import { randomUUID } from "node:crypto";
import {
  createPostgresDatabase,
  migrateDatabase,
  seedCoreDatabase,
  type PostgresDatabaseHandle
} from "@urmotiv/database";
import { sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app";
import { databaseDemoUserIds, seedDatabaseDemoData } from "../src/database-demo";
import { DatabaseDataStore } from "../src/database-store";

const origin = "http://localhost:5173";
const configuredAdminUrl = process.env.URMOTIV_TEST_POSTGRES_ADMIN_URL?.trim();
const describePostgres = configuredAdminUrl === undefined || configuredAdminUrl.length === 0
  ? describe.skip
  : describe;

function databaseConnectionString(connectionString: string, databaseName: string): string {
  const queryIndex = connectionString.indexOf("?");
  const endpoint = queryIndex === -1 ? connectionString : connectionString.slice(0, queryIndex);
  const query = queryIndex === -1 ? "" : connectionString.slice(queryIndex);
  const separator = endpoint.lastIndexOf("/");
  if (separator < "postgresql://".length) throw new Error("测试数据库连接地址无效。");
  return `${endpoint.slice(0, separator + 1)}${databaseName}${query}`;
}

type BatchAuditRow = {
  actor_user_id: string;
  effective_user_id: string | null;
  metadata_text: string;
};

const openApps = new Set<FastifyInstance>();
let databaseName = "";
let admin: PostgresDatabaseHandle | undefined;
let primary: PostgresDatabaseHandle | undefined;

function requireDatabase(): PostgresDatabaseHandle {
  if (primary === undefined) throw new Error("测试数据库未初始化。");
  return primary;
}

async function makeApp(): Promise<FastifyInstance> {
  const app = await createApp({
    store: new DatabaseDataStore(requireDatabase()),
    demoAuthEnabled: true,
    demoUserIds: ["0", ...Object.values(databaseDemoUserIds)],
    demoLoginUserIds: {
      root: "0",
      administrator: databaseDemoUserIds.administrator
    },
    allowedOrigins: [origin],
    secureCookies: false
  });
  openApps.add(app);
  return app;
}

function sessionCookie(response: { headers: Record<string, unknown> }): string {
  const setCookie = response.headers["set-cookie"];
  const firstCookie = Array.isArray(setCookie) ? setCookie[0] : setCookie;
  if (typeof firstCookie !== "string") throw new Error("登录未返回会话 Cookie。");
  return firstCookie.split(";", 1)[0]!;
}

async function login(app: FastifyInstance, userId: string): Promise<string> {
  const response = await app.inject({
    method: "POST",
    url: "/api/v1/auth/demo-login",
    headers: { origin },
    payload: { userId }
  });
  expect(response.statusCode).toBe(200);
  return sessionCookie(response);
}

async function switchToAdministrator(app: FastifyInstance, rootCookie: string): Promise<string> {
  const response = await app.inject({
    method: "POST",
    url: "/api/v1/auth/switch-account",
    headers: { cookie: rootCookie, origin },
    payload: { targetUserId: databaseDemoUserIds.administrator }
  });
  expect(response.statusCode).toBe(200);
  return sessionCookie(response);
}

async function createBatch(
  app: FastifyInstance,
  cookie: string,
  username: string,
  email: string,
  password: string
): Promise<void> {
  const response = await app.inject({
    method: "POST",
    url: "/api/v1/admin/accounts/batch",
    headers: { cookie, origin },
    payload: {
      text: `${username}\t数据库审计合成账号\t${email}\t${password}`
    }
  });
  expect(response.statusCode).toBe(200);
  expect(response.json()).toEqual({ ok: true, createdCount: 1, totalCount: 1 });
  expect(response.body).not.toContain(password);
}

async function latestBatchAudit(): Promise<BatchAuditRow> {
  const rows = await requireDatabase().query<BatchAuditRow>(sql`
    SELECT
      actor_user_id::text AS actor_user_id,
      metadata->>'effectiveUserId' AS effective_user_id,
      metadata::text AS metadata_text
    FROM audit_events
    WHERE action = 'user.batch_create'
    ORDER BY id DESC
    LIMIT 1
  `);
  const row = rows[0];
  if (row === undefined) throw new Error("未找到批量创建审计记录。");
  return row;
}

afterEach(async () => {
  await Promise.all([...openApps].map((app) => app.close()));
  openApps.clear();
});

beforeAll(async () => {
  if (configuredAdminUrl === undefined || configuredAdminUrl.length === 0) return;
  databaseName = `urmotiv_identity_audit_${process.pid}_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
  admin = createPostgresDatabase({
    connectionString: configuredAdminUrl,
    maxConnections: 1,
    applicationName: "urmotiv-identity-audit-admin"
  });
  await admin.execute(sql`CREATE DATABASE ${sql.identifier(databaseName)}`);
  await admin.close();
  admin = undefined;

  primary = createPostgresDatabase({
    connectionString: databaseConnectionString(configuredAdminUrl, databaseName),
    maxConnections: 2,
    statementTimeoutMs: 10_000,
    applicationName: "urmotiv-identity-audit-primary"
  });
  await migrateDatabase(primary);
  await seedCoreDatabase(primary);
  await seedDatabaseDemoData(primary);
}, 30_000);

afterAll(async () => {
  for (const app of openApps) await app.close();
  openApps.clear();
  if (primary !== undefined) {
    await primary.close();
    primary = undefined;
  }
  if (admin !== undefined) {
    await admin.close();
    admin = undefined;
  }
  if (configuredAdminUrl === undefined || configuredAdminUrl.length === 0 || databaseName.length === 0) return;

  const cleanup = createPostgresDatabase({
    connectionString: configuredAdminUrl,
    maxConnections: 1,
    applicationName: "urmotiv-identity-audit-cleanup"
  });
  try {
    await cleanup.execute(sql`DROP DATABASE IF EXISTS ${sql.identifier(databaseName)}`);
  } finally {
    await cleanup.close();
  }
}, 30_000);

describePostgres("High-2 DatabaseDataStore batch audit attribution", () => {
  it("records real root actor and safe effective context for simulated impersonated login", async () => {
    const app = await makeApp();
    const rootCookie = await login(app, "root");
    const effectiveCookie = await switchToAdministrator(app, rootCookie);
    const password = "SyntheticDbBatchPassword-A";
    await createBatch(
      app,
      effectiveCookie,
      "PB-HIGH2-DB-IMP",
      "high2-db-impersonated@example.test",
      password
    );

    const audit = await latestBatchAudit();
    expect(audit.actor_user_id).toBe("0");
    expect(audit.effective_user_id).toBe(databaseDemoUserIds.administrator);
    expect(audit.metadata_text).not.toContain(password);
  });

  it("leaves effective context absent for an ordinary administrator login", async () => {
    const app = await makeApp();
    const cookie = await login(app, "administrator");
    const password = "SyntheticDbBatchPassword-B";
    await createBatch(
      app,
      cookie,
      "PB-HIGH2-DB-ORD",
      "high2-db-ordinary@example.test",
      password
    );

    const audit = await latestBatchAudit();
    expect(audit.actor_user_id).toBe(databaseDemoUserIds.administrator);
    expect(audit.effective_user_id).toBeNull();
    expect(audit.metadata_text).not.toContain(password);
  });
});
