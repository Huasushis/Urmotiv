import { sql } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";
import {
  completeAdminBootstrap,
  createLocalDatabase,
  type LocalDatabaseHandle,
  migrateDatabase,
  openAdminBootstrapForFreshSeed,
  recoverAdminCredentials,
  seedCoreDatabase,
  tryAcquireAdminBootstrapMigrationLease
} from "../src";

const replacementHash =
  "$argon2id$v=19$m=19456,t=2,p=1$c3ludGhldGljc2FsdA$c3ludGhldGljaGFzaA";
const openDatabases: LocalDatabaseHandle[] = [];

afterEach(async () => {
  await Promise.all(openDatabases.splice(0).map((database) => database.close()));
});

describe("administrator credential recovery", () => {
  it("updates only the eligible administrator, revokes sessions, increments auth revision, and audits", async () => {
    const database = await createCompletedDatabase();
    const administrator = await database.query<{ id: string; auth_revision: number }>(sql`
      SELECT id::text AS id, auth_revision
      FROM users
      WHERE id <> 0
    `);
    const userId = administrator[0]?.id;
    if (userId === undefined) throw new Error("synthetic administrator missing");
    await database.execute(sql`
      INSERT INTO sessions (
        id, token_digest, user_id, auth_revision, expires_at
      ) VALUES (
        'a0000000-0000-4000-8000-000000000001',
        repeat('a', 64),
        ${userId}::bigint,
        ${administrator[0]?.auth_revision},
        now() + interval '1 hour'
      )
    `);

    await expect(recoverAdminCredentials(database, { passwordHash: replacementHash })).resolves.toEqual({
      status: "completed",
      userId
    });

    const stored = await database.query<{
      password_hash: string | null;
      auth_revision: number;
      disabled_at: string | null;
    }>(sql`
      SELECT password_hash, auth_revision, disabled_at
      FROM users
      WHERE id = ${userId}::bigint
    `);
    expect(stored).toEqual([{
      password_hash: replacementHash,
      auth_revision: (administrator[0]?.auth_revision ?? 0) + 1,
      disabled_at: null
    }]);
    await expect(database.query<{ active: number; revoked: number }>(sql`
      SELECT
        count(*) FILTER (WHERE revoked_at IS NULL)::integer AS active,
        count(*) FILTER (WHERE revoked_at IS NOT NULL)::integer AS revoked
      FROM sessions
      WHERE user_id = ${userId}::bigint
    `)).resolves.toEqual([{ active: 0, revoked: 1 }]);
    await expect(database.query<{ action: string; metadata: unknown }>(sql`
      SELECT action, metadata
      FROM audit_events
      WHERE action = 'admin.credentials.recover'
    `)).resolves.toEqual([{
      action: "admin.credentials.recover",
      metadata: { channel: "server_tty", credential: "local_password" }
    }]);
  });

  it("fails closed for zero or multiple eligible administrators and for invalid inputs", async () => {
    const database = await createCompletedDatabase();
    await expect(recoverAdminCredentials(database, { passwordHash: "plain text" })).resolves.toBe(
      "input_invalid"
    );
    await database.execute(sql`
      UPDATE role_memberships
      SET revoked_at = now(), revoked_by_user_id = 0
      WHERE user_id <> 0
    `);
    await expect(recoverAdminCredentials(database, { passwordHash: replacementHash })).resolves.toBe(
      "candidate_invalid"
    );
    const second = await database.query<{ id: string; role_id: string }>(sql`
      SELECT role.id::text AS id, role.id::text AS role_id
      FROM roles role
      WHERE role.key = 'system_administrator'
    `);
    await database.execute(sql`
      UPDATE role_memberships
      SET revoked_at = NULL, revoked_by_user_id = NULL
      WHERE user_id <> 0
    `);

    const roleId = second[0]?.role_id;
    if (roleId === undefined) throw new Error("synthetic administrator role missing");
    await database.execute(sql`
      INSERT INTO users (nickname, account_type, password_hash)
      VALUES ('第二个合成管理员', 'human', ${replacementHash})
    `);
    const secondUser = await database.query<{ id: string }>(sql`
      SELECT id::text AS id
      FROM users
      WHERE nickname = '第二个合成管理员'
    `);
    const secondUserId = secondUser[0]?.id;
    if (secondUserId === undefined) throw new Error("synthetic second administrator missing");
    await database.execute(sql`
      INSERT INTO role_memberships (
        id, user_id, role_id, granted_by_user_id, reason
      ) VALUES (
        'a0000000-0000-4000-8000-000000000002',
        ${secondUserId}::bigint,
        ${roleId}::uuid,
        0,
        '合成并发候选'
      )
    `);
    await expect(recoverAdminCredentials(database, { passwordHash: replacementHash })).resolves.toBe(
      "candidate_invalid"
    );
  });

  it("rejects disabled, root, robot, service, and non-admin accounts", async () => {
    const database = await createCompletedDatabase();
    const roleRows = await database.query<{ role_id: string }>(sql`
      SELECT id::text AS role_id
      FROM roles
      WHERE key = 'system_administrator'
    `);
    const roleId = roleRows[0]?.role_id;
    if (roleId === undefined) throw new Error("synthetic administrator role missing");
    await database.execute(sql`
      UPDATE users
      SET disabled_at = now()
      WHERE id <> 0
    `);
    await database.execute(sql`
      UPDATE users
      SET password_hash = ${replacementHash}
      WHERE id = 0
    `);
    await database.execute(sql`
      INSERT INTO role_memberships (
        id, user_id, role_id, granted_by_user_id, reason
      ) VALUES (
        'a0000000-0000-4000-8000-000000000003',
        0,
        ${roleId}::uuid,
        0,
        '合成 root 拒绝'
      )
    `);
    for (const [accountType, nickname, membershipId] of [
      ["robot", "合成机器人", "a0000000-0000-4000-8000-000000000004"],
      ["service", "合成服务", "a0000000-0000-4000-8000-000000000005"],
      ["human", "合成非管理员", undefined]
    ] as const) {
      const inserted = await database.query<{ id: string }>(sql`
        INSERT INTO users (nickname, account_type, password_hash)
        VALUES (${nickname}, ${accountType}::account_type, ${replacementHash})
        RETURNING id::text AS id
      `);
      const userId = inserted[0]?.id;
      if (userId === undefined) throw new Error("synthetic invalid account missing");
      if (membershipId !== undefined) {
        await database.execute(sql`
          INSERT INTO role_memberships (
            id, user_id, role_id, granted_by_user_id, reason
          ) VALUES (
            ${membershipId}::uuid,
            ${userId}::bigint,
            ${roleId}::uuid,
            0,
            '合成非人类拒绝'
          )
        `);
      }
    }
    await expect(recoverAdminCredentials(database, { passwordHash: replacementHash })).resolves.toBe(
      "candidate_invalid"
    );
  });

  it("rolls back the password, revision, sessions, and audit when audit insertion fails", async () => {
    const database = await createCompletedDatabase();
    const before = await database.query<{ id: string; password_hash: string; auth_revision: number }>(sql`
      SELECT id::text AS id, password_hash, auth_revision
      FROM users
      WHERE id <> 0
    `);
    const userId = before[0]?.id;
    if (userId === undefined) throw new Error("synthetic administrator missing");
    await database.execute(sql`
      CREATE FUNCTION reject_recovery_audit() RETURNS trigger
      LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.action = 'admin.credentials.recover' THEN
          RAISE EXCEPTION 'synthetic recovery audit failure';
        END IF;
        RETURN NEW;
      END;
      $$
    `);
    await database.execute(sql`
      CREATE TRIGGER reject_recovery_audit
      BEFORE INSERT ON audit_events
      FOR EACH ROW EXECUTE FUNCTION reject_recovery_audit()
    `);

    await expect(recoverAdminCredentials(database, { passwordHash: replacementHash })).rejects.toBeDefined();

    await expect(database.query<{ password_hash: string; auth_revision: number }>(sql`
      SELECT password_hash, auth_revision
      FROM users
      WHERE id = ${userId}::bigint
    `)).resolves.toEqual([{
      password_hash: before[0]?.password_hash,
      auth_revision: before[0]?.auth_revision
    }]);
    await expect(database.query<{ count: number }>(sql`
      SELECT count(*)::integer AS count
      FROM audit_events
      WHERE action = 'admin.credentials.recover'
    `)).resolves.toEqual([{ count: 0 }]);

    await database.execute(sql`DROP TRIGGER reject_recovery_audit ON audit_events`);
    await database.execute(sql`DROP FUNCTION reject_recovery_audit()`);
  });
});

async function createCompletedDatabase(): Promise<LocalDatabaseHandle> {
  const database = createLocalDatabase();
  openDatabases.push(database);
  const lease = await tryAcquireAdminBootstrapMigrationLease(database);
  if (lease === undefined) throw new Error("synthetic migration lease unavailable");
  await migrateDatabase(database);
  await seedCoreDatabase(database);
  if ((await openAdminBootstrapForFreshSeed(database, lease)) !== "opened") {
    throw new Error("synthetic bootstrap state did not open");
  }
  if ((await completeAdminBootstrap(database, {
    normalizedEmail: "administrator@example.test",
    passwordHash: replacementHash
  })) !== "completed") {
    throw new Error("synthetic administrator was not created");
  }
  return database;
}
