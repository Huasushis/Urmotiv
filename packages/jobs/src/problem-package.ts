import { z } from "zod";
import { jsonValueSchema, jobStateSchema, type JsonValue } from "./types";

/**
 * The task records in this file contain identifiers, counts and stable error
 * codes only. Package text and file bytes deliberately live behind injected
 * readers and writers instead of in a queue payload or task report.
 */

const identifierSchema = z
  .string()
  .trim()
  .min(1)
  .max(160)
  .regex(/^[a-z0-9]+(?:[._-][a-z0-9]+)*$/);

const databaseIdSchema = z.string().regex(/^(0|[1-9]\d*)$/);
const uuidSchema = z.string().uuid();
const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const idempotencyKeySchema = z.string().trim().min(1).max(160).regex(/^[^\u0000-\u001f\u007f]+$/);
const countSchema = z.number().int().min(0).max(10_000);
const progressSchema = z.number().int().min(0).max(100);

export const problemPackageFileCategories = [
  "asset",
  "testdata",
  "checker",
  "interactor",
  "answer_checker",
  "standard_solution",
  "public_attachment",
  "internal_attachment"
] as const;

export const problemPackageFileCategorySchema = z.enum(problemPackageFileCategories);

export type ProblemPackageFileCategory = z.infer<typeof problemPackageFileCategorySchema>;

export const problemPackageImportChoicesSchema = z
  .object({
    conflictAction: z.enum(["create", "update"]),
    targetProblemId: databaseIdSchema.optional(),
    values: z.record(z.string().min(1).max(120), jsonValueSchema).optional()
  })
  .strict()
  .superRefine((value, context) => {
    if (value.conflictAction === "update" && value.targetProblemId === undefined) {
      context.addIssue({
        code: "custom",
        path: ["targetProblemId"],
        message: "更新已有题目时必须固定目标题目编号。"
      });
    }
    if (value.conflictAction === "create" && value.targetProblemId !== undefined) {
      context.addIssue({
        code: "custom",
        path: ["targetProblemId"],
        message: "创建新题目时不能指定目标题目编号。"
      });
    }
  });

export type ProblemPackageImportChoices = z.infer<typeof problemPackageImportChoicesSchema>;

export const problemPackageExportSelectionSchema = z
  .object({
    problemId: databaseIdSchema,
    revisionId: uuidSchema,
    includedFileCategories: z.array(problemPackageFileCategorySchema).max(8)
  })
  .strict()
  .superRefine((value, context) => {
    if (new Set(value.includedFileCategories).size !== value.includedFileCategories.length) {
      context.addIssue({
        code: "custom",
        path: ["includedFileCategories"],
        message: "导出的文件类别不能重复。"
      });
    }
  });

export type ProblemPackageExportSelection = z.infer<typeof problemPackageExportSelectionSchema>;

/**
 * A shortened export warning. It gives the UI a useful status without putting
 * a problem's text, data-point bytes or private paths into a task record.
 */
export const problemPackageLossSummarySchema = z
  .object({
    targetFormat: identifierSchema,
    canExport: z.boolean(),
    errorCount: countSchema,
    choiceCount: countSchema,
    warningCount: countSchema,
    infoCount: countSchema
  })
  .strict();

export type ProblemPackageLossSummary = z.infer<typeof problemPackageLossSummarySchema>;

export const problemPackageJobPhases = [
  "queued",
  "reading",
  "converting",
  "writing",
  "completed",
  "failed",
  "blocked"
] as const;

export const problemPackageJobReportSchema = z
  .object({
    version: z.literal(1),
    phase: z.enum(problemPackageJobPhases),
    completedItems: countSchema,
    failedItems: countSchema,
    skippedItems: countSchema,
    outputFileCount: countSchema.optional()
  })
  .strict();

export type ProblemPackageJobReport = z.infer<typeof problemPackageJobReportSchema>;

export const problemPackageFailureCodes = [
  "source_unavailable",
  "source_digest_mismatch",
  "archive_rejected",
  "format_unavailable",
  "import_invalid",
  "import_write_failed",
  "export_access_revoked",
  "export_source_missing",
  "export_file_missing",
  "export_too_large",
  "export_not_confirmed",
  "export_write_failed",
  "cancelled",
  "internal_failure"
] as const;

export const problemPackageFailureCodeSchema = z.enum(problemPackageFailureCodes);
export type ProblemPackageFailureCode = z.infer<typeof problemPackageFailureCodeSchema>;

export interface ProblemPackageFailure {
  readonly code: ProblemPackageFailureCode;
  readonly message: string;
}

const failureMessages: Readonly<Record<ProblemPackageFailureCode, string>> = {
  source_unavailable: "无法读取导入文件。",
  source_digest_mismatch: "导入文件已改变或不完整。",
  archive_rejected: "题目包没有通过文件安全检查。",
  format_unavailable: "所选题目包格式当前不可用。",
  import_invalid: "题目包内容不符合所选格式。",
  import_write_failed: "保存导入题目时失败，未保留不完整题目。",
  export_access_revoked: "当前已没有导出所需的题目或文件权限。",
  export_source_missing: "固定的题目版本已不可读取。",
  export_file_missing: "固定版本中的文件已不可读取。",
  export_too_large: "所选题目资料超过当前一次导出的大小限制，请减少题目或分批导出。",
  export_not_confirmed: "当前导出选择还不能生成目标格式。",
  export_write_failed: "保存导出文件时失败。",
  cancelled: "任务已取消。",
  internal_failure: "任务处理失败。"
};

export function safeProblemPackageFailure(
  code: ProblemPackageFailureCode
): ProblemPackageFailure {
  return { code, message: failureMessages[code] };
}

export const createProblemPackageImportJobSchema = z
  .object({
    requestedByUserId: databaseIdSchema,
    sourceFileId: uuidSchema,
    inputDigest: sha256Schema,
    detectedFormat: identifierSchema.nullable().optional(),
    selectedFormat: identifierSchema,
    choices: problemPackageImportChoicesSchema,
    itemCount: z.number().int().min(1).max(1_000).default(1),
    idempotencyKey: idempotencyKeySchema,
    auditRequestId: uuidSchema.optional()
  })
  .strict();

export type CreateProblemPackageImportJob = z.input<typeof createProblemPackageImportJobSchema>;

export const createProblemPackageExportJobSchema = z
  .object({
    requestedByUserId: databaseIdSchema,
    targetFormat: identifierSchema,
    options: z.record(z.string().min(1).max(120), jsonValueSchema).default({}),
    lossSummary: problemPackageLossSummarySchema,
    problems: z.array(problemPackageExportSelectionSchema).min(1).max(100),
    idempotencyKey: idempotencyKeySchema,
    auditRequestId: uuidSchema.optional()
  })
  .strict()
  .superRefine((value, context) => {
    if (!value.lossSummary.canExport) {
      context.addIssue({
        code: "custom",
        path: ["lossSummary", "canExport"],
        message: "仍有阻止导出的项目，不能创建导出任务。"
      });
    }
    const problemIds = new Set(value.problems.map((problem) => problem.problemId));
    if (problemIds.size !== value.problems.length) {
      context.addIssue({
        code: "custom",
        path: ["problems"],
        message: "同一个导出任务不能重复选择同一道题。"
      });
    }
  });

export type CreateProblemPackageExportJob = z.input<typeof createProblemPackageExportJobSchema>;

export const problemPackageImportJobSchema = z
  .object({
    id: uuidSchema,
    requestedByUserId: databaseIdSchema,
    sourceFileId: uuidSchema,
    inputDigest: sha256Schema,
    detectedFormat: identifierSchema.nullable(),
    selectedFormat: identifierSchema,
    choices: problemPackageImportChoicesSchema,
    itemCount: z.number().int().min(1).max(1_000),
    state: jobStateSchema,
    progressPercent: progressSchema,
    report: problemPackageJobReportSchema,
    failure: z
      .object({ code: problemPackageFailureCodeSchema, message: z.string().min(1).max(1_000) })
      .strict()
      .nullable(),
    idempotencyKey: idempotencyKeySchema,
    startedAt: z.string().datetime().nullable(),
    finishedAt: z.string().datetime().nullable(),
    createdAt: z.string().datetime()
  })
  .strict();

export type ProblemPackageImportJob = z.infer<typeof problemPackageImportJobSchema>;

export const problemPackageImportItemSchema = z
  .object({
    jobId: uuidSchema,
    position: z.number().int().min(0).max(999),
    state: jobStateSchema,
    importedProblemId: databaseIdSchema.nullable(),
    failure: z
      .object({ code: problemPackageFailureCodeSchema, message: z.string().min(1).max(1_000) })
      .strict()
      .nullable(),
    finishedAt: z.string().datetime().nullable()
  })
  .strict();

export type ProblemPackageImportItem = z.infer<typeof problemPackageImportItemSchema>;

export const problemPackageExportJobSchema = z
  .object({
    id: uuidSchema,
    requestedByUserId: databaseIdSchema,
    targetFormat: identifierSchema,
    options: z.record(z.string(), jsonValueSchema),
    lossSummary: problemPackageLossSummarySchema,
    problems: z.array(problemPackageExportSelectionSchema).min(1).max(100),
    state: jobStateSchema,
    progressPercent: progressSchema,
    report: problemPackageJobReportSchema,
    resultFileId: uuidSchema.nullable(),
    resultExpiresAt: z.string().datetime().nullable(),
    failure: z
      .object({ code: problemPackageFailureCodeSchema, message: z.string().min(1).max(1_000) })
      .strict()
      .nullable(),
    idempotencyKey: idempotencyKeySchema,
    startedAt: z.string().datetime().nullable(),
    finishedAt: z.string().datetime().nullable(),
    createdAt: z.string().datetime()
  })
  .strict();

export type ProblemPackageExportJob = z.infer<typeof problemPackageExportJobSchema>;

export const importItemOutcomeSchema = z
  .object({
    state: z.enum(["succeeded", "failed", "skipped"]),
    importedProblemId: databaseIdSchema.optional(),
    failureCode: problemPackageFailureCodeSchema.optional()
  })
  .strict()
  .superRefine((value, context) => {
    if (value.state === "succeeded" && value.importedProblemId === undefined) {
      context.addIssue({
        code: "custom",
        path: ["importedProblemId"],
        message: "成功的导入项目必须保存题目编号。"
      });
    }
    if (value.state === "failed" && value.failureCode === undefined) {
      context.addIssue({
        code: "custom",
        path: ["failureCode"],
        message: "失败的导入项目必须保存稳定错误编号。"
      });
    }
    if (value.state !== "succeeded" && value.importedProblemId !== undefined) {
      context.addIssue({
        code: "custom",
        path: ["importedProblemId"],
        message: "未成功的导入项目不能保存题目编号。"
      });
    }
  });

export type ImportItemOutcome = z.infer<typeof importItemOutcomeSchema>;

export interface CompleteProblemPackageExport {
  readonly resultFileId: string;
  readonly resultExpiresAt: string;
  readonly outputFileCount: number;
}

/**
 * API storage implements this interface. The worker sees only immutable task
 * snapshots and safe status updates, never a database connection or a file
 * storage secret.
 */
export interface ProblemPackageJobStore {
  createImportJob(input: CreateProblemPackageImportJob): Promise<ProblemPackageImportJob>;
  createExportJob(input: CreateProblemPackageExportJob): Promise<ProblemPackageExportJob>;
  getImportJob(jobId: string): Promise<ProblemPackageImportJob | undefined>;
  getImportItems(jobId: string): Promise<readonly ProblemPackageImportItem[]>;
  getExportJob(jobId: string): Promise<ProblemPackageExportJob | undefined>;
  startImportJob(jobId: string): Promise<ProblemPackageImportJob | undefined>;
  startExportJob(jobId: string): Promise<ProblemPackageExportJob | undefined>;
  updateImportJob(jobId: string, progressPercent: number, report: ProblemPackageJobReport): Promise<void>;
  updateExportJob(jobId: string, progressPercent: number, report: ProblemPackageJobReport): Promise<void>;
  recordImportItem(jobId: string, position: number, outcome: ImportItemOutcome): Promise<void>;
  completeImportJob(jobId: string, report: ProblemPackageJobReport): Promise<void>;
  completeExportJob(jobId: string, result: CompleteProblemPackageExport): Promise<void>;
  failImportJob(jobId: string, code: ProblemPackageFailureCode, report: ProblemPackageJobReport): Promise<void>;
  failExportJob(jobId: string, code: ProblemPackageFailureCode): Promise<void>;
}

export interface ProblemPackageTaskInput {
  readonly jobId: string;
  readonly requestedByUserId: string;
  readonly signal?: AbortSignal;
}

export function isJsonValue(value: unknown): value is JsonValue {
  return jsonValueSchema.safeParse(value).success;
}
