import { afterEach, describe, expect, it } from "vitest";
import { problemListQuerySchema } from "@urmotiv/contracts";
import { createApp } from "../src/app";
import { createDemoUsers, demoTags } from "../src/demo-data";
import { ProblemService } from "../src/service";
import { InMemoryDataStore } from "../src/repository";
import { hasPermission } from "../src/permissions";

import { InMemoryAdminSettingsStore } from "../src/admin-service";
import { InMemoryEmailVerificationOutbox } from "../src/email-verification";
const origin = "http://localhost:5173";
const openApps: Array<Awaited<ReturnType<typeof createApp>>> = [];

async function login(
  app: Awaited<ReturnType<typeof createApp>>,
  userId: string,
  requestOrigin = origin
): Promise<string> {
  const response = await app.inject({
    method: "POST",
    url: "/api/v1/auth/demo-login",
    headers: { origin: requestOrigin },
    payload: { userId }
  });
  expect(response.statusCode).toBe(200);
  return (response.headers["set-cookie"] as string).split(";", 1)[0]!;
}

afterEach(async () => {
  await Promise.all(openApps.splice(0).map((app) => app.close()));
});

describe("最终集成红测：管理员与题库入口", () => {
  it("系统管理员获得题库查看、导入、批量状态管理和审核策略权限", () => {
    const administrator = createDemoUsers().find((user) => user.id === "administrator");
    expect(administrator).toBeDefined();
    expect(hasPermission(administrator!, "problem.view.all")).toBe(true);
    expect(hasPermission(administrator!, "problem.import")).toBe(true);
    expect(hasPermission(administrator!, "review.policy.manage")).toBe(true);
    expect(hasPermission(administrator!, "problem.status.change")).toBe(true);
  });

  it("审核策略能力不再由题目终审权限投影", () => {
    const leader = createDemoUsers().find((candidate) => candidate.id === "leader");
    expect(leader).toBeDefined();
    const statusOnlyUser = {
      ...leader!,
      grants: leader!.grants.filter((grant) => grant.permission !== "review.policy.manage")
    };
    const service = new ProblemService(new InMemoryDataStore([statusOnlyUser], demoTags));
    expect(service.getSessionUser(statusOnlyUser).canManageReviewPolicy).toBe(false);
  });

  it("问题列表查询保留来源、批次和导入源筛选", () => {
    const query = problemListQuerySchema.parse({
      origin: "ustc_history",
      batch: "Formal156",
      source: "history-import"
    });
    expect(query).toMatchObject({
      origin: "ustc_history",
      batch: "Formal156",
      source: "history-import"
    });
  });
  it("系统管理员可以持久化公开注册开关和公开站点地址，普通人不能修改", async () => {
    const outbox = new InMemoryEmailVerificationOutbox();
    const app = await createApp({
      store: new InMemoryDataStore(createDemoUsers(), demoTags),
      demoAuthEnabled: true,
      demoUserIds: ["administrator", "author"],
      emailRegistrationEnabled: true,
      emailVerificationDelivery: outbox,
      emailVerificationWebUrl: origin,
      allowedOrigins: [origin],
      allowLoopbackInsecureCookies: true
    });
    openApps.push(app);
    const administratorCookie = await login(app, "administrator");
    const authorCookie = await login(app, "author");
    const initial = await app.inject({
      method: "GET",
      url: "/api/v1/admin/settings",
      headers: { cookie: administratorCookie }
    });
    expect(initial.statusCode).toBe(200);
    expect(initial.json().settings).toMatchObject({
      publicRegistrationEnabled: true,
      publicSiteUrl: origin
    });
    const disabled = await app.inject({
      method: "PUT",
      url: "/api/v1/admin/settings",
      headers: { cookie: administratorCookie, origin },
      payload: {
        expectedRevision: initial.json().settings.revision,
        publicRegistrationEnabled: false,
        publicSiteUrl: origin
      }
    });
    expect(disabled.statusCode).toBe(200);
    expect(disabled.json().settings).toMatchObject({ publicRegistrationEnabled: false });
    const registration = await app.inject({
      method: "POST",
      url: "/api/v1/auth/email-register",
      headers: { origin },
      payload: { email: "disabled@example.test", password: "safe-password-123", nickname: "Disabled" }
    });
    expect(registration.statusCode).toBe(404);
    const reenabled = await app.inject({
      method: "PUT",
      url: "/api/v1/admin/settings",
      headers: { cookie: administratorCookie, origin },
      payload: {
        expectedRevision: disabled.json().settings.revision,
        publicRegistrationEnabled: true,
        publicSiteUrl: origin
      }
    });
    expect(reenabled.statusCode).toBe(200);
    const enabledRegistration = await app.inject({
      method: "POST",
      url: "/api/v1/auth/email-register",
      headers: { origin },
      payload: { email: "enabled@example.test", password: "safe-password-123", nickname: "Enabled" }
    });
    expect(enabledRegistration.statusCode).toBe(202);
    const denied = await app.inject({
      method: "PUT",
      url: "/api/v1/admin/settings",
      headers: { cookie: authorCookie, origin },
      payload: {
        expectedRevision: reenabled.json().settings.revision,
        publicRegistrationEnabled: false,
        publicSiteUrl: "https://urmotiv.example.test"
      }
    });
    expect(denied.statusCode).toBe(404);
  });

  it("SMTP 设置由管理端持久化、密码不回显并立即驱动注册与登录开关", async () => {
    const outbox = new InMemoryEmailVerificationOutbox();
    const settingsStore = new InMemoryAdminSettingsStore({ publicSiteUrl: origin });
    const app = await createApp({
      store: new InMemoryDataStore(createDemoUsers(), demoTags),
      demoAuthEnabled: true,
      demoUserIds: ["administrator"],
      adminSettingsStore: settingsStore,
      emailVerificationDelivery: outbox,
      allowedOrigins: [origin],
      allowLoopbackInsecureCookies: true
    });
    openApps.push(app);
    const administratorCookie = await login(app, "administrator");
    const initial = await app.inject({
      method: "GET",
      url: "/api/v1/admin/settings",
      headers: { cookie: administratorCookie }
    });
    expect(initial.statusCode).toBe(200);
    expect(initial.json().settings).toMatchObject({
      emailLoginEnabled: true,
      emailRegistrationEnabled: false,
      publicRegistrationEnabled: false,
      smtpConfigured: false,
      smtpPasswordConfigured: false
    });

    const incomplete = await app.inject({
      method: "PUT",
      url: "/api/v1/admin/settings",
      headers: { cookie: administratorCookie, origin },
      payload: {
        expectedRevision: 1,
        publicRegistrationEnabled: true,
        publicSiteUrl: origin,
        emailLoginEnabled: true
      }
    });
    expect(incomplete.statusCode).toBe(422);
    expect(incomplete.json().error.code).toBe("PUBLIC_REGISTRATION_UNAVAILABLE");

    const smtpPassword = "smtp-password-for-test";
    const configured = await app.inject({
      method: "PUT",
      url: "/api/v1/admin/settings",
      headers: { cookie: administratorCookie, origin },
      payload: {
        expectedRevision: 1,
        publicRegistrationEnabled: true,
        publicSiteUrl: origin,
        emailLoginEnabled: true,
        smtpHost: "smtp.example.test",
        smtpPort: 587,
        smtpSecure: false,
        smtpUsername: "mailer",
        smtpPassword,
        smtpFromEmail: "noreply@example.test",
        smtpFromName: "Urmotiv"
      }
    });
    expect(configured.statusCode).toBe(200);
    expect(configured.json().settings).toMatchObject({
      emailRegistrationEnabled: true,
      publicRegistrationEnabled: true,
      smtpConfigured: true,
      smtpPasswordConfigured: true
    });
    expect(JSON.stringify(configured.json())).not.toContain(smtpPassword);
    const stored = await settingsStore.getGeneralSettings();
    expect(stored.smtpPasswordEncrypted).not.toBe(smtpPassword);
    expect(settingsStore.decryptSecret(stored.smtpPasswordEncrypted!)).toBe(smtpPassword);
    await expect(app.inject({
      method: "POST",
      url: "/api/v1/auth/email-register",
      headers: { origin },
      payload: {
        email: "smtp-registration@example.test",
        password: "safe-password-123",
        nickname: "SMTP Registration"
      }
    })).resolves.toMatchObject({ statusCode: 202 });
    expect(outbox.messages).toHaveLength(1);
    expect(outbox.messages[0]?.verificationUrl).toMatch(/^http:\/\/localhost:5173\/#\/verify-email\?/);

    const disabled = await app.inject({
      method: "PUT",
      url: "/api/v1/admin/settings",
      headers: { cookie: administratorCookie, origin },
      payload: {
        expectedRevision: configured.json().settings.revision,
        publicRegistrationEnabled: false,
        publicSiteUrl: origin,
        emailLoginEnabled: false
      }
    });
    expect(disabled.statusCode).toBe(200);
    const session = await app.inject({ method: "GET", url: "/api/v1/session" });
    expect(session.json().auth).toMatchObject({
      emailEnabled: false,
      emailRegistrationEnabled: false
    });
    const loginAttempt = await app.inject({
      method: "POST",
      url: "/api/v1/auth/username-login",
      headers: { origin },
      payload: { username: "administrator", password: "unused-password" }
    });
    expect(loginAttempt.statusCode).toBe(404);

    const cleared = await app.inject({
      method: "PUT",
      url: "/api/v1/admin/settings",
      headers: { cookie: administratorCookie, origin },
      payload: {
        expectedRevision: disabled.json().settings.revision,
        publicRegistrationEnabled: false,
        publicSiteUrl: origin,
        emailLoginEnabled: false,
        clearSmtpPassword: true
      }
    });
    expect(cleared.statusCode).toBe(200);
    expect(cleared.json().settings).toMatchObject({
      smtpConfigured: false,
      smtpPasswordConfigured: false
    });
    expect((await settingsStore.getGeneralSettings()).smtpPasswordEncrypted).toBeNull();
  });


  it("管理员可以读取 USTC OAuth 设置且无权请求按不存在处理", async () => {
    const users = createDemoUsers();
    const app = await createApp({
      store: new InMemoryDataStore(users, demoTags),
      demoAuthEnabled: true,
      demoUserIds: ["administrator", "author"]
    });
    openApps.push(app);
    const administratorCookie = await login(app, "administrator");
    const authorCookie = await login(app, "author");

    const settings = await app.inject({
      method: "GET",
      url: "/api/v1/admin/oauth/ustc",
      headers: { cookie: administratorCookie }
    });
    expect(settings.statusCode).toBe(200);
    expect(settings.json()).toMatchObject({
      settings: {
        enabled: false,
        autoCreateUsers: true,
        authorizeUrl: "",
        tokenUrl: "",
        profileUrl: "",
        redirectUri: "/api/v1/auth/ustc/callback",
        scope: "",
        clientIdConfigured: false,
        clientSecretConfigured: false
      }
    });

    const denied = await app.inject({
      method: "GET",
      url: "/api/v1/admin/oauth/ustc",
      headers: { cookie: authorCookie }
    });
    expect(denied.statusCode).toBe(404);
  });
  it("管理页保存的 USTC OAuth 配置立即驱动登录入口且禁用后隐藏", async () => {
    const oauthOrigin = "https://urmotiv.example.test";
    const settingsStore = new InMemoryAdminSettingsStore({ publicSiteUrl: oauthOrigin });
    const app = await createApp({
      store: new InMemoryDataStore(createDemoUsers(), demoTags),
      demoAuthEnabled: true,
      demoUserIds: ["administrator"],
      adminSettingsStore: settingsStore,
      allowedOrigins: [oauthOrigin],
      secureCookies: true,
      ustcOAuthStateSecret: new Uint8Array(32).fill(7)
    });
    openApps.push(app);
    const administratorCookie = await login(app, "administrator", oauthOrigin);
    const enabled = await app.inject({
      method: "PUT",
      url: "/api/v1/admin/oauth/ustc",
      headers: { cookie: administratorCookie, origin: oauthOrigin },
      payload: {
        expectedRevision: 1,
        enabled: true,
        autoCreateUsers: false,
        authorizeUrl: "https://id.ustc.edu.cn/cas/oauth2.0/authorize",
        tokenUrl: "https://id.ustc.edu.cn/cas/oauth2.0/accessToken",
        profileUrl: "https://id.ustc.edu.cn/cas/oauth2.0/profile",
        redirectUri: `${oauthOrigin}/api/v1/auth/ustc/callback`,
        scope: "openid profile",
        clientId: "client-id",
        clientSecret: "client-secret-1234",
        clearClientId: false,
        clearClientSecret: false
      }
    });
    expect(enabled.statusCode).toBe(200);
    expect(enabled.json().settings.autoCreateUsers).toBe(false);
    const start = await app.inject({
      method: "GET",
      url: "/api/v1/auth/ustc/start?returnPath=%2Fproblems",
      headers: { origin: oauthOrigin }
    });
    expect(start.statusCode).toBe(302);
    expect(start.headers.location).toMatch(/^https:\/\/id\.ustc\.edu\.cn\/cas\/oauth2\.0\/authorize\?/);
    expect(start.headers.location).not.toContain("client-secret-1234");
    const callbackFailure = await app.inject({
      method: "GET",
      url: "/api/v1/auth/ustc/callback?state=invalid&code=invalid",
      headers: { origin: oauthOrigin }
    });
    expect(callbackFailure.statusCode).toBe(401);
    const session = await app.inject({ method: "GET", url: "/api/v1/session" });
    expect(session.json().auth.ustcOAuthEnabled).toBe(true);
    const disabled = await app.inject({
      method: "PUT",
      url: "/api/v1/admin/oauth/ustc",
      headers: { cookie: administratorCookie, origin: oauthOrigin },
      payload: {
        expectedRevision: enabled.json().settings.revision,
        enabled: false,
        authorizeUrl: "",
        tokenUrl: "",
        profileUrl: "",
        redirectUri: "/api/v1/auth/ustc/callback",
        scope: "",
        clientId: "",
        clearClientId: true,
        clearClientSecret: true
      }
    });
    expect(disabled.statusCode).toBe(200);
    expect(disabled.json().settings.autoCreateUsers).toBe(false);
    const hidden = await app.inject({ method: "GET", url: "/api/v1/auth/ustc/start" });
    expect(hidden.statusCode).toBe(404);
  });

  it("各管理目录路由按专属权限开放并对普通人与机器人隐藏", async () => {
    const app = await createApp({
      store: new InMemoryDataStore(createDemoUsers(), demoTags),
      demoAuthEnabled: true,
      demoUserIds: ["administrator", "author", "robot"]
    });
    openApps.push(app);
    const administratorCookie = await login(app, "administrator");
    const authorCookie = await login(app, "author");
    const robotCookie = await login(app, "robot");
    const routes = [
      "/api/v1/admin/settings",
      "/api/v1/admin/roles",
      "/api/v1/admin/permissions",
      "/api/v1/admin/service-accounts",
      "/api/v1/admin/audit"
    ];
    for (const url of routes) {
      const allowed = await app.inject({ method: "GET", url, headers: { cookie: administratorCookie } });
      expect(allowed.statusCode).toBe(200);
      const denied = await app.inject({ method: "GET", url, headers: { cookie: authorCookie } });
      expect(denied.statusCode).toBe(404);
      const robotDenied = await app.inject({ method: "GET", url, headers: { cookie: robotCookie } });
      expect(robotDenied.statusCode).toBe(404);
    }
  });


  it("OAuth 保存只返回配置状态，支持设置和清除客户端密钥并拒绝不安全地址", async () => {
    const app = await createApp({
      store: new InMemoryDataStore(createDemoUsers(), demoTags),
      demoAuthEnabled: true,
      demoUserIds: ["administrator"],
      allowLoopbackInsecureCookies: true
    });
    openApps.push(app);
    const cookie = await login(app, "administrator");
    const valid = await app.inject({
      method: "PUT",
      url: "/api/v1/admin/oauth/ustc",
      headers: { cookie, origin },
      payload: {
        expectedRevision: 1,
        enabled: true,
        authorizeUrl: "https://id.ustc.edu.cn/cas/oauth2.0/authorize",
        tokenUrl: "https://id.ustc.edu.cn/cas/oauth2.0/accessToken",
        profileUrl: "https://id.ustc.edu.cn/cas/oauth2.0/profile",
        redirectUri: `${origin}/api/v1/auth/ustc/callback`,
        scope: "openid profile",
        clientId: "client-id",
        clientSecret: "super-secret-value"
      }
    });
    expect(valid.body).not.toContain("client-id");
    expect(valid.body).not.toContain("super-secret-value");
    expect(valid.json()).toMatchObject({ settings: { clientIdConfigured: true, clientSecretConfigured: true } });

    const cleared = await app.inject({
      method: "PUT",
      url: "/api/v1/admin/oauth/ustc",
      headers: { cookie, origin },
      payload: {
        expectedRevision: 2,
        enabled: false,
        authorizeUrl: "",
        tokenUrl: "",
        profileUrl: "",
        redirectUri: "/api/v1/auth/ustc/callback",
        scope: "",
        clientId: "",
        clearClientId: true,
        clearClientSecret: true
      }
    });
    expect(cleared.statusCode).toBe(200);
    expect(cleared.json()).toMatchObject({ settings: { clientIdConfigured: false, clientSecretConfigured: false } });

    const missingCredentials = await app.inject({
      method: "PUT",
      url: "/api/v1/admin/oauth/ustc",
      headers: { cookie, origin },
      payload: {
        expectedRevision: 3,
        enabled: true,
        authorizeUrl: "https://id.ustc.edu.cn/cas/oauth2.0/authorize",
        tokenUrl: "https://id.ustc.edu.cn/cas/oauth2.0/accessToken",
        profileUrl: "https://id.ustc.edu.cn/cas/oauth2.0/profile",
        redirectUri: `${origin}/api/v1/auth/ustc/callback`,
        scope: "",
        clientId: ""
      }
    });
    expect(missingCredentials.statusCode).toBe(422);
    expect(missingCredentials.json().error.code).toBe("OAUTH_CREDENTIALS_REQUIRED");

    const insecure = await app.inject({
      method: "PUT",
      url: "/api/v1/admin/oauth/ustc",
      headers: { cookie, origin },
      payload: {
        expectedRevision: 3,
        enabled: true,
        authorizeUrl: "http://id.ustc.edu.cn/cas/oauth2.0/authorize",
        tokenUrl: "https://id.ustc.edu.cn/cas/oauth2.0/accessToken",
        profileUrl: "https://id.ustc.edu.cn/cas/oauth2.0/profile",
        redirectUri: `${origin}/api/v1/auth/ustc/callback`,
        scope: "",
        clientId: "client-id",
        clientSecret: "another-secret"
      }
    });
    expect(insecure.statusCode).toBe(422);
    expect(insecure.body).not.toContain("another-secret");
  });
  it("管理员可以创建角色并分配权限与账号，内置机器人限制仍在服务端生效", async () => {
    const app = await createApp({
      store: new InMemoryDataStore(createDemoUsers(), demoTags),
      demoAuthEnabled: true,
      demoUserIds: ["administrator", "author", "robot"]
    });
    openApps.push(app);
    const administratorCookie = await login(app, "administrator");
    const authorCookie = await login(app, "author");
    const roles = await app.inject({
      method: "GET",
      url: "/api/v1/admin/roles",
      headers: { cookie: administratorCookie }
    });
    expect(roles.statusCode).toBe(200);
    expect(roles.json()).toEqual(expect.objectContaining({
      permissions: expect.any(Array),
      users: expect.any(Array),
      roles: expect.any(Array)
    }));
    const created = await app.inject({
      method: "POST",
      url: "/api/v1/admin/roles",
      headers: { cookie: administratorCookie, origin },
      payload: {
        key: "content_curator",
        displayName: "内容维护员",
        description: "维护题库内容",
        permissions: [
          { name: "problem.view.all", effect: "allow" },
          { name: "problem.status.change", effect: "deny" }
        ],
        userIds: ["author"]
      }
    });
    expect(created.statusCode).toBe(201);
    const role = created.json().role;
    expect(role).toMatchObject({ key: "content_curator", isBuiltIn: false });
    expect(role.members).toEqual([expect.objectContaining({ id: "author" })]);
    const updated = await app.inject({
      method: "PUT",
      url: `/api/v1/admin/roles/${role.id}`,
      headers: { cookie: administratorCookie, origin },
      payload: {
        expectedRevision: role.revision,
        key: "content_curator",
        displayName: "高级内容维护员",
        description: "维护并检查题库内容",
        permissions: [
          { name: "problem.view.all", effect: "allow" },
          { name: "problem.status.change", effect: "deny" },
          { name: "review.policy.manage", effect: "allow" }
        ],
        userIds: ["author", "robot"]
      }
    });
    expect(updated.statusCode).toBe(200);
    expect(updated.json().role).toMatchObject({ revision: role.revision + 1 });
    const reloaded = await app.inject({
      method: "GET",
      url: "/api/v1/admin/roles",
      headers: { cookie: administratorCookie }
    });
    const savedRole = reloaded.json().roles.find((candidate: { id: string }) => candidate.id === role.id);
    expect(savedRole).toMatchObject({
      displayName: "高级内容维护员",
      members: [
        expect.objectContaining({ id: "author" }),
        expect.objectContaining({ id: "robot" })
      ],
      permissions: expect.arrayContaining([
        { name: "review.policy.manage", effect: "allow" },
        { name: "problem.status.change", effect: "deny" }
      ])
    });
    const denied = await app.inject({
      method: "POST",
      url: "/api/v1/admin/roles",
      headers: { cookie: authorCookie, origin },
      payload: {
        key: "author_role",
        displayName: "普通角色",
        description: "",
        permissions: [],
        userIds: []
      }
    });
    expect(denied.statusCode).toBe(404);
  });


  it("导入历史集合端点按账号隐藏且成功导入可刷新", async () => {
    const users = createDemoUsers();
    const app = await createApp({
      store: new InMemoryDataStore(users, demoTags),
      demoAuthEnabled: true,
      demoUserIds: ["administrator", "author"]
    });
    openApps.push(app);
    const administratorCookie = await login(app, "administrator");
    const authorCookie = await login(app, "author");

    const history = await app.inject({
      method: "GET",
      url: "/api/v1/transfer/imports",
      headers: { cookie: administratorCookie }
    });
    expect(history.statusCode).toBe(200);
    expect(history.json()).toMatchObject({ items: [], page: 1, pageSize: 20, total: 0 });

    const denied = await app.inject({
      method: "GET",
      url: "/api/v1/transfer/imports",
      headers: { cookie: authorCookie }
    });
    expect(denied.statusCode).toBe(404);
  });
});
