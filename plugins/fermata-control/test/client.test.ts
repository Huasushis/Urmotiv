import { describe, expect, it, vi } from "vitest";
import { FermataControlClient } from "../src/index";

const managementToken = "test-management-token-123456";

function health() {
  return {
    status: "ok",
    service: "fermata",
    apiVersion: "1",
    workerRunning: true,
    activeTasks: 1,
    checkedAt: "2026-07-26T00:00:00.000Z"
  };
}

function settings() {
  return {
    settings: {
      enabled: true,
      pollingIntervalSeconds: 30,
      maximumConcurrentTasks: 2,
      modelProfileName: "review-balanced",
      experimentVersion: "experiment-2026-07"
    },
    revision: 4,
    secretsConfigured: true
  };
}

describe("Fermata 管理客户端", () => {
  it("读取健康状态时使用管理令牌并校验返回结构", async () => {
    const fetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      expect(init?.headers).toEqual(
        expect.objectContaining({ Authorization: `Bearer ${managementToken}` })
      );
      return new Response(JSON.stringify(health()), { status: 200 });
    });
    const client = new FermataControlClient({
      baseUrl: "http://fermata:4100",
      managementToken,
      fetch
    });
    await expect(client.getHealth()).resolves.toEqual(health());
  });

  it("更新设置时带修订编号且不接受密钥字段", async () => {
    const fetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      expect(body).toEqual({ expectedRevision: 4, settings: settings().settings });
      expect(JSON.stringify(body)).not.toContain("apiKey");
      return new Response(JSON.stringify({ ...settings(), revision: 5 }), { status: 200 });
    });
    const client = new FermataControlClient({
      baseUrl: "http://fermata:4100",
      managementToken,
      fetch
    });
    await expect(client.updateSettings(4, settings().settings)).resolves.toEqual({
      ...settings(),
      revision: 5
    });
  });

  it("拒绝服务返回未声明的密钥信息", async () => {
    const client = new FermataControlClient({
      baseUrl: "http://fermata:4100",
      managementToken,
      fetch: async () =>
        new Response(JSON.stringify({ ...settings(), modelApiKey: "must-not-leak" }), {
          status: 200
        })
    });
    await expect(client.getSettings()).rejects.toThrow();
  });

  it("拒绝地址中夹带账号密码", () => {
    expect(
      () =>
        new FermataControlClient({
          baseUrl: "https://user:password@fermata.example.test",
          managementToken
        })
    ).toThrow();
  });
});
