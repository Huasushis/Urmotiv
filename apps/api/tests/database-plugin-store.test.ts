import { randomUUID } from "node:crypto";
import {
  createLocalDatabase,
  type LocalDatabaseHandle,
  migrateDatabase,
  seedCoreDatabase
} from "@urmotiv/database";
import { sql } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";
import { DatabasePluginStore } from "../src/database-plugin-store";
import {
  AesGcmPluginSecretBox,
  PluginRevisionConflictError,
  PluginSecretStorageUnavailableError,
  TrustedPluginHost
} from "../src/plugin-host";

const openDatabases: LocalDatabaseHandle[] = [];
const pluginId = "org.example.database-plugin";

async function createHost(): Promise<{
  database: LocalDatabaseHandle;
  store: DatabasePluginStore;
  host: TrustedPluginHost;
}> {
  const database = createLocalDatabase();
  openDatabases.push(database);
  await migrateDatabase(database);
  await seedCoreDatabase(database);
  const store = new DatabasePluginStore(database);
  const host = new TrustedPluginHost([
    {
      source: "builtin:database-test",
      manifest: {
        id: pluginId,
        name: "数据库插件测试",
        version: "1.0.0",
        apiVersion: "1",
        permissions: []
      },
      settingsSchema: {
        type: "object",
        additionalProperties: false,
        required: ["baseUrl"],
        properties: {
          baseUrl: { type: "string", format: "uri" }
        }
      },
      secretDefinitions: [{
        name: "serviceToken",
        label: "服务认证令牌",
        description: "数据库插件测试使用。"
      }]
    }
  ], store, new AesGcmPluginSecretBox(Buffer.alloc(32, 3)));
  await host.initialize();
  return { database, store, host };
}

afterEach(async () => {
  await Promise.all(openDatabases.splice(0).map((database) => database.close()));
});

describe("数据库插件设置", () => {
  it("空存储允许轻量启动，已有密钥时缺少服务器配置则固定失败", async () => {
    const { database, store } = await createHost();
    expect(await store.hasStoredSecrets()).toBe(false);
    await expect(new TrustedPluginHost([], store).initialize()).resolves.toBeUndefined();

    const encryptedMarker = "stored-ciphertext-must-not-appear";
    await database.execute(sql`
      INSERT INTO plugin_secrets (
        plugin_id, name, encrypted_value, key_version, updated_by_user_id
      ) VALUES (
        ${pluginId}, 'serviceToken', ${encryptedMarker}, 1, 0
      )
    `);
    expect(await store.hasStoredSecrets()).toBe(true);

    const error = await new TrustedPluginHost([], store)
      .initialize()
      .then(() => undefined, (reason: unknown) => reason);
    expect(error).toBeInstanceOf(PluginSecretStorageUnavailableError);
    expect(String(error)).toBe(
      "PluginSecretStorageUnavailableError: 插件密钥保存配置不可用，请检查 URMOTIV_PLUGIN_SECRET_KEY。"
    );
    expect(String(error)).not.toContain(encryptedMarker);
    expect(String(error)).not.toContain("serviceToken");
  });

  it("同时保存设置和成功审计，并拒绝过期版本覆盖", async () => {
    const { database, host } = await createHost();
    const updated = await host.update(
      pluginId,
      {
        expectedRevision: 1,
        clearSecrets: [],
        state: "enabled",
        settings: { baseUrl: "https://plugin.example.test" }
      },
      "0",
      randomUUID()
    );
    expect(updated).toEqual(expect.objectContaining({
      state: "enabled",
      settingsRevision: 2,
      settings: { baseUrl: "https://plugin.example.test" }
    }));

    const auditRows = await database.query<{
      action: string;
      object_id: string;
      result: string;
      reason_code: string | null;
    }>(sql`
      SELECT action, object_id, result, reason_code
      FROM audit_events WHERE object_type = 'plugin'
    `);
    expect(auditRows).toEqual([{
      action: "plugin.update",
      object_id: pluginId,
      result: "success",
      reason_code: null
    }]);

    await expect(host.update(
      pluginId,
      { expectedRevision: 1, clearSecrets: [], state: "disabled" },
      "0",
      randomUUID()
    )).rejects.toBeInstanceOf(PluginRevisionConflictError);
  });

  it("审计写入失败时回滚状态、设置、密钥和版本", async () => {
    const { database, store, host } = await createHost();
    await expect(host.update(
      pluginId,
      {
        expectedRevision: 1,
        clearSecrets: [],
        state: "enabled",
        settings: { baseUrl: "https://plugin.example.test" },
        secrets: { serviceToken: "secret-value" }
      },
      "0",
      "not-a-request-id"
    )).rejects.toBeDefined();

    expect(await store.get(pluginId)).toEqual(expect.objectContaining({
      state: "disabled",
      settings: {},
      settingsRevision: 1,
      secrets: []
    }));
    const auditRows = await database.query<{ count: number }>(sql`
      SELECT count(*)::integer AS count FROM audit_events WHERE object_type = 'plugin'
    `);
    expect(auditRows).toEqual([{ count: 0 }]);
  });

  it("失败尝试审计只写固定原因，不修改插件设置", async () => {
    const { database, store, host } = await createHost();
    const settingMarker = "https://setting-marker-must-not-appear.example.test";
    const secretMarker = "secret-marker-must-not-appear";
    await host.update(
      pluginId,
      {
        expectedRevision: 1,
        clearSecrets: [],
        state: "enabled",
        settings: { baseUrl: settingMarker },
        secrets: { serviceToken: secretMarker }
      },
      "0",
      randomUUID()
    );
    const before = await store.get(pluginId);
    await store.appendAudit({
      actorUserId: "0",
      requestId: randomUUID(),
      action: "plugin.update",
      pluginId,
      result: "failure",
      reasonCode: "invalid_plugin_settings",
      metadata: {}
    });

    expect(await store.get(pluginId)).toEqual(before);
    const auditRows = await database.query<{
      object_id: string;
      result: string;
      reason_code: string;
      metadata: Record<string, unknown> | string;
    }>(sql`
      SELECT object_id, result, reason_code, metadata
      FROM audit_events WHERE object_type = 'plugin' AND result = 'failure'
    `);
    expect(auditRows).toEqual([{
      object_id: pluginId,
      result: "failure",
      reason_code: "invalid_plugin_settings",
      metadata: {}
    }]);
    const serialized = JSON.stringify(auditRows);
    expect(serialized).not.toContain(settingMarker);
    expect(serialized).not.toContain(secretMarker);
  });

  it("旧密钥记录只显示已配置，不暴露任何字符", async () => {
    const { database, store, host } = await createHost();
    await database.execute(sql`
      INSERT INTO plugin_secrets (
        plugin_id, name, encrypted_value, key_version, updated_by_user_id
      ) VALUES (
        ${pluginId}, 'serviceToken', 'legacy-encrypted-value', 1, 0
      )
    `);

    expect(await store.get(pluginId)).toEqual(expect.objectContaining({
      secrets: [expect.objectContaining({
        name: "serviceToken",
        encryptedValue: "legacy-encrypted-value"
      })]
    }));
    const plugins = await host.list();
    expect(plugins.find((plugin) => plugin.id === pluginId)?.secrets).toEqual([
      expect.objectContaining({ name: "serviceToken", configured: true })
    ]);
  });

  it("两个管理员基于同一版本保存时只接受一次", async () => {
    const { database, store, host } = await createHost();
    const firstSettings = { baseUrl: "https://first.example.test" };
    const secondSettings = { baseUrl: "https://second.example.test" };
    const writes = await Promise.allSettled([
      host.update(
        pluginId,
        {
          expectedRevision: 1,
          clearSecrets: [],
          settings: firstSettings
        },
        "0",
        randomUUID()
      ),
      host.update(
        pluginId,
        {
          expectedRevision: 1,
          clearSecrets: [],
          settings: secondSettings
        },
        "0",
        randomUUID()
      )
    ]);
    expect(writes.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const rejected = writes.find((result) => result.status === "rejected");
    expect(rejected).toEqual(expect.objectContaining({
      status: "rejected",
      reason: expect.any(PluginRevisionConflictError)
    }));

    const winningSettings = writes[0]?.status === "fulfilled" ? firstSettings : secondSettings;
    expect(await store.get(pluginId)).toEqual(expect.objectContaining({
      settingsRevision: 2,
      settings: winningSettings
    }));
    const auditRows = await database.query<{ count: number }>(sql`
      SELECT count(*)::integer AS count FROM audit_events
      WHERE object_type = 'plugin' AND object_id = ${pluginId}
    `);
    expect(auditRows).toEqual([{ count: 1 }]);
  });
});
