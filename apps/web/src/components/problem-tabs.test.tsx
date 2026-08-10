import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type {
  Problem,
  ReviewInput,
  ReviewRoundSummary,
  ReviewSuggestionView
} from "@urmotiv/contracts";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  applyReviewSuggestions: vi.fn(),
  createReview: vi.fn(),
  getProblem: vi.fn(),
  getReviewSuggestions: vi.fn(),
  listProblemAccess: vi.fn(),
  listReviewItems: vi.fn(),
  listReviews: vi.fn(),
  listTags: vi.fn()
}));

vi.mock("../lib/api", async (importOriginal) => {
  const original = await importOriginal<typeof import("../lib/api")>();
  return { ...original, ...api };
});

import { ApiError } from "../lib/api";
import { OverviewTab, ProblemAccessPanel, ReviewTab } from "./problem-tabs";

const timestamp = "2026-07-31T08:00:00.000Z";

function problem(canReview = true): Problem {
  return {
    id: "problem-1",
    title: "审核界面测试题",
    type: "traditional",
    tagIds: ["algorithm.implementation"],
    codeforcesDifficulty: 1600,
    thinkingLevel: null,
    codingLevel: null,
    content: {
      basicStatement: "输出输入的整数。",
      basicSolution: "直接输出。",
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
    owner: {
      id: "author",
      nickname: "投稿人",
      accountType: "human"
    },
    revision: 2,
    reviewRound: 1,
    createdAt: timestamp,
    updatedAt: timestamp,
    capabilities: {
      canView: true,
      canEdit: false,
      canEditFrozen: false,
      canSubmit: false,
      canWithdraw: false,
      canReview,
      canChangeStatus: false,
      canReadTestdata: false,
      canWriteTestdata: false,
      canExport: false,
      canViewAccessLog: false
    }
  };
}

function approvedProblem(): Problem {
  const current = problem(false);
  return {
    ...current,
    status: "approved",
    revision: 3,
    capabilities: {
      ...current.capabilities,
      canEdit: true,
      canChangeStatus: true
    }
  };
}

function reviewSuggestions(canApply: boolean): ReviewSuggestionView {
  return {
    round: 1,
    opinionCount: 2,
    current: {
      codeforcesDifficulty: 1600,
      thinkingLevel: null,
      codingLevel: null,
      tagIds: ["algorithm.implementation"]
    },
    suggested: {
      codeforcesDifficulty: 1800,
      thinkingLevel: 3,
      codingLevel: 2,
      tagIds: ["algorithm.implementation", "dynamic-programming"],
      qualityLevel: 4,
      originalityLevel: null
    },
    canApply
  };
}

function reviewSummary(
  overrides: Partial<ReviewRoundSummary> = {}
): ReviewRoundSummary {
  return {
    round: 1,
    reviews: [
      {
        id: "own-review",
        problemId: "problem-1",
        reviewer: {
          id: "current-reviewer",
          nickname: "当前审题人",
          accountType: "human"
        },
        source: "human",
        verdict: "request_changes",
        codeforcesDifficulty: 1800,
        qualityLevel: 4,
        originalityLevel: 4,
        thinkingLevel: 3,
        codingLevel: 2,
        tagIds: ["dynamic-programming"],
        improvements: "请补充边界情况。",
        publicComment: "公开评论。",
        privateNote: "仅审题人可见。",
        expectedRound: 1,
        createdAt: timestamp,
        updatedAt: timestamp
      },
      {
        id: "other-review",
        problemId: "problem-1",
        reviewer: {
          id: "other-reviewer",
          nickname: "AI 审题助手",
          accountType: "robot"
        },
        source: "fermata",
        verdict: "approve",
        codeforcesDifficulty: 1700,
        qualityLevel: 3,
        originalityLevel: null,
        thinkingLevel: 3,
        codingLevel: 2,
        tagIds: [],
        improvements: "题面和题解一致。",
        publicComment: "",
        privateNote: "",
        expectedRound: 1,
        createdAt: timestamp,
        updatedAt: timestamp
      }
    ],
    approvals: 1,
    blockingReviews: 0,
    requiredApprovals: 2,
    status: "waiting",
    ruleId: "org.ustc.urmotiv.review-default.count",
    decisionAvailable: true,
    decisionReason: null,
    decisionSource: null,
    ...overrides
  };
}

let root: Root | undefined;
let container: HTMLDivElement | undefined;

function mount(element: ReactNode): HTMLDivElement {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  const client = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false }
    }
  });
  act(() => {
    root?.render(
      <QueryClientProvider client={client}>
        {element}
      </QueryClientProvider>
    );
  });
  return container;
}

async function waitFor(assertion: () => void): Promise<void> {
  let latestError: unknown;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      assertion();
      return;
    } catch (error) {
      latestError = error;
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 5));
      });
    }
  }
  throw latestError;
}

function fieldControl(
  view: HTMLElement,
  label: string
): HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement {
  const field = [...view.querySelectorAll("label")].find(
    (candidate) => candidate.querySelector("span")?.textContent === label
  );
  const control = field?.querySelector("input, select, textarea");
  if (
    !(control instanceof HTMLInputElement) &&
    !(control instanceof HTMLSelectElement) &&
    !(control instanceof HTMLTextAreaElement)
  ) {
    throw new Error(`找不到“${label}”字段。`);
  }
  return control;
}

async function changeValue(
  control: HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement,
  value: string
): Promise<void> {
  const prototype = control instanceof HTMLSelectElement
    ? HTMLSelectElement.prototype
    : control instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(prototype, "value")?.set;
  if (setter === undefined) {
    throw new Error("测试环境无法修改表单值。");
  }
  await act(async () => {
    setter.call(control, value);
    control.dispatchEvent(
      new Event(control instanceof HTMLSelectElement ? "change" : "input", {
        bubbles: true
      })
    );
  });
}

afterEach(() => {
  if (root !== undefined) {
    act(() => root?.unmount());
  }
  container?.remove();
  root = undefined;
  container = undefined;
  vi.clearAllMocks();
});

describe("题目审核标签页", () => {
  it("回填并只保存当前用户自己的评价，保留知识点修正", async () => {
    const initial = reviewSummary();
    const statusChanged = vi.fn();
    api.listReviews.mockResolvedValue(initial);
    api.listReviewItems.mockResolvedValue({ round: 1, items: [] });
    api.listTags.mockResolvedValue({
      items: [
        { id: "algorithm.implementation", name: "模拟", group: "算法" },
        { id: "dynamic-programming", name: "动态规划", group: "算法" }
      ]
    });
    api.createReview.mockImplementation(async (_problemId: string, input: ReviewInput) => ({
      ...initial,
      status: "approved" as const,
      decisionSource: "rule" as const,
      reviews: initial.reviews.map((review) =>
        review.id === "own-review"
          ? { ...review, ...input, updatedAt: "2026-07-31T08:01:00.000Z" }
          : review
      )
    }));

    const view = mount(
      <ReviewTab
        problem={problem()}
        currentUserId="current-reviewer"
        onStatusChange={statusChanged}
      />
    );

    await waitFor(() => {
      expect(fieldControl(view, "主要改进点")).toHaveProperty(
        "value",
        "请补充边界情况。"
      );
    });
    expect(view.textContent).toContain("修改我的评价");
    expect(view.textContent).toContain("我的评价 · 人工审核");
    expect(fieldControl(view, "结论")).toHaveProperty("value", "request_changes");
    expect(fieldControl(view, "CF 难度")).toHaveProperty("value", "1800");
    expect(fieldControl(view, "原创性（必填）")).toHaveProperty("value", "4");
    expect(fieldControl(view, "公开评论（可选）")).toHaveProperty("value", "公开评论。");
    expect(
      [...view.querySelectorAll<HTMLButtonElement>(".tag-choice")].find(
        (button) => button.textContent === "动态规划"
      )?.getAttribute("aria-pressed")
    ).toBe("true");
    expect(view.textContent).toContain("题目可能因此直接通过或不通过");

    await changeValue(fieldControl(view, "结论"), "approve");
    await changeValue(
      fieldControl(view, "主要改进点"),
      "已经核对题面、题解和边界情况。"
    );
    const save = [...view.querySelectorAll("button")].find(
      (button) => button.textContent === "保存修改"
    );
    expect(save).not.toBeUndefined();
    await act(async () => {
      save?.click();
    });

    await waitFor(() => expect(api.createReview).toHaveBeenCalledTimes(1));
    const [problemId, input] = api.createReview.mock.calls[0] as [
      string,
      Record<string, unknown>
    ];
    expect(problemId).toBe("problem-1");
    expect(input).toEqual(expect.objectContaining({
      verdict: "approve",
      originalityLevel: 4,
      tagIds: ["dynamic-programming"],
      improvements: "已经核对题面、题解和边界情况。",
      publicComment: "公开评论。",
      expectedRound: 1
    }));
    expect(input).not.toHaveProperty("id");
    expect(input).not.toHaveProperty("reviewerId");
    await waitFor(() => expect(statusChanged).toHaveBeenCalledWith("approved"));
    expect(view.textContent).toContain("审核通过");
    expect(view.querySelector(".review-form")).toBeNull();
  });

  it("只读用户仍能看公开评价，轮次结束后也不显示编辑表单", async () => {
    const readOnlySummary = reviewSummary({
      status: "approved",
      decisionSource: "rule"
    });
    api.listReviews.mockResolvedValue({
      ...readOnlySummary,
      reviews: readOnlySummary.reviews.map((review) => ({
        ...review,
        privateNote: ""
      }))
    });
    api.listReviewItems.mockResolvedValue({ round: 1, items: [] });
    api.listTags.mockResolvedValue({
      items: [
        {
          id: "dynamic-programming",
          name: "动态规划",
          group: "基础算法",
          itemKind: "tag",
          active: false,
          category: { id: "category.algorithm", name: "基础算法" }
        }
      ]
    });

    const view = mount(
      <ReviewTab problem={problem(false)} currentUserId="read-only-user" />
    );

    await waitFor(() => expect(view.textContent).toContain("请补充边界情况。"));
    expect(view.textContent).toContain("AI 审题助手");
    expect(view.textContent).toContain("AI 审核服务");
    expect(view.textContent).toContain("公开评论。");
    expect(view.textContent).toContain("未提供");
    expect(view.textContent).toContain("动态规划（已停用）");
    expect(view.textContent).not.toContain("仅审题人可见。");
    expect(view.querySelector(".review-form")).toBeNull();
    expect(view.textContent).not.toContain("保存修改");
    expect(view.textContent).toContain("本轮审核已经结束，所有意见均为只读");
  });

  it("人工评价没有选择原创性时不能提交，并保存可选公开评论", async () => {
    const initial = reviewSummary();
    api.listReviews.mockResolvedValue({
      ...initial,
      reviews: initial.reviews.filter((review) => review.reviewer.id !== "current-reviewer")
    });
    api.listReviewItems.mockResolvedValue({ round: 1, items: [] });
    api.listTags.mockResolvedValue({ items: [] });
    api.createReview.mockResolvedValue(initial);

    const view = mount(
      <ReviewTab problem={problem()} currentUserId="current-reviewer" />
    );

    await waitFor(() => expect(view.textContent).toContain("提交我的评价"));
    await changeValue(fieldControl(view, "主要改进点"), "已经逐项核对。");
    await changeValue(fieldControl(view, "公开评论（可选）"), "作者可以看到这段说明。");
    const submitButton = [...view.querySelectorAll<HTMLButtonElement>("button")].find(
      (button) => button.textContent === "提交审核意见"
    );
    expect(submitButton?.disabled).toBe(true);
    await act(async () => submitButton?.click());
    expect(api.createReview).not.toHaveBeenCalled();

    await changeValue(fieldControl(view, "原创性（必填）"), "3");
    expect(submitButton?.disabled).toBe(false);
    await act(async () => submitButton?.click());

    await waitFor(() => expect(api.createReview).toHaveBeenCalledTimes(1));
    expect(api.createReview.mock.calls[0]?.[1]).toEqual(expect.objectContaining({
      originalityLevel: 3,
      publicComment: "作者可以看到这段说明。"
    }));
  });

  it("题目还有未保存修改时不能保存审核意见", async () => {
    api.listReviews.mockResolvedValue(reviewSummary());
    api.listReviewItems.mockResolvedValue({ round: 1, items: [] });
    api.listTags.mockResolvedValue({ items: [] });

    const view = mount(
      <ReviewTab
        problem={problem()}
        currentUserId="current-reviewer"
        submissionBlocked
      />
    );

    await waitFor(() => expect(view.textContent).toContain("修改我的评价"));
    const save = [...view.querySelectorAll<HTMLButtonElement>("button")].find(
      (button) => button.textContent === "保存修改"
    );
    expect(save?.disabled).toBe(true);
    expect(view.textContent).toContain("请先保存题目工作区中的修改");
  });

  it("没有写回权限时只读展示建议，不显示字段选择或确认按钮", async () => {
    api.listReviews.mockResolvedValue(reviewSummary({
      status: "approved",
      decisionSource: "rule"
    }));
    api.listReviewItems.mockResolvedValue({ round: 1, items: [] });
    api.listTags.mockResolvedValue({
      items: [
        { id: "algorithm.implementation", name: "模拟", group: "算法" },
        { id: "dynamic-programming", name: "动态规划", group: "算法" }
      ]
    });
    api.getReviewSuggestions.mockResolvedValue(reviewSuggestions(false));

    const view = mount(
      <ReviewTab problem={approvedProblem()} currentUserId="read-only-user" />
    );

    await waitFor(() => expect(view.textContent).toContain("系统不会默认写回任何字段"));
    expect(view.textContent).toContain("当前账号不能把它们写回题目");
    expect(view.textContent).toContain("无对应题目字段");
    expect(view.querySelectorAll('.review-suggestions input[type="checkbox"]')).toHaveLength(0);
    expect(view.textContent).not.toContain("继续确认所选字段");
  });

  it("有权限时默认不选择任何建议，并只写回明确确认的字段", async () => {
    const currentProblem = approvedProblem();
    const updatedProblem = {
      ...currentProblem,
      codeforcesDifficulty: 1800,
      tagIds: ["algorithm.implementation", "dynamic-programming"],
      revision: currentProblem.revision + 1
    };
    const problemChanged = vi.fn();
    api.listReviews.mockResolvedValue(reviewSummary({
      status: "approved",
      decisionSource: "rule"
    }));
    api.listReviewItems.mockResolvedValue({ round: 1, items: [] });
    api.listTags.mockResolvedValue({
      items: [
        { id: "algorithm.implementation", name: "模拟", group: "算法" },
        { id: "dynamic-programming", name: "动态规划", group: "算法" }
      ]
    });
    api.getReviewSuggestions.mockResolvedValue(reviewSuggestions(true));
    api.applyReviewSuggestions.mockResolvedValue(updatedProblem);

    const view = mount(
      <ReviewTab
        problem={currentProblem}
        currentUserId="leader"
        onProblemChange={problemChanged}
      />
    );

    await waitFor(() => expect(view.textContent).toContain("系统不会默认写回任何字段"));
    const checkboxes = [...view.querySelectorAll<HTMLInputElement>('.review-suggestions input[type="checkbox"]')];
    expect(checkboxes).toHaveLength(4);
    expect(checkboxes.every((checkbox) => !checkbox.checked)).toBe(true);
    const continueButton = [...view.querySelectorAll<HTMLButtonElement>("button")].find(
      (button) => button.textContent === "继续确认所选字段"
    );
    expect(continueButton?.disabled).toBe(true);

    const cf = view.querySelector<HTMLInputElement>('input[aria-label="写回CF 难度"]');
    const tags = view.querySelector<HTMLInputElement>('input[aria-label="写回知识点"]');
    await act(async () => {
      cf?.click();
      tags?.click();
    });
    expect(continueButton?.disabled).toBe(false);
    await act(async () => continueButton?.click());
    const confirmButton = [...view.querySelectorAll<HTMLButtonElement>("button")].find(
      (button) => button.textContent === "确认写回"
    );
    expect(confirmButton).not.toBeUndefined();
    await act(async () => confirmButton?.click());

    await waitFor(() => expect(api.applyReviewSuggestions).toHaveBeenCalledTimes(1));
    expect(api.applyReviewSuggestions).toHaveBeenCalledWith("problem-1", {
      expectedRound: 1,
      expectedRevision: 3,
      fields: ["codeforcesDifficulty", "tagIds"]
    });
    await waitFor(() => expect(problemChanged).toHaveBeenCalledWith(updatedProblem));
    expect(view.textContent).toContain("所选字段已经写回题目");
  });

  it("修订冲突时重新读取题目且不显示假写回", async () => {
    const currentProblem = approvedProblem();
    const latestProblem = { ...currentProblem, revision: currentProblem.revision + 1 };
    const problemChanged = vi.fn();
    api.listReviews.mockResolvedValue(reviewSummary({
      status: "approved",
      decisionSource: "rule"
    }));
    api.listReviewItems.mockResolvedValue({ round: 1, items: [] });
    api.listTags.mockResolvedValue({ items: [] });
    api.getReviewSuggestions.mockResolvedValue(reviewSuggestions(true));
    api.applyReviewSuggestions.mockRejectedValue(new ApiError("不应显示的内部冲突细节", 409));
    api.getProblem.mockResolvedValue(latestProblem);

    const view = mount(
      <ReviewTab
        problem={currentProblem}
        currentUserId="leader"
        onProblemChange={problemChanged}
      />
    );

    await waitFor(() => expect(view.textContent).toContain("系统不会默认写回任何字段"));
    const cf = view.querySelector<HTMLInputElement>('input[aria-label="写回CF 难度"]');
    await act(async () => cf?.click());
    const continueButton = [...view.querySelectorAll<HTMLButtonElement>("button")].find(
      (button) => button.textContent === "继续确认所选字段"
    );
    await act(async () => continueButton?.click());
    const confirmButton = [...view.querySelectorAll<HTMLButtonElement>("button")].find(
      (button) => button.textContent === "确认写回"
    );
    await act(async () => confirmButton?.click());

    await waitFor(() => expect(api.getProblem).toHaveBeenCalledWith("problem-1"));
    expect(problemChanged).toHaveBeenCalledWith(latestProblem);
    expect(cf?.checked).toBe(false);
    expect(view.textContent).toContain("已经重新读取最新版本");
    expect(view.textContent).not.toContain("所选字段已经写回题目");
    expect(view.textContent).not.toContain("不应显示的内部冲突细节");
  });

  it("修订冲突后读取最新题目失败时明确保留旧值", async () => {
    api.listReviews.mockResolvedValue(reviewSummary({
      status: "approved",
      decisionSource: "rule"
    }));
    api.listReviewItems.mockResolvedValue({ round: 1, items: [] });
    api.listTags.mockResolvedValue({ items: [] });
    api.getReviewSuggestions.mockResolvedValue(reviewSuggestions(true));
    api.applyReviewSuggestions.mockRejectedValue(new ApiError("不应显示的冲突细节", 409));
    api.getProblem.mockRejectedValue(new ApiError("无法连接到服务端", 0));
    const problemChanged = vi.fn();

    const view = mount(
      <ReviewTab
        problem={approvedProblem()}
        currentUserId="leader"
        onProblemChange={problemChanged}
      />
    );

    await waitFor(() => expect(view.textContent).toContain("系统不会默认写回任何字段"));
    const cf = view.querySelector<HTMLInputElement>('input[aria-label="写回CF 难度"]');
    await act(async () => cf?.click());
    const continueButton = [...view.querySelectorAll<HTMLButtonElement>("button")].find(
      (button) => button.textContent === "继续确认所选字段"
    );
    await act(async () => continueButton?.click());
    const confirmButton = [...view.querySelectorAll<HTMLButtonElement>("button")].find(
      (button) => button.textContent === "确认写回"
    );
    await act(async () => confirmButton?.click());

    await waitFor(() => expect(view.textContent).toContain("最新版本暂时无法读取"));
    expect(view.textContent).toContain("当前页面没有写回任何修改");
    expect(view.textContent).not.toContain("已经重新读取最新版本");
    expect(view.textContent).not.toContain("不应显示的冲突细节");
    expect(problemChanged).not.toHaveBeenCalled();
    expect(cf?.checked).toBe(false);
  });

  it("读取建议失败时不显示服务端的权限或存在性细节", async () => {
    api.listReviews.mockResolvedValue(reviewSummary({
      status: "approved",
      decisionSource: "rule"
    }));
    api.listReviewItems.mockResolvedValue({ round: 1, items: [] });
    api.listTags.mockResolvedValue({ items: [] });
    api.getReviewSuggestions.mockRejectedValue(new ApiError("不应显示的存在性细节", 404));

    const view = mount(
      <ReviewTab problem={approvedProblem()} currentUserId="read-only-user" />
    );

    await waitFor(() => expect(view.textContent).toContain("审核建议暂时无法读取"));
    expect(view.textContent).not.toContain("不应显示的存在性细节");
  });

  it("确认后权限失效时使用统一提示且不刷新成本地成功", async () => {
    api.listReviews.mockResolvedValue(reviewSummary({
      status: "approved",
      decisionSource: "rule"
    }));
    api.listReviewItems.mockResolvedValue({ round: 1, items: [] });
    api.listTags.mockResolvedValue({ items: [] });
    api.getReviewSuggestions.mockResolvedValue(reviewSuggestions(true));
    api.applyReviewSuggestions.mockRejectedValue(new ApiError("不应显示的权限判断细节", 403));

    const view = mount(
      <ReviewTab problem={approvedProblem()} currentUserId="leader" />
    );

    await waitFor(() => expect(view.textContent).toContain("系统不会默认写回任何字段"));
    const cf = view.querySelector<HTMLInputElement>('input[aria-label="写回CF 难度"]');
    await act(async () => cf?.click());
    const continueButton = [...view.querySelectorAll<HTMLButtonElement>("button")].find(
      (button) => button.textContent === "继续确认所选字段"
    );
    await act(async () => continueButton?.click());
    const confirmButton = [...view.querySelectorAll<HTMLButtonElement>("button")].find(
      (button) => button.textContent === "确认写回"
    );
    await act(async () => confirmButton?.click());

    await waitFor(() => expect(view.textContent).toContain("当前无法执行这项操作"));
    expect(view.textContent).not.toContain("不应显示的权限判断细节");
    expect(view.textContent).not.toContain("所选字段已经写回题目");
    expect(api.getProblem).not.toHaveBeenCalled();
  });
});

describe("浏览记录面板", () => {
  function accessProblem(): Problem {
    return {
      ...problem(false),
      status: "approved",
      capabilities: {
        ...problem(false).capabilities,
        canView: true,
        canViewAccessLog: true
      }
    };
  }

  it("没有查看权限时不渲染也不请求浏览记录", () => {
    const view = mount(<OverviewTab problem={problem(false)} update={() => undefined} />);
    expect(view.querySelector(".access-log-panel")).toBeNull();
    expect(api.listProblemAccess).not.toHaveBeenCalled();
  });

  it("有权限时按时间列出浏览者、时长和最后修订", async () => {
    api.listProblemAccess.mockResolvedValue({
      items: [
        {
          user: { id: "author", nickname: "投稿人", accountType: "human" },
          firstAccessedAt: "2026-07-24T09:30:00.000Z",
          lastAccessedAt: "2026-07-25T01:35:00.000Z",
          totalActiveSeconds: 3210,
          lastRevision: 3
        },
        {
          user: { id: "reviewer", nickname: "审题人", accountType: "human" },
          firstAccessedAt: "2026-07-24T11:02:00.000Z",
          lastAccessedAt: "2026-07-24T11:08:00.000Z",
          totalActiveSeconds: 42,
          lastRevision: 2
        }
      ]
    });

    const view = mount(<ProblemAccessPanel problemId="problem-1" />);

    await waitFor(() => expect(view.textContent).toContain("投稿人"));
    expect(api.listProblemAccess).toHaveBeenCalledWith("problem-1");
    expect(view.textContent).toContain("53 分 30 秒");
    expect(view.textContent).toContain("42 秒");
    expect(view.textContent).toContain("最后修订第 3 版");
  });

  it("没有任何访问时展示引导性空状态", async () => {
    api.listProblemAccess.mockResolvedValue({ items: [] });

    const view = mount(<ProblemAccessPanel problemId="problem-1" />);

    await waitFor(() => expect(view.textContent).toContain("还没有人看过这道题。"));
    expect(view.querySelectorAll(".access-log-entry")).toHaveLength(0);
  });

  it("加载失败时展示错误与重试入口", async () => {
    api.listProblemAccess.mockRejectedValueOnce(new ApiError("无法读取浏览记录。", 500));
    api.listProblemAccess.mockResolvedValue({ items: [] });

    const view = mount(<ProblemAccessPanel problemId="problem-1" />);

    await waitFor(() => expect(view.textContent).toContain("无法读取浏览记录。"));
    const retry = [...view.querySelectorAll<HTMLButtonElement>("button")].find(
      (button) => button.textContent === "重试"
    );
    expect(retry).toBeDefined();
    await act(async () => retry?.click());
    await waitFor(() => expect(api.listProblemAccess).toHaveBeenCalledTimes(2));
  });
});
