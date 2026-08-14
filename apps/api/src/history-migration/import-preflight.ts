/**
 * 历史导入第 1 阶段预检：确定性对账与零数据库变更检查。
 *
 * 预检只产出聚合计数与布尔结论，不输出题号、题目名称、候选正文或任何私有
 * 文件路径；数据库侧强制只读事务，任何写操作都会由数据库直接拒绝，保证
 * 预检自身无法变更数据库。基础题解缺失与未决附件属于真状态，预检如实
 * 计数，但不把它们当作失败原因。
 */
import { join } from "node:path";
import { readdir } from "node:fs/promises";
import { sql } from "drizzle-orm";
import { z } from "zod";
import type { DatabaseHandle } from "@urmotiv/database";
import { readZipArchive, urmotivNativeAdapter, type CanonicalProblem } from "@urmotiv/problem-package";

import { HistoryMigrationError } from "./errors";
import { historyMetadataFileSchema } from "./schema";
import {
  importManifestPayloadSchema,
  maximumImportPackageBytes,
  packageReportPayloadSchema,
} from "./import-phase";
import { sha256Hex } from "./digests";
import { readPrivateRegularBytes } from "./private-files";
import {
  expectedRevisionContentInventory,
  type RevisionContentInventory,
} from "./revision-integrity";

/** 真实导入中经 DatabaseImportedProblemWriter 原子写入的全部表与对象。 */
export const historyImportRequiredTables = [
  "users",
  "problems",
  "problem_revisions",
  "problem_revision_tags",
  "problem_revision_files",
  "problem_samples",
  "import_jobs",
  "import_job_items",
  "audit_events",
  "stored_files",
] as const;

/**
 * 逐包扫描打包目录：读取磁盘字节、解压校验条目名、核对字节数与摘要、
 * 检测未登记的额外包文件。这是预检 CLI 和验收 runner 共用的同一套扫描逻辑。
 */
export interface PackageScanResult {
  readonly entryNames: readonly string[][];
  readonly missingPackageFileCount: number;
  readonly packageBytesMismatchCount: number;
  readonly packageDigestMismatchCount: number;
  readonly unreportedExtraPackageCount: number;
  /** 从包内容独立解析得到的 problem_samples 预期增量。 */
  readonly expectedSampleRows: number;
  /** 从包内容独立解析得到的 problem_revision_files 预期增量。 */
  readonly expectedProblemFileRows: number;
  /** import_input 与问题附件合计的 stored_files/物理对象预期增量。 */
  readonly expectedStoredFilesRows: number;
  readonly expectedStoredBytes: number;
  /** 忽略随机存储路径，只绑定每个对象的摘要与字节数。 */
  readonly expectedStoredContentSha256: string;
  readonly expectedRevisionInventory: RevisionContentInventory;
}

export async function scanPackageDirectory(
  packageDirectory: string,
  reportParsed: z.infer<typeof packageReportPayloadSchema>,
): Promise<PackageScanResult> {
  const entryNames: string[][] = [];
  const storedObjects: { readonly sha256: string; readonly bytes: number }[] = [];
  let missingPackageFileCount = 0;
  let packageBytesMismatchCount = 0;
  let packageDigestMismatchCount = 0;
  let expectedSampleRows = 0;
  let expectedProblemFileRows = 0;
  const revisionPackages: Array<{
    readonly candidateId: string;
    readonly problem: Awaited<ReturnType<typeof urmotivNativeAdapter.import>>;
  }> = [];
  let expectedStoredFilesRows = 0;
  let expectedStoredBytes = 0;
  const expectedPackageFiles = new Set<string>();
  for (const entry of reportParsed.packages) {
    const fileName = `${entry.candidateId}.zip`;
    expectedPackageFiles.add(fileName);
    const packagePath = join(packageDirectory, "packages", fileName);
    try {
      const bytes = await readPrivateRegularBytes(packagePath, maximumImportPackageBytes);
      const packageSha256 = sha256Hex(bytes);
      const archive = readZipArchive(bytes);
      const imported = await urmotivNativeAdapter.import(archive, { conflictAction: "create" });
      entryNames.push(archive.summary.entries.map((item) => item.path));
      expectedSampleRows += imported.samples.length;
      expectedProblemFileRows += imported.files.length;
      expectedStoredFilesRows += 1 + imported.files.length;
      expectedStoredBytes += bytes.byteLength;
      storedObjects.push({ sha256: packageSha256, bytes: bytes.byteLength });
      revisionPackages.push({ candidateId: entry.candidateId, problem: imported });
      for (const file of imported.files) {
        const fileSha256 = sha256Hex(file.content);
        expectedStoredBytes += file.content.byteLength;
        storedObjects.push({ sha256: fileSha256, bytes: file.content.byteLength });
      }
      if (bytes.byteLength !== entry.packageBytes) packageBytesMismatchCount += 1;
      if (packageSha256 !== entry.packageSha256) packageDigestMismatchCount += 1;
    } catch {
      missingPackageFileCount += 1;
      entryNames.push([]);
    }
  }
  let unreportedExtraPackageCount = 0;
  let diskFiles: string[];
  try {
    diskFiles = await readdir(join(packageDirectory, "packages"));
  } catch {
    diskFiles = [];
  }
  for (const fileName of diskFiles) {
    if (fileName.endsWith(".zip") && !expectedPackageFiles.has(fileName)) {
      unreportedExtraPackageCount += 1;
    }
  }
  storedObjects.sort((left, right) => {
    const digestOrder = left.sha256.localeCompare(right.sha256);
    return digestOrder === 0 ? left.bytes - right.bytes : digestOrder;
  });
  return {
    entryNames,
    missingPackageFileCount,
    packageBytesMismatchCount,
    packageDigestMismatchCount,
    unreportedExtraPackageCount,
    expectedSampleRows,
    expectedProblemFileRows,
    expectedStoredFilesRows,
    expectedStoredBytes,
    expectedStoredContentSha256: sha256Hex(JSON.stringify(storedObjects)),
    expectedRevisionInventory: expectedRevisionContentInventory(revisionPackages),
  };
}

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

/** 打包报告载荷的解析类型；供批次身份重算与收据复用。 */
export type PackageReportPayload = z.infer<typeof packageReportPayloadSchema>;

/** 第 2 阶段预检补充原因码；一律以稳定 ASCII 码输出，绝不携带私有内容。 */
export const historyImportPreflightExtendedReasonCodes = [
  "duplicate_source_binding",
  "duplicate_package_digest",
  "batch_identity_mismatch",
  "package_digest_mismatch",
  "package_bytes_mismatch",
  "unreported_extra_packages",
  "grouping_join_mismatch",
  "database_tag_missing",
  "manifest_entry_mismatch",
  "duplicate_manifest_entry",
] as const;
export type HistoryImportPreflightExtendedReasonCode =
  (typeof historyImportPreflightExtendedReasonCodes)[number];

export type HistoryImportPreflightReasonCode =
  (typeof historyImportPreflightReasonCodes)[number];

export interface PackageReportSummary {
  readonly packageCount: number;
  readonly declaredPackageCount: number;
  readonly duplicateCandidateCount: number;
  readonly missingSourceBindingCount: number;
  readonly duplicateSourceBindingCount: number;
  readonly duplicatePackageDigestCount: number;
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
  const packageDigests = new Set<string>();
  let duplicateCandidateCount = 0;
  let missingSourceBindingCount = 0;
  let embeddedAttachmentCount = 0;
  const sourceBindings = new Set<string>();
  let duplicateSourceBindingCount = 0;
  let duplicatePackageDigestCount = 0;
  let zeroBytePackageCount = 0;
  for (const entry of report.packages) {
    if (candidateIds.has(entry.candidateId)) duplicateCandidateCount += 1;
    candidateIds.add(entry.candidateId);
    if (packageDigests.has(entry.packageSha256)) duplicatePackageDigestCount += 1;
    packageDigests.add(entry.packageSha256);
    if (entry.sourceBindingSha256 === undefined) missingSourceBindingCount += 1;
    if (entry.sourceBindingSha256 !== undefined) {
      if (sourceBindings.has(entry.sourceBindingSha256)) duplicateSourceBindingCount += 1;
      sourceBindings.add(entry.sourceBindingSha256);
    }
    if (entry.attachments !== undefined) embeddedAttachmentCount += entry.attachments.length;
    if (entry.packageBytes === 0) zeroBytePackageCount += 1;
  }
  return {
    packageCount: report.packages.length,
    declaredPackageCount: report.packageCount,
    duplicateCandidateCount,
    missingSourceBindingCount,
    duplicateSourceBindingCount,
    duplicatePackageDigestCount,
    declaredAttachmentCount: report.attachmentCount,
    embeddedAttachmentCount,
    preservedMaterialCount: report.preservedMaterials?.length ?? 0,
    declaredPreservedMaterialCount: report.preservedMaterialCount,
    zeroBytePackageCount,
  };
}

/** 批次身份按打包阶段 core.ts 的精确字段顺序重算；任何一项漂移都会失败。 */
export function recomputePackageBatchIdentity(report: PackageReportPayload): string {
  const entries = report.packages.map((entry) => ({
    candidateId: entry.candidateId,
    contentSha256: entry.contentSha256,
    sourceBindingSha256: entry.sourceBindingSha256,
    packageSha256: entry.packageSha256,
    packageBytes: entry.packageBytes,
    status: entry.status,
    ...(entry.attachments !== undefined && entry.attachments.length > 0
      ? {
          attachments: entry.attachments.map((attachment) => ({
            attachmentId: attachment.attachmentId,
            contentSha256: attachment.contentSha256,
            semanticRole: attachment.semanticRole,
            visibility: attachment.visibility,
            targetPath: attachment.targetPath,
          })),
        }
      : {}),
  }));
  const batchPayload = {
    version: 1,
    packages: entries,
    ...(report.attachmentCount === undefined || report.preservedMaterialCount === undefined
      ? {}
      : {
          attachmentCount: report.attachmentCount,
          preservedMaterialCount: report.preservedMaterialCount,
          preservedMaterials: (report.preservedMaterials ?? []).map((material) => ({
            attachmentId: material.attachmentId,
            contentSha256: material.contentSha256,
            semanticRole: material.semanticRole,
            preservationPath: material.preservationPath,
          })),
        }),
  };
  return sha256Hex(JSON.stringify(batchPayload));
}

/** 全批来源绑定摘要；固定保留报告顺序并绑定候选身份，供收据与执行环境核对。 */
export function recomputeSourceBindingsIdentity(report: PackageReportPayload): string {
  return sha256Hex(
    JSON.stringify(
      report.packages.map((entry) => ({
        candidateId: entry.candidateId,
        sourceBindingSha256: entry.sourceBindingSha256,
      })),
    ),
  );
}

export interface AuthoritativeSourceIdentity {
  readonly candidateId: string;
  readonly contentSha256: string;
  readonly sourceBindingSha256: string;
}

/**
 * 把上游重新验证的源/候选身份按原批准顺序绑定到实际产出的包摘要。
 * 任何报告自报字段都必须与上游候选文件、批准文件和物化源重新计算的结果一致。
 */
export function bindAuthoritativePackageIdentities(
  report: PackageReportPayload,
  authoritative: readonly AuthoritativeSourceIdentity[],
): string {
  if (report.packages.length !== authoritative.length) {
    throw new HistoryMigrationError("INVALID_METADATA", "权威候选清单与产出包数量不一致。");
  }
  const bindings = report.packages.map((entry, index) => {
    const expected = authoritative[index];
    if (
      expected === undefined ||
      entry.candidateId !== expected.candidateId ||
      entry.contentSha256 !== expected.contentSha256 ||
      entry.sourceBindingSha256 !== expected.sourceBindingSha256
    ) {
      throw new HistoryMigrationError("INVALID_METADATA", "产出包没有绑定到权威源与候选身份。");
    }
    return {
      candidateId: expected.candidateId,
      contentSha256: expected.contentSha256,
      sourceBindingSha256: expected.sourceBindingSha256,
      packageSha256: entry.packageSha256,
    };
  });
  return sha256Hex(JSON.stringify(bindings));
}

interface BoundManifestContentEntry {
  readonly candidateId: string;
  readonly contentSha256: string;
  readonly sourceBindingSha256: string;
  readonly packageSha256: string;
}

function boundManifestContentEntries(
  report: PackageReportPayload,
  manifestInput: unknown,
): readonly BoundManifestContentEntry[] {
  const manifest = importManifestPayloadSchema.parse(manifestInput);
  if (
    manifest.batchSha256 !== report.batchSha256 ||
    manifest.importedCount !== report.packages.length ||
    manifest.entries.length !== report.packages.length
  ) {
    throw new HistoryMigrationError("INVALID_METADATA", "产出导入清单与批准批次不一致。");
  }
  const entriesByCandidate = new Map(manifest.entries.map((entry) => [entry.candidateId, entry]));
  if (entriesByCandidate.size !== report.packages.length) {
    throw new HistoryMigrationError("INVALID_METADATA", "产出导入清单包含重复或缺失候选。");
  }
  return report.packages.map((expected) => {
    const entry = entriesByCandidate.get(expected.candidateId);
    if (
      entry === undefined ||
      entry.packageSha256 !== expected.packageSha256 ||
      entry.contentSha256 !== expected.contentSha256 ||
      entry.sourceBindingSha256 !== expected.sourceBindingSha256
    ) {
      throw new HistoryMigrationError("INVALID_METADATA", "产出导入清单没有绑定权威源、候选与包身份。");
    }
    return {
      candidateId: entry.candidateId,
      contentSha256: entry.contentSha256,
      sourceBindingSha256: entry.sourceBindingSha256,
      packageSha256: entry.packageSha256,
    };
  });
}

/**
 * 与库状态无关的清单绑定：只哈希批内候选与内容/来源/包摘要。
 * 正式导入必须与第 2 阶段收据比较这个值（problemId 与库内序号相关，不跨库比较）。
 */
export function manifestContentBindingsIdentity(
  report: PackageReportPayload,
  manifestInput: unknown,
): string {
  return sha256Hex(JSON.stringify(boundManifestContentEntries(report, manifestInput)));
}

export function verifyProducedManifestIdentity(
  report: PackageReportPayload,
  manifestInput: unknown,
): string {
  const contentEntries = boundManifestContentEntries(report, manifestInput);
  const manifest = importManifestPayloadSchema.parse(manifestInput);
  const entriesByCandidate = new Map(manifest.entries.map((entry) => [entry.candidateId, entry]));
  const boundEntries = contentEntries.map((entry) => ({
    ...entry,
    problemIdSha256: sha256Hex(entriesByCandidate.get(entry.candidateId)!.problemId),
  }));
  return sha256Hex(JSON.stringify(boundEntries));
}

export interface AuthoritativeRevisionIdentity {
  readonly candidateId: string;
  readonly problem: CanonicalProblem;
}

/** 把 ZIP 中将写入数据库的全部修订字段绑定到权威批准候选，而非仅信任报告摘要。 */
export function bindAuthoritativeRevisionContent(
  packageInventory: RevisionContentInventory,
  authoritative: readonly AuthoritativeRevisionIdentity[],
): string {
  const expected = expectedRevisionContentInventory(authoritative);
  if (
    packageInventory.revisionCount !== expected.revisionCount ||
    packageInventory.nullSolutionCount !== expected.nullSolutionCount ||
    packageInventory.emptySolutionCount !== expected.emptySolutionCount ||
    packageInventory.fullContentSha256 !== expected.fullContentSha256 ||
    packageInventory.frozenContentSha256 !== expected.frozenContentSha256 ||
    packageInventory.databaseRowsSha256 !== expected.databaseRowsSha256
  ) {
    throw new HistoryMigrationError(
      "INVALID_METADATA",
      "产出包的全部修订内容没有绑定到权威批准候选。",
    );
  }
  return sha256Hex(JSON.stringify(expected));
}

/** 安全编号（如 M-0000123）与清单题号的规范化等价形式：仅比较数字后缀。 */
function normalizedMetadataIdentity(raw: string): string {
  const digits = raw.replace(/\D/g, "").replace(/^0+(?=\d)/, "");
  return digits;
}

export interface GroupingJoinVerification {
  readonly metadataRecordCount: number;
  readonly groupingIdentityCount: number;
  readonly matchedIdentityCount: number;
  readonly duplicateIdentityCount: number;
}

/**
 * 机械核对清单元数据到分组安全编号的连接：题号数字后缀必须与安全编号
 * 一一对应，分组数量与清单记录数一致；任何一边多、少或重复都会失败。
 */
export function verifyGroupingJoin(
  metadataNumbers: readonly string[],
  groupingMetadataIds: readonly string[],
): GroupingJoinVerification {
  const metadataNormalized = metadataNumbers.map(normalizedMetadataIdentity);
  const groupingNormalized = groupingMetadataIds.map(normalizedMetadataIdentity);
  const seen = new Set<string>();
  let duplicateIdentityCount = 0;
  for (const identity of groupingNormalized) {
    if (seen.has(identity)) duplicateIdentityCount += 1;
    seen.add(identity);
  }
  let matchedIdentityCount = 0;
  for (const identity of groupingNormalized) {
    if (metadataNormalized.includes(identity)) matchedIdentityCount += 1;
  }
  return {
    metadataRecordCount: metadataNumbers.length,
    groupingIdentityCount: groupingMetadataIds.length,
    matchedIdentityCount,
    duplicateIdentityCount,
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
  /** 已有导入批次的 manifest 内容；必须与报告逐条绑定同一身份且条目完整。 */
  readonly importManifest?: unknown;
  /** 报告条目中未能读到包文件的数量。 */
  readonly missingPackageFileCount?: number;
  /** 磁盘上包字节数与报告声明不一致的数量。 */
  readonly packageBytesMismatchCount?: number;
  /** 磁盘上包摘要重算与报告声明不一致的数量。 */
  readonly packageDigestMismatchCount?: number;
  /** 磁盘上存在但报告未登记的包数量。 */
  readonly unreportedExtraPackageCount?: number;
  /** 分组阶段安全编号列表；提供时与清单题号做机械连接核对。 */
  readonly groupingMetadataIds?: readonly string[];
}

export interface HistoryImportReconciliation {
  readonly verdict: "READY" | "NOT_READY";
  readonly reasonCodes: readonly (
    | HistoryImportPreflightReasonCode
    | HistoryImportPreflightExtendedReasonCode
  )[];
  readonly listRecordCount: number;
  readonly packageCount: number;
  readonly duplicateCandidateCount: number;
  readonly duplicateSourceBindingCount: number;
  readonly duplicatePackageDigestCount: number;
  readonly missingSourceBindingCount: number;
  readonly embeddedAttachmentCount: number;
  readonly preservedMaterialCount: number;
  readonly missingBasicSolutionCount: number;
  readonly unexpectedEntryNameCount: number;
  readonly importedCount: number | undefined;
  /** 批次身份按打包阶段公式重算后是否与报告一致。 */
  readonly batchIdentityMatches: boolean;
  /** 清单↔分组安全编号机械连接结果；未提供分组输入时为 undefined。 */
  readonly groupingJoin: GroupingJoinVerification | undefined;
}

function codesFromReportSummary(
  summary: PackageReportSummary,
): (HistoryImportPreflightReasonCode | HistoryImportPreflightExtendedReasonCode)[] {
  const codes: (HistoryImportPreflightReasonCode | HistoryImportPreflightExtendedReasonCode)[] = [];
  if (summary.declaredPackageCount !== summary.packageCount) {
    codes.push("report_declared_count_mismatch");
  }
  if (summary.duplicateCandidateCount > 0) codes.push("duplicate_candidate");
  if (summary.missingSourceBindingCount > 0) codes.push("source_binding_missing");
  if (summary.duplicateSourceBindingCount > 0) codes.push("duplicate_source_binding");
  if (summary.duplicatePackageDigestCount > 0) codes.push("duplicate_package_digest");
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
  if ((input.packageBytesMismatchCount ?? 0) > 0) reasonCodes.push("package_bytes_mismatch");
  if ((input.packageDigestMismatchCount ?? 0) > 0) reasonCodes.push("package_digest_mismatch");
  if ((input.unreportedExtraPackageCount ?? 0) > 0) reasonCodes.push("unreported_extra_packages");
  const recomputedBatchIdentity = recomputePackageBatchIdentity(report.data);
  const batchIdentityMatches = recomputedBatchIdentity === report.data.batchSha256;
  if (!batchIdentityMatches) reasonCodes.push("batch_identity_mismatch");

  let groupingJoin: GroupingJoinVerification | undefined;
  if (input.groupingMetadataIds !== undefined) {
    groupingJoin = verifyGroupingJoin(
      metadata.data.records.map((record) => record.number),
      input.groupingMetadataIds,
    );
    if (
      groupingJoin.groupingIdentityCount !== listRecordCount ||
      groupingJoin.matchedIdentityCount !== listRecordCount ||
      groupingJoin.duplicateIdentityCount > 0
    ) {
      reasonCodes.push("grouping_join_mismatch");
    }
  }

  let importedCount: number | undefined;
  if (input.importManifest !== undefined) {
    const manifest = importManifestPayloadSchema.safeParse(input.importManifest);
    if (!manifest.success) {
      throw new HistoryMigrationError("INVALID_METADATA", "导入清单没有通过结构校验。");
    }
    importedCount = manifest.data.importedCount;
    if (manifest.data.batchSha256 !== report.data.batchSha256) reasonCodes.push("manifest_batch_mismatch");
    if (manifest.data.importedCount !== reportSummary.packageCount) reasonCodes.push("manifest_incomplete");
    // 逐条比对候选、候选内容、来源绑定和实际包摘要，反向也必须完整覆盖。
    const reportIdentityByCandidate = new Map(
      report.data.packages.map((entry) => [
        entry.candidateId,
        {
          packageSha256: entry.packageSha256,
          contentSha256: entry.contentSha256,
          sourceBindingSha256: entry.sourceBindingSha256,
        },
      ]),
    );
    const manifestCandidates = new Set<string>();
    let duplicateManifestEntries = 0;
    let manifestEntryMismatches = 0;
    if (manifest.data.entries.length !== report.data.packages.length) manifestEntryMismatches += 1;
    for (const entry of manifest.data.entries) {
      if (manifestCandidates.has(entry.candidateId)) duplicateManifestEntries += 1;
      manifestCandidates.add(entry.candidateId);
      const expected = reportIdentityByCandidate.get(entry.candidateId);
      if (
        expected === undefined ||
        expected.packageSha256 !== entry.packageSha256 ||
        expected.contentSha256 !== entry.contentSha256 ||
        expected.sourceBindingSha256 !== entry.sourceBindingSha256
      ) {
        manifestEntryMismatches += 1;
      }
    }
    if (duplicateManifestEntries > 0) reasonCodes.push("duplicate_manifest_entry");
    if (manifestEntryMismatches > 0) reasonCodes.push("manifest_entry_mismatch");
  }

  return {
    verdict: reasonCodes.length === 0 ? "READY" : "NOT_READY",
    reasonCodes,
    listRecordCount,
    packageCount: reportSummary.packageCount,
    duplicateCandidateCount: reportSummary.duplicateCandidateCount,
    duplicatePackageDigestCount: reportSummary.duplicatePackageDigestCount,
    missingSourceBindingCount: reportSummary.missingSourceBindingCount,
    embeddedAttachmentCount: contentSummary.embeddedAttachmentEntryCount,
    preservedMaterialCount: reportSummary.preservedMaterialCount,
    missingBasicSolutionCount: contentSummary.missingBasicSolutionCount,
    unexpectedEntryNameCount: contentSummary.unexpectedEntryNameCount,
    duplicateSourceBindingCount: reportSummary.duplicateSourceBindingCount,
    batchIdentityMatches,
    groupingJoin,
    importedCount,
  };
}

export interface ZeroMutationDatabaseResult {
  readonly serverVersion: string;
  readonly readOnlyEnforced: boolean;
  readonly presentTableCount: number;
  readonly missingTableCount: number;
  readonly rowCounts: readonly { readonly table: string; readonly rows: number }[];
  /** 指定的标签/执行主体是否存在；未提供对应参数时为 undefined。 */
  readonly tagPresent?: boolean | undefined;
  readonly principalPresent?: boolean | undefined;
}

/**
 * 零数据库变更预检：整个流程在显式只读事务内完成，任何 INSERT/UPDATE/
 * DELETE 都会被数据库拒绝。只读开关确认失败会立即中止，确保预检绝不会
 * 在未受保护的状态下触碰任何数据表。
 */
export async function runZeroMutationDatabasePreflight(
  database: DatabaseHandle,
  options: {
    readonly requiredTagId?: string;
    readonly requiredPrincipalId?: string;
  } = {},
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
    let tagPresent: boolean | undefined;
    if (options.requiredTagId !== undefined) {
      const tagRows = await executor.query<{ total: bigint }>(
        sql`select count(*)::bigint as total from "public"."tags" where id = ${options.requiredTagId}`,
      );
      tagPresent = Number(tagRows[0]?.total ?? 0) === 1;
    }
    let principalPresent: boolean | undefined;
    if (options.requiredPrincipalId !== undefined) {
      const principalRows = await executor.query<{ total: bigint }>(
        sql`select count(*)::bigint as total from "public"."users"
            where id = ${options.requiredPrincipalId} and disabled_at is null`,
      );
      principalPresent = Number(principalRows[0]?.total ?? 0) === 1;
    }
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
        sql`select count(*)::bigint as total from ${sql.identifier("public")}.${sql.identifier(table)}`,
      );
      rowCounts.push({ table, rows: Number(counted[0]?.total ?? 0) });
    }
    return {
      serverVersion: versionRows[0]?.server_version ?? "",
      tagPresent,
      principalPresent,
      readOnlyEnforced,
      presentTableCount,
      missingTableCount,
      rowCounts,
    };
  });
}
