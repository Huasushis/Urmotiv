import {
  createLocalDatabase,
  migrateDatabase,
  readAdminBootstrapState,
  seedCoreDatabase,
  type LocalDatabaseHandle
} from "@urmotiv/database";
import { sql } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";
import { runDeploymentDatabaseMigration } from "../src/deployment-migration";

const openDatabases: LocalDatabaseHandle[] = [];

function createDatabase(): LocalDatabaseHandle {
  const database = createLocalDatabase();
  openDatabases.push(database);
  return database;
}

afterEach(async () => {
  await Promise.all(openDatabases.splice(0).map((database) => database.close()));
});

describe("deployment database migration", () => {
  it("opens bootstrap only during the uninterrupted first migration of an empty database", async () => {
    const database = createDatabase();

    await expect(runDeploymentDatabaseMigration(database)).resolves.toEqual({
      adminBootstrapOpened: true
    });
    expect((await readAdminBootstrapState(database)).status).toBe("open");

    await expect(runDeploymentDatabaseMigration(database)).resolves.toEqual({
      adminBootstrapOpened: false
    });
    expect((await readAdminBootstrapState(database)).status).toBe("open");
  });

  it("leaves an already migrated seed-only database blocked", async () => {
    const database = createDatabase();
    await migrateDatabase(database);
    await seedCoreDatabase(database);

    await expect(runDeploymentDatabaseMigration(database)).resolves.toEqual({
      adminBootstrapOpened: false
    });
    await expect(readAdminBootstrapState(database)).resolves.toEqual({
      status: "blocked",
      openedAt: null,
      completedAt: null
    });
  });

  it("does not open when a non-system object existed before the first migration", async () => {
    const database = createDatabase();
    await database.execute(sql`
      CREATE FUNCTION unrelated_marker() RETURNS integer
      LANGUAGE sql AS 'SELECT 1'
    `);

    await expect(runDeploymentDatabaseMigration(database)).resolves.toEqual({
      adminBootstrapOpened: false
    });
    expect((await readAdminBootstrapState(database)).status).toBe("blocked");
  });

  it("returns a fixed error and never opens after a conflicting partial setup", async () => {
    const database = createDatabase();
    await database.execute(sql`CREATE TABLE users (id integer PRIMARY KEY)`);

    await expect(runDeploymentDatabaseMigration(database)).rejects.toThrow(
      "URMOTIV_DATABASE_MIGRATION_FAILED"
    );
  });
});
