import { z } from "zod";
import { difficultyLevelSchema, userSummarySchema } from "./problem";

export const contestStates = ["draft", "locked", "archived"] as const;
export const contestStateSchema = z.enum(contestStates);
export type ContestState = z.infer<typeof contestStateSchema>;

export const contestMemberRoles = ["participant", "manager"] as const;
export const contestMemberRoleSchema = z.enum(contestMemberRoles);
export type ContestMemberRole = z.infer<typeof contestMemberRoleSchema>;

export const contestMemberInputSchema = z.object({
  userId: z.string().regex(/^(0|[1-9]\d*)$/),
  role: contestMemberRoleSchema
});

export const contestProblemInputSchema = z.object({
  problemId: z.string().regex(/^[1-9]\d*$/),
  score: z.number().int().min(1).max(1_000_000),
  estimatedDifficulty: difficultyLevelSchema.nullable().default(null)
});

export type ContestProblemInput = z.infer<typeof contestProblemInputSchema>;

const contestFieldsSchema = z.object({
  title: z.string().trim().min(1, "请填写组题方案名称").max(200),
  description: z.string().max(20_000).default(""),
  startsAt: z.string().datetime().nullable().default(null),
  endsAt: z.string().datetime().nullable().default(null),
  members: z.array(contestMemberInputSchema).max(2_000).default([]),
  problems: z.array(contestProblemInputSchema).min(1).max(100)
});

function hasValidTimeRange(input: {
  startsAt?: string | null | undefined;
  endsAt?: string | null | undefined;
}): boolean {
  return input.startsAt == null || input.endsAt == null || input.endsAt > input.startsAt;
}

export const createContestInputSchema = contestFieldsSchema.refine(hasValidTimeRange, {
  path: ["endsAt"],
  message: "结束时间必须晚于开始时间"
});

export const updateContestInputSchema = contestFieldsSchema.partial().extend({
  state: contestStateSchema.optional(),
  expectedUpdatedAt: z.string().datetime()
}).refine(hasValidTimeRange, {
  path: ["endsAt"],
  message: "结束时间必须晚于开始时间"
});

export type CreateContestInput = z.infer<typeof createContestInputSchema>;
export type UpdateContestInput = z.infer<typeof updateContestInputSchema>;

export const contestMemberSchema = z.object({
  user: userSummarySchema,
  role: contestMemberRoleSchema
});

export type ContestMember = z.infer<typeof contestMemberSchema>;

export const contestLeakRiskEntrySchema = z.object({
  user: userSummarySchema,
  firstAccessedAt: z.string().datetime(),
  lastAccessedAt: z.string().datetime(),
  totalActiveSeconds: z.number().int().nonnegative()
});

export const contestProblemSchema = z.object({
  position: z.number().int().nonnegative(),
  problemId: z.string(),
  revisionId: z.string().uuid(),
  revision: z.number().int().positive(),
  title: z.string(),
  score: z.number().int().positive(),
  estimatedDifficulty: difficultyLevelSchema.nullable(),
  leakRiskCount: z.number().int().nonnegative(),
  leakRiskEntries: z.array(contestLeakRiskEntrySchema)
});

export type ContestProblem = z.infer<typeof contestProblemSchema>;

export const contestCapabilitiesSchema = z.object({
  canEdit: z.boolean(),
  canDelete: z.boolean(),
  canExport: z.boolean(),
  canReadRisk: z.boolean()
});

export const contestSchema = z.object({
  id: z.string(),
  title: z.string(),
  description: z.string(),
  state: contestStateSchema,
  startsAt: z.string().datetime().nullable(),
  endsAt: z.string().datetime().nullable(),
  creator: userSummarySchema,
  members: z.array(contestMemberSchema),
  problems: z.array(contestProblemSchema),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  capabilities: contestCapabilitiesSchema
});

export type Contest = z.infer<typeof contestSchema>;

export const contestListItemSchema = contestSchema.pick({
  id: true,
  title: true,
  state: true,
  startsAt: true,
  endsAt: true,
  creator: true,
  createdAt: true,
  updatedAt: true,
  capabilities: true
}).extend({
  problemCount: z.number().int().nonnegative(),
  participantCount: z.number().int().nonnegative(),
  leakRiskCount: z.number().int().nonnegative()
});

export type ContestListItem = z.infer<typeof contestListItemSchema>;

export const contestListResponseSchema = z.object({
  items: z.array(contestListItemSchema)
});

export type ContestListResponse = z.infer<typeof contestListResponseSchema>;

export const problemAccessHeartbeatInputSchema = z.object({
  activeSeconds: z.number().int().min(1).max(60)
});

export const problemAccessRecordSchema = z.object({
  user: userSummarySchema,
  firstAccessedAt: z.string().datetime(),
  lastAccessedAt: z.string().datetime(),
  totalActiveSeconds: z.number().int().nonnegative(),
  lastRevision: z.number().int().positive()
});

export type ProblemAccessRecord = z.infer<typeof problemAccessRecordSchema>;

export const problemAccessListResponseSchema = z.object({
  items: z.array(problemAccessRecordSchema)
});

export type ProblemAccessListResponse = z.infer<typeof problemAccessListResponseSchema>;
