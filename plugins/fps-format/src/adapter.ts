import {
  canonicalProblemSchema,
  createLossReport,
  encodeUtf8,
  isSafeArchivePath,
  ProblemPackageError,
  type ArchiveSummary,
  type CanonicalFile,
  type CanonicalProblem,
  type DetectionResult,
  type ExportOptions,
  type GeneratedArchive,
  type ImportChoices,
  type ImportIssue,
  type ImportPreview,
  type LossReport,
  type LossReportItem,
  type ProblemFormatAdapter,
  type SafeArchive
} from "@urmotiv/problem-package";
import {
  fpsAdapterId,
  fpsAdapterVersion,
  fpsExportOptionsSchema,
  fpsExtensionSchema,
  fpsImportChoicesSchema,
  fpsProblemMediaType,
  fpsSupportedRevision,
  type FpsExportOptions,
  type FpsExtension,
  type FpsProgramEntry
} from "./schema";
import {
  parseFpsXmlContent,
  type FpsImageEntry,
  type FpsLimit,
  type FpsTestDataEntry,
  type ParsedFpsDocument,
  type ParsedFpsItem
} from "./parser";

const testdataDirectory = "judge/testdata/";
const testOutputSuffix = ".out";

/**
 * 最小 FPS 语义适配器。导入支持一个文件中的多个 item，每个 item 完整转换
 * 为一道题目，绝不静默截取第一题；统一结构没有对应项的字段（评测程序正文、
 * 多份 solution、prepend/template/append、来源信息等）只写入带 fps 来源标记
 * 的扩展，绝不猜测评测行为或编造难度。
 */
export const fpsProblemFormatAdapter: ProblemFormatAdapter = {
  id: fpsAdapterId,
  displayName: "FPS XML 题目包",
  version: fpsAdapterVersion,
  inputKind: "single_file",

  async detect(input: ArchiveSummary): Promise<DetectionResult> {
    if (input.entries.length === 1 && input.entries[0]?.path === "problem.xml") {
      return {
        confidence: 0.3,
        reason: "单个原始 XML 符合 FPS 的传输形式；是否真的含有 FPS 语义需要解析内容确认。"
      };
    }
    return { confidence: 0, reason: "FPS 只接受未经压缩的单个原始 XML。" };
  },

  async inspect(input: SafeArchive): Promise<ImportPreview> {
    const files = input.list().map((entry) => entry.path).sort();
    try {
      const document = parseFpsPackage(input);
      if (document.items.length === 0) {
        return {
          formatId: fpsAdapterId,
          problemCount: 0,
          files,
          issues: [
            {
              severity: "warning",
              message: "FPS 文件不包含任何 item。"
            }
          ]
        };
      }
      const multiple = document.items.length > 1;
      return {
        formatId: fpsAdapterId,
        problemCount: document.items.length,
        ...(multiple || document.items[0]?.title === undefined
          ? {}
          : { title: document.items[0].title }),
        files,
        issues: document.items.flatMap((item, index) =>
          inspectIssues(document, item).map((issue) =>
            multiple && issue.path !== undefined
              ? { ...issue, path: `item${index}.${issue.path}` }
              : issue
          )
        )
      };
    } catch (error) {
      return {
        formatId: fpsAdapterId,
        problemCount: 0,
        files,
        issues: [
          {
            severity: "error",
            message: error instanceof Error ? error.message : "无法读取 FPS 题目包。"
          }
        ]
      };
    }
  },
  async import(input: SafeArchive, choices: ImportChoices): Promise<readonly CanonicalProblem[]> {
    fpsImportChoicesSchema.parse(choices);
    const document = parseFpsPackage(input);
    if (document.items.length === 0) {
      throw new ProblemPackageError("FPS 文件不包含任何 item。");
    }
    return document.items.map((item) => {
      const files = collectCanonicalFiles(item);
      const extension = buildExtension(item);
      return canonicalProblemSchema.parse({
        title: item.title,
        type: "traditional",
        tags: [],
        difficulty: {},
        content: {
          basicStatement: item.description,
          basicSolution: "原题包未包含说明性题解。",
          background: "",
          statement: item.description,
          ...(item.inputFormat === undefined
            ? { inputFormat: "" }
            : { inputFormat: item.inputFormat }),
          ...(item.outputFormat === undefined
            ? { outputFormat: "" }
            : { outputFormat: item.outputFormat }),
          constraints: "",
          solution: "",
          ...(item.hint === undefined ? { hints: "" } : { hints: item.hint })
        },
        samples: pairSamples(item),
        files,
        provenance: {
          sourceSystem: "fps",
          ...(item.remoteId === undefined ? {} : { sourceProblemId: item.remoteId }),
          sourceRevision: fpsSupportedRevision
        },
        extensions: { fps: extension }
      });
    });
  },

  async validateExport(
    problem: CanonicalProblem,
    options: ExportOptions
  ): Promise<LossReport> {
    const parsedProblem = canonicalProblemSchema.parse(problem);
    const parsedOptions = fpsExportOptionsSchema.parse(options);
    return validateFpsExport(parsedProblem, parsedOptions);
  },

  async export(problem: CanonicalProblem, options: ExportOptions): Promise<GeneratedArchive> {
    const parsedProblem = canonicalProblemSchema.parse(problem);
    const parsedOptions = fpsExportOptionsSchema.parse(options);
    const lossReport = validateFpsExport(parsedProblem, parsedOptions);
    if (!lossReport.canExport) {
      throw new ProblemPackageError("当前题目信息不能直接转换成 FPS XML，请先处理导出报告中的问题。");
    }
    const xml = renderFpsXml(parsedProblem, parsedOptions);
    return {
      kind: "single_file",
      mediaType: fpsProblemMediaType,
      fileName: "problem.xml",
      content: encodeUtf8(xml)
    };
  }
};

export function parseFpsPackage(archive: SafeArchive): ParsedFpsDocument {
  const bytes = archive.read("problem.xml");
  if (bytes === undefined) {
    throw new ProblemPackageError("FPS 适配器没有收到原始 XML 文件。");
  }
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    throw new ProblemPackageError("FPS 原始 XML 不是 UTF-8 文本。");
  }
  return parseFpsXmlContent(text);
}

function inspectIssues(
  document: ParsedFpsDocument,
  item: ParsedFpsItem
): readonly ImportIssue[] {
  const issues: ImportIssue[] = [];
  if (document.generators > 0) {
    issues.push({
      severity: "info",
      path: "fps.generators",
      message: "FPS 根部的 generator 条目只是名目信息，不会作为题目内容导入。"
    });
  }
  if (item.sampleInputs.length !== item.sampleOutputs.length) {
    issues.push({
      severity: "error",
      path: "samples",
      message: "FPS 的 sample_input 与 sample_output 数量不一致，导入会被拒绝。"
    });
  }
  if (item.solutions.length > 0) {
    issues.push({
      severity: "info",
      path: "solution",
      message: "FPS 的 solution 是程序正文，只随来源信息保留，不当作说明性题解导入。"
    });
  }
  if (item.spj !== undefined || item.tpj !== undefined || item.interactor !== undefined) {
    issues.push({
      severity: "info",
      path: "spj/tpj/interactor",
      message: "FPS 评测程序正文只随来源信息保留，本站不猜想它们的运行方式。"
    });
  }
  if (item.images.length > 0) {
    issues.push({
      severity: "info",
      path: "img",
      message: "FPS 内嵌图片会作为资源文件导入，引用路径需要重新检查。"
    });
  }
  if (item.inputFormat === undefined && item.outputFormat === undefined) {
    issues.push({
      severity: "info",
      path: "description",
      message: "FPS item 没有独立的输入输出格式说明。"
    });
  }
  return issues;
}

function pairSamples(item: ParsedFpsItem): CanonicalProblem["samples"] {
  if (item.sampleInputs.length !== item.sampleOutputs.length) {
    throw new ProblemPackageError("FPS 的 sample_input 与 sample_output 数量不一致，已拒绝导入。");
  }
  return item.sampleInputs.map((input, index) => ({
    input,
    output: item.sampleOutputs[index] ?? "",
    explanation: ""
  }));
}

function collectCanonicalFiles(item: ParsedFpsItem): readonly CanonicalFile[] {
  const files: CanonicalFile[] = [];
  const usedPaths = new Set<string>();
  for (const output of item.testOutputs) {
    addTestDataFile(files, usedPaths, output, true);
  }
  for (const input of item.testInputs) {
    addTestDataFile(files, usedPaths, input, false);
  }
  for (const image of item.images) {
    addAssetFile(files, usedPaths, image);
  }
  return files;
}

function addTestDataFile(
  files: CanonicalFile[],
  usedPaths: Set<string>,
  entry: FpsTestDataEntry,
  isOutput: boolean
): void {
  const name = entry.name;
  if (
    name.length === 0 ||
    name.includes("/") ||
    name.includes("\\") ||
    name.endsWith(testOutputSuffix)
  ) {
    throw new ProblemPackageError("FPS 测试数据名称必须是单个安全的文件名，不能为空、包含路径或与输出命名冲突。");
  }
  const path = `${testdataDirectory}${name}${isOutput ? testOutputSuffix : ""}`;
  if (!isSafeArchivePath(path)) {
    throw new ProblemPackageError(`FPS 测试数据名称 ${name} 不是安全的题目包文件名。`);
  }
  if (usedPaths.has(path)) {
    throw new ProblemPackageError(`FPS 测试数据映射后出现重复路径 ${path}。`);
  }
  usedPaths.add(path);
  files.push({
    path,
    category: "testdata",
    content: encodeUtf8(entry.text)
  });
}

function addAssetFile(
  files: CanonicalFile[],
  usedPaths: Set<string>,
  image: FpsImageEntry
): void {
  const path = `assets/${image.src}`;
  if (!isSafeArchivePath(path)) {
    throw new ProblemPackageError("FPS img 的 src 不是安全的题目包内部路径。");
  }
  if (usedPaths.has(path)) {
    throw new ProblemPackageError(`FPS 内嵌图片映射后出现重复路径 ${path}。`);
  }
  usedPaths.add(path);
  let bytes: Uint8Array;
  try {
    bytes = base64ToBytes(image.base64);
  } catch {
    throw new ProblemPackageError("FPS img 的 base64 无法解码。");
  }
  files.push({ path, category: "asset", content: bytes });
}

function base64ToBytes(base64: string): Uint8Array {
  const decoded = atob(base64);
  const bytes = new Uint8Array(decoded.length);
  for (let index = 0; index < decoded.length; index += 1) {
    bytes[index] = decoded.charCodeAt(index);
  }
  return bytes;
}

function buildExtension(item: ParsedFpsItem): FpsExtension {
  const outputNames = item.testOutputs.map((output) => output.name);
  const inputNames = item.testInputs.map((test) => test.name);
  return fpsExtensionSchema.parse({
    revision: fpsSupportedRevision,
    solutions: item.solutions.map((solution) => ({
      language: solution.language,
      text: solution.text
    })),
    prepends: item.prepends.map(programEntryJson),
    templates: item.templates.map(programEntryJson),
    appends: item.appends.map(programEntryJson),
    ...(item.timeLimit === undefined ? {} : { timeLimit: subsetLimit(item.timeLimit) }),
    ...(item.memoryLimit === undefined
      ? {}
      : { memoryLimit: subsetLimit(item.memoryLimit) }),
    ...(item.spj === undefined ? {} : { spj: programEntryJson(item.spj) }),
    ...(item.tpj === undefined ? {} : { tpj: programEntryJson(item.tpj) }),
    ...(item.interactor === undefined
      ? {}
      : { interactor: programEntryJson(item.interactor) }),
    ...(inputNames.length === 0 && outputNames.length === 0
      ? {}
      : { testData: { inputNames, outputNames } }),
    ...(item.url === undefined ? {} : { url: item.url }),
    ...(item.source === undefined ? {} : { source: item.source }),
    ...(item.remoteOj === undefined ? {} : { remoteOj: item.remoteOj }),
    ...(item.remoteId === undefined ? {} : { remoteId: item.remoteId })
  });
}

function subsetLimit(limit: FpsLimit): { raw: string; unit?: string } {
  if (limit.unit === undefined) {
    return { raw: limit.raw };
  }
  return { raw: limit.raw, unit: limit.unit };
}

function programEntryJson(entry: FpsProgramEntry | { language?: string; text: string }): { language?: string; text: string } {
  return entry.language === undefined ? { text: entry.text } : { language: entry.language, text: entry.text };
}

function readFpsExtension(problem: CanonicalProblem): FpsExtension | undefined {
  const value = problem.extensions.fps;
  if (value === undefined) {
    return undefined;
  }
  const result = fpsExtensionSchema.safeParse(value);
  return result.success ? result.data : undefined;
}

function validateFpsExport(problem: CanonicalProblem, options: FpsExportOptions): LossReport {
  const items: LossReportItem[] = [];
  const extension = readFpsExtension(problem);
  if (problem.extensions.fps !== undefined && extension === undefined) {
    items.push({
      severity: "warning",
      path: "extensions.fps",
      message: "FPS 来源信息格式不正确，将不会用于恢复原格式设置。"
    });
  }

  if (problem.type !== "traditional") {
    const required =
      problem.type === "interactive" ? "interactor" : "tpj";
    if (extension?.[required] === undefined) {
      items.push({
        severity: "error",
        path: "type",
        message: `FPS 没有本站题型 ${problem.type} 的对应表示，原包没有保存对应的评测程序正文，不能导出。`
      });
    }
  } else if (problem.judge?.checker?.type === "special" && extension?.spj === undefined) {
    items.push({
      severity: "error",
      path: "judge.checker",
      message: "FPS 需要原包保存的 spj 程序正文才能表达本站特殊判断；不猜测它的调用方式。"
    });
  }

  if (problem.content.constraints.length > 0) {
    items.push({
      severity: "warning",
      path: "content.constraints",
      message: "FPS 没有约束字段，本站约束文本不会写入导出包。"
    });
  }
  problem.samples.forEach((sample, index) => {
    if (sample.explanation.length > 0) {
      items.push({
        severity: "warning",
        path: `samples.${index}.explanation`,
        message: "FPS 样例没有独立的解释字段；解释不会写入导出包。"
      });
    }
  });
  if (problem.tags.length > 0) {
    items.push({
      severity: "warning",
      path: "tags",
      message: "FPS 没有标签字段，本站标签不会写入导出包。"
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
      message: "FPS 没有难度字段，本站难度不会写入导出包。"
    });
  }
  if (problem.content.background.length > 0) {
    items.push({
      severity: "warning",
      path: "content.background",
      message: "FPS 没有背景字段，本站背景不会写入导出包。"
    });
  }

  const selected = selectedCategoriesForExport(problem, options);
  for (const file of problem.files) {
    if (!selected.has(file.category)) {
      items.push({
        severity: "warning",
        path: `files.${file.path}`,
        message: "这个文件已按导出选择排除。"
      });
      continue;
    }
    if (file.category === "internal_attachment" || file.category === "public_attachment") {
      items.push({
        severity: "error",
        path: `files.${file.path}`,
        message: "FPS XML 没有附件可见范围，不能保证附件语义，已阻止导出。"
      });
    }
    if (
      file.category === "checker" ||
      file.category === "interactor" ||
      file.category === "answer_checker"
    ) {
      items.push({
        severity: "error",
        path: `files.${file.path}`,
        message: "FPS 需要原包保存的程序正文才能表达评测程序；单独的程序文件不能无依据写进 XML。"
      });
    }
    if (file.category === "standard_solution" && extension?.solutions.length === 0) {
      items.push({
        severity: "error",
        path: `files.${file.path}`,
        message: "FPS 需要原包保存的 solution 正文才能保留标准程序，否则不猜测其含义。"
      });
    }
  }

  const hasTestDataFiles = problem.files.some(
    (file) => file.category === "testdata" && selected.has(file.category)
  );
  const hasJudgeTestcases = (problem.judge?.testcases.length ?? 0) > 0;
  if (hasTestDataFiles && !hasJudgeTestcases && extension?.testData === undefined) {
    items.push({
      severity: "error",
      path: "files.testdata",
      message: "测试数据文件缺少评测配置和来源信息，无法确定它们在 FPS 中的成对名称。"
    });
  }
  return createLossReport(fpsAdapterId, items);
}

function selectedCategoriesForExport(
  problem: CanonicalProblem,
  options: FpsExportOptions
): ReadonlySet<CanonicalProblem["files"][number]["category"]> {
  return new Set(options.includeFileCategories ?? problem.files.map((file) => file.category));
}

interface ExportTestData {
  readonly inputs: Readonly<Record<string, string>>;
  readonly outputs: Readonly<Record<string, string>>;
}

function testdataForExport(
  problem: CanonicalProblem,
  extension: FpsExtension | undefined,
  selected: ReadonlySet<CanonicalProblem["files"][number]["category"]>
): ExportTestData {
  const inputs: Record<string, string> = {};
  const outputs: Record<string, string> = {};
  if ((problem.judge?.testcases.length ?? 0) > 0) {
    const byPath = new Map(problem.files.map((file) => [file.path, file]));
    for (const testcase of problem.judge?.testcases ?? []) {
      const inputFile = byPath.get(testcase.input);
      if (inputFile === undefined) {
        throw new ProblemPackageError(`评测配置引用的输入文件 ${testcase.input} 不存在。`);
      }
      inputs[testcase.id] = utf8Text(inputFile.content, testcase.input);
      if (testcase.output !== undefined) {
        const outputFile = byPath.get(testcase.output);
        if (outputFile === undefined) {
          throw new ProblemPackageError(`评测配置引用的输出文件 ${testcase.output} 不存在。`);
        }
        outputs[testcase.id] = utf8Text(outputFile.content, testcase.output);
      }
    }
    return { inputs, outputs };
  }
  if (extension?.testData !== undefined && selected.has("testdata")) {
    const byPath = new Map(problem.files.map((file) => [file.path, file]));
    for (const name of extension.testData.inputNames) {
      const file = byPath.get(`${testdataDirectory}${name}`);
      if (file === undefined) {
        throw new ProblemPackageError(`来源信息中的测试输入 ${name} 没有对应文件。`);
      }
      inputs[name] = utf8Text(file.content, file.path);
    }
    for (const name of extension.testData.outputNames) {
      const file = byPath.get(`${testdataDirectory}${name}${testOutputSuffix}`);
      if (file === undefined) {
        throw new ProblemPackageError(`来源信息中的测试输出 ${name} 没有对应文件。`);
      }
      outputs[name] = utf8Text(file.content, file.path);
    }
    return { inputs, outputs };
  }
  return { inputs, outputs };
}

function utf8Text(bytes: Uint8Array, path: string): string {
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes);
  } catch {
    throw new ProblemPackageError(`文件 ${path} 不是 UTF-8 文本，不能写入 FPS XML。`);
  }
}

function renderFpsXml(problem: CanonicalProblem, options: FpsExportOptions): string {
  const extension = readFpsExtension(problem) ?? emptyExtension();
  const selected = selectedCategoriesForExport(problem, options);
  const testdata = testdataForExport(problem, extension, selected);
  const lines = ['<?xml version="1.0" encoding="UTF-8"?>', "<fps>", "  <item>"];

  lines.push(escapedElement("title", problem.title));
  if (problem.content.background.length > 0) {
    lines.push(escapedElement("description", `${problem.content.background}\n\n${problem.content.statement || problem.content.basicStatement}`));
  } else {
    lines.push(escapedElement("description", problem.content.statement || problem.content.basicStatement));
  }
  if (extension.timeLimit !== undefined) {
    lines.push(limitElement("time_limit", extension.timeLimit));
  }
  if (extension.memoryLimit !== undefined) {
    lines.push(limitElement("memory_limit", extension.memoryLimit));
  }
  if (problem.content) {
    lines.push(escapedElement("input", problem.content.inputFormat));
  }
  if (problem.content.outputFormat.length > 0) {
    lines.push(escapedElement("output", problem.content.outputFormat));
  }
  if (problem.content.hints.length > 0) {
    lines.push(escapedElement("hint", problem.content.hints));
  }
  for (const sample of problem.samples) {
    lines.push(`  <sample_input>${escapedText(sample.input)}</sample_input>`);
    lines.push(`  <sample_output>${escapedText(sample.output)}</sample_output>`);
  }
  for (const name of Object.keys(testdata.inputs).sort()) {
    lines.push(`  <test_input name="${escapedAttribute(name)}">${escapedText(testdata.inputs[name] ?? "")}</test_input>`);
  }
  for (const name of Object.keys(testdata.outputs).sort()) {
    lines.push(`  <test_output name="${escapedAttribute(name)}">${escapedText(testdata.outputs[name] ?? "")}</test_output>`);
  }
  for (const solution of extension.solutions) {
    lines.push(`  <solution language="${escapedAttribute(solution.language)}">${escapedText(solution.text)}</solution>`);
  }
  for (const program of extension.prepends) {
    lines.push(`  <prepend language="${escapedAttribute(requiredLanguage(program))}">${escapedText(program.text)}</prepend>`);
  }
  for (const program of extension.templates) {
    lines.push(`  <template language="${escapedAttribute(requiredLanguage(program))}">${escapedText(program.text)}</template>`);
  }
  for (const program of extension.appends) {
    lines.push(`  <append language="${escapedAttribute(requiredLanguage(program))}">${escapedText(program.text)}</append>`);
  }
  if (extension.spj !== undefined) {
    lines.push(`  <spj${languageAttribute(extension.spj)}>${escapedText(extension.spj.text)}</spj>`);
  }
  if (extension.tpj !== undefined) {
    lines.push(`  <tpj${languageAttribute(extension.tpj)}>${escapedText(extension.tpj.text)}</tpj>`);
  }
  if (extension.interactor !== undefined) {
    lines.push(`  <interactor${languageAttribute(extension.interactor)}>${escapedText(extension.interactor.text)}</interactor>`);
  }
  if (extension.source !== undefined) {
    lines.push(escapedElement("source", extension.source));
  }
  if (extension.url !== undefined) {
    lines.push(escapedElement("url", extension.url));
  }
  if (extension.remoteOj !== undefined) {
    lines.push(escapedElement("remote_oj", extension.remoteOj));
  }
  if (extension.remoteId !== undefined) {
    lines.push(escapedElement("remote_id", extension.remoteId));
  }
  for (const image of problem.files) {
    if (image.category === "asset" && selected.has("asset")) {
      lines.push(
        `  <img><src>${escapedText(basename(image.path))}</src><base64>${toBase64(image.content)}</base64></img>`
      );
    }
  }
  lines.push("  </item>", "</fps>");
  return `${lines.join("\n")}\n`;
}

function emptyExtension(): FpsExtension {
  return {
    revision: fpsSupportedRevision,
    solutions: [],
    prepends: [],
    templates: [],
    appends: []
  };
}

function basename(path: string): string {
  const last = path.split("/").at(-1);
  if (last === undefined || last.length === 0) {
    throw new ProblemPackageError("资源文件没有可用的文件名。");
  }
  return last;
}

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return btoa(binary);
}

function requiredLanguage(program: FpsProgramEntry): string {
  if (program.language === undefined || program.language.trim().length === 0) {
    throw new ProblemPackageError("FPS 的 prepend/template/append 必须带语言属性，来源信息缺少。");
  }
  return program.language;
}

function languageAttribute(program: FpsProgramEntry): string {
  return program.language === undefined
    ? ""
    : ` language="${escapedAttribute(program.language)}"`;
}

function escapedElement(name: string, text: string): string {
  return `  <${name}>${escapedText(text)}</${name}>`;
}

function limitElement(name: string, limit: { raw: string; unit?: string | undefined }): string {
  const unit = limit.unit === undefined ? "" : ` unit="${escapedAttribute(limit.unit)}"`;
  return `  <${name}${unit}>${escapedText(limit.raw)}</${name}>`;
}

function escapedText(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function escapedAttribute(value: string): string {
  return escapedText(value).replace(/"/g, "&quot;");
}
