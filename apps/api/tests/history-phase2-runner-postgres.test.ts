import { randomUUID } from "node:crypto";
import { access, chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { sql } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";
import { createPostgresDatabase, type DatabaseHandle } from "@urmotiv/database";
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
import { runPhase2Acceptance, type Phase2RunnerHooks } from "../scripts/run-real-import";
import { databaseDemoUserIds } from "../src/database-demo";
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
      await dropHistoryImportDatabase(adminUrl, name);
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
    expect(
      await runPhase2Acceptance(runnerArguments(), cleanupEnv, {
        ...provenanceHooks(),
        beforeSnapshotCleanup: async () => {
          throw new Error("synthetic cleanup failure");
        },
      }),
    ).toBe(1);
    expect(await exists(join(cleanupBatch.runnerReceiptDirectory, "phase2-run-receipt.private.json"))).toBe(false);
    expect(await exists(join(cleanupBatch.runnerReceiptDirectory, "PHASE2_RUN_PASS"))).toBe(false);
    expect(await exists(join(cleanupBatch.runnerReceiptDirectory, "storage.snapshot"))).toBe(true);
    expect(await exists(join(cleanupBatch.runnerReceiptDirectory, "PHASE2_RECOVERY_IN_PROGRESS"))).toBe(false);
    expect(await exists(join(cleanupBatch.preflightOutput, preflightPassMarkerName))).toBe(true);
    const cleanupAdmin = createPostgresDatabase({ connectionString: adminUrl, maxConnections: 1 });
    expect(await databaseExists(cleanupAdmin, `${cleanupTarget}__snapshot`)).toBe(true);
    await cleanupAdmin.close();
  }, 300_000);
});
