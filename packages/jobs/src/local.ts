import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  enqueueJobSchema,
  jobFailureSchema,
  jobItemReportSchema,
  jobRecordSchema,
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
import { createJobRecord, digestJobRequest, idempotencyIndexKey } from "./record";

const jobIdSchema = z.string().uuid();
const leaseIdSchema = z.string().uuid();
const workerIdSchema = z.string().min(1).max(200);
const leaseDurationSchema = z.number().int().min(100).max(24 * 60 * 60 * 1_000);
const progressSchema = z.number().int().min(0).max(100);

export interface LocalJobQueueOptions {
  readonly now?: () => Date;
  readonly retryDelayMs?: number;
}

export class LocalJobQueue implements JobQueue {
  readonly #jobs = new Map<string, JobRecord>();
  readonly #idempotencyIndex = new Map<string, string>();
  readonly #now: () => Date;
  readonly #retryDelayMs: number;
  #closed = false;

  public constructor(options: LocalJobQueueOptions = {}) {
    this.#now = options.now ?? (() => new Date());
    const retryDelayMs = options.retryDelayMs ?? 1_000;
    if (!Number.isSafeInteger(retryDelayMs) || retryDelayMs < 0) {
      throw new TypeError("任务重试间隔必须是非负整数。");
    }
    this.#retryDelayMs = retryDelayMs;
  }

  public async enqueue(input: EnqueueJobInput): Promise<JobRecord> {
    this.#assertOpen();
    const request = enqueueJobSchema.parse(input);
    const indexKey = idempotencyIndexKey(request.idempotencyScope, request.idempotencyKey);
    const existingId = this.#idempotencyIndex.get(indexKey);
    if (existingId !== undefined) {
      const existing = this.#jobs.get(existingId);
      if (existing === undefined) {
        throw new JobQueueError("JOB_NOT_FOUND", "幂等记录指向的任务不存在。");
      }
      if (existing.requestDigest !== digestJobRequest(request)) {
        throw new JobQueueError(
          "IDEMPOTENCY_CONFLICT",
          "同一个幂等键不能用于不同的任务内容。"
        );
      }
      return clone(existing);
    }

    const job = createJobRecord(request, this.#now());
    this.#jobs.set(job.id, job);
    this.#idempotencyIndex.set(indexKey, job.id);
    return clone(job);
  }

  public async get(jobId: string): Promise<JobRecord | undefined> {
    this.#assertOpen();
    jobIdSchema.parse(jobId);
    const job = this.#jobs.get(jobId);
    return job === undefined ? undefined : clone(job);
  }

  public async leaseNext(options: LeaseJobOptions): Promise<LeasedJob | undefined> {
    this.#assertOpen();
    const workerId = workerIdSchema.parse(options.workerId);
    const leaseMs = leaseDurationSchema.parse(options.leaseMs);
    await this.recoverExpiredLeases();
    const now = this.#now();
    const job = [...this.#jobs.values()]
      .filter(
        (candidate) =>
          candidate.state === "queued" && Date.parse(candidate.availableAt) <= now.getTime()
      )
      .sort(
        (left, right) =>
          left.availableAt.localeCompare(right.availableAt) ||
          left.createdAt.localeCompare(right.createdAt) ||
          left.id.localeCompare(right.id)
      )[0];
    if (job === undefined) {
      return undefined;
    }

    const leased: LeasedJob = {
      ...job,
      state: "running",
      attempt: job.attempt + 1,
      lease: {
        id: randomUUID(),
        workerId,
        expiresAt: new Date(now.getTime() + leaseMs).toISOString()
      },
      startedAt: job.startedAt ?? now.toISOString(),
      updatedAt: now.toISOString()
    };
    this.#jobs.set(job.id, leased);
    return clone(leased);
  }

  public async renewLease(jobId: string, leaseId: string, leaseMs: number): Promise<LeasedJob> {
    this.#assertOpen();
    const duration = leaseDurationSchema.parse(leaseMs);
    const job = this.#activeLease(jobId, leaseId);
    const now = this.#now();
    const renewed: LeasedJob = {
      ...job,
      lease: {
        ...job.lease,
        expiresAt: new Date(now.getTime() + duration).toISOString()
      },
      updatedAt: now.toISOString()
    };
    this.#jobs.set(job.id, renewed);
    return clone(renewed);
  }

  public async updateProgress(
    jobId: string,
    leaseId: string,
    progressPercent: number
  ): Promise<JobRecord> {
    this.#assertOpen();
    const progress = progressSchema.parse(progressPercent);
    const job = this.#activeLease(jobId, leaseId);
    if (progress < job.progressPercent) {
      throw new JobQueueError("PROGRESS_REVERSED", "任务进度不能倒退。");
    }
    const updated = { ...job, progressPercent: progress, updatedAt: this.#now().toISOString() };
    this.#jobs.set(job.id, updated);
    return clone(updated);
  }

  public async putItemReport(
    jobId: string,
    leaseId: string,
    report: JobItemReport
  ): Promise<JobRecord> {
    this.#assertOpen();
    const parsedReport = jobItemReportSchema.parse(report);
    const job = this.#activeLease(jobId, leaseId);
    const itemReports = job.itemReports.filter((item) => item.itemId !== parsedReport.itemId);
    if (itemReports.length >= 10_000) {
      throw new JobQueueError("INVALID_JOB_INPUT", "任务逐项报告数量超过限制。");
    }
    itemReports.push(parsedReport);
    const updated = { ...job, itemReports, updatedAt: this.#now().toISOString() };
    this.#jobs.set(job.id, updated);
    return clone(updated);
  }

  public async complete(
    jobId: string,
    leaseId: string,
    result: JsonValue = null
  ): Promise<JobRecord> {
    this.#assertOpen();
    const parsedResult = jobRecordSchema.shape.result.parse(result);
    const job = this.#activeLease(jobId, leaseId);
    const now = this.#now().toISOString();
    const completed: JobRecord = {
      ...job,
      state: "succeeded",
      progressPercent: 100,
      lease: null,
      failure: null,
      result: parsedResult,
      updatedAt: now,
      finishedAt: now
    };
    this.#jobs.set(job.id, completed);
    return clone(completed);
  }

  public async fail(jobId: string, leaseId: string, failure: FailJobInput): Promise<JobRecord> {
    this.#assertOpen();
    const parsedFailure = jobFailureSchema
      .extend({ retryable: z.boolean() })
      .parse(failure);
    const job = this.#activeLease(jobId, leaseId);
    const now = this.#now();
    const willRetry = parsedFailure.retryable && job.attempt < job.maxAttempts;
    const failed: JobRecord = {
      ...job,
      state: willRetry ? "queued" : "failed",
      availableAt: willRetry
        ? new Date(now.getTime() + this.#retryDelayMs).toISOString()
        : job.availableAt,
      lease: null,
      failure: { code: parsedFailure.code, message: parsedFailure.message },
      updatedAt: now.toISOString(),
      finishedAt: willRetry ? null : now.toISOString()
    };
    this.#jobs.set(job.id, failed);
    return clone(failed);
  }

  public async cancel(jobId: string): Promise<JobRecord | undefined> {
    this.#assertOpen();
    jobIdSchema.parse(jobId);
    const job = this.#jobs.get(jobId);
    if (job === undefined) {
      return undefined;
    }
    if (job.state === "succeeded" || job.state === "failed" || job.state === "cancelled") {
      return clone(job);
    }
    const now = this.#now().toISOString();
    const cancelled: JobRecord = {
      ...job,
      state: "cancelled",
      lease: null,
      updatedAt: now,
      finishedAt: now
    };
    this.#jobs.set(job.id, cancelled);
    return clone(cancelled);
  }

  public async recoverExpiredLeases(): Promise<number> {
    this.#assertOpen();
    const now = this.#now();
    let recovered = 0;
    for (const job of this.#jobs.values()) {
      if (
        job.state !== "running" ||
        job.lease === null ||
        Date.parse(job.lease.expiresAt) > now.getTime()
      ) {
        continue;
      }

      const willRetry = job.attempt < job.maxAttempts;
      const recoveredJob: JobRecord = {
        ...job,
        state: willRetry ? "queued" : "failed",
        availableAt: willRetry ? now.toISOString() : job.availableAt,
        lease: null,
        failure: {
          code: "lease_expired",
          message: willRetry
            ? "上一次执行超时，任务已重新排队。"
            : "任务执行超时，且已达到重试上限。"
        },
        updatedAt: now.toISOString(),
        finishedAt: willRetry ? null : now.toISOString()
      };
      this.#jobs.set(job.id, recoveredJob);
      recovered += 1;
    }
    return recovered;
  }

  public async close(): Promise<void> {
    this.#closed = true;
  }

  #activeLease(jobId: string, leaseId: string): LeasedJob {
    jobIdSchema.parse(jobId);
    leaseIdSchema.parse(leaseId);
    const job = this.#jobs.get(jobId);
    if (job === undefined) {
      throw new JobQueueError("JOB_NOT_FOUND", "任务不存在。");
    }
    if (job.state !== "running" || job.lease === null) {
      throw new JobQueueError("JOB_NOT_RUNNING", "任务当前没有执行者。");
    }
    if (job.lease.id !== leaseId || Date.parse(job.lease.expiresAt) <= this.#now().getTime()) {
      throw new JobQueueError("LEASE_LOST", "任务租约已失效。");
    }
    return job as LeasedJob;
  }

  #assertOpen(): void {
    if (this.#closed) {
      throw new JobQueueError("QUEUE_CLOSED", "任务队列已经关闭。");
    }
  }
}

function clone<T>(value: T): T {
  return structuredClone(value);
}
