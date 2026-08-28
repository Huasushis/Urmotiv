import { randomUUID } from "node:crypto";
import { isIP } from "node:net";
import {
  type BeforeSubmitCheck,
  type BeforeSubmitInput,
  type BeforeSubmitResult,
  type PluginRegistry,
  type ReviewItemInput,
  type ReviewItemType
} from "@urmotiv/plugin-sdk";
import { z } from "zod";

export const anklangPluginId = "org.ustc.urmotiv.anklang";
export const anklangCheckId = `${anklangPluginId}.before-submit`;
export const anklangReviewItemType = `${anklangPluginId}.similarity`;
const responseByteLimit = 2_000_000;
const maximumReuseMs = 7 * 24 * 60 * 60_000;
const defaultRetryAttempts = 2;
const defaultIndexTimeoutMs = 10_000;
function isRetryableAnklangStatus(statusCode: number | undefined): boolean {
  return (
    statusCode === undefined ||
    statusCode === 408 ||
    statusCode === 429 ||
    statusCode === 502 ||
    statusCode === 503 ||
    statusCode === 504
  );
}

const serviceUrlSchema = z
  .string()
  .url()
  .refine((value) => {
    if (
      value !== value.trim() ||
      /[\u0000-\u001f\u007f]/u.test(value) ||
      /[?#]/u.test(value)
    ) {
      return false;
    }
    const url = new URL(value);
    const host = url.hostname.replace(/^\[|\]$/gu, "").toLowerCase();
    return (
      (url.protocol === "http:" || url.protocol === "https:") &&
      url.username.length === 0 &&
      url.password.length === 0 &&
      (url.pathname === "/" || url.pathname === "") &&
      url.search.length === 0 &&
      url.hash.length === 0 &&
      isPrivateServiceHost(host)
    );
  }, "Anklang 服务地址必须是没有账号密码、路径、查询参数或片段的本地/私有 HTTP 或 HTTPS 地址。");

function isPrivateServiceHost(host: string): boolean {
  if (host === "localhost" || host === "host.docker.internal") {
    return true;
  }
  const ipVersion = isIP(host);
  if (ipVersion === 4) {
    const octets = host.split(".").map((value) => Number.parseInt(value, 10));
    const [first, second] = octets;
    return (
      octets.length === 4 &&
      octets.every((octet) => Number.isInteger(octet) && octet >= 0 && octet <= 255) &&
      (first === 10 ||
        (first === 172 && second !== undefined && second >= 16 && second <= 31) ||
        (first === 192 && second === 168) ||
        (first === 127 && second !== undefined) ||
        (first === 169 && second === 254))
    );
  }
  if (ipVersion === 6) {
    const firstHextet = Number.parseInt(host.split(":", 1)[0] ?? "", 16);
    return (
      host === "::1" ||
      (Number.isInteger(firstHextet) &&
        ((firstHextet >= 0xfc00 && firstHextet <= 0xfdff) ||
          (firstHextet >= 0xfe80 && firstHextet <= 0xfebf)))
    );
  }
  return /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/u.test(host);
}

export function isPrivateAnklangBaseUrl(value: string): boolean {
  return serviceUrlSchema.safeParse(value).success;
}

const apiVersionSchema = z.enum(["2", "1"]);

export const anklangSettingsSchema = z
  .object({
    baseUrl: serviceUrlSchema,
    apiVersion: apiVersionSchema.default("2"),
    timeoutMs: z.number().int().min(1_000).max(120_000).default(120_000),
    indexTimeoutMs: z.number().int().min(1_000).max(30_000).default(defaultIndexTimeoutMs),
    retryAttempts: z.number().int().min(1).max(3).default(defaultRetryAttempts),
    privateContentAuthorized: z.boolean().default(false),
    failureBehavior: z.enum(["block", "continue"]).default("block"),
    minimumSimilarityToShow: z.number().min(0).max(1).default(0.3),
    cacheMinutes: z.number().int().min(1).max(10_080).default(1_440)
  })
  .strict();

export type AnklangSettings = z.infer<typeof anklangSettingsSchema>;
export type AnklangApiVersion = z.infer<typeof apiVersionSchema>;

const boundedCanonicalText = (maximum: number): z.ZodType<string> =>
  z
    .string()
    .min(1)
    .max(maximum)
    .refine((value) => value === value.trim(), "文本两端不能有空白字符。");

const safeCandidateUrlSchema = z
  .string()
  .url()
  .max(2_000)
  .refine((value) => {
    if (value !== value.trim() || /[\\\s\u0000-\u001f]/u.test(value)) {
      return false;
    }
    const url = new URL(value);
    return (
      (url.protocol === "http:" || url.protocol === "https:") &&
      url.username.length === 0 &&
      url.password.length === 0
    );
  }, "候选题地址必须是不含账号密码的 HTTP 或 HTTPS 地址。");

const utcDateTimeSchema = z
  .string()
  .datetime({ offset: false })
  .refine((value) => value.endsWith("Z"), "时间必须是以 Z 结尾的 UTC 时间。");

export const anklangCandidateSchema = z
  .object({
    source: boundedCanonicalText(80),
    externalId: boundedCanonicalText(200),
    title: boundedCanonicalText(200),
    url: safeCandidateUrlSchema.optional(),
    similarity: z.number().finite().min(0).max(1),
    sameProblemSuggestion: z.boolean().optional(),
    explanation: boundedCanonicalText(2_000).optional()
  })
  .strict();

/**
 * candidate.metadata 的可选镜像契约，与 Anklang anklang/metadata.py 的
 * canonicalize_metadata 按同一套边界独立实现：键必须是 ASCII 小写字母/
 * 数字/下划线且以字母开头（^[a-z][a-z0-9_]{0,63}$），最多 16 个键；值
 * 只允许字符串、安全整数、布尔或 null（不允许嵌套对象/数组）；字符串值
 * 必须非空、已经是去掉两端空白的形式并按 UTF-8 字节数不超过 512；数字值
 * 只接受 [MIN_SAFE_INTEGER, MAX_SAFE_INTEGER] 内的安全整数（小数、越界、
 * 非有限值、-0 一律拒绝，0 是唯一规范形式），保证与 Python json.dumps 的
 * 字节一致；整包按规范 JSON（ASCII 升序键、紧凑分隔符、不转义非 ASCII）
 * 编码后不超过 2048 个 UTF-8 字节。元数据是展示性、非检索性的题面外信息，
 * 不参与 problem contentHash/相似度/推荐/拦截或任何裁决输入。
 */
const metadataKeySchema = z.string().regex(
  /^[a-z][a-z0-9_]{0,63}$/u,
  "元数据键必须是小写字母开头的字母/数字/下划线。"
);
const metadataStringValueSchema = z
  .string()
  .min(1)
  .refine((value) => value === value.trim(), "元数据字符串值必须已是去空白形式。")
  .refine(
    (value) => new TextEncoder().encode(value).byteLength <= 512,
    "元数据字符串值不能超过 512 字节。"
  );
const metadataIntegerValueSchema = z
  .number()
  .refine(Number.isSafeInteger, "元数据数字值必须是安全整数。")
  .refine((value) => !Object.is(value, -0), "元数据数字值不能是负零；0 是唯一规范形式。");
const metadataValueSchema = z.union([
  metadataStringValueSchema,
  metadataIntegerValueSchema,
  z.boolean(),
  z.null()
]);
const MAX_CANDIDATE_METADATA_KEYS = 16;
const MAX_CANDIDATE_METADATA_BYTES = 2_048;
const anklangCandidateMetadataSchema = z
  .record(metadataKeySchema, metadataValueSchema)
  .superRefine((metadata, context) => {
    const keys = Object.keys(metadata);
    if (keys.length > MAX_CANDIDATE_METADATA_KEYS) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: [],
        message: `candidate.metadata 最多允许 ${MAX_CANDIDATE_METADATA_KEYS} 个键。`
      });
      return;
    }
    const byteLength = new TextEncoder().encode(canonicalMetadataJson(metadata)).byteLength;
    if (byteLength > MAX_CANDIDATE_METADATA_BYTES) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: [],
        message: `candidate.metadata 整包不能超过 ${MAX_CANDIDATE_METADATA_BYTES} 字节。`
      });
    }
  });
export type AnklangCandidateMetadata = z.infer<typeof anklangCandidateMetadataSchema>;

/** ASCII 升序键、紧凑分隔符、不转义非 ASCII 的规范 JSON 序列化。 */
function canonicalMetadataJson(metadata: Record<string, unknown>): string {
  const keys = Object.keys(metadata).sort();
  const parts = keys.map((key) => {
    const serializedKey = JSON.stringify(key);
    const serializedValue = JSON.stringify(metadata[key]);
    return `${serializedKey}:${serializedValue}`;
  });
  return `{${parts.join(",")}}`;
}

/** v2 专用候选题：v1 候选保持原有字节形状，携带 metadata 的 v1 候选被拒绝。 */
export const anklangV2CandidateSchema = anklangCandidateSchema
  .extend({ metadata: anklangCandidateMetadataSchema.optional() })
  .strict()
  .transform((candidate) => {
    if (candidate.metadata !== undefined && Object.keys(candidate.metadata).length !== 0) {
      return candidate;
    }
    const { metadata: _omitted, ...rest } = candidate;
    return rest;
  });

const contentHashSchema = z.string().regex(/^[a-f0-9]{64}$/);
const recommendationSchema = z
  .object({
    blockSubmission: z.boolean(),
    message: boundedCanonicalText(2_000)
  })
  .strict();

export const anklangV1ResultSchema = z
  .object({
    apiVersion: z.literal("1"),
    contentHash: contentHashSchema,
    checkedAt: utcDateTimeSchema,
    candidates: z.array(anklangCandidateSchema).max(50),
    recommendation: recommendationSchema.optional()
  })
  .strict();

const noncompleteReasonCodeSchema = z.enum([
  "search_timeout",
  "search_rate_limited",
  "search_backend_unavailable",
  "search_backend_invalid",
  "search_partial",
  "review_unavailable",
  "service_unavailable",
  "service_invalid_response",
  "internal_error"
]);

const completeCompletionSchema = z
  .object({
    status: z.literal("complete"),
    reasonCode: z.literal("complete"),
    retryable: z.literal(false)
  })
  .strict();

function noncompleteCompletionSchema<TStatus extends "partial" | "unavailable">(
  status: TStatus
) {
  return z
    .object({
      status: z.literal(status),
      reasonCode: noncompleteReasonCodeSchema,
      retryable: z.boolean(),
      retryAfterSeconds: z.number().int().min(1).max(86_400).optional()
    })
    .strict()
    .superRefine((completion, context) => {
      if (completion.retryAfterSeconds !== undefined && !completion.retryable) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["retryAfterSeconds"],
          message: "只有可重试结果才能提供 retryAfterSeconds。"
        });
      }
    });
}

const noStoreReuseSchema = z.object({ policy: z.literal("no-store") }).strict();
const allowedReuseSchema = z
  .object({
    policy: z.literal("allowed"),
    expiresAt: utcDateTimeSchema
  })
  .strict();

const v2ResultCommon = {
  apiVersion: z.literal("2"),
  contentHash: contentHashSchema,
  checkedAt: utcDateTimeSchema,
  candidates: z.array(anklangV2CandidateSchema).max(50),
  recommendation: recommendationSchema.optional()
} as const;

const completeV2ResultSchema = z
  .object({
    ...v2ResultCommon,
    completion: completeCompletionSchema,
    reuse: z.union([allowedReuseSchema, noStoreReuseSchema]).optional()
  })
  .strict()
  .superRefine((result, context) => {
    if (result.reuse?.policy !== "allowed") {
      return;
    }
    const checkedAtMs = Date.parse(result.checkedAt);
    const expiresAtMs = Date.parse(result.reuse.expiresAt);
    if (expiresAtMs <= checkedAtMs || expiresAtMs - checkedAtMs > maximumReuseMs) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["reuse", "expiresAt"],
        message: "复用到期时间必须晚于检查时间且相差不超过七天。"
      });
    }
  });

const partialV2ResultSchema = z
  .object({
    ...v2ResultCommon,
    completion: noncompleteCompletionSchema("partial"),
    reuse: noStoreReuseSchema.optional()
  })
  .strict()
  .superRefine((result, context) => {
    if (
      result.recommendation?.blockSubmission === true &&
      !result.candidates.some((candidate) => candidate.sameProblemSuggestion === true)
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["recommendation", "blockSubmission"],
        message: "部分结果只能由本次可信的同题复核结论建议拦截。"
      });
    }
  });

const unavailableV2ResultSchema = z
  .object({
    ...v2ResultCommon,
    completion: noncompleteCompletionSchema("unavailable"),
    candidates: z.array(anklangV2CandidateSchema).length(0),
    recommendation: z
      .object({
        blockSubmission: z.literal(false),
        message: boundedCanonicalText(2_000)
      })
      .strict()
      .optional(),
    reuse: noStoreReuseSchema.optional()
  })
  .strict();

export const anklangV2ResultSchema = z.union([
  completeV2ResultSchema,
  partialV2ResultSchema,
  unavailableV2ResultSchema
]);

export const anklangResultSchema = z.union([anklangV2ResultSchema, anklangV1ResultSchema]);

export type AnklangV1Result = z.infer<typeof anklangV1ResultSchema>;
export type AnklangV2Result = z.infer<typeof anklangV2ResultSchema>;
export type AnklangResult = z.infer<typeof anklangResultSchema>;
export const anklangSearchCandidateSchema = anklangCandidateSchema
  .omit({ sameProblemSuggestion: true, explanation: true })
  .strict();

export const anklangV2SearchCandidateSchema = anklangSearchCandidateSchema
  .extend({ metadata: anklangCandidateMetadataSchema.optional() })
  .strict()
  .transform((candidate) => {
    if (candidate.metadata !== undefined && Object.keys(candidate.metadata).length !== 0) {
      return candidate;
    }
    const { metadata: _omitted, ...rest } = candidate;
    return rest;
  });

const searchV2ResultCommon = {
  apiVersion: z.literal("2"),
  contentHash: contentHashSchema,
  checkedAt: utcDateTimeSchema,
  candidates: z.array(anklangV2SearchCandidateSchema).max(50)
} as const;

const completeSearchV2ResultSchema = z
  .object({
    ...searchV2ResultCommon,
    completion: completeCompletionSchema,
    reuse: z.union([allowedReuseSchema, noStoreReuseSchema]).optional()
  })
  .strict()
  .superRefine((result, context) => {
    if (result.reuse?.policy !== "allowed") {
      return;
    }
    const checkedAtMs = Date.parse(result.checkedAt);
    const expiresAtMs = Date.parse(result.reuse.expiresAt);
    if (expiresAtMs <= checkedAtMs || expiresAtMs - checkedAtMs > maximumReuseMs) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["reuse", "expiresAt"],
        message: "复用到期时间必须晚于检查时间且相差不超过七天。"
      });
    }
  });

const partialSearchV2ResultSchema = z
  .object({
    ...searchV2ResultCommon,
    completion: noncompleteCompletionSchema("partial"),
    reuse: noStoreReuseSchema.optional()
  })
  .strict();

const unavailableSearchV2ResultSchema = z
  .object({
    ...searchV2ResultCommon,
    completion: noncompleteCompletionSchema("unavailable"),
    candidates: z.array(anklangV2SearchCandidateSchema).length(0),
    reuse: noStoreReuseSchema.optional()
  })
  .strict();

export const anklangSearchResultSchema = z.union([
  completeSearchV2ResultSchema,
  partialSearchV2ResultSchema,
  unavailableSearchV2ResultSchema,
  z
    .object({
      apiVersion: z.literal("1"),
      contentHash: contentHashSchema,
      checkedAt: utcDateTimeSchema,
      candidates: z.array(anklangSearchCandidateSchema).max(50)
    })
    .strict()
]);

export type AnklangSearchResult = z.infer<typeof anklangSearchResultSchema>;

export function projectAnklangSearchResult(result: AnklangResult): AnklangSearchResult {
  const candidates = result.candidates.map((candidate) => {
    const { sameProblemSuggestion: _suggestion, explanation: _explanation, ...searchCandidate } =
      candidate;
    return searchCandidate;
  });
  if (result.apiVersion === "1") {
    return anklangSearchResultSchema.parse({
      apiVersion: result.apiVersion,
      contentHash: result.contentHash,
      checkedAt: result.checkedAt,
      candidates
    });
  }
  const { recommendation: _recommendation, candidates: _candidates, ...searchResult } = result;
  return anklangSearchResultSchema.parse({ ...searchResult, candidates });
}

export type AnklangCompletionStatus = "complete" | "partial" | "unavailable";
export type AnklangNoncompleteReasonCode = z.infer<typeof noncompleteReasonCodeSchema>;


const anklangProblemRequestSchema = z
  .object({
    title: z.string().trim().min(1).max(200),
    type: z.enum(["traditional", "interactive", "submit_answer"]),
    tagIds: z.array(z.string().min(1).max(120)).min(1).max(30),
    basicStatement: z.string().min(1).max(500_000)
  })
  .strict();

export const anklangV1RequestSchema = z
  .object({
    apiVersion: z.literal("1"),
    requestId: z.string().uuid(),
    contentHash: contentHashSchema,
    problem: anklangProblemRequestSchema
  })
  .strict();

export const anklangV2RequestSchema = z
  .object({
    apiVersion: z.literal("2"),
    requestId: z.string().uuid(),
    contentHash: contentHashSchema,
    problem: anklangProblemRequestSchema
  })
  .strict();

export const anklangRequestSchema = z.union([anklangV2RequestSchema, anklangV1RequestSchema]);

export type AnklangRequest = z.infer<typeof anklangRequestSchema>;

const anklangIndexProblemSchema = z
  .object({
    title: boundedCanonicalText(200),
    basicStatement: z.string().min(1).max(500_000)
  })
  .strict();

export const anklangIndexUpsertRequestSchema = z
  .object({
    apiVersion: z.literal("1"),
    requestId: z.string().uuid(),
    externalId: boundedCanonicalText(200),
    updatedAt: utcDateTimeSchema,
    problem: anklangIndexProblemSchema
  })
  .strict();

export const anklangIndexUpsertResponseSchema = z
  .object({
    apiVersion: z.literal("1"),
    requestId: z.string().uuid(),
    source: z.literal("urmotiv"),
    externalId: boundedCanonicalText(200),
    contentHash: contentHashSchema,
    outcome: z.enum(["inserted", "updated", "unchanged"])
  })
  .strict();

export type AnklangIndexUpsertRequest = z.infer<typeof anklangIndexUpsertRequestSchema>;
export type AnklangIndexUpsertResponse = z.infer<typeof anklangIndexUpsertResponseSchema>;

export class AnklangUnavailableError extends Error {
  public readonly statusCode: number | undefined;

  public constructor(message = "Anklang 服务暂时不可用。", statusCode?: number) {
    super(message);
    this.name = "AnklangUnavailableError";
    this.statusCode = statusCode;
  }
}

export class AnklangInvalidResponseError extends Error {
  public constructor(message = "Anklang 返回的内容格式不正确。") {
    super(message);
    this.name = "AnklangInvalidResponseError";
  }
}

export class AnklangConfigurationError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "AnklangConfigurationError";
  }
}

export class AnklangStaleUpdateError extends Error {
  public constructor() {
    super("Anklang 索引中的题目更新时间较新。");
    this.name = "AnklangStaleUpdateError";
  }
}

export interface AnklangCache {
  get(cacheKey: string): Promise<unknown | undefined>;
  set(cacheKey: string, result: AnklangSearchResult, expiresAt: string): Promise<void>;
}

export type AnklangFetch = (
  input: string | URL | Request,
  init?: RequestInit
) => Promise<Response>;

export interface AnklangClientOptions {
  readonly baseUrl: string;
  readonly apiVersion?: AnklangApiVersion;
  readonly token?: string;
  readonly privateContentAuthorized?: boolean;
  readonly retryAttempts?: number;
  readonly timeoutMs?: number;
  readonly indexTimeoutMs?: number;
  readonly fetch?: AnklangFetch;
}

type JsonResponseKind = "check" | "index";

export class AnklangClient {
  readonly #apiVersion: AnklangApiVersion;
  readonly #endpoint: URL;
  readonly #indexEndpoint: URL;
  readonly #token: string;
  readonly #retryAttempts: number;
  readonly #timeoutMs: number;
  readonly #indexTimeoutMs: number;
  readonly #fetch: AnklangFetch;

  public constructor(options: AnklangClientOptions) {
    const parsedBaseUrl = serviceUrlSchema.safeParse(options.baseUrl);
    if (!parsedBaseUrl.success) {
      throw new AnklangConfigurationError("Anklang 服务地址不在批准的私有边界内。");
    }
    const baseUrl = parsedBaseUrl.data;
    if (options.privateContentAuthorized !== true) {
      throw new AnklangConfigurationError(
        "管理员必须先确认 Anklang 存储与嵌入链路处于批准的私有边界内。"
      );
    }
    const token = options.token?.trim();
    if (token === undefined || token.length === 0) {
      throw new AnklangConfigurationError("Anklang 服务认证令牌未配置。");
    }
    this.#apiVersion = apiVersionSchema.parse(options.apiVersion ?? "2");
    this.#endpoint = new URL(
      `/api/v${this.#apiVersion}/checks/similarity`,
      ensureTrailingSlash(baseUrl)
    );
    this.#indexEndpoint = new URL("/api/v1/index/problems", ensureTrailingSlash(baseUrl));
    this.#token = token;
    this.#retryAttempts = z.number().int().min(1).max(3).parse(
      options.retryAttempts ?? defaultRetryAttempts
    );
    this.#timeoutMs = z.number().int().min(1_000).max(120_000).parse(
      options.timeoutMs ?? 120_000
    );
    this.#indexTimeoutMs = z.number().int().min(1_000).max(30_000).parse(
      options.indexTimeoutMs ?? defaultIndexTimeoutMs
    );
    this.#fetch = options.fetch ?? globalThis.fetch;
  }

  public async check(request: AnklangRequest, signal: AbortSignal): Promise<AnklangResult> {
    const requestSchema = this.#apiVersion === "2" ? anklangV2RequestSchema : anklangV1RequestSchema;
    const parsedRequest = requestSchema.safeParse(request);
    if (!parsedRequest.success) {
      throw new AnklangInvalidResponseError("Anklang 请求不符合已配置的接口版本。");
    }
    const body = parsedRequest.data;
    const result = await this.#requestJson(
      this.#endpoint,
      body,
      signal,
      this.#timeoutMs,
      "check",
      (raw) => {
        const resultSchema = this.#apiVersion === "2" ? anklangV2ResultSchema : anklangV1ResultSchema;
        const parsedResult = resultSchema.safeParse(raw);
        if (!parsedResult.success) {
          throw new AnklangInvalidResponseError();
        }
        if (parsedResult.data.contentHash !== body.contentHash) {
          throw new AnklangInvalidResponseError("Anklang 返回结果对应的题目内容已经变化。");
        }
        return parsedResult.data;
      }
    );
    return result;
  }

  public async upsert(
    request: AnklangIndexUpsertRequest,
    signal: AbortSignal = new AbortController().signal
  ): Promise<AnklangIndexUpsertResponse> {
    const parsedRequest = anklangIndexUpsertRequestSchema.safeParse(request);
    if (!parsedRequest.success) {
      throw new AnklangInvalidResponseError("Anklang 索引请求不符合已配置的接口版本。");
    }
    const body = parsedRequest.data;
    return this.#requestJson(
      this.#indexEndpoint,
      body,
      signal,
      this.#indexTimeoutMs,
      "index",
      (raw) => {
        const parsed = anklangIndexUpsertResponseSchema.safeParse(raw);
        if (!parsed.success) {
          throw new AnklangInvalidResponseError();
        }
        if (
          parsed.data.requestId !== body.requestId ||
          parsed.data.externalId !== body.externalId
        ) {
          throw new AnklangInvalidResponseError("Anklang 索引返回结果与请求不一致。");
        }
        return parsed.data;
      }
    );
  }

  async #requestJson<T>(
    endpoint: URL,
    body: object,
    parentSignal: AbortSignal,
    timeoutMs: number,
    kind: JsonResponseKind,
    parse: (raw: unknown) => T
  ): Promise<T> {
    const deadline = Date.now() + timeoutMs;
    let rejectParentAbort = (_reason?: unknown): void => {};
    const parentAbort = new Promise<never>((_resolve, reject) => {
      rejectParentAbort = reject;
    });
    const abortParent = (): void => {
      rejectParentAbort(new DOMException("The operation was aborted", "AbortError"));
    };
    if (parentSignal.aborted) {
      abortParent();
    } else {
      parentSignal.addEventListener("abort", abortParent, { once: true });
    }
    const request = async (): Promise<T> => {
      for (let attempt = 0; attempt < this.#retryAttempts; attempt += 1) {
        const remainingMs = deadline - Date.now();
        if (remainingMs <= 0) {
          throw new AnklangUnavailableError("Anklang 请求超时。");
        }
        const attemptsLeft = this.#retryAttempts - attempt;
        const attemptTimeoutMs = Math.max(1, Math.min(remainingMs, Math.ceil(remainingMs / attemptsLeft)));
        const attemptController = new AbortController();
        const abortAttempt = (): void => attemptController.abort();
        if (parentSignal.aborted) {
          abortAttempt();
        } else {
          parentSignal.addEventListener("abort", abortAttempt, { once: true });
        }
        let attemptTimedOut = false;
        let rejectAttemptTimeout = (_reason?: unknown): void => {};
        const attemptTimeout = new Promise<never>((_resolve, reject) => {
          rejectAttemptTimeout = reject;
        });
        const timer = setTimeout(() => {
          attemptTimedOut = true;
          attemptController.abort();
          rejectAttemptTimeout(new AnklangUnavailableError("Anklang 请求超时。"));
        }, attemptTimeoutMs);
        try {
          let response: Response;
          try {
            response = await Promise.race([
              this.#fetch(endpoint, {
                method: kind === "index" ? "PUT" : "POST",
                redirect: "error",
                signal: attemptController.signal,
                headers: {
                  Accept: "application/json",
                  "Cache-Control": "no-store",
                  "Content-Type": "application/json",
                  "X-Urmotiv-API-Version": kind === "index" ? "1" : this.#apiVersion,
                  Authorization: `Bearer ${this.#token}`
                },
                body: JSON.stringify(body)
              }),
              attemptTimeout
            ]);
          } catch (error) {
            if (parentSignal.aborted) {
              throw error;
            }
            if (error instanceof AnklangUnavailableError) {
              throw error;
            }
            throw new AnklangUnavailableError();
          }

          if (response.status === 401) {
            throw new AnklangUnavailableError("Anklang 认证失败。", response.status);
          }
          if (kind === "index" && response.status === 409) {
            throw new AnklangStaleUpdateError();
          }
          if (isRetryableAnklangStatus(response.status)) {
            throw new AnklangUnavailableError("Anklang 服务未能完成请求。", response.status);
          }
          if (!response.ok) {
            throw new AnklangUnavailableError("Anklang 服务未能完成请求。", response.status);
          }
          const contentType = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
          if (contentType !== "application/json") {
            throw new AnklangInvalidResponseError();
          }
          let text: string;
          try {
            text = await Promise.race([
              readLimitedText(response, responseByteLimit),
              attemptTimeout
            ]);
          } catch (error) {
            if (attemptTimedOut || error instanceof AnklangUnavailableError || parentSignal.aborted) {
              throw error;
            }
            throw new AnklangInvalidResponseError();
          }
          let raw: unknown;
          try {
            raw = JSON.parse(text) as unknown;
          } catch {
            throw new AnklangInvalidResponseError();
          }
          return parse(raw);
        } catch (error) {
          if (parentSignal.aborted) {
            throw error;
          }
          if (error instanceof AnklangInvalidResponseError ||
            error instanceof AnklangStaleUpdateError ||
            error instanceof AnklangConfigurationError) {
            throw error;
          }
          if (error instanceof AnklangUnavailableError) {
            if (
              isRetryableAnklangStatus(error.statusCode) &&
              attempt + 1 < this.#retryAttempts &&
              Date.now() < deadline
            ) {
              continue;
            }
            throw error;
          }
          if (attempt + 1 < this.#retryAttempts && Date.now() < deadline) {
            continue;
          }
          throw new AnklangUnavailableError();
        } finally {
          clearTimeout(timer);
          parentSignal.removeEventListener("abort", abortAttempt);
          attemptController.abort();
        }
      }
      throw new AnklangUnavailableError();
    };
    try {
      return await Promise.race([request(), parentAbort]);
    } finally {
      parentSignal.removeEventListener("abort", abortParent);
      rejectParentAbort(new AnklangUnavailableError());
    }
  }
}

export interface CreateAnklangCheckOptions {
  readonly settings: AnklangSettings;
  readonly token?: string;
  readonly cache?: AnklangCache;
  readonly fetch?: AnklangFetch;
  readonly now?: () => Date;
}

export function createAnklangCheck(options: CreateAnklangCheckOptions): BeforeSubmitCheck {
  const settings = anklangSettingsSchema.parse(options.settings);
  const now = options.now ?? (() => new Date());
  const client = new AnklangClient({
    baseUrl: settings.baseUrl,
    apiVersion: settings.apiVersion,
    ...(options.token === undefined ? {} : { token: options.token }),
    privateContentAuthorized: settings.privateContentAuthorized,
    retryAttempts: settings.retryAttempts,
    timeoutMs: settings.timeoutMs,
    indexTimeoutMs: settings.indexTimeoutMs,
    ...(options.fetch === undefined ? {} : { fetch: options.fetch })
  });
  return {
    id: anklangCheckId,
    displayName: "原题相似度检查",
    timeoutMs: settings.timeoutMs,
    failureBehavior: settings.failureBehavior,
    async run(input, context): Promise<BeforeSubmitResult> {
      let result: AnklangSearchResult;
      try {
        result = await readOrCheck(input, context.signal, client, settings, options.cache, now);
      } catch (error) {
        if (context.signal.aborted || settings.failureBehavior === "block") {
          throw error;
        }
        return {
          decision: "continue",
          reviewItems: [
            createAnklangUnavailableReviewItem(
              input,
              error instanceof AnklangInvalidResponseError
                ? "service_invalid_response"
                : "service_unavailable",
              now
            )
          ]
        };
      }

      if (
        result.apiVersion === "2" &&
        result.completion.status !== "complete" &&
        settings.failureBehavior === "block"
      ) {
        throw new AnklangUnavailableError("Anklang 检查没有完整完成。");
      }

      const visibleCandidates = result.candidates
        .filter((candidate) => candidate.similarity >= settings.minimumSimilarityToShow)
        .sort((left, right) => right.similarity - left.similarity);
      return {
        decision: "continue",
        reviewItems: [toReviewItem(result, visibleCandidates)]
      };
    }
  };
}

export function registerAnklangPlugin(
  registry: PluginRegistry,
  options: CreateAnklangCheckOptions
): void {
  const itemType: ReviewItemType<AnklangSearchResult> = {
    type: anklangReviewItemType,
    displayName: "原题相似度结果",
    dataSchema: anklangSearchResultSchema
  };
  registry.registerReviewItemType(itemType);
  registry.registerBeforeSubmitCheck(createAnklangCheck(options));
}

export function anklangCompletionStatus(value: unknown): AnklangCompletionStatus | undefined {
  const parsed = anklangSearchResultSchema.safeParse(value);
  if (!parsed.success) {
    return undefined;
  }
  return parsed.data.apiVersion === "1" ? "complete" : parsed.data.completion.status;
}



export interface AnklangIndexProblem {
  readonly externalId: string;
  readonly title: string;
  readonly basicStatement: string;
  readonly updatedAt: string;
}

export interface AnklangIndexAdapter {
  upsert(problem: AnklangIndexProblem): Promise<AnklangIndexUpsertResponse | void>;
}

export interface AnklangIndexRuntime {
  readSettings(): Promise<unknown | undefined>;
  readToken(): Promise<string | undefined>;
  readonly fetch?: AnklangFetch;
}

/**
 * Creates the narrow built-in index bridge. It deliberately performs no
 * network request when the plugin is disabled, malformed, unauthorized, or
 * missing its secret; sync errors are best effort and never escape here.
 */
export function createAnklangIndexAdapter(runtime: AnklangIndexRuntime): AnklangIndexAdapter {
  return {
    async upsert(problem) {
      try {
        const rawSettings = await runtime.readSettings();
        const parsedSettings = anklangSettingsSchema.safeParse(rawSettings);
        if (!parsedSettings.success || !parsedSettings.data.privateContentAuthorized) {
          return undefined;
        }
        const token = await runtime.readToken();
        const normalizedToken = token?.trim();
        if (normalizedToken === undefined || normalizedToken.length === 0) {
          return undefined;
        }
        const settings = parsedSettings.data;
        const client = new AnklangClient({
          baseUrl: settings.baseUrl,
          apiVersion: settings.apiVersion,
          token: normalizedToken,
          privateContentAuthorized: settings.privateContentAuthorized,
          retryAttempts: settings.retryAttempts,
          timeoutMs: settings.timeoutMs,
          indexTimeoutMs: settings.indexTimeoutMs,
          ...(runtime.fetch === undefined ? {} : { fetch: runtime.fetch })
        });
        return await client.upsert({
          apiVersion: "1",
          requestId: randomUUID(),
          externalId: problem.externalId,
          updatedAt: problem.updatedAt,
          problem: {
            title: problem.title,
            basicStatement: problem.basicStatement
          }
        });
      } catch {
        return undefined;
      }
    }
  };
}

/** 把本地可安全公开的失败状态写成审核条目，不复制异常或上游响应正文。 */
export function createAnklangUnavailableReviewItem(
  input: BeforeSubmitInput,
  reasonCode: AnklangNoncompleteReasonCode,
  now: () => Date = () => new Date()
): ReviewItemInput {
  const result = projectAnklangSearchResult(
    anklangV2ResultSchema.parse({
      apiVersion: "2",
      contentHash: input.contentHash,
      checkedAt: now().toISOString(),
      completion: {
        status: "unavailable",
        reasonCode,
        retryable: reasonCode !== "service_invalid_response"
      },
      candidates: []
    })
  );
  return toReviewItem(result, []);
}

async function readOrCheck(
  input: BeforeSubmitInput,
  signal: AbortSignal,
  client: AnklangClient,
  settings: AnklangSettings,
  cache: AnklangCache | undefined,
  now: () => Date
): Promise<AnklangSearchResult> {
  const cacheKey = `${settings.apiVersion}:${new URL(settings.baseUrl).href}:${settings.cacheMinutes}:${input.contentHash}`;
  let cached: unknown | undefined;
  try {
    cached = await cache?.get(cacheKey);
  } catch {
    cached = undefined;
  }
  const reusable = reusableCachedResult(cached, settings.apiVersion, input.contentHash, now());
  if (reusable !== undefined) {
    return projectAnklangSearchResult(reusable);
  }

  const request = {
    apiVersion: settings.apiVersion,
    requestId: randomUUID(),
    contentHash: input.contentHash,
    problem: {
      title: input.problem.title,
      type: input.problem.type,
      tagIds: input.problem.tagIds,
      basicStatement: input.problem.basicStatement
    }
  } as AnklangRequest;
  const result = projectAnklangSearchResult(await client.check(request, signal));

  if (result.apiVersion === "1") {
    const expiresAt = new Date(now().getTime() + settings.cacheMinutes * 60_000).toISOString();
    await safeCacheSet(cache, cacheKey, result, expiresAt);
  } else if (result.apiVersion === "2" && result.completion.status === "complete") {
    const reuse = result.reuse;
    if (reuse?.policy === "allowed") {
      const observedNowMs = now().getTime();
      const cacheExpiresAtMs = Math.min(
        Date.parse(reuse.expiresAt),
        observedNowMs + settings.cacheMinutes * 60_000
      );
      if (cacheExpiresAtMs > observedNowMs) {
        await safeCacheSet(cache, cacheKey, result, new Date(cacheExpiresAtMs).toISOString());
      }
    }
  }
  return result;
}

async function safeCacheSet(
  cache: AnklangCache | undefined,
  cacheKey: string,
  result: AnklangSearchResult,
  expiresAt: string
): Promise<void> {
  try {
    await cache?.set(cacheKey, result, expiresAt);
  } catch {
    // 缓存只是复用优化；当前已经严格校验通过的结果仍然有效。
  }
}

function reusableCachedResult(
  value: unknown,
  apiVersion: AnklangApiVersion,
  contentHash: string,
  now: Date
): AnklangResult | undefined {
  if (apiVersion === "1") {
    const parsed = anklangV1ResultSchema.safeParse(value);
    return parsed.success && parsed.data.contentHash === contentHash ? parsed.data : undefined;
  }

  const parsed = anklangV2ResultSchema.safeParse(value);
  const reuse = parsed.data?.reuse;
  if (
    !parsed.success ||
    parsed.data.contentHash !== contentHash ||
    parsed.data.completion.status !== "complete" ||
    reuse?.policy !== "allowed" ||
    Date.parse(reuse?.expiresAt ?? "") <= now.getTime()
  ) {
    return undefined;
  }
  return parsed.data;
}


function toReviewItem(
  result: AnklangSearchResult,
  candidates: AnklangSearchResult["candidates"]
): ReviewItemInput {
  const highest = candidates[0]?.similarity;
  const status = result.apiVersion === "1" ? "complete" : result.completion.status;
  let summary: string;
  if (status === "unavailable") {
    summary = "原题检索暂不可用，本次结果不能视为完整查重。";
  } else if (status === "partial") {
    summary =
      highest === undefined
        ? "原题检索只完成了一部分，暂时没有可供人工核对的候选。"
        : `原题检索只完成了一部分，保留 ${candidates.length} 道候选供人工核对。`;
  } else {
    summary =
      highest === undefined
        ? "完整检索没有发现达到显示下限的相似题目。"
        : `发现 ${candidates.length} 道候选题，最高相似度为 ${Math.round(highest * 100)}%。`;
  }

  const expiresAt =
    result.apiVersion === "2" &&
    result.completion.status === "complete" &&
    result.reuse?.policy === "allowed"
      ? result.reuse.expiresAt
      : undefined;
  return {
    type: anklangReviewItemType,
    visibility: "author",
    summary,
    data: { ...result, candidates },
    contentHash: result.contentHash,
    ...(expiresAt === undefined ? {} : { expiresAt })
  };
}

export function rebuildAnklangReviewItem(
  item: ReviewItemInput,
  candidates: AnklangSearchResult["candidates"]
): ReviewItemInput {
  const result = anklangSearchResultSchema.parse(item.data);
  const rebuilt = toReviewItem(result, candidates);
  const { expiresAt: _oldExpiresAt, ...withoutExpiresAt } = item;
  return {
    ...withoutExpiresAt,
    summary: rebuilt.summary,
    data: rebuilt.data,
    ...(rebuilt.expiresAt === undefined ? {} : { expiresAt: rebuilt.expiresAt })
  };
}

async function readLimitedText(response: Response, limit: number): Promise<string> {
  const lengthHeader = response.headers.get("content-length");
  if (lengthHeader !== null && Number(lengthHeader) > limit) {
    throw new Error("Anklang 返回内容超过大小限制。");
  }
  if (response.body === null) {
    return "";
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const next = await reader.read();
    if (next.done) {
      break;
    }
    size += next.value.byteLength;
    if (size > limit) {
      await reader.cancel();
      throw new Error("Anklang 返回内容超过大小限制。");
    }
    chunks.push(next.value);
  }

  const content = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    content.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(content);
  } catch {
    throw new Error("Anklang 返回的内容格式不正确。");
  }
}

function ensureTrailingSlash(value: string): string {
  return value.endsWith("/") ? value : `${value}/`;
}
