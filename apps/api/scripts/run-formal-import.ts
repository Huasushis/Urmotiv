/**
 * 正式（designated-real）历史导入入口：唯一允许改变真实数据库的入口。
 * 全部门禁检查（收据、绑定、代码/来源/候选/包清单）都在任何数据库或文件写入之前完成；
 * 任何一项不一致都会机械拒绝，绝不绕过第 1/2 阶段与临时库验收。
 * stdout 只输出聚合计数与稳定结论；题号、路径与内容一律不输出。
 */
import { mkdir, chmod } from "node:fs/promises";
import { join } from "node:path";


import { createPostgresDatabase } from "@urmotiv/database";

import { sha256Hex } from "../src/history-migration/digests";
import { HistoryMigrationError } from "../src/history-migration/errors";
import {
  bindAuthoritativePackageIdentities,
  bindAuthoritativeRevisionContent,
  reconcileHistoryImportBatch,
  recomputeSourceBindingsIdentity,
  runZeroMutationDatabasePreflight,
  scanPackageDirectory,
} from "../src/history-migration/import-preflight";
import { verifyApprovedPackageSourceIdentities } from "../src/history-migration/core";
import { packageReportPayloadSchema } from "../src/history-migration/import-phase";
import {
  captureHistoryImportTableCounts,
  scratchDatabaseNamePattern,
} from "../src/history-migration/phase2-postcheck";
import {
  assertNewOutputPath,
  assertPathsInsidePrivateRoot,
  assertPrivateDirectoryMode,
  readPrivateJsonWithDigest,
  writePrivateFile,
} from "../src/history-migration/private-files";
import {
  assertPermittedPhase2EvidenceRoot,
  verifyExecutionProvenance,
  type ExecutionProvenance,
} from "../src/history-migration/execution-provenance";
import {
  executeImport,
  phase2RunReceiptSchema,
  preflightReceiptSchema,
  type Phase2RunReceipt,
  type PreflightReceipt,
  type ValidationContext,
} from "./run-real-import";
import {
  preflightReceiptName,
  runHistoryImportPreflight,
} from "./preflight-history-import";

const digestPattern = /^[a-f0-9]{64}$/;
const formalReceiptName = "formal-import-receipt.private.json";
const formalPassMarkerName = "FORMAL_IMPORT_PASS";

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
  readonly outputDirectory: string;
  readonly storageRoot: string;
  readonly importOutputDirectory: string;
  readonly databaseUrl: string;
  readonly databaseName: string;
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

function assertFormalDatabaseName(name: string): void {
  if (name.length === 0 || scratchDatabaseNamePattern.test(name)) {
    throw new HistoryMigrationError(
      "INVALID_ARGUMENTS",
      "正式目标库名不合法：不允许使用临时/验收库命名范围。",
    );
  }
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
    "output-directory-env",
    "storage-root-env",
    "import-output-directory-env",
    "database-url-env",
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
  let databaseName: string;
  try {
    const parsed = new URL(databaseUrl);
    if (!parsed.protocol.startsWith("postgres")) {
      throw new Error("not postgres");
    }
    databaseName = decodeURIComponent(parsed.pathname.replace(/^\//, ""));
  } catch {
    throw new HistoryMigrationError("INVALID_ARGUMENTS", "正式目标数据库连接串不合法。");
  }
  assertFormalDatabaseName(databaseName);
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
    outputDirectory: environmentValue(values, env, "output-directory-env"),
    storageRoot: environmentValue(values, env, "storage-root-env"),
    importOutputDirectory: environmentValue(values, env, "import-output-directory-env"),
    databaseUrl,
    databaseName,
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
  const report = packageReportPayloadSchema.parse(reportRead.value);
  const preflight = preflightReceiptSchema.parse(preflightRead.value);
  const phase2 = phase2RunReceiptSchema.parse(phase2Read.value);
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
  // 第 1 阶段收据：现目录内容必须逐字段复现当时的 13 项输入绑定。
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
  // 第 2 阶段收据必须绑定第 1 阶段收据文件的字节摘要。
  if (phase2.inputBindings.preflightReceiptSha256 !== preflightRead.sha256) {
    throw new HistoryMigrationError("INVALID_METADATA", "正式门禁：第 2 阶段收据未绑定第 1 阶段收据。");
  }
  // 第 2 阶段收据与当前目录逐字段复现比对（清单句柄在导入后单独核对）。
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

  // 只读的正式库预检（零变更）：表、标签、执行主体必须满足；同时复现第 1 阶段收据文件。
  await assertNewOutputPath(inputs.outputDirectory);
  await mkdir(inputs.outputDirectory, { mode: 0o700, recursive: false });
  await chmod(inputs.outputDirectory, 0o700);
  const freshPreflightDirectory = join(inputs.outputDirectory, "preflight");
  await assertNewOutputPath(freshPreflightDirectory);
  await mkdir(freshPreflightDirectory, { mode: 0o700, recursive: false });
  await assertNewOutputPath(join(inputs.outputDirectory, formalReceiptName));
  await assertNewOutputPath(join(inputs.outputDirectory, formalPassMarkerName));
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

async function runFormalImportCore(
  argv: readonly string[],
  env: NodeJS.ProcessEnv,
  hooks: FormalImportHooks = {},
): Promise<number> {
  const inputs = resolveFormalInputs(argv, env);
  const validation = await validateFormalGate(inputs, env, hooks);
  const { context, phase2 } = validation;

  const database = createPostgresDatabase({
    connectionString: inputs.databaseUrl,
    maxConnections: 8,
    applicationName: "urmotiv-history-import-formal",
  });
  try {
    const databaseResult = await runZeroMutationDatabasePreflight(database, {
      requiredTagId: inputs.tagId,
      requiredPrincipalId: inputs.principal,
    });
    if (
      !databaseResult.readOnlyEnforced ||
      databaseResult.missingTableCount !== 0 ||
      databaseResult.tagPresent !== true ||
      databaseResult.principalPresent !== true
    ) {
      throw new HistoryMigrationError("INVALID_ARGUMENTS", "正式目标库的前置依赖校验未通过。");
    }
  } catch (error) {
    await database.close();
    throw error;
  }
  try {
    const before = await captureHistoryImportTableCounts(database);
    const pseudoInputs = {
      privateRoot: inputs.privateRoot,
      packageDirectory: inputs.packageDirectory,
      listMetadata: inputs.listMetadata,
      groupingFile: inputs.groupingFile,
      materializedDirectory: inputs.materializedDirectory,
      preparedDirectory: inputs.preparedDirectory,
      approvalFile: inputs.approvalFile,
      preflightReceipt: inputs.preflightReceipt,
      receiptDirectory: inputs.outputDirectory,
      storageRoot: inputs.storageRoot,
      importOutputDirectory: inputs.importOutputDirectory,
      adminUrl: inputs.databaseUrl,
      databaseName: inputs.databaseName,
      principal: inputs.principal,
      tagId: inputs.tagId,
      gitCommit: inputs.gitCommit,
      expectedBatchSha256: inputs.expectedBatchSha256,
      expectedSourceBindingsSha256: inputs.expectedSourceBindingsSha256,
      expectedPreflightReceiptSha256: phase2.inputBindings.preflightReceiptSha256,
      executionId: inputs.executionId,
      targetClass: "designated-real" as const,
    };
    const execution = await executeImport(database, pseudoInputs, context, before, {});
    let formalVerdict: "PASS" | "FAIL" = "PASS";
    let formalRefusalCode = "";
    if (execution.manifestContentBindingsSha256 !== phase2.inputBindings.manifestContentBindingsSha256) {
      formalVerdict = "FAIL";
      formalRefusalCode = "manifest_content_bindings_mismatch";
    }
    const formalReceipt = {
      version: 3,
      generatedAt: new Date().toISOString(),
      targetClass: "designated-real",
      inputBindings: {
        preflightReceiptSha256: phase2.inputBindings.preflightReceiptSha256,
        batchSha256: phase2.inputBindings.batchSha256,
        sourceBindingsSha256: phase2.inputBindings.sourceBindingsSha256,
        authoritativePackageIdentitySha256: phase2.inputBindings.authoritativePackageIdentitySha256,
        authoritativeRevisionIdentitySha256: phase2.inputBindings.authoritativeRevisionIdentitySha256,
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
      verdict: formalVerdict,
      ...(formalRefusalCode.length === 0 ? {} : { refusalCode: formalRefusalCode }),
    };
    await writePrivateFile(
      join(inputs.outputDirectory, formalReceiptName),
      `${JSON.stringify(formalReceipt, null, 2)}\n`,
    );
    if (formalVerdict !== "PASS") {
      throw new HistoryMigrationError(
        "INVALID_METADATA",
        "正式导入数据已完成对账，但清单内容绑定与第 2 阶段收据不一致；收据已记为 FAIL。",
      );
    }
    await writePrivateFile(
      join(inputs.outputDirectory, formalPassMarkerName),
      `${formalReceipt.generatedAt}\n`,
    );
    console.log(
      `正式导入: PASS; 包数量=${context.packageCount}; 缺失题解=${execution.nullSolutionCount}; 空题解=${execution.emptySolutionCount}`,
    );
    return 0;
  } finally {
    await database.close();
  }
}

export async function runFormalImport(
  argv: readonly string[],
  env: NodeJS.ProcessEnv,
  hooks: FormalImportHooks = {},
): Promise<number> {
  try {
    return await runFormalImportCore(argv, env, hooks);
  } catch (error) {
    if (error instanceof HistoryMigrationError) {
      console.error(`正式导入拒绝: ${error.code}`);
      if (error.code === "INVALID_ARGUMENTS") return 2;
    }
    console.error(error);
    return 1;
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runFormalImport(process.argv.slice(2), process.env).then((code) => {
    process.exitCode = code;
  });
}
export { assertFormalDatabaseName, formalReceiptName, formalPassMarkerName };