/**
 * 独占窗口内对临时/验收库与本地文件存储做快照与恢复。
 * 只允许操作 urmotiv_history_import_ 前缀的库；真实目标一概拒绝。
 * 文件清单只返回聚合摘要，不输出路径或内容。
 */
import { createHash } from "node:crypto";
import { cp, lstat, readFile, readdir, rename, rm } from "node:fs/promises";
import { join } from "node:path";

import { sql } from "drizzle-orm";
import { createPostgresDatabase, type DatabaseHandle } from "@urmotiv/database";

import { HistoryMigrationError } from "./errors";
import { assertScratchDatabaseName } from "./phase2-postcheck";

export interface StorageInventory {
  readonly fileCount: number;
  readonly totalBytes: number;
  /** 绑定相对路径、字节数和内容摘要，用于恢复后逐项一致性验证。 */
  readonly pathInventorySha256: string;
  /** 忽略随机对象路径，仅绑定内容摘要和字节数，用于导入增量核对。 */
  readonly contentInventorySha256: string;
}

interface StorageInventoryEntry {
  readonly relativePath: string;
  readonly bytes: number;
  readonly sha256: string;
}

function snapshotNameFor(name: string): string {
  assertScratchDatabaseName(name);
  return `${name}__snapshot`;
}

function restoreStagingNameFor(name: string): string {
  assertScratchDatabaseName(name);
  return `${name}__restore`;
}

async function withAdminConnection<T>(
  adminConnectionString: string,
  action: (database: DatabaseHandle) => Promise<T>,
): Promise<T> {
  const admin = createPostgresDatabase({
    connectionString: adminConnectionString,
    maxConnections: 1,
    applicationName: "urmotiv-history-import-snapshot-admin",
  });
  try {
    return await action(admin);
  } finally {
    await admin.close();
  }
}

async function databaseExists(admin: DatabaseHandle, name: string): Promise<boolean> {
  const rows = await admin.query<{ total: bigint }>(
    sql`select count(*)::bigint as total from pg_database where datname = ${name}`,
  );
  return Number(rows[0]?.total ?? 0) === 1;
}

async function terminateConnections(admin: DatabaseHandle, name: string): Promise<void> {
  await admin.execute(
    sql`select pg_terminate_backend(pid) from pg_stat_activity
        where datname = ${name} and pid <> pg_backend_pid()`,
  );
  const remaining = await admin.query<{ total: bigint }>(
    sql`select count(*)::bigint as total from pg_stat_activity
        where datname = ${name} and pid <> pg_backend_pid()`,
  );
  if (Number(remaining[0]?.total ?? 0) !== 0) {
    throw new HistoryMigrationError("INVALID_ARGUMENTS", "临时库仍有活动连接，拒绝快照或恢复。");
  }
}

/** 源业务连接必须由调用者先关闭；函数再确认零连接后创建只读模板快照。 */
export async function snapshotScratchDatabase(
  adminConnectionString: string,
  scratchName: string,
): Promise<void> {
  assertScratchDatabaseName(scratchName);
  const snapshotName = snapshotNameFor(scratchName);
  await withAdminConnection(adminConnectionString, async (admin) => {
    if (!(await databaseExists(admin, scratchName))) {
      throw new HistoryMigrationError("INVALID_ARGUMENTS", "临时库不存在，无法创建快照。");
    }
    if (await databaseExists(admin, snapshotName)) {
      throw new HistoryMigrationError("INVALID_ARGUMENTS", "同名快照已存在，拒绝覆盖。");
    }
    await terminateConnections(admin, scratchName);
    await admin.execute(
      sql`create database ${sql.identifier(snapshotName)} template ${sql.identifier(scratchName)}`,
    );
  });
}

/**
 * 分阶段恢复：先从快照创建独立 staging 库，再替换目标库；快照保留到调用者
 * 完成行数核对，避免恢复校验失败后失去最后一份可重试副本。
 */
export async function restoreScratchDatabase(
  adminConnectionString: string,
  scratchName: string,
): Promise<void> {
  assertScratchDatabaseName(scratchName);
  const snapshotName = snapshotNameFor(scratchName);
  const stagingName = restoreStagingNameFor(scratchName);
  await withAdminConnection(adminConnectionString, async (admin) => {
    if (!(await databaseExists(admin, snapshotName))) {
      throw new HistoryMigrationError("INVALID_ARGUMENTS", "数据库快照不存在，无法恢复。");
    }
    if (await databaseExists(admin, stagingName)) {
      throw new HistoryMigrationError("INVALID_ARGUMENTS", "恢复 staging 库已存在，拒绝覆盖。");
    }
    await admin.execute(
      sql`create database ${sql.identifier(stagingName)} template ${sql.identifier(snapshotName)}`,
    );
    await terminateConnections(admin, scratchName);
    await admin.execute(sql`drop database if exists ${sql.identifier(scratchName)}`);
    await admin.execute(
      sql`alter database ${sql.identifier(stagingName)} rename to ${sql.identifier(scratchName)}`,
    );
  });
}

/** 删除已验证恢复或成功导入后的数据库快照；清理错误直接向上传播。 */
export async function dropScratchSnapshot(
  adminConnectionString: string,
  scratchName: string,
): Promise<void> {
  const snapshotName = snapshotNameFor(scratchName);
  await withAdminConnection(adminConnectionString, async (admin) => {
    await terminateConnections(admin, snapshotName);
    await admin.execute(sql`drop database if exists ${sql.identifier(snapshotName)}`);
  });
}

async function collectStorageEntries(
  root: string,
  relativeDirectory: string,
  output: StorageInventoryEntry[],
): Promise<void> {
  const absoluteDirectory = relativeDirectory.length === 0 ? root : join(root, relativeDirectory);
  const directoryInfo = await lstat(absoluteDirectory);
  if (!directoryInfo.isDirectory() || directoryInfo.isSymbolicLink()) {
    throw new HistoryMigrationError("INVALID_ARGUMENTS", "存储清单只能读取普通目录。");
  }
  const entries = await readdir(absoluteDirectory, { withFileTypes: true });
  entries.sort((left, right) => left.name.localeCompare(right.name));
  for (const entry of entries) {
    const relativePath = relativeDirectory.length === 0
      ? entry.name
      : join(relativeDirectory, entry.name);
    if (entry.isSymbolicLink()) {
      throw new HistoryMigrationError("INVALID_ARGUMENTS", "存储目录包含符号链接，拒绝继续。");
    }
    if (entry.isDirectory()) {
      await collectStorageEntries(root, relativePath, output);
      continue;
    }
    if (!entry.isFile()) {
      throw new HistoryMigrationError("INVALID_ARGUMENTS", "存储目录包含非普通文件，拒绝继续。");
    }
    const bytes = await readFile(join(root, relativePath));
    output.push({
      relativePath,
      bytes: bytes.byteLength,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    });
  }
}

/** 逐文件读取并生成两个稳定摘要；不返回路径或单文件摘要。 */
export async function captureStorageInventory(directory: string): Promise<StorageInventory> {
  const entries: StorageInventoryEntry[] = [];
  await collectStorageEntries(directory, "", entries);
  entries.sort((left, right) => left.relativePath.localeCompare(right.relativePath));
  const contentEntries = entries
    .map((entry) => ({ sha256: entry.sha256, bytes: entry.bytes }))
    .sort((left, right) => {
      const digestOrder = left.sha256.localeCompare(right.sha256);
      return digestOrder === 0 ? left.bytes - right.bytes : digestOrder;
    });
  return {
    fileCount: entries.length,
    totalBytes: entries.reduce((sum, entry) => sum + entry.bytes, 0),
    pathInventorySha256: createHash("sha256").update(JSON.stringify(entries)).digest("hex"),
    contentInventorySha256: createHash("sha256").update(JSON.stringify(contentEntries)).digest("hex"),
  };
}

export function storageInventoriesEqual(left: StorageInventory, right: StorageInventory): boolean {
  return left.fileCount === right.fileCount &&
    left.totalBytes === right.totalBytes &&
    left.pathInventorySha256 === right.pathInventorySha256 &&
    left.contentInventorySha256 === right.contentInventorySha256;
}

/** 快照目录必须尚不存在；复制后逐文件核对路径、字节数与内容摘要。 */
export async function snapshotStorageDirectory(
  source: string,
  snapshotDirectory: string,
): Promise<StorageInventory> {
  const sourceInventory = await captureStorageInventory(source);
  try {
    await lstat(snapshotDirectory);
    throw new HistoryMigrationError("INVALID_ARGUMENTS", "存储快照目录已存在，拒绝覆盖。");
  } catch (error) {
    if (error instanceof HistoryMigrationError) throw error;
    if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") throw error;
  }
  try {
    await cp(source, snapshotDirectory, { recursive: true, errorOnExist: true, force: false });
    const snapshotInventory = await captureStorageInventory(snapshotDirectory);
    if (!storageInventoriesEqual(sourceInventory, snapshotInventory)) {
      throw new HistoryMigrationError("INVALID_ARGUMENTS", "存储快照清单或摘要不一致。");
    }
    return snapshotInventory;
  } catch (error) {
    await rm(snapshotDirectory, { recursive: true, force: true });
    throw error;
  }
}

/**
 * 先完整复制并校验 staging，再用同文件系统 rename 原子替换目标；任何失败都
 * 尝试恢复旧目录，且清理错误不会被吞掉。
 */
export async function restoreStorageDirectory(
  snapshotDirectory: string,
  targetDirectory: string,
  expectedInventory: StorageInventory,
): Promise<StorageInventory> {
  const snapshotInventory = await captureStorageInventory(snapshotDirectory);
  if (!storageInventoriesEqual(snapshotInventory, expectedInventory)) {
    throw new HistoryMigrationError("INVALID_ARGUMENTS", "存储快照不再匹配批准的基线摘要。");
  }
  const stagingDirectory = `${targetDirectory}__phase2_restore`;
  const backupDirectory = `${targetDirectory}__phase2_backup`;
  await rm(stagingDirectory, { recursive: true, force: true });
  await rm(backupDirectory, { recursive: true, force: true });
  await cp(snapshotDirectory, stagingDirectory, { recursive: true, errorOnExist: true, force: false });
  const stagingInventory = await captureStorageInventory(stagingDirectory);
  if (!storageInventoriesEqual(expectedInventory, stagingInventory)) {
    await rm(stagingDirectory, { recursive: true, force: true });
    throw new HistoryMigrationError("INVALID_ARGUMENTS", "存储恢复 staging 清单或摘要不一致。");
  }

  let targetMoved = false;
  try {
    await rename(targetDirectory, backupDirectory);
    targetMoved = true;
    await rename(stagingDirectory, targetDirectory);
    const restoredInventory = await captureStorageInventory(targetDirectory);
    if (!storageInventoriesEqual(expectedInventory, restoredInventory)) {
      throw new HistoryMigrationError("INVALID_ARGUMENTS", "存储恢复后清单或摘要不一致。");
    }
    await rm(backupDirectory, { recursive: true, force: false });
    return restoredInventory;
  } catch (error) {
    if (targetMoved) {
      await rm(targetDirectory, { recursive: true, force: true });
      await rename(backupDirectory, targetDirectory);
    }
    await rm(stagingDirectory, { recursive: true, force: true });
    throw error;
  }
}
