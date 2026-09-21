import { afterEach, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import {
  createLocalDatabase,
  migrateDatabase,
  seedCoreDatabase,
  type LocalDatabaseHandle,
} from "@urmotiv/database";
import { sql } from "drizzle-orm";
import { DatabaseDataStore } from "../src/database-store";
import {
  seedDatabaseDemoData,
  databaseDemoUserIds as ids,
} from "../src/database-demo";
import { createProblemVisibility } from "../src/permissions";
import { ReviewEmailService, enqueueReviewEmail } from "../src/review-email";
import { createApp } from "../src/app";
import { ProblemService } from "../src/service";
import type { StoredProblem, StoredReview } from "../src/domain";
const databases: LocalDatabaseHandle[] = [];
afterEach(async () => {
  for (const db of databases.splice(0)) await db.close();
});
async function fixture() {
  const db = createLocalDatabase();
  databases.push(db);
  await migrateDatabase(db);
  await seedCoreDatabase(db);
  await seedDatabaseDemoData(db);
  const store = new DatabaseDataStore(db),
    mail = new ReviewEmailService(db, store);
  const create = () =>
    store.createProblem({
      id: "unused",
      title: "合成计数测试",
      type: "traditional",
      tagIds: ["catalog.tag.02.09"],
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
      samples: [],
      status: "pending_review",
      ownerId: ids.author,
      revision: 1,
      reviewRound: 1,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    } as StoredProblem);
  const opinion = (
    problemId: string,
    verdict: StoredReview["verdict"] = "approve",
    reviewerId: string = ids.reviewer,
  ): StoredReview => ({
    id: randomUUID(),
    problemId,
    reviewerId,
    reviewer: {
      id: reviewerId,
      nickname: "合成人员",
      accountType: reviewerId === ids.robot ? "robot" : "human",
    },
    source: reviewerId === ids.robot ? "fermata" : "human",
    verdict,
    codeforcesDifficulty: 1200,
    thinkingLevel: 2,
    codingLevel: 2,
    qualityLevel: 3,
    originalityLevel: 3,
    tagIds: [],
    improvements: "内部合成建议不得入邮件",
    publicComment: "",
    privateNote: "秘密合成记录",
    expectedRound: 1,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });
  const put = (review: StoredReview) =>
    store.runProblemTransaction(review.problemId, (tx) =>
      tx.upsertReview(review),
    );
  return { db, store, mail, create, opinion, put };
}
it("数量按题去重、一致率排除待审/需修改/旧轮次；过滤仍尊重题目可见性", async () => {
  const { db, store, create, opinion, put } = await fixture();
  const problems: StoredProblem[] = [];
  for (let i = 0; i < 5; i++) problems.push(await create());
  const [match, miss, changes, pending, unreviewed] = problems as [
    StoredProblem,
    StoredProblem,
    StoredProblem,
    StoredProblem,
    StoredProblem,
  ];
  const first = opinion(match.id);
  await put(first);
  await put({ ...first, improvements: "修改不重复计数" });
  await put(opinion(miss.id, "approve"));
  await put(opinion(changes.id, "request_changes"));
  await put(opinion(pending.id));
  await put(opinion(unreviewed.id, "approve", ids.robot));
  const service = new ProblemService(store),
    root = (await store.getUser("0"))!;
  for (const p of [match, miss, changes])
    await service.finalizeReview(root, p.id, {
      decision: p === match ? "approve" : "reject",
      expectedRound: 1,
      expectedRevision: 1,
      reason: "合成终审结果",
    });
  expect(
    (
      await db.query<{ count: number }>(
        sql`SELECT count(*)::int AS count FROM review_email_outbox WHERE kind IN ('approved','rejected')`,
      )
    )[0]!.count,
  ).toBe(3);
  expect(await store.getReviewerStatistics(ids.reviewer)).toEqual({
    reviewed: 4,
    decided: 2,
    matched: 1,
    accuracy: 0.5,
  });
  expect(await store.getReviewerStatistics(ids.robot)).toEqual({
    reviewed: 0,
    decided: 0,
    matched: 0,
    accuracy: null,
  });
  const board = await store.listReviewerLeaderboard({
    sort: "accuracy",
    page: 1,
    pageSize: 20,
  });
  expect(board.total).toBe(1);
  expect(board.items[0]!.id).toBe(ids.reviewer);
  const filter = {
    page: 1,
    pageSize: 20,
    search: "",
    owner: "all",
    sort: "updated_desc",
    reviewByMe: "unreviewed",
  } as const;
  const reviewer = (await store.getUser(ids.reviewer))!;
  const { reviewByMe: _reviewByMe, ...allFilter } = filter;
  const allPage = await store.listVisibleProblems(
    allFilter,
    createProblemVisibility(reviewer),
  );
  expect(allPage.reviewCounts?.[match.id]).toEqual({
    approve: 1,
    reject: 0,
    requestChanges: 0,
    ai: 0,
  });
  expect(allPage.reviewCounts?.[changes.id]).toEqual({
    approve: 0,
    reject: 0,
    requestChanges: 1,
    ai: 0,
  });
  expect(allPage.reviewCounts?.[unreviewed.id]).toEqual({
    approve: 0,
    reject: 0,
    requestChanges: 0,
    ai: 1,
  });
  expect(
    (
      await store.listVisibleProblems(filter, createProblemVisibility(reviewer))
    ).items.map((p) => p.id),
  ).toEqual([unreviewed.id]);
  const denied = (await store.getUser(ids.denied))!;
  expect(
    (await store.listVisibleProblems(filter, createProblemVisibility(denied)))
      .total,
  ).toBe(0);
  // 新轮次不能沿用上一轮的“已审”或一致率。
  await db.execute(
    sql`UPDATE problems SET current_review_round=2,status='pending_review' WHERE id=${BigInt(match.id)}`,
  );
  expect((await store.getReviewerStatistics(ids.reviewer)).decided).toBe(1);
  expect(
    (
      await store.listVisibleProblems(filter, createProblemVisibility(reviewer))
    ).items.map((p) => p.id),
  ).toContain(match.id);
  await db.execute(
    sql`UPDATE users SET disabled_at=now() WHERE id=${BigInt(ids.reviewer)}`,
  );
  expect(
    (
      await store.listReviewerLeaderboard({
        sort: "reviewed",
        page: 1,
        pageSize: 20,
      })
    ).total,
  ).toBe(0);
});
it("审核和事务同成同败、更新不重复；验证邮箱、偏好、重试与安全摘要", async () => {
  const { db, store, mail, create, opinion, put } = await fixture(),
    p = await create();
  const r = opinion(p.id);
  await put(r);
  await put(r);
  expect(
    (
      await db.query<{ count: number }>(
        sql`SELECT count(*)::int AS count FROM review_email_outbox`,
      )
    )[0]!.count,
  ).toBe(1);
  await expect(
    store.runProblemTransaction(p.id, (tx) => {
      tx.upsertReview(opinion(p.id, "approve", ids.member));
      throw Error("rollback");
    }),
  ).rejects.toThrow("rollback");
  expect(
    (
      await db.query<{ count: number }>(
        sql`SELECT count(*)::int AS count FROM review_email_outbox`,
      )
    )[0]!.count,
  ).toBe(1);
  expect(await mail.preferences(ids.author)).toEqual({
    newReview: true,
    approved: true,
    rejected: true,
  });
  await db.execute(
    sql`INSERT INTO user_emails(id,user_id,address,normalized_address,is_primary,verified_at) VALUES(${randomUUID()}::uuid,${BigInt(ids.author)},'synthetic@example.test','synthetic@example.test',true,now())`,
  );
  const send = vi
    .fn()
    .mockRejectedValueOnce(new Error("sensitive-provider-response"))
    .mockResolvedValue(undefined);
  await mail.deliverBatch(send, async () => "https://example.test");
  expect(send).toHaveBeenCalledTimes(1);
  expect(
    (
      await db.query<{ completed_at: unknown }>(
        sql`SELECT completed_at FROM review_email_outbox`,
      )
    )[0]!.completed_at,
  ).toBeNull();
  await db.execute(sql`UPDATE review_email_outbox SET available_at=now()`);
  await mail.deliverBatch(send, async () => "https://example.test");
  expect(send).toHaveBeenCalledTimes(2);
  expect(send.mock.calls[1]![0]).toMatchObject({
    kind: "newReview",
    url: `https://example.test/problems/${p.id}?tab=reviews`,
  });
  expect(JSON.stringify(send.mock.calls)).not.toContain("内部合成建议");
  expect(JSON.stringify(send.mock.calls)).not.toContain("秘密合成记录");
  await mail.savePreferences(ids.author, {
    newReview: false,
    approved: true,
    rejected: false,
  });
  await enqueueReviewEmail(db, p.id, "rejected", "rejected-test");
  await enqueueReviewEmail(db, p.id, "approved", "approved-test");
  await mail.deliverBatch(send, async () => "https://example.test");
  expect(send).toHaveBeenCalledTimes(3);
  expect(send.mock.calls[2]![0].kind).toBe("approved");
  // 发送前撤销访问权或换成未验证邮箱，不泄露题目存在。
  await db.execute(
    sql`UPDATE user_emails SET verified_at=NULL WHERE user_id=${BigInt(ids.author)}`,
  );
  await enqueueReviewEmail(db, p.id, "approved", "unverified");
  await mail.deliverBatch(send, async () => "https://example.test");
  expect(send).toHaveBeenCalledTimes(3);
  await db.execute(
    sql`UPDATE user_emails SET verified_at=now() WHERE user_id=${BigInt(ids.author)}`,
  );
  await db.execute(
    sql`UPDATE users SET disabled_at=now() WHERE id=${BigInt(ids.author)}`,
  );
  await enqueueReviewEmail(db, p.id, "approved", "disabled");
  await mail.deliverBatch(send, async () => "https://example.test");
  expect(send).toHaveBeenCalledTimes(3);
});
it("个人偏好接口只能修改自己，拒绝匿名/机器人/跨站请求；榜单不返回题目和私密意见", async () => {
  const { db, store, mail, create, opinion, put } = await fixture();
  const p = await create();
  await put(opinion(p.id));
  const app = await createApp({
    store,
    reviewEmail: mail,
    demoAuthEnabled: true,
    demoUserIds: Object.values(ids),
    demoLoginUserIds: ids,
  });
  try {
    expect(
      (await app.inject({ url: "/api/v1/me/email-notifications" })).statusCode,
    ).toBe(401);
    const login = await app.inject({
      method: "POST",
      url: "/api/v1/auth/demo-login",
      headers: { origin: "http://localhost:5173" },
      payload: { userId: "author" },
    });
    const cookie = String(login.headers["set-cookie"]).split(";")[0]!;
    expect(
      (
        await app.inject({
          url: "/api/v1/me/email-notifications",
          headers: { cookie },
        })
      ).json(),
    ).toEqual({ newReview: true, approved: true, rejected: true });
    const payload = { newReview: false, approved: true, rejected: false };
    expect(
      (
        await app.inject({
          method: "PUT",
          url: "/api/v1/me/email-notifications",
          headers: { cookie, origin: "https://evil.test" },
          payload,
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await app.inject({
          method: "PUT",
          url: "/api/v1/me/email-notifications",
          headers: { cookie, origin: "http://localhost:5173" },
          payload: { ...payload, userId: ids.reviewer },
        })
      ).statusCode,
    ).toBe(422);
    expect(
      (
        await app.inject({
          method: "PUT",
          url: "/api/v1/me/email-notifications",
          headers: { cookie, origin: "http://localhost:5173" },
          payload,
        })
      ).statusCode,
    ).toBe(200);
    expect(await mail.preferences(ids.reviewer)).toEqual({
      newReview: true,
      approved: true,
      rejected: true,
    });
    const robotSession = await store.createSession(
      ids.robot,
      new Date(Date.now() + 60000).toISOString(),
    );
    expect(
      (
        await app.inject({
          url: "/api/v1/me/email-notifications",
          headers: { cookie: `urmotiv_session=${robotSession.id}` },
        })
      ).statusCode,
    ).toBe(404);
    const leaderboard = await app.inject({
      url: "/api/v1/leaderboard/reviewers",
    });
    expect(leaderboard.statusCode).toBe(200);
    expect(leaderboard.body).not.toContain("合成计数测试");
    expect(leaderboard.body).not.toContain("内部合成建议");
    expect(
      (await app.inject({ url: "/api/v1/me/review-statistics" })).statusCode,
    ).toBe(401);
  } finally {
    await app.close();
  }
});
