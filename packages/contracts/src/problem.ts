import { z } from "zod";
export type { ProblemTag } from "./tag";
export { tagSchema } from "./tag";

export const problemTypes = ["traditional", "interactive", "submit_answer"] as const;
export const problemStatuses = ["draft", "pending_review", "approved", "rejected"] as const;

export const problemTypeSchema = z.enum(problemTypes);
export const problemStatusSchema = z.enum(problemStatuses);

export type ProblemType = z.infer<typeof problemTypeSchema>;
export type ProblemStatus = z.infer<typeof problemStatusSchema>;

export const markdownSchema = z.string().max(500_000);
export const difficultyLevelSchema = z.number().int().min(1).max(5);
export const codeforcesDifficultySchema = z.number().int().min(800).max(3500).multipleOf(100);

export const problemFilePathSchema = z
  .string()
  .min(1)
  .max(240)
  .refine(
    (path) =>
      !path.startsWith("/") &&
      !path.includes("\\") &&
      path.split("/").every((segment) => segment.length > 0 && segment !== "." && segment !== ".."),
    "文件路径不安全。"
  );

export const judgeScoringModes = ["sum", "min", "max"] as const;
export const judgeScoringModeSchema = z.enum(judgeScoringModes);

const judgeProgramSchema = z.object({
  source: problemFilePathSchema
}).strict();

const judgeCheckerSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("standard") }).strict(),
  z.object({ type: z.literal("special"), source: problemFilePathSchema }).strict()
]);

export const problemJudgeConfigSchema = z
  .object({
    version: z.literal(1),
    limits: z
      .object({
        timeMs: z.number().int().positive().max(600_000),
        memoryMiB: z.number().int().positive().max(262_144)
      })
      .strict(),
    scoring: z
      .object({
        total: z.number().int().positive().max(100_000),
        subtaskMode: judgeScoringModeSchema
      })
      .strict(),
    subtasks: z
      .array(
        z
          .object({
            id: z.number().int().nonnegative(),
            score: z.number().int().nonnegative(),
            method: judgeScoringModeSchema,
            dependsOn: z.array(z.number().int().nonnegative()).max(1_000).default([])
          })
          .strict()
      )
      .max(1_000)
      .default([]),
    testcases: z
      .array(
        z
          .object({
            id: z.string().trim().min(1).max(120),
            input: problemFilePathSchema,
            output: problemFilePathSchema.optional(),
            subtaskId: z.number().int().nonnegative().optional(),
            score: z.number().int().nonnegative(),
            timeMs: z.number().int().positive().max(600_000).optional(),
            memoryMiB: z.number().int().positive().max(262_144).optional()
          })
          .strict()
      )
      .max(10_000)
      .default([]),
    checker: judgeCheckerSchema.optional(),
    interactor: judgeProgramSchema.optional(),
    answerChecker: judgeProgramSchema.optional()
  })
  .strict()
  .superRefine((config, context) => {
    const ids = new Set<number>();
    for (const subtask of config.subtasks) {
      if (ids.has(subtask.id)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["subtasks"],
          message: "子任务编号不能重复。"
        });
      }
      ids.add(subtask.id);
    }

    for (const subtask of config.subtasks) {
      if (subtask.dependsOn.includes(subtask.id) || subtask.dependsOn.some((id) => !ids.has(id))) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["subtasks"],
          message: "子任务依赖必须指向其他已有子任务。"
        });
      }
    }

    const dependencies = new Map(
      config.subtasks.map((subtask) => [subtask.id, subtask.dependsOn] as const)
    );
    const visiting = new Set<number>();
    const visited = new Set<number>();
    let hasDependencyCycle = false;
    const visitDependency = (id: number): void => {
      if (visited.has(id) || hasDependencyCycle) {
        return;
      }
      if (visiting.has(id)) {
        hasDependencyCycle = true;
        return;
      }
      visiting.add(id);
      for (const dependency of dependencies.get(id) ?? []) {
        if (dependencies.has(dependency)) {
          visitDependency(dependency);
        }
      }
      visiting.delete(id);
      visited.add(id);
    };
    for (const id of dependencies.keys()) {
      visitDependency(id);
    }
    if (hasDependencyCycle) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["subtasks"],
        message: "子任务的依赖关系不能形成循环。"
      });
    }

    if (config.interactor !== undefined && config.answerChecker !== undefined) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["interactor"],
        message: "交互程序和答案判断程序不能同时设置。"
      });
    }

    const testcaseIds = new Set<string>();
    for (const testcase of config.testcases) {
      if (testcaseIds.has(testcase.id)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["testcases"],
          message: "数据点编号不能重复。"
        });
      }
      testcaseIds.add(testcase.id);
      if (testcase.subtaskId !== undefined && !ids.has(testcase.subtaskId)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["testcases"],
          message: "数据点引用了不存在的子任务。"
        });
      }
    }

    if (config.subtasks.length > 0) {
      const total = config.subtasks.reduce((sum, subtask) => sum + subtask.score, 0);
      if (total !== config.scoring.total) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["scoring", "total"],
          message: "子任务分值之和必须等于总分。"
        });
      }
    } else if (config.testcases.length > 0) {
      const total = config.testcases.reduce((sum, testcase) => sum + testcase.score, 0);
      if (total !== config.scoring.total) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["scoring", "total"],
          message: "没有子任务时，数据点分值之和必须等于总分。"
        });
      }
    }
  });

export type ProblemJudgeConfig = z.infer<typeof problemJudgeConfigSchema>;

export const problemContentSchema = z.object({
  basicStatement: markdownSchema,
  basicSolution: markdownSchema.nullable(),
  background: markdownSchema.default(""),
  statement: markdownSchema.default(""),
  inputFormat: markdownSchema.default(""),
  outputFormat: markdownSchema.default(""),
  constraints: markdownSchema.default(""),
  solution: markdownSchema.default(""),
  hints: markdownSchema.default("")
});

export type ProblemContent = z.infer<typeof problemContentSchema>;

export const sampleSchema = z.object({
  id: z.string().uuid(),
  input: z.string().max(100_000),
  output: z.string().max(100_000),
  explanation: markdownSchema.default("")
});

export type ProblemSample = z.infer<typeof sampleSchema>;

export const problemDraftSchema = z.object({
  title: z.string().trim().min(1, "请填写题目名称").max(200),
  type: problemTypeSchema,
  tagIds: z.array(z.string().min(1).max(120)).min(1, "请至少选择一个知识点").max(30),
  codeforcesDifficulty: codeforcesDifficultySchema.nullable().default(null),
  thinkingLevel: difficultyLevelSchema.nullable().default(null),
  codingLevel: difficultyLevelSchema.nullable().default(null),
  content: problemContentSchema,
  samples: z.array(sampleSchema).max(50).default([]),
  judgeConfig: problemJudgeConfigSchema.nullable().default(null)
});

export type ProblemDraft = z.infer<typeof problemDraftSchema>;

export const createProblemInputSchema = problemDraftSchema.partial({
  content: true,
  samples: true,
  judgeConfig: true
}).extend({
  title: z.string().trim().min(1, "请填写题目名称").max(200),
  type: problemTypeSchema.default("traditional")
});

export type CreateProblemInput = z.infer<typeof createProblemInputSchema>;

export const updateProblemInputSchema = problemDraftSchema.partial().extend({
  expectedRevision: z.number().int().positive()
});

export type UpdateProblemInput = z.infer<typeof updateProblemInputSchema>;

/**
 * 强制修改冻结字段的专用接口：只能携带基础题面/基础题解两个冻结字段，
 * 必须填写原因。题目名称不在其中——名称永远走普通编辑接口。
 */
export const forceFrozenFieldEditInputSchema = z
  .object({
    expectedRevision: z.number().int().positive(),
    reason: z.string().trim().min(1, "必须填写修改原因").max(1_000),
    content: z
      .object({
        basicStatement: markdownSchema.optional(),
        basicSolution: markdownSchema.optional()
      })
      .strict()
  })
  .strict()
  .refine(
    (input) =>
      input.content.basicStatement !== undefined || input.content.basicSolution !== undefined,
    { path: ["content"], message: "至少要修改基础题面或基础题解中的一个冻结字段。" }
  );

export type ForceFrozenFieldEditInput = z.infer<typeof forceFrozenFieldEditInputSchema>;

export const submitProblemInputSchema = z.object({
  expectedRevision: z.number().int().positive()
});

export const withdrawProblemInputSchema = z.object({
  expectedRevision: z.number().int().positive(),
  reason: z.string().trim().max(500).default("")
});

export const deleteProblemInputSchema = z.object({
  expectedRevision: z.number().int().positive()
}).strict();

export const problemCapabilitiesSchema = z.object({
  canView: z.boolean(),
  canEdit: z.boolean(),
  canEditTitle: z.boolean(),
  canEditFrozen: z.boolean(),
  canSubmit: z.boolean(),
  canWithdraw: z.boolean(),
  canReview: z.boolean(),
  canChangeStatus: z.boolean(),
  canReadTestdata: z.boolean(),
  canWriteTestdata: z.boolean(),
  canExport: z.boolean(),
  canViewAccessLog: z.boolean(),
  canDelete: z.boolean().optional()
});

export type ProblemCapabilities = z.infer<typeof problemCapabilitiesSchema>;

export const userSummarySchema = z.object({
  id: z.string(),
  nickname: z.string(),
  accountType: z.enum(["human", "robot"])
});

export type UserSummary = z.infer<typeof userSummarySchema>;

export const problemMetadataSchema = z.object({
  origin: z.string().trim().min(1).max(100).optional(),
  importBatch: z.string().trim().max(200).nullable().optional(),
  importSource: z.string().trim().max(200).nullable().optional()
});

export const problemSchema = problemDraftSchema.extend({
  id: z.string(),
  status: problemStatusSchema,
  owner: userSummarySchema,
  revision: z.number().int().positive(),
  reviewRound: z.number().int().nonnegative(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  ...problemMetadataSchema.shape,
  capabilities: problemCapabilitiesSchema
});

export type Problem = z.infer<typeof problemSchema>;

export const problemListItemSchema = problemSchema.pick({
  id: true,
  title: true,
  type: true,
  status: true,
  codeforcesDifficulty: true,
  thinkingLevel: true,
  codingLevel: true,
  tagIds: true,
  owner: true,
  revision: true,
  reviewRound: true,
  updatedAt: true,
  capabilities: true,
  origin: true,
  importBatch: true,
  importSource: true
});

export type ProblemListItem = z.infer<typeof problemListItemSchema>;

export const problemListResponseSchema = z.object({
  items: z.array(problemListItemSchema),
  total: z.number().int().nonnegative(),
  page: z.number().int().positive(),
  pageSize: z.number().int().positive()
});

export type ProblemListResponse = z.infer<typeof problemListResponseSchema>;

export const problemListQuerySchema = z.object({
  page: z.coerce.number().int().positive().default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
  search: z.string().trim().max(200).default(""),
  status: problemStatusSchema.optional(),
  type: problemTypeSchema.optional(),
  owner: z.enum(["me", "all"]).default("all"),
  sort: z.enum(["updated_desc", "updated_asc", "difficulty_asc", "difficulty_desc"]).default("updated_desc"),
  origin: z.string().trim().max(100).optional(),
  batch: z.string().trim().max(200).optional(),
  source: z.string().trim().max(200).optional()
});
export type ProblemListQuery = z.infer<typeof problemListQuerySchema>;

export const batchProblemStatusActions = ["submit", "approve", "reject", "withdraw"] as const;
export const batchProblemStatusActionSchema = z.enum(batchProblemStatusActions);
export type BatchProblemStatusAction = z.infer<typeof batchProblemStatusActionSchema>;

export const batchProblemStatusItemSchema = z
  .object({
    id: z.string().trim().min(1).max(200),
    expectedRevision: z.number().int().positive(),
    expectedRound: z.number().int().nonnegative()
  })
  .strict();

export const batchProblemStatusInputSchema = z
  .object({
    action: batchProblemStatusActionSchema,
    items: z.array(batchProblemStatusItemSchema).min(1).max(200),
    reason: z.string().trim().max(2_000).default("")
  })
  .strict()
  .superRefine((input, context) => {
    const seen = new Set<string>();
    for (const [index, item] of input.items.entries()) {
      if (seen.has(item.id)) {
        context.addIssue({
          code: "custom",
          path: ["items", index, "id"],
          message: "同一道题不能在一次批量操作中重复出现。"
        });
      }
      seen.add(item.id);
    }
    if (input.action !== "submit" && input.reason.length === 0) {
      context.addIssue({
        code: "custom",
        path: ["reason"],
        message: "请填写批量状态变更理由。"
      });
    }
    if (
      (input.action === "approve" || input.action === "reject") &&
      input.items.some((item) => item.expectedRound < 1)
    ) {
      context.addIssue({
        code: "custom",
        path: ["items"],
        message: "人工终审必须指定当前审核轮次。"
      });
    }
  });

export type BatchProblemStatusInput = z.infer<typeof batchProblemStatusInputSchema>;

export const batchProblemStatusSuccessSchema = z
  .object({
    id: z.string(),
    ok: z.literal(true),
    status: problemStatusSchema,
    revision: z.number().int().positive()
  })
  .strict();

export const batchProblemStatusFailureSchema = z
  .object({
    id: z.string(),
    ok: z.literal(false),
    code: z.string().min(1).max(80),
    message: z.string().min(1).max(500)
  })
  .strict();

export const batchProblemStatusResponseSchema = z
  .object({
    results: z.array(
      z.discriminatedUnion("ok", [
        batchProblemStatusSuccessSchema,
        batchProblemStatusFailureSchema
      ])
    )
  })
  .strict();

export type BatchProblemStatusResponse = z.infer<typeof batchProblemStatusResponseSchema>;
