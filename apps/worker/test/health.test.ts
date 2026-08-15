import { afterEach, describe, expect, it } from "vitest";
import type { Server } from "node:http";
import { createWorkerHealthServer, type WorkerHealthServer } from "../src/health";

const openServers: Array<{ server: Server; close: () => Promise<void> }> = [];

afterEach(async () => {
  await Promise.all(openServers.splice(0).map((entry) => entry.close()));
});

async function startHealth(options: {
  lastActivityAt: number;
  staleMs?: number;
  now?: () => number;
}): Promise<{ health: WorkerHealthServer; baseUrl: string }> {
  const health = createWorkerHealthServer({
    probe: { lastActivityAt: () => options.lastActivityAt },
    host: "127.0.0.1",
    port: 0,
    staleMs: options.staleMs ?? 60_000,
    now: options.now ?? (() => Date.now())
  });
  const port = await health.listen();
  openServers.push({ server: health.server, close: () => health.close() });
  return { health, baseUrl: `http://127.0.0.1:${port}` };
}

describe("worker 健康服务", () => {
  it("live 在进程存在时返回 200", async () => {
    const { baseUrl } = await startHealth({ lastActivityAt: Date.now() });
    const response = await fetch(`${baseUrl}/live`);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      status: "ok",
      service: "urmotiv-worker"
    });
  });

  it("最近进展未超阈值时 ready 返回 200", async () => {
    const nowMs = 1_000_000;
    const { baseUrl, health } = await startHealth({
      lastActivityAt: nowMs - 5_000,
      staleMs: 60_000,
      now: () => nowMs
    });
    const response = await fetch(`${baseUrl}/ready`);
    expect(response.status).toBe(200);
    expect(health.latest()).toEqual({ ready: true, ageMs: 5_000 });
    await expect(response.json()).resolves.toEqual({
      status: "ready",
      service: "urmotiv-worker",
      lastActivityMs: 5_000
    });
  });

  it("最近进展超过阈值（卡住）时 ready 返回 503", async () => {
    const nowMs = 1_000_000;
    const { baseUrl, health } = await startHealth({
      lastActivityAt: nowMs - 120_000,
      staleMs: 60_000,
      now: () => nowMs
    });
    const response = await fetch(`${baseUrl}/ready`);
    expect(response.status).toBe(503);
    expect(health.latest()).toEqual({ ready: false, ageMs: 120_000 });
    await expect(response.json()).resolves.toEqual({
      status: "unavailable",
      service: "urmotiv-worker",
      reason: "stale",
      lastActivityMs: 120_000
    });
  });

  it("未知路径与非 GET 请求返回 404 固定响应", async () => {
    const { baseUrl } = await startHealth({ lastActivityAt: Date.now() });
    const unknown = await fetch(`${baseUrl}/unknown`);
    expect(unknown.status).toBe(404);
    const post = await fetch(`${baseUrl}/ready`, { method: "POST" });
    expect(post.status).toBe(404);
  });
});