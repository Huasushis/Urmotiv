import { afterEach, describe, expect, it, vi } from "vitest";
import {
  copyFile,
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile
} from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  readZipArchive,
  urmotivNativeAdapter
} from "@urmotiv/problem-package";
import {
  createLlmHistoryNormalizer,
  historySourceMappingSchema,
  packageApprovedCandidates,
  prepareHistoryCandidates,
  sha256Hex,
  type HistoryCandidateRecord,
  type HistoryNormalizer,
  type NormalizedHistoryOutput
} from "../src/history-migration/index";

const temporaryDirectories: string[] = [];
const syntheticSourceName = "synthetic-original-name.md";
const syntheticStudentId = "SYNTHETIC-STUDENT-001";
const syntheticMetadataTitle = "合成元数据题名";

afterEach(async () => {
  vi.unstubAllGlobals();
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true }))
  );
});

describe("历史题目迁移安全核心", () => {
  it("只接受明确确认且没有重复分配的源文件映射", () => {
    const digest = "a".repeat(64);
    expect(
      historySourceMappingSchema.safeParse({
        version: 1,
        confirmed: false,
        metadataFileSha256: "c".repeat(64),
        mappings: [
          {
            sourcePath: syntheticSourceName,
            sourceSha256: digest,
            metadataNumber: "1"
          }
        ]
      }).success
    ).toBe(false);

    expect(
      historySourceMappingSchema.safeParse({
        version: 1,
        confirmed: true,
        metadataFileSha256: "c".repeat(64),
        mappings: [
          {
            sourcePath: syntheticSourceName,
            sourceSha256: digest,
            metadataNumber: "1"
          },
          {
            sourcePath: "another.md",
            sourceSha256: "b".repeat(64),
            metadataNumber: "1"
          }
        ]
      }).success
    ).toBe(false);
  });

  it("拒绝把输入或输出放到明确指定的服务器私有目录之外", async () => {
    const fixture = await createFixture("只用于合成测试的源正文。");
    let called = false;

    await expect(
      prepareHistoryCandidates({
        ...fixture.prepareOptions,
        privateRootDirectory: fixture.sourceDirectory,
        normalizer: {
          async normalize() {
            called = true;
            return normalizedOutput();
          }
        }
      })
    ).rejects.toMatchObject({
      code: "INVALID_ARGUMENTS"
    });
    expect(called).toBe(false);
  });

  it("把完整源文本交给整理器，不再静默截断四万字符之后的内容", async () => {
    const tailMarker = "END-OF-SYNTHETIC-SOURCE";
    const sourceText = `${"x".repeat(45_000)}${tailMarker}`;
    const fixture = await createFixture(sourceText);
    let received = "";
    await prepareHistoryCandidates({
      ...fixture.prepareOptions,
      normalizer: {
        async normalize(input) {
          received = input.text;
          return normalizedOutput();
        }
      }
    });

    expect(received).toBe(sourceText);
    expect(received.endsWith(tailMarker)).toBe(true);
  });

  it("五十万个汉字虽然超过五十万字节，仍按完整文本长度安全处理", async () => {
    const sourceText = "甲".repeat(500_000);
    const fixture = await createFixture(sourceText);
    let receivedLength = 0;
    await prepareHistoryCandidates({
      ...fixture.prepareOptions,
      normalizer: {
        async normalize(input) {
          receivedLength = input.text.length;
          return normalizedOutput();
        }
      }
    });

    expect(receivedLength).toBe(500_000);
  });

  it("源文本超过明确上限时拒绝处理，不截取前一部分继续", async () => {
    const fixture = await createFixture("x".repeat(500_001));
    let called = false;

    await expect(
      prepareHistoryCandidates({
        ...fixture.prepareOptions,
        normalizer: {
          async normalize() {
            called = true;
            return normalizedOutput();
          }
        }
      })
    ).rejects.toMatchObject({
      code: "SOURCE_TOO_LARGE"
    });
    expect(called).toBe(false);
  });

  it("候选文件使用安全编号，公开审核清单不含题名、学号、原文件名或正文", async () => {
    const fixture = await createFixture("只用于合成测试的源正文。");
    await prepareHistoryCandidates({
      ...fixture.prepareOptions,
      normalizer: fixedNormalizer()
    });

    expect(await readdir(join(fixture.prepareOutput, "candidates"))).toEqual([
      "candidate-000001.json"
    ]);
    const reportText = await readFile(
      join(fixture.prepareOutput, "review.json"),
      "utf8"
    );
    expect(reportText).toContain("candidate-000001");
    expect(reportText).toMatch(/[0-9a-f]{64}/);
    expect(reportText).not.toContain(syntheticMetadataTitle);
    expect(reportText).not.toContain(syntheticStudentId);
    expect(reportText).not.toContain(syntheticSourceName);
    expect(reportText).not.toContain("合成候选题面正文");

    const candidate = await readCandidate(fixture.prepareOutput);
    expect(candidate.problem.extensions).toEqual({});
    expect(candidate.problem.provenance).toEqual({
      sourceSystem: "ustc-history-private"
    });
    expect(JSON.stringify(candidate)).not.toContain(syntheticStudentId);
    expect(JSON.stringify(candidate)).not.toContain(syntheticSourceName);
  });

  it("输出路径存在时停止，不覆盖上一次候选结果", async () => {
    const fixture = await createFixture("只用于合成测试的源正文。");
    const first = await prepareHistoryCandidates({
      ...fixture.prepareOptions,
      normalizer: fixedNormalizer()
    });
    const reportBefore = await readFile(
      join(fixture.prepareOutput, "review.json"),
      "utf8"
    );

    await expect(
      prepareHistoryCandidates({
        ...fixture.prepareOptions,
        normalizer: fixedNormalizer()
      })
    ).rejects.toMatchObject({
      code: "OUTPUT_ALREADY_EXISTS"
    });
    expect(first.candidateCount).toBe(1);
    expect(
      await readFile(join(fixture.prepareOutput, "review.json"), "utf8")
    ).toBe(reportBefore);
  });

  it("源文件内容变化后使第一份人工确认失效", async () => {
    const fixture = await createFixture("确认时的合成正文。");
    await writeFile(
      join(fixture.sourceDirectory, syntheticSourceName),
      "确认后被修改的合成正文。",
      "utf8"
    );

    await expect(
      prepareHistoryCandidates({
        ...fixture.prepareOptions,
        normalizer: fixedNormalizer()
      })
    ).rejects.toMatchObject({
      code: "SOURCE_DIGEST_MISMATCH"
    });
  });

  it("作者归属等元数据变化后使第一份人工确认失效", async () => {
    const fixture = await createFixture("确认时的合成正文。");
    const metadata = JSON.parse(
      await readFile(fixture.prepareOptions.metadataFile, "utf8")
    ) as { records: Array<Record<string, unknown>> };
    metadata.records[0] = {
      ...metadata.records[0],
      authorStudentId: "SYNTHETIC-STUDENT-CHANGED"
    };
    await writeFile(
      fixture.prepareOptions.metadataFile,
      `${JSON.stringify(metadata, null, 2)}\n`,
      "utf8"
    );

    await expect(
      prepareHistoryCandidates({
        ...fixture.prepareOptions,
        normalizer: fixedNormalizer()
      })
    ).rejects.toMatchObject({
      code: "SOURCE_MAPPING_CHANGED"
    });
  });

  it("候选内容变化后使第二份人工批准失效", async () => {
    const fixture = await createPreparedFixture();
    const candidate = await readCandidate(fixture.prepareOutput);
    await writeApproval(
      fixture.approvalFile,
      candidate.candidateId,
      candidate.contentSha256
    );
    const changed = {
      ...candidate,
      problem: {
        ...candidate.problem,
        content: {
          ...candidate.problem.content,
          basicStatement: "批准后被修改的合成题面。"
        }
      }
    };
    await writeFile(
      join(
        fixture.prepareOutput,
        "candidates",
        `${candidate.candidateId}.json`
      ),
      `${JSON.stringify(changed, null, 2)}\n`,
      "utf8"
    );

    await expect(
      packageApprovedCandidates(fixture.packageOptions)
    ).rejects.toMatchObject({
      code: "CANDIDATE_CHANGED"
    });
  });

  it("候选审核备注变化后也使第二份人工批准失效", async () => {
    const fixture = await createPreparedFixture();
    const candidate = await readCandidate(fixture.prepareOutput);
    await writeApproval(
      fixture.approvalFile,
      candidate.candidateId,
      candidate.contentSha256
    );
    await writeFile(
      join(
        fixture.prepareOutput,
        "candidates",
        `${candidate.candidateId}.json`
      ),
      `${JSON.stringify(
        {
          ...candidate,
          normalizationNote: "批准后被修改的合成审核备注。"
        },
        null,
        2
      )}\n`,
      "utf8"
    );

    await expect(
      packageApprovedCandidates(fixture.packageOptions)
    ).rejects.toMatchObject({
      code: "CANDIDATE_CHANGED"
    });
  });

  it("模型置信度变化后也使第二份人工批准失效", async () => {
    const fixture = await createPreparedFixture();
    const candidate = await readCandidate(fixture.prepareOutput);
    await writeApproval(
      fixture.approvalFile,
      candidate.candidateId,
      candidate.contentSha256
    );
    await writeFile(
      join(
        fixture.prepareOutput,
        "candidates",
        `${candidate.candidateId}.json`
      ),
      `${JSON.stringify(
        {
          ...candidate,
          modelConfidence: 0.1
        },
        null,
        2
      )}\n`,
      "utf8"
    );

    await expect(
      packageApprovedCandidates(fixture.packageOptions)
    ).rejects.toMatchObject({
      code: "CANDIDATE_CHANGED"
    });
  });

  it("准备后原始文本变化时打包阶段重新核对并停止", async () => {
    const fixture = await createPreparedFixture();
    const candidate = await readCandidate(fixture.prepareOutput);
    await writeApproval(
      fixture.approvalFile,
      candidate.candidateId,
      candidate.contentSha256
    );
    await writeFile(
      join(fixture.sourceDirectory, syntheticSourceName),
      "准备阶段之后被修改的合成正文。",
      "utf8"
    );

    await expect(
      packageApprovedCandidates(fixture.packageOptions)
    ).rejects.toMatchObject({
      code: "SOURCE_DIGEST_MISMATCH"
    });
  });

  it("拒绝从指向私有根目录外的候选子目录读取文件", async () => {
    const fixture = await createPreparedFixture();
    const candidate = await readCandidate(fixture.prepareOutput);
    await writeApproval(
      fixture.approvalFile,
      candidate.candidateId,
      candidate.contentSha256
    );
    const outsideDirectory = await mkdtemp(
      join(tmpdir(), "urmotiv-history-outside-")
    );
    temporaryDirectories.push(outsideDirectory);
    await copyFile(
      join(
        fixture.prepareOutput,
        "candidates",
        `${candidate.candidateId}.json`
      ),
      join(outsideDirectory, `${candidate.candidateId}.json`)
    );
    await rm(join(fixture.prepareOutput, "candidates"), {
      recursive: true,
      force: true
    });
    await symlink(
      outsideDirectory,
      join(fixture.prepareOutput, "candidates"),
      "dir"
    );

    await expect(
      packageApprovedCandidates(fixture.packageOptions)
    ).rejects.toMatchObject({
      code: "INVALID_ARGUMENTS"
    });
  });

  it("已知学号或原文件名出现在模型结果或难度文字时拒绝生成候选", async () => {
    const modelLeakFixture = await createFixture("只用于合成测试的源正文。");
    await expect(
      prepareHistoryCandidates({
        ...modelLeakFixture.prepareOptions,
        normalizer: {
          async normalize() {
            return {
              problems: [
                {
                  ...normalizedProblem("合成候选题"),
                  basicStatement: `不应进入候选的标识：${syntheticStudentId}`
                }
              ]
            };
          }
        }
      })
    ).rejects.toMatchObject({
      code: "CANDIDATE_INVALID"
    });

    const metadataLeakFixture = await createFixture(
      "另一份只用于合成测试的源正文。",
      { difficultyText: `不应导出的原文件名：${syntheticSourceName}` }
    );
    await expect(
      prepareHistoryCandidates({
        ...metadataLeakFixture.prepareOptions,
        normalizer: fixedNormalizer()
      })
    ).rejects.toMatchObject({
      code: "CANDIDATE_INVALID"
    });
  });

  it("拒绝写出超过后续读取上限的候选，不留下完成标记", async () => {
    const fixture = await createFixture("只用于合成测试的源正文。");
    const oversized = "甲".repeat(500_000);
    await expect(
      prepareHistoryCandidates({
        ...fixture.prepareOptions,
        normalizer: {
          async normalize() {
            return {
              problems: [
                {
                  ...normalizedProblem("合成候选题"),
                  basicStatement: oversized,
                  basicSolution: oversized,
                  background: oversized,
                  statement: oversized,
                  inputFormat: oversized,
                  outputFormat: oversized,
                  constraints: oversized,
                  solution: oversized,
                  hints: oversized
                }
              ]
            };
          }
        }
      })
    ).rejects.toMatchObject({
      code: "CANDIDATE_INVALID"
    });
    await expect(
      readFile(join(fixture.prepareOutput, "PREPARE_COMPLETE"), "utf8")
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("即使人工编辑候选，也拒绝把作者学号塞进扩展字段", async () => {
    const fixture = await createPreparedFixture();
    const candidate = await readCandidate(fixture.prepareOutput);
    await writeApproval(
      fixture.approvalFile,
      candidate.candidateId,
      candidate.contentSha256
    );
    const unsafe = {
      ...candidate,
      problem: {
        ...candidate.problem,
        extensions: {
          migration: {
            difficultyText: "",
            authorStudentId: syntheticStudentId
          }
        }
      }
    };
    await writeFile(
      join(
        fixture.prepareOutput,
        "candidates",
        `${candidate.candidateId}.json`
      ),
      `${JSON.stringify(unsafe, null, 2)}\n`,
      "utf8"
    );

    await expect(
      packageApprovedCandidates(fixture.packageOptions)
    ).rejects.toMatchObject({
      code: "CANDIDATE_INVALID"
    });
  });

  it("拒绝把同一份已确认源文件拆出的多个候选重复分配给一条元数据", async () => {
    const fixture = await createFixture("包含两道合成题的源正文。");
    await prepareHistoryCandidates({
      ...fixture.prepareOptions,
      normalizer: {
        async normalize() {
          return {
            problems: [
              normalizedProblem("第一道合成题"),
              normalizedProblem("第二道合成题")
            ]
          };
        }
      }
    });
    const first = await readCandidate(fixture.prepareOutput, "candidate-000001");
    const second = await readCandidate(fixture.prepareOutput, "candidate-000002");
    await writeFile(
      fixture.approvalFile,
      `${JSON.stringify(
        {
          version: 1,
          confirmed: true,
          approvals: [
            {
              candidateId: first.candidateId,
              contentSha256: first.contentSha256,
              decision: "approved"
            },
            {
              candidateId: second.candidateId,
              contentSha256: second.contentSha256,
              decision: "approved"
            }
          ]
        },
        null,
        2
      )}\n`,
      "utf8"
    );

    await expect(
      packageApprovedCandidates(fixture.packageOptions)
    ).rejects.toMatchObject({
      code: "DUPLICATE_ASSIGNMENT"
    });
  });

  it("批准后才生成题目包，作者学号只进入单独私有映射文件", async () => {
    const fixture = await createPreparedFixture();
    const candidate = await readCandidate(fixture.prepareOutput);
    await writeApproval(
      fixture.approvalFile,
      candidate.candidateId,
      candidate.contentSha256
    );

    const result = await packageApprovedCandidates(fixture.packageOptions);
    expect(result).toEqual({ packageCount: 1, authorMappingCount: 1 });

    const packagePath = join(
      fixture.packageOutput,
      "packages",
      "candidate-000001.zip"
    );
    const archive = readZipArchive(new Uint8Array(await readFile(packagePath)));
    const imported = await urmotivNativeAdapter.import(archive, {
      conflictAction: "create"
    });
    expect(imported.extensions).toEqual({});
    expect(imported.provenance).toEqual({
      sourceSystem: "ustc-history-private"
    });
    expect(imported.provenance?.sourceProblemId).toBeUndefined();

    const manifestBytes = archive.read("manifest.yaml");
    if (manifestBytes === undefined) {
      throw new Error("合成题目包缺少 manifest.yaml。");
    }
    const manifest = new TextDecoder().decode(manifestBytes);
    expect(manifest).not.toContain(syntheticStudentId);
    expect(manifest).not.toContain(syntheticSourceName);
    expect(manifest).not.toContain("originalName");
    expect(manifest).not.toContain("authorStudentId");
    for (const entry of archive.list()) {
      const bytes = archive.read(entry.path);
      if (bytes === undefined) {
        throw new Error("合成题目包条目无法读取。");
      }
      const text = new TextDecoder().decode(bytes);
      expect(entry.path).not.toContain(syntheticSourceName);
      expect(text).not.toContain(syntheticStudentId);
      expect(text).not.toContain(syntheticSourceName);
    }

    const reportText = await readFile(
      join(fixture.packageOutput, "report.json"),
      "utf8"
    );
    expect(reportText).not.toContain(syntheticStudentId);
    expect(reportText).not.toContain(syntheticSourceName);
    expect(reportText).not.toContain(syntheticMetadataTitle);
    expect(reportText).not.toContain("合成候选题面正文");

    const authorMapText = await readFile(fixture.authorMappingOutput, "utf8");
    expect(authorMapText).toContain(syntheticStudentId);
    expect(authorMapText).toContain("candidate-000001");
    const report = JSON.parse(reportText) as {
      batchSha256: string;
      packages: Array<{
        contentSha256: string;
        packageSha256: string;
      }>;
    };
    const authorMap = JSON.parse(authorMapText) as {
      batchSha256: string;
      records: Array<{
        contentSha256: string;
        packageSha256: string;
      }>;
    };
    expect(authorMap.batchSha256).toBe(report.batchSha256);
    expect(authorMap.records[0]?.contentSha256).toBe(
      report.packages[0]?.contentSha256
    );
    expect(authorMap.records[0]?.packageSha256).toBe(
      report.packages[0]?.packageSha256
    );
  });

  it("作者映射不能写进题目包输出目录", async () => {
    const fixture = await createPreparedFixture();
    const candidate = await readCandidate(fixture.prepareOutput);
    await writeApproval(
      fixture.approvalFile,
      candidate.candidateId,
      candidate.contentSha256
    );

    await expect(
      packageApprovedCandidates({
        ...fixture.packageOptions,
        authorMappingOutput: join(fixture.packageOutput, "author-map.json")
      })
    ).rejects.toMatchObject({
      code: "INVALID_ARGUMENTS"
    });
  });
});

describe("历史题目模型整理响应限制", () => {
  it("响应头已经返回但正文没有首段有效输出时按首段时限停止", async () => {
    const fetch = vi.fn(async () => {
      return new Response(
        new ReadableStream<Uint8Array>({
          start() {
            // 故意只返回响应头，让正文保持未完成。
          }
        }),
        { status: 200, headers: { "Content-Type": "text/event-stream" } }
      );
    });
    const normalizer = createLlmHistoryNormalizer({
      baseUrl: "https://synthetic.invalid/v1/",
      apiKey: "synthetic-key",
      model: "synthetic-model",
      firstOutputTimeoutMs: 20,
      outputIdleTimeoutMs: 20,
      maximumAttempts: 1,
      maximumResponseBytes: 1_000,
      fetch
    });

    await expect(
      normalizer.normalize({
        sourceId: "source-000001",
        text: "合成正文",
        expectedTitle: "合成题名",
        difficultyGuess: null
      })
    ).rejects.toMatchObject({
      code: "NORMALIZATION_FAILED",
      message: "source-000001 的模型请求在首段有效输出前超时。"
    });
  });

  it("模型响应正文超过字节上限时停止且错误不含响应内容", async () => {
    const privateMarker = "SYNTHETIC-PRIVATE-RESPONSE-MARKER";
    const fetch = vi.fn(async () => {
      return new Response(privateMarker.repeat(4), { status: 200 });
    });
    const normalizer = createLlmHistoryNormalizer({
      baseUrl: "https://synthetic.invalid/v1/",
      apiKey: "synthetic-key",
      model: "synthetic-model",
      firstOutputTimeoutMs: 1_000,
      outputIdleTimeoutMs: 1_000,
      maximumAttempts: 1,
      maximumResponseBytes: 32,
      fetch
    });

    let caught: unknown;
    try {
      await normalizer.normalize({
        sourceId: "source-000001",
        text: "合成正文",
        expectedTitle: "合成题名",
        difficultyGuess: null
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).toMatchObject({
      code: "NORMALIZATION_FAILED",
      message: "模型响应超过明确大小上限。"
    });
    expect(String(caught)).not.toContain(privateMarker);
  });
});

async function createFixture(
  sourceText: string,
  metadataOverrides: {
    readonly difficultyText?: string;
  } = {}
): Promise<{
  readonly root: string;
  readonly sourceDirectory: string;
  readonly prepareOutput: string;
  readonly approvalFile: string;
  readonly packageOutput: string;
  readonly authorMappingOutput: string;
  readonly prepareOptions: {
    readonly privateRootDirectory: string;
    readonly sourceDirectory: string;
    readonly metadataFile: string;
    readonly sourceConfirmationFile: string;
    readonly outputDirectory: string;
  };
  readonly packageOptions: {
    readonly privateRootDirectory: string;
    readonly sourceDirectory: string;
    readonly metadataFile: string;
    readonly sourceConfirmationFile: string;
    readonly preparedDirectory: string;
    readonly approvalFile: string;
    readonly outputDirectory: string;
    readonly authorMappingOutput: string;
    readonly exportedAt: string;
  };
}> {
  const root = await mkdtemp(join(tmpdir(), "urmotiv-history-migration-"));
  temporaryDirectories.push(root);
  const sourceDirectory = join(root, "sources");
  await mkdir(sourceDirectory);
  await writeFile(join(sourceDirectory, syntheticSourceName), sourceText, "utf8");

  const metadataFile = join(root, "metadata.private.json");
  const metadataRecord = {
    number: "synthetic-1",
    name: syntheticMetadataTitle,
    difficultyText: metadataOverrides.difficultyText ?? "",
    difficultyGuess: 1200,
    authorStudentId: syntheticStudentId,
    status: "",
    contest: "",
    note: ""
  };
  const metadataText = `${JSON.stringify(
    {
      records: [metadataRecord]
    },
    null,
    2
  )}\n`;
  await writeFile(metadataFile, metadataText, "utf8");
  const sourceConfirmationFile = join(root, "source-confirmation.private.json");
  await writeFile(
    sourceConfirmationFile,
    `${JSON.stringify(
      {
        version: 1,
        confirmed: true,
        metadataFileSha256: sha256Hex(metadataText),
        mappings: [
          {
            sourcePath: syntheticSourceName,
            sourceSha256: sha256Hex(sourceText),
            metadataNumber: "synthetic-1"
          }
        ]
      },
      null,
      2
    )}\n`,
    "utf8"
  );
  const prepareOutput = join(root, "prepared");
  const approvalFile = join(root, "candidate-approval.private.json");
  const packageOutput = join(root, "packaged");
  const authorMappingOutput = join(root, "author-map.private.json");

  return {
    root,
    sourceDirectory,
    prepareOutput,
    approvalFile,
    packageOutput,
    authorMappingOutput,
    prepareOptions: {
      privateRootDirectory: root,
      sourceDirectory,
      metadataFile,
      sourceConfirmationFile,
      outputDirectory: prepareOutput
    },
    packageOptions: {
      privateRootDirectory: root,
      sourceDirectory,
      metadataFile,
      sourceConfirmationFile,
      preparedDirectory: prepareOutput,
      approvalFile,
      outputDirectory: packageOutput,
      authorMappingOutput,
      exportedAt: "2026-07-30T00:00:00.000Z"
    }
  };
}

async function createPreparedFixture(): Promise<
  Awaited<ReturnType<typeof createFixture>>
> {
  const fixture = await createFixture("只用于合成测试的源正文。");
  await prepareHistoryCandidates({
    ...fixture.prepareOptions,
    normalizer: fixedNormalizer()
  });
  return fixture;
}

function fixedNormalizer(): HistoryNormalizer {
  return {
    async normalize() {
      return normalizedOutput();
    }
  };
}

function normalizedOutput(): NormalizedHistoryOutput {
  return {
    problems: [normalizedProblem("合成候选题")]
  };
}

function normalizedProblem(title: string): NormalizedHistoryOutput["problems"][number] {
  return {
    title,
    type: "traditional",
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
    tags: ["synthetic"],
    confidence: 0.9,
    migrationNote: "合成测试备注。"
  };
}

async function readCandidate(
  preparedDirectory: string,
  candidateId = "candidate-000001"
): Promise<HistoryCandidateRecord> {
  return JSON.parse(
    await readFile(
      join(preparedDirectory, "candidates", `${candidateId}.json`),
      "utf8"
    )
  ) as HistoryCandidateRecord;
}

async function writeApproval(
  approvalFile: string,
  candidateId: string,
  contentSha256: string
): Promise<void> {
  await writeFile(
    approvalFile,
    `${JSON.stringify(
      {
        version: 1,
        confirmed: true,
        approvals: [
          {
            candidateId,
            contentSha256,
            decision: "approved"
          }
        ]
      },
      null,
      2
    )}\n`,
    "utf8"
  );
}
