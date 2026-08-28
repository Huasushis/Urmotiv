import type { PermissionGrant, ProblemTag } from "@urmotiv/contracts";
import type { AnklangIndexAdapter } from "@urmotiv/plugin-anklang";
import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app";
import { createDemoUsers, demoTags } from "../src/demo-data";
import type { StoredUser } from "../src/domain";
import {
  InMemoryDataStore,
  type FrozenFieldEditAuditEvent,
  type ProblemTransaction
} from "../src/repository";

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

interface ProblemResult {
  id: string;
  revision: number;
  reviewRound: number;
  status: string;
  title: string;
  content: { basicStatement: string; basicSolution: string | null };
  capabilities: Record<string, boolean>;
}

class FrozenEditAuditStore extends InMemoryDataStore {
  public readonly frozenFieldEditAudits: FrozenFieldEditAuditEvent[] = [];

  public override runProblemTransaction<T>(
    problemId: string,
    operation: (transaction: ProblemTransaction) => T | Promise<T>
  ): Promise<T> {
    return super.runProblemTransaction(problemId, (transaction) => {
      const wrapped: ProblemTransaction = {
        ...transaction,
        writeFrozenFieldEditAudit: async (event) => {
          this.frozenFieldEditAudits.push(structuredClone(event));
        }
      };
      return operation(wrapped);
    });
  }
}

afterEach(async () => {
  await Promise.all(openApps.splice(0).map((app) => app.close()));
});

function allow(permission: PermissionGrant["permission"]): PermissionGrant {
  return { permission, effect: "allow", scope: "global" };
}

function deny(permission: PermissionGrant["permission"]): PermissionGrant {
  return { permission, effect: "deny", scope: "global" };
}

function demoUser(userId: string): StoredUser {
  const user = createDemoUsers().find((candidate) => candidate.id === userId);
  if (user === undefined) {
    throw new Error(`缺少测试用户 ${userId}`);
  }
  return user;
}

function withFrozenEdit(user: StoredUser, extra: PermissionGrant[] = []): StoredUser {
  return { ...user, grants: [...user.grants, allow("problem.frozen.edit"), ...extra] };
}

function withDeniedFrozenEdit(user: StoredUser): StoredUser {
  return { ...user, grants: [...user.grants, deny("problem.frozen.edit")] };
}

function robotWithFrozenEdit(): StoredUser {
  return { ...demoUser("robot"), grants: [...demoUser("robot").grants, allow("problem.frozen.edit")] };
}

async function makeApp(
  users: StoredUser[],
  anklangIndexAdapter?: AnklangIndexAdapter
): Promise<{ app: FastifyInstance; store: FrozenEditAuditStore }> {
  const store = new FrozenEditAuditStore(users, demoTags);
  const app = await createApp({
    demoAuthEnabled: true,
    store,
    demoUserIds: users.map((user) => user.id),
    ...(anklangIndexAdapter === undefined ? {} : { anklangIndexAdapter })
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
  const setCookie = response.headers["set-cookie"];
  const firstCookie = Array.isArray(setCookie) ? setCookie[0] : setCookie;
  expect(firstCookie).toBeTypeOf("string");
  return (firstCookie as string).split(";", 1)[0] as string;
}

async function createSubmittedProblem(
  app: FastifyInstance,
  authorCookie: string
): Promise<ProblemResult> {
  const created = await app.inject({
    method: "POST",
    url: "/api/v1/problems",
    headers: { cookie: authorCookie, origin },
    payload: {
      title: "冻结字段覆盖测试题",
      type: "traditional",
      tagIds: ["algorithm.implementation"],
      content: {
        basicStatement: "给定一个整数，输出它本身。",
        basicSolution: "直接输出输入即可。"
      }
    }
  });
  expect(created.statusCode).toBe(200);
  const draft = created.json() as ProblemResult;
  const submitted = await app.inject({
    method: "POST",
    url: `/api/v1/problems/${draft.id}/submit`,
    headers: { cookie: authorCookie, origin },
    payload: { expectedRevision: draft.revision }
  });
  expect(submitted.statusCode).toBe(200);
  return submitted.json() as ProblemResult;
}

async function approveProblem(
  app: FastifyInstance,
  reviewerCookie: string,
  memberCookie: string,
  problem: ProblemResult,
  authorCookie: string
): Promise<ProblemResult> {
  for (const cookie of [reviewerCookie, memberCookie]) {
    const review = await app.inject({
      method: "POST",
      url: `/api/v1/problems/${problem.id}/reviews`,
      headers: { cookie, origin },
      payload: {
        verdict: "approve",
        codeforcesDifficulty: 1200,
        qualityLevel: 2,
        originalityLevel: 2,
        thinkingLevel: 2,
        codingLevel: 1,
        tagIds: ["algorithm.implementation"],
        improvements: "补充公开构造的边界说明。",
        expectedRound: problem.reviewRound
      }
    });
    expect(review.statusCode).toBe(200);
  }
  const view = await app.inject({
    method: "GET",
    url: `/api/v1/problems/${problem.id}`,
    headers: { cookie: authorCookie }
  });
  expect(view.statusCode).toBe(200);
  return view.json() as ProblemResult;
}

/* Managers with the dedicated override permission. */
const adminWithFrozenEdit = withFrozenEdit(demoUser("member")); // member has problem.view.all + edit.all
const deniedFrozenEdit = withDeniedFrozenEdit(demoUser("leader")); // leader has broad role grants + explicit deny

describe("冻结字段管理员覆盖", () => {
  it("普通用户修改冻结题面/题解被拒绝，题目名称仍可编辑", async () => {
    const { app } = await makeApp(createDemoUsers());
    const authorCookie = await login(app, "author");
    const memberCookie = await login(app, "member");
    const pending = await createSubmittedProblem(app, authorCookie);

    const titleUpdate = await app.inject({
      method: "PATCH",
      url: `/api/v1/problems/${pending.id}`,
      headers: { cookie: memberCookie, origin },
      payload: { expectedRevision: pending.revision, title: "可继续编辑的名称" }
    });
    expect(titleUpdate.statusCode).toBe(200);

    const blockedStatement = await app.inject({
      method: "PATCH",
      url: `/api/v1/problems/${pending.id}`,
      headers: { cookie: memberCookie, origin },
      payload: {
        expectedRevision: (titleUpdate.json() as ProblemResult).revision,
        content: { ...fullContent, basicStatement: "普通用户不能这样改" }
      }
    });
    expect(blockedStatement.statusCode).toBe(409);

    // 通过状态同样冻结。
    const approved = await approveProblem(
      app,
      await login(app, "reviewer"),
      await login(app, "member"),
      pending,
      authorCookie
    );
    const blockedSolution = await app.inject({
      method: "PATCH",
      url: `/api/v1/problems/${approved.id}`,
      headers: { cookie: memberCookie, origin },
      payload: {
        expectedRevision: approved.revision,
        content: { ...fullContent, basicSolution: "通过后也不能直接改" }
      }
    });
    expect(blockedSolution.statusCode).toBe(409);
  });

  it("具备 problem.frozen.edit 权限的管理员覆盖成功且记录审计元数据", async () => {
    const users = [
      ...createDemoUsers().filter((user) => user.id !== "member"),
      adminWithFrozenEdit
    ];
    const { app, store } = await makeApp(users);
    const authorCookie = await login(app, "author");
    const adminCookie = await login(app, "member");
    const pending = await createSubmittedProblem(app, authorCookie);

    const override = await app.inject({
      method: "POST",
      url: `/api/v1/problems/${pending.id}/frozen-fields`,
      headers: { cookie: adminCookie, origin },
      payload: {
        expectedRevision: pending.revision,
        reason: "紧急修正题面中的公式错误",
        content: { basicStatement: "修正后的基础题面" }
      }
    });
    expect(override.statusCode).toBe(200);
    const result = override.json() as ProblemResult;
    expect(result.content.basicStatement).toBe("修正后的基础题面");
    expect(result.content.basicSolution).toBe("直接输出输入即可。");
    expect(result.revision).toBe(pending.revision + 1);

    expect(store.frozenFieldEditAudits).toEqual([
      expect.objectContaining({
        problemId: pending.id,
        round: pending.reviewRound,
        previousRevision: pending.revision,
        nextRevision: pending.revision + 1,
        fields: ["basicStatement"],
        reason: "紧急修正题面中的公式错误"
      })
    ]);
    // 审计不承载题面或题解内容。
    const auditJson = JSON.stringify(store.frozenFieldEditAudits);
    expect(auditJson).not.toContain("修正后的基础题面");
    expect(auditJson).not.toContain("直接输出输入即可。");
  });

  it("缺少原因的覆盖请求被拒绝", async () => {
    const users = [
      ...createDemoUsers().filter((user) => user.id !== "member"),
      adminWithFrozenEdit
    ];
    const { app } = await makeApp(users);
    const authorCookie = await login(app, "author");
    const adminCookie = await login(app, "member");
    const pending = await createSubmittedProblem(app, authorCookie);

    const noReason = await app.inject({
      method: "POST",
      url: `/api/v1/problems/${pending.id}/frozen-fields`,
      headers: { cookie: adminCookie, origin },
      payload: { expectedRevision: pending.revision, content: { basicStatement: "新题面" } }
    });
    expect(noReason.statusCode).toBe(422);
    expect(noReason.json()).toEqual({
      error: expect.objectContaining({ code: "INVALID_INPUT" })
    });

    const emptyReason = await app.inject({
      method: "POST",
      url: `/api/v1/problems/${pending.id}/frozen-fields`,
      headers: { cookie: adminCookie, origin },
      payload: {
        expectedRevision: pending.revision,
        reason: "   ",
        content: { basicStatement: "新题面" }
      }
    });
    expect(emptyReason.statusCode).toBe(422);

    // 被拒绝的原因没有改变题目内容。
    const view = await app.inject({
      method: "GET",
      url: `/api/v1/problems/${pending.id}`,
      headers: { cookie: authorCookie }
    });
    expect(
      (
        (view.json() as ProblemResult).content.basicStatement
      )
    ).toBe("给定一个整数，输出它本身。");
  });

  it("显式拒绝覆盖角色与单题允许", async () => {
    const users = [
      ...createDemoUsers(),
      deniedFrozenEdit
    ];
    const { app } = await makeApp(users);
    const authorCookie = await login(app, "author");
    const deniedCookie = await login(app, "leader");
    const pending = await createSubmittedProblem(app, authorCookie);

    const deniedOverride = await app.inject({
      method: "POST",
      url: `/api/v1/problems/${pending.id}/frozen-fields`,
      headers: { cookie: deniedCookie, origin },
      payload: {
        expectedRevision: pending.revision,
        reason: "即便有原因，明确拒绝仍然优先",
        content: { basicStatement: "不允许改" }
      }
    });
    expect(deniedOverride.statusCode).toBe(403);
  });

  it("机器人不能获得冻结字段覆盖能力", async () => {
    const robot = robotWithFrozenEdit();
    const users = [...createDemoUsers().filter((u) => u.id !== "robot"), robot];
    const { app } = await makeApp(users);
    const authorCookie = await login(app, "author");
    const robotCookie = await login(app, "robot");
    const pending = await createSubmittedProblem(app, authorCookie);

    const capabilities = await app.inject({
      method: "GET",
      url: `/api/v1/problems/${pending.id}`,
      headers: { cookie: robotCookie }
    });
    expect(capabilities.statusCode).toBe(200);
    expect(
      (capabilities.json() as ProblemResult).capabilities.canEditFrozen
    ).toBe(false);

    const robotOverride = await app.inject({
      method: "POST",
      url: `/api/v1/problems/${pending.id}/frozen-fields`,
      headers: { cookie: robotCookie, origin },
      payload: {
        expectedRevision: pending.revision,
        reason: "机器人不应进入该路径",
        content: { basicStatement: "机器人改的题面" }
      }
    });
    expect(robotOverride.statusCode).toBe(404);
  });

  it("无权查看题目时覆盖按不存在返回", async () => {
    const { app } = await makeApp(createDemoUsers());
    const authorCookie = await login(app, "author");
    const deniedCookie = await login(app, "denied");
    const pending = await createSubmittedProblem(app, authorCookie);

    const hidden = await app.inject({
      method: "POST",
      url: `/api/v1/problems/${pending.id}/frozen-fields`,
      headers: { cookie: deniedCookie, origin },
      payload: {
        expectedRevision: pending.revision,
        reason: "尝试探测不存在的题目",
        content: { basicStatement: "探测" }
      }
    });
    expect(hidden.statusCode).toBe(404);
    expect(hidden.json()).toEqual({
      error: expect.objectContaining({ code: "NOT_FOUND" })
    });
  });

  it("审核前草稿阶段普通用户仍可修改基础题面/基础题解", async () => {
    const { app } = await makeApp(createDemoUsers());
    const authorCookie = await login(app, "author");
    const created = await app.inject({
      method: "POST",
      url: "/api/v1/problems",
      headers: { cookie: authorCookie, origin },
      payload: {
        title: "草稿题目",
        type: "traditional",
        tagIds: ["algorithm.implementation"],
        content: { basicStatement: "初稿题面", basicSolution: "初稿题解" }
      }
    });
    expect(created.statusCode).toBe(200);
    const draft = created.json() as ProblemResult;
    expect(draft.status).toBe("draft");

    const edited = await app.inject({
      method: "PATCH",
      url: `/api/v1/problems/${draft.id}`,
      headers: { cookie: authorCookie, origin },
      payload: {
        expectedRevision: draft.revision,
        content: { basicStatement: "修订后的题面", basicSolution: "修订后的题解" }
      }
    });
    expect(edited.statusCode).toBe(200);
    const result = edited.json() as ProblemResult;
    expect(result.status).toBe("draft");
    expect(result.revision).toBe(draft.revision + 1);
    expect(result.content.basicStatement).toBe("修订后的题面");
    expect(result.content.basicSolution).toBe("修订后的题解");
  });

  it("索引同步只覆盖 submit、可搜索标题和冻结基础题面", async () => {
    const syncs: Array<{
      externalId: string;
      title: string;
      basicStatement: string;
      updatedAt: string;
    }> = [];
    const anklangIndexAdapter: AnklangIndexAdapter = {
      upsert: async (problem) => {
        syncs.push(problem);
      }
    };
    const users = [
      ...createDemoUsers().filter((user) => user.id !== "member"),
      adminWithFrozenEdit
    ];
    const { app } = await makeApp(users, anklangIndexAdapter);
    const authorCookie = await login(app, "author");
    const memberCookie = await login(app, "member");
    const pending = await createSubmittedProblem(app, authorCookie);
    expect(syncs).toHaveLength(1);
    expect(syncs[0]).toMatchObject({
      externalId: pending.id,
      title: pending.title,
      basicStatement: pending.content.basicStatement
    });

    const renamed = await app.inject({
      method: "PATCH",
      url: `/api/v1/problems/${pending.id}`,
      headers: { cookie: memberCookie, origin },
      payload: { expectedRevision: pending.revision, title: "可搜索的新标题" }
    });
    expect(renamed.statusCode).toBe(200);
    expect(syncs).toHaveLength(2);
    expect(syncs[1]).toMatchObject({ externalId: pending.id, title: "可搜索的新标题" });

    const approved = await approveProblem(
      app,
      await login(app, "reviewer"),
      memberCookie,
      renamed.json() as ProblemResult,
      authorCookie
    );
    const frozen = await app.inject({
      method: "POST",
      url: `/api/v1/problems/${approved.id}/frozen-fields`,
      headers: { cookie: memberCookie, origin },
      payload: {
        expectedRevision: approved.revision,
        reason: "修正冻结题面",
        content: { basicStatement: "修正后的可搜索基础题面" }
      }
    });
    expect(frozen.statusCode).toBe(200);
    expect(syncs).toHaveLength(3);
    expect(syncs[2]).toMatchObject({
      externalId: approved.id,
      title: "可搜索的新标题",
      basicStatement: "修正后的可搜索基础题面"
    });

    const solutionOnly = await app.inject({
      method: "POST",
      url: `/api/v1/problems/${approved.id}/frozen-fields`,
      headers: { cookie: memberCookie, origin },
      payload: {
        expectedRevision: (frozen.json() as ProblemResult).revision,
        reason: "只修正冻结题解",
        content: { basicSolution: "修正后的冻结题解" }
      }
    });
    expect(solutionOnly.statusCode).toBe(200);
    expect(syncs).toHaveLength(3);
  });
});
