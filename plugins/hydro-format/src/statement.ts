import type { Code, Heading, RootContent } from "mdast";
import { fromMarkdown } from "mdast-util-from-markdown";
import type {
  CanonicalContent,
  CanonicalProblem,
  CanonicalSample
} from "@urmotiv/problem-package";

export interface ParsedHydroStatement {
  readonly preamble: string;
  readonly background: string;
  readonly description: string;
  readonly inputFormat: string;
  readonly outputFormat: string;
  readonly constraints: string;
  readonly hints: string;
  readonly samples: readonly CanonicalSample[];
  readonly recognizedStructure: boolean;
  readonly unknownSections: readonly string[];
  readonly unknownSectionMarkdown: readonly string[];
}

const knownTopLevelSections = new Set([
  "background",
  "description",
  "format",
  "samples",
  "limitation",
  "hint",
  "hints"
]);

export function parseHydroStatement(markdown: string): ParsedHydroStatement {
  const tree = fromMarkdown(markdown);
  const children = tree.children;
  const preamble = statementPreamble(markdown, children);
  const background = findSection(markdown, children, 1, "background");
  const description = findSection(markdown, children, 1, "description");
  const constraints = findSection(markdown, children, 1, "limitation");
  const hints =
    findSection(markdown, children, 1, "hint") ||
    findSection(markdown, children, 1, "hints");
  const formatIndex = findHeadingIndex(children, 1, "format");
  const inputFormat =
    formatIndex === -1 ? "" : findNestedSection(markdown, children, formatIndex, "input");
  const outputFormat =
    formatIndex === -1 ? "" : findNestedSection(markdown, children, formatIndex, "output");
  const samples = parseSamples(markdown, children, findHeadingIndex(children, 1, "samples"));
  const unknownHeadingIndexes = children
    .map((node, index) => ({ node, index }))
    .filter(
      (entry): entry is { node: Heading; index: number } =>
        entry.node.type === "heading" &&
        entry.node.depth === 1 &&
        !knownTopLevelSections.has(headingText(entry.node).toLowerCase())
    );
  const unknownSections = unknownHeadingIndexes.map(({ node }) => headingText(node));
  const unknownSectionMarkdown = unknownHeadingIndexes.map(({ index }) =>
    wholeTopLevelSectionSource(markdown, children, index)
  );

  return {
    preamble,
    background,
    description,
    inputFormat,
    outputFormat,
    constraints,
    hints,
    samples,
    recognizedStructure:
      description.length > 0 || formatIndex !== -1 || samples.length > 0,
    unknownSections,
    unknownSectionMarkdown
  };
}

export function renderHydroStatement(
  problem: CanonicalProblem,
  sourceMarkdown?: string
): string {
  if (
    sourceMarkdown !== undefined &&
    hydroStatementSourceMatchesProblem(sourceMarkdown, problem)
  ) {
    return sourceMarkdown;
  }

  const sections: string[] = [];
  const content = problem.content;

  if (sourceMarkdown !== undefined) {
    const source = parseHydroStatement(sourceMarkdown);
    if (source.preamble.length > 0) {
      sections.push(source.preamble);
    }
  }

  if (content.background.length > 0) {
    sections.push(renderSection("Background", content.background));
  }
  sections.push(renderSection("Description", content.statement || content.basicStatement));

  if (content.inputFormat.length > 0 || content.outputFormat.length > 0) {
    const formatParts: string[] = ["# Format"];
    if (content.inputFormat.length > 0) {
      formatParts.push(`## Input\n\n${content.inputFormat.trim()}`);
    }
    if (content.outputFormat.length > 0) {
      formatParts.push(`## Output\n\n${content.outputFormat.trim()}`);
    }
    sections.push(formatParts.join("\n\n"));
  }

  if (problem.samples.length > 0) {
    const sampleParts = ["# Samples"];
    problem.samples.forEach((sample, index) => {
      const number = index + 1;
      sampleParts.push(renderCodeFence(`input${number}`, sample.input));
      sampleParts.push(renderCodeFence(`output${number}`, sample.output));
      if (sample.explanation.length > 0) {
        sampleParts.push(`### Explanation ${number}\n\n${sample.explanation.trim()}`);
      }
    });
    sections.push(sampleParts.join("\n\n"));
  }

  if (content.constraints.length > 0) {
    sections.push(renderSection("Limitation", content.constraints));
  }
  if (content.hints.length > 0) {
    sections.push(renderSection("Hint", content.hints));
  }

  if (sourceMarkdown !== undefined) {
    sections.push(...parseHydroStatement(sourceMarkdown).unknownSectionMarkdown);
  }

  return `${sections.join("\n\n")}\n`;
}

export function hydroStatementSourceMatchesProblem(
  sourceMarkdown: string,
  problem: CanonicalProblem
): boolean {
  const parsed = parseHydroStatement(sourceMarkdown);
  const expectedBasicStatement = parsed.description || sourceMarkdown.trim();
  const content = problem.content;
  return (
    content.basicStatement === expectedBasicStatement &&
    content.background === parsed.background &&
    content.statement === parsed.description &&
    content.inputFormat === parsed.inputFormat &&
    content.outputFormat === parsed.outputFormat &&
    content.constraints === parsed.constraints &&
    content.hints === parsed.hints &&
    samplesEqual(problem.samples, parsed.samples)
  );
}

export function canonicalContentFromHydroStatement(
  markdown: string,
  solution: string | undefined
): { readonly content: CanonicalContent; readonly samples: readonly CanonicalSample[] } {
  const parsed = parseHydroStatement(markdown);
  const description = parsed.description || markdown.trim();
  const solutionText = solution?.trim() ?? "";
  return {
    content: {
      basicStatement: description,
      basicSolution: solutionText || "原题包未包含题解。",
      background: parsed.background,
      statement: parsed.description,
      inputFormat: parsed.inputFormat,
      outputFormat: parsed.outputFormat,
      constraints: parsed.constraints,
      solution: solutionText,
      hints: parsed.hints
    },
    samples: parsed.samples
  };
}

function renderSection(name: string, value: string): string {
  return `# ${name}\n\n${value.trim()}`;
}

function renderCodeFence(language: string, value: string): string {
  const longestRun = Math.max(0, ...(value.match(/`+/g) ?? []).map((run) => run.length));
  const fence = "`".repeat(Math.max(3, longestRun + 1));
  return `${fence}${language}\n${value.replace(/\r\n?/g, "\n").replace(/\n$/, "")}\n${fence}`;
}

function findSection(
  markdown: string,
  children: readonly RootContent[],
  depth: Heading["depth"],
  name: string
): string {
  const index = findHeadingIndex(children, depth, name);
  return index === -1 ? "" : sectionSource(markdown, children, index, depth);
}

function findNestedSection(
  markdown: string,
  children: readonly RootContent[],
  parentIndex: number,
  name: string
): string {
  for (let index = parentIndex + 1; index < children.length; index += 1) {
    const node = children[index];
    if (node?.type !== "heading") {
      continue;
    }
    if (node.depth <= 1) {
      break;
    }
    if (node.depth === 2 && headingText(node).toLowerCase() === name) {
      return sectionSource(markdown, children, index, 2);
    }
  }
  return "";
}

function findHeadingIndex(
  children: readonly RootContent[],
  depth: Heading["depth"],
  name: string
): number {
  return children.findIndex(
    (node) =>
      node.type === "heading" &&
      node.depth === depth &&
      headingText(node).toLowerCase() === name
  );
}

function sectionSource(
  markdown: string,
  children: readonly RootContent[],
  headingIndex: number,
  depth: Heading["depth"]
): string {
  const heading = children[headingIndex];
  if (heading?.type !== "heading" || heading.position?.end.offset === undefined) {
    return "";
  }
  let end = markdown.length;
  for (let index = headingIndex + 1; index < children.length; index += 1) {
    const node = children[index];
    if (
      node?.type === "heading" &&
      node.depth <= depth &&
      node.position?.start.offset !== undefined
    ) {
      end = node.position.start.offset;
      break;
    }
  }
  return markdown.slice(heading.position.end.offset, end).trim();
}

function parseSamples(
  markdown: string,
  children: readonly RootContent[],
  samplesIndex: number
): CanonicalSample[] {
  if (samplesIndex === -1) {
    return [];
  }
  const values = new Map<
    number,
    { input?: string; output?: string; explanation?: string }
  >();

  for (let index = samplesIndex + 1; index < children.length; index += 1) {
    const node = children[index];
    if (node?.type === "heading" && node.depth === 1) {
      break;
    }
    if (node?.type === "code") {
      addSampleCode(values, node);
    } else if (node?.type === "heading") {
      const match = /^explanation\s+(\d+)$/i.exec(headingText(node));
      const number = Number.parseInt(match?.[1] ?? "", 10);
      if (match !== null && Number.isSafeInteger(number)) {
        const sample = values.get(number) ?? {};
        sample.explanation = sectionSource(markdown, children, index, node.depth);
        values.set(number, sample);
      }
    }
  }

  return [...values.entries()]
    .sort(([left], [right]) => left - right)
    .filter(
      (
        entry
      ): entry is [
        number,
        { input: string; output: string; explanation?: string }
      ] => {
      const value = entry[1];
      return value.input !== undefined && value.output !== undefined;
      }
    )
    .map(([, value]) => ({
      input: value.input,
      output: value.output,
      explanation: value.explanation ?? ""
    }));
}

function addSampleCode(
  values: Map<number, { input?: string; output?: string; explanation?: string }>,
  node: Code
): void {
  const match = /^(input|output)(\d+)$/i.exec(node.lang ?? "");
  if (match === null) {
    return;
  }
  const kind = match[1]?.toLowerCase();
  const number = Number.parseInt(match[2] ?? "", 10);
  if ((kind !== "input" && kind !== "output") || !Number.isSafeInteger(number)) {
    return;
  }
  const sample = values.get(number) ?? {};
  sample[kind] = node.value;
  values.set(number, sample);
}

function headingText(heading: Heading): string {
  return heading.children.map((node) => textValue(node)).join("").trim();
}

function statementPreamble(markdown: string, children: readonly RootContent[]): string {
  const firstHeading = children.find(
    (node): node is Heading =>
      node.type === "heading" && node.depth === 1 && node.position?.start.offset !== undefined
  );
  if (firstHeading?.position?.start.offset === undefined) {
    return "";
  }
  return markdown.slice(0, firstHeading.position.start.offset).trim();
}

function wholeTopLevelSectionSource(
  markdown: string,
  children: readonly RootContent[],
  headingIndex: number
): string {
  const heading = children[headingIndex];
  if (heading?.type !== "heading" || heading.position?.start.offset === undefined) {
    return "";
  }
  let end = markdown.length;
  for (let index = headingIndex + 1; index < children.length; index += 1) {
    const node = children[index];
    if (
      node?.type === "heading" &&
      node.depth === 1 &&
      node.position?.start.offset !== undefined
    ) {
      end = node.position.start.offset;
      break;
    }
  }
  return markdown.slice(heading.position.start.offset, end).trim();
}

function samplesEqual(
  left: readonly CanonicalSample[],
  right: readonly CanonicalSample[]
): boolean {
  return (
    left.length === right.length &&
    left.every(
      (sample, index) =>
        sample.input === right[index]?.input &&
        sample.output === right[index]?.output &&
        sample.explanation === right[index]?.explanation
    )
  );
}

function textValue(node: unknown): string {
  if (typeof node !== "object" || node === null) {
    return "";
  }
  if ("value" in node && typeof node.value === "string") {
    return node.value;
  }
  if ("alt" in node && typeof node.alt === "string") {
    return node.alt;
  }
  if ("children" in node && Array.isArray(node.children)) {
    return node.children.map((child) => textValue(child)).join("");
  }
  return "";
}
