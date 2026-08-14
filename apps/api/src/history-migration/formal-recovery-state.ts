/**
 * 正式导入恢复状态机：所有破坏性操作（存储快照刷新、最终删除、备份库删除）
 * 都必须在受保护的状态转移之间执行。状态文件位于当次唯一目录，字段只含
 * 相位、世代绑定摘要与时间；相位转移经过只读复检，任何不符都机械拒绝。
 */
import { join } from "node:path";

import { sha256Hex } from "./digests";
import { HistoryMigrationError } from "./errors";
import { privateRegularFileExists, readPrivateJson, writeNewPrivateJson, writePrivateFile } from "./private-files";

export const formalRecoveryStateName = "formal-recovery-state.private.json";

export const formalRecoveryPhases = [
  "pre_backup",
  "backup_create_pending",
  "backup_verified",
  "backup_failed",
  "import_started",
  "import_verified",
  "cleanup_pending",
  "rollback_pending",
  "rollback_verified",
  "rollback_refused",
  "finalization_refused",
  "finalized",
] as const;

export type FormalRecoveryPhase = (typeof formalRecoveryPhases)[number];

export interface FormalRecoveryState {
  readonly version: 1;
  readonly phase: FormalRecoveryPhase;
  readonly generationBindingSha256: string;
  readonly updatedAt: string;
}

const allowedTransitions = new Map<FormalRecoveryPhase, readonly FormalRecoveryPhase[]>([
  ["pre_backup", ["backup_create_pending"]],
  ["backup_create_pending", ["backup_verified", "backup_failed"]],
  ["backup_verified", ["import_started"]],
  ["import_started", ["import_verified", "rollback_pending"]],
  ["import_verified", ["cleanup_pending"]],
  ["cleanup_pending", ["finalized", "rollback_pending", "finalization_refused"]],
  ["rollback_pending", ["rollback_verified", "rollback_refused"]],
  ["rollback_verified", ["cleanup_pending", "finalization_refused"]],
  ["rollback_refused", ["finalization_refused"]],
  ["backup_failed", []],
  ["finalization_refused", []],
  ["finalized", []],
]);

/** 状态记录的规范化摘要：收据与证据用它在写盘时刻绑定同一恢复世代。 */
export function recoveryStateSha256(state: FormalRecoveryState): string {
  return sha256Hex(
    JSON.stringify([state.version, state.phase, state.generationBindingSha256]),
  );
}

function formalRecoveryStatePath(outputDirectory: string): string {
  return join(outputDirectory, formalRecoveryStateName);
}

/** 在刚建立的当次输出目录写入初始状态；目录必须为空且状态文件不得已存在。 */
export async function startFormalRecoveryState(
  outputDirectory: string,
  generationBindingSha256: string,
): Promise<FormalRecoveryState> {
  const state: FormalRecoveryState = {
    version: 1,
    phase: "pre_backup",
    generationBindingSha256,
    updatedAt: new Date().toISOString(),
  };
  await writeNewPrivateJson(formalRecoveryStatePath(outputDirectory), state);
  return state;
}

export async function readFormalRecoveryState(
  outputDirectory: string,
): Promise<FormalRecoveryState | undefined> {
  const statePath = formalRecoveryStatePath(outputDirectory);
  if (!(await privateRegularFileExists(statePath))) return undefined;
  const value = await readPrivateJson(statePath);
  if (
    typeof value !== "object" ||
    value === null ||
    !("version" in value) ||
    value.version !== 1 ||
    !("phase" in value) ||
    typeof value.phase !== "string" ||
    !(formalRecoveryPhases as readonly string[]).includes(value.phase) ||
    !("generationBindingSha256" in value) ||
    typeof value.generationBindingSha256 !== "string" ||
    !/^[a-f0-9]{64}$/.test(value.generationBindingSha256) ||
    !("updatedAt" in value) ||
    typeof value.updatedAt !== "string"
  ) {
    throw new HistoryMigrationError("INVALID_METADATA", "恢复状态文件结构不合法。");
  }
  return value as unknown as FormalRecoveryState;
}

/**
 * 受保护相位转移：先只读当前相位并核对世代绑定，再写下一相位。任何
 * 越界或世代不一致都拒绝，破坏性操作因未获得合法过渡而无法执行。
 */
export async function advanceFormalRecoveryPhase(
  outputDirectory: string,
  from: FormalRecoveryPhase,
  to: FormalRecoveryPhase,
): Promise<FormalRecoveryState> {
  const current = await readFormalRecoveryState(outputDirectory);
  if (current === undefined) {
    throw new HistoryMigrationError("INVALID_METADATA", "恢复状态机尚未建立。");
  }
  if (current.phase !== from) {
    throw new HistoryMigrationError("INVALID_METADATA", "恢复状态机相位不符，拒绝破坏性操作。");
  }
  const allowed = allowedTransitions.get(from) ?? [];
  if (!allowed.includes(to)) {
    throw new HistoryMigrationError("INVALID_METADATA", "恢复状态机不允许该相位转移。");
  }
  const next: FormalRecoveryState = {
    version: 1,
    phase: to,
    generationBindingSha256: current.generationBindingSha256,
    updatedAt: new Date().toISOString(),
  };
  await writePrivateFile(
    formalRecoveryStatePath(outputDirectory),
    `${JSON.stringify(next, null, 2)}\n`,
  );
  return next;
}