import { createHash } from "node:crypto";
import type { EnqueueJob, JobRecord, JsonValue } from "./types";

export function createJobRecord(input: EnqueueJob, now: Date): JobRecord {
  const timestamp = now.toISOString();
  return {
    id: input.jobId,
    type: input.type,
    payload: structuredClone(input.payload),
    idempotencyScope: input.idempotencyScope,
    idempotencyKey: input.idempotencyKey,
    requestDigest: digestJobRequest(input),
    state: "queued",
    progressPercent: 0,
    itemReports: [],
    attempt: 0,
    maxAttempts: input.maxAttempts,
    timeoutMs: input.timeoutMs,
    availableAt: timestamp,
    lease: null,
    failure: null,
    result: null,
    createdAt: timestamp,
    updatedAt: timestamp,
    startedAt: null,
    finishedAt: null
  };
}

export function digestJobRequest(input: EnqueueJob): string {
  return createHash("sha256")
    .update(
      canonicalJson({
        type: input.type,
        payload: input.payload,
        maxAttempts: input.maxAttempts,
        timeoutMs: input.timeoutMs
      })
    )
    .digest("hex");
}

export function idempotencyIndexKey(scope: string, key: string): string {
  return createHash("sha256").update(`${scope}\u0000${key}`).digest("hex");
}

function canonicalJson(value: JsonValue): string {
  if (value === null || typeof value !== "object") {
    return encodeJson(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }

  const entries = Object.entries(value).sort(([left], [right]) =>
    left < right ? -1 : left > right ? 1 : 0
  );
  return `{${entries
    .map(([key, child]) => `${encodeJson(key)}:${canonicalJson(child)}`)
    .join(",")}}`;
}

export function encodeJson(value: unknown): string {
  const encoded = JSON.stringify(value);
  if (encoded === undefined) {
    throw new TypeError("任务数据不能编码为 JSON。");
  }
  return encoded;
}
