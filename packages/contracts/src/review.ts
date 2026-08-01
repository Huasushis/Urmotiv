import { z } from "zod";
import { codeforcesDifficultySchema, difficultyLevelSchema, userSummarySchema } from "./problem";
import { pluginSettingsFormSchema, pluginSettingsSchema } from "./plugin";

export const reviewVerdicts = ["approve", "request_changes", "reject"] as const;
export const reviewVerdictSchema = z.enum(reviewVerdicts);

export const reviewInputSchema = z.object({
  verdict: reviewVerdictSchema,
  codeforcesDifficulty: codeforcesDifficultySchema,
  qualityLevel: difficultyLevelSchema,
  // v1 robot clients did not send this field. The API requires it for human
  // submissions while keeping an omitted legacy value distinguishable as null.
  originalityLevel: difficultyLevelSchema.nullable().optional(),
  thinkingLevel: difficultyLevelSchema,
  codingLevel: difficultyLevelSchema,
  tagIds: z.array(z.string().min(1).max(120)).max(30).default([]),
  improvements: z.string().trim().min(1, "请填写主要改进点").max(20_000),
  publicComment: z.string().trim().max(20_000).optional(),
  privateNote: z.string().trim().max(20_000).default(""),
  expectedRound: z.number().int().positive()
});

export type ReviewInput = z.infer<typeof reviewInputSchema>;

export const reviewSchema = reviewInputSchema.extend({
  originalityLevel: difficultyLevelSchema.nullable(),
  publicComment: z.string().trim().max(20_000),
  id: z.string(),
  problemId: z.string(),
  reviewer: userSummarySchema,
  source: z.enum(["human", "anklang", "fermata", "plugin"]),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime()
});

export type Review = z.infer<typeof reviewSchema>;

export const reviewSuggestionFields = [
  "codeforcesDifficulty",
  "thinkingLevel",
  "codingLevel",
  "tagIds"
] as const;

export const reviewSuggestionFieldSchema = z.enum(reviewSuggestionFields);
export type ReviewSuggestionField = z.infer<typeof reviewSuggestionFieldSchema>;

export const reviewSuggestionViewSchema = z
  .object({
    round: z.number().int().positive(),
    opinionCount: z.number().int().positive(),
    current: z
      .object({
        codeforcesDifficulty: codeforcesDifficultySchema.nullable(),
        thinkingLevel: difficultyLevelSchema.nullable(),
        codingLevel: difficultyLevelSchema.nullable(),
        tagIds: z.array(z.string().min(1).max(120)).max(30)
      })
      .strict(),
    suggested: z
      .object({
        codeforcesDifficulty: codeforcesDifficultySchema,
        thinkingLevel: difficultyLevelSchema,
        codingLevel: difficultyLevelSchema,
        tagIds: z.array(z.string().min(1).max(120)).max(30),
        qualityLevel: difficultyLevelSchema,
        originalityLevel: difficultyLevelSchema.nullable()
      })
      .strict(),
    canApply: z.boolean()
  })
  .strict();

export type ReviewSuggestionView = z.infer<typeof reviewSuggestionViewSchema>;

export const applyReviewSuggestionsInputSchema = z
  .object({
    expectedRound: z.number().int().positive(),
    expectedRevision: z.number().int().positive(),
    fields: z.array(reviewSuggestionFieldSchema).min(1).max(reviewSuggestionFields.length)
  })
  .strict()
  .superRefine((value, context) => {
    const seen = new Set<ReviewSuggestionField>();
    value.fields.forEach((field, index) => {
      if (seen.has(field)) {
        context.addIssue({
          code: "custom",
          message: "同一个建议字段不能重复选择。",
          path: ["fields", index]
        });
      }
      seen.add(field);
    });
  });

export type ApplyReviewSuggestionsInput = z.infer<typeof applyReviewSuggestionsInputSchema>;

export const reviewRoundSummarySchema = z.object({
  round: z.number().int().positive(),
  reviews: z.array(reviewSchema),
  approvals: z.number().int().nonnegative(),
  blockingReviews: z.number().int().nonnegative(),
  requiredApprovals: z.number().int().positive().nullable(),
  status: z.enum(["waiting", "approved", "rejected", "withdrawn"]),
  ruleId: z.string().min(1).max(160),
  decisionAvailable: z.boolean(),
  decisionReason: z.string().max(2_000).nullable(),
  decisionSource: z.enum(["rule", "manual", "withdrawal"]).nullable()
});

export type ReviewRoundSummary = z.infer<typeof reviewRoundSummarySchema>;

const reviewRuleIdSchema = z
  .string()
  .min(1)
  .max(160)
  .regex(/^[a-z0-9]+(?:[._-][a-z0-9]+)*$/);

export const availableReviewRuleSchema = z.object({
  id: reviewRuleIdSchema,
  displayName: z.string().trim().min(1).max(120),
  pluginVersion: z.string().trim().min(1).max(80),
  settingsSchema: pluginSettingsFormSchema.nullable()
}).strict();

export type AvailableReviewRule = z.infer<typeof availableReviewRuleSchema>;

export const reviewPolicyViewSchema = z.object({
  selectedRuleId: reviewRuleIdSchema,
  selectedPluginVersion: z.string().trim().min(1).max(80),
  settings: pluginSettingsSchema,
  revision: z.number().int().positive(),
  selectedRuleAvailable: z.boolean(),
  availableRules: z.array(availableReviewRuleSchema).max(100)
}).strict();

export type ReviewPolicyView = z.infer<typeof reviewPolicyViewSchema>;

export const updateReviewPolicyInputSchema = z.object({
  ruleId: reviewRuleIdSchema,
  settings: pluginSettingsSchema,
  expectedRevision: z.number().int().positive()
}).strict();

export type UpdateReviewPolicyInput = z.infer<typeof updateReviewPolicyInputSchema>;

export const manualReviewDecisionInputSchema = z.object({
  decision: z.enum(["approve", "reject"]),
  reason: z.string().trim().min(1, "请填写人工终审理由。").max(2_000),
  expectedRound: z.number().int().positive(),
  expectedRevision: z.number().int().positive()
}).strict();

export type ManualReviewDecisionInput = z.infer<typeof manualReviewDecisionInputSchema>;
