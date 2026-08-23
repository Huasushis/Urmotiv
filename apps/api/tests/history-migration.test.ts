import { afterEach, describe, expect, it, vi } from "vitest";
import {
  copyFile,
  chmod,
  chown,
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { readZipArchive, urmotivNativeAdapter } from "@urmotiv/problem-package";
import {
  createLlmHistoryNormalizer,
  assertHistoryAttachmentMappingComplete,
  initializeHistoryAttachmentMappingWorksheet,
  inventoryHistorySources,
  historyMetadataFileSchema,
  historySourceMappingSchema,
  HistoryNormalizationError,
  packageApprovedCandidates,
  prepareHistoryCandidates,
  recoverActiveHistoryCandidate,
  sealHistoryAttachmentMapping,
  sealHistoryGrouping,
  sha256Hex,
  verifyApprovedPackageSourceIdentities,
  writeHistoryGroupingConfirmation,
  type HistoryAttachmentMappingCapability,
  type HistoryCandidateRecord,
  type HistoryGroupingPlan,
  type HistoryNormalizer,
  type HistorySourceLocations,
  type HistoryRecoveryNormalizer,
  type NormalizedHistoryOutput,
} from "../src/history-migration/index";

const temporaryDirectories: string[] = [];
const syntheticSourceName = "synthetic-original-name.md";
const syntheticStudentId = "SYNTHETIC-STUDENT-001";
const syntheticMetadataTitle = "合成元数据题名";

afterEach(async () => {
  vi.unstubAllGlobals();
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("历史题目迁移安全核心", () => {
  it.each(["difficultyGuess", "difficultyText", "untrustedSubmittedDifficultyText"])(
    "拒绝仍含 %s 的元数据，避免任何自填难度进入下游",
    (field) => {
      expect(
        historyMetadataFileSchema.safeParse({
          records: [
            {
              number: "synthetic-1",
              name: "Synthetic metadata title",
              [field]: field === "difficultyGuess" ? 3200 : "synthetic self report",
            },
          ],
        }).success,
      ).toBe(false);
    },
  );

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
            metadataNumber: "1",
          },
        ],
      }).success,
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
            metadataNumber: "1",
          },
          {
            sourcePath: "another.md",
            sourceSha256: "b".repeat(64),
            metadataNumber: "1",
          },
        ],
      }).success,
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
          },
        },
      }),
    ).rejects.toMatchObject({
      code: "INVALID_ARGUMENTS",
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
        },
      },
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
        },
      },
    });

    expect(receivedLength).toBe(500_000);
  });

  it("源文本超过明确上限时拒绝处理，不截取前一部分继续", async () => {
    const fixture = await createFixture("x".repeat(500_001));
    let called = false;

    const result = await prepareHistoryCandidates({
      ...fixture.prepareOptions,
      normalizer: {
        async normalize() {
          called = true;
          return normalizedOutput();
        },
      },
    });
    expect(result).toMatchObject({
      complete: false,
      failedSourceCount: 1,
    });
    expect(called).toBe(false);
    await expectFailureKind(fixture.prepareOutput, "source_validation");
  });

  it("候选文件使用安全编号，公开审核清单不含题名、学号、原文件名或正文", async () => {
    const fixture = await createFixture("只用于合成测试的源正文。");
    await prepareHistoryCandidates({
      ...fixture.prepareOptions,
      normalizer: fixedNormalizer(),
    });

    expect(await readdir(join(fixture.prepareOutput, "candidates"))).toEqual([
      "candidate-000001.json",
    ]);
    const reportText = await readFile(join(fixture.prepareOutput, "review.json"), "utf8");
    expect(reportText).toContain("candidate-000001");
    expect(reportText).toMatch(/[0-9a-f]{64}/);
    expect(reportText).not.toContain(syntheticMetadataTitle);
    expect(reportText).not.toContain(syntheticStudentId);
    expect(reportText).not.toContain(syntheticSourceName);
    expect(reportText).not.toContain("合成候选题面正文");

    const candidate = await readCandidate(fixture.prepareOutput);
    expect(candidate.problem.extensions).toEqual({});
    expect(candidate.problem.difficulty).toEqual({});
    expect(candidate.problem.provenance).toEqual({
      sourceSystem: "ustc-history-private",
    });
    expect(JSON.stringify(candidate)).not.toContain(syntheticStudentId);
    expect(JSON.stringify(candidate)).not.toContain(syntheticSourceName);
  });

  it("输出路径存在时停止，不覆盖上一次候选结果", async () => {
    const fixture = await createFixture("只用于合成测试的源正文。");
    const first = await prepareHistoryCandidates({
      ...fixture.prepareOptions,
      normalizer: fixedNormalizer(),
    });
    const reportBefore = await readFile(join(fixture.prepareOutput, "review.json"), "utf8");

    await expect(
      prepareHistoryCandidates({
        ...fixture.prepareOptions,
        normalizer: fixedNormalizer(),
      }),
    ).rejects.toMatchObject({
      code: "OUTPUT_ALREADY_EXISTS",
    });
    expect(first.candidateCount).toBe(1);
    expect(await readFile(join(fixture.prepareOutput, "review.json"), "utf8")).toBe(reportBefore);
  });

  it("每次付费调用前先同步登记安全身份，返回后才登记完成", async () => {
    const fixture = await createFixture("只用于检查登记顺序的合成正文。");
    const release = deferred<NormalizedHistoryOutput>();
    let activeSeenBeforeCall = false;
    const running = prepareHistoryCandidates({
      ...fixture.prepareOptions,
      normalizer: {
        async normalize() {
          const activePath = join(fixture.prepareOutput, "requests", "source-000001.active.json");
          activeSeenBeforeCall = (await stat(activePath)).isFile();
          await expect(
            stat(join(fixture.prepareOutput, "requests", "source-000001.completed.json")),
          ).rejects.toMatchObject({ code: "ENOENT" });
          return release.promise;
        },
      },
    });
    await vi.waitFor(() => expect(activeSeenBeforeCall).toBe(true));
    release.resolve(normalizedOutput());
    await expect(running).resolves.toMatchObject({ complete: true });

    const activeText = await readFile(
      join(fixture.prepareOutput, "requests", "source-000001.active.json"),
      "utf8",
    );
    expect(activeText).toMatch(/[0-9a-f]{64}/);
    expect(activeText).not.toContain(fixture.prepareOptions.operationTag);
    expect(activeText).not.toContain(syntheticSourceName);
    expect((await stat(fixture.prepareOutput)).mode & 0o777).toBe(0o700);
    expect(
      (await stat(join(fixture.prepareOutput, "requests", "source-000001.active.json"))).mode &
        0o777,
    ).toBe(0o600);
  });

  it("完成检查点绑定 429 重试前的每一份请求登记", async () => {
    const fixture = await createFixture("只用于检查重试登记链的合成正文。");
    const responseBody = `data: ${JSON.stringify({
      choices: [
        {
          delta: { content: JSON.stringify(normalizedOutput()) },
          finish_reason: "stop",
        },
      ],
    })}\n\ndata: [DONE]\n\n`;
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(new Response("synthetic rate limit", { status: 429 }))
      .mockResolvedValueOnce(
        new Response(responseBody, { headers: { "Content-Type": "text/event-stream" } }),
      );
    const normalizer = createLlmHistoryNormalizer({
      baseUrl: "https://synthetic.invalid/v1/",
      apiKey: "synthetic-key",
      model: "synthetic-model",
      codeSha256: "f".repeat(64),
      maximumAttempts: 2,
      retryBaseDelayMs: 1,
      fetch,
    });
    await expect(
      prepareHistoryCandidates({
        ...fixture.prepareOptions,
        executorIdentity: normalizer.preparationIdentity,
        normalizer,
      }),
    ).resolves.toMatchObject({ complete: true });
    const completion = JSON.parse(
      await readFile(
        join(fixture.prepareOutput, "requests", "source-000001.completed.json"),
        "utf8",
      ),
    ) as { readonly requestAttemptSha256s?: unknown };
    expect(completion.requestAttemptSha256s).toEqual([
      expect.stringMatching(/^[0-9a-f]{64}$/),
      expect.stringMatching(/^[0-9a-f]{64}$/),
    ]);

    await rm(join(fixture.prepareOutput, "requests", "source-000001.attempt-02.active.json"));
    await expect(
      prepareHistoryCandidates({
        ...fixture.prepareOptions,
        executorIdentity: normalizer.preparationIdentity,
        resume: true,
        normalizer,
      }),
    ).rejects.toMatchObject({ code: "PREPARE_RESUME_UNSAFE" });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("失败后继续处理其余题，续跑只补未开始项且不重复完成或不确定请求", async () => {
    const fixture = await createMultiFixture();
    const firstCalls: string[] = [];
    const first = await prepareHistoryCandidates({
      ...fixture.prepareOptions,
      normalizer: {
        async normalize(input) {
          firstCalls.push(input.sourceId);
          if (input.sourceId === "source-000002") {
            throw new HistoryNormalizationError("cancelled", "合成取消。");
          }
          return normalizedOutput();
        },
      },
    });
    expect(firstCalls).toEqual(["source-000001", "source-000002"]);
    expect(first).toMatchObject({
      complete: false,
      completedSourceCount: 1,
      failedSourceCount: 1,
      pendingSourceCount: 1,
    });
    const failedCheckpoint = await readFile(
      join(fixture.prepareOutput, "requests", "source-000002.failed.json"),
      "utf8",
    );
    expect(failedCheckpoint).toContain('"failureKind": "cancelled"');
    expect(failedCheckpoint).not.toContain("合成取消");
    expect(failedCheckpoint).not.toContain("第二份合成正文");

    const resumedCalls: string[] = [];
    const resumed = await prepareHistoryCandidates({
      ...fixture.prepareOptions,
      resume: true,
      normalizer: {
        async normalize(input) {
          resumedCalls.push(input.sourceId);
          return normalizedOutput();
        },
      },
    });
    expect(resumedCalls).toEqual(["source-000003"]);
    expect(resumed).toMatchObject({
      complete: false,
      completedSourceCount: 2,
      failedSourceCount: 1,
      pendingSourceCount: 0,
    });
    expect(await readdir(join(fixture.prepareOutput, "candidates"))).toEqual([
      "candidate-000001.json",
      "candidate-000061.json",
    ]);
  });

  it("只有 active 的不确定请求不会在续跑时再次发送", async () => {
    const fixture = await createMultiFixture();
    const requests = join(fixture.prepareOutput, "requests");
    const heldRequests = join(fixture.prepareOutput, "requests-held");
    const outsideDirectory = await mkdtemp(join(tmpdir(), "urmotiv-history-checkpoint-outside-"));
    temporaryDirectories.push(outsideDirectory);
    await expect(
      prepareHistoryCandidates({
        ...fixture.prepareOptions,
        normalizer: {
          async normalize() {
            await rename(requests, heldRequests);
            await symlink(outsideDirectory, requests, "dir");
            throw new HistoryNormalizationError("connection", "合成连接状态未知。");
          },
        },
      }),
    ).rejects.toMatchObject({ code: "INVALID_ARGUMENTS" });
    await rm(requests, { force: true });
    await rename(heldRequests, requests);

    const resumedCalls: string[] = [];
    const resumed = await prepareHistoryCandidates({
      ...fixture.prepareOptions,
      resume: true,
      normalizer: {
        async normalize(input) {
          resumedCalls.push(input.sourceId);
          return normalizedOutput();
        },
      },
    });
    expect(resumedCalls).toEqual(["source-000002", "source-000003"]);
    expect(resumed).toMatchObject({
      complete: false,
      uncertainSourceCount: 1,
      completedSourceCount: 2,
      pendingSourceCount: 0,
    });
  });

  it("恢复工具身份不同于原 prepare 身份时仍绑定存储运行检查点", async () => {
    const fixture = await createActiveOnlyFixture("后续恢复工具身份差异正文。");
    const untrustedPrepareOptions = {
      ...fixture.prepareOptions,
      operationTag: "untrusted-run",
    };
    const result = await recoverActiveHistoryCandidate({
      sourceId: "source-000001",
      ...untrustedPrepareOptions,
      normalizer: fixedNormalizer(),
    });
    expect(result.status).toBe("completed");
  });

  it("恢复 active-only 检查点追加第二次请求并兼容续跑", async () => {
    const fixture = await createActiveOnlyFixture("恢复成功的合成正文。");
    const activePath = join(fixture.prepareOutput, "requests", "source-000001.active.json");
    const originalActive = await readFile(activePath, "utf8");

    const result = await recoverActiveHistoryCandidate({
      ...fixture.prepareOptions,
      sourceId: "source-000001",
      normalizer: fixedNormalizer(),
    });

    expect(result).toMatchObject({
      status: "completed",
      requestAttemptCount: 2,
      candidateCount: 1,
    });
    expect(await readFile(activePath, "utf8")).toBe(originalActive);
    const attempt = JSON.parse(
      await readFile(
        join(fixture.prepareOutput, "requests", "source-000001.attempt-02.active.json"),
        "utf8",
      ),
    ) as {
      readonly sourceId: string;
      readonly status: string;
      readonly executionIdentitySha256: string;
      readonly recoveryExecutorIdentity: { readonly codeSha256: string };
    };
    const completed = JSON.parse(
      await readFile(join(fixture.prepareOutput, "requests", "source-000001.completed.json"), "utf8"),
    ) as {
      readonly activeSha256: string;
      readonly requestAttemptSha256s: readonly string[];
      readonly recoveryExecutorIdentity: { readonly codeSha256: string };
    };
    expect(attempt).toMatchObject({ sourceId: "source-000001", status: "active" });
    expect(attempt.executionIdentitySha256).toBe(
      JSON.parse(originalActive).executionIdentitySha256,
    );
    expect(attempt.recoveryExecutorIdentity).toEqual(
      fixedNormalizer().preparationIdentity,
    );
    expect(completed.recoveryExecutorIdentity).toEqual(
      fixedNormalizer().preparationIdentity,
    );
    expect(completed.requestAttemptSha256s).toHaveLength(2);
    expect(completed.activeSha256).toBe(
      sha256Hex(JSON.stringify(JSON.parse(originalActive))),
    );

    let resumedCalls = 0;
    const resumed = await prepareHistoryCandidates({
      ...fixture.prepareOptions,
      resume: true,
      normalizer: {
        async normalize() {
          resumedCalls += 1;
          return normalizedOutput();
        },
      },
    });
    expect(resumedCalls).toBe(0);
    expect(resumed).toMatchObject({ complete: true, completedSourceCount: 1 });
  });

  it("恢复 active-only 的整理失败写入绑定失败回执并拒绝重复恢复", async () => {
    const fixture = await createActiveOnlyFixture("恢复失败的合成正文。");
    const result = await recoverActiveHistoryCandidate({
      ...fixture.prepareOptions,
      sourceId: "source-000001",
      normalizer: {
        preparationIdentity: fixedNormalizer().preparationIdentity,
        async normalize() {
          throw new HistoryNormalizationError("schema", "合成 schema 失败。");
        },
      },
    });

    expect(result).toMatchObject({
      status: "failed",
      failureKind: "schema",
      requestAttemptCount: 2,
    });
    const failed = JSON.parse(
      await readFile(join(fixture.prepareOutput, "requests", "source-000001.failed.json"), "utf8"),
    ) as {
      readonly activeSha256: string;
      readonly requestAttemptSha256s: readonly string[];
      readonly recoveryExecutorIdentity: { readonly codeSha256: string };
    };
    expect(failed.activeSha256).toBe(
      sha256Hex(
        JSON.stringify(
          JSON.parse(
            await readFile(
              join(fixture.prepareOutput, "requests", "source-000001.active.json"),
              "utf8",
            ),
          ),
        ),
      ),
    );
    expect(failed.requestAttemptSha256s).toHaveLength(2);
    expect(failed.recoveryExecutorIdentity).toEqual(
      fixedNormalizer().preparationIdentity,
    );
    await expect(
      recoverActiveHistoryCandidate({
        ...fixture.prepareOptions,
        sourceId: "source-000001",
        normalizer: fixedNormalizer(),
      }),
    ).rejects.toMatchObject({ code: "RECOVERY_REJECTED" });

    const resumed = await prepareHistoryCandidates({
      ...fixture.prepareOptions,
      resume: true,
      normalizer: fixedNormalizer(),
    });
    expect(resumed).toMatchObject({
      complete: false,
      completedSourceCount: 0,
      failedSourceCount: 1,
      pendingSourceCount: 0,
    });
  });

  it("拒绝已完成和 active 摘要不一致的恢复请求", async () => {
    const completedFixture = await createFixture("已完成恢复拒绝正文。");
    await prepareHistoryCandidates({
      ...completedFixture.prepareOptions,
      normalizer: fixedNormalizer(),
    });
    await expect(
      recoverActiveHistoryCandidate({
        ...completedFixture.prepareOptions,
        sourceId: "source-000001",
        normalizer: fixedNormalizer(),
      }),
    ).rejects.toMatchObject({ code: "RECOVERY_REJECTED" });

    const mismatchFixture = await createActiveOnlyFixture("摘要不一致恢复拒绝正文。");
    const activePath = join(
      mismatchFixture.prepareOutput,
      "requests",
      "source-000001.active.json",
    );
    const active = JSON.parse(await readFile(activePath, "utf8")) as Record<string, unknown>;
    await writeFile(
      activePath,
      `${JSON.stringify({ ...active, sourceIdentitySha256: "f".repeat(64) })}\n`,
      "utf8",
    );
    await expect(
      recoverActiveHistoryCandidate({
        ...mismatchFixture.prepareOptions,
        sourceId: "source-000001",
        normalizer: fixedNormalizer(),
      }),
    ).rejects.toMatchObject({ code: "PREPARE_RESUME_UNSAFE" });
  });

  it("旧版无检查点与运行标签不能续跑，但执行器变化不改变存储目标", async () => {
    const legacy = await createFixture("旧版合成输出。");
    await mkdir(legacy.prepareOutput, { mode: 0o700 });
    let called = false;
    await expect(
      prepareHistoryCandidates({
        ...legacy.prepareOptions,
        resume: true,
        normalizer: {
          async normalize() {
            called = true;
            return normalizedOutput();
          },
        },
      }),
    ).rejects.toMatchObject({ code: "PREPARE_RESUME_UNSAFE" });
    expect(called).toBe(false);

    const current = await createFixture("身份变化合成输出。");
    await prepareHistoryCandidates({
      ...current.prepareOptions,
      normalizer: fixedNormalizer(),
    });
    let resumedCompletedCall = false;
    await expect(
      prepareHistoryCandidates({
        ...current.prepareOptions,
        resume: true,
        normalizer: {
          async normalize() {
            resumedCompletedCall = true;
            return normalizedOutput();
          },
        },
      }),
    ).resolves.toMatchObject({ complete: true });
    expect(resumedCompletedCall).toBe(false);
    await expect(
      prepareHistoryCandidates({
        ...current.prepareOptions,
        resume: true,
        operationTag: "different-run-tag",
        normalizer: fixedNormalizer(),
      }),
    ).rejects.toMatchObject({ code: "PREPARE_RESUME_UNSAFE" });
    await expect(
      prepareHistoryCandidates({
        ...current.prepareOptions,
        resume: true,
        executorIdentity: {
          ...current.prepareOptions.executorIdentity,
          configSha256: "5".repeat(64),
        },
        normalizer: fixedNormalizer(),
      }),
    ).resolves.toMatchObject({ complete: true });
  });
  it("current95 stored target with later executor identity is a targeted red case", async () => {
    const fixture = await createFixture("current95 身份分离回归正文。");
    await prepareHistoryCandidates({
      ...fixture.prepareOptions,
      normalizer: fixedNormalizer(),
    });
    let resumedCalls = 0;
    await expect(
      prepareHistoryCandidates({
        ...fixture.prepareOptions,
        resume: true,
        executorIdentity: {
          ...fixture.prepareOptions.executorIdentity,
          configSha256: "5".repeat(64),
        },
        normalizer: {
          async normalize() {
            resumedCalls += 1;
            return normalizedOutput();
          },
        },
      }),
    ).resolves.toMatchObject({ complete: true });
    expect(resumedCalls).toBe(0);
  });
  it("续跑待处理源记录后来执行器并保留原目标运行摘要", async () => {
    const fixture = await createFixture("续跑执行器证据正文。");
    await prepareHistoryCandidates({
      ...fixture.prepareOptions,
      normalizer: fixedNormalizer(),
    });
    await resetPreparedSourcesToPending(fixture);
    const laterExecutor = {
      ...fixture.prepareOptions.executorIdentity,
      configSha256: "5".repeat(64),
    };
    await expect(
      prepareHistoryCandidates({
        ...fixture.prepareOptions,
        resume: true,
        executorIdentity: laterExecutor,
        normalizer: fixedNormalizer(),
      }),
    ).resolves.toMatchObject({ complete: true });
    const run = JSON.parse(
      await readFile(join(fixture.prepareOutput, "run.json"), "utf8"),
    ) as { readonly executionIdentity: unknown };
    const active = JSON.parse(
      await readFile(join(fixture.prepareOutput, "requests", "source-000001.active.json"), "utf8"),
    ) as {
      readonly executionIdentitySha256: string;
      readonly executorIdentity: unknown;
    };
    const completed = JSON.parse(
      await readFile(
        join(fixture.prepareOutput, "requests", "source-000001.completed.json"),
        "utf8",
      ),
    ) as { readonly executorIdentity: unknown };
    expect(run.executionIdentity).toEqual(fixture.prepareOptions.executorIdentity);
    expect(active.executionIdentitySha256).toBe(
      sha256Hex(JSON.stringify(fixture.prepareOptions.executorIdentity)),
    );
    expect(active.executorIdentity).toEqual(laterExecutor);
    expect(completed.executorIdentity).toEqual(laterExecutor);
  });

  it("续跑源校验失败仍记录后来执行器且不伪造目标回执", async () => {
    const fixture = await createFixture("续跑失败执行器证据正文。");
    await prepareHistoryCandidates({
      ...fixture.prepareOptions,
      normalizer: fixedNormalizer(),
    });
    await resetPreparedSourcesToPending(fixture);
    await writeFile(
      join(fixture.sourceDirectory, syntheticSourceName),
      "续跑时被替换的正文。",
      "utf8",
    );
    const laterExecutor = {
      ...fixture.prepareOptions.executorIdentity,
      configSha256: "6".repeat(64),
    };
    const result = await prepareHistoryCandidates({
      ...fixture.prepareOptions,
      resume: true,
      executorIdentity: laterExecutor,
      normalizer: fixedNormalizer(),
    });
    expect(result).toMatchObject({
      complete: false,
      failedSourceCount: 1,
      pendingSourceCount: 0,
    });
    const failed = JSON.parse(
      await readFile(join(fixture.prepareOutput, "requests", "source-000001.failed.json"), "utf8"),
    ) as {
      readonly activeSha256: string | null;
      readonly executorIdentity: unknown;
    };
    expect(failed.activeSha256).toBeNull();
    expect(failed.executorIdentity).toEqual(laterExecutor);
  });

  it("续跑拒绝被改写的原请求摘要", async () => {
    const fixture = await createFixture("续跑摘要拒绝正文。");
    await prepareHistoryCandidates({
      ...fixture.prepareOptions,
      normalizer: fixedNormalizer(),
    });
    const activePath = join(fixture.prepareOutput, "requests", "source-000001.active.json");
    const active = JSON.parse(await readFile(activePath, "utf8")) as Record<string, unknown>;
    await writeFile(
      activePath,
      `${JSON.stringify({ ...active, executionIdentitySha256: "f".repeat(64) })}\n`,
      "utf8",
    );
    await expect(
      prepareHistoryCandidates({
        ...fixture.prepareOptions,
        resume: true,
        executorIdentity: {
          ...fixture.prepareOptions.executorIdentity,
          configSha256: "7".repeat(64),
        },
        normalizer: fixedNormalizer(),
      }),
    ).rejects.toMatchObject({ code: "PREPARE_RESUME_UNSAFE" });
  });


  it("续跑拒绝权限被放宽的目录或检查点", async () => {
    const fileFixture = await createFixture("权限检查合成正文一。");
    await prepareHistoryCandidates({
      ...fileFixture.prepareOptions,
      normalizer: fixedNormalizer(),
    });
    await chmod(join(fileFixture.prepareOutput, "run.json"), 0o644);
    await expect(
      prepareHistoryCandidates({
        ...fileFixture.prepareOptions,
        resume: true,
        normalizer: fixedNormalizer(),
      }),
    ).rejects.toMatchObject({ code: "PREPARE_RESUME_UNSAFE" });

    const directoryFixture = await createFixture("权限检查合成正文二。");
    await prepareHistoryCandidates({
      ...directoryFixture.prepareOptions,
      normalizer: fixedNormalizer(),
    });
    await chmod(join(directoryFixture.prepareOutput, "requests"), 0o755);
    await expect(
      prepareHistoryCandidates({
        ...directoryFixture.prepareOptions,
        resume: true,
        normalizer: fixedNormalizer(),
      }),
    ).rejects.toMatchObject({ code: "PREPARE_RESUME_UNSAFE" });
  });

  it("源文件内容变化后使第一份人工确认失效", async () => {
    const fixture = await createFixture("确认时的合成正文。");
    await writeFile(
      join(fixture.sourceDirectory, syntheticSourceName),
      "确认后被修改的合成正文。",
      "utf8",
    );

    const result = await prepareHistoryCandidates({
      ...fixture.prepareOptions,
      normalizer: fixedNormalizer(),
    });
    expect(result).toMatchObject({
      complete: false,
      failedSourceCount: 1,
    });
    await expectFailureKind(fixture.prepareOutput, "source_validation");
  });

  it("作者归属等元数据变化后使第一份人工确认失效", async () => {
    const fixture = await createFixture("确认时的合成正文。");
    const metadata = JSON.parse(await readFile(fixture.prepareOptions.metadataFile, "utf8")) as {
      records: Array<Record<string, unknown>>;
    };
    metadata.records[0] = {
      ...metadata.records[0],
      authorStudentId: "SYNTHETIC-STUDENT-CHANGED",
    };
    await writeFile(
      fixture.prepareOptions.metadataFile,
      `${JSON.stringify(metadata, null, 2)}\n`,
      "utf8",
    );

    await expect(
      prepareHistoryCandidates({
        ...fixture.prepareOptions,
        normalizer: fixedNormalizer(),
      }),
    ).rejects.toMatchObject({
      code: "SOURCE_MAPPING_CHANGED",
    });
  });

  it("候选内容变化后使第二份人工批准失效", async () => {
    const fixture = await createPreparedFixture();
    const candidate = await readCandidate(fixture.prepareOutput);
    await writeApproval(fixture.approvalFile, candidate.candidateId, candidate.contentSha256);
    const changed = {
      ...candidate,
      problem: {
        ...candidate.problem,
        content: {
          ...candidate.problem.content,
          basicStatement: "批准后被修改的合成题面。",
        },
      },
    };
    await writeFile(
      join(fixture.prepareOutput, "candidates", `${candidate.candidateId}.json`),
      `${JSON.stringify(changed, null, 2)}\n`,
      "utf8",
    );

    await expect(packageApprovedCandidates(fixture.packageOptions)).rejects.toMatchObject({
      code: "CANDIDATE_CHANGED",
    });
  });

  it("打包拒绝旧版完成标记或仍带不完整标记的 prepare 输出", async () => {
    const incomplete = await createPreparedFixture();
    const incompleteCandidate = await readCandidate(incomplete.prepareOutput);
    await writeApproval(
      incomplete.approvalFile,
      incompleteCandidate.candidateId,
      incompleteCandidate.contentSha256,
    );
    await copyFile(
      join(incomplete.prepareOutput, "PREPARE_RUN"),
      join(incomplete.prepareOutput, "PREPARE_INCOMPLETE"),
    );
    await expect(packageApprovedCandidates(incomplete.packageOptions)).rejects.toMatchObject({
      code: "CANDIDATE_INVALID",
    });

    const legacy = await createPreparedFixture();
    const legacyCandidate = await readCandidate(legacy.prepareOutput);
    await writeApproval(
      legacy.approvalFile,
      legacyCandidate.candidateId,
      legacyCandidate.contentSha256,
    );
    await writeFile(
      join(legacy.prepareOutput, "PREPARE_COMPLETE"),
      `${JSON.stringify({
        version: 1,
        phase: "prepare",
        batchSha256: "a".repeat(64),
        candidateCount: 1,
      })}\n`,
      "utf8",
    );
    await expect(packageApprovedCandidates(legacy.packageOptions)).rejects.toMatchObject({
      code: "CANDIDATE_INVALID",
    });
  });

  it("候选审核备注变化后也使第二份人工批准失效", async () => {
    const fixture = await createPreparedFixture();
    const candidate = await readCandidate(fixture.prepareOutput);
    await writeApproval(fixture.approvalFile, candidate.candidateId, candidate.contentSha256);
    await writeFile(
      join(fixture.prepareOutput, "candidates", `${candidate.candidateId}.json`),
      `${JSON.stringify(
        {
          ...candidate,
          normalizationNote: "批准后被修改的合成审核备注。",
        },
        null,
        2,
      )}\n`,
      "utf8",
    );

    await expect(packageApprovedCandidates(fixture.packageOptions)).rejects.toMatchObject({
      code: "CANDIDATE_CHANGED",
    });
  });

  it("模型置信度变化后也使第二份人工批准失效", async () => {
    const fixture = await createPreparedFixture();
    const candidate = await readCandidate(fixture.prepareOutput);
    await writeApproval(fixture.approvalFile, candidate.candidateId, candidate.contentSha256);
    await writeFile(
      join(fixture.prepareOutput, "candidates", `${candidate.candidateId}.json`),
      `${JSON.stringify(
        {
          ...candidate,
          modelConfidence: 0.1,
        },
        null,
        2,
      )}\n`,
      "utf8",
    );

    await expect(packageApprovedCandidates(fixture.packageOptions)).rejects.toMatchObject({
      code: "CANDIDATE_CHANGED",
    });
  });

  it("准备后原始文本变化时打包阶段重新核对并停止", async () => {
    const fixture = await createPreparedFixture();
    const candidate = await readCandidate(fixture.prepareOutput);
    await writeApproval(fixture.approvalFile, candidate.candidateId, candidate.contentSha256);
    await writeFile(
      join(fixture.sourceDirectory, syntheticSourceName),
      "准备阶段之后被修改的合成正文。",
      "utf8",
    );

    await expect(packageApprovedCandidates(fixture.packageOptions)).rejects.toMatchObject({
      code: "SOURCE_DIGEST_MISMATCH",
    });
  });

  it("拒绝从指向私有根目录外的候选子目录读取文件", async () => {
    const fixture = await createPreparedFixture();
    const candidate = await readCandidate(fixture.prepareOutput);
    await writeApproval(fixture.approvalFile, candidate.candidateId, candidate.contentSha256);
    const outsideDirectory = await mkdtemp(join(tmpdir(), "urmotiv-history-outside-"));
    temporaryDirectories.push(outsideDirectory);
    await copyFile(
      join(fixture.prepareOutput, "candidates", `${candidate.candidateId}.json`),
      join(outsideDirectory, `${candidate.candidateId}.json`),
    );
    await rm(join(fixture.prepareOutput, "candidates"), {
      recursive: true,
      force: true,
    });
    await symlink(outsideDirectory, join(fixture.prepareOutput, "candidates"), "dir");

    await expect(packageApprovedCandidates(fixture.packageOptions)).rejects.toMatchObject({
      code: "INVALID_ARGUMENTS",
    });
  });

  it("已知学号出现在模型结果时拒绝生成候选", async () => {
    const modelLeakFixture = await createFixture("只用于合成测试的源正文。");
    const result = await prepareHistoryCandidates({
      ...modelLeakFixture.prepareOptions,
      normalizer: {
        async normalize() {
          return {
            problems: [
              {
                ...normalizedProblem("合成候选题"),
                basicStatement: `不应进入候选的标识：${syntheticStudentId}`,
              },
            ],
          };
        },
      },
    });
    expect(result).toMatchObject({
      complete: false,
      failedSourceCount: 1,
    });
    await expectFailureKind(modelLeakFixture.prepareOutput, "candidate_validation");
  });

  it("元数据题名和难度都不进入整理器、候选难度或扩展字段", async () => {
    const fixture = await createFixture("另一份只用于合成测试的源正文。");
    let normalizerInput: unknown;
    await prepareHistoryCandidates({
      ...fixture.prepareOptions,
      normalizer: {
        async normalize(input) {
          normalizerInput = input;
          return normalizedOutput();
        },
      },
    });

    expect(normalizerInput).not.toHaveProperty("difficultyGuess");
    expect(normalizerInput).not.toHaveProperty("expectedTitle");
    expect(JSON.stringify(normalizerInput)).not.toContain(syntheticMetadataTitle);
    const candidate = await readCandidate(fixture.prepareOutput);
    expect(candidate.problem.difficulty).toEqual({});
    expect(candidate.problem.extensions).toEqual({});
    expect(JSON.stringify(candidate)).not.toContain(syntheticMetadataTitle);
  });

  it("拒绝写出超过后续读取上限的候选，不留下完成标记", async () => {
    const fixture = await createFixture("只用于合成测试的源正文。");
    const oversized = "甲".repeat(500_000);
    const result = await prepareHistoryCandidates({
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
                hints: oversized,
              },
            ],
          };
        },
      },
    });
    expect(result).toMatchObject({
      complete: false,
      failedSourceCount: 1,
    });
    await expectFailureKind(fixture.prepareOutput, "candidate_validation");
    await expect(
      readFile(join(fixture.prepareOutput, "PREPARE_COMPLETE"), "utf8"),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("即使人工编辑候选，也拒绝把作者学号塞进扩展字段", async () => {
    const fixture = await createPreparedFixture();
    const candidate = await readCandidate(fixture.prepareOutput);
    await writeApproval(fixture.approvalFile, candidate.candidateId, candidate.contentSha256);
    const unsafe = {
      ...candidate,
      problem: {
        ...candidate.problem,
        extensions: {
          migration: {
            difficultyText: "",
            authorStudentId: syntheticStudentId,
          },
        },
      },
    };
    await writeFile(
      join(fixture.prepareOutput, "candidates", `${candidate.candidateId}.json`),
      `${JSON.stringify(unsafe, null, 2)}\n`,
      "utf8",
    );

    await expect(packageApprovedCandidates(fixture.packageOptions)).rejects.toMatchObject({
      code: "CANDIDATE_INVALID",
    });
  });

  it("人工写入难度并重算摘要、重新批准后仍拒绝候选", async () => {
    const fixture = await createPreparedFixture();
    const candidate = await readCandidate(fixture.prepareOutput);
    const problem = {
      ...candidate.problem,
      difficulty: { codeforces: 3200 },
    };
    const contentSha256 = sha256Hex(
      JSON.stringify({
        sourceId: candidate.sourceId,
        sourceContentSha256: candidate.sourceContentSha256,
        sourceMappingSha256: candidate.sourceMappingSha256,
        modelConfidence: candidate.modelConfidence,
        normalizationNote: candidate.normalizationNote,
        problem,
      }),
    );
    await writeFile(
      join(fixture.prepareOutput, "candidates", `${candidate.candidateId}.json`),
      `${JSON.stringify({ ...candidate, contentSha256, problem }, null, 2)}\n`,
      "utf8",
    );
    await writeApproval(fixture.approvalFile, candidate.candidateId, contentSha256);

    await expect(packageApprovedCandidates(fixture.packageOptions)).rejects.toMatchObject({
      code: "CANDIDATE_INVALID",
    });
  });

  it("拒绝把同一份已确认源文件拆出的多个候选重复分配给一条元数据", async () => {
    const fixture = await createFixture("包含两道合成题的源正文。");
    await prepareHistoryCandidates({
      ...fixture.prepareOptions,
      normalizer: {
        async normalize() {
          return {
            problems: [normalizedProblem("第一道合成题"), normalizedProblem("第二道合成题")],
          };
        },
      },
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
              decision: "approved",
            },
            {
              candidateId: second.candidateId,
              contentSha256: second.contentSha256,
              decision: "approved",
            },
          ],
        },
        null,
        2,
      )}\n`,
      "utf8",
    );

    await expect(packageApprovedCandidates(fixture.packageOptions)).rejects.toMatchObject({
      code: "DUPLICATE_ASSIGNMENT",
    });
  });

  it("来源验证与打包接受目标与恢复执行器的混合证据", async () => {
    const fixture = await createActiveOnlyFixture("混合执行器证据打包正文。");
    await expect(
      recoverActiveHistoryCandidate({
        ...fixture.prepareOptions,
        sourceId: "source-000001",
        normalizer: fixedNormalizer(),
      }),
    ).resolves.toMatchObject({ status: "completed" });
    const candidate = await readCandidate(fixture.prepareOutput);
    await expect(
      prepareHistoryCandidates({
        ...fixture.prepareOptions,
        resume: true,
        normalizer: fixedNormalizer(),
      }),
    ).resolves.toMatchObject({ complete: true });
    await writeApproval(fixture.approvalFile, candidate.candidateId, candidate.contentSha256);
    const authoritative = await verifyApprovedPackageSourceIdentities({
      privateRootDirectory: fixture.packageOptions.privateRootDirectory,
      materializedDirectory: fixture.packageOptions.materializedDirectory,
      metadataFile: fixture.packageOptions.metadataFile,
      preparedDirectory: fixture.packageOptions.preparedDirectory,
      approvalFile: fixture.packageOptions.approvalFile,
    });
    expect(authoritative).toHaveLength(1);
    await expect(packageApprovedCandidates(fixture.packageOptions)).resolves.toMatchObject({
      packageCount: 1,
      authorMappingCount: 1,
    });
  });

  it("批准后才生成题目包，作者学号只进入单独私有映射文件", async () => {
    const fixture = await createPreparedFixture();
    const candidate = await readCandidate(fixture.prepareOutput);
    await writeApproval(fixture.approvalFile, candidate.candidateId, candidate.contentSha256);

    const result = await packageApprovedCandidates(fixture.packageOptions);
    expect(result).toEqual({ packageCount: 1, authorMappingCount: 1 });

    const packagePath = join(fixture.packageOutput, "packages", "candidate-000001.zip");
    const archive = readZipArchive(new Uint8Array(await readFile(packagePath)));
    const imported = await urmotivNativeAdapter.import(archive, {
      conflictAction: "create",
    });
    expect(imported.extensions).toEqual({});
    expect(imported.provenance).toEqual({
      sourceSystem: "ustc-history-private",
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

    const reportText = await readFile(join(fixture.packageOutput, "report.json"), "utf8");
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
    expect(authorMap.records[0]?.contentSha256).toBe(report.packages[0]?.contentSha256);
    expect(authorMap.records[0]?.packageSha256).toBe(report.packages[0]?.packageSha256);
  });

  it("核心打包器重新验证附件能力，批次内部保全附件进入独立保全目录", async () => {
    const fixture = await createPreparedFixture();
    const candidate = await readCandidate(fixture.prepareOutput);
    await writeApproval(fixture.approvalFile, candidate.candidateId, candidate.contentSha256);
    const attachmentMappingCapability = await createAttachmentMappingCapability({
      root: fixture.root,
      sourceDirectory: fixture.sourceDirectory,
      metadataFile: fixture.prepareOptions.metadataFile,
      includeAttachment: true,
    });
    await rewriteFixtureMaterializationBatch(fixture, attachmentMappingCapability);

    const result = await packageApprovedCandidates({
      ...fixture.packageOptions,
      attachmentMappingCapability,
    });
    expect(result).toEqual({
      packageCount: 1,
      authorMappingCount: 1,
      attachmentCount: 1,
      preservedMaterialCount: 1,
    });

    // 批次内部保全材料只进入独立保全目录，不进入题目包 ZIP。
    const preservedBytes = await readFile(
      join(
        fixture.packageOutput,
        "internal",
        "preservation",
        "internal",
        "attachment-000001.bin",
      ),
    );
    expect(new Uint8Array(preservedBytes)).toEqual(new Uint8Array([1, 2, 3, 4]));

    const packagePath = join(fixture.packageOutput, "packages", "candidate-000001.zip");
    const archive = readZipArchive(new Uint8Array(await readFile(packagePath)));
    for (const entry of archive.list()) {
      expect(entry.path).not.toMatch(/^attachments\//);
      expect(entry.path).not.toMatch(/^internal\//);
      expect(entry.path).not.toContain("attachment-000001");
    }

    const reportText = await readFile(join(fixture.packageOutput, "report.json"), "utf8");
    expect(reportText).not.toContain(syntheticStudentId);
    expect(reportText).not.toContain(syntheticSourceName);
    expect(reportText).not.toContain(syntheticMetadataTitle);
    const report = JSON.parse(reportText) as {
      attachmentCount: number;
      preservedMaterialCount: number;
      preservedMaterials: Array<{ attachmentId: string; preservationPath: string }>;
    };
    expect(report.attachmentCount).toBe(1);
    expect(report.preservedMaterialCount).toBe(1);
    expect(report.preservedMaterials[0]?.attachmentId).toBe("attachment-000001");
    expect(report.preservedMaterials[0]?.preservationPath).toBe(
      "preservation/internal/attachment-000001.bin",
    );

    const authorMapText = await readFile(fixture.authorMappingOutput, "utf8");
    expect(authorMapText).toContain("candidate-000001");
    expect(authorMapText).toContain(syntheticStudentId);
  });

  it("核心打包器拒绝把同 metadata 的零附件能力跨 grouping 用于含附件物化批次", async () => {
    const fixture = await createPreparedFixture();
    const candidate = await readCandidate(fixture.prepareOutput);
    await writeApproval(fixture.approvalFile, candidate.candidateId, candidate.contentSha256);
    const zeroAttachmentCapability = fixture.packageOptions.attachmentMappingCapability;
    const nonemptyOtherBatch = await createAttachmentMappingCapability({
      root: fixture.root,
      sourceDirectory: fixture.sourceDirectory,
      metadataFile: fixture.prepareOptions.metadataFile,
      includeAttachment: true,
    });
    await rewriteFixtureMaterializationBatch(fixture, nonemptyOtherBatch);

    await expect(
      packageApprovedCandidates({
        ...fixture.packageOptions,
        attachmentMappingCapability: zeroAttachmentCapability,
      }),
    ).rejects.toMatchObject({ code: "ATTACHMENT_MAPPING_CHANGED" });
    await expect(stat(fixture.packageOutput)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(stat(fixture.authorMappingOutput)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("核心打包器拒绝复制字段伪造的附件能力", async () => {
    const fixture = await createPreparedFixture();
    const candidate = await readCandidate(fixture.prepareOutput);
    await writeApproval(fixture.approvalFile, candidate.candidateId, candidate.contentSha256);
    const forgedCapability = {
      ...fixture.packageOptions.attachmentMappingCapability,
    } as HistoryAttachmentMappingCapability;

    await expect(
      packageApprovedCandidates({
        ...fixture.packageOptions,
        attachmentMappingCapability: forgedCapability,
      }),
    ).rejects.toMatchObject({ code: "INVALID_ATTACHMENT_MAPPING_CAPABILITY" });
    await expect(stat(fixture.packageOutput)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(stat(fixture.authorMappingOutput)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("附件能力签发后 grouping 确认变化时核心重新扫描并拒绝", async () => {
    const fixture = await createPreparedFixture();
    const candidate = await readCandidate(fixture.prepareOutput);
    await writeApproval(fixture.approvalFile, candidate.candidateId, candidate.contentSha256);
    await writeFile(
      join(fixture.root, "attachment-gate-empty-grouping-confirmation.private.json"),
      '{"changed":true}\n',
      "utf8",
    );

    await expect(packageApprovedCandidates(fixture.packageOptions)).rejects.toMatchObject({
      code: "INVALID_SOURCE_CONFIRMATION",
    });
    await expect(stat(fixture.packageOutput)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(stat(fixture.authorMappingOutput)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("作者映射不能写进题目包输出目录", async () => {
    const fixture = await createPreparedFixture();
    const candidate = await readCandidate(fixture.prepareOutput);
    await writeApproval(fixture.approvalFile, candidate.candidateId, candidate.contentSha256);

    await expect(
      packageApprovedCandidates({
        ...fixture.packageOptions,
        authorMappingOutput: join(fixture.packageOutput, "author-map.json"),
      }),
    ).rejects.toMatchObject({
      code: "INVALID_ARGUMENTS",
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
          },
        }),
        { status: 200, headers: { "Content-Type": "text/event-stream" } },
      );
    });
    const normalizer = createLlmHistoryNormalizer({
      baseUrl: "https://synthetic.invalid/v1/",
      apiKey: "synthetic-key",
      model: "synthetic-model",
      codeSha256: "f".repeat(64),
      firstOutputTimeoutMs: 20,
      outputIdleTimeoutMs: 20,
      maximumAttempts: 1,
      maximumResponseBytes: 1_000,
      fetch,
    });

    await expect(
      normalizer.normalize({
        sourceId: "source-000001",
        text: "合成正文",
      }),
    ).rejects.toMatchObject({
      code: "NORMALIZATION_FAILED",
      message: "source-000001 的模型请求在首段有效输出前超时。",
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
      codeSha256: "f".repeat(64),
      firstOutputTimeoutMs: 1_000,
      outputIdleTimeoutMs: 1_000,
      maximumAttempts: 1,
      maximumResponseBytes: 32,
      fetch,
    });

    let caught: unknown;
    try {
      await normalizer.normalize({
        sourceId: "source-000001",
        text: "合成正文",
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).toMatchObject({
      code: "NORMALIZATION_FAILED",
      message: "模型响应超过明确大小上限。",
    });
    expect(String(caught)).not.toContain(privateMarker);
  });
});

async function createFixture(sourceText: string): Promise<{
  readonly root: string;
  readonly sourceDirectory: string;
  readonly materializedDirectory: string;
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
    readonly operationTag: string;
    readonly executorIdentity: {
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
}> {
  const root = await mkdtemp(join(tmpdir(), "urmotiv-history-migration-"));
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
  const metadataText = `${JSON.stringify(
    {
      records: [metadataRecord],
    },
    null,
    2,
  )}\n`;
  await writeFile(metadataFile, metadataText, "utf8");
  const sourceConfirmationFile = join(materializedDirectory, "source-confirmation.private.json");
  const prepareOutput = join(root, "prepared");
  const approvalFile = join(root, "candidate-approval.private.json");
  const packageOutput = join(root, "packaged");
  const authorMappingOutput = join(root, "author-map.private.json");
  const attachmentMappingCapability = await createAttachmentMappingCapability({
    root,
    sourceDirectory,
    metadataFile,
  });
  await writeSyntheticMaterialization({
    materializedDirectory,
    sourceText,
    metadataFileSha256: sha256Hex(metadataText),
    groupingBatchSha256: attachmentMappingCapability.groupingBatchSha256,
  });

  return {
    root,
    sourceDirectory,
    materializedDirectory,
    prepareOutput,
    approvalFile,
    packageOutput,
    authorMappingOutput,
    prepareOptions: {
      privateRootDirectory: root,
      sourceDirectory,
      metadataFile,
      sourceConfirmationFile,
      outputDirectory: prepareOutput,
      operationTag: "synthetic-run-001",
      executorIdentity: {
        version: 1,
        codeSha256: "1".repeat(64),
        promptSha256: "2".repeat(64),
        modelSha256: "3".repeat(64),
        configSha256: "4".repeat(64),
      },
    },
    packageOptions: {
      privateRootDirectory: root,
      materializedDirectory,
      metadataFile,
      preparedDirectory: prepareOutput,
      approvalFile,
      outputDirectory: packageOutput,
      authorMappingOutput,
      attachmentMappingCapability,
      exportedAt: "2026-07-30T00:00:00.000Z",
    },
  };
}

async function createActiveOnlyFixture(sourceText: string) {
  const fixture = await createFixture(sourceText);
  const requests = join(fixture.prepareOutput, "requests");
  const heldRequests = join(fixture.prepareOutput, "requests-held");
  const outsideDirectory = await mkdtemp(join(tmpdir(), "urmotiv-history-recovery-outside-"));
  temporaryDirectories.push(outsideDirectory);

  await expect(
    prepareHistoryCandidates({
      ...fixture.prepareOptions,
      normalizer: {
        async normalize() {
          await rename(requests, heldRequests);
          await symlink(outsideDirectory, requests, "dir");
          throw new HistoryNormalizationError("connection", "合成连接状态未知。");
        },
      },
    }),
  ).rejects.toMatchObject({ code: "INVALID_ARGUMENTS" });
  await rm(requests, { force: true });
  await rename(heldRequests, requests);
  return fixture;
}
async function resetPreparedSourcesToPending(
  fixture: Awaited<ReturnType<typeof createFixture>>,
): Promise<void> {
  for (const name of ["candidates", "requests", "reports"]) {
    const path = join(fixture.prepareOutput, name);
    await rm(path, { recursive: true, force: true });
    await mkdir(path, { mode: 0o700 });
  }
}

async function writeSyntheticMaterialization(options: {
  readonly materializedDirectory: string;
  readonly sourceText: string;
  readonly metadataFileSha256: string;
  readonly groupingBatchSha256: string;
}): Promise<void> {
  const sourceSha256 = sha256Hex(options.sourceText);
  const byteLength = new TextEncoder().encode(options.sourceText).byteLength;
  const sourceConfirmation = {
    version: 1,
    confirmed: true,
    metadataFileSha256: options.metadataFileSha256,
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
    groupingBatchSha256: options.groupingBatchSha256,
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
        characterCount: options.sourceText.length,
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
    groupingBatchSha256: options.groupingBatchSha256,
    sourceCount: 1,
    fragmentCount: 1,
    unresolvedItemCount: 0,
  };
  await writeFile(
    join(options.materializedDirectory, "source-confirmation.private.json"),
    `${JSON.stringify(sourceConfirmation, null, 2)}\n`,
    "utf8",
  );
  await writeFile(
    join(options.materializedDirectory, "report.json"),
    `${JSON.stringify(report, null, 2)}\n`,
    "utf8",
  );
  await writeFile(
    join(options.materializedDirectory, "MATERIALIZE_COMPLETE"),
    `${JSON.stringify(marker, null, 2)}\n`,
    "utf8",
  );
  // 真实物化流程写出的私有文件都是 0600 且归当前用户；合成夹具必须一致，
  // 否则稳定句柄读取会按不安全状态拒绝。
  await chmod(join(options.materializedDirectory, "source-confirmation.private.json"), 0o600);
  await chmod(join(options.materializedDirectory, "report.json"), 0o600);
  await chmod(join(options.materializedDirectory, "MATERIALIZE_COMPLETE"), 0o600);
}

async function rewriteFixtureMaterializationBatch(
  fixture: Awaited<ReturnType<typeof createFixture>>,
  capability: HistoryAttachmentMappingCapability,
): Promise<void> {
  const sourceText = await readFile(join(fixture.sourceDirectory, syntheticSourceName), "utf8");
  const metadataBytes = await readFile(fixture.prepareOptions.metadataFile);
  await writeSyntheticMaterialization({
    materializedDirectory: fixture.materializedDirectory,
    sourceText,
    metadataFileSha256: sha256Hex(metadataBytes),
    groupingBatchSha256: capability.groupingBatchSha256,
  });
}

async function createPreparedFixture(): Promise<Awaited<ReturnType<typeof createFixture>>> {
  const fixture = await createFixture("只用于合成测试的源正文。");
  await prepareHistoryCandidates({
    ...fixture.prepareOptions,
    normalizer: fixedNormalizer(),
  });
  return fixture;
}

async function createAttachmentMappingCapability(options: {
  readonly root: string;
  readonly sourceDirectory: string;
  readonly metadataFile: string;
  readonly includeAttachment?: boolean;
}): Promise<HistoryAttachmentMappingCapability> {
  const gatePrefix =
    options.includeAttachment === true ? "attachment-gate-nonempty" : "attachment-gate-empty";
  const gateSourceDirectory = join(options.root, `${gatePrefix}-sources`);
  await mkdir(gateSourceDirectory, { mode: 0o700 });
  const requestedGateText = await readFile(
    join(options.sourceDirectory, syntheticSourceName),
    "utf8",
  );
  await writeFile(
    join(gateSourceDirectory, syntheticSourceName),
    requestedGateText.length <= 500_000
      ? requestedGateText
      : "只用于超限反例的合成附件完成门短文本。",
    "utf8",
  );
  if (options.includeAttachment === true) {
    await writeFile(
      join(gateSourceDirectory, "synthetic-preserved.bin"),
      new Uint8Array([1, 2, 3, 4]),
    );
  }
  const catalogDirectory = join(options.root, `${gatePrefix}-catalog`);
  await inventoryHistorySources({
    privateRootDirectory: options.root,
    sourceDirectory: gateSourceDirectory,
    outputDirectory: catalogDirectory,
  });
  const sourceInventoryFile = join(catalogDirectory, "inventory.json");
  const sourceLocationsFile = join(catalogDirectory, "source-locations.private.json");
  const locations = JSON.parse(
    await readFile(sourceLocationsFile, "utf8"),
  ) as HistorySourceLocations;
  const source = locations.sources.find((item) => item.sourcePath === syntheticSourceName);
  if (source === undefined) throw new Error("合成附件完成门缺少源文件。");
  const manualSource = locations.sources.find(
    (item) => item.sourcePath === "synthetic-preserved.bin",
  );
  const groupingPlan: HistoryGroupingPlan = {
    version: 2,
    fragments: [
      {
        fragmentId: "fragment-000001",
        sourceId: source.sourceId,
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
    zipEntryDispositions: [],
    textRangeDispositions: [],
    manualSourceDispositions:
      manualSource === undefined
        ? []
        : [
            {
              sourceId: manualSource.sourceId,
              action: "attachment",
              reason: "人工确认合成二进制材料需要批次内部保全。",
              confirmed: true,
            },
          ],
  };
  const groupingPlanFile = join(options.root, `${gatePrefix}-grouping-plan.private.json`);
  await writeFile(groupingPlanFile, `${JSON.stringify(groupingPlan, null, 2)}\n`, "utf8");
  await chmod(groupingPlanFile, 0o600);
  const groupingDirectory = join(options.root, `${gatePrefix}-grouping`);
  await sealHistoryGrouping({
    privateRootDirectory: options.root,
    sourceDirectory: gateSourceDirectory,
    sourceInventoryFile,
    sourceLocationsFile,
    metadataFile: options.metadataFile,
    groupingPlanFile,
    outputDirectory: groupingDirectory,
  });
  const groupingConfirmationFile = join(
    options.root,
    `${gatePrefix}-grouping-confirmation.private.json`,
  );
  await writeHistoryGroupingConfirmation({
    privateRootDirectory: options.root,
    sourceInventoryFile,
    sourceLocationsFile,
    metadataFile: options.metadataFile,
    groupingDirectory,
    outputFile: groupingConfirmationFile,
    confirmed: true,
  });
  const contextOptions = {
    privateRootDirectory: options.root,
    sourceDirectory: gateSourceDirectory,
    sourceInventoryFile,
    sourceLocationsFile,
    metadataFile: options.metadataFile,
    groupingDirectory,
    groupingConfirmationFile,
  };
  const worksheetDirectory = join(options.root, `${gatePrefix}-worksheet`);
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
    }>;
  };
  const expectedAttachmentCount = options.includeAttachment === true ? 1 : 0;
  if (worksheet.attachments.length !== expectedAttachmentCount) {
    throw new Error("合成附件完成门的附件计数不正确。");
  }
  const mappingPlanFile = join(options.root, `${gatePrefix}-plan.private.json`);
  const mappingItem = worksheet.attachments[0];
  await writeFile(
    mappingPlanFile,
    `${JSON.stringify(
      {
        version: 1,
        confirmed: true,
        worksheetSha256: sha256Hex(JSON.stringify(worksheet)),
        mappings:
          mappingItem === undefined
            ? []
            : [
                {
                  attachmentId: mappingItem.attachmentId,
                  sourceBindingSha256: mappingItem.sourceBindingSha256,
                  status: "resolved",
                  semanticRole: "authoring_material",
                  visibility: "internal",
                  scope: {
                    kind: "batch_internal",
                    targetName: `${mappingItem.attachmentId}.bin`,
                  },
                  reviewNote: "人工确认仅作合成批次内部保全。",
                  confirmed: true,
                },
              ],
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  await chmod(mappingPlanFile, 0o600);
  const attachmentMappingDirectory = join(options.root, `${gatePrefix}-mapping`);
  await sealHistoryAttachmentMapping({
    ...contextOptions,
    worksheetDirectory,
    mappingPlanFile,
    outputDirectory: attachmentMappingDirectory,
  });
  return assertHistoryAttachmentMappingComplete({
    ...contextOptions,
    attachmentMappingDirectory,
  });
}

async function createMultiFixture(): Promise<Awaited<ReturnType<typeof createFixture>>> {
  const fixture = await createFixture("第一份合成正文。");
  const sources = [
    { path: syntheticSourceName, text: "第一份合成正文。", number: "synthetic-1" },
    { path: "synthetic-extra-two.md", text: "第二份合成正文。", number: "synthetic-2" },
    { path: "synthetic-extra-three.md", text: "第三份合成正文。", number: "synthetic-3" },
  ] as const;
  for (const source of sources.slice(1)) {
    await writeFile(join(fixture.sourceDirectory, source.path), source.text, "utf8");
  }
  const metadataText = `${JSON.stringify(
    {
      records: sources.map((source) => ({
        number: source.number,
        name: `合成元数据-${source.number}`,
        authorStudentId: "",
        status: "",
        contest: "",
        note: "",
      })),
    },
    null,
    2,
  )}\n`;
  await writeFile(fixture.prepareOptions.metadataFile, metadataText, "utf8");
  await writeFile(
    fixture.prepareOptions.sourceConfirmationFile,
    `${JSON.stringify(
      {
        version: 1,
        confirmed: true,
        metadataFileSha256: sha256Hex(metadataText),
        mappings: sources.map((source) => ({
          sourcePath: source.path,
          sourceSha256: sha256Hex(source.text),
          metadataNumber: source.number,
        })),
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  return fixture;
}

function fixedNormalizer(): HistoryRecoveryNormalizer {
  return {
    preparationIdentity: {
      version: 1,
      codeSha256: "f".repeat(64),
      promptSha256: "0".repeat(64),
      modelSha256: "1".repeat(64),
      configSha256: "2".repeat(64),
    },
    async normalize() {
      return normalizedOutput();
    },
  };
}

function normalizedOutput(): NormalizedHistoryOutput {
  return {
    problems: [normalizedProblem("合成候选题")],
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
    tags: [],
    confidence: 0.9,
    migrationNote: "合成测试备注。",
  };
}

async function readCandidate(
  preparedDirectory: string,
  candidateId = "candidate-000001",
): Promise<HistoryCandidateRecord> {
  return JSON.parse(
    await readFile(join(preparedDirectory, "candidates", `${candidateId}.json`), "utf8"),
  ) as HistoryCandidateRecord;
}

async function writeApproval(
  approvalFile: string,
  candidateId: string,
  contentSha256: string,
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
            decision: "approved",
          },
        ],
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
}

async function expectFailureKind(preparedDirectory: string, failureKind: string): Promise<void> {
  const failure = JSON.parse(
    await readFile(join(preparedDirectory, "requests", "source-000001.failed.json"), "utf8"),
  ) as { readonly failureKind?: unknown };
  expect(failure.failureKind).toBe(failureKind);
  await expect(readFile(join(preparedDirectory, "PREPARE_COMPLETE"), "utf8")).rejects.toMatchObject(
    { code: "ENOENT" },
  );
}

function deferred<T>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T | PromiseLike<T>) => void;
} {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

/** 等待文件系统把 ctime 推进到同一时间刻度外，避免粗粒度文件系统合并两次操作。 */
async function waitForCtimeTick(): Promise<void> {
  await new Promise<void>((done) => setTimeout(done, 20));
}

describe("打包期目录与输出防替换（同用户负例）", () => {
  const canTestForeignOwner = typeof process.geteuid === "function" && process.geteuid() === 0;

  it("核对后、最终复核前替换整个物化目录时失败且不留下任何输出", async () => {
    const fixture = await createPreparedFixture();
    const candidate = await readCandidate(fixture.prepareOutput);
    await writeApproval(fixture.approvalFile, candidate.candidateId, candidate.contentSha256);

    await expect(
      packageApprovedCandidates({
        ...fixture.packageOptions,
        testingHooks: {
          async afterMaterializationVerified() {
            await rename(fixture.materializedDirectory, `${fixture.materializedDirectory}-displaced`);
            await mkdir(fixture.materializedDirectory, { mode: 0o700 });
          },
        },
      }),
    ).rejects.toMatchObject({ code: "GROUPING_CHANGED" });
    await expect(stat(fixture.packageOutput)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(stat(fixture.authorMappingOutput)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("核对后把已确认源文件换成同名同内容新文件时失败且不留下任何输出", async () => {
    const fixture = await createPreparedFixture();
    const candidate = await readCandidate(fixture.prepareOutput);
    await writeApproval(fixture.approvalFile, candidate.candidateId, candidate.contentSha256);

    await expect(
      packageApprovedCandidates({
        ...fixture.packageOptions,
        testingHooks: {
          async afterMaterializationVerified() {
            const sourcePath = join(fixture.materializedDirectory, "sources", syntheticSourceName);
            const text = await readFile(sourcePath, "utf8");
            await rename(sourcePath, `${sourcePath}.displaced`);
            await writeFile(sourcePath, text, "utf8");
            await chmod(sourcePath, 0o600);
          },
        },
      }),
    ).rejects.toMatchObject({ code: "GROUPING_CHANGED" });
    await expect(stat(fixture.packageOutput)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(stat(fixture.authorMappingOutput)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("发布后、最终复核前把已发布题目包替换成同内容新文件时失败并清理全部输出", async () => {
    const fixture = await createPreparedFixture();
    const candidate = await readCandidate(fixture.prepareOutput);
    await writeApproval(fixture.approvalFile, candidate.candidateId, candidate.contentSha256);

    await expect(
      packageApprovedCandidates({
        ...fixture.packageOptions,
        testingHooks: {
          async afterFinalOutputsPublished() {
            const packagePath = join(fixture.packageOutput, "packages", "candidate-000001.zip");
            const bytes = await readFile(packagePath);
            await rename(packagePath, `${packagePath}.displaced`);
            await writeFile(packagePath, bytes);
            await chmod(packagePath, 0o600);
          },
        },
      }),
    ).rejects.toMatchObject({ code: "GROUPING_CHANGED" });
    await expect(stat(fixture.packageOutput)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(stat(fixture.authorMappingOutput)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("发布后 chmod 再还原权限与内容的题目包仍因 ctime 变化被最终复核拒绝", async () => {
    const fixture = await createPreparedFixture();
    const candidate = await readCandidate(fixture.prepareOutput);
    await writeApproval(fixture.approvalFile, candidate.candidateId, candidate.contentSha256);

    await expect(
      packageApprovedCandidates({
        ...fixture.packageOptions,
        testingHooks: {
          async afterFinalOutputsPublished() {
            const packagePath = join(fixture.packageOutput, "packages", "candidate-000001.zip");
            await waitForCtimeTick();
            await chmod(packagePath, 0o644);
            await waitForCtimeTick();
            await chmod(packagePath, 0o600);
          },
        },
      }),
    ).rejects.toMatchObject({ code: "GROUPING_CHANGED" });
    await expect(stat(fixture.packageOutput)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(stat(fixture.authorMappingOutput)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("最终复核后（打包中段）把物化目录换成伪造目录时失败且不留下任何输出", async () => {
    const fixture = await createPreparedFixture();
    const candidate = await readCandidate(fixture.prepareOutput);
    await writeApproval(fixture.approvalFile, candidate.candidateId, candidate.contentSha256);

    await expect(
      packageApprovedCandidates({
        ...fixture.packageOptions,
        testingHooks: {
          async afterFinalOutputRecheck() {
            await rename(fixture.materializedDirectory, `${fixture.materializedDirectory}-displaced`);
            await mkdir(fixture.materializedDirectory, { mode: 0o700 });
          },
        },
      }),
    ).rejects.toMatchObject({ code: "GROUPING_CHANGED" });
    await expect(stat(fixture.packageOutput)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(stat(fixture.authorMappingOutput)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.skipIf(!canTestForeignOwner)(
    "root 下把已发布题目包 chown 给其他用户时最终复核失败并清理全部输出",
    async () => {
      const fixture = await createPreparedFixture();
      const candidate = await readCandidate(fixture.prepareOutput);
      await writeApproval(fixture.approvalFile, candidate.candidateId, candidate.contentSha256);

      await expect(
        packageApprovedCandidates({
          ...fixture.packageOptions,
          testingHooks: {
            async afterFinalOutputsPublished() {
              await chown(
                join(fixture.packageOutput, "packages", "candidate-000001.zip"),
                65_534,
                65_534,
              );
            },
          },
        }),
      ).rejects.toMatchObject({ code: "GROUPING_CHANGED" });
      await expect(stat(fixture.packageOutput)).rejects.toMatchObject({ code: "ENOENT" });
      await expect(stat(fixture.authorMappingOutput)).rejects.toMatchObject({ code: "ENOENT" });
    },
  );
});
