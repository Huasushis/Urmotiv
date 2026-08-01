import type { DatabaseExecutor, DatabaseHandle } from "@urmotiv/database";
import { sql } from "drizzle-orm";
import { z } from "zod";

const databaseIdSchema = z.string().regex(/^(0|[1-9]\d*)$/);
const uuidSchema = z.string().uuid();
const formatIdSchema = z.string().trim().min(1).max(120);

const sharedEventFields = {
  actorUserId: databaseIdSchema,
  requestId: uuidSchema,
  result: z.literal("success"),
  reasonCode: z.null()
} as const;

export const problemPackageAuditEventSchema = z.discriminatedUnion("action", [
  z
    .object({
      ...sharedEventFields,
      action: z.literal("problem.package.upload"),
      objectType: z.literal("stored_file"),
      objectId: uuidSchema,
      metadata: z
        .object({
          inputKind: z.enum(["zip", "single_file"])
        })
        .strict()
    })
    .strict(),
  z
    .object({
      ...sharedEventFields,
      action: z.literal("problem.package.import.preview"),
      objectType: z.literal("stored_file"),
      objectId: uuidSchema,
      metadata: z
        .object({
          formatId: formatIdSchema,
          problemCount: z.number().int().min(0).max(1_000),
          issueCount: z.number().int().min(0).max(1_000)
        })
        .strict()
    })
    .strict(),
  z
    .object({
      ...sharedEventFields,
      action: z.literal("problem.package.import.create"),
      objectType: z.literal("import_job"),
      objectId: uuidSchema,
      metadata: z
        .object({
          formatId: formatIdSchema,
          itemCount: z.number().int().min(1).max(1_000)
        })
        .strict()
    })
    .strict(),
  z
    .object({
      ...sharedEventFields,
      action: z.literal("problem.package.import.item.complete"),
      objectType: z.literal("problem"),
      objectId: databaseIdSchema,
      metadata: z
        .object({
          importJobId: uuidSchema,
          position: z.number().int().min(0).max(999)
        })
        .strict()
    })
    .strict(),
  z
    .object({
      ...sharedEventFields,
      action: z.literal("problem.package.export.preview"),
      objectType: z.literal("problem_package"),
      objectId: z.null(),
      metadata: z
        .object({
          formatId: formatIdSchema,
          problemCount: z.number().int().min(1).max(100),
          canExport: z.boolean()
        })
        .strict()
    })
    .strict(),
  z
    .object({
      ...sharedEventFields,
      action: z.literal("problem.package.export.create"),
      objectType: z.literal("export_job"),
      objectId: uuidSchema,
      metadata: z
        .object({
          formatId: formatIdSchema,
          problemCount: z.number().int().min(1).max(100)
        })
        .strict()
    })
    .strict(),
  z
    .object({
      ...sharedEventFields,
      action: z.literal("problem.package.export.complete"),
      objectType: z.literal("export_job"),
      objectId: uuidSchema,
      metadata: z
        .object({
          formatId: formatIdSchema,
          outputFileCount: z.number().int().min(0).max(10_000)
        })
        .strict()
    })
    .strict(),
  z
    .object({
      ...sharedEventFields,
      action: z.literal("problem.package.export.download"),
      objectType: z.literal("export_job"),
      objectId: uuidSchema,
      metadata: z.object({}).strict()
    })
    .strict()
]);

export type ProblemPackageAuditEvent = z.input<typeof problemPackageAuditEventSchema>;

export interface ProblemPackageAuditWriter {
  append(
    event: ProblemPackageAuditEvent,
    executor?: DatabaseExecutor
  ): Promise<void>;
}

/**
 * Indicates that the immutable operation record could not be saved. The error
 * intentionally carries no database details, file names, paths, or problem data.
 */
export class ProblemPackageAuditWriteError extends Error {
  public constructor() {
    super("题目包操作记录暂时无法保存。");
    this.name = "ProblemPackageAuditWriteError";
  }
}

export class DatabaseProblemPackageAuditWriter implements ProblemPackageAuditWriter {
  public constructor(private readonly database: DatabaseHandle) {}

  public async append(
    rawEvent: ProblemPackageAuditEvent,
    executor: DatabaseExecutor = this.database
  ): Promise<void> {
    const event = problemPackageAuditEventSchema.parse(rawEvent);
    try {
      await executor.execute(sql`
        INSERT INTO audit_events (
          actor_user_id, request_id, action, object_type, object_id,
          result, reason_code, metadata
        ) VALUES (
          ${BigInt(event.actorUserId)}, ${event.requestId}::uuid, ${event.action},
          ${event.objectType}, ${event.objectId}, ${event.result}, ${event.reasonCode},
          ${JSON.stringify(event.metadata)}::jsonb
        )
      `);
    } catch {
      throw new ProblemPackageAuditWriteError();
    }
  }
}
