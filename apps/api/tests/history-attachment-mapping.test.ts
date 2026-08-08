import { createHash } from "node:crypto";
import {
  chown,
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeZipArchive } from "@urmotiv/problem-package";
import { afterEach, describe, expect, it } from "vitest";
import {
  assertHistoryAttachmentMappingComplete,
  type HistoryGroupingPlan,
  type HistorySourceLocations,
  initializeHistoryAttachmentMappingWorksheet,
  inventoryHistorySources,
  sealHistoryAttachmentMapping,
  sealHistoryGrouping,
  writeHistoryGroupingConfirmation,
} from "../src/history-migration/index";
import {
  withNewStablePrivateDirectoryAccess,
  withStablePrivateDirectoryAccess,
  withStablePrivateJsonFile,
} from "../src/history-migration/private-files";

const temporaryDirectories: string[] = [];
const encoder = new TextEncoder();
const statementText = "SYNTHETIC ATTACHMENT MAPPING STATEMENT";
const trailingText = "\nSYNTHETIC AUTHOR NOTE";
const firstImagePath = "statement/diagram-one.png";
const duplicateImagePath = "statement/diagram-two.png";
const guidePath = "downloads/guide.txt";
const imageBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4]);
const solutionPdfBytes = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37]);
const canTestForeignOwner = typeof process.geteuid === "function" && process.geteuid() === 0;

async function waitForCtimeTick(): Promise<void> {
  // 当前测试文件系统会把极短间隔内的 ctime 合并到同一时钟刻度。
  await new Promise<void>((resolve) => setTimeout(resolve, 5));
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("历史附件严格人工映射", () => {
  it("新建目录拒绝 mkdir 身份快照后、取得 dirfd 前的同用户替换和权限恢复", async () => {
    const privateRoot = await mkdtemp(join(tmpdir(), "urmotiv-history-attachment-create-race-"));
    temporaryDirectories.push(privateRoot);
    const replacedOutput = join(privateRoot, "replaced-output");
    const displacedOutput = join(privateRoot, "displaced-output");
    let replacementOperationRan = false;

    await expect(
      withNewStablePrivateDirectoryAccess(
        replacedOutput,
        async () => {
          replacementOperationRan = true;
        },
        {
          afterCreatedDirectoryIdentityCaptured: async () => {
            await rename(replacedOutput, displacedOutput);
            await mkdir(replacedOutput, { mode: 0o700 });
          },
        },
      ),
    ).rejects.toMatchObject({ code: "ATTACHMENT_MAPPING_CHANGED" });
    expect(replacementOperationRan).toBe(false);

    const chmodOutput = join(privateRoot, "chmod-output");
    let chmodOperationRan = false;
    await expect(
      withNewStablePrivateDirectoryAccess(
        chmodOutput,
        async () => {
          chmodOperationRan = true;
        },
        {
          afterCreatedDirectoryIdentityCaptured: async () => {
            await waitForCtimeTick();
            await chmod(chmodOutput, 0o755);
            await chmod(chmodOutput, 0o700);
          },
        },
      ),
    ).rejects.toMatchObject({ code: "ATTACHMENT_MAPPING_CHANGED" });
    expect(chmodOperationRan).toBe(false);
  });

  it("新建目录从 mkdir 起固定 dirfd，并拒绝公开路径随后被替换", async () => {
    const privateRoot = await mkdtemp(join(tmpdir(), "urmotiv-history-attachment-create-fd-"));
    temporaryDirectories.push(privateRoot);
    const outputDirectory = join(privateRoot, "new-output");
    const displacedDirectory = join(privateRoot, "displaced-output");

    await expect(
      withNewStablePrivateDirectoryAccess(outputDirectory, async (directory) => {
        await rename(outputDirectory, displacedDirectory);
        await mkdir(outputDirectory, { mode: 0o700 });
        await directory.writeNewFile("state.json", '{"written":"through-original-fd"}\n');
        expect(await directory.readJson("state.json")).toEqual({
          written: "through-original-fd",
        });
      }),
    ).rejects.toMatchObject({ code: "ATTACHMENT_MAPPING_CHANGED" });
    await expect(lstat(join(outputDirectory, "state.json"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(readFile(join(displacedDirectory, "state.json"), "utf8")).resolves.toContain(
      "through-original-fd",
    );
  });

  it("核对期间固定同一个目录句柄并拒绝路径被替换", async () => {
    const privateRoot = await mkdtemp(join(tmpdir(), "urmotiv-history-attachment-dirfd-"));
    temporaryDirectories.push(privateRoot);
    const inspectedDirectory = join(privateRoot, "inspected");
    const displacedDirectory = join(privateRoot, "displaced");
    await mkdir(inspectedDirectory, { mode: 0o700 });
    await writeFile(join(inspectedDirectory, "state.json"), '{"identity":"original"}\n', {
      mode: 0o600,
    });

    await expect(
      withStablePrivateDirectoryAccess(inspectedDirectory, async (directory) => {
        await directory.assertDirectoryMode();
        await directory.assertFileMode("state.json");
        expect(await directory.readJson("state.json")).toEqual({ identity: "original" });
        await rename(inspectedDirectory, displacedDirectory);
        await mkdir(inspectedDirectory, { mode: 0o700 });
        await writeFile(join(inspectedDirectory, "state.json"), '{"identity":"replacement"}\n', {
          mode: 0o600,
        });
        expect(await directory.readJson("state.json")).toEqual({ identity: "original" });
      }),
    ).rejects.toMatchObject({ code: "ATTACHMENT_MAPPING_CHANGED" });
  });

  it("拒绝目录权限保持或恢复，以及文件权限变化", async () => {
    const privateRoot = await mkdtemp(join(tmpdir(), "urmotiv-history-attachment-mode-"));
    temporaryDirectories.push(privateRoot);
    const inspectedDirectory = join(privateRoot, "inspected");
    const stateFile = join(inspectedDirectory, "state.json");
    await mkdir(inspectedDirectory, { mode: 0o700 });
    await writeFile(stateFile, '{"stable":true}\n', { mode: 0o600 });

    await chmod(inspectedDirectory, 0o755);
    await expect(
      withStablePrivateDirectoryAccess(inspectedDirectory, async (directory) =>
        directory.readJson("state.json"),
      ),
    ).rejects.toMatchObject({ code: "PREPARE_RESUME_UNSAFE" });
    await chmod(inspectedDirectory, 0o700);

    await expect(
      withStablePrivateDirectoryAccess(inspectedDirectory, async (directory) => {
        expect(await directory.readJson("state.json")).toEqual({ stable: true });
        await waitForCtimeTick();
        await chmod(inspectedDirectory, 0o755);
        await chmod(inspectedDirectory, 0o700);
      }),
    ).rejects.toMatchObject({ code: "ATTACHMENT_MAPPING_CHANGED" });

    await expect(
      withStablePrivateDirectoryAccess(inspectedDirectory, async (directory) => {
        expect(await directory.readJson("state.json")).toEqual({ stable: true });
        await waitForCtimeTick();
        await chmod(stateFile, 0o644);
        await chmod(stateFile, 0o600);
        await directory.readJson("state.json");
      }),
    ).rejects.toMatchObject({ code: "ATTACHMENT_MAPPING_CHANGED" });

    await chmod(stateFile, 0o644);
    await expect(
      withStablePrivateDirectoryAccess(inspectedDirectory, async (directory) =>
        directory.readJson("state.json"),
      ),
    ).rejects.toMatchObject({ code: "PREPARE_RESUME_UNSAFE" });
  });

  it("人工映射计划固定单一文件句柄并拒绝同用户路径替换和 chmod 恢复", async () => {
    const privateRoot = await mkdtemp(join(tmpdir(), "urmotiv-history-attachment-plan-fd-"));
    temporaryDirectories.push(privateRoot);
    const planFile = join(privateRoot, "plan.private.json");
    const displacedPlanFile = join(privateRoot, "plan.displaced.private.json");
    const planContent = '{"confirmed":true}\n';
    await writeFile(planFile, planContent, { mode: 0o600 });

    await expect(
      withStablePrivateJsonFile(planFile, async (input) => {
        expect(input.value).toEqual({ confirmed: true });
        await rename(planFile, displacedPlanFile);
        await writeFile(planFile, planContent, { mode: 0o600 });
      }),
    ).rejects.toMatchObject({ code: "ATTACHMENT_MAPPING_CHANGED" });

    const chmodPlanFile = join(privateRoot, "plan-chmod.private.json");
    await writeFile(chmodPlanFile, planContent, { mode: 0o600 });
    await expect(
      withStablePrivateJsonFile(chmodPlanFile, async () => {
        await waitForCtimeTick();
        await chmod(chmodPlanFile, 0o644);
        await chmod(chmodPlanFile, 0o600);
      }),
    ).rejects.toMatchObject({ code: "ATTACHMENT_MAPPING_CHANGED" });
  });

  it.skipIf(!canTestForeignOwner)("拒绝不属于当前 euid 的目录和文件", async () => {
    const privateRoot = await mkdtemp(join(tmpdir(), "urmotiv-history-attachment-owner-"));
    temporaryDirectories.push(privateRoot);

    const foreignDirectory = join(privateRoot, "foreign-directory");
    await mkdir(foreignDirectory, { mode: 0o700 });
    await writeFile(join(foreignDirectory, "state.json"), '{"stable":true}\n', {
      mode: 0o600,
    });
    await chown(foreignDirectory, 65_534, 65_534);
    await expect(
      withStablePrivateDirectoryAccess(foreignDirectory, async (directory) =>
        directory.readJson("state.json"),
      ),
    ).rejects.toMatchObject({ code: "PREPARE_RESUME_UNSAFE" });

    const foreignFileDirectory = join(privateRoot, "foreign-file");
    const foreignFile = join(foreignFileDirectory, "state.json");
    await mkdir(foreignFileDirectory, { mode: 0o700 });
    await writeFile(foreignFile, '{"stable":true}\n', { mode: 0o600 });
    await chown(foreignFile, 65_534, 65_534);
    await expect(
      withStablePrivateDirectoryAccess(foreignFileDirectory, async (directory) =>
        directory.readJson("state.json"),
      ),
    ).rejects.toMatchObject({ code: "PREPARE_RESUME_UNSAFE" });
  });

  it("绑定既有摘要，生成摘要资源名、引用改写和题解原件语义", async () => {
    const fixture = await createAttachmentFixture();
    const plan = await completePlan(fixture);
    const planFile = await writePlan(fixture.privateRoot, "attachment-plan.complete.json", plan);
    const mappingDirectory = join(fixture.privateRoot, "attachment-mapping-complete");

    await expect(
      sealHistoryAttachmentMapping({
        ...fixture.contextOptions,
        worksheetDirectory: fixture.worksheetDirectory,
        mappingPlanFile: planFile,
        outputDirectory: mappingDirectory,
      }),
    ).resolves.toEqual({
      attachmentCount: 5,
      resolvedItemCount: 5,
      unresolvedItemCount: 0,
      complete: true,
    });

    const capability = await assertHistoryAttachmentMappingComplete({
      ...fixture.contextOptions,
      attachmentMappingDirectory: mappingDirectory,
    });
    const verified = capability.mapping;
    expect(verified.referenceRewrites).toEqual([
      {
        groupId: "group-000001",
        metadataId: "metadata-000001",
        from: firstImagePath,
        to: `assets/${digest(imageBytes)}.png`,
      },
      {
        groupId: "group-000002",
        metadataId: "metadata-000002",
        from: "second/diagram.png",
        to: `assets/${digest(imageBytes)}.png`,
      },
    ]);
    expect(verified.mappings).toContainEqual(
      expect.objectContaining({
        semanticRole: "solution_original",
        visibility: "internal",
        scope: {
          kind: "problem_groups",
          targets: [
            expect.objectContaining({
              groupId: "group-000001",
              targetPath: expect.stringMatching(
                /^attachments\/internal\/attachment-[0-9]{6}\.PDF$/,
              ),
            }),
          ],
        },
      }),
    );
    expect(verified.preservationEntries).toEqual([
      expect.objectContaining({
        semanticRole: "authoring_material",
        preservationPath: expect.stringMatching(
          /^preservation\/internal\/attachment-[0-9]{6}\.txt$/,
        ),
      }),
    ]);
    expect(JSON.stringify(verified)).not.toContain("solutions/std");
    expect(JSON.stringify(verified)).not.toContain("standard_solution");

    await expectMode(mappingDirectory, 0o700);
    await expectMode(join(mappingDirectory, "attachment-mapping.private.json"), 0o600);
    await expectMode(join(mappingDirectory, "report.json"), 0o600);
    await expectMode(join(mappingDirectory, "ATTACHMENT_MAPPING_COMPLETE"), 0o600);
    if (typeof process.geteuid !== "function") {
      throw new Error("合成附件权限测试必须运行在 Linux 服务器。");
    }
    const expectedUid = process.geteuid();
    expect((await lstat(mappingDirectory)).uid).toBe(expectedUid);
    expect((await lstat(join(mappingDirectory, "attachment-mapping.private.json"))).uid).toBe(
      expectedUid,
    );
    expect((await lstat(join(mappingDirectory, "ATTACHMENT_MAPPING_COMPLETE"))).uid).toBe(
      expectedUid,
    );
    await expect(
      lstat(join(mappingDirectory, ".attachment-mapping-incomplete")),
    ).rejects.toMatchObject({ code: "ENOENT" });
    await expect(lstat(join(mappingDirectory, "ATTACHMENT_MAPPING_BLOCKED"))).rejects.toMatchObject(
      { code: "ENOENT" },
    );

    await expect(
      sealHistoryAttachmentMapping({
        ...fixture.contextOptions,
        worksheetDirectory: fixture.worksheetDirectory,
        mappingPlanFile: planFile,
        outputDirectory: mappingDirectory,
      }),
    ).rejects.toMatchObject({ code: "OUTPUT_ALREADY_EXISTS" });
    await expect(
      initializeHistoryAttachmentMappingWorksheet({
        ...fixture.contextOptions,
        outputDirectory: fixture.worksheetDirectory,
      }),
    ).rejects.toMatchObject({ code: "OUTPUT_ALREADY_EXISTS" });

    await writeFile(
      join(mappingDirectory, "ATTACHMENT_MAPPING_BLOCKED"),
      `${JSON.stringify({ status: "blocked" })}\n`,
      "utf8",
    );
    await chmod(join(mappingDirectory, "ATTACHMENT_MAPPING_BLOCKED"), 0o600);
    await expect(
      assertHistoryAttachmentMappingComplete({
        ...fixture.contextOptions,
        attachmentMappingDirectory: mappingDirectory,
      }),
    ).rejects.toMatchObject({ code: "ATTACHMENT_MAPPING_CHANGED" });
  });

  it("显式保留 unresolved 并写 BLOCKED；缺项不能借此消失", async () => {
    const fixture = await createAttachmentFixture();
    const complete = await completePlan(fixture);
    const blocked = structuredClone(complete);
    const unresolved = blocked.mappings.at(-1);
    if (unresolved === undefined) throw new Error("合成附件映射为空。");
    blocked.mappings[blocked.mappings.length - 1] = {
      attachmentId: unresolved.attachmentId,
      sourceBindingSha256: unresolved.sourceBindingSha256,
      status: "unresolved",
      reason: "人工尚不能确定这个合成附件的用途。",
      confirmed: true,
    };
    const blockedPlan = await writePlan(
      fixture.privateRoot,
      "attachment-plan.blocked.json",
      blocked,
    );
    const blockedDirectory = join(fixture.privateRoot, "attachment-mapping-blocked");

    await expect(
      sealHistoryAttachmentMapping({
        ...fixture.contextOptions,
        worksheetDirectory: fixture.worksheetDirectory,
        mappingPlanFile: blockedPlan,
        outputDirectory: blockedDirectory,
      }),
    ).rejects.toMatchObject({ code: "ATTACHMENT_MAPPING_INCOMPLETE" });
    const saved = JSON.parse(
      await readFile(join(blockedDirectory, "attachment-mapping.private.json"), "utf8"),
    ) as { mappings: unknown[]; unresolvedItemCount: number; status: string };
    expect(saved).toMatchObject({
      status: "blocked",
      unresolvedItemCount: 1,
    });
    expect(saved.mappings).toHaveLength(5);
    await expectMode(join(blockedDirectory, "ATTACHMENT_MAPPING_BLOCKED"), 0o600);
    await expect(
      lstat(join(blockedDirectory, "ATTACHMENT_MAPPING_COMPLETE")),
    ).rejects.toMatchObject({ code: "ENOENT" });
    await expect(
      assertHistoryAttachmentMappingComplete({
        ...fixture.contextOptions,
        attachmentMappingDirectory: blockedDirectory,
      }),
    ).rejects.toMatchObject({ code: "ATTACHMENT_MAPPING_INCOMPLETE" });

    const omitted = structuredClone(complete);
    omitted.mappings.pop();
    const omittedPlan = await writePlan(
      fixture.privateRoot,
      "attachment-plan.omitted.json",
      omitted,
    );
    const omittedOutput = join(fixture.privateRoot, "attachment-mapping-omitted");
    await expect(
      sealHistoryAttachmentMapping({
        ...fixture.contextOptions,
        worksheetDirectory: fixture.worksheetDirectory,
        mappingPlanFile: omittedPlan,
        outputDirectory: omittedOutput,
      }),
    ).rejects.toMatchObject({ code: "INVALID_ATTACHMENT_MAPPING" });
    await expect(lstat(omittedOutput)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("拒绝路径跳出、题面引用跳出以及重复摘要资源目标", async () => {
    const fixture = await createAttachmentFixture();
    const unsafeTarget = await completePlan(fixture);
    const publicAttachment = unsafeTarget.mappings.find(
      (mapping) =>
        mapping.status === "resolved" && mapping.semanticRole === "contestant_attachment",
    );
    if (publicAttachment === undefined || publicAttachment.status !== "resolved") {
      throw new Error("合成公开附件不存在。");
    }
    firstProblemTarget(publicAttachment).targetName = "../escape.txt";
    await expectInvalidPlan(fixture, unsafeTarget, "unsafe-target");

    const unsafeReference = await completePlan(fixture);
    const statementAsset = statementAssetIn(unsafeReference);
    const statementTarget = statementAsset.scope.targets[0];
    if (statementTarget === undefined) throw new Error("合成题面资源目标不存在。");
    statementTarget.statementReferences = ["../escape.png"];
    await expectInvalidPlan(fixture, unsafeReference, "unsafe-reference");

    const duplicateTarget = await completePlan(fixture);
    const first = statementAssetIn(duplicateTarget);
    const duplicateImage = duplicateTarget.mappings.find(
      (mapping) =>
        mapping.status === "resolved" &&
        mapping.attachmentId !== first.attachmentId &&
        fixture.imageAttachmentIds.includes(mapping.attachmentId),
    );
    if (duplicateImage === undefined || duplicateImage.status !== "resolved") {
      throw new Error("合成重复图片附件不存在。");
    }
    const firstTargetName = first.scope.targets[0]?.targetName;
    if (firstTargetName === undefined) throw new Error("合成题面资源目标不存在。");
    duplicateTarget.mappings[duplicateTarget.mappings.indexOf(duplicateImage)] = {
      attachmentId: duplicateImage.attachmentId,
      sourceBindingSha256: duplicateImage.sourceBindingSha256,
      status: "resolved",
      semanticRole: "statement_asset",
      visibility: "public",
      scope: {
        kind: "problem_groups",
        targets: [
          {
            groupId: "group-000001",
            metadataId: "metadata-000001",
            targetName: firstTargetName,
            statementReferences: [duplicateImagePath],
          },
        ],
      },
      reviewNote: "人工确认这是第二处相同内容的合成题面资源。",
      confirmed: true,
    };
    await expectInvalidPlan(fixture, duplicateTarget, "duplicate-target");

    const incompatibleExtension = await completePlan(fixture);
    const incompatiblePublic = incompatibleExtension.mappings.find(
      (mapping) =>
        mapping.status === "resolved" && mapping.semanticRole === "contestant_attachment",
    );
    if (incompatiblePublic === undefined) throw new Error("合成公开附件不存在。");
    firstProblemTarget(incompatiblePublic).targetName = `${incompatiblePublic.attachmentId}.c++`;
    await expectInvalidPlan(fixture, incompatibleExtension, "native-extension");

    const invalidBatchScope = await completePlan(fixture);
    const solutionOriginal = invalidBatchScope.mappings.find(
      (mapping) => mapping.status === "resolved" && mapping.semanticRole === "solution_original",
    );
    if (solutionOriginal === undefined) throw new Error("合成题解原件不存在。");
    solutionOriginal.scope = {
      kind: "batch_internal",
      targetName: `${solutionOriginal.attachmentId}.pdf`,
    };
    await expectInvalidPlan(fixture, invalidBatchScope, "invalid-batch-scope");

    const emptyTargets = await completePlan(fixture);
    statementAssetIn(emptyTargets).scope.targets = [];
    await expectInvalidPlan(fixture, emptyTargets, "empty-problem-targets");
  });

  it("拒绝源绑定摘要替换、符号链接计划和确认后的源文件变化", async () => {
    const digestFixture = await createAttachmentFixture();
    const replacedBinding = await completePlan(digestFixture);
    const first = replacedBinding.mappings[0];
    if (first === undefined) throw new Error("合成附件映射为空。");
    first.sourceBindingSha256 = "0".repeat(64);
    await expectInvalidPlan(digestFixture, replacedBinding, "digest-replaced", {
      code: "ATTACHMENT_MAPPING_CHANGED",
    });

    const symlinkFixture = await createAttachmentFixture();
    const validPlan = await completePlan(symlinkFixture);
    const realPlan = await writePlan(
      symlinkFixture.privateRoot,
      "attachment-plan.real.json",
      validPlan,
    );
    const linkedPlan = join(symlinkFixture.privateRoot, "attachment-plan.link.json");
    await symlink(realPlan, linkedPlan);
    await expect(
      sealHistoryAttachmentMapping({
        ...symlinkFixture.contextOptions,
        worksheetDirectory: symlinkFixture.worksheetDirectory,
        mappingPlanFile: linkedPlan,
        outputDirectory: join(symlinkFixture.privateRoot, "attachment-mapping-symlink"),
      }),
    ).rejects.toMatchObject({ code: "INVALID_ARGUMENTS" });

    const modeFixture = await createAttachmentFixture();
    const modePlan = await completePlan(modeFixture);
    const modePlanFile = await writePlan(
      modeFixture.privateRoot,
      "attachment-plan.mode.json",
      modePlan,
    );
    await chmod(modePlanFile, 0o644);
    const modeOutput = join(modeFixture.privateRoot, "attachment-mapping-mode");
    await expect(
      sealHistoryAttachmentMapping({
        ...modeFixture.contextOptions,
        worksheetDirectory: modeFixture.worksheetDirectory,
        mappingPlanFile: modePlanFile,
        outputDirectory: modeOutput,
      }),
    ).rejects.toMatchObject({ code: "PREPARE_RESUME_UNSAFE" });
    await expect(lstat(modeOutput)).rejects.toMatchObject({ code: "ENOENT" });

    const changedSourceFixture = await createAttachmentFixture();
    const changedSourcePlan = await completePlan(changedSourceFixture);
    const changedSourcePlanFile = await writePlan(
      changedSourceFixture.privateRoot,
      "attachment-plan.changed-source.json",
      changedSourcePlan,
    );
    await writeFile(
      join(changedSourceFixture.sourceDirectory, "manual-solution.pdf"),
      new Uint8Array([...solutionPdfBytes, 0]),
    );
    await expect(
      sealHistoryAttachmentMapping({
        ...changedSourceFixture.contextOptions,
        worksheetDirectory: changedSourceFixture.worksheetDirectory,
        mappingPlanFile: changedSourcePlanFile,
        outputDirectory: join(changedSourceFixture.privateRoot, "attachment-mapping-changed"),
      }),
    ).rejects.toMatchObject({ code: "GROUPING_CHANGED" });
  });
});

interface AttachmentFixture {
  readonly privateRoot: string;
  readonly sourceDirectory: string;
  readonly worksheetDirectory: string;
  readonly imageAttachmentIds: readonly string[];
  readonly contextOptions: {
    readonly privateRootDirectory: string;
    readonly sourceDirectory: string;
    readonly sourceInventoryFile: string;
    readonly sourceLocationsFile: string;
    readonly metadataFile: string;
    readonly groupingDirectory: string;
    readonly groupingConfirmationFile: string;
  };
}

interface AttachmentWorksheet {
  readonly attachments: Array<{
    readonly attachmentId: string;
    readonly locator:
      | { readonly kind: "zip_entry"; readonly sourceId: string; readonly entryId: string }
      | {
          readonly kind: "text_range";
          readonly sourceId: string;
          readonly start: number;
          readonly end: number;
        }
      | { readonly kind: "whole_file"; readonly sourceId: string };
    readonly contentSha256: string;
    readonly sourceBindingSha256: string;
  }>;
}

type MappingPlan = {
  version: 1;
  confirmed: true;
  worksheetSha256: string;
  mappings: Array<
    Record<string, unknown> & {
      attachmentId: string;
      sourceBindingSha256: string;
      status: "resolved" | "unresolved";
    }
  >;
};

async function createAttachmentFixture(): Promise<AttachmentFixture> {
  const privateRoot = await mkdtemp(join(tmpdir(), "urmotiv-history-attachments-"));
  temporaryDirectories.push(privateRoot);
  const sourceDirectory = join(privateRoot, "sources");
  await mkdir(sourceDirectory, { mode: 0o700 });
  await writeFile(join(sourceDirectory, "problem.md"), `${statementText}${trailingText}`, "utf8");
  await writeFile(join(sourceDirectory, "problem-two.md"), "SYNTHETIC SECOND STATEMENT", "utf8");
  await writeFile(join(sourceDirectory, "manual-solution.pdf"), solutionPdfBytes);
  await writeFile(
    join(sourceDirectory, "bundle.zip"),
    writeZipArchive([
      { path: firstImagePath, content: imageBytes },
      { path: duplicateImagePath, content: imageBytes },
      { path: guidePath, content: encoder.encode("SYNTHETIC CONTESTANT GUIDE") },
    ]),
  );

  const metadataFile = join(privateRoot, "metadata.private.json");
  await writePrivateJson(metadataFile, {
    records: [
      { number: "synthetic-001", name: "Synthetic attachment mapping problem" },
      { number: "synthetic-002", name: "Synthetic second mapping problem" },
    ],
  });
  const catalogDirectory = join(privateRoot, "catalog");
  await inventoryHistorySources({
    privateRootDirectory: privateRoot,
    sourceDirectory,
    outputDirectory: catalogDirectory,
  });
  const sourceInventoryFile = join(catalogDirectory, "inventory.json");
  const sourceLocationsFile = join(catalogDirectory, "source-locations.private.json");
  const locations = JSON.parse(
    await readFile(sourceLocationsFile, "utf8"),
  ) as HistorySourceLocations;
  const textSourceId = sourceIdForPath(locations, "problem.md");
  const secondTextSourceId = sourceIdForPath(locations, "problem-two.md");
  const manualSourceId = sourceIdForPath(locations, "manual-solution.pdf");
  const archive = locations.sources.find((source) => source.sourcePath === "bundle.zip");
  if (archive === undefined) throw new Error("合成压缩包位置不存在。");
  const entryIdFor = (path: string): string => {
    const entry = archive.entries.find(
      (candidate) => candidate.entryPathChain.length === 1 && candidate.entryPathChain[0] === path,
    );
    if (entry === undefined) throw new Error("合成压缩包条目不存在。");
    return entry.entryId;
  };
  const firstImageEntryId = entryIdFor(firstImagePath);
  const duplicateImageEntryId = entryIdFor(duplicateImagePath);
  const guideEntryId = entryIdFor(guidePath);

  const groupingPlan: HistoryGroupingPlan = {
    version: 2,
    fragments: [
      {
        fragmentId: "fragment-000001",
        sourceId: textSourceId,
        selection: { kind: "text_range", start: 0, end: statementText.length },
      },
      {
        fragmentId: "fragment-000002",
        sourceId: secondTextSourceId,
        selection: { kind: "whole_file" },
      },
    ],
    groups: [
      {
        groupId: "group-000001",
        metadataId: "metadata-000001",
        fragmentIds: ["fragment-000001"],
      },
      {
        groupId: "group-000002",
        metadataId: "metadata-000002",
        fragmentIds: ["fragment-000002"],
      },
    ],
    sharingConfirmations: [],
    metadataDispositions: [],
    zipEntryDispositions: [firstImageEntryId, duplicateImageEntryId, guideEntryId].map(
      (entryId) => ({
        sourceId: archive.sourceId,
        entryId,
        action: "attachment" as const,
        reason: "人工确认这是合成题目的附件。",
        confirmed: true as const,
      }),
    ),
    textRangeDispositions: [
      {
        sourceId: textSourceId,
        start: statementText.length,
        end: statementText.length + trailingText.length,
        action: "attachment",
        reason: "人工确认尾段作为内部命题材料保留。",
        confirmed: true,
      },
    ],
    manualSourceDispositions: [
      {
        sourceId: manualSourceId,
        action: "attachment",
        reason: "人工确认 PDF 是题解原件。",
        confirmed: true,
      },
    ],
  };
  const groupingPlanFile = join(privateRoot, "grouping-plan.private.json");
  await writePrivateJson(groupingPlanFile, groupingPlan);
  const groupingDirectory = join(privateRoot, "grouping");
  await sealHistoryGrouping({
    privateRootDirectory: privateRoot,
    sourceDirectory,
    sourceInventoryFile,
    sourceLocationsFile,
    metadataFile,
    groupingPlanFile,
    outputDirectory: groupingDirectory,
  });
  const groupingConfirmationFile = join(privateRoot, "grouping-confirmation.private.json");
  await writeHistoryGroupingConfirmation({
    privateRootDirectory: privateRoot,
    sourceInventoryFile,
    sourceLocationsFile,
    metadataFile,
    groupingDirectory,
    outputFile: groupingConfirmationFile,
    confirmed: true,
  });
  const contextOptions = {
    privateRootDirectory: privateRoot,
    sourceDirectory,
    sourceInventoryFile,
    sourceLocationsFile,
    metadataFile,
    groupingDirectory,
    groupingConfirmationFile,
  };
  const worksheetDirectory = join(privateRoot, "attachment-worksheet");
  await expect(
    initializeHistoryAttachmentMappingWorksheet({
      ...contextOptions,
      outputDirectory: worksheetDirectory,
    }),
  ).resolves.toMatchObject({ attachmentCount: 5, unresolvedItemCount: 5, complete: false });
  const worksheet = JSON.parse(
    await readFile(join(worksheetDirectory, "attachment-worksheet.json"), "utf8"),
  ) as AttachmentWorksheet;
  const imageAttachmentIds = worksheet.attachments
    .filter(
      (attachment) =>
        attachment.locator.kind === "zip_entry" &&
        [firstImageEntryId, duplicateImageEntryId].includes(attachment.locator.entryId),
    )
    .map((attachment) => attachment.attachmentId);
  expect(imageAttachmentIds).toHaveLength(2);

  return {
    privateRoot,
    sourceDirectory,
    worksheetDirectory,
    imageAttachmentIds,
    contextOptions,
  };
}

async function completePlan(fixture: AttachmentFixture): Promise<MappingPlan> {
  const worksheetText = await readFile(
    join(fixture.worksheetDirectory, "attachment-worksheet.json"),
    "utf8",
  );
  const worksheet = JSON.parse(worksheetText) as AttachmentWorksheet;
  const worksheetSha256 = digest(JSON.stringify(worksheet));
  let publicOrdinal = 0;
  const mappings = worksheet.attachments.map((attachment) => {
    const common = {
      attachmentId: attachment.attachmentId,
      sourceBindingSha256: attachment.sourceBindingSha256,
      status: "resolved" as const,
      reviewNote: "人工逐项核对了合成附件的用途和可见性。",
      confirmed: true as const,
    };
    if (fixture.imageAttachmentIds[0] === attachment.attachmentId) {
      return {
        ...common,
        semanticRole: "statement_asset",
        visibility: "public",
        scope: {
          kind: "problem_groups",
          targets: [
            {
              groupId: "group-000001",
              metadataId: "metadata-000001",
              targetName: `${attachment.contentSha256}.png`,
              statementReferences: [firstImagePath],
            },
            {
              groupId: "group-000002",
              metadataId: "metadata-000002",
              targetName: `${attachment.contentSha256}.png`,
              statementReferences: ["second/diagram.png"],
            },
          ],
        },
      };
    }
    if (attachment.locator.kind === "zip_entry") {
      publicOrdinal += 1;
      return {
        ...common,
        semanticRole: "contestant_attachment",
        visibility: "public",
        scope: {
          kind: "problem_groups",
          targets: [
            {
              groupId: "group-000001",
              metadataId: "metadata-000001",
              targetName: `${attachment.attachmentId}.${
                fixture.imageAttachmentIds.includes(attachment.attachmentId) ? "png" : "txt"
              }`,
            },
          ],
        },
      };
    }
    if (attachment.locator.kind === "text_range") {
      return {
        ...common,
        semanticRole: "authoring_material",
        visibility: "internal",
        scope: {
          kind: "batch_internal",
          targetName: `${attachment.attachmentId}.txt`,
        },
      };
    }
    return {
      ...common,
      semanticRole: "solution_original",
      visibility: "internal",
      scope: {
        kind: "problem_groups",
        targets: [
          {
            groupId: "group-000001",
            metadataId: "metadata-000001",
            targetName: `${attachment.attachmentId}.PDF`,
          },
        ],
      },
    };
  });
  expect(publicOrdinal).toBe(2);
  return { version: 1, confirmed: true, worksheetSha256, mappings };
}

function statementAssetIn(plan: MappingPlan): MappingPlan["mappings"][number] & {
  status: "resolved";
  semanticRole: "statement_asset";
  scope: {
    kind: "problem_groups";
    targets: Array<{
      groupId: string;
      metadataId: string;
      targetName: string;
      statementReferences: string[];
    }>;
  };
} {
  const found = plan.mappings.find(
    (mapping) => mapping.status === "resolved" && mapping.semanticRole === "statement_asset",
  );
  if (found === undefined) throw new Error("合成题面资源不存在。");
  return found as ReturnType<typeof statementAssetIn>;
}

function firstProblemTarget(mapping: MappingPlan["mappings"][number]): {
  targetName: string;
} {
  const scope = mapping.scope as
    | { kind: "problem_groups"; targets: Array<{ targetName: string }> }
    | undefined;
  const target = scope?.kind === "problem_groups" ? scope.targets[0] : undefined;
  if (target === undefined) throw new Error("合成题目组附件目标不存在。");
  return target;
}

async function expectInvalidPlan(
  fixture: AttachmentFixture,
  plan: MappingPlan,
  suffix: string,
  expected: { readonly code: string } = { code: "INVALID_ATTACHMENT_MAPPING" },
): Promise<void> {
  const planFile = await writePlan(fixture.privateRoot, `attachment-plan.${suffix}.json`, plan);
  const outputDirectory = join(fixture.privateRoot, `attachment-mapping-${suffix}`);
  await expect(
    sealHistoryAttachmentMapping({
      ...fixture.contextOptions,
      worksheetDirectory: fixture.worksheetDirectory,
      mappingPlanFile: planFile,
      outputDirectory,
    }),
  ).rejects.toMatchObject(expected);
  await expect(lstat(outputDirectory)).rejects.toMatchObject({ code: "ENOENT" });
}

async function writePlan(privateRoot: string, name: string, value: unknown): Promise<string> {
  const path = join(privateRoot, name);
  await writePrivateJson(path, value);
  return path;
}

async function writePrivateJson(path: string, value: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await chmod(path, 0o600);
}

function sourceIdForPath(locations: HistorySourceLocations, sourcePath: string): string {
  const source = locations.sources.find((candidate) => candidate.sourcePath === sourcePath);
  if (source === undefined) throw new Error("合成源位置不存在。");
  return source.sourceId;
}

function digest(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

async function expectMode(path: string, expected: number): Promise<void> {
  const metadata = await lstat(path);
  expect(metadata.mode & 0o777).toBe(expected);
}
