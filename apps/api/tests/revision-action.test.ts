import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createLocalDatabase,
  type LocalDatabaseHandle,
  migrateDatabase,
  seedCoreDatabase,
} from "@urmotiv/database";
import type { CreateStoredFileInput } from "@urmotiv/contracts";
import { sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { databaseDemoUserIds, seedDatabaseDemoData } from "../src/database-demo";
import { DatabaseDataStore } from "../src/database-store";
import type { StoredProblem, StoredUser } from "../src/domain";
import { createProblemVisibility } from "../src/permissions";
import { ProblemFileStore } from "../src/problem-file-store";
import { ProblemService } from "../src/service";

const createdAt = "2026-07-26T00:00:00.000Z";
const updateAt = "2026-07-26T00:01:00.000Z";
const openDatabases = new Set<LocalDatabaseHandle>();

let temporaryDirectory = "";

beforeEach(async () => {
  temporaryDirectory = await mkdtemp(join(tmpdir(), "urmotiv-revision-action-"));
});

afterEach(async () => {
  await Promise.all([...openDatabases].map((database) => database.close()));
  openDatabases.clear();
  await rm(temporaryDirectory, { recursive: true, force: true });
});

async function openDatabase(): Promise<LocalDatabaseHandle> {
  const database = createLocalDatabase({ dataDirectory: join(temporaryDirectory, "database") });
  openDatabases.add(database);
  await migrateDatabase(database);
  await seedCoreDatabase(database);
  await seedDatabaseDemoData(database);
  return database;
}

function makeProblem(overrides: Partial<StoredProblem> = {}): StoredProblem {
  return {
    id: randomUUID(),
    title: "Revision action regression fixture",
    type: "traditional",
    tagIds: ["catalog.tag.02.09"],
    codeforcesDifficulty: 1200,
    thinkingLevel: 2,
    codingLevel: 2,
    content: {
      basicStatement: "A deliberately constructed statement.",
      basicSolution: "A deliberately constructed solution.",
      background: "",
      statement: "",
      inputFormat: "",
      outputFormat: "",
      constraints: "",
      solution: "",
      hints: "",
    },
    samples: [],
    judgeConfig: null,
    status: "draft",
    ownerId: databaseDemoUserIds.author,
    revision: 1,
    reviewRound: 0,
    createdAt,
    updatedAt: createdAt,
    ...overrides,
  };
}

function requireUser(user: StoredUser | undefined): StoredUser {
  if (user === undefined) {
    throw new Error("The fixture author was not seeded.");
  }
  return user;
}

function requireRevisionId(problem: StoredProblem): string {
  if (problem.revisionId === undefined) {
    throw new Error("The database problem did not expose its internal revision id.");
  }
  return problem.revisionId;
}

async function loadCurrentProblem(
  store: DatabaseDataStore,
  user: StoredUser,
  problemId: string,
): Promise<StoredProblem> {
  const problem = await store.findVisibleProblem(problemId, createProblemVisibility(user));
  if (problem === undefined) {
    throw new Error("The fixture problem is not visible to its author.");
  }
  return problem;
}

function nextRevision(problem: StoredProblem, title: string): StoredProblem {
  return {
    ...problem,
    title,
    revision: problem.revision + 1,
    updatedAt: updateAt,
  };
}

function fileInput(originalName: string): CreateStoredFileInput {
  const id = randomUUID();
  return {
    id,
    purpose: "problem",
    storageKey: `revision-action/${id}`,
    originalName,
    mediaType: "text/plain",
    byteSize: 4,
    sha256: "a".repeat(64),
    createdByUserId: databaseDemoUserIds.author,
  };
}

async function countRevisionFiles(
  database: LocalDatabaseHandle,
  problemId: string,
): Promise<number> {
  const rows = await database.query<{ count: string | number }>(sql`
    SELECT count(*)::integer AS count
    FROM problem_revision_files association
    JOIN problem_revisions revision ON revision.id = association.revision_id
    WHERE revision.problem_id = ${BigInt(problemId)}
  `);
  return Number(rows[0]?.count ?? 0);
}

async function countRevisions(
  database: LocalDatabaseHandle,
  problemId: string,
): Promise<number> {
  const rows = await database.query<{ count: string | number }>(sql`
    SELECT count(*)::integer AS count
    FROM problem_revisions
    WHERE problem_id = ${BigInt(problemId)}
  `);
  return Number(rows[0]?.count ?? 0);
}

describe("problem revision actions", () => {
  it("passes the newly inserted revision id to ProblemService actions", async () => {
    const database = await openDatabase();
    const store = new DatabaseDataStore(database);
    const author = requireUser(await store.getUser(databaseDemoUserIds.author));
    const created = await store.createProblem(makeProblem());
    const current = await loadCurrentProblem(store, author, created.id);
    const previousRevisionId = requireRevisionId(current);
    const seen: Array<{ id: string; revision: number }> = [];
    const service = new ProblemService(store, { now: () => new Date(updateAt) });

    const updated = await service.updateProblem(
      author,
      current.id,
      {
        expectedRevision: current.revision,
        content: { ...current.content, statement: "Updated through a revision action." },
      },
      async (revisionId, executor) => {
        const rows = await executor.query<{ id: string; revision: string | number }>(sql`
          SELECT id::text AS id, revision
          FROM problem_revisions
          WHERE id = ${revisionId}::uuid
        `);
        const row = rows[0];
        if (row !== undefined) {
          seen.push({ id: row.id, revision: Number(row.revision) });
        }
      },
    );

    expect(updated.revision).toBe(2);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toEqual({ id: expect.any(String), revision: 2 });
    expect(seen[0]?.id).not.toBe(previousRevisionId);
    expect(seen[0]?.id).toMatch(/^[0-9a-f-]{36}$/i);
  });

  it("rolls back the new revision and every file association when an action fails", async () => {
    const database = await openDatabase();
    const store = new DatabaseDataStore(database);
    const files = new ProblemFileStore(database);
    const author = requireUser(await store.getUser(databaseDemoUserIds.author));
    const created = await store.createProblem(makeProblem());
    const current = await loadCurrentProblem(store, author, created.id);
    const previousRevisionId = requireRevisionId(current);
    const existingFile = await files.createStoredFile(fileInput("existing.in"));
    await files.linkFileToRevision({
      revisionId: previousRevisionId,
      fileId: existingFile.id,
      category: "testdata",
      logicalPath: "tests/existing.in",
      position: 0,
    });
    const actionFile = fileInput("action.in");

    await expect(
      store.replaceProblemWithRevisionAction(
        nextRevision(current, "This revision must roll back"),
        current.revision,
        author.id,
        async (revisionId, executor) => {
          const createdInsideAction = await files.createStoredFile(actionFile, executor);
          await files.linkFileToRevision(
            {
              revisionId,
              fileId: createdInsideAction.id,
              category: "testdata",
              logicalPath: "tests/action.in",
              position: 1,
            },
            executor,
          );
          throw new Error("revision action failed intentionally");
        },
      ),
    ).rejects.toThrow("revision action failed intentionally");

    const afterFailure = await loadCurrentProblem(store, author, current.id);
    expect(afterFailure).toEqual(
      expect.objectContaining({ revision: 1, title: current.title, revisionId: previousRevisionId }),
    );
    expect(await countRevisions(database, current.id)).toBe(1);
    expect(await countRevisionFiles(database, current.id)).toBe(1);
    expect(await files.listRevisionFiles(previousRevisionId)).toEqual([
      expect.objectContaining({ id: existingFile.id, logicalPath: "tests/existing.in" }),
    ]);
    expect(await files.findStoredFile(actionFile.id)).toBeUndefined();
  });

  it("keeps ordinary replacement working and copies valid prior-revision file associations", async () => {
    const database = await openDatabase();
    const store = new DatabaseDataStore(database);
    const files = new ProblemFileStore(database);
    const author = requireUser(await store.getUser(databaseDemoUserIds.author));
    const created = await store.createProblem(makeProblem());
    const current = await loadCurrentProblem(store, author, created.id);
    const previousRevisionId = requireRevisionId(current);
    const priorFile = await files.createStoredFile(fileInput("001.in"));
    await files.linkFileToRevision({
      revisionId: previousRevisionId,
      fileId: priorFile.id,
      category: "testdata",
      logicalPath: "tests/001.in",
      position: 0,
    });

    expect(
      await store.replaceProblem(
        nextRevision(current, "Ordinary replacement remains available"),
        current.revision,
        author.id,
      ),
    ).toBe(true);

    const updated = await loadCurrentProblem(store, author, current.id);
    const updatedRevisionId = requireRevisionId(updated);
    expect(updated).toEqual(
      expect.objectContaining({ revision: 2, title: "Ordinary replacement remains available" }),
    );
    expect(updatedRevisionId).not.toBe(previousRevisionId);
    expect(await files.listRevisionFiles(updatedRevisionId)).toEqual([
      expect.objectContaining({
        id: priorFile.id,
        category: "testdata",
        logicalPath: "tests/001.in",
        position: 0,
      }),
    ]);
    expect(await countRevisions(database, current.id)).toBe(2);
    expect(await countRevisionFiles(database, current.id)).toBe(2);
  });
});
