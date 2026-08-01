import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createLocalDatabase,
  type LocalDatabaseHandle,
  migrateDatabase,
  seedCoreDatabase,
} from "@urmotiv/database";
import { sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app";
import { databaseDemoUserIds, seedDatabaseDemoData } from "../src/database-demo";
import { DatabaseDataStore } from "../src/database-store";
import type { ProblemListFilters, StoredProblem, StoredReview, StoredUser } from "../src/domain";
import { createProblemVisibility } from "../src/permissions";
import { ProblemService } from "../src/service";

const createdAt = "2026-07-26T00:00:00.000Z";
const listFilters: ProblemListFilters = {
  page: 1,
  pageSize: 20,
  search: "",
  owner: "all",
  sort: "updated_desc",
};

let temporaryDirectory = "";
const openDatabases = new Set<LocalDatabaseHandle>();

beforeEach(async () => {
  temporaryDirectory = await mkdtemp(join(tmpdir(), "urmotiv-api-database-"));
});

afterEach(async () => {
  await Promise.all([...openDatabases].map((database) => database.close()));
  openDatabases.clear();
  await rm(temporaryDirectory, { recursive: true, force: true });
});

async function openDatabase(initialize: boolean): Promise<LocalDatabaseHandle> {
  const database = createLocalDatabase({ dataDirectory: join(temporaryDirectory, "database") });
  openDatabases.add(database);
  if (initialize) {
    await migrateDatabase(database);
    await seedCoreDatabase(database);
    await seedDatabaseDemoData(database);
  }
  return database;
}

async function closeDatabase(database: LocalDatabaseHandle): Promise<void> {
  openDatabases.delete(database);
  await database.close();
}

function requireUser(user: StoredUser | undefined): StoredUser {
  if (user === undefined) {
    throw new Error("缺少数据库演示用户。");
  }
  return user;
}

function problem(overrides: Partial<StoredProblem> = {}): StoredProblem {
  return {
    id: randomUUID(),
    title: "公开构造的数据库测试题",
    type: "traditional",
    tagIds: ["algorithm.implementation"],
    codeforcesDifficulty: 1200,
    thinkingLevel: 2,
    codingLevel: 2,
    content: {
      basicStatement: "给定一个整数。",
      basicSolution: "直接输出。",
      background: "",
      statement: "",
      inputFormat: "",
      outputFormat: "",
      constraints: "",
      solution: "",
      hints: "",
    },
    samples: [
      {
        id: randomUUID(),
        input: "1\n",
        output: "1\n",
        explanation: "",
      },
    ],
    status: "draft",
    ownerId: databaseDemoUserIds.author,
    revision: 1,
    reviewRound: 0,
    createdAt,
    updatedAt: createdAt,
    ...overrides,
  };
}

describe("数据库题目仓库", () => {
  it("持久化邮箱凭据、一次性 CAS 状态和 authRevision 会话撤销", async () => {
    const database = await openDatabase(true);
    const store = new DatabaseDataStore(database);
    const created = await store.registerEmailUser({
      normalizedEmail: "auth.user@example.test",
      displayEmail: "auth.user@example.test",
      passwordHash: "$argon2id$v=19$m=19456,t=2,p=1$example$example",
      nickname: "认证测试用户"
    });
    expect(created).toBeDefined();
    expect(
      await store.registerEmailUser({
        normalizedEmail: "auth.user@example.test",
        displayEmail: "auth.user@example.test",
        passwordHash: "$argon2id$v=19$m=19456,t=2,p=1$example$example",
        nickname: "重复邮箱"
      })
    ).toBeUndefined();
    const credential = await store.findEmailCredential("auth.user@example.test");
    expect(credential).toBeUndefined();
    await store.replaceEmailVerificationToken({
      userId: created!.id,
      normalizedEmail: "auth.user@example.test",
      tokenDigest: "b".repeat(64),
      expiresAt: "2026-12-01T00:00:00.000Z"
    });
    expect(
      await store.consumeEmailVerificationToken("b".repeat(64), "2026-07-26T00:00:00.000Z")
    ).toBe(created!.id);
    expect(
      await store.consumeEmailVerificationToken("b".repeat(64), "2026-07-26T00:00:01.000Z")
    ).toBeUndefined();
    expect((await store.findEmailCredential("auth.user@example.test"))?.user.id).toBe(created?.id);
    await store.replaceEmailVerificationToken({
      userId: created!.id,
      normalizedEmail: "auth.user@example.test",
      tokenDigest: "c".repeat(64),
      expiresAt: "2026-07-25T23:59:59.000Z"
    });
    expect(
      await store.consumeEmailVerificationToken("c".repeat(64), "2026-07-26T00:00:00.000Z")
    ).toBeUndefined();

    const session = await store.createSession(created!.id, "2026-12-01T00:00:00.000Z");
    expect(await store.getSession(session.id)).toEqual(expect.objectContaining({ userId: created!.id }));
    await store.putLoginState("a".repeat(64), "2026-12-01T00:00:00.000Z");
    expect(await store.consumeLoginState("a".repeat(64), "2026-07-26T00:00:00.000Z")).toBe(true);
    expect(await store.consumeLoginState("a".repeat(64), "2026-07-26T00:00:01.000Z")).toBe(false);

    await store.revokeUserSessions(created!.id);
    expect(await store.getSession(session.id)).toBeUndefined();
  });

  it("演示登录只接受明确列出的人工账号", async () => {
    const database = await openDatabase(true);
    const app = await createApp({
      store: new DatabaseDataStore(database),
      demoAuthEnabled: true,
      demoUserIds: Object.values(databaseDemoUserIds),
      demoLoginUserIds: databaseDemoUserIds,
    });
    try {
      const rootLogin = await app.inject({
        method: "POST",
        url: "/api/v1/auth/demo-login",
        headers: { origin: "http://localhost:5173" },
        payload: { userId: "0" },
      });
      expect(rootLogin.statusCode).toBe(401);

      const unknownLogin = await app.inject({
        method: "POST",
        url: "/api/v1/auth/demo-login",
        headers: { origin: "http://localhost:5173" },
        payload: { userId: "not-listed" },
      });
      expect(unknownLogin.statusCode).toBe(401);

      const authorLogin = await app.inject({
        method: "POST",
        url: "/api/v1/auth/demo-login",
        headers: { origin: "http://localhost:5173" },
        payload: { userId: "author" },
      });
      expect(authorLogin.statusCode).toBe(200);
    } finally {
      await app.close();
    }
  });

  it("关闭并重新打开数据库后仍能读取题目", async () => {
    const firstDatabase = await openDatabase(true);
    const firstStore = new DatabaseDataStore(firstDatabase);
    const created = await firstStore.createProblem(problem());
    await closeDatabase(firstDatabase);

    const reopenedDatabase = await openDatabase(false);
    const reopenedStore = new DatabaseDataStore(reopenedDatabase);
    const author = await reopenedStore.getUser(databaseDemoUserIds.author);
    const stored = await reopenedStore.findVisibleProblem(
      created.id,
      createProblemVisibility(requireUser(author)),
    );
    expect(stored).toEqual(expect.objectContaining({ id: created.id, title: created.title }));
  });

  it("在查询和分页前排除无权题目，详情也不说明题目是否存在", async () => {
    const database = await openDatabase(true);
    const store = new DatabaseDataStore(database);
    const created = await store.createProblem(problem());
    const visibleToReviewer = await store.createProblem(problem({ title: "没有单题拒绝的测试题" }));
    const denied = await store.getUser(databaseDemoUserIds.denied);
    const visibility = createProblemVisibility(requireUser(denied));

    expect(await store.listVisibleProblems(listFilters, visibility)).toEqual({
      items: [],
      total: 0,
    });
    expect(await store.findVisibleProblem(created.id, visibility)).toBeUndefined();
    expect(await store.findVisibleProblem("9223372036854775808", visibility)).toBeUndefined();

    await database.execute(sql`
      INSERT INTO permission_grants (
        id,
        subject_user_id,
        permission_name,
        effect,
        scope,
        object_type,
        object_id,
        granted_by_user_id,
        reason
      ) VALUES (
        ${randomUUID()}::uuid,
        ${BigInt(databaseDemoUserIds.reviewer)},
        'problem.view.all',
        'deny',
        'object',
        'problem',
        ${created.id},
        0,
        '验证单题拒绝优先于角色允许'
      )
    `);
    const restrictedReviewer = requireUser(await store.getUser(databaseDemoUserIds.reviewer));
    const restrictedVisibility = createProblemVisibility(restrictedReviewer);
    const restrictedPage = await store.listVisibleProblems(listFilters, restrictedVisibility);
    expect(restrictedPage.total).toBe(1);
    expect(restrictedPage.items.map((item) => item.id)).toEqual([visibleToReviewer.id]);
    expect(await store.findVisibleProblem(created.id, restrictedVisibility)).toBeUndefined();

    const mismatchedGrantUserId = 8_000_000_000_000_001n;
    await database.execute(sql`
      INSERT INTO users (id, nickname)
      VALUES (${mismatchedGrantUserId}, '对象类别不匹配测试账号')
    `);
    await database.execute(sql`
      INSERT INTO permission_grants (
        id,
        subject_user_id,
        permission_name,
        effect,
        scope,
        object_type,
        object_id,
        granted_by_user_id,
        reason
      ) VALUES (
        ${randomUUID()}::uuid,
        ${mismatchedGrantUserId},
        'problem.view.all',
        'allow',
        'object',
        'contest',
        ${created.id},
        0,
        '验证组题方案授权不会变成题目授权'
      )
    `);
    const mismatchedGrantUser = requireUser(await store.getUser(mismatchedGrantUserId.toString()));
    expect(
      await store.findVisibleProblem(created.id, createProblemVisibility(mismatchedGrantUser)),
    ).toBeUndefined();
  });

  it("只接受当前修订号，过期保存不会覆盖较新的内容", async () => {
    const database = await openDatabase(true);
    const store = new DatabaseDataStore(database);
    const created = await store.createProblem(problem());
    const firstUpdate = {
      ...created,
      title: "第一次修改",
      revision: 2,
      updatedAt: "2026-07-26T00:01:00.000Z",
    };
    const staleUpdate = {
      ...created,
      title: "过期修改",
      revision: 2,
      updatedAt: "2026-07-26T00:02:00.000Z",
    };

    expect(await store.replaceProblem(firstUpdate, 1, databaseDemoUserIds.author)).toBe(true);
    expect(await store.replaceProblem(staleUpdate, 1, databaseDemoUserIds.author)).toBe(false);

    const author = await store.getUser(databaseDemoUserIds.author);
    const stored = await store.findVisibleProblem(
      created.id,
      createProblemVisibility(requireUser(author)),
    );
    expect(stored).toEqual(expect.objectContaining({ title: "第一次修改", revision: 2 }));
  });

  it("迁移前审核意见缺少原创性时按 null 持久化和读取", async () => {
    const database = await openDatabase(true);
    const store = new DatabaseDataStore(database);
    const pending = await store.createProblem(
      problem({ status: "pending_review", reviewRound: 1 }),
    );
    const historicalReview: StoredReview = {
      id: randomUUID(),
      problemId: pending.id,
      reviewerId: databaseDemoUserIds.reviewer,
      reviewer: {
        id: databaseDemoUserIds.reviewer,
        nickname: "审题人演示账号",
        accountType: "human",
      },
      source: "human",
      verdict: "approve",
      codeforcesDifficulty: 1200,
      qualityLevel: 3,
      originalityLevel: null,
      thinkingLevel: 2,
      codingLevel: 1,
      tagIds: ["algorithm.implementation"],
      improvements: "历史审核意见没有原创性字段。",
      publicComment: "历史公开评论。",
      privateNote: "",
      expectedRound: 1,
      createdAt,
      updatedAt: createdAt,
    };

    await store.runProblemTransaction(pending.id, (transaction) => {
      transaction.upsertReview(historicalReview);
    });

    expect(await store.listReviews(pending.id, 1)).toEqual([
      expect.objectContaining({ id: historicalReview.id, originalityLevel: null }),
    ]);
  });

  it("审核建议写回在数据库事务中创建修订和安全审计", async () => {
    const database = await openDatabase(true);
    const store = new DatabaseDataStore(database);
    const service = new ProblemService(store, {
      now: () => new Date("2026-08-01T01:00:00.000Z")
    });
    const author = requireUser(await store.getUser(databaseDemoUserIds.author));
    const reviewer = requireUser(await store.getUser(databaseDemoUserIds.reviewer));
    const member = requireUser(await store.getUser(databaseDemoUserIds.member));
    const leader = requireUser(await store.getUser(databaseDemoUserIds.leader));
    const draft = await service.createProblem(author, {
      title: "公开构造的数据库审核建议测试题",
      type: "traditional",
      tagIds: ["string"],
      codeforcesDifficulty: 800,
      thinkingLevel: 1,
      codingLevel: 5,
      content: {
        basicStatement: "给定一个整数，输出它本身。",
        basicSolution: "直接输出输入即可。",
        background: "",
        statement: "",
        inputFormat: "",
        outputFormat: "",
        constraints: "",
        solution: "",
        hints: ""
      }
    });
    const pending = await service.submitProblem(author, draft.id, draft.revision);
    const baseReview = {
      verdict: "approve" as const,
      qualityLevel: 2,
      originalityLevel: 2,
      thinkingLevel: 2,
      codingLevel: 1,
      tagIds: ["algorithm.implementation"],
      improvements: "补充公开构造的边界说明。",
      publicComment: "公开评论。",
      privateNote: "数据库事务测试私密备注。",
      expectedRound: pending.reviewRound
    };
    await service.submitReview(reviewer, draft.id, {
      ...baseReview,
      codeforcesDifficulty: 1200
    });
    await service.submitReview(member, draft.id, {
      ...baseReview,
      codeforcesDifficulty: 1300,
      qualityLevel: 3,
      originalityLevel: 3,
      thinkingLevel: 3,
      codingLevel: 2,
      tagIds: ["dynamic-programming"]
    });
    const approved = await service.getProblem(leader, draft.id);
    expect(approved.status).toBe("approved");

    const applied = await service.applyReviewSuggestions(
      leader,
      draft.id,
      {
        expectedRound: approved.reviewRound,
        expectedRevision: approved.revision,
        fields: ["codeforcesDifficulty", "tagIds"]
      },
      randomUUID()
    );
    expect(applied).toEqual(expect.objectContaining({
      revision: approved.revision + 1,
      codeforcesDifficulty: 1300,
      tagIds: ["algorithm.implementation", "dynamic-programming"]
    }));

    const auditRows = await database.query<{
      action: string;
      object_id: string | null;
      metadata: unknown;
    }>(sql`
      SELECT action, object_id, metadata
      FROM audit_events
      WHERE action = 'problem.review.suggestions.apply'
    `);
    expect(auditRows).toHaveLength(1);
    const rawMetadata = auditRows[0]?.metadata;
    const metadata = typeof rawMetadata === "string"
      ? JSON.parse(rawMetadata) as unknown
      : rawMetadata;
    expect(auditRows[0]).toEqual(expect.objectContaining({ object_id: draft.id }));
    expect(metadata).toEqual({
      round: approved.reviewRound,
      previousRevision: approved.revision,
      nextRevision: approved.revision + 1,
      fields: ["codeforcesDifficulty", "tagIds"],
      opinionCount: 2
    });
    const serializedMetadata = JSON.stringify(metadata);
    expect(serializedMetadata).not.toContain("algorithm.implementation");
    expect(serializedMetadata).not.toContain(baseReview.privateNote);
    expect(serializedMetadata).not.toContain(baseReview.publicComment);
  });

  it("审核写入失败时同时回滚审核意见和题目状态", async () => {
    const database = await openDatabase(true);
    const store = new DatabaseDataStore(database);
    const pending = await store.createProblem(
      problem({ status: "pending_review", reviewRound: 1 }),
    );
    const review: StoredReview = {
      id: randomUUID(),
      problemId: pending.id,
      reviewerId: databaseDemoUserIds.reviewer,
      reviewer: {
        id: databaseDemoUserIds.reviewer,
        nickname: "审题人演示账号",
        accountType: "human",
      },
      source: "human",
      verdict: "approve",
      codeforcesDifficulty: 1200,
      qualityLevel: 3,
      originalityLevel: null,
      thinkingLevel: 2,
      codingLevel: 1,
      tagIds: ["not-a-real-tag"],
      improvements: "补充边界说明。",
      publicComment: "公开评论",
      privateNote: "人工构造的私密备注",
      expectedRound: 1,
      createdAt,
      updatedAt: createdAt,
    };

    await expect(
      store.runProblemTransaction(pending.id, (transaction) => {
        transaction.upsertReview(review);
        expect(
          transaction.replaceProblem(
            {
              ...pending,
              status: "approved",
              revision: 2,
              updatedAt: "2026-07-26T00:03:00.000Z",
            },
            1,
            databaseDemoUserIds.reviewer,
          ),
        ).toBe(true);
      }),
    ).rejects.toBeDefined();

    expect(await store.listReviews(pending.id, 1)).toEqual([]);
    const author = await store.getUser(databaseDemoUserIds.author);
    const stored = await store.findVisibleProblem(
      pending.id,
      createProblemVisibility(requireUser(author)),
    );
    expect(stored).toEqual(expect.objectContaining({ status: "pending_review", revision: 1 }));
  });
});
