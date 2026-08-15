import { sql } from "drizzle-orm";
import { createPostgresDatabase, type DatabaseHandle } from "@urmotiv/database";

import { sha256Hex } from "./digests";
import { HistoryMigrationError } from "./errors";

/**
 * Gate 5 维护活身份：从活 PostgreSQL 服务器就地采集，任何字段缺失即拒
 * （fail-closed，绝不空串放过）。地址/端口取服务器视角的
 * inet_server_addr()/inet_server_port()，集群指纹取 initdb 生成的
 * system_identifier —— 三者合力能在连接串文本不变的情况下识破
 * 端点改指、端口改指、集群翻新与账户/库名变更。
 *
 * 除采集外，本模块还提供「同一连接上原子复核」：任何准备执行管理性
 * 变更（建库、快照、改名、删除）的管理连接都必须先在该连接本身上复核
 * 活身份，复核通过后立即执行，把「复核用的连接」和「执行 DDL 的连接」
 * 压缩为同一条已建立的 TCP 会话。端点只需在身份核对之后、DDL 之前被
 * 改指，新的管理连接就核对失败，零破坏性效果（fail-closed）。
 */
export interface Phase2LiveMaintenanceIdentity {
  readonly serverAddress: string;
  readonly serverPort: string;
  readonly user: string;
  readonly database: string;
  readonly clusterIdentity: string;
}

export function phase2LiveIdentitySha256(identity: Phase2LiveMaintenanceIdentity): string {
  return sha256Hex(
    JSON.stringify([
      "phase2-live-maintenance-v1",
      identity.serverAddress,
      identity.serverPort,
      identity.user,
      identity.database,
      identity.clusterIdentity,
    ]),
  );
}

interface LiveIdentityRowShape {
  server_address: string;
  server_port: number;
  admin_user: string;
  admin_database: string;
  cluster_identifier: string;
}

function requireText(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new HistoryMigrationError("INVALID_METADATA", `维护连接的活身份字段缺失：${label}。`);
  }
  return value;
}

function requirePort(value: unknown): number {
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw new HistoryMigrationError("INVALID_METADATA", "维护连接的活身份端口字段缺失。");
  }
  return value;
}

async function readLiveIdentityRow(database: DatabaseHandle): Promise<LiveIdentityRowShape> {
  const rows = await database.query<Record<string, unknown>>(
    sql`select inet_server_addr()::text as server_address, inet_server_port() as server_port,
        current_user as admin_user, current_database() as admin_database,
        system_identifier::text as cluster_identifier
      from pg_control_system()`,
  );
  const row = rows[0];
  if (row === undefined) {
    throw new HistoryMigrationError("INVALID_METADATA", "维护连接的活身份查询没有结果。");
  }
  return {
    server_address: requireText(row.server_address, "服务器地址"),
    server_port: requirePort(row.server_port),
    admin_user: requireText(row.admin_user, "认证用户"),
    admin_database: requireText(row.admin_database, "当前数据库"),
    cluster_identifier: requireText(row.cluster_identifier, "集群指纹"),
  };
}

/** 打开一条独立连接采集活身份（先核对字段完整性再关闭）。 */
export async function captureLiveMaintenanceIdentity(
  adminUrl: string,
): Promise<Phase2LiveMaintenanceIdentity> {
  const database = createPostgresDatabase({
    connectionString: adminUrl,
    maxConnections: 1,
    applicationName: "urmotiv-history-live-identity",
  });
  try {
    const row = await readLiveIdentityRow(database);
    return {
      serverAddress: row.server_address,
      serverPort: String(row.server_port),
      user: row.admin_user,
      database: row.admin_database,
      clusterIdentity: row.cluster_identifier,
    };
  } catch (error) {
    if (error instanceof HistoryMigrationError) throw error;
    throw new HistoryMigrationError("INVALID_METADATA", "维护连接的活身份无法采集，拒绝续做。");
  } finally {
    await database.close();
  }
}

/**
 * 在即将执行管理性 DDL 的同一条连接上逐字段复核活身份。
 * 任一字段与冻结值不一致立刻拒绝，该连接不会执行任何管理性变更。
 */
export async function verifyLiveMaintenanceIdentityOnConnection(
  database: DatabaseHandle,
  expected: Phase2LiveMaintenanceIdentity,
): Promise<void> {
  const row = await readLiveIdentityRow(database);
  const actual: Phase2LiveMaintenanceIdentity = {
    serverAddress: row.server_address,
    serverPort: String(row.server_port),
    user: row.admin_user,
    database: row.admin_database,
    clusterIdentity: row.cluster_identifier,
  };
  const fields: readonly [keyof Phase2LiveMaintenanceIdentity, string][] = [
    ["serverAddress", "服务器地址"],
    ["serverPort", "服务器端口"],
    ["user", "认证用户"],
    ["database", "当前数据库"],
    ["clusterIdentity", "集群指纹"],
  ];
  for (const [field, label] of fields) {
    if (actual[field] !== expected[field]) {
      throw new HistoryMigrationError(
        "INVALID_METADATA",
        `管理连接的维护活身份字段 ${label} 与冻结值不一致，拒绝执行管理性变更。`,
      );
    }
  }
}