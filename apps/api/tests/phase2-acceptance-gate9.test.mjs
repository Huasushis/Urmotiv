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
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

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
let sharedExcludeOriginal = "";

function enableSharedExcludes() {
  sharedExcludeOriginal = readFileSync(sharedExcludePath, "utf8");
  const existing = new Set(sharedExcludeOriginal.split("\n"));
  const additions = gate9ExcludeLines.filter((line) => !existing.has(line));
  if (additions.length !== 0) {
    writeFileSync(sharedExcludePath, `${sharedExcludeOriginal}${additions.join("\n")}\n`);
  }
}

function restoreSharedExcludes() {
  writeFileSync(sharedExcludePath, sharedExcludeOriginal);
  sharedExcludeOriginal = "";
}

describe.skipIf(!gate9Enabled)("Gate 9 验收运行后整树突变隔离", () => {
  beforeAll(() => {
    enableSharedExcludes();
  });

  afterAll(() => {
    let failure = null;
    try {
      restoreSharedExcludes();
    } catch (error) {
      failure = error;
    }
    try {
      removeGate9Resources();
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
      expect(evidence.reasonCodes).toContain("GIT_INFO_EXCLUDE_NON_EMPTY");
      expect(result.status).not.toBe(0);
    },
  );
});