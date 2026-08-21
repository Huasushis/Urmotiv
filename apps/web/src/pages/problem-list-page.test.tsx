import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ProblemListResponse, ProblemStatus, SessionResponse } from "@urmotiv/contracts";
import type * as ApiModule from "../lib/api";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  getSession: vi.fn(),
  listProblems: vi.fn(),
  listTags: vi.fn()
}));

vi.mock("../lib/api", async (importOriginal) => {
  const original = await importOriginal<typeof ApiModule>();
  return { ...original, ...api };
});

import { ApiError } from "../lib/api";
import { ProblemListPage } from "./problem-list-page";

function sessionWithPermissions(permissions: string[]): SessionResponse {
  return {
    user: {
      id: "leader",
      nickname: "组长",
      accountType: "human",
      permissions,
      roles: ["组长"],
      isRoot: false,
      canManageReviewPolicy: false,
      canManagePlugins: false,
      canManageTags: false
    },
    auth: {
      emailEnabled: false,
      emailRegistrationEnabled: false,
      ustcOAuthEnabled: false,
      casEnabled: false,
      demoEnabled: true
    }
  };
}

function item(overrides: Partial<ProblemListResponse["items"][number]> = {}) {
  return {
    id: "p-1",
    title: "示例题",
    type: "traditional" as const,
    status: "draft" as const,
    codeforcesDifficulty: 1600,
    thinkingLevel: 2,
    codingLevel: 3,
    tagIds: ["tag-a"],
    owner: { id: "u-1", nickname: "例题作者", accountType: "human" as const },
    revision: 1,
    updatedAt: "2026-01-02T03:04:05.000Z",
    capabilities: {
      canView: true,
      canEdit: false,
      canEditTitle: false,
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
  };
}

const emptyList: ProblemListResponse = { items: [], total: 0, page: 1, pageSize: 20 };
const onePage: ProblemListResponse = { items: [item({ id: "p-1" })], total: 1, page: 1, pageSize: 20 };

let root: Root | undefined;
let container: HTMLDivElement | undefined;
let queryClient: QueryClient | undefined;

function mount(props: { ownOnly?: boolean; fixedStatus?: ProblemStatus } = {}, session: SessionResponse = sessionWithPermissions(["problem.create"])): HTMLDivElement {
  api.getSession.mockResolvedValue(session);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } }
  });
  queryClient = client;
  client.setQueryData(["session"], session);
  act(() => {
    root?.render(
      <QueryClientProvider client={client}>
        <MemoryRouter initialEntries={["/problems"]}>
          <ProblemListPage {...props} />
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
      const promise = new Promise<void>((resolve) => { setTimeout(resolve, 5); });
      await act(async () => {
        await promise;
      });
    }
  }
  throw latestError;
}

afterEach(() => {
  if (root !== undefined) {
    act(() => root?.unmount());
  }
  queryClient!.clear();
  container?.remove();
  root = undefined;
  container = undefined;
  queryClient = undefined;
  vi.clearAllMocks();
});

describe("题目列表页状态", () => {
  it("加载中显示占位行和筛选计数", () => {
    api.listProblems.mockReturnValue(new Promise<ProblemListResponse>(() => { /* pending */ }));
    api.listTags.mockResolvedValue({ items: [] });

    const view = mount();

    expect(view.textContent).toContain("正在加载题目…");
    expect(view.textContent).toContain("0 道");
  });

  it("数据到达后渲染每行内容含知识点回退与超量收缩", async () => {
    api.listProblems.mockResolvedValue({
      items: [
        item({ id: "p-1", tagIds: ["tag-a", "tag-missing", "tag-b", "tag-d"] }),
        item({ id: "p-2", title: "交互题", type: "interactive", status: "approved", codeforcesDifficulty: null, tagIds: [], owner: { id: "u-2", nickname: "作者乙", accountType: "human" } })
      ],
      total: 2,
      page: 1,
      pageSize: 20
    });
    api.listTags.mockResolvedValue({
      items: [
        { id: "tag-a", name: "动态规划", parentId: null, active: true },
        { id: "tag-b", name: "组合数学", parentId: null, active: true }
      ]
    });

    const view = mount();
    await waitFor(() => expect(view.textContent).toContain("示例题"));

    const rows = [...view.querySelectorAll<HTMLTableRowElement>("tbody tr")];
    expect(rows.length).toBe(2);
    const firstCells = new Map(
      [...rows[0]!.querySelectorAll<HTMLTableCellElement>("td")]
        .map((cell) => [cell.dataset.label ?? "", cell.textContent?.trim() ?? ""])
    );
    expect(firstCells.get("题目")).toContain("示例题");
    expect(firstCells.get("状态")).toBe("草稿");
    expect(firstCells.get("类型")).toBe("传统题");
    expect(firstCells.get("难度")).toBe("1600");
    expect(firstCells.get("作者")).toBe("例题作者");
    expect(firstCells.get("题目")).toContain("示例题");
    expect(firstCells.get("状态")).toBe("草稿");
    expect(firstCells.get("类型")).toBe("传统题");
    expect(firstCells.get("难度")).toBe("1600");
    expect(firstCells.get("作者")).toBe("例题作者");
    expect(firstCells.get("知识点")).toContain("动态规划");
    expect(firstCells.get("知识点")).toContain("tag-missing");
    expect(firstCells.get("知识点")).toContain("+2");
    expect(firstCells.get("知识点")).not.toContain("组合数学");
    expect(firstCells.get("更新")).not.toBe("");
    const secondCells = new Map(
      [...rows[1]!.querySelectorAll<HTMLTableCellElement>("td")]
        .map((cell) => [cell.dataset.label ?? "", cell.textContent?.trim() ?? ""])
    );
    expect(secondCells.get("题目")).toContain("交互题");
    expect(secondCells.get("类型")).toBe("交互题");
    expect(secondCells.get("状态")).toBe("审核通过");
  });

  it("空数据时显示没有符合条件的题目", async () => {
    api.listProblems.mockResolvedValue(emptyList);
    api.listTags.mockResolvedValue({ items: [] });

    const view = mount();
    await waitFor(() => expect(view.textContent).toContain("没有符合条件的题目"));
  });

  it("加载失败显示可重试的错误区，重试后成功清除", async () => {
    api.listProblems
      .mockRejectedValueOnce(new ApiError("不应出现的虚构错误", 503))
      .mockResolvedValueOnce(onePage);
    api.listTags.mockResolvedValue({ items: [] });

    const view = mount();
    await waitFor(() => expect(view.textContent).toContain("题目列表加载失败"));
    expect(view.textContent).toContain("不应出现的虚构错误");

    const retry = [...view.querySelectorAll<HTMLButtonElement>("button")]
      .find((button) => button.textContent?.includes("重试"));
    expect(retry).toBeTruthy();
    await act(async () => {
      retry?.click();
    });
    await waitFor(() => expect(view.textContent).toContain("示例题"));
    expect(view.textContent).not.toContain("题目列表加载失败");

    expect(api.listProblems).toHaveBeenCalledTimes(2);
  });
});

describe("题目列表页权限与模式", () => {
  it("没有 problem.create 权限时不渲染新建入口", async () => {
    api.listProblems.mockResolvedValue(emptyList);
    api.listTags.mockResolvedValue({ items: [] });

    const view = mount({}, sessionWithPermissions([]));
    await waitFor(() => expect(view.textContent).toContain("没有符合条件的题目"));
    expect([...view.querySelectorAll<HTMLAnchorElement>("a")]
      .some((anchor) => anchor.textContent?.includes("新建题目"))).toBe(false);
  });

  it("有权限时新建入口链接到 /problems/new", async () => {
    api.listProblems.mockResolvedValue(emptyList);
    api.listTags.mockResolvedValue({ items: [] });

    const view = mount();
    await waitFor(() => expect(view.textContent).toContain("没有符合条件的题目"));
    const createLink = [...view.querySelectorAll<HTMLAnchorElement>("a")]
      .find((anchor) => anchor.textContent?.includes("新建题目"));
    expect(createLink).toBeTruthy();
    expect(createLink?.getAttribute("href")).toBe("/problems/new");
  });

  it("固定待审模式显示待审核标题、禁用状态下拉并把状态带入请求", async () => {
    api.listProblems.mockResolvedValue(emptyList);
    api.listTags.mockResolvedValue({ items: [] });

    const view = mount({ fixedStatus: "pending_review" });
    await waitFor(() => expect(view.querySelectorAll("tbody tr").length).toBe(1));

    expect(view.querySelector("h1")?.textContent).toBe("待审核题目");
    const statusSelect = [...view.querySelectorAll<HTMLSelectElement>("select")]
      .find((select) => select.closest('label')?.textContent?.includes("状态"));
    expect(statusSelect?.disabled).toBe(true);
    const query = api.listProblems.mock.calls[0]?.[0];
    expect(query?.status).toBe("pending_review");
  });

  it("ownOnly 模式下请求带 owner=me 且标题为我的投稿", async () => {
    api.listProblems.mockResolvedValue(emptyList);
    api.listTags.mockResolvedValue({ items: [] });

    const view = mount({ ownOnly: true });
    await waitFor(() => expect(view.textContent).toContain("我的投稿"));

    const query = api.listProblems.mock.calls[0]?.[0];
    expect(query?.owner).toBe("me");
  });
});

describe("题目列表页筛选与分页", () => {
  it("改变搜索框后以第 1 页重新发起请求", async () => {
    api.listProblems.mockResolvedValue(emptyList);
    api.listTags.mockResolvedValue({ items: [] });

    const view = mount();
    await waitFor(() => expect(api.listProblems).toHaveBeenCalledTimes(1));

    const search = view.querySelector<HTMLInputElement>('input[placeholder*="搜索题号"]');
    expect(search).toBeTruthy();
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set;
      setter!.call(search, "回文");
      search!.dispatchEvent(new Event("input", { bubbles: true }));
    });

    await waitFor(() => expect(api.listProblems).toHaveBeenCalledTimes(2));
    const query = api.listProblems.mock.calls[1]?.[0];
    expect(query?.search).toBe("回文");
    expect(query?.page).toBe(1);
  });

  it("多于一页时下一页可用、到达末页禁用，翻页请求携带页码", async () => {
    const first = { items: [item({ id: "p-1" })], total: 25, page: 1, pageSize: 20 };
    const second = { items: [item({ id: "p-2" })], total: 25, page: 2, pageSize: 20 };
    api.listProblems.mockResolvedValueOnce(first).mockResolvedValueOnce(second);
    api.listTags.mockResolvedValue({ items: [] });

    const view = mount();
    await waitFor(() => expect(view.textContent).toContain("1 / 2 页"));

    const buttons = [...view.querySelectorAll<HTMLButtonElement>("button")];
    const prev = buttons.find((button) => button.getAttribute("aria-label") === "上一页");
    const next = buttons.find((button) => button.getAttribute("aria-label") === "下一页");
    expect(prev?.disabled).toBe(true);
    expect(next?.disabled).toBe(false);

    await act(async () => {
      next?.click();
    });
    await waitFor(() => expect(view.textContent).toContain("2 / 2 页"));
    expect(api.listProblems).toHaveBeenCalledTimes(2);

    const pageTwoQuery = api.listProblems.mock.calls[1]?.[0];
    expect(pageTwoQuery?.page).toBe(2);
    await waitFor(() => expect(view.textContent).toContain("p-2"));
  });
});
