import { describe, expect, it, vi } from "vitest";
import type { BeforeSubmitInput } from "@urmotiv/plugin-sdk";
import {
  AnklangClient,
  anklangResultSchema,
  anklangSettingsSchema,
  createAnklangCheck,
  type AnklangCache,
  type AnklangResult
} from "../src/index";

const contentHash = "a".repeat(64);
const input: BeforeSubmitInput = {
  problemId: "42",
  revision: 3,
  reviewRound: 1,
  contentHash,
  problem: {
    title: "公开测试题",
    type: "traditional",
    tagIds: ["graph"],
    basicStatement: "给定一张图，求一条最短路。",
    basicSolution: "使用最短路算法。"
  }
};

function result(overrides: Partial<AnklangResult> = {}): AnklangResult {
  return anklangResultSchema.parse({
    apiVersion: "1",
    contentHash,
    checkedAt: "2026-07-26T00:00:00.000Z",
    candidates: [
      {
        source: "公开题库",
        externalId: "sample-1",
        title: "相似的公开题",
        similarity: 0.82,
        sameProblemSuggestion: false
      }
    ],
    recommendation: { blockSubmission: false, message: "可以继续人工审核。" },
    ...overrides
  });
}

describe("Anklang 设置与 HTTP 边界", () => {
  it("拒绝地址中夹带账号密码", () => {
    expect(() =>
      anklangSettingsSchema.parse({ baseUrl: "https://user:secret@example.test" })
    ).toThrow();
  });

  it("只发送查重需要的题目信息，不发送基础题解", async () => {
    const fetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      expect(JSON.stringify(body)).not.toContain("使用最短路算法");
      expect(init?.headers).toEqual(
        expect.objectContaining({ Authorization: "Bearer hidden-token" })
      );
      return new Response(JSON.stringify(result()), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      });
    });
    const client = new AnklangClient({
      baseUrl: "https://anklang.example.test",
      token: "hidden-token",
      fetch
    });
    await expect(
      client.check(
        {
          apiVersion: "1",
          requestId: "54b70dd8-5c21-4d31-84b7-6437b303c4f2",
          contentHash,
          problem: {
            title: input.problem.title,
            type: input.problem.type,
            tagIds: input.problem.tagIds,
            basicStatement: input.problem.basicStatement
          }
        },
        new AbortController().signal
      )
    ).resolves.toEqual(result());
  });

  it("拒绝混用其他内容摘要的返回结果", async () => {
    const client = new AnklangClient({
      baseUrl: "https://anklang.example.test",
      fetch: async () =>
        new Response(JSON.stringify(result({ contentHash: "b".repeat(64) })), { status: 200 })
    });
    await expect(
      client.check(
        {
          apiVersion: "1",
          requestId: "54b70dd8-5c21-4d31-84b7-6437b303c4f2",
          contentHash,
          problem: {
            title: input.problem.title,
            type: input.problem.type,
            tagIds: input.problem.tagIds,
            basicStatement: input.problem.basicStatement
          }
        },
        new AbortController().signal
      )
    ).rejects.toThrow("题目内容已经变化");
  });
});

describe("提交前相似度检查", () => {
  it("按内容摘要复用缓存并过滤低相似度候选", async () => {
    const cached = result({
      candidates: [
        ...result().candidates,
        {
          source: "公开题库",
          externalId: "sample-2",
          title: "较弱候选",
          similarity: 0.1
        }
      ]
    });
    const cache: AnklangCache = {
      get: vi.fn(async () => cached),
      set: vi.fn(async () => undefined)
    };
    const fetch = vi.fn(async () => new Response("should not run"));
    const check = createAnklangCheck({
      settings: {
        baseUrl: "https://anklang.example.test",
        timeoutMs: 30_000,
        failureBehavior: "block",
        blockWhenRecommended: true,
        minimumSimilarityToShow: 0.3,
        cacheMinutes: 60
      },
      cache,
      fetch
    });

    const output = await check.run(input, { signal: new AbortController().signal });
    expect(fetch).not.toHaveBeenCalled();
    expect(output).toEqual(
      expect.objectContaining({
        decision: "continue",
        reviewItems: [
          expect.objectContaining({
            data: expect.objectContaining({ candidates: [expect.objectContaining({ similarity: 0.82 })] })
          })
        ]
      })
    );
  });

  it("服务明确建议拦截时只返回必要摘要", async () => {
    const blocked = result({
      recommendation: { blockSubmission: true, message: "请先说明与候选题的差异。" }
    });
    const check = createAnklangCheck({
      settings: anklangSettingsSchema.parse({ baseUrl: "https://anklang.example.test" }),
      fetch: async () => new Response(JSON.stringify(blocked), { status: 200 })
    });

    const output = await check.run(input, { signal: new AbortController().signal });
    expect(output).toEqual({
      decision: "block",
      code: "anklang_similar_problem",
      message: "请先说明与候选题的差异。",
      details: {
        candidateCount: 1,
        maximumSimilarity: 0.82,
        contentHash
      }
    });
    expect(JSON.stringify(output)).not.toContain("sample-1");
  });
});
