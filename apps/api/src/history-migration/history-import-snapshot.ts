/**
 * 独占窗口内对临时/验收库与本地文件存储做快照与恢复。
 * 只允许操作 urmotiv_history_import_ 前缀的库；真实目标一概拒绝。
 * 所有输出都是聚合计数；不输出题名、编号、摘要或路径。
 */
import { cp, mkdir, readdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";

import { sql } from "drizzle-orm";
import { createPostgresDatabase, type DatabaseHandle } from "@urmotiv/database";

import { HistoryMigrationError } from "./errors";
import { assertScratchDatabaseName } from "./phase2-postcheck";

function snapshotNameFor(name: string): string {
  assertScratchDatabaseName(name);
  return `${name}__snapshot`;
}

async function withAdminConnection<T>(
  adminConnectionString: string,
  action: (database: DatabaseHandle) => Promise<T>,
): Promise<T> {
  const database = createPostgresDatabase({
    connectionString: adminConnectionString,
    maxConnections: 1,
  });
  try {
    return await action(database);
  } finally {
    await database.close();
  }
}

/** 仅在新建临时/验收库上创建同名快照库；快照库存在先删除。 */
export async function snapshotScratchDatabase(
  adminConnectionString: string,
  scratchName: string,
): Promise<void> {
  assertScratchDatabaseName(scratchName);
  const snapshotName = snapshotNameFor(scratchName);
  await withAdminConnection(adminConnectionString, async (adminDatabase) => {
    await adminDatabase.execute(sql.raw(`DROP DATABASE IF EXISTS "${snapshotName}"`));
    // CREATE DATABASE ... TEMPLATE 要求源库没有活动连接；调用者必须先关闭业务连接池。
    await adminDatabase.execute(
      sql.raw(`CREATE DATABASE "${snapshotName}" TEMPLATE "${scratchName}"`),
    );
  });
}

/**
 * 从快照库恢复临时/验收库：先断开业务连接、落库重建、删除快照。
 * 文件名与库名都经过前缀校验，拒绝任何真实目标。
 */
export async function restoreScratchDatabase(
  adminConnectionString: string,
  scratchName: string,
): Promise<void> {
  assertScratchDatabaseName(scratchName);
  const snapshotName = snapshotNameFor(scratchName);
  await withAdminConnection(adminConnectionString, async (adminDatabase) => {
    await adminDatabase.execute(
      sql.raw(
        `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '${scratchName}' AND pid <> pg_backend_pid()`,
      ),
    );
    await adminDatabase.execute(sql.raw(`DROP DATABASE IF EXISTS "${scratchName}"`));
    await adminDatabase.execute(
      sql.raw(`CREATE DATABASE "${scratchName}" TEMPLATE "${snapshotName}"`),
    );
    await adminDatabase.execute(sql.raw(`DROP DATABASE "${snapshotName}"`));
  });
}

/** 删除遗留快照库；存在与否都不输出名称。 */
export async function dropScratchSnapshot(
  adminConnectionString: string,
  scratchName: string,
): Promise<void> {
  const snapshotName = snapshotNameFor(scratchName);
  await withAdminConnection(adminConnectionString, async (adminDatabase) => {
    await adminDatabase.execute(sql.raw(`DROP DATABASE IF EXISTS "${snapshotName}"`));
  });
}

async function countRegularFiles(directory: string): Promise<number> {
  let total = 0;
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) {
      total += await countRegularFiles(join(directory, entry.name));
    } else if (entry.isFile()) {
      total += 1;
    }
  }
  return total;
}

/** 复制整个本地存储目录到新建的快照目录；返回复制的普通文件数量。 */
export async function snapshotStorageDirectory(
  source: string,
  snapshotDirectory: string,
): Promise<number> {
  const sourceInfo = await stat(source);
  if (!sourceInfo.isDirectory()) {
    throw new HistoryMigrationError("INVALID_ARGUMENTS", "存储快照源必须是目录。");
  }
  await rm(snapshotDirectory, { recursive: true, force: true });
  await mkdir(snapshotDirectory, { recursive: true });
  await cp(source, snapshotDirectory, { recursive: true, errorOnExist: true, force: false });
  return countRegularFiles(snapshotDirectory);
}

/** 从快照目录恢复存储目录：先整目录移走再整套换回。 */
export async function restoreStorageDirectory(
  snapshotDirectory: string,
  targetDirectory: string,
): Promise<number> {
  await rm(targetDirectory, { recursive: true, force: true });
  await mkdir(targetDirectory, { recursive: true });
  await cp(snapshotDirectory, targetDirectory, {
    recursive: true,
    errorOnExist: true,
    force: false,
  });
  return countRegularFiles(targetDirectory);
}

/** 仅统计普通文件数量；被删除目录返回 0。 */
export async function countStorageFiles(directory: string): Promise<number> {
  try {
    return await countRegularFiles(directory);
  } catch {
    return 0;
  }
}
