import type { PermissionGrant } from "@urmotiv/contracts";
import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app";
import { createBuiltinPluginDefinitions } from "../src/builtin-plugins";
import { createDemoUsers, demoTags } from "../src/demo-data";
import type { StoredUser } from "../src/domain";
import { InMemoryPluginStore, TrustedPluginHost } from "../src/plugin-host";
import { InMemoryDataStore } from "../src/repository";

const origin = "http://localhost:5173";
const openApps: FastifyInstance[] = [];
const fullContent = {
  basicStatement: "给定一个整数，输出它本身。",
  basicSolution: "直接输出输入即可。",
  background: "",
  statement: "",
  inputFormat: "",
  outputFormat: "",
  constraints: "",
  solution: "",
  hints: ""
};

afterEach(async () => {
  await Promise.all(openApps.splice(0).map(async (app) => app.close()));
});

async function makeApp(users: StoredUser[] = createDemoUsers()) {
  const store = new InMemoryDataStore(users, demoTags);
  const host = new TrustedPluginHost(
    createBuiltinPluginDefinitions(),
    new InMemoryPluginStore()
  );
  const app = await createApp({
    demoAuthEnabled: true,
    store,
    pluginHost: host,
    demoUserIds: users.map((user) => user.id)
  });
  openApps.push(app);
  return { app, store };
}

async function login(app: FastifyInstance, userId: string): Promise<string> {
  const response = await app.inject({
    method: "POST",
    url: "/api/v1/auth/demo-login",
    headers: { origin },
    payload: { userId }
  });
  expect(response.statusCode).toBe(200);
  const cookie = response.headers["set-cookie"];
  return (Array.isArray(cookie) ? cookie[0] : cookie)!.split(";", 1)[0]!;
}

async function createDraft(app: FastifyInstance, cookie: string, title: string) {
  const response = await app.inject({
    method: "POST",
    url: "/api/v1/problems",
    headers: { cookie, origin },
    payload: {
      title,
      type: "traditional",
      tagIds: ["algorithm.implementation"],
      content: fullContent
    }
  });
  expect(response.statusCode).toBe(200);
  return response.json() as {
    id: string;
    revision: number;
    reviewRound: number;
    status: string;
  };
}

describe("批量题目状态管理", () => {
  it("有全局状态权限的真人管理员可以批量提交并人工终审他人的题目", async () => {
    const { app } = await makeApp();
    const author = await login(app, "author");
    const manager = await login(app, "leader");
    const draft = await createDraft(app, author, "批量状态测试题");

    const submitted = await app.inject({
      method: "POST",
      url: "/api/v1/admin/problems/status",
      headers: { cookie: manager, origin },
      payload: {
        action: "submit",
        reason: "",
        items: [{
          id: draft.id,
          expectedRevision: draft.revision,
          expectedRound: draft.reviewRound
        }]
      }
    });
    expect(submitted.statusCode).toBe(200);
    const submittedResult = submitted.json() as {
      results: Array<{ id: string; ok: boolean; status: string; revision: number }>;
    };
    expect(submittedResult.results).toEqual([expect.objectContaining({
      id: draft.id,
      ok: true,
      status: "pending_review",
      revision: draft.revision + 1
    })]);

    const approved = await app.inject({
      method: "POST",
      url: "/api/v1/admin/problems/status",
      headers: { cookie: manager, origin },
      payload: {
        action: "approve",
        reason: "管理员已完成批量人工复核。",
        items: [{
          id: draft.id,
          expectedRevision: draft.revision + 1,
          expectedRound: 1
        }]
      }
    });
    expect(approved.statusCode).toBe(200);
    expect(approved.json()).toEqual({
      results: [{
        id: draft.id,
        ok: true,
        status: "approved",
        revision: draft.revision + 2
      }]
    });
  });

  it("逐题报告版本冲突和非法状态，且不会覆盖其他成功项", async () => {
    const { app } = await makeApp();
    const author = await login(app, "author");
    const manager = await login(app, "leader");
    const stale = await createDraft(app, author, "版本冲突题");
    const valid = await createDraft(app, author, "正常批量题");

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/admin/problems/status",
      headers: { cookie: manager, origin },
      payload: {
        action: "submit",
        reason: "",
        items: [
          { id: stale.id, expectedRevision: stale.revision + 1, expectedRound: 0 },
          { id: valid.id, expectedRevision: valid.revision, expectedRound: 0 }
        ]
      }
    });
    expect(response.statusCode).toBe(200);
    const body = response.json() as {
      results: Array<{ id: string; ok: boolean; code?: string; status?: string }>;
    };
    expect(body.results[0]).toMatchObject({
      id: stale.id,
      ok: false,
      code: "CONFLICT"
    });
    expect(body.results[1]).toMatchObject({
      id: valid.id,
      ok: true,
      status: "pending_review"
    });

    const repeat = await app.inject({
      method: "POST",
      url: "/api/v1/admin/problems/status",
      headers: { cookie: manager, origin },
      payload: {
        action: "submit",
        reason: "",
        items: [{ id: valid.id, expectedRevision: valid.revision + 1, expectedRound: 1 }]
      }
    });
    expect(repeat.statusCode).toBe(200);
    expect(repeat.json()).toMatchObject({
      results: [{ id: valid.id, ok: false, code: "CONFLICT" }]
    });
  });

  it("未登录、机器人、无权限和明确拒绝账号均看不到管理端点", async () => {
    const users = createDemoUsers();
    const leader = users.find((user) => user.id === "leader")!;
    const deny: PermissionGrant = {
      permission: "problem.status.change",
      effect: "deny",
      scope: "global"
    };
    const deniedManager: StoredUser = {
      ...leader,
      id: "status-denied",
      grants: [...leader.grants, deny]
    };
    const { app } = await makeApp([...users, deniedManager]);
    const author = await login(app, "author");
    const robot = await login(app, "robot");
    const denied = await login(app, deniedManager.id);
    const payload = {
      action: "submit",
      reason: "",
      items: [{ id: "not-visible", expectedRevision: 1, expectedRound: 0 }]
    };

    for (const cookie of [undefined, author, robot, denied]) {
      const response = await app.inject({
        method: "POST",
        url: "/api/v1/admin/problems/status",
        headers: { ...(cookie === undefined ? {} : { cookie }), origin },
        payload
      });
      expect(response.statusCode).toBe(cookie === undefined ? 401 : 404);
      expect(response.body).not.toContain("not-visible");
    }
  });

  it("拒绝重复题目和缺失的人工决定理由", async () => {
    const { app } = await makeApp();
    const manager = await login(app, "leader");

    for (const payload of [
      {
        action: "submit",
        reason: "",
        items: [
          { id: "same", expectedRevision: 1, expectedRound: 0 },
          { id: "same", expectedRevision: 1, expectedRound: 0 }
        ]
      },
      {
        action: "reject",
        reason: "",
        items: [{ id: "one", expectedRevision: 1, expectedRound: 1 }]
      }
    ]) {
      const response = await app.inject({
        method: "POST",
        url: "/api/v1/admin/problems/status",
        headers: { cookie: manager, origin },
        payload
      });
      expect(response.statusCode).toBe(422);
    }
  });
});
