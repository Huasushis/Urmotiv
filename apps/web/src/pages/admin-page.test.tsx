import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { AdminPlugin, ReviewPolicyView, SessionUser } from "@urmotiv/contracts";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  getReviewPolicy: vi.fn(),
  listAdminPlugins: vi.fn(),
  listManagedTagCatalog: vi.fn(),
  updateAdminPlugin: vi.fn(),
  updateReviewPolicy: vi.fn()
}));

vi.mock("../lib/api", async (importOriginal) => {
  const original = await importOriginal<typeof import("../lib/api")>();
  return { ...original, ...api };
});

import { AdminPage } from "./admin-page";
import { ApiError } from "../lib/api";

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
const reviewPolicyWithMobileControls: ReviewPolicyView = {
  ...reviewPolicy,
  settings: { minimumReviewers: 2, countRobotReviews: false },
  availableRules: [{
    id: reviewPolicy.selectedRuleId,
    displayName: "默认审核人数规则",
    pluginVersion: reviewPolicy.selectedPluginVersion,
    settingsSchema: {
      type: "object",
      properties: {
        minimumReviewers: {
          type: "integer",
          title: "至少需要的审核人数",
          minimum: 1,
          maximum: 20,
          default: 2
        },
        countRobotReviews: {
          type: "boolean",
          title: "计算机器人意见",
          default: false
        }
      }
    }
  }]
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
      configured: true
    }
  ],
  requiresRestart: false
};

let root: Root | undefined;
let queryClient: QueryClient | undefined;
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
    canManageTags: false,
    ...overrides
  };
}

function mount(element: ReactNode, initialEntries = ["/admin"]): HTMLDivElement {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } }
  });
  queryClient = client;
  act(() => {
    root?.render(<QueryClientProvider client={client}><MemoryRouter initialEntries={initialEntries}>{element}</MemoryRouter></QueryClientProvider>);
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

function buttonWithText(view: HTMLElement, text: string): HTMLButtonElement {
  const button = [...view.querySelectorAll<HTMLButtonElement>("button")]
    .find((candidate) => candidate.textContent?.includes(text));
  if (button === undefined) {
    throw new Error(`找不到按钮：${text}`);
  }
  return button;
}

async function changeValue(
  element: HTMLInputElement | HTMLSelectElement,
  value: string
): Promise<void> {
  await act(async () => {
    const prototype = element instanceof HTMLSelectElement
      ? HTMLSelectElement.prototype
      : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(prototype, "value")?.set;
    if (setter === undefined) {
      throw new Error("测试环境无法修改输入值");
    }
    setter.call(element, value);
    element.dispatchEvent(new Event(
      element instanceof HTMLSelectElement ? "change" : "input",
      { bubbles: true }
    ));
  });
}

async function click(button: HTMLButtonElement): Promise<void> {
  await act(async () => {
    button.click();
  });
}

afterEach(() => {
  if (root !== undefined) {
    act(() => root?.unmount());
  }
  container?.remove();
  root = undefined;
  queryClient?.clear();
  queryClient = undefined;
  container = undefined;
  vi.clearAllMocks();
});

describe("管理页面", () => {
  it("无管理权限时不读取任何管理设置", () => {
    const view = mount(<AdminPage session={session()} />);

    expect(view.textContent).toContain("当前账号没有可用的管理设置");
    expect(api.getReviewPolicy).not.toHaveBeenCalled();
    expect(api.listAdminPlugins).not.toHaveBeenCalled();
    expect(api.listManagedTagCatalog).not.toHaveBeenCalled();
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
  it("审核规则控件保留移动端精确语义钩子", async () => {
    api.getReviewPolicy.mockResolvedValue(reviewPolicyWithMobileControls);
    const view = mount(
      <AdminPage session={session({ canManageReviewPolicy: true })} />
    );

    await waitFor(() => {
      expect(view.querySelector(".admin-rule-select > select")).not.toBeNull();
      expect(view.querySelector('label.settings-form-toggle[for="review-rule-countRobotReviews"]')).not.toBeNull();
    });
    const ruleSelect = view.querySelector<HTMLSelectElement>(".admin-rule-select > select");
    expect(ruleSelect?.textContent).toContain("默认审核人数规则");
    const robotOpinionToggle = view.querySelector<HTMLLabelElement>(
      'label.settings-form-toggle[for="review-rule-countRobotReviews"]'
    );
    expect(robotOpinionToggle?.textContent).toContain("计算机器人意见");
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
    expect(view.textContent).toContain("已配置");
    expect(view.textContent).not.toContain("完整密钥内容");
    expect(view.textContent).not.toContain("末尾四个字符");
    expect(view.textContent).not.toContain(plugin.apiVersion);
    expect(view.textContent).not.toContain(plugin.source);
  });

  it("只有知识点管理权限时直接打开目录且不读取其他管理设置", async () => {
    api.listManagedTagCatalog.mockResolvedValue({ version: 1, items: [], aliases: [] });
    const view = mount(<AdminPage session={session({ canManageTags: true })} />);

    await waitFor(() => expect(view.textContent).toContain("还没有目录项"));
    expect(api.listManagedTagCatalog).toHaveBeenCalledTimes(1);
    expect(api.getReviewPolicy).not.toHaveBeenCalled();
    expect(api.listAdminPlugins).not.toHaveBeenCalled();
    expect(view.textContent).toContain("新增分类");
  });

  it("同一审核规则升级后允许管理员重新确认当前版本", async () => {
    const upgradedPolicy: ReviewPolicyView = {
      ...reviewPolicy,
      selectedPluginVersion: "1.0.0",
      settings: {},
      selectedRuleAvailable: false,
      availableRules: [{
        ...reviewPolicy.availableRules[0]!,
        pluginVersion: "1.1.0",
        settingsSchema: null
      }]
    };
    api.getReviewPolicy.mockResolvedValue(upgradedPolicy);
    api.updateReviewPolicy.mockResolvedValue({
      ...upgradedPolicy,
      selectedPluginVersion: "1.1.0",
      selectedRuleAvailable: true
    });
    const view = mount(
      <AdminPage session={session({ canManageReviewPolicy: true })} />
    );

    await waitFor(() => expect(view.textContent).toContain("当前保存的规则已经不可用"));
    const select = view.querySelector<HTMLSelectElement>("select");
    expect(select).not.toBeNull();
    expect(select?.value).toBe("");

    await changeValue(select!, reviewPolicy.selectedRuleId);
    const save = buttonWithText(view, "保存审核规则");
    await waitFor(() => expect(save.disabled).toBe(false));
    await click(save);

    await waitFor(() => expect(api.updateReviewPolicy).toHaveBeenCalledWith({
      ruleId: reviewPolicy.selectedRuleId,
      settings: {},
      expectedRevision: reviewPolicy.revision
    }));
  });

  it("审核规则冲突后重新读取失败时保留尚未保存的输入", async () => {
    api.getReviewPolicy
      .mockResolvedValueOnce(reviewPolicy)
      .mockRejectedValueOnce(new Error("重新读取失败"));
    api.updateReviewPolicy.mockRejectedValue(new ApiError("版本冲突", 409));
    const view = mount(
      <AdminPage session={session({ canManageReviewPolicy: true })} />
    );

    await waitFor(() => expect(view.textContent).toContain("多数意见"));
    const input = view.querySelector<HTMLInputElement>('input[type="number"]');
    expect(input).not.toBeNull();
    await changeValue(input!, "3");
    await click(buttonWithText(view, "保存审核规则"));
    await waitFor(() => expect(view.textContent).toContain("其他人已经修改了审核规则"));

    await click(buttonWithText(view, "放弃本页输入并重新读取"));
    await waitFor(() => expect(api.getReviewPolicy).toHaveBeenCalledTimes(2));
    expect(input?.value).toBe("3");
    expect(view.textContent).toContain("其他人已经修改了审核规则");
    expect(view.textContent).not.toContain("审核规则暂时无法读取");
  });

  it("插件冲突后重新读取失败时保留密钥输入和编辑器", async () => {
    api.listAdminPlugins
      .mockResolvedValueOnce({ items: [plugin] })
      .mockRejectedValueOnce(new Error("重新读取失败"));
    api.updateAdminPlugin.mockRejectedValue(new ApiError("版本冲突", 409));
    const view = mount(<AdminPage session={session({ canManagePlugins: true })} />);

    await waitFor(() => expect(view.textContent).toContain("AI 审题服务"));
    const secret = view.querySelector<HTMLInputElement>('input[type="password"]');
    expect(secret).not.toBeNull();
    await changeValue(secret!, "temporary-secret");
    await click(buttonWithText(view, "保存插件设置"));
    await waitFor(() => expect(view.textContent).toContain("其他人已经修改了这个插件"));

    await click(buttonWithText(view, "放弃本页输入并重新读取"));
    await waitFor(() => expect(api.listAdminPlugins).toHaveBeenCalledTimes(2));
    expect(secret?.value).toBe("temporary-secret");
    expect(view.textContent).toContain("AI 审题服务");
    expect(view.textContent).toContain("其他人已经修改了这个插件");
    expect(view.textContent).not.toContain("插件设置暂时无法读取");
  });

  it("插件保存被服务端拒绝时清除插件缓存和未保存密钥", async () => {
    api.listAdminPlugins.mockResolvedValue({ items: [plugin] });
    api.updateAdminPlugin.mockRejectedValue(
      new ApiError("不应回显的插件拒绝详情", 403)
    );
    const view = mount(<AdminPage session={session({ canManagePlugins: true })} />);

    await waitFor(() => expect(view.textContent).toContain("AI 审题服务"));
    const secret = view.querySelector<HTMLInputElement>('input[type="password"]');
    expect(secret).not.toBeNull();
    await changeValue(secret!, "temporary-secret");
    await click(buttonWithText(view, "保存插件设置"));

    await waitFor(() => expect(view.textContent).toContain("插件设置不存在"));
    expect(view.textContent).not.toContain("AI 审题服务");
    expect(view.textContent).not.toContain("temporary-secret");
    expect(view.textContent).not.toContain("不应回显的插件拒绝详情");
    expect(queryClient!.getQueryData(["admin-plugins", "user-1"])).toBeUndefined();
  });

  it("机器人即使带有宽泛权限字符串也不能读取管理设置", () => {
    const view = mount(
      <AdminPage
        session={session({
          accountType: "robot",
          roles: ["审核机器人", "管理员"],
          permissions: ["plugin.manage", "system.manage"],
          canManageReviewPolicy: false,
          canManagePlugins: false,
          canManageTags: false
        })}
      />
    );

    expect(view.textContent).toContain("当前账号没有可用的管理设置");
    expect(api.getReviewPolicy).not.toHaveBeenCalled();
    expect(api.listAdminPlugins).not.toHaveBeenCalled();
    expect(api.listManagedTagCatalog).not.toHaveBeenCalled();
  });

  it("明确拒绝账号不因角色名称获得管理读取", () => {
    const view = mount(
      <AdminPage
        session={session({
          roles: ["系统管理员"],
          permissions: ["plugin.manage", "system.manage"],
          canManageReviewPolicy: false,
          canManagePlugins: false,
          canManageTags: false
        })}
      />
    );

    expect(view.textContent).toContain("当前账号没有可用的管理设置");
    expect(api.getReviewPolicy).not.toHaveBeenCalled();
    expect(api.listAdminPlugins).not.toHaveBeenCalled();
    expect(api.listManagedTagCatalog).not.toHaveBeenCalled();
  });
  it("系统管理员能从管理首页看到所有真实设置入口", () => {
    const view = mount(
      <AdminPage
        session={session({
          permissions: [
            "system.manage",
            "user.permission.manage",
            "service_account.manage",
            "audit.read",
            "plugin.manage",
            "tag.manage",
            "problem.view.all",
            "problem.import",
            "review.policy.manage"
          ],
          canManageReviewPolicy: true,
          canManagePlugins: true,
          canManageTags: true,
          canManageSystem: true,
          canManagePermissions: true,
          canManageServiceAccounts: true,
          canReadAudit: true,
          canManageProblemCatalog: true,
          canManageOAuth: true
        })}
      />
    );

    const links = [...view.querySelectorAll<HTMLAnchorElement>("a")].map((link) => ({
      href: link.getAttribute("href"),
      text: link.textContent
    }));
    expect(links).toEqual(expect.arrayContaining([
      expect.objectContaining({ href: "/admin/settings", text: expect.stringContaining("常规设置") }),
      expect.objectContaining({ href: "/admin/users", text: expect.stringContaining("用户管理") }),
      expect.objectContaining({ href: "/admin/roles", text: expect.stringContaining("角色与权限") }),
      expect.objectContaining({ href: "/admin/roles/defaults", text: expect.stringContaining("默认角色") }),
      expect.objectContaining({ href: "/admin/audit", text: expect.stringContaining("审计") }),
      expect.objectContaining({ href: "/admin/oauth", text: expect.stringContaining("统一身份认证") }),
      expect.objectContaining({ href: "/admin/plugins", text: expect.stringContaining("插件") }),
      expect.objectContaining({ href: "/admin/knowledge", text: expect.stringContaining("知识点") }),
      expect.objectContaining({ href: "/problems", text: expect.stringContaining("题库") })
    ]));
    expect(links.some((link) => link.href === "/admin/fermata")).toBe(false);
    const sectionLinks = [...view.querySelectorAll<HTMLAnchorElement>(".admin-section-nav a")];
    expect(new Set(sectionLinks.map((link) => link.getAttribute("href"))).size).toBe(sectionLinks.length);
  });

  it("管理页导航按当前路由标记 active 状态", () => {
    const view = mount(
      <AdminPage session={session({
        permissions: ["user.permission.manage"],
        canManagePermissions: true
      })} />,
      ["/admin/roles"]
    );
    const roleLink = view.querySelector<HTMLAnchorElement>('.admin-section-nav a[href="/admin/roles"]');
    const usersLink = view.querySelector<HTMLAnchorElement>('.admin-section-nav a[href="/admin/users"]');
    expect(roleLink?.classList.contains("active")).toBe(true);
    expect(roleLink?.getAttribute("aria-current")).toBe("page");
    expect(usersLink?.classList.contains("active")).toBe(false);
  });
});
