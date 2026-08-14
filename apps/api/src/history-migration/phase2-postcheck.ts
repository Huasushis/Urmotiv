/**
 * 第 2 阶段专项：导入前后精确对账与失败即非零退出。
 * 一切计数都来自只读事务内的聚合查询；任何一项漂移都会以稳定原因码失败，
 * 绝不输出题号、候选编号、题名、摘要或路径。
 */
import { createHash } from "node:crypto";

import { sql } from "drizzle-orm";
import type { DatabaseHandle } from "@urmotiv/database";

import { HistoryMigrationError } from "./errors";
import {
  historyImportRequiredTables,
  runZeroMutationDatabasePreflight,
} from "./import-preflight";

/** 只允许短且明确的临时/验收库名；为 __snapshot/__restore 后缀预留空间。 */
export const scratchDatabaseNamePattern = /^urmotiv_history_import_[a-z0-9_]{1,20}$/;

export function assertScratchDatabaseName(name: string): void {
  if (!scratchDatabaseNamePattern.test(name)) {
    throw new HistoryMigrationError(
      "INVALID_ARGUMENTS",
      "目标库名不属于安全的临时/验收库命名范围，本工具拒绝继续。",
    );
  }
}

export interface HistoryImportCountRow {
  readonly table: string;
  readonly rows: number;
}

/** 只读采集全部十张受影响/边界表的行数。 */
export async function captureHistoryImportTableCounts(
  database: DatabaseHandle,
): Promise<readonly HistoryImportCountRow[]> {
  const result = await runZeroMutationDatabasePreflight(database);
  if (!result.readOnlyEnforced || result.missingTableCount !== 0) {
    throw new HistoryMigrationError("INVALID_ARGUMENTS", "只读计数或完整表清单验证失败。");
  }
  return result.rowCounts;
}

export interface StoredFileInventory {
  readonly fileCount: number;
  readonly totalBytes: number;
  readonly contentInventorySha256: string;
}

interface StoredFileRow {
  readonly sha256: string;
  readonly byte_size: bigint;
  readonly [key: string]: unknown;
}

/** 只读绑定 stored_files 中每个对象的内容摘要与字节数，不返回单项信息。 */
export async function captureStoredFileInventory(
  database: DatabaseHandle,
): Promise<StoredFileInventory> {
  const rows = await database.transaction(async (executor) => {
    await executor.execute(sql`set local transaction_read_only = on`);
    return executor.query<StoredFileRow>(
      sql`select sha256, byte_size from "public"."stored_files" order by sha256, byte_size`,
    );
  });
  const entries = rows.map((row) => ({ sha256: row.sha256, bytes: Number(row.byte_size) }));
  return {
    fileCount: entries.length,
    totalBytes: entries.reduce((sum, entry) => sum + entry.bytes, 0),
    contentInventorySha256: createHash("sha256").update(JSON.stringify(entries)).digest("hex"),
  };
}

/** 导入两遍执行结果的关键聚合；失败一律体现为非零的 failed 计数。 */
export interface HistoryImportPassTally {
  readonly imported: number;
  readonly skipped: number;
  readonly failed: number;
}

export interface Phase2PostcheckInput {
  readonly before: readonly HistoryImportCountRow[];
  readonly afterFirst: readonly HistoryImportCountRow[];
  readonly afterReplay: readonly HistoryImportCountRow[];
  readonly firstPass: HistoryImportPassTally;
  readonly replayPass: HistoryImportPassTally;
  readonly expectedPackageCount: number;
  readonly expectedAttachmentRows: number;
  readonly expectedSampleRows: number;
  readonly expectedJobItemRows: number;
  readonly expectedStoredFilesDelta: number;
  readonly expectedAuditDelta: number;
  readonly expectedNullSolutionCount: number;
  readonly afterNullSolutionCount: number;
  readonly expectedEmptySolutionCount: number;
  readonly afterEmptySolutionCount: number;
  readonly expectedStoredBytes: number;
  readonly expectedStoredContentSha256: string;
  readonly afterFirstStoredInventory: StoredFileInventory;
  readonly afterReplayStoredInventory: StoredFileInventory;
}

export const phase2PostcheckReasonCodes = [
  "first_import_count_mismatch",
  "failed_candidates_present",
  "unexpected_skipped_first_import",
  "replay_not_idempotent",
  "replay_mutation_present",
  "table_delta_drift",
  "solution_state_drift",
  "stored_inventory_drift",
] as const;
export type Phase2PostcheckReasonCode = (typeof phase2PostcheckReasonCodes)[number];

export interface Phase2PostcheckResult {
  readonly verdict: "PASS" | "FAIL";
  readonly reasonCodes: readonly Phase2PostcheckReasonCode[];
  readonly driftedTableCount: number;
}

function rowsOf(counts: readonly HistoryImportCountRow[], table: string): number {
  let rows = 0;
  for (const row of counts) if (row.table === table) rows = row.rows;
  return rows;
}

/** 按导入写入语义计算全部十张表的精确预期增量。 */
export function expectedTableDeltas(input: {
  readonly imported: number;
  readonly attachmentRows: number;
  readonly sampleRows: number;
  readonly jobItemRows: number;
  readonly storedFilesDelta: number;
  readonly auditDelta: number;
}): readonly { readonly table: string; readonly delta: number }[] {
  return [
    { table: "users", delta: 0 },
    { table: "problems", delta: input.imported },
    { table: "problem_revisions", delta: input.imported },
    { table: "problem_revision_tags", delta: input.imported },
    { table: "problem_revision_files", delta: input.attachmentRows },
    { table: "problem_samples", delta: input.sampleRows },
    { table: "import_jobs", delta: input.imported },
    { table: "import_job_items", delta: input.jobItemRows },
    { table: "audit_events", delta: input.auditDelta },
    { table: "stored_files", delta: input.storedFilesDelta },
  ];
}

function storedInventoriesEqual(left: StoredFileInventory, right: StoredFileInventory): boolean {
  return left.fileCount === right.fileCount &&
    left.totalBytes === right.totalBytes &&
    left.contentInventorySha256 === right.contentInventorySha256;
}

/** 精确对账两遍导入结果、全部表计数与存储对象内容清单。 */
export function verifyPhase2Outcome(input: Phase2PostcheckInput): Phase2PostcheckResult {
  const reasonCodes: Phase2PostcheckReasonCode[] = [];
  if (input.firstPass.imported !== input.expectedPackageCount) {
    reasonCodes.push("first_import_count_mismatch");
  }
  if (input.firstPass.failed !== 0 || input.replayPass.failed !== 0) {
    reasonCodes.push("failed_candidates_present");
  }
  if (input.firstPass.skipped !== 0) reasonCodes.push("unexpected_skipped_first_import");
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
    sampleRows: input.expectedSampleRows,
    jobItemRows: input.expectedJobItemRows,
    storedFilesDelta: input.expectedStoredFilesDelta,
    auditDelta: input.expectedAuditDelta,
  });
  let driftedTableCount = 0;
  for (const expectation of expectations) {
    const actualDelta = rowsOf(input.afterFirst, expectation.table) - rowsOf(input.before, expectation.table);
    if (actualDelta !== expectation.delta) driftedTableCount += 1;
  }
  if (driftedTableCount > 0) reasonCodes.push("table_delta_drift");
  if (
    input.afterNullSolutionCount !== input.expectedNullSolutionCount ||
    input.afterEmptySolutionCount !== input.expectedEmptySolutionCount
  ) {
    reasonCodes.push("solution_state_drift");
  }
  const expectedStoredInventory: StoredFileInventory = {
    fileCount: input.expectedStoredFilesDelta,
    totalBytes: input.expectedStoredBytes,
    contentInventorySha256: input.expectedStoredContentSha256,
  };
  if (
    !storedInventoriesEqual(input.afterFirstStoredInventory, expectedStoredInventory) ||
    !storedInventoriesEqual(input.afterReplayStoredInventory, input.afterFirstStoredInventory)
  ) {
    reasonCodes.push("stored_inventory_drift");
  }
  return {
    verdict: reasonCodes.length === 0 ? "PASS" : "FAIL",
    reasonCodes,
    driftedTableCount,
  };
}

function problemIdList(problemIds: readonly string[]) {
  if (problemIds.length === 0) {
    throw new HistoryMigrationError("INVALID_ARGUMENTS", "导入清单没有可核对的问题标识。");
  }
  return sql.join(problemIds.map((problemId) => sql`${problemId}::bigint`), sql`, `);
}

export interface SolutionStateCounts {
  readonly nullSolutionCount: number;
  readonly emptySolutionCount: number;
}

/** 分别统计 NULL（缺失）与空字符串（明确为空）；两种状态不得合并。 */
export async function countSolutionStatesForProblems(
  database: DatabaseHandle,
  problemIds: readonly string[],
): Promise<SolutionStateCounts> {
  const ids = problemIdList(problemIds);
  const rows = await database.transaction(async (executor) => {
    await executor.execute(sql`set local transaction_read_only = on`);
    return executor.query<{ null_total: bigint; empty_total: bigint }>(
      sql`select
            count(*) filter (where pr.basic_solution is null)::bigint as null_total,
            count(*) filter (where pr.basic_solution = '')::bigint as empty_total
          from "public"."problems" p
          inner join "public"."problem_revisions" pr
            on pr.problem_id = p.id and pr.revision = p.current_revision
          where p.id in (${ids})`,
    );
  });
  return {
    nullSolutionCount: Number(rows[0]?.null_total ?? 0),
    emptySolutionCount: Number(rows[0]?.empty_total ?? 0),
  };
}

/** 精确统计导入清单问题当前修订关联的附件行数。 */
export async function countRevisionFilesForProblems(
  database: DatabaseHandle,
  problemIds: readonly string[],
): Promise<number> {
  const ids = problemIdList(problemIds);
  const rows = await database.transaction(async (executor) => {
    await executor.execute(sql`set local transaction_read_only = on`);
    return executor.query<{ total: bigint }>(
      sql`select count(*)::bigint as total
          from "public"."problem_revision_files" prf
          inner join "public"."problem_revisions" pr on pr.id = prf.revision_id
          inner join "public"."problems" p
            on p.id = pr.problem_id and p.current_revision = pr.revision
          where p.id in (${ids})`,
    );
  });
  return Number(rows[0]?.total ?? 0);
}
