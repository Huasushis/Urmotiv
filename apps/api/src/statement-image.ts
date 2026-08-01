import { StorageError } from "@urmotiv/storage";

interface StatementImageSignature {
  readonly mediaType: string;
  readonly extensions: readonly string[];
  readonly prefixLength: number;
  readonly matches: (prefix: Uint8Array) => boolean;
}

export interface PreparedStatementImage {
  readonly content: AsyncIterable<Uint8Array>;
  readonly close: () => Promise<void>;
}

export class InvalidStatementImageError extends Error {
  public constructor() {
    super("题面图片格式无效。");
    this.name = "InvalidStatementImageError";
  }
}

export class StatementImageReadError extends Error {
  public constructor() {
    super("读取题面图片失败。");
    this.name = "StatementImageReadError";
  }
}

const maximumConsecutiveEmptyChunks = 1024;

const signatures: readonly StatementImageSignature[] = [
  {
    mediaType: "image/png",
    extensions: ["png"],
    prefixLength: 8,
    matches: (prefix) =>
      matchesBytes(prefix, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  },
  {
    mediaType: "image/jpeg",
    extensions: ["jpg", "jpeg"],
    prefixLength: 3,
    matches: (prefix) => matchesBytes(prefix, [0xff, 0xd8, 0xff])
  },
  {
    mediaType: "image/gif",
    extensions: ["gif"],
    prefixLength: 6,
    matches: (prefix) =>
      matchesAscii(prefix, "GIF87a", 0) || matchesAscii(prefix, "GIF89a", 0)
  },
  {
    mediaType: "image/webp",
    extensions: ["webp"],
    prefixLength: 12,
    matches: (prefix) => matchesAscii(prefix, "RIFF", 0) && matchesAscii(prefix, "WEBP", 8)
  }
];

export function assertStatementImageBytes(
  mediaType: string,
  fileName: string,
  content: Uint8Array
): void {
  const signature = signatures.find((candidate) => candidate.mediaType === mediaType);
  if (
    signature === undefined ||
    !hasAllowedExtension(fileName, signature.extensions) ||
    content.byteLength < signature.prefixLength ||
    !signature.matches(content.subarray(0, signature.prefixLength))
  ) {
    throw new InvalidStatementImageError();
  }
}

/**
 * 只读取声明格式所需的最短文件头。通过后把文件头和未消费的数据重新组成流，
 * 后续内容仍由对象存储边读边写，不会在 API 进程里缓存整个文件。
 */
export async function prepareStatementImage(
  mediaType: string,
  fileNames: readonly string[],
  source: AsyncIterable<Uint8Array>
): Promise<PreparedStatementImage> {
  let iterator: AsyncIterator<Uint8Array>;
  try {
    iterator = source[Symbol.asyncIterator]();
  } catch {
    throw new StatementImageReadError();
  }

  const close = closeIteratorOnce(iterator);
  const signature = signatures.find((candidate) => candidate.mediaType === mediaType);
  if (
    signature === undefined ||
    fileNames.length === 0 ||
    fileNames.some((fileName) => !hasAllowedExtension(fileName, signature.extensions))
  ) {
    await close();
    throw new InvalidStatementImageError();
  }

  const prefix = new Uint8Array(signature.prefixLength);
  let prefixBytes = 0;
  let emptyChunks = 0;
  let remainder: Uint8Array | undefined;

  while (prefixBytes < signature.prefixLength) {
    let step: IteratorResult<Uint8Array>;
    try {
      step = await iterator.next();
    } catch {
      await close();
      throw new StatementImageReadError();
    }
    if (typeof step !== "object" || step === null || step.done === true) {
      await close();
      throw new InvalidStatementImageError();
    }
    if (!(step.value instanceof Uint8Array)) {
      await close();
      throw new InvalidStatementImageError();
    }
    if (step.value.byteLength === 0) {
      emptyChunks += 1;
      if (emptyChunks > maximumConsecutiveEmptyChunks) {
        await close();
        throw new InvalidStatementImageError();
      }
      continue;
    }
    emptyChunks = 0;

    const bytesNeeded = signature.prefixLength - prefixBytes;
    const consumedBytes = Math.min(bytesNeeded, step.value.byteLength);
    prefix.set(step.value.subarray(0, consumedBytes), prefixBytes);
    prefixBytes += consumedBytes;
    if (consumedBytes < step.value.byteLength) {
      remainder = step.value.subarray(consumedBytes);
    }
  }

  if (!signature.matches(prefix)) {
    await close();
    throw new InvalidStatementImageError();
  }

  return {
    content: replayCheckedPrefix(prefix, remainder, iterator, close),
    close
  };
}

function matchesBytes(prefix: Uint8Array, expected: readonly number[]): boolean {
  return expected.every((byte, index) => prefix[index] === byte);
}

function matchesAscii(prefix: Uint8Array, expected: string, offset: number): boolean {
  for (let index = 0; index < expected.length; index += 1) {
    if (prefix[offset + index] !== expected.charCodeAt(index)) {
      return false;
    }
  }
  return true;
}

function hasAllowedExtension(fileName: string, allowedExtensions: readonly string[]): boolean {
  const slash = Math.max(fileName.lastIndexOf("/"), fileName.lastIndexOf("\\"));
  const dot = fileName.lastIndexOf(".");
  if (dot <= slash || dot === fileName.length - 1) {
    return false;
  }
  return allowedExtensions.includes(fileName.slice(dot + 1).toLowerCase());
}

async function closeIterator(iterator: AsyncIterator<Uint8Array>): Promise<void> {
  try {
    await iterator.return?.();
  } catch {
    // 关闭失败不能覆盖已经确定且经过脱敏的接口错误。
  }
}

function closeIteratorOnce(iterator: AsyncIterator<Uint8Array>): () => Promise<void> {
  let closing: Promise<void> | undefined;
  return () => {
    closing ??= closeIterator(iterator);
    return closing;
  };
}

async function* replayCheckedPrefix(
  prefix: Uint8Array,
  remainder: Uint8Array | undefined,
  iterator: AsyncIterator<Uint8Array>,
  close: () => Promise<void>
): AsyncGenerator<Uint8Array> {
  let completed = false;
  let emptyChunks = 0;
  try {
    yield prefix;
    if (remainder !== undefined && remainder.byteLength > 0) {
      yield remainder;
    }

    while (true) {
      let step: IteratorResult<Uint8Array>;
      try {
        step = await iterator.next();
      } catch {
        throw new StorageError("STORAGE_READ_FAILED", "读取上传文件失败。");
      }
      if (typeof step !== "object" || step === null) {
        throw new StorageError("INVALID_STREAM", "上传文件包含无效的数据块。");
      }
      if (step.done === true) {
        completed = true;
        return;
      }
      if (!(step.value instanceof Uint8Array)) {
        throw new StorageError("INVALID_STREAM", "上传文件包含无效的数据块。");
      }
      if (step.value.byteLength === 0) {
        emptyChunks += 1;
        if (emptyChunks > maximumConsecutiveEmptyChunks) {
          throw new StorageError("INVALID_STREAM", "上传文件包含过多空数据块。");
        }
        continue;
      }
      emptyChunks = 0;
      yield step.value;
    }
  } finally {
    if (!completed) {
      await close();
    }
  }
}
