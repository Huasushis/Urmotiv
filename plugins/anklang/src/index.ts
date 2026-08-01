import { randomUUID } from "node:crypto";
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

const serviceUrlSchema = z
  .string()
  .url()
  .refine((value) => {
    const url = new URL(value);
    return (
      (url.protocol === "http:" || url.protocol === "https:") &&
      url.username.length === 0 &&
      url.password.length === 0
    );
  }, "Anklang 服务地址必须是不含账号密码的 HTTP 或 HTTPS 地址。");

const apiVersionSchema = z.enum(["2", "1"]);

export const anklangSettingsSchema = z
  .object({
    baseUrl: serviceUrlSchema,
    apiVersion: apiVersionSchema.default("2"),
    timeoutMs: z.number().int().min(1_000).max(120_000).default(120_000),
    failureBehavior: z.enum(["block", "continue"]).default("block"),
    blockWhenRecommended: z.boolean().default(true),
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
    recommendation: recommendationSchema
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
  candidates: z.array(anklangCandidateSchema).max(50),
  recommendation: recommendationSchema
} as const;

const completeV2ResultSchema = z
  .object({
    ...v2ResultCommon,
    completion: completeCompletionSchema,
    reuse: z.union([allowedReuseSchema, noStoreReuseSchema])
  })
  .strict()
  .superRefine((result, context) => {
    if (result.reuse.policy !== "allowed") {
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
    reuse: noStoreReuseSchema
  })
  .strict()
  .superRefine((result, context) => {
    if (
      result.recommendation.blockSubmission &&
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
    candidates: z.array(anklangCandidateSchema).length(0),
    recommendation: z
      .object({
        blockSubmission: z.literal(false),
        message: boundedCanonicalText(2_000)
      })
      .strict(),
    reuse: noStoreReuseSchema
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
export type AnklangCompletionStatus = "complete" | "partial" | "unavailable";
export type AnklangNoncompleteReasonCode = z.infer<typeof noncompleteReasonCodeSchema>;

class AnklangUnavailableError extends Error {}
class AnklangInvalidResponseError extends Error {}

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

export interface AnklangCache {
  get(cacheKey: string): Promise<unknown | undefined>;
  set(cacheKey: string, result: AnklangResult, expiresAt: string): Promise<void>;
}

export type AnklangFetch = (
  input: string | URL | Request,
  init?: RequestInit
) => Promise<Response>;

export interface AnklangClientOptions {
  readonly baseUrl: string;
  readonly apiVersion?: AnklangApiVersion;
  readonly token?: string;
  readonly fetch?: AnklangFetch;
}

export class AnklangClient {
  readonly #apiVersion: AnklangApiVersion;
  readonly #endpoint: URL;
  readonly #token: string | undefined;
  readonly #fetch: AnklangFetch;

  public constructor(options: AnklangClientOptions) {
    const baseUrl = serviceUrlSchema.parse(options.baseUrl);
    this.#apiVersion = apiVersionSchema.parse(options.apiVersion ?? "2");
    this.#endpoint = new URL(
      `/api/v${this.#apiVersion}/checks/similarity`,
      ensureTrailingSlash(baseUrl)
    );
    this.#token = options.token?.trim() || undefined;
    this.#fetch = options.fetch ?? globalThis.fetch;
  }

  public async check(request: AnklangRequest, signal: AbortSignal): Promise<AnklangResult> {
    const requestSchema = this.#apiVersion === "2" ? anklangV2RequestSchema : anklangV1RequestSchema;
    const parsedRequest = requestSchema.safeParse(request);
    if (!parsedRequest.success) {
      throw new AnklangInvalidResponseError("Anklang 请求不符合已配置的接口版本。");
    }
    const body = parsedRequest.data;
    let response: Response;
    try {
      response = await this.#fetch(this.#endpoint, {
        method: "POST",
        redirect: "error",
        signal,
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
          "X-Urmotiv-API-Version": this.#apiVersion,
          ...(this.#token === undefined ? {} : { Authorization: `Bearer ${this.#token}` })
        },
        body: JSON.stringify(body)
      });
    } catch (error) {
      if (signal.aborted) {
        throw error;
      }
      throw new AnklangUnavailableError("Anklang 服务暂时不可用。");
    }

    if (!response.ok) {
      throw new AnklangUnavailableError("Anklang 服务未能完成检查。");
    }
    const contentType = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
    if (contentType !== "application/json") {
      throw new AnklangInvalidResponseError("Anklang 返回的内容格式不正确。");
    }

    let text: string;
    try {
      text = await readLimitedText(response, responseByteLimit);
    } catch {
      throw new AnklangInvalidResponseError("Anklang 返回的内容格式不正确。");
    }
    let raw: unknown;
    try {
      raw = JSON.parse(text) as unknown;
    } catch {
      throw new AnklangInvalidResponseError("Anklang 返回的内容格式不正确。");
    }
    const resultSchema = this.#apiVersion === "2" ? anklangV2ResultSchema : anklangV1ResultSchema;
    const parsedResult = resultSchema.safeParse(raw);
    if (!parsedResult.success) {
      throw new AnklangInvalidResponseError("Anklang 返回的内容格式不正确。");
    }
    const result = parsedResult.data;
    if (result.contentHash !== body.contentHash) {
      throw new AnklangInvalidResponseError("Anklang 返回结果对应的题目内容已经变化。");
    }
    return result;
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
    ...(options.fetch === undefined ? {} : { fetch: options.fetch })
  });

  return {
    id: anklangCheckId,
    displayName: "原题相似度检查",
    timeoutMs: settings.timeoutMs,
    failureBehavior: settings.failureBehavior,
    async run(input, context): Promise<BeforeSubmitResult> {
      let result: AnklangResult;
      try {
        result = await readOrCheck(input, context.signal, client, settings, options.cache, now);
      } catch (error) {
        if (
          context.signal.aborted ||
          settings.failureBehavior === "block" ||
          settings.apiVersion === "1"
        ) {
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
      const highestCandidate = result.candidates.reduce<(typeof result.candidates)[number] | undefined>(
        (highest, candidate) =>
          highest === undefined || candidate.similarity > highest.similarity ? candidate : highest,
        undefined
      );
      const visibleCandidates = result.candidates
        .filter(
          (candidate) =>
            candidate.similarity >= settings.minimumSimilarityToShow ||
            (result.recommendation.blockSubmission && candidate === highestCandidate) ||
            (result.apiVersion === "2" &&
              result.completion.status === "partial" &&
              candidate.sameProblemSuggestion === true)
        )
        .sort((left, right) => right.similarity - left.similarity);

      if (
        result.apiVersion === "2" &&
        result.completion.status === "partial" &&
        settings.blockWhenRecommended &&
        result.recommendation.blockSubmission
      ) {
        return blockedResult(result, visibleCandidates, "anklang_partial_same_problem");
      }

      if (
        result.apiVersion === "2" &&
        result.completion.status !== "complete" &&
        settings.failureBehavior === "block"
      ) {
        throw new Error("Anklang 检查没有完整完成。");
      }

      if (settings.blockWhenRecommended && result.recommendation.blockSubmission) {
        return blockedResult(result, visibleCandidates, "anklang_similar_problem");
      }

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
  const itemType: ReviewItemType<AnklangResult> = {
    type: anklangReviewItemType,
    displayName: "原题相似度结果",
    dataSchema: anklangResultSchema
  };
  registry.registerReviewItemType(itemType);
  registry.registerBeforeSubmitCheck(createAnklangCheck(options));
}

export function anklangCompletionStatus(value: unknown): AnklangCompletionStatus | undefined {
  const parsed = anklangResultSchema.safeParse(value);
  if (!parsed.success) {
    return undefined;
  }
  return parsed.data.apiVersion === "1" ? "complete" : parsed.data.completion.status;
}

/** 把本地可安全公开的失败状态写成审核条目，不复制异常或上游响应正文。 */
export function createAnklangUnavailableReviewItem(
  input: BeforeSubmitInput,
  reasonCode: AnklangNoncompleteReasonCode,
  now: () => Date = () => new Date()
): ReviewItemInput {
  const result = anklangV2ResultSchema.parse({
    apiVersion: "2",
    contentHash: input.contentHash,
    checkedAt: now().toISOString(),
    completion: {
      status: "unavailable",
      reasonCode,
      retryable: reasonCode !== "service_invalid_response"
    },
    candidates: [],
    recommendation: {
      blockSubmission: false,
      message: "本次原题检索未能形成可信结果，请稍后重试。"
    },
    reuse: { policy: "no-store" }
  });
  return toReviewItem(result, []);
}

async function readOrCheck(
  input: BeforeSubmitInput,
  signal: AbortSignal,
  client: AnklangClient,
  settings: AnklangSettings,
  cache: AnklangCache | undefined,
  now: () => Date
): Promise<AnklangResult> {
  const cacheKey = `${settings.apiVersion}:${new URL(settings.baseUrl).href}:${settings.cacheMinutes}:${input.contentHash}`;
  let cached: unknown | undefined;
  try {
    cached = await cache?.get(cacheKey);
  } catch {
    cached = undefined;
  }
  const reusable = reusableCachedResult(cached, settings.apiVersion, input.contentHash, now());
  if (reusable !== undefined) {
    return reusable;
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
  const result = await client.check(request, signal);

  if (result.apiVersion === "1") {
    const expiresAt = new Date(now().getTime() + settings.cacheMinutes * 60_000).toISOString();
    await safeCacheSet(cache, cacheKey, result, expiresAt);
  } else if (
    result.completion.status === "complete" &&
    result.reuse.policy === "allowed"
  ) {
    const observedNowMs = now().getTime();
    const cacheExpiresAtMs = Math.min(
      Date.parse(result.reuse.expiresAt),
      observedNowMs + settings.cacheMinutes * 60_000
    );
    if (cacheExpiresAtMs > observedNowMs) {
      await safeCacheSet(cache, cacheKey, result, new Date(cacheExpiresAtMs).toISOString());
    }
  }
  return result;
}

async function safeCacheSet(
  cache: AnklangCache | undefined,
  cacheKey: string,
  result: AnklangResult,
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
  if (
    !parsed.success ||
    parsed.data.contentHash !== contentHash ||
    parsed.data.completion.status !== "complete" ||
    parsed.data.reuse.policy !== "allowed" ||
    Date.parse(parsed.data.reuse.expiresAt) <= now.getTime()
  ) {
    return undefined;
  }
  return parsed.data;
}

function blockedResult(
  result: AnklangResult,
  candidates: AnklangResult["candidates"],
  code: "anklang_similar_problem" | "anklang_partial_same_problem"
): BeforeSubmitResult {
  return {
    decision: "block",
    code,
    message: result.recommendation.message,
    details: {
      candidateCount: candidates.length,
      maximumSimilarity: candidates[0]?.similarity ?? 0,
      contentHash: result.contentHash
    }
  };
}

function toReviewItem(
  result: AnklangResult,
  candidates: AnklangResult["candidates"]
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
    result.reuse.policy === "allowed"
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
