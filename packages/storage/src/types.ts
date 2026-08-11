import { z } from "zod";

export const storageIdSchema = z.string().uuid();

export const stagedFileSchema = z
  .object({
    id: storageIdSchema,
    originalName: z.string().min(1).max(500),
    mediaType: z.string().min(3).max(255),
    byteSize: z.number().int().nonnegative(),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    stagingKey: z.string().min(1).max(1024)
  })
  .strict();

export type StagedFile = z.infer<typeof stagedFileSchema>;

export const storedFileSchema = stagedFileSchema
  .omit({ stagingKey: true })
  .extend({ storageKey: z.string().min(1).max(1024) })
  .strict();

export type StoredFile = z.infer<typeof storedFileSchema>;

export interface StorageLimits {
  readonly maxBytes: number;
  readonly allowedMediaTypes?: readonly string[];
}

export interface StageFileInput {
  readonly originalName: string;
  readonly mediaType: string;
  readonly content: AsyncIterable<Uint8Array>;
  /**
   * 调用方提供的存储 UUID，用于可恢复的源意向日志。省略时由存储实现生成。
   * 精确重放（同一 UUID + 同一内容）必须返回相同的 StagedFile。
   */
  readonly id?: string;
}

export interface FileStorage {
  stage(input: StageFileInput): Promise<StagedFile>;
  publish(stagedFile: StagedFile): Promise<StoredFile>;
  discard(stagedFile: StagedFile): Promise<void>;
  open(storedFile: Pick<StoredFile, "id" | "storageKey">): Promise<AsyncIterable<Uint8Array>>;
  delete(storedFile: Pick<StoredFile, "id" | "storageKey">): Promise<void>;
}

export type StorageErrorCode =
  | "INVALID_FILE_NAME"
  | "INVALID_MEDIA_TYPE"
  | "INVALID_STORAGE_KEY"
  | "INVALID_STORAGE_LIMIT"
  | "INVALID_STREAM"
  | "FILE_TOO_LARGE"
  | "OBJECT_NOT_FOUND"
  | "STORAGE_WRITE_FAILED"
  | "STORAGE_READ_FAILED"
  | "STORAGE_DELETE_FAILED"
  | "STORAGE_PUBLISH_FAILED";

export class StorageError extends Error {
  public constructor(
    public readonly code: StorageErrorCode,
    message: string,
    options?: ErrorOptions
  ) {
    super(message, options);
    this.name = "StorageError";
  }
}
