import {
  createSafeArchive,
  type SafeArchive
} from "@urmotiv/problem-package";

const encoder = new TextEncoder();

export function fpsFixture(): SafeArchive {
  return archiveFromText(
    [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<fps version="1.2">',
      "  <item>",
      "    <title>人工构造的 FPS 最小示例</title>",
      "    <url>https://example.test/minimal</url>",
      "    <time_limit>1000</time_limit>",
      "    <memory_limit unit=\"mb\">256</memory_limit>",
      "    <description>计算两个整数的和。</description>",
      "    <input>一行两个整数。</input>",
      "    <output>输出它们的和。</output>",
      "    <sample_input>2 3</sample_input>",
      "    <sample_output>5</sample_output>",
      "    <test_input name=\"001\">2 3</test_input>",
      "    <test_output name=\"001\">5</test_output>",
      "    <test_input name=\"002\">10 20</test_input>",
      "    <test_output name=\"002\">30</test_output>",
      "    <solution language=\"cpp\">int main() { return 0; }</solution>",
      "    <prepend language=\"cpp\">// prepend</prepend>",
      "    <append language=\"cpp\">// append</append>",
      "    <spj language=\"c\">int special() { return 1; }</spj>",
      "    <img><src>pic.png</src><base64>aGVsbG8tZmFrZS1wbmc=</base64></img>",
      "    <source>人工来源</source>",
      "    <remote_oj>vjudge</remote_oj>",
      "    <remote_id>ABC-42</remote_id>",
      "  </item>",
      "</fps>"
    ].join("\n")
  );
}

export function fpsFixtureWithoutSolution(): SafeArchive {
  return archiveFromText(
    [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<fps>',
      "  <item>",
      "    <title>人工构造的无题解 FPS 示例</title>",
      "    <time_limit>500</time_limit>",
      "    <memory_limit>64</memory_limit>",
      "    <description>这个示例不包含题解程序。</description>",
      "  </item>",
      "</fps>"
    ].join("\n")
  );
}

export function archiveFromText(xml: string): SafeArchive {
  return archiveFromSingleFile("problem.xml", encoder.encode(xml));
}

/** 把适配器单个原始 XML 的导出结果重新装回安全归档，模拟后台任务的输入。 */
export function archiveFromSingleFile(fileName: string, content: Uint8Array): SafeArchive {
  return createSafeArchive([
    {
      path: "problem.xml",
      kind: "file" as const,
      compressedSize: content.byteLength,
      uncompressedSize: content.byteLength,
      content
    }
  ]);
}
