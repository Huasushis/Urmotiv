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

const pgAdminUrl = process.env.URMOTIV_TEST_POSTGRES_ADMIN_URL ?? "";

// 跟踪本测试运行拥有的 PG 数据库快照前集；清理只删运行中新出现的库，
// 绝不碰预先存在的不相关恢复库。
let preRunDatabaseNames = null;
function pgRequire() {
  const req = nodeCreateRequire(import.meta.url);
  try {
    return req("pg");
  } catch {
    const dbPkgPath = join(repositoryRoot, "packages", "database", "package.json");
    return nodeCreateRequire(dbPkgPath)("pg");
  }
}

async function snapshotOwnedDatabases() {
  if (pgAdminUrl.trim().length === 0) return;
  const mod = pgRequire();
  const Client = mod.Client ?? mod.default?.Client;
  const client = new Client({ connectionString: pgAdminUrl });
  await client.connect();
  try {
    const result = await client.query(
      "select datname from pg_database where datname like 'urmotiv_%'",
    );
    preRunDatabaseNames = new Set(result.rows.map((r) => r.datname));
  } finally {
    await client.end();
  }
}

async function cleanupPgResidue() {
  if (pgAdminUrl.trim().length === 0) return;
  if (!(preRunDatabaseNames instanceof Set)) {
    throw new Error("cleanupPgResidue 在 snapshotOwnedDatabases 之前被调用。");
  }
  const mod = pgRequire();
  const Client = mod.Client ?? mod.default?.Client;
  const client = new Client({ connectionString: pgAdminUrl });
  await client.connect();
  try {
    const result = await client.query(
      "select datname from pg_database where datname like 'urmotiv_%' order by datname",
    );
    // 只删本运行中新创建的库（快照前集中不存在的），绝不碰预先存在的不相关库。
    const owned = result.rows
      .map((r) => r.datname)
      .filter((name) => !preRunDatabaseNames.has(name));
    const failed = [];
    for (const name of owned) {
      try {
        await client.query(`drop database "${name}" with (force)`);
      } catch {
        failed.push(name);
      }
    }
    // 逐一断言已删除的库已消失；未删的预先存在库不在断言范围内。
    const remaining = await client.query(
      "select datname from pg_database where datname like 'urmotiv_%'",
    );
    const stillOwned = remaining.rows
      .map((r) => r.datname)
      .filter((name) => !preRunDatabaseNames.has(name));
    if (stillOwned.length !== 0 || failed.length !== 0) {
      const names = stillOwned.concat(failed);
      throw new Error(`PG 残留数据库未清理（仅限本运行拥有）: ${names.join(", ")}`);
    }
  } finally {
    await client.end();
  }
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
  const adminUrl = process.env.URMOTIV_TEST_POSTGRES_ADMIN_URL;
  if (typeof adminUrl !== "string" || adminUrl.trim().length === 0) {
    throw new Error("Gate 9 集成测试要求 URMOTIV_TEST_POSTGRES_ADMIN_URL。");
  }
  const evidenceDirectory = mkdtempSync(join(tmpdir(), "urmotiv-gate9-evidence-"));
  evidenceDirectories.push(evidenceDirectory);
  const env = {
    ...process.env,
    URMOTIV_TEST_POSTGRES_ADMIN_URL: adminUrl,
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
  };
  delete env.URMOTIV_RUN_PHASE2_GATE9;
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
    // 快照当前 PG 数据库集，清理时只删本运行新创建的库。
    await snapshotOwnedDatabases();
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
    try {
      await cleanupPgResidue();
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
    // 清理本测试验收运行产生的 PG 数据库族残留。
    try {
      await cleanupPgResidue();
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
});

describe.skipIf(pgAdminUrl.trim().length === 0)(
  "Gate 9 PG 清理资源归属边界（不碰不相关恢复库）",
  () => {
    afterEach(() => {
      // 重置共享状态，避免污染主 Gate 9 describe 块的清理逻辑。
      preRunDatabaseNames = null;
    });
    it("cleanupPgResidue 只删本运行拥有的库，保留预存的不相关恢复库", async () => {
      // 1. 预存一个不相关的恢复库（模拟并发的恢复操作）。
      const unrelatedName = `urmotiv_recovery_unrelated_${process.pid}${randomUUID()
        .replaceAll("-", "")
        .slice(0, 8)}`;
      const mod = pgRequire();
      const Client = mod.Client ?? mod.default?.Client;
      const setupClient = new Client({ connectionString: pgAdminUrl });
      await setupClient.connect();
      try {
        await setupClient.query(`create database "${unrelatedName}"`);
      } finally {
        await setupClient.end();
      }

      // 2. 快照当前库集——此时不相关恢复库已存在，会被快照记录。
      await snapshotOwnedDatabases();

      // 3. 创建一个本运行拥有的库（快照后新建）。
      const ownedName = `urmotiv_owned_test_${process.pid}${randomUUID()
        .replaceAll("-", "")
        .slice(0, 8)}`;
      const ownClient = new Client({ connectionString: pgAdminUrl });
      await ownClient.connect();
      try {
        await ownClient.query(`create database "${ownedName}"`);
      } finally {
        await ownClient.end();
      }

      // 4. 清理——只应删除 ownedName，不应碰 unrelatedName。
      await cleanupPgResidue();

      // 5. 断言：ownedName 已消失，unrelatedName 仍存在。
      const checkClient = new Client({ connectionString: pgAdminUrl });
      await checkClient.connect();
      try {
        const ownedResult = await checkClient.query(
          "select count(*) as n from pg_database where datname = $1",
          [ownedName],
        );
        expect(Number(ownedResult.rows[0].n)).toBe(0);
        const unrelatedResult = await checkClient.query(
          "select count(*) as n from pg_database where datname = $1",
          [unrelatedName],
        );
        expect(Number(unrelatedResult.rows[0].n)).toBe(1);
      } finally {
        // 6. 清理不相关恢复库（测试自身的清理，不依赖 cleanupPgResidue）。
        await checkClient.query(`drop database "${unrelatedName}" with (force)`);
        await checkClient.end();
      }
    }, 30_000);
  },
);