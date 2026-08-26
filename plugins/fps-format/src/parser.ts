import { XMLParser } from "fast-xml-parser";
import {
  isSafeArchivePath,
  ProblemPackageError
} from "@urmotiv/problem-package";
import {
  fpsMemoryLimitUnits,
  fpsTimeLimitUnits
} from "./schema";
import {
  type FpsProgramEntry
} from "./schema";

/**
 * 解析结果保持与 DTD 元素名称一致的扁平结构；所有拒绝都发生在字节进入
 * 统一结构之前，且只携带元素名和简短原因，不包含题面或程序正文。
 */

export interface FpsLimit {
  readonly raw: string;
  readonly unit?: string;
}

export interface FpsSolutionEntry {
  readonly language: string;
  readonly text: string;
}

export interface FpsTestDataEntry {
  readonly name: string;
  readonly text: string;
}

export interface FpsImageEntry {
  readonly src: string;
  readonly base64: string;
}

export interface ParsedFpsItem {
  readonly title: string;
  readonly url?: string;
  readonly timeLimit: FpsLimit;
  readonly memoryLimit: FpsLimit;
  readonly description: string;
  readonly inputFormat?: string;
  readonly outputFormat?: string;
  readonly hint?: string;
  readonly source?: string;
  readonly remoteOj?: string;
  readonly remoteId?: string;
  readonly sampleInputs: readonly string[];
  readonly sampleOutputs: readonly string[];
  readonly testInputs: readonly FpsTestDataEntry[];
  readonly testOutputs: readonly FpsTestDataEntry[];
  readonly solutions: readonly FpsSolutionEntry[];
  readonly prepends: readonly FpsProgramEntry[];
  readonly templates: readonly FpsProgramEntry[];
  readonly appends: readonly FpsProgramEntry[];
  readonly spj?: FpsProgramEntry;
  readonly tpj?: FpsProgramEntry;
  readonly interactor?: FpsProgramEntry;
  readonly images: readonly FpsImageEntry[];
}

export interface ParsedFpsDocument {
  readonly itemCount: number;
  readonly generators: number;
  readonly items: readonly ParsedFpsItem[];
}

interface ElementNode {
  readonly name: string;
  /** 当前元素自身声明的属性（不含 "#text"）。 */
  readonly attributes: Readonly<Record<string, unknown>>;
  /** 元素正文：字符串或带 #text 的对象。 */
  readonly text: string;
  /** 元素原始对象（仅在解析容器元素时使用）。 */
  readonly object?: Record<string, unknown>;
}

type XmlRecord = Record<string, unknown>;

const attributePrefix = "@";

const xmlParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: attributePrefix,
  parseTagValue: false,
  parseAttributeValue: false,
  processEntities: true,
  trimValues: false
});

const allowedLeafAttributes: Readonly<Record<string, readonly string[]>> = {
  title: [],
  url: [],
  time_limit: ["unit"],
  memory_limit: ["unit"],
  description: [],
  input: [],
  output: [],
  hint: [],
  source: [],
  remote_oj: [],
  remote_id: [],
  sample_input: [],
  sample_output: [],
  test_input: ["name"],
  test_output: ["name"],
  solution: ["language"],
  prepend: ["language"],
  template: ["language"],
  append: ["language"],
  spj: ["language"],
  tpj: ["language"],
  interactor: ["language"]
};

const fpsRepeatedElementNames = new Set([
  "sample_input",
  "sample_output",
  "test_input",
  "test_output",
  "solution",
  "prepend",
  "template",
  "append",
  "img"
]);

function isFpsRepeatedElement(name: string): boolean {
  return fpsRepeatedElementNames.has(name);
}
const requiredLanguageElements = new Set(["solution", "prepend", "template", "append"]);
const timeLimitUnitSet = new Set<string>(fpsTimeLimitUnits);
const memoryLimitUnitSet = new Set<string>(fpsMemoryLimitUnits);
const fpsChildren = new Set(["generator", "item"]);

/**
 * 解析单个原始 XML 的 FPS 语义。不接触 DOCTYPE、外部实体或网络；出现未声明
 * 的元素或属性时一律拒绝，而不是猜测含义。方法不接受任何外部输入地址。
 */
export function parseFpsXmlContent(content: string): ParsedFpsDocument {
  if (/<!DOCTYPE|<!ENTITY/i.test(content)) {
    throw new ProblemPackageError("FPS 文件包含 DTD 声明，为保持确定性行为已拒绝导入。");
  }

  let parsed: unknown;
  try {
    parsed = xmlParser.parse(content);
  } catch (error) {
    const detail = error instanceof Error ? error.message : "";
    throw new ProblemPackageError(`FPS XML 无法解析${detail.length === 0 ? "。" : `：${detail}`}`);
  }

  const root = asRecord(parsed);
  if (root === undefined) {
    throw new ProblemPackageError("FPS 文件缺少根元素内容。");
  }
  const fpsNodes = elementListOf(root, "fps");
  if (fpsNodes.length !== 1) {
    throw new ProblemPackageError("FPS 文件必须以 fps 为根元素。");
  }
  const fpsRoot = fpsRootOf(fpsNodes[0]);
  if (fpsRoot === undefined) {
    throw new ProblemPackageError("FPS 根元素内容无法读取。");
  }

  const children = childElements(fpsRoot);
  const residual = children
    .map((child) => child.name)
    .filter((name) => !fpsChildren.has(name));
  if (residual.length > 0) {
    throw new ProblemPackageError(`FPS 根元素包含不支持的子元素 ${residual.join("、")}。`);
  }
  const generatorCount = children.filter((child) => child.name === "generator").length;
  const itemElements = children.filter((child) => child.name === "item");
  return {
    itemCount: itemElements.length,
    generators: generatorCount,
    items: itemElements.map(parseItem)
  };
}

function parseItem(element: ElementNode): ParsedFpsItem {
  const object = element.object;
  if (object === undefined) {
    throw new ProblemPackageError("FPS item 没有元素内容。");
  }
  const children = childElements(object);
const seenSingleton = new Set<string>();
for (const child of children) {
  if (isFpsRepeatedElement(child.name)) {
    continue;
  }
  if (seenSingleton.has(child.name)) {
    throw new ProblemPackageError(`FPS item 包含重复的元素 ${child.name}，含义不明确已拒绝。`);
  }
  seenSingleton.add(child.name);
}

  const item: MutableFpsItem = {
    title: "",
    timeLimit: { raw: "" },
    memoryLimit: { raw: "" },
    description: "",
    sampleInputs: [],
    sampleOutputs: [],
    testInputs: [],
    testOutputs: [],
    solutions: [],
    prepends: [],
    templates: [],
    appends: [],
    images: []
  };

  for (const child of children) {
    assignItemField(item, child);
  }

  if (item.title.length === 0) {
    throw new ProblemPackageError("FPS item 缺少标题。");
  }
  if (item.timeLimit.raw.length === 0 || item.memoryLimit.raw.length === 0) {
    throw new ProblemPackageError("FPS item 缺少时间或内存限制。");
  }
  if (item.description.length === 0) {
    throw new ProblemPackageError("FPS item 缺少题面描述。");
  }
  return item;
}

type MutableFpsItem = {
	title: string;
	url?: string;
	timeLimit: FpsLimit;
	memoryLimit: FpsLimit;
	description: string;
	inputFormat?: string;
	outputFormat?: string;
	hint?: string;
	source?: string;
	remoteOj?: string;
	remoteId?: string;
	sampleInputs: string[];
	sampleOutputs: string[];
	testInputs: FpsTestDataEntry[];
	testOutputs: FpsTestDataEntry[];
	solutions: FpsSolutionEntry[];
	prepends: FpsProgramEntry[];
	templates: FpsProgramEntry[];
	appends: FpsProgramEntry[];
	spj?: FpsProgramEntry;
	tpj?: FpsProgramEntry;
	interactor?: FpsProgramEntry;
	images: FpsImageEntry[];
};

function assignItemField(item: MutableFpsItem, child: ElementNode): void {
  switch (child.name) {
    case "title":
      item.title = child.text;
      return;
    case "url":
      item.url = child.text;
      return;
    case "time_limit":
      item.timeLimit = parseLimit(child, timeLimitUnitSet);
      return;
    case "memory_limit":
      item.memoryLimit = parseLimit(child, memoryLimitUnitSet);
      return;
    case "description":
      item.description = child.text;
      return;
    case "input":
      item.inputFormat = child.text;
      return;
    case "output":
      item.outputFormat = child.text;
      return;
    case "hint":
      item.hint = child.text;
      return;
    case "source":
      item.source = child.text;
      return;
    case "remote_oj":
      item.remoteOj = child.text;
      return;
    case "remote_id":
      item.remoteId = child.text;
      return;
    case "sample_input":
      item.sampleInputs.push(child.text);
      return;
    case "sample_output":
      item.sampleOutputs.push(child.text);
      return;
    case "test_input":
      item.testInputs.push(parseTestData(child));
      return;
    case "test_output":
      item.testOutputs.push(parseTestData(child));
      return;
    case "solution":
      item.solutions.push(parseSolution(child));
      return;
    case "prepend":
      item.prepends.push(parseProgramEntry(child));
      return;
    case "template":
      item.templates.push(parseProgramEntry(child));
      return;
    case "append":
      item.appends.push(parseProgramEntry(child));
      return;
    case "spj":
      item.spj = parseProgramEntry(child);
      return;
    case "tpj":
      item.tpj = parseProgramEntry(child);
      return;
    case "interactor":
      item.interactor = parseProgramEntry(child);
      return;
    case "img":
      item.images.push(parseImage(child));
      return;
    default:
      throw new ProblemPackageError(`FPS item 包含不支持的元素 ${child.name}。`);
  }
}

function parseLimit(child: ElementNode, units: ReadonlySet<string>): FpsLimit {
  assertAllowedAttributes(child);
  const text = child.text.trim();
  if (text.length === 0) {
    throw new ProblemPackageError(`FPS 元素 ${child.name} 缺少数值。`);
  }
  if (!/^[0-9]+(?:\.[0-9]+)?$/.test(text)) {
    throw new ProblemPackageError(`FPS 元素 ${child.name} 的数值不是十进制正数。`);
  }
  const unit = typeof child.attributes["unit"] === "string" ? child.attributes["unit"] : undefined;
  if (unit !== undefined && !units.has(unit)) {
    throw new ProblemPackageError(`FPS 元素 ${child.name} 使用了不受支持的单位 ${unit}。`);
  }
  return unit === undefined || unit.length === 0
    ? { raw: text }
    : { raw: text, unit };
}

function parseTestData(child: ElementNode): FpsTestDataEntry {
  assertAllowedAttributes(child);
  const name = child.attributes["name"];
  if (typeof name !== "string" || name.trim().length === 0) {
    throw new ProblemPackageError(`FPS 元素 ${child.name} 缺少配对所需的 name 属性。`);
  }
  return { name: name.trim(), text: child.text };
}

function parseSolution(child: ElementNode): FpsSolutionEntry {
  assertAllowedAttributes(child);
  const language = child.attributes["language"];
  if (typeof language !== "string" || language.trim().length === 0) {
    throw new ProblemPackageError("FPS solution 元素缺少必填的 language 属性。");
  }
  return { language: language.trim(), text: child.text };
}

function parseRequiredLanguageEntry(child: ElementNode): FpsProgramEntry {
  const language = child.attributes["language"];
  if (typeof language !== "string" || language.trim().length === 0) {
    throw new ProblemPackageError(`FPS 元素 ${child.name} 缺少必填的 language 属性。`);
  }
  return { language: language.trim(), text: child.text };
}

function parseProgramEntry(child: ElementNode): FpsProgramEntry {
  assertAllowedAttributes(child);
  if (requiredLanguageElements.has(child.name)) {
    return parseRequiredLanguageEntry(child);
  }
  const language = child.attributes.language;
  return typeof language === "string" && language.trim().length > 0
    ? { language: language.trim(), text: child.text }
    : { text: child.text };
}

function parseImage(child: ElementNode): FpsImageEntry {
  assertAllowedAttributes(child);
  const object = child.object;
  if (object === undefined) {
    throw new ProblemPackageError("FPS img 元素缺少内容。");
  }
  const srcValues = stringValues(object["src"]);
  const base64Values = stringValues(object["base64"]);
  if (srcValues.length !== 1 || base64Values.length !== 1) {
    throw new ProblemPackageError("FPS img 必须恰好包含一个 src 和一个 base64。");
  }
  const src = srcValues[0] ?? "";
  const base64 = base64Values[0] ?? "";
  if (src.length === 0 || base64.length === 0) {
    throw new ProblemPackageError("FPS img 的 src 或 base64 为空。");
  }
  if (!isSafeArchivePath(`assets/${src}`)) {
    throw new ProblemPackageError("FPS img 的 src 不是安全的题目包内部路径。");
  }
  return { src, base64 };
}

function stringValues(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.every((entry) => typeof entry === "string") ? value.slice() : [];
  }
  return typeof value === "string" ? [value] : [];
}

function assertAllowedAttributes(child: ElementNode): void {
  const allowed = allowedLeafAttributes[child.name];
  if (allowed === undefined) {
    return;
  }
  const names = Object.keys(child.attributes);
  for (const name of names) {
    if (!allowed.includes(name)) {
      throw new ProblemPackageError(`FPS 元素 ${child.name} 包含不支持的属性 ${name}。`);
    }
  }
}

/** 返回节点的所有元素子节点；属性以 @ 开头，正文放在 #text，都不算子元素。 */
function childElements(node: XmlRecord): ElementNode[] {
  const children: ElementNode[] = [];
  for (const key of Object.keys(node)) {
    if (key.startsWith(attributePrefix) || key === "#text") {
      continue;
    }
    const value = node[key];
    if (Array.isArray(value)) {
      for (const item of value) {
        children.push(elementNodeOf(key, item));
      }
    } else {
      children.push(elementNodeOf(key, value));
    }
  }
  return children;
}

function elementNodeOf(name: string, raw: unknown): ElementNode {
  const record = asRecord(raw);
  const attributes: Record<string, unknown> = {};
  if (record !== undefined) {
    for (const key of Object.keys(record)) {
      if (key.startsWith(attributePrefix)) {
        attributes[key.slice(attributePrefix.length)] = record[key];
      }
    }
  }
  const text = asText(raw) ?? "";
  return {
    name,
    attributes,
    text,
    ...(record === undefined ? {} : { object: record })
  };
}

function asRecord(value: unknown): XmlRecord | undefined {
  return typeof value === "object" && value !== null ? (value as XmlRecord) : undefined;
}

function fpsRootOf(value: unknown): XmlRecord | undefined {
  return typeof value === "string" && typeof value.trim() === "string" && value.trim().length === 0
    ? {}
    : asRecord(value);
}

function asText(value: unknown): string | undefined {
  if (typeof value === "string") {
    return value;
  }
  const record = asRecord(value);
  if (record === undefined) {
    return undefined;
  }
  const text = record["#text"];
  return typeof text === "string" ? text : undefined;
}

function elementListOf(node: unknown, name: string): unknown[] {
  const record = asRecord(node);
  if (record === undefined) {
    return [];
  }
  const value = record[name];
  if (value === undefined) {
    return [];
  }
  return Array.isArray(value) ? value : [value];
}
