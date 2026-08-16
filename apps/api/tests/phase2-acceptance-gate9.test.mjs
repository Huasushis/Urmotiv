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

// Fix A：精确创建登记册。清理只删除本运行在创建边界登记过的确切库名，
// 绝不按令牌子串、前缀、通配符或「快照后新增」推断归属权。
// 登记册是本运行私有的临时 JSON 文件，由 runToken 命名；子进程通过
// URMOTIV_TEST_RUN_TOKEN 环境变量获得同一个 runToken，写入同一文件。
// 清理时读取该文件，逐条精确匹配 pg_database 中的库名后删除。
// 文件缺失/损坏/不完整时 fail-closed（报错而非跳过）。
const runToken = `${process.pid}${randomUUID().replaceAll("-", "").slice(0, 12)}`;
const registryPath = join(tmpdir(), `urmotiv-gate9-registry-${runToken}.json`);

function registerDatabaseName(name) {
  // 追加 JSON 行（JSONL 格式），每行一个库名，避免并发写竞争。
  appendFileSync(registryPath, `${JSON.stringify(name)}\n`);
}

function readRegisteredNames() {
  if (!existsSync(registryPath)) {
    throw new Error(`PG 创建登记册不存在：${registryPath}；无法安全清理。`);
  }
  const content = readFileSync(registryPath, "utf8");
  if (content.trim().length === 0) return [];
  const names = [];
  for (const line of content.split("\n")) {
    if (line.trim().length === 0) continue;
    let parsed;
    try {
      parsed = JSON.parse(line);
    } catch {
      throw new Error(`PG 创建登记册存在损坏行：${line.slice(0, 80)}；fail-closed。`);
    }
    if (typeof parsed !== "string" || parsed.length === 0) {
      throw new Error(`PG 创建登记册存在非字符串条目；fail-closed。`);
    }
    names.push(parsed);
  }
  return [...new Set(names)];
}

function removeRegistryFile() {
  if (existsSync(registryPath)) {
    rmSync(registryPath, { force: true });
    if (existsSync(registryPath)) {
      throw new Error(`PG 创建登记册删除失败：${registryPath}`);
    }
  }
}

function pgRequire() {
  const req = nodeCreateRequire(import.meta.url);
  try {
    return req("pg");
  } catch {
    const dbPkgPath = join(repositoryRoot, "packages", "database", "package.json");
    return nodeCreateRequire(dbPkgPath)("pg");
  }
}

async function pgClient() {
  const mod = pgRequire();
  const Client = mod.Client ?? mod.default?.Client;
  const client = new Client({ connectionString: pgAdminUrl });
  await client.connect();
  return client;
}

async function snapshotOwnedDatabases() {
  // 精确登记册方案不需要预运行快照——清理时只按登记册中的确切库名删除。
  // 保留函数签名以兼容现有调用点，但改为空操作。
}

async function cleanupPgResidue() {
  if (pgAdminUrl.trim().length === 0) return;
  const registered = readRegisteredNames();
  const client = await pgClient();
  try {
    // 只删除登记册中存在且当前 pg_database 中确实存在的库名。
    // 逐条精确查询并删除——绝不枚举 urmotiv_% 后按子串匹配。
    const failed = [];
    for (const name of registered) {
      const exists = await client.query(
        "select count(*) as n from pg_database where datname = $1",
        [name],
      );
      if (Number(exists.rows[0].n) === 0) continue;
      try {
        await client.query(`drop database "${name}" with (force)`);
      } catch {
        failed.push(name);
      }
    }
    // 验证所有登记库名均已删除。
    const stillExisting = [];
    for (const name of registered) {
      const check = await client.query(
        "select count(*) as n from pg_database where datname = $1",
        [name],
      );
      if (Number(check.rows[0].n) !== 0) stillExisting.push(name);
    }
    if (stillExisting.length !== 0 || failed.length !== 0) {
      const names = stillExisting.concat(failed);
      throw new Error(`PG 残留数据库未清理（仅限登记册确切库名）: ${names.join(", ")}`);
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
    URMOTIV_TEST_RUN_TOKEN: runToken,
    URMOTIV_TEST_PG_REGISTRY_PATH: registryPath,
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
      removeRegistryFile();
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
      const adminUrl = process.env.URMOTIV_TEST_POSTGRES_ADMIN_URL;
      if (typeof adminUrl !== "string" || adminUrl.trim().length === 0) {
        throw new Error("Gate 9 集成测试要求 URMOTIV_TEST_POSTGRES_ADMIN_URL。");
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
          URMOTIV_TEST_POSTGRES_ADMIN_URL: adminUrl,
          URMOTIV_PHASE2_ACCEPTANCE_BASE_COMMIT: readBaseWorkerCommit(),
          URMOTIV_PHASE2_ACCEPTANCE_BASE_WORKER_FILE: defaultBaseWorkerFile(),
          URMOTIV_PHASE2_ACCEPTANCE_DIR: evidenceDirectory,
          URMOTIV_PHASE2_CHILD_FIXTURE_VERDICT: "SYNTHETIC_READINESS",
          URMOTIV_TEST_RUN_TOKEN: runToken,
          URMOTIV_TEST_PG_REGISTRY_PATH: registryPath,
          // 旧的环境变量——已被移除，不应被识别为放宽权威性。
          URMOTIV_PHASE2_NON_AUTHORITATIVE: "1",
        };
        delete env.URMOTIV_RUN_PHASE2_GATE9;
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

describe.skipIf(pgAdminUrl.trim().length === 0)(
  "Gate 9 PG 清理资源归属边界（精确登记册）",
  () => {
    it("cleanupPgResidue 只删登记册中的确切库名；名称含令牌子串但未登记的库必须存活", async () => {
      const Client = (pgRequire().Client ?? pgRequire().default?.Client);

      // 1. 创建一个不相关的恢复库（模拟并发的恢复操作）。
      const unrelatedName = `urmotiv_recovery_unrelated_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
      const setupClient = new Client({ connectionString: pgAdminUrl });
      await setupClient.connect();
      try {
        await setupClient.query(`create database "${unrelatedName}"`);
      } finally {
        await setupClient.end();
      }

      // 2. 创建一个使用不同令牌的并发运行库（模拟并发 gate9 运行）。
      const concurrentToken = `concurrent${randomUUID().replaceAll("-", "").slice(0, 12)}`;
      const concurrentName = `urmotiv_history_import_concurrent${concurrentToken}`;
      const concurrentClient = new Client({ connectionString: pgAdminUrl });
      await concurrentClient.connect();
      try {
        await concurrentClient.query(`create database "${concurrentName}"`);
      } finally {
        await concurrentClient.end();
      }

      // 3. 对抗性测试核心：创建一个名称包含本运行令牌（作为严格子串）
      //    但从未在登记册中登记的库。cleanupPgResidue 绝不能删除它——
      //    令牌子串不是归属权凭据，只有精确登记才是。
      const unregisteredTokenSubstring = `urmotiv_history_import_adversarial${runToken}`;
      const advClient = new Client({ connectionString: pgAdminUrl });
      await advClient.connect();
      try {
        await advClient.query(`create database "${unregisteredTokenSubstring}"`);
      } finally {
        await advClient.end();
      }

      // 4. 创建并登记本运行拥有的库。
      const ownedName = `urmotiv_history_import_owned${runToken}`;
      const ownClient = new Client({ connectionString: pgAdminUrl });
      await ownClient.connect();
      try {
        await ownClient.query(`create database "${ownedName}"`);
      } finally {
        await ownClient.end();
      }
      registerDatabaseName(ownedName);

      // 5. 清理——只应删除 ownedName（已登记），不应碰其他三个库。
      await cleanupPgResidue();

      // 6. 断言：ownedName 已消失；其余三个库（不相关、并发、含令牌子串但未登记）仍存在。
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
        const concurrentResult = await checkClient.query(
          "select count(*) as n from pg_database where datname = $1",
          [concurrentName],
        );
        expect(Number(concurrentResult.rows[0].n)).toBe(1);
        const advResult = await checkClient.query(
          "select count(*) as n from pg_database where datname = $1",
          [unregisteredTokenSubstring],
        );
        expect(Number(advResult.rows[0].n)).toBe(1);
      } finally {
        // 7. 清理测试自身的库（不依赖 cleanupPgResidue）。
        await checkClient.query(`drop database "${unrelatedName}" with (force)`);
        await checkClient.query(`drop database "${concurrentName}" with (force)`);
        await checkClient.query(`drop database "${unregisteredTokenSubstring}" with (force)`);
        await checkClient.end();
      }
    }, 30_000);
  },
);