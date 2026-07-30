import { describe, expect, it } from "vitest";
import {
  createSafeArchive,
  type ArchiveSourceEntry,
  type CanonicalProblem
} from "@urmotiv/problem-package";
import { hydroProblemFormatAdapter } from "../src/adapter";
import {
  archiveFromGenerated,
  archiveFromText,
  fixtureWithMissingOutput,
  hydroFixture
} from "./fixtures";

describe("Hydro 题目包格式适配器", () => {
  it("导入人工构造的最小公开夹具，并保留可恢复的 Hydro 设置", async () => {
    const archive = hydroFixture();
    const preview = await hydroProblemFormatAdapter.inspect(archive);
    const imported = await hydroProblemFormatAdapter.import(archive, { conflictAction: "create" });

    expect(preview).toMatchObject({
      formatId: "hydro",
      problemCount: 1,
      title: "人工构造的 Hydro 最小示例"
    });
    expect(imported).toMatchObject({
      title: "人工构造的 Hydro 最小示例",
      type: "traditional",
      tags: ["math"],
      content: {
        statement: "计算两个整数的和。",
        inputFormat: "一行两个整数。",
        outputFormat: "输出它们的和。",
        solution: "直接相加即可。"
      },
      samples: [{ input: "2 3", output: "5", explanation: "把两个数相加。" }],
      judge: {
        limits: { timeMs: 1000, memoryMiB: 256 },
        scoring: { total: 100, subtaskMode: "sum" },
        checker: { type: "standard" }
      },
      provenance: {
        sourceSystem: "hydro",
        sourceProblemId: "H100"
      }
    });
    expect(imported.files.map((file) => [file.path, file.category])).toEqual([
      ["attachments/public/readme.txt", "public_attachment"],
      ["solutions/std/main.cpp", "standard_solution"],
      ["judge/testdata/001.in", "testdata"],
      ["judge/testdata/001.out", "testdata"]
    ]);
    expect(imported.extensions.hydro).toMatchObject({
      rootDirectory: "fixture",
      statementFile: "problem.md",
      difficulty: 3,
      config: { detail: true }
    });
  });

  it("导出后可再次导入，题面、样例、数据点和来源设置保持一致", async () => {
    const first = await hydroProblemFormatAdapter.import(hydroFixture(), {
      conflictAction: "create"
    });
    const generated = await hydroProblemFormatAdapter.export(first, {});
    const second = await hydroProblemFormatAdapter.import(archiveFromGenerated(generated), {
      conflictAction: "create"
    });

    if (generated.kind !== "zip") {
      throw new Error("Hydro 题目包必须导出为 ZIP。");
    }
    expect(generated.files.map((file) => file.path)).toEqual([
      "fixture/additional_file/readme.txt",
      "fixture/problem.md",
      "fixture/problem.yaml",
      "fixture/solution/solution.md",
      "fixture/std/main.cpp",
      "fixture/testdata/001.in",
      "fixture/testdata/001.out",
      "fixture/testdata/config.yaml"
    ]);
    expect(second.title).toBe(first.title);
    expect(second.content).toEqual(first.content);
    expect(second.samples).toEqual(first.samples);
    expect(second.judge).toEqual(first.judge);
    expect(second.files).toEqual(first.files);
    expect(second.extensions.hydro).toMatchObject({
      rootDirectory: "fixture",
      statementFile: "problem.md",
      difficulty: 3,
      config: { detail: true }
    });
  });

  it("兼容 Hydro 用 name 代替 title 的官方导入后备字段", async () => {
    const archive = archiveFromText({
      "fixture/problem.yaml": "name: 人工构造的标题后备字段\n",
      "fixture/problem.md": "# Description\n\n这不是一道真实题目。\n"
    });
    const imported = await hydroProblemFormatAdapter.import(archive, {
      conflictAction: "create"
    });

    expect(imported.title).toBe("人工构造的标题后备字段");
  });

  it("在 Hydro 不能安全表达内部附件时阻止导出并给出丢失信息报告", async () => {
    const imported = await hydroProblemFormatAdapter.import(hydroFixture(), {
      conflictAction: "create"
    });
    const withInternalAttachment: CanonicalProblem = {
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

    const report = await hydroProblemFormatAdapter.validateExport(withInternalAttachment, {});
    expect(report.canExport).toBe(false);
    expect(report.items).toContainEqual({
      severity: "error",
      path: "files.attachments/internal/only-team.txt",
      message: "Hydro 只有普通附件目录；导出内部附件会改变可见范围，因此已阻止。"
    });
  });

  it("在配置引用的输出文件缺失时停止导入，不生成半成品", async () => {
    await expect(
      hydroProblemFormatAdapter.import(fixtureWithMissingOutput(), { conflictAction: "create" })
    ).rejects.toThrow("输出文件 001.out 不存在");
  });

  it("拒绝无法判断用途的 Hydro 目录内容和多题包", async () => {
    const unknownFile = archiveFromText({
      "fixture/problem.yaml": "title: 人工安全测试\n",
      "fixture/problem.md": "# Description\n\n测试。\n",
      "fixture/unknown/unclassified.txt": "不能忽略"
    });
    await expect(
      hydroProblemFormatAdapter.import(unknownFile, { conflictAction: "create" })
    ).rejects.toThrow("不能确定文件 unknown/unclassified.txt 的用途");

    const multiple = archiveFromText({
      "one/problem.yaml": "title: 人工测试一\n",
      "one/problem.md": "# Description\n\n一。\n",
      "two/problem.yaml": "title: 人工测试二\n",
      "two/problem.md": "# Description\n\n二。\n"
    });
    const preview = await hydroProblemFormatAdapter.inspect(multiple);
    expect(preview.problemCount).toBe(2);
    expect(preview.issues).toContainEqual({
      severity: "error",
      message: "这个压缩包包含多道题；当前单题导入接口不能一次导入多道题。"
    });
  });

  it("在适配器接收前拒绝路径跳转、符号链接和嵌套压缩包", () => {
    const content = new TextEncoder().encode("x");
    const pathTraversal: ArchiveSourceEntry = {
      path: "../problem.yaml",
      kind: "file",
      compressedSize: content.byteLength,
      uncompressedSize: content.byteLength,
      content
    };
    const symbolicLink: ArchiveSourceEntry = {
      path: "fixture/problem.yaml",
      kind: "symlink",
      compressedSize: 1,
      uncompressedSize: 1
    };

    expect(() => createSafeArchive([pathTraversal])).toThrow("题目包没有通过文件安全检查");
    expect(() => createSafeArchive([symbolicLink])).toThrow("题目包没有通过文件安全检查");
    expect(() =>
      createSafeArchive([
        {
          path: "fixture/additional_file/nested.zip",
          kind: "file" as const,
          compressedSize: 4,
          uncompressedSize: 4,
          content: new Uint8Array([0x50, 0x4b, 0x03, 0x04])
        }
      ])
    ).toThrow("题目包没有通过文件安全检查");
  });
});
