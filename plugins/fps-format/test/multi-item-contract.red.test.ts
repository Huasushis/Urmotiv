import { describe, expect, it } from "vitest";
import { fpsProblemFormatAdapter } from "../src/adapter";
import { archiveFromText } from "./fixtures";

/**
 * 契约探针（验收证据）：合法的两 item FPS 文件必须能被无错预览并导入为
 * 两道完整题目，每个 item 的标题与题面正文逐字保留，既不丢失也不拒绝。
 * 依据 docs/oj-compatibility.md 第 10.2 节：多题支持必须先扩展导入接口，
 * 不允许只取第一题的临时版本。多题契约切换完成前本测试保持失败（RED）。
 */
describe("FPS 多 item 契约缺口（RED 探针）", () => {
  it("合法的两 item FPS 文件必须能被无错预览并导入为两道完整题目", async () => {
    const archive = archiveFromText(
      [
        '<?xml version="1.0" encoding="UTF-8"?>',
        "<fps>",
        "  <item>",
        "    <title>合成多题示例 甲</title>",
        "    <time_limit>1000</time_limit>",
        '    <memory_limit unit="mb">256</memory_limit>',
        "    <description>合成题目甲的描述。</description>",
        "  </item>",
        "  <item>",
        "    <title>合成多题示例 乙</title>",
        "    <time_limit>2000</time_limit>",
        '    <memory_limit unit="mb">512</memory_limit>',
        "    <description>合成题目乙的描述。</description>",
        "  </item>",
        "</fps>",
      ].join("\n"),
    );

    const preview = await fpsProblemFormatAdapter.inspect(archive);
    expect(preview.problemCount).toBe(2);

    // RED 观察点 1：合法多 item 输入不得产生阻断性错误。
    const blockingIssues = preview.issues.filter(
      (issue) => issue.severity === "error"
    );
    expect(blockingIssues).toEqual([]);

    // RED 观察点 2：导入必须同时保留两个 item，而不是拒绝或只取其一；
    // 每个 item 的题面正文必须逐字保留。
    const imported = await fpsProblemFormatAdapter.import(archive, {
      conflictAction: "create"
    });
    const problems = Array.isArray(imported) ? [...imported] : [imported];
    expect(problems.map((problem) => problem.title)).toEqual([
      "合成多题示例 甲",
      "合成多题示例 乙"
    ]);
    expect(problems.map((problem) => problem.content.statement)).toEqual([
      "合成题目甲的描述。",
      "合成题目乙的描述。"
    ]);
    expect(problems.map((problem) => problem.content.basicStatement)).toEqual([
      "合成题目甲的描述。",
      "合成题目乙的描述。"
    ]);
  });
});
/*
 * GREEN 判据（最小兼容切换）：ProblemFormatAdapter 契约显式声明并支持多题
 * 结果之后，对合法多 item 输入应满足——预览零 error 级问题；导入结果同时
 * 完整保留每个 item 的标题与题面正文，既不丢失也不拒绝。在此之前本测试
 * 保持 RED。
 */
