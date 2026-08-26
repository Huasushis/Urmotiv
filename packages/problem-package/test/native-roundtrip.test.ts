import { describe, expect, it } from "vitest";
import {
  canonicalProblemSchema,
  createSafeArchive,
  sha256,
  type GeneratedArchive,
  type CanonicalProblem,
  urmotivNativeAdapter
} from "../src";

const encoder = new TextEncoder();
const assetContent = new Uint8Array([1, 2, 3]);

const completeProblem: CanonicalProblem = canonicalProblemSchema.parse({
  title: "最短路示例",
  type: "traditional",
  tags: ["graph.shortest-path"],
  difficulty: {
    codeforces: 1600,
    thinkingLevel: 3,
    codingLevel: 2
  },
  content: {
    basicStatement: "给定一张图。",
    basicSolution: "使用 Dijkstra 算法。",
    background: "",
    statement: "求最短路。",
    inputFormat: "第一行是点数。",
    outputFormat: "输出最短距离。",
    constraints: "$1 \\le n \\le 10^5$",
    solution: "维护优先队列。",
    hints: "边权非负。"
  },
  samples: [{ input: "2 1\n1 2 3", output: "3", explanation: "只有一条边。" }],
  judge: {
    version: 1,
    limits: { timeMs: 1000, memoryMiB: 512 },
    scoring: { total: 100, subtaskMode: "sum" },
    subtasks: [{ id: 0, score: 100, method: "sum", dependsOn: [] }],
    testcases: [
      {
        id: "001",
        input: "judge/testdata/001.in",
        output: "judge/testdata/001.out",
        subtaskId: 0,
        score: 100
      }
    ],
    checker: { type: "standard" }
  },
  files: [
    {
      path: `assets/${sha256(assetContent)}.bin`,
      category: "asset",
      content: assetContent
    },
    {
      path: "attachments/internal/note.txt",
      category: "internal_attachment",
      content: encoder.encode("内部说明")
    },
    {
      path: "judge/testdata/001.in",
      category: "testdata",
      content: encoder.encode("2 1\n1 2 3\n")
    },
    {
      path: "judge/testdata/001.out",
      category: "testdata",
      content: encoder.encode("3\n")
    }
  ],
  provenance: {
    sourceSystem: "urmotiv",
    sourceProblemId: "123",
    sourceRevision: "7"
  },
  extensions: {
    "example.source": { enabled: true }
  }
});

describe("Urmotiv native problem package", () => {
  it("round trips supported fields and every file byte", async () => {
    const first = await urmotivNativeAdapter.export(completeProblem, {
      exportedAt: "2026-07-25T00:00:00.000Z"
    });
    const importedList = await urmotivNativeAdapter.import(toSafeArchive(first), {
      conflictAction: "create"
    });
    const imported = importedList[0]!;
    const second = await urmotivNativeAdapter.export(imported, {
      exportedAt: "2026-07-25T00:00:00.000Z"
    });

    expect(imported).toEqual(completeProblem);
    if (first.kind !== "zip" || second.kind !== "zip") {
      throw new Error("原生题目包必须导出为 ZIP。");
    }
    expect(second.files).toEqual(first.files);
  });

  it("reports omitted optional files without silently losing them", async () => {
    const report = await urmotivNativeAdapter.validateExport(completeProblem, {
      includeFileCategories: ["asset", "testdata"]
    });
    expect(report.canExport).toBe(true);
    expect(report.items).toContainEqual({
      severity: "warning",
      path: "files.attachments/internal/note.txt",
      message: "已按导出选择排除这个文件。"
    });
  });

  it("blocks excluding a file still used by the judge config", async () => {
    const report = await urmotivNativeAdapter.validateExport(completeProblem, {
      includeFileCategories: ["asset", "internal_attachment"]
    });
    expect(report.canExport).toBe(false);
    expect(report.items.some((item) => item.severity === "error")).toBe(true);
  });

  it("rejects changed content when checksums are not updated", async () => {
    const generated = await urmotivNativeAdapter.export(completeProblem, {
      exportedAt: "2026-07-25T00:00:00.000Z"
    });
    if (generated.kind !== "zip") {
      throw new Error("原生题目包必须导出为 ZIP。");
    }
    const changedFiles = generated.files.map((file) =>
      file.path === "content/statement.md"
        ? { ...file, content: encoder.encode("内容被替换") }
        : file
    );

    await expect(
      urmotivNativeAdapter.import(toSafeArchive({ ...generated, files: changedFiles }), {
        conflictAction: "create"
      })
    ).rejects.toThrow("校验值不一致");
  });

  it("round trips an explicitly empty basic solution without converting it to null", async () => {
    const explicitEmpty = canonicalProblemSchema.parse({
      ...completeProblem,
      content: { ...completeProblem.content, basicSolution: "" }
    });
    const generated = await urmotivNativeAdapter.export(explicitEmpty, {});
    const importedList = await urmotivNativeAdapter.import(toSafeArchive(generated), {
      conflictAction: "create"
    });
    const imported = importedList[0]!;
    expect(imported.content.basicSolution).toBe("");
  });
});

function toSafeArchive(archive: GeneratedArchive) {
  if (archive.kind !== "zip") {
    throw new Error("原生题目包必须导出为 ZIP。");
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
