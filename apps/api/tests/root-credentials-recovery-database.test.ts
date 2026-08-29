import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { createLocalDatabase, migrateDatabase, recoverRootCredentials, seedCoreDatabase, type LocalDatabaseHandle } from "@urmotiv/database";
import { sql } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";

const oldHash = "$argon2id$v=19$m=19456,t=2,p=1$b2xkLXNhbHQ$b2xkLWhhc2g";
const newHash = "$argon2id$v=19$m=19456,t=2,p=1$bmV3LXNhbHQ$bmV3LWhhc2g";
const openDatabases: LocalDatabaseHandle[] = [];
let temporaryDirectory: string;

afterEach(async () => {
  await Promise.all(openDatabases.splice(0).map((database) => database.close()));
});

async function openDatabase(): Promise<LocalDatabaseHandle> {
  temporaryDirectory ??= await mkdtemp(join(tmpdir(), "urmotiv-root-recovery-"));
  const database = createLocalDatabase({ dataDirectory: join(temporaryDirectory, randomUUID()) });
  openDatabases.push(database);
  await migrateDatabase(database);
  await seedCoreDatabase(database);
  await database.execute(sql`
    UPDATE admin_bootstrap_state
    SET status = 'completed',
        opened_at = COALESCE(opened_at, now()),
        completed_at = now(),
        updated_at = now()
    WHERE singleton = true
  `);
  await database.execute(sql`
    UPDATE users SET password_hash = ${oldHash}, updated_at = now() WHERE id = 0
  `);
  await database.execute(sql`
    INSERT INTO users (id, nickname, account_type, password_hash)
    VALUES (42, 'fixture-target', 'human', ${oldHash})
    ON CONFLICT (id) DO UPDATE SET password_hash = EXCLUDED.password_hash, disabled_at = NULL
  `);
  await database.execute(sql`
    INSERT INTO sessions (id, token_digest, user_id, impersonator_user_id, auth_revision, expires_at)
    VALUES
      ('00000000-0000-4000-8000-000000000001', repeat('1', 64), 0, NULL, 1, now() + interval '1 hour'),
      ('00000000-0000-4000-8000-000000000002', repeat('2', 64), 42, 0, 1, now() + interval '1 hour'),
      ('00000000-0000-4000-8000-000000000003', repeat('3', 64), 42, NULL, 1, now() + interval '1 hour')
    ON CONFLICT (id) DO UPDATE SET revoked_at = NULL
  `);
  return database;
}

describe("root credential recovery database transaction", () => {
  it("updates user0, revokes root contexts, and audits in one transaction", async () => {
    const database = await openDatabase();
    await expect(recoverRootCredentials(database, { passwordHash: newHash })).resolves.toMatchObject({
      status: "completed",
      userId: "0",
      accountIdentifier: "root"
    });
    const root = await database.query<{ password_hash: string }>(sql`SELECT password_hash FROM users WHERE id = 0`);
    expect(root[0]?.password_hash).toBe(newHash);
    const sessions = await database.query<{ id: string; revoked_at: Date | null }>(sql`
      SELECT id::text AS id, revoked_at FROM sessions ORDER BY id
    `);
    expect(sessions.filter((row) => row.id !== "00000000-0000-4000-8000-000000000003").every((row) => row.revoked_at !== null)).toBe(true);
    expect(sessions.find((row) => row.id === "00000000-0000-4000-8000-000000000003")?.revoked_at).toBeNull();
    const audits = await database.query<{ count: string }>(sql`
      SELECT count(*)::text AS count FROM audit_events WHERE action = 'admin.root_credentials.recover' AND subject_user_id = 0
    `);
    expect(audits[0]?.count).toBe("1");
  });

  it("rolls back password, session revocation, and audit when the final write fails", async () => {
    const database = await openDatabase();
    await database.execute(sql`
      CREATE OR REPLACE FUNCTION fail_root_recovery_audit() RETURNS trigger
      LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.action = 'admin.root_credentials.recover' THEN
          RAISE EXCEPTION 'synthetic root audit failure';
        END IF;
        RETURN NEW;
      END;
      $$
    `);
    await database.execute(sql`
      CREATE TRIGGER fail_root_recovery_audit_trigger
      BEFORE INSERT ON audit_events
      FOR EACH ROW EXECUTE FUNCTION fail_root_recovery_audit()
    `);
    await expect(recoverRootCredentials(database, { passwordHash: newHash })).rejects.toThrow();
    const root = await database.query<{ password_hash: string }>(sql`SELECT password_hash FROM users WHERE id = 0`);
    expect(root[0]?.password_hash).toBe(oldHash);
    const sessions = await database.query<{ revoked: string }>(sql`
      SELECT count(*)::text AS revoked FROM sessions WHERE revoked_at IS NOT NULL
    `);
    expect(sessions[0]?.revoked).toBe("0");
    const audits = await database.query<{ count: string }>(sql`
      SELECT count(*)::text AS count FROM audit_events WHERE action = 'admin.root_credentials.recover'
    `);
    expect(audits[0]?.count).toBe("0");
  });
});
