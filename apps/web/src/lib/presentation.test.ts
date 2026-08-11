import { describe, expect, it } from "vitest";
import { duration, isFrozen, reviewVerdictText, statusText } from "./presentation";

describe("题目展示规则", () => {
  it("待审核和通过时只冻结题面和题解，标题保持可编辑", () => {
    expect(isFrozen("pending_review", "title")).toBe(false);
    expect(isFrozen("approved", "content.basicSolution")).toBe(true);
    expect(isFrozen("pending_review", "content.basicStatement")).toBe(true);
    expect(isFrozen("draft", "title")).toBe(false);
    expect(isFrozen("pending_review", "content.constraints")).toBe(false);
  });

  it("使用给用户看的中文状态和审核结论", () => {
    expect(statusText.rejected).toBe("审核不通过");
    expect(reviewVerdictText("request_changes")).toBe("需要修改");
  });

  it("浏览时长按秒、分秒展示给用户", () => {
    expect(duration(0)).toBe("0 秒");
    expect(duration(42)).toBe("42 秒");
    expect(duration(120)).toBe("2 分钟");
    expect(duration(3210)).toBe("53 分 30 秒");
  });
});
