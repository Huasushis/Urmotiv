import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createLocalDatabase,
  type LocalDatabaseHandle,
  migrateDatabase,
  seedCoreDatabase
} from "@urmotiv/database";
import type { CreateStoredFileInput } from "@urmotiv/contracts";
import { sql } from "drizzle-orm";
import {
  LocalJobQueue,
  problemExportJobType,
  problemImportJobType,
  type CreateProblemPackageExportJob,
  type CreateProblemPackageImportJob
} from "@urmotiv/jobs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { databaseDemoUserIds, seedDatabaseDemoData } from "../src/database-demo";
import { DatabaseDataStore } from "../src/database-store";
import type { StoredProblem } from "../src/domain";
import { createProblemVisibility } from "../src/permissions";
import { ProblemFileStore } from "../src/problem-file-store";
import {
  DatabaseProblemPackageJobStore,
  ProblemPackageJobCoordinator
} from "../src/problem-package-job-store";

const createdAt = "2026-07-26T00:00:00.000Z";
const statementText = "A statement that must never enter a task record.";
const openDatabases = new Set<LocalDatabaseHandle>();

let temporaryDirectory = "";

beforeEach(async () => {
  temporaryDirectory = await mkdtemp(join(tmpdir(), "urmotiv-package-jobs-"));
});

afterEach(async () => {
  await Promise.all([...openDatabases].map((database) => database.close()));
  openDatabases.clear();
  await rm(temporaryDirectory, { recursive: true, force: true });
});

async function openDatabase(): Promise<LocalDatabaseHandle> {
  const database = createLocalDatabase({ dataDirectory: join(temporaryDirectory, randomUUID()) });
  openDatabases.add(database);
  await migrateDatabase(database);
  await seedCoreDatabase(database);
  await seedDatabaseDemoData(database);
  return database;
}

function storedFileInput(purpose: CreateStoredFileInput["purpose"]): CreateStoredFileInput {
  const id = randomUUID();
  return {
    id,
    purpose,
    storageKey: `package-jobs/${id}`,
    originalName: "package.zip",
    mediaType: "application/zip",
    byteSize: 16,
    sha256: "b".repeat(64),
    createdByUserId: databaseDemoUserIds.author
  };
}

function importRequest(
  sourceFileId: string,
  overrides: Partial<CreateProblemPackageImportJob> = {}
): CreateProblemPackageImportJob {
  return {
    requestedByUserId: databaseDemoUserIds.author,
    clientRequestDigest: "c".repeat(64),
    sourceFileId,
    inputDigest: "b".repeat(64),
    selectedFormat: "urmotiv",
    selectedFormatVersion: "1.0.0",
    choices: { conflictAction: "create" },
    itemCount: 1,
    idempotencyKey: "import-request-1",
    ...overrides
  };
}

function makeProblem(): StoredProblem {
  return {
    id: randomUUID(),
    title: "Package job fixture",
    type: "traditional",
    tagIds: ["catalog.tag.02.09"],
    codeforcesDifficulty: 1200,
    thinkingLevel: 2,
    codingLevel: 2,
    content: {
      basicStatement: statementText,
      basicSolution: "A fixture solution.",
      background: "",
      statement: "",
      inputFormat: "",
      outputFormat: "",
      constraints: "",
      solution: "",
      hints: ""
    },
    samples: [],
    judgeConfig: null,
    status: "draft",
    ownerId: databaseDemoUserIds.author,
    revision: 1,
    reviewRound: 0,
    createdAt,
    updatedAt: createdAt
  };
}

async function createProblemWithRevision(
  database: LocalDatabaseHandle
): Promise<{ problemId: string; revisionId: string }> {
  const store = new DatabaseDataStore(database);
  const author = await store.getUser(databaseDemoUserIds.author);
  if (author === undefined) {
    throw new Error("The fixture author was not seeded.");
  }
  const created = await store.createProblem(makeProblem());
  const visible = await store.findVisibleProblem(created.id, createProblemVisibility(author));
  if (visible?.revisionId === undefined) {
    throw new Error("The fixture problem has no revision identifier.");
  }
  return { problemId: created.id, revisionId: visible.revisionId };
}

function exportRequest(
  problemId: string,
  revisionId: string,
  overrides: Partial<CreateProblemPackageExportJob> = {}
): CreateProblemPackageExportJob {
  return {
    requestedByUserId: databaseDemoUserIds.author,
    clientRequestDigest: "d".repeat(64),
    targetFormat: "urmotiv",
    targetFormatVersion: "1.0.0",
    options: {},
    lossSummary: {
      targetFormat: "urmotiv",
      canExport: true,
      errorCount: 0,
      choiceCount: 0,
      warningCount: 0,
      infoCount: 0
    },
    problems: [{ problemId, revisionId, includedFileCategories: ["testdata"] }],
    idempotencyKey: "export-request-1",
    ...overrides
  };
}

describe("数据库题目包任务存储", () => {
  it("创建导入任务并对同一请求编号保持幂等", async () => {
    const database = await openDatabase();
    const files = new ProblemFileStore(database);
    const source = await files.createStoredFile(storedFileInput("import_input"));
    const store = new DatabaseProblemPackageJobStore(database);

    const first = await store.createImportJob(importRequest(source.id));
    expect(first).toEqual(
      expect.objectContaining({
        state: "queued",
        selectedFormat: "urmotiv",
        selectedFormatVersion: "1.0.0",
        progressPercent: 0,
        report: expect.objectContaining({ phase: "queued", completedItems: 0 }),
        failure: null
      })
    );
    expect(await store.getImportItems(first.id)).toEqual([
      expect.objectContaining({ position: 0, state: "queued", importedProblemId: null })
    ]);

    const repeated = await store.createImportJob(importRequest(source.id));
    expect(repeated.id).toBe(first.id);

    const repeatedAfterAdapterUpgrade = await store.createImportJob(
      importRequest(source.id, { selectedFormatVersion: "2.0.0" })
    );
    expect(repeatedAfterAdapterUpgrade.id).toBe(first.id);

    await expect(
      store.createImportJob(
        importRequest(source.id, {
          clientRequestDigest: "e".repeat(64),
          choices: { conflictAction: "update", targetProblemId: "1" }
        })
      )
    ).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });

    expect(
      await store.findImportJobForReplay({
        requestedByUserId: databaseDemoUserIds.leader,
        idempotencyKey: first.idempotencyKey,
        clientRequestDigest: first.clientRequestDigest ?? ""
      })
    ).toBeUndefined();
  });

  it("旧导入任务没有客户端请求摘要时保守拒绝重放", async () => {
    const database = await openDatabase();
    const files = new ProblemFileStore(database);
    const source = await files.createStoredFile(storedFileInput("import_input"));
    const store = new DatabaseProblemPackageJobStore(database);
    const job = await store.createImportJob(importRequest(source.id));
    await database.execute(sql`
      UPDATE import_jobs SET client_request_digest = NULL WHERE id = ${job.id}::uuid
    `);

    await expect(
      store.findImportJobForReplay({
        requestedByUserId: job.requestedByUserId,
        idempotencyKey: job.idempotencyKey,
        clientRequestDigest: "c".repeat(64)
      })
    ).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
  });

  it("导入源文件缺失、用途不符或摘要不同时拒绝创建", async () => {
    const database = await openDatabase();
    const files = new ProblemFileStore(database);
    const store = new DatabaseProblemPackageJobStore(database);

    await expect(store.createImportJob(importRequest(randomUUID()))).rejects.toMatchObject({
      code: "INPUT_FILE_NOT_FOUND"
    });

    const wrongPurpose = await files.createStoredFile(storedFileInput("problem"));
    await expect(store.createImportJob(importRequest(wrongPurpose.id))).rejects.toMatchObject({
      code: "INPUT_FILE_NOT_FOUND"
    });

    const source = await files.createStoredFile(storedFileInput("import_input"));
    await expect(
      store.createImportJob(importRequest(source.id, { inputDigest: "c".repeat(64) }))
    ).rejects.toMatchObject({ code: "INPUT_FILE_NOT_FOUND" });
  });

  it("导入任务按状态机运行且完成后拒绝再次更新", async () => {
    const database = await openDatabase();
    const files = new ProblemFileStore(database);
    const source = await files.createStoredFile(storedFileInput("import_input"));
    const store = new DatabaseProblemPackageJobStore(database);
    const { problemId: importedProblemId } = await createProblemWithRevision(database);
    const job = await store.createImportJob(importRequest(source.id));

    await expect(
      store.completeImportJob(job.id, {
        version: 1,
        phase: "completed",
        completedItems: 1,
        failedItems: 0,
        skippedItems: 0
      })
    ).rejects.toMatchObject({ code: "INVALID_STATE" });

    const started = await store.startImportJob(job.id);
    expect(started).toEqual(
      expect.objectContaining({ state: "running", report: expect.objectContaining({ phase: "reading" }) })
    );

    await store.updateImportJob(job.id, 40, {
      version: 1,
      phase: "converting",
      completedItems: 0,
      failedItems: 0,
      skippedItems: 0
    });
    await expect(
      store.updateImportJob(job.id, 30, {
        version: 1,
        phase: "converting",
        completedItems: 0,
        failedItems: 0,
        skippedItems: 0
      })
    ).rejects.toMatchObject({ code: "INVALID_STATE" });

    await store.recordImportItem(job.id, 0, { state: "succeeded", importedProblemId });
    await store.completeImportJob(job.id, {
      version: 1,
      phase: "completed",
      completedItems: 1,
      failedItems: 0,
      skippedItems: 0
    });

    const finished = await store.getImportJob(job.id);
    expect(finished).toEqual(
      expect.objectContaining({
        state: "succeeded",
        progressPercent: 100,
        report: expect.objectContaining({ phase: "completed", completedItems: 1 })
      })
    );
    expect(await store.getImportItems(job.id)).toEqual([
      expect.objectContaining({ state: "succeeded", importedProblemId })
    ]);

    await expect(
      store.updateImportJob(job.id, 90, {
        version: 1,
        phase: "writing",
        completedItems: 1,
        failedItems: 0,
        skippedItems: 0
      })
    ).rejects.toMatchObject({ code: "INVALID_STATE" });
  });

  it("已经成功的导入项目不能被并发失败结果覆盖", async () => {
    const database = await openDatabase();
    const files = new ProblemFileStore(database);
    const source = await files.createStoredFile(storedFileInput("import_input"));
    const store = new DatabaseProblemPackageJobStore(database);
    const { problemId: importedProblemId } = await createProblemWithRevision(database);
    const job = await store.createImportJob(
      importRequest(source.id, { idempotencyKey: "import-success-wins" })
    );
    await store.startImportJob(job.id);
    await store.recordImportItem(job.id, 0, {
      state: "succeeded",
      importedProblemId
    });

    await expect(
      store.recordImportItem(job.id, 0, {
        state: "failed",
        failureCode: "import_write_failed"
      })
    ).rejects.toMatchObject({ code: "INVALID_STATE" });
    await expect(
      store.failImportJob(job.id, "import_write_failed", {
        version: 1,
        phase: "failed",
        completedItems: 0,
        failedItems: 1,
        skippedItems: 0
      })
    ).rejects.toMatchObject({ code: "INVALID_STATE" });

    expect(await store.getImportJob(job.id)).toEqual(
      expect.objectContaining({ state: "running", failure: null })
    );
    expect(await store.getImportItems(job.id)).toEqual([
      expect.objectContaining({
        state: "succeeded",
        importedProblemId,
        failure: null
      })
    ]);
    await expect(
      store.recordImportItem(job.id, 0, {
        state: "succeeded",
        importedProblemId
      })
    ).resolves.toBeUndefined();
  });

  it("失败的导入任务只保留固定文案", async () => {
    const database = await openDatabase();
    const files = new ProblemFileStore(database);
    const source = await files.createStoredFile(storedFileInput("import_input"));
    const store = new DatabaseProblemPackageJobStore(database);
    const job = await store.createImportJob(importRequest(source.id));
    await store.startImportJob(job.id);
    await store.recordImportItem(job.id, 0, { state: "failed", failureCode: "import_invalid" });
    await store.failImportJob(job.id, "import_invalid", {
      version: 1,
      phase: "failed",
      completedItems: 0,
      failedItems: 1,
      skippedItems: 0
    });

    const failed = await store.getImportJob(job.id);
    expect(failed).toEqual(
      expect.objectContaining({
        state: "failed",
        failure: { code: "import_invalid", message: "题目包内容不符合所选格式。" }
      })
    );
    expect(JSON.stringify(failed)).not.toContain(statementText);
  });

  it("导出任务要求固定版本存在并在完成时保存结果文件", async () => {
    const database = await openDatabase();
    const files = new ProblemFileStore(database);
    const store = new DatabaseProblemPackageJobStore(database);
    const { problemId, revisionId } = await createProblemWithRevision(database);

    await expect(
      store.createExportJob(exportRequest(problemId, randomUUID()))
    ).rejects.toMatchObject({ code: "FIXED_REVISION_NOT_FOUND" });

    const job = await store.createExportJob(exportRequest(problemId, revisionId));
    expect(job).toEqual(
      expect.objectContaining({
        state: "queued",
        targetFormat: "urmotiv",
        targetFormatVersion: "1.0.0",
        problems: [
          expect.objectContaining({ problemId, revisionId, includedFileCategories: ["testdata"] })
        ]
      })
    );
    const repeatedAfterAdapterUpgrade = await store.createExportJob(
      exportRequest(problemId, revisionId, { targetFormatVersion: "2.0.0" })
    );
    expect(repeatedAfterAdapterUpgrade.id).toBe(job.id);
    expect(
      await store.findExportJobForReplay({
        requestedByUserId: databaseDemoUserIds.leader,
        idempotencyKey: job.idempotencyKey
      })
    ).toBeUndefined();

    await store.startExportJob(job.id);
    await store.updateExportJob(job.id, 50, {
      version: 1,
      phase: "converting",
      completedItems: 0,
      failedItems: 0,
      skippedItems: 0
    });

    const result = await files.createStoredFile({
      ...storedFileInput("export_output"),
      sha256: "d".repeat(64)
    });
    await store.completeExportJob(job.id, {
      resultFileId: result.id,
      resultExpiresAt: "2026-07-27T00:00:00.000Z",
      outputFileCount: 6
    });

    const finished = await store.getExportJob(job.id);
    expect(finished).toEqual(
      expect.objectContaining({
        state: "succeeded",
        progressPercent: 100,
        resultFileId: result.id,
        resultExpiresAt: "2026-07-27T00:00:00.000Z",
        report: expect.objectContaining({ phase: "completed", outputFileCount: 6 })
      })
    );
    expect(JSON.stringify(finished)).not.toContain(statementText);
  });

  it("导出任务失败时不保留结果文件", async () => {
    const database = await openDatabase();
    const store = new DatabaseProblemPackageJobStore(database);
    const { problemId, revisionId } = await createProblemWithRevision(database);
    const job = await store.createExportJob(exportRequest(problemId, revisionId));
    await store.startExportJob(job.id);
    await store.failExportJob(job.id, "export_access_revoked");

    expect(await store.getExportJob(job.id)).toEqual(
      expect.objectContaining({
        state: "failed",
        resultFileId: null,
        failure: {
          code: "export_access_revoked",
          message: "当前已没有导出所需的题目或文件权限。"
        }
      })
    );
  });
});

describe("题目包任务协调器", () => {
  it("先保存任务快照，再入队且队列里只有任务编号", async () => {
    const database = await openDatabase();
    const files = new ProblemFileStore(database);
    const source = await files.createStoredFile(storedFileInput("import_input"));
    const store = new DatabaseProblemPackageJobStore(database);
    const queue = new LocalJobQueue();
    const coordinator = new ProblemPackageJobCoordinator(store, queue);

    const job = await coordinator.createImportJob(importRequest(source.id));
    const queued = await queue.leaseNext({ workerId: "test-worker", leaseMs: 1_000 });
    expect(queued).toEqual(
      expect.objectContaining({
        id: job.id,
        type: problemImportJobType,
        payload: { importJobId: job.id }
      })
    );
    expect(JSON.stringify(queued)).not.toContain(statementText);

    const repeated = await coordinator.createImportJob(importRequest(source.id));
    expect(repeated.id).toBe(job.id);
    expect(await queue.leaseNext({ workerId: "test-worker", leaseMs: 1_000 })).toBeUndefined();
  });

  it("数据库已提交但首次入队失败时可按原任务重试导入和导出", async () => {
    const database = await openDatabase();
    const files = new ProblemFileStore(database);
    const source = await files.createStoredFile(storedFileInput("import_input"));
    const { problemId, revisionId } = await createProblemWithRevision(database);
    const store = new DatabaseProblemPackageJobStore(database);
    const queue = new LocalJobQueue();
    const coordinator = new ProblemPackageJobCoordinator(store, queue);
    const enqueue = vi.spyOn(queue, "enqueue");
    const importAuditRequestId = randomUUID();
    const exportAuditRequestId = randomUUID();

    enqueue.mockRejectedValueOnce(new Error("synthetic queue outage"));
    await expect(
      coordinator.createImportJob(
        importRequest(source.id, { auditRequestId: importAuditRequestId })
      )
    ).rejects.toThrow("synthetic queue outage");
    const replayedImport = await coordinator.replayImportJob({
      requestedByUserId: databaseDemoUserIds.author,
      idempotencyKey: "import-request-1",
      clientRequestDigest: "c".repeat(64)
    });
    expect(replayedImport).toBeDefined();
    expect(await queue.leaseNext({ workerId: "import-retry", leaseMs: 1_000 })).toEqual(
      expect.objectContaining({ id: replayedImport?.id, type: problemImportJobType })
    );

    enqueue.mockRejectedValueOnce(new Error("synthetic queue outage"));
    await expect(
      coordinator.createExportJob(
        exportRequest(problemId, revisionId, { auditRequestId: exportAuditRequestId })
      )
    ).rejects.toThrow("synthetic queue outage");
    const replayedExport = await coordinator.findExportJobForReplay({
      requestedByUserId: databaseDemoUserIds.author,
      idempotencyKey: "export-request-1"
    });
    expect(replayedExport).toBeDefined();
    if (replayedExport === undefined) throw new Error("导出重放任务不存在。");
    await coordinator.reenqueueExportJob(replayedExport);
    expect(await queue.leaseNext({ workerId: "export-retry", leaseMs: 1_000 })).toEqual(
      expect.objectContaining({ id: replayedExport.id, type: problemExportJobType })
    );

    const creationAudits = await database.query<{ action: string; count: number }>(sql`
      SELECT action, count(*)::integer AS count
      FROM audit_events
      WHERE request_id IN (${importAuditRequestId}::uuid, ${exportAuditRequestId}::uuid)
        AND action IN ('problem.package.import.create', 'problem.package.export.create')
      GROUP BY action
      ORDER BY action
    `);
    expect(creationAudits).toEqual([
      { action: "problem.package.export.create", count: 1 },
      { action: "problem.package.import.create", count: 1 }
    ]);
  });
});
