import { z } from "zod";
import { problemContentSchema, problemTypeSchema } from "./problem";
import { reviewInputSchema } from "./review";
import { reviewItemSourceSchema, reviewItemVisibilitySchema } from "./review-item";

const contentHashSchema = z.string().regex(/^[a-f0-9]{64}$/);
export const robotAnklangPluginId = "org.ustc.urmotiv.anklang" as const;

const robotReviewItemSchema = z
  .object({
    id: z.string().min(1).max(200),
    type: z.string().min(1).max(160),
    source: reviewItemSourceSchema,
    sourcePluginId: z.string().min(1).max(160).nullable(),
    visibility: reviewItemVisibilitySchema,
    summary: z.string().max(1_000),
    data: z.unknown(),
    contentHash: contentHashSchema,
    expiresAt: z.string().datetime({ offset: true }).nullable(),
    createdAt: z.string().datetime()
  })
  .strict()
  .superRefine((value, context) => {
    if (value.source === "anklang" && value.sourcePluginId !== robotAnklangPluginId) {
      context.addIssue({
        code: "custom",
        path: ["sourcePluginId"],
        message: "Anklang 审核条目必须来自内置 Anklang 插件。"
      });
    }
  });

const robotSampleSchema = z
  .object({
    safeId: z.string().regex(/^sample-[0-9]{3}$/),
    input: z.string().max(100_000),
    output: z.string().max(100_000),
    explanation: z.string().max(500_000)
  })
  .strict();
const robotTagCatalogSchema = z
  .object({
    version: z.number().int().positive(),
    tags: z
      .array(
        z
          .object({
            id: z.string().min(1).max(120),
            name: z.string().min(1).max(80),
            categoryId: z.string().min(1).max(120),
            categoryName: z.string().min(1).max(80),
            description: z.string().max(2_000),
            aliases: z.array(z.string().min(1).max(160)).max(100),
            active: z.literal(true)
          })
          .strict()
      )
      .min(1)
      .max(10_000)
  })
  .strict();
const robotReviewInputSchema = reviewInputSchema.extend({
  tagIds: z.array(z.string().min(1).max(120)).min(1).max(30)
});

export const robotReviewTaskSchema = z
  .object({
    assignmentId: z.string().uuid(),
    leaseExpiresAt: z.string().datetime(),
    problem: z
      .object({
        id: z.string().min(1).max(200),
        revision: z.number().int().positive(),
        reviewRound: z.number().int().positive(),
        contentHash: contentHashSchema,
        title: z.string().trim().min(1).max(200),
        type: problemTypeSchema,
        tagIds: z.array(z.string().min(1).max(120)).min(1).max(30),
        content: problemContentSchema.strict(),
        samples: z.array(robotSampleSchema).max(50),
        limits: z
          .object({
            timeMs: z.number().int().positive().max(600_000),
            memoryMiB: z.number().int().positive().max(262_144)
          })
          .strict()
          .nullable()
      })
      .strict(),
    tagCatalog: robotTagCatalogSchema,
    reviewItems: z.array(robotReviewItemSchema).max(1_000).default([])
  })
  .strict();

export type RobotReviewTask = z.infer<typeof robotReviewTaskSchema>;

export const claimRobotReviewTasksInputSchema = z
  .object({
    maximumTasks: z.number().int().min(1).max(10).default(1),
    leaseSeconds: z.number().int().min(30).max(1_800).default(300),
    supportedProblemTypes: z.array(problemTypeSchema).min(1).max(3).optional()
  })
  .strict();

export type ClaimRobotReviewTasksInput = z.infer<typeof claimRobotReviewTasksInputSchema>;

export const claimRobotReviewTasksResponseSchema = z
  .object({ items: z.array(robotReviewTaskSchema).max(10) })
  .strict();

export const renewRobotReviewTaskInputSchema = z
  .object({
    requestId: z.string().uuid(),
    expectedLeaseExpiresAt: z.string().datetime(),
    leaseSeconds: z.number().int().min(30).max(1_800).default(300)
  })
  .strict();

export const renewRobotReviewTaskResponseSchema = z
  .object({ assignmentId: z.string().uuid(), leaseExpiresAt: z.string().datetime() })
  .strict();

export const completeRobotReviewTaskInputSchema = z
  .object({
    requestId: z.string().uuid(),
    expectedLeaseExpiresAt: z.string().datetime(),
    expectedProblemRevision: z.number().int().positive(),
    expectedTagCatalogVersion: z.number().int().positive(),
    experimentVersion: z.string().trim().min(1).max(120),
    modelProfileName: z.string().trim().min(1).max(120),
    review: robotReviewInputSchema
  })
  .strict();

export type CompleteRobotReviewTaskInput = z.infer<typeof completeRobotReviewTaskInputSchema>;

export const robotReviewTaskCompletionSchema = z
  .object({
    assignmentId: z.string().uuid(),
    accepted: z.literal(true),
    problemStatus: z.enum(["pending_review", "approved", "rejected"])
  })
  .strict();

export const fermataHealthSchema = z
  .object({
    status: z.enum(["ok", "degraded"]),
    service: z.literal("fermata"),
    apiVersion: z.literal("1"),
    workerRunning: z.boolean(),
    activeTasks: z.number().int().nonnegative(),
    checkedAt: z.string().datetime()
  })
  .strict();

export type FermataHealth = z.infer<typeof fermataHealthSchema>;

export const fermataPublicSettingsSchema = z
  .object({
    enabled: z.boolean(),
    pollingIntervalSeconds: z.number().int().min(5).max(3_600),
    maximumConcurrentTasks: z.number().int().min(1).max(32),
    modelProfileName: z.string().trim().min(1).max(120),
    experimentVersion: z.string().trim().min(1).max(120)
  })
  .strict();

export type FermataPublicSettings = z.infer<typeof fermataPublicSettingsSchema>;

export const fermataPublicSettingsResponseSchema = z
  .object({
    settings: fermataPublicSettingsSchema,
    revision: z.number().int().positive(),
    secretsConfigured: z.boolean()
  })
  .strict();

export const updateFermataPublicSettingsInputSchema = z
  .object({
    expectedRevision: z.number().int().positive(),
    settings: fermataPublicSettingsSchema
  })
  .strict();

export type UpdateFermataPublicSettingsInput = z.infer<typeof updateFermataPublicSettingsInputSchema>;
