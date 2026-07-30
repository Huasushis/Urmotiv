import type { Hash } from "node:crypto";
import { z } from "zod";
import type { StageFileInput, StorageLimits } from "./types";
import { StorageError } from "./types";

const fileNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(500)
  .refine((name) => name !== "." && name !== "..")
  .refine((name) => !name.includes("/") && !name.includes("\\"))
  .refine((name) => !/[\u0000-\u001f\u007f]/.test(name));

const mediaTypeSchema = z
  .string()
  .trim()
  .toLowerCase()
  .max(255)
  .regex(/^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/);

export interface NormalizedFileMetadata {
  readonly originalName: string;
  readonly mediaType: string;
}

export interface StreamInspection {
  byteSize: number;
}

export function resolveStorageLimits(limits: StorageLimits): StorageLimits {
  if (!Number.isSafeInteger(limits.maxBytes) || limits.maxBytes <= 0) {
    throw new StorageError("INVALID_STORAGE_LIMIT", "单个文件大小限制必须是正整数。");
  }

  const allowedMediaTypes = limits.allowedMediaTypes?.map((mediaType) => {
    const result = mediaTypeSchema.safeParse(mediaType);
    if (!result.success) {
      throw new StorageError("INVALID_STORAGE_LIMIT", "允许的文件类型中包含无效值。");
    }
    return result.data;
  });

  return {
    maxBytes: limits.maxBytes,
    ...(allowedMediaTypes === undefined
      ? {}
      : { allowedMediaTypes: [...new Set(allowedMediaTypes)] })
  };
}

export function validateFileMetadata(
  input: Pick<StageFileInput, "originalName" | "mediaType">,
  limits: StorageLimits
): NormalizedFileMetadata {
  const originalName = fileNameSchema.safeParse(input.originalName);
  if (!originalName.success) {
    throw new StorageError(
      "INVALID_FILE_NAME",
      "文件名只能用于显示，且不能包含路径、控制字符或空值。"
    );
  }

  const mediaType = mediaTypeSchema.safeParse(input.mediaType);
  if (!mediaType.success) {
    throw new StorageError("INVALID_MEDIA_TYPE", "文件类型格式不正确。");
  }
  if (
    limits.allowedMediaTypes !== undefined &&
    !limits.allowedMediaTypes.includes(mediaType.data)
  ) {
    throw new StorageError("INVALID_MEDIA_TYPE", "该文件类型不在允许范围内。");
  }

  return { originalName: originalName.data, mediaType: mediaType.data };
}

export async function* inspectContent(
  source: AsyncIterable<Uint8Array>,
  maxBytes: number,
  hash: Hash,
  inspection: StreamInspection
): AsyncGenerator<Uint8Array> {
  if (
    typeof source !== "object" ||
    source === null ||
    typeof source[Symbol.asyncIterator] !== "function"
  ) {
    throw new StorageError("INVALID_STREAM", "文件内容必须以数据流方式提供。");
  }

  for await (const value of source as AsyncIterable<unknown>) {
    if (!(value instanceof Uint8Array)) {
      throw new StorageError("INVALID_STREAM", "文件数据流中包含无效内容。");
    }
    if (inspection.byteSize + value.byteLength > maxBytes) {
      throw new StorageError("FILE_TOO_LARGE", "文件大小超过限制。");
    }

    inspection.byteSize += value.byteLength;
    hash.update(value);
    yield value;
  }
}
