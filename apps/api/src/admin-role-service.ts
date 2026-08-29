import { randomUUID } from "node:crypto";
import {
  type CreateAdminRoleInput,
  type UpdateAdminRoleInput
} from "@urmotiv/contracts";
import { builtinRoleDefinitions, type DatabaseHandle } from "@urmotiv/database";
import { sql, type SQL } from "drizzle-orm";
import { ApiError, conflict, notFound } from "./errors";

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
}

export interface RoleManagementStore {
  listRoles(): Promise<StoredAdminRole[]>;
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

function rolePermissionNames(input: readonly StoredAdminRolePermission[]): Set<string> {
  return new Set(input.map((permission) => `${permission.name}\u0000${permission.effect}`));
}

export class InMemoryRoleManagementStore implements RoleManagementStore {
  private readonly roles: StoredAdminRole[];

  public constructor(memberIdsByRoleKey: Readonly<Record<string, readonly string[]>> = {}) {
    this.roles = builtinRoleDefinitions.map((role, index) => ({
      id: `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
      key: role.key,
      displayName: role.displayName,
      description: role.description,
      isBuiltIn: true,
      revision: 1,
      permissions: role.permissions.map((name) => ({ name, effect: "allow" as const })),
      memberIds: [...(memberIdsByRoleKey[role.key] ?? [])]
    }));
  }

  public async listRoles(): Promise<StoredAdminRole[]> {
    return this.roles.map(cloneRole);
  }

  public async createRole(input: CreateAdminRoleInput, _context: AdminRoleMutationContext): Promise<StoredAdminRole> {
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
    _context: AdminRoleMutationContext
  ): Promise<StoredAdminRole> {
    const index = this.roles.findIndex((role) => role.id === roleId);
    if (index < 0) throw notFound();
    const current = this.roles[index]!;
    if (current.revision !== input.expectedRevision) {
      throw conflict("角色已被其他管理员修改，请刷新后重试。");
    }
    if (this.roles.some((role) => role.id !== roleId && role.key === input.key)) {
      throw conflict("角色标识已存在，请换一个标识。");
    }
    if (current.isBuiltIn && (
      current.key !== input.key ||
      current.displayName !== input.displayName ||
      current.description !== input.description ||
      rolePermissionNames(current.permissions).size !== rolePermissionNames(input.permissions).size ||
      [...rolePermissionNames(current.permissions)].some((permission) => !rolePermissionNames(input.permissions).has(permission))
    )) {
      throw new ApiError(409, "BUILTIN_ROLE_IMMUTABLE", "内置角色的名称和权限不可修改。请调整成员归属或新建自定义角色。");
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

  public async createRole(input: CreateAdminRoleInput, context: AdminRoleMutationContext): Promise<StoredAdminRole> {
    const actorId = databaseId(context.actorUserId);
    const roleId = randomUUID();
    return this.database.transaction(async (transaction) => {
      await this.assertUsersExist(transaction, input.userIds);
      const duplicate = await transaction.query<{ id: string }>(sql`SELECT id::text AS id FROM roles WHERE key = ${input.key}`);
      if (duplicate[0] !== undefined) throw conflict("角色标识已存在，请换一个标识。");
      await transaction.execute(sql`
        INSERT INTO roles (id, key, display_name, description, is_built_in, revision, created_by_user_id)
        VALUES (${roleId}::uuid, ${input.key}, ${input.displayName}, ${input.description}, false, 1, ${actorId})
      `);
      await this.replacePermissions(transaction, roleId, input.permissions, actorId, context.requestId);
      await this.replaceMembers(transaction, roleId, input.userIds, actorId);
      await this.writeAudit(transaction, context, "admin.role.create", roleId);
      return this.readRole(transaction, roleId);
    });
  }

  public async updateRole(
    roleId: string,
    input: UpdateAdminRoleInput,
    context: AdminRoleMutationContext
  ): Promise<StoredAdminRole> {
    const actorId = databaseId(context.actorUserId);
    return this.database.transaction(async (transaction) => {
      const rows = await transaction.query<RoleRow>(sql`
        SELECT id::text AS id, key, display_name, description, is_built_in, revision
        FROM roles WHERE id = ${roleId}::uuid FOR UPDATE
      `);
      const current = rows[0];
      if (current === undefined) throw notFound();
      if (Number(current.revision) !== input.expectedRevision) {
        throw conflict("角色已被其他管理员修改，请刷新后重试。");
      }
      await this.assertUsersExist(transaction, input.userIds);
      const duplicate = await transaction.query<{ id: string }>(sql`
        SELECT id::text AS id FROM roles WHERE key = ${input.key} AND id <> ${roleId}::uuid
      `);
      if (duplicate[0] !== undefined) throw conflict("角色标识已存在，请换一个标识。");
      if (current.is_built_in && (
        current.key !== input.key ||
        current.display_name !== input.displayName ||
        current.description !== input.description
      )) {
        throw new ApiError(409, "BUILTIN_ROLE_IMMUTABLE", "内置角色的名称和权限不可修改。请调整成员归属或新建自定义角色。");
      }
      if (current.is_built_in) {
        const existing = await transaction.query<GrantRow>(sql`
          SELECT subject_role_id::text AS role_id, permission_name, effect
          FROM permission_grants
          WHERE subject_role_id = ${roleId}::uuid AND revoked_at IS NULL
            AND (expires_at IS NULL OR expires_at > now()) AND scope = 'global'
        `);
        const existingNames = rolePermissionNames(existing.map((grant) => ({ name: grant.permission_name, effect: grant.effect })));
        const requestedNames = rolePermissionNames(input.permissions);
        if (existingNames.size !== requestedNames.size || [...existingNames].some((permission) => !requestedNames.has(permission))) {
          throw new ApiError(409, "BUILTIN_ROLE_IMMUTABLE", "内置角色的名称和权限不可修改。请调整成员归属或新建自定义角色。");
        }
      }
      await transaction.execute(sql`
        UPDATE roles SET key = ${input.key}, display_name = ${input.displayName}, description = ${input.description},
          revision = revision + 1, updated_at = now()
        WHERE id = ${roleId}::uuid
      `);
      if (!current.is_built_in) {
        await transaction.execute(sql`
          UPDATE permission_grants SET revoked_at = now(), revoked_by_user_id = ${actorId}
          WHERE subject_role_id = ${roleId}::uuid AND revoked_at IS NULL
        `);
        await this.replacePermissions(transaction, roleId, input.permissions, actorId, context.requestId);
      }
      await this.replaceMembers(transaction, roleId, input.userIds, actorId);
      await this.writeAudit(transaction, context, "admin.role.update", roleId);
      return this.readRole(transaction, roleId);
    });
  }

  private async assertUsersExist(executor: RoleExecutor, userIds: readonly string[]): Promise<void> {
    if (userIds.length === 0) return;
    const rows = await executor.query<{ id: string }>(sql`
      SELECT id::text AS id FROM users WHERE id IN (${sqlList(userIds)})
    `);
    if (rows.length !== new Set(userIds).size) {
      throw new ApiError(422, "ROLE_USER_NOT_FOUND", "角色成员中包含不存在的账号。");
    }
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
    await executor.execute(sql`
      INSERT INTO audit_events (
        actor_user_id, request_id, action, object_type, object_id, result, reason_code, metadata
      ) VALUES (
        ${databaseId(context.actorUserId)}, ${context.requestId}::uuid, ${action}, 'role', ${roleId},
        'success', NULL, '{}'::jsonb
      )
    `);
  }
}
