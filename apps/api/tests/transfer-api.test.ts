import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
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
  UnsafeArchiveError,
  urmotivNativeAdapter,
  writeZipArchive,
  type CanonicalProblem,
  type GeneratedArchive,
  type GeneratedSingleFileArchive,
  type GeneratedZipArchive,
  type ProblemFormatAdapter
} from "@urmotiv/problem-package";
import { LocalFileStorage } from "@urmotiv/storage";
import { sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
import {
  maximumProblemPackageArchiveBytes,
  TransferService
} from "../src/transfer-service";

const localOrigin = "http://localhost:5173";
const statementText = "导入题面：给定整数 n，输出 n。";
const solutionText = "导入题解：直接输出。";

const silentLogger: JobLogger = { write: () => undefined };

interface TransferTestContext {
  readonly app: FastifyInstance;
  readonly artifacts: StorageExportArtifactWriter;
  readonly database: LocalDatabaseHandle;
  readonly jobs: DatabaseProblemPackageJobStore;
  readonly metadata: ProblemFileStore;
  readonly storage: LocalFileStorage;
  readonly storageRoot: string;
  readonly store: DatabaseDataStore;
  readonly transfer: TransferService;
  readonly worker: JobWorker;
}

interface TransferTestAppOptions {
  readonly adapters?: ReadonlyMap<string, ProblemFormatAdapter>;
  readonly multiProblemOuterArchiveMaxBytes?: number;
  readonly problemPackageArchiveMaxBytes?: number;
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

async function makeTransferApp(
  options: TransferTestAppOptions = {}
): Promise<TransferTestContext> {
  const database = createLocalDatabase({
    dataDirectory: join(temporaryDirectory, `database-${randomUUID()}`)
  });
  openDatabases.push(database);
  await migrateDatabase(database);
  await seedCoreDatabase(database);
  await seedDatabaseDemoData(database);

  const storageRoot = join(temporaryDirectory, `storage-${randomUUID()}`);
  const storage = new LocalFileStorage({
    rootDirectory: storageRoot,
    limits: { maxBytes: 64 * 1024 * 1024 }
  });
  const store = new DatabaseDataStore(database);
  const metadata = new ProblemFileStore(database);
  const service = new ProblemService(store);
  const jobStore = new DatabaseProblemPackageJobStore(database);
  const queue = new LocalJobQueue();
  const coordinator = new ProblemPackageJobCoordinator(jobStore, queue);
  const exportReader = new DatabaseFixedRevisionExportReader({ database, metadata, storage });
  const artifacts = new StorageExportArtifactWriter({
    database,
    metadata,
    storage,
    ...(options.multiProblemOuterArchiveMaxBytes === undefined
      ? {}
      : { multiProblemOuterArchiveMaxBytes: options.multiProblemOuterArchiveMaxBytes })
  });
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
      artifacts
    }
  });
  const transfer = new TransferService({
    service,
    metadata,
    storage,
    jobs: jobStore,
    coordinator,
    exportReader,
    ...(options.adapters === undefined ? {} : { adapters: options.adapters }),
    ...(options.problemPackageArchiveMaxBytes === undefined
      ? {}
      : { maximumArchiveBytes: options.problemPackageArchiveMaxBytes })
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
  return {
    app,
    artifacts,
    database,
    jobs: jobStore,
    metadata,
    storage,
    storageRoot,
    store,
    transfer,
    worker
  };
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
  if (generated.kind !== "zip") {
    throw new Error("Urmotiv 原生题目包必须导出为 ZIP。");
  }
  return writeZipArchive(generated.files);
}

function syntheticGeneratedArchive(
  fileName: string,
  includeNestedArchive: boolean
): GeneratedZipArchive {
  const encoder = new TextEncoder();
  return {
    kind: "zip",
    mediaType: "application/vnd.urmotiv.problem+zip",
    fileName,
    files: includeNestedArchive
      ? [
          {
            path: "attachments/nested.zip",
            content: writeZipArchive([
              { path: "marker.txt", content: encoder.encode("nested marker") }
            ])
          }
        ]
      : [{ path: "marker.txt", content: encoder.encode("plain marker") }]
  };
}

function syntheticGeneratedSingleFile(
  fileName: string,
  text: string,
  mediaType = "application/fps+xml"
): GeneratedSingleFileArchive {
  return {
    kind: "single_file",
    mediaType,
    fileName,
    content: new TextEncoder().encode(text)
  };
}

async function collectStoredBytes(
  metadata: ProblemFileStore,
  storage: LocalFileStorage,
  fileId: string
): Promise<{
  readonly originalName: string;
  readonly mediaType: string;
  readonly content: Uint8Array;
}> {
  const record = await metadata.findStoredFile(fileId);
  if (record === undefined) {
    throw new Error("测试导出文件不存在。");
  }
  const chunks: Uint8Array[] = [];
  let byteSize = 0;
  const stream = await storage.open({ id: record.id, storageKey: record.storageKey });
  for await (const chunk of stream) {
    chunks.push(chunk);
    byteSize += chunk.byteLength;
  }
  const content = new Uint8Array(byteSize);
  let offset = 0;
  for (const chunk of chunks) {
    content.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return {
    originalName: record.originalName,
    mediaType: record.mediaType,
    content
  };
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

  it("上传接口明确接受原始 XML，并让 ZIP 适配器拒绝错误的文件种类", async () => {
    const { app, metadata } = await makeTransferApp();
    const leader = await login(app, databaseDemoUserIds.leader);
    const xml = new TextEncoder().encode(
      "<?xml version=\"1.0\" encoding=\"UTF-8\"?><fps version=\"1.2\" />"
    );

    const uploaded = await uploadPackage(app, leader, xml, "problem.xml");
    expect(uploaded.statusCode).toBe(200);
    const upload = uploaded.json() as {
      fileId: string;
      sha256: string;
      detected: unknown[];
    };
    expect(upload).toEqual(
      expect.objectContaining({
        detected: []
      })
    );
    expect(await metadata.findStoredFile(upload.fileId)).toEqual(
      expect.objectContaining({
        originalName: "problem.xml",
        mediaType: "application/xml"
      })
    );

    const previewed = await app.inject({
      method: "POST",
      url: "/api/v1/transfer/imports/preview",
      headers: { cookie: leader, origin: localOrigin },
      payload: { fileId: upload.fileId, formatId: "urmotiv" }
    });
    expect(previewed.statusCode).toBe(422);
    expect(previewed.json()).toEqual(
      expect.objectContaining({
        error: expect.objectContaining({ code: "FORMAT_INPUT_MISMATCH" })
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
        idempotencyKey: "wrong-input-kind"
      }
    });
    expect(created.statusCode).toBe(422);
    expect(created.json()).toEqual(
      expect.objectContaining({
        error: expect.objectContaining({ code: "FORMAT_INPUT_MISMATCH" })
      })
    );

    const legacyZipName = await uploadPackage(
      app,
      leader,
      await nativeZipOf(fixtureProblem()),
      "legacy-package.data"
    );
    expect(legacyZipName.statusCode).toBe(200);
    expect(legacyZipName.json()).toEqual(
      expect.objectContaining({ detected: expect.any(Array) })
    );
  });

  it("一个格式识别失败不会让其他格式或已保存的上传失效", async () => {
    const brokenAdapter: ProblemFormatAdapter = {
      ...urmotivNativeAdapter,
      id: "broken-detect",
      displayName: "异常格式",
      detect: async () => {
        throw new Error("private-adapter-detail");
      }
    };
    const malformedAdapter: ProblemFormatAdapter = {
      ...urmotivNativeAdapter,
      id: "malformed-detect",
      displayName: "无效识别结果",
      detect: async () => null as never
    };
    const extraAdapters: ProblemFormatAdapter[] = Array.from(
      { length: 21 },
      (_, index) => ({
        ...urmotivNativeAdapter,
        id: `extra-detect-${index}`,
        displayName: `额外格式 ${index}`,
        detect: async () => ({ confidence: 0.5, reason: "测试识别结果上限。" })
      })
    );
    const adapters = new Map<string, ProblemFormatAdapter>([
      [urmotivNativeAdapter.id, urmotivNativeAdapter],
      [brokenAdapter.id, brokenAdapter],
      [malformedAdapter.id, malformedAdapter],
      ...extraAdapters.map((adapter) => [adapter.id, adapter] as const)
    ]);
    const { app, metadata } = await makeTransferApp({ adapters });
    const leader = await login(app, databaseDemoUserIds.leader);

    const uploaded = await uploadPackage(
      app,
      leader,
      await nativeZipOf(fixtureProblem())
    );
    expect(uploaded.statusCode).toBe(200);
    const body = uploaded.json() as {
      fileId: string;
      detected: Array<{ formatId: string }>;
    };
    expect(body.detected.map((item) => item.formatId)).toContain("urmotiv");
    expect(body.detected.map((item) => item.formatId)).not.toContain("broken-detect");
    expect(body.detected.map((item) => item.formatId)).not.toContain("malformed-detect");
    expect(body.detected).toHaveLength(20);
    expect(uploaded.body).not.toContain("private-adapter-detail");
    expect(await metadata.findStoredFile(body.fileId)).toBeDefined();
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

    const validZip = await nativeZipOf(fixtureProblem());
    const disguisedZip = await uploadPackage(
      app,
      leader,
      validZip,
      "looks-like-xml.xml"
    );
    expect(disguisedZip.statusCode).toBe(422);

    const disguisedXml = await uploadPackage(
      app,
      leader,
      new TextEncoder().encode("<?xml version=\"1.0\"?><fps />"),
      "looks-like-zip.zip"
    );
    expect(disguisedXml.statusCode).toBe(422);

    const otherType = await uploadPackage(
      app,
      leader,
      new TextEncoder().encode("plain text"),
      "plain.txt"
    );
    expect(otherType.statusCode).toBe(422);

    const truncated = await uploadPackage(
      app,
      leader,
      validZip.subarray(0, validZip.byteLength - 20),
      "broken.zip"
    );
    expect(truncated.statusCode).toBe(422);
  });

  it("题目包上传在达到配置上限后立即拒绝", async () => {
    const { app, store, transfer } = await makeTransferApp({
      problemPackageArchiveMaxBytes: 64
    });
    const leader = await login(app, databaseDemoUserIds.leader);

    const rejected = await uploadPackage(
      app,
      leader,
      new Uint8Array(65),
      "private-title.zip"
    );

    expect(rejected.statusCode).toBe(413);
    expect(rejected.json()).toEqual({
      error: expect.objectContaining({
        code: "FILE_TOO_LARGE"
      })
    });
    expect(rejected.body).not.toContain("private-title.zip");
    expect(rejected.body).not.toContain("content-length");

    const leaderUser = await store.getUser(databaseDemoUserIds.leader);
    if (leaderUser === undefined) {
      throw new Error("The seeded leader account is missing.");
    }
    let requestedAnotherChunk = false;
    async function* oversizedChunks(): AsyncGenerator<Uint8Array> {
      yield new Uint8Array(40);
      yield new Uint8Array(25);
      requestedAnotherChunk = true;
      yield new Uint8Array(1);
    }

    await expect(
      transfer.uploadPackage(leaderUser, "stream.zip", oversizedChunks())
    ).rejects.toMatchObject({
      statusCode: 413,
      code: "FILE_TOO_LARGE"
    });
    expect(requestedAnotherChunk).toBe(false);
  });

  it("后台导入不会按异常登记大小读取旧题目包", async () => {
    const { app, database, metadata, storage } = await makeTransferApp();
    const leader = await login(app, databaseDemoUserIds.leader);
    const uploaded = await uploadPackage(
      app,
      leader,
      await nativeZipOf(fixtureProblem())
    );
    expect(uploaded.statusCode).toBe(200);
    const upload = uploaded.json() as { fileId: string; sha256: string };

    await database.execute(sql`
      UPDATE stored_files
      SET byte_size = ${BigInt(maximumProblemPackageArchiveBytes + 1)}
      WHERE id = ${upload.fileId}::uuid
    `);

    const archive = await new StorageVerifiedImportArchiveReader(metadata, storage).read({
      sourceFileId: upload.fileId,
      expectedDigest: upload.sha256,
      signal: new AbortController().signal
    });
    expect(archive).toBeUndefined();
  });

  it("预览和后台读取都会拒绝同长度但摘要已经变化的文件", async () => {
    const { app, metadata, storage, storageRoot } = await makeTransferApp();
    const leader = await login(app, databaseDemoUserIds.leader);
    const original = await nativeZipOf(fixtureProblem());
    const uploaded = await uploadPackage(app, leader, original);
    expect(uploaded.statusCode).toBe(200);
    const upload = uploaded.json() as { fileId: string; sha256: string };

    const changed = new Uint8Array(original);
    const changedIndex = Math.floor(changed.byteLength / 2);
    changed[changedIndex] = (changed[changedIndex] ?? 0) ^ 0x01;
    await writeFile(join(storageRoot, "objects", upload.fileId), changed);

    const previewed = await app.inject({
      method: "POST",
      url: "/api/v1/transfer/imports/preview",
      headers: { cookie: leader, origin: localOrigin },
      payload: { fileId: upload.fileId, formatId: "urmotiv" }
    });
    expect(previewed.statusCode).toBe(404);
    expect(previewed.body).not.toContain("objects");

    const reread = await new StorageVerifiedImportArchiveReader(metadata, storage).read({
      sourceFileId: upload.fileId,
      expectedDigest: upload.sha256,
      signal: new AbortController().signal
    });
    expect(reread).toBeUndefined();
  });
});

describe("题目包导出", () => {
  it("单题原始 XML 直接保存并保留适配器给出的文件类型", async () => {
    const { artifacts, metadata, storage } = await makeTransferApp();
    const xml = "<?xml version=\"1.0\"?><fps version=\"1.2\" />";
    const written = await artifacts.write({
      exportJobId: randomUUID(),
      requestedByUserId: databaseDemoUserIds.leader,
      targetFormat: "fps",
      archives: [
        syntheticGeneratedSingleFile(
          "problem.xml",
          xml,
          "application/vnd.fps+xml"
        )
      ],
      signal: new AbortController().signal
    });

    const stored = await collectStoredBytes(metadata, storage, written.fileId);
    expect(stored.originalName).toBe("problem.xml");
    expect(stored.mediaType).toBe("application/vnd.fps+xml");
    expect(new TextDecoder().decode(stored.content)).toBe(xml);
    expect(() => readZipArchive(stored.content)).toThrow(UnsafeArchiveError);
  });

  it("原始单文件的扩展名或内容不符时不会写出产物", async () => {
    const { artifacts, storage } = await makeTransferApp();
    const stage = vi.spyOn(storage, "stage");
    const write = (archive: GeneratedSingleFileArchive) =>
      artifacts.write({
        exportJobId: randomUUID(),
        requestedByUserId: databaseDemoUserIds.leader,
        targetFormat: "fps",
        archives: [archive],
        signal: new AbortController().signal
      });

    await expect(
      write(
        syntheticGeneratedSingleFile(
          "problem.txt",
          "<?xml version=\"1.0\"?><fps />"
        )
      )
    ).rejects.toMatchObject({
      name: "UnsafeArchiveError",
      issues: [expect.objectContaining({ code: "unsupported_input_type" })]
    });
    await expect(
      write({
        kind: "single_file",
        mediaType: "application/fps+xml",
        fileName: "problem.xml",
        content: writeZipArchive([
          { path: "problem.xml", content: new TextEncoder().encode("<fps />") }
        ])
      })
    ).rejects.toMatchObject({
      name: "UnsafeArchiveError",
      issues: [expect.objectContaining({ code: "input_type_mismatch" })]
    });
    expect(stage).not.toHaveBeenCalled();
  });

  it("多题原始 XML 直接作为外层 ZIP 的普通文件保存", async () => {
    const { artifacts, metadata, storage } = await makeTransferApp();
    const first = syntheticGeneratedSingleFile(
      "first.xml",
      "<?xml version=\"1.0\"?><fps id=\"first\" />"
    );
    const second = syntheticGeneratedSingleFile(
      "second.xml",
      "<?xml version=\"1.0\"?><fps id=\"second\" />"
    );
    const written = await artifacts.write({
      exportJobId: randomUUID(),
      requestedByUserId: databaseDemoUserIds.leader,
      targetFormat: "fps",
      archives: [first, second],
      signal: new AbortController().signal
    });

    const stored = await collectStoredBytes(metadata, storage, written.fileId);
    expect(stored.mediaType).toBe("application/zip");
    const outer = readZipArchive(stored.content);
    expect(outer.list().map((entry) => entry.path)).toEqual(["first.xml", "second.xml"]);
    expect(outer.read("first.xml")).toEqual(first.content);
    expect(outer.read("second.xml")).toEqual(second.content);
  });

  it("多题导出拒绝混合输出和重名的原始 XML", async () => {
    const { artifacts } = await makeTransferApp();
    const single = syntheticGeneratedSingleFile(
      "same.xml",
      "<?xml version=\"1.0\"?><fps />"
    );
    const write = (archives: readonly GeneratedArchive[]) =>
      artifacts.write({
        exportJobId: randomUUID(),
        requestedByUserId: databaseDemoUserIds.leader,
        targetFormat: "mixed",
        archives,
        signal: new AbortController().signal
      });

    await expect(
      write([single, syntheticGeneratedArchive("problem.zip", false)])
    ).rejects.toMatchObject({
      name: "UnsafeArchiveError",
      issues: [expect.objectContaining({ code: "unsupported_archive_feature" })]
    });
    await expect(
      write([
        single,
        syntheticGeneratedSingleFile(
          "SAME.XML",
          "<?xml version=\"1.0\"?><fps id=\"second\" />"
        )
      ])
    ).rejects.toMatchObject({
      name: "UnsafeArchiveError",
      issues: [expect.objectContaining({ code: "duplicate_path" })]
    });
  });

  it("多题导出只在外层包明确允许嵌套题目包", async () => {
    const { app, worker } = await makeTransferApp();
    const leader = await login(app, databaseDemoUserIds.leader);
    const firstProblemId = await importFixtureProblem(app, worker, leader);
    const secondProblem = canonicalProblemSchema.parse({
      ...fixtureProblem(),
      title: "导入的第二道演示题目",
      content: {
        ...fixtureProblem().content,
        basicStatement: "第二道合成题面：给定整数 m，输出 m。"
      }
    });
    const secondProblemId = await importFixtureProblem(
      app,
      worker,
      leader,
      secondProblem
    );

    const created = await app.inject({
      method: "POST",
      url: "/api/v1/transfer/exports",
      headers: { cookie: leader, origin: localOrigin },
      payload: {
        targetFormat: "urmotiv",
        problems: [firstProblemId, secondProblemId].map((problemId) => ({
          problemId,
          includeFileCategories: ["testdata"]
        })),
        idempotencyKey: "export-two-problems-1"
      }
    });
    expect(created.statusCode).toBe(200);
    const exportJobId = (created.json() as { id: string }).id;
    expect(await worker.runOnce()).toBe(true);

    const status = await app.inject({
      method: "GET",
      url: `/api/v1/transfer/exports/${exportJobId}`,
      headers: { cookie: leader }
    });
    expect(status.statusCode).toBe(200);
    expect(status.json()).toEqual(
      expect.objectContaining({
        state: "succeeded",
        resultReady: true,
        failure: null
      })
    );

    const downloaded = await app.inject({
      method: "GET",
      url: `/api/v1/transfer/exports/${exportJobId}/download`,
      headers: { cookie: leader }
    });
    expect(downloaded.statusCode).toBe(200);
    const downloadedBytes = new Uint8Array(downloaded.rawPayload);
    expect(() => readZipArchive(downloadedBytes)).toThrow(UnsafeArchiveError);

    const outer = readZipArchive(downloadedBytes, {
      allowNestedArchives: true
    });
    const packageEntries = outer
      .list()
      .filter((entry) => entry.kind === "file" && entry.path.endsWith(".zip"));
    expect(packageEntries).toHaveLength(2);

    const titles: string[] = [];
    for (const entry of packageEntries) {
      const innerBytes = outer.read(entry.path);
      expect(innerBytes).toBeDefined();
      if (innerBytes === undefined) {
        continue;
      }
      const imported = await urmotivNativeAdapter.import(
        readZipArchive(innerBytes),
        { conflictAction: "create" }
      );
      titles.push(imported.title);
    }
    expect(titles.sort()).toEqual(
      ["导入的演示题目", "导入的第二道演示题目"].sort()
    );
  });

  it("单题导出不会放宽内层嵌套压缩包限制", async () => {
    const { artifacts } = await makeTransferApp();

    await expect(
      artifacts.write({
        exportJobId: randomUUID(),
        requestedByUserId: databaseDemoUserIds.leader,
        targetFormat: "urmotiv",
        archives: [syntheticGeneratedArchive("single.zip", true)],
        signal: new AbortController().signal
      })
    ).rejects.toMatchObject({
      name: "UnsafeArchiveError",
      issues: [
        expect.objectContaining({
          code: "nested_archive",
          path: "attachments/nested.zip"
        })
      ]
    });
  });

  it("多题导出的每个内层题目包仍拒绝嵌套压缩包", async () => {
    const { artifacts } = await makeTransferApp();

    await expect(
      artifacts.write({
        exportJobId: randomUUID(),
        requestedByUserId: databaseDemoUserIds.leader,
        targetFormat: "urmotiv",
        archives: [
          syntheticGeneratedArchive("first.zip", false),
          syntheticGeneratedArchive("second.zip", true)
        ],
        signal: new AbortController().signal
      })
    ).rejects.toMatchObject({
      name: "UnsafeArchiveError",
      issues: [
        expect.objectContaining({
          code: "nested_archive",
          path: "attachments/nested.zip"
        })
      ]
    });
  });

  it("多题导出明确拒绝超过外层包容量上限的内容", async () => {
    const archives = [
      syntheticGeneratedArchive("first.zip", false),
      syntheticGeneratedArchive("second.zip", false)
    ];
    const innerPackageBytes = archives.reduce(
      (total, archive) => total + writeZipArchive(archive.files).byteLength,
      0
    );
    const { artifacts } = await makeTransferApp({
      multiProblemOuterArchiveMaxBytes: innerPackageBytes - 1
    });

    await expect(
      artifacts.write({
        exportJobId: randomUUID(),
        requestedByUserId: databaseDemoUserIds.leader,
        targetFormat: "urmotiv",
        archives,
        signal: new AbortController().signal
      })
    ).rejects.toMatchObject({
      name: "UnsafeArchiveError",
      issues: [
        expect.objectContaining({
          code: "archive_too_large"
        })
      ]
    });
  });

  it("多题导出达到内层包累计上限后立即停止且不写出半成品", async () => {
    const first = syntheticGeneratedArchive("first.zip", false);
    const second = syntheticGeneratedArchive("second.zip", false);
    const firstBytes = writeZipArchive(first.files).byteLength;
    const secondBytes = writeZipArchive(second.files).byteLength;
    let thirdFilesRead = 0;
    const third: GeneratedZipArchive = {
      kind: "zip",
      mediaType: "application/vnd.urmotiv.problem+zip",
      fileName: "third.zip",
      get files() {
        thirdFilesRead += 1;
        return syntheticGeneratedArchive("unused.zip", false).files;
      }
    };
    const { artifacts, storage } = await makeTransferApp({
      multiProblemOuterArchiveMaxBytes: firstBytes + secondBytes - 1
    });
    const stage = vi.spyOn(storage, "stage");

    await expect(
      artifacts.write({
        exportJobId: randomUUID(),
        requestedByUserId: databaseDemoUserIds.leader,
        targetFormat: "urmotiv",
        archives: [first, second, third],
        signal: new AbortController().signal
      })
    ).rejects.toMatchObject({
      name: "UnsafeArchiveError",
      issues: [
        expect.objectContaining({
          code: "archive_too_large"
        })
      ]
    });
    expect(thirdFilesRead).toBe(0);
    expect(stage).not.toHaveBeenCalled();
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

  it("下载前会分别拒绝导出文件的摘要变化和实际大小变化", async () => {
    const { app, jobs, metadata, storageRoot, worker } = await makeTransferApp();
    const leader = await login(app, databaseDemoUserIds.leader);
    const importedProblemId = await importFixtureProblem(app, worker, leader);
    const exportJobId = await createExportJob(
      app,
      leader,
      importedProblemId,
      "export-tampered-result"
    );
    expect(await worker.runOnce()).toBe(true);

    const job = await jobs.getExportJob(exportJobId);
    if (job?.resultFileId === null || job?.resultFileId === undefined) {
      throw new Error("导出任务没有生成结果文件。");
    }
    const record = await metadata.findStoredFile(job.resultFileId);
    if (record === undefined) {
      throw new Error("导出结果的文件记录不存在。");
    }
    const changed = new Uint8Array(record.byteSize);
    changed.fill(0x41);
    await writeFile(join(storageRoot, "objects", record.id), changed);

    const downloaded = await app.inject({
      method: "GET",
      url: `/api/v1/transfer/exports/${exportJobId}/download`,
      headers: { cookie: leader }
    });
    expect(downloaded.statusCode).toBe(404);
    expect(downloaded.body).not.toContain(record.originalName);

    await writeFile(
      join(storageRoot, "objects", record.id),
      changed.subarray(0, changed.byteLength - 1)
    );
    const truncated = await app.inject({
      method: "GET",
      url: `/api/v1/transfer/exports/${exportJobId}/download`,
      headers: { cookie: leader }
    });
    expect(truncated.statusCode).toBe(404);
    expect(truncated.body).not.toContain(record.originalName);
  });
});

async function importFixtureProblem(
  app: FastifyInstance,
  worker: JobWorker,
  cookie: string,
  problem: CanonicalProblem = fixtureProblem()
): Promise<string> {
  const zipBytes = await nativeZipOf(problem);
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
