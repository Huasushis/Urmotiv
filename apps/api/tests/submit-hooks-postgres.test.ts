import { randomUUID } from "node:crypto";
import {
  createPostgresDatabase,
  migrateDatabase,
  seedCoreDatabase,
  type PostgresDatabaseHandle
} from "@urmotiv/database";
import type { AnklangFetch } from "@urmotiv/plugin-anklang";
import { sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app";
import {
  anklangPluginId,
  createBuiltinPluginDefinitions,
  type AnklangHookRuntime
} from "../src/builtin-plugins";
import { DatabaseContestStore } from "../src/database-contest-store";
import { databaseDemoUserIds, seedDatabaseDemoData } from "../src/database-demo";
import { DatabaseDataStore } from "../src/database-store";
import { DatabasePluginStore } from "../src/database-plugin-store";
import { TrustedPluginHost } from "../src/plugin-host";
import { DatabaseReviewItemStore } from "../src/review-item-store";

const adminUrl = process.env.URMOTIV_TEST_POSTGRES_ADMIN_URL;
const describePostgres = adminUrl === undefined ? describe.skip : describe;
const origin = "http://localhost:5173";
const applicationName = "urmotiv-anklang-auth-race-test";

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve = (): void => undefined;
  const promise = new Promise<void>((innerResolve) => {
    resolve = innerResolve;
  });
  return { promise, resolve };
}

function databaseConnectionString(connectionString: string, databaseName: string): string {
  const queryIndex = connectionString.indexOf("?");
  const endpoint = queryIndex === -1 ? connectionString : connectionString.slice(0, queryIndex);
  const query = queryIndex === -1 ? "" : connectionString.slice(queryIndex);
  const separator = endpoint.lastIndexOf("/");
  if (separator < "postgresql://".length) {
    throw new Error("测试数据库连接地址无效。");
  }
  return `${endpoint.slice(0, separator + 1)}${databaseName}${query}`;
}

async function waitForBlockedLock(database: PostgresDatabaseHandle): Promise<boolean> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const rows = await database.query<{ waiting: number }>(sql`
      SELECT count(*)::integer AS waiting
      FROM pg_stat_activity
      WHERE datname = current_database()
        AND application_name = ${applicationName}
        AND wait_event_type = 'Lock'
    `);
    if ((rows[0]?.waiting ?? 0) > 0) {
      return true;
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
  return false;
}

async function login(app: FastifyInstance): Promise<string> {
  const response = await app.inject({
    method: "POST",
    url: "/api/v1/auth/demo-login",
    headers: { origin },
    payload: { userId: databaseDemoUserIds.author }
  });
  expect(response.statusCode).toBe(200);
  const setCookie = response.headers["set-cookie"];
  const firstCookie = Array.isArray(setCookie) ? setCookie[0] : setCookie;
  return (firstCookie as string).split(";", 1)[0] as string;
}

async function createPendingProblem(app: FastifyInstance, cookie: string): Promise<string> {
  const created = await app.inject({
    method: "POST",
    url: "/api/v1/problems",
    headers: { cookie, origin },
    payload: {
      title: "并发撤权查重测试题",
      type: "traditional",
      tagIds: ["catalog.tag.02.09"],
      content: {
        basicStatement: "给定一个整数，输出这个整数。",
        basicSolution: "直接输出输入值。",
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
  const problem = created.json() as { id: string; revision: number };
  const submitted = await app.inject({
    method: "POST",
    url: `/api/v1/problems/${problem.id}/submit`,
    headers: { cookie, origin },
    payload: { expectedRevision: problem.revision }
  });
  expect(submitted.statusCode).toBe(200);
  expect((submitted.json() as { status: string }).status).toBe("pending_review");
  return problem.id;
}

describePostgres("手动原题检索的真实 PostgreSQL 撤权竞态", () => {
  let databaseName = "";
  let database: PostgresDatabaseHandle | undefined;
  let app: FastifyInstance | undefined;

  beforeAll(async () => {
    if (adminUrl === undefined) return;
    databaseName = `urmotiv_anklang_auth_${process.pid}_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
    if (!/^urmotiv_anklang_auth_[a-z0-9_]+$/.test(databaseName)) {
      throw new Error("测试数据库名称无效。");
    }
    const admin = createPostgresDatabase({
      connectionString: adminUrl,
      maxConnections: 2,
      statementTimeoutMs: 10_000,
      applicationName: `${applicationName}-admin`
    });
    try {
      await admin.execute(sql`CREATE DATABASE ${sql.identifier(databaseName)}`);
    } finally {
      await admin.close();
    }
    database = createPostgresDatabase({
      connectionString: databaseConnectionString(adminUrl, databaseName),
      maxConnections: 8,
      statementTimeoutMs: 10_000,
      applicationName
    });
    await migrateDatabase(database);
    await seedCoreDatabase(database);
    await seedDatabaseDemoData(database);
  });

  afterAll(async () => {
    await app?.close();
    await database?.close();
    if (adminUrl === undefined || databaseName.length === 0) return;
    const admin = createPostgresDatabase({
      connectionString: adminUrl,
      maxConnections: 2,
      statementTimeoutMs: 10_000,
      applicationName: `${applicationName}-cleanup`
    });
    try {
      await admin.execute(sql`DROP DATABASE ${sql.identifier(databaseName)}`);
    } finally {
      await admin.close();
    }
  });

  it("撤权事务先持有授权行时，最终检查等待提交并拒绝旧结果且不写条目", async () => {
    if (database === undefined) throw new Error("未建立真实 PostgreSQL 测试数据库。");
    const requestStarted = deferred();
    const releaseResponse = deferred();
    const allowRevocationCommit = deferred();
    const grantLocked = deferred();
    const fetch: AnklangFetch = async (_input, init) => {
      requestStarted.resolve();
      await releaseResponse.promise;
      const request = JSON.parse(String(init?.body ?? "{}")) as { contentHash: string };
      const checkedAt = new Date();
      return new Response(JSON.stringify({
        apiVersion: "2",
        contentHash: request.contentHash,
        checkedAt: checkedAt.toISOString(),
        completion: { status: "complete", reasonCode: "complete", retryable: false },
        candidates: [{
          source: "public-fixture",
          externalId: "fixture-1",
          title: "公开合成候选题",
          similarity: 0.91,
          sameProblemSuggestion: false
        }],
        recommendation: { blockSubmission: false, message: "请人工核对合成候选。" },
        reuse: {
          policy: "allowed",
          expiresAt: new Date(checkedAt.getTime() + 60_000).toISOString()
        }
      }), { status: 200, headers: { "content-type": "application/json" } });
    };

    let hostReference: TrustedPluginHost | undefined;
    const runtime: AnklangHookRuntime = {
      readSettings: async () => hostReference?.readEnabledPluginSettings(anklangPluginId),
      readToken: async () => undefined,
      cache: {
        get: async () => undefined,
        set: async () => undefined
      },
      fetch
    };
    const host = new TrustedPluginHost(
      createBuiltinPluginDefinitions({ anklang: runtime }),
      new DatabasePluginStore(database)
    );
    hostReference = host;
    app = await createApp({
      demoAuthEnabled: true,
      store: new DatabaseDataStore(database),
      contestStore: new DatabaseContestStore(database),
      demoUserIds: Object.values(databaseDemoUserIds),
      demoLoginUserIds: databaseDemoUserIds,
      pluginHost: host,
      reviewItems: new DatabaseReviewItemStore(database)
    });

    const cookie = await login(app);
    const problemId = await createPendingProblem(app, cookie);
    const enabled = await host.update(
      anklangPluginId,
      {
        expectedRevision: 1,
        clearSecrets: [],
        state: "enabled",
        settings: { baseUrl: "http://anklang.test" }
      },
      "0",
      randomUUID()
    );
    expect(enabled?.state).toBe("enabled");

    const grantRows = await database.query<{ id: string }>(sql`
      SELECT grant_record.id::text AS id
      FROM role_memberships membership
      JOIN permission_grants grant_record
        ON grant_record.subject_role_id = membership.role_id
      WHERE membership.user_id = ${BigInt(databaseDemoUserIds.author)}
        AND membership.revoked_at IS NULL
        AND grant_record.permission_name = 'problem.edit.own'
        AND grant_record.revoked_at IS NULL
      ORDER BY grant_record.id
      LIMIT 1
    `);
    const grantId = grantRows[0]?.id;
    if (grantId === undefined) throw new Error("未找到合成投稿人的编辑授权。");

    const checking = app.inject({
      method: "POST",
      url: `/api/v1/problems/${problemId}/similarity-check`,
      headers: { cookie, origin },
      payload: {}
    });
    let checkingSettled = false;
    void checking.then(() => {
      checkingSettled = true;
    });
    await requestStarted.promise;

    const revocation = database.transaction(async (executor) => {
      const revoked = await executor.query<{ id: string }>(sql`
        UPDATE permission_grants
        SET revoked_at = now(), revoked_by_user_id = 0
        WHERE id = ${grantId}::uuid AND revoked_at IS NULL
        RETURNING id::text AS id
      `);
      expect(revoked).toHaveLength(1);
      grantLocked.resolve();
      await allowRevocationCommit.promise;
    });
    await grantLocked.promise;
    releaseResponse.resolve();

    try {
      await expect(waitForBlockedLock(database)).resolves.toBe(true);
      expect(checkingSettled).toBe(false);
    } finally {
      allowRevocationCommit.resolve();
      await revocation;
    }

    const denied = await checking;
    expect(denied.statusCode).toBe(403);
    expect(denied.body).not.toContain("公开合成候选题");
    expect(denied.body).not.toContain("给定一个整数");
    const saved = await database.query<{ count: number }>(sql`
      SELECT count(*)::integer AS count
      FROM review_items item
      JOIN review_rounds round_record ON round_record.id = item.round_id
      WHERE round_record.problem_id = ${BigInt(problemId)}
    `);
    expect(saved).toEqual([{ count: 0 }]);
  }, 20_000);
});
