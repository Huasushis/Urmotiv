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
import {
  verifyLiveMaintenanceIdentityOnConnection,
  type Phase2LiveMaintenanceIdentity,
} from "./live-maintenance-identity";
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

export interface DatabaseContentInventory {
  readonly tableCount: number;
  readonly rowCount: number;
  readonly contentSha256: string;
}

function databaseConnectionString(adminConnectionString: string, databaseName: string): string {
  const parsed = new URL(adminConnectionString);
  parsed.pathname = `/${databaseName}`;
  return parsed.toString();
}

export async function captureDatabaseContentInventory(
  database: DatabaseHandle,
  tableNames: readonly string[],
): Promise<DatabaseContentInventory> {
  const tablePayloads: Array<{ readonly table: string; readonly payload: string }> = [];
  let rowCount = 0;
  for (const tableName of tableNames) {
    if (!/^[a-z_]+$/.test(tableName)) {
      throw new HistoryMigrationError("INVALID_ARGUMENTS", "数据库内容清单包含非法表名。");
    }
    const rows = await database.query<{ total: bigint; payload: string }>(
      sql`select count(*)::bigint as total,
                 coalesce(
                   jsonb_agg(to_jsonb(content_row) order by to_jsonb(content_row)::text),
                   '[]'::jsonb
                 )::text as payload
            from (select * from ${sql.identifier("public")}.${sql.identifier(tableName)}) content_row`,
    );
    const row = rows[0];
    if (row === undefined) {
      throw new HistoryMigrationError("INVALID_ARGUMENTS", "数据库内容清单查询没有结果。");
    }
    rowCount += Number(row.total);
    tablePayloads.push({ table: tableName, payload: row.payload });
  }
  return {
    tableCount: tableNames.length,
    rowCount,
    contentSha256: createHash("sha256").update(JSON.stringify(tablePayloads)).digest("hex"),
  };
}

export function databaseContentInventoriesEqual(
  left: DatabaseContentInventory,
  right: DatabaseContentInventory,
): boolean {
  return (
    left.tableCount === right.tableCount &&
    left.rowCount === right.rowCount &&
    left.contentSha256 === right.contentSha256
  );
}

async function captureNamedDatabaseInventory(
  adminConnectionString: string,
  databaseName: string,
  tableNames: readonly string[],
): Promise<DatabaseContentInventory> {
  const database = createPostgresDatabase({
    connectionString: databaseConnectionString(adminConnectionString, databaseName),
    maxConnections: 1,
    applicationName: "urmotiv-history-import-snapshot-verify",
  });
  try {
    return await captureDatabaseContentInventory(database, tableNames);
  } finally {
    await database.close();
  }
}

function snapshotNameFor(name: string): string {
  assertScratchDatabaseName(name);
  return `${name}__snapshot`;
}

function restoreStagingNameFor(name: string): string {
  assertScratchDatabaseName(name);
  return `${name}__restore`;
}

function restoreBackupNameFor(name: string): string {
  assertScratchDatabaseName(name);
  return `${name}__failed`;
}

async function withAdminConnection<T>(
  adminConnectionString: string,
  maintenanceLiveIdentity: Phase2LiveMaintenanceIdentity | undefined,
  action: (database: DatabaseHandle) => Promise<T>,
): Promise<T> {
  const admin = createPostgresDatabase({
    connectionString: adminConnectionString,
    maxConnections: 1,
    applicationName: "urmotiv-history-import-snapshot-admin",
  });
  try {
    // Gate 5：准备执行管理性 DDL 的连接本身上先原子复核维护活身份；
    // 端点改指、端口改指、账户/库名变更都会在这条连接上核对失败，
    // 后续 DDL 一律不执行（零破坏性效果）。
    if (maintenanceLiveIdentity !== undefined) {
      await verifyLiveMaintenanceIdentityOnConnection(admin, maintenanceLiveIdentity);
    }
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

/**
 * 先请求终止目标库的全部其它后端，再确认 pg_stat_activity 归零。
 * 终止是异步生效的：刚发出 pg_terminate_backend 的会话在系统表中
 * 还会残留片刻。这里按固定小步长轮询归零，消除「按活动连接数立即
 * 断言」与后端回收之间的竞态（Gate 6），轮询超时才拒绝。
 */
async function terminateConnections(admin: DatabaseHandle, name: string): Promise<void> {
  await admin.execute(
    sql`select pg_terminate_backend(pid) from pg_stat_activity
        where datname = ${name} and pid <> pg_backend_pid()`,
  );
  let remaining = await activeConnectionCount(admin, name);
  for (let attempt = 0; attempt < 20 && remaining !== 0; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 250));
    if (attempt % 2 === 1) {
      await admin.execute(
        sql`select pg_terminate_backend(pid) from pg_stat_activity
            where datname = ${name} and pid <> pg_backend_pid()`,
      );
    }
    remaining = await activeConnectionCount(admin, name);
  }
  if (remaining !== 0) {
    throw new HistoryMigrationError("INVALID_ARGUMENTS", "临时库仍有活动连接，拒绝快照或恢复。");
  }
}

async function activeConnectionCount(admin: DatabaseHandle, name: string): Promise<number> {
  const rows = await admin.query<{ total: bigint }>(
    sql`select count(*)::bigint as total from pg_stat_activity
        where datname = ${name} and pid <> pg_backend_pid()`,
  );
  return Number(rows[0]?.total ?? 0);
}

/** 源业务连接必须由调用者先关闭；函数再确认零连接后创建只读模板快照。 */
export async function snapshotScratchDatabase(
  adminConnectionString: string,
  scratchName: string,
  tableNames: readonly string[],
  expectedInventory: DatabaseContentInventory,
  maintenanceLiveIdentity?: Phase2LiveMaintenanceIdentity | undefined,
): Promise<DatabaseContentInventory> {
  assertScratchDatabaseName(scratchName);
  const snapshotName = snapshotNameFor(scratchName);
  await withAdminConnection(adminConnectionString, maintenanceLiveIdentity, async (admin) => {
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
  const snapshotInventory = await captureNamedDatabaseInventory(
    adminConnectionString,
    snapshotName,
    tableNames,
  );
  if (!databaseContentInventoriesEqual(snapshotInventory, expectedInventory)) {
    await dropScratchSnapshot(adminConnectionString, scratchName, maintenanceLiveIdentity);
    throw new HistoryMigrationError("INVALID_ARGUMENTS", "数据库快照内容摘要与批准基线不一致。");
  }
  return snapshotInventory;
}

/**
 * 分阶段恢复：先验证快照内容，再创建并验证 staging 库，最后保留失败现场备份并
 * 原子改名。快照和失败现场直到调用者完成内容复核后才由 dropScratchSnapshot 删除。
 */
export async function restoreScratchDatabase(
  adminConnectionString: string,
  scratchName: string,
  tableNames: readonly string[],
  expectedInventory: DatabaseContentInventory,
  maintenanceLiveIdentity?: Phase2LiveMaintenanceIdentity | undefined,
): Promise<DatabaseContentInventory> {
  assertScratchDatabaseName(scratchName);
  const snapshotName = snapshotNameFor(scratchName);
  const stagingName = restoreStagingNameFor(scratchName);
  const backupName = restoreBackupNameFor(scratchName);
  await withAdminConnection(adminConnectionString, maintenanceLiveIdentity, async (admin) => {
    if (!(await databaseExists(admin, snapshotName))) {
      throw new HistoryMigrationError("INVALID_ARGUMENTS", "数据库快照不存在，无法恢复。");
    }
    if (!(await databaseExists(admin, scratchName))) {
      throw new HistoryMigrationError("INVALID_ARGUMENTS", "待恢复数据库不存在。");
    }
    if ((await databaseExists(admin, stagingName)) || (await databaseExists(admin, backupName))) {
      throw new HistoryMigrationError("INVALID_ARGUMENTS", "恢复 staging 或失败现场库已存在，拒绝覆盖。");
    }
  });
  const snapshotInventory = await captureNamedDatabaseInventory(
    adminConnectionString,
    snapshotName,
    tableNames,
  );
  if (!databaseContentInventoriesEqual(snapshotInventory, expectedInventory)) {
    throw new HistoryMigrationError("INVALID_ARGUMENTS", "数据库快照内容摘要不再匹配批准基线。");
  }
  await withAdminConnection(adminConnectionString, maintenanceLiveIdentity, async (admin) => {
    await terminateConnections(admin, snapshotName);
    await admin.execute(
      sql`create database ${sql.identifier(stagingName)} template ${sql.identifier(snapshotName)}`,
    );
  });
  const stagingInventory = await captureNamedDatabaseInventory(
    adminConnectionString,
    stagingName,
    tableNames,
  );
  if (!databaseContentInventoriesEqual(stagingInventory, expectedInventory)) {
    await withAdminConnection(adminConnectionString, maintenanceLiveIdentity, async (admin) => {
      await terminateConnections(admin, stagingName);
      await admin.execute(sql`drop database ${sql.identifier(stagingName)}`);
    });
    throw new HistoryMigrationError("INVALID_ARGUMENTS", "数据库恢复 staging 内容摘要不一致。");
  }
  await withAdminConnection(adminConnectionString, maintenanceLiveIdentity, async (admin) => {
    await terminateConnections(admin, scratchName);
    await admin.execute(
      sql`alter database ${sql.identifier(scratchName)} rename to ${sql.identifier(backupName)}`,
    );
    try {
      await admin.execute(
        sql`alter database ${sql.identifier(stagingName)} rename to ${sql.identifier(scratchName)}`,
      );
    } catch (error) {
      await admin.execute(
        sql`alter database ${sql.identifier(backupName)} rename to ${sql.identifier(scratchName)}`,
      );
      throw error;
    }
  });
  return stagingInventory;
}

/** 删除已验证恢复或成功导入后的数据库快照；清理错误直接向上传播。 */
export async function dropScratchSnapshot(
  adminConnectionString: string,
  scratchName: string,
  maintenanceLiveIdentity?: Phase2LiveMaintenanceIdentity | undefined,
): Promise<void> {
  const names = [
    snapshotNameFor(scratchName),
    restoreStagingNameFor(scratchName),
    restoreBackupNameFor(scratchName),
  ];
  const failures: unknown[] = [];
  await withAdminConnection(adminConnectionString, maintenanceLiveIdentity, async (admin) => {
    for (const name of names) {
      try {
        await terminateConnections(admin, name);
        await admin.execute(sql`drop database if exists ${sql.identifier(name)}`);
      } catch (error) {
        failures.push(error);
      }
    }
  });
  if (failures.length > 0) throw failures[0];
}

function generationSnapshotNameFor(name: string, generation: 1 | 2): string {
  return `${snapshotNameFor(name)}_g${generation}`;
}

/**
 * 换代快照：创建并核对后保留，绝不触碰规范名快照。与 `__snapshot`（旧代）
 * 并行存在时不形成销毁空隙；核对失败只删除本次代名，旧代原样保留。
 */
export async function snapshotScratchDatabaseGeneration(
  adminConnectionString: string,
  scratchName: string,
  tableNames: readonly string[],
  expectedInventory: DatabaseContentInventory,
  generation: 1 | 2,
  maintenanceLiveIdentity?: Phase2LiveMaintenanceIdentity | undefined,
): Promise<DatabaseContentInventory> {
  assertScratchDatabaseName(scratchName);
  const snapshotName = generationSnapshotNameFor(scratchName, generation);
  await withAdminConnection(adminConnectionString, maintenanceLiveIdentity, async (admin) => {
    if (!(await databaseExists(admin, scratchName))) {
      throw new HistoryMigrationError("INVALID_ARGUMENTS", "临时库不存在，无法创建换代快照。");
    }
    if (await databaseExists(admin, snapshotName)) {
      throw new HistoryMigrationError("INVALID_ARGUMENTS", "同名换代快照已存在，拒绝覆盖。");
    }
    await terminateConnections(admin, scratchName);
    await admin.execute(
      sql`create database ${sql.identifier(snapshotName)} template ${sql.identifier(scratchName)}`,
    );
  });
  const snapshotInventory = await captureNamedDatabaseInventory(
    adminConnectionString,
    snapshotName,
    tableNames,
  );
  if (!databaseContentInventoriesEqual(snapshotInventory, expectedInventory)) {
    await dropScratchSnapshotGeneration(adminConnectionString, scratchName, generation, maintenanceLiveIdentity);
    throw new HistoryMigrationError("INVALID_ARGUMENTS", "换代数据库快照内容摘要与批准基线不一致。");
  }
  return snapshotInventory;
}

/** 只删除规范名快照本身（旧代退役）；分世代名与其他恢复工件不受影响。 */
export async function dropCanonicalScratchSnapshot(
  adminConnectionString: string,
  scratchName: string,
  maintenanceLiveIdentity?: Phase2LiveMaintenanceIdentity | undefined,
): Promise<void> {
  const name = snapshotNameFor(scratchName);
  await withAdminConnection(adminConnectionString, maintenanceLiveIdentity, async (admin) => {
    await terminateConnections(admin, name);
    await admin.execute(sql`drop database if exists ${sql.identifier(name)}`);
  });
}

/** 把已核对的换代快照原子改名为规范名；规范名必须空缺，否则拒绝。 */
export async function promoteScratchDatabaseGeneration(
  adminConnectionString: string,
  scratchName: string,
  generation: 1 | 2,
  maintenanceLiveIdentity?: Phase2LiveMaintenanceIdentity | undefined,
): Promise<void> {
  const generationName = generationSnapshotNameFor(scratchName, generation);
  const canonicalName = snapshotNameFor(scratchName);
  await withAdminConnection(adminConnectionString, maintenanceLiveIdentity, async (admin) => {
    if (!(await databaseExists(admin, generationName))) {
      throw new HistoryMigrationError("INVALID_ARGUMENTS", "待提升的换代快照不存在。");
    }
    if (await databaseExists(admin, canonicalName)) {
      throw new HistoryMigrationError("INVALID_ARGUMENTS", "规范快照名仍被占用，拒绝改名提升。");
    }
    await terminateConnections(admin, generationName);
    await admin.execute(
      sql`alter database ${sql.identifier(generationName)} rename to ${sql.identifier(canonicalName)}`,
    );
  });
}

/** 删除指定的分量名快照；核对失败回收与终删补做共用，允许不存在。 */
export async function dropScratchSnapshotGeneration(
  adminConnectionString: string,
  scratchName: string,
  generation: 1 | 2,
  maintenanceLiveIdentity?: Phase2LiveMaintenanceIdentity | undefined,
): Promise<void> {
  const name = generationSnapshotNameFor(scratchName, generation);
  await withAdminConnection(adminConnectionString, maintenanceLiveIdentity, async (admin) => {
    await terminateConnections(admin, name);
    await admin.execute(sql`drop database if exists ${sql.identifier(name)}`);
  });
}

/** 清洗失败证据用：按规范名、g2、g1 的顺序探明保留的数据库快照代。 */
export async function probeScratchSnapshotGeneration(
  adminConnectionString: string,
  scratchName: string,
  tableNames: readonly string[],
  maintenanceLiveIdentity?: Phase2LiveMaintenanceIdentity | undefined,
): Promise<{ readonly name: string | null; readonly inventory: DatabaseContentInventory | null }> {
  const candidates = [
    { name: snapshotNameFor(scratchName), kind: "canonical" },
    { name: generationSnapshotNameFor(scratchName, 2), kind: "g2" },
    { name: generationSnapshotNameFor(scratchName, 1), kind: "g1" },
  ] as const;
  let existingKind: (typeof candidates)[number] | undefined;
  await withAdminConnection(adminConnectionString, maintenanceLiveIdentity, async (admin) => {
    for (const candidate of candidates) {
      if (await databaseExists(admin, candidate.name)) {
        existingKind = candidate;
        return;
      }
    }
  });
  if (existingKind === undefined) return { name: null, inventory: null };
  return {
    name: existingKind.kind,
    inventory: await captureNamedDatabaseInventory(
      adminConnectionString,
      existingKind.name,
      tableNames,
    ),
  };
}

/** 存储快照目录若不存在返回 null；其他错误照常抛出。 */
export async function captureStorageInventoryIfPresent(
  directory: string,
): Promise<StorageInventory | null> {
  try {
    return await captureStorageInventory(directory);
  } catch (error) {
    if (
      error instanceof Error &&
      "code" in error &&
      (error as NodeJS.ErrnoException).code === "ENOENT"
    ) {
      return null;
    }
    throw error;
  }
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
