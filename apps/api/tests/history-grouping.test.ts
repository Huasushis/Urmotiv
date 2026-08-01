import { describe, expect, it } from "vitest";
import {
  assertHistoryGroupingConfirmation,
  createHistoryGroupingConfirmation,
  type HistoryGroupingDraft,
  type HistoryGroupingInput,
  type HistorySourceInventory,
  historyGroupingDraftSchema,
  historySourceInventorySchema,
  sha256Hex,
  validateHistoryGrouping,
} from "../src/history-migration/index";

const encoder = new TextEncoder();
const firstText = "甲".repeat(80);
const secondText = "乙".repeat(60);
const firstZipEntry = encoder.encode("synthetic zip entry one");
const secondZipEntry = encoder.encode("synthetic zip entry two");

function digest(value: string | Uint8Array): string {
  return sha256Hex(typeof value === "string" ? encoder.encode(value) : value);
}

function sourceInventory(): HistorySourceInventory {
  const firstTextBytes = encoder.encode(firstText);
  const secondTextBytes = encoder.encode(secondText);
  const pdfBytes = encoder.encode("synthetic pdf bytes");
  const wholeFileBytes = encoder.encode("synthetic whole file bytes");
  const zipBytes = encoder.encode("synthetic zip container bytes");
  return historySourceInventorySchema.parse({
    version: 1,
    sources: [
      {
        sourceId: "source-000001",
        kind: "text",
        contentSha256: digest(firstTextBytes),
        byteLength: firstTextBytes.byteLength,
        characterCount: firstText.length,
      },
      {
        sourceId: "source-000002",
        kind: "text",
        contentSha256: digest(secondTextBytes),
        byteLength: secondTextBytes.byteLength,
        characterCount: secondText.length,
      },
      {
        sourceId: "source-000003",
        kind: "zip",
        contentSha256: digest(zipBytes),
        byteLength: zipBytes.byteLength,
        entries: [
          {
            entryId: "entry-000001",
            contentSha256: digest(firstZipEntry),
            byteLength: firstZipEntry.byteLength,
          },
          {
            entryId: "entry-000002",
            contentSha256: digest(secondZipEntry),
            byteLength: secondZipEntry.byteLength,
          },
        ],
      },
      {
        sourceId: "source-000004",
        kind: "pdf",
        contentSha256: digest(pdfBytes),
        byteLength: pdfBytes.byteLength,
        pageCount: 8,
      },
      {
        sourceId: "source-000005",
        kind: "file",
        contentSha256: digest(wholeFileBytes),
        byteLength: wholeFileBytes.byteLength,
      },
    ],
  });
}

function groupingDraft(): HistoryGroupingDraft {
  return historyGroupingDraftSchema.parse({
    version: 2,
    fragments: [
      {
        fragmentId: "fragment-000001",
        sourceId: "source-000001",
        selection: { kind: "text_range", start: 0, end: 20 },
        contentSha256: digest(firstText.slice(0, 20)),
      },
      {
        fragmentId: "fragment-000002",
        sourceId: "source-000001",
        selection: { kind: "text_range", start: 20, end: 40 },
        contentSha256: digest(firstText.slice(20, 40)),
      },
      {
        fragmentId: "fragment-000003",
        sourceId: "source-000002",
        selection: { kind: "text_range", start: 0, end: 15 },
        contentSha256: digest(secondText.slice(0, 15)),
      },
      {
        fragmentId: "fragment-000004",
        sourceId: "source-000003",
        selection: { kind: "zip_entry", entryId: "entry-000001" },
        contentSha256: digest(firstZipEntry),
      },
    ],
    groups: [
      {
        groupId: "group-000001",
        metadataId: "metadata-000001",
        fragmentIds: ["fragment-000001", "fragment-000003"],
      },
      {
        groupId: "group-000002",
        metadataId: "metadata-000002",
        fragmentIds: ["fragment-000002", "fragment-000004"],
      },
    ],
    sharingConfirmations: [],
    metadataDispositions: [],
    zipEntryDispositions: [],
    textRangeDispositions: [],
    manualSourceDispositions: [],
  });
}

function groupingInput(
  grouping: unknown = groupingDraft(),
  inventory: unknown = sourceInventory(),
): HistoryGroupingInput {
  return {
    sourceInventory: inventory,
    sourceLocationsSha256: digest("synthetic locations"),
    manualReviewSha256: digest("synthetic manual review"),
    metadataFileSha256: digest("synthetic metadata file"),
    metadataNumbers: ["metadata-1", "metadata-2", "metadata-3"],
    grouping,
    completenessReportSha256: digest("synthetic completeness report"),
  };
}

function expectFailureCode(work: () => unknown, code: string): unknown {
  let failure: unknown;
  try {
    work();
  } catch (error) {
    failure = error;
  }
  expect(failure).toMatchObject({ code });
  return failure;
}

describe("历史题目人工分组", () => {
  it("支持一份来源拆给多题，也支持一道题引用多份来源", () => {
    const input = groupingInput();
    const checked = validateHistoryGrouping(input);

    expect(checked.grouping.groups).toEqual([
      expect.objectContaining({
        metadataId: "metadata-000001",
        fragmentIds: ["fragment-000001", "fragment-000003"],
      }),
      expect.objectContaining({
        metadataId: "metadata-000002",
        fragmentIds: ["fragment-000002", "fragment-000004"],
      }),
    ]);

    const confirmation = createHistoryGroupingConfirmation(input);
    expect(confirmation).toEqual({
      version: 2,
      confirmed: true,
      sourceInventorySha256: expect.stringMatching(/^[0-9a-f]{64}$/),
      sourceLocationsSha256: input.sourceLocationsSha256,
      manualReviewSha256: input.manualReviewSha256,
      metadataFileSha256: input.metadataFileSha256,
      fragmentSetSha256: expect.stringMatching(/^[0-9a-f]{64}$/),
      groupingSha256: expect.stringMatching(/^[0-9a-f]{64}$/),
      completenessReportSha256: input.completenessReportSha256,
      batchSha256: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
    expect(assertHistoryGroupingConfirmation(input, confirmation)).toEqual(confirmation);
  });

  it("同一片段分给两组时必须逐对明确确认", () => {
    const grouping = groupingDraft();
    grouping.groups[1]?.fragmentIds.push("fragment-000003");
    expectFailureCode(
      () => validateHistoryGrouping(groupingInput(grouping)),
      "DUPLICATE_ASSIGNMENT",
    );

    grouping.sharingConfirmations.push({
      kind: "shared_fragment",
      fragmentId: "fragment-000003",
      groupIds: ["group-000001", "group-000002"],
      confirmed: true,
    });
    expect(() => validateHistoryGrouping(groupingInput(grouping))).not.toThrow();

    grouping.groups.push({
      groupId: "group-000004",
      metadataId: "metadata-000004",
      fragmentIds: ["fragment-000003"],
    });
    const withFourthMetadata = {
      ...groupingInput(grouping),
      metadataNumbers: ["metadata-1", "metadata-2", "metadata-3", "metadata-4"],
    };
    expectFailureCode(() => validateHistoryGrouping(withFourthMetadata), "DUPLICATE_ASSIGNMENT");
  });

  it("同一来源的重叠片段必须确认，相邻文本范围不算重叠", () => {
    const adjacent = groupingDraft();
    expect(() => validateHistoryGrouping(groupingInput(adjacent))).not.toThrow();

    const overlapping = groupingDraft();
    const secondFragment = overlapping.fragments[1];
    if (secondFragment?.selection.kind !== "text_range") {
      throw new Error("合成片段类型不正确。");
    }
    secondFragment.selection.start = 10;
    secondFragment.contentSha256 = digest(firstText.slice(10, 40));
    expectFailureCode(
      () => validateHistoryGrouping(groupingInput(overlapping)),
      "DUPLICATE_ASSIGNMENT",
    );

    overlapping.sharingConfirmations.push({
      kind: "overlapping_fragments",
      fragmentIds: ["fragment-000002", "fragment-000001"],
      confirmed: true,
    });
    expect(() => validateHistoryGrouping(groupingInput(overlapping))).not.toThrow();
  });

  it("完整文件与同源的任何其他片段都视为重叠", () => {
    const grouping = groupingDraft();
    grouping.fragments.push({
      fragmentId: "fragment-000007",
      sourceId: "source-000001",
      selection: { kind: "whole_file" },
      contentSha256: digest(firstText),
    });
    grouping.groups[0]?.fragmentIds.push("fragment-000007");

    expectFailureCode(
      () => validateHistoryGrouping(groupingInput(grouping)),
      "DUPLICATE_ASSIGNMENT",
    );
    grouping.sharingConfirmations.push(
      {
        kind: "overlapping_fragments",
        fragmentIds: ["fragment-000001", "fragment-000007"],
        confirmed: true,
      },
      {
        kind: "overlapping_fragments",
        fragmentIds: ["fragment-000002", "fragment-000007"],
        confirmed: true,
      },
    );
    expect(() => validateHistoryGrouping(groupingInput(grouping))).not.toThrow();
  });

  it("拒绝文本、PDF 范围越界或片段种类与来源不匹配", () => {
    const textOutOfRange = groupingDraft();
    const textFragment = textOutOfRange.fragments[0];
    if (textFragment?.selection.kind !== "text_range") {
      throw new Error("合成片段类型不正确。");
    }
    textFragment.selection.end = firstText.length + 1;
    expectFailureCode(
      () => validateHistoryGrouping(groupingInput(textOutOfRange)),
      "FRAGMENT_OUT_OF_RANGE",
    );

    const pdfOutOfRange = groupingDraft();
    pdfOutOfRange.fragments.push({
      fragmentId: "fragment-000005",
      sourceId: "source-000004",
      selection: { kind: "pdf_pages", firstPage: 2, lastPage: 9 },
      contentSha256: digest("synthetic extracted pdf pages"),
    });
    pdfOutOfRange.groups[0]?.fragmentIds.push("fragment-000005");
    expectFailureCode(
      () => validateHistoryGrouping(groupingInput(pdfOutOfRange)),
      "FRAGMENT_OUT_OF_RANGE",
    );

    const wrongKind = groupingDraft();
    const wrongKindFragment = wrongKind.fragments[0];
    if (wrongKindFragment === undefined) {
      throw new Error("合成片段不存在。");
    }
    wrongKindFragment.sourceId = "source-000004";
    expectFailureCode(
      () => validateHistoryGrouping(groupingInput(wrongKind)),
      "FRAGMENT_OUT_OF_RANGE",
    );
  });

  it("拒绝不存在或摘要不符的压缩包条目", () => {
    const missingEntry = groupingDraft();
    const missingEntryFragment = missingEntry.fragments[3];
    if (missingEntryFragment?.selection.kind !== "zip_entry") {
      throw new Error("合成片段类型不正确。");
    }
    missingEntryFragment.selection.entryId = "entry-999999";
    expectFailureCode(
      () => validateHistoryGrouping(groupingInput(missingEntry)),
      "FRAGMENT_OUT_OF_RANGE",
    );

    const changedEntry = groupingDraft();
    const changedEntryFragment = changedEntry.fragments[3];
    if (changedEntryFragment === undefined) {
      throw new Error("合成片段不存在。");
    }
    changedEntryFragment.contentSha256 = digest("changed entry bytes");
    expectFailureCode(
      () => validateHistoryGrouping(groupingInput(changedEntry)),
      "FRAGMENT_OUT_OF_RANGE",
    );
  });

  it("完整文件片段必须使用源文件的完整内容摘要", () => {
    const grouping = groupingDraft();
    grouping.fragments.push({
      fragmentId: "fragment-000005",
      sourceId: "source-000002",
      selection: { kind: "whole_file" },
      contentSha256: digest("changed whole file bytes"),
    });
    grouping.groups[0]?.fragmentIds.push("fragment-000005");
    expectFailureCode(() => validateHistoryGrouping(groupingInput(grouping)), "GROUPING_CHANGED");
  });

  it("人工或不透明文件不能用 whole_file 绕过文本转换", () => {
    const grouping = groupingDraft();
    grouping.fragments.push({
      fragmentId: "fragment-000005",
      sourceId: "source-000005",
      selection: { kind: "whole_file" },
      contentSha256: digest("synthetic whole file bytes"),
    });
    grouping.groups[0]?.fragmentIds.push("fragment-000005");
    expectFailureCode(
      () => validateHistoryGrouping(groupingInput(grouping)),
      "FRAGMENT_OUT_OF_RANGE",
    );
  });

  it("拒绝不存在的来源、片段、元数据以及没有归组的片段", () => {
    const unknownSource = groupingDraft();
    const firstFragment = unknownSource.fragments[0];
    if (firstFragment === undefined) {
      throw new Error("合成片段不存在。");
    }
    firstFragment.sourceId = "source-999999";
    expectFailureCode(
      () => validateHistoryGrouping(groupingInput(unknownSource)),
      "INVALID_GROUPING",
    );

    const unknownFragment = groupingDraft();
    unknownFragment.groups[0]?.fragmentIds.push("fragment-999999");
    expectFailureCode(
      () => validateHistoryGrouping(groupingInput(unknownFragment)),
      "INVALID_GROUPING",
    );

    const unknownMetadata = groupingDraft();
    if (unknownMetadata.groups[0] !== undefined) {
      unknownMetadata.groups[0].metadataId = "metadata-999999";
    }
    expectFailureCode(
      () => validateHistoryGrouping(groupingInput(unknownMetadata)),
      "INVALID_GROUPING",
    );

    const unassigned = groupingDraft();
    unassigned.groups[0]?.fragmentIds.splice(1, 1);
    expectFailureCode(() => validateHistoryGrouping(groupingInput(unassigned)), "INVALID_GROUPING");
  });

  it("拒绝重复的安全编号、元数据、组内片段和共用确认", () => {
    const duplicateSource = sourceInventory();
    const firstSource = duplicateSource.sources[0];
    if (firstSource === undefined) {
      throw new Error("合成源清单为空。");
    }
    duplicateSource.sources.push(structuredClone(firstSource));
    expectFailureCode(
      () => validateHistoryGrouping(groupingInput(groupingDraft(), duplicateSource)),
      "INVALID_GROUPING",
    );

    const duplicateGroup = groupingDraft();
    const secondGroup = duplicateGroup.groups[1];
    if (secondGroup === undefined) {
      throw new Error("合成分组缺少第二组。");
    }
    secondGroup.groupId = "group-000001";
    expectFailureCode(
      () => validateHistoryGrouping(groupingInput(duplicateGroup)),
      "INVALID_GROUPING",
    );

    const duplicateMetadata = groupingDraft();
    const secondMetadataGroup = duplicateMetadata.groups[1];
    if (secondMetadataGroup === undefined) {
      throw new Error("合成分组缺少第二组。");
    }
    secondMetadataGroup.metadataId = "metadata-000001";
    expectFailureCode(
      () => validateHistoryGrouping(groupingInput(duplicateMetadata)),
      "INVALID_GROUPING",
    );

    const duplicateFragment = groupingDraft();
    duplicateFragment.groups[0]?.fragmentIds.push("fragment-000001");
    expectFailureCode(
      () => validateHistoryGrouping(groupingInput(duplicateFragment)),
      "INVALID_GROUPING",
    );

    const duplicateConfirmation = groupingDraft();
    duplicateConfirmation.groups[1]?.fragmentIds.push("fragment-000003");
    const confirmation = {
      kind: "shared_fragment" as const,
      fragmentId: "fragment-000003",
      groupIds: ["group-000001", "group-000002"] as [string, string],
      confirmed: true as const,
    };
    duplicateConfirmation.sharingConfirmations.push(confirmation, confirmation);
    expectFailureCode(
      () => validateHistoryGrouping(groupingInput(duplicateConfirmation)),
      "INVALID_GROUPING",
    );
  });

  it("拒绝多余或指向错误对象的共用确认", () => {
    const grouping = groupingDraft();
    grouping.sharingConfirmations.push({
      kind: "overlapping_fragments",
      fragmentIds: ["fragment-000001", "fragment-000002"],
      confirmed: true,
    });
    expectFailureCode(
      () => validateHistoryGrouping(groupingInput(grouping)),
      "DUPLICATE_ASSIGNMENT",
    );
  });

  it("共用或重叠确认超过十万项时在展开前停止", () => {
    const itemCount = 449;
    const metadataNumbers = Array.from(
      { length: itemCount },
      (_, index) => `metadata-${index + 1}`,
    );

    const shared = groupingDraft();
    shared.groups = Array.from({ length: itemCount }, (_, index) => ({
      groupId: `group-${(index + 1).toString().padStart(6, "0")}`,
      metadataId: `metadata-${(index + 1).toString().padStart(6, "0")}`,
      fragmentIds:
        index === 0 ? shared.fragments.map((fragment) => fragment.fragmentId) : ["fragment-000001"],
    }));
    expectFailureCode(
      () =>
        validateHistoryGrouping({
          ...groupingInput(shared),
          metadataNumbers,
        }),
      "INVALID_GROUPING",
    );

    const overlapping = groupingDraft();
    overlapping.fragments = Array.from({ length: itemCount }, (_, index) => ({
      fragmentId: `fragment-${(index + 1).toString().padStart(6, "0")}`,
      sourceId: "source-000001",
      selection: { kind: "text_range" as const, start: 0, end: 1 },
      contentSha256: digest(firstText.slice(0, 1)),
    }));
    overlapping.groups = overlapping.fragments.map((fragment, index) => ({
      groupId: `group-${(index + 1).toString().padStart(6, "0")}`,
      metadataId: `metadata-${(index + 1).toString().padStart(6, "0")}`,
      fragmentIds: [fragment.fragmentId],
    }));
    expectFailureCode(
      () =>
        validateHistoryGrouping({
          ...groupingInput(overlapping),
          metadataNumbers,
        }),
      "INVALID_GROUPING",
    );
  });

  it("源清单、元数据、片段或分组变化都会让旧确认失效", () => {
    const input = groupingInput();
    const confirmation = createHistoryGroupingConfirmation(input);

    const changedInventory = sourceInventory();
    const changedSource = changedInventory.sources[0];
    if (changedSource === undefined) {
      throw new Error("合成源清单为空。");
    }
    changedSource.byteLength += 1;
    expectFailureCode(
      () =>
        assertHistoryGroupingConfirmation(
          groupingInput(groupingDraft(), changedInventory),
          confirmation,
        ),
      "GROUPING_CHANGED",
    );

    expectFailureCode(
      () =>
        assertHistoryGroupingConfirmation(
          { ...input, metadataFileSha256: digest("changed metadata") },
          confirmation,
        ),
      "GROUPING_CHANGED",
    );

    for (const changedInput of [
      { ...input, sourceLocationsSha256: digest("changed locations") },
      { ...input, manualReviewSha256: digest("changed manual review") },
      { ...input, completenessReportSha256: digest("changed completeness report") },
    ]) {
      expectFailureCode(
        () => assertHistoryGroupingConfirmation(changedInput, confirmation),
        "GROUPING_CHANGED",
      );
    }

    const changedFragment = groupingDraft();
    const firstChangedFragment = changedFragment.fragments[0];
    if (firstChangedFragment === undefined) {
      throw new Error("合成分组没有片段。");
    }
    firstChangedFragment.contentSha256 = digest("changed fragment");
    expectFailureCode(
      () => assertHistoryGroupingConfirmation(groupingInput(changedFragment), confirmation),
      "GROUPING_CHANGED",
    );

    const changedGrouping = groupingDraft();
    changedGrouping.groups.reverse();
    expectFailureCode(
      () => assertHistoryGroupingConfirmation(groupingInput(changedGrouping), confirmation),
      "GROUPING_CHANGED",
    );
  });

  it("格式错误只返回固定错误，不带来源路径或私有字段", () => {
    const privateMarker = "SYNTHETIC-PRIVATE-PATH-MARKER";
    const malformed = {
      ...groupingDraft(),
      fragments: [
        {
          ...groupingDraft().fragments[0],
          sourcePath: privateMarker,
        },
      ],
    };
    const failure = expectFailureCode(
      () => validateHistoryGrouping(groupingInput(malformed)),
      "INVALID_GROUPING",
    );
    expect(String(failure)).not.toContain(privateMarker);

    const invalidConfirmation = {
      ...createHistoryGroupingConfirmation(groupingInput()),
      confirmed: false,
      privatePath: privateMarker,
    };
    const confirmationFailure = expectFailureCode(
      () => assertHistoryGroupingConfirmation(groupingInput(), invalidConfirmation),
      "INVALID_SOURCE_CONFIRMATION",
    );
    expect(String(confirmationFailure)).not.toContain(privateMarker);
  });
});
