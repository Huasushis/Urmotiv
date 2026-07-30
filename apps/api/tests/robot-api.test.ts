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
import { sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app";
import { DatabaseContestStore } from "../src/database-contest-store";
import { databaseDemoUserIds, seedDatabaseDemoData } from "../src/database-demo";
import { DatabaseDataStore } from "../src/database-store";
import { hasPermission } from "../src/permissions";
import { DatabaseReviewItemStore } from "../src/review-item-store";
import { DatabaseRobotStore, digestRobotToken } from "../src/robot-store";

const localOrigin = "http://localhost:5173";
const robotToken = "urt_test_robot_token_0123456789abcdef";

const openApps: FastifyInstance[] = [];
const openDatabases: LocalDatabaseHandle[] = [];

let temporaryDirectory = "";

beforeEach(async () => {
  temporaryDirectory = await mkdtemp(join(tmpdir(), "urmotiv-robot-api-"));
});

afterEach(async () => {
  await Promise.all(openApps.splice(0).map((app) => app.close()));
  await Promise.all(openDatabases.splice(0).map((database) => database.close()));
  await rm(temporaryDirectory, { recursive: true, force: true });
});

async function makeRobotApp(): Promise<{ app: FastifyInstance; database: LocalDatabaseHandle; store: DatabaseDataStore }> {
  const database = createLocalDatabase({
    dataDirectory: join(temporaryDirectory, `database-${randomUUID()}`)
  });
  openDatabases.push(database);
  await migrateDatabase(database);
  await seedCoreDatabase(database);
  await seedDatabaseDemoData(database);
  await database.execute(sql`
    INSERT INTO api_tokens (id, user_id, name, token_prefix, token_digest, created_by_user_id)
    VALUES (
      ${randomUUID()}::uuid, ${BigInt(databaseDemoUserIds.robot)}, '测试机器人令牌',
      'urt_test', ${digestRobotToken(robotToken)}, 0
    )
  `);

  const store = new DatabaseDataStore(database);
  const app = await createApp({
    demoAuthEnabled: true,
    store,
    contestStore: new DatabaseContestStore(database),
    demoUserIds: Object.values(databaseDemoUserIds),
    demoLoginUserIds: databaseDemoUserIds,
    reviewItems: new DatabaseReviewItemStore(database),
    robots: new DatabaseRobotStore(database)
  });
  openApps.push(app);
  return { app, database, store };
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

async function createPendingProblem(app: FastifyInstance): Promise<{ id: string }> {
  const author = await login(app, databaseDemoUserIds.author);
  const created = await app.inject({
    method: "POST",
    url: "/api/v1/problems",
    headers: { cookie: author, origin: localOrigin },
    payload: {
      title: "机器人审题演示题",
      type: "traditional",
      tagIds: ["algorithm.implementation"],
      content: {
        basicStatement: "给定 n，输出 n。",
        basicSolution: "直接输出。",
        background: "",
        statement: "",
        inputFormat: "",
        outputFormat: "",
        constraints: "",
        solution: "",
        hints: ""
      }
    }
  });
  expect(created.statusCode).toBe(200);
  const draft = created.json() as { id: string; revision: number };
  const submitted = await app.inject({
    method: "POST",
    url: `/api/v1/problems/${draft.id}/submit`,
    headers: { cookie: author, origin: localOrigin },
    payload: { expectedRevision: draft.revision }
  });
  expect(submitted.statusCode).toBe(200);
  return { id: draft.id };
}

function robotHeaders(token = robotToken): Record<string, string> {
  return { authorization: `Bearer ${token}`, origin: localOrigin };
}

describe("机器人审题接口", () => {
  it("坏令牌与被撤销的令牌都无法认证", async () => {
    const { app, database } = await makeRobotApp();

    const missing = await app.inject({
      method: "POST",
      url: "/api/v1/robot/review-tasks/claim",
      payload: {}
    });
    expect(missing.statusCode).toBe(401);

    const wrong = await app.inject({
      method: "POST",
      url: "/api/v1/robot/review-tasks/claim",
      headers: robotHeaders("urt_wrong_token_0123456789abcdef"),
      payload: {}
    });
    expect(wrong.statusCode).toBe(401);

    await database.execute(sql`UPDATE api_tokens SET revoked_at = now()`);
    const revoked = await app.inject({
      method: "POST",
      url: "/api/v1/robot/review-tasks/claim",
      headers: robotHeaders(),
      payload: {}
    });
    expect(revoked.statusCode).toBe(401);
  });

  it("领取待审任务、提交结构化意见并完成整个闭环", async () => {
    const { app } = await makeRobotApp();
    const problem = await createPendingProblem(app);

    const claimed = await app.inject({
      method: "POST",
      url: "/api/v1/robot/review-tasks/claim",
      headers: robotHeaders(),
      payload: { maximumTasks: 2, leaseSeconds: 120 }
    });
    expect(claimed.statusCode).toBe(200);
    const claimBody = claimed.json() as {
      items: Array<{
        assignmentId: string;
        leaseExpiresAt: string;
        problem: { id: string; revision: number; reviewRound: number; basicStatement: string };
      }>;
    };
    expect(claimBody.items).toHaveLength(1);
    const task = claimBody.items[0]!;
    expect(task.problem.id).toBe(problem.id);
    expect(task.problem.basicStatement).toContain("输出 n");

    const renewed = await app.inject({
      method: "POST",
      url: `/api/v1/robot/review-tasks/${task.assignmentId}/renew`,
      headers: robotHeaders(),
      payload: { expectedLeaseExpiresAt: task.leaseExpiresAt, leaseSeconds: 300 }
    });
    expect(renewed.statusCode).toBe(200);
    const newLease = (renewed.json() as { leaseExpiresAt: string }).leaseExpiresAt;
    expect(newLease).not.toBe(task.leaseExpiresAt);

    const staleRenew = await app.inject({
      method: "POST",
      url: `/api/v1/robot/review-tasks/${task.assignmentId}/renew`,
      headers: robotHeaders(),
      payload: { expectedLeaseExpiresAt: task.leaseExpiresAt, leaseSeconds: 300 }
    });
    expect(staleRenew.statusCode).toBe(404);

    const badRevision = await app.inject({
      method: "POST",
      url: `/api/v1/robot/review-tasks/${task.assignmentId}/complete`,
      headers: robotHeaders(),
      payload: {
        expectedLeaseExpiresAt: newLease,
        expectedProblemRevision: task.problem.revision + 5,
        experimentVersion: "exp-2026-07",
        modelProfileName: "difficulty-v1",
        review: {
          verdict: "approve",
          codeforcesDifficulty: 1600,
          qualityLevel: 4,
          thinkingLevel: 3,
          codingLevel: 2,
          improvements: "机器人分析：题面清晰，可以补充更强的边界样例。",
          expectedRound: task.problem.reviewRound
        }
      }
    });
    expect(badRevision.statusCode).toBe(409);

    const completed = await app.inject({
      method: "POST",
      url: `/api/v1/robot/review-tasks/${task.assignmentId}/complete`,
      headers: robotHeaders(),
      payload: {
        expectedLeaseExpiresAt: newLease,
        expectedProblemRevision: task.problem.revision,
        experimentVersion: "exp-2026-07",
        modelProfileName: "difficulty-v1",
        review: {
          verdict: "approve",
          codeforcesDifficulty: 1600,
          qualityLevel: 4,
          thinkingLevel: 3,
          codingLevel: 2,
          improvements: "机器人分析：题面清晰，可以补充更强的边界样例。",
          expectedRound: task.problem.reviewRound
        }
      }
    });
    expect(completed.statusCode).toBe(200);
    expect(completed.json()).toEqual(
      expect.objectContaining({ accepted: true, problemStatus: "pending_review" })
    );

    const reviewer = await login(app, databaseDemoUserIds.reviewer);
    const reviews = await app.inject({
      method: "GET",
      url: `/api/v1/problems/${problem.id}/reviews`,
      headers: { cookie: reviewer }
    });
    const summary = reviews.json() as {
      reviews: Array<{ source: string; codeforcesDifficulty: number }>;
    };
    expect(summary.reviews).toHaveLength(1);
    expect(summary.reviews[0]).toEqual(
      expect.objectContaining({ source: "fermata", codeforcesDifficulty: 1600 })
    );

    const reclaimed = await app.inject({
      method: "POST",
      url: "/api/v1/robot/review-tasks/claim",
      headers: robotHeaders(),
      payload: {}
    });
    expect((reclaimed.json() as { items: unknown[] }).items).toHaveLength(0);
  });

  it("机器人即使获得组长角色也保留固定禁止项", async () => {
    const { app, database, store } = await makeRobotApp();
    await database.execute(sql`
      INSERT INTO role_memberships (id, user_id, role_id, granted_by_user_id, reason)
      SELECT ${randomUUID()}::uuid, ${BigInt(databaseDemoUserIds.robot)}, role.id, 0, '测试：误授组长角色'
      FROM roles role WHERE role.key = 'leader'
    `);
    const robotUser = await store.getUser(databaseDemoUserIds.robot);
    expect(robotUser).toBeDefined();
    const now = new Date();
    expect(hasPermission(robotUser!, "problem.status.change", {}, now)).toBe(true);
    for (const permission of [
      "problem.delete.all",
      "problem.delete.own",
      "user.delete",
      "user.impersonate",
      "user.permission.manage",
      "system.manage",
      "plugin.manage",
      "contest.delete"
    ]) {
      expect(hasPermission(robotUser!, permission, {}, now)).toBe(false);
    }

    const problem = await createPendingProblem(app);
    const claimed = await app.inject({
      method: "POST",
      url: "/api/v1/robot/review-tasks/claim",
      headers: robotHeaders(),
      payload: {}
    });
    expect((claimed.json() as { items: unknown[] }).items).toHaveLength(1);
    expect(claimed.body).toContain(problem.id);
  });
});
