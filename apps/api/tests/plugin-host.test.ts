import { describe, expect, it } from "vitest";
import { z } from "zod";
import { createApp } from "../src/app";
import { InMemoryDataStore } from "../src/repository";
import { demoTags } from "../src/demo-data";
import {
  AesGcmPluginSecretBox,
  createPluginSecretBox,
  InMemoryPluginStore,
  PluginSecretStorageUnavailableError,
  TrustedPluginHost,
  type TrustedPluginDefinition
} from "../src/plugin-host";

const manifest = {
  id: "org.example.safe-plugin",
  name: "安全测试插件",
  version: "1.0.0",
  apiVersion: "1",
  permissions: ["org.example.safe-plugin.configure"]
};

const accessTokenDefinition = {
  name: "accessToken",
  label: "访问令牌",
  description: "测试插件调用外部服务时使用。"
} as const;

function createTestPluginDefinition(): TrustedPluginDefinition {
  return {
    source: "builtin:test",
    manifest,
    settingsSchema: {
      type: "object",
      additionalProperties: false,
      required: ["baseUrl"],
      properties: {
        baseUrl: { type: "string", format: "uri" },
        retries: { type: "integer", minimum: 0, maximum: 3, default: 1 },
        failureBehavior: {
          type: "string",
          oneOf: [
            { const: "block", title: "阻止提交" },
            { const: "continue", title: "继续提交" }
          ],
          default: "block"
        }
      }
    },
    secretDefinitions: [accessTokenDefinition]
  };
}

function createHost() {
  const store = new InMemoryPluginStore();
  const secretBox = new AesGcmPluginSecretBox(Buffer.alloc(32, 7));
  const host = new TrustedPluginHost([createTestPluginDefinition()], store, secretBox);
  return { host, store };
}

describe("插件宿主", () => {
  it("拒绝外部来源、核心权限碰撞和越界钩子", () => {
    expect(() => new TrustedPluginHost([{ source: "file:/tmp/plugin", manifest }], new InMemoryPluginStore())).toThrow("内置插件");
    expect(() => new TrustedPluginHost([{
      source: "builtin:collision",
      manifest: { ...manifest, permissions: ["system.manage"] }
    }], new InMemoryPluginStore())).toThrow("核心权限");
    expect(() => new TrustedPluginHost([{
      source: "builtin:hook-owner",
      manifest,
      registerHooks: (registry) => registry.registerBeforeSubmitCheck({
        id: "org.other.plugin.check", displayName: "越界", timeoutMs: 1000, failureBehavior: "block",
        run: () => ({ decision: "continue" })
      })
    }], new InMemoryPluginStore())).toThrow("不属于自己的钩子");
  });

  it("校验设置、密文保存且永不从管理响应返回明文", async () => {
    const { host, store } = createHost();
    await host.initialize();
    await expect(host.update(manifest.id, {
      expectedRevision: 1,
      clearSecrets: [],
      settings: { unknown: true }
    }, "9", "00000000-0000-4000-8000-000000000001"))
      .rejects.toThrow("不是允许的设置项");
    const result = await host.update(manifest.id, {
      expectedRevision: 1,
      clearSecrets: [],
      state: "enabled",
      settings: { baseUrl: "https://anklang.example.test" },
      secrets: { accessToken: "very-secret-token" }
    }, "9", "00000000-0000-4000-8000-000000000001");
    expect(result?.state).toBe("enabled");
    expect(result?.settings).toEqual({
      baseUrl: "https://anklang.example.test",
      retries: 1,
      failureBehavior: "block"
    });
    expect(result?.secrets).toEqual([{
      ...accessTokenDefinition,
      configured: true,
      maskedSuffix: "oken"
    }]);
    expect(JSON.stringify(result)).not.toContain("very-secret-token");
    expect((await store.get(manifest.id))?.secrets[0]?.encryptedValue).not.toContain("very-secret-token");
    expect(JSON.stringify(store.auditEvents)).not.toContain("very-secret-token");
    await expect(host.readSecretForPlugin(manifest.id, "accessToken")).resolves.toBe("very-secret-token");
    await expect(host.readSecretForPlugin(manifest.id, "anotherPluginToken")).resolves.toBeUndefined();

    await expect(host.update(manifest.id, {
      expectedRevision: 2,
      clearSecrets: [],
      settings: {
        baseUrl: "https://anklang.example.test",
        failureBehavior: "ignore"
      }
    }, "9", "00000000-0000-4000-8000-000000000002"))
      .rejects.toThrow("不在允许值中");
  });

  it("严格校验服务器插件密钥的编码和长度", () => {
    const validKey = Buffer.alloc(32, 9).toString("base64url");
    expect(createPluginSecretBox(undefined)).toBeUndefined();
    expect(createPluginSecretBox("")).toBeUndefined();
    expect(createPluginSecretBox(validKey)).toBeInstanceOf(AesGcmPluginSecretBox);

    for (const invalidKey of [
      "not-base64url",
      Buffer.alloc(31, 9).toString("base64url"),
      Buffer.alloc(33, 9).toString("base64url"),
      `${validKey.slice(0, -1)}B`,
      `${validKey}=`
    ]) {
      expect(() => createPluginSecretBox(invalidKey)).toThrow(
        PluginSecretStorageUnavailableError
      );
      expect(() => createPluginSecretBox(invalidKey)).toThrow(
        "插件密钥保存配置不可用，请检查 URMOTIV_PLUGIN_SECRET_KEY。"
      );
    }
  });

  it("只有确有密钥记录时才要求解密配置，并用固定错误拒绝读取失败", async () => {
    const store = new InMemoryPluginStore();
    const hostWithoutSecretBox = new TrustedPluginHost([createTestPluginDefinition()], store);
    await expect(hostWithoutSecretBox.initialize()).resolves.toBeUndefined();
    await hostWithoutSecretBox.update(manifest.id, {
      expectedRevision: 1,
      clearSecrets: [],
      state: "enabled",
      settings: { baseUrl: "https://plugin.example.test" }
    }, "9", "00000000-0000-4000-8000-000000000021");
    await expect(
      hostWithoutSecretBox.readSecretForPlugin(manifest.id, accessTokenDefinition.name)
    ).resolves.toBeUndefined();

    const secretValue = "startup-secret-marker-value";
    const hostWithSecretBox = new TrustedPluginHost(
      [createTestPluginDefinition()],
      store,
      new AesGcmPluginSecretBox(Buffer.alloc(32, 7))
    );
    await hostWithSecretBox.initialize();
    await hostWithSecretBox.update(manifest.id, {
      expectedRevision: 2,
      clearSecrets: [],
      secrets: { [accessTokenDefinition.name]: secretValue }
    }, "9", "00000000-0000-4000-8000-000000000022");
    const storedSecret = (await store.get(manifest.id))?.secrets[0];
    expect(storedSecret).toBeDefined();

    const hostWithWrongKey = new TrustedPluginHost(
      [createTestPluginDefinition()],
      store,
      new AesGcmPluginSecretBox(Buffer.alloc(32, 8))
    );
    await hostWithWrongKey.initialize();
    for (const reader of [hostWithoutSecretBox, hostWithWrongKey]) {
      const error = await reader
        .readSecretForPlugin(manifest.id, accessTokenDefinition.name)
        .then(() => undefined, (reason: unknown) => reason);
      expect(error).toBeInstanceOf(PluginSecretStorageUnavailableError);
      expect(String(error)).toBe(
        "PluginSecretStorageUnavailableError: 插件密钥保存配置不可用，请检查 URMOTIV_PLUGIN_SECRET_KEY。"
      );
      for (const forbidden of [
        secretValue,
        accessTokenDefinition.name,
        storedSecret?.maskedSuffix,
        storedSecret?.encryptedValue
      ]) {
        if (forbidden !== undefined) {
          expect(String(error)).not.toContain(forbidden);
        }
      }
    }
  });

  it("短密钥不回显原值，且只能按插件声明的名称保存和清除", async () => {
    const { host, store } = createHost();
    await host.initialize();
    await expect(host.update(manifest.id, {
      expectedRevision: 1,
      clearSecrets: [],
      secrets: { anotherPluginToken: "not-allowed" }
    }, "9", "00000000-0000-4000-8000-000000000011")).rejects.toThrow("未声明的密钥名称");

    const saved = await host.update(manifest.id, {
      expectedRevision: 1,
      clearSecrets: [],
      state: "enabled",
      settings: { baseUrl: "https://plugin.example.test" },
      secrets: { accessToken: "abcd" }
    }, "9", "00000000-0000-4000-8000-000000000012");
    expect(saved?.secrets).toEqual([
      { ...accessTokenDefinition, configured: true, maskedSuffix: "****" }
    ]);
    expect(JSON.stringify(saved)).not.toContain("abcd");

    await expect(host.update(manifest.id, {
      expectedRevision: 2,
      secrets: { accessToken: "replacement" },
      clearSecrets: ["accessToken"]
    }, "9", "00000000-0000-4000-8000-000000000013")).rejects.toThrow("同时保存和清除");

    const cleared = await host.update(manifest.id, {
      expectedRevision: 2,
      clearSecrets: ["accessToken"]
    }, "9", "00000000-0000-4000-8000-000000000014");
    expect(cleared).toEqual(expect.objectContaining({
      settingsRevision: 3,
      secrets: [{ ...accessTokenDefinition, configured: false, maskedSuffix: "" }]
    }));
    await expect(host.readSecretForPlugin(manifest.id, "accessToken")).resolves.toBeUndefined();
    expect(JSON.stringify(store.auditEvents)).not.toContain("abcd");
  });

  it("地址只接受不含账号密码的 HTTP 或 HTTPS", async () => {
    const { host } = createHost();
    await host.initialize();
    for (const baseUrl of [
      "ftp://plugin.example.test",
      "https://user:password@plugin.example.test",
      "https://plugin.example.test/search?token=must-not-be-saved",
      "https://plugin.example.test/#must-not-be-saved"
    ]) {
      await expect(host.update(manifest.id, {
        expectedRevision: 1,
        clearSecrets: [],
        settings: { baseUrl }
      }, "9", "00000000-0000-4000-8000-000000000015")).rejects.toThrow("HTTP 或 HTTPS");
    }
  });

  it("读取审核规则状态失败时不把规则当作停用", async () => {
    class FailingPluginStore extends InMemoryPluginStore {
      public override async get(): Promise<never> {
        throw new Error("database unavailable");
      }
    }
    const host = new TrustedPluginHost([{
      source: "builtin:review-failure",
      manifest,
      initialState: "enabled",
      reviewRuleSettingsSchemas: {
        "org.example.safe-plugin.review": {
          type: "object",
          additionalProperties: false,
          properties: {}
        }
      },
      registerHooks: (registry) => registry.registerReviewDecisionRule({
        id: "org.example.safe-plugin.review",
        displayName: "测试审核规则",
        supportedReviewItemTypes: [],
        settingsSchema: z.object({}).strict(),
        evaluate: () => ({
          decision: "pending",
          usedOpinionIds: [],
          usedReviewItemIds: [],
          reason: "继续等待。"
        })
      })
    }], new FailingPluginStore());
    await host.initialize();
    await expect(host.listEnabledReviewRules()).rejects.toThrow("database unavailable");
  });

  it("禁用插件后不能取得请求时钩子范围", async () => {
    const { host } = createHost();
    await host.initialize();
    await expect(host.requestScope(manifest.id)).rejects.toThrow("未启用");
    await expect(host.update(manifest.id, {
      expectedRevision: 1,
      clearSecrets: [],
      state: "enabled"
    }, "9", "00000000-0000-4000-8000-000000000002")).rejects.toThrow("baseUrl 是必填项");
    await host.update(manifest.id, {
      expectedRevision: 1,
      clearSecrets: [],
      state: "enabled",
      settings: { baseUrl: "https://plugin.example.test" }
    }, "9", "00000000-0000-4000-8000-000000000002");
    await expect(host.requestScope(manifest.id)).resolves.toEqual({ pluginId: manifest.id, enabled: true });
    await host.update(manifest.id, {
      expectedRevision: 2,
      clearSecrets: [],
      state: "disabled"
    }, "9", "00000000-0000-4000-8000-000000000003");
    await expect(host.requestScope(manifest.id)).rejects.toThrow("未启用");
  });

  it("请求时再次检查钩子所属插件是否启用，注册表已经锁定", async () => {
    const store = new InMemoryPluginStore();
    const host = new TrustedPluginHost([{
      source: "builtin:hook-test",
      manifest,
      registerHooks: (registry) => registry.registerBeforeSubmitCheck({
        id: "org.example.safe-plugin.before-submit", displayName: "测试检查", timeoutMs: 1000,
        failureBehavior: "block", run: () => ({ decision: "continue" })
      })
    }], store);
    await host.initialize();
    const input = {
      problemId: "1", revision: 1, reviewRound: 1,
      contentHash: "a".repeat(64),
      problem: { title: "测试", type: "traditional" as const, tagIds: ["tag"], basicStatement: "题面", basicSolution: "题解" }
    };
    await expect(host.runBeforeSubmit(input, ["org.example.safe-plugin.before-submit"])).rejects.toThrow("未启用");
    await host.update(manifest.id, {
      expectedRevision: 1,
      clearSecrets: [],
      state: "enabled"
    }, "9", "00000000-0000-4000-8000-000000000004");
    await expect(host.runBeforeSubmit(input, ["org.example.safe-plugin.before-submit"])).resolves.toEqual({ decision: "continue" });
    await expect(host.runBeforeSubmit(input, ["org.unknown.plugin.check"])).rejects.toThrow("没有登记");
  });

  it("读取插件状态失败时不把必需检查当作停用并跳过", async () => {
    class FailingPluginStore extends InMemoryPluginStore {
      public override async get(): Promise<never> {
        throw new Error("database unavailable");
      }
    }
    const store = new FailingPluginStore();
    const host = new TrustedPluginHost([{
      source: "builtin:failure-check",
      manifest,
      initialState: "enabled",
      registerHooks: (registry) => registry.registerBeforeSubmitCheck({
        id: "org.example.safe-plugin.before-submit",
        displayName: "必须执行的检查",
        timeoutMs: 1000,
        failureBehavior: "block",
        run: () => ({ decision: "continue" })
      })
    }], store);
    await host.initialize();
    await expect(host.listEnabledBeforeSubmitCheckIds()).rejects.toThrow("database unavailable");
  });

  it("管理接口同时要求插件管理和系统管理，明确拒绝仍然优先", async () => {
    const manager = {
      id: "901", nickname: "系统管理员", accountType: "human" as const, disabled: false,
      roles: [], isRoot: false,
      grants: [
        { permission: "auth.login", effect: "allow" as const, scope: "global" as const },
        { permission: "plugin.manage", effect: "allow" as const, scope: "global" as const },
        { permission: "system.manage", effect: "allow" as const, scope: "global" as const }
      ]
    };
    const denied = {
      ...manager,
      id: "902",
      grants: [...manager.grants, { permission: "plugin.manage", effect: "deny" as const, scope: "global" as const }]
    };
    const { host } = createHost();
    const app = await createApp({
      store: new InMemoryDataStore([manager, denied], demoTags),
      demoAuthEnabled: true,
      demoUserIds: [manager.id, denied.id],
      demoLoginUserIds: { manager: manager.id, denied: denied.id },
      pluginHost: host
    });
    try {
      const login = async (userId: string) => {
        const response = await app.inject({
          method: "POST", url: "/api/v1/auth/demo-login", headers: { origin: "http://localhost:5173" }, payload: { userId }
        });
        return (response.headers["set-cookie"] as string).split(";", 1)[0]!;
      };
      const managerCookie = await login("manager");
      const allowed = await app.inject({ method: "GET", url: "/api/v1/admin/plugins", headers: { cookie: managerCookie } });
      expect(allowed.statusCode).toBe(200);
      expect(JSON.stringify(allowed.json())).not.toContain("very-secret-token");
      const deniedCookie = await login("denied");
      const blocked = await app.inject({ method: "GET", url: "/api/v1/admin/plugins", headers: { cookie: deniedCookie } });
      expect(blocked.statusCode).toBe(403);
      const write = await app.inject({
        method: "PATCH", url: `/api/v1/admin/plugins/${manifest.id}`,
        headers: { cookie: managerCookie, origin: "http://localhost:5173" },
        payload: {
          expectedRevision: 1,
          state: "enabled",
          settings: { baseUrl: "https://plugin.example.test" }
        }
      });
      expect(write.statusCode).toBe(200);
      const stale = await app.inject({
        method: "PATCH", url: `/api/v1/admin/plugins/${manifest.id}`,
        headers: { cookie: managerCookie, origin: "http://localhost:5173" },
        payload: { expectedRevision: 1, state: "disabled" }
      });
      expect(stale.statusCode).toBe(409);
      const invalid = await app.inject({
        method: "PATCH", url: `/api/v1/admin/plugins/${manifest.id}`,
        headers: { cookie: managerCookie, origin: "http://localhost:5173" },
        payload: {
          expectedRevision: 2,
          settings: { baseUrl: "ftp://plugin.example.test" }
        }
      });
      expect(invalid.statusCode).toBe(422);
      expect(invalid.json()).toEqual({
        error: expect.objectContaining({ code: "INVALID_PLUGIN_SETTINGS" })
      });
    } finally {
      await app.close();
    }
  });

  it("密钥保存内部故障只返回固定错误，不泄露内部原因或密钥", async () => {
    const manager = {
      id: "903", nickname: "系统管理员", accountType: "human" as const, disabled: false,
      roles: [], isRoot: false,
      grants: [
        { permission: "auth.login", effect: "allow" as const, scope: "global" as const },
        { permission: "plugin.manage", effect: "allow" as const, scope: "global" as const },
        { permission: "system.manage", effect: "allow" as const, scope: "global" as const }
      ]
    };
    const store = new InMemoryPluginStore();
    const host = new TrustedPluginHost([{
      source: "builtin:failure-test",
      manifest,
      secretNames: ["accessToken"]
    }], store);
    const app = await createApp({
      store: new InMemoryDataStore([manager], demoTags),
      demoAuthEnabled: true,
      demoUserIds: [manager.id],
      demoLoginUserIds: { manager: manager.id },
      pluginHost: host
    });
    try {
      const login = await app.inject({
        method: "POST",
        url: "/api/v1/auth/demo-login",
        headers: { origin: "http://localhost:5173" },
        payload: { userId: "manager" }
      });
      const cookie = (login.headers["set-cookie"] as string).split(";", 1)[0]!;
      const secret = "must-not-appear";
      const failed = await app.inject({
        method: "PATCH",
        url: `/api/v1/admin/plugins/${manifest.id}`,
        headers: { cookie, origin: "http://localhost:5173" },
        payload: {
          expectedRevision: 1,
          secrets: { accessToken: secret }
        }
      });
      expect(failed.statusCode).toBe(500);
      expect(failed.json()).toEqual({
        error: expect.objectContaining({
          code: "PLUGIN_UPDATE_FAILED",
          message: "插件配置暂时无法保存，请稍后重试。"
        })
      });
      expect(failed.body).not.toContain(secret);
      expect(store.auditEvents).toEqual([
        expect.objectContaining({
          action: "plugin.update",
          pluginId: manifest.id,
          result: "failure",
          reasonCode: "internal_error",
          metadata: {}
        })
      ]);
      expect(JSON.stringify(store.auditEvents)).not.toContain(secret);
    } finally {
      await app.close();
    }
  });
});
