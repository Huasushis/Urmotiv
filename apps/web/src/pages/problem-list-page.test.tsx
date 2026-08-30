import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ProblemCapabilities, ProblemListResponse, SessionUser } from "@urmotiv/contracts";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  listProblems: vi.fn(),
  listTags: vi.fn(),
  batchChangeProblemStatus: vi.fn()
}));

vi.mock("../lib/api", async (importOriginal) => {
  const original = await importOriginal<typeof import("../lib/api")>();
  return { ...original, ...api };
});

import { ProblemListPage } from "./problem-list-page";

const capabilities: ProblemCapabilities = {
  canView: true,
  canEdit: true,
  canEditTitle: true,
  canEditFrozen: false,
  canSubmit: false,
  canWithdraw: false,
  canReview: false,
  canChangeStatus: true,
  canReadTestdata: true,
  canWriteTestdata: true,
  canExport: true,
  canViewAccessLog: true,
  canDelete: true
};

const response: ProblemListResponse = {
  items: [
    {
      id: "problem-draft",
      title: "批量管理草稿",
      type: "traditional",
      status: "draft",
      codeforcesDifficulty: 1200,
      thinkingLevel: 2,
      codingLevel: 2,
      tagIds: ["algorithm.implementation"],
      owner: { id: "author", nickname: "投稿人", accountType: "human" },
      revision: 3,
      reviewRound: 0,
      updatedAt: "2026-08-30T00:00:00.000Z",
      capabilities,
      origin: "native",
      importBatch: null,
      importSource: null
    },
    {
      id: "problem-pending",
      title: "批量管理待审题",
      type: "traditional",
      status: "pending_review",
      codeforcesDifficulty: 1500,
      thinkingLevel: 3,
      codingLevel: 3,
      tagIds: ["algorithm.implementation"],
      owner: { id: "author", nickname: "投稿人", accountType: "human" },
      revision: 5,
      reviewRound: 2,
      updatedAt: "2026-08-30T01:00:00.000Z",
      capabilities,
      origin: "native",
      importBatch: null,
      importSource: null
    }
  ],
  total: 2,
  page: 1,
  pageSize: 50
};

const manager: SessionUser = {
  id: "manager",
  nickname: "系统管理员",
  accountType: "human",
  permissions: ["problem.view.all", "problem.status.change", "problem.create"],
  roles: ["系统管理员"],
  isRoot: false,
  canManageReviewPolicy: true,
  canManagePlugins: true,
  canManageTags: true,
  canManageProblemCatalog: true,
  canManageProblemStatuses: true
};

let root: Root | undefined;
let container: HTMLDivElement | undefined;
let client: QueryClient | undefined;

function mount(session: SessionUser = manager): HTMLDivElement {
  api.listProblems.mockResolvedValue(response);
  api.listTags.mockResolvedValue({
    items: [{
      id: "algorithm.implementation",
      name: "模拟",
      group: "算法",
      itemKind: "tag",
      active: true,
      category: { id: "category.algorithm", name: "算法" }
    }]
  });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } }
  });
  act(() => {
    root?.render(
      <QueryClientProvider client={client}>
        <MemoryRouter initialEntries={["/admin/problems"]}>
          <ProblemListPage managementSession={session} />
        </MemoryRouter>
      </QueryClientProvider>
    );
  });
  return container;
}

async function waitFor(assertion: () => void): Promise<void> {
  let latest: unknown;
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      assertion();
      return;
    } catch (error) {
      latest = error;
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 10));
      });
    }
  }
  throw latest;
}

async function changeSelect(select: HTMLSelectElement, value: string): Promise<void> {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")!.set!.call(select, value);
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

async function changeInput(input: HTMLInputElement, value: string): Promise<void> {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  client?.clear();
  root = undefined;
  container = undefined;
  client = undefined;
  vi.clearAllMocks();
  vi.restoreAllMocks();
});

describe("题目批量管理页", () => {
  it("按操作限制可选状态，并提交修订号与审核轮次", async () => {
    api.batchChangeProblemStatus.mockResolvedValue({
      results: [{ id: "problem-pending", ok: true, status: "rejected", revision: 6 }]
    });
    vi.spyOn(window, "confirm").mockReturnValue(true);
    const view = mount();
    await waitFor(() => expect(view.textContent).toContain("批量管理待审题"));

    const action = [...view.querySelectorAll<HTMLSelectElement>("select")]
      .find((select) => select.querySelector('option[value="reject"]'))!;
    await changeSelect(action, "reject");
    const pendingCheckbox = view.querySelector<HTMLInputElement>(
      'input[aria-label="选择题目 批量管理待审题"]'
    )!;
    const draftCheckbox = view.querySelector<HTMLInputElement>(
      'input[aria-label="选择题目 批量管理草稿"]'
    )!;
    expect(pendingCheckbox.disabled).toBe(false);
    expect(draftCheckbox.disabled).toBe(true);
    await act(async () => pendingCheckbox.click());

    const reason = [...view.querySelectorAll<HTMLInputElement>("input")]
      .find((input) => input.placeholder.includes("审核决定"))!;
    await changeInput(reason, "批量复核后确认不通过。");
    const execute = [...view.querySelectorAll<HTMLButtonElement>("button")]
      .find((button) => button.textContent?.includes("执行确认不通过"))!;
    await act(async () => execute.click());

    await waitFor(() => expect(api.batchChangeProblemStatus).toHaveBeenCalledTimes(1));
    expect(api.batchChangeProblemStatus.mock.calls[0]?.[0]).toEqual({
      action: "reject",
      reason: "批量复核后确认不通过。",
      items: [{
        id: "problem-pending",
        expectedRevision: 5,
        expectedRound: 2
      }]
    });
    await waitFor(() => expect(view.textContent).toContain("1 道成功"));
  });

  it("没有全局状态管理能力时不读取题目列表", () => {
    const view = mount({ ...manager, canManageProblemStatuses: false });
    expect(view.textContent).toContain("没有批量管理题目状态的权限");
    expect(api.listProblems).not.toHaveBeenCalled();
  });
});
