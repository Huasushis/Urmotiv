/**
 * 第 2 阶段验收导入 runner：只允许新建临时/验收库；真实目标一概拒绝。
 * 所有身份、摘要、路径和连接串均由命令行指定的环境变量读取。
 */
import { dirname, join } from "node:path";
import { rm } from "node:fs/promises";

import { sql } from "drizzle-orm";
import { z } from "zod";
import { createPostgresDatabase, type DatabaseHandle } from "@urmotiv/database";

import { sha256Hex } from "../src/history-migration/digests";
import { HistoryMigrationError } from "../src/history-migration/errors";
import {
  dropHistoryImportDatabase,
  importHistoryPackages,
  importManifestPayloadSchema,
  packageReportPayloadSchema,
  prepareHistoryImportDatabase,
} from "../src/history-migration/import-phase";
import {
  verifyApprovedPackageSourceIdentities,
  type VerifyApprovedPackageSourceIdentitiesOptions,
} from "../src/history-migration/core";
import {
  bindAuthoritativePackageIdentities,
  bindAuthoritativeRevisionContent,
  verifyProducedManifestIdentity,
  historyImportRequiredTables,
  reconcileHistoryImportBatch,
  recomputeSourceBindingsIdentity,
  runZeroMutationDatabasePreflight,
  scanPackageDirectory,
  type HistoryImportReconciliation,
  type PackageScanResult,
} from "../src/history-migration/import-preflight";
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
} from "../src/history-migration/phase2-postcheck";
import {
  captureImportedRevisionContentInventory,
  type RevisionContentInventory,
} from "../src/history-migration/revision-integrity";
import {
  captureDatabaseContentInventory,
  captureStorageInventory,
  databaseContentInventoriesEqual,
  dropScratchSnapshot,
  restoreScratchDatabase,
  restoreStorageDirectory,
  snapshotScratchDatabase,
  snapshotStorageDirectory,
  storageInventoriesEqual,
  type DatabaseContentInventory,
  type StorageInventory,
} from "../src/history-migration/history-import-snapshot";
import {
  assertNewOutputPath,
  assertPathsInsidePrivateRoot,
  assertPrivateDirectoryMode,
  privateRegularFileExists,
  readPrivateJsonWithDigest,
  writePrivateFile,
} from "../src/history-migration/private-files";
import {
  assertPermittedPhase2EvidenceRoot,
  verifyExecutionProvenance,
  type ExecutionProvenance,
} from "../src/history-migration/execution-provenance";
import { preflightPassMarkerName } from "./preflight-history-import";

const allowedTargetClasses = ["scratch-temporary", "designated-validation", "designated-real"] as const;
type TargetClass = (typeof allowedTargetClasses)[number];
const digestPattern = /^[a-f0-9]{64}$/;
const importManifestName = "import-manifest.private.json";
const runReceiptName = "phase2-run-receipt.private.json";
const runPassMarkerName = "PHASE2_RUN_PASS";
const recoveryMarkerName = "PHASE2_RECOVERY_IN_PROGRESS";

interface RunnerInputs {
  readonly privateRoot: string;
  readonly packageDirectory: string;
  readonly listMetadata: string;
  readonly groupingFile: string;
  readonly materializedDirectory: string;
  readonly preparedDirectory: string;
  readonly approvalFile: string;
  readonly preflightReceipt: string;
  readonly receiptDirectory: string;
  readonly storageRoot: string;
  readonly importOutputDirectory: string;
  readonly adminUrl: string;
  readonly databaseName: string;
  readonly principal: string;
  readonly tagId: string;
  readonly gitCommit: string;
  readonly expectedBatchSha256: string;
  readonly expectedSourceBindingsSha256: string;
  readonly expectedPreflightReceiptSha256: string;
  readonly executionId: string;
  readonly targetClass: TargetClass;
}

export interface Phase2RunnerHooks {
  readonly afterSnapshot?: (() => Promise<void>) | undefined;
  readonly afterFirstPass?: (() => Promise<void>) | undefined;
  readonly beforeSnapshotCleanup?: (() => Promise<void>) | undefined;
  readonly verifyProvenance?: ((commit: string) => Promise<ExecutionProvenance>) | undefined;
  readonly verifySourceIdentities?:
    | ((
        options: VerifyApprovedPackageSourceIdentitiesOptions,
      ) => ReturnType<typeof verifyApprovedPackageSourceIdentities>)
    | undefined;
}

function environmentValue(
  values: ReadonlyMap<string, string>,
  env: NodeJS.ProcessEnv,
  name: string,
): string {
  const variableName = values.get(name);
  if (variableName === undefined || variableName.length === 0) {
    throw new HistoryMigrationError("INVALID_ARGUMENTS", `缺少必填参数 ${name}。`);
  }
  const value = env[variableName];
  if (value === undefined || value.trim().length === 0) {
    throw new HistoryMigrationError("INVALID_ARGUMENTS", `${name} 指定的环境变量未设置。`);
  }
  return value;
}

export function resolveRunnerInputs(
  argv: readonly string[],
  env: NodeJS.ProcessEnv,
): RunnerInputs {
  const values = new Map<string, string>();
  for (const argument of argv) {
    const match = /^--([a-z0-9-]+)=(.*)$/s.exec(argument);
    if (match === null || match[1] === undefined || match[2] === undefined) {
      throw new HistoryMigrationError("INVALID_ARGUMENTS", "runner 参数必须是 --名称=值 形式。");
    }
    if (values.has(match[1])) {
      throw new HistoryMigrationError("INVALID_ARGUMENTS", "命令行参数重复。");
    }
    values.set(match[1], match[2]);
  }
  const targetClassRaw = environmentValue(values, env, "target-class-env");
  const allowedKeys = new Set([
    "private-root-env",
    "package-directory-env",
    "list-metadata-env",
    "grouping-file-env",
    "materialized-directory-env",
    "prepared-directory-env",
    "approval-file-env",
    "preflight-receipt-env",
    "receipt-directory-env",
    "storage-root-env",
    "import-output-directory-env",
    "admin-url-env",
    "db-name-env",
    "principal-env",
    "tag-id-env",
    "git-commit-env",
    "batch-sha256-env",
    "source-bindings-sha256-env",
    "preflight-receipt-sha256-env",
    "execution-id-env",
    "target-class-env",
  ]);
  for (const key of values.keys()) {
    if (!allowedKeys.has(key)) {
      throw new HistoryMigrationError("INVALID_ARGUMENTS", "命令行包含未批准的参数。");
    }
  }
  if (!allowedTargetClasses.includes(targetClassRaw as TargetClass)) {
    throw new HistoryMigrationError("INVALID_ARGUMENTS", "target-class 环境变量值不合法。");
  }
  if (targetClassRaw === "designated-real") {
    throw new HistoryMigrationError("INVALID_ARGUMENTS", "第 2 阶段禁止真实目标导入。");
  }
  const expectedBatchSha256 = environmentValue(values, env, "batch-sha256-env");
  const expectedSourceBindingsSha256 = environmentValue(values, env, "source-bindings-sha256-env");
  const expectedPreflightReceiptSha256 = environmentValue(
    values,
    env,
    "preflight-receipt-sha256-env",
  );
  if (
    !digestPattern.test(expectedBatchSha256) ||
    !digestPattern.test(expectedSourceBindingsSha256) ||
    !digestPattern.test(expectedPreflightReceiptSha256)
  ) {
    throw new HistoryMigrationError("INVALID_ARGUMENTS", "批准摘要环境变量值不合法。");
  }
  const databaseName = environmentValue(values, env, "db-name-env");
  assertScratchDatabaseName(databaseName);
  return {
    privateRoot: environmentValue(values, env, "private-root-env"),
    packageDirectory: environmentValue(values, env, "package-directory-env"),
    listMetadata: environmentValue(values, env, "list-metadata-env"),
    groupingFile: environmentValue(values, env, "grouping-file-env"),
    materializedDirectory: environmentValue(values, env, "materialized-directory-env"),
    preparedDirectory: environmentValue(values, env, "prepared-directory-env"),
    approvalFile: environmentValue(values, env, "approval-file-env"),
    preflightReceipt: environmentValue(values, env, "preflight-receipt-env"),
    receiptDirectory: environmentValue(values, env, "receipt-directory-env"),
    storageRoot: environmentValue(values, env, "storage-root-env"),
    importOutputDirectory: environmentValue(values, env, "import-output-directory-env"),
    adminUrl: environmentValue(values, env, "admin-url-env"),
    databaseName,
    principal: environmentValue(values, env, "principal-env"),
    tagId: environmentValue(values, env, "tag-id-env"),
    gitCommit: environmentValue(values, env, "git-commit-env"),
    expectedBatchSha256,
    expectedSourceBindingsSha256,
    expectedPreflightReceiptSha256,
    executionId: environmentValue(values, env, "execution-id-env"),
    targetClass: targetClassRaw as TargetClass,
  };
}

const countRowSchema = z.object({ table: z.string(), rows: z.number().int().min(0) }).strict();
const preflightReceiptSchema = z
  .object({
    version: z.literal(3),
    targetClass: z.enum(allowedTargetClasses),
    inputBindings: z
      .object({
        listMetadataSha256: z.string().regex(digestPattern),
        packageReportSha256: z.string().regex(digestPattern),
        groupingSha256: z.string().regex(digestPattern),
        importManifestSha256: z.string().regex(digestPattern).optional(),
        batchSha256: z.string().regex(digestPattern),
        sourceBindingsSha256: z.string().regex(digestPattern),
        authoritativePackageIdentitySha256: z.string().regex(digestPattern),
        authoritativeRevisionIdentitySha256: z.string().regex(digestPattern),
        codeInventoryEntryCount: z.number().int().positive(),
        codeInventorySha256: z.string().regex(digestPattern),
        tagIdSha256: z.string().regex(digestPattern),
        gitCommitSha256: z.string().regex(digestPattern),
        principalSha256: z.string().regex(digestPattern),
        executionIdSha256: z.string().regex(digestPattern),
      })
      .strict(),
    authoritativeContentMatches: z.literal(true),
    approvedInputMatches: z.literal(true),
    reconciliation: z
      .object({
        verdict: z.literal("READY"),
        listRecordCount: z.number().int().min(0),
        packageCount: z.number().int().min(0),
        embeddedAttachmentCount: z.number().int().min(0),
        missingBasicSolutionCount: z.number().int().min(0),
        batchIdentityMatches: z.literal(true),
        reasonCodes: z.array(z.string()).length(0),
      })
      .passthrough(),
    packagesChecked: z.number().int().min(0),
    packageScan: z
      .object({
        missingPackageFileCount: z.literal(0),
        packageBytesMismatchCount: z.literal(0),
        packageDigestMismatchCount: z.literal(0),
        unreportedExtraPackageCount: z.literal(0),
        expectedSampleRows: z.number().int().min(0),
        expectedProblemFileRows: z.number().int().min(0),
        expectedStoredFilesRows: z.number().int().min(0),
        expectedStoredBytes: z.number().int().min(0),
        expectedStoredContentSha256: z.string().regex(digestPattern),
        expectedRevisionInventory: z
          .object({
            revisionCount: z.number().int().min(0),
            nullSolutionCount: z.number().int().min(0),
            emptySolutionCount: z.number().int().min(0),
            fullContentSha256: z.string().regex(digestPattern),
            frozenContentSha256: z.string().regex(digestPattern),
          })
          .strict(),
      })
      .strict(),
    database: z
      .object({
        readOnlyEnforced: z.literal(true),
        presentTableCount: z.number().int().min(0),
        missingTableCount: z.literal(0),
        requiredTableCount: z.number().int().min(0),
        rowCounts: z.array(countRowSchema),
        tagPresent: z.literal(true),
        principalPresent: z.literal(true),
      })
      .passthrough(),
    verdict: z.literal("READY"),
  })
  .passthrough();

type PreflightReceipt = z.infer<typeof preflightReceiptSchema>;

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

interface ValidationContext {
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

interface ExecutionSummary {
  readonly firstPass: { readonly imported: number; readonly skipped: number; readonly failed: number };
  readonly replayPass: { readonly imported: number; readonly skipped: number; readonly failed: number };
  readonly postcheck: Phase2PostcheckResult;
  readonly titleProbePassed: boolean;
  readonly nullSolutionCount: number;
  readonly emptySolutionCount: number;
  readonly attachmentCount: number;
  readonly storageInventory: StorageInventory;
  readonly manifestIdentitySha256: string;
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
    actual.frozenContentSha256 === expected.frozenContentSha256
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

async function executeImport(
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

  await hooks.beforeSnapshotCleanup?.();
  await dropScratchSnapshot(inputs.adminUrl, inputs.databaseName);
  await rm(storageSnapshotDirectory, { recursive: true, force: false });
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
    verdict: "PASS",
  };
  await writePrivateFile(
    join(inputs.receiptDirectory, runReceiptName),
    `${JSON.stringify(receipt, null, 2)}\n`,
  );
  await writePrivateFile(
    join(inputs.receiptDirectory, runPassMarkerName),
    `${receipt.generatedAt}\n`,
  );
  console.log(
    `第 2 阶段验收: PASS; 缺失题解=${execution.nullSolutionCount}; 空题解=${execution.emptySolutionCount}; 附件=${execution.attachmentCount}`,
  );
  return 0;
}

export async function runPhase2Acceptance(
  argv: readonly string[],
  env: NodeJS.ProcessEnv,
  hooks: Phase2RunnerHooks = {},
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

if (import.meta.url === `file://${process.argv[1]}`) {
  runPhase2Acceptance(process.argv.slice(2), process.env).then((code) => {
    process.exitCode = code;
  });
}

export type { RunnerInputs, TargetClass };
