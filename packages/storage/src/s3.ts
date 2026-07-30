import { createHash, randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import {
  CopyObjectCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  type S3Client
} from "@aws-sdk/client-s3";
import { Upload } from "@aws-sdk/lib-storage";
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

export interface S3FileStorageOptions {
  readonly client: S3Client;
  readonly bucket: string;
  readonly keyPrefix?: string;
  readonly limits: StorageLimits;
}

export class S3FileStorage implements FileStorage {
  readonly #client: S3Client;
  readonly #bucket: string;
  readonly #keyPrefix: string;
  readonly #limits: StorageLimits;

  public constructor(options: S3FileStorageOptions) {
    this.#client = options.client;
    this.#bucket = validateBucket(options.bucket);
    this.#keyPrefix = validatePrefix(options.keyPrefix ?? "urmotiv");
    this.#limits = resolveStorageLimits(options.limits);
  }

  public async stage(input: StageFileInput): Promise<StagedFile> {
    const metadata = validateFileMetadata(input, this.#limits);
    const id = randomUUID();
    const stagingKey = this.#stagingKey(id);
    const hash = createHash("sha256");
    const inspection = { byteSize: 0 };
    const content = inspectContent(input.content, this.#limits.maxBytes, hash, inspection);
    const upload = new Upload({
      client: this.#client,
      params: {
        Bucket: this.#bucket,
        Key: stagingKey,
        Body: Readable.from(content),
        ContentType: metadata.mediaType
      }
    });

    try {
      await upload.done();
      return {
        id,
        ...metadata,
        byteSize: inspection.byteSize,
        sha256: hash.digest("hex"),
        stagingKey
      };
    } catch (error) {
      await upload.abort().catch(() => undefined);
      await this.#deleteKey(stagingKey).catch(() => undefined);
      if (error instanceof StorageError) {
        throw error;
      }
      throw new StorageError("STORAGE_WRITE_FAILED", "文件写入对象存储临时区失败。", {
        cause: error
      });
    }
  }

  public async publish(stagedFile: StagedFile): Promise<StoredFile> {
    const staged = stagedFileSchema.parse(stagedFile);
    if (staged.stagingKey !== this.#stagingKey(staged.id)) {
      throw new StorageError("INVALID_STORAGE_KEY", "临时文件位置不正确。");
    }
    const storageKey = this.#storageKey(staged.id);

    try {
      await this.#client.send(
        new CopyObjectCommand({
          Bucket: this.#bucket,
          Key: storageKey,
          CopySource: copySource(this.#bucket, staged.stagingKey),
          ContentType: staged.mediaType,
          MetadataDirective: "REPLACE"
        })
      );
      await this.#deleteKey(staged.stagingKey);
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
        this.#deleteKey(storageKey),
        this.#deleteKey(staged.stagingKey)
      ]);
      throw new StorageError(
        "STORAGE_PUBLISH_FAILED",
        "文件从对象存储临时区发布到正式区失败。",
        { cause: error }
      );
    }
  }

  public async discard(stagedFile: StagedFile): Promise<void> {
    const staged = stagedFileSchema.parse(stagedFile);
    if (staged.stagingKey !== this.#stagingKey(staged.id)) {
      throw new StorageError("INVALID_STORAGE_KEY", "临时文件位置不正确。");
    }
    await this.#deleteKey(staged.stagingKey).catch((error) => {
      throw new StorageError("STORAGE_DELETE_FAILED", "清理对象存储临时文件失败。", {
        cause: error
      });
    });
  }

  public async open(
    storedFile: Pick<StoredFile, "id" | "storageKey">
  ): Promise<AsyncIterable<Uint8Array>> {
    this.#assertPublishedFile(storedFile);
    try {
      const response = await this.#client.send(
        new GetObjectCommand({ Bucket: this.#bucket, Key: storedFile.storageKey })
      );
      const body: unknown = response.Body;
      if (
        typeof body !== "object" ||
        body === null ||
        typeof (body as AsyncIterable<Uint8Array>)[Symbol.asyncIterator] !== "function"
      ) {
        throw new StorageError("STORAGE_READ_FAILED", "对象存储没有返回可读取的文件内容。");
      }
      return body as AsyncIterable<Uint8Array>;
    } catch (error) {
      if (error instanceof StorageError) {
        throw error;
      }
      throw new StorageError("OBJECT_NOT_FOUND", "文件不存在或已被清理。", { cause: error });
    }
  }

  public async delete(storedFile: Pick<StoredFile, "id" | "storageKey">): Promise<void> {
    this.#assertPublishedFile(storedFile);
    await this.#deleteKey(storedFile.storageKey).catch((error) => {
      throw new StorageError("STORAGE_DELETE_FAILED", "删除对象存储文件失败。", {
        cause: error
      });
    });
  }

  #assertPublishedFile(storedFile: Pick<StoredFile, "id" | "storageKey">): void {
    const id = storageIdSchema.safeParse(storedFile.id);
    if (!id.success || storedFile.storageKey !== this.#storageKey(storedFile.id)) {
      throw new StorageError("INVALID_STORAGE_KEY", "正式文件位置不正确。");
    }
  }

  #stagingKey(id: string): string {
    return `${this.#keyPrefix}/staging/${id}.part`;
  }

  #storageKey(id: string): string {
    return `${this.#keyPrefix}/objects/${id}`;
  }

  async #deleteKey(key: string): Promise<void> {
    await this.#client.send(new DeleteObjectCommand({ Bucket: this.#bucket, Key: key }));
  }
}

function validateBucket(bucket: string): string {
  const normalized = bucket.trim();
  if (!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(normalized)) {
    throw new StorageError("INVALID_STORAGE_KEY", "对象存储桶名称格式不正确。");
  }
  return normalized;
}

function validatePrefix(prefix: string): string {
  const normalized = prefix.replace(/^\/+|\/+$/g, "");
  if (
    normalized.length === 0 ||
    normalized.length > 200 ||
    normalized.includes("\\") ||
    normalized.split("/").some((part) => part.length === 0 || part === "." || part === "..")
  ) {
    throw new StorageError("INVALID_STORAGE_KEY", "对象存储路径前缀格式不正确。");
  }
  return normalized;
}

function copySource(bucket: string, key: string): string {
  return `${bucket}/${key.split("/").map(encodeURIComponent).join("/")}`;
}
