import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { SessionResponse } from "@urmotiv/contracts";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  demoLogin: vi.fn()
}));

vi.mock("../lib/api", async (importOriginal) => {
  const original = await importOriginal<typeof import("../lib/api")>();
  return { ...original, demoLogin: api.demoLogin };
});

import { DemoLoginPage } from "./demo-login-page";

const previousSession: SessionResponse = {
  user: {
    id: "reviewer",
    nickname: "旧审题账号",
    accountType: "human",
    permissions: ["problem.review"],
    roles: ["审题人"],
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

const nextSession: SessionResponse = {
  ...previousSession,
  user: {
    ...previousSession.user!,
    id: "author",
    nickname: "新投稿账号",
    permissions: ["problem.view.own"],
    roles: ["投稿人"]
  }
};

let root: Root | undefined;
let container: HTMLDivElement | undefined;

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

afterEach(() => {
  if (root !== undefined) {
    act(() => root?.unmount());
  }
  container?.remove();
  root = undefined;
  container = undefined;
  sessionStorage.clear();
  vi.clearAllMocks();
});

describe("切换登录账号", () => {
  it("清除上一账号的题目与私密审核缓存后再保存新会话", async () => {
    api.demoLogin.mockResolvedValue(nextSession);
    const client = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
        mutations: { retry: false }
      }
    });
    client.setQueryData(["session"], previousSession);
    client.setQueryData(["problem", "private-problem", "reviewer"], {
      title: "不应保留的旧题目"
    });
    client.setQueryData(["reviews", "private-problem", 1, "reviewer"], {
      privateNote: "不应保留的私密备注"
    });
    sessionStorage.setItem(
      "urmotiv.web.unsaved.reviewer.private-problem",
      "不应跨账号保留的本地草稿"
    );

    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    act(() => {
      root?.render(
        <QueryClientProvider client={client}>
          <MemoryRouter>
            <DemoLoginPage existingSession={previousSession} />
          </MemoryRouter>
        </QueryClientProvider>
      );
    });

    const authorButton = [...container.querySelectorAll<HTMLButtonElement>(".demo-account")]
      .find((button) => button.textContent?.includes("投稿人"));
    expect(authorButton).not.toBeUndefined();
    await act(async () => {
      authorButton?.click();
    });

    await waitFor(() => {
      expect(client.getQueryData(["session"])).toEqual(nextSession);
    });
    expect(client.getQueryData(["problem", "private-problem", "reviewer"])).toBeUndefined();
    expect(client.getQueryData(["reviews", "private-problem", 1, "reviewer"])).toBeUndefined();
    expect(
      sessionStorage.getItem("urmotiv.web.unsaved.reviewer.private-problem")
    ).toBeNull();
  });
  it("OAuth2 开启时显示独立入口，经典 CAS 入口不会冒充 OAuth2", () => {
    const client = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
        mutations: { retry: false }
      }
    });
    const oauthSession: SessionResponse = {
      ...previousSession,
      auth: {
        ...previousSession.auth,
        ustcOAuthEnabled: true,
        casEnabled: false
      }
    };
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    act(() => {
      root?.render(
        <QueryClientProvider client={client}>
          <MemoryRouter>
            <DemoLoginPage existingSession={oauthSession} />
          </MemoryRouter>
        </QueryClientProvider>
      );
    });
    expect(container.textContent).toContain("使用 USTC OAuth2 统一身份认证登录");
    expect(container.textContent).not.toContain("使用经典 CAS 统一身份认证登录");
  });
});
