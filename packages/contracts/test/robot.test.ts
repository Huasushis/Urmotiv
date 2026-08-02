import { describe, expect, it } from "vitest";
import {
  completeRobotReviewTaskInputSchema,
  robotReviewTaskSchema,
  renewRobotReviewTaskInputSchema
} from "../src";

const requestId = "3fa85f64-5717-4562-b3fc-2c963f66afa6";
const expectedLeaseExpiresAt = "2026-08-01T18:00:00.000Z";

describe("机器人操作请求契约", () => {
  it("续租和完成都要求调用方提供 UUID 请求标识", () => {
    const renewal = {
      requestId,
      expectedLeaseExpiresAt,
      leaseSeconds: 300
    };
    expect(renewRobotReviewTaskInputSchema.parse(renewal)).toEqual(renewal);
    expect(renewRobotReviewTaskInputSchema.safeParse({
      expectedLeaseExpiresAt,
      leaseSeconds: 300
    }).success).toBe(false);

    const completion = {
      requestId,
      expectedLeaseExpiresAt,
      expectedProblemRevision: 1,
      expectedTagCatalogVersion: 7,
      experimentVersion: "experiment-2026-08",
      modelProfileName: "review-balanced",
      review: {
        verdict: "approve",
        codeforcesDifficulty: 1200,
        qualityLevel: 3,
        thinkingLevel: 2,
        codingLevel: 1,
        tagIds: ["basic.simulation"],
        improvements: "无需修改。",
        expectedRound: 1
      }
    };
    expect(completeRobotReviewTaskInputSchema.parse(completion)).toMatchObject(completion);
    const { requestId: _requestId, ...missingRequestId } = completion;
    expect(completeRobotReviewTaskInputSchema.safeParse(missingRequestId).success).toBe(false);
  });

  it("领取快照只含完整题面题解、公开样例、资源限制和启用标签目录", () => {
    const task = {
      assignmentId: requestId,
      leaseExpiresAt: expectedLeaseExpiresAt,
      problem: {
        id: "problem-1",
        revision: 2,
        reviewRound: 1,
        contentHash: "a".repeat(64),
        title: "合成题",
        type: "traditional",
        tagIds: ["basic.simulation"],
        content: {
          basicStatement: "合成题面",
          basicSolution: "合成题解",
          background: "",
          statement: "",
          inputFormat: "",
          outputFormat: "",
          constraints: "",
          solution: "",
          hints: ""
        },
        samples: [{ safeId: "sample-001", input: "1\n", output: "1\n", explanation: "" }],
        limits: { timeMs: 1_000, memoryMiB: 256 }
      },
      tagCatalog: {
        version: 7,
        tags: [{
          id: "basic.simulation",
          name: "模拟",
          categoryId: "basic",
          categoryName: "基础算法",
          description: "按题意实现",
          aliases: [],
          active: true
        }]
      },
      reviewItems: []
    };
    expect(robotReviewTaskSchema.parse(task)).toEqual(task);
    expect(robotReviewTaskSchema.safeParse({
      ...task,
      problem: {
        ...task.problem,
        testcases: [{ input: "private/input.txt" }]
      }
    }).success).toBe(false);
  });
});
