/**
 * 历史题目包正式导入阶段。
 *
 * 把 packageApprovedCandidates 产出的原生 Urmotiv 题目包通过正式导入基础设施
 * （安全压缩包读取 → urmotiv 原生适配器 → 导入任务 → 权限校验 → 事务写入 →
 * 审计）写入真实 PostgreSQL 数据库。导入是幂等的：同一包重复导入不会产生
 * 重复题目；单个包失败不会影响其余包，重跑时只处理失败的包。
 *
 * 安全边界：本模块只返回计数和状态，不返回题面、题解、附件内容或文件名。
 * 私有材料只写入调用方提供的私有目录和验收数据库。
 */

import { createHash, randomUUID } from "node:crypto";
import { mkdir, open } from "node:fs/promises";
import { constants } from "node:fs";
import { join } from "node:path";
import { sql } from "drizzle-orm";
import { z } from "zod";

import {
  createPostgresDatabase,
  migrateDatabase,
  seedCoreDatabase,
  type DatabaseHandle,
} from "@urmotiv/database";
import {
  canonicalProblemSchema,
  nativeProblemMediaType,
  readZipArchive,
  urmotivNativeAdapter,
  type CanonicalProblem,
  type SafeArchive,
} from "@urmotiv/problem-package";
import {
  ImportAccessRevokedError,
  type AtomicImportedProblemWriter,
  type HistoryImportJobStore,
  type HistoryImportJobClaim,
  type ImportJobReplayResult,
  type ProblemPackageImportChoices,
  type ProblemPackageImportJob,
  type ProblemPackageJobReport,
} from "@urmotiv/jobs";
import { LocalFileStorage, type FileStorage } from "@urmotiv/storage";

import { databaseDemoUserIds, seedDatabaseDemoData } from "../database-demo";
import { DatabaseDataStore } from "../database-store";
import {
  DatabaseImportedProblemWriter,
  type DatabaseImportedProblemWriterDependencies,
} from "../problem-package-runtime";
import { DatabaseProblemPackageAuditWriter } from "../problem-package-audit";
import { DatabaseProblemPackageJobStore } from "../problem-package-job-store";
import { ProblemFileStore } from "../problem-file-store";

import { sha256Hex } from "./digests";
import { HistoryMigrationError } from "./errors";
import {
  assertPathsInsidePrivateRoot,
  createNewPrivateDirectory,
  privateRegularFileExists,
  readPrivateJson,
  removePrivateRegularFile,
  writeNewPrivateJson,
  writePrivateFile,
} from "./private-files";

// ---------------------------------------------------------------------------
// 收敛式清理：不静默吞没不确定性
// ---------------------------------------------------------------------------

/**
 * 清理操作结果。不暴露内部错误消息——仅用稳定状态码表示。
 */
type CleanupResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly code: "CLEANUP_FAILED" };

/**
 * 尝试执行清理操作，不静默吞没失败。
 * 返回稳定状态码而非内部错误消息，避免在 API/报告层面暴露实现细节。
 * 底层错误被记录到 cause 供内部诊断，但不出现在面向用户的 message 中。
 */
async function attemptCleanup<T>(operation: () => Promise<T>): Promise<CleanupResult> {
  try {
    await operation();
    return { ok: true };
  } catch {
    return { ok: false, code: "CLEANUP_FAILED" };
  }
}

/**
 * 组合原始错误与清理不确定性。
 * 如果清理失败，附加稳定状态码 CLEANUP_FAILED 而非内部错误消息。
 * 原始错误的 message 保持不变；清理不确定性仅通过 cause 链记录（供内部诊断）。
 */
function withCleanupError(original: unknown, cleanup: CleanupResult): unknown {
  if (cleanup.ok) return original;
  if (original instanceof HistoryMigrationError) {
    return new HistoryMigrationError(
      original.code,
      original.message,
      { cause: { cleanupState: "CLEANUP_FAILED" } },
    );
  }
  if (original instanceof Error) {
    return new HistoryMigrationError(
      "INTERNAL_ERROR",
      original.message,
      { cause: { cleanupState: "CLEANUP_FAILED", originalError: original } },
    );
  }
  return new HistoryMigrationError(
    "INTERNAL_ERROR",
    "操作失败且清理亦不确定。",
    { cause: { cleanupState: "CLEANUP_FAILED" } },
  );
}

// ---------------------------------------------------------------------------
// 类型与常量
// ---------------------------------------------------------------------------

export interface HistoryImportPhaseDependencies {
  readonly database: DatabaseHandle;
  /** 对象存储根目录；导入输入文件与题目文件都发布到这里。 */
  readonly storageRoot: string;
  /**
   * 分给每道历史题目的固定知识点标签。历史整理模型不自行选择标签
   * （historyCandidateProblemSchema 强制 tags 为空数组），导入阶段按操作员
   * 指定注入一个目录叶子标签。
   */
  readonly assignedTagId: string;
  /** 缺省使用演示组长账号（拥有 problem.import 权限）。 */
  readonly requestedByUserId?: string;
  /** 可注入自定义 writer；缺省使用 DatabaseImportedProblemWriter。 */
  readonly writer?: AtomicImportedProblemWriter;
  /**
   * 统一历史导入任务存储：同时实现 job + replay + recovery 三接口。
   * 缺省使用 DatabaseProblemPackageJobStore（已实现全部三接口）。
   * 不允许 Partial 类型转换或可选回退——必须是编译期安全的统一接口。
   */
  readonly jobStore?: HistoryImportJobStore;
  /** 可注入自定义对象存储；缺省使用 LocalFileStorage。 */
  readonly storage?: FileStorage;
  /** 可注入自定义清单/标记发布器；缺省使用基于私有文件的安全发布器。 */
  readonly publisher?: HistoryImportPublisher;
  /** 可注入自定义文件元数据存储；缺省使用 ProblemFileStore。 */
  readonly store?: HistoryImportStore;
  readonly now?: () => Date;
}

/**
 * 导入阶段使用的文件元数据存储接口（ProblemFileStore 的子集）。
 * 该接口存在的目的是让测试可以注入故障。
 * findStoredFile 返回完整行以支持回放时的全字段验证。
 */
export interface HistoryImportStore {
  readonly createStoredFile: (
    input: import("@urmotiv/contracts").CreateStoredFileInput,
  ) => Promise<unknown>;
  readonly findStoredFile: (
    fileId: string,
  ) => Promise<import("@urmotiv/contracts").StoredFileRecord | undefined>;
}

export interface ImportHistoryPackagesOptions {
  readonly privateRootDirectory: string;
  /** packageApprovedCandidates 输出的私有目录（report.json + packages/*.zip）。 */
  readonly packageDirectory: string;
  /** 本阶段自己的私有输出目录（manifest 与完成标记）。 */
  readonly outputDirectory: string;
  readonly dependencies: HistoryImportPhaseDependencies;
}

export interface ImportHistoryPackagesFailedCandidate {
  readonly candidateId: string;
  /** 稳定消毒码：HistoryMigrationErrorCode 或 "internal_failure"。不含路径/原因/正文。 */
  readonly code: string;
}

export interface ImportHistoryPackagesResult {
  readonly packageCount: number;
  readonly importedCount: number;
  readonly skippedCount: number;
  readonly failedCount: number;
  readonly failedCandidateIds: readonly string[];
  /** 每个失败候选的稳定消毒码；与 failedCandidateIds 一一对应。 */
  readonly failedCandidates: readonly ImportHistoryPackagesFailedCandidate[];
}

/**
 * 清单与完成标记的发布接口。
 *
 * 生产实现使用 private-files 模块的安全原子文件操作。
 * 该接口存在的目的是让测试可以注入发布失败，验证故障下的恢复语义。
 * 这不是测试旁路——生产实现是真实的安全文件操作，接口本身是合法的
 * 依赖注入缝（与 writer/jobStore/storage 同级）。
 */
export interface HistoryImportPublisher {
  /** 写入（覆盖）清单文件。 */
  readonly writeManifest: (manifestPath: string, payload: string) => Promise<void>;
  /** 写入（覆盖）完成标记。 */
  readonly writeComplete: (completePath: string, payload: string) => Promise<void>;
  /** 幂等移除完成标记。 */
  readonly removeComplete: (completePath: string) => Promise<void>;
}

const defaultPublisher: HistoryImportPublisher = {
  writeManifest: writePrivateFile,
  writeComplete: writePrivateFile,
  removeComplete: removePrivateRegularFile,
};

/**
 * 单个历史题目包在导入阶段的硬上限。packageApprovedCandidates 产出的包
 * 都经过 writeZipArchive 的默认安全限制（128 MiB），这里额外设一道上限
 * 防止私有目录被替换后读入超大文件。读取前先用 stat 核对实际文件大小，
 * 再与包报告声明的 packageBytes 比对，两者一致后才读入内存。
 */
export const maximumImportPackageBytes = 256 * 1024 * 1024;
const digestSchema = z.string().regex(/^[0-9a-f]{64}$/);

export const packageReportEntrySchema = z
  .object({
    candidateId: z.string().regex(/^candidate-[0-9]{6}$/),
    contentSha256: digestSchema,
    sourceBindingSha256: digestSchema.optional(),
    packageSha256: digestSchema,
    packageBytes: z
      .number()
      .int()
      .min(0)
      .max(256 * 1024 * 1024),
    status: z.literal("packaged"),
    attachments: z
      .array(
        z
          .object({
            attachmentId: z.string().min(1).max(200),
            contentSha256: digestSchema,
            semanticRole: z.string().min(1).max(80),
            visibility: z.string().min(1).max(40),
            targetPath: z.string().min(1).max(400),
          })
          .strict(),
      )
      .optional(),
  })
  .strict();

export const packageReportPayloadSchema = z
  .object({
    version: z.literal(1),
    phase: z.literal("package"),
    batchSha256: digestSchema,
    packageCount: z.number().int().min(0),
    packages: z.array(packageReportEntrySchema),
    attachmentCount: z.number().int().min(0).optional(),
    preservedMaterialCount: z.number().int().min(0).optional(),
    preservedMaterials: z
      .array(
        z
          .object({
            attachmentId: z.string().min(1).max(200),
            contentSha256: digestSchema,
            semanticRole: z.string().min(1).max(80),
            preservationPath: z.string().min(1).max(400),
          })
          .strict(),
      )
      .optional(),
  })
  .strict();

const importManifestEntrySchema = z
  .object({
    candidateId: z.string().regex(/^candidate-[0-9]{6}$/),
    packageSha256: digestSchema,
    importJobId: z.string().uuid(),
    problemId: z.string().regex(/^(0|[1-9][0-9]*)$/),
    importedAt: z.string(),
  })
  .strict();

export const importManifestPayloadSchema = z
  .object({
    version: z.literal(1),
    phase: z.literal("import"),
    batchSha256: digestSchema,
    importedCount: z.number().int().min(0),
    entries: z.array(importManifestEntrySchema),
  })
  .strict();

type PackageReportEntry = z.infer<typeof packageReportEntrySchema>;

/**
 * 来源绑定键：新包报告包含 sourceBindingSha256（与标题无关），用于幂等回放。
 * 旧包报告没有此字段时回退到 packageSha256——保持已完成记录的原有行为。
 */
function entrySourceBindingKey(entry: PackageReportEntry): string {
  return entry.sourceBindingSha256 ?? entry.packageSha256;
}
const importCompletePayloadSchema = z
  .object({
    version: z.literal(1),
    phase: z.literal("import"),
    batchSha256: digestSchema,
    packageCount: z.number().int().min(0),
    importedCount: z.number().int().min(0),
  })
  .strict();

type ImportCompletePayload = z.infer<typeof importCompletePayloadSchema>;
type ImportManifestEntry = z.infer<typeof importManifestEntrySchema>;
type ImportManifestPayload = z.infer<typeof importManifestPayloadSchema>;

const manifestFileName = "import-manifest.private.json";
const importCompleteFileName = "IMPORT_COMPLETE";
const batchPublicationFileName = "batch-publication.private.json";

function importCompleteReport(): ProblemPackageJobReport {
  return {
    version: 1,
    phase: "completed",
    completedItems: 1,
    failedItems: 0,
    skippedItems: 0,
  };
}

function importFailedReport(): ProblemPackageJobReport {
  return {
    version: 1,
    phase: "failed",
    completedItems: 0,
    failedItems: 1,
    skippedItems: 0,
  };
}

// ---------------------------------------------------------------------------
// 正式导入入口
// ---------------------------------------------------------------------------

export async function importHistoryPackages(
  options: ImportHistoryPackagesOptions,
): Promise<ImportHistoryPackagesResult> {
  await assertPathsInsidePrivateRoot(options.privateRootDirectory, [
    { path: options.packageDirectory, kind: "existing" },
    { path: options.outputDirectory, kind: "new" },
  ]);

  // 输出目录不存在则创建；重跑时已经存在则沿用（绝不覆盖）。
  try {
    await createNewPrivateDirectory(options.outputDirectory);
  } catch (error) {
    if (!(error instanceof HistoryMigrationError && error.code === "OUTPUT_ALREADY_EXISTS")) {
      throw error;
    }
  }

  const report = await readPackageReport(options.packageDirectory);

  // 幂等：读取既有的导入清单（存在即沿用）。
  const manifestPath = join(options.outputDirectory, manifestFileName);
  const existingManifest = await readExistingManifest(manifestPath);
  const entries = new Map<string, ImportManifestEntry>();

  if (existingManifest !== undefined) {
    // 把既有清单条目与当前包报告逐条绑定：只有 candidateId 和 packageSha256
    // 都与当前报告一致的条目才视为有效。这防止修复包后旧条目继续跳过，
    // 也防止把另一个批次的清单混用到当前包集。
    const reportByCandidateId = new Map(
      report.packages.map((pkg) => [pkg.candidateId, pkg] as const),
    );
    for (const entry of existingManifest.entries) {
      const current = reportByCandidateId.get(entry.candidateId);
      if (current !== undefined && current.packageSha256 === entry.packageSha256) {
        entries.set(entry.candidateId, entry);
      }
    }
  }
  let importedThisRun = 0;

  const database = options.dependencies.database;
  const writer = options.dependencies.writer ?? createDefaultWriter(options.dependencies);
  const jobStore: HistoryImportJobStore =
    options.dependencies.jobStore ?? new DatabaseProblemPackageJobStore(database);
  const storage =
    options.dependencies.storage ??
    new LocalFileStorage({
      rootDirectory: options.dependencies.storageRoot,
      limits: { maxBytes: 256 * 1024 * 1024 },
    });
  const publisher = options.dependencies.publisher ?? defaultPublisher;
  const store = options.dependencies.store ?? new ProblemFileStore(database);
  const requestedByUserId = options.dependencies.requestedByUserId ?? databaseDemoUserIds.leader;

  // 预检：分配标签必须是活跃目录标签（与正式写入路径的 hasTags 一致），
  // 失败发生在任何任务创建之前。
  if (!(await new DatabaseDataStore(database).hasTags([options.dependencies.assignedTagId]))) {
    throw new HistoryMigrationError(
      "INVALID_ARGUMENTS",
      "分配的知识点标签不是活跃标签；导入没有开始。",
    );
  }

  const failedCandidateIds: string[] = [];
  const failedCandidates: ImportHistoryPackagesFailedCandidate[] = [];
  let skippedCount = 0;

  for (const packageEntry of report.packages) {
    if (entries.has(packageEntry.candidateId)) {
      skippedCount += 1;
      continue;
    }
    try {
      const entry = await importSinglePackage({
        packageEntry,
        packageDirectory: options.packageDirectory,
        outputDirectory: options.outputDirectory,
        writer,
        jobStore,
        storage,
        store,
        database,
        requestedByUserId,
        assignedTagId: options.dependencies.assignedTagId,
        ...(options.dependencies.now === undefined ? {} : { now: options.dependencies.now }),
      });
      entries.set(entry.candidateId, entry);
      importedThisRun += 1;
    } catch (error) {
      // 单个包失败不影响其余包；失败项不会进入清单，重跑会重试。
      // 只记录稳定消毒码，绝不记录原始错误（可能含路径、题面片段或上游正文）。
      const code = error instanceof HistoryMigrationError ? error.code : "internal_failure";
      if (process.env.HISTORY_IMPORT_DEBUG === "1") {
        console.error("importItemFailed", packageEntry.candidateId, code);
      }
      failedCandidateIds.push(packageEntry.candidateId);
      failedCandidates.push({ candidateId: packageEntry.candidateId, code });
    }
  }

  // 清单随着每次运行更新（含重跑补入的条目）。累计导入数就是当前 entries
  // 的大小：它包含本次运行前仍有效的条目加上本次新导入的条目。修复包后
  // 旧条目（packageSha256 不再匹配）不计入。
  const cumulativeImportedCount = entries.size;
  const manifestPayload: ImportManifestPayload = {
    version: 1,
    phase: "import",
    batchSha256: report.batchSha256,
    importedCount: cumulativeImportedCount,
    entries: [...entries.values()],
  };
  const manifestPayloadJson = JSON.stringify(manifestPayload);
  const manifestDigest = payloadDigest(manifestPayloadJson);

  const completePayload: ImportCompletePayload = {
    version: 1,
    phase: "import",
    batchSha256: report.batchSha256,
    packageCount: report.packages.length,
    importedCount: cumulativeImportedCount,
  };
  const completePayloadJson = JSON.stringify(completePayload);
  const completeDigest = payloadDigest(completePayloadJson);

  // ── 批次发布日志：持久化 pending/confirmed 阶段 ──
  // 日志绑定 batchSha256 身份和清单/完成标记载荷摘要。
  // 响应丢失后重跑时，通过日志阶段判断已发布效果，避免重复写入。
const batchJournalPath = join(options.outputDirectory, batchPublicationFileName);
  const existingBatch = await readExistingBatchPublication(batchJournalPath);
  // 清单发布确认判定：同一批次身份 + 清单载荷摘要 + 阶段已越过 manifest_publish_confirmed。
  const manifestAlreadyPublished =
    existingBatch !== undefined &&
    existingBatch.batchSha256 === report.batchSha256 &&
    existingBatch.manifestPayloadDigest === manifestDigest &&
    (existingBatch.phase === "manifest_publish_confirmed" ||
      existingBatch.phase === "complete_publish_pending" ||
      existingBatch.phase === "complete_publish_confirmed");
  // 完成标记发布确认判定：同一批次身份 + 双载荷摘要 + 阶段已到 complete_publish_confirmed。
  const completeAlreadyConfirmed =
    existingBatch !== undefined &&
    existingBatch.batchSha256 === report.batchSha256 &&
    existingBatch.manifestPayloadDigest === manifestDigest &&
    existingBatch.completePayloadDigest === completeDigest &&
    existingBatch.phase === "complete_publish_confirmed";

  // ── 故障关闭发布顺序 ──
  // 1. 先失效旧完成标记：在任何新清单写入之前移除既有标记。
  //    这关闭了"新清单已发布但旧标记仍存在"的崩溃窗口——
  //    如果在第 2 步或第 3 步之间崩溃，不会有残留的旧批次标记。
  // 2. 写入新清单（覆盖）。
  // 3. 仅当全部成功时发布新完成标记；有失败则保持标记已移除状态。
  // 不变的已确认重放（批次身份+双摘要+complete_publish_confirmed）跳过
  // 整个发布序列——既不重写清单也不移除完成标记，避免误删持久标记。
  const completePath = join(options.outputDirectory, importCompleteFileName);

  // 清单发布：pending 日志 → 写清单 → confirmed 日志（响应丢失后重跑跳过已确认效果）。
  if (!manifestAlreadyPublished) {
    // 仅在要写入新清单时先失效旧完成标记（故障关闭顺序）。
    await publisher.removeComplete(completePath);

    await writeBatchPublication(batchJournalPath, {
      version: 1,
      batchSha256: report.batchSha256,
      manifestPayloadDigest: manifestDigest,
      completePayloadDigest: completeDigest,
      phase: "manifest_publish_pending",
    });

    await publisher.writeManifest(manifestPath, manifestPayloadJson);

    await writeBatchPublication(batchJournalPath, {
      version: 1,
      batchSha256: report.batchSha256,
      manifestPayloadDigest: manifestDigest,
      completePayloadDigest: completeDigest,
      phase: "manifest_publish_confirmed",
    });
  }
  if (failedCandidateIds.length === 0 && !completeAlreadyConfirmed) {
    // 完成标记发布：pending 日志 → 写标记 → confirmed 日志（仅当效果尚未确认）。
    await writeBatchPublication(batchJournalPath, {
      version: 1,
      batchSha256: report.batchSha256,
      manifestPayloadDigest: manifestDigest,
      completePayloadDigest: completeDigest,
      phase: "complete_publish_pending",
    });

    await publisher.writeComplete(completePath, completePayloadJson);

    await writeBatchPublication(batchJournalPath, {
      version: 1,
      batchSha256: report.batchSha256,
      manifestPayloadDigest: manifestDigest,
      completePayloadDigest: completeDigest,
      phase: "complete_publish_confirmed",
    });
  }

  return {
    packageCount: report.packages.length,
    importedCount: importedThisRun,
    skippedCount,
    failedCount: failedCandidateIds.length,
    failedCandidateIds,
    failedCandidates,
  };
}

// ---------------------------------------------------------------------------
// 单包导入
// ---------------------------------------------------------------------------

async function importSinglePackage(input: {
  readonly packageEntry: PackageReportEntry;
  readonly packageDirectory: string;
  readonly outputDirectory: string;
  readonly writer: AtomicImportedProblemWriter;
  readonly jobStore: HistoryImportJobStore;
  readonly storage: FileStorage;
  readonly store: HistoryImportStore;
  readonly database: DatabaseHandle;
  readonly requestedByUserId: string;
  readonly assignedTagId: string;
  readonly now?: () => Date;
}): Promise<ImportManifestEntry> {
  // 有界读取：先用 O_NOFOLLOW 打开并 stat 实际大小，与包报告声明的
  // packageBytes 比对，再与硬上限比对，三者一致后才读入内存。防止私有
  // 目录被替换成符号链接或超大文件后造成无界分配。
  const packagePath = join(
    input.packageDirectory,
    "packages",
    `${input.packageEntry.candidateId}.zip`,
  );
  let bytes: Uint8Array;
  try {
    const handle = await open(packagePath, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const stat = await handle.stat();
      if (!stat.isFile()) {
        throw new HistoryMigrationError("CANDIDATE_NOT_FOUND", "题目包文件不是普通文件。");
      }
      if (stat.size !== input.packageEntry.packageBytes) {
        throw new HistoryMigrationError("SOURCE_DIGEST_MISMATCH", "题目包大小与包报告不一致。");
      }
      if (stat.size > maximumImportPackageBytes) {
        throw new HistoryMigrationError("SOURCE_TOO_LARGE", "题目包文件超过导入硬上限。");
      }
      const buffer = await handle.readFile();
      bytes = new Uint8Array(buffer);
    } finally {
      await handle.close();
    }
  } catch (error) {
    if (error instanceof HistoryMigrationError) throw error;
    throw new HistoryMigrationError("CANDIDATE_NOT_FOUND", "题目包文件不存在或不可读。");
  }
  if (bytes.byteLength !== input.packageEntry.packageBytes) {
    throw new HistoryMigrationError("SOURCE_DIGEST_MISMATCH", "题目包大小与包报告不一致。");
  }
  if (sha256Hex(bytes) !== input.packageEntry.packageSha256) {
    throw new HistoryMigrationError("SOURCE_DIGEST_MISMATCH", "题目包内容与包报告不一致。");
  }

  // 安全解包：嵌套压缩包一律拒绝；其余限制与平台默认一致。
  let archive: SafeArchive;
  try {
    archive = readZipArchive(bytes, { allowNestedArchives: false });
  } catch {
    throw new HistoryMigrationError("CANDIDATE_INVALID", "题目包没有通过压缩包安全检查。");
  }

  // urmotiv 原生适配器转换。
  const canonical = await urmotivNativeAdapter.import(archive, {
    conflictAction: "create",
  });

  // 历史整理模型不选标签：按操作员指定注入目录标签。
  const problem: CanonicalProblem = canonicalProblemSchema.parse({
    ...canonical,
    tags: [input.assignedTagId],
  });

  // 源意图日志 v2：在 staging 前原子排他创建，绑定固定存储 UUID 和完整身份。
  const journalDir = join(input.outputDirectory, "journal");
  const sourceIntentPath = join(journalDir, `${input.packageEntry.candidateId}.private.json`);
  await mkdir(journalDir, { mode: 0o700, recursive: true });
  const sourceBindingKey = entrySourceBindingKey(input.packageEntry);
  const importChoices = { conflictAction: "create" as const };
  const canonicalChoicesDigest = choicesDigestOf(importChoices);
  const sourceIntentExpected: SourceIntentExpected = {
    selectedFormat: urmotivNativeAdapter.id,
    selectedFormatVersion: urmotivNativeAdapter.version,
    idempotencyKey: sourceBindingKey,
    clientRequestDigest: sourceBindingKey,
    inputDigest: input.packageEntry.packageSha256,
    choicesDigest: canonicalChoicesDigest,
    requestedByUserId: input.requestedByUserId,
  };

  // 读取既有日志（判别 absent/v1/v2），处理升级/创建，最终获得规范载荷。
  // 绝不使用调用方预生成的 UUID/audit——只使用规范持久化载荷中的值。
  let journal: SourceIntentPayload;
  const existingRead = await readExistingSourceIntent(sourceIntentPath, input.packageEntry, sourceIntentExpected);
  if (existingRead.kind === "v2") {
    journal = existingRead.payload;
  } else if (existingRead.kind === "v1") {
    // v1 升级：保留 v1 UUID，派生确定性审计 ID，写入 v2 并重新读取规范结果。
    const upgraded = upgradeV1ToV2Payload(existingRead.identity, input.packageEntry, sourceIntentExpected);
    journal = await createSourceIntentExclusively(sourceIntentPath, upgraded, input.packageEntry, sourceIntentExpected);
  } else {
    // absent：首次创建。身份在 establishNewSourceIntent 内部生成，调用方不接触随机值。
    // 竞争者可能获胜，只使用返回的规范载荷。
    journal = await establishNewSourceIntent(sourceIntentPath, input.packageEntry, sourceIntentExpected, nativeProblemMediaType);
  }
  // ── 发布前幂等命中检查：在发布存储对象前，检查是否已有规范 import job。
  // 如果已存在（真正的前序提交或并发获胜方），验证本竞争者的 journal 身份
  // 是否匹配获胜方的 sourceFileId——不匹配则 fail-closed（零物理对象、零存储行）。
  const preExistingJob = await input.jobStore.findImportJobForReplay({
    requestedByUserId: input.requestedByUserId,
    idempotencyKey: sourceBindingKey,
    clientRequestDigest: sourceBindingKey,
  });
  if (preExistingJob !== undefined) {
    // 已有规范 import job：验证 journal UUID 是否匹配获胜方 sourceFileId。
    // 不匹配 → fail-closed，零物理对象/零存储行。
    validateReplayJobIdentity(preExistingJob, journal, journal.storageUuid, input.packageEntry, sourceIntentExpected);
  }

  // 只使用规范日志中的 UUID/audit——确定性派生确保独立竞争者收敛至同一 UUID。
  const sourceIntentUuid = journal.storageUuid;
  const auditRequestId = journal.auditRequestId;
  // ── 效果边界 1：存储发布 ──
  // 写入 pending 阶段（单调前进，已确认时为 no-op）。
  journal = await advanceSourceIntentPhase(sourceIntentPath, input.packageEntry, sourceIntentExpected, { phase: "storage_publish_pending" });

  // 使用规范日志 UUID 发布原始包到对象存储（可重放）。
  // 确定性 UUID 确保独立竞争者收敛至同一最终对象键 objects/<id>。
  // 每个竞争者使用自己的 staging 路径（所有权安全），原子 publish 选出一个完整对象。
  const staged = await input.storage.stage({
    originalName: `${input.packageEntry.candidateId}.zip`,
    mediaType: nativeProblemMediaType,
    content: bytesOnce(bytes),
    id: sourceIntentUuid,
  });
  let stored;
  try {
    stored = await input.storage.publish(staged);
  } catch (error) {
    const cleanupErr = await attemptCleanup(() => input.storage.discard(staged));
    throw withCleanupError(error, cleanupErr);
  }

  const sourceFileId = stored.id;

  // 验证发布对象与日志绑定的存储键一致。
  if (stored.storageKey !== journal.expectedStorageKey) {
    throw new HistoryMigrationError(
      "SOURCE_INTENT_MISMATCH",
      "存储对象键与日志绑定不匹配；拒绝继续。",
    );
  }
  // 存储发布已确认：写入 confirmed 阶段。
  journal = await advanceSourceIntentPhase(sourceIntentPath, input.packageEntry, sourceIntentExpected, { phase: "storage_publish_confirmed" });
  const existingFile = await input.store.findStoredFile(sourceFileId);
  // ── 效果边界 2：stored_files 行写入 ──
  // 写入 pending 阶段（单调前进，已确认时为 no-op）。
  journal = await advanceSourceIntentPhase(sourceIntentPath, input.packageEntry, sourceIntentExpected, { phase: "stored_file_create_pending" });
  if (existingFile !== undefined) {
    validateStoredFileIdentity(existingFile, journal, stored, input.requestedByUserId);
  } else {
    // 行不存在：安全补写（UUID 已由日志绑定）。
    try {
      await input.store.createStoredFile({
        id: sourceFileId,
        purpose: "import_input",
        storageKey: stored.storageKey,
        originalName: `${input.packageEntry.candidateId}.zip`,
        mediaType: nativeProblemMediaType,
        byteSize: stored.byteSize,
        sha256: stored.sha256,
        createdByUserId: input.requestedByUserId,
      });
    } catch {
      // 创建可能已成功（响应丢失）：回查验证。绝不删除已发布对象。
      const recovered = await input.store.findStoredFile(sourceFileId);
      if (recovered !== undefined) {
        validateStoredFileIdentity(recovered, journal, stored, input.requestedByUserId);
      } else {
        // 行确实不存在：保留已发布对象，返回稳定恢复态。
        throw new HistoryMigrationError(
          "RECOVERY_PENDING",
          "stored_files 写入失败，已发布对象已保留；请重试。",
        );
      }
    }
  }
  // stored_files 行已确认：写入 confirmed 阶段。
  journal = await advanceSourceIntentPhase(sourceIntentPath, input.packageEntry, sourceIntentExpected, { phase: "stored_file_create_confirmed" });

  // 创建导入任务（幂等键=包摘要；同包重复创建返回既有任务）。
  // ── 效果边界 3：导入任务创建 ──
  // 写入 pending 阶段（单调前进，已确认时为 no-op）。
  journal = await advanceSourceIntentPhase(sourceIntentPath, input.packageEntry, sourceIntentExpected, { phase: "job_create_pending" });
  let job;
  try {
    job = await input.jobStore.createImportJob({
      requestedByUserId: input.requestedByUserId,
      clientRequestDigest: sourceBindingKey,
      sourceFileId,
      inputDigest: input.packageEntry.packageSha256,
      selectedFormat: urmotivNativeAdapter.id,
      selectedFormatVersion: urmotivNativeAdapter.version,
      choices: importChoices,
      itemCount: 1,
      idempotencyKey: sourceBindingKey,
      auditRequestId,
    });
    // 立即验证 createImportJob 返回值的身份字段（不含 audit/items）。
    validateCreatedJobIdentity(job, journal, sourceFileId, input.packageEntry, sourceIntentExpected);
    // 重新查询类型化回查信封并验证 audit/items + 与返回 job 精确相等。
    // 成功创建后缺失类型化回查信封 = 持久化不可验证 → fail-closed（稳定消毒码）。
    // 审计/条目持久化是强制性要求，不可选跳过。
    const successReplay = await input.jobStore.findImportJobForReplay({
      requestedByUserId: input.requestedByUserId,
      idempotencyKey: sourceBindingKey,
      clientRequestDigest: sourceBindingKey,
    });
    if (successReplay === undefined) {
      throw new HistoryMigrationError(
        "SOURCE_INTENT_MISMATCH",
        "创建成功但回查信封缺失；审计/条目持久化不可验证，拒绝继续。",
      );
    }
    validateReplayJobIdentity(successReplay, journal, sourceFileId, input.packageEntry, sourceIntentExpected);
    validateCreatedJobEqualsReplay(job, successReplay);
    // 任务创建已确认：写入 confirmed 阶段，持久化 jobId。
    journal = await advanceSourceIntentPhase(sourceIntentPath, input.packageEntry, sourceIntentExpected, { phase: "job_create_confirmed", jobId: job.id });
  } catch (error) {
    // 身份验证失败（createImportJob 返回值或回查不匹配）→ 立即 fail-closed，不尝试恢复。
    if (error instanceof HistoryMigrationError && error.code === "SOURCE_INTENT_MISMATCH") {
      throw error;
    }
    // 如果任务已提交，绝不删除已提交的源状态——直接使用既有任务。
    const committed = await input.jobStore.findImportJobForReplay({
      requestedByUserId: input.requestedByUserId,
      idempotencyKey: sourceBindingKey,
      clientRequestDigest: sourceBindingKey,
    });
    if (committed !== undefined) {
      // 任务已提交：响应丢失。验证全部绑定身份匹配（含审计/条目/位置）。
      validateReplayJobIdentity(committed, journal, sourceFileId, input.packageEntry, sourceIntentExpected);
      // 验证源元数据仍然完整匹配。
      const replayFile = await input.store.findStoredFile(sourceFileId);
      if (replayFile !== undefined) {
        validateStoredFileIdentity(replayFile, journal, stored, input.requestedByUserId);
        job = committed.job;
        // 任务已提交（响应丢失恢复）：写入 confirmed 阶段，持久化 jobId。
        journal = await advanceSourceIntentPhase(sourceIntentPath, input.packageEntry, sourceIntentExpected, { phase: "job_create_confirmed", jobId: job.id });
      } else {
        throw new HistoryMigrationError(
          "SOURCE_INTENT_MISMATCH",
          "任务已提交但源元数据行缺失；拒绝继续。",
        );
      }
    } else {
      // 任务确实未创建：保留源状态用于重试（不删除）。
      throw new HistoryMigrationError(
        "RECOVERY_PENDING",
        "任务创建失败，源状态已保留；请重试。",
        { cause: error instanceof Error ? error : undefined },
      );
    }
  }

  // ── 认领/恢复导入任务（围栏）──
  // 用 claimOrRecoverImportJob 原子地认领任务，获得租约 token。
  // queued → claimed（新租约）；running+active → busy（另一进程持有）；
  // running+expired → claimed（递增 attempt，换新 token）；
  // failed → claimed（安全重置）；succeeded → reconstruct（不重写）。
  const leaseDurationMs = 30_000;
  const claim = await input.jobStore.claimOrRecoverImportJob({
    jobId: job.id,
    leaseDurationMs,
  });
  if (claim === undefined) {
    throw new HistoryMigrationError("CANDIDATE_CHANGED", "导入任务不存在。");
  }
  if (claim.kind === "busy") {
    throw new HistoryMigrationError("LEASE_BUSY", "导入任务正在被另一个进程执行。");
  }
  if (claim.kind === "cancelled") {
    throw new HistoryMigrationError("CANDIDATE_CHANGED", "导入任务已取消。");
  }
  if (claim.kind === "reconstruct") {
    // 任务已成功完成：既有 imported_problem_id 即为最终结果，不重写。
    const item = claim.items.find((it) => it.position === 0);
    if (item === undefined || item.importedProblemId === null) {
      throw new HistoryMigrationError("CANDIDATE_CHANGED", "重建结果缺少已提交条目。");
    }
    // 任务已成功完成（重建）：确保日志处于 writer_commit_confirmed 阶段，持久化 problemId。
    journal = await advanceSourceIntentPhase(sourceIntentPath, input.packageEntry, sourceIntentExpected, { phase: "writer_commit_confirmed", problemId: item.importedProblemId });
    return {
      candidateId: input.packageEntry.candidateId,
      packageSha256: input.packageEntry.packageSha256,
      importJobId: job.id,
      problemId: item.importedProblemId,
      importedAt: (input.now ?? defaultNow)().toISOString(),
    };
  }

  // claim.kind === "claimed"：持有租约 leaseId，执行写入。
  const leaseId = claim.leaseId;
  const abortController = new AbortController();
  let result: { readonly problemId: string } | undefined;
  // ── 效果边界 4：写入器提交 ──
  // 写入 pending 阶段（单调前进，已确认时为 no-op）。
  journal = await advanceSourceIntentPhase(sourceIntentPath, input.packageEntry, sourceIntentExpected, { phase: "writer_commit_pending" });
  try {
    // 心跳续租：在写入期间定期续租，租约丢失时中止写入。
    const heartbeat = startHeartbeat(input.jobStore, job.id, leaseId, leaseDurationMs, abortController);
    try {
      result = await input.writer.write({
        importJobId: job.id,
        position: 0,
        requestedByUserId: input.requestedByUserId,
        choices: { conflictAction: "create" },
        problem,
        signal: abortController.signal,
        leaseId,
      });
    } finally {
      clearInterval(heartbeat.timer);
    }
  } catch (error) {
    // 写入可能已成功（响应丢失）：先检查围栏条目/任务持久状态。
    // 如果条目已有 imported_problem_id，写入已提交——恢复已提交成功，不做失败变异。
    const items = await input.jobStore.getImportItems(job.id);
    const item = items.find((it) => it.position === 0);
    if (item !== undefined && item.importedProblemId !== null && item.state === "succeeded") {
      // 写入已成功提交：恢复已提交成功，不做任何失败变异。
      const committed = await input.jobStore.getImportJob(job.id);
      if (committed?.state === "succeeded") {
        journal = await advanceSourceIntentPhase(sourceIntentPath, input.packageEntry, sourceIntentExpected, { phase: "writer_commit_confirmed", problemId: item.importedProblemId });
        return {
          candidateId: input.packageEntry.candidateId,
          packageSha256: input.packageEntry.packageSha256,
          importJobId: job.id,
          problemId: item.importedProblemId,
          importedAt: (input.now ?? defaultNow)().toISOString(),
        };
      }
      // 条目已成功但任务尚未标记完成：用围栏完成。
      const completed = await input.jobStore.fencedCompleteImportJob({
        jobId: job.id,
        leaseId,
        report: importCompleteReport(),
      });
      if (completed || (await input.jobStore.getImportJob(job.id))?.state === "succeeded") {
        journal = await advanceSourceIntentPhase(sourceIntentPath, input.packageEntry, sourceIntentExpected, { phase: "writer_commit_confirmed", problemId: item.importedProblemId });
        return {
          candidateId: input.packageEntry.candidateId,
          packageSha256: input.packageEntry.packageSha256,
          importJobId: job.id,
          problemId: item.importedProblemId,
          importedAt: (input.now ?? defaultNow)().toISOString(),
        };
      }
      // 围栏完成失败且任务不是 succeeded：租约已失效，另一进程可能已处理。
      throw new HistoryMigrationError("LEASE_LOST", "写入完成时租约已失效。");
    }
    // 写入确实未提交：围栏标记条目+任务失败（原子、在同一事务内）。
    const fenced = await fencedFailImportJobSafely(input.jobStore, job.id, leaseId, 0, error);
    if (!fenced) {
      // 租约已失效但任务可能已被另一个进程完成。
      const committed = await input.jobStore.getImportJob(job.id);
      if (committed?.state === "succeeded") {
        const problemId = result?.problemId ?? (await getImportedProblemId(input.jobStore, job.id));
        journal = await advanceSourceIntentPhase(sourceIntentPath, input.packageEntry, sourceIntentExpected, { phase: "writer_commit_confirmed", problemId });
        return {
          candidateId: input.packageEntry.candidateId,
          packageSha256: input.packageEntry.packageSha256,
          importJobId: job.id,
          problemId,
          importedAt: (input.now ?? defaultNow)().toISOString(),
        };
      }
    }
    throw error;
  }

  // 完成任务。写入事务本身已经保存 importedProblemId 和条目成功状态；
  // 无需再调用未围栏的 recordImportItem。若任务已被先前运行标记完成
  // （幂等重放），以既有提交结果为准。
  const completed = await input.jobStore.fencedCompleteImportJob({
    jobId: job.id,
    leaseId,
    report: importCompleteReport(),
  });
  if (!completed) {
    // 租约已失效但任务可能已被另一个进程完成。
    const committed = await input.jobStore.getImportJob(job.id);
    if (committed?.state !== "succeeded") {
      throw new HistoryMigrationError("LEASE_LOST", "写入完成时租约已失效。");
    }
  }

  // 写入器提交已确认：写入 confirmed 阶段，持久化 problemId。
  journal = await advanceSourceIntentPhase(sourceIntentPath, input.packageEntry, sourceIntentExpected, { phase: "writer_commit_confirmed", problemId: result!.problemId });
  return {
    candidateId: input.packageEntry.candidateId,
    packageSha256: input.packageEntry.packageSha256,
    importJobId: job.id,
    problemId: result!.problemId,
    importedAt: (input.now ?? defaultNow)().toISOString(),
  };
}

/**
 * 心跳续租句柄。
 */
interface HeartbeatHandle {
  readonly timer: NodeJS.Timeout;
  readonly renew: () => Promise<void>;
}

function startHeartbeat(
  store: HistoryImportJobStore,
  jobId: string,
  leaseId: string,
  leaseDurationMs: number,
  controller: AbortController,
): HeartbeatHandle {
  const intervalMs = Math.max(1_000, Math.floor(leaseDurationMs / 3));
  const renew = async (): Promise<void> => {
    try {
      const ok = await store.renewImportJobLease({ jobId, leaseId, leaseDurationMs });
      if (!ok) {
        controller.abort();
      }
    } catch {
      controller.abort();
    }
  };
  const timer = setInterval(() => {
    void renew();
  }, intervalMs);
  return { timer, renew };
}

/**
 * 围栏标记条目+任务失败：原子地在同一事务内记录条目失败状态和任务失败状态。
 * 只有持有未过期租约者才能成功。返回 true 表示成功围栏标记，false 表示租约已失效。
 * 不使用 .catch(()=>undefined)：调用方根据返回值决定是否抛出。
 */
async function fencedFailImportJobSafely(
  recoveryStore: HistoryImportJobStore,
  jobId: string,
  leaseId: string,
  position: number,
  error: unknown,
): Promise<boolean> {
  const code =
    error instanceof ImportAccessRevokedError ? "import_access_revoked" : "internal_failure";
  try {
    return await recoveryStore.fencedFailImportJob({
      jobId,
      leaseId,
      position,
      code,
      report: importFailedReport(),
    });
  } catch {
    // fencedFailImportJob 抛出说明数据库异常，租约状态不确定。
    // 调用方会检查 getImportJob 判断实际状态。
    return false;
  }
}

/**
 * 获取已导入题目 ID（用于写入完成但租约失效后的回查）。
 */
async function getImportedProblemId(
  jobStore: HistoryImportJobStore,
  jobId: string,
): Promise<string> {
  const items = await jobStore.getImportItems(jobId);
  const item = items.find((it) => it.position === 0);
  if (item?.importedProblemId !== null && item?.importedProblemId !== undefined) {
    return item.importedProblemId;
  }
  return "";
}

// ---------------------------------------------------------------------------
// 源意图日志 v2：持久化、经过消毒的状态机
// ---------------------------------------------------------------------------

/**
 * 计算导入选择的规范化摘要。完整 choices 对象的 JSON 规范化形式（键排序）的 SHA-256。
 * 包含 conflictAction、targetProblemId、values——防止持久化后篡改任意字段。
 * 不使用字面量 "create"——必须是可验证的密码学摘要。
 */
function choicesDigestOf(choices: ProblemPackageImportChoices): string {
  return sha256Hex(stableJsonStringify(choices));
}

/**
 * 递归生成键排序的 JSON 字符串，确保相同内容产生相同摘要。
 */
function stableJsonStringify(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableJsonStringify).join(",")}]`;
  }
  const keys = Object.keys(value as Record<string, unknown>).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableJsonStringify((value as Record<string, unknown>)[k])}`).join(",")}}`;
}

/**
 * 从完整稳定操作身份确定性派生存储 UUID（RFC 4122 UUID v5）。
 * 绑定 requester + package/input/client/idempotency digest + format/version + choicesDigest。
 * 独立竞争者（不同 output 目录）派生相同 UUID → 同一 staging/objects 路径 → 单一物理对象。
 * v1 升级保留 v1 UUID（不重新派生）。
 */
const HISTORY_IMPORT_STORAGE_NAMESPACE_UUID = "6ba7b812-9dad-11d1-80b4-00c04fd430c8";
function deterministicSourceStorageUuid(expected: SourceIntentExpected): string {
  return uuidV5(
    HISTORY_IMPORT_STORAGE_NAMESPACE_UUID,
    `${expected.requestedByUserId}:${expected.idempotencyKey}:${expected.clientRequestDigest}:${expected.inputDigest}:${expected.selectedFormat}:${expected.selectedFormatVersion}:${expected.choicesDigest}`,
  );
}

/**
 * 从完整稳定操作身份确定性派生稳定审计请求 ID（RFC 4122 UUID v5）。
 * 绑定 requester + package/input/client/idempotency digest + format/version + choicesDigest。
 * 独立竞争者派生相同 auditRequestId——无需依赖 storageUuid 作为中间值。
 * v1 升级时使用 deterministicAuditRequestIdFromUuid 保留 v1 UUID 的确定性派生。
 */
const HISTORY_IMPORT_AUDIT_NAMESPACE_UUID = "6ba7b810-9dad-11d1-80b4-00c04fd430c8";
function deterministicAuditRequestId(expected: SourceIntentExpected): string {
  return uuidV5(
    HISTORY_IMPORT_AUDIT_NAMESPACE_UUID,
    `${expected.requestedByUserId}:${expected.idempotencyKey}:${expected.clientRequestDigest}:${expected.inputDigest}:${expected.selectedFormat}:${expected.selectedFormatVersion}:${expected.choicesDigest}`,
  );
}

/**
 * v1 升级专用：从完整规范操作身份 + v1 保留 UUID 派生确定性审计请求 ID。
 * v1 日志没有审计 ID；并发升级者必须派生出相同的 ID。
 * 绑定完整 SourceIntentExpected 操作身份（requester + 所有摘要 + format/version + choices）
 * 以及 v1 保留的 storageUuid——不兼容的竞争者派生出不兼容的 audit ID，
 * 只有持久化获胜方的载荷才能通过后续回查验证并继续。
 */
function deterministicAuditRequestIdFromUuid(
  expected: SourceIntentExpected,
  storageUuid: string,
): string {
  return uuidV5(
    HISTORY_IMPORT_AUDIT_NAMESPACE_UUID,
    `${expected.requestedByUserId}:${expected.idempotencyKey}:${expected.clientRequestDigest}:${expected.inputDigest}:${expected.selectedFormat}:${expected.selectedFormatVersion}:${expected.choicesDigest}:${storageUuid}`,
  );
}

/**
 * RFC 4122 UUID v5（SHA-1 命名空间 + 名称）。
 * Node 的 crypto.randomUUID 只支持 v4，这里手动实现 v5。
 */
function uuidV5(namespaceUuid: string, name: string): string {
  const namespaceBytes = parseUuidBytes(namespaceUuid);
  const nameBytes = new TextEncoder().encode(name);
  const data = new Uint8Array(namespaceBytes.length + nameBytes.length);
  data.set(namespaceBytes);
  data.set(nameBytes, namespaceBytes.length);
  const hash = createHash("sha1").update(data).digest();
  hash[6] = (hash[6]! & 0x0f) | 0x50; // version 5
  hash[8] = (hash[8]! & 0x3f) | 0x80; // variant 10
  const hex = Buffer.from(hash).toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

function parseUuidBytes(uuid: string): Uint8Array {
  const hex = uuid.replaceAll("-", "");
  const bytes = new Uint8Array(16);
  for (let i = 0; i < 16; i++) {
    bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

/**
 * 候选级源摄入阶段。每个阶段代表一个效果边界：
 * - pending = 效果前写入的持久化不确定标记（崩溃/响应丢失后可恢复）。
 * - confirmed = 效果已提交并验证。
 *
 * 日志是 pre/post-effect 真相源。并发尝试通过原子排他创建选择 UUID；
 * 失败方重新读取获胜方日志。v1 日志解析为 `intent_confirmed` 并保留其 UUID。
 */
const SOURCE_INTENT_PHASES = [
  "intent_confirmed",
  "storage_publish_pending",
  "storage_publish_confirmed",
  "stored_file_create_pending",
  "stored_file_create_confirmed",
  "job_create_pending",
  "job_create_confirmed",
  "writer_commit_pending",
  "writer_commit_confirmed",
] as const;
type SourceIntentPhase = (typeof SOURCE_INTENT_PHASES)[number];

const SOURCE_INTENT_PHASE_ORDER: Readonly<Record<SourceIntentPhase, number>> = Object.fromEntries(
  SOURCE_INTENT_PHASES.map((p, i) => [p, i]),
) as Readonly<Record<SourceIntentPhase, number>>;

/** 批次发布阶段。 */
const BATCH_PHASES = [
  "manifest_publish_pending",
  "manifest_publish_confirmed",
  "complete_publish_pending",
  "complete_publish_confirmed",
] as const;
type BatchPhase = (typeof BATCH_PHASES)[number];

/**
 * 源意图日志 v2 载荷。
 * 绑定候选/包摘要+字节数、固定存储 UUID、预期存储键/名称/媒体/用途/请求者、
 * 幂等/客户端摘要、格式+版本、choices 摘要、itemCount=1/position=0、
 * 稳定审计请求 ID、确认的 job/problem ID（已知时）。
 * 不含原始错误/路径/内容。
 */
interface SourceIntentPayload {
  readonly version: 2;
  readonly candidateId: string;
  readonly packageSha256: string;
  readonly packageBytes: number;
  readonly storageUuid: string;
  readonly expectedStorageKey: string;
  readonly originalName: string;
  readonly mediaType: string;
  readonly purpose: "import_input";
  readonly requestedByUserId: string;
  readonly idempotencyKey: string;
  readonly clientRequestDigest: string;
  readonly inputDigest: string;
  readonly selectedFormat: string;
  readonly selectedFormatVersion: string;
  readonly choicesDigest: string;
  readonly itemCount: 1;
  readonly position: 0;
  readonly auditRequestId: string;
  readonly phase: SourceIntentPhase;
  readonly jobId: string | null;
  readonly problemId: string | null;
}

/** v1 日志载荷（向后兼容解析为 `intent_confirmed`）。 */
interface SourceIntentPayloadV1 {
  readonly version: 1;
  readonly candidateId: string;
  readonly packageSha256: string;
  readonly packageBytes: number;
  readonly storageUuid: string;
  readonly originalName: string;
  readonly mediaType: string;
}

const sourceIntentV1Schema = z
  .object({
    version: z.literal(1),
    candidateId: z.string().regex(/^candidate-[0-9]{6}$/),
    packageSha256: digestSchema,
    packageBytes: z.number().int().min(0).max(256 * 1024 * 1024),
    storageUuid: z.string().uuid(),
    originalName: z.string().min(1).max(400),
    mediaType: z.string().min(1).max(100),
  })
  .strict();

const sourceIntentV2Schema = z
  .object({
    version: z.literal(2),
    candidateId: z.string().regex(/^candidate-[0-9]{6}$/),
    packageSha256: digestSchema,
    packageBytes: z.number().int().min(0).max(256 * 1024 * 1024),
    storageUuid: z.string().uuid(),
    expectedStorageKey: z.string().min(1).max(400),
    originalName: z.string().min(1).max(400),
    mediaType: z.string().min(1).max(100),
    purpose: z.literal("import_input"),
    requestedByUserId: z.string().min(1),
    idempotencyKey: digestSchema,
    clientRequestDigest: digestSchema,
    inputDigest: digestSchema,
    selectedFormat: z.string().min(1).max(100),
    selectedFormatVersion: z.string().min(1).max(100),
    choicesDigest: z.string().min(1).max(128),
    itemCount: z.literal(1),
    position: z.literal(0),
    auditRequestId: z.string().uuid(),
    phase: z.enum(SOURCE_INTENT_PHASES),
    jobId: z.string().uuid().nullable(),
    problemId: z.string().nullable(),
  })
  .strict();

/** 批次发布日志载荷。 */
interface BatchPublicationPayload {
  readonly version: 1;
  readonly batchSha256: string;
  readonly manifestPayloadDigest: string;
  readonly completePayloadDigest: string;
  readonly phase: BatchPhase;
}

const batchPublicationSchema = z
  .object({
    version: z.literal(1),
    batchSha256: digestSchema,
    manifestPayloadDigest: digestSchema,
    completePayloadDigest: digestSchema,
    phase: z.enum(BATCH_PHASES),
  })
  .strict();

/**
 * 源意图日志读取结果（判别联合）。
 * - absent: 文件不存在（首次运行）。
 * - v1: 旧版日志，保留其 UUID/身份，需升级为 v2。
 * - v2: 新版日志，已包含完整绑定身份。
 */
type SourceIntentReadResult =
  | { readonly kind: "absent" }
  | { readonly kind: "v1"; readonly identity: SourceIntentPayloadV1 }
  | { readonly kind: "v2"; readonly payload: SourceIntentPayload };

/**
 * 源意图日志的期望身份绑定。所有字段必须在回放时与当前包报告匹配。
 */
interface SourceIntentExpected {
  readonly selectedFormat: string;
  readonly selectedFormatVersion: string;
  readonly idempotencyKey: string;
  readonly clientRequestDigest: string;
  readonly inputDigest: string;
  readonly choicesDigest: string;
  readonly requestedByUserId: string;
}

/**
 * v1→v2 升级使用排他 sidecar 文件（`.v2` 后缀），通过 O_EXCL 原子创建。
 * 所有并发升级者通过 writeNewPrivateJson 竞争同一个 sidecar；获胜者的载荷成为
 * 唯一规范 v2。失败者收到 OUTPUT_ALREADY_EXISTS 后回读 sidecar 并使用其内容。
 * 绝不覆盖既有文件——消除 split-brain。
 */
function sourceIntentV2SidecarPath(path: string): string {
  return `${path}.v2`;
}

/**
 * 读取既有源意图日志。
 * - 优先检查 v2 sidecar（升级后的规范 v2）：存在则验证并返回 v2。
 * - 原始文件不存在 → { kind: "absent" }（首次运行）。
 * - v1 日志 → { kind: "v1", identity } 验证候选/包摘要/字节数匹配后返回。
 *   保留其 UUID，不覆盖——调用方通过 sidecar 排他升级为 v2。
 * - v2 日志 → { kind: "v2", payload } 验证全部绑定字段匹配。
 * - 损坏/不可解析/版本未知/字段不匹配 → 抛出 SOURCE_INTENT_MISMATCH（fail-closed）。
 *   绝不静默覆盖：日志代表已发布到存储的 UUID，覆盖会导致孤立对象。
 */
async function readExistingSourceIntent(
  path: string,
  entry: PackageReportEntry,
  expected: SourceIntentExpected,
): Promise<SourceIntentReadResult> {
  // 优先检查 v2 sidecar（升级后的规范 v2）。
  const sidecarPath = sourceIntentV2SidecarPath(path);
  if (await privateRegularFileExists(sidecarPath)) {
    return readSourceIntentFile(sidecarPath, entry, expected);
  }
  if (!(await privateRegularFileExists(path))) return { kind: "absent" };
  return readSourceIntentFile(path, entry, expected);
}

/**
 * 从指定路径读取并解析源意图日志（v2 或 v1），验证字段匹配。
 */
async function readSourceIntentFile(
  path: string,
  entry: PackageReportEntry,
  expected: SourceIntentExpected,
): Promise<SourceIntentReadResult> {
  let raw: unknown;
  try {
    raw = await readPrivateJson(path);
  } catch {
    throw new HistoryMigrationError("SOURCE_INTENT_MISMATCH", "源意图日志不可读。");
  }
  // 尝试 v2 解析。
  const v2Result = sourceIntentV2Schema.safeParse(raw);
  if (v2Result.success) {
    const parsed = v2Result.data;
    if (
      parsed.candidateId !== entry.candidateId ||
      parsed.packageSha256 !== entry.packageSha256 ||
      parsed.packageBytes !== entry.packageBytes ||
      parsed.selectedFormat !== expected.selectedFormat ||
      parsed.selectedFormatVersion !== expected.selectedFormatVersion ||
      parsed.idempotencyKey !== expected.idempotencyKey ||
      parsed.clientRequestDigest !== expected.clientRequestDigest ||
      parsed.inputDigest !== expected.inputDigest ||
      parsed.choicesDigest !== expected.choicesDigest ||
      parsed.requestedByUserId !== expected.requestedByUserId
    ) {
      throw new HistoryMigrationError("SOURCE_INTENT_MISMATCH", "源意图日志与当前包报告不匹配。");
    }
    return { kind: "v2", payload: parsed };
  }
  // 尝试 v1 解析（向后兼容，保留 UUID 升级为 v2）。
  const v1Result = sourceIntentV1Schema.safeParse(raw);
  if (v1Result.success) {
    const parsed = v1Result.data;
    if (
      parsed.candidateId !== entry.candidateId ||
      parsed.packageSha256 !== entry.packageSha256 ||
      parsed.packageBytes !== entry.packageBytes
    ) {
      throw new HistoryMigrationError("SOURCE_INTENT_MISMATCH", "源意图日志 v1 与当前包报告不匹配。");
    }
    return { kind: "v1", identity: parsed };
  }
  // 未知版本或损坏。
  throw new HistoryMigrationError("SOURCE_INTENT_MISMATCH", "源意图日志版本未知或损坏。");
}

/**
 * 从 v1 身份构造完整 v2 载荷，保留 v1 的 UUID，用确定性审计 ID。
 * 并发升级者派生出相同的审计 ID（UUID v5），避免随机竞争。
 */
function upgradeV1ToV2Payload(
  v1: SourceIntentPayloadV1,
  entry: PackageReportEntry,
  expected: SourceIntentExpected,
): SourceIntentPayload {
  return {
    version: 2,
    candidateId: entry.candidateId,
    packageSha256: entry.packageSha256,
    packageBytes: entry.packageBytes,
    storageUuid: v1.storageUuid,
    expectedStorageKey: `objects/${v1.storageUuid}`,
    originalName: v1.originalName,
    mediaType: v1.mediaType,
    purpose: "import_input",
    requestedByUserId: expected.requestedByUserId,
    idempotencyKey: expected.idempotencyKey,
    clientRequestDigest: expected.clientRequestDigest,
    inputDigest: expected.inputDigest,
    selectedFormat: expected.selectedFormat,
    selectedFormatVersion: expected.selectedFormatVersion,
    choicesDigest: expected.choicesDigest,
    itemCount: 1,
    position: 0,
    auditRequestId: deterministicAuditRequestIdFromUuid(
      expected,
      v1.storageUuid,
    ),
    phase: "intent_confirmed",
    jobId: null,
    problemId: null,
  };
}
/**
 * 构建并排他创建首次源意图日志。身份（UUID + audit）从完整稳定操作身份
 * 确定性派生——独立竞争者派生相同 UUID/audit，收敛至同一物理对象。
 * 竞争者可能获胜（OUTPUT_ALREADY_EXISTS），此时重新读取获胜方日志。
 */
async function establishNewSourceIntent(
  path: string,
  entry: PackageReportEntry,
  expected: SourceIntentExpected,
  mediaType: string,
): Promise<SourceIntentPayload> {
  // 派生相同 UUID，收敛至同一 staging/objects 路径，产出单一物理对象。
  const storageUuid = deterministicSourceStorageUuid(expected);
  const auditRequestId = deterministicAuditRequestId(expected);
  const payload: SourceIntentPayload = {
    version: 2,
    candidateId: entry.candidateId,
    packageSha256: entry.packageSha256,
    packageBytes: entry.packageBytes,
    storageUuid,
    expectedStorageKey: `objects/${storageUuid}`,
    originalName: `${entry.candidateId}.zip`,
    mediaType,
    purpose: "import_input",
    requestedByUserId: expected.requestedByUserId,
    idempotencyKey: expected.idempotencyKey,
    clientRequestDigest: expected.clientRequestDigest,
    inputDigest: expected.inputDigest,
    selectedFormat: expected.selectedFormat,
    selectedFormatVersion: expected.selectedFormatVersion,
    choicesDigest: expected.choicesDigest,
    itemCount: 1,
    position: 0,
    auditRequestId,
    phase: "intent_confirmed",
    jobId: null,
    problemId: null,
  };
  return createSourceIntentExclusively(path, payload, entry, expected);
}

/**
 * 排他创建源意图日志。使用 writeNewPrivateJson（O_EXCL 语义）确保
 * 绝不覆盖既有文件。如果文件已存在（并发竞争或既有日志），重新读取获胜方。
 * v1 升级使用 sidecar 文件（`.v2` 后缀）的 O_EXCL 创建——所有并发升级者
 * 竞争同一个 sidecar，获胜者写入规范 v2，失败者回读并使用 sidecar 内容。
 * 绝不覆盖既有文件——消除 split-brain。仅捕获 OUTPUT_ALREADY_EXISTS；
 * 所有其他写入失败向上传播。返回最终规范载荷（自己写入或竞争者写入的）。
 */
async function createSourceIntentExclusively(
  path: string,
  payload: SourceIntentPayload,
  entry: PackageReportEntry,
  expected: SourceIntentExpected,
): Promise<SourceIntentPayload> {
  try {
    await writeNewPrivateJson(path, payload);
    // 绝不直接返回本地候选载荷——重新通过判别读取器回读、验证、返回规范持久化载荷。
    const canonicalRead = await readExistingSourceIntent(path, entry, expected);
    if (canonicalRead.kind === "v2") return canonicalRead.payload;
    throw new HistoryMigrationError("SOURCE_INTENT_MISMATCH", "排他写入后无法回读规范 v2 日志。");
  } catch (error) {
    if (error instanceof HistoryMigrationError && error.code === "OUTPUT_ALREADY_EXISTS") {
      // 文件已存在（并发竞争或既有日志）：重新读取获胜方日志。
      const existing = await readExistingSourceIntent(path, entry, expected);
      if (existing.kind === "v2") return existing.payload;
      if (existing.kind === "v1") {
        // v1 升级：通过 sidecar O_EXCL 排他创建规范 v2。
        // 所有并发升级者竞争同一个 sidecar；获胜者写入，失败者回读。
        const upgraded = upgradeV1ToV2Payload(existing.identity, entry, expected);
        const sidecarPath = sourceIntentV2SidecarPath(path);
        try {
          await writeNewPrivateJson(sidecarPath, upgraded);
          // 绝不直接返回本地候选载荷——重新通过判别读取器回读 sidecar、验证、返回规范持久化载荷。
          const sidecarRead = await readExistingSourceIntent(path, entry, expected);
          if (sidecarRead.kind === "v2") return sidecarRead.payload;
          throw new HistoryMigrationError("SOURCE_INTENT_MISMATCH", "sidecar 排他写入后无法回读规范 v2 日志。");
        } catch (sidecarError) {
          if (
            sidecarError instanceof HistoryMigrationError &&
            sidecarError.code === "OUTPUT_ALREADY_EXISTS"
          ) {
            // 并发升级者已写入 sidecar：回读规范 v2 并完全验证。
            const canonicalRead = await readExistingSourceIntent(path, entry, expected);
            if (canonicalRead.kind === "v2") return canonicalRead.payload;
            // sidecar 存在但主文件仍为 v1 或 absent——不应发生。
            throw new HistoryMigrationError(
              "SOURCE_INTENT_MISMATCH",
              "并发升级后无法读取规范 v2 日志。",
            );
          }
          throw sidecarError;
        }
      }
      // absent 不应发生——刚收到 OUTPUT_ALREADY_EXISTS。
      throw new HistoryMigrationError("SOURCE_INTENT_MISMATCH", "并发竞争后无法读取源意图日志。");
    }
    // 所有其他写入失败向上传播——不吞没不确定性。
    throw error;
  }
}

/**
 * 原子更新源意图日志阶段。仅允许前进（phase order 递增），不允许后退。
 * 如果更新失败（崩溃/响应丢失），重试时通过 readExistingSourceIntent 重新读取。
 */
async function advanceSourceIntentPhase(
  path: string,
  entry: PackageReportEntry,
  expected: SourceIntentExpected,
  update: Partial<Pick<SourceIntentPayload, "phase" | "jobId" | "problemId">>,
): Promise<SourceIntentPayload> {
  const read = await readExistingSourceIntent(path, entry, expected);
  if (read.kind === "absent") {
    throw new HistoryMigrationError("SOURCE_INTENT_MISMATCH", "源意图日志不存在，无法更新阶段。");
  }
  if (read.kind === "v1") {
    throw new HistoryMigrationError("SOURCE_INTENT_MISMATCH", "源意图日志仍为 v1，需先升级。");
  }
  const current = read.payload;
  if (update.phase !== undefined && SOURCE_INTENT_PHASE_ORDER[update.phase] < SOURCE_INTENT_PHASE_ORDER[current.phase]) {
    // 不允许后退阶段。
    return current;
  }
  const updated: SourceIntentPayload = {
    ...current,
    ...update,
    phase: update.phase ?? current.phase,
    jobId: update.jobId ?? current.jobId,
    problemId: update.problemId ?? current.problemId,
  };
  await writePrivateFile(path, JSON.stringify(updated));
  return updated;
}

/**
 * 逐字段验证 stored_files 行与日志/发布对象完全匹配。
 * 验证：id、purpose、storageKey、originalName、mediaType、byteSize、sha256、createdByUserId。
 * 任何字段不匹配 → SOURCE_INTENT_MISMATCH（fail-closed）。
 */
function validateStoredFileIdentity(
  row: import("@urmotiv/contracts").StoredFileRecord,
  journal: SourceIntentPayload,
  stored: { readonly storageKey: string; readonly sha256: string; readonly byteSize: number },
  requestedByUserId: string,
): void {
  if (
    row.id !== journal.storageUuid ||
    row.purpose !== "import_input" ||
    row.storageKey !== journal.expectedStorageKey ||
    row.storageKey !== stored.storageKey ||
    row.originalName !== journal.originalName ||
    row.mediaType !== journal.mediaType ||
    row.byteSize !== journal.packageBytes ||
    row.byteSize !== stored.byteSize ||
    row.sha256 !== journal.packageSha256 ||
    row.sha256 !== stored.sha256 ||
    row.createdByUserId !== requestedByUserId ||
    row.createdByUserId !== journal.requestedByUserId
  ) {
    throw new HistoryMigrationError(
      "SOURCE_INTENT_MISMATCH",
      "stored_files 行与日志/发布对象身份不匹配；拒绝继续以防止数据不一致。",
    );
  }
}

/**
 * 验证 createImportJob 返回值的身份字段立即匹配规范身份。
 * 验证 ProblemPackageImportJob 类型上可用的全部绑定字段：
 * requester、sourceFileId、inputDigest、clientRequestDigest、idempotencyKey、
 * selectedFormat、selectedFormatVersion、choices（完整规范摘要）、itemCount。
 * 不含 audit/items——这些通过后续 findImportJobForReplay 回查验证。
 * 任何字段不匹配 → SOURCE_INTENT_MISMATCH（fail-closed，稳定消毒错误码）。
 */
function validateCreatedJobIdentity(
  job: ProblemPackageImportJob,
  journal: SourceIntentPayload,
  sourceFileId: string,
  entry: PackageReportEntry,
  expected: SourceIntentExpected,
): void {
  const createdChoicesDigest = choicesDigestOf(job.choices);
  const bindingKey = entrySourceBindingKey(entry);
  if (
    job.requestedByUserId !== expected.requestedByUserId ||
    job.sourceFileId !== sourceFileId ||
    job.sourceFileId !== journal.storageUuid ||
    job.inputDigest !== expected.inputDigest ||
    job.inputDigest !== entry.packageSha256 ||
    job.clientRequestDigest !== expected.clientRequestDigest ||
    job.clientRequestDigest !== bindingKey ||
    job.idempotencyKey !== expected.idempotencyKey ||
    job.idempotencyKey !== bindingKey ||
    job.selectedFormat !== expected.selectedFormat ||
    job.selectedFormat !== journal.selectedFormat ||
    job.selectedFormatVersion !== expected.selectedFormatVersion ||
    job.selectedFormatVersion !== journal.selectedFormatVersion ||
    createdChoicesDigest !== expected.choicesDigest ||
    createdChoicesDigest !== journal.choicesDigest ||
    job.itemCount !== journal.itemCount ||
    job.itemCount !== 1
  ) {
    throw new HistoryMigrationError(
      "SOURCE_INTENT_MISMATCH",
      "创建任务返回值身份与当前包/日志不匹配；拒绝继续。",
    );
  }
}

/**
 * 验证 createImportJob 返回值与 findImportJobForReplay 回查结果精确相等。
 * 确保返回的 job 与持久化回查的 job 是同一个身份（id + 全部绑定字段）。
 */
function validateCreatedJobEqualsReplay(
  created: ProblemPackageImportJob,
  replay: ImportJobReplayResult,
): void {
  const replayJob = replay.job;
  if (
    created.id !== replayJob.id ||
    created.requestedByUserId !== replayJob.requestedByUserId ||
    created.sourceFileId !== replayJob.sourceFileId ||
    created.inputDigest !== replayJob.inputDigest ||
    created.clientRequestDigest !== replayJob.clientRequestDigest ||
    created.idempotencyKey !== replayJob.idempotencyKey ||
    created.selectedFormat !== replayJob.selectedFormat ||
    created.selectedFormatVersion !== replayJob.selectedFormatVersion ||
    created.itemCount !== replayJob.itemCount ||
    choicesDigestOf(created.choices) !== choicesDigestOf(replayJob.choices)
  ) {
    throw new HistoryMigrationError(
      "SOURCE_INTENT_MISMATCH",
      "创建任务返回值与回查结果不匹配；拒绝继续。",
    );
  }
}

/**
 * 验证回查任务的全部绑定身份与当前包/日志匹配。
 * 验证：requester、sourceFileId、inputDigest、clientRequestDigest、idempotencyKey、
 * selectedFormat、selectedFormatVersion、choices（完整规范摘要）、
 * itemCount、审计绑定（auditRequestId 与日志一致）、条目链接（jobId、position=0、count=1）。
 * 任何字段不匹配 → SOURCE_INTENT_MISMATCH（fail-closed）。
 */
function validateReplayJobIdentity(
  committed: ImportJobReplayResult,
  journal: SourceIntentPayload,
  sourceFileId: string,
  entry: PackageReportEntry,
  expected: SourceIntentExpected,
): void {
  const job = committed.job;
  const replayChoicesDigest = choicesDigestOf(job.choices);
  const bindingKey = entrySourceBindingKey(entry);
  if (
    job.requestedByUserId !== expected.requestedByUserId ||
    job.sourceFileId !== sourceFileId ||
    job.sourceFileId !== journal.storageUuid ||
    job.inputDigest !== expected.inputDigest ||
    job.inputDigest !== entry.packageSha256 ||
    job.clientRequestDigest !== expected.clientRequestDigest ||
    job.clientRequestDigest !== bindingKey ||
    job.idempotencyKey !== expected.idempotencyKey ||
    job.idempotencyKey !== bindingKey ||
    job.selectedFormat !== expected.selectedFormat ||
    job.selectedFormat !== journal.selectedFormat ||
    job.selectedFormatVersion !== expected.selectedFormatVersion ||
    job.selectedFormatVersion !== journal.selectedFormatVersion ||
    replayChoicesDigest !== expected.choicesDigest ||
    replayChoicesDigest !== journal.choicesDigest ||
    job.itemCount !== journal.itemCount ||
    job.itemCount !== 1
  ) {
    throw new HistoryMigrationError(
      "SOURCE_INTENT_MISMATCH",
      "回查任务身份与当前包/日志不匹配；拒绝继续。",
    );
  }
  // 审计绑定必须精确匹配——缺失即为不匹配（fail-closed）。
  if (committed.auditRequestId !== journal.auditRequestId) {
    throw new HistoryMigrationError(
      "SOURCE_INTENT_MISMATCH",
      "回查任务审计绑定缺失或与日志不匹配；拒绝继续。",
    );
  }
  if (
    committed.items.length !== 1 ||
    committed.items[0]!.jobId !== job.id ||
    committed.items[0]!.position !== 0 ||
    committed.items[0]!.position !== journal.position
  ) {
    throw new HistoryMigrationError(
      "SOURCE_INTENT_MISMATCH",
      "回查任务条目链接/位置与日志不匹配；拒绝继续。",
    );
  }
}

function defaultNow(): Date {
  return new Date();
}

// ---------------------------------------------------------------------------
// 验收数据库准备/清理
// ---------------------------------------------------------------------------

export interface PreparedHistoryImportDatabase {
  readonly databaseName: string;
  readonly connectionString: string;
}

/**
 * 创建并准备一个历史导入验收数据库（迁移 + 核心种子 + 演示账号）。
 * 数据库名必须符合 urmotiv_history_import_* 模式，防止误连重要数据库。
 */
export async function prepareHistoryImportDatabase(
  adminConnectionString: string,
  databaseName: string,
): Promise<PreparedHistoryImportDatabase> {
  if (!/^urmotiv_history_import_[a-z0-9_]{1,50}$/u.test(databaseName)) {
    throw new HistoryMigrationError(
      "INVALID_ARGUMENTS",
      "验收数据库名称必须匹配 urmotiv_history_import_* 模式。",
    );
  }
  const admin = createPostgresDatabase({
    connectionString: adminConnectionString,
    maxConnections: 1,
    applicationName: "urmotiv-history-import-admin",
  });
  try {
    await admin.execute(sql`CREATE DATABASE ${sql.identifier(databaseName)}`);
  } finally {
    await admin.close();
  }
  const connectionString = databaseConnectionString(adminConnectionString, databaseName);
  const database = createPostgresDatabase({
    connectionString,
    maxConnections: 8,
    applicationName: "urmotiv-history-import",
  });
  try {
    await migrateDatabase(database);
    await seedCoreDatabase(database);
    await seedDatabaseDemoData(database);
  } finally {
    await database.close();
  }
  return { databaseName, connectionString };
}

/** 删除一个历史导入验收数据库；名称同样必须符合 urmotiv_history_import_* 模式。 */
export async function dropHistoryImportDatabase(
  adminConnectionString: string,
  databaseName: string,
): Promise<void> {
  if (!/^urmotiv_history_import_[a-z0-9_]{1,50}$/u.test(databaseName)) {
    throw new HistoryMigrationError(
      "INVALID_ARGUMENTS",
      "验收数据库名称必须匹配 urmotiv_history_import_* 模式。",
    );
  }
  const admin = createPostgresDatabase({
    connectionString: adminConnectionString,
    maxConnections: 1,
    applicationName: "urmotiv-history-import-cleanup",
  });
  try {
    await admin.execute(sql`DROP DATABASE IF EXISTS ${sql.identifier(databaseName)}`);
  } finally {
    await admin.close();
  }
}

export function historyImportDatabaseConnectionString(
  adminConnectionString: string,
  databaseName: string,
): string {
  return databaseConnectionString(adminConnectionString, databaseName);
}

// ---------------------------------------------------------------------------
// 内部帮助函数
// ---------------------------------------------------------------------------

function createDefaultWriter(
  dependencies: HistoryImportPhaseDependencies,
): AtomicImportedProblemWriter {
  const database = dependencies.database;
  return new DatabaseImportedProblemWriter({
    database,
    store: new DatabaseDataStore(database),
    metadata: new ProblemFileStore(database),
    storage: new LocalFileStorage({
      rootDirectory: dependencies.storageRoot,
      limits: { maxBytes: 256 * 1024 * 1024 },
    }),
    audit: new DatabaseProblemPackageAuditWriter(database),
    ...(dependencies.now === undefined ? {} : { now: dependencies.now }),
  } satisfies DatabaseImportedProblemWriterDependencies);
}

async function readPackageReport(
  packageDirectory: string,
): Promise<z.infer<typeof packageReportPayloadSchema>> {
  const markerExists = await privateRegularFileExists(join(packageDirectory, "PACKAGE_COMPLETE"));
  if (!markerExists) {
    throw new HistoryMigrationError("PREPARE_INCOMPLETE", "package 阶段没有完成标记，不能导入。");
  }
  const report = packageReportPayloadSchema.parse(
    await readPrivateJson(join(packageDirectory, "report.json")),
  );
  if (report.packages.length !== report.packageCount) {
    throw new HistoryMigrationError("INVALID_METADATA", "包报告中的数量与包条目不一致。");
  }
  return report;
}

async function readExistingManifest(
  manifestPath: string,
): Promise<ImportManifestPayload | undefined> {
  const exists = await privateRegularFileExists(manifestPath);
  if (!exists) {
    return undefined;
  }
  try {
    return importManifestPayloadSchema.parse(await readPrivateJson(manifestPath));
  } catch {
    throw new HistoryMigrationError(
      "INVALID_METADATA",
      "既有导入清单格式无效；为防止重复导入，请核对后手动处置。",
    );
  }
}
/**
 * 读取既有批次发布日志。文件不存在返回 undefined。
 * 损坏/不可解析 → 抛出 INVALID_METADATA（绝不静默覆盖）。
 */
async function readExistingBatchPublication(
  path: string,
): Promise<BatchPublicationPayload | undefined> {
  if (!(await privateRegularFileExists(path))) return undefined;
  try {
    return batchPublicationSchema.parse(await readPrivateJson(path));
  } catch {
    throw new HistoryMigrationError(
      "INVALID_METADATA",
      "批次发布日志格式无效；为防止重复发布，请核对后手动处置。",
    );
  }
}

/**
 * 写入批次发布日志（覆盖，使用安全原子写入）。
 */
async function writeBatchPublication(
  path: string,
  payload: BatchPublicationPayload,
): Promise<void> {
  await writePrivateFile(path, JSON.stringify(payload));
}

/**
 * 计算清单/完成标记载荷的摘要，用于批次发布日志的身份绑定。
 */
function payloadDigest(payload: string): string {
  return sha256Hex(new TextEncoder().encode(payload));
}

function bytesOnce(bytes: Uint8Array): AsyncIterable<Uint8Array> {
  return {
    async *[Symbol.asyncIterator]() {
      yield bytes;
    },
  };
}

/**
 * 把管理连接地址替换成目标数据库连接地址（保留查询参数）。实现与 API 测试
 * 使用的助手一致，避免为一次 CLI 用途重复造轮子。
 */
function databaseConnectionString(connectionString: string, databaseName: string): string {
  const queryIndex = connectionString.indexOf("?");
  const endpoint = queryIndex === -1 ? connectionString : connectionString.slice(0, queryIndex);
  const query = queryIndex === -1 ? "" : connectionString.slice(queryIndex);
  const separator = endpoint.lastIndexOf("/");
  if (separator < "postgresql://".length) {
    throw new HistoryMigrationError("INVALID_ARGUMENTS", "数据库连接地址无效。");
  }
  return `${endpoint.slice(0, separator + 1)}${databaseName}${query}`;
}
