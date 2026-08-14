/**
 * 第 2 阶段专项：导入前后精确对账（postcheck）与失败即非零退出。
 * 一切计数都来自只读事务内的聚合查询；任何一项漂移都会以稳定原因码失败，
 * 绝不输出题号、候选编号、题名、摘要或路径。
 */
import { sql } from "drizzle-orm";
import type { DatabaseHandle } from "@urmotiv/database";

import { HistoryMigrationError } from "./errors";
import {
  historyImportRequiredTables,
  runZeroMutationDatabasePreflight,
} from "./import-preflight";

/** 只允许在该命名前缀下的临时/验收库上做快照与恢复；真实目标永远被拒绝。 */
export const scratchDatabaseNamePattern = /^urmotiv_history_import_[a-z0-9_]+$/;

export function assertScratchDatabaseName(name: string): void {
  if (!scratchDatabaseNamePattern.test(name)) {
    throw new HistoryMigrationError(
      "INVALID_ARGUMENTS",
      "目标库名不属于临时/验收库前缀，本工具拒绝继续。",
    );
  }
}

export interface HistoryImportCountRow {
  readonly table: string;
  readonly rows: number;
}

/** 只读采集八张必需表的行数；沿用零变更预检的只读事务保证。 */
export async function captureHistoryImportTableCounts(
  database: DatabaseHandle,
): Promise<readonly HistoryImportCountRow[]> {
  const result = await runZeroMutationDatabasePreflight(database);
  if (!result.readOnlyEnforced) {
    throw new HistoryMigrationError("INVALID_ARGUMENTS", "只读事务未生效，计数采集中止。");
  }
  return result.rowCounts;
}

/** 导入两遍执行结果的关键聚合；失败一律体现为非零的 failed 计数。 */
export interface HistoryImportPassTally {
  readonly imported: number;
  readonly skipped: number;
  readonly failed: number;
}

export interface Phase2PostcheckInput {
  /** 首次导入前的表计数。 */
  readonly before: readonly HistoryImportCountRow[];
  /** 首次导入后的表计数。 */
  readonly afterFirst: readonly HistoryImportCountRow[];
  /** 幂等重放后的表计数。 */
  readonly afterReplay: readonly HistoryImportCountRow[];
  readonly firstPass: HistoryImportPassTally;
  readonly replayPass: HistoryImportPassTally;
  /** 本批包数量（如本批为 137）。 */
  readonly expectedPackageCount: number;
  /** problem_revision_files 的预期增量（结构化附件条目数）。 */
  readonly expectedAttachmentRows: number;
  /** stored_files 的预期增量（import_input 每件一行）。 */
  readonly expectedStoredFilesDelta: number;
  /** audit_events 的预期增量。 */
  readonly expectedAuditDelta: number;
  /** 结构性缺失基础题解的预期真状态数量。 */
  readonly expectedMissingSolutionCount: number;
  /** 导入后实测的结构性缺失基础题解数量。 */
  readonly afterMissingSolutionCount: number;
}

export const phase2PostcheckReasonCodes = [
  "first_import_count_mismatch",
  "failed_candidates_present",
  "unexpected_skipped_first_import",
  "replay_not_idempotent",
  "replay_mutation_present",
  "table_delta_drift",
  "solution_state_drift",
] as const;
export type Phase2PostcheckReasonCode = (typeof phase2PostcheckReasonCodes)[number];

export interface Phase2PostcheckResult {
  readonly verdict: "PASS" | "FAIL";
  readonly reasonCodes: readonly Phase2PostcheckReasonCode[];
  /** 与预期不符的表数量。 */
  readonly driftedTableCount: number;
}

function rowsOf(counts: readonly HistoryImportCountRow[], table: string): number {
  let rows = 0;
  for (const row of counts) if (row.table === table) rows = row.rows;
  return rows;
}

/** 按导入写入语义计算的每张表精确预期增量；全部为零或精确加项。 */
export function expectedTableDeltas(input: {
  readonly imported: number;
  readonly attachmentRows: number;
  readonly storedFilesDelta: number;
  readonly auditDelta: number;
}): readonly { readonly table: string; readonly delta: number }[] {
  return [
    { table: "users", delta: 0 },
    { table: "problems", delta: input.imported },
    { table: "problem_revisions", delta: input.imported },
    { table: "problem_revision_tags", delta: input.imported },
    { table: "problem_revision_files", delta: input.attachmentRows },
    { table: "import_jobs", delta: input.imported },
    { table: "audit_events", delta: input.auditDelta },
    { table: "stored_files", delta: input.storedFilesDelta },
  ];
}

/** 精确对账两遍导入结果与全部表计数；任一漂移都会判 FAIL。 */
export function verifyPhase2Outcome(input: Phase2PostcheckInput): Phase2PostcheckResult {
  const reasonCodes: Phase2PostcheckReasonCode[] = [];
  if (input.firstPass.imported !== input.expectedPackageCount) {
    reasonCodes.push("first_import_count_mismatch");
  }
  if (input.firstPass.failed > 0 || input.replayPass.failed > 0) {
    reasonCodes.push("failed_candidates_present");
  }
  if (input.firstPass.skipped > 0) reasonCodes.push("unexpected_skipped_first_import");
  if (
    input.replayPass.imported !== 0 ||
    input.replayPass.skipped !== input.expectedPackageCount
  ) {
    reasonCodes.push("replay_not_idempotent");
  }
  for (const table of historyImportRequiredTables) {
    if (rowsOf(input.afterReplay, table) !== rowsOf(input.afterFirst, table)) {
      reasonCodes.push("replay_mutation_present");
      break;
    }
  }
  const expectations = expectedTableDeltas({
    imported: input.expectedPackageCount,
    attachmentRows: input.expectedAttachmentRows,
    storedFilesDelta: input.expectedStoredFilesDelta,
    auditDelta: input.expectedAuditDelta,
  });
  let driftedTableCount = 0;
  for (const expectation of expectations) {
    const actualDelta = rowsOf(input.afterFirst, expectation.table) - rowsOf(input.before, expectation.table);
    if (actualDelta !== expectation.delta) driftedTableCount += 1;
  }
  if (driftedTableCount > 0) reasonCodes.push("table_delta_drift");
  if (input.afterMissingSolutionCount !== input.expectedMissingSolutionCount) {
    reasonCodes.push("solution_state_drift");
  }
  return {
    verdict: reasonCodes.length === 0 ? "PASS" : "FAIL",
    reasonCodes,
    driftedTableCount,
  };
}

/** 导入后只读查询结构性缺失基础题解的数量。 */
export async function countMissingBasicSolutions(
  database: DatabaseHandle,
  sinceProblemId?: number,
): Promise<number> {
  // NULL 或空字符串都算结构性缺失；限定 problem_id 上界以下时用于批次内判定。
  const rows = await database.transaction(async (executor) => {
    await executor.execute(sql`SET LOCAL transaction_read_only = on`);
    if (sinceProblemId !== undefined) {
      return executor.query<{ total: bigint }>(
        sql`select count(*)::bigint as total from "public"."problem_revisions"
            where problem_id > ${sinceProblemId} and coalesce(basic_solution, '') = ''`,
      );
    }
    return executor.query<{ total: bigint }>(
      sql`select count(*)::bigint as total from "public"."problem_revisions"
          where coalesce(basic_solution, '') = ''`,
    );
  });
  return Number(rows[0]?.total ?? 0);
}
