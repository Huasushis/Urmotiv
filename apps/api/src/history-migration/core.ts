import { randomUUID } from "node:crypto";
import { lstat, mkdir, rm } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import type { CanonicalProblem } from "@urmotiv/problem-package";
import {
  checksumFilePath,
  checksumsForFiles,
  renderChecksums,
  urmotivNativeAdapter,
  writeZipArchive,
} from "@urmotiv/problem-package";
import { z } from "zod";
import {
  type HistoryAttachmentMappingCapability,
  revalidateHistoryAttachmentMappingCapability,
} from "./attachment-mapping";
import { candidateContentDigest, sha256Hex, sourceMappingDigest } from "./digests";
import {
  HistoryMigrationError,
  HistoryNormalizationError,
  historyNormalizationFailureKinds,
  type HistoryNormalizationFailureKind,
} from "./errors";
import {
  type HistoryAttachmentSourceLocator,
  assertHistoryMaterializationComplete,
} from "./grouping-workflow";
import {
  assertPathsInsidePrivateRoot,
  assertPrivateDirectoryMode,
  assertPrivateFileMode,
  assertNewOutputPath,
  createNewPrivateDirectory,
  openVerifiedPrivateOutputWriter,
  type VerifiedPrivateOutputWriter,
  readConfirmedSource,
  readPrivateJson,
  readPrivateJsonWithDigest,
  movePrivateFileNoReplace,
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
  readonly materializedDirectory: string;
  readonly metadataFile: string;
  readonly preparedDirectory: string;
  readonly approvalFile: string;
  readonly outputDirectory: string;
  readonly authorMappingOutput: string;
  readonly attachmentMappingCapability: HistoryAttachmentMappingCapability;
  readonly exportedAt?: string;
  /**
   * 只供确定性测试注入的挂钩。真实调用方不要传这些函数。
   */
  readonly testingHooks?: {
    /** 物化核对通过之后、发布任何最终输出之前的最终复核之前触发。 */
    readonly afterMaterializationVerified?: () => Promise<void>;
    /** 最终复核通过之后、创建输出目录之前触发。 */
    readonly afterFinalOutputRecheck?: () => Promise<void>;
    /** 全部最终输出（不含 PACKAGE_COMPLETE）发布之后、最终复核之前触发。 */
    readonly afterFinalOutputsPublished?: () => Promise<void>;
  };
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
  /** 本批次已确认附件数；仅在附件能力非空时出现。 */
  readonly attachmentCount?: number;
  /** 写入内部保全目录的批次内部附件数；仅在附件能力非空时出现。 */
  readonly preservedMaterialCount?: number;
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
    await readPrivateJson(options.sourceConfirmationFile),
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
    { path: options.materializedDirectory, kind: "existing" },
    { path: options.metadataFile, kind: "existing" },
    { path: options.preparedDirectory, kind: "existing" },
    { path: options.approvalFile, kind: "existing" },
    { path: options.outputDirectory, kind: "new" },
    { path: options.authorMappingOutput, kind: "new" },
  ]);
  assertSeparateAuthorMappingPath(options.outputDirectory, options.authorMappingOutput);

  const materialization = await assertHistoryMaterializationComplete({
    privateRootDirectory: options.privateRootDirectory,
    materializedDirectory: options.materializedDirectory,
  });
  const attachmentCapability = await revalidateHistoryAttachmentMappingCapability(
    options.attachmentMappingCapability,
    {
      privateRootDirectory: options.privateRootDirectory,
      metadataFile: options.metadataFile,
    },
  );
  if (attachmentCapability.groupingBatchSha256 !== materialization.groupingBatchSha256) {
    throw new HistoryMigrationError(
      "ATTACHMENT_MAPPING_CHANGED",
      "附件映射与本次可信物化结果不属于同一个已确认题目分组批次。",
    );
  }
  let attachmentPackagePlan: AttachmentPackagePlan | undefined;
  if (attachmentCapability.attachmentCount > 0) {
    attachmentPackagePlan = buildAttachmentPackagePlan(
      attachmentCapability,
      await materialization.readReport(),
    );
  }
  await assertNewOutputPath(options.authorMappingOutput);

  const { confirmedSources } = await loadConfirmedInputs(
    options.metadataFile,
    await materialization.readSourceConfirmation(),
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
    await materialization.readConfirmedSource(
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

  await options.testingHooks?.afterMaterializationVerified?.();
  await materialization.assertUnchangedBeforePublish();
  await options.testingHooks?.afterFinalOutputRecheck?.();

  await createNewPrivateDirectory(options.outputDirectory);
  const packagesDirectory = join(options.outputDirectory, "packages");
  let authorMappingWritten = false;
  let authorMappingWriter: VerifiedPrivateOutputWriter | undefined;
  let packagesWriter: VerifiedPrivateOutputWriter | undefined;
  let outputWriter: VerifiedPrivateOutputWriter | undefined;
  const preservedWriters: VerifiedPrivateOutputWriter[] = [];
  try {
    await mkdir(packagesDirectory, { recursive: false, mode: 0o700 });
    outputWriter = await openVerifiedPrivateOutputWriter(options.outputDirectory);
    packagesWriter = await openVerifiedPrivateOutputWriter(packagesDirectory);
    authorMappingWriter = await openVerifiedPrivateOutputWriter(
      dirname(options.authorMappingOutput),
    );

    const packageReport: Array<{
      readonly candidateId: string;
      readonly contentSha256: string;
      readonly packageSha256: string;
      readonly packageBytes: number;
      readonly status: "packaged";
      readonly attachments?: readonly {
        readonly attachmentId: string;
        readonly contentSha256: string;
        readonly semanticRole: string;
        readonly visibility: string;
        readonly targetPath: string;
      }[];
    }> = [];
    const authorMappings: Array<{
      readonly candidateId: string;
      readonly contentSha256: string;
      readonly packageSha256: string;
      readonly authorStudentId: string;
    }> = [];

    for (const approved of approvedCandidates) {
      const candidateAttachmentPlan =
        attachmentPackagePlan === undefined
          ? undefined
          : attachmentPlanForCandidate(attachmentPackagePlan, approved.record.sourceId);
      const problemForExport =
        candidateAttachmentPlan === undefined || candidateAttachmentPlan.rewrites.length === 0
          ? approved.record.problem
          : applyStatementReferenceRewrites(approved.record.problem, candidateAttachmentPlan.rewrites);
      const generated = await urmotivNativeAdapter.export(problemForExport, {
        exportedAt: options.exportedAt ?? new Date().toISOString(),
      });
      if (generated.kind !== "zip") {
        throw new Error("Urmotiv 原生题目包没有生成 ZIP。");
      }
      const attachmentFiles: Array<{ readonly path: string; readonly content: Uint8Array }> = [];
      const attachmentRecords: Array<{
        readonly attachmentId: string;
        readonly contentSha256: string;
        readonly semanticRole: string;
        readonly visibility: string;
        readonly targetPath: string;
      }> = [];
      if (candidateAttachmentPlan !== undefined) {
        const seenPaths = new Set(generated.files.map((file) => file.path));
        for (const target of candidateAttachmentPlan.targets) {
          if (seenPaths.has(target.targetPath)) {
            throw new HistoryMigrationError(
              "INVALID_ATTACHMENT_MAPPING",
              "附件目标路径与题目包已有文件冲突。",
            );
          }
          const bytes = readVerifiedAttachmentBytes(attachmentCapability, target);
          attachmentFiles.push({ path: target.targetPath, content: bytes });
          attachmentRecords.push({
            attachmentId: target.attachmentId,
            contentSha256: target.contentSha256,
            semanticRole: target.semanticRole,
            visibility: target.visibility,
            targetPath: target.targetPath,
          });
          seenPaths.add(target.targetPath);
        }
      }
      // 服务端导入路径同样以 allowNestedArchives=true 读取题目包，.xlsx/.docx
      // 等 ZIP 容器格式的附件作为不透明叶子文件进入包内。
      const archive = writeZipArchive(
        repackagedWithAttachmentChecksums(generated.files, attachmentFiles),
        { allowNestedArchives: true },
      );
      const packageSha256 = sha256Hex(archive);
      await packagesWriter.writeNewFile(`${approved.record.candidateId}.zip`, archive);
      packageReport.push({
        candidateId: approved.record.candidateId,
        contentSha256: approved.record.contentSha256,
        packageSha256,
        packageBytes: archive.byteLength,
        status: "packaged",
        ...(attachmentRecords.length > 0 ? { attachments: attachmentRecords } : {}),
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

    const preservedMaterialReport: Array<{
      readonly attachmentId: string;
      readonly contentSha256: string;
      readonly semanticRole: string;
      readonly preservationPath: string;
    }> = [];
    if (attachmentPackagePlan !== undefined) {
      const internalDirectory = join(options.outputDirectory, "internal");
      await mkdir(internalDirectory, { recursive: false, mode: 0o700 });
      for (const entry of attachmentPackagePlan.preservedEntries) {
        const bytes = readVerifiedAttachmentBytes(attachmentCapability, entry);
        preservedWriters.push(
          await writePreservedMaterialFile(
            options.privateRootDirectory,
            internalDirectory,
            entry.preservationPath,
            bytes,
          ),
        );
        preservedMaterialReport.push({
          attachmentId: entry.attachmentId,
          contentSha256: entry.contentSha256,
          semanticRole: entry.semanticRole,
          preservationPath: entry.preservationPath,
        });
      }
    }

    const batchPayload = {
      version: 1,
      packages: packageReport,
      ...(attachmentPackagePlan === undefined
        ? {}
        : {
            attachmentCount: attachmentCapability.attachmentCount,
            preservedMaterialCount: preservedMaterialReport.length,
            preservedMaterials: preservedMaterialReport,
          }),
    };
    const batchSha256 = sha256Hex(JSON.stringify(batchPayload));
    await outputWriter.writeNewJson("report.json", {
      version: 1,
      phase: "package",
      batchSha256,
      packageCount: packageReport.length,
      packages: packageReport,
      ...(attachmentPackagePlan === undefined
        ? {}
        : {
            attachmentCount: attachmentCapability.attachmentCount,
            preservedMaterialCount: preservedMaterialReport.length,
            preservedMaterials: preservedMaterialReport,
          }),
    });
    await authorMappingWriter.writeNewJson(basename(options.authorMappingOutput), {
      version: 1,
      batchSha256,
      records: authorMappings,
    });
    authorMappingWritten = true;

    await options.testingHooks?.afterFinalOutputsPublished?.();

    // 最终复核 PASS 点：PACKAGE_COMPLETE 发布前复核全部已发布输出；任何文件
    // 被替换、改写或 chmod 过（包括还原后，ctimeNs 仍会变化）都会失败，
    // 由下方 catch 删除全部部分输出。
    await packagesWriter.assertAllPublishedUnchanged();
    await outputWriter.assertAllPublishedUnchanged();
    await authorMappingWriter.assertAllPublishedUnchanged();
    for (const writer of preservedWriters) {
      await writer.assertAllPublishedUnchanged();
    }
    // 完成标记必须最后发布。
    await outputWriter.writeNewJson("PACKAGE_COMPLETE", {
      version: 1,
      phase: "package",
      batchSha256,
      packageCount: packageReport.length,
      ...(attachmentPackagePlan === undefined
        ? {}
        : {
            attachmentCount: attachmentCapability.attachmentCount,
            preservedMaterialCount: preservedMaterialReport.length,
          }),
    });
    // 返回前的最终 PASS 点：连同 PACKAGE_COMPLETE 一起复核，并复核输入的
    // 物化目录公开路径身份（close 内部完成）。
    await outputWriter.assertAllPublishedUnchanged();

    await authorMappingWriter.close();
    authorMappingWriter = undefined;
    await packagesWriter.close();
    packagesWriter = undefined;
    for (const writer of preservedWriters) {
      await writer.close();
    }
    preservedWriters.length = 0;
    await outputWriter.close();
    outputWriter = undefined;
    await materialization.close();

    return {
      packageCount: packageReport.length,
      authorMappingCount: authorMappings.length,
      ...(attachmentPackagePlan === undefined
        ? {}
        : {
            attachmentCount: attachmentCapability.attachmentCount,
            preservedMaterialCount: preservedMaterialReport.length,
          }),
    };
  } catch (error) {
    await rm(options.outputDirectory, { recursive: true, force: true }).catch(() => undefined);
    if (authorMappingWritten) {
      await rm(options.authorMappingOutput, { force: true }).catch(() => undefined);
    }
    throw error;
  } finally {
    await authorMappingWriter?.close().catch(() => undefined);
    await packagesWriter?.close().catch(() => undefined);
    for (const writer of preservedWriters) {
      await writer.close().catch(() => undefined);
    }
    await outputWriter?.close().catch(() => undefined);
    await materialization.close().catch(() => undefined);
  }
}

interface AttachmentPackageTarget {
  readonly attachmentId: string;
  readonly locator: HistoryAttachmentSourceLocator;
  readonly contentSha256: string;
  readonly byteLength: number;
  readonly semanticRole: string;
  readonly visibility: string;
  readonly targetPath: string;
}

interface AttachmentPackagePreservedEntry {
  readonly attachmentId: string;
  readonly locator: HistoryAttachmentSourceLocator;
  readonly contentSha256: string;
  readonly byteLength: number;
  readonly semanticRole: string;
  readonly preservationPath: string;
}

interface AttachmentPackagePlan {
  readonly groupIdBySourceId: ReadonlyMap<string, string>;
  readonly rewritesByGroupId: ReadonlyMap<string, readonly { readonly from: string; readonly to: string }[]>;
  readonly targetsByGroupId: ReadonlyMap<string, readonly AttachmentPackageTarget[]>;
  readonly preservedEntries: readonly AttachmentPackagePreservedEntry[];
}

function buildAttachmentPackagePlan(
  capability: HistoryAttachmentMappingCapability,
  materializeReport: {
    readonly sources: readonly { readonly groupId: string; readonly sourceId: string }[];
  },
): AttachmentPackagePlan {
  const groupIdBySourceId = new Map(
    materializeReport.sources.map((source) => [source.sourceId, source.groupId] as const),
  );
  // 物化报告的 source→groupId 只是由确认清单与批次摘要间接绑定，这里与附件
  // 完成门的分组集合双向核对，防止物化报告被一致改写后把附件路由到别的分组。
  const reportGroupIds = new Set(materializeReport.sources.map((source) => source.groupId));
  for (const source of materializeReport.sources) {
    if (!capability.groups.some((group) => group.groupId === source.groupId)) {
      throw new HistoryMigrationError(
        "GROUPING_CHANGED",
        "物化报告的分组与附件完成门不一致。",
      );
    }
  }
  for (const group of capability.groups) {
    if (!reportGroupIds.has(group.groupId)) {
      throw new HistoryMigrationError(
        "GROUPING_CHANGED",
        "附件完成门分组缺少对应的物化源。",
      );
    }
  }
  const rewritesByGroupId = new Map<
    string,
    Array<{ readonly from: string; readonly to: string }>
  >();
  for (const rewrite of capability.mapping.referenceRewrites) {
    const list = rewritesByGroupId.get(rewrite.groupId) ?? [];
    list.push({ from: rewrite.from, to: rewrite.to });
    rewritesByGroupId.set(rewrite.groupId, list);
  }
  const targetsByGroupId = new Map<string, AttachmentPackageTarget[]>();
  for (const mapping of capability.mapping.mappings) {
    if (mapping.status !== "resolved" || mapping.scope.kind !== "problem_groups") {
      continue;
    }
    for (const target of mapping.scope.targets) {
      const list = targetsByGroupId.get(target.groupId) ?? [];
      list.push({
        attachmentId: mapping.attachmentId,
        locator: mapping.locator,
        contentSha256: mapping.contentSha256,
        byteLength: mapping.byteLength,
        semanticRole: mapping.semanticRole,
        visibility: mapping.visibility,
        targetPath: target.targetPath,
      });
      targetsByGroupId.set(target.groupId, list);
    }
  }
  const preservedEntries = capability.mapping.preservationEntries.map((entry) => {
    const mapping = capability.mapping.mappings.find(
      (item) => item.attachmentId === entry.attachmentId,
    );
    if (
      mapping === undefined ||
      mapping.status !== "resolved" ||
      mapping.scope.kind !== "batch_internal"
    ) {
      throw new HistoryMigrationError(
        "INVALID_ATTACHMENT_MAPPING",
        "内部保全条目与附件映射不一致。",
      );
    }
    return {
      attachmentId: entry.attachmentId,
      locator: mapping.locator,
      contentSha256: mapping.contentSha256,
      byteLength: mapping.byteLength,
      semanticRole: entry.semanticRole,
      preservationPath: entry.preservationPath,
    };
  });
  return {
    groupIdBySourceId,
    rewritesByGroupId,
    targetsByGroupId,
    preservedEntries,
  };
}

function attachmentPlanForCandidate(
  plan: AttachmentPackagePlan,
  sourceId: string,
): {
  readonly rewrites: readonly { readonly from: string; readonly to: string }[];
  readonly targets: readonly AttachmentPackageTarget[];
} | undefined {
  const groupId = plan.groupIdBySourceId.get(sourceId);
  if (groupId === undefined) {
    throw new HistoryMigrationError(
      "SOURCE_MAPPING_MISSING",
      "已批准候选没有对应的已确认物化源分组。",
    );
  }
  const rewrites = plan.rewritesByGroupId.get(groupId) ?? [];
  const targets = plan.targetsByGroupId.get(groupId) ?? [];
  if (rewrites.length === 0 && targets.length === 0) {
    return undefined;
  }
  return { rewrites, targets };
}

function applyStatementReferenceRewrites(
  problem: CanonicalProblem,
  rewrites: readonly { readonly from: string; readonly to: string }[],
): CanonicalProblem {
  const original = problem.content.basicStatement;
  // 先对未改写的原题面核对全部原引用，再按最长优先单遍替换：改写结果与
  // 计划顺序无关，也不会把先替换引入的新文本再次当作原引用匹配。
  for (const rewrite of rewrites) {
    if (!original.includes(rewrite.from)) {
      throw new HistoryMigrationError(
        "INVALID_ATTACHMENT_MAPPING",
        "题面资源原引用在候选题面中不存在，不能改写。",
      );
    }
  }
  if (rewrites.length === 0) {
    return problem;
  }
  const ordered = [...rewrites].sort((left, right) => right.from.length - left.from.length);
  let result = "";
  let index = 0;
  while (index < original.length) {
    let matched: { readonly from: string; readonly to: string } | undefined;
    for (const rewrite of ordered) {
      if (original.startsWith(rewrite.from, index)) {
        matched = rewrite;
        break;
      }
    }
    if (matched === undefined) {
      result += original[index] ?? "";
      index += 1;
      continue;
    }
    result += matched.to;
    index += matched.from.length;
  }
  const rewritten = structuredClone(problem);
  rewritten.content.basicStatement = result;
  return rewritten;
}

function readVerifiedAttachmentBytes(
  capability: HistoryAttachmentMappingCapability,
  target: {
    readonly locator: HistoryAttachmentSourceLocator;
    readonly contentSha256: string;
    readonly byteLength: number;
  },
): Uint8Array {
  const bytes = capability.readAttachmentBytes(target.locator);
  if (bytes.byteLength !== target.byteLength || sha256Hex(bytes) !== target.contentSha256) {
    throw new HistoryMigrationError(
      "SOURCE_DIGEST_MISMATCH",
      "附件固定源字节与已确认映射不一致。",
    );
  }
  return bytes;
}

/**
 * 原生导出在生成 ZIP 前就写好了覆盖导出文件的 checksums.sha256；追加附件后
 * 必须重新生成校验值文件，否则题目包无法按原生格式重新导入。
 */
function repackagedWithAttachmentChecksums(
  generatedFiles: readonly { readonly path: string; readonly content: Uint8Array }[],
  attachmentFiles: readonly { readonly path: string; readonly content: Uint8Array }[],
): Array<{ readonly path: string; readonly content: Uint8Array }> {
  const files = new Map<string, Uint8Array>();
  for (const file of [...generatedFiles, ...attachmentFiles]) {
    files.set(file.path, file.content);
  }
  files.delete(checksumFilePath);
  files.set(
    checksumFilePath,
    new TextEncoder().encode(renderChecksums(checksumsForFiles(files))),
  );
  return [...files.entries()].map(([path, content]) => ({ path, content }));
}

async function ensurePrivateSubdirectory(path: string): Promise<void> {
  try {
    await createNewPrivateDirectory(path);
  } catch (error) {
    if (error instanceof HistoryMigrationError && error.code === "OUTPUT_ALREADY_EXISTS") {
      await assertPrivateDirectoryMode(path);
      return;
    }
    throw error;
  }
}

async function writePreservedMaterialFile(
  privateRootDirectory: string,
  internalDirectory: string,
  preservationPath: string,
  content: Uint8Array,
): Promise<VerifiedPrivateOutputWriter> {
  const segments = preservationPath.split("/");
  if (
    segments.length === 0 ||
    segments.some((segment) => segment.length === 0 || segment === "." || segment === "..")
  ) {
    throw new HistoryMigrationError("OUTPUT_WRITE_FAILED", "内部保全路径不安全。");
  }
  let directory = internalDirectory;
  for (const segment of segments.slice(0, -1)) {
    directory = join(directory, segment);
    await ensurePrivateSubdirectory(directory);
  }
  const leafName = segments.at(-1) as string;
  // 写入后不立即关闭：调用方在最终复核 PASS 点与 PACKAGE_COMPLETE 之前一起
  // 复核保全文件，并让 close() 的目录身份核对在正常路径上生效。
  const writer = await openVerifiedPrivateOutputWriter(directory);
  await writer.writeNewFile(leafName, content);
  await writer.assertAllPublishedUnchanged();
  return writer;
}

async function loadConfirmedInputs(
  metadataFile: string,
  sourceConfirmationInput: unknown,
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
    sourceConfirmationInput,
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
