import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { AdminPlugin, ReviewPolicyView, SessionUser } from "@urmotiv/contracts";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  getReviewPolicy: vi.fn(),
  listAdminPlugins: vi.fn(),
  updateAdminPlugin: vi.fn(),
  updateReviewPolicy: vi.fn()
}));

vi.mock("../lib/api", async (importOriginal) => {
  const original = await importOriginal<typeof import("../lib/api")>();
  return { ...original, ...api };
});

import { AdminPage } from "./admin-page";

const reviewPolicy: ReviewPolicyView = {
  selectedRuleId: "org.ustc.urmotiv.review-default.count",
  selectedPluginVersion: "1.0.0",
  settings: { minimumReviewers: 2 },
  revision: 3,
  selectedRuleAvailable: true,
  availableRules: [
    {
      id: "org.ustc.urmotiv.review-default.count",
      displayName: "多数意见",
      pluginVersion: "1.0.0",
      settingsSchema: {
        type: "object",
        properties: {
          minimumReviewers: {
            type: "integer",
            title: "至少需要的审核人数",
            minimum: 1,
            maximum: 20,
            default: 2
          }
        }
      }
    }
  ]
};

const plugin: AdminPlugin = {
  id: "org.ustc.urmotiv.fermata-control",
  name: "AI 审题服务",
  version: "1.0.0",
  apiVersion: "v1",
  source: "builtin",
  state: "enabled",
  failureCode: null,
  settings: { baseUrl: "https://review.example" },
  settingsManagedBy: "plugin",
  settingsSchema: {
    type: "object",
    properties: {
      baseUrl: {
        type: "string",
        format: "uri",
        title: "服务地址",
        default: "https://review.example"
      }
    }
  },
  reviewRuleIds: [],
  settingsRevision: 4,
  secrets: [
    {
      name: "managementToken",
      label: "管理令牌",
      description: "用于确认请求来自题库系统。",
      configured: true,
      maskedSuffix: "7xQp"
    }
  ],
  requiresRestart: false
};

let root: Root | undefined;
let container: HTMLDivElement | undefined;

function session(overrides: Partial<SessionUser> = {}): SessionUser {
  return {
    id: "user-1",
    nickname: "测试账号",
    accountType: "human",
    roles: ["测试角色"],
    isRoot: false,
    permissions: [],
    canManageReviewPolicy: false,
    canManagePlugins: false,
    ...overrides
  };
}

function mount(element: ReactNode): HTMLDivElement {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } }
  });
  act(() => {
    root?.render(<QueryClientProvider client={client}>{element}</QueryClientProvider>);
  });
  return container;
}

async function waitFor(assertion: () => void): Promise<void> {
  let latestError: unknown;
  for (let attempt = 0; attempt < 30; attempt += 1) {
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
  vi.clearAllMocks();
});

describe("管理页面", () => {
  it("无管理权限时不读取任何管理设置", () => {
    const view = mount(<AdminPage session={session()} />);

    expect(view.textContent).toContain("当前账号没有可用的管理设置");
    expect(api.getReviewPolicy).not.toHaveBeenCalled();
    expect(api.listAdminPlugins).not.toHaveBeenCalled();
  });

  it("只有审核规则权限时只读取审核规则", async () => {
    api.getReviewPolicy.mockResolvedValue(reviewPolicy);
    const view = mount(
      <AdminPage session={session({ canManageReviewPolicy: true })} />
    );

    await waitFor(() => expect(view.textContent).toContain("多数意见"));
    expect(api.getReviewPolicy).toHaveBeenCalledTimes(1);
    expect(api.listAdminPlugins).not.toHaveBeenCalled();
    expect(view.textContent).not.toContain("已安装插件");
  });

  it("审核规则读取失败时显示错误而不是停留在加载状态", async () => {
    api.getReviewPolicy.mockRejectedValue(new Error("暂时无法连接服务端"));
    const view = mount(
      <AdminPage session={session({ canManageReviewPolicy: true })} />
    );

    await waitFor(() => expect(view.textContent).toContain("审核规则暂时无法读取"));
    expect(view.textContent).toContain("暂时无法连接服务端");
    expect(view.textContent).not.toContain("正在读取审核规则");
  });

  it("只有插件权限时不读取审核规则且不回显完整密钥", async () => {
    api.listAdminPlugins.mockResolvedValue({ items: [plugin] });
    const view = mount(<AdminPage session={session({ canManagePlugins: true })} />);

    await waitFor(() => expect(view.textContent).toContain("AI 审题服务"));
    const secretInput = view.querySelector<HTMLInputElement>('input[type="password"]');

    expect(api.listAdminPlugins).toHaveBeenCalledTimes(1);
    expect(api.getReviewPolicy).not.toHaveBeenCalled();
    expect(secretInput?.value).toBe("");
    expect(view.textContent).toContain("末尾四个字符为 7xQp");
    expect(view.textContent).not.toContain("完整密钥内容");
    expect(view.textContent).not.toContain(plugin.apiVersion);
    expect(view.textContent).not.toContain(plugin.source);
  });
});
