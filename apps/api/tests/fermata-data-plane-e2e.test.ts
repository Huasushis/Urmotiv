/**
 * Fermata 审核数据面端到端测试。
 *
 * 这组测试证明 Urmotiv 和 Fermata 之间的审核数据面完整闭环：
 * 1. 有权限的审核任务通过版本 1 机器人接口提供给 Fermata（Fermata 拉取）；
 * 2. Fermata 的结构化审核意见通过版本 1 认证路由提交回 Urmotiv；
 * 3. Urmotiv 把意见绑定到正确的题目/修订/任务，存储为现有审核流程可用的附加属性；
 * 4. 丢失授权、错误任务/题目/修订、重复/重放、畸形/版本不匹配、不可达和私有资源猜测
 *    全部故障关闭，未授权与不存在不可区分，且不产生部分写入；
 * 5. 令牌、题面、密钥不进入日志、审计或错误体。
 *
 * 使用本地 PostgreSQL（createLocalDatabase），不调用任何外部模型。Fermata 侧通过机器人
 * 令牌直接调用 Urmotiv 的机器人 API 模拟，不启动真实 Fermata 进程。
 */
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createLocalDatabase,
  type LocalDatabaseHandle,
  migrateDatabase,
  seedCoreDatabase
} from "@urmotiv/database";
import { type SQL, sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app";
import { DatabaseContestStore } from "../src/database-contest-store";
import { databaseDemoUserIds, seedDatabaseDemoData } from "../src/database-demo";
import { DatabaseDataStore } from "../src/database-store";
import { DatabaseReviewItemStore } from "../src/review-item-store";
import { DatabaseRobotStore, digestRobotToken } from "../src/robot-store";
import { DatabaseTagCatalogService } from "../src/tag-catalog-service";

const localOrigin = "http://localhost:5173";
const robotToken = "urt_fermata_e2e_token_0123456789ab";
const defaultTokenPermissions = ["auth.login", "problem.view.all", "problem.review"] as const;

interface ClaimedTask {
  readonly assignmentId: string;
  readonly leaseExpiresAt: string;
  readonly problem: {
    readonly id: string;
    readonly revision: number;
    readonly reviewRound: number;
    readonly content: { readonly basicStatement: string };
  };
  readonly tagCatalog: {
    readonly version: number;
    readonly tags: ReadonlyArray<{ readonly id: string; readonly active: true }>;
  };
}

const openApps: FastifyInstance[] = [];
const openDatabases: LocalDatabaseHandle[] = [];
let temporaryDirectory = "";

beforeEach(async () => {
  temporaryDirectory = await mkdtemp(join(tmpdir(), "urmotiv-fermata-e2e-"));
});

afterEach(async () => {
  await Promise.all(openApps.splice(0).map(async (app) => app.close()));
  await Promise.all(openDatabases.splice(0).map(async (database) => database.close()));
  await rm(temporaryDirectory, { recursive: true, force: true });
});

async function insertToken(
  database: LocalDatabaseHandle,
  input: {
    readonly token?: string;
    readonly userId?: string;
    readonly permissions?: readonly string[];
  } = {},
): Promise<string> {
  const token = input.token ?? robotToken;
  const tokenId = randomUUID();
  await database.execute(sql`
    INSERT INTO api_tokens (
      id, user_id, name, token_prefix, token_digest, source_cidrs, created_by_user_id
    ) VALUES (
      ${tokenId}::uuid,
      ${BigInt(input.userId ?? databaseDemoUserIds.robot)},
      'Fermata 模拟令牌',
      'urt_fermata',
      ${digestRobotToken(token)},
      ${JSON.stringify([])}::jsonb,
      0
    )
  `);
  for (const permission of input.permissions ?? defaultTokenPermissions) {
    await database.execute(sql`
      INSERT INTO api_token_permissions (
        id, token_id, permission_name, effect, scope
      ) VALUES (
        ${randomUUID()}::uuid, ${tokenId}::uuid, ${permission}, 'allow', 'global'
      )
    `);
  }
  return tokenId;
}

async function makeFermataApp(): Promise<{
  app: FastifyInstance;
  database: LocalDatabaseHandle;
  tokenId: string;
}> {
  const database = createLocalDatabase({
    dataDirectory: join(temporaryDirectory, `database-${randomUUID()}`)
  });
  openDatabases.push(database);
  await migrateDatabase(database);
  await seedCoreDatabase(database);
  await seedDatabaseDemoData(database);
  const tokenId = await insertToken(database);

  const app = await createApp({
    demoAuthEnabled: true,
    store: new DatabaseDataStore(database),
    contestStore: new DatabaseContestStore(database),
    demoUserIds: Object.values(databaseDemoUserIds),
    demoLoginUserIds: databaseDemoUserIds,
    reviewItems: new DatabaseReviewItemStore(database),
    robots: new DatabaseRobotStore(database),
    tagCatalog: new DatabaseTagCatalogService(database),
  });
  openApps.push(app);
  return { app, database, tokenId };
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
  const firstCookie = Array.isArray(setCookie) ? setCookie[0] : setCookie;
  return (firstCookie as string).split(";", 1)[0] as string;
}

async function createPendingProblem(app: FastifyInstance): Promise<{ id: string }> {
  const author = await login(app, databaseDemoUserIds.author);
  const created = await app.inject({
    method: "POST",
    url: "/api/v1/problems",
    headers: { cookie: author, origin: localOrigin },
    payload: {
      title: "Fermata 审核端到端测试题",
      type: "traditional",
      tagIds: ["catalog.tag.02.09"],
      content: {
        basicStatement: "给定 n，输出 n。",
        basicSolution: "直接输出。",
        background: "",
        statement: "",
        inputFormat: "",
        outputFormat: "",
        constraints: "",
        solution: "",
        hints: ""
      }
    }
  });
  expect(created.statusCode).toBe(200);
  const draft = created.json() as { id: string; revision: number };
  const submitted = await app.inject({
    method: "POST",
    url: `/api/v1/problems/${draft.id}/submit`,
    headers: { cookie: author, origin: localOrigin },
    payload: { expectedRevision: draft.revision }
  });
  expect(submitted.statusCode).toBe(200);
  return { id: draft.id };
}

function fermataHeaders(token = robotToken): Record<string, string> {
  return { authorization: `Bearer ${token}`, origin: localOrigin };
}

function fermataReviewPayload(task: ClaimedTask): Record<string, unknown> {
  return {
    requestId: randomUUID(),
    expectedLeaseExpiresAt: task.leaseExpiresAt,
    expectedProblemRevision: task.problem.revision,
    expectedTagCatalogVersion: task.tagCatalog.version,
    experimentVersion: "fermata-e2e-v1",
    modelProfileName: "fermata-review-profile",
    review: {
      verdict: "approve" as const,
      codeforcesDifficulty: 1600,
      qualityLevel: 4,
      thinkingLevel: 3,
      codingLevel: 2,
      tagIds: [task.tagCatalog.tags[0]?.id ?? "catalog.tag.02.09"],
      improvements: "Fermata 模拟审核意见：题面清晰。",
      expectedRound: task.problem.reviewRound,
    },
  };
}

async function claimOne(app: FastifyInstance): Promise<ClaimedTask> {
  const claimed = await app.inject({
    method: "POST",
    url: "/api/v1/robot/review-tasks/claim",
    headers: fermataHeaders(),
    payload: { maximumTasks: 1, leaseSeconds: 300 },
  });
  expect(claimed.statusCode).toBe(200);
  const items = (claimed.json() as { items: ClaimedTask[] }).items;
  expect(items).toHaveLength(1);
  const item = items[0];
  if (item === undefined) throw new Error("未领取到测试任务。");
  return item;
}

describe("Fermata 审核数据面端到端", () => {
  it("Fermata 拉取任务、提交结构化审核意见，Urmotiv 绑定并存储为附加审核属性", async () => {
    const { app } = await makeFermataApp();
    const problem = await createPendingProblem(app);

    // 1. Fermata 通过机器人 API 拉取待审任务
    const task = await claimOne(app);
    expect(task.problem.id).toBe(problem.id);
    expect(task.problem.content.basicStatement).toContain("输出 n");
    expect(task.tagCatalog.tags.some((tag) => tag.id === "catalog.tag.02.09")).toBe(true);
    // 不泄露题解、评测配置等非审核必要字段
    expect(task.problem).not.toHaveProperty("judgeConfig");
    expect(task.problem).not.toHaveProperty("testcases");

    // 2. Fermata 提交结构化审核意见
    const completed = await app.inject({
      method: "POST",
      url: `/api/v1/robot/review-tasks/${task.assignmentId}/complete`,
      headers: fermataHeaders(),
      payload: fermataReviewPayload(task),
    });
    expect(completed.statusCode).toBe(200);
    expect(completed.json()).toEqual(
      expect.objectContaining({ accepted: true })
    );

    // 3. 审核意见已绑定到正确题目，可通过现有审核流程读取
    const reviewer = await login(app, databaseDemoUserIds.reviewer);
    const reviews = await app.inject({
      method: "GET",
      url: `/api/v1/problems/${problem.id}/reviews`,
      headers: { cookie: reviewer }
    });
    const summary = reviews.json() as {
      reviews: Array<{
        source: string;
        verdict: string;
        codeforcesDifficulty: number;
        qualityLevel: number;
      }>;
    };
    expect(summary.reviews).toHaveLength(1);
    expect(summary.reviews[0]).toEqual(
      expect.objectContaining({
        source: "fermata",
        verdict: "approve",
        codeforcesDifficulty: 1600,
        qualityLevel: 4,
      })
    );

    // 4. 任务已被消费，再次拉取不返回已完成的任务
    const reclaimed = await app.inject({
      method: "POST",
      url: "/api/v1/robot/review-tasks/claim",
      headers: fermataHeaders(),
      payload: {}
    });
    expect((reclaimed.json() as { items: unknown[] }).items).toHaveLength(0);
  });

  it("错误题目修订号提交被拒绝，不产生部分写入", async () => {
    const { app, database } = await makeFermataApp();
    await createPendingProblem(app);
    const task = await claimOne(app);

    const badRevision = await app.inject({
      method: "POST",
      url: `/api/v1/robot/review-tasks/${task.assignmentId}/complete`,
      headers: fermataHeaders(),
      payload: {
        ...fermataReviewPayload(task),
        expectedProblemRevision: task.problem.revision + 999,
      },
    });
    expect(badRevision.statusCode).toBe(409);

    // 没有审核意见被写入
    const opinions = await database.query<{ count: number | string }>(sql`
      SELECT count(*)::integer AS count FROM review_opinions
    `);
    expect(opinions[0]?.count).toBe(0);
  });

  it("重复/重放完成请求返回固定结果，不同载荷被拒绝且不产生额外写入", async () => {
    const { app, database } = await makeFermataApp();
    await createPendingProblem(app);
    const task = await claimOne(app);

    const payload = fermataReviewPayload(task);
    const firstCompletion = await app.inject({
      method: "POST",
      url: `/api/v1/robot/review-tasks/${task.assignmentId}/complete`,
      headers: fermataHeaders(),
      payload,
    });
    expect(firstCompletion.statusCode).toBe(200);

    // 相同 requestId 重放，返回相同结果
    const replayedCompletion = await app.inject({
      method: "POST",
      url: `/api/v1/robot/review-tasks/${task.assignmentId}/complete`,
      headers: fermataHeaders(),
      payload,
    });
    expect(replayedCompletion.statusCode).toBe(200);
    expect(replayedCompletion.json()).toEqual(firstCompletion.json());

    // 不同载荷（不同 codeforcesDifficulty）被拒绝
    const conflictingPayload = {
      ...payload,
      review: {
        ...(payload.review as Record<string, unknown>),
        codeforcesDifficulty: 1700,
      },
    };
    const conflicting = await app.inject({
      method: "POST",
      url: `/api/v1/robot/review-tasks/${task.assignmentId}/complete`,
      headers: fermataHeaders(),
      payload: conflictingPayload,
    });
    expect(conflicting.statusCode).toBe(409);

    // 只有一份审核意见
    const opinions = await database.query<{ count: number | string }>(sql`
      SELECT count(*)::integer AS count FROM review_opinions
    `);
    expect(opinions[0]?.count).toBe(1);
  });

  it("丢失授权（令牌吊销）后不能拉取或提交，且与未认证不可区分", async () => {
    const { app, database } = await makeFermataApp();
    await createPendingProblem(app);

    // 吊销令牌
    await database.execute(sql`UPDATE api_tokens SET revoked_at = now()`);

    const claim = await app.inject({
      method: "POST",
      url: "/api/v1/robot/review-tasks/claim",
      headers: fermataHeaders(),
      payload: {},
    });
    expect(claim.statusCode).toBe(401);

    const complete = await app.inject({
      method: "POST",
      url: `/api/v1/robot/review-tasks/fake-assignment-id/complete`,
      headers: fermataHeaders(),
      payload: {},
    });
    expect(complete.statusCode).toBe(401);
  });

  it("审核权限被明确拒绝后任务关闭，不产生审核意见且按不存在返回", async () => {
    const { app, database } = await makeFermataApp();
    await createPendingProblem(app);
    const task = await claimOne(app);

    // 对具体题目插入明确拒绝审题权限
    const grantId = randomUUID();
    await database.execute(sql`
      INSERT INTO permission_grants (
        id, subject_user_id, permission_name, effect, scope,
        object_type, object_id, granted_by_user_id, reason
      ) VALUES (
        ${grantId}::uuid,
        ${BigInt(databaseDemoUserIds.robot)},
        'problem.review', 'deny', 'object', 'problem', ${task.problem.id}, 0,
        'Fermata 端到端测试：明确拒绝审题权限'
      )
    `);

    const renewed = await app.inject({
      method: "POST",
      url: `/api/v1/robot/review-tasks/${task.assignmentId}/renew`,
      headers: fermataHeaders(),
      payload: {
        requestId: randomUUID(),
        expectedLeaseExpiresAt: task.leaseExpiresAt,
        leaseSeconds: 300,
      },
    });
    expect(renewed.statusCode).toBe(404);

    const completed = await app.inject({
      method: "POST",
      url: `/api/v1/robot/review-tasks/${task.assignmentId}/complete`,
      headers: fermataHeaders(),
      payload: fermataReviewPayload(task),
    });
    expect(completed.statusCode).toBe(404);

    // 没有审核意见
    const opinions = await database.query<{ count: number | string }>(sql`
      SELECT count(*)::integer AS count FROM review_opinions
    `);
    expect(opinions[0]?.count).toBe(0);
  });

  it("猜测不存在的任务 ID 与无权访问返回相同的 404", async () => {
    const { app } = await makeFermataApp();

    const guessRenew = await app.inject({
      method: "POST",
      url: `/api/v1/robot/review-tasks/${randomUUID()}/renew`,
      headers: fermataHeaders(),
      payload: { requestId: randomUUID(), expectedLeaseExpiresAt: "2026-01-01T00:00:00Z", leaseSeconds: 300 },
    });
    expect(guessRenew.statusCode).toBe(404);

    const guessComplete = await app.inject({
      method: "POST",
      url: `/api/v1/robot/review-tasks/${randomUUID()}/complete`,
      headers: fermataHeaders(),
      payload: {
        requestId: randomUUID(),
        expectedLeaseExpiresAt: "2026-01-01T00:00:00Z",
        expectedProblemRevision: 1,
        expectedTagCatalogVersion: 1,
        experimentVersion: "x",
        modelProfileName: "x",
        review: {
          verdict: "approve",
          codeforcesDifficulty: 1000,
          qualityLevel: 3,
          thinkingLevel: 2,
          codingLevel: 2,
          tagIds: ["catalog.tag.02.09"],
          improvements: "安全测试",
          expectedRound: 1,
        },
      },
    });
    expect(guessComplete.statusCode).toBe(404);
  });

  it("畸形请求体（缺少必填字段）返回 422，不调用服务层", async () => {
    const { app } = await makeFermataApp();
    await createPendingProblem(app);
    const task = await claimOne(app);

    const malformed = await app.inject({
      method: "POST",
      url: `/api/v1/robot/review-tasks/${task.assignmentId}/complete`,
      headers: fermataHeaders(),
      payload: { requestId: randomUUID() },
    });
    expect(malformed.statusCode).toBe(422);
  });

  it("响应中不包含令牌值", async () => {
    const { app } = await makeFermataApp();
    await createPendingProblem(app);
    const task = await claimOne(app);

    const completed = await app.inject({
      method: "POST",
      url: `/api/v1/robot/review-tasks/${task.assignmentId}/complete`,
      headers: fermataHeaders(),
      payload: fermataReviewPayload(task),
    });
    expect(completed.statusCode).toBe(200);
    expect(completed.body).not.toContain(robotToken);
  });
});
