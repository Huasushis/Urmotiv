import { randomUUID } from "node:crypto";
import { lstat, mkdir, readdir, rm } from "node:fs/promises";
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
import { candidateContentDigest, sha256Hex, sourceBindingDigest, sourceMappingDigest } from "./digests";
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
  historyRepairManifestSchema,
  historySourceMappingSchema,
  historySourceIdSchema,
  normalizedHistoryOutputSchema,
  type HistoryCandidateRecord,
  type HistoryMetadataRecord,
  type HistoryRepairManifest,
  type HistorySourceMapping,
  type NormalizedHistoryOutput,
  type NormalizedHistoryProblem,
} from "./schema";

const digestSchema = z.string().regex(/^[0-9a-f]{64}$/);
const preparationFinalizationDirectories: Readonly<Record<string, true>> = {
  candidates: true,
  requests: true,
  reports: true,
};
const preparationFinalizationFiles: Readonly<Record<string, true>> = {
  "run.json": true,
  PREPARE_INCOMPLETE: true,
  PREPARE_RUN: true,
  PREPARE_COMPLETE: true,
  "review.json": true,
};

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
const preparationExecutorEvidenceSchema = z
  .object({
    executorIdentity: historyPreparationExecutionIdentitySchema.optional(),
    recoveryExecutorIdentity: historyPreparationExecutionIdentitySchema.optional(),
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
    ...preparationExecutorEvidenceSchema.shape,
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
    ...preparationExecutorEvidenceSchema.shape,
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
    ...preparationExecutorEvidenceSchema.shape,
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

/**
 * 传输层捕获的终止类别。只区分可在线/离线确定的终止原因：
 * - clean_eof：读取器正常结束，全部字节已收到。
 * - partial_eof：读取器提前结束（HTTP 连接中断），已收到部分字节。
 * - aborted：请求被 AbortController 或父信号明确取消。
 * - limit_exceeded：超过字节上限，只保留已收到的前缀。
 */
export type CapturedTransportTermination =
  | "clean_eof"
  | "partial_eof"
  | "aborted"
  | "limit_exceeded";

/**
 * 在线请求期间捕获的传输证据描述符。绑定到确切解析器版本、尝试编号、
 * HTTP 状态码、仅解析器相关头部（content-type/content-length）、媒体类型、
 * 精确捕获的响应体字节、字节计数、终止类别和已净化的失败类别。
 * 绝不包含正文内容之外的私有值；失败类别只来自固定枚举。
 * Stage A 不做文件系统持久化——只通过证据接收器传递不透明绑定。
 */
export interface CapturedTransport {
  readonly attempt: number;
  readonly parserVersion: string;
  readonly status: number;
  readonly contentType: string;
  readonly contentLength: string | null;
  readonly mediaKind: "event_stream" | "json" | "unknown";
  readonly body: Uint8Array;
  readonly byteCount: number;
  readonly termination: CapturedTransportTermination;
  readonly failureKind: HistoryNormalizationFailureKind | null;
}

/**
 * 证据接收器返回的不透明绑定描述符。core 持久化层（未来阶段）用它绑定
 * 传输证据到 prepare/repair 状态，不暴露正文。
 */
export interface EvidenceDescriptor {
  readonly descriptorDigest: string;
}

export interface HistoryNormalizerInput {
  readonly sourceId: string;
  readonly text: string;
  /** 传输层每次真正发请求前调用并等待，用于同步登记唯一请求身份。 */
  readonly beforeRequest?: (attempt: number) => Promise<void>;
  /**
   * 在线请求终端失败时调用的证据接收器。在净化后的 HistoryNormalizationError
   * 逃逸之前等待。接收器错误会取代原始终端失败，且不携带正文。成功时返回
   * 不透明绑定描述符，供未来 core 持久化层使用。Stage A 不做文件系统持久化。
   */
  readonly captureTransportEvidence?: (
    transport: CapturedTransport,
  ) => Promise<EvidenceDescriptor>;
}

export interface HistoryRecoveryNormalizer extends HistoryNormalizer {
  readonly preparationIdentity: HistoryPreparationExecutionIdentity;
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
type PreparationExecutorEvidence = z.infer<typeof preparationExecutorEvidenceSchema>;

function preparationExecutorIdentity(
  evidence: PreparationExecutorEvidence,
): HistoryPreparationExecutionIdentity | undefined {
  if (evidence.executorIdentity !== undefined && evidence.recoveryExecutorIdentity !== undefined) {
    throw new HistoryMigrationError(
      "PREPARE_RESUME_UNSAFE",
      "prepare 检查点同时声明了普通执行器和恢复执行器身份，不能继续。",
    );
  }
  return evidence.executorIdentity ?? evidence.recoveryExecutorIdentity;
}

function preparationExecutorIdentitySha256(
  evidence: PreparationExecutorEvidence,
): string | null {
  const identity = preparationExecutorIdentity(evidence);
  return identity === undefined ? null : sha256Hex(JSON.stringify(identity));
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
  /** 当前进程的执行身份；续跑时目标身份只从存储的 run.json 读取。 */
  readonly executorIdentity: HistoryPreparationExecutionIdentity;
  /** 只允许在同一输出目录、同一标签和同一存储目标运行下续跑。 */
  readonly resume?: boolean;
}

export interface FinalizeCompletedHistoryPreparationOptions {
  readonly privateRootDirectory: string;
  readonly materializedDirectory: string;
  readonly metadataFile: string;
  readonly preparedDirectory: string;
  readonly approvalFile: string;
}

export interface FinalizeCompletedHistoryPreparationResult {
  readonly sourceCount: number;
  readonly candidateCount: number;
  readonly approvedCandidateCount: number;
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

export interface VerifyApprovedPackageSourceIdentitiesOptions {
  readonly privateRootDirectory: string;
  readonly materializedDirectory: string;
  readonly metadataFile: string;
  readonly preparedDirectory: string;
  readonly approvalFile: string;
}

export interface AuthoritativePackageSourceIdentity {
  readonly candidateId: string;
  readonly contentSha256: string;
  readonly sourceBindingSha256: string;
  readonly problem: CanonicalProblem;
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

export interface RecoverActiveHistoryCandidateOptions {
  readonly privateRootDirectory: string;
  readonly sourceDirectory: string;
  readonly metadataFile: string;
  readonly sourceConfirmationFile: string;
  readonly outputDirectory: string;
  readonly sourceId: string;
  readonly normalizer: HistoryRecoveryNormalizer;
}

export interface RecoverActiveHistoryCandidateResult {
  readonly sourceId: string;
  readonly status: "completed" | "failed";
  readonly candidateCount: number;
  readonly requestAttemptCount: number;
  readonly failureKind?: HistoryNormalizationFailureKind;
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
  readonly mapping: HistorySourceMapping["mappings"][number];
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
  const parsedExecutorIdentity = historyPreparationExecutionIdentitySchema.safeParse(
    options.executorIdentity,
  );
  if (!parsedExecutorIdentity.success) {
    throw new HistoryMigrationError(
      "INVALID_ARGUMENTS",
      "prepare 的代码、提示词、模型或配置身份不完整。",
    );
  }
  const executorIdentity = parsedExecutorIdentity.data;
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
  let run: z.infer<typeof preparationRunSchema>;
  let targetExecutionIdentity: HistoryPreparationExecutionIdentity;
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
    const expectedRun = preparationRunSchema.parse({
      version: 2,
      phase: "prepare",
      operationTagSha256,
      inputBatchSha256,
      sourceCount: confirmedSources.length,
      executionIdentity: savedRun.executionIdentity,
    });
    const savedRunSha256 = sha256Hex(JSON.stringify(savedRun));
    if (savedRunSha256 !== sha256Hex(JSON.stringify(expectedRun))) {
      throw new HistoryMigrationError(
        "PREPARE_RESUME_UNSAFE",
        "prepare 的输入、运行标签或存储目标身份已经变化，不能续跑。",
      );
    }
    await assertPreparationRunMarkers(
      options.privateRootDirectory,
      options.outputDirectory,
      savedRunSha256,
    );
    run = savedRun;
    targetExecutionIdentity = savedRun.executionIdentity;
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
    targetExecutionIdentity = executorIdentity;
    run = preparationRunSchema.parse({
      version: 2,
      phase: "prepare",
      operationTagSha256,
      inputBatchSha256,
      sourceCount: confirmedSources.length,
      executionIdentity: targetExecutionIdentity,
    });
  }
  const runSha256 = sha256Hex(JSON.stringify(run));

  if (options.resume !== true) {
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

  const targetExecutionIdentitySha256 = sha256Hex(JSON.stringify(targetExecutionIdentity));
  const resumeExecutorEvidence: PreparationExecutorEvidence =
    options.resume === true ? { executorIdentity } : {};
  for (const [sourceIndex, source] of confirmedSources.entries()) {
    const existingState = await loadPreparationSourceState(
      options.privateRootDirectory,
      options.outputDirectory,
      source.sourceId,
      targetExecutionIdentitySha256,
      operationTagSha256,
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
        resumeExecutorEvidence,
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
      executionIdentitySha256: targetExecutionIdentitySha256,
      operationSha256: sha256Hex(
        JSON.stringify({ operationTagSha256, sourceId: source.sourceId, attempt: 1 }),
      ),
      ...resumeExecutorEvidence,
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
        const sourceBindingSha256 = sourceBindingDigest({
          sourceId: source.sourceId,
          sourceContentSha256: sourceContent.sha256,
          sourcePath: source.mapping.sourcePath,
          sourceSha256: source.mapping.sourceSha256,
          metadataNumber: source.mapping.metadataNumber,
        });
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
          sourceBindingSha256,
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
          ...resumeExecutorEvidence,
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
        resumeExecutorEvidence,
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
    targetExecutionIdentitySha256,
    operationTagSha256,
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

/**
 * 只读重算既有完成检查点并发布 prepare 收尾文件。此入口没有 normalizer，
 * 不创建请求登记，也不删除或移动 PREPARE_INCOMPLETE 与逐请求历史证据。
 */
export async function finalizeCompletedHistoryPreparation(
  options: FinalizeCompletedHistoryPreparationOptions,
): Promise<FinalizeCompletedHistoryPreparationResult> {
  await assertPathsInsidePrivateRoot(options.privateRootDirectory, [
    { path: options.materializedDirectory, kind: "existing" },
    { path: options.metadataFile, kind: "existing" },
    { path: options.preparedDirectory, kind: "existing" },
    { path: options.approvalFile, kind: "existing" },
  ]);
  await Promise.all([
    assertPrivateFileMode(options.metadataFile),
    assertPrivateFileMode(options.approvalFile),
  ]);
  const materialization = await assertHistoryMaterializationComplete({
    privateRootDirectory: options.privateRootDirectory,
    materializedDirectory: options.materializedDirectory,
  });
  try {
    const { confirmedSources } = await loadConfirmedInputs(
      options.metadataFile,
      await materialization.readSourceConfirmation(),
    );
    const preparedInventory = await inspectPreparationFinalizationTree(
      options.preparedDirectory,
      new Set(confirmedSources.map((source) => source.sourceId)),
    );
    const run = preparationRunSchema.parse(
      await readPrivateJson(join(options.preparedDirectory, "run.json")),
    );
    const inputBatchSha256 = sha256Hex(
      JSON.stringify(
        confirmedSources.map((source) => ({
          sourceId: source.sourceId,
          sourceContentSha256: source.mapping.sourceSha256,
          sourceMappingSha256: source.sourceMappingSha256,
        })),
      ),
    );
    const expectedRun = preparationRunSchema.parse({
      version: 2,
      phase: "prepare",
      operationTagSha256: run.operationTagSha256,
      inputBatchSha256,
      sourceCount: confirmedSources.length,
      executionIdentity: run.executionIdentity,
    });
    const runSha256 = sha256Hex(JSON.stringify(run));
    if (runSha256 !== sha256Hex(JSON.stringify(expectedRun))) {
      throw new HistoryMigrationError(
        "PREPARE_RESUME_UNSAFE",
        "离线收尾的存储运行、输入或目标执行身份不一致。",
      );
    }
    await assertPreparationRunMarkers(
      options.privateRootDirectory,
      options.preparedDirectory,
      runSha256,
    );
    const summary = await summarizePreparation(
      options.privateRootDirectory,
      options.preparedDirectory,
      confirmedSources,
      sha256Hex(JSON.stringify(run.executionIdentity)),
      run.operationTagSha256,
    );
    if (!summary.complete) {
      throw new HistoryMigrationError(
        "PREPARE_RESUME_UNSAFE",
        "离线收尾要求全部源已有完整且可核对的完成检查点。",
      );
    }
    const expectedCandidateFiles = new Set(
      summary.report.map((candidate) => `${candidate.candidateId}.json`),
    );
    if (
      expectedCandidateFiles.size !== summary.report.length ||
      preparedInventory.candidateFiles.size !== expectedCandidateFiles.size ||
      [...expectedCandidateFiles].some((name) => !preparedInventory.candidateFiles.has(name))
    ) {
      throw new HistoryMigrationError(
        "PREPARE_RESUME_UNSAFE",
        "离线收尾的候选文件集合与完成检查点不一致。",
      );
    }
    const approvedCandidates = await loadApprovedCandidatesForSources(
      options,
      materialization,
      confirmedSources,
    );
    const approvedById = new Map(
      approvedCandidates.map(({ record }) => [record.candidateId, record.contentSha256]),
    );
    if (
      approvedCandidates.length !== summary.report.length ||
      summary.report.some(
        (candidate) => approvedById.get(candidate.candidateId) !== candidate.contentSha256,
      )
    ) {
      throw new HistoryMigrationError(
        "INVALID_CANDIDATE_APPROVAL",
        "离线收尾要求当前全部完成候选都有逐项匹配的人工批准。",
      );
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
    const review = {
      version: 2,
      phase: "prepare",
      batchSha256,
      runSha256,
      sourceCount: confirmedSources.length,
      candidateCount: summary.report.length,
      candidates: summary.report,
    };
    const complete = {
      version: 2,
      phase: "prepare",
      batchSha256,
      candidateCount: summary.report.length,
      sourceCount: confirmedSources.length,
      runSha256,
    };
    await assertPreparationJsonAbsentOrEqual(
      options.privateRootDirectory,
      join(options.preparedDirectory, "review.json"),
      review,
    );
    await assertPreparationJsonAbsentOrEqual(
      options.privateRootDirectory,
      join(options.preparedDirectory, "PREPARE_COMPLETE"),
      complete,
    );
    await materialization.assertUnchangedBeforePublish();
    await writeOrValidatePreparationJson(
      options.privateRootDirectory,
      join(options.preparedDirectory, "review.json"),
      review,
    );
    await writeOrValidatePreparationJson(
      options.privateRootDirectory,
      join(options.preparedDirectory, "PREPARE_COMPLETE"),
      complete,
    );
    return {
      sourceCount: confirmedSources.length,
      candidateCount: summary.report.length,
      approvedCandidateCount: approvedCandidates.length,
    };
  } finally {
    await materialization.close();
  }
}

export async function recoverActiveHistoryCandidate(
  options: RecoverActiveHistoryCandidateOptions,
): Promise<RecoverActiveHistoryCandidateResult> {
  const parsedSourceId = historySourceIdSchema.safeParse(options.sourceId);
  if (!parsedSourceId.success) {
    throw new HistoryMigrationError("INVALID_ARGUMENTS", "recover-active 的源编号格式不正确。");
  }
  const parsedRecoveryExecutorIdentity = historyPreparationExecutionIdentitySchema.safeParse(
    options.normalizer.preparationIdentity,
  );
  if (!parsedRecoveryExecutorIdentity.success) {
    throw new HistoryMigrationError(
      "INVALID_ARGUMENTS",
      "recover-active 的恢复执行器身份不完整。",
    );
  }
  const recoveryExecutorIdentity = parsedRecoveryExecutorIdentity.data;
  await assertPathsInsidePrivateRoot(options.privateRootDirectory, [
    { path: options.sourceDirectory, kind: "existing" },
    { path: options.metadataFile, kind: "existing" },
    { path: options.sourceConfirmationFile, kind: "existing" },
    { path: options.outputDirectory, kind: "existing" },
  ]);

  const { confirmedSources } = await loadConfirmedInputs(
    options.metadataFile,
    await readPrivateJson(options.sourceConfirmationFile),
  );
  const sourceIndex = confirmedSources.findIndex(
    (source) => source.sourceId === parsedSourceId.data,
  );
  if (sourceIndex < 0) {
    throw new HistoryMigrationError("INVALID_ARGUMENTS", "recover-active 的源编号不存在。");
  }
  const source = confirmedSources[sourceIndex];
  if (source === undefined) {
    throw new HistoryMigrationError("INVALID_ARGUMENTS", "recover-active 的源编号不存在。");
  }
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
      "recover-active 找不到可验证的 prepare 运行检查点。",
    );
  }
  const inputBatchSha256 = sha256Hex(
    JSON.stringify(
      confirmedSources.map((confirmedSource) => ({
        sourceId: confirmedSource.sourceId,
        sourceContentSha256: confirmedSource.mapping.sourceSha256,
        sourceMappingSha256: confirmedSource.sourceMappingSha256,
      })),
    ),
  );
  const expectedRun = preparationRunSchema.parse({
    version: 2,
    phase: "prepare",
    operationTagSha256: savedRun.operationTagSha256,
    inputBatchSha256,
    sourceCount: confirmedSources.length,
    executionIdentity: savedRun.executionIdentity,
  });
  if (sha256Hex(JSON.stringify(savedRun)) !== sha256Hex(JSON.stringify(expectedRun))) {
    throw new HistoryMigrationError(
      "PREPARE_RESUME_UNSAFE",
      "recover-active 的存储运行、输入或目标执行身份已经变化。",
    );
  }

  const targetExecutionIdentitySha256 = sha256Hex(
    JSON.stringify(savedRun.executionIdentity),
  );
  let state: Awaited<ReturnType<typeof loadPreparationSourceState>>;
  try {
    state = await loadPreparationSourceState(
      options.privateRootDirectory,
      options.outputDirectory,
      source.sourceId,
      targetExecutionIdentitySha256,
      savedRun.operationTagSha256,
    );
  } catch (error) {
    if (error instanceof HistoryMigrationError && error.code === "PREPARE_RESUME_UNSAFE") {
      throw new HistoryMigrationError(
        "RECOVERY_REJECTED",
        "recover-active 的现有请求或终态登记不一致。",
      );
    }
    throw error;
  }
  if (state === "pending") {
    throw new HistoryMigrationError(
      "RECOVERY_PENDING",
      "recover-active 只接受仍有 active 请求登记的源。",
    );
  }
  if (state.kind === "completed") {
    throw new HistoryMigrationError(
      "RECOVERY_REJECTED",
      "recover-active 拒绝已完成、歧义或不具备完整 active 前缀的源。",
    );
  }
  const failedPrefixActive = await loadRecoverableFailedActiveState(
    options.privateRootDirectory,
    options.outputDirectory,
    source.sourceId,
  );
  const active =
    failedPrefixActive ?? (state.kind === "active" ? state.record : null);
  if (active === null) {
    throw new HistoryMigrationError(
      "RECOVERY_REJECTED",
      "recover-active 拒绝已完成、歧义或不具备完整 active 前缀的源。",
    );
  }
  const requestDirectory = join(options.outputDirectory, "requests");
  const activeSha256 = sha256Hex(JSON.stringify(active));
  const expectedOperationSha256 = sha256Hex(
    JSON.stringify({
      operationTagSha256: savedRun.operationTagSha256,
      sourceId: source.sourceId,
      attempt: 1,
    }),
  );
  if (
    active.executionIdentitySha256 !== targetExecutionIdentitySha256 ||
    active.operationSha256 !== expectedOperationSha256
  ) {
    throw new HistoryMigrationError(
      "PREPARE_RESUME_UNSAFE",
      "recover-active 的 active 执行或操作身份不一致。",
    );
  }

  let sourceContent: { readonly text: string; readonly sha256: string };
  try {
    sourceContent = await readConfirmedSource(
      options.sourceDirectory,
      source.mapping.sourcePath,
      source.mapping.sourceSha256,
      source.sourceId,
    );
  } catch {
    throw new HistoryMigrationError(
      "PREPARE_RESUME_UNSAFE",
      "recover-active 的源内容摘要或映射已经变化。",
    );
  }
  const expectedSourceIdentitySha256 = sha256Hex(
    JSON.stringify({
      sourceId: source.sourceId,
      sourceContentSha256: sourceContent.sha256,
      sourceMappingSha256: source.sourceMappingSha256,
    }),
  );
  if (active.sourceIdentitySha256 !== expectedSourceIdentitySha256) {
    throw new HistoryMigrationError(
      "PREPARE_RESUME_UNSAFE",
      "recover-active 的 active 源身份摘要不一致。",
    );
  }
  if (active.recoveryExecutorIdentity !== undefined) {
    throw new HistoryMigrationError(
      "RECOVERY_REJECTED",
      "recover-active 拒绝已经使用恢复执行器身份的 active 请求。",
    );
  }
  const activeTarget = { ...active, executorIdentity: undefined };
  const attemptHistory = await loadAppendedPreparationAttemptHistory(
    options.privateRootDirectory,
    options.outputDirectory,
    source.sourceId,
    active,
    targetExecutionIdentitySha256,
    savedRun.operationTagSha256,
  );
  const operationAttempt = attemptHistory.requestAttemptSha256s.length + 1;
  if (operationAttempt > 10) {
    throw new HistoryMigrationError(
      "RECOVERY_REJECTED",
      "recover-active 的请求登记已达到有界尝试上限。",
    );
  }
  const retryActive = preparationActiveSchema.parse({
    ...activeTarget,
    operationSha256: sha256Hex(
      JSON.stringify({
        operationTagSha256: savedRun.operationTagSha256,
        sourceId: source.sourceId,
        attempt: operationAttempt,
      }),
    ),
    recoveryExecutorIdentity,
  });
  await writeNewPrivateJson(
    join(
      requestDirectory,
      `${source.sourceId}.attempt-${String(operationAttempt).padStart(2, "0")}.active.json`,
    ),
    retryActive,
  );
  const requestAttemptSha256s = [
    ...attemptHistory.requestAttemptSha256s,
    sha256Hex(JSON.stringify(retryActive)),
  ];
  const candidates: Array<{ readonly candidateId: string; readonly contentSha256: string }> = [];

  try {
    const normalized = normalizedHistoryOutputSchema.parse(
      await options.normalizer.normalize({
        sourceId: source.sourceId,
        text: sourceContent.text,
        beforeRequest: async (attempt) => {
          if (attempt < 2) return;
          const retryOperationAttempt = requestAttemptSha256s.length + 1;
          if (retryOperationAttempt > 10) {
            throw new HistoryMigrationError(
              "RECOVERY_REJECTED",
              "recover-active 的请求登记已达到有界尝试上限。",
            );
          }
          const retry = preparationActiveSchema.parse({
            ...activeTarget,
            operationSha256: sha256Hex(
              JSON.stringify({
                operationTagSha256: savedRun.operationTagSha256,
                sourceId: source.sourceId,
                attempt: retryOperationAttempt,
              }),
            ),
            recoveryExecutorIdentity,
          });
          await writeNewPrivateJson(
            join(
              requestDirectory,
              `${source.sourceId}.attempt-${String(retryOperationAttempt).padStart(2, "0")}.active.json`,
            ),
            retry,
          );
          requestAttemptSha256s.push(sha256Hex(JSON.stringify(retry)));
        },
      }),
    );
    for (const [problemIndex, normalizedProblem] of normalized.problems.entries()) {
      const candidateId = makeSafeId("candidate", sourceIndex * 30 + problemIndex + 1);
      const problem = toCandidateProblem(normalizedProblem);
      assertPrivateIdentifiersNotPresent(
        { problem, normalizationNote: normalizedProblem.migrationNote },
        source.metadata.authorStudentId,
        source.mapping.sourcePath,
      );
      const sourceBindingSha256 = sourceBindingDigest({
        sourceId: source.sourceId,
        sourceContentSha256: sourceContent.sha256,
        sourcePath: source.mapping.sourcePath,
        sourceSha256: source.mapping.sourceSha256,
        metadataNumber: source.mapping.metadataNumber,
      });
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
        sourceBindingSha256,
        contentSha256,
        modelConfidence: normalizedProblem.confidence,
        normalizationNote: normalizedProblem.migrationNote,
        problem,
      });
      await writeNewPrivateJson(
        join(options.outputDirectory, "candidates", `${candidateId}.json`),
        candidate,
      );
      candidates.push({ candidateId, contentSha256 });
    }
    await writeNewPrivateJson(
      preparationStatePath(options.outputDirectory, source.sourceId, "completed"),
      preparationCompletedSchema.parse({
        version: 1,
        status: "completed",
        sourceId: source.sourceId,
        activeSha256,
        requestAttemptSha256s,
        candidates,
        recoveryExecutorIdentity,
      }),
    );
    return {
      sourceId: source.sourceId,
      status: "completed",
      candidateCount: candidates.length,
      requestAttemptCount: requestAttemptSha256s.length,
    };
  } catch (error) {
    const failureKind = classifyPreparationFailure(error);
    await writePreparationFailure(
      options.privateRootDirectory,
      options.outputDirectory,
      source.sourceId,
      activeSha256,
      requestAttemptSha256s,
      failureKind,
      { recoveryExecutorIdentity },
      failedPrefixActive === null ? undefined : requestAttemptSha256s.length,
    );
    return {
      sourceId: source.sourceId,
      status: "failed",
      candidateCount: candidates.length,
      requestAttemptCount: requestAttemptSha256s.length,
      failureKind,
    };
  }
}

type PreparationSourceState =
  | "pending"
  | { readonly kind: "active"; readonly record: z.infer<typeof preparationActiveSchema> }
  | { readonly kind: "failed"; readonly record: z.infer<typeof preparationFailureSchema> }
  | {
      readonly kind: "completed";
      readonly record: z.infer<typeof preparationCompletedSchema>;
    };
function preparationFailureMatchesActivePrefix(
  failed: z.infer<typeof preparationFailureSchema>,
  active: z.infer<typeof preparationActiveSchema>,
): boolean {
  const activeSha256 = sha256Hex(JSON.stringify(active));
  return (
    failed.activeSha256 === activeSha256 &&
    failed.requestAttemptSha256s.length === 1 &&
    failed.requestAttemptSha256s[0] === activeSha256
  );
}

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
  targetExecutionIdentitySha256?: string,
  operationTagSha256?: string,
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
    const failedPrefix =
      failed !== null &&
      active !== null &&
      preparationFailureMatchesActivePrefix(failed, active);
    if (
      active === null ||
      (failed !== null && !failedPrefix) ||
      completed.activeSha256 !== sha256Hex(JSON.stringify(active))
    ) {
      throw new HistoryMigrationError(
        "PREPARE_RESUME_UNSAFE",
        "prepare 完成检查点与请求登记不一致，不能继续。",
      );
    }
    const attempts = await assertPreparationAttemptChain(
      privateRootDirectory,
      outputDirectory,
      sourceId,
      completed.requestAttemptSha256s,
      targetExecutionIdentitySha256,
    );
    const appendedHistory = await loadAppendedPreparationAttemptHistory(
      privateRootDirectory,
      outputDirectory,
      sourceId,
      active,
      targetExecutionIdentitySha256,
      operationTagSha256,
    );
    if (
      completed.requestAttemptSha256s.length !==
        appendedHistory.requestAttemptSha256s.length ||
      completed.requestAttemptSha256s.some(
        (digest, index) => digest !== appendedHistory.requestAttemptSha256s[index],
      )
    ) {
      throw new HistoryMigrationError(
        "PREPARE_RESUME_UNSAFE",
        "prepare 完成检查点没有绑定全部编号请求登记。",
      );
    }
    if (failed !== null) {
      const failedAttempts = await assertPreparationAttemptChain(
        privateRootDirectory,
        outputDirectory,
        sourceId,
        failed.requestAttemptSha256s,
        targetExecutionIdentitySha256,
      );
      assertPreparationTerminalExecutorEvidence(failed, failedAttempts);
    }
    assertPreparationTerminalExecutorEvidence(completed, attempts);
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
    const attempts = await assertPreparationAttemptChain(
      privateRootDirectory,
      outputDirectory,
      sourceId,
      failed.requestAttemptSha256s,
      targetExecutionIdentitySha256,
    );
    assertPreparationTerminalExecutorEvidence(failed, attempts);
    if (active !== null && preparationFailureMatchesActivePrefix(failed, active)) {
      const appendedHistory = await loadAppendedPreparationAttemptHistory(
        privateRootDirectory,
        outputDirectory,
        sourceId,
        active,
        targetExecutionIdentitySha256,
        operationTagSha256,
      );
      if (appendedHistory.records.length > 0) {
        const latestAttempt = appendedHistory.records.length + 1;
        const latestFailure = appendedHistory.terminalFailures.find(
          ({ attempt }) => attempt === latestAttempt,
        );
        return latestFailure === undefined
          ? { kind: "active", record: active }
          : { kind: "failed", record: latestFailure.record };
      }
    }
    return { kind: "failed", record: failed };
  }
  if (active !== null) {
    assertPreparationActiveRecord(active, targetExecutionIdentitySha256);
    const appendedHistory = await loadAppendedPreparationAttemptHistory(
      privateRootDirectory,
      outputDirectory,
      sourceId,
      active,
      targetExecutionIdentitySha256,
      operationTagSha256,
    );
    if (appendedHistory.records.length > 0) {
      const latestAttempt = appendedHistory.records.length + 1;
      const latestFailure = appendedHistory.terminalFailures.find(
        ({ attempt }) => attempt === latestAttempt,
      );
      if (latestFailure !== undefined) {
        return { kind: "failed", record: latestFailure.record };
      }
    }
  }
  return active === null ? "pending" : { kind: "active", record: active };
}
async function loadRecoverableFailedActiveState(
  privateRootDirectory: string,
  outputDirectory: string,
  sourceId: string,
): Promise<z.infer<typeof preparationActiveSchema> | null> {
  const active = await readOptionalPreparationRecord(
    privateRootDirectory,
    preparationStatePath(outputDirectory, sourceId, "active"),
    preparationActiveSchema,
  );
  const failed = await readOptionalPreparationRecord(
    privateRootDirectory,
    preparationStatePath(outputDirectory, sourceId, "failed"),
    preparationFailureSchema,
  );
  if (active === null || failed === null) return null;
  if (!preparationFailureMatchesActivePrefix(failed, active)) {
    if (failed.requestAttemptSha256s.length !== 1) return null;
    throw new HistoryMigrationError(
      "PREPARE_RESUME_UNSAFE",
      "recover-active 的失败回执不是原 active 请求的完整前缀。",
    );
  }
  const attempts = await assertPreparationAttemptChain(
    privateRootDirectory,
    outputDirectory,
    sourceId,
    failed.requestAttemptSha256s,
  );
  assertPreparationTerminalExecutorEvidence(failed, attempts);
  return active;
}
interface AppendedPreparationAttemptHistory {
  readonly records: readonly PreparationActiveRecord[];
  readonly requestAttemptSha256s: readonly string[];
  readonly terminalFailures: readonly {
    readonly attempt: number;
    readonly record: z.infer<typeof preparationFailureSchema>;
  }[];
}

async function loadAppendedPreparationAttemptHistory(
  privateRootDirectory: string,
  outputDirectory: string,
  sourceId: string,
  active: PreparationActiveRecord,
  targetExecutionIdentitySha256?: string,
  operationTagSha256?: string,
): Promise<AppendedPreparationAttemptHistory> {
  const requestDirectory = join(outputDirectory, "requests");
  const prefix = `${sourceId}.attempt-`;
  const names = (await readdir(requestDirectory)).filter((name) => name.startsWith(prefix));
  const parsedNames = names.map((name) => {
    const match = name.match(
      new RegExp(`^${sourceId}\\.attempt-([0-9]{2})\\.(active|failed)\\.json$`, "u"),
    );
    if (match === null) {
      throw new HistoryMigrationError(
        "PREPARE_RESUME_UNSAFE",
        "prepare 的编号请求或终态回执名称不明确，不能继续。",
      );
    }
    return {
      name,
      attempt: Number(match[1]),
      state: match[2] as "active" | "failed",
    };
  });
  const activeNames = parsedNames
    .filter(({ state }) => state === "active")
    .sort((left, right) => left.attempt - right.attempt);
  if (
    activeNames.length > 9 ||
    activeNames.some(({ attempt }, index) => attempt !== index + 2)
  ) {
    throw new HistoryMigrationError(
      "PREPARE_RESUME_UNSAFE",
      "prepare 的编号请求登记不连续或超过有界上限。",
    );
  }
  const records: PreparationActiveRecord[] = [];
  for (const { attempt, name } of activeNames) {
    const record = await readOptionalPreparationRecord(
      privateRootDirectory,
      join(requestDirectory, name),
      preparationActiveSchema,
    );
    if (record === null || record.sourceId !== sourceId) {
      throw new HistoryMigrationError(
        "PREPARE_RESUME_UNSAFE",
        "prepare 的编号请求登记与安全编号不一致。",
      );
    }
    assertPreparationActiveRecord(record, targetExecutionIdentitySha256);
    if (
      operationTagSha256 !== undefined &&
      record.operationSha256 !==
        sha256Hex(JSON.stringify({ operationTagSha256, sourceId, attempt }))
    ) {
      throw new HistoryMigrationError(
        "PREPARE_RESUME_UNSAFE",
        "prepare 的编号请求登记没有绑定存储的操作身份。",
      );
    }
    records.push(record);
  }
  const requestAttemptSha256s = [
    sha256Hex(JSON.stringify(active)),
    ...records.map((record) => sha256Hex(JSON.stringify(record))),
  ];
  const failedNames = parsedNames
    .filter(({ state }) => state === "failed")
    .sort((left, right) => left.attempt - right.attempt);
  const terminalFailures: Array<{
    readonly attempt: number;
    readonly record: z.infer<typeof preparationFailureSchema>;
  }> = [];
  for (const { attempt, name } of failedNames) {
    const failed = await readOptionalPreparationRecord(
      privateRootDirectory,
      join(requestDirectory, name),
      preparationFailureSchema,
    );
    const expectedAttemptSha256s = requestAttemptSha256s.slice(0, attempt);
    if (
      failed === null ||
      failed.sourceId !== sourceId ||
      attempt < 2 ||
      attempt > records.length + 1 ||
      failed.activeSha256 !== requestAttemptSha256s[0] ||
      failed.requestAttemptSha256s.length !== expectedAttemptSha256s.length ||
      failed.requestAttemptSha256s.some(
        (digest, index) => digest !== expectedAttemptSha256s[index],
      )
    ) {
      throw new HistoryMigrationError(
        "PREPARE_RESUME_UNSAFE",
        "prepare 的编号失败回执没有绑定完整请求前缀。",
      );
    }
    assertPreparationTerminalExecutorEvidence(failed, [
      active,
      ...records.slice(0, attempt - 1),
    ]);
    terminalFailures.push({ attempt, record: failed });
  }
  return { records, requestAttemptSha256s, terminalFailures };
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

/**
 * 受控修复专属的收敛步骤：当同一源同时存在完成检查点与失败回执、且完成检查点
 * 的请求登记链自洽（completed.activeSha256 与 active.json 一致）时，该失败回执
 * 已被更晚的完成检查点取代，删除它以让 loadPreparationSourceState 的成功分支
 * 成立。这是修复"先写 completed 后删 failed"的崩溃窗口自愈机制；任何不一致
 * （active 缺失或链不匹配）都保持原样，交由后续校验失败关闭。仅对受控清单源
 * 调用；prepare 自身的成功路径不会产生该共存态。
 */
async function removeSupersededFailureReceipt(
  privateRootDirectory: string,
  outputDirectory: string,
  sourceId: string,
): Promise<void> {
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
  if (completed === null || failed === null || active === null) {
    return;
  }
  if (completed.activeSha256 !== sha256Hex(JSON.stringify(active))) {
    return;
  }
  await rm(preparationStatePath(outputDirectory, sourceId, "failed"), { force: true });
}

type PreparationActiveRecord = z.infer<typeof preparationActiveSchema>;

function assertPreparationActiveRecord(
  record: PreparationActiveRecord,
  targetExecutionIdentitySha256?: string,
): void {
  preparationExecutorIdentity(record);
  if (
    targetExecutionIdentitySha256 !== undefined &&
    record.executionIdentitySha256 !== targetExecutionIdentitySha256
  ) {
    throw new HistoryMigrationError(
      "PREPARE_RESUME_UNSAFE",
      "prepare 请求登记没有绑定存储的目标执行身份，不能继续。",
    );
  }
}

function assertPreparationTerminalExecutorEvidence(
  receipt: PreparationExecutorEvidence,
  attempts: readonly PreparationActiveRecord[],
): void {
  const receiptExecutorSha256 = preparationExecutorIdentitySha256(receipt);
  if (receiptExecutorSha256 === null || attempts.length === 0) return;
  const latestAttempt = attempts[attempts.length - 1];
  if (latestAttempt === undefined) return;
  const latestExecutorSha256 = preparationExecutorIdentitySha256(latestAttempt);
  if (latestExecutorSha256 === null || latestExecutorSha256 !== receiptExecutorSha256) {
    throw new HistoryMigrationError(
      "PREPARE_RESUME_UNSAFE",
      "prepare 终态回执的执行器身份与最后一次请求登记不一致。",
    );
  }
}

async function assertPreparationAttemptChain(
  privateRootDirectory: string,
  outputDirectory: string,
  sourceId: string,
  expectedSha256s: readonly string[],
  targetExecutionIdentitySha256?: string,
): Promise<readonly PreparationActiveRecord[]> {
  const records: PreparationActiveRecord[] = [];
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
    assertPreparationActiveRecord(record, targetExecutionIdentitySha256);
    records.push(record);
  }
  return records;
}

async function writePreparationFailure(
  privateRootDirectory: string,
  outputDirectory: string,
  sourceId: string,
  activeSha256: string | null,
  requestAttemptSha256s: readonly string[],
  failureKind: HistoryNormalizationFailureKind,
  executorEvidence: PreparationExecutorEvidence = {},
  attemptNumber?: number,
): Promise<void> {
  const requestDirectory = join(outputDirectory, "requests");
  await assertPathsInsidePrivateRoot(privateRootDirectory, [
    { path: requestDirectory, kind: "existing" },
  ]);
  if (
    attemptNumber !== undefined &&
    (attemptNumber < 2 ||
      attemptNumber > 10 ||
      attemptNumber !== requestAttemptSha256s.length)
  ) {
    throw new HistoryMigrationError(
      "PREPARE_RESUME_UNSAFE",
      "prepare 的编号失败回执没有绑定最后一次请求。",
    );
  }
  const parsedExecutorEvidence = preparationExecutorEvidenceSchema.parse(executorEvidence);
  preparationExecutorIdentity(parsedExecutorEvidence);
  const path =
    attemptNumber === undefined
      ? preparationStatePath(outputDirectory, sourceId, "failed")
      : join(
          requestDirectory,
          `${sourceId}.attempt-${String(attemptNumber).padStart(2, "0")}.failed.json`,
        );
  await writeNewPrivateJson(
    path,
    preparationFailureSchema.parse({
      version: 1,
      status: "failed",
      sourceId,
      activeSha256,
      requestAttemptSha256s,
      failureKind,
      ...parsedExecutorEvidence,
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
async function assertPreparationRunMarkers(
  privateRootDirectory: string,
  outputDirectory: string,
  expectedRunSha256: string,
): Promise<void> {
  const markerSchema = z.object({ runSha256: digestSchema }).passthrough();
  for (const name of ["PREPARE_INCOMPLETE", "PREPARE_RUN", "PREPARE_COMPLETE", "review.json"]) {
    const path = join(outputDirectory, name);
    try {
      await lstat(path);
    } catch (error) {
      if (hasNodeErrorCode(error, "ENOENT")) continue;
      throw new HistoryMigrationError("PREPARE_RESUME_UNSAFE", "prepare 运行标记无法安全检查。");
    }
    try {
      await assertPathsInsidePrivateRoot(privateRootDirectory, [{ path, kind: "existing" }]);
      await assertPrivateFileMode(path);
      const parsed = markerSchema.safeParse(await readPrivateJson(path));
      if (!parsed.success || parsed.data.runSha256 !== expectedRunSha256) {
        throw new HistoryMigrationError(
          "PREPARE_RESUME_UNSAFE",
          "prepare 运行标记与存储的目标运行摘要不一致，不能继续。",
        );
      }
    } catch (error) {
      if (error instanceof HistoryMigrationError) throw error;
      throw new HistoryMigrationError("PREPARE_RESUME_UNSAFE", "prepare 运行标记无法安全验证。");
    }
  }
}

async function inspectPreparationFinalizationTree(
  preparedDirectory: string,
  expectedSourceIds: ReadonlySet<string>,
): Promise<{ readonly candidateFiles: ReadonlySet<string> }> {
  await assertPrivateDirectoryMode(preparedDirectory);
  const topLevelEntries = await readdir(preparedDirectory, { withFileTypes: true });
  const expectedDirectoryNames = Object.keys(preparationFinalizationDirectories);
  const foundDirectories = new Set<string>();
  const foundFiles = new Set<string>();
  for (const entry of topLevelEntries) {
    const path = join(preparedDirectory, entry.name);
    if (entry.isSymbolicLink()) {
      throw new HistoryMigrationError(
        "PREPARE_RESUME_UNSAFE",
        "离线收尾拒绝 prepare 目录中的符号链接。",
      );
    }
    if (preparationFinalizationDirectories[entry.name] === true && entry.isDirectory()) {
      foundDirectories.add(entry.name);
      continue;
    }
    if (preparationFinalizationFiles[entry.name] === true && entry.isFile()) {
      await assertPrivateFileMode(path);
      foundFiles.add(entry.name);
      continue;
    }
    throw new HistoryMigrationError(
      "PREPARE_RESUME_UNSAFE",
      "离线收尾发现未登记或类型不正确的 prepare 输出。",
    );
  }
  if (
    foundDirectories.size !== expectedDirectoryNames.length ||
    expectedDirectoryNames.some((name) => !foundDirectories.has(name)) ||
    !foundFiles.has("run.json") ||
    Number(foundFiles.has("PREPARE_INCOMPLETE")) + Number(foundFiles.has("PREPARE_RUN")) !== 1 ||
    (foundFiles.has("PREPARE_COMPLETE") && !foundFiles.has("review.json"))
  ) {
    throw new HistoryMigrationError(
      "PREPARE_RESUME_UNSAFE",
      "离线收尾的 prepare 目录或历史状态标记不完整。",
    );
  }

  const candidateFiles = new Set<string>();
  const candidateDirectory = join(preparedDirectory, "candidates");
  await assertPrivateDirectoryMode(candidateDirectory);
  for (const entry of await readdir(candidateDirectory, { withFileTypes: true })) {
    if (
      entry.isSymbolicLink() ||
      !entry.isFile() ||
      !/^candidate-[0-9]{6}\.json$/u.test(entry.name)
    ) {
      throw new HistoryMigrationError(
        "PREPARE_RESUME_UNSAFE",
        "离线收尾发现未登记或类型不正确的候选输出。",
      );
    }
    await assertPrivateFileMode(join(candidateDirectory, entry.name));
    candidateFiles.add(entry.name);
  }

  const requestDirectory = join(preparedDirectory, "requests");
  await assertPrivateDirectoryMode(requestDirectory);
  for (const entry of await readdir(requestDirectory, { withFileTypes: true })) {
    if (entry.isSymbolicLink() || !entry.isFile()) {
      throw new HistoryMigrationError(
        "PREPARE_RESUME_UNSAFE",
        "离线收尾拒绝请求目录中的链接或非普通文件。",
      );
    }
    const base = /^(source-[0-9]{6})\.(active|completed|failed)\.json$/u.exec(entry.name);
    const appended = /^(source-[0-9]{6})\.attempt-(0[2-9]|10)\.(active|failed)\.json$/u.exec(
      entry.name,
    );
    const sourceId = base?.[1] ?? appended?.[1];
    if (sourceId === undefined || !expectedSourceIds.has(sourceId)) {
      throw new HistoryMigrationError(
        "PREPARE_RESUME_UNSAFE",
        "离线收尾发现未登记来源或名称不正确的请求证据。",
      );
    }
    await assertPrivateFileMode(join(requestDirectory, entry.name));
  }

  const reportDirectory = join(preparedDirectory, "reports");
  await assertPrivateDirectoryMode(reportDirectory);
  for (const entry of await readdir(reportDirectory, { withFileTypes: true })) {
    if (
      entry.isSymbolicLink() ||
      !entry.isFile() ||
      !/^attempt-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.json$/u.test(
        entry.name,
      )
    ) {
      throw new HistoryMigrationError(
        "PREPARE_RESUME_UNSAFE",
        "离线收尾发现未登记或类型不正确的运行报告。",
      );
    }
    await assertPrivateFileMode(join(reportDirectory, entry.name));
  }
  return { candidateFiles };
}

async function summarizePreparation(
  privateRootDirectory: string,
  outputDirectory: string,
  confirmedSources: readonly ConfirmedSource[],
  targetExecutionIdentitySha256?: string,
  operationTagSha256?: string,
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
      targetExecutionIdentitySha256,
      operationTagSha256,
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
        basicSolutionLength: candidate.problem.content.basicSolution === null ? 0 : candidate.problem.content.basicSolution.length,
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

async function assertPreparationJsonAbsentOrEqual(
  privateRootDirectory: string,
  path: string,
  value: unknown,
): Promise<void> {
  await assertPathsInsidePrivateRoot(privateRootDirectory, [
    { path: dirname(path), kind: "existing" },
  ]);
  try {
    await lstat(path);
  } catch (error) {
    if (hasNodeErrorCode(error, "ENOENT")) return;
    throw new HistoryMigrationError("PREPARE_RESUME_UNSAFE", "prepare 收尾文件无法安全检查。");
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

/**
 * 受控修复的写输出：文件不存在则新建；已存在且内容与本次确定性结果完全
 * 一致则视为已满足（幂等重跑/崩溃续跑）；已存在但内容不同则拒绝覆盖。
 * 任何检查失败都关闭，绝不覆盖已完成候选、后来授权内容或完成检查点。
 */
async function writeOrRejectRepairOutput(
  privateRootDirectory: string,
  path: string,
  value: unknown,
  sourceId: string,
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
      throw new HistoryMigrationError("REPAIR_REJECTED", `${sourceId} 的修复输出无法安全检查。`);
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
      "REPAIR_REJECTED",
      `${sourceId} 已存在内容不同的修复输出（可能来自后来授权）；拒绝覆盖。`,
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

/**
 * 受控本地源文修复的候选溯源说明。固定类别常量，不包含任何私有值：
 * 只声明"本地源文只读修复、未调用模型"，绝不写入名称、路径、正文或摘要。
 */
/**
 * 规范题面（canonicalContentSchema）允许 basicSolution 为 null，以结构性缺失
 * 表达"无题解"。本地修复对原文缺题解的源写入 null（绝不写入任何占位或提示文字）；
 * solution 保持空串，缺失由 null 在候选 → 打包 → 导入全程透传，幂等重放后仍为 null。
 */
export const localSourceTextRepairNote = "local-source-text-only-repair:v1" as const;

/**
 * 把已确认元数据记录中的源原生名称确定性地规范化为 1..200 字符的候选标题。
 * 只做两步确定性变换：折叠所有空白为单个空格并去掉首尾空白；若仍超过
 * 200 个码点则按码点截断（不拆代理对）。不猜测、不加工、不生成新文本。
 * 名称来自 1..500 且 trim 后非空的已确认元数据，因此结果恒非空且长度受控。
 */
export function normalizeRepairTitle(name: string): string {
  const collapsed = name.replace(/\s+/gu, " ").trim();
  if (collapsed.length === 0) {
    throw new HistoryMigrationError(
      "REPAIR_REJECTED",
      "受控修复的源原生名称规范化为空，不能生成标题。",
    );
  }
  const characters = Array.from(collapsed);
  return characters.slice(0, 200).join("");
}

export interface RepairFailedHistoryCandidatesOptions {
  readonly privateRootDirectory: string;
  readonly sourceDirectory: string;
  readonly metadataFile: string;
  readonly sourceConfirmationFile: string;
  readonly preparedDirectory: string;
  /** 恰好九条失败回执的受控修复清单（留在私有目录，绝不进入公开或报告上下文）。 */
  readonly repairManifestFile: string;
}

export interface RepairFailedHistoryCandidatesResult {
  /** 本次实际写出修复候选的源文件数。 */
  readonly repairedCount: number;
  /** 清单中此前已经满足、本次未再改动的源文件数。 */
  readonly alreadyRepairedCount: number;
  readonly candidateCount: number;
  readonly sourceCount: number;
  readonly complete: boolean;
}

/**
 * 受控本地源文修复：只针对修复清单明确选择的九条失败回执，在私有目录内用
 * 源正文与源原生名称本地重建候选。整个过程不调用模型、不重发任何请求、
 * 不缩小范围、不加工或伪造正文；身份只来自标题无关的绑定元组。任何一条
 * 校验不一致（数量、唯一性、回执类别与摘要、源映射与摘要、正文为空、名称
 * 无法规范化）都会在任何输出写入之前失败关闭。
 *
 * 幂等与覆盖保护：已完成的源若其候选与本次确定性结果一致则跳过；若已存在
 * 内容不同的候选（例如后来授权的新标题）则拒绝覆盖，绝不用修复结果覆盖
 * 后来授权的内容。
 */
export async function repairFailedHistoryCandidates(
  options: RepairFailedHistoryCandidatesOptions,
): Promise<RepairFailedHistoryCandidatesResult> {
  await assertPathsInsidePrivateRoot(options.privateRootDirectory, [
    { path: options.sourceDirectory, kind: "existing" },
    { path: options.metadataFile, kind: "existing" },
    { path: options.sourceConfirmationFile, kind: "existing" },
    { path: options.preparedDirectory, kind: "existing" },
    { path: options.repairManifestFile, kind: "existing" },
  ]);
  const repairManifest = parsePrivateInput(
    historyRepairManifestSchema,
    await readPrivateJson(options.repairManifestFile),
    "REPAIR_MANIFEST_INVALID",
    "受控本地修复清单格式不正确，或没有恰好九条不重复的失败回执。",
  );
  const { confirmedSources } = await loadConfirmedInputs(
    options.metadataFile,
    await readPrivateJson(options.sourceConfirmationFile),
  );
  const sourcesById = new Map(confirmedSources.map((source) => [source.sourceId, source] as const));

  // ── 阶段 1：逐条校验；任何不一致都在写入任何输出之前失败关闭 ────────
  const repairs: Array<{
    readonly source: ConfirmedSource;
    readonly candidateId: string;
    readonly candidate: HistoryCandidateRecord;
    readonly reference: { readonly candidateId: string; readonly contentSha256: string };
    readonly activeSha256: string;
    readonly requestAttemptSha256s: readonly string[];
  }> = [];
  let alreadyRepairedCount = 0;
  for (const receipt of repairManifest.receipts) {
    const source = sourcesById.get(receipt.sourceId);
    if (
      source === undefined ||
      source.mapping.sourcePath !== receipt.sourcePath ||
      source.mapping.sourceSha256 !== receipt.sourceSha256 ||
      source.mapping.metadataNumber !== receipt.metadataNumber
    ) {
      throw new HistoryMigrationError(
        "REPAIR_REJECTED",
        `${receipt.sourceId} 的源映射与受控修复清单不一致，不能修复。`,
      );
    }
    await removeSupersededFailureReceipt(
      options.privateRootDirectory,
      options.preparedDirectory,
      receipt.sourceId,
    );
    const state = await loadPreparationSourceState(
      options.privateRootDirectory,
      options.preparedDirectory,
      receipt.sourceId,
    );
    let sourceContent: { readonly text: string; readonly sha256: string };
    try {
      sourceContent = await readConfirmedSource(
        options.sourceDirectory,
        source.mapping.sourcePath,
        source.mapping.sourceSha256,
        receipt.sourceId,
      );
    } catch {
      throw new HistoryMigrationError(
        "REPAIR_REJECTED",
        `${receipt.sourceId} 的源正文无法安全读取或其摘要已变化，不能修复。`,
      );
    }
    if (sourceContent.text.trim().length === 0) {
      throw new HistoryMigrationError(
        "REPAIR_REJECTED",
        `${receipt.sourceId} 的源正文为空，不能修复。`,
      );
    }
    const candidateId = makeSafeId("candidate", confirmedSources.indexOf(source) * 30 + 1);
    const candidate = buildRepairedCandidate({
      candidateId,
      source,
      sourceContentSha256: sourceContent.sha256,
      title: normalizeRepairTitle(source.metadata.name),
      sourceText: sourceContent.text,
    });
    const reference = { candidateId, contentSha256: candidate.contentSha256 };
    if (state === "pending") {
      throw new HistoryMigrationError(
        "REPAIR_REJECTED",
        `${receipt.sourceId} 尚未处理，没有可用的失败回执，不能修复。`,
      );
    }
    if (state.kind === "completed") {
      if (
        !state.record.candidates.some(
          (item) => item.candidateId === candidateId && item.contentSha256 === reference.contentSha256,
        )
      ) {
        throw new HistoryMigrationError(
          "REPAIR_REJECTED",
          `${receipt.sourceId} 已有内容不同的完成候选（可能来自后来授权）；拒绝覆盖。`,
        );
      }
      alreadyRepairedCount += 1;
      continue;
    }
    if (state.kind === "active") {
      throw new HistoryMigrationError(
        "REPAIR_REJECTED",
        `${receipt.sourceId} 的请求仍然活跃，不能修复。`,
      );
    }
    if (state.record.failureKind !== "schema") {
      throw new HistoryMigrationError(
        "REPAIR_REJECTED",
        `${receipt.sourceId} 的失败回执不是受控可修复的格式失败类别。`,
      );
    }
    if (sha256Hex(JSON.stringify(state.record)) !== receipt.failedReceiptSha256) {
      throw new HistoryMigrationError(
        "REPAIR_REJECTED",
        `${receipt.sourceId} 的失败回执与修复清单摘要不一致，不能修复。`,
      );
    }
    if (state.record.activeSha256 === null) {
      throw new HistoryMigrationError(
        "REPAIR_REJECTED",
        `${receipt.sourceId} 的失败回执缺少请求登记链，不能修复。`,
      );
    }
    repairs.push({
      source,
      candidateId,
      candidate,
      reference,
      activeSha256: state.record.activeSha256,
      requestAttemptSha256s: state.record.requestAttemptSha256s,
    });
  }

  // ── 阶段 1b：除修复清单外，目录其余源必须全部已完成（先于任何输出写入）──
  const manifestSourceIds = new Set(repairManifest.receipts.map((receipt) => receipt.sourceId));
  for (const source of confirmedSources) {
    if (manifestSourceIds.has(source.sourceId)) {
      continue;
    }
    const state = await loadPreparationSourceState(
      options.privateRootDirectory,
      options.preparedDirectory,
      source.sourceId,
    );
    if (state !== "pending" && state.kind !== "completed") {
      throw new HistoryMigrationError(
        "REPAIR_REJECTED",
        `${source.sourceId} 不在受控修复清单中但尚未完成，不能修复。`,
      );
    }
  }

  // ── 阶段 2：全部校验通过后才开始写输出（write-or-reject：绝不覆盖任何已有内容）──
  for (const repair of repairs) {
    await writeOrRejectRepairOutput(
      options.privateRootDirectory,
      join(options.preparedDirectory, "candidates", `${repair.candidateId}.json`),
      repair.candidate,
      repair.source.sourceId,
    );
    await writeOrRejectRepairOutput(
      options.privateRootDirectory,
      preparationStatePath(options.preparedDirectory, repair.source.sourceId, "completed"),
      preparationCompletedSchema.parse({
        version: 1,
        status: "completed",
        sourceId: repair.source.sourceId,
        activeSha256: repair.activeSha256,
        requestAttemptSha256s: repair.requestAttemptSha256s,
        candidates: [repair.reference],
      }),
      repair.source.sourceId,
    );
    // 完成检查点已权威地取代失败回执：移除它，让状态与 prepare 成功路径一致。
    // 若中途崩溃留下两者并存，重跑时由 removeSupersededFailureReceipt 自愈。
    await rm(
      preparationStatePath(options.preparedDirectory, repair.source.sourceId, "failed"),
      { force: true },
    );
  }

  // ── 阶段 3：汇总并发布完成标记（与 prepare 收尾一致，全部 write-or-validate）。
  // 该阶段在"全部已满足"时同样执行，因此崩溃续跑/重跑可幂等恢复：已存在且
  // 内容一致的标记原样保留，缺失的补写，绝不用不同内容覆盖已有标记。 ──────
  const summary = await summarizePreparation(
    options.privateRootDirectory,
    options.preparedDirectory,
    confirmedSources,
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
    const run = preparationRunSchema.parse(
      await readPrivateJson(join(options.preparedDirectory, "run.json")),
    );
    const runSha256 = sha256Hex(JSON.stringify(run));
    await writeOrValidatePreparationJson(
      options.privateRootDirectory,
      join(options.preparedDirectory, "review.json"),
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
      options.preparedDirectory,
    );
    await writeOrValidatePreparationJson(
      options.privateRootDirectory,
      join(options.preparedDirectory, "PREPARE_COMPLETE"),
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
    repairedCount: repairs.length,
    alreadyRepairedCount,
    candidateCount: summary.report.length,
    sourceCount: confirmedSources.length,
    complete: summary.complete,
  };
}

function buildRepairedCandidate(input: {
  readonly candidateId: string;
  readonly source: ConfirmedSource;
  readonly sourceContentSha256: string;
  readonly title: string;
  readonly sourceText: string;
}): HistoryCandidateRecord {
  const problem = historyCandidateProblemSchema.parse({
    title: input.title,
    type: "traditional",
    tags: [],
    difficulty: {},
    content: {
      basicStatement: input.sourceText,
      basicSolution: null,
      background: "",
      statement: "",
      inputFormat: "",
      outputFormat: "",
      constraints: "",
      solution: "",
      hints: "",
    },
    samples: [],
    files: [],
    provenance: { sourceSystem: "ustc-history-private" },
    extensions: {},
  });
  const sourceBindingSha256 = sourceBindingDigest({
    sourceId: input.source.sourceId,
    sourceContentSha256: input.sourceContentSha256,
    sourcePath: input.source.mapping.sourcePath,
    sourceSha256: input.source.mapping.sourceSha256,
    metadataNumber: input.source.mapping.metadataNumber,
  });
  const contentSha256 = candidateContentDigest({
    sourceId: input.source.sourceId,
    sourceContentSha256: input.sourceContentSha256,
    sourceMappingSha256: input.source.sourceMappingSha256,
    modelConfidence: 0,
    normalizationNote: localSourceTextRepairNote,
    problem,
  });
  return historyCandidateRecordSchema.parse({
    version: 1,
    candidateId: input.candidateId,
    sourceId: input.source.sourceId,
    sourceContentSha256: input.sourceContentSha256,
    sourceMappingSha256: input.source.sourceMappingSha256,
    sourceBindingSha256,
    contentSha256,
    modelConfidence: 0,
    normalizationNote: localSourceTextRepairNote,
    problem,
  });
}

type VerifiedHistoryMaterialization = Awaited<
  ReturnType<typeof assertHistoryMaterializationComplete>
>;

async function loadApprovedCandidatesForSources(
  options: VerifyApprovedPackageSourceIdentitiesOptions,
  materialization: VerifiedHistoryMaterialization,
  confirmedSources: readonly ConfirmedSource[],
): Promise<readonly ApprovedCandidate[]> {
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
    const expectedSourceBindingSha256 = sourceBindingDigest({
      sourceId: candidate.sourceId,
      sourceContentSha256: candidate.sourceContentSha256,
      sourcePath: source.mapping.sourcePath,
      sourceSha256: source.mapping.sourceSha256,
      metadataNumber: source.mapping.metadataNumber,
    });
    if (
      candidate.sourceContentSha256 !== source.mapping.sourceSha256 ||
      candidate.sourceMappingSha256 !== source.sourceMappingSha256 ||
      (candidate.sourceBindingSha256 !== undefined &&
        candidate.sourceBindingSha256 !== expectedSourceBindingSha256)
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
    approvedCandidates.push({ record: candidate, metadata: source.metadata, mapping: source.mapping });
  }
  return approvedCandidates;
}

async function loadAuthoritativelyApprovedCandidates(
  options: VerifyApprovedPackageSourceIdentitiesOptions,
  materialization: VerifiedHistoryMaterialization,
): Promise<readonly ApprovedCandidate[]> {
  const { confirmedSources } = await loadConfirmedInputs(
    options.metadataFile,
    await materialization.readSourceConfirmation(),
  );
  const approvedCandidates = await loadApprovedCandidatesForSources(
    options,
    materialization,
    confirmedSources,
  );
  await loadPreparationMarker(
    options.privateRootDirectory,
    options.preparedDirectory,
    confirmedSources,
  );
  return approvedCandidates;
}

export async function verifyApprovedPackageSourceIdentities(
  options: VerifyApprovedPackageSourceIdentitiesOptions,
): Promise<readonly AuthoritativePackageSourceIdentity[]> {
  await assertPathsInsidePrivateRoot(options.privateRootDirectory, [
    { path: options.materializedDirectory, kind: "existing" },
    { path: options.metadataFile, kind: "existing" },
    { path: options.preparedDirectory, kind: "existing" },
    { path: options.approvalFile, kind: "existing" },
  ]);
  const materialization = await assertHistoryMaterializationComplete({
    privateRootDirectory: options.privateRootDirectory,
    materializedDirectory: options.materializedDirectory,
  });
  try {
    const approvedCandidates = await loadAuthoritativelyApprovedCandidates(options, materialization);
    await materialization.assertUnchangedBeforePublish();
    return approvedCandidates.map(({ record, mapping }) => ({
      candidateId: record.candidateId,
      contentSha256: record.contentSha256,
      sourceBindingSha256:
        record.sourceBindingSha256 ??
        sourceBindingDigest({
          sourceId: record.sourceId,
          sourceContentSha256: record.sourceContentSha256,
          sourcePath: mapping.sourcePath,
          sourceSha256: mapping.sourceSha256,
          metadataNumber: mapping.metadataNumber,
        }),
      problem: record.problem,
    }));
  } finally {
    await materialization.close();
  }
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

  const approvedCandidates = await loadAuthoritativelyApprovedCandidates(options, materialization);

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
      readonly sourceBindingSha256: string;
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
        sourceBindingSha256:
          approved.record.sourceBindingSha256 ?? sourceBindingDigest({
            sourceId: approved.record.sourceId,
            sourceContentSha256: approved.record.sourceContentSha256,
            sourcePath: approved.mapping.sourcePath,
            sourceSha256: approved.mapping.sourceSha256,
            metadataNumber: approved.mapping.metadataNumber,
          }),
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
  const stateMarkerPaths = [
    join(preparedDirectory, "PREPARE_INCOMPLETE"),
    join(preparedDirectory, "PREPARE_RUN"),
  ];
  const existingStateMarkers: string[] = [];
  for (const path of stateMarkerPaths) {
    try {
      await lstat(path);
    } catch (error) {
      if (hasNodeErrorCode(error, "ENOENT")) continue;
      throw new HistoryMigrationError("CANDIDATE_INVALID", "候选目录的运行状态标记无法检查。");
    }
    await assertPathsInsidePrivateRoot(privateRootDirectory, [{ path, kind: "existing" }]);
    await assertPrivateFileMode(path);
    existingStateMarkers.push(path);
  }
  if (existingStateMarkers.length !== 1) {
    throw new HistoryMigrationError(
      "CANDIDATE_INVALID",
      "候选目录必须恰好保留一份可核对的历史运行状态标记。",
    );
  }

  const completePath = join(preparedDirectory, "PREPARE_COMPLETE");
  const runPath = join(preparedDirectory, "run.json");
  const reviewPath = join(preparedDirectory, "review.json");
  for (const path of [completePath, runPath, reviewPath]) {
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
  const stateMarkerPath = existingStateMarkers[0];
  const runMarker =
    stateMarkerPath === undefined
      ? undefined
      : z
          .object({
            version: z.literal(1),
            phase: z.literal("prepare"),
            status: z.literal("incomplete"),
            runSha256: digestSchema,
          })
          .strict()
          .safeParse(await readPrivateJson(stateMarkerPath));
  if (
    runMarker === undefined ||
    !runMarker.success ||
    runMarker.data.runSha256 !== marker.runSha256
  ) {
    throw new HistoryMigrationError("CANDIDATE_INVALID", "候选目录的运行状态标记不一致。");
  }
  if (
    run.data.sourceCount !== confirmedSources.length ||
    marker.sourceCount !== confirmedSources.length
  ) {
    throw new HistoryMigrationError("CANDIDATE_INVALID", "候选目录的源文件计数不一致。");
  }

  let summary: Awaited<ReturnType<typeof summarizePreparation>>;
  try {
    summary = await summarizePreparation(
      privateRootDirectory,
      preparedDirectory,
      confirmedSources,
      sha256Hex(JSON.stringify(run.data.executionIdentity)),
      run.data.operationTagSha256,
    );
  } catch (error) {
    if (error instanceof HistoryMigrationError && error.code === "PREPARE_RESUME_UNSAFE") {
      throw new HistoryMigrationError("CANDIDATE_INVALID", "候选目录的执行身份证据不一致。");
    }
    throw error;
  }
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
    (total, value) => total + (value === null ? 0 : value.length),
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
    | "CANDIDATE_INVALID"
    | "REPAIR_MANIFEST_INVALID",
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
