import { z } from "zod";
import { sha256Hex } from "./digests";
import { HistoryMigrationError } from "./errors";
import { historyContentDigestSchema, historySourceIdSchema } from "./schema";

export const historyFragmentIdSchema = z
  .string()
  .regex(/^fragment-[0-9]{6}$/, "片段安全编号格式不正确。");

export const historyGroupIdSchema = z
  .string()
  .regex(/^group-[0-9]{6}$/, "题目分组安全编号格式不正确。");

export const historyMetadataIdSchema = z
  .string()
  .regex(/^metadata-[0-9]{6}$/, "元数据安全编号格式不正确。");

export const historyZipEntryIdSchema = z
  .string()
  .regex(/^entry-[0-9]{6}$/, "压缩包条目安全编号格式不正确。");

const historySourceBaseShape = {
  sourceId: historySourceIdSchema,
  contentSha256: historyContentDigestSchema,
  byteLength: z.number().int().nonnegative(),
};

const maximumConflictConfirmations = 100_000;

const historyTextSourceSchema = z
  .object({
    ...historySourceBaseShape,
    kind: z.literal("text"),
    characterCount: z.number().int().nonnegative(),
  })
  .strict();

const historyPdfSourceSchema = z
  .object({
    ...historySourceBaseShape,
    kind: z.literal("pdf"),
    pageCount: z.number().int().positive(),
  })
  .strict();

const historyZipSourceSchema = z
  .object({
    ...historySourceBaseShape,
    kind: z.literal("zip"),
    entries: z
      .array(
        z
          .object({
            entryId: historyZipEntryIdSchema,
            contentSha256: historyContentDigestSchema,
            byteLength: z.number().int().nonnegative(),
          })
          .strict(),
      )
      .min(1)
      .max(100_000),
  })
  .strict()
  .superRefine((value, context) => {
    addDuplicateIssues(
      value.entries.map((entry) => entry.entryId),
      context,
      ["entries"],
      "同一个压缩包条目安全编号不能重复。",
    );
  });

const historyWholeFileSourceSchema = z
  .object({
    ...historySourceBaseShape,
    kind: z.literal("file"),
  })
  .strict();

export const historySourceInventorySchema = z
  .object({
    version: z.literal(1),
    sources: z
      .array(
        z.discriminatedUnion("kind", [
          historyTextSourceSchema,
          historyPdfSourceSchema,
          historyZipSourceSchema,
          historyWholeFileSourceSchema,
        ]),
      )
      .min(1)
      .max(10_000),
  })
  .strict()
  .superRefine((value, context) => {
    addDuplicateIssues(
      value.sources.map((source) => source.sourceId),
      context,
      ["sources"],
      "同一个源文件安全编号不能重复。",
    );
  });

export const historyFragmentSelectionSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("text_range"),
      start: z.number().int().nonnegative(),
      end: z.number().int().positive(),
    })
    .strict()
    .refine((value) => value.end > value.start, {
      message: "文本片段的结束位置必须在开始位置之后。",
    }),
  z
    .object({
      kind: z.literal("pdf_pages"),
      firstPage: z.number().int().positive(),
      lastPage: z.number().int().positive(),
    })
    .strict()
    .refine((value) => value.lastPage >= value.firstPage, {
      message: "PDF 片段的结束页不能早于开始页。",
    }),
  z
    .object({
      kind: z.literal("zip_entry"),
      entryId: historyZipEntryIdSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("whole_file"),
    })
    .strict(),
]);

export const historySourceFragmentSchema = z
  .object({
    fragmentId: historyFragmentIdSchema,
    sourceId: historySourceIdSchema,
    selection: historyFragmentSelectionSchema,
    contentSha256: historyContentDigestSchema,
  })
  .strict();

const historyDispositionReasonSchema = z.string().trim().min(1).max(2_000);

const historyMetadataDispositionSchema = z
  .object({
    metadataId: historyMetadataIdSchema,
    action: z.enum(["deferred", "ignored"]),
    reason: historyDispositionReasonSchema,
    confirmed: z.literal(true),
  })
  .strict();

const historyZipEntryDispositionSchema = z
  .object({
    sourceId: historySourceIdSchema,
    entryId: historyZipEntryIdSchema,
    action: z.enum(["deferred", "attachment", "ignored"]),
    reason: historyDispositionReasonSchema,
    confirmed: z.literal(true),
  })
  .strict();

const historyTextRangeDispositionSchema = z
  .object({
    sourceId: historySourceIdSchema,
    start: z.number().int().nonnegative(),
    end: z.number().int().positive(),
    action: z.enum(["deferred", "attachment", "ignored"]),
    reason: historyDispositionReasonSchema,
    confirmed: z.literal(true),
  })
  .strict()
  .refine((value) => value.end > value.start, {
    message: "文本处置范围的结束位置必须在开始位置之后。",
  });

const historyManualSourceDispositionSchema = z.discriminatedUnion("action", [
  z
    .object({
      sourceId: historySourceIdSchema,
      action: z.literal("converted"),
      convertedSourceId: historySourceIdSchema,
      reason: historyDispositionReasonSchema,
      confirmed: z.literal(true),
    })
    .strict()
    .refine((value) => value.convertedSourceId !== value.sourceId, {
      message: "人工转换后的文本必须使用另一个源文件安全编号。",
    }),
  z
    .object({
      sourceId: historySourceIdSchema,
      action: z.enum(["deferred", "attachment", "ignored"]),
      reason: historyDispositionReasonSchema,
      confirmed: z.literal(true),
    })
    .strict(),
]);

const sharedFragmentConfirmationSchema = z
  .object({
    kind: z.literal("shared_fragment"),
    fragmentId: historyFragmentIdSchema,
    groupIds: z.tuple([historyGroupIdSchema, historyGroupIdSchema]),
    confirmed: z.literal(true),
  })
  .strict()
  .refine((value) => value.groupIds[0] !== value.groupIds[1], {
    message: "共用片段确认必须指向两个不同的题目分组。",
  });

const overlappingFragmentsConfirmationSchema = z
  .object({
    kind: z.literal("overlapping_fragments"),
    fragmentIds: z.tuple([historyFragmentIdSchema, historyFragmentIdSchema]),
    confirmed: z.literal(true),
  })
  .strict()
  .refine((value) => value.fragmentIds[0] !== value.fragmentIds[1], {
    message: "重叠片段确认必须指向两个不同的片段。",
  });

export const historyGroupingDraftSchema = z
  .object({
    version: z.literal(2),
    fragments: z.array(historySourceFragmentSchema).max(100_000),
    groups: z
      .array(
        z
          .object({
            groupId: historyGroupIdSchema,
            metadataId: historyMetadataIdSchema,
            fragmentIds: z.array(historyFragmentIdSchema).min(1).max(10_000),
          })
          .strict()
          .superRefine((value, context) => {
            addDuplicateIssues(
              value.fragmentIds,
              context,
              ["fragmentIds"],
              "同一个题目分组不能重复列出同一片段。",
            );
          }),
      )
      .max(10_000),
    sharingConfirmations: z
      .array(
        z.discriminatedUnion("kind", [
          sharedFragmentConfirmationSchema,
          overlappingFragmentsConfirmationSchema,
        ]),
      )
      .max(100_000)
      .default([]),
    metadataDispositions: z.array(historyMetadataDispositionSchema).max(10_000).default([]),
    zipEntryDispositions: z.array(historyZipEntryDispositionSchema).max(100_000).default([]),
    textRangeDispositions: z.array(historyTextRangeDispositionSchema).max(100_000).default([]),
    manualSourceDispositions: z.array(historyManualSourceDispositionSchema).max(10_000).default([]),
  })
  .strict()
  .superRefine((value, context) => {
    addDuplicateIssues(
      value.fragments.map((fragment) => fragment.fragmentId),
      context,
      ["fragments"],
      "片段安全编号不能重复。",
    );
    addDuplicateIssues(
      value.groups.map((group) => group.groupId),
      context,
      ["groups"],
      "题目分组安全编号不能重复。",
    );
    addDuplicateIssues(
      value.groups.map((group) => group.metadataId),
      context,
      ["groups"],
      "同一条元数据不能分配给多个题目分组。",
    );
    addDuplicateIssues(
      value.metadataDispositions.map((disposition) => disposition.metadataId),
      context,
      ["metadataDispositions"],
      "同一条元数据不能重复处置。",
    );
    addDuplicateIssues(
      value.zipEntryDispositions.map(
        (disposition) => `${disposition.sourceId}:${disposition.entryId}`,
      ),
      context,
      ["zipEntryDispositions"],
      "同一个压缩包条目不能重复处置。",
    );
    addDuplicateIssues(
      value.manualSourceDispositions.map((disposition) => disposition.sourceId),
      context,
      ["manualSourceDispositions"],
      "同一个人工源文件不能重复处置。",
    );
  });

export const historyGroupingConfirmationSchema = z
  .object({
    version: z.literal(2),
    confirmed: z.literal(true),
    sourceInventorySha256: historyContentDigestSchema,
    sourceLocationsSha256: historyContentDigestSchema,
    manualReviewSha256: historyContentDigestSchema,
    metadataFileSha256: historyContentDigestSchema,
    fragmentSetSha256: historyContentDigestSchema,
    groupingSha256: historyContentDigestSchema,
    completenessReportSha256: historyContentDigestSchema,
    batchSha256: historyContentDigestSchema,
  })
  .strict();

export type HistorySourceInventory = z.infer<typeof historySourceInventorySchema>;
export type HistorySourceFragment = z.infer<typeof historySourceFragmentSchema>;
export type HistoryGroupingDraft = z.infer<typeof historyGroupingDraftSchema>;
export type HistoryGroupingConfirmation = z.infer<typeof historyGroupingConfirmationSchema>;

type HistorySource = HistorySourceInventory["sources"][number];

export interface HistoryGroupingInput {
  readonly sourceInventory: unknown;
  readonly sourceLocationsSha256: string;
  readonly manualReviewSha256: string;
  readonly metadataFileSha256: string;
  readonly metadataNumbers: readonly string[];
  readonly grouping: unknown;
  readonly completenessReportSha256: string;
}

interface CheckedHistoryGrouping {
  readonly sourceInventory: HistorySourceInventory;
  readonly sourceLocationsSha256: string;
  readonly manualReviewSha256: string;
  readonly metadataFileSha256: string;
  readonly grouping: HistoryGroupingDraft;
  readonly completenessReportSha256: string;
}

/**
 * 文本范围使用从 0 开始、左闭右开的字符位置；PDF 页码从 1 开始且两端都包含。
 */
export function validateHistoryGrouping(input: HistoryGroupingInput): CheckedHistoryGrouping {
  const sourceInventory = parseWithoutPrivateDetails(
    historySourceInventorySchema,
    input.sourceInventory,
    "INVALID_GROUPING",
    "历史资料源清单格式不正确。",
  );
  const metadataFileSha256 = parseWithoutPrivateDetails(
    historyContentDigestSchema,
    input.metadataFileSha256,
    "INVALID_GROUPING",
    "私有元数据摘要格式不正确。",
  );
  const sourceLocationsSha256 = parseWithoutPrivateDetails(
    historyContentDigestSchema,
    input.sourceLocationsSha256,
    "INVALID_GROUPING",
    "私有源位置清单摘要格式不正确。",
  );
  const manualReviewSha256 = parseWithoutPrivateDetails(
    historyContentDigestSchema,
    input.manualReviewSha256,
    "INVALID_GROUPING",
    "人工处理清单摘要格式不正确。",
  );
  const completenessReportSha256 = parseWithoutPrivateDetails(
    historyContentDigestSchema,
    input.completenessReportSha256,
    "INVALID_GROUPING",
    "分组完整性报告摘要格式不正确。",
  );
  const grouping = parseWithoutPrivateDetails(
    historyGroupingDraftSchema,
    input.grouping,
    "INVALID_GROUPING",
    "历史资料分组格式不正确。",
  );
  const metadataNumbers = input.metadataNumbers.map((number) => number.trim());
  if (
    metadataNumbers.some((number) => number.length === 0 || number.length > 200) ||
    new Set(metadataNumbers).size !== metadataNumbers.length
  ) {
    throw new HistoryMigrationError(
      "INVALID_GROUPING",
      "私有元数据题号缺失或重复，必须先人工消除歧义。",
    );
  }
  const metadataIdSet = new Set(metadataNumbers.map((_, index) => makeMetadataId(index + 1)));
  if (grouping.groups.some((group) => !metadataIdSet.has(group.metadataId))) {
    throw new HistoryMigrationError("INVALID_GROUPING", "题目分组指向的元数据不存在。");
  }
  if (
    grouping.metadataDispositions.some((disposition) => !metadataIdSet.has(disposition.metadataId))
  ) {
    throw new HistoryMigrationError("INVALID_GROUPING", "人工处置指向的元数据不存在。");
  }

  const sourcesById = new Map(
    sourceInventory.sources.map((source) => [source.sourceId, source] as const),
  );
  const fragmentsById = new Map(
    grouping.fragments.map((fragment) => [fragment.fragmentId, fragment] as const),
  );
  for (const fragment of grouping.fragments) {
    const source = sourcesById.get(fragment.sourceId);
    if (source === undefined) {
      throw new HistoryMigrationError("INVALID_GROUPING", "片段指向的源文件安全编号不存在。");
    }
    validateFragmentBounds(fragment, source);
  }

  const groupsByFragment = new Map<string, string[]>();
  for (const group of grouping.groups) {
    for (const fragmentId of group.fragmentIds) {
      if (!fragmentsById.has(fragmentId)) {
        throw new HistoryMigrationError("INVALID_GROUPING", "题目分组指向的片段安全编号不存在。");
      }
      const assignedGroups = groupsByFragment.get(fragmentId) ?? [];
      assignedGroups.push(group.groupId);
      groupsByFragment.set(fragmentId, assignedGroups);
    }
  }
  if (grouping.fragments.some((fragment) => !groupsByFragment.has(fragment.fragmentId))) {
    throw new HistoryMigrationError(
      "INVALID_GROUPING",
      "每个已定义片段都必须放入至少一个题目分组。",
    );
  }

  validateConflictConfirmations(grouping, groupsByFragment);
  return {
    sourceInventory,
    sourceLocationsSha256,
    manualReviewSha256,
    metadataFileSha256,
    grouping,
    completenessReportSha256,
  };
}

export function createHistoryGroupingConfirmation(
  input: HistoryGroupingInput,
): HistoryGroupingConfirmation {
  const checked = validateHistoryGrouping(input);
  const digests = groupingDigests(checked);
  return historyGroupingConfirmationSchema.parse({
    version: 2,
    confirmed: true,
    ...digests,
  });
}

export function assertHistoryGroupingConfirmation(
  input: HistoryGroupingInput,
  confirmationInput: unknown,
): HistoryGroupingConfirmation {
  const confirmation = parseWithoutPrivateDetails(
    historyGroupingConfirmationSchema,
    confirmationInput,
    "INVALID_SOURCE_CONFIRMATION",
    "历史资料分组没有得到明确确认。",
  );
  const current = createHistoryGroupingConfirmation(input);
  if (
    confirmation.sourceInventorySha256 !== current.sourceInventorySha256 ||
    confirmation.sourceLocationsSha256 !== current.sourceLocationsSha256 ||
    confirmation.manualReviewSha256 !== current.manualReviewSha256 ||
    confirmation.metadataFileSha256 !== current.metadataFileSha256 ||
    confirmation.fragmentSetSha256 !== current.fragmentSetSha256 ||
    confirmation.groupingSha256 !== current.groupingSha256 ||
    confirmation.completenessReportSha256 !== current.completenessReportSha256 ||
    confirmation.batchSha256 !== current.batchSha256
  ) {
    throw new HistoryMigrationError(
      "GROUPING_CHANGED",
      "源清单、元数据、题目分组或片段内容已经变化，原来的确认已失效。",
    );
  }
  return confirmation;
}

function validateFragmentBounds(fragment: HistorySourceFragment, source: HistorySource): void {
  const selection = fragment.selection;
  switch (selection.kind) {
    case "whole_file": {
      if (source.kind !== "text") {
        throw new HistoryMigrationError(
          "FRAGMENT_OUT_OF_RANGE",
          "完整文件片段只允许指向已经登记为文本的源文件。",
        );
      }
      if (fragment.contentSha256 !== source.contentSha256) {
        throw new HistoryMigrationError(
          "GROUPING_CHANGED",
          "完整文件片段的内容摘要与源文件不一致。",
        );
      }
      return;
    }
    case "text_range": {
      if (source.kind !== "text" || selection.end > source.characterCount) {
        throw new HistoryMigrationError(
          "FRAGMENT_OUT_OF_RANGE",
          "文本片段的字符范围超出已确认的源文件范围。",
        );
      }
      return;
    }
    case "pdf_pages": {
      if (source.kind !== "pdf" || selection.lastPage > source.pageCount) {
        throw new HistoryMigrationError(
          "FRAGMENT_OUT_OF_RANGE",
          "PDF 片段的页码范围超出已确认的源文件范围。",
        );
      }
      return;
    }
    case "zip_entry": {
      if (source.kind !== "zip") {
        throw new HistoryMigrationError(
          "FRAGMENT_OUT_OF_RANGE",
          "压缩包片段指向的源文件类型不正确。",
        );
      }
      const entry = source.entries.find((candidate) => candidate.entryId === selection.entryId);
      if (entry === undefined || entry.contentSha256 !== fragment.contentSha256) {
        throw new HistoryMigrationError(
          "FRAGMENT_OUT_OF_RANGE",
          "压缩包片段的安全条目不存在或内容摘要已经变化。",
        );
      }
      return;
    }
  }
}

function validateConflictConfirmations(
  grouping: HistoryGroupingDraft,
  groupsByFragment: ReadonlyMap<string, readonly string[]>,
): void {
  const requiredShared = new Set<string>();
  for (const [fragmentId, groupIds] of groupsByFragment) {
    assertConfirmationCapacity(requiredShared.size, pairCount(groupIds.length));
    for (let first = 0; first < groupIds.length; first += 1) {
      for (let second = first + 1; second < groupIds.length; second += 1) {
        const firstGroupId = groupIds[first];
        const secondGroupId = groupIds[second];
        if (firstGroupId === undefined || secondGroupId === undefined) {
          continue;
        }
        requiredShared.add(sharedFragmentKey(fragmentId, firstGroupId, secondGroupId));
      }
    }
  }

  const requiredOverlaps = new Set<string>();
  const fragmentsBySource = new Map<string, HistorySourceFragment[]>();
  for (const fragment of grouping.fragments) {
    const fragments = fragmentsBySource.get(fragment.sourceId) ?? [];
    fragments.push(fragment);
    fragmentsBySource.set(fragment.sourceId, fragments);
  }
  for (const fragments of fragmentsBySource.values()) {
    const wholeFiles = fragments.filter((fragment) => fragment.selection.kind === "whole_file");
    const partialFragments = fragments.filter(
      (fragment) => fragment.selection.kind !== "whole_file",
    );
    addAllPairs(wholeFiles, requiredShared, requiredOverlaps);
    assertConfirmationCapacity(
      requiredShared.size + requiredOverlaps.size,
      wholeFiles.length * partialFragments.length,
    );
    for (const wholeFile of wholeFiles) {
      for (const partialFragment of partialFragments) {
        requiredOverlaps.add(
          overlappingFragmentsKey(wholeFile.fragmentId, partialFragment.fragmentId),
        );
      }
    }

    addRangeOverlaps(
      fragments.flatMap((fragment) =>
        fragment.selection.kind === "text_range"
          ? [
              {
                fragmentId: fragment.fragmentId,
                start: fragment.selection.start,
                end: fragment.selection.end,
              },
            ]
          : [],
      ),
      false,
      requiredShared,
      requiredOverlaps,
    );
    addRangeOverlaps(
      fragments.flatMap((fragment) =>
        fragment.selection.kind === "pdf_pages"
          ? [
              {
                fragmentId: fragment.fragmentId,
                start: fragment.selection.firstPage,
                end: fragment.selection.lastPage,
              },
            ]
          : [],
      ),
      true,
      requiredShared,
      requiredOverlaps,
    );

    const zipEntries = new Map<string, HistorySourceFragment[]>();
    for (const fragment of fragments) {
      if (fragment.selection.kind !== "zip_entry") {
        continue;
      }
      const entryFragments = zipEntries.get(fragment.selection.entryId) ?? [];
      entryFragments.push(fragment);
      zipEntries.set(fragment.selection.entryId, entryFragments);
    }
    for (const entryFragments of zipEntries.values()) {
      addAllPairs(entryFragments, requiredShared, requiredOverlaps);
    }
  }

  const providedShared = new Set<string>();
  const providedOverlaps = new Set<string>();
  for (const confirmation of grouping.sharingConfirmations) {
    const key =
      confirmation.kind === "shared_fragment"
        ? sharedFragmentKey(
            confirmation.fragmentId,
            confirmation.groupIds[0],
            confirmation.groupIds[1],
          )
        : overlappingFragmentsKey(confirmation.fragmentIds[0], confirmation.fragmentIds[1]);
    const target = confirmation.kind === "shared_fragment" ? providedShared : providedOverlaps;
    if (target.has(key)) {
      throw new HistoryMigrationError("INVALID_GROUPING", "同一项共用确认不能重复填写。");
    }
    target.add(key);
  }

  if (
    !setsEqual(requiredShared, providedShared) ||
    !setsEqual(requiredOverlaps, providedOverlaps)
  ) {
    throw new HistoryMigrationError(
      "DUPLICATE_ASSIGNMENT",
      "片段被重复分配或发生重叠；每一项共用都必须单独明确确认。",
    );
  }
}

interface ConflictRange {
  readonly fragmentId: string;
  readonly start: number;
  readonly end: number;
}

function addRangeOverlaps(
  ranges: readonly ConflictRange[],
  inclusiveEnd: boolean,
  requiredShared: ReadonlySet<string>,
  requiredOverlaps: Set<string>,
): void {
  const sorted = [...ranges].sort(
    (first, second) =>
      first.start - second.start ||
      first.end - second.end ||
      first.fragmentId.localeCompare(second.fragmentId),
  );
  const active = new Map<string, ConflictRange>();
  const byEnd: ConflictRange[] = [];
  for (const current of sorted) {
    while (
      byEnd[0] !== undefined &&
      (inclusiveEnd ? byEnd[0].end < current.start : byEnd[0].end <= current.start)
    ) {
      const expired = popMinimumEnd(byEnd);
      if (expired !== undefined) {
        active.delete(expired.fragmentId);
      }
    }
    assertConfirmationCapacity(requiredShared.size + requiredOverlaps.size, active.size);
    for (const activeFragmentId of active.keys()) {
      requiredOverlaps.add(overlappingFragmentsKey(activeFragmentId, current.fragmentId));
    }
    active.set(current.fragmentId, current);
    pushMinimumEnd(byEnd, current);
  }
}

function addAllPairs(
  fragments: readonly HistorySourceFragment[],
  requiredShared: ReadonlySet<string>,
  requiredOverlaps: Set<string>,
): void {
  assertConfirmationCapacity(
    requiredShared.size + requiredOverlaps.size,
    pairCount(fragments.length),
  );
  for (let first = 0; first < fragments.length; first += 1) {
    for (let second = first + 1; second < fragments.length; second += 1) {
      const firstFragment = fragments[first];
      const secondFragment = fragments[second];
      if (firstFragment !== undefined && secondFragment !== undefined) {
        requiredOverlaps.add(
          overlappingFragmentsKey(firstFragment.fragmentId, secondFragment.fragmentId),
        );
      }
    }
  }
}

function pairCount(itemCount: number): number {
  return (itemCount * (itemCount - 1)) / 2;
}

function assertConfirmationCapacity(existingCount: number, additionalCount: number): void {
  if (
    !Number.isSafeInteger(additionalCount) ||
    additionalCount < 0 ||
    existingCount + additionalCount > maximumConflictConfirmations
  ) {
    throw new HistoryMigrationError(
      "INVALID_GROUPING",
      "片段共用或重叠确认数量超过明确上限，必须缩小分组批次。",
    );
  }
}

function pushMinimumEnd(heap: ConflictRange[], value: ConflictRange): void {
  heap.push(value);
  let index = heap.length - 1;
  while (index > 0) {
    const parent = Math.floor((index - 1) / 2);
    const parentValue = heap[parent];
    if (parentValue === undefined || compareRangeEnd(parentValue, value) <= 0) {
      break;
    }
    heap[index] = parentValue;
    index = parent;
  }
  heap[index] = value;
}

function popMinimumEnd(heap: ConflictRange[]): ConflictRange | undefined {
  const minimum = heap[0];
  const last = heap.pop();
  if (minimum === undefined || last === undefined || heap.length === 0) {
    return minimum;
  }
  let index = 0;
  while (true) {
    const left = index * 2 + 1;
    const right = left + 1;
    if (left >= heap.length) {
      break;
    }
    const leftValue = heap[left];
    const rightValue = heap[right];
    if (leftValue === undefined) {
      break;
    }
    const child =
      rightValue !== undefined && compareRangeEnd(rightValue, leftValue) < 0 ? right : left;
    const childValue = heap[child];
    if (childValue === undefined || compareRangeEnd(last, childValue) <= 0) {
      break;
    }
    heap[index] = childValue;
    index = child;
  }
  heap[index] = last;
  return minimum;
}

function compareRangeEnd(first: ConflictRange, second: ConflictRange): number {
  return first.end - second.end || first.fragmentId.localeCompare(second.fragmentId);
}

function groupingDigests(
  checked: CheckedHistoryGrouping,
): Omit<HistoryGroupingConfirmation, "version" | "confirmed"> {
  const sourceInventorySha256 = sha256Hex(JSON.stringify(checked.sourceInventory));
  const fragmentSetSha256 = sha256Hex(
    JSON.stringify({
      version: 2,
      fragments: checked.grouping.fragments,
    }),
  );
  const groupingSha256 = sha256Hex(JSON.stringify(checked.grouping));
  const batchSha256 = sha256Hex(
    JSON.stringify({
      version: 2,
      sourceInventorySha256,
      sourceLocationsSha256: checked.sourceLocationsSha256,
      manualReviewSha256: checked.manualReviewSha256,
      metadataFileSha256: checked.metadataFileSha256,
      fragmentSetSha256,
      groupingSha256,
      completenessReportSha256: checked.completenessReportSha256,
    }),
  );
  return {
    sourceInventorySha256,
    sourceLocationsSha256: checked.sourceLocationsSha256,
    manualReviewSha256: checked.manualReviewSha256,
    metadataFileSha256: checked.metadataFileSha256,
    fragmentSetSha256,
    groupingSha256,
    completenessReportSha256: checked.completenessReportSha256,
    batchSha256,
  };
}

function makeMetadataId(sequence: number): string {
  if (!Number.isSafeInteger(sequence) || sequence <= 0 || sequence > 999_999) {
    throw new HistoryMigrationError("INVALID_GROUPING", "元数据数量超过工具支持的范围。");
  }
  return `metadata-${sequence.toString().padStart(6, "0")}`;
}

function sharedFragmentKey(
  fragmentId: string,
  firstGroupId: string,
  secondGroupId: string,
): string {
  const groupIds = [firstGroupId, secondGroupId].sort();
  return `${fragmentId}:${groupIds[0]}:${groupIds[1]}`;
}

function overlappingFragmentsKey(firstFragmentId: string, secondFragmentId: string): string {
  return [firstFragmentId, secondFragmentId].sort().join(":");
}

function setsEqual(first: ReadonlySet<string>, second: ReadonlySet<string>): boolean {
  return first.size === second.size && [...first].every((value) => second.has(value));
}

function parseWithoutPrivateDetails<T>(
  schema: z.ZodType<T>,
  input: unknown,
  code: "INVALID_GROUPING" | "INVALID_SOURCE_CONFIRMATION",
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
