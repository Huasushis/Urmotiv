import { randomUUID } from "node:crypto";
import { digestSecretToken } from "@urmotiv/auth";
import {
  createLocalDatabase,
  type LocalDatabaseHandle,
  migrateDatabase,
  seedCoreDatabase
} from "@urmotiv/database";
import { sql } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";
import {
  DatabaseServiceAccountTokenStore,
  type CreateServiceAccountTokenRecordInput
} from "../src/service-account-store";

const activeRobotId = "101";
const otherRobotId = "102";
const humanId = "103";
const disabledRobotId = "104";
const tokenExpiry = "2099-08-01T00:00:00.000Z";
const openDatabases: LocalDatabaseHandle[] = [];

async function createStore(): Promise<{
  database: LocalDatabaseHandle;
  store: DatabaseServiceAccountTokenStore;
}> {
  const database = createLocalDatabase();
  openDatabases.push(database);
  await migrateDatabase(database);
  await seedCoreDatabase(database);
  await database.execute(sql`
    INSERT INTO users (id, nickname, account_type, disabled_at, disabled_reason)
    VALUES
      (${BigInt(activeRobotId)}, '正在使用的机器人', 'robot', NULL, NULL),
      (${BigInt(otherRobotId)}, '另一台机器人', 'robot', NULL, NULL),
      (${BigInt(humanId)}, '普通用户', 'human', NULL, NULL),
      (${BigInt(disabledRobotId)}, '已停用机器人', 'robot', now(), '测试停用')
  `);
  return { database, store: new DatabaseServiceAccountTokenStore(database) };
}

function createOperation(
  overrides: Partial<CreateServiceAccountTokenRecordInput["token"]> = {}
): CreateServiceAccountTokenRecordInput {
  return {
    actorUserId: "0",
    requestId: randomUUID(),
    token: {
      name: "Fermata 标定服务",
      permissions: ["problem.review", "auth.login", "problem.view.all"],
      sourceCidrs: ["127.0.0.1/32", "2001:DB8::/64"],
      expiresAt: tokenExpiry,
      ...overrides
    }
  };
}

async function counts(database: LocalDatabaseHandle): Promise<{
  tokens: number;
  permissions: number;
  audits: number;
}> {
  const rows = await database.query<{
    tokens: number;
    permissions: number;
    audits: number;
  }>(sql`
    SELECT
      (SELECT count(*)::integer FROM api_tokens) AS tokens,
      (SELECT count(*)::integer FROM api_token_permissions) AS permissions,
      (SELECT count(*)::integer FROM audit_events
       WHERE action LIKE 'service_account.token.%') AS audits
  `);
  return rows[0] ?? { tokens: -1, permissions: -1, audits: -1 };
}

afterEach(async () => {
  await Promise.all(openDatabases.splice(0).map((database) => database.close()));
});

describe("机器人令牌事务存储", () => {
  it("只在创建结果中返回一次原令牌，数据库、列表和审计均不回显", async () => {
    const { database, store } = await createStore();
    const operation = createOperation();
    const created = await store.createToken(activeRobotId, operation);
    expect(created).toBeDefined();
    expect(created?.token).toMatch(/^urv_[A-Za-z0-9_-]{43}$/);
    expect(created?.item).toEqual(expect.objectContaining({
      name: operation.token.name,
      displayPrefix: created?.token.slice(0, 12),
      permissions: ["auth.login", "problem.review", "problem.view.all"],
      sourceCidrs: ["127.0.0.1/32", "2001:db8::/64"],
      expiresAt: tokenExpiry,
      revokedAt: null
    }));

    const rawToken = created!.token;
    const digest = digestSecretToken(rawToken);
    const stored = await database.query<{
      token_prefix: string;
      token_digest: string;
      source_cidrs: unknown;
    }>(sql`
      SELECT token_prefix, token_digest, source_cidrs
      FROM api_tokens WHERE id = ${created!.item.id}::uuid
    `);
    expect(stored).toEqual([expect.objectContaining({
      token_prefix: rawToken.slice(0, 12),
      token_digest: digest
    })]);
    expect(JSON.stringify(stored)).not.toContain(rawToken);

    const listedFirst = await store.listTokens(activeRobotId);
    const listedAgain = await store.listTokens(activeRobotId);
    expect(listedFirst).toEqual({ items: [created!.item] });
    expect(listedAgain).toEqual(listedFirst);
    for (const safeValue of [created!.item, listedFirst, listedAgain]) {
      const serialized = JSON.stringify(safeValue);
      expect(serialized).not.toContain(rawToken);
      expect(serialized).not.toContain(digest);
      expect(serialized).not.toContain("tokenDigest");
    }

    const audits = await database.query<{
      action: string;
      object_id: string;
      subject_user_id: string;
      metadata: Record<string, unknown> | string;
    }>(sql`
      SELECT action, object_id, subject_user_id::text AS subject_user_id, metadata
      FROM audit_events WHERE action = 'service_account.token.create'
    `);
    expect(audits).toEqual([{
      action: "service_account.token.create",
      object_id: created!.item.id,
      subject_user_id: activeRobotId,
      metadata: { permissionCount: 3, sourceCidrCount: 2, hasExpiry: true }
    }]);
    const serializedAudit = JSON.stringify(audits);
    expect(serializedAudit).not.toContain(rawToken);
    expect(serializedAudit).not.toContain(digest);
    expect(serializedAudit).not.toContain(created!.item.displayPrefix);
    expect(serializedAudit).not.toContain(operation.token.name);
    expect(serializedAudit).not.toContain("127.0.0.1");
  });

  it("错误编号、不存在、普通用户和已停用机器人统一返回未找到且没有副作用", async () => {
    const { database, store } = await createStore();
    const targets = [
      "not-an-id",
      "999999",
      "9223372036854775808",
      "9".repeat(10_000),
      humanId,
      disabledRobotId
    ];
    for (const target of targets) {
      await expect(store.listTokens(target)).resolves.toBeUndefined();
      await expect(store.createToken(target, createOperation())).resolves.toBeUndefined();
    }
    expect(await counts(database)).toEqual({ tokens: 0, permissions: 0, audits: 0 });
  });

  it("固定禁止权限在存储入口再次校验，失败时不产生令牌或审计", async () => {
    const { database, store } = await createStore();
    await expect(store.createToken(activeRobotId, createOperation({
      permissions: ["auth.login", "service_account.manage"]
    }))).rejects.toBeDefined();
    expect(await counts(database)).toEqual({ tokens: 0, permissions: 0, audits: 0 });
  });

  it("跨账号、错误编号和已停用账号不能撤销令牌，也不留下失败状态", async () => {
    const { database, store } = await createStore();
    const created = await store.createToken(activeRobotId, createOperation());
    expect(created).toBeDefined();

    await expect(store.revokeToken(
      otherRobotId,
      created!.item.id,
      "0",
      randomUUID()
    )).resolves.toBeUndefined();
    await expect(store.revokeToken(
      activeRobotId,
      "not-a-token-id",
      "0",
      randomUUID()
    )).resolves.toBeUndefined();
    for (const invalidTarget of ["9223372036854775808", "9".repeat(10_000)]) {
      await expect(store.revokeToken(
        invalidTarget,
        created!.item.id,
        "0",
        randomUUID()
      )).resolves.toBeUndefined();
    }

    await database.execute(sql`
      UPDATE users SET disabled_at = now(), disabled_reason = '测试停用'
      WHERE id = ${BigInt(activeRobotId)}
    `);
    await expect(store.revokeToken(
      activeRobotId,
      created!.item.id,
      "0",
      randomUUID()
    )).resolves.toBeUndefined();

    const state = await database.query<{ revoked_at: string | null }>(sql`
      SELECT revoked_at FROM api_tokens WHERE id = ${created!.item.id}::uuid
    `);
    expect(state).toEqual([{ revoked_at: null }]);
    expect(await counts(database)).toEqual({ tokens: 1, permissions: 3, audits: 1 });
  });

  it("撤销只改变所属账号的活动令牌，并与成功审计一起提交", async () => {
    const { database, store } = await createStore();
    const created = await store.createToken(activeRobotId, createOperation());
    expect(created).toBeDefined();
    const revoked = await store.revokeToken(
      activeRobotId,
      created!.item.id,
      "0",
      randomUUID()
    );
    expect(revoked?.revokedAt).not.toBeNull();
    expect(revoked).toEqual(expect.objectContaining({ id: created!.item.id }));
    await expect(store.revokeToken(
      activeRobotId,
      created!.item.id,
      "0",
      randomUUID()
    )).resolves.toBeUndefined();

    const listed = await store.listTokens(activeRobotId);
    expect(listed?.items).toEqual([revoked]);
    const audits = await database.query<{
      action: string;
      metadata: Record<string, unknown> | string;
    }>(sql`
      SELECT action, metadata FROM audit_events
      WHERE action LIKE 'service_account.token.%'
      ORDER BY id
    `);
    expect(audits).toEqual([
      { action: "service_account.token.create", metadata: {
        permissionCount: 3,
        sourceCidrCount: 2,
        hasExpiry: true
      } },
      { action: "service_account.token.revoke", metadata: {} }
    ]);
  });

  it("审计写入失败会回滚令牌创建和撤销", async () => {
    const { database, store } = await createStore();
    await expect(store.createToken(activeRobotId, {
      ...createOperation(),
      requestId: "not-a-request-id"
    })).rejects.toBeDefined();
    expect(await counts(database)).toEqual({ tokens: 0, permissions: 0, audits: 0 });

    const created = await store.createToken(activeRobotId, createOperation());
    expect(created).toBeDefined();
    await expect(store.revokeToken(
      activeRobotId,
      created!.item.id,
      "0",
      "not-a-request-id"
    )).rejects.toBeDefined();
    const rows = await database.query<{ revoked_at: string | null }>(sql`
      SELECT revoked_at FROM api_tokens WHERE id = ${created!.item.id}::uuid
    `);
    expect(rows).toEqual([{ revoked_at: null }]);
    expect(await counts(database)).toEqual({ tokens: 1, permissions: 3, audits: 1 });
  });
});
