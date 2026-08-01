import { describe, expect, it } from "vitest";
import { localDraftKey } from "./problem-workspace-page";

describe("题目工作区未保存草稿", () => {
  it("按当前账号和题目共同隔离，且不再使用旧格式", () => {
    const firstUser = localDraftKey("reviewer-a", "problem-1");
    const secondUser = localDraftKey("reviewer-b", "problem-1");

    expect(firstUser).not.toBe(secondUser);
    expect(firstUser).not.toBe("urmotiv.web.unsaved.problem-1");
    expect(firstUser).toContain(encodeURIComponent("reviewer-a"));
    expect(firstUser).toContain(encodeURIComponent("problem-1"));
  });
});
