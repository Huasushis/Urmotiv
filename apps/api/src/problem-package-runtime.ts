import { createHash, randomUUID } from "node:crypto";
import {
  problemJudgeConfigSchema,
  type ProblemFileCategory
} from "@urmotiv/contracts";
import type { DatabaseHandle } from "@urmotiv/database";
import {
  ExportResultSaveError,
  ImportResultSaveError,
  ProblemPackageTemporaryError,
  type AtomicImportedProblemWriter,
  type ExportArtifactWriter,
  type ExportProblemFileDescriptor,
  type ExportProblemRevision,
  type ExportReadAuthorization,
  type FixedRevisionExportReader,
  type ProblemPackageExportSelection,
  type ProblemPackageImportChoices,
  type VerifiedImportArchiveReader
} from "@urmotiv/jobs";
import {
  UnsafeArchiveError,
  canonicalProblemSchema,
  defaultArchiveSafetyLimits,
  readProblemPackageInput,
  singleFileProblemPackagePath,
  writeZipArchive,
  type ArchiveSafetyLimits,
  type CanonicalFile,
  type CanonicalFileCategory,
  type CanonicalProblem,
  type GeneratedArchive,
  type GeneratedSingleFileArchive,
  type GeneratedZipArchive,
  type SafeProblemPackageInput
} from "@urmotiv/problem-package";
import { StorageError, type FileStorage, type StagedFile, type StoredFile } from "@urmotiv/storage";
import { sql } from "drizzle-orm";
import { z } from "zod";
import type { StoredProblem, StoredUser } from "./domain";
import type { DatabaseDataStore } from "./database-store";
import { ApiError } from "./errors";
import { ProblemFileStore } from "./problem-file-store";
import {
  ProblemPackageJobStoreError,
  completeDatabaseExportJob
} from "./problem-package-job-store";
import {
  DatabaseProblemPackageAuditWriter,
  type ProblemPackageAuditWriter
} from "./problem-package-audit";
import type { ProblemService } from "./service";

/**
 * 本文件是后台题目包任务的“真实依赖”：读取上传的压缩包、把转换后的题目原子地写入
 * 数据库、在导出过程中的每次读取前重新计算权限、把导出产物写入私有对象存储。
 * 队列和任务处理器只通过这些接口访问数据，永远拿不到数据库连接或存储密钥。
 */

const canonicalToProblemCategory: Readonly<Record<CanonicalFileCategory, ProblemFileCategory>> = {
  asset: "statement_image",
  testdata: "testdata",
  checker: "checker",
  interactor: "interactor",
  answer_checker: "answer_checker",
  standard_solution: "standard_solution",
  public_attachment: "public_attachment",
  internal_attachment: "internal_attachment"
};

const problemToCanonicalCategory: Readonly<Record<ProblemFileCategory, CanonicalFileCategory>> = {
  statement_image: "asset",
  testdata: "testdata",
  checker: "checker",
  interactor: "interactor",
  answer_checker: "answer_checker",
  standard_solution: "standard_solution",
  public_attachment: "public_attachment",
  internal_attachment: "internal_attachment"
};

const internalCanonicalCategories: ReadonlySet<CanonicalFileCategory> = new Set([
  "testdata",
  "checker",
  "interactor",
  "answer_checker",
  "standard_solution",
  "internal_attachment"
]);

const multiProblemOuterArchiveMaxBytes =
  defaultArchiveSafetyLimits.maxArchiveBytes;

function toProblemCategory(category: CanonicalFileCategory): ProblemFileCategory {
  const mapped = canonicalToProblemCategory[category];
  if (mapped === undefined) {
    throw new Error("未知的题目包文件类别。");
  }
  return mapped;
}

function toCanonicalCategory(category: ProblemFileCategory): CanonicalFileCategory {
  const mapped = problemToCanonicalCategory[category];
  if (mapped === undefined) {
    throw new Error("未知的题目文件类别。");
  }
  return mapped;
}

const mediaTypesByExtension: Readonly<Record<string, string>> = {
  md: "text/markdown",
  txt: "text/plain",
  in: "text/plain",
  out: "text/plain",
  ans: "text/plain",
  yaml: "application/yaml",
  yml: "application/yaml",
  json: "application/json",
  pdf: "application/pdf",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  svg: "image/svg+xml",
  webp: "image/webp",
  cpp: "text/x-c++src",
  cc: "text/x-c++src",
  c: "text/x-csrc",
  h: "text/x-chdr",
  py: "text/x-python",
  java: "text/x-java-source"
};

function mediaTypeForPath(path: string): string {
  const dot = path.lastIndexOf(".");
  const extension = dot < 0 ? "" : path.slice(dot + 1).toLowerCase();
  return mediaTypesByExtension[extension] ?? "application/octet-stream";
}

function fileNameOf(path: string): string {
  const slash = path.lastIndexOf("/");
  const name = slash < 0 ? path : path.slice(slash + 1);
  return name.length === 0 ? "file" : name;
}

function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function* singleChunk(bytes: Uint8Array): AsyncGenerator<Uint8Array> {
  yield bytes;
}

class TaskAborted extends Error {
  public constructor() {
    super("任务已取消。");
    this.name = "TaskAborted";
  }
}

class StoredContentMismatch extends Error {
  public constructor() {
    super("文件内容与登记信息不一致。");
    this.name = "StoredContentMismatch";
  }
}

class ImportItemAlreadyCommitted extends Error {
  public constructor() {
    super("导入项目已经由另一工作进程完成。");
    this.name = "ImportItemAlreadyCommitted";
  }
}

function assertActive(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw new TaskAborted();
  }
}

function isHiddenProblemAccessError(error: unknown): boolean {
  return (
    error instanceof ApiError &&
    (error.statusCode === 403 || error.statusCode === 404)
  );
}

async function collectBytes(
  stream: AsyncIterable<Uint8Array>,
  maximumBytes: number,
  signal?: AbortSignal
): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let total = 0;
  for await (const chunk of stream) {
    assertActive(signal);
    total += chunk.byteLength;
    if (total > maximumBytes) {
      throw new StoredContentMismatch();
    }
    chunks.push(chunk);
  }
  const merged = new Uint8Array(total);
  let cursor = 0;
  for (const chunk of chunks) {
    merged.set(chunk, cursor);
    cursor += chunk.byteLength;
  }
  return merged;
}

/**
 * 按登记的元数据读取导入文件。用途、摘要或字节内容任何一项对不上都按“不存在”
 * 返回，随后由与上传接口相同的读取函数完成 ZIP 或单个 XML 的安全检查。
 */
export class StorageVerifiedImportArchiveReader implements VerifiedImportArchiveReader {
  public constructor(
    private readonly metadata: ProblemFileStore,
    private readonly storage: FileStorage
  ) {}

  public async read(input: {
    readonly sourceFileId: string;
    readonly expectedDigest: string;
    readonly signal: AbortSignal;
  }): Promise<SafeProblemPackageInput | undefined> {
    assertActive(input.signal);
    let record: Awaited<ReturnType<ProblemFileStore["findStoredFile"]>>;
    try {
      record = await this.metadata.findStoredFile(input.sourceFileId);
    } catch {
      throw new ProblemPackageTemporaryError(
        "导入文件暂时无法读取，请稍后重试。"
      );
    }
    if (
      record === undefined ||
      record.purpose !== "import_input" ||
      record.sha256 !== input.expectedDigest ||
      !Number.isSafeInteger(record.byteSize) ||
      record.byteSize < 0 ||
      record.byteSize > defaultArchiveSafetyLimits.maxArchiveBytes
    ) {
      return undefined;
    }

    let bytes: Uint8Array;
    try {
      const stream = await this.storage.open({
        id: record.id,
        storageKey: record.storageKey
      });
      bytes = await collectBytes(
        stream,
        defaultArchiveSafetyLimits.maxArchiveBytes,
        input.signal
      );
    } catch (error) {
      if (error instanceof TaskAborted) {
        throw error;
      }
      if (error instanceof StoredContentMismatch) {
        return undefined;
      }
      if (error instanceof StorageError && error.code === "OBJECT_NOT_FOUND") {
        return undefined;
      }
      throw new ProblemPackageTemporaryError(
        "导入文件暂时无法读取，请稍后重试。"
      );
    }
    if (bytes.byteLength !== record.byteSize || sha256Hex(bytes) !== input.expectedDigest) {
      return undefined;
    }
    const packageInput = readProblemPackageInput({
      originalName: record.originalName,
      content: bytes
    });
    return packageInput.mediaType === record.mediaType ? packageInput : undefined;
  }
}

export interface DatabaseImportedProblemWriterDependencies {
  readonly database: DatabaseHandle;
  readonly store: DatabaseDataStore;
  readonly metadata: ProblemFileStore;
  readonly storage: FileStorage;
  readonly audit?: ProblemPackageAuditWriter;
  readonly now?: () => Date;
}

/**
 * 把一道转换完成的题目写入数据库。对象文件先发布，然后题目、修订、样例、标签、文件
 * 元数据和关联在同一个事务里写入；事务失败时删除刚发布的对象文件，不留下半道题目。
 * 同一个任务位置重复执行时直接返回已导入的题目编号。
 */
export class DatabaseImportedProblemWriter implements AtomicImportedProblemWriter {
  readonly #database: DatabaseHandle;
  readonly #store: DatabaseDataStore;
  readonly #metadata: ProblemFileStore;
  readonly #storage: FileStorage;
  readonly #audit: ProblemPackageAuditWriter;
  readonly #now: () => Date;

  public constructor(dependencies: DatabaseImportedProblemWriterDependencies) {
    this.#database = dependencies.database;
    this.#store = dependencies.store;
    this.#metadata = dependencies.metadata;
    this.#storage = dependencies.storage;
    this.#audit =
      dependencies.audit ?? new DatabaseProblemPackageAuditWriter(dependencies.database);
    this.#now = dependencies.now ?? (() => new Date());
  }

  public async write(input: {
    readonly importJobId: string;
    readonly position: number;
    readonly requestedByUserId: string;
    readonly choices: ProblemPackageImportChoices;
    readonly problem: CanonicalProblem;
    readonly signal: AbortSignal;
  }): Promise<{ readonly problemId: string }> {
    assertActive(input.signal);
    if (input.choices.conflictAction !== "create") {
      throw new Error("当前版本的导入只支持创建新题目。");
    }

    let existingProblemId: string | undefined;
    try {
      existingProblemId = await this.#findImportedProblemId(
        input.importJobId,
        input.position
      );
    } catch {
      throw new ImportResultSaveError();
    }
    if (existingProblemId !== undefined) {
      return { problemId: existingProblemId };
    }

    const problem = canonicalProblemSchema.parse(input.problem);
    let knownTags: Set<string>;
    try {
      knownTags = new Set((await this.#store.listTags()).map((tag) => tag.id));
    } catch {
      throw new ImportResultSaveError();
    }
    const tagIds = problem.tags.filter((tag) => knownTags.has(tag));
    const now = this.#now().toISOString();
    const stored: StoredProblem = {
      id: randomUUID(),
      title: problem.title,
      type: problem.type,
      tagIds,
      codeforcesDifficulty: problem.difficulty.codeforces ?? null,
      thinkingLevel: problem.difficulty.thinkingLevel ?? null,
      codingLevel: problem.difficulty.codingLevel ?? null,
      content: {
        basicStatement: problem.content.basicStatement,
        basicSolution: problem.content.basicSolution,
        background: problem.content.background,
        statement: problem.content.statement,
        inputFormat: problem.content.inputFormat,
        outputFormat: problem.content.outputFormat,
        constraints: problem.content.constraints,
        solution: problem.content.solution,
        hints: problem.content.hints
      },
      samples: problem.samples.map((sample) => ({
        id: randomUUID(),
        input: sample.input,
        output: sample.output,
        explanation: sample.explanation
      })),
      judgeConfig:
        problem.judge === undefined ? null : problemJudgeConfigSchema.parse(problem.judge),
      status: "draft",
      ownerId: input.requestedByUserId,
      revision: 1,
      reviewRound: 0,
      createdAt: now,
      updatedAt: now
    };

    const published: StoredFile[] = [];
    let transactionWritesFinished = false;
    try {
      for (const file of problem.files) {
        assertActive(input.signal);
        published.push(await this.#stageAndPublish(file));
      }

      const created = await this.#store.createProblemWithRevisionAction(
        stored,
        async (revisionId, executor) => {
          const lockedJob = await executor.query<{ id: string }>(sql`
            SELECT id::text AS id
            FROM import_jobs
            WHERE id = ${input.importJobId}::uuid
              AND state = 'running'
              AND requested_by_user_id = ${BigInt(input.requestedByUserId)}
            FOR UPDATE
          `);
          if (lockedJob.length !== 1) {
            throw new ImportItemAlreadyCommitted();
          }

          for (const [index, file] of problem.files.entries()) {
            const storedFile = published[index];
            if (storedFile === undefined) {
              throw new Error("导入文件没有全部发布。");
            }
            await this.#metadata.createStoredFile(
              {
                id: storedFile.id,
                purpose: "problem",
                storageKey: storedFile.storageKey,
                originalName: storedFile.originalName,
                mediaType: storedFile.mediaType,
                byteSize: storedFile.byteSize,
                sha256: storedFile.sha256,
                createdByUserId: input.requestedByUserId
              },
              executor
            );
            const linked = await this.#metadata.linkFileToRevision(
              {
                revisionId,
                fileId: storedFile.id,
                category: toProblemCategory(file.category),
                logicalPath: file.path,
                position: index
              },
              executor
            );
            if (linked === undefined) {
              throw new Error("导入文件没有关联到新题目。");
            }
          }

          if (Object.keys(problem.extensions).length > 0) {
            await executor.execute(sql`
              UPDATE problem_revisions
              SET format_extensions = ${JSON.stringify(problem.extensions)}::jsonb
              WHERE id = ${revisionId}::uuid
            `);
          }

          const revision = await executor.query<{ problem_id: string }>(sql`
            SELECT problem_id::text AS problem_id
            FROM problem_revisions
            WHERE id = ${revisionId}::uuid
          `);
          const importedProblemId = revision[0]?.problem_id;
          if (importedProblemId === undefined) {
            throw new Error("新题目版本没有关联题目。");
          }
          const recorded = await executor.query<{ position: number }>(sql`
            UPDATE import_job_items
            SET state = 'succeeded',
                imported_problem_id = ${BigInt(importedProblemId)},
                report = '{}'::jsonb,
                failure_code = NULL,
                failure_message = NULL,
                finished_at = ${this.#now().toISOString()}::timestamptz
            WHERE job_id = ${input.importJobId}::uuid
              AND position = ${input.position}
              AND imported_problem_id IS NULL
              AND EXISTS (
                SELECT 1
                FROM import_jobs
                WHERE id = ${input.importJobId}::uuid
                  AND state = 'running'
                  AND requested_by_user_id = ${BigInt(input.requestedByUserId)}
              )
            RETURNING position
          `);
          if (recorded.length !== 1) {
            throw new ImportItemAlreadyCommitted();
          }
          await this.#audit.append(
            {
              actorUserId: input.requestedByUserId,
              requestId: input.importJobId,
              action: "problem.package.import.item.complete",
              objectType: "problem",
              objectId: importedProblemId,
              result: "success",
              reasonCode: null,
              metadata: {
                importJobId: input.importJobId,
                position: input.position
              }
            },
            executor
          );
          transactionWritesFinished = true;
        }
      );
      return { problemId: created.id };
    } catch {
      let committedProblemId: string | undefined;
      try {
        committedProblemId = await this.#findImportedProblemId(
          input.importJobId,
          input.position
        );
        if (committedProblemId !== undefined) {
          const linkedToCommittedProblem = await this.#publishedFilesBelongToProblem(
            committedProblemId,
            published
          );
          if (!linkedToCommittedProblem) {
            await this.#deletePublishedFiles(published);
          }
          return { problemId: committedProblemId };
        }
      } catch {
        if (!transactionWritesFinished) {
          await this.#deletePublishedFiles(published);
        }
        throw new ImportResultSaveError();
      }
      if (transactionWritesFinished) {
        // The transaction body finished, so a lost commit response can leave a
        // valid problem that is not visible to this connection yet. Keep the
        // objects until a retry can read the committed item.
        throw new ImportResultSaveError();
      }
      await this.#deletePublishedFiles(published);
      throw new ImportResultSaveError();
    }
  }

  async #findImportedProblemId(
    importJobId: string,
    position: number
  ): Promise<string | undefined> {
    const rows = await this.#database.query<{ imported_problem_id: string | null }>(sql`
      SELECT imported_problem_id::text AS imported_problem_id
      FROM import_job_items
      WHERE job_id = ${importJobId}::uuid AND position = ${position}
    `);
    return rows[0]?.imported_problem_id ?? undefined;
  }

  async #publishedFilesBelongToProblem(
    problemId: string,
    published: readonly StoredFile[]
  ): Promise<boolean> {
    for (const storedFile of published) {
      const rows = await this.#database.query<{ linked: boolean }>(sql`
        SELECT EXISTS (
          SELECT 1
          FROM problem_revision_files association
          INNER JOIN problem_revisions revision
            ON revision.id = association.revision_id
          WHERE revision.problem_id = ${BigInt(problemId)}
            AND association.file_id = ${storedFile.id}::uuid
        ) AS linked
      `);
      if (rows[0]?.linked !== true) {
        return false;
      }
    }
    return true;
  }

  async #deletePublishedFiles(published: readonly StoredFile[]): Promise<void> {
    for (const storedFile of published) {
      await this.#storage.delete(storedFile).catch(() => undefined);
    }
  }

  async #stageAndPublish(file: CanonicalFile): Promise<StoredFile> {
    const staged = await this.#storage.stage({
      originalName: fileNameOf(file.path),
      mediaType: mediaTypeForPath(file.path),
      content: singleChunk(file.content)
    });
    try {
      return await this.#storage.publish(staged);
    } catch (error) {
      await this.#storage.discard(staged).catch(() => undefined);
      throw error;
    }
  }
}

export interface ServiceExportReadAuthorizationDependencies {
  readonly getUser: (userId: string) => Promise<StoredUser | undefined>;
  readonly service: ProblemService;
}

/**
 * 导出任务里每次读取题目或文件前都重新计算权限：用户仍然存在且可登录、仍能看到并
 * 导出这道题、读取内部资料时仍有测试数据权限。创建任务时的授权不会被缓存复用。
 */
export class ServiceExportReadAuthorization implements ExportReadAuthorization {
  public constructor(private readonly dependencies: ServiceExportReadAuthorizationDependencies) {}

  public async canReadProblem(input: {
    readonly requestedByUserId: string;
    readonly selection: ProblemPackageExportSelection;
    readonly signal: AbortSignal;
  }): Promise<boolean> {
    const capabilities = await this.#capabilitiesFor(
      input.requestedByUserId,
      input.selection.problemId
    );
    return capabilities?.canExport === true;
  }

  public async canReadFile(input: {
    readonly requestedByUserId: string;
    readonly selection: ProblemPackageExportSelection;
    readonly file: ExportProblemFileDescriptor;
    readonly signal: AbortSignal;
  }): Promise<boolean> {
    const capabilities = await this.#capabilitiesFor(
      input.requestedByUserId,
      input.selection.problemId
    );
    if (capabilities?.canExport !== true) {
      return false;
    }
    if (internalCanonicalCategories.has(input.file.category)) {
      return capabilities.canReadTestdata;
    }
    return true;
  }

  async #capabilitiesFor(
    userId: string,
    problemId: string
  ): Promise<{ canExport: boolean; canReadTestdata: boolean } | undefined> {
    try {
      const user = await this.dependencies.getUser(userId);
      if (user === undefined) {
        return undefined;
      }
      const { capabilities } = await this.dependencies.service.getProblemForFileAccess(
        user,
        problemId
      );
      return { canExport: capabilities.canExport, canReadTestdata: capabilities.canReadTestdata };
    } catch (error) {
      if (isHiddenProblemAccessError(error)) {
        return undefined;
      }
      throw new ProblemPackageTemporaryError(
        "题目权限检查暂时失败，请稍后重试。"
      );
    }
  }
}

export interface DatabaseFixedRevisionExportReaderDependencies {
  readonly database: DatabaseHandle;
  readonly metadata: ProblemFileStore;
  readonly storage: FileStorage;
}

interface RevisionRow extends Record<string, unknown> {
  problem_id: string;
  revision: number;
  title: string;
  type: string;
  codeforces_difficulty: number | null;
  thinking_level: number | null;
  coding_level: number | null;
  basic_statement: string;
  basic_solution: string;
  background: string;
  statement: string;
  input_format: string;
  output_format: string;
  constraints: string;
  solution: string;
  hints: string;
  judge_config: unknown;
  format_extensions: unknown;
}

interface SampleRow extends Record<string, unknown> {
  input: string;
  output: string;
  explanation: string;
}

const jsonObjectSchema = z.record(z.string(), z.unknown());

/**
 * 按任务里固定的题目版本读取内容，不跟随后续修订。返回的文档不包含文件字节，
 * 文件在授权检查通过后按需单独读取。
 */
export class DatabaseFixedRevisionExportReader implements FixedRevisionExportReader {
  public constructor(private readonly dependencies: DatabaseFixedRevisionExportReaderDependencies) {}

  public async readRevision(input: {
    readonly selection: ProblemPackageExportSelection;
    readonly signal: AbortSignal;
  }): Promise<ExportProblemRevision | undefined> {
    try {
      return await this.#readRevision(input);
    } catch (error) {
      if (error instanceof TaskAborted || error instanceof ProblemPackageTemporaryError) {
        throw error;
      }
      throw new ProblemPackageTemporaryError(
        "导出题目暂时无法读取，请稍后重试。"
      );
    }
  }

  async #readRevision(input: {
    readonly selection: ProblemPackageExportSelection;
    readonly signal: AbortSignal;
  }): Promise<ExportProblemRevision | undefined> {
    assertActive(input.signal);
    const { database, metadata } = this.dependencies;
    const rows = await database.query<RevisionRow>(sql`
      SELECT
        problem_id::text AS problem_id,
        revision,
        title,
        type::text AS type,
        codeforces_difficulty,
        thinking_level,
        coding_level,
        basic_statement,
        basic_solution,
        background,
        statement,
        input_format,
        output_format,
        constraints,
        solution,
        hints,
        judge_config,
        format_extensions
      FROM problem_revisions
      WHERE id = ${input.selection.revisionId}::uuid
        AND problem_id = ${BigInt(input.selection.problemId)}
    `);
    const row = rows[0];
    if (row === undefined) {
      return undefined;
    }

    const sampleRows = await database.query<SampleRow>(sql`
      SELECT input, output, explanation
      FROM problem_samples
      WHERE revision_id = ${input.selection.revisionId}::uuid
      ORDER BY position ASC
    `);
    const tagRows = await database.query<{ tag_id: string }>(sql`
      SELECT tag_id
      FROM problem_revision_tags
      WHERE revision_id = ${input.selection.revisionId}::uuid
      ORDER BY tag_id ASC
    `);
    const fileRecords = await metadata.listRevisionFiles(input.selection.revisionId);

    const judgeConfig = parseJsonColumn(row.judge_config);
    const extensions = parseJsonColumn(row.format_extensions);
    const document: ExportProblemRevision["document"] = {
      title: row.title,
      type: row.type as CanonicalProblem["type"],
      tags: tagRows.map((tag) => tag.tag_id),
      difficulty: {
        ...(row.codeforces_difficulty === null
          ? {}
          : { codeforces: Number(row.codeforces_difficulty) }),
        ...(row.thinking_level === null ? {} : { thinkingLevel: Number(row.thinking_level) }),
        ...(row.coding_level === null ? {} : { codingLevel: Number(row.coding_level) })
      },
      content: {
        basicStatement: row.basic_statement,
        basicSolution: row.basic_solution,
        background: row.background,
        statement: row.statement,
        inputFormat: row.input_format,
        outputFormat: row.output_format,
        constraints: row.constraints,
        solution: row.solution,
        hints: row.hints
      },
      samples: sampleRows.map((sample) => ({
        input: sample.input,
        output: sample.output,
        explanation: sample.explanation
      })),
      ...(Object.keys(judgeConfig).length === 0
        ? {}
        : { judge: problemJudgeConfigSchema.parse(judgeConfig) }),
      provenance: {
        sourceSystem: "urmotiv",
        sourceProblemId: row.problem_id,
        sourceRevision: String(row.revision)
      },
      extensions: extensions as CanonicalProblem["extensions"]
    };

    return {
      document,
      files: fileRecords.map((record) => ({
        path: record.logicalPath,
        category: toCanonicalCategory(record.category),
        byteSize: record.byteSize
      }))
    };
  }

  public async readFile(input: {
    readonly selection: ProblemPackageExportSelection;
    readonly file: ExportProblemFileDescriptor;
    readonly signal: AbortSignal;
  }): Promise<CanonicalFile | undefined> {
    try {
      return await this.#readFile(input);
    } catch (error) {
      if (error instanceof TaskAborted || error instanceof ProblemPackageTemporaryError) {
        throw error;
      }
      if (error instanceof StoredContentMismatch) {
        return undefined;
      }
      if (error instanceof StorageError && error.code === "OBJECT_NOT_FOUND") {
        return undefined;
      }
      throw new ProblemPackageTemporaryError(
        "导出文件暂时无法读取，请稍后重试。"
      );
    }
  }

  async #readFile(input: {
    readonly selection: ProblemPackageExportSelection;
    readonly file: ExportProblemFileDescriptor;
    readonly signal: AbortSignal;
  }): Promise<CanonicalFile | undefined> {
    assertActive(input.signal);
    const { metadata, storage } = this.dependencies;
    const records = await metadata.listRevisionFiles(input.selection.revisionId);
    const record = records.find(
      (candidate) =>
        candidate.logicalPath === input.file.path &&
        toCanonicalCategory(candidate.category) === input.file.category &&
        candidate.byteSize === input.file.byteSize
    );
    if (record === undefined) {
      return undefined;
    }
    const stream = await storage.open({ id: record.id, storageKey: record.storageKey });
    const content = await collectBytes(stream, record.byteSize, input.signal);
    if (content.byteLength !== record.byteSize) {
      return undefined;
    }
    return { path: input.file.path, category: input.file.category, content };
  }
}

function parseJsonColumn(value: unknown): Record<string, unknown> {
  const parsed = typeof value === "string" ? JSON.parse(value) : value;
  const result = jsonObjectSchema.safeParse(parsed);
  return result.success ? result.data : {};
}

export interface StorageExportArtifactWriterDependencies {
  readonly database: DatabaseHandle;
  readonly metadata: ProblemFileStore;
  readonly storage: FileStorage;
  readonly audit?: ProblemPackageAuditWriter;
  /**
   * 多题导出外层包可以使用更小的内存上限，但不能超过固定的 128 MiB。
   * 主要供内存较小的部署和自动化测试使用。
   */
  readonly multiProblemOuterArchiveMaxBytes?: number;
  /** 导出结果的保存时长，超过后不能再下载。默认 72 小时。 */
  readonly resultTimeToLiveMs?: number;
  readonly now?: () => Date;
}

/**
 * 把生成的题目包写入私有对象存储：单题 ZIP 仍按原方式打包，单个原始 XML
 * 直接保存；多题只接受同一种输出，再把每道题的 ZIP 或 XML 放进一个外层 ZIP。
 * 返回的只有文件编号和过期时间，下载接口自行完成权限检查。
 */
export class StorageExportArtifactWriter implements ExportArtifactWriter {
  readonly #database: DatabaseHandle;
  readonly #metadata: ProblemFileStore;
  readonly #storage: FileStorage;
  readonly #audit: ProblemPackageAuditWriter;
  readonly #multiProblemOuterArchiveMaxBytes: number;
  readonly #multiProblemOuterArchiveLimits: Partial<ArchiveSafetyLimits>;
  readonly #timeToLiveMs: number;
  readonly #now: () => Date;

  public constructor(dependencies: StorageExportArtifactWriterDependencies) {
    const outerMaxBytes =
      dependencies.multiProblemOuterArchiveMaxBytes ?? multiProblemOuterArchiveMaxBytes;
    if (
      !Number.isSafeInteger(outerMaxBytes) ||
      outerMaxBytes <= 0 ||
      outerMaxBytes > multiProblemOuterArchiveMaxBytes
    ) {
      throw new TypeError(
        `多题导出外层包上限必须是 1 到 ${multiProblemOuterArchiveMaxBytes} 之间的整数。`
      );
    }
    this.#database = dependencies.database;
    this.#metadata = dependencies.metadata;
    this.#storage = dependencies.storage;
    this.#audit =
      dependencies.audit ?? new DatabaseProblemPackageAuditWriter(dependencies.database);
    this.#multiProblemOuterArchiveMaxBytes = outerMaxBytes;
    this.#multiProblemOuterArchiveLimits = {
      // 单个内层题目包和所有内层包的总量使用同一个上限，避免更小的
      // 单文件限制让本来可以单独导出的题目无法参加多题导出。
      maxArchiveBytes: outerMaxBytes,
      maxSingleFileBytes: outerMaxBytes,
      maxTotalUncompressedBytes: outerMaxBytes,
      allowNestedArchives: true
    };
    this.#timeToLiveMs = dependencies.resultTimeToLiveMs ?? 72 * 60 * 60 * 1_000;
    this.#now = dependencies.now ?? (() => new Date());
  }

  public async write(input: {
    readonly exportJobId: string;
    readonly requestedByUserId: string;
    readonly targetFormat: string;
    readonly archives: readonly GeneratedArchive[];
    readonly signal: AbortSignal;
  }): Promise<{ readonly fileId: string; readonly expiresAt: string }> {
    return this.#write(input);
  }

  public async writeAndComplete(input: {
    readonly exportJobId: string;
    readonly requestedByUserId: string;
    readonly targetFormat: string;
    readonly archives: readonly GeneratedArchive[];
    readonly outputFileCount: number;
    readonly signal: AbortSignal;
  }): Promise<{ readonly fileId: string; readonly expiresAt: string }> {
    return this.#write(input, input.outputFileCount);
  }

  async #write(
    input: {
      readonly exportJobId: string;
      readonly requestedByUserId: string;
      readonly targetFormat: string;
      readonly archives: readonly GeneratedArchive[];
      readonly signal: AbortSignal;
    },
    outputFileCount?: number
  ): Promise<{ readonly fileId: string; readonly expiresAt: string }> {
    assertActive(input.signal);
    if (input.archives.length === 0) {
      throw new Error("导出任务没有产生任何题目包。");
    }

    let fileName: string;
    let mediaType: string;
    let bytes: Uint8Array;
    const first = input.archives[0];
    if (input.archives.length === 1 && first !== undefined) {
      const outputKind = requireGeneratedOutputKind(first);
      if (outputKind === "zip") {
        fileName = safeZipArtifactName(first.fileName);
        mediaType = "application/zip";
        bytes = writeZipArchive((first as GeneratedZipArchive).files);
      } else {
        const singleFile = validateGeneratedSingleFile(first as GeneratedSingleFileArchive);
        fileName = singleFile.fileName;
        mediaType = first.mediaType;
        bytes = singleFile.content;
      }
    } else {
      const outputKind = requireUniformOutputKind(input.archives);
      const usedNames = new Set<string>();
      const wrapped: Array<{ readonly path: string; readonly content: Uint8Array }> = [];
      let innerPackageBytes = 0;
      for (const [index, archive] of input.archives.entries()) {
        assertActive(input.signal);
        const archiveKind = requireGeneratedOutputKind(archive);
        const singleArchive =
          archiveKind === "single_file"
            ? (archive as GeneratedSingleFileArchive)
            : undefined;
        if (
          singleArchive !== undefined &&
          singleArchive.content.byteLength >
            this.#multiProblemOuterArchiveMaxBytes - innerPackageBytes
        ) {
          throwOuterArchiveTooLarge();
        }
        const singleFile =
          singleArchive === undefined
            ? undefined
            : validateGeneratedSingleFile(singleArchive);
        let name =
          archiveKind === "zip"
            ? safeZipArtifactName((archive as GeneratedZipArchive).fileName)
            : singleFile?.fileName;
        if (name === undefined) {
          throw new Error("单文件导出没有生成文件名。");
        }
        let foldedName = name.normalize("NFC").toLowerCase();
        if (usedNames.has(foldedName) && outputKind === "zip") {
          name = `${index + 1}-${name}`;
          foldedName = name.normalize("NFC").toLowerCase();
        }
        if (usedNames.has(foldedName)) {
          throwDuplicateOutputName();
        }
        usedNames.add(foldedName);
        const content =
          archiveKind === "zip"
            ? writeZipArchive((archive as GeneratedZipArchive).files)
            : singleFile?.content;
        if (content === undefined) {
          throw new Error("单文件导出没有生成文件内容。");
        }
        if (
          content.byteLength >
          this.#multiProblemOuterArchiveMaxBytes - innerPackageBytes
        ) {
          throwOuterArchiveTooLarge();
        }
        innerPackageBytes += content.byteLength;
        wrapped.push({ path: name, content });
      }
      fileName = `urmotiv-export-${input.targetFormat}.zip`;
      mediaType = "application/zip";
      bytes = writeZipArchive(wrapped, {
        ...this.#multiProblemOuterArchiveLimits,
        allowNestedArchives: outputKind === "zip"
      });
    }

    assertActive(input.signal);
    let staged: StagedFile;
    try {
      staged = await this.#storage.stage({
        originalName: fileName,
        mediaType,
        content: singleChunk(bytes)
      });
    } catch {
      throw new ExportResultSaveError();
    }
    let stored: StoredFile;
    try {
      stored = await this.#storage.publish(staged);
    } catch {
      await this.#discardStaged(staged);
      throw new ExportResultSaveError();
    }

    const expiresAt = new Date(this.#now().getTime() + this.#timeToLiveMs).toISOString();
    const metadataInput = {
      id: stored.id,
      purpose: "export_output" as const,
      storageKey: stored.storageKey,
      originalName: fileName,
      mediaType,
      byteSize: stored.byteSize,
      sha256: stored.sha256,
      createdByUserId: input.requestedByUserId,
      expiresAt
    };
    let transactionWritesFinished = false;
    try {
      if (outputFileCount === undefined) {
        await this.#metadata.createStoredFile(metadataInput);
      } else {
        await this.#database.transaction(async (transaction) => {
          await this.#metadata.createStoredFile(metadataInput, transaction);
          await completeDatabaseExportJob(
            transaction,
            this.#audit,
            this.#now,
            input.exportJobId,
            {
              resultFileId: stored.id,
              resultExpiresAt: expiresAt,
              outputFileCount
            }
          );
          transactionWritesFinished = true;
        });
      }
    } catch (error) {
      if (outputFileCount !== undefined) {
        if (error instanceof ProblemPackageJobStoreError) {
          await this.#storage.delete(stored).catch(() => undefined);
          throw new ExportResultSaveError();
        }
        if (!transactionWritesFinished) {
          await this.#storage.delete(stored).catch(() => undefined);
          throw new ExportResultSaveError();
        }
        try {
          if (await this.#isCompletedWithFile(input.exportJobId, stored.id)) {
            return { fileId: stored.id, expiresAt };
          }
        } catch {
          // The object may already be referenced by a committed task. Deleting it
          // while the database is unavailable would turn a valid result into a broken one.
          throw new ExportResultSaveError();
        }
        // A connection failure can race with a commit that is still becoming
        // visible. Preserve the object unless the transaction reported a
        // definite task-state rejection above.
        throw new ExportResultSaveError();
      }
      await this.#storage.delete(stored).catch(() => undefined);
      throw new ExportResultSaveError();
    }
    return { fileId: stored.id, expiresAt };
  }

  async #isCompletedWithFile(exportJobId: string, fileId: string): Promise<boolean> {
    const rows = await this.#database.query<{
      state: string;
      result_file_id: string | null;
      has_audit: boolean;
    }>(sql`
      SELECT
        job.state::text AS state,
        job.result_file_id::text AS result_file_id,
        EXISTS (
          SELECT 1
          FROM audit_events
          WHERE request_id = job.id
            AND actor_user_id = job.requested_by_user_id
            AND action = 'problem.package.export.complete'
            AND object_type = 'export_job'
            AND object_id = job.id::text
            AND result = 'success'
        ) AS has_audit
      FROM export_jobs job
      WHERE job.id = ${exportJobId}::uuid
    `);
    const row = rows[0];
    return (
      row?.state === "succeeded" &&
      row.result_file_id === fileId &&
      row.has_audit === true
    );
  }

  public async discard(fileId: string): Promise<void> {
    const record = await this.#metadata.findStoredFile(fileId);
    if (record === undefined) {
      return;
    }
    await this.#storage
      .delete({ id: record.id, storageKey: record.storageKey })
      .catch(() => undefined);
    await this.#database.execute(sql`
      UPDATE stored_files
      SET deleted_at = ${this.#now().toISOString()}::timestamptz
      WHERE id = ${record.id}::uuid AND deleted_at IS NULL
    `);
  }

  async #discardStaged(staged: StagedFile): Promise<void> {
    await this.#storage.discard(staged).catch(() => undefined);
  }
}

function safeZipArtifactName(name: string): string {
  const trimmed = name.trim().replace(/[\u0000-\u001f\u007f/\\]/gu, "_");
  const bounded = trimmed.length === 0 ? "problem.zip" : trimmed.slice(0, 120);
  return bounded.toLowerCase().endsWith(".zip") ? bounded : `${bounded}.zip`;
}

function safeSingleFileArtifactName(name: string): string {
  const trimmed = name.trim();
  if (
    trimmed.length === 0 ||
    trimmed.length > 120 ||
    trimmed === "." ||
    trimmed === ".." ||
    /[\u0000-\u001f\u007f/\\]/u.test(trimmed)
  ) {
    throw new UnsafeArchiveError([
      {
        severity: "error",
        code: "invalid_path",
        message: "单文件导出的文件名不安全。"
      }
    ]);
  }
  if (!trimmed.toLowerCase().endsWith(".xml")) {
    throw new UnsafeArchiveError([
      {
        severity: "error",
        code: "unsupported_input_type",
        message: "单文件导出目前只接受 .xml 文件。"
      }
    ]);
  }
  return trimmed;
}

function validateGeneratedSingleFile(
  archive: GeneratedSingleFileArchive
): { readonly fileName: string; readonly content: Uint8Array } {
  const fileName = safeSingleFileArtifactName(archive.fileName);
  const checked = readProblemPackageInput({
    originalName: fileName,
    content: archive.content
  });
  const content = checked.archive.read(singleFileProblemPackagePath);
  if (checked.kind !== "single_file" || content === undefined) {
    throw new UnsafeArchiveError([
      {
        severity: "error",
        code: "not_an_xml_file",
        message: "单文件导出没有产生可识别的 XML 文件。"
      }
    ]);
  }
  return { fileName, content };
}

function requireUniformOutputKind(
  archives: readonly GeneratedArchive[]
): "zip" | "single_file" {
  const first = archives[0];
  if (first === undefined) {
    throw new Error("导出任务没有产生任何题目包。");
  }
  const firstKind = requireGeneratedOutputKind(first);
  if (archives.some((archive) => requireGeneratedOutputKind(archive) !== firstKind)) {
    throw new UnsafeArchiveError([
      {
        severity: "error",
        code: "unsupported_archive_feature",
        message: "一次多题导出不能混合 ZIP 和单个 XML 文件。"
      }
    ]);
  }
  return firstKind;
}

function requireGeneratedOutputKind(
  archive: GeneratedArchive
): "zip" | "single_file" {
  const legacyCandidate = archive as {
    readonly kind?: unknown;
    readonly files?: unknown;
    readonly content?: unknown;
  };
  const kind = legacyCandidate.kind;
  if (
    kind === undefined &&
    Array.isArray(legacyCandidate.files) &&
    legacyCandidate.content === undefined
  ) {
    return "zip";
  }
  if (kind !== "zip" && kind !== "single_file") {
    throw new UnsafeArchiveError([
      {
        severity: "error",
        code: "unsupported_archive_feature",
        message: "格式适配器没有说明导出结果是 ZIP 还是单个 XML 文件。"
      }
    ]);
  }
  return kind;
}

function throwDuplicateOutputName(): never {
  throw new UnsafeArchiveError([
    {
      severity: "error",
      code: "duplicate_path",
      message: "多题导出中有重名文件。"
    }
  ]);
}

function throwOuterArchiveTooLarge(): never {
  throw new UnsafeArchiveError([
    {
      severity: "error",
      code: "archive_too_large",
      message: "多题导出外层包超过允许的大小限制。"
    }
  ]);
}
