import { sql } from "drizzle-orm";

import { hashPassword } from "@urmotiv/auth";
import {
  completeAdminBootstrap,
  createLocalDatabase,
  type LocalDatabaseHandle,
  migrateDatabase,
  openAdminBootstrapForFreshSeed,
  seedCoreDatabase,
  tryAcquireAdminBootstrapMigrationLease,
} from "@urmotiv/database";
import { afterEach, describe, expect, it } from "vitest";
import {
  adminBootstrapStartupErrors,
  assertAdminBootstrapReadyForServer,
} from "../src/bootstrap-admin";

const openDatabases: LocalDatabaseHandle[] = [];

afterEach(async () => {
  await Promise.all(openDatabases.splice(0).map((database) => database.close()));
});

describe("API administrator bootstrap startup gate", () => {
  it("allows a blocked legacy-compatible state", async () => {
    const database = createDatabase();
    await migrateDatabase(database);

    await expect(assertAdminBootstrapReadyForServer(database)).resolves.toBeUndefined();
  });

  it("refuses an open state with one fixed error", async () => {
    const database = await createOpenBootstrapDatabase();

    await expect(assertAdminBootstrapReadyForServer(database)).rejects.toThrow(
      adminBootstrapStartupErrors.required,
    );
  });

  it("allows a completed state", async () => {
    const database = await createOpenBootstrapDatabase();
    await completeAdminBootstrap(database, {
      normalizedEmail: "administrator@example.test",
      passwordHash: await hashPassword("synthetic-long-password"),
    });

    await expect(assertAdminBootstrapReadyForServer(database)).resolves.toBeUndefined();
  });

  it("rejects non-seed system settings during fresh bootstrap", async () => {
    const database = createDatabase();
    const lease = await tryAcquireAdminBootstrapMigrationLease(database);
    if (lease === undefined) throw new Error("测试未取得迁移锁。");
    await migrateDatabase(database);
    await seedCoreDatabase(database);
    await database.execute(sql`
      UPDATE system_settings
      SET public_site_url = 'unexpected'
      WHERE id = 'global'
    `);

    await expect(openAdminBootstrapForFreshSeed(database, lease)).resolves.toBe(
      "baseline_mismatch",
    );
  });

  it("maps a missing marker or unreadable database to one fixed error", async () => {
    const missing = createDatabase();
    await expect(assertAdminBootstrapReadyForServer(missing)).rejects.toThrow(
      adminBootstrapStartupErrors.invalid,
    );

    const unreadable = {
      query: async () => {
        throw new Error("private database detail");
      },
    } as unknown as LocalDatabaseHandle;
    await expect(assertAdminBootstrapReadyForServer(unreadable)).rejects.toThrow(
      adminBootstrapStartupErrors.invalid,
    );

    const malformed = {
      query: async () => [{ status: "open", opened_at: null, completed_at: null }],
    } as unknown as LocalDatabaseHandle;
    await expect(assertAdminBootstrapReadyForServer(malformed)).rejects.toThrow(
      adminBootstrapStartupErrors.invalid,
    );
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
  if (lease === undefined) throw new Error("测试未取得迁移锁。");
  await migrateDatabase(database);
  await seedCoreDatabase(database);
  if ((await openAdminBootstrapForFreshSeed(database, lease)) !== "opened") {
    throw new Error("测试未打开初始化标记。");
  }
  return database;
}
