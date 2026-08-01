import { randomUUID } from "node:crypto";
import type { PermissionGrant } from "@urmotiv/contracts";
import { defaultReviewRuleId } from "@urmotiv/plugin-review-default";
import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { createApp } from "../src/app";
import { createBuiltinPluginDefinitions } from "../src/builtin-plugins";
import { createDemoUsers, demoTags } from "../src/demo-data";
import type { StoredUser } from "../src/domain";
import {
  InMemoryPluginStore,
  TrustedPluginHost,
  type TrustedPluginDefinition
} from "../src/plugin-host";
import { InMemoryDataStore } from "../src/repository";

const origin = "http://localhost:5173";
const defaultPluginId = "org.ustc.urmotiv.review-default";
const failingPluginId = "org.example.failing-review";
const failingRuleId = `${failingPluginId}.rule`;
const changingPluginId = "org.example.read-changing-review";
const changingRuleId = `${changingPluginId}.rule`;

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

const openApps: FastifyInstance[] = [];

interface ProblemResult {
  id: string;
  revision: number;
  reviewRound: number;
  status: string;
}

interface ReviewSummaryResult {
  round: number;
  reviews: Array<{ id: string; verdict: string; reviewer: { id: string } }>;
  approvals: number;
  blockingReviews: number;
  requiredApprovals: number | null;
  status: string;
  ruleId: string;
  decisionAvailable: boolean;
  decisionReason: string | null;
  decisionSource: "rule" | "manual" | "withdrawal" | null;
}

class UserListOverrideStore extends InMemoryDataStore {
  private currentUsers: StoredUser[] | undefined;

  public setUsersForReviewDecision(users: StoredUser[]): void {
    this.currentUsers = structuredClone(users);
  }

  public override async listUsers(): Promise<StoredUser[]> {
    return this.currentUsers === undefined
      ? super.listUsers()
      : structuredClone(this.currentUsers);
  }
}

afterEach(async () => {
  await Promise.all(openApps.splice(0).map((app) => app.close()));
});

async function makeApp(options: {
  users?: StoredUser[];
  definitions?: readonly TrustedPluginDefinition[];
} = {}): Promise<{
  app: FastifyInstance;
  host: TrustedPluginHost;
  store: UserListOverrideStore;
  users: StoredUser[];
}> {
  const users = options.users ?? createDemoUsers();
  const store = new UserListOverrideStore(users, demoTags);
  const host = new TrustedPluginHost(
    options.definitions ?? createBuiltinPluginDefinitions(),
    new InMemoryPluginStore()
  );
  const app = await createApp({
    demoAuthEnabled: true,
    store,
    demoUserIds: users.map((user) => user.id),
    pluginHost: host
  });
  openApps.push(app);
  return { app, host, store, users };
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

async function createDraft(app: FastifyInstance, cookie: string): Promise<ProblemResult> {
  const response = await app.inject({
    method: "POST",
    url: "/api/v1/problems",
    headers: { cookie, origin },
    payload: {
      title: "审核规则测试题",
      type: "traditional",
      tagIds: ["algorithm.implementation"],
      content: fullContent
    }
  });
  expect(response.statusCode).toBe(200);
  return response.json() as ProblemResult;
}

async function submitProblem(
  app: FastifyInstance,
  cookie: string,
  problem: Pick<ProblemResult, "id" | "revision">
): Promise<ProblemResult> {
  const response = await app.inject({
    method: "POST",
    url: `/api/v1/problems/${problem.id}/submit`,
    headers: { cookie, origin },
    payload: { expectedRevision: problem.revision }
  });
  expect(response.statusCode).toBe(200);
  return response.json() as ProblemResult;
}

function reviewInput(
  expectedRound: number,
  verdict: "approve" | "request_changes" | "reject" = "approve"
): Record<string, unknown> {
  return {
    verdict,
    codeforcesDifficulty: 1200,
    qualityLevel: 3,
    thinkingLevel: 2,
    codingLevel: 1,
    tagIds: ["algorithm.implementation"],
    improvements: "请补充边界情况说明。",
    expectedRound
  };
}

async function submitReview(
  app: FastifyInstance,
  cookie: string,
  problemId: string,
  round: number,
  verdict: "approve" | "request_changes" | "reject" = "approve"
) {
  return app.inject({
    method: "POST",
    url: `/api/v1/problems/${problemId}/reviews`,
    headers: { cookie, origin },
    payload: reviewInput(round, verdict)
  });
}

async function updatePolicy(
  app: FastifyInstance,
  leaderCookie: string,
  expectedRevision: number,
  settings: Record<string, unknown>,
  ruleId = defaultReviewRuleId
): Promise<{ revision: number }> {
  const response = await app.inject({
    method: "PATCH",
    url: "/api/v1/review-policy",
    headers: { cookie: leaderCookie, origin },
    payload: { ruleId, settings, expectedRevision }
  });
  expect(response.statusCode).toBe(200);
  return response.json() as { revision: number };
}

function demoUser(userId: string): StoredUser {
  const user = createDemoUsers().find((candidate) => candidate.id === userId);
  if (user === undefined) {
    throw new Error(`测试用户 ${userId} 不存在。`);
  }
  return user;
}

function deny(permission: PermissionGrant["permission"]): PermissionGrant {
  return { permission, effect: "deny", scope: "global" };
}

function failingReviewPlugin(): TrustedPluginDefinition {
  return {
    source: "builtin:test-failing-review",
    initialState: "enabled",
    requiresRestart: false,
    manifest: {
      id: failingPluginId,
      name: "故障审核规则测试插件",
      version: "1.0.0",
      apiVersion: "1",
      permissions: []
    },
    reviewRuleSettingsSchemas: {
      [failingRuleId]: {
        type: "object",
        additionalProperties: false,
        properties: {}
      }
    },
    registerHooks: (registry) => {
      registry.registerReviewDecisionRule({
        id: failingRuleId,
        displayName: "故意失败的审核规则",
        supportedReviewItemTypes: [],
        settingsSchema: z.object({}).strict(),
        evaluate: async () => {
          throw new Error("测试规则内部错误不应出现在响应中");
        }
      });
    }
  };
}

function malformedReviewPlugin(): TrustedPluginDefinition {
  return {
    source: "builtin:test-malformed-review",
    initialState: "enabled",
    requiresRestart: false,
    manifest: {
      id: "org.example.malformed-review",
      name: "返回异常结果的审核规则测试插件",
      version: "1.0.0",
      apiVersion: "1",
      permissions: []
    },
    reviewRuleSettingsSchemas: {
      "org.example.malformed-review.rule": {
        type: "object",
        additionalProperties: false,
        properties: {}
      }
    },
    registerHooks: (registry) => {
      registry.registerReviewDecisionRule({
        id: "org.example.malformed-review.rule",
        displayName: "返回异常结果的审核规则",
        supportedReviewItemTypes: [],
        settingsSchema: z.object({}).strict(),
        evaluate: () => ({ decision: "approve" } as never)
      });
    }
  };
}

function timeoutReviewPlugin(): TrustedPluginDefinition {
  return {
    source: "builtin:test-timeout-review",
    initialState: "enabled",
    requiresRestart: false,
    manifest: {
      id: "org.example.timeout-review",
      name: "超时审核规则测试插件",
      version: "1.0.0",
      apiVersion: "1",
      permissions: []
    },
    reviewRuleSettingsSchemas: {
      "org.example.timeout-review.rule": {
        type: "object",
        additionalProperties: false,
        properties: {}
      }
    },
    registerHooks: (registry) => {
      registry.registerReviewDecisionRule({
        id: "org.example.timeout-review.rule",
        displayName: "超时审核规则",
        supportedReviewItemTypes: [],
        settingsSchema: z.object({}).strict(),
        evaluate: () => new Promise(() => {})
      });
    }
  };
}

function readChangingReviewPlugin(): TrustedPluginDefinition {
  let evaluationCount = 0;
  return {
    source: "builtin:test-read-changing-review",
    initialState: "enabled",
    requiresRestart: false,
    manifest: {
      id: changingPluginId,
      name: "读取时结果变化的审核规则测试插件",
      version: "1.0.0",
      apiVersion: "1",
      permissions: []
    },
    reviewRuleSettingsSchemas: {
      [changingRuleId]: {
        type: "object",
        additionalProperties: false,
        properties: {}
      }
    },
    registerHooks: (registry) => {
      registry.registerReviewDecisionRule({
        id: changingRuleId,
        displayName: "读取时结果变化的审核规则",
        supportedReviewItemTypes: [],
        settingsSchema: z.object({}).strict(),
        evaluate: (input) => {
          evaluationCount += 1;
          const usedOpinionIds = input.opinions
            .filter((opinion) => opinion.reviewerCanReview)
            .map((opinion) => opinion.id);
          return {
            decision: evaluationCount === 1 ? "pending" : "approve",
            usedOpinionIds,
            usedReviewItemIds: [],
            reason: evaluationCount === 1 ? "继续等待。" : "读取时临时判定通过。"
          };
        }
      });
    }
  };
}

async function expectUnavailableReviewWasRolledBack(
  app: FastifyInstance,
  problem: ProblemResult,
  authorCookie: string,
  reviewerCookie: string,
  leaderCookie: string
): Promise<void> {
  const failed = await submitReview(
    app,
    reviewerCookie,
    problem.id,
    problem.reviewRound
  );
  expect(failed.statusCode).toBe(503);
  expect(failed.json()).toEqual({
    error: expect.objectContaining({ code: "REVIEW_RULE_UNAVAILABLE" })
  });
  expect(failed.body).not.toContain("测试规则内部错误");

  const summary = await app.inject({
    method: "GET",
    url: `/api/v1/problems/${problem.id}/reviews`,
    headers: { cookie: leaderCookie }
  });
  expect(summary.statusCode).toBe(200);
  expect(summary.json()).toEqual(expect.objectContaining({
    status: "waiting",
    decisionAvailable: false,
    reviews: []
  }));

  const storedProblem = await app.inject({
    method: "GET",
    url: `/api/v1/problems/${problem.id}`,
    headers: { cookie: authorCookie }
  });
  expect(storedProblem.statusCode).toBe(200);
  expect(storedProblem.json()).toEqual(expect.objectContaining({
    status: "pending_review",
    revision: problem.revision
  }));
}

async function withdraw(
  app: FastifyInstance,
  cookie: string,
  problem: Pick<ProblemResult, "id" | "revision">,
  reason: string
) {
  return app.inject({
    method: "POST",
    url: `/api/v1/problems/${problem.id}/withdraw`,
    headers: { cookie, origin },
    payload: { expectedRevision: problem.revision, reason }
  });
}

describe("可配置审核决定流程", () => {
  it("只有人类最终决定者能管理审核策略，明确拒绝优先，并发修改只接受一次", async () => {
    const leader = demoUser("leader");
    const explicitlyDenied: StoredUser = {
      ...leader,
      id: "status-denied",
      nickname: "明确拒绝最终决定权",
      grants: [...leader.grants, deny("problem.status.change")]
    };
    const privilegedRobot: StoredUser = {
      ...leader,
      id: "privileged-robot",
      nickname: "误授最终决定权的机器人",
      accountType: "robot"
    };
    const { app } = await makeApp({
      users: [...createDemoUsers(), explicitlyDenied, privilegedRobot]
    });
    const leaderCookie = await login(app, leader.id);
    const reviewerCookie = await login(app, "reviewer");
    const deniedCookie = await login(app, explicitlyDenied.id);
    const robotCookie = await login(app, privilegedRobot.id);

    for (const cookie of [reviewerCookie, deniedCookie, robotCookie]) {
      const read = await app.inject({
        method: "GET",
        url: "/api/v1/review-policy",
        headers: { cookie }
      });
      expect(read.statusCode).toBe(403);

      const write = await app.inject({
        method: "PATCH",
        url: "/api/v1/review-policy",
        headers: { cookie, origin },
        payload: {
          ruleId: defaultReviewRuleId,
          settings: {},
          expectedRevision: 1
        }
      });
      expect(write.statusCode).toBe(403);
    }

    const initial = await app.inject({
      method: "GET",
      url: "/api/v1/review-policy",
      headers: { cookie: leaderCookie }
    });
    expect(initial.statusCode).toBe(200);
    expect(initial.json()).toEqual(expect.objectContaining({
      selectedRuleId: defaultReviewRuleId,
      revision: 1,
      selectedRuleAvailable: true
    }));

    const writes = await Promise.all([
      app.inject({
        method: "PATCH",
        url: "/api/v1/review-policy",
        headers: { cookie: leaderCookie, origin },
        payload: {
          ruleId: defaultReviewRuleId,
          settings: {
            requiredApprovals: 1,
            maximumRejections: 0,
            countRobotReviews: false
          },
          expectedRevision: 1
        }
      }),
      app.inject({
        method: "PATCH",
        url: "/api/v1/review-policy",
        headers: { cookie: leaderCookie, origin },
        payload: {
          ruleId: defaultReviewRuleId,
          settings: {
            requiredApprovals: 3,
            maximumRejections: 0,
            countRobotReviews: false
          },
          expectedRevision: 1
        }
      })
    ]);
    expect(writes.map((response) => response.statusCode).sort()).toEqual([200, 409]);

    const afterConcurrentWrites = await app.inject({
      method: "GET",
      url: "/api/v1/review-policy",
      headers: { cookie: leaderCookie }
    });
    expect(afterConcurrentWrites.json()).toEqual(expect.objectContaining({ revision: 2 }));
  });

  it("拒绝不符合要求的规则设置且不增加策略版本", async () => {
    const { app } = await makeApp();
    const leaderCookie = await login(app, "leader");
    const invalid = await app.inject({
      method: "PATCH",
      url: "/api/v1/review-policy",
      headers: { cookie: leaderCookie, origin },
      payload: {
        ruleId: defaultReviewRuleId,
        settings: { requiredApprovals: 0 },
        expectedRevision: 1
      }
    });
    expect(invalid.statusCode).toBe(422);
    expect(invalid.json()).toEqual({
      error: expect.objectContaining({ code: "REVIEW_RULE_UNAVAILABLE" })
    });

    const unchanged = await app.inject({
      method: "GET",
      url: "/api/v1/review-policy",
      headers: { cookie: leaderCookie }
    });
    expect(unchanged.json()).toEqual(expect.objectContaining({ revision: 1 }));
  });

  it("每轮保存提交时的规则设置，之后修改全局策略不影响正在审核的题目", async () => {
    const { app } = await makeApp();
    const authorCookie = await login(app, "author");
    const reviewerCookie = await login(app, "reviewer");
    const leaderCookie = await login(app, "leader");

    const oldRound = await submitProblem(app, authorCookie, await createDraft(app, authorCookie));
    await updatePolicy(app, leaderCookie, 1, {
      requiredApprovals: 1,
      maximumRejections: 0,
      countRobotReviews: false
    });

    const oldRoundReview = await submitReview(
      app,
      reviewerCookie,
      oldRound.id,
      oldRound.reviewRound
    );
    expect(oldRoundReview.statusCode).toBe(200);
    expect(oldRoundReview.json()).toEqual(expect.objectContaining({
      status: "waiting",
      approvals: 1,
      requiredApprovals: 2
    }));

    const newRound = await submitProblem(app, authorCookie, await createDraft(app, authorCookie));
    const newRoundReview = await submitReview(
      app,
      reviewerCookie,
      newRound.id,
      newRound.reviewRound
    );
    expect(newRoundReview.statusCode).toBe(200);
    expect(newRoundReview.json()).toEqual(expect.objectContaining({
      status: "approved",
      approvals: 1,
      requiredApprovals: 1,
      decisionSource: "rule"
    }));
  });

  it("读取未关闭轮次时即使规则临时返回通过，仍保持等待且不修改题目", async () => {
    const { app } = await makeApp({
      definitions: [...createBuiltinPluginDefinitions(), readChangingReviewPlugin()]
    });
    const authorCookie = await login(app, "author");
    const reviewerCookie = await login(app, "reviewer");
    const leaderCookie = await login(app, "leader");
    await updatePolicy(app, leaderCookie, 1, {}, changingRuleId);
    const problem = await submitProblem(app, authorCookie, await createDraft(app, authorCookie));

    const submitted = await submitReview(
      app,
      reviewerCookie,
      problem.id,
      problem.reviewRound
    );
    expect(submitted.statusCode).toBe(200);
    expect(submitted.json()).toEqual(expect.objectContaining({ status: "waiting" }));

    const summary = await app.inject({
      method: "GET",
      url: `/api/v1/problems/${problem.id}/reviews`,
      headers: { cookie: leaderCookie }
    });
    expect(summary.statusCode).toBe(200);
    expect(summary.json()).toEqual(expect.objectContaining({
      status: "waiting",
      approvals: 1,
      decisionAvailable: true,
      decisionReason: null,
      decisionSource: null
    }));

    const storedProblem = await app.inject({
      method: "GET",
      url: `/api/v1/problems/${problem.id}`,
      headers: { cookie: authorCookie }
    });
    expect(storedProblem.json()).toEqual(expect.objectContaining({
      status: "pending_review",
      revision: problem.revision
    }));
  });

  it("默认规则在两个不同的人通过后关闭审核轮次", async () => {
    const { app } = await makeApp();
    const authorCookie = await login(app, "author");
    const reviewerCookie = await login(app, "reviewer");
    const memberCookie = await login(app, "member");
    const problem = await submitProblem(app, authorCookie, await createDraft(app, authorCookie));

    const first = await submitReview(app, reviewerCookie, problem.id, problem.reviewRound);
    expect(first.statusCode).toBe(200);
    expect(first.json()).toEqual(expect.objectContaining({
      status: "waiting",
      approvals: 1
    }));

    const second = await submitReview(app, memberCookie, problem.id, problem.reviewRound);
    expect(second.statusCode).toBe(200);
    expect(second.json()).toEqual(expect.objectContaining({
      status: "approved",
      approvals: 2,
      blockingReviews: 0,
      decisionSource: "rule"
    }));
  });

  it("默认规则在一份有效的不通过意见后拒绝题目", async () => {
    const { app } = await makeApp();
    const authorCookie = await login(app, "author");
    const reviewerCookie = await login(app, "reviewer");
    const problem = await submitProblem(app, authorCookie, await createDraft(app, authorCookie));

    const rejected = await submitReview(
      app,
      reviewerCookie,
      problem.id,
      problem.reviewRound,
      "reject"
    );
    expect(rejected.statusCode).toBe(200);
    expect(rejected.json()).toEqual(expect.objectContaining({
      status: "rejected",
      approvals: 0,
      blockingReviews: 1,
      decisionSource: "rule"
    }));
  });

  it("机器人是否计票由当前轮次快照决定", async () => {
    const { app } = await makeApp();
    const authorCookie = await login(app, "author");
    const robotCookie = await login(app, "robot");
    const leaderCookie = await login(app, "leader");

    await updatePolicy(app, leaderCookie, 1, {
      requiredApprovals: 1,
      maximumRejections: 0,
      countRobotReviews: false
    });
    const humansOnlyRound = await submitProblem(
      app,
      authorCookie,
      await createDraft(app, authorCookie)
    );
    await updatePolicy(app, leaderCookie, 2, {
      requiredApprovals: 1,
      maximumRejections: 0,
      countRobotReviews: true
    });

    const ignoredRobot = await submitReview(
      app,
      robotCookie,
      humansOnlyRound.id,
      humansOnlyRound.reviewRound
    );
    expect(ignoredRobot.statusCode).toBe(200);
    expect(ignoredRobot.json()).toEqual(expect.objectContaining({
      status: "waiting",
      approvals: 0,
      reviews: [expect.objectContaining({ source: "fermata" })]
    }));

    const robotRound = await submitProblem(app, authorCookie, await createDraft(app, authorCookie));
    const countedRobot = await submitReview(
      app,
      robotCookie,
      robotRound.id,
      robotRound.reviewRound
    );
    expect(countedRobot.statusCode).toBe(200);
    expect(countedRobot.json()).toEqual(expect.objectContaining({
      status: "approved",
      approvals: 1,
      decisionSource: "rule"
    }));
  });

  it("人工终审固定显示计数时仍遵守规则是否计入机器人意见", async () => {
    for (const countRobotReviews of [false, true]) {
      const { app, store } = await makeApp();
      const authorCookie = await login(app, "author");
      const robotCookie = await login(app, "robot");
      const leaderCookie = await login(app, "leader");
      await updatePolicy(app, leaderCookie, 1, {
        requiredApprovals: 2,
        maximumRejections: 0,
        countRobotReviews
      });
      const problem = await submitProblem(app, authorCookie, await createDraft(app, authorCookie));
      const robotReview = await submitReview(
        app,
        robotCookie,
        problem.id,
        problem.reviewRound
      );
      expect(robotReview.statusCode).toBe(200);
      const robotReviewId = (robotReview.json() as ReviewSummaryResult).reviews[0]?.id;

      const decided = await app.inject({
        method: "POST",
        url: `/api/v1/problems/${problem.id}/review-decision`,
        headers: { cookie: leaderCookie, origin },
        payload: {
          decision: "approve",
          reason: "组长已人工确认。",
          expectedRound: problem.reviewRound,
          expectedRevision: problem.revision
        }
      });
      expect(decided.statusCode).toBe(200);
      expect(decided.json()).toEqual(expect.objectContaining({
        approvals: countRobotReviews ? 1 : 0,
        decisionSource: "manual"
      }));

      const storedRound = await store.runProblemTransaction(
        problem.id,
        (transaction) => transaction.getProblem()?.reviewRoundState
      );
      expect(storedRound).toEqual(expect.objectContaining({
        countedOpinionIds: countRobotReviews ? [robotReviewId] : [],
        usedOpinionIds: []
      }));
    }
  });

  it("同一审题人修改自己的意见时重新判定题目，轮次结束后不能再改", async () => {
    for (const expected of [
      {
        verdict: "approve",
        status: "approved",
        approvals: 1,
        blockingReviews: 0
      },
      {
        verdict: "reject",
        status: "rejected",
        approvals: 0,
        blockingReviews: 1
      }
    ] as const) {
      const { app } = await makeApp();
      const authorCookie = await login(app, "author");
      const reviewerCookie = await login(app, "reviewer");
      const leaderCookie = await login(app, "leader");
      await updatePolicy(app, leaderCookie, 1, {
        requiredApprovals: 1,
        maximumRejections: 0,
        countRobotReviews: false
      });
      const problem = await submitProblem(
        app,
        authorCookie,
        await createDraft(app, authorCookie)
      );

      const first = await submitReview(
        app,
        reviewerCookie,
        problem.id,
        problem.reviewRound,
        "request_changes"
      );
      expect(first.statusCode).toBe(200);
      const firstSummary = first.json() as ReviewSummaryResult;
      expect(firstSummary).toEqual(expect.objectContaining({
        approvals: 0,
        blockingReviews: 0,
        status: "waiting"
      }));
      expect(firstSummary.reviews).toHaveLength(1);

      const forgedTarget = await app.inject({
        method: "POST",
        url: `/api/v1/problems/${problem.id}/reviews`,
        headers: { cookie: reviewerCookie, origin },
        payload: {
          ...reviewInput(problem.reviewRound, expected.verdict),
          id: "another-review",
          reviewerId: "member"
        }
      });
      expect(forgedTarget.statusCode).toBe(422);

      const changed = await submitReview(
        app,
        reviewerCookie,
        problem.id,
        problem.reviewRound,
        expected.verdict
      );
      expect(changed.statusCode).toBe(200);
      const changedSummary = changed.json() as ReviewSummaryResult;
      expect(changedSummary).toEqual(expect.objectContaining({
        status: expected.status,
        approvals: expected.approvals,
        blockingReviews: expected.blockingReviews,
        decisionSource: "rule"
      }));
      expect(changedSummary.reviews).toHaveLength(1);
      expect(changedSummary.reviews[0]?.id).toBe(firstSummary.reviews[0]?.id);
      expect(changedSummary.reviews[0]?.verdict).toBe(expected.verdict);

      const afterClose = await submitReview(
        app,
        reviewerCookie,
        problem.id,
        problem.reviewRound,
        "request_changes"
      );
      expect(afterClose.statusCode).toBe(409);
    }
  });

  it("有题目查看权的用户可以查看公开评价，但看不到私密备注也不能提交意见", async () => {
    const reviewer = demoUser("reviewer");
    const readOnlyUser: StoredUser = {
      ...reviewer,
      id: "review-reader",
      nickname: "只读评价查看者",
      roles: ["只读成员"],
      grants: [...reviewer.grants, deny("problem.review")]
    };
    const { app } = await makeApp({
      users: [...createDemoUsers(), readOnlyUser]
    });
    const authorCookie = await login(app, "author");
    const reviewerCookie = await login(app, "reviewer");
    const readOnlyCookie = await login(app, readOnlyUser.id);
    const noAccessCookie = await login(app, "denied");
    const problem = await submitProblem(
      app,
      authorCookie,
      await createDraft(app, authorCookie)
    );
    const privateNote = "只允许审题人查看的测试备注。";

    const review = await app.inject({
      method: "POST",
      url: `/api/v1/problems/${problem.id}/reviews`,
      headers: { cookie: reviewerCookie, origin },
      payload: {
        ...reviewInput(problem.reviewRound, "request_changes"),
        privateNote
      }
    });
    expect(review.statusCode).toBe(200);

    const visible = await app.inject({
      method: "GET",
      url: `/api/v1/problems/${problem.id}/reviews`,
      headers: { cookie: readOnlyCookie }
    });
    expect(visible.statusCode).toBe(200);
    expect(visible.json()).toEqual(expect.objectContaining({
      status: "waiting",
      reviews: [
        expect.objectContaining({
          verdict: "request_changes",
          improvements: "请补充边界情况说明。",
          privateNote: ""
        })
      ]
    }));
    expect(visible.body).not.toContain(privateNote);

    const cannotSubmit = await submitReview(
      app,
      readOnlyCookie,
      problem.id,
      problem.reviewRound
    );
    expect(cannotSubmit.statusCode).toBe(403);

    const hidden = await app.inject({
      method: "GET",
      url: `/api/v1/problems/${problem.id}/reviews`,
      headers: { cookie: noAccessCookie }
    });
    expect(hidden.statusCode).toBe(404);
    expect(hidden.body).not.toContain("审核规则测试题");
    expect(hidden.body).not.toContain(privateNote);
  });

  it("规则插件停用时审核意见与题目状态一起回滚", async () => {
    const { app, host } = await makeApp();
    const authorCookie = await login(app, "author");
    const reviewerCookie = await login(app, "reviewer");
    const leaderCookie = await login(app, "leader");
    const problem = await submitProblem(app, authorCookie, await createDraft(app, authorCookie));

    await host.update(
      defaultPluginId,
      { expectedRevision: 1, clearSecrets: [], state: "disabled" },
      "leader",
      randomUUID()
    );
    await expectUnavailableReviewWasRolledBack(
      app,
      problem,
      authorCookie,
      reviewerCookie,
      leaderCookie
    );
  });

  it("审核规则执行报错时审核意见与题目状态一起回滚", async () => {
    const definitions = [
      ...createBuiltinPluginDefinitions(),
      failingReviewPlugin()
    ];
    const { app } = await makeApp({ definitions });
    const authorCookie = await login(app, "author");
    const reviewerCookie = await login(app, "reviewer");
    const leaderCookie = await login(app, "leader");
    await updatePolicy(
      app,
      leaderCookie,
      1,
      {},
      failingRuleId
    );
    const problem = await submitProblem(app, authorCookie, await createDraft(app, authorCookie));

    await expectUnavailableReviewWasRolledBack(
      app,
      problem,
      authorCookie,
      reviewerCookie,
      leaderCookie
    );
  });

  it("审核规则返回畸形结果时不保存意见，也不把内部错误回传给调用者", async () => {
    const definitions = [...createBuiltinPluginDefinitions(), malformedReviewPlugin()];
    const { app } = await makeApp({ definitions });
    const authorCookie = await login(app, "author");
    const reviewerCookie = await login(app, "reviewer");
    const leaderCookie = await login(app, "leader");
    await updatePolicy(app, leaderCookie, 1, {}, "org.example.malformed-review.rule");
    const problem = await submitProblem(app, authorCookie, await createDraft(app, authorCookie));
    await expectUnavailableReviewWasRolledBack(
      app,
      problem,
      authorCookie,
      reviewerCookie,
      leaderCookie
    );
  });

  it("审核规则超时时不保存意见，也不阻塞后续登录请求", async () => {
    const definitions = [...createBuiltinPluginDefinitions(), timeoutReviewPlugin()];
    const { app } = await makeApp({ definitions });
    const authorCookie = await login(app, "author");
    const reviewerCookie = await login(app, "reviewer");
    const leaderCookie = await login(app, "leader");
    await updatePolicy(app, leaderCookie, 1, {}, "org.example.timeout-review.rule");
    const problem = await submitProblem(app, authorCookie, await createDraft(app, authorCookie));
    await expectUnavailableReviewWasRolledBack(
      app,
      problem,
      authorCookie,
      reviewerCookie,
      leaderCookie
    );
    const loginAfterTimeout = await login(app, "member");
    expect(loginAfterTimeout).toContain("urmotiv_session=");
  }, 10_000);

  it("审核轮次关闭后，撤销原审题人的权限不会改写已经作出的决定", async () => {
    const { app, store, users } = await makeApp();
    const authorCookie = await login(app, "author");
    const reviewerCookie = await login(app, "reviewer");
    const memberCookie = await login(app, "member");
    const leaderCookie = await login(app, "leader");
    const problem = await submitProblem(app, authorCookie, await createDraft(app, authorCookie));
    await submitReview(app, reviewerCookie, problem.id, problem.reviewRound);
    const closed = await submitReview(app, memberCookie, problem.id, problem.reviewRound);
    expect((closed.json() as ReviewSummaryResult).status).toBe("approved");

    store.setUsersForReviewDecision(users.map((user) =>
      user.id === "reviewer" || user.id === "member"
        ? { ...user, grants: [...user.grants, deny("problem.review")] }
        : user
    ));

    const summary = await app.inject({
      method: "GET",
      url: `/api/v1/problems/${problem.id}/reviews`,
      headers: { cookie: leaderCookie }
    });
    expect(summary.statusCode).toBe(200);
    expect(summary.json()).toEqual(expect.objectContaining({
      status: "approved",
      approvals: 2,
      blockingReviews: 0,
      decisionAvailable: true,
      decisionSource: "rule"
    }));
  });

  it("规则不可用时人工终审和撤回仍可关闭轮次，并按有效人类意见固定显示计数", async () => {
    for (const action of ["manual", "withdrawal"] as const) {
      const { app, host, store } = await makeApp();
      const authorCookie = await login(app, "author");
      const reviewerCookie = await login(app, "reviewer");
      const leaderCookie = await login(app, "leader");
      const problem = await submitProblem(app, authorCookie, await createDraft(app, authorCookie));
      const reviewed = await submitReview(
        app,
        reviewerCookie,
        problem.id,
        problem.reviewRound
      );
      expect(reviewed.statusCode).toBe(200);
      const reviewId = (reviewed.json() as ReviewSummaryResult).reviews[0]?.id;
      expect(reviewId).toBeTypeOf("string");

      await host.update(
        defaultPluginId,
        { expectedRevision: 1, clearSecrets: [], state: "disabled" },
        "leader",
        randomUUID()
      );

      if (action === "manual") {
        const decided = await app.inject({
          method: "POST",
          url: `/api/v1/problems/${problem.id}/review-decision`,
          headers: { cookie: leaderCookie, origin },
          payload: {
            decision: "approve",
            reason: "规则不可用，已由组长人工确认。",
            expectedRound: problem.reviewRound,
            expectedRevision: problem.revision
          }
        });
        expect(decided.statusCode).toBe(200);
      } else {
        const withdrawn = await withdraw(
          app,
          authorCookie,
          problem,
          "规则不可用，作者先撤回修改。"
        );
        expect(withdrawn.statusCode).toBe(200);
      }

      const summary = await app.inject({
        method: "GET",
        url: `/api/v1/problems/${problem.id}/reviews`,
        headers: { cookie: leaderCookie }
      });
      expect(summary.statusCode).toBe(200);
      expect(summary.json()).toEqual(expect.objectContaining({
        approvals: 1,
        decisionSource: action
      }));

      const storedRound = await store.runProblemTransaction(
        problem.id,
        (transaction) => transaction.getProblem()?.reviewRoundState
      );
      expect(storedRound).toEqual(expect.objectContaining({
        countedOpinionIds: [reviewId],
        usedOpinionIds: []
      }));
    }
  });

  it("人工终审要求人类最终决定权，机器人即使被误授权也不能执行", async () => {
    const leader = demoUser("leader");
    const explicitlyDenied: StoredUser = {
      ...leader,
      id: "manual-decision-denied",
      nickname: "明确拒绝最终决定权",
      grants: [...leader.grants, deny("problem.status.change")]
    };
    const privilegedRobot: StoredUser = {
      ...leader,
      id: "manual-decision-robot",
      nickname: "误授最终决定权的机器人",
      accountType: "robot"
    };
    const { app, store, users } = await makeApp({
      users: [...createDemoUsers(), explicitlyDenied, privilegedRobot]
    });
    const authorCookie = await login(app, "author");
    const reviewerCookie = await login(app, "reviewer");
    const leaderCookie = await login(app, "leader");
    const explicitlyDeniedCookie = await login(app, explicitlyDenied.id);
    const robotCookie = await login(app, privilegedRobot.id);
    const noAccessCookie = await login(app, "denied");
    const problem = await submitProblem(app, authorCookie, await createDraft(app, authorCookie));
    const privateNote = "这段内容只供审题人和最终决定者查看。";
    const review = await app.inject({
      method: "POST",
      url: `/api/v1/problems/${problem.id}/reviews`,
      headers: { cookie: reviewerCookie, origin },
      payload: { ...reviewInput(problem.reviewRound), privateNote }
    });
    expect(review.statusCode).toBe(200);
    const reviewId = (review.json() as ReviewSummaryResult).reviews[0]?.id;
    expect(reviewId).toBeTypeOf("string");
    const payload = {
      decision: "approve",
      reason: "组长已人工核对题面与题解。",
      expectedRound: problem.reviewRound,
      expectedRevision: problem.revision
    };

    for (const cookie of [reviewerCookie, explicitlyDeniedCookie, robotCookie]) {
      const denied = await app.inject({
        method: "POST",
        url: `/api/v1/problems/${problem.id}/review-decision`,
        headers: { cookie, origin },
        payload
      });
      expect(denied.statusCode).toBe(403);
    }

    const decided = await app.inject({
      method: "POST",
      url: `/api/v1/problems/${problem.id}/review-decision`,
      headers: { cookie: leaderCookie, origin },
      payload
    });
    expect(decided.statusCode).toBe(200);
    expect(decided.json()).toEqual(expect.objectContaining({
      status: "approved",
      approvals: 1,
      decisionSource: "manual",
      decisionReason: payload.reason,
      reviews: [expect.objectContaining({ privateNote })]
    }));

    const storedRound = await store.runProblemTransaction(
      problem.id,
      (transaction) => transaction.getProblem()?.reviewRoundState
    );
    expect(storedRound).toEqual(expect.objectContaining({
      countedOpinionIds: [reviewId],
      usedOpinionIds: []
    }));

    store.setUsersForReviewDecision(users.map((candidate) =>
      candidate.id === "reviewer"
        ? { ...candidate, grants: [...candidate.grants, deny("problem.review")] }
        : candidate
    ));

    const authorSummary = await app.inject({
      method: "GET",
      url: `/api/v1/problems/${problem.id}/reviews`,
      headers: { cookie: authorCookie }
    });
    expect(authorSummary.statusCode).toBe(200);
    expect(authorSummary.json()).toEqual(expect.objectContaining({
      status: "approved",
      approvals: 1,
      decisionSource: "manual",
      decisionReason: payload.reason,
      reviews: [expect.objectContaining({ privateNote: "" })]
    }));

    const hidden = await app.inject({
      method: "GET",
      url: `/api/v1/problems/${problem.id}/reviews`,
      headers: { cookie: noAccessCookie }
    });
    expect(hidden.statusCode).toBe(404);
    expect(hidden.body).not.toContain("审核规则测试题");
    expect(hidden.body).not.toContain(payload.reason);
    expect(hidden.body).not.toContain(privateNote);
  });

  it("待审题目撤回后保存理由并关闭旧轮次，恢复编辑后从下一轮重新审核", async () => {
    const { app, store } = await makeApp();
    const authorCookie = await login(app, "author");
    const reviewerCookie = await login(app, "reviewer");
    const leaderCookie = await login(app, "leader");
    const problem = await submitProblem(app, authorCookie, await createDraft(app, authorCookie));
    const review = await app.inject({
      method: "POST",
      url: `/api/v1/problems/${problem.id}/reviews`,
      headers: { cookie: reviewerCookie, origin },
      payload: {
        ...reviewInput(problem.reviewRound),
        privateNote: "撤回前的审题私密备注。"
      }
    });
    expect(review.statusCode).toBe(200);
    const reviewId = (review.json() as ReviewSummaryResult).reviews[0]?.id;
    expect(reviewId).toBeTypeOf("string");

    const withdrawn = await withdraw(
      app,
      authorCookie,
      problem,
      "需要修改基础题面。"
    );
    expect(withdrawn.statusCode).toBe(200);
    expect(withdrawn.json()).toEqual(expect.objectContaining({
      status: "draft",
      revision: problem.revision + 1,
      reviewRound: problem.reviewRound
    }));

    const oldRound = await app.inject({
      method: "GET",
      url: `/api/v1/problems/${problem.id}/reviews`,
      headers: { cookie: leaderCookie }
    });
    expect(oldRound.statusCode).toBe(200);
    expect(oldRound.json()).toEqual(expect.objectContaining({
      status: "withdrawn",
      approvals: 1,
      decisionSource: "withdrawal",
      decisionReason: "需要修改基础题面。"
    }));

    const authorOldRound = await app.inject({
      method: "GET",
      url: `/api/v1/problems/${problem.id}/reviews`,
      headers: { cookie: authorCookie }
    });
    expect(authorOldRound.json()).toEqual(expect.objectContaining({
      status: "withdrawn",
      approvals: 1,
      decisionReason: "需要修改基础题面。",
      reviews: [expect.objectContaining({ privateNote: "" })]
    }));

    const storedRound = await store.runProblemTransaction(
      problem.id,
      (transaction) => transaction.getProblem()?.reviewRoundState
    );
    expect(storedRound).toEqual(expect.objectContaining({
      countedOpinionIds: [reviewId],
      usedOpinionIds: []
    }));

    const lateReview = await submitReview(
      app,
      reviewerCookie,
      problem.id,
      problem.reviewRound
    );
    expect(lateReview.statusCode).toBe(409);

    const edited = await app.inject({
      method: "PATCH",
      url: `/api/v1/problems/${problem.id}`,
      headers: { cookie: authorCookie, origin },
      payload: {
        expectedRevision: problem.revision + 1,
        title: "撤回后修改的题目名称"
      }
    });
    expect(edited.statusCode).toBe(200);
    const resubmitted = await submitProblem(
      app,
      authorCookie,
      edited.json() as ProblemResult
    );
    expect(resubmitted).toEqual(expect.objectContaining({
      status: "pending_review",
      reviewRound: problem.reviewRound + 1
    }));

    const newRound = await app.inject({
      method: "GET",
      url: `/api/v1/problems/${problem.id}/reviews`,
      headers: { cookie: leaderCookie }
    });
    expect(newRound.json()).toEqual(expect.objectContaining({
      round: problem.reviewRound + 1,
      status: "waiting",
      reviews: []
    }));
  });

  it("已通过题目可以撤回修改，旧决定保留且新提交进入下一轮", async () => {
    const { app } = await makeApp();
    const authorCookie = await login(app, "author");
    const reviewerCookie = await login(app, "reviewer");
    const memberCookie = await login(app, "member");
    const leaderCookie = await login(app, "leader");
    const problem = await submitProblem(app, authorCookie, await createDraft(app, authorCookie));
    await submitReview(app, reviewerCookie, problem.id, problem.reviewRound);
    const approved = await submitReview(app, memberCookie, problem.id, problem.reviewRound);
    expect(approved.statusCode).toBe(200);

    const approvedProblem = await app.inject({
      method: "GET",
      url: `/api/v1/problems/${problem.id}`,
      headers: { cookie: authorCookie }
    });
    const approvedBody = approvedProblem.json() as ProblemResult;
    expect(approvedBody.status).toBe("approved");

    const withdrawn = await withdraw(
      app,
      authorCookie,
      approvedBody,
      "补充证明细节。"
    );
    expect(withdrawn.statusCode).toBe(200);
    const withdrawnBody = withdrawn.json() as ProblemResult;
    expect(withdrawnBody).toEqual(expect.objectContaining({
      status: "draft",
      reviewRound: problem.reviewRound
    }));

    const historicalDecision = await app.inject({
      method: "GET",
      url: `/api/v1/problems/${problem.id}/reviews`,
      headers: { cookie: leaderCookie }
    });
    expect(historicalDecision.json()).toEqual(expect.objectContaining({
      status: "approved",
      approvals: 2,
      decisionSource: "rule"
    }));

    const edited = await app.inject({
      method: "PATCH",
      url: `/api/v1/problems/${problem.id}`,
      headers: { cookie: authorCookie, origin },
      payload: {
        expectedRevision: withdrawnBody.revision,
        title: "通过后撤回修改的题目名称"
      }
    });
    expect(edited.statusCode).toBe(200);
    const resubmitted = await submitProblem(
      app,
      authorCookie,
      edited.json() as ProblemResult
    );
    expect(resubmitted).toEqual(expect.objectContaining({
      status: "pending_review",
      reviewRound: problem.reviewRound + 1
    }));
  });

  it("最终决定者可以撤回他人的待审题目，普通审题人不能撤回", async () => {
    const { app } = await makeApp();
    const authorCookie = await login(app, "author");
    const reviewerCookie = await login(app, "reviewer");
    const leaderCookie = await login(app, "leader");
    const problem = await submitProblem(app, authorCookie, await createDraft(app, authorCookie));

    const denied = await withdraw(
      app,
      reviewerCookie,
      problem,
      "普通审题人无权撤回。"
    );
    expect(denied.statusCode).toBe(403);

    const allowed = await withdraw(
      app,
      leaderCookie,
      problem,
      "组长要求作者补充必要信息。"
    );
    expect(allowed.statusCode).toBe(200);
    expect(allowed.json()).toEqual(expect.objectContaining({
      status: "draft",
      revision: problem.revision + 1
    }));
  });
});
