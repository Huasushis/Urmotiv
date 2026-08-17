import { EnvHttpProxyAgent, fetch as undiciFetch } from "undici";
import type { QaReviewRequest, QaReviewResult, QaReviewer } from "./qa-gate";
import { HistoryNormalizationError, type HistoryNormalizationFailureKind } from "./errors";

export const qaReviewOutputTokens = 4_096;
export const qaReviewFirstOutputTimeoutMs = 60_000;
export const qaReviewIdleTimeoutMs = 30_000;

export interface DeepSeekReviewClientOptions {
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly model: string;
  /** 只供受控传输层测试。 */
  readonly fetch?: (input: URL, init: RequestInit) => Promise<Response>;
}

/** 流式“源对候选”评审客户端；单次调用，429 由上层以有界重试处理。 */
export function createDeepSeekReviewClient(options: DeepSeekReviewClientOptions): QaReviewer {
  const endpoint = new URL("chat/completions", options.baseUrl.endsWith("/") ? options.baseUrl : `${options.baseUrl}/`);
  const model = options.model.trim();
  const apiKey = options.apiKey;
  if (apiKey.length === 0 || model.length === 0) {
    throw new TypeError("AETHER_BASE_URL与AETHER_API_KEY必须提供才能创建评审钩子。");
  }
  const fetchImpl = options.fetch ?? defaultProxyFetch;
  return async (request: QaReviewRequest) => {
    const content = await requestExternalReview(fetchImpl, endpoint, apiKey, model, request);
    return parseReviewJson(content);
  };
}

async function requestExternalReview(
  fetchImpl: (input: URL, init: RequestInit) => Promise<Response>,
  endpoint: URL,
  apiKey: string,
  model: string,
  request: QaReviewRequest,
): Promise<string> {
  const controller = new AbortController();
  const watchdog = new OutputGuard(controller, qaReviewFirstOutputTimeoutMs, qaReviewIdleTimeoutMs);
  let response: Response;
  try {
    response = await fetchImpl(endpoint, buildReviewInit(apiKey, model, request, controller.signal));
    watchdog.receivedResponse();
  } catch (cause) {
    throw normalizeTransportError(cause, watchdog);
  }
  if (response.status === 429 || response.status >= 500 || !response.ok) {
    await response.body?.cancel();
    throw normalizationFailure(response.status === 429 ? "http_429" : "http_status");
  }
  const body = response.body;
  if (!body) {
    throw normalizationFailure("connection");
  }
  const content = await drainStream(body, watchdog);
  if (content.trim().length === 0) {
    throw normalizationFailure("eof_incomplete");
  }
  return content;
}

function normalizeTransportError(cause: unknown, watchdog: OutputGuard): HistoryNormalizationError {
  if (cause instanceof HistoryNormalizationError) return cause;
  if (isAbortError(cause)) return normalizationFailure(watchdog.timeoutKind);
  if (cause instanceof TypeError) return normalizationFailure("connection");
  return new HistoryNormalizationError("internal", cause instanceof Error ? cause.message : "传输未知错误");
}

function buildReviewInit(
  apiKey: string,
  model: string,
  request: QaReviewRequest,
  signal: AbortSignal,
): RequestInit {
  return {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model,
      temperature: 0.1,
      max_tokens: qaReviewOutputTokens,
      thinking: { type: "disabled" },
      response_format: { type: "json_object" },
      stream: true,
      messages: [
        { role: "system", content: reviewInstructions(request.secondAttempt) },
        { role: "user", content: `原始材料：\n${request.sourceText}\n\n候选内容：\n${request.candidateText}` },
      ],
    }),
    signal,
  };
}

const reviewInstructions = (secondAttempt: boolean): string =>
  `You are a quality reviewer for a competitive-programming problem-set archive. ` +
  `You receive the ORIGINAL material for one problem and a CANDIDATE problem record that a ` +
  `normalizer produced from it. Your job: decide whether the candidate faithfully preserved the ` +
  `source. Do NOT edit, answer, or fabricate anything not present in the original. ` +
  `Specifically flag: candidate inventing constraints/examples/solutions missing from source; ` +
  `candidate dropping required content such as attachments, constraints, or answer sections; ` +
  `candidate merging or splitting problems incorrectly; fields filled with garbage or invented text. ` +
  `If the source explicitly lacks a solution, the candidate MUST keep the solution empty and note ` +
  `the absence — that is PASS, not ANOMALY. Only respond with a single JSON object: ` +
  `{"verdict":"pass|anomaly|error","reasons":["short chinese reason"]}. Map pass to PASS, anomaly to ` +
  `ANOMALY, error to ERROR. No code fences, no commentary.` +
  (secondAttempt ? " This is the SECOND/ANOMALY-only review: confirm or refute the anomaly using the same rules." : "");

function defaultProxyFetch(input: URL, init: RequestInit): Promise<Response> {
  const dispatcher = new EnvHttpProxyAgent({ headersTimeout: 0, bodyTimeout: 0 });
  return undiciFetch(input, { ...init, dispatcher } as unknown as Parameters<typeof undiciFetch>[1]) as unknown as Promise<Response>;
}

async function drainStream(
  body: ReadableStream<Uint8Array>,
  watchdog: OutputGuard,
): Promise<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let pending = "";
  let content = "";
  for (;;) {
    const { value, done } = await readChunk(reader, watchdog);
    if (done) break;
    if (value === undefined) continue;
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
    }
  }
  content += decoder.decode();
  return content;
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
  return { verdict: verdictField, reasons: reasonsField as string[] };
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
