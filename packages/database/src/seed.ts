import { createHash } from "node:crypto";
import { corePermissions, type CorePermission } from "@urmotiv/contracts";
import { sql } from "drizzle-orm";
import type { DatabaseExecutor, DatabaseHandle } from "./client";

interface PermissionText {
  readonly displayName: string;
  readonly description: string;
}

const permissionText = {
  "auth.login": { displayName: "登录系统", description: "允许账号登录并使用系统。" },
  "user.create": { displayName: "创建账号", description: "允许创建一个或一批账号。" },
  "user.delete": { displayName: "停用账号", description: "允许停用或删除普通账号。" },
  "user.impersonate": {
    displayName: "模拟用户登录",
    description: "允许在排查问题时短暂以另一名用户的身份查看系统。"
  },
  "user.permission.manage": {
    displayName: "管理角色和权限",
    description: "允许分配角色以及单独允许或拒绝某项操作。"
  },
  "system.manage": {
    displayName: "管理系统设置",
    description: "允许修改认证、存储和其他重要运行设置。"
  },
  "plugin.manage": {
    displayName: "管理插件",
    description: "允许管理、启用、停用和配置受信任内置插件。"
  },
  "service_account.manage": {
    displayName: "管理机器人账号",
    description: "允许创建机器人账号并发放可撤销的接口令牌。"
  },
  "tag.manage": { displayName: "管理知识点", description: "允许修改知识点标签树。" },
  "audit.read": { displayName: "查看审计记录", description: "允许查看重要操作的记录。" },
  "review.policy.manage": {
    displayName: "管理审核策略",
    description: "允许修改新审核轮次使用的审核策略，不包含单题终审。"
  },
  "problem.create": { displayName: "创建题目", description: "允许新建题目草稿。" },
  "problem.view.own": { displayName: "查看自己的题目", description: "允许查看自己创建的题目。" },
  "problem.edit.own": {
    displayName: "编辑自己的题目",
    description: "允许修改自己题目中当前没有被冻结的内容。"
  },
  "problem.delete.own": {
    displayName: "删除自己的草稿",
    description: "允许删除自己尚未提交的草稿。"
  },
  "problem.view.all": {
    displayName: "查看全部题目",
    description: "允许查看题库中的题面，但单题拒绝仍然有效。"
  },
  "problem.edit.all": {
    displayName: "编辑全部题目",
    description: "允许修改有权查看题目中当前没有被冻结的内容。"
  },
  "problem.delete.all": {
    displayName: "删除题目",
    description: "允许把题目标记为已删除，并保留操作记录。"
  },
  "problem.review": {
    displayName: "提交审题意见",
    description: "允许对有权查看的待审题目提交意见。"
  },
  "problem.status.change": {
    displayName: "最终确认题目状态",
    description: "允许最终确认通过、不通过或强制撤回。"
  },
  "problem.frozen.edit": {
    displayName: "紧急修改冻结内容",
    description: "允许在填写原因后修改已冻结的名称、基础题面或基础题解。"
  },
  "problem.access.grant": {
    displayName: "设置单题访问权",
    description: "允许给指定用户单独授予或拒绝题目权限。"
  },
  "problem.viewers.read": {
    displayName: "查看题目访问记录",
    description: "允许查看谁读过题面以及累计活动时间。"
  },
  "problem.import": { displayName: "导入题目包", description: "允许导入完整题目包。" },
  "problem.export.own": {
    displayName: "导出自己的题目",
    description: "允许把自己的完整题目导出为题目包。"
  },
  "problem.export.all": {
    displayName: "导出任意可见题目",
    description: "允许导出有权查看的任意题目。"
  },
  "problem.testdata.read": {
    displayName: "读取内部评测资料",
    description: "允许下载测试数据、标准程序和内部附件。"
  },
  "problem.testdata.write": {
    displayName: "修改内部评测资料",
    description: "允许上传和配置测试数据、程序和内部附件。"
  },
  "contest.create": { displayName: "创建组题方案", description: "允许新建组题方案或比赛。" },
  "contest.edit.own": {
    displayName: "编辑自己的组题方案",
    description: "允许编辑自己创建的组题方案。"
  },
  "contest.edit.all": {
    displayName: "编辑全部组题方案",
    description: "允许编辑任意组题方案。"
  },
  "contest.delete": { displayName: "删除组题方案", description: "允许删除组题方案。" },
  "contest.export": {
    displayName: "导出比赛",
    description: "允许导出比赛信息及其中固定版本的题目。"
  },
  "contest.risk.read": {
    displayName: "查看泄题风险",
    description: "允许比较题目访问者和比赛参与者，帮助发现泄题风险。"
  }
} satisfies Record<CorePermission, PermissionText>;

const roleDefinitions = [
  {
    key: "contributor",
    displayName: "投稿人",
    description: "可以创建、查看和编辑自己的题目。",
    permissions: [
      "auth.login",
      "problem.create",
      "problem.view.own",
      "problem.edit.own",
      "problem.delete.own"
    ]
  },
  {
    key: "reviewer",
    displayName: "审题人",
    description: "可以查看待审题目并提交审题意见。",
    permissions: [
      "auth.login",
      "problem.create",
      "problem.view.own",
      "problem.edit.own",
      "problem.delete.own",
      "problem.view.all",
      "problem.review",
      "problem.testdata.read"
    ]
  },
  {
    key: "problem_setter",
    displayName: "命题组成员",
    description: "可以补充题目资料、组题并查看题目访问风险。",
    permissions: [
      "auth.login",
      "problem.create",
      "problem.view.own",
      "problem.edit.own",
      "problem.delete.own",
      "problem.view.all",
      "problem.review",
      "problem.testdata.read",
      "problem.edit.all",
      "problem.testdata.write",
      "problem.viewers.read",
      "contest.create",
      "contest.edit.own",
      "contest.risk.read"
    ]
  },
  {
    key: "leader",
    displayName: "组长",
    description: "可以最终确认题目状态、管理组题并导入导出题目。",
    permissions: [
      "auth.login",
      "problem.create",
      "problem.view.own",
      "problem.edit.own",
      "problem.delete.own",
      "problem.view.all",
      "problem.review",
      "problem.testdata.read",
      "problem.edit.all",
      "problem.testdata.write",
      "problem.viewers.read",
      "contest.create",
      "contest.edit.own",
      "problem.status.change",
      "review.policy.manage",
      "problem.access.grant",
      "problem.import",
      "problem.export.all",
      "contest.edit.all",
      "contest.delete",
      "contest.export",
      "tag.manage",
      "user.create"
    ]
  },
  {
    key: "system_administrator",
    displayName: "系统管理员",
    description: "可以管理账号、权限、运行设置、题库入口和插件，但不自动拥有最终审题权。",
    permissions: [
      "auth.login",
      "user.create",
      "user.delete",
      "user.permission.manage",
      "system.manage",
      "plugin.manage",
      "service_account.manage",
      "tag.manage",
      "audit.read",
      "review.policy.manage",
      "problem.view.all",
      "problem.import"
    ]
  },
  {
    key: "root",
    displayName: "root",
    description: "只用于首次配置和紧急恢复，拥有全部核心允许项。",
    permissions: [...corePermissions]
  }
] as const satisfies readonly {
  readonly key: string;
  readonly displayName: string;
  readonly description: string;
  readonly permissions: readonly CorePermission[];
}[];

export const corePermissionDefinitions = permissionText;
export const builtinRoleDefinitions = roleDefinitions;

export interface CoreSeedResult {
  readonly rootUserId: 0n;
  readonly roleKeys: readonly string[];
  readonly permissionNames: readonly CorePermission[];
}

export async function seedCoreDatabase(handle: DatabaseHandle): Promise<CoreSeedResult> {
  await handle.transaction(async (transaction) => {
    await transaction.execute(sql`
      INSERT INTO users (id, nickname, account_type, password_hash)
      VALUES (0, 'root', 'human', NULL)
      ON CONFLICT (id) DO NOTHING
    `);

    for (const permission of corePermissions) {
      const copy = permissionText[permission];
      await transaction.execute(sql`
        INSERT INTO permission_definitions (name, display_name, description, source)
        VALUES (${permission}, ${copy.displayName}, ${copy.description}, 'core')
        ON CONFLICT (name) DO UPDATE
        SET display_name = EXCLUDED.display_name,
            description = EXCLUDED.description,
            source = 'core'
      `);
    }

    for (const role of roleDefinitions) {
      const roleId = stableUuid(`role:${role.key}`);
      await transaction.execute(sql`
        INSERT INTO roles (id, key, display_name, description, is_built_in, created_by_user_id)
        VALUES (${roleId}::uuid, ${role.key}, ${role.displayName}, ${role.description}, true, 0)
        ON CONFLICT (id) DO NOTHING
      `);

      for (const permission of role.permissions) {
        const grantId = stableUuid(`role-grant:${role.key}:${permission}`);
        const scope = permission.endsWith(".own") ? "own" : "global";
        await transaction.execute(sql`
          INSERT INTO permission_grants (
            id,
            subject_role_id,
            permission_name,
            effect,
            scope,
            granted_by_user_id,
            reason
          )
          VALUES (
            ${grantId}::uuid,
            ${roleId}::uuid,
            ${permission},
            'allow',
            ${scope}::permission_scope,
            0,
            '内置角色的初始权限'
          )
          ON CONFLICT (id) DO NOTHING
        `);
      }
    }

    const rootRoleId = stableUuid("role:root");
    const rootMembershipId = stableUuid("role-membership:root:0");
    await transaction.execute(sql`
      INSERT INTO role_memberships (
        id,
        user_id,
        role_id,
        granted_by_user_id,
        reason
      )
      VALUES (${rootMembershipId}::uuid, 0, ${rootRoleId}::uuid, 0, '首次初始化 root 账号')
      ON CONFLICT (id) DO NOTHING
    `);
  });

  return {
    rootUserId: 0n,
    roleKeys: roleDefinitions.map((role) => role.key),
    permissionNames: corePermissions
  };
}

/**
 * Checks only the rows owned by seedCoreDatabase. Callers that use this as a
 * fresh-install guard must also prove that every other application table is empty.
 */
export async function hasExactDefaultCoreSeed(
  executor: DatabaseExecutor
): Promise<boolean> {
  const rootRows = await executor.query<{
    id: string;
    nickname: string;
    account_type: string;
    password_hash: string | null;
    auth_revision: number;
    password_changed_at_is_null: boolean;
    disabled_at_is_null: boolean;
    disabled_reason_is_null: boolean;
  }>(sql`
    SELECT
      id::text AS id,
      nickname,
      account_type::text AS account_type,
      password_hash,
      auth_revision::integer AS auth_revision,
      password_changed_at IS NULL AS password_changed_at_is_null,
      disabled_at IS NULL AS disabled_at_is_null,
      disabled_reason IS NULL AS disabled_reason_is_null
    FROM users
    ORDER BY id
  `);
  if (!sameRows(rootRows, [{
    id: "0",
    nickname: "root",
    account_type: "human",
    password_hash: null,
    auth_revision: 1,
    password_changed_at_is_null: true,
    disabled_at_is_null: true,
    disabled_reason_is_null: true
  }])) {
    return false;
  }

  const permissionRows = await executor.query<{
    name: string;
    display_name: string;
    description: string;
    source: string;
  }>(sql`
    SELECT name, display_name, description, source
    FROM permission_definitions
    ORDER BY name
  `);
  const expectedPermissions = corePermissions
    .map((name) => ({
      name,
      display_name: permissionText[name].displayName,
      description: permissionText[name].description,
      source: "core"
    }))
    .sort(compareNamedRows);
  if (!sameRows(permissionRows, expectedPermissions)) {
    return false;
  }

  const roleRows = await executor.query<{
    id: string;
    key: string;
    display_name: string;
    description: string;
    is_built_in: boolean;
    created_by_user_id: string | null;
  }>(sql`
    SELECT
      id::text AS id,
      key,
      display_name,
      description,
      is_built_in,
      created_by_user_id::text AS created_by_user_id
    FROM roles
    ORDER BY key
  `);
  const expectedRoles = roleDefinitions
    .map((role) => ({
      id: stableUuid(`role:${role.key}`),
      key: role.key,
      display_name: role.displayName,
      description: role.description,
      is_built_in: true,
      created_by_user_id: "0"
    }))
    .sort((left, right) => compareText(left.key, right.key));
  if (!sameRows(roleRows, expectedRoles)) {
    return false;
  }

  const grantRows = await executor.query<{
    id: string;
    subject_user_id: string | null;
    subject_role_id: string | null;
    permission_name: string;
    effect: string;
    scope: string;
    object_type: string | null;
    object_id: string | null;
    expires_at_is_null: boolean;
    granted_by_user_id: string;
    reason: string;
    revoked_at_is_null: boolean;
    revoked_by_user_id_is_null: boolean;
  }>(sql`
    SELECT
      id::text AS id,
      subject_user_id::text AS subject_user_id,
      subject_role_id::text AS subject_role_id,
      permission_name,
      effect::text AS effect,
      scope::text AS scope,
      object_type,
      object_id,
      expires_at IS NULL AS expires_at_is_null,
      granted_by_user_id::text AS granted_by_user_id,
      reason,
      revoked_at IS NULL AS revoked_at_is_null,
      revoked_by_user_id IS NULL AS revoked_by_user_id_is_null
    FROM permission_grants
    ORDER BY id
  `);
  const expectedGrants = roleDefinitions
    .flatMap((role) => role.permissions.map((permission) => ({
      id: stableUuid(`role-grant:${role.key}:${permission}`),
      subject_user_id: null,
      subject_role_id: stableUuid(`role:${role.key}`),
      permission_name: permission,
      effect: "allow",
      scope: permission.endsWith(".own") ? "own" : "global",
      object_type: null,
      object_id: null,
      expires_at_is_null: true,
      granted_by_user_id: "0",
      reason: "内置角色的初始权限",
      revoked_at_is_null: true,
      revoked_by_user_id_is_null: true
    })))
    .sort((left, right) => compareText(left.id, right.id));
  if (!sameRows(grantRows, expectedGrants)) {
    return false;
  }

  const membershipRows = await executor.query<{
    id: string;
    user_id: string;
    role_id: string;
    granted_by_user_id: string;
    reason: string;
    expires_at_is_null: boolean;
    revoked_at_is_null: boolean;
    revoked_by_user_id_is_null: boolean;
  }>(sql`
    SELECT
      id::text AS id,
      user_id::text AS user_id,
      role_id::text AS role_id,
      granted_by_user_id::text AS granted_by_user_id,
      reason,
      expires_at IS NULL AS expires_at_is_null,
      revoked_at IS NULL AS revoked_at_is_null,
      revoked_by_user_id IS NULL AS revoked_by_user_id_is_null
    FROM role_memberships
    ORDER BY id
  `);
  return sameRows(membershipRows, [{
    id: stableUuid("role-membership:root:0"),
    user_id: "0",
    role_id: stableUuid("role:root"),
    granted_by_user_id: "0",
    reason: "首次初始化 root 账号",
    expires_at_is_null: true,
    revoked_at_is_null: true,
    revoked_by_user_id_is_null: true
  }]);
}

function stableUuid(value: string): string {
  const digest = createHash("sha256").update(`urmotiv:${value}`, "utf8").digest("hex");
  return [
    digest.slice(0, 8),
    digest.slice(8, 12),
    `5${digest.slice(13, 16)}`,
    `a${digest.slice(17, 20)}`,
    digest.slice(20, 32)
  ].join("-");
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function compareNamedRows(
  left: { readonly name: string },
  right: { readonly name: string }
): number {
  return compareText(left.name, right.name);
}

function sameRows(actual: unknown, expected: unknown): boolean {
  return JSON.stringify(actual) === JSON.stringify(expected);
}
