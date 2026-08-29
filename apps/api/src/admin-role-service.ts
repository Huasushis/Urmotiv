import { randomUUID } from "node:crypto";
import {
  corePermissions,
  type AdminRoleDefaults,
  type CreateAdminRoleInput,
  type PermissionGrant,
  type UpdateAdminRoleDefaultsInput,
  type UpdateAdminRoleInput
} from "@urmotiv/contracts";
import { builtinRoleDefinitions, type DatabaseHandle } from "@urmotiv/database";
import { sql, type SQL } from "drizzle-orm";
import type { StoredUser } from "./domain";
import { ApiError, conflict, notFound } from "./errors";
import { hasPermission } from "./permissions";
import { loadUsers } from "./database-store";

export interface StoredAdminRolePermission {
  readonly name: string;
  readonly effect: "allow" | "deny";
}

export interface StoredAdminRole {
  readonly id: string;
  readonly key: string;
  readonly displayName: string;
  readonly description: string;
  readonly isBuiltIn: boolean;
  readonly revision: number;
  readonly permissions: readonly StoredAdminRolePermission[];
  readonly memberIds: readonly string[];
}

export interface AdminRoleMutationContext {
  readonly actorUserId: string;
  readonly requestId: string;
  readonly actorIsRoot?: boolean;
  readonly auditActorUserId?: string;
  readonly actorAllowCeiling: readonly string[];
  readonly actorDeniedPermissions: readonly string[];
}

export interface RoleManagementStore {
  listRoles(): Promise<StoredAdminRole[]>;
  getRoleDefaults(): Promise<AdminRoleDefaults>;
  updateRoleDefaults(
    input: UpdateAdminRoleDefaultsInput,
    context: AdminRoleMutationContext
  ): Promise<AdminRoleDefaults>;
  createRole(input: CreateAdminRoleInput, context: AdminRoleMutationContext): Promise<StoredAdminRole>;
  updateRole(
    roleId: string,
    input: UpdateAdminRoleInput,
    context: AdminRoleMutationContext
  ): Promise<StoredAdminRole>;
}

function cloneRole(role: StoredAdminRole): StoredAdminRole {
  return {
    ...role,
    permissions: role.permissions.map((permission) => ({ ...permission })),
    memberIds: [...role.memberIds]
  };
}

function isActiveGrant(grant: PermissionGrant, now: Date): boolean {
  if (grant.expiresAt === undefined) return true;
  const expiresAt = Date.parse(grant.expiresAt);
  return Number.isFinite(expiresAt) && expiresAt > now.getTime();
}
export function createAdminRoleMutationContext(
  user: StoredUser,
  requestId: string,
  now = new Date(),
  auditActorUserId?: string
): AdminRoleMutationContext {
  const actorAllowCeiling = corePermissions.filter((permission) =>
    hasPermission(user, permission, {}, now)
  );
  const actorDeniedPermissions = [
    ...new Set(
      user.grants
        .filter((grant) =>
          grant.effect === "deny" &&
          grant.scope === "global" &&
          isActiveGrant(grant, now)
        )
        .map((grant) => grant.permission)
    )
  ];
  return {
    actorUserId: user.id,
    requestId,
    actorIsRoot: user.isRoot && user.id === "0",
    actorAllowCeiling,
    actorDeniedPermissions,
    ...(auditActorUserId === undefined ? {} : { auditActorUserId })
  };
}

function rolePermissionNames(input: readonly StoredAdminRolePermission[]): Set<string> {
  return new Set(input.map((permission) => `${permission.name}\u0000${permission.effect}`));
}

export function assertRoleMutationSafety(
  input: Pick<CreateAdminRoleInput, "permissions" | "userIds">,
  context: AdminRoleMutationContext,
  role?: Pick<StoredAdminRole, "key" | "isBuiltIn">
): void {
  const memberIds = [...new Set(input.userIds)];
  const actorIsRoot = context.actorIsRoot ?? context.actorUserId === "0";
  if (memberIds.includes("0") && role?.key !== "root") {
    throw new ApiError(403, "ROLE_ROOT_MEMBERSHIP", "bootstrap root 账号只能属于 root 角色。");
  }
  if (role?.key === "root" && (
    !role.isBuiltIn ||
    memberIds.length !== 1 ||
    memberIds[0] !== "0"
  )) {
    throw new ApiError(403, "ROLE_ROOT_MEMBERSHIP", "root 角色成员固定为 bootstrap root 账号。");
  }
  if (!actorIsRoot && (
    role?.key === "root" ||
    input.permissions.some((permission) => permission.name === "user.impersonate")
  )) {
    throw new ApiError(403, "ROLE_ROOT_PRIVILEGE", "只有 root 可以管理 root 等价权限。");
  }
  const allowCeiling = new Set(context.actorAllowCeiling);
  const explicitDenies = new Set(context.actorDeniedPermissions);
  for (const permission of input.permissions) {
    if (permission.effect !== "allow") continue;
    if (explicitDenies.has(permission.name)) {
      throw new ApiError(403, "ROLE_PERMISSION_DENIED", "不能通过角色绕过调用者已有的明确拒绝。");
    }
    if (!allowCeiling.has(permission.name)) {
      throw new ApiError(403, "ROLE_PERMISSION_CEILING", "角色权限不能超出调用者当前的允许权限上限。");
    }
  }
}

export class InMemoryRoleManagementStore implements RoleManagementStore {
  private readonly roles: StoredAdminRole[];
  private defaults: AdminRoleDefaults = {
    humanRoleKey: "contributor",
    robotRoleKey: "reviewer",
    revision: 1
  };

  public constructor(memberIdsByRoleKey: Readonly<Record<string, readonly string[]>> = {}) {
    this.roles = builtinRoleDefinitions.map((role, index) => ({
      id: `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
      key: role.key,
      displayName: role.displayName,
      description: role.description,
      isBuiltIn: true,
      revision: 1,
      permissions: role.permissions.map((name) => ({ name, effect: "allow" as const })),
      memberIds: role.key === "root" ? ["0"] : [...(memberIdsByRoleKey[role.key] ?? [])]
    }));
  }

  public async listRoles(): Promise<StoredAdminRole[]> {
    return this.roles.map(cloneRole);
  }

  public async getRoleDefaults(): Promise<AdminRoleDefaults> {
    return { ...this.defaults };
  }

  public async updateRoleDefaults(
    input: UpdateAdminRoleDefaultsInput,
    context: AdminRoleMutationContext
  ): Promise<AdminRoleDefaults> {
    const actorIsRoot = context.actorIsRoot ?? context.actorUserId === "0";
    if (!actorIsRoot) throw notFound();
    if (this.defaults.revision !== input.expectedRevision) {
      throw conflict("默认角色已被其他管理员修改，请刷新后重试。");
    }
    if (!this.roles.some((role) => role.key === input.humanRoleKey) ||
        !this.roles.some((role) => role.key === input.robotRoleKey)) {
      throw new ApiError(422, "ROLE_DEFAULT_UNKNOWN", "默认角色不存在。");
    }
    this.defaults = {
      humanRoleKey: input.humanRoleKey,
      robotRoleKey: input.robotRoleKey,
      revision: this.defaults.revision + 1
    };
    return { ...this.defaults };
  }


  public async createRole(input: CreateAdminRoleInput, context: AdminRoleMutationContext): Promise<StoredAdminRole> {
    assertRoleMutationSafety(input, context);
    if (this.roles.some((role) => role.key === input.key)) {
      throw conflict("角色标识已存在，请换一个标识。");
    }
    const role: StoredAdminRole = {
      id: randomUUID(),
      key: input.key,
      displayName: input.displayName,
      description: input.description,
      isBuiltIn: false,
      revision: 1,
      permissions: input.permissions.map((permission) => ({ ...permission })),
      memberIds: [...input.userIds]
    };
    this.roles.push(role);
    return cloneRole(role);
  }

  public async updateRole(
    roleId: string,
    input: UpdateAdminRoleInput,
    context: AdminRoleMutationContext
  ): Promise<StoredAdminRole> {
    const index = this.roles.findIndex((role) => role.id === roleId);
    if (index < 0) throw notFound();
    const current = this.roles[index]!;
    assertRoleMutationSafety(input, context, current);
    if (current.revision !== input.expectedRevision) {
      throw conflict("角色已被其他管理员修改，请刷新后重试。");
    }
    if (this.roles.some((role) => role.id !== roleId && role.key === input.key)) {
      throw conflict("角色标识已存在，请换一个标识。");
    }
    if (current.isBuiltIn && (
      current.key === "root" ||
      current.key !== input.key ||
      current.displayName !== input.displayName ||
      current.description !== input.description
    )) {
      throw new ApiError(409, "BUILTIN_ROLE_METADATA_IMMUTABLE", "内置角色标识和说明不可修改。");
    }
    const next: StoredAdminRole = {
      ...current,
      key: input.key,
      displayName: input.displayName,
      description: input.description,
      revision: current.revision + 1,
      permissions: input.permissions.map((permission) => ({ ...permission })),
      memberIds: [...input.userIds]
    };
    this.roles[index] = next;
    return cloneRole(next);
  }
}

interface RoleRow extends Record<string, unknown> {
  id: string;
  key: string;
  display_name: string;
  description: string;
  is_built_in: boolean;
  revision: number;
}

interface GrantRow extends Record<string, unknown> {
  role_id: string;
  permission_name: string;
  effect: "allow" | "deny";
}

interface MemberRow extends Record<string, unknown> {
  role_id: string;
  user_id: string;
}

interface RoleExecutor {
  query<T extends Record<string, unknown>>(query: SQL): Promise<T[]>;
  execute(query: SQL): Promise<unknown>;
}

function databaseId(value: string): bigint {
  if (!/^(0|[1-9]\d*)$/.test(value)) {
    throw new ApiError(422, "ROLE_USER_INVALID", "角色成员编号无效。");
  }
  return BigInt(value);
}

function uniqueSortedUserIds(userIds: readonly string[]): string[] {
  return [...new Set(userIds)].sort((left, right) => {
    const a = databaseId(left);
    const b = databaseId(right);
    return a < b ? -1 : a > b ? 1 : 0;
  });
}

function sameUserIds(left: readonly string[], right: readonly string[]): boolean {
  const a = uniqueSortedUserIds(left);
  const b = uniqueSortedUserIds(right);
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

function sqlList(values: readonly string[], cast?: "uuid"): SQL {
  return sql.join(
    values.map((value) => cast === "uuid" ? sql`${value}::uuid` : sql`${databaseId(value)}`),
    sql`, `
  );
}

function buildRoles(
  roleRows: readonly RoleRow[],
  grantRows: readonly GrantRow[],
  memberRows: readonly MemberRow[]
): StoredAdminRole[] {
  const grants = new Map<string, StoredAdminRolePermission[]>();
  const members = new Map<string, string[]>();
  for (const row of grantRows) {
    const list = grants.get(row.role_id) ?? [];
    list.push({ name: row.permission_name, effect: row.effect });
    grants.set(row.role_id, list);
  }
  for (const row of memberRows) {
    const list = members.get(row.role_id) ?? [];
    list.push(row.user_id);
    members.set(row.role_id, list);
  }
  return roleRows.map((row) => ({
    id: row.id,
    key: row.key,
    displayName: row.display_name,
    description: row.description,
    isBuiltIn: row.is_built_in,
    revision: Number(row.revision),
    permissions: grants.get(row.id) ?? [],
    memberIds: members.get(row.id) ?? []
  }));
}

export class DatabaseRoleManagementStore implements RoleManagementStore {
  public constructor(private readonly database: DatabaseHandle) {}

  public async listRoles(): Promise<StoredAdminRole[]> {
    const [roleRows, grantRows, memberRows] = await Promise.all([
      this.database.query<RoleRow>(sql`
        SELECT id::text AS id, key, display_name, description, is_built_in, revision
        FROM roles ORDER BY is_built_in DESC, display_name, key
      `),
      this.database.query<GrantRow>(sql`
        SELECT subject_role_id::text AS role_id, permission_name, effect
        FROM permission_grants
        WHERE subject_role_id IS NOT NULL AND revoked_at IS NULL
          AND (expires_at IS NULL OR expires_at > now())
          AND scope = 'global'
        ORDER BY subject_role_id, permission_name, effect
      `),
      this.database.query<MemberRow>(sql`
        SELECT role_id::text AS role_id, user_id::text AS user_id
        FROM role_memberships
        WHERE revoked_at IS NULL AND (expires_at IS NULL OR expires_at > now())
        ORDER BY role_id, user_id
      `)
    ]);
    return buildRoles(roleRows, grantRows, memberRows);
  }
  public async getRoleDefaults(): Promise<AdminRoleDefaults> {
    const rows = await this.database.query<{
      human_role_key: string;
      robot_role_key: string;
      revision: number;
    }>(sql`
      SELECT human_role_key, robot_role_key, revision
      FROM role_defaults
      WHERE id = 'global'
    `);
    const row = rows[0];
    return {
      humanRoleKey: row?.human_role_key ?? "contributor",
      robotRoleKey: row?.robot_role_key ?? "reviewer",
      revision: Number(row?.revision ?? 1)
    };
  }

  public async updateRoleDefaults(
    input: UpdateAdminRoleDefaultsInput,
    context: AdminRoleMutationContext
  ): Promise<AdminRoleDefaults> {
    const actorIsRoot = context.actorIsRoot ?? context.actorUserId === "0";
    if (!actorIsRoot) throw notFound();
    const actorId = databaseId(context.actorUserId);
    return this.database.transaction(async (transaction) => {
      const currentRows = await transaction.query<{
        human_role_key: string;
        robot_role_key: string;
        revision: number;
      }>(sql`
        SELECT human_role_key, robot_role_key, revision
        FROM role_defaults
        WHERE id = 'global'
        FOR UPDATE
      `);
      const current = currentRows[0];
      if (current === undefined) throw new ApiError(503, "ROLE_DEFAULTS_UNAVAILABLE", "默认角色配置不可用。");
      if (Number(current.revision) !== input.expectedRevision) {
        throw conflict("默认角色已被其他管理员修改，请刷新后重试。");
      }
      const roleRows = await transaction.query<{ key: string }>(sql`
        SELECT key FROM roles WHERE key IN (${input.humanRoleKey}, ${input.robotRoleKey})
      `);
      if (roleRows.length !== new Set([input.humanRoleKey, input.robotRoleKey]).size) {
        throw new ApiError(422, "ROLE_DEFAULT_UNKNOWN", "默认角色不存在。");
      }
      await transaction.execute(sql`
        UPDATE role_defaults
        SET human_role_key = ${input.humanRoleKey},
            robot_role_key = ${input.robotRoleKey},
            revision = revision + 1,
            updated_at = clock_timestamp(),
            updated_by_user_id = ${actorId}
        WHERE id = 'global'
      `);
      const next = await transaction.query<{ revision: number }>(sql`
        SELECT revision FROM role_defaults WHERE id = 'global'
      `);
      await this.writeAudit(transaction, context, "admin.role_defaults.update", "global");
      return {
        humanRoleKey: input.humanRoleKey,
        robotRoleKey: input.robotRoleKey,
        revision: Number(next[0]?.revision ?? input.expectedRevision + 1)
      };
    });
  }

  public async createRole(input: CreateAdminRoleInput, context: AdminRoleMutationContext): Promise<StoredAdminRole> {
    const actorId = databaseId(context.actorUserId);
    assertRoleMutationSafety(input, context);
    const roleId = randomUUID();
    const affectedUsers = uniqueSortedUserIds([context.actorUserId, ...input.userIds]);
    return this.database.transaction(async (transaction) => {
      await this.lockAffectedUsers(transaction, affectedUsers);
      const refreshedContext = await this.reloadActorMutationContext(transaction, context);
      assertRoleMutationSafety(input, refreshedContext);
      const duplicate = await transaction.query<{ id: string }>(sql`SELECT id::text AS id FROM roles WHERE key = ${input.key}`);
      if (duplicate[0] !== undefined) throw conflict("角色标识已存在，请换一个标识。");
      await transaction.execute(sql`
        INSERT INTO roles (id, key, display_name, description, is_built_in, revision, created_by_user_id)
        VALUES (${roleId}::uuid, ${input.key}, ${input.displayName}, ${input.description}, false, 1, ${actorId})
      `);
      await this.replacePermissions(transaction, roleId, input.permissions, actorId, refreshedContext.requestId);
      await this.replaceMembers(transaction, roleId, input.userIds, actorId);
      await this.writeAudit(transaction, refreshedContext, "admin.role.create", roleId);
      return this.readRole(transaction, roleId);
    });
  }

  public async updateRole(
    roleId: string,
    input: UpdateAdminRoleInput,
    context: AdminRoleMutationContext
  ): Promise<StoredAdminRole> {
    const actorId = databaseId(context.actorUserId);
    const initial = await this.readRole(this.database, roleId);
    const affectedUsers = uniqueSortedUserIds([
      context.actorUserId,
      ...initial.memberIds,
      ...input.userIds
    ]);
    return this.database.transaction(async (transaction) => {
      await this.lockAffectedUsers(transaction, affectedUsers);
      const refreshedContext = await this.reloadActorMutationContext(transaction, context);
      const current = await this.lockRoleState(transaction, roleId);
      if (current.revision !== initial.revision || !sameUserIds(current.memberIds, initial.memberIds)) {
        throw conflict("角色成员或修订号已被其他管理员修改，请刷新后重试。");
      }
      assertRoleMutationSafety(input, refreshedContext, current);
      if (current.revision !== input.expectedRevision) {
        throw conflict("角色已被其他管理员修改，请刷新后重试。");
      }
      const duplicate = await transaction.query<{ id: string }>(sql`
        SELECT id::text AS id FROM roles WHERE key = ${input.key} AND id <> ${roleId}::uuid
      `);
      if (duplicate[0] !== undefined) throw conflict("角色标识已存在，请换一个标识。");
      if (current.isBuiltIn && (
        current.key === "root" ||
        current.key !== input.key ||
        current.displayName !== input.displayName ||
        current.description !== input.description
      )) {
        throw new ApiError(409, "BUILTIN_ROLE_METADATA_IMMUTABLE", "内置角色标识和说明不可修改。");
      }
      await transaction.execute(sql`
        UPDATE roles SET key = ${input.key}, display_name = ${input.displayName}, description = ${input.description},
          revision = revision + 1, updated_at = now()
        WHERE id = ${roleId}::uuid
      `);
      if (current.key !== "root") {
        await transaction.execute(sql`
          UPDATE permission_grants SET revoked_at = now(), revoked_by_user_id = ${actorId}
          WHERE subject_role_id = ${roleId}::uuid AND revoked_at IS NULL
        `);
        await this.replacePermissions(transaction, roleId, input.permissions, actorId, context.requestId);
      }
      await this.replaceMembers(transaction, roleId, input.userIds, actorId);
      await this.writeAudit(transaction, refreshedContext, "admin.role.update", roleId);
      return this.readRole(transaction, roleId);
    });
  }

  private async lockAffectedUsers(executor: RoleExecutor, userIds: readonly string[]): Promise<void> {
    const sortedIds = uniqueSortedUserIds(userIds);
    if (sortedIds.length === 0) return;
    const rows = await executor.query<{ id: string }>(sql`
      SELECT id::text AS id
      FROM users
      WHERE id IN (${sqlList(sortedIds)})
      ORDER BY id
      FOR UPDATE
    `);
    if (rows.length !== sortedIds.length) {
      throw new ApiError(422, "ROLE_USER_NOT_FOUND", "角色成员中包含不存在的账号。");
    }
  }

  private async reloadActorMutationContext(
    executor: RoleExecutor,
    context: AdminRoleMutationContext
  ): Promise<AdminRoleMutationContext> {
    const actor = (await loadUsers(executor, [databaseId(context.actorUserId)]))[0];
    if (actor === undefined || actor.accountType !== "human") {
      throw notFound();
    }
    if (!hasPermission(actor, "user.permission.manage", {}, new Date())) {
      throw notFound();
    }
    return createAdminRoleMutationContext(actor, context.requestId, new Date(), context.auditActorUserId);
  }
  private async lockRoleState(executor: RoleExecutor, roleId: string): Promise<StoredAdminRole> {
    const rows = await executor.query<{ id: string }>(sql`
      SELECT id::text AS id FROM roles WHERE id = ${roleId}::uuid FOR UPDATE
    `);
    if (rows[0] === undefined) throw notFound();
    await executor.query<{ id: string }>(sql`
      SELECT id::text AS id
      FROM permission_grants
      WHERE subject_role_id = ${roleId}::uuid
      ORDER BY id
      FOR UPDATE
    `);
    await executor.query<{ id: string }>(sql`
      SELECT id::text AS id
      FROM role_memberships
      WHERE role_id = ${roleId}::uuid
      ORDER BY id
      FOR UPDATE
    `);
    return this.readRole(executor, roleId);
  }

  private async replacePermissions(
    executor: RoleExecutor,
    roleId: string,
    permissions: readonly { name: string; effect: "allow" | "deny" }[],
    actorId: bigint,
    requestId: string
  ): Promise<void> {
    for (const permission of permissions) {
      await executor.execute(sql`
        INSERT INTO permission_grants (
          id, subject_role_id, permission_name, effect, scope, granted_by_user_id, reason
        ) VALUES (
          ${randomUUID()}::uuid, ${roleId}::uuid, ${permission.name}, ${permission.effect}::permission_effect,
          'global'::permission_scope, ${actorId}, ${`管理员角色设置（${requestId}）`}
        )
      `);
    }
  }

  private async replaceMembers(executor: RoleExecutor, roleId: string, userIds: readonly string[], actorId: bigint): Promise<void> {
    const uniqueIds = [...new Set(userIds)];
    if (uniqueIds.length === 0) {
      await executor.execute(sql`
        UPDATE role_memberships SET revoked_at = now(), revoked_by_user_id = ${actorId}
        WHERE role_id = ${roleId}::uuid AND revoked_at IS NULL
      `);
      return;
    }
    await executor.execute(sql`
      UPDATE role_memberships SET revoked_at = now(), revoked_by_user_id = ${actorId}
      WHERE role_id = ${roleId}::uuid AND revoked_at IS NULL
        AND user_id NOT IN (${sqlList(uniqueIds)})
    `);
    for (const userId of uniqueIds) {
      await executor.execute(sql`
        INSERT INTO role_memberships (id, user_id, role_id, granted_by_user_id, reason)
        SELECT ${randomUUID()}::uuid, ${databaseId(userId)}, ${roleId}::uuid, ${actorId}, '管理员角色设置'
        WHERE NOT EXISTS (
          SELECT 1 FROM role_memberships
          WHERE user_id = ${databaseId(userId)} AND role_id = ${roleId}::uuid AND revoked_at IS NULL
        )
      `);
    }
  }

  private async readRole(executor: RoleExecutor, roleId: string): Promise<StoredAdminRole> {
    const [roleRows, grantRows, memberRows] = await Promise.all([
      executor.query<RoleRow>(sql`
        SELECT id::text AS id, key, display_name, description, is_built_in, revision
        FROM roles WHERE id = ${roleId}::uuid
      `),
      executor.query<GrantRow>(sql`
        SELECT subject_role_id::text AS role_id, permission_name, effect
        FROM permission_grants
        WHERE subject_role_id = ${roleId}::uuid AND revoked_at IS NULL
          AND (expires_at IS NULL OR expires_at > now()) AND scope = 'global'
        ORDER BY permission_name, effect
      `),
      executor.query<MemberRow>(sql`
        SELECT role_id::text AS role_id, user_id::text AS user_id
        FROM role_memberships
        WHERE role_id = ${roleId}::uuid AND revoked_at IS NULL
          AND (expires_at IS NULL OR expires_at > now())
        ORDER BY user_id
      `)
    ]);
    const role = buildRoles(roleRows, grantRows, memberRows)[0];
    if (role === undefined) throw notFound();
    return role;
  }

  private async writeAudit(executor: RoleExecutor, context: AdminRoleMutationContext, action: string, roleId: string): Promise<void> {
    const actorId = context.auditActorUserId ?? context.actorUserId;
    const metadata = context.auditActorUserId === undefined
      ? {}
      : { effectiveUserId: context.actorUserId };
    await executor.execute(sql`
      INSERT INTO audit_events (
        actor_user_id, request_id, action, object_type, object_id, result, reason_code, metadata
      ) VALUES (
        ${databaseId(actorId)}, ${context.requestId}::uuid, ${action}, 'role', ${roleId},
        'success', NULL, ${JSON.stringify(metadata)}::jsonb
      )
    `);
  }
}
