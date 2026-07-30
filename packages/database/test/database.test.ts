import { sql } from "drizzle-orm";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createLocalDatabase,
  type LocalDatabaseHandle,
  migrateDatabase,
  seedCoreDatabase
} from "../src";

const openDatabases: LocalDatabaseHandle[] = [];
const temporaryDirectories: string[] = [];

async function createMigratedDatabase(): Promise<LocalDatabaseHandle> {
  const handle = createLocalDatabase();
  openDatabases.push(handle);
  await migrateDatabase(handle);
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

  it("rejects plain root passwords before writing anything", async () => {
    const handle = await createMigratedDatabase();

    await expect(
      seedCoreDatabase(handle, { rootPasswordHash: "this-is-not-a-password-hash" })
    ).rejects.toThrow("Argon2id");

    const root = await handle.client.query<{ count: number }>(
      "SELECT count(*)::integer AS count FROM users WHERE id = 0"
    );
    expect(root.rows[0]?.count).toBe(0);
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
