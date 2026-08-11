import { beforeEach, describe, expect, it } from "vitest";
import type { Problem } from "@urmotiv/contracts";
import { updateDemoProblem } from "./demo-store";

const problemsKey = "urmotiv.web.demo.problems.v1";
const sessionKey = "urmotiv.web.demo.session.v1";

function makeProblem(overrides: Partial<Problem> = {}): Problem {
  return {
    id: "test-problem-1",
    title: "原始标题",
    type: "traditional",
    tagIds: ["tag-1"],
    codeforcesDifficulty: null,
    thinkingLevel: null,
    codingLevel: null,
    content: {
      basicStatement: "原始题面",
      basicSolution: "原始题解",
      background: "",
      statement: "",
      inputFormat: "",
      outputFormat: "",
      constraints: "",
      solution: "",
      hints: ""
    },
    samples: [],
    judgeConfig: null,
    status: "pending_review",
    owner: { id: "author", nickname: "作者", accountType: "human" },
    revision: 1,
    reviewRound: 1,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    capabilities: {
      canView: true,
      canEdit: false,
      canEditTitle: true,
      canEditFrozen: false,
      canSubmit: false,
      canWithdraw: false,
      canReview: false,
      canChangeStatus: false,
      canReadTestdata: false,
      canWriteTestdata: false,
      canExport: false,
      canViewAccessLog: false
    },
    ...overrides
  } as Problem;
}

function seed(problem: Problem, userId = "author"): void {
  window.localStorage.setItem(problemsKey, JSON.stringify([problem]));
  window.localStorage.setItem(sessionKey, userId);
}

describe("updateDemoProblem 名称专用权限", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it("canEdit=false + canEditTitle=true 时只允许 title-only 更新并递增 revision", async () => {
    seed(makeProblem());

    const updated = await updateDemoProblem("test-problem-1", {
      expectedRevision: 1,
      title: "新标题"
    });

    expect(updated.title).toBe("新标题");
    expect(updated.revision).toBe(2);
    expect(updated.content.basicStatement).toBe("原始题面");
    expect(updated.content.basicSolution).toBe("原始题解");
  });

  it("canEdit=false + canEditTitle=true 时拒绝包含 content 的混合更新", async () => {
    const problem = makeProblem();
    seed(problem);

    await expect(
      updateDemoProblem("test-problem-1", {
        expectedRevision: 1,
        title: "新标题",
        content: { ...problem.content, basicStatement: "篡改题面" }
      })
    ).rejects.toThrow();
  });

  it("canEdit=false + canEditTitle=true 时拒绝包含 type 的额外字段", async () => {
    seed(makeProblem());

    await expect(
      updateDemoProblem("test-problem-1", {
        expectedRevision: 1,
        title: "新标题",
        type: "interactive"
      })
    ).rejects.toThrow();
  });

  it("canEdit=false + canEditTitle=false (审题人) 时拒绝所有更新", async () => {
    seed(makeProblem(), "reviewer");

    await expect(
      updateDemoProblem("test-problem-1", {
        expectedRevision: 1,
        title: "新标题"
      })
    ).rejects.toThrow();
  });
});
