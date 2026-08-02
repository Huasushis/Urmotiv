import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createLlmHistoryNormalizer,
  loadHistoryPreparationCodeSha256,
  type LlmHistoryNormalizerOptions,
} from "../src/history-migration/index";

const sourceInput = {
  sourceId: "source-000001",
  text: "只用于测试流式读取的合成正文。",
} as const;

const normalizedContent = JSON.stringify({
  problems: [
    {
      title: "合成候选题",
      basicStatement: "只用于测试的合成题面。",
      basicSolution: "只用于测试的合成题解。",
    },
  ],
});

const openServers: Server[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    openServers.splice(0).map(async (server) => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    }),
  );
});

describe("历史题目模型整理流式请求", () => {
  it("执行身份绑定实际受信代码文件而不是手填版本号", async () => {
    await expect(loadHistoryPreparationCodeSha256()).resolves.toMatch(/^[0-9a-f]{64}$/);
  });

  it("持续输出超过首段等待时仍继续，并在 stop 与 DONE 后等待 HTTP 正文真正结束", async () => {
    const allowHttpEnd = deferred<void>();
    const sentCompletionMarkers = deferred<void>();
    let requestBody = "";
    const server = createServer(async (request, response) => {
      for await (const chunk of request) {
        requestBody += chunk.toString("utf8");
      }
      response.writeHead(200, {
        "Content-Type": "text/event-stream; charset=utf-8",
      });
      const fragments = splitIntoFragments(normalizedContent, 6);
      for (const fragment of fragments) {
        response.write(completionEvent(fragment));
        await wait(40);
      }
      response.write(completionEvent("", "stop"));
      response.write("data: [DONE]\n\n");
      sentCompletionMarkers.resolve(undefined);
      await allowHttpEnd.promise;
      response.end();
    });
    openServers.push(server);
    await listenOnLoopback(server);

    const originalNoProxy = process.env.NO_PROXY;
    const originalLowercaseNoProxy = process.env.no_proxy;
    process.env.NO_PROXY = appendNoProxy(originalNoProxy, "127.0.0.1");
    process.env.no_proxy = appendNoProxy(originalLowercaseNoProxy, "127.0.0.1");
    try {
      const resultPromise = createNormalizer({
        baseUrl: localBaseUrl(server),
        firstOutputTimeoutMs: 150,
        outputIdleTimeoutMs: 100,
      }).normalize(sourceInput);
      let settled = false;
      void resultPromise.then(
        () => {
          settled = true;
        },
        () => {
          settled = true;
        },
      );
      await sentCompletionMarkers.promise;
      await wait(20);
      expect(settled).toBe(false);

      allowHttpEnd.resolve(undefined);
      await expect(resultPromise).resolves.toMatchObject({
        problems: [{ title: "合成候选题" }],
      });
    } finally {
      if (originalNoProxy === undefined) {
        delete process.env.NO_PROXY;
      } else {
        process.env.NO_PROXY = originalNoProxy;
      }
      if (originalLowercaseNoProxy === undefined) {
        delete process.env.no_proxy;
      } else {
        process.env.no_proxy = originalLowercaseNoProxy;
      }
    }

    const parsedRequest = JSON.parse(requestBody) as { stream?: unknown };
    expect(parsedRequest.stream).toBe(true);
    expect(requestBody).not.toContain("参考题名");
    expect(requestBody).not.toContain("CF 难度参考");
    expect(requestBody).not.toContain("difficultyGuess");
  });

  it("SSE heartbeat 和空事件不冒充首段有效输出", async () => {
    let heartbeat: ReturnType<typeof setInterval> | undefined;
    const fetch = vi.fn(async () => {
      return new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode(": heartbeat\n\n\n\n"));
            heartbeat = setInterval(() => {
              controller.enqueue(new TextEncoder().encode(": heartbeat\n\n"));
            }, 5);
          },
          cancel() {
            if (heartbeat !== undefined) clearInterval(heartbeat);
          },
        }),
        { headers: { "Content-Type": "text/event-stream" } },
      );
    });
    const normalizer = createNormalizer({
      fetch,
      firstOutputTimeoutMs: 25,
      outputIdleTimeoutMs: 25,
    });

    await expect(normalizer.normalize(sourceInput)).rejects.toMatchObject({
      code: "NORMALIZATION_FAILED",
      message: "source-000001 的模型请求在首段有效输出前超时。",
    });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("非空 reasoning 输出会续期，最终仍必须收到非空 content 和 stop", async () => {
    let generation: ReturnType<typeof setInterval> | undefined;
    const fetch = vi.fn(async () => {
      return new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            let step = 0;
            generation = setInterval(() => {
              step += 1;
              if (step <= 4) {
                controller.enqueue(
                  new TextEncoder().encode(reasoningEvent(`合成推理片段-${step}`)),
                );
                return;
              }
              controller.enqueue(
                new TextEncoder().encode(
                  `${completionEvent(normalizedContent, "stop")}data: [DONE]\n\n`,
                ),
              );
              if (generation !== undefined) clearInterval(generation);
              controller.close();
            }, 15);
          },
          cancel() {
            if (generation !== undefined) clearInterval(generation);
          },
        }),
        { headers: { "Content-Type": "text/event-stream" } },
      );
    });

    await expect(
      createNormalizer({
        fetch,
        firstOutputTimeoutMs: 25,
        outputIdleTimeoutMs: 25,
      }).normalize(sourceInput),
    ).resolves.toMatchObject({ problems: [{ title: "合成候选题" }] });
  });

  it("开始生成后长时间没有新的有效输出时停止，且不重复付费请求", async () => {
    const fetch = vi.fn(async () => {
      return new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode(completionEvent('{"problems":')));
          },
        }),
        { headers: { "Content-Type": "text/event-stream" } },
      );
    });
    const normalizer = createNormalizer({
      fetch,
      firstOutputTimeoutMs: 50,
      outputIdleTimeoutMs: 25,
      maximumAttempts: 3,
    });

    await expect(normalizer.normalize(sourceInput)).rejects.toMatchObject({
      code: "NORMALIZATION_FAILED",
      message: "source-000001 的模型输出长时间没有继续。",
    });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("只有 DONE 而没有 finish_reason=stop 时不接受部分内容", async () => {
    const fetch = vi.fn(async () => {
      return eventStreamResponse(`${completionEvent(normalizedContent)}data: [DONE]\n\n`);
    });

    await expect(createNormalizer({ fetch }).normalize(sourceInput)).rejects.toMatchObject({
      code: "NORMALIZATION_FAILED",
      message: "模型响应在完成标记前结束。",
    });
  });

  it("finish_reason=stop 后等到 HTTP EOF 即可完整结束，不强制兼容服务额外发送 DONE", async () => {
    const fetch = vi.fn(async () => {
      return eventStreamResponse(completionEvent(normalizedContent, "stop"));
    });

    await expect(createNormalizer({ fetch }).normalize(sourceInput)).resolves.toMatchObject({
      problems: [{ title: "合成候选题" }],
    });
  });

  it.each(["length", "content_filter"])(
    "finish_reason=%s 不能作为完整候选成功",
    async (finishReason) => {
      const fetch = vi.fn(async () => {
        return eventStreamResponse(
          `${completionEvent(normalizedContent, finishReason)}data: [DONE]\n\n`,
        );
      });

      await expect(createNormalizer({ fetch }).normalize(sourceInput)).rejects.toMatchObject({
        code: "NORMALIZATION_FAILED",
        message: "模型响应缺少完整候选内容。",
      });
    },
  );

  it("空白输出即使带 stop 和 DONE 也不能成功", async () => {
    const fetch = vi.fn(async () => {
      return eventStreamResponse(`${completionEvent("   \n", "stop")}data: [DONE]\n\n`);
    });

    await expect(createNormalizer({ fetch }).normalize(sourceInput)).rejects.toMatchObject({
      code: "NORMALIZATION_FAILED",
      message: "模型响应在完成标记前结束。",
    });
  });

  it("stop 后流连接报错时拒绝部分结果且不重试", async () => {
    const privateMarker = "SYNTHETIC-STREAM-ERROR-MARKER";
    const fetch = vi.fn(async () => {
      return new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(
              new TextEncoder().encode(completionEvent(normalizedContent, "stop")),
            );
            controller.error(new Error(privateMarker));
          },
        }),
        { headers: { "Content-Type": "text/event-stream" } },
      );
    });

    let caught: unknown;
    try {
      await createNormalizer({ fetch, maximumAttempts: 3 }).normalize(sourceInput);
    } catch (error) {
      caught = error;
    }
    expect(caught).toMatchObject({
      code: "NORMALIZATION_FAILED",
      message: "source-000001 的模型响应在完整结束前中断。",
    });
    expect(String(caught)).not.toContain(privateMarker);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("明确取消正在读取的请求，并且不自动重发", async () => {
    const cancellation = new AbortController();
    const responseStarted = deferred<void>();
    const fetch = vi.fn(async () => {
      return new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode(completionEvent('{"problems":')));
            responseStarted.resolve(undefined);
          },
        }),
        { headers: { "Content-Type": "text/event-stream" } },
      );
    });
    const result = createNormalizer({
      fetch,
      signal: cancellation.signal,
      maximumAttempts: 3,
    }).normalize(sourceInput);
    await responseStarted.promise;
    cancellation.abort();

    await expect(result).rejects.toMatchObject({
      code: "NORMALIZATION_FAILED",
      message: "source-000001 的模型请求已明确取消。",
    });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("开始前已经明确取消时不会发出请求", async () => {
    const cancellation = new AbortController();
    cancellation.abort();
    const fetch = vi.fn(async () => {
      return eventStreamResponse(completionEvent(normalizedContent, "stop"));
    });

    await expect(
      createNormalizer({ fetch, signal: cancellation.signal }).normalize(sourceInput),
    ).rejects.toMatchObject({
      code: "NORMALIZATION_FAILED",
      message: "source-000001 的模型请求已明确取消。",
    });
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe("历史题目模型整理重试与完整性", () => {
  it("只在明确收到 429 后安全重试", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(new Response("synthetic rate limit", { status: 429 }))
      .mockResolvedValueOnce(
        eventStreamResponse(`${completionEvent(normalizedContent, "stop")}data: [DONE]\n\n`),
      );

    const registeredAttempts: number[] = [];
    await expect(
      createNormalizer({
        fetch,
        maximumAttempts: 3,
        retryBaseDelayMs: 1,
      }).normalize({
        ...sourceInput,
        beforeRequest: async (attempt) => {
          registeredAttempts.push(attempt);
        },
      }),
    ).resolves.toMatchObject({ problems: [{ title: "合成候选题" }] });
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(registeredAttempts).toEqual([1, 2]);
  });

  it("429 退避等待可以明确取消，不会继续第二次请求", async () => {
    const cancellation = new AbortController();
    const fetch = vi.fn(async () => {
      return new Response("synthetic rate limit", { status: 429 });
    });
    const result = createNormalizer({
      fetch,
      signal: cancellation.signal,
      maximumAttempts: 3,
      retryBaseDelayMs: 5_000,
    }).normalize(sourceInput);
    await vi.waitFor(() => {
      expect(fetch).toHaveBeenCalledTimes(1);
    });
    cancellation.abort();

    await expect(result).rejects.toMatchObject({
      code: "NORMALIZATION_FAILED",
      message: "source-000001 的模型请求已明确取消。",
    });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it.each([499, 500, 503])("HTTP %s 不自动重发", async (status) => {
    const privateMarker = "SYNTHETIC-ERROR-BODY-MARKER";
    const fetch = vi.fn(async () => {
      return new Response(privateMarker, { status });
    });

    let caught: unknown;
    try {
      await createNormalizer({ fetch, maximumAttempts: 3 }).normalize(sourceInput);
    } catch (error) {
      caught = error;
    }
    expect(caught).toMatchObject({
      code: "NORMALIZATION_FAILED",
      failureKind: status === 499 ? "http_499" : "http_status",
      message: `source-000001 的模型服务返回 HTTP ${status}。`,
    });
    expect(String(caught)).not.toContain(privateMarker);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("请求是否到达服务端无法确认的网络错误不自动重发", async () => {
    const privateMarker = "SYNTHETIC-NETWORK-ERROR-MARKER";
    const fetch = vi.fn(async () => {
      throw new Error(privateMarker);
    });

    let caught: unknown;
    try {
      await createNormalizer({ fetch, maximumAttempts: 3 }).normalize(sourceInput);
    } catch (error) {
      caught = error;
    }
    expect(caught).toMatchObject({
      code: "NORMALIZATION_FAILED",
      message: "source-000001 的模型连接失败。",
    });
    expect(String(caught)).not.toContain(privateMarker);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("非流式兼容响应也必须完整结束、非空且 finish_reason=stop", async () => {
    const validFetch = vi.fn(async () => {
      return Response.json({
        choices: [
          {
            finish_reason: "stop",
            message: { content: normalizedContent },
          },
        ],
      });
    });
    await expect(
      createNormalizer({ fetch: validFetch }).normalize(sourceInput),
    ).resolves.toMatchObject({ problems: [{ title: "合成候选题" }] });

    const truncatedFetch = vi.fn(async () => {
      return Response.json({
        choices: [
          {
            finish_reason: "length",
            message: { content: normalizedContent },
          },
        ],
      });
    });
    await expect(
      createNormalizer({ fetch: truncatedFetch }).normalize(sourceInput),
    ).rejects.toMatchObject({
      code: "NORMALIZATION_FAILED",
      message: "模型响应缺少完整候选内容。",
    });
  });
});

function createNormalizer(overrides: Partial<LlmHistoryNormalizerOptions> = {}) {
  return createLlmHistoryNormalizer({
    baseUrl: "https://synthetic.invalid/v1/",
    apiKey: "synthetic-key",
    model: "synthetic-model",
    codeSha256: "f".repeat(64),
    firstOutputTimeoutMs: 200,
    outputIdleTimeoutMs: 200,
    maximumAttempts: 1,
    maximumResponseBytes: 100_000,
    ...overrides,
  });
}

function completionEvent(content: string, finishReason: string | null = null): string {
  return `data: ${JSON.stringify({
    choices: [
      {
        delta: { content },
        finish_reason: finishReason,
      },
    ],
  })}\n\n`;
}

function reasoningEvent(reasoning: string): string {
  return `data: ${JSON.stringify({
    choices: [
      {
        delta: { reasoning_content: reasoning },
        finish_reason: null,
      },
    ],
  })}\n\n`;
}

function eventStreamResponse(body: string): Response {
  return new Response(body, {
    headers: { "Content-Type": "text/event-stream" },
  });
}

function splitIntoFragments(value: string, count: number): string[] {
  const fragments: string[] = [];
  const size = Math.ceil(value.length / count);
  for (let offset = 0; offset < value.length; offset += size) {
    fragments.push(value.slice(offset, offset + size));
  }
  return fragments;
}

async function listenOnLoopback(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
}

function localBaseUrl(server: Server): string {
  const address = server.address() as AddressInfo;
  return `http://127.0.0.1:${address.port}/v1/`;
}

function appendNoProxy(value: string | undefined, host: string): string {
  return value === undefined || value.length === 0 ? host : `${value},${host}`;
}

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}

function deferred<T>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T | PromiseLike<T>) => void;
} {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
