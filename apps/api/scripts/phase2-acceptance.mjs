// Phase-2 PostgreSQL 验收运行器：验收只能发生在干净的已提交检出上。
// 它自己解析当前 HEAD 并强制整树干净，然后带着验收门环境变量运行
// tests/history-phase2-runner-postgres.test.ts。任何未提交修改（包括对验收
// 脚本或测试自身的修改）都会在启动前被拒绝，避免削弱验收门。
//
// 同时输出三类只含聚合的安全证据（存放于操作员所有的非 Git 目录）：
//   1) worker 基线 vs 当前检出：同一命令、当前失败标签集合一致性；
//   2) 全 API 工作区测试：计数 + 失败标签（可选项，由环境变量开启）；
//   3) Phase-2 路由：合并测试运行内部写出的路线收据分片。
// 证据文件只记录命令字符串、计数、测试标签与文件摘要，绝不记录
// 真实题面、路径、数据库身份或任何私有素材。
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, tmpdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const repositoryRoot = fileURLToPath(new URL("../../..", import.meta.url));
const apiDirectory = fileURLToPath(new URL("..", import.meta.url));
const workspaceDirectory = join(repositoryRoot, "apps", "worker");
const vitestBin = join(repositoryRoot, "node_modules", ".bin", "vitest");
const acceptanceTestFile = "tests/history-phase2-runner-postgres.test.ts";
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
    tmpdirSync(),
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
}

// 全 API 单元测试：可选；失败标签集合适用于净差，不输出任何错误正文。
if (process.env.URMOTIV_PHASE2_RUN_FULL_API === "1") {
  const { result, reportFile } = runVitestReport(["--exclude", acceptanceTestFile], apiDirectory);
  const exitCode = result.status ?? 1;
  if (exitCode === 0) {
    evidence.reasonCodes.push("FULL_API_PASS");
  } else {
    evidence.reasonCodes.push("FULL_API_FAILED_UNADJUDICATED");
  }
  evidence.fullApi = {
    exitCode,
    report: [0, 1].includes(exitCode) ? parseReport(reportFile) : null,
  };
} else {
  evidence.reasonCodes.push("FULL_API_NOT_ENABLED");
}

// Phase-2 路由：在验收模式下运行测试，由测试自身把路线收据分片写进证据目录。
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
    evidence.route = {
      formalExitCode: shard.formalExitCode,
      formalVerdict: shard.formalVerdict,
      bindings: shard.bindings,
      route: shard.route,
      headCommit: shard.headCommit,
    };
    if (
      shard.formalExitCode === 0 &&
      shard.formalVerdict === "PASS" &&
      shard.headCommit === head
    ) {
      evidence.reasonCodes.push("PHASE2_ROUTE_PASS");
    } else {
      evidence.reasonCodes.push("PHASE2_ROUTE_FAILED_UNADJUDICATED");
    }
  } else {
    evidence.reasonCodes.push("PHASE2_ROUTE_SHARD_MISSING");
  }
}

// 定级：必须带外基线齐全、同命令 worker 标签一致、测试全过、路由指出正式导入通过。
const codes = new Set(evidence.reasonCodes);
if (
  codes.has("CRASHED_WORKER_TEST_RUN") ||
  codes.has("WORKER_FAILURE_LABELS_CHANGED") ||
  codes.has("BASE_WORKER_EVIDENCE_COMMIT_MISMATCH")
) {
  evidence.status = "INCONCLUSIVE";
} else if (
  evidence.runnerExitCode === 0 &&
  codes.has("PHASE2_ROUTE_PASS") &&
  codes.has("WORKER_BASE_CURRENT_LABELS_EQUAL") &&
  (codes.has("FULL_API_PASS") || codes.has("FULL_API_NOT_ENABLED"))
) {
  evidence.status = "PASS";
}
const payload = `${JSON.stringify(evidence, null, 2)}\n`;
writeFileSync(join(acceptanceDirectory, evidenceFileName), payload);
console.log(`phase2-acceptance: 证据状态=${evidence.status}`);
console.log(
  `phase2-acceptance: 证据文件 sha256=${sha256Hex(payload)}（仅聚合内容，不含任何私有素材）`,
);
process.exit(acceptance.status ?? 1);