import { z } from "zod";
import {
  codeforcesDifficultySchema,
  difficultyLevelSchema,
  problemTypeSchema
} from "@urmotiv/contracts";

export const nativeProblemFormat = "urmotiv-problem" as const;
export const nativeProblemFormatVersion = 1 as const;

const archiveTimestampSchema = z.union([
  z.string().datetime(),
  z.date().transform((value) => value.toISOString())
]);

export const canonicalFileCategories = [
  "asset",
  "testdata",
  "checker",
  "interactor",
  "answer_checker",
  "standard_solution",
  "public_attachment",
  "internal_attachment"
] as const;

export type CanonicalFileCategory = (typeof canonicalFileCategories)[number];

export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { readonly [key: string]: JsonValue };

export const jsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.null(),
    z.array(jsonValueSchema),
    z.record(z.string(), jsonValueSchema)
  ])
);

export const archivePathSchema = z
  .string()
  .min(1)
  .max(240)
  .refine((path) => isSafeArchivePath(path), "文件路径不安全或不符合原生包约定。");

export const binaryDataSchema = z.custom<Uint8Array>((value) => value instanceof Uint8Array);

export const canonicalContentSchema = z.object({
  basicStatement: z.string().min(1).max(500_000),
  basicSolution: z.string().max(500_000).nullable(),
  background: z.string().max(500_000).default(""),
  statement: z.string().max(500_000).default(""),
  inputFormat: z.string().max(500_000).default(""),
  outputFormat: z.string().max(500_000).default(""),
  constraints: z.string().max(500_000).default(""),
  solution: z.string().max(500_000).default(""),
  hints: z.string().max(500_000).default("")
}).strict();

export const canonicalSampleSchema = z.object({
  input: z.string().max(100_000),
  output: z.string().max(100_000),
  explanation: z.string().max(500_000).default("")
}).strict();

export const programReferenceSchema = z.object({
  source: archivePathSchema
}).strict();

export const checkerSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("standard") }).strict(),
  z.object({ type: z.literal("special"), source: archivePathSchema }).strict()
]);

export const scoringModes = ["sum", "min", "max"] as const;

export const judgeConfigSchema = z.object({
  version: z.literal(1),
  limits: z.object({
    timeMs: z.number().int().positive(),
    memoryMiB: z.number().int().positive()
  }).strict(),
  scoring: z.object({
    total: z.number().int().positive(),
    subtaskMode: z.enum(scoringModes)
  }).strict(),
  subtasks: z
    .array(
      z.object({
        id: z.number().int().nonnegative(),
        score: z.number().int().nonnegative(),
        method: z.enum(scoringModes),
        dependsOn: z.array(z.number().int().nonnegative()).default([])
      }).strict()
    )
    .max(1_000)
    .default([]),
  testcases: z
    .array(
      z.object({
        id: z.string().min(1).max(120),
        input: archivePathSchema,
        output: archivePathSchema.optional(),
        subtaskId: z.number().int().nonnegative().optional(),
        score: z.number().int().nonnegative(),
        timeMs: z.number().int().positive().optional(),
        memoryMiB: z.number().int().positive().optional()
      }).strict()
    )
    .max(10_000)
    .default([]),
  checker: checkerSchema.optional(),
  interactor: programReferenceSchema.optional(),
  answerChecker: programReferenceSchema.optional()
}).strict();

export const canonicalFileSchema = z.object({
  path: archivePathSchema,
  category: z.enum(canonicalFileCategories),
  content: binaryDataSchema
}).strict();

export const provenanceSchema = z.object({
  sourceSystem: z.string().trim().min(1).max(120),
  sourceProblemId: z.string().trim().min(1).max(200).optional(),
  sourceRevision: z.string().trim().min(1).max(200).optional()
}).strict();

export const canonicalProblemSchema = z.object({
  title: z.string().trim().min(1).max(200),
  type: problemTypeSchema,
  tags: z.array(z.string().trim().min(1).max(120)).max(30),
  difficulty: z.object({
    codeforces: codeforcesDifficultySchema.optional(),
    thinkingLevel: difficultyLevelSchema.optional(),
    codingLevel: difficultyLevelSchema.optional()
  }).strict(),
  content: canonicalContentSchema,
  samples: z.array(canonicalSampleSchema).max(50).default([]),
  judge: judgeConfigSchema.optional(),
  files: z.array(canonicalFileSchema).max(10_000).default([]),
  provenance: provenanceSchema.optional(),
  extensions: z.record(z.string(), jsonValueSchema).default({})
}).strict();

export type CanonicalContent = z.infer<typeof canonicalContentSchema>;
export type CanonicalSample = z.infer<typeof canonicalSampleSchema>;
export type JudgeConfig = z.infer<typeof judgeConfigSchema>;
export type CanonicalFile = z.infer<typeof canonicalFileSchema>;
export type Provenance = z.infer<typeof provenanceSchema>;
export type CanonicalProblem = z.infer<typeof canonicalProblemSchema>;

export const nativeManifestSchema = z.object({
  format: z.literal(nativeProblemFormat),
  formatVersion: z.literal(nativeProblemFormatVersion),
  exportedAt: archiveTimestampSchema,
  problem: z.object({
    title: z.string().trim().min(1).max(200),
    type: problemTypeSchema,
    tags: z.array(z.string().trim().min(1).max(120)).max(30),
    difficulty: z
      .object({
        codeforces: codeforcesDifficultySchema.optional(),
        thinkingLevel: difficultyLevelSchema.optional(),
        codingLevel: difficultyLevelSchema.optional()
      }).strict()
      .default({}),
    content: z.object({
      basicStatement: archivePathSchema,
      basicSolution: archivePathSchema.optional(),
      background: archivePathSchema.optional(),
      statement: archivePathSchema.optional(),
      input: archivePathSchema.optional(),
      output: archivePathSchema.optional(),
      constraints: archivePathSchema.optional(),
      solution: archivePathSchema.optional(),
      hints: archivePathSchema.optional()
    }).strict(),
    samples: archivePathSchema.optional(),
    judge: archivePathSchema.optional(),
    extensions: z.record(z.string(), jsonValueSchema).default({})
  }).strict(),
  provenance: provenanceSchema.optional()
}).strict();

export type NativeManifest = z.infer<typeof nativeManifestSchema>;

/**
 * Keeps ZIP entry paths independent of the operating system. The caller must
 * still compare all paths for collisions before extracting any entry.
 */
export function isSafeArchivePath(path: string): boolean {
  if (path.length === 0 || path.length > 240 || path.includes("\0") || hasUnpairedSurrogate(path)) {
    return false;
  }

  if (path.includes("\\") || path.startsWith("/") || /^[A-Za-z]:/.test(path)) {
    return false;
  }

  const segments = path.split("/");
  if (
    segments.length > 16 ||
    segments.some((segment) => segment.length === 0 || segment === "." || segment === "..")
  ) {
    return false;
  }

  return segments.every((segment) => segment.length <= 120 && !/[\u0000-\u001f]/.test(segment));
}

function hasUnpairedSurrogate(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next < 0xdc00 || next > 0xdfff) {
        return true;
      }
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return true;
    }
  }
  return false;
}
