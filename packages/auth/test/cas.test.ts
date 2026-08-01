import { createHmac } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  CasAuthenticationError,
  CasClient,
  casBrowserBindingCookieName,
  parseCasIdentity,
  type CasLoginStateStore
} from "../src/cas";

const configuration = {
  loginUrl: "https://id.ustc.edu.cn/cas/login",
  validateUrl: "https://id.ustc.edu.cn/cas/serviceValidate",
  callbackUrl: "https://problems.example.test/api/v1/auth/cas/callback",
  subjectAttribute: "gid",
  emailAttribute: "mail",
  nicknameAttribute: "displayName",
  studentIdAttributes: ["studentId", "formerStudentId"]
};

function successXml() {
  return `<?xml version="1.0" encoding="UTF-8"?>
  <cas:serviceResponse xmlns:cas="http://www.yale.edu/tp/cas">
    <cas:authenticationSuccess>
      <cas:user>login-name</cas:user>
      <cas:attributes>
        <cas:gid>stable-subject</cas:gid>
        <cas:mail>student@example.test</cas:mail>
        <cas:displayName>测试账号</cas:displayName>
        <cas:studentId>PB00000000</cas:studentId>
        <cas:formerStudentId>SA00000000</cas:formerStudentId>
      </cas:attributes>
    </cas:authenticationSuccess>
  </cas:serviceResponse>`;
}

class MemoryStates implements CasLoginStateStore {
  readonly values = new Map<string, string>();
  public putCalls = 0;
  public consumeCalls = 0;
  public async put(digest: string, expiresAt: string): Promise<void> {
    this.putCalls += 1;
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

describe("CAS 返回结构", () => {
  it("只使用明确配置的稳定身份字段并保留多个学号", () => {
    expect(parseCasIdentity(successXml(), configuration)).toEqual({
      provider: "ustc-cas",
      subject: "stable-subject",
      email: "student@example.test",
      nickname: "测试账号",
      studentIds: [
        { attribute: "studentId", value: "PB00000000" },
        { attribute: "formerStudentId", value: "SA00000000" }
      ],
      availableAttributeNames: [
        "cas:user",
        "displayName",
        "formerStudentId",
        "gid",
        "mail",
        "studentId"
      ]
    });
  });

  it("稳定身份字段缺失时返回字段名而不泄露字段值", () => {
    try {
      parseCasIdentity(successXml(), { ...configuration, subjectAttribute: "missing" });
      throw new Error("预期解析失败");
    } catch (error) {
      expect(error).toBeInstanceOf(CasAuthenticationError);
      expect((error as CasAuthenticationError).code).toBe("subject_attribute_missing");
      expect((error as CasAuthenticationError).availableAttributeNames).toContain("studentId");
      expect(error).not.toHaveProperty("message", expect.stringContaining("PB00000000"));
    }
  });

  it("拒绝带外部实体声明的 XML", () => {
    expect(() =>
      parseCasIdentity(`<!DOCTYPE foo [<!ENTITY xxe SYSTEM "file:///etc/passwd">]>${successXml()}`, configuration)
    ).toThrow("不允许的 XML 声明");
  });
});

describe("CAS 登录状态和票据校验", () => {
  it("只把浏览器绑定摘要写入 v2 状态，校验后只能使用一次", async () => {
    const states = new MemoryStates();
    const fetch = vi.fn(async (url: string | URL | Request) => {
      const validateUrl = new URL(String(url));
      expect(validateUrl.searchParams.get("ticket")).toBe("ST-test-ticket");
      expect(validateUrl.searchParams.get("service")).toContain("state=");
      return new Response(successXml(), { status: 200 });
    });
    const client = new CasClient({
      configuration,
      stateSecret: new TextEncoder().encode("0123456789abcdef0123456789abcdef"),
      states,
      fetch,
      now: () => new Date("2026-07-26T00:00:00.000Z")
    });
    const started = await client.startLogin("/problems?owner=me");
    expect(new URL(started.loginUrl).searchParams.get("service")).toBe(started.serviceUrl);
    expect(started.browserBindingCookie).toMatchObject({
      name: casBrowserBindingCookieName(started.state),
      maxAgeSeconds: 600
    });
    expect(started.browserBindingCookie.value).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const encodedPayload = started.state.split(".", 1)[0];
    expect(encodedPayload).toBeDefined();
    const payload = JSON.parse(
      Buffer.from(encodedPayload!, "base64url").toString("utf8")
    ) as Record<string, unknown>;
    expect(payload).toMatchObject({
      version: 2,
      browserBindingDigest: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/)
    });
    expect(payload).not.toHaveProperty("browserBinding");
    expect(JSON.stringify(payload)).not.toContain(started.browserBindingCookie.value);
    expect([...states.values.keys()]).toEqual([expect.stringMatching(/^[0-9a-f]{64}$/)]);
    expect([...states.values.keys()]).not.toContain(started.browserBindingCookie.value);

    await expect(
      client.finishLogin({
        state: started.state,
        ticket: "ST-test-ticket",
        browserBinding: started.browserBindingCookie.value
      })
    ).resolves.toEqual({
      identity: parseCasIdentity(successXml(), configuration),
      returnTo: "/problems?owner=me"
    });
    await expect(
      client.finishLogin({
        state: started.state,
        ticket: "ST-test-ticket",
        browserBinding: started.browserBindingCookie.value
      })
    ).rejects.toMatchObject({ code: "state_reused" });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("绑定缺失、错误或票据畸形时不消费状态也不请求 CAS", async () => {
    const states = new MemoryStates();
    const fetch = vi.fn(async () => new Response(successXml(), { status: 200 }));
    const client = new CasClient({
      configuration,
      stateSecret: new Uint8Array(32).fill(3),
      states,
      fetch,
      now: () => new Date("2026-07-26T00:00:00.000Z")
    });
    const started = await client.startLogin("/problems");

    await expect(
      client.finishLogin({ state: started.state, ticket: "ST-one", browserBinding: undefined })
    ).rejects.toMatchObject({ code: "browser_binding_invalid" });
    await expect(
      client.finishLogin({
        state: started.state,
        ticket: "ST-two",
        browserBinding: "A".repeat(43)
      })
    ).rejects.toMatchObject({ code: "browser_binding_invalid" });
    await expect(
      client.finishLogin({
        state: started.state,
        ticket: " ",
        browserBinding: started.browserBindingCookie.value
      })
    ).rejects.toMatchObject({ code: "invalid_ticket" });

    expect(states.consumeCalls).toBe(0);
    expect(fetch).not.toHaveBeenCalled();
    await expect(
      client.finishLogin({
        state: started.state,
        ticket: "ST-valid",
        browserBinding: started.browserBindingCookie.value
      })
    ).resolves.toMatchObject({ returnTo: "/problems" });
    expect(states.consumeCalls).toBe(1);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("过期状态和协调切换前的 v1 状态都失败关闭", async () => {
    const states = new MemoryStates();
    const fetch = vi.fn(async () => new Response(successXml(), { status: 200 }));
    let now = new Date("2026-07-26T00:00:00.000Z");
    const secret = new Uint8Array(32).fill(5);
    const client = new CasClient({
      configuration,
      stateSecret: secret,
      states,
      fetch,
      now: () => now
    });
    const started = await client.startLogin("/problems");
    now = new Date("2026-07-26T00:11:00.000Z");
    await expect(
      client.finishLogin({
        state: started.state,
        ticket: "ST-expired",
        browserBinding: started.browserBindingCookie.value
      })
    ).rejects.toMatchObject({ code: "state_expired" });

    const legacyPayload = Buffer.from(JSON.stringify({
      version: 1,
      nonce: "legacy-state-nonce-1234567890",
      returnTo: "/problems",
      issuedAt: "2026-07-26T00:00:00.000Z",
      expiresAt: "2026-07-26T00:10:00.000Z"
    }), "utf8").toString("base64url");
    const legacySignature = createHmac("sha256", secret)
      .update(legacyPayload)
      .digest("base64url");
    await expect(
      client.finishLogin({
        state: `${legacyPayload}.${legacySignature}`,
        ticket: "ST-legacy",
        browserBinding: "A".repeat(43)
      })
    ).rejects.toMatchObject({ code: "invalid_state" });

    expect(states.consumeCalls).toBe(0);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("相同状态并发回调最多校验一次 CAS 票据", async () => {
    const states = new MemoryStates();
    const fetch = vi.fn(async () => new Response(successXml(), { status: 200 }));
    const client = new CasClient({
      configuration,
      stateSecret: new Uint8Array(32).fill(9),
      states,
      fetch,
      now: () => new Date("2026-07-26T00:00:00.000Z")
    });
    const started = await client.startLogin("/problems");
    const results = await Promise.allSettled([
      client.finishLogin({
        state: started.state,
        ticket: "ST-concurrent-a",
        browserBinding: started.browserBindingCookie.value
      }),
      client.finishLogin({
        state: started.state,
        ticket: "ST-concurrent-b",
        browserBinding: started.browserBindingCookie.value
      })
    ]);

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find((result) => result.status === "rejected");
    expect(rejected).toMatchObject({
      status: "rejected",
      reason: expect.objectContaining({ code: "state_reused" })
    });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("拒绝把站外网址作为登录后的返回地址", async () => {
    const client = new CasClient({
      configuration,
      stateSecret: new Uint8Array(32).fill(7),
      states: new MemoryStates()
    });
    await expect(client.startLogin("//evil.example/path")).rejects.toMatchObject({
      code: "invalid_return_path"
    });
  });
});
