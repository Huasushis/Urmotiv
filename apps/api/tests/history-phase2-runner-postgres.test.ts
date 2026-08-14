import { randomUUID } from "node:crypto";
import { access, chmod, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { sql } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";
import {
  createPostgresDatabase,
  migrateDatabase,
  seedCoreDatabase,
  type DatabaseHandle,
} from "@urmotiv/database";
import { createFileStorage, type FileStorage } from "@urmotiv/storage";
import {
  urmotivNativeAdapter,
  writeZipArchive,
  type CanonicalProblem,
} from "@urmotiv/problem-package";

import {
  preflightPassMarkerName,
  preflightReceiptName,
  runHistoryImportPreflight,
  type HistoryImportPreflightHooks,
} from "../scripts/preflight-history-import";
import {
  computeFormalTargetFingerprintSha256,
  formalPassMarkerName,
  formalRollbackVerifiedMarkerName,
  formalBackupVerifiedMarkerName,
  formalRestoreRefusedMarkerName,
  formalReceiptName,
  runFormalImport,
  runFormalImportForTestSeam,
} from "../scripts/run-formal-import";
import { runPhase2Acceptance, type Phase2RunnerHooks } from "../scripts/run-real-import";
import { databaseDemoUserIds, seedDatabaseDemoData } from "../src/database-demo";
import {
  prepareHistoryCandidates,
  verifyApprovedPackageSourceIdentities,
  type HistoryNormalizer,
} from "../src/history-migration/core";
import { sha256Hex } from "../src/history-migration/digests";
import {
  dropHistoryImportDatabase,
  historyImportDatabaseConnectionString,
  packageReportPayloadSchema,
  prepareHistoryImportDatabase,
} from "../src/history-migration/import-phase";
import {
  historyImportRequiredTables,
  recomputePackageBatchIdentity,
  recomputeSourceBindingsIdentity,
} from "../src/history-migration/import-preflight";
import {
  permittedPhase2EvidenceRoot,
  type ExecutionProvenance,
} from "../src/history-migration/execution-provenance";
import {
  captureDatabaseContentInventory,
  captureStorageInventory,
  restoreStorageDirectory,
} from "../src/history-migration/history-import-snapshot";
import {
  captureHistoryImportTableCounts,
  captureStoredFileInventory,
  expectedTableDeltas,
  type HistoryImportCountRow,
} from "../src/history-migration/phase2-postcheck";
const adminUrl = process.env.URMOTIV_TEST_POSTGRES_ADMIN_URL;
const acceptanceMode = process.env.URMOTIV_PHASE2_RUNNER_ACCEPTANCE === "1";
const acceptanceCommit = process.env.URMOTIV_PHASE2_ACCEPTANCE_COMMIT;
const describePostgres = adminUrl === undefined && !acceptanceMode ? describe.skip : describe;
const temporaryDirectories: string[] = [];
const temporaryDatabaseNames: string[] = [];
const encoder = new TextEncoder();
const tagId = "catalog.tag.01.01";
const evidenceRoot = permittedPhase2EvidenceRoot();

interface SyntheticBatch {
  readonly root: string;
  readonly packageDirectory: string;
  readonly listMetadata: string;
  readonly groupingFile: string;
  readonly materializedDirectory: string;
  readonly preparedDirectory: string;
  readonly approvalFile: string;
  readonly preflightOutput: string;
  readonly runnerReceiptDirectory: string;
  readonly storageRoot: string;
  readonly importOutputDirectory: string;
  readonly report: ReturnType<typeof packageReportPayloadSchema.parse>;
}

function scratchName(label: string): string {
  const suffix = `${label}${process.pid}${randomUUID().replaceAll("-", "").slice(0, 8)}`.slice(0, 20);
  return `urmotiv_history_import_${suffix}`;
}

function candidateIdForSource(index: number): string {
  return `candidate-${String((index - 1) * 30 + 1).padStart(6, "0")}`;
}

async function privateDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  await chmod(path, 0o700);
}

async function privateFile(path: string, content: string | Uint8Array): Promise<void> {
  await writeFile(path, content, { mode: 0o600 });
  await chmod(path, 0o600);
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function assertNode24(): void {
  if (process.versions.node.split(".")[0] !== "24") {
    throw new Error("Phase-2 PostgreSQL 验收必须使用 Node 24。");
  }
}

function canonicalProblem(index: number): CanonicalProblem {
  const hasAttachment = index <= 38;
  return {
    title: `合成验收题目 ${index}`,
    type: "traditional",
    tags: [],
    difficulty: {},
    content: {
      basicStatement: `# 合成验收题目 ${index}\n\n仅用于自动化验证。`,
      basicSolution: index <= 7 ? null : index === 8 ? "" : `合成题解 ${index}`,
      background: "",
      statement: "",
      inputFormat: "",
      outputFormat: "",
      constraints: "",
      solution: "",
      hints: "",
    },
    samples: index <= 15
      ? [{ input: `${index}\n`, output: `${index}\n`, explanation: "合成样例" }]
      : [],
    files: hasAttachment
      ? [{
          path: `attachments/public/synthetic-${index}.txt`,
          category: "public_attachment",
          content: encoder.encode(`synthetic-attachment-${index}`),
        }]
      : [],
    provenance: { sourceSystem: "ustc-history-private" },
    extensions: {},
  };
}

function syntheticNormalizer(): HistoryNormalizer {
  return {
    async normalize({ sourceId }) {
      const index = Number(sourceId.slice("source-".length));
      const problem = canonicalProblem(index);
      return {
        problems: [{
          title: problem.title,
          type: problem.type,
          basicStatement: problem.content.basicStatement,
          basicSolution: problem.content.basicSolution,
          background: problem.content.background,
          statement: problem.content.statement,
          inputFormat: problem.content.inputFormat,
          outputFormat: problem.content.outputFormat,
          constraints: problem.content.constraints,
          solution: problem.content.solution,
          hints: problem.content.hints,
          samples: problem.samples,
          tags: [],
          confidence: 1,
          migrationNote: "synthetic-phase2-acceptance",
        }],
      };
    },
  };
}

async function writeSyntheticMaterialization(
  materializedDirectory: string,
  metadataFileSha256: string,
  count: number,
): Promise<void> {
  const sourceDirectory = join(materializedDirectory, "sources");
  await privateDirectory(sourceDirectory);
  const mappings = [];
  const sources = [];
  const sourceSet = [];
  for (let index = 1; index <= count; index += 1) {
    const sourceId = `source-${String(index).padStart(6, "0")}`;
    const sourcePath = `synthetic-source-${String(index).padStart(6, "0")}.md`;
    const sourceText = `synthetic source body ${index}`;
    const sourceBytes = encoder.encode(sourceText);
    const sourceSha256 = sha256Hex(sourceBytes);
    await privateFile(join(sourceDirectory, sourcePath), sourceBytes);
    mappings.push({
      sourcePath,
      sourceSha256,
      metadataNumber: String(index),
    });
    sources.push({
      groupId: `group-${String(index).padStart(6, "0")}`,
      sourceId,
      sourceSha256,
      fragmentCount: 1,
      byteLength: sourceBytes.byteLength,
      characterCount: sourceText.length,
      status: "ready_for_prepare",
    });
    sourceSet.push({ sourceId, sourceSha256, byteLength: sourceBytes.byteLength });
  }
  const sourceConfirmation = {
    version: 1,
    confirmed: true,
    metadataFileSha256,
    mappings,
  };
  const groupingBatchSha256 = sha256Hex("synthetic-phase2-grouping");
  const report = {
    version: 2,
    phase: "materialize",
    sourceInventorySha256: sha256Hex("synthetic-phase2-source-inventory"),
    groupingBatchSha256,
    fragmentCount: count,
    sourceCount: count,
    unresolvedItemCount: 0,
    sources,
  };
  const marker = {
    version: 2,
    phase: "materialize",
    reportSha256: sha256Hex(JSON.stringify(report)),
    sourceConfirmationSha256: sha256Hex(JSON.stringify(sourceConfirmation)),
    sourceSetSha256: sha256Hex(JSON.stringify({ version: 1, sources: sourceSet })),
    groupingBatchSha256,
    sourceCount: count,
    fragmentCount: count,
    unresolvedItemCount: 0,
  };
  await privateFile(
    join(materializedDirectory, "source-confirmation.private.json"),
    `${JSON.stringify(sourceConfirmation, null, 2)}\n`,
  );
  await privateFile(join(materializedDirectory, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
  await privateFile(
    join(materializedDirectory, "MATERIALIZE_COMPLETE"),
    `${JSON.stringify(marker, null, 2)}\n`,
  );
}

async function createSyntheticBatch(count: number): Promise<SyntheticBatch> {
  await privateDirectory(evidenceRoot);
  const root = join(evidenceRoot, `runner-${process.pid}-${randomUUID()}`);
  temporaryDirectories.push(root);
  await privateDirectory(root);
  const materializedDirectory = join(root, "materialized");
  const preparedDirectory = join(root, "prepared");
  const packageDirectory = join(root, "package-output");
  const packageFilesDirectory = join(packageDirectory, "packages");
  const preflightOutput = join(root, "preflight");
  const runnerReceiptDirectory = join(root, "runner");
  const storageRoot = join(root, "storage");
  const importOutputDirectory = join(root, "import-output");
  await Promise.all([
    privateDirectory(materializedDirectory),
    privateDirectory(packageFilesDirectory),
    privateDirectory(preflightOutput),
    privateDirectory(runnerReceiptDirectory),
    privateDirectory(storageRoot),
  ]);

  const listMetadata = join(root, "list-metadata.json");
  const metadata = {
    records: Array.from({ length: count }, (_unused, index) => ({
      number: String(index + 1),
      name: `合成元数据 ${index + 1}`,
      authorStudentId: `SYNTHETIC-${String(index + 1).padStart(6, "0")}`,
      status: "",
      contest: "",
      note: "",
    })),
  };
  const metadataText = `${JSON.stringify(metadata, null, 2)}\n`;
  await privateFile(listMetadata, metadataText);
  await writeSyntheticMaterialization(
    materializedDirectory,
    sha256Hex(metadataText),
    count,
  );
  await prepareHistoryCandidates({
    privateRootDirectory: evidenceRoot,
    sourceDirectory: join(materializedDirectory, "sources"),
    metadataFile: listMetadata,
    sourceConfirmationFile: join(materializedDirectory, "source-confirmation.private.json"),
    outputDirectory: preparedDirectory,
    normalizer: syntheticNormalizer(),
    operationTag: `phase2-${randomUUID()}`,
    executionIdentity: {
      version: 1,
      codeSha256: sha256Hex("synthetic-normalizer-code"),
      promptSha256: sha256Hex("synthetic-normalizer-prompt"),
      modelSha256: sha256Hex("synthetic-normalizer-model"),
      configSha256: sha256Hex("synthetic-normalizer-config"),
    },
  });

  const approvals = [];
  for (let index = 1; index <= count; index += 1) {
    const candidateId = candidateIdForSource(index);
    const candidate = JSON.parse(
      await readFile(join(preparedDirectory, "candidates", `${candidateId}.json`), "utf8"),
    ) as { readonly contentSha256: string };
    approvals.push({ candidateId, contentSha256: candidate.contentSha256, decision: "approved" });
  }
  const approvalFile = join(root, "candidate-approval.private.json");
  await privateFile(
    approvalFile,
    `${JSON.stringify({ version: 1, confirmed: true, approvals }, null, 2)}\n`,
  );
  const authoritative = await verifyApprovedPackageSourceIdentities({
    privateRootDirectory: evidenceRoot,
    materializedDirectory,
    metadataFile: listMetadata,
    preparedDirectory,
    approvalFile,
  });

  const entries = [];
  for (let index = 1; index <= count; index += 1) {
    const identity = authoritative[index - 1];
    if (identity === undefined) throw new Error("synthetic authoritative identity missing");
    const problem = canonicalProblem(index);
    const generated = await urmotivNativeAdapter.export(problem, {});
    if (generated.kind === "single_file") throw new Error("原生适配器必须生成 ZIP。");
    const packageBytes = writeZipArchive(generated.files, { allowNestedArchives: true });
    await privateFile(join(packageFilesDirectory, `${identity.candidateId}.zip`), packageBytes);
    const attachment = problem.files[0];
    entries.push({
      candidateId: identity.candidateId,
      contentSha256: identity.contentSha256,
      sourceBindingSha256: identity.sourceBindingSha256,
      packageSha256: sha256Hex(packageBytes),
      packageBytes: packageBytes.byteLength,
      status: "packaged" as const,
      attachments: attachment === undefined
        ? []
        : [{
            attachmentId: `synthetic-attachment-${index}`,
            contentSha256: sha256Hex(attachment.content),
            semanticRole: "statement_support",
            visibility: "public",
            targetPath: attachment.path,
          }],
    });
  }
  const draft = packageReportPayloadSchema.parse({
    version: 1,
    phase: "package",
    batchSha256: "0".repeat(64),
    packageCount: count,
    packages: entries,
    attachmentCount: Math.min(count, 38),
    preservedMaterialCount: 0,
    preservedMaterials: [],
  });
  const report = packageReportPayloadSchema.parse({
    ...draft,
    batchSha256: recomputePackageBatchIdentity(draft),
  });
  await privateFile(join(packageDirectory, "report.json"), `${JSON.stringify(report)}\n`);
  await privateFile(
    join(packageDirectory, "PACKAGE_COMPLETE"),
    `${JSON.stringify({ version: 1, phase: "package", packageCount: count })}\n`,
  );

  const groupingFile = join(root, "grouping.json");
  await privateFile(
    groupingFile,
    `${JSON.stringify({
      groups: Array.from({ length: count }, (_unused, index) => ({
        metadataId: `M-${String(index + 1).padStart(7, "0")}`,
      })),
    })}\n`,
  );
  return {
    root,
    packageDirectory,
    listMetadata,
    groupingFile,
    materializedDirectory,
    preparedDirectory,
    approvalFile,
    preflightOutput,
    runnerReceiptDirectory,
    storageRoot,
    importOutputDirectory,
    report,
  };
}

function preflightArguments(): string[] {
  return [
    "--private-root-env=PRIVATE_ROOT",
    "--list-metadata-env=LIST_METADATA",
    "--package-directory-env=PACKAGE_DIRECTORY",
    "--output-directory-env=PREFLIGHT_OUTPUT",
    "--materialized-directory-env=MATERIALIZED_DIRECTORY",
    "--prepared-directory-env=PREPARED_DIRECTORY",
    "--approval-file-env=APPROVAL_FILE",
    "--database-url-env=DATABASE_URL",
    "--grouping-file-env=GROUPING_FILE",
    "--tag-id-env=TAG_ID",
    "--git-commit-env=GIT_COMMIT",
    "--target-class-env=TARGET_CLASS",
    "--principal-env=PRINCIPAL",
    "--execution-id-env=EXECUTION_ID",
    "--batch-sha256-env=BATCH_SHA256",
    "--source-bindings-sha256-env=SOURCE_BINDINGS_SHA256",
  ];
}

function runnerArguments(): string[] {
  return [
    "--private-root-env=PRIVATE_ROOT",
    "--package-directory-env=PACKAGE_DIRECTORY",
    "--list-metadata-env=LIST_METADATA",
    "--grouping-file-env=GROUPING_FILE",
    "--materialized-directory-env=MATERIALIZED_DIRECTORY",
    "--prepared-directory-env=PREPARED_DIRECTORY",
    "--approval-file-env=APPROVAL_FILE",
    "--preflight-receipt-env=PREFLIGHT_RECEIPT",
    "--receipt-directory-env=RECEIPT_DIRECTORY",
    "--storage-root-env=STORAGE_ROOT",
    "--import-output-directory-env=IMPORT_OUTPUT_DIRECTORY",
    "--admin-url-env=ADMIN_URL",
    "--db-name-env=DATABASE_NAME",
    "--principal-env=PRINCIPAL",
    "--tag-id-env=TAG_ID",
    "--git-commit-env=GIT_COMMIT",
    "--batch-sha256-env=BATCH_SHA256",
    "--source-bindings-sha256-env=SOURCE_BINDINGS_SHA256",
    "--preflight-receipt-sha256-env=PREFLIGHT_RECEIPT_SHA256",
    "--execution-id-env=EXECUTION_ID",
    "--target-class-env=TARGET_CLASS",
  ];
}

function formalArguments(): string[] {
  return [
    "--private-root-env=PRIVATE_ROOT",
    "--package-directory-env=PACKAGE_DIRECTORY",
    "--list-metadata-env=LIST_METADATA",
    "--grouping-file-env=GROUPING_FILE",
    "--materialized-directory-env=MATERIALIZED_DIRECTORY",
    "--prepared-directory-env=PREPARED_DIRECTORY",
    "--approval-file-env=APPROVAL_FILE",
    "--preflight-receipt-env=PREFLIGHT_RECEIPT",
    "--phase2-receipt-env=PHASE2_RECEIPT",
    "--target-approval-env=TARGET_APPROVAL",
    "--output-directory-env=FORMAL_OUTPUT",
    "--storage-root-env=STORAGE_ROOT",
    "--import-output-directory-env=IMPORT_OUTPUT_DIRECTORY",
    "--database-url-env=DATABASE_URL",
    "--admin-url-env=ADMIN_URL",
    "--principal-env=PRINCIPAL",
    "--tag-id-env=TAG_ID",
    "--git-commit-env=GIT_COMMIT",
    "--execution-id-env=EXECUTION_ID",
    "--target-class-env=TARGET_CLASS",
    "--batch-sha256-env=BATCH_SHA256",
    "--source-bindings-sha256-env=SOURCE_BINDINGS_SHA256",
  ];
}

async function formalEnvironment(
  batch: SyntheticBatch,
  databaseUrl: string,
  adminUrlValue: string,
  targetApprovalFile: string,
  outputDirectory: string,
  storageRoot: string,
  importOutputDirectory: string,
  executionId: string,
): Promise<NodeJS.ProcessEnv> {
  const base = await approvedEnvironment(batch, databaseUrl, executionId);
  return {
    ...base,
    PREFLIGHT_RECEIPT: join(batch.preflightOutput, preflightReceiptName),
    PHASE2_RECEIPT: join(batch.runnerReceiptDirectory, "phase2-run-receipt.private.json"),
    TARGET_APPROVAL: targetApprovalFile,
    ADMIN_URL: adminUrlValue,
    FORMAL_OUTPUT: outputDirectory,
    STORAGE_ROOT: storageRoot,
    IMPORT_OUTPUT_DIRECTORY: importOutputDirectory,
    TARGET_CLASS: "designated-real",
    // 测试缝（hook/故障注入）在 Vitest 运行时且仅对回环合成正式目标生效。
    VITEST: "true",
  };
}

interface FormalApprovalDocuments {
  readonly preflightReceiptSha256: string;
  readonly phase2ReceiptSha256: string;
  readonly scratchDatabaseFingerprintSha256: string;
  readonly formalTargetFingerprintSha256: string;
}

async function writeFormalTargetApproval(
  targetApprovalFile: string,
  documents: FormalApprovalDocuments,
): Promise<void> {
  await privateFile(
    targetApprovalFile,
    `${JSON.stringify({ version: 1, generatedAt: new Date().toISOString(), ...documents }, null, 2)}\n`,
  );
}

function formalTargetIdentity(connectionString: string): {
  readonly host: string;
  readonly port: string;
  readonly user: string;
  readonly database: string;
} {
  const parsed = new URL(connectionString);
  return {
    host: parsed.hostname,
    port: parsed.port === "" ? "5432" : parsed.port,
    user: decodeURIComponent(parsed.username),
    database: decodeURIComponent(parsed.pathname.replace(/^\//, "")),
  };
}

function provenanceHooks(): HistoryImportPreflightHooks & Phase2RunnerHooks {
  if (acceptanceMode) return {};
  return {
    verifyProvenance: async (commit): Promise<ExecutionProvenance> => ({
      commit,
      codeInventorySha256: sha256Hex("synthetic-code-inventory"),
      codeInventoryEntryCount: 1,
    }),
  };
}

async function approvedEnvironment(
  batch: SyntheticBatch,
  sourceConnectionString: string,
  executionId: string,
): Promise<NodeJS.ProcessEnv> {
  if (acceptanceMode && !/^[a-f0-9]{40}$/.test(acceptanceCommit ?? "")) {
    throw new Error("专用验收缺少完整批准提交摘要。");
  }
  return {
    PRIVATE_ROOT: evidenceRoot,
    LIST_METADATA: batch.listMetadata,
    PACKAGE_DIRECTORY: batch.packageDirectory,
    MATERIALIZED_DIRECTORY: batch.materializedDirectory,
    PREPARED_DIRECTORY: batch.preparedDirectory,
    APPROVAL_FILE: batch.approvalFile,
    PREFLIGHT_OUTPUT: batch.preflightOutput,
    DATABASE_URL: sourceConnectionString,
    GROUPING_FILE: batch.groupingFile,
    TAG_ID: tagId,
    GIT_COMMIT: acceptanceMode ? acceptanceCommit : "0".repeat(40),
    TARGET_CLASS: "scratch-temporary",
    PRINCIPAL: databaseDemoUserIds.leader,
    EXECUTION_ID: executionId,
    BATCH_SHA256: batch.report.batchSha256,
    SOURCE_BINDINGS_SHA256: recomputeSourceBindingsIdentity(batch.report),
    ...(acceptanceMode ? {} : { VITEST: "true" }),
  };
}

async function runApprovedPreflight(
  batch: SyntheticBatch,
  sourceConnectionString: string,
  executionId: string,
): Promise<NodeJS.ProcessEnv> {
  const env = await approvedEnvironment(batch, sourceConnectionString, executionId);
  expect(await runHistoryImportPreflight(preflightArguments(), env, provenanceHooks())).toBe(0);
  const preflightReceipt = join(batch.preflightOutput, preflightReceiptName);
  const receiptBytes = await readFile(preflightReceipt);
  return {
    ...env,
    PREFLIGHT_RECEIPT: preflightReceipt,
    PREFLIGHT_RECEIPT_SHA256: sha256Hex(receiptBytes),
    RECEIPT_DIRECTORY: batch.runnerReceiptDirectory,
    STORAGE_ROOT: batch.storageRoot,
    IMPORT_OUTPUT_DIRECTORY: batch.importOutputDirectory,
  };
}

function countMap(rows: readonly HistoryImportCountRow[]): Map<string, number> {
  return new Map(rows.map((row) => [row.table, row.rows]));
}

async function databaseExists(database: DatabaseHandle, name: string): Promise<boolean> {
  const rows = await database.query<{ total: bigint }>(
    sql`select count(*)::bigint as total from pg_database where datname = ${name}`,
  );
  return Number(rows[0]?.total ?? 0) === 1;
}

function trackDatabaseFamily(name: string): void {
  temporaryDatabaseNames.push(
    name,
    `${name}__snapshot`,
    `${name}__restore`,
    `${name}__failed`,
  );
}

afterEach(async () => {
  if (adminUrl !== undefined) {
    for (const name of temporaryDatabaseNames.splice(0).reverse()) {
      if (/^urmotiv_formal_/u.test(name)) {
        const admin = createPostgresDatabase({ connectionString: adminUrl, maxConnections: 1 });
        await admin.execute(sql`drop database if exists ${sql.identifier(name)} with (force)`);
        await admin.close();
      } else {
        await dropHistoryImportDatabase(adminUrl, name);
      }
    }
  }
  for (const directory of temporaryDirectories.splice(0)) {
    await rm(directory, { recursive: true, force: true });
  }
});

describePostgres("Phase-2 runner 真实 PostgreSQL 验收", () => {
  it("137 个权威来源包精确导入并以 0/137 幂等重放", async () => {
    assertNode24();
    if (adminUrl === undefined) throw new Error("缺少 PostgreSQL 管理连接配置。");
    const sourceName = scratchName("src");
    const targetName = scratchName("ok");
    trackDatabaseFamily(sourceName);
    trackDatabaseFamily(targetName);
    await prepareHistoryImportDatabase(adminUrl, sourceName);
    const sourceConnectionString = historyImportDatabaseConnectionString(adminUrl, sourceName);
    const sourceDatabase = createPostgresDatabase({
      connectionString: sourceConnectionString,
      maxConnections: 1,
    });
    const before = await captureHistoryImportTableCounts(sourceDatabase);
    await sourceDatabase.close();

    const batch = await createSyntheticBatch(137);
    const env = await runApprovedPreflight(batch, sourceConnectionString, "synthetic-success");
    env.ADMIN_URL = sourceConnectionString;
    env.DATABASE_NAME = targetName;
    expect(await runPhase2Acceptance(runnerArguments(), env, provenanceHooks())).toBe(0);

    const receiptBytes = await readFile(
      join(batch.runnerReceiptDirectory, "phase2-run-receipt.private.json"),
    );
    const receipt = JSON.parse(receiptBytes.toString("utf8")) as Record<string, unknown>;
    expect(receipt).toMatchObject({
      version: 3,
      packageCount: 137,
      firstPass: { imported: 137, skipped: 0, failed: 0 },
      replayPass: { imported: 0, skipped: 137, failed: 0 },
      postcheck: { verdict: "PASS", reasonCodes: [], driftedTableCount: 0 },
      titleProbePassed: true,
      solutionStates: { nullCount: 7, emptyCount: 1 },
      attachmentCount: 38,
      storedObjectCount: 175,
      verdict: "PASS",
    });
    expect(JSON.stringify(receipt)).not.toContain("合成验收题目");
    expect(await exists(join(batch.runnerReceiptDirectory, "PHASE2_RUN_PASS"))).toBe(true);
    expect(await exists(join(batch.runnerReceiptDirectory, "storage.snapshot"))).toBe(false);
    expect(await exists(join(batch.runnerReceiptDirectory, "PHASE2_RECOVERY_IN_PROGRESS"))).toBe(false);
    const runnerTemplate = JSON.parse(
      await readFile(
        join(batch.runnerReceiptDirectory, "phase2-target-approval-template.private.json"),
        "utf8",
      ),
    ) as {
      preflightReceiptSha256: string;
      phase2ReceiptSha256: string;
      scratchDatabaseFingerprintSha256: string;
    };
    const preflightReceiptBytes = await readFile(join(batch.preflightOutput, preflightReceiptName));
    expect(runnerTemplate.preflightReceiptSha256).toBe(sha256Hex(preflightReceiptBytes));
    expect(runnerTemplate.phase2ReceiptSha256).toBe(sha256Hex(receiptBytes));
    expect(runnerTemplate.scratchDatabaseFingerprintSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(receipt.scratchDatabaseFingerprintSha256).toBe(
      runnerTemplate.scratchDatabaseFingerprintSha256,
    );

    const targetDatabase = createPostgresDatabase({
      connectionString: historyImportDatabaseConnectionString(adminUrl, targetName),
      maxConnections: 1,
    });
    const after = await captureHistoryImportTableCounts(targetDatabase);
    const databaseStorage = await captureStoredFileInventory(targetDatabase);
    await targetDatabase.close();
    const beforeMap = countMap(before);
    const afterMap = countMap(after);
    for (const expectation of expectedTableDeltas({
      imported: 137,
      attachmentRows: 38,
      sampleRows: 15,
      jobItemRows: 137,
      storedFilesDelta: 175,
      auditDelta: 274,
    })) {
      expect((afterMap.get(expectation.table) ?? 0) - (beforeMap.get(expectation.table) ?? 0)).toBe(
        expectation.delta,
      );
    }
    const physicalStorage = await captureStorageInventory(batch.storageRoot);
    expect(physicalStorage.fileCount).toBe(175);
    expect(databaseStorage).toEqual({
      fileCount: physicalStorage.fileCount,
      totalBytes: physicalStorage.totalBytes,
      contentInventorySha256: physicalStorage.contentInventorySha256,
    });

    const adminDatabase = createPostgresDatabase({ connectionString: adminUrl, maxConnections: 1 });
    expect(await databaseExists(adminDatabase, `${targetName}__snapshot`)).toBe(false);
    expect(await databaseExists(adminDatabase, `${targetName}__restore`)).toBe(false);
    expect(await databaseExists(adminDatabase, `${targetName}__failed`)).toBe(false);
    await adminDatabase.close();
    if (acceptanceMode) {
      console.log(
        `Phase-2 route receipt: phase2-run-receipt.private.json sha256=${sha256Hex(receiptBytes)}`,
      );
    }
  }, 300_000);

  it("故障恢复、数据库快照损坏与清理失败均关闭验收", async () => {
    assertNode24();
    if (adminUrl === undefined) throw new Error("缺少 PostgreSQL 管理连接配置。");
    const sourceName = scratchName("fsrc");
    trackDatabaseFamily(sourceName);
    await prepareHistoryImportDatabase(adminUrl, sourceName);
    const sourceConnectionString = historyImportDatabaseConnectionString(adminUrl, sourceName);
    const sourceDatabase = createPostgresDatabase({
      connectionString: sourceConnectionString,
      maxConnections: 1,
    });
    const expectedCounts = await captureHistoryImportTableCounts(sourceDatabase);
    const expectedStored = await captureStoredFileInventory(sourceDatabase);
    await sourceDatabase.close();

    const rollbackTarget = scratchName("roll");
    trackDatabaseFamily(rollbackTarget);
    const rollbackBatch = await createSyntheticBatch(1);
    const rollbackEnv = await runApprovedPreflight(
      rollbackBatch,
      sourceConnectionString,
      "synthetic-rollback",
    );
    rollbackEnv.ADMIN_URL = sourceConnectionString;
    rollbackEnv.DATABASE_NAME = rollbackTarget;
    expect(
      await runPhase2Acceptance(runnerArguments(), rollbackEnv, {
        ...provenanceHooks(),
        afterFirstPass: async () => {
          throw new Error("synthetic fault after first pass");
        },
      }),
    ).toBe(1);
    const restoredDatabase = createPostgresDatabase({
      connectionString: historyImportDatabaseConnectionString(adminUrl, rollbackTarget),
      maxConnections: 1,
    });
    expect(await captureHistoryImportTableCounts(restoredDatabase)).toEqual(expectedCounts);
    expect(await captureStoredFileInventory(restoredDatabase)).toEqual(expectedStored);
    await restoredDatabase.close();
    expect((await captureStorageInventory(rollbackBatch.storageRoot)).fileCount).toBe(0);
    expect(await exists(join(rollbackBatch.runnerReceiptDirectory, "phase2-run-receipt.private.json"))).toBe(false);
    expect(await exists(join(rollbackBatch.runnerReceiptDirectory, "PHASE2_RUN_PASS"))).toBe(false);
    expect(await exists(join(rollbackBatch.runnerReceiptDirectory, "storage.snapshot"))).toBe(false);
    expect(await exists(join(rollbackBatch.runnerReceiptDirectory, "PHASE2_RECOVERY_IN_PROGRESS"))).toBe(false);

    const corruptTarget = scratchName("corrupt");
    trackDatabaseFamily(corruptTarget);
    const corruptBatch = await createSyntheticBatch(1);
    const corruptEnv = await runApprovedPreflight(
      corruptBatch,
      sourceConnectionString,
      "synthetic-corruption",
    );
    corruptEnv.ADMIN_URL = sourceConnectionString;
    corruptEnv.DATABASE_NAME = corruptTarget;
    let corruptionStage = "not-started";
    expect(
      await runPhase2Acceptance(runnerArguments(), corruptEnv, {
        ...provenanceHooks(),
        afterFirstPass: async () => {
          const snapshotDatabase = createPostgresDatabase({
            connectionString: historyImportDatabaseConnectionString(
              adminUrl,
              `${corruptTarget}__snapshot`,
            ),
            maxConnections: 1,
          });
          corruptionStage = "connected";
          try {
            const beforeCorruption = await captureDatabaseContentInventory(
              snapshotDatabase,
              historyImportRequiredTables,
            );
            corruptionStage = "captured-before";
            const changedRows = await snapshotDatabase.query<{ readonly id: string }>(
              sql`update "public"."users"
                  set nickname = nickname || ' changed'
                  where id = ${databaseDemoUserIds.leader}
                  returning id::text as id`,
            );
            corruptionStage = `updated-${changedRows.length}`;
            if (changedRows.length !== 1) {
              throw new Error("snapshot corruption did not mutate a row");
            }
            const afterCorruption = await captureDatabaseContentInventory(
              snapshotDatabase,
              historyImportRequiredTables,
            );
            corruptionStage = "captured-after";
            console.log(
              `数据库快照损坏摘要变化: ${
                beforeCorruption.contentSha256 !== afterCorruption.contentSha256 ? "是" : "否"
              }`,
            );
            if (beforeCorruption.contentSha256 === afterCorruption.contentSha256) {
              throw new Error("database inventory did not detect snapshot corruption");
            }
            corruptionStage = "digest-changed";
          } finally {
            await snapshotDatabase.close();
          }
          throw new Error("synthetic database snapshot corruption");
        },
      }),
    ).toBe(1);
    expect(corruptionStage).toBe("digest-changed");
    expect(await exists(join(corruptBatch.runnerReceiptDirectory, "phase2-run-receipt.private.json"))).toBe(false);
    expect(await exists(join(corruptBatch.runnerReceiptDirectory, "PHASE2_RUN_PASS"))).toBe(false);
    expect(await exists(join(corruptBatch.runnerReceiptDirectory, "storage.snapshot"))).toBe(true);
    expect(await exists(join(corruptBatch.runnerReceiptDirectory, "PHASE2_RECOVERY_IN_PROGRESS"))).toBe(true);
    const adminDatabase = createPostgresDatabase({ connectionString: adminUrl, maxConnections: 1 });
    expect(await databaseExists(adminDatabase, `${corruptTarget}__snapshot`)).toBe(true);
    await adminDatabase.close();

    const cleanupTarget = scratchName("clean");
    trackDatabaseFamily(cleanupTarget);
    const cleanupBatch = await createSyntheticBatch(1);
    const cleanupEnv = await runApprovedPreflight(
      cleanupBatch,
      sourceConnectionString,
      "synthetic-cleanup-failure",
    );
    cleanupEnv.ADMIN_URL = sourceConnectionString;
    cleanupEnv.DATABASE_NAME = cleanupTarget;
    const cleanupSnapshotDir = join(cleanupBatch.runnerReceiptDirectory, "storage.snapshot");
    let cleanupStage = "not-started";
    expect(
      await runPhase2Acceptance(runnerArguments(), cleanupEnv, {
        ...provenanceHooks(),
        beforeSnapshotCleanup: async () => {
          // 真实的部分删除失败：先确证性地删掉一半文件，
          const names = (await readdir(cleanupSnapshotDir)).filter((name) => name !== "blocked");
          expect(names.length).toBeGreaterThan(0);
          cleanupStage = "partially-deleted";
          for (let index = 0; index < names.length; index += 2) {
            await rm(join(cleanupSnapshotDir, names[index]!), { recursive: true, force: false });
          }
          const blockedDirectory = join(cleanupSnapshotDir, "blocked");
          await mkdir(blockedDirectory);
          await privateFile(join(blockedDirectory, "locked.txt"), "locked");
          await chmod(blockedDirectory, 0o500);
        },
      }),
    ).toBe(1);
    expect(cleanupStage).toBe("partially-deleted");
    expect(await exists(join(cleanupBatch.runnerReceiptDirectory, "phase2-run-receipt.private.json"))).toBe(false);
    expect(await exists(join(cleanupBatch.runnerReceiptDirectory, "PHASE2_RUN_PASS"))).toBe(false);
    expect(await exists(join(cleanupBatch.runnerReceiptDirectory, "storage.snapshot"))).toBe(true);
    expect(await exists(join(cleanupBatch.runnerReceiptDirectory, "PHASE2_CLEANUP_IN_PROGRESS"))).toBe(true);
    expect(await exists(join(cleanupBatch.runnerReceiptDirectory, "PHASE2_CLEANUP_REFUSED"))).toBe(true);
    expect(await exists(join(cleanupBatch.runnerReceiptDirectory, "PHASE2_RECOVERY_IN_PROGRESS"))).toBe(false);
    expect(await exists(join(cleanupBatch.preflightOutput, preflightPassMarkerName))).toBe(true);
    const cleanupEvidence = JSON.parse(
      await readFile(
        join(cleanupBatch.runnerReceiptDirectory, "cleanup-recovery-evidence.private.json"),
        "utf8",
      ),
    ) as {
      databaseSnapshotMatchesExecution: boolean;
      storageRecoveryMatchesExecution: boolean;
      databaseSnapshotRetained: boolean;
      storageRecoveryRetained: boolean;
      databaseSnapshotContentSha256: string;
      executionDatabaseContentSha256: string;
      storageRecoveryContentSha256: string;
    };
    expect(cleanupEvidence).toMatchObject({
      databaseSnapshotMatchesExecution: true,
      storageRecoveryMatchesExecution: true,
      databaseSnapshotRetained: true,
      storageRecoveryRetained: true,
    });
    expect(cleanupEvidence.databaseSnapshotContentSha256).toBe(
      cleanupEvidence.executionDatabaseContentSha256,
    );
    expect(cleanupEvidence.storageRecoveryContentSha256).not.toBe("");
    const recoverySnapshotDirectory = join(cleanupBatch.runnerReceiptDirectory, "storage.recovery");
    expect(await exists(recoverySnapshotDirectory)).toBe(true);
    // 恢复可行性证明（文件系统）：重建的快照可以把目标存储完整恢复到干净目录，
    // 且与执行后现场一致（恢复快照与保留的数据库快照描述同一状态）。
    const restoredStorageRoot = join(cleanupBatch.root, "storage-restored-from-recovery");
    await privateDirectory(restoredStorageRoot);
    await restoreStorageDirectory(
      recoverySnapshotDirectory,
      restoredStorageRoot,
      await captureStorageInventory(cleanupBatch.storageRoot),
    );
    // 恢复可行性证明（数据库）：保留的模板快照能重建出与执行后现场完全一致的库。
    const restoreDatabaseName = `${cleanupTarget}__restore`;
    const cleanupAdmin = createPostgresDatabase({ connectionString: adminUrl, maxConnections: 1 });
    const cleanupTargetDatabase = createPostgresDatabase({
      connectionString: historyImportDatabaseConnectionString(adminUrl, cleanupTarget),
      maxConnections: 1,
    });
    try {
      const executionCounts = await captureHistoryImportTableCounts(cleanupTargetDatabase);
      const executionStored = await captureStoredFileInventory(cleanupTargetDatabase);
      expect(await databaseExists(cleanupAdmin, `${cleanupTarget}__snapshot`)).toBe(true);
      await cleanupAdmin.execute(
        sql`create database ${sql.identifier(restoreDatabaseName)} template ${sql.identifier(
          `${cleanupTarget}__snapshot`,
        )}`,
      );
      const restoredFromSnapshot = createPostgresDatabase({
        connectionString: historyImportDatabaseConnectionString(adminUrl, restoreDatabaseName),
        maxConnections: 1,
      });
      try {
        expect(await captureHistoryImportTableCounts(restoredFromSnapshot)).toEqual(executionCounts);
        expect(await captureStoredFileInventory(restoredFromSnapshot)).toEqual(executionStored);
      } finally {
        await restoredFromSnapshot.close();
      }
    } finally {
      await cleanupTargetDatabase.close();
      await cleanupAdmin.close();
    }
    await chmod(join(cleanupSnapshotDir, "blocked"), 0o700);
  }, 300_000);
  it("正式导入：带外批准书门禁、伪造拒绝、v4 单遍收据与中途故障双向回滚", async () => {
    assertNode24();
    if (adminUrl === undefined) throw new Error("缺少 PostgreSQL 管理连接配置。");
    // 正式目标库：名称不能落入临时验收范围，结构与种子与验收库一致；
    // 名称同时满足合成正式测试缝范围，让 hook/故障注入只能在测试内生效。
    const formalDatabaseName = `urmotiv_formal_${process.pid}${randomUUID()
      .replaceAll("-", "")
      .slice(0, 8)}`;
    temporaryDatabaseNames.push(`${formalDatabaseName}__formal_backup`);
    const formalAdmin = createPostgresDatabase({ connectionString: adminUrl, maxConnections: 1 });
    let formalDropped = false;
    try {
      await formalAdmin.execute(
        sql`create database ${sql.identifier(formalDatabaseName)}`,
      );
      const formalConnectionString = historyImportDatabaseConnectionString(
        adminUrl,
        formalDatabaseName,
      );
      const formalPreparation = createPostgresDatabase({
        connectionString: formalConnectionString,
        maxConnections: 4,
      });
      try {
        await migrateDatabase(formalPreparation);
        await seedCoreDatabase(formalPreparation);
        await seedDatabaseDemoData(formalPreparation);
      } finally {
        await formalPreparation.close();
      }
      // 同一批次完整跑通第 1 阶段预检与第 2 阶段临时库验收，
      // 收据与带外模板文件本身就出自这两个阶段。
      const formalSourceName = scratchName("formsrc");
      trackDatabaseFamily(formalSourceName);
      await prepareHistoryImportDatabase(adminUrl, formalSourceName);
      const formalSourceConnectionString = historyImportDatabaseConnectionString(
        adminUrl,
        formalSourceName,
      );
      const formalBatch = await createSyntheticBatch(6);
      const formalSeedEnv = await runApprovedPreflight(
        formalBatch,
        formalSourceConnectionString,
        "synthetic-formal-phase1",
      );
      formalSeedEnv.ADMIN_URL = formalSourceConnectionString;
      const formalRunnerTarget = scratchName("formrun");
      trackDatabaseFamily(formalRunnerTarget);
      formalSeedEnv.DATABASE_NAME = formalRunnerTarget;
      expect(
        await runPhase2Acceptance(runnerArguments(), formalSeedEnv, provenanceHooks()),
      ).toBe(0);
      // 临时库验收必须留下绑定实际临时库身份的模板；批准书由操作员
      // 在收据目录之外带外发布，正式命令只读取核对。
      const phase2ReceiptBytes = await readFile(
        join(formalBatch.runnerReceiptDirectory, "phase2-run-receipt.private.json"),
      );
      const runnerTemplate = JSON.parse(
        await readFile(
          join(
            formalBatch.runnerReceiptDirectory,
            "phase2-target-approval-template.private.json",
          ),
          "utf8",
        ),
      ) as {
        preflightReceiptSha256: string;
        phase2ReceiptSha256: string;
        scratchDatabaseFingerprintSha256: string;
      };
      const preflightReceiptBytesForFormal = await readFile(
        join(formalBatch.preflightOutput, preflightReceiptName),
      );
      expect(runnerTemplate.preflightReceiptSha256).toBe(
        sha256Hex(preflightReceiptBytesForFormal),
      );
      expect(runnerTemplate.phase2ReceiptSha256).toBe(sha256Hex(phase2ReceiptBytes));
      expect(runnerTemplate.scratchDatabaseFingerprintSha256).toMatch(/^[a-f0-9]{64}$/);
      expect(
        JSON.parse(phase2ReceiptBytes.toString("utf8")).scratchDatabaseFingerprintSha256,
      ).toBe(runnerTemplate.scratchDatabaseFingerprintSha256);
      const formalTargetApprovalFile = join(formalBatch.root, "formal-target-approval.private.json");
      const formalTargetFingerprint = computeFormalTargetFingerprintSha256(
        formalTargetIdentity(formalConnectionString),
      );
      await writeFormalTargetApproval(formalTargetApprovalFile, {
        preflightReceiptSha256: runnerTemplate.preflightReceiptSha256,
        phase2ReceiptSha256: runnerTemplate.phase2ReceiptSha256,
        scratchDatabaseFingerprintSha256: runnerTemplate.scratchDatabaseFingerprintSha256,
        formalTargetFingerprintSha256: formalTargetFingerprint,
      });
      const formalBaselineClient = createPostgresDatabase({
        connectionString: formalConnectionString,
        maxConnections: 1,
      });
      const formalBefore = await captureHistoryImportTableCounts(formalBaselineClient);
      await formalBaselineClient.close();
      const formalHooks = {
        verifyProvenance: provenanceHooks().verifyProvenance,
        runPreflight: async (preflightArgv: readonly string[], preflightEnv: NodeJS.ProcessEnv) =>
          runHistoryImportPreflight(preflightArgv, preflightEnv, provenanceHooks()),
      };

      await privateDirectory(join(formalBatch.root, "formal-storage-forged"));
      const forgedApprovalFile = join(formalBatch.root, "formal-target-approval-forged.private.json");
      await writeFormalTargetApproval(forgedApprovalFile, {
        preflightReceiptSha256: runnerTemplate.preflightReceiptSha256,
        phase2ReceiptSha256: runnerTemplate.phase2ReceiptSha256,
        scratchDatabaseFingerprintSha256: runnerTemplate.scratchDatabaseFingerprintSha256,
        formalTargetFingerprintSha256: "f".repeat(64),
      });
      const forgedOutput = join(formalBatch.root, "formal-output-forged");
      const forgedEnv = await formalEnvironment(
        formalBatch,
        formalConnectionString,
        adminUrl,
        forgedApprovalFile,
        forgedOutput,
        join(formalBatch.root, "formal-storage-forged"),
        join(formalBatch.root, "formal-import-output-forged"),
        "synthetic-formal-phase1",
      );
      expect(await runFormalImport(formalArguments(), forgedEnv, formalHooks)).toBe(1);
      expect(await exists(forgedOutput)).toBe(false);
      const forgedCheck = createPostgresDatabase({
        connectionString: formalConnectionString,
        maxConnections: 1,
      });
      expect(await captureHistoryImportTableCounts(forgedCheck)).toEqual(formalBefore);
      await forgedCheck.close();
      expect(await databaseExists(formalAdmin, `${formalDatabaseName}__formal_backup`)).toBe(false);

      // （二）真实中途故障：注入的存储层在第 3 次发布时故障，
      // 此时数据库行与文件对象均已部分存在，必须整体还原并证明等价。
      const rollbackStorageRoot = join(formalBatch.root, "formal-rollback-storage");
      await privateDirectory(rollbackStorageRoot);
      const rollbackOutput = join(formalBatch.root, "formal-rollback-output");
      const rollbackImportOutput = join(formalBatch.root, "formal-rollback-import-output");
      const rollbackEnv = await formalEnvironment(
        formalBatch,
        formalConnectionString,
        adminUrl,
        formalTargetApprovalFile,
        rollbackOutput,
        rollbackStorageRoot,
        rollbackImportOutput,
        "synthetic-formal-phase1",
      );
      const realStorage = createFileStorage({
        kind: "local",
        rootDirectory: rollbackStorageRoot,
        limits: { maxBytes: 2_000_000 },
      });
      let storagePublishCount = 0;
      const failingStorage: FileStorage = {
        stage: (input) => realStorage.stage(input),
        publish: async (staged) => {
          storagePublishCount += 1;
          if (storagePublishCount > 2) {
            throw new Error("synthetic mid-batch storage failure");
          }
          return realStorage.publish(staged);
        },
        discard: (staged) => realStorage.discard(staged),
        open: (stored) => realStorage.open(stored),
        delete: (stored) => realStorage.delete(stored),
      };
      expect(
        await runFormalImportForTestSeam(
          formalArguments(),
          rollbackEnv,
          { storage: failingStorage },
          formalHooks,
        ),
      ).toBe(1);
      expect(storagePublishCount).toBeGreaterThanOrEqual(3);
      expect(await exists(join(rollbackOutput, formalRollbackVerifiedMarkerName))).toBe(true);
      expect(await exists(join(rollbackOutput, formalRestoreRefusedMarkerName))).toBe(false);
      const rollbackReceipt = JSON.parse(
        await readFile(join(rollbackOutput, formalReceiptName), "utf8"),
      ) as { verdict: "PASS" | "FAIL"; rollback: { storageRestored: boolean; databaseRestored: boolean } };
      expect(rollbackReceipt).toMatchObject({
        verdict: "FAIL",
        rollback: { storageRestored: true, databaseRestored: true },
      });
      const rollbackCheck = createPostgresDatabase({
        connectionString: formalConnectionString,
        maxConnections: 1,
      });
      expect(await captureHistoryImportTableCounts(rollbackCheck)).toEqual(formalBefore);
      await rollbackCheck.close();
      expect((await captureStorageInventory(rollbackStorageRoot)).fileCount).toBe(0);
      expect(await databaseExists(formalAdmin, `${formalDatabaseName}__formal_backup`)).toBe(false);
      expect(await exists(join(rollbackOutput, "formal.storage.before.snapshot"))).toBe(false);

      // （三）正确批准书：单遍导入 + 独立自证核对 + v4 通过收据。
      const formalStorageRoot = join(formalBatch.root, "formal-storage");
      await privateDirectory(formalStorageRoot);
      const formalOutputDirectory = join(formalBatch.root, "formal-output");
      const formalImportOutputDirectory = join(formalBatch.root, "formal-import-output");
      const formalEnvironmentValue = await formalEnvironment(
        formalBatch,
        formalConnectionString,
        adminUrl,
        formalTargetApprovalFile,
        formalOutputDirectory,
        formalStorageRoot,
        formalImportOutputDirectory,
        "synthetic-formal-phase1",
      );
      expect(
        await runFormalImport(formalArguments(), formalEnvironmentValue, formalHooks),
      ).toBe(0);
      const formalReceipt = JSON.parse(
        await readFile(join(formalOutputDirectory, formalReceiptName), "utf8"),
      ) as {
        version: number;
        singlePass: boolean;
        packageCount: number;
        storedObjectCount: number;
        verdict: "PASS" | "FAIL";
        backupVerifiedBeforeMutation: boolean;
        postcheck: {
          verdict: string;
          authoritativeInventoryEquality: Record<string, boolean>;
        };
      };
      expect(formalReceipt).toMatchObject({
        version: 4,
        singlePass: true,
        packageCount: 6,
        verdict: "PASS",
        backupVerifiedBeforeMutation: true,
        postcheck: {
          verdict: "PASS",
          authoritativeInventoryEquality: {
            revisionContent: true,
            solutionStates: true,
            attachmentCount: true,
            tableDeltas: true,
            titleUnmodified: true,
            storage: true,
            storedFiles: true,
          },
        },
      });
      expect(await exists(join(formalOutputDirectory, formalPassMarkerName))).toBe(true);
      expect(await exists(join(formalOutputDirectory, formalBackupVerifiedMarkerName))).toBe(true);
      expect(await exists(join(formalOutputDirectory, formalRollbackVerifiedMarkerName))).toBe(false);
      expect(await exists(join(formalOutputDirectory, formalRestoreRefusedMarkerName))).toBe(false);
      expect(await exists(join(formalOutputDirectory, "formal.backup.evidence.available"))).toBe(false);
      expect(await exists(join(formalOutputDirectory, "formal.storage.before.snapshot"))).toBe(false);
      expect(await databaseExists(formalAdmin, `${formalDatabaseName}__formal_backup`)).toBe(false);
      const formalDatabase = createPostgresDatabase({
        connectionString: formalConnectionString,
        maxConnections: 1,
      });
      const formalCounts = await captureHistoryImportTableCounts(formalDatabase);
      await formalDatabase.close();
      const formalBeforeMap = countMap(formalBefore);
      const formalAfterMap = countMap(formalCounts);
      for (const expectation of expectedTableDeltas({
        imported: 6,
        attachmentRows: 6,
        sampleRows: 6,
        jobItemRows: 6,
        storedFilesDelta: 12,
        auditDelta: 12,
      })) {
        expect(
          (formalAfterMap.get(expectation.table) ?? 0) -
            (formalBeforeMap.get(expectation.table) ?? 0),
        ).toBe(expectation.delta);
      }
      const formalStorage = await captureStorageInventory(formalStorageRoot);
      expect(formalStorage.fileCount).toBe(formalReceipt.storedObjectCount);
      const phase2ReceiptForFormal = JSON.parse(phase2ReceiptBytes.toString("utf8")) as {
        storedObjectCount: number;
      };
      expect(formalReceipt.storedObjectCount).toBe(phase2ReceiptForFormal.storedObjectCount);

      // （四）原样重放到新的输出目录：已入库批次按聚合判定拒绝，
      // 回滚已证明，数据不得有任何新增。
      const formalOutputSecond = join(formalBatch.root, "formal-output-second");
      const formalSecondEnv = await formalEnvironment(
        formalBatch,
        formalConnectionString,
        adminUrl,
        formalTargetApprovalFile,
        formalOutputSecond,
        formalStorageRoot,
        join(formalBatch.root, "formal-import-output-second"),
        "synthetic-formal-phase1",
      );
      expect(await runFormalImport(formalArguments(), formalSecondEnv, formalHooks)).toBe(1);
      expect(await exists(join(formalOutputSecond, formalPassMarkerName))).toBe(false);
      expect(await exists(join(formalOutputSecond, formalRollbackVerifiedMarkerName))).toBe(true);
      const formalDatabaseAfterReplay = createPostgresDatabase({
        connectionString: formalConnectionString,
        maxConnections: 1,
      });
      expect(await captureHistoryImportTableCounts(formalDatabaseAfterReplay)).toEqual(
        formalCounts,
      );
      await formalDatabaseAfterReplay.close();
      expect((await captureStorageInventory(formalStorageRoot)).fileCount).toBe(
        formalReceipt.storedObjectCount,
      );
    if (acceptanceMode) {
      const acceptanceDirectory = process.env.URMOTIV_PHASE2_ACCEPTANCE_DIR;
      if (acceptanceDirectory === undefined) {
        throw new Error("专用验收缺少证据输出根目录。");
      }
      const formalReceiptBytes = await readFile(join(formalOutputDirectory, formalReceiptName));
      const phase2ReceiptJson = JSON.parse(phase2ReceiptBytes.toString("utf8")) as {
        inputBindings?: Record<string, unknown>;
      };
      const inputBindings = phase2ReceiptJson.inputBindings ?? {};
      const bindings: Record<string, unknown | null> = {};
      for (const key of [
        "batchSha256",
        "manifestIdentitySha256",
        "manifestContentBindingsSha256",
        "codeInventorySha256",
        "codeInventoryEntryCount",
      ]) {
        bindings[key] = (inputBindings as Record<string, unknown>)[key] ?? null;
      }
      const shard = {
        version: 1,
        generatedAt: new Date().toISOString(),
        route: "formal",
        headCommit: acceptanceCommit,
        preflightReceiptFileSha256: runnerTemplate.preflightReceiptSha256,
        phase2ReceiptFileSha256: runnerTemplate.phase2ReceiptSha256,
        formalReceiptFileSha256: sha256Hex(formalReceiptBytes),
        formalExitCode: 0,
        formalVerdict: "PASS",
        bindings,
      };
      await writeFile(
        join(acceptanceDirectory, "shard-runner.private.json"),
        `${JSON.stringify(shard, null, 2)}\n`,
      );
    }
    } finally {
      await formalAdmin.execute(
        sql`drop database if exists ${sql.identifier(formalDatabaseName)} with (force)`,
      );
      formalDropped = true;
      await formalAdmin.close();
    }
    expect(formalDropped).toBe(true);
  }, 300_000);
});
