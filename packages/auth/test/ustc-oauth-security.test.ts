import { describe, expect, it } from "vitest";
import {
  UstcOAuthClient,
  ustcOAuthConfigurationSchema,
  type CasLoginStateStore,
  type UstcOAuthFetch
} from "@urmotiv/auth";

const configuration = {
  authorizeUrl: "https://id.ustc.edu.cn/cas/oauth2.0/authorize",
  tokenUrl: "https://id.ustc.edu.cn/cas/oauth2.0/accessToken",
  profileUrl: "https://id.ustc.edu.cn/cas/oauth2.0/profile",
  redirectUri: "https://site.example.test/api/v1/auth/ustc/callback",
  clientId: "security-client",
  clientSecret: "security-client-secret"
};

class States implements CasLoginStateStore {
  public async put(): Promise<void> {}
  public async consume(): Promise<boolean> {
    return true;
  }
}

const fetchImpl: UstcOAuthFetch = async (input) => {
  const url = String(input);
  if (url.endsWith("accessToken")) {
    return new Response(JSON.stringify({ access_token: "access-token" }), { status: 200 });
  }
  return new Response(
    JSON.stringify({
      active: true,
      client_id: configuration.clientId,
      id: "security-user",
      attributes: { gid: "security-user", name: "安全测试用户" }
    }),
    { status: 200 }
  );
};

describe("USTC OAuth DNS rebinding 防护", () => {
  it("解析结果从公网地址重绑定到私有地址时拒绝第二次请求", async () => {
    let calls = 0;
    const client = new UstcOAuthClient({
      configuration,
      stateSecret: new Uint8Array(32).fill(8),
      states: new States(),
      fetch: fetchImpl,
      resolveHostAddresses: async () => {
        calls += 1;
        return calls === 1 ? ["93.184.216.34"] : ["127.0.0.1"];
      }
    });
    const start = await client.startLogin("/admin");
    await expect(
      client.finishLogin({
        state: start.state,
        code: "authorization-code",
        browserBinding: start.browserBindingCookie.value
      })
    ).rejects.toMatchObject({ code: "provider_dns_blocked" });
    expect(calls).toBe(2);
  });

  it("仅显式安全模式允许精确回环 HTTP 回调，近似地址与非回环地址拒绝", () => {
    for (const host of ["localhost", "127.0.0.1", "[::1]"]) {
      const loopbackConfiguration = {
        ...configuration,
        redirectUri: `http://${host}/api/v1/auth/ustc/callback`
      };
      expect(() => ustcOAuthConfigurationSchema.parse(loopbackConfiguration)).not.toThrow();
      expect(() => new UstcOAuthClient({
        configuration: loopbackConfiguration,
        stateSecret: new Uint8Array(32).fill(8),
        states: new States(),
        fetch: fetchImpl
      })).toThrow();
      expect(() => new UstcOAuthClient({
        configuration: loopbackConfiguration,
        stateSecret: new Uint8Array(32).fill(8),
        states: new States(),
        fetch: fetchImpl,
        allowLoopbackInsecureRedirect: true
      })).not.toThrow();
    }

    for (const redirectUri of [
      "http://127.0.0.2/api/v1/auth/ustc/callback",
      "http://localhost.example.test/api/v1/auth/ustc/callback",
      "http://site.example.test/api/v1/auth/ustc/callback",
      "http://127.0.0.1/api/v1/auth/ustc/callback/extra",
      "http://127.0.0.1/api/v1/auth/ustc/callback?near=miss"
    ]) {
      expect(() => ustcOAuthConfigurationSchema.parse({
        ...configuration,
        redirectUri
      })).toThrow();
    }
  });
});
