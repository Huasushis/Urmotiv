import { describe, expect, it } from "vitest";
import { LocalJobQueue } from "../src";

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

describe("本地任务队列", () => {
  it("相同幂等请求只创建一个任务，不同内容会报冲突", async () => {
    const queue = new LocalJobQueue();
    const first = await queue.enqueue(request());
    const duplicate = await queue.enqueue(request());
    expect(duplicate.id).toBe(first.id);

    await expect(
      queue.enqueue(request({ payload: { sourceFileId: "file-2" } }))
    ).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
  });

  it("租约到期后允许其他 worker 恢复并重新领取", async () => {
    let now = new Date("2026-07-26T00:00:00.000Z");
    const queue = new LocalJobQueue({ now: () => now });
    const job = await queue.enqueue(request());
    const firstLease = await queue.leaseNext({ workerId: "worker-1", leaseMs: 1_000 });
    expect(firstLease).toEqual(expect.objectContaining({ id: job.id, attempt: 1 }));

    now = new Date("2026-07-26T00:00:02.000Z");
    expect(await queue.recoverExpiredLeases()).toBe(1);
    const secondLease = await queue.leaseNext({ workerId: "worker-2", leaseMs: 1_000 });
    expect(secondLease).toEqual(
      expect.objectContaining({
        id: job.id,
        attempt: 2,
        lease: expect.objectContaining({ workerId: "worker-2" })
      })
    );
  });

  it("达到重试上限后进入失败状态", async () => {
    const queue = new LocalJobQueue({ retryDelayMs: 0 });
    const job = await queue.enqueue(request({ maxAttempts: 2 }));

    const first = await queue.leaseNext({ workerId: "worker", leaseMs: 1_000 });
    if (first === undefined) {
      throw new Error("任务没有进入队列");
    }
    const retrying = await queue.fail(job.id, first.lease.id, {
      code: "temporary_failure",
      message: "临时失败。",
      retryable: true
    });
    expect(retrying.state).toBe("queued");

    const second = await queue.leaseNext({ workerId: "worker", leaseMs: 1_000 });
    if (second === undefined) {
      throw new Error("任务没有重新进入队列");
    }
    const failed = await queue.fail(job.id, second.lease.id, {
      code: "temporary_failure",
      message: "临时失败。",
      retryable: true
    });
    expect(failed).toEqual(expect.objectContaining({ state: "failed", attempt: 2 }));
    expect(await queue.leaseNext({ workerId: "worker", leaseMs: 1_000 })).toBeUndefined();
  });

  it("保存递增进度和逐项报告", async () => {
    const queue = new LocalJobQueue();
    const job = await queue.enqueue(request());
    const leased = await queue.leaseNext({ workerId: "worker", leaseMs: 1_000 });
    if (leased === undefined) {
      throw new Error("任务没有进入队列");
    }

    await queue.updateProgress(job.id, leased.lease.id, 50);
    const withReport = await queue.putItemReport(job.id, leased.lease.id, {
      itemId: "0",
      state: "succeeded",
      resultId: "problem-10"
    });
    expect(withReport).toEqual(
      expect.objectContaining({
        progressPercent: 50,
        itemReports: [expect.objectContaining({ itemId: "0", resultId: "problem-10" })]
      })
    );
    await expect(queue.updateProgress(job.id, leased.lease.id, 40)).rejects.toMatchObject({
      code: "PROGRESS_REVERSED"
    });
  });
});
