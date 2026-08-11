import { EnvHttpProxyAgent, fetch as undiciFetch } from "undici";
import { readFile } from "node:fs/promises";
import { dirname, extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type {
  HistoryNormalizer,
  HistoryNormalizerInput,
  HistoryPreparationExecutionIdentity,
} from "./core";
import { sha256Hex } from "./digests";
import {
  HistoryMigrationError,
  HistoryNormalizationError,
  type HistoryNormalizationFailureKind,
} from "./errors";
import { type NormalizedHistoryOutput, normalizedHistoryOutputSchema } from "./schema";

type HistoryNormalizerFetch = (input: URL, init: RequestInit) => Promise<Response>;

export interface LlmHistoryNormalizerOptions {
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly model: string;
  /** 由 loadHistoryPreparationCodeSha256 读取实际受信代码字节得到。 */
  readonly codeSha256: string;
  /** 等待第一段非空模型输出的时间。 */
  readonly firstOutputTimeoutMs?: number;
  /** 已经开始输出后，连续没有非空模型输出的等待时间。 */
  readonly outputIdleTimeoutMs?: number;
  /**
   * 首段有效输出前以及不可逆协议错误排空阶段的最终保护。正常生成一旦
   * 出现有效输出就清除此计时，不能把它当成生成总时限。
   */
  readonly maximumDurationMs?: number;
  /** 总尝试次数；只有服务端明确返回 429 时才会使用后续尝试。 */
  readonly maximumAttempts?: number;
  readonly retryBaseDelayMs?: number;
  readonly maximumResponseBytes?: number;
  /** 单次整理允许模型生成的最大 token 数，写入请求并绑定 prepare 执行身份。 */
  readonly maximumOutputTokens?: number;
  /** 人工停止任务或上层不再允许继续时，明确取消正在运行的请求。 */
  readonly signal?: AbortSignal;
  /** 只供合成测试或受控传输层使用。 */
  readonly fetch?: HistoryNormalizerFetch;
}

export const maximumNormalizationResponseBytes = 10_000_000;
export const maximumNormalizationOutputTokens = 65_536;
export const defaultNormalizationOutputTokens = maximumNormalizationOutputTokens;
export const historyNormalizationRequestProfileVersion =
  "history-normalization-request-v2" as const;
export const defaultNormalizationFirstOutputTimeoutMs = 30 * 60 * 1_000;
export const defaultNormalizationOutputIdleTimeoutMs = 10 * 60 * 1_000;
export const defaultNormalizationMaximumDurationMs = 4 * 60 * 60 * 1_000;
export interface IdentifiedHistoryNormalizer extends HistoryNormalizer {
  readonly preparationIdentity: HistoryPreparationExecutionIdentity;
}

interface NormalizationRuntime {
  readonly firstOutputTimeoutMs: number;
  readonly outputIdleTimeoutMs: number;
  readonly maximumDurationMs: number;
  readonly maximumAttempts: number;
  readonly retryBaseDelayMs: number;
  readonly maximumResponseBytes: number;
  readonly maximumOutputTokens: number;
  readonly signal: AbortSignal | undefined;
  readonly fetch: HistoryNormalizerFetch;
}

export function createLlmHistoryNormalizer(
  options: LlmHistoryNormalizerOptions,
): IdentifiedHistoryNormalizer {
  const endpoint = new URL("chat/completions", ensureTrailingSlash(options.baseUrl));
  const model = options.model.trim();
  if (options.apiKey.length === 0 || model.length === 0) {
    throw new HistoryMigrationError(
      "INVALID_ARGUMENTS",
      "模型地址、密钥和模型名称必须通过私有环境配置提供。",
    );
  }
  if (!/^[0-9a-f]{64}$/.test(options.codeSha256)) {
    throw new HistoryMigrationError("INVALID_ARGUMENTS", "历史 prepare 代码身份不正确。");
  }
  const runtime: NormalizationRuntime = {
    firstOutputTimeoutMs: positiveDuration(
      options.firstOutputTimeoutMs ?? defaultNormalizationFirstOutputTimeoutMs,
    ),
    outputIdleTimeoutMs: positiveDuration(
      options.outputIdleTimeoutMs ?? defaultNormalizationOutputIdleTimeoutMs,
    ),
    maximumDurationMs: positiveDuration(
      options.maximumDurationMs ?? defaultNormalizationMaximumDurationMs,
    ),
    maximumAttempts: positiveInteger(options.maximumAttempts ?? 3, 10),
    retryBaseDelayMs: positiveInteger(options.retryBaseDelayMs ?? 3_000, 60_000),
    maximumResponseBytes: positiveInteger(
      options.maximumResponseBytes ?? maximumNormalizationResponseBytes,
      maximumNormalizationResponseBytes,
    ),
    maximumOutputTokens: positiveInteger(
      options.maximumOutputTokens ?? defaultNormalizationOutputTokens,
      maximumNormalizationOutputTokens,
    ),
    signal: options.signal,
    fetch: options.fetch ?? defaultStreamingFetch,
  };

  return {
    preparationIdentity: {
      version: 1,
      codeSha256: options.codeSha256,
      promptSha256: sha256Hex(normalizationInstructions),
      modelSha256: sha256Hex(model),
      configSha256: sha256Hex(
        JSON.stringify({
          endpointSha256: sha256Hex(endpoint.toString()),
          firstOutputTimeoutMs: runtime.firstOutputTimeoutMs,
          outputIdleTimeoutMs: runtime.outputIdleTimeoutMs,
          maximumDurationMs: runtime.maximumDurationMs,
          maximumAttempts: runtime.maximumAttempts,
          retryBaseDelayMs: runtime.retryBaseDelayMs,
          maximumResponseBytes: runtime.maximumResponseBytes,
          requestProfile: normalizationRequestProfile(runtime.maximumOutputTokens),
          streamingProtocol: "sse-eof-benign-controls-v2",
          retryPolicy: "http-429-only",
        }),
      ),
    },
    async normalize(input: HistoryNormalizerInput): Promise<NormalizedHistoryOutput> {
      const response = await requestNormalization(
        endpoint,
        options.apiKey,
        model,
        input,
        runtime,
      );
      const parsed = normalizedHistoryOutputSchema.safeParse(response);
      if (!parsed.success) {
        throw normalizationFailure("schema", `${input.sourceId} 的模型结果不符合候选内容格式。`);
      }
      return parsed.data;
    },
  };
}

export async function loadHistoryPreparationCodeSha256(): Promise<string> {
  const currentPath = fileURLToPath(import.meta.url);
  const extension = extname(currentPath);
  const directory = dirname(currentPath);
  const names = ["core", "digests", "errors", "llm-normalizer", "private-files", "schema"] as const;
  const files = await Promise.all(
    names.map(async (name) => ({
      name,
      sha256: sha256Hex(await readFile(join(directory, `${name}${extension}`))),
    })),
  );
  return sha256Hex(JSON.stringify({ version: 1, files }));
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
      attempt,
      runtime,
    );
    if (attemptResult.kind === "content") {
      try {
        return JSON.parse(attemptResult.content.trim()) as unknown;
      } catch {
        throw normalizationFailure(
          "invalid_json",
          `${input.sourceId} 的模型响应不包含有效候选 JSON。`,
        );
      }
    }
    if (attempt === runtime.maximumAttempts) {
      throw normalizationFailure("http_429", `${input.sourceId} 的模型服务持续返回 HTTP 429。`);
    }
    await waitBeforeRateLimitRetry(
      runtime.retryBaseDelayMs * attempt,
      runtime.signal,
      input.sourceId,
    );
  }
  throw normalizationFailure("internal", `${input.sourceId} 的模型请求失败。`);
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
  attempt: number,
  runtime: NormalizationRuntime,
): Promise<NormalizationAttemptResult> {
  if (isSignalAborted(runtime.signal)) {
    throw cancelledRequest(sourceId);
  }
  await input.beforeRequest?.(attempt);

  const controller = new AbortController();
  const watchdog = new NormalizationOutputWatchdog(
    controller,
    runtime.firstOutputTimeoutMs,
    runtime.outputIdleTimeoutMs,
    runtime.maximumDurationMs,
  );
  const cancelFromParent = (): void => {
    controller.abort();
  };
  runtime.signal?.addEventListener("abort", cancelFromParent, { once: true });
  let responseReceived = false;

  try {
    const requestProfile = normalizationRequestProfile(runtime.maximumOutputTokens);
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
          ...requestProfile.parameters,
          messages: [
            {
              role: requestProfile.messageLayout.systemRole,
              content: normalizationInstructions,
            },
            {
              role: requestProfile.messageLayout.userRole,
              content: [requestProfile.messageLayout.userPrefix, input.text].join("\n"),
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
      throw normalizationFailure(
        response.status === 499 ? "http_499" : "http_status",
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
      throw normalizationFailure(
        "first_output_timeout",
        `${sourceId} 的模型请求在首段有效输出前超时。`,
      );
    }
    if (timeoutKind === "output_idle") {
      throw normalizationFailure("output_idle_timeout", `${sourceId} 的模型输出长时间没有继续。`);
    }
    if (timeoutKind === "maximum_duration") {
      throw normalizationFailure(
        "maximum_duration_timeout",
        `${sourceId} 的模型请求超过最终保护时长。`,
      );
    }
    if (isSignalAborted(runtime.signal)) {
      throw cancelledRequest(sourceId);
    }
    if (error instanceof HistoryMigrationError) {
      throw error;
    }
    throw normalizationFailure(
      responseReceived ? "eof_incomplete" : "connection",
      responseReceived
        ? `${sourceId} 的模型响应在完整结束前中断。`
        : `${sourceId} 的模型连接失败。`,
    );
  } finally {
    runtime.signal?.removeEventListener("abort", cancelFromParent);
    watchdog.close();
  }
}

type NormalizationTimeoutKind = "first_output" | "output_idle" | "maximum_duration";

class NormalizationOutputWatchdog {
  readonly #controller: AbortController;
  readonly #outputIdleTimeoutMs: number;
  readonly #maximumDurationMs: number;
  #firstOutputTimer: ReturnType<typeof setTimeout> | null;
  #outputIdleTimer: ReturnType<typeof setTimeout> | null = null;
  #maximumDurationTimer: ReturnType<typeof setTimeout> | null;
  #timeoutKind: NormalizationTimeoutKind | null = null;
  #receivedValidOutput = false;
  #drainingInvalidResponse = false;

  public constructor(
    controller: AbortController,
    firstOutputTimeoutMs: number,
    outputIdleTimeoutMs: number,
    maximumDurationMs: number,
  ) {
    this.#controller = controller;
    this.#outputIdleTimeoutMs = outputIdleTimeoutMs;
    this.#maximumDurationMs = maximumDurationMs;
    this.#firstOutputTimer = setTimeout(() => {
      this.#abort("first_output");
    }, firstOutputTimeoutMs);
    this.#maximumDurationTimer = setTimeout(() => {
      this.#abort("maximum_duration");
    }, maximumDurationMs);
  }

  public receivedValidOutput(): void {
    if (this.#timeoutKind !== null) return;
    if (!this.#receivedValidOutput) {
      this.#receivedValidOutput = true;
      if (this.#firstOutputTimer !== null) {
        clearTimeout(this.#firstOutputTimer);
        this.#firstOutputTimer = null;
      }
      // 四小时是首段前的最终保护，不是正常持续生成的总时限。
      if (this.#maximumDurationTimer !== null) {
        clearTimeout(this.#maximumDurationTimer);
        this.#maximumDurationTimer = null;
      }
    }
    this.#resetOutputIdleTimer();
  }

  public invalidResponseDrainStarted(): void {
    if (this.#timeoutKind !== null || this.#drainingInvalidResponse) return;
    this.#drainingInvalidResponse = true;
    if (this.#firstOutputTimer !== null) {
      clearTimeout(this.#firstOutputTimer);
      this.#firstOutputTimer = null;
    }
    // 协议首错后只排空，不再生成候选；从排空开始重新建立四小时最终边界。
    if (this.#maximumDurationTimer !== null) {
      clearTimeout(this.#maximumDurationTimer);
    }
    this.#maximumDurationTimer = setTimeout(() => {
      this.#abort("maximum_duration");
    }, this.#maximumDurationMs);
    this.receivedInvalidResponseDrainActivity();
  }

  public receivedInvalidResponseDrainActivity(): void {
    if (this.#timeoutKind !== null || !this.#drainingInvalidResponse) return;
    this.#resetOutputIdleTimer();
  }

  #resetOutputIdleTimer(): void {
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
    if (this.#maximumDurationTimer !== null) {
      clearTimeout(this.#maximumDurationTimer);
      this.#maximumDurationTimer = null;
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
    throw normalizationFailure("protocol", "模型响应不是完整的 JSON。");
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
    throw normalizationFailure("invalid_utf8", "模型响应不是有效的 UTF-8 文本。");
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
  let firstProtocolError: HistoryNormalizationError | undefined;

  try {
    for (;;) {
      const chunk = await waitForOrAbort(reader.read(), requestController.signal);
      if (chunk.done) {
        readerFinished = true;
        if (firstProtocolError !== undefined) {
          throw firstProtocolError;
        }
        try {
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
        } catch (error) {
          if (!isDrainableNormalizationProtocolError(error)) throw error;
          state.content = "";
          throw error;
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
      if (firstProtocolError !== undefined) {
        watchdog.receivedInvalidResponseDrainActivity();
        continue;
      }
      try {
        ({ pending, trailingCarriageReturn } = appendEventStreamText(
          pending,
          trailingCarriageReturn,
          decodeEventStreamText(decoder, chunk.value),
          false,
        ));
        pending = consumeCompleteEvents(pending, state, watchdog);
      } catch (error) {
        if (!isDrainableNormalizationProtocolError(error)) throw error;
        firstProtocolError = error;
        state.content = "";
        pending = "";
        watchdog.invalidResponseDrainStarted();
      }
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

function isDrainableNormalizationProtocolError(
  error: unknown,
): error is HistoryNormalizationError {
  return (
    error instanceof HistoryNormalizationError &&
    (error.failureKind === "protocol" || error.failureKind === "invalid_utf8")
  );
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
  const dataFields = event
    .split("\n")
    .flatMap((line) =>
      line === "data"
        ? [""]
        : line.startsWith("data:")
          ? [line.slice("data:".length).trimStart()]
          : [],
    );
  if (dataFields.length === 0) return;
  const data = dataFields.join("\n").trim();
  if (data.length === 0) return;
  if (state.sawDone) {
    if (data === "[DONE]") return;
    if (isStrictStreamUsageMetadata(parseCompletionEventData(data))) return;
    throw invalidResponseFormat();
  }
  if (data === "[DONE]") {
    state.sawDone = true;
    return;
  }

  const raw = parseCompletionEventData(data);
  if (!isPlainJsonRecord(raw)) {
    throw invalidResponseFormat();
  }
  const record = raw;
  if (Object.hasOwn(record, "error")) {
    throw invalidResponseFormat();
  }
  if (isStrictStreamUsageMetadata(record)) {
    return;
  }
  if (!Array.isArray(record.choices)) {
    throw invalidResponseFormat();
  }
  if (record.choices.length === 0) {
    // 空 choices 只有通过上面的封闭元数据校验才可忽略。
    throw invalidResponseFormat();
  }
  if (record.choices.length !== 1) {
    throw invalidResponseFormat();
  }
  if (state.sawStop) {
    // 兼容在 stop 事件之后再发送 usage 的网关：唯一 choice 只能是
    // 空 delta，不允许携带内容、reasoning 或 finish_reason。
    if (isPostStopStreamUsageRecord(record)) return;
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

const streamUsageMetadataKeys = new Set([
  "choices",
  "usage",
  "id",
  "object",
  "created",
  "model",
  "system_fingerprint",
  "service_tier",
]);
const maximumStreamUsageNodes = 256;
const maximumStreamUsageDepth = 4;
const maximumStreamUsageKeys = 64;
const maximumStreamMetadataStringLength = 1_024;

function parseCompletionEventData(data: string): unknown {
  try {
    return JSON.parse(data) as unknown;
  } catch {
    throw invalidResponseFormat();
  }
}

function isPlainJsonRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value) as unknown;
  return prototype === Object.prototype || prototype === null;
}

function isStrictStreamUsageMetadata(raw: unknown): boolean {
  if (!isPlainJsonRecord(raw)) return false;
  const entries = Object.entries(raw);
  if (
    entries.length === 0 ||
    entries.some(([key]) => !streamUsageMetadataKeys.has(key))
  ) {
    return false;
  }
  if (
    Object.hasOwn(raw, "choices") &&
    (!Array.isArray(raw.choices) || raw.choices.length !== 0)
  ) {
    return false;
  }
  if (
    Object.hasOwn(raw, "usage") &&
    !isBoundedStreamUsageCounterStructure(raw.usage)
  ) {
    return false;
  }
  const hasControlEvidence =
    (Object.hasOwn(raw, "choices") &&
      Array.isArray(raw.choices) &&
      raw.choices.length === 0) ||
    Object.hasOwn(raw, "usage");
  if (!hasControlEvidence) return false;

  for (const key of ["id", "object", "model"] as const) {
    if (Object.hasOwn(raw, key) && !isBoundedStreamMetadataString(raw[key])) {
      return false;
    }
  }

  for (const key of ["system_fingerprint", "service_tier"] as const) {
    if (
      Object.hasOwn(raw, key) &&
      !isBoundedStreamMetadataString(raw[key], true)
    ) {
      return false;
    }
  }
  if (
    Object.hasOwn(raw, "created") &&
    (typeof raw.created !== "number" ||
      !Number.isSafeInteger(raw.created) ||
      raw.created < 0)
  ) {
    return false;
  }
  return true;
}

function isBoundedStreamUsageCounter(value: unknown): boolean {
  return isBoundedStreamUsageCounterStructure(value);
}

function isPostStopStreamUsageRecord(record: Record<string, unknown>): boolean {
  if (!Object.hasOwn(record, "usage")) return false;
  if (!isBoundedStreamUsageCounter(record.usage)) return false;
  // Reject any top-level key outside the provider-compatible envelope.  This
  // prevents reasoning/content/arbitrary values from piggy-backing on a
  // valid usage record and bypassing the bounded-metadata limits below.
  for (const key of Object.keys(record)) {
    if (!streamUsageMetadataKeys.has(key)) return false;
  }
  // Bound the metadata string/integer fields exactly as the strict path does.
  for (const key of ["id", "object", "model"] as const) {
    if (Object.hasOwn(record, key) && !isBoundedStreamMetadataString(record[key])) {
      return false;
    }
  }
  for (const key of ["system_fingerprint", "service_tier"] as const) {
    if (
      Object.hasOwn(record, key) &&
      !isBoundedStreamMetadataString(record[key], true)
    ) {
      return false;
    }
  }
  if (
    Object.hasOwn(record, "created") &&
    (typeof record.created !== "number" ||
      !Number.isSafeInteger(record.created) ||
      record.created < 0)
  ) {
    return false;
  }
  const only = (record.choices as unknown[])[0];
  if (!isPlainJsonRecord(only)) return false;
  for (const key of Object.keys(only)) {
    if (key !== "index" && key !== "delta" && key !== "logprobs") return false;
  }
  if (Object.hasOwn(only, "index") && only.index !== 0) return false;
  if (Object.hasOwn(only, "logprobs") && only.logprobs !== null) return false;
  if (!Object.hasOwn(only, "delta") || !isPlainJsonRecord(only.delta)) {
    return false;
  }
  return Object.keys(only.delta).length === 0;
}

function isBoundedStreamMetadataString(value: unknown, nullable = false): boolean {
  return (
    (nullable && value === null) ||
    (typeof value === "string" &&
      value.length <= maximumStreamMetadataStringLength &&
      value.trim().length > 0 &&
      !/[\u0000-\u001f\u007f]/u.test(value))
  );
}

function isBoundedStreamUsageCounterStructure(value: unknown): boolean {
  if (!isPlainJsonRecord(value)) return false;
  const result = scanBoundedStreamUsageCounter(value, 0, {
    remaining: maximumStreamUsageNodes,
  });
  return result.valid && result.hasNumericCounter;
}

function scanBoundedStreamUsageCounter(
  value: unknown,
  depth: number,
  budget: { remaining: number },
): { readonly valid: boolean; readonly hasNumericCounter: boolean } {
  if (typeof value === "number") {
    const valid = Number.isSafeInteger(value) && value >= 0;
    return { valid, hasNumericCounter: valid };
  }
  if (!isPlainJsonRecord(value) || depth >= maximumStreamUsageDepth) {
    return { valid: false, hasNumericCounter: false };
  }
  const entries = Object.entries(value);
  if (entries.length === 0 || entries.length > maximumStreamUsageKeys) {
    return { valid: false, hasNumericCounter: false };
  }
  let hasNumericCounter = false;
  for (const [key, child] of entries) {
    budget.remaining -= 1;
    if (budget.remaining < 0 || !/^[A-Za-z0-9_]{1,64}$/u.test(key)) {
      return { valid: false, hasNumericCounter: false };
    }
    if (child === null) continue;
    const childResult = scanBoundedStreamUsageCounter(child, depth + 1, budget);
    if (!childResult.valid) {
      return { valid: false, hasNumericCounter: false };
    }
    hasNumericCounter ||= childResult.hasNumericCounter;
  }
  return { valid: true, hasNumericCounter };
}

function decodeEventStreamText(decoder: TextDecoder, bytes?: Uint8Array): string {
  try {
    return bytes === undefined ? decoder.decode() : decoder.decode(bytes, { stream: true });
  } catch {
    throw normalizationFailure("invalid_utf8", "模型响应不是有效的 UTF-8 文本。");
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

/**
 * 公共域对"原文没有题解"的权威缺失表示：结构性的 null。规范化指令要求模型
 * 在原文缺题解时把 basicSolution 写成 null（而非任何占位字符串）、solution 留空，
 * 并在 migrationNote 如实记录。本地修复同样写入 null，候选 → 打包 → 导入全程
 * 按原文含义保持结构性缺失，缺失在幂等重放后依然保持缺失。
 */

const normalizationInstructions = [
  "你是算法竞赛题库历史资料整理助手。输入材料已经过人工分组，但你的结果仍只是待人工批准的候选，不能直接导入。",
  "请按以下步骤整理，并且只依据本次给出的原始文本：",
  "1. 先辨认材料中实际包含几道题。一份源含多道题时必须逐题拆成 problems 数组的独立项目；不要把多题合并，也不要凭题名、编号或顺序补出材料中没有的题。",
  "2. 题面和题解是核心。逐题提取明确出现的题意、输入、输出、约束、样例和题解；不得臆造规则、数据范围、样例、算法、结论或缺失段落。材料不明确时保留空字段，并在 migrationNote 简短说明不确定项。",
  "3. basicStatement 写成完整、可读且自洽的 Markdown 核心题面；background、statement、inputFormat、outputFormat、constraints、hints 和 samples 只放各自对应且原文确有的内容。不要把同一整段题面原样复制到 basicStatement 与任一拆分字段，也不要在多个拆分字段间重复整段正文。",
  `4. basicSolution 写原文已有的完整核心题解；solution 只放原文中可明确区分的补充题解内容，不能与 basicSolution 重复整段。原文没有题解时，basicSolution 必须写成 null（不得写任何占位或提示文字），solution 留空，并在 migrationNote 如实记录缺失。`,
  "5. title 只取材料中明确的题名；type 只能是 traditional、interactive 或 submit_answer。只有材料明确要求交互或提交答案时才使用后两种，否则使用 traditional。",
  "6. samples 只登记材料中明确成对出现的输入、输出及解释；不要把正文代码块猜成样例。保留原有公式、代码和 Markdown 含义，不要擅自改题或润色成不同规则。",
  "7. tags 必须始终是空数组 []。不要选择或创造知识点标签，不要读取、采信或推断投题者自报难度，也不要输出任何难度字段。",
  "8. confidence 只表示本次整理对材料边界和字段归属的把握，不表示题目质量、难度或审核结论。",
  "9. 完成后在内部逐项核对题目数量、题面题解证据、缺失项、整段重复、tags 为空以及下方结构；不要输出核对过程、推理、评论或 Markdown 代码围栏。",
  "最终响应必须是且只能是一个严格符合下方结构的 JSON object。JSON 前后不得出现说明、寒暄、reasoning、commentary、代码围栏或其他非空字节。不得增加结构之外的字段。",
  "所有字符串都必须完整输出，不能为了缩短响应而截断。无法完整整理时应让请求失败，不要返回半段内容。",
  "唯一允许的结构：",
  '{"problems":[{"title":"","type":"traditional","basicStatement":"","basicSolution":"","background":"","statement":"","inputFormat":"","outputFormat":"","constraints":"","solution":"","hints":"","samples":[{"input":"","output":"","explanation":""}],"tags":[],"confidence":0.5,"migrationNote":""}]}',
].join("\n");

function normalizationRequestProfile(maximumOutputTokens: number): {
  readonly version: typeof historyNormalizationRequestProfileVersion;
  readonly parameters: {
    readonly temperature: 0.1;
    readonly max_tokens: number;
    readonly thinking: { readonly type: "disabled" };
    readonly response_format: { readonly type: "json_object" };
    readonly stream: true;
  };
  readonly messageLayout: {
    readonly systemRole: "system";
    readonly userRole: "user";
    readonly userPrefix: "原始文本：";
  };
} {
  return {
    version: historyNormalizationRequestProfileVersion,
    parameters: {
      temperature: 0.1,
      max_tokens: maximumOutputTokens,
      thinking: { type: "disabled" },
      response_format: { type: "json_object" },
      stream: true,
    },
    messageLayout: {
      systemRole: "system",
      userRole: "user",
      userPrefix: "原始文本：",
    },
  };
}

function cancelledRequest(sourceId: string): HistoryMigrationError {
  return normalizationFailure("cancelled", `${sourceId} 的模型请求已明确取消。`);
}

function responseTooLarge(): HistoryMigrationError {
  return normalizationFailure("response_too_large", "模型响应超过明确大小上限。");
}

function invalidResponseFormat(): HistoryMigrationError {
  return normalizationFailure("protocol", "模型响应缺少完整候选内容。");
}

function interruptedResponse(): HistoryMigrationError {
  return normalizationFailure("eof_incomplete", "模型响应在完成标记前结束。");
}

function normalizationFailure(
  kind: HistoryNormalizationFailureKind,
  message: string,
): HistoryNormalizationError {
  return new HistoryNormalizationError(kind, message);
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
