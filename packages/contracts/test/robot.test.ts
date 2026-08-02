import { describe, expect, it } from "vitest";
import {
  completeRobotReviewTaskInputSchema,
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
      experimentVersion: "experiment-2026-08",
      modelProfileName: "review-balanced",
      review: {
        verdict: "approve",
        codeforcesDifficulty: 1200,
        qualityLevel: 3,
        thinkingLevel: 2,
        codingLevel: 1,
        tagIds: [],
        improvements: "无需修改。",
        expectedRound: 1
      }
    };
    expect(completeRobotReviewTaskInputSchema.parse(completion)).toMatchObject(completion);
    const { requestId: _requestId, ...missingRequestId } = completion;
    expect(completeRobotReviewTaskInputSchema.safeParse(missingRequestId).success).toBe(false);
  });
});
