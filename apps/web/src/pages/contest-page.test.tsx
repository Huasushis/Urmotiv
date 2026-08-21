import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { Contest, ContestListResponse, SessionResponse } from "@urmotiv/contracts";
import type * as ApiModule from "../lib/api";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  getSession: vi.fn(),
  listContests: vi.fn(),
  getContest: vi.fn(),
  createContest: vi.fn(),
  updateContest: vi.fn()
}));

vi.mock("../lib/api", async (importOriginal) => {
  const original = await importOriginal<typeof ApiModule>();
  return { ...original, ...api };
});

import { ApiError } from "../lib/api";
import { ContestPage } from "./contest-page";

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

function contest(overrides: Partial<Contest> = {}): Contest {
  return {
    id: "c-1",
    title: "示例组题方案",
    description: "用于测试的方案",
    state: "draft",
    startsAt: null,
    endsAt: null,
    creator: { id: "leader", nickname: "组长", accountType: "human" },
    members: [
      { user: { id: "u-9", nickname: "参赛者", accountType: "human" }, role: "participant" }
    ],
    problems: [
      {
        position: 0,
        problemId: "9001",
        revisionId: "11111111-1111-4111-8111-111111111111",
        revision: 3,
        title: "示例题",
        score: 100,
        estimatedDifficulty: 2,
        leakRiskCount: 0,
        leakRiskEntries: []
      }
    ],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-02T00:00:00.000Z",
    capabilities: { canEdit: true, canDelete: false, canExport: false, canReadRisk: true },
    ...overrides
  };
}

function listResponse(contests: Contest[]): ContestListResponse {
  const items: ContestListResponse["items"] = [];
  for (const item of contests) {
    items.push({
      id: item.id,
      title: item.title,
      state: item.state,
      startsAt: item.startsAt,
      endsAt: item.endsAt,
      creator: item.creator,
      createdAt: item.createdAt,
      updatedAt: item.updatedAt,
      capabilities: item.capabilities,
      problemCount: item.problems.length,
      participantCount: item.members.filter((member) => member.role === "participant").length,
      leakRiskCount: item.problems.reduce((sum, problem) => sum + problem.leakRiskCount, 0)
    });
  }
  return { items };
}

let root: Root | undefined;
let container: HTMLDivElement | undefined;
let queryClient: QueryClient | undefined;

function mount(session: SessionResponse): HTMLDivElement {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } }
  });
  queryClient = client;
  client.setQueryData(["session"], session);
  api.getSession.mockResolvedValue(session);
  act(() => {
    root?.render(
      <QueryClientProvider client={client}>
        <MemoryRouter initialEntries={["/contests"]}>
          <ContestPage />
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

function buttonWithText(view: HTMLElement, text: string): HTMLButtonElement | undefined {
  return [...view.querySelectorAll<HTMLButtonElement>("button")]
    .find((candidate) => candidate.textContent?.includes(text));
}

function buttonWithExactText(view: HTMLElement, text: string): HTMLButtonElement | undefined {
  return [...view.querySelectorAll<HTMLButtonElement>("button")]
    .find((candidate) => candidate.textContent?.trim() === text);
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

describe("组题页权限边界", () => {
  it("没有比赛方案权限时仅显示拒绝页，不渲染任何方案内容", async () => {
    api.listContests.mockResolvedValue({ items: [] });

    const view = mount(sessionWithPermissions([]));

    await waitFor(() => expect(view.textContent).toContain("当前账号不能查看组题方案"));
    expect(view.textContent).toContain("返回题目列表");
    expect(view.textContent).not.toContain("示例组题方案");
    expect(view.textContent).not.toContain("比赛信息");
    expect(view.textContent).not.toContain("方案里还没有题目");
  });

  it("只有查看风险权限时仍可打开方案但不显示新建按钮", async () => {
    const riskSession = sessionWithPermissions(["contest.risk.read"]);
    const noEdit = contest({ capabilities: { canEdit: false, canDelete: false, canExport: false, canReadRisk: true } });
    api.listContests.mockResolvedValue(listResponse([noEdit]));
    api.getContest.mockResolvedValue(noEdit);

    const view = mount(riskSession);
    await waitFor(() => expect(view.textContent).toContain("示例题"));
    expect(buttonWithText(view, "新建")).toBeUndefined();
    expect(buttonWithText(view, "锁定")).toBeUndefined();
  });
});

describe("组题页列表与选择", () => {
  it("加载方案与打开方案的过程状态可区分", async () => {
    api.listContests.mockResolvedValue(listResponse([contest()]));
    api.getContest.mockReturnValue(new Promise<Contest>(() => { /* pending */ }));

    const view = mount(sessionWithPermissions(["contest.create"]));
    await waitFor(() => expect(api.listContests).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(view.textContent).toContain("正在打开方案…"));
  });

  it("列表为空时显示暂无方案的提示", async () => {
    api.listContests.mockResolvedValue(listResponse([]));

    const view = mount(sessionWithPermissions(["contest.create"]));
    await waitFor(() => expect(view.textContent).toContain("当前没有可查看的组题方案。"));
    expect(view.textContent).toContain("选择一个方案查看内容。");
  });

  it("列表加载失败时显示错误、不显示空态", async () => {
    api.listContests.mockRejectedValue(new ApiError("组题方案暂时无法读取", 503));

    const view = mount(sessionWithPermissions(["contest.create"]));
    await waitFor(() => expect(view.textContent).toContain("组题方案暂时无法读取"));
    expect(view.textContent).not.toContain("正在加载…");
    expect(view.textContent).not.toContain("当前没有可查看的组题方案");
  });

  it("方案数据到达后自动选中第一项并渲染详情", async () => {
    api.listContests.mockResolvedValue(listResponse([contest()]));
    api.getContest.mockResolvedValue(contest());

    const view = mount(sessionWithPermissions(["contest.create"]));
    await waitFor(() => expect(view.textContent).toContain("示例题"));
    expect(view.textContent).toContain("1 题 · 1 名参与者");
    expect(view.textContent).toContain("第 3 版");
    expect(view.textContent).toContain("未发现");
    expect(view.textContent).toContain("参赛者");
  });

  it("打开方案失败时详情区显示错误", async () => {
    api.listContests.mockResolvedValue(listResponse([contest()]));
    api.getContest.mockRejectedValue(new ApiError("方案不存在或无权访问", 404));

    const view = mount(sessionWithPermissions(["contest.create"]));
    await waitFor(() => expect(view.textContent).toContain("方案不存在或无权访问"));
  });
});

describe("组题页新建方案", () => {
  it("标题为空时无法提交，填写后按输入构造请求并在成功后切换详情", async () => {
    api.listContests.mockResolvedValue(listResponse([]));
    api.getContest.mockResolvedValue(contest());
    api.createContest.mockResolvedValue(contest());

    const view = mount(sessionWithPermissions(["contest.create"]));
    await waitFor(() => expect(view.textContent).toContain("当前没有可查看的组题方案"));

    await act(async () => {
      buttonWithText(view, "新建方案")?.click();
    });
    expect(view.textContent).toContain("比赛信息");
    const submitButton = buttonWithText(view, "创建方案");
    expect(submitButton?.disabled).toBe(true);

    const inputs = view.querySelectorAll<HTMLInputElement>("input");
    const titleInput = [...inputs].find((candidate) => candidate.closest("label")?.textContent?.includes("方案名称"));
    const problemIdInput = [...inputs].find((candidate) => candidate.closest('td[data-label="题目编号"]') !== null);
    expect(titleInput).toBeTruthy();
    expect(problemIdInput).toBeTruthy();

    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set;
      setter!.call(titleInput, "新方案");
      titleInput!.dispatchEvent(new Event("input", { bubbles: true }));
      setter!.call(problemIdInput, "9001");
      problemIdInput!.dispatchEvent(new Event("input", { bubbles: true }));
    });

    expect(buttonWithText(view, "创建方案")?.disabled).toBe(false);
    await act(async () => {
      buttonWithText(view, "创建方案")?.click();
    });

    await waitFor(() => expect(api.createContest).toHaveBeenCalledTimes(1));
    const payload = api.createContest.mock.calls[0]?.[0];
    expect(payload).toMatchObject({
      title: "新方案",
      description: "",
      startsAt: null,
      endsAt: null,
      members: []
    });
    expect(payload?.problems[0]).toMatchObject({ problemId: "9001", score: 100, estimatedDifficulty: null });

    await waitFor(() => expect(view.textContent).toContain("示例组题方案"));
    expect(view.textContent).not.toContain("比赛信息");
  });

  it("创建失败时显示表单错误并保留输入", async () => {
    api.listContests.mockResolvedValue(listResponse([]));
    api.createContest.mockRejectedValue(new ApiError("不应泄露的方案创建拒绝", 403));

    const view = mount(sessionWithPermissions(["contest.create"]));
    await waitFor(() => expect(view.textContent).toContain("当前没有可查看的组题方案"));

    await act(async () => {
      buttonWithText(view, "新建方案")?.click();
    });
    const inputs = view.querySelectorAll<HTMLInputElement>("input");
    const titleInput = [...inputs].find((candidate) => candidate.closest("label")?.textContent?.includes("方案名称"));
    const problemIdInput = [...inputs].find((candidate) => candidate.closest('td[data-label="题目编号"]') !== null);
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set;
      setter!.call(titleInput, "重试方案");
      titleInput!.dispatchEvent(new Event("input", { bubbles: true }));
      setter!.call(problemIdInput, "9001");
      problemIdInput!.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(buttonWithText(view, "创建方案")?.disabled).toBe(false);
    await act(async () => {
      buttonWithText(view, "创建方案")?.click();
    });

    await waitFor(() => expect(view.textContent).toContain("不应泄露的方案创建拒绝"));
    expect(buttonWithText(view, "创建方案")?.disabled).toBe(false);
    const titleValue = [...view.querySelectorAll<HTMLInputElement>("input")]
      .find((candidate) => candidate.closest("label")?.textContent?.includes("方案名称"))?.value;
    expect(titleValue).toBe("重试方案");
  });
});

describe("组题页草稿细节", () => {
  it("草稿方案的锁定入口在可编辑时可用并触发状态更新", async () => {
    const locked = { ...contest(), state: "locked" as const };
    api.listContests.mockResolvedValue(listResponse([contest()]));
    api.getContest.mockResolvedValue(contest());
    api.updateContest.mockResolvedValue(locked);

    const view = mount(sessionWithPermissions(["contest.create", "contest.edit.own"]));
    await waitFor(() => expect(buttonWithExactText(view, "锁定")).toBeTruthy());

    const lockButton = buttonWithExactText(view, "锁定");
    expect(lockButton).toBeTruthy();
    await act(async () => {
      lockButton?.click();
    });

    await waitFor(() => expect(api.updateContest).toHaveBeenCalledTimes(1));
    expect(api.updateContest).toHaveBeenCalledWith("c-1", {
      state: "locked",
      expectedUpdatedAt: "2026-01-02T00:00:00.000Z"
    });
    await waitFor(() => expect(view.textContent).toContain("已锁定"));
    expect(buttonWithExactText(view, "归档")).toBeTruthy();
  });

  it("无法读取风险时显示不可查看，不渲染访问记录", async () => {
    const noRisk = contest({ capabilities: { canEdit: false, canDelete: false, canExport: false, canReadRisk: false } });
    api.listContests.mockResolvedValue(listResponse([noRisk]));
    api.getContest.mockResolvedValue(noRisk);

    const view = mount(sessionWithPermissions(["contest.export"]));
    await waitFor(() => expect(view.textContent).toContain("示例题"));
    expect(view.textContent).toContain("不可查看");
    expect(view.textContent).toContain("当前账号不能查看访问记录。");
    expect(view.textContent).not.toContain("未发现参与者访问过这些题目");
    expect(buttonWithText(view, "锁定")).toBeUndefined();
  });

  it("风险记录与零风险语义分别按权限呈现", async () => {
    const risky = contest({
      problems: [
        {
          position: 0,
          problemId: "9001",
          revisionId: "11111111-1111-4111-8111-111111111111",
          revision: 3,
          title: "示例题",
          score: 100,
          estimatedDifficulty: null,
          leakRiskCount: 2,
          leakRiskEntries: [
            { user: { id: "u-9", nickname: "参赛者", accountType: "human" }, firstAccessedAt: "2026-01-03T00:00:00.000Z", lastAccessedAt: "2026-01-03T01:00:00.000Z", totalActiveSeconds: 300 },
            { user: { id: "u-10", nickname: "另参赛者", accountType: "human" }, firstAccessedAt: "2026-01-03T00:10:00.000Z", lastAccessedAt: "2026-01-03T00:20:00.000Z", totalActiveSeconds: 120 }
          ]
        }
      ]
    });
    api.listContests.mockResolvedValue(listResponse([risky]));
    api.getContest.mockResolvedValue(risky);

    const view = mount(sessionWithPermissions(["contest.risk.read"]));
    await waitFor(() => expect(view.textContent).toContain("2 人"));
    expect(view.textContent).toContain("参赛者");
    expect(view.textContent).toContain("另参赛者");
    expect(view.textContent).toContain("5 分钟");
    expect(view.textContent).not.toContain("未发现参与者访问过这些题目");
  });

  it("方案详情为空题时显示空位提示", async () => {
    const empty = contest({ problems: [], members: [] });
    api.listContests.mockResolvedValue(listResponse([empty]));
    api.getContest.mockResolvedValue(empty);

    const view = mount(sessionWithPermissions(["contest.create"]));
    await waitFor(() => expect(view.textContent).toContain("方案里还没有题目。"));
    expect(view.textContent).toContain("没有参与者。");
  });
});
