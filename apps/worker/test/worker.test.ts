import { LocalJobQueue, type JobRecord } from "@urmotiv/jobs";
import { describe, expect, it } from "vitest";
import { JobWorker, type JobLogEvent, type JobLogger } from "../src";

class MemoryLogger implements JobLogger {
  public readonly events: JobLogEvent[] = [];

  public write(event: JobLogEvent): void {
    this.events.push(structuredClone(event));
  }
}

function request(overrides: Record<string, unknown> = {}) {
  return {
    type: "problem.import",
    payload: { sourceFileId: "file-1" },
    idempotencyScope: "user-1",
    idempotencyKey: "request-1",
    maxAttempts: 3,
    timeoutMs: 1_000,
    ...overrides
  };
}

async function requiredJob(queue: LocalJobQueue, jobId: string): Promise<JobRecord> {
  const job = await queue.get(jobId);
  if (job === undefined) {
    throw new Error("任务不存在");
  }
  return job;
}

describe("后台 worker", () => {
  it("重复入队只执行一次", async () => {
    const queue = new LocalJobQueue();
    const first = await queue.enqueue(request());
    const duplicate = await queue.enqueue(request());
    const logger = new MemoryLogger();
    const worker = new JobWorker(queue, { workerId: "worker", logger });
    let executions = 0;
    worker.register("problem.import", () => {
      executions += 1;
      return { result: { imported: 1 } };
    });

    expect(first.id).toBe(duplicate.id);
    expect(await worker.runOnce()).toBe(true);
    expect(await worker.runOnce()).toBe(false);
    expect(executions).toBe(1);
    expect(await requiredJob(queue, first.id)).toEqual(
      expect.objectContaining({ state: "succeeded", attempt: 1 })
    );
  });

  it("未知任务直接拒绝且日志不包含任务参数", async () => {
    const queue = new LocalJobQueue();
    const job = await queue.enqueue(
      request({ type: "plugin.unknown", payload: { secret: "do-not-log" } })
    );
    const logger = new MemoryLogger();
    const worker = new JobWorker(queue, { workerId: "worker", logger });

    expect(await worker.runOnce()).toBe(true);
    expect(await requiredJob(queue, job.id)).toEqual(
      expect.objectContaining({
        state: "failed",
        failure: expect.objectContaining({ code: "unknown_job_type" })
      })
    );
    const serializedLog = JSON.stringify(logger.events);
    expect(serializedLog).not.toContain("do-not-log");
    expect(serializedLog).not.toContain("plugin.unknown");
  });

  it("处理器持续失败时在重试上限结束", async () => {
    const queue = new LocalJobQueue({ retryDelayMs: 0 });
    const job = await queue.enqueue(request({ maxAttempts: 2 }));
    const worker = new JobWorker(queue, {
      workerId: "worker",
      logger: new MemoryLogger()
    });
    worker.register("problem.import", () => {
      throw new Error("包含不应写入日志的内部内容");
    });

    expect(await worker.runOnce()).toBe(true);
    expect((await requiredJob(queue, job.id)).state).toBe("queued");
    expect(await worker.runOnce()).toBe(true);
    expect(await requiredJob(queue, job.id)).toEqual(
      expect.objectContaining({ state: "failed", attempt: 2 })
    );
  });

  it("停止时结束轮询并等待当前状态稳定", async () => {
    const queue = new LocalJobQueue();
    const worker = new JobWorker(queue, {
      workerId: "worker",
      pollIntervalMs: 10,
      logger: new MemoryLogger()
    });
    const running = worker.run();
    await new Promise<void>((resolve) => setImmediate(resolve));
    await worker.stop();
    await expect(running).resolves.toBeUndefined();
  });
});
