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

    for (const [sortOrder, tag] of demoTags.entries()) {
      await transaction.execute(sql`
        INSERT INTO tags (id, name, group_name, sort_order, created_by_user_id)
        VALUES (${tag.id}, ${tag.name}, ${tag.group}, ${sortOrder}, 0)
        ON CONFLICT (id) DO NOTHING
      `);
    }
  });
}
