import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app";
import { resolveClientAddress } from "../src/client-address";

const openApps: FastifyInstance[] = [];

afterEach(async () => {
  await Promise.all(openApps.splice(0).map((app) => app.close()));
});

async function createAddressProbe(
  trustedProxyCidrs: readonly string[] = [],
): Promise<FastifyInstance> {
  const app = await createApp({ trustedProxyCidrs });
  app.get("/__test/client-address", async (request) => ({
    address: resolveClientAddress(request, trustedProxyCidrs) ?? null,
  }));
  app.get("/__test/proxy-semantics", async (request) => ({
    address: resolveClientAddress(request, trustedProxyCidrs) ?? null,
    hostname: request.hostname,
    protocol: request.protocol,
  }));
  openApps.push(app);
  return app;
}

describe("请求来源地址解析", () => {
  it("默认只使用 socket 地址并忽略伪造的转发头", async () => {
    const app = await createAddressProbe();
    const response = await app.inject({
      method: "GET",
      url: "/__test/client-address",
      remoteAddress: "198.51.100.9",
      headers: {
        "x-forwarded-for": "192.0.2.99",
        forwarded: "for=203.0.113.7",
      },
    });
    expect(response.json()).toEqual({ address: "198.51.100.9" });
  });

  it("socket 不可信时忽略完整 X-Forwarded-For 链", async () => {
    const trustedProxyCidrs = ["10.0.0.0/8"];
    const app = await createAddressProbe(trustedProxyCidrs);
    const response = await app.inject({
      method: "GET",
      url: "/__test/client-address",
      remoteAddress: "198.51.100.9",
      headers: { "x-forwarded-for": "192.0.2.44, 10.1.2.3" },
    });
    expect(response.json()).toEqual({ address: "198.51.100.9" });
  });

  it("从 socket 向右到左跨过明确可信的多级代理", async () => {
    const trustedProxyCidrs = ["10.0.0.0/8", "172.16.0.0/12"];
    const app = await createAddressProbe(trustedProxyCidrs);
    const response = await app.inject({
      method: "GET",
      url: "/__test/client-address",
      remoteAddress: "10.0.0.8",
      headers: { "x-forwarded-for": "192.0.2.44, 172.16.4.9" },
    });
    expect(response.json()).toEqual({ address: "192.0.2.44" });
  });

  it("在第一个不可信中间节点停止，不采用它左侧的伪造地址", async () => {
    const trustedProxyCidrs = ["10.0.0.0/8"];
    const app = await createAddressProbe(trustedProxyCidrs);
    const response = await app.inject({
      method: "GET",
      url: "/__test/client-address",
      remoteAddress: "10.0.0.8",
      headers: { "x-forwarded-for": "192.0.2.44, 172.16.4.9" },
    });
    expect(response.json()).toEqual({ address: "172.16.4.9" });
  });

  it("即使 socket 可信也不解释单独的 Forwarded 头", async () => {
    const trustedProxyCidrs = ["10.0.0.0/8"];
    const app = await createAddressProbe(trustedProxyCidrs);
    const response = await app.inject({
      method: "GET",
      url: "/__test/client-address",
      remoteAddress: "10.0.0.8",
      headers: { forwarded: "for=192.0.2.44" },
    });
    expect(response.json()).toEqual({ address: "10.0.0.8" });
  });

  it("支持 IPv6 代理链并规范化客户端地址", async () => {
    const trustedProxyCidrs = ["2001:db8:1::/64"];
    const app = await createAddressProbe(trustedProxyCidrs);
    const response = await app.inject({
      method: "GET",
      url: "/__test/client-address",
      remoteAddress: "2001:db8:1::8",
      headers: { "x-forwarded-for": "2001:0DB8:2:0:0:0:0:44" },
    });
    expect(response.json()).toEqual({ address: "2001:db8:2::44" });
  });

  it("把 IPv4-mapped socket 地址规范化后交给后续认证", async () => {
    const app = await createAddressProbe();
    const response = await app.inject({
      method: "GET",
      url: "/__test/client-address",
      remoteAddress: "::ffff:192.0.2.44",
    });
    expect(response.json()).toEqual({ address: "192.0.2.44" });
  });

  it("socket 地址无效时关闭来源解析", async () => {
    const app = await createAddressProbe(["10.0.0.0/8"]);
    const response = await app.inject({
      method: "GET",
      url: "/__test/client-address",
      remoteAddress: "not-an-address",
      headers: { "x-forwarded-for": "192.0.2.44" },
    });
    expect(response.json()).toEqual({ address: null });
  });

  it("允许 IPv4 CIDR 识别 IPv4-mapped 的可信代理 socket", async () => {
    const trustedProxyCidrs = ["192.0.2.0/24"];
    const app = await createAddressProbe(trustedProxyCidrs);
    const response = await app.inject({
      method: "GET",
      url: "/__test/client-address",
      remoteAddress: "::ffff:192.0.2.44",
      headers: { "x-forwarded-for": "198.51.100.8" },
    });
    expect(response.json()).toEqual({ address: "198.51.100.8" });
  });

  it("可信 socket 邻近的畸形 XFF 会关闭来源解析", async () => {
    const trustedProxyCidrs = ["10.0.0.0/8"];
    const app = await createAddressProbe(trustedProxyCidrs);
    const malformed = await app.inject({
      method: "GET",
      url: "/__test/client-address",
      remoteAddress: "10.0.0.8",
      headers: { "x-forwarded-for": "192.0.2.44, unknown" },
    });
    expect(malformed.json()).toEqual({ address: null });

    const emptySegment = await app.inject({
      method: "GET",
      url: "/__test/client-address",
      remoteAddress: "10.0.0.8",
      headers: { "x-forwarded-for": "192.0.2.44, , 10.0.0.9" },
    });
    expect(emptySegment.json()).toEqual({ address: null });

    const tooMany = await app.inject({
      method: "GET",
      url: "/__test/client-address",
      remoteAddress: "10.0.0.8",
      headers: { "x-forwarded-for": Array<string>(65).fill("10.0.0.9").join(",") },
    });
    expect(tooMany.json()).toEqual({ address: null });
  });

  it("接受恰好 64 项的有界可信代理链", async () => {
    const trustedProxyCidrs = ["10.0.0.0/8"];
    const app = await createAddressProbe(trustedProxyCidrs);
    const response = await app.inject({
      method: "GET",
      url: "/__test/client-address",
      remoteAddress: "10.0.0.8",
      headers: {
        "x-forwarded-for": ["198.51.100.8", ...Array<string>(63).fill("10.0.0.9")].join(","),
      },
    });
    expect(response.json()).toEqual({ address: "198.51.100.8" });
  });

  it("不会解析首个不可信地址左侧的攻击者输入", async () => {
    const trustedProxyCidrs = ["10.0.0.0/8"];
    const app = await createAddressProbe(trustedProxyCidrs);
    const response = await app.inject({
      method: "GET",
      url: "/__test/client-address",
      remoteAddress: "10.0.0.8",
      headers: { "x-forwarded-for": "unknown, 198.51.100.8" },
    });
    expect(response.json()).toEqual({ address: "198.51.100.8" });
  });

  it("可信代理配置不会扩大 Fastify 对 Host 和协议转发头的信任", async () => {
    const trustedProxyCidrs = ["10.0.0.0/8"];
    const app = await createAddressProbe(trustedProxyCidrs);
    const response = await app.inject({
      method: "GET",
      url: "/__test/proxy-semantics",
      remoteAddress: "10.0.0.8",
      headers: {
        host: "api.example.test",
        "x-forwarded-for": "192.0.2.44",
        "x-forwarded-host": "attacker.invalid",
        "x-forwarded-proto": "https",
      },
    });
    expect(response.json()).toEqual({
      address: "192.0.2.44",
      hostname: "api.example.test",
      protocol: "http",
    });
  });
});
