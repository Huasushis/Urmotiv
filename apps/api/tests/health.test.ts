import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { createApp, type ApiAppOptions } from "../src/app";
import { InMemoryDataStore } from "../src/repository";

const openApps: FastifyInstance[] = [];

afterEach(async () => {
  await Promise.all(openApps.splice(0).map((app) => app.close()));
});

class UnavailableStore extends InMemoryDataStore {
  public override async ping(): Promise<void> {
    throw new Error("database unavailable");
  }
}

async function healthApp(extraOptions: Pick<ApiAppOptions, "store"> = {}): Promise<FastifyInstance> {
  const app = await createApp({ demoAuthEnabled: true, ...extraOptions });
  openApps.push(app);
  return app;
}

describe("健康检查接口", () => {
  it("存活检查始终返回 200 ok", async () => {
    const app = await healthApp();
    const response = await app.inject({ method: "GET", url: "/api/v1/health" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: "ok", service: "urmotiv-api" });
  });

  it("持久化后端可达时就绪检查返回 200 ready", async () => {
    const app = await healthApp();
    const response = await app.inject({ method: "GET", url: "/api/v1/health/ready" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      status: "ready",
      service: "urmotiv-api",
      checks: { database: "ok" }
    });
  });

  it("持久化后端不可达时就绪检查返回 503 且不泄露内部信息", async () => {
    const app = await healthApp({ store: new UnavailableStore([], []) });
    const response = await app.inject({ method: "GET", url: "/api/v1/health/ready" });
    expect(response.statusCode).toBe(503);
    const body = response.json();
    expect(body).toEqual({
      status: "unavailable",
      service: "urmotiv-api",
      checks: { database: "unavailable" }
    });
    const serialized = JSON.stringify(body);
    expect(serialized).not.toContain("database unavailable");
    expect(serialized).not.toContain("Error");
  });
});