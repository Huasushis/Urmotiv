import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { z } from "zod";
import {
  type ArchiveSummary,
  createSafeArchive,
  type SafeArchive
} from "./archive";
import type {
  DetectionResult,
  ExportOptions,
  GeneratedArchive,
  ImportChoices,
  ImportPreview,
  ProblemFormatAdapter
} from "./adapter";
import {
  checksumsForFiles,
  checksumFilePath,
  decodeUtf8,
  encodeUtf8,
  renderChecksums,
  sha256,
  verifyArchiveChecksums
} from "./checksums";
import { createLossReport, type LossReport, type LossReportItem } from "./loss-report";
import {
  type CanonicalContent,
  type CanonicalFile,
  type CanonicalFileCategory,
  canonicalFileCategories,
  canonicalProblemSchema,
  type CanonicalProblem,
  type CanonicalSample,
  type JudgeConfig,
  judgeConfigSchema,
  nativeManifestSchema,
  nativeProblemFormat,
  nativeProblemFormatVersion,
  type NativeManifest
} from "./schema";

export const nativeProblemMediaType = "application/vnd.urmotiv.problem+zip";
export const nativeAdapterId = "urmotiv";

const manifestPath = "manifest.yaml";
const samplePath = "samples/samples.yaml";
const judgePath = "judge/config.yaml";

interface ContentReferences {
  readonly basicStatement: string;
  basicSolution?: string;
  background?: string;
  statement?: string;
  inputFormat?: string;
  outputFormat?: string;
  constraints?: string;
  solution?: string;
  hints?: string;
}

const sampleFileSchema = z.object({
  version: z.literal(1),
  samples: z
    .array(
      z.object({
        input: z.string().max(100_000),
        output: z.string().max(100_000),
        explanation: z.string().max(500_000).default("")
      }).strict()
    )
    .max(50)
}).strict();

const importChoicesSchema = z.object({
  conflictAction: z.enum(["create", "update"]),
  targetProblemId: z.string().min(1).max(200).optional(),
  values: z.record(z.string(), z.never()).optional()
}).strict().superRefine((choices, context) => {
  if (choices.conflictAction === "update" && choices.targetProblemId === undefined) {
    context.addIssue({
      code: "custom",
      path: ["targetProblemId"],
      message: "更新现有题目时必须指定目标题目。"
    });
  }
  if (choices.conflictAction === "create" && choices.targetProblemId !== undefined) {
    context.addIssue({
      code: "custom",
      path: ["targetProblemId"],
      message: "创建新题目时不能指定目标题目。"
    });
  }
});

const exportOptionsSchema = z.object({
  exportedAt: z.string().datetime().optional(),
  includeFileCategories: z.array(z.enum(canonicalFileCategories)).optional(),
  values: z.record(z.string(), z.never()).optional()
}).strict();

export class ProblemPackageError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "ProblemPackageError";
  }
}

export const urmotivNativeAdapter: ProblemFormatAdapter = {
  id: nativeAdapterId,
  displayName: "Urmotiv 原生题目包",
  version: "1.0.0",
  inputKind: "zip",

  async detect(input: ArchiveSummary): Promise<DetectionResult> {
    const paths = new Set(input.entries.map((entry) => entry.path));
    if (paths.has(manifestPath) && paths.has(checksumFilePath)) {
      return { confidence: 0.99, reason: "包含 Urmotiv 清单和校验值文件。" };
    }
    if (paths.has(manifestPath)) {
      return { confidence: 0.45, reason: "包含清单文件，但缺少原生包必需的校验值文件。" };
    }
    return { confidence: 0, reason: "没有找到 Urmotiv 原生题目包清单。" };
  },

  async inspect(input: SafeArchive): Promise<ImportPreview> {
    try {
      const manifest = loadManifest(input);
      const files = input.list().map((entry) => entry.path).sort();
      return {
        formatId: nativeAdapterId,
        problemCount: 1,
        title: manifest.problem.title,
        files,
        issues: []
      };
    } catch (error) {
      return {
        formatId: nativeAdapterId,
        problemCount: 0,
        files: input.list().map((entry) => entry.path).sort(),
        issues: [
          {
            severity: "error",
            message: error instanceof Error ? error.message : "无法读取题目包。"
          }
        ]
      };
    }
  },

  async import(input: SafeArchive, choices: ImportChoices): Promise<CanonicalProblem> {
    importChoicesSchema.parse(choices);
    const manifest = loadManifest(input);
    const content = loadContent(input, manifest);
    const samples = loadSamples(input, manifest);
    const judge = loadJudge(input, manifest);
    const files = collectPackageFiles(input, manifest);

    if (judge !== undefined) {
      validateJudgeConfig(manifest.problem.type, judge, new Set(files.map((file) => file.path)));
    }

    return canonicalProblemSchema.parse({
      title: manifest.problem.title,
      type: manifest.problem.type,
      tags: manifest.problem.tags,
      difficulty: manifest.problem.difficulty,
      content,
      samples,
      judge,
      files,
      provenance: manifest.provenance,
      extensions: manifest.problem.extensions
    });
  },

  async validateExport(problem: CanonicalProblem, options: ExportOptions): Promise<LossReport> {
    const parsedProblem = canonicalProblemSchema.parse(problem);
    const parsedOptions = exportOptionsSchema.parse(options);
    validateCanonicalFilePaths(parsedProblem.files);
    if (parsedProblem.judge !== undefined) {
      validateJudgeConfig(
        parsedProblem.type,
        parsedProblem.judge,
        new Set(parsedProblem.files.map((file) => file.path))
      );
    }

    const selectedCategories = selectedFileCategories(parsedOptions, parsedProblem.files);
    const items: LossReportItem[] = [];
    const requiredJudgeFiles = judgeFilePaths(parsedProblem.judge);

    for (const file of parsedProblem.files) {
      if (selectedCategories.has(file.category)) {
        continue;
      }

      if (requiredJudgeFiles.has(file.path)) {
        items.push({
          severity: "error",
          path: `files.${file.path}`,
          message: "评测配置仍引用这个文件，不能在导出时排除它。"
        });
        continue;
      }

      items.push({
        severity: "warning",
        path: `files.${file.path}`,
        message: "已按导出选择排除这个文件。"
      });
    }

    return createLossReport(nativeAdapterId, items);
  },

  async export(problem: CanonicalProblem, options: ExportOptions): Promise<GeneratedArchive> {
    const parsedProblem = canonicalProblemSchema.parse(problem);
    const parsedOptions = exportOptionsSchema.parse(options);
    const lossReport = await urmotivNativeAdapter.validateExport(parsedProblem, options);
    if (!lossReport.canExport) {
      throw new ProblemPackageError("当前导出选择会遗漏评测配置必需的文件。请调整文件类别后重试。");
    }

    const selectedCategories = selectedFileCategories(parsedOptions, parsedProblem.files);
    const files = new Map<string, Uint8Array>();
    const contentRefs = addContentFiles(files, parsedProblem.content);

    let samplesRef: string | undefined;
    if (parsedProblem.samples.length > 0) {
      samplesRef = samplePath;
      addFile(
        files,
        samplePath,
        encodeUtf8(stringifyYaml({ version: 1, samples: parsedProblem.samples }))
      );
    }

    let judgeRef: string | undefined;
    if (parsedProblem.judge !== undefined) {
      judgeRef = judgePath;
      addFile(files, judgePath, encodeUtf8(stringifyYaml(parsedProblem.judge)));
    }

    for (const file of parsedProblem.files) {
      if (selectedCategories.has(file.category)) {
        addFile(files, file.path, file.content);
      }
    }

    const manifest = buildManifest(
      parsedProblem,
      parsedOptions.exportedAt ?? new Date().toISOString(),
      { content: contentRefs, samples: samplesRef, judge: judgeRef }
    );
    addFile(files, manifestPath, encodeUtf8(stringifyYaml(manifest)));
    addFile(files, checksumFilePath, encodeUtf8(renderChecksums(checksumsForFiles(files))));

    const generatedFiles = [...files.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([path, content]) => ({ path, content: new Uint8Array(content) }));

    // Reuse the same checks that a worker applies after it turns these files into a ZIP.
    createSafeArchive(
      generatedFiles.map((file) => ({
        path: file.path,
        kind: "file" as const,
        compressedSize: file.content.byteLength,
        uncompressedSize: file.content.byteLength,
        content: file.content
      }))
    );

    return {
      kind: "zip",
      mediaType: nativeProblemMediaType,
      fileName: "urmotiv-problem.zip",
      files: generatedFiles
    };
  }
};

function loadManifest(archive: SafeArchive): NativeManifest {
  verifyArchiveChecksums(archive);
  const rawManifest = readTextFile(archive, manifestPath);
  const manifest = parseWithSchema(rawManifest, nativeManifestSchema, "manifest.yaml 格式不正确。");

  if (
    manifest.format !== nativeProblemFormat ||
    manifest.formatVersion !== nativeProblemFormatVersion
  ) {
    throw new ProblemPackageError("不支持该题目包格式版本。");
  }

  assertPathPrefix(manifest.problem.content.basicStatement, "content/", "基础题面");
  if (manifest.problem.content.basicSolution !== undefined) {
    assertPathPrefix(manifest.problem.content.basicSolution, "content/", "基础题解");
  }
  for (const path of optionalContentPaths(manifest)) {
    assertPathPrefix(path, "content/", "题面内容");
  }
  if (manifest.problem.samples !== undefined) {
    assertPathPrefix(manifest.problem.samples, "samples/", "样例");
  }
  if (manifest.problem.judge !== undefined) {
    assertPathPrefix(manifest.problem.judge, "judge/", "评测配置");
  }
  const referencedPaths = [
    ...Object.values(manifest.problem.content),
    manifest.problem.samples,
    manifest.problem.judge
  ].filter((path): path is string => path !== undefined);
  if (new Set(referencedPaths).size !== referencedPaths.length) {
    throw new ProblemPackageError("题目包清单不能让多个字段引用同一个文件。");
  }

  return manifest;
}

function loadContent(archive: SafeArchive, manifest: NativeManifest): CanonicalContent {
  const content = manifest.problem.content;
  return {
    basicStatement: readTextFile(archive, content.basicStatement),
    basicSolution:
      content.basicSolution === undefined ? null : readTextFile(archive, content.basicSolution),
    background: readOptionalTextFile(archive, content.background),
    statement: readOptionalTextFile(archive, content.statement),
    inputFormat: readOptionalTextFile(archive, content.input),
    outputFormat: readOptionalTextFile(archive, content.output),
    constraints: readOptionalTextFile(archive, content.constraints),
    solution: readOptionalTextFile(archive, content.solution),
    hints: readOptionalTextFile(archive, content.hints)
  };
}

function loadSamples(archive: SafeArchive, manifest: NativeManifest): readonly CanonicalSample[] {
  if (manifest.problem.samples === undefined) {
    return [];
  }
  const raw = readTextFile(archive, manifest.problem.samples);
  return parseWithSchema(raw, sampleFileSchema, "样例文件格式不正确。").samples;
}

function loadJudge(archive: SafeArchive, manifest: NativeManifest): JudgeConfig | undefined {
  if (manifest.problem.judge === undefined) {
    return undefined;
  }
  const raw = readTextFile(archive, manifest.problem.judge);
  return parseWithSchema(raw, judgeConfigSchema, "评测配置文件格式不正确。");
}

function collectPackageFiles(
  archive: SafeArchive,
  manifest: NativeManifest
): readonly CanonicalFile[] {
  const contentPaths = Object.values(manifest.problem.content).filter(
    (path): path is string => path !== undefined
  );
  const structuredPaths = new Set<string>([
    manifestPath,
    checksumFilePath,
    ...contentPaths,
    ...(manifest.problem.samples === undefined ? [] : [manifest.problem.samples]),
    ...(manifest.problem.judge === undefined ? [] : [manifest.problem.judge])
  ]);
  const files: CanonicalFile[] = [];

  for (const entry of archive.list()) {
    if (structuredPaths.has(entry.path)) {
      continue;
    }
    const category = categoryForPath(entry.path);
    if (category === undefined) {
      throw new ProblemPackageError("原生题目包包含未定义用途的文件。");
    }
    files.push({ path: entry.path, category, content: new Uint8Array(entry.content) });
  }

  validateCanonicalFilePaths(files);
  return files;
}

function buildManifest(
  problem: CanonicalProblem,
  exportedAt: string,
  refs: {
    readonly content: ContentReferences;
    readonly samples: string | undefined;
    readonly judge: string | undefined;
  }
): NativeManifest {
  const content = refs.content;
  const manifest = {
    format: nativeProblemFormat,
    formatVersion: nativeProblemFormatVersion,
    exportedAt,
    problem: {
      title: problem.title,
      type: problem.type,
      tags: problem.tags,
      difficulty: problem.difficulty,
      content: {
        basicStatement: content.basicStatement,
        ...(content.basicSolution === undefined ? {} : { basicSolution: content.basicSolution }),
        ...(content.background === undefined ? {} : { background: content.background }),
        ...(content.statement === undefined ? {} : { statement: content.statement }),
        ...(content.inputFormat === undefined ? {} : { input: content.inputFormat }),
        ...(content.outputFormat === undefined ? {} : { output: content.outputFormat }),
        ...(content.constraints === undefined ? {} : { constraints: content.constraints }),
        ...(content.solution === undefined ? {} : { solution: content.solution }),
        ...(content.hints === undefined ? {} : { hints: content.hints })
      },
      ...(refs.samples === undefined ? {} : { samples: refs.samples }),
      ...(refs.judge === undefined ? {} : { judge: refs.judge }),
      extensions: problem.extensions
    },
    ...(problem.provenance === undefined ? {} : { provenance: problem.provenance })
  };
  return nativeManifestSchema.parse(manifest);
}

function addContentFiles(
  files: Map<string, Uint8Array>,
  content: CanonicalContent
): ContentReferences {
  const refs: ContentReferences = {
    basicStatement: "content/basic-statement.md"
  };

  addFile(files, refs.basicStatement, encodeUtf8(content.basicStatement));
  if (content.basicSolution !== null) {
    refs.basicSolution = "content/basic-solution.md";
    addFile(files, refs.basicSolution, encodeUtf8(content.basicSolution));
  }

  const optionalFiles: readonly [
    Exclude<keyof ContentReferences, "basicStatement" | "basicSolution">,
    string
  ][] = [
    ["background", "content/background.md"],
    ["statement", "content/statement.md"],
    ["inputFormat", "content/input.md"],
    ["outputFormat", "content/output.md"],
    ["constraints", "content/constraints.md"],
    ["solution", "content/solution.md"],
    ["hints", "content/hints.md"]
  ];

  for (const [field, path] of optionalFiles) {
    if (content[field].length > 0) {
      refs[field] = path;
      addFile(files, path, encodeUtf8(content[field]));
    }
  }

  return refs;
}

function selectedFileCategories(
  options: z.infer<typeof exportOptionsSchema>,
  files: readonly CanonicalFile[]
): ReadonlySet<CanonicalFileCategory> {
  if (options.includeFileCategories === undefined) {
    return new Set(files.map((file) => file.category));
  }

  const allowed = new Set<CanonicalFileCategory>();
  for (const category of options.includeFileCategories) {
    if (!isCanonicalFileCategory(category)) {
      throw new ProblemPackageError("导出选项包含未知的文件类别。");
    }
    allowed.add(category);
  }
  return allowed;
}

function validateCanonicalFilePaths(files: readonly CanonicalFile[]): void {
  const paths = new Set<string>();
  for (const file of files) {
    if (paths.has(file.path)) {
      throw new ProblemPackageError("题目中有重复的文件路径。"
      );
    }
    paths.add(file.path);
    if (categoryForPath(file.path) !== file.category) {
      throw new ProblemPackageError("文件路径与它的用途不匹配。"
      );
    }
    if (file.category === "asset") {
      const match = /^assets\/([a-f0-9]{64})\.[A-Za-z0-9]+$/i.exec(file.path);
      if (match?.[1]?.toLowerCase() !== sha256(file.content)) {
        throw new ProblemPackageError("资源文件名必须使用它的 SHA-256 内容摘要。");
      }
    }
  }
}

function validateJudgeConfig(
  problemType: CanonicalProblem["type"],
  judge: JudgeConfig,
  filePaths: ReadonlySet<string>
): void {
  const subtaskIds = new Set<number>();
  for (const subtask of judge.subtasks) {
    if (subtaskIds.has(subtask.id)) {
      throw new ProblemPackageError("评测配置中有重复的子任务编号。"
      );
    }
    subtaskIds.add(subtask.id);
  }
  for (const subtask of judge.subtasks) {
    for (const dependency of subtask.dependsOn) {
      if (dependency === subtask.id || !subtaskIds.has(dependency)) {
        throw new ProblemPackageError("子任务依赖关系不正确。"
        );
      }
    }
  }
  ensureNoSubtaskCycle(judge);

  if (judge.scoring.subtaskMode === "sum" && judge.subtasks.length > 0) {
    const total = judge.subtasks.reduce((sum, subtask) => sum + subtask.score, 0);
    if (total !== judge.scoring.total) {
      throw new ProblemPackageError("子任务分值之和必须等于总分。"
      );
    }
  }

  const testcaseIds = new Set<string>();
  for (const testcase of judge.testcases) {
    if (testcaseIds.has(testcase.id)) {
      throw new ProblemPackageError("评测配置中有重复的数据点编号。"
      );
    }
    testcaseIds.add(testcase.id);
    if (!filePaths.has(testcase.input) || !testcase.input.startsWith("judge/testdata/")) {
      throw new ProblemPackageError("数据点引用了缺失或不正确的输入文件。"
      );
    }
    if (
      testcase.output !== undefined &&
      (!filePaths.has(testcase.output) || !testcase.output.startsWith("judge/testdata/"))
    ) {
      throw new ProblemPackageError("数据点引用了缺失或不正确的输出文件。"
      );
    }
    if (testcase.subtaskId !== undefined && !subtaskIds.has(testcase.subtaskId)) {
      throw new ProblemPackageError("数据点引用了不存在的子任务。"
      );
    }
  }

  if (problemType === "traditional") {
    if (
      judge.checker === undefined ||
      judge.interactor !== undefined ||
      judge.answerChecker !== undefined
    ) {
      throw new ProblemPackageError("传统题只能使用标准或特殊判断程序。");
    }
    if (judge.testcases.some((testcase) => testcase.output === undefined)) {
      throw new ProblemPackageError("传统题的每个数据点都需要输出文件。"
      );
    }
    if (judge.checker.type === "special") {
      ensureProgramFile(judge.checker.source, "judge/checker/", filePaths, "特殊判断程序");
    }
  }

  if (problemType === "interactive") {
    if (
      judge.interactor === undefined ||
      judge.checker !== undefined ||
      judge.answerChecker !== undefined
    ) {
      throw new ProblemPackageError("交互题需要交互程序，且不能同时使用其他判断程序。");
    }
    ensureProgramFile(judge.interactor.source, "judge/interactor/", filePaths, "交互程序");
  }

  if (problemType === "submit_answer") {
    if (
      judge.answerChecker === undefined ||
      judge.checker !== undefined ||
      judge.interactor !== undefined
    ) {
      throw new ProblemPackageError("提交答案题需要答案判断程序，且不能同时使用其他判断程序。");
    }
    ensureProgramFile(judge.answerChecker.source, "judge/answer-checker/", filePaths, "答案判断程序");
  }
}

function ensureNoSubtaskCycle(judge: JudgeConfig): void {
  const dependencies = new Map(judge.subtasks.map((subtask) => [subtask.id, subtask.dependsOn]));
  const visiting = new Set<number>();
  const visited = new Set<number>();

  const visit = (id: number): void => {
    if (visited.has(id)) {
      return;
    }
    if (visiting.has(id)) {
      throw new ProblemPackageError("子任务依赖关系不能形成循环。"
      );
    }
    visiting.add(id);
    for (const dependency of dependencies.get(id) ?? []) {
      visit(dependency);
    }
    visiting.delete(id);
    visited.add(id);
  };

  for (const id of dependencies.keys()) {
    visit(id);
  }
}

function judgeFilePaths(judge: JudgeConfig | undefined): ReadonlySet<string> {
  const paths = new Set<string>();
  if (judge === undefined) {
    return paths;
  }
  for (const testcase of judge.testcases) {
    paths.add(testcase.input);
    if (testcase.output !== undefined) {
      paths.add(testcase.output);
    }
  }
  if (judge.checker?.type === "special") {
    paths.add(judge.checker.source);
  }
  if (judge.interactor !== undefined) {
    paths.add(judge.interactor.source);
  }
  if (judge.answerChecker !== undefined) {
    paths.add(judge.answerChecker.source);
  }
  return paths;
}

function ensureProgramFile(
  path: string,
  prefix: string,
  filePaths: ReadonlySet<string>,
  name: string
): void {
  if (!path.startsWith(prefix) || !filePaths.has(path)) {
    throw new ProblemPackageError(`${name}引用了缺失或不正确的文件。`);
  }
}

function categoryForPath(path: string): CanonicalFileCategory | undefined {
  if (path.startsWith("assets/")) return "asset";
  if (path.startsWith("judge/testdata/")) return "testdata";
  if (path.startsWith("judge/checker/")) return "checker";
  if (path.startsWith("judge/interactor/")) return "interactor";
  if (path.startsWith("judge/answer-checker/")) return "answer_checker";
  if (path.startsWith("solutions/std/")) return "standard_solution";
  if (path.startsWith("attachments/public/")) return "public_attachment";
  if (path.startsWith("attachments/internal/")) return "internal_attachment";
  return undefined;
}

function isCanonicalFileCategory(value: string): value is CanonicalFileCategory {
  return [
    "asset",
    "testdata",
    "checker",
    "interactor",
    "answer_checker",
    "standard_solution",
    "public_attachment",
    "internal_attachment"
  ].includes(value as CanonicalFileCategory);
}

function optionalContentPaths(manifest: NativeManifest): readonly string[] {
  const content = manifest.problem.content;
  return [
    content.background,
    content.statement,
    content.input,
    content.output,
    content.constraints,
    content.solution,
    content.hints
  ].filter((path): path is string => path !== undefined);
}

function readTextFile(archive: SafeArchive, path: string): string {
  const content = archive.read(path);
  if (content === undefined) {
    throw new ProblemPackageError("题目包引用了不存在的文件。"
    );
  }
  try {
    return decodeUtf8(content, "题目包中的文本文件不是 UTF-8 编码。"
    );
  } catch (error) {
    throw new ProblemPackageError(error instanceof Error ? error.message : "无法读取文本文件。"
    );
  }
}

function readOptionalTextFile(archive: SafeArchive, path: string | undefined): string {
  return path === undefined ? "" : readTextFile(archive, path);
}

function parseWithSchema<T>(text: string, schema: z.ZodType<T>, message: string): T {
  try {
    return schema.parse(parseYaml(text));
  } catch {
    throw new ProblemPackageError(message);
  }
}

function assertPathPrefix(path: string, prefix: string, name: string): void {
  if (!path.startsWith(prefix)) {
    throw new ProblemPackageError(`${name}必须位于 ${prefix} 目录中。`);
  }
}

function addFile(files: Map<string, Uint8Array>, path: string, content: Uint8Array): void {
  if (files.has(path)) {
    throw new ProblemPackageError("导出时出现重复的文件路径。"
    );
  }
  files.set(path, new Uint8Array(content));
}
