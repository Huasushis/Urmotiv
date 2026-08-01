import { randomUUID } from "node:crypto";
import type { PermissionGrant } from "@urmotiv/contracts";
import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app";
import { createDemoUsers, demoTags } from "../src/demo-data";
import type { StoredReview, StoredUser } from "../src/domain";
import {
  InMemoryDataStore,
  type ProblemTransaction,
  type ReviewSuggestionAuditEvent
} from "../src/repository";

const origin = "http://localhost:5173";
const openApps: FastifyInstance[] = [];

interface ProblemResult {
  id: string;
  revision: number;
  reviewRound: number;
  status: string;
  codeforcesDifficulty: number | null;
  thinkingLevel: number | null;
  codingLevel: number | null;
  tagIds: string[];
}

interface ReviewSummaryResult {
  reviews: Array<{ id: string; reviewer: { id: string } }>;
  status: string;
}

class ReviewSuggestionAuditStore extends InMemoryDataStore {
  public readonly reviewSuggestionAudits: ReviewSuggestionAuditEvent[] = [];
  public failReviewSuggestionAudit = false;

  public override runProblemTransaction<T>(
    problemId: string,
    operation: (transaction: ProblemTransaction) => T | Promise<T>
  ): Promise<T> {
    return super.runProblemTransaction(problemId, (transaction) => {
      const wrapped: ProblemTransaction = {
        ...transaction,
        writeReviewSuggestionAudit: async (event) => {
          if (this.failReviewSuggestionAudit) {
            throw new Error("模拟审核建议审计写入失败");
          }
          this.reviewSuggestionAudits.push(structuredClone(event));
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

async function makeApp(users: StoredUser[] = createDemoUsers()): Promise<{
  app: FastifyInstance;
  store: ReviewSuggestionAuditStore;
}> {
  const store = new ReviewSuggestionAuditStore(users, demoTags);
  const app = await createApp({
    demoAuthEnabled: true,
    store,
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
  const setCookie = response.headers["set-cookie"];
  const firstCookie = Array.isArray(setCookie) ? setCookie[0] : setCookie;
  expect(firstCookie).toBeTypeOf("string");
  return (firstCookie as string).split(";", 1)[0] as string;
}

async function createApprovedProblem(app: FastifyInstance): Promise<{
  problem: ProblemResult;
  authorCookie: string;
  reviewerCookie: string;
  memberCookie: string;
  countedOpinionIds: string[];
}> {
  const authorCookie = await login(app, "author");
  const reviewerCookie = await login(app, "reviewer");
  const memberCookie = await login(app, "member");
  const created = await app.inject({
    method: "POST",
    url: "/api/v1/problems",
    headers: { cookie: authorCookie, origin },
    payload: {
      title: "公开构造的审核建议测试题",
      type: "traditional",
      tagIds: ["string"],
      codeforcesDifficulty: 800,
      thinkingLevel: 1,
      codingLevel: 5,
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
  const pending = submitted.json() as ProblemResult;

  const first = await app.inject({
    method: "POST",
    url: `/api/v1/problems/${draft.id}/reviews`,
    headers: { cookie: reviewerCookie, origin },
    payload: {
      verdict: "approve",
      codeforcesDifficulty: 1200,
      qualityLevel: 2,
      originalityLevel: 2,
      thinkingLevel: 2,
      codingLevel: 1,
      tagIds: ["algorithm.implementation"],
      improvements: "补充第一个公开构造的边界说明。",
      expectedRound: pending.reviewRound
    }
  });
  expect(first.statusCode).toBe(200);
  const second = await app.inject({
    method: "POST",
    url: `/api/v1/problems/${draft.id}/reviews`,
    headers: { cookie: memberCookie, origin },
    payload: {
      verdict: "approve",
      codeforcesDifficulty: 1300,
      qualityLevel: 3,
      originalityLevel: 3,
      thinkingLevel: 3,
      codingLevel: 2,
      tagIds: ["dynamic-programming", "algorithm.implementation"],
      improvements: "补充第二个公开构造的复杂度说明。",
      expectedRound: pending.reviewRound
    }
  });
  expect(second.statusCode).toBe(200);
  const summary = second.json() as ReviewSummaryResult;
  expect(summary.status).toBe("approved");
  const problemResponse = await app.inject({
    method: "GET",
    url: `/api/v1/problems/${draft.id}`,
    headers: { cookie: authorCookie }
  });
  expect(problemResponse.statusCode).toBe(200);
  return {
    problem: problemResponse.json() as ProblemResult,
    authorCookie,
    reviewerCookie,
    memberCookie,
    countedOpinionIds: summary.reviews.map((review) => review.id)
  };
}

describe("审核建议工作流", () => {
  it("只按关闭轮次冻结的意见聚合，并按规定向上舍入半级和整百", async () => {
    const { app, store } = await makeApp();
    const { problem, authorCookie, countedOpinionIds } = await createApprovedProblem(app);

    const lateReview: StoredReview = {
      id: randomUUID(),
      problemId: problem.id,
      reviewerId: "leader",
      reviewer: { id: "leader", nickname: "组长演示账号", accountType: "human" },
      source: "human",
      verdict: "approve",
      codeforcesDifficulty: 3500,
      qualityLevel: 5,
      originalityLevel: 5,
      thinkingLevel: 5,
      codingLevel: 5,
      tagIds: ["math.number-theory"],
      improvements: "这条关闭轮次后的测试意见不能参与建议。",
      publicComment: "",
      privateNote: "这段私密备注不能进入建议。",
      expectedRound: problem.reviewRound,
      createdAt: "2026-08-01T00:10:00.000Z",
      updatedAt: "2026-08-01T00:10:00.000Z"
    };
    await store.runProblemTransaction(problem.id, (transaction) => {
      transaction.upsertReview(lateReview);
      const current = transaction.getProblem();
      if (current === undefined || current.reviewRoundState === undefined) {
        throw new Error("测试题缺少关闭轮次。");
      }
      expect(transaction.replaceProblem({
        ...current,
        revision: current.revision + 1,
        reviewRoundState: {
          ...current.reviewRoundState,
          countedOpinionIds,
          usedOpinionIds: [lateReview.id]
        }
      }, current.revision)).toBe(true);
    });

    const response = await app.inject({
      method: "GET",
      url: `/api/v1/problems/${problem.id}/review-suggestions`,
      headers: { cookie: authorCookie }
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      round: problem.reviewRound,
      opinionCount: 2,
      current: {
        codeforcesDifficulty: 800,
        thinkingLevel: 1,
        codingLevel: 5,
        tagIds: ["string"]
      },
      suggested: {
        codeforcesDifficulty: 1300,
        thinkingLevel: 3,
        codingLevel: 2,
        tagIds: ["algorithm.implementation", "dynamic-programming"],
        qualityLevel: 3,
        originalityLevel: 3
      },
      canApply: false
    });
    expect(response.body).not.toContain(lateReview.privateNote);
    expect(response.body).not.toContain(lateReview.id);
  });

  it("写回只应用明确选择的字段，并记录不含内容和值的最小审计", async () => {
    const { app, store } = await makeApp();
    const { problem } = await createApprovedProblem(app);
    const leaderCookie = await login(app, "leader");

    const readable = await app.inject({
      method: "GET",
      url: `/api/v1/problems/${problem.id}/review-suggestions`,
      headers: { cookie: leaderCookie }
    });
    expect(readable.statusCode).toBe(200);
    expect(readable.json()).toEqual(expect.objectContaining({ canApply: true }));

    const applied = await app.inject({
      method: "POST",
      url: `/api/v1/problems/${problem.id}/review-suggestions/apply`,
      headers: { cookie: leaderCookie, origin },
      payload: {
        expectedRound: problem.reviewRound,
        expectedRevision: problem.revision,
        fields: ["codeforcesDifficulty", "thinkingLevel", "tagIds"]
      }
    });
    expect(applied.statusCode).toBe(200);
    expect(applied.json()).toEqual(expect.objectContaining({
      revision: problem.revision + 1,
      codeforcesDifficulty: 1300,
      thinkingLevel: 3,
      codingLevel: 5,
      tagIds: ["algorithm.implementation", "dynamic-programming"]
    }));
    expect(store.reviewSuggestionAudits).toHaveLength(1);
    expect(store.reviewSuggestionAudits[0]).toEqual({
      actorUserId: "leader",
      requestId: expect.any(String),
      problemId: problem.id,
      round: problem.reviewRound,
      previousRevision: problem.revision,
      nextRevision: problem.revision + 1,
      fields: ["codeforcesDifficulty", "thinkingLevel", "tagIds"],
      opinionCount: 2
    });
    expect(Object.keys(store.reviewSuggestionAudits[0] ?? {}).sort()).toEqual([
      "actorUserId",
      "fields",
      "nextRevision",
      "opinionCount",
      "previousRevision",
      "problemId",
      "requestId",
      "round"
    ]);
    const serializedAudit = JSON.stringify(store.reviewSuggestionAudits[0]);
    expect(serializedAudit).not.toContain("algorithm.implementation");
    expect(serializedAudit).not.toContain("privateNote");
  });

  it("无权用户得到 404，缺少任一确认权限、明确拒绝和机器人都得到 403", async () => {
    const leader = demoUser("leader");
    const statusDenied: StoredUser = {
      ...leader,
      id: "status-denied",
      nickname: "明确拒绝状态权限",
      grants: [...leader.grants, deny("problem.status.change")]
    };
    const editDenied: StoredUser = {
      ...leader,
      id: "edit-denied",
      nickname: "明确拒绝编辑权限",
      grants: [...leader.grants, deny("problem.edit.all")]
    };
    const privilegedRobot: StoredUser = {
      ...leader,
      id: "privileged-robot",
      nickname: "误授组长权限的机器人",
      accountType: "robot"
    };
    const viewOnlyStatusUser: StoredUser = {
      ...demoUser("reviewer"),
      id: "status-only",
      nickname: "只有状态权限",
      grants: [...demoUser("reviewer").grants, allow("problem.status.change")]
    };
    const users = [
      ...createDemoUsers(),
      statusDenied,
      editDenied,
      privilegedRobot,
      viewOnlyStatusUser
    ];
    const { app } = await makeApp(users);
    const { problem, reviewerCookie } = await createApprovedProblem(app);
    const payload = {
      expectedRound: problem.reviewRound,
      expectedRevision: problem.revision,
      fields: ["codingLevel"]
    };

    const hiddenCookie = await login(app, "denied");
    const hiddenRead = await app.inject({
      method: "GET",
      url: `/api/v1/problems/${problem.id}/review-suggestions`,
      headers: { cookie: hiddenCookie }
    });
    expect(hiddenRead.statusCode).toBe(404);
    const hiddenApply = await app.inject({
      method: "POST",
      url: `/api/v1/problems/${problem.id}/review-suggestions/apply`,
      headers: { cookie: hiddenCookie, origin },
      payload
    });
    expect(hiddenApply.statusCode).toBe(404);
    expect(hiddenApply.body).not.toContain("审核建议测试题");

    for (const cookie of [
      reviewerCookie,
      await login(app, statusDenied.id),
      await login(app, editDenied.id),
      await login(app, privilegedRobot.id),
      await login(app, viewOnlyStatusUser.id)
    ]) {
      const response = await app.inject({
        method: "POST",
        url: `/api/v1/problems/${problem.id}/review-suggestions/apply`,
        headers: { cookie, origin },
        payload
      });
      expect(response.statusCode).toBe(403);
    }
  });

  it("拒绝过期轮次、过期修订、状态变化和客户端伪造的值或意见编号", async () => {
    const { app } = await makeApp();
    const { problem, authorCookie } = await createApprovedProblem(app);
    const leaderCookie = await login(app, "leader");
    const basePayload = {
      expectedRound: problem.reviewRound,
      expectedRevision: problem.revision,
      fields: ["codingLevel"]
    };
    for (const payload of [
      { ...basePayload, expectedRound: problem.reviewRound + 1 },
      { ...basePayload, expectedRevision: problem.revision + 1 }
    ]) {
      const response = await app.inject({
        method: "POST",
        url: `/api/v1/problems/${problem.id}/review-suggestions/apply`,
        headers: { cookie: leaderCookie, origin },
        payload
      });
      expect(response.statusCode).toBe(409);
    }

    for (const payload of [
      { ...basePayload, fields: [] },
      { ...basePayload, fields: ["codingLevel", "codingLevel"] },
      { ...basePayload, fields: ["qualityLevel"] },
      { ...basePayload, usedOpinionIds: ["forged-opinion"] },
      { ...basePayload, suggested: { codingLevel: 5 } }
    ]) {
      const response = await app.inject({
        method: "POST",
        url: `/api/v1/problems/${problem.id}/review-suggestions/apply`,
        headers: { cookie: leaderCookie, origin },
        payload
      });
      expect(response.statusCode).toBe(422);
    }

    const withdrawn = await app.inject({
      method: "POST",
      url: `/api/v1/problems/${problem.id}/withdraw`,
      headers: { cookie: authorCookie, origin },
      payload: { expectedRevision: problem.revision, reason: "测试状态变化。" }
    });
    expect(withdrawn.statusCode).toBe(200);
    const afterStatusChange = await app.inject({
      method: "POST",
      url: `/api/v1/problems/${problem.id}/review-suggestions/apply`,
      headers: { cookie: leaderCookie, origin },
      payload: basePayload
    });
    expect(afterStatusChange.statusCode).toBe(409);
  });

  it("冻结意见编号缺失时整份建议不可用，不能按剩余意见部分计算", async () => {
    const { app, store } = await makeApp();
    const { problem, authorCookie, countedOpinionIds } = await createApprovedProblem(app);
    await store.runProblemTransaction(problem.id, (transaction) => {
      const current = transaction.getProblem();
      if (current === undefined || current.reviewRoundState === undefined) {
        throw new Error("测试题缺少关闭轮次。");
      }
      expect(transaction.replaceProblem({
        ...current,
        revision: current.revision + 1,
        reviewRoundState: {
          ...current.reviewRoundState,
          countedOpinionIds: [countedOpinionIds[0] as string, randomUUID()]
        }
      }, current.revision)).toBe(true);
    });

    const response = await app.inject({
      method: "GET",
      url: `/api/v1/problems/${problem.id}/review-suggestions`,
      headers: { cookie: authorCookie }
    });
    expect(response.statusCode).toBe(409);
  });

  it("审计失败时题目修订和字段写回整体回滚", async () => {
    const { app, store } = await makeApp();
    const { problem } = await createApprovedProblem(app);
    const leaderCookie = await login(app, "leader");
    store.failReviewSuggestionAudit = true;

    const failed = await app.inject({
      method: "POST",
      url: `/api/v1/problems/${problem.id}/review-suggestions/apply`,
      headers: { cookie: leaderCookie, origin },
      payload: {
        expectedRound: problem.reviewRound,
        expectedRevision: problem.revision,
        fields: ["codeforcesDifficulty", "tagIds"]
      }
    });
    expect(failed.statusCode).toBe(500);
    expect(failed.json()).toEqual({
      error: expect.objectContaining({ code: "INTERNAL_ERROR" })
    });
    expect(failed.body).not.toContain("模拟审核建议审计写入失败");
    expect(store.reviewSuggestionAudits).toEqual([]);

    const unchanged = await app.inject({
      method: "GET",
      url: `/api/v1/problems/${problem.id}`,
      headers: { cookie: leaderCookie }
    });
    expect(unchanged.statusCode).toBe(200);
    expect(unchanged.json()).toEqual(expect.objectContaining({
      revision: problem.revision,
      codeforcesDifficulty: 800,
      tagIds: ["string"]
    }));
  });
});
