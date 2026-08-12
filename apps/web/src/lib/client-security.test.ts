import { describe, expect, it } from "vitest";
import { ApiError } from "./api";
import { clearProblemDrafts, isAccessBoundaryError } from "./client-security";

describe("客户端私密状态边界", () => {
  it.each([401, 403, 404])("把 %i 识别为访问边界错误", (status) => {
    expect(isAccessBoundaryError(new ApiError("虚构错误", status))).toBe(true);
  });

  it("清除全部账号的题目草稿但保留无关会话数据", () => {
    sessionStorage.setItem("urmotiv.web.unsaved.user-a.problem-a", "fictional-a");
    sessionStorage.setItem("urmotiv.web.unsaved.user-b.problem-b", "fictional-b");
    sessionStorage.setItem("unrelated.preference", "keep");

    clearProblemDrafts();

    expect(sessionStorage.getItem("urmotiv.web.unsaved.user-a.problem-a")).toBeNull();
    expect(sessionStorage.getItem("urmotiv.web.unsaved.user-b.problem-b")).toBeNull();
    expect(sessionStorage.getItem("unrelated.preference")).toBe("keep");
    sessionStorage.removeItem("unrelated.preference");
  });
});
