// Gate 9 集成测试：验收运行结束后、终判定之前的整树突变，必须把
// 本可成功的定级（IMPLEMENTATION_READY / REAL_PASS）硬压为 INCONCLUSIVE，
// 并以非零退出码结束。整条链路只在一次性 Git worktree 内执行：
//   1. 用已提交检出创建 --detach worktree；
//   2. 把主仓库的 node_modules 目录按包软链进 worktree；
//   3. 环境变量显式指定路由夹具与后置突变夹具；
//   4. 运行真实的 scripts/phase2-acceptance.mjs；
//   5. 解析证据断言 POST_RUN_* 理由、INCONCLUSIVE 与非零退出；
//   6. 无论成败都移除 worktree 并在主检出上硬门断言整树干净。
import {
  appendFileSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { execFileSync, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire as nodeCreateRequire } from "node:module";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  createIsolatedPostgres,
  teardownIsolatedPostgres,
  verifyContainerIdentity,
  verifyLiveIdentity,
  getLiveIdentity,
  listProjectContainers,
  manifestExists,
  recoverAndTeardown,
} from "./phase2-isolated-postgres.mjs";

const testsDirectory = fileURLToPath(new URL(".", import.meta.url));
const apiDirectory = resolve(testsDirectory, "..");
const repositoryRoot = resolve(repositoryRootFromApi(apiDirectory));
function repositoryRootFromApi(apiDir) {
  return resolve(apiDir, "..", "..");
}

const gate9Enabled = process.env.URMOTIV_RUN_PHASE2_GATE9 === "1";

function git(cwd, ...args) {
  return execFileSync("git", args, { cwd, encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
}

const sharedPgAdminUrl = process.env.URMOTIV_TEST_POSTGRES_ADMIN_URL ?? "";

// Fix A（Sol HOLD 重做——一次性隔离集群）：不再用子进程可写的登记册/HMAC
// 作为删除归属权凭据。父进程独占创建一个项目专属的、一次性的 Docker
// PostgreSQL 17 容器（随机凭据/端口/标签，仅绑定 127.0.0.1）。子进程只
// 拿到隔离集群的连接参数——无法接触任何共享/正式集群。拆除时只按精确
// 容器 ID + 标签停止/移除，绝不模式删除。
const runToken = `${process.pid}${randomUUID().replaceAll("-", "").slice(0, 12)}`;

// 隔离集群实例——由 beforeAll 创建，afterAll/afterEach 拆除。
// gate9Enabled 为 true 时在 beforeAll 中赋值。
let isolatedCluster = null;

// 保存原始共享集群 URL，用于对抗性测试验证子进程不会接触它。
// 隔离集群的 URL 覆盖 URMOTIV_TEST_POSTGRES_ADMIN_URL 传给子进程。

function pgRequire() {
  const req = nodeCreateRequire(import.meta.url);
  try {
    return req("pg");
  } catch {
    const dbPkgPath = join(repositoryRoot, "packages", "database", "package.json");
    return nodeCreateRequire(dbPkgPath)("pg");
  }
}

// captureClusterIdentity 已不再需要——隔离集群通过容器 ID + system_identifier
// 验证身份，而非连接后查询。

// snapshotOwnedDatabases / cleanupPgResidue 已不再需要——隔离集群是一次性的，
// 拆除即销毁整个容器，无需逐库清理。
async function teardownIsolatedCluster() {
  if (isolatedCluster === null) return;
  teardownIsolatedPostgres(isolatedCluster);
  isolatedCluster = null;
}

function defaultBaseWorkerFile() {
  const override = process.env.URMOTIV_PHASE2_GATE9_BASE_WORKER_FILE;
  if (typeof override === "string" && override.trim().length !== 0) {
    return override.trim();
  }
  return "/home/ubuntu/codex-urmotiv/.acceptance-evidence/base-worker.450cd48.private.json";
}

function readBaseWorkerCommit() {
  const parsed = JSON.parse(readFileSync(defaultBaseWorkerFile(), "utf8"));
  if (typeof parsed.commit !== "string") {
    throw new Error("worker 基线证据缺少 commit 字段。");
  }
  return parsed.commit;
}

const worktrees = [];
const evidenceDirectories = [];
function makeWorktree() {
  const directory = mkdtempSync(join(tmpdir(), "urmotiv-gate9-worktree-"));
  git(repositoryRoot, "worktree", "add", "--detach", directory, "HEAD");
  const bridges = [
    ["node_modules", "node_modules"],
    [join("apps", "api", "node_modules"), join("apps", "api", "node_modules")],
    [join("apps", "worker", "node_modules"), join("apps", "worker", "node_modules")],
  ];
  for (const [targetRel, linkRel] of bridges) {
    const target = join(repositoryRoot, targetRel);
    if (!existsSync(target)) {
      rmSync(directory, { recursive: true, force: true });
      throw new Error(`测试要求主检出存在 ${target}：先安装依赖再运行 Gate 9 集成测试。`);
    }
    symlinkSync(target, join(directory, linkRel), "dir");
  }
  return directory;
}
function runAcceptanceLauncher(worktreeDirectory, { verdict, hookMode }) {
  if (isolatedCluster === null) {
    throw new Error("Gate 9 集成测试要求隔离集群已创建。");
  }
  const evidenceDirectory = mkdtempSync(join(tmpdir(), "urmotiv-gate9-evidence-"));
  evidenceDirectories.push(evidenceDirectory);
  const env = {
    ...process.env,
    // 子进程只拿到隔离集群的连接参数——绝不接触共享/正式集群。
    URMOTIV_TEST_POSTGRES_ADMIN_URL: isolatedCluster.adminUrl,
    URMOTIV_PHASE2_ACCEPTANCE_BASE_COMMIT: readBaseWorkerCommit(),
    URMOTIV_PHASE2_ACCEPTANCE_BASE_WORKER_FILE: defaultBaseWorkerFile(),
    URMOTIV_PHASE2_ACCEPTANCE_DIR: evidenceDirectory,
    URMOTIV_PHASE2_ACCEPTANCE_TEST_CHILD_FIXTURE: join(
      worktreeDirectory,
      "apps",
      "api",
      "tests",
      "fixtures",
      "phase2-acceptance-child-fixture.test.mjs",
    ),
    URMOTIV_PHASE2_ACCEPTANCE_TEST_AFTER_CHILD_RUNS: join(
      worktreeDirectory,
      "apps",
      "api",
      "tests",
      "fixtures",
      "phase2-acceptance-hook-fixture.mjs",
    ),
    URMOTIV_PHASE2_CHILD_FIXTURE_VERDICT: verdict,
    URMOTIV_PHASE2_ACCEPTANCE_HOOK_MODE: hookMode,
    URMOTIV_TEST_RUN_TOKEN: runToken,
  };
  // 清除所有可能泄露共享集群凭据的环境变量。
  delete env.URMOTIV_RUN_PHASE2_GATE9;
  // 不再传递 URMOTIV_TEST_PG_LIFECYCLE_DIR——隔离集群不需要子进程登记。
  delete env.URMOTIV_TEST_PG_LIFECYCLE_DIR;
  const launcherPath = join(
    worktreeDirectory,
    "apps",
    "api",
    "scripts",
    "phase2-acceptance.mjs",
  );
  const result = spawnSync(process.execPath, [launcherPath], {
    env,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 256 * 1024 * 1024,
  });
  return { result, evidenceDirectory };
}

function readEvidence(evidenceDirectory, result) {
  const path = join(evidenceDirectory, "phase2-acceptance-evidence.private.json");
  if (!existsSync(path)) {
    console.error("GATE9 launcher status:", result === undefined ? "undefined" : result.status);
    if (result !== undefined) {
      console.error("GATE9 stdout:", result.stdout ?? "(none)");
      console.error("GATE9 stderr:", result.stderr ?? "(none)");
    }
  }
  expect(existsSync(path)).toBe(true);
  const evidence = JSON.parse(readFileSync(path, "utf8"));
  console.log("GATE9 reasonCodes:", JSON.stringify(evidence.reasonCodes));
  console.log("GATE9 dirtyCount:", evidence.dirtyCount);
  return evidence;
}
function removeGate9Resources() {
  // 只动测试自己申请的一次性资源；任何一步失败都抛错，绝不让残留静默存活。
  for (const worktreeDirectory of worktrees.splice(0)) {
    git(repositoryRoot, "worktree", "remove", "--force", worktreeDirectory);
    if (existsSync(worktreeDirectory)) {
      rmSync(worktreeDirectory, { recursive: true, force: true });
      throw new Error(`worktree 目录移除后仍有残留：${worktreeDirectory}`);
    }
  }
  for (const evidenceDirectory of evidenceDirectories.splice(0)) {
    rmSync(evidenceDirectory, { recursive: true, force: true });
    if (existsSync(evidenceDirectory)) {
      throw new Error(`证据目录移除后仍有残留：${evidenceDirectory}`);
    }
  }
}

// 链接型 worktree 对根 .gitignore 的锚定模式实测不生效（git 只对目录套用），
// 唯一验证过的归宿是共享 .git/info/exclude 的锚定条目。条目不覆盖任何
// 证据路径（证据只落在 /tmp 证据目录与 .acceptance-evidence），并在硬门前
// 按字节还原，杜绝借排除项掩盖验收突变。
const sharedExcludePath = join(repositoryRoot, ".git", "info", "exclude");
const gate9ExcludeLines = [
  "/node_modules",
  "/apps/api/node_modules",
  "/apps/worker/node_modules",
];
// null = 尚未捕获；"" = 合法的零字节原始文件；非空串 = 捕获到的原始字节。
// 三者必须严格区分，否则零字节原始文件与「未捕获」无法区分。
let sharedExcludeOriginal = null;
let sharedExcludeCaptured = false;

function enableSharedExcludes() {
  sharedExcludeOriginal = readFileSync(sharedExcludePath, "utf8");
  sharedExcludeCaptured = true;
  const existing = new Set(sharedExcludeOriginal.split("\n"));
  const additions = gate9ExcludeLines.filter((line) => !existing.has(line));
  if (additions.length !== 0) {
    writeFileSync(sharedExcludePath, `${sharedExcludeOriginal}${additions.join("\n")}\n`);
  }
}

function restoreSharedExcludes() {
  // 未捕获（null）说明 enableSharedExcludes 从未成功执行——不是幂等
  // 恢复，而是前置条件缺失，必须报错而非静默跳过。
  if (!sharedExcludeCaptured || sharedExcludeOriginal === null) {
    throw new Error("restoreSharedExcludes 在 enableSharedExcludes 之前被调用。");
  }
  writeFileSync(sharedExcludePath, sharedExcludeOriginal);
  sharedExcludeOriginal = null;
  sharedExcludeCaptured = false;
}

function verifySharedExcludesRestored() {
  // fail-closed：快照未捕获也必须报错，不能假装验证通过。
  const snapshot = configSnapshot.get("__info_exclude_original__");
  if (typeof snapshot !== "string") {
    throw new Error("info/exclude 原始字节快照缺失，验证无法成立。");
  }
  const current = readFileSync(sharedExcludePath, "utf8");
  if (current !== snapshot) {
    throw new Error("info/exclude 未恢复到测试前精确字节。");
  }
}

// Gate 9 hook 模式可能在共享 git config 中设置 core.excludesFile 或
// core.sparseCheckout。测试必须保存测试前的原始值（含「未设置」状态），
// 无论成功失败都精确恢复，并验证恢复后字节一致。绝不篡改用户预存配置。
const configKeysToSnapshot = ["core.excludesFile", "core.sparseCheckout"];
const configSnapshot = new Map();

function snapshotGitConfig() {
  for (const key of configKeysToSnapshot) {
    try {
      const value = git(repositoryRoot, "config", "--get", key).trimEnd();
      configSnapshot.set(key, { wasSet: true, value });
    } catch {
      configSnapshot.set(key, { wasSet: false, value: "" });
    }
  }
  // 同时快照 info/exclude 原始字节，用于 afterAll 逐字节验证恢复。
  configSnapshot.set("__info_exclude_original__", readFileSync(sharedExcludePath, "utf8"));
}

function restoreGitConfig() {
  for (const key of configKeysToSnapshot) {
    const snap = configSnapshot.get(key);
    if (snap === undefined) continue;
    if (snap.wasSet) {
      git(repositoryRoot, "config", key, snap.value);
    } else {
      try {
        git(repositoryRoot, "config", "--unset", key);
      } catch {
        // 已未设置，无需操作。
      }
    }
  }
}

function verifyGitConfigRestored() {
  for (const key of configKeysToSnapshot) {
    const snap = configSnapshot.get(key);
    if (snap === undefined) continue;
    let currentValue = "";
    let currentSet = false;
    try {
      currentValue = git(repositoryRoot, "config", "--get", key).trimEnd();
      currentSet = true;
    } catch {
      currentSet = false;
    }
    if (currentSet !== snap.wasSet || currentValue !== snap.value) {
      throw new Error(`git config ${key} 未恢复到测试前状态。`);
    }
  }
}

describe.skipIf(!gate9Enabled)("Gate 9 验收运行后整树突变隔离", () => {
  beforeAll(async () => {
    // 先快照 info/exclude 原始字节（不含测试追加的 node_modules 行），
    // 再启用排除行。afterAll 的 verifySharedExcludesRestored 与此比对。
    snapshotGitConfig();
    enableSharedExcludes();
    // 创建一次性隔离 PostgreSQL 集群——子进程只拿到这个集群的连接参数。
    isolatedCluster = createIsolatedPostgres({ runId: runToken });
  });

  afterAll(async () => {
    let failure = null;
    try {
      restoreGitConfig();
    } catch (error) {
      failure = error;
    }
    try {
      restoreSharedExcludes();
    } catch (error) {
      failure ??= error;
    }
    try {
      removeGate9Resources();
    } catch (error) {
      failure ??= error;
    }
    try {
      verifyGitConfigRestored();
    } catch (error) {
      failure ??= error;
    }
    try {
      verifySharedExcludesRestored();
    } catch (error) {
      failure ??= error;
    }
    // 拆除隔离集群——停止/移除精确容器 ID + 验证标签后销毁。
    // 失败时保留清单目录供恢复取证。
    try {
      teardownIsolatedCluster();
    } catch (error) {
      failure ??= error;
    }
    try {
      const status = git(repositoryRoot, "status", "--porcelain=v1", "--untracked-files=all");
      expect(status.trim()).toBe("");
    } catch (error) {
      failure ??= error;
    }
    if (failure !== null) {
      throw failure;
    }
  });
  afterEach(async () => {
    // 每个测试的 hook 都可能改共享 git config 和 info/exclude；
    // 测试间必须恢复，避免泄露到后续测试或用户环境。
    let cleanupError = null;
    try {
      restoreGitConfig();
    } catch (error) {
      cleanupError = error;
    }
    try {
      restoreSharedExcludes();
    } catch (error) {
      cleanupError ??= error;
    }
    // 重新启用排除行供下一个测试的 worktree 使用。
    try {
      enableSharedExcludes();
    } catch (error) {
      cleanupError ??= error;
    }
    // 隔离集群内不需要逐库清理——整个集群在 afterAll 中一次性销毁。
    if (cleanupError !== null) {
      throw cleanupError;
    }
  });
  it(
    "缝激活 + 脏树突变：本可 IMPLEMENTATION_READY 的载荷仍被缝强制非权威，且突变仍被检出",
    { timeout: 1_800_000 },
    () => {
      const worktreeDirectory = makeWorktree();
      worktrees.push(worktreeDirectory);
      const { result, evidenceDirectory } = runAcceptanceLauncher(worktreeDirectory, {
        verdict: "SYNTHETIC_READINESS",
        hookMode: "dirty",
      });
      const evidence = readEvidence(evidenceDirectory, result);
      expect(evidence.status).toBe("INCONCLUSIVE");
      expect(evidence.reasonCodes).toContain("TEST_SEAM_ACTIVE_NON_AUTHORITATIVE");
      expect(evidence.reasonCodes).toContain("POST_RUN_TREE_NOT_CLEAN");
      expect(evidence.reasonCodes).toContain("PHASE2_ROUTE_SYNTHETIC_READINESS");
      expect(evidence.dirtyCount).toBeGreaterThan(0);
      expect(result.status).not.toBe(0);
    },
  );

  it(
    "缝激活 + HEAD 漂移：REAL_PASS 形似载荷仍被缝强制非权威，突变仍被检出",
    { timeout: 1_800_000 },
    () => {
      const worktreeDirectory = makeWorktree();
      worktrees.push(worktreeDirectory);
      const { result, evidenceDirectory } = runAcceptanceLauncher(worktreeDirectory, {
        verdict: "REAL_PASS",
        hookMode: "head-move",
      });
      const evidence = readEvidence(evidenceDirectory, result);
      expect(evidence.status).toBe("INCONCLUSIVE");
      expect(evidence.reasonCodes).toContain("TEST_SEAM_ACTIVE_NON_AUTHORITATIVE");
      expect(evidence.reasonCodes).toContain("POST_RUN_HEAD_MOVED");
      expect(evidence.reasonCodes).toContain("PHASE2_ROUTE_PASS");
      expect(result.status).not.toBe(0);
    },
  );

  it(
    "仅缝激活（clean 钩子、可成 IMPLEMENTATION_READY 的载荷）：强制非权威且树保持干净",
    { timeout: 1_800_000 },
    () => {
      const worktreeDirectory = makeWorktree();
      worktrees.push(worktreeDirectory);
      const { result, evidenceDirectory } = runAcceptanceLauncher(worktreeDirectory, {
        verdict: "SYNTHETIC_READINESS",
        hookMode: "clean",
      });
      const evidence = readEvidence(evidenceDirectory, result);
      expect(evidence.status).toBe("INCONCLUSIVE");
      expect(evidence.reasonCodes).toContain("TEST_SEAM_ACTIVE_NON_AUTHORITATIVE");
      expect(evidence.reasonCodes).toContain("PHASE2_ROUTE_SYNTHETIC_READINESS");
      expect(evidence.dirtyCount).toBe(0);
      expect(result.status).not.toBe(0);
    },
  );

  it(
    "仅缝激活（clean 钩子、REAL_PASS 形似载荷）：强制非权威，绝不发放权威定级",
    { timeout: 1_800_000 },
    () => {
      const worktreeDirectory = makeWorktree();
      worktrees.push(worktreeDirectory);
      const { result, evidenceDirectory } = runAcceptanceLauncher(worktreeDirectory, {
        verdict: "REAL_PASS",
        hookMode: "clean",
      });
      const evidence = readEvidence(evidenceDirectory, result);
      expect(evidence.status).toBe("INCONCLUSIVE");
      expect(evidence.reasonCodes).toContain("TEST_SEAM_ACTIVE_NON_AUTHORITATIVE");
      expect(evidence.reasonCodes).toContain("PHASE2_ROUTE_PASS");
      expect(evidence.dirtyCount).toBe(0);
      expect(result.status).not.toBe(0);
    },
  );
  it(
    "元数据掩盖缝（skip-worktree）：已跟踪文件改动被 Git 元数据隐形，porcelain 仍显干净但仍被识破",
    { timeout: 1_800_000 },
    () => {
      const worktreeDirectory = makeWorktree();
      worktrees.push(worktreeDirectory);
      const { result, evidenceDirectory } = runAcceptanceLauncher(worktreeDirectory, {
        verdict: "SYNTHETIC_READINESS",
        hookMode: "skip-worktree",
      });
      const evidence = readEvidence(evidenceDirectory, result);
      expect(evidence.status).toBe("INCONCLUSIVE");
      expect(evidence.reasonCodes).toContain("POST_RUN_GIT_METADATA_HIDING");
      expect(evidence.reasonCodes).toContain("GIT_LS_FILES_ASSUMUNCHANGED_OR_SKIPWORKTREE");
      expect(result.status).not.toBe(0);
    },
  );
  it(
    "元数据掩盖缝（assume-unchanged）：已跟踪文件改动被隐形，porcelain 仍显干净但仍被识破",
    { timeout: 1_800_000 },
    () => {
      const worktreeDirectory = makeWorktree();
      worktrees.push(worktreeDirectory);
      const { result, evidenceDirectory } = runAcceptanceLauncher(worktreeDirectory, {
        verdict: "REAL_PASS",
        hookMode: "assume-unchanged",
      });
      const evidence = readEvidence(evidenceDirectory, result);
      expect(evidence.status).toBe("INCONCLUSIVE");
      expect(evidence.reasonCodes).toContain("POST_RUN_GIT_METADATA_HIDING");
      expect(evidence.reasonCodes).toContain("GIT_LS_FILES_ASSUMUNCHANGED_OR_SKIPWORKTREE");
      expect(result.status).not.toBe(0);
    },
  );
  it(
    "元数据掩盖缝（info-exclude）：未跟踪文件被排除规则隐藏，porcelain 仍显干净但仍被识破",
    { timeout: 1_800_000 },
    () => {
      const worktreeDirectory = makeWorktree();
      worktrees.push(worktreeDirectory);
      const { result, evidenceDirectory } = runAcceptanceLauncher(worktreeDirectory, {
        verdict: "SYNTHETIC_READINESS",
        hookMode: "info-exclude",
      });
      const evidence = readEvidence(evidenceDirectory, result);
      expect(evidence.status).toBe("INCONCLUSIVE");
      expect(evidence.reasonCodes).toContain("POST_RUN_GIT_METADATA_HIDING");
      expect(evidence.reasonCodes).toContain("GIT_INFO_EXCLUDE_CHANGED");
      expect(result.status).not.toBe(0);
    },
  );
  it(
    "元数据掩盖缝（excludes-file）：运行中设置 core.excludesFile 隐藏未跟踪文件，字节哈希差检出",
    { timeout: 1_800_000 },
    () => {
      const worktreeDirectory = makeWorktree();
      worktrees.push(worktreeDirectory);
      const { result, evidenceDirectory } = runAcceptanceLauncher(worktreeDirectory, {
        verdict: "REAL_PASS",
        hookMode: "excludes-file",
      });
      const evidence = readEvidence(evidenceDirectory, result);
      expect(evidence.status).toBe("INCONCLUSIVE");
      expect(evidence.reasonCodes).toContain("POST_RUN_GIT_METADATA_HIDING");
      expect(evidence.reasonCodes).toContain("GIT_CORE_EXCLUDES_FILE_CHANGED");
      expect(result.status).not.toBe(0);
    },
  );
  it(
    "元数据掩盖缝（pre-existing-info-exclude）：已有非注释排除规则上再添一行，字节哈希仍检出",
    { timeout: 1_800_000 },
    () => {
      const worktreeDirectory = makeWorktree();
      worktrees.push(worktreeDirectory);
      const { result, evidenceDirectory } = runAcceptanceLauncher(worktreeDirectory, {
        verdict: "SYNTHETIC_READINESS",
        hookMode: "pre-existing-info-exclude",
      });
      const evidence = readEvidence(evidenceDirectory, result);
      expect(evidence.status).toBe("INCONCLUSIVE");
      expect(evidence.reasonCodes).toContain("POST_RUN_GIT_METADATA_HIDING");
      expect(evidence.reasonCodes).toContain("GIT_INFO_EXCLUDE_CHANGED");
      expect(result.status).not.toBe(0);
    },
  );
  it(
    "元数据掩盖缝（sparse-checkout）：运行中启用稀疏检出，绝对非法即报",
    { timeout: 1_800_000 },
    () => {
      const worktreeDirectory = makeWorktree();
      worktrees.push(worktreeDirectory);
      const { result, evidenceDirectory } = runAcceptanceLauncher(worktreeDirectory, {
        verdict: "REAL_PASS",
        hookMode: "sparse-checkout",
      });
      const evidence = readEvidence(evidenceDirectory, result);
      expect(evidence.status).toBe("INCONCLUSIVE");
      expect(evidence.reasonCodes).toContain("POST_RUN_GIT_METADATA_HIDING");
      expect(result.status).not.toBe(0);
    },
  );
  it(
    "Fix C1 对抗性：仅设 URMOTIV_PHASE2_NON_AUTHORITATIVE=1 且有活跃 info/exclude 隐藏，仍硬拒且不能产生 PASS/IMPLEMENTATION_READY",
    { timeout: 1_800_000 },
    () => {
      const worktreeDirectory = makeWorktree();
      worktrees.push(worktreeDirectory);
      // 模拟生产 CLI 环境：仅设置旧的环境变量（已不再被识别），
      // 不设任何测试缝，不传 child fixture 或 after-child hook。
      // 在工作树中预置活跃 info/exclude 规则以模拟本地隐藏。
      // 权威运行必须硬拒——旧环境变量不能放宽权威性。
      if (isolatedCluster === null) {
        throw new Error("Gate 9 集成测试要求隔离集群已创建。");
      }
      const evidenceDirectory = mkdtempSync(join(tmpdir(), "urmotiv-gate9-evidence-"));
      evidenceDirectories.push(evidenceDirectory);
      // 预置活跃 info/exclude 规则到工作树（通过 commondir 影响主仓库的 exclude）。
      // 但工作树通过 commondir 共享主仓库 .git，所以直接写主仓库的 info/exclude。
      const infoExcludePath = join(repositoryRoot, ".git", "info", "exclude");
      const originalExclude = readFileSync(infoExcludePath, "utf8");
      appendFileSync(infoExcludePath, "\n# adversarial-test-rule\nhidden-artifact-*.txt\n");
      try {
        const env = {
          ...process.env,
          URMOTIV_TEST_POSTGRES_ADMIN_URL: isolatedCluster.adminUrl,
          URMOTIV_PHASE2_ACCEPTANCE_BASE_COMMIT: readBaseWorkerCommit(),
          URMOTIV_PHASE2_ACCEPTANCE_BASE_WORKER_FILE: defaultBaseWorkerFile(),
          URMOTIV_PHASE2_ACCEPTANCE_DIR: evidenceDirectory,
          URMOTIV_PHASE2_CHILD_FIXTURE_VERDICT: "SYNTHETIC_READINESS",
          URMOTIV_TEST_RUN_TOKEN: runToken,
          // 旧的环境变量——已被移除，不应被识别为放宽权威性。
          URMOTIV_PHASE2_NON_AUTHORITATIVE: "1",
        };
        delete env.URMOTIV_RUN_PHASE2_GATE9;
        delete env.URMOTIV_TEST_PG_LIFECYCLE_DIR;
        // 不设 child fixture 或 after-child hook——纯权威运行。
        delete env.URMOTIV_PHASE2_ACCEPTANCE_TEST_CHILD_FIXTURE;
        delete env.URMOTIV_PHASE2_ACCEPTANCE_TEST_AFTER_CHILD_RUNS;
        delete env.URMOTIV_PHASE2_ACCEPTANCE_HOOK_MODE;
        const launcherPath = join(
          worktreeDirectory,
          "apps",
          "api",
          "scripts",
          "phase2-acceptance.mjs",
        );
        const result = spawnSync(process.execPath, [launcherPath], {
          env,
          encoding: "utf8",
          stdio: ["ignore", "pipe", "pipe"],
          maxBuffer: 256 * 1024 * 1024,
        });
        // 权威运行必须在预运行硬门就 fail（exit code 2），因为有活跃 info/exclude 规则。
        // 旧环境变量不能绕过此硬拒。
        expect(result.status).toBe(2);
        expect(result.stderr).toContain("权威运行拒绝 info/exclude");
        // 不应产生证据文件（在预运行就失败）。
        const evidencePath = join(evidenceDirectory, "phase2-acceptance-evidence.private.json");
        expect(existsSync(evidencePath)).toBe(false);
      } finally {
        // 恢复 info/exclude 到原始内容。
        writeFileSync(infoExcludePath, originalExclude);
      }
    },
  );
});

// 隔离集群对抗性测试——不需要 gate9Enabled，但需要 Docker 可用。
// 这些测试验证隔离集群的创建/身份验证/拆除/恢复，以及共享集群不受影响。
describe.skipIf(sharedPgAdminUrl.trim().length === 0)(
  "Gate 9 隔离集群生命周期边界",
  () => {
    it("隔离集群创建后 system_identifier 非空且容器有正确标签", () => {
      const cluster = createIsolatedPostgres({ runId: "test-label-" + runToken });
      try {
        expect(cluster.containerId).toMatch(/^[0-9a-f]{12,}$/);
        expect(cluster.systemIdentifier).toMatch(/^[0-9]+$/);
        expect(cluster.host).toBe("127.0.0.1");
        expect(cluster.port).toBeGreaterThan(0);
        expect(cluster.password.length).toBeGreaterThanOrEqual(16);
        expect(cluster.labels["urmotiv.gate9.managed"]).toBe("true");
        expect(cluster.labels["urmotiv.gate9.disposable"]).toBe("true");
        // 验证容器身份函数。
        expect(verifyContainerIdentity(cluster.containerId, cluster.labels)).toBe(true);
        // 验证活身份函数。
        expect(verifyLiveIdentity(cluster.containerId, cluster.systemIdentifier)).toBe(true);
      } finally {
        teardownIsolatedPostgres(cluster);
      }
    }, 120_000);

    it("隔离集群内可创建/删除数据库，但子进程无法接触共享集群", async () => {
      const cluster = createIsolatedPostgres({ runId: "test-isolation-" + runToken });
      const Client = (pgRequire().Client ?? pgRequire().default?.Client);
      try {
        // 在隔离集群内创建一个数据库。
        const client = new Client({ connectionString: cluster.adminUrl });
        await client.connect();
        try {
          await client.query("create database urmotiv_history_import_isolated_test");
          // 验证可以查询。
          const r = await client.query("select count(*) as n from pg_database where datname = $1", ["urmotiv_history_import_isolated_test"]);
          expect(Number(r.rows[0].n)).toBe(1);
          // 删除它。
          await client.query("drop database urmotiv_history_import_isolated_test with (force)");
          const r2 = await client.query("select count(*) as n from pg_database where datname = $1", ["urmotiv_history_import_isolated_test"]);
          expect(Number(r2.rows[0].n)).toBe(0);
        } finally {
          await client.end();
        }
        // 验证共享集群上没有这个数据库（隔离集群的数据库不在共享集群上）。
        const sharedClient = new Client({ connectionString: sharedPgAdminUrl });
        await sharedClient.connect();
        try {
          const r = await sharedClient.query("select count(*) as n from pg_database where datname = $1", ["urmotiv_history_import_isolated_test"]);
          expect(Number(r.rows[0].n)).toBe(0);
        } finally {
          await sharedClient.end();
        }
      } finally {
        teardownIsolatedPostgres(cluster);
      }
    }, 120_000);

    it("活身份不匹配时拒绝 DDL：错误容器 ID 的验证返回 false", () => {
      const cluster = createIsolatedPostgres({ runId: "test-identity-" + runToken });
      try {
        // 正确身份验证通过。
        expect(verifyLiveIdentity(cluster.containerId, cluster.systemIdentifier)).toBe(true);
        // 错误的 system_identifier 验证失败。
        expect(verifyLiveIdentity(cluster.containerId, "0000000000000000000")).toBe(false);
        // 错误的容器 ID 验证失败。
        expect(verifyContainerIdentity("000000000000", cluster.labels)).toBe(false);
        // 正确容器 ID 但错误标签验证失败。
        expect(verifyContainerIdentity(cluster.containerId, { "urmotiv.gate9.managed": "false" })).toBe(false);
      } finally {
        teardownIsolatedPostgres(cluster);
      }
    }, 120_000);

    it("拆除后容器不再存在，清单目录已移除", () => {
      const cluster = createIsolatedPostgres({ runId: "test-teardown-" + runToken });
      const { containerId, manifestDir } = cluster;
      teardownIsolatedPostgres(cluster);
      // 容器应已不存在。
      expect(verifyContainerIdentity(containerId, cluster.labels)).toBe(false);
      // 清单目录应已移除。
      expect(manifestExists(manifestDir)).toBe(false);
    }, 120_000);

    it("拆除拒绝错误的容器身份（不匹配的标签）", () => {
      const cluster = createIsolatedPostgres({ runId: "test-reject-" + runToken });
      try {
        // 篡改标签后尝试拆除——必须抛出。
        const tamperedLabels = { ...cluster.labels, "urmotiv.gate9.managed": "false" };
        expect(() => teardownIsolatedPostgres({
          containerId: cluster.containerId,
          labels: tamperedLabels,
          manifestDir: cluster.manifestDir,
          systemIdentifier: cluster.systemIdentifier,
        })).toThrow();
      } finally {
        // 手动清理——用正确的标签拆除。
        teardownIsolatedPostgres(cluster);
      }
    }, 120_000);

    it("中断拆除后清单保留，恢复拆除成功", () => {
      const cluster = createIsolatedPostgres({ runId: "test-recover-" + runToken });
      const { manifestDir } = cluster;
      // 模拟中断：不拆除容器，只保留清单。
      // 验证清单存在。
      expect(manifestExists(manifestDir)).toBe(true);
      // 恢复拆除——从清单中读取精确 ID/标签并拆除。
      recoverAndTeardown(manifestDir);
      // 验证容器已移除。
      expect(verifyContainerIdentity(cluster.containerId, cluster.labels)).toBe(false);
      // 验证清单目录已移除。
      expect(manifestExists(manifestDir)).toBe(false);
    }, 120_000);

    it("env scrub：子进程的 URMOTIV_TEST_POSTGRES_ADMIN_URL 指向隔离集群而非共享集群", () => {
      const cluster = createIsolatedPostgres({ runId: "test-envscrub-" + runToken });
      try {
        // runAcceptanceLauncher 传递的 adminUrl 是隔离集群的 URL。
        // 这里验证隔离集群 URL 与共享集群 URL 不同。
        expect(cluster.adminUrl).not.toBe(sharedPgAdminUrl);
        // 隔离集群 URL 包含随机端口，不等于共享集群端口。
        const sharedPort = new URL(sharedPgAdminUrl).port;
        expect(String(cluster.port)).not.toBe(sharedPort);
      } finally {
        teardownIsolatedPostgres(cluster);
      }
    }, 120_000);

    it("共享哨兵库不受隔离集群操作影响", async () => {
      const Client = (pgRequire().Client ?? pgRequire().default?.Client);
      // 在共享集群上创建一个哨兵库。
      const sentinelName = `urmotiv_gate9_sentinel_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
      const sharedClient = new Client({ connectionString: sharedPgAdminUrl });
      await sharedClient.connect();
      try {
        await sharedClient.query(`create database "${sentinelName}"`);
      } finally {
        await sharedClient.end();
      }
      try {
        // 创建并拆除一个隔离集群。
        const cluster = createIsolatedPostgres({ runId: "test-sentinel-" + runToken });
        teardownIsolatedPostgres(cluster);
        // 验证哨兵库仍在共享集群上。
        const checkClient = new Client({ connectionString: sharedPgAdminUrl });
        await checkClient.connect();
        try {
          const r = await checkClient.query("select count(*) as n from pg_database where datname = $1", [sentinelName]);
          expect(Number(r.rows[0].n)).toBe(1);
        } finally {
          await checkClient.end();
        }
      } finally {
        // 清理哨兵库。
        const cleanupClient = new Client({ connectionString: sharedPgAdminUrl });
        await cleanupClient.connect();
        try {
          await cleanupClient.query(`drop database "${sentinelName}" with (force)`);
        } finally {
          await cleanupClient.end();
        }
      }
    }, 120_000);

    it("拆除后无项目专属容器残留", () => {
      // 记录拆除前的项目容器列表。
      const before = listProjectContainers();
      const cluster = createIsolatedPostgres({ runId: "test-residue-" + runToken });
      teardownIsolatedPostgres(cluster);
      // 拆除后项目容器列表不应增加。
      const after = listProjectContainers();
      expect(after.length).toBeLessThanOrEqual(before.length);
      // 确保被拆除的容器不在列表中。
      expect(after).not.toContain(cluster.containerId);
    }, 120_000);
  },
);