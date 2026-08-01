import { describe, expect, it } from "vitest";
import {
  applyReviewSuggestionsInputSchema,
  reviewInputSchema,
  reviewSchema,
  reviewSuggestionViewSchema
} from "../src";

const legacyReviewInput = {
  verdict: "approve",
  codeforcesDifficulty: 1200,
  qualityLevel: 3,
  thinkingLevel: 2,
  codingLevel: 1,
  tagIds: ["algorithm.implementation"],
  improvements: "补充边界情况说明。",
  expectedRound: 1
} as const;

describe("审核意见与建议契约", () => {
  it("保留 v1 机器人缺少原创性字段的输入兼容性", () => {
    const parsed = reviewInputSchema.parse(legacyReviewInput);
    expect(parsed.originalityLevel).toBeUndefined();
    expect(parsed.publicComment).toBeUndefined();
    expect(reviewInputSchema.parse({ ...legacyReviewInput, originalityLevel: 5 }))
      .toEqual(expect.objectContaining({ originalityLevel: 5 }));
    expect(reviewInputSchema.safeParse({
      ...legacyReviewInput,
      publicComment: "x".repeat(20_001)
    }).success).toBe(false);
  });

  it("公开审核记录明确把历史原创性序列化为 null", () => {
    const historical = {
      ...legacyReviewInput,
      originalityLevel: null,
      publicComment: "",
      privateNote: "",
      id: "opinion-1",
      problemId: "problem-1",
      reviewer: { id: "reviewer-1", nickname: "审题人", accountType: "human" },
      source: "human",
      createdAt: "2026-08-01T00:00:00.000Z",
      updatedAt: "2026-08-01T00:00:00.000Z"
    };
    expect(reviewSchema.parse(historical).originalityLevel).toBeNull();
    const { originalityLevel: _originalityLevel, ...missing } = historical;
    expect(reviewSchema.safeParse(missing).success).toBe(false);
  });

  it("写回请求只接受非空、不重复的固定字段名", () => {
    const valid = {
      expectedRound: 2,
      expectedRevision: 7,
      fields: ["codeforcesDifficulty", "tagIds"]
    } as const;
    expect(applyReviewSuggestionsInputSchema.parse(valid)).toEqual(valid);
    expect(applyReviewSuggestionsInputSchema.safeParse({ ...valid, fields: [] }).success)
      .toBe(false);
    expect(applyReviewSuggestionsInputSchema.safeParse({
      ...valid,
      fields: ["tagIds", "tagIds"]
    }).success).toBe(false);
    expect(applyReviewSuggestionsInputSchema.safeParse({
      ...valid,
      fields: ["qualityLevel"]
    }).success).toBe(false);
    expect(applyReviewSuggestionsInputSchema.safeParse({
      ...valid,
      usedOpinionIds: ["forged-opinion"]
    }).success).toBe(false);
    expect(applyReviewSuggestionsInputSchema.safeParse({
      ...valid,
      suggested: { codeforcesDifficulty: 3500 }
    }).success).toBe(false);
  });

  it("只读建议可展示质量和可空的历史原创性汇总", () => {
    const view = {
      round: 2,
      opinionCount: 2,
      current: {
        codeforcesDifficulty: null,
        thinkingLevel: null,
        codingLevel: null,
        tagIds: []
      },
      suggested: {
        codeforcesDifficulty: 1300,
        thinkingLevel: 3,
        codingLevel: 2,
        tagIds: ["algorithm.implementation"],
        qualityLevel: 4,
        originalityLevel: null
      },
      canApply: false
    };
    expect(reviewSuggestionViewSchema.parse(view)).toEqual(view);
  });
});
