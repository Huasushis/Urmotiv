import {
  createPostgresDatabase,
  migrateDatabase,
  seedCoreDatabase
} from "@urmotiv/database";
import { readServerDatabaseOptions } from "./server-config";

const options = readServerDatabaseOptions(process.env);

if (options.kind !== "postgres") {
  throw new Error("正式部署迁移必须使用 PostgreSQL。");
}

const database = createPostgresDatabase({
  connectionString: options.connectionString,
  applicationName: "urmotiv-migrate"
});

try {
  await migrateDatabase(database);
  await seedCoreDatabase(database);
} finally {
  await database.close();
}
