import { randomUUID } from "node:crypto";
import { access, chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
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
} from "../scripts/preflight-history-import";
import { runPhase2Acceptance } from "../scripts/run-real-import";
import { databaseDemoUserIds } from "../src/database-demo";
import { sha256Hex } from "../src/history-migration/digests";
import {
  dropHistoryImportDatabase,
  historyImportDatabaseConnectionString,
  packageReportPayloadSchema,
  prepareHistoryImportDatabase,
} from "../src/history-migration/import-phase";
import {
  recomputePackageBatchIdentity,
  recomputeSourceBindingsIdentity,
} from "../src/history-migration/import-preflight";
import {
  captureStorageInventory,
  restoreStorageDirectory,
  snapshotStorageDirectory,
} from "../src/history-migration/history-import-snapshot";
import {
  captureHistoryImportTableCounts,
  captureStoredFileInventory,
  expectedTableDeltas,
  type HistoryImportCountRow,
} from "../src/history-migration/phase2-postcheck";

const adminUrl = process.env.URMOTIV_TEST_POSTGRES_ADMIN_URL;
const describePostgres = adminUrl === undefined ? describe.skip : describe;
const temporaryDirectories: string[] = [];
const temporaryDatabaseNames: string[] = [];
const encoder = new TextEncoder();
const tagId = "catalog.tag.01.01";

interface SyntheticBatch {
  readonly root: string;
  readonly packageDirectory: string;
  readonly listMetadata: string;
  readonly groupingFile: string;
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

function canonicalProblem(index: number): CanonicalProblem {
  const hasAttachment = index <= 38;
  return {
    title: `合成验收题目 ${index}`,
    type: "traditional",
    tags: [],
    difficulty: {},
    content: {
      basicStatement: `# 合成验收题目 ${index}\n\n仅用于自动化验证。`,
      basicSolution: index <= 7 ? null : `合成题解 ${index}`,
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
    extensions: {},
  };
}

async function createSyntheticBatch(count: number): Promise<SyntheticBatch> {
  const root = await mkdtemp(join(tmpdir(), "urmotiv-phase2-runner-"));
  temporaryDirectories.push(root);
  await chmod(root, 0o700);
  const packageDirectory = join(root, "package-output");
  const packageFilesDirectory = join(packageDirectory, "packages");
  const preflightOutput = join(root, "preflight");
  const runnerReceiptDirectory = join(root, "runner");
  const storageRoot = join(root, "storage");
  const importOutputDirectory = join(root, "import-output");
  await Promise.all([
    privateDirectory(packageFilesDirectory),
    privateDirectory(preflightOutput),
    privateDirectory(runnerReceiptDirectory),
    privateDirectory(storageRoot),
  ]);

  const entries = [];
  for (let index = 1; index <= count; index += 1) {
    const candidateId = `candidate-${String(index).padStart(6, "0")}`;
    const problem = canonicalProblem(index);
    const generated = await urmotivNativeAdapter.export(problem, {});
    if (generated.kind === "single_file") throw new Error("原生适配器必须生成 ZIP。");
    const packageBytes = writeZipArchive(generated.files, { allowNestedArchives: true });
    await privateFile(join(packageFilesDirectory, `${candidateId}.zip`), packageBytes);
    const attachment = problem.files[0];
    entries.push({
      candidateId,
      contentSha256: sha256Hex(problem.content.basicStatement),
      sourceBindingSha256: sha256Hex(`synthetic-source-binding-${index}`),
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

  const listMetadata = join(root, "list-metadata.json");
  const groupingFile = join(root, "grouping.json");
  await privateFile(
    listMetadata,
    `${JSON.stringify({
      records: Array.from({ length: count }, (_unused, index) => ({
        number: String(index + 1),
        name: `合成元数据 ${index + 1}`,
      })),
    })}\n`,
  );
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
    "--expected-record-count=137",
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

function runnerArguments(expectedCount: number): string[] {
  return [
    "--private-root-env=PRIVATE_ROOT",
    "--package-directory-env=PACKAGE_DIRECTORY",
    "--list-metadata-env=LIST_METADATA",
    "--grouping-file-env=GROUPING_FILE",
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
    `--expected-count=${expectedCount}`,
  ];
}

async function approvedEnvironment(
  batch: SyntheticBatch,
  sourceConnectionString: string,
  executionId: string,
): Promise<NodeJS.ProcessEnv> {
  const sourceBindingsSha256 = recomputeSourceBindingsIdentity(batch.report);
  return {
    PRIVATE_ROOT: batch.root,
    LIST_METADATA: batch.listMetadata,
    PACKAGE_DIRECTORY: batch.packageDirectory,
    PREFLIGHT_OUTPUT: batch.preflightOutput,
    DATABASE_URL: sourceConnectionString,
    GROUPING_FILE: batch.groupingFile,
    TAG_ID: tagId,
    GIT_COMMIT: "synthetic-phase2-commit",
    TARGET_CLASS: "scratch-temporary",
    PRINCIPAL: databaseDemoUserIds.leader,
    EXECUTION_ID: executionId,
    BATCH_SHA256: batch.report.batchSha256,
    SOURCE_BINDINGS_SHA256: sourceBindingsSha256,
  };
}

async function runApprovedPreflight(
  batch: SyntheticBatch,
  sourceConnectionString: string,
  count: number,
  executionId: string,
): Promise<NodeJS.ProcessEnv> {
  const env = await approvedEnvironment(batch, sourceConnectionString, executionId);
  const args = preflightArguments().map((argument) =>
    argument === "--expected-record-count=137" ? `--expected-record-count=${count}` : argument,
  );
  expect(await runHistoryImportPreflight(args, env)).toBe(0);
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

describe("Phase-2 storage snapshot lifecycle", () => {
  it("按批准摘要恢复非空目录，并在快照被改动时保持目标不变", async () => {
    const root = await mkdtemp(join(tmpdir(), "urmotiv-phase2-storage-"));
    temporaryDirectories.push(root);
    const target = join(root, "target");
    const nested = join(target, "nested");
    const snapshot = join(root, "snapshot");
    await privateDirectory(nested);
    await privateFile(join(target, "one.bin"), encoder.encode("baseline-one"));
    await privateFile(join(nested, "two.bin"), encoder.encode("baseline-two"));
    const approved = await snapshotStorageDirectory(target, snapshot);

    await privateFile(join(target, "one.bin"), encoder.encode("mutated"));
    expect(await restoreStorageDirectory(snapshot, target, approved)).toEqual(approved);
    expect(await captureStorageInventory(target)).toEqual(approved);

    await privateFile(join(target, "one.bin"), encoder.encode("second-mutation"));
    const targetBeforeRejectedRestore = await captureStorageInventory(target);
    await privateFile(join(snapshot, "one.bin"), encoder.encode("corrupt-snapshot"));
    await expect(restoreStorageDirectory(snapshot, target, approved)).rejects.toThrow();
    expect(await captureStorageInventory(target)).toEqual(targetBeforeRejectedRestore);
  });
});

describePostgres("Phase-2 runner 真实 PostgreSQL 验收", () => {
  it("137 个合成包精确导入并幂等重放，完整增量与冻结字段均通过", async () => {
    if (adminUrl === undefined) throw new Error("缺少 PostgreSQL 管理连接配置。");
    const sourceName = scratchName("src");
    const targetName = scratchName("ok");
    temporaryDatabaseNames.push(sourceName, `${targetName}__snapshot`, `${targetName}__restore`, targetName);
    await prepareHistoryImportDatabase(adminUrl, sourceName);
    const sourceConnectionString = historyImportDatabaseConnectionString(adminUrl, sourceName);
    const sourceDatabase = createPostgresDatabase({ connectionString: sourceConnectionString, maxConnections: 1 });
    const before = await captureHistoryImportTableCounts(sourceDatabase);
    await sourceDatabase.close();

    const batch = await createSyntheticBatch(137);
    const env = await runApprovedPreflight(batch, sourceConnectionString, 137, "synthetic-success");
    env.ADMIN_URL = sourceConnectionString;
    env.DATABASE_NAME = targetName;
    expect(await runPhase2Acceptance(runnerArguments(137), env)).toBe(0);

    const receipt = JSON.parse(
      await readFile(join(batch.runnerReceiptDirectory, "phase2-run-receipt.private.json"), "utf8"),
    ) as Record<string, unknown>;
    expect(receipt).toMatchObject({
      packageCount: 137,
      firstPass: { imported: 137, skipped: 0, failed: 0 },
      replayPass: { imported: 0, skipped: 137, failed: 0 },
      postcheck: { verdict: "PASS", reasonCodes: [], driftedTableCount: 0 },
      titleProbePassed: true,
      missingSolutionCount: 7,
      attachmentCount: 38,
      storedObjectCount: 175,
      verdict: "PASS",
    });
    expect(JSON.stringify(receipt)).not.toContain("合成验收题目");
    expect(await exists(join(batch.runnerReceiptDirectory, "PHASE2_RUN_PASS"))).toBe(true);
    expect(await exists(join(batch.runnerReceiptDirectory, "storage.snapshot"))).toBe(false);

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
    await adminDatabase.close();
  }, 300_000);

  it("快照后故障恢复数据库与存储精确基线，不留下通过收据或快照", async () => {
    if (adminUrl === undefined) throw new Error("缺少 PostgreSQL 管理连接配置。");
    const sourceName = scratchName("fsrc");
    const targetName = scratchName("fail");
    temporaryDatabaseNames.push(sourceName, `${targetName}__snapshot`, `${targetName}__restore`, targetName);
    await prepareHistoryImportDatabase(adminUrl, sourceName);
    const sourceConnectionString = historyImportDatabaseConnectionString(adminUrl, sourceName);
    const sourceDatabase = createPostgresDatabase({ connectionString: sourceConnectionString, maxConnections: 1 });
    const expectedCounts = await captureHistoryImportTableCounts(sourceDatabase);
    const expectedStored = await captureStoredFileInventory(sourceDatabase);
    await sourceDatabase.close();

    const batch = await createSyntheticBatch(1);
    const env = await runApprovedPreflight(batch, sourceConnectionString, 1, "synthetic-failure");
    env.ADMIN_URL = sourceConnectionString;
    env.DATABASE_NAME = targetName;
    const code = await runPhase2Acceptance(runnerArguments(1), env, {
      afterFirstPass: async () => {
        throw new Error("synthetic fault after first pass");
      },
    });
    expect(code).toBe(1);

    const restoredDatabase = createPostgresDatabase({
      connectionString: historyImportDatabaseConnectionString(adminUrl, targetName),
      maxConnections: 1,
    });
    expect(await captureHistoryImportTableCounts(restoredDatabase)).toEqual(expectedCounts);
    expect(await captureStoredFileInventory(restoredDatabase)).toEqual(expectedStored);
    await restoredDatabase.close();
    expect((await captureStorageInventory(batch.storageRoot)).fileCount).toBe(0);
    expect(await exists(batch.importOutputDirectory)).toBe(false);
    expect(await exists(join(batch.runnerReceiptDirectory, "phase2-run-receipt.private.json"))).toBe(false);
    expect(await exists(join(batch.runnerReceiptDirectory, "PHASE2_RUN_PASS"))).toBe(false);
    expect(await exists(join(batch.runnerReceiptDirectory, "storage.snapshot"))).toBe(false);
    expect(await exists(join(batch.preflightOutput, preflightPassMarkerName))).toBe(true);

    const adminDatabase = createPostgresDatabase({ connectionString: adminUrl, maxConnections: 1 });
    expect(await databaseExists(adminDatabase, `${targetName}__snapshot`)).toBe(false);
    expect(await databaseExists(adminDatabase, `${targetName}__restore`)).toBe(false);
    await adminDatabase.close();
  }, 180_000);
});
