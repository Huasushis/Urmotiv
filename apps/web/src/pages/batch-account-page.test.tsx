import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { SessionResponse } from "@urmotiv/contracts";
import type * as ApiModule from "../lib/api";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  getSession: vi.fn(),
  createBatchAccounts: vi.fn()
}));

vi.mock("../lib/api", async (importOriginal) => {
  const original = await importOriginal<typeof ApiModule>();
  return { ...original, ...api };
});

import { ApiError } from "../lib/api";
import { BatchAccountPage } from "./batch-account-page";

const leaderSession: SessionResponse = {
  user: {
    id: "leader",
    nickname: "组长",
    accountType: "human",
    permissions: ["user.create"],
    roles: ["管理员"],
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

const authorSession: SessionResponse = {
  ...leaderSession,
  user: {
    ...leaderSession.user!,
    id: "author",
    nickname: "作者",
    permissions: []
  }
};

let root: Root | undefined;
let container: HTMLDivElement | undefined;

function mount(session: SessionResponse = leaderSession): HTMLDivElement {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } }
  });
  client.setQueryData(["session"], session);
  api.getSession.mockResolvedValue(session);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  act(() => {
    root?.render(
      <QueryClientProvider client={client}>
        <MemoryRouter>
          <BatchAccountPage />
        </MemoryRouter>
      </QueryClientProvider>
    );
  });
  return container;
}

function setText(value: string): void {
  const textarea = container!.querySelector<HTMLTextAreaElement>("textarea")!;
  act(() => {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value")!.set!;
    setter.call(textarea, value);
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function waitFor(assertion: () => void): Promise<void> {
  let latestError: unknown;
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      assertion();
      return;
    } catch (error) {
      latestError = error;
      await new Promise<void>((resolve) => setTimeout(resolve, 25));
    }
  }
  throw latestError;
}

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = undefined;
  container = undefined;
  vi.clearAllMocks();
});

describe("批量创建账号页", () => {
  it("无 user.create 权限时不显示创建表单", async () => {
    mount(authorSession);

    await waitFor(() => expect(container!.textContent).toContain("没有访问权限"));
    expect(container!.querySelector("textarea")).toBeNull();
    expect(api.createBatchAccounts).not.toHaveBeenCalled();
  });

  it("成功提交多行内容后只显示创建数量并清空密码输入", async () => {
    const input = "PB-SYNTH-UI-1\t界面甲\tui-a@example.test\tSyntheticUiPass-A-123\nPB-SYNTH-UI-2\t界面乙\tui-b@example.test\tSyntheticUiPass-B-456";
    api.createBatchAccounts.mockResolvedValue({ ok: true, createdCount: 2, totalCount: 2 });
    mount();
    await waitFor(() => expect(container!.querySelector("textarea")).not.toBeNull());

    setText(input);
    await act(async () => {
      container!.querySelector<HTMLButtonElement>("button[type=submit]")!.click();
    });
    await waitFor(() => expect(container!.textContent).toContain("已创建 2 个账号"));

    expect(api.createBatchAccounts).toHaveBeenCalledWith(input);
    expect(container!.querySelector<HTMLTextAreaElement>("textarea")!.value).toBe("");
    expect(container!.textContent).not.toContain("SyntheticUiPass");
  });

  it("失败时保留原始多行输入，只显示固定错误和行号", async () => {
    const input = "PB-SYNTH-UI-3\t界面丙\tui-c@example.test\tSyntheticUiPass-C-789\nPB-SYNTH-UI-4\t界面丁\tbad-email\tshort";
    api.createBatchAccounts.mockRejectedValue(
      new ApiError("批量账号内容不符合要求。", 422, {
        fieldErrors: { "lines.2": ["邮箱格式不正确。"] }
      })
    );
    mount();
    await waitFor(() => expect(container!.querySelector("textarea")).not.toBeNull());

    setText(input);
    await act(async () => {
      container!.querySelector<HTMLButtonElement>("button[type=submit]")!.click();
    });
    await waitFor(() => expect(container!.textContent).toContain("第 2 行"));

    expect(container!.querySelector<HTMLTextAreaElement>("textarea")!.value).toBe(input);
    const alertText = container!.querySelector<HTMLElement>("[role=alert]")!.textContent;
    expect(alertText).not.toContain("ui-c@example.test");
    expect(alertText).not.toContain("SyntheticUiPass");
  });
});
