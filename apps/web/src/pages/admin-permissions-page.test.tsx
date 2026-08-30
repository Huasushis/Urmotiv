import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type {
  AdminPermissionCatalogResponse,
  AdminRoleDefaultsResponse,
  AdminRoleManagementResponse,
  AdminUserPermissionDeltaResponse,
  AdminUsersResponse,
  SessionUser
} from "@urmotiv/contracts";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  listAdminPermissionCatalog: vi.fn(),
  listAdminRoles: vi.fn(),
  getAdminRoleDefaults: vi.fn(),
  listAdminUsers: vi.fn(),
  getAdminUserPermissions: vi.fn(),
  updateAdminUserPermissions: vi.fn(),
  updateAdminRole: vi.fn(),
  updateAdminRoleDefaults: vi.fn()
}));

vi.mock("../lib/api", async (importOriginal) => {
  const original = await importOriginal() as Record<string, unknown>;
  return { ...original, ...api };
});

import { AdminPermissionsPage } from "./admin-permissions-page";

const session: SessionUser = {
  id: "0",
  nickname: "root",
  accountType: "human",
  roles: ["root"],
  isRoot: true,
  permissions: [],
  canManageReviewPolicy: false,
  canManagePlugins: false,
  canManageTags: false
};

const catalog: AdminPermissionCatalogResponse = {
  groups: [{
    key: "content",
    displayName: "题目与附件",
    permissions: [
      { name: "problem.review", displayName: "审题", description: "查看审题入口" },
      { name: "problem.create", displayName: "创建题目", description: "创建题目" }
    ]
  }]
};

const roles: AdminRoleManagementResponse = {
  roles: [{
    id: "00000000-0000-4000-8000-000000000001",
    key: "root",
    displayName: "root",
    description: "bootstrap",
    isBuiltIn: true,
    revision: 1,
    permissions: [{ name: "problem.review", effect: "allow" }],
    members: [{ id: "0", nickname: "root", accountType: "human", enabled: true }]
  }, {
    id: "00000000-0000-4000-8000-000000000002",
    key: "contributor",
    displayName: "投稿人",
    description: "普通投稿",
    isBuiltIn: true,
    revision: 2,
    permissions: [{ name: "problem.create", effect: "allow" }],
    members: [{ id: "author", nickname: "投稿人", accountType: "human", enabled: true }]
  }],
  permissions: catalog.groups.flatMap((group) => group.permissions),
  users: [
    { id: "0", nickname: "root", accountType: "human", enabled: true },
    { id: "author", nickname: "投稿人", accountType: "human", enabled: true }
  ]
};

const defaults: AdminRoleDefaultsResponse = {
  defaults: { humanRoleKey: "contributor", robotRoleKey: "reviewer", revision: 1 }
};

const users: AdminUsersResponse = {
  items: [
    { id: "0", nickname: "root", accountType: "human", enabled: true, roles: ["root"] },
    { id: "author", nickname: "投稿人", accountType: "human", enabled: true, roles: ["投稿人"] }
  ],
  total: 2,
  page: 1,
  pageSize: 30
};

const permissionDelta: AdminUserPermissionDeltaResponse = {
  delta: {
    userId: "author",
    roles: ["contributor"],
    allows: ["problem.review"],
    denies: ["problem.create"],
    effective: ["problem.review"],
    revision: 3
  },
  effective: {
    permissions: ["problem.review"],
    entries: [
      { name: "problem.review", allowed: true, sources: ["role:contributor", "user:allow"] },
      { name: "problem.create", allowed: false, sources: ["role:contributor", "user:deny"] }
    ]
  }
};

let root: Root | undefined;
let container: HTMLDivElement | undefined;

function mount(element: ReactNode): HTMLDivElement {
  container = document.createElement("div");
  document.body.append(container);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  root = createRoot(container);
  act(() => { root?.render(<QueryClientProvider client={client}>{element}</QueryClientProvider>); });
  return container;
}

async function waitFor(assertion: () => void): Promise<void> {
  let error: unknown;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try { assertion(); return; } catch (nextError) { error = nextError; await act(async () => { await new Promise((resolve) => setTimeout(resolve, 5)); }); }
  }
  throw error;
}

afterEach(() => {
  act(() => { root?.unmount(); });
  container?.remove();
  root = undefined;
  container = undefined;
  vi.clearAllMocks();
});

describe("权限管理页", () => {
  it("显示完整分组矩阵并保护 root 角色", async () => {
    api.listAdminPermissionCatalog.mockResolvedValue(catalog);
    api.listAdminRoles.mockResolvedValue(roles);
    api.getAdminRoleDefaults.mockResolvedValue(defaults);
    api.listAdminUsers.mockResolvedValue(users);
    api.getAdminUserPermissions.mockResolvedValue(permissionDelta);
    const view = mount(<AdminPermissionsPage session={session} section="roles" />);
    await waitFor(() => expect(view.textContent).toContain("题目与附件"));
    expect(view.textContent).toContain("root（受保护）");
    expect(view.textContent).toContain("角色基线");
    expect(view.querySelector('input[name="role-root-problem.review"]')?.hasAttribute("disabled")).toBe(true);
  });

  it("分别编辑用户 allow/deny 并展示 deny 优先及来源解释", async () => {
    api.listAdminPermissionCatalog.mockResolvedValue(catalog);
    api.listAdminRoles.mockResolvedValue(roles);
    api.getAdminRoleDefaults.mockResolvedValue(defaults);
    api.listAdminUsers.mockResolvedValue(users);
    api.getAdminUserPermissions.mockResolvedValue(permissionDelta);
    api.updateAdminUserPermissions.mockResolvedValue(permissionDelta);
    const view = mount(<AdminPermissionsPage session={session} section="users" />);
    await waitFor(() => expect(view.textContent).toContain("角色基线：contributor"));
    expect(view.textContent).toContain("角色基线：contributor");
    expect(view.textContent).toContain("用户允许");
    expect(view.textContent).toContain("用户拒绝（优先）");
    expect(view.textContent).toContain("角色基线、用户 allow、用户 deny");
    const save = [...view.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent?.includes("保存用户权限"));
    expect(save).toBeDefined();
    await act(async () => { save?.click(); });
    expect(api.updateAdminUserPermissions).toHaveBeenCalledWith("author", {
      expectedRevision: 3,
      allows: ["problem.review"],
      denies: ["problem.create"]
    });
  });
  it("按入口只渲染用户管理面板并只读取用户所需数据", async () => {
    api.listAdminPermissionCatalog.mockResolvedValue(catalog);
    api.listAdminRoles.mockResolvedValue(roles);
    api.getAdminRoleDefaults.mockResolvedValue(defaults);
    api.listAdminUsers.mockResolvedValue(users);
    api.getAdminUserPermissions.mockResolvedValue(permissionDelta);
    const view = mount(<AdminPermissionsPage session={session} section="users" />);

    await waitFor(() => expect(view.querySelector(".permission-user-panel")).not.toBeNull());
    expect(view.querySelector(".admin-permissions-roles")).toBeNull();
    expect(view.querySelector(".permission-defaults")).toBeNull();
    expect(api.listAdminRoles).not.toHaveBeenCalled();
    expect(api.getAdminRoleDefaults).not.toHaveBeenCalled();
  });

  it("按入口只渲染角色基线面板并避免读取无关账号数据", async () => {
    api.listAdminPermissionCatalog.mockResolvedValue(catalog);
    api.listAdminRoles.mockResolvedValue(roles);
    api.getAdminRoleDefaults.mockResolvedValue(defaults);
    api.listAdminUsers.mockResolvedValue(users);
    const view = mount(<AdminPermissionsPage session={session} section="roles" />);

    await waitFor(() => expect(view.querySelector(".admin-permissions-roles")).not.toBeNull());
    expect(view.querySelector(".permission-user-panel")).toBeNull();
    expect(view.querySelector(".permission-defaults")).toBeNull();
    expect(api.listAdminUsers).not.toHaveBeenCalled();
    expect(api.getAdminRoleDefaults).not.toHaveBeenCalled();
  });

  it("按入口只渲染默认角色说明并避免展开其它管理面板", async () => {
    api.listAdminRoles.mockResolvedValue(roles);
    api.getAdminRoleDefaults.mockResolvedValue(defaults);
    api.listAdminPermissionCatalog.mockResolvedValue(catalog);
    api.listAdminUsers.mockResolvedValue(users);
    const view = mount(<AdminPermissionsPage session={session} section="defaults" />);

    await waitFor(() => expect(view.querySelector(".permission-defaults")).not.toBeNull());
    expect(view.querySelector(".admin-permissions-roles")).toBeNull();
    expect(view.querySelector(".permission-user-panel")).toBeNull();
    expect(api.listAdminPermissionCatalog).not.toHaveBeenCalled();
    expect(api.listAdminUsers).not.toHaveBeenCalled();
  });

  it("默认选择第一个可管理普通用户而不是 root", async () => {
    api.listAdminPermissionCatalog.mockResolvedValue(catalog);
    api.listAdminUsers.mockResolvedValue(users);
    api.getAdminUserPermissions.mockResolvedValue(permissionDelta);
    const view = mount(<AdminPermissionsPage session={session} section="users" />);

    await waitFor(() => expect(api.getAdminUserPermissions).toHaveBeenCalledWith("author"));
    expect(api.getAdminUserPermissions).not.toHaveBeenCalledWith("0");
  });

  it("没有可管理普通用户时显示空态而不请求受保护账号", async () => {
    api.listAdminPermissionCatalog.mockResolvedValue(catalog);
    api.listAdminUsers.mockResolvedValue({ items: [], total: 0, page: 1, pageSize: 30 });
    const view = mount(<AdminPermissionsPage session={session} section="users" />);

    await waitFor(() => expect(view.textContent).toContain("没有可管理的普通用户"));
    expect(view.textContent).toContain("受保护");
    expect(api.getAdminUserPermissions).not.toHaveBeenCalled();
  });

  it("用户权限保存使用响应中的新修订号并显示成功", async () => {
    const updated = {
      ...permissionDelta,
      delta: { ...permissionDelta.delta, revision: 4 }
    };
    api.listAdminPermissionCatalog.mockResolvedValue(catalog);
    api.listAdminUsers.mockResolvedValue(users);
    api.getAdminUserPermissions.mockResolvedValue(permissionDelta);
    api.updateAdminUserPermissions.mockImplementation(async (userId, input) => {
      expect(userId).toBe("author");
      expect(input).toEqual({ expectedRevision: 3, allows: ["problem.review"], denies: ["problem.create"] });
      return updated;
    });
    const view = mount(<AdminPermissionsPage session={session} section="users" />);
    await waitFor(() => expect([...view.querySelectorAll<HTMLButtonElement>("button")]
      .some((button) => button.textContent?.includes("保存用户权限"))).toBe(true));

    const save = [...view.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent?.includes("保存用户权限"));
    await act(async () => { save?.click(); });
    await waitFor(() => {
      expect(view.textContent).toContain("修订号：4");
      expect(view.textContent).toContain("账号权限已保存");
    });
  });

  it("用户权限保存失败时不假定提交、保持 deny-wins 预览并要求刷新回滚", async () => {
    api.listAdminPermissionCatalog.mockResolvedValue(catalog);
    api.listAdminUsers.mockResolvedValue(users);
    api.getAdminUserPermissions.mockResolvedValue(permissionDelta);
    api.updateAdminUserPermissions.mockRejectedValue(new Error("连接中断"));
    const view = mount(<AdminPermissionsPage session={session} section="users" />);
    await waitFor(() => expect(view.querySelector<HTMLInputElement>('input[name="user-deny-problem.review"]')).not.toBeNull());

    const denyReview = view.querySelector<HTMLInputElement>('input[name="user-deny-problem.review"]');
    await act(async () => { denyReview?.click(); });
    const previewBeforeSave = [...view.querySelectorAll<HTMLElement>(".effective-entry")]
      .find((entry) => entry.querySelector("code")?.textContent === "problem.review");
    expect(previewBeforeSave?.textContent).toContain("拒绝");

    const save = [...view.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent?.includes("保存用户权限"));
    await act(async () => { save?.click(); });
    await waitFor(() => expect(view.textContent).toContain("服务端状态未确认"));
    expect(save?.disabled).toBe(true);
    expect(view.textContent).toContain("刷新并确认服务端状态");

    const refresh = [...view.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent?.includes("刷新并确认服务端状态"));
    await act(async () => { refresh?.click(); });
    await waitFor(() => {
      expect(api.getAdminUserPermissions.mock.calls.length).toBeGreaterThan(1);
      expect(view.querySelector<HTMLInputElement>('input[name="user-deny-problem.review"]')?.checked).toBe(false);
    });
    const previewAfterRefresh = [...view.querySelectorAll<HTMLElement>(".effective-entry")]
      .find((entry) => entry.querySelector("code")?.textContent === "problem.review");
    expect(previewAfterRefresh?.textContent).toContain("允许");
    expect(api.updateAdminUserPermissions).toHaveBeenCalledTimes(1);
    expect(view.textContent).not.toContain("服务端状态未确认");
  });

  it("角色保存使用响应中的新修订号并在失败时保持真实状态", async () => {
    const contributor = roles.roles[1]!;
    api.listAdminPermissionCatalog.mockResolvedValue(catalog);
    api.listAdminRoles.mockResolvedValue(roles);
    const updatedRole = { ...contributor, revision: 3 };
    api.updateAdminRole.mockResolvedValue({ role: updatedRole });
    const view = mount(<AdminPermissionsPage session={session} section="roles" />);
    await waitFor(() => expect(view.textContent).toContain("编辑角色：root"));
    const contributorButton = [...view.querySelectorAll<HTMLButtonElement>('button[role="listitem"]')].find((button) => button.textContent?.includes("投稿人"));
    await act(async () => { contributorButton?.click(); });
    await waitFor(() => expect(view.textContent).toContain("编辑角色：投稿人"));
    const save = [...view.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === "保存角色");
    await act(async () => { save?.click(); });
    await waitFor(() => {
      expect(view.textContent).toContain("修订号：3");
      expect(view.textContent).toContain("角色设置已保存");
    });

    api.updateAdminRole.mockRejectedValue(new Error("连接中断"));
    await act(async () => { save?.click(); });
    await waitFor(() => expect(view.textContent).toContain("服务端状态未确认"));
    expect(save?.disabled).toBe(true);
  });
  it("受保护 root 角色的所有权限域默认折叠", async () => {
    api.listAdminPermissionCatalog.mockResolvedValue(catalog);
    api.listAdminRoles.mockResolvedValue(roles);
    const view = mount(<AdminPermissionsPage session={session} section="roles" />);
    await waitFor(() => expect(view.querySelectorAll(".admin-permissions-roles details.permission-group")).toHaveLength(catalog.groups.length));
    expect([...view.querySelectorAll<HTMLDetailsElement>(".admin-permissions-roles details.permission-group")].every((group) => !group.open)).toBe(true);
  });

  it("生效权限预览按域折叠并保留拒绝与来源计数", async () => {
    api.listAdminPermissionCatalog.mockResolvedValue(catalog);
    api.listAdminUsers.mockResolvedValue(users);
    api.getAdminUserPermissions.mockResolvedValue(permissionDelta);
    const view = mount(<AdminPermissionsPage session={session} section="users" />);
    await waitFor(() => expect(view.querySelectorAll(".effective-domain")).toHaveLength(catalog.groups.length));
    const domains = [...view.querySelectorAll<HTMLDetailsElement>(".effective-domain")];
    expect(domains.every((domain) => !domain.open)).toBe(true);
    expect(domains[0]?.querySelector("summary")?.textContent).toContain("来源");
    await act(async () => { domains[0]?.querySelector("summary")?.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
    expect(domains[0]?.open).toBe(true);
  });
});
