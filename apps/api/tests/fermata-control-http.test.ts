import type { PermissionGrant } from "@urmotiv/contracts";
import type { FermataFetch } from "@urmotiv/plugin-fermata-control";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { StoredUser } from "../src/domain";
import { createApp } from "../src/app";
import {
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

const origin = "http://localhost:5173";
const managementToken = "fermata-management-token-test-1234";
const fermataBaseUrl = "http://fermata.test:4100";

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

function fakeHealth() {
  return {
    status: "ok" as const,
    service: "fermata" as const,
    apiVersion: "1" as const,
    workerRunning: true,
    activeTasks: 1,
    checkedAt: "2026-07-26T00:00:00.000Z"
  };
}

function fakeSettings() {
  return {
    settings: {
      enabled: true,
      pollingIntervalSeconds: 30,
      maximumConcurrentTasks: 2,
      modelProfileName: "review-balanced",
      experimentVersion: "experiment-2026-07"
    },
    revision: 4,
    secretsConfigured: true
  };
}

/** 造一个已经启用 Fermata 插件、保存了服务地址和管理令牌的插件宿主。 */
function makeConfiguredHost(): TrustedPluginHost {
  return new TrustedPluginHost(
    createBuiltinPluginDefinitions(),
    new InMemoryPluginStore(),
    new AesGcmPluginSecretBox(Buffer.alloc(32, 6))
  );
}

const openApps: Array<Awaited<ReturnType<typeof createApp>>> = [];

afterEach(async () => {
  await Promise.all(openApps.splice(0).map(async (app) => app.close()));
});

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

/** 用管理员账号登录、启用 Fermata 插件、保存服务地址和令牌，返回 cookie。 */
async function setupFermataPlugin(
  app: Awaited<ReturnType<typeof createApp>>,
  manager: StoredUser,
  baseUrl = fermataBaseUrl,
  token = managementToken
): Promise<string> {
  const cookie = await login(app, manager.id);
  const saved = await app.inject({
    method: "PATCH",
    url: `/api/v1/admin/plugins/${fermataPluginId}`,
    headers: { cookie, origin },
    payload: {
      expectedRevision: 1,
      state: "enabled",
      settings: { baseUrl, timeoutMs: 5000 },
      secrets: { [fermataManagementTokenSecretName]: token }
    }
  });
  expect(saved.statusCode).toBe(200);
  return cookie;
}

describe("Fermata 管理 HTTP 接口", () => {
  it("有权限的管理员能读取 Fermata 健康状态", async () => {
    const manager = createUser("fermata-manager", "human", [grant("plugin.manage")]);
    const fetch = vi.fn<FermataFetch>(async () =>
      new Response(JSON.stringify(fakeHealth()), { status: 200 })
    );
    const app = await createApp({
      store: new InMemoryDataStore([manager], demoTags),
      demoAuthEnabled: true,
      demoUserIds: [manager.id],
      pluginHost: makeConfiguredHost(),
      fermataFetch: fetch
    });
    openApps.push(app);
    const cookie = await setupFermataPlugin(app, manager);

    const response = await app.inject({
      method: "GET",
      url: "/api/v1/admin/fermata/health",
      headers: { cookie }
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers["cache-control"]).toBe("private, no-store");
    expect(response.json()).toEqual({ health: fakeHealth() });

    // 断言实际发起了请求，且带了管理令牌和版本头。
    expect(fetch).toHaveBeenCalledTimes(1);
    const [calledUrl, init] = fetch.mock.calls[0]!;
    expect(String(calledUrl)).toContain("/api/v1/health");
    expect(init?.headers).toEqual(
      expect.objectContaining({
        Authorization: `Bearer ${managementToken}`,
        "X-Urmotiv-API-Version": "1"
      })
    );
  });

  it("有权限的管理员能读取 Fermata 公开设置", async () => {
    const manager = createUser("fermata-manager", "human", [grant("plugin.manage")]);
    const fetch = vi.fn<FermataFetch>(async () =>
      new Response(JSON.stringify(fakeSettings()), { status: 200 })
    );
    const app = await createApp({
      store: new InMemoryDataStore([manager], demoTags),
      demoAuthEnabled: true,
      demoUserIds: [manager.id],
      pluginHost: makeConfiguredHost(),
      fermataFetch: fetch
    });
    openApps.push(app);
    const cookie = await setupFermataPlugin(app, manager);

    const response = await app.inject({
      method: "GET",
      url: "/api/v1/admin/fermata/settings",
      headers: { cookie }
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ settings: fakeSettings() });
  });

  it("有权限的管理员能更新 Fermata 公开设置", async () => {
    const manager = createUser("fermata-manager", "human", [grant("plugin.manage")]);
    const updatedSnapshot = { ...fakeSettings(), revision: 5 };
    const fetch = vi.fn<FermataFetch>(async (_url, init) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      expect(body).toEqual({ expectedRevision: 4, settings: fakeSettings().settings });
      return new Response(JSON.stringify(updatedSnapshot), { status: 200 });
    });
    const app = await createApp({
      store: new InMemoryDataStore([manager], demoTags),
      demoAuthEnabled: true,
      demoUserIds: [manager.id],
      pluginHost: makeConfiguredHost(),
      fermataFetch: fetch
    });
    openApps.push(app);
    const cookie = await setupFermataPlugin(app, manager);

    const response = await app.inject({
      method: "PUT",
      url: "/api/v1/admin/fermata/settings",
      headers: { cookie, origin },
      payload: { expectedRevision: 4, settings: fakeSettings().settings }
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ settings: updatedSnapshot });
  });

  it("有权限的管理员能触发 Fermata 立即检查", async () => {
    const manager = createUser("fermata-manager", "human", [grant("plugin.manage")]);
    const fetch = vi.fn<FermataFetch>(async () =>
      new Response(JSON.stringify({ ok: true }), { status: 200 })
    );
    const app = await createApp({
      store: new InMemoryDataStore([manager], demoTags),
      demoAuthEnabled: true,
      demoUserIds: [manager.id],
      pluginHost: makeConfiguredHost(),
      fermataFetch: fetch
    });
    openApps.push(app);
    const cookie = await setupFermataPlugin(app, manager);

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/admin/fermata/wake",
      headers: { cookie, origin }
    });
    expect(response.statusCode).toBe(204);
    expect(fetch).toHaveBeenCalledTimes(1);
    const [calledUrl] = fetch.mock.calls[0]!;
    expect(String(calledUrl)).toContain("/api/v1/actions/wake");
  });

  it("缺少 plugin.manage 权限的请求统一返回 404", async () => {
    const regular = createUser("regular-user", "human", []);
    const fetch = vi.fn<FermataFetch>();
    const app = await createApp({
      store: new InMemoryDataStore([regular], demoTags),
      demoAuthEnabled: true,
      demoUserIds: [regular.id],
      pluginHost: makeConfiguredHost(),
      fermataFetch: fetch
    });
    openApps.push(app);
    const cookie = await login(app, regular.id);

    for (const [method, url] of [
      ["GET", "/api/v1/admin/fermata/health"],
      ["GET", "/api/v1/admin/fermata/settings"],
      ["PUT", "/api/v1/admin/fermata/settings"],
      ["POST", "/api/v1/admin/fermata/wake"]
    ] as const) {
      const response = await app.inject({
        method,
        url,
        headers: { cookie, ...(method === "PUT" || method === "POST" ? { origin } : {}) },
        ...(method === "PUT"
          ? { payload: { expectedRevision: 1, settings: fakeSettings().settings } }
          : {})
      });
      expect(response.statusCode).toBe(404);
      expect(fetch).not.toHaveBeenCalled();
    }
  });

  it("未登录的请求返回 401，不调用 Fermata", async () => {
    const fetch = vi.fn<FermataFetch>();
    const app = await createApp({
      store: new InMemoryDataStore([], demoTags),
      demoAuthEnabled: true,
      pluginHost: makeConfiguredHost(),
      fermataFetch: fetch
    });
    openApps.push(app);

    const response = await app.inject({
      method: "GET",
      url: "/api/v1/admin/fermata/health"
    });
    expect(response.statusCode).toBe(401);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("Fermata 插件未启用时返回 503 FERMATA_NOT_CONFIGURED", async () => {
    const manager = createUser("fermata-manager", "human", [grant("plugin.manage")]);
    const fetch = vi.fn<FermataFetch>();
    const app = await createApp({
      store: new InMemoryDataStore([manager], demoTags),
      demoAuthEnabled: true,
      demoUserIds: [manager.id],
      pluginHost: makeConfiguredHost(),
      fermataFetch: fetch
    });
    openApps.push(app);
    // 登录但不启用插件
    const cookie = await login(app, manager.id);

    const response = await app.inject({
      method: "GET",
      url: "/api/v1/admin/fermata/health",
      headers: { cookie }
    });
    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({
      error: { code: "FERMATA_NOT_CONFIGURED" }
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("Fermata 插件已启用但缺少管理令牌时返回 503", async () => {
    const manager = createUser("fermata-manager", "human", [grant("plugin.manage")]);
    const fetch = vi.fn<FermataFetch>();
    const app = await createApp({
      store: new InMemoryDataStore([manager], demoTags),
      demoAuthEnabled: true,
      demoUserIds: [manager.id],
      pluginHost: makeConfiguredHost(),
      fermataFetch: fetch
    });
    openApps.push(app);
    const cookie = await login(app, manager.id);
    // 启用插件、保存地址，但不保存令牌
    const saved = await app.inject({
      method: "PATCH",
      url: `/api/v1/admin/plugins/${fermataPluginId}`,
      headers: { cookie, origin },
      payload: {
        expectedRevision: 1,
        state: "enabled",
        settings: { baseUrl: fermataBaseUrl, timeoutMs: 5000 }
      }
    });
    expect(saved.statusCode).toBe(200);

    const response = await app.inject({
      method: "GET",
      url: "/api/v1/admin/fermata/health",
      headers: { cookie }
    });
    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({
      error: { code: "FERMATA_NOT_CONFIGURED" }
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("Fermata 返回非 2xx 时返回 502 且不泄露原始错误体", async () => {
    const manager = createUser("fermata-manager", "human", [grant("plugin.manage")]);
    const fetch = vi.fn<FermataFetch>(async () =>
      new Response(JSON.stringify({ internal: "secret-details" }), { status: 500 })
    );
    const app = await createApp({
      store: new InMemoryDataStore([manager], demoTags),
      demoAuthEnabled: true,
      demoUserIds: [manager.id],
      pluginHost: makeConfiguredHost(),
      fermataFetch: fetch
    });
    openApps.push(app);
    const cookie = await setupFermataPlugin(app, manager);

    const response = await app.inject({
      method: "GET",
      url: "/api/v1/admin/fermata/health",
      headers: { cookie }
    });
    expect(response.statusCode).toBe(502);
    const body = response.json();
    expect(body.error.code).toBe("FERMATA_REQUEST_FAILED");
    expect(response.body).not.toContain("secret-details");
  });

  it("Fermata 返回不符合契约的内容时返回 502", async () => {
    const manager = createUser("fermata-manager", "human", [grant("plugin.manage")]);
    const fetch = vi.fn<FermataFetch>(async () =>
      new Response(JSON.stringify({ unexpected: "shape" }), { status: 200 })
    );
    const app = await createApp({
      store: new InMemoryDataStore([manager], demoTags),
      demoAuthEnabled: true,
      demoUserIds: [manager.id],
      pluginHost: makeConfiguredHost(),
      fermataFetch: fetch
    });
    openApps.push(app);
    const cookie = await setupFermataPlugin(app, manager);

    const response = await app.inject({
      method: "GET",
      url: "/api/v1/admin/fermata/health",
      headers: { cookie }
    });
    expect(response.statusCode).toBe(502);
    expect(response.json()).toMatchObject({
      error: { code: "FERMATA_RESPONSE_INVALID" }
    });
  });

  it("Fermata 不可达时返回 503 且不泄露网络错误细节", async () => {
    const manager = createUser("fermata-manager", "human", [grant("plugin.manage")]);
    const fetch = vi.fn<FermataFetch>(async () => {
      throw new TypeError("fetch failed: ECONNREFUSED 127.0.0.1:4100");
    });
    const app = await createApp({
      store: new InMemoryDataStore([manager], demoTags),
      demoAuthEnabled: true,
      demoUserIds: [manager.id],
      pluginHost: makeConfiguredHost(),
      fermataFetch: fetch
    });
    openApps.push(app);
    const cookie = await setupFermataPlugin(app, manager);

    const response = await app.inject({
      method: "GET",
      url: "/api/v1/admin/fermata/health",
      headers: { cookie }
    });
    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({
      error: { code: "FERMATA_UNAVAILABLE" }
    });
    expect(response.body).not.toContain("ECONNREFUSED");
  });

  it("PUT 设置时提交无效输入返回 422", async () => {
    const manager = createUser("fermata-manager", "human", [grant("plugin.manage")]);
    const fetch = vi.fn<FermataFetch>();
    const app = await createApp({
      store: new InMemoryDataStore([manager], demoTags),
      demoAuthEnabled: true,
      demoUserIds: [manager.id],
      pluginHost: makeConfiguredHost(),
      fermataFetch: fetch
    });
    openApps.push(app);
    const cookie = await setupFermataPlugin(app, manager);

    const response = await app.inject({
      method: "PUT",
      url: "/api/v1/admin/fermata/settings",
      headers: { cookie, origin },
      payload: { expectedRevision: 1 }
    });
    expect(response.statusCode).toBe(422);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("机器人账号即使被错误分配 plugin.manage 也不能访问 Fermata 管理接口", async () => {
    // 机器人固定禁止 plugin.manage（robotHardDeniedPermissions），所以即使
    // grant 里有 allow，hasPermission 也会返回 false，路由返回 404。
    const robot = createUser("fermata-robot", "robot", [grant("plugin.manage")]);
    const fetch = vi.fn<FermataFetch>();
    const app = await createApp({
      store: new InMemoryDataStore([robot], demoTags),
      demoAuthEnabled: true,
      demoUserIds: [robot.id],
      pluginHost: makeConfiguredHost(),
      fermataFetch: fetch
    });
    openApps.push(app);
    const cookie = await login(app, robot.id);

    const response = await app.inject({
      method: "GET",
      url: "/api/v1/admin/fermata/health",
      headers: { cookie }
    });
    expect(response.statusCode).toBe(404);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("响应中不包含管理令牌", async () => {
    const manager = createUser("fermata-manager", "human", [grant("plugin.manage")]);
    const fetch = vi.fn<FermataFetch>(async () =>
      new Response(JSON.stringify(fakeHealth()), { status: 200 })
    );
    const app = await createApp({
      store: new InMemoryDataStore([manager], demoTags),
      demoAuthEnabled: true,
      demoUserIds: [manager.id],
      pluginHost: makeConfiguredHost(),
      fermataFetch: fetch
    });
    openApps.push(app);
    const cookie = await setupFermataPlugin(app, manager);

    const response = await app.inject({
      method: "GET",
      url: "/api/v1/admin/fermata/health",
      headers: { cookie }
    });
    expect(response.statusCode).toBe(200);
    expect(response.body).not.toContain(managementToken);
  });
});
