import { afterEach, describe, expect, it } from "vitest";
import { lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { writeZipArchive } from "@urmotiv/problem-package";
import {
  inventoryHistorySources,
  materializeHistoryGrouping,
  sealHistoryGrouping,
  writeHistoryGroupingConfirmation,
  type HistoryGroupingPlan,
  type HistorySourceInventory,
  type HistorySourceLocations,
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
    });

    await writeHistoryGroupingConfirmation({
      privateRootDirectory: fixture.privateRoot,
      sourceInventoryFile: fixture.inventoryFile,
      metadataFile: fixture.metadataFile,
      groupingFile: sealed.groupingFile,
      outputFile: fixture.confirmationFile,
      confirmed: true,
    });
    const result = await materializeHistoryGrouping({
      privateRootDirectory: fixture.privateRoot,
      sourceDirectory: fixture.sourceDirectory,
      sourceInventoryFile: fixture.inventoryFile,
      sourceLocationsFile: fixture.locationsFile,
      metadataFile: fixture.metadataFile,
      groupingFile: sealed.groupingFile,
      groupingConfirmationFile: fixture.confirmationFile,
      outputDirectory: fixture.materializedDirectory,
    });

    expect(result).toEqual({
      sourceCount: 2,
      fragmentCount: 4,
      unreferencedSourceCount: 1,
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
    const grouping = JSON.parse(await readFile(fixture.groupingFile, "utf8")) as {
      groups: Array<{ fragmentIds: string[] }>;
    };
    grouping.groups[0]!.fragmentIds.reverse();
    await writeFile(fixture.groupingFile, `${JSON.stringify(grouping, null, 2)}\n`, "utf8");

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
        outputFile: join(fixture.privateRoot, "grouping.private.json"),
      }),
    ).rejects.toMatchObject({ code: "GROUPING_CHANGED" });
  });

  it("符号链接和伪装成 ZIP 的损坏文件都只返回固定安全错误", async () => {
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
    let brokenError: unknown;
    try {
      await inventoryHistorySources({
        privateRootDirectory: privateRoot,
        sourceDirectory: brokenSourceDirectory,
        outputDirectory: join(privateRoot, "broken-catalog"),
      });
    } catch (error) {
      brokenError = error;
    }
    expect(brokenError).toMatchObject({ code: "SOURCE_FILE_INVALID" });
    expect(String(brokenError)).not.toContain(brokenName);
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
          version: 1,
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
              metadataNumber: "metadata-1",
              fragmentIds: ["fragment-000001"],
            },
          ],
          sharingConfirmations: [],
        },
        null,
        2,
      )}\n`,
      "utf8",
    );
    const outputFile = join(fixture.privateRoot, "binary-grouping.private.json");

    await expect(
      sealHistoryGrouping({
        privateRootDirectory: fixture.privateRoot,
        sourceDirectory: fixture.sourceDirectory,
        sourceInventoryFile: fixture.inventoryFile,
        sourceLocationsFile: fixture.locationsFile,
        metadataFile: fixture.metadataFile,
        groupingPlanFile: planFile,
        outputFile,
      }),
    ).rejects.toMatchObject({ code: "SOURCE_FILE_INVALID" });
    await expect(lstat(outputFile)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("没有明确人工确认或输出目录已存在时拒绝继续", async () => {
    const fixture = await createCatalogFixture();
    const sealed = await sealFixture(fixture);
    await expect(
      writeHistoryGroupingConfirmation({
        privateRootDirectory: fixture.privateRoot,
        sourceInventoryFile: fixture.inventoryFile,
        metadataFile: fixture.metadataFile,
        groupingFile: sealed.groupingFile,
        outputFile: fixture.confirmationFile,
        confirmed: false,
      }),
    ).rejects.toMatchObject({ code: "INVALID_SOURCE_CONFIRMATION" });

    await writeHistoryGroupingConfirmation({
      privateRootDirectory: fixture.privateRoot,
      sourceInventoryFile: fixture.inventoryFile,
      metadataFile: fixture.metadataFile,
      groupingFile: sealed.groupingFile,
      outputFile: fixture.confirmationFile,
      confirmed: true,
    });
    await materializeHistoryGrouping(
      materializeOptions({
        ...fixture,
        groupingFile: sealed.groupingFile,
      }),
    );
    await expect(
      materializeHistoryGrouping(
        materializeOptions({
          ...fixture,
          groupingFile: sealed.groupingFile,
        }),
      ),
    ).rejects.toMatchObject({ code: "OUTPUT_ALREADY_EXISTS" });
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
  readonly groupingFile: string;
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
  readonly groupingFile: string;
  readonly result: Awaited<ReturnType<typeof sealHistoryGrouping>>;
}> {
  const groupingPlanFile = await writePlan(fixture);
  const groupingFile = join(fixture.privateRoot, "grouping.private.json");
  const result = await sealHistoryGrouping({
    privateRootDirectory: fixture.privateRoot,
    sourceDirectory: fixture.sourceDirectory,
    sourceInventoryFile: fixture.inventoryFile,
    sourceLocationsFile: fixture.locationsFile,
    metadataFile: fixture.metadataFile,
    groupingPlanFile,
    outputFile: groupingFile,
  });
  return { groupingFile, result };
}

async function createConfirmedFixture(): Promise<ConfirmedFixture> {
  const fixture = await createCatalogFixture();
  const sealed = await sealFixture(fixture);
  await writeHistoryGroupingConfirmation({
    privateRootDirectory: fixture.privateRoot,
    sourceInventoryFile: fixture.inventoryFile,
    metadataFile: fixture.metadataFile,
    groupingFile: sealed.groupingFile,
    outputFile: fixture.confirmationFile,
    confirmed: true,
  });
  return { ...fixture, groupingFile: sealed.groupingFile };
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
  expect(archiveLocation).toBeDefined();
  const archiveEntry = archiveLocation!.entries.find(
    (entry) => entry.entryPath === archiveEntryName,
  );
  expect(archiveEntry).toBeDefined();
  expect(inventory.sources.some((source) => source.sourceId === combinedSourceId)).toBe(true);

  const combined = `${alphaText}\n${betaText}`;
  const betaStart = combined.indexOf(betaText);
  const plan: HistoryGroupingPlan = {
    version: 1,
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
        sourceId: archiveLocation!.sourceId,
        selection: { kind: "zip_entry", entryId: archiveEntry!.entryId },
      },
    ],
    groups: [
      {
        groupId: "group-000001",
        metadataNumber: "metadata-1",
        fragmentIds: ["fragment-000001", "fragment-000002"],
      },
      {
        groupId: "group-000002",
        metadataNumber: "metadata-2",
        fragmentIds: ["fragment-000003", "fragment-000004"],
      },
    ],
    sharingConfirmations: [],
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
  expect(source).toBeDefined();
  return source!.sourceId;
}

function materializeOptions(fixture: ConfirmedFixture) {
  return {
    privateRootDirectory: fixture.privateRoot,
    sourceDirectory: fixture.sourceDirectory,
    sourceInventoryFile: fixture.inventoryFile,
    sourceLocationsFile: fixture.locationsFile,
    metadataFile: fixture.metadataFile,
    groupingFile: fixture.groupingFile,
    groupingConfirmationFile: fixture.confirmationFile,
    outputDirectory: fixture.materializedDirectory,
  };
}

async function expectPrivateMode(path: string, mode: number): Promise<void> {
  const metadata = await lstat(path);
  expect(metadata.mode & 0o777).toBe(mode);
}
