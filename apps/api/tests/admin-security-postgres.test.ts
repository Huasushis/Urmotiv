import { randomUUID } from "node:crypto";
import {
  createPostgresDatabase,
  migrateDatabase,
  seedCoreDatabase,
  type PostgresDatabaseHandle
} from "@urmotiv/database";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DatabaseRoleManagementStore } from "../src/admin-role-service";

const adminUrl = process.env.URMOTIV_TEST_POSTGRES_ADMIN_URL ?? process.env.DATABASE_URL;
const describePostgres = adminUrl === undefined ? describe.skip : describe;

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

function roleContext(requestId: string) {
  return {
    actorUserId: "0",
    requestId,
    actorAllowCeiling: ["auth.login", "user.permission.manage", "system.manage"],
    actorDeniedPermissions: []
  };
}

describePostgres("角色成员变更的真实 PostgreSQL 锁顺序", () => {
  let databaseName = "";
  let primary: PostgresDatabaseHandle | undefined;
  let observer: PostgresDatabaseHandle | undefined;

  beforeAll(async () => {
    if (adminUrl === undefined) return;
    databaseName = `urmotiv_role_security_${process.pid}_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
    const admin = createPostgresDatabase({
      connectionString: adminUrl,
      maxConnections: 1,
      applicationName: "urmotiv-role-security-admin"
    });
    try {
      await admin.execute(sql`CREATE DATABASE ${sql.identifier(databaseName)}`);
    } finally {
      await admin.close();
    }
    const connectionString = databaseConnectionString(adminUrl, databaseName);
    primary = createPostgresDatabase({
      connectionString,
      maxConnections: 2,
      statementTimeoutMs: 10_000,
      applicationName: "urmotiv-role-security-primary"
    });
    observer = createPostgresDatabase({
      connectionString,
      maxConnections: 2,
      statementTimeoutMs: 10_000,
      applicationName: "urmotiv-role-security-observer"
    });
    await migrateDatabase(primary);
    await seedCoreDatabase(primary);
    await primary.execute(sql`
      INSERT INTO users (id, nickname, account_type)
      VALUES (1, '锁测试用户一', 'human'), (2, '锁测试用户二', 'human')
      ON CONFLICT (id) DO NOTHING
    `);
    await primary.execute(sql`
      CREATE OR REPLACE FUNCTION test_pause_role_security_update()
      RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        PERFORM pg_sleep(0.8);
        RETURN NEW;
      END;
      $$
    `);
    await primary.execute(sql`
      CREATE TRIGGER test_pause_role_security_update_trigger
      BEFORE UPDATE OF display_name ON roles
      FOR EACH ROW EXECUTE FUNCTION test_pause_role_security_update()
    `);
  });

  afterAll(async () => {
    await observer?.close();
    await primary?.close();
  });

  it("在角色状态锁之前持有 current∪next 用户的行锁", async () => {
    if (primary === undefined || observer === undefined) return;
    const store = new DatabaseRoleManagementStore(primary);
    const created = await store.createRole(
      {
        key: `lock_probe_${process.pid}`,
        displayName: "锁顺序探针",
        description: "",
        permissions: [{ name: "auth.login", effect: "allow" }],
        userIds: []
      },
      roleContext("00000000-0000-4000-8000-000000000010")
    );
    const mutation = store.updateRole(
      created.id,
      {
        expectedRevision: created.revision,
        key: created.key,
        displayName: "锁顺序探针已更新",
        description: created.description,
        permissions: [...created.permissions],
        userIds: ["1", "2"]
      },
      roleContext("00000000-0000-4000-8000-000000000011")
    );
    let userTableLockObserved = false;
    try {
      for (let attempt = 0; attempt < 120; attempt += 1) {
        const rows = await observer.query<{ count: number }>(sql`
          SELECT count(*)::integer AS count
          FROM pg_locks
          WHERE pid IN (
            SELECT pid FROM pg_stat_activity
            WHERE application_name = 'urmotiv-role-security-primary'
          )
            AND relation = 'users'::regclass
            AND mode = 'RowShareLock'
            AND granted
        `);
        if (Number(rows[0]?.count ?? 0) > 0) {
          userTableLockObserved = true;
          break;
        }
        await new Promise<void>((resolve) => setTimeout(resolve, 10));
      }
    } finally {
      await mutation;
    }
    expect(userTableLockObserved).toBe(true);
  });

  it("相反成员顺序的并发角色变更不会死锁", async () => {
    if (primary === undefined) return;
    const store = new DatabaseRoleManagementStore(primary);
    const first = await store.createRole(
      {
        key: `stable_a_${process.pid}`,
        displayName: "稳定顺序 A",
        description: "",
        permissions: [{ name: "auth.login", effect: "allow" }],
        userIds: []
      },
      roleContext("00000000-0000-4000-8000-000000000012")
    );
    const second = await store.createRole(
      {
        key: `stable_b_${process.pid}`,
        displayName: "稳定顺序 B",
        description: "",
        permissions: [{ name: "auth.login", effect: "allow" }],
        userIds: []
      },
      roleContext("00000000-0000-4000-8000-000000000013")
    );
    const updates = await Promise.all([
      store.updateRole(
        first.id,
        {
          expectedRevision: first.revision,
          key: first.key,
          displayName: first.displayName,
          description: first.description,
          permissions: [...first.permissions],
          userIds: ["1", "2"]
        },
        roleContext("00000000-0000-4000-8000-000000000014")
      ),
      store.updateRole(
        second.id,
        {
          expectedRevision: second.revision,
          key: second.key,
          displayName: second.displayName,
          description: second.description,
          permissions: [...second.permissions],
          userIds: ["2", "1"]
        },
        roleContext("00000000-0000-4000-8000-000000000015")
      )
    ]);
    expect(updates).toHaveLength(2);
  });
});
