import type { PermissionGrant } from "@urmotiv/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app";
import {
  anklangPluginId,
  createBuiltinPluginDefinitions
} from "../src/builtin-plugins";
import { demoTags } from "../src/demo-data";
import type { StoredUser } from "../src/domain";
import {
  AesGcmPluginSecretBox,
  InMemoryPluginStore,
  TrustedPluginHost
} from "../src/plugin-host";
import { InMemoryDataStore } from "../src/repository";

const origin = "http://localhost:5173";

function grant(permission: PermissionGrant["permission"]): PermissionGrant {
  return { permission, effect: "allow", scope: "global" };
}

function user(id: string, permissions: readonly PermissionGrant[]): StoredUser {
  return {
    id,
    nickname: id,
    accountType: "human",
    disabled: false,
    roles: [],
    isRoot: false,
    grants: [grant("auth.login"), ...permissions]
  };
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
  return (response.headers["set-cookie"] as string).split(";", 1)[0]!;
}

const apps: Array<Awaited<ReturnType<typeof createApp>>> = [];
afterEach(async () => Promise.all(apps.splice(0).map(async (app) => app.close())));

describe("Anklang 配置连接测试", () => {
  it("使用已加密保存的令牌测试 yuantiji，响应不回显令牌", async () => {
    const manager = user("anklang-manager", [grant("plugin.manage"), grant("system.manage")]);
    const token = "anklang-test-token-must-not-leak";
    const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      expect(String(input)).toContain("/api/v1/admin/search-sources/test");
      expect(init?.headers).toEqual(expect.objectContaining({ Authorization: `Bearer ${token}` }));
      return new Response(JSON.stringify({
        ok: true,
        yuantijiReady: true,
        yuantijiProblemCount: 250_000
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    });
    const pluginHost = new TrustedPluginHost(
      createBuiltinPluginDefinitions(),
      new InMemoryPluginStore(),
      new AesGcmPluginSecretBox(Buffer.alloc(32, 9))
    );
    const app = await createApp({
      store: new InMemoryDataStore([manager], demoTags),
      demoAuthEnabled: true,
      demoUserIds: [manager.id],
      pluginHost,
      anklangFetch: fetch
    });
    apps.push(app);
    const cookie = await login(app, manager.id);
    const saved = await app.inject({
      method: "PATCH",
      url: `/api/v1/admin/plugins/${anklangPluginId}`,
      headers: { cookie, origin },
      payload: {
        expectedRevision: 1,
        state: "enabled",
        settings: {
          baseUrl: "http://127.0.0.1:8730",
          searchMode: "yuantiji",
          privateContentAuthorized: true
        },
        secrets: { serviceToken: token }
      }
    });
    expect(saved.statusCode).toBe(200);

    const tested = await app.inject({
      method: "POST",
      url: "/api/v1/admin/anklang/test",
      headers: { cookie, origin },
      payload: { settings: saved.json().item.settings, secrets: {}, clearSecrets: [] }
    });

    expect(tested.statusCode).toBe(200);
    expect(tested.headers["cache-control"]).toBe("private, no-store");
    expect(tested.json()).toEqual({
      ok: true,
      search: { ok: true, yuantijiReady: true, yuantijiProblemCount: 250_000 },
      embedding: null
    });
    expect(tested.body).not.toContain(token);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("把已保存的 yuantiji 模式应用到 Anklang 并清除不再需要的嵌入配置", async () => {
    const manager = user("anklang-apply-manager", [grant("plugin.manage"), grant("system.manage")]);
    const token = "anklang-apply-token-must-not-leak";
    const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const path = new URL(String(input)).pathname;
      expect(init?.headers).toEqual(expect.objectContaining({ Authorization: `Bearer ${token}` }));
      if (path === "/api/v1/admin/search-sources") {
        return new Response(JSON.stringify({
          mode: "yuantiji",
          yuantijiBaseUrl: "https://yuantiji.ac",
          yuantijiRerank: false
        }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      expect(path).toBe("/api/v1/admin/embedding-provider");
      expect(init?.method).toBe("DELETE");
      return new Response(JSON.stringify({ configured: false }), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      });
    });
    const pluginHost = new TrustedPluginHost(
      createBuiltinPluginDefinitions(),
      new InMemoryPluginStore(),
      new AesGcmPluginSecretBox(Buffer.alloc(32, 10))
    );
    const app = await createApp({
      store: new InMemoryDataStore([manager], demoTags),
      demoAuthEnabled: true,
      demoUserIds: [manager.id],
      pluginHost,
      anklangFetch: fetch
    });
    apps.push(app);
    const cookie = await login(app, manager.id);
    const saved = await app.inject({
      method: "PATCH",
      url: `/api/v1/admin/plugins/${anklangPluginId}`,
      headers: { cookie, origin },
      payload: {
        expectedRevision: 1,
        state: "enabled",
        settings: {
          baseUrl: "http://127.0.0.1:8730",
          searchMode: "yuantiji",
          privateContentAuthorized: true
        },
        secrets: { serviceToken: token }
      }
    });
    expect(saved.statusCode).toBe(200);

    const applied = await app.inject({
      method: "POST",
      url: "/api/v1/admin/anklang/apply",
      headers: { cookie, origin }
    });

    expect(applied.statusCode).toBe(200);
    expect(applied.json()).toEqual({
      ok: true,
      search: {
        mode: "yuantiji",
        yuantijiBaseUrl: "https://yuantiji.ac",
        yuantijiRerank: false
      },
      provider: { configured: false }
    });
    expect(applied.body).not.toContain(token);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("缺少双重管理权限时按不存在返回且不外调", async () => {
    const blocked = user("plugin-only", [grant("plugin.manage")]);
    const fetch = vi.fn();
    const app = await createApp({
      store: new InMemoryDataStore([blocked], demoTags),
      demoAuthEnabled: true,
      demoUserIds: [blocked.id],
      anklangFetch: fetch
    });
    apps.push(app);
    const cookie = await login(app, blocked.id);

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/admin/anklang/test",
      headers: { cookie, origin },
      payload: { settings: {}, secrets: {}, clearSecrets: [] }
    });

    expect(response.statusCode).toBe(404);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("未确认题面处理范围时不发起连接测试", async () => {
    const manager = user("anklang-unapproved", [grant("plugin.manage"), grant("system.manage")]);
    const fetch = vi.fn();
    const pluginHost = new TrustedPluginHost(
      createBuiltinPluginDefinitions(),
      new InMemoryPluginStore(),
      new AesGcmPluginSecretBox(Buffer.alloc(32, 11))
    );
    const app = await createApp({
      store: new InMemoryDataStore([manager], demoTags),
      demoAuthEnabled: true,
      demoUserIds: [manager.id],
      pluginHost,
      anklangFetch: fetch
    });
    apps.push(app);
    const cookie = await login(app, manager.id);
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/admin/anklang/test",
      headers: { cookie, origin },
      payload: {
        settings: {
          baseUrl: "http://127.0.0.1:8730",
          searchMode: "yuantiji",
          privateContentAuthorized: false
        },
        secrets: { serviceToken: "anklang-unapproved-token-1234" },
        clearSecrets: []
      }
    });
    expect(response.statusCode).toBe(422);
    expect(response.body).not.toContain("anklang-unapproved-token");
    expect(fetch).not.toHaveBeenCalled();
  });
});
