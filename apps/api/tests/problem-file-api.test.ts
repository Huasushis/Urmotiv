import { randomUUID } from "node:crypto";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import {
  createLocalDatabase,
  type LocalDatabaseHandle,
  migrateDatabase,
  seedCoreDatabase
} from "@urmotiv/database";
import { LocalFileStorage } from "@urmotiv/storage";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app";
import { DatabaseContestStore } from "../src/database-contest-store";
import { databaseDemoUserIds, seedDatabaseDemoData } from "../src/database-demo";
import { DatabaseDataStore } from "../src/database-store";
import { ProblemFileStore } from "../src/problem-file-store";

const localOrigin = "http://localhost:5173";
const fullContent = {
  basicStatement: "给定一个整数，输出它本身。",
  basicSolution: "直接输出输入即可。",
  background: "",
  statement: "",
  inputFormat: "",
  outputFormat: "",
  constraints: "",
  solution: "",
  hints: ""
};

interface FileTestContext {
  readonly app: FastifyInstance;
  readonly objectsDirectory: string;
  readonly stagingDirectory: string;
}

const openApps: FastifyInstance[] = [];
const openDatabases: LocalDatabaseHandle[] = [];

let temporaryDirectory = "";

beforeEach(async () => {
  temporaryDirectory = await mkdtemp(join(tmpdir(), "urmotiv-problem-file-api-"));
});

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(openApps.splice(0).map((app) => app.close()));
  await Promise.all(openDatabases.splice(0).map((database) => database.close()));
  await rm(temporaryDirectory, { recursive: true, force: true });
});

async function makeFileApp(maxBytes = 1024 * 1024): Promise<FileTestContext> {
  const database = createLocalDatabase({
    dataDirectory: join(temporaryDirectory, `database-${randomUUID()}`)
  });
  openDatabases.push(database);
  await migrateDatabase(database);
  await seedCoreDatabase(database);
  await seedDatabaseDemoData(database);

  const storageRoot = join(temporaryDirectory, `storage-${randomUUID()}`);
  const app = await createApp({
    demoAuthEnabled: true,
    store: new DatabaseDataStore(database),
    contestStore: new DatabaseContestStore(database),
    demoUserIds: Object.values(databaseDemoUserIds),
    demoLoginUserIds: databaseDemoUserIds,
    problemFiles: {
      metadata: new ProblemFileStore(database),
      storage: new LocalFileStorage({ rootDirectory: storageRoot, limits: { maxBytes } })
    }
  });
  openApps.push(app);
  return {
    app,
    objectsDirectory: join(storageRoot, "objects"),
    stagingDirectory: join(storageRoot, "staging")
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
  expect(firstCookie).toBeTypeOf("string");
  return (firstCookie as string).split(";", 1)[0] as string;
}

async function createDraft(app: FastifyInstance, cookie: string): Promise<{ id: string; revision: number }> {
  const response = await app.inject({
    method: "POST",
    url: "/api/v1/problems",
    headers: { cookie, origin: localOrigin },
    payload: {
      title: "文件接口演示题目",
      type: "traditional",
      tagIds: ["algorithm.implementation"],
      content: fullContent
    }
  });
  expect(response.statusCode).toBe(200);
  const body = response.json() as { id: string; revision: number };
  return { id: body.id, revision: body.revision };
}

interface UploadOptions {
  readonly expectedRevision: number;
  readonly category: string;
  readonly logicalPath: string;
  readonly originalName: string;
  readonly mediaType?: string;
  readonly replaceExisting?: boolean;
  readonly content?: string | Buffer | Readable;
}

async function uploadFile(
  app: FastifyInstance,
  cookie: string,
  problemId: string,
  options: UploadOptions
) {
  const query = new URLSearchParams({
    expectedRevision: String(options.expectedRevision),
    category: options.category,
    logicalPath: options.logicalPath,
    originalName: options.originalName,
    mediaType: options.mediaType ?? "text/plain"
  });
  if (options.replaceExisting === true) {
    query.set("replaceExisting", "true");
  }
  return app.inject({
    method: "PUT",
    url: `/api/v1/problems/${problemId}/files?${query.toString()}`,
    headers: { cookie, origin: localOrigin, "content-type": "application/octet-stream" },
    payload: options.content ?? "file-content"
  });
}

async function countFiles(directory: string): Promise<number> {
  try {
    return (await readdir(directory)).length;
  } catch {
    return 0;
  }
}

describe("题目文件接口", () => {
  it("作者上传公开附件后可以列出并下载，题目版本号随之增加", async () => {
    const { app } = await makeFileApp();
    const author = await login(app, databaseDemoUserIds.author);
    const draft = await createDraft(app, author);

    const uploaded = await uploadFile(app, author, draft.id, {
      expectedRevision: draft.revision,
      category: "public_attachment",
      logicalPath: "attachments/note.txt",
      originalName: "说明.txt",
      content: "hello urmotiv"
    });
    expect(uploaded.statusCode).toBe(200);
    const uploadBody = uploaded.json() as {
      item: { id: string; sha256: string; byteSize: number };
      revision: number;
    };
    expect(uploadBody.revision).toBe(draft.revision + 1);
    expect(uploadBody.item.byteSize).toBe(Buffer.byteLength("hello urmotiv"));
    expect(JSON.stringify(uploadBody)).not.toContain("storageKey");
    expect(JSON.stringify(uploadBody)).not.toContain("objects/");

    const listed = await app.inject({
      method: "GET",
      url: `/api/v1/problems/${draft.id}/files`,
      headers: { cookie: author }
    });
    expect(listed.statusCode).toBe(200);
    expect(listed.json()).toEqual({
      items: [
        expect.objectContaining({
          id: uploadBody.item.id,
          category: "public_attachment",
          logicalPath: "attachments/note.txt",
          originalName: "说明.txt"
        })
      ]
    });
    expect(listed.body).not.toContain("storageKey");

    const downloaded = await app.inject({
      method: "GET",
      url: `/api/v1/problems/${draft.id}/files/${uploadBody.item.id}`,
      headers: { cookie: author }
    });
    expect(downloaded.statusCode).toBe(200);
    expect(downloaded.body).toBe("hello urmotiv");
    expect(downloaded.headers["content-type"]).toBe("text/plain");
    expect(downloaded.headers["content-disposition"]).toContain("filename*=UTF-8''");
    expect(downloaded.headers["cache-control"]).toBe("private, no-store");
    expect(downloaded.headers["x-content-type-options"]).toBe("nosniff");
  });

  it("没有测试数据权限的作者不能上传内部文件，命题组成员可以", async () => {
    const { app } = await makeFileApp();
    const author = await login(app, databaseDemoUserIds.author);
    const member = await login(app, databaseDemoUserIds.member);
    const draft = await createDraft(app, author);

    const rejected = await uploadFile(app, author, draft.id, {
      expectedRevision: draft.revision,
      category: "testdata",
      logicalPath: "tests/001.in",
      originalName: "001.in"
    });
    expect(rejected.statusCode).toBe(403);

    const accepted = await uploadFile(app, member, draft.id, {
      expectedRevision: draft.revision,
      category: "testdata",
      logicalPath: "tests/001.in",
      originalName: "001.in",
      content: "1 2\n"
    });
    expect(accepted.statusCode).toBe(200);
  });

  it("无权查看题目的用户对文件列表、上传和下载都得到不存在", async () => {
    const { app } = await makeFileApp();
    const author = await login(app, databaseDemoUserIds.author);
    const denied = await login(app, databaseDemoUserIds.denied);
    const draft = await createDraft(app, author);
    const uploaded = await uploadFile(app, author, draft.id, {
      expectedRevision: draft.revision,
      category: "public_attachment",
      logicalPath: "attachments/note.txt",
      originalName: "note.txt"
    });
    const fileId = (uploaded.json() as { item: { id: string } }).item.id;

    const listResponse = await app.inject({
      method: "GET",
      url: `/api/v1/problems/${draft.id}/files`,
      headers: { cookie: denied }
    });
    expect(listResponse.statusCode).toBe(404);
    expect(listResponse.body).not.toContain("note.txt");

    const uploadResponse = await uploadFile(app, denied, draft.id, {
      expectedRevision: draft.revision + 1,
      category: "public_attachment",
      logicalPath: "attachments/other.txt",
      originalName: "other.txt"
    });
    expect(uploadResponse.statusCode).toBe(404);

    const downloadResponse = await app.inject({
      method: "GET",
      url: `/api/v1/problems/${draft.id}/files/${fileId}`,
      headers: { cookie: denied }
    });
    expect(downloadResponse.statusCode).toBe(404);
  });

  it("内部文件对没有测试数据读取权限的用户完全隐藏", async () => {
    const { app } = await makeFileApp();
    const author = await login(app, databaseDemoUserIds.author);
    const member = await login(app, databaseDemoUserIds.member);
    const reviewer = await login(app, databaseDemoUserIds.reviewer);
    const draft = await createDraft(app, author);

    const uploadedInternal = await uploadFile(app, member, draft.id, {
      expectedRevision: draft.revision,
      category: "testdata",
      logicalPath: "tests/001.in",
      originalName: "001.in",
      content: "secret-testdata"
    });
    expect(uploadedInternal.statusCode).toBe(200);
    const internalBody = uploadedInternal.json() as { item: { id: string }; revision: number };
    const uploadedPublic = await uploadFile(app, author, draft.id, {
      expectedRevision: internalBody.revision,
      category: "statement_image",
      logicalPath: "assets/figure.png",
      originalName: "figure.png",
      mediaType: "image/png",
      content: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x01])
    });
    expect(uploadedPublic.statusCode).toBe(200);

    const authorList = await app.inject({
      method: "GET",
      url: `/api/v1/problems/${draft.id}/files`,
      headers: { cookie: author }
    });
    expect(authorList.statusCode).toBe(200);
    const authorItems = (authorList.json() as { items: Array<{ category: string }> }).items;
    expect(authorItems).toHaveLength(1);
    expect(authorItems[0]?.category).toBe("statement_image");
    expect(authorList.body).not.toContain("001.in");
    expect(authorList.body).not.toContain("testdata");

    const authorDownload = await app.inject({
      method: "GET",
      url: `/api/v1/problems/${draft.id}/files/${internalBody.item.id}`,
      headers: { cookie: author }
    });
    expect(authorDownload.statusCode).toBe(404);
    expect(authorDownload.body).not.toContain("secret-testdata");

    const reviewerList = await app.inject({
      method: "GET",
      url: `/api/v1/problems/${draft.id}/files`,
      headers: { cookie: reviewer }
    });
    expect(reviewerList.statusCode).toBe(200);
    expect((reviewerList.json() as { items: unknown[] }).items).toHaveLength(2);

    const reviewerDownload = await app.inject({
      method: "GET",
      url: `/api/v1/problems/${draft.id}/files/${internalBody.item.id}`,
      headers: { cookie: reviewer }
    });
    expect(reviewerDownload.statusCode).toBe(200);
    expect(reviewerDownload.body).toBe("secret-testdata");
  });

  it("相同路径重复上传需要明确选择替换，失败时不留下新对象文件", async () => {
    const { app, objectsDirectory } = await makeFileApp();
    const author = await login(app, databaseDemoUserIds.author);
    const draft = await createDraft(app, author);

    const first = await uploadFile(app, author, draft.id, {
      expectedRevision: draft.revision,
      category: "public_attachment",
      logicalPath: "attachments/note.txt",
      originalName: "note.txt",
      content: "first-version"
    });
    expect(first.statusCode).toBe(200);
    const firstBody = first.json() as { item: { id: string }; revision: number };
    expect(await countFiles(objectsDirectory)).toBe(1);

    const conflicted = await uploadFile(app, author, draft.id, {
      expectedRevision: firstBody.revision,
      category: "public_attachment",
      logicalPath: "attachments/note.txt",
      originalName: "note.txt",
      content: "conflicting-version"
    });
    expect(conflicted.statusCode).toBe(409);
    expect(await countFiles(objectsDirectory)).toBe(1);

    const replaced = await uploadFile(app, author, draft.id, {
      expectedRevision: firstBody.revision,
      category: "public_attachment",
      logicalPath: "attachments/note.txt",
      originalName: "note.txt",
      replaceExisting: true,
      content: "second-version"
    });
    expect(replaced.statusCode).toBe(200);
    const replacedBody = replaced.json() as { item: { id: string }; revision: number };
    expect(replacedBody.item.id).not.toBe(firstBody.item.id);

    const listed = await app.inject({
      method: "GET",
      url: `/api/v1/problems/${draft.id}/files`,
      headers: { cookie: author }
    });
    expect((listed.json() as { items: Array<{ id: string }> }).items).toEqual([
      expect.objectContaining({ id: replacedBody.item.id })
    ]);

    const downloaded = await app.inject({
      method: "GET",
      url: `/api/v1/problems/${draft.id}/files/${replacedBody.item.id}`,
      headers: { cookie: author }
    });
    expect(downloaded.body).toBe("second-version");
  });

  it("版本号不匹配时上传失败并清理刚发布的对象文件", async () => {
    const { app, objectsDirectory, stagingDirectory } = await makeFileApp();
    const author = await login(app, databaseDemoUserIds.author);
    const draft = await createDraft(app, author);

    const stale = await uploadFile(app, author, draft.id, {
      expectedRevision: draft.revision + 5,
      category: "public_attachment",
      logicalPath: "attachments/late.txt",
      originalName: "late.txt"
    });
    expect(stale.statusCode).toBe(409);
    expect(await countFiles(objectsDirectory)).toBe(0);
    expect(await countFiles(stagingDirectory)).toBe(0);
  });

  it("超出大小限制的上传被拒绝且不留下临时文件", async () => {
    const { app, objectsDirectory, stagingDirectory } = await makeFileApp(64);
    const author = await login(app, databaseDemoUserIds.author);
    const draft = await createDraft(app, author);

    const tooLarge = await uploadFile(app, author, draft.id, {
      expectedRevision: draft.revision,
      category: "public_attachment",
      logicalPath: "attachments/huge.bin",
      originalName: "huge.bin",
      mediaType: "application/octet-stream",
      content: Buffer.alloc(1024, 1)
    });
    expect(tooLarge.statusCode).toBe(413);
    expect(await countFiles(objectsDirectory)).toBe(0);
    expect(await countFiles(stagingDirectory)).toBe(0);
  });

  it("删除只影响新版本的关联，历史对象文件保留", async () => {
    const { app, objectsDirectory } = await makeFileApp();
    const author = await login(app, databaseDemoUserIds.author);
    const draft = await createDraft(app, author);
    const uploaded = await uploadFile(app, author, draft.id, {
      expectedRevision: draft.revision,
      category: "public_attachment",
      logicalPath: "attachments/note.txt",
      originalName: "note.txt"
    });
    const uploadBody = uploaded.json() as { item: { id: string }; revision: number };

    const removed = await app.inject({
      method: "DELETE",
      url: `/api/v1/problems/${draft.id}/files/${uploadBody.item.id}`,
      headers: { cookie: author, origin: localOrigin },
      payload: { expectedRevision: uploadBody.revision }
    });
    expect(removed.statusCode).toBe(200);
    expect(removed.json()).toEqual({ ok: true, revision: uploadBody.revision + 1 });

    const listed = await app.inject({
      method: "GET",
      url: `/api/v1/problems/${draft.id}/files`,
      headers: { cookie: author }
    });
    expect(listed.json()).toEqual({ items: [] });

    const download = await app.inject({
      method: "GET",
      url: `/api/v1/problems/${draft.id}/files/${uploadBody.item.id}`,
      headers: { cookie: author }
    });
    expect(download.statusCode).toBe(404);
    expect(await countFiles(objectsDirectory)).toBe(1);
  });

  it("作者不能删除内部文件，机器人无编辑权也不能上传", async () => {
    const { app } = await makeFileApp();
    const author = await login(app, databaseDemoUserIds.author);
    const member = await login(app, databaseDemoUserIds.member);
    const robot = await login(app, databaseDemoUserIds.robot);
    const draft = await createDraft(app, author);

    const uploadedInternal = await uploadFile(app, member, draft.id, {
      expectedRevision: draft.revision,
      category: "checker",
      logicalPath: "judge/checker/check.cpp",
      originalName: "check.cpp",
      mediaType: "text/x-c++src"
    });
    expect(uploadedInternal.statusCode).toBe(200);
    const internalBody = uploadedInternal.json() as { item: { id: string }; revision: number };

    const authorRemoval = await app.inject({
      method: "DELETE",
      url: `/api/v1/problems/${draft.id}/files/${internalBody.item.id}`,
      headers: { cookie: author, origin: localOrigin },
      payload: { expectedRevision: internalBody.revision }
    });
    expect(authorRemoval.statusCode).toBe(404);

    const robotUpload = await uploadFile(app, robot, draft.id, {
      expectedRevision: internalBody.revision,
      category: "public_attachment",
      logicalPath: "attachments/robot.txt",
      originalName: "robot.txt"
    });
    expect(robotUpload.statusCode).toBe(403);
  });

  it("题面图片会绕过客户端声明按文件头校验，失败时不发布文件或创建版本", async () => {
    const { app, objectsDirectory, stagingDirectory } = await makeFileApp();
    const author = await login(app, databaseDemoUserIds.author);
    const draft = await createDraft(app, author);

    const invalidUploads = [
      {
        logicalPath: "assets/invalid.svg",
        originalName: "invalid.svg",
        mediaType: "image/svg+xml",
        content: Buffer.from("<svg>private-image-detail</svg>")
      },
      {
        logicalPath: "assets/mismatched.png",
        originalName: "mismatched.png",
        mediaType: "image/png",
        content: Buffer.from([0xff, 0xd8, 0xff, 0x00])
      },
      {
        logicalPath: "assets/empty.gif",
        originalName: "empty.gif",
        mediaType: "image/gif",
        content: Buffer.alloc(0)
      },
      {
        logicalPath: "assets/truncated.webp",
        originalName: "truncated.webp",
        mediaType: "image/webp",
        content: Buffer.from("RIFF")
      },
      {
        logicalPath: "assets/disguised.svg",
        originalName: "disguised.png",
        mediaType: "image/png",
        content: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
      },
      {
        logicalPath: "assets/disguised.png",
        originalName: "disguised.bin",
        mediaType: "image/png",
        content: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
      }
    ];

    for (const invalid of invalidUploads) {
      const response = await uploadFile(app, author, draft.id, {
        expectedRevision: draft.revision,
        category: "statement_image",
        logicalPath: invalid.logicalPath,
        originalName: invalid.originalName,
        mediaType: invalid.mediaType,
        content: invalid.content
      });
      expect(response.statusCode).toBe(422);
      expect(response.json()).toEqual({
        error: expect.objectContaining({ code: "INVALID_STATEMENT_IMAGE" })
      });
      expect(response.body).not.toContain("private-image-detail");
    }

    expect(await countFiles(objectsDirectory)).toBe(0);
    expect(await countFiles(stagingDirectory)).toBe(0);

    const validAfterFailures = await uploadFile(app, author, draft.id, {
      expectedRevision: draft.revision,
      category: "statement_image",
      logicalPath: "assets/valid.png",
      originalName: "valid.png",
      mediaType: "image/png",
      content: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
    });
    expect(validAfterFailures.statusCode).toBe(200);
    expect((validAfterFailures.json() as { revision: number }).revision).toBe(draft.revision + 1);
  });

  it("跨数据块读取最短 WebP 文件头，并完整保留后续字节", async () => {
    const { app } = await makeFileApp();
    const author = await login(app, databaseDemoUserIds.author);
    const draft = await createDraft(app, author);
    const chunks = [
      Buffer.from("R"),
      Buffer.from("IF"),
      Buffer.from([0x46, 0x04, 0x00, 0x00, 0x00, 0x57]),
      Buffer.from("EBPpayload")
    ];

    const uploaded = await uploadFile(app, author, draft.id, {
      expectedRevision: draft.revision,
      category: "statement_image",
      logicalPath: "assets/figure.webp",
      originalName: "figure.webp",
      mediaType: "image/webp",
      content: Readable.from(chunks)
    });
    expect(uploaded.statusCode).toBe(200);
    const uploadBody = uploaded.json() as { item: { id: string; byteSize: number } };
    expect(uploadBody.item.byteSize).toBe(Buffer.concat(chunks).byteLength);

    const downloaded = await app.inject({
      method: "GET",
      url: `/api/v1/problems/${draft.id}/files/${uploadBody.item.id}`,
      headers: { cookie: author }
    });
    expect(downloaded.statusCode).toBe(200);
    expect(downloaded.rawPayload).toEqual(Buffer.concat(chunks));
    expect(downloaded.headers["x-content-type-options"]).toBe("nosniff");
  });

  it("题面图片允许四种声明类型且各自必须使用对应文件头", async () => {
    const { app } = await makeFileApp();
    const author = await login(app, databaseDemoUserIds.author);
    const draft = await createDraft(app, author);
    const images = [
      {
        logicalExtension: "PNG",
        originalExtension: "png",
        mediaType: "image/png",
        content: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x01])
      },
      {
        logicalExtension: "jpeg",
        originalExtension: "JPG",
        mediaType: "image/jpeg",
        content: Buffer.from([0xff, 0xd8, 0xff, 0xe0])
      },
      {
        logicalExtension: "GiF",
        originalExtension: "gif",
        mediaType: "image/gif",
        content: Buffer.from("GIF89a+")
      },
      {
        logicalExtension: "webp",
        originalExtension: "WEBP",
        mediaType: "image/webp",
        content: Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(4), Buffer.from("WEBP+")])
      }
    ];
    let expectedRevision = draft.revision;

    for (const image of images) {
      const uploaded = await uploadFile(app, author, draft.id, {
        expectedRevision,
        category: "statement_image",
        logicalPath: `assets/allowed.${image.logicalExtension}`,
        originalName: `allowed.${image.originalExtension}`,
        mediaType: image.mediaType,
        content: image.content
      });
      expect(uploaded.statusCode).toBe(200);
      const body = uploaded.json() as { item: { mediaType: string }; revision: number };
      expect(body.item.mediaType).toBe(image.mediaType);
      expectedRevision = body.revision;
    }
  });

  it("文件存储和读取失败使用固定响应且不泄漏底层错误", async () => {
    const { app } = await makeFileApp();
    const author = await login(app, databaseDemoUserIds.author);
    const draft = await createDraft(app, author);
    const privateFailure = "private-storage-detail";

    vi.spyOn(LocalFileStorage.prototype, "stage").mockRejectedValueOnce(new Error(privateFailure));
    const failedUpload = await uploadFile(app, author, draft.id, {
      expectedRevision: draft.revision,
      category: "public_attachment",
      logicalPath: "attachments/failure.txt",
      originalName: "failure.txt"
    });
    expect(failedUpload.statusCode).toBe(500);
    expect(failedUpload.json()).toEqual({
      error: expect.objectContaining({ code: "STORAGE_FAILED" })
    });
    expect(failedUpload.body).not.toContain(privateFailure);

    const uploaded = await uploadFile(app, author, draft.id, {
      expectedRevision: draft.revision,
      category: "public_attachment",
      logicalPath: "attachments/available.txt",
      originalName: "available.txt"
    });
    expect(uploaded.statusCode).toBe(200);
    const fileId = (uploaded.json() as { item: { id: string } }).item.id;

    const openFile = vi
      .spyOn(LocalFileStorage.prototype, "open")
      .mockRejectedValueOnce(new Error(privateFailure));
    const failedDownload = await app.inject({
      method: "GET",
      url: `/api/v1/problems/${draft.id}/files/${fileId}`,
      headers: { cookie: author }
    });
    expect(failedDownload.statusCode).toBe(500);
    expect(failedDownload.json()).toEqual({
      error: expect.objectContaining({ code: "STORAGE_FAILED" })
    });
    expect(failedDownload.body).not.toContain(privateFailure);

    const failingReadStream: AsyncIterable<Uint8Array> = {
      [Symbol.asyncIterator]: () => ({
        next: () => Promise.reject(new Error(privateFailure))
      })
    };
    openFile.mockResolvedValueOnce(failingReadStream);
    const failedStreamDownload = await app.inject({
      method: "GET",
      url: `/api/v1/problems/${draft.id}/files/${fileId}`,
      headers: { cookie: author }
    });
    expect(failedStreamDownload.statusCode).toBe(500);
    expect(failedStreamDownload.json()).toEqual({
      error: expect.objectContaining({ code: "STORAGE_FAILED" })
    });
    expect(failedStreamDownload.body).not.toContain(privateFailure);

    const closeEmptyRead = vi.fn(async (): Promise<IteratorResult<Uint8Array>> => ({
      done: true,
      value: undefined
    }));
    const emptyChunkStream: AsyncIterable<Uint8Array> = {
      [Symbol.asyncIterator]: () => ({
        next: async () => ({ done: false, value: new Uint8Array(0) }),
        return: closeEmptyRead
      })
    };
    openFile.mockResolvedValueOnce(emptyChunkStream);
    const failedEmptyChunks = await app.inject({
      method: "GET",
      url: `/api/v1/problems/${draft.id}/files/${fileId}`,
      headers: { cookie: author }
    });
    expect(failedEmptyChunks.statusCode).toBe(500);
    expect(failedEmptyChunks.json()).toEqual({
      error: expect.objectContaining({ code: "STORAGE_FAILED" })
    });
    expect(closeEmptyRead).toHaveBeenCalledOnce();

    const closeShortRead = vi.fn(async (): Promise<IteratorResult<Uint8Array>> => ({
      done: true,
      value: undefined
    }));
    const shortStream: AsyncIterable<Uint8Array> = {
      [Symbol.asyncIterator]: () => ({
        next: async () => ({ done: true, value: undefined }),
        return: closeShortRead
      })
    };
    openFile.mockResolvedValueOnce(shortStream);
    const failedLength = await app.inject({
      method: "GET",
      url: `/api/v1/problems/${draft.id}/files/${fileId}`,
      headers: { cookie: author }
    });
    expect(failedLength.statusCode).toBe(500);
    expect(failedLength.json()).toEqual({
      error: expect.objectContaining({ code: "STORAGE_FAILED" })
    });
    expect(closeShortRead).toHaveBeenCalledOnce();

    let partialReadCount = 0;
    const closePartialRead = vi.fn(async (): Promise<IteratorResult<Uint8Array>> => ({
      done: true,
      value: undefined
    }));
    const partialFailureStream: AsyncIterable<Uint8Array> = {
      [Symbol.asyncIterator]: () => ({
        next: async () => {
          partialReadCount += 1;
          if (partialReadCount === 1) {
            return { done: false as const, value: new Uint8Array(Buffer.from("file-")) };
          }
          throw new Error(privateFailure);
        },
        return: closePartialRead
      })
    };
    openFile.mockResolvedValueOnce(partialFailureStream);
    let partialResponse: Awaited<ReturnType<typeof app.inject>> | undefined;
    let partialError: unknown;
    try {
      partialResponse = await app.inject({
        method: "GET",
        url: `/api/v1/problems/${draft.id}/files/${fileId}`,
        headers: { cookie: author }
      });
    } catch (error) {
      partialError = error;
    }
    expect(partialResponse !== undefined || partialError !== undefined).toBe(true);
    const visibleFailure =
      partialResponse?.body ??
      (partialError instanceof Error ? `${partialError.name}:${partialError.message}` : "");
    expect(visibleFailure).not.toContain(privateFailure);
    if (partialResponse !== undefined) {
      expect(partialResponse.rawPayload.byteLength).toBeLessThan(Buffer.byteLength("file-content"));
    }
    expect(closePartialRead).toHaveBeenCalledOnce();
  });
});
