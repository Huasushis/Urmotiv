import { createHash } from "node:crypto";
import {
  fileOriginalNameSchema,
  packageDetectionSchema,
  type CreateExportJobRequest,
  type CreateImportJobRequest,
  type ExportJobView,
  type ExportPreviewRequest,
  type ExportPreviewResponse,
  type ImportJobView,
  type ImportPreviewRequest,
  type ImportPreviewResponse,
  type PackageFileCategory,
  type PackageUploadResponse
} from "@urmotiv/contracts";
import {
  coreProblemFormatAdapterCatalog,
  type ProblemPackageExportJob,
  type ProblemPackageExportSelection,
  type ProblemPackageImportItem,
  type ProblemPackageImportJob,
  type ProblemPackageJobStore,
  type FixedRevisionExportReader
} from "@urmotiv/jobs";
import type { DatabaseHandle } from "@urmotiv/database";
import {
  ProblemPackageJobCoordinator,
  ProblemPackageJobStoreError
} from "./problem-package-job-store";
import {
  UnsafeArchiveError,
  canonicalProblemSchema,
  defaultArchiveSafetyLimits,
  inputKindForProblemFormatAdapter,
  readProblemPackageInput,
  type ProblemFormatAdapter,
  type ProblemFormatAdapterCatalog,
  type SafeProblemPackageInput
} from "@urmotiv/problem-package";
import type { FileStorage, StoredFile } from "@urmotiv/storage";
import { sql } from "drizzle-orm";
import { ApiError, conflict, forbidden, notFound } from "./errors";
import type { StoredProblem, StoredUser } from "./domain";
import { hasPermission } from "./permissions";
import { ProblemFileStore } from "./problem-file-store";
import {
  ProblemPackageAuditWriteError,
  type ProblemPackageAuditEvent,
  type ProblemPackageAuditWriter
} from "./problem-package-audit";
import type { ProblemService } from "./service";

/**
 * 题目包导入导出的接口层。它负责：上传包的安全检查与登记、按格式预览、创建后台任务、
 * 查询任务状态、下载导出结果。所有权限判断都发生在这里或更深层，任务记录里永远没有
 * 题面、文件内容或存储位置。
 */

export const maximumProblemPackageArchiveBytes =
  defaultArchiveSafetyLimits.maxArchiveBytes;
const defaultUploadTimeToLiveMs = 24 * 60 * 60 * 1_000;

const internalPackageCategories: ReadonlySet<PackageFileCategory> = new Set([
  "testdata",
  "checker",
  "interactor",
  "answer_checker",
  "standard_solution",
  "internal_attachment"
]);

export interface TransferServiceDependencies {
  readonly database: DatabaseHandle;
  readonly service: ProblemService;
  readonly metadata: ProblemFileStore;
  readonly storage: FileStorage;
  readonly audit: ProblemPackageAuditWriter;
  readonly jobs: ProblemPackageJobStore;
  readonly coordinator: ProblemPackageJobCoordinator;
  readonly exportReader: FixedRevisionExportReader;
  readonly adapterCatalog?: ProblemFormatAdapterCatalog;
  /**
   * 题目包原始文件的上限。生产环境默认 128 MiB；测试和内存较小的部署可以调低，
   * 但不能调高。
   */
  readonly maximumArchiveBytes?: number;
  readonly uploadTimeToLiveMs?: number;
  readonly now?: () => Date;
}

export class TransferService {
  readonly #database: DatabaseHandle;
  readonly #service: ProblemService;
  readonly #metadata: ProblemFileStore;
  readonly #storage: FileStorage;
  readonly #audit: ProblemPackageAuditWriter;
  readonly #jobs: ProblemPackageJobStore;
  readonly #coordinator: ProblemPackageJobCoordinator;
  readonly #exportReader: FixedRevisionExportReader;
  readonly #adapterCatalog: ProblemFormatAdapterCatalog;
  public readonly maximumArchiveBytes: number;
  readonly #uploadTimeToLiveMs: number;
  readonly #now: () => Date;

  public constructor(dependencies: TransferServiceDependencies) {
    const archiveLimit =
      dependencies.maximumArchiveBytes ?? maximumProblemPackageArchiveBytes;
    if (
      !Number.isSafeInteger(archiveLimit) ||
      archiveLimit <= 0 ||
      archiveLimit > maximumProblemPackageArchiveBytes
    ) {
      throw new TypeError(
        `题目包上限必须是 1 到 ${maximumProblemPackageArchiveBytes} 之间的整数。`
      );
    }
    this.#database = dependencies.database;
    this.#service = dependencies.service;
    this.#metadata = dependencies.metadata;
    this.#storage = dependencies.storage;
    this.#audit = dependencies.audit;
    this.#jobs = dependencies.jobs;
    this.#coordinator = dependencies.coordinator;
    this.#exportReader = dependencies.exportReader;
    this.#adapterCatalog =
      dependencies.adapterCatalog ?? coreProblemFormatAdapterCatalog;
    this.maximumArchiveBytes = archiveLimit;
    this.#uploadTimeToLiveMs = dependencies.uploadTimeToLiveMs ?? defaultUploadTimeToLiveMs;
    this.#now = dependencies.now ?? (() => new Date());
  }

  /**
   * 上传一个题目包。ZIP 或单个 XML 必须先通过对应的文件安全检查，然后才登记为短期保存的导入
   * 输入文件。返回内容包含各已启用格式的识别建议，最终格式仍由用户确认。
   */
  public async uploadPackage(
    user: StoredUser,
    requestId: string,
    rawOriginalName: string,
    content: AsyncIterable<Uint8Array>
  ): Promise<PackageUploadResponse> {
    this.#requireImportPermission(user);
    const originalName = fileOriginalNameSchema.parse(rawOriginalName);
    const bytes = await collectBytes(content, this.maximumArchiveBytes);
    const packageInput = readPackageInputOrReject(originalName, bytes, {
      maxArchiveBytes: this.maximumArchiveBytes
    });
    const enabledAdapters = await this.#listEnabledAdapters();

    const staged = await this.#storage.stage({
      originalName,
      mediaType: packageInput.mediaType,
      content: singleChunk(bytes)
    });
    let stored: StoredFile;
    try {
      stored = await this.#storage.publish(staged);
    } catch (error) {
      await this.#storage.discard(staged).catch(() => undefined);
      throw error;
    }

    const expiresAt = new Date(this.#now().getTime() + this.#uploadTimeToLiveMs).toISOString();
    try {
      await this.#database.transaction(async (transaction) => {
        await this.#metadata.createStoredFile(
          {
            id: stored.id,
            purpose: "import_input",
            storageKey: stored.storageKey,
            originalName,
            mediaType: packageInput.mediaType,
            byteSize: stored.byteSize,
            sha256: stored.sha256,
            createdByUserId: user.id,
            expiresAt
          },
          transaction
        );
        await this.#audit.append(
          {
            actorUserId: user.id,
            requestId,
            action: "problem.package.upload",
            objectType: "stored_file",
            objectId: stored.id,
            result: "success",
            reasonCode: null,
            metadata: { inputKind: packageInput.kind }
          },
          transaction
        );
      });
    } catch (error) {
      let saved: "complete" | "absent" | "uncertain";
      try {
        saved = await this.#uploadSaveState(stored.id, user.id, requestId);
      } catch {
        throw new ApiError(
          503,
          "UPLOAD_SAVE_UNCONFIRMED",
          "系统暂时无法确认题目包是否保存成功，请稍后重试。"
        );
      }
      if (saved === "complete") {
        // The database committed but its response was lost. Keep the referenced
        // object and return the same successful upload response.
      } else if (saved === "absent") {
        await this.#storage.delete(stored).catch(() => undefined);
        throw translateAuditError(error);
      } else {
        throw new ApiError(
          503,
          "UPLOAD_SAVE_UNCONFIRMED",
          "系统暂时无法确认题目包是否保存成功，请稍后重试。"
        );
      }
    }

    const detected = [] as PackageUploadResponse["detected"];
    for (const adapter of enabledAdapters) {
      try {
        if (inputKindForProblemFormatAdapter(adapter) !== packageInput.kind) {
          continue;
        }
        const result = await adapter.detect(packageInput.archive.summary);
        const parsed = packageDetectionSchema.safeParse({
          formatId: adapter.id,
          displayName: adapter.displayName,
          confidence: result.confidence,
          reason: result.reason
        });
        if (parsed.success && parsed.data.confidence > 0) {
          detected.push(parsed.data);
        }
      } catch {
        // One broken optional format must not hide an otherwise valid upload
        // after the file has already been safely stored.
        continue;
      }
    }
    detected.sort((left, right) => right.confidence - left.confidence);
    detected.splice(20);

    return {
      fileId: stored.id,
      sha256: stored.sha256,
      byteSize: stored.byteSize,
      expiresAt,
      detected
    };
  }

  public async previewImport(
    user: StoredUser,
    requestId: string,
    input: ImportPreviewRequest
  ): Promise<ImportPreviewResponse> {
    this.#requireImportPermission(user);
    const record = await this.#requireOwnImportInput(user, input.fileId);
    const adapter = await this.#requireAdapter(input.formatId);
    const packageInput = await this.#readStoredPackageInput(record);
    this.#requireMatchingInputKind(adapter, packageInput);
    const preview = await adapter.inspect(packageInput.archive);
    const response: ImportPreviewResponse = {
      formatId: adapter.id,
      problemCount: Math.min(preview.problemCount, 1_000),
      ...(preview.title === undefined ? {} : { title: preview.title.slice(0, 200) }),
      files: preview.files.slice(0, 10_000).map((path) => path.slice(0, 500)),
      issues: preview.issues.slice(0, 1_000).map((issue) => ({
        severity: issue.severity,
        ...(issue.path === undefined ? {} : { path: issue.path.slice(0, 500) }),
        message: issue.message.slice(0, 2_000)
      }))
    };
    await this.#appendAudit({
      actorUserId: user.id,
      requestId,
      action: "problem.package.import.preview",
      objectType: "stored_file",
      objectId: record.id,
      result: "success",
      reasonCode: null,
      metadata: {
        formatId: adapter.id,
        formatVersion: adapter.version,
        problemCount: response.problemCount,
        issueCount: response.issues.length
      }
    });
    return response;
  }

  public async createImport(
    user: StoredUser,
    requestId: string,
    input: CreateImportJobRequest
  ): Promise<ImportJobView> {
    this.#requireImportPermission(user);
    const clientRequestDigest = digestImportCreateRequest(input);
    try {
      const replayed = await this.#coordinator.replayImportJob({
        requestedByUserId: user.id,
        idempotencyKey: input.idempotencyKey,
        clientRequestDigest
      });
      if (replayed !== undefined) {
        const items = await this.#jobs.getImportItems(replayed.id);
        return toImportJobView(replayed, items);
      }
    } catch (error) {
      throw translateJobStoreError(error);
    }

    const record = await this.#requireOwnImportInput(user, input.fileId);
    if (record.sha256 !== input.sha256) {
      throw conflict("上传的文件已改变，请重新上传后再试。");
    }
    const adapter = await this.#requireAdapter(input.formatId);
    const packageInput = await this.#readStoredPackageInput(record);
    this.#requireMatchingInputKind(adapter, packageInput);

    try {
      const job = await this.#coordinator.createImportJob({
        requestedByUserId: user.id,
        clientRequestDigest,
        sourceFileId: record.id,
        inputDigest: record.sha256,
        selectedFormat: input.formatId,
        selectedFormatVersion: adapter.version,
        choices: { conflictAction: "create" },
        itemCount: 1,
        idempotencyKey: input.idempotencyKey,
        auditRequestId: requestId
      });
      const items = await this.#jobs.getImportItems(job.id);
      return toImportJobView(job, items);
    } catch (error) {
      throw translateJobStoreError(error);
    }
  }

  public async getImportJob(user: StoredUser, jobId: string): Promise<ImportJobView> {
    const job = await this.#jobs.getImportJob(jobId);
    if (job === undefined || job.requestedByUserId !== user.id) {
      throw notFound();
    }
    const items = await this.#jobs.getImportItems(job.id);
    return toImportJobView(job, items);
  }

  public async previewExport(
    user: StoredUser,
    requestId: string,
    input: ExportPreviewRequest
  ): Promise<ExportPreviewResponse> {
    const adapter = await this.#requireAdapter(input.targetFormat);
    const problems: ExportPreviewResponse["problems"] = [];
    let canExport = true;

    for (const selection of input.problems) {
      const evaluated = await this.#evaluateExportSelection(user, adapter, {
        problemId: selection.problemId,
        includeFileCategories: selection.includeFileCategories
      });
      if (evaluated.status !== "ready") {
        canExport = false;
      }
      problems.push(evaluated.view);
    }

    const response = { targetFormat: adapter.id, canExport, problems };
    await this.#appendAudit({
      actorUserId: user.id,
      requestId,
      action: "problem.package.export.preview",
      objectType: "problem_package",
      objectId: null,
      result: "success",
      reasonCode: null,
      metadata: {
        formatId: adapter.id,
        formatVersion: adapter.version,
        problemCount: input.problems.length,
        canExport
      }
    });
    return response;
  }

  public async createExport(
    user: StoredUser,
    requestId: string,
    input: CreateExportJobRequest
  ): Promise<ExportJobView> {
    const clientRequestDigest = digestExportCreateRequest(input);
    try {
      const replayed = await this.#coordinator.findExportJobForReplay({
        requestedByUserId: user.id,
        idempotencyKey: input.idempotencyKey
      });
      if (replayed !== undefined) {
        await this.#requireReplayExportAccess(user, replayed);
        if (replayed.clientRequestDigest !== clientRequestDigest) {
          throw conflict("同一个请求编号不能用于不同的任务内容。");
        }
        await this.#coordinator.reenqueueExportJob(replayed);
        return this.#toExportJobView(replayed);
      }
    } catch (error) {
      throw translateJobStoreError(error);
    }

    const adapter = await this.#requireAdapter(input.targetFormat);
    const selections: ProblemPackageExportSelection[] = [];
    const summary = { errorCount: 0, choiceCount: 0, warningCount: 0, infoCount: 0 };

    for (const requested of input.problems) {
      const evaluated = await this.#evaluateExportSelection(user, adapter, {
        problemId: requested.problemId,
        includeFileCategories: requested.includeFileCategories
      });
      if (evaluated.status === "not_found") {
        throw notFound();
      }
      if (evaluated.status === "blocked" || evaluated.selection === undefined) {
        throw conflict("仍有阻止导出的项目，请先查看导出预览。");
      }
      if (
        requested.revisionId !== undefined &&
        requested.revisionId !== evaluated.selection.revisionId
      ) {
        throw conflict("题目内容已更新，请重新预览后再导出。");
      }
      for (const item of evaluated.view.items) {
        if (item.severity === "error") summary.errorCount += 1;
        else if (item.severity === "choice") summary.choiceCount += 1;
        else if (item.severity === "warning") summary.warningCount += 1;
        else summary.infoCount += 1;
      }
      selections.push(evaluated.selection);
    }

    try {
      const job = await this.#coordinator.createExportJob({
        requestedByUserId: user.id,
        clientRequestDigest,
        targetFormat: adapter.id,
        targetFormatVersion: adapter.version,
        options: {},
        lossSummary: {
          targetFormat: adapter.id,
          canExport: true,
          errorCount: Math.min(summary.errorCount, 10_000),
          choiceCount: Math.min(summary.choiceCount, 10_000),
          warningCount: Math.min(summary.warningCount, 10_000),
          infoCount: Math.min(summary.infoCount, 10_000)
        },
        problems: selections,
        idempotencyKey: input.idempotencyKey,
        auditRequestId: requestId
      });
      return this.#toExportJobView(job);
    } catch (error) {
      throw translateJobStoreError(error);
    }
  }

  public async getExportJob(user: StoredUser, jobId: string): Promise<ExportJobView> {
    const job = await this.#jobs.getExportJob(jobId);
    if (job === undefined || job.requestedByUserId !== user.id) {
      throw notFound();
    }
    await this.#requireReplayExportAccess(user, job);
    return this.#toExportJobView(job);
  }

  /**
   * 下载导出结果。除任务归属外，这里对任务中的每道题重新执行与创建时相同的权限
   * 检查：任何一项权限被撤销，下载都按“不存在”处理。
   */
  public async downloadExport(
    user: StoredUser,
    requestId: string,
    jobId: string
  ): Promise<{
    readonly fileName: string;
    readonly mediaType: string;
    readonly byteSize: number;
    readonly stream: AsyncIterable<Uint8Array>;
  }> {
    const job = await this.#jobs.getExportJob(jobId);
    if (
      job === undefined ||
      job.requestedByUserId !== user.id ||
      job.state !== "succeeded" ||
      job.resultFileId === null ||
      job.resultExpiresAt === null ||
      Date.parse(job.resultExpiresAt) <= this.#now().getTime()
    ) {
      throw notFound();
    }

    for (const selection of job.problems) {
      const access = await this.#tryProblemAccess(user, selection.problemId);
      if (access === undefined || !access.capabilities.canExport) {
        throw notFound();
      }
      const includesInternal = selection.includedFileCategories.some((category) =>
        internalPackageCategories.has(category)
      );
      if (includesInternal && !access.capabilities.canReadTestdata) {
        throw notFound();
      }
    }

    const record = await this.#metadata.findStoredFile(job.resultFileId);
    if (
      record === undefined ||
      record.purpose !== "export_output" ||
      record.createdByUserId !== user.id ||
      !Number.isSafeInteger(record.byteSize) ||
      record.byteSize < 0 ||
      record.byteSize > maximumProblemPackageArchiveBytes
    ) {
      throw notFound();
    }
    let bytes: Uint8Array;
    try {
      const stream = await this.#storage.open({
        id: record.id,
        storageKey: record.storageKey
      });
      bytes = await collectBytes(stream, maximumProblemPackageArchiveBytes);
    } catch {
      throw notFound();
    }
    if (bytes.byteLength !== record.byteSize || sha256Hex(bytes) !== record.sha256) {
      throw notFound();
    }
    await this.#appendAudit({
      actorUserId: user.id,
      requestId,
      action: "problem.package.export.download",
      objectType: "export_job",
      objectId: job.id,
      result: "success",
      reasonCode: null,
      metadata: {}
    });
    return {
      fileName: record.originalName,
      mediaType: record.mediaType,
      byteSize: record.byteSize,
      stream: singleChunk(bytes)
    };
  }

  async #appendAudit(event: ProblemPackageAuditEvent): Promise<void> {
    try {
      await this.#audit.append(event);
    } catch (error) {
      throw translateAuditError(error);
    }
  }

  async #uploadSaveState(
    fileId: string,
    actorUserId: string,
    requestId: string
  ): Promise<"complete" | "absent" | "uncertain"> {
    const rows = await this.#database.query<{
      has_file: boolean;
      has_audit: boolean;
    }>(sql`
      SELECT
        EXISTS (
          SELECT 1
          FROM stored_files
          WHERE id = ${fileId}::uuid
            AND purpose = 'import_input'
            AND created_by_user_id = ${BigInt(actorUserId)}
            AND deleted_at IS NULL
        ) AS has_file,
        EXISTS (
          SELECT 1
          FROM audit_events
          WHERE request_id = ${requestId}::uuid
            AND actor_user_id = ${BigInt(actorUserId)}
            AND action = 'problem.package.upload'
            AND object_type = 'stored_file'
            AND object_id = ${fileId}
            AND result = 'success'
        ) AS has_audit
    `);
    const state = rows[0];
    if (state?.has_file === true && state.has_audit === true) return "complete";
    if (state?.has_file === false && state.has_audit === false) return "absent";
    return "uncertain";
  }

  async #evaluateExportSelection(
    user: StoredUser,
    adapter: ProblemFormatAdapter,
    request: { problemId: string; includeFileCategories: readonly PackageFileCategory[] }
  ): Promise<{
    status: "ready" | "blocked" | "not_found";
    view: ExportPreviewResponse["problems"][number];
    selection?: ProblemPackageExportSelection;
  }> {
    const access = await this.#tryProblemAccess(user, request.problemId);
    if (access === undefined) {
      return {
        status: "not_found",
        view: { problemId: request.problemId, status: "not_found", items: [] }
      };
    }
    const { problem, capabilities } = access;

    const blockedItems: ExportPreviewResponse["problems"][number]["items"] = [];
    if (!capabilities.canExport) {
      blockedItems.push({
        severity: "error",
        path: "problem",
        message: "你没有导出这道题的权限。"
      });
    }
    const wantsInternal = request.includeFileCategories.some((category) =>
      internalPackageCategories.has(category)
    );
    if (wantsInternal && !capabilities.canReadTestdata) {
      blockedItems.push({
        severity: "error",
        path: "files",
        message: "导出所选的内部资料需要测试数据读取权限。"
      });
    }
    if (blockedItems.length > 0) {
      return {
        status: "blocked",
        view: {
          problemId: request.problemId,
          status: "blocked",
          title: problem.title,
          items: blockedItems
        }
      };
    }

    const revisionId = problem.revisionId;
    if (revisionId === undefined) {
      throw new Error("题目包导出需要数据库存储提供版本编号。");
    }
    const selection: ProblemPackageExportSelection = {
      problemId: problem.id,
      revisionId,
      includedFileCategories: [...request.includeFileCategories]
    };

    const revision = await this.#exportReader.readRevision({
      selection,
      signal: new AbortController().signal
    });
    if (revision === undefined) {
      return {
        status: "not_found",
        view: { problemId: request.problemId, status: "not_found", items: [] }
      };
    }

    const includeSet = new Set(request.includeFileCategories);
    const canonical = canonicalProblemSchema.parse({
      ...revision.document,
      files: revision.files
        .filter((file) => includeSet.has(file.category))
        .map((file) => ({ path: file.path, category: file.category, content: new Uint8Array(0) }))
    });
    const loss = await adapter.validateExport(canonical, {
      includeFileCategories: [...request.includeFileCategories]
    });
    const items = loss.items.slice(0, 200).map((item) => ({
      severity: item.severity,
      path: item.path.slice(0, 500),
      message: item.message.slice(0, 2_000)
    }));

    return {
      status: loss.canExport ? "ready" : "blocked",
      view: {
        problemId: request.problemId,
        status: loss.canExport ? "ready" : "blocked",
        title: problem.title,
        revisionId,
        items
      },
      ...(loss.canExport ? { selection } : {})
    };
  }

  async #tryProblemAccess(
    user: StoredUser,
    problemId: string
  ): Promise<
    | {
        problem: StoredProblem;
        capabilities: { canExport: boolean; canReadTestdata: boolean };
      }
    | undefined
  > {
    try {
      const { problem, capabilities } = await this.#service.getProblemForFileAccess(user, problemId);
      return {
        problem,
        capabilities: {
          canExport: capabilities.canExport,
          canReadTestdata: capabilities.canReadTestdata
        }
      };
    } catch (error) {
      if (
        error instanceof ApiError &&
        (error.statusCode === 403 || error.statusCode === 404)
      ) {
        return undefined;
      }
      throw new ApiError(
        500,
        "PROBLEM_ACCESS_CHECK_FAILED",
        "题目权限检查暂时失败，请稍后重试。"
      );
    }
  }

  async #requireReplayExportAccess(
    user: StoredUser,
    job: ProblemPackageExportJob
  ): Promise<void> {
    for (const selection of job.problems) {
      const access = await this.#tryProblemAccess(user, selection.problemId);
      if (access === undefined || !access.capabilities.canExport) throw notFound();
      const includesInternal = selection.includedFileCategories.some((category) =>
        internalPackageCategories.has(category)
      );
      if (includesInternal && !access.capabilities.canReadTestdata) {
        throw notFound();
      }
    }
  }

  #requireImportPermission(user: StoredUser): void {
    if (!hasPermission(user, "problem.import", {}, this.#now())) {
      throw forbidden("导入题目包需要导入权限。");
    }
  }

  async #requireAdapter(formatId: string): Promise<ProblemFormatAdapter> {
    let adapter: ProblemFormatAdapter | undefined;
    try {
      adapter = await this.#adapterCatalog.getEnabled(formatId);
    } catch {
      throw new ApiError(
        503,
        "FORMAT_REGISTRY_UNAVAILABLE",
        "题目包格式目录暂时不可用，请稍后重试。"
      );
    }
    if (adapter === undefined) {
      throw new ApiError(422, "UNKNOWN_FORMAT", "所选题目包格式当前不可用。");
    }
    if (adapter.id !== formatId) {
      throw new ApiError(
        503,
        "FORMAT_REGISTRY_UNAVAILABLE",
        "题目包格式目录暂时不可用，请稍后重试。"
      );
    }
    return adapter;
  }

  async #listEnabledAdapters(): Promise<readonly ProblemFormatAdapter[]> {
    try {
      return await this.#adapterCatalog.listEnabled();
    } catch {
      throw new ApiError(
        503,
        "FORMAT_REGISTRY_UNAVAILABLE",
        "题目包格式目录暂时不可用，请稍后重试。"
      );
    }
  }

  #requireMatchingInputKind(
    adapter: ProblemFormatAdapter,
    packageInput: SafeProblemPackageInput
  ): void {
    if (inputKindForProblemFormatAdapter(adapter) !== packageInput.kind) {
      throw new ApiError(
        422,
        "FORMAT_INPUT_MISMATCH",
        "所选题目格式不能读取这种文件。"
      );
    }
  }

  async #requireOwnImportInput(user: StoredUser, fileId: string) {
    const record = await this.#metadata.findStoredFile(fileId);
    if (
      record === undefined ||
      record.purpose !== "import_input" ||
      record.createdByUserId !== user.id
    ) {
      throw notFound();
    }
    return record;
  }

  async #readStoredPackageInput(record: {
    readonly id: string;
    readonly storageKey: string;
    readonly originalName: string;
    readonly mediaType: string;
    readonly byteSize: number;
    readonly sha256: string;
  }): Promise<SafeProblemPackageInput> {
    if (
      !Number.isSafeInteger(record.byteSize) ||
      record.byteSize < 0 ||
      record.byteSize > this.maximumArchiveBytes
    ) {
      throw new ApiError(413, "FILE_TOO_LARGE", "题目包超过允许的大小限制。");
    }
    const stream = await this.#storage.open({ id: record.id, storageKey: record.storageKey });
    const bytes = await collectBytes(stream, this.maximumArchiveBytes);
    if (bytes.byteLength !== record.byteSize || sha256Hex(bytes) !== record.sha256) {
      throw notFound();
    }
    const packageInput = readPackageInputOrReject(record.originalName, bytes, {
      maxArchiveBytes: this.maximumArchiveBytes
    });
    if (packageInput.mediaType !== record.mediaType) {
      throw notFound();
    }
    return packageInput;
  }

  #toExportJobView(job: ProblemPackageExportJob): ExportJobView {
    const resultReady =
      job.state === "succeeded" &&
      job.resultFileId !== null &&
      job.resultExpiresAt !== null &&
      Date.parse(job.resultExpiresAt) > this.#now().getTime();
    return {
      id: job.id,
      state: job.state,
      progressPercent: job.progressPercent,
      phase: job.report.phase,
      targetFormat: job.targetFormat,
      problemCount: job.problems.length,
      resultReady,
      resultExpiresAt: job.resultExpiresAt,
      failure: job.failure,
      createdAt: job.createdAt,
      finishedAt: job.finishedAt
    };
  }
}

function toImportJobView(
  job: ProblemPackageImportJob,
  items: readonly ProblemPackageImportItem[]
): ImportJobView {
  return {
    id: job.id,
    state: job.state,
    progressPercent: job.progressPercent,
    phase: job.report.phase,
    completedItems: job.report.completedItems,
    failedItems: job.report.failedItems,
    failure: job.failure,
    items: items.map((item) => ({
      position: item.position,
      state: item.state,
      importedProblemId: item.importedProblemId,
      failure: item.failure
    })),
    createdAt: job.createdAt,
    finishedAt: job.finishedAt
  };
}

function translateJobStoreError(error: unknown): unknown {
  if (error instanceof ProblemPackageJobStoreError) {
    if (error.code === "IDEMPOTENCY_CONFLICT") {
      return conflict("同一个请求编号不能用于不同的任务内容。");
    }
    if (error.code === "INPUT_FILE_NOT_FOUND" || error.code === "FIXED_REVISION_NOT_FOUND") {
      return notFound();
    }
    return new ApiError(500, "TASK_CREATE_FAILED", "任务创建失败，请稍后重试。");
  }
  return translateAuditError(error);
}

function translateAuditError(error: unknown): unknown {
  if (error instanceof ProblemPackageAuditWriteError) {
    return new ApiError(
      503,
      "AUDIT_UNAVAILABLE",
      "系统暂时无法记录这次操作，请稍后重试。"
    );
  }
  return error;
}

function readPackageInputOrReject(
  originalName: string,
  bytes: Uint8Array,
  limits: { readonly maxArchiveBytes: number }
): SafeProblemPackageInput {
  try {
    return readProblemPackageInput({ originalName, content: bytes }, limits);
  } catch (error) {
    if (error instanceof UnsafeArchiveError) {
      const messages = error.issues.slice(0, 3).map((issue) => issue.message);
      throw new ApiError(
        422,
        "UNSAFE_PACKAGE",
        messages.join(" ") || "题目包没有通过文件安全检查。",
        { package: error.issues.slice(0, 20).map((issue) => issue.message) }
      );
    }
    throw error;
  }
}

async function collectBytes(
  stream: AsyncIterable<Uint8Array>,
  maximumBytes: number
): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let total = 0;
  for await (const chunk of stream) {
    total += chunk.byteLength;
    if (total > maximumBytes) {
      throw new ApiError(413, "FILE_TOO_LARGE", "题目包超出允许的大小限制。");
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

async function* singleChunk(bytes: Uint8Array): AsyncGenerator<Uint8Array> {
  yield bytes;
}

/**
 * The digest binds an idempotency key to the normalized public request, not to
 * adapter-derived data. This lets a response-loss retry recover the immutable
 * original task after an adapter is upgraded or disabled.
 */
function digestImportCreateRequest(input: CreateImportJobRequest): string {
  return sha256Text(
    JSON.stringify({
      version: 1,
      kind: "problem-package-import",
      fileId: input.fileId,
      sha256: input.sha256,
      formatId: input.formatId
    })
  );
}

function digestExportCreateRequest(input: CreateExportJobRequest): string {
  return sha256Text(
    JSON.stringify({
      version: 1,
      kind: "problem-package-export",
      targetFormat: input.targetFormat,
      problems: input.problems.map((problem) => ({
        problemId: problem.problemId,
        includeFileCategories: problem.includeFileCategories,
        hasRevisionId: problem.revisionId !== undefined,
        revisionId: problem.revisionId ?? null
      }))
    })
  );
}

function sha256Text(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}
