import { afterEach, describe, expect, it } from "vitest";
import { corePermissions, type PermissionGrant } from "@urmotiv/contracts";
import { createApp } from "../src/app";
import { InMemoryAdminSettingsStore } from "../src/admin-service";
import { InMemoryRoleManagementStore } from "../src/admin-role-service";
import { createDemoUsers, demoTags } from "../src/demo-data";
import type { StoredUser } from "../src/domain";
import { InMemoryDataStore } from "../src/repository";

const origin = "https://urmotiv.example.test";
const openApps: Array<Awaited<ReturnType<typeof createApp>>> = [];

function rootUser(): StoredUser {
  const grants: PermissionGrant[] = corePermissions.map((permission) => ({
    permission,
    effect: "allow",
    scope: "global"
  }));
  return {
    id: "0",
    nickname: "root",
    accountType: "human",
    disabled: false,
    roles: ["root"],
    grants,
    isRoot: true
  };
}

async function makeApp() {
  const app = await createApp({
    store: new InMemoryDataStore([rootUser(), ...createDemoUsers()], demoTags),
    demoAuthEnabled: true,
    demoUserIds: ["0", ...createDemoUsers().map((user) => user.id)],
    allowedOrigins: [origin],
    secureCookies: true,
    adminSettingsStore: new InMemoryAdminSettingsStore({ publicSiteUrl: origin }),
    roleManagementStore: new InMemoryRoleManagementStore({
      root: ["0"],
      system_administrator: ["administrator"]
    })
  });
  openApps.push(app);
  return app;
}

async function login(app: Awaited<ReturnType<typeof createApp>>, userId: string): Promise<string> {
  const response = await app.inject({
    method: "POST",
    url: "/api/v1/auth/demo-login",
    headers: { origin },
    payload: { userId }
  });
  expect(response.statusCode).toBe(200);
  return (response.headers["set-cookie"] as string).split(";", 1)[0]!;
}

afterEach(async () => {
  await Promise.all(openApps.splice(0).map((app) => app.close()));
});

describe("P1 root identity and permission model", () => {
  it("root can switch once, see actor/effective identity, and exit", async () => {
    const app = await makeApp();
    const rootCookie = await login(app, "0");
    const switched = await app.inject({
      method: "POST",
      url: "/api/v1/auth/switch-account",
      headers: { cookie: rootCookie, origin },
      payload: { targetUserId: "author" }
    });
    expect(switched.statusCode).toBe(200);
    expect(switched.json().identity).toEqual({
      actor: { id: "0", nickname: "root" },
      effective: { id: "author", nickname: "投稿人演示账号" },
      switched: true
    });
    expect(switched.json()).not.toHaveProperty("password");
    expect(switched.json()).not.toHaveProperty("token");
    const switchedCookie = (switched.headers["set-cookie"] as string).split(";", 1)[0]!;
    const switchedSession = await app.inject({
      method: "GET",
      url: "/api/v1/session",
      headers: { cookie: switchedCookie, origin }
    });
    expect(switchedSession.statusCode).toBe(200);
    expect(switchedSession.json().identity).toEqual(switched.json().identity);
    const nested = await app.inject({
      method: "POST",
      url: "/api/v1/auth/switch-account",
      headers: { cookie: switchedCookie, origin },
      payload: { targetUserId: "reviewer" }
    });
    expect(nested.statusCode).toBe(409);
    expect(nested.json().error.code).toBe("IMPERSONATION_NESTED");

    const exited = await app.inject({
      method: "POST",
      url: "/api/v1/auth/switch-account/exit",
      headers: { cookie: switchedCookie, origin }
    });
    expect(exited.statusCode).toBe(200);
    expect(exited.json().identity.effective.id).toBe("0");
    const exitedCookie = (exited.headers["set-cookie"] as string).split(";", 1)[0]!;
    const audit = await app.inject({
      method: "GET",
      url: "/api/v1/admin/audit?page=1&pageSize=20",
      headers: { cookie: exitedCookie, origin }
    });
    expect(audit.statusCode).toBe(200);
    expect(audit.json().items.map((item: { action: string }) => item.action)).toEqual(
      expect.arrayContaining(["auth.account_switch", "auth.account_switch.exit"])
    );

    const administratorCookie = await login(app, "administrator");
    const denied = await app.inject({
      method: "POST",
      url: "/api/v1/auth/switch-account",
      headers: { cookie: administratorCookie, origin },
      payload: { targetUserId: "author" }
    });
    expect(denied.statusCode).toBe(404);
    for (const targetUserId of ["robot", "missing"]) {
      const deniedTarget = await app.inject({
        method: "POST",
        url: "/api/v1/auth/switch-account",
        headers: { cookie: exitedCookie, origin },
        payload: { targetUserId }
      });
      expect(deniedTarget.statusCode).toBe(404);
      expect(deniedTarget.json().error.code).toBe("NOT_FOUND");
    }
  });

  it("exposes grouped permissions, searchable users, and effective user deltas", async () => {
    const app = await makeApp();
    const rootCookie = await login(app, "0");
    const catalog = await app.inject({
      method: "GET",
      url: "/api/v1/admin/permissions/catalog",
      headers: { cookie: rootCookie, origin }
    });
    expect(catalog.statusCode).toBe(200);
    expect(catalog.json().groups.map((group: { key: string }) => group.key)).toContain("content");

    const users = await app.inject({
      method: "GET",
      url: "/api/v1/admin/users?search=投稿人",
      headers: { cookie: rootCookie, origin }
    });
    expect(users.statusCode).toBe(200);
    expect(users.json().items.map((item: { id: string }) => item.id)).toContain("author");

    const before = await app.inject({
      method: "GET",
      url: "/api/v1/admin/users/author/permissions",
      headers: { cookie: rootCookie, origin }
    });
    expect(before.statusCode).toBe(200);
    expect(before.json().delta.roles).toContain("contributor");
    expect(before.json().effective.entries.find((entry: { name: string }) => entry.name === "problem.create").sources)
      .toContain("role:contributor");

    const administratorCookie = await login(app, "administrator");
    const updated = await app.inject({
      method: "PUT",
      url: "/api/v1/admin/users/author/permissions",
      headers: { cookie: administratorCookie, origin },
      payload: {
        expectedRevision: before.json().delta.revision,
        allows: ["problem.review", "problem.view.all"],
        denies: ["problem.view.all"]
      }
    });
    expect(updated.statusCode).toBe(200);
    expect(updated.json().effective.permissions).toContain("problem.review");
    expect(updated.json().effective.permissions).not.toContain("problem.view.all");
    expect(updated.json().effective.entries.find((entry: { name: string }) => entry.name === "problem.review").sources)
      .toContain("user:allow");
    expect(updated.json().effective.entries.find((entry: { name: string }) => entry.name === "problem.view.all").sources)
      .toEqual(expect.arrayContaining(["user:allow", "user:deny"]));
    const staleDelta = await app.inject({
      method: "PUT",
      url: "/api/v1/admin/users/author/permissions",
      headers: { cookie: administratorCookie, origin },
      payload: { expectedRevision: before.json().delta.revision, allows: [], denies: [] }
    });
    expect(staleDelta.statusCode).toBe(409);
    expect(staleDelta.json().error.message).toContain("刷新");

    const roles = await app.inject({
      method: "GET",
      url: "/api/v1/admin/roles",
      headers: { cookie: rootCookie, origin }
    });
    const contributor = roles.json().roles.find((role: { key: string }) => role.key === "contributor");
    const roleUpdated = await app.inject({
      method: "PUT",
      url: `/api/v1/admin/roles/${contributor.id}`,
      headers: { cookie: rootCookie, origin },
      payload: {
        expectedRevision: contributor.revision,
        key: contributor.key,
        displayName: contributor.displayName,
        description: contributor.description,
        permissions: [
          ...contributor.permissions,
          { name: "problem.view.all", effect: "allow" }
        ],
        userIds: ["author"]
      }
    });
    expect(roleUpdated.statusCode).toBe(200);
    const afterRoleUpdate = await app.inject({
      method: "GET",
      url: "/api/v1/admin/users/author/permissions",
      headers: { cookie: rootCookie, origin }
    });
    expect(afterRoleUpdate.json().effective.permissions).not.toContain("problem.view.all");
    expect(afterRoleUpdate.json().effective.entries.find((entry: { name: string }) => entry.name === "problem.view.all").sources)
      .toEqual(expect.arrayContaining(["role:contributor", "user:deny"]));

    const rootPermissions = await app.inject({
      method: "GET",
      url: "/api/v1/admin/users/0/permissions",
      headers: { cookie: rootCookie, origin }
    });
    expect(rootPermissions.statusCode).toBe(200);
    expect(rootPermissions.json().effective.permissions).toEqual(corePermissions);

    const adminDelta = await app.inject({
      method: "GET",
      url: "/api/v1/admin/users/administrator/permissions",
      headers: { cookie: administratorCookie, origin }
    });
    const selfEscalation = await app.inject({
      method: "PUT",
      url: "/api/v1/admin/users/administrator/permissions",
      headers: { cookie: administratorCookie, origin },
      payload: {
        expectedRevision: adminDelta.json().delta.revision,
        allows: ["user.impersonate"],
        denies: []
      }
    });
    expect(selfEscalation.statusCode).toBe(403);
    expect((await app.inject({
      method: "GET",
      url: "/api/v1/admin/users/robot/permissions",
      headers: { cookie: administratorCookie, origin }
    })).statusCode).toBe(404);

    const defaults = await app.inject({
      method: "GET",
      url: "/api/v1/admin/roles/defaults",
      headers: { cookie: rootCookie, origin }
    });
    expect(defaults.statusCode).toBe(200);
    expect(defaults.json().defaults.humanRoleKey).toBe("contributor");
    const defaultUpdate = await app.inject({
      method: "PUT",
      url: "/api/v1/admin/roles/defaults",
      headers: { cookie: rootCookie, origin },
      payload: {
        expectedRevision: defaults.json().defaults.revision,
        humanRoleKey: "reviewer",
        robotRoleKey: "reviewer"
      }
    });
    expect(defaultUpdate.statusCode).toBe(200);

    const audit = await app.inject({
      method: "GET",
      url: "/api/v1/admin/audit?page=1&pageSize=100",
      headers: { cookie: rootCookie, origin }
    });
    expect(audit.json().items.map((item: { action: string }) => item.action)).toEqual(
      expect.arrayContaining([
        "admin.user_permission_delta.update",
        "admin.role_defaults.update"
      ])
    );
  });

  it("keeps system-admin daily operations broad while root owns defaults", async () => {
    const app = await makeApp();
    const rootCookie = await login(app, "0");
    const roles = await app.inject({
      method: "GET",
      url: "/api/v1/admin/roles",
      headers: { cookie: rootCookie, origin }
    });
    expect(roles.statusCode).toBe(200);
    const administrator = roles.json().roles.find((role: { key: string }) => role.key === "system_administrator");
    expect(administrator.permissions.map((permission: { name: string }) => permission.name)).toEqual(
      expect.arrayContaining(["problem.review", "problem.export.all", "contest.create", "plugin.manage"])
    );

    const defaults = await app.inject({
      method: "GET",
      url: "/api/v1/admin/roles/defaults",
      headers: { cookie: rootCookie, origin }
    });
    expect(defaults.statusCode).toBe(200);
    expect(defaults.json().defaults.humanRoleKey).toBe("contributor");
    const adminCookie = await login(app, "administrator");
    const defaultWrite = await app.inject({
      method: "PUT",
      url: "/api/v1/admin/roles/defaults",
      headers: { cookie: adminCookie, origin },
      payload: {
        expectedRevision: defaults.json().defaults.revision,
        humanRoleKey: "leader",
        robotRoleKey: "reviewer"
      }
    });
    expect(defaultWrite.statusCode).toBe(404);
  });
});
