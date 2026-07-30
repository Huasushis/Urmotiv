import { createHash, randomUUID } from "node:crypto";
import { isAbsolute, relative, resolve } from "node:path";
import { link, mkdir, open, rm } from "node:fs/promises";
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
    const id = randomUUID();
    const stagingKey = `staging/${id}.part`;
    const stagingPath = this.#pathForKey(stagingKey, "staging");
    await this.#ensureDirectories();

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
      await rm(stagingPath, { force: true }).catch(() => undefined);
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
    const expectedStagingKey = `staging/${staged.id}.part`;
    if (staged.stagingKey !== expectedStagingKey) {
      throw new StorageError("INVALID_STORAGE_KEY", "临时文件位置不正确。");
    }

    const storageKey = `objects/${staged.id}`;
    const stagingPath = this.#pathForKey(staged.stagingKey, "staging");
    const storagePath = this.#pathForKey(storageKey, "objects");
    await this.#ensureDirectories();
    let linked = false;
    try {
      await link(stagingPath, storagePath);
      linked = true;
      await rm(stagingPath);
      return {
        id: staged.id,
        originalName: staged.originalName,
        mediaType: staged.mediaType,
        byteSize: staged.byteSize,
        sha256: staged.sha256,
        storageKey
      };
    } catch (error) {
      await Promise.allSettled([
        ...(linked ? [rm(storagePath, { force: true })] : []),
        rm(stagingPath, { force: true })
      ]);
      throw new StorageError(
        "STORAGE_PUBLISH_FAILED",
        "文件从临时区发布到正式区失败。",
        { cause: error }
      );
    }
  }

  public async discard(stagedFile: StagedFile): Promise<void> {
    const staged = stagedFileSchema.parse(stagedFile);
    const expectedStagingKey = `staging/${staged.id}.part`;
    if (staged.stagingKey !== expectedStagingKey) {
      throw new StorageError("INVALID_STORAGE_KEY", "临时文件位置不正确。");
    }
    await rm(this.#pathForKey(staged.stagingKey, "staging"), { force: true }).catch((error) => {
      throw new StorageError("STORAGE_DELETE_FAILED", "清理临时文件失败。", { cause: error });
    });
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
        ? /^staging\/[0-9a-f-]{36}\.part$/
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
