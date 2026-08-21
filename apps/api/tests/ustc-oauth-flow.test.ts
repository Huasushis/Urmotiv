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
const clientSecret = "synthetic-client-secret-value";

const configuration: UstcOAuthConfiguration = {
  authorizeUrl: "https://idp.example.test/oauth2/authorize",
  tokenUrl: "https://idp.example.test/oauth2/accessToken",
  profileUrl: "https://idp.example.test/oauth2/profile",
  redirectUri: callbackUrl,
  clientId: "synthetic-client-id",
  clientSecret,
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

async function makeHarness(options: { profileBody?: string } = {}) {
  const states = new TrackingStates();
  let profileBody = options.profileBody ?? profileWith({});
  const fetch = vi.fn(async (input: string | URL | Request) => {
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
    fetch: fetch as unknown as typeof globalThis.fetch,
  });
  const app = await createApp({ ustcOAuthClient: client });
  openApps.push(app);
  return {
    app,
    fetch,
    states,
    setProfileBody(value: string) {
      profileBody = value;
    },
  };
}

interface StartedFlow {
  state: string;
  cookieName: string;
  cookiePair: string;
}

function cookieLines(header: string | string[] | undefined): string[] {
  if (header === undefined) return [];
  return Array.isArray(header) ? header : [header];
}

async function startFlow(app: FastifyInstance, returnPath = "/problems"): Promise<StartedFlow> {
  const response = await app.inject({
    method: "GET",
    url: `/api/v1/auth/ustc/start?returnPath=${encodeURIComponent(returnPath)}`,
  });
  expect(response.statusCode).toBe(302);
  expect(response.headers["cache-control"]).toBe("no-store");
  expect(response.headers["referrer-policy"]).toBe("no-referrer");

  const loginLocation = new URL(response.headers.location as string);
  const state = loginLocation.searchParams.get("state") as string;
  const expectedCookieName = ustcOAuthBrowserBindingCookieName(state);
  const line = cookieLines(response.headers["set-cookie"]).find((candidate) =>
    candidate.startsWith(`${expectedCookieName}=`),
  );
  expect(line).toBeDefined();
  const cookiePair = line!.split(";", 1)[0]!;
  return { state, cookieName: expectedCookieName, cookiePair };
}

function callbackRequest(state: string, code: string): string {
  return `${callbackPath}?state=${encodeURIComponent(state)}&code=${encodeURIComponent(code)}`;
}

function publicFailure(response: { statusCode: number; json(): unknown }): unknown {
  return (response.json() as { error: { code: string } }).error.code;
}

describe("USTC OAuth2 应用级流程", () => {
  it("启动与回调完整建档：gid 稳定身份、zjhm 作为用户名、name 作为姓名", async () => {
    const { app, states } = await makeHarness();
    const flow = await startFlow(app, "/problems?tab=2");
    expect(flow.cookieName).toMatch(/^__Host-urmotiv_ustc_binding_[A-Za-z0-9_-]{43}$/);

    const callback = await app.inject({
      method: "GET",
      url: callbackRequest(flow.state, "synthetic-code"),
      headers: { cookie: flow.cookiePair },
    });
    expect(callback.statusCode).toBe(302);
    expect(callback.headers["cache-control"]).toBe("no-store");
    expect(callback.headers["referrer-policy"]).toBe("no-referrer");
    expect(callback.headers.location).toContain("/problems?tab=2");
    const cookies = cookieLines(callback.headers["set-cookie"]);
    const sessionCookie = cookies.find((line) => line.startsWith("urmotiv_session="));
    expect(sessionCookie).toBeDefined();
    expect(states.consumeCalls).toBe(1);

    const profile = await app.inject({
      method: "GET",
      url: "/api/v1/me",
      headers: { cookie: sessionCookie!.split(";", 1)[0] },
    });
    expect(profile.statusCode).toBe(200);
    expect(profile.json()).toEqual(
      expect.objectContaining({
        username: "PB21000077",
        realName: "张三",
        email: "zhangsan@example.test",
        emailVerified: true,
        studentIds: [{ attribute: "zjhm", value: "PB21000077" }],
      }),
    );
  });

  it("重复登录同一 gid 复用账号，不新建、不覆盖现有昵称", async () => {
    const { app, states } = await makeHarness();
    const first = await startFlow(app);
    const firstCallback = await app.inject({
      method: "GET",
      url: callbackRequest(first.state, "code-1"),
      headers: { cookie: first.cookiePair },
    });
    expect(firstCallback.statusCode).toBe(302);
    const firstSession = cookieLines(firstCallback.headers["set-cookie"])
      .find((line) => line.startsWith("urmotiv_session="))!
      .split(";", 1)[0]!;

    const me = await app.inject({
      method: "GET",
      url: "/api/v1/me",
      headers: { cookie: firstSession },
    });
    const userId = (me.json() as { id: string }).id;
    const nickname = (me.json() as { nickname: string }).nickname;

    const second = await startFlow(app);
    const secondCallback = await app.inject({
      method: "GET",
      url: callbackRequest(second.state, "code-2"),
      headers: { cookie: second.cookiePair },
    });
    expect(secondCallback.statusCode).toBe(302);
    const secondSession = cookieLines(secondCallback.headers["set-cookie"])
      .find((line) => line.startsWith("urmotiv_session="))!
      .split(";", 1)[0]!;
    const after = await app.inject({
      method: "GET",
      url: "/api/v1/me",
      headers: { cookie: secondSession },
    });
    expect((after.json() as { id: string }).id).toBe(userId);
    expect((after.json() as { nickname: string }).nickname).toBe(nickname);
    expect(states.consumeCalls).toBe(2);
  });

  it("同一 zjhm 已绑定到其他 gid 时不自动改绑，直接失败关闭", async () => {
    const harness = await makeHarness();
    const first = await startFlow(harness.app);
    const firstCallback = await harness.app.inject({
      method: "GET",
      url: callbackRequest(first.state, "code-1"),
      headers: { cookie: first.cookiePair },
    });
    expect(firstCallback.statusCode).toBe(302);

    harness.setProfileBody(profileWith({ gid: "other-gid-999", name: "李四" }));
    const second = await startFlow(harness.app);
    const secondCallback = await harness.app.inject({
      method: "GET",
      url: callbackRequest(second.state, "code-2"),
      headers: { cookie: second.cookiePair },
    });
    // 同一学号不能自动改绑——按“未认证”失败关闭，不泄露差异。
    expect(secondCallback.statusCode).toBe(401);
    expect(publicFailure(secondCallback)).toBe("UNAUTHENTICATED");
    expect(harness.states.consumeCalls).toBe(2);
  });

  it("缺少 zjhm/name/email 建档字段时统一失败且不泄露资料差异", async () => {
    const { app, states } = await makeHarness({
      profileBody: profileWith({ email: undefined }),
    });
    const flow = await startFlow(app);
    const callback = await app.inject({
      method: "GET",
      url: callbackRequest(flow.state, "code-missing-email"),
      headers: { cookie: flow.cookiePair },
    });
    expect(callback.statusCode).toBe(401);
    expect(publicFailure(callback)).toBe("UNAUTHENTICATED");
    expect(callback.headers["cache-control"]).toBe("no-store");
    expect(callback.headers["referrer-policy"]).toBe("no-referrer");
    expect(callback.body).not.toContain("code-missing-email");
    expect(callback.body).not.toContain("PB21000077");
    expect(states.consumeCalls).toBe(1);
  });

  it("state 重放与浏览器绑定缺失/错误都按 401 失败关闭且不调用 IdP", async () => {
    const { app, states, fetch } = await makeHarness();
    const flow = await startFlow(app);
    const goodCallback = await app.inject({
      method: "GET",
      url: callbackRequest(flow.state, "code-good"),
      headers: { cookie: flow.cookiePair },
    });
    expect(goodCallback.statusCode).toBe(302);

    const replay = await app.inject({
      method: "GET",
      url: callbackRequest(flow.state, "code-replay"),
      headers: { cookie: flow.cookiePair },
    });
    expect(replay.statusCode).toBe(401);
    expect(publicFailure(replay)).toBe("UNAUTHENTICATED");
    expect(replay.body).not.toContain("code-replay");
    expect(fetch).toHaveBeenCalledTimes(2);

    const second = await startFlow(app);
    const noCookie = await app.inject({
      method: "GET",
      url: callbackRequest(second.state, "code-no-cookie"),
    });
    expect(noCookie.statusCode).toBe(401);
    expect(publicFailure(noCookie)).toBe("UNAUTHENTICATED");
    expect(fetch).toHaveBeenCalledTimes(2);

    const third = await startFlow(app);
    const wrongCookie = await app.inject({
      method: "GET",
      url: callbackRequest(third.state, "code-wrong-cookie"),
      headers: { cookie: `${third.cookieName}=${"B".repeat(43)}` },
    });
    expect(wrongCookie.statusCode).toBe(401);
    expect(publicFailure(wrongCookie)).toBe("UNAUTHENTICATED");
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(wrongCookie.headers["set-cookie"]).toBeUndefined();
    expect(states.consumeCalls).toBeLessThanOrEqual(2);
  });

  it("会话响应暴露 ustcOAuth 能力开关但不暴露任何密钥", async () => {
    const { app } = await makeHarness();
    const response = await app.inject({ method: "GET", url: "/api/v1/session" });
    expect(response.statusCode).toBe(200);
    const body = response.json() as { auth: Record<string, unknown> };
    expect(body.auth.ustcOAuthEnabled).toBe(true);
    expect(JSON.stringify(body)).not.toContain("synthetic");
  });
});
