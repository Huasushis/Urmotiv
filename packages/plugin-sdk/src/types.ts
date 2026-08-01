import {
  codeforcesDifficultySchema,
  difficultyLevelSchema,
  problemTypeSchema,
  reviewVerdictSchema
} from "@urmotiv/contracts";
import { z } from "zod";

export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { readonly [key: string]: JsonValue };

const jsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.null(),
    z.array(jsonValueSchema),
    z.record(z.string(), jsonValueSchema)
  ])
);

export const pluginApiVersion = "1" as const;

export const pluginIdSchema = z
  .string()
  .min(3)
  .max(160)
  .regex(/^[a-z0-9]+(?:[.-][a-z0-9]+)+$/);

export const pluginManifestSchema = z
  .object({
    id: pluginIdSchema,
    name: z.string().trim().min(1).max(120),
    version: z.string().regex(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/),
    apiVersion: z.literal(pluginApiVersion),
    serverEntry: z.string().min(1).max(240).optional(),
    workerEntry: z.string().min(1).max(240).optional(),
    webEntry: z.string().min(1).max(240).optional(),
    permissions: z.array(pluginIdSchema).max(100).default([]),
    settingsSchema: z.string().min(1).max(240).optional()
  })
  .strict();

export type PluginManifest = z.infer<typeof pluginManifestSchema>;

export const reviewItemVisibilities = ["author", "reviewer", "admin"] as const;

export const reviewItemInputSchema = z
  .object({
    type: pluginIdSchema,
    visibility: z.enum(reviewItemVisibilities),
    summary: z.string().trim().min(1).max(1_000),
    data: z.unknown(),
    contentHash: z.string().regex(/^[a-f0-9]{64}$/),
    expiresAt: z.string().datetime().optional()
  })
  .strict();

export type ReviewItemInput = z.infer<typeof reviewItemInputSchema>;

export const reviewItemSchema = reviewItemInputSchema
  .extend({
    id: z.string().min(1).max(200),
    source: z
      .object({
        kind: z.enum(["plugin", "robot", "human"]),
        id: z.string().min(1).max(200)
      })
      .strict(),
    createdAt: z.string().datetime()
  })
  .strict();

export type ReviewItem = z.infer<typeof reviewItemSchema>;

export const beforeSubmitInputSchema = z
  .object({
    problemId: z.string().min(1).max(200),
    revision: z.number().int().positive(),
    reviewRound: z.number().int().positive(),
    contentHash: z.string().regex(/^[a-f0-9]{64}$/),
    problem: z
      .object({
        title: z.string().trim().min(1).max(200),
        type: problemTypeSchema,
        tagIds: z.array(z.string().min(1).max(120)).min(1).max(30),
        basicStatement: z.string().min(1).max(500_000),
        basicSolution: z.string().min(1).max(500_000)
      })
      .strict()
  })
  .strict();

export type BeforeSubmitInput = z.infer<typeof beforeSubmitInputSchema>;

export const beforeSubmitResultSchema = z.discriminatedUnion("decision", [
  z
    .object({
      decision: z.literal("continue"),
      reviewItems: z.array(reviewItemInputSchema).max(100).optional()
    })
    .strict(),
  z
    .object({
      decision: z.literal("block"),
      code: z.string().min(1).max(160).regex(/^[a-z0-9]+(?:[._-][a-z0-9]+)*$/),
      message: z.string().trim().min(1).max(2_000),
      details: jsonValueSchema.optional()
    })
    .strict()
]);

export type BeforeSubmitResult = z.infer<typeof beforeSubmitResultSchema>;

export interface BeforeSubmitCheckContext {
  readonly signal: AbortSignal;
}

export interface BeforeSubmitCheck {
  readonly id: string;
  readonly displayName: string;
  readonly timeoutMs: number;
  readonly failureBehavior: "block" | "continue";
  run(
    input: BeforeSubmitInput,
    context: BeforeSubmitCheckContext
  ): Promise<BeforeSubmitResult> | BeforeSubmitResult;
}

export const reviewOpinionSchema = z
  .object({
    id: z.string().min(1).max(200),
    reviewRound: z.number().int().positive(),
    reviewerId: z.string().min(1).max(200),
    reviewerAccountType: z.enum(["human", "robot"]),
    verdict: reviewVerdictSchema,
    codeforcesDifficulty: codeforcesDifficultySchema,
    qualityLevel: difficultyLevelSchema,
    thinkingLevel: difficultyLevelSchema,
    codingLevel: difficultyLevelSchema,
    tagIds: z.array(z.string().min(1).max(120)).max(30),
    improvements: z.string().trim().min(1).max(20_000),
    source: z.enum(["human", "anklang", "fermata", "plugin"]),
    reviewerCanReview: z.boolean(),
    updatedAt: z.string().datetime()
  })
  .strict();

export type ReviewOpinion = z.infer<typeof reviewOpinionSchema>;

export const reviewRoundSnapshotSchema = z
  .object({
    problemId: z.string().min(1).max(200),
    round: z.number().int().positive(),
    contentHash: z.string().regex(/^[a-f0-9]{64}$/),
    opinions: z.array(reviewOpinionSchema).max(10_000),
    reviewItems: z.array(reviewItemSchema).max(10_000).default([])
  })
  .strict();

export type ReviewRoundSnapshot = z.infer<typeof reviewRoundSnapshotSchema>;

export const reviewDecisionSchema = z
  .object({
    decision: z.enum(["pending", "approve", "reject"]),
    usedOpinionIds: z.array(z.string().min(1).max(200)).max(10_000),
    usedReviewItemIds: z.array(z.string().min(1).max(200)).max(10_000).default([]),
    reason: z.string().trim().min(1).max(2_000)
  })
  .strict();

export type ReviewDecision = z.infer<typeof reviewDecisionSchema>;

export interface ReviewDecisionRule<TSettings> {
  readonly id: string;
  readonly displayName: string;
  readonly supportedReviewItemTypes: readonly string[];
  readonly settingsSchema: z.ZodType<TSettings>;
  evaluate(
    input: ReviewRoundSnapshot,
    settings: TSettings
  ): Promise<ReviewDecision> | ReviewDecision;
}

export interface ReviewItemType<TData> {
  readonly type: string;
  readonly displayName: string;
  readonly dataSchema: z.ZodType<TData>;
}
