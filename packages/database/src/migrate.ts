import { fileURLToPath } from "node:url";
import { migrate as migrateNodePostgres } from "drizzle-orm/node-postgres/migrator";
import { migrate as migratePglite } from "drizzle-orm/pglite/migrator";
import type { DatabaseHandle } from "./client";

export interface MigrationOptions {
  readonly migrationsFolder?: string;
}

export async function migrateDatabase(
  handle: DatabaseHandle,
  options: MigrationOptions = {}
): Promise<void> {
  const migrationsFolder =
    options.migrationsFolder ?? fileURLToPath(new URL("../migrations", import.meta.url));

  if (handle.kind === "postgres") {
    await migrateNodePostgres(handle.database, { migrationsFolder });
    return;
  }

  await migratePglite(handle.database, { migrationsFolder });
}
