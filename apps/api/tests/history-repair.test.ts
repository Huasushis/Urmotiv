/**
 * 受控本地源文修复的行为测试。
 *
 * 只使用合成哨兵（源正文、元数据名称、路径、摘要），不包含任何私有内容。
 * 覆盖：修复清单必须恰好选择九条不重复回执；任何校验不一致都先于输出写入
 * 失败关闭；修复候选只用源正文与源原生名称本地重建（不调用模型、不生成或
 * 缩小正文、保留缺失解与未解析附件）；身份与幂等只来自标题无关的绑定元组；
 * 重跑幂等且绝不覆盖后来授权的内容。
 */
import { afterEach, describe, expect, it, vi, type Mock } from "vitest";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { canonicalProblemSchema, readZipArchive, urmotivNativeAdapter, writeZipArchive, type CanonicalProblem } from "@urmotiv/problem-package";
import {
  localSourceTextRepairNote,
  normalizeRepairTitle,
  prepareHistoryCandidates,
  repairFailedHistoryCandidates,
  sha256Hex,
  sourceBindingDigest,
  type HistoryCandidateRecord,
  type HistoryNormalizer,
} from "../src/history-migration/index";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

const SOURCE_COUNT = 10;
const FAILING_FIRST_INDEX = 1;

function sourceIdAt(index: number): string {
  return `source-${String(index + 1).padStart(6, "0")}`;
}

function candidateIdAt(index: number): string {
  return `candidate-${String(index * 30 + 1).padStart(6, "0")}`;
}

interface RepairSourceMapping {
  readonly sourcePath: string;
  readonly sourceSha256: string;
  readonly metadataNumber: string;
  readonly text: string;
}

interface RepairFixture {
  readonly root: string;
  readonly sourceDirectory: string;
  readonly metadataFile: string;
  readonly sourceConfirmationFile: string;
  readonly preparedDirectory: string;
  readonly mappings: ReadonlyArray<RepairSourceMapping>;
  readonly normalizeSpy: NormalizeSpy;
}

type NormalizeSpy = Mock<(input: { readonly sourceId: string }) => Promise<unknown>>;

async function createRepairFixture(): Promise<RepairFixture> {
  const root = await mkdtemp(join(tmpdir(), "urmotiv-history-repair-"));
  temporaryDirectories.push(root);
  const materializedDirectory = join(root, "materialized");
  const sourceDirectory = join(materializedDirectory, "sources");
  await mkdir(materializedDirectory, { mode: 0o700 });
  await mkdir(sourceDirectory, { mode: 0o700 });

  const records: Array<{
    readonly number: string;
    readonly name: string;
    readonly authorStudentId: string;
    readonly status: string;
    readonly contest: string;
    readonly note: string;
  }> = [];
  const mappings: Array<{
    readonly sourcePath: string;
    readonly sourceSha256: string;
    readonly metadataNumber: string;
    readonly text: string;
  }> = [];
  for (let index = 0; index < SOURCE_COUNT; index += 1) {
    const metadataNumber = `synthetic-${index + 1}`;
    const sourcePath = `synthetic-repair-${index + 1}.md`;
    const text = `只用于受控修复合成测试的源正文 ${index + 1}。`;
    await writeFile(join(sourceDirectory, sourcePath), text, "utf8");
    await chmod(join(sourceDirectory, sourcePath), 0o600);
    records.push({
      number: metadataNumber,
      name: `SYNTHETIC-REPAIR-NAME-${index + 1}`,
      authorStudentId: "",
      status: "",
      contest: "",
      note: "",
    });
    mappings.push({
      sourcePath,
      sourceSha256: sha256Hex(text),
      metadataNumber,
      text,
    });
  }

  const metadataText = `${JSON.stringify({ records }, null, 2)}\n`;
  const metadataFile = join(root, "metadata.private.json");
  await writeFile(metadataFile, metadataText, "utf8");
  const sourceConfirmationFile = join(materializedDirectory, "source-confirmation.private.json");
  await writeFile(
    sourceConfirmationFile,
    `${JSON.stringify(
      {
        version: 1,
        confirmed: true,
        metadataFileSha256: sha256Hex(metadataText),
        mappings: mappings.map(({ sourcePath, sourceSha256, metadataNumber }) => ({
          sourcePath,
          sourceSha256,
          metadataNumber,
        })),
      },
      null,
      2,
    )}\n`,
    "utf8",
  );

  const normalizeSpy = vi.fn(async (input: { readonly sourceId: string }) => {
    if (input.sourceId === sourceIdAt(0)) {
      return {
        problems: [
          {
            title: "合成候选题",
            type: "traditional" as const,
            basicStatement: "合成候选题面正文。",
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
          },
        ],
      };
    }
    return { problems: [] };
  });
  const normalizer: HistoryNormalizer = { normalize: normalizeSpy };

  const preparedDirectory = join(root, "prepared");
  const result = await prepareHistoryCandidates({
    privateRootDirectory: root,
    sourceDirectory,
    metadataFile,
    sourceConfirmationFile,
    outputDirectory: preparedDirectory,
    operationTag: "synthetic-repair-run-001",
    executorIdentity: {
      version: 1,
      codeSha256: "1".repeat(64),
      promptSha256: "2".repeat(64),
      modelSha256: "3".repeat(64),
      configSha256: "4".repeat(64),
    },
    normalizer,
  });
  if (result.complete) {
    throw new Error("合成修复测试的 prepare 应产生九个失败源。");
  }
  return {
    root,
    sourceDirectory,
    metadataFile,
    sourceConfirmationFile,
    preparedDirectory,
    mappings,
    normalizeSpy,
  };
}

async function writeRepairManifest(
  root: string,
  receipts: ReadonlyArray<unknown>,
): Promise<string> {
  const repairManifestFile = join(root, "repair-manifest.private.json");
  await writeFile(
    repairManifestFile,
    `${JSON.stringify({ version: 1, receipts }, null, 2)}\n`,
    "utf8",
  );
  await chmod(repairManifestFile, 0o600);
  return repairManifestFile;
}

async function buildReceipts(
  preparedDirectory: string,
  mappings: ReadonlyArray<{ readonly sourcePath: string; readonly sourceSha256: string; readonly metadataNumber: string }>,
): Promise<Array<Record<string, string>>> {
  const receipts: Array<Record<string, string>> = [];
  for (let index = FAILING_FIRST_INDEX; index < SOURCE_COUNT; index += 1) {
    const sourceId = sourceIdAt(index);
    const failed = JSON.parse(
      await readFile(join(preparedDirectory, "requests", `${sourceId}.failed.json`), "utf8"),
    ) as unknown;
    const mapping = mappings[index]!;
    receipts.push({
      sourceId,
      sourcePath: mapping.sourcePath,
      sourceSha256: mapping.sourceSha256,
      metadataNumber: mapping.metadataNumber,
      failedReceiptSha256: sha256Hex(JSON.stringify(failed)),
    });
  }
  return receipts;
}

function hasErrorCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}

describe("normalizeRepairTitle 确定性标题规范化", () => {
  it("折叠所有空白并去首尾空白，保持 1..200 长度", () => {
    expect(normalizeRepairTitle("  甲乙  丙\n丁\t戊  ")).toBe("甲乙 丙 丁 戊");
    expect(normalizeRepairTitle("简短标题").length).toBeGreaterThanOrEqual(1);
    expect(normalizeRepairTitle("简短标题").length).toBeLessThanOrEqual(200);
  });

  it("超过 200 个码点时按码点确定性截断到 200", () => {
    const longName = "甲".repeat(250);
    const title = normalizeRepairTitle(longName);
    expect(title).toBe("甲".repeat(200));
    expect(title.length).toBe(200);
  });

  it("空白名称拒绝（防御，元数据层已保证非空）", () => {
    expect(() => normalizeRepairTitle(" \n\t ")).toThrowError(
      expect.objectContaining({ code: "REPAIR_REJECTED" }),
    );
  });
});

describe("受控修复清单校验", () => {
  it("少于九条回执时拒绝且不产生任何输出", async () => {
    const fixture = await createRepairFixture();
    const receipts = (await buildReceipts(fixture.preparedDirectory, fixture.mappings)).slice(0, 8);
    const repairManifestFile = await writeRepairManifest(fixture.root, receipts);
    await expect(
      repairFailedHistoryCandidates({
        privateRootDirectory: fixture.root,
        sourceDirectory: fixture.sourceDirectory,
        metadataFile: fixture.metadataFile,
        sourceConfirmationFile: fixture.sourceConfirmationFile,
        preparedDirectory: fixture.preparedDirectory,
        repairManifestFile,
      }),
    ).rejects.toMatchObject({ code: "REPAIR_MANIFEST_INVALID" });
    await expect(
      readFile(join(fixture.preparedDirectory, "PREPARE_COMPLETE"), "utf8"),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("多于九条回执时拒绝", async () => {
    const fixture = await createRepairFixture();
    const receipts = await buildReceipts(fixture.preparedDirectory, fixture.mappings);
    receipts.push({ ...receipts[0] });
    const repairManifestFile = await writeRepairManifest(fixture.root, receipts);
    await expect(
      repairFailedHistoryCandidates({
        privateRootDirectory: fixture.root,
        sourceDirectory: fixture.sourceDirectory,
        metadataFile: fixture.metadataFile,
        sourceConfirmationFile: fixture.sourceConfirmationFile,
        preparedDirectory: fixture.preparedDirectory,
        repairManifestFile,
      }),
    ).rejects.toMatchObject({ code: "REPAIR_MANIFEST_INVALID" });
  });

  it("重复 sourceId 时拒绝", async () => {
    const fixture = await createRepairFixture();
    const receipts = await buildReceipts(fixture.preparedDirectory, fixture.mappings);
    receipts[1] = { ...receipts[0] };
    const repairManifestFile = await writeRepairManifest(fixture.root, receipts);
    await expect(
      repairFailedHistoryCandidates({
        privateRootDirectory: fixture.root,
        sourceDirectory: fixture.sourceDirectory,
        metadataFile: fixture.metadataFile,
        sourceConfirmationFile: fixture.sourceConfirmationFile,
        preparedDirectory: fixture.preparedDirectory,
        repairManifestFile,
      }),
    ).rejects.toMatchObject({ code: "REPAIR_MANIFEST_INVALID" });
  });
});

describe("受控本地源文修复端到端", () => {
  it("恰好九条失败回执被本地源文修复并发布完成标记", async () => {
    const fixture = await createRepairFixture();
    const receipts = await buildReceipts(fixture.preparedDirectory, fixture.mappings);
    const repairManifestFile = await writeRepairManifest(fixture.root, receipts);

    const result = await repairFailedHistoryCandidates({
      privateRootDirectory: fixture.root,
      sourceDirectory: fixture.sourceDirectory,
      metadataFile: fixture.metadataFile,
      sourceConfirmationFile: fixture.sourceConfirmationFile,
      preparedDirectory: fixture.preparedDirectory,
      repairManifestFile,
    });
    expect(result).toEqual({
      repairedCount: 9,
      alreadyRepairedCount: 0,
      candidateCount: SOURCE_COUNT,
      sourceCount: SOURCE_COUNT,
      complete: true,
    });

    const marker = JSON.parse(
      await readFile(join(fixture.preparedDirectory, "PREPARE_COMPLETE"), "utf8"),
    ) as { readonly candidateCount: number; readonly sourceCount: number };
    expect(marker.candidateCount).toBe(SOURCE_COUNT);
    expect(marker.sourceCount).toBe(SOURCE_COUNT);
    await expect(
      readFile(join(fixture.preparedDirectory, "PREPARE_INCOMPLETE"), "utf8"),
    ).rejects.toMatchObject({ code: "ENOENT" });

    for (let index = FAILING_FIRST_INDEX; index < SOURCE_COUNT; index += 1) {
      const checkpoint = JSON.parse(
        await readFile(
          join(fixture.preparedDirectory, "requests", `${sourceIdAt(index)}.completed.json`),
          "utf8",
        ),
      ) as { readonly candidates: ReadonlyArray<{ readonly candidateId: string }> };
      expect(checkpoint.candidates.map((item) => item.candidateId)).toEqual([
        candidateIdAt(index),
      ]);
    }
  });

  it("修复只使用源正文与源原生名称，不调用模型、不生成或缩小正文", async () => {
    const fixture = await createRepairFixture();
    const normalizeCallsAfterPrepare = fixture.normalizeSpy.mock.calls.length;
    const receipts = await buildReceipts(fixture.preparedDirectory, fixture.mappings);
    const repairManifestFile = await writeRepairManifest(fixture.root, receipts);

    await repairFailedHistoryCandidates({
      privateRootDirectory: fixture.root,
      sourceDirectory: fixture.sourceDirectory,
      metadataFile: fixture.metadataFile,
      sourceConfirmationFile: fixture.sourceConfirmationFile,
      preparedDirectory: fixture.preparedDirectory,
      repairManifestFile,
    });

    // 修复阶段绝不重发模型请求。
    expect(fixture.normalizeSpy.mock.calls.length).toBe(normalizeCallsAfterPrepare);
    for (let index = FAILING_FIRST_INDEX; index < SOURCE_COUNT; index += 1) {
      const candidate = JSON.parse(
        await readFile(
          join(fixture.preparedDirectory, "candidates", `${candidateIdAt(index)}.json`),
          "utf8",
        ),
      ) as HistoryCandidateRecord;
      // 精确源正文作为题面，不缩小、不生成。
      expect(candidate.problem.content.basicStatement).toBe(fixture.mappings[index]!.text);
      // 解不伪造：原文缺题解时 basicSolution 为结构性 null（绝不写入任何占位或
      // 提示文字），solution 保持空串；缺失在候选层即为结构性缺失。
      expect(candidate.problem.content.basicSolution).toBeNull();
      expect(candidate.problem.content.solution).toBe("");
      expect(candidate.problem.samples).toEqual([]);
      // 未解析附件保持未附加。
      expect(candidate.problem.files).toEqual([]);
      // 无模型参与：置信度为零，且只记录固定的本地修复溯源常量。
      expect(candidate.modelConfidence).toBe(0);
      expect(candidate.normalizationNote).toBe(localSourceTextRepairNote);
    }
  });

  it("题解缺失经候选 → 打包 → 导入全程保持结构性缺失（无任何占位内容或文件）", async () => {
    const fixture = await createRepairFixture();
    const receipts = await buildReceipts(fixture.preparedDirectory, fixture.mappings);
    const repairManifestFile = await writeRepairManifest(fixture.root, receipts);
    await repairFailedHistoryCandidates({
      privateRootDirectory: fixture.root,
      sourceDirectory: fixture.sourceDirectory,
      metadataFile: fixture.metadataFile,
      sourceConfirmationFile: fixture.sourceConfirmationFile,
      preparedDirectory: fixture.preparedDirectory,
      repairManifestFile,
    });

    const candidate = JSON.parse(
      await readFile(
        join(
          fixture.preparedDirectory,
          "candidates",
          `${candidateIdAt(FAILING_FIRST_INDEX)}.json`,
        ),
        "utf8",
      ),
    ) as HistoryCandidateRecord;

    // 候选层：缺题解以结构性 null 表示。
    expect(candidate.problem.content.basicSolution).toBeNull();
    expect(candidate.problem.content.solution).toBe("");

    // 打包层：同一原生适配器导出生成题目包，缺失不生成 basic-solution.md 文件；
    // 补充题解为空则不生成 solution.md（缺失不到处蔓延）。
    const generated = await urmotivNativeAdapter.export(candidate.problem, {
      exportedAt: "2026-08-11T00:00:00.000Z",
    });
    if (generated.kind !== "zip") {
      throw new Error("合成题目包导出应为 zip。");
    }
    const archive = readZipArchive(writeZipArchive(generated.files));
    expect(archive.read("content/basic-solution.md")).toBeUndefined();
    expect(archive.read("content/solution.md")).toBeUndefined();

    // 导入层：包经原生适配器导入后，缺失依然保持结构性缺失，题面精确。
    const imported = await urmotivNativeAdapter.import(archive, { conflictAction: "create" });
    expect(imported.content.basicStatement).toBe(fixture.mappings[FAILING_FIRST_INDEX]!.text);
    expect(imported.content.basicSolution).toBeNull();
    expect(imported.content.solution).toBe("");
    expect(imported.samples).toEqual([]);

    // 幂等重放后缺失不变：候选与包的字节保持不变，缺失仍为 null。
    await repairFailedHistoryCandidates({
      privateRootDirectory: fixture.root,
      sourceDirectory: fixture.sourceDirectory,
      metadataFile: fixture.metadataFile,
      sourceConfirmationFile: fixture.sourceConfirmationFile,
      preparedDirectory: fixture.preparedDirectory,
      repairManifestFile,
    });
    const replayCandidate = JSON.parse(
      await readFile(
        join(
          fixture.preparedDirectory,
          "candidates",
          `${candidateIdAt(FAILING_FIRST_INDEX)}.json`,
        ),
        "utf8",
      ),
    ) as HistoryCandidateRecord;
    expect(replayCandidate.problem.content.basicSolution).toBeNull();
    expect(replayCandidate.problem.content.solution).toBe("");
  });

  it("非空基础题解经打包 → 导入完整往返且与缺失解互不影响", async () => {
    const problemWithSolution = canonicalProblemSchema.parse({
      title: "合成有解题",
      type: "traditional",
      tags: [],
      difficulty: { thinkingLevel: 3, codingLevel: 2 },
      content: {
        basicStatement: "求 1+1 的值。",
        basicSolution: "1+1=2，直接计算即可。",
        background: "",
        statement: "",
        inputFormat: "",
        outputFormat: "",
        constraints: "",
        solution: "",
        hints: ""
      },
      samples: [{ input: "无输入", output: "2", explanation: "" }],
      files: [],
      provenance: { sourceSystem: "synthetic-test" },
      extensions: {}
    }) as CanonicalProblem;

    const generated = await urmotivNativeAdapter.export(problemWithSolution, {
      exportedAt: "2026-08-11T00:00:00.000Z"
    });
    if (generated.kind !== "zip") {
      throw new Error("合成题目包导出应为 zip。");
    }
    const archive = readZipArchive(writeZipArchive(generated.files));
    expect(archive.read("content/basic-solution.md")).toBeDefined();
    expect(new TextDecoder().decode(archive.read("content/basic-solution.md"))).toBe("1+1=2，直接计算即可。");

    const imported = await urmotivNativeAdapter.import(archive, { conflictAction: "create" });
    expect(imported.content.basicSolution).toBe("1+1=2，直接计算即可。");
    expect(imported.content.basicStatement).toBe("求 1+1 的值。");
  });

  it("修复候选的稳定绑定来自标题无关元组并与确定性结果一致", async () => {
    const fixture = await createRepairFixture();
    const receipts = await buildReceipts(fixture.preparedDirectory, fixture.mappings);
    const repairManifestFile = await writeRepairManifest(fixture.root, receipts);
    await repairFailedHistoryCandidates({
      privateRootDirectory: fixture.root,
      sourceDirectory: fixture.sourceDirectory,
      metadataFile: fixture.metadataFile,
      sourceConfirmationFile: fixture.sourceConfirmationFile,
      preparedDirectory: fixture.preparedDirectory,
      repairManifestFile,
    });

    for (let index = FAILING_FIRST_INDEX; index < SOURCE_COUNT; index += 1) {
      const candidate = JSON.parse(
        await readFile(
          join(fixture.preparedDirectory, "candidates", `${candidateIdAt(index)}.json`),
          "utf8",
        ),
      ) as HistoryCandidateRecord;
      const mapping = fixture.mappings[index]!;
      const expectedBinding = sourceBindingDigest({
        sourceId: sourceIdAt(index),
        sourceContentSha256: mapping.sourceSha256,
        sourcePath: mapping.sourcePath,
        sourceSha256: mapping.sourceSha256,
        metadataNumber: mapping.metadataNumber,
      });
      expect(candidate.sourceBindingSha256).toBe(expectedBinding);
      // 确定性候选：源正文+名称+固定溯源可复算同一 contentSha256。
      expect(candidate.normalizationNote).toBe(localSourceTextRepairNote);
      expect(candidate.problem.title).toBe(`SYNTHETIC-REPAIR-NAME-${index + 1}`);
    }
  });

  it("已存在的模型候选原样保留（不被修复触碰）", async () => {
    const fixture = await createRepairFixture();
    const modelCandidatePath = join(
      fixture.preparedDirectory,
      "candidates",
      `${candidateIdAt(0)}.json`,
    );
    const modelCheckpointPath = join(
      fixture.preparedDirectory,
      "requests",
      `${sourceIdAt(0)}.completed.json`,
    );
    const candidateBefore = await readFile(modelCandidatePath, "utf8");
    const checkpointBefore = await readFile(modelCheckpointPath, "utf8");

    const receipts = await buildReceipts(fixture.preparedDirectory, fixture.mappings);
    const repairManifestFile = await writeRepairManifest(fixture.root, receipts);
    await repairFailedHistoryCandidates({
      privateRootDirectory: fixture.root,
      sourceDirectory: fixture.sourceDirectory,
      metadataFile: fixture.metadataFile,
      sourceConfirmationFile: fixture.sourceConfirmationFile,
      preparedDirectory: fixture.preparedDirectory,
      repairManifestFile,
    });

    expect(await readFile(modelCandidatePath, "utf8")).toBe(candidateBefore);
    expect(await readFile(modelCheckpointPath, "utf8")).toBe(checkpointBefore);
  });

  it("重跑幂等：九条全部已满足、标记与候选字节完全不变", async () => {
    const fixture = await createRepairFixture();
    const receipts = await buildReceipts(fixture.preparedDirectory, fixture.mappings);
    const repairManifestFile = await writeRepairManifest(fixture.root, receipts);
    const options = {
      privateRootDirectory: fixture.root,
      sourceDirectory: fixture.sourceDirectory,
      metadataFile: fixture.metadataFile,
      sourceConfirmationFile: fixture.sourceConfirmationFile,
      preparedDirectory: fixture.preparedDirectory,
      repairManifestFile,
    };

    const first = await repairFailedHistoryCandidates(options);
    expect(first.repairedCount).toBe(9);
    const snapshots: Array<[string, string]> = [];
    snapshots.push([join(fixture.preparedDirectory, "PREPARE_COMPLETE"), await readFile(join(fixture.preparedDirectory, "PREPARE_COMPLETE"), "utf8")]);
    snapshots.push([join(fixture.preparedDirectory, "review.json"), await readFile(join(fixture.preparedDirectory, "review.json"), "utf8")]);
    snapshots.push([join(fixture.preparedDirectory, "run.json"), await readFile(join(fixture.preparedDirectory, "run.json"), "utf8")]);
    for (let index = FAILING_FIRST_INDEX; index < SOURCE_COUNT; index += 1) {
      snapshots.push([
        join(fixture.preparedDirectory, "candidates", `${candidateIdAt(index)}.json`),
        await readFile(join(fixture.preparedDirectory, "candidates", `${candidateIdAt(index)}.json`), "utf8"),
      ]);
      snapshots.push([
        join(fixture.preparedDirectory, "requests", `${sourceIdAt(index)}.completed.json`),
        await readFile(join(fixture.preparedDirectory, "requests", `${sourceIdAt(index)}.completed.json`), "utf8"),
      ]);
    }

    const second = await repairFailedHistoryCandidates(options);
    expect(second).toEqual({
      repairedCount: 0,
      alreadyRepairedCount: 9,
      candidateCount: SOURCE_COUNT,
      sourceCount: SOURCE_COUNT,
      complete: true,
    });
    for (const [path, before] of snapshots) {
      expect(await readFile(path, "utf8")).toBe(before);
    }
  });

  it("完成标记丢失后重跑可幂等恢复（崩溃续跑）", async () => {
    const fixture = await createRepairFixture();
    const receipts = await buildReceipts(fixture.preparedDirectory, fixture.mappings);
    const repairManifestFile = await writeRepairManifest(fixture.root, receipts);
    const options = {
      privateRootDirectory: fixture.root,
      sourceDirectory: fixture.sourceDirectory,
      metadataFile: fixture.metadataFile,
      sourceConfirmationFile: fixture.sourceConfirmationFile,
      preparedDirectory: fixture.preparedDirectory,
      repairManifestFile,
    };

    await repairFailedHistoryCandidates(options);
    await rm(join(fixture.preparedDirectory, "review.json"), { force: true });
    await rm(join(fixture.preparedDirectory, "PREPARE_COMPLETE"), { force: true });

    const resumed = await repairFailedHistoryCandidates(options);
    expect(resumed).toEqual({
      repairedCount: 0,
      alreadyRepairedCount: 9,
      candidateCount: SOURCE_COUNT,
      sourceCount: SOURCE_COUNT,
      complete: true,
    });
    const marker = JSON.parse(
      await readFile(join(fixture.preparedDirectory, "PREPARE_COMPLETE"), "utf8"),
    ) as { readonly candidateCount: number; readonly sourceCount: number };
    expect(marker.candidateCount).toBe(SOURCE_COUNT);
    expect(marker.sourceCount).toBe(SOURCE_COUNT);
    await expect(
      readFile(join(fixture.preparedDirectory, "review.json"), "utf8"),
    ).resolves.toBeTruthy();
  });
it("写完成检查点后崩溃留下的失败回执在重跑时自愈移除", async () => {
    const fixture = await createRepairFixture();
    const receipts = await buildReceipts(fixture.preparedDirectory, fixture.mappings);
    const repairManifestFile = await writeRepairManifest(fixture.root, receipts);
    const options = {
      privateRootDirectory: fixture.root,
      sourceDirectory: fixture.sourceDirectory,
      metadataFile: fixture.metadataFile,
      sourceConfirmationFile: fixture.sourceConfirmationFile,
      preparedDirectory: fixture.preparedDirectory,
      repairManifestFile,
    };

    // 模拟"先写 completed、后删 failed"之间崩溃：预先留存失败回执字节。
    const failedBefore = await readFile(
      join(fixture.preparedDirectory, "requests", `${sourceIdAt(1)}.failed.json`),
      "utf8",
    );
    await repairFailedHistoryCandidates(options);
    const completeBefore = await readFile(join(fixture.preparedDirectory, "PREPARE_COMPLETE"), "utf8");
    await expect(
      readFile(join(fixture.preparedDirectory, "requests", `${sourceIdAt(1)}.failed.json`), "utf8"),
    ).rejects.toMatchObject({ code: "ENOENT" });

    // 恢复失败回执以重现崩溃窗口（completed 与 failed 并存）。
    const failureReceiptPath = join(
      fixture.preparedDirectory,
      "requests",
      `${sourceIdAt(1)}.failed.json`,
    );
    await writeFile(failureReceiptPath, failedBefore, "utf8");
    await chmod(failureReceiptPath, 0o600);
    const resumed = await repairFailedHistoryCandidates(options);
    expect(resumed).toEqual({
      repairedCount: 0,
      alreadyRepairedCount: 9,
      candidateCount: SOURCE_COUNT,
      sourceCount: SOURCE_COUNT,
      complete: true,
    });
    // 自愈：失败回执再次移除，完成标记原样保留。
    await expect(
      readFile(join(fixture.preparedDirectory, "requests", `${sourceIdAt(1)}.failed.json`), "utf8"),
    ).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(join(fixture.preparedDirectory, "PREPARE_COMPLETE"), "utf8")).toBe(
      completeBefore,
    );
  });
});

describe("任何不一致先于输出写入失败关闭", () => {
  async function expectRejectedWithoutOutput(
    fixture: RepairFixture,
    repairManifestFile: string,
  ): Promise<void> {
    await expect(
      repairFailedHistoryCandidates({
        privateRootDirectory: fixture.root,
        sourceDirectory: fixture.sourceDirectory,
        metadataFile: fixture.metadataFile,
        sourceConfirmationFile: fixture.sourceConfirmationFile,
        preparedDirectory: fixture.preparedDirectory,
        repairManifestFile,
      }),
    ).rejects.toMatchObject({ code: "REPAIR_REJECTED" });
    // 除 prepare 已有的第一个模型候选外，不得留下任何候选或完成标记。
    const candidateFiles = (await readdir(join(fixture.preparedDirectory, "candidates"))).filter(
      (name) => name.endsWith(".json"),
    );
    expect(candidateFiles.sort()).toEqual([`${candidateIdAt(0)}.json`]);
    await expect(
      readFile(join(fixture.preparedDirectory, "PREPARE_COMPLETE"), "utf8"),
    ).rejects.toMatchObject({ code: "ENOENT" });
    await expect(
      readFile(join(fixture.preparedDirectory, "review.json"), "utf8"),
    ).rejects.toMatchObject({ code: "ENOENT" });
  }

  it("清单引用错误的源正文摘要时拒绝", async () => {
    const fixture = await createRepairFixture();
    const receipts = await buildReceipts(fixture.preparedDirectory, fixture.mappings);
    receipts[0] = { ...receipts[0], sourceSha256: "9".repeat(64) };
    const repairManifestFile = await writeRepairManifest(fixture.root, receipts);
    await expectRejectedWithoutOutput(fixture, repairManifestFile);
  });

  it("清单引用错误的失败回执摘要时拒绝", async () => {
    const fixture = await createRepairFixture();
    const receipts = await buildReceipts(fixture.preparedDirectory, fixture.mappings);
    receipts[0] = { ...receipts[0], failedReceiptSha256: "8".repeat(64) };
    const repairManifestFile = await writeRepairManifest(fixture.root, receipts);
    await expectRejectedWithoutOutput(fixture, repairManifestFile);
  });

  it("源正文文件被替换（摘要已变化）时拒绝", async () => {
    const fixture = await createRepairFixture();
    const replacedPath = join(fixture.sourceDirectory, fixture.mappings[1]!.sourcePath);
    await writeFile(replacedPath, "被替换成不同正文的合成文件。", "utf8");
    await chmod(replacedPath, 0o600);
    const receipts = await buildReceipts(fixture.preparedDirectory, fixture.mappings);
    const repairManifestFile = await writeRepairManifest(fixture.root, receipts);
    await expectRejectedWithoutOutput(fixture, repairManifestFile);
  });

  it("非清单源的源尚未完成时拒绝", async () => {
    const fixture = await createRepairFixture();
    await rm(
      join(fixture.preparedDirectory, "requests", `${sourceIdAt(0)}.completed.json`),
      { force: true },
    );
    const receipts = await buildReceipts(fixture.preparedDirectory, fixture.mappings);
    const repairManifestFile = await writeRepairManifest(fixture.root, receipts);
    await expectRejectedWithoutOutput(fixture, repairManifestFile);
  });

  it("存在内容不同的后来授权候选时拒绝覆盖", async () => {
    const fixture = await createRepairFixture();
    const receipts = await buildReceipts(fixture.preparedDirectory, fixture.mappings);
    const repairManifestFile = await writeRepairManifest(fixture.root, receipts);
    const options = {
      privateRootDirectory: fixture.root,
      sourceDirectory: fixture.sourceDirectory,
      metadataFile: fixture.metadataFile,
      sourceConfirmationFile: fixture.sourceConfirmationFile,
      preparedDirectory: fixture.preparedDirectory,
      repairManifestFile,
    };
    await repairFailedHistoryCandidates(options);

    // 模拟后来授权的新标题候选：替换源 2 的完成检查点为内容不同（更大批次）的候选。
    const checkpoint = JSON.parse(
      await readFile(
        join(fixture.preparedDirectory, "requests", `${sourceIdAt(1)}.completed.json`),
        "utf8",
      ),
    ) as { readonly activeSha256: string; readonly requestAttemptSha256s: readonly string[] };
    const authorized = {
      version: 1,
      status: "completed",
      sourceId: sourceIdAt(1),
      activeSha256: checkpoint.activeSha256,
      requestAttemptSha256s: checkpoint.requestAttemptSha256s,
      candidates: [
        {
          candidateId: candidateIdAt(1),
          contentSha256: "0".repeat(64),
        },
      ],
    };
    await writeFile(
      join(fixture.preparedDirectory, "requests", `${sourceIdAt(1)}.completed.json`),
      `${JSON.stringify(authorized, null, 2)}\n`,
      "utf8",
    );

    const candidatePath = join(
      fixture.preparedDirectory,
      "candidates",
      `${candidateIdAt(1)}.json`,
    );
    const candidateBefore = await readFile(candidatePath, "utf8");
    const error = await repairFailedHistoryCandidates(options).then(
      () => undefined,
      (caught: unknown) => caught,
    );
    expect(hasErrorCode(error, "REPAIR_REJECTED")).toBe(true);
    // 拒绝覆盖：修复候选原样保留。
    expect(await readFile(candidatePath, "utf8")).toBe(candidateBefore);
    expect((await readFile(candidatePath, "utf8")).length).toBeGreaterThan(0);
  });
});