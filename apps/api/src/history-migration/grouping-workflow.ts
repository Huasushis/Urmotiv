import { extname, isAbsolute, join, relative, resolve } from "node:path";
import type { Dirent } from "node:fs";
import { lstat, mkdir, readdir, realpath, rename, rm, rmdir } from "node:fs/promises";
import {
  defaultArchiveSafetyLimits,
  isSafeArchivePath,
  looksLikeZipArchive,
  readZipArchive,
} from "@urmotiv/problem-package";
import { z } from "zod";
import { sha256Hex } from "./digests";
import { HistoryMigrationError } from "./errors";
import {
  assertHistoryGroupingConfirmation,
  createHistoryGroupingConfirmation,
  historyFragmentIdSchema,
  historyFragmentSelectionSchema,
  historyGroupingDraftSchema,
  historySourceInventorySchema,
  historyZipEntryIdSchema,
  validateHistoryGrouping,
  type HistoryGroupingDraft,
  type HistorySourceInventory,
} from "./grouping";
import {
  assertNewOutputPath,
  assertPathsInsidePrivateRoot,
  createNewPrivateDirectory,
  maximumHistorySourceBytes,
  maximumHistorySourceTextUnits,
  readPrivateJson,
  readPrivateJsonWithDigest,
  readPrivateRegularBytes,
  writeNewPrivateFile,
  writeNewPrivateJson,
} from "./private-files";
import {
  historyMetadataFileSchema,
  historySourceIdSchema,
  historySourceMappingSchema,
  type HistoryMetadataFile,
} from "./schema";

const maximumCatalogFiles = 10_000;
const maximumCatalogTotalBytes = 512 * 1024 * 1024;
const maximumCatalogSourceBytes = defaultArchiveSafetyLimits.maxArchiveBytes;

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
    version: z.literal(1),
    fragments: z.array(historyGroupingPlanFragmentSchema).min(1).max(100_000),
    groups: historyGroupingDraftSchema.shape.groups,
    sharingConfirmations: historyGroupingDraftSchema.shape.sharingConfirmations,
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
  readonly outputFile: string;
}

export interface SealHistoryGroupingResult {
  readonly sourceCount: number;
  readonly fragmentCount: number;
  readonly groupCount: number;
}

export interface WriteHistoryGroupingConfirmationOptions {
  readonly privateRootDirectory: string;
  readonly sourceInventoryFile: string;
  readonly metadataFile: string;
  readonly groupingFile: string;
  readonly outputFile: string;
  readonly confirmed: boolean;
}

export interface MaterializeHistoryGroupingOptions {
  readonly privateRootDirectory: string;
  readonly sourceDirectory: string;
  readonly sourceInventoryFile: string;
  readonly sourceLocationsFile: string;
  readonly metadataFile: string;
  readonly groupingFile: string;
  readonly groupingConfirmationFile: string;
  readonly outputDirectory: string;
}

export interface MaterializeHistoryGroupingResult {
  readonly sourceCount: number;
  readonly fragmentCount: number;
  readonly unreferencedSourceCount: number;
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

/**
 * 对私有源目录建立两份清单：inventory.json 只有安全编号和摘要；
 * source-locations.private.json 才保存原相对路径。两份文件都只写进新的私有目录。
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
  let totalSourceBytes = 0;
  let archiveEntryCount = 0;

  for (const [index, sourcePath] of sourcePaths.entries()) {
    const sourceId = makeSafeId("source", index + 1);
    const inspected = await inspectSourceForInventory(
      options.sourceDirectory,
      sourcePath,
      sourceId,
    );
    totalSourceBytes += inspected.inventory.byteLength;
    if (totalSourceBytes > maximumCatalogTotalBytes) {
      throw new HistoryMigrationError("SOURCE_TOO_LARGE", "本批私有源文件的总大小超过明确上限。");
    }
    if (inspected.inventory.kind === "zip") {
      archiveEntryCount += inspected.inventory.entries.length;
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
  const inventorySha256 = sha256Hex(JSON.stringify(inventory));

  await createNewPrivateDirectory(options.outputDirectory);
  const stagingDirectory = join(options.outputDirectory, ".inventory-incomplete");
  try {
    await mkdir(stagingDirectory, { recursive: false, mode: 0o700 });
    await writeNewPrivateJson(join(stagingDirectory, "inventory.json"), inventory);
    await writeNewPrivateJson(
      join(stagingDirectory, "source-locations.private.json"),
      sourceLocations,
    );
    await writeNewPrivateJson(join(stagingDirectory, "INVENTORY_COMPLETE"), {
      version: 1,
      phase: "inventory",
      inventorySha256,
      sourceCount: inventory.sources.length,
      archiveEntryCount,
      totalSourceBytes,
    });
    await publishStagedEntries(options.outputDirectory, stagingDirectory, [
      "inventory.json",
      "source-locations.private.json",
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
    { path: options.outputFile, kind: "new" },
  ]);
  await assertNewOutputPath(options.outputFile);
  assertOutputOutsideSource(options.sourceDirectory, options.outputFile);

  const { inventory, sourcesById } = await loadCurrentCatalogSources(options);
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
    version: 1,
    fragments,
    groups: plan.groups,
    sharingConfirmations: plan.sharingConfirmations,
  };
  validateHistoryGrouping({
    sourceInventory: inventory,
    metadataFileSha256: metadata.sha256,
    metadataNumbers: metadata.value.records.map((record) => record.number),
    grouping,
  });
  await writeNewPrivateJson(options.outputFile, grouping);

  return {
    sourceCount: inventory.sources.length,
    fragmentCount: grouping.fragments.length,
    groupCount: grouping.groups.length,
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
    { path: options.metadataFile, kind: "existing" },
    { path: options.groupingFile, kind: "existing" },
    { path: options.outputFile, kind: "new" },
  ]);
  await assertNewOutputPath(options.outputFile);

  const inventory = await loadSourceInventory(options.sourceInventoryFile);
  const metadata = await loadMetadata(options.metadataFile);
  const grouping = await readPrivateJson(options.groupingFile);
  const confirmation = createHistoryGroupingConfirmation({
    sourceInventory: inventory,
    metadataFileSha256: metadata.sha256,
    metadataNumbers: metadata.value.records.map((record) => record.number),
    grouping,
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
    { path: options.groupingFile, kind: "existing" },
    { path: options.groupingConfirmationFile, kind: "existing" },
    { path: options.outputDirectory, kind: "new" },
  ]);
  assertOutputOutsideSource(options.sourceDirectory, options.outputDirectory);

  const { inventory, sourcesById } = await loadCurrentCatalogSources(options);
  const metadata = await loadMetadata(options.metadataFile);
  const groupingInput = await readPrivateJson(options.groupingFile);
  const checked = validateHistoryGrouping({
    sourceInventory: inventory,
    metadataFileSha256: metadata.sha256,
    metadataNumbers: metadata.value.records.map((record) => record.number),
    grouping: groupingInput,
  });
  await assertHistoryGroupingConfirmation(
    {
      sourceInventory: inventory,
      metadataFileSha256: metadata.sha256,
      metadataNumbers: metadata.value.records.map((record) => record.number),
      grouping: checked.grouping,
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
    return {
      groupId: group.groupId,
      metadataNumber: group.metadataNumber,
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
  const referencedSourceIds = new Set(
    checked.grouping.fragments.map((fragment) => fragment.sourceId),
  );
  const unreferencedSourceCount = inventory.sources.filter(
    (source) => !referencedSourceIds.has(source.sourceId),
  ).length;

  await createNewPrivateDirectory(options.outputDirectory);
  const stagingDirectory = join(options.outputDirectory, ".materialize-incomplete");
  try {
    await mkdir(stagingDirectory, { recursive: false, mode: 0o700 });
    const stagedSources = join(stagingDirectory, "sources");
    await mkdir(stagedSources, { recursive: false, mode: 0o700 });
    for (const output of outputs) {
      await writeNewPrivateFile(join(stagedSources, output.sourcePath), output.text);
    }
    await writeNewPrivateJson(
      join(stagingDirectory, "source-confirmation.private.json"),
      sourceConfirmation,
    );
    await writeNewPrivateJson(join(stagingDirectory, "report.json"), {
      version: 1,
      phase: "materialize",
      sourceInventorySha256: sha256Hex(JSON.stringify(inventory)),
      fragmentCount: checked.grouping.fragments.length,
      sourceCount: outputs.length,
      unreferencedSourceCount,
      sources: outputs.map((output) => ({
        groupId: output.groupId,
        sourceId: output.sourceId,
        sourceSha256: output.sourceSha256,
        fragmentCount: output.fragmentCount,
        byteLength: output.byteLength,
        characterCount: output.characterCount,
        status: "ready_for_prepare",
      })),
    });
    await writeNewPrivateJson(join(stagingDirectory, "MATERIALIZE_COMPLETE"), {
      version: 1,
      phase: "materialize",
      sourceCount: outputs.length,
      fragmentCount: checked.grouping.fragments.length,
      unreferencedSourceCount,
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
    unreferencedSourceCount,
  };
}

async function inspectSourceForInventory(
  sourceDirectory: string,
  sourcePath: string,
  sourceId: string,
): Promise<{
  readonly inventory: HistorySourceInventory["sources"][number];
  readonly location: CatalogSourceLocation;
}> {
  const absolutePath = await resolvePrivateSourceFile(sourceDirectory, sourcePath);
  const bytes = await readPrivateRegularBytes(absolutePath, maximumCatalogSourceBytes);
  const contentSha256 = sha256Hex(bytes);
  const lowerExtension = extname(sourcePath).toLocaleLowerCase("en-US");

  if (lowerExtension === ".zip" || looksLikeZipArchive(bytes)) {
    const entries = [...readSafeHistoryZip(bytes)].sort((first, second) =>
      compareCodeUnits(first.path, second.path),
    );
    if (entries.length === 0) {
      throw new HistoryMigrationError("SOURCE_FILE_INVALID", "私有压缩包中没有可登记的普通文件。");
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
    const text = decodeMaterializableText(bytes);
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
  };
}

async function loadCurrentCatalogSources(options: {
  readonly sourceDirectory: string;
  readonly sourceInventoryFile: string;
  readonly sourceLocationsFile: string;
}): Promise<{
  readonly inventory: HistorySourceInventory;
  readonly sourcesById: ReadonlyMap<string, LoadedHistorySource>;
}> {
  const inventory = await loadSourceInventory(options.sourceInventoryFile);
  const locations = parsePrivateInput(
    historySourceLocationsSchema,
    await readPrivateJson(options.sourceLocationsFile),
    "INVALID_GROUPING",
    "私有源位置清单格式不正确。",
  );
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
  return { inventory, sourcesById };
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
  if (expected.kind === "pdf") {
    throw new HistoryMigrationError(
      "SOURCE_FILE_INVALID",
      "当前分组工作流不自动提取 PDF 页；必须先在私有目录人工转成文本。",
    );
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
        selection.end > source.text.length
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
      if (source.inventory.kind === "zip" || source.inventory.kind === "pdf") {
        throw new HistoryMigrationError(
          "SOURCE_FILE_INVALID",
          "压缩包或 PDF 不能作为整段文本；必须明确选择可复核的文本片段。",
        );
      }
      const text =
        source.inventory.kind === "text" && source.text !== undefined
          ? source.text
          : decodeMaterializableText(source.bytes);
      return { text, contentSha256: source.inventory.contentSha256 };
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
  } catch {
    throw new HistoryMigrationError(
      "SOURCE_FILE_INVALID",
      "私有压缩包未通过路径、类型、大小或完整性安全检查。",
    );
  }
}

function decodeMaterializableText(bytes: Uint8Array): string {
  if (bytes.byteLength > maximumHistorySourceBytes) {
    throw new HistoryMigrationError("SOURCE_TOO_LARGE", "待分组文本超过明确的存储字节上限。");
  }
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new HistoryMigrationError(
      "SOURCE_FILE_INVALID",
      "选中的历史资料片段不是有效的 UTF-8 文本。",
    );
  }
  if (text.length > maximumHistorySourceTextUnits) {
    throw new HistoryMigrationError("SOURCE_TOO_LARGE", "待分组文本超过明确的字符长度上限。");
  }
  assertNonemptyMaterializedText(text);
  return text;
}

function assertNonemptyMaterializedText(text: string): void {
  if (text.trim().length === 0) {
    throw new HistoryMigrationError("SOURCE_FILE_INVALID", "选中的历史资料片段是空白文本。");
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
