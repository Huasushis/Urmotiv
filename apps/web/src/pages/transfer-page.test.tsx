import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { SessionResponse } from "@urmotiv/contracts";
import type * as ApiModule from "../lib/api";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  getSession: vi.fn(),
  previewExport: vi.fn()
}));

vi.mock("../lib/api", async (importOriginal) => {
  const original = await importOriginal<typeof ApiModule>();
  return { ...original, ...api };
});

import { ApiError } from "../lib/api";
import { TransferPage } from "./transfer-page";

const fullSession: SessionResponse = {
  user: {
    id: "leader",
    nickname: "组长",
    accountType: "human",
    permissions: ["problem.import", "problem.export.all"],
    roles: ["组长"],
    isRoot: false,
    canManageReviewPolicy: false,
    canManagePlugins: false,
    canManageTags: false
  },
  auth: {
    emailEnabled: false,
    emailRegistrationEnabled: false,
    casEnabled: false,
    demoEnabled: true
  }
};

let root: Root | undefined;
let container: HTMLDivElement | undefined;
let queryClient: QueryClient | undefined;

function mount(session: SessionResponse): HTMLDivElement {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } }
  });
  queryClient = client;
  client.setQueryData(["session"], session);
  api.getSession.mockResolvedValue(session);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  act(() => {
    root?.render(
      <QueryClientProvider client={client}>
        <MemoryRouter>
          <TransferPage />
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
      await act(async () => {
        await new Promise<void>((resolve) => {
          setTimeout(resolve, 5);
        });
      });
    }
  }
  throw latestError;
}

function buttonWithText(view: HTMLElement, text: string): HTMLButtonElement {
  const button = [...view.querySelectorAll<HTMLButtonElement>("button")]
    .find((candidate) => candidate.textContent?.includes(text));
  if (button === undefined) {
    throw new Error(`找不到按钮：${text}`);
  }
  return button;
}

afterEach(() => {
  if (root !== undefined) {
    act(() => root?.unmount());
  }
  queryClient?.clear();
  container?.remove();
  root = undefined;
  container = undefined;
  queryClient = undefined;
  vi.clearAllMocks();
});

describe("导入导出客户端权限边界", () => {
  it("会话撤权后卸载导入导出界面并清除两类任务缓存", async () => {
    const view = mount(fullSession);
    queryClient!.setQueryData(
      ["transfer-import-job", "leader", "11111111-1111-4111-8111-111111111111"],
      { privateResult: "不应保留的导入结果" }
    );
    queryClient!.setQueryData(
      ["transfer-export-job", "leader", "22222222-2222-4222-8222-222222222222"],
      { privateResult: "不应保留的导出结果" }
    );

    await waitFor(() => expect(view.textContent).toContain("选择题目包"));
    await act(async () => {
      queryClient!.setQueryData(["session"], {
        ...fullSession,
        user: { ...fullSession.user!, permissions: [] }
      });
    });

    await waitFor(() => expect(view.textContent).toContain("当前账号不能导入或导出"));
    expect(view.textContent).not.toContain("选择题目包");
    expect(view.textContent).not.toContain("选择导出内容");
    expect(queryClient!.getQueryData([
      "transfer-import-job",
      "leader",
      "11111111-1111-4111-8111-111111111111"
    ])).toBeUndefined();
    expect(queryClient!.getQueryData([
      "transfer-export-job",
      "leader",
      "22222222-2222-4222-8222-222222222222"
    ])).toBeUndefined();
  });

  it("导出预检返回不存在时清除输入与旧任务且不回显后端详情", async () => {
    const exportSession: SessionResponse = {
      ...fullSession,
      user: { ...fullSession.user!, permissions: ["problem.export.all"] }
    };
    api.previewExport.mockRejectedValue(new ApiError("不应回显的导出拒绝详情", 404));
    const view = mount(exportSession);
    const oldJobKey = [
      "transfer-export-job",
      "leader",
      "33333333-3333-4333-8333-333333333333"
    ] as const;
    queryClient!.setQueryData(oldJobKey, { privateResult: "不应保留的旧任务" });

    await waitFor(() => expect(view.textContent).toContain("选择导出内容"));
    const input = view.querySelector<HTMLTextAreaElement>("textarea");
    expect(input).not.toBeNull();
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(
        window.HTMLTextAreaElement.prototype,
        "value"
      )!.set;
      setter!.call(input, "12345");
      input!.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => {
      buttonWithText(view, "检查格式差异").click();
    });

    await waitFor(() => expect(view.textContent).toContain("导出任务不存在"));
    expect(view.textContent).not.toContain("12345");
    expect(view.textContent).not.toContain("不应回显的导出拒绝详情");
    expect(queryClient!.getQueryData(oldJobKey)).toBeUndefined();
  });
});
