import { unified } from "unified";
import remarkParse from "remark-parse";
import type { ProblemContent, ProblemSample } from "@urmotiv/contracts";
export const templateSections = {
  基础题面: "basicStatement",
  基础题解: "basicSolution",
  题目背景: "background",
  正式题面: "statement",
  输入格式: "inputFormat",
  输出格式: "outputFormat",
  数据范围: "constraints",
  正式题解: "solution",
  提示: "hints",
} as const;
export const problemTemplate =
  "# 题目名称\n\n" +
  Object.keys(templateSections)
    .map((title) => "## " + title + "\n\n")
    .join("") +
  "## 样例 1 输入\n\n```text\n\n```\n\n## 样例 1 输出\n\n```text\n\n```\n\n## 样例 1 说明\n";
export type ParsedProblemTemplate = {
  title: string;
  content: ProblemContent;
  samples: ProblemSample[];
};
export function parseProblemTemplate(source: string): ParsedProblemTemplate {
  if (source.length > 1_000_000)
    throw Error("模板超过 1 MB，请拆分附件后再导入。");
  const tree = unified()
    .use(remarkParse)
    .parse(source.replace(/^\uFEFF/, ""));
  source = source.replace(/^\uFEFF/, "");
  const headings = tree.children.filter(
    (node) => node.type === "heading" && node.depth <= 2,
  );
  const titleNode = headings[0];
  if (titleNode?.type !== "heading" || titleNode.depth !== 1)
    throw Error("模板第一项应是一级标题：# 题目名称。");
  if (tree.children[0] !== titleNode)
    throw Error("题目名称前有未识别内容，请移入对应分区。");
  const headingText = (node: typeof titleNode) =>
    node.children
      .map((child) => ("value" in child ? child.value : ""))
      .join("")
      .trim();
  const title = headingText(titleNode);
  if (!title || title.length > 200) throw Error("题目名称须为 1–200 个字符。");
  const content = Object.fromEntries(
    Object.values(templateSections).map((key) => [key, ""]),
  ) as ProblemContent;
  const samples = new Map<number, Partial<ProblemSample>>(),
    seen = new Set<string>();
  for (let i = 0; i < headings.length; i++) {
    const node = headings[i]!;
    if (node.type !== "heading") continue;
    const value = source
      .slice(
        node.position!.end.offset!,
        headings[i + 1]?.position!.start.offset ?? source.length,
      )
      .trim();
    if (i === 0) {
      if (value) throw Error("题目名称后请用二级标题划分内容。");
      continue;
    }
    if (node.depth === 1) throw Error("一份模板只能创建一道题目。");
    const name = headingText(node);
    if (seen.has(name)) throw Error("模板分区重复，请合并同名二级标题。");
    seen.add(name);
    if (Object.hasOwn(templateSections, name)) {
      if (value.length > 500000) throw Error("单个内容分区过长。");
      content[templateSections[name as keyof typeof templateSections]] = value;
      continue;
    }
    const sample = /^样例 ([1-9]\d?) (输入|输出|说明)$/.exec(name);
    if (!sample || Number(sample[1]) > 50)
      throw Error(
        "存在未识别的二级标题，请使用下载模板中的名称；内容中的小标题用三级标题。",
      );
    const number = Number(sample[1]),
      item = samples.get(number) ?? {};
    const key =
      sample[2] === "输入"
        ? "input"
        : sample[2] === "输出"
          ? "output"
          : "explanation";
    const nodes = unified().use(remarkParse).parse(value).children;
    item[key] =
      key !== "explanation" && nodes.length === 1 && nodes[0]?.type === "code"
        ? nodes[0].value
        : value;
    samples.set(number, item);
  }
  if (!content.basicStatement.trim() || !content.basicSolution?.trim())
    throw Error("请填写基础题面和基础题解。");
  const output: ProblemSample[] = [];
  for (const [number, item] of [...samples].sort((a, b) => a[0] - b[0])) {
    if (
      !item.input?.trim() &&
      !item.output?.trim() &&
      !item.explanation?.trim()
    )
      continue;
    if (item.input === undefined || item.output === undefined)
      throw Error("每个样例必须同时包含输入和输出分区。");
    if (item.input.length > 100000 || item.output.length > 100000)
      throw Error("样例输入或输出超过 100,000 个字符。");
    output.push({
      id: crypto.randomUUID(),
      input: item.input,
      output: item.output,
      explanation: item.explanation ?? "",
    });
  }
  return { title, content, samples: output };
}
