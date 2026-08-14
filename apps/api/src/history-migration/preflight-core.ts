/**
 * 历史导入预检 CLI：确定性对账 + 零数据库变更检查。
 * 命令行只接收环境变量名；路径、身份、标签、提交与摘要值均从环境变量读取。
 * stdout 只输出聚合计数与稳定状态码。
 */
import { join } from "node:path";

import { createPostgresDatabase } from "@urmotiv/database";

import { sha256Hex } from "./digests";
import { HistoryMigrationError } from "./errors";
import { packageReportPayloadSchema } from "./import-phase";
import {
  verifyApprovedPackageSourceIdentities,
  type VerifyApprovedPackageSourceIdentitiesOptions,
} from "./core";
import {
  historyImportRequiredTables,
  bindAuthoritativePackageIdentities,
  bindAuthoritativeRevisionContent,
  reconcileHistoryImportBatch,
  recomputeSourceBindingsIdentity,
  runZeroMutationDatabasePreflight,
  scanPackageDirectory,
  summarizePackageEntryNames,
  type HistoryImportReconciliation,
  type ZeroMutationDatabaseResult,
} from "./import-preflight";
import {
  assertPathsInsidePrivateRoot,
  assertNewOutputPath,
  assertPrivateDirectoryMode,
  privateRegularFileExists,
  readPrivateJsonWithDigest,
  removePrivateRegularFile,
  writePrivateFile,
} from "./private-files";
import {
  assertPermittedPhase2EvidenceRoot,
  verifyExecutionProvenance,
  type ExecutionProvenance,
} from "./execution-provenance";

export const allowedTargetClasses = ["scratch-temporary", "designated-validation", "designated-real"] as const;
export const digestPattern = /^[a-f0-9]{64}$/;
export type TargetClass = (typeof allowedTargetClasses)[number];
export const preflightReceiptName = "history-import-preflight.private.json";
export const preflightPassMarkerName = "PREFLIGHT_PASS";

export interface PreflightInputs {
  readonly privateRoot: string;
  readonly listMetadata: string;
  readonly packageDirectory: string;
  readonly outputDirectory: string;
  readonly materializedDirectory: string;
  readonly preparedDirectory: string;
  readonly approvalFile: string;
  readonly databaseUrl: string;
  readonly groupingFile: string;
  readonly tagId: string;
  readonly gitCommit: string;
  readonly targetClass: TargetClass;
  readonly principal: string;
  readonly executionId: string;
  readonly expectedBatchSha256: string;
  readonly expectedSourceBindingsSha256: string;
  readonly importManifest: string | undefined;
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

export function resolvePreflightInputs(
  argv: readonly string[],
  env: NodeJS.ProcessEnv,
): PreflightInputs {
  const values = new Map<string, string>();
  for (const argument of argv) {
    const match = /^--([a-z0-9-]+)=(.*)$/s.exec(argument);
    if (match === null || match[1] === undefined || match[2] === undefined) {
      throw new HistoryMigrationError("INVALID_ARGUMENTS", "预检参数必须是 --名称=值 形式。");
    }
    if (values.has(match[1])) {
      throw new HistoryMigrationError("INVALID_ARGUMENTS", "命令行参数重复。");
    }
    values.set(match[1], match[2]);
  }
  const allowedKeys = new Set([
    "private-root-env",
    "list-metadata-env",
    "package-directory-env",
    "output-directory-env",
    "materialized-directory-env",
    "prepared-directory-env",
    "approval-file-env",
    "database-url-env",
    "grouping-file-env",
    "tag-id-env",
    "git-commit-env",
    "target-class-env",
    "principal-env",
    "execution-id-env",
    "batch-sha256-env",
    "source-bindings-sha256-env",
    "import-manifest-env",
  ]);
  for (const key of values.keys()) {
    if (!allowedKeys.has(key)) {
      throw new HistoryMigrationError("INVALID_ARGUMENTS", "命令行包含未批准的参数。");
    }
  }
  const targetClassRaw = environmentValue(values, env, "target-class-env");
  if (!allowedTargetClasses.includes(targetClassRaw as TargetClass)) {
    throw new HistoryMigrationError("INVALID_ARGUMENTS", "target-class 环境变量值不合法。");
  }
  const importManifestVariable = values.get("import-manifest-env");
  const importManifest = importManifestVariable === undefined
    ? undefined
    : env[importManifestVariable];
  if (importManifestVariable !== undefined && (importManifest === undefined || importManifest.length === 0)) {
    throw new HistoryMigrationError("INVALID_ARGUMENTS", "import-manifest-env 指定的环境变量未设置。");
  }
  const expectedBatchSha256 = environmentValue(values, env, "batch-sha256-env");
  const expectedSourceBindingsSha256 = environmentValue(
    values,
    env,
    "source-bindings-sha256-env",
  );
  if (!digestPattern.test(expectedBatchSha256) || !digestPattern.test(expectedSourceBindingsSha256)) {
    throw new HistoryMigrationError("INVALID_ARGUMENTS", "批准摘要环境变量值不合法。");
  }
  return {
    privateRoot: environmentValue(values, env, "private-root-env"),
    listMetadata: environmentValue(values, env, "list-metadata-env"),
    packageDirectory: environmentValue(values, env, "package-directory-env"),
    outputDirectory: environmentValue(values, env, "output-directory-env"),
    materializedDirectory: environmentValue(values, env, "materialized-directory-env"),
    preparedDirectory: environmentValue(values, env, "prepared-directory-env"),
    approvalFile: environmentValue(values, env, "approval-file-env"),
    databaseUrl: environmentValue(values, env, "database-url-env"),
    groupingFile: environmentValue(values, env, "grouping-file-env"),
    tagId: environmentValue(values, env, "tag-id-env"),
    gitCommit: environmentValue(values, env, "git-commit-env"),
    targetClass: targetClassRaw as TargetClass,
    principal: environmentValue(values, env, "principal-env"),
    executionId: environmentValue(values, env, "execution-id-env"),
    expectedBatchSha256,
    expectedSourceBindingsSha256,
    importManifest,
  };
}

export interface HistoryImportPreflightHooks {
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

export async function runHistoryImportPreflight(
  argv: readonly string[],
  env: NodeJS.ProcessEnv,
  hooks: HistoryImportPreflightHooks = {},
): Promise<number> {
  const inputs = resolvePreflightInputs(argv, env);
  await assertPrivateDirectoryMode(inputs.privateRoot);
  await assertPrivateDirectoryMode(inputs.outputDirectory);
  const receiptPath = join(inputs.outputDirectory, preflightReceiptName);
  const markerPath = join(inputs.outputDirectory, preflightPassMarkerName);
  const pathChecks: { path: string; kind: "existing" | "new" }[] = [
    { path: inputs.listMetadata, kind: "existing" },
    { path: inputs.materializedDirectory, kind: "existing" },
    { path: inputs.preparedDirectory, kind: "existing" },
    { path: inputs.approvalFile, kind: "existing" },
    { path: inputs.packageDirectory, kind: "existing" },
    { path: inputs.outputDirectory, kind: "existing" },
    { path: inputs.groupingFile, kind: "existing" },
    { path: receiptPath, kind: "new" },
    { path: markerPath, kind: "new" },
  ];
  if (inputs.importManifest !== undefined) {
    pathChecks.push({ path: inputs.importManifest, kind: "existing" });
  }
  await assertPathsInsidePrivateRoot(inputs.privateRoot, pathChecks);
  await assertNewOutputPath(receiptPath);
  await assertNewOutputPath(markerPath);

  const provenance = await (hooks.verifyProvenance ?? verifyExecutionProvenance)(inputs.gitCommit);
  const authoritativeIdentities = await (
    hooks.verifySourceIdentities ?? verifyApprovedPackageSourceIdentities
  )({
    privateRootDirectory: inputs.privateRoot,
    materializedDirectory: inputs.materializedDirectory,
    metadataFile: inputs.listMetadata,
    preparedDirectory: inputs.preparedDirectory,
    approvalFile: inputs.approvalFile,
  });

  const metadataRead = await readPrivateJsonWithDigest(inputs.listMetadata);
  const reportRead = await readPrivateJsonWithDigest(join(inputs.packageDirectory, "report.json"));
  const groupingRead = await readPrivateJsonWithDigest(inputs.groupingFile);
  const reportParsed = packageReportPayloadSchema.parse(reportRead.value);
  const scan = await scanPackageDirectory(inputs.packageDirectory, reportParsed);
  const authoritativeRevisionIdentitySha256 = bindAuthoritativeRevisionContent(
    scan.expectedRevisionInventory,
    authoritativeIdentities,
  );
  const authoritativeContentMatches = true;
  const authoritativePackageIdentitySha256 = bindAuthoritativePackageIdentities(
    reportParsed,
    authoritativeIdentities,
  );
  const contentSummary = summarizePackageEntryNames(scan.entryNames);
  const groupingMetadataIds = groupingIds(groupingRead.value);

  let manifest: unknown;
  let manifestSha256: string | undefined;
  if (inputs.importManifest !== undefined) {
    const manifestRead = await readPrivateJsonWithDigest(inputs.importManifest);
    manifest = manifestRead.value;
    manifestSha256 = manifestRead.sha256;
  }

  const reconciliation: HistoryImportReconciliation = reconcileHistoryImportBatch({
    listMetadata: metadataRead.value,
    packageReport: reportRead.value,
    packageEntryNames: scan.entryNames,
    expectedRecordCount: authoritativeIdentities.length,
    importManifest: manifest,
    missingPackageFileCount: scan.missingPackageFileCount,
    packageBytesMismatchCount: scan.packageBytesMismatchCount,
    packageDigestMismatchCount: scan.packageDigestMismatchCount,
    unreportedExtraPackageCount: scan.unreportedExtraPackageCount,
    groupingMetadataIds,
  });

  const sourceBindingsSha256 = recomputeSourceBindingsIdentity(reportParsed);
  const approvedInputMatches =
    reportParsed.batchSha256 === inputs.expectedBatchSha256 &&
    sourceBindingsSha256 === inputs.expectedSourceBindingsSha256;
  const authoritativeCountMatches =
    authoritativeIdentities.length === scan.expectedRevisionInventory.revisionCount;

  const database = createPostgresDatabase({
    connectionString: inputs.databaseUrl,
    maxConnections: 1,
    applicationName: "urmotiv-history-import-preflight",
  });
  let databaseResult: ZeroMutationDatabaseResult;
  try {
    databaseResult = await runZeroMutationDatabasePreflight(database, {
      requiredTagId: inputs.tagId,
      requiredPrincipalId: inputs.principal,
    });
  } finally {
    await database.close();
  }

  const ready =
    reconciliation.verdict === "READY" &&
    approvedInputMatches &&
    authoritativeCountMatches &&
    authoritativeContentMatches &&
    databaseResult.readOnlyEnforced &&
    databaseResult.missingTableCount === 0 &&
    databaseResult.tagPresent === true &&
    databaseResult.principalPresent === true;

  const receipt = {
    version: 3,
    generatedAt: new Date().toISOString(),
    targetClass: inputs.targetClass,
    inputBindings: {
      listMetadataSha256: metadataRead.sha256,
      packageReportSha256: reportRead.sha256,
      groupingSha256: groupingRead.sha256,
      ...(manifestSha256 === undefined ? {} : { importManifestSha256: manifestSha256 }),
      batchSha256: reportParsed.batchSha256,
      sourceBindingsSha256,
      authoritativePackageIdentitySha256,
      authoritativeRevisionIdentitySha256,
      codeInventoryEntryCount: provenance.codeInventoryEntryCount,
      codeInventorySha256: provenance.codeInventorySha256,
      tagIdSha256: sha256Hex(inputs.tagId),
      gitCommitSha256: sha256Hex(inputs.gitCommit),
      principalSha256: sha256Hex(inputs.principal),
      executionIdSha256: sha256Hex(inputs.executionId),
    },
    approvedInputMatches,
    authoritativeContentMatches,
    reconciliation,
    packagesChecked: contentSummary.packagesChecked,
    packagesWithEmbeddedAttachments: contentSummary.packagesWithEmbeddedAttachments,
    packageScan: {
      missingPackageFileCount: scan.missingPackageFileCount,
      packageBytesMismatchCount: scan.packageBytesMismatchCount,
      packageDigestMismatchCount: scan.packageDigestMismatchCount,
      unreportedExtraPackageCount: scan.unreportedExtraPackageCount,
      expectedSampleRows: scan.expectedSampleRows,
      expectedProblemFileRows: scan.expectedProblemFileRows,
      expectedStoredFilesRows: scan.expectedStoredFilesRows,
      expectedStoredBytes: scan.expectedStoredBytes,
      expectedStoredContentSha256: scan.expectedStoredContentSha256,
      expectedRevisionInventory: scan.expectedRevisionInventory,
    },
    database: {
      serverVersion: databaseResult.serverVersion,
      readOnlyEnforced: databaseResult.readOnlyEnforced,
      presentTableCount: databaseResult.presentTableCount,
      missingTableCount: databaseResult.missingTableCount,
      requiredTableCount: historyImportRequiredTables.length,
      rowCounts: databaseResult.rowCounts,
      tagPresent: databaseResult.tagPresent,
      principalPresent: databaseResult.principalPresent,
    },
    verdict: ready ? "READY" : "NOT_READY",
  };
  await writePrivateFile(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`);
  if (ready) {
    await writePrivateFile(markerPath, `${receipt.generatedAt}\n`);
  } else if (await privateRegularFileExists(markerPath)) {
    await removePrivateRegularFile(markerPath);
  }

  console.log(`预检清单记录数: ${reconciliation.listRecordCount}`);
  console.log(`预检包数量: ${reconciliation.packageCount}`);
  console.log(`预检保留材料数: ${reconciliation.preservedMaterialCount}`);
  console.log(`预检内嵌附件数: ${reconciliation.embeddedAttachmentCount}`);
  console.log(`结构性缺失基础题解的包数: ${reconciliation.missingBasicSolutionCount}`);
  console.log(`缺失包文件数: ${scan.missingPackageFileCount}`);
  console.log(`包字节数不一致: ${scan.packageBytesMismatchCount}`);
  console.log(`包摘要不一致: ${scan.packageDigestMismatchCount}`);
  console.log(`未登记额外包: ${scan.unreportedExtraPackageCount}`);
  console.log(`批准输入绑定一致: ${approvedInputMatches ? "是" : "否"}`);
  console.log(`权威候选内容一致: ${authoritativeContentMatches ? "是" : "否"}`);
  console.log(`权威来源数量一致: ${authoritativeCountMatches ? "是" : "否"}`);
  console.log(`数据库只读开关已验证: ${databaseResult.readOnlyEnforced ? "是" : "否"}`);
  console.log(`数据库必需表存在: ${databaseResult.presentTableCount}/${historyImportRequiredTables.length}`);
  console.log(`标签依赖存在: ${databaseResult.tagPresent === true ? "是" : "否"}`);
  console.log(`执行主体存在: ${databaseResult.principalPresent === true ? "是" : "否"}`);
  if (reconciliation.reasonCodes.length > 0) {
    console.log(`不一致原因码: ${reconciliation.reasonCodes.join(", ")}`);
  }
  console.log(`预检结论: ${receipt.verdict}`);
  return ready ? 0 : 1;
}
