import { createHash, randomUUID } from "node:crypto";
import { isAbsolute, relative, resolve } from "node:path";
import { link, mkdir, open, readdir, rm, rmdir, stat } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import {
  stagedFileSchema,
  storageIdSchema,
  type FileStorage,
  type StageFileInput,
  type StagedFile,
  type StoredFile,
  type StorageLimits,
  StorageError
} from "./types";
import {
  inspectContent,
  resolveStorageLimits,
  validateFileMetadata
} from "./validation";

export interface LocalFileStorageOptions {
  readonly rootDirectory: string;
  readonly limits: StorageLimits;
}

export class LocalFileStorage implements FileStorage {
  readonly #rootDirectory: string;
  readonly #limits: StorageLimits;

  public constructor(options: LocalFileStorageOptions) {
    this.#rootDirectory = resolve(options.rootDirectory);
    this.#limits = resolveStorageLimits(options.limits);
  }

  public async stage(input: StageFileInput): Promise<StagedFile> {
    const metadata = validateFileMetadata(input, this.#limits);
    const id = input.id ?? randomUUID();
    await this.#ensureDirectories();
    storageIdSchema.parse(id);
    // 所有权安全：每个竞争者使用自己的 staging 路径 staging/<id>/<attempt>.part，
    // 而非共享 staging/<id>.part。确定性对象键 objects/<id> 保持不变——
    // 原子 publish 通过 link 选出一个完整对象。失败方只删除自己的 staging 文件。
    const attemptId = randomUUID();
    const stagingKey = `staging/${id}/${attemptId}.part`;
    const stagingDir = resolve(this.#rootDirectory, "staging", id);
    const stagingPath = resolve(stagingDir, `${attemptId}.part`);
    await mkdir(stagingDir, { recursive: true });

    let handle: FileHandle | undefined;
    try {
      handle = await open(stagingPath, "wx", 0o600);
      const hash = createHash("sha256");
      const inspection = { byteSize: 0 };
      for await (const chunk of inspectContent(
        input.content,
        this.#limits.maxBytes,
        hash,
        inspection
      )) {
        await writeAll(handle, chunk);
      }
      await handle.sync();
      await handle.close();
      handle = undefined;

      return {
        id,
        ...metadata,
        byteSize: inspection.byteSize,
        sha256: hash.digest("hex"),
        stagingKey
      };
    } catch (error) {
      await handle?.close().catch(() => undefined);
      // 只清理自己拥有的 staging 文件——绝不触碰其他竞争者的文件。
      await rm(stagingPath, { force: true }).catch(() => undefined);
      // 清理可能空的 staging 子目录（best-effort）。
      await rmdir(stagingDir).catch(() => undefined);
      if (error instanceof StorageError) {
        throw error;
      }
      throw new StorageError(
        "STORAGE_WRITE_FAILED",
        "文件写入临时区失败。",
        { cause: error }
      );
    }
  }

  public async publish(stagedFile: StagedFile): Promise<StoredFile> {
    const staged = stagedFileSchema.parse(stagedFile);
    // 接受新的所有权安全 staging 键格式 staging/<id>/<attempt>.part。
    const stagingKeyPrefix = `staging/${staged.id}/`;
    if (!staged.stagingKey.startsWith(stagingKeyPrefix) || !staged.stagingKey.endsWith(".part")) {
      throw new StorageError("INVALID_STORAGE_KEY", "临时文件位置不正确。");
    }

    const storageKey = `objects/${staged.id}`;
    const stagingPath = this.#pathForKey(staged.stagingKey, "staging");
    const stagingDir = resolve(this.#rootDirectory, "staging", staged.id);
    const storagePath = this.#pathForKey(storageKey, "objects");
    await this.#ensureDirectories();
    let objectExists = false;
    try {
      const objStat = await stat(storagePath);
      objectExists = objStat.isFile();
    } catch {
      // 正式区无对象，继续正常发布。
    }

    if (objectExists) {
      const objStat = await stat(storagePath);
      if (objStat.size !== staged.byteSize) {
        // 清理自己的 staging 文件后失败。
        await rm(stagingPath, { force: true }).catch(() => undefined);
        await rmdir(stagingDir).catch(() => undefined);
        throw new StorageError(
          "STORAGE_PUBLISH_FAILED",
          "已存在的正式对象大小与记录不符。",
        );
      }
      await rm(stagingPath, { force: true }).catch(() => undefined);
      await rmdir(stagingDir).catch(() => undefined);
      return {
        id: staged.id,
        originalName: staged.originalName,
        mediaType: staged.mediaType,
        byteSize: staged.byteSize,
        sha256: staged.sha256,
        storageKey,
      };
    }

    // 正式区无对象：正常发布（link 临时文件到正式区）。
    // 原子 link：第一个竞争者获胜，后续 link 得到 EEXIST。
    try {
      await link(stagingPath, storagePath);
      await rm(stagingPath);
      await rmdir(stagingDir).catch(() => undefined);
      return {
        id: staged.id,
        originalName: staged.originalName,
        mediaType: staged.mediaType,
        byteSize: staged.byteSize,
        sha256: staged.sha256,
        storageKey,
      };
    } catch (error) {
      // link 失败：可能是 EEXIST（另一竞争者已 link）或其他错误。
      // 只清理自己的 staging 文件——绝不删除 objects 路径（可能属于获胜方）。
      await rm(stagingPath, { force: true }).catch(() => undefined);
      await rmdir(stagingDir).catch(() => undefined);
      if (error instanceof Error && (error as NodeJS.ErrnoException).code === "EEXIST") {
        try {
          const objStat = await stat(storagePath);
          if (objStat.isFile() && objStat.size === staged.byteSize) {
            await rmdir(stagingDir).catch(() => undefined);
            return {
              id: staged.id,
              originalName: staged.originalName,
              mediaType: staged.mediaType,
              byteSize: staged.byteSize,
              sha256: staged.sha256,
              storageKey,
            };
          }
        } catch {
          // 对象可能在竞争中被删除——继续抛出失败。
        }
        throw new StorageError(
          "STORAGE_PUBLISH_FAILED",
          "并发发布竞争失败；另一竞争者的对象大小不匹配。",
          { cause: error },
        );
      }
      throw new StorageError(
        "STORAGE_PUBLISH_FAILED",
        "文件从临时区发布到正式区失败。",
        { cause: error },
      );
    }
  }

  public async discard(stagedFile: StagedFile): Promise<void> {
    const staged = stagedFileSchema.parse(stagedFile);
    // 接受新的所有权安全 staging 键格式 staging/<id>/<attempt>.part。
    const stagingKeyPrefix = `staging/${staged.id}/`;
    if (!staged.stagingKey.startsWith(stagingKeyPrefix) || !staged.stagingKey.endsWith(".part")) {
      throw new StorageError("INVALID_STORAGE_KEY", "临时文件位置不正确。");
    }
    await rm(this.#pathForKey(staged.stagingKey, "staging"), { force: true }).catch((error) => {
      throw new StorageError("STORAGE_DELETE_FAILED", "清理临时文件失败。", { cause: error });
    });
    // 清理可能空的 staging 子目录（best-effort）。
    await rmdir(resolve(this.#rootDirectory, "staging", staged.id)).catch(() => undefined);
  }

  public async open(
    storedFile: Pick<StoredFile, "id" | "storageKey">
  ): Promise<AsyncIterable<Uint8Array>> {
    const storagePath = this.#publishedPath(storedFile);
    let handle: FileHandle;
    try {
      handle = await open(storagePath, "r");
    } catch (error) {
      throw new StorageError("OBJECT_NOT_FOUND", "文件不存在或已被清理。", { cause: error });
    }

    return readFromHandle(handle);
  }

  public async delete(storedFile: Pick<StoredFile, "id" | "storageKey">): Promise<void> {
    const storagePath = this.#publishedPath(storedFile);
    await rm(storagePath, { force: true }).catch((error) => {
      throw new StorageError("STORAGE_DELETE_FAILED", "删除文件失败。", { cause: error });
    });
  }

  async #ensureDirectories(): Promise<void> {
    await Promise.all([
      mkdir(resolve(this.#rootDirectory, "staging"), { recursive: true }),
      mkdir(resolve(this.#rootDirectory, "objects"), { recursive: true })
    ]);
  }

  #publishedPath(storedFile: Pick<StoredFile, "id" | "storageKey">): string {
    const id = storageIdSchema.safeParse(storedFile.id);
    if (!id.success || storedFile.storageKey !== `objects/${storedFile.id}`) {
      throw new StorageError("INVALID_STORAGE_KEY", "正式文件位置不正确。");
    }
    return this.#pathForKey(storedFile.storageKey, "objects");
  }

  #pathForKey(key: string, expectedArea: "staging" | "objects"): string {
    const pattern =
      expectedArea === "staging"
        ? /^staging\/[0-9a-f-]{36}\/[0-9a-f-]{36}\.part$/
        : /^objects\/[0-9a-f-]{36}$/;
    if (!pattern.test(key)) {
      throw new StorageError("INVALID_STORAGE_KEY", "文件位置格式不正确。");
    }

    const filePath = resolve(this.#rootDirectory, ...key.split("/"));
    const relativePath = relative(this.#rootDirectory, filePath);
    if (relativePath.startsWith("..") || isAbsolute(relativePath)) {
      throw new StorageError("INVALID_STORAGE_KEY", "文件位置超出存储目录。");
    }
    return filePath;
  }
}

async function writeAll(handle: FileHandle, bytes: Uint8Array): Promise<void> {
  let offset = 0;
  while (offset < bytes.byteLength) {
    const result = await handle.write(bytes, offset, bytes.byteLength - offset);
    if (result.bytesWritten <= 0) {
      throw new StorageError("STORAGE_WRITE_FAILED", "文件写入没有取得进展。");
    }
    offset += result.bytesWritten;
  }
}

async function* readFromHandle(handle: FileHandle): AsyncGenerator<Uint8Array> {
  const stream = handle.createReadStream({ autoClose: false });
  try {
    for await (const chunk of stream) {
      if (!(chunk instanceof Uint8Array)) {
        throw new StorageError("STORAGE_READ_FAILED", "文件读取返回了无效内容。");
      }
      yield chunk;
    }
  } catch (error) {
    if (error instanceof StorageError) {
      throw error;
    }
    throw new StorageError("STORAGE_READ_FAILED", "读取文件失败。", { cause: error });
  } finally {
    await handle.close().catch(() => undefined);
  }
}
