import { describe, expect, it } from "vitest";
import {
  createSafeArchive,
  type ArchiveSourceEntry,
  type CanonicalProblem
} from "@urmotiv/problem-package";
import { fpsProblemFormatAdapter, parseFpsPackage } from "../src/adapter";
import { archiveFromSingleFile, archiveFromText, fpsFixture, fpsFixtureWithoutSolution } from "./fixtures";

describe("FPS XML 题目包格式适配器", () => {
  it("导入人工构造的最小公开夹具，程序正文只留在来源信息中", async () => {
    const archive = fpsFixture();
    const preview = await fpsProblemFormatAdapter.inspect(archive);
    const importedList = await fpsProblemFormatAdapter.import(archive, {
      conflictAction: "create"
    });
    expect(importedList).toHaveLength(1);
    const imported = importedList[0]!;

    expect(preview).toMatchObject({
      formatId: "fps",
      problemCount: 1,
      title: "人工构造的 FPS 最小示例"
    });
    expect(imported).toMatchObject({
      title: "人工构造的 FPS 最小示例",
      type: "traditional",
      content: {
        basicStatement: "计算两个整数的和。",
        basicSolution: "原题包未包含说明性题解。",
        statement: "计算两个整数的和。",
        inputFormat: "一行两个整数。",
        outputFormat: "输出它们的和。"
      },
      samples: [{ input: "2 3", output: "5", explanation: "" }],
      provenance: {
        sourceSystem: "fps",
        sourceProblemId: "ABC-42"
      }
    });
    expect(imported.judge).toBeUndefined();
    expect(imported.files.map((file) => [file.path, file.category])).toEqual([
      ["judge/testdata/001.out", "testdata"],
      ["judge/testdata/002.out", "testdata"],
      ["judge/testdata/001", "testdata"],
      ["judge/testdata/002", "testdata"],
      ["assets/pic.png", "asset"]
    ]);
    expect(imported.extensions.fps).toMatchObject({
      revision: "fps-7782b381-2026-05-20",
      solutions: [{ language: "cpp", text: "int main() { return 0; }" }],
      prepends: [{ language: "cpp", text: "// prepend" }],
      testData: { inputNames: ["001", "002"], outputNames: ["001", "002"] },
      spj: { language: "c", text: "int special() { return 1; }" },
      source: "人工来源",
      url: "https://example.test/minimal"
    });
  });

  it("导出后的 XML 可再次导入，保留已支持字段和来源信息", async () => {
    const firstList = await fpsProblemFormatAdapter.import(fpsFixture(), {
      conflictAction: "create"
    });
    const first = firstList[0]!;
    const generated = await fpsProblemFormatAdapter.export(first, {});
    if (generated.kind !== "single_file") {
      throw new Error("FPS 题目包必须导出为单个原始 XML。");
    }
    expect(generated.fileName).toBe("problem.xml");
    expect(new TextDecoder().decode(generated.content)).toMatch(/<fps>/);

    const secondList = await fpsProblemFormatAdapter.import(
      archiveFromSingleFile(generated.fileName, generated.content),
      { conflictAction: "create" }
    );
    const second = secondList[0]!;
    expect(second.title).toBe(first.title);
    expect(second.content).toEqual(first.content);
    expect(second.samples).toEqual(first.samples);
    expect(second.files).toEqual(first.files);
    expect(second.extensions.fps).toEqual(first.extensions.fps);
    expect(second.provenance).toEqual(first.provenance);
  });


  it("原包没有题解时如实标记，导出不会凭空生成 solution 元素", async () => {
    const importedList = await fpsProblemFormatAdapter.import(fpsFixtureWithoutSolution(), {
      conflictAction: "create"
    });
    const imported = importedList[0]!;
    expect(imported.content.basicSolution).toBe("原题包未包含说明性题解。");
    expect(imported.extensions.fps).toMatchObject({ solutions: [] });

    const generated = await fpsProblemFormatAdapter.export(imported, {});
    if (!("content" in generated)) {
      throw new Error("FPS 题目包必须导出为单个原始 XML。");
    }
    const xml = new TextDecoder().decode(generated.content);
    expect(xml).not.toContain("<solution");
    expect(xml).toContain("<description>这个示例不包含题解程序。</description>");
  });

  it("拒绝 DOCTYPE、外部实体和不支持的根元素", async () => {
    const doctype = archiveFromText(
      '<?xml version="1.0"?><!DOCTYPE fps SYSTEM "http://evil.test/fps.dtd"><fps/>'
    );
    await expect(
      fpsProblemFormatAdapter.import(doctype, { conflictAction: "create" })
    ).rejects.toThrow("DTD");

    const entity = archiveFromText('<?xml version="1.0"?><!ENTITY x "boom"><fps/>');
    await expect(
      fpsProblemFormatAdapter.import(entity, { conflictAction: "create" })
    ).rejects.toThrow("DTD");

    const wrongRoot = archiveFromText("<polygon/>");
    await expect(
      fpsProblemFormatAdapter.import(wrongRoot, { conflictAction: "create" })
    ).rejects.toThrow("根元素");
  });

  it("多题包完整导入为多道题，空题包被拒绝，不默默取第一道", async () => {
    const multiple = archiveFromText(
      [
        "<fps>",
        "  <item>",
        "    <title>one</title>",
        "    <time_limit>1</time_limit>",
        "    <memory_limit>1</memory_limit>",
        "    <description>一</description>",
        "  </item>",
        "  <item>",
        "    <title>two</title>",
        "    <time_limit>1</time_limit>",
        "    <memory_limit>1</memory_limit>",
        "    <description>二</description>",
        "  </item>",
        "</fps>"
      ].join("\n")
    );
    const preview = await fpsProblemFormatAdapter.inspect(multiple);
    expect(preview.problemCount).toBe(2);
    expect(preview.issues.filter((issue) => issue.severity === "error")).toEqual([]);
    const importedMultiple = await fpsProblemFormatAdapter.import(multiple, {
      conflictAction: "create"
    });
    expect(importedMultiple.map((problem) => problem.title)).toEqual(["one", "two"]);
    expect(importedMultiple.map((problem) => problem.content.basicStatement)).toEqual([
      "一",
      "二"
    ]);

    const empty = archiveFromText("<fps></fps>");
    const emptyPreview = await fpsProblemFormatAdapter.inspect(empty);
    expect(emptyPreview.problemCount).toBe(0);
    await expect(
      fpsProblemFormatAdapter.import(empty, { conflictAction: "create" })
    ).rejects.toThrow(/不包含任何/);
  });

  it("拒绝数量不一致的样例和缺少名称的测试数据", async () => {
    const badSamples = archiveFromText(
      [
        "<fps>",
        "  <item><title>样例不一致</title><time_limit>1</time_limit><memory_limit>1</memory_limit><description>x</description>",
        "    <sample_input>1</sample_input>",
        "  </item>",
        "</fps>"
      ].join("\n")
    );
    await expect(
      fpsProblemFormatAdapter.import(badSamples, { conflictAction: "create" })
    ).rejects.toThrow(/sample_input 与 sample_output 数量不一致/);

    const unnamed = archiveFromText(
      [
        "<fps>",
        "  <item><title>无名测试数据</title><time_limit>1</time_limit><memory_limit>1</memory_limit><description>x</description>",
        "    <test_input>1 2</test_input>",
        "  </item>",
        "</fps>"
      ].join("\n")
    );
    await expect(
      fpsProblemFormatAdapter.import(unnamed, { conflictAction: "create" })
    ).rejects.toThrow(/name/);
  });

  it("拒绝未知单位和不安全的测试数据名称", async () => {
    const badUnit = archiveFromText(
      [
        "<fps>",
        "  <item><title>未知单位</title><time_limit unit=\"hours\">1</time_limit><memory_limit>64</memory_limit><description>x</description></item>",
        "</fps>"
      ].join("\n")
    );
    await expect(
      fpsProblemFormatAdapter.import(badUnit, { conflictAction: "create" })
    ).rejects.toThrow(/单位/);

    const unsafeName = archiveFromText(
      [
        "<fps>",
        "  <item><title>危险路径</title><time_limit>1</time_limit><memory_limit>1</memory_limit><description>x</description>",
        "    <test_input name=\"a/b\">1</test_input>",
        "  </item>",
        "</fps>"
      ].join("\n")
    );
    await expect(
      fpsProblemFormatAdapter.import(unsafeName, { conflictAction: "create" })
    ).rejects.toThrow(/安全/);
  });

  it("缺失核心元素、未知元素和重复元素被拒绝", async () => {
    const noDescription = archiveFromText(
      "<fps><item><title>缺少内容</title><time_limit>1</time_limit><memory_limit>1</memory_limit></item></fps>"
    );
    await expect(
      fpsProblemFormatAdapter.import(noDescription, { conflictAction: "create" })
    ).rejects.toThrow(/题面描述/);

    const unknown = archiveFromText(
      "<fps><item><title>x</title><time_limit>1</time_limit><memory_limit>1</memory_limit><description>y</description><validator>z</validator></item></fps>"
    );
    await expect(
      fpsProblemFormatAdapter.import(unknown, { conflictAction: "create" })
    ).rejects.toThrow(/validator/);

    const duplicateTitle = archiveFromText(
      "<fps><item><title>a</title><title>b</title><time_limit>1</time_limit><memory_limit>1</memory_limit><description>y</description></item></fps>"
    );
    await expect(
      fpsProblemFormatAdapter.import(duplicateTitle, { conflictAction: "create" })
    ).rejects.toThrow(/重复/);
  });

  it("适配器没有收到原始 XML 时按确定错误失败", async () => {
    const emptyArchive = createSafeArchive([
      {
        path: "other.txt",
        kind: "file" as const,
        compressedSize: 1,
        uncompressedSize: 1,
        content: new TextEncoder().encode("x")
      }
    ]);
    await expect(
      fpsProblemFormatAdapter.import(emptyArchive, { conflictAction: "create" })
    ).rejects.toThrow(/原始 XML/);
  });

  it("包含内部或公开附件时阻止导出并给出丢失信息报告", async () => {
    const importedList = await fpsProblemFormatAdapter.import(fpsFixture(), {
      conflictAction: "create"
    });
    const imported = importedList[0]!;
    const withAttachment: CanonicalProblem = {
      ...imported,
      files: [
        ...imported.files,
        {
          path: "attachments/internal/only-team.txt",
          category: "internal_attachment",
          content: new TextEncoder().encode("人工构造的内部测试文本")
        }
      ]
    };
    const report = await fpsProblemFormatAdapter.validateExport(withAttachment, {});
    expect(report.canExport).toBe(false);
    expect(report.items).toContainEqual({
      severity: "error",
      path: "files.attachments/internal/only-team.txt",
      message: "FPS XML 没有附件可见范围，不能保证附件语义，已阻止导出。"
    });
  });

  it("导出只增加警告的字段：标签、难度和约束不会写入导出包", async () => {
    const importedList = await fpsProblemFormatAdapter.import(fpsFixtureWithoutSolution(), {
      conflictAction: "create"
    });
    const imported = importedList[0]!;
    const enriched: CanonicalProblem = {
      ...imported,
      tags: ["math"],
      difficulty: { codeforces: 1200, thinkingLevel: 3 },
      content: { ...imported.content, constraints: "1 ≤ n ≤ 10^9" }
    };
    const report = await fpsProblemFormatAdapter.validateExport(enriched, {});
    expect(report.canExport).toBe(true);
    expect(report.targetFormat).toBe("fps");
    expect(report.items.every((item) => item.severity === "warning")).toBe(true);

    const generated = await fpsProblemFormatAdapter.export(enriched, {});
    if (!("content" in generated)) {
      throw new Error("FPS 题目包必须导出为单个原始 XML。");
    }
    const xml = new TextDecoder().decode(generated.content);
    expect(xml).not.toContain("≤");
    expect(xml).not.toContain("<tag");
  });

  it("解析返回正确的题目数和生成器计数", async () => {
    const document = parseFpsPackage(fpsFixture());
    expect(document.itemCount).toBe(1);
    expect(document.generators).toBe(0);
  });

  it("路径遍历、符号链接和嵌套压缩包在适配器接收前被拒绝", () => {
    const content = new TextEncoder().encode("x");
    const pathTraversal: ArchiveSourceEntry = {
      path: "../problem.xml",
      kind: "file",
      compressedSize: content.byteLength,
      uncompressedSize: content.byteLength,
      content
    };
    const symbolicLink: ArchiveSourceEntry = {
      path: "problem.xml",
      kind: "symlink",
      compressedSize: 1,
      uncompressedSize: 1
    };
    expect(() => createSafeArchive([pathTraversal])).toThrow("题目包没有通过文件安全检查");
    expect(() => createSafeArchive([symbolicLink])).toThrow("题目包没有通过文件安全检查");
    expect(() =>
      createSafeArchive([
        {
          path: "problem.xml",
          kind: "file" as const,
          compressedSize: 4,
          uncompressedSize: 4,
          content: new Uint8Array([0x50, 0x4b, 0x03, 0x04])
        }
      ])
    ).toThrow("题目包没有通过文件安全检查");
  });
});
