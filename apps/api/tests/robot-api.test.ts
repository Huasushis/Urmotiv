import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createLocalDatabase,
  type DatabaseExecutor,
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
import { hasPermission } from "../src/permissions";
import { DatabaseReviewItemStore } from "../src/review-item-store";
import { DatabaseRobotStore, digestRobotToken } from "../src/robot-store";

const localOrigin = "http://localhost:5173";
const robotToken = "urt_test_robot_token_0123456789abcdef";
const defaultTokenPermissions = ["auth.login", "problem.view.all", "problem.review"] as const;

interface ClaimedTask {
  readonly assignmentId: string;
  readonly leaseExpiresAt: string;
  readonly problem: {
    readonly id: string;
    readonly revision: number;
    readonly reviewRound: number;
    readonly basicStatement?: string;
  };
}

const openApps: FastifyInstance[] = [];
const openDatabases: LocalDatabaseHandle[] = [];

let temporaryDirectory = "";

beforeEach(async () => {
  temporaryDirectory = await mkdtemp(join(tmpdir(), "urmotiv-robot-api-"));
});

afterEach(async () => {
  await Promise.all(openApps.splice(0).map((app) => app.close()));
  await Promise.all(openDatabases.splice(0).map((database) => database.close()));
  await rm(temporaryDirectory, { recursive: true, force: true });
});

async function insertToken(
  database: LocalDatabaseHandle,
  input: {
    readonly token?: string;
    readonly userId?: string;
    readonly permissions?: readonly string[];
    readonly sourceCidrs?: readonly string[];
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
      '测试机器人令牌',
      'urt_test',
      ${digestRobotToken(token)},
      ${JSON.stringify(input.sourceCidrs ?? [])}::jsonb,
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

async function makeRobotApp(
  options: { readonly trustedProxyCidrs?: readonly string[] } = {},
): Promise<{
  app: FastifyInstance;
  database: LocalDatabaseHandle;
  store: DatabaseDataStore;
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

  const store = new DatabaseDataStore(database);
  const app = await createApp({
    demoAuthEnabled: true,
    store,
    contestStore: new DatabaseContestStore(database),
    demoUserIds: Object.values(databaseDemoUserIds),
    demoLoginUserIds: databaseDemoUserIds,
    reviewItems: new DatabaseReviewItemStore(database),
    robots: new DatabaseRobotStore(database),
    ...(options.trustedProxyCidrs === undefined
      ? {}
      : { trustedProxyCidrs: options.trustedProxyCidrs }),
  });
  openApps.push(app);
  return { app, database, store, tokenId };
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
      title: "机器人审题演示题",
      type: "traditional",
      tagIds: ["algorithm.implementation"],
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

function robotHeaders(token = robotToken): Record<string, string> {
  return { authorization: `Bearer ${token}`, origin: localOrigin };
}

async function tokenLastUsedAt(
  database: LocalDatabaseHandle,
  tokenId: string,
): Promise<Date | string | null | undefined> {
  const rows = await database.query<{ last_used_at: Date | string | null }>(sql`
    SELECT last_used_at
    FROM api_tokens
    WHERE id = ${tokenId}::uuid
  `);
  return rows[0]?.last_used_at;
}

async function replaceTokenPermissions(
  database: LocalDatabaseHandle,
  tokenId: string,
  permissions: readonly string[],
): Promise<void> {
  await database.execute(sql`
    DELETE FROM api_token_permissions WHERE token_id = ${tokenId}::uuid
  `);
  for (const permission of permissions) {
    await database.execute(sql`
      INSERT INTO api_token_permissions (
        id, token_id, permission_name, effect, scope
      ) VALUES (
        ${randomUUID()}::uuid, ${tokenId}::uuid, ${permission}, 'allow', 'global'
      )
    `);
  }
}

function completionPayload(task: {
  readonly leaseExpiresAt: string;
  readonly problem: { readonly revision: number; readonly reviewRound: number };
}): Record<string, unknown> {
  return {
    requestId: randomUUID(),
    expectedLeaseExpiresAt: task.leaseExpiresAt,
    expectedProblemRevision: task.problem.revision,
    experimentVersion: "negative-matrix-v1",
    modelProfileName: "public-fixture",
    review: {
      verdict: "approve",
      codeforcesDifficulty: 1600,
      qualityLevel: 4,
      thinkingLevel: 3,
      codingLevel: 2,
      improvements: "公开构造的安全测试意见。",
      expectedRound: task.problem.reviewRound,
    },
  };
}

async function claimOne(app: FastifyInstance): Promise<ClaimedTask> {
  const claimed = await app.inject({
    method: "POST",
    url: "/api/v1/robot/review-tasks/claim",
    headers: robotHeaders(),
    payload: { maximumTasks: 1, leaseSeconds: 300 },
  });
  expect(claimed.statusCode).toBe(200);
  const items = (claimed.json() as { items: ClaimedTask[] }).items;
  expect(items).toHaveLength(1);
  const item = items[0];
  if (item === undefined) throw new Error("未领取到公开构造的测试任务。");
  return item;
}

describe("机器人审题接口", () => {
  it("认证事务先使用读已提交，再按账号、令牌和权限顺序显式锁定", async () => {
    const { database } = await makeRobotApp();
    let firstOperation: "execute" | "query" | undefined;
    let firstStatementIsolation: string | undefined;
    const wrappedDatabase: LocalDatabaseHandle = {
      ...database,
      transaction: async <T>(work: (executor: DatabaseExecutor) => Promise<T>): Promise<T> =>
        database.transaction(async (executor) => {
          const hookedExecutor: DatabaseExecutor = {
            execute: async (statement) => {
              const isFirst = firstOperation === undefined;
              if (isFirst) firstOperation = "execute";
              const result = await executor.execute(statement);
              if (isFirst) {
                const isolation = await executor.query<{ transaction_isolation: string }>(sql`
                  SHOW transaction_isolation
                `);
                firstStatementIsolation = isolation[0]?.transaction_isolation;
              }
              return result;
            },
            query: async <Row extends Record<string, unknown>>(statement: SQL): Promise<Row[]> => {
              if (firstOperation === undefined) firstOperation = "query";
              return executor.query<Row>(statement);
            },
          };
          return work(hookedExecutor);
        }),
    };

    const identity = await new DatabaseRobotStore(wrappedDatabase).authenticateToken(
      robotToken,
      "127.0.0.1",
    );
    expect(identity?.user.id).toBe(databaseDemoUserIds.robot);
    expect(firstOperation).toBe("execute");
    expect(firstStatementIsolation).toBe("read committed");
  });

  it("序列化冲突只重试一次，其他数据库故障不会伪装成令牌不存在", async () => {
    const { database } = await makeRobotApp();
    let attempts = 0;
    const retryingDatabase: LocalDatabaseHandle = {
      ...database,
      transaction: async <T>(work: (executor: DatabaseExecutor) => Promise<T>): Promise<T> => {
        attempts += 1;
        if (attempts === 1) {
          throw Object.assign(new Error("公开构造的数据库包装错误"), {
            cause: Object.assign(new Error("公开构造的序列化冲突"), { code: "40001" }),
          });
        }
        return database.transaction(work);
      },
    };
    await expect(
      new DatabaseRobotStore(retryingDatabase).authenticateToken(robotToken, "127.0.0.1"),
    ).resolves.toEqual(expect.objectContaining({ userId: databaseDemoUserIds.robot }));
    expect(attempts).toBe(2);

    const failingDatabase: LocalDatabaseHandle = {
      ...database,
      transaction: async <T>(_work: (executor: DatabaseExecutor) => Promise<T>): Promise<T> => {
        throw Object.assign(new Error("公开构造的数据库包装错误"), {
          cause: Object.assign(new Error("公开构造的数据库故障"), { code: "XX000" }),
        });
      },
    };
    await expect(
      new DatabaseRobotStore(failingDatabase).authenticateToken(robotToken, "127.0.0.1"),
    ).rejects.toMatchObject({ cause: { code: "XX000" } });
  });

  it("缺失、错误、撤销和过期令牌都无法认证", async () => {
    const { app, database, tokenId } = await makeRobotApp();

    const missing = await app.inject({
      method: "POST",
      url: "/api/v1/robot/review-tasks/claim",
      payload: {}
    });
    expect(missing.statusCode).toBe(401);

    const wrong = await app.inject({
      method: "POST",
      url: "/api/v1/robot/review-tasks/claim",
      headers: robotHeaders("urt_wrong_token_0123456789abcdef"),
      payload: {}
    });
    expect(wrong.statusCode).toBe(401);

    await database.execute(sql`UPDATE api_tokens SET revoked_at = now()`);
    const revoked = await app.inject({
      method: "POST",
      url: "/api/v1/robot/review-tasks/claim",
      headers: robotHeaders(),
      payload: {}
    });
    expect(revoked.statusCode).toBe(401);
    expect(await tokenLastUsedAt(database, tokenId)).toBeNull();

    const expiredToken = "urt_test_expired_token_0123456789abcdef";
    const expiredTokenId = await insertToken(database, { token: expiredToken });
    await database.execute(sql`
      UPDATE api_tokens
      SET created_at = '2000-01-01T00:00:00Z'::timestamptz,
          expires_at = '2001-01-01T00:00:00Z'::timestamptz
      WHERE id = ${expiredTokenId}::uuid
    `);
    const expired = await app.inject({
      method: "POST",
      url: "/api/v1/robot/review-tasks/claim",
      headers: robotHeaders(expiredToken),
      payload: {},
    });
    expect(expired.statusCode).toBe(401);
    expect(await tokenLastUsedAt(database, expiredTokenId)).toBeNull();
  });

  it("人工、临时服务、停用机器人和被拒绝登录的账号统一认证失败且不更新令牌", async () => {
    const { app, database, tokenId } = await makeRobotApp();
    const serviceUserId = "8000000000000101";
    const disabledRobotId = "8000000000000102";
    await database.execute(sql`
      INSERT INTO users (id, nickname, account_type)
      VALUES
        (${BigInt(serviceUserId)}, '临时服务账号', 'service'),
        (${BigInt(disabledRobotId)}, '停用机器人', 'robot')
    `);
    await database.execute(sql`
      UPDATE users
      SET disabled_at = now(), disabled_reason = '公开构造的停用测试'
      WHERE id = ${BigInt(disabledRobotId)}
    `);
    const humanToken = "urt_test_human_token_0123456789abcdef";
    const serviceToken = "urt_test_service_token_0123456789abcdef";
    const disabledToken = "urt_test_disabled_token_0123456789abcdef";
    const humanTokenId = await insertToken(database, {
      token: humanToken,
      userId: databaseDemoUserIds.author,
    });
    const serviceTokenId = await insertToken(database, {
      token: serviceToken,
      userId: serviceUserId,
    });
    const disabledTokenId = await insertToken(database, {
      token: disabledToken,
      userId: disabledRobotId,
    });
    await database.execute(sql`
      INSERT INTO permission_grants (
        id, subject_user_id, permission_name, effect, scope, granted_by_user_id, reason
      ) VALUES (
        ${randomUUID()}::uuid,
        ${BigInt(databaseDemoUserIds.robot)},
        'auth.login', 'deny', 'global', 0,
        '验证明确拒绝登录阻止令牌认证'
      )
    `);

    const tokens = [humanToken, serviceToken, disabledToken, robotToken];
    const responses = await Promise.all(tokens.map((token) => app.inject({
      method: "POST",
      url: "/api/v1/robot/review-tasks/claim",
      headers: robotHeaders(token),
      payload: {},
    })));
    expect(responses.map((response) => response.statusCode)).toEqual([401, 401, 401, 401]);
    expect(responses.map((response) => {
      const body = response.json() as { error: { code: string; message: string } };
      return { code: body.error.code, message: body.error.message };
    })).toEqual(Array(4).fill({ code: "UNAUTHENTICATED", message: "请先登录后再继续。" }));
    for (const id of [humanTokenId, serviceTokenId, disabledTokenId, tokenId]) {
      expect(await tokenLastUsedAt(database, id)).toBeNull();
    }
  });

  it("数据库中的畸形令牌策略全部认证失败且没有最近使用副作用", async () => {
    const { app, database } = await makeRobotApp();
    await database.execute(sql`
      INSERT INTO permission_definitions (name, display_name, description, source)
      VALUES ('org.test.extra', '测试扩展权限', '只用于验证机器人令牌拒绝非核心权限。', 'plugin')
    `);

    const cases: Array<{ token: string; tokenId: string }> = [];
    const add = async (
      suffix: string,
      permissions: readonly string[],
      sourceCidrs: readonly string[] = [],
    ): Promise<string> => {
      const token = `urt_test_malformed_${suffix}_0123456789abcdef`;
      const malformedTokenId = await insertToken(database, { token, permissions, sourceCidrs });
      cases.push({ token, tokenId: malformedTokenId });
      return malformedTokenId;
    };

    await add("empty", []);
    await add("no_login", ["problem.review"]);
    await add("hard_deny", ["auth.login", "system.manage"]);
    await add("unknown", ["auth.login", "org.test.extra"]);
    await add("duplicate", ["auth.login", "auth.login"]);
    const deniedId = await add("deny_row", ["auth.login", "problem.review"]);
    await database.execute(sql`
      UPDATE api_token_permissions
      SET effect = 'deny'
      WHERE token_id = ${deniedId}::uuid AND permission_name = 'problem.review'
    `);
    const objectId = await add("object_row", ["auth.login", "problem.review"]);
    await database.execute(sql`
      UPDATE api_token_permissions
      SET scope = 'object', object_type = 'problem', object_id = '1'
      WHERE token_id = ${objectId}::uuid AND permission_name = 'problem.review'
    `);
    await add("bad_cidr", ["auth.login", "problem.review"], ["2001:DB8::/64"]);

    for (const item of cases) {
      const response = await app.inject({
        method: "POST",
        url: "/api/v1/robot/review-tasks/claim",
        headers: robotHeaders(item.token),
        payload: {},
      });
      expect(response.statusCode).toBe(401);
      expect(await tokenLastUsedAt(database, item.tokenId)).toBeNull();
    }
  });

  it("来源地址限制只信任明确配置的代理链并在完整认证后更新使用时间", async () => {
    const { app, database, tokenId } = await makeRobotApp({
      trustedProxyCidrs: ["10.0.0.0/8"],
    });
    await database.execute(sql`
      UPDATE api_tokens
      SET source_cidrs = '["198.51.100.0/24"]'::jsonb
      WHERE id = ${tokenId}::uuid
    `);

    const forged = await app.inject({
      method: "POST",
      url: "/api/v1/robot/review-tasks/claim",
      remoteAddress: "203.0.113.9",
      headers: { ...robotHeaders(), "x-forwarded-for": "198.51.100.7" },
      payload: {},
    });
    expect(forged.statusCode).toBe(401);
    expect(await tokenLastUsedAt(database, tokenId)).toBeNull();

    const malformed = await app.inject({
      method: "POST",
      url: "/api/v1/robot/review-tasks/claim",
      remoteAddress: "10.0.0.8",
      headers: { ...robotHeaders(), "x-forwarded-for": "198.51.100.7, unknown" },
      payload: {},
    });
    expect(malformed.statusCode).toBe(401);
    expect(await tokenLastUsedAt(database, tokenId)).toBeNull();

    const forwarded = await app.inject({
      method: "POST",
      url: "/api/v1/robot/review-tasks/claim",
      remoteAddress: "10.0.0.8",
      headers: { ...robotHeaders(), "x-forwarded-for": "198.51.100.7" },
      payload: {},
    });
    expect(forwarded.statusCode).toBe(200);
    expect(await tokenLastUsedAt(database, tokenId)).not.toBeNull();
  });

  it("令牌权限只设上限：只有登录权限不能审题，查看与审题缺一不可", async () => {
    const { app, database, tokenId } = await makeRobotApp();
    await createPendingProblem(app);

    await replaceTokenPermissions(database, tokenId, ["auth.login"]);
    const loginOnly = await app.inject({
      method: "POST",
      url: "/api/v1/robot/review-tasks/claim",
      headers: robotHeaders(),
      payload: {},
    });
    expect(loginOnly.statusCode).toBe(403);
    expect(await tokenLastUsedAt(database, tokenId)).not.toBeNull();

    await replaceTokenPermissions(database, tokenId, ["auth.login", "problem.review"]);
    const noView = await app.inject({
      method: "POST",
      url: "/api/v1/robot/review-tasks/claim",
      headers: robotHeaders(),
      payload: {},
    });
    expect(noView.statusCode).toBe(200);
    expect(noView.json()).toEqual({ items: [] });

    await replaceTokenPermissions(database, tokenId, ["auth.login", "problem.view.all"]);
    const noReview = await app.inject({
      method: "POST",
      url: "/api/v1/robot/review-tasks/claim",
      headers: robotHeaders(),
      payload: {},
    });
    expect(noReview.statusCode).toBe(403);

    const assignments = await database.query<{ count: number | string }>(sql`
      SELECT count(*)::integer AS count FROM review_assignments
    `);
    expect(Number(assignments[0]?.count ?? -1)).toBe(0);
  });

  it("对象级审题权限在候选 SQL 中生效，不会被前五十条无权题目饿死", async () => {
    const { app, database } = await makeRobotApp();
    const allowedProblem = await createPendingProblem(app);
    await database.execute(sql`
      UPDATE review_rounds
      SET created_at = '2100-01-01T00:00:00.000Z'::timestamptz
      WHERE problem_id = ${BigInt(allowedProblem.id)}
    `);

    await database.transaction(async (transaction) => {
      for (let index = 0; index < 50; index += 1) {
        const createdAt = new Date(Date.UTC(2000, 0, 1, 0, 0, index)).toISOString();
        const revisionId = randomUUID();
        const roundId = randomUUID();
        const inserted = await transaction.query<{ id: string }>(sql`
          INSERT INTO problems (
            owner_id, status, current_revision, current_review_round, created_at, updated_at
          ) VALUES (
            ${BigInt(databaseDemoUserIds.author)}, 'pending_review', 1, 1,
            ${createdAt}::timestamptz, ${createdAt}::timestamptz
          )
          RETURNING id::text AS id
        `);
        const problemId = inserted[0]?.id;
        if (problemId === undefined) throw new Error("未建立公开构造的候选题目。");
        await transaction.execute(sql`
          INSERT INTO problem_revisions (
            id, problem_id, revision, status, title, type,
            basic_statement, basic_solution, content_hash, change_reason,
            created_by_user_id, created_at
          ) VALUES (
            ${revisionId}::uuid, ${BigInt(problemId)}, 1, 'pending_review',
            ${`公开构造的候选题目 ${index}`}, 'traditional',
            '公开构造的题面', '公开构造的题解',
            '0000000000000000000000000000000000000000000000000000000000000000',
            '公开构造的候选题目', ${BigInt(databaseDemoUserIds.author)},
            ${createdAt}::timestamptz
          )
        `);
        await transaction.execute(sql`
          INSERT INTO review_rounds (
            id, problem_id, round, submitted_revision_id, status,
            rule_id, rule_version, rule_settings, submitted_by_user_id, created_at
          ) VALUES (
            ${roundId}::uuid, ${BigInt(problemId)}, 1, ${revisionId}::uuid, 'open',
            'robot-candidate-test', '1', '{}'::jsonb,
            ${BigInt(databaseDemoUserIds.author)}, ${createdAt}::timestamptz
          )
        `);
      }
    });

    await database.execute(sql`
      UPDATE permission_grants grant_record
      SET revoked_at = now(), revoked_by_user_id = 0
      WHERE grant_record.permission_name = 'problem.review'
        AND (
          grant_record.subject_user_id = ${BigInt(databaseDemoUserIds.robot)}
          OR grant_record.subject_role_id IN (
            SELECT membership.role_id
            FROM role_memberships membership
            WHERE membership.user_id = ${BigInt(databaseDemoUserIds.robot)}
              AND membership.revoked_at IS NULL
          )
        )
    `);
    await database.execute(sql`
      INSERT INTO permission_grants (
        id, subject_user_id, permission_name, effect, scope,
        object_type, object_id, granted_by_user_id, reason
      ) VALUES (
        ${randomUUID()}::uuid, ${BigInt(databaseDemoUserIds.robot)},
        'problem.review', 'allow', 'object', 'problem', ${allowedProblem.id}, 0,
        '验证对象级权限在候选 SQL 中过滤'
      )
    `);

    const claimed = await app.inject({
      method: "POST",
      url: "/api/v1/robot/review-tasks/claim",
      headers: robotHeaders(),
      payload: {},
    });
    expect(claimed.statusCode).toBe(200);
    expect((claimed.json() as { items: ClaimedTask[] }).items).toEqual([
      expect.objectContaining({ problem: expect.objectContaining({ id: allowedProblem.id }) }),
    ]);
  });

  it("支持题型在候选 LIMIT 前过滤，不会被前五十道不支持题型饿死", async () => {
    const { app, database } = await makeRobotApp();
    const supportedProblem = await createPendingProblem(app);
    await database.execute(sql`
      UPDATE review_rounds
      SET created_at = '2100-01-01T00:00:00.000Z'::timestamptz
      WHERE problem_id = ${BigInt(supportedProblem.id)}
    `);
    await database.transaction(async (transaction) => {
      for (let index = 0; index < 50; index += 1) {
        const createdAt = new Date(Date.UTC(2001, 0, 1, 0, 0, index)).toISOString();
        const revisionId = randomUUID();
        const roundId = randomUUID();
        const inserted = await transaction.query<{ id: string }>(sql`
          INSERT INTO problems (
            owner_id, status, current_revision, current_review_round, created_at, updated_at
          ) VALUES (
            ${BigInt(databaseDemoUserIds.author)}, 'pending_review', 1, 1,
            ${createdAt}::timestamptz, ${createdAt}::timestamptz
          )
          RETURNING id::text AS id
        `);
        const problemId = inserted[0]?.id;
        if (problemId === undefined) throw new Error("未建立公开构造的不支持题型候选。");
        await transaction.execute(sql`
          INSERT INTO problem_revisions (
            id, problem_id, revision, status, title, type, basic_statement, basic_solution,
            content_hash, change_reason, created_by_user_id, created_at
          ) VALUES (
            ${revisionId}::uuid, ${BigInt(problemId)}, 1, 'pending_review',
            ${`公开构造的交互题 ${index}`}, 'interactive', '公开构造题面', '公开构造题解',
            '0000000000000000000000000000000000000000000000000000000000000000',
            '题型过滤测试', ${BigInt(databaseDemoUserIds.author)}, ${createdAt}::timestamptz
          )
        `);
        await transaction.execute(sql`
          INSERT INTO review_rounds (
            id, problem_id, round, submitted_revision_id, status, rule_id, rule_version,
            rule_settings, submitted_by_user_id, created_at
          ) VALUES (
            ${roundId}::uuid, ${BigInt(problemId)}, 1, ${revisionId}::uuid, 'open',
            'robot-type-filter-test', '1', '{}'::jsonb,
            ${BigInt(databaseDemoUserIds.author)}, ${createdAt}::timestamptz
          )
        `);
      }
    });

    const claimed = await app.inject({
      method: "POST",
      url: "/api/v1/robot/review-tasks/claim",
      headers: robotHeaders(),
      payload: {
        maximumTasks: 1,
        leaseSeconds: 300,
        supportedProblemTypes: ["traditional"]
      }
    });
    expect(claimed.statusCode).toBe(200);
    expect((claimed.json() as { items: ClaimedTask[] }).items).toEqual([
      expect.objectContaining({ problem: expect.objectContaining({ id: supportedProblem.id }) })
    ]);
  });

  it("领取待审任务、提交结构化意见并完成整个闭环", async () => {
    const { app } = await makeRobotApp();
    const problem = await createPendingProblem(app);

    const claimed = await app.inject({
      method: "POST",
      url: "/api/v1/robot/review-tasks/claim",
      headers: robotHeaders(),
      payload: { maximumTasks: 2, leaseSeconds: 120 }
    });
    expect(claimed.statusCode).toBe(200);
    const claimBody = claimed.json() as {
      items: Array<{
        assignmentId: string;
        leaseExpiresAt: string;
        problem: { id: string; revision: number; reviewRound: number; basicStatement: string };
      }>;
    };
    expect(claimBody.items).toHaveLength(1);
    const task = claimBody.items[0];
    if (task === undefined) throw new Error("未领取到公开构造的测试任务。");
    expect(task.problem.id).toBe(problem.id);
    expect(task.problem.basicStatement).toContain("输出 n");

    const renewed = await app.inject({
      method: "POST",
      url: `/api/v1/robot/review-tasks/${task.assignmentId}/renew`,
      headers: robotHeaders(),
      payload: {
        requestId: randomUUID(),
        expectedLeaseExpiresAt: task.leaseExpiresAt,
        leaseSeconds: 300
      }
    });
    expect(renewed.statusCode).toBe(200);
    const newLease = (renewed.json() as { leaseExpiresAt: string }).leaseExpiresAt;
    expect(newLease).not.toBe(task.leaseExpiresAt);

    const staleRenew = await app.inject({
      method: "POST",
      url: `/api/v1/robot/review-tasks/${task.assignmentId}/renew`,
      headers: robotHeaders(),
      payload: {
        requestId: randomUUID(),
        expectedLeaseExpiresAt: task.leaseExpiresAt,
        leaseSeconds: 300
      }
    });
    expect(staleRenew.statusCode).toBe(404);

    const badRevision = await app.inject({
      method: "POST",
      url: `/api/v1/robot/review-tasks/${task.assignmentId}/complete`,
      headers: robotHeaders(),
      payload: {
        requestId: randomUUID(),
        expectedLeaseExpiresAt: newLease,
        expectedProblemRevision: task.problem.revision + 5,
        experimentVersion: "exp-2026-07",
        modelProfileName: "difficulty-v1",
        review: {
          verdict: "approve",
          codeforcesDifficulty: 1600,
          qualityLevel: 4,
          thinkingLevel: 3,
          codingLevel: 2,
          improvements: "机器人分析：题面清晰，可以补充更强的边界样例。",
          expectedRound: task.problem.reviewRound
        }
      }
    });
    expect(badRevision.statusCode).toBe(409);

    const completed = await app.inject({
      method: "POST",
      url: `/api/v1/robot/review-tasks/${task.assignmentId}/complete`,
      headers: robotHeaders(),
      payload: {
        requestId: randomUUID(),
        expectedLeaseExpiresAt: newLease,
        expectedProblemRevision: task.problem.revision,
        experimentVersion: "exp-2026-07",
        modelProfileName: "difficulty-v1",
        review: {
          verdict: "approve",
          codeforcesDifficulty: 1600,
          qualityLevel: 4,
          thinkingLevel: 3,
          codingLevel: 2,
          improvements: "机器人分析：题面清晰，可以补充更强的边界样例。",
          expectedRound: task.problem.reviewRound
        }
      }
    });
    expect(completed.statusCode).toBe(200);
    expect(completed.json()).toEqual(
      expect.objectContaining({ accepted: true, problemStatus: "pending_review" })
    );

    const reviewer = await login(app, databaseDemoUserIds.reviewer);
    const reviews = await app.inject({
      method: "GET",
      url: `/api/v1/problems/${problem.id}/reviews`,
      headers: { cookie: reviewer }
    });
    const summary = reviews.json() as {
      reviews: Array<{ source: string; codeforcesDifficulty: number }>;
    };
    expect(summary.reviews).toHaveLength(1);
    expect(summary.reviews[0]).toEqual(
      expect.objectContaining({ source: "fermata", codeforcesDifficulty: 1600 })
    );

    const reclaimed = await app.inject({
      method: "POST",
      url: "/api/v1/robot/review-tasks/claim",
      headers: robotHeaders(),
      payload: {}
    });
    expect((reclaimed.json() as { items: unknown[] }).items).toHaveLength(0);
  });

  it("续租和完成在响应丢失后按请求标识重放固定结果，且拒绝不同载荷", async () => {
    const { app, database } = await makeRobotApp();
    await createPendingProblem(app);
    const task = await claimOne(app);

    const renewalRequestId = randomUUID();
    const renewalPayload = {
      requestId: renewalRequestId,
      expectedLeaseExpiresAt: task.leaseExpiresAt,
      leaseSeconds: 300
    };
    const firstRenewal = await app.inject({
      method: "POST",
      url: `/api/v1/robot/review-tasks/${task.assignmentId}/renew`,
      headers: robotHeaders(),
      payload: renewalPayload
    });
    const replayedRenewal = await app.inject({
      method: "POST",
      url: `/api/v1/robot/review-tasks/${task.assignmentId}/renew`,
      headers: robotHeaders(),
      payload: renewalPayload
    });
    expect(firstRenewal.statusCode).toBe(200);
    expect(replayedRenewal.statusCode).toBe(200);
    expect(replayedRenewal.json()).toEqual(firstRenewal.json());

    const conflictingRenewal = await app.inject({
      method: "POST",
      url: `/api/v1/robot/review-tasks/${task.assignmentId}/renew`,
      headers: robotHeaders(),
      payload: { ...renewalPayload, leaseSeconds: 301 }
    });
    expect(conflictingRenewal.statusCode).toBe(409);
    const renewedLease = (firstRenewal.json() as { leaseExpiresAt: string }).leaseExpiresAt;

    const completionRequestId = randomUUID();
    const baseCompletion = completionPayload({
        ...task,
        leaseExpiresAt: renewedLease
      });
    const completionReview = baseCompletion.review as Record<string, unknown>;
    const completion = {
      ...baseCompletion,
      requestId: completionRequestId
    };
    const firstCompletion = await app.inject({
      method: "POST",
      url: `/api/v1/robot/review-tasks/${task.assignmentId}/complete`,
      headers: robotHeaders(),
      payload: completion
    });
    const replayedCompletion = await app.inject({
      method: "POST",
      url: `/api/v1/robot/review-tasks/${task.assignmentId}/complete`,
      headers: robotHeaders(),
      payload: completion
    });
    expect(firstCompletion.statusCode).toBe(200);
    expect(replayedCompletion.statusCode).toBe(200);
    expect(replayedCompletion.json()).toEqual(firstCompletion.json());

    const conflictingCompletion = await app.inject({
      method: "POST",
      url: `/api/v1/robot/review-tasks/${task.assignmentId}/complete`,
      headers: robotHeaders(),
      payload: {
        ...completion,
        review: { ...completionReview, codeforcesDifficulty: 1700 }
      }
    });
    expect(conflictingCompletion.statusCode).toBe(409);

    const effects = await database.query<{
      opinion_count: number | string;
      renew_operation_count: number | string;
      complete_operation_count: number | string;
      renew_audit_count: number | string;
      complete_audit_count: number | string;
      closure_reason: string | null;
      completion_request_id: string | null;
    }>(sql`
      SELECT
        (SELECT count(*) FROM review_opinions)::integer AS opinion_count,
        (
          SELECT count(*) FROM review_assignment_operations
          WHERE operation = 'renew'
        )::integer AS renew_operation_count,
        (
          SELECT count(*) FROM review_assignment_operations
          WHERE operation = 'complete'
        )::integer AS complete_operation_count,
        (
          SELECT count(*) FROM audit_events WHERE action = 'robot.review.renew'
        )::integer AS renew_audit_count,
        (
          SELECT count(*) FROM audit_events WHERE action = 'robot.review.complete'
        )::integer AS complete_audit_count,
        assignment.closure_reason,
        assignment.completion_request_id::text AS completion_request_id
      FROM review_assignments assignment
      WHERE assignment.id = ${task.assignmentId}::uuid
    `);
    expect(effects[0]).toEqual({
      opinion_count: 1,
      renew_operation_count: 1,
      complete_operation_count: 1,
      renew_audit_count: 1,
      complete_audit_count: 1,
      closure_reason: "completed",
      completion_request_id: completionRequestId
    });
  });

  it("过期完成的失败结果也按请求标识固定重放且只关闭和审计一次", async () => {
    const { app, database } = await makeRobotApp();
    await createPendingProblem(app);
    const task = await claimOne(app);
    await database.execute(sql`
      UPDATE review_assignments
      SET created_at = now() - interval '2 hours',
          expires_at = now() - interval '1 hour'
      WHERE id = ${task.assignmentId}::uuid
    `);
    const payload = completionPayload(task);
    const first = await app.inject({
      method: "POST",
      url: `/api/v1/robot/review-tasks/${task.assignmentId}/complete`,
      headers: robotHeaders(),
      payload,
    });
    const replay = await app.inject({
      method: "POST",
      url: `/api/v1/robot/review-tasks/${task.assignmentId}/complete`,
      headers: robotHeaders(),
      payload,
    });
    expect(first.statusCode).toBe(409);
    expect(replay.statusCode).toBe(409);
    const firstError = first.json() as { error: { code: string; message: string } };
    const replayError = replay.json() as { error: { code: string; message: string } };
    expect(replayError.error.code).toBe(firstError.error.code);
    expect(replayError.error.message).toBe(firstError.error.message);

    const review = payload.review as Record<string, unknown>;
    const conflicting = await app.inject({
      method: "POST",
      url: `/api/v1/robot/review-tasks/${task.assignmentId}/complete`,
      headers: robotHeaders(),
      payload: { ...payload, review: { ...review, codeforcesDifficulty: 1700 } },
    });
    expect(conflicting.statusCode).toBe(409);

    const effects = await database.query<{
      closure_reason: string;
      operation_count: number | string;
      close_audit_count: number | string;
      opinion_count: number | string;
      stored_outcome: string | null;
    }>(sql`
      SELECT assignment.closure_reason::text AS closure_reason,
             (
               SELECT count(*)::integer FROM review_assignment_operations operation
               WHERE operation.assignment_id = assignment.id AND operation.operation = 'complete'
             ) AS operation_count,
             (
               SELECT count(*)::integer FROM audit_events audit
               WHERE audit.action = 'robot.review.assignment.close'
                 AND audit.request_id = ${(payload.requestId as string)}::uuid
             ) AS close_audit_count,
             (SELECT count(*)::integer FROM review_opinions) AS opinion_count,
             (
               SELECT operation.result ->> 'outcome'
               FROM review_assignment_operations operation
               WHERE operation.assignment_id = assignment.id AND operation.operation = 'complete'
             ) AS stored_outcome
      FROM review_assignments assignment
      WHERE assignment.id = ${task.assignmentId}::uuid
    `);
    expect(effects).toEqual([{
      closure_reason: "expired",
      operation_count: 1,
      close_audit_count: 1,
      opinion_count: 0,
      stored_outcome: "conflict",
    }]);
  });

  it("滚动升级期间兼容未带请求标识的旧 Fermata，且仍不重复写意见", async () => {
    const { app, database } = await makeRobotApp();
    await createPendingProblem(app);
    const task = await claimOne(app);
    const renewed = await app.inject({
      method: "POST",
      url: `/api/v1/robot/review-tasks/${task.assignmentId}/renew`,
      headers: robotHeaders(),
      payload: {
        expectedLeaseExpiresAt: task.leaseExpiresAt,
        leaseSeconds: 300,
      },
    });
    expect(renewed.statusCode).toBe(200);
    const renewedLease = (renewed.json() as { leaseExpiresAt: string }).leaseExpiresAt;
    const legacyCompletion = completionPayload({ ...task, leaseExpiresAt: renewedLease });
    Reflect.deleteProperty(legacyCompletion, "requestId");
    const completed = await app.inject({
      method: "POST",
      url: `/api/v1/robot/review-tasks/${task.assignmentId}/complete`,
      headers: robotHeaders(),
      payload: legacyCompletion,
    });
    expect(completed.statusCode).toBe(200);
    const effects = await database.query<{
      operations: number | string;
      opinions: number | string;
      generated_ids: number | string;
    }>(sql`
      SELECT count(*)::integer AS operations,
             (SELECT count(*)::integer FROM review_opinions) AS opinions,
             count(request_id)::integer AS generated_ids
      FROM review_assignment_operations
      WHERE assignment_id = ${task.assignmentId}::uuid
    `);
    expect(effects).toEqual([{ operations: 2, opinions: 1, generated_ids: 2 }]);
  });

  it("领取后失去具体题目的审题或查看权限时，续租和完成都按不存在处理", async () => {
    const { app, database } = await makeRobotApp();
    await createPendingProblem(app);
    const task = await claimOne(app);
    const grantId = randomUUID();
    await database.execute(sql`
      INSERT INTO permission_grants (
        id, subject_user_id, permission_name, effect, scope,
        object_type, object_id, granted_by_user_id, reason
      ) VALUES (
        ${grantId}::uuid,
        ${BigInt(databaseDemoUserIds.robot)},
        'problem.review', 'deny', 'object', 'problem', ${task.problem.id}, 0,
        '验证具体题目审题拒绝在续租时重新生效'
      )
    `);

    for (const path of ["renew", "complete"] as const) {
      const response = await app.inject({
        method: "POST",
        url: `/api/v1/robot/review-tasks/${task.assignmentId}/${path}`,
        headers: robotHeaders(),
        payload: path === "renew"
          ? {
              requestId: randomUUID(),
              expectedLeaseExpiresAt: task.leaseExpiresAt,
              leaseSeconds: 300
            }
          : completionPayload(task),
      });
      expect(response.statusCode).toBe(404);
    }

    await database.execute(sql`
      UPDATE permission_grants
      SET permission_name = 'problem.view.all',
          reason = '验证具体题目查看拒绝在续租时重新生效'
      WHERE id = ${grantId}::uuid
    `);
    for (const path of ["renew", "complete"] as const) {
      const response = await app.inject({
        method: "POST",
        url: `/api/v1/robot/review-tasks/${task.assignmentId}/${path}`,
        headers: robotHeaders(),
        payload: path === "renew"
          ? {
              requestId: randomUUID(),
              expectedLeaseExpiresAt: task.leaseExpiresAt,
              leaseSeconds: 300
            }
          : completionPayload(task),
      });
      expect(response.statusCode).toBe(404);
    }

    const sideEffects = await database.query<{
      revoked_at: Date | string | null;
      closure_reason: string | null;
      opinion_count: number | string;
      audit_count: number | string;
    }>(sql`
      SELECT assignment.revoked_at, assignment.closure_reason,
             (SELECT count(*) FROM review_opinions)::integer AS opinion_count,
             (
               SELECT count(*) FROM audit_events
               WHERE action = 'robot.review.assignment.close'
             )::integer AS audit_count
      FROM review_assignments assignment
      WHERE assignment.id = ${task.assignmentId}::uuid
    `);
    expect(sideEffects[0]).toEqual(expect.objectContaining({
      revoked_at: expect.anything(),
      closure_reason: "permission_revoked",
      opinion_count: 0,
      audit_count: 1,
    }));
  });

  it("领取后令牌移除审题权限时，具体租约不可续租或完成", async () => {
    const { app, database, tokenId } = await makeRobotApp();
    await createPendingProblem(app);
    const task = await claimOne(app);
    await replaceTokenPermissions(database, tokenId, ["auth.login", "problem.view.all"]);

    const renewed = await app.inject({
      method: "POST",
      url: `/api/v1/robot/review-tasks/${task.assignmentId}/renew`,
      headers: robotHeaders(),
      payload: {
        requestId: randomUUID(),
        expectedLeaseExpiresAt: task.leaseExpiresAt,
        leaseSeconds: 300
      },
    });
    expect(renewed.statusCode).toBe(404);

    const completed = await app.inject({
      method: "POST",
      url: `/api/v1/robot/review-tasks/${task.assignmentId}/complete`,
      headers: robotHeaders(),
      payload: completionPayload(task),
    });
    expect(completed.statusCode).toBe(404);

    const opinions = await database.query<{ count: number | string }>(sql`
      SELECT count(*)::integer AS count FROM review_opinions
    `);
    expect(Number(opinions[0]?.count ?? -1)).toBe(0);
  });

  it("领取记录属于旧审核轮次时，续租和完成都按不存在处理", async () => {
    const { app, database } = await makeRobotApp();
    await createPendingProblem(app);
    const task = await claimOne(app);
    const nextRoundId = randomUUID();
    await database.transaction(async (transaction) => {
      await transaction.execute(sql`
        UPDATE review_rounds
        SET status = 'rejected',
            decided_by_user_id = 0,
            decision_reason = '公开构造的旧轮次测试',
            decision_source = 'manual',
            decided_at = now()
        WHERE problem_id = ${BigInt(task.problem.id)} AND round = ${task.problem.reviewRound}
      `);
      await transaction.execute(sql`
        INSERT INTO review_rounds (
          id, problem_id, round, submitted_revision_id, status,
          rule_id, rule_version, rule_settings, submitted_by_user_id
        )
        SELECT ${nextRoundId}::uuid, problem_id, ${task.problem.reviewRound + 1},
               submitted_revision_id, 'open', rule_id, rule_version, rule_settings,
               submitted_by_user_id
        FROM review_rounds
        WHERE problem_id = ${BigInt(task.problem.id)} AND round = ${task.problem.reviewRound}
      `);
      await transaction.execute(sql`
        UPDATE problems
        SET current_review_round = ${task.problem.reviewRound + 1}
        WHERE id = ${BigInt(task.problem.id)}
      `);
    });

    const renewed = await app.inject({
      method: "POST",
      url: `/api/v1/robot/review-tasks/${task.assignmentId}/renew`,
      headers: robotHeaders(),
      payload: {
        requestId: randomUUID(),
        expectedLeaseExpiresAt: task.leaseExpiresAt,
        leaseSeconds: 300
      },
    });
    expect(renewed.statusCode).toBe(404);
    const completed = await app.inject({
      method: "POST",
      url: `/api/v1/robot/review-tasks/${task.assignmentId}/complete`,
      headers: robotHeaders(),
      payload: completionPayload(task),
    });
    expect(completed.statusCode).toBe(404);
  });

  it("机器人即使获得组长角色也保留固定禁止项", async () => {
    const { app, database, store } = await makeRobotApp();
    await database.execute(sql`
      INSERT INTO role_memberships (id, user_id, role_id, granted_by_user_id, reason)
      SELECT ${randomUUID()}::uuid, ${BigInt(databaseDemoUserIds.robot)}, role.id, 0, '测试：误授组长角色'
      FROM roles role WHERE role.key = 'leader'
    `);
    const robotUser = await store.getUser(databaseDemoUserIds.robot);
    if (robotUser === undefined) throw new Error("缺少机器人演示账号。");
    const now = new Date();
    expect(hasPermission(robotUser, "problem.status.change", {}, now)).toBe(true);
    for (const permission of [
      "problem.delete.all",
      "problem.delete.own",
      "user.delete",
      "user.impersonate",
      "user.permission.manage",
      "system.manage",
      "plugin.manage",
      "contest.delete"
    ]) {
      expect(hasPermission(robotUser, permission, {}, now)).toBe(false);
    }

    const problem = await createPendingProblem(app);
    const claimed = await app.inject({
      method: "POST",
      url: "/api/v1/robot/review-tasks/claim",
      headers: robotHeaders(),
      payload: {}
    });
    expect((claimed.json() as { items: unknown[] }).items).toHaveLength(1);
    expect(claimed.body).toContain(problem.id);
  });
});
