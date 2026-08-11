import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { Problem, SimilarityCheckResponse } from "@urmotiv/contracts";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SimilarityCheckPanel } from "./problem-workspace-page";

const api = vi.hoisted(() => ({
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
let container: HTMLDivElement | undefined;

function mount(element: ReactNode): HTMLDivElement {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } }
  });
  act(() => {
    root?.render(
      <QueryClientProvider client={client}>
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
      const { promise, resolve } = Promise.withResolvers<void>();
      setTimeout(resolve, 50);
      await promise;
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
});
