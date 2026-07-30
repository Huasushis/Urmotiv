import { randomUUID } from "node:crypto";
import { mkdir, rename, rm, rmdir } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import type { CanonicalProblem } from "@urmotiv/problem-package";
import {
  urmotivNativeAdapter,
  writeZipArchive
} from "@urmotiv/problem-package";
import { z } from "zod";
import {
  candidateContentDigest,
  sha256Hex,
  sourceMappingDigest
} from "./digests";
import { HistoryMigrationError } from "./errors";
import {
  assertPathsInsidePrivateRoot,
  assertNewOutputPath,
  createNewPrivateDirectory,
  readConfirmedSource,
  readPrivateJson,
  readPrivateJsonWithDigest,
  writeNewPrivateFile,
  writeNewPrivateJson
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
  type NormalizedHistoryProblem
} from "./schema";

const preparationCompleteSchema = z
  .object({
    version: z.literal(1),
    phase: z.literal("prepare"),
    batchSha256: z.string().regex(/^[0-9a-f]{64}$/),
    candidateCount: z.number().int().nonnegative()
  })
  .strict();

export interface HistoryNormalizerInput {
  readonly sourceId: string;
  readonly text: string;
  readonly expectedTitle: string;
  readonly difficultyGuess: number | null;
}

export interface HistoryNormalizer {
  normalize(input: HistoryNormalizerInput): Promise<NormalizedHistoryOutput>;
}

export interface PrepareHistoryCandidatesOptions {
  readonly privateRootDirectory: string;
  readonly sourceDirectory: string;
  readonly metadataFile: string;
  readonly sourceConfirmationFile: string;
  readonly outputDirectory: string;
  readonly normalizer: HistoryNormalizer;
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
  options: PrepareHistoryCandidatesOptions
): Promise<PrepareHistoryCandidatesResult> {
  await assertPathsInsidePrivateRoot(options.privateRootDirectory, [
    { path: options.sourceDirectory, kind: "existing" },
    { path: options.metadataFile, kind: "existing" },
    { path: options.sourceConfirmationFile, kind: "existing" },
    { path: options.outputDirectory, kind: "new" }
  ]);
  const { confirmedSources } = await loadConfirmedInputs(
    options.metadataFile,
    options.sourceConfirmationFile
  );

  await createNewPrivateDirectory(options.outputDirectory);
  const stagingDirectory = join(
    options.outputDirectory,
    `.incomplete-${randomUUID()}`
  );
  try {
    await mkdir(stagingDirectory, { recursive: false, mode: 0o700 });
    const candidateDirectory = join(stagingDirectory, "candidates");
    await mkdir(candidateDirectory, { recursive: false, mode: 0o700 });

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
    let candidateSequence = 0;

    for (const source of confirmedSources) {
      const sourceContent = await readConfirmedSource(
        options.sourceDirectory,
        source.mapping.sourcePath,
        source.mapping.sourceSha256,
        source.sourceId
      );
      let normalized: NormalizedHistoryOutput;
      try {
        normalized = normalizedHistoryOutputSchema.parse(
          await options.normalizer.normalize({
            sourceId: source.sourceId,
            text: sourceContent.text,
            expectedTitle: source.metadata.name,
            difficultyGuess: source.metadata.difficultyGuess
          })
        );
      } catch {
        throw new HistoryMigrationError(
          "NORMALIZATION_FAILED",
          `${source.sourceId} 的候选内容生成失败。`
        );
      }

      for (const normalizedProblem of normalized.problems) {
        candidateSequence += 1;
        const candidateId = makeSafeId("candidate", candidateSequence);
        const problem = toCandidateProblem(normalizedProblem, source.metadata);
        const sourceMappingSha256 = source.sourceMappingSha256;
        assertPrivateIdentifiersNotPresent(
          {
            problem,
            normalizationNote: normalizedProblem.migrationNote
          },
          source.metadata.authorStudentId,
          source.mapping.sourcePath
        );
        const contentSha256 = candidateContentDigest({
          sourceId: source.sourceId,
          sourceContentSha256: sourceContent.sha256,
          sourceMappingSha256,
          modelConfidence: normalizedProblem.confidence,
          normalizationNote: normalizedProblem.migrationNote,
          problem
        });
        const candidate: HistoryCandidateRecord =
          historyCandidateRecordSchema.parse({
            version: 1,
            candidateId,
            sourceId: source.sourceId,
            sourceContentSha256: sourceContent.sha256,
            sourceMappingSha256,
            contentSha256,
            modelConfidence: normalizedProblem.confidence,
            normalizationNote: normalizedProblem.migrationNote,
            problem
          });
        await writeNewPrivateJson(
          join(candidateDirectory, `${candidateId}.json`),
          candidate
        );
        report.push({
          candidateId,
          sourceId: source.sourceId,
          contentSha256,
          titleLength: problem.title.length,
          basicStatementLength: problem.content.basicStatement.length,
          basicSolutionLength: problem.content.basicSolution.length,
          totalContentLength: totalCandidateContentLength(problem),
          sampleCount: problem.samples.length,
          status: "awaiting_approval"
        });
      }
    }

    const batchSha256 = sha256Hex(
      JSON.stringify({
        version: 1,
        candidates: report.map((candidate) => ({
          candidateId: candidate.candidateId,
          sourceId: candidate.sourceId,
          contentSha256: candidate.contentSha256
        }))
      })
    );
    await writeNewPrivateJson(join(stagingDirectory, "review.json"), {
      version: 1,
      phase: "prepare",
      batchSha256,
      sourceCount: confirmedSources.length,
      candidateCount: report.length,
      candidates: report
    });
    await writeNewPrivateJson(join(stagingDirectory, "PREPARE_COMPLETE"), {
      version: 1,
      phase: "prepare",
      batchSha256,
      candidateCount: report.length
    });
    await rename(
      join(stagingDirectory, "candidates"),
      join(options.outputDirectory, "candidates")
    );
    await rename(
      join(stagingDirectory, "review.json"),
      join(options.outputDirectory, "review.json")
    );
    await rename(
      join(stagingDirectory, "PREPARE_COMPLETE"),
      join(options.outputDirectory, "PREPARE_COMPLETE")
    );
    await rmdir(stagingDirectory);

    return {
      sourceCount: confirmedSources.length,
      candidateCount: report.length
    };
  } catch (error) {
    await rm(options.outputDirectory, { recursive: true, force: true }).catch(
      () => undefined
    );
    throw error;
  }
}

export async function packageApprovedCandidates(
  options: PackageApprovedCandidatesOptions
): Promise<PackageApprovedCandidatesResult> {
  await assertPathsInsidePrivateRoot(options.privateRootDirectory, [
    { path: options.sourceDirectory, kind: "existing" },
    { path: options.metadataFile, kind: "existing" },
    { path: options.sourceConfirmationFile, kind: "existing" },
    { path: options.preparedDirectory, kind: "existing" },
    { path: options.approvalFile, kind: "existing" },
    { path: options.outputDirectory, kind: "new" },
    { path: options.authorMappingOutput, kind: "new" }
  ]);
  assertSeparateAuthorMappingPath(options.outputDirectory, options.authorMappingOutput);
  await assertNewOutputPath(options.authorMappingOutput);

  const { confirmedSources } = await loadConfirmedInputs(
    options.metadataFile,
    options.sourceConfirmationFile
  );
  const sourcesById = new Map(
    confirmedSources.map((source) => [source.sourceId, source] as const)
  );
  await loadPreparationMarker(options.preparedDirectory);
  const approvals = parsePrivateInput(
    historyCandidateApprovalSchema,
    await readPrivateJson(options.approvalFile),
    "INVALID_CANDIDATE_APPROVAL",
    "候选批准文件格式不正确或没有明确确认。"
  );

  const assignedSourceIds = new Set<string>();
  const approvedCandidates: ApprovedCandidate[] = [];
  for (const approval of approvals.approvals) {
    const candidate = await loadCandidate(
      options.privateRootDirectory,
      options.preparedDirectory,
      approval.candidateId
    );
    if (candidate.candidateId !== approval.candidateId) {
      throw new HistoryMigrationError(
        "CANDIDATE_INVALID",
        `${approval.candidateId} 的文件内容与安全编号不一致。`
      );
    }
    const currentDigest = candidateContentDigest(candidate);
    if (
      currentDigest !== candidate.contentSha256 ||
      currentDigest !== approval.contentSha256
    ) {
      throw new HistoryMigrationError(
        "CANDIDATE_CHANGED",
        `${approval.candidateId} 的内容已经变化，原来的批准已失效。`
      );
    }

    const source = sourcesById.get(candidate.sourceId);
    if (source === undefined) {
      throw new HistoryMigrationError(
        "SOURCE_MAPPING_MISSING",
        `${approval.candidateId} 没有对应的已确认源文件映射。`
      );
    }
    if (
      candidate.sourceContentSha256 !== source.mapping.sourceSha256 ||
      candidate.sourceMappingSha256 !== source.sourceMappingSha256
    ) {
      throw new HistoryMigrationError(
        "SOURCE_MAPPING_CHANGED",
        `${approval.candidateId} 对应的源文件映射已经变化，必须重新准备候选。`
      );
    }
    await readConfirmedSource(
      options.sourceDirectory,
      source.mapping.sourcePath,
      source.mapping.sourceSha256,
      source.sourceId
    );
    assertPrivateIdentifiersNotPresent(
      {
        problem: candidate.problem,
        normalizationNote: candidate.normalizationNote
      },
      source.metadata.authorStudentId,
      source.mapping.sourcePath
    );
    if (assignedSourceIds.has(candidate.sourceId)) {
      throw new HistoryMigrationError(
        "DUPLICATE_ASSIGNMENT",
        "多个批准候选被分配给同一条元数据，必须人工拆分源文件并重新确认。"
      );
    }
    assignedSourceIds.add(candidate.sourceId);
    approvedCandidates.push({ record: candidate, metadata: source.metadata });
  }

  await createNewPrivateDirectory(options.outputDirectory);
  const stagingDirectory = join(
    options.outputDirectory,
    `.incomplete-${randomUUID()}`
  );
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
        exportedAt: options.exportedAt ?? new Date().toISOString()
      });
      const archive = writeZipArchive(generated.files);
      const packageSha256 = sha256Hex(archive);
      await writeNewPrivateFile(
        join(packageDirectory, `${approved.record.candidateId}.zip`),
        archive
      );
      packageReport.push({
        candidateId: approved.record.candidateId,
        contentSha256: approved.record.contentSha256,
        packageSha256,
        packageBytes: archive.byteLength,
        status: "packaged"
      });
      if (approved.metadata.authorStudentId.length > 0) {
        authorMappings.push({
          candidateId: approved.record.candidateId,
          contentSha256: approved.record.contentSha256,
          packageSha256,
          authorStudentId: approved.metadata.authorStudentId
        });
      }
    }

    const batchSha256 = sha256Hex(
      JSON.stringify({
        version: 1,
        packages: packageReport
      })
    );
    await writeNewPrivateJson(join(stagingDirectory, "report.json"), {
      version: 1,
      phase: "package",
      batchSha256,
      packageCount: packageReport.length,
      packages: packageReport
    });
    await writeNewPrivateJson(join(stagingDirectory, "PACKAGE_COMPLETE"), {
      version: 1,
      phase: "package",
      batchSha256,
      packageCount: packageReport.length
    });
    await rename(
      join(stagingDirectory, "packages"),
      join(options.outputDirectory, "packages")
    );
    await rename(
      join(stagingDirectory, "report.json"),
      join(options.outputDirectory, "report.json")
    );
    await writeNewPrivateJson(options.authorMappingOutput, {
      version: 1,
      batchSha256,
      records: authorMappings
    });
    authorMappingWritten = true;
    await rename(
      join(stagingDirectory, "PACKAGE_COMPLETE"),
      join(options.outputDirectory, "PACKAGE_COMPLETE")
    );
    await rmdir(stagingDirectory);

    return {
      packageCount: packageReport.length,
      authorMappingCount: authorMappings.length
    };
  } catch (error) {
    await rm(options.outputDirectory, { recursive: true, force: true }).catch(
      () => undefined
    );
    if (authorMappingWritten) {
      await rm(options.authorMappingOutput, { force: true }).catch(
        () => undefined
      );
    }
    throw error;
  }
}

async function loadConfirmedInputs(
  metadataFile: string,
  sourceConfirmationFile: string
): Promise<{
  readonly confirmedSources: readonly ConfirmedSource[];
}> {
  const metadataInput = await readPrivateJsonWithDigest(metadataFile);
  const metadata = parsePrivateInput(
    historyMetadataFileSchema,
    metadataInput.value,
    "INVALID_METADATA",
    "历史题目元数据格式不正确。"
  );
  const sourceConfirmation = parsePrivateInput(
    historySourceMappingSchema,
    await readPrivateJson(sourceConfirmationFile),
    "INVALID_SOURCE_CONFIRMATION",
    "源文件映射确认格式不正确或没有明确确认。"
  );
  if (sourceConfirmation.metadataFileSha256 !== metadataInput.sha256) {
    throw new HistoryMigrationError(
      "SOURCE_MAPPING_CHANGED",
      "私有元数据文件已经变化，原来的源文件映射确认已失效。"
    );
  }
  const metadataByNumber = new Map(
    metadata.records.map((record) => [record.number, record] as const)
  );
  const confirmedSources = sourceConfirmation.mappings.map((mapping, index) => {
    const matchedMetadata = metadataByNumber.get(mapping.metadataNumber);
    if (matchedMetadata === undefined) {
      throw new HistoryMigrationError(
        "SOURCE_MAPPING_MISSING",
        `${makeSafeId("source", index + 1)} 指向的元数据不存在。`
      );
    }
    return {
      sourceId: makeSafeId("source", index + 1),
      mapping,
      sourceMappingSha256: sourceMappingDigest(
        mapping,
        sourceConfirmation.metadataFileSha256
      ),
      metadata: matchedMetadata
    };
  });
  return { confirmedSources };
}

async function loadPreparationMarker(preparedDirectory: string): Promise<void> {
  parsePrivateInput(
    preparationCompleteSchema,
    await readPrivateJson(join(preparedDirectory, "PREPARE_COMPLETE")),
    "CANDIDATE_INVALID",
    "候选目录没有完整的准备完成标记。"
  );
}

async function loadCandidate(
  privateRootDirectory: string,
  preparedDirectory: string,
  candidateId: string
): Promise<HistoryCandidateRecord> {
  const candidatePath = join(
    preparedDirectory,
    "candidates",
    `${candidateId}.json`
  );
  try {
    await assertPathsInsidePrivateRoot(privateRootDirectory, [
      { path: candidatePath, kind: "existing" }
    ]);
    return parsePrivateInput(
      historyCandidateRecordSchema,
      await readPrivateJson(candidatePath),
      "CANDIDATE_INVALID",
      `${candidateId} 的候选文件格式不正确。`
    );
  } catch (error) {
    if (error instanceof HistoryMigrationError) {
      if (error.code === "SOURCE_FILE_INVALID" || error.code === "SOURCE_TOO_LARGE") {
        throw new HistoryMigrationError(
          "CANDIDATE_NOT_FOUND",
          `${candidateId} 不存在或无法安全读取。`
        );
      }
      throw error;
    }
    throw new HistoryMigrationError(
      "CANDIDATE_NOT_FOUND",
      `${candidateId} 不存在或无法安全读取。`
    );
  }
}

function toCandidateProblem(
  problem: NormalizedHistoryProblem,
  metadata: HistoryMetadataRecord
): CanonicalProblem {
  return historyCandidateProblemSchema.parse({
    title: problem.title,
    type: problem.type,
    tags: problem.tags,
    difficulty:
      metadata.difficultyGuess === null
        ? {}
        : { codeforces: metadata.difficultyGuess },
    content: {
      basicStatement: problem.basicStatement,
      basicSolution: problem.basicSolution,
      background: problem.background,
      statement: problem.statement,
      inputFormat: problem.inputFormat,
      outputFormat: problem.outputFormat,
      constraints: problem.constraints,
      solution: problem.solution,
      hints: problem.hints
    },
    samples: problem.samples,
    files: [],
    provenance: {
      sourceSystem: "ustc-history-private"
    },
    extensions:
      metadata.difficultyText.length === 0
        ? {}
        : {
            migration: {
              difficultyText: metadata.difficultyText
            }
          }
  });
}

function totalCandidateContentLength(problem: CanonicalProblem): number {
  const contentLength = Object.values(problem.content).reduce(
    (total, value) => total + value.length,
    0
  );
  const sampleLength = problem.samples.reduce(
    (total, sample) =>
      total + sample.input.length + sample.output.length + sample.explanation.length,
    0
  );
  return problem.title.length + contentLength + sampleLength;
}

function makeSafeId(kind: "source" | "candidate", sequence: number): string {
  if (!Number.isSafeInteger(sequence) || sequence <= 0 || sequence > 999_999) {
    throw new HistoryMigrationError(
      "CANDIDATE_INVALID",
      "历史迁移安全编号数量超出支持范围。"
    );
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
  message: string
): T {
  const parsed = schema.safeParse(input);
  if (!parsed.success) {
    throw new HistoryMigrationError(code, message);
  }
  return parsed.data;
}

function assertSeparateAuthorMappingPath(
  outputDirectory: string,
  authorMappingOutput: string
): void {
  const outputRoot = resolve(outputDirectory);
  const authorPath = resolve(authorMappingOutput);
  const relativePath = relative(outputRoot, authorPath);
  if (
    relativePath.length === 0 ||
    (!relativePath.startsWith("..") && !isAbsolute(relativePath))
  ) {
    throw new HistoryMigrationError(
      "INVALID_ARGUMENTS",
      "作者学号映射必须写到题目包输出目录之外的单独私有文件。"
    );
  }
}

function assertPrivateIdentifiersNotPresent(
  value: unknown,
  authorStudentId: string,
  sourcePath: string
): void {
  const sourceName = sourcePath.split("/").at(-1) ?? sourcePath;
  const privateIdentifiers = [authorStudentId, sourcePath, sourceName]
    .map((item) => item.trim().toLocaleLowerCase("en-US"))
    .filter((item, index, all) => item.length > 0 && all.indexOf(item) === index);
  if (
    privateIdentifiers.some((identifier) => containsText(value, identifier))
  ) {
    throw new HistoryMigrationError(
      "CANDIDATE_INVALID",
      "候选内容含有作者学号或原文件标识；必须先在私有资料中移除个人标识，再重新准备候选。"
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
    return Object.values(value).some((item) =>
      containsText(item, normalizedNeedle)
    );
  }
  return false;
}
