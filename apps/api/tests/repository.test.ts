import { describe, expect, it } from "vitest";
import { createDemoUsers, demoTags } from "../src/demo-data";
import type { StoredProblem, StoredReview } from "../src/domain";
import { createProblemVisibility } from "../src/permissions";
import { InMemoryDataStore } from "../src/repository";

const createdAt = "2026-07-26T00:00:00.000Z";

function pendingProblem(): StoredProblem {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    title: "事务测试题",
    type: "traditional",
    tagIds: ["algorithm.implementation"],
    codeforcesDifficulty: null,
    thinkingLevel: null,
    codingLevel: null,
    content: {
      basicStatement: "题面",
      basicSolution: "题解",
      background: "",
      statement: "",
      inputFormat: "",
      outputFormat: "",
      constraints: "",
      solution: "",
      hints: ""
    },
    samples: [],
    status: "pending_review",
    ownerId: "author",
    revision: 1,
    reviewRound: 1,
    createdAt,
    updatedAt: createdAt
  };
}

function review(): StoredReview {
  return {
    id: "22222222-2222-4222-8222-222222222222",
    problemId: "11111111-1111-4111-8111-111111111111",
    reviewerId: "reviewer",
    reviewer: { id: "reviewer", nickname: "审题人演示账号", accountType: "human" },
    source: "human",
    verdict: "approve",
    codeforcesDifficulty: 1200,
    qualityLevel: 3,
    thinkingLevel: 2,
    codingLevel: 1,
    tagIds: [],
    improvements: "补充说明。",
    privateNote: "私密备注",
    expectedRound: 1,
    createdAt,
    updatedAt: createdAt
  };
}

describe("内存存储事务", () => {
  it("题目状态冲突时不保留同一事务写入的审核意见", async () => {
    const users = createDemoUsers();
    const store = new InMemoryDataStore(users, demoTags);
    const problem = pendingProblem();
    await store.createProblem(problem);

    await expect(
      store.runProblemTransaction(problem.id, (transaction) => {
        transaction.upsertReview(review());
        const changed = transaction.replaceProblem(
          { ...problem, status: "approved", revision: 2 },
          99
        );
        if (!changed) {
          throw new Error("模拟修订冲突");
        }
      })
    ).rejects.toThrow("模拟修订冲突");

    expect(await store.listReviews(problem.id, 1)).toEqual([]);
    const author = users.find((user) => user.id === "author");
    if (author === undefined) {
      throw new Error("缺少投稿人演示账号");
    }
    const stored = await store.findVisibleProblem(problem.id, createProblemVisibility(author));
    expect(stored).toEqual(expect.objectContaining({ status: "pending_review", revision: 1 }));
  });

  it("整组修改完成前发生错误时同时回滚题目状态和审核意见", async () => {
    const users = createDemoUsers();
    const store = new InMemoryDataStore(users, demoTags);
    const problem = pendingProblem();
    await store.createProblem(problem);

    await expect(
      store.runProblemTransaction(problem.id, (transaction) => {
        transaction.upsertReview(review());
        expect(
          transaction.replaceProblem(
            { ...problem, status: "approved", revision: 2 },
            problem.revision
          )
        ).toBe(true);
        throw new Error("模拟提交前失败");
      })
    ).rejects.toThrow("模拟提交前失败");

    expect(await store.listReviews(problem.id, 1)).toEqual([]);
    const author = users.find((user) => user.id === "author");
    if (author === undefined) {
      throw new Error("缺少投稿人演示账号");
    }
    const stored = await store.findVisibleProblem(problem.id, createProblemVisibility(author));
    expect(stored).toEqual(expect.objectContaining({ status: "pending_review", revision: 1 }));
  });
});
