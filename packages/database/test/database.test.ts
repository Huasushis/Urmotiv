import { randomUUID } from "node:crypto";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  createLocalDatabase,
  createPostgresDatabase,
  isDatabaseEmptyForAdminBootstrap,
  type LocalDatabaseHandle,
  migrateDatabase,
  openAdminBootstrapForFreshSeed,
  type PostgresDatabaseHandle,
  readAdminBootstrapState,
  releaseAdminBootstrapMigrationLease,
  seedCoreDatabase,
  tryAcquireAdminBootstrapMigrationLease
} from "../src";

const openDatabases: LocalDatabaseHandle[] = [];
const temporaryDirectories: string[] = [];
const postgresAdminUrl = process.env.URMOTIV_TEST_POSTGRES_ADMIN_URL;
const describePostgres = postgresAdminUrl === undefined ? describe.skip : describe;

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

function migrationFolderThrough(lastIndex: number): string {
  const source = new URL("../migrations/", import.meta.url);
  const temporaryDirectory = mkdtempSync(join(tmpdir(), "urmotiv-migrations-"));
  temporaryDirectories.push(temporaryDirectory);
  mkdirSync(join(temporaryDirectory, "meta"), { recursive: true });
  const journal = JSON.parse(
    readFileSync(new URL("meta/_journal.json", source), "utf8")
  ) as { entries: Array<{ idx: number; tag: string }> };
  const entries = journal.entries.filter((entry) => entry.idx <= lastIndex);
  for (const entry of entries) {
    cpSync(
      new URL(`${entry.tag}.sql`, source),
      join(temporaryDirectory, `${entry.tag}.sql`)
    );
  }
  writeFileSync(
    join(temporaryDirectory, "meta", "_journal.json"),
    JSON.stringify({ ...journal, entries }),
    { encoding: "utf8", mode: 0o600 }
  );
  return temporaryDirectory;
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
      UPDATE tags SET description = '合成变更' WHERE id = 'catalog.tag.01.01'
    `);
    await expect(openAdminBootstrapForFreshSeed(handle, lease)).resolves.toBe(
      "baseline_mismatch"
    );
    await handle.execute(sql`
      UPDATE tags SET description = '' WHERE id = 'catalog.tag.01.01'
    `);

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
      await transaction.execute(sql`
        INSERT INTO problem_revision_tags (revision_id, tag_id)
        VALUES ('20000000-0000-4000-8000-000000000001', 'catalog.tag.02.09')
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

describe("robot review lease migration", () => {
  it("blocks live leases, then archives expired and legacy rows without changing human opinions", async () => {
    const handle = createEmptyDatabase();
    await migrateDatabase(handle, { migrationsFolder: migrationFolderThrough(8) });
    await seedCoreDatabase(handle);
    await handle.transaction(async (transaction) => {
      await transaction.execute(sql`
        INSERT INTO users (id, nickname, account_type)
        VALUES (7001, '合成机器人', 'robot'), (7002, '合成人工审题人', 'human')
      `);
      await transaction.execute(sql`
        INSERT INTO problems (id, owner_id, status, current_revision, current_review_round)
        VALUES (7001, 0, 'pending_review', 1, 1)
      `);
      await transaction.execute(sql`
        INSERT INTO problem_revisions (
          id, problem_id, revision, status, title, type, basic_statement, basic_solution,
          content_hash, change_reason, created_by_user_id
        ) VALUES (
          '70000000-0000-4000-8000-000000000001', 7001, 1, 'pending_review',
          '公开构造迁移题', 'traditional', '公开构造题面', '公开构造题解',
          '0000000000000000000000000000000000000000000000000000000000000000',
          '迁移测试', 0
        )
      `);
      await transaction.execute(sql`
        INSERT INTO tags (id, name, group_name)
        VALUES ('legacy.synthetic', '合成迁移标签', '迁移测试分组')
      `);
      await transaction.execute(sql`
        INSERT INTO problem_revision_tags (revision_id, tag_id)
        VALUES ('70000000-0000-4000-8000-000000000001', 'legacy.synthetic')
      `);
      await transaction.execute(sql`
        INSERT INTO review_rounds (
          id, problem_id, round, submitted_revision_id, status, rule_id, rule_version,
          submitted_by_user_id
        ) VALUES (
          '70000000-0000-4000-8000-000000000002', 7001, 1,
          '70000000-0000-4000-8000-000000000001', 'open', 'fixture', '1', 0
        )
      `);
      await transaction.execute(sql`
        INSERT INTO review_opinions (
          id, round_id, reviewer_user_id, source, verdict, codeforces_difficulty,
          quality_level, originality_level, thinking_level, coding_level, improvements
        ) VALUES (
          '70000000-0000-4000-8000-000000000003',
          '70000000-0000-4000-8000-000000000002', 7002, 'human', 'approve', 1600,
          4, 4, 3, 2, '公开构造的人工意见'
        )
      `);
      await transaction.execute(sql`
        INSERT INTO review_assignments (
          id, round_id, reviewer_user_id, assigned_by_user_id, reason, expires_at
        ) VALUES (
          '70000000-0000-4000-8000-000000000004',
          '70000000-0000-4000-8000-000000000002', 7001, 7001, '迁移门禁测试',
          now() + interval '1 hour'
        )
      `);
    });

    await expect(migrateDatabase(handle)).rejects.toThrow(
      /robot review lease migration requires all live robot leases to finish/
    );
    const absentColumns = await handle.query<{ count: number | string }>(sql`
      SELECT count(*)::integer AS count
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'review_assignments'
        AND column_name = 'closure_reason'
    `);
    expect(Number(absentColumns[0]?.count ?? -1)).toBe(0);

    await handle.execute(sql`
      UPDATE review_assignments
      SET created_at = now() - interval '2 hours',
          expires_at = now() - interval '1 hour'
      WHERE id = '70000000-0000-4000-8000-000000000004'
    `);
    await handle.execute(sql`
      INSERT INTO review_assignments (
        id, round_id, reviewer_user_id, assigned_by_user_id, reason,
        revoked_at, revoked_by_user_id, created_at
      ) VALUES (
        '70000000-0000-4000-8000-000000000005',
        '70000000-0000-4000-8000-000000000002', 7001, 7001, '旧撤销记录',
        now(), 7001, now() - interval '1 hour'
      )
    `);
    await migrateDatabase(handle);

    const assignments = await handle.query<{
      id: string;
      closure_reason: string;
      assignment_kind: string;
      expires_at: Date | string | null;
    }>(sql`
      SELECT id::text AS id, closure_reason::text AS closure_reason,
             assignment_kind::text AS assignment_kind, expires_at
      FROM review_assignments
      ORDER BY id
    `);
    expect(assignments).toEqual([
      {
        id: "70000000-0000-4000-8000-000000000004",
        closure_reason: "expired",
        assignment_kind: "robot",
        expires_at: expect.anything()
      },
      {
        id: "70000000-0000-4000-8000-000000000005",
        closure_reason: "legacy_closed",
        assignment_kind: "robot",
        expires_at: expect.anything()
      }
    ]);
    const opinions = await handle.query<{
      id: string;
      is_active: boolean;
      improvements: string;
    }>(sql`
      SELECT id::text AS id, is_active, improvements FROM review_opinions
    `);
    expect(opinions).toEqual([{
      id: "70000000-0000-4000-8000-000000000003",
      is_active: true,
      improvements: "公开构造的人工意见"
    }]);

    await expect(handle.execute(sql`
      UPDATE review_assignments
      SET closure_reason = NULL
      WHERE id = '70000000-0000-4000-8000-000000000004'
    `)).rejects.toBeDefined();
    await expect(handle.execute(sql`
      INSERT INTO review_assignments (
        id, round_id, reviewer_user_id, assigned_by_user_id, assignment_kind,
        claimed_problem_revision, claimed_submitted_revision_id, expires_at
      ) VALUES (
        '70000000-0000-4000-8000-000000000006',
        '70000000-0000-4000-8000-000000000002', 7001, 7001, 'robot',
        NULL, '70000000-0000-4000-8000-000000000001', now() + interval '1 hour'
      )
    `)).rejects.toBeDefined();
  });
});

describe("problem package outbox state machine in PGlite", () => {
  it("rejects undispatched execution, queue identity reuse, and active retirement", async () => {
    const handle = await createMigratedDatabase();
    const jobId = "83000000-0000-4000-8000-000000000001";
    const firstQueueJobId = "83000000-0000-4000-8000-000000000002";
    const secondQueueJobId = "83000000-0000-4000-8000-000000000003";

    await handle.execute(sql`
      INSERT INTO problem_package_job_outbox (
        job_id, job_kind, import_job_id, queue_job_id, queue_job_ids,
        queue_idempotency_scope, queue_idempotency_key, queue_request_digest,
        max_attempts, timeout_ms, max_delivery_generations, next_dispatch_at
      ) VALUES (
        ${jobId}::uuid, 'import', ${jobId}::uuid, ${firstQueueJobId}::uuid,
        ARRAY[${firstQueueJobId}::uuid], 'problem-package-import', ${firstQueueJobId},
        'eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee',
        3, 900000, 3, clock_timestamp()
      )
    `);

    await expectDatabaseError(handle.execute(sql`
      UPDATE problem_package_job_outbox
      SET execution_fence = execution_fence + 1,
          execution_delivery_generation = delivery_generation,
          execution_queue_job_id = queue_job_id,
          execution_queue_lease_id = '83000000-0000-4000-8000-000000000004',
          execution_worker_id = 'pglite-worker-before-dispatch',
          execution_queue_attempt = 1,
          execution_claimed_at = clock_timestamp() - interval '2 minutes',
          execution_lease_expires_at = clock_timestamp() + interval '5 minutes',
          updated_at = clock_timestamp()
      WHERE job_id = ${jobId}::uuid
    `), "PP_JOB_OUTBOX_EXECUTION_NOT_DISPATCHED");

    await handle.execute(sql`
      UPDATE problem_package_job_outbox
      SET dispatch_attempts = 1,
          dispatch_claim_id = '83000000-0000-4000-8000-000000000005',
          dispatch_claimed_by = 'pglite-dispatcher-one',
          dispatch_claimed_at = clock_timestamp(),
          dispatch_claim_expires_at = clock_timestamp() + interval '5 minutes',
          dispatch_claim_generation = delivery_generation,
          dispatch_claim_queue_job_id = queue_job_id,
          updated_at = clock_timestamp()
      WHERE job_id = ${jobId}::uuid
    `);
    await handle.execute(sql`
      UPDATE problem_package_job_outbox
      SET dispatch_claim_id = NULL,
          dispatch_claimed_by = NULL,
          dispatch_claimed_at = NULL,
          dispatch_claim_expires_at = NULL,
          dispatch_claim_generation = NULL,
          dispatch_claim_queue_job_id = NULL,
          last_dispatched_at = clock_timestamp(),
          next_dispatch_at = NULL,
          updated_at = clock_timestamp()
      WHERE job_id = ${jobId}::uuid
    `);
    await handle.execute(sql`
      UPDATE problem_package_job_outbox
      SET delivery_generation = delivery_generation + 1,
          queue_job_id = ${secondQueueJobId}::uuid,
          queue_job_ids = array_append(queue_job_ids, ${secondQueueJobId}::uuid),
          queue_idempotency_key = ${secondQueueJobId},
          dispatch_attempts = 0,
          last_dispatched_at = NULL,
          next_dispatch_at = clock_timestamp(),
          updated_at = clock_timestamp()
      WHERE job_id = ${jobId}::uuid
    `);
    await expectDatabaseError(handle.execute(sql`
      INSERT INTO problem_package_job_outbox (
        job_id, job_kind, import_job_id, queue_job_id, queue_job_ids,
        queue_idempotency_scope, queue_idempotency_key, queue_request_digest,
        max_attempts, timeout_ms, next_dispatch_at
      ) VALUES (
        '83000000-0000-4000-8000-000000000008', 'import',
        '83000000-0000-4000-8000-000000000008', ${firstQueueJobId}::uuid,
        ARRAY[${firstQueueJobId}::uuid], 'problem-package-import', ${firstQueueJobId},
        'ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff',
        3, 900000, clock_timestamp()
      )
    `), "PP_JOB_OUTBOX_DELIVERY_IDENTITY_GLOBALLY_REUSED");
    await handle.execute(sql`
      UPDATE problem_package_job_outbox
      SET dispatch_attempts = 1,
          dispatch_claim_id = '83000000-0000-4000-8000-000000000006',
          dispatch_claimed_by = 'pglite-dispatcher-two',
          dispatch_claimed_at = clock_timestamp(),
          dispatch_claim_expires_at = clock_timestamp() + interval '5 minutes',
          dispatch_claim_generation = delivery_generation,
          dispatch_claim_queue_job_id = queue_job_id,
          updated_at = clock_timestamp()
      WHERE job_id = ${jobId}::uuid
    `);
    await handle.execute(sql`
      UPDATE problem_package_job_outbox
      SET dispatch_claim_id = NULL,
          dispatch_claimed_by = NULL,
          dispatch_claimed_at = NULL,
          dispatch_claim_expires_at = NULL,
          dispatch_claim_generation = NULL,
          dispatch_claim_queue_job_id = NULL,
          last_dispatched_at = clock_timestamp(),
          next_dispatch_at = NULL,
          updated_at = clock_timestamp()
      WHERE job_id = ${jobId}::uuid
    `);

    await expectDatabaseError(handle.execute(sql`
      UPDATE problem_package_job_outbox
      SET delivery_generation = delivery_generation + 1,
          queue_job_id = ${firstQueueJobId}::uuid,
          queue_job_ids = array_append(queue_job_ids, ${firstQueueJobId}::uuid),
          queue_idempotency_key = ${firstQueueJobId},
          dispatch_attempts = 0,
          last_dispatched_at = NULL,
          next_dispatch_at = clock_timestamp(),
          updated_at = clock_timestamp()
      WHERE job_id = ${jobId}::uuid
    `), "PP_JOB_OUTBOX_DELIVERY_IDENTITY_REUSED");

    await handle.execute(sql`
      UPDATE problem_package_job_outbox
      SET execution_fence = execution_fence + 1,
          execution_delivery_generation = delivery_generation,
          execution_queue_job_id = queue_job_id,
          execution_queue_lease_id = '83000000-0000-4000-8000-000000000007',
          execution_worker_id = 'pglite-worker-two',
          execution_queue_attempt = 1,
          execution_claimed_at = clock_timestamp() - interval '2 minutes',
          execution_lease_expires_at = clock_timestamp() + interval '5 minutes',
          updated_at = clock_timestamp()
      WHERE job_id = ${jobId}::uuid
    `);
    await expectDatabaseError(handle.execute(sql`
      UPDATE problem_package_job_outbox
      SET retired_at = clock_timestamp(),
          next_dispatch_at = NULL,
          execution_delivery_generation = NULL,
          execution_queue_job_id = NULL,
          execution_queue_lease_id = NULL,
          execution_worker_id = NULL,
          execution_queue_attempt = NULL,
          execution_claimed_at = NULL,
          execution_lease_expires_at = NULL,
          updated_at = clock_timestamp()
      WHERE job_id = ${jobId}::uuid
    `), "PP_JOB_OUTBOX_RETIREMENT_EXECUTION_ACTIVE");
    await handle.execute(sql`
      UPDATE problem_package_job_outbox
      SET execution_lease_expires_at = execution_claimed_at + interval '1 second',
          updated_at = clock_timestamp()
      WHERE job_id = ${jobId}::uuid
    `);
    await handle.execute(sql`
      UPDATE problem_package_job_outbox
      SET retired_at = clock_timestamp(),
          next_dispatch_at = NULL,
          execution_delivery_generation = NULL,
          execution_queue_job_id = NULL,
          execution_queue_lease_id = NULL,
          execution_worker_id = NULL,
          execution_queue_attempt = NULL,
          execution_claimed_at = NULL,
          execution_lease_expires_at = NULL,
          updated_at = clock_timestamp()
      WHERE job_id = ${jobId}::uuid
    `);

    const state = await handle.query<{
      delivery_generation: number;
      history_count: number;
      first_queue_job_id: string;
      second_queue_job_id: string;
      retired: boolean;
      execution_identity_count: number;
    }>(sql`
      SELECT delivery_generation,
             cardinality(queue_job_ids)::integer AS history_count,
             queue_job_ids[1]::text AS first_queue_job_id,
             queue_job_ids[2]::text AS second_queue_job_id,
             retired_at IS NOT NULL AS retired,
             num_nonnulls(
               execution_delivery_generation, execution_queue_job_id,
               execution_queue_lease_id, execution_worker_id,
               execution_queue_attempt, execution_claimed_at,
               execution_lease_expires_at
             )::integer AS execution_identity_count
      FROM problem_package_job_outbox
      WHERE job_id = ${jobId}::uuid
    `);
    expect(state).toEqual([{
      delivery_generation: 2,
      history_count: 2,
      first_queue_job_id: firstQueueJobId,
      second_queue_job_id: secondQueueJobId,
      retired: true,
      execution_identity_count: 0
    }]);
  });
});

describePostgres("problem package outbox on real PostgreSQL", () => {
  let databaseName = "";
  let databaseUrl = "";
  let database: PostgresDatabaseHandle | undefined;

  beforeAll(async () => {
    if (postgresAdminUrl === undefined) return;
    databaseName = `urmotiv_outbox_${process.pid}_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
    if (!/^urmotiv_outbox_[a-z0-9_]+$/.test(databaseName)) {
      throw new Error("测试数据库名称无效。");
    }
    const admin = createPostgresDatabase({
      connectionString: postgresAdminUrl,
      maxConnections: 2,
      statementTimeoutMs: 10_000,
      applicationName: "urmotiv-outbox-test-admin"
    });
    try {
      await admin.execute(sql`CREATE DATABASE ${sql.identifier(databaseName)}`);
    } finally {
      await admin.close();
    }
    databaseUrl = databaseConnectionString(postgresAdminUrl, databaseName);
    database = createPostgresDatabase({
      connectionString: databaseUrl,
      maxConnections: 8,
      statementTimeoutMs: 10_000,
      applicationName: "urmotiv-outbox-test"
    });
  });

  afterAll(async () => {
    await database?.close();
    if (postgresAdminUrl === undefined || databaseName.length === 0) return;
    const admin = createPostgresDatabase({
      connectionString: postgresAdminUrl,
      maxConnections: 2,
      statementTimeoutMs: 10_000,
      applicationName: "urmotiv-outbox-test-cleanup"
    });
    try {
      await admin.execute(sql`DROP DATABASE ${sql.identifier(databaseName)}`);
    } finally {
      await admin.close();
    }
  });

  it("keeps C1 compatible and protects delivery generations and execution fences", async () => {
    if (database === undefined) {
      throw new Error("未建立真实 PostgreSQL 测试数据库。");
    }

    await migrateDatabase(database, { migrationsFolder: migrationFolderThrough(9) });
    await seedCoreDatabase(database);

    const legacyFileId = "81000000-0000-4000-8000-000000000001";
    const legacyJobId = "81000000-0000-4000-8000-000000000002";
    await database.execute(sql`
      INSERT INTO stored_files (
        id, purpose, storage_key, original_name, media_type, byte_size, sha256,
        created_by_user_id
      ) VALUES (
        ${legacyFileId}::uuid, 'import_input', 'synthetic-outbox-source-one',
        'synthetic-one.zip', 'application/zip', 1,
        '1111111111111111111111111111111111111111111111111111111111111111', 0
      )
    `);
    await database.execute(sql`
      INSERT INTO import_jobs (
        id, requested_by_user_id, source_file_id, selected_format, input_digest,
        state, idempotency_key
      ) VALUES (
        ${legacyJobId}::uuid, 0, ${legacyFileId}::uuid, 'synthetic',
        '1111111111111111111111111111111111111111111111111111111111111111',
        'running', 'synthetic-running-compatible'
      )
    `);
    await migrateDatabase(database);
    const legacyAdapterBinding = await database.query<{
      selected_format_version: string;
      client_request_digest: string | null;
    }>(sql`
      SELECT selected_format_version, client_request_digest
      FROM import_jobs
      WHERE id = ${legacyJobId}::uuid
    `);
    expect(legacyAdapterBinding).toEqual([
      { selected_format_version: "legacy-unbound", client_request_digest: null }
    ]);
    const legacyOutbox = await database.query<{ count: number }>(sql`
      SELECT count(*)::integer AS count
      FROM problem_package_job_outbox
      WHERE job_id = ${legacyJobId}::uuid
    `);
    expect(legacyOutbox).toEqual([{ count: 0 }]);
    await database.execute(sql`
      INSERT INTO problem_package_job_outbox (
        job_id, job_kind, import_job_id, queue_job_id, queue_job_ids,
        queue_idempotency_scope, queue_idempotency_key, queue_request_digest,
        max_attempts, timeout_ms,
        max_delivery_generations, next_dispatch_at
      ) VALUES (
        ${legacyJobId}::uuid, 'import', ${legacyJobId}::uuid,
        '82000000-0000-4000-8000-000000000001',
        ARRAY['82000000-0000-4000-8000-000000000001'::uuid],
        'problem-package-import', '82000000-0000-4000-8000-000000000001',
        'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        3, 900000, 3, clock_timestamp()
      )
    `);

    const importFileId = "81000000-0000-4000-8000-000000000003";
    const importJobId = "81000000-0000-4000-8000-000000000004";
    let queuedInsertReachedEnd = false;
    await database.transaction(async (transaction) => {
      await transaction.execute(sql`
        INSERT INTO stored_files (
          id, purpose, storage_key, original_name, media_type, byte_size, sha256,
          created_by_user_id
        ) VALUES (
          ${importFileId}::uuid, 'import_input', 'synthetic-outbox-source-two',
          'synthetic-two.zip', 'application/zip', 1,
          '2222222222222222222222222222222222222222222222222222222222222222', 0
        )
      `);
      await transaction.execute(sql`
        INSERT INTO import_jobs (
          id, requested_by_user_id, source_file_id, selected_format,
          selected_format_version, input_digest, idempotency_key
        ) VALUES (
          ${importJobId}::uuid, 0, ${importFileId}::uuid, 'synthetic',
          'test-version',
          '2222222222222222222222222222222222222222222222222222222222222222',
          'synthetic-deferred'
        )
      `);
      queuedInsertReachedEnd = true;
    });
    expect(queuedInsertReachedEnd).toBe(true);
    await database.execute(sql`
      UPDATE import_jobs SET state = 'running' WHERE id = ${importJobId}::uuid
    `);
    await database.execute(sql`
      UPDATE import_jobs SET state = 'queued' WHERE id = ${importJobId}::uuid
    `);
    const compatibleQueuedJob = await database.query<{
      state: string;
      outbox_count: number;
    }>(sql`
      SELECT task.state::text AS state,
             (SELECT count(*)::integer
              FROM problem_package_job_outbox outbox
              WHERE outbox.job_id = task.id) AS outbox_count
      FROM import_jobs task
      WHERE task.id = ${importJobId}::uuid
    `);
    expect(compatibleQueuedJob).toEqual([{ state: "queued", outbox_count: 0 }]);

    const firstQueueJobId = "82000000-0000-4000-8000-000000000002";
    await database.execute(sql`
        INSERT INTO problem_package_job_outbox (
          job_id, job_kind, import_job_id, queue_job_id, queue_job_ids,
          queue_idempotency_scope, queue_idempotency_key, queue_request_digest,
          max_attempts, timeout_ms,
          max_delivery_generations, next_dispatch_at
        ) VALUES (
          ${importJobId}::uuid, 'import', ${importJobId}::uuid,
          ${firstQueueJobId}::uuid, ARRAY[${firstQueueJobId}::uuid],
          'problem-package-import', ${firstQueueJobId},
          'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
          3, 900000, 3, clock_timestamp()
        )
    `);

    await expectDatabaseError(database.execute(sql`
      UPDATE problem_package_job_outbox
      SET execution_fence = execution_fence + 1,
          execution_delivery_generation = delivery_generation,
          execution_queue_job_id = queue_job_id,
          execution_queue_lease_id = '82000000-0000-4000-8000-000000000015',
          execution_worker_id = 'synthetic-worker-before-dispatch',
          execution_queue_attempt = 1,
          execution_claimed_at = clock_timestamp() - interval '2 minutes',
          execution_lease_expires_at = clock_timestamp() + interval '5 minutes',
          updated_at = clock_timestamp()
      WHERE job_id = ${importJobId}::uuid
    `), "PP_JOB_OUTBOX_EXECUTION_NOT_DISPATCHED");
    await expectDatabaseError(database.execute(sql`
      UPDATE problem_package_job_outbox
      SET queue_job_ids = array_append(
            queue_job_ids,
            '82000000-0000-4000-8000-000000000016'::uuid
          )
      WHERE job_id = ${importJobId}::uuid
    `), "PP_JOB_OUTBOX_DELIVERY_HISTORY_IMMUTABLE");

    const exportJobId = "81000000-0000-4000-8000-000000000005";
    await database.transaction(async (transaction) => {
      await transaction.execute(sql`
        INSERT INTO export_jobs (
          id, requested_by_user_id, target_format, target_format_version,
          idempotency_key
        ) VALUES (
          ${exportJobId}::uuid, 0, 'synthetic', 'test-version', 'synthetic-export'
        )
      `);
      await transaction.execute(sql`
        INSERT INTO problem_package_job_outbox (
          job_id, job_kind, export_job_id, queue_job_id, queue_job_ids,
          queue_idempotency_scope, queue_idempotency_key, queue_request_digest,
          max_attempts, timeout_ms,
          next_dispatch_at
        ) VALUES (
          ${exportJobId}::uuid, 'export', ${exportJobId}::uuid,
          '82000000-0000-4000-8000-000000000003',
          ARRAY['82000000-0000-4000-8000-000000000003'::uuid],
          'problem-package-export', '82000000-0000-4000-8000-000000000003',
          'cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc',
          3, 1800000, clock_timestamp()
        )
      `);
    });

    const invalidExportJobId = "81000000-0000-4000-8000-000000000006";
    await database.execute(sql`
      INSERT INTO export_jobs (
        id, requested_by_user_id, target_format, target_format_version,
        state, idempotency_key
      ) VALUES (
        ${invalidExportJobId}::uuid, 0, 'synthetic', 'test-version', 'failed',
        'synthetic-invalid-parent'
      )
    `);
    await expectDatabaseError(database.execute(sql`
      INSERT INTO problem_package_job_outbox (
        job_id, job_kind, export_job_id, queue_job_id, queue_job_ids,
        queue_idempotency_scope, queue_idempotency_key, queue_request_digest,
        max_attempts, timeout_ms,
        next_dispatch_at
      ) VALUES (
        ${invalidExportJobId}::uuid, 'import', ${invalidExportJobId}::uuid,
        '82000000-0000-4000-8000-000000000004',
        ARRAY['82000000-0000-4000-8000-000000000004'::uuid],
        'problem-package-import', '82000000-0000-4000-8000-000000000004',
        'dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd',
        3, 900000, clock_timestamp()
      )
    `), "PP_JOB_OUTBOX_PARENT_INVALID");

    await database.execute(sql`
      UPDATE export_jobs SET state = 'running' WHERE id = ${exportJobId}::uuid
    `);

    let activeDeleteReachedEnd = false;
    await expectDatabaseError(database.transaction(async (transaction) => {
      await transaction.execute(sql`
        DELETE FROM problem_package_job_outbox WHERE job_id = ${exportJobId}::uuid
      `);
      activeDeleteReachedEnd = true;
    }), "PP_JOB_OUTBOX_DELETE_FORBIDDEN");
    expect(activeDeleteReachedEnd).toBe(false);
    await expectDatabaseError(
      database.execute(sql`TRUNCATE TABLE problem_package_job_outbox`),
      "PP_JOB_OUTBOX_TRUNCATE_FORBIDDEN"
    );

    await expectDatabaseError(database.execute(sql`
      UPDATE problem_package_job_outbox
      SET queue_request_digest = 'eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee'
      WHERE job_id = ${importJobId}::uuid
    `), "PP_JOB_OUTBOX_IDENTITY_IMMUTABLE");
    await expectDatabaseError(database.execute(sql`
      UPDATE problem_package_job_outbox
      SET created_at = created_at + interval '1 second'
      WHERE job_id = ${importJobId}::uuid
    `), "PP_JOB_OUTBOX_IDENTITY_IMMUTABLE");
    await expectDatabaseError(database.execute(sql`
      UPDATE problem_package_job_outbox
      SET queue_job_id = '82000000-0000-4000-8000-000000000005',
          queue_idempotency_key = '82000000-0000-4000-8000-000000000005'
      WHERE job_id = ${importJobId}::uuid
    `), "PP_JOB_OUTBOX_DELIVERY_IDENTITY");
    await expectDatabaseError(database.execute(sql`
      UPDATE problem_package_job_outbox
      SET delivery_generation = 3,
          queue_job_id = '82000000-0000-4000-8000-000000000006',
          queue_idempotency_key = '82000000-0000-4000-8000-000000000006'
      WHERE job_id = ${importJobId}::uuid
    `), "PP_JOB_OUTBOX_DELIVERY_STEP");
    await expectDatabaseError(database.execute(sql`
      UPDATE problem_package_job_outbox
      SET delivery_generation = 2,
          queue_job_id = '82000000-0000-4000-8000-000000000007',
          queue_idempotency_key = '82000000-0000-4000-8000-000000000007'
      WHERE job_id = ${importJobId}::uuid
    `), "PP_JOB_OUTBOX_DELIVERY_NOT_DISPATCHED");
    await expectDatabaseError(database.execute(sql`
      UPDATE problem_package_job_outbox
      SET last_dispatched_at = clock_timestamp(),
          next_dispatch_at = NULL,
          updated_at = clock_timestamp()
      WHERE job_id = ${importJobId}::uuid
    `), "PP_JOB_OUTBOX_DISPATCH_EVIDENCE");

    const firstDispatchClaimId = "82000000-0000-4000-8000-000000000008";
    await database.execute(sql`
      UPDATE problem_package_job_outbox
      SET dispatch_attempts = 1,
          dispatch_claim_id = ${firstDispatchClaimId}::uuid,
          dispatch_claimed_by = 'synthetic-dispatcher-one',
          dispatch_claimed_at = clock_timestamp(),
          dispatch_claim_expires_at = clock_timestamp() + interval '5 minutes',
          dispatch_claim_generation = delivery_generation,
          dispatch_claim_queue_job_id = queue_job_id,
          updated_at = clock_timestamp()
      WHERE job_id = ${importJobId}::uuid
    `);
    await database.execute(sql`
      UPDATE problem_package_job_outbox
      SET dispatch_claim_id = NULL,
          dispatch_claimed_by = NULL,
          dispatch_claimed_at = NULL,
          dispatch_claim_expires_at = NULL,
          dispatch_claim_generation = NULL,
          dispatch_claim_queue_job_id = NULL,
          last_dispatched_at = clock_timestamp(),
          next_dispatch_at = NULL,
          updated_at = clock_timestamp()
      WHERE job_id = ${importJobId}::uuid
    `);

    const secondQueueJobId = "82000000-0000-4000-8000-000000000009";
    const secondGeneration = await database.query<{
      delivery_generation: number;
      queue_job_id: string;
      queue_request_digest: string;
    }>(sql`
      UPDATE problem_package_job_outbox
      SET delivery_generation = delivery_generation + 1,
          queue_job_id = ${secondQueueJobId}::uuid,
          queue_job_ids = array_append(queue_job_ids, ${secondQueueJobId}::uuid),
          queue_idempotency_key = ${secondQueueJobId},
          dispatch_attempts = 0,
          last_dispatched_at = NULL,
          last_dispatch_error_code = NULL,
          next_dispatch_at = clock_timestamp(),
          updated_at = clock_timestamp()
      WHERE job_id = ${importJobId}::uuid
      RETURNING delivery_generation, queue_job_id::text AS queue_job_id,
                queue_request_digest::text AS queue_request_digest
    `);
    expect(secondGeneration).toEqual([{
      delivery_generation: 2,
      queue_job_id: secondQueueJobId,
      queue_request_digest: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
    }]);
    await expectDatabaseError(database.execute(sql`
      INSERT INTO problem_package_job_outbox (
        job_id, job_kind, import_job_id, queue_job_id, queue_job_ids,
        queue_idempotency_scope, queue_idempotency_key, queue_request_digest,
        max_attempts, timeout_ms, next_dispatch_at
      ) VALUES (
        '81000000-0000-4000-8000-000000000009', 'import',
        '81000000-0000-4000-8000-000000000009', ${firstQueueJobId}::uuid,
        ARRAY[${firstQueueJobId}::uuid], 'problem-package-import', ${firstQueueJobId},
        '9999999999999999999999999999999999999999999999999999999999999999',
        3, 900000, clock_timestamp()
      )
    `), "PP_JOB_OUTBOX_DELIVERY_IDENTITY_GLOBALLY_REUSED");

    const secondDispatchClaimId = "82000000-0000-4000-8000-000000000010";
    await database.execute(sql`
      UPDATE problem_package_job_outbox
      SET dispatch_attempts = 1,
          dispatch_claim_id = ${secondDispatchClaimId}::uuid,
          dispatch_claimed_by = 'synthetic-dispatcher-two',
          dispatch_claimed_at = clock_timestamp(),
          dispatch_claim_expires_at = clock_timestamp() + interval '5 minutes',
          dispatch_claim_generation = delivery_generation,
          dispatch_claim_queue_job_id = queue_job_id,
          updated_at = clock_timestamp()
      WHERE job_id = ${importJobId}::uuid
    `);
    await database.execute(sql`
      UPDATE problem_package_job_outbox
      SET dispatch_claim_id = NULL,
          dispatch_claimed_by = NULL,
          dispatch_claimed_at = NULL,
          dispatch_claim_expires_at = NULL,
          dispatch_claim_generation = NULL,
          dispatch_claim_queue_job_id = NULL,
          last_dispatched_at = clock_timestamp(),
          next_dispatch_at = NULL,
          updated_at = clock_timestamp()
      WHERE job_id = ${importJobId}::uuid
    `);

    await expectDatabaseError(database.execute(sql`
      UPDATE problem_package_job_outbox
      SET delivery_generation = delivery_generation + 1,
          queue_job_id = ${firstQueueJobId}::uuid,
          queue_job_ids = array_append(queue_job_ids, ${firstQueueJobId}::uuid),
          queue_idempotency_key = ${firstQueueJobId},
          dispatch_attempts = 0,
          last_dispatched_at = NULL,
          last_dispatch_error_code = NULL,
          next_dispatch_at = clock_timestamp(),
          updated_at = clock_timestamp()
      WHERE job_id = ${importJobId}::uuid
    `), "PP_JOB_OUTBOX_DELIVERY_IDENTITY_REUSED");

    const firstLeaseId = "81000000-0000-4000-8000-000000000007";
    await database.transaction(async (transaction) => {
      await transaction.execute(sql`
        UPDATE problem_package_job_outbox
        SET execution_fence = execution_fence + 1,
            execution_delivery_generation = delivery_generation,
            execution_queue_job_id = queue_job_id,
            execution_queue_lease_id = ${firstLeaseId}::uuid,
            execution_worker_id = 'synthetic-worker-one',
            execution_queue_attempt = 1,
            execution_claimed_at = clock_timestamp() - interval '2 minutes',
            execution_lease_expires_at = clock_timestamp() - interval '1 minute',
            updated_at = clock_timestamp()
        WHERE job_id = ${importJobId}::uuid
      `);
      await transaction.execute(sql`
        UPDATE import_jobs SET state = 'running' WHERE id = ${importJobId}::uuid
      `);
    });
    await expectDatabaseError(database.execute(sql`
      UPDATE problem_package_job_outbox
      SET execution_fence = execution_fence + 1,
          execution_lease_expires_at = clock_timestamp() + interval '5 minutes',
          updated_at = clock_timestamp()
      WHERE job_id = ${importJobId}::uuid
    `), "PP_JOB_OUTBOX_FENCE_IDENTITY");

    const secondLeaseId = "81000000-0000-4000-8000-000000000008";
    const secondFence = await database.query<{ execution_fence: string }>(sql`
      UPDATE problem_package_job_outbox
      SET execution_fence = execution_fence + 1,
          execution_delivery_generation = delivery_generation,
          execution_queue_job_id = queue_job_id,
          execution_queue_lease_id = ${secondLeaseId}::uuid,
          execution_worker_id = 'synthetic-worker-two',
          execution_queue_attempt = 2,
          execution_claimed_at = clock_timestamp() - interval '2 minutes',
          execution_lease_expires_at = clock_timestamp() + interval '5 minutes',
          updated_at = clock_timestamp()
      WHERE job_id = ${importJobId}::uuid
      RETURNING execution_fence::text AS execution_fence
    `);
    expect(secondFence).toEqual([{ execution_fence: "2" }]);

    const staleWrite = await database.query<{ progress_percent: number }>(sql`
      UPDATE import_jobs task
      SET progress_percent = 25
      WHERE task.id = ${importJobId}::uuid
        AND EXISTS (
          SELECT 1
          FROM problem_package_job_outbox outbox
          WHERE outbox.job_id = task.id
            AND outbox.retired_at IS NULL
            AND outbox.execution_fence = 1
            AND outbox.execution_delivery_generation = 2
            AND outbox.execution_queue_job_id = ${secondQueueJobId}::uuid
            AND outbox.execution_queue_lease_id = ${firstLeaseId}::uuid
            AND outbox.execution_lease_expires_at > clock_timestamp()
        )
      RETURNING progress_percent
    `);
    expect(staleWrite).toEqual([]);
    const currentWrite = await database.query<{ progress_percent: number }>(sql`
      UPDATE import_jobs task
      SET progress_percent = 40
      WHERE task.id = ${importJobId}::uuid
        AND EXISTS (
          SELECT 1
          FROM problem_package_job_outbox outbox
          WHERE outbox.job_id = task.id
            AND outbox.retired_at IS NULL
            AND outbox.execution_fence = 2
            AND outbox.execution_delivery_generation = 2
            AND outbox.execution_queue_job_id = ${secondQueueJobId}::uuid
            AND outbox.execution_queue_lease_id = ${secondLeaseId}::uuid
            AND outbox.execution_lease_expires_at > clock_timestamp()
        )
      RETURNING progress_percent
    `);
    expect(currentWrite).toEqual([{ progress_percent: 40 }]);

    await expectDatabaseError(database.execute(sql`
      UPDATE problem_package_job_outbox
      SET execution_fence = 1
      WHERE job_id = ${importJobId}::uuid
    `), "PP_JOB_OUTBOX_FENCE_REGRESSION");
    await expectDatabaseError(database.execute(sql`
      UPDATE problem_package_job_outbox
      SET execution_queue_lease_id = ${firstLeaseId}::uuid
      WHERE job_id = ${importJobId}::uuid
    `), "PP_JOB_OUTBOX_FENCE_REUSE");
    await expectDatabaseError(database.execute(sql`
      UPDATE problem_package_job_outbox
      SET execution_fence = 4
      WHERE job_id = ${importJobId}::uuid
    `), "PP_JOB_OUTBOX_FENCE_STEP");
    await expectDatabaseError(database.execute(sql`
      UPDATE problem_package_job_outbox
      SET execution_fence = 3,
          execution_delivery_generation = delivery_generation,
          execution_queue_job_id = queue_job_id,
          execution_queue_lease_id = ${firstLeaseId}::uuid,
          execution_worker_id = 'synthetic-worker-three',
          execution_queue_attempt = 3,
          execution_claimed_at = clock_timestamp(),
          execution_lease_expires_at = clock_timestamp() + interval '5 minutes'
      WHERE job_id = ${importJobId}::uuid
    `), "PP_JOB_OUTBOX_FENCE_ACTIVE");

    const thirdQueueJobId = "82000000-0000-4000-8000-000000000011";
    await expectDatabaseError(database.execute(sql`
      UPDATE problem_package_job_outbox
      SET delivery_generation = delivery_generation + 1,
          queue_job_id = ${thirdQueueJobId}::uuid,
          queue_job_ids = array_append(queue_job_ids, ${thirdQueueJobId}::uuid),
          queue_idempotency_key = ${thirdQueueJobId},
          dispatch_attempts = 0,
          last_dispatched_at = NULL,
          last_dispatch_error_code = NULL,
          next_dispatch_at = clock_timestamp(),
          execution_delivery_generation = NULL,
          execution_queue_job_id = NULL,
          execution_queue_lease_id = NULL,
          execution_worker_id = NULL,
          execution_queue_attempt = NULL,
          execution_claimed_at = NULL,
          execution_lease_expires_at = NULL,
          updated_at = clock_timestamp()
      WHERE job_id = ${importJobId}::uuid
    `), "PP_JOB_OUTBOX_FENCE_ACTIVE");

    await database.execute(sql`
      UPDATE problem_package_job_outbox
      SET execution_lease_expires_at = execution_claimed_at + interval '1 second',
          updated_at = clock_timestamp()
      WHERE job_id = ${importJobId}::uuid
    `);
    const thirdGeneration = await database.query<{
      delivery_generation: number;
      execution_fence: string;
      execution_queue_lease_id: string | null;
    }>(sql`
      UPDATE problem_package_job_outbox
      SET delivery_generation = delivery_generation + 1,
          queue_job_id = ${thirdQueueJobId}::uuid,
          queue_job_ids = array_append(queue_job_ids, ${thirdQueueJobId}::uuid),
          queue_idempotency_key = ${thirdQueueJobId},
          dispatch_attempts = 0,
          last_dispatched_at = NULL,
          last_dispatch_error_code = NULL,
          next_dispatch_at = clock_timestamp(),
          execution_delivery_generation = NULL,
          execution_queue_job_id = NULL,
          execution_queue_lease_id = NULL,
          execution_worker_id = NULL,
          execution_queue_attempt = NULL,
          execution_claimed_at = NULL,
          execution_lease_expires_at = NULL,
          updated_at = clock_timestamp()
      WHERE job_id = ${importJobId}::uuid
      RETURNING delivery_generation, execution_fence::text AS execution_fence,
                execution_queue_lease_id::text AS execution_queue_lease_id
    `);
    expect(thirdGeneration).toEqual([{
      delivery_generation: 3,
      execution_fence: "2",
      execution_queue_lease_id: null
    }]);

    const thirdDispatchClaimId = "82000000-0000-4000-8000-000000000012";
    await database.execute(sql`
      UPDATE problem_package_job_outbox
      SET dispatch_attempts = 1,
          dispatch_claim_id = ${thirdDispatchClaimId}::uuid,
          dispatch_claimed_by = 'synthetic-dispatcher-three',
          dispatch_claimed_at = clock_timestamp(),
          dispatch_claim_expires_at = clock_timestamp() + interval '5 minutes',
          dispatch_claim_generation = delivery_generation,
          dispatch_claim_queue_job_id = queue_job_id,
          updated_at = clock_timestamp()
      WHERE job_id = ${importJobId}::uuid
    `);
    await database.execute(sql`
      UPDATE problem_package_job_outbox
      SET dispatch_claim_id = NULL,
          dispatch_claimed_by = NULL,
          dispatch_claimed_at = NULL,
          dispatch_claim_expires_at = NULL,
          dispatch_claim_generation = NULL,
          dispatch_claim_queue_job_id = NULL,
          last_dispatched_at = clock_timestamp(),
          next_dispatch_at = NULL,
          updated_at = clock_timestamp()
      WHERE job_id = ${importJobId}::uuid
    `);

    const thirdLeaseId = "82000000-0000-4000-8000-000000000013";
    const thirdFence = await database.query<{
      execution_fence: string;
      execution_delivery_generation: number;
      execution_queue_job_id: string;
      execution_queue_attempt: number;
    }>(sql`
      UPDATE problem_package_job_outbox
      SET execution_fence = execution_fence + 1,
          execution_delivery_generation = delivery_generation,
          execution_queue_job_id = queue_job_id,
          execution_queue_lease_id = ${thirdLeaseId}::uuid,
          execution_worker_id = 'synthetic-worker-three',
          execution_queue_attempt = 1,
          execution_claimed_at = clock_timestamp() - interval '2 minutes',
          execution_lease_expires_at = clock_timestamp() + interval '5 minutes',
          updated_at = clock_timestamp()
      WHERE job_id = ${importJobId}::uuid
      RETURNING execution_fence::text AS execution_fence,
                execution_delivery_generation, execution_queue_job_id::text AS execution_queue_job_id,
                execution_queue_attempt
    `);
    expect(thirdFence).toEqual([{
      execution_fence: "3",
      execution_delivery_generation: 3,
      execution_queue_job_id: thirdQueueJobId,
      execution_queue_attempt: 1
    }]);

    const staleGenerationWrite = await database.query<{ progress_percent: number }>(sql`
      UPDATE import_jobs task
      SET progress_percent = 60
      WHERE task.id = ${importJobId}::uuid
        AND EXISTS (
          SELECT 1
          FROM problem_package_job_outbox outbox
          WHERE outbox.job_id = task.id
            AND outbox.retired_at IS NULL
            AND outbox.execution_fence = 2
            AND outbox.execution_delivery_generation = 2
            AND outbox.execution_queue_job_id = ${secondQueueJobId}::uuid
            AND outbox.execution_queue_lease_id = ${secondLeaseId}::uuid
            AND outbox.execution_lease_expires_at > clock_timestamp()
        )
      RETURNING progress_percent
    `);
    expect(staleGenerationWrite).toEqual([]);
    const currentGenerationWrite = await database.query<{ progress_percent: number }>(sql`
      UPDATE import_jobs task
      SET progress_percent = 70
      WHERE task.id = ${importJobId}::uuid
        AND EXISTS (
          SELECT 1
          FROM problem_package_job_outbox outbox
          WHERE outbox.job_id = task.id
            AND outbox.retired_at IS NULL
            AND outbox.execution_fence = 3
            AND outbox.execution_delivery_generation = 3
            AND outbox.execution_queue_job_id = ${thirdQueueJobId}::uuid
            AND outbox.execution_queue_lease_id = ${thirdLeaseId}::uuid
            AND outbox.execution_lease_expires_at > clock_timestamp()
        )
      RETURNING progress_percent
    `);
    expect(currentGenerationWrite).toEqual([{ progress_percent: 70 }]);

    await expectDatabaseError(database.execute(sql`
      UPDATE problem_package_job_outbox
      SET delivery_generation = delivery_generation + 1,
          queue_job_id = '82000000-0000-4000-8000-000000000014',
          queue_idempotency_key = '82000000-0000-4000-8000-000000000014'
      WHERE job_id = ${importJobId}::uuid
    `), "PP_JOB_OUTBOX_DELIVERY_LIMIT");

    await expectDatabaseError(database.execute(sql`
      UPDATE problem_package_job_outbox
      SET retired_at = clock_timestamp(),
          next_dispatch_at = NULL,
          execution_delivery_generation = NULL,
          execution_queue_job_id = NULL,
          execution_queue_lease_id = NULL,
          execution_worker_id = NULL,
          execution_queue_attempt = NULL,
          execution_claimed_at = NULL,
          execution_lease_expires_at = NULL,
          updated_at = clock_timestamp()
      WHERE job_id = ${importJobId}::uuid
    `), "PP_JOB_OUTBOX_RETIREMENT_EXECUTION_ACTIVE");
    await database.execute(sql`
      UPDATE problem_package_job_outbox
      SET execution_lease_expires_at = execution_claimed_at + interval '1 second',
          updated_at = clock_timestamp()
      WHERE job_id = ${importJobId}::uuid
    `);
    await expectDatabaseError(database.execute(sql`
      UPDATE problem_package_job_outbox
      SET retired_at = clock_timestamp(),
          next_dispatch_at = NULL,
          updated_at = clock_timestamp()
      WHERE job_id = ${importJobId}::uuid
    `), "PP_JOB_OUTBOX_RETIREMENT_EXECUTION_IDENTITY");

    await database.execute(sql`
      UPDATE import_jobs SET state = 'failed' WHERE id = ${importJobId}::uuid
    `);
    await database.execute(sql`
      UPDATE problem_package_job_outbox
      SET retired_at = clock_timestamp(),
          next_dispatch_at = NULL,
          execution_delivery_generation = NULL,
          execution_queue_job_id = NULL,
          execution_queue_lease_id = NULL,
          execution_worker_id = NULL,
          execution_queue_attempt = NULL,
          execution_claimed_at = NULL,
          execution_lease_expires_at = NULL,
          updated_at = clock_timestamp()
      WHERE job_id = ${importJobId}::uuid
    `);
    await expectDatabaseError(database.execute(sql`
      UPDATE problem_package_job_outbox
      SET retired_at = NULL, next_dispatch_at = clock_timestamp()
      WHERE job_id = ${importJobId}::uuid
    `), "PP_JOB_OUTBOX_RETIREMENT_IMMUTABLE");

    const concurrencyDatabase = database;
    if (concurrencyDatabase === undefined) {
      throw new Error("真实 PostgreSQL 测试连接已经关闭。");
    }
    const insertConcurrentOutbox = (
      jobId: string,
      queueJobId: string,
      requestDigest: string
    ): Promise<void> => concurrencyDatabase.transaction(async (transaction) => {
      await transaction.execute(sql`
        INSERT INTO problem_package_job_outbox (
          job_id, job_kind, import_job_id, queue_job_id, queue_job_ids,
          queue_idempotency_scope, queue_idempotency_key, queue_request_digest,
          max_attempts, timeout_ms, next_dispatch_at
        ) VALUES (
          ${jobId}::uuid, 'import', ${jobId}::uuid, ${queueJobId}::uuid,
          ARRAY[${queueJobId}::uuid], 'problem-package-import', ${queueJobId},
          ${requestDigest}, 3, 900000, clock_timestamp()
        )
      `);
    });

    const historicalQueueJobId = "85000000-0000-4000-8000-000000000001";
    const replacementQueueJobId = "85000000-0000-4000-8000-000000000002";
    const historyOwnerJobId = "85000000-0000-4000-8000-000000000003";
    const blockedHistoryJobId = "85000000-0000-4000-8000-000000000004";
    const rotationReady = createDeferred<void>();
    const releaseRotation = createDeferred<void>();
    const historyOwnerTransaction = concurrencyDatabase.transaction(async (transaction) => {
      await transaction.execute(sql`
        INSERT INTO problem_package_job_outbox (
          job_id, job_kind, import_job_id, queue_job_id, queue_job_ids,
          queue_idempotency_scope, queue_idempotency_key, queue_request_digest,
          max_attempts, timeout_ms, next_dispatch_at
        ) VALUES (
          ${historyOwnerJobId}::uuid, 'import', ${historyOwnerJobId}::uuid,
          ${historicalQueueJobId}::uuid, ARRAY[${historicalQueueJobId}::uuid],
          'problem-package-import', ${historicalQueueJobId},
          '8181818181818181818181818181818181818181818181818181818181818181',
          3, 900000, clock_timestamp()
        )
      `);
      await transaction.execute(sql`
        UPDATE problem_package_job_outbox
        SET dispatch_attempts = 1,
            dispatch_claim_id = '85000000-0000-4000-8000-000000000005',
            dispatch_claimed_by = 'synthetic-history-dispatcher',
            dispatch_claimed_at = clock_timestamp(),
            dispatch_claim_expires_at = clock_timestamp() + interval '5 minutes',
            dispatch_claim_generation = delivery_generation,
            dispatch_claim_queue_job_id = queue_job_id,
            updated_at = clock_timestamp()
        WHERE job_id = ${historyOwnerJobId}::uuid
      `);
      await transaction.execute(sql`
        UPDATE problem_package_job_outbox
        SET dispatch_claim_id = NULL,
            dispatch_claimed_by = NULL,
            dispatch_claimed_at = NULL,
            dispatch_claim_expires_at = NULL,
            dispatch_claim_generation = NULL,
            dispatch_claim_queue_job_id = NULL,
            last_dispatched_at = clock_timestamp(),
            next_dispatch_at = NULL,
            updated_at = clock_timestamp()
        WHERE job_id = ${historyOwnerJobId}::uuid
      `);
      await transaction.execute(sql`
        UPDATE problem_package_job_outbox
        SET delivery_generation = delivery_generation + 1,
            queue_job_id = ${replacementQueueJobId}::uuid,
            queue_job_ids = array_append(queue_job_ids, ${replacementQueueJobId}::uuid),
            queue_idempotency_key = ${replacementQueueJobId},
            dispatch_attempts = 0,
            last_dispatched_at = NULL,
            next_dispatch_at = clock_timestamp(),
            updated_at = clock_timestamp()
        WHERE job_id = ${historyOwnerJobId}::uuid
      `);
      rotationReady.resolve();
      await releaseRotation.promise;
    });
    historyOwnerTransaction.then(undefined, rotationReady.reject);
    await rotationReady.promise;

    const blockedBackend = createDeferred<number>();
    const blockedHistoryTransaction = concurrencyDatabase.transaction(async (transaction) => {
      const backend = await transaction.query<{ pid: number }>(sql`
        SELECT pg_backend_pid()::integer AS pid
      `);
      const backendProcessId = backend[0]?.pid;
      if (backend.length !== 1 || backendProcessId === undefined) {
        throw new Error("未取得并发历史身份测试的数据库进程号。");
      }
      blockedBackend.resolve(backendProcessId);
      await transaction.execute(sql`
        INSERT INTO problem_package_job_outbox (
          job_id, job_kind, import_job_id, queue_job_id, queue_job_ids,
          queue_idempotency_scope, queue_idempotency_key, queue_request_digest,
          max_attempts, timeout_ms, next_dispatch_at
        ) VALUES (
          ${blockedHistoryJobId}::uuid, 'import', ${blockedHistoryJobId}::uuid,
          ${historicalQueueJobId}::uuid, ARRAY[${historicalQueueJobId}::uuid],
          'problem-package-import', ${historicalQueueJobId},
          '9292929292929292929292929292929292929292929292929292929292929292',
          3, 900000, clock_timestamp()
        )
      `);
    });
    blockedHistoryTransaction.then(undefined, blockedBackend.reject);
    let advisoryWaitError: unknown;
    try {
      const blockedBackendProcessId = await blockedBackend.promise;
      await waitForOutboxIdentityAdvisoryWait(
        concurrencyDatabase,
        blockedBackendProcessId
      );
    } catch (error) {
      advisoryWaitError = error;
    } finally {
      releaseRotation.resolve();
    }
    const historicalConcurrency = await Promise.allSettled([
      historyOwnerTransaction,
      blockedHistoryTransaction
    ]);
    if (advisoryWaitError !== undefined) throw advisoryWaitError;
    expect(historicalConcurrency[0]?.status).toBe("fulfilled");
    const blockedHistoricalResult = historicalConcurrency[1];
    if (
      blockedHistoricalResult?.status !== "rejected"
      || !databaseErrorIncludes(
        blockedHistoricalResult.reason,
        "PP_JOB_OUTBOX_DELIVERY_IDENTITY_GLOBALLY_REUSED"
      )
    ) {
      throw new Error("等待事务锁后的历史队列身份未被拒绝。");
    }
    const historicalConcurrencyState = await database.query<{
      current_queue_job_id: string;
      historical_count: number;
      blocked_count: number;
    }>(sql`
      SELECT queue_job_id::text AS current_queue_job_id,
             cardinality(queue_job_ids)::integer AS historical_count,
             (SELECT count(*)::integer
              FROM problem_package_job_outbox
              WHERE job_id = ${blockedHistoryJobId}::uuid) AS blocked_count
      FROM problem_package_job_outbox
      WHERE job_id = ${historyOwnerJobId}::uuid
    `);
    expect(historicalConcurrencyState).toEqual([{
      current_queue_job_id: replacementQueueJobId,
      historical_count: 2,
      blocked_count: 0
    }]);

    await expectDatabaseError(concurrencyDatabase.transaction(async (transaction) => {
      await transaction.execute(sql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ`);
      await transaction.query(sql`SELECT count(*) FROM problem_package_job_outbox`);
      await transaction.execute(sql`
        INSERT INTO problem_package_job_outbox (
          job_id, job_kind, import_job_id, queue_job_id, queue_job_ids,
          queue_idempotency_scope, queue_idempotency_key, queue_request_digest,
          max_attempts, timeout_ms, next_dispatch_at
        ) VALUES (
          '85000000-0000-4000-8000-000000000006', 'import',
          '85000000-0000-4000-8000-000000000006',
          '85000000-0000-4000-8000-000000000007',
          ARRAY['85000000-0000-4000-8000-000000000007'::uuid],
          'problem-package-import', '85000000-0000-4000-8000-000000000007',
          'a3a3a3a3a3a3a3a3a3a3a3a3a3a3a3a3a3a3a3a3a3a3a3a3a3a3a3a3a3a3a3a3',
          3, 900000, clock_timestamp()
        )
      `);
    }), "PP_JOB_OUTBOX_IDENTITY_ISOLATION_UNSUPPORTED");
    await expectDatabaseError(concurrencyDatabase.transaction(async (transaction) => {
      await transaction.execute(sql`SET TRANSACTION ISOLATION LEVEL SERIALIZABLE`);
      await transaction.query(sql`SELECT count(*) FROM problem_package_job_outbox`);
      await transaction.execute(sql`
        INSERT INTO problem_package_job_outbox (
          job_id, job_kind, import_job_id, queue_job_id, queue_job_ids,
          queue_idempotency_scope, queue_idempotency_key, queue_request_digest,
          max_attempts, timeout_ms, next_dispatch_at
        ) VALUES (
          '85000000-0000-4000-8000-000000000008', 'import',
          '85000000-0000-4000-8000-000000000008',
          '85000000-0000-4000-8000-000000000009',
          ARRAY['85000000-0000-4000-8000-000000000009'::uuid],
          'problem-package-import', '85000000-0000-4000-8000-000000000009',
          'b4b4b4b4b4b4b4b4b4b4b4b4b4b4b4b4b4b4b4b4b4b4b4b4b4b4b4b4b4b4b4b4',
          3, 900000, clock_timestamp()
        )
      `);
    }), "PP_JOB_OUTBOX_IDENTITY_ISOLATION_UNSUPPORTED");
    const repeatableReadLeaseUpdate = await concurrencyDatabase.transaction(
      async (transaction) => {
        await transaction.execute(sql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ`);
        await transaction.query(sql`SELECT count(*) FROM problem_package_job_outbox`);
        await transaction.execute(sql`
          UPDATE problem_package_job_outbox
          SET dispatch_attempts = dispatch_attempts + 1,
              dispatch_claim_id = '85000000-0000-4000-8000-000000000010',
              dispatch_claimed_by = 'synthetic-rr-dispatcher',
              dispatch_claimed_at = clock_timestamp(),
              dispatch_claim_expires_at = clock_timestamp() + interval '5 minutes',
              dispatch_claim_generation = delivery_generation,
              dispatch_claim_queue_job_id = queue_job_id,
              updated_at = clock_timestamp()
          WHERE job_id = ${historyOwnerJobId}::uuid
        `);
        return transaction.query<{
          dispatch_claim_id: string;
          dispatch_claim_generation: number;
          dispatch_claim_queue_job_id: string;
        }>(sql`
          UPDATE problem_package_job_outbox
          SET dispatch_claim_expires_at = dispatch_claim_expires_at + interval '1 minute',
              updated_at = clock_timestamp()
          WHERE job_id = ${historyOwnerJobId}::uuid
          RETURNING dispatch_claim_id::text AS dispatch_claim_id,
                    dispatch_claim_generation,
                    dispatch_claim_queue_job_id::text AS dispatch_claim_queue_job_id
        `);
      }
    );
    expect(repeatableReadLeaseUpdate).toEqual([{
      dispatch_claim_id: "85000000-0000-4000-8000-000000000010",
      dispatch_claim_generation: 2,
      dispatch_claim_queue_job_id: replacementQueueJobId
    }]);
    await concurrencyDatabase.execute(sql`
      UPDATE problem_package_job_outbox
      SET dispatch_claim_id = NULL,
          dispatch_claimed_by = NULL,
          dispatch_claimed_at = NULL,
          dispatch_claim_expires_at = NULL,
          dispatch_claim_generation = NULL,
          dispatch_claim_queue_job_id = NULL,
          last_dispatched_at = clock_timestamp(),
          next_dispatch_at = NULL,
          updated_at = clock_timestamp()
      WHERE job_id = ${historyOwnerJobId}::uuid
    `);
    await expectDatabaseError(concurrencyDatabase.transaction(async (transaction) => {
      await transaction.execute(sql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ`);
      await transaction.query(sql`SELECT count(*) FROM problem_package_job_outbox`);
      await transaction.execute(sql`
        UPDATE problem_package_job_outbox
        SET delivery_generation = delivery_generation + 1,
            queue_job_id = '85000000-0000-4000-8000-000000000011',
            queue_job_ids = array_append(
              queue_job_ids,
              '85000000-0000-4000-8000-000000000011'::uuid
            ),
            queue_idempotency_key = '85000000-0000-4000-8000-000000000011',
            dispatch_attempts = 0,
            last_dispatched_at = NULL,
            next_dispatch_at = clock_timestamp(),
            updated_at = clock_timestamp()
        WHERE job_id = ${historyOwnerJobId}::uuid
      `);
    }), "PP_JOB_OUTBOX_IDENTITY_ISOLATION_UNSUPPORTED");

    const sharedConcurrentQueueJobId = "84000000-0000-4000-8000-000000000001";
    const concurrentSameIdentity = await Promise.allSettled([
      insertConcurrentOutbox(
        "84000000-0000-4000-8000-000000000002",
        sharedConcurrentQueueJobId,
        "1212121212121212121212121212121212121212121212121212121212121212"
      ),
      insertConcurrentOutbox(
        "84000000-0000-4000-8000-000000000003",
        sharedConcurrentQueueJobId,
        "3434343434343434343434343434343434343434343434343434343434343434"
      )
    ]);
    expect(concurrentSameIdentity.map(({ status }) => status).sort()).toEqual([
      "fulfilled",
      "rejected"
    ]);
    const rejectedConcurrentIdentity = concurrentSameIdentity.find(
      (result): result is PromiseRejectedResult => result.status === "rejected"
    );
    if (
      rejectedConcurrentIdentity === undefined
      || !databaseErrorIncludes(
        rejectedConcurrentIdentity.reason,
        "PP_JOB_OUTBOX_DELIVERY_IDENTITY_GLOBALLY_REUSED"
      )
    ) {
      throw new Error("并发重复队列身份未被全局历史检查拒绝。");
    }
    const sharedIdentityCount = await database.query<{ count: number }>(sql`
      SELECT count(*)::integer AS count
      FROM problem_package_job_outbox
      WHERE ${sharedConcurrentQueueJobId}::uuid = ANY(queue_job_ids)
    `);
    expect(sharedIdentityCount).toEqual([{ count: 1 }]);

    await Promise.all([
      insertConcurrentOutbox(
        "84000000-0000-4000-8000-000000000006",
        "84000000-0000-4000-8000-000000000004",
        "5656565656565656565656565656565656565656565656565656565656565656"
      ),
      insertConcurrentOutbox(
        "84000000-0000-4000-8000-000000000007",
        "84000000-0000-4000-8000-000000000005",
        "7878787878787878787878787878787878787878787878787878787878787878"
      )
    ]);
    const distinctIdentityCount = await database.query<{ count: number }>(sql`
      SELECT count(*)::integer AS count
      FROM problem_package_job_outbox
      WHERE queue_job_id IN (
        '84000000-0000-4000-8000-000000000004',
        '84000000-0000-4000-8000-000000000005'
      )
    `);
    expect(distinctIdentityCount).toEqual([{ count: 2 }]);

    const migrationState = await database.query<{
      migration_count: number;
      sequence_value: string;
      sequence_called: boolean;
    }>(sql`
      SELECT
        (SELECT count(*)::integer FROM drizzle.__drizzle_migrations) AS migration_count,
        last_value::text AS sequence_value,
        is_called AS sequence_called
      FROM drizzle.__drizzle_migrations_id_seq
    `);
    expect(migrationState).toEqual([{
      migration_count: 18,
      sequence_value: "18",
      sequence_called: true
    }]);
    const indexes = await database.query<{ indexname: string }>(sql`
      SELECT indexname
      FROM pg_indexes
      WHERE schemaname = 'public'
        AND tablename = 'problem_package_job_outbox'
      ORDER BY indexname
    `);
    expect(indexes.map(({ indexname }) => indexname)).toEqual([
      "problem_package_job_outbox_execution_expiry_idx",
      "problem_package_job_outbox_export_uq",
      "problem_package_job_outbox_import_uq",
      "problem_package_job_outbox_pkey",
      "problem_package_job_outbox_queue_identity_uq",
      "problem_package_job_outbox_queue_job_uq",
      "problem_package_job_outbox_ready_idx"
    ]);
  }, 60_000);
});

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

async function expectDatabaseError(
  operation: Promise<unknown>,
  expectedCode: string
): Promise<void> {
  try {
    await operation;
  } catch (error) {
    if (databaseErrorIncludes(error, expectedCode)) return;
    throw new Error(`未观察到固定数据库错误码 ${expectedCode}。`);
  }
  throw new Error(`数据库操作未返回固定错误码 ${expectedCode}。`);
}

function databaseErrorIncludes(error: unknown, expectedCode: string): boolean {
  let current: unknown = error;
  const seen = new Set<unknown>();
  while (typeof current === "object" && current !== null && !seen.has(current)) {
    seen.add(current);
    if (
      "message" in current
      && typeof current.message === "string"
      && current.message.includes(expectedCode)
    ) {
      return true;
    }
    current = "cause" in current ? current.cause : undefined;
  }
  return false;
}

interface Deferred<T> {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
  readonly reject: (reason: unknown) => void;
}

function createDeferred<T>(): Deferred<T> {
  let resolvePromise: ((value: T) => void) | undefined;
  let rejectPromise: ((reason: unknown) => void) | undefined;
  const promise = new Promise<T>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  if (resolvePromise === undefined || rejectPromise === undefined) {
    throw new Error("未能创建测试同步信号。");
  }
  return {
    promise,
    resolve: resolvePromise,
    reject: rejectPromise
  };
}

async function waitForOutboxIdentityAdvisoryWait(
  database: PostgresDatabaseHandle,
  backendProcessId: number
): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const waiting = await database.query<{ count: number }>(sql`
      SELECT count(*)::integer AS count
      FROM pg_catalog.pg_locks
      WHERE pid = ${backendProcessId}
        AND locktype = 'advisory'
        AND classid = 1431453002::oid
        AND objid = 1651666805::oid
        AND objsubid = 2
        AND granted = false
    `);
    if (waiting[0]?.count === 1) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("并发身份登记未观察到等待专用事务锁。");
}
