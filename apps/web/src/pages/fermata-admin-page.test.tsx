import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { SessionUser } from "@urmotiv/contracts";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  getFermataHealth: vi.fn(),
  getFermataSettings: vi.fn(),
  updateFermataSettings: vi.fn(),
  wakeFermata: vi.fn()
}));

vi.mock("../lib/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/api")>()),
  ...api
}));

import { FermataAdminPage } from "./fermata-admin-page";

const manager: SessionUser = {
  id: "fermata-manager",
  nickname: "Fermata 管理员",
  accountType: "human",
  roles: ["系统管理员"],
  isRoot: false,
  permissions: ["plugin.manage", "system.manage"],
  canManageReviewPolicy: false,
  canManagePlugins: true,
  canManageTags: false,
  canManageSystem: true
};

let root: Root | undefined;
let container: HTMLDivElement | undefined;

async function waitFor(assertion: () => void): Promise<void> {
  let last: unknown;
  for (let attempt = 0; attempt < 30; attempt += 1) {
    try {
      assertion();
      return;
    } catch (error) {
      last = error;
      await act(async () => Promise.resolve());
    }
  }
  throw last;
}

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = undefined;
  container = undefined;
  vi.clearAllMocks();
});

describe("Fermata 管理页面", () => {
  it("展示可编辑的模型连接与三类凭据的用途，密钥输入保持为空", async () => {
    api.getFermataHealth.mockResolvedValue({
      health: {
        status: "ok",
        service: "fermata",
        apiVersion: "1",
        workerRunning: true,
        activeTasks: 2,
        checkedAt: "2026-08-30T00:00:00.000Z"
      }
    });
    api.getFermataSettings.mockResolvedValue({
      settings: {
        enabled: true,
        pollingIntervalSeconds: 15,
        maximumConcurrentTasks: 16,
        modelProfileName: "review-balanced",
        experimentVersion: "review-flow-v1",
        model: { baseUrl: "https://models.example.test/v1", model: "deepseek-v4-flash", temperature: 0.2, thinking: true },
        urmotivBaseUrl: "https://urmotiv.example.test"
      },
      revision: 4,
      secretsConfigured: true
    });
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    act(() => {
      root?.render(
        <QueryClientProvider client={client}>
          <MemoryRouter initialEntries={["/admin/fermata"]}>
            <FermataAdminPage session={manager} />
          </MemoryRouter>
        </QueryClientProvider>
      );
    });

    await waitFor(() => {
      expect(container?.textContent).toContain("deepseek-v4-flash");
    });
    expect(container.textContent).toContain("自动审题已启动");
    expect(container.textContent).toContain("当前处理任务：2");
    expect(container.textContent).toContain("模型 API 密钥");
    expect(container.textContent).toContain("题库机器人令牌");
    expect(container.textContent).toContain("管理令牌用于连接 Fermata 管理端口");
    for (const input of container.querySelectorAll<HTMLInputElement>('input[type="password"]')) expect(input.value).toBe("");
    expect(container.querySelector('.admin-section-nav a[href="/admin/fermata"]')).toBeNull();
  });
});
