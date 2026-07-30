import { readFileSync } from "node:fs";
import { pluginManifestSchema, type ReviewOpinion } from "@urmotiv/plugin-sdk";
import { describe, expect, it } from "vitest";
import {
  defaultReviewDecisionRule,
  defaultReviewRuleSettingsSchema
} from "../src";

function opinion(
  id: string,
  reviewerId: string,
  verdict: ReviewOpinion["verdict"],
  overrides: Partial<ReviewOpinion> = {}
): ReviewOpinion {
  return {
    id,
    reviewRound: 1,
    reviewerId,
    reviewerAccountType: "human",
    verdict,
    source: "human",
    reviewerCanReview: true,
    updatedAt: "2026-07-25T00:00:00.000Z",
    ...overrides
  };
}

describe("default review rule", () => {
  it("approves after two valid human approvals", async () => {
    const decision = await defaultReviewDecisionRule.evaluate(
      {
        problemId: "problem-1",
        round: 1,
        contentHash: "a".repeat(64),
        opinions: [
          opinion("one", "reviewer-1", "approve"),
          opinion("two", "reviewer-2", "approve")
        ],
        reviewItems: []
      },
      defaultReviewRuleSettingsSchema.parse({})
    );
    expect(decision.decision).toBe("approve");
  });

  it("rejects when the default allowed rejection count is exceeded", async () => {
    const decision = await defaultReviewDecisionRule.evaluate(
      {
        problemId: "problem-1",
        round: 1,
        contentHash: "a".repeat(64),
        opinions: [
          opinion("one", "reviewer-1", "approve"),
          opinion("two", "reviewer-2", "approve"),
          opinion("three", "reviewer-3", "reject")
        ],
        reviewItems: []
      },
      defaultReviewRuleSettingsSchema.parse({})
    );
    expect(decision.decision).toBe("reject");
  });

  it("ignores old rounds, removed reviewers and robots by default", async () => {
    const decision = await defaultReviewDecisionRule.evaluate(
      {
        problemId: "problem-1",
        round: 2,
        contentHash: "a".repeat(64),
        opinions: [
          opinion("old", "reviewer-1", "approve", { reviewRound: 1 }),
          opinion("removed", "reviewer-2", "approve", {
            reviewRound: 2,
            reviewerCanReview: false
          }),
          opinion("robot", "robot-1", "approve", {
            reviewRound: 2,
            reviewerAccountType: "robot",
            source: "fermata"
          })
        ],
        reviewItems: []
      },
      defaultReviewRuleSettingsSchema.parse({})
    );
    expect(decision.decision).toBe("pending");
    expect(decision.usedOpinionIds).toEqual([]);
  });

  it("uses only the latest opinion from one reviewer", async () => {
    const decision = await defaultReviewDecisionRule.evaluate(
      {
        problemId: "problem-1",
        round: 1,
        contentHash: "a".repeat(64),
        opinions: [
          opinion("old", "reviewer-1", "reject", { updatedAt: "2026-07-25T00:00:00.000Z" }),
          opinion("new", "reviewer-1", "approve", { updatedAt: "2026-07-25T01:00:00.000Z" }),
          opinion("other", "reviewer-2", "approve")
        ],
        reviewItems: []
      },
      defaultReviewRuleSettingsSchema.parse({})
    );
    expect(decision.decision).toBe("approve");
    expect(decision.usedOpinionIds).toContain("new");
    expect(decision.usedOpinionIds).not.toContain("old");
  });
});

describe("plugin files", () => {
  it("has a compatible manifest", () => {
    const path = new URL("../urmotiv-plugin.json", import.meta.url);
    const manifest = JSON.parse(readFileSync(path, "utf8"));
    expect(pluginManifestSchema.parse(manifest).apiVersion).toBe("1");
  });

  it("keeps the documented default settings", () => {
    const path = new URL("../settings.schema.json", import.meta.url);
    const settings = JSON.parse(readFileSync(path, "utf8")) as {
      properties: Record<string, { default: unknown }>;
    };
    expect(settings.properties.requiredApprovals?.default).toBe(2);
    expect(settings.properties.maximumRejections?.default).toBe(0);
    expect(settings.properties.countRobotReviews?.default).toBe(false);
  });
});
