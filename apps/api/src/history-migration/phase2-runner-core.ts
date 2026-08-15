import { dirname, join } from "node:path";
import { lstat, rename, rm } from "node:fs/promises";
import { userInfo } from "node:os";
import { sql } from "drizzle-orm";
import { z } from "zod";
import {
  createPostgresDatabase,
  type DatabaseHandle,
} from "@urmotiv/database";
import type { ImportExecutionAuthorization } from "@urmotiv/jobs";

import { DatabaseDataStore } from "../database-store";
import { ServiceImportExecutionAuthorization } from "../problem-package-runtime";

import { sha256Hex } from "./digests";
import { HistoryMigrationError } from "./errors";
import {
  computeFormalAdminFingerprintSha256,
  computeStorageRootIdentitySha256,
  parsePostgresIdentity,
} from "./formal-identity";
import {
  dropHistoryImportDatabase,
  importHistoryPackages,
  importManifestPayloadSchema,
  packageReportPayloadSchema,
  prepareHistoryImportDatabase,
  historyImportDatabaseConnectionString,
} from "./import-phase";
import {
  verifyApprovedPackageSourceIdentities,
  type VerifyApprovedPackageSourceIdentitiesOptions,
} from "./core";
import {
  bindAuthoritativePackageIdentities,
  bindAuthoritativeRevisionContent,
  historyImportRequiredTables,
  manifestContentBindingsIdentity,
  reconcileHistoryImportBatch,
  recomputeSourceBindingsIdentity,
  runZeroMutationDatabasePreflight,
  scanPackageDirectory,
  verifyProducedManifestIdentity,
  type HistoryImportReconciliation,
  type PackageScanResult,
} from "./import-preflight";
import {
  assertScratchDatabaseName,
  captureHistoryImportTableCounts,
  captureStoredFileInventory,
  countSolutionStatesForProblems,
  countRevisionFilesForProblems,
  verifyPhase2Outcome,
  type HistoryImportCountRow,
  type Phase2PostcheckResult,
  type StoredFileInventory,
} from "./phase2-postcheck";
import {
  captureImportedRevisionContentInventory,
  type RevisionContentInventory,
} from "./revision-integrity";
import {
  captureDatabaseContentInventory,
  captureStorageInventory,
  databaseContentInventoriesEqual,
  captureStorageInventoryIfPresent,
  dropCanonicalScratchSnapshot,
  dropScratchSnapshot,
  dropScratchSnapshotGeneration,
  probeScratchSnapshotGeneration,
  promoteScratchDatabaseGeneration,
  restoreScratchDatabase,
  restoreStorageDirectory,
  snapshotStorageDirectory,
  snapshotScratchDatabase,
  snapshotScratchDatabaseGeneration,
  storageInventoriesEqual,
  type DatabaseContentInventory,
  type StorageInventory,
} from "./history-import-snapshot";
import {
  advanceFormalRecoveryPhase,
  readFormalRecoveryState,
  recoveryStateSha256,
  startFormalRecoveryState,
  type FormalRecoveryPhase,
} from "./formal-recovery-state";
import {
  assertNewOutputPath,
  assertPathsInsidePrivateRoot,
  assertPrivateDirectoryMode,
  privateRegularFileExists,
  readPrivateJson,
  readPrivateJsonWithDigest,
  writeNewPrivateJson,
  writePrivateFile,
} from "./private-files";
import {
  assertPermittedPhase2EvidenceRoot,
  verifyExecutionProvenance,
  type ExecutionProvenance,
} from "./execution-provenance";
import { preflightPassMarkerName } from "./pipeline-constants";
import { resolveRunnerInputs, type RunnerInputs } from "./runner-inputs";
import { digestPattern, preflightReceiptSchema } from "./runner-inputs";
import { importManifestName, targetApprovalTemplateName, cleanupRecoveryEvidenceName, runReceiptName, runPassMarkerName, recoveryMarkerName, cleanupMarkerName, cleanupRefusedMarkerName } from "./pipeline-constants";
function isMissingFilesystemEntryError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { readonly code?: unknown }).code === "ENOENT"
  );
}
/**
 * 终删中断证据用的尽力清单探针：目录存在但无法读取（例如权限被现场
 * 故障破坏）时如实报告 present=true、inventory=null，而不是让证据写盘
 * 本身失败；只有目录缺失才报告未在场。
 */
async function probeStorageCapture(
  directory: string,
): Promise<{ readonly present: boolean; readonly inventory: StorageInventory | null }> {
  try {
    await lstat(directory);
  } catch (lstatError) {
    if (isMissingFilesystemEntryError(lstatError)) return { present: false, inventory: null };
    throw lstatError;
  }
  const inventory = await captureStorageInventory(directory).catch(() => null);
  return { present: true, inventory };
}

 /** 换代与终删的故障注入缝（仅测试）；正式入口不提供这些参数。 */
export interface Phase2CleanupFaultHooks {
  /** 换代开始前：旧代完整保留的失败现场。 */
  readonly beforeGenerationReplacement?: (() => Promise<void>) | undefined;
  /** 新代（数据库 g2 + 存储 .next）均已建立并核对后。 */
  readonly afterGenerationSealed?: (() => Promise<void>) | undefined;
  /** 旧代数据库规范名已删除、存储换代开始前。 */
  readonly afterDatabaseSnapshotRetired?: (() => Promise<void>) | undefined;
  /** 存储 g2 已提升为规范名、数据库 g2 提升前。 */
  readonly afterStorageSnapshotPromoted?: (() => Promise<void>) | undefined;
  /** 终删：数据库快照已删除（成对代已退役）后的喊停点；此后任何失败都
   * 只允许报告「已退役待清理」，绝不允许产出可回滚的 FAILED 相位。 */
  readonly afterTerminalDatabaseDrop?: (() => Promise<void>) | undefined;
  /** 终删：隔离存储已删除、终态相位写盘之前。 */
  readonly beforeTerminalFinalizedWrite?: (() => Promise<void>) | undefined;
}

export interface Phase2RunnerHooks {
  readonly afterSnapshot?: (() => Promise<void>) | undefined;
  readonly afterFirstPass?: (() => Promise<void>) | undefined;
  readonly beforeSnapshotCleanup?: (() => Promise<void>) | undefined;
  readonly cleanupFaults?: Phase2CleanupFaultHooks | undefined;
  readonly verifyProvenance?: ((commit: string) => Promise<ExecutionProvenance>) | undefined;
  readonly verifySourceIdentities?:
    | ((
        options: VerifyApprovedPackageSourceIdentitiesOptions,
      ) => ReturnType<typeof verifyApprovedPackageSourceIdentities>)
    | undefined;
}



function groupingIds(payload: unknown): string[] {
  if (
    typeof payload !== "object" ||
    payload === null ||
    !("groups" in payload) ||
    !Array.isArray(payload.groups)
  ) {
    return [];
  }
  return payload.groups
    .map((group) =>
      typeof group === "object" && group !== null && "metadataId" in group
        ? group.metadataId
        : undefined,
    )
    .filter((id): id is string => typeof id === "string");
}

function countsEqual(
  left: readonly HistoryImportCountRow[],
  right: readonly HistoryImportCountRow[],
): boolean {
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1) {
    if (left[index]?.table !== right[index]?.table || left[index]?.rows !== right[index]?.rows) {
      return false;
    }
  }
  return true;
}

function storedInventoriesEqual(left: StoredFileInventory, right: StoredFileInventory): boolean {
  return left.fileCount === right.fileCount &&
    left.totalBytes === right.totalBytes &&
    left.contentInventorySha256 === right.contentInventorySha256;
}

async function scratchDatabaseExists(adminUrl: string, databaseName: string): Promise<boolean> {
  const database = createPostgresDatabase({
    connectionString: adminUrl,
    maxConnections: 1,
    applicationName: "urmotiv-history-import-target-check",
  });
  try {
    const rows = await database.query<{ total: bigint }>(
      sql`select count(*)::bigint as total from pg_database where datname = ${databaseName}`,
    );
    return Number(rows[0]?.total ?? 0) === 1;
  } finally {
    await database.close();
  }
}

export interface ValidationContext {
  readonly report: z.infer<typeof packageReportPayloadSchema>;
  readonly scan: PackageScanResult;
  readonly reconciliation: HistoryImportReconciliation;
  readonly preflightReceiptSha256: string;
  readonly packageCount: number;
  readonly authoritativePackageIdentitySha256: string;
  readonly authoritativeRevisionIdentitySha256: string;
  readonly provenance: ExecutionProvenance;
}

async function validateBeforeMutation(
  inputs: RunnerInputs,
  hooks: Phase2RunnerHooks,
): Promise<ValidationContext> {
  await assertPermittedPhase2EvidenceRoot(inputs.privateRoot);
  await assertPrivateDirectoryMode(inputs.receiptDirectory);
  await assertPrivateDirectoryMode(inputs.storageRoot);
  const runReceiptPath = join(inputs.receiptDirectory, runReceiptName);
  const passMarkerPath = join(inputs.receiptDirectory, runPassMarkerName);
  const recoveryMarkerPath = join(inputs.receiptDirectory, recoveryMarkerName);
  const storageSnapshotDirectory = join(inputs.receiptDirectory, "storage.snapshot");
  const markerPath = join(dirname(inputs.preflightReceipt), preflightPassMarkerName);
  await assertPathsInsidePrivateRoot(inputs.privateRoot, [
    { path: inputs.packageDirectory, kind: "existing" },
    { path: inputs.listMetadata, kind: "existing" },
    { path: inputs.groupingFile, kind: "existing" },
    { path: inputs.materializedDirectory, kind: "existing" },
    { path: inputs.preparedDirectory, kind: "existing" },
    { path: inputs.approvalFile, kind: "existing" },
    { path: inputs.preflightReceipt, kind: "existing" },
    { path: markerPath, kind: "existing" },
    { path: inputs.receiptDirectory, kind: "existing" },
    { path: inputs.storageRoot, kind: "existing" },
    { path: inputs.importOutputDirectory, kind: "new" },
    { path: runReceiptPath, kind: "new" },
    { path: passMarkerPath, kind: "new" },
    { path: recoveryMarkerPath, kind: "new" },
    { path: storageSnapshotDirectory, kind: "new" },
  ]);
  await assertNewOutputPath(inputs.importOutputDirectory);
  await assertNewOutputPath(runReceiptPath);
  await assertNewOutputPath(passMarkerPath);
  await assertNewOutputPath(recoveryMarkerPath);
  await assertNewOutputPath(storageSnapshotDirectory);

  const storageBefore = await captureStorageInventory(inputs.storageRoot);
  if (storageBefore.fileCount !== 0 || storageBefore.totalBytes !== 0) {
    throw new HistoryMigrationError("INVALID_ARGUMENTS", "第 2 阶段验收存储目录必须为空。");
  }
  if (!(await privateRegularFileExists(markerPath))) {
    throw new HistoryMigrationError("INVALID_METADATA", "第 1 阶段通过标记不存在。");
  }

  const provenance = await (hooks.verifyProvenance ?? verifyExecutionProvenance)(inputs.gitCommit);
  const sourceIdentityOptions = {
    privateRootDirectory: inputs.privateRoot,
    materializedDirectory: inputs.materializedDirectory,
    metadataFile: inputs.listMetadata,
    preparedDirectory: inputs.preparedDirectory,
    approvalFile: inputs.approvalFile,
  };
  const authoritativeIdentities = await (
    hooks.verifySourceIdentities ?? verifyApprovedPackageSourceIdentities
  )(sourceIdentityOptions);
  const metadataRead = await readPrivateJsonWithDigest(inputs.listMetadata);
  const reportRead = await readPrivateJsonWithDigest(join(inputs.packageDirectory, "report.json"));
  const groupingRead = await readPrivateJsonWithDigest(inputs.groupingFile);
  const receiptRead = await readPrivateJsonWithDigest(inputs.preflightReceipt);
  const report = packageReportPayloadSchema.parse(reportRead.value);
  const receipt = preflightReceiptSchema.parse(receiptRead.value);
  const scan = await scanPackageDirectory(inputs.packageDirectory, report);
  const authoritativeRevisionIdentitySha256 = bindAuthoritativeRevisionContent(
    scan.expectedRevisionInventory,
    authoritativeIdentities,
  );
  const authoritativePackageIdentitySha256 = bindAuthoritativePackageIdentities(
    report,
    authoritativeIdentities,
  );
  const packageCount = scan.expectedRevisionInventory.revisionCount;
  const sourceBindingsSha256 = recomputeSourceBindingsIdentity(report);
  const reconciliation = reconcileHistoryImportBatch({
    listMetadata: metadataRead.value,
    packageReport: reportRead.value,
    packageEntryNames: scan.entryNames,
    expectedRecordCount: authoritativeIdentities.length,
    missingPackageFileCount: scan.missingPackageFileCount,
    packageBytesMismatchCount: scan.packageBytesMismatchCount,
    packageDigestMismatchCount: scan.packageDigestMismatchCount,
    unreportedExtraPackageCount: scan.unreportedExtraPackageCount,
    groupingMetadataIds: groupingIds(groupingRead.value),
  });

  const receiptScanMatches =
    receipt.packageScan.expectedSampleRows === scan.expectedSampleRows &&
    receipt.packageScan.expectedProblemFileRows === scan.expectedProblemFileRows &&
    receipt.packageScan.expectedStoredFilesRows === scan.expectedStoredFilesRows &&
    receipt.packageScan.expectedStoredBytes === scan.expectedStoredBytes &&
    receipt.packageScan.expectedStoredContentSha256 === scan.expectedStoredContentSha256 &&
    JSON.stringify(receipt.packageScan.expectedRevisionInventory) ===
      JSON.stringify(scan.expectedRevisionInventory);
  const receiptBindingsMatch =
    receiptRead.sha256 === inputs.expectedPreflightReceiptSha256 &&
    receipt.targetClass === inputs.targetClass &&
    receipt.inputBindings.listMetadataSha256 === metadataRead.sha256 &&
    receipt.inputBindings.packageReportSha256 === reportRead.sha256 &&
    receipt.inputBindings.groupingSha256 === groupingRead.sha256 &&
    receipt.inputBindings.batchSha256 === report.batchSha256 &&
    receipt.inputBindings.sourceBindingsSha256 === sourceBindingsSha256 &&
    receipt.inputBindings.authoritativePackageIdentitySha256 ===
      authoritativePackageIdentitySha256 &&
    receipt.inputBindings.authoritativeRevisionIdentitySha256 ===
      authoritativeRevisionIdentitySha256 &&
    receipt.inputBindings.codeInventorySha256 === provenance.codeInventorySha256 &&
    receipt.inputBindings.codeInventoryEntryCount === provenance.codeInventoryEntryCount &&
    receipt.inputBindings.tagIdSha256 === sha256Hex(inputs.tagId) &&
    receipt.inputBindings.gitCommitSha256 === sha256Hex(inputs.gitCommit) &&
    receipt.inputBindings.principalSha256 === sha256Hex(inputs.principal) &&
    receipt.inputBindings.executionIdSha256 === sha256Hex(inputs.executionId) &&
    receipt.reconciliation.packageCount === packageCount &&
    receipt.packagesChecked === packageCount &&
    receipt.database.requiredTableCount === historyImportRequiredTables.length &&
    receipt.database.presentTableCount === historyImportRequiredTables.length &&
    receiptScanMatches;
  const approvedEnvironmentMatches =
    report.batchSha256 === inputs.expectedBatchSha256 &&
    sourceBindingsSha256 === inputs.expectedSourceBindingsSha256;
  if (
    packageCount !== authoritativeIdentities.length ||
    reconciliation.verdict !== "READY" ||
    !receiptBindingsMatch ||
    !approvedEnvironmentMatches
  ) {
    throw new HistoryMigrationError("INVALID_METADATA", "批准输入、收据或执行绑定不一致。");
  }

  const sourceDatabase = createPostgresDatabase({
    connectionString: inputs.adminUrl,
    maxConnections: 1,
    applicationName: "urmotiv-history-import-runner-preflight",
  });
  try {
    const databaseResult = await runZeroMutationDatabasePreflight(sourceDatabase, {
      requiredTagId: inputs.tagId,
      requiredPrincipalId: inputs.principal,
    });
    if (
      !databaseResult.readOnlyEnforced ||
      databaseResult.missingTableCount !== 0 ||
      databaseResult.tagPresent !== true ||
      databaseResult.principalPresent !== true
    ) {
      throw new HistoryMigrationError("INVALID_METADATA", "数据库只读依赖校验未通过。");
    }
  } finally {
    await sourceDatabase.close();
  }
  if (await scratchDatabaseExists(inputs.adminUrl, inputs.databaseName)) {
    throw new HistoryMigrationError("INVALID_ARGUMENTS", "临时/验收库已存在，拒绝覆盖。");
  }
  return {
    report,
    scan,
    reconciliation,
    preflightReceiptSha256: receiptRead.sha256,
    packageCount,
    authoritativePackageIdentitySha256,
    authoritativeRevisionIdentitySha256,
    provenance,
  };
}

interface TitleProbeState {
  readonly revisionId: string;
  readonly title: string;
  readonly basicStatement: string;
  readonly basicSolution: string | null;
}

interface TitleProbeRow {
  readonly revision_id: string;
  readonly title: string;
  readonly basic_statement: string;
  readonly basic_solution: string | null;
  readonly [key: string]: unknown;
}

async function readTitleProbeState(database: DatabaseHandle, problemId: string): Promise<TitleProbeState> {
  const rows = await database.query<TitleProbeRow>(
    sql`select pr.id::text as revision_id, pr.title, pr.basic_statement, pr.basic_solution
        from "public"."problems" p
        inner join "public"."problem_revisions" pr
          on pr.problem_id = p.id and pr.revision = p.current_revision
        where p.id = ${problemId}::bigint`,
  );
  if (rows.length !== 1) {
    throw new HistoryMigrationError("INVALID_METADATA", "无法精确定位导入问题的当前修订。");
  }
  return {
    revisionId: rows[0]!.revision_id,
    title: rows[0]!.title,
    basicStatement: rows[0]!.basic_statement,
    basicSolution: rows[0]!.basic_solution,
  };
}

export interface ExecutionSummary {
  readonly firstPass: { readonly imported: number; readonly skipped: number; readonly failed: number };
  readonly replayPass: { readonly imported: number; readonly skipped: number; readonly failed: number };
  readonly postcheck: Phase2PostcheckResult;
  readonly titleProbePassed: boolean;
  readonly nullSolutionCount: number;
  readonly emptySolutionCount: number;
  readonly attachmentCount: number;
  readonly storageInventory: StorageInventory;
  readonly manifestIdentitySha256: string;
  readonly manifestContentBindingsSha256: string;
  readonly firstRevisionInventory: RevisionContentInventory;
  readonly replayRevisionInventory: RevisionContentInventory;
  readonly databaseInventory: DatabaseContentInventory;
}

function revisionInventoryMatchesExpected(
  actual: RevisionContentInventory,
  expected: RevisionContentInventory,
): boolean {
  return (
    actual.revisionCount === expected.revisionCount &&
    actual.nullSolutionCount === expected.nullSolutionCount &&
    actual.emptySolutionCount === expected.emptySolutionCount &&
    actual.fullContentSha256 === expected.fullContentSha256 &&
    actual.frozenContentSha256 === expected.frozenContentSha256 &&
    actual.databaseRowsSha256 === expected.databaseRowsSha256
  );
}

function frozenRevisionInventoryMatchesExpected(
  actual: RevisionContentInventory,
  expected: RevisionContentInventory,
): boolean {
  return (
    actual.revisionCount === expected.revisionCount &&
    actual.nullSolutionCount === expected.nullSolutionCount &&
    actual.emptySolutionCount === expected.emptySolutionCount &&
    actual.frozenContentSha256 === expected.frozenContentSha256
  );
}

/** 临时验收库专用执行授权：每次运行都从数据库重新读取操作员账号状态。 */
function importExecutionAuthorizationFor(database: DatabaseHandle): ImportExecutionAuthorization {
  const store = new DatabaseDataStore(database);
  return new ServiceImportExecutionAuthorization({
    getUser: (userId) => store.getUser(userId),
  });
}
export async function executeImport(
  database: DatabaseHandle,
  inputs: RunnerInputs,
  context: ValidationContext,
  before: readonly HistoryImportCountRow[],
  hooks: Phase2RunnerHooks,
): Promise<ExecutionSummary> {
  const first = await importHistoryPackages({
    privateRootDirectory: inputs.privateRoot,
    packageDirectory: inputs.packageDirectory,
    outputDirectory: inputs.importOutputDirectory,
    dependencies: {
      database,
      requestedByUserId: inputs.principal,
      assignedTagId: inputs.tagId,
      storageRoot: inputs.storageRoot,
      authorization: importExecutionAuthorizationFor(database),
    },
  });
  console.log(
    `第 1 遍聚合: imported=${first.importedCount} skipped=${first.skippedCount} failed=${first.failedCount}`,
  );
  if (
    first.importedCount !== context.packageCount ||
    first.skippedCount !== 0 ||
    first.failedCount !== 0
  ) {
    throw new HistoryMigrationError("INVALID_METADATA", "首遍导入聚合不符合批准数量。");
  }

  const manifestRead = await readPrivateJsonWithDigest(
    join(inputs.importOutputDirectory, importManifestName),
  );
  const manifestIdentitySha256 = verifyProducedManifestIdentity(context.report, manifestRead.value);
  const manifestContentBindingsSha256 = manifestContentBindingsIdentity(context.report, manifestRead.value);
  const manifest = importManifestPayloadSchema.parse(manifestRead.value);
  const identities = manifest.entries.map((entry) => ({
    candidateId: entry.candidateId,
    problemId: entry.problemId,
  }));
  const problemIds = identities.map(({ problemId }) => problemId);
  const uniqueProblemIds = new Set(problemIds);
  if (
    manifest.entries.length !== context.packageCount ||
    manifest.importedCount !== context.packageCount ||
    uniqueProblemIds.size !== context.packageCount
  ) {
    throw new HistoryMigrationError("INVALID_METADATA", "首遍导入清单不完整或包含重复问题身份。");
  }

  const afterFirst = await captureHistoryImportTableCounts(database);
  const firstStoredInventory = await captureStoredFileInventory(database);
  const firstStorageInventory = await captureStorageInventory(inputs.storageRoot);
  const firstRevisionInventory = await captureImportedRevisionContentInventory(database, identities);
  if (
    !revisionInventoryMatchesExpected(
      firstRevisionInventory,
      context.scan.expectedRevisionInventory,
    )
  ) {
    throw new HistoryMigrationError("INVALID_METADATA", "首遍导入的修订内容清单不匹配批准包。");
  }
  await hooks.afterFirstPass?.();

  const probeBefore = await readTitleProbeState(database, problemIds[0]!);
  const editedTitle = `${probeBefore.title} [验收编辑]`;
  const updatedRows = await database.query<TitleProbeRow>(
    sql`update "public"."problem_revisions"
        set title = ${editedTitle}
        where id = ${probeBefore.revisionId}::uuid
        returning id::text as revision_id, title, basic_statement, basic_solution`,
  );
  if (
    updatedRows.length !== 1 ||
    updatedRows[0]!.title !== editedTitle ||
    updatedRows[0]!.basic_statement !== probeBefore.basicStatement ||
    updatedRows[0]!.basic_solution !== probeBefore.basicSolution
  ) {
    throw new HistoryMigrationError("INVALID_METADATA", "标题编辑或冻结内容核对失败。");
  }
  const afterEditRevisionInventory = await captureImportedRevisionContentInventory(
    database,
    identities,
  );
  if (
    !frozenRevisionInventoryMatchesExpected(
      afterEditRevisionInventory,
      context.scan.expectedRevisionInventory,
    ) ||
    afterEditRevisionInventory.fullContentSha256 === firstRevisionInventory.fullContentSha256
  ) {
    throw new HistoryMigrationError("INVALID_METADATA", "标题编辑改变了冻结修订内容或没有生效。");
  }
  const afterEditDatabaseInventory = await captureDatabaseContentInventory(
    database,
    historyImportRequiredTables,
  );

  const replay = await importHistoryPackages({
    privateRootDirectory: inputs.privateRoot,
    packageDirectory: inputs.packageDirectory,
    outputDirectory: inputs.importOutputDirectory,
    dependencies: {
      database,
      requestedByUserId: inputs.principal,
      assignedTagId: inputs.tagId,
      storageRoot: inputs.storageRoot,
      authorization: importExecutionAuthorizationFor(database),
    },
  });
  console.log(
    `重放聚合: imported=${replay.importedCount} skipped=${replay.skippedCount} failed=${replay.failedCount}`,
  );
  const afterReplay = await captureHistoryImportTableCounts(database);
  const replayStoredInventory = await captureStoredFileInventory(database);
  const replayStorageInventory = await captureStorageInventory(inputs.storageRoot);
  const replayRevisionInventory = await captureImportedRevisionContentInventory(database, identities);
  const replayDatabaseInventory = await captureDatabaseContentInventory(
    database,
    historyImportRequiredTables,
  );
  const probeAfterReplay = await readTitleProbeState(database, problemIds[0]!);
  const titleProbePassed =
    probeAfterReplay.revisionId === probeBefore.revisionId &&
    probeAfterReplay.title === editedTitle &&
    probeAfterReplay.basicStatement === probeBefore.basicStatement &&
    probeAfterReplay.basicSolution === probeBefore.basicSolution;
  const solutionStates = await countSolutionStatesForProblems(database, problemIds);
  const attachmentCount = await countRevisionFilesForProblems(database, problemIds);
  const postcheck = verifyPhase2Outcome({
    before,
    afterFirst,
    afterReplay,
    firstPass: {
      imported: first.importedCount,
      skipped: first.skippedCount,
      failed: first.failedCount,
    },
    replayPass: {
      imported: replay.importedCount,
      skipped: replay.skippedCount,
      failed: replay.failedCount,
    },
    expectedPackageCount: context.packageCount,
    expectedAttachmentRows: context.scan.expectedProblemFileRows,
    expectedSampleRows: context.scan.expectedSampleRows,
    expectedJobItemRows: context.packageCount,
    expectedStoredFilesDelta: context.scan.expectedStoredFilesRows,
    expectedAuditDelta: context.packageCount * 2,
    expectedNullSolutionCount: context.scan.expectedRevisionInventory.nullSolutionCount,
    afterNullSolutionCount: solutionStates.nullSolutionCount,
    expectedEmptySolutionCount: context.scan.expectedRevisionInventory.emptySolutionCount,
    afterEmptySolutionCount: solutionStates.emptySolutionCount,
    expectedStoredBytes: context.scan.expectedStoredBytes,
    expectedStoredContentSha256: context.scan.expectedStoredContentSha256,
    afterFirstStoredInventory: firstStoredInventory,
    afterReplayStoredInventory: replayStoredInventory,
  });
  const physicalStorageMatches =
    firstStorageInventory.fileCount === context.scan.expectedStoredFilesRows &&
    firstStorageInventory.totalBytes === context.scan.expectedStoredBytes &&
    firstStorageInventory.contentInventorySha256 === context.scan.expectedStoredContentSha256 &&
    storageInventoriesEqual(firstStorageInventory, replayStorageInventory);
  const replayRevisionMatches =
    frozenRevisionInventoryMatchesExpected(
      replayRevisionInventory,
      context.scan.expectedRevisionInventory,
    ) &&
    replayRevisionInventory.fullContentSha256 === afterEditRevisionInventory.fullContentSha256 &&
    replayRevisionInventory.databaseRowsSha256 ===
      afterEditRevisionInventory.databaseRowsSha256;
  if (
    postcheck.verdict !== "PASS" ||
    !titleProbePassed ||
    !replayRevisionMatches ||
    !databaseContentInventoriesEqual(afterEditDatabaseInventory, replayDatabaseInventory) ||
    attachmentCount !== context.scan.expectedProblemFileRows ||
    !physicalStorageMatches
  ) {
    throw new HistoryMigrationError("INVALID_METADATA", "导入后精确对账失败。");
  }

  return {
    firstPass: {
      imported: first.importedCount,
      skipped: first.skippedCount,
      failed: first.failedCount,
    },
    replayPass: {
      imported: replay.importedCount,
      skipped: replay.skippedCount,
      failed: replay.failedCount,
    },
    postcheck,
    titleProbePassed,
    nullSolutionCount: solutionStates.nullSolutionCount,
    emptySolutionCount: solutionStates.emptySolutionCount,
    attachmentCount,
    storageInventory: replayStorageInventory,
    manifestIdentitySha256,
    manifestContentBindingsSha256,
    firstRevisionInventory,
    replayRevisionInventory,
    databaseInventory: replayDatabaseInventory,
  };
}

async function restoreAndVerify(
  inputs: RunnerInputs,
  connectionString: string,
  baselineCounts: readonly HistoryImportCountRow[],
  baselineStoredInventory: StoredFileInventory,
  baselineDatabaseInventory: DatabaseContentInventory,
  baselineStorageInventory: StorageInventory,
  storageSnapshotDirectory: string,
): Promise<void> {
  const recoveryMarkerPath = join(inputs.receiptDirectory, recoveryMarkerName);
  await writePrivateFile(recoveryMarkerPath, `${new Date().toISOString()}\n`);
  const failures: unknown[] = [];
  let databaseRestored = false;
  let storageRestored = false;
  try {
    await restoreScratchDatabase(
      inputs.adminUrl,
      inputs.databaseName,
      historyImportRequiredTables,
      baselineDatabaseInventory,
    );
    databaseRestored = true;
  } catch (error) {
    failures.push(error);
  }
  try {
    const restoredStorageInventory = await restoreStorageDirectory(
      storageSnapshotDirectory,
      inputs.storageRoot,
      baselineStorageInventory,
    );
    storageRestored = storageInventoriesEqual(
      restoredStorageInventory,
      baselineStorageInventory,
    );
    if (!storageRestored) failures.push(new Error("storage inventory mismatch"));
  } catch (error) {
    failures.push(error);
  }
  if (databaseRestored) {
    const verifyDatabase = createPostgresDatabase({
      connectionString,
      maxConnections: 1,
      applicationName: "urmotiv-history-import-restore-verify",
    });
    try {
      const restoredCounts = await captureHistoryImportTableCounts(verifyDatabase);
      const restoredStoredInventory = await captureStoredFileInventory(verifyDatabase);
      const restoredDatabaseInventory = await captureDatabaseContentInventory(
        verifyDatabase,
        historyImportRequiredTables,
      );
      if (
        !countsEqual(restoredCounts, baselineCounts) ||
        !storedInventoriesEqual(restoredStoredInventory, baselineStoredInventory) ||
        !databaseContentInventoriesEqual(
          restoredDatabaseInventory,
          baselineDatabaseInventory,
        )
      ) {
        failures.push(new Error("database inventory mismatch"));
      }
    } catch (error) {
      failures.push(error);
    } finally {
      await verifyDatabase.close();
    }
  }
  if (!databaseRestored || !storageRestored || failures.length > 0) {
    throw new HistoryMigrationError(
      "INVALID_METADATA",
      "数据库与存储的联合恢复未通过完整内容验证，保留恢复标记与现场。",
    );
  }
  await rm(inputs.importOutputDirectory, { recursive: true, force: true });
  await rm(join(inputs.receiptDirectory, runReceiptName), { force: true });
  await rm(join(inputs.receiptDirectory, runPassMarkerName), { force: true });
  await dropScratchSnapshot(inputs.adminUrl, inputs.databaseName);
  await rm(storageSnapshotDirectory, { recursive: true, force: false });
  await rm(recoveryMarkerPath, { force: false });
}

async function executeBoundRunner(
  argv: readonly string[],
  env: NodeJS.ProcessEnv,
  hooks: Phase2RunnerHooks,
): Promise<number> {
  const inputs = resolveRunnerInputs(argv, env);
  const context = await validateBeforeMutation(inputs, hooks);
  console.log(`批准输入校验: READY; 包数量=${context.packageCount}`);

  const prepared = await prepareHistoryImportDatabase(inputs.adminUrl, inputs.databaseName);
  let baseline: {
    readonly counts: readonly HistoryImportCountRow[];
    readonly storedInventory: StoredFileInventory;
    readonly databaseInventory: DatabaseContentInventory;
  };
  try {
    const baselineDatabase = createPostgresDatabase({
      connectionString: prepared.connectionString,
      maxConnections: 1,
      applicationName: "urmotiv-history-import-baseline",
    });
    try {
      const scratchPostcondition = await runZeroMutationDatabasePreflight(baselineDatabase, {
        requiredTagId: inputs.tagId,
        requiredPrincipalId: inputs.principal,
      });
      if (
        scratchPostcondition.missingTableCount !== 0 ||
        scratchPostcondition.tagPresent !== true ||
        scratchPostcondition.principalPresent !== true
      ) {
        throw new HistoryMigrationError(
          "INVALID_METADATA",
          "新建验收库迁移或种子后置条件失败。",
        );
      }
      const counts = await captureHistoryImportTableCounts(baselineDatabase);
      const storedInventory = await captureStoredFileInventory(baselineDatabase);
      const databaseInventory = await captureDatabaseContentInventory(
        baselineDatabase,
        historyImportRequiredTables,
      );
      if (storedInventory.fileCount !== 0) {
        throw new HistoryMigrationError("INVALID_METADATA", "新建验收库的存储记录不是空集。");
      }
      baseline = { counts, storedInventory, databaseInventory };
    } finally {
      await baselineDatabase.close();
    }
  } catch (error) {
    await dropHistoryImportDatabase(inputs.adminUrl, inputs.databaseName);
    throw error;
  }

  const baselineStorageInventory = await captureStorageInventory(inputs.storageRoot);
  const storageSnapshotDirectory = join(inputs.receiptDirectory, "storage.snapshot");
  try {
    await snapshotScratchDatabase(
      inputs.adminUrl,
      inputs.databaseName,
      historyImportRequiredTables,
      baseline.databaseInventory,
    );
  } catch (error) {
    await dropHistoryImportDatabase(inputs.adminUrl, inputs.databaseName);
    throw error;
  }
  try {
    await snapshotStorageDirectory(inputs.storageRoot, storageSnapshotDirectory);
  } catch (error) {
    await rm(storageSnapshotDirectory, { recursive: true, force: true });
    await dropScratchSnapshot(inputs.adminUrl, inputs.databaseName);
    await dropHistoryImportDatabase(inputs.adminUrl, inputs.databaseName);
    throw error;
  }

  let execution: ExecutionSummary;
  try {
    await hooks.afterSnapshot?.();
    const importDatabase = createPostgresDatabase({
      connectionString: prepared.connectionString,
      maxConnections: 8,
      applicationName: "urmotiv-history-import-phase2",
    });
    try {
      execution = await executeImport(importDatabase, inputs, context, baseline.counts, hooks);
    } finally {
      await importDatabase.close();
    }
  } catch (error) {
    try {
      await restoreAndVerify(
        inputs,
        prepared.connectionString,
        baseline.counts,
        baseline.storedInventory,
        baseline.databaseInventory,
        baselineStorageInventory,
        storageSnapshotDirectory,
      );
    } catch {
      throw new HistoryMigrationError(
        "INVALID_METADATA",
        "第 2 阶段执行失败，联合恢复未通过；现场已保留。",
      );
    }
    throw error;
  }
  const cleanupMarkerPath = join(inputs.receiptDirectory, cleanupMarkerName);
  const cleanupRefusedMarkerPath = join(inputs.receiptDirectory, cleanupRefusedMarkerName);
  const storageRecoveryDirectory = join(inputs.receiptDirectory, "storage.recovery");
  const terminalTrashDirectory = `${storageSnapshotDirectory}.terminal-trash`;
  await writePrivateFile(cleanupMarkerPath, `${new Date().toISOString()}\n`);
  const scratchRecoveryBindingSha256 = sha256Hex(
    `${inputs.databaseName}|${execution.databaseInventory.contentSha256}|${execution.storageInventory.contentInventorySha256}`,
  );
  await startFormalRecoveryState(
    inputs.receiptDirectory,
    scratchRecoveryBindingSha256,
    "scratch_established",
  );
  let terminalDeletionStarted = false;
  try {
    // 换代：新代（数据库 __snapshot_g2 + 存储 storage.snapshot.next）与
    // 旧代并行建立并各自核对；先有已验证的新代，才允许退役旧代。
    // 任何中间失败都至少保留一个已核对成对代，绝不出现销毁空隙。
    await hooks.cleanupFaults?.beforeGenerationReplacement?.();
    await snapshotScratchDatabaseGeneration(
      inputs.adminUrl,
      inputs.databaseName,
      historyImportRequiredTables,
      execution.databaseInventory,
      2,
    );
    await advanceFormalRecoveryPhase(
      inputs.receiptDirectory,
      "scratch_established",
      "scratch_g2_sealed",
    );
    const nextStorageSnapshotDirectory = `${storageSnapshotDirectory}.next`;
    const nextStorageInventory = await snapshotStorageDirectory(
      inputs.storageRoot,
      nextStorageSnapshotDirectory,
    );
    if (!storageInventoriesEqual(nextStorageInventory, execution.storageInventory)) {
      throw new HistoryMigrationError(
        "CLEANUP_FAILED",
        "换代存储快照与导入后现场不一致；两代工件均原样保留。",
      );
    }
    await hooks.cleanupFaults?.afterGenerationSealed?.();
    // 旧代退役：只删规范名快照，然后原子提升存储与数据库新代。
    await advanceFormalRecoveryPhase(
      inputs.receiptDirectory,
      "scratch_g2_sealed",
      "scratch_retiring_g1",
    );
    await dropCanonicalScratchSnapshot(inputs.adminUrl, inputs.databaseName);
    await hooks.cleanupFaults?.afterDatabaseSnapshotRetired?.();
    await rm(storageSnapshotDirectory, { recursive: true, force: false });
    await rename(nextStorageSnapshotDirectory, storageSnapshotDirectory);
    await hooks.cleanupFaults?.afterStorageSnapshotPromoted?.();
    await promoteScratchDatabaseGeneration(inputs.adminUrl, inputs.databaseName, 2);
    await advanceFormalRecoveryPhase(
      inputs.receiptDirectory,
      "scratch_retiring_g1",
      "scratch_g1_retired",
    );
    // 终删前的喊停点：与既有诊断语义一致（工件此时尚未开始删除）。
    await hooks.beforeSnapshotCleanup?.();
    await advanceFormalRecoveryPhase(
      inputs.receiptDirectory,
      "scratch_g1_retired",
      "scratch_terminal_pending",
    );
    terminalDeletionStarted = true;
    // 终删安全协议：先原子把存储快照改名隔离（不产生部分删除），数据库
    // 快照是最后一道可回滚防线。数据库快照删除成功的刹那起，一切后续
    // 失败都属于「已退役待清理」，绝不再报告可回滚的 FAILED 相位。
    await rename(storageSnapshotDirectory, terminalTrashDirectory).catch(
      (renameError: unknown) => {
        if (!isMissingFilesystemEntryError(renameError)) throw renameError;
      },
    );
    await dropScratchSnapshot(inputs.adminUrl, inputs.databaseName);
    await hooks.cleanupFaults?.afterTerminalDatabaseDrop?.();
    await rm(terminalTrashDirectory, { recursive: true, force: false });
    await hooks.cleanupFaults?.beforeTerminalFinalizedWrite?.();
    await advanceFormalRecoveryPhase(
      inputs.receiptDirectory,
      "scratch_terminal_pending",
      "scratch_finalized",
    );
  } catch (error) {
    // 真实的部分删除/换代失败：重建文件系统恢复快照，核对保留的数据库
    // 快照与导入后现场一致，并把核对结果写成只含聚合的安全证据。
    try {
      const stateBefore = await readFormalRecoveryState(inputs.receiptDirectory);
      const databaseSnapshotProbe = await probeScratchSnapshotGeneration(
        inputs.adminUrl,
        inputs.databaseName,
        historyImportRequiredTables,
      );
      const storageCanonicalCapture = await probeStorageCapture(storageSnapshotDirectory);
      const storageNextCapture = await probeStorageCapture(`${storageSnapshotDirectory}.next`);
      const storageTrashCapture = await probeStorageCapture(terminalTrashDirectory);
      const databaseSnapshotMatches =
        databaseSnapshotProbe.inventory !== null &&
        databaseContentInventoriesEqual(
          databaseSnapshotProbe.inventory,
          execution.databaseInventory,
        );
      const storageCanonicalPresent = storageCanonicalCapture.present;
      const storageCanonicalMatches =
        storageCanonicalCapture.inventory === null
          ? null
          : storageInventoriesEqual(storageCanonicalCapture.inventory, execution.storageInventory);
      const storageTrashPresent = storageTrashCapture.present;
      const storageTrashMatches =
        storageTrashCapture.inventory === null
          ? null
          : storageInventoriesEqual(storageTrashCapture.inventory, execution.storageInventory);
      // 只有数据库快照与某个位置的存储快照同时与导入后现场匹配时，终删
      // 失败才允许报告可回滚的 FAILED 相位；否则保持「已退役待清理」，
      // 绝不为已被销毁的成对代谎报可回滚。
      const terminalPairRecoverable =
        terminalDeletionStarted &&
        databaseSnapshotMatches &&
        (storageCanonicalMatches === true || storageTrashMatches === true);
      if (terminalPairRecoverable) {
        await advanceFormalRecoveryPhase(
          inputs.receiptDirectory,
          "scratch_terminal_pending",
          "scratch_terminal_failed",
        ).catch(() => undefined);
      }
      const stateAfter = await readFormalRecoveryState(inputs.receiptDirectory);
      const storageRecovery = await snapshotStorageDirectory(
        inputs.storageRoot,
        storageRecoveryDirectory,
      );
      const storageRecoveryMatches = storageInventoriesEqual(
        storageRecovery,
        execution.storageInventory,
      );
      const maintenanceLiveIdentity = await captureLiveMaintenanceIdentity(inputs.adminUrl).catch(
        () => null,
      );
      await writeNewPrivateJson(join(inputs.receiptDirectory, cleanupRecoveryEvidenceName), {
        version: 1,
        generatedAt: new Date().toISOString(),
        databaseName: inputs.databaseName,
        adminUrlSha256: sha256Hex(`admin-url-v1|${inputs.adminUrl}`),
        scratchRecoveryBindingSha256,
        maintenanceLiveIdentity,
        cleanupRecoveryIdentitySha256:
          maintenanceLiveIdentity === null
            ? ""
            : boundCleanupRecoveryIdentitySha256(scratchRecoveryBindingSha256, maintenanceLiveIdentity),
        recoveryPhase: stateAfter?.phase ?? stateBefore?.phase ?? "scratch_established",
        recoveryStateSha256: stateAfter === undefined ? "" : recoveryStateSha256(stateAfter),
        databaseSnapshotName: databaseSnapshotProbe.name,
        databaseSnapshotMatchesExecution: databaseSnapshotMatches,
        databaseSnapshotContentSha256: databaseSnapshotProbe.inventory?.contentSha256 ?? null,
        executionDatabaseContentSha256: execution.databaseInventory.contentSha256,
        storageCanonicalPresent,
        storageCanonicalMatchesExecution: storageCanonicalMatches,
        storageCanonicalContentSha256: storageCanonicalCapture.inventory?.contentInventorySha256 ?? null,
        storageNextPresent: storageNextCapture.present,
        storageNextMatchesExecution:
          storageNextCapture.inventory === null
            ? null
            : storageInventoriesEqual(storageNextCapture.inventory, execution.storageInventory),
        storageNextContentSha256: storageNextCapture.inventory?.contentInventorySha256 ?? null,
        storageTrashPresent,
        storageTrashMatchesExecution: storageTrashMatches,
        storageTrashContentSha256: storageTrashCapture.inventory?.contentInventorySha256 ?? null,
        terminalRecoveryCapable: terminalPairRecoverable,
        storageRecoveryMatchesExecution: storageRecoveryMatches,
        storageRecoveryFileCount: storageRecovery.fileCount,
        storageRecoveryContentSha256: storageRecovery.contentInventorySha256,
        databaseSnapshotRetained: databaseSnapshotProbe.inventory !== null,
        storageRecoveryRetained: true,
      });
      await writePrivateFile(cleanupRefusedMarkerPath, `${new Date().toISOString()}\n`);
      console.error("快照清理未完成：恢复工件保留与一致性核对已写入证据。");
    } catch {
      throw new HistoryMigrationError(
        "CLEANUP_FAILED",
        "快照清理失败，恢复工件核对未完成；现场已保留。",
      );
    }
    throw new HistoryMigrationError("CLEANUP_FAILED", "验收数据已验证，但快照清理未完成。");
  }
  await rm(cleanupMarkerPath, { force: false });
  const receipt = {
    version: 3,
    generatedAt: new Date().toISOString(),
    targetClass: inputs.targetClass,
    inputBindings: {
      preflightReceiptSha256: context.preflightReceiptSha256,
      batchSha256: context.report.batchSha256,
      sourceBindingsSha256: recomputeSourceBindingsIdentity(context.report),
      authoritativePackageIdentitySha256: context.authoritativePackageIdentitySha256,
      authoritativeRevisionIdentitySha256: context.authoritativeRevisionIdentitySha256,
      manifestIdentitySha256: execution.manifestIdentitySha256,
      manifestContentBindingsSha256: execution.manifestContentBindingsSha256,
      codeInventorySha256: context.provenance.codeInventorySha256,
      codeInventoryEntryCount: context.provenance.codeInventoryEntryCount,
      tagIdSha256: sha256Hex(inputs.tagId),
      gitCommitSha256: sha256Hex(inputs.gitCommit),
      principalSha256: sha256Hex(inputs.principal),
      executionIdSha256: sha256Hex(inputs.executionId),
    },
    packageCount: context.packageCount,
    firstPass: execution.firstPass,
    replayPass: execution.replayPass,
    postcheck: execution.postcheck,
    titleProbePassed: execution.titleProbePassed,
    solutionStates: {
      nullCount: execution.nullSolutionCount,
      emptyCount: execution.emptySolutionCount,
    },
    attachmentCount: execution.attachmentCount,
    storedObjectCount: execution.storageInventory.fileCount,
    storedBytes: execution.storageInventory.totalBytes,
    revisionIntegrity: {
      firstFullContentSha256: execution.firstRevisionInventory.fullContentSha256,
      replayFullContentSha256: execution.replayRevisionInventory.fullContentSha256,
      frozenContentSha256: execution.replayRevisionInventory.frozenContentSha256,
      replayDatabaseRowsSha256: execution.replayRevisionInventory.databaseRowsSha256,
    },
    databaseContentSha256: execution.databaseInventory.contentSha256,
    baselineDatabaseContentSha256: baseline.databaseInventory.contentSha256,
    scratchDatabaseFingerprintSha256: sha256Hex(
      `${inputs.databaseName}|${baseline.databaseInventory.contentSha256}|${execution.databaseInventory.contentSha256}`,
    ),
    verdict: "PASS",
  };
  const receiptPayload = `${JSON.stringify(receipt, null, 2)}\n`;
  await writePrivateFile(join(inputs.receiptDirectory, runReceiptName), receiptPayload);
  await writePrivateFile(
    join(inputs.receiptDirectory, runPassMarkerName),
    `${receipt.generatedAt}\n`,
  );
  // v2 批准书模板：全部确定值就位，操作员只需在带外填充非确定字段
  // （nonce、分支名、正式目标指纹）并放到收据目录之外。占位符不符合
  // 正式门禁结构，机械拒绝，无法原样通过。
  const adminIdentity = (() => {
    const parsed = parsePostgresIdentity(inputs.adminUrl);
    return {
      host: parsed.host,
      port: parsed.port,
      user: parsed.user,
      database: parsed.database,
    };
  })();
  await writeNewPrivateJson(join(inputs.receiptDirectory, targetApprovalTemplateName), {
    version: 2,
    generatedAt: receipt.generatedAt,
    expiresAt: new Date(Date.parse(receipt.generatedAt) + 24 * 60 * 60 * 1000).toISOString(),
    nonce: "<FILL_32_HEX_OUT_OF_BAND>",
    approvedByActorSha256: sha256Hex(`actor-v1|${userInfo().username}`),
    branchName: "<FILL_OPERATOR_BRANCH_OUT_OF_BAND>",
    gitCommitSha256: sha256Hex(inputs.gitCommit),
    expectedFormalImportCount: context.packageCount,
    storageRootIdentitySha256: await computeStorageRootIdentitySha256(inputs.storageRoot),
    prestateDatabaseInventorySha256: baseline.databaseInventory.contentSha256,
    prestateStorageInventorySha256: baselineStorageInventory.contentInventorySha256,
    adminTargetFingerprintSha256: computeFormalAdminFingerprintSha256(adminIdentity),
    preflightReceiptSha256: context.preflightReceiptSha256,
    phase2ReceiptSha256: sha256Hex(receiptPayload),
    scratchDatabaseFingerprintSha256: receipt.scratchDatabaseFingerprintSha256,
    formalTargetFingerprintSha256: "<FILL_FORMAL_TARGET_FINGERPRINT_OUT_OF_BAND>",
  });
  console.log(
    `第 2 阶段验收: PASS; 缺失题解=${execution.nullSolutionCount}; 空题解=${execution.emptySolutionCount}; 附件=${execution.attachmentCount}`,
  );
  return 0;
}


export async function runPhase2Bound(
  argv: readonly string[],
  env: NodeJS.ProcessEnv,
  hooks: Phase2RunnerHooks,
): Promise<number> {
  try {
    return await executeBoundRunner(argv, env, hooks);
  } catch (error: unknown) {
    if (error instanceof HistoryMigrationError) {
      console.error(`第 2 阶段验收失败（${error.code}）。`);
      return error.code === "INVALID_ARGUMENTS" ? 2 : 1;
    }
    console.error("第 2 阶段验收失败（UNCLASSIFIED）。");
    return 1;
  }
}

/**
 * 生产入口：固定空钩子，不提供任何故障注入通道。测试通过
 * tests/history-migration/phase2-runner-harness.ts 直接以依赖注入组合
 * runPhase2Bound，生产 CLI/server 不引用该测试专用模块。
 */
export async function runPhase2Acceptance(
  argv: readonly string[],
  env: NodeJS.ProcessEnv,
): Promise<number> {

  return runPhase2Bound(argv, env, {});
}

/**
 * Gate 5 维护活身份：从活 PostgreSQL 服务器就地采集，任何字段缺失即拒
 * （fail-closed，绝不空串放过）。地址/端口取服务器视角的
 * inet_server_addr()/inet_server_port()，集群指纹取 initdb 生成的
 * system_identifier —— 三者合力能在连接串文本不变的情况下识破
 * 端点改指、端口改指、集群翻新与账户/库名变更。
 */
export interface Phase2LiveMaintenanceIdentity {
  readonly serverAddress: string;
  readonly serverPort: string;
  readonly user: string;
  readonly database: string;
  readonly clusterIdentity: string;
}

export function phase2LiveIdentitySha256(identity: Phase2LiveMaintenanceIdentity): string {
  return sha256Hex(
    JSON.stringify([
      "phase2-live-maintenance-v1",
      identity.serverAddress,
      identity.serverPort,
      identity.user,
      identity.database,
      identity.clusterIdentity,
    ]),
  );
}

export function boundCleanupRecoveryIdentitySha256(
  generationBindingSha256: string,
  liveIdentity: Phase2LiveMaintenanceIdentity,
): string {
  return sha256Hex(
    JSON.stringify([
      "phase2-cleanup-recovery-v1",
      generationBindingSha256,
      phase2LiveIdentitySha256(liveIdentity),
    ]),
  );
}

export async function captureLiveMaintenanceIdentity(
  adminUrl: string,
): Promise<Phase2LiveMaintenanceIdentity> {
  const database = createPostgresDatabase({
    connectionString: adminUrl,
    maxConnections: 1,
    applicationName: "urmotiv-history-live-identity",
  });
  try {
    const rows = await database.query<{
      server_address: string | null;
      server_port: number | null;
      admin_user: string | null;
      admin_database: string | null;
      cluster_identifier: string | null;
    }>(
      sql`select inet_server_addr()::text as server_address, inet_server_port() as server_port,
          current_user as admin_user, current_database() as admin_database,
          system_identifier::text as cluster_identifier
        from pg_control_system()`,
    );
    const row = rows[0];
    if (
      row === undefined ||
      typeof row.server_address !== "string" ||
      row.server_address.length === 0 ||
      typeof row.server_port !== "number" ||
      !Number.isInteger(row.server_port) ||
      typeof row.admin_user !== "string" ||
      row.admin_user.length === 0 ||
      typeof row.admin_database !== "string" ||
      row.admin_database.length === 0 ||
      typeof row.cluster_identifier !== "string" ||
      row.cluster_identifier.length === 0
    ) {
      throw new HistoryMigrationError("INVALID_METADATA", "维护连接的活身份字段不完整，拒绝续做。");
    }
    return {
      serverAddress: row.server_address,
      serverPort: String(row.server_port),
      user: row.admin_user,
      database: row.admin_database,
      clusterIdentity: row.cluster_identifier,
    };
  } catch (error) {
    if (error instanceof HistoryMigrationError) throw error;
    throw new HistoryMigrationError("INVALID_METADATA", "维护连接的活身份无法采集，拒绝续做。");
  } finally {
    await database.close();
  }
}

function verifyCleanupLiveIdentity(
  evidenceRecord: Record<string, unknown>,
  generationBindingSha256: string,
  liveIdentity: Phase2LiveMaintenanceIdentity,
): void {
  const frozen = evidenceRecord.maintenanceLiveIdentity;
  if (typeof frozen !== "object" || frozen === null || Array.isArray(frozen)) {
    throw new HistoryMigrationError("INVALID_METADATA", "终删中断证据缺少维护活身份绑定，拒绝续做。");
  }
  const record = frozen as Record<string, unknown>;
  const fields: readonly [keyof Phase2LiveMaintenanceIdentity, string][] = [
    ["serverAddress", "服务器地址"],
    ["serverPort", "服务器端口"],
    ["user", "认证用户"],
    ["database", "当前数据库"],
    ["clusterIdentity", "集群指纹"],
  ];
  for (const [field, label] of fields) {
    if (typeof record[field] !== "string" || (record[field] as string).length === 0) {
      throw new HistoryMigrationError(
        "INVALID_METADATA",
        `中断证据维护活身份缺少字段 ${label}，拒绝续做。`,
      );
    }
    if (record[field] !== liveIdentity[field]) {
      throw new HistoryMigrationError(
        "INVALID_METADATA",
        `维护活身份字段 ${label} 与中断证据不一致，拒绝续做。`,
      );
    }
  }
  const frozenDigest =
    typeof evidenceRecord.cleanupRecoveryIdentitySha256 === "string"
      ? evidenceRecord.cleanupRecoveryIdentitySha256
      : "";
  const expectedDigest = boundCleanupRecoveryIdentitySha256(generationBindingSha256, liveIdentity);
  if (frozenDigest.length === 0 || frozenDigest !== expectedDigest) {
    throw new HistoryMigrationError(
      "INVALID_METADATA",
      "维护活身份绑定摘要与中断证据不一致，拒绝续做。",
    );
  }
}

/**
 * 第 2 阶段终删中断（scratch_terminal_failed / scratch_terminal_pending）的
 * 幂等续做。先按中断证据核对数据库名、管理员连接与记账代绑定，再以
 * 「存储隔离改名 -> 数据库快照删除 -> 隔离清理 -> 终态写盘」的顺序续做；
 * 数据库快照删除之后的一切失败保持「已退役待清理」相位，绝不谎报可回滚。
 * 任何中间失败均保留相位，可安全重试。
 */
export async function completePhase2TerminalCleanup(args: {
  readonly receiptDirectory: string;
  readonly adminUrl: string;
  readonly databaseName: string;
}): Promise<{ readonly phase: FormalRecoveryPhase }> {
  assertScratchDatabaseName(args.databaseName);
  const state = await readFormalRecoveryState(args.receiptDirectory);
  if (state === undefined) {
    throw new HistoryMigrationError("INVALID_METADATA", "恢复状态机尚未建立，无法续做终删。");
  }
  if (
    state.phase !== "scratch_terminal_failed" &&
    state.phase !== "scratch_terminal_pending" &&
    state.phase !== "scratch_finalized"
  ) {
    throw new HistoryMigrationError(
      "INVALID_METADATA",
      `恢复状态机相位 ${state.phase} 不允许续做第 2 阶段终删。`,
    );
  }
  const evidencePath = join(args.receiptDirectory, cleanupRecoveryEvidenceName);
  const evidence = await readPrivateJson(evidencePath).catch(() => undefined);
  if (evidence === undefined) {
    throw new HistoryMigrationError("INVALID_METADATA", "缺少终删中断证据，拒绝续做。");
  }
  const evidenceRecord =
    typeof evidence === "object" && evidence !== null
      ? (evidence as Record<string, unknown>)
      : undefined;
  if (evidenceRecord === undefined) {
    throw new HistoryMigrationError("INVALID_METADATA", "终删中断证据格式损坏，拒绝续做。");
  }
  if (evidenceRecord.databaseName !== args.databaseName) {
    throw new HistoryMigrationError("INVALID_METADATA", "终删中断证据的数据库名不匹配，拒绝续做。");
  }
  if (evidenceRecord.adminUrlSha256 !== sha256Hex(`admin-url-v1|${args.adminUrl}`)) {
    throw new HistoryMigrationError("INVALID_METADATA", "续做管理员连接与中断证据不匹配，拒绝续做。");
  }
  const evidencePhase =
    typeof evidenceRecord.recoveryPhase === "string" ? evidenceRecord.recoveryPhase : "";
  const evidencePhaseValid =
    evidencePhase === "scratch_terminal_pending" ||
    evidencePhase === "scratch_terminal_failed" ||
    evidencePhase === "scratch_finalized";
  const evidencePhaseMatchesLive =
    state.phase === "scratch_finalized"
      ? evidencePhase === "scratch_terminal_pending" || evidencePhase === "scratch_terminal_failed"
      : evidencePhase === state.phase;
  if (!evidencePhaseValid || !evidencePhaseMatchesLive) {
    throw new HistoryMigrationError(
      "INVALID_METADATA",
      "终删中断证据的恢复相位与状态机不一致，拒绝续做。",
    );
  }
  // Gate 5：任何删除动作之前，先核对中断证据与活恢复状态机的世代绑定 —
  // 世代绑定摘要与按当前绑定重构的恢复状态摘要都必须在案，缺失即拒绝。
  if (
    typeof evidenceRecord.scratchRecoveryBindingSha256 !== "string" ||
    !digestPattern.test(evidenceRecord.scratchRecoveryBindingSha256) ||
    evidenceRecord.scratchRecoveryBindingSha256 !== state.generationBindingSha256
  ) {
    throw new HistoryMigrationError(
      "INVALID_METADATA",
      "终删中断证据与当前恢复世代绑定不一致，拒绝续做。",
    );
  }
  const expectedRecoveryDigest = recoveryStateSha256({
    version: 1,
    phase: evidencePhase as FormalRecoveryPhase,
    generationBindingSha256: state.generationBindingSha256,
    updatedAt: state.updatedAt,
  });
  if (
    typeof evidenceRecord.recoveryStateSha256 !== "string" ||
    evidenceRecord.recoveryStateSha256 !== expectedRecoveryDigest
  ) {
    throw new HistoryMigrationError(
      "INVALID_METADATA",
      "终删中断证据的恢复状态摘要与状态机不匹配，拒绝续做。",
    );
  }
  // 任何删除动作之前建立新活连接并核对维护活身份（Gate 5）：服务器地址/
  // 端口/用户/数据库/集群指纹逐字段与证据冻结值一致，且绑定摘要匹配；
  // 错服务器、错端口、错用户、错库、端点改指、字段缺失或篡改一律零效果拒绝。
  const liveIdentity = await captureLiveMaintenanceIdentity(args.adminUrl);
  verifyCleanupLiveIdentity(evidenceRecord, state.generationBindingSha256, liveIdentity);
  // 已终删（scratch_finalized）重放：身份、世代绑定与恢复状态摘要全部
  // 核对通过（含活身份）才幂等成功。
  if (state.phase === "scratch_finalized") {
    return { phase: "scratch_finalized" };
  }
  const expectedDatabaseSha =
    typeof evidenceRecord.executionDatabaseContentSha256 === "string"
      ? evidenceRecord.executionDatabaseContentSha256
      : "";
  const expectedStorageSha =
    typeof evidenceRecord.storageRecoveryContentSha256 === "string"
      ? evidenceRecord.storageRecoveryContentSha256
      : "";
  if (expectedDatabaseSha === "" || expectedStorageSha === "") {
    throw new HistoryMigrationError("INVALID_METADATA", "终删中断证据缺少执行内容哈希，拒绝续做。");
  }
  const canonicalDirectory = join(args.receiptDirectory, "storage.snapshot");
  const trashDirectory = `${canonicalDirectory}.terminal-trash`;
  const nextDirectory = `${canonicalDirectory}.next`;
  const databaseProbe = await probeScratchSnapshotGeneration(
    args.adminUrl,
    args.databaseName,
    historyImportRequiredTables,
  );
  const canonicalProbe = await captureStorageInventoryIfPresent(canonicalDirectory);
  const trashProbe = await captureStorageInventoryIfPresent(trashDirectory);
  const databaseMatches =
    databaseProbe.inventory !== null &&
    databaseProbe.inventory.contentSha256 === expectedDatabaseSha;
  if (databaseProbe.inventory !== null && !databaseMatches) {
    throw new HistoryMigrationError("INVALID_METADATA", "数据库快照与中断证据不匹配，拒绝续做。");
  }
  const canonicalMatches = canonicalProbe?.contentInventorySha256 === expectedStorageSha;
  const trashMatches = trashProbe?.contentInventorySha256 === expectedStorageSha;
  // 数据库快照仍在（可回滚路径）时，隔离目录扮演「第二份成对代」，
  // 内容必须与执行现场一致；数据库快照已删（仅残留清理）时，隔离目录
  // 内容已无核对意义，续做目标就是清空该保留名。
  if (canonicalProbe !== null && !canonicalMatches) {
    throw new HistoryMigrationError("INVALID_METADATA", "规范存储快照与中断证据不匹配，拒绝续做。");
  }
  if (trashProbe !== null && databaseProbe.inventory !== null && !trashMatches) {
    throw new HistoryMigrationError("INVALID_METADATA", "隔离存储与中断证据不匹配，拒绝续做。");
  }
  // 可回滚相位必须同时拥有匹配的数据库快照与匹配的存储快照，否则是
  // 相位谎报或现场损坏，零效果拒绝。
  if (state.phase === "scratch_terminal_failed" && !databaseMatches) {
    throw new HistoryMigrationError(
      "INVALID_METADATA",
      "终删失败相位缺少匹配的数据库快照，拒绝续做。",
    );
  }
  if (state.phase === "scratch_terminal_failed" && !canonicalMatches && !trashMatches) {
    throw new HistoryMigrationError(
      "INVALID_METADATA",
      "终删失败相位缺少匹配的存储快照，拒绝续做。",
    );
  }
  // 先救回隔离存储：数据库快照仍在时优先恢复成对代，再按协议删除。
  if (canonicalProbe === null && trashProbe !== null && databaseMatches) {
    await rename(trashDirectory, canonicalDirectory);
  }
  const canonicalNow = await captureStorageInventoryIfPresent(canonicalDirectory);
  if (canonicalNow !== null) {
    await rename(canonicalDirectory, trashDirectory).catch((renameError: unknown) => {
      if (!isMissingFilesystemEntryError(renameError)) throw renameError;
    });
  }
  // 数据库快照是最后一道可回滚防线；此后失败不回滚、只续做清理。
  if (databaseProbe.inventory !== null) {
    await dropScratchSnapshot(args.adminUrl, args.databaseName);
  }
  const trashNow = await captureStorageInventoryIfPresent(trashDirectory);
  if (trashNow !== null) {
    await rm(trashDirectory, { recursive: true, force: false });
  }
  await dropScratchSnapshotGeneration(args.adminUrl, args.databaseName, 2);
  await rm(nextDirectory, { recursive: true, force: true });
  const finalized = await advanceFormalRecoveryPhase(
    args.receiptDirectory,
    state.phase,
    "scratch_finalized",
  );
  await rm(join(args.receiptDirectory, cleanupRefusedMarkerName), { force: true });
  return { phase: finalized.phase };
}
