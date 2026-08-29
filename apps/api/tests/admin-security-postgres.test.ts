import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import {
  createPostgresDatabase,
  migrateDatabase,
  seedCoreDatabase,
  type PostgresDatabaseHandle
} from "@urmotiv/database";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  AdminService,
  DatabaseAdminSettingsStore
} from "../src/admin-service";
import { DatabaseRoleManagementStore } from "../src/admin-role-service";
import { InMemoryDataStore } from "../src/repository";

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

function roleContext(
  requestId: string,
  actorAllowCeiling: readonly string[] = ["auth.login", "user.permission.manage", "system.manage"]
) {
  return {
    actorUserId: "0",
    requestId,
    actorAllowCeiling,
    actorDeniedPermissions: []
  };
}

async function applyOAuthRepairMigration(database: PostgresDatabaseHandle): Promise<void> {
  const migration = await readFile(
    new URL("../../../packages/database/migrations/0022_repair_oauth_override.sql", import.meta.url),
    "utf8"
  );
  for (const statement of migration.split("--> statement-breakpoint")) {
    if (statement.trim().length > 0) {
      await database.execute(sql.raw(statement));
    }
  }
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

  it("0022 修复显式禁用覆盖并保留无覆盖环境回退", async () => {
    if (primary === undefined) return;
    await primary.execute(sql`
      DELETE FROM system_oauth_settings WHERE id = 'global'
    `);
    await primary.execute(sql`
      UPDATE system_settings
      SET enabled = false,
          authorize_url = '',
          token_url = '',
          profile_url = '',
          redirect_uri = '/api/v1/auth/ustc/callback',
          scope = '',
          client_id_encrypted = NULL,
          client_secret_encrypted = NULL,
          revision = 1,
          updated_by_user_id = NULL
      WHERE id = 'global'
    `);
    await applyOAuthRepairMigration(primary);

    const fallbackStore = new DatabaseAdminSettingsStore(primary);
    const fallbackService = new AdminService({
      store: new InMemoryDataStore([], []),
      settingsStore: fallbackStore,
      secureCookies: true,
      allowLoopbackInsecureCookies: false,
      emailLoginEnabled: false,
      emailRegistrationEnabled: false,
      allowedOrigins: []
    });
    await expect(fallbackStore.getUstcOAuthSettings()).resolves.toMatchObject({
      enabled: false,
      overrideConfigured: false
    });
    await expect(fallbackService.isUstcOAuthEnabled(true)).resolves.toBe(true);
    await expect(fallbackService.isUstcOAuthEnabled(false)).resolves.toBe(false);

    await primary.execute(sql`
      UPDATE system_settings SET revision = 2 WHERE id = 'global'
    `);
    await expect(applyOAuthRepairMigration(primary)).rejects.toThrow(
      "OAUTH_OVERRIDE_REPAIR_IMPOSSIBLE: default legacy OAuth state lacks authoritative audit evidence"
    );
    await primary.execute(sql`
      UPDATE system_settings SET revision = 1 WHERE id = 'global'
    `);
    await primary.execute(sql`
      INSERT INTO audit_events (
        actor_user_id, request_id, action, object_type, object_id, result, metadata
      ) VALUES (
        0, ${randomUUID()}::uuid, 'auth.ustc_oauth.settings.update',
        'system_settings', 'global', 'success', '{}'::jsonb
      )
    `);
    await primary.execute(sql`
      UPDATE system_settings
      SET revision = 2, updated_by_user_id = 0, updated_at = now()
      WHERE id = 'global'
    `);
    await applyOAuthRepairMigration(primary);

    await expect(fallbackStore.getUstcOAuthSettings()).resolves.toMatchObject({
      enabled: false,
      authorizeUrl: '',
      tokenUrl: '',
      profileUrl: '',
      redirectUri: '/api/v1/auth/ustc/callback',
      scope: '',
      clientIdEncrypted: null,
      clientSecretEncrypted: null,
      revision: 2,
      overrideConfigured: true
    });
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

  it("提交的权限撤销阻止带旧 ceiling 的角色突变", async () => {
    if (primary === undefined || observer === undefined) return;
    const actorId = "900001";
    const grantIds = [randomUUID(), randomUUID(), randomUUID()];
    await primary.execute(sql`
      INSERT INTO users (id, nickname, account_type)
      VALUES (${actorId}::bigint, '撤销竞态用户', 'human')
      ON CONFLICT (id) DO NOTHING
    `);
    await primary.execute(sql`
      INSERT INTO permission_grants (
        id, subject_user_id, permission_name, effect, scope, granted_by_user_id, reason
      ) VALUES
        (${grantIds[0]}::uuid, ${actorId}::bigint, 'auth.login', 'allow', 'global', 0, '安全竞态测试'),
        (${grantIds[1]}::uuid, ${actorId}::bigint, 'user.permission.manage', 'allow', 'global', 0, '安全竞态测试'),
        (${grantIds[2]}::uuid, ${actorId}::bigint, 'problem.view.all', 'allow', 'global', 0, '安全竞态测试')
    `);

    let releaseRevocation!: () => void;
    const revocationRelease = new Promise<void>((resolve) => {
      releaseRevocation = resolve;
    });
    let revocationReady!: () => void;
    const revocationStarted = new Promise<void>((resolve) => {
      revocationReady = resolve;
    });
    const revocation = observer.transaction(async (transaction) => {
      await transaction.query<{ id: string }>(sql`
        SELECT id::text AS id FROM users WHERE id = ${actorId}::bigint FOR UPDATE
      `);
      await transaction.execute(sql`
        UPDATE permission_grants
        SET revoked_at = now(), revoked_by_user_id = 0
        WHERE id = ${grantIds[2]}::uuid AND revoked_at IS NULL
      `);
      revocationReady();
      await revocationRelease;
    });
    await revocationStarted;

    const store = new DatabaseRoleManagementStore(primary);
    const mutation = store.createRole(
      {
        key: `revocation_race_${process.pid}`,
        displayName: "撤销竞态角色",
        description: "",
        permissions: [{ name: "problem.view.all", effect: "allow" }],
        userIds: []
      },
      {
        ...roleContext("00000000-0000-4000-8000-000000000020", [
          "auth.login",
          "user.permission.manage",
          "problem.view.all"
        ]),
        actorUserId: actorId
      }
    );

    let mutationBlocked = false;
    try {
      for (let attempt = 0; attempt < 120; attempt += 1) {
        const rows = await observer.query<{ count: number }>(sql`
          SELECT count(*)::integer AS count
          FROM pg_stat_activity
          WHERE application_name = 'urmotiv-role-security-primary'
            AND wait_event_type = 'Lock'
        `);
        if (Number(rows[0]?.count ?? 0) > 0) {
          mutationBlocked = true;
          break;
        }
        await new Promise<void>((resolve) => setTimeout(resolve, 10));
      }
      expect(mutationBlocked).toBe(true);
      releaseRevocation();
      await expect(mutation).rejects.toMatchObject({
        code: "ROLE_PERMISSION_CEILING"
      });
    } finally {
      releaseRevocation();
      await revocation;
    }

    const roles = await primary.query<{ count: number }>(sql`
      SELECT count(*)::integer AS count
      FROM roles WHERE key = ${`revocation_race_${process.pid}`}
    `);
    expect(Number(roles[0]?.count ?? 0)).toBe(0);
    const grants = await primary.query<{ revoked: boolean }>(sql`
      SELECT revoked_at IS NOT NULL AS revoked
      FROM permission_grants WHERE id = ${grantIds[2]}::uuid
    `);
    expect(grants[0]?.revoked).toBe(true);
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
