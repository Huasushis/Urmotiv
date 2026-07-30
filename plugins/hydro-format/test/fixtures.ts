import {
  createSafeArchive,
  type ArchiveSourceEntry,
  type GeneratedArchive,
  type SafeArchive
} from "@urmotiv/problem-package";

const encoder = new TextEncoder();

export function hydroFixture(): SafeArchive {
  return archiveFromText({
    "fixture/problem.yaml": [
      "pid: H100",
      "title: 人工构造的 Hydro 最小示例",
      "tag:",
      "  - math",
      "difficulty: 3"
    ].join("\n"),
    "fixture/problem.md": [
      "# Description",
      "",
      "计算两个整数的和。",
      "",
      "# Format",
      "",
      "## Input",
      "",
      "一行两个整数。",
      "",
      "## Output",
      "",
      "输出它们的和。",
      "",
      "# Samples",
      "",
      "```input1",
      "2 3",
      "```",
      "",
      "```output1",
      "5",
      "```",
      "",
      "### Explanation 1",
      "",
      "把两个数相加。"
    ].join("\n"),
    "fixture/solution/solution.md": "直接相加即可。\n",
    "fixture/testdata/config.yaml": [
      "time: 1000ms",
      "memory: 256m",
      "detail: true",
      "cases:",
      "  - input: 001.in",
      "    output: 001.out",
      "    score: 100"
    ].join("\n"),
    "fixture/testdata/001.in": "2 3\n",
    "fixture/testdata/001.out": "5\n",
    "fixture/additional_file/readme.txt": "公开附件\n",
    "fixture/std/main.cpp": "int main() {}\n"
  });
}

export function fixtureWithMissingOutput(): SafeArchive {
  return archiveFromText({
    "fixture/problem.yaml": "title: 缺少输出的人工测试\n",
    "fixture/problem.md": "# Description\n\n这不是一道真实题目。\n",
    "fixture/testdata/config.yaml": [
      "cases:",
      "  - input: 001.in",
      "    output: 001.out"
    ].join("\n"),
    "fixture/testdata/001.in": "1\n"
  });
}

export function archiveFromGenerated(archive: GeneratedArchive): SafeArchive {
  if (archive.kind !== "zip") {
    throw new Error("这个测试夹具只接受 ZIP 格式的导出结果。");
  }
  return createSafeArchive(
    archive.files.map((file) => ({
      path: file.path,
      kind: "file" as const,
      compressedSize: file.content.byteLength,
      uncompressedSize: file.content.byteLength,
      content: file.content
    }))
  );
}

export function archiveFromText(files: Readonly<Record<string, string>>): SafeArchive {
  const entries: ArchiveSourceEntry[] = Object.entries(files).map(([path, text]) => {
    const content = encoder.encode(text);
    return {
      path,
      kind: "file" as const,
      compressedSize: content.byteLength,
      uncompressedSize: content.byteLength,
      content
    };
  });
  return createSafeArchive(entries);
}
