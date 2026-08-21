import { EnvHttpProxyAgent, fetch as undiciFetch } from "undici";
import type { QaReviewRequest, QaReviewResult, QaReviewer, QaDisposition } from "./qa-gate";
import { HistoryNormalizationError, type HistoryNormalizationFailureKind } from "./errors";

/** 抽取阶段只输出评审字段所需的 tokens。 */
export const qaReviewOutputTokens = 4_096;
/** 深度思考阶段（含推理）的 tokens，容纳完整分析后再被抽取。 */
export const qaReviewStageOneOutputTokens = 16_384;
export const qaReviewFirstOutputTimeoutMs = 60_000;
export const qaReviewIdleTimeoutMs = 30_000;
/**
 * 阶段一使用的最大推理预算（串行化元数据：thinking.budget_tokens）。
 * 数值沿用既有配置；未对提供方运行时上限做实机验证，上线前须以现网请求复核。
 */
export const qaReviewThinkingBudgetTokens = 8_192;

export interface DeepSeekReviewClientOptions {
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly model: string;
  /** 只供受控传输层测试。 */
  readonly fetch?: (input: URL, init: RequestInit) => Promise<Response>;
}

/** 单次评审的两阶段文本载体；只在内存中传递，绝不落库/日志。 */
interface CompletionText {
  readonly content: string;
  readonly reasoning: string;
  /** 传输层是否收到过至少一个字节；区分零字节断流（可重试）与有字节但无正文（歧义）。 */
  readonly receivedBytes: boolean;
}

/**
 * 两阶段深度评审：
 *  1) 最大深度思考请求（thinking 开启、不约束结构化输出），流式收取 content+reasoning；
 *  2) 独立抽取请求（thinking 关闭、strict JSON Schema）只回传 disposition/verdict/reasons。
 * 传输层保持既有安全策略：明确 429 或零字节连接失败才可重试；部分/歧义流从不重放，
 * 统一以非重试 schema/eof 错误暴露，由上层有界记账。
 */
export function createDeepSeekReviewClient(options: DeepSeekReviewClientOptions): QaReviewer {
  const endpoint = new URL("chat/completions", options.baseUrl.endsWith("/") ? options.baseUrl : `${options.baseUrl}/`);
  const model = options.model.trim();
  const apiKey = options.apiKey;
  if (apiKey.length === 0 || model.length === 0) {
    throw new TypeError("AETHER_BASE_URL与AETHER_API_KEY必须提供才能创建评审钩子。");
  }
  const fetchImpl = options.fetch ?? defaultProxyFetch;
  return async (request: QaReviewRequest) => {
    const stageOne = await requestStageOne(fetchImpl, endpoint, apiKey, model, request);
    const extractionText = await requestStageTwo(fetchImpl, endpoint, apiKey, model, stageOne);
    return parseReviewJson(extractionText);
  };
}

async function requestStageOne(
  fetchImpl: (input: URL, init: RequestInit) => Promise<Response>,
  endpoint: URL,
  apiKey: string,
  model: string,
  request: QaReviewRequest,
): Promise<CompletionText> {
  const controller = new AbortController();
  const watchdog = new OutputGuard(controller, qaReviewFirstOutputTimeoutMs, qaReviewIdleTimeoutMs);
  return streamCompletion(fetchImpl, endpoint, apiKey, model, buildStageOneInit(apiKey, model, request), watchdog);
}

async function requestStageTwo(
  fetchImpl: (input: URL, init: RequestInit) => Promise<Response>,
  endpoint: URL,
  apiKey: string,
  model: string,
  stageOne: CompletionText,
): Promise<string> {
  const controller = new AbortController();
  const watchdog = new OutputGuard(controller, qaReviewFirstOutputTimeoutMs, qaReviewIdleTimeoutMs);
  const { content } = await streamCompletion(
    fetchImpl,
    endpoint,
    apiKey,
    model,
    buildStageTwoInit(apiKey, model, stageOne),
    watchdog,
  );
  if (content.trim().length === 0) {
    throw normalizationFailure("eof_incomplete");
  }
  return content;
}

async function streamCompletion(
  fetchImpl: (input: URL, init: RequestInit) => Promise<Response>,
  endpoint: URL,
  apiKey: string,
  model: string,
  buildInit: (signal: AbortSignal) => RequestInit,
  watchdog: OutputGuard,
): Promise<CompletionText> {
  let response: Response;
  try {
    response = await fetchImpl(endpoint, buildInit(watchdog.controller()));
    watchdog.receivedResponse();
  } catch (cause) {
    throw normalizeTransportError(cause, watchdog);
  }
  if (response.status === 429 || response.status >= 500 || !response.ok) {
    await response.body?.cancel();
    const statusClass = response.status < 500 ? `${Math.floor(response.status / 100)}xx` : "5xx";
    throw new HistoryNormalizationError(
      response.status === 429 ? "http_429" : "http_status",
      response.status === 429 ? "限流，稍后重试。" : `HTTP ${response.status}`,
      statusClass,
    );
  }
  const body = response.body;
  if (!body) {
    throw normalizationFailure("connection");
  }
  const text = await drainStream(body, watchdog);
  if (text.content.trim().length === 0 && text.reasoning.trim().length === 0) {
    // 零字节断流 → connection（可重试，有界退避由 gate 负责）；
    // 有字节但无正文 → 歧义，不重放。
    throw normalizationFailure(text.receivedBytes ? "eof_incomplete" : "connection");
  }
  return text;
}

function normalizeTransportError(cause: unknown, watchdog: OutputGuard): HistoryNormalizationError {
  if (cause instanceof HistoryNormalizationError) return cause;
  if (isAbortError(cause)) return normalizationFailure(watchdog.timeoutKind);
  if (cause instanceof TypeError) return normalizationFailure("connection");
  return new HistoryNormalizationError("internal", cause instanceof Error ? cause.message : "传输未知错误");
}

function buildStageOneInit(
  apiKey: string,
  model: string,
  request: QaReviewRequest,
): (signal: AbortSignal) => RequestInit {
  return (signal) => ({
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model,
      temperature: 0.1,
      max_tokens: qaReviewStageOneOutputTokens,
      // 最大深度推理：不附加 response_format，避免与 thinking 冲突。
      thinking: { type: "enabled", budget_tokens: qaReviewThinkingBudgetTokens },
      stream: true,
      messages: [{
        role: "user",
        content: reviewUserText(request),
      }],
    }),
    signal,
  });
}

function buildStageTwoInit(
  apiKey: string,
  model: string,
  stageOne: CompletionText,
): (signal: AbortSignal) => RequestInit {
  return (signal) => ({
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model,
      temperature: 0.1,
      max_tokens: qaReviewOutputTokens,
      // 抽取阶段不做深度推理：强制关闭 thinking，用 strict JSON Schema 约束输出。
      thinking: { type: "disabled" },
      response_format: {
        type: "json_schema",
        json_schema: {
          name: "qa_review_extraction",
          strict: true,
          schema: reviewJsonSchema,
        },
      },
      stream: true,
      messages: [
        { role: "system", content: extractionInstruction() },
        { role: "user", content: `评审分析：\n${stageOne.reasoning}\n${stageOne.content}` },
      ],
    }),
    signal,
  });
}

function reviewUserText(request: QaReviewRequest): string {
  const riskContext =
    request.deterministicRisks !== undefined && request.deterministicRisks.length > 0
      ? `\n\n确定性检查发现风险：${request.deterministicRisks.join("、")}。这些机器发现可能错误，请逐条对照原文独立核实，并给出处置结论。`
      : "";
  return (
    `你是竞赛题库存档的质量评审员。你收到一道题的【原始材料】和由规范化流程生成的【候选题目记录】。` +
    `请判断候选是否忠实保留了原始材料：不便造原文没有的约束/样例/题解；不遗漏附件、约束或答案段落；不改写语义。` +
    `若原文明确没有题解，候选必须保持题解为空并说明缺失——这是通过（PASS），不是异常。` +
    `请逐步分析后给出结论。` +
    riskContext +
    (request.secondAttempt ? `\n\n这是对 ANOMALY 的复核：请用同一套规则确认或驳回异常。` : "")
  );
}

function extractionInstruction(): string {
  return (
    `你是结构化输出抽取器。请根据给定的完整评审分析，只输出评审结论，` +
    `严格符合 JSON Schema：{"verdict":"PASS"|"ANOMALY"|"ERROR","disposition":"corrected"|"verified-false-positive"|"genuinely-unresolved-preserved-missing"|null,"reasons":["简短中文理由"]}。` +
    `disposition 表示风险项处置；无风险时不填（返回 null）。reasons 为 1..3 条简短中文理由。` +
    `不得输出任何额外文字、代码围栏或分析。`
  );
}

/** Stage-2 strict JSON Schema（与 parseReviewJson 保持一致）。 */
const reviewJsonSchema = {
  type: "object",
  properties: {
    verdict: { type: "string", enum: ["PASS", "ANOMALY", "ERROR"] },
    disposition: {
      anyOf: [
        { type: "string", enum: ["corrected", "verified-false-positive", "genuinely-unresolved-preserved-missing"] },
        { type: "null" },
      ],
    },
    reasons: { type: "array", items: { type: "string" }, minItems: 1 },
  },
  required: ["verdict", "reasons"],
  additionalProperties: false,
} as const;

function defaultProxyFetch(input: URL, init: RequestInit): Promise<Response> {
  const dispatcher = new EnvHttpProxyAgent({ headersTimeout: 0, bodyTimeout: 0 });
  return undiciFetch(input, { ...init, dispatcher } as unknown as Parameters<typeof undiciFetch>[1]) as unknown as Promise<Response>;
}

async function drainStream(
  body: ReadableStream<Uint8Array>,
  watchdog: OutputGuard,
): Promise<CompletionText> {
  const reader = body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let pending = "";
  let content = "";
  let reasoning = "";
  let receivedBytes = false;
  for (;;) {
    const { value, done } = await readChunk(reader, watchdog);
    if (done) break;
    if (value === undefined) continue;
    if (value.byteLength > 0) receivedBytes = true;
    watchdog.receivedChunk();
    pending += decoder.decode(value, { stream: true });
    const lines = pending.split("\n");
    pending = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.startsWith("data:")) continue;
      const data = line.slice("data:".length).trimStart();
      if (data.length === 0 || data === "[DONE]") continue;
      let event: SseRecord;
      try {
        event = JSON.parse(data) as SseRecord;
      } catch {
        continue;
      }
      const choices = event.choices;
      if (!Array.isArray(choices) || choices.length === 0) continue;
      if (typeof event.error !== "undefined") {
        throw normalizationFailure("http_status");
      }
      const delta = choices[0]?.delta;
      if (typeof delta !== "object" || delta === null) continue;
      const piece = delta as Record<string, unknown>;
      if (typeof piece.content === "string") content += piece.content;
      if (typeof piece.reasoning_content === "string") reasoning += piece.reasoning_content;
    }
  }
  content += decoder.decode();
  return { content, reasoning, receivedBytes };
}

async function readChunk(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  watchdog: OutputGuard,
): Promise<{ readonly value: Uint8Array | undefined; readonly done: boolean }> {
  try {
    return await reader.read();
  } catch (error) {
    if (isAbortError(error)) {
      throw normalizationFailure(watchdog.timeoutKind);
    }
    throw normalizeTransportError(error, watchdog);
  }
}

interface SseRecord {
  readonly choices?: readonly { readonly delta?: unknown }[];
  readonly error?: unknown;
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

function parseReviewJson(content: string): QaReviewResult {
  let payload: unknown;
  try {
    payload = JSON.parse(content) as unknown;
  } catch {
    throw normalizationFailure("invalid_json");
  }
  if (typeof payload !== "object" || payload === null) {
    throw normalizationFailure("schema");
  }
  const record = payload as Record<string, unknown>;
  // 提示词要求模型把 verdict 映射为大写 PASS/ANOMALY/ERROR；但模型常按
  // 字面示例回传小写。这里统一规范化大小写，避免合法判定被误判为 schema 失败。
  const rawVerdict = record.verdict;
  const verdictField =
    typeof rawVerdict === "string" ? rawVerdict.toUpperCase() : rawVerdict;
  if (verdictField !== "PASS" && verdictField !== "ANOMALY" && verdictField !== "ERROR") {
    throw normalizationFailure("schema");
  }
  const reasonsField = record.reasons;
  if (!Array.isArray(reasonsField) || !reasonsField.every((reason) => typeof reason === "string")) {
    throw normalizationFailure("schema");
  }
  // disposition 可缺省或为 null（无风险项不要求），出现有效字符串时必须严格校验。
  let disposition: QaDisposition | undefined;
  const dispositionField = record.disposition;
  if (dispositionField !== undefined && dispositionField !== null) {
    validateQaDisposition(dispositionField);
    disposition = dispositionField as QaDisposition;
  }
  return {
    verdict: verdictField,
    reasons: reasonsField as string[],
    ...(disposition ? { disposition } : {}),
  };
}

function isQaDispositionValue(value: unknown): value is QaDisposition {
  return value === "corrected" || value === "verified-false-positive" ||
    value === "genuinely-unresolved-preserved-missing";
}

function validateQaDisposition(value: unknown): void {
  if (!isQaDispositionValue(value)) {
    throw normalizationFailure("schema");
  }
}

function normalizationFailure(kind: HistoryNormalizationFailureKind): HistoryNormalizationError {
  return new HistoryNormalizationError(kind, `评审失败（${kind}）。`);
}

class OutputGuard {
  readonly #controller: AbortController;
  readonly #idleTimeoutMs: number;
  #firstTimer: NodeJS.Timeout | undefined;
  #idleTimer: NodeJS.Timeout | undefined;
  timeoutKind: HistoryNormalizationFailureKind = "first_output_timeout";

  public constructor(
    controller: AbortController,
    firstTokenTimeoutMs: number,
    idleTimeoutMs: number,
  ) {
    this.#controller = controller;
    this.#idleTimeoutMs = idleTimeoutMs;
    this.#firstTimer = setTimeout(() => this.#abort("first_output_timeout"), firstTokenTimeoutMs);
  }

  /** 供转译层把 AbortSignal 交给 fetch。 */
  public controller(): AbortSignal {
    return this.#controller.signal;
  }

  public receivedResponse(): void {
    this.#clearFirstTimer();
  }

  public receivedChunk(): void {
    this.#clearFirstTimer();
    if (this.#idleTimer !== undefined) clearTimeout(this.#idleTimer);
    this.#idleTimer = setTimeout(() => this.#abort("output_idle_timeout"), this.#idleTimeoutMs);
  }

  public close(): void {
    this.#clearFirstTimer();
    if (this.#idleTimer !== undefined) clearTimeout(this.#idleTimer);
    this.#idleTimer = undefined;
  }

  #clearFirstTimer(): void {
    if (this.#firstTimer !== undefined) clearTimeout(this.#firstTimer);
    this.#firstTimer = undefined;
  }

  #abort(kind: HistoryNormalizationFailureKind): void {
    this.timeoutKind = kind;
    this.close();
    this.#controller.abort();
  }
}
