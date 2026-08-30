import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { Problem, SimilarityCheckResponse } from "@urmotiv/contracts";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SimilarityCheckPanel } from "./problem-workspace-page";

const api = vi.hoisted(() => ({
  deleteProblem: vi.fn(),
  getProblem: vi.fn(),
  listTags: vi.fn(),
  recordProblemActivity: vi.fn(),
  runSimilarityCheck: vi.fn(),
  submitProblem: vi.fn(),
  updateProblem: vi.fn(),
  withdrawProblem: vi.fn()
}));

vi.mock("../lib/api", async (importOriginal) => {
  const original = await importOriginal<typeof import("../lib/api")>();
  return { ...original, ...api };
});

import { ProblemWorkspacePage } from "./problem-workspace-page";
import { ReviewItemCard } from "../components/problem-tabs";
import { ApiError } from "../lib/api";

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

function titleOnlyProblem(): Problem {
  return {
    id: "p-title-1",
    title: "原标题",
    type: "traditional",
    tagIds: ["tag-1"],
    codeforcesDifficulty: null,
    thinkingLevel: null,
    codingLevel: null,
    content: {
      basicStatement: "题面",
      basicSolution: "题解",
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
    revision: 3,
    reviewRound: 1,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    capabilities: {
      canView: true,
      canEdit: false,
      canEditTitle: true,
      canEditFrozen: false,
      canSubmit: false,
      canWithdraw: true,
      canReview: false,
      canChangeStatus: false,
      canReadTestdata: false,
      canWriteTestdata: false,
      canExport: false,
      canViewAccessLog: false
    }
  } as Problem;
}

let root: Root | undefined;
let queryClient: QueryClient | undefined;
let container: HTMLDivElement | undefined;

function mount(element: ReactNode): HTMLDivElement {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } }
  });
  act(() => {
    root?.render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={["/problems/p-title-1"]}>
          <Routes>
            <Route path="/problems/:problemId" element={element} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>
    );
  });
  return container;
}

async function waitFor(assertion: () => void): Promise<void> {
  let latestError: unknown;
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      assertion();
      return;
    } catch (error) {
      latestError = error;
      await new Promise<void>((resolve) => setTimeout(resolve, 50));
    }
  }
  throw latestError;
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

describe("ProblemWorkspacePage 名称专用权限自动保存", () => {
  afterEach(() => {
    act(() => root?.unmount());
    container?.remove();
    root = undefined;
    container = undefined;
    queryClient = undefined;
    sessionStorage.clear();
    vi.clearAllMocks();
  });

  it("canEdit=false + canEditTitle=true 时只发送 expectedRevision 和 title", async () => {
    const base = titleOnlyProblem();
    api.getProblem.mockResolvedValue(base);
    api.recordProblemActivity.mockResolvedValue(undefined);
    api.listTags.mockResolvedValue([]);
    const saved = { ...base, title: "新标题", revision: 4, updatedAt: "2026-01-02T00:00:00.000Z" };
    api.updateProblem.mockResolvedValue(saved);

    mount(<ProblemWorkspacePage currentUserId="author" />);

    await waitFor(() => expect(container!.textContent).toContain("原标题"));

    const titleInput = container!.querySelector('input[value="原标题"]') as HTMLInputElement;
    expect(titleInput).toBeTruthy();
    expect(titleInput.disabled).toBe(false);

    await act(async () => {
      const nativeInputValueSetter = Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype,
 "value"
      )!.set;
      nativeInputValueSetter!.call(titleInput, "新标题");
      titleInput.dispatchEvent(new Event("input", { bubbles: true }));
    });

    await waitFor(() =>
      expect(api.updateProblem).toHaveBeenCalledWith("p-title-1", {
        expectedRevision: 3,
        title: "新标题"
      })
    );

    expect(api.updateProblem).toHaveBeenCalledTimes(1);
    const payload = api.updateProblem.mock.calls[0]![1];
    expect(Object.keys(payload).sort()).toEqual(["expectedRevision", "title"]);

    await waitFor(() => expect(container!.textContent).toContain("新标题"));
    await waitFor(() => expect(container!.textContent).toContain("已保存"));
  });

  it("自动保存再次被服务端拒绝时立即清除题目、缓存和草稿", async () => {
    const base = titleOnlyProblem();
    api.getProblem.mockResolvedValue(base);
    api.recordProblemActivity.mockResolvedValue(undefined);
    api.listTags.mockResolvedValue([]);
    api.updateProblem.mockRejectedValue(new ApiError("不应回显的保存拒绝", 403));

    mount(<ProblemWorkspacePage currentUserId="author" />);
    await waitFor(() => expect(container!.textContent).toContain("原标题"));
    sessionStorage.setItem(
      "urmotiv.web.unsaved.author.p-title-1",
      JSON.stringify({ ...base, title: "不应保留的草稿" })
    );

    const titleInput = container!.querySelector('input[value="原标题"]') as HTMLInputElement;
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype,
        "value"
      )!.set;
      setter!.call(titleInput, "触发撤权保存");
      titleInput.dispatchEvent(new Event("input", { bubbles: true }));
    });

    await waitFor(() => expect(api.updateProblem).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(container!.textContent).toContain("题目不存在"));
    expect(container!.textContent).not.toContain("原标题");
    expect(container!.textContent).not.toContain("不应回显的保存拒绝");
    expect(queryClient!.getQueryData(["problem", "p-title-1", "author"])).toBeUndefined();
    expect(sessionStorage.getItem("urmotiv.web.unsaved.author.p-title-1")).toBeNull();
  });

  it("提交审核再次被服务端拒绝时不保留已打开题目", async () => {
    const base = {
      ...titleOnlyProblem(),
      status: "draft" as const,
      capabilities: {
        ...titleOnlyProblem().capabilities,
        canSubmit: true,
        canWithdraw: false
      }
    };
    api.getProblem.mockResolvedValue(base);
    api.recordProblemActivity.mockResolvedValue(undefined);
    api.listTags.mockResolvedValue([]);
    api.submitProblem.mockRejectedValue(new ApiError("不应回显的提交拒绝", 404));

    mount(<ProblemWorkspacePage currentUserId="author" />);
    await waitFor(() => expect(container!.textContent).toContain("原标题"));
    const submit = [...container!.querySelectorAll<HTMLButtonElement>("button")]
      .find((button) => button.textContent?.includes("提交审核"));
    expect(submit).not.toBeUndefined();
    await act(async () => {
      submit?.click();
    });

    await waitFor(() => expect(container!.textContent).toContain("题目不存在"));
    expect(container!.textContent).not.toContain("原标题");
    expect(container!.textContent).not.toContain("不应回显的提交拒绝");
    expect(queryClient!.getQueryData(["problem", "p-title-1", "author"])).toBeUndefined();
  });

  it("服务端允许删除时显示二次确认并携带当前修订号", async () => {
    const base = {
      ...titleOnlyProblem(),
      status: "draft" as const,
      capabilities: {
        ...titleOnlyProblem().capabilities,
        canDelete: true,
        canEdit: true,
        canEditTitle: true,
        canWithdraw: false
      }
    };
    api.getProblem.mockResolvedValue(base);
    api.recordProblemActivity.mockResolvedValue(undefined);
    api.listTags.mockResolvedValue([]);
    api.deleteProblem.mockResolvedValue({ ok: true });

    mount(<ProblemWorkspacePage currentUserId="author" />);
    await waitFor(() => expect(container!.textContent).toContain("原标题"));
    const deleteButton = [...container!.querySelectorAll<HTMLButtonElement>("button")]
      .find((button) => button.textContent?.trim() === "删除");
    expect(deleteButton).toBeDefined();
    await act(async () => deleteButton?.click());
    expect(container!.textContent).toContain("确认删除题目");
    expect(api.deleteProblem).not.toHaveBeenCalled();
    const confirmButton = [...container!.querySelectorAll<HTMLButtonElement>("button")]
      .find((button) => button.textContent?.trim() === "确认删除");
    await act(async () => confirmButton?.click());
    await waitFor(() => expect(api.deleteProblem).toHaveBeenCalledWith("p-title-1", 3));
  });

  it.each([401, 403, 404])(
    "已加载题目在重新读取返回 %i 后清除 DOM、查询缓存和本地草稿",
    async (status) => {
      const base = titleOnlyProblem();
      api.getProblem
        .mockResolvedValueOnce(base)
        .mockRejectedValueOnce(new ApiError(`虚构 ${status} 错误`, status));
      api.recordProblemActivity.mockResolvedValue(undefined);
      api.listTags.mockResolvedValue([]);

      mount(<ProblemWorkspacePage currentUserId="author" />);
      await waitFor(() => expect(container!.textContent).toContain("原标题"));
      sessionStorage.setItem(
        "urmotiv.web.unsaved.author.p-title-1",
        JSON.stringify({ ...base, title: "不应保留的本地草稿" })
      );

      await act(async () => {
        await queryClient!.invalidateQueries({
          queryKey: ["problem", "p-title-1", "author"],
          exact: true
        });
      });

      await waitFor(() => expect(container!.textContent).toContain("题目不存在"));
      expect(container!.textContent).not.toContain("原标题");
      expect(container!.textContent).not.toContain("题面");
      expect(container!.textContent).not.toContain(`虚构 ${status} 错误`);
      expect(api.getProblem).toHaveBeenCalledTimes(2);
      await waitFor(() => {
        expect(queryClient!.getQueryData(["problem", "p-title-1", "author"])).toBeUndefined();
      });
      expect(sessionStorage.getItem("urmotiv.web.unsaved.author.p-title-1")).toBeNull();
    }
  );

  it("真实不存在与撤权使用相同的安全页面且不回显后端消息", async () => {
    api.getProblem.mockRejectedValue(new ApiError("虚构但不可回显的详情", 404));
    api.recordProblemActivity.mockResolvedValue(undefined);
    api.listTags.mockResolvedValue([]);

    mount(<ProblemWorkspacePage currentUserId="author" />);

    await waitFor(() => expect(container!.textContent).toContain("题目不存在"));
    expect(container!.textContent).toContain("题目不存在或当前账号不能访问");
    expect(container!.textContent).not.toContain("虚构但不可回显的详情");
    expect(queryClient!.getQueryData(["problem", "p-title-1", "author"])).toBeUndefined();
  });
});

describe("原题检索条目省略决策字段时的渲染", () => {
  const bareFiveFieldItem = (overrides: Record<string, unknown> = {}) => ({
    id: "ri-anklang-1",
    type: "org.ustc.urmotiv.anklang.similarity",
    source: "anklang",
    visibility: "author" as const,
    summary: "完整检索发现 1 道候选题。",
    createdAt: "2026-08-01T00:00:00.000Z",
    data: {
      apiVersion: "2",
      checkedAt: "2026-08-01T00:00:00.000Z",
      completion: { status: "complete", reasonCode: "complete", retryable: false },
      candidates: [
        {
          source: "公开题库",
          externalId: "sample-1",
          title: "相似的公开题",
          similarity: 0.82,
          metadata: { origin: "CF", rounds: 3 }
        }
      ],
      ...overrides,
    }
  });

  it("search-only 条目不携带 recommendation/reuse 时候选仍可见且不泄露默认值", () => {
    const html = renderToStaticMarkup(<ReviewItemCard item={bareFiveFieldItem()} defaultExpanded />);
    expect(html).toContain("相似的公开题");
    expect(html).toContain("82%");
    expect(html).toContain("收起候选");
    // 不合成推荐文案、拦截语义或复用策略。
    expect(html).not.toContain("建议");
    expect(html).not.toContain("拦截");
    expect(html).not.toContain("no-store");
    expect(html).not.toContain("allowed");
    expect(html).not.toContain("expiresAt");
    expect(html).not.toContain("blockSubmission");
  });


});
