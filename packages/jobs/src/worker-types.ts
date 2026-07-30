import {
  jobItemReportSchema,
  jobFailureSchema,
  jsonValueSchema,
  type JobItemReport,
  type JsonValue
} from "./types";
import { z } from "zod";

export const jobHandlerResultSchema = z
  .object({
    result: jsonValueSchema.default(null)
  })
  .strict();

export type JobHandlerResult = z.output<typeof jobHandlerResultSchema>;

export interface JobHandlerContext {
  readonly jobId: string;
  readonly attempt: number;
  readonly signal: AbortSignal;
  updateProgress(progressPercent: number): Promise<void>;
  putItemReport(report: JobItemReport): Promise<void>;
}

export type JobHandler = (
  payload: JsonValue,
  context: JobHandlerContext
) => Promise<JobHandlerResult | void> | JobHandlerResult | void;

export const jobLogOutcomes = [
  "started",
  "succeeded",
  "retry_scheduled",
  "failed",
  "lease_lost"
] as const;

export interface JobLogEvent {
  readonly jobId: string;
  readonly outcome: (typeof jobLogOutcomes)[number];
  readonly attempt: number;
}

export interface JobLogger {
  write(event: JobLogEvent): void;
}

export class ConsoleJobLogger implements JobLogger {
  public write(event: JobLogEvent): void {
    process.stdout.write(`${JSON.stringify(event)}\n`);
  }
}

export class PermanentJobError extends Error {
  public readonly code: string;
  public readonly safeMessage: string;

  public constructor(code: string, safeMessage: string) {
    const parsed = z
      .object({
        code: jobFailureSchema.shape.code,
        safeMessage: z.string().min(1).max(1_000)
      })
      .strict()
      .parse({ code, safeMessage });
    super(parsed.safeMessage);
    this.name = "PermanentJobError";
    this.code = parsed.code;
    this.safeMessage = parsed.safeMessage;
  }
}

export function validateItemReport(report: JobItemReport): JobItemReport {
  return jobItemReportSchema.parse(report);
}
