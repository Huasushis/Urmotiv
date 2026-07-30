import { randomUUID } from "node:crypto";
import {
  ChecksumValidationError,
  ProblemPackageError,
  SafeArchive,
  UnsafeArchiveError,
  canonicalProblemSchema,
  createSafeArchive,
  defaultArchiveSafetyLimits,
  inputKindForProblemFormatAdapter,
  readProblemPackageInput,
  singleFileProblemPackagePath,
  urmotivNativeAdapter,
  type CanonicalFile,
  type CanonicalProblem,
  type GeneratedArchive,
  type GeneratedSingleFileArchive,
  type GeneratedZipArchive,
  type ImportChoices,
  type ProblemFormatAdapter,
  type SafeProblemPackageInput
} from "@urmotiv/problem-package";
import { hydroProblemFormatAdapter } from "@urmotiv/plugin-hydro-format";
import { problemExportJobPayloadSchema, problemImportJobPayloadSchema, type JsonValue } from "./types";
import {
  safeProblemPackageFailure,
  type ProblemPackageExportJob,
  type ProblemPackageExportSelection,
  type ProblemPackageFailureCode,
  type ProblemPackageFileCategory,
  type ProblemPackageImportJob,
  type ProblemPackageImportChoices,
  type ProblemPackageJobReport,
  type ProblemPackageJobStore
} from "./problem-package";
import { PermanentJobError, type JobHandler } from "./worker-types";

export const builtinProblemPackageAdapters: ReadonlyMap<string, ProblemFormatAdapter> = new Map([
  [urmotivNativeAdapter.id, urmotivNativeAdapter],
  [hydroProblemFormatAdapter.id, hydroProblemFormatAdapter]
]);

const maximumInMemoryExportBytes =
  defaultArchiveSafetyLimits.maxTotalUncompressedBytes;

/**
 * The API-side source implementation checks the original file and its digest
 * again. The returned object keeps ZIP and a raw XML file distinct while both
 * expose only a SafeArchive to the selected adapter.
 */
export interface VerifiedImportArchiveReader {
  read(input: {
    readonly sourceFileId: string;
    readonly expectedDigest: string;
    readonly signal: AbortSignal;
  }): Promise<SafeProblemPackageInput | undefined>;
}

/**
 * A writer must use one database transaction per item and use importJobId plus
 * position as its idempotency key. On rejection it must leave no problem,
 * revision, or file relation behind.
 */
export interface AtomicImportedProblemWriter {
  write(input: {
    readonly importJobId: string;
    readonly position: number;
    readonly requestedByUserId: string;
    readonly choices: ProblemPackageImportChoices;
    readonly problem: CanonicalProblem;
    readonly signal: AbortSignal;
  }): Promise<{ readonly problemId: string }>;
}

export interface ProblemPackageImportHandlerDependencies {
  readonly jobs: ProblemPackageJobStore;
  readonly archives: VerifiedImportArchiveReader;
  readonly writer: AtomicImportedProblemWriter;
  readonly adapters?: ReadonlyMap<string, ProblemFormatAdapter>;
}

export interface ExportProblemFileDescriptor {
  readonly path: string;
  readonly category: ProblemPackageFileCategory;
  /** 已保存文件的字节数；用于在读取文件内容前检查一次导出的总量。 */
  readonly byteSize: number;
}

export interface ExportProblemRevision {
  /** The selected revision's text and structured fields, without file bytes. */
  readonly document: Omit<CanonicalProblem, "files">;
  readonly files: readonly ExportProblemFileDescriptor[];
}

export interface FixedRevisionExportReader {
  readRevision(input: {
    readonly selection: ProblemPackageExportSelection;
    readonly signal: AbortSignal;
  }): Promise<ExportProblemRevision | undefined>;
  readFile(input: {
    readonly selection: ProblemPackageExportSelection;
    readonly file: ExportProblemFileDescriptor;
    readonly signal: AbortSignal;
  }): Promise<CanonicalFile | undefined>;
}

/**
 * These checks run immediately before every database/file read. They are a
 * callback rather than cached creation-time state so a revoked grant stops an
 * already queued export task.
 */
export interface ExportReadAuthorization {
  canReadProblem(input: {
    readonly requestedByUserId: string;
    readonly selection: ProblemPackageExportSelection;
    readonly signal: AbortSignal;
  }): Promise<boolean>;
  canReadFile(input: {
    readonly requestedByUserId: string;
    readonly selection: ProblemPackageExportSelection;
    readonly file: ExportProblemFileDescriptor;
    readonly signal: AbortSignal;
  }): Promise<boolean>;
}

export interface ExportArtifactWriter {
  write(input: {
    readonly exportJobId: string;
    readonly requestedByUserId: string;
    readonly targetFormat: string;
    readonly archives: readonly GeneratedArchive[];
    readonly signal: AbortSignal;
  }): Promise<{ readonly fileId: string; readonly expiresAt: string }>;
  discard?(fileId: string): Promise<void>;
}

export interface ProblemPackageExportHandlerDependencies {
  readonly jobs: ProblemPackageJobStore;
  readonly source: FixedRevisionExportReader;
  readonly authorization: ExportReadAuthorization;
  readonly artifacts: ExportArtifactWriter;
  readonly adapters?: ReadonlyMap<string, ProblemFormatAdapter>;
  /**
   * 一次任务所选原文件的总量与已生成文件的总量分别使用这个上限。
   * 生产环境固定不超过 128 MiB；自动化测试可以传入更小的值验证失败路径。
   */
  readonly maxInMemoryBytes?: number;
}

export function createProblemPackageImportHandler(
  dependencies: ProblemPackageImportHandlerDependencies
): JobHandler {
  const adapters = dependencies.adapters ?? builtinProblemPackageAdapters;
  return async (payload, context) => {
    const { importJobId } = problemImportJobPayloadSchema.parse(payload);
    let job: ProblemPackageImportJob | undefined;
    let itemSucceeded = false;

    try {
      job = await dependencies.jobs.startImportJob(importJobId);
      if (job === undefined) {
        throw new PackageTaskError("source_unavailable");
      }
      if (job.state !== "running") {
        if (job.state === "succeeded") {
          return { result: { importedProblemCount: job.report.completedItems, failedProblemCount: 0 } };
        }
        throw new PackageTaskError("cancelled");
      }

      assertActive(context.signal);
      await context.putItemReport({ itemId: "0", state: "running" });
      const packageInput = await dependencies.archives.read({
        sourceFileId: job.sourceFileId,
        expectedDigest: job.inputDigest,
        signal: context.signal
      });
      if (
        packageInput === undefined ||
        !(packageInput.archive instanceof SafeArchive) ||
        (packageInput.kind !== "zip" && packageInput.kind !== "single_file")
      ) {
        throw new PackageTaskError("source_digest_mismatch");
      }

      const adapter = adapters.get(job.selectedFormat);
      if (adapter === undefined) {
        throw new PackageTaskError("format_unavailable");
      }
      if (inputKindForProblemFormatAdapter(adapter) !== packageInput.kind) {
        throw new PackageTaskError("format_unavailable");
      }
      await dependencies.jobs.updateImportJob(importJobId, 30, report("converting", 0, 0));
      assertActive(context.signal);
      const problem = await adapter.import(
        packageInput.archive,
        toAdapterImportChoices(job.choices)
      );
      assertActive(context.signal);

      await dependencies.jobs.updateImportJob(importJobId, 60, report("writing", 0, 0));
      const committed = await dependencies.writer.write({
        importJobId,
        position: 0,
        requestedByUserId: job.requestedByUserId,
        choices: job.choices,
        problem,
        signal: context.signal
      });
      const importedProblemId = requireDatabaseId(committed.problemId);
      itemSucceeded = true;
      await dependencies.jobs.recordImportItem(importJobId, 0, {
        state: "succeeded",
        importedProblemId
      });
      await dependencies.jobs.completeImportJob(importJobId, report("completed", 1, 0));
      await context.updateProgress(100);
      await context.putItemReport({ itemId: "0", state: "succeeded", resultId: importedProblemId });
      return { result: { importedProblemCount: 1, failedProblemCount: 0 } };
    } catch (error) {
      const code = classifyImportFailure(error, context.signal);
      await failImportSafely(dependencies.jobs, importJobId, code, itemSucceeded);
      await putFailureReport(context, "0", code);
      const failure = safeProblemPackageFailure(code);
      throw new PermanentJobError(failure.code, failure.message);
    }
  };
}

export function createProblemPackageExportHandler(
  dependencies: ProblemPackageExportHandlerDependencies
): JobHandler {
  const adapters = dependencies.adapters ?? builtinProblemPackageAdapters;
  const maxInMemoryBytes =
    dependencies.maxInMemoryBytes ?? maximumInMemoryExportBytes;
  if (
    !Number.isSafeInteger(maxInMemoryBytes) ||
    maxInMemoryBytes <= 0 ||
    maxInMemoryBytes > maximumInMemoryExportBytes
  ) {
    throw new TypeError(
      `一次导出的内容上限必须是 1 到 ${maximumInMemoryExportBytes} 之间的整数。`
    );
  }
  return async (payload, context) => {
    const { exportJobId } = problemExportJobPayloadSchema.parse(payload);
    let job: ProblemPackageExportJob | undefined;
    let artifactFileId: string | undefined;

    try {
      job = await dependencies.jobs.startExportJob(exportJobId);
      if (job === undefined) {
        throw new PackageTaskError("export_source_missing");
      }
      if (job.state !== "running") {
        if (job.state === "succeeded" && job.resultFileId !== null) {
          return { result: { resultFileId: job.resultFileId } };
        }
        throw new PackageTaskError("cancelled");
      }

      const adapter = adapters.get(job.targetFormat);
      if (adapter === undefined) {
        throw new PackageTaskError("format_unavailable");
      }

      await precheckSelectedExportFiles(
        dependencies,
        job,
        maxInMemoryBytes,
        context.signal
      );

      const generated: GeneratedArchive[] = [];
      let generatedBytes = 0;
      for (const [position, selection] of job.problems.entries()) {
        assertActive(context.signal);
        await context.putItemReport({ itemId: String(position), state: "running" });
        const allowedProblem = await dependencies.authorization.canReadProblem({
          requestedByUserId: job.requestedByUserId,
          selection,
          signal: context.signal
        });
        if (!allowedProblem) {
          throw new PackageTaskError("export_access_revoked");
        }

        const revision = await dependencies.source.readRevision({ selection, signal: context.signal });
        if (revision === undefined) {
          throw new PackageTaskError("export_source_missing");
        }
        await dependencies.jobs.updateExportJob(
          exportJobId,
          Math.max(5, Math.floor((position * 70) / job.problems.length)),
          report("reading", position, 0)
        );

        const selected = new Set(selection.includedFileCategories);
        const files: CanonicalFile[] = [];
        for (const descriptor of revision.files) {
          if (!selected.has(descriptor.category)) continue;
          assertActive(context.signal);
          const allowedFile = await dependencies.authorization.canReadFile({
            requestedByUserId: job.requestedByUserId,
            selection,
            file: descriptor,
            signal: context.signal
          });
          if (!allowedFile) {
            throw new PackageTaskError("export_access_revoked");
          }
          const file = await dependencies.source.readFile({
            selection,
            file: descriptor,
            signal: context.signal
          });
          if (
            file === undefined ||
            file.path !== descriptor.path ||
            file.category !== descriptor.category ||
            file.content.byteLength !== descriptor.byteSize
          ) {
            throw new PackageTaskError("export_file_missing");
          }
          files.push(file);
        }

        const canonical = canonicalProblemSchema.parse({ ...revision.document, files });
        const options = exportOptionsForSelection(job, selection);
        await dependencies.jobs.updateExportJob(
          exportJobId,
          Math.max(10, Math.floor(((position + 1) * 70) / job.problems.length)),
          report("converting", position, 0)
        );
        const loss = await adapter.validateExport(canonical, options);
        if (!loss.canExport) {
          throw new PackageTaskError("export_not_confirmed");
        }
        assertActive(context.signal);
        const archive = await adapter.export(canonical, options);
        generatedBytes = countGeneratedArchiveBytes(
          archive,
          generatedBytes,
          maxInMemoryBytes
        );
        generated.push(validateGeneratedArchive(archive));
        await context.putItemReport({ itemId: String(position), state: "succeeded" });
      }

      assertActive(context.signal);
      await dependencies.jobs.updateExportJob(
        exportJobId,
        85,
        report("writing", job.problems.length, 0)
      );
      const written = await dependencies.artifacts.write({
        exportJobId,
        requestedByUserId: job.requestedByUserId,
        targetFormat: job.targetFormat,
        archives: generated,
        signal: context.signal
      });
      artifactFileId = requireUuid(written.fileId);
      await dependencies.jobs.completeExportJob(exportJobId, {
        resultFileId: artifactFileId,
        resultExpiresAt: validDateTime(written.expiresAt),
        outputFileCount: generated.reduce(
          (sum, archive) =>
            sum +
            (requireGeneratedArchiveKind(archive) === "zip"
              ? (archive as GeneratedZipArchive).files.length
              : 1),
          0
        )
      });
      await context.updateProgress(100);
      return { result: { resultFileId: artifactFileId } };
    } catch (error) {
      const code = classifyExportFailure(error, context.signal);
      if (artifactFileId !== undefined) {
        await dependencies.artifacts.discard?.(artifactFileId).catch(() => undefined);
      }
      await failExportSafely(dependencies.jobs, exportJobId, code);
      const failure = safeProblemPackageFailure(code);
      throw new PermanentJobError(failure.code, failure.message);
    }
  };
}

async function precheckSelectedExportFiles(
  dependencies: Pick<
    ProblemPackageExportHandlerDependencies,
    "source" | "authorization"
  >,
  job: ProblemPackageExportJob,
  maximumBytes: number,
  signal: AbortSignal
): Promise<void> {
  let selectedBytes = 0;
  let exceedsLimit = false;
  let invalidSize = false;

  for (const selection of job.problems) {
    assertActive(signal);
    const allowedProblem = await dependencies.authorization.canReadProblem({
      requestedByUserId: job.requestedByUserId,
      selection,
      signal
    });
    if (!allowedProblem) {
      throw new PackageTaskError("export_access_revoked");
    }

    const revision = await dependencies.source.readRevision({ selection, signal });
    if (revision === undefined) {
      throw new PackageTaskError("export_source_missing");
    }

    const selected = new Set(selection.includedFileCategories);
    for (const descriptor of revision.files) {
      if (!selected.has(descriptor.category)) continue;
      assertActive(signal);
      const allowedFile = await dependencies.authorization.canReadFile({
        requestedByUserId: job.requestedByUserId,
        selection,
        file: descriptor,
        signal
      });
      if (!allowedFile) {
        throw new PackageTaskError("export_access_revoked");
      }

      if (!Number.isSafeInteger(descriptor.byteSize) || descriptor.byteSize < 0) {
        invalidSize = true;
        continue;
      }
      if (exceedsLimit || descriptor.byteSize > maximumBytes - selectedBytes) {
        exceedsLimit = true;
        continue;
      }
      selectedBytes += descriptor.byteSize;
    }
  }

  if (invalidSize) {
    throw new PackageTaskError("export_source_missing");
  }
  if (exceedsLimit) {
    throw new PackageTaskError("export_too_large");
  }
}

function countGeneratedArchiveBytes(
  archive: GeneratedArchive,
  currentBytes: number,
  maximumBytes: number
): number {
  let total = currentBytes;
  const kind = requireGeneratedArchiveKind(archive);
  if (kind === "single_file") {
    const content = (archive as GeneratedSingleFileArchive).content;
    if (content.byteLength > maximumBytes - total) {
      throw new PackageTaskError("export_too_large");
    }
    return total + content.byteLength;
  }
  for (const file of (archive as GeneratedZipArchive).files) {
    if (file.content.byteLength > maximumBytes - total) {
      throw new PackageTaskError("export_too_large");
    }
    total += file.content.byteLength;
  }
  return total;
}

/** Registers both fixed payload handlers on the worker before its registry locks. */
export function registerProblemPackageHandlers(
  worker: { register(type: string, handler: JobHandler): void },
  dependencies: {
    readonly import: ProblemPackageImportHandlerDependencies;
    readonly export: ProblemPackageExportHandlerDependencies;
  }
): void {
  worker.register("problem.import", createProblemPackageImportHandler(dependencies.import));
  worker.register("problem.export", createProblemPackageExportHandler(dependencies.export));
}

/** In-memory, byte-preserving source for isolated worker tests. */
export class InMemoryVerifiedImportArchiveReader implements VerifiedImportArchiveReader {
  readonly #archives = new Map<
    string,
    { readonly digest: string; readonly packageInput: SafeProblemPackageInput }
  >();

  public put(
    sourceFileId: string,
    digest: string,
    packageInput: SafeProblemPackageInput
  ): void {
    this.#archives.set(requireUuid(sourceFileId), {
      digest: requireSha256(digest),
      packageInput
    });
  }

  public async read(input: {
    readonly sourceFileId: string;
    readonly expectedDigest: string;
    readonly signal: AbortSignal;
  }): Promise<SafeProblemPackageInput | undefined> {
    assertActive(input.signal);
    const stored = this.#archives.get(requireUuid(input.sourceFileId));
    if (stored === undefined || stored.digest !== requireSha256(input.expectedDigest)) return undefined;
    return stored.packageInput;
  }
}

/** In-memory fixed-revision reader. It copies byte arrays before returning them. */
export class InMemoryFixedRevisionExportReader implements FixedRevisionExportReader {
  readonly #revisions = new Map<string, { readonly revision: ExportProblemRevision; readonly files: Map<string, CanonicalFile> }>();

  public put(selection: ProblemPackageExportSelection, problem: CanonicalProblem): void {
    const parsed = canonicalProblemSchema.parse(problem);
    const key = revisionKey(selection);
    this.#revisions.set(key, {
      revision: {
        document: copyDocument(parsed),
        files: parsed.files.map((file) => ({
          path: file.path,
          category: file.category,
          byteSize: file.content.byteLength
        }))
      },
      files: new Map(parsed.files.map((file) => [file.path, copyFile(file)]))
    });
  }

  public async readRevision(input: {
    readonly selection: ProblemPackageExportSelection;
    readonly signal: AbortSignal;
  }): Promise<ExportProblemRevision | undefined> {
    assertActive(input.signal);
    const stored = this.#revisions.get(revisionKey(input.selection));
    return stored === undefined ? undefined : structuredClone(stored.revision);
  }

  public async readFile(input: {
    readonly selection: ProblemPackageExportSelection;
    readonly file: ExportProblemFileDescriptor;
    readonly signal: AbortSignal;
  }): Promise<CanonicalFile | undefined> {
    assertActive(input.signal);
    const stored = this.#revisions.get(revisionKey(input.selection));
    const file = stored?.files.get(input.file.path);
    return file === undefined ? undefined : copyFile(file);
  }
}

/**
 * Keeps generated archive bytes in memory for tests. Production code injects a
 * private object-storage writer that returns only a stored file ID and expiry.
 */
export class InMemoryExportArtifactWriter implements ExportArtifactWriter {
  readonly #artifacts = new Map<string, {
    readonly requestedByUserId: string;
    readonly targetFormat: string;
    readonly archives: readonly GeneratedArchive[];
    readonly expiresAt: string;
  }>();

  public constructor(private readonly expiresInMs = 60_000, private readonly now: () => Date = () => new Date()) {}

  public async write(input: {
    readonly exportJobId: string;
    readonly requestedByUserId: string;
    readonly targetFormat: string;
    readonly archives: readonly GeneratedArchive[];
    readonly signal: AbortSignal;
  }): Promise<{ readonly fileId: string; readonly expiresAt: string }> {
    assertActive(input.signal);
    if (!Number.isInteger(this.expiresInMs) || this.expiresInMs <= 0) {
      throw new Error("导出文件保留时间必须是正整数。");
    }
    const fileId = randomUUID();
    const expiresAt = new Date(this.now().getTime() + this.expiresInMs).toISOString();
    this.#artifacts.set(fileId, {
      requestedByUserId: input.requestedByUserId,
      targetFormat: input.targetFormat,
      archives: input.archives.map(copyArchive),
      expiresAt
    });
    return { fileId, expiresAt };
  }

  public async discard(fileId: string): Promise<void> {
    this.#artifacts.delete(requireUuid(fileId));
  }

  public get(fileId: string): { readonly archives: readonly GeneratedArchive[]; readonly expiresAt: string } | undefined {
    const artifact = this.#artifacts.get(requireUuid(fileId));
    return artifact === undefined
      ? undefined
      : { archives: artifact.archives.map(copyArchive), expiresAt: artifact.expiresAt };
  }
}

class PackageTaskError extends Error {
  public constructor(public readonly code: ProblemPackageFailureCode) {
    super(code);
    this.name = "PackageTaskError";
  }
}

function report(
  phase: ProblemPackageJobReport["phase"],
  completedItems: number,
  failedItems: number
): ProblemPackageJobReport {
  return { version: 1, phase, completedItems, failedItems, skippedItems: 0 };
}

function exportOptionsForSelection(
  job: ProblemPackageExportJob,
  selection: ProblemPackageExportSelection
): { readonly includeFileCategories: readonly ProblemPackageFileCategory[]; readonly values?: Record<string, JsonValue> } {
  const { includeFileCategories: _ignored, values, ...other } = job.options;
  return {
    includeFileCategories: selection.includedFileCategories,
    ...(Object.keys(other).length === 0 && values === undefined ? {} : { values: { ...other, ...(isJsonObject(values) ? values : {}) } })
  };
}

function toAdapterImportChoices(choices: ProblemPackageImportChoices): ImportChoices {
  return {
    conflictAction: choices.conflictAction,
    ...(choices.targetProblemId === undefined ? {} : { targetProblemId: choices.targetProblemId }),
    ...(choices.values === undefined ? {} : { values: choices.values })
  };
}

function validateGeneratedArchive(archive: GeneratedArchive): GeneratedArchive {
  const kind = requireGeneratedArchiveKind(archive);
  if (kind === "single_file") {
    const singleFile = archive as GeneratedSingleFileArchive;
    const checked = readProblemPackageInput({
      originalName: singleFile.fileName,
      content: singleFile.content
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
    return {
      kind: "single_file",
      mediaType: singleFile.mediaType,
      fileName: singleFile.fileName,
      content
    };
  }
  const zip = archive as GeneratedZipArchive;
  const safe = createSafeArchive(
    zip.files.map((file) => ({
      path: file.path,
      kind: "file" as const,
      compressedSize: file.content.byteLength,
      uncompressedSize: file.content.byteLength,
      content: file.content
    }))
  );
  return {
    kind: "zip",
    mediaType: zip.mediaType,
    fileName: zip.fileName,
    files: safe.list().map((file) => ({ path: file.path, content: new Uint8Array(file.content) }))
  };
}

function requireGeneratedArchiveKind(
  archive: GeneratedArchive
): "zip" | "single_file" {
  const legacyCandidate = archive as unknown as {
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
    // Problem-format plugin API v1 returned only files. Keep those already
    // installed ZIP adapters working while new raw-file adapters must opt in.
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

async function failImportSafely(
  jobs: ProblemPackageJobStore,
  jobId: string,
  code: ProblemPackageFailureCode,
  itemSucceeded: boolean
): Promise<void> {
  try {
    if (!itemSucceeded) {
      await jobs.recordImportItem(jobId, 0, { state: "failed", failureCode: code });
    }
    await jobs.failImportJob(jobId, code, report("failed", itemSucceeded ? 1 : 0, itemSucceeded ? 0 : 1));
  } catch {
    // The generic worker failure still has a stable error code; never expose a storage error here.
  }
}

async function failExportSafely(
  jobs: ProblemPackageJobStore,
  jobId: string,
  code: ProblemPackageFailureCode
): Promise<void> {
  try {
    await jobs.failExportJob(jobId, code);
  } catch {
    // See failImportSafely: task logs must not gain database error text.
  }
}

async function putFailureReport(
  context: Parameters<JobHandler>[1],
  itemId: string,
  code: ProblemPackageFailureCode
): Promise<void> {
  try {
    await context.putItemReport({ itemId, state: "failed", code });
  } catch {
    // Lease loss is handled by JobWorker; do not replace it with a raw error.
  }
}

function classifyImportFailure(error: unknown, signal: AbortSignal): ProblemPackageFailureCode {
  if (signal.aborted) return "cancelled";
  if (error instanceof PackageTaskError) return error.code;
  if (error instanceof UnsafeArchiveError) return "archive_rejected";
  if (error instanceof ChecksumValidationError || error instanceof ProblemPackageError) return "import_invalid";
  return "import_write_failed";
}

function classifyExportFailure(error: unknown, signal: AbortSignal): ProblemPackageFailureCode {
  if (signal.aborted) return "cancelled";
  if (error instanceof PackageTaskError) return error.code;
  if (error instanceof UnsafeArchiveError) {
    return error.issues.some(
      (issue) => issue.code === "archive_too_large" || issue.code === "file_too_large"
    )
      ? "export_too_large"
      : "export_not_confirmed";
  }
  if (error instanceof ProblemPackageError) return "export_not_confirmed";
  return "export_write_failed";
}

function assertActive(signal: AbortSignal): void {
  if (signal.aborted) throw new PackageTaskError("cancelled");
}

function requireUuid(value: string): string {
  if (!zodUuid.test(value)) throw new PackageTaskError("internal_failure");
  return value;
}

function requireSha256(value: string): string {
  if (!/^[a-f0-9]{64}$/.test(value)) throw new PackageTaskError("source_digest_mismatch");
  return value;
}

function requireDatabaseId(value: string): string {
  if (!/^(0|[1-9]\d*)$/.test(value)) throw new PackageTaskError("import_write_failed");
  return value;
}

function validDateTime(value: string): string {
  const time = Date.parse(value);
  if (!Number.isFinite(time)) throw new PackageTaskError("export_write_failed");
  return new Date(time).toISOString();
}

const zodUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function revisionKey(selection: ProblemPackageExportSelection): string {
  return `${selection.problemId}\u0000${selection.revisionId}`;
}

function copyFile(file: CanonicalFile): CanonicalFile {
  return { path: file.path, category: file.category, content: new Uint8Array(file.content) };
}

function copyDocument(problem: CanonicalProblem): Omit<CanonicalProblem, "files"> {
  const { files: _files, ...document } = problem;
  return structuredClone(document);
}

function copyArchive(archive: GeneratedArchive): GeneratedArchive {
  if (requireGeneratedArchiveKind(archive) === "single_file") {
    const singleFile = archive as GeneratedSingleFileArchive;
    return {
      kind: "single_file",
      mediaType: singleFile.mediaType,
      fileName: singleFile.fileName,
      content: new Uint8Array(singleFile.content)
    };
  }
  const zip = archive as GeneratedZipArchive;
  return {
    kind: "zip",
    mediaType: zip.mediaType,
    fileName: zip.fileName,
    files: zip.files.map((file) => ({
      path: file.path,
      content: new Uint8Array(file.content)
    }))
  };
}

function isJsonObject(value: unknown): value is Record<string, JsonValue> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
