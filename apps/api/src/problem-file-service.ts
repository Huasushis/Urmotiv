import {
  problemFileSummarySchema,
  type ProblemFileCategory,
  type ProblemFileListResponse,
  type ProblemFileSummary,
  type ProblemRevisionFileRecord,
  type UploadProblemFileInput
} from "@urmotiv/contracts";
import { StorageError, type FileStorage, type StagedFile, type StoredFile } from "@urmotiv/storage";
import { ApiError, conflict, forbidden, notFound } from "./errors";
import type { StoredProblem, StoredUser } from "./domain";
import { type ProblemFileStore, ProblemFileStoreError } from "./problem-file-store";
import type { ProblemService } from "./service";
import {
  InvalidStatementImageError,
  prepareStatementImage,
  StatementImageReadError,
  type PreparedStatementImage
} from "./statement-image";

/** 这两类文件跟随题面公开；能看题面就能看到并下载它们。 */
export const publicProblemFileCategories = [
  "statement_image",
  "public_attachment"
] as const satisfies readonly ProblemFileCategory[];

/** 这些属于内部评测资料，读写都需要单独的测试数据权限。 */
export const internalProblemFileCategories = [
  "testdata",
  "checker",
  "interactor",
  "answer_checker",
  "standard_solution",
  "internal_attachment"
] as const satisfies readonly ProblemFileCategory[];

const internalCategorySet: ReadonlySet<ProblemFileCategory> = new Set(
  internalProblemFileCategories
);

export function isInternalProblemFileCategory(category: ProblemFileCategory): boolean {
  return internalCategorySet.has(category);
}

export interface ProblemFileUploadResult {
  readonly item: ProblemFileSummary;
  readonly revision: number;
}

export interface ProblemFileRemovalResult {
  readonly ok: true;
  readonly revision: number;
}

export interface ProblemFileDownload {
  readonly item: ProblemFileSummary;
  readonly stream: AsyncIterable<Uint8Array>;
}

export interface ProblemFileServiceDependencies {
  readonly service: ProblemService;
  readonly metadata: ProblemFileStore;
  readonly storage: FileStorage;
}

/**
 * 题目文件的读写入口。它把三层职责串在一起并保持顺序：
 * 先由 ProblemService 判断当前用户能否看到、编辑这道题；再按文件类别检查测试数据权限；
 * 最后才允许触碰文件元数据和对象存储。无权访问的题目或文件一律按“不存在”返回，
 * 存储键和对象存储路径永远不出现在返回值里。
 */
export class ProblemFileService {
  readonly #service: ProblemService;
  readonly #metadata: ProblemFileStore;
  readonly #storage: FileStorage;

  public constructor(dependencies: ProblemFileServiceDependencies) {
    this.#service = dependencies.service;
    this.#metadata = dependencies.metadata;
    this.#storage = dependencies.storage;
  }

  public async listFiles(user: StoredUser, problemId: string): Promise<ProblemFileListResponse> {
    const { problem, capabilities } = await this.#service.getProblemForFileAccess(user, problemId);
    const revisionId = requireRevisionId(problem);
    const records = capabilities.canReadTestdata
      ? await this.#metadata.listRevisionFiles(revisionId)
      : await this.#metadata.listRevisionFilesForCategories(revisionId, publicProblemFileCategories);
    return { items: records.map(toSummary) };
  }

  /**
   * 上传顺序是固定的：文件先进入对象存储的正式区，然后在一个数据库事务里创建新的题目
   * 版本、写入文件信息并建立关联。事务失败时删除刚发布的对象文件，不留下无主文件。
   */
  public async uploadFile(
    user: StoredUser,
    problemId: string,
    input: UploadProblemFileInput,
    content: AsyncIterable<Uint8Array>
  ): Promise<ProblemFileUploadResult> {
    const { capabilities } = await this.#service.getProblemForFileAccess(user, problemId);
    if (!capabilities.canEdit) {
      throw forbidden();
    }
    if (isInternalProblemFileCategory(input.category) && !capabilities.canWriteTestdata) {
      throw forbidden("上传测试数据或内部资料需要测试数据管理权限。");
    }

    let preparedImage: PreparedStatementImage | undefined;
    if (input.category === "statement_image") {
      try {
        preparedImage = await prepareStatementImage(
          input.mediaType,
          [input.logicalPath, input.originalName],
          content
        );
      } catch (error) {
        if (error instanceof InvalidStatementImageError) {
          throw invalidStatementImage();
        }
        if (error instanceof StatementImageReadError) {
          throw storageFailed();
        }
        throw storageFailed();
      }
    }
    const checkedContent = preparedImage?.content ?? content;

    let staged: StagedFile;
    try {
      staged = await this.#storage.stage({
        originalName: input.originalName,
        mediaType: input.mediaType,
        content: checkedContent
      });
    } catch (error) {
      await preparedImage?.close();
      if (
        input.category === "statement_image" &&
        error instanceof StorageError &&
        error.code === "INVALID_STREAM"
      ) {
        throw invalidStatementImage();
      }
      throw translateStorageError(error);
    }
    await preparedImage?.close();
    let stored: StoredFile;
    try {
      stored = await this.#storage.publish(staged);
    } catch (error) {
      await this.#storage.discard(staged).catch(() => undefined);
      throw translateStorageError(error);
    }

    let linked: ProblemRevisionFileRecord | undefined;
    try {
      const updated = await this.#service.updateProblem(
        user,
        problemId,
        { expectedRevision: input.expectedRevision },
        async (revisionId, executor) => {
          if (input.replaceExisting) {
            const copied = await this.#metadata.listRevisionFiles(revisionId, executor);
            const existing = copied.find((record) => record.logicalPath === input.logicalPath);
            if (existing !== undefined) {
              await this.#metadata.removeFileRelation(revisionId, existing.id, executor);
            }
          }
          await this.#metadata.createStoredFile(
            {
              id: stored.id,
              purpose: "problem",
              storageKey: stored.storageKey,
              originalName: stored.originalName,
              mediaType: stored.mediaType,
              byteSize: stored.byteSize,
              sha256: stored.sha256,
              createdByUserId: user.id
            },
            executor
          );
          linked = await this.#metadata.linkFileToRevision(
            {
              revisionId,
              fileId: stored.id,
              category: input.category,
              logicalPath: input.logicalPath,
              position: input.position
            },
            executor
          );
          if (linked === undefined) {
            throw new ProblemFileStoreError("WRITE_FAILED", "文件没有关联到新的题目版本。");
          }
        }
      );

      if (linked === undefined) {
        throw new ProblemFileStoreError("WRITE_FAILED", "文件没有关联到新的题目版本。");
      }
      return { item: toSummary(linked), revision: updated.revision };
    } catch (error) {
      await this.#storage.delete(stored).catch(() => undefined);
      throw translateMetadataError(error);
    }
  }

  public async downloadFile(
    user: StoredUser,
    problemId: string,
    fileId: string
  ): Promise<ProblemFileDownload> {
    const access = await this.#service.getProblemForFileAccess(user, problemId);
    const record = await this.#findVisibleFile(access, fileId, "read");
    const item = toSummary(record);
    try {
      const stream = await this.#storage.open({ id: record.id, storageKey: record.storageKey });
      return {
        item,
        stream: await prepareDownloadStream(stream, record.byteSize)
      };
    } catch (error) {
      if (error instanceof StorageError && error.code === "OBJECT_NOT_FOUND") {
        throw notFound();
      }
      if (error instanceof ApiError) {
        throw error;
      }
      throw translateStorageError(error);
    }
  }

  /**
   * 删除只是在新的题目版本里取消这一条关联。对象文件保持不动，因为旧版本仍然引用它，
   * 历史修订必须保持完整。
   */
  public async removeFile(
    user: StoredUser,
    problemId: string,
    fileId: string,
    expectedRevision: number
  ): Promise<ProblemFileRemovalResult> {
    const access = await this.#service.getProblemForFileAccess(user, problemId);
    if (!access.capabilities.canEdit) {
      throw forbidden();
    }
    const record = await this.#findVisibleFile(access, fileId, "write");
    if (isInternalProblemFileCategory(record.category) && !access.capabilities.canWriteTestdata) {
      throw forbidden("移除测试数据或内部资料需要测试数据管理权限。");
    }

    const updated = await this.#service.updateProblem(
      user,
      problemId,
      { expectedRevision },
      async (revisionId, executor) => {
        const removed = await this.#metadata.removeFileRelation(revisionId, fileId, executor);
        if (!removed) {
          throw conflict("文件已被其他操作移除，请刷新后重试。");
        }
      }
    );
    return { ok: true, revision: updated.revision };
  }

  /**
   * 在当前题目版本中查找一个文件。查询范围先按权限收窄类别，所以没有测试数据权限的
   * 用户查内部文件时得到与“文件不存在”完全相同的结果。
   */
  async #findVisibleFile(
    access: { readonly problem: StoredProblem; readonly capabilities: ProblemFileAccessCapabilities },
    fileId: string,
    mode: "read" | "write"
  ): Promise<ProblemRevisionFileRecord> {
    const revisionId = requireRevisionId(access.problem);
    const canSeeInternal =
      mode === "read"
        ? access.capabilities.canReadTestdata
        : access.capabilities.canReadTestdata || access.capabilities.canWriteTestdata;
    const records = canSeeInternal
      ? await this.#metadata.listRevisionFiles(revisionId)
      : await this.#metadata.listRevisionFilesForCategories(revisionId, publicProblemFileCategories);
    const record = records.find((candidate) => candidate.id === fileId);
    if (record === undefined) {
      throw notFound();
    }
    return record;
  }
}

interface ProblemFileAccessCapabilities {
  readonly canReadTestdata: boolean;
  readonly canWriteTestdata: boolean;
}

const maximumConsecutiveEmptyDownloadChunks = 1024;

function requireRevisionId(problem: StoredProblem): string {
  if (problem.revisionId === undefined) {
    throw new Error("题目文件功能需要数据库存储提供版本编号。");
  }
  return problem.revisionId;
}

function toSummary(record: ProblemRevisionFileRecord): ProblemFileSummary {
  return problemFileSummarySchema.parse({
    id: record.id,
    category: record.category,
    logicalPath: record.logicalPath,
    position: record.position,
    originalName: record.originalName,
    mediaType: record.mediaType,
    byteSize: record.byteSize,
    sha256: record.sha256,
    createdAt: record.createdAt
  });
}

function invalidStatementImage(): ApiError {
  return new ApiError(
    422,
    "INVALID_STATEMENT_IMAGE",
    "题面图片必须是内容与声明类型一致的 PNG、JPEG、GIF 或 WebP 文件。"
  );
}

function storageFailed(): ApiError {
  return new ApiError(500, "STORAGE_FAILED", "文件存储暂时不可用，请稍后重试。");
}

async function closeDownloadIterator(iterator: AsyncIterator<Uint8Array>): Promise<void> {
  try {
    await iterator.return?.();
  } catch {
    // 关闭失败不能覆盖固定的存储错误。
  }
}

function closeDownloadIteratorOnce(iterator: AsyncIterator<Uint8Array>): () => Promise<void> {
  let closing: Promise<void> | undefined;
  return () => {
    closing ??= closeDownloadIterator(iterator);
    return closing;
  };
}

async function prepareDownloadStream(
  source: AsyncIterable<Uint8Array>,
  expectedByteSize: number
): Promise<AsyncIterable<Uint8Array>> {
  let iterator: AsyncIterator<Uint8Array>;
  try {
    iterator = source[Symbol.asyncIterator]();
  } catch {
    throw new StorageError("STORAGE_READ_FAILED", "文件读取失败。");
  }
  const close = closeDownloadIteratorOnce(iterator);

  let emptyChunks = 0;
  while (true) {
    let step: IteratorResult<Uint8Array>;
    try {
      step = await iterator.next();
    } catch {
      await close();
      throw new StorageError("STORAGE_READ_FAILED", "文件读取失败。");
    }
    if (typeof step !== "object" || step === null) {
      await close();
      throw new StorageError("STORAGE_READ_FAILED", "文件读取失败。");
    }
    if (step.done === true) {
      await close();
      if (expectedByteSize !== 0) {
        throw new StorageError("STORAGE_READ_FAILED", "文件读取失败。");
      }
      return emptyDownloadStream();
    }
    if (!(step.value instanceof Uint8Array)) {
      await close();
      throw new StorageError("STORAGE_READ_FAILED", "文件读取失败。");
    }
    if (step.value.byteLength === 0) {
      emptyChunks += 1;
      if (emptyChunks > maximumConsecutiveEmptyDownloadChunks) {
        await close();
        throw new StorageError("STORAGE_READ_FAILED", "文件读取失败。");
      }
      continue;
    }
    if (step.value.byteLength > expectedByteSize) {
      await close();
      throw new StorageError("STORAGE_READ_FAILED", "文件读取失败。");
    }
    return replayDownloadStream(step.value, iterator, expectedByteSize, close);
  }
}

function emptyDownloadStream(): AsyncIterable<Uint8Array> {
  return {
    [Symbol.asyncIterator]: () => ({
      next: async () => ({ done: true, value: undefined })
    })
  };
}

async function* replayDownloadStream(
  firstChunk: Uint8Array,
  iterator: AsyncIterator<Uint8Array>,
  expectedByteSize: number,
  close: () => Promise<void>
): AsyncGenerator<Uint8Array> {
  let completed = false;
  let emittedBytes = firstChunk.byteLength;
  let emptyChunks = 0;
  try {
    yield firstChunk;
    while (true) {
      let step: IteratorResult<Uint8Array>;
      try {
        step = await iterator.next();
      } catch {
        throw storageFailed();
      }
      if (typeof step !== "object" || step === null) {
        throw storageFailed();
      }
      if (step.done === true) {
        if (emittedBytes !== expectedByteSize) {
          throw storageFailed();
        }
        completed = true;
        await close();
        return;
      }
      if (!(step.value instanceof Uint8Array)) {
        throw storageFailed();
      }
      if (step.value.byteLength === 0) {
        emptyChunks += 1;
        if (emptyChunks > maximumConsecutiveEmptyDownloadChunks) {
          throw storageFailed();
        }
        continue;
      }
      emptyChunks = 0;
      if (emittedBytes + step.value.byteLength > expectedByteSize) {
        throw storageFailed();
      }
      emittedBytes += step.value.byteLength;
      yield step.value;
    }
  } finally {
    if (!completed) {
      await close();
    }
  }
}

function translateMetadataError(error: unknown): unknown {
  if (error instanceof ProblemFileStoreError && error.code === "FILE_LINK_CONFLICT") {
    return conflict("该题目版本中已有相同路径的文件。可以选择替换，或换一个文件路径。");
  }
  if (error instanceof ProblemFileStoreError) {
    return new ApiError(500, "FILE_METADATA_FAILED", "保存文件信息失败，请稍后重试。");
  }
  return error;
}

function translateStorageError(error: unknown): unknown {
  if (!(error instanceof StorageError)) {
    return new ApiError(500, "STORAGE_FAILED", "文件存储暂时不可用，请稍后重试。");
  }
  if (error.code === "FILE_TOO_LARGE") {
    return new ApiError(413, "FILE_TOO_LARGE", "文件超出允许的大小限制。");
  }
  if (error.code === "INVALID_FILE_NAME" || error.code === "INVALID_MEDIA_TYPE" || error.code === "INVALID_STREAM") {
    return new ApiError(422, "INVALID_FILE", "文件名或文件类型不符合要求。");
  }
  return new ApiError(500, "STORAGE_FAILED", "文件存储暂时不可用，请稍后重试。");
}
