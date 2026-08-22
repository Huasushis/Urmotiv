import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import {
  pluginManifestSchema,
  type BeforeSubmitInput,
  type BeforeSubmitResult,
  type ReviewItemInput
} from "@urmotiv/plugin-sdk";
import {
  AnklangClient,
  anklangCompletionStatus,
  anklangSettingsSchema,
  anklangV2ResultSchema,
  createAnklangCheck,
  type AnklangCache,
  type AnklangResult,
  type AnklangV2Result
} from "../src/index";

const contentHash = "a".repeat(64);
const checkedAt = "2026-08-01T00:00:00.000Z";
const expiresAt = "2026-08-01T01:00:00.000Z";
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

const candidate = {
  source: "公开题库",
  externalId: "sample-1",
  title: "相似的公开题",
  similarity: 0.82,
  sameProblemSuggestion: false
};

function v2Result(options: {
  status?: "complete" | "partial" | "unavailable";
  reasonCode?: string;
  retryable?: boolean;
  retryAfterSeconds?: number;
  candidates?: readonly Record<string, unknown>[];
  blockSubmission?: boolean;
  reuse?: Record<string, unknown>;
  checkedAt?: string;
  contentHash?: string;
  extra?: Record<string, unknown>;
} = {}): AnklangV2Result {
  const status = options.status ?? "complete";
  const completion: Record<string, unknown> =
    status === "complete"
      ? { status: "complete", reasonCode: "complete", retryable: false }
      : {
          status,
          reasonCode: options.reasonCode ?? "search_partial",
          retryable: options.retryable ?? true,
          ...(options.retryAfterSeconds === undefined
            ? {}
            : { retryAfterSeconds: options.retryAfterSeconds })
        };
  return anklangV2ResultSchema.parse({
    apiVersion: "2",
    contentHash: options.contentHash ?? contentHash,
    checkedAt: options.checkedAt ?? checkedAt,
    completion,
    candidates:
      options.candidates ?? (status === "unavailable" ? [] : [candidate]),
    recommendation: {
      blockSubmission: options.blockSubmission ?? false,
      message: "请继续人工核对。"
    },
    reuse:
      options.reuse ??
      (status === "complete"
        ? { policy: "allowed", expiresAt }
        : { policy: "no-store" }),
    ...options.extra
  });
}

function v1Result(overrides: Record<string, unknown> = {}): AnklangResult {
  return {
    apiVersion: "1",
    contentHash,
    checkedAt,
    candidates: [candidate],
    recommendation: { blockSubmission: false, message: "请继续人工核对。" },
    ...overrides
  } as AnklangResult;
}

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" }
  });
}

function request(version: "1" | "2") {
  return {
    apiVersion: version,
    requestId: "54b70dd8-5c21-4d31-84b7-6437b303c4f2",
    contentHash,
    problem: {
      title: input.problem.title,
      type: input.problem.type,
      tagIds: input.problem.tagIds,
      basicStatement: input.problem.basicStatement
    }
  } as const;
}

describe("Anklang 设置、清单与 HTTP 边界", () => {
  it("新配置默认使用 v2，并保留显式 v1 迁移选项", () => {
    expect(
      anklangSettingsSchema.parse({ baseUrl: "https://anklang.example.test" })
    ).toMatchObject({ apiVersion: "2", timeoutMs: 120_000 });
    expect(
      anklangSettingsSchema.parse({
        baseUrl: "https://anklang.example.test",
        apiVersion: "1"
      }).apiVersion
    ).toBe("1");

    const packagedSchema = JSON.parse(
      readFileSync(new URL("../settings.schema.json", import.meta.url), "utf8")
    ) as {
      properties?: {
        apiVersion?: { default?: unknown; enum?: unknown };
        timeoutMs?: { default?: unknown; maximum?: unknown };
      };
    };
    expect(packagedSchema.properties?.apiVersion).toMatchObject({
      default: "2",
      enum: ["2", "1"]
    });
    expect(packagedSchema.properties?.timeoutMs).toMatchObject({
      default: 120_000,
      maximum: 120_000
    });
    expect(() =>
      anklangSettingsSchema.parse({
        baseUrl: "https://anklang.example.test",
        timeoutMs: 120_001
      })
    ).toThrow();

    const manifest = pluginManifestSchema.parse(
      JSON.parse(readFileSync(new URL("../urmotiv-plugin.json", import.meta.url), "utf8"))
    );
    expect(manifest).toMatchObject({ version: "0.2.0", apiVersion: "1" });
  });

  it("拒绝服务地址中夹带账号密码", () => {
    expect(() =>
      anklangSettingsSchema.parse({ baseUrl: "https://user:secret@example.test" })
    ).toThrow();
  });

  it("v2 只发送查重所需字段，固定路径和版本且禁止重定向", async () => {
    const fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      expect(String(url)).toBe("https://anklang.example.test/api/v2/checks/similarity");
      expect(init?.redirect).toBe("error");
      expect(init?.headers).toEqual(
        expect.objectContaining({
          Authorization: "Bearer hidden-token",
          "X-Urmotiv-API-Version": "2"
        })
      );
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      expect(body.apiVersion).toBe("2");
      expect(JSON.stringify(body)).not.toContain(input.problem.basicSolution);
      return jsonResponse(v2Result());
    });
    const client = new AnklangClient({
      baseUrl: "https://anklang.example.test",
      token: "hidden-token",
      fetch
    });
    await expect(client.check(request("2"), new AbortController().signal)).resolves.toEqual(
      v2Result()
    );
  });

  it("只有显式配置才调用 v1 路径并要求 v1 正文", async () => {
    const fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      expect(String(url)).toBe("https://anklang.example.test/api/v1/checks/similarity");
      expect(init?.headers).toEqual(
        expect.objectContaining({ "X-Urmotiv-API-Version": "1" })
      );
      expect(JSON.parse(String(init?.body))).toMatchObject({ apiVersion: "1", contentHash });
      return jsonResponse(v1Result());
    });
    const client = new AnklangClient({
      baseUrl: "https://anklang.example.test",
      apiVersion: "1",
      fetch
    });
    await expect(client.check(request("1"), new AbortController().signal)).resolves.toEqual(
      v1Result()
    );
    await expect(client.check(request("2"), new AbortController().signal)).rejects.toThrow(
      "已配置的接口版本"
    );
  });

  it("拒绝非 JSON 媒体类型、串题摘要与响应额外字段，错误不含上游正文", async () => {
    const marker = "upstream-body-must-not-leak";
    const cases: Array<() => Promise<Response>> = [
      async () => new Response(JSON.stringify(v2Result()), { status: 200 }),
      async () => jsonResponse(v2Result({ contentHash: "b".repeat(64) })),
      async () => jsonResponse({ ...v2Result(), extraField: marker }),
      async () => new Response(marker, { status: 503, headers: { "Content-Type": "text/plain" } })
    ];
    for (const fetch of cases) {
      const client = new AnklangClient({ baseUrl: "https://anklang.example.test", fetch });
      const rejection = client.check(request("2"), new AbortController().signal);
      await expect(rejection).rejects.toThrow();
      await rejection.catch((error: unknown) => {
        expect(String(error)).not.toContain(marker);
        expect(String(error)).not.toContain("相似的公开题");
      });
    }
  });

  it("拒绝非法 UTF-8 与超过 2 MB 的响应体", async () => {
    const cases: Array<() => Promise<Response>> = [
      async () =>
        new Response(new Uint8Array([0xc3, 0x28]), {
          status: 200,
          headers: { "Content-Type": "application/json" }
        }),
      async () =>
        new Response(new Uint8Array(2_000_001), {
          status: 200,
          headers: { "Content-Type": "application/json" }
        })
    ];
    for (const fetch of cases) {
      const client = new AnklangClient({ baseUrl: "https://anklang.example.test", fetch });
      await expect(
        client.check(request("2"), new AbortController().signal)
      ).rejects.toThrow("格式不正确");
    }
  });
});

describe("v2 严格契约", () => {
  it("接受全部固定非完整原因，并拒绝未知原因和非法重试字段", () => {
    const reasons = [
      "search_timeout",
      "search_rate_limited",
      "search_backend_unavailable",
      "search_backend_invalid",
      "search_partial",
      "review_unavailable",
      "service_unavailable",
      "service_invalid_response",
      "internal_error"
    ];
    for (const reasonCode of reasons) {
      expect(
        anklangV2ResultSchema.safeParse(
          v2Result({ status: "partial", reasonCode, retryable: true })
        ).success
      ).toBe(true);
    }

    const base = v2Result({ status: "partial" }) as unknown as Record<string, unknown>;
    expect(
      anklangV2ResultSchema.safeParse({
        ...base,
        completion: { status: "partial", reasonCode: "unknown", retryable: true }
      }).success
    ).toBe(false);
    expect(
      anklangV2ResultSchema.safeParse({
        ...base,
        completion: {
          status: "partial",
          reasonCode: "search_partial",
          retryable: false,
          retryAfterSeconds: 30
        }
      }).success
    ).toBe(false);
  });

  it("严格拒绝非 UTC、超过七天、跨分支字段和不可信 partial 拦截", () => {
    const complete = v2Result() as unknown as Record<string, unknown>;
    const partial = v2Result({ status: "partial" }) as unknown as Record<string, unknown>;
    const unavailable = v2Result({
      status: "unavailable",
      reasonCode: "service_unavailable"
    }) as unknown as Record<string, unknown>;
    const invalid = [
      { ...complete, checkedAt: "2026-08-01T00:00:00+00:00" },
      { ...complete, reuse: { policy: "allowed", expiresAt: "2026-08-09T00:00:00.000Z" } },
      {
        ...partial,
        recommendation: { blockSubmission: true, message: "不可信拦截" }
      },
      { ...partial, reuse: { policy: "allowed", expiresAt } },
      { ...unavailable, candidates: [candidate] },
      {
        ...unavailable,
        recommendation: { blockSubmission: true, message: "不可用时不能拦截" }
      },
      { ...complete, unknown: true },
      {
        ...complete,
        completion: { status: "complete", reasonCode: "complete", retryable: false, extra: true }
      },
      { ...complete, candidates: [{ ...candidate, extra: true }] },
      {
        ...complete,
        recommendation: { blockSubmission: false, message: "固定说明", extra: true }
      },
      {
        ...complete,
        reuse: { policy: "allowed", expiresAt, extra: true }
      }
    ];
    for (const value of invalid) {
      expect(anklangV2ResultSchema.safeParse(value).success).toBe(false);
    }
  });
});

describe("提交前相似度检查与缓存", () => {
  it("只缓存 complete + allowed，并严格使用服务的绝对到期时间", async () => {
    let current = new Date(checkedAt);
    let stored: { key: string; value: unknown; expiresAt: string } | undefined;
    const cache: AnklangCache = {
      get: vi.fn(async (key) =>
        stored !== undefined && stored.key === key ? stored.value : undefined
      ),
      set: vi.fn(async (key, value, expiry) => {
        stored = { key, value, expiresAt: expiry };
      })
    };
    const fetch = vi.fn(async () => jsonResponse(v2Result()));
    const check = createAnklangCheck({
      settings: anklangSettingsSchema.parse({ baseUrl: "https://anklang.example.test" }),
      cache,
      fetch,
      now: () => current
    });

    await check.run(input, { signal: new AbortController().signal });
    expect(cache.set).toHaveBeenCalledTimes(1);
    expect(stored?.expiresAt).toBe(expiresAt);
    expect(stored?.key).toContain(`2:https://anklang.example.test/:1440:${contentHash}`);
    await check.run(input, { signal: new AbortController().signal });
    expect(fetch).toHaveBeenCalledTimes(1);

    current = new Date("2026-08-01T01:00:00.001Z");
    await check.run(input, { signal: new AbortController().signal });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("过期 allowed 结果仍可作为本次完整结果，但绝不写入缓存", async () => {
    const cache: AnklangCache = {
      get: vi.fn(async () => undefined),
      set: vi.fn(async () => undefined)
    };
    const check = createAnklangCheck({
      settings: anklangSettingsSchema.parse({ baseUrl: "https://anklang.example.test" }),
      cache,
      fetch: async () => jsonResponse(v2Result()),
      now: () => new Date("2026-08-01T02:00:00.000Z")
    });
    const output = await check.run(input, { signal: new AbortController().signal });
    expect(output.decision).toBe("continue");
    expect(cache.set).not.toHaveBeenCalled();
  });

  it("本地保留上限收紧服务期限，缓存读写故障不破坏本次可信结果", async () => {
    const set = vi.fn(async () => {
      throw new Error("cache-write-marker");
    });
    const cache: AnklangCache = {
      get: vi.fn(async () => {
        throw new Error("cache-read-marker");
      }),
      set
    };
    const fetch = vi.fn(async () =>
      jsonResponse(
        v2Result({
          reuse: { policy: "allowed", expiresAt: "2026-08-08T00:00:00.000Z" }
        })
      )
    );
    const check = createAnklangCheck({
      settings: anklangSettingsSchema.parse({
        baseUrl: "https://anklang.example.test",
        cacheMinutes: 60
      }),
      cache,
      fetch,
      now: () => new Date(checkedAt)
    });
    await expect(
      check.run(input, { signal: new AbortController().signal })
    ).resolves.toMatchObject({ decision: "continue" });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(set).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(Object),
      "2026-08-01T01:00:00.000Z"
    );
  });

  it("设置从长缓存收紧为短缓存后不复用旧设置写入的结果", async () => {
    const stored = new Map<string, unknown>();
    const cache: AnklangCache = {
      get: vi.fn(async (key) => stored.get(key)),
      set: vi.fn(async (key, value) => {
        stored.set(key, value);
      })
    };
    const fetch = vi.fn(async () => jsonResponse(v2Result()));
    const common = {
      cache,
      fetch,
      now: () => new Date(checkedAt)
    };

    const longCacheCheck = createAnklangCheck({
      ...common,
      settings: anklangSettingsSchema.parse({
        baseUrl: "https://anklang.example.test",
        cacheMinutes: 1_440
      })
    });
    const shortCacheCheck = createAnklangCheck({
      ...common,
      settings: anklangSettingsSchema.parse({
        baseUrl: "https://anklang.example.test",
        cacheMinutes: 1
      })
    });

    await longCacheCheck.run(input, { signal: new AbortController().signal });
    await shortCacheCheck.run(input, { signal: new AbortController().signal });

    expect(fetch).toHaveBeenCalledTimes(2);
    expect(stored.size).toBe(2);
  });

  it("complete + no-store、partial 与 unavailable 都不写业务缓存", async () => {
    for (const response of [
      v2Result({ reuse: { policy: "no-store" } }),
      v2Result({ status: "partial" }),
      v2Result({ status: "unavailable", reasonCode: "service_unavailable" })
    ]) {
      const cache: AnklangCache = {
        get: vi.fn(async () => undefined),
        set: vi.fn(async () => undefined)
      };
      const check = createAnklangCheck({
        settings: anklangSettingsSchema.parse({
          baseUrl: "https://anklang.example.test",
          failureBehavior: "continue"
        }),
        cache,
        fetch: async () => jsonResponse(response),
        now: () => new Date(checkedAt)
      });
      const output = await check.run(input, { signal: new AbortController().signal });
      expect(output.decision).toBe("continue");
      expect(cache.set).not.toHaveBeenCalled();
      if (response.completion.status !== "complete") {
        expect(anklangCompletionStatus(output.decision === "continue" ? output.reviewItems?.[0]?.data : null))
          .toBe(response.completion.status);
      }
    }
  });

  it("partial 只有可信同题复核可拦截，并保留低于显示阈值的拦截依据", async () => {
    const trusted = v2Result({
      status: "partial",
      candidates: [{ ...candidate, similarity: 0.1, sameProblemSuggestion: true }],
      blockSubmission: true
    });
    const check = createAnklangCheck({
      settings: anklangSettingsSchema.parse({
        baseUrl: "https://anklang.example.test",
        minimumSimilarityToShow: 0.9
      }),
      fetch: async () => jsonResponse(trusted)
    });
    const output = await check.run(input, { signal: new AbortController().signal });
    expect(output).toEqual({
      decision: "block",
      code: "anklang_partial_same_problem",
      message: "请继续人工核对。",
      details: { candidateCount: 1, maximumSimilarity: 0.1, contentHash }
    });
    expect(JSON.stringify(output)).not.toContain("sample-1");
    expect(JSON.stringify(output)).not.toContain(input.problem.basicStatement);
  });

  it("未完整结果按 failureBehavior 阻止或明确降级，不会伪装成完整空候选", async () => {
    const partial = v2Result({ status: "partial", candidates: [] });
    const blocking = createAnklangCheck({
      settings: anklangSettingsSchema.parse({ baseUrl: "https://anklang.example.test" }),
      fetch: async () => jsonResponse(partial)
    });
    await expect(
      blocking.run(input, { signal: new AbortController().signal })
    ).rejects.toThrow("没有完整完成");

    const continuing = createAnklangCheck({
      settings: anklangSettingsSchema.parse({
        baseUrl: "https://anklang.example.test",
        failureBehavior: "continue"
      }),
      fetch: async () => jsonResponse(partial)
    });
    const output = await continuing.run(input, { signal: new AbortController().signal });
    expect(output).toMatchObject({
      decision: "continue",
      reviewItems: [{ summary: expect.stringContaining("只完成了一部分") }]
    });
  });

  it("网络与畸形响应在 continue 模式生成固定 unavailable 条目且不泄露原文", async () => {
    const marker = "raw-upstream-secret-marker";
    for (const fetch of [
      async () => {
        throw new Error(marker);
      },
      async () => jsonResponse({ ...v2Result(), extra: marker })
    ]) {
      const check = createAnklangCheck({
        settings: anklangSettingsSchema.parse({
          baseUrl: "https://anklang.example.test",
          failureBehavior: "continue"
        }),
        fetch
      });
      const output = await check.run(input, { signal: new AbortController().signal });
      expect(output).toMatchObject({
        decision: "continue",
        reviewItems: [
          {
            summary: expect.stringContaining("暂不可用"),
            data: {
              apiVersion: "2",
              completion: { status: "unavailable" },
              candidates: []
            }
          }
        ]
      });
      // 本地生成的 unavailable 条目不合成推荐或复用策略，字段整体省略。
      const dataJson = JSON.stringify((output as { reviewItems: unknown[] }).reviewItems[0]);
      expect(dataJson).not.toContain('"recommendation"');
      expect(dataJson).not.toContain('"reuse"');
      expect(JSON.stringify(output)).not.toContain(marker);
      expect(JSON.stringify(output)).not.toContain(input.problem.basicStatement);
    }
  });
});

describe("candidate.metadata 镜像契约", () => {
  function continueReviewItems(output: BeforeSubmitResult): ReviewItemInput[] {
    if (output.decision !== "continue") {
      throw new Error("metadata 用例应为放行决策，不应拦截。");
    }
    return output.reviewItems ?? [];
  }

  function withCandidateMetadata(metadata: unknown): AnklangV2Result {
    return {
      ...v2Result(),
      candidates: [{ ...candidate, metadata }]
    } as unknown as AnklangV2Result;
  }

  function parseV2(metadata: unknown): boolean {
    return anklangV2ResultSchema.safeParse(withCandidateMetadata(metadata)).success;
  }

  function throughReviewItem(metadata: unknown) {
    const ck = createAnklangCheck({
      settings: anklangSettingsSchema.parse({ baseUrl: "https://anklang.example.test" }),
      fetch: async () => jsonResponse(withCandidateMetadata(metadata))
    });
    return ck.run(input, { signal: new AbortController().signal });
  }

  it("合法标量 metadata（字符串/安全整数/布尔/null）原样保留进 review-item，决策输入不变", async () => {
    const metadata = {
      origin: "CF 1000A",
      rounds: 3,
      pinned: true,
      archived: null,
      display_order: 2,
      limit: Number.MAX_SAFE_INTEGER,
      floor: Number.MIN_SAFE_INTEGER
    };
    const output = await throughReviewItem(metadata);
    expect(output.decision).toBe("continue");
    const data = continueReviewItems(output)[0]?.data as AnklangV2Result;
    expect(data.candidates[0]).toMatchObject({ metadata });
    expect(
      (anklangV2ResultSchema.parse(data).candidates[0] as Record<string, unknown> | undefined)
        ?.metadata
    ).toEqual(metadata);
  });

  it("v1 候选携带 metadata 仍被拒绝；v2 空对象与缺失同样视为没有 metadata", async () => {
    // v1 候选 schema 未声明 metadata：strict 拒绝携带 metadata 的 v1 候选。
    const v1 = { ...v1Result(), candidates: [{ ...candidate, metadata: { a: "b" } }] };
    const client = new AnklangClient({
      baseUrl: "https://anklang.example.test",
      apiVersion: "1",
      fetch: async () => jsonResponse(v1)
    });
    await expect(client.check(request("1"), new AbortController().signal)).rejects.toThrow(
      "格式不正确"
    );

    // v2 空对象在解析边界规范化为缺失：candidates 里不再出现 metadata 键。
    const empty = anklangV2ResultSchema.parse(withCandidateMetadata({}));
    expect(Object.hasOwn(empty.candidates[0] ?? {}, "metadata")).toBe(false);
    const absent = anklangV2ResultSchema.parse(withCandidateMetadata(undefined));
    expect(Object.hasOwn(absent.candidates[0] ?? {}, "metadata")).toBe(false);
    const preserved = anklangV2ResultSchema.parse(withCandidateMetadata({ origin: "CF" }));
    expect(
      (preserved.candidates[0] as Record<string, unknown> | undefined)?.metadata
    ).toEqual({ origin: "CF" });
  });

  it("键名、键数量、值类型与整包字节的每个边界都 fail closed", () => {
    const invalidKeyBadChar = parseV2({ BadKey: "x" });
    expect(invalidKeyBadChar).toBe(false);

    const invalidKeyDigitStart = parseV2({ OneAbc: "x" });
    expect(invalidKeyDigitStart).toBe(false);

    const invalidKeyHyphen = parseV2({ "a-b": "x" });
    expect(invalidKeyHyphen).toBe(false);

    const invalidKeyDot = parseV2({ "a.b": "x" });
    expect(invalidKeyDot).toBe(false);

    const tooLongKey = parseV2({ [`a${"a".repeat(64)}`]: "x" });
    expect(tooLongKey).toBe(false);

    const emptyKey = parseV2({ "": "x" });
    expect(emptyKey).toBe(false);

    const tooManyKeys = parseV2(
      Object.fromEntries(Array.from({ length: 17 }, (_, i) => [`k${i}`, "x"]))
    );
    expect(tooManyKeys).toBe(false);

    const nestedObject = parseV2({ nested: { value: 1 } });
    expect(nestedObject).toBe(false);

    const nestedArray = parseV2({ children: [1, 2, 3] });
    expect(nestedArray).toBe(false);

    const emptyStringValue = parseV2({ empty: "" });
    expect(emptyStringValue).toBe(false);

    const untrimmed = parseV2({ untrimmed: "  x " });
    expect(untrimmed).toBe(false);

    const tooLongString = parseV2({ long: "中".repeat(171) });
    expect(tooLongString).toBe(false);

    const fractional = parseV2({ float: 1.5 });
    expect(fractional).toBe(false);

    const negativeZero = parseV2({ negativeZero: -0 });
    expect(negativeZero).toBe(false);

    const outOfRange = parseV2({ beyond: Number.MAX_SAFE_INTEGER + 1 });
    expect(outOfRange).toBe(false);

    const nonFinite = parseV2({
      infinity: Number.POSITIVE_INFINITY,
      nan: Number.NaN
    });
    expect(nonFinite).toBe(false);

    // 16 个键、每值 500 字节 → 整包超 2048 字节；单值仍 ≤512。
    const overBudget = parseV2(
      Object.fromEntries(Array.from({ length: 16 }, (_, i) => [`k${i}`, "x".repeat(500)]))
    );
    expect(overBudget).toBe(false);
  });

  it("有/无 metadata 时 contentHash、相似度、推荐与决策逐字节不变", async () => {
    const withMetadata = await throughReviewItem({ origin: "CF", rounds: 3 });
    const withoutMetadata = await throughReviewItem(undefined);
    expect(withMetadata.decision).toBe(withoutMetadata.decision);
    expect(withMetadata).toMatchObject(withoutMetadata);
    const withData = continueReviewItems(withMetadata)[0]?.data as AnklangV2Result;
    const withoutData = continueReviewItems(withoutMetadata)[0]?.data as AnklangV2Result;
    expect(withData.contentHash).toBe(withoutData.contentHash);
    expect(withData.candidates[0]?.similarity).toBe(withoutData.candidates[0]?.similarity);
    expect(withData.recommendation).toEqual(withoutData.recommendation);
  });
});

describe("搜索型只读结果：recommendation 与 reuse 可选", () => {
  /** 真实 Anklang 只会返回检索候选，不携带决策字段的完整 v2 结果。 */
  function bareV2Result(overrides: Record<string, unknown> = {}): AnklangV2Result {
    return anklangV2ResultSchema.parse({
      apiVersion: "2",
      contentHash,
      checkedAt,
      candidates: [candidate],
      completion: { status: "complete", reasonCode: "complete", retryable: false },
      ...overrides
    });
  }

  it("正路径：五字段完整 v2 结果（无 recommendation/reuse）携带候选 metadata 被接受", async () => {
    const withMetadata: Record<string, unknown> = {
      ...candidate,
      metadata: { origin: "CF", rounds: 3, pinned: true, archived: null }
    };
    const value = bareV2Result({ candidates: [withMetadata] });
    expect(value.recommendation).toBeUndefined();
    expect(value.reuse).toBeUndefined();
    expect(
      (value.candidates[0] as Record<string, unknown> | undefined)?.metadata
    ).toEqual({
      origin: "CF",
      rounds: 3,
      pinned: true,
      archived: null
    });

    const check = createAnklangCheck({
      settings: anklangSettingsSchema.parse({
        baseUrl: "https://anklang.example.test",
        failureBehavior: "continue",
        blockWhenRecommended: true
      }),
      fetch: async () => jsonResponse(value)
    });
    const output = await check.run(input, { signal: new AbortController().signal });
    expect(output.decision).toBe("continue");
    const data = (output as { reviewItems?: unknown[] }).reviewItems?.[0] as
      | { data: AnklangV2Result }
      | undefined;
    expect(data?.data.recommendation).toBeUndefined();
    expect(data?.data.reuse).toBeUndefined();
    expect(
      (data?.data.candidates[0] as Record<string, unknown> | undefined)?.metadata
    ).toEqual({
      origin: "CF",
      rounds: 3,
      pinned: true,
      archived: null
    });
  });

  it("显式旧版决策字段仍参与本地 blockWhenRecommended 拦截", async () => {
    const legacy = v2Result({ blockSubmission: true });
    const check = createAnklangCheck({
      settings: anklangSettingsSchema.parse({
        baseUrl: "https://anklang.example.test",
        blockWhenRecommended: true
      }),
      fetch: async () => jsonResponse(legacy)
    });
    const output = await check.run(input, { signal: new AbortController().signal });
    expect(output).toMatchObject({
      decision: "block",
      code: "anklang_similar_problem",
      message: "请继续人工核对。"
    });

    // blockWhenRecommended=false 时显式推荐不会拦截。
    const permissive = createAnklangCheck({
      settings: anklangSettingsSchema.parse({
        baseUrl: "https://anklang.example.test",
        blockWhenRecommended: false
      }),
      fetch: async () => jsonResponse(legacy)
    });
    await expect(
      permissive.run(input, { signal: new AbortController().signal })
    ).resolves.toMatchObject({ decision: "continue" });
  });

  it("缺失决策字段时非法 metadata 仍 fail closed 且不生成合成字段", async () => {
    const check = createAnklangCheck({
      settings: anklangSettingsSchema.parse({
        baseUrl: "https://anklang.example.test",
        failureBehavior: "continue"
      }),
      fetch: async () =>
        jsonResponse({
          apiVersion: "2",
          contentHash,
          checkedAt,
          completion: { status: "complete", reasonCode: "complete", retryable: false },
          candidates: [{ ...candidate, metadata: { float: 1.5 } }]
        })
    });
    const output = await check.run(input, { signal: new AbortController().signal });
    expect(output).toMatchObject({
      decision: "continue",
      reviewItems: [{ summary: expect.stringContaining("暂不可用") }]
    });
    const dataJson = JSON.stringify(output);
    expect(dataJson).not.toContain("float");
    expect(dataJson).not.toContain("1.5");
    expect(dataJson).not.toContain('"recommendation"');
    expect(dataJson).not.toContain('"reuse"');
  });

  it("缺失决策字段时不拦截、不写缓存、不产生 expiresAt，候选仍可见且不泄露内部默认值", async () => {
    const set = vi.fn(async () => undefined);
    const cache: AnklangCache = { get: vi.fn(async () => undefined), set };
    const check = createAnklangCheck({
      settings: anklangSettingsSchema.parse({
        baseUrl: "https://anklang.example.test",
        failureBehavior: "continue",
        cacheMinutes: 60
      }),
      cache,
      fetch: async () => jsonResponse(bareV2Result()),
      now: () => new Date(checkedAt)
    });
    const output = await check.run(input, { signal: new AbortController().signal });
    expect(output.decision).toBe("continue");
    expect(cache.set).not.toHaveBeenCalled();

    const item = (output as { decision: "continue"; reviewItems?: unknown[] }).reviewItems?.[0] as
      | { summary?: string; data?: AnklangV2Result; expiresAt?: string }
      | undefined;
    expect(item?.expiresAt).toBeUndefined();
    expect(item?.data?.candidates.length).toBe(1);
    expect(item?.data?.recommendation).toBeUndefined();
    expect(item?.data?.reuse).toBeUndefined();
    const serialized = JSON.stringify(output);
    const leakedDefaults = ['"blockSubmission"', '"policy"', '"no-store"', '"allowed"', '"expiresAt"'];
    for (const token of leakedDefaults) {
      expect(serialized).not.toContain(token);
    }
  });

  it("partial/unavailable 失败语义不变：block 模式仍抛错，continue 模式明确降级", async () => {
    const partial = v2Result({ status: "partial", candidates: [] });
    const blocking = createAnklangCheck({
      settings: anklangSettingsSchema.parse({
        baseUrl: "https://anklang.example.test",
        failureBehavior: "block"
      }),
      fetch: async () => jsonResponse(partial)
    });
    await expect(
      blocking.run(input, { signal: new AbortController().signal })
    ).rejects.toThrow("没有完整完成");

    const continuing = createAnklangCheck({
      settings: anklangSettingsSchema.parse({
        baseUrl: "https://anklang.example.test",
        failureBehavior: "continue"
      }),
      fetch: async () => jsonResponse(partial)
    });
    const output = await continuing.run(input, { signal: new AbortController().signal });
    expect(output).toMatchObject({
      decision: "continue",
      reviewItems: [{ summary: expect.stringContaining("只完成了一部分") }]
    });
  });
});
