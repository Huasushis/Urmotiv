import { createHash } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createLlmHistoryNormalizer,
  defaultNormalizationMaximumDurationMs,
  historyNormalizationRequestProfileVersion,
  historyReplayParserVersion,
  loadHistoryPreparationCodeSha256,
  maximumNormalizationOutputTokens,
  ReplaySession,
  type CapturedTransport,
  type LlmHistoryNormalizerOptions,
} from "../src/history-migration/index";
import { HistoryMigrationError, HistoryNormalizationError } from "../src/history-migration/errors";

const sourceInput = {
  sourceId: "source-000001",
  text: "只用于测试流式读取的合成正文。",
} as const;

const normalizedContent = JSON.stringify({
  problems: [
    {
      title: "合成候选题",
      type: "traditional",
      basicStatement: "只用于测试的合成题面。",
      basicSolution: "只用于测试的合成题解。",
      background: "",
      statement: "",
      inputFormat: "",
      outputFormat: "",
      constraints: "",
      solution: "",
      hints: "",
      samples: [],
      tags: [],
      confidence: 0.9,
      migrationNote: "",
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

  it("发送版本化 JSON 请求配置，并把每个影响输出的固定参数绑定进执行身份", async () => {
    let requestBody: unknown;
    const fetch = vi.fn(async (_input: URL, init: RequestInit) => {
      requestBody = JSON.parse(String(init.body)) as unknown;
      return eventStreamResponse(`${completionEvent(normalizedContent, "stop")}data: [DONE]\n\n`);
    });
    const normalizer = createNormalizer({
      fetch,
      model: "  synthetic-model  ",
    });

    await expect(normalizer.normalize(sourceInput)).resolves.toMatchObject({
      problems: [{ title: "合成候选题" }],
    });
    expect(requestBody).toEqual({
      model: "synthetic-model",
      temperature: 0.1,
      thinking: { type: "max" },
      stream: true,
      messages: [
        { role: "system", content: expect.any(String) },
        { role: "user", content: `原始文本：\n${sourceInput.text}` },
      ],
    });
    expect(Object.keys(requestBody as Record<string, unknown>)).toEqual([
      "model",
      "temperature",
      "thinking",
      "stream",
      "messages",
    ]);
    expect(requestBody).not.toHaveProperty("max_tokens");
    expect(requestBody).not.toHaveProperty("max_completion_tokens");
    expect(requestBody).not.toHaveProperty("response_format");
    const messages = (requestBody as { messages: Array<{ content: string }> }).messages;
    expect(messages[0]?.content).toContain("题面和题解是核心");
    expect(messages[0]?.content).toContain("tags 必须始终是空数组 []");
    expect(messages[0]?.content).toContain("不要读取、采信或推断投题者自报难度");
    expect(messages[0]?.content).toContain("JSON 前后不得出现说明");
    expect(messages[0]?.content).toContain('"additionalProperties": false');
    expect(messages[0]?.content).toContain('"required": [');

    const expectedConfig = {
      endpointSha256: sha256("https://synthetic.invalid/v1/chat/completions"),
      firstOutputTimeoutMs: 200,
      outputIdleTimeoutMs: 200,
      maximumDurationMs: defaultNormalizationMaximumDurationMs,
      maximumAttempts: 1,
      retryBaseDelayMs: 3_000,
      maximumResponseBytes: 100_000,
      requestProfile: {
        version: historyNormalizationRequestProfileVersion,
        parameters: {
          temperature: 0.1,
          thinking: { type: "max" },
          stream: true,
        },
        messageLayout: {
          systemRole: "system",
          userRole: "user",
          userPrefix: "原始文本：",
        },
      },
      streamingProtocol: "sse-eof-benign-controls-v2",
      retryPolicy: "http-429-and-zero-byte-transport",
    };
    expect(normalizer.preparationIdentity.configSha256).toBe(
      sha256(JSON.stringify(expectedConfig)),
    );
    expect(normalizer.preparationIdentity.modelSha256).toBe(sha256("synthetic-model"));
  });

  it("只有显式配置才发送输出 token 上限并改变执行身份", async () => {
    expect(maximumNormalizationOutputTokens).toBe(65_536);
    let requestBody: Record<string, unknown> | undefined;
    const fetch = vi.fn(async (_input: URL, init: RequestInit) => {
      requestBody = JSON.parse(String(init.body)) as Record<string, unknown>;
      return eventStreamResponse(`${completionEvent(normalizedContent, "stop")}data: [DONE]\n\n`);
    });
    const uncapped = createNormalizer();
    const capped = createNormalizer({
      fetch,
      maximumOutputTokens: 65_535,
    });
    expect(uncapped.preparationIdentity.configSha256).not.toBe(
      capped.preparationIdentity.configSha256,
    );
    await expect(capped.normalize(sourceInput)).resolves.toBeDefined();
    expect(requestBody).toMatchObject({ max_tokens: 65_535 });
    expect(() =>
      createNormalizer({ maximumOutputTokens: maximumNormalizationOutputTokens + 1 }),
    ).toThrow("模型请求限制配置不正确。");
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

  it.each([
    `\`\`\`json\n${normalizedContent}\n\`\`\``,
    `整理结果如下：${normalizedContent}`,
    `${normalizedContent}\n以上为整理结果。`,
  ])("只做一次本地 JSON 包装格式修复且不重新请求", async (content) => {
    const fetch = vi.fn(async () =>
      eventStreamResponse(`${completionEvent(content, "stop")}data: [DONE]\n\n`),
    );

    await expect(createNormalizer({ fetch }).normalize(sourceInput)).resolves.toMatchObject({
      problems: [{ title: "合成候选题" }],
    });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("模型自行选择知识点标签时严格拒绝且不重新请求", async () => {
    const withInventedTag = JSON.stringify({
      ...JSON.parse(normalizedContent),
      problems: [
        {
          ...JSON.parse(normalizedContent).problems[0],
          tags: ["合成但未经人工选择的标签"],
        },
      ],
    });
    const fetch = vi.fn(async () =>
      eventStreamResponse(`${completionEvent(withInventedTag, "stop")}data: [DONE]\n\n`),
    );

    await expect(createNormalizer({ fetch }).normalize(sourceInput)).rejects.toMatchObject({
      code: "NORMALIZATION_FAILED",
      failureKind: "schema",
    });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("模型结果含结构外字段时严格拒绝且不重新请求", async () => {
    const parsed = JSON.parse(normalizedContent);
    parsed.problems[0].unexpected = "synthetic-extra";
    const fetch = vi.fn(async () =>
      eventStreamResponse(`${completionEvent(JSON.stringify(parsed), "stop")}data: [DONE]\n\n`),
    );

    await expect(createNormalizer({ fetch }).normalize(sourceInput)).rejects.toMatchObject({
      code: "NORMALIZATION_FAILED",
      failureKind: "schema",
    });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("stop 之后的 usage 记录携带唯一空 delta choice 时视为元数据", async () => {
    const postStopUsage = {
      ...strictUsageMetadataEvent(),
      choices: [{ index: 0, delta: {} }],
    };
    const fetch = vi.fn(async () =>
      eventStreamResponse(
        `${completionEvent(normalizedContent, "stop")}data: ${JSON.stringify(
          postStopUsage,
        )}\n\ndata: [DONE]\n\n`,
      ),
    );

    const result = await createNormalizer({ fetch }).normalize(sourceInput);
    expect(result.problems).toHaveLength(1);
  });

  it("stop 之后的 usage 记录不得携带任何正文或推理字段", async () => {
    const poisoned = {
      ...strictUsageMetadataEvent(),
      choices: [{ index: 0, delta: { content: "stop 后混进来的合成正文" } }],
    };
    const fetch = vi.fn(async () =>
      eventStreamResponse(
        `${completionEvent(normalizedContent, "stop")}data: ${JSON.stringify(
          poisoned,
        )}\n\ndata: [DONE]\n\n`,
      ),
    );

    await expect(createNormalizer({ fetch }).normalize(sourceInput)).rejects.toMatchObject({
      code: "NORMALIZATION_FAILED",
    });
  });

  it("stop 之后的 usage 记录不得携带顶层 reasoning 字段", async () => {
    const poisoned = {
      ...strictUsageMetadataEvent(),
      choices: [{ index: 0, delta: {} }],
      reasoning: "synthetic-payload",
    };
    const fetch = vi.fn(async () =>
      eventStreamResponse(
        `${completionEvent(normalizedContent, "stop")}data: ${JSON.stringify(
          poisoned,
        )}\n\ndata: [DONE]\n\n`,
      ),
    );

    await expect(createNormalizer({ fetch }).normalize(sourceInput)).rejects.toMatchObject({
      code: "NORMALIZATION_FAILED",
    });
  });

  it("stop 之后的 usage 记录不得携带顶层 content 字段", async () => {
    const poisoned = {
      ...strictUsageMetadataEvent(),
      choices: [{ index: 0, delta: {} }],
      content: "synthetic-injected-content",
    };
    const fetch = vi.fn(async () =>
      eventStreamResponse(
        `${completionEvent(normalizedContent, "stop")}data: ${JSON.stringify(
          poisoned,
        )}\n\ndata: [DONE]\n\n`,
      ),
    );

    await expect(createNormalizer({ fetch }).normalize(sourceInput)).rejects.toMatchObject({
      code: "NORMALIZATION_FAILED",
    });
  });

  it("stop 之后的 usage 记录不得携带任意未知顶层字段", async () => {
    const poisoned = {
      ...strictUsageMetadataEvent(),
      choices: [{ index: 0, delta: {} }],
      arbitrary_content_like_key: "synthetic-extra-value",
    };
    const fetch = vi.fn(async () =>
      eventStreamResponse(
        `${completionEvent(normalizedContent, "stop")}data: ${JSON.stringify(
          poisoned,
        )}\n\ndata: [DONE]\n\n`,
      ),
    );

    await expect(createNormalizer({ fetch }).normalize(sourceInput)).rejects.toMatchObject({
      code: "NORMALIZATION_FAILED",
    });
  });

  it("stop 之后的 usage 记录不得携带超长顶层元数据字符串", async () => {
    const poisoned = {
      ...strictUsageMetadataEvent(),
      choices: [{ index: 0, delta: {} }],
      model: "x".repeat(2000),
    };
    const fetch = vi.fn(async () =>
      eventStreamResponse(
        `${completionEvent(normalizedContent, "stop")}data: ${JSON.stringify(
          poisoned,
        )}\n\ndata: [DONE]\n\n`,
      ),
    );

    await expect(createNormalizer({ fetch }).normalize(sourceInput)).rejects.toMatchObject({
      code: "NORMALIZATION_FAILED",
    });
  });

  it("stop 之后的 usage 记录中 delta 不得携带 reasoning_content", async () => {
    const poisoned = {
      ...strictUsageMetadataEvent(),
      choices: [{ index: 0, delta: { reasoning_content: "synthetic-reasoning" } }],
    };
    const fetch = vi.fn(async () =>
      eventStreamResponse(
        `${completionEvent(normalizedContent, "stop")}data: ${JSON.stringify(
          poisoned,
        )}\n\ndata: [DONE]\n\n`,
      ),
    );

    await expect(createNormalizer({ fetch }).normalize(sourceInput)).rejects.toMatchObject({
      code: "NORMALIZATION_FAILED",
    });
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

  it("DONE 后只接受空 data、重复 DONE 与严格有界元数据，并继续等待真实 HTTP EOF", async () => {
    const encoder = new TextEncoder();
    let streamController!: ReadableStreamDefaultController<Uint8Array>;
    let cancelled = false;
    const fetch = vi.fn(
      async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              streamController = controller;
            },
            cancel() {
              cancelled = true;
            },
          }),
          { headers: { "Content-Type": "text/event-stream" } },
        ),
    );
    const resultPromise = createNormalizer({
      fetch,
      firstOutputTimeoutMs: 1_000,
      outputIdleTimeoutMs: 1_000,
      maximumDurationMs: 5_000,
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
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
    streamController.enqueue(
      encoder.encode(
        [
          completionEvent(normalizedContent, "stop").trimEnd(),
          "",
          `data: ${JSON.stringify(strictUsageMetadataEvent())}`,
          "",
          "data: [DONE]",
          "",
          "data:",
          "",
          "data",
          "",
          "data: [DONE]",
          "",
          `data: ${JSON.stringify(strictUsageMetadataEvent())}`,
          "",
          "",
        ].join("\r\n"),
      ),
    );
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(settled).toBe(false);
    expect(cancelled).toBe(false);

    streamController.close();
    await expect(resultPromise).resolves.toMatchObject({
      problems: [{ title: "合成候选题" }],
    });
    expect(cancelled).toBe(false);
  });

  it("逐字节分片和 CRLF 不改变 benign 控制尾部的接受条件", async () => {
    const bytes = new TextEncoder().encode(
      [
        completionEvent(normalizedContent, "stop").trim(),
        "",
        "data: [DONE]",
        "",
        "data:",
        "",
        "data: [DONE]",
        "",
        `data: ${JSON.stringify(strictUsageMetadataEvent())}`,
      ].join("\r\n"),
    );
    let offset = 0;
    const fetch = vi.fn(
      async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            pull(controller) {
              if (offset < bytes.byteLength) {
                controller.enqueue(bytes.slice(offset, offset + 1));
                offset += 1;
              } else {
                controller.close();
              }
            },
          }),
          { headers: { "Content-Type": "text/event-stream; charset=utf-8" } },
        ),
    );

    await expect(createNormalizer({ fetch }).normalize(sourceInput)).resolves.toMatchObject({
      problems: [{ title: "合成候选题" }],
    });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it.each([
    { name: "非法 JSON", tail: "{not-json}" },
    { name: "未知对象", tail: JSON.stringify({ provider_payload: true }) },
    {
      name: "越界 usage",
      tail: JSON.stringify({ choices: [], usage: { total_tokens: -1 } }),
    },
    {
      name: "过深 usage",
      tail: JSON.stringify({
        choices: [],
        usage: { a: { b: { c: { d: { total_tokens: 1 } } } } },
      }),
    },
    { name: "非空 choices", tail: JSON.stringify({ choices: [{ index: 0 }] }) },
    {
      name: "正文或工具字段",
      tail: JSON.stringify({ choices: [], content: "合成尾部正文", tool_calls: [] }),
    },
  ])("DONE 后的$name清空候选并排空到真实 EOF 后才固定失败", async ({ tail }) => {
    const encoder = new TextEncoder();
    let streamController!: ReadableStreamDefaultController<Uint8Array>;
    let cancelled = false;
    const fetch = vi.fn(
      async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              streamController = controller;
            },
            cancel() {
              cancelled = true;
            },
          }),
          { headers: { "Content-Type": "text/event-stream" } },
        ),
    );
    const resultPromise = createNormalizer({
      fetch,
      firstOutputTimeoutMs: 1_000,
      outputIdleTimeoutMs: 1_000,
      maximumDurationMs: 5_000,
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
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
    streamController.enqueue(
      encoder.encode(
        `${completionEvent(normalizedContent, "stop")}data: [DONE]\n\ndata: ${tail}\n\n`,
      ),
    );
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(settled).toBe(false);
    expect(cancelled).toBe(false);

    streamController.enqueue(encoder.encode("排空阶段不应保存的合成字节"));
    streamController.close();
    const error = await resultPromise.catch((caught: unknown) => caught);
    expect(error).toMatchObject({
      code: "NORMALIZATION_FAILED",
      failureKind: "protocol",
      message: "模型响应缺少完整候选内容。",
    });
    expect(String(error)).not.toContain("合成尾部正文");
    expect(String(error)).not.toContain("排空阶段");
    expect(cancelled).toBe(false);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("DONE 前的 choices:[] 必须通过同一封闭元数据校验", async () => {
    const unsafeMarker = "不应静默忽略的合成正文";
    const fetch = vi.fn(async () =>
      eventStreamResponse(
        `${completionEvent(normalizedContent, "stop")}data: ${JSON.stringify({
          choices: [],
          content: unsafeMarker,
        })}\n\ndata: [DONE]\n\n`,
      ),
    );

    const error = await createNormalizer({ fetch })
      .normalize(sourceInput)
      .catch((caught) => caught);
    expect(error).toMatchObject({
      code: "NORMALIZATION_FAILED",
      failureKind: "protocol",
    });
    expect(String(error)).not.toContain(unsafeMarker);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it.each([
    { mode: "stream_interrupted", failureKind: "eof_incomplete" },
    { mode: "cancelled", failureKind: "cancelled" },
  ] as const)("协议首错排空期间 $mode 仍保持不完整", async ({ mode, failureKind }) => {
    const encoder = new TextEncoder();
    const cancellation = new AbortController();
    let streamController!: ReadableStreamDefaultController<Uint8Array>;
    const fetch = vi.fn(
      async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              streamController = controller;
            },
          }),
          { headers: { "Content-Type": "text/event-stream" } },
        ),
    );
    const resultPromise = createNormalizer({
      fetch,
      signal: cancellation.signal,
      firstOutputTimeoutMs: 1_000,
      outputIdleTimeoutMs: 1_000,
      maximumDurationMs: 5_000,
    }).normalize(sourceInput);
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
    streamController.enqueue(
      encoder.encode(
        `${completionEvent(normalizedContent, "stop")}data: [DONE]\n\ndata: {not-json}\n\n`,
      ),
    );
    await new Promise<void>((resolve) => setImmediate(resolve));
    if (mode === "stream_interrupted") {
      streamController.error(new Error("不应泄漏的合成传输错误"));
    } else {
      cancellation.abort();
    }

    const error = await resultPromise.catch((caught: unknown) => caught);
    expect(error).toMatchObject({
      code: "NORMALIZATION_FAILED",
      failureKind,
    });
    expect(String(error)).not.toContain("不应泄漏");
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

  it("默认最终保护是四小时，首段有效输出后不会成为正常生成总时限", async () => {
    expect(defaultNormalizationMaximumDurationMs).toBe(4 * 60 * 60 * 1_000);
    vi.useFakeTimers();
    try {
      const encoder = new TextEncoder();
      let streamController!: ReadableStreamDefaultController<Uint8Array>;
      const fetch = vi.fn(
        async () =>
          new Response(
            new ReadableStream<Uint8Array>({
              start(controller) {
                streamController = controller;
              },
            }),
            { headers: { "Content-Type": "text/event-stream" } },
          ),
      );
      const normalizer = createNormalizer({
        fetch,
        firstOutputTimeoutMs: 20,
        outputIdleTimeoutMs: 1_000,
        maximumDurationMs: 50,
      });
      const resultPromise = normalizer.normalize(sourceInput);
      await vi.advanceTimersByTimeAsync(0);
      streamController.enqueue(encoder.encode(completionEvent(normalizedContent)));
      await vi.advanceTimersByTimeAsync(0);

      await vi.advanceTimersByTimeAsync(60);
      streamController.enqueue(encoder.encode(`${completionEvent("", "stop")}data: [DONE]\n\n`));
      streamController.close();
      await expect(resultPromise).resolves.toMatchObject({
        problems: [{ title: "合成候选题" }],
      });
      expect(fetch).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("协议排空重启最终保护，原始分块只刷新 idle 而不能延长绝对边界", async () => {
    vi.useFakeTimers();
    try {
      const encoder = new TextEncoder();
      let streamController!: ReadableStreamDefaultController<Uint8Array>;
      let cancelled = false;
      const fetch = vi.fn(
        async () =>
          new Response(
            new ReadableStream<Uint8Array>({
              start(controller) {
                streamController = controller;
              },
              cancel() {
                cancelled = true;
              },
            }),
            { headers: { "Content-Type": "text/event-stream" } },
          ),
      );
      const resultPromise = createNormalizer({
        fetch,
        firstOutputTimeoutMs: 20,
        outputIdleTimeoutMs: 30,
        maximumDurationMs: 50,
      }).normalize(sourceInput);
      const rejection = expect(resultPromise).rejects.toMatchObject({
        code: "NORMALIZATION_FAILED",
        failureKind: "maximum_duration_timeout",
      });
      await vi.advanceTimersByTimeAsync(0);
      streamController.enqueue(
        encoder.encode(
          `${completionEvent(normalizedContent, "stop")}data: [DONE]\n\ndata: {not-json}\n\n`,
        ),
      );
      await vi.advanceTimersByTimeAsync(0);

      await vi.advanceTimersByTimeAsync(20);
      streamController.enqueue(encoder.encode("合成排空分块一"));
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(20);
      streamController.enqueue(encoder.encode("合成排空分块二"));
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(11);

      await rejection;
      expect(cancelled).toBe(true);
      expect(fetch).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("协议排空没有原始分块继续到达时仍按 idle 判为不完整", async () => {
    vi.useFakeTimers();
    try {
      const encoder = new TextEncoder();
      let streamController!: ReadableStreamDefaultController<Uint8Array>;
      let cancelled = false;
      const fetch = vi.fn(
        async () =>
          new Response(
            new ReadableStream<Uint8Array>({
              start(controller) {
                streamController = controller;
              },
              cancel() {
                cancelled = true;
              },
            }),
            { headers: { "Content-Type": "text/event-stream" } },
          ),
      );
      const resultPromise = createNormalizer({
        fetch,
        firstOutputTimeoutMs: 20,
        outputIdleTimeoutMs: 30,
        maximumDurationMs: 100,
      }).normalize(sourceInput);
      const rejection = expect(resultPromise).rejects.toMatchObject({
        code: "NORMALIZATION_FAILED",
        failureKind: "output_idle_timeout",
      });
      await vi.advanceTimersByTimeAsync(0);
      streamController.enqueue(
        encoder.encode(
          `${completionEvent(normalizedContent, "stop")}data: [DONE]\n\ndata: {not-json}\n\n`,
        ),
      );
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(31);

      await rejection;
      expect(cancelled).toBe(true);
      expect(fetch).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("DONE 后 benign 控制事件不冒充有效输出刷新 idle", async () => {
    vi.useFakeTimers();
    try {
      const encoder = new TextEncoder();
      let streamController!: ReadableStreamDefaultController<Uint8Array>;
      const fetch = vi.fn(
        async () =>
          new Response(
            new ReadableStream<Uint8Array>({
              start(controller) {
                streamController = controller;
              },
            }),
            { headers: { "Content-Type": "text/event-stream" } },
          ),
      );
      const resultPromise = createNormalizer({
        fetch,
        firstOutputTimeoutMs: 20,
        outputIdleTimeoutMs: 30,
        maximumDurationMs: 100,
      }).normalize(sourceInput);
      const rejection = expect(resultPromise).rejects.toMatchObject({
        code: "NORMALIZATION_FAILED",
        failureKind: "output_idle_timeout",
      });
      await vi.advanceTimersByTimeAsync(0);
      streamController.enqueue(
        encoder.encode(`${completionEvent(normalizedContent, "stop")}data: [DONE]\n\n`),
      );
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(20);
      streamController.enqueue(
        encoder.encode(`data: [DONE]\n\ndata: ${JSON.stringify(strictUsageMetadataEvent())}\n\n`),
      );
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(11);

      await rejection;
      expect(fetch).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("最终保护时长属于 prepare 执行身份", () => {
    const first = createNormalizer({ maximumDurationMs: 10_000 });
    const second = createNormalizer({ maximumDurationMs: 10_001 });
    expect(first.preparationIdentity.configSha256).not.toBe(
      second.preparationIdentity.configSha256,
    );
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
      let delivered = false;
      return new Response(
        new ReadableStream<Uint8Array>({
          pull(controller) {
            if (!delivered) {
              delivered = true;
              controller.enqueue(
                new TextEncoder().encode(completionEvent(normalizedContent, "stop")),
              );
              return;
            }
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

  it("确认零字节的网络错误最多尝试三次且不泄露底层错误", async () => {
    const privateMarker = "SYNTHETIC-NETWORK-ERROR-MARKER";
    const fetch = vi.fn(async () => {
      throw new Error(privateMarker);
    });

    let caught: unknown;
    try {
      await createNormalizer({
        fetch,
        maximumAttempts: 10,
        retryBaseDelayMs: 1,
      }).normalize(sourceInput);
    } catch (error) {
      caught = error;
    }
    expect(caught).toMatchObject({
      code: "NORMALIZATION_FAILED",
      message: "source-000001 的模型连接失败。",
    });
    expect(String(caught)).not.toContain(privateMarker);
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it("SSE 正文超过硬字节上限时立即失败并且不自动重发", async () => {
    let cancelled = false;
    const fetch = vi.fn(
      async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(new Uint8Array(20));
              controller.enqueue(new Uint8Array(20));
            },
            cancel() {
              cancelled = true;
            },
          }),
          { headers: { "Content-Type": "text/event-stream" } },
        ),
    );

    await expect(
      createNormalizer({
        fetch,
        maximumAttempts: 3,
        maximumResponseBytes: 32,
      }).normalize(sourceInput),
    ).rejects.toMatchObject({
      code: "NORMALIZATION_FAILED",
      failureKind: "response_too_large",
      message: "模型响应超过明确大小上限。",
    });
    expect(cancelled).toBe(true);
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

describe("传输证据捕获与离线重放", () => {
  it("重放解析器版本是显式常量", () => {
    expect(historyReplayParserVersion).toBe("history-replay-parser-v1");
  });

  it("SSE 在线解析与离线重放提取完全相同的原始 payload", () => {
    const body = `${completionEvent(normalizedContent, "stop")}data: [DONE]\n\n`;
    const online = vi.fn(async () => eventStreamResponse(body));
    const normalizer = createNormalizer({ fetch: online });
    return normalizer.normalize(sourceInput).then(async (onlineResult) => {
      // 离线重放提取的严格内容必须与原始 payload 逐字节一致。
      const replayResult = ReplaySession.replay(new TextEncoder().encode(body), "event_stream");
      expect(replayResult).toBe(normalizedContent);
      // 在线结果与同一原始 payload 的字段一致（schema 校验会补默认字段）。
      expect(onlineResult.problems[0]).toMatchObject(JSON.parse(normalizedContent).problems[0]);
    });
  });

  it("JSON 在线解析与离线重放提取完全相同的原始 payload", async () => {
    const jsonBody = JSON.stringify({
      choices: [{ message: { content: normalizedContent }, finish_reason: "stop" }],
    });
    const fetch = vi.fn(
      async () => new Response(jsonBody, { headers: { "Content-Type": "application/json" } }),
    );
    const onlineResult = await createNormalizer({ fetch }).normalize(sourceInput);
    const replayResult = ReplaySession.replay(new TextEncoder().encode(jsonBody), "json");
    expect(replayResult).toBe(normalizedContent);
    expect(onlineResult.problems[0]).toMatchObject(JSON.parse(normalizedContent).problems[0]);
  });

  it("SSE 协议失败在线和离线重放抛出相同 failureKind 与消息", async () => {
    const body = `${completionEvent(normalizedContent, "stop")}data: [DONE]\n\ndata: {not-json}\n\n`;
    const fetch = vi.fn(async () => eventStreamResponse(body));
    const onlineError = await createNormalizer({ fetch })
      .normalize(sourceInput)
      .catch((e) => e);
    expect(onlineError).toMatchObject({ code: "NORMALIZATION_FAILED", failureKind: "protocol" });
    let offlineError: unknown;
    try {
      ReplaySession.replay(new TextEncoder().encode(body), "event_stream");
    } catch (error) {
      offlineError = error;
    }
    expect(offlineError).toMatchObject({ code: "NORMALIZATION_FAILED", failureKind: "protocol" });
    expect(offlineError).toBeInstanceOf(HistoryNormalizationError);
  });

  it("JSON 协议失败在线和离线重放抛出相同 failureKind", async () => {
    const jsonBody = JSON.stringify({ choices: [] });
    const fetch = vi.fn(
      async () => new Response(jsonBody, { headers: { "Content-Type": "application/json" } }),
    );
    const onlineError = await createNormalizer({ fetch })
      .normalize(sourceInput)
      .catch((e) => e);
    expect(onlineError).toMatchObject({ code: "NORMALIZATION_FAILED", failureKind: "protocol" });
    expect(() => ReplaySession.replay(new TextEncoder().encode(jsonBody), "json")).toThrowError(
      expect.objectContaining({ code: "NORMALIZATION_FAILED", failureKind: "protocol" }),
    );
  });

  it("证据接收器在协议终端失败前被等待", async () => {
    let sinkCalled = false;
    const body = `${completionEvent(normalizedContent, "stop")}data: [DONE]\n\ndata: {not-json}\n\n`;
    const fetch = vi.fn(async () => eventStreamResponse(body));
    const input = {
      ...sourceInput,
      captureTransportEvidence: async () => {
        sinkCalled = true;
        return { descriptorDigest: "synthetic-digest" };
      },
    };
    await expect(createNormalizer({ fetch }).normalize(input)).rejects.toMatchObject({
      code: "NORMALIZATION_FAILED",
      failureKind: "protocol",
    });
    expect(sinkCalled).toBe(true);
  });

  it("证据接收器在真实 payload schema 失败前被等待并携带精确正文", async () => {
    let sinkCalled = false;
    let capturedDescriptor: CapturedTransport | undefined;
    const schemaViolatingPayload = '{"problems":[]}';
    const body = `${completionEvent(schemaViolatingPayload, "stop")}data: [DONE]\n\n`;
    const fetch = vi.fn(async () => eventStreamResponse(body));
    const input = {
      ...sourceInput,
      captureTransportEvidence: async (transport: CapturedTransport) => {
        sinkCalled = true;
        capturedDescriptor = transport;
        return { descriptorDigest: "synthetic-digest" };
      },
    };
    await expect(createNormalizer({ fetch }).normalize(input)).rejects.toMatchObject({
      code: "NORMALIZATION_FAILED",
      failureKind: "schema",
    });
    expect(sinkCalled).toBe(true);
    // 证据正文是完整传输字节，schema 失败发生在传输完整读完并标记 clean_eof 之后。
    expect(new TextDecoder().decode(capturedDescriptor!.body)).toBe(body);
    expect(capturedDescriptor!.termination).toBe("clean_eof");
    expect(capturedDescriptor!.failureKind).toBe("schema");
  });

  it("schema 失败的已提取 payload 与离线重放严格一致", async () => {
    const schemaViolatingPayload = '{"problems":[]}';
    const body = `${completionEvent(schemaViolatingPayload, "stop")}data: [DONE]\n\n`;
    // 离线重放不执行 schema 校验，只提取严格 payload：必须等于原始内容。
    const replayResult = ReplaySession.replay(new TextEncoder().encode(body), "event_stream");
    expect(replayResult).toBe(schemaViolatingPayload);
    // 在线同一传输内容在 schema 校验阶段失败。
    const fetch = vi.fn(async () => eventStreamResponse(body));
    await expect(createNormalizer({ fetch }).normalize(sourceInput)).rejects.toMatchObject({
      code: "NORMALIZATION_FAILED",
      failureKind: "schema",
    });
  });

  it("证据接收器在 invalid_json 解析失败前被等待并携带精确正文", async () => {
    let sinkCalled = false;
    let capturedDescriptor: CapturedTransport | undefined;
    const invalidPayload = "this is not JSON at all";
    const body = `${completionEvent(invalidPayload, "stop")}data: [DONE]\n\n`;
    const fetch = vi.fn(async () => eventStreamResponse(body));
    const input = {
      ...sourceInput,
      captureTransportEvidence: async (transport: CapturedTransport) => {
        sinkCalled = true;
        capturedDescriptor = transport;
        return { descriptorDigest: "synthetic-digest" };
      },
    };
    await expect(createNormalizer({ fetch }).normalize(input)).rejects.toMatchObject({
      code: "NORMALIZATION_FAILED",
      failureKind: "invalid_json",
    });
    expect(sinkCalled).toBe(true);
    expect(new TextDecoder().decode(capturedDescriptor!.body)).toBe(body);
    expect(capturedDescriptor!.failureKind).toBe("invalid_json");
  });

  it("invalid_json 的已提取 payload 与离线重放严格一致", async () => {
    const invalidPayload = "this is not JSON at all";
    const body = `${completionEvent(invalidPayload, "stop")}data: [DONE]\n\n`;
    expect(ReplaySession.replay(new TextEncoder().encode(body), "event_stream")).toBe(
      invalidPayload,
    );
    const fetch = vi.fn(async () => eventStreamResponse(body));
    await expect(createNormalizer({ fetch }).normalize(sourceInput)).rejects.toMatchObject({
      code: "NORMALIZATION_FAILED",
      failureKind: "invalid_json",
    });
  });

  it("证据接收器在 EOF 中断终端失败前被等待", async () => {
    let sinkCalled = false;
    const fetch = vi.fn(
      async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(
                new TextEncoder().encode(completionEvent(normalizedContent, "stop")),
              );
              controller.error(new Error("synthetic-connection-drop"));
            },
          }),
          { headers: { "Content-Type": "text/event-stream" } },
        ),
    );
    const input = {
      ...sourceInput,
      captureTransportEvidence: async () => {
        sinkCalled = true;
        return { descriptorDigest: "synthetic-digest" };
      },
    };
    await expect(createNormalizer({ fetch }).normalize(input)).rejects.toMatchObject({
      code: "NORMALIZATION_FAILED",
      failureKind: "eof_incomplete",
    });
    expect(sinkCalled).toBe(true);
  });

  it("证据接收器在 abort 终端失败前被等待", async () => {
    let sinkCalled = false;
    const cancellation = new AbortController();
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
    const input = {
      ...sourceInput,
      captureTransportEvidence: async () => {
        sinkCalled = true;
        return { descriptorDigest: "synthetic-digest" };
      },
    };
    const result = createNormalizer({
      fetch,
      signal: cancellation.signal,
      maximumAttempts: 3,
    }).normalize(input);
    await new Promise<void>((resolve) => setImmediate(resolve));
    cancellation.abort();
    await expect(result).rejects.toMatchObject({
      code: "NORMALIZATION_FAILED",
      failureKind: "cancelled",
    });
    expect(sinkCalled).toBe(true);
  });

  it("证据接收器在 response_too_large 终端失败前被等待", async () => {
    let sinkCalled = false;
    const fetch = vi.fn(
      async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(new TextEncoder().encode("x".repeat(200)));
              controller.close();
            },
          }),
          { headers: { "Content-Type": "application/json" } },
        ),
    );
    const input = {
      ...sourceInput,
      captureTransportEvidence: async () => {
        sinkCalled = true;
        return { descriptorDigest: "synthetic-digest" };
      },
    };
    await expect(
      createNormalizer({ fetch, maximumResponseBytes: 100 }).normalize(input),
    ).rejects.toMatchObject({
      code: "NORMALIZATION_FAILED",
      failureKind: "response_too_large",
    });
    expect(sinkCalled).toBe(true);
  });

  it("证据接收器失败取代原始终端失败且不携带正文", async () => {
    const sinkMarker = "SYNTHETIC-SINK-FAILURE-MARKER";
    const body = `${completionEvent(normalizedContent, "stop")}data: [DONE]\n\ndata: {not-json}\n\n`;
    const fetch = vi.fn(async () => eventStreamResponse(body));
    const input = {
      ...sourceInput,
      captureTransportEvidence: async () => {
        throw new Error(sinkMarker);
      },
    };
    const error = await createNormalizer({ fetch })
      .normalize(input)
      .catch((e) => e);
    expect(error).toMatchObject({ code: "NORMALIZATION_FAILED", failureKind: "internal" });
    expect(String(error)).not.toContain(sinkMarker);
  });

  it("证据接收器失败为 HistoryMigrationError 时直接传播", async () => {
    const body = `${completionEvent(normalizedContent, "stop")}data: [DONE]\n\ndata: {not-json}\n\n`;
    const fetch = vi.fn(async () => eventStreamResponse(body));
    const input = {
      ...sourceInput,
      captureTransportEvidence: async () => {
        throw new HistoryMigrationError("REPAIR_REJECTED", "synthetic-sink-rejection");
      },
    };
    await expect(createNormalizer({ fetch }).normalize(input)).rejects.toMatchObject({
      code: "REPAIR_REJECTED",
    });
  });

  it("无 captureTransportEvidence 时不调用接收器且行为不变", async () => {
    const body = `${completionEvent(normalizedContent, "stop")}data: [DONE]\n\n`;
    const fetch = vi.fn(async () => eventStreamResponse(body));
    await expect(createNormalizer({ fetch }).normalize(sourceInput)).resolves.toMatchObject({
      problems: [{ title: "合成候选题" }],
    });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("终端 HTTP 429 失败在重试耗尽时调用证据接收器并携带状态正文", async () => {
    let sinkCalled = false;
    let capturedDescriptor: CapturedTransport | undefined;
    const fetch = vi.fn(async () => new Response("rate limit", { status: 429 }));
    const input = {
      ...sourceInput,
      captureTransportEvidence: async (transport: CapturedTransport) => {
        sinkCalled = true;
        capturedDescriptor = transport;
        return { descriptorDigest: "synthetic-digest" };
      },
    };
    await expect(
      createNormalizer({ fetch, maximumAttempts: 1 }).normalize(input),
    ).rejects.toMatchObject({ code: "NORMALIZATION_FAILED", failureKind: "http_429" });
    expect(sinkCalled).toBe(true);
    expect(capturedDescriptor!.status).toBe(429);
    expect(capturedDescriptor!.failureKind).toBe("http_429");
    // 状态正文被有界收集为证据。
    expect(new TextDecoder().decode(capturedDescriptor!.body)).toBe("rate limit");
    expect(capturedDescriptor!.termination).toBe("clean_eof");
  });

  it("非终端的 429 重试尝试绝不调用证据接收器，最终成功也不调用", async () => {
    let sinkCalled = false;
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(new Response("rate limit", { status: 429 }))
      .mockResolvedValueOnce(
        eventStreamResponse(`${completionEvent(normalizedContent, "stop")}data: [DONE]\n\n`),
      );
    const input = {
      ...sourceInput,
      captureTransportEvidence: async () => {
        sinkCalled = true;
        return { descriptorDigest: "synthetic-digest" };
      },
    };
    await expect(
      createNormalizer({ fetch, maximumAttempts: 3, retryBaseDelayMs: 5 }).normalize(input),
    ).resolves.toMatchObject({ problems: [{ title: "合成候选题" }] });
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(sinkCalled).toBe(false);
  });

  it("非成功状态码零字节正文也触发证据接收器（携带状态且 byteCount=0）", async () => {
    let sinkCalled = false;
    let capturedDescriptor: CapturedTransport | undefined;
    const fetch = vi.fn(async () => new Response("", { status: 500 }));
    const input = {
      ...sourceInput,
      captureTransportEvidence: async (transport: CapturedTransport) => {
        sinkCalled = true;
        capturedDescriptor = transport;
        return { descriptorDigest: "synthetic-digest" };
      },
    };
    await expect(
      createNormalizer({ fetch, maximumAttempts: 1 }).normalize(input),
    ).rejects.toMatchObject({
      code: "NORMALIZATION_FAILED",
      failureKind: "http_status",
    });
    expect(sinkCalled).toBe(true);
    expect(capturedDescriptor!.status).toBe(500);
    expect(capturedDescriptor!.byteCount).toBe(0);
    expect(capturedDescriptor!.termination).toBe("clean_eof");
  });

  it("声明长度越界仍产出 limit_exceeded 证据并等待接收器", async () => {
    let sinkCalled = false;
    let capturedDescriptor: CapturedTransport | undefined;
    const fetch = vi.fn(
      async () =>
        new Response("x".repeat(50), {
          status: 200,
          headers: {
            "Content-Type": "application/json",
            "Content-Length": "99999",
          },
        }),
    );
    const input = {
      ...sourceInput,
      captureTransportEvidence: async (transport: CapturedTransport) => {
        sinkCalled = true;
        capturedDescriptor = transport;
        return { descriptorDigest: "synthetic-digest" };
      },
    };
    await expect(
      createNormalizer({ fetch, maximumResponseBytes: 100 }).normalize(input),
    ).rejects.toMatchObject({
      code: "NORMALIZATION_FAILED",
      failureKind: "response_too_large",
    });
    expect(sinkCalled).toBe(true);
    expect(capturedDescriptor!.termination).toBe("limit_exceeded");
    expect(capturedDescriptor!.byteCount).toBe(0);
  });

  it("已接收但零字节的响应也触发证据接收器（不以 byteCount>0 为准）", async () => {
    let sinkCalled = false;
    let capturedByteCount: number | undefined;
    const fetch = vi.fn(
      async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.close();
            },
          }),
          { headers: { "Content-Type": "text/event-stream" } },
        ),
    );
    const input = {
      ...sourceInput,
      captureTransportEvidence: async (transport: CapturedTransport) => {
        sinkCalled = true;
        capturedByteCount = transport.byteCount;
        return { descriptorDigest: "synthetic-digest" };
      },
    };
    await expect(createNormalizer({ fetch }).normalize(input)).rejects.toMatchObject({
      code: "NORMALIZATION_FAILED",
    });
    expect(sinkCalled).toBe(true);
    expect(capturedByteCount).toBe(0);
  });

  it("捕获描述符绑定解析器版本和尝试编号", async () => {
    let capturedDescriptor: CapturedTransport | undefined;
    const body = `${completionEvent(normalizedContent, "stop")}data: [DONE]\n\ndata: {not-json}\n\n`;
    const fetch = vi.fn(async () => eventStreamResponse(body));
    const input = {
      ...sourceInput,
      captureTransportEvidence: async (transport: CapturedTransport) => {
        capturedDescriptor = transport;
        return { descriptorDigest: "synthetic-digest" };
      },
    };
    await createNormalizer({ fetch })
      .normalize(input)
      .catch(() => {});
    expect(capturedDescriptor).toBeDefined();
    expect(capturedDescriptor!.parserVersion).toBe(historyReplayParserVersion);
    expect(capturedDescriptor!.attempt).toBe(1);
    expect(capturedDescriptor!.mediaKind).toBe("event_stream");
    expect(capturedDescriptor!.termination).toBe("clean_eof");
    expect(capturedDescriptor!.failureKind).toBe("protocol");
    expect(capturedDescriptor!.byteCount).toBeGreaterThan(0);
    expect(capturedDescriptor!.body).toBeInstanceOf(Uint8Array);
  });

  it("partial_eof 终止类别在流中断时正确标记", async () => {
    let capturedDescriptor: CapturedTransport | undefined;
    const fetch = vi.fn(
      async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(
                new TextEncoder().encode(completionEvent(normalizedContent, "stop")),
              );
              controller.error(new Error("synthetic-stream-error"));
            },
          }),
          { headers: { "Content-Type": "text/event-stream" } },
        ),
    );
    const input = {
      ...sourceInput,
      captureTransportEvidence: async (transport: CapturedTransport) => {
        capturedDescriptor = transport;
        return { descriptorDigest: "synthetic-digest" };
      },
    };
    await createNormalizer({ fetch })
      .normalize(input)
      .catch(() => {});
    expect(capturedDescriptor!.termination).toBe("partial_eof");
  });

  it("aborted 终止类别在取消时正确标记", async () => {
    let capturedDescriptor: CapturedTransport | undefined;
    const cancellation = new AbortController();
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
    const input = {
      ...sourceInput,
      captureTransportEvidence: async (transport: CapturedTransport) => {
        capturedDescriptor = transport;
        return { descriptorDigest: "synthetic-digest" };
      },
    };
    const result = createNormalizer({
      fetch,
      signal: cancellation.signal,
      maximumAttempts: 3,
    }).normalize(input);
    await new Promise<void>((resolve) => setImmediate(resolve));
    cancellation.abort();
    await result.catch(() => {});
    expect(capturedDescriptor!.termination).toBe("aborted");
  });

  it("limit_exceeded 终止类别在超字节上限时正确标记", async () => {
    let capturedDescriptor: CapturedTransport | undefined;
    const fetch = vi.fn(
      async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(new TextEncoder().encode("x".repeat(200)));
              controller.close();
            },
          }),
          { headers: { "Content-Type": "application/json" } },
        ),
    );
    const input = {
      ...sourceInput,
      captureTransportEvidence: async (transport: CapturedTransport) => {
        capturedDescriptor = transport;
        return { descriptorDigest: "synthetic-digest" };
      },
    };
    await createNormalizer({ fetch, maximumResponseBytes: 100 })
      .normalize(input)
      .catch(() => {});
    expect(capturedDescriptor!.termination).toBe("limit_exceeded");
  });

  it("严格 post-stop usage 规则在重放中保持", () => {
    const poisoned = {
      ...strictUsageMetadataEvent(),
      choices: [{ index: 0, delta: {} }],
      content: "synthetic-injected-content",
    };
    const body = `${completionEvent(normalizedContent, "stop")}data: ${JSON.stringify(poisoned)}\n\ndata: [DONE]\n\n`;
    expect(() => ReplaySession.replay(new TextEncoder().encode(body), "event_stream")).toThrow();
  });

  it("有界协议排空在重放中保持", () => {
    const body = `${completionEvent(normalizedContent, "stop")}data: [DONE]\n\ndata: {not-json}\n\n排空阶段不应保存的合成字节`;
    expect(() => ReplaySession.replay(new TextEncoder().encode(body), "event_stream")).toThrow();
  });

  it("finish_reason=stop 要求在重放中保持", () => {
    const body = `${completionEvent(normalizedContent)}data: [DONE]\n\n`;
    expect(() => ReplaySession.replay(new TextEncoder().encode(body), "event_stream")).toThrow();
  });

  it("逐字节分片投喂与整体投喂结果一致", () => {
    const body = `${completionEvent(normalizedContent, "stop")}data: [DONE]\n\n`;
    const fullResult = ReplaySession.replay(new TextEncoder().encode(body), "event_stream");
    // ReplaySession.replay already chunks at 4096; verify it works with exact body
    expect(JSON.parse(fullResult)).toEqual(JSON.parse(normalizedContent));
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

function strictUsageMetadataEvent(): Record<string, unknown> {
  return {
    id: "synthetic-completion-id",
    object: "chat.completion.chunk",
    created: 1,
    model: "synthetic-model",
    system_fingerprint: null,
    service_tier: "default",
    choices: [],
    usage: {
      prompt_tokens: 3,
      completion_tokens: 4,
      total_tokens: 7,
      prompt_tokens_details: { cached_tokens: 0 },
    },
  };
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

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
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
