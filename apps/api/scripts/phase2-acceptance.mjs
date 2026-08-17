// Phase-2 PostgreSQL 验收运行器：验收只能发生在干净的已提交检出上。
// 它自己解析当前 HEAD 并强制整树干净，然后带着验收门环境变量运行
// tests/history-phase2-runner-postgres.test.ts。任何未提交修改（包括对验收
// 脚本或测试自身的修改）都会在启动前被拒绝，避免削弱验收门。
//
// 同时输出三类只含聚合的安全证据（存放于操作员所有的非 Git 目录）：
//   1) worker 基线 vs 当前检出：失败标签净差只做因果证据，
//      当前必须零失败（回归由 WORKER_CURRENT_NOT_GREEN 拒绝）；
//   2) 全 API 工作区测试：必跑，只有零失败才发放通过标记；
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import { join, resolve } from "node:path";
import { assessFormalShard, finalizeStatus, postRunDirtyReasons } from "./phase2-acceptance-verdict.mjs";

const repositoryRoot = fileURLToPath(new URL("../../..", import.meta.url));
const apiDirectory = fileURLToPath(new URL("..", import.meta.url));
const workspaceDirectory = join(repositoryRoot, "apps", "worker");
const vitestBin = join(repositoryRoot, "node_modules", "vitest", "vitest.mjs");
const defaultAcceptanceTestFile = "tests/history-phase2-runner-postgres.test.ts";
const childFixturePath = (process.env.URMOTIV_PHASE2_ACCEPTANCE_TEST_CHILD_FIXTURE ?? "").trim();
const acceptanceTestFile =
  childFixturePath.length === 0 ? defaultAcceptanceTestFile : resolve(childFixturePath);
if (acceptanceTestFile !== defaultAcceptanceTestFile) {
  // 测试专用缝（Gate 9）：仅当显式给出环境变量时启用；必须落在 api 目录内，
  // 防止验收指向仓库外的任意文件。正常验收运行绝不设置该变量。
  const apiPrefix = `${resolve(apiDirectory)}${process.platform === "win32" ? "\\" : "/"}`;
  if (!acceptanceTestFile.startsWith(apiPrefix)) {
    fail("URMOTIV_PHASE2_ACCEPTANCE_TEST_CHILD_FIXTURE 必须指向 apps/api 目录内的测试文件。");
  }
  if (!existsSync(acceptanceTestFile)) {
    fail(`URMOTIV_PHASE2_ACCEPTANCE_TEST_CHILD_FIXTURE 指向的文件不存在。`);
  }
}
const afterChildHookPath = (process.env.URMOTIV_PHASE2_ACCEPTANCE_TEST_AFTER_CHILD_RUNS ?? "").trim();
// 测试缝自起始环境一次性冻结：任何夹具/钩子在运行途中都没法改写它。
// 只要任一缝处于激活状态，本运行就不可能是权威运行 —— 即使路由分片
// 形似 REAL_PASS、即使钩子事后把检出恢复干净，也强制 INCONCLUSIVE。
const seamState = Object.freeze({
  childFixture: childFixturePath.length !== 0,
  afterChildHook: afterChildHookPath.length !== 0,
  active: childFixturePath.length !== 0 || afterChildHookPath.length !== 0,
});
const shardFileName = "shard-runner.private.json";
const evidenceFileName = "phase2-acceptance-evidence.private.json";
const fullCommitPattern = /^[0-9a-f]{40}$/;

function fail(message) {
  console.error(`phase2-acceptance: ${message}`);
  process.exit(2);
}

function sha256Hex(content) {
  return createHash("sha256").update(content).digest("hex");
}


/**
 * Gate 9 Git 元数据掩盖探测：收集可隐藏检出突变的元数据状态。
 * porcelain status 无法识破 assume-unchanged/skip-worktree、info/exclude、
 * core.excludesFile、sparse-checkout 等。本函数只采集原始 git 输出与
 * 排除文件的字节哈希，不解析内容、不输出路径。判定在 verdict 模块的
 * 纯函数完成。
 *
 * 排除文件用字节哈希（sha256）而非布尔值：运行前冻结哈希，运行后逐字节
 * 比对，任何字节变化即报 POST_RUN_GIT_METADATA_HIDING。这样预存的合法
 * 排除规则（如 worktree node_modules 软链排除）被冻结，运行中新增的规则
 * 一定被检出——比布尔 delta 更强，不受「已有非空文件再添一行」的遮蔽。
 *
 * git-path 解析用 git rev-parse --git-path，正确处理链接型 worktree
 * （.git 是 gitdir 指针文件而非目录）。
 */
function captureGitMetadataHiding() {
  let lsFilesVerbose = "";
  try {
    lsFilesVerbose = execFileSync("git", ["ls-files", "-v"], {
      cwd: repositoryRoot,
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch {
    // ls-files 失败本身是异常状态——用哨兵值确保运行后差比一定触发。
    lsFilesVerbose = "READ_ERROR_SENTINEL";
  }
  let excludesFileValue = "";
  try {
    excludesFileValue = execFileSync("git", ["config", "--get", "core.excludesFile"], {
      cwd: repositoryRoot,
      encoding: "utf8",
    }).trim();
  } catch {
    excludesFileValue = "";
  }
  let excludesFileHash = "";
  if (excludesFileValue.length !== 0) {
    try {
      excludesFileHash = createHash("sha256")
        .update(readFileSync(excludesFileValue, "utf8"))
        .digest("hex");
    } catch {
      // 读取失败用哨兵值——与任何真实哈希（64 位十六进制）都不同，
      // 运行后即使恢复为可读也一定被检出为变化。
      excludesFileHash = "READ_ERROR_SENTINEL";
    }
  }
  let infoExcludeHash = "";
  let infoExcludeHasActiveRules = false;
  try {
    const excludePath = execFileSync("git", ["rev-parse", "--git-path", "info/exclude"], {
      cwd: repositoryRoot,
      encoding: "utf8",
    }).trim();
    const content = readFileSync(excludePath, "utf8");
    infoExcludeHash = createHash("sha256").update(content).digest("hex");
    // 预运行硬门：info/exclude 中的非注释非空行是活跃排除规则，
    // 可能隐藏运行中产生的未跟踪工件。预运行必须拒绝。
    infoExcludeHasActiveRules = content
      .split("\n")
      .some((line) => line.trim().length > 0 && !line.trim().startsWith("#"));
  } catch {
    // 读取失败用哨兵值——绝不静默为"不存在"。
    infoExcludeHash = "READ_ERROR_SENTINEL";
    infoExcludeHasActiveRules = false;
  }
  let sparseCheckout = false;
  try {
    sparseCheckout = execFileSync("git", ["config", "--get", "core.sparseCheckout"], {
      cwd: repositoryRoot,
      encoding: "utf8",
    }).trim();
  } catch {
    sparseCheckout = false;
  }
  let sparseCheckoutFilePresent = false;
  try {
    const sparsePath = execFileSync("git", ["rev-parse", "--git-path", "info/sparse-checkout"], {
      cwd: repositoryRoot,
      encoding: "utf8",
    }).trim();
    sparseCheckoutFilePresent = existsSync(sparsePath);
  } catch {
    sparseCheckoutFilePresent = false;
  }
  // 冻结被忽略文件集的哈希——运行前后比对可发现预存排除规则被用来
  // 隐藏运行中新增的未跟踪工件（即使排除规则字节未变）。
  let ignoredFilesHash = "";
  try {
    const ignored = execFileSync(
      "git",
      ["status", "--porcelain=v1", "--ignored", "--untracked-files=all"],
      { cwd: repositoryRoot, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
    );
    ignoredFilesHash = createHash("sha256").update(ignored).digest("hex");
  } catch {
    ignoredFilesHash = "READ_ERROR_SENTINEL";
  }
  return {
    lsFilesVerbose,
    excludesFileValue,
    excludesFileHash,
    infoExcludeHash,
    infoExcludeHasActiveRules,
    ignoredFilesHash,
    sparseCheckout,
    sparseCheckoutFilePresent,
  };
}

// 代码清单摘要与入口的 verifyExecutionProvenance 保持同一命令与同一摘要构造。
function codeInventoryForCommit(commit) {
  const raw = execFileSync("git", ["ls-tree", "-r", "--full-tree", commit, "--"], {
    cwd: repositoryRoot,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  return {
    commit,
    entryCount: raw.trim().split("\n").length,
    sha256: sha256Hex(raw),
  };
}

const head = execFileSync("git", ["rev-parse", "HEAD"], {
  cwd: repositoryRoot,
  encoding: "utf8",
}).trim();
if (!fullCommitPattern.test(head)) {
  fail(`HEAD 不是完整提交摘要: ${head}`);
}
const status = execFileSync(
  "git",
  ["status", "--porcelain=v1", "--untracked-files=all"],
  { cwd: repositoryRoot, encoding: "utf8" },
);
if (status.trim().length !== 0) {
  fail("整树必须干净且全部内容已提交；拒绝在未提交检出上发放验收。");
}
// Gate 9 预运行硬门：porcelain 干净不够——assume-unchanged/skip-worktree、
// sparse-checkout 等元数据能掩盖已跟踪文件改动，在任何验收检出上都不合法，
// 启动前即拒绝。读取失败用哨兵值标记，绝不静默为"不存在"。
//
// 权威运行（默认）额外硬拒 info/exclude 中的活跃排除规则和 core.excludesFile：
// 这些规则能隐藏运行中产生的未跟踪工件。唯一的放宽途径是内部测试缝
// （seamState.active），其存在无条件强制终判定 INCONCLUSIVE——
// 没有任何 CLI 环境变量（包括 URMOTIV_PHASE2_NON_AUTHORITATIVE）能放宽权威性。
const preRunMetadata = captureGitMetadataHiding();
if (
  preRunMetadata.lsFilesVerbose.split("\n").some((line) => {
    const tag = line.charAt(0);
    return tag === "h" || tag === "S";
  }) ||
  preRunMetadata.sparseCheckout === true ||
  preRunMetadata.sparseCheckout === "true" ||
  preRunMetadata.sparseCheckoutFilePresent
) {
  fail("检出存在可隐藏已跟踪文件改动的 Git 元数据（assume-unchanged/skip-worktree/sparse-checkout）；拒绝发放验收。");
}
// 所有读取失败哨兵值都必须在启动前拒绝——包括 lsFilesVerbose 和 ignoredFilesHash。
// 相同哨兵值前后比对应判为不通过（哨兵值不是合法状态）。
if (
  preRunMetadata.infoExcludeHash === "READ_ERROR_SENTINEL" ||
  preRunMetadata.excludesFileHash === "READ_ERROR_SENTINEL" ||
  preRunMetadata.lsFilesVerbose === "READ_ERROR_SENTINEL" ||
  preRunMetadata.ignoredFilesHash === "READ_ERROR_SENTINEL"
) {
  fail("Git 元数据探测存在读取失败哨兵值，无法建立安全的预运行基线；拒绝发放验收。");
}
if (!seamState.active) {
  // 权威运行：硬拒 info/exclude 活跃规则和 core.excludesFile。
  if (preRunMetadata.infoExcludeHasActiveRules) {
    fail("权威运行拒绝 info/exclude 中的活跃排除规则（非注释非空行）；请清除后重试。");
  }
  if (preRunMetadata.excludesFileValue.length !== 0) {
    fail("权威运行拒绝 core.excludesFile 设置；请清除后重试。");
  }
}
if (
  process.env.URMOTIV_TEST_POSTGRES_ADMIN_URL === undefined ||
  process.env.URMOTIV_TEST_POSTGRES_ADMIN_URL.trim().length === 0
) {
  fail("缺少 URMOTIV_TEST_POSTGRES_ADMIN_URL 管理连接。");
}

const baseCommit = process.env.URMOTIV_PHASE2_ACCEPTANCE_BASE_COMMIT;
if (baseCommit === undefined || !fullCommitPattern.test(baseCommit)) {
  fail("缺少完整的中性基线提交 URMOTIV_PHASE2_ACCEPTANCE_BASE_COMMIT。");
}
const baseWorkerFile = process.env.URMOTIV_PHASE2_ACCEPTANCE_BASE_WORKER_FILE;
if (baseWorkerFile === undefined || baseWorkerFile.trim().length === 0) {
  fail("缺少 worker 基线证据文件 URMOTIV_PHASE2_ACCEPTANCE_BASE_WORKER_FILE。");
}
let baseWorker;
try {
  baseWorker = JSON.parse(readFileSync(baseWorkerFile, "utf8"));
} catch {
  fail("worker 基线证据文件不是合法 JSON。");
}
if (
  typeof baseWorker !== "object" ||
  baseWorker === null ||
  !Array.isArray(baseWorker.failedLabels) ||
  !Array.isArray(baseWorker.argv) ||
  typeof baseWorker.exitCode !== "number" ||
  typeof baseWorker.commit !== "string" ||
  typeof baseWorker.cwd !== "string" ||
  !baseWorker.cwd.startsWith("apps/worker")
) {
  fail("worker 基线证据文件缺少必要字段或运行目录越界。");
}

const acceptanceDirectory = process.env.URMOTIV_PHASE2_ACCEPTANCE_DIR;
if (acceptanceDirectory === undefined || acceptanceDirectory.trim().length === 0) {
  fail("缺少操作员所有证据目录 URMOTIV_PHASE2_ACCEPTANCE_DIR。");
}
if (acceptanceDirectory.startsWith(repositoryRoot)) {
  fail("证据目录不得位于项目检出内。");
}
mkdirSync(acceptanceDirectory, { recursive: true });

const evidence = {
  version: 1,
  kind: "phase2-acceptance-evidence",
  generatedAt: new Date().toISOString(),
  status: "INCONCLUSIVE",
  reasonCodes: [],
  head,
  baseCommit,
  codeInventory: {
    base: codeInventoryForCommit(baseCommit),
    head: codeInventoryForCommit(head),
  },
  worker: { base: null, current: null },
  fullApi: null,
  route: null,
  runnerExitCode: null,
};
if (baseWorker.commit !== baseCommit) {
  evidence.reasonCodes.push("BASE_WORKER_EVIDENCE_COMMIT_MISMATCH");
}
evidence.codeInventory.sameInventory =
  evidence.codeInventory.base.sha256 === evidence.codeInventory.head.sha256;
if (evidence.codeInventory.sameInventory) {
  evidence.reasonCodes.push("BASE_HEAD_CODE_INVENTORY_EQUAL");
}

function runVitestReport(vitestArgs, cwd) {
  const reportFile = join(
    tmpdir(),
    `urmotiv-vitest-${process.pid}-${Math.random().toString(16).slice(2)}.json`,
  );
  const result = spawnSync(
    process.execPath,
    [vitestBin, "run", ...vitestArgs, "--reporter=json", `--outputFile=${reportFile}`],
    { cwd, stdio: ["ignore", "ignore", "ignore"], env: process.env },
  );
  return { result, reportFile };
}

function parseReport(reportFile) {
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(reportFile, "utf8"));
  } catch {
    return null;
  }
  const failedLabels = [];
  for (const fileResult of parsed.testResults ?? []) {
    for (const assertion of fileResult.assertionResults ?? []) {
      if (assertion.status === "failed" && typeof assertion.fullName === "string") {
        failedLabels.push(assertion.fullName);
      }
    }
  }
  failedLabels.sort();
  return {
    numTotalTests: parsed.numTotalTests ?? 0,
    numFailedTests: parsed.numFailedTests ?? failedLabels.length,
    numPassedTests: parsed.numPassedTests ?? 0,
    failedLabels,
  };
}

// worker 基线 vs 当前：同一 argv 与工作目录，只对比失败标签集合与计数。
{
  const base = {
    command: JSON.stringify(baseWorker.argv),
    cwd: baseWorker.cwd,
    commit: baseCommit,
    exitCode: baseWorker.exitCode,
    numFailedTests: baseWorker.failedLabels.length,
    failedLabels: [...baseWorker.failedLabels].sort(),
  };
  const { result, reportFile } = runVitestReport(baseWorker.argv, workspaceDirectory);
  const exitCode = result.status ?? 1;
  const current = {
    command: JSON.stringify(baseWorker.argv),
    cwd: baseWorker.cwd,
    commit: head,
    exitCode,
    numFailedTests: null,
    failedLabels: null,
  };
  if ([0, 1].includes(exitCode)) {
    const parsed = parseReport(reportFile);
    if (parsed === null) {
      evidence.reasonCodes.push("WORKER_JSON_REPORT_MISSING");
    } else {
      current.numFailedTests = parsed.numFailedTests;
      current.failedLabels = parsed.failedLabels;
      current.numTotalTests = parsed.numTotalTests;
      current.numPassedTests = parsed.numPassedTests;
    }
  } else {
    evidence.reasonCodes.push("CRASHED_WORKER_TEST_RUN");
    evidence.reasonCodes.push(`WORKER_TEST_EXIT_CODE_${String(exitCode)}`);
  }
  evidence.worker = { base, current };
  if (
    current.failedLabels !== null &&
    current.numFailedTests === base.numFailedTests &&
    JSON.stringify(current.failedLabels) === JSON.stringify(base.failedLabels)
  ) {
    evidence.reasonCodes.push("WORKER_BASE_CURRENT_LABELS_EQUAL");
  } else {
    evidence.reasonCodes.push("WORKER_FAILURE_LABELS_CHANGED");
    evidence.reasonCodes.push(`WORKER_BASE_FAILED_${base.numFailedTests}`);
    evidence.reasonCodes.push(`WORKER_CURRENT_FAILED_${String(current.numFailedTests)}`);
  }
  // 当前检出必须零失败，否则任何基线一致性都不得升级状态。
  if (current.numFailedTests === 0) {
    evidence.reasonCodes.push("WORKER_CURRENT_ZERO_FAIL");
  } else {
    evidence.reasonCodes.push("WORKER_CURRENT_NOT_GREEN");
  }
}

// 全 API 单元测试：必跑。只有零失败（numFailedTests === 0）才发放 FULL_API_PASS；
// 失败标签集合仅用于净差证据，绝不输出任何错误正文。
// 内部全量测试显式排除父进程专用的 Gate9/Docker 生命周期套件——
// runner 容器内无 Docker 权限，不应触碰 Docker 资源管理测试。
{
  const { result, reportFile } = runVitestReport([
    "--exclude", acceptanceTestFile,
    "--exclude", "tests/phase2-acceptance-gate9.test.mjs",
    "--exclude", "tests/phase2-isolated-postgres.mjs",
    "--exclude", "tests/phase2-isolated-postgres.d.ts",
  ], apiDirectory);
  const exitCode = result.status ?? 1;
  const parsed = [0, 1].includes(exitCode) ? parseReport(reportFile) : null;
  if (exitCode === 0 && parsed !== null && parsed.numFailedTests === 0) {
    evidence.reasonCodes.push("FULL_API_PASS");
  } else {
    evidence.reasonCodes.push("FULL_API_FAILED_UNADJUDICATED");
    evidence.reasonCodes.push(`FULL_API_FAILED_COUNT_${String(parsed?.numFailedTests ?? -1)}`);
  }
  evidence.fullApi = { exitCode, report: parsed };
}

console.log(`phase2-acceptance: HEAD=${head}`);
const acceptance = spawnSync(process.execPath, [vitestBin, "run", acceptanceTestFile], {
  cwd: apiDirectory,
  stdio: "inherit",
  env: {
    ...process.env,
    URMOTIV_PHASE2_RUNNER_ACCEPTANCE: "1",
    URMOTIV_PHASE2_ACCEPTANCE_COMMIT: head,
    URMOTIV_PHASE2_ACCEPTANCE_DIR: acceptanceDirectory,
  },
});
evidence.runnerExitCode = acceptance.status ?? 1;
if (seamState.afterChildHook) {
  // 测试专用缝（Gate 9）：验收子进程结束之后、运行后卫生判定之前注入受控突变；
  // 钩子作为独立子进程执行，无法触碰本进程内存里的 seamState 或任何权威状态。
  const hookPath = resolve(afterChildHookPath);
  const apiPrefix = `${resolve(apiDirectory)}${process.platform === "win32" ? "\\" : "/"}`;
  if (!hookPath.startsWith(apiPrefix) || !existsSync(hookPath)) {
    fail("URMOTIV_PHASE2_ACCEPTANCE_TEST_AFTER_CHILD_RUNS 必须指向 apps/api 目录内存在的脚本。");
  }
  const hookRun = spawnSync(process.execPath, [hookPath], {
    cwd: apiDirectory,
    stdio: "inherit",
    env: process.env,
  });
  if ((hookRun.status ?? 1) !== 0) {
    fail("URMOTIV_PHASE2_ACCEPTANCE_TEST_AFTER_CHILD_RUNS 钩子进程退出非零。");
  }
}
{
  const postRunHead = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: repositoryRoot,
    encoding: "utf8",
  })
    .trim()
    .replace(/\r?\n$/, "");
  const postRunStatus = execFileSync(
    "git",
    ["status", "--porcelain=v1", "--untracked-files=all"],
    { cwd: repositoryRoot, encoding: "utf8" },
  );
  const postMetadata = captureGitMetadataHiding();
  // 运行后元数据探测：skip-worktree/assume-unchanged/sparse 是绝对非法的
  // （预运行已拒，运行中出现即为掩盖突变）。info/exclude 与 excludesFile 用
  // 字节哈希前后差比对——预存的合法排除规则被冻结（哈希不变即无变化），
  // 运行中任何字节变化（新增/修改/删除排除规则）一定被检出。
  // 哨兵值（读取失败）在预运行已被拒绝。运行后出现哨兵值本身即为异常——
  // 相同哨兵值前后比对应判为掩盖（哨兵值不是合法状态，不能通过）。
  const hasPostSentinel =
    postMetadata.infoExcludeHash === "READ_ERROR_SENTINEL" ||
    postMetadata.excludesFileHash === "READ_ERROR_SENTINEL" ||
    postMetadata.lsFilesVerbose === "READ_ERROR_SENTINEL" ||
    postMetadata.ignoredFilesHash === "READ_ERROR_SENTINEL";
  const metadataForVerdict = {
    lsFilesVerbose: postMetadata.lsFilesVerbose,
    excludesFileHashChanged:
      hasPostSentinel ||
      postMetadata.excludesFileHash !== preRunMetadata.excludesFileHash,
    infoExcludeHashChanged:
      hasPostSentinel ||
      postMetadata.infoExcludeHash !== preRunMetadata.infoExcludeHash,
    ignoredFilesHashChanged:
      hasPostSentinel ||
      postMetadata.ignoredFilesHash !== preRunMetadata.ignoredFilesHash,
    sparseCheckout: postMetadata.sparseCheckout,
    sparseCheckoutFilePresent: postMetadata.sparseCheckoutFilePresent,
  };
  const postRun = postRunDirtyReasons({
    headBefore: head,
    headAfter: postRunHead,
    statusOutput: postRunStatus,
    metadata: metadataForVerdict,
  });
  evidence.dirtyCount = postRun.dirtyCount;
  evidence.reasonCodes.push(...postRun.reasons);
}

{
  let shard = null;
  try {
    const entries = readdirSync(acceptanceDirectory);
    if (entries.includes(shardFileName)) {
      shard = JSON.parse(readFileSync(join(acceptanceDirectory, shardFileName), "utf8"));
      evidence.routeSha256 = sha256Hex(readFileSync(join(acceptanceDirectory, shardFileName)));
    }
  } catch {
    evidence.reasonCodes.push("PHASE2_ROUTE_SHARD_UNREADABLE");
  }
  if (shard !== null) {
    const assessment = assessFormalShard(shard, {
      headCommit: head,
      runnerExitCode: evidence.runnerExitCode,
    });
    evidence.reasonCodes.push(...assessment.reasons);
    evidence.route = {
      formalExitCode:
        typeof shard.formalExitCode === "number" ? shard.formalExitCode : null,
      formalVerdict: typeof shard.formalVerdict === "string" ? shard.formalVerdict : null,
      formalTargetSynthetic:
        typeof shard.formalTargetSynthetic === "boolean" ? shard.formalTargetSynthetic : null,
      bindings:
        typeof shard.bindings === "object" && shard.bindings !== null
          ? shard.bindings
          : null,
      route: typeof shard.route === "string" ? shard.route : null,
      headCommit: typeof shard.headCommit === "string" ? shard.headCommit : null,
    };
    if (assessment.admission === "REAL_PASS") {
      evidence.reasonCodes.push("PHASE2_ROUTE_PASS");
    } else if (assessment.admission === "SYNTHETIC_READINESS") {
      evidence.reasonCodes.push("PHASE2_ROUTE_SYNTHETIC_READINESS");
    }
  } else {
    evidence.reasonCodes.push("PHASE2_ROUTE_SHARD_MISSING");
  }
}

// 定级：任何硬失败或基线不一致都压为 INCONCLUSIVE；只有形式路由给出
// REAL_PASS 才是 PASS；合成库给出 SYNTHETIC_READINESS 仅是实现就绪。
const codes = new Set(evidence.reasonCodes);
const hardFailures = [
  "CRASHED_WORKER_TEST_RUN",
  "BASE_WORKER_EVIDENCE_COMMIT_MISMATCH",
  "WORKER_CURRENT_NOT_GREEN",
  "FULL_API_FAILED_UNADJUDICATED",
  "PHASE2_ROUTE_SHARD_COMMIT_MISMATCH",
  "PHASE2_ROUTE_FAKE_PASS_REJECTED",
  "PHASE2_ROUTE_FAILED_UNADJUDICATED",
  "PHASE2_ROUTE_NOT_AUTHORIZED",
  "PHASE2_ROUTE_SHARD_MISSING",
  "PHASE2_ROUTE_SHARD_UNREADABLE",
  "POST_RUN_HEAD_MOVED",
  "POST_RUN_GIT_METADATA_HIDING",
];
let candidate;
if (seamState.active) {
  evidence.reasonCodes.push("TEST_SEAM_ACTIVE_NON_AUTHORITATIVE");
  candidate = "INCONCLUSIVE";
} else if (codes.has("PHASE2_ROUTE_PASS") && !hardFailures.some((code) => codes.has(code))) {
  candidate = "PASS";
} else if (
  codes.has("PHASE2_ROUTE_SYNTHETIC_READINESS") &&
  evidence.runnerExitCode === 0 &&
  codes.has("WORKER_CURRENT_ZERO_FAIL") &&
  codes.has("FULL_API_PASS") &&
  !codes.has("CRASHED_WORKER_TEST_RUN") &&
  !codes.has("BASE_WORKER_EVIDENCE_COMMIT_MISMATCH")
) {
  candidate = "IMPLEMENTATION_READY";
} else {
  candidate = "INCONCLUSIVE";
}
// 运行后整树突变（HEAD 漂移 / 树脏）对每个本可成功的定级都是硬失败。
evidence.status = finalizeStatus({ candidate, reasonCodes: evidence.reasonCodes });
if (seamState.active && (evidence.status === "PASS" || evidence.status === "IMPLEMENTATION_READY")) {
  fail("测试缝激活的运行绝不能产出权威定级；终判定机失防，拒绝发放。");
}
const payload = `${JSON.stringify(evidence, null, 2)}\n`;
writeFileSync(join(acceptanceDirectory, evidenceFileName), payload);
console.log(`phase2-acceptance: 证据状态=${evidence.status}`);
console.log(
  `phase2-acceptance: 证据文件 sha256=${sha256Hex(payload)}（仅聚合内容，不含任何私有素材）`,
);
process.exit(
  evidence.status === "PASS" || evidence.status === "IMPLEMENTATION_READY" ? 0 : 1,
);