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
  const store = new InMemoryDataStore([rootUser(), ...createDemoUsers()], demoTags);
  const app = await createApp({
    store,
    demoAuthEnabled: true,
    demoUserIds: ["0", ...createDemoUsers().map((user) => user.id)],
    allowedOrigins: [origin],
    secureCookies: true,
    adminSettingsStore: new InMemoryAdminSettingsStore({ publicSiteUrl: origin }),
    roleManagementStore: new InMemoryRoleManagementStore({ root: ["0"] })
  });
  openApps.push(app);
  return { app, store };
}

async function login(app: Awaited<ReturnType<typeof createApp>>): Promise<string> {
  const response = await app.inject({
    method: "POST",
    url: "/api/v1/auth/demo-login",
    headers: { origin },
    payload: { userId: "0" }
  });
  expect(response.statusCode).toBe(200);
  return (response.headers["set-cookie"] as string).split(";", 1)[0]!;
}

afterEach(async () => {
  await Promise.all(openApps.splice(0).map((app) => app.close()));
});

describe("P1 default role application", () => {
  it("applies the current human default to email and first OAuth accounts", async () => {
    const { app, store } = await makeApp();
    const cookie = await login(app);
    const current = await app.inject({
      method: "GET",
      url: "/api/v1/admin/roles/defaults",
      headers: { cookie, origin }
    });
    expect(current.statusCode).toBe(200);
    const updated = await app.inject({
      method: "PUT",
      url: "/api/v1/admin/roles/defaults",
      headers: { cookie, origin },
      payload: {
        expectedRevision: current.json().defaults.revision,
        humanRoleKey: "reviewer",
        robotRoleKey: "reviewer"
      }
    });
    expect(updated.statusCode).toBe(200);

    const emailUser = await store.registerEmailUser({
      normalizedEmail: "new-email@example.test",
      displayEmail: "new-email@example.test",
      passwordHash: "test-password-hash",
      nickname: "新邮箱账号"
    });
    const oauthUser = await store.findOrCreateExternalUser({
      provider: "ustc-oauth",
      subject: "new-oauth-subject",
      nickname: "新 OAuth 账号",
      strictReconciliation: true
    });
    expect(emailUser?.roles).toEqual(["审题人"]);
    expect(oauthUser.roles).toEqual(["审题人"]);
    expect(emailUser?.grants.map((grant) => grant.permission)).toContain("problem.review");
    expect(oauthUser.grants.map((grant) => grant.permission)).toContain("problem.review");
  });
});
