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
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app";
import { ContestService } from "../src/contest-service";
import { DatabaseContestStore } from "../src/database-contest-store";
import { databaseDemoUserIds, seedDatabaseDemoData } from "../src/database-demo";
import { DatabaseDataStore } from "../src/database-store";
import type { StoredProblem, StoredUser } from "../src/domain";

let temporaryDirectory = "";
const openDatabases = new Set<LocalDatabaseHandle>();

beforeEach(async () => {
  temporaryDirectory = await mkdtemp(join(tmpdir(), "urmotiv-contest-database-"));
});

afterEach(async () => {
  await Promise.all([...openDatabases].map((database) => database.close()));
  openDatabases.clear();
  await rm(temporaryDirectory, { recursive: true, force: true });
});

async function openDatabase(initialize: boolean): Promise<LocalDatabaseHandle> {
  const database = createLocalDatabase({ dataDirectory: join(temporaryDirectory, "database") });
  openDatabases.add(database);
  if (initialize) {
    await migrateDatabase(database);
    await seedCoreDatabase(database);
    await seedDatabaseDemoData(database);
  }
  return database;
}

async function closeDatabase(database: LocalDatabaseHandle): Promise<void> {
  openDatabases.delete(database);
  await database.close();
}

function requireUser(user: StoredUser | undefined): StoredUser {
  if (user === undefined) {
    throw new Error("缺少数据库演示用户。");
  }
  return user;
}

function approvedProblem(): StoredProblem {
  return {
    id: randomUUID(),
    title: "公开构造的持久化组题测试题",
    type: "traditional",
    tagIds: ["algorithm.implementation"],
    codeforcesDifficulty: 1400,
    thinkingLevel: 2,
    codingLevel: 2,
    content: {
      basicStatement: "给定两个整数。",
      basicSolution: "计算它们的和。",
      background: "",
      statement: "",
      inputFormat: "",
      outputFormat: "",
      constraints: "",
      solution: "",
      hints: ""
    },
    samples: [],
    status: "approved",
    ownerId: databaseDemoUserIds.author,
    revision: 1,
    reviewRound: 0,
    createdAt: "2026-07-26T00:00:00.000Z",
    updatedAt: "2026-07-26T00:00:00.000Z"
  };
}

describe("数据库组题与访问记录仓库", () => {
  it("重启后保留固定修订和风险记录，重复心跳不重复累计", async () => {
    const database = await openDatabase(true);
    const problemStore = new DatabaseDataStore(database);
    const contestStore = new DatabaseContestStore(database);
    const author = requireUser(await problemStore.getUser(databaseDemoUserIds.author));
    const leader = requireUser(await problemStore.getUser(databaseDemoUserIds.leader));
    const problem = await problemStore.createProblem(approvedProblem());
    const clockBase = Date.now();
    let now = new Date(clockBase);
    const service = new ContestService(problemStore, contestStore, { now: () => now });

    await service.recordProblemAccess(author, problem.id, 0);
    now = new Date(clockBase + 15_000);
    await service.recordProblemAccess(author, problem.id, 15);
    await service.recordProblemAccess(author, problem.id, 15);
    const created = await service.createContest(leader, {
      title: "持久化组题方案",
      description: "只使用公开构造的数据测试。",
      startsAt: null,
      endsAt: null,
      members: [{ userId: author.id, role: "participant" }],
      problems: [{ problemId: problem.id, score: 100, estimatedDifficulty: 2 }]
    });
    const revisionId = created.problems[0]?.revisionId;
    expect(created.problems[0]).toMatchObject({
      revision: 1,
      leakRiskCount: 1,
      leakRiskEntries: [expect.objectContaining({ totalActiveSeconds: 15 })]
    });

    await closeDatabase(database);
    const reopened = await openDatabase(false);
    const reopenedProblemStore = new DatabaseDataStore(reopened);
    const reopenedLeader = requireUser(
      await reopenedProblemStore.getUser(databaseDemoUserIds.leader)
    );
    const reopenedService = new ContestService(
      reopenedProblemStore,
      new DatabaseContestStore(reopened)
    );
    const stored = await reopenedService.getContest(reopenedLeader, created.id);

    expect(stored.problems[0]).toMatchObject({
      problemId: problem.id,
      revisionId,
      revision: 1,
      title: problem.title,
      leakRiskCount: 1
    });
    expect(stored.members).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ user: expect.objectContaining({ id: author.id }), role: "participant" }),
        expect.objectContaining({ user: expect.objectContaining({ id: leader.id }), role: "manager" })
      ])
    );
  });

  it("HTTP 路由重新检查登录、来源和对象权限", async () => {
    const database = await openDatabase(true);
    const problemStore = new DatabaseDataStore(database);
    const contestStore = new DatabaseContestStore(database);
    const problem = await problemStore.createProblem(approvedProblem());
    const clockBase = Date.now();
    let now = new Date(clockBase);
    const app = await createApp({
      store: problemStore,
      contestStore,
      demoAuthEnabled: true,
      demoUserIds: Object.values(databaseDemoUserIds),
      demoLoginUserIds: databaseDemoUserIds,
      now: () => now
    });
    const origin = "http://localhost:5173";
    const login = async (userId: "author" | "leader") => {
      const response = await app.inject({
        method: "POST",
        url: "/api/v1/auth/demo-login",
        headers: { origin },
        payload: { userId }
      });
      expect(response.statusCode).toBe(200);
      const header = response.headers["set-cookie"];
      const cookie = (Array.isArray(header) ? header[0] : header)?.split(";", 1)[0];
      expect(cookie).toBeTypeOf("string");
      return cookie as string;
    };

    try {
      const authorCookie = await login("author");
      const leaderCookie = await login("leader");
      const firstRead = await app.inject({
        method: "GET",
        url: `/api/v1/problems/${problem.id}`,
        headers: { cookie: authorCookie }
      });
      expect(firstRead.statusCode).toBe(200);
      now = new Date(clockBase + 15_000);
      const heartbeat = await app.inject({
        method: "POST",
        url: `/api/v1/problems/${problem.id}/access-heartbeat`,
        headers: { cookie: authorCookie, origin },
        payload: { activeSeconds: 15 }
      });
      expect(heartbeat.statusCode).toBe(200);

      const createResponse = await app.inject({
        method: "POST",
        url: "/api/v1/contests",
        headers: { cookie: leaderCookie, origin },
        payload: {
          title: "API 组题方案",
          description: "",
          startsAt: null,
          endsAt: null,
          members: [{ userId: databaseDemoUserIds.author, role: "participant" }],
          problems: [{ problemId: problem.id, score: 100, estimatedDifficulty: 2 }]
        }
      });
      expect(createResponse.statusCode).toBe(200);
      const contestId = (createResponse.json() as { id: string }).id;

      const guessedContest = await app.inject({
        method: "GET",
        url: `/api/v1/contests/${contestId}`,
        headers: { cookie: authorCookie }
      });
      expect(guessedContest.statusCode).toBe(404);
      const authorAccess = await app.inject({
        method: "GET",
        url: `/api/v1/problems/${problem.id}/access`,
        headers: { cookie: authorCookie }
      });
      expect(authorAccess.statusCode).toBe(403);

      const leaderContest = await app.inject({
        method: "GET",
        url: `/api/v1/contests/${contestId}`,
        headers: { cookie: leaderCookie }
      });
      expect(leaderContest.statusCode).toBe(200);
      expect(leaderContest.json()).toEqual(
        expect.objectContaining({
          problems: [
            expect.objectContaining({
              problemId: problem.id,
              revision: 1,
              leakRiskCount: 1
            })
          ]
        })
      );
      const leaderAccess = await app.inject({
        method: "GET",
        url: `/api/v1/problems/${problem.id}/access`,
        headers: { cookie: leaderCookie }
      });
      expect(leaderAccess.statusCode).toBe(200);
      expect(leaderAccess.json()).toEqual({
        items: [expect.objectContaining({ totalActiveSeconds: 15 })]
      });
    } finally {
      await app.close();
    }
  });
});
