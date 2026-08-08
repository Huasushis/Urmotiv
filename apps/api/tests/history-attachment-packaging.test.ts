import { afterEach, describe, expect, it } from "vitest";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { readZipArchive, urmotivNativeAdapter, writeZipArchive } from "@urmotiv/problem-package";
import {
  assertHistoryAttachmentMappingComplete,
  initializeHistoryAttachmentMappingWorksheet,
  inventoryHistorySources,
  packageApprovedCandidates,
  prepareHistoryCandidates,
  sealHistoryAttachmentMapping,
  sealHistoryGrouping,
  sha256Hex,
  writeHistoryGroupingConfirmation,
  type HistoryAttachmentMappingCapability,
  type HistoryGroupingPlan,
  type HistoryNormalizer,
  type HistorySourceLocations,
  type NormalizedHistoryOutput,
  type PackageApprovedCandidatesResult,
} from "../src/history-migration/index";

const temporaryDirectories: string[] = [];
const syntheticSourceName = "synthetic-original-name.md";
const syntheticStudentId = "SYNTHETIC-STUDENT-001";
const syntheticMetadataTitle = "合成元数据题名";
const sourceText = "# 合成题目\n\n![示意图](images/fig1.png)\n\n正文内容。";
const encoder = new TextEncoder();

const fig1Bytes = new Uint8Array([1, 2, 3, 4, 5]);
const fig2Bytes = new Uint8Array([9, 8, 7, 6]);
const solutionBytes = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2d]);
const judgeBytes = new Uint8Array([10, 20, 30, 40, 50, 60]);
const notesText = "内部批改要点。";
const svgBytes = encoder.encode('<svg xmlns="http://www.w3.org/2000/svg"></svg>');
// .xlsx 本身是 ZIP 容器：作为不透明附件叶子进入题目包，验证嵌套容器放行。
const xlsxBytes = writeZipArchive([
  { path: "sheet1.xml", content: encoder.encode("<worksheet/>") },
]);

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("历史附件第二阶段打包", () => {
  it("按映射物化附件、改写题面引用并写入公开/内部/保全位置", async () => {
    const fixture = await createSealedFixture();
    const result = await fixture.package();
    expect(result).toEqual({
      packageCount: 1,
      authorMappingCount: 1,
      attachmentCount: 7,
      preservedMaterialCount: 1,
    });

    const idOf = (bytes: Uint8Array): string => {
      const id = fixture.attachmentIdBySha.get(sha256Hex(bytes));
      if (id === undefined) {
        throw new Error("合成附件缺少工作表安全编号。");
      }
      return id;
    };
    const judgeId = idOf(judgeBytes);

    const packagePath = join(fixture.packageOutput, "packages", "candidate-000001.zip");
    const archive = readZipArchive(new Uint8Array(await readFile(packagePath)), {
      allowNestedArchives: true,
    });
    const entries = new Map(archive.list().map((entry) => [entry.path, entry] as const));
    const statementBytes = archive.read("content/basic-statement.md");
    if (statementBytes === undefined) {
      throw new Error("题目包缺少题面正文。");
    }
    const statementText = new TextDecoder().decode(statementBytes);
    const assetName = `assets/${sha256Hex(fig1Bytes)}.png`;
    expect(statementText).toContain(assetName);
    expect(statementText).not.toContain("images/fig1.png");

    const statementAsset = archive.read(assetName);
    expect(statementAsset).toEqual(fig1Bytes);
    const publicContestant = archive.read(`attachments/public/${idOf(fig2Bytes)}.png`);
    expect(publicContestant).toEqual(fig2Bytes);
    const internalSolution = archive.read(`attachments/internal/${idOf(solutionBytes)}.pdf`);
    expect(internalSolution).toEqual(solutionBytes);
    const zipEntryInternal = archive.read(`attachments/internal/${idOf(svgBytes)}.svg`);
    expect(zipEntryInternal).toEqual(svgBytes);
    const textRangePublic = archive.read(
      `attachments/public/${idOf(encoder.encode(notesText))}.txt`,
    );
    expect(textRangePublic).toEqual(encoder.encode(notesText));
    // .xlsx 是 ZIP 容器，按不透明附件叶子原样进入包内。
    const xlsxPublic = archive.read(`attachments/public/${idOf(xlsxBytes)}.xlsx`);
    expect(xlsxPublic).toEqual(xlsxBytes);
    // 批次内部保全材料绝不进入题目包。
    for (const entry of entries.keys()) {
      expect(entry).not.toMatch(/^internal\//);
      expect(entry).not.toContain(judgeId);
      expect(entry).not.toContain("judge");
    }

    // 保全目录：0700 目录链 + 0600 文件，内容与摘要一致。
    const preservedPath = join(
      fixture.packageOutput,
      "internal",
      "preservation",
      "internal",
      `${judgeId}.bin`,
    );
    const preservedBytes = await readFile(preservedPath);
    expect(new Uint8Array(preservedBytes)).toEqual(judgeBytes);
    const preservedMode = (await stat(preservedPath)).mode & 0o777;
    expect(preservedMode).toBe(0o600);
    expect((await stat(join(fixture.packageOutput, "internal"))).mode & 0o777).toBe(0o700);
    expect((await stat(join(fixture.packageOutput, "internal", "preservation"))).mode & 0o777).toBe(
      0o700,
    );

    // 题目包能按原生格式重新导入，附件按类别落位。
    const imported = await urmotivNativeAdapter.import(archive, { conflictAction: "create" });
    expect(imported.extensions).toEqual({});
    expect(imported.provenance?.sourceSystem).toBe("ustc-history-private");

    // 报告与完成标记：附件计数、保全清单、逐包附件记录、整批摘要绑定。
    const reportText = await readFile(join(fixture.packageOutput, "report.json"), "utf8");
    expect(reportText).not.toContain(syntheticStudentId);
    expect(reportText).not.toContain(syntheticSourceName);
    expect(reportText).not.toContain(syntheticMetadataTitle);
    expect(reportText).not.toContain("judge-data.bin");
    const report = JSON.parse(reportText) as {
      batchSha256: string;
      attachmentCount: number;
      preservedMaterialCount: number;
      preservedMaterials: Array<{ attachmentId: string; preservationPath: string }>;
      packages: Array<{
        contentSha256: string;
        packageSha256: string;
        attachments: Array<{ attachmentId: string; targetPath: string }>;
      }>;
    };
    expect(report.attachmentCount).toBe(7);
    expect(report.preservedMaterialCount).toBe(1);
    expect(report.preservedMaterials[0]).toEqual({
      attachmentId: judgeId,
      contentSha256: sha256Hex(judgeBytes),
      semanticRole: "judge_material_candidate",
      preservationPath: `preservation/internal/${judgeId}.bin`,
    });
    const packageAttachments = report.packages[0]?.attachments ?? [];
    expect(new Set(packageAttachments.map((item) => item.attachmentId))).toEqual(
      new Set([
        idOf(fig1Bytes),
        idOf(fig2Bytes),
        idOf(solutionBytes),
        idOf(svgBytes),
        idOf(encoder.encode(notesText)),
        idOf(xlsxBytes),
      ]),
    );
    expect(packageAttachments.some((item) => item.targetPath === assetName)).toBe(true);
    expect(
      packageAttachments.some(
        (item) => item.targetPath === `attachments/internal/${idOf(solutionBytes)}.pdf`,
      ),
    ).toBe(true);

    const markerText = await readFile(join(fixture.packageOutput, "PACKAGE_COMPLETE"), "utf8");
    const marker = JSON.parse(markerText) as { batchSha256: string; attachmentCount: number };
    expect(marker.attachmentCount).toBe(7);
    expect(marker.batchSha256).toBe(report.batchSha256);

    const authorMapText = await readFile(fixture.authorMappingOutput, "utf8");
    expect(authorMapText).toContain(syntheticStudentId);
    const authorMap = JSON.parse(authorMapText) as {
      batchSha256: string;
      records: Array<{ contentSha256: string; packageSha256: string }>;
    };
    expect(authorMap.batchSha256).toBe(report.batchSha256);
    expect(authorMap.records[0]?.contentSha256).toBe(report.packages[0]?.contentSha256);
    expect(authorMap.records[0]?.packageSha256).toBe(report.packages[0]?.packageSha256);
  });

  it("封存后整文件附件字节变化时重新核对失败且不产生任何输出", async () => {
    const fixture = await createSealedFixture();
    await writeFile(
      join(fixture.gateSourceDirectory, "images", "fig1.png"),
      new Uint8Array([255, 254, 253]),
    );

    await expect(fixture.package()).rejects.toMatchObject({ code: "GROUPING_CHANGED" });
    await expect(stat(fixture.packageOutput)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(stat(fixture.authorMappingOutput)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("封存后压缩包附件字节变化时重新核对失败且不产生任何输出", async () => {
    const fixture = await createSealedFixture();
    await writeFile(
      join(fixture.gateSourceDirectory, "diagrams.zip"),
      writeZipArchive([
        {
          path: "statement-part.md",
          content: encoder.encode("只用于合成测试的压缩包正文。"),
        },
        { path: "fig3.svg", content: encoder.encode("<svg>CHANGED</svg>") },
      ]),
    );

    await expect(fixture.package()).rejects.toMatchObject({ code: "GROUPING_CHANGED" });
    await expect(stat(fixture.packageOutput)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(stat(fixture.authorMappingOutput)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("题面原引用不在候选题面中时拒绝改写且不产生任何输出", async () => {
    const fixture = await createSealedFixture({
      statementReferences: ["missing/not-in-statement.png"],
    });

    await expect(fixture.package()).rejects.toMatchObject({
      code: "INVALID_ATTACHMENT_MAPPING",
    });
    await expect(stat(fixture.packageOutput)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(stat(fixture.authorMappingOutput)).rejects.toMatchObject({ code: "ENOENT" });
  });
});

interface BaseFixture {
  readonly root: string;
  readonly packageOutput: string;
  readonly authorMappingOutput: string;
  readonly gateSourceDirectory: string;
  /** 附件内容摘要到工作表实际分配的安全编号。 */
  readonly attachmentIdBySha: ReadonlyMap<string, string>;
  readonly prepareOptions: {
    readonly privateRootDirectory: string;
    readonly sourceDirectory: string;
    readonly metadataFile: string;
    readonly sourceConfirmationFile: string;
    readonly outputDirectory: string;
    readonly approvalFile: string;
    readonly operationTag: string;
    readonly executionIdentity: {
      readonly version: 1;
      readonly codeSha256: string;
      readonly promptSha256: string;
      readonly modelSha256: string;
      readonly configSha256: string;
    };
  };
  readonly packageOptions: {
    readonly privateRootDirectory: string;
    readonly materializedDirectory: string;
    readonly metadataFile: string;
    readonly preparedDirectory: string;
    readonly approvalFile: string;
    readonly outputDirectory: string;
    readonly authorMappingOutput: string;
    readonly attachmentMappingCapability: HistoryAttachmentMappingCapability;
    readonly exportedAt: string;
  };
}

interface SealedFixture extends BaseFixture {
  readonly package: () => Promise<PackageApprovedCandidatesResult>;
}

async function createSealedFixture(options?: {
  readonly statementReferences?: string[];
}): Promise<SealedFixture> {
  const fixture = await createBaseFixture(options);
  await prepareHistoryCandidates({
    ...fixture.prepareOptions,
    normalizer: statementEmbeddingNormalizer(),
  });
  const candidate = JSON.parse(
    await readFile(
      join(fixture.prepareOptions.outputDirectory, "candidates", "candidate-000001.json"),
      "utf8",
    ),
  ) as { candidateId: string; contentSha256: string };
  await writeFile(
    fixture.prepareOptions.approvalFile,
    `${JSON.stringify(
      {
        version: 1,
        confirmed: true,
        approvals: [
          {
            candidateId: candidate.candidateId,
            contentSha256: candidate.contentSha256,
            decision: "approved",
          },
        ],
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  return {
    ...fixture,
    package: async () => packageApprovedCandidates(fixture.packageOptions),
  };
}

async function createBaseFixture(options?: {
  readonly statementReferences?: string[];
}): Promise<BaseFixture> {
  const root = await mkdtemp(join(tmpdir(), "urmotiv-attachment-packaging-"));
  temporaryDirectories.push(root);
  const materializedDirectory = join(root, "materialized");
  const sourceDirectory = join(materializedDirectory, "sources");
  await mkdir(materializedDirectory, { mode: 0o700 });
  await mkdir(sourceDirectory, { mode: 0o700 });
  await writeFile(join(sourceDirectory, syntheticSourceName), sourceText, "utf8");
  await chmod(join(sourceDirectory, syntheticSourceName), 0o600);

  const metadataFile = join(root, "metadata.private.json");
  const metadataRecord = {
    number: "synthetic-1",
    name: syntheticMetadataTitle,
    authorStudentId: syntheticStudentId,
    status: "",
    contest: "",
    note: "",
  };
  const metadataText = `${JSON.stringify({ records: [metadataRecord] }, null, 2)}\n`;
  await writeFile(metadataFile, metadataText, "utf8");

  const gateSourceDirectory = join(root, "attachment-gate-sources");
  await mkdir(gateSourceDirectory, { mode: 0o700 });
  await mkdir(join(gateSourceDirectory, "images"), { mode: 0o700 });
  await writeFile(join(gateSourceDirectory, syntheticSourceName), sourceText, "utf8");
  await writeFile(join(gateSourceDirectory, "images", "fig1.png"), fig1Bytes);
  await writeFile(join(gateSourceDirectory, "images", "fig2.png"), fig2Bytes);
  await writeFile(join(gateSourceDirectory, "original-solution.pdf"), solutionBytes);
  await writeFile(join(gateSourceDirectory, "judge-data.bin"), judgeBytes);
  await writeFile(join(gateSourceDirectory, "notes.txt"), notesText, "utf8");
  await writeFile(join(gateSourceDirectory, "report.xlsx"), xlsxBytes);
  await writeFile(
    join(gateSourceDirectory, "diagrams.zip"),
    writeZipArchive([
      {
        path: "statement-part.md",
        content: encoder.encode("只用于合成测试的压缩包正文。"),
      },
      { path: "fig3.svg", content: svgBytes },
    ]),
  );

  const catalogDirectory = join(root, "attachment-gate-catalog");
  await inventoryHistorySources({
    privateRootDirectory: root,
    sourceDirectory: gateSourceDirectory,
    outputDirectory: catalogDirectory,
  });
  const sourceInventoryFile = join(catalogDirectory, "inventory.json");
  const sourceLocationsFile = join(catalogDirectory, "source-locations.private.json");
  const locations = JSON.parse(
    await readFile(sourceLocationsFile, "utf8"),
  ) as HistorySourceLocations;

  const findSource = (sourcePath: string) =>
    locations.sources.find((item) => item.sourcePath === sourcePath);
  const mdSource = findSource(syntheticSourceName);
  const notesSource = findSource("notes.txt");
  const zipSource = findSource("diagrams.zip");
  if (mdSource === undefined || notesSource === undefined || zipSource === undefined) {
    throw new Error("合成附件完成门缺少登记源。");
  }
  const svgEntry = zipSource.entries.find(
    (entry) => entry.entryPathChain.length === 1 && entry.entryPathChain[0] === "fig3.svg",
  );
  const statementEntry = zipSource.entries.find(
    (entry) =>
      entry.entryPathChain.length === 1 && entry.entryPathChain[0] === "statement-part.md",
  );
  if (svgEntry === undefined || statementEntry === undefined) {
    throw new Error("合成附件完成门压缩包缺少条目。");
  }

  const groupingPlan: HistoryGroupingPlan = {
    version: 2,
    fragments: [
      {
        fragmentId: "fragment-000001",
        sourceId: mdSource.sourceId,
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
    metadataDispositions: [],
    zipEntryDispositions: [
      {
        sourceId: zipSource.sourceId,
        entryId: svgEntry.entryId,
        action: "attachment",
        reason: "人工确认合成示意图需要随题打包。",
        confirmed: true,
      },
      {
        sourceId: zipSource.sourceId,
        entryId: statementEntry.entryId,
        action: "ignored",
        reason: "合成压缩包内重复文本条目。",
        confirmed: true,
      },
    ],
    textRangeDispositions: [
      {
        sourceId: notesSource.sourceId,
        start: 0,
        end: notesText.length,
        action: "attachment",
        reason: "人工确认内部批改要点需要随题保留。",
        confirmed: true,
      },
    ],
    manualSourceDispositions: [
      "images/fig1.png",
      "images/fig2.png",
      "original-solution.pdf",
      "judge-data.bin",
      "report.xlsx",
    ].map((sourcePath) => {
      const source = findSource(sourcePath);
      if (source === undefined) {
        throw new Error("合成附件完成门缺少人工源。");
      }
      return {
        sourceId: source.sourceId,
        action: "attachment" as const,
        reason: "人工确认合成附件需要保留。",
        confirmed: true,
      };
    }),
  };
  const groupingPlanFile = join(root, "attachment-gate-grouping-plan.private.json");
  await writeFile(groupingPlanFile, `${JSON.stringify(groupingPlan, null, 2)}\n`, "utf8");
  await chmod(groupingPlanFile, 0o600);
  const groupingDirectory = join(root, "attachment-gate-grouping");
  await sealHistoryGrouping({
    privateRootDirectory: root,
    sourceDirectory: gateSourceDirectory,
    sourceInventoryFile,
    sourceLocationsFile,
    metadataFile,
    groupingPlanFile,
    outputDirectory: groupingDirectory,
  });
  const groupingConfirmationFile = join(
    root,
    "attachment-gate-grouping-confirmation.private.json",
  );
  await writeHistoryGroupingConfirmation({
    privateRootDirectory: root,
    sourceInventoryFile,
    sourceLocationsFile,
    metadataFile,
    groupingDirectory,
    outputFile: groupingConfirmationFile,
    confirmed: true,
  });
  const contextOptions = {
    privateRootDirectory: root,
    sourceDirectory: gateSourceDirectory,
    sourceInventoryFile,
    sourceLocationsFile,
    metadataFile,
    groupingDirectory,
    groupingConfirmationFile,
  };
  const worksheetDirectory = join(root, "attachment-gate-worksheet");
  await initializeHistoryAttachmentMappingWorksheet({
    ...contextOptions,
    outputDirectory: worksheetDirectory,
  });
  const worksheet = JSON.parse(
    await readFile(join(worksheetDirectory, "attachment-worksheet.json"), "utf8"),
  ) as {
    attachments: Array<{
      attachmentId: string;
      sourceBindingSha256: string;
      contentSha256: string;
    }>;
  };
  expect(worksheet.attachments.length).toBe(7);

  // 按工作表逐项给出人工计划：内容摘要决定语义角色与目标，目标名按工作表
  // 实际分配的附件安全编号构造。
  const roleBySha = new Map<
    string,
    {
      readonly semanticRole: string;
      readonly visibility: "public" | "internal";
      readonly extension: string;
      readonly statementReferences?: readonly string[];
    }
  >();
  roleBySha.set(sha256Hex(fig1Bytes), {
    semanticRole: "statement_asset",
    visibility: "public",
    extension: "png",
    statementReferences: options?.statementReferences ?? ["images/fig1.png"],
  });
  roleBySha.set(sha256Hex(fig2Bytes), {
    semanticRole: "contestant_attachment",
    visibility: "public",
    extension: "png",
  });
  roleBySha.set(sha256Hex(solutionBytes), {
    semanticRole: "solution_original",
    visibility: "internal",
    extension: "pdf",
  });
  roleBySha.set(sha256Hex(judgeBytes), {
    semanticRole: "judge_material_candidate",
    visibility: "internal",
    extension: "bin",
  });
  roleBySha.set(sha256Hex(svgBytes), {
    semanticRole: "reference_implementation_candidate",
    visibility: "internal",
    extension: "svg",
  });
  roleBySha.set(sha256Hex(encoder.encode(notesText)), {
    semanticRole: "contestant_attachment",
    visibility: "public",
    extension: "txt",
  });
  roleBySha.set(sha256Hex(xlsxBytes), {
    semanticRole: "contestant_attachment",
    visibility: "public",
    extension: "xlsx",
  });

  const attachmentIdBySha = new Map<string, string>();
  const mappings = worksheet.attachments.map((item) => {
    const spec = roleBySha.get(item.contentSha256);
    if (spec === undefined) {
      throw new Error(`合成附件工作表缺少 ${item.contentSha256} 的计划。`);
    }
    attachmentIdBySha.set(item.contentSha256, item.attachmentId);
    const targetName =
      spec.semanticRole === "statement_asset"
        ? `${item.contentSha256}.${spec.extension}`
        : `${item.attachmentId}.${spec.extension}`;
    return {
      attachmentId: item.attachmentId,
      sourceBindingSha256: item.sourceBindingSha256,
      status: "resolved" as const,
      semanticRole: spec.semanticRole,
      visibility: spec.visibility,
      scope:
        spec.semanticRole === "judge_material_candidate"
          ? {
              kind: "batch_internal" as const,
              targetName,
            }
          : {
              kind: "problem_groups" as const,
              targets: [
                {
                  groupId: "group-000001",
                  metadataId: "metadata-000001",
                  targetName,
                  ...(spec.statementReferences === undefined
                    ? {}
                    : { statementReferences: spec.statementReferences }),
                },
              ],
            },
      reviewNote: "人工确认合成附件目标。",
      confirmed: true,
    };
  });
  const mappingPlanFile = join(root, "attachment-gate-plan.private.json");
  await writeFile(
    mappingPlanFile,
    `${JSON.stringify(
      {
        version: 1,
        confirmed: true,
        worksheetSha256: sha256Hex(JSON.stringify(worksheet)),
        mappings,
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  await chmod(mappingPlanFile, 0o600);
  const attachmentMappingDirectory = join(root, "attachment-gate-mapping");
  await sealHistoryAttachmentMapping({
    ...contextOptions,
    worksheetDirectory,
    mappingPlanFile,
    outputDirectory: attachmentMappingDirectory,
  });
  const attachmentMappingCapability = await assertHistoryAttachmentMappingComplete({
    ...contextOptions,
    attachmentMappingDirectory,
  });
  expect(attachmentMappingCapability.attachmentCount).toBe(7);

  // 合成物化报告：只含进入候选的确认源，分组批次摘要与附件能力一致。
  const sourceConfirmationFile = join(materializedDirectory, "source-confirmation.private.json");
  const sourceSha256 = sha256Hex(sourceText);
  const byteLength = new TextEncoder().encode(sourceText).byteLength;
  const sourceConfirmation = {
    version: 1,
    confirmed: true,
    metadataFileSha256: sha256Hex(metadataText),
    mappings: [
      {
        sourcePath: syntheticSourceName,
        sourceSha256,
        metadataNumber: "synthetic-1",
      },
    ],
  };
  const report = {
    version: 2,
    phase: "materialize",
    sourceInventorySha256: "e".repeat(64),
    groupingBatchSha256: attachmentMappingCapability.groupingBatchSha256,
    fragmentCount: 1,
    sourceCount: 1,
    unresolvedItemCount: 0,
    sources: [
      {
        groupId: "group-000001",
        sourceId: "source-000001",
        sourceSha256,
        fragmentCount: 1,
        byteLength,
        characterCount: sourceText.length,
        status: "ready_for_prepare",
      },
    ],
  };
  const marker = {
    version: 2,
    phase: "materialize",
    reportSha256: sha256Hex(JSON.stringify(report)),
    sourceConfirmationSha256: sha256Hex(JSON.stringify(sourceConfirmation)),
    sourceSetSha256: sha256Hex(
      JSON.stringify({
        version: 1,
        sources: [{ sourceId: "source-000001", sourceSha256, byteLength }],
      }),
    ),
    groupingBatchSha256: attachmentMappingCapability.groupingBatchSha256,
    sourceCount: 1,
    fragmentCount: 1,
    unresolvedItemCount: 0,
  };
  await writeFile(
    sourceConfirmationFile,
    `${JSON.stringify(sourceConfirmation, null, 2)}\n`,
    "utf8",
  );
  await writeFile(
    join(materializedDirectory, "report.json"),
    `${JSON.stringify(report, null, 2)}\n`,
    "utf8",
  );
  await writeFile(
    join(materializedDirectory, "MATERIALIZE_COMPLETE"),
    `${JSON.stringify(marker, null, 2)}\n`,
    "utf8",
  );
  await chmod(sourceConfirmationFile, 0o600);
  await chmod(join(materializedDirectory, "report.json"), 0o600);
  await chmod(join(materializedDirectory, "MATERIALIZE_COMPLETE"), 0o600);

  const prepareOutput = join(root, "prepared");
  const approvalFile = join(root, "candidate-approval.private.json");
  const packageOutput = join(root, "packaged");
  const authorMappingOutput = join(root, "author-map.private.json");
  const prepareOptions = {
    privateRootDirectory: root,
    sourceDirectory,
    metadataFile,
    sourceConfirmationFile,
    outputDirectory: prepareOutput,
    approvalFile,
    operationTag: "synthetic-run-001",
    executionIdentity: {
      version: 1 as const,
      codeSha256: "1".repeat(64),
      promptSha256: "2".repeat(64),
      modelSha256: "3".repeat(64),
      configSha256: "4".repeat(64),
    },
  };
  const packageOptions = {
    privateRootDirectory: root,
    materializedDirectory,
    metadataFile,
    preparedDirectory: prepareOutput,
    approvalFile,
    outputDirectory: packageOutput,
    authorMappingOutput,
    attachmentMappingCapability,
    exportedAt: "2026-07-30T00:00:00.000Z",
  };
  return {
    root,
    packageOutput,
    authorMappingOutput,
    gateSourceDirectory,
    attachmentIdBySha,
    prepareOptions,
    packageOptions,
  };
}

function statementEmbeddingNormalizer(): HistoryNormalizer {
  return {
    async normalize() {
      return {
        problems: [normalizedProblemWithStatement(sourceText)],
      };
    },
  };
}

function normalizedProblemWithStatement(
  embeddedSourceText: string,
): NormalizedHistoryOutput["problems"][number] {
  return {
    title: "合成候选题",
    type: "traditional",
    basicStatement: `题面正文：\n\n${embeddedSourceText}`,
    basicSolution: "合成候选题解。",
    background: "",
    statement: "",
    inputFormat: "",
    outputFormat: "",
    constraints: "",
    solution: "",
    hints: "",
    samples: [],
    tags: [],
    confidence: 0.9,
    migrationNote: "合成测试备注。",
  };
}
