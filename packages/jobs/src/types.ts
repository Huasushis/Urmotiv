import { z } from "zod";

export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { readonly [key: string]: JsonValue };

export const jsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.string(),
    z.number().finite(),
    z.boolean(),
    z.null(),
    z.array(jsonValueSchema),
    z.record(z.string(), jsonValueSchema)
  ])
);

export const jobTypeSchema = z
  .string()
  .min(3)
  .max(160)
  .regex(/^[a-z0-9]+(?:[._-][a-z0-9]+)+$/);

export const problemImportJobType = "problem.import" as const;
export const problemExportJobType = "problem.export" as const;

export const problemImportJobPayloadSchema = z
  .object({ importJobId: z.string().uuid() })
  .strict();

export const problemExportJobPayloadSchema = z
  .object({ exportJobId: z.string().uuid() })
  .strict();

export type ProblemImportJobPayload = z.infer<typeof problemImportJobPayloadSchema>;
export type ProblemExportJobPayload = z.infer<typeof problemExportJobPayloadSchema>;

export const jobStates = ["queued", "running", "succeeded", "failed", "cancelled"] as const;
export const jobStateSchema = z.enum(jobStates);

export const jobItemReportSchema = z
  .object({
    itemId: z.string().min(1).max(200),
    state: z.enum(["queued", "running", "succeeded", "failed", "skipped"]),
    code: z
      .string()
      .min(1)
      .max(120)
      .regex(/^[a-z0-9]+(?:[._-][a-z0-9]+)*$/)
      .optional(),
    message: z.string().max(1_000).optional(),
    resultId: z.string().min(1).max(200).optional()
  })
  .strict();

export type JobItemReport = z.infer<typeof jobItemReportSchema>;

export const jobFailureSchema = z
  .object({
    code: z.string().min(1).max(120).regex(/^[a-z0-9]+(?:[._-][a-z0-9]+)*$/),
    message: z.string().min(1).max(1_000)
  })
  .strict();

export type JobFailure = z.infer<typeof jobFailureSchema>;

export const jobLeaseSchema = z
  .object({
    id: z.string().uuid(),
    workerId: z.string().min(1).max(200),
    expiresAt: z.string().datetime()
  })
  .strict();

export type JobLease = z.infer<typeof jobLeaseSchema>;

export const enqueueJobSchema = z
  .object({
    jobId: z.string().uuid(),
    type: jobTypeSchema,
    payload: jsonValueSchema.default({}),
    idempotencyScope: z.string().min(1).max(200).regex(/^[^\u0000-\u001f\u007f]+$/),
    idempotencyKey: z.string().min(1).max(200).regex(/^[^\u0000-\u001f\u007f]+$/),
    maxAttempts: z.number().int().min(1).max(20).default(3),
    timeoutMs: z.number().int().min(100).max(24 * 60 * 60 * 1_000).default(15 * 60 * 1_000)
  })
  .strict();

export type EnqueueJobInput = z.input<typeof enqueueJobSchema>;
export type EnqueueJob = z.output<typeof enqueueJobSchema>;

export const jobRecordSchema = z
  .object({
    id: z.string().uuid(),
    type: jobTypeSchema,
    payload: jsonValueSchema,
    idempotencyScope: z.string().min(1).max(200).regex(/^[^\u0000-\u001f\u007f]+$/),
    idempotencyKey: z.string().min(1).max(200).regex(/^[^\u0000-\u001f\u007f]+$/),
    requestDigest: z.string().regex(/^[a-f0-9]{64}$/),
    state: jobStateSchema,
    progressPercent: z.number().int().min(0).max(100),
    itemReports: z.array(jobItemReportSchema).max(10_000),
    attempt: z.number().int().nonnegative(),
    maxAttempts: z.number().int().min(1).max(20),
    timeoutMs: z.number().int().min(100).max(24 * 60 * 60 * 1_000),
    availableAt: z.string().datetime(),
    lease: jobLeaseSchema.nullable(),
    failure: jobFailureSchema.nullable(),
    result: jsonValueSchema,
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
    startedAt: z.string().datetime().nullable(),
    finishedAt: z.string().datetime().nullable()
  })
  .strict();

export type JobRecord = z.infer<typeof jobRecordSchema>;
export type LeasedJob = JobRecord & { state: "running"; lease: JobLease };
