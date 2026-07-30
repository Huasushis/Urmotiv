import {
  canonicalFileCategories,
  jsonValueSchema
} from "@urmotiv/problem-package";
import { z } from "zod";

export const hydroSupportedRevision = "hydro-591dbd31-2026-07-25" as const;
const hydroLegacySupportedRevision = "hydro-unversioned-2026-07-25" as const;

export const hydroProblemTypes = [
  "default",
  "interactive",
  "communication",
  "submit_answer",
  "objective",
  "remote_judge"
] as const;

export const hydroCheckerTypeSchema = z.string().trim().min(1).max(80);

const hydroTimeSchema = z.union([
  z.number().positive().finite(),
  z.string().regex(/^([0-9]+(?:\.[0-9]*)?)([mu]?)s?$/i)
]);

const hydroMemorySchema = z.union([
  z.number().positive().finite(),
  z.string().regex(/^([0-9]+(?:\.[0-9]*)?)([kmg])b?$/i)
]);

export const hydroCompilableSourceSchema = z.union([
  z.string().min(1).max(120),
  z
    .object({
      file: z.string().min(1).max(120),
      lang: z.string().min(1).max(80)
    })
    .strict()
]);

export type HydroCompilableSource = z.infer<typeof hydroCompilableSourceSchema>;

export const hydroCaseSchema = z
  .object({
    input: z.string().min(1).max(120),
    output: z.string().min(1).max(120).optional(),
    time: hydroTimeSchema.optional(),
    memory: hydroMemorySchema.optional(),
    score: z.number().int().min(1).max(100).optional()
  })
  .strict();

export const hydroSubtaskSchema = z
  .object({
    id: z.number().int().nonnegative().optional(),
    score: z.number().int().min(1).max(100).optional(),
    type: z.enum(["min", "max", "sum"]).optional(),
    time: hydroTimeSchema.optional(),
    memory: hydroMemorySchema.optional(),
    if: z.array(z.number().int().nonnegative()).max(1_000).optional(),
    cases: z.array(hydroCaseSchema).max(10_000).optional()
  })
  .strict();

export const hydroConfigSchema = z
  .object({
    redirect: z.string().min(1).max(240).optional(),
    key: z.string().regex(/^[0-9a-f]{32}$/).optional(),
    type: z.enum(hydroProblemTypes).optional(),
    subType: z.string().min(1).max(120).optional(),
    langs: z.array(z.string().min(1).max(80)).max(100).optional(),
    target: z.string().min(1).max(240).optional(),
    checker_type: hydroCheckerTypeSchema.optional(),
    checker: hydroCompilableSourceSchema.optional(),
    interactor: hydroCompilableSourceSchema.optional(),
    manager: hydroCompilableSourceSchema.optional(),
    validator: hydroCompilableSourceSchema.optional(),
    num_processes: z.number().int().min(1).max(5).optional(),
    multi_pass: z.number().int().min(2).max(20).optional(),
    user_extra_files: z.array(z.string().min(1).max(120)).max(1_000).optional(),
    judge_extra_files: z.array(z.string().min(1).max(120)).max(1_000).optional(),
    cases: z.array(hydroCaseSchema).max(10_000).optional(),
    subtasks: z.array(hydroSubtaskSchema).max(1_000).optional(),
    filename: z.string().min(1).max(120).optional(),
    detail: z.union([z.enum(["full", "case", "none"]), z.boolean()]).optional(),
    time: hydroTimeSchema.optional(),
    memory: hydroMemorySchema.optional(),
    score: z.number().int().min(1).max(100).optional(),
    template: z.record(z.string(), jsonValueSchema).optional(),
    answers: z.record(z.string(), jsonValueSchema).optional(),
    time_limit_rate: z.record(z.string(), z.number().positive().finite()).optional(),
    memory_limit_rate: z.record(z.string(), z.number().positive().finite()).optional()
  })
  .strict();

export type HydroConfig = z.infer<typeof hydroConfigSchema>;
export type HydroCase = z.infer<typeof hydroCaseSchema>;
export type HydroSubtask = z.infer<typeof hydroSubtaskSchema>;

const hydroProblemYamlInputSchema = z
  .object({
    title: z.string().trim().min(1).max(200).optional(),
    name: z.string().trim().min(1).max(200).optional(),
    tag: z.array(z.union([z.string(), z.number()])).max(100).optional(),
    pid: z.union([z.string(), z.number()]).optional(),
    owner: z.union([z.string(), z.number()]).optional(),
    nSubmit: z.number().int().nonnegative().optional(),
    nAccept: z.number().int().nonnegative().optional(),
    difficulty: z.number().int().min(0).max(10).optional(),
    hidden: z.boolean().optional(),
    content: z.string().max(500_000).optional(),
    limits: z
      .object({
        time_limit: z.number().positive().finite().optional(),
        memory: z.number().positive().finite().optional()
      })
      .strict()
      .optional()
  })
  .strict();

export const hydroProblemYamlSchema = hydroProblemYamlInputSchema.transform((value, context) => {
  const title = (value.title ?? value.name)?.trim();
  if (title === undefined || title.length === 0) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["title"],
      message: "Hydro 题目包需要 title 或 name。"
    });
    return z.NEVER;
  }
  return { ...value, title };
});

export type HydroProblemYaml = z.infer<typeof hydroProblemYamlSchema>;

export const hydroExtensionSchema = z
  .object({
    revision: z.union([
      z.literal(hydroSupportedRevision),
      z.literal(hydroLegacySupportedRevision)
    ]),
    rootDirectory: z.string().max(120),
    statementFile: z.string().min(1).max(120),
    sourceStatementMarkdown: z.string().min(1).max(500_000),
    hadSolution: z.boolean(),
    problemId: z.string().min(1).max(200).optional(),
    difficulty: z.number().int().min(0).max(10).optional(),
    config: hydroConfigSchema.optional()
  })
  .strict();

export type HydroExtension = z.infer<typeof hydroExtensionSchema>;

export const hydroImportChoicesSchema = z
  .object({
    conflictAction: z.enum(["create", "update"]),
    targetProblemId: z.string().min(1).max(200).optional(),
    values: z
      .object({
        statementFile: z.string().min(1).max(240).optional()
      })
      .strict()
      .optional()
  })
  .strict();

export const hydroExportOptionsSchema = z
  .object({
    exportedAt: z.string().datetime().optional(),
    includeFileCategories: z.array(z.enum(canonicalFileCategories)).optional(),
    values: z
      .object({
        rootDirectory: z.string().min(1).max(120).optional(),
        problemId: z.string().min(1).max(200).optional(),
        statementFile: z.string().min(1).max(120).optional(),
        checkerType: hydroCheckerTypeSchema.optional()
      })
      .strict()
      .optional()
  })
  .strict();

export type HydroExportOptions = z.infer<typeof hydroExportOptionsSchema>;
