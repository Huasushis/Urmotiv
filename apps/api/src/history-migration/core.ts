import { randomUUID } from "node:crypto";
import { lstat, mkdir, rename, rm, rmdir } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import type { CanonicalProblem } from "@urmotiv/problem-package";
import { urmotivNativeAdapter, writeZipArchive } from "@urmotiv/problem-package";
import { z } from "zod";
import { candidateContentDigest, sha256Hex, sourceMappingDigest } from "./digests";
import {
  HistoryMigrationError,
  HistoryNormalizationError,
  historyNormalizationFailureKinds,
  type HistoryNormalizationFailureKind,
} from "./errors";
import {
  assertPathsInsidePrivateRoot,
  assertPrivateDirectoryMode,
  assertPrivateFileMode,
  assertNewOutputPath,
  createNewPrivateDirectory,
  readConfirmedSource,
  readPrivateJson,
  readPrivateJsonWithDigest,
  movePrivateFileNoReplace,
  writeNewPrivateFile,
  writeNewPrivateJson,
} from "./private-files";
import {
  historyCandidateApprovalSchema,
  historyCandidateProblemSchema,
  historyCandidateRecordSchema,
  historyMetadataFileSchema,
  historySourceMappingSchema,
  normalizedHistoryOutputSchema,
  type HistoryCandidateRecord,
  type HistoryMetadataRecord,
  type HistorySourceMapping,
  type NormalizedHistoryOutput,
  type NormalizedHistoryProblem,
} from "./schema";

const digestSchema = z.string().regex(/^[0-9a-f]{64}$/);

const historyPreparationExecutionIdentitySchema = z
  .object({
    version: z.literal(1),
    codeSha256: digestSchema,
    promptSha256: digestSchema,
    modelSha256: digestSchema,
    configSha256: digestSchema,
  })
  .strict();

const preparationRunSchema = z
  .object({
    version: z.literal(2),
    phase: z.literal("prepare"),
    operationTagSha256: digestSchema,
    inputBatchSha256: digestSchema,
    sourceCount: z.number().int().positive(),
    executionIdentity: historyPreparationExecutionIdentitySchema,
  })
  .strict();

const preparationActiveSchema = z
  .object({
    version: z.literal(1),
    status: z.literal("active"),
    sourceId: z.string().regex(/^source-[0-9]{6}$/),
    sourceIdentitySha256: digestSchema,
    executionIdentitySha256: digestSchema,
    operationSha256: digestSchema,
  })
  .strict();

const preparationCompletedSchema = z
  .object({
    version: z.literal(1),
    status: z.literal("completed"),
    sourceId: z.string().regex(/^source-[0-9]{6}$/),
    activeSha256: digestSchema,
    requestAttemptSha256s: z.array(digestSchema).min(1).max(10),
    candidates: z
      .array(
        z
          .object({
            candidateId: z.string().regex(/^candidate-[0-9]{6}$/),
            contentSha256: digestSchema,
          })
          .strict(),
      )
      .min(1)
      .max(30),
  })
  .strict();

const preparationFailureSchema = z
  .object({
    version: z.literal(1),
    status: z.literal("failed"),
    sourceId: z.string().regex(/^source-[0-9]{6}$/),
    activeSha256: digestSchema.nullable(),
    requestAttemptSha256s: z.array(digestSchema).max(10),
    failureKind: z.enum(historyNormalizationFailureKinds),
  })
  .strict();

const preparationCompleteSchema = z
  .object({
    version: z.literal(2),
    phase: z.literal("prepare"),
    batchSha256: z.string().regex(/^[0-9a-f]{64}$/),
    candidateCount: z.number().int().nonnegative(),
    sourceCount: z.number().int().positive(),
    runSha256: digestSchema,
  })
  .strict();

export interface HistoryNormalizerInput {
  readonly sourceId: string;
  readonly text: string;
  /** 传输层每次真正发请求前调用并等待，用于同步登记唯一请求身份。 */
  readonly beforeRequest?: (attempt: number) => Promise<void>;
}

export interface HistoryNormalizer {
  normalize(input: HistoryNormalizerInput): Promise<NormalizedHistoryOutput>;
}

export interface HistoryPreparationExecutionIdentity {
  readonly version: 1;
  readonly codeSha256: string;
  readonly promptSha256: string;
  readonly modelSha256: string;
  readonly configSha256: string;
}

export interface PrepareHistoryCandidatesOptions {
  readonly privateRootDirectory: string;
  readonly sourceDirectory: string;
  readonly metadataFile: string;
  readonly sourceConfirmationFile: string;
  readonly outputDirectory: string;
  readonly normalizer: HistoryNormalizer;
  /** 每次新运行必须使用新的非空标签；检查点只保存其摘要。 */
  readonly operationTag: string;
  readonly executionIdentity: HistoryPreparationExecutionIdentity;
  /** 只允许在同一输出目录、同一标签和同一执行身份下续跑。 */
  readonly resume?: boolean;
}

export interface PackageApprovedCandidatesOptions {
  readonly privateRootDirectory: string;
  readonly sourceDirectory: string;
  readonly metadataFile: string;
  readonly sourceConfirmationFile: string;
  readonly preparedDirectory: string;
  readonly approvalFile: string;
  readonly outputDirectory: string;
  readonly authorMappingOutput: string;
  readonly exportedAt?: string;
}

export interface PrepareHistoryCandidatesResult {
  readonly sourceCount: number;
  readonly candidateCount: number;
  readonly completedSourceCount: number;
  readonly failedSourceCount: number;
  readonly uncertainSourceCount: number;
  readonly pendingSourceCount: number;
  readonly complete: boolean;
}

export interface PackageApprovedCandidatesResult {
  readonly packageCount: number;
  readonly authorMappingCount: number;
}

interface ConfirmedSource {
  readonly sourceId: string;
  readonly mapping: HistorySourceMapping["mappings"][number];
  readonly sourceMappingSha256: string;
  readonly metadata: HistoryMetadataRecord;
}

interface ApprovedCandidate {
  readonly record: HistoryCandidateRecord;
  readonly metadata: HistoryMetadataRecord;
}

export async function prepareHistoryCandidates(
  options: PrepareHistoryCandidatesOptions,
): Promise<PrepareHistoryCandidatesResult> {
  const operationTag = options.operationTag.trim();
  if (operationTag.length === 0 || operationTag.length > 200) {
    throw new HistoryMigrationError(
      "INVALID_ARGUMENTS",
      "prepare 必须提供本次运行唯一且长度合规的操作标签。",
    );
  }
  const parsedExecutionIdentity = historyPreparationExecutionIdentitySchema.safeParse(
    options.executionIdentity,
  );
  if (!parsedExecutionIdentity.success) {
    throw new HistoryMigrationError(
      "INVALID_ARGUMENTS",
      "prepare 的代码、提示词、模型或配置身份不完整。",
    );
  }
  const executionIdentity = parsedExecutionIdentity.data;
  await assertPathsInsidePrivateRoot(options.privateRootDirectory, [
    { path: options.sourceDirectory, kind: "existing" },
    { path: options.metadataFile, kind: "existing" },
    { path: options.sourceConfirmationFile, kind: "existing" },
    { path: options.outputDirectory, kind: options.resume === true ? "existing" : "new" },
  ]);
  const { confirmedSources } = await loadConfirmedInputs(
    options.metadataFile,
    options.sourceConfirmationFile,
  );
  const operationTagSha256 = sha256Hex(operationTag);
  const inputBatchSha256 = sha256Hex(
    JSON.stringify(
      confirmedSources.map((source) => ({
        sourceId: source.sourceId,
        sourceContentSha256: source.mapping.sourceSha256,
        sourceMappingSha256: source.sourceMappingSha256,
      })),
    ),
  );
  const run = preparationRunSchema.parse({
    version: 2,
    phase: "prepare",
    operationTagSha256,
    inputBatchSha256,
    sourceCount: confirmedSources.length,
    executionIdentity,
  });
  const runSha256 = sha256Hex(JSON.stringify(run));

  if (options.resume === true) {
    let savedRun: z.infer<typeof preparationRunSchema>;
    try {
      await assertPrivateDirectoryMode(options.outputDirectory);
      await assertPrivateFileMode(join(options.outputDirectory, "run.json"));
      savedRun = preparationRunSchema.parse(
        await readPrivateJson(join(options.outputDirectory, "run.json")),
      );
    } catch {
      throw new HistoryMigrationError(
        "PREPARE_RESUME_UNSAFE",
        "旧 prepare 输出没有可验证检查点；必须使用新的输出目录和新的运行标签。",
      );
    }
    if (sha256Hex(JSON.stringify(savedRun)) !== runSha256) {
      throw new HistoryMigrationError(
        "PREPARE_RESUME_UNSAFE",
        "prepare 的输入、运行标签、代码、提示词、模型或配置身份已经变化，不能续跑。",
      );
    }
    try {
      await assertPathsInsidePrivateRoot(options.privateRootDirectory, [
        { path: join(options.outputDirectory, "candidates"), kind: "existing" },
        { path: join(options.outputDirectory, "requests"), kind: "existing" },
        { path: join(options.outputDirectory, "reports"), kind: "existing" },
      ]);
      await Promise.all(
        ["candidates", "requests", "reports"].map((name) =>
          assertPrivateDirectoryMode(join(options.outputDirectory, name)),
        ),
      );
    } catch {
      throw new HistoryMigrationError(
        "PREPARE_RESUME_UNSAFE",
        "prepare 检查点目录不完整或不安全，不能继续。",
      );
    }
  } else {
    await createNewPrivateDirectory(options.outputDirectory);
    await createNewPrivateDirectory(join(options.outputDirectory, "candidates"));
    await createNewPrivateDirectory(join(options.outputDirectory, "requests"));
    await createNewPrivateDirectory(join(options.outputDirectory, "reports"));
    await writeNewPrivateJson(join(options.outputDirectory, "run.json"), run);
    await writeNewPrivateJson(join(options.outputDirectory, "PREPARE_INCOMPLETE"), {
      version: 1,
      phase: "prepare",
      status: "incomplete",
      runSha256,
    });
  }

  const executionIdentitySha256 = sha256Hex(JSON.stringify(executionIdentity));
  for (const [sourceIndex, source] of confirmedSources.entries()) {
    const existingState = await loadPreparationSourceState(
      options.privateRootDirectory,
      options.outputDirectory,
      source.sourceId,
    );
    if (existingState !== "pending") continue;

    let sourceContent: Awaited<ReturnType<typeof readConfirmedSource>>;
    try {
      sourceContent = await readConfirmedSource(
        options.sourceDirectory,
        source.mapping.sourcePath,
        source.mapping.sourceSha256,
        source.sourceId,
      );
    } catch {
      await writePreparationFailure(
        options.privateRootDirectory,
        options.outputDirectory,
        source.sourceId,
        null,
        [],
        "source_validation",
      );
      continue;
    }

    const sourceIdentitySha256 = sha256Hex(
      JSON.stringify({
        sourceId: source.sourceId,
        sourceContentSha256: sourceContent.sha256,
        sourceMappingSha256: source.sourceMappingSha256,
      }),
    );
    const active = preparationActiveSchema.parse({
      version: 1,
      status: "active",
      sourceId: source.sourceId,
      sourceIdentitySha256,
      executionIdentitySha256,
      operationSha256: sha256Hex(
        JSON.stringify({ operationTagSha256, sourceId: source.sourceId, attempt: 1 }),
      ),
    });
    await assertPathsInsidePrivateRoot(options.privateRootDirectory, [
      { path: join(options.outputDirectory, "requests"), kind: "existing" },
      { path: join(options.outputDirectory, "candidates"), kind: "existing" },
    ]);
    await writeNewPrivateJson(
      preparationStatePath(options.outputDirectory, source.sourceId, "active"),
      active,
    );
    const activeSha256 = sha256Hex(JSON.stringify(active));
    const requestAttemptSha256s = [activeSha256];

    try {
      const normalized = normalizedHistoryOutputSchema.parse(
        await options.normalizer.normalize({
          sourceId: source.sourceId,
          text: sourceContent.text,
          beforeRequest: async (attempt) => {
            if (attempt === 1) return;
            const retryActive = preparationActiveSchema.parse({
              ...active,
              operationSha256: sha256Hex(
                JSON.stringify({ operationTagSha256, sourceId: source.sourceId, attempt }),
              ),
            });
            await assertPathsInsidePrivateRoot(options.privateRootDirectory, [
              { path: join(options.outputDirectory, "requests"), kind: "existing" },
            ]);
            await writeNewPrivateJson(
              join(
                options.outputDirectory,
                "requests",
                `${source.sourceId}.attempt-${String(attempt).padStart(2, "0")}.active.json`,
              ),
              retryActive,
            );
            requestAttemptSha256s.push(sha256Hex(JSON.stringify(retryActive)));
          },
        }),
      );
      const candidates: Array<{
        readonly candidateId: string;
        readonly contentSha256: string;
      }> = [];
      for (const [problemIndex, normalizedProblem] of normalized.problems.entries()) {
        const candidateId = makeSafeId("candidate", sourceIndex * 30 + problemIndex + 1);
        const problem = toCandidateProblem(normalizedProblem);
        assertPrivateIdentifiersNotPresent(
          { problem, normalizationNote: normalizedProblem.migrationNote },
          source.metadata.authorStudentId,
          source.mapping.sourcePath,
        );
        const contentSha256 = candidateContentDigest({
          sourceId: source.sourceId,
          sourceContentSha256: sourceContent.sha256,
          sourceMappingSha256: source.sourceMappingSha256,
          modelConfidence: normalizedProblem.confidence,
          normalizationNote: normalizedProblem.migrationNote,
          problem,
        });
        const candidate = historyCandidateRecordSchema.parse({
          version: 1,
          candidateId,
          sourceId: source.sourceId,
          sourceContentSha256: sourceContent.sha256,
          sourceMappingSha256: source.sourceMappingSha256,
          contentSha256,
          modelConfidence: normalizedProblem.confidence,
          normalizationNote: normalizedProblem.migrationNote,
          problem,
        });
        await assertPathsInsidePrivateRoot(options.privateRootDirectory, [
          { path: join(options.outputDirectory, "candidates"), kind: "existing" },
        ]);
        await writeNewPrivateJson(
          join(options.outputDirectory, "candidates", `${candidateId}.json`),
          candidate,
        );
        candidates.push({ candidateId, contentSha256 });
      }
      await assertPathsInsidePrivateRoot(options.privateRootDirectory, [
        { path: join(options.outputDirectory, "requests"), kind: "existing" },
      ]);
      await writeNewPrivateJson(
        preparationStatePath(options.outputDirectory, source.sourceId, "completed"),
        preparationCompletedSchema.parse({
          version: 1,
          status: "completed",
          sourceId: source.sourceId,
          activeSha256,
          requestAttemptSha256s,
          candidates,
        }),
      );
    } catch (error) {
      await writePreparationFailure(
        options.privateRootDirectory,
        options.outputDirectory,
        source.sourceId,
        activeSha256,
        requestAttemptSha256s,
        classifyPreparationFailure(error),
      );
      if (error instanceof HistoryNormalizationError && error.failureKind === "cancelled") {
        break;
      }
    }
  }

  const summary = await summarizePreparation(
    options.privateRootDirectory,
    options.outputDirectory,
    confirmedSources,
  );
  await assertPathsInsidePrivateRoot(options.privateRootDirectory, [
    { path: join(options.outputDirectory, "reports"), kind: "existing" },
  ]);
  await writeNewPrivateJson(
    join(options.outputDirectory, "reports", `attempt-${randomUUID()}.json`),
    {
      version: 1,
      phase: "prepare",
      runSha256,
      complete: summary.complete,
      sourceCount: confirmedSources.length,
      candidateCount: summary.report.length,
      completedSourceCount: summary.completedSourceCount,
      failedSourceCount: summary.failedSourceCount,
      uncertainSourceCount: summary.uncertainSourceCount,
      pendingSourceCount: summary.pendingSourceCount,
      failureKinds: summary.failureKinds,
    },
  );

  if (summary.complete) {
    const batchSha256 = sha256Hex(
      JSON.stringify({
        version: 1,
        candidates: summary.report.map((candidate) => ({
          candidateId: candidate.candidateId,
          sourceId: candidate.sourceId,
          contentSha256: candidate.contentSha256,
        })),
      }),
    );
    await writeOrValidatePreparationJson(
      options.privateRootDirectory,
      join(options.outputDirectory, "review.json"),
      {
        version: 2,
        phase: "prepare",
        batchSha256,
        runSha256,
        sourceCount: confirmedSources.length,
        candidateCount: summary.report.length,
        candidates: summary.report,
      },
    );
    await finalizePreparationIncompleteMarker(
      options.privateRootDirectory,
      options.outputDirectory,
    );
    await writeOrValidatePreparationJson(
      options.privateRootDirectory,
      join(options.outputDirectory, "PREPARE_COMPLETE"),
      {
        version: 2,
        phase: "prepare",
        batchSha256,
        candidateCount: summary.report.length,
        sourceCount: confirmedSources.length,
        runSha256,
      },
    );
  }

  return {
    sourceCount: confirmedSources.length,
    candidateCount: summary.report.length,
    completedSourceCount: summary.completedSourceCount,
    failedSourceCount: summary.failedSourceCount,
    uncertainSourceCount: summary.uncertainSourceCount,
    pendingSourceCount: summary.pendingSourceCount,
    complete: summary.complete,
  };
}

type PreparationSourceState =
  | "pending"
  | { readonly kind: "active"; readonly record: z.infer<typeof preparationActiveSchema> }
  | { readonly kind: "failed"; readonly record: z.infer<typeof preparationFailureSchema> }
  | {
      readonly kind: "completed";
      readonly record: z.infer<typeof preparationCompletedSchema>;
    };

function preparationStatePath(
  outputDirectory: string,
  sourceId: string,
  state: "active" | "completed" | "failed",
): string {
  return join(outputDirectory, "requests", `${sourceId}.${state}.json`);
}

async function loadPreparationSourceState(
  privateRootDirectory: string,
  outputDirectory: string,
  sourceId: string,
): Promise<PreparationSourceState> {
  const active = await readOptionalPreparationRecord(
    privateRootDirectory,
    preparationStatePath(outputDirectory, sourceId, "active"),
    preparationActiveSchema,
  );
  const completed = await readOptionalPreparationRecord(
    privateRootDirectory,
    preparationStatePath(outputDirectory, sourceId, "completed"),
    preparationCompletedSchema,
  );
  const failed = await readOptionalPreparationRecord(
    privateRootDirectory,
    preparationStatePath(outputDirectory, sourceId, "failed"),
    preparationFailureSchema,
  );
  for (const record of [active, completed, failed]) {
    if (record !== null && record.sourceId !== sourceId) {
      throw new HistoryMigrationError(
        "PREPARE_RESUME_UNSAFE",
        "prepare 检查点的安全编号不一致，不能继续。",
      );
    }
  }
  if (completed !== null) {
    if (
      active === null ||
      failed !== null ||
      completed.activeSha256 !== sha256Hex(JSON.stringify(active))
    ) {
      throw new HistoryMigrationError(
        "PREPARE_RESUME_UNSAFE",
        "prepare 完成检查点与请求登记不一致，不能继续。",
      );
    }
    await assertPreparationAttemptChain(
      privateRootDirectory,
      outputDirectory,
      sourceId,
      completed.requestAttemptSha256s,
    );
    return { kind: "completed", record: completed };
  }
  if (failed !== null) {
    if (
      (failed.activeSha256 === null && active !== null) ||
      (failed.activeSha256 !== null &&
        (active === null || failed.activeSha256 !== sha256Hex(JSON.stringify(active))))
    ) {
      throw new HistoryMigrationError(
        "PREPARE_RESUME_UNSAFE",
        "prepare 失败检查点与请求登记不一致，不能继续。",
      );
    }
    await assertPreparationAttemptChain(
      privateRootDirectory,
      outputDirectory,
      sourceId,
      failed.requestAttemptSha256s,
    );
    return { kind: "failed", record: failed };
  }
  return active === null ? "pending" : { kind: "active", record: active };
}

async function readOptionalPreparationRecord<T>(
  privateRootDirectory: string,
  path: string,
  schema: z.ZodType<T>,
): Promise<T | null> {
  try {
    await lstat(path);
  } catch (error) {
    if (hasNodeErrorCode(error, "ENOENT")) return null;
    throw new HistoryMigrationError("PREPARE_RESUME_UNSAFE", "prepare 检查点无法安全读取。");
  }
  await assertPathsInsidePrivateRoot(privateRootDirectory, [{ path, kind: "existing" }]);
  await assertPrivateFileMode(path);
  const parsed = schema.safeParse(await readPrivateJson(path));
  if (!parsed.success) {
    throw new HistoryMigrationError(
      "PREPARE_RESUME_UNSAFE",
      "prepare 检查点格式不正确，不能继续。",
    );
  }
  return parsed.data;
}

async function assertPreparationAttemptChain(
  privateRootDirectory: string,
  outputDirectory: string,
  sourceId: string,
  expectedSha256s: readonly string[],
): Promise<void> {
  if (expectedSha256s.length === 0) return;
  for (const [index, expectedSha256] of expectedSha256s.entries()) {
    const path =
      index === 0
        ? preparationStatePath(outputDirectory, sourceId, "active")
        : join(
            outputDirectory,
            "requests",
            `${sourceId}.attempt-${String(index + 1).padStart(2, "0")}.active.json`,
          );
    const record = await readOptionalPreparationRecord(
      privateRootDirectory,
      path,
      preparationActiveSchema,
    );
    if (
      record === null ||
      record.sourceId !== sourceId ||
      sha256Hex(JSON.stringify(record)) !== expectedSha256
    ) {
      throw new HistoryMigrationError(
        "PREPARE_RESUME_UNSAFE",
        "prepare 的逐请求登记链不完整或摘要不一致，不能继续。",
      );
    }
  }
}

async function writePreparationFailure(
  privateRootDirectory: string,
  outputDirectory: string,
  sourceId: string,
  activeSha256: string | null,
  requestAttemptSha256s: readonly string[],
  failureKind: HistoryNormalizationFailureKind,
): Promise<void> {
  await assertPathsInsidePrivateRoot(privateRootDirectory, [
    { path: join(outputDirectory, "requests"), kind: "existing" },
  ]);
  await writeNewPrivateJson(
    preparationStatePath(outputDirectory, sourceId, "failed"),
    preparationFailureSchema.parse({
      version: 1,
      status: "failed",
      sourceId,
      activeSha256,
      requestAttemptSha256s,
      failureKind,
    }),
  );
}

function classifyPreparationFailure(error: unknown): HistoryNormalizationFailureKind {
  if (error instanceof HistoryNormalizationError) return error.failureKind;
  if (error instanceof z.ZodError) return "schema";
  if (
    error instanceof HistoryMigrationError &&
    (error.code === "CANDIDATE_INVALID" || error.code === "CANDIDATE_CHANGED")
  ) {
    return "candidate_validation";
  }
  return "internal";
}

async function summarizePreparation(
  privateRootDirectory: string,
  outputDirectory: string,
  confirmedSources: readonly ConfirmedSource[],
): Promise<{
  readonly complete: boolean;
  readonly completedSourceCount: number;
  readonly failedSourceCount: number;
  readonly uncertainSourceCount: number;
  readonly pendingSourceCount: number;
  readonly failureKinds: readonly HistoryNormalizationFailureKind[];
  readonly report: readonly {
    readonly candidateId: string;
    readonly sourceId: string;
    readonly contentSha256: string;
    readonly titleLength: number;
    readonly basicStatementLength: number;
    readonly basicSolutionLength: number;
    readonly totalContentLength: number;
    readonly sampleCount: number;
    readonly status: "awaiting_approval";
  }[];
}> {
  let completedSourceCount = 0;
  let failedSourceCount = 0;
  let uncertainSourceCount = 0;
  let pendingSourceCount = 0;
  const failureKinds = new Set<HistoryNormalizationFailureKind>();
  const report: Array<{
    readonly candidateId: string;
    readonly sourceId: string;
    readonly contentSha256: string;
    readonly titleLength: number;
    readonly basicStatementLength: number;
    readonly basicSolutionLength: number;
    readonly totalContentLength: number;
    readonly sampleCount: number;
    readonly status: "awaiting_approval";
  }> = [];

  for (const source of confirmedSources) {
    const state = await loadPreparationSourceState(
      privateRootDirectory,
      outputDirectory,
      source.sourceId,
    );
    if (state === "pending") {
      pendingSourceCount += 1;
      continue;
    }
    if (state.kind === "active") {
      uncertainSourceCount += 1;
      continue;
    }
    if (state.kind === "failed") {
      failedSourceCount += 1;
      failureKinds.add(state.record.failureKind);
      continue;
    }
    completedSourceCount += 1;
    for (const reference of state.record.candidates) {
      const candidate = await loadCandidate(
        privateRootDirectory,
        outputDirectory,
        reference.candidateId,
      );
      if (
        candidate.sourceId !== source.sourceId ||
        candidate.contentSha256 !== reference.contentSha256 ||
        candidateContentDigest(candidate) !== reference.contentSha256
      ) {
        throw new HistoryMigrationError(
          "PREPARE_RESUME_UNSAFE",
          "prepare 已完成候选与检查点摘要不一致，不能继续。",
        );
      }
      report.push({
        candidateId: candidate.candidateId,
        sourceId: candidate.sourceId,
        contentSha256: candidate.contentSha256,
        titleLength: candidate.problem.title.length,
        basicStatementLength: candidate.problem.content.basicStatement.length,
        basicSolutionLength: candidate.problem.content.basicSolution.length,
        totalContentLength: totalCandidateContentLength(candidate.problem),
        sampleCount: candidate.problem.samples.length,
        status: "awaiting_approval",
      });
    }
  }

  return {
    complete:
      failedSourceCount === 0 &&
      uncertainSourceCount === 0 &&
      pendingSourceCount === 0 &&
      completedSourceCount === confirmedSources.length,
    completedSourceCount,
    failedSourceCount,
    uncertainSourceCount,
    pendingSourceCount,
    failureKinds: [...failureKinds].sort(),
    report,
  };
}

function hasNodeErrorCode(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { readonly code?: unknown }).code === code
  );
}

async function writeOrValidatePreparationJson(
  privateRootDirectory: string,
  path: string,
  value: unknown,
): Promise<void> {
  await assertPathsInsidePrivateRoot(privateRootDirectory, [
    { path: dirname(path), kind: "existing" },
  ]);
  let exists = true;
  try {
    await lstat(path);
  } catch (error) {
    if (hasNodeErrorCode(error, "ENOENT")) {
      exists = false;
    } else {
      throw new HistoryMigrationError("PREPARE_RESUME_UNSAFE", "prepare 收尾文件无法安全检查。");
    }
  }
  if (!exists) {
    await writeNewPrivateJson(path, value);
    return;
  }
  await assertPathsInsidePrivateRoot(privateRootDirectory, [{ path, kind: "existing" }]);
  await assertPrivateFileMode(path);
  const existing = await readPrivateJson(path);
  if (sha256Hex(JSON.stringify(existing)) !== sha256Hex(JSON.stringify(value))) {
    throw new HistoryMigrationError(
      "PREPARE_RESUME_UNSAFE",
      "prepare 收尾文件与检查点不一致，不能覆盖。",
    );
  }
}

async function finalizePreparationIncompleteMarker(
  privateRootDirectory: string,
  outputDirectory: string,
): Promise<void> {
  await assertPathsInsidePrivateRoot(privateRootDirectory, [
    { path: outputDirectory, kind: "existing" },
  ]);
  const incompletePath = join(outputDirectory, "PREPARE_INCOMPLETE");
  try {
    await lstat(incompletePath);
  } catch (error) {
    if (hasNodeErrorCode(error, "ENOENT")) {
      const runPath = join(outputDirectory, "PREPARE_RUN");
      await assertPathsInsidePrivateRoot(privateRootDirectory, [
        { path: runPath, kind: "existing" },
      ]);
      await assertPrivateFileMode(runPath);
      return;
    }
    throw new HistoryMigrationError("OUTPUT_WRITE_FAILED", "prepare 状态标记无法安全完成。");
  }
  await assertPathsInsidePrivateRoot(privateRootDirectory, [
    { path: incompletePath, kind: "existing" },
  ]);
  await assertPrivateFileMode(incompletePath);
  await movePrivateFileNoReplace(incompletePath, join(outputDirectory, "PREPARE_RUN"));
}

export async function packageApprovedCandidates(
  options: PackageApprovedCandidatesOptions,
): Promise<PackageApprovedCandidatesResult> {
  await assertPathsInsidePrivateRoot(options.privateRootDirectory, [
    { path: options.sourceDirectory, kind: "existing" },
    { path: options.metadataFile, kind: "existing" },
    { path: options.sourceConfirmationFile, kind: "existing" },
    { path: options.preparedDirectory, kind: "existing" },
    { path: options.approvalFile, kind: "existing" },
    { path: options.outputDirectory, kind: "new" },
    { path: options.authorMappingOutput, kind: "new" },
  ]);
  assertSeparateAuthorMappingPath(options.outputDirectory, options.authorMappingOutput);
  await assertNewOutputPath(options.authorMappingOutput);

  const { confirmedSources } = await loadConfirmedInputs(
    options.metadataFile,
    options.sourceConfirmationFile,
  );
  const sourcesById = new Map(confirmedSources.map((source) => [source.sourceId, source] as const));
  const approvals = parsePrivateInput(
    historyCandidateApprovalSchema,
    await readPrivateJson(options.approvalFile),
    "INVALID_CANDIDATE_APPROVAL",
    "候选批准文件格式不正确或没有明确确认。",
  );

  const assignedSourceIds = new Set<string>();
  const approvedCandidates: ApprovedCandidate[] = [];
  for (const approval of approvals.approvals) {
    const candidate = await loadCandidate(
      options.privateRootDirectory,
      options.preparedDirectory,
      approval.candidateId,
    );
    if (candidate.candidateId !== approval.candidateId) {
      throw new HistoryMigrationError(
        "CANDIDATE_INVALID",
        `${approval.candidateId} 的文件内容与安全编号不一致。`,
      );
    }
    const currentDigest = candidateContentDigest(candidate);
    if (currentDigest !== candidate.contentSha256 || currentDigest !== approval.contentSha256) {
      throw new HistoryMigrationError(
        "CANDIDATE_CHANGED",
        `${approval.candidateId} 的内容已经变化，原来的批准已失效。`,
      );
    }

    const source = sourcesById.get(candidate.sourceId);
    if (source === undefined) {
      throw new HistoryMigrationError(
        "SOURCE_MAPPING_MISSING",
        `${approval.candidateId} 没有对应的已确认源文件映射。`,
      );
    }
    if (
      candidate.sourceContentSha256 !== source.mapping.sourceSha256 ||
      candidate.sourceMappingSha256 !== source.sourceMappingSha256
    ) {
      throw new HistoryMigrationError(
        "SOURCE_MAPPING_CHANGED",
        `${approval.candidateId} 对应的源文件映射已经变化，必须重新准备候选。`,
      );
    }
    await readConfirmedSource(
      options.sourceDirectory,
      source.mapping.sourcePath,
      source.mapping.sourceSha256,
      source.sourceId,
    );
    assertPrivateIdentifiersNotPresent(
      {
        problem: candidate.problem,
        normalizationNote: candidate.normalizationNote,
      },
      source.metadata.authorStudentId,
      source.mapping.sourcePath,
    );
    if (assignedSourceIds.has(candidate.sourceId)) {
      throw new HistoryMigrationError(
        "DUPLICATE_ASSIGNMENT",
        "多个批准候选被分配给同一条元数据，必须人工拆分源文件并重新确认。",
      );
    }
    assignedSourceIds.add(candidate.sourceId);
    approvedCandidates.push({ record: candidate, metadata: source.metadata });
  }

  await loadPreparationMarker(
    options.privateRootDirectory,
    options.preparedDirectory,
    confirmedSources,
  );

  await createNewPrivateDirectory(options.outputDirectory);
  const stagingDirectory = join(options.outputDirectory, `.incomplete-${randomUUID()}`);
  let authorMappingWritten = false;
  try {
    await mkdir(stagingDirectory, { recursive: false, mode: 0o700 });
    const packageDirectory = join(stagingDirectory, "packages");
    await mkdir(packageDirectory, { recursive: false, mode: 0o700 });

    const packageReport: Array<{
      readonly candidateId: string;
      readonly contentSha256: string;
      readonly packageSha256: string;
      readonly packageBytes: number;
      readonly status: "packaged";
    }> = [];
    const authorMappings: Array<{
      readonly candidateId: string;
      readonly contentSha256: string;
      readonly packageSha256: string;
      readonly authorStudentId: string;
    }> = [];

    for (const approved of approvedCandidates) {
      const generated = await urmotivNativeAdapter.export(approved.record.problem, {
        exportedAt: options.exportedAt ?? new Date().toISOString(),
      });
      if (generated.kind !== "zip") {
        throw new Error("Urmotiv 原生题目包没有生成 ZIP。");
      }
      const archive = writeZipArchive(generated.files);
      const packageSha256 = sha256Hex(archive);
      await writeNewPrivateFile(
        join(packageDirectory, `${approved.record.candidateId}.zip`),
        archive,
      );
      packageReport.push({
        candidateId: approved.record.candidateId,
        contentSha256: approved.record.contentSha256,
        packageSha256,
        packageBytes: archive.byteLength,
        status: "packaged",
      });
      if (approved.metadata.authorStudentId.length > 0) {
        authorMappings.push({
          candidateId: approved.record.candidateId,
          contentSha256: approved.record.contentSha256,
          packageSha256,
          authorStudentId: approved.metadata.authorStudentId,
        });
      }
    }

    const batchSha256 = sha256Hex(
      JSON.stringify({
        version: 1,
        packages: packageReport,
      }),
    );
    await writeNewPrivateJson(join(stagingDirectory, "report.json"), {
      version: 1,
      phase: "package",
      batchSha256,
      packageCount: packageReport.length,
      packages: packageReport,
    });
    await writeNewPrivateJson(join(stagingDirectory, "PACKAGE_COMPLETE"), {
      version: 1,
      phase: "package",
      batchSha256,
      packageCount: packageReport.length,
    });
    await rename(join(stagingDirectory, "packages"), join(options.outputDirectory, "packages"));
    await rename(
      join(stagingDirectory, "report.json"),
      join(options.outputDirectory, "report.json"),
    );
    await writeNewPrivateJson(options.authorMappingOutput, {
      version: 1,
      batchSha256,
      records: authorMappings,
    });
    authorMappingWritten = true;
    await rename(
      join(stagingDirectory, "PACKAGE_COMPLETE"),
      join(options.outputDirectory, "PACKAGE_COMPLETE"),
    );
    await rmdir(stagingDirectory);

    return {
      packageCount: packageReport.length,
      authorMappingCount: authorMappings.length,
    };
  } catch (error) {
    await rm(options.outputDirectory, { recursive: true, force: true }).catch(() => undefined);
    if (authorMappingWritten) {
      await rm(options.authorMappingOutput, { force: true }).catch(() => undefined);
    }
    throw error;
  }
}

async function loadConfirmedInputs(
  metadataFile: string,
  sourceConfirmationFile: string,
): Promise<{
  readonly confirmedSources: readonly ConfirmedSource[];
}> {
  const metadataInput = await readPrivateJsonWithDigest(metadataFile);
  const metadata = parsePrivateInput(
    historyMetadataFileSchema,
    metadataInput.value,
    "INVALID_METADATA",
    "历史题目元数据格式不正确。",
  );
  const sourceConfirmation = parsePrivateInput(
    historySourceMappingSchema,
    await readPrivateJson(sourceConfirmationFile),
    "INVALID_SOURCE_CONFIRMATION",
    "源文件映射确认格式不正确或没有明确确认。",
  );
  if (sourceConfirmation.metadataFileSha256 !== metadataInput.sha256) {
    throw new HistoryMigrationError(
      "SOURCE_MAPPING_CHANGED",
      "私有元数据文件已经变化，原来的源文件映射确认已失效。",
    );
  }
  const metadataByNumber = new Map(
    metadata.records.map((record) => [record.number, record] as const),
  );
  const confirmedSources = sourceConfirmation.mappings.map((mapping, index) => {
    const matchedMetadata = metadataByNumber.get(mapping.metadataNumber);
    if (matchedMetadata === undefined) {
      throw new HistoryMigrationError(
        "SOURCE_MAPPING_MISSING",
        `${makeSafeId("source", index + 1)} 指向的元数据不存在。`,
      );
    }
    return {
      sourceId: makeSafeId("source", index + 1),
      mapping,
      sourceMappingSha256: sourceMappingDigest(mapping, sourceConfirmation.metadataFileSha256),
      metadata: matchedMetadata,
    };
  });
  return { confirmedSources };
}

async function loadPreparationMarker(
  privateRootDirectory: string,
  preparedDirectory: string,
  confirmedSources: readonly ConfirmedSource[],
): Promise<void> {
  const incompletePath = join(preparedDirectory, "PREPARE_INCOMPLETE");
  try {
    await lstat(incompletePath);
    throw new HistoryMigrationError(
      "CANDIDATE_INVALID",
      "候选目录仍标记为不完整，不能生成题目包。",
    );
  } catch (error) {
    if (error instanceof HistoryMigrationError || !hasNodeErrorCode(error, "ENOENT")) {
      throw error;
    }
  }

  const completePath = join(preparedDirectory, "PREPARE_COMPLETE");
  const runPath = join(preparedDirectory, "run.json");
  const runMarkerPath = join(preparedDirectory, "PREPARE_RUN");
  const reviewPath = join(preparedDirectory, "review.json");
  for (const path of [completePath, runPath, runMarkerPath, reviewPath]) {
    await assertPathsInsidePrivateRoot(privateRootDirectory, [{ path, kind: "existing" }]);
    await assertPrivateFileMode(path);
  }
  const marker = parsePrivateInput(
    preparationCompleteSchema,
    await readPrivateJson(completePath),
    "CANDIDATE_INVALID",
    "候选目录没有完整的准备完成标记。",
  );
  const run = preparationRunSchema.safeParse(await readPrivateJson(runPath));
  if (!run.success || sha256Hex(JSON.stringify(run.data)) !== marker.runSha256) {
    throw new HistoryMigrationError("CANDIDATE_INVALID", "候选目录的运行身份不完整或不一致。");
  }
  const runMarker = z
    .object({
      version: z.literal(1),
      phase: z.literal("prepare"),
      status: z.literal("incomplete"),
      runSha256: digestSchema,
    })
    .strict()
    .safeParse(await readPrivateJson(runMarkerPath));
  if (!runMarker.success || runMarker.data.runSha256 !== marker.runSha256) {
    throw new HistoryMigrationError("CANDIDATE_INVALID", "候选目录的运行状态标记不一致。");
  }
  if (
    run.data.sourceCount !== confirmedSources.length ||
    marker.sourceCount !== confirmedSources.length
  ) {
    throw new HistoryMigrationError("CANDIDATE_INVALID", "候选目录的源文件计数不一致。");
  }

  const summary = await summarizePreparation(
    privateRootDirectory,
    preparedDirectory,
    confirmedSources,
  );
  if (!summary.complete || summary.report.length !== marker.candidateCount) {
    throw new HistoryMigrationError("CANDIDATE_INVALID", "候选目录的逐题检查点尚未完整结束。");
  }
  const batchSha256 = sha256Hex(
    JSON.stringify({
      version: 1,
      candidates: summary.report.map((candidate) => ({
        candidateId: candidate.candidateId,
        sourceId: candidate.sourceId,
        contentSha256: candidate.contentSha256,
      })),
    }),
  );
  const expectedReview = {
    version: 2,
    phase: "prepare",
    batchSha256,
    runSha256: marker.runSha256,
    sourceCount: confirmedSources.length,
    candidateCount: summary.report.length,
    candidates: summary.report,
  };
  if (
    batchSha256 !== marker.batchSha256 ||
    sha256Hex(JSON.stringify(await readPrivateJson(reviewPath))) !==
      sha256Hex(JSON.stringify(expectedReview))
  ) {
    throw new HistoryMigrationError("CANDIDATE_INVALID", "候选目录的审核清单与检查点不一致。");
  }
}

async function loadCandidate(
  privateRootDirectory: string,
  preparedDirectory: string,
  candidateId: string,
): Promise<HistoryCandidateRecord> {
  const candidatePath = join(preparedDirectory, "candidates", `${candidateId}.json`);
  try {
    await assertPathsInsidePrivateRoot(privateRootDirectory, [
      { path: candidatePath, kind: "existing" },
    ]);
    await assertPrivateFileMode(candidatePath);
    return parsePrivateInput(
      historyCandidateRecordSchema,
      await readPrivateJson(candidatePath),
      "CANDIDATE_INVALID",
      `${candidateId} 的候选文件格式不正确。`,
    );
  } catch (error) {
    if (error instanceof HistoryMigrationError) {
      if (error.code === "SOURCE_FILE_INVALID" || error.code === "SOURCE_TOO_LARGE") {
        throw new HistoryMigrationError(
          "CANDIDATE_NOT_FOUND",
          `${candidateId} 不存在或无法安全读取。`,
        );
      }
      throw error;
    }
    throw new HistoryMigrationError("CANDIDATE_NOT_FOUND", `${candidateId} 不存在或无法安全读取。`);
  }
}

function toCandidateProblem(problem: NormalizedHistoryProblem): CanonicalProblem {
  return historyCandidateProblemSchema.parse({
    title: problem.title,
    type: problem.type,
    tags: problem.tags,
    difficulty: {},
    content: {
      basicStatement: problem.basicStatement,
      basicSolution: problem.basicSolution,
      background: problem.background,
      statement: problem.statement,
      inputFormat: problem.inputFormat,
      outputFormat: problem.outputFormat,
      constraints: problem.constraints,
      solution: problem.solution,
      hints: problem.hints,
    },
    samples: problem.samples,
    files: [],
    provenance: {
      sourceSystem: "ustc-history-private",
    },
    extensions: {},
  });
}

function totalCandidateContentLength(problem: CanonicalProblem): number {
  const contentLength = Object.values(problem.content).reduce(
    (total, value) => total + value.length,
    0,
  );
  const sampleLength = problem.samples.reduce(
    (total, sample) =>
      total + sample.input.length + sample.output.length + sample.explanation.length,
    0,
  );
  return problem.title.length + contentLength + sampleLength;
}

function makeSafeId(kind: "source" | "candidate", sequence: number): string {
  if (!Number.isSafeInteger(sequence) || sequence <= 0 || sequence > 999_999) {
    throw new HistoryMigrationError("CANDIDATE_INVALID", "历史迁移安全编号数量超出支持范围。");
  }
  return `${kind}-${String(sequence).padStart(6, "0")}`;
}

function parsePrivateInput<T>(
  schema: z.ZodType<T>,
  input: unknown,
  code:
    | "INVALID_METADATA"
    | "INVALID_SOURCE_CONFIRMATION"
    | "INVALID_CANDIDATE_APPROVAL"
    | "CANDIDATE_INVALID",
  message: string,
): T {
  const parsed = schema.safeParse(input);
  if (!parsed.success) {
    throw new HistoryMigrationError(code, message);
  }
  return parsed.data;
}

function assertSeparateAuthorMappingPath(
  outputDirectory: string,
  authorMappingOutput: string,
): void {
  const outputRoot = resolve(outputDirectory);
  const authorPath = resolve(authorMappingOutput);
  const relativePath = relative(outputRoot, authorPath);
  if (relativePath.length === 0 || (!relativePath.startsWith("..") && !isAbsolute(relativePath))) {
    throw new HistoryMigrationError(
      "INVALID_ARGUMENTS",
      "作者学号映射必须写到题目包输出目录之外的单独私有文件。",
    );
  }
}

function assertPrivateIdentifiersNotPresent(
  value: unknown,
  authorStudentId: string,
  sourcePath: string,
): void {
  const sourceName = sourcePath.split("/").at(-1) ?? sourcePath;
  const privateIdentifiers = [authorStudentId, sourcePath, sourceName]
    .map((item) => item.trim().toLocaleLowerCase("en-US"))
    .filter((item, index, all) => item.length > 0 && all.indexOf(item) === index);
  if (privateIdentifiers.some((identifier) => containsText(value, identifier))) {
    throw new HistoryMigrationError(
      "CANDIDATE_INVALID",
      "候选内容含有作者学号或原文件标识；必须先在私有资料中移除个人标识，再重新准备候选。",
    );
  }
}

function containsText(value: unknown, normalizedNeedle: string): boolean {
  if (typeof value === "string") {
    return value.toLocaleLowerCase("en-US").includes(normalizedNeedle);
  }
  if (Array.isArray(value)) {
    return value.some((item) => containsText(item, normalizedNeedle));
  }
  if (typeof value === "object" && value !== null) {
    return Object.values(value).some((item) => containsText(item, normalizedNeedle));
  }
  return false;
}
