export const sourceLanguages = [
  { id: "cpp", name: "C++", extension: "cpp" },
  { id: "c", name: "C", extension: "c" },
  { id: "python", name: "Python", extension: "py" },
  { id: "java", name: "Java", extension: "java" },
  { id: "rust", name: "Rust", extension: "rs" },
  { id: "go", name: "Go", extension: "go" },
  { id: "javascript", name: "JavaScript", extension: "js" },
  { id: "typescript", name: "TypeScript", extension: "ts" },
  { id: "csharp", name: "C#", extension: "cs" },
  { id: "pascal", name: "Pascal", extension: "pas" },
  { id: "plaintext", name: "其它 / 纯文本", extension: "txt" },
] as const;
export type StandardProgram = { source: string; language: string };
export function sourceLanguage(name: string): string {
  const normalized = name.toLowerCase();
  const alias: Record<string, string> = {
    "c++": "cpp",
    cc: "cpp",
    cxx: "cpp",
    py: "python",
    python3: "python",
    "c#": "csharp",
    text: "plaintext",
    txt: "plaintext",
  };
  const key = normalized.split(".").pop() ?? normalized;
  return (
    alias[key] ??
    sourceLanguages.find((language) => language.id === key || language.extension === key)?.id ??
    "plaintext"
  );
}
export function extractStandardProgram(raw: string): StandardProgram {
  // 只移除包住整段源码的 Markdown 围栏，保留代码字节和缩进；不猜测未知语言。
  const fenced = raw.match(/^\s*(`{3,}|~{3,})([^\r\n]*)\r?\n([\s\S]*?)\r?\n\1\s*$/);
  return fenced
    ? { source: fenced[3]!, language: sourceLanguage(fenced[2]!.trim()) }
    : { source: raw, language: "plaintext" };
}
export function sourcePreview(source: string, language: string): string {
  const fence = "`".repeat(
    [...source.matchAll(/`+/g)].reduce((size, match) => Math.max(size, match[0].length + 1), 3),
  );
  return `${fence}${language}\n${source}\n${fence}`;
}
