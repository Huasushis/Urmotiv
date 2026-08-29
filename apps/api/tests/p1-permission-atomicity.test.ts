import { afterEach, describe, expect, it } from "vitest";
import { corePermissions, type PermissionGrant } from "@urmotiv/contracts";
import { createApp } from "../src/app";
import { InMemoryAdminSettingsStore, type AdminAuditEventInput } from "../src/admin-service";
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

class CapturingAuditStore extends InMemoryAdminSettingsStore {
  public readonly events: AdminAuditEventInput[] = [];

  public override async recordAuditEvent(event: AdminAuditEventInput): Promise<void> {
    this.events.push(structuredClone(event));
    await super.recordAuditEvent(event);
  }
}

class FailingAuditStore extends InMemoryAdminSettingsStore {
  public override async recordAuditEvent(_event: AdminAuditEventInput): Promise<void> {
    throw new Error("synthetic audit failure");
  }
}

async function makeApp(settingsStore: InMemoryAdminSettingsStore) {
  const store = new InMemoryDataStore([rootUser(), ...createDemoUsers()], demoTags);
  const app = await createApp({
    store,
    adminSettingsStore: settingsStore,
    roleManagementStore: new InMemoryRoleManagementStore({ root: ["0"] }),
    demoAuthEnabled: true,
    demoUserIds: ["0", ...createDemoUsers().map((user) => user.id)],
    allowedOrigins: [origin],
    secureCookies: true
  });
  openApps.push(app);
  return { app, store };
}

async function login(app: Awaited<ReturnType<typeof createApp>>, userId: string): Promise<string> {
  const response = await app.inject({
    method: "POST",
    url: "/api/v1/auth/demo-login",
    headers: { origin },
    payload: { userId }
  });
  expect(response.statusCode).toBe(200);
  const cookie = response.headers["set-cookie"];
  const firstCookie = Array.isArray(cookie) ? cookie[0] : cookie;
  expect(firstCookie).toBeTypeOf("string");
  return (firstCookie as string).split(";", 1)[0]!;
}

afterEach(async () => {
  await Promise.all(openApps.splice(0).map((app) => app.close()));
});

describe("P1 permission delta atomicity and attribution", () => {
  it("rolls back the delta when the audit write fails", async () => {
    const { app, store } = await makeApp(new FailingAuditStore());
    const cookie = await login(app, "0");
    const before = await store.getUserPermissionDelta("author");
    const response = await app.inject({
      method: "PUT",
      url: "/api/v1/admin/users/author/permissions",
      headers: { cookie, origin },
      payload: { expectedRevision: before.revision, allows: ["problem.review"], denies: [] }
    });
    expect(response.statusCode).toBe(503);
    await expect(store.getUserPermissionDelta("author")).resolves.toEqual(before);
  });

  it("audits the root actor while authorizing as the switched effective user", async () => {
    const auditStore = new CapturingAuditStore();
    const { app, store } = await makeApp(auditStore);
    const rootCookie = await login(app, "0");
    const switched = await app.inject({
      method: "POST",
      url: "/api/v1/auth/switch-account",
      headers: { cookie: rootCookie, origin },
      payload: { targetUserId: "administrator" }
    });
    expect(switched.statusCode).toBe(200);
    const setCookie = switched.headers["set-cookie"];
    const switchedCookie = (Array.isArray(setCookie) ? setCookie[0] : setCookie)!.split(";", 1)[0]!;
    const before = await store.getUserPermissionDelta("author");
    const response = await app.inject({
      method: "PUT",
      url: "/api/v1/admin/users/author/permissions",
      headers: { cookie: switchedCookie, origin },
      payload: { expectedRevision: before.revision, allows: ["problem.review"], denies: [] }
    });
    expect(response.statusCode).toBe(200);
    const audit = auditStore.events.find((event) => event.action === "admin.user_permission_delta.update");
    expect(audit?.actorUserId).toBe("0");
    expect(audit?.metadata).toMatchObject({ effectiveUserId: "administrator" });
  });
});
