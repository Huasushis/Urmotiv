/**
 * 历史导入第 1 阶段预检：确定性对账与零数据库变更检查。
 *
 * 预检只产出聚合计数与布尔结论，不输出题号、题目名称、候选正文或任何私有
 * 文件路径；数据库侧强制只读事务，任何写操作都会由数据库直接拒绝，保证
 * 预检自身无法变更数据库。基础题解缺失与未决附件属于真状态，预检如实
 * 计数，但不把它们当作失败原因。
 */
import { sql } from "drizzle-orm";
import type { DatabaseHandle } from "@urmotiv/database";

import { HistoryMigrationError } from "./errors";
import { historyMetadataFileSchema } from "./schema";
import { importManifestPayloadSchema, packageReportPayloadSchema } from "./import-phase";

/** 真实导入中经 DatabaseImportedProblemWriter 原子写入的全部表。 */
export const historyImportRequiredTables = [
  "users",
  "problems",
  "problem_revisions",
  "problem_revision_tags",
  "problem_revision_files",
  "import_jobs",
  "audit_events",
  "stored_files",
] as const;

/** 预检结论的稳定原因码；只能来自这里，便于报告与审计核对。 */
export const historyImportPreflightReasonCodes = [
  "report_declared_count_mismatch",
  "duplicate_candidate",
  "source_binding_missing",
  "empty_package",
  "preserved_material_mismatch",
  "attachment_count_mismatch",
  "metadata_report_count_mismatch",
  "expected_record_count_mismatch",
  "entry_names_incomplete",
  "package_file_missing",
  "manifest_batch_mismatch",
  "manifest_incomplete",
  "unexpected_entry_names",
  "database_read_only_unavailable",
  "database_table_missing",
] as const;

export type HistoryImportPreflightReasonCode =
  (typeof historyImportPreflightReasonCodes)[number];

export interface PackageReportSummary {
  readonly packageCount: number;
  readonly declaredPackageCount: number;
  readonly duplicateCandidateCount: number;
  readonly missingSourceBindingCount: number;
  readonly embeddedAttachmentCount: number;
  readonly declaredAttachmentCount: number | undefined;
  readonly preservedMaterialCount: number;
  readonly declaredPreservedMaterialCount: number | undefined;
  readonly zeroBytePackageCount: number;
}

/** 解析并聚合打包报告；任何结构或聚合不一致都会如实计数。 */
export function summarizePackageReport(payload: unknown): PackageReportSummary {
  const parsed = packageReportPayloadSchema.safeParse(payload);
  if (!parsed.success) {
    throw new HistoryMigrationError("INVALID_METADATA", "打包报告没有通过结构校验。");
  }
  const report = parsed.data;
  const candidateIds = new Set<string>();
  let duplicateCandidateCount = 0;
  let missingSourceBindingCount = 0;
  let embeddedAttachmentCount = 0;
  let zeroBytePackageCount = 0;
  for (const entry of report.packages) {
    if (candidateIds.has(entry.candidateId)) duplicateCandidateCount += 1;
    candidateIds.add(entry.candidateId);
    if (entry.sourceBindingSha256 === undefined) missingSourceBindingCount += 1;
    if (entry.attachments !== undefined) embeddedAttachmentCount += entry.attachments.length;
    if (entry.packageBytes === 0) zeroBytePackageCount += 1;
  }
  return {
    packageCount: report.packages.length,
    declaredPackageCount: report.packageCount,
    duplicateCandidateCount,
    missingSourceBindingCount,
    embeddedAttachmentCount,
    declaredAttachmentCount: report.attachmentCount,
    preservedMaterialCount: report.preservedMaterials?.length ?? 0,
    declaredPreservedMaterialCount: report.preservedMaterialCount,
    zeroBytePackageCount,
  };
}

export interface PackageContentSummary {
  readonly packagesChecked: number;
  /** 结构性缺失基础题解的包数量；这是允许的真状态，只属于统计。 */
  readonly missingBasicSolutionCount: number;
  readonly packagesWithEmbeddedAttachments: number;
  readonly embeddedAttachmentEntryCount: number;
  /** 落在规范 §2 允许之外（manifest.yaml、checksums.sha256、content/、samples/、assets/、attachments/ 以外）的条目数量。 */
  readonly unexpectedEntryNameCount: number;
}

const canonicalTopLevelFiles = ["manifest.yaml", "checksums.sha256"] as const;
const canonicalTopLevelPrefixes = ["content/", "samples/", "assets/", "attachments/"] as const;
const canonicalBasicSolutionPath = "content/basic-solution.md";
const canonicalAttachmentPrefix = "attachments/";

/** 只用包内条目路径做确定性判断，不读取任何条目正文。 */
export function summarizePackageEntryNames(
  entryNamesPerPackage: readonly (readonly string[])[],
): PackageContentSummary {
  let missingBasicSolutionCount = 0;
  let packagesWithEmbeddedAttachments = 0;
  let embeddedAttachmentEntryCount = 0;
  let unexpectedEntryNameCount = 0;
  for (const names of entryNamesPerPackage) {
    if (!names.includes(canonicalBasicSolutionPath)) missingBasicSolutionCount += 1;
    let hasAttachment = false;
    for (const name of names) {
      if (canonicalTopLevelFiles.includes(name as "manifest.yaml" | "checksums.sha256")) continue;
      if (canonicalTopLevelPrefixes.some((prefix) => name.startsWith(prefix))) {
        if (name.startsWith(canonicalAttachmentPrefix)) {
          hasAttachment = true;
          embeddedAttachmentEntryCount += 1;
        }
        continue;
      }
      unexpectedEntryNameCount += 1;
    }
    if (hasAttachment) packagesWithEmbeddedAttachments += 1;
  }
  return {
    packagesChecked: entryNamesPerPackage.length,
    missingBasicSolutionCount,
    packagesWithEmbeddedAttachments,
    embeddedAttachmentEntryCount,
    unexpectedEntryNameCount,
  };
}

export interface HistoryImportReconciliationInput {
  /** 私有清单元数据文件内容（题号是不参与输出的稳定身份）。 */
  readonly listMetadata: unknown;
  /** 打包阶段的 report.json 内容。 */
  readonly packageReport: unknown;
  /** 每个包内条目路径；与报告条目一一对应，缺失的包用空数组占位。 */
  readonly packageEntryNames: readonly (readonly string[])[];
  /** 权威清单的期望记录数；不一致直接判 NOT_READY。 */
  readonly expectedRecordCount?: number;
  /** 已有导入批次的 manifest 内容；必须与报告绑定同一摘要不完整。 */
  readonly importManifest?: unknown;
  /** 报告条目中未能读到包文件的数量。 */
  readonly missingPackageFileCount?: number;
}

export interface HistoryImportReconciliation {
  readonly verdict: "READY" | "NOT_READY";
  readonly reasonCodes: readonly HistoryImportPreflightReasonCode[];
  readonly listRecordCount: number;
  readonly packageCount: number;
  readonly duplicateCandidateCount: number;
  readonly missingSourceBindingCount: number;
  readonly embeddedAttachmentCount: number;
  readonly preservedMaterialCount: number;
  readonly missingBasicSolutionCount: number;
  readonly unexpectedEntryNameCount: number;
  readonly importedCount: number | undefined;
}

function codesFromReportSummary(summary: PackageReportSummary): HistoryImportPreflightReasonCode[] {
  const codes: HistoryImportPreflightReasonCode[] = [];
  if (summary.declaredPackageCount !== summary.packageCount) {
    codes.push("report_declared_count_mismatch");
  }
  if (summary.duplicateCandidateCount > 0) codes.push("duplicate_candidate");
  if (summary.missingSourceBindingCount > 0) codes.push("source_binding_missing");
  if (summary.zeroBytePackageCount > 0) codes.push("empty_package");
  if (
    summary.declaredPreservedMaterialCount !== undefined &&
    summary.declaredPreservedMaterialCount !== summary.preservedMaterialCount
  ) {
    codes.push("preserved_material_mismatch");
  }
  return codes;
}

/**
 * 确定性对账：清单记录数、包报告、包内条目结构与已有导入清单一致才 READY。
 * 基础题解结构性缺失只计数；来源绑定缺失、数量不一致、包文件缺失等都是
 * 硬性失败，任何一项都不会被静默跳过。
 */
export function reconcileHistoryImportBatch(
  input: HistoryImportReconciliationInput,
): HistoryImportReconciliation {
  const metadata = historyMetadataFileSchema.safeParse(input.listMetadata);
  if (!metadata.success) {
    throw new HistoryMigrationError("INVALID_METADATA", "清单元数据文件没有通过结构校验。");
  }
  const report = packageReportPayloadSchema.safeParse(input.packageReport);
  if (!report.success) {
    throw new HistoryMigrationError("INVALID_METADATA", "打包报告没有通过结构校验。");
  }
  const listRecordCount = metadata.data.records.length;
  const reportSummary = summarizePackageReport(input.packageReport);
  const contentSummary = summarizePackageEntryNames(input.packageEntryNames);
  const reasonCodes = codesFromReportSummary(reportSummary);
  if (contentSummary.unexpectedEntryNameCount > 0) reasonCodes.push("unexpected_entry_names");
  if (
    reportSummary.declaredAttachmentCount !== undefined &&
    reportSummary.declaredAttachmentCount !==
      contentSummary.embeddedAttachmentEntryCount + reportSummary.preservedMaterialCount
  ) {
    reasonCodes.push("attachment_count_mismatch");
  }
  if (listRecordCount !== reportSummary.packageCount) reasonCodes.push("metadata_report_count_mismatch");
  if (input.expectedRecordCount !== undefined && input.expectedRecordCount !== listRecordCount) {
    reasonCodes.push("expected_record_count_mismatch");
  }
  if (input.packageEntryNames.length !== reportSummary.packageCount) {
    reasonCodes.push("entry_names_incomplete");
  }
  if ((input.missingPackageFileCount ?? 0) > 0) reasonCodes.push("package_file_missing");

  let importedCount: number | undefined;
  if (input.importManifest !== undefined) {
    const manifest = importManifestPayloadSchema.safeParse(input.importManifest);
    if (!manifest.success) {
      throw new HistoryMigrationError("INVALID_METADATA", "导入清单没有通过结构校验。");
    }
    importedCount = manifest.data.importedCount;
    if (manifest.data.batchSha256 !== report.data.batchSha256) reasonCodes.push("manifest_batch_mismatch");
    if (manifest.data.importedCount !== reportSummary.packageCount) reasonCodes.push("manifest_incomplete");
  }

  return {
    verdict: reasonCodes.length === 0 ? "READY" : "NOT_READY",
    reasonCodes,
    listRecordCount,
    packageCount: reportSummary.packageCount,
    duplicateCandidateCount: reportSummary.duplicateCandidateCount,
    missingSourceBindingCount: reportSummary.missingSourceBindingCount,
    embeddedAttachmentCount: contentSummary.embeddedAttachmentEntryCount,
    preservedMaterialCount: reportSummary.preservedMaterialCount,
    missingBasicSolutionCount: contentSummary.missingBasicSolutionCount,
    unexpectedEntryNameCount: contentSummary.unexpectedEntryNameCount,
    importedCount,
  };
}

export interface ZeroMutationDatabaseResult {
  readonly serverVersion: string;
  readonly readOnlyEnforced: boolean;
  readonly presentTableCount: number;
  readonly missingTableCount: number;
  readonly rowCounts: readonly { readonly table: string; readonly rows: number }[];
}

/**
 * 零数据库变更预检：整个流程在显式只读事务内完成，任何 INSERT/UPDATE/
 * DELETE 都会被数据库拒绝。只读开关确认失败会立即中止，确保预检绝不会
 * 在未受保护的状态下触碰任何数据表。
 */
export async function runZeroMutationDatabasePreflight(
  database: DatabaseHandle,
): Promise<ZeroMutationDatabaseResult> {
  // 不限制引擎：PGlite 同样是完整 PostgreSQL，只读事务与 SHOW/to_regclass
  // 语义一致，可用于确定性单测；真正的防变更保证由只读开关失败即中止提供。
  return database.transaction(async (executor) => {
    await executor.execute(sql`SET LOCAL transaction_read_only = on`);
    const flag = await executor.query<{ transaction_read_only: string }>(
      sql`SHOW transaction_read_only`,
    );
    const readOnlyEnforced = flag[0]?.transaction_read_only === "on";
    if (!readOnlyEnforced) {
      throw new HistoryMigrationError(
        "INVALID_ARGUMENTS",
        "无法启用只读事务，预检中止，未执行任何数据查询。",
      );
    }
    const versionRows = await executor.query<{ server_version: string }>(sql`SHOW server_version`);
    const rowCounts: { readonly table: string; readonly rows: number }[] = [];
    let presentTableCount = 0;
    let missingTableCount = 0;
    for (const table of historyImportRequiredTables) {
      const qualifiedName = `public.${table}`;
      const found = await executor.query<{ found: string | null }>(
        sql`select to_regclass(${qualifiedName})::text as found`,
      );
      if (found[0]?.found === null || found[0]?.found === undefined) {
        missingTableCount += 1;
        continue;
      }
      presentTableCount += 1;
      const counted = await executor.query<{ total: bigint }>(
        sql`select count(*)::bigint as total from ${sql.raw(`"public"."${table}"`)}`,
      );
      rowCounts.push({ table, rows: Number(counted[0]?.total ?? 0) });
    }
    return {
      serverVersion: versionRows[0]?.server_version ?? "",
      readOnlyEnforced,
      presentTableCount,
      missingTableCount,
      rowCounts,
    };
  });
}
