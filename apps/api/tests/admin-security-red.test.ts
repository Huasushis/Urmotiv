import { afterEach, describe, expect, it } from "vitest";
import type { CorePermission, PermissionGrant } from "@urmotiv/contracts";
import { createApp } from "../src/app";
import {
  InMemoryAdminSettingsStore,
  type StoredGeneralSettings,
  type StoredUstcOAuthSettings
} from "../src/admin-service";
import { InMemoryRoleManagementStore } from "../src/admin-role-service";
import { createDemoUsers, demoTags } from "../src/demo-data";
import { hasPermission } from "../src/permissions";
import type { StoredUser } from "../src/domain";
import { InMemoryDataStore } from "../src/repository";

const origin = "https://urmotiv.example.test";
const oauthEndpoints = {
  authorizeUrl: "https://id.ustc.edu.cn/cas/oauth2.0/authorize",
  tokenUrl: "https://id.ustc.edu.cn/cas/oauth2.0/accessToken",
  profileUrl: "https://id.ustc.edu.cn/cas/oauth2.0/profile",
  redirectUri: `${origin}/api/v1/auth/ustc/callback`,
  scope: "gid email name"
};
const openApps: Array<Awaited<ReturnType<typeof createApp>>> = [];

function grant(
  permission: string,
  effect: PermissionGrant["effect"] = "allow",
  scope: PermissionGrant["scope"] = "global",
  extra: Pick<PermissionGrant, "objectId" | "expiresAt"> = {}
): PermissionGrant {
  return {
    permission: permission as CorePermission,
    effect,
    scope,
    ...extra
  };
}

function restrictedManager(overrides: Partial<StoredUser> = {}): StoredUser {
  return {
    id: "manager",
    nickname: "受限权限管理员",
    accountType: "human",
    disabled: false,
    roles: ["受限权限管理员"],
    grants: [grant("auth.login"), grant("user.permission.manage")],
    isRoot: false,
    ...overrides
  };
}

async function login(
  app: Awaited<ReturnType<typeof createApp>>,
  userId: string
): Promise<string> {
  const response = await app.inject({
    method: "POST",
    url: "/api/v1/auth/demo-login",
    headers: { origin },
    payload: { userId }
  });
  expect(response.statusCode).toBe(200);
  return (response.headers["set-cookie"] as string).split(";", 1)[0]!;
}

function makeApp(
  users: StoredUser[],
  roleStore = new InMemoryRoleManagementStore()
) {
  return createApp({
    store: new InMemoryDataStore(users, demoTags),
    demoAuthEnabled: true,
    demoUserIds: users.map((user) => user.id),
    allowedOrigins: [origin],
    secureCookies: true,
    adminSettingsStore: new InMemoryAdminSettingsStore({ publicSiteUrl: origin }),
    roleManagementStore: roleStore
  });
}

function oauthPayload(expectedRevision: number, overrides: Record<string, unknown> = {}) {
  return {
    expectedRevision,
    enabled: true,
    ...oauthEndpoints,
    clientId: "security-client",
    clientSecret: "security-client-secret",
    ...overrides
  };
}

afterEach(async () => {
  await Promise.all(openApps.splice(0).map((app) => app.close()));
});

describe("管理员权限提升攻击红测", () => {
  it("拒绝超出调用者 allow ceiling 的权限授予", async () => {
    const manager = restrictedManager();
    const app = await makeApp([manager]);
    openApps.push(app);
    const cookie = await login(app, manager.id);
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/admin/roles",
      headers: { cookie, origin },
      payload: {
        key: "too_powerful",
        displayName: "越权角色",
        description: "",
        permissions: [{ name: "problem.view.all", effect: "allow" }],
        userIds: []
      }
    });
    expect(response.statusCode).toBe(403);
    expect(response.json().error.code).toBe("ROLE_PERMISSION_CEILING");
  });

  it("忽略 own/object 作用域的 allow，不能扩大为全局角色权限", async () => {
    for (const scopedGrant of [
      grant("problem.view.all", "allow", "own"),
      grant("problem.view.all", "allow", "object", { objectId: "problem-1" })
    ]) {
      const manager = restrictedManager({
        grants: [grant("auth.login"), grant("user.permission.manage"), scopedGrant]
      });
      const app = await makeApp([manager]);
      openApps.push(app);
      const cookie = await login(app, manager.id);
      const response = await app.inject({
        method: "POST",
        url: "/api/v1/admin/roles",
        headers: { cookie, origin },
        payload: {
          key: `scoped_ceiling_${scopedGrant.scope}`,
          displayName: "作用域权限",
          description: "",
          permissions: [{ name: "problem.view.all", effect: "allow" }],
          userIds: []
        }
      });
      expect(response.statusCode).toBe(403);
      expect(response.json().error.code).toBe("ROLE_PERMISSION_CEILING");
    }
  });

  it("忽略已过期的 allow，不能扩大为全局角色权限", async () => {
    const manager = restrictedManager({
      grants: [
        grant("auth.login"),
        grant("user.permission.manage"),
        grant("problem.view.all", "allow", "global", {
          expiresAt: new Date(Date.now() - 1_000).toISOString()
        })
      ]
    });
    const app = await makeApp([manager]);
    openApps.push(app);
    const cookie = await login(app, manager.id);
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/admin/roles",
      headers: { cookie, origin },
      payload: {
        key: "expired_ceiling",
        displayName: "过期权限",
        description: "",
        permissions: [{ name: "problem.view.all", effect: "allow" }],
        userIds: []
      }
    });
    expect(response.statusCode).toBe(403);
    expect(response.json().error.code).toBe("ROLE_PERMISSION_CEILING");
  });

  it("拒绝绕过调用者对权限的明确 deny", async () => {
    const manager = restrictedManager({
      grants: [
        grant("auth.login"),
        grant("user.permission.manage"),
        grant("problem.view.all", "deny")
      ]
    });
    const app = await makeApp([manager]);
    openApps.push(app);
    const cookie = await login(app, manager.id);
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/admin/roles",
      headers: { cookie, origin },
      payload: {
        key: "deny_bypass",
        displayName: "绕过拒绝",
        description: "",
        permissions: [{ name: "problem.view.all", effect: "allow" }],
        userIds: []
      }
    });
    expect(response.statusCode).toBe(403);
    expect(response.json().error.code).toBe("ROLE_PERMISSION_DENIED");
  });

  it("全局 allow 被明确 deny 覆盖时不能授权角色", async () => {
    const manager = restrictedManager({
      grants: [
        grant("auth.login"),
        grant("user.permission.manage"),
        grant("problem.view.all", "allow"),
        grant("problem.view.all", "deny")
      ]
    });
    const app = await makeApp([manager]);
    openApps.push(app);
    const cookie = await login(app, manager.id);
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/admin/roles",
      headers: { cookie, origin },
      payload: {
        key: "deny_override",
        displayName: "明确拒绝",
        description: "",
        permissions: [{ name: "problem.view.all", effect: "allow" }],
        userIds: []
      }
    });
    expect(response.statusCode).toBe(403);
    expect(response.json().error.code).toBe("ROLE_PERMISSION_DENIED");
  });

  it("拒绝通过自我成员分配扩大权限", async () => {
    const manager = restrictedManager();
    const app = await makeApp([manager]);
    openApps.push(app);
    const cookie = await login(app, manager.id);
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/admin/roles",
      headers: { cookie, origin },
      payload: {
        key: "self_escalation",
        displayName: "自我提升",
        description: "",
        permissions: [
          { name: "auth.login", effect: "allow" },
          { name: "problem.view.all", effect: "allow" }
        ],
        userIds: [manager.id]
      }
    });
    expect(response.statusCode).toBe(403);
    expect(response.json().error.code).toBe("ROLE_PERMISSION_CEILING");
  });

  it("拒绝把高权限内置角色分配给调用者", async () => {
    const manager = restrictedManager();
    const app = await makeApp([manager]);
    openApps.push(app);
    const cookie = await login(app, manager.id);
    const roles = await app.inject({
      method: "GET",
      url: "/api/v1/admin/roles",
      headers: { cookie }
    });
    const leader = roles.json().roles.find((role: { key: string }) => role.key === "leader");
    expect(leader).toBeDefined();
    const response = await app.inject({
      method: "PUT",
      url: `/api/v1/admin/roles/${leader.id}`,
      headers: { cookie, origin },
      payload: {
        expectedRevision: leader.revision,
        key: leader.key,
        displayName: leader.displayName,
        description: leader.description,
        permissions: leader.permissions,
        userIds: [manager.id]
      }
    });
    expect(response.statusCode).toBe(403);
    expect(response.json().error.code).toBe("ROLE_PERMISSION_CEILING");
  });

  it("root 成员固定为 bootstrap root，root 账号不能进入其他角色", async () => {
    const root: StoredUser = {
      id: "0",
      nickname: "root",
      accountType: "human",
      disabled: false,
      roles: ["root"],
      grants: [
        grant("auth.login"),
        grant("user.permission.manage"),
        grant("system.manage"),
        grant("problem.view.all")
      ],
      isRoot: true
    };
    const manager = restrictedManager();
    const roleStore = new InMemoryRoleManagementStore({ root: ["0"] });
    const app = await makeApp([root, manager], roleStore);
    openApps.push(app);
    const cookie = await login(app, root.id);
    const roles = await app.inject({
      method: "GET",
      url: "/api/v1/admin/roles",
      headers: { cookie }
    });
    const rootRole = roles.json().roles.find((role: { key: string }) => role.key === "root");
    expect(rootRole).toBeDefined();
    const updateRoot = await app.inject({
      method: "PUT",
      url: `/api/v1/admin/roles/${rootRole.id}`,
      headers: { cookie, origin },
      payload: {
        expectedRevision: rootRole.revision,
        key: rootRole.key,
        displayName: rootRole.displayName,
        description: rootRole.description,
        permissions: rootRole.permissions,
        userIds: [manager.id]
      }
    });
    expect(updateRoot.statusCode).toBe(403);
    expect(updateRoot.json().error.code).toBe("ROLE_ROOT_MEMBERSHIP");

    const assignRoot = await app.inject({
      method: "POST",
      url: "/api/v1/admin/roles",
      headers: { cookie, origin },
      payload: {
        key: "root_member_bypass",
        displayName: "root 成员绕过",
        description: "",
        permissions: [{ name: "auth.login", effect: "allow" }],
        userIds: [root.id]
      }
    });
    expect(assignRoot.statusCode).toBe(403);
    expect(assignRoot.json().error.code).toBe("ROLE_ROOT_MEMBERSHIP");
  });

  it("角色管理不能解除机器人硬禁止", async () => {
    const users = createDemoUsers();
    const administrator = users.find((user) => user.id === "administrator")!;
    const robot = users.find((user) => user.id === "robot")!;
    const app = await makeApp(users);
    openApps.push(app);
    const cookie = await login(app, administrator.id);
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/admin/roles",
      headers: { cookie, origin },
      payload: {
        key: "robot_system_manager",
        displayName: "机器人系统管理员",
        description: "",
        permissions: [{ name: "system.manage", effect: "allow" }],
        userIds: [robot.id]
      }
    });
    expect(response.statusCode).toBe(201);
    const roleAssignedRobot = {
      ...robot,
      grants: [...robot.grants, grant("system.manage")]
    };
    expect(hasPermission(roleAssignedRobot, "system.manage", {})).toBe(false);
  });
});

describe("OAuth 高风险配置红测", () => {
  async function appWithAdmin() {
    const users = createDemoUsers();
    const app = await makeApp(users);
    openApps.push(app);
    return { app, cookie: await login(app, "administrator") };
  }

  it("只接受部署批准的 USTC HTTPS authority/path", async () => {
    const { app, cookie } = await appWithAdmin();
    const response = await app.inject({
      method: "PUT",
      url: "/api/v1/admin/oauth/ustc",
      headers: { cookie, origin },
      payload: oauthPayload(1, {
        authorizeUrl: "https://evil.example.test/oauth/authorize"
      })
    });
    expect(response.statusCode).toBe(422);
    expect(response.json().error.code).toBe("OAUTH_ENDPOINT_NOT_APPROVED");
  });

  it("拒绝 OAuth loopback/private/reserved 端点", async () => {
    const { app, cookie } = await appWithAdmin();
    for (const field of ["authorizeUrl", "tokenUrl", "profileUrl"] as const) {
      const response = await app.inject({
        method: "PUT",
        url: "/api/v1/admin/oauth/ustc",
        headers: { cookie, origin },
        payload: oauthPayload(1, {
          [field]: "https://127.0.0.1/cas/oauth2.0/authorize"
        })
      });
      expect(response.statusCode).toBe(422);
      expect(response.json().error.code).toBe("OAUTH_ENDPOINT_NOT_APPROVED");
    }
  });

  it("client/origin 身份变化时必须重新输入旧密钥", async () => {
    const { app, cookie } = await appWithAdmin();
    const first = await app.inject({
      method: "PUT",
      url: "/api/v1/admin/oauth/ustc",
      headers: { cookie, origin },
      payload: oauthPayload(1)
    });
    expect(first.statusCode).toBe(200);
    const revision = first.json().settings.revision;
    const changedClient = await app.inject({
      method: "PUT",
      url: "/api/v1/admin/oauth/ustc",
      headers: { cookie, origin },
      payload: oauthPayload(revision, { clientId: "new-security-client", clientSecret: undefined })
    });
    expect(changedClient.statusCode).toBe(422);
    expect(changedClient.json().error.code).toBe("OAUTH_SECRET_REENTRY_REQUIRED");
  });

  it("身份字段不变时允许空密钥保留已有密钥", async () => {
    const { app, cookie } = await appWithAdmin();
    const first = await app.inject({
      method: "PUT",
      url: "/api/v1/admin/oauth/ustc",
      headers: { cookie, origin },
      payload: oauthPayload(1)
    });
    const revision = first.json().settings.revision;
    const unchanged = await app.inject({
      method: "PUT",
      url: "/api/v1/admin/oauth/ustc",
      headers: { cookie, origin },
      payload: oauthPayload(revision, { clientId: "" , clientSecret: undefined })
    });
    expect(unchanged.statusCode).toBe(200);
  });

  it("公开站点只能使用部署配置的 Web origin", async () => {
    const { app, cookie } = await appWithAdmin();
    const response = await app.inject({
      method: "PUT",
      url: "/api/v1/admin/settings",
      headers: { cookie, origin },
      payload: {
        expectedRevision: 1,
        publicRegistrationEnabled: false,
        publicSiteUrl: "https://evil.example.test"
      }
    });
    expect(response.statusCode).toBe(422);
    expect(response.json().error.code).toBe("PUBLIC_SITE_ORIGIN_NOT_ALLOWED");
  });
});

describe("OAuth 与普通设置修订号隔离红测", () => {
  it("普通设置保存不改变 OAuth override revision 或状态", async () => {
    const users = createDemoUsers();
    const settingsStore = new InMemoryAdminSettingsStore({ publicSiteUrl: origin });
    const app = await createApp({
      store: new InMemoryDataStore(users, demoTags),
      demoAuthEnabled: true,
      demoUserIds: users.map((user) => user.id),
      allowedOrigins: [origin],
      secureCookies: true,
      adminSettingsStore: settingsStore
    });
    openApps.push(app);
    const cookie = await login(app, "administrator");
    const oauth = await app.inject({
      method: "PUT",
      url: "/api/v1/admin/oauth/ustc",
      headers: { cookie, origin },
      payload: oauthPayload(1)
    });
    expect(oauth.statusCode).toBe(200);
    const before = await settingsStore.getUstcOAuthSettings();
    const general = await app.inject({
      method: "PUT",
      url: "/api/v1/admin/settings",
      headers: { cookie, origin },
      payload: {
        expectedRevision: 1,
        publicRegistrationEnabled: false,
        publicSiteUrl: origin
      }
    });
    expect(general.statusCode).toBe(200);
    const after = await settingsStore.getUstcOAuthSettings();
    expect(after).toEqual(before);
    expect((general.json().settings as StoredGeneralSettings).revision).toBe(2);
    expect((oauth.json().settings as StoredUstcOAuthSettings).revision).toBe(before.revision);
  });
});

describe("管理路由解析顺序红测", () => {
  it("roleId 解析前先完成身份与授权", async () => {
    const users = createDemoUsers();
    const app = await makeApp(users);
    openApps.push(app);
    const cookie = await login(app, "author");
    const response = await app.inject({
      method: "PUT",
      url: "/api/v1/admin/roles/not-a-uuid",
      headers: { cookie, origin },
      payload: { malformed: true }
    });
    expect(response.statusCode).toBe(404);
    expect(response.json().error.code).toBe("NOT_FOUND");
  });

  it("OAuth body 解析前先完成身份与授权", async () => {
    const users = createDemoUsers();
    const app = await makeApp(users);
    openApps.push(app);
    const cookie = await login(app, "author");
    const response = await app.inject({
      method: "PUT",
      url: "/api/v1/admin/oauth/ustc",
      headers: { cookie, origin },
      payload: { malformed: true }
    });
    expect(response.statusCode).toBe(404);
    expect(response.json().error.code).toBe("NOT_FOUND");
  });
});
