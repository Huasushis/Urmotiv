import { z } from "zod";

import { HistoryMigrationError } from "./errors";
import { assertScratchDatabaseName } from "./phase2-postcheck";

export const allowedTargetClasses = ["scratch-temporary", "designated-validation", "designated-real"] as const;
export type TargetClass = (typeof allowedTargetClasses)[number];
export const digestPattern = /^[a-f0-9]{64}$/;

export interface RunnerInputs {
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
export const preflightReceiptSchema = z
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
            databaseRowsSha256: z.string().regex(digestPattern),
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

const importPassTallySchema = z
  .object({
    imported: z.number().int().min(0),
    skipped: z.number().int().min(0),
    failed: z.number().int().min(0),
  })
  .strict();

export const phase2RunReceiptSchema = z
  .object({
    version: z.literal(3),
    targetClass: z.enum(allowedTargetClasses),
    inputBindings: z
      .object({
        preflightReceiptSha256: z.string().regex(digestPattern),
        batchSha256: z.string().regex(digestPattern),
        sourceBindingsSha256: z.string().regex(digestPattern),
        authoritativePackageIdentitySha256: z.string().regex(digestPattern),
        authoritativeRevisionIdentitySha256: z.string().regex(digestPattern),
        manifestIdentitySha256: z.string().regex(digestPattern),
        manifestContentBindingsSha256: z.string().regex(digestPattern),
        codeInventoryEntryCount: z.number().int().positive(),
        codeInventorySha256: z.string().regex(digestPattern),
        tagIdSha256: z.string().regex(digestPattern),
        gitCommitSha256: z.string().regex(digestPattern),
        principalSha256: z.string().regex(digestPattern),
        executionIdSha256: z.string().regex(digestPattern),
      })
      .strict(),
    packageCount: z.number().int().min(0),
    firstPass: importPassTallySchema,
    replayPass: importPassTallySchema,
    postcheck: z
      .object({
        verdict: z.literal("PASS"),
        reasonCodes: z.array(z.string()).length(0),
        driftedTableCount: z.literal(0),
      })
      .passthrough(),
    titleProbePassed: z.literal(true),
    solutionStates: z
      .object({ nullCount: z.number().int().min(0), emptyCount: z.number().int().min(0) })
      .strict(),
    attachmentCount: z.number().int().min(0),
    storedObjectCount: z.number().int().min(0),
    storedBytes: z.number().int().min(0),
    revisionIntegrity: z
      .object({
        firstFullContentSha256: z.string().regex(digestPattern),
        replayFullContentSha256: z.string().regex(digestPattern),
        frozenContentSha256: z.string().regex(digestPattern),
        replayDatabaseRowsSha256: z.string().regex(digestPattern),
      })
      .strict(),
    databaseContentSha256: z.string().regex(digestPattern),
    baselineDatabaseContentSha256: z.string().regex(digestPattern),
    scratchDatabaseFingerprintSha256: z.string().regex(digestPattern),
    verdict: z.literal("PASS"),
  })
  .passthrough();

export type Phase2RunReceipt = z.infer<typeof phase2RunReceiptSchema>;
export type PreflightReceipt = z.infer<typeof preflightReceiptSchema>;
