import { constants } from "node:fs";
import {
  access,
  link,
  lstat,
  mkdir,
  open,
  realpath,
  rm
} from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { basename, dirname, isAbsolute, relative, resolve } from "node:path";
import { HistoryMigrationError, type HistoryMigrationErrorCode } from "./errors";
import { sha256Hex } from "./digests";

export const maximumHistorySourceBytes = 2_000_000;
export const maximumHistorySourceTextUnits = 500_000;
export const maximumPrivateJsonBytes = 10_000_000;

export async function assertPathsInsidePrivateRoot(
  privateRootDirectory: string,
  paths: readonly {
    readonly path: string;
    readonly kind: "existing" | "new";
  }[]
): Promise<void> {
  let rootPath: string;
  try {
    const rootMetadata = await lstat(privateRootDirectory);
    if (!rootMetadata.isDirectory() || rootMetadata.isSymbolicLink()) {
      throw new Error("invalid private root");
    }
    rootPath = await realpath(privateRootDirectory);
  } catch {
    throw new HistoryMigrationError(
      "INVALID_ARGUMENTS",
      "必须指定一个真实存在且不是符号链接的服务器私有目录。"
    );
  }

  for (const item of paths) {
    const resolvedPath = resolve(item.path);
    if (!isPathInside(rootPath, resolvedPath)) {
      throw new HistoryMigrationError(
        "INVALID_ARGUMENTS",
        "历史迁移的输入和输出必须全部位于明确指定的服务器私有目录内。"
      );
    }
    try {
      const checkedPath =
        item.kind === "existing"
          ? await realpath(resolvedPath)
          : resolve(await realpath(dirname(resolvedPath)), basename(resolvedPath));
      const passedThroughLink =
        item.kind === "existing"
          ? checkedPath !== resolvedPath
          : dirname(checkedPath) !== dirname(resolvedPath);
      if (passedThroughLink || !isPathInside(rootPath, checkedPath)) {
        throw new Error("path escapes private root");
      }
    } catch {
      throw new HistoryMigrationError(
        "INVALID_ARGUMENTS",
        item.kind === "existing"
          ? "私有输入路径不存在、经过符号链接或超出私有目录。"
          : "私有输出的上级目录不存在、经过符号链接或超出私有目录。"
      );
    }
  }
}

export async function readPrivateJson(path: string): Promise<unknown> {
  return (await readPrivateJsonWithDigest(path)).value;
}

export async function readPrivateJsonWithDigest(
  path: string
): Promise<{ readonly value: unknown; readonly sha256: string }> {
  const bytes = await readRegularFile(
    path,
    maximumPrivateJsonBytes,
    "SOURCE_FILE_INVALID",
    "私有 JSON 文件无法安全读取。"
  );
  try {
    return {
      value: JSON.parse(decodeUtf8(bytes)),
      sha256: sha256Hex(bytes)
    };
  } catch {
    throw new HistoryMigrationError("SOURCE_FILE_INVALID", "私有 JSON 文件格式不正确。");
  }
}

/**
 * 读取已经由调用方限制在私有目录内的普通文件。这里仍使用 O_NOFOLLOW，
 * 并在读取前后检查文件类型和大小；错误信息不会带出实际路径。
 */
export async function readPrivateRegularBytes(
  path: string,
  maximumBytes: number
): Promise<Uint8Array> {
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes <= 0) {
    throw new HistoryMigrationError(
      "INVALID_ARGUMENTS",
      "私有文件读取上限不正确。"
    );
  }
  return readRegularFile(
    path,
    maximumBytes,
    "SOURCE_FILE_INVALID",
    "私有源文件无法安全读取。"
  );
}

export async function readConfirmedSource(
  sourceDirectory: string,
  sourcePath: string,
  expectedSha256: string,
  sourceId: string
): Promise<{ readonly text: string; readonly sha256: string }> {
  const root = resolve(sourceDirectory);
  const filePath = resolve(root, ...sourcePath.split("/"));
  const pathFromRoot = relative(root, filePath);
  if (pathFromRoot.startsWith("..") || isAbsolute(pathFromRoot)) {
    throw new HistoryMigrationError(
      "SOURCE_FILE_INVALID",
      `${sourceId} 不在已确认的源文件目录内。`
    );
  }
  let rootRealPath: string;
  let fileRealPath: string;
  try {
    rootRealPath = await realpath(root);
    fileRealPath = await realpath(filePath);
  } catch {
    throw new HistoryMigrationError(
      "SOURCE_FILE_INVALID",
      `${sourceId} 不是可安全读取的普通文件。`
    );
  }
  if (
    fileRealPath !== resolve(rootRealPath, ...sourcePath.split("/")) ||
    relative(rootRealPath, fileRealPath).startsWith("..")
  ) {
    throw new HistoryMigrationError(
      "SOURCE_FILE_INVALID",
      `${sourceId} 经过了符号链接或超出源文件目录。`
    );
  }

  const bytes = await readRegularFile(
    fileRealPath,
    maximumHistorySourceBytes,
    "SOURCE_FILE_INVALID",
    `${sourceId} 不是可安全读取的普通文件。`
  );
  const digest = sha256Hex(bytes);
  if (digest !== expectedSha256) {
    throw new HistoryMigrationError(
      "SOURCE_DIGEST_MISMATCH",
      `${sourceId} 的内容已经变化，原来的映射确认已失效。`
    );
  }

  let text: string;
  try {
    text = decodeUtf8(bytes);
  } catch {
    throw new HistoryMigrationError(
      "SOURCE_FILE_INVALID",
      `${sourceId} 不是有效的 UTF-8 文本。`
    );
  }
  if (text.length > maximumHistorySourceTextUnits) {
    throw new HistoryMigrationError(
      "SOURCE_TOO_LARGE",
      `${sourceId} 的文本长度超过明确上限；迁移工具不会截断内容。`
    );
  }
  if (text.trim().length === 0) {
    throw new HistoryMigrationError("SOURCE_FILE_INVALID", `${sourceId} 是空文件。`);
  }
  return { text, sha256: digest };
}

export async function createNewPrivateDirectory(path: string): Promise<void> {
  try {
    await mkdir(path, { recursive: false, mode: 0o700 });
  } catch (error) {
    if (hasErrorCode(error, "EEXIST")) {
      throw new HistoryMigrationError(
        "OUTPUT_ALREADY_EXISTS",
        "输出目录已经存在；为避免覆盖，请使用新的空路径。"
      );
    }
    throw new HistoryMigrationError("OUTPUT_WRITE_FAILED", "无法创建私有输出目录。");
  }
}

export async function assertNewOutputPath(path: string): Promise<void> {
  try {
    await access(path);
  } catch (error) {
    if (hasErrorCode(error, "ENOENT")) {
      return;
    }
    throw new HistoryMigrationError("OUTPUT_WRITE_FAILED", "无法检查私有输出路径。");
  }
  throw new HistoryMigrationError(
    "OUTPUT_ALREADY_EXISTS",
    "输出文件已经存在；为避免覆盖，请使用新的路径。"
  );
}

export async function writeNewPrivateFile(
  path: string,
  content: string | Uint8Array
): Promise<void> {
  const directory = dirname(path);
  const temporaryPath = resolve(directory, `.history-write-${randomUUID()}.tmp`);
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(temporaryPath, "wx", 0o600);
    await handle.writeFile(content);
    await handle.sync();
    await handle.close();
    handle = undefined;
    await link(temporaryPath, path);
    await rm(temporaryPath);
  } catch (error) {
    await handle?.close().catch(() => undefined);
    await rm(temporaryPath, { force: true }).catch(() => undefined);
    if (hasErrorCode(error, "EEXIST")) {
      throw new HistoryMigrationError(
        "OUTPUT_ALREADY_EXISTS",
        "输出文件已经存在；为避免覆盖，迁移工具已停止。"
      );
    }
    throw new HistoryMigrationError("OUTPUT_WRITE_FAILED", "私有输出写入失败。");
  }
}

export async function writeNewPrivateJson(path: string, value: unknown): Promise<void> {
  const serialized = `${JSON.stringify(value, null, 2)}\n`;
  if (new TextEncoder().encode(serialized).byteLength > maximumPrivateJsonBytes) {
    throw new HistoryMigrationError(
      "CANDIDATE_INVALID",
      "要写出的私有 JSON 超过明确上限；工具不会写出随后无法复核的候选。"
    );
  }
  await writeNewPrivateFile(path, serialized);
}

async function readRegularFile(
  path: string,
  maximumBytes: number,
  invalidCode: HistoryMigrationErrorCode,
  invalidMessage: string
): Promise<Uint8Array> {
  let metadata: Awaited<ReturnType<typeof lstat>>;
  try {
    metadata = await lstat(path);
  } catch {
    throw new HistoryMigrationError(invalidCode, invalidMessage);
  }
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new HistoryMigrationError(invalidCode, invalidMessage);
  }
  if (metadata.size > maximumBytes) {
    throw new HistoryMigrationError(
      "SOURCE_TOO_LARGE",
      "输入文件超过明确上限；迁移工具不会截断内容。"
    );
  }

  let handle: Awaited<ReturnType<typeof open>>;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch {
    throw new HistoryMigrationError(invalidCode, invalidMessage);
  }
  try {
    const openedMetadata = await handle.stat();
    if (!openedMetadata.isFile() || openedMetadata.size > maximumBytes) {
      throw new HistoryMigrationError(
        openedMetadata.size > maximumBytes ? "SOURCE_TOO_LARGE" : invalidCode,
        openedMetadata.size > maximumBytes
          ? "输入文件超过明确上限；迁移工具不会截断内容。"
          : invalidMessage
      );
    }
    const content = await handle.readFile();
    if (content.byteLength > maximumBytes) {
      throw new HistoryMigrationError(
        "SOURCE_TOO_LARGE",
        "输入文件超过明确上限；迁移工具不会截断内容。"
      );
    }
    return new Uint8Array(content);
  } finally {
    await handle.close().catch(() => undefined);
  }
}

function decodeUtf8(bytes: Uint8Array): string {
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}

function hasErrorCode(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { readonly code?: unknown }).code === code
  );
}

function isPathInside(root: string, candidate: string): boolean {
  const pathFromRoot = relative(root, candidate);
  return (
    pathFromRoot.length === 0 ||
    (!pathFromRoot.startsWith("..") && !isAbsolute(pathFromRoot))
  );
}
