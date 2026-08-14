import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { dirname, join, relative, resolve } from "node:path";

import { HistoryMigrationError } from "./errors";
import { sha256Hex } from "./digests";
import { assertPrivateDirectoryMode } from "./private-files";

const execFileAsync = promisify(execFile);
const fullCommitPattern = /^[0-9a-f]{40}$/;
const loadBearingPaths = [
  "apps/api/scripts/preflight-history-import.ts",
  "apps/api/scripts/run-real-import.ts",
  "apps/api/src/history-migration",
  "packages/database",
  "packages/problem-package",
] as const;

export interface ExecutionProvenance {
  readonly commit: string;
  readonly codeInventorySha256: string;
  readonly codeInventoryEntryCount: number;
}

export function historyRepositoryRoot(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
}

export function permittedPhase2EvidenceRoot(): string {
  return join(historyRepositoryRoot(), "private", "phase2-evidence");
}

async function runGit(arguments_: readonly string[]): Promise<string> {
  try {
    const result = await execFileAsync("git", [...arguments_], {
      cwd: historyRepositoryRoot(),
      encoding: "utf8",
      maxBuffer: 4 * 1024 * 1024,
    });
    return result.stdout;
  } catch {
    throw new HistoryMigrationError("INVALID_ARGUMENTS", "无法验证执行检出的 Git 身份。");
  }
}

export async function verifyExecutionProvenance(
  suppliedCommit: string,
): Promise<ExecutionProvenance> {
  if (!fullCommitPattern.test(suppliedCommit)) {
    throw new HistoryMigrationError("INVALID_ARGUMENTS", "批准提交必须是完整的 Git 提交摘要。");
  }
  const expectedRoot = historyRepositoryRoot();
  const actualRoot = resolve((await runGit(["rev-parse", "--show-toplevel"])).trim());
  if (actualRoot !== expectedRoot) {
    throw new HistoryMigrationError("INVALID_ARGUMENTS", "执行代码不属于批准的项目检出。");
  }
  const commit = (await runGit(["rev-parse", "HEAD"])).trim();
  if (commit !== suppliedCommit) {
    throw new HistoryMigrationError("INVALID_ARGUMENTS", "批准提交与当前执行检出不一致。");
  }
  const status = await runGit([
    "status",
    "--porcelain=v1",
    "--untracked-files=all",
    "--",
    ...loadBearingPaths,
  ]);
  if (status.trim().length !== 0) {
    throw new HistoryMigrationError("INVALID_ARGUMENTS", "执行代码与批准提交的内容不一致。");
  }
  const inventory = await runGit([
    "ls-tree",
    "-r",
    "--full-tree",
    commit,
    "--",
    ...loadBearingPaths,
  ]);
  if (inventory.trim().length === 0) {
    throw new HistoryMigrationError("INVALID_ARGUMENTS", "批准提交没有可验证的执行代码清单。");
  }
  return {
    commit,
    codeInventorySha256: sha256Hex(inventory),
    codeInventoryEntryCount: inventory.trim().split("\n").length,
  };
}

export async function assertPermittedPhase2EvidenceRoot(suppliedRoot: string): Promise<string> {
  const repositoryRoot = historyRepositoryRoot();
  const permittedRoot = permittedPhase2EvidenceRoot();
  if (resolve(suppliedRoot) !== permittedRoot) {
    throw new HistoryMigrationError("INVALID_ARGUMENTS", "私有证据根目录不是项目固定的 Phase-2 目录。");
  }
  await assertPrivateDirectoryMode(permittedRoot);
  const relativeRoot = relative(repositoryRoot, permittedRoot);
  if (relativeRoot.startsWith("..") || relativeRoot.length === 0) {
    throw new HistoryMigrationError("INVALID_ARGUMENTS", "私有证据根目录不在项目检出内。");
  }
  await runGit(["check-ignore", "--quiet", "--no-index", "--", `${relativeRoot}/.evidence-probe`]);
  const tracked = await runGit(["ls-files", "--", relativeRoot]);
  if (tracked.trim().length !== 0) {
    throw new HistoryMigrationError("INVALID_ARGUMENTS", "私有证据根目录包含 Git 跟踪文件。");
  }
  return permittedRoot;
}
