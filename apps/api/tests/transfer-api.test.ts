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
import {
  JobWorker,
  LocalJobQueue,
  registerProblemPackageHandlers,
  type JobLogger
} from "@urmotiv/jobs";
import {
  canonicalProblemSchema,
  readZipArchive,
  urmotivNativeAdapter,
  writeZipArchive,
  type CanonicalProblem
} from "@urmotiv/problem-package";
import { LocalFileStorage } from "@urmotiv/storage";
import { sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app";
import { DatabaseContestStore } from "../src/database-contest-store";
import { databaseDemoUserIds, seedDatabaseDemoData } from "../src/database-demo";
import { DatabaseDataStore } from "../src/database-store";
import {
  DatabaseProblemPackageJobStore,
  ProblemPackageJobCoordinator
} from "../src/problem-package-job-store";
import {
  DatabaseFixedRevisionExportReader,
  DatabaseImportedProblemWriter,
  ServiceExportReadAuthorization,
  StorageExportArtifactWriter,
  StorageVerifiedImportArchiveReader
} from "../src/problem-package-runtime";
import { ProblemFileStore } from "../src/problem-file-store";
import { ProblemService } from "../src/service";
import { TransferService } from "../src/transfer-service";

const localOrigin = "http://localhost:5173";
const statementText = "导入题面：给定整数 n，输出 n。";
const solutionText = "导入题解：直接输出。";

const silentLogger: JobLogger = { write: () => undefined };

interface TransferTestContext {
  readonly app: FastifyInstance;
  readonly database: LocalDatabaseHandle;
  readonly worker: JobWorker;
}

const openApps: FastifyInstance[] = [];
const openDatabases: LocalDatabaseHandle[] = [];

let temporaryDirectory = "";

beforeEach(async () => {
  temporaryDirectory = await mkdtemp(join(tmpdir(), "urmotiv-transfer-api-"));
});

afterEach(async () => {
  await Promise.all(openApps.splice(0).map((app) => app.close()));
  await Promise.all(openDatabases.splice(0).map((database) => database.close()));
  await rm(temporaryDirectory, { recursive: true, force: true });
});

async function makeTransferApp(): Promise<TransferTestContext> {
  const database = createLocalDatabase({
    dataDirectory: join(temporaryDirectory, `database-${randomUUID()}`)
  });
  openDatabases.push(database);
  await migrateDatabase(database);
  await seedCoreDatabase(database);
  await seedDatabaseDemoData(database);

  const storage = new LocalFileStorage({
    rootDirectory: join(temporaryDirectory, `storage-${randomUUID()}`),
    limits: { maxBytes: 64 * 1024 * 1024 }
  });
  const store = new DatabaseDataStore(database);
  const metadata = new ProblemFileStore(database);
  const service = new ProblemService(store);
  const jobStore = new DatabaseProblemPackageJobStore(database);
  const queue = new LocalJobQueue();
  const coordinator = new ProblemPackageJobCoordinator(jobStore, queue);
  const exportReader = new DatabaseFixedRevisionExportReader({ database, metadata, storage });
  const worker = new JobWorker(queue, { workerId: "test-worker", logger: silentLogger });
  registerProblemPackageHandlers(worker, {
    import: {
      jobs: jobStore,
      archives: new StorageVerifiedImportArchiveReader(metadata, storage),
      writer: new DatabaseImportedProblemWriter({ database, store, metadata, storage })
    },
    export: {
      jobs: jobStore,
      source: exportReader,
      authorization: new ServiceExportReadAuthorization({
        getUser: (userId) => store.getUser(userId),
        service
      }),
      artifacts: new StorageExportArtifactWriter({ database, metadata, storage })
    }
  });
  const transfer = new TransferService({
    service,
    metadata,
    storage,
    jobs: jobStore,
    coordinator,
    exportReader
  });

  const app = await createApp({
    demoAuthEnabled: true,
    store,
    contestStore: new DatabaseContestStore(database),
    demoUserIds: Object.values(databaseDemoUserIds),
    demoLoginUserIds: databaseDemoUserIds,
    problemFiles: { metadata, storage },
    transfer
  });
  openApps.push(app);
  return { app, database, worker };
}

async function login(app: FastifyInstance, userId: string): Promise<string> {
  const response = await app.inject({
    method: "POST",
    url: "/api/v1/auth/demo-login",
    headers: { origin: localOrigin },
    payload: { userId }
  });
  expect(response.statusCode).toBe(200);
  const setCookie = response.headers["set-cookie"];
  const firstCookie = Array.isArray(setCookie) ? setCookie[0] : setCookie;
  return (firstCookie as string).split(";", 1)[0] as string;
}

function fixtureProblem(): CanonicalProblem {
  return canonicalProblemSchema.parse({
    title: "导入的演示题目",
    type: "traditional",
    tags: ["algorithm.implementation", "unknown.tag-not-in-tree"],
    difficulty: { codeforces: 1600, thinkingLevel: 3, codingLevel: 2 },
    content: {
      basicStatement: statementText,
      basicSolution: solutionText,
      statement: "完整题面。"
    },
    samples: [{ input: "5", output: "5", explanation: "原样输出。" }],
    judge: {
      version: 1,
      limits: { timeMs: 1000, memoryMiB: 256 },
      scoring: { total: 100, subtaskMode: "sum" },
      subtasks: [],
      testcases: [
        { id: "001", input: "judge/testdata/001.in", output: "judge/testdata/001.out", score: 100 }
      ],
      checker: { type: "standard" }
    },
    files: [
      {
        path: "judge/testdata/001.in",
        category: "testdata",
        content: new TextEncoder().encode("5\n")
      },
      {
        path: "judge/testdata/001.out",
        category: "testdata",
        content: new TextEncoder().encode("5\n")
      }
    ],
    extensions: {}
  });
}

async function nativeZipOf(problem: CanonicalProblem): Promise<Uint8Array> {
  const generated = await urmotivNativeAdapter.export(problem, {
    exportedAt: "2026-07-26T00:00:00.000Z"
  });
  return writeZipArchive(generated.files);
}

async function uploadPackage(
  app: FastifyInstance,
  cookie: string,
  bytes: Uint8Array,
  originalName = "problem.zip"
) {
  return app.inject({
    method: "POST",
    url: `/api/v1/transfer/uploads?originalName=${encodeURIComponent(originalName)}`,
    headers: { cookie, origin: localOrigin, "content-type": "application/octet-stream" },
    payload: Buffer.from(bytes)
  });
}

async function revokeExportPermissions(
  database: LocalDatabaseHandle,
  userId: string
): Promise<void> {
  for (const permission of ["problem.export.all", "problem.export.own"]) {
    await database.execute(sql`
      INSERT INTO permission_grants (
        id, subject_user_id, permission_name, effect, scope, granted_by_user_id, reason
      ) VALUES (
        ${randomUUID()}::uuid, ${BigInt(userId)}, ${permission}, 'deny', 'global', 0,
        '测试：导出权限被撤销'
      )
    `);
  }
}

describe("题目包导入", () => {
  it("组长上传原生包、预览并导入成新题目，随后可以整包导出往返", async () => {
    const { app, worker } = await makeTransferApp();
    const leader = await login(app, databaseDemoUserIds.leader);
    const zipBytes = await nativeZipOf(fixtureProblem());

    const uploaded = await uploadPackage(app, leader, zipBytes);
    expect(uploaded.statusCode).toBe(200);
    const upload = uploaded.json() as {
      fileId: string;
      sha256: string;
      detected: Array<{ formatId: string; confidence: number }>;
    };
    expect(upload.detected[0]).toEqual(
      expect.objectContaining({ formatId: "urmotiv", confidence: expect.any(Number) })
    );

    const previewed = await app.inject({
      method: "POST",
      url: "/api/v1/transfer/imports/preview",
      headers: { cookie: leader, origin: localOrigin },
      payload: { fileId: upload.fileId, formatId: "urmotiv" }
    });
    expect(previewed.statusCode).toBe(200);
    expect(previewed.json()).toEqual(
      expect.objectContaining({
        formatId: "urmotiv",
        problemCount: 1,
        title: "导入的演示题目"
      })
    );

    const created = await app.inject({
      method: "POST",
      url: "/api/v1/transfer/imports",
      headers: { cookie: leader, origin: localOrigin },
      payload: {
        fileId: upload.fileId,
        sha256: upload.sha256,
        formatId: "urmotiv",
        idempotencyKey: "import-roundtrip-1"
      }
    });
    expect(created.statusCode).toBe(200);
    const createdJob = created.json() as { id: string; state: string };
    expect(createdJob.state).toBe("queued");

    expect(await worker.runOnce()).toBe(true);

    const finished = await app.inject({
      method: "GET",
      url: `/api/v1/transfer/imports/${createdJob.id}`,
      headers: { cookie: leader }
    });
    expect(finished.statusCode).toBe(200);
    const finishedJob = finished.json() as {
      state: string;
      phase: string;
      items: Array<{ state: string; importedProblemId: string | null }>;
    };
    expect(finishedJob.state).toBe("succeeded");
    expect(finishedJob.phase).toBe("completed");
    const importedProblemId = finishedJob.items[0]?.importedProblemId;
    expect(importedProblemId).toMatch(/^\d+$/);

    const problemResponse = await app.inject({
      method: "GET",
      url: `/api/v1/problems/${importedProblemId}`,
      headers: { cookie: leader }
    });
    expect(problemResponse.statusCode).toBe(200);
    const problem = problemResponse.json() as {
      title: string;
      status: string;
      revision: number;
      tagIds: string[];
      content: { basicStatement: string };
      judgeConfig: { testcases: Array<{ id: string }> } | null;
    };
    expect(problem.title).toBe("导入的演示题目");
    expect(problem.status).toBe("draft");
    expect(problem.tagIds).toEqual(["algorithm.implementation"]);
    expect(problem.content.basicStatement).toBe(statementText);
    expect(problem.judgeConfig?.testcases).toHaveLength(1);

    const files = await app.inject({
      method: "GET",
      url: `/api/v1/problems/${importedProblemId}/files`,
      headers: { cookie: leader }
    });
    expect(files.statusCode).toBe(200);
    expect((files.json() as { items: unknown[] }).items).toHaveLength(2);

    const exportPreview = await app.inject({
      method: "POST",
      url: "/api/v1/transfer/exports/preview",
      headers: { cookie: leader, origin: localOrigin },
      payload: {
        targetFormat: "urmotiv",
        problems: [{ problemId: importedProblemId, includeFileCategories: ["testdata"] }]
      }
    });
    expect(exportPreview.statusCode).toBe(200);
    expect(exportPreview.json()).toEqual(
      expect.objectContaining({
        canExport: true,
        problems: [expect.objectContaining({ status: "ready", title: "导入的演示题目" })]
      })
    );

    const exportCreated = await app.inject({
      method: "POST",
      url: "/api/v1/transfer/exports",
      headers: { cookie: leader, origin: localOrigin },
      payload: {
        targetFormat: "urmotiv",
        problems: [{ problemId: importedProblemId, includeFileCategories: ["testdata"] }],
        idempotencyKey: "export-roundtrip-1"
      }
    });
    expect(exportCreated.statusCode).toBe(200);
    const exportJob = exportCreated.json() as { id: string };

    expect(await worker.runOnce()).toBe(true);

    const exportStatus = await app.inject({
      method: "GET",
      url: `/api/v1/transfer/exports/${exportJob.id}`,
      headers: { cookie: leader }
    });
    expect(exportStatus.statusCode).toBe(200);
    expect(exportStatus.json()).toEqual(
      expect.objectContaining({ state: "succeeded", resultReady: true })
    );

    const downloaded = await app.inject({
      method: "GET",
      url: `/api/v1/transfer/exports/${exportJob.id}/download`,
      headers: { cookie: leader }
    });
    expect(downloaded.statusCode).toBe(200);
    expect(downloaded.headers["content-type"]).toBe("application/zip");

    const roundTripped = await urmotivNativeAdapter.import(
      readZipArchive(new Uint8Array(downloaded.rawPayload)),
      { conflictAction: "create" }
    );
    expect(roundTripped.title).toBe("导入的演示题目");
    expect(roundTripped.content.basicStatement).toBe(statementText);
    expect(roundTripped.content.basicSolution).toBe(solutionText);
    expect(roundTripped.samples).toEqual([
      { input: "5", output: "5", explanation: "原样输出。" }
    ]);
    expect(roundTripped.files.map((file) => file.path).sort()).toEqual([
      "judge/testdata/001.in",
      "judge/testdata/001.out"
    ]);
    expect(new TextDecoder().decode(roundTripped.files[0]?.content)).toBe("5\n");
  });

  it("没有导入权限的用户不能上传，任务对其他用户不可见", async () => {
    const { app, worker } = await makeTransferApp();
    const author = await login(app, databaseDemoUserIds.author);
    const leader = await login(app, databaseDemoUserIds.leader);
    const zipBytes = await nativeZipOf(fixtureProblem());

    const rejected = await uploadPackage(app, author, zipBytes);
    expect(rejected.statusCode).toBe(403);

    const uploaded = await uploadPackage(app, leader, zipBytes);
    const upload = uploaded.json() as { fileId: string; sha256: string };

    const foreignPreview = await app.inject({
      method: "POST",
      url: "/api/v1/transfer/imports/preview",
      headers: { cookie: author, origin: localOrigin },
      payload: { fileId: upload.fileId, formatId: "urmotiv" }
    });
    expect(foreignPreview.statusCode).toBe(403);

    const created = await app.inject({
      method: "POST",
      url: "/api/v1/transfer/imports",
      headers: { cookie: leader, origin: localOrigin },
      payload: {
        fileId: upload.fileId,
        sha256: upload.sha256,
        formatId: "urmotiv",
        idempotencyKey: "import-owner-1"
      }
    });
    const jobId = (created.json() as { id: string }).id;
    expect(await worker.runOnce()).toBe(true);

    const foreignJob = await app.inject({
      method: "GET",
      url: `/api/v1/transfer/imports/${jobId}`,
      headers: { cookie: author }
    });
    expect(foreignJob.statusCode).toBe(404);
  });

  it("拒绝不安全的压缩包并保持存储干净", async () => {
    const { app } = await makeTransferApp();
    const leader = await login(app, databaseDemoUserIds.leader);

    const hostile = await uploadPackage(
      app,
      leader,
      buildHostileZip("../escape.txt"),
      "hostile.zip"
    );
    expect(hostile.statusCode).toBe(422);
    expect(hostile.body).toContain("不安全");

    const truncated = await uploadPackage(
      app,
      leader,
      new TextEncoder().encode("not a zip at all"),
      "broken.zip"
    );
    expect(truncated.statusCode).toBe(422);
  });
});

describe("题目包导出权限", () => {
  it("无权用户的导出预览统一显示不存在，创建导出任务返回不存在", async () => {
    const { app, worker } = await makeTransferApp();
    const leader = await login(app, databaseDemoUserIds.leader);
    const denied = await login(app, databaseDemoUserIds.denied);
    const importedProblemId = await importFixtureProblem(app, worker, leader);

    const preview = await app.inject({
      method: "POST",
      url: "/api/v1/transfer/exports/preview",
      headers: { cookie: denied, origin: localOrigin },
      payload: {
        targetFormat: "urmotiv",
        problems: [
          { problemId: importedProblemId, includeFileCategories: [] },
          { problemId: "999999", includeFileCategories: [] }
        ]
      }
    });
    expect(preview.statusCode).toBe(200);
    const previewBody = preview.json() as {
      canExport: boolean;
      problems: Array<{ status: string; title?: string }>;
    };
    expect(previewBody.canExport).toBe(false);
    expect(previewBody.problems.map((problem) => problem.status)).toEqual([
      "not_found",
      "not_found"
    ]);
    expect(preview.body).not.toContain("导入的演示题目");

    const created = await app.inject({
      method: "POST",
      url: "/api/v1/transfer/exports",
      headers: { cookie: denied, origin: localOrigin },
      payload: {
        targetFormat: "urmotiv",
        problems: [{ problemId: importedProblemId, includeFileCategories: [] }],
        idempotencyKey: "export-denied-1"
      }
    });
    expect(created.statusCode).toBe(404);
  });

  it("导出任务创建后权限被撤销：后台任务失败，已完成任务不能下载", async () => {
    const { app, database, worker } = await makeTransferApp();
    const leader = await login(app, databaseDemoUserIds.leader);
    const importedProblemId = await importFixtureProblem(app, worker, leader);

    const firstJob = await createExportJob(app, leader, importedProblemId, "export-revoke-1");
    expect(await worker.runOnce()).toBe(true);
    const firstStatus = await app.inject({
      method: "GET",
      url: `/api/v1/transfer/exports/${firstJob}`,
      headers: { cookie: leader }
    });
    expect(firstStatus.json()).toEqual(expect.objectContaining({ resultReady: true }));

    const secondJob = await createExportJob(app, leader, importedProblemId, "export-revoke-2");

    await revokeExportPermissions(database, databaseDemoUserIds.leader);

    expect(await worker.runOnce()).toBe(true);
    const secondStatus = await app.inject({
      method: "GET",
      url: `/api/v1/transfer/exports/${secondJob}`,
      headers: { cookie: leader }
    });
    expect(secondStatus.json()).toEqual(
      expect.objectContaining({
        state: "failed",
        failure: expect.objectContaining({ code: "export_access_revoked" })
      })
    );

    const blockedDownload = await app.inject({
      method: "GET",
      url: `/api/v1/transfer/exports/${firstJob}/download`,
      headers: { cookie: leader }
    });
    expect(blockedDownload.statusCode).toBe(404);
  });
});

async function importFixtureProblem(
  app: FastifyInstance,
  worker: JobWorker,
  cookie: string
): Promise<string> {
  const zipBytes = await nativeZipOf(fixtureProblem());
  const uploaded = await uploadPackage(app, cookie, zipBytes);
  const upload = uploaded.json() as { fileId: string; sha256: string };
  const created = await app.inject({
    method: "POST",
    url: "/api/v1/transfer/imports",
    headers: { cookie, origin: localOrigin },
    payload: {
      fileId: upload.fileId,
      sha256: upload.sha256,
      formatId: "urmotiv",
      idempotencyKey: `import-fixture-${upload.sha256.slice(0, 8)}`
    }
  });
  const jobId = (created.json() as { id: string }).id;
  if (!(await worker.runOnce())) {
    throw new Error("导入任务没有被处理。");
  }
  const finished = await app.inject({
    method: "GET",
    url: `/api/v1/transfer/imports/${jobId}`,
    headers: { cookie }
  });
  const job = finished.json() as {
    state: string;
    items: Array<{ importedProblemId: string | null }>;
  };
  const problemId = job.items[0]?.importedProblemId;
  if (job.state !== "succeeded" || problemId === null || problemId === undefined) {
    throw new Error("导入任务没有成功完成。");
  }
  return problemId;
}

async function createExportJob(
  app: FastifyInstance,
  cookie: string,
  problemId: string,
  idempotencyKey: string
): Promise<string> {
  const created = await app.inject({
    method: "POST",
    url: "/api/v1/transfer/exports",
    headers: { cookie, origin: localOrigin },
    payload: {
      targetFormat: "urmotiv",
      problems: [{ problemId, includeFileCategories: ["testdata"] }],
      idempotencyKey
    }
  });
  if (created.statusCode !== 200) {
    throw new Error(`导出任务创建失败：${created.statusCode}`);
  }
  return (created.json() as { id: string }).id;
}

function buildHostileZip(path: string): Uint8Array {
  const encoder = new TextEncoder();
  const nameBytes = encoder.encode(path);
  const content = encoder.encode("x");

  const local = new Uint8Array(30 + nameBytes.byteLength + content.byteLength);
  const localView = new DataView(local.buffer);
  localView.setUint32(0, 0x04034b50, true);
  localView.setUint16(4, 20, true);
  localView.setUint16(8, 0, true);
  localView.setUint32(18, content.byteLength, true);
  localView.setUint32(22, content.byteLength, true);
  localView.setUint16(26, nameBytes.byteLength, true);
  local.set(nameBytes, 30);
  local.set(content, 30 + nameBytes.byteLength);

  const central = new Uint8Array(46 + nameBytes.byteLength);
  const centralView = new DataView(central.buffer);
  centralView.setUint32(0, 0x02014b50, true);
  centralView.setUint16(10, 0, true);
  centralView.setUint32(20, content.byteLength, true);
  centralView.setUint32(24, content.byteLength, true);
  centralView.setUint16(28, nameBytes.byteLength, true);
  centralView.setUint32(38, 0o100644 << 16, true);
  centralView.setUint32(42, 0, true);
  central.set(nameBytes, 46);

  const end = new Uint8Array(22);
  const endView = new DataView(end.buffer);
  endView.setUint32(0, 0x06054b50, true);
  endView.setUint16(8, 1, true);
  endView.setUint16(10, 1, true);
  endView.setUint32(12, central.byteLength, true);
  endView.setUint32(16, local.byteLength, true);

  const archive = new Uint8Array(local.byteLength + central.byteLength + end.byteLength);
  archive.set(local, 0);
  archive.set(central, local.byteLength);
  archive.set(end, local.byteLength + central.byteLength);
  return archive;
}
