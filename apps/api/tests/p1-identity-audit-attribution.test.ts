import { createApiToken } from "@urmotiv/auth";
import { corePermissions, type CreatedServiceAccountToken, type PermissionGrant } from "@urmotiv/contracts";
import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import type { BatchAccountAuditEvent, BatchAccountAuditWriter } from "../src/account-audit";
import { createApp } from "../src/app";
import { InMemoryRoleManagementStore } from "../src/admin-role-service";
import { createDemoUsers, demoTags } from "../src/demo-data";
import type { StoredUser } from "../src/domain";
import { InMemoryDataStore } from "../src/repository";
import { DatabaseServiceAccountTokenStore } from "../src/service-account-store";

const origin = "https://urmotiv.example.test";
const openApps: FastifyInstance[] = [];

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

type CapturedBatchEvent = BatchAccountAuditEvent & { effectiveUserId?: string };
type CapturedTokenEvent = {
  action: string;
  actorUserId: string;
  effectiveUserId?: string;
};

class CapturingBatchAuditWriter implements BatchAccountAuditWriter {
  public readonly events: CapturedBatchEvent[] = [];

  public async write(event: BatchAccountAuditEvent): Promise<void> {
    this.events.push(event as CapturedBatchEvent);
  }
}

class FakeServiceAccountTokenStore {
  public readonly events: CapturedTokenEvent[] = [];
  private nextId = 1;

  public async listTokens(): Promise<undefined> {
    return undefined;
  }

  public async createToken(
    _userId: string,
    operation: { actorUserId: string; effectiveUserId?: string }
  ): Promise<CreatedServiceAccountToken> {
    return this.created("service_account.token.create", operation);
  }

  public async rotateToken(
    _userId: string,
    _tokenId: string,
    operation: { actorUserId: string; effectiveUserId?: string }
  ): Promise<CreatedServiceAccountToken> {
    return this.created("service_account.token.rotate", operation);
  }

  public async revokeToken(
    _userId: string,
    _tokenId: string,
    actorUserId: string,
    _requestId: string,
    effectiveUserId?: string
  ) {
    this.events.push({
      action: "service_account.token.revoke",
      actorUserId,
      ...(effectiveUserId === undefined ? {} : { effectiveUserId })
    });
    return {
      id: "00000000-0000-4000-8000-000000000010",
      name: "合成服务令牌",
      displayPrefix: "umv_test",
      permissions: ["problem.review"],
      sourceCidrs: [],
      expiresAt: null,
      lastUsedAt: null,
      revokedAt: new Date().toISOString(),
      createdAt: new Date().toISOString()
    };
  }

  private created(action: string, operation: { actorUserId: string; effectiveUserId?: string }): CreatedServiceAccountToken {
    const apiToken = createApiToken();
    this.events.push({
      action,
      actorUserId: operation.actorUserId,
      ...(operation.effectiveUserId === undefined ? {} : { effectiveUserId: operation.effectiveUserId })
    });
    return {
      item: {
        id: `00000000-0000-4000-8000-${String(this.nextId++).padStart(12, "0")}`,
        name: "合成服务令牌",
        displayPrefix: apiToken.displayPrefix,
        permissions: ["problem.review"],
        sourceCidrs: [],
        expiresAt: null,
        lastUsedAt: null,
        revokedAt: null,
        createdAt: new Date().toISOString()
      },
      token: apiToken.token
    };
  }
}

async function makeApp() {
  const demoUsers = createDemoUsers();
  const robot = demoUsers.find((user) => user.id === "robot");
  if (robot !== undefined) {
    demoUsers.push({ ...robot, id: "1003" });
  }
  const store = new InMemoryDataStore([rootUser(), ...demoUsers], demoTags);
  const batchAudit = new CapturingBatchAuditWriter();
  const tokenStore = new FakeServiceAccountTokenStore();
  const app = await createApp({
    store,
    demoAuthEnabled: true,
    demoUserIds: ["0", ...demoUsers.map((user) => user.id)],
    allowedOrigins: [origin],
    secureCookies: true,
    roleManagementStore: new InMemoryRoleManagementStore({ root: ["0"] }),
    batchAccountAuditWriter: batchAudit,
    serviceAccountTokens: tokenStore as unknown as DatabaseServiceAccountTokenStore
  });
  openApps.push(app);
  return { app, batchAudit, tokenStore };
}

async function login(app: FastifyInstance, userId: string): Promise<string> {
  const response = await app.inject({
    method: "POST",
    url: "/api/v1/auth/demo-login",
    headers: { origin },
    payload: { userId }
  });
  expect(response.statusCode).toBe(200);
  const setCookie = response.headers["set-cookie"];
  const firstCookie = Array.isArray(setCookie) ? setCookie[0] : setCookie;
  return (firstCookie as string).split(";", 1)[0]!;
}

async function switchToAdministrator(app: FastifyInstance, rootCookie: string): Promise<string> {
  const response = await app.inject({
    method: "POST",
    url: "/api/v1/auth/switch-account",
    headers: { cookie: rootCookie, origin },
    payload: { targetUserId: "administrator" }
  });
  expect(response.statusCode).toBe(200);
  const setCookie = response.headers["set-cookie"];
  const firstCookie = Array.isArray(setCookie) ? setCookie[0] : setCookie;
  return (firstCookie as string).split(";", 1)[0]!;
}

afterEach(async () => {
  await Promise.all(openApps.splice(0).map((app) => app.close()));
});

describe("High-2 identity-admin audit attribution", () => {
  it("attributes impersonated batch and token create/rotate/revoke to root", async () => {
    const { app, batchAudit, tokenStore } = await makeApp();
    const effectiveCookie = await switchToAdministrator(app, await login(app, "0"));
    const batch = await app.inject({
      method: "POST",
      url: "/api/v1/admin/accounts/batch",
      headers: { cookie: effectiveCookie, origin },
      payload: { text: "PB-HIGH2\t合成账号\tbatch-high2@example.test\tSyntheticPass-A-123" }
    });
    expect(batch.statusCode).toBe(200);
    const created = await app.inject({
      method: "POST",
      url: "/api/v1/admin/service-accounts/1003/tokens",
      headers: { cookie: effectiveCookie, origin },
      payload: { name: "合成令牌", permissions: ["auth.login", "problem.review"], sourceCidrs: [], expiresAt: null }
    });
    expect(created.statusCode).toBe(200);
    const createdToken = (created.json() as CreatedServiceAccountToken).token;
    const tokenId = (created.json() as CreatedServiceAccountToken).item.id;
    const rotated = await app.inject({
      method: "POST",
      url: `/api/v1/admin/service-accounts/1003/tokens/${tokenId}/rotate`,
      headers: { cookie: effectiveCookie, origin },
      payload: { name: "合成令牌轮换", permissions: ["auth.login", "problem.review"], sourceCidrs: [], expiresAt: null }
    });
    expect(rotated.statusCode).toBe(200);
    const rotatedToken = (rotated.json() as CreatedServiceAccountToken).token;
    const revoked = await app.inject({
      method: "DELETE",
      url: `/api/v1/admin/service-accounts/1003/tokens/${tokenId}`,
      headers: { cookie: effectiveCookie, origin }
    });
    expect(revoked.statusCode).toBe(200);

    expect(batchAudit.events[0]).toEqual(expect.objectContaining({ actorUserId: "0", effectiveUserId: "administrator" }));
    expect(tokenStore.events).toEqual(expect.arrayContaining([
      expect.objectContaining({ action: "service_account.token.create", actorUserId: "0", effectiveUserId: "administrator" }),
      expect.objectContaining({ action: "service_account.token.rotate", actorUserId: "0", effectiveUserId: "administrator" }),
      expect.objectContaining({ action: "service_account.token.revoke", actorUserId: "0", effectiveUserId: "administrator" })
    ]));
    expect(JSON.stringify(batchAudit.events)).not.toContain("SyntheticPass-A-123");
    expect(JSON.stringify(tokenStore.events)).not.toContain(createdToken);
    expect(JSON.stringify(tokenStore.events)).not.toContain(rotatedToken);
  });

  it("keeps ordinary admin mutations attributed to the ordinary actor", async () => {
    const { app, batchAudit, tokenStore } = await makeApp();
    const cookie = await login(app, "administrator");
    const batch = await app.inject({
      method: "POST",
      url: "/api/v1/admin/accounts/batch",
      headers: { cookie, origin },
      payload: { text: "PB-HIGH2-NORMAL\t普通合成账号\tnormal-high2@example.test\tSyntheticPass-B-456" }
    });
    expect(batch.statusCode).toBe(200);
    const token = await app.inject({
      method: "POST",
      url: "/api/v1/admin/service-accounts/1003/tokens",
      headers: { cookie, origin },
      payload: { name: "普通合成令牌", permissions: ["auth.login", "problem.review"], sourceCidrs: [], expiresAt: null }
    });
    expect(token.statusCode).toBe(200);
    expect(batchAudit.events[0]).toMatchObject({ actorUserId: "administrator" });
    expect(batchAudit.events[0]?.effectiveUserId).toBeUndefined();
    expect(tokenStore.events[0]).toMatchObject({ actorUserId: "administrator" });
    expect(tokenStore.events[0]?.effectiveUserId).toBeUndefined();
  });
});
