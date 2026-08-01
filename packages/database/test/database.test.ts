import { sql } from "drizzle-orm";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createLocalDatabase,
  type LocalDatabaseHandle,
  isDatabaseEmptyForAdminBootstrap,
  migrateDatabase,
  openAdminBootstrapForFreshSeed,
  readAdminBootstrapState,
  releaseAdminBootstrapMigrationLease,
  seedCoreDatabase,
  tryAcquireAdminBootstrapMigrationLease
} from "../src";

const openDatabases: LocalDatabaseHandle[] = [];
const temporaryDirectories: string[] = [];

async function createMigratedDatabase(): Promise<LocalDatabaseHandle> {
  const handle = createEmptyDatabase();
  await migrateDatabase(handle);
  return handle;
}

function createEmptyDatabase(): LocalDatabaseHandle {
  const handle = createLocalDatabase();
  openDatabases.push(handle);
  return handle;
}

afterEach(async () => {
  await Promise.all(openDatabases.splice(0).map((handle) => handle.close()));
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("database migration and initial data", () => {
  it("creates missing parent directories for a persistent local database", async () => {
    const temporaryDirectory = mkdtempSync(join(tmpdir(), "urmotiv-database-"));
    temporaryDirectories.push(temporaryDirectory);
    const dataDirectory = join(temporaryDirectory, "missing", "nested", "database");

    const handle = createLocalDatabase({ dataDirectory });
    openDatabases.push(handle);
    await migrateDatabase(handle);

    expect(existsSync(join(temporaryDirectory, "missing", "nested"))).toBe(true);
  });

  it("creates root as user 0 and can run the seed more than once", async () => {
    const handle = await createMigratedDatabase();

    await seedCoreDatabase(handle);
    await seedCoreDatabase(handle);

    const root = await handle.client.query<{
      id: string;
      nickname: string;
      account_type: string;
    }>("SELECT id::text AS id, nickname, account_type FROM users WHERE id = 0");
    expect(root.rows).toEqual([{ id: "0", nickname: "root", account_type: "human" }]);

    const permissions = await handle.client.query<{ count: number }>(
      "SELECT count(*)::integer AS count FROM permission_definitions WHERE source = 'core'"
    );
    expect(permissions.rows[0]?.count).toBeGreaterThan(0);

    const rootMemberships = await handle.client.query<{ count: number }>(`
      SELECT count(*)::integer AS count
      FROM role_memberships membership
      JOIN roles role ON role.id = membership.role_id
      WHERE membership.user_id = 0 AND role.key = 'root' AND membership.revoked_at IS NULL
    `);
    expect(rootMemberships.rows[0]?.count).toBe(1);
  });

  it("never injects a login credential into the seed-only root account", async () => {
    const handle = await createMigratedDatabase();
    await seedCoreDatabase(handle);
    await seedCoreDatabase(handle);

    const root = await handle.client.query<{
      nickname: string;
      password_hash: string | null;
      password_changed_at: string | null;
    }>(`
      SELECT nickname, password_hash, password_changed_at
      FROM users
      WHERE id = 0
    `);
    expect(root.rows).toEqual([{
      nickname: "root",
      password_hash: null,
      password_changed_at: null
    }]);
    const identities = await handle.client.query<{ count: number }>(`
      SELECT (
        (SELECT count(*) FROM user_emails WHERE user_id = 0)
        + (SELECT count(*) FROM external_identities WHERE user_id = 0)
      )::integer AS count
    `);
    expect(identities.rows).toEqual([{ count: 0 }]);
  });

  it("keeps normalized email addresses unique across all users", async () => {
    const handle = await createMigratedDatabase();
    await seedCoreDatabase(handle);
    await handle.execute(sql`INSERT INTO users (id, nickname) VALUES (1, '测试用户')`);
    await handle.execute(sql`
      INSERT INTO user_emails (
        id,
        user_id,
        address,
        normalized_address,
        is_primary,
        verified_at
      )
      VALUES (
        '00000000-0000-4000-8000-000000000001',
        0,
        'Member@Example.test',
        'member@example.test',
        true,
        now()
      )
    `);

    await expect(
      handle.execute(sql`
        INSERT INTO user_emails (
          id,
          user_id,
          address,
          normalized_address,
          is_primary,
          verified_at
        )
        VALUES (
          '00000000-0000-4000-8000-000000000002',
          1,
          'member@example.test',
          'member@example.test',
          true,
          now()
        )
      `)
    ).rejects.toThrow();
  });

  it("stores matching allow and deny records without discarding the deny", async () => {
    const handle = await createMigratedDatabase();
    await seedCoreDatabase(handle);

    await handle.execute(sql`
      INSERT INTO permission_grants (
        id,
        subject_user_id,
        permission_name,
        effect,
        scope,
        granted_by_user_id,
        reason
      ) VALUES
        (
          '10000000-0000-4000-8000-000000000001',
          0,
          'problem.view.all',
          'allow',
          'global',
          0,
          '测试允许记录'
        ),
        (
          '10000000-0000-4000-8000-000000000002',
          0,
          'problem.view.all',
          'deny',
          'global',
          0,
          '测试拒绝记录'
        )
    `);

    const effects = await handle.client.query<{ effect: string }>(`
      SELECT effect
      FROM permission_grants
      WHERE subject_user_id = 0 AND permission_name = 'problem.view.all'
      ORDER BY effect
    `);
    expect(effects.rows).toEqual([{ effect: "allow" }, { effect: "deny" }]);
  });
});

describe("one-time administrator bootstrap eligibility", () => {
  it("creates a blocked singleton and prevents deletion or completed-state regression", async () => {
    const handle = await createMigratedDatabase();

    await expect(readAdminBootstrapState(handle)).resolves.toEqual({
      status: "blocked",
      openedAt: null,
      completedAt: null
    });
    await expect(
      handle.execute(sql`DELETE FROM admin_bootstrap_state WHERE singleton = true`)
    ).rejects.toBeDefined();
    await expect(
      handle.execute(sql`TRUNCATE TABLE admin_bootstrap_state`)
    ).rejects.toBeDefined();

    await handle.execute(sql`
      UPDATE admin_bootstrap_state
      SET status = 'open', opened_at = now(), updated_at = now()
      WHERE singleton = true
    `);
    await handle.execute(sql`
      UPDATE admin_bootstrap_state
      SET status = 'completed', completed_at = now(), updated_at = now()
      WHERE singleton = true
    `);
    await expect(
      handle.execute(sql`
        UPDATE admin_bootstrap_state
        SET status = 'open', completed_at = NULL, updated_at = now()
        WHERE singleton = true
      `)
    ).rejects.toBeDefined();
    expect((await readAdminBootstrapState(handle)).status).toBe("completed");

    const lease = await tryAcquireAdminBootstrapMigrationLease(handle);
    if (lease === undefined) {
      throw new Error("测试未取得迁移锁。");
    }
    await expect(openAdminBootstrapForFreshSeed(handle, lease)).resolves.toBe(
      "state_not_blocked"
    );
    await expect(releaseAdminBootstrapMigrationLease(handle, lease)).resolves.toBe(true);
    expect((await readAdminBootstrapState(handle)).status).toBe("completed");
  });

  it("accepts only a database without non-system objects before migration", async () => {
    const handle = createEmptyDatabase();
    await expect(isDatabaseEmptyForAdminBootstrap(handle)).resolves.toBe(true);

    for (const statement of [
      `CREATE TABLE unrelated_marker (id integer PRIMARY KEY)`,
      `CREATE FUNCTION unrelated_marker() RETURNS integer LANGUAGE sql AS 'SELECT 1'`,
      `CREATE SCHEMA unrelated_marker`
    ]) {
      await handle.client.exec("BEGIN");
      try {
        await handle.client.exec(statement);
        await expect(isDatabaseEmptyForAdminBootstrap(handle)).resolves.toBe(false);
      } finally {
        await handle.client.exec("ROLLBACK");
      }
      await expect(isDatabaseEmptyForAdminBootstrap(handle)).resolves.toBe(true);
    }
  }, 20_000);

  it("opens exactly once for a locked, newly migrated default seed", async () => {
    const handle = createEmptyDatabase();
    const lease = await tryAcquireAdminBootstrapMigrationLease(handle);
    if (lease === undefined) {
      throw new Error("测试未取得迁移锁。");
    }
    expect(await isDatabaseEmptyForAdminBootstrap(handle)).toBe(true);

    await migrateDatabase(handle);
    await seedCoreDatabase(handle);
    await expect(openAdminBootstrapForFreshSeed(handle, lease)).resolves.toBe("opened");

    const state = await readAdminBootstrapState(handle);
    expect(state.status).toBe("open");
    expect(state.openedAt).not.toBeNull();
    expect(state.completedAt).toBeNull();
    await expect(releaseAdminBootstrapMigrationLease(handle, lease)).resolves.toBe(false);

    const secondLease = await tryAcquireAdminBootstrapMigrationLease(handle);
    if (secondLease === undefined) {
      throw new Error("测试未取得第二个迁移锁。");
    }
    await expect(openAdminBootstrapForFreshSeed(handle, secondLease)).resolves.toBe(
      "state_not_blocked"
    );
    await expect(releaseAdminBootstrapMigrationLease(handle, secondLease)).resolves.toBe(true);
    expect((await readAdminBootstrapState(handle)).openedAt).toBe(state.openedAt);
  });

  it("keeps the marker blocked when root, built-in roles, or grants differ", async () => {
    const handle = createEmptyDatabase();
    const lease = await tryAcquireAdminBootstrapMigrationLease(handle);
    if (lease === undefined) {
      throw new Error("测试未取得迁移锁。");
    }
    await migrateDatabase(handle);
    await seedCoreDatabase(handle);
    await handle.execute(sql`
      UPDATE users SET password_hash = '$argon2id$synthetic-test-digest' WHERE id = 0
    `);

    await expect(openAdminBootstrapForFreshSeed(handle, lease)).resolves.toBe(
      "baseline_mismatch"
    );
    await handle.execute(sql`UPDATE users SET password_hash = NULL WHERE id = 0`);

    await handle.execute(sql`
      UPDATE roles SET display_name = 'changed'
      WHERE key = 'root'
    `);
    await expect(openAdminBootstrapForFreshSeed(handle, lease)).resolves.toBe(
      "baseline_mismatch"
    );
    await handle.execute(sql`UPDATE roles SET display_name = 'root' WHERE key = 'root'`);

    await handle.execute(sql`
      UPDATE permission_grants SET effect = 'deny'
      WHERE subject_role_id = (SELECT id FROM roles WHERE key = 'root')
        AND permission_name = 'auth.login'
    `);
    await expect(openAdminBootstrapForFreshSeed(handle, lease)).resolves.toBe(
      "baseline_mismatch"
    );
    await handle.execute(sql`
      UPDATE permission_grants SET effect = 'allow'
      WHERE subject_role_id = (SELECT id FROM roles WHERE key = 'root')
        AND permission_name = 'auth.login'
    `);

    await expect(readAdminBootstrapState(handle)).resolves.toEqual({
      status: "blocked",
      openedAt: null,
      completedAt: null
    });
    await expect(releaseAdminBootstrapMigrationLease(handle, lease)).resolves.toBe(true);
  });

  it("requires identity, session, token, policy, and business tables to match a fresh seed", async () => {
    const handle = createEmptyDatabase();
    const lease = await tryAcquireAdminBootstrapMigrationLease(handle);
    if (lease === undefined) {
      throw new Error("测试未取得迁移锁。");
    }
    await migrateDatabase(handle);
    await seedCoreDatabase(handle);

    await handle.execute(sql`
      INSERT INTO user_emails (
        id, user_id, address, normalized_address, is_primary, verified_at
      ) VALUES (
        '90000000-0000-4000-8000-000000000001',
        0,
        'bootstrap-fixture@example.invalid',
        'bootstrap-fixture@example.invalid',
        true,
        now()
      )
    `);
    await expect(openAdminBootstrapForFreshSeed(handle, lease)).resolves.toBe(
      "baseline_mismatch"
    );
    await handle.execute(sql`DELETE FROM user_emails`);

    await handle.execute(sql`
      INSERT INTO external_identities (id, user_id, provider, subject)
      VALUES ('90000000-0000-4000-8000-000000000002', 0, 'fixture', 'fixture-subject')
    `);
    await expect(openAdminBootstrapForFreshSeed(handle, lease)).resolves.toBe(
      "baseline_mismatch"
    );
    await handle.execute(sql`DELETE FROM external_identities`);

    await handle.execute(sql`
      INSERT INTO sessions (id, token_digest, user_id, auth_revision, expires_at)
      VALUES (
        '90000000-0000-4000-8000-000000000003',
        'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        0,
        1,
        now() + interval '1 hour'
      )
    `);
    await expect(openAdminBootstrapForFreshSeed(handle, lease)).resolves.toBe(
      "baseline_mismatch"
    );
    await handle.execute(sql`DELETE FROM sessions`);

    await handle.execute(sql`
      INSERT INTO api_tokens (
        id, user_id, name, token_prefix, token_digest, created_by_user_id
      ) VALUES (
        '90000000-0000-4000-8000-000000000004',
        0,
        'fixture',
        'fixture',
        'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
        0
      )
    `);
    await expect(openAdminBootstrapForFreshSeed(handle, lease)).resolves.toBe(
      "baseline_mismatch"
    );
    await handle.execute(sql`DELETE FROM api_tokens`);

    await handle.execute(sql`
      INSERT INTO tags (id, name, group_name, created_by_user_id)
      VALUES ('fixture', '合成标签', '合成分组', 0)
    `);
    await expect(openAdminBootstrapForFreshSeed(handle, lease)).resolves.toBe(
      "baseline_mismatch"
    );
    await handle.execute(sql`DELETE FROM tags`);

    await handle.execute(sql`
      UPDATE review_policy SET revision = 2, updated_at = now() WHERE singleton = true
    `);
    await expect(openAdminBootstrapForFreshSeed(handle, lease)).resolves.toBe(
      "baseline_mismatch"
    );
    await handle.execute(sql`
      UPDATE review_policy SET revision = 1, updated_at = now() WHERE singleton = true
    `);

    await handle.execute(sql`INSERT INTO users (nickname) VALUES ('临时用户')`);
    await handle.execute(sql`DELETE FROM users WHERE id <> 0`);
    await expect(openAdminBootstrapForFreshSeed(handle, lease)).resolves.toBe(
      "baseline_mismatch"
    );
    await handle.execute(sql`ALTER SEQUENCE users_id_seq RESTART WITH 1`);

    expect((await readAdminBootstrapState(handle)).status).toBe("blocked");
    await expect(openAdminBootstrapForFreshSeed(handle, lease)).resolves.toBe("opened");
  });

  it("does not open after the migration session loses its lock", async () => {
    const handle = createEmptyDatabase();
    const lease = await tryAcquireAdminBootstrapMigrationLease(handle);
    if (lease === undefined) {
      throw new Error("测试未取得迁移锁。");
    }
    expect(await releaseAdminBootstrapMigrationLease(handle, lease)).toBe(true);
    await migrateDatabase(handle);
    await seedCoreDatabase(handle);

    await expect(openAdminBootstrapForFreshSeed(handle, lease)).resolves.toBe("lock_lost");
    expect((await readAdminBootstrapState(handle)).status).toBe("blocked");
  });
});

describe("problem revisions and audit history", () => {
  it("requires the current revision to exist and uses the expected revision in updates", async () => {
    const handle = await createMigratedDatabase();
    await seedCoreDatabase(handle);

    await handle.transaction(async (transaction) => {
      await transaction.execute(sql`
        INSERT INTO problems (id, owner_id, current_revision)
        VALUES (1, 0, 1)
      `);
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
          '20000000-0000-4000-8000-000000000001',
          1,
          1,
          'draft',
          '公开构造的测试题',
          'traditional',
          '题面',
          '题解',
          '0000000000000000000000000000000000000000000000000000000000000000',
          '创建草稿',
          0
        )
      `);
    });

    const staleUpdate = await handle.client.query<{ id: string }>(`
      UPDATE problems
      SET updated_at = now()
      WHERE id = 1 AND current_revision = 99
      RETURNING id
    `);
    expect(staleUpdate.rows).toHaveLength(0);

    await expect(
      handle.transaction(async (transaction) => {
        await transaction.execute(sql`
          UPDATE problems SET current_revision = 2 WHERE id = 1 AND current_revision = 1
        `);
      })
    ).rejects.toThrow();

    const current = await handle.client.query<{ current_revision: number }>(
      "SELECT current_revision FROM problems WHERE id = 1"
    );
    expect(current.rows[0]?.current_revision).toBe(1);
  });

  it("does not allow an audit event to be changed or deleted", async () => {
    const handle = await createMigratedDatabase();
    await seedCoreDatabase(handle);
    await handle.execute(sql`
      INSERT INTO audit_events (
        actor_user_id,
        request_id,
        action,
        object_type,
        object_id,
        result
      ) VALUES (
        0,
        '30000000-0000-4000-8000-000000000001',
        'problem.create',
        'problem',
        '1',
        'success'
      )
    `);

    await expect(
      handle.execute(sql`UPDATE audit_events SET result = 'failure' WHERE object_id = '1'`)
    ).rejects.toBeDefined();
    await expect(
      handle.execute(sql`DELETE FROM audit_events WHERE object_id = '1'`)
    ).rejects.toBeDefined();

    const storedEvents = await handle.client.query<{ result: string }>(`
      SELECT result
      FROM audit_events
      WHERE request_id = '30000000-0000-4000-8000-000000000001'
    `);
    expect(storedEvents.rows).toEqual([{ result: "success" }]);
  });
});
