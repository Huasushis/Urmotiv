import { z } from "zod";
import { codeforcesDifficultySchema, difficultyLevelSchema, userSummarySchema } from "./problem";
import { pluginSettingsFormSchema, pluginSettingsSchema } from "./plugin";

export const reviewVerdicts = ["approve", "request_changes", "reject"] as const;
export const reviewVerdictSchema = z.enum(reviewVerdicts);

export const reviewInputSchema = z.object({
  verdict: reviewVerdictSchema,
  codeforcesDifficulty: codeforcesDifficultySchema,
  qualityLevel: difficultyLevelSchema,
  thinkingLevel: difficultyLevelSchema,
  codingLevel: difficultyLevelSchema,
  tagIds: z.array(z.string().min(1).max(120)).max(30).default([]),
  improvements: z.string().trim().min(1, "请填写主要改进点").max(20_000),
  privateNote: z.string().trim().max(20_000).default(""),
  expectedRound: z.number().int().positive()
});

export type ReviewInput = z.infer<typeof reviewInputSchema>;

export const reviewSchema = reviewInputSchema.extend({
  id: z.string(),
  problemId: z.string(),
  reviewer: userSummarySchema,
  source: z.enum(["human", "anklang", "fermata", "plugin"]),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime()
});

export type Review = z.infer<typeof reviewSchema>;

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
