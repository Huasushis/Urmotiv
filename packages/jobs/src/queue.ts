import type {
  EnqueueJobInput,
  JobFailure,
  JobItemReport,
  JobRecord,
  JsonValue,
  LeasedJob
} from "./types";

export interface LeaseJobOptions {
  readonly workerId: string;
  readonly leaseMs: number;
}

export interface FailJobInput extends JobFailure {
  readonly retryable: boolean;
}

export interface JobQueue {
  enqueue(input: EnqueueJobInput): Promise<JobRecord>;
  get(jobId: string): Promise<JobRecord | undefined>;
  leaseNext(options: LeaseJobOptions): Promise<LeasedJob | undefined>;
  renewLease(jobId: string, leaseId: string, leaseMs: number): Promise<LeasedJob>;
  updateProgress(jobId: string, leaseId: string, progressPercent: number): Promise<JobRecord>;
  putItemReport(jobId: string, leaseId: string, report: JobItemReport): Promise<JobRecord>;
  complete(jobId: string, leaseId: string, result?: JsonValue): Promise<JobRecord>;
  fail(jobId: string, leaseId: string, failure: FailJobInput): Promise<JobRecord>;
  cancel(jobId: string): Promise<JobRecord | undefined>;
  recoverExpiredLeases(): Promise<number>;
  close(): Promise<void>;
}

export type JobQueueErrorCode =
  | "IDEMPOTENCY_CONFLICT"
  | "INVALID_JOB_INPUT"
  | "JOB_NOT_FOUND"
  | "JOB_NOT_RUNNING"
  | "LEASE_LOST"
  | "PROGRESS_REVERSED"
  | "QUEUE_CLOSED";

export class JobQueueError extends Error {
  public constructor(
    public readonly code: JobQueueErrorCode,
    message: string,
    options?: ErrorOptions
  ) {
    super(message, options);
    this.name = "JobQueueError";
  }
}
