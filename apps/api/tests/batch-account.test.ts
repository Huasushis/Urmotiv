import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { BatchAccountAuditWriteError } from "../src/batch-account";
import type { BatchAccountAuditWriter } from "../src/account-audit";
import { createApp } from "../src/app";
import type { StoredUser } from "../src/domain";
import { createDemoUsers, demoTags } from "../src/demo-data";
import { InMemoryDataStore } from "../src/repository";

const localOrigin = "http://localhost:5173";
const openApps: FastifyInstance[] = [];
async function makeApp(
  users: StoredUser[] = createDemoUsers(),
  batchAccountAuditWriter?: BatchAccountAuditWriter
) {
  const store = new InMemoryDataStore(users, demoTags);
  const app = await createApp({
    store,
    demoAuthEnabled: true,
    demoUserIds: users.map((user) => user.id),
    allowedOrigins: [localOrigin],
    ...(batchAccountAuditWriter === undefined ? {} : { batchAccountAuditWriter })
  });
  openApps.push(app);
  return { app, store };
}

async function login(app: FastifyInstance, userId: string): Promise<string> {
  const response = await app.inject({
    method: "POST",
    url: "/api/v1/auth/demo-login",
    headers: { origin: localOrigin },
    payload: { userId }
  });
  expect(response.statusCode).toBe(200);
  const setCookie = response.headers["set-cookie"];
  const cookie = Array.isArray(setCookie) ? setCookie[0] : setCookie;
  expect(cookie).toMatch(/^urmotiv_session=/);
  return cookie!.split(";", 1)[0]!;
}

function batchText(...lines: string[]): string {
  return lines.join("\n");
}

function accountLine(username: string, nickname: string, email: string, password: string): string {
  return `${username}\t${nickname}\t${email}\t${password}`;
}

afterEach(async () => {
  await Promise.all(openApps.splice(0).map((app) => app.close()));
});

describe("批量创建账号 API", () => {
  it("组长可以一次创建多行合成邮箱账号，只返回数量而不返回密码或账号明细", async () => {
    const { app, store } = await makeApp();
    const cookie = await login(app, "leader");
    const before = (await store.listUsers()).length;

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/admin/accounts/batch",
      headers: { cookie, origin: localOrigin },
      payload: {
        text: batchText(
          accountLine("PB-SYNTH-0001", "合成账号甲", "batch-a@example.test", "SyntheticPass-A-123"),
          accountLine("PB-SYNTH-0002", "合成账号乙", "batch-b@example.test", "SyntheticPass-B-456")
        )
      }
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ ok: true, createdCount: 2, totalCount: 2 });
    expect(store.batchAccountAuditEvents).toEqual([
      expect.objectContaining({ actorUserId: "leader", accountCount: 2 })
    ]);
    expect(response.body).not.toContain("SyntheticPass");
    expect((await store.listUsers()).length).toBe(before + 2);
  });

  it("混合无效行时整批拒绝、保留零新增，并只返回行号和固定错误", async () => {
    const { app, store } = await makeApp();
    const cookie = await login(app, "leader");
    const before = (await store.listUsers()).length;
    const secret = "SyntheticPass-C-789";

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/admin/accounts/batch",
      headers: { cookie, origin: localOrigin },
      payload: {
        text: batchText(
          accountLine("PB-SYNTH-0003", "合成账号丙", "batch-c@example.test", secret),
          accountLine("PB-SYNTH-0004", "合成账号丁", "not-an-email", "short")
        )
      }
    });

    expect(response.statusCode).toBe(422);
    const body = response.json() as { error: { code: string; message: string; fieldErrors?: Record<string, string[]> } };
    expect(body.error.code).toBe("INVALID_INPUT");
    expect(body.error.message).toBe("批量账号内容不符合要求。");
    expect(body.error.fieldErrors).toEqual(expect.objectContaining({ "lines.2": expect.any(Array) }));
    expect(response.body).not.toContain(secret);
    expect(response.body).not.toContain("not-an-email");
    expect((await store.listUsers()).length).toBe(before);
  });

  it("拒绝本批次重复邮箱和用户名，且不部分创建", async () => {
    const { app, store } = await makeApp();
    const cookie = await login(app, "leader");
    const before = (await store.listUsers()).length;

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/admin/accounts/batch",
      headers: { cookie, origin: localOrigin },
      payload: {
        text: batchText(
          accountLine("PB-SYNTH-DUP", "合成重复甲", "duplicate@example.test", "SyntheticPass-D-123"),
          accountLine("PB-SYNTH-DUP", "合成重复乙", "duplicate@example.test", "SyntheticPass-E-456")
        )
      }
    });

    expect(response.statusCode).toBe(409);
    const body = response.json() as { error: { code: string; message: string; fieldErrors?: Record<string, string[]> } };
    expect(body.error.code).toBe("CONFLICT");
    expect(body.error.message).toBe("批量账号与已有账号冲突。");
    expect(body.error.fieldErrors).toEqual(expect.objectContaining({ "lines.2": expect.any(Array) }));
    expect(response.body).not.toContain("SyntheticPass");
    expect((await store.listUsers()).length).toBe(before);
  });

  it("拒绝既有邮箱、用户名和身份冲突，且不部分创建或泄露冲突值", async () => {
    const users = createDemoUsers();
    const existing = { ...users[0]!, id: "existing-identity", username: "PB-SYNTH-EXISTING" };
    users.push(existing);
    const { app, store } = await makeApp(users);
    await store.registerEmailUser({
      normalizedEmail: "existing@example.test",
      displayEmail: "existing@example.test",
      passwordHash: "synthetic-hash",
      nickname: "既有邮箱账号"
    });
    const cookie = await login(app, "leader");
    const before = (await store.listUsers()).length;

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/admin/accounts/batch",
      headers: { cookie, origin: localOrigin },
      payload: {
        text: batchText(
          accountLine("PB-SYNTH-OTHER", "既有邮箱账号", "existing@example.test", "SyntheticPass-F-789"),
          accountLine("PB-SYNTH-EXISTING", "既有用户名账号", "username@example.test", "SyntheticPass-G-012")
        )
      }
    });

    expect(response.statusCode).toBe(409);
    const body = response.json() as { error: { code: string; message: string; fieldErrors?: Record<string, string[]> } };
    expect(body.error.code).toBe("CONFLICT");
    expect(body.error.message).toBe("批量账号与已有账号冲突。");
    expect(Object.keys(body.error.fieldErrors ?? {})).toEqual(expect.arrayContaining(["lines.1", "lines.2"]));
    expect(response.body).not.toContain("existing@example.test");
    expect(response.body).not.toContain("SyntheticPass");
    expect((await store.listUsers()).length).toBe(before);
  });

  it("审计写入失败时事务回滚且不泄露凭据", async () => {
    const failingAuditWriter: BatchAccountAuditWriter = {
      async write() {
        throw new BatchAccountAuditWriteError();
      }
    };
    const { app, store } = await makeApp(createDemoUsers(), failingAuditWriter);
    const cookie = await login(app, "leader");
    const before = (await store.listUsers()).length;

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/admin/accounts/batch",
      headers: { cookie, origin: localOrigin },
      payload: {
        text: accountLine("PB-SYNTH-AUDIT", "审计回滚账号", "audit-rollback@example.test", "SyntheticPass-I-678")
      }
    });

    expect(response.statusCode).toBe(503);
    const body = response.json() as { error: { code: string; message: string } };
    expect(body.error.code).toBe("AUDIT_UNAVAILABLE");
    expect(body.error.message).toBe("账号创建记录暂时无法保存，未创建任何账号。");
    expect(response.body).not.toContain("SyntheticPass-I-678");
    expect((await store.listUsers()).length).toBe(before);
    expect(store.batchAccountAuditEvents).toHaveLength(0);
  });

  it("未登录、无创建权限、明确拒绝和已停用账号均不能创建", async () => {
    const base = createDemoUsers();
    const denied: StoredUser = {
      ...base.find((user) => user.id === "leader")!,
      id: "explicit-deny",
      grants: [
        ...base.find((user) => user.id === "leader")!.grants,
        { permission: "user.create", effect: "deny", scope: "global" }
      ]
    };
    const disabled: StoredUser = {
      ...base.find((user) => user.id === "leader")!,
      id: "disabled-creator",
      disabled: true
    };
    const { app, store } = await makeApp([...base, denied, disabled]);
    const authorCookie = await login(app, "author");
    const deniedCookie = await login(app, denied.id);
    const disabledSession = await store.createSession(disabled.id, new Date(Date.now() + 60_000).toISOString());
    const payload = { text: accountLine("PB-SYNTH-NO", "不应创建", "no-create@example.test", "SyntheticPass-H-345") };

    for (const [cookie, status] of [
      [undefined, 401],
      [authorCookie, 403],
      [deniedCookie, 403],
      [`urmotiv_session=${disabledSession.id}`, 401]
    ] as const) {
      const response = await app.inject({
        method: "POST",
        url: "/api/v1/admin/accounts/batch",
        headers: { ...(cookie === undefined ? {} : { cookie }), origin: localOrigin },
        payload
      });
      expect(response.statusCode).toBe(status);
      expect(response.body).not.toContain("SyntheticPass-H-345");
    }
    expect((await store.listUsers()).filter((user) => user.nickname === "不应创建")).toHaveLength(0);
  });
});
