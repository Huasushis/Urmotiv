import { randomUUID } from "node:crypto";
import { createPostgresDatabase, migrateDatabase, seedCoreDatabase, type PostgresDatabaseHandle } from "@urmotiv/database";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DatabaseDataStore } from "../src/database-store";

const adminUrl = process.env.URMOTIV_TEST_POSTGRES_ADMIN_URL ?? process.env.DATABASE_URL;
const describePostgres = adminUrl === undefined ? describe.skip : describe;

function databaseConnectionString(connectionString: string, databaseName: string): string {
  const queryIndex = connectionString.indexOf("?");
  const endpoint = queryIndex === -1 ? connectionString : connectionString.slice(0, queryIndex);
  const query = queryIndex === -1 ? "" : connectionString.slice(queryIndex);
  const separator = endpoint.lastIndexOf("/");
  if (separator < "postgresql://".length) throw new Error("测试数据库连接地址无效。");
  return `${endpoint.slice(0, separator + 1)}${databaseName}${query}`;
}

describePostgres("权限增量 PostgreSQL 原子竞态", () => {
  let databaseName = "";
  let admin: PostgresDatabaseHandle | undefined;
  let primary: PostgresDatabaseHandle | undefined;
  let observer: PostgresDatabaseHandle | undefined;

  beforeAll(async () => {
    if (adminUrl === undefined) return;
    databaseName = `urmotiv_permission_atomic_${process.pid}_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
    admin = createPostgresDatabase({ connectionString: adminUrl, maxConnections: 1, applicationName: "urmotiv-permission-admin" });
    await admin.execute(sql`CREATE DATABASE ${sql.identifier(databaseName)}`);
    await admin.close();
    admin = undefined;
    const connectionString = databaseConnectionString(adminUrl, databaseName);
    primary = createPostgresDatabase({ connectionString, maxConnections: 2, statementTimeoutMs: 10_000, applicationName: "urmotiv-permission-primary" });
    observer = createPostgresDatabase({ connectionString, maxConnections: 2, statementTimeoutMs: 10_000, applicationName: "urmotiv-permission-observer" });
    await migrateDatabase(primary);
    await seedCoreDatabase(primary);
    const actorGrants = ["auth.login", "user.permission.manage"].map(() => randomUUID());
    await primary.execute(sql`
      INSERT INTO users (id, nickname, account_type)
      VALUES (1001, '权限竞态操作者', 'human'), (1002, '权限竞态目标', 'human')
      ON CONFLICT (id) DO UPDATE SET disabled_at = NULL
    `);
    await primary.execute(sql`
      INSERT INTO permission_grants (id, subject_user_id, permission_name, effect, scope, granted_by_user_id, reason)
      VALUES
        (${actorGrants[0]}::uuid, 1001, 'auth.login', 'allow', 'global', 0, '权限竞态测试'),
        (${actorGrants[1]}::uuid, 1001, 'user.permission.manage', 'allow', 'global', 0, '权限竞态测试')
      ON CONFLICT (id) DO UPDATE SET revoked_at = NULL
    `);
  }, 30_000);

  afterAll(async () => {
    await primary?.close();
    await observer?.close();
    if (adminUrl === undefined) return;
    admin = createPostgresDatabase({ connectionString: adminUrl, maxConnections: 1, applicationName: "urmotiv-permission-admin-cleanup" });
    try {
      if (databaseName.length > 0) await admin.execute(sql`DROP DATABASE IF EXISTS ${sql.identifier(databaseName)}`);
    } finally {
      await admin.close();
      admin = undefined;
    }
  });

  it("rolls back the permission delta when audit insertion fails", async () => {
    if (primary === undefined) return;
    const store = new DatabaseDataStore(primary);
    const before = await store.getUserPermissionDelta("1002");
    const requestId = randomUUID();
    await expect(store.replaceUserPermissionDeltaAtomic({
      actorUserId: "1001",
      authorizationUserId: "1001",
      userId: "1002",
      expectedRevision: before.revision,
      allows: ["problem.review"],
      denies: [],
      requestId,
      authorizeActor: (actor) => {
        expect(actor.grants.some((grant) => grant.permission === "user.permission.manage" && grant.effect === "allow")).toBe(true);
      },
      writeAudit: async (executor) => {
        if (executor === undefined) throw new Error("missing database transaction");
        await executor.execute(sql`
          INSERT INTO audit_events (
            actor_user_id, subject_user_id, request_id, action, object_type, object_id, result, metadata
          ) VALUES (
            1001, 1002, ${requestId}::uuid, 'p1.synthetic.audit', 'user', '1002', 'success', '{}'::jsonb
          )
        `);
        throw new Error("synthetic audit failure");
      }
    })).rejects.toThrow("synthetic audit failure");
    await expect(store.getUserPermissionDelta("1002")).resolves.toEqual(before);
    const active = await primary.query<{ count: number }>(sql`
      SELECT count(*)::integer AS count FROM permission_grants
      WHERE subject_user_id = 1002 AND revoked_at IS NULL
    `);
    expect(Number(active[0]?.count ?? 0)).toBe(0);
    const audits = await primary.query<{ count: number }>(sql`
      SELECT count(*)::integer AS count FROM audit_events
      WHERE request_id = ${requestId}::uuid
    `);
    expect(Number(audits[0]?.count ?? 0)).toBe(0);
  });

  it("rejects a request after a second connection revokes actor management", async () => {
    if (primary === undefined || observer === undefined) return;
    const store = new DatabaseDataStore(primary);
    const before = await store.getUserPermissionDelta("1002");
    await store.getUser("1001");
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    let ready!: () => void;
    const started = new Promise<void>((resolve) => { ready = resolve; });
    const revocation = observer.transaction(async (transaction) => {
      await transaction.query<{ id: string }>(sql`SELECT id::text AS id FROM users WHERE id = 1001 FOR UPDATE`);
      await transaction.execute(sql`
        UPDATE permission_grants SET revoked_at = clock_timestamp(), revoked_by_user_id = 0
        WHERE subject_user_id = 1001 AND permission_name = 'user.permission.manage' AND revoked_at IS NULL
      `);
      ready();
      await held;
    });
    await started;
    const mutation = store.replaceUserPermissionDeltaAtomic({
      actorUserId: "1001",
      authorizationUserId: "1001",
      userId: "1002",
      expectedRevision: before.revision,
      allows: ["problem.review"],
      denies: [],
      requestId: randomUUID(),
      authorizeActor: (actor) => {
        if (!actor.grants.some((grant) => grant.permission === "user.permission.manage" && grant.effect === "allow")) {
          throw new Error("ACTOR_REVOKED");
        }
      },
      writeAudit: async () => undefined
    });
    await new Promise<void>((resolve) => setTimeout(resolve, 25));
    release();
    await expect(mutation).rejects.toThrow("ACTOR_REVOKED");
    await revocation;
    await expect(store.getUserPermissionDelta("1002")).resolves.toEqual(before);
  });
});
