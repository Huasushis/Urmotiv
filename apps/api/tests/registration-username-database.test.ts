import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLocalDatabase, migrateDatabase, seedCoreDatabase } from "@urmotiv/database";
import { describe, expect, it } from "vitest";
import { DatabaseDataStore } from "../src/database-store";

describe("注册用户名的数据库边界", () => {
  it("保存自由用户名，忽略大小写唯一，未验证邮箱不能绕过用户名登录", async () => {
    const directory = await mkdtemp(join(tmpdir(), "urmotiv-registration-username-"));
    const database = createLocalDatabase({ dataDirectory: directory });
    try {
      await migrateDatabase(database);
      await seedCoreDatabase(database);
      const store = new DatabaseDataStore(database);
      const user = await store.registerEmailUser({ username: "自由Alias", nickname: "合成用户",
        normalizedEmail: "member@example.test", displayEmail: "member@example.test", passwordHash: "synthetic-hash" });
      expect(user?.username).toBe("自由Alias");
      expect(await store.findUsernameCredential("自由alias")).toBeUndefined();
      expect(await store.findEmailCredential("member@example.test")).toBeUndefined();
      await expect(store.registerEmailUser({ username: "自由ALIAS", nickname: "重复用户名",
        normalizedEmail: "other@example.test", displayEmail: "other@example.test", passwordHash: "synthetic-other" })).rejects.toThrow("用户名不可用");
      const now = new Date();
      await store.replaceEmailVerificationToken({ userId: user!.id, normalizedEmail: "member@example.test",
        tokenDigest: "a".repeat(64), expiresAt: new Date(now.getTime() + 60000).toISOString() });
      await store.consumeEmailVerificationToken("a".repeat(64), now.toISOString());
      expect((await store.findUsernameCredential("自由alias"))?.user.id).toBe(user!.id);
      expect((await store.findEmailCredential("member@example.test"))?.user.id).toBe(user!.id);
      expect((await store.listUsers()).filter(candidate => candidate.username?.toLowerCase() === "自由alias")).toHaveLength(1);
    } finally {
      await database.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
});
