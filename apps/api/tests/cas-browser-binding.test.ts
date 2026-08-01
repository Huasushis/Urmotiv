import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CasClient, casBrowserBindingCookieName, type CasLoginStateStore } from "@urmotiv/auth";
import { createApp } from "../src/app";

const callbackPath = "/api/v1/auth/cas/callback";
const callbackUrl = `http://localhost:3000${callbackPath}`;

function successfulCasResponse(): string {
  return '<cas:serviceResponse xmlns:cas="http://www.yale.edu/tp/cas"><cas:authenticationSuccess><cas:user>login-name</cas:user><cas:attributes><cas:accountId>stable-account</cas:accountId><cas:name>CAS 用户</cas:name></cas:attributes></cas:authenticationSuccess></cas:serviceResponse>';
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

interface StartedFlow {
  readonly state: string;
  readonly cookieName: string;
  readonly cookieValue: string;
  readonly cookiePair: string;
  readonly cookieLine: string;
}

const openApps: FastifyInstance[] = [];

afterEach(async () => {
  await Promise.all(openApps.splice(0).map((app) => app.close()));
});

async function makeHarness(options: { validationStatus?: number; fetchFailure?: boolean } = {}) {
  const states = new TrackingStates();
  const fetch = vi.fn(async () => {
    if (options.fetchFailure === true) {
      throw new Error("synthetic CAS transport failure");
    }
    return new Response(successfulCasResponse(), {
      status: options.validationStatus ?? 200,
    });
  });
  const casClient = new CasClient({
    configuration: {
      loginUrl: "https://id.example/cas/login",
      validateUrl: "https://id.example/cas/serviceValidate",
      callbackUrl,
      subjectAttribute: "accountId",
      nicknameAttribute: "name",
      studentIdAttributes: [],
    },
    stateSecret: Buffer.alloc(32, 11),
    states,
    fetch,
  });
  const app = await createApp({ casClient });
  openApps.push(app);
  return { app, fetch, states };
}

function cookieLines(header: string | string[] | undefined): string[] {
  if (header === undefined) return [];
  return Array.isArray(header) ? header : [header];
}

async function startFlow(app: FastifyInstance, returnPath = "/problems"): Promise<StartedFlow> {
  const response = await app.inject({
    method: "GET",
    url: `/api/v1/auth/cas/start?returnPath=${encodeURIComponent(returnPath)}`,
  });
  expect(response.statusCode).toBe(302);
  expect(response.headers["cache-control"]).toBe("no-store");
  expect(response.headers["referrer-policy"]).toBe("no-referrer");

  const loginLocation = new URL(response.headers.location!);
  const serviceUrl = new URL(loginLocation.searchParams.get("service")!);
  const state = serviceUrl.searchParams.get("state")!;
  const expectedCookieName = casBrowserBindingCookieName(state);
  const line = cookieLines(response.headers["set-cookie"]).find((candidate) =>
    candidate.startsWith(`${expectedCookieName}=`),
  );
  expect(line).toBeDefined();
  const pair = line!.split(";", 1)[0]!;
  return {
    state,
    cookieName: expectedCookieName,
    cookieValue: pair.slice(pair.indexOf("=") + 1),
    cookiePair: pair,
    cookieLine: line!,
  };
}

function callbackRequest(state: string, ticket: string): string {
  return `${callbackPath}?state=${encodeURIComponent(state)}&ticket=${encodeURIComponent(ticket)}`;
}

function publicFailure(response: { statusCode: number; json(): unknown }) {
  const body = response.json() as {
    error: { code: string; message: string; requestId: string };
  };
  return {
    statusCode: response.statusCode,
    code: body.error.code,
    message: body.error.message,
  };
}

function expectBindingCookieAttributes(line: string): void {
  expect(line).toContain("Path=/");
  expect(line).toContain("HttpOnly");
  expect(line).toContain("Secure");
  expect(line).toContain("SameSite=Lax");
  expect(line.toLowerCase()).not.toContain("domain=");
}

describe("CAS 浏览器绑定", () => {
  it("用严格的 __Host- Cookie 启动登录，并把所有前置失败固定为不消耗的 401", async () => {
    const { app, fetch, states } = await makeHarness();
    const flow = await startFlow(app);

    expect(flow.cookieName).toMatch(/^__Host-urmotiv_cas_binding_[A-Za-z0-9_-]{43}$/);
    expect(flow.cookieValue).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(flow.cookieLine).toContain("Max-Age=600");
    expectBindingCookieAttributes(flow.cookieLine);

    const attempts = [
      await app.inject({
        method: "GET",
        url: callbackRequest(flow.state, "ST-missing-cookie"),
      }),
      await app.inject({
        method: "GET",
        url: callbackRequest(flow.state, "ST-wrong-cookie"),
        headers: { cookie: `${flow.cookieName}=${"A".repeat(43)}` },
      }),
      await app.inject({
        method: "GET",
        url: callbackRequest(flow.state, "ST-duplicate-cookie"),
        headers: { cookie: `${flow.cookiePair}; ${flow.cookiePair}` },
      }),
      await app.inject({
        method: "GET",
        url: `${callbackPath}?state=${encodeURIComponent(flow.state)}`,
        headers: { cookie: flow.cookiePair },
      }),
      await app.inject({
        method: "GET",
        url: `${callbackRequest(flow.state, "ST-extra-field")}&unexpected=1`,
        headers: { cookie: flow.cookiePair },
      }),
      await app.inject({
        method: "GET",
        url: callbackRequest("invalid-state", "ST-invalid-state"),
      }),
    ];

    for (const attempt of attempts) {
      expect(publicFailure(attempt)).toEqual({
        statusCode: 401,
        code: "UNAUTHENTICATED",
        message: "请先登录后再继续。",
      });
      expect(attempt.statusCode).toBe(401);
      expect(attempt.headers["cache-control"]).toBe("no-store");
      expect(attempt.headers["referrer-policy"]).toBe("no-referrer");
      expect(attempt.headers["set-cookie"]).toBeUndefined();
    }
    expect(states.consumeCalls).toBe(0);
    expect(fetch).not.toHaveBeenCalled();

    const success = await app.inject({
      method: "GET",
      url: callbackRequest(flow.state, "ST-valid"),
      headers: { cookie: flow.cookiePair },
    });
    expect(success.statusCode).toBe(302);
    expect(success.headers.location).toBe("/problems");
    expect(success.headers["cache-control"]).toBe("no-store");
    expect(success.headers["referrer-policy"]).toBe("no-referrer");
    const successCookies = cookieLines(success.headers["set-cookie"]);
    expect(successCookies.some((line) => line.startsWith("urmotiv_session="))).toBe(true);
    const clearedBinding = successCookies.find((line) => line.startsWith(`${flow.cookieName}=`));
    expect(clearedBinding).toBeDefined();
    expectBindingCookieAttributes(clearedBinding!);
    expect(clearedBinding).toMatch(/Max-Age=0|Expires=Thu, 01 Jan 1970/);
    expect(states.consumeCalls).toBe(1);
    expect(fetch).toHaveBeenCalledTimes(1);

    const replay = await app.inject({
      method: "GET",
      url: callbackRequest(flow.state, "ST-replay"),
      headers: { cookie: flow.cookiePair },
    });
    expect(publicFailure(replay)).toEqual({
      statusCode: 401,
      code: "UNAUTHENTICATED",
      message: "请先登录后再继续。",
    });
    expect(replay.headers["set-cookie"]).toBeUndefined();
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("两个标签页逆序回调时只清理各自的绑定 Cookie", async () => {
    const { app, fetch } = await makeHarness();
    const first = await startFlow(app, "/problems?tab=first");
    const second = await startFlow(app, "/problems?tab=second");
    expect(first.cookieName).not.toBe(second.cookieName);
    expect(first.cookieValue).not.toBe(second.cookieValue);

    const secondCallback = await app.inject({
      method: "GET",
      url: callbackRequest(second.state, "ST-second"),
      headers: { cookie: `${first.cookiePair}; ${second.cookiePair}` },
    });
    expect(secondCallback.statusCode).toBe(302);
    expect(secondCallback.headers.location).toBe("/problems?tab=second");
    const secondCookies = cookieLines(secondCallback.headers["set-cookie"]);
    expect(secondCookies.some((line) => line.startsWith(`${second.cookieName}=`))).toBe(true);
    expect(secondCookies.some((line) => line.startsWith(`${first.cookieName}=`))).toBe(false);
    const sessionCookie = secondCookies
      .find((line) => line.startsWith("urmotiv_session="))!
      .split(";", 1)[0]!;

    const firstCallback = await app.inject({
      method: "GET",
      url: callbackRequest(first.state, "ST-first"),
      headers: { cookie: `${first.cookiePair}; ${sessionCookie}` },
    });
    expect(firstCallback.statusCode).toBe(302);
    expect(firstCallback.headers.location).toBe("/problems?tab=first");
    const firstCookies = cookieLines(firstCallback.headers["set-cookie"]);
    expect(firstCookies.some((line) => line.startsWith(`${first.cookieName}=`))).toBe(true);
    expect(firstCookies.some((line) => line.startsWith(`${second.cookieName}=`))).toBe(false);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("同一 state 并发回调时只调用一次 CAS，失败响应不清 Cookie", async () => {
    const { app, fetch } = await makeHarness();
    const flow = await startFlow(app);
    const responses = await Promise.all([
      app.inject({
        method: "GET",
        url: callbackRequest(flow.state, "ST-concurrent-a"),
        headers: { cookie: flow.cookiePair },
      }),
      app.inject({
        method: "GET",
        url: callbackRequest(flow.state, "ST-concurrent-b"),
        headers: { cookie: flow.cookiePair },
      }),
    ]);

    expect(responses.map((response) => response.statusCode).sort()).toEqual([302, 401]);
    expect(fetch).toHaveBeenCalledTimes(1);
    const failed = responses.find((response) => response.statusCode === 401)!;
    expect(publicFailure(failed)).toEqual({
      statusCode: 401,
      code: "UNAUTHENTICATED",
      message: "请先登录后再继续。",
    });
    expect(failed.headers["set-cookie"]).toBeUndefined();
  });

  it("CAS 明确拒绝票据时返回固定 401，且不清浏览器绑定 Cookie", async () => {
    const { app, fetch, states } = await makeHarness({ validationStatus: 401 });
    const flow = await startFlow(app);
    const response = await app.inject({
      method: "GET",
      url: callbackRequest(flow.state, "ST-rejected"),
      headers: { cookie: flow.cookiePair },
    });

    expect(publicFailure(response)).toEqual({
      statusCode: 401,
      code: "UNAUTHENTICATED",
      message: "请先登录后再继续。",
    });
    expect(response.headers["set-cookie"]).toBeUndefined();
    expect(states.consumeCalls).toBe(1);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("CAS 传输异常也返回固定 401，且不清浏览器绑定 Cookie", async () => {
    const { app, fetch, states } = await makeHarness({ fetchFailure: true });
    const flow = await startFlow(app);
    const response = await app.inject({
      method: "GET",
      url: callbackRequest(flow.state, "ST-transport-failure"),
      headers: { cookie: flow.cookiePair },
    });

    expect(publicFailure(response)).toEqual({
      statusCode: 401,
      code: "UNAUTHENTICATED",
      message: "请先登录后再继续。",
    });
    expect(response.headers["set-cookie"]).toBeUndefined();
    expect(states.consumeCalls).toBe(1);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
