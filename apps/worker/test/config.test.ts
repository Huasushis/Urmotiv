import { describe, expect, it } from "vitest";
import { readWorkerConfig } from "../src";

describe("worker 配置", () => {
  it("轻量模式不要求 Redis", () => {
    expect(readWorkerConfig({})).toEqual(
      expect.objectContaining({
        leaseMs: 30_000,
        pollIntervalMs: 500,
        retryDelayMs: 1_000,
        redis: { enabled: false }
      })
    );
  });

  it("生产环境没有 Redis 时拒绝启动", () => {
    expect(() => readWorkerConfig({ NODE_ENV: "production" })).toThrow(
      "生产环境必须设置 REDIS_URL"
    );
  });

  it("读取 Redis 与任务时间配置", () => {
    expect(
      readWorkerConfig({
        NODE_ENV: "production",
        REDIS_URL: "redis://127.0.0.1:6379/1",
        JOB_REDIS_PREFIX: "test:jobs",
        JOB_LEASE_MS: "60000",
        JOB_RETRY_DELAY_MS: "2000",
        WORKER_POLL_INTERVAL_MS: "250",
        WORKER_ID: "worker-test"
      })
    ).toEqual({
      workerId: "worker-test",
      pollIntervalMs: 250,
      leaseMs: 60_000,
      retryDelayMs: 2_000,
      redis: {
        enabled: true,
        url: "redis://127.0.0.1:6379/1",
        prefix: "test:jobs"
      }
    });
  });
});
