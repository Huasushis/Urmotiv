import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { SessionResponse } from "@urmotiv/contracts";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  logout: vi.fn()
}));

vi.mock("../lib/api", async (importOriginal) => {
  const original = await importOriginal<typeof import("../lib/api")>();
  return { ...original, logout: api.logout };
});

import { AppShell } from "./app-shell";

const session: NonNullable<SessionResponse["user"]> = {
  id: "reviewer",
  nickname: "审题人",
  accountType: "human",
  permissions: ["problem.review"],
  roles: ["审题人"],
  isRoot: false,
  canManageReviewPolicy: false,
  canManagePlugins: false,
  canManageTags: false
};

let root: Root | undefined;
let container: HTMLDivElement | undefined;

function mount(client: QueryClient, children: ReactNode): HTMLDivElement {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  act(() => {
    root?.render(
      <QueryClientProvider client={client}>
        <MemoryRouter>{children}</MemoryRouter>
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

describe("退出登录", () => {
  it("清除当前账号的题目与私密审核缓存并重置会话", async () => {
    api.logout.mockResolvedValue({ ok: true });
    const client = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
        mutations: { retry: false }
      }
    });
    client.setQueryData(["session"], { user: session });
    client.setQueryData(["problem", "private-problem", session.id], {
      title: "不应保留的旧题目"
    });
    client.setQueryData(["reviews", "private-problem", 1, session.id], {
      privateNote: "不应保留的私密备注"
    });
    sessionStorage.setItem(
      "urmotiv.web.unsaved.reviewer.private-problem",
      "不应保留的本地草稿"
    );

    const view = mount(
      client,
      <AppShell session={session} demoEnabled={false}>
        <p>题目工作区</p>
      </AppShell>
    );
    const signOut = [...view.querySelectorAll<HTMLButtonElement>("button")].find(
      (button) => button.textContent === "退出"
    );
    expect(signOut).not.toBeUndefined();

    await act(async () => {
      signOut?.click();
    });

    await waitFor(() => expect(api.logout).toHaveBeenCalledTimes(1));
    await waitFor(() => {
      expect(client.getQueryData(["problem", "private-problem", session.id])).toBeUndefined();
      expect(
        client.getQueryData(["reviews", "private-problem", 1, session.id])
      ).toBeUndefined();
      expect(client.getQueryData(["session"])).toBeUndefined();
      expect(
        sessionStorage.getItem("urmotiv.web.unsaved.reviewer.private-problem")
      ).toBeNull();
    });
  });
});

describe("管理导航", () => {
  it("有知识点管理权限的真人可以从主导航进入管理页", () => {
    const client = new QueryClient();
    const view = mount(
      client,
      <AppShell session={{ ...session, canManageTags: true }} demoEnabled={false}>
        <p>题目工作区</p>
      </AppShell>
    );

    const management = [...view.querySelectorAll<HTMLAnchorElement>("nav a")]
      .find((link) => link.textContent === "管理");
    expect(management?.getAttribute("href")).toBe("/admin");
  });

  it("没有任何管理权限时不显示管理入口", () => {
    const client = new QueryClient();
    const view = mount(
      client,
      <AppShell session={session} demoEnabled={false}>
        <p>题目工作区</p>
      </AppShell>
    );

    expect([...view.querySelectorAll("nav a")].some((link) => link.textContent === "管理")).toBe(false);
  });
});

describe("导航权限", () => {
  it("有比赛或导入导出权限时才显示对应入口", () => {
    const client = new QueryClient();
    const view = mount(
      client,
      <AppShell
        session={{
          ...session,
          permissions: ["problem.review", "contest.create", "problem.import"]
        }}
        demoEnabled={false}
      >
        <p>题目工作区</p>
      </AppShell>
    );

    const labels = [...view.querySelectorAll("nav a")].map((link) => link.textContent);
    expect(labels).toEqual(expect.arrayContaining(["组题", "导入导出"]));
  });

  it("只有审核权限时不显示组题和导入导出入口", () => {
    const client = new QueryClient();
    const view = mount(
      client,
      <AppShell session={session} demoEnabled={false}>
        <p>题目工作区</p>
      </AppShell>
    );

    const labels = [...view.querySelectorAll("nav a")].map((link) => link.textContent);
    expect(labels).not.toContain("组题");
    expect(labels).not.toContain("导入导出");
  });
});

describe("跳过链接", () => {
  it("出现指向主内容区的跳过链接", () => {
    const client = new QueryClient();
    const view = mount(
      client,
      <AppShell session={session} demoEnabled={false}>
        <p>题目工作区</p>
      </AppShell>
    );

    const skip = view.querySelector<HTMLAnchorElement>("a.skip-link");
    expect(skip?.getAttribute("href")).toBe("#main-content");
    const main = view.querySelector<HTMLElement>("#main-content");
    expect(main?.tagName).toBe("MAIN");
  });
});
