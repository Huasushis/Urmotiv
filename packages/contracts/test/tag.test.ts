import { describe, expect, it } from "vitest";
import {
  createProblemInputSchema,
  normalizeTagName,
  reviewInputSchema,
  tagSchema,
  updateProblemInputSchema,
} from "../src";

describe("tag contracts", () => {
  it("normalizes names with NFKC, trimming, and case folding", () => {
    expect(normalizeTagName("  ＫＭＰ  ")).toBe("kmp");
  });

  it("requires at least one tag for problems while keeping review suggestions optional", () => {
    const draft = {
      title: "合成题",
      type: "traditional",
      content: { basicStatement: "合成题面", basicSolution: "合成题解" },
    };
    expect(createProblemInputSchema.safeParse(draft).success).toBe(false);
    expect(createProblemInputSchema.safeParse({ ...draft, tagIds: [] }).success).toBe(false);
    expect(updateProblemInputSchema.safeParse({ expectedRevision: 1, tagIds: [] }).success).toBe(
      false,
    );
    expect(
      reviewInputSchema.parse({
        verdict: "approve",
        codeforcesDifficulty: 1200,
        qualityLevel: 3,
        originalityLevel: 3,
        thinkingLevel: 2,
        codingLevel: 2,
        tagIds: [],
        improvements: "合成改进意见",
        expectedRound: 1,
      }).tagIds,
    ).toEqual([]);
  });

  it("expresses active state and category details for selectable leaves", () => {
    expect(
      tagSchema.parse({
        id: "catalog.tag.01.01",
        name: "变量操作",
        group: "基础",
        itemKind: "tag",
        active: false,
        category: { id: "catalog.category.01", name: "基础" },
      }),
    ).toEqual(expect.objectContaining({ active: false }));
  });
});
