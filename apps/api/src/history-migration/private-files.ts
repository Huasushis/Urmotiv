import { constants, lstatSync, mkdirSync, type BigIntStats, type Dirent } from "node:fs";
import {
  access,
  link,
  lstat,
  mkdir,
  open,
  readdir,
  realpath,
  rename,
  rm,
  unlink,
} from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { isSafeArchivePath } from "@urmotiv/problem-package";
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
  }[],
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
      "必须指定一个真实存在且不是符号链接的服务器私有目录。",
    );
  }

  for (const item of paths) {
    const resolvedPath = resolve(item.path);
    if (!isPathInside(rootPath, resolvedPath)) {
      throw new HistoryMigrationError(
        "INVALID_ARGUMENTS",
        "历史迁移的输入和输出必须全部位于明确指定的服务器私有目录内。",
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
          : "私有输出的上级目录不存在、经过符号链接或超出私有目录。",
      );
    }
  }
}

export async function readPrivateJson(path: string): Promise<unknown> {
  return (await readPrivateJsonWithDigest(path)).value;
}

export async function readPrivateJsonWithDigest(
  path: string,
): Promise<{ readonly value: unknown; readonly sha256: string }> {
  const bytes = await readRegularFile(
    path,
    maximumPrivateJsonBytes,
    "SOURCE_FILE_INVALID",
    "私有 JSON 文件无法安全读取。",
  );
  try {
    return {
      value: JSON.parse(decodeUtf8(bytes)),
      sha256: sha256Hex(bytes),
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
  maximumBytes: number,
): Promise<Uint8Array> {
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes <= 0) {
    throw new HistoryMigrationError("INVALID_ARGUMENTS", "私有文件读取上限不正确。");
  }
  return readRegularFile(path, maximumBytes, "SOURCE_FILE_INVALID", "私有源文件无法安全读取。");
}

export async function readConfirmedSource(
  sourceDirectory: string,
  sourcePath: string,
  expectedSha256: string,
  sourceId: string,
): Promise<{ readonly text: string; readonly sha256: string; readonly textSha256: string }> {
  const root = resolve(sourceDirectory);
  const filePath = resolve(root, ...sourcePath.split("/"));
  const pathFromRoot = relative(root, filePath);
  if (pathFromRoot.startsWith("..") || isAbsolute(pathFromRoot)) {
    throw new HistoryMigrationError(
      "SOURCE_FILE_INVALID",
      `${sourceId} 不在已确认的源文件目录内。`,
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
      `${sourceId} 不是可安全读取的普通文件。`,
    );
  }
  if (
    fileRealPath !== resolve(rootRealPath, ...sourcePath.split("/")) ||
    relative(rootRealPath, fileRealPath).startsWith("..")
  ) {
    throw new HistoryMigrationError(
      "SOURCE_FILE_INVALID",
      `${sourceId} 经过了符号链接或超出源文件目录。`,
    );
  }

  const bytes = await readRegularFile(
    fileRealPath,
    maximumHistorySourceBytes,
    "SOURCE_FILE_INVALID",
    `${sourceId} 不是可安全读取的普通文件。`,
  );
  const digest = sha256Hex(bytes);
  if (digest !== expectedSha256) {
    throw new HistoryMigrationError(
      "SOURCE_DIGEST_MISMATCH",
      `${sourceId} 的内容已经变化，原来的映射确认已失效。`,
    );
  }

  let text: string;
  try {
    text = decodeUtf8(bytes);
  } catch {
    throw new HistoryMigrationError("SOURCE_FILE_INVALID", `${sourceId} 不是有效的 UTF-8 文本。`);
  }
  if (text.length > maximumHistorySourceTextUnits) {
    throw new HistoryMigrationError(
      "SOURCE_TOO_LARGE",
      `${sourceId} 的文本长度超过明确上限；迁移工具不会截断内容。`,
    );
  }
  if (text.trim().length === 0) {
    throw new HistoryMigrationError("SOURCE_FILE_INVALID", `${sourceId} 是空文件。`);
  }
  return { text, sha256: digest, textSha256: sha256Hex(text) };
}

export async function createNewPrivateDirectory(path: string): Promise<void> {
  const directory = dirname(path);
  const name = basename(path);
  const parent = await openStablePrivateDirectory(directory);
  try {
    await mkdir(joinThroughDirectoryHandle(parent.handle.fd, name), {
      recursive: false,
      mode: 0o700,
    });
    await parent.handle.sync();
  } catch (error) {
    if (hasErrorCode(error, "EEXIST")) {
      throw new HistoryMigrationError(
        "OUTPUT_ALREADY_EXISTS",
        "输出目录已经存在；为避免覆盖，请使用新的空路径。",
      );
    }
    throw new HistoryMigrationError("OUTPUT_WRITE_FAILED", "无法创建私有输出目录。");
  } finally {
    await parent.handle.close().catch(() => undefined);
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
    "输出文件已经存在；为避免覆盖，请使用新的路径。",
  );
}

export async function writeNewPrivateFile(
  path: string,
  content: string | Uint8Array,
): Promise<void> {
  const directory = dirname(path);
  const name = basename(path);
  const parent = await openStablePrivateDirectory(directory);
  try {
    await writeNewPrivateFileThroughDirectoryHandle(parent.handle, name, content);
  } finally {
    await parent.handle.close().catch(() => undefined);
  }
}

/**
 * 覆盖式原子写入（rename 语义）：用于重跑时更新既有清单。已 fsync 的临时
 * 文件原地 rename，目录同步后返回；目标不存在时行为与新建一致。
 */
export async function writePrivateFile(path: string, content: string | Uint8Array): Promise<void> {
  const directory = dirname(path);
  const name = basename(path);
  const parent = await openStablePrivateDirectory(directory);
  try {
    const targetPath = joinThroughDirectoryHandle(parent.handle.fd, name);
    const temporaryName = `.history-replace-${randomUUID()}.tmp`;
    const temporaryPath = joinThroughDirectoryHandle(parent.handle.fd, temporaryName);
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    try {
      handle = await open(temporaryPath, "wx", 0o600);
      await handle.writeFile(content);
      await handle.sync();
      await handle.close();
      handle = undefined;
      await rename(temporaryPath, targetPath);
      await parent.handle.sync();
    } catch (error) {
      await handle?.close().catch(() => undefined);
      await rm(temporaryPath, { force: true }).catch(() => undefined);
      throw new HistoryMigrationError("OUTPUT_WRITE_FAILED", "私有输出写入失败。");
    }
  } finally {
    await parent.handle.close().catch(() => undefined);
  }
}

/**
 * 同一阶段的 payload 与最终 marker 共用一个持续持有的目录句柄。每个文件都
 * 先 fsync 自身，再用 hard-link 的 no-replace 语义发布并 fsync 目录；marker
 * 固定最后发布，绝不使用可能覆盖目标的 rename。
 */
export async function writeNewPrivateJsonBundleWithFinalMarker(
  directoryPath: string,
  payloads: readonly { readonly name: string; readonly value: unknown }[],
  marker: { readonly name: string; readonly value: unknown },
): Promise<void> {
  const names = [...payloads.map((item) => item.name), marker.name];
  if (new Set(names).size !== names.length) {
    throw new HistoryMigrationError("INVALID_ARGUMENTS", "私有阶段输出文件名不能重复。");
  }
  const serializedPayloads = payloads.map((payload) => ({
    name: payload.name,
    content: serializePrivateJson(payload.value),
  }));
  const serializedMarker = {
    name: marker.name,
    content: serializePrivateJson(marker.value),
  };
  await withNewStablePrivateDirectoryHandle(directoryPath, async (directoryHandle) => {
    for (const payload of serializedPayloads) {
      await writeNewPrivateFileThroughDirectoryHandle(
        directoryHandle,
        payload.name,
        payload.content,
      );
    }
    await writeNewPrivateFileThroughDirectoryHandle(
      directoryHandle,
      serializedMarker.name,
      serializedMarker.content,
    );

    const publishedDirectoryState = await readSecurePrivateDirectoryState(directoryHandle);
    for (const payload of serializedPayloads) {
      await assertPublishedPrivateFile(directoryHandle, payload.name, payload.content);
    }
    await assertPublishedPrivateFile(
      directoryHandle,
      serializedMarker.name,
      serializedMarker.content,
    );
    const verifiedDirectoryState = await readSecurePrivateDirectoryState(directoryHandle);
    assertSamePrivateDirectoryState(publishedDirectoryState, verifiedDirectoryState);
  });
}

async function writeNewPrivateFileThroughDirectoryHandle(
  directoryHandle: Awaited<ReturnType<typeof open>>,
  name: string,
  content: string | Uint8Array,
): Promise<void> {
  // 在创建临时文件之前先验证名称；joinThroughDirectoryHandle 只接受单个 basename。
  const targetPath = joinThroughDirectoryHandle(directoryHandle.fd, name);
  const temporaryName = `.history-write-${randomUUID()}.tmp`;
  const temporaryPath = joinThroughDirectoryHandle(directoryHandle.fd, temporaryName);
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(temporaryPath, "wx", 0o600);
    await handle.writeFile(content);
    await handle.sync();
    await handle.close();
    handle = undefined;
    await link(temporaryPath, targetPath);
    await directoryHandle.sync();
    await rm(temporaryPath);
    await directoryHandle.sync();
  } catch (error) {
    await handle?.close().catch(() => undefined);
    await rm(temporaryPath, { force: true }).catch(() => undefined);
    if (hasErrorCode(error, "EEXIST")) {
      throw new HistoryMigrationError(
        "OUTPUT_ALREADY_EXISTS",
        "输出文件已经存在；为避免覆盖，迁移工具已停止。",
      );
    }
    throw new HistoryMigrationError("OUTPUT_WRITE_FAILED", "私有输出写入失败。");
  }
}

export async function movePrivateFileNoReplace(
  sourcePath: string,
  destinationPath: string,
): Promise<void> {
  if (dirname(sourcePath) !== dirname(destinationPath)) {
    throw new HistoryMigrationError("INVALID_ARGUMENTS", "私有状态标记必须在同一目录内移动。");
  }
  const parent = await openStablePrivateDirectory(dirname(sourcePath));
  const source = joinThroughDirectoryHandle(parent.handle.fd, basename(sourcePath));
  const destination = joinThroughDirectoryHandle(parent.handle.fd, basename(destinationPath));
  try {
    const sourceHandle = await open(source, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const metadata = await sourceHandle.stat();
      if (!metadata.isFile()) {
        throw new HistoryMigrationError("OUTPUT_WRITE_FAILED", "私有状态标记不是普通文件。");
      }
    } finally {
      await sourceHandle.close().catch(() => undefined);
    }
    await link(source, destination);
    await parent.handle.sync();
    await unlink(source);
    await parent.handle.sync();
  } catch (error) {
    if (error instanceof HistoryMigrationError) throw error;
    if (hasErrorCode(error, "EEXIST")) {
      throw new HistoryMigrationError(
        "OUTPUT_ALREADY_EXISTS",
        "私有状态标记已经存在；为避免覆盖，迁移工具已停止。",
      );
    }
    throw new HistoryMigrationError("OUTPUT_WRITE_FAILED", "私有状态标记无法原子发布。");
  } finally {
    await parent.handle.close().catch(() => undefined);
  }
}

export async function writeNewPrivateJson(path: string, value: unknown): Promise<void> {
  await writeNewPrivateFile(path, serializePrivateJson(value));
}

function serializePrivateJson(value: unknown): string {
  const serialized = `${JSON.stringify(value, null, 2)}\n`;
  if (new TextEncoder().encode(serialized).byteLength > maximumPrivateJsonBytes) {
    throw new HistoryMigrationError(
      "CANDIDATE_INVALID",
      "要写出的私有 JSON 超过明确上限；工具不会写出随后无法复核的候选。",
    );
  }
  return serialized;
}

async function readRegularFile(
  path: string,
  maximumBytes: number,
  invalidCode: HistoryMigrationErrorCode,
  invalidMessage: string,
): Promise<Uint8Array> {
  const parent = await openStablePrivateDirectory(dirname(path));
  try {
    return await readRegularFileThroughDirectoryHandle(
      parent.handle,
      basename(path),
      maximumBytes,
      invalidCode,
      invalidMessage,
    );
  } finally {
    await parent.handle.close().catch(() => undefined);
  }
}

async function readRegularFileThroughDirectoryHandle(
  directoryHandle: Awaited<ReturnType<typeof open>>,
  name: string,
  maximumBytes: number,
  invalidCode: HistoryMigrationErrorCode,
  invalidMessage: string,
): Promise<Uint8Array> {
  let handle: Awaited<ReturnType<typeof open>>;
  try {
    handle = await open(
      joinThroughDirectoryHandle(directoryHandle.fd, name),
      constants.O_RDONLY | constants.O_NOFOLLOW,
    );
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
          : invalidMessage,
      );
    }
    const content = await handle.readFile();
    if (content.byteLength > maximumBytes) {
      throw new HistoryMigrationError(
        "SOURCE_TOO_LARGE",
        "输入文件超过明确上限；迁移工具不会截断内容。",
      );
    }
    return new Uint8Array(content);
  } finally {
    await handle.close().catch(() => undefined);
  }
}

async function assertPrivateFileModeThroughDirectoryHandle(
  directoryHandle: Awaited<ReturnType<typeof open>>,
  name: string,
): Promise<void> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(
      joinThroughDirectoryHandle(directoryHandle.fd, name),
      constants.O_RDONLY | constants.O_NOFOLLOW,
    );
    const metadata = await handle.stat();
    if (!metadata.isFile() || (metadata.mode & 0o777) !== 0o600) {
      throw new HistoryMigrationError(
        "PREPARE_RESUME_UNSAFE",
        "prepare 私有检查点权限不是 0600，不能继续。",
      );
    }
  } catch (error) {
    if (error instanceof HistoryMigrationError) throw error;
    throw new HistoryMigrationError("PREPARE_RESUME_UNSAFE", "prepare 私有检查点无法安全读取。");
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function privateRegularFileExistsThroughDirectoryHandle(
  directoryHandle: Awaited<ReturnType<typeof open>>,
  name: string,
): Promise<boolean> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    try {
      handle = await open(
        joinThroughDirectoryHandle(directoryHandle.fd, name),
        constants.O_RDONLY | constants.O_NOFOLLOW,
      );
    } catch (error) {
      if (hasErrorCode(error, "ENOENT")) return false;
      throw new HistoryMigrationError(
        "ATTACHMENT_MAPPING_CHANGED",
        "附件映射状态文件不是可安全读取的普通文件。",
      );
    }
    const metadata = await handle.stat();
    if (!metadata.isFile()) {
      throw new HistoryMigrationError(
        "ATTACHMENT_MAPPING_CHANGED",
        "附件映射状态文件不是普通文件。",
      );
    }
    return true;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

export async function assertPrivateDirectoryMode(path: string): Promise<void> {
  const directory = await openStablePrivateDirectory(path);
  try {
    const metadata = await directory.handle.stat();
    if ((metadata.mode & 0o777) !== 0o700) {
      throw new HistoryMigrationError(
        "PREPARE_RESUME_UNSAFE",
        "prepare 私有输出目录权限不是 0700，不能继续。",
      );
    }
  } finally {
    await directory.handle.close().catch(() => undefined);
  }
}

export async function assertPrivateFileMode(path: string): Promise<void> {
  const parent = await openStablePrivateDirectory(dirname(path));
  try {
    await assertPrivateFileModeThroughDirectoryHandle(parent.handle, basename(path));
  } finally {
    await parent.handle.close().catch(() => undefined);
  }
}

export interface PrivateDirectoryIdentity {
  readonly device: number;
  readonly inode: number;
}

interface PrivateDirectorySecurityState {
  readonly device: bigint;
  readonly inode: bigint;
  readonly uid: bigint;
  readonly mode: bigint;
  readonly ctimeNs: bigint;
}

interface PrivateFileSecurityState extends PrivateDirectorySecurityState {
  readonly size: bigint;
}

/**
 * 一次核对流程所用的目录访问全部绑定到同一个已经逐级 O_NOFOLLOW 打开的
 * dirfd。即使路径名在核对中被换走，也不能把 marker、payload 和报告分别
 * 从不同目录读入。
 */
export interface StablePrivateDirectoryAccess {
  assertDirectoryMode(): Promise<void>;
  assertFileMode(name: string): Promise<void>;
  regularFileExists(name: string): Promise<boolean>;
  readJson(name: string): Promise<unknown>;
  readJsonIfExists(name: string): Promise<unknown | undefined>;
}

export async function withStablePrivateDirectoryAccess<T>(
  path: string,
  operation: (access: StablePrivateDirectoryAccess) => Promise<T>,
): Promise<T> {
  const directory = await openStablePrivateDirectory(path);
  try {
    const openedState = await readSecurePrivateDirectoryState(directory.handle);
    const fileStates = new Map<string, PrivateFileSecurityState>();
    const access: StablePrivateDirectoryAccess = {
      assertDirectoryMode: async () => {
        assertSamePrivateDirectoryState(
          openedState,
          await readSecurePrivateDirectoryState(directory.handle),
        );
      },
      assertFileMode: async (name) => {
        await readSecurePrivateFileThroughDirectoryHandle(
          directory.handle,
          name,
          maximumPrivateJsonBytes,
          fileStates,
        );
      },
      regularFileExists: async (name) =>
        (await readSecurePrivateFileThroughDirectoryHandle(
          directory.handle,
          name,
          maximumPrivateJsonBytes,
          fileStates,
          true,
        )) !== undefined,
      readJson: async (name) =>
        parseStablePrivateJson(
          await readSecurePrivateFileThroughDirectoryHandle(
            directory.handle,
            name,
            maximumPrivateJsonBytes,
            fileStates,
          ),
        ),
      readJsonIfExists: async (name) => {
        const bytes = await readSecurePrivateFileThroughDirectoryHandle(
          directory.handle,
          name,
          maximumPrivateJsonBytes,
          fileStates,
          true,
        );
        return bytes === undefined ? undefined : parseStablePrivateJson(bytes);
      },
    };
    const result = await operation(access);
    const finishedState = await readSecurePrivateDirectoryState(directory.handle);
    assertSamePrivateDirectoryState(openedState, finishedState);
    await assertPublicPrivateDirectoryState(path, finishedState);
    return result;
  } finally {
    await directory.handle.close().catch(() => undefined);
  }
}

export interface StablePrivateJsonFile {
  readonly value: unknown;
  readonly sha256: string;
}

/**
 * 人工确认文件在整个消费流程中只持有一个父目录句柄和一个文件句柄。读取前后
 * 都比较文件身份与安全状态；流程结束时还会从原父目录和公开路径各自重开，
 * 防止路径名在固定文件句柄背后被换成另一个同权限文件。
 */
export async function withStablePrivateJsonFile<T>(
  path: string,
  operation: (input: StablePrivateJsonFile) => Promise<T>,
): Promise<T> {
  const parentPath = dirname(path);
  const name = basename(path);
  const parent = await openStablePrivateDirectory(parentPath);
  let fileHandle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    const openedParentState = await readSecurePrivateDirectoryState(parent.handle);
    try {
      fileHandle = await open(
        joinThroughDirectoryHandle(parent.handle.fd, name),
        constants.O_RDONLY | constants.O_NOFOLLOW,
      );
    } catch {
      throw new HistoryMigrationError(
        "PREPARE_RESUME_UNSAFE",
        "人工附件映射计划无法通过稳定目录句柄安全打开。",
      );
    }

    const initial = await readSecurePrivateFileHandle(fileHandle, maximumPrivateJsonBytes);
    const input = Object.freeze({
      value: parseStablePrivateJson(initial.bytes),
      sha256: sha256Hex(initial.bytes),
    });
    let completed = false;
    let result: T | undefined;
    let operationError: unknown;
    try {
      result = await operation(input);
      completed = true;
    } catch (error) {
      operationError = error;
    }

    // 即使消费流程本身失败，也先完成安全复核；竞态失败必须覆盖普通业务错误。
    const finalHeld = await readSecurePrivateFileHandle(fileHandle, maximumPrivateJsonBytes);
    assertSamePrivateFileState(initial.state, finalHeld.state);
    if (!bytesEqual(initial.bytes, finalHeld.bytes)) {
      throw new HistoryMigrationError(
        "ATTACHMENT_MAPPING_CHANGED",
        "人工附件映射计划在封存过程中发生变化。",
      );
    }
    const finishedParentState = await readSecurePrivateDirectoryState(parent.handle);
    assertSamePrivateDirectoryIdentityAndPermissions(openedParentState, finishedParentState);
    await assertPrivateFilePathStateThroughDirectoryHandle(
      parent.handle,
      name,
      initial.state,
      initial.bytes,
    );
    await assertPublicPrivateFileState(
      parentPath,
      name,
      finishedParentState,
      initial.state,
      initial.bytes,
    );

    if (!completed) throw operationError;
    return result as T;
  } finally {
    await fileHandle?.close().catch(() => undefined);
    await parent.handle.close().catch(() => undefined);
  }
}

/** 仅供需要从 mkdir 起持续持有新目录 dirfd 的私有阶段写入流程。 */
export interface NewStablePrivateDirectoryAccess {
  writeNewFile(name: string, content: string | Uint8Array): Promise<void>;
  readJson(name: string): Promise<unknown>;
}

export async function withNewStablePrivateDirectoryAccess<T>(
  path: string,
  operation: (access: NewStablePrivateDirectoryAccess) => Promise<T>,
  testingHooks?: {
    readonly afterCreatedDirectoryIdentityCaptured?: () => Promise<void>;
  },
): Promise<T> {
  return withNewStablePrivateDirectoryHandle(
    path,
    async (directoryHandle) => {
      const fileStates = new Map<string, PrivateFileSecurityState>();
      return operation({
        writeNewFile: (name, content) =>
          writeNewPrivateFileThroughDirectoryHandle(directoryHandle, name, content),
        readJson: async (name) =>
          parseStablePrivateJson(
            await readSecurePrivateFileThroughDirectoryHandle(
              directoryHandle,
              name,
              maximumPrivateJsonBytes,
              fileStates,
            ),
          ),
      });
    },
    testingHooks,
  );
}

/**
 * 从物化核对开始一直持有到打包结束的目录访问。所有 marker、报告、源映射确认
 * 以及源文件读取都通过同一组 O_NOFOLLOW 打开的 dirfd 完成；调用方不能再按公开
 * 路径重新解析任何输入，只能通过本句柄读取，并在发布最终输出前调用
 * assertPublicPathUnchanged 复核公开路径身份。句柄在 close 前一直持有目录
 * inode，即使公开路径被替换，句柄仍然只指向最初验证过的目录。
 */
export interface HeldVerifiedDirectoryAccess {
  readJson(name: string): Promise<unknown>;
  readBytes(name: string, maximumBytes: number): Promise<Uint8Array>;
  readConfirmedSource(
    sourcePath: string,
    expectedSha256: string,
    sourceId: string,
  ): Promise<{
    readonly text: string;
    readonly sha256: string;
    readonly textSha256: string;
  }>;
  listSourcePaths(): Promise<readonly string[]>;
  assertPublicPathUnchanged(): Promise<void>;
  close(): Promise<void>;
}

const maximumHeldSourcePathSegments = 8;
const maximumHeldSourcePathSegmentUnits = 120;

function isHeldSourceRelativePath(path: string): boolean {
  if (path.length === 0 || isAbsolute(path) || path.includes("\\")) {
    return false;
  }
  if (!isSafeArchivePath(path)) {
    return false;
  }
  const segments = path.split("/");
  if (segments.length > maximumHeldSourcePathSegments) {
    return false;
  }
  return segments.every(
    (segment) =>
      segment.length > 0 &&
      segment !== "." &&
      segment !== ".." &&
      [...segment].length <= maximumHeldSourcePathSegmentUnits,
  );
}

function foldHeldSourcePath(path: string): string {
  return path.normalize("NFC").toLocaleUpperCase().toLocaleLowerCase().normalize("NFC");
}

export function compareHeldSourcePaths(left: string, right: string): number {
  const foldedLeft = foldHeldSourcePath(left);
  const foldedRight = foldHeldSourcePath(right);
  if (foldedLeft < foldedRight) return -1;
  if (foldedLeft > foldedRight) return 1;
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

async function openHeldSourceFile(
  directoryHandle: Awaited<ReturnType<typeof open>>,
  name: string,
): Promise<{ readonly bytes: Uint8Array; readonly state: PrivateFileSecurityState }> {
  let handle: Awaited<ReturnType<typeof open>>;
  try {
    handle = await open(
      joinThroughDirectoryHandle(directoryHandle.fd, name),
      constants.O_RDONLY | constants.O_NOFOLLOW,
    );
  } catch {
    throw new HistoryMigrationError("SOURCE_FILE_INVALID", "源文件无法安全读取。");
  }
  try {
    const metadata = await handle.stat({ bigint: true });
    if (
      !metadata.isFile() ||
      metadata.uid !== effectiveUserId() ||
      metadata.size > BigInt(maximumHistorySourceBytes)
    ) {
      throw new HistoryMigrationError(
        "SOURCE_FILE_INVALID",
        metadata.size > BigInt(maximumHistorySourceBytes)
          ? "源文件超过明确上限；迁移工具不会截断内容。"
          : "源文件所有者或类型不安全。",
      );
    }
    const content = await handle.readFile();
    const bytes = new Uint8Array(content);
    if (
      bytes.byteLength > maximumHistorySourceBytes ||
      BigInt(bytes.byteLength) !== metadata.size
    ) {
      throw new HistoryMigrationError("SOURCE_FILE_INVALID", "源文件在读取期间发生变化。");
    }
    return {
      bytes,
      state: {
        device: metadata.dev,
        inode: metadata.ino,
        uid: metadata.uid,
        mode: metadata.mode & 0o777n,
        ctimeNs: metadata.ctimeNs,
        size: metadata.size,
      },
    };
  } finally {
    await handle.close().catch(() => undefined);
  }
}

async function readConfirmedSourceThroughHeldDirectoryHandle(
  directoryHandle: Awaited<ReturnType<typeof open>>,
  sourcePath: string,
  expectedSha256: string,
  sourceId: string,
  stateByPath: Map<string, PrivateFileSecurityState>,
): Promise<{ readonly text: string; readonly sha256: string; readonly textSha256: string }> {
  if (!isHeldSourceRelativePath(sourcePath)) {
    throw new HistoryMigrationError("SOURCE_FILE_INVALID", `${sourceId} 的源路径不安全。`);
  }
  const segments = sourcePath.split("/");
  let directory = directoryHandle;
  const openedDirectories: Array<Awaited<ReturnType<typeof open>>> = [];
  try {
    for (const segment of segments.slice(0, -1)) {
      const next = await open(
        joinThroughDirectoryHandle(directory.fd, segment),
        constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
      );
      openedDirectories.push(next);
      directory = next;
    }
    const sourceName = segments[segments.length - 1];
    if (sourceName === undefined) {
      throw new HistoryMigrationError("SOURCE_FILE_INVALID", "源文件路径无效。");
    }
    const { bytes, state } = await openHeldSourceFile(directory, sourceName);
    const previousState = stateByPath.get(sourcePath);
    if (previousState !== undefined) {
      try {
        assertSamePrivateFileState(previousState, state);
      } catch (error) {
        if (error instanceof HistoryMigrationError) {
          throw new HistoryMigrationError(
            "GROUPING_CHANGED",
            `${sourceId} 的源文件在核对后发生变化。`,
          );
        }
        throw error;
      }
    }
    stateByPath.set(sourcePath, state);
    const digest = sha256Hex(bytes);
    if (digest !== expectedSha256) {
      throw new HistoryMigrationError(
        "SOURCE_DIGEST_MISMATCH",
        `${sourceId} 的源文件内容与安全编号不一致。`,
      );
    }
    const text = decodeUtf8(bytes);
    return { text, sha256: digest, textSha256: sha256Hex(text) };
  } finally {
    await Promise.all(openedDirectories.map((handle) => handle.close().catch(() => undefined)));
  }
}

async function listSourcePathsThroughHeldDirectoryHandle(
  directoryHandle: Awaited<ReturnType<typeof open>>,
): Promise<readonly string[]> {
  const paths: string[] = [];
  const walkDirectory = async (
    handle: Awaited<ReturnType<typeof open>>,
    prefix: string,
    depth: number,
  ): Promise<void> => {
    if (depth > maximumHeldSourcePathSegments) {
      throw new HistoryMigrationError("GROUPING_CHANGED", "物化源目录嵌套过深。");
    }
    let entries: Dirent[];
    try {
      // joinThroughDirectoryHandle 不接受 "."；目录扫描直接经由已持有句柄的
      // /proc/self/fd 路径进行，句柄保持期间即使目录被改名也无法换到别的 inode。
      entries = await readdir(`/proc/self/fd/${handle.fd}/`, {
        withFileTypes: true,
      });
    } catch {
      throw new HistoryMigrationError("GROUPING_CHANGED", "物化源目录无法重新扫描。");
    }
    for (const entry of entries) {
      const relativePath = prefix.length === 0 ? entry.name : `${prefix}/${entry.name}`;
      if (!isHeldSourceRelativePath(relativePath)) {
        throw new HistoryMigrationError("GROUPING_CHANGED", "物化源目录包含不安全路径。");
      }
      if (entry.isDirectory()) {
        const sub = await open(
          joinThroughDirectoryHandle(handle.fd, entry.name),
          constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
        );
        try {
          await walkDirectory(sub, relativePath, depth + 1);
        } finally {
          await sub.close().catch(() => undefined);
        }
      } else if (entry.isFile()) {
        paths.push(relativePath);
      } else {
        throw new HistoryMigrationError("GROUPING_CHANGED", "物化源目录包含非普通文件。");
      }
    }
  };
  try {
    await walkDirectory(directoryHandle, "", 0);
  } catch {
    throw new HistoryMigrationError("GROUPING_CHANGED", "物化源目录的文件集合无法复核。");
  }
  paths.sort(compareHeldSourcePaths);
  return paths;
}

export async function openHeldVerifiedDirectoryAccess(
  directoryPath: string,
  sourceSubdirectoryName: string | undefined,
): Promise<HeldVerifiedDirectoryAccess> {
  const opened = await openStablePrivateDirectory(directoryPath);
  const openedState = await readSecurePrivateDirectoryState(opened.handle);
  let sourcesHandle: Awaited<ReturnType<typeof open>> | undefined;
  let openedSourcesState: PrivateDirectorySecurityState | undefined;
  if (sourceSubdirectoryName !== undefined) {
    if (
      sourceSubdirectoryName.length === 0 ||
      sourceSubdirectoryName.includes("/") ||
      !isSafeArchivePath(sourceSubdirectoryName)
    ) {
      await opened.handle.close().catch(() => undefined);
      throw new HistoryMigrationError("GROUPING_CHANGED", "物化源子目录名不安全。");
    }
    try {
      sourcesHandle = await open(
        joinThroughDirectoryHandle(opened.handle.fd, sourceSubdirectoryName),
        constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
      );
    } catch {
      await opened.handle.close().catch(() => undefined);
      throw new HistoryMigrationError("GROUPING_CHANGED", "物化源子目录无法安全打开。");
    }
    openedSourcesState = await readSecurePrivateDirectoryState(sourcesHandle);
  }
  const heldDirectory = sourcesHandle ?? opened.handle;
  const rootFileStates = new Map<string, PrivateFileSecurityState>();
  const sourceFileStates = new Map<string, PrivateFileSecurityState>();
  let closed = false;
  const closeHandles = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    await sourcesHandle?.close().catch(() => undefined);
    await opened.handle.close().catch(() => undefined);
  };
  return Object.freeze({
    readJson: async (name: string) =>
      parseStablePrivateJson(
        await readSecurePrivateFileThroughDirectoryHandle(
          opened.handle,
          name,
          maximumPrivateJsonBytes,
          rootFileStates,
        ),
      ),
    readBytes: async (name: string, maximumBytes: number) => {
      const bytes = await readSecurePrivateFileThroughDirectoryHandle(
        opened.handle,
        name,
        maximumBytes,
        rootFileStates,
      );
      if (bytes === undefined) {
        throw new HistoryMigrationError("GROUPING_CHANGED", "物化私有文件在读取时不存在。");
      }
      return bytes;
    },
    readConfirmedSource: (sourcePath: string, expectedSha256: string, sourceId: string) =>
      readConfirmedSourceThroughHeldDirectoryHandle(
        heldDirectory,
        sourcePath,
        expectedSha256,
        sourceId,
        sourceFileStates,
      ),
    listSourcePaths: () => listSourcePathsThroughHeldDirectoryHandle(heldDirectory),
    assertPublicPathUnchanged: async () => {
      await assertPublicPrivateDirectoryState(directoryPath, openedState);
      if (sourcesHandle !== undefined && openedSourcesState !== undefined) {
        await assertPublicPrivateDirectoryState(
          join(directoryPath, sourceSubdirectoryName!),
          openedSourcesState,
        );
      }
    },
    close: closeHandles,
  });
}

/**
 * 打包输出的私有发布器：每个文件先在私有目录内以 O_CREAT|O_EXCL|O_NOFOLLOW
 * 临时写入并 fsync，捕获创建时刻状态，再硬链接（不可覆盖）发布到最终路径，
 * 从发布后的句柄复核同一 dev+ino 证明发布成功；最终复核重新打开已发布文件，
 * 比较完整状态（dev/ino/uid/gid/mode/size/ctimeNs/mtimeNs）与内容摘要，
 * 任何变化（包括 chmod 后再还原，ctimeNs 也会移动）都会失败。只有
 * PACKAGE_COMPLETE 一类的收尾标记应当最后发布。
 */
export interface VerifiedPrivateOutputWriter {
  writeNewFile(name: string, content: string | Uint8Array): Promise<void>;
  writeNewJson(name: string, value: unknown): Promise<void>;
  assertAllPublishedUnchanged(): Promise<void>;
  close(): Promise<void>;
}

interface PublishedPrivateOutputState {
  readonly device: bigint;
  readonly inode: bigint;
  readonly uid: bigint;
  readonly gid: bigint;
  readonly mode: bigint;
  readonly size: bigint;
  readonly ctimeNs: bigint;
  readonly mtimeNs: bigint;
}

interface PublishedPrivateOutputRecord {
  readonly contentSha256: string;
  readonly baseline: PublishedPrivateOutputState;
}

async function capturePublishedPrivateOutputState(
  handle: Awaited<ReturnType<typeof open>>,
): Promise<PublishedPrivateOutputState> {
  const metadata = await handle.stat({ bigint: true });
  if (
    !metadata.isFile() ||
    metadata.uid !== effectiveUserId() ||
    (metadata.mode & 0o777n) !== 0o600n ||
    metadata.dev === 0n ||
    metadata.ino === 0n
  ) {
    throw new HistoryMigrationError("OUTPUT_WRITE_FAILED", "打包输出文件状态不安全。");
  }
  return {
    device: metadata.dev,
    inode: metadata.ino,
    uid: metadata.uid,
    gid: metadata.gid,
    mode: metadata.mode & 0o777n,
    size: metadata.size,
    ctimeNs: metadata.ctimeNs,
    mtimeNs: metadata.mtimeNs,
  };
}

function assertSamePublishedPrivateOutputState(
  expected: PublishedPrivateOutputState,
  actual: PublishedPrivateOutputState,
): void {
  if (
    expected.device !== actual.device ||
    expected.inode !== actual.inode ||
    expected.uid !== actual.uid ||
    expected.gid !== actual.gid ||
    expected.mode !== actual.mode ||
    expected.size !== actual.size ||
    expected.ctimeNs !== actual.ctimeNs ||
    expected.mtimeNs !== actual.mtimeNs
  ) {
    throw new HistoryMigrationError("GROUPING_CHANGED", "打包输出文件在最终复核时状态发生变化。");
  }
}

export async function openVerifiedPrivateOutputWriter(
  directoryPath: string,
): Promise<VerifiedPrivateOutputWriter> {
  const opened = await openStablePrivateDirectory(directoryPath);
  const openedState = await readSecurePrivateDirectoryState(opened.handle);
  const records = new Map<string, PublishedPrivateOutputRecord>();
  let closed = false;
  const closeWriter = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    try {
      // 写入过程本身会推进目录 ctime，这里只比较身份与权限，仍然能发现
      // 目录被整体替换；文件级状态由 assertAllPublishedUnchanged 复核。
      const current = await openStablePrivateDirectory(directoryPath);
      try {
        assertSamePrivateDirectoryIdentityAndPermissions(
          openedState,
          await readSecurePrivateDirectoryState(current.handle),
        );
      } finally {
        await current.handle.close().catch(() => undefined);
      }
    } catch (error) {
      if (error instanceof HistoryMigrationError) {
        throw new HistoryMigrationError("GROUPING_CHANGED", "打包输出目录在写入期间被替换。");
      }
      throw error;
    } finally {
      await opened.handle.close().catch(() => undefined);
    }
  };
  const writeNewFile = async (name: string, content: string | Uint8Array): Promise<void> => {
    if (!isSafeArchivePath(name) || name.includes("/")) {
      throw new HistoryMigrationError("OUTPUT_WRITE_FAILED", "打包输出文件名不安全。");
    }
    const temporaryName = `.incomplete-${randomUUID()}`;
    let temporaryHandle: Awaited<ReturnType<typeof open>> | undefined;
    try {
      temporaryHandle = await open(
        joinThroughDirectoryHandle(opened.handle.fd, temporaryName),
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
        0o600,
      );
      await temporaryHandle.writeFile(content);
      await temporaryHandle.sync();
      const creationState = await capturePublishedPrivateOutputState(temporaryHandle);
      try {
        await link(join(directoryPath, temporaryName), join(directoryPath, name));
      } catch (error) {
        if (hasErrorCode(error, "EEXIST")) {
          throw new HistoryMigrationError("OUTPUT_WRITE_FAILED", "打包输出文件已经存在。");
        }
        throw error;
      }
      await opened.handle.sync();
      await temporaryHandle.close();
      temporaryHandle = undefined;
      await unlink(join(directoryPath, temporaryName));
      await opened.handle.sync();
      let publishedHandle: Awaited<ReturnType<typeof open>>;
      try {
        publishedHandle = await open(
          joinThroughDirectoryHandle(opened.handle.fd, name),
          constants.O_RDONLY | constants.O_NOFOLLOW,
        );
      } catch {
        throw new HistoryMigrationError("OUTPUT_WRITE_FAILED", "打包输出文件发布后无法复核。");
      }
      try {
        const publishedState = await capturePublishedPrivateOutputState(publishedHandle);
        if (
          publishedState.device !== creationState.device ||
          publishedState.inode !== creationState.inode
        ) {
          throw new HistoryMigrationError(
            "OUTPUT_WRITE_FAILED",
            "打包输出文件发布后 inode 不一致。",
          );
        }
        records.set(name, {
          contentSha256: sha256Hex(content),
          baseline: publishedState,
        });
      } finally {
        await publishedHandle.close().catch(() => undefined);
      }
    } finally {
      await temporaryHandle?.close().catch(() => undefined);
      await unlink(join(directoryPath, temporaryName)).catch(() => undefined);
    }
  };
  const writeNewJson = async (name: string, value: unknown): Promise<void> => {
    await writeNewFile(name, serializePrivateJson(value));
  };
  const assertAllPublishedUnchanged = async (): Promise<void> => {
    for (const [name, record] of records) {
      let publishedHandle: Awaited<ReturnType<typeof open>>;
      try {
        publishedHandle = await open(
          joinThroughDirectoryHandle(opened.handle.fd, name),
          constants.O_RDONLY | constants.O_NOFOLLOW,
        );
      } catch {
        throw new HistoryMigrationError(
          "GROUPING_CHANGED",
          "打包输出文件在最终复核时不存在或已被替换。",
        );
      }
      try {
        let currentState: PublishedPrivateOutputState;
        try {
          currentState = await capturePublishedPrivateOutputState(publishedHandle);
        } catch (error) {
          if (error instanceof HistoryMigrationError) {
            throw new HistoryMigrationError(
              "GROUPING_CHANGED",
              "打包输出文件在最终复核时状态发生变化。",
            );
          }
          throw error;
        }
        assertSamePublishedPrivateOutputState(record.baseline, currentState);
        const content = new Uint8Array(await publishedHandle.readFile());
        if (sha256Hex(content) !== record.contentSha256) {
          throw new HistoryMigrationError(
            "GROUPING_CHANGED",
            "打包输出文件在最终复核时内容发生变化。",
          );
        }
      } finally {
        await publishedHandle.close().catch(() => undefined);
      }
    }
  };
  return Object.freeze({
    writeNewFile,
    writeNewJson,
    assertAllPublishedUnchanged,
    close: closeWriter,
  });
}

/**
 * 取得已经通过逐级 O_NOFOLLOW 打开的私有目录身份。长流程在结束时重新比较，
 * 不能只凭开始时解析过一次路径就假定目录没有被替换。
 */
export async function readPrivateDirectoryIdentity(
  path: string,
): Promise<PrivateDirectoryIdentity> {
  const directory = await openStablePrivateDirectory(path);
  try {
    const metadata = await directory.handle.stat();
    if (!metadata.isDirectory()) {
      throw new HistoryMigrationError("INVALID_ARGUMENTS", "私有目录身份不正确。");
    }
    return { device: metadata.dev, inode: metadata.ino };
  } finally {
    await directory.handle.close().catch(() => undefined);
  }
}

export async function assertPrivateDirectoryIdentity(
  path: string,
  expected: PrivateDirectoryIdentity,
): Promise<void> {
  const current = await readPrivateDirectoryIdentity(path);
  if (current.device !== expected.device || current.inode !== expected.inode) {
    throw new HistoryMigrationError(
      "ATTACHMENT_MAPPING_CHANGED",
      "附件映射目录在核对过程中被替换。",
    );
  }
}

/** 相对于稳定父目录句柄检查一个普通文件是否存在；符号链接不会被当作文件。 */
export async function privateRegularFileExists(path: string): Promise<boolean> {
  const parent = await openStablePrivateDirectory(dirname(path));
  try {
    return await privateRegularFileExistsThroughDirectoryHandle(parent.handle, basename(path));
  } finally {
    await parent.handle.close().catch(() => undefined);
  }
}

/**
 * 相对于稳定父目录句柄安全删除一个普通文件。先通过目录句柄验证目标是
 * 普通文件（非符号链接），再通过 /proc/self/fd 路径 unlink，最后 fsync
 * 目录。文件不存在时静默返回（幂等）。
 */
export async function removePrivateRegularFile(path: string): Promise<void> {
  const parent = await openStablePrivateDirectory(dirname(path));
  try {
    const name = basename(path);
    const exists = await privateRegularFileExistsThroughDirectoryHandle(parent.handle, name);
    if (!exists) return;
    await unlink(joinThroughDirectoryHandle(parent.handle.fd, name));
    await parent.handle.sync();
  } finally {
    await parent.handle.close().catch(() => undefined);
  }
}

async function withNewStablePrivateDirectoryHandle<T>(
  path: string,
  operation: (directoryHandle: Awaited<ReturnType<typeof open>>) => Promise<T>,
  testingHooks?: {
    readonly afterCreatedDirectoryIdentityCaptured?: () => Promise<void>;
  },
): Promise<T> {
  const parent = await openStablePrivateDirectory(dirname(path));
  const name = basename(path);
  let directoryHandle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    const targetPath = joinThroughDirectoryHandle(parent.handle.fd, name);
    let createdState: PrivateDirectorySecurityState;
    try {
      // Node 没有返回新目录 fd 的 mkdirat。同步 mkdir 与 lstat 是相邻系统调用，
      // 中间不向 JS 事件循环让步；随后取得的 fd 必须逐字段匹配这份创建快照。
      mkdirSync(targetPath, {
        recursive: false,
        mode: 0o700,
      });
      createdState = securePrivateDirectoryState(lstatSync(targetPath, { bigint: true }));
    } catch (error) {
      if (hasErrorCode(error, "EEXIST")) {
        throw new HistoryMigrationError(
          "OUTPUT_ALREADY_EXISTS",
          "输出目录已经存在；为避免覆盖，请使用新的空路径。",
        );
      }
      if (error instanceof HistoryMigrationError) throw error;
      throw new HistoryMigrationError("OUTPUT_WRITE_FAILED", "无法创建私有输出目录。");
    }
    await parent.handle.sync();
    await testingHooks?.afterCreatedDirectoryIdentityCaptured?.();

    try {
      directoryHandle = await open(
        targetPath,
        constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
      );
    } catch {
      throw new HistoryMigrationError(
        "ATTACHMENT_MAPPING_CHANGED",
        "新建私有输出目录在取得稳定句柄前被替换。",
      );
    }
    const openedState = await readSecurePrivateDirectoryState(directoryHandle);
    assertSamePrivateDirectoryState(createdState, openedState);
    await assertPublicPrivateDirectoryState(path, openedState);
    const result = await operation(directoryHandle);
    const finishedState = await readSecurePrivateDirectoryState(directoryHandle);
    assertSamePrivateDirectoryIdentityAndPermissions(openedState, finishedState);
    await assertPublicPrivateDirectoryState(path, finishedState);
    return result;
  } finally {
    await directoryHandle?.close().catch(() => undefined);
    await parent.handle.close().catch(() => undefined);
  }
}

async function readSecurePrivateDirectoryState(
  directoryHandle: Awaited<ReturnType<typeof open>>,
): Promise<PrivateDirectorySecurityState> {
  let metadata: BigIntStats;
  try {
    metadata = await directoryHandle.stat({ bigint: true });
  } catch {
    throw new HistoryMigrationError(
      "ATTACHMENT_MAPPING_CHANGED",
      "附件映射目录无法通过稳定句柄复核。",
    );
  }
  return securePrivateDirectoryState(metadata);
}

function securePrivateDirectoryState(metadata: BigIntStats): PrivateDirectorySecurityState {
  if (
    !metadata.isDirectory() ||
    metadata.uid !== effectiveUserId() ||
    (metadata.mode & 0o777n) !== 0o700n
  ) {
    throw new HistoryMigrationError(
      "PREPARE_RESUME_UNSAFE",
      "附件映射私有目录必须由当前进程用户拥有且权限为 0700。",
    );
  }
  return {
    device: metadata.dev,
    inode: metadata.ino,
    uid: metadata.uid,
    mode: metadata.mode & 0o777n,
    ctimeNs: metadata.ctimeNs,
  };
}

async function assertPublicPrivateDirectoryState(
  path: string,
  expected: PrivateDirectorySecurityState,
): Promise<void> {
  let current: Awaited<ReturnType<typeof openStablePrivateDirectory>>;
  try {
    current = await openStablePrivateDirectory(path);
  } catch {
    throw new HistoryMigrationError(
      "ATTACHMENT_MAPPING_CHANGED",
      "附件映射目录的公开路径在核对过程中被替换或移除。",
    );
  }
  try {
    assertSamePrivateDirectoryState(
      expected,
      await readSecurePrivateDirectoryState(current.handle),
    );
  } finally {
    await current.handle.close().catch(() => undefined);
  }
}

async function assertPrivateFilePathStateThroughDirectoryHandle(
  directoryHandle: Awaited<ReturnType<typeof open>>,
  name: string,
  expectedState: PrivateFileSecurityState,
  expectedBytes: Uint8Array,
): Promise<void> {
  const fileStates = new Map<string, PrivateFileSecurityState>();
  const bytes = await readSecurePrivateFileThroughDirectoryHandle(
    directoryHandle,
    name,
    maximumPrivateJsonBytes,
    fileStates,
  );
  const state = fileStates.get(name);
  if (bytes === undefined || state === undefined) {
    throw new HistoryMigrationError(
      "ATTACHMENT_MAPPING_CHANGED",
      "人工附件映射计划的公开路径不再指向原文件。",
    );
  }
  assertSamePrivateFileState(expectedState, state);
  if (!bytesEqual(expectedBytes, bytes)) {
    throw new HistoryMigrationError(
      "ATTACHMENT_MAPPING_CHANGED",
      "人工附件映射计划的公开路径内容发生变化。",
    );
  }
}

async function assertPublicPrivateFileState(
  parentPath: string,
  name: string,
  expectedParentState: PrivateDirectorySecurityState,
  expectedFileState: PrivateFileSecurityState,
  expectedBytes: Uint8Array,
): Promise<void> {
  let currentParent: Awaited<ReturnType<typeof openStablePrivateDirectory>>;
  try {
    currentParent = await openStablePrivateDirectory(parentPath);
  } catch {
    throw new HistoryMigrationError(
      "ATTACHMENT_MAPPING_CHANGED",
      "人工附件映射计划的公开父目录被替换或移除。",
    );
  }
  try {
    assertSamePrivateDirectoryState(
      expectedParentState,
      await readSecurePrivateDirectoryState(currentParent.handle),
    );
    await assertPrivateFilePathStateThroughDirectoryHandle(
      currentParent.handle,
      name,
      expectedFileState,
      expectedBytes,
    );
    assertSamePrivateDirectoryState(
      expectedParentState,
      await readSecurePrivateDirectoryState(currentParent.handle),
    );
  } finally {
    await currentParent.handle.close().catch(() => undefined);
  }
}

function assertSamePrivateDirectoryIdentityAndPermissions(
  expected: PrivateDirectorySecurityState,
  actual: PrivateDirectorySecurityState,
): void {
  if (
    expected.device !== actual.device ||
    expected.inode !== actual.inode ||
    expected.uid !== actual.uid ||
    expected.mode !== actual.mode
  ) {
    throw new HistoryMigrationError(
      "ATTACHMENT_MAPPING_CHANGED",
      "附件映射目录的身份、所有者或权限在操作过程中发生变化。",
    );
  }
}

function assertSamePrivateDirectoryState(
  expected: PrivateDirectorySecurityState,
  actual: PrivateDirectorySecurityState,
): void {
  assertSamePrivateDirectoryIdentityAndPermissions(expected, actual);
  if (expected.ctimeNs !== actual.ctimeNs) {
    throw new HistoryMigrationError(
      "ATTACHMENT_MAPPING_CHANGED",
      "附件映射目录的状态时间在核对过程中发生变化。",
    );
  }
}

async function readSecurePrivateFileThroughDirectoryHandle(
  directoryHandle: Awaited<ReturnType<typeof open>>,
  name: string,
  maximumBytes: number,
  previousStates: Map<string, PrivateFileSecurityState>,
  allowMissing = false,
): Promise<Uint8Array | undefined> {
  let handle: Awaited<ReturnType<typeof open>>;
  try {
    handle = await open(
      joinThroughDirectoryHandle(directoryHandle.fd, name),
      constants.O_RDONLY | constants.O_NOFOLLOW,
    );
  } catch (error) {
    if (allowMissing && hasErrorCode(error, "ENOENT")) return undefined;
    throw new HistoryMigrationError(
      "ATTACHMENT_MAPPING_CHANGED",
      "附件映射私有文件不存在或无法通过稳定目录句柄读取。",
    );
  }
  try {
    const openedState = await readSecurePrivateFileState(handle, maximumBytes);
    const previousState = previousStates.get(name);
    if (previousState !== undefined) {
      assertSamePrivateFileState(previousState, openedState);
    }
    const content = await handle.readFile();
    if (content.byteLength > maximumBytes) {
      throw new HistoryMigrationError(
        "SOURCE_TOO_LARGE",
        "附件映射私有文件超过明确上限；工具不会截断。",
      );
    }
    const finishedState = await readSecurePrivateFileState(handle, maximumBytes);
    assertSamePrivateFileState(openedState, finishedState);
    if (BigInt(content.byteLength) !== finishedState.size) {
      throw new HistoryMigrationError(
        "ATTACHMENT_MAPPING_CHANGED",
        "附件映射私有文件在读取过程中发生变化。",
      );
    }
    previousStates.set(name, finishedState);
    return new Uint8Array(content);
  } finally {
    await handle.close().catch(() => undefined);
  }
}

async function readSecurePrivateFileState(
  handle: Awaited<ReturnType<typeof open>>,
  maximumBytes: number,
): Promise<PrivateFileSecurityState> {
  let metadata: BigIntStats;
  try {
    metadata = await handle.stat({ bigint: true });
  } catch {
    throw new HistoryMigrationError(
      "ATTACHMENT_MAPPING_CHANGED",
      "附件映射私有文件无法通过固定文件句柄复核。",
    );
  }
  if (
    !metadata.isFile() ||
    metadata.uid !== effectiveUserId() ||
    (metadata.mode & 0o777n) !== 0o600n
  ) {
    throw new HistoryMigrationError(
      "PREPARE_RESUME_UNSAFE",
      "附件映射私有文件必须是当前进程用户拥有且权限为 0600 的普通文件。",
    );
  }
  if (metadata.size > BigInt(maximumBytes)) {
    throw new HistoryMigrationError(
      "SOURCE_TOO_LARGE",
      "附件映射私有文件超过明确上限；工具不会截断。",
    );
  }
  return {
    device: metadata.dev,
    inode: metadata.ino,
    uid: metadata.uid,
    mode: metadata.mode & 0o777n,
    ctimeNs: metadata.ctimeNs,
    size: metadata.size,
  };
}

async function readSecurePrivateFileHandle(
  handle: Awaited<ReturnType<typeof open>>,
  maximumBytes: number,
): Promise<{ readonly bytes: Uint8Array; readonly state: PrivateFileSecurityState }> {
  const openedState = await readSecurePrivateFileState(handle, maximumBytes);
  const bytes = new Uint8Array(Number(openedState.size));
  let offset = 0;
  try {
    while (offset < bytes.byteLength) {
      const { bytesRead } = await handle.read(bytes, offset, bytes.byteLength - offset, offset);
      if (bytesRead === 0) {
        throw new HistoryMigrationError(
          "ATTACHMENT_MAPPING_CHANGED",
          "人工附件映射计划在固定文件句柄读取期间被截断。",
        );
      }
      offset += bytesRead;
    }
  } catch (error) {
    if (error instanceof HistoryMigrationError) throw error;
    throw new HistoryMigrationError(
      "ATTACHMENT_MAPPING_CHANGED",
      "人工附件映射计划无法通过固定文件句柄完整读取。",
    );
  }
  const finishedState = await readSecurePrivateFileState(handle, maximumBytes);
  assertSamePrivateFileState(openedState, finishedState);
  if (BigInt(bytes.byteLength) !== finishedState.size) {
    throw new HistoryMigrationError(
      "ATTACHMENT_MAPPING_CHANGED",
      "人工附件映射计划在固定文件句柄读取期间发生变化。",
    );
  }
  return { bytes, state: finishedState };
}

function assertSamePrivateFileState(
  expected: PrivateFileSecurityState,
  actual: PrivateFileSecurityState,
): void {
  if (
    expected.device !== actual.device ||
    expected.inode !== actual.inode ||
    expected.uid !== actual.uid ||
    expected.mode !== actual.mode ||
    expected.size !== actual.size ||
    expected.ctimeNs !== actual.ctimeNs
  ) {
    throw new HistoryMigrationError(
      "ATTACHMENT_MAPPING_CHANGED",
      "附件映射私有文件的身份、权限、大小或状态时间发生变化。",
    );
  }
}

async function assertPublishedPrivateFile(
  directoryHandle: Awaited<ReturnType<typeof open>>,
  name: string,
  expectedContent: string | Uint8Array,
): Promise<void> {
  const actual = await readSecurePrivateFileThroughDirectoryHandle(
    directoryHandle,
    name,
    maximumPrivateJsonBytes,
    new Map(),
  );
  const expected =
    typeof expectedContent === "string"
      ? new TextEncoder().encode(expectedContent)
      : expectedContent;
  if (actual === undefined || !bytesEqual(actual, expected)) {
    throw new HistoryMigrationError(
      "ATTACHMENT_MAPPING_CHANGED",
      "附件映射私有输出在最终标记发布后无法逐字节复核。",
    );
  }
}

export function parseStablePrivateJson(bytes: Uint8Array | undefined): unknown {
  if (bytes === undefined) {
    throw new HistoryMigrationError("ATTACHMENT_MAPPING_CHANGED", "附件映射私有 JSON 文件不存在。");
  }
  try {
    return JSON.parse(decodeUtf8(bytes));
  } catch {
    throw new HistoryMigrationError("SOURCE_FILE_INVALID", "私有 JSON 文件格式不正确。");
  }
}

function effectiveUserId(): bigint {
  if (typeof process.geteuid !== "function") {
    throw new HistoryMigrationError(
      "PREPARE_RESUME_UNSAFE",
      "附件映射私有文件检查只允许在可验证当前用户的 Linux 服务器运行。",
    );
  }
  return BigInt(process.geteuid());
}

function bytesEqual(first: Uint8Array, second: Uint8Array): boolean {
  if (first.byteLength !== second.byteLength) return false;
  return first.every((value, index) => value === second[index]);
}

async function openStablePrivateDirectory(path: string): Promise<{
  readonly handle: Awaited<ReturnType<typeof open>>;
}> {
  // 历史迁移只在 Linux 服务器运行。逐级持有目录句柄，避免“先 realpath、后 open”期间
  // 任一父目录被换成符号链接；后续 I/O 都相对于最后一个句柄完成。
  const components = resolve(path)
    .split("/")
    .filter((component) => component.length > 0);
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open("/", constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    for (const component of components) {
      const next = await open(
        joinThroughDirectoryHandle(handle.fd, component),
        constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
      );
      const metadata = await next.stat();
      if (!metadata.isDirectory()) {
        await next.close().catch(() => undefined);
        throw new Error("not a directory");
      }
      const previous = handle;
      handle = next;
      await previous.close();
    }
    return { handle };
  } catch {
    await handle?.close().catch(() => undefined);
    throw new HistoryMigrationError(
      "INVALID_ARGUMENTS",
      "私有目录经过符号链接、身份发生变化或无法安全打开。",
    );
  }
}

function joinThroughDirectoryHandle(directoryFileDescriptor: number, name: string): string {
  if (name.length === 0 || name === "." || name === ".." || name.includes("/")) {
    throw new HistoryMigrationError("INVALID_ARGUMENTS", "私有文件名不安全。");
  }
  return `/proc/self/fd/${directoryFileDescriptor}/${name}`;
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
  return pathFromRoot.length === 0 || (!pathFromRoot.startsWith("..") && !isAbsolute(pathFromRoot));
}
