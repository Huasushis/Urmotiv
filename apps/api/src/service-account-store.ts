import { randomUUID } from "node:crypto";
import { createApiToken } from "@urmotiv/auth";
import {
  adminServiceAccountSchema,
  createServiceAccountTokenInputSchema,
  createdServiceAccountTokenSchema,
  serviceAccountTokenListSchema,
  serviceAccountTokenSchema,
  type AdminServiceAccount,
  type CreateServiceAccountTokenInput,
  type CreatedServiceAccountToken,
  type ServiceAccountToken,
  type ServiceAccountTokenList
} from "@urmotiv/contracts";
import type { DatabaseExecutor, DatabaseHandle } from "@urmotiv/database";
import { sql } from "drizzle-orm";

const databaseIdPattern = /^(0|[1-9]\d*)$/;
const maximumDatabaseId = 9_223_372_036_854_775_807n;
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

interface TokenRow extends Record<string, unknown> {
  id: string;
  name: string;
  token_prefix: string;
  source_cidrs: unknown;
  expires_at: Date | string | null;
  last_used_at: Date | string | null;
  revoked_at: Date | string | null;
  created_at: Date | string;
}

interface TokenPermissionRow extends Record<string, unknown> {
  token_id: string;
  permission_name: string;
}

export interface CreateServiceAccountTokenRecordInput {
  readonly actorUserId: string;
  readonly effectiveUserId?: string;
  readonly requestId: string;
  readonly token: CreateServiceAccountTokenInput;
}

export interface CreateServiceAccountRecordInput {
  readonly actorUserId: string;
  readonly effectiveUserId?: string;
  readonly requestId: string;
  readonly nickname: string;
}

export interface UpdateServiceAccountRecordInput {
  readonly actorUserId: string;
  readonly effectiveUserId?: string;
  readonly requestId: string;
  readonly enabled: boolean;
}

function parseDatabaseId(value: string): bigint | undefined {
  if (value.length === 0 || value.length > 19 || !databaseIdPattern.test(value)) {
    return undefined;
  }
  const parsed = BigInt(value);
  return parsed <= maximumDatabaseId ? parsed : undefined;
}

function requireDatabaseId(value: string, label: string): bigint {
  const parsed = parseDatabaseId(value);
  if (parsed === undefined) throw new Error(`${label}无效。`);
  return parsed;
}

function toIso(value: Date | string): string {
  return (value instanceof Date ? value : new Date(value)).toISOString();
}

function toNullableIso(value: Date | string | null): string | null {
  return value === null ? null : toIso(value);
}

function readStringArray(value: unknown): string[] {
  const parsed = typeof value === "string" ? JSON.parse(value) as unknown : value;
  if (!Array.isArray(parsed) || !parsed.every((item) => typeof item === "string")) {
    throw new Error("机器人令牌来源地址记录无效。");
  }
  return parsed;
}

async function robotExists(
  executor: DatabaseExecutor,
  userId: bigint,
  lock: boolean,
  activeOnly: boolean
): Promise<boolean> {
  const rows = await executor.query<{ id: string }>(lock
    ? sql`
        SELECT id::text AS id
        FROM users
        WHERE id = ${userId}
          AND account_type = 'robot'
          AND (${activeOnly} = false OR disabled_at IS NULL)
        FOR UPDATE
      `
    : sql`
        SELECT id::text AS id
        FROM users
        WHERE id = ${userId}
          AND account_type = 'robot'
          AND (${activeOnly} = false OR disabled_at IS NULL)
      `);
  return rows.length === 1;
}

async function activeTokenConfigured(
  executor: DatabaseExecutor,
  userId: bigint,
  now: Date
): Promise<boolean> {
  const rows = await executor.query<{ configured: boolean }>(sql`
    SELECT EXISTS (
      SELECT 1 FROM api_tokens
      WHERE user_id = ${userId}
        AND revoked_at IS NULL
        AND (expires_at IS NULL OR expires_at > ${now.toISOString()}::timestamptz)
    ) AS configured
  `);
  return rows[0]?.configured === true;
}

async function readTokens(
  executor: DatabaseExecutor,
  userId: bigint,
  tokenId?: string
): Promise<ServiceAccountToken[]> {
  const rows = await executor.query<TokenRow>(tokenId === undefined
    ? sql`
        SELECT id::text AS id, name, token_prefix, source_cidrs, expires_at,
               last_used_at, revoked_at, created_at
        FROM api_tokens
        WHERE user_id = ${userId}
        ORDER BY created_at DESC, id
      `
    : sql`
        SELECT id::text AS id, name, token_prefix, source_cidrs, expires_at,
               last_used_at, revoked_at, created_at
        FROM api_tokens
        WHERE user_id = ${userId} AND id = ${tokenId}::uuid
      `);
  if (rows.length === 0) return [];

  const permissionRows = await executor.query<TokenPermissionRow>(tokenId === undefined
    ? sql`
        SELECT permission.token_id::text AS token_id, permission.permission_name
        FROM api_token_permissions permission
        JOIN api_tokens token ON token.id = permission.token_id
        WHERE token.user_id = ${userId}
          AND permission.effect = 'allow'
          AND permission.scope = 'global'
        ORDER BY permission.permission_name, permission.id
      `
    : sql`
        SELECT token_id::text AS token_id, permission_name
        FROM api_token_permissions
        WHERE token_id = ${tokenId}::uuid
          AND effect = 'allow'
          AND scope = 'global'
        ORDER BY permission_name, id
      `);
  const permissionsByToken = new Map<string, string[]>();
  for (const permission of permissionRows) {
    const names = permissionsByToken.get(permission.token_id) ?? [];
    names.push(permission.permission_name);
    permissionsByToken.set(permission.token_id, names);
  }

  return rows.map((row) => serviceAccountTokenSchema.parse({
    id: row.id,
    name: row.name,
    displayPrefix: row.token_prefix,
    permissions: permissionsByToken.get(row.id) ?? [],
    sourceCidrs: readStringArray(row.source_cidrs),
    expiresAt: toNullableIso(row.expires_at),
    lastUsedAt: toNullableIso(row.last_used_at),
    revokedAt: toNullableIso(row.revoked_at),
    createdAt: toIso(row.created_at)
  }));
}

async function insertToken(
  transaction: DatabaseExecutor,
  userId: bigint,
  operation: CreateServiceAccountTokenRecordInput,
  now: () => Date,
  action: "service_account.token.create" | "service_account.token.rotate"
): Promise<CreatedServiceAccountToken> {
  const input = createServiceAccountTokenInputSchema.parse(operation.token);
  if (input.expiresAt !== null && Date.parse(input.expiresAt) <= now().getTime()) {
    throw new Error("机器人令牌的到期时间必须晚于当前时间。");
  }
  const sourceCidrs = [...input.sourceCidrs];
  const permissions = [...input.permissions].sort();
  const actorUserId = requireDatabaseId(operation.actorUserId, "令牌创建者编号");
  const tokenId = randomUUID();
  const created = createApiToken();
  await transaction.execute(sql`
    INSERT INTO api_tokens (
      id, user_id, name, token_prefix, token_digest, source_cidrs,
      expires_at, created_by_user_id
    ) VALUES (
      ${tokenId}::uuid, ${userId}, ${input.name}, ${created.displayPrefix},
      ${created.digest}, ${JSON.stringify(sourceCidrs)}::jsonb,
      ${input.expiresAt}::timestamptz, ${actorUserId}
    )
  `);
  for (const permission of permissions) {
    await transaction.execute(sql`
      INSERT INTO api_token_permissions (
        id, token_id, permission_name, effect, scope
      ) VALUES (
        ${randomUUID()}::uuid, ${tokenId}::uuid, ${permission}, 'allow', 'global'
      )
    `);
  }
  await transaction.execute(sql`
    INSERT INTO audit_events (
      actor_user_id, subject_user_id, request_id, action, object_type,
      object_id, result, metadata
    ) VALUES (
      ${actorUserId}, ${userId}, ${operation.requestId}::uuid,
      ${action}, 'api_token', ${tokenId}, 'success',
      ${JSON.stringify({
        permissionCount: permissions.length,
        sourceCidrCount: sourceCidrs.length,
        hasExpiry: input.expiresAt !== null,
        ...(operation.effectiveUserId === undefined || operation.effectiveUserId === operation.actorUserId
          ? {}
          : { effectiveUserId: operation.effectiveUserId })
      })}::jsonb
    )
  `);
  const item = (await readTokens(transaction, userId, tokenId))[0];
  if (item === undefined) throw new Error("机器人令牌创建后无法读取。");
  return createdServiceAccountTokenSchema.parse({ item, token: created.token });
}
export class DatabaseServiceAccountTokenStore {
  public constructor(
    private readonly database: DatabaseHandle,
    private readonly now: () => Date = () => new Date()
  ) {}

  /** Missing and non-robot accounts look absent; disabled robots remain manageable. */
  public async listTokens(serviceAccountUserId: string): Promise<ServiceAccountTokenList | undefined> {
    const userId = parseDatabaseId(serviceAccountUserId);
    if (userId === undefined) return undefined;
    return this.database.transaction(async (transaction) => {
      if (!await robotExists(transaction, userId, false, false)) return undefined;
      return serviceAccountTokenListSchema.parse({ items: await readTokens(transaction, userId) });
    });
  }

  public async createAccount(
    operation: CreateServiceAccountRecordInput
  ): Promise<AdminServiceAccount> {
    const actorUserId = requireDatabaseId(operation.actorUserId, "机器人账号创建者编号");
    const nickname = operation.nickname.trim();
    if (nickname.length === 0 || nickname.length > 120) {
      throw new Error("机器人账号名称无效。");
    }
    return this.database.transaction(async (transaction) => {
      const roleRows = await transaction.query<{ id: string }>(sql`
        SELECT role.id::text AS id
        FROM role_defaults defaults
        JOIN roles role ON role.key = defaults.robot_role_key
        WHERE defaults.id = 'global'
        LIMIT 1
      `);
      const roleId = roleRows[0]?.id;
      if (roleId === undefined) throw new Error("机器人默认角色尚未初始化。");
      const inserted = await transaction.query<{ id: string }>(sql`
        INSERT INTO users (nickname, account_type)
        VALUES (${nickname}, 'robot')
        RETURNING id::text AS id
      `);
      const userId = inserted[0]?.id;
      if (userId === undefined) throw new Error("机器人账号创建后无法读取编号。");
      const databaseUserId = requireDatabaseId(userId, "机器人账号编号");
      await transaction.execute(sql`
        INSERT INTO role_memberships (id, user_id, role_id, granted_by_user_id, reason)
        VALUES (
          ${randomUUID()}::uuid,
          ${databaseUserId},
          ${roleId}::uuid,
          ${actorUserId},
          '创建机器人服务账号'
        )
      `);
      await transaction.execute(sql`
        INSERT INTO audit_events (
          actor_user_id, subject_user_id, request_id, action, object_type,
          object_id, result, metadata
        ) VALUES (
          ${actorUserId}, ${databaseUserId}, ${operation.requestId}::uuid,
          'service_account.create', 'user', ${userId}, 'success',
          ${JSON.stringify(
            operation.effectiveUserId === undefined || operation.effectiveUserId === operation.actorUserId
              ? {}
              : { effectiveUserId: operation.effectiveUserId }
          )}::jsonb
        )
      `);
      return adminServiceAccountSchema.parse({
        id: userId,
        nickname,
        accountType: "robot",
        enabled: true,
        tokenConfigured: false
      });
    });
  }

  public async updateAccount(
    serviceAccountUserId: string,
    operation: UpdateServiceAccountRecordInput
  ): Promise<AdminServiceAccount | undefined> {
    const userId = parseDatabaseId(serviceAccountUserId);
    if (userId === undefined) return undefined;
    const actorUserId = requireDatabaseId(operation.actorUserId, "机器人账号管理者编号");
    return this.database.transaction(async (transaction) => {
      const rows = await transaction.query<{ nickname: string }>(sql`
        SELECT nickname
        FROM users
        WHERE id = ${userId} AND account_type = 'robot'
        FOR UPDATE
      `);
      const account = rows[0];
      if (account === undefined) return undefined;
      const now = this.now();
      if (operation.enabled) {
        await transaction.execute(sql`
          UPDATE users SET disabled_at = NULL WHERE id = ${userId} AND account_type = 'robot'
        `);
      } else {
        await transaction.execute(sql`
          UPDATE users SET disabled_at = ${now.toISOString()}::timestamptz
          WHERE id = ${userId} AND account_type = 'robot'
        `);
        await transaction.execute(sql`
          UPDATE api_tokens SET revoked_at = ${now.toISOString()}::timestamptz
          WHERE user_id = ${userId} AND revoked_at IS NULL
        `);
      }
      await transaction.execute(sql`
        INSERT INTO audit_events (
          actor_user_id, subject_user_id, request_id, action, object_type,
          object_id, result, metadata
        ) VALUES (
          ${actorUserId}, ${userId}, ${operation.requestId}::uuid,
          'service_account.status.update', 'user', ${serviceAccountUserId}, 'success',
          ${JSON.stringify({
            enabled: operation.enabled,
            ...(operation.effectiveUserId === undefined || operation.effectiveUserId === operation.actorUserId
              ? {}
              : { effectiveUserId: operation.effectiveUserId })
          })}::jsonb
        )
      `);
      return adminServiceAccountSchema.parse({
        id: serviceAccountUserId,
        nickname: account.nickname,
        accountType: "robot",
        enabled: operation.enabled,
        tokenConfigured: operation.enabled && await activeTokenConfigured(transaction, userId, now)
      });
    });
  }

  /**
   * The raw token exists only in this return value. The database receives its
   * display prefix and SHA-256 digest; the audit event receives neither.
   */
  public async createToken(
    serviceAccountUserId: string,
    operation: CreateServiceAccountTokenRecordInput
  ): Promise<CreatedServiceAccountToken | undefined> {
    const userId = parseDatabaseId(serviceAccountUserId);
    if (userId === undefined) return undefined;
    return this.database.transaction(async (transaction) => {
      if (!await robotExists(transaction, userId, true, true)) return undefined;
      return insertToken(transaction, userId, operation, this.now, "service_account.token.create");
    });
  }

  /**
   * Rotation creates and audits the replacement before revoking the old token
   * in the same transaction. The replacement secret is returned only here.
   */
  public async rotateToken(
    serviceAccountUserId: string,
    tokenId: string,
    operation: CreateServiceAccountTokenRecordInput
  ): Promise<CreatedServiceAccountToken | undefined> {
    const userId = parseDatabaseId(serviceAccountUserId);
    if (userId === undefined || !uuidPattern.test(tokenId)) return undefined;
    return this.database.transaction(async (transaction) => {
      if (!await robotExists(transaction, userId, true, true)) return undefined;
      const activeToken = await transaction.query<{ id: string }>(sql`
        SELECT id::text AS id
        FROM api_tokens
        WHERE id = ${tokenId}::uuid
          AND user_id = ${userId}
          AND revoked_at IS NULL
        FOR UPDATE
      `);
      if (activeToken.length !== 1) return undefined;
      const replacement = await insertToken(
        transaction,
        userId,
        operation,
        this.now,
        "service_account.token.rotate"
      );
      const revoked = await transaction.query<{ id: string }>(sql`
        UPDATE api_tokens
        SET revoked_at = ${this.now().toISOString()}::timestamptz
        WHERE id = ${tokenId}::uuid
          AND user_id = ${userId}
          AND revoked_at IS NULL
        RETURNING id::text AS id
      `);
      if (revoked.length !== 1) {
        throw new Error("机器人令牌轮换时旧令牌状态发生变化。");
      }
      return replacement;
    });
  }

  /** Cross-account, missing, malformed, and already-revoked targets all look absent. */
  public async revokeToken(
    serviceAccountUserId: string,
    tokenId: string,
    actorUserId: string,
    requestId: string,
    effectiveUserId?: string
  ): Promise<ServiceAccountToken | undefined> {
    const userId = parseDatabaseId(serviceAccountUserId);
    if (userId === undefined || !uuidPattern.test(tokenId)) return undefined;
    return this.database.transaction(async (transaction) => {
      if (!await robotExists(transaction, userId, true, false)) return undefined;
      const revoked = await transaction.query<{ id: string }>(sql`
        UPDATE api_tokens
        SET revoked_at = ${this.now().toISOString()}::timestamptz
        WHERE id = ${tokenId}::uuid
          AND user_id = ${userId}
          AND revoked_at IS NULL
        RETURNING id::text AS id
      `);
      if (revoked.length !== 1) return undefined;
      const actorId = requireDatabaseId(actorUserId, "令牌撤销者编号");
      await transaction.execute(sql`
        INSERT INTO audit_events (
          actor_user_id, subject_user_id, request_id, action, object_type,
          object_id, result, metadata
        ) VALUES (
          ${actorId}, ${userId}, ${requestId}::uuid,
          'service_account.token.revoke', 'api_token', ${tokenId}, 'success',
          ${JSON.stringify(
            effectiveUserId === undefined || effectiveUserId === actorUserId ? {} : { effectiveUserId }
          )}::jsonb
        )
      `);
      const item = (await readTokens(transaction, userId, tokenId))[0];
      if (item === undefined) throw new Error("机器人令牌撤销后无法读取。");
      return item;
    });
  }
}
