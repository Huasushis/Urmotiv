import { randomUUID } from "node:crypto";
import {
  type CreatedServiceAccountToken,
} from "@urmotiv/contracts";
import {
  createLocalDatabase,
  migrateDatabase,
  seedCoreDatabase,
  type LocalDatabaseHandle
} from "@urmotiv/database";
import { sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app";
import { DatabaseContestStore } from "../src/database-contest-store";
import { databaseDemoUserIds, seedDatabaseDemoData } from "../src/database-demo";
import { DatabaseDataStore } from "../src/database-store";
import { DatabaseReviewItemStore } from "../src/review-item-store";
import { DatabaseRobotStore } from "../src/robot-store";
import { DatabaseServiceAccountTokenStore } from "../src/service-account-store";
import { DatabaseTagCatalogService } from "../src/tag-catalog-service";

const localOrigin = "http://localhost:5173";
const openApps: FastifyInstance[] = [];
const openDatabases: LocalDatabaseHandle[] = [];

interface ServiceAccountApp {
  readonly app: FastifyInstance;
  readonly database: LocalDatabaseHandle;
}

async function createServiceAccountApp(): Promise<ServiceAccountApp> {
  const database = createLocalDatabase();
  openDatabases.push(database);
  await migrateDatabase(database);
  await seedCoreDatabase(database);
  await seedDatabaseDemoData(database);
  const app = await createApp({
    demoAuthEnabled: true,
    store: new DatabaseDataStore(database),
    contestStore: new DatabaseContestStore(database),
    demoUserIds: Object.values(databaseDemoUserIds),
    demoLoginUserIds: databaseDemoUserIds,
    reviewItems: new DatabaseReviewItemStore(database),
    robots: new DatabaseRobotStore(database),
    serviceAccountTokens: new DatabaseServiceAccountTokenStore(database),
    tagCatalog: new DatabaseTagCatalogService(database)
  });
  openApps.push(app);
  return { app, database };
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

async function provision(
  app: FastifyInstance,
  cookie: string,
  input: Record<string, unknown> = {}
): Promise<CreatedServiceAccountToken> {
  const response = await app.inject({
    method: "POST",
    url: `/api/v1/admin/service-accounts/${databaseDemoUserIds.robot}/tokens`,
    headers: { cookie, origin: localOrigin },
    payload: {
      name: "Fermata 审核服务",
      permissions: ["auth.login", "problem.view.all", "problem.review"],
      sourceCidrs: [],
      expiresAt: null,
      ...input
    }
  });
  expect(response.statusCode).toBe(200);
  return response.json() as CreatedServiceAccountToken;
}

async function createPendingProblem(app: FastifyInstance): Promise<{ id: string }> {
  const author = await login(app, databaseDemoUserIds.author);
  const created = await app.inject({
    method: "POST",
    url: "/api/v1/problems",
    headers: { cookie: author, origin: localOrigin },
    payload: {
      title: "机器人令牌流程合成题",
      type: "traditional",
      tagIds: ["catalog.tag.02.09"],
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

async function claim(app: FastifyInstance, token: string) {
  return app.inject({
    method: "POST",
    url: "/api/v1/robot/review-tasks/claim",
    headers: { authorization: `Bearer ${token}`, origin: localOrigin },
    payload: { maximumTasks: 1, leaseSeconds: 300 }
  });
}

afterEach(async () => {
  await Promise.all(openApps.splice(0).map((app) => app.close()));
  await Promise.all(openDatabases.splice(0).map((database) => database.close()));
});

describe("机器人令牌管理接口", () => {
  it("管理员签发的令牌可以领取任务，列表和审计不回显密钥", async () => {
    const { app, database } = await createServiceAccountApp();
    const admin = await login(app, databaseDemoUserIds.administrator);
    const created = await provision(app, admin);
    const pending = await createPendingProblem(app);

    const claimResponse = await claim(app, created.token);
    expect(claimResponse.statusCode).toBe(200);
    expect(claimResponse.json()).toEqual(expect.objectContaining({
      items: [expect.objectContaining({
        problem: expect.objectContaining({ id: pending.id })
      })]
    }));

    const listed = await app.inject({
      method: "GET",
      url: `/api/v1/admin/service-accounts/${databaseDemoUserIds.robot}/tokens`,
      headers: { cookie: admin, origin: localOrigin }
    });
    expect(listed.statusCode).toBe(200);
    expect(listed.body).not.toContain(created.token);

    const stored = await database.query<{ token_digest: string }>(sql`
      SELECT token_digest FROM api_tokens WHERE id = ${created.item.id}::uuid
    `);
    expect(stored).toHaveLength(1);
    expect(stored[0]?.token_digest).not.toBe(created.token);
    const audits = await database.query<{ action: string; metadata: unknown }>(sql`
      SELECT action, metadata FROM audit_events
      WHERE action LIKE 'service_account.token.%'
      ORDER BY id
    `);
    expect(JSON.stringify(audits)).not.toContain(created.token);
  });

  it("轮换在同一事务中撤销旧令牌，撤销后令牌不能领取", async () => {
    const { app, database } = await createServiceAccountApp();
    const admin = await login(app, databaseDemoUserIds.administrator);
    const created = await provision(app, admin);

    const rotatedResponse = await app.inject({
      method: "POST",
      url: `/api/v1/admin/service-accounts/${databaseDemoUserIds.robot}/tokens/${created.item.id}/rotate`,
      headers: { cookie: admin, origin: localOrigin },
      payload: {
        name: "Fermata 审核服务轮换",
        permissions: ["auth.login", "problem.review", "problem.view.all"],
        sourceCidrs: [],
        expiresAt: null
      }
    });
    expect(rotatedResponse.statusCode).toBe(200);
    const rotated = rotatedResponse.json() as CreatedServiceAccountToken;
    expect(rotated.token).not.toBe(created.token);
    expect(rotatedResponse.body).not.toContain(created.token);

    const oldClaim = await claim(app, created.token);
    expect(oldClaim.statusCode).toBe(401);
    const newClaim = await claim(app, rotated.token);
    expect(newClaim.statusCode).toBe(200);

    const oldState = await database.query<{ revoked_at: Date | string | null }>(sql`
      SELECT revoked_at FROM api_tokens WHERE id = ${created.item.id}::uuid
    `);
    expect(oldState[0]?.revoked_at).not.toBeNull();

    const revokeResponse = await app.inject({
      method: "DELETE",
      url: `/api/v1/admin/service-accounts/${databaseDemoUserIds.robot}/tokens/${rotated.item.id}`,
      headers: { cookie: admin, origin: localOrigin }
    });
    expect(revokeResponse.statusCode).toBe(200);
    expect(revokeResponse.json()).toEqual({
      item: expect.objectContaining({ id: rotated.item.id, revokedAt: expect.any(String) })
    });
    expect((await claim(app, rotated.token)).statusCode).toBe(401);
    expect(JSON.stringify(await database.query(sql`
      SELECT action, metadata FROM audit_events
      WHERE action LIKE 'service_account.token.%'
      ORDER BY id
    `))).not.toContain(rotated.token);
  });

  it("非管理员、机器人和明确拒绝账号不能管理令牌", async () => {
    const { app, database } = await createServiceAccountApp();
    const request = {
      method: "POST" as const,
      url: `/api/v1/admin/service-accounts/${databaseDemoUserIds.robot}/tokens`,
      headers: { origin: localOrigin },
      payload: {
        name: "不应创建",
        permissions: ["auth.login", "problem.review"],
        sourceCidrs: [],
        expiresAt: null
      }
    };

    const author = await login(app, databaseDemoUserIds.author);
    expect((await app.inject({ ...request, headers: { cookie: author, origin: localOrigin } })).statusCode)
      .toBe(404);
    const robot = await login(app, databaseDemoUserIds.robot);
    expect((await app.inject({ ...request, headers: { cookie: robot, origin: localOrigin } })).statusCode)
      .toBe(404);

    await database.execute(sql`
      INSERT INTO permission_grants (
        id, subject_user_id, permission_name, effect, scope, granted_by_user_id, reason
      ) VALUES (
        ${randomUUID()}::uuid, ${BigInt(databaseDemoUserIds.administrator)},
        'service_account.manage', 'deny', 'global', 0, '测试明确拒绝'
      )
    `);
    const deniedAdmin = await login(app, databaseDemoUserIds.administrator);
    expect((await app.inject({
      ...request,
      headers: { cookie: deniedAdmin, origin: localOrigin }
    })).statusCode).toBe(404);

    const rows = await database.query<{ count: number }>(sql`
      SELECT count(*)::integer AS count FROM api_tokens
      WHERE user_id = ${BigInt(databaseDemoUserIds.robot)}
    `);
    expect(rows).toEqual([{ count: 0 }]);
  });

  it("输入错误、过期令牌和撤销令牌均失败且不留下部分创建", async () => {
    const { app, database } = await createServiceAccountApp();
    const admin = await login(app, databaseDemoUserIds.administrator);
    const url = `/api/v1/admin/service-accounts/${databaseDemoUserIds.robot}/tokens`;

    for (const payload of [
      {},
      {
        name: "过期令牌",
        permissions: ["auth.login", "problem.review"],
        sourceCidrs: [],
        expiresAt: "2000-01-01T00:00:00.000Z"
      },
      {
        name: "禁止令牌",
        permissions: ["auth.login", "service_account.manage"],
        sourceCidrs: [],
        expiresAt: null
      }
    ]) {
      const response = await app.inject({
        method: "POST",
        url,
        headers: { cookie: admin, origin: localOrigin },
        payload
      });
      expect(response.statusCode).toBe(422);
      expect(response.body).not.toContain("service_account.manage");
    }

    const created = await provision(app, admin, {
      name: "之后过期",
      expiresAt: "2099-08-01T00:00:00.000Z"
    });
    await database.execute(sql`
      UPDATE api_tokens
      SET created_at = '1999-01-01T00:00:00.000Z'::timestamptz,
          expires_at = '2000-01-01T00:00:00.000Z'::timestamptz
      WHERE id = ${created.item.id}::uuid
    `);
    expect((await claim(app, created.token)).statusCode).toBe(401);

    const rows = await database.query<{ count: number }>(sql`
      SELECT count(*)::integer AS count FROM api_tokens
      WHERE user_id = ${BigInt(databaseDemoUserIds.robot)}
    `);
    expect(rows).toEqual([{ count: 1 }]);
  });

  it("缺少、错误和撤销后的机器人令牌统一返回 401", async () => {
    const { app } = await createServiceAccountApp();
    expect((await app.inject({
      method: "POST",
      url: "/api/v1/robot/review-tasks/claim",
      headers: { origin: localOrigin },
      payload: {}
    })).statusCode).toBe(401);
    expect((await claim(app, "urv_wrong_token_0123456789abcdef")).statusCode).toBe(401);
  });
});
