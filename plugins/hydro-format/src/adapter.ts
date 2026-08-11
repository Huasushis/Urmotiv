import {
  canonicalProblemSchema,
  createLossReport,
  createSafeArchive,
  decodeUtf8,
  encodeUtf8,
  isSafeArchivePath,
  ProblemPackageError,
  type ArchiveSummary,
  type CanonicalFile,
  type CanonicalFileCategory,
  type CanonicalProblem,
  type DetectionResult,
  type ExportOptions,
  type GeneratedArchive,
  type ImportChoices,
  type ImportIssue,
  type ImportPreview,
  type JudgeConfig,
  type LossReport,
  type LossReportItem,
  type ProblemFormatAdapter,
  type SafeArchive
} from "@urmotiv/problem-package";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import {
  hydroConfigSchema,
  hydroExportOptionsSchema,
  hydroExtensionSchema,
  hydroImportChoicesSchema,
  hydroProblemYamlSchema,
  hydroSupportedRevision,
  type HydroCase,
  type HydroCompilableSource,
  type HydroConfig,
  type HydroExportOptions,
  type HydroExtension,
  type HydroProblemYaml,
  type HydroSubtask
} from "./schema";
import {
  canonicalContentFromHydroStatement,
  parseHydroStatement,
  renderHydroStatement
} from "./statement";

export const hydroAdapterId = "hydro";
export const hydroAdapterVersion = "0.1.0";
export const hydroProblemMediaType = "application/zip";

interface HydroLayout {
  readonly rootDirectory: string;
  readonly prefix: string;
  readonly manifestPath: string;
  readonly statementFiles: readonly string[];
  readonly configPath?: string;
  readonly solutionFiles: readonly string[];
  readonly allFiles: readonly string[];
  readonly files: readonly string[];
}

interface LoadedHydroPackage {
  readonly layout: HydroLayout;
  readonly metadata: HydroProblemYaml;
  readonly config: HydroConfig;
  readonly statementFile: string;
  readonly statement: string;
  readonly solution?: string;
  readonly issues: readonly ImportIssue[];
}

interface FileCollection {
  readonly files: readonly CanonicalFile[];
  readonly canonicalPathByHydroName: ReadonlyMap<string, string>;
}

interface NormalizedHydroSubtask {
  readonly id: number;
  readonly score: number;
  readonly type: "min" | "max" | "sum";
  readonly dependsOn: readonly number[];
  readonly cases: readonly HydroCase[];
  readonly time?: string | number;
  readonly memory?: string | number;
}

const unsupportedConfigFields: readonly (keyof HydroConfig)[] = [
  "subType",
  "langs",
  "target",
  "manager",
  "validator",
  "num_processes",
  "multi_pass",
  "user_extra_files",
  "judge_extra_files",
  "filename",
  "detail",
  "time_limit_rate",
  "memory_limit_rate"
];

export const hydroProblemFormatAdapter: ProblemFormatAdapter = {
  id: hydroAdapterId,
  displayName: "Hydro 题目包",
  version: hydroAdapterVersion,
  inputKind: "zip",

  async detect(input: ArchiveSummary): Promise<DetectionResult> {
    const manifests = findManifestPaths(input.entries.map((entry) => entry.path));
    if (manifests.length === 0) {
      return { confidence: 0, reason: "没有找到 Hydro 题目包使用的 problem.yaml。" };
    }
    if (manifests.length === 1) {
      const prefix = manifests[0] === "problem.yaml" ? "" : manifests[0]?.slice(0, -"problem.yaml".length);
      const hasStatement = input.entries.some((entry) =>
        isHydroStatementPath(relativeToPrefix(entry.path, prefix ?? ""))
      );
      return hasStatement
        ? { confidence: 0.98, reason: "包含 problem.yaml 和 Hydro Markdown 题面文件。" }
        : { confidence: 0.72, reason: "包含 problem.yaml，但没有找到独立 Markdown 题面。" };
    }
    return {
      confidence: 0.9,
      reason: "包含多个 Hydro 题目目录；当前单题导入接口需要先选择其中一道题。"
    };
  },

  async inspect(input: SafeArchive): Promise<ImportPreview> {
    const files = input.list().map((entry) => entry.path).sort();
    const manifests = findManifestPaths(files);
    if (manifests.length !== 1) {
      return {
        formatId: hydroAdapterId,
        problemCount: manifests.length,
        files,
        issues: [
          {
            severity: "error",
            message:
              manifests.length === 0
                ? "没有找到 Hydro 题目包使用的 problem.yaml。"
                : "这个压缩包包含多道题；当前单题导入接口不能一次导入多道题。"
          }
        ]
      };
    }

    try {
      const loaded = loadHydroPackage(input, undefined, true);
      return {
        formatId: hydroAdapterId,
        problemCount: 1,
        title: loaded.metadata.title,
        files,
        issues: loaded.issues
      };
    } catch (error) {
      return {
        formatId: hydroAdapterId,
        problemCount: 0,
        files,
        issues: [
          {
            severity: "error",
            message: error instanceof Error ? error.message : "无法读取 Hydro 题目包。"
          }
        ]
      };
    }
  },

  async import(input: SafeArchive, choices: ImportChoices): Promise<CanonicalProblem> {
    const parsedChoices = hydroImportChoicesSchema.parse(choices);
    const loaded = loadHydroPackage(input, parsedChoices.values?.statementFile, false);
    const problemType = canonicalProblemType(loaded.config.type);
    const roles = programRoles(loaded.config, problemType);
    const collected = collectCanonicalFiles(input, loaded.layout, roles);
    const judge = buildCanonicalJudge(
      loaded.config,
      problemType,
      loaded.layout,
      input,
      roles,
      collected.canonicalPathByHydroName
    );
    const statementContent = canonicalContentFromHydroStatement(
      loaded.statement,
      loaded.solution
    );
    const problemId =
      loaded.metadata.pid === undefined ? undefined : String(loaded.metadata.pid);
    const extension = hydroExtensionSchema.parse({
      revision: hydroSupportedRevision,
      rootDirectory: loaded.layout.rootDirectory,
      statementFile: relativeToPrefix(loaded.statementFile, loaded.layout.prefix),
      sourceStatementMarkdown: loaded.statement,
      hadSolution: loaded.solution !== undefined,
      ...(problemId === undefined ? {} : { problemId }),
      ...(loaded.metadata.difficulty === undefined
        ? {}
        : { difficulty: loaded.metadata.difficulty }),
      ...(Object.keys(loaded.config).length === 0 ? {} : { config: loaded.config })
    });
    const tags = (loaded.metadata.tag ?? []).map((tag) => String(tag));
    if (tags.length > 30) {
      throw new ProblemPackageError("Hydro 题目包含超过 30 个标签，不能无提示截断。请先减少标签数量。");
    }

    return canonicalProblemSchema.parse({
      title: loaded.metadata.title,
      type: problemType,
      tags,
      difficulty: {},
      content: statementContent.content,
      samples: statementContent.samples,
      ...(judge === undefined ? {} : { judge }),
      files: collected.files,
      provenance: {
        sourceSystem: "hydro",
        ...(problemId === undefined ? {} : { sourceProblemId: problemId }),
        sourceRevision: hydroSupportedRevision
      },
      extensions: { hydro: extension }
    });
  },

  async validateExport(problem: CanonicalProblem, options: ExportOptions): Promise<LossReport> {
    const parsedProblem = canonicalProblemSchema.parse(problem);
    const parsedOptions = hydroExportOptionsSchema.parse(options);
    return validateHydroExport(parsedProblem, parsedOptions);
  },

  async export(problem: CanonicalProblem, options: ExportOptions): Promise<GeneratedArchive> {
    const parsedProblem = canonicalProblemSchema.parse(problem);
    const parsedOptions = hydroExportOptionsSchema.parse(options);
    const lossReport = validateHydroExport(parsedProblem, parsedOptions);
    if (!lossReport.canExport) {
      throw new ProblemPackageError("当前题目信息不能直接转换成 Hydro 格式，请先处理导出报告中的问题。");
    }

    const extension = readHydroExtension(parsedProblem);
    const rootDirectory = resolveRootDirectory(parsedOptions, extension);
    const prefix = `${rootDirectory}/`;
    const statementFile = resolveStatementFile(parsedOptions, extension);
    const selectedCategories = selectedCategoriesForExport(parsedProblem, parsedOptions);
    const outputFiles = new Map<string, Uint8Array>();
    const mappedPaths = mapCanonicalFiles(
      parsedProblem.files.filter((file) => selectedCategories.has(file.category)),
      prefix
    );

    const metadata: Record<string, unknown> = {
      title: parsedProblem.title,
      tag: parsedProblem.tags
    };
    const problemId =
      parsedOptions.values?.problemId ??
      extension?.problemId ??
      (parsedProblem.provenance?.sourceSystem === "hydro"
        ? parsedProblem.provenance.sourceProblemId
        : undefined);
    if (problemId !== undefined) {
      metadata.pid = problemId;
    }
    if (extension?.difficulty !== undefined) {
      metadata.difficulty = extension.difficulty;
    }

    addOutputFile(
      outputFiles,
      `${prefix}problem.yaml`,
      encodeUtf8(stringifyYaml(metadata))
    );
    addOutputFile(
      outputFiles,
      `${prefix}${statementFile}`,
      encodeUtf8(renderHydroStatement(parsedProblem, extension?.sourceStatementMarkdown))
    );

    const solution = (parsedProblem.content.solution || parsedProblem.content.basicSolution) ?? "";
    const shouldWriteSolution =
      solution.length > 0 &&
      !(extension?.hadSolution === false && parsedProblem.content.solution.length === 0);
    if (shouldWriteSolution) {
      addOutputFile(outputFiles, `${prefix}solution/solution.md`, encodeUtf8(solution));
    }

    if (parsedProblem.judge !== undefined) {
      const config = buildHydroConfig(
        parsedProblem,
        parsedProblem.judge,
        parsedOptions,
        extension,
        mappedPaths
      );
      addOutputFile(
        outputFiles,
        `${prefix}testdata/config.yaml`,
        encodeUtf8(stringifyYaml(config))
      );
    }

    for (const mapping of mappedPaths.values()) {
      addOutputFile(outputFiles, mapping.targetPath, mapping.file.content);
    }

    const files = [...outputFiles.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([path, content]) => ({ path, content: new Uint8Array(content) }));
    createSafeArchive(
      files.map((file) => ({
        path: file.path,
        kind: "file" as const,
        compressedSize: file.content.byteLength,
        uncompressedSize: file.content.byteLength,
        content: file.content
      }))
    );

    return {
      kind: "zip",
      mediaType: hydroProblemMediaType,
      fileName: "hydro-problem.zip",
      files
    };
  }
};

interface ProgramRoles {
  readonly checker?: string;
  readonly interactor?: string;
  readonly answerChecker?: string;
}

interface ExportFileMapping {
  readonly file: CanonicalFile;
  readonly targetPath: string;
  readonly targetName: string;
}

function loadHydroPackage(
  archive: SafeArchive,
  requestedStatementFile: string | undefined,
  allowAmbiguousStatement: boolean
): LoadedHydroPackage {
  const layout = locateSingleProblem(archive);
  assertSupportedPaths(layout);
  const metadata = parseYamlFile(
    readTextFile(archive, layout.manifestPath),
    hydroProblemYamlSchema,
    "problem.yaml 格式不符合当前 Hydro 题目包约定。"
  );
  const config = layout.configPath === undefined
    ? configFromProblemMetadata(metadata)
    : parseYamlFile(
        readTextFile(archive, layout.configPath),
        hydroConfigSchema,
        "testdata/config.yaml 格式不符合当前 Hydro 配置结构。"
      );
  canonicalProblemType(config.type);
  const issues: ImportIssue[] = [];
  const statementFile = selectStatementFile(
    layout,
    requestedStatementFile,
    allowAmbiguousStatement,
    issues
  );
  const statement = statementFile === undefined
    ? metadata.content
    : readTextFile(archive, statementFile);
  if (statement === undefined || statement.trim().length === 0) {
    throw new ProblemPackageError("Hydro 题目包没有可读取的 Markdown 题面。");
  }
  const parsedStatement = parseHydroStatement(statement);
  if (parsedStatement.unknownSections.length > 0) {
    issues.push({
      severity: "warning",
      path: relativeToPrefix(statementFile ?? layout.manifestPath, layout.prefix),
      message: `题面包含未结构化映射的一级分区：${parsedStatement.unknownSections.join("、")}。原文仍保留在基础题面中。`
    });
  }
  if (layout.solutionFiles.length > 1) {
    throw new ProblemPackageError("Hydro 题目包包含多份题解，当前内部结构不能无损区分它们。");
  }
  const solution = layout.solutionFiles[0] === undefined
    ? undefined
    : readTextFile(archive, layout.solutionFiles[0]);
  if (solution === undefined) {
    issues.push({ severity: "info", path: "solution", message: "原题包没有包含题解文件。" });
  }
  if (metadata.difficulty !== undefined) {
    issues.push({
      severity: "warning",
      path: "problem.yaml.difficulty",
      message: "Hydro 的 0 到 10 难度与本站难度标准不同；原值会保留，但不会自动换算。"
    });
  }
  if (
    metadata.owner !== undefined ||
    metadata.nSubmit !== undefined ||
    metadata.nAccept !== undefined ||
    metadata.hidden !== undefined
  ) {
    issues.push({
      severity: "info",
      path: "problem.yaml",
      message: "原包中的所有者、提交统计和隐藏状态不会作为题目内容导入。"
    });
  }
  for (const field of unsupportedConfigFields) {
    if (config[field] !== undefined) {
      issues.push({
        severity: "warning",
        path: `testdata/config.yaml.${field}`,
        message: "这个 Hydro 专用设置会随来源信息保留，但本站评测配置不会使用它。"
      });
    }
  }
  if (config.cases !== undefined && config.subtasks !== undefined) {
    issues.push({
      severity: "warning",
      path: "testdata/config.yaml.subtasks",
      message: "Hydro 在同时存在 cases 和 subtasks 时只使用 cases；subtasks 不会参与本站评测配置。"
    });
  }

  return {
    layout,
    metadata,
    config,
    statementFile: statementFile ?? `${layout.prefix}problem.md`,
    statement,
    ...(solution === undefined ? {} : { solution }),
    issues
  };
}

function findManifestPaths(paths: readonly string[]): string[] {
  return paths
    .filter((path) => path === "problem.yaml" || /^[^/]+\/problem\.yaml$/.test(path))
    .sort();
}

function locateSingleProblem(archive: SafeArchive): HydroLayout {
  const files = archive.list().map((entry) => entry.path).sort();
  const manifests = findManifestPaths(files);
  if (manifests.length !== 1) {
    throw new ProblemPackageError(
      manifests.length === 0
        ? "没有找到 Hydro 题目包使用的 problem.yaml。"
        : "这个压缩包包含多道题，当前单题适配器不能选择其中一道。"
    );
  }
  const manifestPath = manifests[0];
  if (manifestPath === undefined) {
    throw new ProblemPackageError("没有找到 Hydro 题目包清单。");
  }
  const rootDirectory = manifestPath === "problem.yaml" ? "" : manifestPath.split("/")[0] ?? "";
  const prefix = rootDirectory.length === 0 ? "" : `${rootDirectory}/`;
  const packageFiles = files.filter((path) => path.startsWith(prefix));
  const statementFiles = packageFiles.filter((path) =>
    isHydroStatementPath(relativeToPrefix(path, prefix))
  );
  const configPath = packageFiles.find(
    (path) => relativeToPrefix(path, prefix) === "testdata/config.yaml"
  );
  const solutionFiles = packageFiles.filter((path) =>
    /^solution\/[^/]+\.md$/i.test(relativeToPrefix(path, prefix))
  );
  return {
    rootDirectory,
    prefix,
    manifestPath,
    statementFiles,
    ...(configPath === undefined ? {} : { configPath }),
    solutionFiles,
    allFiles: files,
    files: packageFiles
  };
}

function assertSupportedPaths(layout: HydroLayout): void {
  const outside = layout.prefix.length === 0
    ? []
    : layout.allFiles.filter((path) => !path.startsWith(layout.prefix));
  if (outside.length > 0) {
    throw new ProblemPackageError("Hydro 单题目录之外还包含其他文件，不能判断它们属于哪道题。");
  }
  for (const path of layout.files) {
    const relative = relativeToPrefix(path, layout.prefix);
    if (
      relative === "problem.yaml" ||
      isHydroStatementPath(relative) ||
      /^testdata\/[^/]+$/.test(relative) ||
      /^additional_file\/[^/]+$/.test(relative) ||
      /^solution\/[^/]+\.md$/i.test(relative) ||
      /^std\/[^/]+$/.test(relative)
    ) {
      continue;
    }
    throw new ProblemPackageError(
      `当前支持的 Hydro 版本不能确定文件 ${relative} 的用途，已停止导入。`
    );
  }
}

function selectStatementFile(
  layout: HydroLayout,
  requested: string | undefined,
  allowAmbiguous: boolean,
  issues: ImportIssue[]
): string | undefined {
  if (requested !== undefined) {
    const fullPath = requested.startsWith(layout.prefix)
      ? requested
      : `${layout.prefix}${requested}`;
    if (!layout.statementFiles.includes(fullPath)) {
      throw new ProblemPackageError("选择的 Hydro 题面文件不存在。");
    }
    return fullPath;
  }
  const plain = layout.statementFiles.find(
    (path) => relativeToPrefix(path, layout.prefix) === "problem.md"
  );
  if (plain !== undefined) {
    return plain;
  }
  if (layout.statementFiles.length <= 1) {
    return layout.statementFiles[0];
  }
  if (!allowAmbiguous) {
    throw new ProblemPackageError("Hydro 题目包包含多种语言题面，请明确选择要导入的 Markdown 文件。");
  }
  const selected = [...layout.statementFiles].sort()[0];
  issues.push({
    severity: "warning",
    path: "problem_*.md",
    message: "检测到多种语言题面；预览暂用文件名排序后的第一份，导入时必须明确选择。"
  });
  return selected;
}

function isHydroStatementPath(path: string): boolean {
  return path === "problem.md" || /^problem(?:_|\.)[A-Za-z_]+\.md$/.test(path);
}

function relativeToPrefix(path: string, prefix: string): string {
  return prefix.length > 0 && path.startsWith(prefix) ? path.slice(prefix.length) : path;
}

function readTextFile(archive: SafeArchive, path: string): string {
  const content = archive.read(path);
  if (content === undefined) {
    throw new ProblemPackageError(`Hydro 题目包引用的文件 ${path} 不存在。`);
  }
  try {
    return decodeUtf8(content, `文件 ${path} 不是 UTF-8 文本。`);
  } catch (error) {
    throw new ProblemPackageError(error instanceof Error ? error.message : `无法读取文件 ${path}。`);
  }
}

function parseYamlFile<T>(
  text: string,
  schema: { parse(value: unknown): T },
  message: string
): T {
  try {
    return schema.parse(parseYaml(text));
  } catch {
    throw new ProblemPackageError(message);
  }
}

function configFromProblemMetadata(metadata: HydroProblemYaml): HydroConfig {
  if (metadata.limits === undefined) {
    return {};
  }
  return hydroConfigSchema.parse({
    ...(metadata.limits.time_limit === undefined
      ? {}
      : { time: `${metadata.limits.time_limit * 1000}ms` }),
    ...(metadata.limits.memory === undefined
      ? {}
      : { memory: `${metadata.limits.memory}m` })
  });
}

function canonicalProblemType(type: HydroConfig["type"]): CanonicalProblem["type"] {
  if (type === undefined || type === "default") {
    return "traditional";
  }
  if (type === "interactive") {
    return "interactive";
  }
  if (type === "submit_answer") {
    return "submit_answer";
  }
  throw new ProblemPackageError(
    `Hydro 题型 ${type} 在本站没有对应题型，不能自动改变含义后导入。`
  );
}

function programRoles(config: HydroConfig, problemType: CanonicalProblem["type"]): ProgramRoles {
  if (problemType === "interactive") {
    const interactor = sourceFileName(config.interactor, "交互程序");
    if (interactor === undefined) {
      throw new ProblemPackageError("Hydro 交互题没有配置 interactor 文件。");
    }
    return { interactor };
  }
  if (problemType === "submit_answer") {
    const answerChecker = customCheckerFileName(config.checker);
    if (answerChecker === undefined) {
      throw new ProblemPackageError(
        "Hydro 提交答案题没有可导入的自定义 checker；本站不能用一个名称代替答案判断程序。"
      );
    }
    assertCustomCheckerType(config.checker_type);
    return { answerChecker };
  }
  const checker = customCheckerFileName(config.checker);
  if (checker !== undefined) {
    assertCustomCheckerType(config.checker_type);
    return { checker };
  }
  return {};
}

function customCheckerFileName(source: HydroCompilableSource | undefined): string | undefined {
  if (source === undefined) {
    return undefined;
  }
  if (typeof source === "string" && !source.includes(".")) {
    return undefined;
  }
  return sourceFileName(source, "特殊判断程序");
}

function sourceFileName(
  source: HydroCompilableSource | undefined,
  displayName: string
): string | undefined {
  if (source === undefined) {
    return undefined;
  }
  const file = typeof source === "string" ? source : source.file;
  assertHydroFileName(file, displayName);
  return file;
}

function assertCustomCheckerType(type: HydroConfig["checker_type"]): void {
  if (type === undefined || type === "default" || type === "strict") {
    throw new ProblemPackageError(
      "Hydro 自定义 checker 没有声明可执行程序的调用约定，不能猜测为 testlib 或其他类型。"
    );
  }
}

function assertHydroFileName(name: string, displayName: string): void {
  if (
    name === "." ||
    name === ".." ||
    name.includes("/") ||
    name.includes("\\") ||
    !isSafeArchivePath(`testdata/${name}`)
  ) {
    throw new ProblemPackageError(`${displayName}使用了不安全或不受支持的文件名。`);
  }
}

function collectCanonicalFiles(
  archive: SafeArchive,
  layout: HydroLayout,
  roles: ProgramRoles
): FileCollection {
  const roleByName = new Map<string, CanonicalFileCategory>();
  addRole(roleByName, roles.checker, "checker");
  addRole(roleByName, roles.interactor, "interactor");
  addRole(roleByName, roles.answerChecker, "answer_checker");
  const canonicalPathByHydroName = new Map<string, string>();
  const files: CanonicalFile[] = [];
  const seenCanonicalPaths = new Set<string>();

  for (const archivePath of layout.files) {
    const relative = relativeToPrefix(archivePath, layout.prefix);
    if (relative === "testdata/config.yaml") {
      continue;
    }
    let targetPath: string | undefined;
    let category: CanonicalFileCategory | undefined;
    if (relative.startsWith("testdata/")) {
      const name = relative.slice("testdata/".length);
      assertHydroFileName(name, "测试数据文件");
      category = roleByName.get(name) ?? "testdata";
      targetPath = canonicalPathForHydroName(name, category);
      canonicalPathByHydroName.set(name, targetPath);
    } else if (relative.startsWith("additional_file/")) {
      const name = relative.slice("additional_file/".length);
      assertHydroFileName(name, "附件");
      category = "public_attachment";
      targetPath = `attachments/public/${name}`;
    } else if (relative.startsWith("std/")) {
      const name = relative.slice("std/".length);
      assertHydroFileName(name, "标准程序");
      category = "standard_solution";
      targetPath = `solutions/std/${name}`;
    }
    if (targetPath === undefined || category === undefined) {
      continue;
    }
    if (seenCanonicalPaths.has(targetPath)) {
      throw new ProblemPackageError(`多个 Hydro 文件会映射到同一路径 ${targetPath}，已停止导入。`);
    }
    const content = archive.read(archivePath);
    if (content === undefined) {
      throw new ProblemPackageError(`无法读取 Hydro 文件 ${archivePath}。`);
    }
    seenCanonicalPaths.add(targetPath);
    files.push({ path: targetPath, category, content });
  }

  for (const [name, category] of roleByName) {
    const expectedPath = `${layout.prefix}testdata/${name}`;
    if (!archive.has(expectedPath)) {
      throw new ProblemPackageError(`${categoryDisplayName(category)}文件 ${name} 不存在。`);
    }
  }
  return { files, canonicalPathByHydroName };
}

function addRole(
  roles: Map<string, CanonicalFileCategory>,
  name: string | undefined,
  category: CanonicalFileCategory
): void {
  if (name === undefined) {
    return;
  }
  const previous = roles.get(name);
  if (previous !== undefined && previous !== category) {
    throw new ProblemPackageError("同一个 Hydro 文件不能同时充当两种不同的评测程序。");
  }
  roles.set(name, category);
}

function canonicalPathForHydroName(name: string, category: CanonicalFileCategory): string {
  if (category === "checker") return `judge/checker/${name}`;
  if (category === "interactor") return `judge/interactor/${name}`;
  if (category === "answer_checker") return `judge/answer-checker/${name}`;
  return `judge/testdata/${name}`;
}

function categoryDisplayName(category: CanonicalFileCategory): string {
  if (category === "checker") return "特殊判断程序";
  if (category === "interactor") return "交互程序";
  if (category === "answer_checker") return "答案判断程序";
  return "评测";
}

function buildCanonicalJudge(
  config: HydroConfig,
  problemType: CanonicalProblem["type"],
  layout: HydroLayout,
  archive: SafeArchive,
  roles: ProgramRoles,
  pathByName: ReadonlyMap<string, string>
): JudgeConfig | undefined {
  const dataNames = new Set(
    layout.files
      .map((path) => relativeToPrefix(path, layout.prefix))
      .filter((path) => path.startsWith("testdata/") && path !== "testdata/config.yaml")
      .map((path) => path.slice("testdata/".length))
  );
  const sourceSubtasks = sourceSubtasksForConfig(config, dataNames);
  if (sourceSubtasks.length === 0) {
    if (Object.keys(config).length === 0) {
      return undefined;
    }
    throw new ProblemPackageError("Hydro 评测配置没有可识别的数据点。");
  }
  const defaultTime = parseHydroTime(config.time ?? 1000);
  const defaultMemory = parseHydroMemory(config.memory ?? 256);
  const subtasks = normalizeHydroSubtasks(sourceSubtasks);
  const canonicalSubtasks: JudgeConfig["subtasks"] = [];
  const testcases: JudgeConfig["testcases"] = [];
  const reservedProgramNames = new Set(
    [roles.checker, roles.interactor, roles.answerChecker].filter(
      (name): name is string => name !== undefined
    )
  );

  for (const subtask of subtasks) {
    canonicalSubtasks.push({
      id: subtask.id,
      score: subtask.score,
      method: subtask.type,
      dependsOn: [...subtask.dependsOn]
    });
    const caseScores = normalizedCaseScores(subtask);
    subtask.cases.forEach((testcase, index) => {
      const input = canonicalTestdataReference(
        testcase.input,
        "输入文件",
        layout,
        archive,
        pathByName,
        reservedProgramNames
      );
      const output = testcase.output === undefined
        ? undefined
        : canonicalTestdataReference(
            testcase.output,
            "输出文件",
            layout,
            archive,
            pathByName,
            reservedProgramNames
          );
      if (problemType === "traditional" && output === undefined) {
        throw new ProblemPackageError("Hydro 普通题的数据点缺少输出文件。");
      }
      testcases.push({
        id: `${subtask.id}-${index + 1}`,
        input,
        ...(output === undefined ? {} : { output }),
        subtaskId: subtask.id,
        score: caseScores[index] ?? 0,
        timeMs: parseHydroTime(testcase.time ?? subtask.time ?? config.time ?? defaultTime),
        memoryMiB: parseHydroMemory(
          testcase.memory ?? subtask.memory ?? config.memory ?? defaultMemory
        )
      });
    });
  }

  const total = canonicalSubtasks.reduce((sum, subtask) => sum + subtask.score, 0);
  const base = {
    version: 1 as const,
    limits: { timeMs: defaultTime, memoryMiB: defaultMemory },
    scoring: { total, subtaskMode: "sum" as const },
    subtasks: canonicalSubtasks,
    testcases
  };
  if (problemType === "interactive") {
    const source = requiredCanonicalProgramPath(roles.interactor, pathByName, "交互程序");
    return { ...base, interactor: { source } };
  }
  if (problemType === "submit_answer") {
    const source = requiredCanonicalProgramPath(
      roles.answerChecker,
      pathByName,
      "答案判断程序"
    );
    return { ...base, answerChecker: { source } };
  }
  if (roles.checker !== undefined) {
    const source = requiredCanonicalProgramPath(roles.checker, pathByName, "特殊判断程序");
    return { ...base, checker: { type: "special", source } };
  }
  return { ...base, checker: { type: "standard" } };
}

function requiredCanonicalProgramPath(
  name: string | undefined,
  pathByName: ReadonlyMap<string, string>,
  displayName: string
): string {
  if (name === undefined) {
    throw new ProblemPackageError(`${displayName}没有配置文件。`);
  }
  const path = pathByName.get(name);
  if (path === undefined) {
    throw new ProblemPackageError(`${displayName}文件 ${name} 不存在。`);
  }
  return path;
}

function sourceSubtasksForConfig(
  config: HydroConfig,
  dataNames: ReadonlySet<string>
): HydroSubtask[] {
  if (config.cases !== undefined && config.cases.length > 0) {
    return [{ id: 0, score: 100, type: "sum", cases: config.cases }];
  }
  if (config.subtasks !== undefined && config.subtasks.length > 0) {
    return config.subtasks;
  }
  const cases = autoDetectedCases(dataNames);
  return cases.length === 0 ? [] : [{ id: 0, score: 100, type: "sum", cases }];
}

function autoDetectedCases(dataNames: ReadonlySet<string>): HydroCase[] {
  const cases: HydroCase[] = [];
  for (const input of [...dataNames].sort()) {
    let outputs: readonly string[] = [];
    const ordinary = /^(.*?\d+)\.in$/i.exec(input);
    if (ordinary !== null) {
      outputs = [`${ordinary[1]}.out`, `${ordinary[1]}.ans`];
    }
    const text = /^input(\d+)\.txt$/i.exec(input);
    if (text !== null) {
      outputs = [`output${text[1]}.txt`];
    }
    const output = outputs.find((candidate) => dataNames.has(candidate));
    if (output !== undefined) {
      cases.push({ input, output });
    }
  }
  return cases;
}

function normalizeHydroSubtasks(subtasks: readonly HydroSubtask[]): NormalizedHydroSubtask[] {
  const explicitScore = subtasks.reduce((sum, subtask) => sum + (subtask.score ?? 0), 0);
  const missingCount = subtasks.filter((subtask) => subtask.score === undefined).length;
  const missingScores = distributeScore(Math.max(100 - explicitScore, 0), missingCount);
  let missingIndex = 0;
  const ids = new Set<number>();
  return subtasks.map((subtask, index) => {
    const id = subtask.id ?? index + 1;
    if (ids.has(id)) {
      throw new ProblemPackageError("Hydro 配置包含重复的子任务编号。");
    }
    ids.add(id);
    const score = subtask.score ?? missingScores[missingIndex++] ?? 0;
    const cases = subtask.cases ?? [];
    if (cases.length === 0) {
      throw new ProblemPackageError(`Hydro 子任务 ${id} 没有数据点。`);
    }
    return {
      id,
      score,
      type: subtask.type ?? "min",
      dependsOn: subtask.if ?? [],
      cases,
      ...(subtask.time === undefined ? {} : { time: subtask.time }),
      ...(subtask.memory === undefined ? {} : { memory: subtask.memory })
    };
  });
}

function normalizedCaseScores(subtask: NormalizedHydroSubtask): number[] {
  if (subtask.type !== "sum") {
    return subtask.cases.map((testcase) => testcase.score ?? subtask.score);
  }
  const explicit = subtask.cases.reduce((sum, testcase) => sum + (testcase.score ?? 0), 0);
  const missingCount = subtask.cases.filter((testcase) => testcase.score === undefined).length;
  const missing = distributeScore(Math.max(subtask.score - explicit, 0), missingCount);
  let missingIndex = 0;
  return subtask.cases.map((testcase) => testcase.score ?? missing[missingIndex++] ?? 0);
}

function distributeScore(total: number, count: number): number[] {
  if (count === 0) {
    return [];
  }
  const base = Math.floor(total / count);
  const lowerCount = count - (total % count);
  return Array.from({ length: count }, (_unused, index) =>
    index >= lowerCount ? base + 1 : base
  );
}

function canonicalTestdataReference(
  name: string,
  displayName: string,
  layout: HydroLayout,
  archive: SafeArchive,
  pathByName: ReadonlyMap<string, string>,
  reservedProgramNames: ReadonlySet<string>
): string {
  assertHydroFileName(name, displayName);
  if (reservedProgramNames.has(name)) {
    throw new ProblemPackageError(`${displayName} ${name} 同时被配置为评测程序，不能确定文件用途。`);
  }
  if (!archive.has(`${layout.prefix}testdata/${name}`)) {
    throw new ProblemPackageError(`${displayName} ${name} 不存在。`);
  }
  const path = pathByName.get(name);
  if (path === undefined || !path.startsWith("judge/testdata/")) {
    throw new ProblemPackageError(`${displayName} ${name} 没有安全映射到测试数据目录。`);
  }
  return path;
}

function parseHydroTime(value: string | number): number {
  if (typeof value === "number" || Number.isSafeInteger(Number(value))) {
    const parsed = Number(value);
    if (Number.isSafeInteger(parsed) && parsed > 0) return parsed;
  }
  const match = /^([0-9]+(?:\.[0-9]*)?)([mu]?)s?$/i.exec(String(value));
  if (match === null) {
    throw new ProblemPackageError(`无法识别 Hydro 时间限制 ${value}。`);
  }
  const unit = (match[2] ?? "").toLowerCase();
  const multiplier = unit === "m" ? 1 : unit === "u" ? 0.001 : 1000;
  const result = Math.floor(Number.parseFloat(match[1] ?? "0") * multiplier);
  if (!Number.isSafeInteger(result) || result <= 0) {
    throw new ProblemPackageError(`Hydro 时间限制 ${value} 转换后不是正整数毫秒。`);
  }
  return result;
}

function parseHydroMemory(value: string | number): number {
  if (typeof value === "number" || Number.isSafeInteger(Number(value))) {
    const parsed = Number(value);
    if (Number.isSafeInteger(parsed) && parsed > 0) return parsed;
  }
  const match = /^([0-9]+(?:\.[0-9]*)?)([kmg])b?$/i.exec(String(value));
  if (match === null) {
    throw new ProblemPackageError(`无法识别 Hydro 内存限制 ${value}。`);
  }
  const unit = (match[2] ?? "m").toLowerCase();
  const multiplier = unit === "k" ? 1 / 1024 : unit === "g" ? 1024 : 1;
  const result = Math.ceil(Number.parseFloat(match[1] ?? "0") * multiplier);
  if (!Number.isSafeInteger(result) || result <= 0) {
    throw new ProblemPackageError(`Hydro 内存限制 ${value} 转换后不是正整数 MiB。`);
  }
  return result;
}

function validateHydroExport(
  problem: CanonicalProblem,
  options: HydroExportOptions
): LossReport {
  const items: LossReportItem[] = [];
  const extension = readHydroExtension(problem);
  if (problem.extensions.hydro !== undefined && extension === undefined) {
    items.push({
      severity: "warning",
      path: "extensions.hydro",
      message: "Hydro 来源信息格式不正确，将不会用于恢复原格式设置。"
    });
  }
  try {
    resolveRootDirectory(options, extension);
    resolveStatementFile(options, extension);
  } catch (error) {
    items.push({
      severity: "error",
      path: "options.values",
      message: error instanceof Error ? error.message : "Hydro 导出文件名设置不正确。"
    });
  }

  if (
    problem.difficulty.codeforces !== undefined ||
    problem.difficulty.thinkingLevel !== undefined ||
    problem.difficulty.codingLevel !== undefined
  ) {
    items.push({
      severity: "warning",
      path: "difficulty",
      message: "Hydro 的难度是另一套 0 到 10 标准；本站难度不会自动换算后写入。"
    });
  }
  problem.samples.forEach((sample, index) => {
    if (sample.explanation.length > 0) {
      items.push({
        severity: "warning",
        path: `samples.${index}.explanation`,
        message: "Hydro 默认样例代码块没有独立的样例解释字段；解释会作为题面小节保留。"
      });
    }
  });

  const selected = selectedCategoriesForExport(problem, options);
  const requiredPaths = requiredJudgePaths(problem.judge, extension);
  for (const file of problem.files) {
    if (!selected.has(file.category)) {
      items.push({
        severity: requiredPaths.has(file.path) ? "error" : "warning",
        path: `files.${file.path}`,
        message: requiredPaths.has(file.path)
          ? "Hydro 评测配置仍引用这个文件，不能排除。"
          : "这个文件已按导出选择排除。"
      });
      continue;
    }
    if (file.category === "internal_attachment") {
      items.push({
        severity: "error",
        path: `files.${file.path}`,
        message: "Hydro 只有普通附件目录；导出内部附件会改变可见范围，因此已阻止。"
      });
    }
    const expectedPrefix = prefixForCategory(file.category);
    const relative = expectedPrefix === undefined ? file.path : file.path.slice(expectedPrefix.length);
    if (relative.includes("/")) {
      items.push({
        severity: "warning",
        path: `files.${file.path}`,
        message: "Hydro 官方导入器会把这一类文件放在单层目录中，导出时将只保留文件名。"
      });
    }
    if (file.category === "asset") {
      items.push({
        severity: "warning",
        path: `files.${file.path}`,
        message: "资源会进入 Hydro 的 additional_file 目录；请确认题面使用 file://文件名 引用。"
      });
    }
  }

  const selectedFiles = problem.files.filter((file) => selected.has(file.category));
  try {
    mapCanonicalFiles(selectedFiles, "problem/");
  } catch (error) {
    items.push({
      severity: "error",
      path: "files",
      message: error instanceof Error ? error.message : "文件映射到 Hydro 后发生冲突。"
    });
  }

  if (problem.judge !== undefined) {
    validateJudgeForHydro(problem, problem.judge, options, extension, selected, items);
  }
  return createLossReport(hydroAdapterId, items);
}

function validateJudgeForHydro(
  problem: CanonicalProblem,
  judge: JudgeConfig,
  options: HydroExportOptions,
  extension: HydroExtension | undefined,
  selected: ReadonlySet<CanonicalFileCategory>,
  items: LossReportItem[]
): void {
  if (judge.scoring.total > 100) {
    items.push({
      severity: "error",
      path: "judge.scoring.total",
      message: "Hydro 当前配置把总分限制在 100 分以内。"
    });
  }
  if (judge.scoring.subtaskMode !== "sum") {
    items.push({
      severity: "error",
      path: "judge.scoring.subtaskMode",
      message: "Hydro 会把各子任务得分相加，不能表达本站的全局 min 或 max 计分。"
    });
  }
  for (const subtask of judge.subtasks) {
    if (subtask.score < 1 || subtask.score > 100) {
      items.push({
        severity: "error",
        path: `judge.subtasks.${subtask.id}.score`,
        message: "Hydro 子任务分数必须在 1 到 100 之间。"
      });
    }
  }
  for (const testcase of judge.testcases) {
    if (testcase.score < 1 || testcase.score > 100) {
      items.push({
        severity: "error",
        path: `judge.testcases.${testcase.id}.score`,
        message: "Hydro 数据点分数必须在 1 到 100 之间。"
      });
    }
    if (judge.subtasks.length > 0 && testcase.subtaskId === undefined) {
      items.push({
        severity: "error",
        path: `judge.testcases.${testcase.id}.subtaskId`,
        message: "存在子任务时，每个数据点都必须明确属于一个子任务。"
      });
    }
  }
  const checkerType = selectedHydroCheckerType(options, extension);
  const usesCustomChecker =
    problem.type === "submit_answer" || judge.checker?.type === "special";
  if (
    usesCustomChecker &&
    (checkerType === undefined || checkerType === "default" || checkerType === "strict")
  ) {
    items.push({
      severity: "choice",
      path: "options.values.checkerType",
      message: "请明确选择 Hydro 调用这个判断程序的类型，例如 testlib；适配器不会根据文件内容猜测。"
    });
  }
  const requiredCategory =
    problem.type === "interactive"
      ? "interactor"
      : problem.type === "submit_answer"
        ? "answer_checker"
        : judge.checker?.type === "special"
          ? "checker"
          : undefined;
  if (requiredCategory !== undefined && !selected.has(requiredCategory)) {
    items.push({
      severity: "error",
      path: `options.includeFileCategories.${requiredCategory}`,
      message: "所选文件类别没有包含题型必需的评测程序。"
    });
  }
}

function readHydroExtension(problem: CanonicalProblem): HydroExtension | undefined {
  const value = problem.extensions.hydro;
  if (value === undefined) {
    return undefined;
  }
  const result = hydroExtensionSchema.safeParse(value);
  return result.success ? result.data : undefined;
}

function selectedCategoriesForExport(
  problem: CanonicalProblem,
  options: HydroExportOptions
): ReadonlySet<CanonicalFileCategory> {
  return new Set(
    options.includeFileCategories ?? problem.files.map((file) => file.category)
  );
}

function requiredJudgePaths(
  judge: JudgeConfig | undefined,
  extension: HydroExtension | undefined
): ReadonlySet<string> {
  const paths = new Set<string>();
  if (judge !== undefined) {
    for (const testcase of judge.testcases) {
      paths.add(testcase.input);
      if (testcase.output !== undefined) paths.add(testcase.output);
    }
    if (judge.checker?.type === "special") paths.add(judge.checker.source);
    if (judge.interactor !== undefined) paths.add(judge.interactor.source);
    if (judge.answerChecker !== undefined) paths.add(judge.answerChecker.source);
  }
  for (const name of referencedExtraFileNames(extension?.config)) {
    paths.add(`judge/testdata/${name}`);
  }
  return paths;
}

function referencedExtraFileNames(config: HydroConfig | undefined): readonly string[] {
  if (config === undefined) return [];
  const names = [
    ...(config.user_extra_files ?? []),
    ...(config.judge_extra_files ?? [])
  ];
  for (const source of [config.manager, config.validator]) {
    const name = sourceFileName(source, "Hydro 额外程序");
    if (name !== undefined) names.push(name);
  }
  return names;
}

function prefixForCategory(category: CanonicalFileCategory): string | undefined {
  if (category === "testdata") return "judge/testdata/";
  if (category === "checker") return "judge/checker/";
  if (category === "interactor") return "judge/interactor/";
  if (category === "answer_checker") return "judge/answer-checker/";
  if (category === "standard_solution") return "solutions/std/";
  if (category === "public_attachment") return "attachments/public/";
  if (category === "internal_attachment") return "attachments/internal/";
  if (category === "asset") return "assets/";
  return undefined;
}

function mapCanonicalFiles(
  files: readonly CanonicalFile[],
  prefix: string
): Map<string, ExportFileMapping> {
  const mappings = new Map<string, ExportFileMapping>();
  const targetPaths = new Map<string, string>();
  for (const file of files) {
    if (file.category === "internal_attachment") {
      continue;
    }
    const targetDirectory =
      file.category === "standard_solution"
        ? "std"
        : file.category === "public_attachment" || file.category === "asset"
          ? "additional_file"
          : "testdata";
    const targetName = file.path.split("/").at(-1);
    if (targetName === undefined) {
      throw new ProblemPackageError("无法取得导出文件名。");
    }
    assertHydroFileName(targetName, "导出文件");
    const targetPath = `${prefix}${targetDirectory}/${targetName}`;
    const previous = targetPaths.get(targetPath.toLowerCase());
    if (previous !== undefined && previous !== file.path) {
      throw new ProblemPackageError(
        `文件 ${previous} 和 ${file.path} 在 Hydro 单层目录中会发生重名。`
      );
    }
    targetPaths.set(targetPath.toLowerCase(), file.path);
    mappings.set(file.path, { file, targetPath, targetName });
  }
  return mappings;
}

function resolveRootDirectory(
  options: HydroExportOptions,
  extension: HydroExtension | undefined
): string {
  const value = options.values?.rootDirectory ?? (extension?.rootDirectory || "problem");
  if (
    value === "." ||
    value === ".." ||
    !/^[A-Za-z0-9._-]{1,120}$/.test(value) ||
    !isSafeArchivePath(`${value}/problem.yaml`)
  ) {
    throw new ProblemPackageError("Hydro 外层文件夹名称不安全，只能使用常见字母、数字、点、横线和下划线。");
  }
  return value;
}

function resolveStatementFile(
  options: HydroExportOptions,
  extension: HydroExtension | undefined
): string {
  const value = options.values?.statementFile ?? extension?.statementFile ?? "problem.md";
  if (!isHydroStatementPath(value)) {
    throw new ProblemPackageError("Hydro 题面文件必须是 problem.md 或 problem_语言.md。");
  }
  return value;
}

function selectedHydroCheckerType(
  options: HydroExportOptions,
  extension: HydroExtension | undefined
): HydroConfig["checker_type"] {
  return options.values?.checkerType ?? extension?.config?.checker_type;
}

function buildHydroConfig(
  problem: CanonicalProblem,
  judge: JudgeConfig,
  options: HydroExportOptions,
  extension: HydroExtension | undefined,
  mappings: ReadonlyMap<string, ExportFileMapping>
): HydroConfig {
  const config = { ...(extension?.config ?? {}) } as Record<string, unknown>;
  for (const key of ["type", "time", "memory", "score", "cases", "subtasks", "checker", "interactor"]) {
    delete config[key];
  }
  config.type =
    problem.type === "traditional"
      ? "default"
      : problem.type === "interactive"
        ? "interactive"
        : "submit_answer";
  config.time = `${judge.limits.timeMs}ms`;
  config.memory = `${judge.limits.memoryMiB}m`;
  config.score = judge.scoring.total;

  if (judge.subtasks.length > 0) {
    config.subtasks = judge.subtasks.map((subtask) => ({
      id: subtask.id,
      score: subtask.score,
      type: subtask.method,
      ...(subtask.dependsOn.length === 0 ? {} : { if: [...subtask.dependsOn] }),
      cases: judge.testcases
        .filter((testcase) => testcase.subtaskId === subtask.id)
        .map((testcase) => hydroCaseForExport(testcase, mappings))
    }));
  } else {
    config.cases = judge.testcases.map((testcase) => hydroCaseForExport(testcase, mappings));
  }

  if (problem.type === "interactive") {
    const source = judge.interactor?.source;
    if (source === undefined) throw new ProblemPackageError("交互题缺少交互程序。");
    const mapping = requiredExportMapping(source, mappings, "交互程序");
    config.interactor = preservedProgramSource(extension?.config?.interactor, mapping.targetName);
    delete config.checker_type;
  } else if (problem.type === "submit_answer") {
    const source = judge.answerChecker?.source;
    if (source === undefined) throw new ProblemPackageError("提交答案题缺少答案判断程序。");
    const mapping = requiredExportMapping(source, mappings, "答案判断程序");
    config.checker_type = requiredCustomCheckerType(options, extension);
    config.checker = preservedProgramSource(extension?.config?.checker, mapping.targetName);
  } else if (judge.checker?.type === "special") {
    const mapping = requiredExportMapping(judge.checker.source, mappings, "特殊判断程序");
    config.checker_type = requiredCustomCheckerType(options, extension);
    config.checker = preservedProgramSource(extension?.config?.checker, mapping.targetName);
  } else {
    const originalType = extension?.config?.checker_type;
    config.checker_type = originalType === "strict" ? "strict" : "default";
    const originalChecker = extension?.config?.checker;
    if (typeof originalChecker === "string" && !originalChecker.includes(".")) {
      config.checker = originalChecker;
      if (originalType !== undefined) config.checker_type = originalType;
    }
  }

  return hydroConfigSchema.parse(config);
}

function hydroCaseForExport(
  testcase: JudgeConfig["testcases"][number],
  mappings: ReadonlyMap<string, ExportFileMapping>
): Record<string, unknown> {
  const input = requiredExportMapping(testcase.input, mappings, "数据点输入").targetName;
  const output = testcase.output === undefined
    ? undefined
    : requiredExportMapping(testcase.output, mappings, "数据点输出").targetName;
  return {
    input,
    ...(output === undefined ? {} : { output }),
    score: testcase.score,
    ...(testcase.timeMs === undefined ? {} : { time: `${testcase.timeMs}ms` }),
    ...(testcase.memoryMiB === undefined ? {} : { memory: `${testcase.memoryMiB}m` })
  };
}

function requiredExportMapping(
  path: string,
  mappings: ReadonlyMap<string, ExportFileMapping>,
  displayName: string
): ExportFileMapping {
  const mapping = mappings.get(path);
  if (mapping === undefined) {
    throw new ProblemPackageError(`${displayName}引用的文件 ${path} 没有进入导出包。`);
  }
  return mapping;
}

function requiredCustomCheckerType(
  options: HydroExportOptions,
  extension: HydroExtension | undefined
): Exclude<HydroConfig["checker_type"], "default" | "strict" | undefined> {
  const type = selectedHydroCheckerType(options, extension);
  if (type === undefined || type === "default" || type === "strict") {
    throw new ProblemPackageError("必须明确选择 Hydro 自定义判断程序的类型。");
  }
  return type;
}

function preservedProgramSource(
  original: HydroCompilableSource | undefined,
  targetName: string
): HydroCompilableSource {
  if (typeof original === "object" && sourceFileName(original, "评测程序") !== undefined) {
    return { file: targetName, lang: original.lang };
  }
  return targetName;
}

function addOutputFile(
  files: Map<string, Uint8Array>,
  path: string,
  content: Uint8Array
): void {
  if (files.has(path)) {
    throw new ProblemPackageError(`导出 Hydro 题目包时出现重复路径 ${path}。`);
  }
  files.set(path, new Uint8Array(content));
}
