import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  UstcOAuthClient,
  ustcOAuthBrowserBindingCookieName,
  type CasLoginStateStore,
  type UstcOAuthConfiguration,
} from "@urmotiv/auth";
import { createApp } from "../src/app";

const callbackPath = "/api/v1/auth/ustc/callback";
const callbackUrl = `https://site.example.test${callbackPath}`;
const localOrigin = "https://site.example.test";
const configuration: UstcOAuthConfiguration = {
  authorizeUrl: "https://id.ustc.edu.cn/cas/oauth2.0/authorize",
  tokenUrl: "https://id.ustc.edu.cn/cas/oauth2.0/accessToken",
  profileUrl: "https://id.ustc.edu.cn/cas/oauth2.0/profile",
  redirectUri: callbackUrl,
  clientId: "synthetic-client-id",
  clientSecret: "synthetic-client-secret-value",
};

function profileWith(overrides: Record<string, unknown>): string {
  return JSON.stringify({
    active: true,
    id: "campus-id-123",
    client_id: "synthetic-client-id",
    attributes: {
      gid: "stable-gid-456",
      name: "张三",
      zjhm: "PB21000077",
      email: "zhangsan@example.test",
      ...overrides,
    },
  });
}

class TrackingStates implements CasLoginStateStore {
  readonly values = new Map<string, string>();
  public consumeCalls = 0;

  public async put(digest: string, expiresAt: string): Promise<void> {
    this.values.set(digest, expiresAt);
  }

  public async consume(digest: string, now: string): Promise<boolean> {
    this.consumeCalls += 1;
    const expiresAt = this.values.get(digest);
    if (expiresAt === undefined || Date.parse(expiresAt) <= Date.parse(now)) {
      return false;
    }
    this.values.delete(digest);
    return true;
  }
}

const openApps: FastifyInstance[] = [];

afterEach(async () => {
  await Promise.all(openApps.splice(0).map((app) => app.close()));
});

async function makeHarness(
  options: { profileBody?: string; appFetch?: typeof fetch } = {}
) {
  const states = new TrackingStates();
  let profileBody = options.profileBody ?? profileWith({});
  const oauthFetch = vi.fn(async (input: string | URL | Request) => {
    const url = String(input);
    if (url.endsWith("/accessToken")) {
      return new Response(JSON.stringify({ access_token: "synthetic-access-token" }), {
        status: 200,
      });
    }
    if (url.endsWith("/profile")) {
      return new Response(profileBody, { status: 200 });
    }
    return new Response("not found", { status: 404 });
  });
  const client = new UstcOAuthClient({
    configuration,
    stateSecret: Buffer.alloc(32, 9),
    states,
    fetch: oauthFetch as unknown as typeof globalThis.fetch,
  });
  const app = await createApp({
    ustcOAuthClient: client,
    allowedOrigins: [localOrigin],
    secureCookies: true,
    ...(options.appFetch === undefined ? {} : { fetchImpl: options.appFetch }),
  });
  openApps.push(app);
  return { app, oauthFetch, states };
}

function cookieLines(header: string | string[] | undefined): string[] {
  if (header === undefined) return [];
  return Array.isArray(header) ? header : [header];
}

function loginViaOAuth(
  app: FastifyInstance,
  code = "synthetic-code",
): Promise<{ sessionCookie: string; state: string }> {
  return (async () => {
    const start = await app.inject({
      method: "GET",
      url: "/api/v1/auth/ustc/start?returnPath=%2Fproblems",
    });
    expect(start.statusCode).toBe(302);
    const location = new URL(start.headers.location as string);
    const state = location.searchParams.get("state") as string;
    const cookieName = ustcOAuthBrowserBindingCookieName(state);
    const bindingLine = cookieLines(start.headers["set-cookie"]).find((line) =>
      line.startsWith(`${cookieName}=`)
    );
    expect(bindingLine).toBeDefined();
    const bindingCookie = bindingLine!.split(";", 1)[0]!;

    const callback = await app.inject({
      method: "GET",
      url: `${callbackPath}?state=${encodeURIComponent(state)}&code=${encodeURIComponent(code)}`,
      headers: { cookie: bindingCookie },
    });
    expect(callback.statusCode).toBe(302);
    const sessionLine = cookieLines(callback.headers["set-cookie"]).find((line) =>
      line.startsWith("urmotiv_session=")
    );
    expect(sessionLine).toBeDefined();
    return { sessionCookie: sessionLine!.split(";", 1)[0]!, state };
  })();
}

const transparentPng = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64"
);

describe("R-ACCT-026 集成：统一身份登录后的个人资料与头像维护", () => {
  it("未登录访问个人资料与头像接口统一按未认证返回，不泄露字段差异", async () => {
    const { app, oauthFetch } = await makeHarness();
    const me = await app.inject({ method: "GET", url: "/api/v1/me" });
    expect(me.statusCode).toBe(401);
    const patch = await app.inject({
      method: "PATCH",
      url: "/api/v1/me",
      headers: { origin: localOrigin },
      payload: { qq: "123456789" },
    });
    expect(patch.statusCode).toBe(401);
    const avatar = await app.inject({ method: "PUT", url: "/api/v1/me/avatar" });
    expect(avatar.statusCode).toBe(401);
    const removeAvatar = await app.inject({ method: "DELETE", url: "/api/v1/me/avatar" });
    expect(removeAvatar.statusCode).toBe(401);
    const othersAvatar = await app.inject({
      method: "GET",
      url: "/api/v1/users/author/avatar",
    });
    expect(othersAvatar.statusCode).toBe(401);
    expect(oauthFetch).not.toHaveBeenCalled();
    for (const response of [me, patch, avatar, removeAvatar, othersAvatar]) {
      expect(response.body).not.toContain("PB21000077");
      expect(response.body).not.toContain("张三");
      expect(response.body).not.toContain("zhangsan@example.test");
    }
  });

  it("OAuth 建档后同一会话可维护 QQ、上传自己的头像并完整读回", async () => {
    const { app } = await makeHarness();
    const { sessionCookie } = await loginViaOAuth(app);

    const initial = await app.inject({
      method: "GET",
      url: "/api/v1/me",
      headers: { cookie: sessionCookie },
    });
    expect(initial.statusCode).toBe(200);
    expect(initial.json()).toEqual(
      expect.objectContaining({
        username: "PB21000077",
        realName: "张三",
        email: "zhangsan@example.test",
        emailVerified: true,
        qq: null,
        avatarSource: "none",
        avatarUrl: null,
        studentIds: [{ attribute: "zjhm", value: "PB21000077" }],
      })
    );

    const patched = await app.inject({
      method: "PATCH",
      url: "/api/v1/me",
      headers: { cookie: sessionCookie, origin: localOrigin },
      payload: { qq: "7654321" },
    });
    expect(patched.statusCode).toBe(200);
    expect(patched.json()).toEqual(expect.objectContaining({ qq: "7654321" }));

    const uploaded = await app.inject({
      method: "PUT",
      url: "/api/v1/me/avatar",
      headers: {
        cookie: sessionCookie,
        origin: localOrigin,
        "content-type": "application/octet-stream",
      },
      payload: transparentPng,
    });
    expect(uploaded.statusCode).toBe(200);
    expect(uploaded.json()).toEqual(
      expect.objectContaining({
        avatarSource: "uploaded",
        avatarUrl: expect.stringContaining("/api/v1/users/"),
      })
    );

    const finalProfile = await app.inject({
      method: "GET",
      url: "/api/v1/me",
      headers: { cookie: sessionCookie },
    });
    expect(finalProfile.statusCode).toBe(200);
    expect(finalProfile.json()).toEqual(
      expect.objectContaining({
        username: "PB21000077",
        realName: "张三",
        email: "zhangsan@example.test",
        qq: "7654321",
        avatarSource: "uploaded",
        avatarUrl: expect.stringContaining("/api/v1/users/"),
        studentIds: [{ attribute: "zjhm", value: "PB21000077" }],
      })
    );
    const serialized = JSON.stringify(finalProfile.json());
    expect(serialized).not.toContain("synthetic-access-token");
    expect(serialized).not.toContain("client-secret");
  });

  it("QQ 头像经服务端代理返回；抓取失败按不存在处理且不暴露 QQ 号码", async () => {
    const fetchedQqNumbers: string[] = [];
    const proxiedPng = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const appFetch: typeof fetch = async (url) => {
      const raw = String(url);
      const match = /nk=(\d+)/.exec(raw);
      if (match !== null) {
        fetchedQqNumbers.push(match[1]!);
      }
      return new Response(proxiedPng, { status: 200 });
    };
    const { app } = await makeHarness({ appFetch });
    const { sessionCookie } = await loginViaOAuth(app);

    const noQq = await app.inject({
      method: "PATCH",
      url: "/api/v1/me",
      headers: { cookie: sessionCookie, origin: localOrigin },
      payload: { avatarSource: "qq" },
    });
    expect(noQq.statusCode).toBe(409);

    await app.inject({
      method: "PATCH",
      url: "/api/v1/me",
      headers: { cookie: sessionCookie, origin: localOrigin },
      payload: { qq: "88888888", avatarSource: "qq" },
    });
    const profile = await app.inject({
      method: "GET",
      url: "/api/v1/me",
      headers: { cookie: sessionCookie },
    });
    expect(profile.json()).toEqual(
      expect.objectContaining({
        qq: "88888888",
        avatarSource: "qq",
        avatarUrl: expect.stringContaining("/api/v1/users/"),
      })
    );
    const avatarUrl = (profile.json() as { avatarUrl: string }).avatarUrl;
    expect(avatarUrl).not.toContain("88888888");

    const avatar = await app.inject({
      method: "GET",
      url: avatarUrl,
      headers: { cookie: sessionCookie },
    });
    expect(avatar.statusCode).toBe(200);
    expect(avatar.headers["content-type"]).toBe("image/png");
    expect(fetchedQqNumbers).toEqual(["88888888"]);
  });

  it("QQ 头像抓取失败按不存在处理，不暴露用户与 QQ 号码", async () => {
    const failingFetch: typeof fetch = async () => new Response("boom", { status: 502 });
    const { app } = await makeHarness({ appFetch: failingFetch });
    const { sessionCookie } = await loginViaOAuth(app);
    await app.inject({
      method: "PATCH",
      url: "/api/v1/me",
      headers: { cookie: sessionCookie, origin: localOrigin },
      payload: { qq: "7777777", avatarSource: "qq" },
    });
    const profile = await app.inject({
      method: "GET",
      url: "/api/v1/me",
      headers: { cookie: sessionCookie },
    });
    const avatarUrl = (profile.json() as { avatarUrl: string }).avatarUrl;
    const avatar = await app.inject({
      method: "GET",
      url: avatarUrl,
      headers: { cookie: sessionCookie },
    });
    expect(avatar.statusCode).toBe(404);
    expect(avatar.body).not.toContain("7777777");
    expect(avatar.body).not.toContain("张三");
  });
});
