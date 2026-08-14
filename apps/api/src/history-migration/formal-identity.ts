/**
 * 正式目标身份指纹与存储根身份：只做规范化摘要计算，不接触私有内容。
 * 这些函数同时被第 2 阶段批准书模板与正式入口门禁使用，避免两处各自
 * 计算导致语义分叉。任何时候都不得把计算出的指纹或连接细节打印出来。
 */
import { realpath } from "node:fs/promises";

import { sha256Hex } from "./digests";
import { HistoryMigrationError } from "./errors";

export interface FormalTargetIdentity {
  readonly host: string;
  readonly port: string;
  readonly user: string;
  readonly database: string;
}

/** 正式目标身份指纹；任何字段都改变摘要。 */
export function computeFormalTargetFingerprintSha256(target: FormalTargetIdentity): string {
  const parts = [target.user, target.host, target.port, target.database];
  return sha256Hex(parts.map((part) => `${part.length}:${part}`).join("|") + "|formal-target-v1");
}

/** 管理员连接身份指纹：只绑定主机/端口/用户，不绑定库名（备份库名是派生的）。 */
export function computeFormalAdminFingerprintSha256(
  adminTarget: Pick<FormalTargetIdentity, "host" | "port" | "user">,
): string {
  const parts = [adminTarget.user, adminTarget.host, adminTarget.port];
  return sha256Hex(parts.map((part) => `${part.length}:${part}`).join("|") + "|formal-admin-v1");
}

/** 存储根身份：绑定真实路径（解符号链接后的绝对路径）。 */
export async function computeStorageRootIdentitySha256(storageRoot: string): Promise<string> {
  const resolved = await realpath(storageRoot);
  return sha256Hex(`${resolved.length}:${resolved}|formal-storage-root-v1`);
}

/** 解析 PostgreSQL 连接串身份；任何失败都只报通用不合法，不带原文。 */
export function parsePostgresIdentity(raw: string): FormalTargetIdentity {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new HistoryMigrationError("INVALID_ARGUMENTS", "数据库连接串不合法。");
  }
  if (!parsed.protocol.startsWith("postgres")) {
    throw new HistoryMigrationError("INVALID_ARGUMENTS", "数据库连接串不合法。");
  }
  const database = decodeURIComponent(parsed.pathname.replace(/^\//, ""));
  if (database.length === 0) {
    throw new HistoryMigrationError("INVALID_ARGUMENTS", "数据库连接串不合法。");
  }
  return {
    host: parsed.hostname,
    port: parsed.port === "" ? "5432" : parsed.port,
    user: decodeURIComponent(parsed.username),
    database,
  };
}