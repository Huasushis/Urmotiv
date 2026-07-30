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

export const anklangSettingsSchema = z
  .object({
    baseUrl: serviceUrlSchema,
    timeoutMs: z.number().int().min(1_000).max(120_000).default(120_000),
    failureBehavior: z.enum(["block", "continue"]).default("block"),
    blockWhenRecommended: z.boolean().default(true),
    minimumSimilarityToShow: z.number().min(0).max(1).default(0.3),
    cacheMinutes: z.number().int().min(1).max(10_080).default(1_440)
  })
  .strict();

export type AnklangSettings = z.infer<typeof anklangSettingsSchema>;

export const anklangCandidateSchema = z
  .object({
    source: z.string().trim().min(1).max(80),
    externalId: z.string().trim().min(1).max(200),
    title: z.string().trim().min(1).max(200),
    url: z.string().url().optional(),
    similarity: z.number().finite().min(0).max(1),
    sameProblemSuggestion: z.boolean().optional(),
    explanation: z.string().trim().min(1).max(2_000).optional()
  })
  .strict();

export const anklangResultSchema = z
  .object({
    apiVersion: z.literal("1"),
    contentHash: z.string().regex(/^[a-f0-9]{64}$/),
    checkedAt: z.string().datetime(),
    candidates: z.array(anklangCandidateSchema).max(50),
    recommendation: z
      .object({
        blockSubmission: z.boolean(),
        message: z.string().trim().min(1).max(2_000)
      })
      .strict()
  })
  .strict();

export type AnklangResult = z.infer<typeof anklangResultSchema>;

export const anklangRequestSchema = z
  .object({
    apiVersion: z.literal("1"),
    requestId: z.string().uuid(),
    contentHash: z.string().regex(/^[a-f0-9]{64}$/),
    problem: z
      .object({
        title: z.string().trim().min(1).max(200),
        type: z.enum(["traditional", "interactive", "submit_answer"]),
        tagIds: z.array(z.string().min(1).max(120)).min(1).max(30),
        basicStatement: z.string().min(1).max(500_000)
      })
      .strict()
  })
  .strict();

export type AnklangRequest = z.infer<typeof anklangRequestSchema>;

export interface AnklangCache {
  get(contentHash: string): Promise<unknown | undefined>;
  set(contentHash: string, result: AnklangResult, expiresAt: string): Promise<void>;
}

export type AnklangFetch = (
  input: string | URL | Request,
  init?: RequestInit
) => Promise<Response>;

export interface AnklangClientOptions {
  readonly baseUrl: string;
  readonly token?: string;
  readonly fetch?: AnklangFetch;
}

export class AnklangClient {
  readonly #endpoint: URL;
  readonly #token: string | undefined;
  readonly #fetch: AnklangFetch;

  public constructor(options: AnklangClientOptions) {
    const baseUrl = serviceUrlSchema.parse(options.baseUrl);
    this.#endpoint = new URL("/api/v1/checks/similarity", ensureTrailingSlash(baseUrl));
    this.#token = options.token?.trim() || undefined;
    this.#fetch = options.fetch ?? globalThis.fetch;
  }

  public async check(request: AnklangRequest, signal: AbortSignal): Promise<AnklangResult> {
    const body = anklangRequestSchema.parse(request);
    const response = await this.#fetch(this.#endpoint, {
      method: "POST",
      signal,
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        "X-Urmotiv-API-Version": "1",
        ...(this.#token === undefined ? {} : { Authorization: `Bearer ${this.#token}` })
      },
      body: JSON.stringify(body)
    });

    if (!response.ok) {
      throw new Error(`Anklang 请求失败，状态码为 ${response.status}。`);
    }

    const text = await readLimitedText(response, responseByteLimit);
    let raw: unknown;
    try {
      raw = JSON.parse(text) as unknown;
    } catch {
      throw new Error("Anklang 返回的内容不是有效 JSON。");
    }
    const result = anklangResultSchema.parse(raw);
    if (result.contentHash !== body.contentHash) {
      throw new Error("Anklang 返回结果对应的题目内容已经变化。");
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
  const client = new AnklangClient({
    baseUrl: settings.baseUrl,
    ...(options.token === undefined ? {} : { token: options.token }),
    ...(options.fetch === undefined ? {} : { fetch: options.fetch })
  });
  const now = options.now ?? (() => new Date());

  return {
    id: anklangCheckId,
    displayName: "原题相似度检查",
    timeoutMs: settings.timeoutMs,
    failureBehavior: settings.failureBehavior,
    async run(input, context): Promise<BeforeSubmitResult> {
      const result = await readOrCheck(input, context.signal, client, settings, options.cache, now);
      const visibleCandidates = result.candidates
        .filter((candidate) => candidate.similarity >= settings.minimumSimilarityToShow)
        .sort((left, right) => right.similarity - left.similarity);

      if (settings.blockWhenRecommended && result.recommendation.blockSubmission) {
        return {
          decision: "block",
          code: "anklang_similar_problem",
          message: result.recommendation.message,
          details: {
            candidateCount: visibleCandidates.length,
            maximumSimilarity: visibleCandidates[0]?.similarity ?? 0,
            contentHash: result.contentHash
          }
        };
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

async function readOrCheck(
  input: BeforeSubmitInput,
  signal: AbortSignal,
  client: AnklangClient,
  settings: AnklangSettings,
  cache: AnklangCache | undefined,
  now: () => Date
): Promise<AnklangResult> {
  const cached = await cache?.get(input.contentHash);
  if (cached !== undefined) {
    const parsed = anklangResultSchema.parse(cached);
    if (parsed.contentHash === input.contentHash) {
      return parsed;
    }
  }

  const result = await client.check(
    {
      apiVersion: "1",
      requestId: randomUUID(),
      contentHash: input.contentHash,
      problem: {
        title: input.problem.title,
        type: input.problem.type,
        tagIds: input.problem.tagIds,
        basicStatement: input.problem.basicStatement
      }
    },
    signal
  );
  const expiresAt = new Date(now().getTime() + settings.cacheMinutes * 60_000).toISOString();
  await cache?.set(input.contentHash, result, expiresAt);
  return result;
}

function toReviewItem(
  result: AnklangResult,
  candidates: AnklangResult["candidates"]
): ReviewItemInput {
  const highest = candidates[0]?.similarity;
  return {
    type: anklangReviewItemType,
    visibility: "author",
    summary:
      highest === undefined
        ? "没有发现达到显示下限的相似题目。"
        : `发现 ${candidates.length} 道候选题，最高相似度为 ${Math.round(highest * 100)}%。`,
    data: { ...result, candidates },
    contentHash: result.contentHash
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
  return new TextDecoder().decode(content);
}

function ensureTrailingSlash(value: string): string {
  return value.endsWith("/") ? value : `${value}/`;
}
