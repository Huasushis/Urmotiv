import { createHash, randomUUID } from "node:crypto";
import {
  createProblemPackageExportJobSchema,
  createProblemPackageImportJobSchema,
  importItemOutcomeSchema,
  problemExportJobType,
  problemImportJobType,
  problemPackageExportJobSchema,
  problemPackageImportItemSchema,
  problemPackageImportJobSchema,
  problemPackageJobReportSchema,
  safeProblemPackageFailure,
  type CompleteProblemPackageExport,
  type CreateProblemPackageExportJob,
  type CreateProblemPackageImportJob,
  type ImportItemOutcome,
  type ProblemPackageExportJob,
  type ProblemPackageFailureCode,
  type ProblemPackageImportItem,
  type ProblemPackageImportJob,
  type ProblemPackageJobReport,
  type JobQueue,
  type ProblemPackageJobStore
} from "@urmotiv/jobs";
import type { DatabaseExecutor, DatabaseHandle } from "@urmotiv/database";
import { sql } from "drizzle-orm";
import { z } from "zod";
import {
  DatabaseProblemPackageAuditWriter,
  type ProblemPackageAuditWriter
} from "./problem-package-audit";

type JsonObject = Record<string, unknown>;

const databaseIdSchema = z.string().regex(/^(0|[1-9]\d*)$/);
const uuidSchema = z.string().uuid();
const taskStateSchema = z.enum(["queued", "running", "succeeded", "failed", "cancelled"]);

interface ImportJobRow extends Record<string, unknown> {
  id: string;
  requested_by_user_id: string;
  source_file_id: string;
  input_digest: string;
  detected_format: string | null;
  selected_format: string;
  choices: unknown;
  state: string;
  progress_percent: number;
  report: unknown;
  failure_code: string | null;
  failure_message: string | null;
  idempotency_key: string;
  started_at: Date | string | null;
  finished_at: Date | string | null;
  created_at: Date | string;
}

interface ImportItemRow extends Record<string, unknown> {
  job_id: string;
  position: number;
  state: string;
  imported_problem_id: string | null;
  failure_code: string | null;
  failure_message: string | null;
  finished_at: Date | string | null;
}

interface ExportJobRow extends Record<string, unknown> {
  id: string;
  requested_by_user_id: string;
  target_format: string;
  options: unknown;
  loss_report: unknown;
  state: string;
  progress_percent: number;
  report: unknown;
  result_file_id: string | null;
  result_expires_at: Date | string | null;
  failure_code: string | null;
  failure_message: string | null;
  idempotency_key: string;
  started_at: Date | string | null;
  finished_at: Date | string | null;
  created_at: Date | string;
}

interface ExportProblemRow extends Record<string, unknown> {
  job_id: string;
  position: number;
  problem_id: string;
  revision_id: string;
  included_file_categories: unknown;
}

export type ProblemPackageJobStoreErrorCode =
  | "IDEMPOTENCY_CONFLICT"
  | "INPUT_FILE_NOT_FOUND"
  | "FIXED_REVISION_NOT_FOUND"
  | "TASK_NOT_FOUND"
  | "INVALID_STATE";

/** Error messages intentionally contain no archive path or problem content. */
export class ProblemPackageJobStoreError extends Error {
  public constructor(
    public readonly code: ProblemPackageJobStoreErrorCode,
    message: string
  ) {
    super(message);
    this.name = "ProblemPackageJobStoreError";
  }
}

export interface InMemoryProblemPackageJobStoreOptions {
  readonly now?: () => Date;
}

/**
 * Saves the full immutable snapshot first, then queues only its task ID. A
 * retry after a queue outage reuses both records through their idempotency
 * keys, so no problem content or file bytes enter Redis.
 */
export class ProblemPackageJobCoordinator {
  public constructor(
    private readonly store: ProblemPackageJobStore,
    private readonly queue: JobQueue
  ) {}

  public async createImportJob(
    input: CreateProblemPackageImportJob
  ): Promise<ProblemPackageImportJob> {
    const task = await this.store.createImportJob(input);
    await this.queue.enqueue({
      type: problemImportJobType,
      payload: { importJobId: task.id },
      idempotencyScope: "problem-package-import",
      idempotencyKey: task.id,
      maxAttempts: 3,
      timeoutMs: 15 * 60 * 1_000
    });
    return task;
  }

  public async createExportJob(
    input: CreateProblemPackageExportJob
  ): Promise<ProblemPackageExportJob> {
    const task = await this.store.createExportJob(input);
    await this.queue.enqueue({
      type: problemExportJobType,
      payload: { exportJobId: task.id },
      idempotencyScope: "problem-package-export",
      idempotencyKey: task.id,
      maxAttempts: 3,
      timeoutMs: 30 * 60 * 1_000
    });
    return task;
  }
}

/**
 * This is useful in API and worker tests. It stores only task snapshots and
 * summaries, never the archive bytes or converted problem content.
 */
export class InMemoryProblemPackageJobStore implements ProblemPackageJobStore {
  readonly #imports = new Map<string, ProblemPackageImportJob>();
  readonly #importItems = new Map<string, ProblemPackageImportItem[]>();
  readonly #exports = new Map<string, ProblemPackageExportJob>();
  readonly #importIdempotency = new Map<string, string>();
  readonly #exportIdempotency = new Map<string, string>();
  readonly #now: () => Date;

  public constructor(options: InMemoryProblemPackageJobStoreOptions = {}) {
    this.#now = options.now ?? (() => new Date());
  }

  public async createImportJob(input: CreateProblemPackageImportJob): Promise<ProblemPackageImportJob> {
    const parsed = createProblemPackageImportJobSchema.parse(input);
    const key = idempotencyIndex(parsed.requestedByUserId, parsed.idempotencyKey);
    const existingId = this.#importIdempotency.get(key);
    if (existingId !== undefined) {
      const existing = this.#imports.get(existingId);
      if (existing === undefined) {
        throw new ProblemPackageJobStoreError("TASK_NOT_FOUND", "任务记录不存在。");
      }
      if (!sameImportRequest(existing, parsed)) {
        throw new ProblemPackageJobStoreError(
          "IDEMPOTENCY_CONFLICT",
          "同一个请求编号不能用于不同的导入任务。"
        );
      }
      return copy(existing);
    }

    const now = this.#now().toISOString();
    const job = problemPackageImportJobSchema.parse({
      id: randomUUID(),
      requestedByUserId: parsed.requestedByUserId,
      sourceFileId: parsed.sourceFileId,
      inputDigest: parsed.inputDigest,
      detectedFormat: parsed.detectedFormat ?? null,
      selectedFormat: parsed.selectedFormat,
      choices: parsed.choices,
      itemCount: parsed.itemCount,
      state: "queued",
      progressPercent: 0,
      report: initialReport(),
      failure: null,
      idempotencyKey: parsed.idempotencyKey,
      startedAt: null,
      finishedAt: null,
      createdAt: now
    });
    this.#imports.set(job.id, job);
    this.#importItems.set(
      job.id,
      Array.from({ length: job.itemCount }, (_, position) =>
        problemPackageImportItemSchema.parse({
          jobId: job.id,
          position,
          state: "queued",
          importedProblemId: null,
          failure: null,
          finishedAt: null
        })
      )
    );
    this.#importIdempotency.set(key, job.id);
    return copy(job);
  }

  public async createExportJob(input: CreateProblemPackageExportJob): Promise<ProblemPackageExportJob> {
    const parsed = createProblemPackageExportJobSchema.parse(input);
    const key = idempotencyIndex(parsed.requestedByUserId, parsed.idempotencyKey);
    const existingId = this.#exportIdempotency.get(key);
    if (existingId !== undefined) {
      const existing = this.#exports.get(existingId);
      if (existing === undefined) {
        throw new ProblemPackageJobStoreError("TASK_NOT_FOUND", "任务记录不存在。");
      }
      if (!sameExportRequest(existing, parsed)) {
        throw new ProblemPackageJobStoreError(
          "IDEMPOTENCY_CONFLICT",
          "同一个请求编号不能用于不同的导出任务。"
        );
      }
      return copy(existing);
    }

    const now = this.#now().toISOString();
    const job = problemPackageExportJobSchema.parse({
      id: randomUUID(),
      requestedByUserId: parsed.requestedByUserId,
      targetFormat: parsed.targetFormat,
      options: parsed.options,
      lossSummary: parsed.lossSummary,
      problems: parsed.problems,
      state: "queued",
      progressPercent: 0,
      report: initialReport(),
      resultFileId: null,
      resultExpiresAt: null,
      failure: null,
      idempotencyKey: parsed.idempotencyKey,
      startedAt: null,
      finishedAt: null,
      createdAt: now
    });
    this.#exports.set(job.id, job);
    this.#exportIdempotency.set(key, job.id);
    return copy(job);
  }

  public async getImportJob(jobId: string): Promise<ProblemPackageImportJob | undefined> {
    uuidSchema.parse(jobId);
    const job = this.#imports.get(jobId);
    return job === undefined ? undefined : copy(job);
  }

  public async getImportItems(jobId: string): Promise<readonly ProblemPackageImportItem[]> {
    uuidSchema.parse(jobId);
    return (this.#importItems.get(jobId) ?? []).map(copy);
  }

  public async getExportJob(jobId: string): Promise<ProblemPackageExportJob | undefined> {
    uuidSchema.parse(jobId);
    const job = this.#exports.get(jobId);
    return job === undefined ? undefined : copy(job);
  }

  public async startImportJob(jobId: string): Promise<ProblemPackageImportJob | undefined> {
    return this.#startImport(jobId);
  }

  public async startExportJob(jobId: string): Promise<ProblemPackageExportJob | undefined> {
    return this.#startExport(jobId);
  }

  public async updateImportJob(
    jobId: string,
    progressPercent: number,
    report: ProblemPackageJobReport
  ): Promise<void> {
    const job = this.#requiredImport(jobId);
    assertRunning(job.state);
    const parsedReport = problemPackageJobReportSchema.parse(report);
    this.#imports.set(job.id, { ...job, progressPercent: parseProgress(progressPercent), report: parsedReport });
  }

  public async updateExportJob(
    jobId: string,
    progressPercent: number,
    report: ProblemPackageJobReport
  ): Promise<void> {
    const job = this.#requiredExport(jobId);
    assertRunning(job.state);
    const parsedReport = problemPackageJobReportSchema.parse(report);
    this.#exports.set(job.id, { ...job, progressPercent: parseProgress(progressPercent), report: parsedReport });
  }

  public async recordImportItem(
    jobId: string,
    position: number,
    outcome: ImportItemOutcome
  ): Promise<void> {
    const job = this.#requiredImport(jobId);
    assertRunning(job.state);
    const parsed = importItemOutcomeSchema.parse(outcome);
    const items = this.#importItems.get(job.id);
    if (items === undefined || !Number.isInteger(position) || position < 0 || position >= items.length) {
      throw new ProblemPackageJobStoreError("TASK_NOT_FOUND", "导入项目不存在。");
    }
    const currentItem = items[position];
    if (currentItem?.state === "succeeded") {
      if (
        parsed.state === "succeeded" &&
        currentItem.importedProblemId === parsed.importedProblemId
      ) {
        return;
      }
      throw new ProblemPackageJobStoreError(
        "INVALID_STATE",
        "已经成功的导入项目不能改成其他结果。"
      );
    }
    const failure = parsed.failureCode === undefined ? null : safeProblemPackageFailure(parsed.failureCode);
    items[position] = problemPackageImportItemSchema.parse({
      jobId: job.id,
      position,
      state: parsed.state,
      importedProblemId: parsed.importedProblemId ?? null,
      failure,
      finishedAt: this.#now().toISOString()
    });
  }

  public async completeImportJob(jobId: string, report: ProblemPackageJobReport): Promise<void> {
    const job = this.#requiredImport(jobId);
    assertRunning(job.state);
    this.#imports.set(job.id, {
      ...job,
      state: "succeeded",
      progressPercent: 100,
      report: completeReport(report),
      failure: null,
      finishedAt: this.#now().toISOString()
    });
  }

  public async completeExportJob(
    jobId: string,
    result: CompleteProblemPackageExport
  ): Promise<void> {
    const job = this.#requiredExport(jobId);
    assertRunning(job.state);
    const parsed = parseCompleteExport(result);
    this.#exports.set(job.id, {
      ...job,
      state: "succeeded",
      progressPercent: 100,
      report: {
        ...completeReport(job.report),
        outputFileCount: parsed.outputFileCount
      },
      resultFileId: parsed.resultFileId,
      resultExpiresAt: parsed.resultExpiresAt,
      failure: null,
      finishedAt: this.#now().toISOString()
    });
  }

  public async failImportJob(
    jobId: string,
    code: ProblemPackageFailureCode,
    report: ProblemPackageJobReport
  ): Promise<void> {
    const job = this.#requiredImport(jobId);
    assertRunning(job.state);
    const items = this.#importItems.get(job.id) ?? [];
    if (items.some((item) => item.state === "succeeded")) {
      throw new ProblemPackageJobStoreError(
        "INVALID_STATE",
        "已有导入项目成功，任务不能标记为失败。"
      );
    }
    this.#imports.set(job.id, {
      ...job,
      state: "failed",
      report: failedReport(report),
      failure: safeProblemPackageFailure(code),
      finishedAt: this.#now().toISOString()
    });
  }

  public async failExportJob(jobId: string, code: ProblemPackageFailureCode): Promise<void> {
    const job = this.#requiredExport(jobId);
    assertRunning(job.state);
    this.#exports.set(job.id, {
      ...job,
      state: "failed",
      report: failedReport(job.report),
      failure: safeProblemPackageFailure(code),
      finishedAt: this.#now().toISOString()
    });
  }

  #startImport(jobId: string): ProblemPackageImportJob | undefined {
    const job = this.#imports.get(uuidSchema.parse(jobId));
    if (job === undefined) return undefined;
    if (job.state !== "queued") return copy(job);
    const started = { ...job, state: "running" as const, report: { ...job.report, phase: "reading" as const }, startedAt: this.#now().toISOString() };
    this.#imports.set(job.id, started);
    return copy(started);
  }

  #startExport(jobId: string): ProblemPackageExportJob | undefined {
    const job = this.#exports.get(uuidSchema.parse(jobId));
    if (job === undefined) return undefined;
    if (job.state !== "queued") return copy(job);
    const started = { ...job, state: "running" as const, report: { ...job.report, phase: "reading" as const }, startedAt: this.#now().toISOString() };
    this.#exports.set(job.id, started);
    return copy(started);
  }

  #requiredImport(jobId: string): ProblemPackageImportJob {
    const job = this.#imports.get(uuidSchema.parse(jobId));
    if (job === undefined) throw new ProblemPackageJobStoreError("TASK_NOT_FOUND", "任务记录不存在。");
    return job;
  }

  #requiredExport(jobId: string): ProblemPackageExportJob {
    const job = this.#exports.get(uuidSchema.parse(jobId));
    if (job === undefined) throw new ProblemPackageJobStoreError("TASK_NOT_FOUND", "任务记录不存在。");
    return job;
  }
}

/**
 * PostgreSQL/PGlite implementation for the existing task tables. The caller
 * must perform authorization before creation; this class additionally proves
 * that an import source and every fixed export revision exists.
 */
export class DatabaseProblemPackageJobStore implements ProblemPackageJobStore {
  public constructor(
    private readonly database: DatabaseHandle,
    private readonly audit: ProblemPackageAuditWriter =
      new DatabaseProblemPackageAuditWriter(database),
    private readonly now: () => Date = () => new Date()
  ) {}

  public async createImportJob(input: CreateProblemPackageImportJob): Promise<ProblemPackageImportJob> {
    const parsed = createProblemPackageImportJobSchema.parse(input);
    const requesterId = requireDatabaseId(parsed.requestedByUserId, "请求用户编号");
    return this.database.transaction(async (transaction) => {
      const existing = await findImportByIdempotency(transaction, requesterId, parsed.idempotencyKey);
      if (existing !== undefined) {
        if (!sameImportRequest(existing, parsed)) {
          throw new ProblemPackageJobStoreError("IDEMPOTENCY_CONFLICT", "同一个请求编号不能用于不同的导入任务。");
        }
        return existing;
      }

      const source = await transaction.query<{ id: string }>(sql`
        SELECT id::text AS id
        FROM stored_files
        WHERE id = ${parsed.sourceFileId}::uuid
          AND purpose = 'import_input'
          AND sha256 = ${parsed.inputDigest}
          AND deleted_at IS NULL
          AND (expires_at IS NULL OR expires_at > ${this.now().toISOString()}::timestamptz)
      `);
      if (source.length !== 1) {
        throw new ProblemPackageJobStoreError("INPUT_FILE_NOT_FOUND", "导入文件不存在、已过期或已改变。");
      }

      const id = randomUUID();
      const now = this.now().toISOString();
      await transaction.execute(sql`
        INSERT INTO import_jobs (
          id, requested_by_user_id, source_file_id, detected_format, selected_format,
          input_digest, choices, state, progress_percent, report, idempotency_key, created_at
        ) VALUES (
          ${id}::uuid, ${requesterId}, ${parsed.sourceFileId}::uuid,
          ${parsed.detectedFormat ?? null}, ${parsed.selectedFormat}, ${parsed.inputDigest},
          ${json(parsed.choices)}::jsonb, 'queued', 0, ${json(initialReport())}::jsonb,
          ${parsed.idempotencyKey}, ${now}::timestamptz
        )
      `);
      for (let position = 0; position < parsed.itemCount; position += 1) {
        await transaction.execute(sql`
          INSERT INTO import_job_items (job_id, position, source_label, state, report)
          VALUES (${id}::uuid, ${position}, ${String(position + 1)}, 'queued', ${json({})}::jsonb)
        `);
      }
      const created = await findImportById(transaction, id);
      if (created === undefined) throw new ProblemPackageJobStoreError("TASK_NOT_FOUND", "任务记录不存在。");
      await this.writeImportCreationAudit(transaction, parsed, created);
      return created;
    });
  }

  public async createExportJob(input: CreateProblemPackageExportJob): Promise<ProblemPackageExportJob> {
    const parsed = createProblemPackageExportJobSchema.parse(input);
    const requesterId = requireDatabaseId(parsed.requestedByUserId, "请求用户编号");
    return this.database.transaction(async (transaction) => {
      const existing = await findExportByIdempotency(transaction, requesterId, parsed.idempotencyKey);
      if (existing !== undefined) {
        if (!sameExportRequest(existing, parsed)) {
          throw new ProblemPackageJobStoreError("IDEMPOTENCY_CONFLICT", "同一个请求编号不能用于不同的导出任务。");
        }
        return existing;
      }

      for (const selection of parsed.problems) {
        const revision = await transaction.query<{ id: string }>(sql`
          SELECT id::text AS id
          FROM problem_revisions
          WHERE id = ${selection.revisionId}::uuid
            AND problem_id = ${requireDatabaseId(selection.problemId, "题目编号")}
        `);
        if (revision.length !== 1) {
          throw new ProblemPackageJobStoreError("FIXED_REVISION_NOT_FOUND", "所选题目版本不存在。");
        }
      }

      const id = randomUUID();
      const now = this.now().toISOString();
      await transaction.execute(sql`
        INSERT INTO export_jobs (
          id, requested_by_user_id, target_format, options, loss_report, state,
          progress_percent, report, idempotency_key, created_at
        ) VALUES (
          ${id}::uuid, ${requesterId}, ${parsed.targetFormat}, ${json(parsed.options)}::jsonb,
          ${json(parsed.lossSummary)}::jsonb, 'queued', 0, ${json(initialReport())}::jsonb,
          ${parsed.idempotencyKey}, ${now}::timestamptz
        )
      `);
      for (const [position, selection] of parsed.problems.entries()) {
        await transaction.execute(sql`
          INSERT INTO export_job_problems (
            job_id, position, problem_id, revision_id, included_file_categories
          ) VALUES (
            ${id}::uuid, ${position}, ${requireDatabaseId(selection.problemId, "题目编号")},
            ${selection.revisionId}::uuid, ${json(selection.includedFileCategories)}::jsonb
          )
        `);
      }
      const created = await findExportById(transaction, id);
      if (created === undefined) throw new ProblemPackageJobStoreError("TASK_NOT_FOUND", "任务记录不存在。");
      await this.writeExportCreationAudit(transaction, parsed, created);
      return created;
    });
  }

  private async writeImportCreationAudit(
    executor: DatabaseExecutor,
    input: z.output<typeof createProblemPackageImportJobSchema>,
    job: ProblemPackageImportJob
  ): Promise<void> {
    if (input.auditRequestId === undefined) return;
    await this.audit.append(
      {
        actorUserId: input.requestedByUserId,
        requestId: input.auditRequestId,
        action: "problem.package.import.create",
        objectType: "import_job",
        objectId: job.id,
        result: "success",
        reasonCode: null,
        metadata: {
          formatId: job.selectedFormat,
          itemCount: job.itemCount
        }
      },
      executor
    );
  }

  private async writeExportCreationAudit(
    executor: DatabaseExecutor,
    input: z.output<typeof createProblemPackageExportJobSchema>,
    job: ProblemPackageExportJob
  ): Promise<void> {
    if (input.auditRequestId === undefined) return;
    await this.audit.append(
      {
        actorUserId: input.requestedByUserId,
        requestId: input.auditRequestId,
        action: "problem.package.export.create",
        objectType: "export_job",
        objectId: job.id,
        result: "success",
        reasonCode: null,
        metadata: {
          formatId: job.targetFormat,
          problemCount: job.problems.length
        }
      },
      executor
    );
  }

  public async getImportJob(jobId: string): Promise<ProblemPackageImportJob | undefined> {
    return findImportById(this.database, uuidSchema.parse(jobId));
  }

  public async getImportItems(jobId: string): Promise<readonly ProblemPackageImportItem[]> {
    const id = uuidSchema.parse(jobId);
    const rows = await this.database.query<ImportItemRow>(sql`
      SELECT job_id::text, position, state::text, imported_problem_id::text,
             failure_code, failure_message, finished_at
      FROM import_job_items
      WHERE job_id = ${id}::uuid
      ORDER BY position ASC
    `);
    return rows.map(hydrateImportItem);
  }

  public async getExportJob(jobId: string): Promise<ProblemPackageExportJob | undefined> {
    return findExportById(this.database, uuidSchema.parse(jobId));
  }

  public async startImportJob(jobId: string): Promise<ProblemPackageImportJob | undefined> {
    const id = uuidSchema.parse(jobId);
    await this.database.execute(sql`
      UPDATE import_jobs
      SET state = 'running', started_at = COALESCE(started_at, ${this.now().toISOString()}::timestamptz),
          report = ${json({ ...initialReport(), phase: "reading" })}::jsonb
      WHERE id = ${id}::uuid AND state = 'queued'
    `);
    return this.getImportJob(id);
  }

  public async startExportJob(jobId: string): Promise<ProblemPackageExportJob | undefined> {
    const id = uuidSchema.parse(jobId);
    await this.database.execute(sql`
      UPDATE export_jobs
      SET state = 'running', started_at = COALESCE(started_at, ${this.now().toISOString()}::timestamptz),
          report = ${json({ ...initialReport(), phase: "reading" })}::jsonb
      WHERE id = ${id}::uuid AND state = 'queued'
    `);
    return this.getExportJob(id);
  }

  public async updateImportJob(
    jobId: string,
    progressPercent: number,
    report: ProblemPackageJobReport
  ): Promise<void> {
    await this.updateImport(uuidSchema.parse(jobId), parseProgress(progressPercent), problemPackageJobReportSchema.parse(report));
  }

  public async updateExportJob(
    jobId: string,
    progressPercent: number,
    report: ProblemPackageJobReport
  ): Promise<void> {
    await this.updateExport(uuidSchema.parse(jobId), parseProgress(progressPercent), problemPackageJobReportSchema.parse(report));
  }

  public async recordImportItem(
    jobId: string,
    position: number,
    outcome: ImportItemOutcome
  ): Promise<void> {
    const id = uuidSchema.parse(jobId);
    const parsed = importItemOutcomeSchema.parse(outcome);
    const failure = parsed.failureCode === undefined ? null : safeProblemPackageFailure(parsed.failureCode);
    const importedProblemId =
      parsed.importedProblemId === undefined
        ? null
        : requireDatabaseId(parsed.importedProblemId, "题目编号");
    const stateGuard =
      parsed.state === "succeeded" && importedProblemId !== null
        ? sql`
            AND (
              (state <> 'succeeded' AND imported_problem_id IS NULL)
              OR (state = 'succeeded' AND imported_problem_id = ${importedProblemId})
            )
          `
        : sql`AND state <> 'succeeded' AND imported_problem_id IS NULL`;
    await this.database.transaction(async (transaction) => {
      const locked = await transaction.query<{ state: string }>(sql`
        SELECT state::text AS state
        FROM import_jobs
        WHERE id = ${id}::uuid
        FOR UPDATE
      `);
      if (locked[0]?.state !== "running") {
        throw new ProblemPackageJobStoreError(
          "INVALID_STATE",
          "任务当前不能更新导入项目。"
        );
      }
      const result = await transaction.query<{ position: number }>(sql`
        UPDATE import_job_items
        SET state = ${parsed.state},
            imported_problem_id = ${importedProblemId},
            report = ${json({})}::jsonb,
            failure_code = ${failure?.code ?? null},
            failure_message = ${failure?.message ?? null},
            finished_at = ${this.now().toISOString()}::timestamptz
        WHERE job_id = ${id}::uuid AND position = ${parsePosition(position)}
          ${stateGuard}
        RETURNING position
      `);
      if (result.length !== 1) {
        throw new ProblemPackageJobStoreError(
          "INVALID_STATE",
          "任务当前不能更新导入项目。"
        );
      }
    });
  }

  public async completeImportJob(jobId: string, report: ProblemPackageJobReport): Promise<void> {
    const result = await this.database.query<{ id: string }>(sql`
      UPDATE import_jobs
      SET state = 'succeeded', progress_percent = 100,
          report = ${json(completeReport(report))}::jsonb,
          failure_code = NULL, failure_message = NULL,
          finished_at = ${this.now().toISOString()}::timestamptz
      WHERE id = ${uuidSchema.parse(jobId)}::uuid AND state = 'running'
      RETURNING id::text AS id
    `);
    if (result.length !== 1) throw new ProblemPackageJobStoreError("INVALID_STATE", "任务当前不能完成。");
  }

  public async completeExportJob(
    jobId: string,
    result: CompleteProblemPackageExport
  ): Promise<void> {
    await this.database.transaction((transaction) =>
      completeDatabaseExportJob(transaction, this.audit, this.now, jobId, result)
    );
  }

  public async failImportJob(
    jobId: string,
    code: ProblemPackageFailureCode,
    report: ProblemPackageJobReport
  ): Promise<void> {
    const id = uuidSchema.parse(jobId);
    const failure = safeProblemPackageFailure(code);
    const parsedReport = problemPackageJobReportSchema.parse(report);
    await this.database.transaction(async (transaction) => {
      const locked = await transaction.query<{ state: string }>(sql`
        SELECT state::text AS state
        FROM import_jobs
        WHERE id = ${id}::uuid
        FOR UPDATE
      `);
      if (locked[0]?.state !== "running") {
        throw new ProblemPackageJobStoreError(
          "INVALID_STATE",
          "任务当前不能标记为失败。"
        );
      }
      const succeeded = await transaction.query<{ position: number }>(sql`
        SELECT position
        FROM import_job_items
        WHERE job_id = ${id}::uuid
          AND state = 'succeeded'
        LIMIT 1
      `);
      if (succeeded.length > 0) {
        throw new ProblemPackageJobStoreError(
          "INVALID_STATE",
          "已有导入项目成功，任务不能标记为失败。"
        );
      }
      const updated = await transaction.query<{ id: string }>(sql`
        UPDATE import_jobs
        SET state = 'failed', report = ${json(failedReport(parsedReport))}::jsonb,
            failure_code = ${failure.code}, failure_message = ${failure.message},
            finished_at = ${this.now().toISOString()}::timestamptz
        WHERE id = ${id}::uuid AND state = 'running'
        RETURNING id::text AS id
      `);
      if (updated.length !== 1) {
        throw new ProblemPackageJobStoreError(
          "INVALID_STATE",
          "任务当前不能标记为失败。"
        );
      }
    });
  }

  public async failExportJob(jobId: string, code: ProblemPackageFailureCode): Promise<void> {
    const failure = safeProblemPackageFailure(code);
    const id = uuidSchema.parse(jobId);
    const current = await this.getExportJob(id);
    const updated = await this.database.query<{ id: string }>(sql`
      UPDATE export_jobs
      SET state = 'failed', report = ${json(failedReport(current?.report ?? initialReport()))}::jsonb,
          failure_code = ${failure.code}, failure_message = ${failure.message},
          finished_at = ${this.now().toISOString()}::timestamptz
      WHERE id = ${id}::uuid AND state = 'running'
      RETURNING id::text AS id
    `);
    if (updated.length !== 1) throw new ProblemPackageJobStoreError("INVALID_STATE", "任务当前不能标记为失败。");
  }

  private async updateImport(
    id: string,
    progressPercent: number,
    report: ProblemPackageJobReport
  ): Promise<void> {
    const updated = await this.database.query<{ id: string }>(sql`
      UPDATE import_jobs
      SET progress_percent = ${progressPercent}, report = ${json(report)}::jsonb
      WHERE id = ${id}::uuid AND state = 'running' AND progress_percent <= ${progressPercent}
      RETURNING id::text AS id
    `);
    if (updated.length !== 1) throw new ProblemPackageJobStoreError("INVALID_STATE", "任务当前不能更新进度。");
  }

  private async updateExport(
    id: string,
    progressPercent: number,
    report: ProblemPackageJobReport
  ): Promise<void> {
    const updated = await this.database.query<{ id: string }>(sql`
      UPDATE export_jobs
      SET progress_percent = ${progressPercent}, report = ${json(report)}::jsonb
      WHERE id = ${id}::uuid AND state = 'running' AND progress_percent <= ${progressPercent}
      RETURNING id::text AS id
    `);
    if (updated.length !== 1) throw new ProblemPackageJobStoreError("INVALID_STATE", "任务当前不能更新进度。");
  }
}

/**
 * 供导出文件写入器复用：调用方可以把文件元数据写入和任务完成放进同一个数据库事务。
 * 相同结果重复提交会直接成功，不会改写成另一份文件。
 */
export async function completeDatabaseExportJob(
  executor: DatabaseExecutor,
  audit: ProblemPackageAuditWriter,
  now: () => Date,
  jobId: string,
  result: CompleteProblemPackageExport
): Promise<void> {
  const id = uuidSchema.parse(jobId);
  const parsed = parseCompleteExport(result);
  const resultExpiresAt = new Date(parsed.resultExpiresAt).toISOString();
  const current = await findExportById(executor, id);
  if (current === undefined) {
    throw new ProblemPackageJobStoreError("TASK_NOT_FOUND", "任务记录不存在。");
  }
  if (current.state === "succeeded") {
    if (
      current.resultFileId === parsed.resultFileId &&
      current.resultExpiresAt === resultExpiresAt &&
      current.report.outputFileCount === parsed.outputFileCount
    ) {
      return;
    }
    throw new ProblemPackageJobStoreError("INVALID_STATE", "任务当前不能完成。");
  }
  if (current.state !== "running") {
    throw new ProblemPackageJobStoreError("INVALID_STATE", "任务当前不能完成。");
  }

  const completedReport = {
    ...completeReport(current.report),
    outputFileCount: parsed.outputFileCount
  };
  const updated = await executor.query<{ id: string }>(sql`
    UPDATE export_jobs
    SET state = 'succeeded', progress_percent = 100,
        report = ${json(completedReport)}::jsonb,
        result_file_id = ${parsed.resultFileId}::uuid,
        result_expires_at = ${resultExpiresAt}::timestamptz,
        failure_code = NULL, failure_message = NULL,
        finished_at = ${now().toISOString()}::timestamptz
    WHERE id = ${id}::uuid AND state = 'running'
    RETURNING id::text AS id
  `);
  if (updated.length !== 1) {
    throw new ProblemPackageJobStoreError("INVALID_STATE", "任务当前不能完成。");
  }
  await audit.append(
    {
      actorUserId: current.requestedByUserId,
      requestId: id,
      action: "problem.package.export.complete",
      objectType: "export_job",
      objectId: id,
      result: "success",
      reasonCode: null,
      metadata: {
        formatId: current.targetFormat,
        outputFileCount: parsed.outputFileCount
      }
    },
    executor
  );
}

function initialReport(): ProblemPackageJobReport {
  return { version: 1, phase: "queued", completedItems: 0, failedItems: 0, skippedItems: 0 };
}

function completeReport(report: ProblemPackageJobReport): ProblemPackageJobReport {
  return { ...problemPackageJobReportSchema.parse(report), phase: "completed" };
}

function failedReport(report: ProblemPackageJobReport): ProblemPackageJobReport {
  return { ...problemPackageJobReportSchema.parse(report), phase: "failed" };
}

function parseProgress(value: number): number {
  return z.number().int().min(0).max(100).parse(value);
}

function parsePosition(value: number): number {
  return z.number().int().min(0).max(999).parse(value);
}

function parseCompleteExport(value: CompleteProblemPackageExport): CompleteProblemPackageExport {
  return z
    .object({
      resultFileId: uuidSchema,
      resultExpiresAt: z.string().datetime(),
      outputFileCount: countSchema
    })
    .strict()
    .parse(value);
}

const countSchema = z.number().int().min(0).max(10_000);

function assertRunning(state: string): void {
  if (state !== "running") {
    throw new ProblemPackageJobStoreError("INVALID_STATE", "任务当前不能更新。");
  }
}

function requireDatabaseId(value: string, label: string): bigint {
  const parsed = databaseIdSchema.parse(value);
  return BigInt(parsed);
}

function json(value: unknown): string {
  return JSON.stringify(value);
}

function copy<T>(value: T): T {
  return structuredClone(value);
}

function idempotencyIndex(userId: string, key: string): string {
  return createHash("sha256").update(`${userId}\u0000${key}`).digest("hex");
}

function sameImportRequest(
  existing: ProblemPackageImportJob,
  input: z.output<typeof createProblemPackageImportJobSchema>
): boolean {
  return stableJson({
    sourceFileId: existing.sourceFileId,
    inputDigest: existing.inputDigest,
    detectedFormat: existing.detectedFormat,
    selectedFormat: existing.selectedFormat,
    choices: existing.choices,
    itemCount: existing.itemCount
  }) === stableJson({
    sourceFileId: input.sourceFileId,
    inputDigest: input.inputDigest,
    detectedFormat: input.detectedFormat ?? null,
    selectedFormat: input.selectedFormat,
    choices: input.choices,
    itemCount: input.itemCount
  });
}

function sameExportRequest(
  existing: ProblemPackageExportJob,
  input: z.output<typeof createProblemPackageExportJobSchema>
): boolean {
  return stableJson({
    targetFormat: existing.targetFormat,
    options: existing.options,
    lossSummary: existing.lossSummary,
    problems: existing.problems
  }) === stableJson({
    targetFormat: input.targetFormat,
    options: input.options,
    lossSummary: input.lossSummary,
    problems: input.problems
  });
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  return `{${Object.entries(value as JsonObject)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, child]) => `${JSON.stringify(key)}:${stableJson(child)}`)
    .join(",")}}`;
}

async function findImportById(
  executor: Pick<DatabaseExecutor | DatabaseHandle, "query">,
  id: string
): Promise<ProblemPackageImportJob | undefined> {
  const rows = await executor.query<ImportJobRow>(sql`
    SELECT id::text, requested_by_user_id::text, source_file_id::text, input_digest,
           detected_format, selected_format, choices, state::text, progress_percent,
           report, failure_code, failure_message, idempotency_key, started_at, finished_at, created_at
    FROM import_jobs WHERE id = ${id}::uuid
  `);
  if (rows.length === 0) return undefined;
  const row = rows[0];
  if (row === undefined) return undefined;
  const items = await executor.query<{ count: number }>(sql`
    SELECT count(*)::integer AS count FROM import_job_items WHERE job_id = ${id}::uuid
  `);
  return hydrateImport(row, items[0]?.count ?? 0);
}

async function findImportByIdempotency(
  executor: DatabaseExecutor,
  requesterId: bigint,
  idempotencyKey: string
): Promise<ProblemPackageImportJob | undefined> {
  const rows = await executor.query<ImportJobRow>(sql`
    SELECT id::text, requested_by_user_id::text, source_file_id::text, input_digest,
           detected_format, selected_format, choices, state::text, progress_percent,
           report, failure_code, failure_message, idempotency_key, started_at, finished_at, created_at
    FROM import_jobs
    WHERE requested_by_user_id = ${requesterId} AND idempotency_key = ${idempotencyKey}
  `);
  const row = rows[0];
  if (row === undefined) return undefined;
  const items = await executor.query<{ count: number }>(sql`
    SELECT count(*)::integer AS count FROM import_job_items WHERE job_id = ${row.id}::uuid
  `);
  return hydrateImport(row, items[0]?.count ?? 0);
}

async function findExportById(
  executor: Pick<DatabaseExecutor | DatabaseHandle, "query">,
  id: string
): Promise<ProblemPackageExportJob | undefined> {
  const rows = await executor.query<ExportJobRow>(sql`
    SELECT id::text, requested_by_user_id::text, target_format, options, loss_report,
           state::text, progress_percent, report, result_file_id::text, result_expires_at,
           failure_code, failure_message, idempotency_key, started_at, finished_at, created_at
    FROM export_jobs WHERE id = ${id}::uuid
  `);
  const row = rows[0];
  if (row === undefined) return undefined;
  const selections = await executor.query<ExportProblemRow>(sql`
    SELECT job_id::text, position, problem_id::text, revision_id::text, included_file_categories
    FROM export_job_problems WHERE job_id = ${id}::uuid ORDER BY position ASC
  `);
  return hydrateExport(row, selections);
}

async function findExportByIdempotency(
  executor: DatabaseExecutor,
  requesterId: bigint,
  idempotencyKey: string
): Promise<ProblemPackageExportJob | undefined> {
  const rows = await executor.query<ExportJobRow>(sql`
    SELECT id::text, requested_by_user_id::text, target_format, options, loss_report,
           state::text, progress_percent, report, result_file_id::text, result_expires_at,
           failure_code, failure_message, idempotency_key, started_at, finished_at, created_at
    FROM export_jobs
    WHERE requested_by_user_id = ${requesterId} AND idempotency_key = ${idempotencyKey}
  `);
  const row = rows[0];
  if (row === undefined) return undefined;
  const selections = await executor.query<ExportProblemRow>(sql`
    SELECT job_id::text, position, problem_id::text, revision_id::text, included_file_categories
    FROM export_job_problems WHERE job_id = ${row.id}::uuid ORDER BY position ASC
  `);
  return hydrateExport(row, selections);
}

function hydrateImport(row: ImportJobRow, itemCount: number): ProblemPackageImportJob {
  return problemPackageImportJobSchema.parse({
    id: row.id,
    requestedByUserId: row.requested_by_user_id,
    sourceFileId: row.source_file_id,
    inputDigest: row.input_digest,
    detectedFormat: row.detected_format,
    selectedFormat: row.selected_format,
    choices: jsonObject(row.choices, "导入选择"),
    itemCount,
    state: taskStateSchema.parse(row.state),
    progressPercent: Number(row.progress_percent),
    report: reportFromDatabase(row.report),
    failure: parseFailure(row.failure_code, row.failure_message),
    idempotencyKey: row.idempotency_key,
    startedAt: toIsoOrNull(row.started_at),
    finishedAt: toIsoOrNull(row.finished_at),
    createdAt: toIso(row.created_at)
  });
}

function hydrateImportItem(row: ImportItemRow): ProblemPackageImportItem {
  return problemPackageImportItemSchema.parse({
    jobId: row.job_id,
    position: Number(row.position),
    state: taskStateSchema.parse(row.state),
    importedProblemId: row.imported_problem_id,
    failure: parseFailure(row.failure_code, row.failure_message),
    finishedAt: toIsoOrNull(row.finished_at)
  });
}

function hydrateExport(
  row: ExportJobRow,
  selections: readonly ExportProblemRow[]
): ProblemPackageExportJob {
  return problemPackageExportJobSchema.parse({
    id: row.id,
    requestedByUserId: row.requested_by_user_id,
    targetFormat: row.target_format,
    options: jsonObject(row.options, "导出选项"),
    lossSummary: jsonObject(row.loss_report, "导出说明"),
    problems: selections.map((selection) => ({
      problemId: selection.problem_id,
      revisionId: selection.revision_id,
      includedFileCategories: jsonArray(selection.included_file_categories, "导出文件类别")
    })),
    state: taskStateSchema.parse(row.state),
    progressPercent: Number(row.progress_percent),
    report: reportFromDatabase(row.report),
    resultFileId: row.result_file_id,
    resultExpiresAt: toIsoOrNull(row.result_expires_at),
    failure: parseFailure(row.failure_code, row.failure_message),
    idempotencyKey: row.idempotency_key,
    startedAt: toIsoOrNull(row.started_at),
    finishedAt: toIsoOrNull(row.finished_at),
    createdAt: toIso(row.created_at)
  });
}

function reportFromDatabase(value: unknown): ProblemPackageJobReport {
  const parsed = jsonObject(value, "任务报告");
  if (Object.keys(parsed).length === 0) return initialReport();
  return problemPackageJobReportSchema.parse(parsed);
}

function parseFailure(code: string | null, message: string | null): { code: ProblemPackageFailureCode; message: string } | null {
  if (code === null || message === null) return null;
  const expected = safeProblemPackageFailure(code as ProblemPackageFailureCode);
  if (expected.message !== message) {
    throw new Error("数据库中的任务失败说明不符合安全格式。");
  }
  return expected;
}

function jsonObject(value: unknown, label: string): JsonObject {
  const parsed = typeof value === "string" ? JSON.parse(value) : value;
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`数据库中的${label}不是对象。`);
  }
  return parsed as JsonObject;
}

function jsonArray(value: unknown, label: string): unknown[] {
  const parsed = typeof value === "string" ? JSON.parse(value) : value;
  if (!Array.isArray(parsed)) throw new Error(`数据库中的${label}不是数组。`);
  return parsed;
}

function toIso(value: Date | string): string {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) throw new Error("数据库中的时间无效。");
  return date.toISOString();
}

function toIsoOrNull(value: Date | string | null): string | null {
  return value === null ? null : toIso(value);
}
