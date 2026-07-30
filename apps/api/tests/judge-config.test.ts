import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import type { PermissionGrant, ProblemJudgeConfig } from "@urmotiv/contracts";
import { createApp } from "../src/app";
import { demoTags } from "../src/demo-data";
import type { StoredUser } from "../src/domain";
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

const judgeConfig: ProblemJudgeConfig = {
  version: 1,
  limits: { timeMs: 1000, memoryMiB: 256 },
  scoring: { total: 100, subtaskMode: "sum" },
  subtasks: [
    { id: 1, score: 40, method: "sum", dependsOn: [] },
    { id: 2, score: 60, method: "sum", dependsOn: [1] }
  ],
  testcases: [
    { id: "case-1", input: "data/001.in", output: "data/001.out", subtaskId: 1, score: 40 },
    { id: "case-2", input: "data/002.in", output: "data/002.out", subtaskId: 2, score: 60 }
  ],
  checker: { type: "standard" }
};

function grant(permission: PermissionGrant["permission"], scope: PermissionGrant["scope"] = "global"): PermissionGrant {
  return { permission, effect: "allow", scope };
}

function user(id: string, grants: PermissionGrant[]): StoredUser {
  return {
    id,
    nickname: id,
    accountType: "human",
    disabled: false,
    roles: [],
    grants,
    isRoot: false
  };
}

function createUsers(): StoredUser[] {
  return [
    user("editor", [
      grant("auth.login"),
      grant("problem.create"),
      grant("problem.view.own", "own"),
      grant("problem.edit.own", "own")
    ]),
    user("writer", [
      grant("auth.login"),
      grant("problem.view.all"),
      grant("problem.edit.all"),
      grant("problem.testdata.read"),
      grant("problem.testdata.write")
    ]),
    user("viewer", [grant("auth.login"), grant("problem.view.all")])
  ];
}

async function makeApp(): Promise<FastifyInstance> {
  const users = createUsers();
  const app = await createApp({
    store: new InMemoryDataStore(users, demoTags),
    demoAuthEnabled: true,
    demoUserIds: users.map((item) => item.id)
  });
  openApps.push(app);
  return app;
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
  const cookie = (Array.isArray(setCookie) ? setCookie[0] : setCookie)?.split(";", 1)[0];
  if (cookie === undefined) {
    throw new Error("登录响应缺少会话 Cookie。");
  }
  return cookie;
}

async function createProblem(app: FastifyInstance, cookie: string): Promise<{ id: string; revision: number }> {
  const response = await app.inject({
    method: "POST",
    url: "/api/v1/problems",
    headers: { cookie, origin },
    payload: {
      title: "评测配置权限测试题",
      type: "traditional",
      tagIds: ["algorithm.implementation"],
      content: fullContent
    }
  });
  expect(response.statusCode).toBe(200);
  return response.json() as { id: string; revision: number };
}

afterEach(async () => {
  await Promise.all(openApps.splice(0).map((app) => app.close()));
});

describe("题目评测配置 API", () => {
  it("允许有测试数据写入权限的成员保存配置，普通编辑者不能修改，未获读取权限的查看者看不到配置", async () => {
    const app = await makeApp();
    const editorCookie = await login(app, "editor");
    const writerCookie = await login(app, "writer");
    const viewerCookie = await login(app, "viewer");
    const problem = await createProblem(app, editorCookie);

    const saved = await app.inject({
      method: "PATCH",
      url: `/api/v1/problems/${problem.id}`,
      headers: { cookie: writerCookie, origin },
      payload: { expectedRevision: problem.revision, judgeConfig }
    });
    expect(saved.statusCode).toBe(200);
    expect(saved.json()).toEqual(
      expect.objectContaining({
        revision: 2,
        judgeConfig,
        capabilities: expect.objectContaining({ canReadTestdata: true, canWriteTestdata: true })
      })
    );

    const writerRead = await app.inject({
      method: "GET",
      url: `/api/v1/problems/${problem.id}`,
      headers: { cookie: writerCookie }
    });
    expect(writerRead.statusCode).toBe(200);
    expect(writerRead.json()).toEqual(expect.objectContaining({ judgeConfig }));

    const editorUpdate = await app.inject({
      method: "PATCH",
      url: `/api/v1/problems/${problem.id}`,
      headers: { cookie: editorCookie, origin },
      payload: {
        expectedRevision: 2,
        judgeConfig: {
          ...judgeConfig,
          limits: { ...judgeConfig.limits, timeMs: 2000 }
        }
      }
    });
    expect(editorUpdate.statusCode).toBe(403);
    expect(editorUpdate.json()).toEqual({ error: expect.objectContaining({ code: "FORBIDDEN" }) });

    const viewerRead = await app.inject({
      method: "GET",
      url: `/api/v1/problems/${problem.id}`,
      headers: { cookie: viewerCookie }
    });
    expect(viewerRead.statusCode).toBe(200);
    expect(viewerRead.json()).toEqual(
      expect.objectContaining({
        judgeConfig: null,
        capabilities: expect.objectContaining({ canReadTestdata: false, canWriteTestdata: false })
      })
    );
  });

  it("拒绝子任务总分与总分不一致的配置，并返回对应字段错误", async () => {
    const app = await makeApp();
    const editorCookie = await login(app, "editor");
    const writerCookie = await login(app, "writer");
    const problem = await createProblem(app, editorCookie);

    const invalid = await app.inject({
      method: "PATCH",
      url: `/api/v1/problems/${problem.id}`,
      headers: { cookie: writerCookie, origin },
      payload: {
        expectedRevision: problem.revision,
        judgeConfig: {
          ...judgeConfig,
          subtasks: [{ id: 1, score: 99, method: "sum", dependsOn: [] }]
        }
      }
    });
    expect(invalid.statusCode).toBe(422);
    expect(invalid.json()).toEqual({
      error: expect.objectContaining({
        code: "INVALID_INPUT",
        fieldErrors: expect.objectContaining({ "judgeConfig.scoring.total": expect.any(Array) })
      })
    });
  });
});
