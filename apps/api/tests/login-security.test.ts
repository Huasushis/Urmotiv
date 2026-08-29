import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { createApp } from "../src/app";
import { createDemoUsers, demoTags } from "../src/demo-data";
import { InMemoryDataStore } from "../src/repository";
import { InMemoryEmailVerificationOutbox } from "../src/email-verification";
import {
  InMemoryLoginRateLimiterStorage,
  LoginRateLimiter
} from "../src/login-rate-limiter";

const origin = "http://localhost:5173";
const openApps: FastifyInstance[] = [];

afterEach(async () => {
  await Promise.all(openApps.splice(0).map(async (app) => app.close()));
});

async function makeVerifiedEmailApp(): Promise<{
  app: FastifyInstance;
  email: string;
  password: string;
}> {
  const outbox = new InMemoryEmailVerificationOutbox();
  const app = await createApp({
    emailRegistrationEnabled: true,
    emailVerificationDelivery: outbox,
    emailVerificationWebUrl: "http://localhost:5173"
  });
  openApps.push(app);
  const email = "verified.login@example.test";
  const password = "verified-login-password";
  const registration = await app.inject({
    method: "POST",
    url: "/api/v1/auth/email-register",
    headers: { origin },
    payload: { email, password, nickname: "验证登录账号" }
  });
  expect(registration.statusCode).toBe(202);
  const verificationUrl = new URL(outbox.messages[0]!.verificationUrl);
  const token = new URLSearchParams(verificationUrl.hash.split("?", 2)[1]).get("token");
  expect(token).toMatch(/^uve_/);
  const verify = await app.inject({
    method: "POST",
    url: "/api/v1/auth/email-verification/verify",
    headers: { origin },
    payload: { token }
  });
  expect(verify.statusCode).toBe(200);
  return { app, email, password };
}

function loginErrorShape(body: string): { code: string; message: string } {
  const parsed = JSON.parse(body) as { error?: { code?: string; message?: string } };
  return {
    code: parsed.error?.code ?? "",
    message: parsed.error?.message ?? ""
  };
}

describe("邮箱登录失败路径的响应一致性", () => {
  it("邮箱未知与口令错误都返回相同的 401 错误体（未知邮箱也会做一次 Argon2id 校验）", async () => {
    const { app, email, password } = await makeVerifiedEmailApp();
    void password;
    const wrongPassword = await app.inject({
      method: "POST",
      url: "/api/v1/auth/email-login",
      headers: { origin },
      payload: { email, password: "definitely-wrong-password" }
    });
    const unknownEmail = await app.inject({
      method: "POST",
      url: "/api/v1/auth/email-login",
      headers: { origin },
      payload: { email: "absent.user@example.test", password: "does-not-matter-123" }
    });
    expect(wrongPassword.statusCode).toBe(401);
    expect(unknownEmail.statusCode).toBe(401);
    expect(loginErrorShape(wrongPassword.body)).toEqual(loginErrorShape(unknownEmail.body));
  });

  it("正确口令成功登录并写入会话 Cookie", async () => {
    const { app, email, password } = await makeVerifiedEmailApp();
    const signedIn = await app.inject({
      method: "POST",
      url: "/api/v1/auth/email-login",
      headers: { origin },
      payload: { email, password }
    });
    expect(signedIn.statusCode).toBe(200);
    const setCookie = signedIn.headers["set-cookie"];
    const cookie = (Array.isArray(setCookie) ? setCookie[0] : setCookie) ?? "";
    expect(cookie).toContain("urmotiv_session=");
  });
});

describe("按来源地址限制登录尝试", () => {
  it("超过失败上限后即使口令正确也返回通用 429，响应不泄露邮箱", async () => {
    let now = 2_000_000;
    const { limiter } = createRateLimiter({
      maxFailedAttempts: 2,
      now: () => now
    });
    const app = await createApp({
      demoAuthEnabled: true,
      loginRateLimiter: limiter,
      store: new InMemoryDataStore(createDemoUsers(), demoTags)
    });
    openApps.push(app);
    // 前两次失败各记录一次（到达 maxFailedAttempts=2），第三次开始被阻止。
    const failures = [
      { email: "absent.a@example.test", password: "wrong-password-1" },
      { email: "absent.b@example.test", password: "wrong-password-2" }
    ];
    for (const attempt of failures) {
      const response = await app.inject({
        method: "POST",
        url: "/api/v1/auth/email-login",
        headers: { origin },
        payload: attempt
      });
      expect(response.statusCode).toBe(401);
    }
    const blocked = await app.inject({
      method: "POST",
      url: "/api/v1/auth/email-login",
      headers: { origin },
      payload: { email: "absent.d@example.test", password: "whatever-password" }
    });
    expect(blocked.statusCode).toBe(429);
    // 只断言固定错误码；框架标准错误体仍带 message/requestId。
    expect(loginErrorShape(blocked.body).code).toBe("LOGIN_RATE_LIMITED");
    expect(blocked.body).not.toContain("absent");

    // 窗口过期后恢复，不再是被限流的 429。
    now += 60_001;
    const retry = await app.inject({
      method: "POST",
      url: "/api/v1/auth/email-login",
      headers: { origin },
      payload: { email: "absent.d@example.test", password: "whatever-password" }
    });
    expect(retry.statusCode).toBe(401);
  });

});

function createRateLimiter(options: { maxFailedAttempts: number; now: () => number }): {
  limiter: LoginRateLimiter;
  store: InMemoryLoginRateLimiterStorage;
} {
  const store = new InMemoryLoginRateLimiterStorage();
  const limiter = new LoginRateLimiter({
    maxFailedAttempts: options.maxFailedAttempts,
    windowMs: 60_000,
    storage: store,
    now: options.now
  });
  return { limiter, store };
}
