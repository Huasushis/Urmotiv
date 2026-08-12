import { createHash } from "node:crypto";
import type { DatabaseHandle } from "@urmotiv/database";
import { sql } from "drizzle-orm";
import { demoTags } from "./demo-data";

export const databaseDemoUserIds = {
  author: "9000000000000001",
  reviewer: "9000000000000002",
  member: "9000000000000003",
  leader: "9000000000000004",
  robot: "9000000000000005",
  denied: "9000000000000006",
  administrator: "9000000000000007",
} as const;

const demoUsers = [
  {
    id: databaseDemoUserIds.author,
    nickname: "投稿人演示账号",
    accountType: "human",
    roleKey: "contributor",
  },
  {
    id: databaseDemoUserIds.reviewer,
    nickname: "审题人演示账号",
    accountType: "human",
    roleKey: "reviewer",
  },
  {
    id: databaseDemoUserIds.member,
    nickname: "命题组成员演示账号",
    accountType: "human",
    roleKey: "problem_setter",
  },
  {
    id: databaseDemoUserIds.leader,
    nickname: "组长演示账号",
    accountType: "human",
    roleKey: "leader",
  },
  {
    id: databaseDemoUserIds.robot,
    nickname: "审核机器人演示账号",
    accountType: "robot",
    roleKey: "reviewer",
  },
  {
    id: databaseDemoUserIds.denied,
    nickname: "明确拒绝演示账号",
    accountType: "human",
    roleKey: "reviewer",
  },
  {
    id: databaseDemoUserIds.administrator,
    nickname: "系统管理员演示账号",
    accountType: "human",
    roleKey: "system_administrator",
  },
] as const;

function stableUuid(value: string): string {
  const digest = createHash("sha256").update(`urmotiv-demo:${value}`, "utf8").digest("hex");
  return [
    digest.slice(0, 8),
    digest.slice(8, 12),
    `5${digest.slice(13, 16)}`,
    `a${digest.slice(17, 20)}`,
    digest.slice(20, 32),
  ].join("-");
}

export async function seedDatabaseDemoData(handle: DatabaseHandle): Promise<void> {
  await handle.transaction(async (transaction) => {
    // 1. 演示用户
    for (const user of demoUsers) {
      await transaction.execute(sql`
        INSERT INTO users (id, nickname, account_type)
        VALUES (${BigInt(user.id)}, ${user.nickname}, ${user.accountType}::account_type)
        ON CONFLICT (id) DO NOTHING
      `);
      await transaction.execute(sql`
        INSERT INTO role_memberships (
          id,
          user_id,
          role_id,
          granted_by_user_id,
          reason
        )
        SELECT
          ${stableUuid(`membership:${user.id}:${user.roleKey}`)}::uuid,
          ${BigInt(user.id)},
          role.id,
          0,
          '人工开启的演示账号角色'
        FROM roles role
        WHERE role.key = ${user.roleKey}
        ON CONFLICT (id) DO NOTHING
      `);
    }

    await transaction.execute(sql`
      INSERT INTO permission_grants (
        id,
        subject_user_id,
        permission_name,
        effect,
        scope,
        granted_by_user_id,
        reason
      ) VALUES (
        ${stableUuid("denied:problem.view.all")}::uuid,
        ${BigInt(databaseDemoUserIds.denied)},
        'problem.view.all',
        'deny',
        'global',
        0,
        '用于验证明确拒绝优先于角色允许'
      )
      ON CONFLICT (id) DO NOTHING
    `);
    // 2. 演示知识点目录：先插类别，再插标签。E2E/演示环境的标签 ID（如
    // algorithm.implementation）不在正式迁移目录里，需要额外 seed 才能让
    // hasTags 校验通过。演示类别名称加"演示"前缀，避免与正式迁移目录
    // （0011_tag_catalog.sql）创建的 legacy.category.* / catalog.category.* 冲突。
    // 仅在 tags 表已含 normalized_name / item_kind 列（迁移 0011 之后）时执行；
    // 旧 schema 的并发测试只迁移到第 8 步，跳过即可。
    const schemaColumns = await transaction.query<{ column_name: string }>(sql`
      SELECT column_name FROM information_schema.columns
      WHERE table_name = 'tags' AND column_name IN ('normalized_name', 'item_kind')
    `);
    if (schemaColumns.length >= 2) {
      const demoCategories = new Map<string, string>();
      for (const tag of demoTags) {
        if (tag.category !== undefined && !demoCategories.has(tag.category.id)) {
          demoCategories.set(tag.category.id, `演示·${tag.category.name}`);
        }
      }
      let categorySort = 0;
      for (const [categoryId, categoryName] of demoCategories) {
        await transaction.execute(sql`
          INSERT INTO tags (
            id, parent_id, name, normalized_name, item_kind, group_name,
            description, sort_order, is_active, created_by_user_id
          )
          VALUES (
            ${categoryId}, NULL, ${categoryName},
            lower(regexp_replace(normalize(${categoryName}, NFKC), '^[[:space:]]+|[[:space:]]+$', '', 'g')),
            'category', ${categoryName}, '演示种子数据', ${categorySort}, true, NULL
          )
          ON CONFLICT (id) DO NOTHING
        `);
        categorySort += 1;
      }
      let tagSort = 0;
      for (const tag of demoTags) {
        const categoryId = tag.category?.id ?? null;
        await transaction.execute(sql`
          INSERT INTO tags (
            id, parent_id, name, normalized_name, item_kind, group_name,
            description, sort_order, is_active, created_by_user_id
          )
          VALUES (
            ${tag.id}, ${categoryId}, ${tag.name},
            lower(regexp_replace(normalize(${tag.name}, NFKC), '^[[:space:]]+|[[:space:]]+$', '', 'g')),
            'tag', ${tag.group}, '', ${tagSort}, ${tag.active ?? true}, NULL
          )
          ON CONFLICT (id) DO NOTHING
        `);
        tagSort += 1;
      }
    }

  });
}
