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
});
