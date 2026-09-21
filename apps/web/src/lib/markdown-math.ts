import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkMath from "remark-math";

const parser = unified().use(remarkParse).use(remarkMath);
type Node = {
  type: string;
  children?: Node[] | undefined;
  position?:
    | {
        start: { offset?: number | undefined };
        end: { offset?: number | undefined };
      }
    | undefined;
};

/** 使用 Markdown 解析器保护代码、链接目标和已有公式；只补标准 LaTeX 分隔符。 */
export function normalizeMathDelimiters(source: string): string {
  if (!source.includes("\\(") && !source.includes("\\[")) return source;
  const excluded: Array<[number, number]> = [];
  function visit(node: Node) {
    if (
      [
        "code",
        "inlineCode",
        "html",
        "definition",
        "image",
        "link",
        "math",
        "inlineMath",
      ].includes(node.type)
    ) {
      const start = node.position?.start.offset,
        end = node.position?.end.offset;
      if (start !== undefined && end !== undefined) excluded.push([start, end]);
    } else node.children?.forEach(visit);
  }
  visit(parser.parse(source));
  excluded.sort((a, b) => a[0] - b[0]);
  let result = "",
    index = 0,
    range = 0;
  while (index < source.length) {
    while (excluded[range] && excluded[range]![1] <= index) range++;
    const protectedRange = excluded[range];
    if (protectedRange && index >= protectedRange[0]) {
      result += source.slice(index, protectedRange[1]);
      index = protectedRange[1];
      continue;
    }
    if (source[index] === "\\" && source[index + 1] === "\\") {
      result += "\\\\";
      index += 2;
      continue;
    }
    const display = source.startsWith("\\[", index),
      inline = source.startsWith("\\(", index);
    if (display || inline) {
      const end = source.indexOf(display ? "\\]" : "\\)", index + 2);
      if (end >= 0 && (!protectedRange || end < protectedRange[0])) {
        const formula = source.slice(index + 2, end);
        if (formula.trim()) {
          let fenceLength = 2;
          for (const match of formula.matchAll(/\$+/g))
            fenceLength = Math.max(fenceLength, match[0].length + 1);
          const fence = "$".repeat(fenceLength);
          result += display
            ? `\n\n${fence}\n${formula.trim()}\n${fence}\n\n`
            : `${fence}${formula}${fence}`;
          index = end + 2;
          continue;
        }
      }
    }
    result += source[index++];
  }
  return result;
}
