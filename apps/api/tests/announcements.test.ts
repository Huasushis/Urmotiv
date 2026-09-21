import { afterEach, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import {
  createLocalDatabase,
  migrateDatabase,
  seedCoreDatabase,
  type LocalDatabaseHandle,
} from "@urmotiv/database";
import { sql } from "drizzle-orm";
import { announcementInputSchema } from "@urmotiv/contracts";
import { AnnouncementService } from "../src/announcement-service";
import { DatabaseDataStore } from "../src/database-store";
import { createApp } from "../src/app";
import {
  seedDatabaseDemoData,
  databaseDemoUserIds,
} from "../src/database-demo";
const open: LocalDatabaseHandle[] = [];
afterEach(async () => {
  for (const db of open.splice(0)) await db.close();
});
async function fixture() {
  const db = createLocalDatabase();
  open.push(db);
  await migrateDatabase(db);
  await seedCoreDatabase(db);
  await seedDatabaseDemoData(db);
  return { db, service: new AnnouncementService(db) };
}
const input = () =>
  announcementInputSchema.parse({
    title: "合成使用提醒",
    body: "请看 [使用文档](/guide)",
    published: true,
  });
const paging = { page: 1, pageSize: 20 };
it("新人、权限组、已读版本、撤回和置顶保持正确，过期/撤销成员不泄露", async () => {
  const { db, service } = await fixture(),
    author = databaseDemoUserIds.author,
    leader = databaseDemoUserIds.leader;
  await db.execute(
    sql`UPDATE users SET created_at=now()-interval '100 days' WHERE id=${BigInt(leader)}`,
  );
  const first = await service.save("0", input(), randomUUID());
  expect((await service.list(author, paging)).items.map((i) => i.id)).toEqual([
    first.id,
  ]);
  expect((await service.list(leader, paging)).total).toBe(0);
  await expect(service.markRead(leader, first.id, 1)).rejects.toMatchObject({
    statusCode: 404,
  });
  await service.markRead(author, first.id, 1);
  expect(
    (await service.list(author, { ...paging, popup: true })).items,
  ).toEqual([]);
  await service.save(
    "0",
    { ...input(), body: "更新后的合成内容" },
    randomUUID(),
    first.id,
    1,
  );
  expect(
    (await service.list(author, { ...paging, popup: true })).items[0]?.revision,
  ).toBe(2);
  await expect(
    service.save("0", input(), randomUUID(), first.id, 1),
  ).rejects.toMatchObject({ statusCode: 409 });
  await expect(service.markRead(author, first.id, 1)).rejects.toMatchObject({
    statusCode: 409,
  });
  const pinned = await service.save(
    "0",
    { ...input(), audience: "all", pinned: true },
    randomUUID(),
  );
  expect((await service.list(author, paging)).items[0]?.id).toBe(pinned.id);
  await service.save(
    "0",
    { ...input(), published: false },
    randomUUID(),
    first.id,
    2,
  );
  expect((await service.list(author, paging)).total).toBe(1);
  const role = (
    await db.query<{ id: string }>(
      sql`SELECT id::text FROM roles WHERE key='contributor'`,
    )
  )[0]!;
  const targeted = await service.save(
    "0",
    { ...input(), audience: "roles", roleIds: [role.id] },
    randomUUID(),
  );
  expect(
    (await service.list(author, paging)).items.some(
      (i) => i.id === targeted.id,
    ),
  ).toBe(true);
  await db.execute(
    sql`UPDATE role_memberships SET created_at=now()-interval '2 days',expires_at=now()-interval '1 day' WHERE user_id=${BigInt(author)} AND role_id=${role.id}::uuid`,
  );
  // 给账号保留独立登录权限，验证受众过滤不是恰好被禁止登录。
  await db.execute(
    sql`INSERT INTO permission_grants(id,subject_user_id,permission_name,effect,scope,granted_by_user_id,reason) VALUES(${randomUUID()}::uuid,${BigInt(author)},'auth.login','allow','global',0,'合成验证')`,
  );
  expect(
    (await service.list(author, paging)).items.some(
      (i) => i.id === targeted.id,
    ),
  ).toBe(false);
  await expect(service.markRead(author, targeted.id, 1)).rejects.toMatchObject({
    statusCode: 404,
  });
});
it("发布事务重验权限、机器人硬拒绝，审计失败没有部分写入", async () => {
  const { db, service } = await fixture();
  await expect(
    service.save(databaseDemoUserIds.author, input(), randomUUID()),
  ).rejects.toMatchObject({ statusCode: 404 });
  await expect(
    service.save(databaseDemoUserIds.robot, input(), randomUUID()),
  ).rejects.toMatchObject({ statusCode: 404 });
  await expect(
    service.save("0", input(), "invalid-request"),
  ).rejects.toBeDefined();
  expect((await service.list("0", { ...paging, manage: true })).total).toBe(0);
  await db.execute(
    sql`INSERT INTO permission_grants(id,subject_user_id,permission_name,effect,scope,granted_by_user_id,reason) VALUES(${randomUUID()}::uuid,0,'announcement.manage','deny','global',0,'合成撤权')`,
  );
  await expect(service.save("0", input(), randomUUID())).rejects.toMatchObject({
    statusCode: 404,
  });
});
it("API 匿名、越权、错误来源和猜公告编号被拒绝，响应不缓存", async () => {
  const { db, service } = await fixture();
  const app = await createApp({
    store: new DatabaseDataStore(db),
    announcements: service,
    demoAuthEnabled: true,
    demoUserIds: Object.values(databaseDemoUserIds),
    demoLoginUserIds: databaseDemoUserIds,
  });
  try {
    expect(
      (await app.inject({ url: "/api/v1/announcements" })).statusCode,
    ).toBe(401);
    const login = await app.inject({
      method: "POST",
      url: "/api/v1/auth/demo-login",
      headers: { origin: "http://localhost:5173" },
      payload: { userId: "author" },
    });
    const cookie = String(login.headers["set-cookie"]).split(";")[0]!;
    for (const url of [
      "/api/v1/admin/announcements",
      "/api/v1/admin/announcements/roles",
    ])
      expect((await app.inject({ url, headers: { cookie } })).statusCode).toBe(
        404,
      );
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/api/v1/admin/announcements",
          headers: { cookie, origin: "http://localhost:5173" },
          payload: input(),
        })
      ).statusCode,
    ).toBe(404);
    const feed = await app.inject({
      url: "/api/v1/announcements",
      headers: { cookie },
    });
    expect(feed.statusCode).toBe(200);
    expect(feed.headers["cache-control"]).toContain("no-store");
    expect(
      (
        await app.inject({
          method: "POST",
          url: `/api/v1/announcements/${randomUUID()}/read`,
          headers: { cookie, origin: "http://localhost:5173" },
          payload: { revision: 1 },
        })
      ).statusCode,
    ).toBe(404);
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/api/v1/admin/announcements",
          headers: { cookie, origin: "https://untrusted.test" },
          payload: input(),
        })
      ).statusCode,
    ).toBe(403);
  } finally {
    await app.close();
  }
});
