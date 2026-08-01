import { EnvHttpProxyAgent, fetch as undiciFetch } from "undici";
import type { HistoryNormalizer, HistoryNormalizerInput } from "./core";
import { HistoryMigrationError } from "./errors";
import { type NormalizedHistoryOutput, normalizedHistoryOutputSchema } from "./schema";

type HistoryNormalizerFetch = (input: URL, init: RequestInit) => Promise<Response>;

export interface LlmHistoryNormalizerOptions {
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly model: string;
  /** 等待第一段非空模型输出的时间。 */
  readonly firstOutputTimeoutMs?: number;
  /** 已经开始输出后，连续没有非空模型输出的等待时间。 */
  readonly outputIdleTimeoutMs?: number;
  /** 总尝试次数；只有服务端明确返回 429 时才会使用后续尝试。 */
  readonly maximumAttempts?: number;
  readonly retryBaseDelayMs?: number;
  readonly maximumResponseBytes?: number;
  /** 人工停止任务或上层不再允许继续时，明确取消正在运行的请求。 */
  readonly signal?: AbortSignal;
  /** 只供合成测试或受控传输层使用。 */
  readonly fetch?: HistoryNormalizerFetch;
}

export const maximumNormalizationResponseBytes = 10_000_000;
export const defaultNormalizationFirstOutputTimeoutMs = 30 * 60 * 1_000;
export const defaultNormalizationOutputIdleTimeoutMs = 10 * 60 * 1_000;

interface NormalizationRuntime {
  readonly firstOutputTimeoutMs: number;
  readonly outputIdleTimeoutMs: number;
  readonly maximumAttempts: number;
  readonly retryBaseDelayMs: number;
  readonly maximumResponseBytes: number;
  readonly signal: AbortSignal | undefined;
  readonly fetch: HistoryNormalizerFetch;
}

export function createLlmHistoryNormalizer(
  options: LlmHistoryNormalizerOptions,
): HistoryNormalizer {
  const endpoint = new URL("chat/completions", ensureTrailingSlash(options.baseUrl));
  if (options.apiKey.length === 0 || options.model.trim().length === 0) {
    throw new HistoryMigrationError(
      "INVALID_ARGUMENTS",
      "模型地址、密钥和模型名称必须通过私有环境配置提供。",
    );
  }
  const runtime: NormalizationRuntime = {
    firstOutputTimeoutMs: positiveDuration(
      options.firstOutputTimeoutMs ?? defaultNormalizationFirstOutputTimeoutMs,
    ),
    outputIdleTimeoutMs: positiveDuration(
      options.outputIdleTimeoutMs ?? defaultNormalizationOutputIdleTimeoutMs,
    ),
    maximumAttempts: positiveInteger(options.maximumAttempts ?? 3, 10),
    retryBaseDelayMs: positiveInteger(options.retryBaseDelayMs ?? 3_000, 60_000),
    maximumResponseBytes: positiveInteger(
      options.maximumResponseBytes ?? maximumNormalizationResponseBytes,
      maximumNormalizationResponseBytes,
    ),
    signal: options.signal,
    fetch: options.fetch ?? defaultStreamingFetch,
  };

  return {
    async normalize(input: HistoryNormalizerInput): Promise<NormalizedHistoryOutput> {
      const response = await requestNormalization(
        endpoint,
        options.apiKey,
        options.model,
        input,
        runtime,
      );
      const parsed = normalizedHistoryOutputSchema.safeParse(response);
      if (!parsed.success) {
        throw new HistoryMigrationError(
          "NORMALIZATION_FAILED",
          `${input.sourceId} 的模型结果不符合候选内容格式。`,
        );
      }
      return parsed.data;
    },
  };
}

async function requestNormalization(
  endpoint: URL,
  apiKey: string,
  model: string,
  input: HistoryNormalizerInput,
  runtime: NormalizationRuntime,
): Promise<unknown> {
  for (let attempt = 1; attempt <= runtime.maximumAttempts; attempt += 1) {
    const attemptResult = await requestNormalizationOnce(
      endpoint,
      apiKey,
      model,
      input.sourceId,
      input,
      runtime,
    );
    if (attemptResult.kind === "content") {
      try {
        return JSON.parse(extractJsonObject(attemptResult.content)) as unknown;
      } catch {
        throw new HistoryMigrationError(
          "NORMALIZATION_FAILED",
          `${input.sourceId} 的模型响应不包含有效候选 JSON。`,
        );
      }
    }
    if (attempt === runtime.maximumAttempts) {
      throw new HistoryMigrationError(
        "NORMALIZATION_FAILED",
        `${input.sourceId} 的模型服务持续返回 HTTP 429。`,
      );
    }
    await waitBeforeRateLimitRetry(
      runtime.retryBaseDelayMs * attempt,
      runtime.signal,
      input.sourceId,
    );
  }
  throw new HistoryMigrationError("NORMALIZATION_FAILED", `${input.sourceId} 的模型请求失败。`);
}

type NormalizationAttemptResult =
  | { readonly kind: "content"; readonly content: string }
  | { readonly kind: "rate_limited" };

async function requestNormalizationOnce(
  endpoint: URL,
  apiKey: string,
  model: string,
  sourceId: string,
  input: HistoryNormalizerInput,
  runtime: NormalizationRuntime,
): Promise<NormalizationAttemptResult> {
  if (isSignalAborted(runtime.signal)) {
    throw cancelledRequest(sourceId);
  }

  const controller = new AbortController();
  const watchdog = new NormalizationOutputWatchdog(
    controller,
    runtime.firstOutputTimeoutMs,
    runtime.outputIdleTimeoutMs,
  );
  const cancelFromParent = (): void => {
    controller.abort();
  };
  runtime.signal?.addEventListener("abort", cancelFromParent, { once: true });
  let responseReceived = false;

  try {
    const response = await waitForOrAbort(
      runtime.fetch(endpoint, {
        method: "POST",
        signal: controller.signal,
        headers: {
          "Content-Type": "application/json",
          Accept: "text/event-stream, application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model,
          temperature: 0.1,
          stream: true,
          messages: [
            { role: "system", content: normalizationInstructions },
            {
              role: "user",
              content: [
                `已由人工确认的参考题名：${input.expectedTitle}`,
                `已由人工确认的 CF 难度参考：${input.difficultyGuess ?? "未知"}`,
                "",
                "原始文本：",
                input.text,
              ].join("\n"),
            },
          ],
        }),
      }),
      controller.signal,
    );
    responseReceived = true;

    if (!response.ok) {
      cancelResponseBodyWithoutReading(response, controller);
      if (response.status === 429) {
        return { kind: "rate_limited" };
      }
      throw new HistoryMigrationError(
        "NORMALIZATION_FAILED",
        `${sourceId} 的模型服务返回 HTTP ${response.status}。`,
      );
    }

    const content = await readSuccessfulResponse(
      response,
      controller,
      watchdog,
      runtime.maximumResponseBytes,
    );
    return { kind: "content", content };
  } catch (error) {
    const timeoutKind = watchdog.timeoutKind();
    if (timeoutKind === "first_output") {
      throw new HistoryMigrationError(
        "NORMALIZATION_FAILED",
        `${sourceId} 的模型请求在首段有效输出前超时。`,
      );
    }
    if (timeoutKind === "output_idle") {
      throw new HistoryMigrationError(
        "NORMALIZATION_FAILED",
        `${sourceId} 的模型输出长时间没有继续。`,
      );
    }
    if (isSignalAborted(runtime.signal)) {
      throw cancelledRequest(sourceId);
    }
    if (error instanceof HistoryMigrationError) {
      throw error;
    }
    throw new HistoryMigrationError(
      "NORMALIZATION_FAILED",
      responseReceived
        ? `${sourceId} 的模型响应在完整结束前中断。`
        : `${sourceId} 的模型连接失败。`,
    );
  } finally {
    runtime.signal?.removeEventListener("abort", cancelFromParent);
    watchdog.close();
  }
}

type NormalizationTimeoutKind = "first_output" | "output_idle";

class NormalizationOutputWatchdog {
  readonly #controller: AbortController;
  readonly #outputIdleTimeoutMs: number;
  #firstOutputTimer: ReturnType<typeof setTimeout> | null;
  #outputIdleTimer: ReturnType<typeof setTimeout> | null = null;
  #timeoutKind: NormalizationTimeoutKind | null = null;

  public constructor(
    controller: AbortController,
    firstOutputTimeoutMs: number,
    outputIdleTimeoutMs: number,
  ) {
    this.#controller = controller;
    this.#outputIdleTimeoutMs = outputIdleTimeoutMs;
    this.#firstOutputTimer = setTimeout(() => {
      this.#abort("first_output");
    }, firstOutputTimeoutMs);
  }

  public receivedValidOutput(): void {
    if (this.#timeoutKind !== null) return;
    if (this.#firstOutputTimer !== null) {
      clearTimeout(this.#firstOutputTimer);
      this.#firstOutputTimer = null;
    }
    if (this.#outputIdleTimer !== null) {
      clearTimeout(this.#outputIdleTimer);
    }
    this.#outputIdleTimer = setTimeout(() => {
      this.#abort("output_idle");
    }, this.#outputIdleTimeoutMs);
  }

  public timeoutKind(): NormalizationTimeoutKind | null {
    return this.#timeoutKind;
  }

  public close(): void {
    if (this.#firstOutputTimer !== null) {
      clearTimeout(this.#firstOutputTimer);
      this.#firstOutputTimer = null;
    }
    if (this.#outputIdleTimer !== null) {
      clearTimeout(this.#outputIdleTimer);
      this.#outputIdleTimer = null;
    }
  }

  #abort(kind: NormalizationTimeoutKind): void {
    if (this.#timeoutKind !== null) return;
    this.#timeoutKind = kind;
    this.#controller.abort();
  }
}

async function readSuccessfulResponse(
  response: Response,
  requestController: AbortController,
  watchdog: NormalizationOutputWatchdog,
  maximumBytes: number,
): Promise<string> {
  assertDeclaredResponseSize(response, requestController, maximumBytes);
  const mediaType = response.headers.get("content-type")?.toLowerCase() ?? "";
  if (mediaType.includes("text/event-stream")) {
    return readEventStream(response, requestController, watchdog, maximumBytes);
  }
  const responseText = await readBoundedJsonResponseText(
    response,
    requestController,
    watchdog,
    maximumBytes,
  );
  let payload: unknown;
  try {
    payload = JSON.parse(responseText) as unknown;
  } catch {
    throw new HistoryMigrationError("NORMALIZATION_FAILED", "模型响应不是完整的 JSON。");
  }
  return readCompletedResponseContent(payload);
}

function assertDeclaredResponseSize(
  response: Response,
  requestController: AbortController,
  maximumBytes: number,
): void {
  const declaredLength = response.headers.get("content-length");
  if (
    declaredLength !== null &&
    /^[0-9]+$/.test(declaredLength) &&
    Number(declaredLength) > maximumBytes
  ) {
    cancelResponseBodyWithoutReading(response, requestController);
    throw responseTooLarge();
  }
}

async function readBoundedJsonResponseText(
  response: Response,
  requestController: AbortController,
  watchdog: NormalizationOutputWatchdog,
  maximumBytes: number,
): Promise<string> {
  if (response.body === null) {
    throw interruptedResponse();
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  let readerFinished = false;
  try {
    for (;;) {
      const chunk = await waitForOrAbort(reader.read(), requestController.signal);
      if (chunk.done) {
        readerFinished = true;
        break;
      }
      totalBytes = addResponseChunkSize(
        totalBytes,
        chunk.value.byteLength,
        maximumBytes,
        reader,
        requestController,
      );
      if (containsNonWhitespaceByte(chunk.value)) {
        watchdog.receivedValidOutput();
      }
      chunks.push(chunk.value);
    }
  } finally {
    if (!readerFinished) {
      cancelReaderWithoutReplacingError(reader, requestController);
    }
    try {
      reader.releaseLock();
    } catch {
      // 已经得到固定结果或固定错误，不再用清理错误替换它。
    }
  }

  const bytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new HistoryMigrationError("NORMALIZATION_FAILED", "模型响应不是有效的 UTF-8 文本。");
  }
}

interface CompletionStreamState {
  content: string;
  sawChoice: boolean;
  sawStop: boolean;
  sawDone: boolean;
}

async function readEventStream(
  response: Response,
  requestController: AbortController,
  watchdog: NormalizationOutputWatchdog,
  maximumBytes: number,
): Promise<string> {
  if (response.body === null) {
    throw interruptedResponse();
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const state: CompletionStreamState = {
    content: "",
    sawChoice: false,
    sawStop: false,
    sawDone: false,
  };
  let pending = "";
  let trailingCarriageReturn = false;
  let totalBytes = 0;
  let readerFinished = false;

  try {
    for (;;) {
      const chunk = await waitForOrAbort(reader.read(), requestController.signal);
      if (chunk.done) {
        readerFinished = true;
        ({ pending, trailingCarriageReturn } = appendEventStreamText(
          pending,
          trailingCarriageReturn,
          decodeEventStreamText(decoder),
          true,
        ));
        pending = consumeCompleteEvents(pending, state, watchdog);
        if (pending.trim().length > 0) {
          consumeCompletionEvent(pending, state, watchdog);
        }
        if (!state.sawChoice || !state.sawStop || state.content.trim().length === 0) {
          throw interruptedResponse();
        }
        return state.content;
      }
      totalBytes = addResponseChunkSize(
        totalBytes,
        chunk.value.byteLength,
        maximumBytes,
        reader,
        requestController,
      );
      if (chunk.value.byteLength === 0) continue;
      ({ pending, trailingCarriageReturn } = appendEventStreamText(
        pending,
        trailingCarriageReturn,
        decodeEventStreamText(decoder, chunk.value),
        false,
      ));
      pending = consumeCompleteEvents(pending, state, watchdog);
    }
  } finally {
    if (!readerFinished) {
      cancelReaderWithoutReplacingError(reader, requestController);
    }
    try {
      reader.releaseLock();
    } catch {
      // 已经得到固定结果或固定错误，不再用清理错误替换它。
    }
  }
}

function consumeCompleteEvents(
  input: string,
  state: CompletionStreamState,
  watchdog: NormalizationOutputWatchdog,
): string {
  let pending = input;
  for (;;) {
    const boundary = pending.indexOf("\n\n");
    if (boundary < 0) return pending;
    const event = pending.slice(0, boundary);
    pending = pending.slice(boundary + 2);
    consumeCompletionEvent(event, state, watchdog);
  }
}

function consumeCompletionEvent(
  event: string,
  state: CompletionStreamState,
  watchdog: NormalizationOutputWatchdog,
): void {
  const data = event
    .split("\n")
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice("data:".length).trimStart())
    .join("\n")
    .trim();
  if (data.length === 0) return;
  if (state.sawDone) {
    throw invalidResponseFormat();
  }
  if (data === "[DONE]") {
    state.sawDone = true;
    return;
  }

  let raw: unknown;
  try {
    raw = JSON.parse(data) as unknown;
  } catch {
    throw invalidResponseFormat();
  }
  if (typeof raw !== "object" || raw === null) {
    throw invalidResponseFormat();
  }
  const record = raw as Record<string, unknown>;
  if (Object.hasOwn(record, "error")) {
    throw invalidResponseFormat();
  }
  if (!Array.isArray(record.choices)) {
    throw invalidResponseFormat();
  }
  if (record.choices.length === 0) {
    // 部分兼容服务会在答案后发送只含用量的事件。
    return;
  }
  if (record.choices.length !== 1 || state.sawStop) {
    throw invalidResponseFormat();
  }
  const choice = record.choices[0];
  if (typeof choice !== "object" || choice === null) {
    throw invalidResponseFormat();
  }
  state.sawChoice = true;
  const choiceRecord = choice as Record<string, unknown>;
  const delta =
    typeof choiceRecord.delta === "object" && choiceRecord.delta !== null
      ? choiceRecord.delta
      : choiceRecord.message;
  if (typeof delta !== "object" || delta === null) {
    throw invalidResponseFormat();
  }
  const part = delta as Record<string, unknown>;
  for (const field of ["content", "reasoning_content", "reasoning"] as const) {
    const value = part[field];
    if (value !== undefined && value !== null && typeof value !== "string") {
      throw invalidResponseFormat();
    }
  }

  let containsValidOutput = false;
  if (typeof part.content === "string") {
    state.content += part.content;
    containsValidOutput ||= part.content.trim().length > 0;
  }
  if (typeof part.reasoning_content === "string") {
    containsValidOutput ||= part.reasoning_content.trim().length > 0;
  }
  if (typeof part.reasoning === "string") {
    containsValidOutput ||= part.reasoning.trim().length > 0;
  }
  if (containsValidOutput) {
    watchdog.receivedValidOutput();
  }

  const finishReason = choiceRecord.finish_reason;
  if (finishReason !== undefined && finishReason !== null) {
    if (finishReason !== "stop") {
      throw invalidResponseFormat();
    }
    state.sawStop = true;
  }
}

function decodeEventStreamText(decoder: TextDecoder, bytes?: Uint8Array): string {
  try {
    return bytes === undefined ? decoder.decode() : decoder.decode(bytes, { stream: true });
  } catch {
    throw new HistoryMigrationError("NORMALIZATION_FAILED", "模型响应不是有效的 UTF-8 文本。");
  }
}

function appendEventStreamText(
  pending: string,
  trailingCarriageReturn: boolean,
  next: string,
  final: boolean,
): { readonly pending: string; readonly trailingCarriageReturn: boolean } {
  let text = next;
  let carried = trailingCarriageReturn;
  if (carried && text.length > 0) {
    pending += "\n";
    if (text.startsWith("\n")) {
      text = text.slice(1);
    }
    carried = false;
  }
  if (!final && text.endsWith("\r")) {
    text = text.slice(0, -1);
    carried = true;
  }
  pending += text.replace(/\r\n/gu, "\n").replace(/\r/gu, "\n");
  if (final && carried) {
    pending += "\n";
    carried = false;
  }
  return { pending, trailingCarriageReturn: carried };
}

function addResponseChunkSize(
  totalBytes: number,
  nextBytes: number,
  maximumBytes: number,
  reader: ReadableStreamDefaultReader<Uint8Array>,
  requestController: AbortController,
): number {
  if (nextBytes > maximumBytes - totalBytes) {
    cancelReaderWithoutReplacingError(reader, requestController);
    throw responseTooLarge();
  }
  return totalBytes + nextBytes;
}

function containsNonWhitespaceByte(bytes: Uint8Array): boolean {
  return bytes.some((byte) => byte !== 0x09 && byte !== 0x0a && byte !== 0x0d && byte !== 0x20);
}

function cancelResponseBodyWithoutReading(
  response: Response,
  fallbackController: AbortController,
): void {
  if (response.body === null) return;
  try {
    const cancellation = response.body.cancel();
    void cancellation.catch(() => {
      fallbackController.abort();
    });
  } catch {
    fallbackController.abort();
  }
}

function cancelReaderWithoutReplacingError(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  fallbackController: AbortController,
): void {
  try {
    const cancellation = reader.cancel();
    void cancellation.catch(() => {
      fallbackController.abort();
    });
  } catch {
    fallbackController.abort();
  }
}

function waitForOrAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    return Promise.reject(new DOMException("请求已结束。", "AbortError"));
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => {
      signal.removeEventListener("abort", onAbort);
      reject(new DOMException("请求已结束。", "AbortError"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

async function waitBeforeRateLimitRetry(
  milliseconds: number,
  signal: AbortSignal | undefined,
  sourceId: string,
): Promise<void> {
  if (isSignalAborted(signal)) {
    throw cancelledRequest(sourceId);
  }
  if (signal === undefined) {
    await new Promise<void>((resolve) => {
      setTimeout(resolve, milliseconds);
    });
    return;
  }
  await new Promise<void>((resolve, reject) => {
    const onAbort = (): void => {
      clearTimeout(timeout);
      signal.removeEventListener("abort", onAbort);
      reject(cancelledRequest(sourceId));
    };
    const timeout = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, milliseconds);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function readCompletedResponseContent(payload: unknown): string {
  if (
    typeof payload !== "object" ||
    payload === null ||
    !("choices" in payload) ||
    !Array.isArray(payload.choices) ||
    payload.choices.length !== 1
  ) {
    throw invalidResponseFormat();
  }
  const first = payload.choices[0];
  if (
    typeof first !== "object" ||
    first === null ||
    !("finish_reason" in first) ||
    first.finish_reason !== "stop" ||
    !("message" in first) ||
    typeof first.message !== "object" ||
    first.message === null ||
    !("content" in first.message) ||
    typeof first.message.content !== "string" ||
    first.message.content.trim().length === 0
  ) {
    throw invalidResponseFormat();
  }
  return first.message.content;
}

function extractJsonObject(value: string): string {
  const firstBrace = value.indexOf("{");
  const lastBrace = value.lastIndexOf("}");
  if (firstBrace < 0 || lastBrace < firstBrace) {
    throw invalidResponseFormat();
  }
  return value.slice(firstBrace, lastBrace + 1);
}

const normalizationInstructions = [
  "你是算法竞赛题库历史资料整理助手。输入已经由人工确认对应关系，但你的输出仍然只是候选内容，不能直接导入。",
  "请只整理原文，不要补写原文没有的事实。若一个文件确实包含多道题，可拆成 problems 数组的多项；后续系统会要求人工分别确认。",
  "basicStatement 必须是完整可读的 Markdown 题面。缺少题解时，basicSolution 写“（迁移时缺题解，待补充）”。",
  "type 只能是 traditional、interactive 或 submit_answer。",
  "所有字符串都必须完整输出，不能为了缩短响应而截断。无法完整整理时应让请求失败，不要返回半段内容。",
  "只输出 JSON，不要输出代码围栏或说明文字。",
  "格式：",
  '{"problems":[{"title":"","type":"traditional","basicStatement":"","basicSolution":"","background":"","statement":"","inputFormat":"","outputFormat":"","constraints":"","solution":"","hints":"","samples":[{"input":"","output":"","explanation":""}],"tags":[],"confidence":0.5,"migrationNote":""}]}',
].join("\n");

function cancelledRequest(sourceId: string): HistoryMigrationError {
  return new HistoryMigrationError("NORMALIZATION_FAILED", `${sourceId} 的模型请求已明确取消。`);
}

function responseTooLarge(): HistoryMigrationError {
  return new HistoryMigrationError("NORMALIZATION_FAILED", "模型响应超过明确大小上限。");
}

function invalidResponseFormat(): HistoryMigrationError {
  return new HistoryMigrationError("NORMALIZATION_FAILED", "模型响应缺少完整候选内容。");
}

function interruptedResponse(): HistoryMigrationError {
  return new HistoryMigrationError("NORMALIZATION_FAILED", "模型响应在完成标记前结束。");
}

function positiveDuration(value: number): number {
  if (!Number.isSafeInteger(value) || value <= 0 || value > 24 * 60 * 60 * 1_000) {
    throw new HistoryMigrationError("INVALID_ARGUMENTS", "模型请求限制配置不正确。");
  }
  return value;
}

function positiveInteger(value: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || value <= 0 || value > maximum) {
    throw new HistoryMigrationError("INVALID_ARGUMENTS", "模型请求限制配置不正确。");
  }
  return value;
}

function ensureTrailingSlash(value: string): string {
  return value.endsWith("/") ? value : `${value}/`;
}

function isSignalAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted ?? false;
}

let proxyAwareDispatcher: EnvHttpProxyAgent | undefined;

async function defaultStreamingFetch(input: URL, init: RequestInit): Promise<Response> {
  proxyAwareDispatcher ??= new EnvHttpProxyAgent({
    // 超时由上面的首段输出和有效输出停顿看门狗负责；禁用 Undici 隐藏的 300 秒限制。
    headersTimeout: 0,
    bodyTimeout: 0,
  });
  const undiciInit = {
    ...init,
    dispatcher: proxyAwareDispatcher,
  } as unknown as Parameters<typeof undiciFetch>[1];
  return (await undiciFetch(input, undiciInit)) as unknown as Response;
}
