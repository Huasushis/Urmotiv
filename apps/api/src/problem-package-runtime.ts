import { createHash, randomUUID } from "node:crypto";
import {
  problemJudgeConfigSchema,
  type ProblemFileCategory
} from "@urmotiv/contracts";
import type { DatabaseHandle } from "@urmotiv/database";
import type {
  AtomicImportedProblemWriter,
  ExportArtifactWriter,
  ExportProblemFileDescriptor,
  ExportProblemRevision,
  ExportReadAuthorization,
  FixedRevisionExportReader,
  ProblemPackageExportSelection,
  ProblemPackageImportChoices,
  VerifiedImportArchiveReader
} from "@urmotiv/jobs";
import {
  SafeArchive,
  canonicalProblemSchema,
  readZipArchive,
  writeZipArchive,
  type CanonicalFile,
  type CanonicalFileCategory,
  type CanonicalProblem,
  type GeneratedArchive
} from "@urmotiv/problem-package";
import { StorageError, type FileStorage, type StagedFile, type StoredFile } from "@urmotiv/storage";
import { sql } from "drizzle-orm";
import { z } from "zod";
import type { StoredProblem, StoredUser } from "./domain";
import type { DatabaseDataStore } from "./database-store";
import { ProblemFileStore } from "./problem-file-store";
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

function assertActive(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw new TaskAborted();
  }
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
      throw new StorageError("STORAGE_READ_FAILED", "文件内容超过登记的大小。");
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
 * 按登记的元数据读取导入压缩包。用途、摘要或字节内容任何一项对不上都按“不存在”
 * 返回，随后由 ZIP 读取器完成全部文件安全检查。
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
  }): Promise<SafeArchive | undefined> {
    assertActive(input.signal);
    const record = await this.metadata.findStoredFile(input.sourceFileId);
    if (
      record === undefined ||
      record.purpose !== "import_input" ||
      record.sha256 !== input.expectedDigest
    ) {
      return undefined;
    }

    const stream = await this.storage.open({ id: record.id, storageKey: record.storageKey });
    const bytes = await collectBytes(stream, record.byteSize, input.signal);
    if (sha256Hex(bytes) !== input.expectedDigest) {
      return undefined;
    }
    return readZipArchive(bytes);
  }
}

export interface DatabaseImportedProblemWriterDependencies {
  readonly database: DatabaseHandle;
  readonly store: DatabaseDataStore;
  readonly metadata: ProblemFileStore;
  readonly storage: FileStorage;
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
  readonly #now: () => Date;

  public constructor(dependencies: DatabaseImportedProblemWriterDependencies) {
    this.#database = dependencies.database;
    this.#store = dependencies.store;
    this.#metadata = dependencies.metadata;
    this.#storage = dependencies.storage;
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

    const already = await this.#database.query<{ imported_problem_id: string | null }>(sql`
      SELECT imported_problem_id::text AS imported_problem_id
      FROM import_job_items
      WHERE job_id = ${input.importJobId}::uuid AND position = ${input.position}
    `);
    const existingProblemId = already[0]?.imported_problem_id;
    if (existingProblemId !== null && existingProblemId !== undefined) {
      return { problemId: existingProblemId };
    }

    const problem = canonicalProblemSchema.parse(input.problem);
    const knownTags = new Set((await this.#store.listTags()).map((tag) => tag.id));
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
    try {
      for (const file of problem.files) {
        assertActive(input.signal);
        published.push(await this.#stageAndPublish(file));
      }

      const created = await this.#store.createProblemWithRevisionAction(
        stored,
        async (revisionId, executor) => {
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
        }
      );
      return { problemId: created.id };
    } catch (error) {
      for (const storedFile of published) {
        await this.#storage.delete(storedFile).catch(() => undefined);
      }
      throw error;
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
    const user = await this.dependencies.getUser(userId);
    if (user === undefined) {
      return undefined;
    }
    try {
      const { capabilities } = await this.dependencies.service.getProblemForFileAccess(
        user,
        problemId
      );
      return { canExport: capabilities.canExport, canReadTestdata: capabilities.canReadTestdata };
    } catch {
      return undefined;
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
        category: toCanonicalCategory(record.category)
      }))
    };
  }

  public async readFile(input: {
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
        toCanonicalCategory(candidate.category) === input.file.category
    );
    if (record === undefined) {
      return undefined;
    }
    const stream = await storage.open({ id: record.id, storageKey: record.storageKey });
    const content = await collectBytes(stream, record.byteSize, input.signal);
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
  /** 导出结果的保存时长，超过后不能再下载。默认 72 小时。 */
  readonly resultTimeToLiveMs?: number;
  readonly now?: () => Date;
}

/**
 * 把生成的题目包写入私有对象存储：单题直接保存该题的 ZIP，多题时把每题的 ZIP 放进
 * 一个外层 ZIP。返回的只有文件编号和过期时间，下载接口自行完成权限检查。
 */
export class StorageExportArtifactWriter implements ExportArtifactWriter {
  readonly #database: DatabaseHandle;
  readonly #metadata: ProblemFileStore;
  readonly #storage: FileStorage;
  readonly #timeToLiveMs: number;
  readonly #now: () => Date;

  public constructor(dependencies: StorageExportArtifactWriterDependencies) {
    this.#database = dependencies.database;
    this.#metadata = dependencies.metadata;
    this.#storage = dependencies.storage;
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
    assertActive(input.signal);
    if (input.archives.length === 0) {
      throw new Error("导出任务没有产生任何题目包。");
    }

    let fileName: string;
    let bytes: Uint8Array;
    const first = input.archives[0];
    if (input.archives.length === 1 && first !== undefined) {
      fileName = safeArtifactName(first.fileName);
      bytes = writeZipArchive(first.files);
    } else {
      const usedNames = new Set<string>();
      const wrapped = input.archives.map((archive, index) => {
        let name = safeArtifactName(archive.fileName);
        if (usedNames.has(name)) {
          name = `${index + 1}-${name}`;
        }
        usedNames.add(name);
        return { path: name, content: writeZipArchive(archive.files) };
      });
      fileName = `urmotiv-export-${input.targetFormat}.zip`;
      bytes = writeZipArchive(wrapped);
    }

    assertActive(input.signal);
    const staged = await this.#storage.stage({
      originalName: fileName,
      mediaType: "application/zip",
      content: singleChunk(bytes)
    });
    let stored: StoredFile;
    try {
      stored = await this.#storage.publish(staged);
    } catch (error) {
      await this.#discardStaged(staged);
      throw error;
    }

    const expiresAt = new Date(this.#now().getTime() + this.#timeToLiveMs).toISOString();
    try {
      await this.#metadata.createStoredFile({
        id: stored.id,
        purpose: "export_output",
        storageKey: stored.storageKey,
        originalName: fileName,
        mediaType: "application/zip",
        byteSize: stored.byteSize,
        sha256: stored.sha256,
        createdByUserId: input.requestedByUserId,
        expiresAt
      });
    } catch (error) {
      await this.#storage.delete(stored).catch(() => undefined);
      throw error;
    }
    return { fileId: stored.id, expiresAt };
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

function safeArtifactName(name: string): string {
  const trimmed = name.trim().replace(/[\u0000-\u001f\u007f/\\]/gu, "_");
  const bounded = trimmed.length === 0 ? "problem.zip" : trimmed.slice(0, 120);
  return bounded.toLowerCase().endsWith(".zip") ? bounded : `${bounded}.zip`;
}
