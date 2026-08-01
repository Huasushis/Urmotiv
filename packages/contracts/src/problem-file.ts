import { z } from "zod";

/**
 * 这些枚举对应数据库里的文件用途。文件内容留在对象存储中；这里和 API 之间只传递元数据。
 */
export const storedFilePurposes = ["problem", "import_input", "export_output", "temporary"] as const;
export const storedFilePurposeSchema = z.enum(storedFilePurposes);
export type StoredFilePurpose = z.infer<typeof storedFilePurposeSchema>;

export const problemFileCategories = [
  "statement_image",
  "public_attachment",
  "internal_attachment",
  "testdata",
  "checker",
  "interactor",
  "answer_checker",
  "standard_solution"
] as const;
export const problemFileCategorySchema = z.enum(problemFileCategories);
export type ProblemFileCategory = z.infer<typeof problemFileCategorySchema>;

export const judgeProgramFileCategories = [
  "checker",
  "interactor",
  "answer_checker"
] as const satisfies readonly ProblemFileCategory[];
export const judgeProgramFileCategorySchema = z.enum(judgeProgramFileCategories);
export type JudgeProgramFileCategory = z.infer<typeof judgeProgramFileCategorySchema>;

const maximumDatabaseId = 9_223_372_036_854_775_807n;
const maximumInteger = 2_147_483_647;

export const databaseRecordIdSchema = z
  .string()
  .regex(/^(0|[1-9]\d*)$/, "数据库编号格式不正确。")
  .refine(
    (value) => /^(0|[1-9]\d*)$/.test(value) && BigInt(value) <= maximumDatabaseId,
    "数据库编号超出范围。"
  );

export const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/, "SHA-256 校验值格式不正确。");

export const fileOriginalNameSchema = z
  .string()
  .trim()
  .min(1, "文件名不能为空。")
  .max(500, "文件名过长。")
  .refine((name) => name !== "." && name !== "..", "文件名不能表示目录。")
  .refine((name) => !name.includes("/") && !name.includes("\\"), "文件名不能包含路径。")
  .refine((name) => !/[\u0000-\u001f\u007f]/.test(name), "文件名不能包含控制字符。");

export const mediaTypeSchema = z
  .string()
  .trim()
  .toLowerCase()
  .max(255, "文件类型过长。")
  .regex(
    /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/,
    "文件类型格式不正确。"
  );

/**
 * 存储键是服务端生成的相对位置，不是下载地址，也不会返回给普通页面。
 */
export const storageKeySchema = z
  .string()
  .min(1, "文件存储位置不能为空。")
  .max(1024, "文件存储位置过长。")
  .refine(
    (key) =>
      !/[\u0000-\u001f\u007f]/.test(key) &&
      !key.startsWith("/") &&
      !key.includes("\\") &&
      key.split("/").every((part) => part.length > 0 && part !== "." && part !== ".."),
    "文件存储位置不安全。"
  );

/**
 * 题目包内的逻辑路径只用于版本和导入导出映射，不用于直接拼接操作系统路径。
 */
export const problemLogicalPathSchema = z
  .string()
  .min(1, "题目内文件路径不能为空。")
  .max(1024, "题目内文件路径过长。")
  .refine(
    (path) =>
      !/[\u0000-\u001f\u007f]/.test(path) &&
      !path.startsWith("/") &&
      !path.includes("\\") &&
      path.split("/").every((part) => part.length > 0 && part !== "." && part !== ".."),
    "题目内文件路径不安全。"
  );

export const timestampSchema = z.string().datetime({ offset: true });

export const createStoredFileInputSchema = z
  .object({
    id: z.string().uuid(),
    purpose: storedFilePurposeSchema,
    storageKey: storageKeySchema,
    originalName: fileOriginalNameSchema,
    mediaType: mediaTypeSchema,
    byteSize: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    sha256: sha256Schema,
    createdByUserId: databaseRecordIdSchema,
    expiresAt: timestampSchema.nullable().optional()
  })
  .strict();

export type CreateStoredFileInput = z.infer<typeof createStoredFileInputSchema>;

export const storedFileRecordSchema = createStoredFileInputSchema
  .extend({
    expiresAt: timestampSchema.nullable(),
    deletedAt: timestampSchema.nullable(),
    createdAt: timestampSchema
  })
  .strict();

export type StoredFileRecord = z.infer<typeof storedFileRecordSchema>;

export const linkProblemRevisionFileInputSchema = z
  .object({
    revisionId: z.string().uuid(),
    fileId: z.string().uuid(),
    category: problemFileCategorySchema,
    logicalPath: problemLogicalPathSchema,
    position: z.number().int().min(0).max(maximumInteger)
  })
  .strict();

export type LinkProblemRevisionFileInput = z.infer<typeof linkProblemRevisionFileInputSchema>;

export const problemRevisionFileRecordSchema = storedFileRecordSchema
  .extend({
    revisionId: z.string().uuid(),
    category: problemFileCategorySchema,
    logicalPath: problemLogicalPathSchema,
    position: z.number().int().min(0).max(maximumInteger)
  })
  .strict();

export type ProblemRevisionFileRecord = z.infer<typeof problemRevisionFileRecordSchema>;

/** Metadata sent with a raw file upload. File bytes are deliberately not part of this JSON shape. */
export const uploadProblemFileInputSchema = z
  .object({
    expectedRevision: z.number().int().positive(),
    category: problemFileCategorySchema,
    logicalPath: problemLogicalPathSchema,
    position: z.number().int().min(0).max(maximumInteger).default(0),
    originalName: fileOriginalNameSchema,
    mediaType: mediaTypeSchema,
    replaceExisting: z.boolean().default(false),
    bindJudgeProgram: z.boolean().default(false)
  })
  .strict();

export type UploadProblemFileInput = z.infer<typeof uploadProblemFileInputSchema>;

/**
 * 上传接口的正文是文件本身，所以这些说明字段放在网址参数里。网址参数都是文本，
 * 这里先把数字和开关转换成正确类型，再套用与 JSON 相同的规则。
 */
export const uploadProblemFileQuerySchema = z
  .object({
    expectedRevision: z.coerce.number().int().positive(),
    category: problemFileCategorySchema,
    logicalPath: problemLogicalPathSchema,
    position: z.coerce.number().int().min(0).max(maximumInteger).default(0),
    originalName: fileOriginalNameSchema,
    mediaType: mediaTypeSchema,
    replaceExisting: z
      .enum(["true", "false"])
      .default("false")
      .transform((value) => value === "true"),
    bindJudgeProgram: z
      .enum(["true", "false"])
      .default("false")
      .transform((value) => value === "true")
  })
  .strict();

export type UploadProblemFileQuery = z.output<typeof uploadProblemFileQuerySchema>;

export const removeProblemFileInputSchema = z
  .object({ expectedRevision: z.number().int().positive() })
  .strict();

export type RemoveProblemFileInput = z.infer<typeof removeProblemFileInputSchema>;

/** Safe for API responses: it intentionally excludes the internal storage key. */
export const problemFileSummarySchema = z
  .object({
    id: z.string().uuid(),
    category: problemFileCategorySchema,
    logicalPath: problemLogicalPathSchema,
    position: z.number().int().min(0).max(maximumInteger),
    originalName: fileOriginalNameSchema,
    mediaType: mediaTypeSchema,
    byteSize: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    sha256: sha256Schema,
    createdAt: timestampSchema
  })
  .strict();

export type ProblemFileSummary = z.infer<typeof problemFileSummarySchema>;

export const problemFileListResponseSchema = z
  .object({ items: z.array(problemFileSummarySchema) })
  .strict();

export type ProblemFileListResponse = z.infer<typeof problemFileListResponseSchema>;
