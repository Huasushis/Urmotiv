import { HistoryMigrationError } from "./errors";
import {
  normalizedHistoryOutputSchema,
  type NormalizedHistoryOutput
} from "./schema";
import type {
  HistoryNormalizer,
  HistoryNormalizerInput
} from "./core";

export interface LlmHistoryNormalizerOptions {
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly model: string;
  readonly requestTimeoutMs?: number;
  readonly maximumAttempts?: number;
  readonly maximumResponseBytes?: number;
}

export const maximumNormalizationResponseBytes = 10_000_000;

export function createLlmHistoryNormalizer(
  options: LlmHistoryNormalizerOptions
): HistoryNormalizer {
  const endpoint = new URL("chat/completions", ensureTrailingSlash(options.baseUrl));
  if (options.apiKey.length === 0 || options.model.trim().length === 0) {
    throw new HistoryMigrationError(
      "INVALID_ARGUMENTS",
      "模型地址、密钥和模型名称必须通过私有环境配置提供。"
    );
  }
  const requestTimeoutMs = options.requestTimeoutMs ?? 600_000;
  const maximumAttempts = options.maximumAttempts ?? 3;
  const maximumResponseBytes =
    options.maximumResponseBytes ?? maximumNormalizationResponseBytes;
  if (
    !Number.isSafeInteger(requestTimeoutMs) ||
    requestTimeoutMs <= 0 ||
    !Number.isSafeInteger(maximumAttempts) ||
    maximumAttempts <= 0 ||
    maximumAttempts > 10 ||
    !Number.isSafeInteger(maximumResponseBytes) ||
    maximumResponseBytes <= 0 ||
    maximumResponseBytes > maximumNormalizationResponseBytes
  ) {
    throw new HistoryMigrationError("INVALID_ARGUMENTS", "模型请求限制配置不正确。");
  }

  return {
    async normalize(input: HistoryNormalizerInput): Promise<NormalizedHistoryOutput> {
      const response = await requestNormalization(
        endpoint,
        options.apiKey,
        options.model,
        input,
        requestTimeoutMs,
        maximumAttempts,
        maximumResponseBytes
      );
      const parsed = normalizedHistoryOutputSchema.safeParse(response);
      if (!parsed.success) {
        throw new HistoryMigrationError(
          "NORMALIZATION_FAILED",
          `${input.sourceId} 的模型结果不符合候选内容格式。`
        );
      }
      return parsed.data;
    }
  };
}

async function requestNormalization(
  endpoint: URL,
  apiKey: string,
  model: string,
  input: HistoryNormalizerInput,
  requestTimeoutMs: number,
  maximumAttempts: number,
  maximumResponseBytes: number
): Promise<unknown> {
  let responseText: string | undefined;
  for (let attempt = 1; attempt <= maximumAttempts; attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), requestTimeoutMs);
    try {
      const response = await fetch(endpoint, {
        method: "POST",
        signal: controller.signal,
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`
        },
        body: JSON.stringify({
          model,
          temperature: 0.1,
          stream: false,
          messages: [
            { role: "system", content: normalizationInstructions },
            {
              role: "user",
              content: [
                `已由人工确认的参考题名：${input.expectedTitle}`,
                `已由人工确认的 CF 难度参考：${input.difficultyGuess ?? "未知"}`,
                "",
                "原始文本：",
                input.text
              ].join("\n")
            }
          ]
        })
      });
      if (response.ok) {
        responseText = await readBoundedResponseText(
          response,
          controller.signal,
          maximumResponseBytes
        );
      } else {
        void response.body?.cancel().catch(() => undefined);
      }
    } catch (error) {
      if (error instanceof HistoryMigrationError) {
        throw error;
      }
    } finally {
      clearTimeout(timeout);
    }
    if (responseText !== undefined) {
      break;
    }
    if (attempt < maximumAttempts) {
      await wait(attempt * 3_000);
    }
  }
  if (responseText === undefined) {
    throw new HistoryMigrationError(
      "NORMALIZATION_FAILED",
      `${input.sourceId} 的模型请求失败。`
    );
  }

  let payload: unknown;
  try {
    payload = JSON.parse(responseText);
  } catch {
    throw new HistoryMigrationError(
      "NORMALIZATION_FAILED",
      `${input.sourceId} 的模型响应不是 JSON。`
    );
  }
  const content = readResponseContent(payload);
  try {
    return JSON.parse(extractJsonObject(content));
  } catch {
    throw new HistoryMigrationError(
      "NORMALIZATION_FAILED",
      `${input.sourceId} 的模型响应不包含有效候选 JSON。`
    );
  }
}

async function readBoundedResponseText(
  response: Response,
  signal: AbortSignal,
  maximumBytes: number
): Promise<string> {
  const declaredLength = response.headers.get("content-length");
  if (
    declaredLength !== null &&
    /^[0-9]+$/.test(declaredLength) &&
    Number(declaredLength) > maximumBytes
  ) {
    void response.body?.cancel().catch(() => undefined);
    throw new HistoryMigrationError(
      "NORMALIZATION_FAILED",
      "模型响应超过明确大小上限。"
    );
  }
  if (response.body === null) {
    return "";
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  try {
    while (true) {
      const chunk = await readResponseChunk(reader, signal);
      if (chunk.done) {
        break;
      }
      totalBytes += chunk.value.byteLength;
      if (totalBytes > maximumBytes) {
        throw new HistoryMigrationError(
          "NORMALIZATION_FAILED",
          "模型响应超过明确大小上限。"
        );
      }
      chunks.push(chunk.value);
    }
  } catch (error) {
    void reader.cancel().catch(() => undefined);
    throw error;
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // 中止请求时，底层读取可能尚未完成；放弃该响应即可。
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
    throw new HistoryMigrationError(
      "NORMALIZATION_FAILED",
      "模型响应不是有效的 UTF-8 文本。"
    );
  }
}

function readResponseChunk(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  signal: AbortSignal
): Promise<ReadableStreamReadResult<Uint8Array>> {
  return new Promise((resolve, reject) => {
    const onAbort = (): void => {
      signal.removeEventListener("abort", onAbort);
      reject(new Error("response body timeout"));
    };
    if (signal.aborted) {
      onAbort();
      return;
    }
    signal.addEventListener("abort", onAbort, { once: true });
    reader.read().then(
      (result) => {
        signal.removeEventListener("abort", onAbort);
        resolve(result);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      }
    );
  });
}

const normalizationInstructions = [
  "你是算法竞赛题库历史资料整理助手。输入已经由人工确认对应关系，但你的输出仍然只是候选内容，不能直接导入。",
  "请只整理原文，不要补写原文没有的事实。若一个文件确实包含多道题，可拆成 problems 数组的多项；后续系统会要求人工分别确认。",
  "basicStatement 必须是完整可读的 Markdown 题面。缺少题解时，basicSolution 写“（迁移时缺题解，待补充）”。",
  "type 只能是 traditional、interactive 或 submit_answer。",
  "所有字符串都必须完整输出，不能为了缩短响应而截断。无法完整整理时应让请求失败，不要返回半段内容。",
  "只输出 JSON，不要输出代码围栏或说明文字。",
  "格式：",
  '{"problems":[{"title":"","type":"traditional","basicStatement":"","basicSolution":"","background":"","statement":"","inputFormat":"","outputFormat":"","constraints":"","solution":"","hints":"","samples":[{"input":"","output":"","explanation":""}],"tags":[],"confidence":0.5,"migrationNote":""}]}'
].join("\n");

function readResponseContent(payload: unknown): string {
  if (
    typeof payload !== "object" ||
    payload === null ||
    !("choices" in payload) ||
    !Array.isArray(payload.choices)
  ) {
    throw new HistoryMigrationError("NORMALIZATION_FAILED", "模型响应缺少候选内容。");
  }
  const first = payload.choices[0];
  if (
    typeof first !== "object" ||
    first === null ||
    !("message" in first) ||
    typeof first.message !== "object" ||
    first.message === null ||
    !("content" in first.message) ||
    typeof first.message.content !== "string"
  ) {
    throw new HistoryMigrationError("NORMALIZATION_FAILED", "模型响应缺少候选内容。");
  }
  return first.message.content;
}

function extractJsonObject(value: string): string {
  const firstBrace = value.indexOf("{");
  const lastBrace = value.lastIndexOf("}");
  if (firstBrace < 0 || lastBrace < firstBrace) {
    throw new HistoryMigrationError("NORMALIZATION_FAILED", "模型响应缺少候选内容。");
  }
  return value.slice(firstBrace, lastBrace + 1);
}

function ensureTrailingSlash(value: string): string {
  return value.endsWith("/") ? value : `${value}/`;
}

async function wait(milliseconds: number): Promise<void> {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}
