import {
  pluginSettingsFormSchema,
  type PermissionGrant
} from "@urmotiv/contracts";
import { pluginManifestSchema } from "@urmotiv/plugin-sdk";
import { afterEach, describe, expect, it } from "vitest";
import type { StoredUser } from "../src/domain";
import { createApp } from "../src/app";
import {
  anklangPluginId,
  createBuiltinPluginDefinitions,
  fermataManagementTokenSecretName,
  fermataPluginId
} from "../src/builtin-plugins";
import { demoTags } from "../src/demo-data";
import {
  AesGcmPluginSecretBox,
  InMemoryPluginStore,
  TrustedPluginHost
} from "../src/plugin-host";
import { InMemoryDataStore } from "../src/repository";

const pluginId = "org.example.private-admin-plugin";
const pluginName = "仅管理员可见的测试插件";
const origin = "http://localhost:5173";

function grant(
  permission: PermissionGrant["permission"],
  effect: PermissionGrant["effect"] = "allow"
): PermissionGrant {
  return { permission, effect, scope: "global" };
}

function createUser(
  id: string,
  accountType: StoredUser["accountType"],
  permissions: readonly PermissionGrant[]
): StoredUser {
  return {
    id,
    nickname: `测试账号 ${id}`,
    accountType,
    disabled: false,
    roles: [],
    isRoot: false,
    grants: [grant("auth.login"), ...permissions]
  };
}

function createPluginHost(store = new InMemoryPluginStore()): TrustedPluginHost {
  return new TrustedPluginHost(
    [{
      source: "builtin:admin-http-test",
      manifest: {
        id: pluginId,
        name: pluginName,
        version: "1.0.0",
        apiVersion: "1",
        permissions: []
      },
      secretDefinitions: [{
        name: "serviceToken",
        label: "服务认证令牌",
        description: "测试插件调用服务时使用。"
      }]
    }],
    store
  );
}

async function login(
  app: Awaited<ReturnType<typeof createApp>>,
  userId: string
): Promise<string> {
  const response = await app.inject({
    method: "POST",
    url: "/api/v1/auth/demo-login",
    headers: { origin },
    payload: { userId }
  });
  expect(response.statusCode).toBe(200);
  return (response.headers["set-cookie"] as string).split(";", 1)[0]!;
}

const openApps: Array<Awaited<ReturnType<typeof createApp>>> = [];

afterEach(async () => {
  await Promise.all(openApps.splice(0).map(async (app) => app.close()));
});

describe("插件管理 HTTP 接口", () => {
  it("内置 Anklang 设置默认给服务端重试和复核留足时间", () => {
    const definition = createBuiltinPluginDefinitions().find(
      (candidate) => pluginManifestSchema.parse(candidate.manifest).id === anklangPluginId
    );
    expect(definition).toBeDefined();
    expect(pluginManifestSchema.parse(definition?.manifest).version).toBe("0.3.0");
    const settingsSchema = pluginSettingsFormSchema.parse(definition?.settingsSchema);
    expect(settingsSchema.properties?.apiVersion?.default).toBe("2");
    const timeoutDefinition = settingsSchema.properties?.timeoutMs;
    expect(timeoutDefinition).toMatchObject({
      default: 120_000,
      maximum: 120_000
    });
    expect(timeoutDefinition?.maximum).toBeLessThanOrEqual(125_000);
  });

  it("列表与单项修改响应均禁止缓存", async () => {
    const manager = createUser("plugin-manager", "human", [grant("plugin.manage")]);
    const app = await createApp({
      store: new InMemoryDataStore([manager], demoTags),
      demoAuthEnabled: true,
      demoUserIds: [manager.id],
      pluginHost: createPluginHost()
    });
    openApps.push(app);
    const cookie = await login(app, manager.id);

    const list = await app.inject({
      method: "GET",
      url: "/api/v1/admin/plugins",
      headers: { cookie }
    });
    expect(list.statusCode).toBe(200);
    expect(list.headers["cache-control"]).toBe("private, no-store");
    expect(list.json()).toMatchObject({ items: [{ id: pluginId, name: pluginName }] });

    const update = await app.inject({
      method: "PATCH",
      url: `/api/v1/admin/plugins/${pluginId}`,
      headers: { cookie, origin },
      payload: { expectedRevision: 1, state: "enabled" }
    });
    expect(update.statusCode).toBe(200);
    expect(update.headers["cache-control"]).toBe("private, no-store");
    expect(update.json()).toMatchObject({ item: { id: pluginId, state: "enabled" } });

    const staleUpdate = await app.inject({
      method: "PATCH",
      url: `/api/v1/admin/plugins/${pluginId}`,
      headers: { cookie, origin },
      payload: { expectedRevision: 1, state: "disabled" }
    });
    expect(staleUpdate.statusCode).toBe(409);
    expect(staleUpdate.headers["cache-control"]).toBe("private, no-store");
  });

  it("Fermata 管理令牌通过声明的加密字段保存和清除", async () => {
    const manager = createUser("fermata-manager", "human", [
      grant("plugin.manage"),
      grant("system.manage")
    ]);
    const pluginHost = new TrustedPluginHost(
      createBuiltinPluginDefinitions(),
      new InMemoryPluginStore(),
      new AesGcmPluginSecretBox(Buffer.alloc(32, 6))
    );
    const app = await createApp({
      store: new InMemoryDataStore([manager], demoTags),
      demoAuthEnabled: true,
      demoUserIds: [manager.id],
      pluginHost
    });
    openApps.push(app);
    const cookie = await login(app, manager.id);
    const managementToken = "fermata-management-token-test-1234";

    const saved = await app.inject({
      method: "PATCH",
      url: `/api/v1/admin/plugins/${fermataPluginId}`,
      headers: { cookie, origin },
      payload: {
        expectedRevision: 1,
        state: "enabled",
        settings: { baseUrl: "http://127.0.0.1:8720" },
        secrets: { [fermataManagementTokenSecretName]: managementToken }
      }
    });
    expect(saved.statusCode).toBe(200);
    expect(saved.body).not.toContain(managementToken);
    expect(saved.json()).toMatchObject({
      item: {
        id: fermataPluginId,
        secrets: [{
          name: fermataManagementTokenSecretName,
          label: "管理令牌",
          configured: true,
          maskedSuffix: "1234"
        }]
      }
    });

    const cleared = await app.inject({
      method: "PATCH",
      url: `/api/v1/admin/plugins/${fermataPluginId}`,
      headers: { cookie, origin },
      payload: {
        expectedRevision: 2,
        clearSecrets: [fermataManagementTokenSecretName]
      }
    });
    expect(cleared.statusCode).toBe(200);
    expect(cleared.json()).toMatchObject({
      item: {
        id: fermataPluginId,
        secrets: [{
          name: fermataManagementTokenSecretName,
          configured: false,
          maskedSuffix: ""
        }]
      }
    });
  });

  it("缺少插件管理权限、明确拒绝和机器人固定限制都不能读取或修改插件", async () => {
    const blockedUsers = [
      createUser("explicitly-denied", "human", [
        grant("plugin.manage"),
        grant("plugin.manage", "deny")
      ]),
      createUser("system-only", "human", [grant("system.manage")]),
      createUser("robot-with-both", "robot", [
        grant("plugin.manage"),
        grant("system.manage")
      ])
    ];
    const pluginStore = new InMemoryPluginStore();
    const app = await createApp({
      store: new InMemoryDataStore(blockedUsers, demoTags),
      demoAuthEnabled: true,
      demoUserIds: blockedUsers.map((user) => user.id),
      pluginHost: createPluginHost(pluginStore)
    });
    openApps.push(app);

    for (const user of blockedUsers) {
      const cookie = await login(app, user.id);
      const list = await app.inject({
        method: "GET",
        url: "/api/v1/admin/plugins",
        headers: { cookie }
      });
      expect(list.statusCode, user.id).toBe(404);
      expect(list.headers["cache-control"], user.id).toBe("private, no-store");
      expect(list.json(), user.id).toMatchObject({
        error: { code: "NOT_FOUND", message: "未找到请求的资源。" }
      });
      expect(list.body, user.id).not.toContain(pluginId);
      expect(list.body, user.id).not.toContain(pluginName);

      const update = await app.inject({
        method: "PATCH",
        url: `/api/v1/admin/plugins/${pluginId}`,
        headers: { cookie, origin },
        payload: { expectedRevision: 1, state: "enabled" }
      });
      expect(update.statusCode, user.id).toBe(404);
      expect(update.headers["cache-control"], user.id).toBe("private, no-store");
      expect(update.json(), user.id).toMatchObject({
        error: { code: "NOT_FOUND", message: "未找到请求的资源。" }
      });
      expect(update.body, user.id).not.toContain(pluginId);
      expect(update.body, user.id).not.toContain(pluginName);
    }
    expect(pluginStore.auditEvents).toEqual(blockedUsers.map((user) => ({
      actorUserId: user.id,
      requestId: expect.any(String),
      action: "plugin.update",
      pluginId,
      result: "denied",
      reasonCode: "permission_denied",
      metadata: {}
    })));
  });

  it("只记录固定的失败原因，不把设置或密钥写进审计", async () => {
    const manager = createUser("audit-manager", "human", [
      grant("plugin.manage"),
      grant("system.manage")
    ]);
    const pluginStore = new InMemoryPluginStore();
    const app = await createApp({
      store: new InMemoryDataStore([manager], demoTags),
      demoAuthEnabled: true,
      demoUserIds: [manager.id],
      pluginHost: createPluginHost(pluginStore)
    });
    openApps.push(app);
    const cookie = await login(app, manager.id);

    const unauthenticated = await app.inject({
      method: "PATCH",
      url: `/api/v1/admin/plugins/${pluginId}`,
      headers: { origin },
      payload: { expectedRevision: 1, state: "enabled" }
    });
    expect(unauthenticated.statusCode).toBe(401);
    expect(pluginStore.auditEvents).toEqual([]);

    const requests = [
      {
        url: "/api/v1/admin/plugins/INVALID",
        payload: { expectedRevision: 1, state: "enabled" },
        status: 404,
        reasonCode: "invalid_input"
      },
      {
        url: `/api/v1/admin/plugins/${pluginId}`,
        payload: { expectedRevision: "one", state: "enabled" },
        status: 422,
        reasonCode: "invalid_input"
      },
      {
        url: `/api/v1/admin/plugins/${pluginId}`,
        payload: { expectedRevision: 1, settings: { marker: "setting-must-not-appear" } },
        status: 422,
        reasonCode: "invalid_plugin_settings"
      },
      {
        url: "/api/v1/admin/plugins/org.example.missing-plugin",
        payload: { expectedRevision: 1, state: "enabled" },
        status: 404,
        reasonCode: "plugin_not_found"
      }
    ] as const;
    for (const item of requests) {
      const response = await app.inject({
        method: "PATCH",
        url: item.url,
        headers: { cookie, origin },
        payload: item.payload
      });
      expect(response.statusCode).toBe(item.status);
      expect(pluginStore.auditEvents.at(-1)).toMatchObject({
        result: "failure",
        reasonCode: item.reasonCode,
        metadata: {}
      });
    }

    const saved = await app.inject({
      method: "PATCH",
      url: `/api/v1/admin/plugins/${pluginId}`,
      headers: { cookie, origin },
      payload: { expectedRevision: 1, state: "enabled" }
    });
    expect(saved.statusCode).toBe(200);
    const stale = await app.inject({
      method: "PATCH",
      url: `/api/v1/admin/plugins/${pluginId}`,
      headers: { cookie, origin },
      payload: { expectedRevision: 1, state: "disabled" }
    });
    expect(stale.statusCode).toBe(409);
    expect(pluginStore.auditEvents.at(-1)).toMatchObject({
      result: "failure",
      reasonCode: "revision_conflict",
      metadata: {}
    });

    const secretMarker = "secret-must-not-appear-1234";
    const failed = await app.inject({
      method: "PATCH",
      url: `/api/v1/admin/plugins/${pluginId}`,
      headers: { cookie, origin },
      payload: {
        expectedRevision: 2,
        secrets: { serviceToken: secretMarker }
      }
    });
    expect(failed.statusCode).toBe(500);
    expect(pluginStore.auditEvents.at(-1)).toMatchObject({
      result: "failure",
      reasonCode: "internal_error",
      metadata: {}
    });
    const auditText = JSON.stringify(pluginStore.auditEvents);
    expect(auditText).not.toContain("setting-must-not-appear");
    expect(auditText).not.toContain(secretMarker);
  });

  it("失败审计写入故障不改变原响应，成功更新不调用独立失败审计", async () => {
    class FailingAttemptAuditStore extends InMemoryPluginStore {
      public appendAttempts = 0;

      public override async appendAudit(): Promise<void> {
        this.appendAttempts += 1;
        throw new Error("audit storage marker must not be returned");
      }
    }
    const manager = createUser("audit-failure-manager", "human", [
      grant("plugin.manage"),
      grant("system.manage")
    ]);
    const pluginStore = new FailingAttemptAuditStore();
    const app = await createApp({
      store: new InMemoryDataStore([manager], demoTags),
      demoAuthEnabled: true,
      demoUserIds: [manager.id],
      pluginHost: createPluginHost(pluginStore)
    });
    openApps.push(app);
    const cookie = await login(app, manager.id);

    const invalid = await app.inject({
      method: "PATCH",
      url: `/api/v1/admin/plugins/${pluginId}`,
      headers: { cookie, origin },
      payload: { expectedRevision: "bad", state: "enabled" }
    });
    expect(invalid.statusCode).toBe(422);
    expect(invalid.body).not.toContain("audit storage marker");
    expect(pluginStore.appendAttempts).toBe(1);

    const saved = await app.inject({
      method: "PATCH",
      url: `/api/v1/admin/plugins/${pluginId}`,
      headers: { cookie, origin },
      payload: { expectedRevision: 1, state: "enabled" }
    });
    expect(saved.statusCode).toBe(200);
    expect(pluginStore.appendAttempts).toBe(1);
  });
});

describe("插件管理权限安全契约", () => {
  const blockedUsers = [
    createUser("security-explicit-deny", "human", [
      grant("plugin.manage"),
      grant("plugin.manage", "deny")
    ]),
    createUser("security-no-perm", "human", [grant("tag.manage")]),
    createUser("security-robot", "robot", [
      grant("plugin.manage"),
      grant("system.manage")
    ])
  ];

  async function setup(users: StoredUser[]): Promise<{
    app: Awaited<ReturnType<typeof createApp>>;
    cookie: (userId: string) => Promise<string>;
  }> {
    const app = await createApp({
      store: new InMemoryDataStore([...users, ...blockedUsers], demoTags),
      demoAuthEnabled: true,
      demoUserIds: [...users, ...blockedUsers].map((u) => u.id),
      pluginHost: createPluginHost()
    });
    openApps.push(app);
    return {
      app,
      cookie: (userId: string) => login(app, userId)
    };
  }

  it("无权访问（明确拒绝、无权限、机器人）统一返回 404，不泄露存在性", async () => {
    const { app, cookie } = await setup([
      createUser("security-manager", "human", [grant("plugin.manage"), grant("system.manage")])
    ]);

    for (const user of blockedUsers) {
      const session = await cookie(user.id);

      // GET list — 404
      const list = await app.inject({
        method: "GET",
        url: "/api/v1/admin/plugins",
        headers: { cookie: session }
      });
      expect(list.statusCode, user.id).toBe(404);
      expect(list.json(), user.id).toMatchObject({
        error: { code: "NOT_FOUND", message: "未找到请求的资源。" }
      });
      // 不泄露插件 ID 或名称
      expect(list.body, user.id).not.toContain(pluginId);
      expect(list.body, user.id).not.toContain(pluginName);

      // PATCH — 404
      const update = await app.inject({
        method: "PATCH",
        url: `/api/v1/admin/plugins/${pluginId}`,
        headers: { cookie: session, origin },
        payload: { expectedRevision: 1, state: "enabled" }
      });
      expect(update.statusCode, user.id).toBe(404);
      expect(update.json(), user.id).toMatchObject({
        error: { code: "NOT_FOUND", message: "未找到请求的资源。" }
      });
      expect(update.body, user.id).not.toContain(pluginId);
      expect(update.body, user.id).not.toContain(pluginName);
    }
  });

  it("真实不存在的插件 ID 与无权访问返回相同的 404 错误体", async () => {
    const { app, cookie } = await setup([
      createUser("security-manager", "human", [grant("plugin.manage"), grant("system.manage")])
    ]);
    const managerCookie = await cookie("security-manager");

    // 有权管理者访问真实不存在的插件 — 404
    const realNotFound = await app.inject({
      method: "PATCH",
      url: "/api/v1/admin/plugins/org.example.missing-plugin",
      headers: { cookie: managerCookie, origin },
      payload: { expectedRevision: 1, state: "enabled" }
    });
    expect(realNotFound.statusCode).toBe(404);

    // 无权用户访问任意插件 — 404
    const deniedCookie = await cookie("security-explicit-deny");
    const denied = await app.inject({
      method: "PATCH",
      url: `/api/v1/admin/plugins/${pluginId}`,
      headers: { cookie: deniedCookie, origin },
      payload: { expectedRevision: 1, state: "enabled" }
    });
    expect(denied.statusCode).toBe(404);

    // 两种 404 的错误体结构一致（code + message 相同）
    expect(denied.json().error.code).toBe(realNotFound.json().error.code);
    expect(denied.json().error.message).toBe(realNotFound.json().error.message);
  });

  it("有权管理者可以成功列出和修改插件", async () => {
    const { app, cookie } = await setup([
      createUser("security-manager", "human", [grant("plugin.manage"), grant("system.manage")])
    ]);
    const session = await cookie("security-manager");

    const list = await app.inject({
      method: "GET",
      url: "/api/v1/admin/plugins",
      headers: { cookie: session }
    });
    expect(list.statusCode).toBe(200);
    expect(list.json().items).toBeInstanceOf(Array);
    expect(list.json().items.length).toBeGreaterThan(0);

    const update = await app.inject({
      method: "PATCH",
      url: `/api/v1/admin/plugins/${pluginId}`,
      headers: { cookie: session, origin },
      payload: { expectedRevision: 1, state: "enabled" }
    });
    expect(update.statusCode).toBe(200);
  });

  it("所有插件端点响应含 cache-control: no-store 或更强的缓存头", async () => {
    const { app, cookie } = await setup([
      createUser("security-manager", "human", [grant("plugin.manage"), grant("system.manage")])
    ]);
    const session = await cookie("security-manager");

    // 有权 GET
    const list = await app.inject({
      method: "GET",
      url: "/api/v1/admin/plugins",
      headers: { cookie: session }
    });
    expect(list.headers["cache-control"]).toMatch(/no-store|no-cache/);

    // 无权 GET — 404 也必须有缓存头
    const deniedCookie = await cookie("security-no-perm");
    const denied = await app.inject({
      method: "GET",
      url: "/api/v1/admin/plugins",
      headers: { cookie: deniedCookie }
    });
    expect(denied.headers["cache-control"]).toMatch(/no-store|no-cache/);

    // 未认证 — 401 也必须有缓存头
    const unauth = await app.inject({
      method: "GET",
      url: "/api/v1/admin/plugins"
    });
    expect(unauth.statusCode).toBe(401);
    expect(unauth.headers["cache-control"]).toMatch(/no-store|no-cache/);
  });

  it("认证/会话端点响应含 cache-control: no-store", async () => {
    const { app, cookie } = await setup([
      createUser("security-manager", "human", [grant("plugin.manage"), grant("system.manage")])
    ]);

    // session
    const session = await app.inject({
      method: "GET",
      url: "/api/v1/session",
      headers: { cookie: await cookie("security-manager") }
    });
    expect(session.statusCode).toBe(200);
    expect(session.headers["cache-control"]).toMatch(/no-store|no-cache/);

    // demo-login
    const login = await app.inject({
      method: "POST",
      url: "/api/v1/auth/demo-login",
      headers: { origin },
      payload: { userId: "security-manager" }
    });
    expect(login.statusCode).toBe(200);
    expect(login.headers["cache-control"]).toMatch(/no-store|no-cache/);

    // logout
    const logout = await app.inject({
      method: "POST",
      url: "/api/v1/auth/logout",
      headers: { cookie: await cookie("security-manager"), origin }
    });
    expect(logout.statusCode).toBe(200);
    expect(logout.headers["cache-control"]).toMatch(/no-store|no-cache/);
  });
});
