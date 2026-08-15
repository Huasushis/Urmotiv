import { JobQueueError, type JobQueue } from "./queue";
import { jobTypeSchema, type LeasedJob } from "./types";
import { z } from "zod";
import {
  ConsoleJobLogger,
  PermanentJobError,
  jobHandlerResultSchema,
  validateItemReport,
  type JobHandler,
  type JobHandlerContext,
  type JobLogger
} from "./worker-types";

const workerOptionsSchema = z
  .object({
    workerId: z.string().min(1).max(200),
    leaseMs: z.number().int().min(100).max(24 * 60 * 60 * 1_000),
    pollIntervalMs: z.number().int().min(10).max(60_000)
  })
  .strict();

export interface JobWorkerOptions {
  readonly workerId: string;
  readonly leaseMs?: number;
  readonly pollIntervalMs?: number;
  readonly logger?: JobLogger;
}

export class JobWorker {
  readonly #queue: JobQueue;
  readonly #handlers = new Map<string, JobHandler>();
  readonly #workerId: string;
  readonly #leaseMs: number;
  readonly #pollIntervalMs: number;
  readonly #logger: JobLogger;
  #registryLocked = false;
  #stopping = false;
  #pollController: AbortController | undefined;
  #running: Promise<void> | undefined;
  #currentExecution: Promise<void> | undefined;
  #lastActivityAt: number = Date.now();

  public constructor(queue: JobQueue, options: JobWorkerOptions) {
    const parsed = workerOptionsSchema.parse({
      workerId: options.workerId,
      leaseMs: options.leaseMs ?? 30_000,
      pollIntervalMs: options.pollIntervalMs ?? 500
    });
    this.#queue = queue;
    this.#workerId = parsed.workerId;
    this.#leaseMs = parsed.leaseMs;
    this.#pollIntervalMs = parsed.pollIntervalMs;
    this.#logger = options.logger ?? new ConsoleJobLogger();
  }

  public register(type: string, handler: JobHandler): void {
    if (this.#registryLocked) {
      throw new Error("worker 已经开始运行，不能再注册任务处理器。");
    }
    const parsedType = jobTypeSchema.parse(type);
    if (this.#handlers.has(parsedType)) {
      throw new Error(`任务类型 ${parsedType} 已经注册。`);
    }
    this.#handlers.set(parsedType, handler);
  }

  public async run(): Promise<void> {
    if (this.#running !== undefined) {
      throw new Error("worker 已经在运行。");
    }
    this.#registryLocked = true;
    this.#stopping = false;
    const loop = this.#runLoop();
    this.#running = loop;
    try {
      await loop;
    } finally {
      this.#running = undefined;
    }
  }

  public async runOnce(): Promise<boolean> {
    this.#registryLocked = true;
    if (this.#currentExecution !== undefined) {
      throw new Error("worker 正在处理另一个任务。");
    }
    const job = await this.#queue.leaseNext({
      workerId: this.#workerId,
      leaseMs: this.#leaseMs
    });
    if (job === undefined) {
      this.#lastActivityAt = Date.now();
      return false;
    }

    const execution = this.#execute(job);
    this.#currentExecution = execution;
    try {
      await execution;
    } finally {
      this.#currentExecution = undefined;
    }
    this.#lastActivityAt = Date.now();
    return true;
  }

  public lastActivityAt(): number {
    return this.#lastActivityAt;
  }

  public async stop(): Promise<void> {
    this.#stopping = true;
    this.#pollController?.abort();
    await this.#currentExecution;
    await this.#running;
  }

  async #runLoop(): Promise<void> {
    while (!this.#stopping) {
      const processed = await this.runOnce();
      if (!processed && !this.#stopping) {
        this.#pollController = new AbortController();
        await wait(this.#pollIntervalMs, this.#pollController.signal);
        this.#pollController = undefined;
      }
    }
  }

  async #execute(job: LeasedJob): Promise<void> {
    this.#logger.write({ jobId: job.id, outcome: "started", attempt: job.attempt });
    const handler = this.#handlers.get(job.type);
    if (handler === undefined) {
      const failed = await this.#queue.fail(job.id, job.lease.id, {
        code: "unknown_job_type",
        message: "没有注册该任务类型的处理器。",
        retryable: false
      });
      this.#logger.write({ jobId: job.id, outcome: "failed", attempt: failed.attempt });
      return;
    }

    const controller = new AbortController();
    let timeoutReached = false;
    let rejectLeaseLost: (reason: Error) => void = () => undefined;
    const leaseLost = new Promise<never>((_resolve, reject) => {
      rejectLeaseLost = reject;
    });
    let heartbeatRunning = false;
    const heartbeat = setInterval(() => {
      if (heartbeatRunning) {
        return;
      }
      heartbeatRunning = true;
      void this.#queue
        .renewLease(job.id, job.lease.id, this.#leaseMs)
        .then(() => {
          this.#lastActivityAt = Date.now();
        })
        .catch(() => {
          controller.abort();
          rejectLeaseLost(new JobQueueError("LEASE_LOST", "任务租约已失效。"));
        })
        .finally(() => {
          heartbeatRunning = false;
        });
    }, Math.max(50, Math.floor(this.#leaseMs / 3)));

    let rejectTimeout: (reason: Error) => void = () => undefined;
    const timeout = new Promise<never>((_resolve, reject) => {
      rejectTimeout = reject;
    });
    const timeoutHandle = setTimeout(() => {
      timeoutReached = true;
      controller.abort();
      rejectTimeout(new Error("handler_timeout"));
    }, job.timeoutMs);

    const context: JobHandlerContext = {
      jobId: job.id,
      attempt: job.attempt,
      maxAttempts: job.maxAttempts,
      signal: controller.signal,
      updateProgress: async (progressPercent) => {
        await this.#queue.updateProgress(job.id, job.lease.id, progressPercent);
      },
      putItemReport: async (report) => {
        await this.#queue.putItemReport(job.id, job.lease.id, validateItemReport(report));
      }
    };

    try {
      const handlerResult = Promise.resolve(handler(structuredClone(job.payload), context));
      const result = await Promise.race([handlerResult, timeout, leaseLost]);
      const parsed = jobHandlerResultSchema.parse(result ?? {});
      await this.#queue.complete(job.id, job.lease.id, parsed.result);
      this.#logger.write({ jobId: job.id, outcome: "succeeded", attempt: job.attempt });
    } catch (error) {
      controller.abort();
      if (error instanceof JobQueueError && error.code === "LEASE_LOST") {
        this.#logger.write({ jobId: job.id, outcome: "lease_lost", attempt: job.attempt });
        return;
      }

      const failure =
        error instanceof PermanentJobError
          ? { code: error.code, message: error.safeMessage, retryable: false }
          : timeoutReached
            ? {
                code: "handler_timeout",
                message: "任务处理超过时间限制。",
                retryable: true
              }
            : {
                code: "handler_failed",
                message: "任务处理时发生错误。",
                retryable: true
              };
      try {
        const failed = await this.#queue.fail(job.id, job.lease.id, failure);
        this.#logger.write({
          jobId: job.id,
          outcome: failed.state === "queued" ? "retry_scheduled" : "failed",
          attempt: failed.attempt
        });
      } catch (failureError) {
        if (failureError instanceof JobQueueError && failureError.code === "LEASE_LOST") {
          this.#logger.write({ jobId: job.id, outcome: "lease_lost", attempt: job.attempt });
          return;
        }
        throw failureError;
      }
    } finally {
      clearInterval(heartbeat);
      clearTimeout(timeoutHandle);
    }
  }
}

function wait(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    const finish = (): void => {
      clearTimeout(timeout);
      signal.removeEventListener("abort", finish);
      resolve();
    };
    const timeout = setTimeout(finish, milliseconds);
    signal.addEventListener("abort", finish, { once: true });
  });
}
