import { createHash, randomUUID } from "node:crypto";
import { createClient } from "redis";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  RedisJobQueue,
  type EnqueueJobInput,
  type RedisCommandClient
} from "../src";

const redisUrl = process.env.URMOTIV_REDIS_TEST_URL?.trim();
const describeWithRedis = redisUrl === undefined || redisUrl.length === 0 ? describe.skip : describe;
type TestRedisClient = ReturnType<typeof createClient>;

function request(
  jobId: string,
  overrides: Partial<EnqueueJobInput> = {}
): EnqueueJobInput {
  return {
    jobId,
    type: "problem.import",
    payload: { importJobId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" },
    idempotencyScope: "redis-integration",
    idempotencyKey: jobId,
    maxAttempts: 3,
    timeoutMs: 1_000,
    ...overrides
  };
}

function commands(client: TestRedisClient): RedisCommandClient {
  return {
    get: (key) => client.get(key),
    evaluate: (script, keys, arguments_) =>
      client.eval(script, { keys: [...keys], arguments: [...arguments_] })
  };
}

function keys(prefix: string, input: EnqueueJobInput): {
  readonly job: string;
  readonly index: string;
  readonly queued: string;
  readonly running: string;
} {
  const digest = createHash("sha256")
    .update(`${input.idempotencyScope}\u0000${input.idempotencyKey}`)
    .digest("hex");
  return {
    job: `${prefix}:v2:job:${input.jobId}`,
    index: `${prefix}:v2:idempotency:${digest}`,
    queued: `${prefix}:v2:queue:queued`,
    running: `${prefix}:v2:queue:running`
  };
}

describeWithRedis("Redis 任务队列集成", () => {
  let client: TestRedisClient;
  const prefixes = new Set<string>();

  beforeAll(async () => {
    if (redisUrl === undefined || redisUrl.length === 0) {
      throw new Error("URMOTIV_REDIS_TEST_URL 未设置。");
    }
    client = createClient({ url: redisUrl, socket: { reconnectStrategy: false } });
    await client.connect();
  });

  afterEach(async () => {
    for (const prefix of prefixes) {
      for await (const batch of client.scanIterator({ MATCH: `${prefix}:v2:*`, COUNT: 100 })) {
        if (batch.length > 0) {
          await client.del(batch);
        }
      }
    }
    prefixes.clear();
  });

  afterAll(async () => {
    if (client?.isOpen) {
      await client.quit();
    }
  });

  function queue(
    options: { readonly now?: () => Date; readonly retryDelayMs?: number } = {},
    commandClient: RedisCommandClient = commands(client)
  ): { readonly queue: RedisJobQueue; readonly prefix: string } {
    const prefix = `urmotiv:test:${randomUUID()}`;
    prefixes.add(prefix);
    return {
      prefix,
      queue: new RedisJobQueue(commandClient, { prefix, ...options })
    };
  }

  it("响应丢失后用同一任务编号重投，并只写 v2 键", async () => {
    const commandClient = commands(client);
    let loseFirstResponse = true;
    const lossyCommands: RedisCommandClient = {
      ...commandClient,
      evaluate: async (script, scriptKeys, arguments_) => {
        const result = await commandClient.evaluate(script, scriptKeys, arguments_);
        if (loseFirstResponse) {
          loseFirstResponse = false;
          throw new Error("simulated_response_loss");
        }
        return result;
      }
    };
    const { prefix, queue: lossyQueue } = queue({}, lossyCommands);
    const input = request("11111111-1111-4111-8111-111111111111");

    await expect(lossyQueue.enqueue(input)).rejects.toMatchObject({
      code: "INVALID_JOB_INPUT",
      message: "Redis 任务队列暂时不可用。"
    });

    const retryQueue = new RedisJobQueue(commandClient, { prefix });
    await expect(retryQueue.enqueue(input)).resolves.toEqual(
      expect.objectContaining({ id: input.jobId, state: "queued", attempt: 0 })
    );
    const redisKeys = keys(prefix, input);
    expect(await client.exists(redisKeys.job)).toBe(1);
    expect(await client.exists(`${prefix}:job:${input.jobId}`)).toBe(0);
    expect(JSON.parse((await client.get(redisKeys.index)) ?? "null")).toEqual({
      jobId: input.jobId,
      requestDigest: expect.stringMatching(/^[a-f0-9]{64}$/)
    });
  });

  it("只缺任务记录或只缺幂等索引时原子修复", async () => {
    const { prefix, queue: redisQueue } = queue();
    const input = request("22222222-2222-4222-8222-222222222222");
    const redisKeys = keys(prefix, input);
    await redisQueue.enqueue(input);

    await client.del(redisKeys.job);
    const recreated = await redisQueue.enqueue(input);
    expect(recreated).toEqual(expect.objectContaining({ id: input.jobId, state: "queued" }));
    expect(await client.zScore(redisKeys.queued, input.jobId)).not.toBeNull();

    await client.del(redisKeys.index);
    const repaired = await redisQueue.enqueue(input);
    expect(repaired).toEqual(recreated);
    expect(await client.get(redisKeys.index)).not.toBeNull();
  });

  it("修复索引时不覆盖运行中或已结束的任务", async () => {
    const { prefix, queue: redisQueue } = queue();
    const input = request("33333333-3333-4333-8333-333333333333");
    const redisKeys = keys(prefix, input);
    await redisQueue.enqueue(input);
    const leased = await redisQueue.leaseNext({ workerId: "worker-a", leaseMs: 60_000 });
    if (leased === undefined) {
      throw new Error("测试任务没有被领取。");
    }

    await client.del(redisKeys.index);
    const running = await redisQueue.enqueue(input);
    expect(running).toEqual(
      expect.objectContaining({
        state: "running",
        attempt: 1,
        lease: expect.objectContaining({ id: leased.lease.id, workerId: "worker-a" })
      })
    );

    await redisQueue.complete(input.jobId, leased.lease.id, { resultId: "safe-result" });
    const completed = await redisQueue.get(input.jobId);
    await client.del(redisKeys.index);
    const repeated = await redisQueue.enqueue(input);
    expect(repeated).toEqual(completed);
    expect(repeated).toEqual(
      expect.objectContaining({ state: "succeeded", result: { resultId: "safe-result" } })
    );
  });

  it("任务编号、请求摘要或幂等身份冲突时固定拒绝", async () => {
    const { queue: redisQueue } = queue();
    const input = request("44444444-4444-4444-8444-444444444444");
    await redisQueue.enqueue(input);

    await expect(
      redisQueue.enqueue({
        ...input,
        jobId: "55555555-5555-4555-8555-555555555555"
      })
    ).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
    await expect(
      redisQueue.enqueue({ ...input, payload: { importJobId: randomUUID() } })
    ).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
    await expect(
      redisQueue.enqueue({ ...input, idempotencyKey: "another-request" })
    ).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
  });

  it("两个 worker 并发领取时只有一个获得租约", async () => {
    const { prefix, queue: firstQueue } = queue();
    const secondQueue = new RedisJobQueue(commands(client), { prefix });
    const input = request("66666666-6666-4666-8666-666666666666");
    await firstQueue.enqueue(input);

    const leases = await Promise.all([
      firstQueue.leaseNext({ workerId: "worker-a", leaseMs: 60_000 }),
      secondQueue.leaseNext({ workerId: "worker-b", leaseMs: 60_000 })
    ]);
    expect(leases.filter((leased) => leased !== undefined)).toHaveLength(1);
    expect(leases.find((leased) => leased !== undefined)?.id).toBe(input.jobId);
  });

  it("客户端时钟偏移不会改变 Redis 的创建时间和租约", async () => {
    const { prefix, queue: futureQueue } = queue({
      now: () => new Date("2126-01-01T00:00:00.000Z"),
      retryDelayMs: 60_000
    });
    const pastQueue = new RedisJobQueue(commands(client), {
      prefix,
      now: () => new Date("1926-01-01T00:00:00.000Z")
    });
    const input = request("77777777-7777-4777-8777-777777777777");
    const before = Date.now();
    const created = await futureQueue.enqueue(input);
    const leased = await futureQueue.leaseNext({ workerId: "clock-test", leaseMs: 60_000 });
    const after = Date.now();
    if (leased === undefined) {
      throw new Error("测试任务没有被领取。");
    }

    expect(Date.parse(created.createdAt)).toBeGreaterThanOrEqual(before - 2_000);
    expect(Date.parse(created.createdAt)).toBeLessThanOrEqual(after + 2_000);
    expect(Date.parse(leased.lease.expiresAt)).toBeGreaterThanOrEqual(before + 55_000);
    expect(Date.parse(leased.lease.expiresAt)).toBeLessThanOrEqual(after + 65_000);

    const beforeRenew = Date.now();
    const renewed = await pastQueue.renewLease(input.jobId, leased.lease.id, 120_000);
    const afterRenew = Date.now();
    expect(Date.parse(renewed.lease.expiresAt)).toBeGreaterThanOrEqual(beforeRenew + 115_000);
    expect(Date.parse(renewed.lease.expiresAt)).toBeLessThanOrEqual(afterRenew + 125_000);
    expect(await pastQueue.recoverExpiredLeases()).toBe(0);
    expect(await pastQueue.get(input.jobId)).toEqual(
      expect.objectContaining({ state: "running", lease: expect.objectContaining({ id: leased.lease.id }) })
    );

    const retrying = await futureQueue.fail(input.jobId, leased.lease.id, {
      code: "temporary_failure",
      message: "暂时失败。",
      retryable: true
    });
    const failedAt = Date.now();
    expect(Date.parse(retrying.availableAt)).toBeGreaterThanOrEqual(failedAt + 55_000);
    expect(Date.parse(retrying.availableAt)).toBeLessThanOrEqual(failedAt + 65_000);
    expect(await pastQueue.leaseNext({ workerId: "past-clock", leaseMs: 60_000 })).toBeUndefined();
  });

  it("一次调用分批恢复超过一百个过期租约", async () => {
    const { prefix, queue: redisQueue } = queue();
    const count = 105;
    const inputs = Array.from({ length: count }, (_, index) =>
      request(`${String(index + 1).padStart(8, "0")}-0000-4000-8000-000000000001`)
    );
    await Promise.all(inputs.map((input) => redisQueue.enqueue(input)));

    const leasedIds: string[] = [];
    for (let index = 0; index < count; index += 1) {
      const leased = await redisQueue.leaseNext({ workerId: "batch-worker", leaseMs: 60_000 });
      if (leased === undefined) {
        throw new Error("测试任务数量不足。");
      }
      leasedIds.push(leased.id);
    }

    const runningKey = `${prefix}:v2:queue:running`;
    await Promise.all(
      leasedIds.map(async (jobId) => {
        const jobKey = `${prefix}:v2:job:${jobId}`;
        const raw = await client.get(jobKey);
        if (raw === null) {
          throw new Error("测试任务记录缺失。");
        }
        const stored = JSON.parse(raw) as { lease: { expiresAtMs: number } | null };
        if (stored.lease === null) {
          throw new Error("测试任务没有租约。");
        }
        stored.lease.expiresAtMs = 0;
        await client.set(jobKey, JSON.stringify(stored));
        await client.zAdd(runningKey, { score: 0, value: jobId });
      })
    );

    expect(await redisQueue.recoverExpiredLeases()).toBe(count);
    const recovered = await Promise.all(inputs.map((input) => redisQueue.get(input.jobId)));
    expect(recovered.every((job) => job?.state === "queued" && job.lease === null)).toBe(true);
  });
});
