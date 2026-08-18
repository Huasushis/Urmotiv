import { z } from "zod";
import { canonicalProblemSchema, isSafeArchivePath } from "@urmotiv/problem-package";

export const historyContentDigestSchema = z
  .string()
  .regex(/^[0-9a-f]{64}$/, "内容摘要必须是 64 位小写十六进制文本。");

export const historySourceIdSchema = z
  .string()
  .regex(/^source-[0-9]{6}$/, "源文件安全编号格式不正确。");

export const historyCandidateIdSchema = z
  .string()
  .regex(/^candidate-[0-9]{6}$/, "候选安全编号格式不正确。");

export const historyMetadataRecordSchema = z
  .object({
    number: z.string().trim().min(1).max(200),
    name: z.string().trim().min(1).max(500),
    authorStudentId: z.string().trim().max(200).default(""),
    status: z.string().max(500).default(""),
    contest: z.string().max(500).default(""),
    note: z.string().max(10_000).default(""),
  })
  .strict();

export const historyMetadataFileSchema = z
  .object({
    records: z.array(historyMetadataRecordSchema).min(1).max(10_000),
  })
  .strict()
  .superRefine((value, context) => {
    addDuplicateIssues(
      value.records.map((record) => record.number),
      context,
      ["records"],
      "元数据题号重复，必须先人工消除歧义。",
    );
  });

const confirmedSourcePathSchema = z
  .string()
  .min(1)
  .max(240)
  .refine((value) => isSafeArchivePath(value), "源文件路径不安全。")
  .refine(
    (value) => /\.(?:md|txt)$/i.test(value),
    "第一阶段只读取已经人工分组的 Markdown 或纯文本文件。",
  );

export const historySourceMappingSchema = z
  .object({
    version: z.literal(1),
    confirmed: z.literal(true),
    metadataFileSha256: historyContentDigestSchema,
    mappings: z
      .array(
        z
          .object({
            sourcePath: confirmedSourcePathSchema,
            sourceSha256: historyContentDigestSchema,
            metadataNumber: z.string().trim().min(1).max(200),
          })
          .strict(),
      )
      .min(1)
      .max(10_000),
  })
  .strict()
  .superRefine((value, context) => {
    addDuplicateIssues(
      value.mappings.map((mapping) => mapping.sourcePath.toLocaleLowerCase("en-US")),
      context,
      ["mappings"],
      "同一个源文件不能被重复分配。",
    );
    addDuplicateIssues(
      value.mappings.map((mapping) => mapping.metadataNumber),
      context,
      ["mappings"],
      "同一条元数据不能分配给多个源文件。",
    );
  });

const normalizedHistoryProblemSchema = z
  .object({
    title: z.string().min(1).max(200),
    type: z.enum(["traditional", "interactive", "submit_answer"]),
    basicStatement: z.string().min(1).max(500_000),
    basicSolution: z.string().max(500_000).nullable(),
    background: z.string().max(500_000),
    statement: z.string().max(500_000),
    inputFormat: z.string().max(500_000),
    outputFormat: z.string().max(500_000),
    constraints: z.string().max(500_000),
    solution: z.string().max(500_000),
    hints: z.string().max(500_000),
    samples: z
      .array(
        z
          .object({
            input: z.string().max(100_000),
            output: z.string().max(100_000),
            explanation: z.string().max(500_000),
          })
          .strict(),
      )
      .max(50),
    tags: z.array(z.string().min(1).max(120)).max(0, "历史整理模型不能自行选择知识点标签。"),
    confidence: z.number().min(0).max(1),
    migrationNote: z.string().max(10_000),
  })
  .strict();

export const normalizedHistoryOutputSchema = z
  .object({
    problems: z.array(normalizedHistoryProblemSchema).min(1).max(30),
  })
  .strict();

export const historyCandidateProblemSchema = canonicalProblemSchema.superRefine(
  (problem, context) => {
    if (problem.files.length > 0) {
      context.addIssue({
        code: "custom",
        path: ["files"],
        message: "第一阶段候选内容不能直接加入附件或评测文件。",
      });
    }
    if (problem.judge !== undefined) {
      context.addIssue({
        code: "custom",
        path: ["judge"],
        message: "第一阶段候选内容不能直接加入评测配置。",
      });
    }
    if (Object.keys(problem.difficulty).length > 0) {
      context.addIssue({
        code: "custom",
        path: ["difficulty"],
        message: "历史迁移候选不能采用投题者自填或人工写入的难度。",
      });
    }
    if (Object.keys(problem.extensions).length > 0) {
      context.addIssue({
        code: "custom",
        path: ["extensions"],
        message: "历史迁移候选不能写入私有元数据或其他扩展字段。",
      });
    }
    if (
      problem.provenance?.sourceProblemId !== undefined ||
      problem.provenance?.sourceRevision !== undefined
    ) {
      context.addIssue({
        code: "custom",
        path: ["provenance"],
        message: "题目包不能包含历史题号或原始修订编号。",
      });
    }
  },
);

export const historyCandidateRecordSchema = z
  .object({
    version: z.literal(1),
    candidateId: historyCandidateIdSchema,
    sourceId: historySourceIdSchema,
    sourceContentSha256: historyContentDigestSchema,
    sourceMappingSha256: historyContentDigestSchema,
    sourceBindingSha256: historyContentDigestSchema.optional(),
    contentSha256: historyContentDigestSchema,
    modelConfidence: z.number().min(0).max(1),
    normalizationNote: z.string().max(10_000),
    problem: historyCandidateProblemSchema,
  })
  .strict();

export const historyCandidateApprovalSchema = z
  .object({
    version: z.literal(1),
    confirmed: z.literal(true),
    approvals: z
      .array(
        z
          .object({
            candidateId: historyCandidateIdSchema,
            contentSha256: historyContentDigestSchema,
            decision: z.literal("approved"),
          })
          .strict(),
      )
      .min(1)
      .max(10_000),
  })
  .strict()
  .superRefine((value, context) => {
    addDuplicateIssues(
      value.approvals.map((approval) => approval.candidateId),
      context,
      ["approvals"],
      "同一个候选不能重复批准。",
    );
  });

export const historyRepairManifestSchema = z
  .object({
    version: z.literal(1),
    receipts: z
      .array(
        z
          .object({
            sourceId: historySourceIdSchema,
            sourcePath: confirmedSourcePathSchema,
            sourceSha256: historyContentDigestSchema,
            metadataNumber: z.string().trim().min(1).max(200),
            /** 失败回执（requests/<sourceId>.failed.json 解析后）的整体内容摘要。 */
            failedReceiptSha256: historyContentDigestSchema,
          })
          .strict(),
      )
      .length(9, "受控本地源文修复必须恰好选择九个失败回执。")
      .superRefine((value, context) => {
        addDuplicateIssues(
          value.map((receipt) => receipt.sourceId),
          context,
          ["receipts"],
          "同一份源文件的失败回执不能重复修复。",
        );
      }),
  })
  .strict();

export const historySourceSelectionSchema = z
  .object({
    version: z.literal(1),
    confirmed: z.literal(true),
    sourceIds: z.array(historySourceIdSchema).min(1).max(10_000),
  })
  .strict()
  .superRefine((value, context) => {
    addDuplicateIssues(value.sourceIds, context, ["sourceIds"], "同一份源文件不能重复选择。");
  });

export type HistorySourceSelection = z.infer<typeof historySourceSelectionSchema>;
export type HistoryRepairManifest = z.infer<typeof historyRepairManifestSchema>;
export type HistoryMetadataRecord = z.infer<typeof historyMetadataRecordSchema>;
export type HistoryMetadataFile = z.infer<typeof historyMetadataFileSchema>;
export type HistorySourceMapping = z.infer<typeof historySourceMappingSchema>;
export type NormalizedHistoryOutput = z.infer<typeof normalizedHistoryOutputSchema>;
export type NormalizedHistoryProblem = NormalizedHistoryOutput["problems"][number];
export type HistoryCandidateRecord = z.infer<typeof historyCandidateRecordSchema>;
export type HistoryCandidateApproval = z.infer<typeof historyCandidateApprovalSchema>;

function addDuplicateIssues(
  values: readonly string[],
  context: z.RefinementCtx,
  path: readonly (string | number)[],
  message: string,
): void {
  const seen = new Set<string>();
  for (const [index, value] of values.entries()) {
    if (seen.has(value)) {
      context.addIssue({
        code: "custom",
        path: [...path, index],
        message,
      });
    }
    seen.add(value);
  }
}
