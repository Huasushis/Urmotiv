import { createHash } from "node:crypto";
import { chmod, lstat, mkdir, mkdtemp, open, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { crc32, deflateRawSync } from "node:zlib";
import { readZipArchive, writeZipArchive } from "@urmotiv/problem-package";
import { afterEach, describe, expect, it } from "vitest";
import {
  assertSafeHistoryZipTreeForTest,
  historyCatalogBatchSafetyForTest,
} from "../src/history-migration/grouping-workflow";
import {
  assertHistoryMaterializationComplete,
  type HistoryGroupingPlan,
  type HistorySourceInventory,
  type HistorySourceLocations,
  initializeHistoryGroupingWorksheet,
  inventoryHistorySources,
  materializeHistoryGrouping,
  sealHistoryGrouping,
  writeHistoryGroupingConfirmation,
} from "../src/history-migration/index";

const temporaryDirectories: string[] = [];
const combinedSourceName = "synthetic-combined.txt";
const extraSourceName = "synthetic-extra.md";
const archiveSourceName = "synthetic-bundle.zip";
const manualSourceName = "synthetic-manual.bin";
const archiveEntryName = "private/synthetic-beta-solution.md";
const alphaText = "SYNTHETIC ALPHA PROBLEM";
const betaText = "SYNTHETIC BETA PROBLEM";
const alphaSolution = "SYNTHETIC ALPHA SOLUTION";
const betaSolution = "SYNTHETIC BETA SOLUTION";

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("历史题目人工分组文件工作流", () => {
  it("把一文件多题和一题多文件安全物化为旧迁移流程的一题一文件输入", async () => {
    const fixture = await createCatalogFixture();
    const sealed = await sealFixture(fixture);
    expect(sealed.result).toEqual({
      sourceCount: 4,
      fragmentCount: 4,
      groupCount: 2,
      unresolvedItemCount: 0,
    });

    await writeHistoryGroupingConfirmation({
      privateRootDirectory: fixture.privateRoot,
      sourceInventoryFile: fixture.inventoryFile,
      sourceLocationsFile: fixture.locationsFile,
      metadataFile: fixture.metadataFile,
      groupingDirectory: sealed.groupingDirectory,
      outputFile: fixture.confirmationFile,
      confirmed: true,
    });
    const result = await materializeHistoryGrouping({
      privateRootDirectory: fixture.privateRoot,
      sourceDirectory: fixture.sourceDirectory,
      sourceInventoryFile: fixture.inventoryFile,
      sourceLocationsFile: fixture.locationsFile,
      metadataFile: fixture.metadataFile,
      groupingDirectory: sealed.groupingDirectory,
      groupingConfirmationFile: fixture.confirmationFile,
      outputDirectory: fixture.materializedDirectory,
    });

    expect(result).toEqual({
      sourceCount: 2,
      fragmentCount: 4,
      unresolvedItemCount: 0,
    });
    const first = await readFile(
      join(fixture.materializedDirectory, "sources", "source-000001.md"),
      "utf8",
    );
    const second = await readFile(
      join(fixture.materializedDirectory, "sources", "source-000002.md"),
      "utf8",
    );
    expect(first).toContain(alphaText);
    expect(first).toContain(alphaSolution);
    expect(first).not.toContain(betaText);
    expect(second).toContain(betaText);
    expect(second).toContain(betaSolution);
    expect(second).not.toContain(alphaText);
    expect(first).toContain("fragment-000002");
    expect(second).toContain("fragment-000004");

    const sourceConfirmation = JSON.parse(
      await readFile(
        join(fixture.materializedDirectory, "source-confirmation.private.json"),
        "utf8",
      ),
    ) as {
      mappings: Array<{
        sourcePath: string;
        sourceSha256: string;
        metadataNumber: string;
      }>;
    };
    expect(sourceConfirmation.mappings).toHaveLength(2);
    expect(sourceConfirmation.mappings.map((mapping) => mapping.sourcePath)).toEqual([
      "source-000001.md",
      "source-000002.md",
    ]);
    expect(sourceConfirmation.mappings.map((mapping) => mapping.metadataNumber)).toEqual([
      "metadata-1",
      "metadata-2",
    ]);

    const report = await readFile(join(fixture.materializedDirectory, "report.json"), "utf8");
    for (const privateMarker of [
      combinedSourceName,
      extraSourceName,
      archiveSourceName,
      archiveEntryName,
      manualSourceName,
      alphaText,
      betaText,
      alphaSolution,
      betaSolution,
      "metadata-1",
      "Synthetic metadata title",
    ]) {
      expect(report).not.toContain(privateMarker);
    }

    await expectPrivateMode(join(fixture.materializedDirectory, "sources"), 0o700);
    await expectPrivateMode(
      join(fixture.materializedDirectory, "sources", "source-000001.md"),
      0o600,
    );
  });

  it("安全清单不写原路径或正文，原路径只留在单独私有位置文件", async () => {
    const fixture = await createCatalogFixture();
    const inventoryText = await readFile(fixture.inventoryFile, "utf8");
    const locationsText = await readFile(fixture.locationsFile, "utf8");

    for (const privateMarker of [
      combinedSourceName,
      extraSourceName,
      archiveSourceName,
      archiveEntryName,
      manualSourceName,
      alphaText,
      betaText,
    ]) {
      expect(inventoryText).not.toContain(privateMarker);
    }
    expect(inventoryText).toContain("source-000001");
    expect(inventoryText).toMatch(/[0-9a-f]{64}/);
    expect(locationsText).toContain(combinedSourceName);
    expect(locationsText).toContain(archiveEntryName);
    await expectPrivateMode(fixture.catalogDirectory, 0o700);
    await expectPrivateMode(fixture.locationsFile, 0o600);
  });

  it("只有明确的 .zip 才按题目压缩包登记，XLSX 等 ZIP 容器保持不透明", async () => {
    const privateRoot = await createPrivateRoot();
    const sourceDirectory = join(privateRoot, "container-sources");
    await mkdir(sourceDirectory, { mode: 0o700 });
    const spreadsheetName = "synthetic-list.xlsx";
    const internalSpreadsheetPath = "xl/worksheets/sheet1.xml";
    await writeFile(
      join(sourceDirectory, spreadsheetName),
      writeZipArchive([
        {
          path: internalSpreadsheetPath,
          content: new TextEncoder().encode("<synthetic-sheet />"),
        },
      ]),
    );
    const catalogDirectory = join(privateRoot, "container-catalog");

    await expect(
      inventoryHistorySources({
        privateRootDirectory: privateRoot,
        sourceDirectory,
        outputDirectory: catalogDirectory,
      }),
    ).resolves.toMatchObject({
      sourceCount: 1,
      archiveSourceCount: 0,
      archiveEntryCount: 0,
      manualSourceCount: 1,
    });
    const inventoryText = await readFile(join(catalogDirectory, "inventory.json"), "utf8");
    expect(inventoryText).not.toContain(spreadsheetName);
    expect(inventoryText).not.toContain(internalSpreadsheetPath);
    const manualReview = JSON.parse(
      await readFile(join(catalogDirectory, "manual-review.json"), "utf8"),
    ) as { sources: Array<{ reasons: string[] }> };
    expect(manualReview.sources).toEqual([
      { sourceId: "source-000001", reasons: ["manual_binary"] },
    ]);
  });

  it("批次边界单包可完整写出 inventory 与 source-locations，最坏 JSON 证明低于读取上限", async () => {
    expect(historyCatalogBatchSafetyForTest.maximumItems).toBe(5_000);
    expect(historyCatalogBatchSafetyForTest.maximumInventoryCatalogBytes).toBeLessThanOrEqual(
      historyCatalogBatchSafetyForTest.maximumPrivateJsonBytes,
    );
    expect(historyCatalogBatchSafetyForTest.maximumLocationCatalogBytes).toBeLessThanOrEqual(
      historyCatalogBatchSafetyForTest.maximumPrivateJsonBytes,
    );
    const maximumPath = `${"\u0800".repeat(120)}/${"\u0800".repeat(119)}`;
    const maximumEntryCount = historyCatalogBatchSafetyForTest.maximumItems - 1;
    const maximumLocationValue = {
      version: 2,
      sources: [
        {
          sourceId: "source-999999",
          sourcePath: maximumPath,
          entries: Array.from({ length: maximumEntryCount }, () => ({
            entryId: "entry-999999",
            entryPathChain: [maximumPath, maximumPath],
          })),
        },
      ],
    };
    const maximumInventoryValue = {
      version: 1,
      sources: [
        {
          sourceId: "source-999999",
          kind: "zip",
          contentSha256: "f".repeat(64),
          byteLength: 128 * 1024 * 1024,
          entries: Array.from({ length: maximumEntryCount }, () => ({
            entryId: "entry-999999",
            contentSha256: "f".repeat(64),
            byteLength: 128 * 1024 * 1024,
          })),
        },
      ],
    };
    const maximumTextInventoryValue = {
      version: 1,
      sources: Array.from({ length: historyCatalogBatchSafetyForTest.maximumItems }, () => ({
        sourceId: "source-999999",
        kind: "text",
        contentSha256: "f".repeat(64),
        byteLength: 128 * 1024 * 1024,
        characterCount: 500_000,
      })),
    };
    expect(privateJsonByteLength(maximumLocationValue)).toBeLessThanOrEqual(
      historyCatalogBatchSafetyForTest.maximumLocationCatalogBytes,
    );
    expect(privateJsonByteLength(maximumInventoryValue)).toBeLessThanOrEqual(
      historyCatalogBatchSafetyForTest.maximumInventoryCatalogBytes,
    );
    expect(privateJsonByteLength(maximumTextInventoryValue)).toBeLessThanOrEqual(
      historyCatalogBatchSafetyForTest.maximumInventoryCatalogBytes,
    );

    const privateRoot = await createPrivateRoot();
    const sourceDirectory = join(privateRoot, "batch-boundary-sources");
    await mkdir(sourceDirectory, { mode: 0o700 });
    const declaredEntries = maximumEntryCount;
    await writeFile(
      join(sourceDirectory, "boundary.zip"),
      writeZipArchive(syntheticArchiveEntries(declaredEntries, "boundary")),
    );
    const catalogDirectory = join(privateRoot, "batch-boundary-catalog");

    await expect(
      inventoryHistorySources({
        privateRootDirectory: privateRoot,
        sourceDirectory,
        outputDirectory: catalogDirectory,
      }),
    ).resolves.toMatchObject({
      sourceCount: 1,
      archiveSourceCount: 1,
      archiveEntryCount: declaredEntries,
    });

    for (const name of ["inventory.json", "source-locations.private.json"]) {
      const content = await readFile(join(catalogDirectory, name));
      expect(content.byteLength).toBeLessThanOrEqual(
        historyCatalogBatchSafetyForTest.maximumPrivateJsonBytes,
      );
      expect(() => JSON.parse(content.toString("utf8"))).not.toThrow();
    }
  }, 30_000);

  it("多包声明记录按整批立即计数，合计越界时不建立输出目录", async () => {
    const privateRoot = await createPrivateRoot();
    const sourceDirectory = join(privateRoot, "batch-overflow-sources");
    await mkdir(sourceDirectory, { mode: 0o700 });
    const perArchive = historyCatalogBatchSafetyForTest.maximumItems / 2;
    await writeFile(
      join(sourceDirectory, "a.zip"),
      corruptFirstZipCrc(writeZipArchive(syntheticArchiveEntries(perArchive, "first"))),
    );
    await writeFile(
      join(sourceDirectory, "b.zip"),
      writeZipArchive(syntheticArchiveEntries(perArchive, "second")),
    );
    const catalogDirectory = join(privateRoot, "batch-overflow-catalog");

    await expect(
      inventoryHistorySources({
        privateRootDirectory: privateRoot,
        sourceDirectory,
        outputDirectory: catalogDirectory,
      }),
    ).rejects.toMatchObject({ code: "SOURCE_TOO_LARGE" });
    await expect(lstat(catalogDirectory)).rejects.toMatchObject({ code: "ENOENT" });
  }, 30_000);

  it("结构校验失败的多包仍按 EOCD 声明记录占用整批预算", async () => {
    const corruptions = [
      (archive: Uint8Array) => patchFirstLocalU16(archive, 6, (value) => value ^ 0x0008),
      (archive: Uint8Array) => patchFirstLocalU32(archive, 22, (value) => (value + 1) >>> 0),
    ];
    const perArchive = historyCatalogBatchSafetyForTest.maximumItems / 2;

    for (const [caseIndex, corrupt] of corruptions.entries()) {
      const privateRoot = await createPrivateRoot();
      const sourceDirectory = join(privateRoot, `structural-overflow-${caseIndex}`);
      await mkdir(sourceDirectory, { mode: 0o700 });
      for (const [archiveIndex, prefix] of ["first", "second"].entries()) {
        const archive = writeZipArchive(syntheticArchiveEntries(perArchive, prefix));
        await writeFile(join(sourceDirectory, `${archiveIndex}.zip`), corrupt(archive));
      }
      const catalogDirectory = join(privateRoot, `structural-overflow-catalog-${caseIndex}`);

      await expect(
        inventoryHistorySources({
          privateRootDirectory: privateRoot,
          sourceDirectory,
          outputDirectory: catalogDirectory,
        }),
      ).rejects.toMatchObject({ code: "SOURCE_TOO_LARGE" });
      await expect(lstat(catalogDirectory)).rejects.toMatchObject({ code: "ENOENT" });
    }
  }, 60_000);

  it("受限展开一层内嵌单题 ZIP，路径链只写私有位置清单且不按数字名自动分组", async () => {
    const privateRoot = await createPrivateRoot();
    const sourceDirectory = join(privateRoot, "nested-sources");
    await mkdir(sourceDirectory, { mode: 0o700 });
    const nestedText = "SYNTHETIC NESTED PROBLEM TEXT";
    const innerName = "101.zip";
    const leafName = "101.md";
    const spreadsheetAttachmentName = "attachment.xlsx";
    const inner = writeZipArchive([
      { path: leafName, content: new TextEncoder().encode(nestedText) },
    ]);
    const spreadsheetAttachment = writeZipArchive([
      {
        path: "xl/worksheets/sheet1.xml",
        content: new TextEncoder().encode("<synthetic-attachment />"),
      },
    ]);
    const outerName = "101~106.zip";
    await writeFile(
      join(sourceDirectory, outerName),
      writeZipArchive(
        [
          { path: innerName, content: inner },
          { path: spreadsheetAttachmentName, content: spreadsheetAttachment },
        ],
        { allowNestedArchives: true },
      ),
    );
    const catalogDirectory = join(privateRoot, "nested-catalog");
    const inventoryResult = await inventoryHistorySources({
      privateRootDirectory: privateRoot,
      sourceDirectory,
      outputDirectory: catalogDirectory,
    });
    expect(inventoryResult).toMatchObject({
      sourceCount: 1,
      archiveSourceCount: 1,
      archiveEntryCount: 2,
      manualSourceCount: 0,
    });

    const inventoryFile = join(catalogDirectory, "inventory.json");
    const locationsFile = join(catalogDirectory, "source-locations.private.json");
    const inventoryText = await readFile(inventoryFile, "utf8");
    expect(inventoryText).not.toContain(outerName);
    expect(inventoryText).not.toContain(innerName);
    expect(inventoryText).not.toContain(leafName);
    expect(inventoryText).not.toContain(spreadsheetAttachmentName);
    const locations = await readLocations(locationsFile);
    expect(locations.version).toBe(2);
    expect(locations.sources[0]?.entries).toEqual([
      {
        entryId: "entry-000001",
        entryPathChain: [innerName, leafName],
      },
      {
        entryId: "entry-000002",
        entryPathChain: [spreadsheetAttachmentName],
      },
    ]);

    const metadataFile = join(privateRoot, "nested-metadata.private.json");
    await writeFile(
      metadataFile,
      `${JSON.stringify({
        records: [{ number: "synthetic-101", name: "Synthetic nested metadata" }],
      })}\n`,
      "utf8",
    );
    const worksheetDirectory = join(privateRoot, "nested-worksheet");
    await initializeHistoryGroupingWorksheet({
      privateRootDirectory: privateRoot,
      sourceInventoryFile: inventoryFile,
      sourceLocationsFile: locationsFile,
      metadataFile,
      outputDirectory: worksheetDirectory,
    });
    const skeleton = JSON.parse(
      await readFile(join(worksheetDirectory, "grouping-plan.skeleton.private.json"), "utf8"),
    ) as { groups: unknown[]; fragments: unknown[] };
    expect(skeleton.groups).toEqual([]);
    expect(skeleton.fragments).toEqual([]);

    const planFile = join(privateRoot, "nested-plan.private.json");
    await writeFile(
      planFile,
      `${JSON.stringify({
        version: 2,
        fragments: [
          {
            fragmentId: "fragment-000001",
            sourceId: "source-000001",
            selection: { kind: "zip_entry", entryId: "entry-000001" },
          },
        ],
        groups: [
          {
            groupId: "group-000001",
            metadataId: "metadata-000001",
            fragmentIds: ["fragment-000001"],
          },
        ],
        sharingConfirmations: [],
        metadataDispositions: [],
        zipEntryDispositions: [
          {
            sourceId: "source-000001",
            entryId: "entry-000002",
            action: "attachment",
            reason: "synthetic spreadsheet attachment",
            confirmed: true,
          },
        ],
        textRangeDispositions: [],
        manualSourceDispositions: [],
      })}\n`,
      "utf8",
    );
    const groupingDirectory = join(privateRoot, "nested-grouping");
    await sealHistoryGrouping({
      privateRootDirectory: privateRoot,
      sourceDirectory,
      sourceInventoryFile: inventoryFile,
      sourceLocationsFile: locationsFile,
      metadataFile,
      groupingPlanFile: planFile,
      outputDirectory: groupingDirectory,
    });
    const confirmationFile = join(privateRoot, "nested-confirmation.private.json");
    await writeHistoryGroupingConfirmation({
      privateRootDirectory: privateRoot,
      sourceInventoryFile: inventoryFile,
      sourceLocationsFile: locationsFile,
      metadataFile,
      groupingDirectory,
      outputFile: confirmationFile,
      confirmed: true,
    });
    const materializedDirectory = join(privateRoot, "nested-materialized");
    await materializeHistoryGrouping({
      privateRootDirectory: privateRoot,
      sourceDirectory,
      sourceInventoryFile: inventoryFile,
      sourceLocationsFile: locationsFile,
      metadataFile,
      groupingDirectory,
      groupingConfirmationFile: confirmationFile,
      outputDirectory: materializedDirectory,
    });
    expect(await readFile(join(materializedDirectory, "sources", "source-000001.md"), "utf8")).toBe(
      nestedText,
    );
  });

  it("内层 ZIP 仍执行路径、链接、重复、大小比例和深度检查", async () => {
    const privateRoot = await createPrivateRoot();
    const sourceDirectory = join(privateRoot, "unsafe-nested-sources");
    await mkdir(sourceDirectory, { mode: 0o700 });
    const encoder = new TextEncoder();
    const safeInner = writeZipArchive([{ path: "safe.txt", content: encoder.encode("safe") }]);
    const traversalInner = rewriteFirstZipPath(safeInner, "../x.txt");
    const symlinkInner = markFirstZipEntryAsSymlink(safeInner);
    const duplicateInner = rewriteZipPath(
      writeZipArchive([
        { path: "one.txt", content: encoder.encode("one") },
        { path: "two.txt", content: encoder.encode("two") },
      ]),
      1,
      "one.txt",
    );
    const oversizedInner = rewriteFirstZipUncompressedSize(safeInner, 128 * 1024 * 1024 + 1);
    const secondLevel = writeZipArchive([{ path: "level-two.zip", content: safeInner }], {
      allowNestedArchives: true,
    });
    const tooDeepInner = writeZipArchive([{ path: "level-one.zip", content: secondLevel }], {
      allowNestedArchives: true,
    });
    const cases = [
      ["a-traversal.zip", traversalInner],
      ["b-symlink.zip", symlinkInner],
      ["c-duplicate.zip", duplicateInner],
      ["d-oversized.zip", oversizedInner],
      ["e-too-deep.zip", tooDeepInner],
      ["f-fake-inner.zip", encoder.encode("synthetic not a zip")],
    ] as const;
    for (const [name, inner] of cases) {
      await writeFile(
        join(sourceDirectory, name),
        writeZipArchive([{ path: "inner.zip", content: inner }], {
          allowNestedArchives: true,
        }),
      );
    }
    const emptyInnerSourceName = "g-empty-inner.zip";
    await writeFile(
      join(sourceDirectory, emptyInnerSourceName),
      writeZipArchive(
        [
          { path: "empty.zip", content: writeZipArchive([]) },
          { path: "kept.md", content: encoder.encode("must not survive partial inventory") },
        ],
        { allowNestedArchives: true },
      ),
    );

    const catalogDirectory = join(privateRoot, "unsafe-nested-catalog");
    await expect(
      inventoryHistorySources({
        privateRootDirectory: privateRoot,
        sourceDirectory,
        outputDirectory: catalogDirectory,
      }),
    ).resolves.toMatchObject({
      sourceCount: cases.length + 1,
      archiveSourceCount: 0,
      manualSourceCount: cases.length + 1,
    });
    const manualReviewText = await readFile(join(catalogDirectory, "manual-review.json"), "utf8");
    const manualReview = JSON.parse(manualReviewText) as {
      sources: Array<{ reasons: string[] }>;
    };
    const reasons = new Set(manualReview.sources.flatMap((source) => source.reasons));
    expect(reasons).toEqual(
      new Set([
        "archive_too_large",
        "compression_ratio_too_high",
        "duplicate_path",
        "empty_file",
        "file_too_large",
        "invalid_path",
        "nested_archive",
        "not_a_zip_archive",
        "unsupported_entry_type",
      ]),
    );
    for (const [name] of cases) {
      expect(manualReviewText).not.toContain(name);
    }
    expect(manualReviewText).not.toContain(emptyInnerSourceName);
  });

  it("以小上限实际触发跨层条目、展开量和根包压缩比限制", () => {
    const encoder = new TextEncoder();
    const firstLeaf = encoder.encode("first synthetic leaf has enough bytes");
    const secondLeaf = encoder.encode("second synthetic leaf has enough bytes");
    const firstInner = writeZipArchive([{ path: "first.md", content: firstLeaf }]);
    const secondInner = writeZipArchive([{ path: "second.md", content: secondLeaf }]);
    const outer = writeZipArchive(
      [
        { path: "first.zip", content: firstInner },
        { path: "second.zip", content: secondInner },
      ],
      { allowNestedArchives: true },
    );
    const generous = {
      maxArchiveBytes: 1024 * 1024,
      maxEntries: 100,
      maxSingleFileBytes: 1024 * 1024,
      maxExpandedBytes: 1024 * 1024,
      maxCompressionRatio: 100,
      maxDepth: 2,
    };

    expectHistoryArchiveReason(
      () => assertSafeHistoryZipTreeForTest(outer, { ...generous, maxEntries: 3 }),
      "too_many_entries",
    );
    const aggregateExpanded =
      firstInner.byteLength + secondInner.byteLength + firstLeaf.byteLength + secondLeaf.byteLength;
    expectHistoryArchiveReason(
      () =>
        assertSafeHistoryZipTreeForTest(outer, {
          ...generous,
          maxSingleFileBytes: Math.max(
            firstInner.byteLength,
            secondInner.byteLength,
            firstLeaf.byteLength,
            secondLeaf.byteLength,
          ),
          maxExpandedBytes: aggregateExpanded - 1,
        }),
      "archive_too_large",
    );

    const incompressible = deterministicIncompressibleBytes(4096);
    const ratioInner = writeZipArchive([{ path: "random.bin", content: incompressible }]);
    const ratioOuter = writeZipArchive([{ path: "inner.zip", content: ratioInner }], {
      allowNestedArchives: true,
    });
    const innerSummary = readZipArchive(ratioInner, {
      allowNestedArchives: true,
      maxCompressionRatio: generous.maxCompressionRatio,
    }).summary;
    const outerSummary = readZipArchive(ratioOuter, {
      allowNestedArchives: true,
      maxCompressionRatio: generous.maxCompressionRatio,
    }).summary;
    const maximumPerLayerRatio = Math.max(
      innerSummary.uncompressedSize / Math.max(1, innerSummary.compressedSize),
      outerSummary.uncompressedSize / Math.max(1, outerSummary.compressedSize),
    );
    const rootTreeRatio =
      (ratioInner.byteLength + incompressible.byteLength) / ratioOuter.byteLength;
    expect(rootTreeRatio).toBeGreaterThan(maximumPerLayerRatio);
    const treeOnlyRatioLimit = (maximumPerLayerRatio + rootTreeRatio) / 2;
    expect(() =>
      readZipArchive(ratioInner, {
        allowNestedArchives: true,
        maxCompressionRatio: treeOnlyRatioLimit,
      }),
    ).not.toThrow();
    expect(() =>
      readZipArchive(ratioOuter, {
        allowNestedArchives: true,
        maxCompressionRatio: treeOnlyRatioLimit,
      }),
    ).not.toThrow();
    expectHistoryArchiveReason(
      () =>
        assertSafeHistoryZipTreeForTest(ratioOuter, {
          ...generous,
          maxCompressionRatio: treeOnlyRatioLimit,
        }),
      "compression_ratio_too_high",
    );
  });

  it("测试钩子不能放大生产历史 ZIP 安全上限", () => {
    const archive = writeZipArchive([
      { path: "safe.md", content: new TextEncoder().encode("synthetic safe content") },
    ]);
    expect(() =>
      assertSafeHistoryZipTreeForTest(archive, {
        maxArchiveBytes: 128 * 1024 * 1024 + 1,
        maxEntries: 100,
        maxSingleFileBytes: 1024,
        maxExpandedBytes: 1024,
        maxCompressionRatio: 100,
        maxDepth: 2,
      }),
    ).toThrow(TypeError);
  });

  it("内层 ZIP 的 CRC 损坏和 Zip64 标记同样安全失败", () => {
    const inner = writeZipArchive([
      { path: "safe.md", content: new TextEncoder().encode("synthetic inner content") },
    ]);
    const cases = [
      [corruptFirstZipCrc(inner), "size_mismatch"],
      [markFirstZipEntryAsZip64(inner), "unsupported_archive_feature"],
    ] as const;
    for (const [unsafeInner, reason] of cases) {
      const outer = writeZipArchive([{ path: "inner.zip", content: unsafeInner }], {
        allowNestedArchives: true,
      });
      expectHistoryArchiveReason(
        () =>
          assertSafeHistoryZipTreeForTest(outer, {
            maxArchiveBytes: 1024 * 1024,
            maxEntries: 100,
            maxSingleFileBytes: 1024 * 1024,
            maxExpandedBytes: 1024 * 1024,
            maxCompressionRatio: 100,
            maxDepth: 2,
          }),
        reason,
      );
    }
  });

  it("根包和内包都拒绝前缀、各区段缝隙、尾随数据与伪 EOCD", () => {
    const encoder = new TextEncoder();
    const base = writeZipArchive([
      { path: "first.md", content: encoder.encode("synthetic first") },
      { path: "second.md", content: encoder.encode("synthetic second") },
    ]);
    const centralOffsets = zipCentralEntryOffsets(base);
    const secondCentral = centralOffsets[1];
    if (secondCentral === undefined) {
      throw new Error("合成 ZIP 缺少第二个中央目录项。");
    }
    const baseView = new DataView(base.buffer, base.byteOffset, base.byteLength);
    const secondLocal = baseView.getUint32(secondCentral + 42, true);
    const centralStart = zipCentralStart(base);
    const endOffset = zipEndOffset(base);
    const structuralCases = [
      addAdjustedZipByte(base, 0),
      addAdjustedZipByte(base, secondLocal),
      addAdjustedZipByte(base, centralStart),
      addAdjustedZipByte(base, endOffset),
      appendZipByte(base),
      appendDuplicateZipEnd(base),
    ];
    const limits = generousHistoryArchiveLimits();

    for (const [index, unsafe] of structuralCases.entries()) {
      expectHistoryArchiveReason(
        () => assertSafeHistoryZipTreeForTest(unsafe, limits),
        "not_a_zip_archive",
      );
      const outer = writeZipArchive([{ path: `inner-${index}.zip`, content: unsafe }], {
        allowNestedArchives: true,
      });
      expectHistoryArchiveReason(
        () => assertSafeHistoryZipTreeForTest(outer, limits),
        "not_a_zip_archive",
      );
    }
  });

  it("严格绑定中央目录、本地头、Zip64 和有无签名的数据描述符", () => {
    const base = writeZipArchive([
      { path: "strict.md", content: new TextEncoder().encode("x".repeat(1024)) },
    ]);
    const mismatches = [
      patchFirstLocalU16(base, 6, (value) => value ^ 0x0008),
      patchFirstLocalU16(base, 8, (value) => (value === 0 ? 8 : 0)),
      corruptFirstLocalZipName(base),
      patchFirstLocalU32(base, 14, (value) => (value + 1) >>> 0),
      patchFirstLocalU32(base, 22, (value) => (value + 1) >>> 0),
      patchFirstCentralU32(base, 42, (value) => (value + 1) >>> 0),
    ];
    const limits = generousHistoryArchiveLimits();
    for (const unsafe of mismatches) {
      expect(() => assertSafeHistoryZipTreeForTest(unsafe, limits)).toThrow();
    }

    const signed = makeDataDescriptorZip(true);
    const unsigned = makeDataDescriptorZip(false);
    expect(() => assertSafeHistoryZipTreeForTest(signed, limits)).not.toThrow();
    expect(() => assertSafeHistoryZipTreeForTest(unsigned, limits)).not.toThrow();
    expectHistoryArchiveReason(
      () => assertSafeHistoryZipTreeForTest(corruptZipDescriptor(signed, true), limits),
      "size_mismatch",
    );
    expectHistoryArchiveReason(
      () => assertSafeHistoryZipTreeForTest(corruptZipDescriptor(unsigned, false), limits),
      "size_mismatch",
    );

    const archiveZip64 = addArchiveLevelZip64(base);
    expectHistoryArchiveReason(
      () => assertSafeHistoryZipTreeForTest(archiveZip64, limits),
      "unsupported_archive_feature",
    );
    const outer = writeZipArchive([{ path: "zip64.zip", content: archiveZip64 }], {
      allowNestedArchives: true,
    });
    expectHistoryArchiveReason(
      () => assertSafeHistoryZipTreeForTest(outer, limits),
      "unsupported_archive_feature",
    );
  });

  it("历史源路径以及根包、内包路径都拒绝非 NFC、Cc 与 Cf 字符", async () => {
    const unsafePaths = ["synthetic-\u0085.md", "synthetic-\u202e.md", "synthetic-e\u0301.md"];
    const limits = generousHistoryArchiveLimits();
    for (const unsafePath of unsafePaths) {
      const rootArchive = writeZipArchive([
        { path: unsafePath, content: new TextEncoder().encode("synthetic") },
      ]);
      expectHistoryArchiveReason(
        () => assertSafeHistoryZipTreeForTest(rootArchive, limits),
        "invalid_path",
      );
      const inner = writeZipArchive([
        { path: unsafePath, content: new TextEncoder().encode("synthetic") },
      ]);
      const outer = writeZipArchive([{ path: "inner.zip", content: inner }], {
        allowNestedArchives: true,
      });
      expectHistoryArchiveReason(
        () => assertSafeHistoryZipTreeForTest(outer, limits),
        "invalid_path",
      );

      const privateRoot = await createPrivateRoot();
      const sourceDirectory = join(privateRoot, "unsafe-unicode-source");
      await mkdir(sourceDirectory, { mode: 0o700 });
      await writeFile(join(sourceDirectory, unsafePath), "synthetic source", "utf8");
      const catalogDirectory = join(privateRoot, "unsafe-unicode-catalog");
      await expect(
        inventoryHistorySources({
          privateRootDirectory: privateRoot,
          sourceDirectory,
          outputDirectory: catalogDirectory,
        }),
      ).rejects.toMatchObject({ code: "SOURCE_FILE_INVALID" });
      await expect(lstat(catalogDirectory)).rejects.toMatchObject({ code: "ENOENT" });
    }

    const casefoldCollision = writeZipArchive([
      { path: "straße.md", content: new TextEncoder().encode("first") },
      { path: "STRASSE.md", content: new TextEncoder().encode("second") },
    ]);
    expectHistoryArchiveReason(
      () => assertSafeHistoryZipTreeForTest(casefoldCollision, limits),
      "duplicate_path",
    );
    const collisionOuter = writeZipArchive(
      [{ path: "collision.zip", content: casefoldCollision }],
      { allowNestedArchives: true },
    );
    expectHistoryArchiveReason(
      () => assertSafeHistoryZipTreeForTest(collisionOuter, limits),
      "duplicate_path",
    );
  });

  it("同层内包先整体预占条目和展开预算，CRC 坏包不会抢先解压且结果与兄弟顺序无关", () => {
    const encoder = new TextEncoder();
    const corruptInner = corruptFirstZipCrc(
      writeZipArchive([{ path: "corrupt.md", content: encoder.encode("c".repeat(64)) }]),
    );
    const validInner = writeZipArchive([
      { path: "valid.md", content: encoder.encode("v".repeat(64)) },
    ]);
    for (const children of [
      [corruptInner, validInner],
      [validInner, corruptInner],
    ]) {
      const outer = writeZipArchive(
        children.map((content, index) => ({ path: `child-${index}.zip`, content })),
        { allowNestedArchives: true },
      );
      const rootExpanded = corruptInner.byteLength + validInner.byteLength;
      const expandedLimit = rootExpanded + 64 + 64 - 1;
      expectHistoryArchiveReason(
        () =>
          assertSafeHistoryZipTreeForTest(outer, {
            ...generousHistoryArchiveLimits(),
            maxSingleFileBytes: Math.max(corruptInner.byteLength, validInner.byteLength),
            maxExpandedBytes: expandedLimit,
          }),
        "archive_too_large",
      );
      expectHistoryArchiveReason(
        () =>
          assertSafeHistoryZipTreeForTest(outer, {
            ...generousHistoryArchiveLimits(),
            maxEntries: 3,
          }),
        "too_many_entries",
      );
    }
  });

  it("旧式非 UTF-8 文件名 ZIP 不放宽解码，固定进入人工转换队列", async () => {
    const privateRoot = await createPrivateRoot();
    const sourceDirectory = join(privateRoot, "legacy-zip-sources");
    await mkdir(sourceDirectory, { mode: 0o700 });
    const legacyName = "synthetic-legacy-name.zip";
    await writeFile(join(sourceDirectory, legacyName), makeLegacyFilenameZip());
    const catalogDirectory = join(privateRoot, "legacy-zip-catalog");

    await expect(
      inventoryHistorySources({
        privateRootDirectory: privateRoot,
        sourceDirectory,
        outputDirectory: catalogDirectory,
      }),
    ).resolves.toMatchObject({
      sourceCount: 1,
      archiveSourceCount: 0,
      manualSourceCount: 1,
    });
    const manualReviewText = await readFile(join(catalogDirectory, "manual-review.json"), "utf8");
    expect(manualReviewText).toContain("not_a_zip_archive");
    expect(manualReviewText).not.toContain(legacyName);
  });

  it("确认后源文件变化会停止物化且不留下半成品", async () => {
    const fixture = await createConfirmedFixture();
    await writeFile(
      join(fixture.sourceDirectory, combinedSourceName),
      `${alphaText}\nSYNTHETIC CHANGED VALUE`,
      "utf8",
    );

    await expect(materializeHistoryGrouping(materializeOptions(fixture))).rejects.toMatchObject({
      code: "GROUPING_CHANGED",
    });
    await expect(lstat(fixture.materializedDirectory)).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("确认后分组顺序变化会使确认失效", async () => {
    const fixture = await createConfirmedFixture();
    const groupingFile = join(fixture.groupingDirectory, "grouping.private.json");
    const grouping = JSON.parse(await readFile(groupingFile, "utf8")) as {
      groups: Array<{ fragmentIds: string[] }>;
    };
    const firstGroup = grouping.groups[0];
    if (firstGroup === undefined) {
      throw new Error("合成分组缺少第一组。");
    }
    firstGroup.fragmentIds.reverse();
    await writeFile(groupingFile, `${JSON.stringify(grouping, null, 2)}\n`, "utf8");

    await expect(materializeHistoryGrouping(materializeOptions(fixture))).rejects.toMatchObject({
      code: "GROUPING_CHANGED",
    });
  });

  it("建立清单后新增文件会停止封存分组", async () => {
    const fixture = await createCatalogFixture();
    await writeFile(
      join(fixture.sourceDirectory, "synthetic-added-later.txt"),
      "SYNTHETIC NEW SOURCE",
      "utf8",
    );
    const planFile = await writePlan(fixture);

    await expect(
      sealHistoryGrouping({
        privateRootDirectory: fixture.privateRoot,
        sourceDirectory: fixture.sourceDirectory,
        sourceInventoryFile: fixture.inventoryFile,
        sourceLocationsFile: fixture.locationsFile,
        metadataFile: fixture.metadataFile,
        groupingPlanFile: planFile,
        outputDirectory: join(fixture.privateRoot, "grouping-attempt"),
      }),
    ).rejects.toMatchObject({ code: "GROUPING_CHANGED" });
  });

  it("符号链接返回固定错误，未通过安全检查的 ZIP 只进入人工队列", async () => {
    const privateRoot = await createPrivateRoot();
    const linkedSourceDirectory = join(privateRoot, "linked-sources");
    await mkdir(linkedSourceDirectory, { mode: 0o700 });
    const outside = join(privateRoot, "outside.txt");
    await writeFile(outside, "SYNTHETIC OUTSIDE", "utf8");
    const privateLinkName = "synthetic-private-link.txt";
    await symlink(outside, join(linkedSourceDirectory, privateLinkName));

    let linkedError: unknown;
    try {
      await inventoryHistorySources({
        privateRootDirectory: privateRoot,
        sourceDirectory: linkedSourceDirectory,
        outputDirectory: join(privateRoot, "linked-catalog"),
      });
    } catch (error) {
      linkedError = error;
    }
    expect(linkedError).toMatchObject({ code: "SOURCE_FILE_INVALID" });
    expect(String(linkedError)).not.toContain(privateLinkName);

    const brokenSourceDirectory = join(privateRoot, "broken-sources");
    await mkdir(brokenSourceDirectory, { mode: 0o700 });
    const brokenName = "synthetic-private-broken.zip";
    await writeFile(join(brokenSourceDirectory, brokenName), "SYNTHETIC NOT A ZIP", "utf8");
    const brokenResult = await inventoryHistorySources({
      privateRootDirectory: privateRoot,
      sourceDirectory: brokenSourceDirectory,
      outputDirectory: join(privateRoot, "broken-catalog"),
    });
    expect(brokenResult).toMatchObject({
      sourceCount: 1,
      archiveSourceCount: 0,
      manualSourceCount: 1,
    });
    const manualReview = JSON.parse(
      await readFile(join(privateRoot, "broken-catalog", "manual-review.json"), "utf8"),
    ) as {
      manualSourceCount: number;
      sources: Array<{
        sourceId: string;
        reasons: string[];
      }>;
    };
    expect(manualReview).toEqual({
      version: 2,
      phase: "inventory",
      sourceCount: 1,
      manualSourceCount: 1,
      sources: [
        {
          sourceId: "source-000001",
          reasons: ["not_a_zip_archive"],
        },
      ],
    });
    expect(JSON.stringify(manualReview)).not.toContain(brokenName);
    await expectPrivateMode(join(privateRoot, "broken-catalog", "manual-review.json"), 0o600);
  });

  it("源文件超过清单上限时只在私有失败清单中记录原路径", async () => {
    const privateRoot = await createPrivateRoot();
    const sourceDirectory = join(privateRoot, "oversized-sources");
    await mkdir(sourceDirectory, { mode: 0o700 });
    const privateSourceName = "synthetic-private-oversized.bin";
    const handle = await open(join(sourceDirectory, privateSourceName), "w", 0o600);
    await handle.truncate(128 * 1024 * 1024 + 1);
    await handle.close();
    const outputDirectory = join(privateRoot, "oversized-catalog");

    let failure: unknown;
    try {
      await inventoryHistorySources({
        privateRootDirectory: privateRoot,
        sourceDirectory,
        outputDirectory,
      });
    } catch (error) {
      failure = error;
    }
    expect(failure).toMatchObject({ code: "SOURCE_FILE_INVALID" });
    expect(String(failure)).not.toContain(privateSourceName);
    const report = JSON.parse(
      await readFile(join(outputDirectory, "inventory-failures.private.json"), "utf8"),
    ) as {
      failureCount: number;
      failures: Array<{
        sourceId: string;
        sourcePath: string;
        code: string;
        reasons: string[];
      }>;
    };
    expect(report).toMatchObject({
      failureCount: 1,
      failures: [
        {
          sourceId: "source-000001",
          sourcePath: privateSourceName,
          code: "SOURCE_TOO_LARGE",
          reasons: ["source_too_large"],
        },
      ],
    });
    await expect(lstat(join(outputDirectory, "inventory.json"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expectPrivateMode(join(outputDirectory, "inventory-failures.private.json"), 0o600);
  });

  it("二进制完整文件不能冒充文本片段，失败时不写分组文件", async () => {
    const fixture = await createCatalogFixture();
    const locations = await readLocations(fixture.locationsFile);
    const manualSourceId = sourceIdForPath(locations, manualSourceName);
    const planFile = join(fixture.privateRoot, "binary-plan.private.json");
    await writeFile(
      planFile,
      `${JSON.stringify(
        {
          version: 2,
          fragments: [
            {
              fragmentId: "fragment-000001",
              sourceId: manualSourceId,
              selection: { kind: "whole_file" },
            },
          ],
          groups: [
            {
              groupId: "group-000001",
              metadataId: "metadata-000001",
              fragmentIds: ["fragment-000001"],
            },
          ],
          sharingConfirmations: [],
          metadataDispositions: [
            {
              metadataId: "metadata-000002",
              action: "deferred",
              reason: "synthetic manual decision",
              confirmed: true,
            },
          ],
          zipEntryDispositions: [],
          textRangeDispositions: [],
          manualSourceDispositions: [],
        },
        null,
        2,
      )}\n`,
      "utf8",
    );
    const outputDirectory = join(fixture.privateRoot, "binary-grouping");

    await expect(
      sealHistoryGrouping({
        privateRootDirectory: fixture.privateRoot,
        sourceDirectory: fixture.sourceDirectory,
        sourceInventoryFile: fixture.inventoryFile,
        sourceLocationsFile: fixture.locationsFile,
        metadataFile: fixture.metadataFile,
        groupingPlanFile: planFile,
        outputDirectory,
      }),
    ).rejects.toMatchObject({ code: "SOURCE_FILE_INVALID" });
    await expect(lstat(outputDirectory)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("没有明确人工确认或输出目录已存在时拒绝继续", async () => {
    const fixture = await createCatalogFixture();
    const sealed = await sealFixture(fixture);
    await expect(
      writeHistoryGroupingConfirmation({
        privateRootDirectory: fixture.privateRoot,
        sourceInventoryFile: fixture.inventoryFile,
        sourceLocationsFile: fixture.locationsFile,
        metadataFile: fixture.metadataFile,
        groupingDirectory: sealed.groupingDirectory,
        outputFile: fixture.confirmationFile,
        confirmed: false,
      }),
    ).rejects.toMatchObject({ code: "INVALID_SOURCE_CONFIRMATION" });

    await writeHistoryGroupingConfirmation({
      privateRootDirectory: fixture.privateRoot,
      sourceInventoryFile: fixture.inventoryFile,
      sourceLocationsFile: fixture.locationsFile,
      metadataFile: fixture.metadataFile,
      groupingDirectory: sealed.groupingDirectory,
      outputFile: fixture.confirmationFile,
      confirmed: true,
    });
    await materializeHistoryGrouping(
      materializeOptions({
        ...fixture,
        groupingDirectory: sealed.groupingDirectory,
      }),
    );
    await expect(
      materializeHistoryGrouping(
        materializeOptions({
          ...fixture,
          groupingDirectory: sealed.groupingDirectory,
        }),
      ),
    ).rejects.toMatchObject({ code: "OUTPUT_ALREADY_EXISTS" });
  });

  it("完整性报告逐类列出未分组元数据、文本空档、ZIP 条目和人工源", async () => {
    const fixture = await createCatalogFixture();
    const metadata = JSON.parse(await readFile(fixture.metadataFile, "utf8")) as {
      records: Array<{ number: string; name: string }>;
    };
    metadata.records.push({ number: "metadata-3", name: "Synthetic metadata title three" });
    await writeFile(fixture.metadataFile, `${JSON.stringify(metadata, null, 2)}\n`, "utf8");
    const planFile = await writePlan(fixture);
    const plan = JSON.parse(await readFile(planFile, "utf8")) as {
      zipEntryDispositions: unknown[];
      textRangeDispositions: unknown[];
      manualSourceDispositions: unknown[];
    };
    plan.zipEntryDispositions = [];
    plan.textRangeDispositions = [];
    plan.manualSourceDispositions = [];
    await writeFile(planFile, `${JSON.stringify(plan, null, 2)}\n`, "utf8");
    const outputDirectory = join(fixture.privateRoot, "grouping-incomplete");

    await expect(
      sealHistoryGrouping({
        privateRootDirectory: fixture.privateRoot,
        sourceDirectory: fixture.sourceDirectory,
        sourceInventoryFile: fixture.inventoryFile,
        sourceLocationsFile: fixture.locationsFile,
        metadataFile: fixture.metadataFile,
        groupingPlanFile: planFile,
        outputDirectory,
      }),
    ).rejects.toMatchObject({ code: "INVALID_GROUPING" });
    const reportText = await readFile(join(outputDirectory, "grouping-validation.json"), "utf8");
    const report = JSON.parse(reportText) as {
      status: string;
      unresolvedMetadataIds: string[];
      uncoveredTextRanges: Array<{ sourceId: string; start: number; end: number }>;
      unresolvedZipEntries: Array<{ sourceId: string; entryId: string }>;
      unresolvedManualSourceIds: string[];
      unresolvedItemCount: number;
    };
    expect(report).toMatchObject({
      status: "incomplete",
      unresolvedMetadataIds: ["metadata-000003"],
      unresolvedItemCount: 4,
    });
    expect(report.uncoveredTextRanges).toHaveLength(1);
    expect(report.unresolvedZipEntries).toHaveLength(1);
    expect(report.unresolvedManualSourceIds).toHaveLength(1);
    for (const privateMarker of [
      combinedSourceName,
      archiveSourceName,
      manualSourceName,
      archiveEntryName,
      alphaText,
      "metadata-3",
    ]) {
      expect(reportText).not.toContain(privateMarker);
    }
    await expect(lstat(join(outputDirectory, "GROUPING_COMPLETE"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("清单标记没有绑定当前人工队列时拒绝 seal", async () => {
    const fixture = await createCatalogFixture();
    const manualReviewFile = join(fixture.catalogDirectory, "manual-review.json");
    const manualReview = JSON.parse(await readFile(manualReviewFile, "utf8")) as {
      sources: Array<{ reasons: string[] }>;
    };
    const firstManualSource = manualReview.sources[0];
    if (firstManualSource === undefined) {
      throw new Error("合成人工队列为空。");
    }
    firstManualSource.reasons.push("synthetic_changed_reason");
    await writeFile(manualReviewFile, `${JSON.stringify(manualReview, null, 2)}\n`, "utf8");

    await expect(
      sealHistoryGrouping({
        privateRootDirectory: fixture.privateRoot,
        sourceDirectory: fixture.sourceDirectory,
        sourceInventoryFile: fixture.inventoryFile,
        sourceLocationsFile: fixture.locationsFile,
        metadataFile: fixture.metadataFile,
        groupingPlanFile: await writePlan(fixture),
        outputDirectory: join(fixture.privateRoot, "grouping-marker-mismatch"),
      }),
    ).rejects.toMatchObject({ code: "GROUPING_CHANGED" });
  });

  it("人工源标为已转换时必须指向实际进入分组的文本源", async () => {
    const fixture = await createCatalogFixture();
    const planFile = await writePlan(fixture);
    const plan = JSON.parse(await readFile(planFile, "utf8")) as {
      manualSourceDispositions: Array<Record<string, unknown>>;
    };
    const locations = await readLocations(fixture.locationsFile);
    plan.manualSourceDispositions = [
      {
        sourceId: sourceIdForPath(locations, manualSourceName),
        action: "converted",
        convertedSourceId: sourceIdForPath(locations, extraSourceName),
        reason: "synthetic reviewed conversion",
        confirmed: true,
      },
    ];
    await writeFile(planFile, `${JSON.stringify(plan, null, 2)}\n`, "utf8");
    const convertedOutputDirectory = join(fixture.privateRoot, "grouping-converted");
    await expect(
      sealHistoryGrouping({
        privateRootDirectory: fixture.privateRoot,
        sourceDirectory: fixture.sourceDirectory,
        sourceInventoryFile: fixture.inventoryFile,
        sourceLocationsFile: fixture.locationsFile,
        metadataFile: fixture.metadataFile,
        groupingPlanFile: planFile,
        outputDirectory: convertedOutputDirectory,
      }),
    ).resolves.toMatchObject({ unresolvedItemCount: 0 });
    const convertedReport = JSON.parse(
      await readFile(join(convertedOutputDirectory, "grouping-validation.json"), "utf8"),
    ) as {
      dispositionSummary: Array<{
        itemId: string;
        action: string;
        convertedSourceId?: string;
      }>;
    };
    expect(convertedReport.dispositionSummary).toContainEqual(
      expect.objectContaining({
        itemId: sourceIdForPath(locations, manualSourceName),
        action: "converted",
        convertedSourceId: sourceIdForPath(locations, extraSourceName),
      }),
    );

    const convertedDisposition = plan.manualSourceDispositions[0];
    if (convertedDisposition === undefined) {
      throw new Error("合成转换处置不存在。");
    }
    convertedDisposition.convertedSourceId = "source-999999";
    const invalidPlanFile = join(fixture.privateRoot, "grouping-converted-invalid.private.json");
    await writeFile(invalidPlanFile, `${JSON.stringify(plan, null, 2)}\n`, "utf8");
    await expect(
      sealHistoryGrouping({
        privateRootDirectory: fixture.privateRoot,
        sourceDirectory: fixture.sourceDirectory,
        sourceInventoryFile: fixture.inventoryFile,
        sourceLocationsFile: fixture.locationsFile,
        metadataFile: fixture.metadataFile,
        groupingPlanFile: invalidPlanFile,
        outputDirectory: join(fixture.privateRoot, "grouping-converted-invalid"),
      }),
    ).rejects.toMatchObject({ code: "INVALID_GROUPING" });
  });

  it("片段与人工处置范围都不能切开 Unicode 代理项对", async () => {
    const privateRoot = await createPrivateRoot();
    const sourceDirectory = join(privateRoot, "unicode-sources");
    await mkdir(sourceDirectory, { mode: 0o700 });
    await writeFile(join(sourceDirectory, "synthetic-unicode.txt"), "A😀B", "utf8");
    const catalogDirectory = join(privateRoot, "unicode-catalog");
    await inventoryHistorySources({
      privateRootDirectory: privateRoot,
      sourceDirectory,
      outputDirectory: catalogDirectory,
    });
    const metadataFile = join(privateRoot, "unicode-metadata.private.json");
    await writeFile(
      metadataFile,
      `${JSON.stringify({ records: [{ number: "metadata-1", name: "Synthetic Unicode" }] })}\n`,
      "utf8",
    );
    const planFile = join(privateRoot, "unicode-plan.private.json");
    await writeFile(
      planFile,
      `${JSON.stringify({
        version: 2,
        fragments: [
          {
            fragmentId: "fragment-000001",
            sourceId: "source-000001",
            selection: { kind: "text_range", start: 0, end: 2 },
          },
        ],
        groups: [
          {
            groupId: "group-000001",
            metadataId: "metadata-000001",
            fragmentIds: ["fragment-000001"],
          },
        ],
        sharingConfirmations: [],
        metadataDispositions: [],
        zipEntryDispositions: [],
        textRangeDispositions: [],
        manualSourceDispositions: [],
      })}\n`,
      "utf8",
    );
    await expect(
      sealHistoryGrouping({
        privateRootDirectory: privateRoot,
        sourceDirectory,
        sourceInventoryFile: join(catalogDirectory, "inventory.json"),
        sourceLocationsFile: join(catalogDirectory, "source-locations.private.json"),
        metadataFile,
        groupingPlanFile: planFile,
        outputDirectory: join(privateRoot, "unicode-grouping"),
      }),
    ).rejects.toMatchObject({ code: "FRAGMENT_OUT_OF_RANGE" });

    const dispositionPlanFile = join(privateRoot, "unicode-disposition-plan.private.json");
    await writeFile(
      dispositionPlanFile,
      `${JSON.stringify({
        version: 2,
        fragments: [
          {
            fragmentId: "fragment-000001",
            sourceId: "source-000001",
            selection: { kind: "text_range", start: 0, end: 1 },
          },
        ],
        groups: [
          {
            groupId: "group-000001",
            metadataId: "metadata-000001",
            fragmentIds: ["fragment-000001"],
          },
        ],
        sharingConfirmations: [],
        metadataDispositions: [],
        zipEntryDispositions: [],
        textRangeDispositions: [
          {
            sourceId: "source-000001",
            start: 1,
            end: 2,
            action: "ignored",
            reason: "synthetic invalid unicode boundary",
            confirmed: true,
          },
        ],
        manualSourceDispositions: [],
      })}\n`,
      "utf8",
    );
    await expect(
      sealHistoryGrouping({
        privateRootDirectory: privateRoot,
        sourceDirectory,
        sourceInventoryFile: join(catalogDirectory, "inventory.json"),
        sourceLocationsFile: join(catalogDirectory, "source-locations.private.json"),
        metadataFile,
        groupingPlanFile: dispositionPlanFile,
        outputDirectory: join(privateRoot, "unicode-disposition-grouping"),
      }),
    ).rejects.toMatchObject({ code: "FRAGMENT_OUT_OF_RANGE" });
  });

  it("空白工作表只列安全编号，不自动建议映射或代替确认", async () => {
    const fixture = await createCatalogFixture();
    const outputDirectory = join(fixture.privateRoot, "worksheet-001");
    await initializeHistoryGroupingWorksheet({
      privateRootDirectory: fixture.privateRoot,
      sourceInventoryFile: fixture.inventoryFile,
      sourceLocationsFile: fixture.locationsFile,
      metadataFile: fixture.metadataFile,
      outputDirectory,
    });
    const worksheetText = await readFile(join(outputDirectory, "worksheet.json"), "utf8");
    const skeleton = JSON.parse(
      await readFile(join(outputDirectory, "grouping-plan.skeleton.private.json"), "utf8"),
    ) as { fragments: unknown[]; groups: unknown[]; manualSourceDispositions: unknown[] };
    const marker = JSON.parse(
      await readFile(join(outputDirectory, "WORKSHEET_COMPLETE"), "utf8"),
    ) as { reviewed: boolean };
    expect(skeleton).toMatchObject({
      fragments: [],
      groups: [],
      manualSourceDispositions: [],
    });
    expect(marker.reviewed).toBe(false);
    expect(worksheetText).toContain("metadata-000001");
    for (const privateMarker of [
      combinedSourceName,
      archiveSourceName,
      manualSourceName,
      archiveEntryName,
      alphaText,
      "metadata-1",
    ]) {
      expect(worksheetText).not.toContain(privateMarker);
    }
  });

  it("prepare 前会重新核对 MATERIALIZE_COMPLETE 及报告摘要", async () => {
    const fixture = await createConfirmedFixture();
    await materializeHistoryGrouping(materializeOptions(fixture));
    await expect(
      assertHistoryMaterializationComplete({
        privateRootDirectory: fixture.privateRoot,
        materializedDirectory: fixture.materializedDirectory,
      }),
    ).resolves.toMatchObject({
      materializedDirectory: fixture.materializedDirectory,
      sourceDirectory: join(fixture.materializedDirectory, "sources"),
      sourceConfirmationFile: join(
        fixture.materializedDirectory,
        "source-confirmation.private.json",
      ),
      groupingBatchSha256: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
    const reportFile = join(fixture.materializedDirectory, "report.json");
    const report = JSON.parse(await readFile(reportFile, "utf8")) as { fragmentCount: number };
    report.fragmentCount += 1;
    await writeFile(reportFile, `${JSON.stringify(report, null, 2)}\n`, "utf8");
    await chmod(reportFile, 0o600);
    await expect(
      assertHistoryMaterializationComplete({
        privateRootDirectory: fixture.privateRoot,
        materializedDirectory: fixture.materializedDirectory,
      }),
    ).rejects.toMatchObject({ code: "GROUPING_CHANGED" });
  });
});

interface CatalogFixture {
  readonly privateRoot: string;
  readonly sourceDirectory: string;
  readonly catalogDirectory: string;
  readonly inventoryFile: string;
  readonly locationsFile: string;
  readonly metadataFile: string;
  readonly confirmationFile: string;
  readonly materializedDirectory: string;
}

interface ConfirmedFixture extends CatalogFixture {
  readonly groupingDirectory: string;
}

async function createPrivateRoot(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "urmotiv-history-grouping-"));
  temporaryDirectories.push(path);
  return path;
}

async function createCatalogFixture(): Promise<CatalogFixture> {
  const privateRoot = await createPrivateRoot();
  const sourceDirectory = join(privateRoot, "sources");
  await mkdir(sourceDirectory, { mode: 0o700 });
  await writeFile(join(sourceDirectory, combinedSourceName), `${alphaText}\n${betaText}`, "utf8");
  await writeFile(join(sourceDirectory, extraSourceName), alphaSolution, "utf8");
  await writeFile(
    join(sourceDirectory, archiveSourceName),
    writeZipArchive([
      {
        path: archiveEntryName,
        content: new TextEncoder().encode(betaSolution),
      },
      {
        path: "private/synthetic-unused.md",
        content: new TextEncoder().encode("SYNTHETIC UNUSED ARCHIVE ENTRY"),
      },
    ]),
  );
  await writeFile(
    join(sourceDirectory, manualSourceName),
    new Uint8Array([0xff, 0x00, 0xfe, 0x01]),
  );

  const metadataFile = join(privateRoot, "metadata.private.json");
  await writeFile(
    metadataFile,
    `${JSON.stringify(
      {
        records: [
          { number: "metadata-1", name: "Synthetic metadata title one" },
          { number: "metadata-2", name: "Synthetic metadata title two" },
        ],
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  const catalogDirectory = join(privateRoot, "catalog-001");
  const result = await inventoryHistorySources({
    privateRootDirectory: privateRoot,
    sourceDirectory,
    outputDirectory: catalogDirectory,
  });
  expect(result).toMatchObject({
    sourceCount: 4,
    textSourceCount: 2,
    archiveSourceCount: 1,
    manualSourceCount: 1,
    archiveEntryCount: 2,
  });

  return {
    privateRoot,
    sourceDirectory,
    catalogDirectory,
    inventoryFile: join(catalogDirectory, "inventory.json"),
    locationsFile: join(catalogDirectory, "source-locations.private.json"),
    metadataFile,
    confirmationFile: join(privateRoot, "grouping-confirmation.private.json"),
    materializedDirectory: join(privateRoot, "materialized-001"),
  };
}

async function sealFixture(fixture: CatalogFixture): Promise<{
  readonly groupingDirectory: string;
  readonly result: Awaited<ReturnType<typeof sealHistoryGrouping>>;
}> {
  const groupingPlanFile = await writePlan(fixture);
  const groupingDirectory = join(fixture.privateRoot, "grouping-001");
  const result = await sealHistoryGrouping({
    privateRootDirectory: fixture.privateRoot,
    sourceDirectory: fixture.sourceDirectory,
    sourceInventoryFile: fixture.inventoryFile,
    sourceLocationsFile: fixture.locationsFile,
    metadataFile: fixture.metadataFile,
    groupingPlanFile,
    outputDirectory: groupingDirectory,
  });
  return { groupingDirectory, result };
}

async function createConfirmedFixture(): Promise<ConfirmedFixture> {
  const fixture = await createCatalogFixture();
  const sealed = await sealFixture(fixture);
  await writeHistoryGroupingConfirmation({
    privateRootDirectory: fixture.privateRoot,
    sourceInventoryFile: fixture.inventoryFile,
    sourceLocationsFile: fixture.locationsFile,
    metadataFile: fixture.metadataFile,
    groupingDirectory: sealed.groupingDirectory,
    outputFile: fixture.confirmationFile,
    confirmed: true,
  });
  return { ...fixture, groupingDirectory: sealed.groupingDirectory };
}

async function writePlan(fixture: CatalogFixture): Promise<string> {
  const inventory = JSON.parse(
    await readFile(fixture.inventoryFile, "utf8"),
  ) as HistorySourceInventory;
  const locations = await readLocations(fixture.locationsFile);
  const combinedSourceId = sourceIdForPath(locations, combinedSourceName);
  const extraSourceId = sourceIdForPath(locations, extraSourceName);
  const archiveLocation = locations.sources.find(
    (source) => source.sourcePath === archiveSourceName,
  );
  if (archiveLocation === undefined) {
    throw new Error("合成压缩包来源不存在。");
  }
  const archiveEntry = archiveLocation.entries.find(
    (entry) => entry.entryPathChain.length === 1 && entry.entryPathChain[0] === archiveEntryName,
  );
  if (archiveEntry === undefined) {
    throw new Error("合成压缩包条目不存在。");
  }
  const unusedArchiveEntry = archiveLocation.entries.find(
    (entry) =>
      entry.entryPathChain.length === 1 &&
      entry.entryPathChain[0] === "private/synthetic-unused.md",
  );
  if (unusedArchiveEntry === undefined) {
    throw new Error("合成未使用压缩包条目不存在。");
  }
  expect(inventory.sources.some((source) => source.sourceId === combinedSourceId)).toBe(true);

  const combined = `${alphaText}\n${betaText}`;
  const betaStart = combined.indexOf(betaText);
  const plan: HistoryGroupingPlan = {
    version: 2,
    fragments: [
      {
        fragmentId: "fragment-000001",
        sourceId: combinedSourceId,
        selection: { kind: "text_range", start: 0, end: alphaText.length },
      },
      {
        fragmentId: "fragment-000002",
        sourceId: extraSourceId,
        selection: { kind: "whole_file" },
      },
      {
        fragmentId: "fragment-000003",
        sourceId: combinedSourceId,
        selection: {
          kind: "text_range",
          start: betaStart,
          end: combined.length,
        },
      },
      {
        fragmentId: "fragment-000004",
        sourceId: archiveLocation.sourceId,
        selection: { kind: "zip_entry", entryId: archiveEntry.entryId },
      },
    ],
    groups: [
      {
        groupId: "group-000001",
        metadataId: "metadata-000001",
        fragmentIds: ["fragment-000001", "fragment-000002"],
      },
      {
        groupId: "group-000002",
        metadataId: "metadata-000002",
        fragmentIds: ["fragment-000003", "fragment-000004"],
      },
    ],
    sharingConfirmations: [],
    metadataDispositions: [],
    zipEntryDispositions: [
      {
        sourceId: archiveLocation.sourceId,
        entryId: unusedArchiveEntry.entryId,
        action: "ignored",
        reason: "synthetic unused archive material",
        confirmed: true,
      },
    ],
    textRangeDispositions: [
      {
        sourceId: combinedSourceId,
        start: alphaText.length,
        end: betaStart,
        action: "ignored",
        reason: "synthetic separator",
        confirmed: true,
      },
    ],
    manualSourceDispositions: [
      {
        sourceId: sourceIdForPath(locations, manualSourceName),
        action: "ignored",
        reason: "synthetic opaque fixture",
        confirmed: true,
      },
    ],
  };
  const planFile = join(fixture.privateRoot, "grouping-plan.private.json");
  await writeFile(planFile, `${JSON.stringify(plan, null, 2)}\n`, "utf8");
  return planFile;
}

async function readLocations(path: string): Promise<HistorySourceLocations> {
  return JSON.parse(await readFile(path, "utf8")) as HistorySourceLocations;
}

function sourceIdForPath(locations: HistorySourceLocations, sourcePath: string): string {
  const source = locations.sources.find((candidate) => candidate.sourcePath === sourcePath);
  if (source === undefined) {
    throw new Error("合成来源路径没有安全编号。");
  }
  return source.sourceId;
}

function materializeOptions(fixture: ConfirmedFixture) {
  return {
    privateRootDirectory: fixture.privateRoot,
    sourceDirectory: fixture.sourceDirectory,
    sourceInventoryFile: fixture.inventoryFile,
    sourceLocationsFile: fixture.locationsFile,
    metadataFile: fixture.metadataFile,
    groupingDirectory: fixture.groupingDirectory,
    groupingConfirmationFile: fixture.confirmationFile,
    outputDirectory: fixture.materializedDirectory,
  };
}

async function expectPrivateMode(path: string, mode: number): Promise<void> {
  const metadata = await lstat(path);
  expect(metadata.mode & 0o777).toBe(mode);
}

function syntheticArchiveEntries(
  count: number,
  prefix: string,
): Array<{ path: string; content: Uint8Array }> {
  return Array.from({ length: count }, (_, index) => ({
    path: `${prefix}-${index.toString().padStart(4, "0")}.md`,
    content: new Uint8Array([index & 0xff]),
  }));
}

function privateJsonByteLength(value: unknown): number {
  return new TextEncoder().encode(`${JSON.stringify(value, null, 2)}\n`).byteLength;
}

function generousHistoryArchiveLimits() {
  return {
    maxArchiveBytes: 1024 * 1024,
    maxEntries: 100,
    maxSingleFileBytes: 1024 * 1024,
    maxExpandedBytes: 1024 * 1024,
    maxCompressionRatio: 100,
    maxDepth: 2,
  };
}

function zipEndOffset(bytes: Uint8Array): number {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const scanStart = Math.max(0, bytes.byteLength - (22 + 65_535));
  for (let offset = bytes.byteLength - 22; offset >= scanStart; offset -= 1) {
    if (
      view.getUint32(offset, true) === 0x06054b50 &&
      offset + 22 + view.getUint16(offset + 20, true) === bytes.byteLength
    ) {
      return offset;
    }
  }
  throw new Error("合成 ZIP 缺少普通结束目录记录。");
}

function zipCentralStart(bytes: Uint8Array): number {
  const endOffset = zipEndOffset(bytes);
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(
    endOffset + 16,
    true,
  );
}

function addAdjustedZipByte(archive: Uint8Array, insertionOffset: number): Uint8Array {
  const oldEndOffset = zipEndOffset(archive);
  const oldView = new DataView(archive.buffer, archive.byteOffset, archive.byteLength);
  const oldCentralStart = oldView.getUint32(oldEndOffset + 16, true);
  const oldCentralOffsets = zipCentralEntryOffsets(archive);
  if (insertionOffset < 0 || insertionOffset > oldEndOffset) {
    throw new Error("合成 ZIP 插入位置不正确。");
  }
  const changed = new Uint8Array(archive.byteLength + 1);
  changed.set(archive.subarray(0, insertionOffset), 0);
  changed[insertionOffset] = 0x5a;
  changed.set(archive.subarray(insertionOffset), insertionOffset + 1);
  const changedView = new DataView(changed.buffer);
  const newEndOffset = oldEndOffset + 1;
  const newCentralStart = oldCentralStart + (insertionOffset <= oldCentralStart ? 1 : 0);
  changedView.setUint32(newEndOffset + 16, newCentralStart, true);
  for (const oldCentralOffset of oldCentralOffsets) {
    const oldLocalOffset = oldView.getUint32(oldCentralOffset + 42, true);
    const newCentralOffset = oldCentralOffset + (insertionOffset <= oldCentralOffset ? 1 : 0);
    const newLocalOffset = oldLocalOffset + (insertionOffset <= oldLocalOffset ? 1 : 0);
    changedView.setUint32(newCentralOffset + 42, newLocalOffset, true);
  }
  return changed;
}

function appendZipByte(archive: Uint8Array): Uint8Array {
  const changed = new Uint8Array(archive.byteLength + 1);
  changed.set(archive);
  changed[archive.byteLength] = 0x5a;
  return changed;
}

function appendDuplicateZipEnd(archive: Uint8Array): Uint8Array {
  const endOffset = zipEndOffset(archive);
  const endRecord = archive.subarray(endOffset);
  const changed = new Uint8Array(archive.byteLength + endRecord.byteLength);
  changed.set(archive);
  changed.set(endRecord, archive.byteLength);
  return changed;
}

function patchFirstLocalU16(
  archive: Uint8Array,
  fieldOffset: number,
  update: (value: number) => number,
): Uint8Array {
  const changed = new Uint8Array(archive);
  const view = new DataView(changed.buffer, changed.byteOffset, changed.byteLength);
  const centralOffset = zipCentralEntryOffsets(changed)[0];
  if (centralOffset === undefined) throw new Error("合成 ZIP 缺少目录项。");
  const localOffset = view.getUint32(centralOffset + 42, true);
  view.setUint16(
    localOffset + fieldOffset,
    update(view.getUint16(localOffset + fieldOffset, true)),
    true,
  );
  return changed;
}

function patchFirstLocalU32(
  archive: Uint8Array,
  fieldOffset: number,
  update: (value: number) => number,
): Uint8Array {
  const changed = new Uint8Array(archive);
  const view = new DataView(changed.buffer, changed.byteOffset, changed.byteLength);
  const centralOffset = zipCentralEntryOffsets(changed)[0];
  if (centralOffset === undefined) throw new Error("合成 ZIP 缺少目录项。");
  const localOffset = view.getUint32(centralOffset + 42, true);
  view.setUint32(
    localOffset + fieldOffset,
    update(view.getUint32(localOffset + fieldOffset, true)),
    true,
  );
  return changed;
}

function patchFirstCentralU32(
  archive: Uint8Array,
  fieldOffset: number,
  update: (value: number) => number,
): Uint8Array {
  const changed = new Uint8Array(archive);
  const view = new DataView(changed.buffer, changed.byteOffset, changed.byteLength);
  const centralOffset = zipCentralEntryOffsets(changed)[0];
  if (centralOffset === undefined) throw new Error("合成 ZIP 缺少目录项。");
  view.setUint32(
    centralOffset + fieldOffset,
    update(view.getUint32(centralOffset + fieldOffset, true)),
    true,
  );
  return changed;
}

function corruptFirstLocalZipName(archive: Uint8Array): Uint8Array {
  const changed = new Uint8Array(archive);
  const view = new DataView(changed.buffer, changed.byteOffset, changed.byteLength);
  const centralOffset = zipCentralEntryOffsets(changed)[0];
  if (centralOffset === undefined) throw new Error("合成 ZIP 缺少目录项。");
  const localOffset = view.getUint32(centralOffset + 42, true);
  if (view.getUint16(localOffset + 26, true) === 0) {
    throw new Error("合成 ZIP 缺少本地文件名。");
  }
  changed[localOffset + 30] = (changed[localOffset + 30] ?? 0) ^ 0x01;
  return changed;
}

function makeDataDescriptorZip(signed: boolean): Uint8Array {
  const name = new TextEncoder().encode("descriptor.md");
  const content = new TextEncoder().encode("synthetic descriptor content".repeat(8));
  const compressed = deflateRawSync(content);
  const checksum = crc32(content) >>> 0;
  const flags = 0x0808;
  const descriptor = new Uint8Array(signed ? 16 : 12);
  const descriptorView = new DataView(descriptor.buffer);
  const valuesOffset = signed ? 4 : 0;
  if (signed) descriptorView.setUint32(0, 0x08074b50, true);
  descriptorView.setUint32(valuesOffset, checksum, true);
  descriptorView.setUint32(valuesOffset + 4, compressed.byteLength, true);
  descriptorView.setUint32(valuesOffset + 8, content.byteLength, true);

  const local = new Uint8Array(30 + name.byteLength);
  const localView = new DataView(local.buffer);
  localView.setUint32(0, 0x04034b50, true);
  localView.setUint16(4, 20, true);
  localView.setUint16(6, flags, true);
  localView.setUint16(8, 8, true);
  localView.setUint16(26, name.byteLength, true);
  local.set(name, 30);

  const central = new Uint8Array(46 + name.byteLength);
  const centralView = new DataView(central.buffer);
  centralView.setUint32(0, 0x02014b50, true);
  centralView.setUint16(4, 0x0314, true);
  centralView.setUint16(6, 20, true);
  centralView.setUint16(8, flags, true);
  centralView.setUint16(10, 8, true);
  centralView.setUint32(16, checksum, true);
  centralView.setUint32(20, compressed.byteLength, true);
  centralView.setUint32(24, content.byteLength, true);
  centralView.setUint16(28, name.byteLength, true);
  centralView.setUint32(38, (0o100600 << 16) >>> 0, true);
  central.set(name, 46);

  const centralOffset = local.byteLength + compressed.byteLength + descriptor.byteLength;
  const end = new Uint8Array(22);
  const endView = new DataView(end.buffer);
  endView.setUint32(0, 0x06054b50, true);
  endView.setUint16(8, 1, true);
  endView.setUint16(10, 1, true);
  endView.setUint32(12, central.byteLength, true);
  endView.setUint32(16, centralOffset, true);
  return concatenateBytes([local, compressed, descriptor, central, end]);
}

function corruptZipDescriptor(archive: Uint8Array, signed: boolean): Uint8Array {
  const changed = new Uint8Array(archive);
  const view = new DataView(changed.buffer, changed.byteOffset, changed.byteLength);
  const centralOffset = zipCentralStart(changed);
  const localOffset = view.getUint32(centralOffset + 42, true);
  const nameLength = view.getUint16(localOffset + 26, true);
  const extraLength = view.getUint16(localOffset + 28, true);
  const compressedSize = view.getUint32(centralOffset + 20, true);
  const descriptorOffset = localOffset + 30 + nameLength + extraLength + compressedSize;
  const checksumOffset = descriptorOffset + (signed ? 4 : 0);
  changed[checksumOffset] = (changed[checksumOffset] ?? 0) ^ 0x01;
  return changed;
}

function addArchiveLevelZip64(archive: Uint8Array): Uint8Array {
  const endOffset = zipEndOffset(archive);
  const view = new DataView(archive.buffer, archive.byteOffset, archive.byteLength);
  const entryCount = view.getUint16(endOffset + 10, true);
  const centralSize = view.getUint32(endOffset + 12, true);
  const centralOffset = view.getUint32(endOffset + 16, true);
  const zip64End = new Uint8Array(56);
  const zip64EndView = new DataView(zip64End.buffer);
  zip64EndView.setUint32(0, 0x06064b50, true);
  zip64EndView.setBigUint64(4, 44n, true);
  zip64EndView.setUint16(12, 45, true);
  zip64EndView.setUint16(14, 45, true);
  zip64EndView.setBigUint64(24, BigInt(entryCount), true);
  zip64EndView.setBigUint64(32, BigInt(entryCount), true);
  zip64EndView.setBigUint64(40, BigInt(centralSize), true);
  zip64EndView.setBigUint64(48, BigInt(centralOffset), true);
  const locator = new Uint8Array(20);
  const locatorView = new DataView(locator.buffer);
  locatorView.setUint32(0, 0x07064b50, true);
  locatorView.setBigUint64(8, BigInt(endOffset), true);
  locatorView.setUint32(16, 1, true);
  const ordinaryEnd = new Uint8Array(archive.subarray(endOffset));
  const ordinaryView = new DataView(ordinaryEnd.buffer);
  ordinaryView.setUint16(8, 0xffff, true);
  ordinaryView.setUint16(10, 0xffff, true);
  ordinaryView.setUint32(12, 0xffffffff, true);
  ordinaryView.setUint32(16, 0xffffffff, true);
  return concatenateBytes([archive.subarray(0, endOffset), zip64End, locator, ordinaryEnd]);
}

function concatenateBytes(parts: readonly Uint8Array[]): Uint8Array {
  const output = new Uint8Array(parts.reduce((total, part) => total + part.byteLength, 0));
  let offset = 0;
  for (const part of parts) {
    output.set(part, offset);
    offset += part.byteLength;
  }
  return output;
}

function expectHistoryArchiveReason(callback: () => void, reason: string): void {
  let caught: unknown;
  try {
    callback();
  } catch (error) {
    caught = error;
  }
  expect(caught).toMatchObject({ reasons: [reason] });
}

function deterministicIncompressibleBytes(length: number): Uint8Array {
  const output = new Uint8Array(length);
  let offset = 0;
  let block = 0;
  while (offset < output.byteLength) {
    const digest = createHash("sha256").update(`urmotiv-history-archive-test-${block}`).digest();
    const remaining = output.byteLength - offset;
    output.set(digest.subarray(0, Math.min(remaining, digest.byteLength)), offset);
    offset += Math.min(remaining, digest.byteLength);
    block += 1;
  }
  return output;
}

function rewriteFirstZipPath(archive: Uint8Array, replacement: string): Uint8Array {
  return rewriteZipPath(archive, 0, replacement);
}

function rewriteZipPath(archive: Uint8Array, entryIndex: number, replacement: string): Uint8Array {
  const bytes = new Uint8Array(archive);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const centralOffset = zipCentralEntryOffsets(bytes)[entryIndex];
  if (centralOffset === undefined) {
    throw new Error("合成 ZIP 缺少要改写的目录项。");
  }
  const replacementBytes = new TextEncoder().encode(replacement);
  const nameLength = view.getUint16(centralOffset + 28, true);
  const localOffset = view.getUint32(centralOffset + 42, true);
  if (
    replacementBytes.byteLength !== nameLength ||
    view.getUint16(localOffset + 26, true) !== nameLength
  ) {
    throw new Error("合成 ZIP 路径改写必须保持相同字节长度。");
  }
  bytes.set(replacementBytes, centralOffset + 46);
  bytes.set(replacementBytes, localOffset + 30);
  return bytes;
}

function markFirstZipEntryAsSymlink(archive: Uint8Array): Uint8Array {
  const bytes = new Uint8Array(archive);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const centralOffset = zipCentralEntryOffsets(bytes)[0];
  if (centralOffset === undefined) {
    throw new Error("合成 ZIP 缺少目录项。");
  }
  view.setUint32(centralOffset + 38, (0o120777 << 16) >>> 0, true);
  return bytes;
}

function corruptFirstZipCrc(archive: Uint8Array): Uint8Array {
  const bytes = new Uint8Array(archive);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const centralOffset = zipCentralEntryOffsets(bytes)[0];
  if (centralOffset === undefined) {
    throw new Error("合成 ZIP 缺少目录项。");
  }
  const localOffset = view.getUint32(centralOffset + 42, true);
  const wrong = (view.getUint32(centralOffset + 16, true) + 1) >>> 0;
  view.setUint32(centralOffset + 16, wrong, true);
  view.setUint32(localOffset + 14, wrong, true);
  return bytes;
}

function markFirstZipEntryAsZip64(archive: Uint8Array): Uint8Array {
  const bytes = new Uint8Array(archive);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const centralOffset = zipCentralEntryOffsets(bytes)[0];
  if (centralOffset === undefined) {
    throw new Error("合成 ZIP 缺少目录项。");
  }
  view.setUint32(centralOffset + 24, 0xffffffff, true);
  return bytes;
}

function rewriteFirstZipUncompressedSize(archive: Uint8Array, declaredSize: number): Uint8Array {
  const bytes = new Uint8Array(archive);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const centralOffset = zipCentralEntryOffsets(bytes)[0];
  if (centralOffset === undefined) {
    throw new Error("合成 ZIP 缺少目录项。");
  }
  const localOffset = view.getUint32(centralOffset + 42, true);
  view.setUint32(centralOffset + 24, declaredSize, true);
  view.setUint32(localOffset + 22, declaredSize, true);
  return bytes;
}

function makeLegacyFilenameZip(): Uint8Array {
  const bytes = new Uint8Array(
    writeZipArchive([
      { path: "safe.txt", content: new TextEncoder().encode("synthetic legacy text") },
    ]),
  );
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const centralOffset = zipCentralEntryOffsets(bytes)[0];
  if (centralOffset === undefined) {
    throw new Error("合成 ZIP 缺少目录项。");
  }
  const localOffset = view.getUint32(centralOffset + 42, true);
  bytes[centralOffset + 46] = 0x82;
  bytes[localOffset + 30] = 0x82;
  view.setUint16(centralOffset + 8, view.getUint16(centralOffset + 8, true) & ~0x0800, true);
  view.setUint16(localOffset + 6, view.getUint16(localOffset + 6, true) & ~0x0800, true);
  return bytes;
}

function zipCentralEntryOffsets(bytes: Uint8Array): number[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let endOffset = -1;
  for (let offset = bytes.byteLength - 22; offset >= 0; offset -= 1) {
    if (view.getUint32(offset, true) === 0x06054b50) {
      endOffset = offset;
      break;
    }
  }
  if (endOffset < 0) {
    throw new Error("合成 ZIP 缺少结束目录记录。");
  }
  const entryCount = view.getUint16(endOffset + 10, true);
  let cursor = view.getUint32(endOffset + 16, true);
  const offsets: number[] = [];
  for (let index = 0; index < entryCount; index += 1) {
    if (view.getUint32(cursor, true) !== 0x02014b50) {
      throw new Error("合成 ZIP 中央目录格式不正确。");
    }
    offsets.push(cursor);
    cursor +=
      46 +
      view.getUint16(cursor + 28, true) +
      view.getUint16(cursor + 30, true) +
      view.getUint16(cursor + 32, true);
  }
  return offsets;
}
