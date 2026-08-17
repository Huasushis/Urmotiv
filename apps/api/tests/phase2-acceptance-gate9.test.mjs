// Gate 9 集成测试：验收运行结束后、终判定之前的整树突变，必须把
// 本可成功的定级（IMPLEMENTATION_READY / REAL_PASS）硬压为 INCONCLUSIVE，
// 并以非零退出码结束。整条链路只在一次性 Git worktree 内执行：
//   1. 用已提交检出创建 --detach worktree；
//   2. 把主仓库的 node_modules 目录按包软链进 worktree；
//   3. 环境变量显式指定路由夹具与后置突变夹具；
//   4. 运行真实的 scripts/phase2-acceptance.mjs（在无 Docker 权限的 runner 容器内）；
//   5. 解析证据断言 POST_RUN_* 理由、INCONCLUSIVE 与非零退出；
//   6. 无论成败都移除 worktree 并在主检出上硬门断言整树干净。
//
// Sol HOLD 第三版：物理隔离 + 无 Docker 权限子进程 + 显式环境白名单。
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
  verifyNetworkIdentity,
  verifyManifestPermissions,
  listProjectContainers,
  listProjectNetworks,
  manifestExists,
  recoverAndTeardown,
  readManifest,
  createRunnerContainer,
  execInRunnerWithEnv,
  teardownRunnerContainer,
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

const runToken = `${process.pid}${randomUUID().replaceAll("-", "").slice(0, 12)}`;

// 隔离集群实例——由 beforeAll 创建，afterAll 拆除。
let primaryCluster = null;
let secondaryCluster = null;
let runnerContainer = null;
let dockerNetworkName = null;

function pgRequire() {
  const req = nodeCreateRequire(import.meta.url);
  try {
    return req("pg");
  } catch {
    const dbPkgPath = join(repositoryRoot, "packages", "database", "package.json");
    return nodeCreateRequire(dbPkgPath)("pg");
  }
}

/**
 * 构建子进程环境白名单——只包含必需的非密钥运行时/工具/测试变量。
 * 绝不展开 process.env。所有共享/正式 DB URL、Docker 变量、不相关密钥均被清除。
 */
function buildChildEnv(isolatedAdminUrl, secondaryUrl, extra = {}) {
  // 白名单：只有这些变量从 process.env 继承。
  const ALLOWLIST = new Set([
    "PATH",
    "HOME",
    "USER",
    "LANG",
    "LC_ALL",
    "TERM",
    "SHELL",
    "TMPDIR",
  ]);
  const env = {};
  for (const key of ALLOWLIST) {
    if (process.env[key] !== undefined) {
      env[key] = process.env[key];
    }
  }
  // 设置隔离集群的连接参数——子进程只能接触隔离集群。
  env.URMOTIV_TEST_POSTGRES_ADMIN_URL = isolatedAdminUrl;
  if (secondaryUrl) {
    env.URMOTIV_TEST_SECONDARY_PG_URL = secondaryUrl;
  }
  // 验收测试必需的变量。
  env.URMOTIV_PHASE2_ACCEPTANCE_BASE_COMMIT = readBaseWorkerCommit();
  env.URMOTIV_PHASE2_ACCEPTANCE_BASE_WORKER_FILE = defaultBaseWorkerFile();
  env.URMOTIV_TEST_RUN_TOKEN = runToken;
  // 合并额外变量（如证据目录、夹具路径等）。
  Object.assign(env, extra);
  // 显式清除所有可能泄露共享集群凭据或 Docker 权限的变量。
  for (const key of Object.keys(env)) {
    if (key.startsWith("DB_") || key.startsWith("PG") || key.startsWith("DOCKER") ||
        key.startsWith("COMPOSE_") || key.includes("POSTGRES") && !key.startsWith("URMOTIV_")) {
      delete env[key];
    }
  }
  return env;
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

/**
 * 在 runner 容器内运行验收启动器。
 * runner 容器无 Docker socket——子进程无法调用 docker。
 */
function runAcceptanceLauncherInRunner(worktreeDirectory, { verdict, hookMode }) {
  if (primaryCluster === null || runnerContainer === null) {
    throw new Error("Gate 9 集成测试要求隔离集群和 runner 容器已创建。");
  }
  const evidenceDirectory = mkdtempSync(join(tmpdir(), "urmotiv-gate9-evidence-"));
  evidenceDirectories.push(evidenceDirectory);

  // 子进程在 runner 容器内，通过 Docker 网络连接 PG 容器。
  // 用容器名作为主机名（Docker DNS 解析）。
  const primaryContainerName = primaryCluster.containerId.slice(0, 12);
  const isolatedAdminUrl = `postgres://postgres:${encodeURIComponent(primaryCluster.password)}@${primaryContainerName}:5432/postgres`;
  const secondaryContainerName = secondaryCluster
    ? secondaryCluster.containerId.slice(0, 12)
    : null;
  const secondaryUrl = secondaryContainerName
    ? `postgres://postgres:${encodeURIComponent(secondaryCluster.password)}@${secondaryContainerName}:5432/postgres`
    : null;

  const env = buildChildEnv(isolatedAdminUrl, secondaryUrl, {
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
  });

  const launcherPath = join(
    worktreeDirectory,
    "apps",
    "api",
    "scripts",
    "phase2-acceptance.mjs",
  );
  const nodePath = "/home/ubuntu/codex-urmotiv/.tools/node-v24.18.0-linux-x64/bin/node";

  // 在 runner 容器内执行启动器。
  const result = execInRunnerWithEnv(
    runnerContainer.containerId,
    env,
    [nodePath, launcherPath],
    { cwd: worktreeDirectory },
  );

  return { result, evidenceDirectory };
}

/**
 * 在 runner 容器内运行纯权威运行（无夹具/钩子）。
 */
function runAuthoritativeInRunner(worktreeDirectory, extraEnv = {}) {
  if (primaryCluster === null || runnerContainer === null) {
    throw new Error("Gate 9 集成测试要求隔离集群和 runner 容器已创建。");
  }
  const evidenceDirectory = mkdtempSync(join(tmpdir(), "urmotiv-gate9-evidence-"));
  evidenceDirectories.push(evidenceDirectory);

  const primaryContainerName = primaryCluster.containerId.slice(0, 12);
  const isolatedAdminUrl = `postgres://postgres:${encodeURIComponent(primaryCluster.password)}@${primaryContainerName}:5432/postgres`;

  const env = buildChildEnv(isolatedAdminUrl, null, {
    URMOTIV_PHASE2_ACCEPTANCE_DIR: evidenceDirectory,
    ...extraEnv,
  });
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
  const nodePath = "/home/ubuntu/codex-urmotiv/.tools/node-v24.18.0-linux-x64/bin/node";

  const result = execInRunnerWithEnv(
    runnerContainer.containerId,
    env,
    [nodePath, launcherPath],
    { cwd: worktreeDirectory },
  );

  return { result, evidenceDirectory };
}

function readEvidence(evidenceDirectory, result) {
  const path = join(evidenceDirectory, "phase2-acceptance-evidence.private.json");
  if (!existsSync(path)) {
    const stderr = typeof result.stderr === "string" ? result.stderr : "";
    throw new Error(`证据文件不存在。stderr: ${stderr}`);
  }
  const evidence = JSON.parse(readFileSync(path, "utf8"));
  return evidence;
}
function removeGate9Resources() {
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
  if (!sharedExcludeCaptured || sharedExcludeOriginal === null) {
    throw new Error("restoreSharedExcludes 在 enableSharedExcludes 之前被调用。");
  }
  writeFileSync(sharedExcludePath, sharedExcludeOriginal);
  sharedExcludeOriginal = null;
  sharedExcludeCaptured = false;
}

function verifySharedExcludesRestored() {
  const snapshot = configSnapshot.get("__info_exclude_original__");
  if (typeof snapshot !== "string") {
    throw new Error("info/exclude 原始字节快照缺失，验证无法成立。");
  }
  const current = readFileSync(sharedExcludePath, "utf8");
  if (current !== snapshot) {
    throw new Error("info/exclude 未恢复到测试前精确字节。");
  }
}

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
    snapshotGitConfig();
    enableSharedExcludes();
    // 创建主隔离集群（primary）——子进程通过 Docker 网络连接。
    primaryCluster = createIsolatedPostgres({ runId: runToken, role: "primary" });
    dockerNetworkName = primaryCluster.networkName;
    // 创建次隔离集群（secondary）——用于活身份改指测试。
    secondaryCluster = createIsolatedPostgres({
      runId: runToken,
      role: "secondary",
      networkName: dockerNetworkName,
    });
    // 创建 runner 容器——无 Docker socket，在同一 Docker 网络上。
    runnerContainer = createRunnerContainer({
      runId: runToken,
      networkName: dockerNetworkName,
      mounts: [
        ["/home/ubuntu/codex-urmotiv", "/home/ubuntu/codex-urmotiv", "bind"],
        ["/tmp", "/tmp", "bind"],
      ],
      workDir: "/home/ubuntu/codex-urmotiv/Urmotiv/apps/api",
    });
  }, 300_000);

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
    // 拆除 runner 容器。
    try {
      if (runnerContainer !== null) {
        teardownRunnerContainer(runnerContainer);
        runnerContainer = null;
      }
    } catch (error) {
      failure ??= error;
    }
    // 拆除次集群。
    try {
      if (secondaryCluster !== null) {
        teardownIsolatedPostgres(secondaryCluster);
        secondaryCluster = null;
      }
    } catch (error) {
      failure ??= error;
    }
    // 拆除主集群（含网络）。
    try {
      if (primaryCluster !== null) {
        teardownIsolatedPostgres(primaryCluster);
        primaryCluster = null;
      }
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
  }, 300_000);
  afterEach(async () => {
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
    try {
      enableSharedExcludes();
    } catch (error) {
      cleanupError ??= error;
    }
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
      const { result, evidenceDirectory } = runAcceptanceLauncherInRunner(worktreeDirectory, {
        verdict: "SYNTHETIC_READINESS",
        hookMode: "dirty",
      });
      const evidence = readEvidence(evidenceDirectory, result);
      expect(evidence.status).toBe("INCONCLUSIVE");
      expect(evidence.reasonCodes).toContain("TEST_SEAM_ACTIVE_NON_AUTHORITATIVE");
      expect(evidence.reasonCodes).toContain("POST_RUN_TREE_NOT_CLEAN");
      expect(evidence.reasonCodes).toContain("PHASE2_ROUTE_SYNTHETIC_READINESS");
      expect(evidence.dirtyCount).toBeGreaterThan(0);
      expect(result.ok).toBe(false);
    },
  );

  it(
    "缝激活 + HEAD 漂移：REAL_PASS 形似载荷仍被缝强制非权威，突变仍被检出",
    { timeout: 1_800_000 },
    () => {
      const worktreeDirectory = makeWorktree();
      worktrees.push(worktreeDirectory);
      const { result, evidenceDirectory } = runAcceptanceLauncherInRunner(worktreeDirectory, {
        verdict: "REAL_PASS",
        hookMode: "head-move",
      });
      const evidence = readEvidence(evidenceDirectory, result);
      expect(evidence.status).toBe("INCONCLUSIVE");
      expect(evidence.reasonCodes).toContain("TEST_SEAM_ACTIVE_NON_AUTHORITATIVE");
      expect(evidence.reasonCodes).toContain("POST_RUN_HEAD_MOVED");
      expect(evidence.reasonCodes).toContain("PHASE2_ROUTE_PASS");
      expect(result.ok).toBe(false);
    },
  );

  it(
    "仅缝激活（clean 钩子、可成 IMPLEMENTATION_READY 的载荷）：强制非权威且树保持干净",
    { timeout: 1_800_000 },
    () => {
      const worktreeDirectory = makeWorktree();
      worktrees.push(worktreeDirectory);
      const { result, evidenceDirectory } = runAcceptanceLauncherInRunner(worktreeDirectory, {
        verdict: "SYNTHETIC_READINESS",
        hookMode: "clean",
      });
      const evidence = readEvidence(evidenceDirectory, result);
      expect(evidence.status).toBe("INCONCLUSIVE");
      expect(evidence.reasonCodes).toContain("TEST_SEAM_ACTIVE_NON_AUTHORITATIVE");
      expect(evidence.reasonCodes).toContain("PHASE2_ROUTE_SYNTHETIC_READINESS");
      expect(evidence.dirtyCount).toBe(0);
      expect(result.ok).toBe(false);
    },
  );

  it(
    "仅缝激活（clean 钩子、REAL_PASS 形似载荷）：强制非权威，绝不发放权威定级",
    { timeout: 1_800_000 },
    () => {
      const worktreeDirectory = makeWorktree();
      worktrees.push(worktreeDirectory);
      const { result, evidenceDirectory } = runAcceptanceLauncherInRunner(worktreeDirectory, {
        verdict: "REAL_PASS",
        hookMode: "clean",
      });
      const evidence = readEvidence(evidenceDirectory, result);
      expect(evidence.status).toBe("INCONCLUSIVE");
      expect(evidence.reasonCodes).toContain("TEST_SEAM_ACTIVE_NON_AUTHORITATIVE");
      expect(evidence.reasonCodes).toContain("PHASE2_ROUTE_PASS");
      expect(evidence.dirtyCount).toBe(0);
      expect(result.ok).toBe(false);
    },
  );
  it(
    "元数据掩盖缝（skip-worktree）：已跟踪文件改动被 Git 元数据隐形，porcelain 仍显干净但仍被识破",
    { timeout: 1_800_000 },
    () => {
      const worktreeDirectory = makeWorktree();
      worktrees.push(worktreeDirectory);
      const { result, evidenceDirectory } = runAcceptanceLauncherInRunner(worktreeDirectory, {
        verdict: "SYNTHETIC_READINESS",
        hookMode: "skip-worktree",
      });
      const evidence = readEvidence(evidenceDirectory, result);
      expect(evidence.status).toBe("INCONCLUSIVE");
      expect(evidence.reasonCodes).toContain("POST_RUN_GIT_METADATA_HIDING");
      expect(evidence.reasonCodes).toContain("GIT_LS_FILES_ASSUMUNCHANGED_OR_SKIPWORKTREE");
      expect(result.ok).toBe(false);
    },
  );
  it(
    "元数据掩盖缝（assume-unchanged）：已跟踪文件改动被隐形，porcelain 仍显干净但仍被识破",
    { timeout: 1_800_000 },
    () => {
      const worktreeDirectory = makeWorktree();
      worktrees.push(worktreeDirectory);
      const { result, evidenceDirectory } = runAcceptanceLauncherInRunner(worktreeDirectory, {
        verdict: "REAL_PASS",
        hookMode: "assume-unchanged",
      });
      const evidence = readEvidence(evidenceDirectory, result);
      expect(evidence.status).toBe("INCONCLUSIVE");
      expect(evidence.reasonCodes).toContain("POST_RUN_GIT_METADATA_HIDING");
      expect(evidence.reasonCodes).toContain("GIT_LS_FILES_ASSUMUNCHANGED_OR_SKIPWORKTREE");
      expect(result.ok).toBe(false);
    },
  );
  it(
    "元数据掩盖缝（info-exclude）：未跟踪文件被排除规则隐藏，porcelain 仍显干净但仍被识破",
    { timeout: 1_800_000 },
    () => {
      const worktreeDirectory = makeWorktree();
      worktrees.push(worktreeDirectory);
      const { result, evidenceDirectory } = runAcceptanceLauncherInRunner(worktreeDirectory, {
        verdict: "SYNTHETIC_READINESS",
        hookMode: "info-exclude",
      });
      const evidence = readEvidence(evidenceDirectory, result);
      expect(evidence.status).toBe("INCONCLUSIVE");
      expect(evidence.reasonCodes).toContain("POST_RUN_GIT_METADATA_HIDING");
      expect(evidence.reasonCodes).toContain("GIT_INFO_EXCLUDE_CHANGED");
      expect(result.ok).toBe(false);
    },
  );
  it(
    "元数据掩盖缝（excludes-file）：运行中设置 core.excludesFile 隐藏未跟踪文件，字节哈希差检出",
    { timeout: 1_800_000 },
    () => {
      const worktreeDirectory = makeWorktree();
      worktrees.push(worktreeDirectory);
      const { result, evidenceDirectory } = runAcceptanceLauncherInRunner(worktreeDirectory, {
        verdict: "REAL_PASS",
        hookMode: "excludes-file",
      });
      const evidence = readEvidence(evidenceDirectory, result);
      expect(evidence.status).toBe("INCONCLUSIVE");
      expect(evidence.reasonCodes).toContain("POST_RUN_GIT_METADATA_HIDING");
      expect(evidence.reasonCodes).toContain("GIT_CORE_EXCLUDES_FILE_CHANGED");
      expect(result.ok).toBe(false);
    },
  );
  it(
    "元数据掩盖缝（pre-existing-info-exclude）：已有非注释排除规则上再添一行，字节哈希仍检出",
    { timeout: 1_800_000 },
    () => {
      const worktreeDirectory = makeWorktree();
      worktrees.push(worktreeDirectory);
      const { result, evidenceDirectory } = runAcceptanceLauncherInRunner(worktreeDirectory, {
        verdict: "SYNTHETIC_READINESS",
        hookMode: "pre-existing-info-exclude",
      });
      const evidence = readEvidence(evidenceDirectory, result);
      expect(evidence.status).toBe("INCONCLUSIVE");
      expect(evidence.reasonCodes).toContain("POST_RUN_GIT_METADATA_HIDING");
      expect(evidence.reasonCodes).toContain("GIT_INFO_EXCLUDE_CHANGED");
      expect(result.ok).toBe(false);
    },
  );
  it(
    "元数据掩盖缝（sparse-checkout）：运行中启用稀疏检出，绝对非法即报",
    { timeout: 1_800_000 },
    () => {
      const worktreeDirectory = makeWorktree();
      worktrees.push(worktreeDirectory);
      const { result, evidenceDirectory } = runAcceptanceLauncherInRunner(worktreeDirectory, {
        verdict: "REAL_PASS",
        hookMode: "sparse-checkout",
      });
      const evidence = readEvidence(evidenceDirectory, result);
      expect(evidence.status).toBe("INCONCLUSIVE");
      expect(evidence.reasonCodes).toContain("POST_RUN_GIT_METADATA_HIDING");
      expect(result.ok).toBe(false);
    },
  );
  it(
    "Fix C1 对抗性：仅设 URMOTIV_PHASE2_NON_AUTHORITATIVE=1 且有活跃 info/exclude 隐藏，仍硬拒且不能产生 PASS/IMPLEMENTATION_READY",
    { timeout: 1_800_000 },
    () => {
      const worktreeDirectory = makeWorktree();
      worktrees.push(worktreeDirectory);
      // 预置活跃 info/exclude 规则到工作树。
      const infoExcludePath = join(repositoryRoot, ".git", "info", "exclude");
      const originalExclude = readFileSync(infoExcludePath, "utf8");
      appendFileSync(infoExcludePath, "\n# adversarial-test-rule\nhidden-artifact-*.txt\n");
      try {
        const { result, evidenceDirectory } = runAuthoritativeInRunner(worktreeDirectory, {
          URMOTIV_PHASE2_NON_AUTHORITATIVE: "1",
          URMOTIV_PHASE2_CHILD_FIXTURE_VERDICT: "SYNTHETIC_READINESS",
        });
        // 权威运行必须在预运行硬门就 fail（exit code 2），因为有活跃 info/exclude 规则。
        expect(result.ok).toBe(false);
        expect(result.stderr).toContain("权威运行拒绝 info/exclude");
        // 不应产生证据文件（在预运行就失败）。
        const evidencePath = join(evidenceDirectory, "phase2-acceptance-evidence.private.json");
        expect(existsSync(evidencePath)).toBe(false);
      } finally {
        writeFileSync(infoExcludePath, originalExclude);
      }
    },
  );
});

// 隔离集群对抗性测试——不需要 gate9Enabled，但需要 Docker 和共享集群可用。
describe.skipIf(sharedPgAdminUrl.trim().length === 0)(
  "Gate 9 隔离集群生命周期边界",
  () => {
    it("隔离集群创建后 system_identifier 非空且容器有正确标签和全 64 字符 ID", () => {
      const cluster = createIsolatedPostgres({ runId: "test-label-" + runToken, role: "primary" });
      try {
        expect(cluster.containerId).toMatch(/^[0-9a-f]{64}$/);
        expect(cluster.systemIdentifier).toMatch(/^[0-9]+$/);
        expect(cluster.host).toBe("127.0.0.1");
        expect(cluster.port).toBeGreaterThan(0);
        expect(cluster.password.length).toBeGreaterThanOrEqual(16);
        expect(cluster.labels["urmotiv.gate9.managed"]).toBe("true");
        expect(cluster.labels["urmotiv.gate9.disposable"]).toBe("true");
        expect(cluster.labels["urmotiv.gate9.role"]).toBe("primary");
        // 验证容器身份函数（含镜像验证）。
        expect(verifyContainerIdentity(cluster.containerId, cluster.labels, cluster.image)).toBe(true);
        // 验证活身份函数。
        expect(verifyLiveIdentity(cluster.containerId, cluster.systemIdentifier)).toBe(true);
        // 验证网络身份。
        expect(verifyNetworkIdentity(cluster.networkName, cluster.runId)).toBe(true);
      } finally {
        teardownIsolatedPostgres(cluster);
      }
    }, 120_000);

    it("隔离集群内可创建/删除数据库，但共享集群上不出现", async () => {
      const cluster = createIsolatedPostgres({ runId: "test-isolation-" + runToken, role: "primary" });
      const Client = (pgRequire().Client ?? pgRequire().default?.Client);
      try {
        const client = new Client({ connectionString: cluster.adminUrl });
        await client.connect();
        try {
          await client.query("create database urmotiv_history_import_isolated_test");
          const r = await client.query("select count(*) as n from pg_database where datname = $1", ["urmotiv_history_import_isolated_test"]);
          expect(Number(r.rows[0].n)).toBe(1);
          await client.query("drop database urmotiv_history_import_isolated_test with (force)");
          const r2 = await client.query("select count(*) as n from pg_database where datname = $1", ["urmotiv_history_import_isolated_test"]);
          expect(Number(r2.rows[0].n)).toBe(0);
        } finally {
          await client.end();
        }
        // 验证共享集群上没有这个数据库。
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

    it("活身份不匹配时验证返回 false：错误容器 ID/标签/system_identifier", () => {
      const cluster = createIsolatedPostgres({ runId: "test-identity-" + runToken, role: "primary" });
      try {
        expect(verifyLiveIdentity(cluster.containerId, cluster.systemIdentifier)).toBe(true);
        expect(verifyLiveIdentity(cluster.containerId, "0000000000000000000")).toBe(false);
        // 前缀 ID 验证失败（必须全 64 字符）。
        expect(verifyContainerIdentity(cluster.containerId.slice(0, 12), cluster.labels)).toBe(false);
        expect(verifyContainerIdentity("0".repeat(64), cluster.labels)).toBe(false);
        expect(verifyContainerIdentity(cluster.containerId, { "urmotiv.gate9.managed": "false" })).toBe(false);
        // 错误镜像验证失败。
        expect(verifyContainerIdentity(cluster.containerId, cluster.labels, "wrong:latest")).toBe(false);
      } finally {
        teardownIsolatedPostgres(cluster);
      }
    }, 120_000);

    it("拆除后容器和网络不再存在，清单目录已移除", () => {
      const cluster = createIsolatedPostgres({ runId: "test-teardown-" + runToken, role: "primary" });
      const { containerId, manifestDir, networkName } = cluster;
      teardownIsolatedPostgres(cluster);
      expect(verifyContainerIdentity(containerId, cluster.labels)).toBe(false);
      expect(manifestExists(manifestDir)).toBe(false);
      // 网络也应已移除。
      expect(verifyNetworkIdentity(networkName)).toBe(false);
    }, 120_000);

    it("拆除拒绝错误的容器身份（不匹配的标签）", () => {
      const cluster = createIsolatedPostgres({ runId: "test-reject-" + runToken, role: "primary" });
      try {
        const tamperedLabels = { ...cluster.labels, "urmotiv.gate9.managed": "false" };
        expect(() => teardownIsolatedPostgres({
          ...cluster,
          labels: tamperedLabels,
        })).toThrow();
      } finally {
        teardownIsolatedPostgres(cluster);
      }
    }, 120_000);

    it("拆除拒绝前缀 ID（非全 64 字符）", () => {
      const cluster = createIsolatedPostgres({ runId: "test-prefix-" + runToken, role: "primary" });
      try {
        expect(() => teardownIsolatedPostgres({
          ...cluster,
          containerId: cluster.containerId.slice(0, 12),
        })).toThrow();
      } finally {
        teardownIsolatedPostgres(cluster);
      }
    }, 120_000);

    it("中断拆除后清单保留，恢复拆除成功", () => {
      const cluster = createIsolatedPostgres({ runId: "test-recover-" + runToken, role: "primary" });
      const { manifestDir } = cluster;
      expect(manifestExists(manifestDir)).toBe(true);
      expect(verifyManifestPermissions(manifestDir)).toBe(true);
      recoverAndTeardown(manifestDir);
      expect(verifyContainerIdentity(cluster.containerId, cluster.labels)).toBe(false);
      expect(manifestExists(manifestDir)).toBe(false);
    }, 120_000);

    it("已停止容器的安全恢复：start → 验证身份 → stop → rm", () => {
      const cluster = createIsolatedPostgres({ runId: "test-stopped-" + runToken, role: "primary" });
      // 手动停止容器（模拟中断后容器已停止）。
      execFileSync("docker", ["stop", "-t", "5", cluster.containerId], { stdio: "ignore" });
      // 拆除应成功——内部会 start → 验证身份 → stop → rm。
      teardownIsolatedPostgres(cluster);
      expect(verifyContainerIdentity(cluster.containerId, cluster.labels)).toBe(false);
    }, 120_000);

    it("env scrub：子进程环境白名单不包含共享 DB/Docker 变量", () => {
      const cluster = createIsolatedPostgres({ runId: "test-envscrub-" + runToken, role: "primary" });
      try {
        const env = buildChildEnv(cluster.adminUrl, null, {});
        // 白名单中不应有任何 DB/PG/Docker 变量。
        for (const key of Object.keys(env)) {
          expect(key.startsWith("DB_")).toBe(false);
          expect(key.startsWith("PG")).toBe(false);
          expect(key.startsWith("DOCKER")).toBe(false);
          expect(key.startsWith("COMPOSE_")).toBe(false);
        }
        // 唯一的 POSTGRES 变量是 URMOTIV_TEST_POSTGRES_ADMIN_URL（隔离集群）。
        expect(env.URMOTIV_TEST_POSTGRES_ADMIN_URL).toBe(cluster.adminUrl);
        expect(env.URMOTIV_TEST_POSTGRES_ADMIN_URL).not.toBe(sharedPgAdminUrl);
      } finally {
        teardownIsolatedPostgres(cluster);
      }
    }, 120_000);

    it("子进程 Docker socket 拒绝：runner 容器内 docker 命令失败", () => {
      const cluster = createIsolatedPostgres({ runId: "test-dockerdeny-" + runToken, role: "primary" });
      try {
        const runner = createRunnerContainer({
          runId: "test-dockerdeny-" + runToken,
          networkName: cluster.networkName,
          mounts: [
            ["/home/ubuntu/codex-urmotiv", "/home/ubuntu/codex-urmotiv", "bind"],
            ["/tmp", "/tmp", "bind"],
          ],
          workDir: "/home/ubuntu/codex-urmotiv/Urmotiv/apps/api",
        });
        try {
          // docker 命令不应存在于 runner 容器内。
          const result = execInRunnerWithEnv(
            runner.containerId, {},
            ["bash", "-c", "which docker || echo 'docker-not-found'"],
          );
          expect(result.stdout.trim()).toBe("docker-not-found");
          // /var/run/docker.sock 不应存在。
          const sockResult = execInRunnerWithEnv(
            runner.containerId, {},
            ["bash", "-c", "ls /var/run/docker.sock 2>&1 || echo 'no-sock'"],
          );
          expect(sockResult.stdout.trim()).toContain("no-sock");
        } finally {
          teardownRunnerContainer(runner);
        }
      } finally {
        teardownIsolatedPostgres(cluster);
      }
    }, 120_000);

    it("共享哨兵库不受隔离集群操作影响", async () => {
      const Client = (pgRequire().Client ?? pgRequire().default?.Client);
      const sentinelName = `urmotiv_gate9_sentinel_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
      const sharedClient = new Client({ connectionString: sharedPgAdminUrl });
      await sharedClient.connect();
      try {
        await sharedClient.query(`create database "${sentinelName}"`);
      } finally {
        await sharedClient.end();
      }
      try {
        const cluster = createIsolatedPostgres({ runId: "test-sentinel-" + runToken, role: "primary" });
        teardownIsolatedPostgres(cluster);
        const checkClient = new Client({ connectionString: sharedPgAdminUrl });
        await checkClient.connect();
        try {
          const r = await checkClient.query("select count(*) as n from pg_database where datname = $1", [sentinelName]);
          expect(Number(r.rows[0].n)).toBe(1);
        } finally {
          await checkClient.end();
        }
      } finally {
        const cleanupClient = new Client({ connectionString: sharedPgAdminUrl });
        await cleanupClient.connect();
        try {
          await cleanupClient.query(`drop database "${sentinelName}" with (force)`);
        } finally {
          await cleanupClient.end();
        }
      }
    }, 120_000);

    it("拆除后无项目专属容器/网络残留", () => {
      const beforeContainers = listProjectContainers();
      const beforeNetworks = listProjectNetworks();
      const cluster = createIsolatedPostgres({ runId: "test-residue-" + runToken, role: "primary" });
      teardownIsolatedPostgres(cluster);
      const afterContainers = listProjectContainers();
      const afterNetworks = listProjectNetworks();
      expect(afterContainers.length).toBeLessThanOrEqual(beforeContainers.length);
      expect(afterContainers).not.toContain(cluster.containerId);
      expect(afterNetworks.length).toBeLessThanOrEqual(beforeNetworks.length);
      expect(afterNetworks).not.toContain(cluster.networkName);
    }, 120_000);

    it("无匿名卷残留：tmpfs 设计不创建 Docker 卷", () => {
      const cluster = createIsolatedPostgres({ runId: "test-novol-" + runToken, role: "primary" });
      try {
        // 检查容器没有关联的命名卷或匿名卷。
        const mounts = JSON.parse(
          execFileSync("docker", ["inspect", "-f", "{{json .Mounts}}", cluster.containerId], { encoding: "utf8" }).trim(),
        );
        for (const mount of mounts) {
          // tmpfs 挂载没有 Name/Destination 卷——类型应为 "tmpfs"。
          expect(mount.Type).toBe("tmpfs");
        }
      } finally {
        teardownIsolatedPostgres(cluster);
      }
    }, 120_000);

    it("清单权限验证：0700 目录 + 0600 文件", () => {
      const cluster = createIsolatedPostgres({ runId: "test-perms-" + runToken, role: "primary" });
      try {
        expect(verifyManifestPermissions(cluster.manifestDir)).toBe(true);
      } finally {
        teardownIsolatedPostgres(cluster);
      }
    }, 120_000);

    it("主次集群在同一 Docker 网络上，runner 可达两者", () => {
      const primary = createIsolatedPostgres({ runId: "test-multicluster-" + runToken, role: "primary" });
      try {
        const secondary = createIsolatedPostgres({
          runId: "test-multicluster-" + runToken,
          role: "secondary",
          networkName: primary.networkName,
        });
        try {
          // 两者在同一网络。
          expect(primary.networkName).toBe(secondary.networkName);
          // 两者的 system_identifier 不同（不同的 initdb）。
          expect(primary.systemIdentifier).not.toBe(secondary.systemIdentifier);
        } finally {
          teardownIsolatedPostgres(secondary);
        }
      } finally {
        teardownIsolatedPostgres(primary);
      }
    }, 120_000);
  },
);
