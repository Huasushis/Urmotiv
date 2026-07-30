import { describe, expect, it, vi } from "vitest";
import {
  CasAuthenticationError,
  CasClient,
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
  public async put(digest: string, expiresAt: string): Promise<void> {
    this.values.set(digest, expiresAt);
  }
  public async consume(digest: string, now: string): Promise<boolean> {
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
  it("把状态放入 service 地址，校验后只能使用一次", async () => {
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

    await expect(
      client.finishLogin({ state: started.state, ticket: "ST-test-ticket" })
    ).resolves.toEqual({
      identity: parseCasIdentity(successXml(), configuration),
      returnTo: "/problems?owner=me"
    });
    await expect(
      client.finishLogin({ state: started.state, ticket: "ST-test-ticket" })
    ).rejects.toMatchObject({ code: "state_reused" });
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
