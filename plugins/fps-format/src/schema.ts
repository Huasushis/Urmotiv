import { canonicalFileCategories } from "@urmotiv/problem-package";
import { z } from "zod";

/**
 * 固定核对的 FPS 上游提交：fps.current.dtd 在
 * https://github.com/zhblue/freeproblemset/commit/7782b3815fd40f5bba95d5d7b90e3fbefafae656
 * （2026-05-20，parent bd8df4a19bd8057fc24c27a94e9aa007e12b9703）中的内容。
 * 只把经过审阅并固定提交的格式定义作为只读依据；绝不读取或跟随包内 DOCTYPE 引用的地址，
 * 也绝不解析外部实体。“支持”只表示格式转换能力，不表示有权复制或再分发题面、数据或程序。
 */
export const fpsSupportedRevision = "fps-7782b381-2026-05-20" as const;

export const fpsAdapterId = "fps" as const;
export const fpsAdapterVersion = "0.1.0" as const;
export const fpsProblemMediaType = "application/xml" as const;

export const fpsTimeLimitUnits = ["ms", "s"] as const;
export const fpsMemoryLimitUnits = ["b", "kb", "mb", "gb"] as const;

export const fpsLanguageSchema = z.string().trim().min(1).max(80);

export const fpsProgramEntrySchema = z
  .object({
    language: z.string().trim().min(1).max(80).optional(),
    text: z.string().min(1).max(1_000_000)
  })
  .strict();

export type FpsProgramEntry = z.infer<typeof fpsProgramEntrySchema>;

export const fpsTestDataNamesSchema = z
  .object({
    inputNames: z.array(z.string().trim().min(1).max(120)).max(10_000),
    outputNames: z.array(z.string().trim().min(1).max(120)).max(10_000)
  })
  .strict();

export type FpsTestDataNames = z.infer<typeof fpsTestDataNamesSchema>;

/**
 * 来源标记信息：只有本适配器明确实现的 FPS 语义才写入这里，其余内容不进扩展。
 * 这些信息只用于再次导出 FPS 时恢复原样，不表示本站评测或编辑器会使用它们，
 * 也不能用扩展绕过丢失信息报告。
 */
export const fpsExtensionSchema = z
  .object({
    revision: z.literal(fpsSupportedRevision),
    solutions: z
      .array(z.object({ language: fpsLanguageSchema, text: z.string().min(1).max(1_000_000) }).strict())
      .max(10)
      .default([]),
    prepends: z.array(fpsProgramEntrySchema).max(10).default([]),
    templates: z.array(fpsProgramEntrySchema).max(10).default([]),
    appends: z.array(fpsProgramEntrySchema).max(10).default([]),
    spj: fpsProgramEntrySchema.optional(),
    tpj: fpsProgramEntrySchema.optional(),
    interactor: fpsProgramEntrySchema.optional(),
    testData: fpsTestDataNamesSchema.optional(),
    timeLimit: z.object({ raw: z.string().min(1).max(80), unit: z.string().min(1).max(20).optional() }).strict().optional(),
    memoryLimit: z.object({ raw: z.string().min(1).max(80), unit: z.string().min(1).max(20).optional() }).strict().optional(),
    source: z.string().trim().min(1).max(500).optional(),
    url: z.string().trim().min(1).max(2_000).optional(),
    remoteOj: z.string().trim().min(1).max(120).optional(),
    remoteId: z.string().trim().min(1).max(200).optional()
  })
  .strict();

export type FpsExtension = z.infer<typeof fpsExtensionSchema>;

export const fpsImportChoicesSchema = z
  .object({
    conflictAction: z.enum(["create", "update"]),
    targetProblemId: z.string().min(1).max(200).optional(),
    values: z.object({}).strict().optional()
  })
  .strict();

export const fpsExportChoicesSchema = z.object({}).strict();

export const fpsExportOptionsSchema = z
  .object({
    exportedAt: z.string().datetime().optional(),
    includeFileCategories: z.array(z.enum(canonicalFileCategories)).optional(),
    values: fpsExportChoicesSchema.optional()
  })
  .strict();

export type FpsExportOptions = z.infer<typeof fpsExportOptionsSchema>;
