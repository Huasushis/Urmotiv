import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  combineBeforeSubmitResults,
  PluginRegistry,
  PluginRegistryError,
  type BeforeSubmitInput,
  type ReviewOpinion
} from "../src";

const input: BeforeSubmitInput = {
  problemId: "problem-1",
  revision: 1,
  reviewRound: 1,
  contentHash: "a".repeat(64),
  problem: {
    title: "示例题",
    type: "traditional",
    tagIds: ["graph"],
    basicStatement: "题面",
    basicSolution: "题解"
  }
};

const pluginManifest = {
  id: "org.example.plugin",
  name: "示例插件",
  version: "1.0.0",
  apiVersion: "1" as const
};

function opinion(
  id: string,
  reviewerId: string,
  overrides: Partial<ReviewOpinion> = {}
): ReviewOpinion {
  return {
    id,
    reviewRound: 2,
    reviewerId,
    reviewerAccountType: "human",
    verdict: "approve",
    codeforcesDifficulty: 1600,
    qualityLevel: 3,
    thinkingLevel: 3,
    codingLevel: 2,
    tagIds: ["graph.shortest-path"],
    improvements: "请补充边界情况说明。",
    source: "human",
    reviewerCanReview: true,
    updatedAt: "2026-07-25T00:00:00.000Z",
    ...overrides
  };
}

describe("PluginRegistry", () => {
  it("keeps a block decision even after an earlier check continued", async () => {
    const registry = new PluginRegistry();
    registry.registerReviewItemType({
      type: "org.example.static-check",
      displayName: "静态检查",
      dataSchema: z.object({ passed: z.boolean() }).strict()
    });
    registry.registerBeforeSubmitCheck({
      id: "org.example.first",
      displayName: "第一项检查",
      timeoutMs: 1_000,
      failureBehavior: "block",
      run: () => ({
        decision: "continue",
        reviewItems: [
          {
            type: "org.example.static-check",
            visibility: "reviewer",
            summary: "检查完成",
            data: { passed: true },
            contentHash: "a".repeat(64)
          }
        ]
      })
    });
    registry.registerBeforeSubmitCheck({
      id: "org.example.second",
      displayName: "第二项检查",
      timeoutMs: 1_000,
      failureBehavior: "block",
      run: () => ({ decision: "block", code: "duplicate", message: "需要先处理重复题目。" })
    });
    registry.lock();

    await expect(
      registry.runBeforeSubmit(input, ["org.example.first", "org.example.second"])
    ).resolves.toEqual({
      decision: "block",
      code: "duplicate",
      message: "需要先处理重复题目。"
    });
  });

  it("treats malformed output as a failed required check", async () => {
    const registry = new PluginRegistry();
    registry.registerBeforeSubmitCheck({
      id: "org.example.required",
      displayName: "必需检查",
      timeoutMs: 1_000,
      failureBehavior: "block",
      run: async () => ({ decision: "continue", unexpected: true }) as never
    });
    registry.lock();

    await expect(registry.runBeforeSubmit(input, ["org.example.required"])).resolves.toEqual({
      decision: "block",
      code: "plugin_check_failed",
      message: "必需检查未能完成，题目尚未提交。"
    });
  });

  it("does not allow registrations after startup is locked", () => {
    const registry = new PluginRegistry();
    registry.lock();
    expect(() =>
      registry.registerReviewItemType({
        type: "org.example.item",
        displayName: "示例",
        dataSchema: z.string()
      })
    ).toThrow(PluginRegistryError);
  });

  it("keeps a format adapter's declared input kind and rejects unknown values", () => {
    const adapter = {
      id: "org.example.format",
      displayName: "示例格式",
      version: "1.0.0",
      inputKind: "single_file" as const,
      detect: async () => ({ confidence: 0, reason: "测试" }),
      inspect: async () => ({
        formatId: "org.example.format",
        problemCount: 0,
        files: [],
        issues: []
      }),
      import: async () => null as never,
      validateExport: async () => ({
        targetFormat: "org.example.format",
        canExport: true,
        items: []
      }),
      export: async () => null as never
    };
    const registry = new PluginRegistry();
    registry.registerProblemFormatAdapter(adapter);
    registry.lock();
    expect(registry.getProblemFormatAdapter(adapter.id).inputKind).toBe("single_file");

    const invalid = new PluginRegistry();
    expect(() =>
      invalid.registerProblemFormatAdapter({
        ...adapter,
        inputKind: "unknown" as never
      })
    ).toThrow();
  });

  it("rejects plugin permissions that conflict with core permissions", () => {
    const registry = new PluginRegistry();
    expect(() =>
      registry.registerPluginManifest({
        ...pluginManifest,
        permissions: ["problem.review"]
      })
    ).toThrow(PluginRegistryError);
  });

  it("requires plugin permissions to start with the plugin id", () => {
    const registry = new PluginRegistry();
    expect(() =>
      registry.registerPluginManifest({
        ...pluginManifest,
        permissions: ["org.other.configure"]
      })
    ).toThrow(PluginRegistryError);
  });

  it("hides old, replaced and ineligible opinions from the rule", async () => {
    const registry = new PluginRegistry();
    let visibleOpinionIds: readonly string[] = [];
    registry.registerReviewDecisionRule({
      id: "org.example.rule",
      displayName: "恶意示例规则",
      supportedReviewItemTypes: [],
      settingsSchema: z.object({}).strict(),
      evaluate: (snapshot) => {
        visibleOpinionIds = snapshot.opinions.map((opinion) => opinion.id);
        return {
          decision: "pending",
          usedOpinionIds: [...visibleOpinionIds],
          usedReviewItemIds: [],
          reason: "测试"
        };
      }
    });
    registry.lock();

    await expect(
      registry.evaluateReviewDecision(
        "org.example.rule",
        {
          problemId: "problem-1",
          round: 2,
          contentHash: "a".repeat(64),
          opinions: [
            opinion("old", "reviewer-1", { reviewRound: 1 }),
            opinion("valid", "reviewer-2", {
              updatedAt: "2026-07-25T01:00:00.000Z"
            }),
            opinion("replaced", "reviewer-3"),
            opinion("ineligible", "reviewer-3", {
              reviewerCanReview: false,
              updatedAt: "2026-07-25T01:00:00.000Z"
            })
          ],
          reviewItems: []
        },
        {}
      )
    ).resolves.toMatchObject({ usedOpinionIds: ["valid"] });
    expect(visibleOpinionIds).toEqual(["valid"]);
  });

  it("passes every public structured field in an immutable opinion snapshot", async () => {
    const registry = new PluginRegistry();
    let visibleOpinion: ReviewOpinion | undefined;
    let opinionWasFrozen = false;
    let tagsWereFrozen = false;
    let mutationWasBlocked = false;
    registry.registerReviewDecisionRule({
      id: "org.example.structured-rule",
      displayName: "结构化字段示例规则",
      supportedReviewItemTypes: [],
      settingsSchema: z.object({}).strict(),
      evaluate: (snapshot) => {
        const current = snapshot.opinions[0];
        if (current === undefined) {
          throw new Error("测试快照缺少意见。");
        }
        visibleOpinion = current;
        opinionWasFrozen = Object.isFrozen(current);
        tagsWereFrozen = Object.isFrozen(current.tagIds);
        try {
          current.tagIds.push("unexpected");
        } catch {
          mutationWasBlocked = true;
        }
        return {
          decision: "pending",
          usedOpinionIds: [current.id],
          usedReviewItemIds: [],
          reason: "测试"
        };
      }
    });
    registry.lock();

    await registry.evaluateReviewDecision(
      "org.example.structured-rule",
      {
        problemId: "problem-1",
        round: 2,
        contentHash: "a".repeat(64),
        opinions: [opinion("current", "reviewer-1", {
          verdict: "request_changes",
          codeforcesDifficulty: 2300,
          qualityLevel: 4,
          thinkingLevel: 5,
          codingLevel: 3,
          tagIds: ["graph.flow", "data-structures"],
          improvements: "请补充复杂度证明。"
        })],
        reviewItems: []
      },
      {}
    );

    expect(visibleOpinion).toEqual(expect.objectContaining({
      verdict: "request_changes",
      codeforcesDifficulty: 2300,
      qualityLevel: 4,
      thinkingLevel: 5,
      codingLevel: 3,
      tagIds: ["graph.flow", "data-structures"],
      improvements: "请补充复杂度证明。"
    }));
    expect(Object.keys(visibleOpinion ?? {})).not.toContain("privateNote");
    expect(opinionWasFrozen).toBe(true);
    expect(tagsWereFrozen).toBe(true);
    expect(mutationWasBlocked).toBe(true);
  });

  it("rejects private notes or problem content before a rule can inspect them", async () => {
    const registry = new PluginRegistry();
    let evaluationCount = 0;
    registry.registerReviewDecisionRule({
      id: "org.example.strict-rule",
      displayName: "严格输入示例规则",
      supportedReviewItemTypes: [],
      settingsSchema: z.object({}).strict(),
      evaluate: () => {
        evaluationCount += 1;
        return {
          decision: "pending",
          usedOpinionIds: [],
          usedReviewItemIds: [],
          reason: "测试"
        };
      }
    });
    registry.lock();
    const snapshot = {
      problemId: "problem-1",
      round: 2,
      contentHash: "a".repeat(64),
      opinions: [opinion("current", "reviewer-1")],
      reviewItems: []
    };

    await expect(registry.evaluateReviewDecision(
      "org.example.strict-rule",
      {
        ...snapshot,
        opinions: [{ ...snapshot.opinions[0], privateNote: "不可进入规则" }]
      } as never,
      {}
    )).rejects.toThrow();
    await expect(registry.evaluateReviewDecision(
      "org.example.strict-rule",
      {
        ...snapshot,
        problem: { basicStatement: "不可进入规则" }
      } as never,
      {}
    )).rejects.toThrow();
    expect(evaluationCount).toBe(0);
  });

  it("rejects a rule result that names a hidden opinion", async () => {
    const registry = new PluginRegistry();
    registry.registerReviewDecisionRule({
      id: "org.example.rule",
      displayName: "错误示例规则",
      supportedReviewItemTypes: [],
      settingsSchema: z.object({}).strict(),
      evaluate: () => ({
        decision: "approve",
        usedOpinionIds: ["old"],
        usedReviewItemIds: [],
        reason: "测试"
      })
    });
    registry.lock();

    await expect(
      registry.evaluateReviewDecision(
        "org.example.rule",
        {
          problemId: "problem-1",
          round: 2,
          contentHash: "a".repeat(64),
          opinions: [opinion("old", "reviewer-1", { reviewRound: 1 })],
          reviewItems: []
        },
        {}
      )
    ).rejects.toThrow("旧轮次或已失效");
  });
});

describe("combineBeforeSubmitResults", () => {
  it("always gives a block priority over continue results", () => {
    expect(
      combineBeforeSubmitResults([
        { decision: "continue" },
        { decision: "block", code: "denied", message: "不能继续。" },
        { decision: "continue" }
      ])
    ).toEqual({ decision: "block", code: "denied", message: "不能继续。" });
  });
});
