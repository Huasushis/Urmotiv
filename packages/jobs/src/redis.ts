import { randomUUID } from "node:crypto";
import { createClient } from "redis";
import { z } from "zod";
import {
  enqueueJobSchema,
  jobFailureSchema,
  jobItemReportSchema,
  jobLeaseSchema,
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
const redisTimestampSchema = z.number().int().nonnegative().safe();
const redisLeaseSchema = jobLeaseSchema
  .omit({ expiresAt: true })
  .extend({ expiresAtMs: redisTimestampSchema })
  .strict();
const redisJobSchema = jobRecordSchema
  .omit({
    payload: true,
    itemReports: true,
    result: true,
    availableAt: true,
    lease: true,
    createdAt: true,
    updatedAt: true,
    startedAt: true,
    finishedAt: true
  })
  .extend({
    payloadJson: z.string(),
    itemReportsJson: z.string(),
    resultJson: z.string(),
    availableAtMs: redisTimestampSchema,
    lease: redisLeaseSchema.nullable(),
    createdAtMs: redisTimestampSchema,
    updatedAtMs: redisTimestampSchema,
    startedAtMs: redisTimestampSchema.nullable(),
    finishedAtMs: redisTimestampSchema.nullable()
  })
  .strict();

const redisIdempotencyIndexSchema = z
  .object({
    jobId: z.string().uuid(),
    requestDigest: z.string().regex(/^[a-f0-9]{64}$/)
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
  /** Test-only compatibility hook. Redis queue timing always comes from Redis TIME. */
  readonly now?: () => Date;
  readonly close?: () => Promise<void>;
}

export class RedisJobQueue implements JobQueue {
  readonly #commands: RedisCommandClient;
  readonly #prefix: string;
  readonly #retryDelayMs: number;
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
    this.#close = options.close ?? (async () => undefined);
  }

  public async enqueue(input: EnqueueJobInput): Promise<JobRecord> {
    this.#assertOpen();
    const request = enqueueJobSchema.parse(input);
    const record = createJobRecord(request, new Date(0));
    const requestDigest = digestJobRequest(request);
    const indexKey = this.#idempotencyKey(
      idempotencyIndexKey(request.idempotencyScope, request.idempotencyKey)
    );
    const result = await this.#evaluate(
      enqueueScript,
      [indexKey, this.#jobKey(record.id), this.#queuedKey(), this.#runningKey()],
      [
        record.id,
        requestDigest,
        request.idempotencyScope,
        request.idempotencyKey,
        encodeJson(redisIdempotencyIndexSchema.parse({ jobId: record.id, requestDigest })),
        encodeJson(toRedisJob(record))
      ]
    );
    const response = redisStringArray(result);
    if (response?.[0] === enqueueConflictMarker) {
      throw idempotencyConflict();
    }
    if (response?.[0] !== enqueueOkMarker || response[1] === undefined) {
      throw invalidRedisResponse();
    }
    const stored = parseJob(response[1]);
    if (!sameJobIdentity(stored, request, requestDigest)) {
      throw idempotencyConflict();
    }
    return stored;
  }

  public async get(jobId: string): Promise<JobRecord | undefined> {
    this.#assertOpen();
    const id = jobIdSchema.parse(jobId);
    const raw = await this.#get(this.#jobKey(id));
    return raw === null ? undefined : parseJob(raw);
  }

  public async leaseNext(options: LeaseJobOptions): Promise<LeasedJob | undefined> {
    this.#assertOpen();
    const workerId = workerIdSchema.parse(options.workerId);
    const leaseMs = leaseDurationSchema.parse(options.leaseMs);
    await this.recoverExpiredLeases();
    const leaseId = randomUUID();
    const result = await this.#evaluate(
      leaseScript,
      [this.#queuedKey(), this.#runningKey()],
      [leaseId, workerId, String(leaseMs), this.#jobKey("")]
    );
    const raw = redisString(result);
    if (raw === undefined) {
      return undefined;
    }
    if (raw === invalidRecordMarker) {
      throw invalidRedisResponse();
    }
    return parseLeasedJob(raw);
  }

  public async renewLease(jobId: string, leaseId: string, leaseMs: number): Promise<LeasedJob> {
    this.#assertOpen();
    const id = jobIdSchema.parse(jobId);
    const parsedLeaseId = leaseIdSchema.parse(leaseId);
    const duration = leaseDurationSchema.parse(leaseMs);
    const raw = await this.#activeJobCommand(renewLeaseScript, id, parsedLeaseId, [
      String(duration)
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
    const raw = await this.#activeJobCommand(updateProgressScript, id, parsedLeaseId, [
      String(progress)
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
      encodeJson(parsedReport)
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
    const raw = await this.#activeJobCommand(completeScript, id, parsedLeaseId, [
      encodeJson(parsedResult)
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
    const raw = await this.#activeJobCommand(failScript, id, parsedLeaseId, [
      encodeJson({ code: parsedFailure.code, message: parsedFailure.message }),
      parsedFailure.retryable ? "1" : "0",
      String(this.#retryDelayMs)
    ], [this.#queuedKey()]);
    return parseJob(raw);
  }

  public async cancel(jobId: string): Promise<JobRecord | undefined> {
    this.#assertOpen();
    const id = jobIdSchema.parse(jobId);
    const result = await this.#evaluate(
      cancelScript,
      [this.#jobKey(id), this.#queuedKey(), this.#runningKey()],
      [id]
    );
    const raw = redisString(result);
    if (raw === invalidRecordMarker) {
      throw invalidRedisResponse();
    }
    return raw === undefined ? undefined : parseJob(raw);
  }

  public async recoverExpiredLeases(): Promise<number> {
    this.#assertOpen();
    let totalRecovered = 0;
    while (true) {
      const result = await this.#evaluate(
        recoverExpiredScript,
        [this.#runningKey(), this.#queuedKey()],
        [this.#jobKey("")]
      );
      const counts = redisNumberArray(result);
      if (counts === undefined || counts.length !== 2) {
        throw invalidRedisResponse();
      }
      const [scanned, recovered] = counts;
      if (
        scanned === undefined ||
        recovered === undefined ||
        !Number.isSafeInteger(scanned) ||
        !Number.isSafeInteger(recovered) ||
        scanned < 0 ||
        scanned > recoveryBatchSize ||
        recovered < 0 ||
        recovered > scanned
      ) {
        throw invalidRedisResponse();
      }
      totalRecovered += recovered;
      if (scanned < recoveryBatchSize) {
        return totalRecovered;
      }
    }
  }

  public async close(): Promise<void> {
    if (this.#closed) {
      return;
    }
    this.#closed = true;
    try {
      await this.#close();
    } catch {
      throw redisUnavailable();
    }
  }

  async #activeJobCommand(
    script: string,
    jobId: string,
    leaseId: string,
    extraArguments: readonly string[],
    extraKeys: readonly string[] = []
  ): Promise<string> {
    const result = await this.#evaluate(
      script,
      [this.#jobKey(jobId), this.#runningKey(), ...extraKeys],
      [jobId, leaseId, ...extraArguments]
    );
    const raw = redisString(result);
    if (raw === undefined || raw === leaseLostMarker) {
      throw new JobQueueError("LEASE_LOST", "任务租约已失效。");
    }
    if (raw === invalidRecordMarker) {
      throw invalidRedisResponse();
    }
    return raw;
  }

  #jobKey(jobId: string): string {
    return `${this.#prefix}:v2:job:${jobId}`;
  }

  #idempotencyKey(digest: string): string {
    return `${this.#prefix}:v2:idempotency:${digest}`;
  }

  #queuedKey(): string {
    return `${this.#prefix}:v2:queue:queued`;
  }

  #runningKey(): string {
    return `${this.#prefix}:v2:queue:running`;
  }

  async #get(key: string): Promise<string | null> {
    try {
      return await this.#commands.get(key);
    } catch {
      throw redisUnavailable();
    }
  }

  async #evaluate(
    script: string,
    keys: readonly string[],
    arguments_: readonly string[]
  ): Promise<unknown> {
    try {
      return await this.#commands.evaluate(script, keys, arguments_);
    } catch {
      throw redisUnavailable();
    }
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
  try {
    await client.connect();
  } catch {
    if (client.isOpen) {
      client.destroy();
    }
    throw redisUnavailable();
  }
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
    const {
      payloadJson,
      itemReportsJson,
      resultJson,
      availableAtMs,
      createdAtMs,
      updatedAtMs,
      startedAtMs,
      finishedAtMs,
      lease,
      ...record
    } = stored;
    return jobRecordSchema.parse({
      ...record,
      payload: JSON.parse(payloadJson),
      itemReports: JSON.parse(itemReportsJson),
      result: JSON.parse(resultJson),
      availableAt: redisDate(availableAtMs),
      lease:
        lease === null
          ? null
          : {
              id: lease.id,
              workerId: lease.workerId,
              expiresAt: redisDate(lease.expiresAtMs)
            },
      createdAt: redisDate(createdAtMs),
      updatedAt: redisDate(updatedAtMs),
      startedAt: startedAtMs === null ? null : redisDate(startedAtMs),
      finishedAt: finishedAtMs === null ? null : redisDate(finishedAtMs)
    });
  } catch {
    throw new JobQueueError("INVALID_JOB_INPUT", "Redis 中的任务记录格式不正确。");
  }
}

function toRedisJob(job: JobRecord): RedisJob {
  const {
    payload,
    itemReports,
    result,
    availableAt,
    lease,
    createdAt,
    updatedAt,
    startedAt,
    finishedAt,
    ...record
  } = job;
  return {
    ...record,
    payloadJson: encodeJson(payload),
    itemReportsJson: encodeJson(itemReports),
    resultJson: encodeJson(result),
    availableAtMs: Date.parse(availableAt),
    lease:
      lease === null
        ? null
        : {
            id: lease.id,
            workerId: lease.workerId,
            expiresAtMs: Date.parse(lease.expiresAt)
          },
    createdAtMs: Date.parse(createdAt),
    updatedAtMs: Date.parse(updatedAt),
    startedAtMs: startedAt === null ? null : Date.parse(startedAt),
    finishedAtMs: finishedAt === null ? null : Date.parse(finishedAt)
  };
}

function redisDate(timestamp: number): string {
  return new Date(timestamp).toISOString();
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

function redisStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const parsed = value.map(redisString);
  return parsed.every((item): item is string => item !== undefined) ? parsed : undefined;
}

function redisNumberArray(value: unknown): number[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const parsed = value.map((item) =>
    typeof item === "number" ? item : Number(redisString(item))
  );
  return parsed.every((item) => Number.isFinite(item)) ? parsed : undefined;
}

function sameJobIdentity(
  job: JobRecord,
  request: ReturnType<typeof enqueueJobSchema.parse>,
  requestDigest: string
): boolean {
  return (
    job.id === request.jobId &&
    job.requestDigest === requestDigest &&
    job.idempotencyScope === request.idempotencyScope &&
    job.idempotencyKey === request.idempotencyKey
  );
}

function idempotencyConflict(): JobQueueError {
  return new JobQueueError(
    "IDEMPOTENCY_CONFLICT",
    "同一个幂等键或任务编号不能用于不同的任务内容。"
  );
}

function redisUnavailable(): JobQueueError {
  return new JobQueueError("INVALID_JOB_INPUT", "Redis 任务队列暂时不可用。");
}

function invalidRedisResponse(): JobQueueError {
  return new JobQueueError("INVALID_JOB_INPUT", "Redis 返回了无效的任务队列结果。");
}

const leaseLostMarker = "__LEASE_LOST__";
const progressReversedMarker = "__PROGRESS_REVERSED__";
const reportLimitMarker = "__REPORT_LIMIT__";
const enqueueOkMarker = "__ENQUEUE_OK__";
const enqueueConflictMarker = "__ENQUEUE_CONFLICT__";
const invalidRecordMarker = "__INVALID_RECORD__";
const recoveryBatchSize = 100;

const enqueueScript = `
local indexRaw = redis.call("GET", KEYS[1])
if indexRaw then
  local decoded, index = pcall(cjson.decode, indexRaw)
  if not decoded or index.jobId ~= ARGV[1] or index.requestDigest ~= ARGV[2] then
    return { "${enqueueConflictMarker}" }
  end
end

local jobRaw = redis.call("GET", KEYS[2])
if jobRaw then
  local decoded, job = pcall(cjson.decode, jobRaw)
  if not decoded or
     job.id ~= ARGV[1] or
     job.requestDigest ~= ARGV[2] or
     job.idempotencyScope ~= ARGV[3] or
     job.idempotencyKey ~= ARGV[4] then
    return { "${enqueueConflictMarker}" }
  end
  if not indexRaw then
    redis.call("SET", KEYS[1], ARGV[5])
  end
  return { "${enqueueOkMarker}", jobRaw }
end

local decoded, job = pcall(cjson.decode, ARGV[6])
if not decoded then
  return { "${invalidRecordMarker}" }
end
local redisTime = redis.call("TIME")
local nowMs = tonumber(redisTime[1]) * 1000 + math.floor(tonumber(redisTime[2]) / 1000)
job.availableAtMs = nowMs
job.createdAtMs = nowMs
job.updatedAtMs = nowMs
job.startedAtMs = cjson.null
job.finishedAtMs = cjson.null
local encoded = cjson.encode(job)
redis.call("SET", KEYS[1], ARGV[5])
redis.call("SET", KEYS[2], encoded)
redis.call("ZREM", KEYS[4], ARGV[1])
redis.call("ZADD", KEYS[3], nowMs, ARGV[1])
return { "${enqueueOkMarker}", encoded }
`;

const leaseScript = `
local redisTime = redis.call("TIME")
local nowMs = tonumber(redisTime[1]) * 1000 + math.floor(tonumber(redisTime[2]) / 1000)
for _ = 1, 100 do
  local ids = redis.call("ZRANGEBYSCORE", KEYS[1], "-inf", nowMs, "LIMIT", 0, 1)
  if #ids == 0 then
    return nil
  end
  local id = ids[1]
  local key = ARGV[4] .. id
  local raw = redis.call("GET", key)
  if not raw then
    redis.call("ZREM", KEYS[1], id)
  else
    local decoded, job = pcall(cjson.decode, raw)
    if not decoded then
      return "${invalidRecordMarker}"
    end
    if job.state ~= "queued" then
      redis.call("ZREM", KEYS[1], id)
    else
      local expiresAtMs = nowMs + tonumber(ARGV[3])
      job.state = "running"
      job.attempt = job.attempt + 1
      job.lease = { id = ARGV[1], workerId = ARGV[2], expiresAtMs = expiresAtMs }
      if job.startedAtMs == cjson.null then
        job.startedAtMs = nowMs
      end
      job.updatedAtMs = nowMs
      local encoded = cjson.encode(job)
      redis.call("ZREM", KEYS[1], id)
      redis.call("SET", key, encoded)
      redis.call("ZADD", KEYS[2], expiresAtMs, id)
      return encoded
    end
  end
end
return nil
`;

const renewLeaseScript = `
local redisTime = redis.call("TIME")
local nowMs = tonumber(redisTime[1]) * 1000 + math.floor(tonumber(redisTime[2]) / 1000)
local score = redis.call("ZSCORE", KEYS[2], ARGV[1])
if not score or tonumber(score) <= nowMs then
  return "${leaseLostMarker}"
end
local raw = redis.call("GET", KEYS[1])
if not raw then return "${leaseLostMarker}" end
local decoded, job = pcall(cjson.decode, raw)
if not decoded then return "${invalidRecordMarker}" end
if job.state ~= "running" or
   job.lease == cjson.null or
   job.lease.id ~= ARGV[2] or
   tonumber(job.lease.expiresAtMs) ~= tonumber(score) or
   tonumber(job.lease.expiresAtMs) <= nowMs then
  return "${leaseLostMarker}"
end
local expiresAtMs = nowMs + tonumber(ARGV[3])
job.lease.expiresAtMs = expiresAtMs
job.updatedAtMs = nowMs
local encoded = cjson.encode(job)
redis.call("SET", KEYS[1], encoded)
redis.call("ZADD", KEYS[2], expiresAtMs, ARGV[1])
return encoded
`;

const updateProgressScript = `
local redisTime = redis.call("TIME")
local nowMs = tonumber(redisTime[1]) * 1000 + math.floor(tonumber(redisTime[2]) / 1000)
local score = redis.call("ZSCORE", KEYS[2], ARGV[1])
if not score or tonumber(score) <= nowMs then
  return "${leaseLostMarker}"
end
local raw = redis.call("GET", KEYS[1])
if not raw then return "${leaseLostMarker}" end
local decoded, job = pcall(cjson.decode, raw)
if not decoded then return "${invalidRecordMarker}" end
if job.state ~= "running" or
   job.lease == cjson.null or
   job.lease.id ~= ARGV[2] or
   tonumber(job.lease.expiresAtMs) ~= tonumber(score) or
   tonumber(job.lease.expiresAtMs) <= nowMs then
  return "${leaseLostMarker}"
end
local progress = tonumber(ARGV[3])
if progress < job.progressPercent then
  return "${progressReversedMarker}"
end
job.progressPercent = progress
job.updatedAtMs = nowMs
local encoded = cjson.encode(job)
redis.call("SET", KEYS[1], encoded)
return encoded
`;

const putItemReportScript = `
local redisTime = redis.call("TIME")
local nowMs = tonumber(redisTime[1]) * 1000 + math.floor(tonumber(redisTime[2]) / 1000)
local score = redis.call("ZSCORE", KEYS[2], ARGV[1])
if not score or tonumber(score) <= nowMs then
  return "${leaseLostMarker}"
end
local raw = redis.call("GET", KEYS[1])
if not raw then return "${leaseLostMarker}" end
local decoded, job = pcall(cjson.decode, raw)
if not decoded then return "${invalidRecordMarker}" end
if job.state ~= "running" or
   job.lease == cjson.null or
   job.lease.id ~= ARGV[2] or
   tonumber(job.lease.expiresAtMs) ~= tonumber(score) or
   tonumber(job.lease.expiresAtMs) <= nowMs then
  return "${leaseLostMarker}"
end
local report = cjson.decode(ARGV[3])
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
job.updatedAtMs = nowMs
local encoded = cjson.encode(job)
redis.call("SET", KEYS[1], encoded)
return encoded
`;

const completeScript = `
local redisTime = redis.call("TIME")
local nowMs = tonumber(redisTime[1]) * 1000 + math.floor(tonumber(redisTime[2]) / 1000)
local score = redis.call("ZSCORE", KEYS[2], ARGV[1])
if not score or tonumber(score) <= nowMs then
  return "${leaseLostMarker}"
end
local raw = redis.call("GET", KEYS[1])
if not raw then return "${leaseLostMarker}" end
local decoded, job = pcall(cjson.decode, raw)
if not decoded then return "${invalidRecordMarker}" end
if job.state ~= "running" or
   job.lease == cjson.null or
   job.lease.id ~= ARGV[2] or
   tonumber(job.lease.expiresAtMs) ~= tonumber(score) or
   tonumber(job.lease.expiresAtMs) <= nowMs then
  return "${leaseLostMarker}"
end
job.state = "succeeded"
job.progressPercent = 100
job.lease = cjson.null
job.failure = cjson.null
job.resultJson = ARGV[3]
job.updatedAtMs = nowMs
job.finishedAtMs = nowMs
local encoded = cjson.encode(job)
redis.call("SET", KEYS[1], encoded)
redis.call("ZREM", KEYS[2], ARGV[1])
return encoded
`;

const failScript = `
local redisTime = redis.call("TIME")
local nowMs = tonumber(redisTime[1]) * 1000 + math.floor(tonumber(redisTime[2]) / 1000)
local score = redis.call("ZSCORE", KEYS[2], ARGV[1])
if not score or tonumber(score) <= nowMs then
  return "${leaseLostMarker}"
end
local raw = redis.call("GET", KEYS[1])
if not raw then return "${leaseLostMarker}" end
local decoded, job = pcall(cjson.decode, raw)
if not decoded then return "${invalidRecordMarker}" end
if job.state ~= "running" or
   job.lease == cjson.null or
   job.lease.id ~= ARGV[2] or
   tonumber(job.lease.expiresAtMs) ~= tonumber(score) or
   tonumber(job.lease.expiresAtMs) <= nowMs then
  return "${leaseLostMarker}"
end
job.failure = cjson.decode(ARGV[3])
job.lease = cjson.null
job.updatedAtMs = nowMs
redis.call("ZREM", KEYS[2], ARGV[1])
if ARGV[4] == "1" and job.attempt < job.maxAttempts then
  local retryAtMs = nowMs + tonumber(ARGV[5])
  job.state = "queued"
  job.availableAtMs = retryAtMs
  job.finishedAtMs = cjson.null
  redis.call("ZADD", KEYS[3], retryAtMs, ARGV[1])
else
  job.state = "failed"
  job.finishedAtMs = nowMs
end
local encoded = cjson.encode(job)
redis.call("SET", KEYS[1], encoded)
return encoded
`;

const cancelScript = `
local redisTime = redis.call("TIME")
local nowMs = tonumber(redisTime[1]) * 1000 + math.floor(tonumber(redisTime[2]) / 1000)
local raw = redis.call("GET", KEYS[1])
if not raw then return nil end
local decoded, job = pcall(cjson.decode, raw)
if not decoded then return "${invalidRecordMarker}" end
if job.state == "succeeded" or job.state == "failed" or job.state == "cancelled" then
  return raw
end
job.state = "cancelled"
job.lease = cjson.null
job.updatedAtMs = nowMs
job.finishedAtMs = nowMs
local encoded = cjson.encode(job)
redis.call("SET", KEYS[1], encoded)
redis.call("ZREM", KEYS[2], ARGV[1])
redis.call("ZREM", KEYS[3], ARGV[1])
return encoded
`;

const recoverExpiredScript = `
local redisTime = redis.call("TIME")
local nowMs = tonumber(redisTime[1]) * 1000 + math.floor(tonumber(redisTime[2]) / 1000)
local ids = redis.call("ZRANGEBYSCORE", KEYS[1], "-inf", nowMs, "LIMIT", 0, ${recoveryBatchSize})
local entries = {}
for _, id in ipairs(ids) do
  local key = ARGV[1] .. id
  local raw = redis.call("GET", key)
  if raw then
    local decoded, job = pcall(cjson.decode, raw)
    if not decoded then
      return { "-1", "-1" }
    end
    entries[id] = { key = key, job = job }
  end
end

local recovered = 0
for _, id in ipairs(ids) do
  local entry = entries[id]
  if not entry then
    redis.call("ZREM", KEYS[1], id)
  else
    local job = entry.job
    if job.state == "running" and job.lease ~= cjson.null then
      local expiresAtMs = tonumber(job.lease.expiresAtMs)
      if not expiresAtMs then
        return { "-1", "-1" }
      end
      if expiresAtMs > nowMs then
        redis.call("ZADD", KEYS[1], expiresAtMs, id)
      else
        redis.call("ZREM", KEYS[1], id)
        job.lease = cjson.null
        job.updatedAtMs = nowMs
        if job.attempt < job.maxAttempts then
          job.state = "queued"
          job.availableAtMs = nowMs
          job.finishedAtMs = cjson.null
          job.failure = { code = "lease_expired", message = "上一次执行超时，任务已重新排队。" }
          redis.call("ZADD", KEYS[2], nowMs, id)
        else
          job.state = "failed"
          job.finishedAtMs = nowMs
          job.failure = { code = "lease_expired", message = "任务执行超时，且已达到重试上限。" }
        end
        redis.call("SET", entry.key, cjson.encode(job))
        recovered = recovered + 1
      end
    else
      redis.call("ZREM", KEYS[1], id)
    end
  end
end
return { tostring(#ids), tostring(recovered) }
`;
