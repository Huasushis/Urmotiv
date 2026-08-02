import { randomUUID } from "node:crypto";
import {
  createLocalDatabase,
  type LocalDatabaseHandle,
  migrateDatabase,
  seedCoreDatabase
} from "@urmotiv/database";
import { sql } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";
import { ProblemFileStore, ProblemFileStoreError } from "../src/problem-file-store";

const openDatabases: LocalDatabaseHandle[] = [];
const sha256 = "a".repeat(64);

afterEach(async () => {
  await Promise.all(openDatabases.splice(0).map((database) => database.close()));
});

async function openDatabase(): Promise<LocalDatabaseHandle> {
  const database = createLocalDatabase();
  openDatabases.push(database);
  await migrateDatabase(database);
  await seedCoreDatabase(database);
  return database;
}

async function createRevision(
  database: LocalDatabaseHandle,
  input: { problemId: number; revision: number; revisionId: string; createProblem?: boolean }
): Promise<void> {
  await database.transaction(async (transaction) => {
    if (input.createProblem ?? input.revision === 1) {
      await transaction.execute(sql`
        INSERT INTO problems (id, owner_id, current_revision)
        VALUES (${input.problemId}, 0, ${input.revision})
      `);
    }
    await transaction.execute(sql`
      INSERT INTO problem_revisions (
        id,
        problem_id,
        revision,
        status,
        title,
        type,
        basic_statement,
        basic_solution,
        content_hash,
        change_reason,
        created_by_user_id
      ) VALUES (
        ${input.revisionId}::uuid,
        ${input.problemId},
        ${input.revision},
        'draft',
        '公开构造的文件元数据测试题',
        'traditional',
        '题面只用于建表测试。',
        '题解只用于建表测试。',
        ${"0".repeat(64)},
        '建立测试版本',
        0
      )
    `);
    await transaction.execute(sql`
      INSERT INTO problem_revision_tags (revision_id, tag_id)
      VALUES (${input.revisionId}::uuid, 'catalog.tag.02.09')
    `);
  });
}

function fileInput(overrides: Partial<{
  id: string;
  purpose: "problem" | "import_input" | "export_output" | "temporary";
  storageKey: string;
  originalName: string;
  mediaType: string;
  byteSize: number;
  sha256: string;
  createdByUserId: string;
  expiresAt: string | null;
}> = {}) {
  const id = overrides.id ?? randomUUID();
  return {
    id,
    purpose: overrides.purpose ?? "problem",
    storageKey: overrides.storageKey ?? `urmotiv/objects/${id}`,
    originalName: overrides.originalName ?? "fixture.in",
    mediaType: overrides.mediaType ?? "text/plain",
    byteSize: overrides.byteSize ?? 4,
    sha256: overrides.sha256 ?? sha256,
    createdByUserId: overrides.createdByUserId ?? "0",
    ...(overrides.expiresAt === undefined ? {} : { expiresAt: overrides.expiresAt })
  };
}

describe("题目文件元数据仓库", () => {
  it("只持久化元数据，并按版本列举和按存储键定位", async () => {
    const database = await openDatabase();
    const revisionId = randomUUID();
    await createRevision(database, { problemId: 11, revision: 1, revisionId });
    const store = new ProblemFileStore(database);

    const file = await store.createStoredFile(fileInput({ originalName: "001.in" }));
    const linked = await store.linkFileToRevision({
      revisionId,
      fileId: file.id,
      category: "testdata",
      logicalPath: "tests/001.in",
      position: 0
    });

    expect(linked).toEqual(
      expect.objectContaining({
        revisionId,
        id: file.id,
        originalName: "001.in",
        category: "testdata",
        logicalPath: "tests/001.in",
        byteSize: 4
      })
    );
    expect(linked).not.toHaveProperty("content");

    expect(await store.listRevisionFiles(revisionId)).toEqual([
      expect.objectContaining({ id: file.id, logicalPath: "tests/001.in" })
    ]);
    expect(await store.findStoredFileByStorageKey(file.storageKey)).toEqual(
      expect.objectContaining({ id: file.id })
    );
    expect(await store.findRevisionFileByStorageKey(revisionId, file.storageKey)).toEqual(
      expect.objectContaining({ id: file.id, logicalPath: "tests/001.in" })
    );
    expect(await store.findRevisionFileByStorageKey(randomUUID(), file.storageKey)).toBeUndefined();
    expect(await store.findStoredFileByStorageKey("../../private-file")).toBeUndefined();
  });

  it("只复制同一题目的紧邻上一版本，并复用已发布文件记录", async () => {
    const database = await openDatabase();
    const firstRevisionId = randomUUID();
    const secondRevisionId = randomUUID();
    await createRevision(database, { problemId: 12, revision: 1, revisionId: firstRevisionId });
    await createRevision(database, {
      problemId: 12,
      revision: 2,
      revisionId: secondRevisionId,
      createProblem: false
    });
    const store = new ProblemFileStore(database);
    const first = await store.createStoredFile(fileInput({ originalName: "001.in" }));
    const second = await store.createStoredFile(fileInput({ originalName: "001.out" }));
    await store.linkFileToRevision({
      revisionId: firstRevisionId,
      fileId: first.id,
      category: "testdata",
      logicalPath: "tests/001.in",
      position: 0
    });
    await store.linkFileToRevision({
      revisionId: firstRevisionId,
      fileId: second.id,
      category: "testdata",
      logicalPath: "tests/001.out",
      position: 1
    });

    const copied = await store.copyPreviousRevisionFiles(secondRevisionId);
    expect(copied.map((file) => [file.id, file.logicalPath])).toEqual([
      [first.id, "tests/001.in"],
      [second.id, "tests/001.out"]
    ]);
    const storedFileCount = await database.query<{ count: string }>(sql`
      SELECT count(*)::text AS count FROM stored_files
    `);
    expect(storedFileCount[0]?.count).toBe("2");

    await expect(store.copyPreviousRevisionFiles(secondRevisionId)).rejects.toMatchObject({
      code: "TARGET_ALREADY_HAS_FILES"
    } satisfies Partial<ProblemFileStoreError>);
  });

  it("不关联临时、过期或不安全的文件元数据", async () => {
    const database = await openDatabase();
    const revisionId = randomUUID();
    await createRevision(database, { problemId: 13, revision: 1, revisionId });
    const store = new ProblemFileStore(database);

    await expect(
      store.createStoredFile(fileInput({ storageKey: "../../not-allowed" }))
    ).rejects.toThrow();

    const temporary = await store.createStoredFile(fileInput({ purpose: "temporary" }));
    expect(
      await store.linkFileToRevision({
        revisionId,
        fileId: temporary.id,
        category: "testdata",
        logicalPath: "tests/temporary.in",
        position: 0
      })
    ).toBeUndefined();

    const expired = await store.createStoredFile(
      fileInput({ expiresAt: "2020-01-01T00:00:00.000Z" })
    );
    expect(await store.findStoredFile(expired.id)).toBeUndefined();
    expect(
      await store.linkFileToRevision({
        revisionId,
        fileId: expired.id,
        category: "testdata",
        logicalPath: "tests/expired.in",
        position: 1
      })
    ).toBeUndefined();
    expect(await store.listRevisionFiles(revisionId)).toEqual([]);
  });

  it("拒绝同一版本内冲突的逻辑路径", async () => {
    const database = await openDatabase();
    const revisionId = randomUUID();
    await createRevision(database, { problemId: 14, revision: 1, revisionId });
    const store = new ProblemFileStore(database);
    const first = await store.createStoredFile(fileInput());
    const second = await store.createStoredFile(fileInput());
    await store.linkFileToRevision({
      revisionId,
      fileId: first.id,
      category: "testdata",
      logicalPath: "tests/case.in",
      position: 0
    });

    await expect(
      store.linkFileToRevision({
        revisionId,
        fileId: second.id,
        category: "testdata",
        logicalPath: "tests/case.in",
        position: 1
      })
    ).rejects.toMatchObject({ code: "FILE_LINK_CONFLICT" } satisfies Partial<ProblemFileStoreError>);
  });
});
