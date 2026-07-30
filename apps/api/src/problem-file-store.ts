import {
  createStoredFileInputSchema,
  linkProblemRevisionFileInputSchema,
  problemFileCategorySchema,
  problemRevisionFileRecordSchema,
  storageKeySchema,
  storedFileRecordSchema,
  type CreateStoredFileInput,
  type LinkProblemRevisionFileInput,
  type ProblemFileCategory,
  type ProblemRevisionFileRecord,
  type StoredFileRecord
} from "@urmotiv/contracts";
import type { DatabaseExecutor, DatabaseHandle } from "@urmotiv/database";
import { type SQL, sql } from "drizzle-orm";

const maximumDatabaseId = 9_223_372_036_854_775_807n;

export const problemFileStoreErrorCodes = [
  "REVISION_NOT_FOUND",
  "TARGET_ALREADY_HAS_FILES",
  "FILE_LINK_CONFLICT",
  "WRITE_FAILED",
  "INVALID_DATABASE_RECORD"
] as const;

export type ProblemFileStoreErrorCode = (typeof problemFileStoreErrorCodes)[number];

/**
 * 这是仅供服务端使用的文件元数据错误。消息不包含文件正文、存储键或题目内容。
 */
export class ProblemFileStoreError extends Error {
  public constructor(
    public readonly code: ProblemFileStoreErrorCode,
    message: string
  ) {
    super(message);
    this.name = "ProblemFileStoreError";
  }
}

interface StoredFileRow extends Record<string, unknown> {
  id: string;
  purpose: string;
  storage_key: string;
  original_name: string;
  media_type: string;
  byte_size: string | number | bigint;
  sha256: string;
  created_by_user_id: string;
  expires_at: Date | string | null;
  deleted_at: Date | string | null;
  created_at: Date | string;
}

interface ProblemRevisionFileRow extends StoredFileRow {
  revision_id: string;
  category: string;
  logical_path: string;
  position: string | number | bigint;
}

interface PreviousRevisionRow extends Record<string, unknown> {
  predecessor_revision_id: string | null;
}

/**
 * 题目文件元数据仓库。
 *
 * 它只读写数据库中的文件信息与版本关联，绝不读取或返回文件字节。调用它的 HTTP 层仍须先完成
 * 当前用户的题目与文件类别权限检查，且不得把 storageKey 直接返回给浏览器。
 */
export class ProblemFileStore {
  public constructor(private readonly database: DatabaseHandle) {}

  /** 写入已由对象存储正式发布的文件元数据。 */
  public async createStoredFile(
    rawInput: CreateStoredFileInput,
    executor: DatabaseExecutor = this.database
  ): Promise<StoredFileRecord> {
    const input = createStoredFileInputSchema.parse(rawInput);

    try {
      const rows = await executor.query<StoredFileRow>(sql`
        INSERT INTO stored_files (
          id,
          purpose,
          storage_key,
          original_name,
          media_type,
          byte_size,
          sha256,
          created_by_user_id,
          expires_at
        ) VALUES (
          ${input.id}::uuid,
          ${input.purpose}::file_purpose,
          ${input.storageKey},
          ${input.originalName},
          ${input.mediaType},
          ${input.byteSize},
          ${input.sha256},
          ${requireDatabaseId(input.createdByUserId)}::bigint,
          ${input.expiresAt ?? null}::timestamptz
        )
        RETURNING
          id::text AS id,
          purpose::text AS purpose,
          storage_key,
          original_name,
          media_type,
          byte_size,
          sha256,
          created_by_user_id::text AS created_by_user_id,
          expires_at,
          deleted_at,
          created_at
      `);
      const row = rows[0];
      if (row === undefined) {
        throw new ProblemFileStoreError("WRITE_FAILED", "文件元数据没有成功写入。");
      }
      return toStoredFileRecord(row);
    } catch (error) {
      throw translateWriteError(error);
    }
  }

  /** 仅返回未删除且未过期的文件元数据。 */
  public async findStoredFile(fileId: string): Promise<StoredFileRecord | undefined> {
    const parsedId = parseUuid(fileId);
    if (parsedId === undefined) {
      return undefined;
    }

    const rows = await this.database.query<StoredFileRow>(sql`
      SELECT
        id::text AS id,
        purpose::text AS purpose,
        storage_key,
        original_name,
        media_type,
        byte_size,
        sha256,
        created_by_user_id::text AS created_by_user_id,
        expires_at,
        deleted_at,
        created_at
      FROM stored_files
      WHERE id = ${parsedId}::uuid
        AND deleted_at IS NULL
        AND (expires_at IS NULL OR expires_at > now())
    `);
    const row = rows[0];
    return row === undefined ? undefined : toStoredFileRecord(row);
  }

  /**
   * 通过服务端内部存储键查找元数据。该方法不是面向浏览器的下载接口。
   */
  public async findStoredFileByStorageKey(storageKey: string): Promise<StoredFileRecord | undefined> {
    const parsedKey = storageKeySchema.safeParse(storageKey);
    if (!parsedKey.success) {
      return undefined;
    }

    const rows = await this.database.query<StoredFileRow>(sql`
      SELECT
        id::text AS id,
        purpose::text AS purpose,
        storage_key,
        original_name,
        media_type,
        byte_size,
        sha256,
        created_by_user_id::text AS created_by_user_id,
        expires_at,
        deleted_at,
        created_at
      FROM stored_files
      WHERE storage_key = ${parsedKey.data}
        AND deleted_at IS NULL
        AND (expires_at IS NULL OR expires_at > now())
    `);
    const row = rows[0];
    return row === undefined ? undefined : toStoredFileRecord(row);
  }

  /** 按固定题目版本列举仍可用的文件元数据，不查询题面、题解或文件正文。 */
  public async listRevisionFiles(
    revisionId: string,
    executor: DatabaseExecutor = this.database
  ): Promise<ProblemRevisionFileRecord[]> {
    return this.listRevisionFilesWithCategories(revisionId, undefined, executor);
  }

  /**
   * Lists only the requested categories, so a caller without internal-file permission never has
   * to query metadata for internal files and filter it in application memory.
   */
  public async listRevisionFilesForCategories(
    revisionId: string,
    categories: readonly ProblemFileCategory[],
    executor: DatabaseExecutor = this.database
  ): Promise<ProblemRevisionFileRecord[]> {
    return this.listRevisionFilesWithCategories(revisionId, categories, executor);
  }

  private async listRevisionFilesWithCategories(
    revisionId: string,
    categories: readonly ProblemFileCategory[] | undefined,
    executor: DatabaseExecutor
  ): Promise<ProblemRevisionFileRecord[]> {
    const parsedRevisionId = parseUuid(revisionId);
    if (parsedRevisionId === undefined) {
      return [];
    }

    const categoryFilter = categoryFilterSql(categories);
    if (categoryFilter === undefined) {
      return [];
    }

    const rows = await executor.query<ProblemRevisionFileRow>(sql`
      SELECT
        association.revision_id::text AS revision_id,
        association.category::text AS category,
        association.logical_path,
        association.position,
        file.id::text AS id,
        file.purpose::text AS purpose,
        file.storage_key,
        file.original_name,
        file.media_type,
        file.byte_size,
        file.sha256,
        file.created_by_user_id::text AS created_by_user_id,
        file.expires_at,
        file.deleted_at,
        file.created_at
      FROM problem_revision_files association
      JOIN stored_files file ON file.id = association.file_id
      WHERE association.revision_id = ${parsedRevisionId}::uuid
        AND file.deleted_at IS NULL
        AND (file.expires_at IS NULL OR file.expires_at > now())
        ${categoryFilter}
      ORDER BY association.category, association.position, association.logical_path
    `);
    return rows.map(toProblemRevisionFileRecord);
  }

  /**
   * 在一个版本中按存储键定位文件，避免上层只凭存储键跨题目读取文件。
   */
  public async findRevisionFileByStorageKey(
    revisionId: string,
    storageKey: string
  ): Promise<ProblemRevisionFileRecord | undefined> {
    const parsedRevisionId = parseUuid(revisionId);
    const parsedKey = storageKeySchema.safeParse(storageKey);
    if (parsedRevisionId === undefined || !parsedKey.success) {
      return undefined;
    }

    const rows = await this.database.query<ProblemRevisionFileRow>(sql`
      SELECT
        association.revision_id::text AS revision_id,
        association.category::text AS category,
        association.logical_path,
        association.position,
        file.id::text AS id,
        file.purpose::text AS purpose,
        file.storage_key,
        file.original_name,
        file.media_type,
        file.byte_size,
        file.sha256,
        file.created_by_user_id::text AS created_by_user_id,
        file.expires_at,
        file.deleted_at,
        file.created_at
      FROM problem_revision_files association
      JOIN stored_files file ON file.id = association.file_id
      WHERE association.revision_id = ${parsedRevisionId}::uuid
        AND file.storage_key = ${parsedKey.data}
        AND file.deleted_at IS NULL
        AND (file.expires_at IS NULL OR file.expires_at > now())
    `);
    const row = rows[0];
    return row === undefined ? undefined : toProblemRevisionFileRecord(row);
  }

  /**
   * 将一个已经正式发布、用途为 problem 的文件关联到固定版本。没有满足条件的版本或文件时返回
   * undefined，方便上层保持“不存在”和“无权”的相同对外行为。
   */
  public async linkFileToRevision(
    rawInput: LinkProblemRevisionFileInput,
    executor: DatabaseExecutor = this.database
  ): Promise<ProblemRevisionFileRecord | undefined> {
    const input = linkProblemRevisionFileInputSchema.parse(rawInput);
    try {
      const rows = await executor.query<ProblemRevisionFileRow>(sql`
        WITH inserted AS (
          INSERT INTO problem_revision_files (
            revision_id,
            file_id,
            category,
            logical_path,
            position
          )
          SELECT
            revision.id,
            file.id,
            ${input.category}::problem_file_category,
            ${input.logicalPath},
            ${input.position}
          FROM problem_revisions revision
          JOIN stored_files file
            ON file.id = ${input.fileId}::uuid
           AND file.purpose = 'problem'::file_purpose
           AND file.deleted_at IS NULL
           AND (file.expires_at IS NULL OR file.expires_at > now())
          WHERE revision.id = ${input.revisionId}::uuid
          RETURNING revision_id, file_id, category, logical_path, position
        )
        SELECT
          inserted.revision_id::text AS revision_id,
          inserted.category::text AS category,
          inserted.logical_path,
          inserted.position,
          file.id::text AS id,
          file.purpose::text AS purpose,
          file.storage_key,
          file.original_name,
          file.media_type,
          file.byte_size,
          file.sha256,
          file.created_by_user_id::text AS created_by_user_id,
          file.expires_at,
          file.deleted_at,
          file.created_at
        FROM inserted
        JOIN stored_files file ON file.id = inserted.file_id
      `);
      const row = rows[0];
      return row === undefined ? undefined : toProblemRevisionFileRecord(row);
    } catch (error) {
      throw translateWriteError(error);
    }
  }

  /**
   * Removes only the relation from one new revision. The stored object stays
   * intact because older immutable revisions can still refer to it.
   */
  public async removeFileRelation(
    revisionId: string,
    fileId: string,
    executor: DatabaseExecutor = this.database
  ): Promise<boolean> {
    const parsedRevisionId = parseUuid(revisionId);
    const parsedFileId = parseUuid(fileId);
    if (parsedRevisionId === undefined || parsedFileId === undefined) {
      return false;
    }
    try {
      const rows = await executor.query<{ file_id: string }>(sql`
        DELETE FROM problem_revision_files
        WHERE revision_id = ${parsedRevisionId}::uuid
          AND file_id = ${parsedFileId}::uuid
        RETURNING file_id::text AS file_id
      `);
      return rows.length === 1;
    } catch (error) {
      throw translateWriteError(error);
    }
  }

  /**
   * 新版本创建后复制同一题目的紧邻上一版本文件关联。目标版本必须还是空的，避免静默覆盖或把两套
   * 文件混在一起。传入事务执行器时，复制会与创建版本在同一个数据库事务中完成。
   */
  public async copyPreviousRevisionFiles(
    revisionId: string,
    executor?: DatabaseExecutor
  ): Promise<ProblemRevisionFileRecord[]> {
    const parsedRevisionId = parseUuid(revisionId);
    if (parsedRevisionId === undefined) {
      throw new ProblemFileStoreError("REVISION_NOT_FOUND", "题目版本不存在。");
    }

    if (executor !== undefined) {
      return this.copyPreviousRevisionFilesInExecutor(parsedRevisionId, executor);
    }
    return this.database.transaction((transaction) =>
      this.copyPreviousRevisionFilesInExecutor(parsedRevisionId, transaction)
    );
  }

  private async copyPreviousRevisionFilesInExecutor(
    revisionId: string,
    executor: DatabaseExecutor
  ): Promise<ProblemRevisionFileRecord[]> {
    try {
      const predecessorRows = await executor.query<PreviousRevisionRow>(sql`
        SELECT predecessor.id::text AS predecessor_revision_id
        FROM problem_revisions target
        LEFT JOIN problem_revisions predecessor
          ON predecessor.problem_id = target.problem_id
         AND predecessor.revision = target.revision - 1
        WHERE target.id = ${revisionId}::uuid
      `);
      const predecessor = predecessorRows[0];
      if (predecessor === undefined) {
        throw new ProblemFileStoreError("REVISION_NOT_FOUND", "题目版本不存在。");
      }

      const targetFileRows = await executor.query<{ count: string | number | bigint }>(sql`
        SELECT count(*) AS count
        FROM problem_revision_files
        WHERE revision_id = ${revisionId}::uuid
      `);
      if (readNonnegativeCount(targetFileRows[0]?.count) > 0) {
        throw new ProblemFileStoreError(
          "TARGET_ALREADY_HAS_FILES",
          "目标题目版本已经有关联文件，不能复制上一版本。"
        );
      }

      if (predecessor.predecessor_revision_id === null) {
        return [];
      }

      await executor.execute(sql`
        INSERT INTO problem_revision_files (
          revision_id,
          file_id,
          category,
          logical_path,
          position
        )
        SELECT
          ${revisionId}::uuid,
          association.file_id,
          association.category,
          association.logical_path,
          association.position
        FROM problem_revision_files association
        JOIN stored_files file ON file.id = association.file_id
        WHERE association.revision_id = ${predecessor.predecessor_revision_id}::uuid
          AND file.purpose = 'problem'::file_purpose
          AND file.deleted_at IS NULL
          AND (file.expires_at IS NULL OR file.expires_at > now())
      `);

      return this.listRevisionFiles(revisionId, executor);
    } catch (error) {
      throw translateWriteError(error);
    }
  }
}

function categoryFilterSql(categories: readonly ProblemFileCategory[] | undefined): SQL | undefined {
  if (categories === undefined) {
    return sql``;
  }
  const normalized = [...new Set(categories)];
  if (normalized.length === 0 || !normalized.every((category) => problemFileCategorySchema.safeParse(category).success)) {
    return undefined;
  }
  return sql`AND association.category IN (${sql.join(
    normalized.map((category) => sql`${category}::problem_file_category`),
    sql`, `
  )})`;
}

function parseUuid(value: string): string | undefined {
  const result = zUuid.safeParse(value);
  return result.success ? result.data : undefined;
}

const zUuid = createStoredFileInputSchema.shape.id;

function requireDatabaseId(value: string): bigint {
  const parsed = BigInt(value);
  if (parsed > maximumDatabaseId) {
    throw new ProblemFileStoreError("INVALID_DATABASE_RECORD", "文件创建者编号超出范围。");
  }
  return parsed;
}

function toStoredFileRecord(row: StoredFileRow): StoredFileRecord {
  const parsed = storedFileRecordSchema.safeParse({
    id: row.id,
    purpose: row.purpose,
    storageKey: row.storage_key,
    originalName: row.original_name,
    mediaType: row.media_type,
    byteSize: readByteSize(row.byte_size),
    sha256: row.sha256,
    createdByUserId: row.created_by_user_id,
    expiresAt: nullableTimestamp(row.expires_at),
    deletedAt: nullableTimestamp(row.deleted_at),
    createdAt: timestamp(row.created_at)
  });
  if (!parsed.success) {
    throw new ProblemFileStoreError("INVALID_DATABASE_RECORD", "文件元数据记录不符合数据结构。");
  }
  return parsed.data;
}

function toProblemRevisionFileRecord(row: ProblemRevisionFileRow): ProblemRevisionFileRecord {
  const file = toStoredFileRecord(row);
  const parsed = problemRevisionFileRecordSchema.safeParse({
    ...file,
    revisionId: row.revision_id,
    category: row.category,
    logicalPath: row.logical_path,
    position: readNonnegativeCount(row.position)
  });
  if (!parsed.success) {
    throw new ProblemFileStoreError("INVALID_DATABASE_RECORD", "题目文件关联记录不符合数据结构。");
  }
  return parsed.data;
}

function timestamp(value: Date | string): string {
  const parsed = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(parsed.getTime())) {
    throw new ProblemFileStoreError("INVALID_DATABASE_RECORD", "文件元数据时间无效。");
  }
  return parsed.toISOString();
}

function nullableTimestamp(value: Date | string | null): string | null {
  return value === null ? null : timestamp(value);
}

function readByteSize(value: string | number | bigint): number {
  const parsed = readNonnegativeInteger(value);
  if (parsed > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new ProblemFileStoreError("INVALID_DATABASE_RECORD", "文件大小超出安全范围。");
  }
  return Number(parsed);
}

function readNonnegativeCount(value: string | number | bigint | undefined): number {
  if (value === undefined) {
    return 0;
  }
  const parsed = readNonnegativeInteger(value);
  if (parsed > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new ProblemFileStoreError("INVALID_DATABASE_RECORD", "数据库计数超出安全范围。");
  }
  return Number(parsed);
}

function readNonnegativeInteger(value: string | number | bigint): bigint {
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new ProblemFileStoreError("INVALID_DATABASE_RECORD", "数据库数字无效。");
    }
    return BigInt(value);
  }
  if (typeof value === "string" && !/^\d+$/.test(value)) {
    throw new ProblemFileStoreError("INVALID_DATABASE_RECORD", "数据库数字无效。");
  }
  const parsed = typeof value === "bigint" ? value : BigInt(value);
  if (parsed < 0n) {
    throw new ProblemFileStoreError("INVALID_DATABASE_RECORD", "数据库数字无效。");
  }
  return parsed;
}

function translateWriteError(error: unknown): ProblemFileStoreError {
  if (error instanceof ProblemFileStoreError) {
    return error;
  }
  if (isUniqueConstraintError(error)) {
    return new ProblemFileStoreError("FILE_LINK_CONFLICT", "题目版本中的文件路径或文件关联重复。");
  }
  return new ProblemFileStoreError("WRITE_FAILED", "文件元数据写入失败。");
}

function isUniqueConstraintError(error: unknown, depth = 0): boolean {
  if (depth > 3 || typeof error !== "object" || error === null) {
    return false;
  }
  const code = "code" in error && typeof error.code === "string" ? error.code : undefined;
  const message = error instanceof Error ? error.message : "";
  if (code === "23505" || /duplicate key|unique constraint/i.test(message)) {
    return true;
  }
  if (!("cause" in error) || error.cause === error) {
    return false;
  }
  return isUniqueConstraintError(error.cause, depth + 1);
}
