import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { SimilarityCheckResponse } from "@urmotiv/contracts";
import { SimilarityCheckPanel } from "./problem-workspace-page";

function renderResult(
  status: SimilarityCheckResponse["status"],
  blockedAdvice: SimilarityCheckResponse["blockedAdvice"] = null
): string {
  return renderToStaticMarkup(
    <SimilarityCheckPanel
      result={{ status, blockedAdvice, items: [] }}
      onDismiss={() => undefined}
    />
  );
}

describe("原题检索结果面板", () => {
  it("只有完整且无候选的结果显示明确阴性结论", () => {
    const html = renderResult("completed");

    expect(html).toContain("完整检索未发现需要关注的相似题目");
    expect(html).not.toContain("只完成了一部分");
    expect(html).not.toContain("未能形成可信结果");
  });

  it("部分完成只显示警告，不显示阴性结论", () => {
    const html = renderResult("partial");

    expect(html).toContain("本次检索只完成了一部分");
    expect(html).not.toContain("完整检索未发现需要关注的相似题目");
  });

  it("不可用只显示警告，不显示阴性结论", () => {
    const html = renderResult("unavailable");

    expect(html).toContain("原题检索未能形成可信结果");
    expect(html).not.toContain("完整检索未发现需要关注的相似题目");
  });

  it("完整检索明确建议拦截时不同时显示阴性结论", () => {
    const html = renderResult("completed", {
      code: "anklang_similar_problem",
      message: "发现合成的高度相似候选，请人工核对。"
    });

    expect(html).toContain("建议不要提交：发现合成的高度相似候选，请人工核对");
    expect(html).not.toContain("完整检索未发现需要关注的相似题目");
  });
});
