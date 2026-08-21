import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type * as ApiModule from "../lib/api";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  verifyEmail: vi.fn()
}));

vi.mock("../lib/api", async (importOriginal) => {
  const original = await importOriginal<typeof ApiModule>();
  return { ...original, ...api };
});

import { ApiError } from "../lib/api";
import { VerifyEmailPage } from "./verify-email-page";

let root: Root | undefined;
let container: HTMLDivElement | undefined;
let queryClient: QueryClient | undefined;

function mount(token: string | undefined): HTMLDivElement {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } }
  });
  queryClient = client;
  act(() => {
    root?.render(
      <QueryClientProvider client={client}>
        <MemoryRouter initialEntries={["/verify-email"]}>
          <Routes>
            <Route
              path="/verify-email"
              element={<VerifyEmailPage token={token} />}
            />
            <Route path="/login" element={<div>已回到登录页</div>} />
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
      const promise = new Promise<void>((resolve) => { setTimeout(resolve, 5); });
      await act(async () => {
        await promise;
      });
    }
  }
  throw latestError;
}

function confirmButton(view: HTMLElement): HTMLButtonElement | undefined {
  return view.querySelector<HTMLButtonElement>(".primary-button") ?? undefined;
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

describe("邮箱验证页", () => {
  it("有令牌时显示标题与可点击的确认按钮", () => {
    api.verifyEmail.mockResolvedValue({ ok: true });

    const view = mount("uve_sample_token_123");
    expect(view.textContent).toContain("确认邮箱后再登录");
    const button = confirmButton(view);
    expect(button?.disabled).toBe(false);
    expect(button?.textContent).toBe("确认邮箱");
  });

  it("点击后携带令牌调用接口并返回登录页", async () => {
    api.verifyEmail.mockResolvedValue({ ok: true });

    const view = mount("uve_sample_token_123");
    await act(async () => {
      confirmButton(view)?.click();
    });

    await waitFor(() => expect(api.verifyEmail).toHaveBeenCalledTimes(1));
    expect(api.verifyEmail).toHaveBeenCalledWith("uve_sample_token_123");
    await waitFor(() => expect(view.textContent).toContain("已回到登录页"));
  });

  it("接口失败时显示错误且不出现完成提示，按钮恢复可点", async () => {
    api.verifyEmail.mockRejectedValue(new ApiError("邮箱验证失败，请重新申请验证邮件。", 400));

    const view = mount("uve_sample_token_123");
    await act(async () => {
      confirmButton(view)?.click();
    });

    await waitFor(() => expect(view.textContent).toContain("邮箱验证失败，请重新申请验证邮件。"));
    expect(view.textContent).not.toContain("验证完成，正在回到登录页。");
    expect(confirmButton(view)?.disabled).toBe(false);
  });

  it("缺少令牌时按钮禁用且不会发起请求", () => {
    api.verifyEmail.mockResolvedValue({ ok: true });

    const view = mount(undefined);
    expect(confirmButton(view)?.disabled).toBe(true);
    expect(api.verifyEmail).not.toHaveBeenCalled();
  });

  it("请求进行中按钮进入正在验证状态并保持禁用", async () => {
    let finishVerification!: (result: { ok: true }) => void;
    const pending = new Promise<{ ok: true }>((resolve) => {
      finishVerification = resolve;
    });
    api.verifyEmail.mockReturnValue(pending);

    const view = mount("uve_sample_token_123");
    await act(async () => {
      confirmButton(view)?.click();
    });

    await waitFor(() => expect(confirmButton(view)?.textContent).toContain("正在验证…"));
    expect(confirmButton(view)?.disabled).toBe(true);
    expect(view.textContent).not.toContain("验证完成");

    finishVerification({ ok: true });
    await waitFor(() => expect(view.textContent).toContain("已回到登录页"));
  });
});
