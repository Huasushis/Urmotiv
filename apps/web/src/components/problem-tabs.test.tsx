import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { Problem, ReviewInput, ReviewRoundSummary } from "@urmotiv/contracts";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  createReview: vi.fn(),
  listReviewItems: vi.fn(),
  listReviews: vi.fn(),
  listTags: vi.fn()
}));

vi.mock("../lib/api", async (importOriginal) => {
  const original = await importOriginal<typeof import("../lib/api")>();
  return { ...original, ...api };
});

import { ReviewTab } from "./problem-tabs";

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
        thinkingLevel: 3,
        codingLevel: 2,
        tagIds: ["dynamic-programming"],
        improvements: "请补充边界情况。",
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
          nickname: "另一位审题人",
          accountType: "human"
        },
        source: "human",
        verdict: "approve",
        codeforcesDifficulty: 1700,
        qualityLevel: 3,
        thinkingLevel: 3,
        codingLevel: 2,
        tagIds: [],
        improvements: "题面和题解一致。",
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
      tagIds: ["dynamic-programming"],
      improvements: "已经核对题面、题解和边界情况。",
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
    api.listTags.mockResolvedValue({ items: [] });

    const view = mount(
      <ReviewTab problem={problem(false)} currentUserId="read-only-user" />
    );

    await waitFor(() => expect(view.textContent).toContain("请补充边界情况。"));
    expect(view.textContent).toContain("另一位审题人");
    expect(view.textContent).not.toContain("仅审题人可见。");
    expect(view.querySelector(".review-form")).toBeNull();
    expect(view.textContent).not.toContain("保存修改");
    expect(view.textContent).toContain("本轮审核已经结束，所有意见均为只读");
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
});
