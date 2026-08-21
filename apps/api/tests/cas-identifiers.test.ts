import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createLocalDatabase,
  type LocalDatabaseHandle,
  migrateDatabase,
  seedCoreDatabase
} from "@urmotiv/database";
import { sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DatabaseDataStore } from "../src/database-store";
import { readProfileView } from "../src/profile-service";
import { ExternalIdentityCollisionError } from "../src/repository";

const openDatabases: LocalDatabaseHandle[] = [];

let temporaryDirectory = "";

beforeEach(async () => {
  temporaryDirectory = await mkdtemp(join(tmpdir(), "urmotiv-cas-identifiers-"));
});

afterEach(async () => {
  await Promise.all(openDatabases.splice(0).map((database) => database.close()));
  await rm(temporaryDirectory, { recursive: true, force: true });
});

async function openDatabase(): Promise<LocalDatabaseHandle> {
  const database = createLocalDatabase({
    dataDirectory: join(temporaryDirectory, `database-${randomUUID()}`)
  });
  openDatabases.push(database);
  await migrateDatabase(database);
  await seedCoreDatabase(database);
  return database;
}

async function listIdentifiers(
  database: LocalDatabaseHandle,
  userId: string
): Promise<Array<{ kind: string; value: string; source: string }>> {
  return database.query<{ kind: string; value: string; source: string }>(sql`
    SELECT kind, value, source
    FROM user_identifiers
    WHERE user_id = ${BigInt(userId)}
    ORDER BY source, value
  `);
}

describe("统一身份认证的学号落库", () => {
  it("首次登录写入学号标识，重复登录不重复写入", async () => {
    const database = await openDatabase();
    const store = new DatabaseDataStore(database);
    const identity = {
      provider: "ustc-cas",
      subject: "gid-1001",
      nickname: "认证用户",
      studentIds: [
        { attribute: "cas:studentId", value: "PB20000001" },
        { attribute: "cas:employeeNumber", value: "SA24000002" }
      ]
    };

    const created = await store.findOrCreateExternalUser(identity);
    expect(await listIdentifiers(database, created.id)).toEqual([
      { kind: "student_id", value: "SA24000002", source: "cas:employeeNumber" },
      { kind: "student_id", value: "PB20000001", source: "cas:studentId" }
    ]);

    const again = await store.findOrCreateExternalUser(identity);
    expect(again.id).toBe(created.id);
    expect(await listIdentifiers(database, created.id)).toHaveLength(2);
  });

  it("学号已经绑定其他账号时保持原绑定，不自动改绑", async () => {
    const database = await openDatabase();
    const store = new DatabaseDataStore(database);
    const first = await store.findOrCreateExternalUser({
      provider: "ustc-cas",
      subject: "gid-A",
      nickname: "甲",
      studentIds: [{ attribute: "cas:studentId", value: "PB19000009" }]
    });
    const second = await store.findOrCreateExternalUser({
      provider: "ustc-cas",
      subject: "gid-B",
      nickname: "乙",
      studentIds: [{ attribute: "cas:studentId", value: "PB19000009" }]
    });
    expect(second.id).not.toBe(first.id);

    expect(await listIdentifiers(database, first.id)).toHaveLength(1);
    expect(await listIdentifiers(database, second.id)).toHaveLength(0);
  });

  it("没有提供学号时不写任何标识，旧调用方式保持兼容", async () => {
    const database = await openDatabase();
    const store = new DatabaseDataStore(database);
    const user = await store.findOrCreateExternalUser({
      provider: "ustc-cas",
      subject: "gid-plain",
      nickname: "无学号用户"
    });
    expect(await listIdentifiers(database, user.id)).toHaveLength(0);
  });

  it("首次登录的昵称、主邮箱与学号可直接构成个人资料视图", async () => {
    const database = await openDatabase();
    const store = new DatabaseDataStore(database);
    const created = await store.findOrCreateExternalUser({
      provider: "ustc-cas",
      subject: "gid-2002",
      nickname: "统一身份认证用户",
      email: "cas.user@example.test",
      studentIds: [{ attribute: "cas:studentId", value: "PB21000077" }]
    });
    expect(created.nickname).toBe("统一身份认证用户");

    const [email, identifiers] = await Promise.all([
      store.getPrimaryEmail(created.id),
      store.listUserIdentifiers(created.id)
    ]);
    expect(email).toEqual({ address: "cas.user@example.test", verified: true });
    expect(identifiers).toEqual([
      { attribute: "cas:studentId", value: "PB21000077" }
    ]);

    const profile = await readProfileView(created, store);
    expect(profile).toEqual(
      expect.objectContaining({
        id: created.id,
        nickname: "统一身份认证用户",
        accountType: "human",
        email: "cas.user@example.test",
        emailVerified: true,
        studentIds: [{ attribute: "cas:studentId", value: "PB21000077" }]
      })
    );
  });

  it("头像字节可写入并可读回，来源切换会按约束清空字节", async () => {
    const database = await openDatabase();
    const store = new DatabaseDataStore(database);
    const user = await store.findOrCreateExternalUser({
      provider: "ustc-cas",
      subject: "gid-3003",
      nickname: "头像用户"
    });
    const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);

    const updated = await store.setUserAvatar(user.id, "image/png", bytes);
    expect(updated?.avatarSource).toBe("uploaded");
    const readBack = await store.getUserAvatar(user.id);
    expect(readBack?.mediaType).toBe("image/png");
    expect(Buffer.from(readBack?.content ?? new Uint8Array())).toEqual(Buffer.from(bytes));

    // 从 uploaded 切回 qq/none 时字节必须一并清空，满足数据库约束。
    await store.updateUserProfile(user.id, { qq: "12345678", avatarSource: "qq" });
    expect(await store.getUserAvatar(user.id)).toBeUndefined();
    const afterQq = await store.getUser(user.id);
    expect(afterQq?.avatarSource).toBe("qq");

    await store.clearUserAvatar(user.id);
    expect((await store.getUser(user.id))?.avatarSource).toBe("none");
    expect(await store.getUserAvatar(user.id)).toBeUndefined();
  });
  it("OAuth2 首次登录写入 username/realName/email，后续同一 gid 安全更新", async () => {
    const database = await openDatabase();
    const store = new DatabaseDataStore(database);
    const first = await store.findOrCreateExternalUser({
      provider: "ustc-oauth",
      subject: "synthetic-gid-1",
      nickname: "首次昵称",
      username: "PB21000077",
      realName: "张三",
      email: "zhangsan@example.test",
      strictReconciliation: true,
      studentIds: [{ attribute: "zjhm", value: "PB21000077" }]
    });
    const profile = await readProfileView(first, store);
    expect(profile).toEqual(
      expect.objectContaining({
        id: first.id,
        nickname: "首次昵称",
        username: "PB21000077",
        realName: "张三",
        email: "zhangsan@example.test",
        emailVerified: true,
        studentIds: [{ attribute: "zjhm", value: "PB21000077" }]
      })
    );

    const reconciled = await store.findOrCreateExternalUser({
      provider: "ustc-oauth",
      subject: "synthetic-gid-1",
      nickname: "不覆盖用户昵称",
      username: "PB21000077",
      realName: "张三（新）",
      email: "zhangsan@example.test",
      strictReconciliation: true,
      studentIds: [{ attribute: "zjhm", value: "PB21000077" }]
    });
    expect(reconciled.id).toBe(first.id);
    expect(reconciled.nickname).toBe("首次昵称");
    expect(reconciled.realName).toBe("张三（新）");
  });

  it("OAuth2 的学工号或邮箱碰撞时失败并回滚新账号", async () => {
    const database = await openDatabase();
    const store = new DatabaseDataStore(database);
    await store.findOrCreateExternalUser({
      provider: "ustc-oauth",
      subject: "synthetic-gid-owner",
      nickname: "已有账号",
      username: "PB21000088",
      realName: "已有姓名",
      email: "owner@example.test",
      strictReconciliation: true,
      studentIds: [{ attribute: "zjhm", value: "PB21000088" }]
    });

    await expect(
      store.findOrCreateExternalUser({
        provider: "ustc-oauth",
        subject: "synthetic-gid-collision",
        nickname: "冲突账号",
        username: "PB21000088",
        realName: "冲突姓名",
        email: "other@example.test",
        strictReconciliation: true,
        studentIds: [{ attribute: "zjhm", value: "PB21000088" }]
      })
    ).rejects.toBeInstanceOf(ExternalIdentityCollisionError);
    await expect(
      store.findOrCreateExternalUser({
        provider: "ustc-oauth",
        subject: "synthetic-gid-email-collision",
        nickname: "邮箱冲突账号",
        username: "PB21000099",
        realName: "邮箱冲突姓名",
        email: "owner@example.test",
        strictReconciliation: true,
        studentIds: [{ attribute: "zjhm", value: "PB21000099" }]
      })
    ).rejects.toBeInstanceOf(ExternalIdentityCollisionError);

    const rows = await database.query<{ subject: string }>(sql`
      SELECT subject FROM external_identities WHERE provider = 'ustc-oauth'
    `);
    expect(rows.map((row) => row.subject)).toEqual(["synthetic-gid-owner"]);
  });

});
