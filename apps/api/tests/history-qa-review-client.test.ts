import { describe, expect, it } from "vitest";
import {
  createDeepSeekReviewClient,
  qaReviewThinkingBudgetTokens,
  qaReviewStageOneOutputTokens,
  qaReviewOutputTokens,
} from "../src/history-migration/qa-review-client";
import { HistoryNormalizationError, type HistoryNormalizationFailureKind } from "../src/history-migration/errors";
import type { QaReviewRequest } from "../src/history-migration/qa-gate";

/**
 * 传输层注入的两阶段评审测试：只把住院里的口径，不读 Git、不写正式库。
 * 假 fetch 返回合成 SSE 流；所有断言只检查结构化请求/解析结果，不暴露原文。
 */
function sseChunk(payload: unknown): string {
  return `data: ${JSON.stringify(payload)}\n\n`;
}

function streamResponse(chunks: readonly string[]): Response {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
  return new Response(body) as Response;
}

function capturedRequestBody(exit: RequestInit): Record<string, unknown> {
  return JSON.parse(exit.body as string) as Record<string, unknown>;
}

/** 阶段一由请求体中的 thinking.type === "enabled" 标识。 */
function isStageOneRequest(exit: RequestInit): boolean {
  const thinking = capturedRequestBody(exit).thinking as { readonly type: string } | undefined;
  return thinking?.type === "enabled";
}

function sseContentDelta(text: string): unknown {
  return { choices: [{ delta: { content: text } }] };
}

function sseReasoningDelta(text: string): unknown {
  return { choices: [{ delta: { reasoning_content: text } }] };
}

function sseDone(): unknown {
  return { choices: [] };
}

function reviewRequest(overrides: Partial<QaReviewRequest> = {}): QaReviewRequest {
  return {
    id: 7,
    sourceText: "合成原文，不含题解。",
    sourceSha256: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    candidateText: "合成候选。",
    secondAttempt: false,
    ...overrides,
  };
}

function makeClient(fetchImpl: (input: URL, init: RequestInit) => Promise<Response>) {
  return createDeepSeekReviewClient({
    baseUrl: "https://example.test/v1/",
    apiKey: "test-key",
    model: "deepseek-v4-flash",
    fetch: fetchImpl,
  });
}

describe("createDeepSeekReviewClient 两阶段传输", () => {
  it("阶段一启用最大推理预算且不强制结构化输出，阶段二改用 strict JSON Schema 抽取", async () => {
    let calls = 0;
    const initList: RequestInit[] = [];
    const client = makeClient(async (_input: URL, init: RequestInit) => {
      calls += 1;
      initList.push(init);
      if (calls === 1) {
        return streamResponse([
          sseChunk(sseReasoningDelta("深度推理过程 A")),
          sseChunk(sseContentDelta("半成品正文 B")),
          sseChunk(sseDone()),
        ]);
      }
      return streamResponse([
        sseChunk(sseContentDelta('{"verdict":"PASS","disposition":null,"reasons":["同意","保留语义"]}')),
        sseChunk(sseDone()),
      ]);
    });

    const result = await client(reviewRequest({ deterministicRisks: ["candidate-json-unparsable"] }));

    // 两次独立请求，且阶段一先于阶段二。
    expect(calls).toBe(2);
    const stageOne = capturedRequestBody(initList[0]!);
    expect(stageOne.thinking).toEqual({ type: "enabled", budget_tokens: qaReviewThinkingBudgetTokens });
    expect(stageOne).not.toHaveProperty("response_format");
    expect(stageOne.max_tokens).toBe(qaReviewStageOneOutputTokens);
    const stageTwo = capturedRequestBody(initList[1]!);
    expect(stageTwo.thinking).toEqual({ type: "disabled" });
    expect(stageTwo.response_format).toEqual({
      type: "json_schema",
      json_schema: {
        name: "qa_review_extraction",
        strict: true,
        schema: expect.objectContaining({
          required: ["verdict", "reasons"],
        }),
      },
    });
    expect(stageTwo.max_tokens).toBe(qaReviewOutputTokens);
    expect(result).toEqual({ verdict: "PASS", reasons: ["同意", "保留语义"] });
  });

  it("阶段二只收到阶段一的推理与内容，不重复原文；结果不含原始正文", async () => {
    const stage2Messages: unknown[] = [];
    const client = makeClient(async (_input: URL, init: RequestInit) => {
      if (isStageOneRequest(init)) {
        return streamResponse([sseChunk(sseReasoningDelta("推理文本")), sseChunk(sseDone())]);
      }
      stage2Messages.push(capturedRequestBody(init).messages);
      return streamResponse([
        sseChunk(sseContentDelta('{"verdict":"ANOMALY","disposition":"corrected","reasons":["已补题解"]}')),
        sseChunk(sseDone()),
      ]);
    });

    const result = await client(reviewRequest());
    const userMessage = (stage2Messages[0] as { readonly user?: string; readonly content?: string }[]).at(-1);
    const body = JSON.stringify(userMessage);

    // 阶段二不携带原始材料文本，只携带阶段一推理产物。
    expect(body).toContain("推理文本");
    expect(body).not.toContain("合成原文");
    expect(body).not.toContain("合成候选");
    expect(result).toEqual({ verdict: "ANOMALY", disposition: "corrected", reasons: ["已补题解"] });
    expect(Object.keys(result).sort()).toEqual(["disposition", "reasons", "verdict"]);
  });

  it("零字节响应（空 body）报告 connection，属于可重试种类", async () => {
    const client = makeClient(async () => streamResponse([]));
    await expect(client(reviewRequest())).rejects.toMatchObject({ failureKind: "connection" });
  });

  it("有字节但无正文（仅 [DONE] 帧）报告 eof_incomplete，不重放", async () => {
    const client = makeClient(async () => streamResponse([sseChunk(sseDone())]));
    await expect(client(reviewRequest())).rejects.toMatchObject({ failureKind: "eof_incomplete" });
  });

  it("阶段二有字节但无正文（仅 [DONE] 帧）报告 eof_incomplete，不重放", async () => {
    const client = makeClient(async (_input, init) => {
      if (isStageOneRequest(init)) {
        return streamResponse([sseChunk(sseReasoningDelta("完整推理，正文略")), sseChunk(sseDone())]);
      }
      return streamResponse([sseChunk(sseDone())]);
    });
    await expect(client(reviewRequest())).rejects.toMatchObject({ failureKind: "eof_incomplete" });
  });

  it("服务端 429 阶段一报告 http_429（可重试）", async () => {
    const client = makeClient(async (_input: URL, _init: RequestInit) =>
      new Response("", { status: 429 }) as Response,
    );
    await expect(client(reviewRequest())).rejects.toMatchObject({ failureKind: "http_429" });
  });

  it("阶段二输出不合 schema 报告 schema 失败（不回退）；阶段一推理不足报告 eof_incomplete", async () => {
    const badJson = makeClient(async (_input: URL, init: RequestInit) => {
      if (isStageOneRequest(init)) {
        return streamResponse([sseChunk(sseReasoningDelta("推理")), sseChunk(sseDone())]);
      }
      return streamResponse([sseChunk(sseContentDelta('{"verdict":"UNKNOWN"}')), sseChunk(sseDone())]);
    });
    await expect(badJson(reviewRequest())).rejects.toMatchObject({ failureKind: "schema" });

    const emptyReasoning = makeClient(async (_input: URL, init: RequestInit) => {
      return isStageOneRequest(init)
        ? streamResponse([sseChunk(sseDone())])
        : streamResponse([
            sseChunk(sseContentDelta('{"verdict":"PASS","reasons":[]}')),
            sseChunk(sseDone()),
          ]);
    });
    await expect(emptyReasoning(reviewRequest())).rejects.toMatchObject({ failureKind: "eof_incomplete" });
  });

  it("传输异常映射为 connection 或超时种类，用于上层有线重试", async () => {
    const client = makeClient(async (_input: URL, _init: RequestInit) => {
      throw new TypeError("socket hang up");
    });
    await expect(client(reviewRequest())).rejects.toMatchObject({ failureKind: "connection" });
  });

  it("失败只带安全分类，不带正文", async () => {
    let caught: HistoryNormalizationError | null = null;
    const client = makeClient(async (_input: URL, init: RequestInit) => {
      if (isStageOneRequest(init)) {
        return streamResponse([sseChunk(sseReasoningDelta("推理")), sseChunk(sseDone())]);
      }
      return streamResponse([sseChunk(sseContentDelta("不是 JSON")), sseChunk(sseDone())]);
    });
    try {
      await client(reviewRequest());
    } catch (error) {
      caught = error as HistoryNormalizationError;
    }
    expect(caught).not.toBeNull();
    expect(caught?.failureKind as HistoryNormalizationFailureKind).toBe("invalid_json");
    expect(String(caught?.message)).not.toContain("不是 JSON");
  });
});
