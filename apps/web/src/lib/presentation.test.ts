import { describe, expect, it } from "vitest";
import { isFrozen, reviewVerdictText, statusText } from "./presentation";

describe("题目展示规则", () => {
  it("只在待审核和通过时冻结三个稳定字段", () => {
    expect(isFrozen("pending_review", "title")).toBe(true);
    expect(isFrozen("approved", "content.basicSolution")).toBe(true);
    expect(isFrozen("draft", "title")).toBe(false);
    expect(isFrozen("pending_review", "content.constraints")).toBe(false);
  });

  it("使用给用户看的中文状态和审核结论", () => {
    expect(statusText.rejected).toBe("审核不通过");
    expect(reviewVerdictText("request_changes")).toBe("需要修改");
  });
});
