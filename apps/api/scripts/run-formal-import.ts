/**
 * 正式（designated-real）历史导入入口：唯一允许改变真实数据库的入口。
 * 全部门禁（收据、密码学绑定、带外批准书、目标身份指纹）都在任何数据库或
 * 文件写入之前完成；任何一项不一致都机械拒绝，绝不绕过第 1/2 阶段验收。
 *
 * 导入采用单遍执行：不做临时库式两遍导入/回放，不跑标题编辑探针，
 * 不修改任何已批准标题或内容；导入后自证核对证明结果与批准清单逐项相等。
 *
 * 突变前必须先建立并核对一组匹配的 DB+存储备份；任何失败都回滚两者、
 * 核对回滚结果，并保留只含聚合的安全标记/收据。回滚不可证明时机械拒绝。
 */
import { chmod, mkdir, rm } from "node:fs/promises";
import { dirname, join } from "node:path";

import { sql } from "drizzle-orm";
import { createPostgresDatabase, type DatabaseHandle } from "@urmotiv/database";
import type { FileStorage } from "@urmotiv/storage";
import { z } from "zod";

import { sha256Hex } from "../src/history-migration/digests";
import { HistoryMigrationError } from "../src/history-migration/errors";
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
} from "../src/history-migration/import-preflight";
import { verifyApprovedPackageSourceIdentities } from "../src/history-migration/core";
import {
  importHistoryPackages,
  importManifestPayloadSchema,
  packageReportPayloadSchema,
} from "../src/history-migration/import-phase";
import {
  captureHistoryImportTableCounts,
  captureStoredFileInventory,
  countRevisionFilesForProblems,
  countSolutionStatesForProblems,
  expectedTableDeltas,
  scratchDatabaseNamePattern,
  type HistoryImportCountRow,
  type SolutionStateCounts,
  type StoredFileInventory,
} from "../src/history-migration/phase2-postcheck";
import {
  captureDatabaseContentInventory,
  captureStorageInventory,
  databaseContentInventoriesEqual,
  restoreStorageDirectory,
  snapshotStorageDirectory,
  storageInventoriesEqual,
  type DatabaseContentInventory,
  type StorageInventory,
} from "../src/history-migration/history-import-snapshot";
import {
  captureImportedRevisionContentInventory,
  type RevisionContentInventory,
} from "../src/history-migration/revision-integrity";
import {
  assertNewOutputPath,
  assertPathsInsidePrivateRoot,
  assertPrivateDirectoryMode,
  readPrivateJsonWithDigest,
  writeNewPrivateJson,
  writePrivateFile,
} from "../src/history-migration/private-files";
import {
  assertPermittedPhase2EvidenceRoot,
  verifyExecutionProvenance,
  type ExecutionProvenance,
} from "../src/history-migration/execution-provenance";
import {
  assertSyntheticFormalSeamAllowed,
  assertTestSeamRuntime,
} from "../src/history-migration/test-seam";
import {
  phase2RunReceiptSchema,
  preflightReceiptSchema,
  type Phase2RunReceipt,
  type PreflightReceipt,
  type ValidationContext,
} from "./run-real-import";
import { preflightReceiptName, runHistoryImportPreflight } from "./preflight-history-import";

const digestPattern = /^[a-f0-9]{64}$/;
const formalDatabaseNamePattern = /^[a-z][a-z0-9_]{0,47}$/;
const formalReceiptName = "formal-import-receipt.private.json";
const formalPassMarkerName = "FORMAL_IMPORT_PASS";
const formalBackupVerifiedMarkerName = "FORMAL_BACKUP_VERIFIED";
const formalRollbackVerifiedMarkerName = "FORMAL_ROLLBACK_VERIFIED";
const formalRestoreRefusedMarkerName = "FORMAL_RESTORE_REFUSED";
const formalBackupEvidenceName = "formal-backup-evidence.private.json";
const formalRollbackEvidenceName = "formal-rollback-evidence.private.json";
const formalStorageSnapshotName = "formal.storage.before.snapshot";
const formalDatabaseBackupSuffix = "__formal_backup";
const importManifestFileName = "import-manifest.private.json";

/** 带外批准书：操作员在收据目录之外提供，正式命令只读、不自证。 */
export const formalTargetApprovalSchema = z
  .object({
    version: z.literal(1),
    generatedAt: z.string().min(1).optional(),
    preflightReceiptSha256: z.string().regex(digestPattern),
    phase2ReceiptSha256: z.string().regex(digestPattern),
    scratchDatabaseFingerprintSha256: z.string().regex(digestPattern),
    formalTargetFingerprintSha256: z.string().regex(digestPattern),
  })
  .strict();

export type FormalTargetApproval = z.infer<typeof formalTargetApprovalSchema>;

export interface FormalTargetIdentity {
  readonly host: string;
  readonly port: string;
  readonly user: string;
  readonly database: string;
}

/** 正式目标身份指纹；任何字段都改变摘要。命令绝不打印指纹或连接细节。 */
export function computeFormalTargetFingerprintSha256(target: FormalTargetIdentity): string {
  const parts = [target.user, target.host, target.port, target.database];
  return sha256Hex(
    parts.map((part) => `${part.length}:${part}`).join("|") + "|formal-target-v1",
  );
}

interface FormalInputs {
  readonly privateRoot: string;
  readonly packageDirectory: string;
  readonly listMetadata: string;
  readonly groupingFile: string;
  readonly materializedDirectory: string;
  readonly preparedDirectory: string;
  readonly approvalFile: string;
  readonly preflightReceipt: string;
  readonly phase2Receipt: string;
  readonly targetApprovalFile: string;
  readonly outputDirectory: string;
  readonly storageRoot: string;
  readonly importOutputDirectory: string;
  readonly databaseUrl: string;
  readonly adminUrl: string;
  readonly databaseName: string;
  readonly target: FormalTargetIdentity;
  readonly principal: string;
  readonly tagId: string;
  readonly gitCommit: string;
  readonly executionId: string;
  readonly expectedBatchSha256: string;
  readonly expectedSourceBindingsSha256: string;
}

export interface FormalImportHooks {
  readonly verifyProvenance?: ((commit: string) => Promise<ExecutionProvenance>) | undefined;
  readonly runPreflight?: ((argv: readonly string[], env: NodeJS.ProcessEnv) => Promise<number>)
  | undefined;
}

/** 仅测试缝可注入的故障面；正式导出入口不接受任何此类参数。 */
export interface FormalImportTestSeam {
  readonly storage?: FileStorage | undefined;
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

export function assertFormalDatabaseName(name: string): void {
  if (!formalDatabaseNamePattern.test(name) || scratchDatabaseNamePattern.test(name)) {
    throw new HistoryMigrationError(
      "INVALID_ARGUMENTS",
      "正式目标库名不合法：不允许临时/验收命名范围。",
    );
  }
}

function parsePostgresTarget(raw: string, role: "target" | "admin"): FormalTargetIdentity & {
  readonly database: string;
} {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new HistoryMigrationError("INVALID_ARGUMENTS", "数据库连接串不合法。");
  }
  if (!parsed.protocol.startsWith("postgres")) {
    throw new HistoryMigrationError("INVALID_ARGUMENTS", "数据库连接串不合法。");
  }
  const database = decodeURIComponent(parsed.pathname.replace(/^\//, ""));
  if (database.length === 0) {
    throw new HistoryMigrationError("INVALID_ARGUMENTS", "数据库连接串不合法。");
  }
  return {
    host: parsed.hostname,
    port: parsed.port === "" ? "5432" : parsed.port,
    user: decodeURIComponent(parsed.username),
    database,
  };
}

export function resolveFormalInputs(
  argv: readonly string[],
  env: NodeJS.ProcessEnv,
): FormalInputs {
  const values = new Map<string, string>();
  for (const argument of argv) {
    const match = /^--([a-z0-9-]+)=(.*)$/s.exec(argument);
    if (match === null || match[1] === undefined || match[2] === undefined) {
      throw new HistoryMigrationError("INVALID_ARGUMENTS", "正式导入参数必须是 --名称=值 形式。");
    }
    if (values.has(match[1])) {
      throw new HistoryMigrationError("INVALID_ARGUMENTS", "命令行参数重复。");
    }
    values.set(match[1], match[2]);
  }
  const allowedKeys = new Set([
    "private-root-env",
    "package-directory-env",
    "list-metadata-env",
    "grouping-file-env",
    "materialized-directory-env",
    "prepared-directory-env",
    "approval-file-env",
    "preflight-receipt-env",
    "phase2-receipt-env",
    "target-approval-env",
    "output-directory-env",
    "storage-root-env",
    "import-output-directory-env",
    "database-url-env",
    "admin-url-env",
    "principal-env",
    "tag-id-env",
    "git-commit-env",
    "execution-id-env",
    "target-class-env",
    "batch-sha256-env",
    "source-bindings-sha256-env",
  ]);
  for (const key of values.keys()) {
    if (!allowedKeys.has(key)) {
      throw new HistoryMigrationError("INVALID_ARGUMENTS", "命令行包含未批准的参数。");
    }
  }
  const targetClass = environmentValue(values, env, "target-class-env");
  if (targetClass !== "designated-real") {
    throw new HistoryMigrationError(
      "INVALID_ARGUMENTS",
      "正式导入只接受 target-class=designated-real。",
    );
  }
  const expectedBatchSha256 = environmentValue(values, env, "batch-sha256-env");
  const expectedSourceBindingsSha256 = environmentValue(values, env, "source-bindings-sha256-env");
  if (!digestPattern.test(expectedBatchSha256) || !digestPattern.test(expectedSourceBindingsSha256)) {
    throw new HistoryMigrationError("INVALID_ARGUMENTS", "批准摘要环境变量值不合法。");
  }
  const databaseUrl = environmentValue(values, env, "database-url-env");
  const adminUrl = environmentValue(values, env, "admin-url-env");
  const targetParsed = parsePostgresTarget(databaseUrl, "target");
  const adminParsed = parsePostgresTarget(adminUrl, "admin");
  if (
    targetParsed.host !== adminParsed.host ||
    targetParsed.port !== adminParsed.port ||
    targetParsed.user !== adminParsed.user
  ) {
    throw new HistoryMigrationError(
      "INVALID_ARGUMENTS",
      "正式目标与维护连接必须指向同一实例与身份。",
    );
  }
  assertFormalDatabaseName(targetParsed.database);
  const target: FormalTargetIdentity = {
    host: targetParsed.host,
    port: targetParsed.port,
    user: targetParsed.user,
    database: targetParsed.database,
  };
  return {
    privateRoot: environmentValue(values, env, "private-root-env"),
    packageDirectory: environmentValue(values, env, "package-directory-env"),
    listMetadata: environmentValue(values, env, "list-metadata-env"),
    groupingFile: environmentValue(values, env, "grouping-file-env"),
    materializedDirectory: environmentValue(values, env, "materialized-directory-env"),
    preparedDirectory: environmentValue(values, env, "prepared-directory-env"),
    approvalFile: environmentValue(values, env, "approval-file-env"),
    preflightReceipt: environmentValue(values, env, "preflight-receipt-env"),
    phase2Receipt: environmentValue(values, env, "phase2-receipt-env"),
    targetApprovalFile: environmentValue(values, env, "target-approval-env"),
    outputDirectory: environmentValue(values, env, "output-directory-env"),
    storageRoot: environmentValue(values, env, "storage-root-env"),
    importOutputDirectory: environmentValue(values, env, "import-output-directory-env"),
    databaseUrl,
    adminUrl,
    databaseName: target.database,
    target,
    principal: environmentValue(values, env, "principal-env"),
    tagId: environmentValue(values, env, "tag-id-env"),
    gitCommit: environmentValue(values, env, "git-commit-env"),
    executionId: environmentValue(values, env, "execution-id-env"),
    expectedBatchSha256,
    expectedSourceBindingsSha256,
  };
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

interface FormalValidation {
  readonly context: ValidationContext;
  readonly preflight: PreflightReceipt;
  readonly phase2: Phase2RunReceipt;
}

async function validateFormalGate(
  inputs: FormalInputs,
  env: NodeJS.ProcessEnv,
  hooks: FormalImportHooks,
): Promise<FormalValidation> {
  await assertPermittedPhase2EvidenceRoot(inputs.privateRoot);
  await assertPrivateDirectoryMode(inputs.privateRoot);
  await assertPathsInsidePrivateRoot(inputs.privateRoot, [
    { path: inputs.packageDirectory, kind: "existing" },
    { path: inputs.listMetadata, kind: "existing" },
    { path: inputs.groupingFile, kind: "existing" },
    { path: inputs.materializedDirectory, kind: "existing" },
    { path: inputs.preparedDirectory, kind: "existing" },
    { path: inputs.approvalFile, kind: "existing" },
    { path: inputs.preflightReceipt, kind: "existing" },
    { path: inputs.phase2Receipt, kind: "existing" },
    { path: inputs.targetApprovalFile, kind: "existing" },
    { path: inputs.outputDirectory, kind: "new" },
    { path: inputs.storageRoot, kind: "existing" },
    { path: inputs.importOutputDirectory, kind: "new" },
  ]);

  const provenance = await (hooks.verifyProvenance ?? verifyExecutionProvenance)(inputs.gitCommit);
  const authoritativeIdentities = await verifyApprovedPackageSourceIdentities({
    privateRootDirectory: inputs.privateRoot,
    materializedDirectory: inputs.materializedDirectory,
    metadataFile: inputs.listMetadata,
    preparedDirectory: inputs.preparedDirectory,
    approvalFile: inputs.approvalFile,
  });
  const metadataRead = await readPrivateJsonWithDigest(inputs.listMetadata);
  const reportRead = await readPrivateJsonWithDigest(join(inputs.packageDirectory, "report.json"));
  const groupingRead = await readPrivateJsonWithDigest(inputs.groupingFile);
  const preflightRead = await readPrivateJsonWithDigest(inputs.preflightReceipt);
  const phase2Read = await readPrivateJsonWithDigest(inputs.phase2Receipt);
  const targetApprovalRead = await readPrivateJsonWithDigest(inputs.targetApprovalFile);
  const report = packageReportPayloadSchema.parse(reportRead.value);
  const preflight = preflightReceiptSchema.parse(preflightRead.value);
  const phase2 = phase2RunReceiptSchema.parse(phase2Read.value);
  let targetApproval: FormalTargetApproval;
  try {
    targetApproval = formalTargetApprovalSchema.parse(targetApprovalRead.value);
  } catch {
    throw new HistoryMigrationError("INVALID_METADATA", "正式门禁：带外批准书结构不合法。");
  }
  if (dirname(inputs.targetApprovalFile) === dirname(inputs.phase2Receipt)) {
    throw new HistoryMigrationError(
      "INVALID_METADATA",
      "正式门禁：批准书不得存放在第 2 阶段收据目录内。",
    );
  }
  // 批准书是操作员带外提供的预期摘要：正式命令在此只能核对，不能改写。
  if (targetApproval.preflightReceiptSha256 !== preflightRead.sha256) {
    throw new HistoryMigrationError("INVALID_METADATA", "正式门禁：批准书未绑定第 1 阶段收据。");
  }
  if (targetApproval.phase2ReceiptSha256 !== phase2Read.sha256) {
    throw new HistoryMigrationError("INVALID_METADATA", "正式门禁：批准书未绑定第 2 阶段收据。");
  }
  if (targetApproval.scratchDatabaseFingerprintSha256 !== phase2.scratchDatabaseFingerprintSha256) {
    throw new HistoryMigrationError(
      "INVALID_METADATA",
      "正式门禁：批准书与第 2 阶段收据的临时库身份不一致。",
    );
  }
  const actualTargetFingerprint = computeFormalTargetFingerprintSha256(inputs.target);
  if (targetApproval.formalTargetFingerprintSha256 !== actualTargetFingerprint) {
    throw new HistoryMigrationError("INVALID_METADATA", "正式门禁：正式目标身份与批准书不一致。");
  }
  const scan = await scanPackageDirectory(inputs.packageDirectory, report);
  const authoritativePackageIdentitySha256 = bindAuthoritativePackageIdentities(
    report,
    authoritativeIdentities,
  );
  const authoritativeRevisionIdentitySha256 = bindAuthoritativeRevisionContent(
    scan.expectedRevisionInventory,
    authoritativeIdentities,
  );
  const sourceBindingsSha256 = recomputeSourceBindingsIdentity(report);
  const packageCount = scan.expectedRevisionInventory.revisionCount;
  if (
    packageCount !== authoritativeIdentities.length ||
    packageCount !== report.packages.length
  ) {
    throw new HistoryMigrationError("INVALID_METADATA", "正式门禁：候选、包与修订数量不一致。");
  }
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
  const batchSha256 = report.batchSha256;
  const expectedBindingValues = {
    listMetadataSha256: metadataRead.sha256,
    packageReportSha256: reportRead.sha256,
    groupingSha256: groupingRead.sha256,
    batchSha256,
    sourceBindingsSha256,
    authoritativePackageIdentitySha256,
    authoritativeRevisionIdentitySha256,
    codeInventoryEntryCount: provenance.codeInventoryEntryCount,
    codeInventorySha256: provenance.codeInventorySha256,
    tagIdSha256: sha256Hex(inputs.tagId),
    gitCommitSha256: sha256Hex(inputs.gitCommit),
    principalSha256: sha256Hex(inputs.principal),
    executionIdSha256: sha256Hex(inputs.executionId),
  };
  for (const [key, value] of Object.entries(expectedBindingValues)) {
    const bound = (preflight.inputBindings as Record<string, unknown>)[key];
    if (bound !== value) {
      throw new HistoryMigrationError("INVALID_METADATA", `正式门禁：第 1 阶段收据绑定不一致（${key}）。`);
    }
  }
  const scanMatches =
    preflight.packageScan.expectedSampleRows === scan.expectedSampleRows &&
    preflight.packageScan.expectedProblemFileRows === scan.expectedProblemFileRows &&
    preflight.packageScan.expectedStoredFilesRows === scan.expectedStoredFilesRows &&
    preflight.packageScan.expectedStoredBytes === scan.expectedStoredBytes &&
    preflight.packageScan.expectedStoredContentSha256 === scan.expectedStoredContentSha256 &&
    JSON.stringify(preflight.packageScan.expectedRevisionInventory) ===
      JSON.stringify(scan.expectedRevisionInventory);
  if (
    preflight.verdict !== "READY" ||
    !preflight.approvedInputMatches ||
    !preflight.authoritativeContentMatches ||
    preflight.reconciliation.packageCount !== packageCount ||
    !scanMatches
  ) {
    throw new HistoryMigrationError("INVALID_METADATA", "正式门禁：第 1 阶段收据未通过当前目录复验。");
  }
  if (phase2.inputBindings.preflightReceiptSha256 !== preflightRead.sha256) {
    throw new HistoryMigrationError("INVALID_METADATA", "正式门禁：第 2 阶段收据未绑定第 1 阶段收据。");
  }
  const phase2BindingsOk =
    phase2.inputBindings.batchSha256 === batchSha256 &&
    phase2.inputBindings.sourceBindingsSha256 === sourceBindingsSha256 &&
    phase2.inputBindings.authoritativePackageIdentitySha256 === authoritativePackageIdentitySha256 &&
    phase2.inputBindings.authoritativeRevisionIdentitySha256 === authoritativeRevisionIdentitySha256 &&
    phase2.inputBindings.codeInventorySha256 === provenance.codeInventorySha256 &&
    phase2.inputBindings.codeInventoryEntryCount === provenance.codeInventoryEntryCount &&
    phase2.inputBindings.tagIdSha256 === sha256Hex(inputs.tagId) &&
    phase2.inputBindings.gitCommitSha256 === sha256Hex(inputs.gitCommit) &&
    phase2.inputBindings.principalSha256 === sha256Hex(inputs.principal) &&
    phase2.inputBindings.executionIdSha256 === sha256Hex(inputs.executionId);
  if (
    !phase2BindingsOk ||
    batchSha256 !== inputs.expectedBatchSha256 ||
    sourceBindingsSha256 !== inputs.expectedSourceBindingsSha256 ||
    phase2.verdict !== "PASS" ||
    phase2.postcheck.verdict !== "PASS" ||
    !phase2.titleProbePassed ||
    phase2.packageCount !== packageCount ||
    phase2.firstPass.imported !== packageCount ||
    phase2.firstPass.skipped !== 0 ||
    phase2.firstPass.failed !== 0 ||
    phase2.replayPass.imported !== 0 ||
    phase2.replayPass.skipped !== packageCount ||
    phase2.replayPass.failed !== 0
  ) {
    throw new HistoryMigrationError("INVALID_METADATA", "正式门禁：第 2 阶段收据未满足通过条件或绑定不一致。");
  }
  if (reconciliation.verdict !== "READY") {
    throw new HistoryMigrationError("INVALID_METADATA", "正式门禁：当前批次对账未通过。");
  }

  await assertNewOutputPath(inputs.outputDirectory);
  await mkdir(inputs.outputDirectory, { mode: 0o700, recursive: false });
  await chmod(inputs.outputDirectory, 0o700);
  const freshPreflightDirectory = join(inputs.outputDirectory, "preflight");
  await assertNewOutputPath(freshPreflightDirectory);
  await mkdir(freshPreflightDirectory, { mode: 0o700, recursive: false });
  await assertNewOutputPath(join(inputs.outputDirectory, formalReceiptName));
  await assertNewOutputPath(join(inputs.outputDirectory, formalPassMarkerName));
  await assertNewOutputPath(join(inputs.outputDirectory, formalBackupVerifiedMarkerName));
  await assertNewOutputPath(join(inputs.outputDirectory, formalRollbackVerifiedMarkerName));
  await assertNewOutputPath(join(inputs.outputDirectory, formalRestoreRefusedMarkerName));
  await assertNewOutputPath(join(inputs.outputDirectory, formalBackupEvidenceName));
  await assertNewOutputPath(join(inputs.outputDirectory, formalRollbackEvidenceName));
  await assertNewOutputPath(join(inputs.outputDirectory, formalStorageSnapshotName));
  await assertNewOutputPath(inputs.importOutputDirectory);
  await assertPrivateDirectoryMode(inputs.storageRoot);

  const formalEnv = { ...env };
  const formalArgv = [
    "--private-root-env=FORMAL_PRIVATE_ROOT",
    "--list-metadata-env=FORMAL_LIST_METADATA",
    "--package-directory-env=FORMAL_PACKAGE_DIRECTORY",
    "--output-directory-env=FORMAL_PREFLIGHT_OUTPUT",
    "--materialized-directory-env=FORMAL_MATERIALIZED",
    "--prepared-directory-env=FORMAL_PREPARED",
    "--approval-file-env=FORMAL_APPROVAL",
    "--database-url-env=FORMAL_DATABASE_URL",
    "--grouping-file-env=FORMAL_GROUPING",
    "--tag-id-env=FORMAL_TAG",
    "--git-commit-env=FORMAL_GIT_COMMIT",
    "--target-class-env=FORMAL_TARGET_CLASS",
    "--principal-env=FORMAL_PRINCIPAL",
    "--execution-id-env=FORMAL_EXECUTION_ID",
    "--batch-sha256-env=FORMAL_BATCH_SHA256",
    "--source-bindings-sha256-env=FORMAL_SOURCE_BINDINGS_SHA256",
  ];
  Object.assign(formalEnv, {
    FORMAL_PRIVATE_ROOT: inputs.privateRoot,
    FORMAL_LIST_METADATA: inputs.listMetadata,
    FORMAL_PACKAGE_DIRECTORY: inputs.packageDirectory,
    FORMAL_PREFLIGHT_OUTPUT: freshPreflightDirectory,
    FORMAL_MATERIALIZED: inputs.materializedDirectory,
    FORMAL_PREPARED: inputs.preparedDirectory,
    FORMAL_APPROVAL: inputs.approvalFile,
    FORMAL_DATABASE_URL: inputs.databaseUrl,
    FORMAL_GROUPING: inputs.groupingFile,
    FORMAL_TAG: inputs.tagId,
    FORMAL_GIT_COMMIT: inputs.gitCommit,
    FORMAL_TARGET_CLASS: "designated-real",
    FORMAL_PRINCIPAL: inputs.principal,
    FORMAL_EXECUTION_ID: inputs.executionId,
    FORMAL_BATCH_SHA256: inputs.expectedBatchSha256,
    FORMAL_SOURCE_BINDINGS_SHA256: inputs.expectedSourceBindingsSha256,
  });
  const preflightExit = await (hooks.runPreflight ?? runHistoryImportPreflight)(
    formalArgv,
    formalEnv,
    {},
  );
  if (preflightExit !== 0) {
    throw new HistoryMigrationError("INVALID_METADATA", "正式门禁：当前目录的只读预检复验未通过。");
  }
  const freshPreflightRead = await readPrivateJsonWithDigest(
    join(freshPreflightDirectory, preflightReceiptName),
  );
  const freshPreflight = preflightReceiptSchema.parse(freshPreflightRead.value);
  if (freshPreflight.verdict !== "READY") {
    throw new HistoryMigrationError("INVALID_METADATA", "正式门禁：正式目标库只读预检未就绪。");
  }
  for (const [key, value] of Object.entries(expectedBindingValues)) {
    if ((freshPreflight.inputBindings as Record<string, unknown>)[key] !== value) {
      throw new HistoryMigrationError("INVALID_METADATA", "正式门禁：预检复验收据与已批准收据不一致。");
    }
  }

  return {
    context: {
      report,
      scan,
      reconciliation,
      preflightReceiptSha256: preflightRead.sha256,
      packageCount,
      authoritativePackageIdentitySha256,
      authoritativeRevisionIdentitySha256,
      provenance,
    },
    preflight,
    phase2,
  };
}

// ---------------------------------------------------------------------------
// 数据库备份/回滚：只操作第 1 阶段验证过的维护连接，不打印任何数据库细节。
// ---------------------------------------------------------------------------

function namedDatabaseConnectionString(adminUrl: string, name: string): string {
  const parsed = new URL(adminUrl);
  parsed.pathname = `/${encodeURIComponent(name)}`;
  return parsed.toString();
}
async function terminateConnectionsFor(admin: DatabaseHandle, name: string): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    await admin.execute(
      sql`select pg_terminate_backend(pid) from pg_stat_activity
          where datname = ${name} and pid <> pg_backend_pid()`,
    );
    const remaining = await admin.query<{ total: bigint }>(
      sql`select count(*)::bigint as total from pg_stat_activity
          where datname = ${name} and pid <> pg_backend_pid()`,
    );
    if (Number(remaining[0]?.total ?? 0) === 0) return;
    await admin.execute(sql`select pg_sleep(0.25)`);
  }
  throw new HistoryMigrationError(
    "INVALID_ARGUMENTS",
    "目标库仍有活动连接，无法建立备份。",
  );
}

async function captureNamedDatabaseContentInventory(
  adminUrl: string,
  name: string,
  tableNames: readonly string[],
): Promise<DatabaseContentInventory> {
  const database = createPostgresDatabase({
    connectionString: namedDatabaseConnectionString(adminUrl, name),
    maxConnections: 1,
    applicationName: "urmotiv-formal-backup-verify",
  });
  try {
    return await captureDatabaseContentInventory(database, [...tableNames]);
  } finally {
    await database.close();
  }
}

async function databaseExistsNamed(admin: DatabaseHandle, name: string): Promise<boolean> {
  const rows = await admin.query<{ total: bigint }>(
    sql`select count(*)::bigint as total from pg_database where datname = ${name}`,
  );
  return Number(rows[0]?.total ?? 0) === 1;
}

async function dropDatabaseForce(admin: DatabaseHandle, name: string): Promise<void> {
  // name 已通过 formalDatabaseNamePattern 严格校验，只能由安全字符构成。
  await terminateConnectionsFor(admin, name);
  await admin.execute(sql.raw(`drop database if exists "${name}" with (force)`));
}

/**
 * 建立并核对 DB+存储备份。返回后即存在一组与导入前现场逐项一致的备份；
 * 任何一步失败都会尽量回滚已完成部分，并向调用方抛出。
 */
async function createVerifiedFormalBackup(options: {
  readonly admin: DatabaseHandle;
  readonly inputs: FormalInputs;
  readonly beforeDatabaseInventory: DatabaseContentInventory;
  readonly beforeStorageInventory: StorageInventory;
}): Promise<{ readonly backupName: string; readonly storageSnapshotDirectory: string }> {
  const { admin, inputs, beforeDatabaseInventory, beforeStorageInventory } = options;
  const backupName = `${inputs.databaseName}${formalDatabaseBackupSuffix}`;
  const storageSnapshotDirectory = join(inputs.outputDirectory, formalStorageSnapshotName);
  if (formalDatabaseBackupSuffix.length + inputs.databaseName.length > 63) {
    throw new HistoryMigrationError("INVALID_ARGUMENTS", "正式目标库名过长，无法建立备份。");
  }
  try {
    await databaseExistsNamed(admin, backupName).then((exists) => {
      if (exists) {
        throw new HistoryMigrationError("INVALID_METADATA", "检测到遗留正式备份库，拒绝继续。");
      }
    });
    await terminateConnectionsFor(admin, inputs.databaseName);
    await admin.execute(
      sql`create database ${sql.identifier(backupName)} template ${sql.identifier(inputs.databaseName)}`,
    );
    const backupInventory = await captureNamedDatabaseContentInventory(
      inputs.adminUrl,
      backupName,
      historyImportRequiredTables,
    );
    if (!databaseContentInventoriesEqual(backupInventory, beforeDatabaseInventory)) {
      throw new HistoryMigrationError("INVALID_METADATA", "数据库备份内容与导入前摘要不一致。");
    }
    const snapshotInventory = await snapshotStorageDirectory(
      inputs.storageRoot,
      storageSnapshotDirectory,
    );
    if (!storageInventoriesEqual(snapshotInventory, beforeStorageInventory)) {
      throw new HistoryMigrationError("INVALID_METADATA", "存储备份内容与导入前摘要不一致。");
    }
    return { backupName, storageSnapshotDirectory };
  } catch (error) {
    await databaseExistsNamed(admin, backupName)
      .then((exists) => (exists ? dropDatabaseForce(admin, backupName) : undefined))
      .catch(() => undefined);
    await rm(storageSnapshotDirectory, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
}

interface RollbackProof {
  readonly storageRestored: boolean;
  readonly databaseRestored: boolean;
}

/**
 * 确定性地把数据库与存储回滚到备份时刻，并逐项核对。任何一步未证明都
 * 保留备份工件并写出 RESTORE_REFUSED 标记；返回的 proof 由调用方定级。
 */
async function rollbackFormalMutation(options: {
  readonly admin: DatabaseHandle;
  readonly inputs: FormalInputs;
  readonly backupName: string;
  readonly storageSnapshotDirectory: string;
  readonly beforeDatabaseInventory: DatabaseContentInventory;
  readonly beforeStorageInventory: StorageInventory;
}): Promise<RollbackProof> {
  const { admin, inputs, backupName, storageSnapshotDirectory } = options;
  let storageRestored = false;
  let databaseRestored = false;
  try {
    const restoredStorage = await restoreStorageDirectory(
      storageSnapshotDirectory,
      inputs.storageRoot,
      options.beforeStorageInventory,
    );
    storageRestored = storageInventoriesEqual(restoredStorage, options.beforeStorageInventory);
  } catch {
    storageRestored = false;
  }
  try {
    await terminateConnectionsFor(admin, inputs.databaseName);
    await admin.execute(sql.raw(`drop database if exists "${inputs.databaseName}" with (force)`));
    await admin.execute(
      sql`create database ${sql.identifier(inputs.databaseName)} template ${sql.identifier(backupName)}`,
    );
    const restoredDatabase = await captureNamedDatabaseContentInventory(
      inputs.adminUrl,
      inputs.databaseName,
      historyImportRequiredTables,
    );
    databaseRestored = databaseContentInventoriesEqual(
      restoredDatabase,
      options.beforeDatabaseInventory,
    );
  } catch {
    databaseRestored = false;
  }
  return { storageRestored, databaseRestored };
}

// ---------------------------------------------------------------------------
// 单遍导入与自证核对：不复用临时库两遍/回放执行，不跑标题探针。
// ---------------------------------------------------------------------------

function tablesDeltaMatches(
  before: readonly HistoryImportCountRow[],
  after: readonly HistoryImportCountRow[],
  input: {
    imported: number;
    attachmentRows: number;
    sampleRows: number;
    storedFilesDelta: number;
  },
): boolean {
  const expected = expectedTableDeltas({
    imported: input.imported,
    attachmentRows: input.attachmentRows,
    sampleRows: input.sampleRows,
    jobItemRows: input.imported,
    storedFilesDelta: input.storedFilesDelta,
    auditDelta: input.imported * 2,
  });
  const beforeMap = new Map(before.map((row) => [row.table, row.rows]));
  const afterMap = new Map(after.map((row) => [row.table, row.rows]));
  return expected.every(({ table, delta }) => (afterMap.get(table) ?? 0) - (beforeMap.get(table) ?? 0) === delta);
}

function revisionContentInventoriesEqual(
  actual: RevisionContentInventory,
  expected: RevisionContentInventory,
): boolean {
  return (
    actual.revisionCount === expected.revisionCount &&
    actual.nullSolutionCount === expected.nullSolutionCount &&
    actual.emptySolutionCount === expected.emptySolutionCount &&
    actual.fullContentSha256 === expected.fullContentSha256 &&
    actual.frozenContentSha256 === expected.frozenContentSha256 &&
    (actual.databaseRowsSha256 === undefined ||
      expected.databaseRowsSha256 === undefined ||
      actual.databaseRowsSha256 === expected.databaseRowsSha256)
  );
}

async function assertNoAcceptanceTitleProbeRemnants(
  database: DatabaseHandle,
  problemIds: readonly string[],
): Promise<boolean> {
  const rows = await database.query<{ total: bigint }>(
    sql`select count(*)::bigint as total from problem_revisions
        where title like '%[验收编辑]%' and problem_id in
        (${sql.join(problemIds.map((id) => sql`${id}`), sql`, `)})`,
  );
  return Number(rows[0]?.total ?? 0) === 0;
}

export interface FormalImportPassSummary {
  readonly importedCount: number;
  readonly skippedCount: number;
  readonly failedCount: number;
  readonly manifestIdentitySha256: string;
  readonly manifestContentBindingsSha256: string;
  readonly revisionContentEqualsApproved: boolean;
  readonly solutionStatesMatch: boolean;
  readonly attachmentCountMatches: boolean;
  readonly tableDeltasEqual: boolean;
  readonly titleUnmodified: boolean;
  readonly storageInventoryMatches: boolean;
  readonly storedFilesInventoryMatches: boolean;
  readonly solutionStates: SolutionStateCounts;
  readonly attachmentCount: number;
  readonly storageInventory: StorageInventory;
  readonly databaseInventory: DatabaseContentInventory;
  readonly revisionContent: RevisionContentInventory;
}

async function executeFormalImportPass(
  database: DatabaseHandle,
  inputs: FormalInputs,
  context: ValidationContext,
  beforeCounts: readonly HistoryImportCountRow[],
  seam: FormalImportTestSeam,
): Promise<FormalImportPassSummary> {
  const result = await importHistoryPackages({
    privateRootDirectory: inputs.privateRoot,
    packageDirectory: inputs.packageDirectory,
    outputDirectory: inputs.importOutputDirectory,
    dependencies: {
      database,
      assignedTagId: inputs.tagId,
      requestedByUserId: inputs.principal,
      storageRoot: inputs.storageRoot,
      ...(seam.storage === undefined ? {} : { storage: seam.storage }),
    },
  });
  const manifestRead = await readPrivateJsonWithDigest(
    join(inputs.importOutputDirectory, importManifestFileName),
  );
  const manifest = importManifestPayloadSchema.parse(manifestRead.value);
  const manifestIdentitySha256 = verifyProducedManifestIdentity(context.report, manifestRead.value);
  const manifestContentBindingsSha256 = manifestContentBindingsIdentity(
    context.report,
    manifestRead.value,
  );
  const identities = manifest.entries.map((entry) => ({
    candidateId: entry.candidateId,
    problemId: entry.problemId,
  }));
  const problemIds = identities.map(({ problemId }) => problemId);
  if (
    result.importedCount !== context.packageCount ||
    result.skippedCount !== 0 ||
    result.failedCount !== 0 ||
    manifest.entries.length !== context.packageCount ||
    manifest.importedCount !== context.packageCount ||
    new Set(problemIds).size !== context.packageCount
  ) {
    throw new HistoryMigrationError("INVALID_METADATA", "正式单遍导入聚合不满足批准数量。");
  }
  const afterCounts = await captureHistoryImportTableCounts(database);
  const storedFilesInventory = await captureStoredFileInventory(database);
  const revisionContent = await captureImportedRevisionContentInventory(database, identities);
  const solutionStates = await countSolutionStatesForProblems(database, problemIds);
  const attachmentCount = await countRevisionFilesForProblems(database, problemIds);
  const storageInventory = await captureStorageInventory(inputs.storageRoot);
  const databaseInventory = await captureDatabaseContentInventory(
    database,
    historyImportRequiredTables,
  );
  const expectedStored: StoredFileInventory = {
    fileCount: context.scan.expectedStoredFilesRows,
    totalBytes: context.scan.expectedStoredBytes,
    contentInventorySha256: context.scan.expectedStoredContentSha256,
  };
  const revisionContentEqualsApproved = revisionContentInventoriesEqual(
    revisionContent,
    context.scan.expectedRevisionInventory,
  );
  const solutionStatesMatch =
    solutionStates.nullSolutionCount === context.scan.expectedRevisionInventory.nullSolutionCount &&
    solutionStates.emptySolutionCount === context.scan.expectedRevisionInventory.emptySolutionCount;
  const attachmentCountMatches = attachmentCount === context.scan.expectedProblemFileRows;
  const tableDeltasEqual = tablesDeltaMatches(beforeCounts, afterCounts, {
    imported: result.importedCount,
    attachmentRows: attachmentCount,
    sampleRows: context.scan.expectedSampleRows,
    storedFilesDelta: context.scan.expectedStoredFilesRows,
  });
  const titleUnmodified = await assertNoAcceptanceTitleProbeRemnants(database, problemIds);
  const storageInventoryMatches =
    storageInventory.fileCount === expectedStored.fileCount &&
    storageInventory.totalBytes === expectedStored.totalBytes &&
    storageInventory.contentInventorySha256 === expectedStored.contentInventorySha256;
  const storedFilesInventoryMatches =
    storedFilesInventory.fileCount === expectedStored.fileCount &&
    storedFilesInventory.totalBytes === expectedStored.totalBytes &&
    storedFilesInventory.contentInventorySha256 === expectedStored.contentInventorySha256;
  if (
    !revisionContentEqualsApproved ||
    !solutionStatesMatch ||
    !attachmentCountMatches ||
    !tableDeltasEqual ||
    !titleUnmodified ||
    !storageInventoryMatches ||
    !storedFilesInventoryMatches
  ) {
    throw new HistoryMigrationError("INVALID_METADATA", "正式单遍导入后自证核对未通过。");
  }
  return {
    importedCount: result.importedCount,
    skippedCount: result.skippedCount,
    failedCount: result.failedCount,
    manifestIdentitySha256,
    manifestContentBindingsSha256,
    revisionContentEqualsApproved,
    solutionStatesMatch,
    attachmentCountMatches,
    tableDeltasEqual,
    titleUnmodified,
    storageInventoryMatches,
    storedFilesInventoryMatches,
    solutionStates,
    attachmentCount,
    storageInventory,
    databaseInventory,
    revisionContent,
  };
}

// ---------------------------------------------------------------------------
// 执行核心与安全拒绝层。
// ---------------------------------------------------------------------------

interface FormalCoreOptions {
  readonly inputs: FormalInputs;
  readonly context: ValidationContext;
  readonly phase2: Phase2RunReceipt;
  readonly seam: FormalImportTestSeam;
}

async function writeFormalReceiptPASS(options: FormalCoreOptions, pass: FormalImportPassSummary): Promise<void> {
  const receipt = {
    version: 4,
    generatedAt: new Date().toISOString(),
    targetClass: "designated-real",
    singlePass: true,
    inputBindings: {
      preflightReceiptSha256: options.phase2.inputBindings.preflightReceiptSha256,
      batchSha256: options.phase2.inputBindings.batchSha256,
      sourceBindingsSha256: options.phase2.inputBindings.sourceBindingsSha256,
      authoritativePackageIdentitySha256: options.phase2.inputBindings.authoritativePackageIdentitySha256,
      authoritativeRevisionIdentitySha256: options.phase2.inputBindings.authoritativeRevisionIdentitySha256,
      manifestContentBindingsSha256: pass.manifestContentBindingsSha256,
      codeInventorySha256: options.context.provenance.codeInventorySha256,
      codeInventoryEntryCount: options.context.provenance.codeInventoryEntryCount,
      tagIdSha256: sha256Hex(options.inputs.tagId),
      gitCommitSha256: sha256Hex(options.inputs.gitCommit),
      principalSha256: sha256Hex(options.inputs.principal),
      executionIdSha256: sha256Hex(options.inputs.executionId),
    },
    packageCount: options.context.packageCount,
    postcheck: {
      verdict: "PASS",
      authoritativeInventoryEquality: {
        revisionContent: pass.revisionContentEqualsApproved,
        solutionStates: pass.solutionStatesMatch,
        attachmentCount: pass.attachmentCountMatches,
        tableDeltas: pass.tableDeltasEqual,
        titleUnmodified: pass.titleUnmodified,
        storage: pass.storageInventoryMatches,
        storedFiles: pass.storedFilesInventoryMatches,
      },
    },
    solutionStates: pass.solutionStates,
    attachmentCount: pass.attachmentCount,
    storedObjectCount: pass.storageInventory.fileCount,
    storedBytes: pass.storageInventory.totalBytes,
    revisionIntegrity: {
      fullContentSha256: pass.revisionContent.fullContentSha256,
      frozenContentSha256: pass.revisionContent.frozenContentSha256,
      databaseRowsSha256: pass.revisionContent.databaseRowsSha256,
    },
    databaseContentSha256: pass.databaseInventory.contentSha256,
    storageContentSha256: pass.storageInventory.contentInventorySha256,
    manifestContentBindingsSha256: pass.manifestContentBindingsSha256,
    backupVerifiedBeforeMutation: true,
    verdict: "PASS",
  };
  await writePrivateFile(
    join(options.inputs.outputDirectory, formalReceiptName),
    `${JSON.stringify(receipt, null, 2)}\n`,
  );
  await writePrivateFile(
    join(options.inputs.outputDirectory, formalPassMarkerName),
    `${receipt.generatedAt}\n`,
  );
}

async function writeFormalReceiptRefused(
  options: FormalCoreOptions,
  details: { readonly refusalCode: string; readonly rollback: RollbackProof },
): Promise<void> {
  const receipt = {
    version: 4,
    generatedAt: new Date().toISOString(),
    targetClass: "designated-real",
    singlePass: true,
    verdict: "FAIL",
    refusalCode: details.refusalCode,
    rollback: {
      storageRestored: details.rollback.storageRestored,
      databaseRestored: details.rollback.databaseRestored,
    },
    batchSha256: options.context.report.batchSha256,
    packageCount: options.context.packageCount,
  };
  await writePrivateFile(
    join(options.inputs.outputDirectory, formalReceiptName),
    `${JSON.stringify(receipt, null, 2)}\n`,
  );
}

async function runFormalImportCore(
  argv: readonly string[],
  env: NodeJS.ProcessEnv,
  hooks: FormalImportHooks = {},
  seam: FormalImportTestSeam = {},
): Promise<number> {

  const inputs = resolveFormalInputs(argv, env);
  const validation = await validateFormalGate(inputs, env, hooks);
  const { context, phase2 } = validation;
  const coreOptions: FormalCoreOptions = { inputs, context, phase2, seam };

  let beforeCounts: readonly HistoryImportCountRow[];
  let beforeDatabaseInventory: DatabaseContentInventory;
  let beforeStorageInventory: StorageInventory;
  const database = createPostgresDatabase({
    connectionString: inputs.databaseUrl,
    maxConnections: 8,
    applicationName: "urmotiv-history-import-formal",
  });
  try {

    await runZeroMutationDatabasePreflight(database, {
      requiredTagId: inputs.tagId,
      requiredPrincipalId: inputs.principal,
    }).then((databaseResult) => {
      if (
        !databaseResult.readOnlyEnforced ||
        databaseResult.missingTableCount !== 0 ||
        databaseResult.tagPresent !== true ||
        databaseResult.principalPresent !== true
      ) {
        throw new HistoryMigrationError("INVALID_ARGUMENTS", "正式目标库的前置依赖校验未通过。");
      }
    });
    beforeCounts = await captureHistoryImportTableCounts(database);
    beforeDatabaseInventory = await captureDatabaseContentInventory(
      database,
      historyImportRequiredTables,
    );
    beforeStorageInventory = await captureStorageInventory(inputs.storageRoot);
    await database.close();
  } catch (error) {
    await database.close().catch(() => undefined);
    throw error;
  }

  const admin = createPostgresDatabase({
    connectionString: inputs.adminUrl,
    maxConnections: 2,
    applicationName: "urmotiv-history-import-formal-admin",
  });
  try {
    const storageSnapshotDirectory = join(inputs.outputDirectory, formalStorageSnapshotName);
    // 第一步：设立并核对匹配的 DB+存储备份；未完成前绝不允许突变。
    const backup = await createVerifiedFormalBackup({
      admin,
      inputs,
      beforeDatabaseInventory,
      beforeStorageInventory,
    });
    await writeNewPrivateJson(join(inputs.outputDirectory, formalBackupEvidenceName), {
      version: 1,
      generatedAt: new Date().toISOString(),
      databaseBackupVerified: true,
      databaseBackupContentSha256: beforeDatabaseInventory.contentSha256,
      storageSnapshotVerified: true,
      storageSnapshotContentSha256: beforeStorageInventory.contentInventorySha256,
    });
    await writePrivateFile(
      join(inputs.outputDirectory, formalBackupVerifiedMarkerName),
      `${new Date().toISOString()}\n`,
    );

    // 第二步：单遍导入 + 自证核对；任何失败/不一致都走确定性双向回滚。
    let pass: FormalImportPassSummary;
    let refusalCode = "import_refused";
    let rollback: RollbackProof;
    const importDatabase = createPostgresDatabase({
      connectionString: inputs.databaseUrl,
      maxConnections: 8,
      applicationName: "urmotiv-history-import-formal-single-pass",
    });
    try {
      pass = await executeFormalImportPass(
        importDatabase,
        inputs,
        context,
        beforeCounts,
        seam,
      );
      if (pass.manifestContentBindingsSha256 !== phase2.inputBindings.manifestContentBindingsSha256) {
        refusalCode = "manifest_content_bindings_mismatch";
        throw new HistoryMigrationError(
          "INVALID_METADATA",
          "正式导入清单内容绑定与第 2 阶段收据不一致。",
        );
      }
    } catch (error) {
      await importDatabase.close().catch(() => undefined);
      rollback = await rollbackFormalMutation({
        admin,
        inputs,
        backupName: backup.backupName,
        storageSnapshotDirectory,
        beforeDatabaseInventory,
        beforeStorageInventory,
      });
      if (!rollback.storageRestored || !rollback.databaseRestored) {
        const refusedAt = new Date().toISOString();
        await writeNewPrivateJson(join(inputs.outputDirectory, formalRollbackEvidenceName), {
          version: 1,
          generatedAt: refusedAt,
          storageRestored: rollback.storageRestored,
          databaseRestored: rollback.databaseRestored,
          backupRetained: true,
          storageSnapshotRetained: true,
        }).catch(() => undefined);
        await writePrivateFile(
          join(inputs.outputDirectory, formalRestoreRefusedMarkerName),
          `${refusedAt}\n`,
        ).catch(() => undefined);
        if (error instanceof HistoryMigrationError) {
          if (error.code === "INVALID_ARGUMENTS") {
            throw error;
          }
          throw new HistoryMigrationError(
            "INTERNAL_ERROR",
            "正式导入已中止；回滚未能证明，备份工件已保留。",
          );
        }
        throw new HistoryMigrationError(
          "INTERNAL_ERROR",
          "正式导入已中止；回滚未能证明，备份工件已保留。",
        );
      }
      await writeNewPrivateJson(join(inputs.outputDirectory, formalRollbackEvidenceName), {
        version: 1,
        generatedAt: new Date().toISOString(),
        storageRestored: true,
        databaseRestored: true,
        databaseContentSha256Restored: beforeDatabaseInventory.contentSha256,
        storageContentSha256Restored: beforeStorageInventory.contentInventorySha256,
      });
      await writePrivateFile(
        join(inputs.outputDirectory, formalRollbackVerifiedMarkerName),
        `${new Date().toISOString()}\n`,
      );
      await writeFormalReceiptRefused(coreOptions, {
        refusalCode,
        rollback,
      });
      await dropDatabaseForce(admin, backup.backupName).catch(() => undefined);
      await rm(storageSnapshotDirectory, { recursive: true, force: true }).catch(() => undefined);
      if (error instanceof HistoryMigrationError) throw error;
      throw new HistoryMigrationError("INVALID_METADATA", "正式导入已中止并回滚。");
    }
    await importDatabase.close().catch(() => undefined);

    // 第三步：成功路径——只写 PASS 收据，然后清理备份工件；清理失败即拒绝。
    try {
      await writeFormalReceiptPASS(coreOptions, pass);
      await dropDatabaseForce(admin, backup.backupName);
      await rm(storageSnapshotDirectory, { recursive: true, force: true });
    } catch (error) {
      throw new HistoryMigrationError(
        "INVALID_METADATA",
        "正式导入数据已写入，但最终核对或备份清理未完成；现场需人工接管。",
      );
    }
    console.log(
      `正式导入: PASS; 包数量=${context.packageCount}; 缺失题解=${pass.solutionStates.nullSolutionCount}; 空题解=${pass.solutionStates.emptySolutionCount}`,
    );
    return 0;
  } finally {
    await admin.close().catch(() => undefined);
  }
}
/**
 * 正式导出的唯一入口：不接受故障注入参数；hook 只允许测试运行时对回环合成
 * 目标生效。任何路径、指纹、未分类异常细节都不进 stdout/stderr。
 */
export async function runFormalImport(
  argv: readonly string[],
  env: NodeJS.ProcessEnv,
  hooks: FormalImportHooks = {},
): Promise<number> {
  try {
    if (Object.keys(hooks).length > 0) {
      assertTestSeamRuntime(env);
      const inputs = resolveFormalInputs(argv, env);
      assertSyntheticFormalSeamAllowed(env, {
        host: inputs.target.host,
        databaseName: inputs.databaseName,
      });
    }
    return await runFormalImportCore(argv, env, hooks, {});
  } catch (error: unknown) {
    if (error instanceof HistoryMigrationError) {
      console.error(`正式导入拒绝: ${error.code}`);
      return error.code === "INVALID_ARGUMENTS" ? 2 : 1;
    }
    console.error("正式导入拒绝: UNCLASSIFIED");
    return 1;
  }
}

/**
 * 仅测试缝：先做回环+合成正式命名校验，再以可注入故障面运行同一核心。
 * 任何真实生产目标在此机械拒绝，无法借道。hook 也必须显式给出：测试
 * 内可用合成来源证明，生产调用不存在此入口的带 hook 路径。
 */

export async function runFormalImportForTestSeam(
  argv: readonly string[],
  env: NodeJS.ProcessEnv,
  seam: FormalImportTestSeam,
  hooks: FormalImportHooks = {},
): Promise<number> {
  try {
    assertTestSeamRuntime(env);
    const inputs = resolveFormalInputs(argv, env);
    assertSyntheticFormalSeamAllowed(env, {
      host: inputs.target.host,
      databaseName: inputs.databaseName,
    });
    if (Object.keys(seam).length === 0) {
      throw new HistoryMigrationError("INVALID_ARGUMENTS", "测试缝必须提供注入故障面。");
    }
    return await runFormalImportCore(argv, env, hooks, seam);
  } catch (error: unknown) {
    if (error instanceof HistoryMigrationError) {

      console.error(`正式导入拒绝: ${error.code}`);
      return error.code === "INVALID_ARGUMENTS" ? 2 : 1;
    }
    console.error("正式导入拒绝: UNCLASSIFIED");
    return 1;
  }
}


if (import.meta.url === `file://${process.argv[1]}`) {
  runFormalImport(process.argv.slice(2), process.env).then((code) => {
    process.exitCode = code;
  });
}

export {
  formalReceiptName,
  formalPassMarkerName,
  formalBackupVerifiedMarkerName,
  formalRollbackVerifiedMarkerName,
  formalRestoreRefusedMarkerName,
  formalBackupEvidenceName,
  formalRollbackEvidenceName,
};