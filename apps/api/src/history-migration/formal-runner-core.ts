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
import { appendFile, chmod, mkdir, open, readFile, realpath, rm } from "node:fs/promises";

import { dirname, join } from "node:path";

import { sql } from "drizzle-orm";
import { createPostgresDatabase, type DatabaseHandle } from "@urmotiv/database";
import type { ImportExecutionAuthorization } from "@urmotiv/jobs";
import type { FileStorage } from "@urmotiv/storage";
import { z } from "zod";

import { DatabaseDataStore } from "../database-store";
import { ServiceImportExecutionAuthorization } from "../problem-package-runtime";
import { ProblemPackageTemporaryError } from "@urmotiv/jobs";
import { sha256Hex } from "./digests";
import { HistoryMigrationError } from "./errors";
import {
  computeFormalAdminFingerprintSha256,
  computeFormalTargetFingerprintSha256,
  computeStorageRootIdentitySha256,
  parsePostgresIdentity,
  type FormalTargetIdentity,
} from "./formal-identity";

export {
  computeFormalAdminFingerprintSha256,
  computeFormalTargetFingerprintSha256,
  computeStorageRootIdentitySha256,
  parsePostgresIdentity,
  type FormalTargetIdentity,
} from "./formal-identity";
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
} from "./import-preflight";
import { verifyApprovedPackageSourceIdentities } from "./core";
import {
  importHistoryPackages,
  importManifestPayloadSchema,
  packageReportPayloadSchema,
} from "./import-phase";
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
} from "./phase2-postcheck";
import {
  captureDatabaseContentInventory,
  captureStorageInventory,
  databaseContentInventoriesEqual,
  restoreStorageDirectory,
  snapshotStorageDirectory,
  storageInventoriesEqual,
  type DatabaseContentInventory,
  type StorageInventory,
} from "./history-import-snapshot";
import {
  captureImportedRevisionContentInventory,
  type RevisionContentInventory,
} from "./revision-integrity";
import {
  assertNewOutputPath,
  assertPathsInsidePrivateRoot,
  assertPrivateDirectoryMode,
  readPrivateJson,
  movePrivateFileNoReplace,
  privateRegularFileExists,
  readPrivateJsonWithDigest,
  removePrivateRegularFile,
  writeNewPrivateJson,
  writePrivateFile,
} from "./private-files";
import {
  assertPermittedPhase2EvidenceRoot,
  verifyExecutionProvenance,
  type ExecutionProvenance,
} from "./execution-provenance";
import {
  phase2RunReceiptSchema,
  preflightReceiptSchema,
  type Phase2RunReceipt,
  type PreflightReceipt,
} from "./runner-inputs";
import type { ValidationContext } from "./phase2-runner-core";
import {
  advanceFormalRecoveryPhase,
  readFormalRecoveryState,
  recoveryStateSha256,
  startFormalRecoveryState,
  type FormalRecoveryPhase,
  type FormalRecoveryState,
} from "./formal-recovery-state";
import { preflightReceiptName, runHistoryImportPreflight } from "./preflight-core";
import { designatedRealFormalImportCount } from "./pipeline-constants";
export { designatedRealFormalImportCount };
const digestPattern = /^[a-f0-9]{64}$/;
const formalDatabaseNamePattern = /^[a-z][a-z0-9_]{0,47}$/;
export const formalReceiptName = "formal-import-receipt.private.json";
export const formalPassMarkerName = "FORMAL_IMPORT_PASS";
export const formalRetiredPassReceiptName = "formal-import-receipt.retired-pass.private.json";
export const formalRetiredPassMarkerName = "FORMAL_IMPORT_PASS.retired";
export const formalPassRetirementEvidenceName = "formal-pass-retirement.private.json";
export const formalBackupVerifiedMarkerName = "FORMAL_BACKUP_VERIFIED";
export const formalRollbackVerifiedMarkerName = "FORMAL_ROLLBACK_VERIFIED";
export const formalRestoreRefusedMarkerName = "FORMAL_RESTORE_REFUSED";
export const formalBackupEvidenceName = "formal-backup-evidence.private.json";
export const formalRollbackEvidenceName = "formal-rollback-evidence.private.json";
export const formalCleanupPendingEvidenceName = "formal-cleanup-pending-evidence.private.json";
const formalStorageSnapshotName = "formal.storage.before.snapshot";
const formalDatabaseBackupSuffix = "__formal_backup";
const importManifestFileName = "import-manifest.private.json";

/** 带外批准书：操作员在收据目录之外提供，正式命令只读、不自证。 */
const generatedAtSchema = z.string().refine(
  (value) => !Number.isNaN(Date.parse(value)),
  "generatedAt 必须是可解析的时间。",
);
const noncePattern = /^[a-f0-9]{32}$/;

/**
 * 批准书 v2：单次 nonce、时间窗、操作员身份、代码与批次的完整绑定，
 * 以及正式目标/管理员连接/存储根/预突变的逐项预期摘要。任何正式突变
 * 都需要这张批准书，且由 generationBinding 绑定到备份、回滚证据与收据。
 */
export const formalTargetApprovalSchema = z
  .object({
    version: z.literal(2),
    generatedAt: generatedAtSchema,
    expiresAt: generatedAtSchema,
    nonce: z.string().regex(noncePattern),
    approvedByActorSha256: z.string().regex(digestPattern),
    branchName: z.string().min(1).max(120),
    gitCommitSha256: z.string().regex(digestPattern),
    expectedFormalImportCount: z.number().int().min(1),
    storageRootIdentitySha256: z.string().regex(digestPattern),
    prestateDatabaseInventorySha256: z.string().regex(digestPattern),
    prestateStorageInventorySha256: z.string().regex(digestPattern),
    adminTargetFingerprintSha256: z.string().regex(digestPattern),
    preflightReceiptSha256: z.string().regex(digestPattern),
    phase2ReceiptSha256: z.string().regex(digestPattern),
    scratchDatabaseFingerprintSha256: z.string().regex(digestPattern),
    formalTargetFingerprintSha256: z.string().regex(digestPattern),
  })
  .strict();

export type FormalTargetApproval = z.infer<typeof formalTargetApprovalSchema>;

/**
 * 批准书世代绑定：固定字段顺序的规范化摘要，用于把备份/回滚证据与
 * 正式收据绑定到同一张批准书，防止证据拼接自不同批准代次。
 */
export function computeFormalGenerationBinding(target: FormalTargetApproval): string {
  const canonical = JSON.stringify([
    target.version,
    target.generatedAt,
    target.expiresAt,
    target.nonce,
    target.approvedByActorSha256,
    target.branchName,
    target.gitCommitSha256,
    target.expectedFormalImportCount,
    target.storageRootIdentitySha256,
    target.prestateDatabaseInventorySha256,
    target.prestateStorageInventorySha256,
    target.adminTargetFingerprintSha256,
    target.preflightReceiptSha256,
    target.phase2ReceiptSha256,
    target.scratchDatabaseFingerprintSha256,
    target.formalTargetFingerprintSha256,
  ]);
  return sha256Hex(canonical);
}


/**
 * 批准书 nonce 只能核销一次。先用 O_EXCL 独占创建声明文件（内核级原子），
 * 随后把只含摘要的条目追加进 0o600 日志并落盘。任何一次重复执行都失败
 * 关闭：日志含该 nonce、或声明文件已存在（并发/残留），都拒绝。
 */
const formalApprovalLogName = "formal-approval-log";
async function consumeFormalApprovalNonce(
  privateRoot: string,
  approval: FormalTargetApproval,
): Promise<void> {
  const logPath = join(privateRoot, formalApprovalLogName);
  const nonceSha256 = sha256Hex(`nonce-v1|${approval.nonce}`);
  const consumedAt = new Date().toISOString();
  const entry = `${nonceSha256}\t${consumedAt}\t${approval.gitCommitSha256}`;
  const claimPath = join(privateRoot, `${formalApprovalLogName}.${nonceSha256}.claim`);
  let existing = "";
  try {
    existing = await readFile(logPath, "utf8");
  } catch {
    // 日志尚不存在：可能是首次核销。
  }
  if (
    existing
      .split("\n")
      .map((line) => line.split("\t")[0])
      .includes(nonceSha256)
  ) {
    throw new HistoryMigrationError("INVALID_METADATA", "正式门禁：批准书 nonce 已被核销，拒绝重放。");
  }
  const claim = await open(claimPath, "wx", 0o600).catch(() => undefined);
  if (claim === undefined) {
    throw new HistoryMigrationError(
      "INVALID_METADATA",
      "正式门禁：批准书 nonce 核销声明已存在（并发或残留），拒绝执行。",
    );
  }
  try {
    await claim.writeFile(entry, "utf8");
    await claim.sync();
  } finally {
    await claim.close();
  }
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(logPath, "a", 0o600);
  } catch {
    handle = undefined;
  }
  if (handle !== undefined) {
    await handle.appendFile(`${entry}\n`, "utf8");
    await handle.sync();
    await handle.close();
  } else {
    await appendFile(logPath, `${entry}\n`, { encoding: "utf8", mode: 0o600 });
  }
}
export interface FormalInputs {
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
  readonly finalization?: {
    /** PASS 收据写盘之前的故障注入：证明收据缺席时的失败必须联合回滚。 */
    readonly beforePassReceiptWrite?: (() => Promise<void>) | undefined;
    /** 成功承诺（success_committed）落盘前的故障注入：两个恢复副本仍完好。 */
    readonly beforeSuccessCommittedWrite?: (() => Promise<void>) | undefined;
    /** 承诺落盘后的故障注入：只能是尽力而为收尾、不得把 PASS 转失败。 */
    readonly afterPassReceiptWrite?: (() => Promise<void>) | undefined;
    /** 数据库备份已删除、存储快照删除前的故障注入。 */
    readonly afterDatabaseBackupDrop?: (() => Promise<void>) | undefined;
    /** finalized 相位写盘前的故障注入：两个恢复副本均已删除。 */
    readonly beforeFinalizedWrite?: (() => Promise<void>) | undefined;
  } | undefined;
  readonly refusal?: {
    /** FAIL 收据写盘前的故障注入：证明拒绝结论不得与 PASS 标记共存。 */
    readonly beforeRefusalReceiptWrite?: (() => Promise<void>) | undefined;
  } | undefined;
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

function parsePostgresTarget(raw: string, _role: "target" | "admin"): FormalTargetIdentity {
  return parsePostgresIdentity(raw);
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
  readonly targetApproval: FormalTargetApproval;
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
  if (Date.parse(targetApproval.expiresAt) <= Date.now()) {
    throw new HistoryMigrationError("INVALID_METADATA", "正式门禁：批准书已过期。");
  }
  if (Date.parse(targetApproval.generatedAt) > Date.now()) {
    throw new HistoryMigrationError("INVALID_METADATA", "正式门禁：批准书生成时间在未来，拒绝。");
  }
  if (sha256Hex(inputs.gitCommit) !== targetApproval.gitCommitSha256) {
    throw new HistoryMigrationError("INVALID_METADATA", "正式门禁：批准书未绑定当前 git 提交。");
  }
  const adminTarget = parsePostgresTarget(inputs.adminUrl, "admin");
  if (
    computeFormalAdminFingerprintSha256({
      host: adminTarget.host,
      port: adminTarget.port,
      user: adminTarget.user,
      database: adminTarget.database,
    }) !== targetApproval.adminTargetFingerprintSha256
  ) {
    throw new HistoryMigrationError("INVALID_METADATA", "正式门禁：管理员连接身份与批准书不一致。");
  }
  let storageRootIdentitySha256: string;
  try {
    storageRootIdentitySha256 = await computeStorageRootIdentitySha256(inputs.storageRoot);
  } catch {
    throw new HistoryMigrationError("INVALID_METADATA", "正式门禁：无法解析存储根真实路径。");
  }
  if (storageRootIdentitySha256 !== targetApproval.storageRootIdentitySha256) {
    throw new HistoryMigrationError("INVALID_METADATA", "正式门禁：存储根身份与批准书不一致。");
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
  if (packageCount !== targetApproval.expectedFormalImportCount) {
    throw new HistoryMigrationError("INVALID_METADATA", "正式门禁：批准书预期导入数量与批次不一致。");
  }
  if (packageCount !== authoritativeIdentities.length || packageCount !== report.packages.length) {
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
  await assertNewOutputPath(join(inputs.outputDirectory, formalRetiredPassReceiptName));
  await assertNewOutputPath(join(inputs.outputDirectory, formalRetiredPassMarkerName));
  await assertNewOutputPath(join(inputs.outputDirectory, formalPassRetirementEvidenceName));
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
    targetApproval,
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
  readonly outputDirectory: string;
  readonly beforeDatabaseInventory: DatabaseContentInventory;
  readonly beforeStorageInventory: StorageInventory;
}): Promise<{ readonly backupName: string; readonly storageSnapshotDirectory: string }> {
  const { admin, inputs, outputDirectory, beforeDatabaseInventory, beforeStorageInventory } = options;

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
    // 破坏性清理只能发生在 backup_create_pending 相位内，且以受保护
    // 转移收尾；相位无法复检时一律不做任何删除。
    const current = await readFormalRecoveryState(outputDirectory).catch(() => undefined);
    if (current?.phase === "backup_create_pending") {
      await databaseExistsNamed(admin, backupName)
        .then((exists) => (exists ? dropDatabaseForce(admin, backupName) : undefined))
        .catch(() => undefined);
      await rm(storageSnapshotDirectory, { recursive: true, force: true }).catch(() => undefined);
      await advanceFormalRecoveryPhase(outputDirectory, "backup_create_pending", "backup_failed")
        .catch(() => undefined);
    }
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
    actual.databaseRowsSha256 === expected.databaseRowsSha256
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

/** 正式入口的执行授权：绑定运行库，从数据库实时读取操作员账号状态。 */
function importExecutionAuthorizationFor(database: DatabaseHandle): ImportExecutionAuthorization {
  const store = new DatabaseDataStore(database);
  return new ServiceImportExecutionAuthorization({
    getUser: (userId) => store.getUser(userId),
  });
}

/**
 * 维护连接身份探针：活动连接解析出的角色/数据库 + 服务器集群标识 +
 * 连接串摘要，全部用于收尾续做的运行时绑定（Gate 4）。任何字段在
 * 运行期无法取得时以空串计入摘要，续做时用同一构造法对拍。
 */
async function probeMaintenanceConnectionIdentity(
  admin: DatabaseHandle,
  adminUrl: string,
): Promise<{
  readonly liveAdminFingerprintSha256: string;
  readonly clusterIdentitySha256: string;
  readonly adminUrlSha256: string;
}> {
  const parsed = parsePostgresTarget(adminUrl, "admin");
  const rows = await admin.query<{ admin_database: string; admin_role: string }>(
    sql`select current_database() as admin_database, current_user as admin_role`,
  );
  const row = rows[0];
  const liveAdminFingerprintSha256 =
    row === undefined || typeof row.admin_database !== "string" || typeof row.admin_role !== "string"
      ? ""
      : computeFormalAdminFingerprintSha256({
          host: parsed.host,
          port: parsed.port,
          user: row.admin_role,
          database: row.admin_database,
        });
  let clusterIdentity = "";
  try {
    const cluster = await admin.query<{ identifier: string }>(
      sql`select system_identifier::text as identifier from pg_control_system()`,
    );
    if (typeof cluster[0]?.identifier === "string") clusterIdentity = cluster[0].identifier;
  } catch {
    clusterIdentity = "";
  }
  return {
    liveAdminFingerprintSha256,
    clusterIdentitySha256: sha256Hex(`cluster-v1|${clusterIdentity}`),
    adminUrlSha256: sha256Hex(`admin-url-v1|${adminUrl}`),
  };
}

/**
 * 运行时管理员身份核验：用实际连接查询 current_database/current_user，
 * 与批准书绑定的管理员连接指纹比对。解析一致但实际身份不同（代理、
 * 反向映射、遗漏重写）也会在突变前被拒绝。
 */
async function verifyAdministratorConnectionIdentity(
  admin: DatabaseHandle,
  inputs: FormalInputs,
  approval: FormalTargetApproval,
): Promise<void> {
  const live = await probeMaintenanceConnectionIdentity(admin, inputs.adminUrl);
  if (
    live.liveAdminFingerprintSha256 === "" ||
    live.liveAdminFingerprintSha256 !== approval.adminTargetFingerprintSha256
  ) {
    throw new HistoryMigrationError(
      "INVALID_METADATA",
      "正式门禁：管理员连接的实际身份与批准书不一致。",
    );
  }
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
      authorization: importExecutionAuthorizationFor(database),
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
  readonly targetApproval: FormalTargetApproval;
}

async function recoveryGenerationForReceipt(options: FormalCoreOptions) {
  const state = await readFormalRecoveryState(options.inputs.outputDirectory);
  if (state === undefined) {
    throw new HistoryMigrationError("INVALID_METADATA", "恢复状态机尚未建立，无法签署收据。");
  }
  return { phase: state.phase, stateSha256: recoveryStateSha256(state) } as const;
}

async function writeFormalReceiptPASS(options: FormalCoreOptions, pass: FormalImportPassSummary): Promise<void> {
  const recoveryGeneration = await recoveryGenerationForReceipt(options);
  const receipt = {
    version: 4,
    generatedAt: new Date().toISOString(),
    target: {
      host: options.inputs.target.host,
      port: options.inputs.target.port,
      user: options.inputs.target.user,
      database: options.inputs.target.database,
    },
    targetClass: "designated-real",
    singlePass: true,
    recoveryGeneration,
    approvalBinding: {
      nonceSha256: sha256Hex(`nonce-v1|${options.targetApproval.nonce}`),
      generationBindingSha256: computeFormalGenerationBinding(options.targetApproval),
      approvedByActorSha256: options.targetApproval.approvedByActorSha256,
      branchName: options.targetApproval.branchName,
      gitCommitSha256: options.targetApproval.gitCommitSha256,
      expectedFormalImportCount: options.targetApproval.expectedFormalImportCount,
    },
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
  const recoveryGeneration = await recoveryGenerationForReceipt(options);
  const receipt = {
    version: 4,
    generatedAt: new Date().toISOString(),
    target: {
      host: options.inputs.target.host,
      port: options.inputs.target.port,
      user: options.inputs.target.user,
      database: options.inputs.target.database,
    },
    recoveryGeneration,
    targetClass: "designated-real",
    singlePass: true,
    approvalBinding: {
      nonceSha256: sha256Hex(`nonce-v1|${options.targetApproval.nonce}`),
      generationBindingSha256: computeFormalGenerationBinding(options.targetApproval),
      approvedByActorSha256: options.targetApproval.approvedByActorSha256,
      branchName: options.targetApproval.branchName,
      gitCommitSha256: options.targetApproval.gitCommitSha256,
      expectedFormalImportCount: options.targetApproval.expectedFormalImportCount,
    },
    inputBindings: {
      preflightReceiptSha256: options.phase2.inputBindings.preflightReceiptSha256,
      batchSha256: options.phase2.inputBindings.batchSha256,
      sourceBindingsSha256: options.phase2.inputBindings.sourceBindingsSha256,
      authoritativePackageIdentitySha256: options.phase2.inputBindings.authoritativePackageIdentitySha256,
      authoritativeRevisionIdentitySha256: options.phase2.inputBindings.authoritativeRevisionIdentitySha256,
      codeInventorySha256: options.context.provenance.codeInventorySha256,
      codeInventoryEntryCount: options.context.provenance.codeInventoryEntryCount,
      tagIdSha256: sha256Hex(options.inputs.tagId),
      gitCommitSha256: sha256Hex(options.inputs.gitCommit),
      principalSha256: sha256Hex(options.inputs.principal),
      executionIdSha256: sha256Hex(options.inputs.executionId),
    },
    packageCount: options.context.packageCount,
    verdict: "FAIL",
    refusalCode: details.refusalCode,
    rollback: {
      storageRestored: details.rollback.storageRestored,
      databaseRestored: details.rollback.databaseRestored,
    },
    batchSha256: options.context.report.batchSha256,
    packageCountReported: options.context.packageCount,
    backupRetainedForInspection: true,
    storageSnapshotRetainedForInspection: true,
  };
  await writePrivateFile(
    join(options.inputs.outputDirectory, formalReceiptName),
    `${JSON.stringify(receipt, null, 2)}\n`,
  );
}
/**
 * 正式导入核心：实时执行授权（任何副作用前）→ 核销批准书 → 建立恢复状态机 →
 * 管理员实时身份核验 → 受保护相位内建备份 → 单遍导入自证 → 确定性双向回滚 →
 * 成功承诺（PASS 收据 + success_committed）两个匹配恢复副本完好时落盘；承诺之后
 * 的副本销毁与 finalized 为尽力而为收尾，失败只进入 cleanup_incomplete。
 */
async function runFormalImportCore(
  argv: readonly string[],
  env: NodeJS.ProcessEnv,
  hooks: FormalImportHooks = {},
  seam: FormalImportTestSeam = {},
  coreGate: { readonly productionRealCountGate?: boolean } = {},
): Promise<number> {
  const inputs = resolveFormalInputs(argv, env);
  // 门禁 1：任何作业/来源/暂存/输出/备份/存储/数据库副作用之前的实时执行授权。
  // 授权对象由服务端组装（实时用户表读取 + problem.import 权限），任何调用方
  // 提供的布尔值或操作员身份都不能伪造。检查失败或权限缺失即刻拒绝且零改动。
  {
    const authorizationDatabase = createPostgresDatabase({
      connectionString: inputs.databaseUrl,
      maxConnections: 2,
      applicationName: "urmotiv-history-import-formal-authz",
    });
    try {
      const authorized = await importExecutionAuthorizationFor(authorizationDatabase).canImport({
        requestedByUserId: inputs.principal,
        signal: AbortSignal.timeout(60_000),
      });
      if (!authorized) {
        throw new HistoryMigrationError(
          "NOT_AUTHORIZED",
          "正式导入实时执行授权未通过：拒绝执行且未产生任何改动。",
        );
      }
    } catch (error) {
      if (error instanceof HistoryMigrationError) {
        await authorizationDatabase.close().catch(() => undefined);
        throw error;
      }
      if (error instanceof ProblemPackageTemporaryError) {
        await authorizationDatabase.close().catch(() => undefined);
        throw new HistoryMigrationError(
          "NOT_AUTHORIZED",
          "正式导入实时执行授权检查暂时失败：拒绝执行且未产生任何改动。",
        );
      }
      await authorizationDatabase.close().catch(() => undefined);
      throw error;
    }
    await authorizationDatabase.close().catch(() => undefined);
  }
  const validation = await validateFormalGate(inputs, env, hooks);
  const { context, phase2, targetApproval } = validation;
  if (coreGate.productionRealCountGate) {
    assertProductionFormalImportCount(context.packageCount);
  }
  // 单次核销必须先于任何数据库连接；核销记录只含摘要。
  await consumeFormalApprovalNonce(inputs.privateRoot, targetApproval);
  await startFormalRecoveryState(
    inputs.outputDirectory,
    computeFormalGenerationBinding(targetApproval),
  );
  const coreOptions: FormalCoreOptions = { inputs, context, phase2, seam, targetApproval };

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
        !databaseResult.readOnlyEnforced
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
    if (beforeDatabaseInventory.contentSha256 !== targetApproval.prestateDatabaseInventorySha256) {
      throw new HistoryMigrationError("INVALID_METADATA", "正式门禁：当前数据库状态与批准书预状态不一致。");
    }
    if (
      beforeStorageInventory.contentInventorySha256 !== targetApproval.prestateStorageInventorySha256
    ) {
      throw new HistoryMigrationError("INVALID_METADATA", "正式门禁：当前存储状态与批准书预状态不一致。");
    }
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
    // 第一步：管理员实时身份核验后，在 backup_create_pending 相位建立并核对备份。
    await verifyAdministratorConnectionIdentity(admin, inputs, targetApproval);
    const maintenance = await probeMaintenanceConnectionIdentity(admin, inputs.adminUrl);
    await advanceFormalRecoveryPhase(inputs.outputDirectory, "pre_backup", "backup_create_pending");
    const backup = await createVerifiedFormalBackup({
      admin,
      inputs,
      outputDirectory: inputs.outputDirectory,
      beforeDatabaseInventory,
      beforeStorageInventory,
    });
    const backupVerifiedState = await advanceFormalRecoveryPhase(
      inputs.outputDirectory,
      "backup_create_pending",
      "backup_verified",
    );
    await writeNewPrivateJson(join(inputs.outputDirectory, formalBackupEvidenceName), {
      generatedAt: new Date().toISOString(),
      approvalNonceSha256: sha256Hex(`nonce-v1|${targetApproval.nonce}`),
      approvalGenerationBindingSha256: computeFormalGenerationBinding(targetApproval),
      maintenanceLiveAdminFingerprintSha256: maintenance.liveAdminFingerprintSha256,
      maintenanceClusterIdentitySha256: maintenance.clusterIdentitySha256,
      maintenanceAdminUrlSha256: maintenance.adminUrlSha256,
      targetDatabaseName: inputs.databaseName,
      recoveryPhase: backupVerifiedState.phase,
      recoveryStateSha256: recoveryStateSha256(backupVerifiedState),
    });
    await writePrivateFile(
      join(inputs.outputDirectory, formalBackupVerifiedMarkerName),
      `${new Date().toISOString()}\n`,
    );

    // 第二步：单遍导入 + 自证核对；任何失败/不一致都走确定性双向回滚。
    let refusalCode = "import_refused";
    const importDatabase = createPostgresDatabase({
      connectionString: inputs.databaseUrl,
      maxConnections: 8,
      applicationName: "urmotiv-history-import-formal-single-pass",
    });
    await advanceFormalRecoveryPhase(inputs.outputDirectory, "backup_verified", "import_started");
    let pass: FormalImportPassSummary;
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
      await advanceFormalRecoveryPhase(inputs.outputDirectory, "import_started", "rollback_pending");
      const rollback = await rollbackFormalMutation({
        admin,
        inputs,
        backupName: backup.backupName,
        storageSnapshotDirectory,
        beforeDatabaseInventory,
        beforeStorageInventory,
      });
      await concludeRefusedRun({
        coreOptions,
        admin,
        backupName: backup.backupName,
        storageSnapshotDirectory,
        rollback,
        refusalCode,
        seam,
      });
      if (error instanceof HistoryMigrationError) {
        if (error.code === "INVALID_ARGUMENTS") throw error;
        throw new HistoryMigrationError("INVALID_METADATA", "正式导入已中止并回滚。");
      }
      throw new HistoryMigrationError("INVALID_METADATA", "正式导入已中止并回滚。");
    }
    await importDatabase.close().catch(() => undefined);
    await advanceFormalRecoveryPhase(inputs.outputDirectory, "import_started", "import_verified");

    // 第三步：清理相位内的关键提交。PASS 收据与 success_committed 相位必须
    // 在两个匹配恢复副本（数据库备份 + 存储快照）都完好时写盘；这一窗口内
    // 任何失败都联合回滚、签名 FAIL 并消灭 PASS 标记。承诺持久化之后，
    // 销毁恢复副本与写 finalized 只是尽力而为的收尾：失败只诚实进入
    // cleanup_incomplete，绝不允许把已提交的 PASS 结果反转成失败报告。
    await advanceFormalRecoveryPhase(inputs.outputDirectory, "import_verified", "cleanup_pending");
    try {
      await seam.finalization?.beforePassReceiptWrite?.();
      await writeFormalReceiptPASS(coreOptions, pass);
      await seam.finalization?.beforeSuccessCommittedWrite?.();
      await advanceFormalRecoveryPhase(
        inputs.outputDirectory,
        "cleanup_pending",
        "success_committed",
      );
    } catch {
      await retireFormalPassArtifacts(inputs.outputDirectory).catch(() => undefined);
      await advanceFormalRecoveryPhase(inputs.outputDirectory, "cleanup_pending", "rollback_pending");
      const rollback = await rollbackFormalMutation({
        admin,
        inputs,
        backupName: backup.backupName,
        storageSnapshotDirectory,
        beforeDatabaseInventory,
        beforeStorageInventory,
      });
      await concludeRefusedRun({
        coreOptions,
        admin,
        backupName: backup.backupName,
        storageSnapshotDirectory,
        rollback,
        refusalCode: "finalization_commit_refused",
        seam,
      });
      throw new HistoryMigrationError(
        "INTERNAL_ERROR",
        "正式导入已写入，但成功承诺未能在两个恢复副本完好时落盘；数据库与存储已联合回滚并核验。",
      );
    }
    // 成功承诺已持久化：以下每步失败都只能遗留清理待办，不得改变数据结论。
    let databaseBackupRetained = true;
    let storageSnapshotRetained = true;
    let cleanupIncomplete = false;
    try {
      await seam.finalization?.afterPassReceiptWrite?.();
      await dropDatabaseForce(admin, backup.backupName);
      databaseBackupRetained = false;
      await seam.finalization?.afterDatabaseBackupDrop?.();
      await rm(storageSnapshotDirectory, { recursive: true, force: true });
      storageSnapshotRetained = false;
      await seam.finalization?.beforeFinalizedWrite?.();
      await advanceFormalRecoveryPhase(inputs.outputDirectory, "success_committed", "finalized");
    } catch {
      cleanupIncomplete = true;
      await advanceFormalRecoveryPhase(
        inputs.outputDirectory,
        "success_committed",
        "cleanup_incomplete",
      ).catch(() => undefined);
    }
    if (cleanupIncomplete) {
      const pendingState = await readFormalRecoveryState(inputs.outputDirectory);
      await writeNewPrivateJson(join(inputs.outputDirectory, formalCleanupPendingEvidenceName), {
        version: 1,
        generatedAt: new Date().toISOString(),
        receiptVerdict: "PASS",
        passReceiptWritten: true,
        recoveryPhase: pendingState?.phase ?? "success_committed",
        recoveryStateSha256:
          pendingState === undefined ? "" : recoveryStateSha256(pendingState),
        approvalNonceSha256: sha256Hex(`nonce-v1|${targetApproval.nonce}`),
        approvalGenerationBindingSha256: computeFormalGenerationBinding(targetApproval),
        databaseBackupRetained,
        storageSnapshotRetained,
      }).catch(() => {
        console.error("正式导入：收尾未完成证据写入失败（成功承诺与状态机仍然有效）。");
      });
      console.error(
        "正式导入：数据已提交成功，恢复副本清理未完成；状态机处于 cleanup_incomplete，可调用 completeFormalFinalizationCleanup 幂等续做。",
      );
    }
    console.log(
      `正式导入: PASS; 包数量=${context.packageCount}; 缺失题解=${pass.solutionStates.nullSolutionCount}; 空题解=${pass.solutionStates.emptySolutionCount}; 收尾=${cleanupIncomplete ? "cleanup_incomplete" : "finalized"}`,
    );
    return 0;
  } finally {
    await admin.close().catch(() => undefined);
  }
}
/**
 * PASS 结论的全部权威工件退役：规范 PASS 标记与规范 PASS 收据都被原子改名
 * 隔离到 retired 名字后，写退役证据。任何一步失败在明确检查后中止，调用方
 * 绝不写 FAIL/REFUSED 收据，拒绝/失败的结论就不可能留下权威 PASS 工件。
 */

async function quarantinePassArtifact(fromPath: string, toPath: string): Promise<boolean> {
  if (!(await privateRegularFileExists(fromPath))) {
    return true;
  }
  if (await privateRegularFileExists(toPath)) {
    await removePrivateRegularFile(toPath).catch(() => undefined);
  }
  if (await privateRegularFileExists(toPath)) {
    return false;
  }
  await movePrivateFileNoReplace(fromPath, toPath);
  return !(await privateRegularFileExists(fromPath));
}
async function retireFormalPassArtifacts(outputDirectory: string): Promise<void> {
  const markerPath = join(outputDirectory, formalPassMarkerName);
  const retiredMarkerPath = join(outputDirectory, formalRetiredPassMarkerName);
  const receiptPath = join(outputDirectory, formalReceiptName);
  const retiredReceiptPath = join(outputDirectory, formalRetiredPassReceiptName);

  if (!(await quarantinePassArtifact(markerPath, retiredMarkerPath))) {
    throw new HistoryMigrationError(
      "INTERNAL_ERROR",
      "正式导入：PASS 承诺标记无法移除或改名，拒绝产出失败结论。",
    );
  }

  let passReceiptRetired = false;
  let passReceiptSha256 = "";
  // 规范收据读取失败（缺失、被目录占用、损坏）都按“规范名上无权威 PASS”
  // 处理并继续退役；只有确认存在权威 PASS 收据却无法隔离时才会中止结论。
  const receiptRead = await readPrivateJsonWithDigest(receiptPath).catch(() => undefined);
  if (receiptRead !== undefined) {
    const receipt = (receiptRead.value ?? null) as { readonly verdict?: unknown } | null;
    if (receipt !== null && receipt.verdict === "PASS") {
      if (!(await quarantinePassArtifact(receiptPath, retiredReceiptPath))) {
        throw new HistoryMigrationError(
          "INTERNAL_ERROR",
          "正式导入：权威 PASS 收据无法改名隔离，拒绝产出失败结论。",
        );
      }
      passReceiptRetired = true;
      passReceiptSha256 = receiptRead.sha256;
    }
  }
  if (!passReceiptRetired && (await privateRegularFileExists(retiredReceiptPath))) {
    try {
      const retiredRead = await readPrivateJsonWithDigest(retiredReceiptPath);
      const retiredReceipt = (retiredRead.value ?? null) as { readonly verdict?: unknown } | null;
      if (retiredReceipt !== null && retiredReceipt.verdict === "PASS") {
        passReceiptRetired = true;
        passReceiptSha256 = retiredRead.sha256;
      }
    } catch {
      // 退役副本不可读：标记退役状态无法确认，保留 markerRetired 证据继续。
    }
  }
  try {
    await writePrivateFile(
      join(outputDirectory, formalPassRetirementEvidenceName),
      `${JSON.stringify(
        {
          version: 1,
          generatedAt: new Date().toISOString(),
          markerRetired: true,
          passReceiptRetired,
          passReceiptSha256,
          retirementReason: "refusal-conclusion-prologue",
        },
        null,
        2,
      )}\n`,
    );

  } catch {
    throw new HistoryMigrationError(
      "INTERNAL_ERROR",
      "正式导入：PASS 工件已隔离但退役证据写盘失败，拒绝产出失败结论。",
    );
  }
}

/**
 * 失败路径共享收尾：PASS 标记先退役（强校验，不达标即中止且不产出任何
 * 结论），再在 rollback_pending 相位完成回滚后，按 proof 定级转移。
 */
async function concludeRefusedRun(options: {
  readonly coreOptions: FormalCoreOptions;
  readonly admin: DatabaseHandle;
  readonly backupName: string;
  readonly storageSnapshotDirectory: string;
  readonly rollback: RollbackProof;
  readonly refusalCode: string;
  readonly seam: FormalImportTestSeam;
}): Promise<{ readonly verified: boolean }> {
  const {
    coreOptions,
    admin,
    backupName,
    storageSnapshotDirectory,
    rollback,
    refusalCode,
    seam,
  } = options;
  const { outputDirectory } = coreOptions.inputs;
  const approval = coreOptions.targetApproval;
  const restoredAll = rollback.storageRestored && rollback.databaseRestored;
  // 结论域内绝不出现「拒绝收据 + 权威 PASS」共存：标记与收据退役失败时直接中止。
  await retireFormalPassArtifacts(outputDirectory);
  const terminalState = await advanceFormalRecoveryPhase(
    outputDirectory,
    "rollback_pending",
    restoredAll ? "rollback_verified" : "rollback_refused",
  );

  await writeNewPrivateJson(join(outputDirectory, formalRollbackEvidenceName), {
    version: 1,
    generatedAt: new Date().toISOString(),
    approvalNonceSha256: sha256Hex(`nonce-v1|${approval.nonce}`),
    approvalGenerationBindingSha256: computeFormalGenerationBinding(approval),
    recoveryPhase: terminalState.phase,
    recoveryStateSha256: recoveryStateSha256(terminalState),
    storageRestored: rollback.storageRestored,
    databaseRestored: rollback.databaseRestored,
    backupRetained: true,
    storageSnapshotRetained: true,
  }).catch(() => undefined);
  // 回滚证据（状态机终相 + 回滚标记）先于拒绝收据写盘：即使收据路径被
  // 占用导致报错，现场仍保留可审计的已验证回滚证据。
  if (restoredAll) {
    await writePrivateFile(
      join(outputDirectory, formalRollbackVerifiedMarkerName),
      `${new Date().toISOString()}\n`,
    ).catch(() => undefined);
  } else {
    await writePrivateFile(
      join(outputDirectory, formalRestoreRefusedMarkerName),
      `${new Date().toISOString()}\n`,
    ).catch(() => undefined);
  }
  if (restoredAll) {
    // 回滚证明已确认数据复原：残余恢复工件（备份库、存储快照）在
    // rollback_verified 相位内先行清除；终相推进延迟到拒绝收据写盘之后。
    // 收据路径被占用时现场仍保留 rollback_verified 相位与全部回滚证据。
    await dropDatabaseForce(admin, backupName).catch(() => undefined);
    await rm(storageSnapshotDirectory, { recursive: true, force: true }).catch(() => undefined);
  }
  // 拒绝收据写盘失败时中止：现场仍保留回滚证据、终相状态机与收尾事实。
  await seam.refusal?.beforeRefusalReceiptWrite?.();
  try {
    await writeFormalReceiptRefused(coreOptions, { refusalCode, rollback });
  } catch {
    throw new HistoryMigrationError(
      "INTERNAL_ERROR",
      "正式导入：拒绝收据写盘失败；回滚证据与恢复状态机已保留，PASS 标记已退役。",
    );
  }
  if (restoredAll) {
    await advanceFormalRecoveryPhase(outputDirectory, "rollback_verified", "cleanup_pending")
      .catch(() => undefined);
    await advanceFormalRecoveryPhase(outputDirectory, "cleanup_pending", "finalization_refused")
      .catch(() => undefined);
  } else {
    // 回滚未证明：保留备份工件，收据与工件同代绑定。
    await advanceFormalRecoveryPhase(outputDirectory, "rollback_refused", "finalization_refused")
      .catch(() => undefined);
  }
  return { verified: restoredAll };
}

/**
 * PASS 承诺持久化后的清理续做入口：状态机处于 cleanup_incomplete 或
 * success_committed 时可幂等调用。先核对 PASS 收据版本、结论与目标命名，
 * 再用活动连接核对维护身份，随后删除备份库与存储快照并进入 finalized。
 * 任一中间失败都会保留当前相位，可安全重试；绝不在承诺之前销毁副本。
 */
export async function completeFormalFinalizationCleanup(args: {
  readonly outputDirectory: string;
  readonly adminUrl: string;
}): Promise<{ readonly phase: FormalRecoveryPhase }> {
  const state = await readFormalRecoveryState(args.outputDirectory);
  if (state === undefined) {
    throw new HistoryMigrationError("INVALID_METADATA", "恢复状态机尚未建立，无法续做收尾。");
  }
  if (state.phase !== "cleanup_incomplete" && state.phase !== "success_committed") {
    throw new HistoryMigrationError(
      "INVALID_METADATA",
      `恢复状态机相位 ${state.phase} 不允许续做正式收尾。`,
    );
  }
  const receiptPayload = (await readPrivateJsonWithDigest(
    join(args.outputDirectory, formalReceiptName),
  )).value;
  const receipt = receiptPayload as {
    version?: unknown;
    verdict?: unknown;
    target?: unknown;
    approvalBinding?: unknown;
    recoveryGeneration?: unknown;
  };
  const target = receipt.target as {
    host?: unknown;
    port?: unknown;
    user?: unknown;
    database?: unknown;
  } | undefined;
  const approvalBinding = receipt.approvalBinding as
    | {
        nonceSha256?: unknown;
        generationBindingSha256?: unknown;
        approvedByActorSha256?: unknown;
        branchName?: unknown;
        gitCommitSha256?: unknown;
        expectedFormalImportCount?: unknown;
      }
    | undefined;
  const recoveryGeneration = receipt.recoveryGeneration as
    | { phase?: unknown; stateSha256?: unknown }
    | undefined;
  const hex64 = (value: unknown): value is string =>
    typeof value === "string" && digestPattern.test(value);
  if (
    receipt.version !== 4 ||
    receipt.verdict !== "PASS" ||
    target === null ||
    target === undefined ||
    typeof target !== "object" ||
    typeof target.host !== "string" ||
    typeof target.port !== "string" ||
    typeof target.user !== "string" ||
    typeof target.database !== "string" ||
    approvalBinding === null ||
    approvalBinding === undefined ||
    !hex64(approvalBinding.nonceSha256) ||
    !hex64(approvalBinding.generationBindingSha256) ||
    !hex64(approvalBinding.approvedByActorSha256) ||
    typeof approvalBinding.branchName !== "string" ||
    !hex64(approvalBinding.gitCommitSha256) ||
    typeof approvalBinding.expectedFormalImportCount !== "number" ||
    recoveryGeneration === null ||
    recoveryGeneration === undefined ||
    typeof recoveryGeneration.phase !== "string" ||
    !hex64(recoveryGeneration.stateSha256)
  ) {
    throw new HistoryMigrationError("INVALID_METADATA", "PASS 收据结构不完整，拒绝续做收尾。");
  }
  assertFormalDatabaseName(target.database);
  const backupEvidencePayload = await readPrivateJson(
    join(args.outputDirectory, formalBackupEvidenceName),
  );
  const backupEvidence = backupEvidencePayload as {
    approvalNonceSha256?: unknown;
    approvalGenerationBindingSha256?: unknown;
    targetDatabaseName?: unknown;
    maintenanceLiveAdminFingerprintSha256?: unknown;
    maintenanceClusterIdentitySha256?: unknown;
    maintenanceAdminUrlSha256?: unknown;
  };
  // 收据写盘时刻的相位可能是 cleanup_pending（先收据后提交）或
  // success_committed（原地补做），其后合法相位只能是同记账代的
  // success_committed 或 cleanup_incomplete；用允许转移对 + 记账代绑定
  // 拒绝跨批次重放。
  const recordedHashFor = (phase: FormalRecoveryPhase): string =>
    recoveryStateSha256({
      version: 1,
      phase,
      generationBindingSha256: state.generationBindingSha256,
      updatedAt: state.updatedAt,
    });
  const recordedGenerationKnown =
    (recoveryGeneration.phase === "cleanup_pending" ||
      recoveryGeneration.phase === "success_committed") &&
    recoveryGeneration.stateSha256 === recordedHashFor(recoveryGeneration.phase);
  const liveSuccessorAllowed =
    (recoveryGeneration.phase === "cleanup_pending" &&
      (state.phase === "success_committed" || state.phase === "cleanup_incomplete")) ||
    (recoveryGeneration.phase === "success_committed" &&
      (state.phase === "success_committed" || state.phase === "cleanup_incomplete"));
  if (!recordedGenerationKnown || !liveSuccessorAllowed) {
    throw new HistoryMigrationError(
      "INVALID_METADATA",
      "PASS 收据记录的恢复世代与磁盘状态机不一致，拒绝续做收尾。",
    );
  }
  if (
    typeof backupEvidence !== "object" ||
    backupEvidence.approvalNonceSha256 !== approvalBinding.nonceSha256 ||
    backupEvidence.approvalGenerationBindingSha256 !== approvalBinding.generationBindingSha256 ||
    backupEvidence.targetDatabaseName !== target.database ||
    !hex64(backupEvidence.maintenanceLiveAdminFingerprintSha256) ||
    !hex64(backupEvidence.maintenanceClusterIdentitySha256) ||
    !hex64(backupEvidence.maintenanceAdminUrlSha256)
  ) {
    throw new HistoryMigrationError(
      "INVALID_METADATA",
      "备份证据与 PASS 收据的批准/目标绑定不一致，拒绝续做收尾。",
    );
  }
  const admin = createPostgresDatabase({
    connectionString: args.adminUrl,
    maxConnections: 2,
    applicationName: "urmotiv-history-import-formal-cleanup",
  });
  try {
    const live = await probeMaintenanceConnectionIdentity(admin, args.adminUrl);
    if (
      live.liveAdminFingerprintSha256 !== backupEvidence.maintenanceLiveAdminFingerprintSha256 ||
      live.clusterIdentitySha256 !== backupEvidence.maintenanceClusterIdentitySha256 ||
      live.adminUrlSha256 !== backupEvidence.maintenanceAdminUrlSha256
    ) {
      throw new HistoryMigrationError(
        "INVALID_METADATA",
        "续做收尾的维护连接/集群/连接串身份与备份证据不一致。",
      );
    }
    const targetRow = await admin.query<{ present: unknown }>(
      sql`select 1 as present from pg_database where datname = ${target.database}`,
    );
    if (targetRow.length !== 1) {
      throw new HistoryMigrationError(
        "INVALID_METADATA",
        "续做收尾的维护连接所在集群不包含收据目标库。",
      );
    }
    await dropDatabaseForce(admin, `${target.database}${formalDatabaseBackupSuffix}`);
    await rm(join(args.outputDirectory, formalStorageSnapshotName), {
      recursive: true,
      force: true,
    });
    const finalized = await advanceFormalRecoveryPhase(
      args.outputDirectory,
      state.phase,
      "finalized",
    );
    return { phase: finalized.phase };
  } finally {
    await admin.close().catch(() => undefined);
  }
}

/** 回环地址集合：仅测试用的绑定入口允许这些主机。 */
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1"]);

/** 合成正式目标：仅回环主机 + urmotiv_formal_ 前缀命名；真实目标在此机械拒绝。 */
export function assertSyntheticFormalDatabaseAllowed(host: string, databaseName: string): void {
  if (!LOOPBACK_HOSTS.has(host) || !/^urmotiv_formal_[a-z0-9_]{1,40}$/.test(databaseName)) {
    throw new HistoryMigrationError(
      "INVALID_ARGUMENTS",
      "测试绑定入口只允许回环主机上的 urmotiv_formal_ 合成正式目标。",
    );
  }
}

/** 生产入口：任何 urmotiv_ 前缀库名都拒绝，合成命名无法伪装成正式目标。 */
export function assertProductionFormalDatabaseName(databaseName: string): void {
  if (/^urmotiv_/.test(databaseName)) {
    throw new HistoryMigrationError("INVALID_ARGUMENTS", "正式目标不得使用 urmotiv_ 前缀命名。");
  }
}

/** 生产入口数量闸门：只接受指定批次的精确包数量；绑定测试入口可跳过该闸门。 */
export function assertProductionFormalImportCount(packageCount: number): void {
  if (packageCount !== designatedRealFormalImportCount) {
    throw new HistoryMigrationError(
      "INVALID_METADATA",
      "正式门禁：生产入口只接受指定批次的精确导入数量。",
    );
  }
}

/** 正式唯一生产入口：拒绝 urmotiv_ 前缀；不接受故障注入面或 hook。 */
export async function runFormalImport(
  argv: readonly string[],
  env: NodeJS.ProcessEnv,
): Promise<number> {
  try {
    const inputs = resolveFormalInputs(argv, env);
    assertProductionFormalDatabaseName(inputs.databaseName);
    return await runFormalImportCore(argv, env, {}, {}, { productionRealCountGate: true });
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
 * 测试绑定入口：仅由测试目录的 harness 显式注入 hook/seam 组合；先做回环 +
 * 合成正式命名校验，再运行核心。真实生产目标无法通过该入口（不回环或
 * 非 urmotiv_formal_ 前缀命名即拒绝），生产 CLI 与 server 均不引用。
 */
export async function runFormalImportBound(
  argv: readonly string[],
  env: NodeJS.ProcessEnv,
  seam: FormalImportTestSeam,
  hooks: FormalImportHooks = {},
): Promise<number> {
  try {
    const inputs = resolveFormalInputs(argv, env);
    assertSyntheticFormalDatabaseAllowed(inputs.target.host, inputs.databaseName);
    if (Object.keys(seam).length === 0 && Object.keys(hooks).length === 0) {
      throw new HistoryMigrationError("INVALID_ARGUMENTS", "测试绑定需要提供注入故障面或 hook。");
    }
    return await runFormalImportCore(argv, env, hooks, seam);
  } catch (error: unknown) {
    if (error instanceof HistoryMigrationError) {
      console.error(`正式导入拒绝: ${error.code} | ${error.message}`);
      return error.code === "INVALID_ARGUMENTS" ? 2 : 1;
    }
    console.error("正式导入拒绝: UNCLASSIFIED");
    return 1;
  }
}
