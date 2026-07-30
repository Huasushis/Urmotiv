import { z } from "zod";
import { sha256Schema } from "./problem-file";

/**
 * 题目包导入导出接口的共享数据结构。这些结构只携带任务编号、状态、计数和给用户看的
 * 提示文字；题面、题解和文件内容永远不通过任务记录传递。
 */

export const packageFormatIdSchema = z
  .string()
  .trim()
  .min(1)
  .max(160)
  .regex(/^[a-z0-9]+(?:[._-][a-z0-9]+)*$/, "格式编号不正确。");

export const transferIdempotencyKeySchema = z
  .string()
  .trim()
  .min(1)
  .max(160)
  .regex(/^\S+$/, "请求编号不能包含空白字符。");

/** 与题目包内部使用的文件类别一致；`asset` 表示题面引用的图片等资源。 */
export const packageFileCategories = [
  "asset",
  "testdata",
  "checker",
  "interactor",
  "answer_checker",
  "standard_solution",
  "public_attachment",
  "internal_attachment"
] as const;

export const packageFileCategorySchema = z.enum(packageFileCategories);
export type PackageFileCategory = z.infer<typeof packageFileCategorySchema>;

export const packageDetectionSchema = z
  .object({
    formatId: packageFormatIdSchema,
    displayName: z.string().min(1).max(120),
    confidence: z.number().min(0).max(1),
    reason: z.string().max(500)
  })
  .strict();

export const packageUploadResponseSchema = z
  .object({
    fileId: z.string().uuid(),
    sha256: sha256Schema,
    byteSize: z.number().int().nonnegative(),
    expiresAt: z.string().datetime({ offset: true }),
    detected: z.array(packageDetectionSchema).max(20)
  })
  .strict();

export type PackageUploadResponse = z.infer<typeof packageUploadResponseSchema>;

export const importPreviewRequestSchema = z
  .object({
    fileId: z.string().uuid(),
    formatId: packageFormatIdSchema
  })
  .strict();

export type ImportPreviewRequest = z.infer<typeof importPreviewRequestSchema>;

export const importIssueSchema = z
  .object({
    severity: z.enum(["error", "warning", "info"]),
    path: z.string().max(500).optional(),
    message: z.string().min(1).max(2_000)
  })
  .strict();

export const importPreviewResponseSchema = z
  .object({
    formatId: packageFormatIdSchema,
    problemCount: z.number().int().min(0).max(1_000),
    title: z.string().max(200).optional(),
    files: z.array(z.string().max(500)).max(10_000),
    issues: z.array(importIssueSchema).max(1_000)
  })
  .strict();

export type ImportPreviewResponse = z.infer<typeof importPreviewResponseSchema>;

export const createImportJobRequestSchema = z
  .object({
    fileId: z.string().uuid(),
    sha256: sha256Schema,
    formatId: packageFormatIdSchema,
    idempotencyKey: transferIdempotencyKeySchema
  })
  .strict();

export type CreateImportJobRequest = z.infer<typeof createImportJobRequestSchema>;

export const transferJobPhaseSchema = z.enum([
  "queued",
  "reading",
  "converting",
  "writing",
  "completed",
  "failed",
  "blocked"
]);

export const transferJobStateSchema = z.enum([
  "queued",
  "running",
  "succeeded",
  "failed",
  "cancelled"
]);

export const transferFailureSchema = z
  .object({
    code: z.string().min(1).max(120),
    message: z.string().min(1).max(1_000)
  })
  .strict();

export const importJobItemViewSchema = z
  .object({
    position: z.number().int().min(0),
    state: transferJobStateSchema,
    importedProblemId: z.string().nullable(),
    failure: transferFailureSchema.nullable()
  })
  .strict();

export const importJobViewSchema = z
  .object({
    id: z.string().uuid(),
    state: transferJobStateSchema,
    progressPercent: z.number().int().min(0).max(100),
    phase: transferJobPhaseSchema,
    completedItems: z.number().int().min(0),
    failedItems: z.number().int().min(0),
    failure: transferFailureSchema.nullable(),
    items: z.array(importJobItemViewSchema).max(1_000),
    createdAt: z.string().datetime(),
    finishedAt: z.string().datetime().nullable()
  })
  .strict();

export type ImportJobView = z.infer<typeof importJobViewSchema>;

export const exportSelectionRequestSchema = z
  .object({
    problemId: z.string().regex(/^[1-9]\d*$/, "题目编号不正确。"),
    includeFileCategories: z.array(packageFileCategorySchema).max(8).default([])
  })
  .strict();

export const exportPreviewRequestSchema = z
  .object({
    targetFormat: packageFormatIdSchema,
    problems: z.array(exportSelectionRequestSchema).min(1).max(100)
  })
  .strict()
  .superRefine((value, context) => {
    if (new Set(value.problems.map((problem) => problem.problemId)).size !== value.problems.length) {
      context.addIssue({
        code: "custom",
        path: ["problems"],
        message: "同一道题不能重复选择。"
      });
    }
  });

export type ExportPreviewRequest = z.infer<typeof exportPreviewRequestSchema>;

export const lossItemViewSchema = z
  .object({
    severity: z.enum(["error", "choice", "warning", "info"]),
    path: z.string().max(500),
    message: z.string().min(1).max(2_000)
  })
  .strict();

export const exportPreviewProblemSchema = z
  .object({
    problemId: z.string(),
    /** 找不到或没有权限的题目统一标记为不存在，不返回标题。 */
    status: z.enum(["ready", "blocked", "not_found"]),
    title: z.string().max(200).optional(),
    revisionId: z.string().uuid().optional(),
    items: z.array(lossItemViewSchema).max(200)
  })
  .strict();

export const exportPreviewResponseSchema = z
  .object({
    targetFormat: packageFormatIdSchema,
    canExport: z.boolean(),
    problems: z.array(exportPreviewProblemSchema).max(100)
  })
  .strict();

export type ExportPreviewResponse = z.infer<typeof exportPreviewResponseSchema>;

export const createExportJobRequestSchema = z
  .object({
    targetFormat: packageFormatIdSchema,
    problems: z
      .array(
        exportSelectionRequestSchema
          .extend({ revisionId: z.string().uuid().optional() })
          .strict()
      )
      .min(1)
      .max(100),
    idempotencyKey: transferIdempotencyKeySchema
  })
  .strict()
  .superRefine((value, context) => {
    if (new Set(value.problems.map((problem) => problem.problemId)).size !== value.problems.length) {
      context.addIssue({
        code: "custom",
        path: ["problems"],
        message: "同一道题不能重复选择。"
      });
    }
  });

export type CreateExportJobRequest = z.infer<typeof createExportJobRequestSchema>;

export const exportJobViewSchema = z
  .object({
    id: z.string().uuid(),
    state: transferJobStateSchema,
    progressPercent: z.number().int().min(0).max(100),
    phase: transferJobPhaseSchema,
    targetFormat: packageFormatIdSchema,
    problemCount: z.number().int().min(1).max(100),
    resultReady: z.boolean(),
    resultExpiresAt: z.string().datetime().nullable(),
    failure: transferFailureSchema.nullable(),
    createdAt: z.string().datetime(),
    finishedAt: z.string().datetime().nullable()
  })
  .strict();

export type ExportJobView = z.infer<typeof exportJobViewSchema>;
