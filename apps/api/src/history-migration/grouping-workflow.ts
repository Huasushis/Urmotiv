import type { Dirent } from "node:fs";
import { lstat, mkdir, readdir, realpath, rename, rm, rmdir } from "node:fs/promises";
import { dirname, extname, isAbsolute, join, relative, resolve } from "node:path";
import {
  type ArchiveIssue,
  defaultArchiveSafetyLimits,
  isSafeArchivePath,
  looksLikeZipArchive,
  readZipArchive,
  UnsafeArchiveError,
} from "@urmotiv/problem-package";
import { z } from "zod";
import { sha256Hex } from "./digests";
import { HistoryMigrationError } from "./errors";
import {
  assertHistoryGroupingConfirmation,
  createHistoryGroupingConfirmation,
  type HistoryGroupingDraft,
  type HistorySourceInventory,
  historyFragmentIdSchema,
  historyFragmentSelectionSchema,
  historyGroupIdSchema,
  historyGroupingDraftSchema,
  historyMetadataIdSchema,
  historySourceInventorySchema,
  historyZipEntryIdSchema,
  validateHistoryGrouping,
} from "./grouping";
import {
  assertNewOutputPath,
  assertPathsInsidePrivateRoot,
  createNewPrivateDirectory,
  maximumHistorySourceBytes,
  maximumHistorySourceTextUnits,
  readConfirmedSource,
  readPrivateJson,
  readPrivateJsonWithDigest,
  readPrivateRegularBytes,
  writeNewPrivateFile,
  writeNewPrivateJson,
} from "./private-files";
import {
  type HistoryMetadataFile,
  historyContentDigestSchema,
  historyMetadataFileSchema,
  historySourceIdSchema,
  historySourceMappingSchema,
} from "./schema";

const maximumCatalogFiles = 10_000;
const maximumCatalogTotalBytes = 512 * 1024 * 1024;
const maximumCatalogSourceBytes = defaultArchiveSafetyLimits.maxArchiveBytes;

type HistorySourceInspectionReason =
  | ArchiveIssue["code"]
  | "archive_invalid"
  | "manual_binary"
  | "source_too_large"
  | "source_unreadable"
  | "text_empty"
  | "text_not_utf8"
  | "text_too_large";

class HistorySourceInspectionFailure extends HistoryMigrationError {
  public readonly reasons: readonly HistorySourceInspectionReason[];

  public constructor(
    code: "SOURCE_FILE_INVALID" | "SOURCE_TOO_LARGE",
    reasons: readonly HistorySourceInspectionReason[],
    message: string,
  ) {
    super(code, message);
    this.name = "HistorySourceInspectionFailure";
    this.reasons = reasons;
  }
}

const privateRelativePathSchema = z
  .string()
  .min(1)
  .max(240)
  .refine((value) => isSafeArchivePath(value), "私有相对路径不安全。");

const historyZipEntryLocationSchema = z
  .object({
    entryId: historyZipEntryIdSchema,
    entryPath: privateRelativePathSchema,
  })
  .strict();

const historySourceLocationSchema = z
  .object({
    sourceId: historySourceIdSchema,
    sourcePath: privateRelativePathSchema,
    entries: z.array(historyZipEntryLocationSchema).max(100_000).default([]),
  })
  .strict()
  .superRefine((value, context) => {
    addDuplicateIssues(
      value.entries.map((entry) => entry.entryId),
      context,
      ["entries"],
      "同一个压缩包条目安全编号不能重复。",
    );
    addDuplicateIssues(
      value.entries.map((entry) => foldPrivatePath(entry.entryPath)),
      context,
      ["entries"],
      "同一个压缩包条目路径不能重复或只靠大小写区分。",
    );
  });

export const historySourceLocationsSchema = z
  .object({
    version: z.literal(1),
    sources: z.array(historySourceLocationSchema).min(1).max(maximumCatalogFiles),
  })
  .strict()
  .superRefine((value, context) => {
    addDuplicateIssues(
      value.sources.map((source) => source.sourceId),
      context,
      ["sources"],
      "同一个源文件安全编号不能重复。",
    );
    addDuplicateIssues(
      value.sources.map((source) => foldPrivatePath(source.sourcePath)),
      context,
      ["sources"],
      "源文件路径不能重复或只靠大小写、Unicode 形式区分。",
    );
  });

const historyManualReviewSchema = z
  .object({
    version: z.literal(2),
    phase: z.literal("inventory"),
    sourceCount: z.number().int().positive(),
    manualSourceCount: z.number().int().nonnegative(),
    sources: z
      .array(
        z
          .object({
            sourceId: historySourceIdSchema,
            reasons: z.array(z.string().min(1).max(100)).min(1).max(100),
          })
          .strict(),
      )
      .max(maximumCatalogFiles),
  })
  .strict()
  .superRefine((value, context) => {
    addDuplicateIssues(
      value.sources.map((source) => source.sourceId),
      context,
      ["sources"],
      "同一个人工源文件安全编号不能重复。",
    );
  });

const historyInventoryCompleteSchema = z
  .object({
    version: z.literal(2),
    phase: z.literal("inventory"),
    inventorySha256: historyContentDigestSchema,
    sourceLocationsSha256: historyContentDigestSchema,
    manualReviewSha256: historyContentDigestSchema,
    catalogSha256: historyContentDigestSchema,
    sourceCount: z.number().int().positive(),
    archiveEntryCount: z.number().int().nonnegative(),
    manualSourceCount: z.number().int().nonnegative(),
    totalSourceBytes: z.number().int().nonnegative(),
  })
  .strict();

const safeRangeSchema = z
  .object({
    sourceId: historySourceIdSchema,
    start: z.number().int().nonnegative(),
    end: z.number().int().positive(),
  })
  .strict();

const safeZipEntryReferenceSchema = z
  .object({
    sourceId: historySourceIdSchema,
    entryId: historyZipEntryIdSchema,
  })
  .strict();

const historyGroupingValidationReportSchema = z
  .object({
    version: z.literal(1),
    phase: z.literal("grouping_validation"),
    status: z.enum(["complete", "incomplete"]),
    metadataCount: z.number().int().nonnegative(),
    groupedMetadataCount: z.number().int().nonnegative(),
    disposedMetadataCount: z.number().int().nonnegative(),
    unresolvedMetadataIds: z.array(historyMetadataIdSchema).max(10_000),
    textSourceCount: z.number().int().nonnegative(),
    uncoveredTextRanges: z.array(safeRangeSchema).max(100_000),
    zipEntryCount: z.number().int().nonnegative(),
    selectedZipEntryCount: z.number().int().nonnegative(),
    disposedZipEntryCount: z.number().int().nonnegative(),
    unresolvedZipEntries: z.array(safeZipEntryReferenceSchema).max(100_000),
    manualSourceCount: z.number().int().nonnegative(),
    disposedManualSourceCount: z.number().int().nonnegative(),
    unresolvedManualSourceIds: z.array(historySourceIdSchema).max(10_000),
    missingGroupCount: z.union([z.literal(0), z.literal(1)]),
    dispositionSummary: z
      .array(
        z
          .object({
            itemId: z.string().min(1).max(100),
            action: z.enum(["converted", "deferred", "attachment", "ignored"]),
            reasonSha256: historyContentDigestSchema,
            convertedSourceId: historySourceIdSchema.optional(),
          })
          .strict()
          .refine(
            (value) => (value.action === "converted") === (value.convertedSourceId !== undefined),
            "只有已转换处置需要记录转换后文本的安全编号。",
          ),
      )
      .max(220_000),
    unresolvedItemCount: z.number().int().nonnegative(),
  })
  .strict();

const historyGroupingCompleteSchema = z
  .object({
    version: z.literal(1),
    phase: z.literal("grouping"),
    catalogSha256: historyContentDigestSchema,
    metadataFileSha256: historyContentDigestSchema,
    groupingSha256: historyContentDigestSchema,
    validationReportSha256: historyContentDigestSchema,
    fragmentCount: z.number().int().nonnegative(),
    groupCount: z.number().int().nonnegative(),
    unresolvedItemCount: z.literal(0),
  })
  .strict();

const historyMaterializeReportSchema = z
  .object({
    version: z.literal(2),
    phase: z.literal("materialize"),
    sourceInventorySha256: historyContentDigestSchema,
    groupingBatchSha256: historyContentDigestSchema,
    fragmentCount: z.number().int().nonnegative(),
    sourceCount: z.number().int().positive(),
    unresolvedItemCount: z.literal(0),
    sources: z
      .array(
        z
          .object({
            groupId: historyGroupIdSchema,
            sourceId: historySourceIdSchema,
            sourceSha256: historyContentDigestSchema,
            fragmentCount: z.number().int().positive(),
            byteLength: z.number().int().positive(),
            characterCount: z.number().int().positive(),
            status: z.literal("ready_for_prepare"),
          })
          .strict(),
      )
      .min(1)
      .max(10_000),
  })
  .strict();

const historyMaterializeCompleteSchema = z
  .object({
    version: z.literal(2),
    phase: z.literal("materialize"),
    reportSha256: historyContentDigestSchema,
    sourceConfirmationSha256: historyContentDigestSchema,
    sourceSetSha256: historyContentDigestSchema,
    groupingBatchSha256: historyContentDigestSchema,
    sourceCount: z.number().int().positive(),
    fragmentCount: z.number().int().nonnegative(),
    unresolvedItemCount: z.literal(0),
  })
  .strict();

const historyGroupingPlanFragmentSchema = z
  .object({
    fragmentId: historyFragmentIdSchema,
    sourceId: historySourceIdSchema,
    selection: historyFragmentSelectionSchema,
  })
  .strict();

/**
 * 人工分组计划只描述选择范围，不要求人手计算摘要。seal-grouping 会重新读取
 * 私有源文件，计算每个片段摘要后才产生可确认的正式分组文件。
 */
export const historyGroupingPlanSchema = z
  .object({
    version: z.literal(2),
    fragments: z.array(historyGroupingPlanFragmentSchema).max(100_000),
    groups: historyGroupingDraftSchema.shape.groups,
    sharingConfirmations: historyGroupingDraftSchema.shape.sharingConfirmations,
    metadataDispositions: historyGroupingDraftSchema.shape.metadataDispositions,
    zipEntryDispositions: historyGroupingDraftSchema.shape.zipEntryDispositions,
    textRangeDispositions: historyGroupingDraftSchema.shape.textRangeDispositions,
    manualSourceDispositions: historyGroupingDraftSchema.shape.manualSourceDispositions,
  })
  .strict();

export type HistorySourceLocations = z.infer<typeof historySourceLocationsSchema>;
export type HistoryGroupingPlan = z.infer<typeof historyGroupingPlanSchema>;

export interface InventoryHistorySourcesOptions {
  readonly privateRootDirectory: string;
  readonly sourceDirectory: string;
  readonly outputDirectory: string;
}

export interface InventoryHistorySourcesResult {
  readonly sourceCount: number;
  readonly textSourceCount: number;
  readonly archiveSourceCount: number;
  readonly manualSourceCount: number;
  readonly archiveEntryCount: number;
  readonly totalSourceBytes: number;
  readonly inventorySha256: string;
}

export interface SealHistoryGroupingOptions {
  readonly privateRootDirectory: string;
  readonly sourceDirectory: string;
  readonly sourceInventoryFile: string;
  readonly sourceLocationsFile: string;
  readonly metadataFile: string;
  readonly groupingPlanFile: string;
  readonly outputDirectory: string;
}

export interface SealHistoryGroupingResult {
  readonly sourceCount: number;
  readonly fragmentCount: number;
  readonly groupCount: number;
  readonly unresolvedItemCount: 0;
}

export interface WriteHistoryGroupingConfirmationOptions {
  readonly privateRootDirectory: string;
  readonly sourceInventoryFile: string;
  readonly sourceLocationsFile: string;
  readonly metadataFile: string;
  readonly groupingDirectory: string;
  readonly outputFile: string;
  readonly confirmed: boolean;
}

export interface MaterializeHistoryGroupingOptions {
  readonly privateRootDirectory: string;
  readonly sourceDirectory: string;
  readonly sourceInventoryFile: string;
  readonly sourceLocationsFile: string;
  readonly metadataFile: string;
  readonly groupingDirectory: string;
  readonly groupingConfirmationFile: string;
  readonly outputDirectory: string;
}

export interface MaterializeHistoryGroupingResult {
  readonly sourceCount: number;
  readonly fragmentCount: number;
  readonly unresolvedItemCount: 0;
}

export interface InitializeHistoryGroupingWorksheetOptions {
  readonly privateRootDirectory: string;
  readonly sourceInventoryFile: string;
  readonly sourceLocationsFile: string;
  readonly metadataFile: string;
  readonly outputDirectory: string;
}

export interface AssertHistoryMaterializationCompleteOptions {
  readonly privateRootDirectory: string;
  readonly materializedDirectory: string;
}

interface CatalogSourceLocation {
  readonly sourceId: string;
  readonly sourcePath: string;
  readonly entries: readonly {
    readonly entryId: string;
    readonly entryPath: string;
  }[];
}

interface LoadedHistorySource {
  readonly inventory: HistorySourceInventory["sources"][number];
  readonly bytes: Uint8Array;
  readonly text?: string;
  readonly zipEntriesById?: ReadonlyMap<string, Uint8Array>;
}

interface MaterializedFragment {
  readonly text: string;
  readonly contentSha256: string;
}

interface VerifiedCatalog {
  readonly inventory: HistorySourceInventory;
  readonly locations: HistorySourceLocations;
  readonly manualReview: z.infer<typeof historyManualReviewSchema>;
  readonly inventorySha256: string;
  readonly sourceLocationsSha256: string;
  readonly manualReviewSha256: string;
  readonly catalogSha256: string;
}

/**
 * 对私有源目录建立清单：inventory.json 只有安全编号和摘要；
 * source-locations.private.json 才保存原相对路径；manual-review.json 只列
 * 待人工处理的安全编号与原因码。所有文件都只写进新的私有目录。
 */
export async function inventoryHistorySources(
  options: InventoryHistorySourcesOptions,
): Promise<InventoryHistorySourcesResult> {
  await assertPathsInsidePrivateRoot(options.privateRootDirectory, [
    { path: options.sourceDirectory, kind: "existing" },
    { path: options.outputDirectory, kind: "new" },
  ]);
  assertOutputOutsideSource(options.sourceDirectory, options.outputDirectory);

  const sourcePaths = await listPrivateSourcePaths(options.sourceDirectory);
  if (sourcePaths.length === 0) {
    throw new HistoryMigrationError("SOURCE_FILE_INVALID", "私有源目录中没有可登记的普通文件。");
  }

  const sources: HistorySourceInventory["sources"] = [];
  const locations: CatalogSourceLocation[] = [];
  const failures: Array<{
    readonly sourceId: string;
    readonly sourcePath: string;
    readonly code: "SOURCE_FILE_INVALID" | "SOURCE_TOO_LARGE";
    readonly reasons: readonly HistorySourceInspectionReason[];
  }> = [];
  const manualReviews: Array<{
    readonly sourceId: string;
    readonly reasons: readonly HistorySourceInspectionReason[];
  }> = [];
  let totalSourceBytes = 0;
  let archiveEntryCount = 0;

  for (const [index, sourcePath] of sourcePaths.entries()) {
    const sourceId = makeSafeId("source", index + 1);
    let inspected: Awaited<ReturnType<typeof inspectSourceForInventory>>;
    try {
      inspected = await inspectSourceForInventory(options.sourceDirectory, sourcePath, sourceId);
    } catch (error) {
      if (
        error instanceof HistoryMigrationError &&
        (error.code === "SOURCE_FILE_INVALID" || error.code === "SOURCE_TOO_LARGE")
      ) {
        failures.push({
          sourceId,
          sourcePath,
          code: error.code,
          reasons:
            error instanceof HistorySourceInspectionFailure
              ? error.reasons
              : error.code === "SOURCE_TOO_LARGE"
                ? ["source_too_large"]
                : ["source_unreadable"],
        });
        continue;
      }
      throw error;
    }
    totalSourceBytes += inspected.inventory.byteLength;
    if (totalSourceBytes > maximumCatalogTotalBytes) {
      throw new HistoryMigrationError("SOURCE_TOO_LARGE", "本批私有源文件的总大小超过明确上限。");
    }
    if (inspected.inventory.kind === "zip") {
      archiveEntryCount += inspected.inventory.entries.length;
    }
    if (inspected.manualReasons !== undefined) {
      manualReviews.push({ sourceId, reasons: inspected.manualReasons });
    }
    sources.push(inspected.inventory);
    locations.push(inspected.location);
  }
  if (!arraysEqual(sourcePaths, await listPrivateSourcePaths(options.sourceDirectory))) {
    throw new HistoryMigrationError(
      "GROUPING_CHANGED",
      "私有源目录在建立清单过程中发生变化，必须重新开始。",
    );
  }
  if (failures.length > 0) {
    await writeInventoryFailureOutput(options.outputDirectory, sourcePaths.length, failures);
    throw new HistoryMigrationError(
      "SOURCE_FILE_INVALID",
      "部分私有源文件未通过安全登记；具体路径只写入私有失败清单。",
    );
  }

  const inventory = parsePrivateInput(
    historySourceInventorySchema,
    { version: 1, sources },
    "INVALID_GROUPING",
    "生成的历史资料源清单格式不正确。",
  );
  const sourceLocations = parsePrivateInput(
    historySourceLocationsSchema,
    { version: 1, sources: locations },
    "INVALID_GROUPING",
    "生成的私有源位置清单格式不正确。",
  );
  const manualReview = parsePrivateInput(
    historyManualReviewSchema,
    {
      version: 2,
      phase: "inventory",
      sourceCount: inventory.sources.length,
      manualSourceCount: manualReviews.length,
      sources: manualReviews,
    },
    "INVALID_GROUPING",
    "生成的人工处理清单格式不正确。",
  );
  const inventorySha256 = sha256Hex(JSON.stringify(inventory));
  const sourceLocationsSha256 = sha256Hex(JSON.stringify(sourceLocations));
  const manualReviewSha256 = sha256Hex(JSON.stringify(manualReview));
  const catalogSha256 = sha256Hex(
    JSON.stringify({
      version: 2,
      inventorySha256,
      sourceLocationsSha256,
      manualReviewSha256,
    }),
  );

  await createNewPrivateDirectory(options.outputDirectory);
  const stagingDirectory = join(options.outputDirectory, ".inventory-incomplete");
  try {
    await mkdir(stagingDirectory, { recursive: false, mode: 0o700 });
    await writeNewPrivateJson(join(stagingDirectory, "inventory.json"), inventory);
    await writeNewPrivateJson(
      join(stagingDirectory, "source-locations.private.json"),
      sourceLocations,
    );
    await writeNewPrivateJson(join(stagingDirectory, "manual-review.json"), manualReview);
    await writeNewPrivateJson(join(stagingDirectory, "INVENTORY_COMPLETE"), {
      version: 2,
      phase: "inventory",
      inventorySha256,
      sourceLocationsSha256,
      manualReviewSha256,
      catalogSha256,
      sourceCount: inventory.sources.length,
      archiveEntryCount,
      manualSourceCount: manualReviews.length,
      totalSourceBytes,
    });
    await publishStagedEntries(options.outputDirectory, stagingDirectory, [
      "inventory.json",
      "source-locations.private.json",
      "manual-review.json",
      "INVENTORY_COMPLETE",
    ]);
  } catch (error) {
    await rm(options.outputDirectory, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }

  return {
    sourceCount: inventory.sources.length,
    textSourceCount: inventory.sources.filter((source) => source.kind === "text").length,
    archiveSourceCount: inventory.sources.filter((source) => source.kind === "zip").length,
    manualSourceCount: inventory.sources.filter(
      (source) => source.kind === "file" || source.kind === "pdf",
    ).length,
    archiveEntryCount,
    totalSourceBytes,
    inventorySha256,
  };
}

/** 读取人工选择范围并补齐由当前源内容计算出的片段摘要。 */
export async function sealHistoryGrouping(
  options: SealHistoryGroupingOptions,
): Promise<SealHistoryGroupingResult> {
  await assertPathsInsidePrivateRoot(options.privateRootDirectory, [
    { path: options.sourceDirectory, kind: "existing" },
    { path: options.sourceInventoryFile, kind: "existing" },
    { path: options.sourceLocationsFile, kind: "existing" },
    { path: options.metadataFile, kind: "existing" },
    { path: options.groupingPlanFile, kind: "existing" },
    { path: options.outputDirectory, kind: "new" },
  ]);
  assertOutputOutsideSource(options.sourceDirectory, options.outputDirectory);

  const { inventory, sourcesById, catalog } = await loadCurrentCatalogSources(options);
  const metadata = await loadMetadata(options.metadataFile);
  const plan = parsePrivateInput(
    historyGroupingPlanSchema,
    await readPrivateJson(options.groupingPlanFile),
    "INVALID_GROUPING",
    "人工分组计划格式不正确。",
  );

  const fragments = plan.fragments.map((fragment) => {
    const source = sourcesById.get(fragment.sourceId);
    if (source === undefined) {
      throw new HistoryMigrationError(
        "INVALID_GROUPING",
        "人工分组计划指向的源文件安全编号不存在。",
      );
    }
    const materialized = materializeFragment(source, fragment.selection);
    return {
      ...fragment,
      contentSha256: materialized.contentSha256,
    };
  });
  const grouping: HistoryGroupingDraft = {
    version: 2,
    fragments,
    groups: plan.groups,
    sharingConfirmations: plan.sharingConfirmations,
    metadataDispositions: plan.metadataDispositions,
    zipEntryDispositions: plan.zipEntryDispositions,
    textRangeDispositions: plan.textRangeDispositions,
    manualSourceDispositions: plan.manualSourceDispositions,
  };
  const placeholderDigest = "0".repeat(64);
  const checked = validateHistoryGrouping({
    sourceInventory: inventory,
    sourceLocationsSha256: catalog.sourceLocationsSha256,
    manualReviewSha256: catalog.manualReviewSha256,
    metadataFileSha256: metadata.sha256,
    metadataNumbers: metadata.value.records.map((record) => record.number),
    grouping,
    completenessReportSha256: placeholderDigest,
  });
  validateDispositionUnicodeBoundaries(checked.grouping, sourcesById);
  const validationReport = createGroupingValidationReport(
    inventory,
    metadata.value.records.length,
    checked.grouping,
  );
  const validationReportSha256 = sha256Hex(JSON.stringify(validationReport));

  await createNewPrivateDirectory(options.outputDirectory);
  if (validationReport.status === "incomplete") {
    await writeNewPrivateJson(
      join(options.outputDirectory, "grouping-validation.json"),
      validationReport,
    );
    await writeNewPrivateJson(join(options.outputDirectory, "GROUPING_INCOMPLETE"), {
      version: 1,
      phase: "grouping",
      status: "incomplete",
      catalogSha256: catalog.catalogSha256,
      metadataFileSha256: metadata.sha256,
      validationReportSha256,
      unresolvedItemCount: validationReport.unresolvedItemCount,
    });
    throw new HistoryMigrationError(
      "INVALID_GROUPING",
      "人工分组仍有未分组或未明确处置的项目；安全编号只写入私有校验报告。",
    );
  }

  const groupingSha256 = sha256Hex(JSON.stringify(checked.grouping));
  await writeNewPrivateJson(
    join(options.outputDirectory, "grouping.private.json"),
    checked.grouping,
  );
  await writeNewPrivateJson(
    join(options.outputDirectory, "grouping-validation.json"),
    validationReport,
  );
  await writeNewPrivateJson(join(options.outputDirectory, "GROUPING_COMPLETE"), {
    version: 1,
    phase: "grouping",
    catalogSha256: catalog.catalogSha256,
    metadataFileSha256: metadata.sha256,
    groupingSha256,
    validationReportSha256,
    fragmentCount: checked.grouping.fragments.length,
    groupCount: checked.grouping.groups.length,
    unresolvedItemCount: 0,
  });

  return {
    sourceCount: inventory.sources.length,
    fragmentCount: grouping.fragments.length,
    groupCount: grouping.groups.length,
    unresolvedItemCount: 0,
  };
}

/**
 * 人在核对正式分组文件后单独运行此步骤。confirmed 必须明确为 true；任何后续
 * 清单、元数据、片段或分组变化都会让确认失效。
 */
export async function writeHistoryGroupingConfirmation(
  options: WriteHistoryGroupingConfirmationOptions,
): Promise<void> {
  if (options.confirmed !== true) {
    throw new HistoryMigrationError(
      "INVALID_SOURCE_CONFIRMATION",
      "必须在人工核对后明确确认历史资料分组。",
    );
  }
  await assertPathsInsidePrivateRoot(options.privateRootDirectory, [
    { path: options.sourceInventoryFile, kind: "existing" },
    { path: options.sourceLocationsFile, kind: "existing" },
    { path: options.metadataFile, kind: "existing" },
    { path: options.groupingDirectory, kind: "existing" },
    { path: join(options.groupingDirectory, "grouping.private.json"), kind: "existing" },
    { path: join(options.groupingDirectory, "grouping-validation.json"), kind: "existing" },
    { path: join(options.groupingDirectory, "GROUPING_COMPLETE"), kind: "existing" },
    { path: options.outputFile, kind: "new" },
  ]);
  await assertNewOutputPath(options.outputFile);

  const catalog = await loadVerifiedCatalogArtifacts(
    options.sourceInventoryFile,
    options.sourceLocationsFile,
  );
  const metadata = await loadMetadata(options.metadataFile);
  const verifiedGrouping = await loadVerifiedGrouping(
    options.groupingDirectory,
    catalog,
    metadata.value.records.length,
    metadata.sha256,
  );
  const confirmation = createHistoryGroupingConfirmation({
    sourceInventory: catalog.inventory,
    sourceLocationsSha256: catalog.sourceLocationsSha256,
    manualReviewSha256: catalog.manualReviewSha256,
    metadataFileSha256: metadata.sha256,
    metadataNumbers: metadata.value.records.map((record) => record.number),
    grouping: verifiedGrouping.grouping,
    completenessReportSha256: verifiedGrouping.validationReportSha256,
  });
  await writeNewPrivateJson(options.outputFile, confirmation);
}

/**
 * 在正式迁移前把多对多片段物化为一题一份安全编号文本，并生成旧 prepare/package
 * 流程需要的第一份源映射确认。执行时会重新扫描整个源目录并逐项核对内容。
 */
export async function materializeHistoryGrouping(
  options: MaterializeHistoryGroupingOptions,
): Promise<MaterializeHistoryGroupingResult> {
  await assertPathsInsidePrivateRoot(options.privateRootDirectory, [
    { path: options.sourceDirectory, kind: "existing" },
    { path: options.sourceInventoryFile, kind: "existing" },
    { path: options.sourceLocationsFile, kind: "existing" },
    { path: options.metadataFile, kind: "existing" },
    { path: options.groupingDirectory, kind: "existing" },
    { path: join(options.groupingDirectory, "grouping.private.json"), kind: "existing" },
    { path: join(options.groupingDirectory, "grouping-validation.json"), kind: "existing" },
    { path: join(options.groupingDirectory, "GROUPING_COMPLETE"), kind: "existing" },
    { path: options.groupingConfirmationFile, kind: "existing" },
    { path: options.outputDirectory, kind: "new" },
  ]);
  assertOutputOutsideSource(options.sourceDirectory, options.outputDirectory);

  const { inventory, sourcesById, catalog } = await loadCurrentCatalogSources(options);
  const metadata = await loadMetadata(options.metadataFile);
  const verifiedGrouping = await loadVerifiedGrouping(
    options.groupingDirectory,
    catalog,
    metadata.value.records.length,
    metadata.sha256,
  );
  const checked = validateHistoryGrouping({
    sourceInventory: inventory,
    sourceLocationsSha256: catalog.sourceLocationsSha256,
    manualReviewSha256: catalog.manualReviewSha256,
    metadataFileSha256: metadata.sha256,
    metadataNumbers: metadata.value.records.map((record) => record.number),
    grouping: verifiedGrouping.grouping,
    completenessReportSha256: verifiedGrouping.validationReportSha256,
  });
  validateDispositionUnicodeBoundaries(checked.grouping, sourcesById);
  const groupingConfirmation = assertHistoryGroupingConfirmation(
    {
      sourceInventory: inventory,
      sourceLocationsSha256: catalog.sourceLocationsSha256,
      manualReviewSha256: catalog.manualReviewSha256,
      metadataFileSha256: metadata.sha256,
      metadataNumbers: metadata.value.records.map((record) => record.number),
      grouping: checked.grouping,
      completenessReportSha256: verifiedGrouping.validationReportSha256,
    },
    await readPrivateJson(options.groupingConfirmationFile),
  );

  const materializedByFragmentId = new Map<string, MaterializedFragment>();
  for (const fragment of checked.grouping.fragments) {
    const source = sourcesById.get(fragment.sourceId);
    if (source === undefined) {
      throw new HistoryMigrationError("GROUPING_CHANGED", "已确认片段的源文件安全编号已经变化。");
    }
    const materialized = materializeFragment(source, fragment.selection);
    if (materialized.contentSha256 !== fragment.contentSha256) {
      throw new HistoryMigrationError(
        "GROUPING_CHANGED",
        "已确认片段的内容已经变化，必须重新分组并确认。",
      );
    }
    materializedByFragmentId.set(fragment.fragmentId, materialized);
  }

  const outputs = checked.grouping.groups.map((group, index) => {
    const materializedSourceId = makeSafeId("source", index + 1);
    const pieces = group.fragmentIds.map((fragmentId) => {
      const fragment = materializedByFragmentId.get(fragmentId);
      if (fragment === undefined) {
        throw new HistoryMigrationError("GROUPING_CHANGED", "已确认题目分组中的片段已经变化。");
      }
      return { fragmentId, text: fragment.text };
    });
    const text = joinMaterializedFragments(pieces);
    assertMaterializedTextSize(text);
    const metadataNumber = metadata.value.records[metadataIndexFromId(group.metadataId)]?.number;
    if (metadataNumber === undefined) {
      throw new HistoryMigrationError("GROUPING_CHANGED", "题目分组的元数据安全编号已经变化。");
    }
    return {
      groupId: group.groupId,
      metadataNumber,
      fragmentCount: pieces.length,
      sourceId: materializedSourceId,
      sourcePath: `${materializedSourceId}.md`,
      text,
      byteLength: new TextEncoder().encode(text).byteLength,
      characterCount: text.length,
      sourceSha256: sha256Hex(text),
    };
  });

  const sourceConfirmation = parsePrivateInput(
    historySourceMappingSchema,
    {
      version: 1,
      confirmed: true,
      metadataFileSha256: metadata.sha256,
      mappings: outputs.map((output) => ({
        sourcePath: output.sourcePath,
        sourceSha256: output.sourceSha256,
        metadataNumber: output.metadataNumber,
      })),
    },
    "INVALID_SOURCE_CONFIRMATION",
    "物化后的源映射确认格式不正确。",
  );
  const groupingBatchSha256 = groupingConfirmation.batchSha256;

  await createNewPrivateDirectory(options.outputDirectory);
  const stagingDirectory = join(options.outputDirectory, ".materialize-incomplete");
  try {
    await mkdir(stagingDirectory, { recursive: false, mode: 0o700 });
    const stagedSources = join(stagingDirectory, "sources");
    await mkdir(stagedSources, { recursive: false, mode: 0o700 });
    for (const output of outputs) {
      await writeNewPrivateFile(join(stagedSources, output.sourcePath), output.text);
    }
    const sourceConfirmationSha256 = sha256Hex(JSON.stringify(sourceConfirmation));
    const report = parsePrivateInput(
      historyMaterializeReportSchema,
      {
        version: 2,
        phase: "materialize",
        sourceInventorySha256: sha256Hex(JSON.stringify(inventory)),
        groupingBatchSha256,
        fragmentCount: checked.grouping.fragments.length,
        sourceCount: outputs.length,
        unresolvedItemCount: 0,
        sources: outputs.map((output) => ({
          groupId: output.groupId,
          sourceId: output.sourceId,
          sourceSha256: output.sourceSha256,
          fragmentCount: output.fragmentCount,
          byteLength: output.byteLength,
          characterCount: output.characterCount,
          status: "ready_for_prepare",
        })),
      },
      "INVALID_GROUPING",
      "生成的物化安全报告格式不正确。",
    );
    const reportSha256 = sha256Hex(JSON.stringify(report));
    const sourceSetSha256 = sha256Hex(
      JSON.stringify({
        version: 1,
        sources: outputs.map((output) => ({
          sourceId: output.sourceId,
          sourceSha256: output.sourceSha256,
          byteLength: output.byteLength,
        })),
      }),
    );
    await writeNewPrivateJson(
      join(stagingDirectory, "source-confirmation.private.json"),
      sourceConfirmation,
    );
    await writeNewPrivateJson(join(stagingDirectory, "report.json"), report);
    await writeNewPrivateJson(join(stagingDirectory, "MATERIALIZE_COMPLETE"), {
      version: 2,
      phase: "materialize",
      reportSha256,
      sourceConfirmationSha256,
      sourceSetSha256,
      groupingBatchSha256,
      sourceCount: outputs.length,
      fragmentCount: checked.grouping.fragments.length,
      unresolvedItemCount: 0,
    });
    await rename(stagedSources, join(options.outputDirectory, "sources"));
    await publishStagedEntries(options.outputDirectory, stagingDirectory, [
      "source-confirmation.private.json",
      "report.json",
      "MATERIALIZE_COMPLETE",
    ]);
  } catch (error) {
    await rm(options.outputDirectory, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }

  return {
    sourceCount: outputs.length,
    fragmentCount: checked.grouping.fragments.length,
    unresolvedItemCount: 0,
  };
}

/**
 * 生成不含路径、题号和正文的空白人工计划与核对工作表。它只列安全编号和范围，
 * 不给出任何来源到元数据的映射建议，也不代表人工确认。
 */
export async function initializeHistoryGroupingWorksheet(
  options: InitializeHistoryGroupingWorksheetOptions,
): Promise<void> {
  await assertPathsInsidePrivateRoot(options.privateRootDirectory, [
    { path: options.sourceInventoryFile, kind: "existing" },
    { path: options.sourceLocationsFile, kind: "existing" },
    { path: options.metadataFile, kind: "existing" },
    { path: options.outputDirectory, kind: "new" },
  ]);
  const catalog = await loadVerifiedCatalogArtifacts(
    options.sourceInventoryFile,
    options.sourceLocationsFile,
  );
  const metadata = await loadMetadata(options.metadataFile);
  const skeleton: HistoryGroupingPlan = {
    version: 2,
    fragments: [],
    groups: [],
    sharingConfirmations: [],
    metadataDispositions: [],
    zipEntryDispositions: [],
    textRangeDispositions: [],
    manualSourceDispositions: [],
  };
  const emptyGrouping = historyGroupingDraftSchema.parse({ ...skeleton, fragments: [] });
  const validationReport = createGroupingValidationReport(
    catalog.inventory,
    metadata.value.records.length,
    emptyGrouping,
  );
  const worksheet = {
    version: 1,
    phase: "grouping_worksheet",
    metadataIds: metadata.value.records.map((_, index) => makeMetadataId(index + 1)),
    textSources: catalog.inventory.sources
      .filter((source) => source.kind === "text")
      .map((source) => ({ sourceId: source.sourceId, characterCount: source.characterCount })),
    zipSources: catalog.inventory.sources
      .filter((source) => source.kind === "zip")
      .map((source) => ({
        sourceId: source.sourceId,
        entryIds: source.entries.map((entry) => entry.entryId),
      })),
    manualSourceIds: catalog.manualReview.sources.map((source) => source.sourceId),
  };
  const worksheetSha256 = sha256Hex(JSON.stringify(worksheet));
  const skeletonSha256 = sha256Hex(JSON.stringify(skeleton));
  const validationReportSha256 = sha256Hex(JSON.stringify(validationReport));

  await createNewPrivateDirectory(options.outputDirectory);
  const stagingDirectory = join(options.outputDirectory, ".worksheet-incomplete");
  try {
    await mkdir(stagingDirectory, { recursive: false, mode: 0o700 });
    await writeNewPrivateJson(join(stagingDirectory, "worksheet.json"), worksheet);
    await writeNewPrivateJson(
      join(stagingDirectory, "grouping-plan.skeleton.private.json"),
      skeleton,
    );
    await writeNewPrivateJson(
      join(stagingDirectory, "grouping-validation.initial.json"),
      validationReport,
    );
    await writeNewPrivateJson(join(stagingDirectory, "WORKSHEET_COMPLETE"), {
      version: 1,
      phase: "grouping_worksheet",
      catalogSha256: catalog.catalogSha256,
      metadataFileSha256: metadata.sha256,
      worksheetSha256,
      skeletonSha256,
      validationReportSha256,
      reviewed: false,
    });
    await publishStagedEntries(options.outputDirectory, stagingDirectory, [
      "worksheet.json",
      "grouping-plan.skeleton.private.json",
      "grouping-validation.initial.json",
      "WORKSHEET_COMPLETE",
    ]);
  } catch (error) {
    await rm(options.outputDirectory, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
}

/** 在 prepare 发出任何模型请求前，重新核对物化标记、报告、映射和全部文本。 */
export async function assertHistoryMaterializationComplete(
  options: AssertHistoryMaterializationCompleteOptions,
): Promise<void> {
  const sourceDirectory = join(options.materializedDirectory, "sources");
  const reportFile = join(options.materializedDirectory, "report.json");
  const sourceConfirmationFile = join(
    options.materializedDirectory,
    "source-confirmation.private.json",
  );
  const completeFile = join(options.materializedDirectory, "MATERIALIZE_COMPLETE");
  await assertPathsInsidePrivateRoot(options.privateRootDirectory, [
    { path: options.materializedDirectory, kind: "existing" },
    { path: sourceDirectory, kind: "existing" },
    { path: reportFile, kind: "existing" },
    { path: sourceConfirmationFile, kind: "existing" },
    { path: completeFile, kind: "existing" },
  ]);
  const report = parsePrivateInput(
    historyMaterializeReportSchema,
    await readPrivateJson(reportFile),
    "INVALID_GROUPING",
    "物化目录的安全报告格式不正确。",
  );
  const sourceConfirmation = parsePrivateInput(
    historySourceMappingSchema,
    await readPrivateJson(sourceConfirmationFile),
    "INVALID_SOURCE_CONFIRMATION",
    "物化目录的源映射确认格式不正确。",
  );
  const marker = parsePrivateInput(
    historyMaterializeCompleteSchema,
    await readPrivateJson(completeFile),
    "INVALID_GROUPING",
    "物化目录没有可验证的完整完成标记。",
  );
  if (
    report.sources.length !== sourceConfirmation.mappings.length ||
    report.sourceCount !== report.sources.length ||
    marker.sourceCount !== report.sourceCount ||
    marker.fragmentCount !== report.fragmentCount ||
    marker.groupingBatchSha256 !== report.groupingBatchSha256 ||
    marker.reportSha256 !== sha256Hex(JSON.stringify(report)) ||
    marker.sourceConfirmationSha256 !== sha256Hex(JSON.stringify(sourceConfirmation))
  ) {
    throw new HistoryMigrationError("GROUPING_CHANGED", "物化报告、源映射或完成标记已经不一致。");
  }

  const actualSources: Array<{
    readonly sourceId: string;
    readonly sourceSha256: string;
    readonly byteLength: number;
  }> = [];
  for (const [index, mapping] of sourceConfirmation.mappings.entries()) {
    const sourceId = makeSafeId("source", index + 1);
    const reportSource = report.sources[index];
    if (
      reportSource === undefined ||
      reportSource.sourceId !== sourceId ||
      reportSource.sourceSha256 !== mapping.sourceSha256
    ) {
      throw new HistoryMigrationError("GROUPING_CHANGED", "物化报告中的安全源编号已经变化。");
    }
    const loaded = await readConfirmedSource(
      sourceDirectory,
      mapping.sourcePath,
      mapping.sourceSha256,
      sourceId,
    );
    const byteLength = new TextEncoder().encode(loaded.text).byteLength;
    if (
      reportSource.byteLength !== byteLength ||
      reportSource.characterCount !== loaded.text.length
    ) {
      throw new HistoryMigrationError("GROUPING_CHANGED", "物化报告中的文本计数已经变化。");
    }
    actualSources.push({
      sourceId,
      sourceSha256: loaded.sha256,
      byteLength,
    });
  }
  const confirmedPaths = sourceConfirmation.mappings
    .map((mapping) => mapping.sourcePath)
    .sort(compareCodeUnits);
  if (!arraysEqual(confirmedPaths, await listPrivateSourcePaths(sourceDirectory))) {
    throw new HistoryMigrationError("GROUPING_CHANGED", "物化源目录的文件集合已经变化。");
  }
  const sourceSetSha256 = sha256Hex(JSON.stringify({ version: 1, sources: actualSources }));
  if (marker.sourceSetSha256 !== sourceSetSha256) {
    throw new HistoryMigrationError("GROUPING_CHANGED", "物化文本集合与完成标记已经不一致。");
  }
}

function createGroupingValidationReport(
  inventory: HistorySourceInventory,
  metadataCount: number,
  grouping: HistoryGroupingDraft,
): z.infer<typeof historyGroupingValidationReportSchema> {
  const sourcesById = new Map(
    inventory.sources.map((source) => [source.sourceId, source] as const),
  );
  const metadataIds = Array.from({ length: metadataCount }, (_, index) =>
    makeMetadataId(index + 1),
  );
  const groupedMetadataIds = new Set(grouping.groups.map((group) => group.metadataId));
  const disposedMetadataIds = new Set(grouping.metadataDispositions.map((item) => item.metadataId));
  if ([...groupedMetadataIds].some((metadataId) => disposedMetadataIds.has(metadataId))) {
    throw new HistoryMigrationError("INVALID_GROUPING", "已分组元数据不能同时标为延期或忽略。");
  }
  const unresolvedMetadataIds = metadataIds.filter(
    (metadataId) => !groupedMetadataIds.has(metadataId) && !disposedMetadataIds.has(metadataId),
  );

  const selectedZipEntries = new Set<string>();
  const selectedTextRanges = new Map<string, Array<{ start: number; end: number }>>();
  const referencedTextSourceIds = new Set<string>();
  for (const fragment of grouping.fragments) {
    const source = sourcesById.get(fragment.sourceId);
    if (source === undefined) {
      throw new HistoryMigrationError("INVALID_GROUPING", "片段指向的源文件安全编号不存在。");
    }
    if (fragment.selection.kind === "zip_entry") {
      selectedZipEntries.add(zipEntryKey(fragment.sourceId, fragment.selection.entryId));
    } else if (fragment.selection.kind === "text_range") {
      referencedTextSourceIds.add(fragment.sourceId);
      addRange(
        selectedTextRanges,
        fragment.sourceId,
        fragment.selection.start,
        fragment.selection.end,
      );
    } else if (fragment.selection.kind === "whole_file") {
      if (source.kind !== "text") {
        throw new HistoryMigrationError("INVALID_GROUPING", "完整文件片段只能指向文本源文件。");
      }
      referencedTextSourceIds.add(fragment.sourceId);
      addRange(selectedTextRanges, fragment.sourceId, 0, source.characterCount);
    }
  }

  const disposedZipEntries = new Set<string>();
  const dispositionSummary: Array<{
    itemId: string;
    action: "converted" | "deferred" | "attachment" | "ignored";
    reasonSha256: string;
    convertedSourceId?: string;
  }> = [];
  for (const disposition of grouping.metadataDispositions) {
    dispositionSummary.push(dispositionSummaryItem(disposition.metadataId, disposition));
  }
  for (const disposition of grouping.zipEntryDispositions) {
    const source = sourcesById.get(disposition.sourceId);
    const key = zipEntryKey(disposition.sourceId, disposition.entryId);
    if (
      source?.kind !== "zip" ||
      !source.entries.some((entry) => entry.entryId === disposition.entryId) ||
      selectedZipEntries.has(key)
    ) {
      throw new HistoryMigrationError(
        "INVALID_GROUPING",
        "压缩包条目处置指向不存在或已经选入题目分组的条目。",
      );
    }
    disposedZipEntries.add(key);
    dispositionSummary.push(dispositionSummaryItem(key, disposition));
  }

  const disposedTextRanges = new Map<string, Array<{ start: number; end: number }>>();
  for (const disposition of grouping.textRangeDispositions) {
    const source = sourcesById.get(disposition.sourceId);
    if (
      source?.kind !== "text" ||
      disposition.end > source.characterCount ||
      rangesOverlapAny(
        { start: disposition.start, end: disposition.end },
        selectedTextRanges.get(disposition.sourceId) ?? [],
      ) ||
      rangesOverlapAny(
        { start: disposition.start, end: disposition.end },
        disposedTextRanges.get(disposition.sourceId) ?? [],
      )
    ) {
      throw new HistoryMigrationError(
        "INVALID_GROUPING",
        "文本处置范围越界、重复或与已选片段重叠。",
      );
    }
    addRange(disposedTextRanges, disposition.sourceId, disposition.start, disposition.end);
    dispositionSummary.push(
      dispositionSummaryItem(
        `${disposition.sourceId}:${disposition.start}:${disposition.end}`,
        disposition,
      ),
    );
  }

  const manualSources = inventory.sources.filter(
    (source) => source.kind === "file" || source.kind === "pdf",
  );
  const disposedManualSourceIds = new Set<string>();
  for (const disposition of grouping.manualSourceDispositions) {
    const source = sourcesById.get(disposition.sourceId);
    if (source === undefined || (source.kind !== "file" && source.kind !== "pdf")) {
      throw new HistoryMigrationError("INVALID_GROUPING", "人工源文件处置指向了非人工源文件。");
    }
    if (disposition.action === "converted") {
      const converted = sourcesById.get(disposition.convertedSourceId);
      if (
        converted?.kind !== "text" ||
        !referencedTextSourceIds.has(disposition.convertedSourceId)
      ) {
        throw new HistoryMigrationError(
          "INVALID_GROUPING",
          "标为已转换的人工源文件必须指向已实际进入分组的文本源文件。",
        );
      }
    }
    disposedManualSourceIds.add(disposition.sourceId);
    dispositionSummary.push(dispositionSummaryItem(disposition.sourceId, disposition));
  }

  const uncoveredTextRanges: Array<{ sourceId: string; start: number; end: number }> = [];
  for (const source of inventory.sources) {
    if (source.kind !== "text") {
      continue;
    }
    const covered = mergeRanges([
      ...(selectedTextRanges.get(source.sourceId) ?? []),
      ...(disposedTextRanges.get(source.sourceId) ?? []),
    ]);
    let cursor = 0;
    for (const range of covered) {
      if (range.start > cursor) {
        uncoveredTextRanges.push({ sourceId: source.sourceId, start: cursor, end: range.start });
      }
      cursor = Math.max(cursor, range.end);
    }
    if (cursor < source.characterCount) {
      uncoveredTextRanges.push({
        sourceId: source.sourceId,
        start: cursor,
        end: source.characterCount,
      });
    }
  }

  const unresolvedZipEntries: Array<{ sourceId: string; entryId: string }> = [];
  let zipEntryCount = 0;
  for (const source of inventory.sources) {
    if (source.kind !== "zip") {
      continue;
    }
    zipEntryCount += source.entries.length;
    for (const entry of source.entries) {
      const key = zipEntryKey(source.sourceId, entry.entryId);
      if (!selectedZipEntries.has(key) && !disposedZipEntries.has(key)) {
        unresolvedZipEntries.push({ sourceId: source.sourceId, entryId: entry.entryId });
      }
    }
  }
  const unresolvedManualSourceIds = manualSources
    .map((source) => source.sourceId)
    .filter((sourceId) => !disposedManualSourceIds.has(sourceId));
  const unresolvedItemCount =
    unresolvedMetadataIds.length +
    uncoveredTextRanges.length +
    unresolvedZipEntries.length +
    unresolvedManualSourceIds.length +
    (grouping.groups.length === 0 ? 1 : 0);
  return historyGroupingValidationReportSchema.parse({
    version: 1,
    phase: "grouping_validation",
    status: unresolvedItemCount === 0 ? "complete" : "incomplete",
    metadataCount,
    groupedMetadataCount: groupedMetadataIds.size,
    disposedMetadataCount: disposedMetadataIds.size,
    unresolvedMetadataIds,
    textSourceCount: inventory.sources.filter((source) => source.kind === "text").length,
    uncoveredTextRanges,
    zipEntryCount,
    selectedZipEntryCount: selectedZipEntries.size,
    disposedZipEntryCount: disposedZipEntries.size,
    unresolvedZipEntries,
    manualSourceCount: manualSources.length,
    disposedManualSourceCount: disposedManualSourceIds.size,
    unresolvedManualSourceIds,
    missingGroupCount: grouping.groups.length === 0 ? 1 : 0,
    dispositionSummary: dispositionSummary.sort((first, second) =>
      compareCodeUnits(first.itemId, second.itemId),
    ),
    unresolvedItemCount,
  });
}

async function loadVerifiedGrouping(
  groupingDirectory: string,
  catalog: VerifiedCatalog,
  metadataCount: number,
  metadataFileSha256: string,
): Promise<{
  readonly grouping: HistoryGroupingDraft;
  readonly validationReportSha256: string;
}> {
  const grouping = parsePrivateInput(
    historyGroupingDraftSchema,
    await readPrivateJson(join(groupingDirectory, "grouping.private.json")),
    "INVALID_GROUPING",
    "正式分组文件格式不正确。",
  );
  const validationReport = parsePrivateInput(
    historyGroupingValidationReportSchema,
    await readPrivateJson(join(groupingDirectory, "grouping-validation.json")),
    "INVALID_GROUPING",
    "分组完整性报告格式不正确。",
  );
  const marker = parsePrivateInput(
    historyGroupingCompleteSchema,
    await readPrivateJson(join(groupingDirectory, "GROUPING_COMPLETE")),
    "INVALID_GROUPING",
    "分组目录没有可验证的完整完成标记。",
  );
  const currentReport = createGroupingValidationReport(catalog.inventory, metadataCount, grouping);
  const groupingSha256 = sha256Hex(JSON.stringify(grouping));
  const validationReportSha256 = sha256Hex(JSON.stringify(validationReport));
  if (
    currentReport.status !== "complete" ||
    JSON.stringify(currentReport) !== JSON.stringify(validationReport) ||
    marker.catalogSha256 !== catalog.catalogSha256 ||
    marker.metadataFileSha256 !== metadataFileSha256 ||
    marker.groupingSha256 !== groupingSha256 ||
    marker.validationReportSha256 !== validationReportSha256 ||
    marker.fragmentCount !== grouping.fragments.length ||
    marker.groupCount !== grouping.groups.length
  ) {
    throw new HistoryMigrationError(
      "GROUPING_CHANGED",
      "正式分组、完整性报告或完成标记已经不一致。",
    );
  }
  return { grouping, validationReportSha256 };
}

function validateDispositionUnicodeBoundaries(
  grouping: HistoryGroupingDraft,
  sourcesById: ReadonlyMap<string, LoadedHistorySource>,
): void {
  for (const disposition of grouping.textRangeDispositions) {
    const source = sourcesById.get(disposition.sourceId);
    if (
      source?.inventory.kind !== "text" ||
      source.text === undefined ||
      !isUnicodeRangeBoundary(source.text, disposition.start) ||
      !isUnicodeRangeBoundary(source.text, disposition.end)
    ) {
      throw new HistoryMigrationError(
        "FRAGMENT_OUT_OF_RANGE",
        "文本处置范围不能切开 Unicode 代理项对。",
      );
    }
  }
}

function isUnicodeRangeBoundary(text: string, position: number): boolean {
  if (position <= 0 || position >= text.length) {
    return position >= 0 && position <= text.length;
  }
  const before = text.charCodeAt(position - 1);
  const after = text.charCodeAt(position);
  return !(before >= 0xd800 && before <= 0xdbff && after >= 0xdc00 && after <= 0xdfff);
}

function dispositionSummaryItem(
  itemId: string,
  disposition: {
    readonly action: "converted" | "deferred" | "attachment" | "ignored";
    readonly reason: string;
    readonly convertedSourceId?: string;
  },
): {
  readonly itemId: string;
  readonly action: "converted" | "deferred" | "attachment" | "ignored";
  readonly reasonSha256: string;
  readonly convertedSourceId?: string;
} {
  return {
    itemId,
    action: disposition.action,
    reasonSha256: sha256Hex(disposition.reason),
    ...(disposition.convertedSourceId === undefined
      ? {}
      : { convertedSourceId: disposition.convertedSourceId }),
  };
}

function addRange(
  rangesBySource: Map<string, Array<{ start: number; end: number }>>,
  sourceId: string,
  start: number,
  end: number,
): void {
  const ranges = rangesBySource.get(sourceId) ?? [];
  ranges.push({ start, end });
  rangesBySource.set(sourceId, ranges);
}

function rangesOverlapAny(
  candidate: { readonly start: number; readonly end: number },
  ranges: readonly { readonly start: number; readonly end: number }[],
): boolean {
  return ranges.some((range) => candidate.start < range.end && range.start < candidate.end);
}

function mergeRanges(
  ranges: readonly { readonly start: number; readonly end: number }[],
): Array<{ readonly start: number; readonly end: number }> {
  const sorted = [...ranges].sort(
    (first, second) => first.start - second.start || first.end - second.end,
  );
  const merged: Array<{ start: number; end: number }> = [];
  for (const range of sorted) {
    const previous = merged.at(-1);
    if (previous === undefined || range.start > previous.end) {
      merged.push({ start: range.start, end: range.end });
    } else {
      previous.end = Math.max(previous.end, range.end);
    }
  }
  return merged;
}

function zipEntryKey(sourceId: string, entryId: string): string {
  return `${sourceId}:${entryId}`;
}

function makeMetadataId(sequence: number): string {
  if (!Number.isSafeInteger(sequence) || sequence <= 0 || sequence > 999_999) {
    throw new HistoryMigrationError("INVALID_GROUPING", "元数据数量超过工具支持的范围。");
  }
  return `metadata-${sequence.toString().padStart(6, "0")}`;
}

function metadataIndexFromId(metadataId: string): number {
  const parsed = historyMetadataIdSchema.safeParse(metadataId);
  if (!parsed.success) {
    throw new HistoryMigrationError("INVALID_GROUPING", "元数据安全编号格式不正确。");
  }
  return Number.parseInt(metadataId.slice("metadata-".length), 10) - 1;
}

async function inspectSourceForInventory(
  sourceDirectory: string,
  sourcePath: string,
  sourceId: string,
): Promise<{
  readonly inventory: HistorySourceInventory["sources"][number];
  readonly location: CatalogSourceLocation;
  readonly manualReasons?: readonly HistorySourceInspectionReason[];
}> {
  const absolutePath = await resolvePrivateSourceFile(sourceDirectory, sourcePath);
  const bytes = await readPrivateRegularBytes(absolutePath, maximumCatalogSourceBytes);
  const contentSha256 = sha256Hex(bytes);
  const lowerExtension = extname(sourcePath).toLocaleLowerCase("en-US");

  if (lowerExtension === ".zip" || looksLikeZipArchive(bytes)) {
    let entries: ReturnType<typeof readSafeHistoryZip>;
    try {
      entries = [...readSafeHistoryZip(bytes)].sort((first, second) =>
        compareCodeUnits(first.path, second.path),
      );
    } catch (error) {
      if (error instanceof HistorySourceInspectionFailure) {
        return {
          inventory: {
            sourceId,
            kind: "file",
            contentSha256,
            byteLength: bytes.byteLength,
          },
          location: { sourceId, sourcePath, entries: [] },
          manualReasons: error.reasons,
        };
      }
      throw error;
    }
    if (entries.length === 0) {
      return {
        inventory: {
          sourceId,
          kind: "file",
          contentSha256,
          byteLength: bytes.byteLength,
        },
        location: { sourceId, sourcePath, entries: [] },
        manualReasons: ["empty_file"],
      };
    }
    return {
      inventory: {
        sourceId,
        kind: "zip",
        contentSha256,
        byteLength: bytes.byteLength,
        entries: entries.map((entry, index) => ({
          entryId: makeSafeId("entry", index + 1),
          contentSha256: sha256Hex(entry.content),
          byteLength: entry.content.byteLength,
        })),
      },
      location: {
        sourceId,
        sourcePath,
        entries: entries.map((entry, index) => ({
          entryId: makeSafeId("entry", index + 1),
          entryPath: entry.path,
        })),
      },
    };
  }

  if (lowerExtension === ".md" || lowerExtension === ".txt") {
    let text: string;
    try {
      text = decodeMaterializableText(bytes);
    } catch (error) {
      if (error instanceof HistorySourceInspectionFailure) {
        return {
          inventory: {
            sourceId,
            kind: "file",
            contentSha256,
            byteLength: bytes.byteLength,
          },
          location: { sourceId, sourcePath, entries: [] },
          manualReasons: error.reasons,
        };
      }
      throw error;
    }
    return {
      inventory: {
        sourceId,
        kind: "text",
        contentSha256,
        byteLength: bytes.byteLength,
        characterCount: text.length,
      },
      location: { sourceId, sourcePath, entries: [] },
    };
  }

  return {
    inventory: {
      sourceId,
      kind: "file",
      contentSha256,
      byteLength: bytes.byteLength,
    },
    location: { sourceId, sourcePath, entries: [] },
    manualReasons: ["manual_binary"],
  };
}

async function loadCurrentCatalogSources(options: {
  readonly sourceDirectory: string;
  readonly sourceInventoryFile: string;
  readonly sourceLocationsFile: string;
}): Promise<{
  readonly inventory: HistorySourceInventory;
  readonly sourcesById: ReadonlyMap<string, LoadedHistorySource>;
  readonly catalog: VerifiedCatalog;
}> {
  const catalog = await loadVerifiedCatalogArtifacts(
    options.sourceInventoryFile,
    options.sourceLocationsFile,
  );
  const { inventory, locations } = catalog;
  if (inventory.sources.length !== locations.sources.length) {
    throw new HistoryMigrationError("GROUPING_CHANGED", "源清单与私有源位置清单已经不一致。");
  }

  const currentPaths = await listPrivateSourcePaths(options.sourceDirectory);
  const confirmedPaths = locations.sources
    .map((source) => source.sourcePath)
    .sort(compareCodeUnits);
  if (!arraysEqual(currentPaths, confirmedPaths)) {
    throw new HistoryMigrationError(
      "GROUPING_CHANGED",
      "私有源目录中的文件集合已经变化，必须重新建立清单。",
    );
  }

  const locationsById = new Map(
    locations.sources.map((location) => [location.sourceId, location] as const),
  );
  const sourcesById = new Map<string, LoadedHistorySource>();
  for (const expected of inventory.sources) {
    const location = locationsById.get(expected.sourceId);
    if (location === undefined) {
      throw new HistoryMigrationError("GROUPING_CHANGED", "源清单中的安全编号已经变化。");
    }
    const loaded = await loadCurrentSource(options.sourceDirectory, expected, location);
    sourcesById.set(expected.sourceId, loaded);
  }
  if (!arraysEqual(confirmedPaths, await listPrivateSourcePaths(options.sourceDirectory))) {
    throw new HistoryMigrationError(
      "GROUPING_CHANGED",
      "私有源目录在核对过程中发生变化，必须重新开始。",
    );
  }
  if (sourcesById.size !== locations.sources.length) {
    throw new HistoryMigrationError("GROUPING_CHANGED", "私有源位置清单包含未确认的安全编号。");
  }
  return { inventory, sourcesById, catalog };
}

async function loadVerifiedCatalogArtifacts(
  sourceInventoryFile: string,
  sourceLocationsFile: string,
): Promise<VerifiedCatalog> {
  const catalogDirectory = dirname(resolve(sourceInventoryFile));
  if (resolve(sourceLocationsFile) !== join(catalogDirectory, "source-locations.private.json")) {
    throw new HistoryMigrationError(
      "GROUPING_CHANGED",
      "源清单与私有源位置清单不是同一次完整登记结果。",
    );
  }
  const inventory = await loadSourceInventory(sourceInventoryFile);
  const locations = parsePrivateInput(
    historySourceLocationsSchema,
    await readPrivateJson(sourceLocationsFile),
    "INVALID_GROUPING",
    "私有源位置清单格式不正确。",
  );
  const manualReview = parsePrivateInput(
    historyManualReviewSchema,
    await readPrivateJson(join(catalogDirectory, "manual-review.json")),
    "INVALID_GROUPING",
    "人工处理清单格式不正确。",
  );
  const marker = parsePrivateInput(
    historyInventoryCompleteSchema,
    await readPrivateJson(join(catalogDirectory, "INVENTORY_COMPLETE")),
    "INVALID_GROUPING",
    "源清单目录没有可验证的完整登记标记。",
  );
  const inventorySha256 = sha256Hex(JSON.stringify(inventory));
  const sourceLocationsSha256 = sha256Hex(JSON.stringify(locations));
  const manualReviewSha256 = sha256Hex(JSON.stringify(manualReview));
  const catalogSha256 = sha256Hex(
    JSON.stringify({
      version: 2,
      inventorySha256,
      sourceLocationsSha256,
      manualReviewSha256,
    }),
  );
  const manualSourceIds = inventory.sources
    .filter((source) => source.kind === "file" || source.kind === "pdf")
    .map((source) => source.sourceId)
    .sort(compareCodeUnits);
  const reviewedSourceIds = manualReview.sources
    .map((source) => source.sourceId)
    .sort(compareCodeUnits);
  const archiveEntryCount = inventory.sources.reduce(
    (count, source) => count + (source.kind === "zip" ? source.entries.length : 0),
    0,
  );
  const totalSourceBytes = inventory.sources.reduce(
    (count, source) => count + source.byteLength,
    0,
  );
  if (
    inventory.sources.length !== locations.sources.length ||
    manualReview.sourceCount !== inventory.sources.length ||
    manualReview.manualSourceCount !== manualSourceIds.length ||
    !arraysEqual(manualSourceIds, reviewedSourceIds) ||
    marker.inventorySha256 !== inventorySha256 ||
    marker.sourceLocationsSha256 !== sourceLocationsSha256 ||
    marker.manualReviewSha256 !== manualReviewSha256 ||
    marker.catalogSha256 !== catalogSha256 ||
    marker.sourceCount !== inventory.sources.length ||
    marker.archiveEntryCount !== archiveEntryCount ||
    marker.manualSourceCount !== manualSourceIds.length ||
    marker.totalSourceBytes !== totalSourceBytes
  ) {
    throw new HistoryMigrationError(
      "GROUPING_CHANGED",
      "源清单、私有位置、人工处理清单或完整登记标记已经不一致。",
    );
  }
  return {
    inventory,
    locations,
    manualReview,
    inventorySha256,
    sourceLocationsSha256,
    manualReviewSha256,
    catalogSha256,
  };
}

async function loadCurrentSource(
  sourceDirectory: string,
  expected: HistorySourceInventory["sources"][number],
  location: HistorySourceLocations["sources"][number],
): Promise<LoadedHistorySource> {
  const absolutePath = await resolvePrivateSourceFile(sourceDirectory, location.sourcePath);
  const bytes = await readPrivateRegularBytes(absolutePath, maximumCatalogSourceBytes);
  if (bytes.byteLength !== expected.byteLength || sha256Hex(bytes) !== expected.contentSha256) {
    throw new HistoryMigrationError(
      "GROUPING_CHANGED",
      `${expected.sourceId} 的内容已经变化，原来的源清单已失效。`,
    );
  }

  if (expected.kind === "text") {
    if (location.entries.length !== 0) {
      throw new HistoryMigrationError("GROUPING_CHANGED", "文本源文件不能带有压缩包条目位置。");
    }
    const text = decodeMaterializableText(bytes);
    if (text.length !== expected.characterCount) {
      throw new HistoryMigrationError(
        "GROUPING_CHANGED",
        `${expected.sourceId} 的文本长度已经变化。`,
      );
    }
    return { inventory: expected, bytes, text };
  }

  if (expected.kind === "zip") {
    const archiveEntries = readSafeHistoryZip(bytes);
    if (archiveEntries.length !== location.entries.length) {
      throw new HistoryMigrationError(
        "GROUPING_CHANGED",
        `${expected.sourceId} 的压缩包条目集合已经变化。`,
      );
    }
    const archiveByPath = new Map(
      archiveEntries.map((entry) => [entry.path, entry.content] as const),
    );
    const expectedEntriesById = new Map(
      expected.entries.map((entry) => [entry.entryId, entry] as const),
    );
    const zipEntriesById = new Map<string, Uint8Array>();
    for (const entryLocation of location.entries) {
      const expectedEntry = expectedEntriesById.get(entryLocation.entryId);
      const content = archiveByPath.get(entryLocation.entryPath);
      if (
        expectedEntry === undefined ||
        content === undefined ||
        content.byteLength !== expectedEntry.byteLength ||
        sha256Hex(content) !== expectedEntry.contentSha256
      ) {
        throw new HistoryMigrationError(
          "GROUPING_CHANGED",
          `${expected.sourceId} 的压缩包条目已经变化。`,
        );
      }
      zipEntriesById.set(entryLocation.entryId, content);
    }
    if (
      zipEntriesById.size !== expected.entries.length ||
      archiveByPath.size !== location.entries.length
    ) {
      throw new HistoryMigrationError(
        "GROUPING_CHANGED",
        `${expected.sourceId} 的压缩包条目映射已经变化。`,
      );
    }
    return { inventory: expected, bytes, zipEntriesById };
  }

  if (location.entries.length !== 0) {
    throw new HistoryMigrationError("GROUPING_CHANGED", "普通源文件不能带有压缩包条目位置。");
  }
  return { inventory: expected, bytes };
}

function materializeFragment(
  source: LoadedHistorySource,
  selection: z.infer<typeof historyFragmentSelectionSchema>,
): MaterializedFragment {
  switch (selection.kind) {
    case "text_range": {
      if (
        source.inventory.kind !== "text" ||
        source.text === undefined ||
        selection.end > source.text.length ||
        !isUnicodeRangeBoundary(source.text, selection.start) ||
        !isUnicodeRangeBoundary(source.text, selection.end)
      ) {
        throw new HistoryMigrationError(
          "FRAGMENT_OUT_OF_RANGE",
          "文本片段的字符范围超出当前源文件。",
        );
      }
      const text = source.text.slice(selection.start, selection.end);
      assertNonemptyMaterializedText(text);
      return { text, contentSha256: sha256Hex(text) };
    }
    case "zip_entry": {
      if (source.inventory.kind !== "zip") {
        throw new HistoryMigrationError(
          "FRAGMENT_OUT_OF_RANGE",
          "压缩包片段指向的源文件类型不正确。",
        );
      }
      const content = source.zipEntriesById?.get(selection.entryId);
      const expectedEntry = source.inventory.entries.find(
        (entry) => entry.entryId === selection.entryId,
      );
      if (content === undefined || expectedEntry === undefined) {
        throw new HistoryMigrationError("FRAGMENT_OUT_OF_RANGE", "压缩包片段的安全条目不存在。");
      }
      const text = decodeMaterializableText(content);
      return { text, contentSha256: expectedEntry.contentSha256 };
    }
    case "whole_file": {
      if (source.inventory.kind !== "text" || source.text === undefined) {
        throw new HistoryMigrationError(
          "SOURCE_FILE_INVALID",
          "完整文件片段只允许使用已经登记并复核为 UTF-8 文本的源文件。",
        );
      }
      return { text: source.text, contentSha256: source.inventory.contentSha256 };
    }
    case "pdf_pages":
      throw new HistoryMigrationError(
        "SOURCE_FILE_INVALID",
        "当前分组工作流不自动提取 PDF 页；必须先在私有目录人工转成文本。",
      );
  }
}

async function loadSourceInventory(path: string): Promise<HistorySourceInventory> {
  return parsePrivateInput(
    historySourceInventorySchema,
    await readPrivateJson(path),
    "INVALID_GROUPING",
    "历史资料源清单格式不正确。",
  );
}

async function loadMetadata(
  path: string,
): Promise<{ readonly value: HistoryMetadataFile; readonly sha256: string }> {
  const raw = await readPrivateJsonWithDigest(path);
  return {
    value: parsePrivateInput(
      historyMetadataFileSchema,
      raw.value,
      "INVALID_METADATA",
      "私有元数据格式不正确。",
    ),
    sha256: raw.sha256,
  };
}

async function listPrivateSourcePaths(sourceDirectory: string): Promise<string[]> {
  let rootRealPath: string;
  try {
    const metadata = await lstat(sourceDirectory);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
      throw new Error("invalid source root");
    }
    rootRealPath = await realpath(sourceDirectory);
  } catch {
    throw new HistoryMigrationError("SOURCE_FILE_INVALID", "私有源目录无法安全读取。");
  }

  const paths: string[] = [];
  const foldedPaths = new Set<string>();
  async function walk(relativeDirectory: string): Promise<void> {
    const absoluteDirectory =
      relativeDirectory.length === 0
        ? rootRealPath
        : resolve(rootRealPath, ...relativeDirectory.split("/"));
    let entries: Dirent<string>[];
    try {
      const currentRealPath = await realpath(absoluteDirectory);
      const metadata = await lstat(absoluteDirectory);
      if (
        currentRealPath !== absoluteDirectory ||
        !metadata.isDirectory() ||
        metadata.isSymbolicLink()
      ) {
        throw new Error("unsafe directory");
      }
      entries = await readdir(absoluteDirectory, { withFileTypes: true });
    } catch {
      throw new HistoryMigrationError("SOURCE_FILE_INVALID", "私有源目录包含无法安全读取的目录。");
    }

    entries.sort((first, second) => compareCodeUnits(first.name, second.name));
    for (const entry of entries) {
      const sourcePath =
        relativeDirectory.length === 0 ? entry.name : `${relativeDirectory}/${entry.name}`;
      if (!isSafeArchivePath(sourcePath)) {
        throw new HistoryMigrationError(
          "SOURCE_FILE_INVALID",
          "私有源目录包含不安全或过深的相对路径。",
        );
      }
      const absolutePath = resolve(rootRealPath, ...sourcePath.split("/"));
      let metadata: Awaited<ReturnType<typeof lstat>>;
      try {
        metadata = await lstat(absolutePath);
      } catch {
        throw new HistoryMigrationError("SOURCE_FILE_INVALID", "私有源目录在检查过程中发生变化。");
      }
      if (metadata.isSymbolicLink()) {
        throw new HistoryMigrationError("SOURCE_FILE_INVALID", "私有源目录不能包含符号链接。");
      }
      if (metadata.isDirectory()) {
        await walk(sourcePath);
        continue;
      }
      if (!metadata.isFile()) {
        throw new HistoryMigrationError(
          "SOURCE_FILE_INVALID",
          "私有源目录只能包含普通文件和真实目录。",
        );
      }
      const folded = foldPrivatePath(sourcePath);
      if (foldedPaths.has(folded)) {
        throw new HistoryMigrationError(
          "SOURCE_FILE_INVALID",
          "私有源目录包含只靠大小写或 Unicode 形式区分的冲突路径。",
        );
      }
      foldedPaths.add(folded);
      paths.push(sourcePath);
      if (paths.length > maximumCatalogFiles) {
        throw new HistoryMigrationError("SOURCE_TOO_LARGE", "私有源目录中的文件数量超过明确上限。");
      }
    }
  }

  await walk("");
  return paths.sort(compareCodeUnits);
}

async function resolvePrivateSourceFile(
  sourceDirectory: string,
  sourcePath: string,
): Promise<string> {
  if (!isSafeArchivePath(sourcePath)) {
    throw new HistoryMigrationError("SOURCE_FILE_INVALID", "私有源文件的相对路径不安全。");
  }
  let rootRealPath: string;
  let fileRealPath: string;
  try {
    rootRealPath = await realpath(sourceDirectory);
    fileRealPath = await realpath(resolve(rootRealPath, ...sourcePath.split("/")));
  } catch {
    throw new HistoryMigrationError("SOURCE_FILE_INVALID", "私有源文件不存在或无法安全读取。");
  }
  const expectedPath = resolve(rootRealPath, ...sourcePath.split("/"));
  const pathFromRoot = relative(rootRealPath, fileRealPath);
  if (fileRealPath !== expectedPath || pathFromRoot.startsWith("..") || isAbsolute(pathFromRoot)) {
    throw new HistoryMigrationError("SOURCE_FILE_INVALID", "私有源文件经过符号链接或超出源目录。");
  }
  return fileRealPath;
}

function readSafeHistoryZip(
  bytes: Uint8Array,
): ReturnType<ReturnType<typeof readZipArchive>["list"]> {
  try {
    return readZipArchive(bytes, {
      maxArchiveBytes: maximumCatalogSourceBytes,
      maxEntries: 100_000,
      maxSingleFileBytes: maximumCatalogSourceBytes,
      maxTotalUncompressedBytes: maximumCatalogSourceBytes,
      maxCompressionRatio: 200,
      allowNestedArchives: false,
    }).list();
  } catch (error) {
    const reasons: readonly HistorySourceInspectionReason[] =
      error instanceof UnsafeArchiveError
        ? [...new Set(error.issues.map((issue) => issue.code))].sort()
        : ["archive_invalid"];
    throw new HistorySourceInspectionFailure(
      "SOURCE_FILE_INVALID",
      reasons,
      "私有压缩包未通过路径、类型、大小或完整性安全检查。",
    );
  }
}

function decodeMaterializableText(bytes: Uint8Array): string {
  if (bytes.byteLength > maximumHistorySourceBytes) {
    throw new HistorySourceInspectionFailure(
      "SOURCE_TOO_LARGE",
      ["text_too_large"],
      "待分组文本超过明确的存储字节上限。",
    );
  }
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new HistorySourceInspectionFailure(
      "SOURCE_FILE_INVALID",
      ["text_not_utf8"],
      "选中的历史资料片段不是有效的 UTF-8 文本。",
    );
  }
  if (text.length > maximumHistorySourceTextUnits) {
    throw new HistorySourceInspectionFailure(
      "SOURCE_TOO_LARGE",
      ["text_too_large"],
      "待分组文本超过明确的字符长度上限。",
    );
  }
  assertNonemptyMaterializedText(text);
  return text;
}

function assertNonemptyMaterializedText(text: string): void {
  if (text.trim().length === 0) {
    throw new HistorySourceInspectionFailure(
      "SOURCE_FILE_INVALID",
      ["text_empty"],
      "选中的历史资料片段是空白文本。",
    );
  }
}

function assertMaterializedTextSize(text: string): void {
  assertNonemptyMaterializedText(text);
  if (
    text.length > maximumHistorySourceTextUnits ||
    new TextEncoder().encode(text).byteLength > maximumHistorySourceBytes
  ) {
    throw new HistoryMigrationError(
      "SOURCE_TOO_LARGE",
      "合并后的单题文本超过明确上限；工具不会截断。",
    );
  }
}

function joinMaterializedFragments(
  fragments: readonly { readonly fragmentId: string; readonly text: string }[],
): string {
  const first = fragments[0];
  if (first === undefined) {
    throw new HistoryMigrationError("INVALID_GROUPING", "题目分组至少需要一个片段。");
  }
  let output = first.text;
  for (const fragment of fragments.slice(1)) {
    output += `\n\n<!-- 历史人工分组片段边界：${fragment.fragmentId} -->\n\n${fragment.text}`;
  }
  return output;
}

async function publishStagedEntries(
  outputDirectory: string,
  stagingDirectory: string,
  entries: readonly string[],
): Promise<void> {
  for (const entry of entries) {
    await rename(join(stagingDirectory, entry), join(outputDirectory, entry));
  }
  await rmdir(stagingDirectory);
}

async function writeInventoryFailureOutput(
  outputDirectory: string,
  sourceCount: number,
  failures: readonly {
    readonly sourceId: string;
    readonly sourcePath: string;
    readonly code: "SOURCE_FILE_INVALID" | "SOURCE_TOO_LARGE";
    readonly reasons: readonly HistorySourceInspectionReason[];
  }[],
): Promise<void> {
  await createNewPrivateDirectory(outputDirectory);
  const stagingDirectory = join(outputDirectory, ".inventory-failed-incomplete");
  try {
    await mkdir(stagingDirectory, { recursive: false, mode: 0o700 });
    await writeNewPrivateJson(join(stagingDirectory, "inventory-failures.private.json"), {
      version: 1,
      phase: "inventory",
      status: "failed",
      sourceCount,
      failureCount: failures.length,
      failures,
    });
    await writeNewPrivateJson(join(stagingDirectory, "INVENTORY_FAILED"), {
      version: 1,
      phase: "inventory",
      status: "failed",
      sourceCount,
      failureCount: failures.length,
    });
    await publishStagedEntries(outputDirectory, stagingDirectory, [
      "inventory-failures.private.json",
      "INVENTORY_FAILED",
    ]);
  } catch (error) {
    await rm(outputDirectory, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
}

function assertOutputOutsideSource(sourceDirectory: string, outputPath: string): void {
  const pathFromSource = relative(resolve(sourceDirectory), resolve(outputPath));
  if (
    pathFromSource.length === 0 ||
    (!pathFromSource.startsWith("..") && !isAbsolute(pathFromSource))
  ) {
    throw new HistoryMigrationError(
      "INVALID_ARGUMENTS",
      "清单或物化输出不能放在本批私有源目录内部。",
    );
  }
}

function makeSafeId(prefix: "source" | "entry", sequence: number): string {
  if (!Number.isSafeInteger(sequence) || sequence <= 0 || sequence > 999_999) {
    throw new HistoryMigrationError("SOURCE_TOO_LARGE", "安全编号数量超过工具支持的范围。");
  }
  return `${prefix}-${sequence.toString().padStart(6, "0")}`;
}

function compareCodeUnits(first: string, second: string): number {
  return first < second ? -1 : first > second ? 1 : 0;
}

function foldPrivatePath(path: string): string {
  return path.normalize("NFC").toLocaleLowerCase("en-US");
}

function arraysEqual(first: readonly string[], second: readonly string[]): boolean {
  return first.length === second.length && first.every((value, index) => value === second[index]);
}

function parsePrivateInput<T>(
  schema: z.ZodType<T>,
  input: unknown,
  code: "INVALID_GROUPING" | "INVALID_METADATA" | "INVALID_SOURCE_CONFIRMATION",
  message: string,
): T {
  const parsed = schema.safeParse(input);
  if (!parsed.success) {
    throw new HistoryMigrationError(code, message);
  }
  return parsed.data;
}

function addDuplicateIssues(
  values: readonly string[],
  context: z.RefinementCtx,
  path: readonly (string | number)[],
  message: string,
): void {
  const seen = new Set<string>();
  for (const [index, value] of values.entries()) {
    if (seen.has(value)) {
      context.addIssue({
        code: "custom",
        path: [...path, index],
        message,
      });
    }
    seen.add(value);
  }
}
