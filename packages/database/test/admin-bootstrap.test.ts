import { sql } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";
import {
  completeAdminBootstrap,
  createLocalDatabase,
  type LocalDatabaseHandle,
  migrateDatabase,
  openAdminBootstrapForFreshSeed,
  readAdminBootstrapState,
  seedCoreDatabase,
  tryAcquireAdminBootstrapMigrationLease,
} from "../src";

const syntheticPasswordHash =
  "$argon2id$v=19$m=19456,t=2,p=1$c3ludGhldGljc2FsdA$c3ludGhldGljaGFzaA";
const administratorInput = Object.freeze({
  normalizedEmail: "administrator@example.test",
  passwordHash: syntheticPasswordHash,
});
const openDatabases: LocalDatabaseHandle[] = [];

afterEach(async () => {
  await Promise.all(openDatabases.splice(0).map((database) => database.close()));
});

describe("one-time first administrator creation", () => {
  it("atomically creates a separate human administrator and completes the marker", async () => {
    const database = await createOpenBootstrapDatabase();

    await expect(completeAdminBootstrap(database, administratorInput)).resolves.toBe("completed");
    await expect(readAdminBootstrapState(database)).resolves.toMatchObject({
      status: "completed",
    });

    const root = await database.query<{
      nickname: string;
      password_hash: string | null;
      password_changed_at: string | null;
      email_count: number;
      identity_count: number;
      identifier_count: number;
      session_count: number;
      token_count: number;
      verification_count: number;
    }>(sql`
      SELECT
        nickname,
        password_hash,
        password_changed_at,
        (SELECT count(*)::integer FROM user_emails WHERE user_id = 0) AS email_count,
        (SELECT count(*)::integer FROM external_identities WHERE user_id = 0) AS identity_count,
        (SELECT count(*)::integer FROM user_identifiers WHERE user_id = 0) AS identifier_count,
        (SELECT count(*)::integer FROM sessions WHERE user_id = 0) AS session_count,
        (SELECT count(*)::integer FROM api_tokens WHERE user_id = 0) AS token_count,
        (
          SELECT count(*)::integer
          FROM email_verification_tokens
          WHERE user_id = 0
        ) AS verification_count
      FROM users
      WHERE id = 0
    `);
    expect(root).toEqual([
      {
        nickname: "root",
        password_hash: null,
        password_changed_at: null,
        email_count: 0,
        identity_count: 0,
        identifier_count: 0,
        session_count: 0,
        token_count: 0,
        verification_count: 0,
      },
    ]);

    const administrators = await database.query<{
      id: string;
      nickname: string;
      account_type: string;
      password_hash: string;
      password_changed: boolean;
      address: string;
      normalized_address: string;
      is_primary: boolean;
      verified: boolean;
      role_key: string;
      role_is_built_in: boolean;
      granted_by_user_id: string;
    }>(sql`
      SELECT
        account.id::text AS id,
        account.nickname,
        account.account_type::text AS account_type,
        account.password_hash,
        account.password_changed_at IS NOT NULL AS password_changed,
        email.address,
        email.normalized_address,
        email.is_primary,
        email.verified_at IS NOT NULL AS verified,
        role.key AS role_key,
        role.is_built_in AS role_is_built_in,
        membership.granted_by_user_id::text AS granted_by_user_id
      FROM users account
      JOIN user_emails email ON email.user_id = account.id
      JOIN role_memberships membership
        ON membership.user_id = account.id AND membership.revoked_at IS NULL
      JOIN roles role ON role.id = membership.role_id
      WHERE account.id <> 0
    `);
    expect(administrators).toHaveLength(1);
    expect(administrators[0]).toMatchObject({
      nickname: "系统管理员",
      account_type: "human",
      password_hash: syntheticPasswordHash,
      password_changed: true,
      address: administratorInput.normalizedEmail,
      normalized_address: administratorInput.normalizedEmail,
      is_primary: true,
      verified: true,
      role_key: "system_administrator",
      role_is_built_in: true,
      granted_by_user_id: "0",
    });

    const audit = await database.query<{
      actor_user_id: string | null;
      subject_matches: boolean;
      action: string;
      object_type: string;
      result: string;
      reason_code: string | null;
      metadata: unknown;
    }>(sql`
      SELECT
        actor_user_id::text AS actor_user_id,
        subject_user_id = (SELECT id FROM users WHERE id <> 0) AS subject_matches,
        action,
        object_type,
        result::text AS result,
        reason_code,
        metadata
      FROM audit_events
    `);
    expect(audit).toEqual([
      {
        actor_user_id: null,
        subject_matches: true,
        action: "admin.bootstrap.complete",
        object_type: "user",
        result: "success",
        reason_code: null,
        metadata: { channel: "server_tty", roleKey: "system_administrator" },
      },
    ]);
  });

  it("allows only one success across repeated calls", async () => {
    const database = await createOpenBootstrapDatabase();

    await expect(completeAdminBootstrap(database, administratorInput)).resolves.toBe("completed");
    await expect(completeAdminBootstrap(database, administratorInput)).resolves.toBe("not_open");
    await expect(countBootstrapWrites(database)).resolves.toEqual({
      users: 1,
      emails: 1,
      memberships: 1,
      audits: 1,
    });
  });

  it("allows only one success across concurrent calls", async () => {
    const database = await createOpenBootstrapDatabase();

    const results = await Promise.all([
      completeAdminBootstrap(database, administratorInput),
      completeAdminBootstrap(database, administratorInput),
    ]);
    expect(results.sort()).toEqual(["completed", "not_open"]);
    await expect(countBootstrapWrites(database)).resolves.toEqual({
      users: 1,
      emails: 1,
      memberships: 1,
      audits: 1,
    });
  });

  it("refuses blocked state and a tampered root baseline without writing", async () => {
    const blocked = createDatabase();
    await migrateDatabase(blocked);
    await seedCoreDatabase(blocked);
    await expect(completeAdminBootstrap(blocked, administratorInput)).resolves.toBe("not_open");

    const tampered = await createOpenBootstrapDatabase();
    await tampered.execute(sql`
      UPDATE users
      SET password_hash = ${syntheticPasswordHash}, password_changed_at = now()
      WHERE id = 0
    `);
    await expect(completeAdminBootstrap(tampered, administratorInput)).resolves.toBe(
      "baseline_mismatch",
    );
    await expect(countBootstrapWrites(tampered)).resolves.toEqual({
      users: 0,
      emails: 0,
      memberships: 0,
      audits: 0,
    });
    expect((await readAdminBootstrapState(tampered)).status).toBe("open");
  });

  it("refuses a changed system administrator role", async () => {
    const database = await createOpenBootstrapDatabase();
    await database.execute(sql`
      UPDATE roles SET is_built_in = false WHERE key = 'system_administrator'
    `);

    await expect(completeAdminBootstrap(database, administratorInput)).resolves.toBe(
      "baseline_mismatch",
    );
    await expect(countBootstrapWrites(database)).resolves.toEqual({
      users: 0,
      emails: 0,
      memberships: 0,
      audits: 0,
    });
  });

  it("refuses an existing email conflict before creating another account", async () => {
    const database = await createOpenBootstrapDatabase();
    await database.execute(sql`
      INSERT INTO user_emails (
        id, user_id, address, normalized_address, is_primary, verified_at
      ) VALUES (
        'a0000000-0000-4000-8000-000000000001',
        0,
        ${administratorInput.normalizedEmail},
        ${administratorInput.normalizedEmail},
        true,
        now()
      )
    `);

    await expect(completeAdminBootstrap(database, administratorInput)).resolves.toBe(
      "baseline_mismatch",
    );
    await expect(countBootstrapWrites(database)).resolves.toEqual({
      users: 0,
      emails: 1,
      memberships: 0,
      audits: 0,
    });
  });

  it("rolls back an audit failure and can retry after PostgreSQL-style sequence gaps", async () => {
    const database = await createOpenBootstrapDatabase();
    await database.execute(sql`
      CREATE FUNCTION reject_bootstrap_audit() RETURNS trigger
      LANGUAGE plpgsql AS $$
      BEGIN
        RAISE EXCEPTION 'synthetic audit failure';
      END;
      $$
    `);
    await database.execute(sql`
      CREATE TRIGGER reject_bootstrap_audit
      BEFORE INSERT ON audit_events
      FOR EACH ROW EXECUTE FUNCTION reject_bootstrap_audit()
    `);

    await expect(completeAdminBootstrap(database, administratorInput)).rejects.toBeDefined();
    await expect(countBootstrapWrites(database)).resolves.toEqual({
      users: 0,
      emails: 0,
      memberships: 0,
      audits: 0,
    });
    expect((await readAdminBootstrapState(database)).status).toBe("open");

    await database.execute(sql`DROP TRIGGER reject_bootstrap_audit ON audit_events`);
    await database.execute(sql`DROP FUNCTION reject_bootstrap_audit()`);
    await expect(completeAdminBootstrap(database, administratorInput)).resolves.toBe("completed");
  });

  it("rolls back every write when the final marker update fails", async () => {
    const database = await createOpenBootstrapDatabase();
    await database.execute(sql`
      CREATE FUNCTION reject_bootstrap_completion() RETURNS trigger
      LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.status = 'completed' THEN
          RAISE EXCEPTION 'synthetic marker failure';
        END IF;
        RETURN NEW;
      END;
      $$
    `);
    await database.execute(sql`
      CREATE TRIGGER reject_bootstrap_completion
      BEFORE UPDATE ON admin_bootstrap_state
      FOR EACH ROW EXECUTE FUNCTION reject_bootstrap_completion()
    `);

    await expect(completeAdminBootstrap(database, administratorInput)).rejects.toBeDefined();
    await expect(countBootstrapWrites(database)).resolves.toEqual({
      users: 0,
      emails: 0,
      memberships: 0,
      audits: 0,
    });
    expect((await readAdminBootstrapState(database)).status).toBe("open");

    await database.execute(sql`
      DROP TRIGGER reject_bootstrap_completion ON admin_bootstrap_state
    `);
    await database.execute(sql`DROP FUNCTION reject_bootstrap_completion()`);
    await expect(completeAdminBootstrap(database, administratorInput)).resolves.toBe("completed");
  });

  it("rejects malformed internal inputs before opening a transaction", async () => {
    const database = await createOpenBootstrapDatabase();

    await expect(
      completeAdminBootstrap(database, {
        normalizedEmail: "not-an-email",
        passwordHash: "plain text",
      }),
    ).rejects.toThrow("URMOTIV_ADMIN_BOOTSTRAP_INPUT_INVALID");
    expect((await readAdminBootstrapState(database)).status).toBe("open");
  });
});

function createDatabase(): LocalDatabaseHandle {
  const database = createLocalDatabase();
  openDatabases.push(database);
  return database;
}

async function createOpenBootstrapDatabase(): Promise<LocalDatabaseHandle> {
  const database = createDatabase();
  const lease = await tryAcquireAdminBootstrapMigrationLease(database);
  if (lease === undefined) {
    throw new Error("测试未取得迁移锁。");
  }
  await migrateDatabase(database);
  await seedCoreDatabase(database);
  const opened = await openAdminBootstrapForFreshSeed(database, lease);
  if (opened !== "opened") {
    throw new Error("测试未打开初始化标记。");
  }
  return database;
}

async function countBootstrapWrites(database: LocalDatabaseHandle): Promise<{
  users: number;
  emails: number;
  memberships: number;
  audits: number;
}> {
  const rows = await database.query<{
    users: number;
    emails: number;
    memberships: number;
    audits: number;
  }>(sql`
    SELECT
      (SELECT count(*)::integer FROM users WHERE id <> 0) AS users,
      (SELECT count(*)::integer FROM user_emails) AS emails,
      (
        SELECT count(*)::integer
        FROM role_memberships membership
        JOIN roles role ON role.id = membership.role_id
        WHERE membership.user_id <> 0 AND role.key = 'system_administrator'
      ) AS memberships,
      (
        SELECT count(*)::integer
        FROM audit_events
        WHERE action = 'admin.bootstrap.complete'
      ) AS audits
  `);
  const row = rows[0];
  if (rows.length !== 1 || row === undefined) {
    throw new Error("测试无法读取初始化写入计数。");
  }
  return row;
}
