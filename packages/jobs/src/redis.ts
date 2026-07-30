import { randomUUID } from "node:crypto";
import { createClient } from "redis";
import { z } from "zod";
import {
  enqueueJobSchema,
  jobFailureSchema,
  jobItemReportSchema,
  jobRecordSchema,
  jsonValueSchema,
  type EnqueueJobInput,
  type JobItemReport,
  type JobRecord,
  type JsonValue,
  type LeasedJob
} from "./types";
import {
  JobQueueError,
  type FailJobInput,
  type JobQueue,
  type LeaseJobOptions
} from "./queue";
import {
  createJobRecord,
  digestJobRequest,
  encodeJson,
  idempotencyIndexKey
} from "./record";

const jobIdSchema = z.string().uuid();
const leaseIdSchema = z.string().uuid();
const workerIdSchema = z.string().min(1).max(200);
const leaseDurationSchema = z.number().int().min(100).max(24 * 60 * 60 * 1_000);
const progressSchema = z.number().int().min(0).max(100);
const queuePrefixSchema = z.string().min(1).max(100).regex(/^[a-zA-Z0-9:_-]+$/);
const redisJobSchema = jobRecordSchema
  .omit({ payload: true, itemReports: true, result: true })
  .extend({
    payloadJson: z.string(),
    itemReportsJson: z.string(),
    resultJson: z.string()
  })
  .strict();

type RedisJob = z.infer<typeof redisJobSchema>;

export interface RedisCommandClient {
  get(key: string): Promise<string | null>;
  evaluate(script: string, keys: readonly string[], arguments_: readonly string[]): Promise<unknown>;
}

export interface RedisJobQueueOptions {
  readonly prefix?: string;
  readonly retryDelayMs?: number;
  readonly now?: () => Date;
  readonly close?: () => Promise<void>;
}

export class RedisJobQueue implements JobQueue {
  readonly #commands: RedisCommandClient;
  readonly #prefix: string;
  readonly #retryDelayMs: number;
  readonly #now: () => Date;
  readonly #close: () => Promise<void>;
  #closed = false;

  public constructor(commands: RedisCommandClient, options: RedisJobQueueOptions = {}) {
    this.#commands = commands;
    this.#prefix = queuePrefixSchema.parse(options.prefix ?? "urmotiv:jobs");
    const retryDelayMs = options.retryDelayMs ?? 1_000;
    if (!Number.isSafeInteger(retryDelayMs) || retryDelayMs < 0) {
      throw new TypeError("任务重试间隔必须是非负整数。");
    }
    this.#retryDelayMs = retryDelayMs;
    this.#now = options.now ?? (() => new Date());
    this.#close = options.close ?? (async () => undefined);
  }

  public async enqueue(input: EnqueueJobInput): Promise<JobRecord> {
    this.#assertOpen();
    const request = enqueueJobSchema.parse(input);
    const record = createJobRecord(request, this.#now());
    const indexKey = this.#idempotencyKey(
      idempotencyIndexKey(request.idempotencyScope, request.idempotencyKey)
    );
    const result = await this.#commands.evaluate(
      enqueueScript,
      [indexKey, this.#jobKey(record.id), this.#queuedKey()],
      [record.id, encodeJson(toRedisJob(record)), String(Date.parse(record.availableAt))]
    );
    const jobId = redisString(result);
    if (jobId === undefined) {
      throw new JobQueueError("INVALID_JOB_INPUT", "Redis 没有返回任务编号。");
    }
    const stored = await this.get(jobId);
    if (stored === undefined) {
      throw new JobQueueError("JOB_NOT_FOUND", "幂等记录指向的任务不存在。");
    }
    if (stored.requestDigest !== digestJobRequest(request)) {
      throw new JobQueueError(
        "IDEMPOTENCY_CONFLICT",
        "同一个幂等键不能用于不同的任务内容。"
      );
    }
    return stored;
  }

  public async get(jobId: string): Promise<JobRecord | undefined> {
    this.#assertOpen();
    const id = jobIdSchema.parse(jobId);
    const raw = await this.#commands.get(this.#jobKey(id));
    return raw === null ? undefined : parseJob(raw);
  }

  public async leaseNext(options: LeaseJobOptions): Promise<LeasedJob | undefined> {
    this.#assertOpen();
    const workerId = workerIdSchema.parse(options.workerId);
    const leaseMs = leaseDurationSchema.parse(options.leaseMs);
    await this.recoverExpiredLeases();
    const now = this.#now();
    const leaseId = randomUUID();
    const expiresAt = new Date(now.getTime() + leaseMs);
    const result = await this.#commands.evaluate(
      leaseScript,
      [this.#queuedKey(), this.#runningKey()],
      [
        String(now.getTime()),
        now.toISOString(),
        leaseId,
        workerId,
        String(expiresAt.getTime()),
        expiresAt.toISOString(),
        this.#jobKey("")
      ]
    );
    const raw = redisString(result);
    if (raw === undefined) {
      return undefined;
    }
    return parseLeasedJob(raw);
  }

  public async renewLease(jobId: string, leaseId: string, leaseMs: number): Promise<LeasedJob> {
    this.#assertOpen();
    const id = jobIdSchema.parse(jobId);
    const parsedLeaseId = leaseIdSchema.parse(leaseId);
    const duration = leaseDurationSchema.parse(leaseMs);
    const now = this.#now();
    const expiresAt = new Date(now.getTime() + duration);
    const raw = await this.#activeJobCommand(renewLeaseScript, id, parsedLeaseId, [
      String(expiresAt.getTime()),
      expiresAt.toISOString(),
      now.toISOString()
    ]);
    return parseLeasedJob(raw);
  }

  public async updateProgress(
    jobId: string,
    leaseId: string,
    progressPercent: number
  ): Promise<JobRecord> {
    this.#assertOpen();
    const id = jobIdSchema.parse(jobId);
    const parsedLeaseId = leaseIdSchema.parse(leaseId);
    const progress = progressSchema.parse(progressPercent);
    const now = this.#now();
    const raw = await this.#activeJobCommand(updateProgressScript, id, parsedLeaseId, [
      String(progress),
      now.toISOString()
    ]);
    if (raw === progressReversedMarker) {
      throw new JobQueueError("PROGRESS_REVERSED", "任务进度不能倒退。");
    }
    return parseJob(raw);
  }

  public async putItemReport(
    jobId: string,
    leaseId: string,
    report: JobItemReport
  ): Promise<JobRecord> {
    this.#assertOpen();
    const id = jobIdSchema.parse(jobId);
    const parsedLeaseId = leaseIdSchema.parse(leaseId);
    const parsedReport = jobItemReportSchema.parse(report);
    const raw = await this.#activeJobCommand(putItemReportScript, id, parsedLeaseId, [
      encodeJson(parsedReport),
      this.#now().toISOString()
    ]);
    if (raw === reportLimitMarker) {
      throw new JobQueueError("INVALID_JOB_INPUT", "任务逐项报告数量超过限制。");
    }
    return parseJob(raw);
  }

  public async complete(
    jobId: string,
    leaseId: string,
    result: JsonValue = null
  ): Promise<JobRecord> {
    this.#assertOpen();
    const id = jobIdSchema.parse(jobId);
    const parsedLeaseId = leaseIdSchema.parse(leaseId);
    const parsedResult = jsonValueSchema.parse(result);
    const now = this.#now();
    const raw = await this.#activeJobCommand(completeScript, id, parsedLeaseId, [
      encodeJson(parsedResult),
      now.toISOString()
    ]);
    return parseJob(raw);
  }

  public async fail(jobId: string, leaseId: string, failure: FailJobInput): Promise<JobRecord> {
    this.#assertOpen();
    const id = jobIdSchema.parse(jobId);
    const parsedLeaseId = leaseIdSchema.parse(leaseId);
    const parsedFailure = jobFailureSchema
      .extend({ retryable: z.boolean() })
      .parse(failure);
    const now = this.#now();
    const retryAt = new Date(now.getTime() + this.#retryDelayMs);
    const raw = await this.#activeJobCommand(failScript, id, parsedLeaseId, [
      encodeJson({ code: parsedFailure.code, message: parsedFailure.message }),
      parsedFailure.retryable ? "1" : "0",
      String(retryAt.getTime()),
      retryAt.toISOString(),
      now.toISOString()
    ], [this.#queuedKey()]);
    return parseJob(raw);
  }

  public async cancel(jobId: string): Promise<JobRecord | undefined> {
    this.#assertOpen();
    const id = jobIdSchema.parse(jobId);
    const result = await this.#commands.evaluate(
      cancelScript,
      [this.#jobKey(id), this.#queuedKey(), this.#runningKey()],
      [id, this.#now().toISOString()]
    );
    const raw = redisString(result);
    return raw === undefined ? undefined : parseJob(raw);
  }

  public async recoverExpiredLeases(): Promise<number> {
    this.#assertOpen();
    const now = this.#now();
    const result = await this.#commands.evaluate(
      recoverExpiredScript,
      [this.#runningKey(), this.#queuedKey()],
      [String(now.getTime()), now.toISOString(), this.#jobKey("")]
    );
    const count = typeof result === "number" ? result : Number(redisString(result));
    if (!Number.isSafeInteger(count) || count < 0) {
      throw new JobQueueError("INVALID_JOB_INPUT", "Redis 返回了无效的恢复数量。");
    }
    return count;
  }

  public async close(): Promise<void> {
    if (this.#closed) {
      return;
    }
    this.#closed = true;
    await this.#close();
  }

  async #activeJobCommand(
    script: string,
    jobId: string,
    leaseId: string,
    extraArguments: readonly string[],
    extraKeys: readonly string[] = []
  ): Promise<string> {
    const now = this.#now();
    const result = await this.#commands.evaluate(
      script,
      [this.#jobKey(jobId), this.#runningKey(), ...extraKeys],
      [jobId, leaseId, String(now.getTime()), ...extraArguments]
    );
    const raw = redisString(result);
    if (raw === undefined || raw === leaseLostMarker) {
      throw new JobQueueError("LEASE_LOST", "任务租约已失效。");
    }
    return raw;
  }

  #jobKey(jobId: string): string {
    return `${this.#prefix}:job:${jobId}`;
  }

  #idempotencyKey(digest: string): string {
    return `${this.#prefix}:idempotency:${digest}`;
  }

  #queuedKey(): string {
    return `${this.#prefix}:queued`;
  }

  #runningKey(): string {
    return `${this.#prefix}:running`;
  }

  #assertOpen(): void {
    if (this.#closed) {
      throw new JobQueueError("QUEUE_CLOSED", "任务队列已经关闭。");
    }
  }
}

class NodeRedisCommandClient implements RedisCommandClient {
  public constructor(
    private readonly getValue: (key: string) => Promise<string | null>,
    private readonly runScript: (
      script: string,
      keys: readonly string[],
      arguments_: readonly string[]
    ) => Promise<unknown>
  ) {}

  public async get(key: string): Promise<string | null> {
    return this.getValue(key);
  }

  public async evaluate(
    script: string,
    keys: readonly string[],
    arguments_: readonly string[]
  ): Promise<unknown> {
    return this.runScript(script, keys, arguments_);
  }
}

export interface ConnectRedisJobQueueOptions extends RedisJobQueueOptions {
  readonly url: string;
  readonly onError?: () => void;
}

export async function connectRedisJobQueue(
  options: ConnectRedisJobQueueOptions
): Promise<RedisJobQueue> {
  const url = z.string().url().parse(options.url);
  const client = createClient({ url });
  client.on("error", () => options.onError?.());
  await client.connect();
  const commandClient = new NodeRedisCommandClient(
    (key) => client.get(key),
    (script, keys, arguments_) =>
      client.eval(script, { keys: [...keys], arguments: [...arguments_] })
  );
  return new RedisJobQueue(commandClient, {
    ...(options.prefix === undefined ? {} : { prefix: options.prefix }),
    ...(options.retryDelayMs === undefined ? {} : { retryDelayMs: options.retryDelayMs }),
    ...(options.now === undefined ? {} : { now: options.now }),
    close: async () => {
      if (client.isOpen) {
        await client.quit();
      }
    }
  });
}

function parseJob(raw: string): JobRecord {
  try {
    const stored = redisJobSchema.parse(JSON.parse(raw));
    const { payloadJson, itemReportsJson, resultJson, ...record } = stored;
    return jobRecordSchema.parse({
      ...record,
      payload: JSON.parse(payloadJson),
      itemReports: JSON.parse(itemReportsJson),
      result: JSON.parse(resultJson)
    });
  } catch (error) {
    throw new JobQueueError("INVALID_JOB_INPUT", "Redis 中的任务记录格式不正确。", {
      cause: error
    });
  }
}

function toRedisJob(job: JobRecord): RedisJob {
  const { payload, itemReports, result, ...record } = job;
  return {
    ...record,
    payloadJson: encodeJson(payload),
    itemReportsJson: encodeJson(itemReports),
    resultJson: encodeJson(result)
  };
}

function parseLeasedJob(raw: string): LeasedJob {
  const job = parseJob(raw);
  if (job.state !== "running" || job.lease === null) {
    throw new JobQueueError("INVALID_JOB_INPUT", "Redis 返回的任务没有有效租约。");
  }
  return job as LeasedJob;
}

function redisString(value: unknown): string | undefined {
  if (typeof value === "string") {
    return value;
  }
  if (value instanceof Uint8Array) {
    return Buffer.from(value).toString("utf8");
  }
  return undefined;
}

const leaseLostMarker = "__LEASE_LOST__";
const progressReversedMarker = "__PROGRESS_REVERSED__";
const reportLimitMarker = "__REPORT_LIMIT__";

const enqueueScript = `
local existing = redis.call("GET", KEYS[1])
if existing then
  return existing
end
redis.call("SET", KEYS[1], ARGV[1])
redis.call("SET", KEYS[2], ARGV[2])
redis.call("ZADD", KEYS[3], ARGV[3], ARGV[1])
return ARGV[1]
`;

const leaseScript = `
local ids = redis.call("ZRANGEBYSCORE", KEYS[1], "-inf", ARGV[1], "LIMIT", 0, 1)
if #ids == 0 then
  return nil
end
local id = ids[1]
redis.call("ZREM", KEYS[1], id)
local key = ARGV[7] .. id
local raw = redis.call("GET", key)
if not raw then
  return nil
end
local job = cjson.decode(raw)
if job.state ~= "queued" then
  return nil
end
job.state = "running"
job.attempt = job.attempt + 1
job.lease = { id = ARGV[3], workerId = ARGV[4], expiresAt = ARGV[6] }
if job.startedAt == cjson.null then
  job.startedAt = ARGV[2]
end
job.updatedAt = ARGV[2]
local encoded = cjson.encode(job)
redis.call("SET", key, encoded)
redis.call("ZADD", KEYS[2], ARGV[5], id)
return encoded
`;

const renewLeaseScript = `
local score = redis.call("ZSCORE", KEYS[2], ARGV[1])
if not score or tonumber(score) <= tonumber(ARGV[3]) then
  return "${leaseLostMarker}"
end
local raw = redis.call("GET", KEYS[1])
if not raw then return "${leaseLostMarker}" end
local job = cjson.decode(raw)
if job.state ~= "running" or job.lease == cjson.null or job.lease.id ~= ARGV[2] then
  return "${leaseLostMarker}"
end
job.lease.expiresAt = ARGV[5]
job.updatedAt = ARGV[6]
local encoded = cjson.encode(job)
redis.call("SET", KEYS[1], encoded)
redis.call("ZADD", KEYS[2], ARGV[4], ARGV[1])
return encoded
`;

const updateProgressScript = `
local score = redis.call("ZSCORE", KEYS[2], ARGV[1])
if not score or tonumber(score) <= tonumber(ARGV[3]) then
  return "${leaseLostMarker}"
end
local raw = redis.call("GET", KEYS[1])
if not raw then return "${leaseLostMarker}" end
local job = cjson.decode(raw)
if job.state ~= "running" or job.lease == cjson.null or job.lease.id ~= ARGV[2] then
  return "${leaseLostMarker}"
end
local progress = tonumber(ARGV[4])
if progress < job.progressPercent then
  return "${progressReversedMarker}"
end
job.progressPercent = progress
job.updatedAt = ARGV[5]
local encoded = cjson.encode(job)
redis.call("SET", KEYS[1], encoded)
return encoded
`;

const putItemReportScript = `
local score = redis.call("ZSCORE", KEYS[2], ARGV[1])
if not score or tonumber(score) <= tonumber(ARGV[3]) then
  return "${leaseLostMarker}"
end
local raw = redis.call("GET", KEYS[1])
if not raw then return "${leaseLostMarker}" end
local job = cjson.decode(raw)
if job.state ~= "running" or job.lease == cjson.null or job.lease.id ~= ARGV[2] then
  return "${leaseLostMarker}"
end
local report = cjson.decode(ARGV[4])
local reports = cjson.decode(job.itemReportsJson)
local replaced = false
for index, item in ipairs(reports) do
  if item.itemId == report.itemId then
    reports[index] = report
    replaced = true
    break
  end
end
if not replaced then
  if #reports >= 10000 then
    return "${reportLimitMarker}"
  end
  table.insert(reports, report)
end
job.itemReportsJson = cjson.encode(reports)
job.updatedAt = ARGV[5]
local encoded = cjson.encode(job)
redis.call("SET", KEYS[1], encoded)
return encoded
`;

const completeScript = `
local score = redis.call("ZSCORE", KEYS[2], ARGV[1])
if not score or tonumber(score) <= tonumber(ARGV[3]) then
  return "${leaseLostMarker}"
end
local raw = redis.call("GET", KEYS[1])
if not raw then return "${leaseLostMarker}" end
local job = cjson.decode(raw)
if job.state ~= "running" or job.lease == cjson.null or job.lease.id ~= ARGV[2] then
  return "${leaseLostMarker}"
end
job.state = "succeeded"
job.progressPercent = 100
job.lease = cjson.null
job.failure = cjson.null
job.resultJson = ARGV[4]
job.updatedAt = ARGV[5]
job.finishedAt = ARGV[5]
local encoded = cjson.encode(job)
redis.call("SET", KEYS[1], encoded)
redis.call("ZREM", KEYS[2], ARGV[1])
return encoded
`;

const failScript = `
local score = redis.call("ZSCORE", KEYS[2], ARGV[1])
if not score or tonumber(score) <= tonumber(ARGV[3]) then
  return "${leaseLostMarker}"
end
local raw = redis.call("GET", KEYS[1])
if not raw then return "${leaseLostMarker}" end
local job = cjson.decode(raw)
if job.state ~= "running" or job.lease == cjson.null or job.lease.id ~= ARGV[2] then
  return "${leaseLostMarker}"
end
job.failure = cjson.decode(ARGV[4])
job.lease = cjson.null
job.updatedAt = ARGV[8]
redis.call("ZREM", KEYS[2], ARGV[1])
if ARGV[5] == "1" and job.attempt < job.maxAttempts then
  job.state = "queued"
  job.availableAt = ARGV[7]
  job.finishedAt = cjson.null
  redis.call("ZADD", KEYS[3], ARGV[6], ARGV[1])
else
  job.state = "failed"
  job.finishedAt = ARGV[8]
end
local encoded = cjson.encode(job)
redis.call("SET", KEYS[1], encoded)
return encoded
`;

const cancelScript = `
local raw = redis.call("GET", KEYS[1])
if not raw then return nil end
local job = cjson.decode(raw)
if job.state == "succeeded" or job.state == "failed" or job.state == "cancelled" then
  return raw
end
job.state = "cancelled"
job.lease = cjson.null
job.updatedAt = ARGV[2]
job.finishedAt = ARGV[2]
local encoded = cjson.encode(job)
redis.call("SET", KEYS[1], encoded)
redis.call("ZREM", KEYS[2], ARGV[1])
redis.call("ZREM", KEYS[3], ARGV[1])
return encoded
`;

const recoverExpiredScript = `
local ids = redis.call("ZRANGEBYSCORE", KEYS[1], "-inf", ARGV[1], "LIMIT", 0, 100)
local recovered = 0
for _, id in ipairs(ids) do
  redis.call("ZREM", KEYS[1], id)
  local key = ARGV[3] .. id
  local raw = redis.call("GET", key)
  if raw then
    local job = cjson.decode(raw)
    if job.state == "running" then
      job.lease = cjson.null
      job.updatedAt = ARGV[2]
      if job.attempt < job.maxAttempts then
        job.state = "queued"
        job.availableAt = ARGV[2]
        job.finishedAt = cjson.null
        job.failure = { code = "lease_expired", message = "上一次执行超时，任务已重新排队。" }
        redis.call("ZADD", KEYS[2], ARGV[1], id)
      else
        job.state = "failed"
        job.finishedAt = ARGV[2]
        job.failure = { code = "lease_expired", message = "任务执行超时，且已达到重试上限。" }
      end
      redis.call("SET", key, cjson.encode(job))
      recovered = recovered + 1
    end
  end
end
return recovered
`;
