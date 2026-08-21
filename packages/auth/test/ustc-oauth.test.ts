import { describe, expect, it } from "vitest";
import {
  UstcOAuthClient,
  ustcOAuthConfigurationSchema,
  type CasLoginStateStore,
} from "@urmotiv/auth";

const clientId = "synthetic-client-id";
const clientSecret = "synthetic-client-secret-value";

const baseConfig = {
  authorizeUrl: "https://idp.example.test/oauth2/authorize",
  tokenUrl: "https://idp.example.test/oauth2/accessToken",
  profileUrl: "https://idp.example.test/oauth2/profile",
  redirectUri: "https://site.example.test/api/v1/auth/ustc/callback",
  clientId,
  clientSecret,
};

interface RequestRecord {
  url: string;
  body: string;
}

class RecordingFetch {
  public readonly calls: RequestRecord[] = [];
  private tokenBody = JSON.stringify({ access_token: "synthetic-access-token" });
  private profileBody = JSON.stringify({
    active: true,
    id: "campus-id-123",
    client_id: clientId,
    attributes: {
      gid: "stable-gid-456",
      name: "张三",
      zjhm: "PB21000077",
      email: "zhangsan@example.test",
    },
  });
  public responseStatus = 200;

  public setProfile(value: unknown): void {
    this.profileBody = JSON.stringify(value);
  }

  public setToken(value: unknown): void {
    this.tokenBody = JSON.stringify(value);
  }

  public readonly impl: typeof fetch = async (input, init) => {
    const url = String(input);
    this.calls.push({ url, body: String(init?.body ?? "") });
    if (url.endsWith("/accessToken")) {
      return new Response(this.tokenBody, { status: this.responseStatus });
    }
    if (url.endsWith("/profile")) {
      return new Response(this.profileBody, { status: this.responseStatus });
    }
    return new Response("not found", { status: 404 });
  };
}

class TrackingStates implements CasLoginStateStore {
  public readonly values = new Map<string, string>();
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

function makeClient(
  overrides: {
    fetch?: typeof fetch;
    now?: () => Date;
  } = {},
) {
  const states = new TrackingStates();
  const recording = new RecordingFetch();
  const client = new UstcOAuthClient({
    configuration: baseConfig,
    stateSecret: Buffer.alloc(32, 7),
    states,
    fetch: overrides.fetch ?? (recording.impl as typeof fetch),
    ...(overrides.now === undefined ? {} : { now: overrides.now }),
  });
  return { client, recording, states };
}

describe("USTC OAuth2 授权码流程", () => {
  it("配置校验：clientId 必填、clientSecret 至少 16 字节、回调只接受固定路径", () => {
    expect(() =>
      ustcOAuthConfigurationSchema.parse({ ...baseConfig, clientId: "" }),
    ).toThrow();
    expect(() =>
      ustcOAuthConfigurationSchema.parse({ ...baseConfig, clientSecret: "short" }),
    ).toThrow();
    expect(() =>
      ustcOAuthConfigurationSchema.parse({
        ...baseConfig,
        redirectUri: "https://site.example.test/other/callback",
      }),
    ).toThrow();
    expect(
      () =>
        ustcOAuthConfigurationSchema.parse({
          ...baseConfig,
          redirectUri: "https://site.example.test/api/v1/auth/ustc/callback?extra=1",
        }),
    ).toThrow();
    expect(() => ustcOAuthConfigurationSchema.parse(baseConfig)).not.toThrow();
  });

  it("startLogin 生成一次性 state 的授权 URL，保留安全返回路径", async () => {
    const { client, states, recording } = makeClient();
    const start = await client.startLogin("/problems?tab=2");
    const url = new URL(start.authorizeUrl);
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("client_id")).toBe(clientId);
    expect(url.searchParams.get("redirect_uri")).toBe(baseConfig.redirectUri);
    expect(url.searchParams.get("state")).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
    expect(url.searchParams.get("scope")).toBeNull();
    expect(start.returnTo).toBe("/problems?tab=2");
    expect(states.values.size).toBe(1);
    expect(recording.calls).toHaveLength(0);
    await expect(client.startLogin("//evil.example.test/path")).rejects.toThrow();
    await expect(client.startLogin("https://evil.example.test/path")).rejects.toThrow();
  });

  it("finishLogin 换码取资料，映射 gid/zjhm/name/email，绑定一次消费", async () => {
    const { client, states, recording } = makeClient();
    const start = await client.startLogin("/");
    const result = await client.finishLogin({
      state: start.state,
      code: "synthetic-auth-code",
      browserBinding: start.browserBindingCookie.value,
    });

    expect(result.identity.provider).toBe("ustc-oauth");
    expect(result.identity.subject).toBe("stable-gid-456");
    expect(result.identity.username).toBe("PB21000077");
    expect(result.identity.realName).toBe("张三");
    expect(result.identity.email).toBe("zhangsan@example.test");
    expect(result.identity.nickname).toBe("张三");
    expect(result.identity.studentIds).toEqual([
      { attribute: "zjhm", value: "PB21000077" },
    ]);

    const tokenCall = recording.calls.find((call) =>
      call.url.endsWith("/accessToken"),
    );
    expect(tokenCall).toBeDefined();
    expect(tokenCall!.body).toContain("grant_type=authorization_code");
    expect(tokenCall!.body).toContain(`client_id=${encodeURIComponent(clientId)}`);
    expect(tokenCall!.body).toContain(
      `client_secret=${encodeURIComponent(clientSecret)}`,
    );
    expect(tokenCall!.body).toContain(
      `redirect_uri=${encodeURIComponent(baseConfig.redirectUri)}`,
    );
    const profileCall = recording.calls.find((call) =>
      call.url.endsWith("/profile"),
    );
    expect(profileCall).toBeDefined();
    expect(profileCall!.body).toContain(encodeURIComponent("synthetic-access-token"));
    expect(states.consumeCalls).toBe(1);
  });

  it("无 gid/id 时失败；profile 非 active 失败；令牌缺失失败", async () => {
    const { client, recording } = makeClient();
    const first = await client.startLogin("/");
    recording.setProfile({
      active: true,
      client_id: clientId,
      attributes: { name: "无身份" },
    });
    await expect(
      client.finishLogin({
        state: first.state,
        code: "c",
        browserBinding: first.browserBindingCookie.value,
      }),
    ).rejects.toThrow();

    const second = await client.startLogin("/");
    recording.setProfile({ active: false, id: "x", client_id: clientId });
    await expect(
      client.finishLogin({
        state: second.state,
        code: "c",
        browserBinding: second.browserBindingCookie.value,
      }),
    ).rejects.toThrow();

    const third = await client.startLogin("/");
    recording.setToken({});
    await expect(
      client.finishLogin({
        state: third.state,
        code: "c",
        browserBinding: third.browserBindingCookie.value,
      }),
    ).rejects.toThrow();
  });

  it("gid 缺失时使用顶层 id；错误 client_id 的资料失败关闭", async () => {
    const { client, recording } = makeClient();
    recording.setProfile({
      active: true,
      id: "stable-top-level-id",
      client_id: clientId,
      attributes: {
        name: "合成用户",
        zjhm: "PB21000066",
        email: "fallback@example.test",
      },
    });
    const first = await client.startLogin("/");
    const result = await client.finishLogin({
      state: first.state,
      code: "c",
      browserBinding: first.browserBindingCookie.value,
    });
    expect(result.identity.subject).toBe("stable-top-level-id");

    recording.setProfile({
      active: true,
      id: "other-id",
      client_id: "different-client",
      attributes: {
        name: "错误客户端",
        zjhm: "PB21000065",
        email: "wrong-client@example.test",
      },
    });
    const second = await client.startLogin("/");
    await expect(
      client.finishLogin({
        state: second.state,
        code: "c",
        browserBinding: second.browserBindingCookie.value,
      }),
    ).rejects.toThrow();
  });

  it("响应体超限时中止调用，不把内容回传", async () => {
    const oversizedProfile = {
      active: true,
      id: "x".repeat(20_000),
      attributes: { gid: "g", name: "n".repeat(20_000), zjhm: "z" },
    };
    const { client, recording } = makeClient();
    const first = await client.startLogin("/");
    recording.setProfile(oversizedProfile);
    await expect(
      client.finishLogin({
        state: first.state,
        code: "c",
        browserBinding: first.browserBindingCookie.value,
      }),
    ).rejects.toThrow();
  });

  it("实例与返回对象不暴露 client_secret，令牌不进入返回值", async () => {
    const { client, recording } = makeClient();
    const start = await client.startLogin("/");
    const result = await client.finishLogin({
      state: start.state,
      code: "synthetic-auth-code",
      browserBinding: start.browserBindingCookie.value,
    });
    expect(JSON.stringify(client)).not.toContain(clientSecret);
    expect(JSON.stringify(result)).not.toContain(clientSecret);
    expect(JSON.stringify(result)).not.toContain("synthetic-access-token");
  });
});
