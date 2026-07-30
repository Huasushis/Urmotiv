import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  combineBeforeSubmitResults,
  PluginRegistry,
  PluginRegistryError,
  type BeforeSubmitInput
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
            {
              id: "old",
              reviewRound: 1,
              reviewerId: "reviewer-1",
              reviewerAccountType: "human",
              verdict: "approve",
              source: "human",
              reviewerCanReview: true,
              updatedAt: "2026-07-25T00:00:00.000Z"
            },
            {
              id: "valid",
              reviewRound: 2,
              reviewerId: "reviewer-2",
              reviewerAccountType: "human",
              verdict: "approve",
              source: "human",
              reviewerCanReview: true,
              updatedAt: "2026-07-25T01:00:00.000Z"
            },
            {
              id: "replaced",
              reviewRound: 2,
              reviewerId: "reviewer-3",
              reviewerAccountType: "human",
              verdict: "approve",
              source: "human",
              reviewerCanReview: true,
              updatedAt: "2026-07-25T00:00:00.000Z"
            },
            {
              id: "ineligible",
              reviewRound: 2,
              reviewerId: "reviewer-3",
              reviewerAccountType: "human",
              verdict: "approve",
              source: "human",
              reviewerCanReview: false,
              updatedAt: "2026-07-25T01:00:00.000Z"
            }
          ],
          reviewItems: []
        },
        {}
      )
    ).resolves.toMatchObject({ usedOpinionIds: ["valid"] });
    expect(visibleOpinionIds).toEqual(["valid"]);
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
          opinions: [
            {
              id: "old",
              reviewRound: 1,
              reviewerId: "reviewer-1",
              reviewerAccountType: "human",
              verdict: "approve",
              source: "human",
              reviewerCanReview: true,
              updatedAt: "2026-07-25T00:00:00.000Z"
            }
          ],
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
