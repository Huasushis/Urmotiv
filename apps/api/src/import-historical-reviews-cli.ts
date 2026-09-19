import { readFile, stat } from "node:fs/promises";
import { createPostgresDatabase } from "@urmotiv/database";
import { importHistoricalReviews } from "./historical-reviews";

const [path, mode] = process.argv.slice(2);
let database: ReturnType<typeof createPostgresDatabase> | undefined;
try {
  if (!path || (mode !== undefined && mode !== "--apply") || process.argv.length > 4) throw new Error();
  const info = await stat(path);
  if (!info.isFile() || (info.mode & 0o077) !== 0 || info.size > 10_000_000) throw new Error();
  const input: unknown = JSON.parse(await readFile(path, "utf8"));
  database = createPostgresDatabase({ connectionString: process.env.DATABASE_URL ?? "", maxConnections: 1 });
  const result = await importHistoricalReviews(database, input, mode === "--apply");
  process.stdout.write(`${JSON.stringify(result)}\n`);
} catch {
  // Database errors can contain original review text or connection credentials.
  process.stderr.write("HISTORY_IMPORT_FAILED: 检查私有文件权限、题目对应关系、当前版本和管理员权限。\n");
  process.exitCode = 1;
} finally {
  try { await database?.close(); } catch {
    process.stderr.write("HISTORY_IMPORT_CLOSE_FAILED\n");
    process.exitCode = 1;
  }
}
