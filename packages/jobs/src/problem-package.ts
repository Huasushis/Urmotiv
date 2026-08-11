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
const adapterVersionSchema = z
  .string()
  .trim()
  .min(1)
  .max(80)
  .regex(/^[0-9A-Za-z]+(?:[._+-][0-9A-Za-z]+)*$/);

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
  "import_access_revoked",
  "import_write_failed",
  "export_access_revoked",
  "export_source_missing",
  "export_file_missing",
  "export_source_integrity",
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
  import_access_revoked: "当前已没有导入题目包的权限。",
  import_write_failed: "保存导入题目时失败，未保留不完整题目。",
  export_access_revoked: "当前已没有导出所需的题目或文件权限。",
  export_source_missing: "固定的题目版本已不可读取。",
  export_file_missing: "固定版本中的文件已不可读取。",
  export_source_integrity: "固定版本中的文件内容与登记信息不一致。",
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
    clientRequestDigest: sha256Schema,
    sourceFileId: uuidSchema,
    inputDigest: sha256Schema,
    detectedFormat: identifierSchema.nullable().optional(),
    selectedFormat: identifierSchema,
    selectedFormatVersion: adapterVersionSchema,
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
    clientRequestDigest: sha256Schema,
    targetFormat: identifierSchema,
    targetFormatVersion: adapterVersionSchema,
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
    clientRequestDigest: sha256Schema.nullable(),
    sourceFileId: uuidSchema,
    inputDigest: sha256Schema,
    detectedFormat: identifierSchema.nullable(),
    selectedFormat: identifierSchema,
    selectedFormatVersion: adapterVersionSchema,
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
    executionAttempt: z.number().int().min(0),
    leaseId: uuidSchema.nullable(),
    leaseExpiresAt: z.string().datetime().nullable(),
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
    clientRequestDigest: sha256Schema.nullable(),
    targetFormat: identifierSchema,
    targetFormatVersion: adapterVersionSchema,
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

export const problemPackageJobReplayLookupSchema = z
  .object({
    requestedByUserId: databaseIdSchema,
    idempotencyKey: idempotencyKeySchema
  })
  .strict();

export type ProblemPackageJobReplayLookup = z.infer<
  typeof problemPackageJobReplayLookupSchema
>;

export const problemPackageJobReplayClaimSchema = problemPackageJobReplayLookupSchema
  .extend({ clientRequestDigest: sha256Schema })
  .strict();

export type ProblemPackageJobReplayClaim = z.infer<
  typeof problemPackageJobReplayClaimSchema
>;

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

/**
 * 回查结果：已提交任务 + 持久化审计身份 + 持久化条目身份/位置。
 * 用于在创建响应丢失后验证全部绑定身份（审计绑定、条目链接、位置）。
 */
export interface ImportJobReplayResult {
  readonly job: ProblemPackageImportJob;
  readonly auditRequestId: string | undefined;
  readonly items: readonly ProblemPackageImportItem[];
}

/** API-side extension used only to recover a committed create request. */
export interface ProblemPackageJobReplayStore {
  findImportJobForReplay(
    input: ProblemPackageJobReplayClaim
  ): Promise<ImportJobReplayResult | undefined>;
  findExportJobForReplay(
    input: ProblemPackageJobReplayLookup
  ): Promise<ProblemPackageExportJob | undefined>;
}

/**
 * 历史导入恢复/认领接口。
 *
 * 这是 ProblemPackageJobStore 的历史导入专用围栏扩展，不属于通用队列。
 * 它原子地认领或恢复一个导入任务，根据当前状态返回不同的认领结果：
 * - queued/never-started：认领并设为 running
 * - running with active lease：繁忙（另一个进程正在执行）
 * - running with expired lease：收回（递增 attempt，发新 lease token）
 * - failed with no committed item：安全重置并认领
 * - succeeded 或任何 item 有 imported_problem_id：重建结果
 * - cancelled：失败关闭
 */
export interface HistoryImportRecoveryStore {
  /**
   * 原子地认领或恢复一个导入任务。返回认领结果或 undefined 表示任务不存在。
   *
   * 调用方提供 leaseDurationMs 决定租约过期时间。如果任务正在被另一个活跃
   * 租约持有（lease_expires_at > now），返回 busy 而不修改任务。
   */
  claimOrRecoverImportJob(input: {
    readonly jobId: string;
    readonly leaseDurationMs: number;
  }): Promise<HistoryImportJobClaim | undefined>;

  /**
   * 续租当前持有的租约。必须提供当前 leaseId。
   * 如果租约已被收回（leaseId 不匹配），返回 false。
   */
  renewImportJobLease(input: {
    readonly jobId: string;
    readonly leaseId: string;
    readonly leaseDurationMs: number;
  }): Promise<boolean>;

  /**
   * 围栏完成导入任务：只有持有未过期租约者才能完成。
   * 租约不匹配或已过期时返回 false。
   */
  fencedCompleteImportJob(input: {
    readonly jobId: string;
    readonly leaseId: string;
    readonly report: ProblemPackageJobReport;
  }): Promise<boolean>;

  /**
   * 围栏标记导入任务失败：只有持有未过期租约者才能标记失败。
   * 租约不匹配或已过期时返回 false。
   */
  fencedFailImportJob(input: {
    readonly jobId: string;
    readonly leaseId: string;
    readonly position: number;
    readonly code: ProblemPackageFailureCode;
    readonly report: ProblemPackageJobReport;
  }): Promise<boolean>;
}

export type HistoryImportJobClaim =
  | { readonly kind: "claimed"; readonly job: ProblemPackageImportJob; readonly leaseId: string }
  | { readonly kind: "busy" }
  | {
      readonly kind: "reconstruct";
      readonly job: ProblemPackageImportJob;
      readonly items: readonly ProblemPackageImportItem[];
    }
  | { readonly kind: "cancelled" };

/**
 * 统一历史导入任务存储：job + replay + recovery 三接口的编译期安全交集。
 * 历史导入流程要求同一个对象同时实现全部三个接口，杜绝 Partial 类型转换。
 * DatabaseProblemPackageJobStore 与 InMemoryProblemPackageJobStore 均实现此接口。
 */
export interface HistoryImportJobStore
  extends ProblemPackageJobStore,
    ProblemPackageJobReplayStore,
    HistoryImportRecoveryStore {}

export interface ProblemPackageTaskInput {
  readonly jobId: string;
  readonly requestedByUserId: string;
  readonly signal?: AbortSignal;
}

export function isJsonValue(value: unknown): value is JsonValue {
  return jsonValueSchema.safeParse(value).success;
}
