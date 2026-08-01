import {
  createPostgresDatabase
} from "@urmotiv/database";
import { runDeploymentDatabaseMigration } from "./deployment-migration";
import { readServerDatabaseOptions } from "./server-config";

const options = readServerDatabaseOptions(process.env);

if (options.kind !== "postgres") {
  throw new Error("正式部署迁移必须使用 PostgreSQL。");
}

const database = createPostgresDatabase({
  connectionString: options.connectionString,
  applicationName: "urmotiv-migrate",
  maxConnections: 1,
  idleTimeoutMs: 0
});

let migrationError: Error | undefined;
try {
  await runDeploymentDatabaseMigration(database);
} catch {
  migrationError = new Error("URMOTIV_DATABASE_MIGRATION_FAILED");
} finally {
  try {
    await database.close();
  } catch {
    migrationError ??= new Error("URMOTIV_DATABASE_MIGRATION_FAILED");
  }
}

if (migrationError !== undefined) {
  throw migrationError;
}
