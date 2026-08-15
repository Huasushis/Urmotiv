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
{
  const { result, reportFile } = runVitestReport(["--exclude", acceptanceTestFile], apiDirectory);
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
const afterChildHookPath = (process.env.URMOTIV_PHASE2_ACCEPTANCE_TEST_AFTER_CHILD_RUNS ?? "").trim();
if (afterChildHookPath.length !== 0) {
  // 测试专用缝（Gate 9）：验收子进程结束之后、运行后卫生判定之前注入受控突变；
  // 只读环境变量显式开启，正常验收运行绝不设置。
  let hookModule;
  try {
    hookModule = await import(pathToFileURL(resolve(afterChildHookPath)).href);
  } catch {
    fail("URMOTIV_PHASE2_ACCEPTANCE_TEST_AFTER_CHILD_RUNS 指向的模块无法加载。");
  }
  if (typeof hookModule.inject !== "function") {
    fail("URMOTIV_PHASE2_ACCEPTANCE_TEST_AFTER_CHILD_RUNS 模块缺少 inject 导出。");
  }
  await hookModule.inject({ repositoryRoot });
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
  const postRun = postRunDirtyReasons({
    headBefore: head,
    headAfter: postRunHead,
    statusOutput: postRunStatus,
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
  "POST_RUN_TREE_NOT_CLEAN",
];
let candidate;
if (codes.has("PHASE2_ROUTE_PASS") && !hardFailures.some((code) => codes.has(code))) {
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
const payload = `${JSON.stringify(evidence, null, 2)}\n`;
writeFileSync(join(acceptanceDirectory, evidenceFileName), payload);
console.log(`phase2-acceptance: 证据状态=${evidence.status}`);
console.log(
  `phase2-acceptance: 证据文件 sha256=${sha256Hex(payload)}（仅聚合内容，不含任何私有素材）`,
);
process.exit(
  evidence.status === "PASS" || evidence.status === "IMPLEMENTATION_READY" ? 0 : 1,
);