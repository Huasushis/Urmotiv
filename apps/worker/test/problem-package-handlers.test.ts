import { randomUUID } from "node:crypto";
import {
  createSafeArchive,
  createStaticProblemFormatAdapterCatalog,
  canonicalProblemSchema,
  readProblemPackageInput,
  singleFileProblemPackagePath,
  UnsafeArchiveError,
  urmotivNativeAdapter,
  type CanonicalProblem,
  type ProblemFormatAdapter,
  type SafeProblemPackageInput
} from "@urmotiv/problem-package";
import {
  problemPackageExportJobSchema,
  problemPackageImportItemSchema,
  problemPackageImportJobSchema,
  problemPackageJobReportSchema,
  ProblemPackageTemporaryError,
  safeProblemPackageFailure,
  type CompleteProblemPackageExport,
  type CreateProblemPackageExportJob,
  type CreateProblemPackageImportJob,
  type ImportItemOutcome,
  type ProblemPackageExportJob,
  type ProblemPackageFailureCode,
  type ProblemPackageImportItem,
  type ProblemPackageImportJob,
  type ProblemPackageImportHandlerDependencies,
  type ProblemPackageJobReport,
  type ProblemPackageJobStore,
  type JobItemReport
} from "@urmotiv/jobs";
import { describe, expect, it } from "vitest";
import {
  InMemoryExportArtifactWriter,
  InMemoryFixedRevisionExportReader,
  InMemoryVerifiedImportArchiveReader,
  createProblemPackageExportHandler,
  createProblemPackageImportHandler as createProblemPackageImportHandlerWithAuthorization,
  type ExportReadAuthorization,
  type ImportExecutionAuthorization,
  type JobHandlerContext
} from "../src";

const fixedNow = "2026-07-26T00:00:00.000Z";
const statementText = "A statement that must never appear in task records.";
const solutionText = "A solution that must never appear in task records.";

/**
 * 一个只在测试进程内保存任务状态的实现。它模拟数据库存储的状态机规则：
 * 只有 queued 任务能开始，只有 running 任务能更新、完成或失败。
 */
class FakeProblemPackageJobStore implements ProblemPackageJobStore {
  public readonly imports = new Map<string, ProblemPackageImportJob>();
  public readonly importItems = new Map<string, ProblemPackageImportItem[]>();
  public readonly exports = new Map<string, ProblemPackageExportJob>();

  public seedImport(overrides: Partial<ProblemPackageImportJob> = {}): ProblemPackageImportJob {
    const job = problemPackageImportJobSchema.parse({
      id: randomUUID(),
      requestedByUserId: "5",
      clientRequestDigest: "c".repeat(64),
      sourceFileId: randomUUID(),
      inputDigest: "a".repeat(64),
      detectedFormat: null,
      selectedFormat: "urmotiv",
      selectedFormatVersion: "1.0.0",
      choices: { conflictAction: "create" },
      itemCount: 1,
      state: "queued",
      progressPercent: 0,
      report: initialReport(),
      failure: null,
      idempotencyKey: "import-1",
      startedAt: null,
      finishedAt: null,
      executionAttempt: 0,
      leaseId: null,
      leaseExpiresAt: null,
      createdAt: fixedNow,
      ...overrides
    });
    this.imports.set(job.id, job);
    this.importItems.set(job.id, [
      problemPackageImportItemSchema.parse({
        jobId: job.id,
        position: 0,
        state: "queued",
        importedProblemId: null,
        failure: null,
        finishedAt: null
      })
    ]);
    return job;
  }

  public seedExport(overrides: Partial<ProblemPackageExportJob> = {}): ProblemPackageExportJob {
    const job = problemPackageExportJobSchema.parse({
      id: randomUUID(),
      requestedByUserId: "5",
      clientRequestDigest: "d".repeat(64),
      targetFormat: "urmotiv",
      targetFormatVersion: "1.0.0",
      options: {},
      lossSummary: {
        targetFormat: "urmotiv",
        canExport: true,
        errorCount: 0,
        choiceCount: 0,
        warningCount: 0,
        infoCount: 0
      },
      problems: [
        {
          problemId: "10",
          revisionId: randomUUID(),
          includedFileCategories: ["testdata"]
        }
      ],
      state: "queued",
      progressPercent: 0,
      report: initialReport(),
      resultFileId: null,
      resultExpiresAt: null,
      failure: null,
      idempotencyKey: "export-1",
      startedAt: null,
      finishedAt: null,
      createdAt: fixedNow,
      ...overrides
    });
    this.exports.set(job.id, job);
    return job;
  }

  public async createImportJob(_input: CreateProblemPackageImportJob): Promise<ProblemPackageImportJob> {
    throw new Error("The fake store only accepts seeded tasks.");
  }

  public async createExportJob(_input: CreateProblemPackageExportJob): Promise<ProblemPackageExportJob> {
    throw new Error("The fake store only accepts seeded tasks.");
  }

  public async getImportJob(jobId: string): Promise<ProblemPackageImportJob | undefined> {
    return this.imports.get(jobId);
  }

  public async getImportItems(jobId: string): Promise<readonly ProblemPackageImportItem[]> {
    return this.importItems.get(jobId) ?? [];
  }

  public async getExportJob(jobId: string): Promise<ProblemPackageExportJob | undefined> {
    return this.exports.get(jobId);
  }

  public async startImportJob(jobId: string): Promise<ProblemPackageImportJob | undefined> {
    const job = this.imports.get(jobId);
    if (job === undefined || job.state !== "queued") {
      return job;
    }
    const started: ProblemPackageImportJob = {
      ...job,
      state: "running",
      report: { ...job.report, phase: "reading" },
      startedAt: fixedNow
    };
    this.imports.set(jobId, started);
    return started;
  }

  public async startExportJob(jobId: string): Promise<ProblemPackageExportJob | undefined> {
    const job = this.exports.get(jobId);
    if (job === undefined || job.state !== "queued") {
      return job;
    }
    const started: ProblemPackageExportJob = {
      ...job,
      state: "running",
      report: { ...job.report, phase: "reading" },
      startedAt: fixedNow
    };
    this.exports.set(jobId, started);
    return started;
  }

  public async updateImportJob(
    jobId: string,
    progressPercent: number,
    report: ProblemPackageJobReport
  ): Promise<void> {
    const job = this.requireRunningImport(jobId);
    this.imports.set(jobId, {
      ...job,
      progressPercent,
      report: problemPackageJobReportSchema.parse(report)
    });
  }

  public async updateExportJob(
    jobId: string,
    progressPercent: number,
    report: ProblemPackageJobReport
  ): Promise<void> {
    const job = this.requireRunningExport(jobId);
    this.exports.set(jobId, {
      ...job,
      progressPercent,
      report: problemPackageJobReportSchema.parse(report)
    });
  }

  public async recordImportItem(
    jobId: string,
    position: number,
    outcome: ImportItemOutcome
  ): Promise<void> {
    this.requireRunningImport(jobId);
    const items = this.importItems.get(jobId);
    if (items === undefined || items[position] === undefined) {
      throw new Error("导入项目不存在。");
    }
    items[position] = problemPackageImportItemSchema.parse({
      jobId,
      position,
      state: outcome.state,
      importedProblemId: outcome.importedProblemId ?? null,
      failure:
        outcome.failureCode === undefined ? null : safeProblemPackageFailure(outcome.failureCode),
      finishedAt: fixedNow
    });
  }

  public async completeImportJob(jobId: string, report: ProblemPackageJobReport): Promise<void> {
    const job = this.requireRunningImport(jobId);
    this.imports.set(jobId, {
      ...job,
      state: "succeeded",
      progressPercent: 100,
      report: { ...problemPackageJobReportSchema.parse(report), phase: "completed" },
      failure: null,
      finishedAt: fixedNow
    });
  }

  public async completeExportJob(jobId: string, result: CompleteProblemPackageExport): Promise<void> {
    const job = this.requireRunningExport(jobId);
    this.exports.set(jobId, {
      ...job,
      state: "succeeded",
      progressPercent: 100,
      report: { ...job.report, phase: "completed", outputFileCount: result.outputFileCount },
      resultFileId: result.resultFileId,
      resultExpiresAt: result.resultExpiresAt,
      failure: null,
      finishedAt: fixedNow
    });
  }

  public async failImportJob(
    jobId: string,
    code: ProblemPackageFailureCode,
    report: ProblemPackageJobReport
  ): Promise<void> {
    const job = this.requireRunningImport(jobId);
    this.imports.set(jobId, {
      ...job,
      state: "failed",
      report: { ...problemPackageJobReportSchema.parse(report), phase: "failed" },
      failure: safeProblemPackageFailure(code),
      finishedAt: fixedNow
    });
  }

  public async failExportJob(jobId: string, code: ProblemPackageFailureCode): Promise<void> {
    const job = this.requireRunningExport(jobId);
    this.exports.set(jobId, {
      ...job,
      state: "failed",
      report: { ...job.report, phase: "failed" },
      failure: safeProblemPackageFailure(code),
      finishedAt: fixedNow
    });
  }

  private requireRunningImport(jobId: string): ProblemPackageImportJob {
    const job = this.imports.get(jobId);
    if (job === undefined || job.state !== "running") {
      throw new Error("任务当前不能更新。");
    }
    return job;
  }

  private requireRunningExport(jobId: string): ProblemPackageExportJob {
    const job = this.exports.get(jobId);
    if (job === undefined || job.state !== "running") {
      throw new Error("任务当前不能更新。");
    }
    return job;
  }
}

function initialReport(): ProblemPackageJobReport {
  return { version: 1, phase: "queued", completedItems: 0, failedItems: 0, skippedItems: 0 };
}

function makeContext(
  overrides: Partial<Pick<JobHandlerContext, "attempt" | "maxAttempts">> = {}
): JobHandlerContext & { readonly itemReports: JobItemReport[] } {
  const itemReports: JobItemReport[] = [];
  return {
    jobId: randomUUID(),
    attempt: overrides.attempt ?? 1,
    maxAttempts: overrides.maxAttempts ?? 3,
    signal: new AbortController().signal,
    itemReports,
    updateProgress: async () => {},
    putItemReport: async (report) => {
      itemReports.push(structuredClone(report));
    }
  };
}

function secondProblem(): CanonicalProblem {
  return canonicalProblemSchema.parse({
    title: "Handler fixture two",
    type: "traditional",
    tags: ["graph"],
    difficulty: { codeforces: 1700 },
    content: {
      basicStatement: `${statementText} (second)`,
      basicSolution: solutionText
    },
    samples: [{ input: "2 3", output: "5", explanation: "" }],
    files: [
      {
        path: "judge/testdata/001.in",
        category: "testdata",
        content: new TextEncoder().encode("2 3\n")
      }
    ],
    extensions: {}
  });
}

function fixtureProblem(): CanonicalProblem {
  return canonicalProblemSchema.parse({
    title: "Handler fixture",
    type: "traditional",
    tags: ["graph"],
    difficulty: { codeforces: 1600 },
    content: {
      basicStatement: statementText,
      basicSolution: solutionText
    },
    samples: [{ input: "1 2", output: "3", explanation: "" }],
    files: [
      {
        path: "judge/testdata/001.in",
        category: "testdata",
        content: new TextEncoder().encode("1 2\n")
      }
    ],
    extensions: {}
  });
}

async function nativeArchiveOf(problem: CanonicalProblem): Promise<SafeProblemPackageInput> {
  const generated = await urmotivNativeAdapter.export(problem, { exportedAt: fixedNow });
  if (generated.kind !== "zip") {
    throw new Error("Urmotiv 原生题目包必须导出为 ZIP。");
  }
  return {
    kind: "zip",
    mediaType: "application/zip",
    archive: createSafeArchive(
    generated.files.map((file) => ({
      path: file.path,
      kind: "file" as const,
      compressedSize: file.content.byteLength,
      uncompressedSize: file.content.byteLength,
      content: file.content
    }))
    )
  };
}

function allowAll(): ExportReadAuthorization {
  return {
    canReadProblem: async () => true,
    canReadFile: async () => true
  };
}

function allowImport(): ImportExecutionAuthorization {
  return { canImport: async () => true };
}

function createProblemPackageImportHandler(
  dependencies: Omit<ProblemPackageImportHandlerDependencies, "authorization"> & {
    readonly authorization?: ImportExecutionAuthorization;
  }
) {
  return createProblemPackageImportHandlerWithAuthorization({
    authorization: allowImport(),
    ...dependencies
  });
}

describe("题目包导入任务处理器", () => {
  it("成功导入原生包并保存题目编号", async () => {
    const store = new FakeProblemPackageJobStore();
    const job = store.seedImport();
    const reader = new InMemoryVerifiedImportArchiveReader();
    reader.put(job.sourceFileId, job.inputDigest, await nativeArchiveOf(fixtureProblem()));
    const writes: Array<{ position: number; title: string }> = [];
    const handler = createProblemPackageImportHandler({
      jobs: store,
      archives: reader,
      writer: {
        write: async (input) => {
          writes.push({ position: input.position, title: input.problem.title });
          return { problemId: "42" };
        }
      }
    });

    const outcome = await handler({ importJobId: job.id }, makeContext());

    expect(outcome).toEqual({ result: { importedProblemCount: 1, failedProblemCount: 0 } });
    expect(writes).toEqual([{ position: 0, title: "Handler fixture" }]);
    expect(store.imports.get(job.id)).toEqual(
      expect.objectContaining({
        state: "succeeded",
        progressPercent: 100,
        report: expect.objectContaining({ phase: "completed", completedItems: 1, failedItems: 0 })
      })
    );
    expect(store.importItems.get(job.id)?.[0]).toEqual(
      expect.objectContaining({ state: "succeeded", importedProblemId: "42" })
    );
  });

  it("部分提交的多题导入不得提前封存成功，重试续写剩余题目", async () => {
    const store = new FakeProblemPackageJobStore();
    const job = store.seedImport({
      selectedFormat: "two.test",
      selectedFormatVersion: "1.0.0",
      itemCount: 2
    });
    // 与真实多题创建流一致：position 0/1 各有一条持久化的排队项目行。
    store.importItems.set(job.id, [
      problemPackageImportItemSchema.parse({
        jobId: job.id,
        position: 0,
        state: "queued",
        importedProblemId: null,
        failure: null,
        finishedAt: null
      }),
      problemPackageImportItemSchema.parse({
        jobId: job.id,
        position: 1,
        state: "queued",
        importedProblemId: null,
        failure: null,
        finishedAt: null
      })
    ]);
    const reader = new InMemoryVerifiedImportArchiveReader();
    reader.put(job.sourceFileId, job.inputDigest, await nativeArchiveOf(fixtureProblem()));
    let writeCount = 0;
    const writes: Array<{ position: number; title: string }> = [];
    const handler = createProblemPackageImportHandler({
      jobs: store,
      archives: reader,
      writer: {
        write: async (input) => {
          writes.push({ position: input.position, title: input.problem.title });
          writeCount += 1;
          if (writeCount === 2) {
            throw new Error("transient persistence outage");
          }
          return { problemId: String(40 + input.position) };
        }
      },
      adapterCatalog: createStaticProblemFormatAdapterCatalog(
        new Map([
          [
            "two.test",
            {
              id: "two.test",
              displayName: "两题测试格式",
              version: "1.0.0",
              inputKind: "zip",
              detect: async () => ({ confidence: 1, reason: "测试" }),
              inspect: async () => ({
                formatId: "two.test",
                problemCount: 2,
                files: [],
                issues: []
              }),
              import: async () => [fixtureProblem(), secondProblem()],
              validateExport: async () => ({
                targetFormat: "two.test",
                canExport: true,
                items: []
              }),
              export: async () => {
                throw new Error("这个测试不会导出文件。");
              }
            } satisfies ProblemFormatAdapter
          ]
        ])
      )
    });

    const firstAttempt = makeContext({ attempt: 1, maxAttempts: 3 });
    // 第一次尝试以可重试的持久化错误收场，任务保持 running，等待队列续做。
    let firstFailure: unknown;
    try {
      await handler({ importJobId: job.id }, firstAttempt);
    } catch (error) {
      firstFailure = error;
    }
    expect(firstFailure).toBeInstanceOf(ProblemPackageTemporaryError);
    expect(store.imports.get(job.id)?.state).not.toBe("succeeded");
    expect(store.importItems.get(job.id)?.[0]).toEqual(
      expect.objectContaining({ state: "succeeded", importedProblemId: "40" })
    );

    // 第二次尝试：已提交的 position 0 不得重复写入，position 1 续写成功。
    const retryContext = makeContext({ attempt: 2, maxAttempts: 3 });
    await expect(handler({ importJobId: job.id }, retryContext)).resolves.toEqual({
      result: { importedProblemCount: 2, failedProblemCount: 0 }
    });
    expect(writes.map((entry) => entry.position)).toEqual([0, 1, 1]);
    expect(store.imports.get(job.id)).toEqual(
      expect.objectContaining({
        state: "succeeded",
        report: expect.objectContaining({ phase: "completed", completedItems: 2, failedItems: 0 })
      })
    );
    expect(store.importItems.get(job.id)?.[1]).toEqual(
      expect.objectContaining({ state: "succeeded", importedProblemId: "41" })
    );
  });

  it("读取上传包前发现导入权限已撤销时固定失败且不读取或写入", async () => {
    const store = new FakeProblemPackageJobStore();
    const job = store.seedImport();
    let archiveReads = 0;
    let writes = 0;
    const handler = createProblemPackageImportHandler({
      jobs: store,
      authorization: { canImport: async () => false },
      archives: {
        read: async () => {
          archiveReads += 1;
          throw new Error(`撤权后不应读取 ${statementText}`);
        }
      },
      writer: {
        write: async () => {
          writes += 1;
          throw new Error(`撤权后不应写入 ${solutionText}`);
        }
      }
    });

    await expect(handler({ importJobId: job.id }, makeContext())).rejects.toMatchObject({
      name: "PermanentJobError",
      code: "import_access_revoked",
      safeMessage: "当前已没有导入题目包的权限。"
    });
    expect(archiveReads).toBe(0);
    expect(writes).toBe(0);
    expect(store.imports.get(job.id)).toEqual(
      expect.objectContaining({
        state: "failed",
        failure: safeProblemPackageFailure("import_access_revoked")
      })
    );
    const serialized = JSON.stringify({
      job: store.imports.get(job.id),
      items: store.importItems.get(job.id)
    });
    expect(serialized).not.toContain(statementText);
    expect(serialized).not.toContain(solutionText);
  });

  it("解析期间撤销导入权限时写入前的第二次检查会阻止 writer", async () => {
    const store = new FakeProblemPackageJobStore();
    const job = store.seedImport();
    const reader = new InMemoryVerifiedImportArchiveReader();
    reader.put(job.sourceFileId, job.inputDigest, await nativeArchiveOf(fixtureProblem()));
    let authorizationChecks = 0;
    let writes = 0;
    const handler = createProblemPackageImportHandler({
      jobs: store,
      authorization: {
        canImport: async () => {
          authorizationChecks += 1;
          return authorizationChecks === 1;
        }
      },
      archives: reader,
      writer: {
        write: async () => {
          writes += 1;
          return { problemId: "42" };
        }
      }
    });

    await expect(handler({ importJobId: job.id }, makeContext())).rejects.toMatchObject({
      name: "PermanentJobError",
      code: "import_access_revoked"
    });
    expect(authorizationChecks).toBe(2);
    expect(writes).toBe(0);
    expect(store.imports.get(job.id)?.failure).toEqual(
      safeProblemPackageFailure("import_access_revoked")
    );
  });

  it("导入权限服务暂时失败时保留运行状态交给队列重试", async () => {
    const store = new FakeProblemPackageJobStore();
    const job = store.seedImport();
    const privateFailure = `permission database unavailable ${statementText}`;
    let archiveReads = 0;
    const handler = createProblemPackageImportHandler({
      jobs: store,
      authorization: {
        canImport: async () => {
          throw new Error(privateFailure);
        }
      },
      archives: {
        read: async () => {
          archiveReads += 1;
          return undefined;
        }
      },
      writer: {
        write: async () => {
          throw new Error("权限检查失败时不应写入题目。");
        }
      }
    });

    let failure: unknown;
    try {
      await handler(
        { importJobId: job.id },
        makeContext({ attempt: 1, maxAttempts: 3 })
      );
    } catch (error) {
      failure = error;
    }
    expect(failure).toMatchObject({
      name: "ProblemPackageTemporaryError",
      message: "导入权限检查暂时失败，请稍后重试。"
    });
    expect(JSON.stringify(failure)).not.toContain(privateFailure);
    expect(archiveReads).toBe(0);
    expect(store.imports.get(job.id)?.state).toBe("running");
    expect(store.imports.get(job.id)?.failure).toBeNull();
  });

  it("输入文件摘要不符时用固定错误结束任务", async () => {
    const store = new FakeProblemPackageJobStore();
    const job = store.seedImport();
    const handler = createProblemPackageImportHandler({
      jobs: store,
      archives: new InMemoryVerifiedImportArchiveReader(),
      writer: {
        write: async () => {
          throw new Error("The writer must not run for a missing archive.");
        }
      }
    });

    await expect(handler({ importJobId: job.id }, makeContext())).rejects.toMatchObject({
      name: "PermanentJobError",
      code: "source_digest_mismatch"
    });
    expect(store.imports.get(job.id)).toEqual(
      expect.objectContaining({
        state: "failed",
        failure: safeProblemPackageFailure("source_digest_mismatch")
      })
    );
    expect(store.importItems.get(job.id)?.[0]?.state).toBe("failed");
  });

  it("不存在或已经失败的导入任务直接结束，不再尝试改写终态", async () => {
    const store = new FakeProblemPackageJobStore();
    const failed = store.seedImport({
      state: "failed",
      report: {
        version: 1,
        phase: "failed",
        completedItems: 0,
        failedItems: 1,
        skippedItems: 0
      },
      failure: safeProblemPackageFailure("import_invalid"),
      startedAt: fixedNow,
      finishedAt: fixedNow
    });
    const handler = createProblemPackageImportHandler({
      jobs: store,
      archives: {
        read: async () => {
          throw new Error("终态任务不应读取题目包。");
        }
      },
      writer: {
        write: async () => {
          throw new Error("终态任务不应写入题目。");
        }
      }
    });

    await expect(
      handler({ importJobId: randomUUID() }, makeContext())
    ).rejects.toMatchObject({
      name: "PermanentJobError",
      code: "source_unavailable"
    });
    await expect(handler({ importJobId: failed.id }, makeContext())).rejects.toMatchObject({
      name: "PermanentJobError",
      code: "import_invalid"
    });
    expect(store.imports.get(failed.id)?.state).toBe("failed");
  });

  it("所选格式不可用时不读取包内容", async () => {
    const store = new FakeProblemPackageJobStore();
    const job = store.seedImport({ selectedFormat: "unknown.format" });
    const reader = new InMemoryVerifiedImportArchiveReader();
    reader.put(job.sourceFileId, job.inputDigest, await nativeArchiveOf(fixtureProblem()));
    const handler = createProblemPackageImportHandler({
      jobs: store,
      archives: reader,
      writer: {
        write: async () => {
          throw new Error("The writer must not run for an unknown format.");
        }
      }
    });

    await expect(handler({ importJobId: job.id }, makeContext())).rejects.toMatchObject({
      code: "format_unavailable"
    });
    expect(store.imports.get(job.id)?.failure).toEqual(
      safeProblemPackageFailure("format_unavailable")
    );
  });

  it("导入任务绑定的格式版本变化后不会调用新实现", async () => {
    const store = new FakeProblemPackageJobStore();
    const job = store.seedImport();
    const reader = new InMemoryVerifiedImportArchiveReader();
    reader.put(job.sourceFileId, job.inputDigest, await nativeArchiveOf(fixtureProblem()));
    let writes = 0;
    const changedAdapter: ProblemFormatAdapter = {
      ...urmotivNativeAdapter,
      version: "2.0.0"
    };
    const handler = createProblemPackageImportHandler({
      jobs: store,
      archives: reader,
      writer: {
        write: async () => {
          writes += 1;
          return { problemId: "42" };
        }
      },
      adapterCatalog: createStaticProblemFormatAdapterCatalog(
        new Map([[changedAdapter.id, changedAdapter]])
      )
    });

    await expect(handler({ importJobId: job.id }, makeContext())).rejects.toMatchObject({
      code: "format_unavailable"
    });
    expect(writes).toBe(0);
    expect(store.imports.get(job.id)?.failure).toEqual(
      safeProblemPackageFailure("format_unavailable")
    );
  });

  it("后台不会把原始 XML 交给默认的 ZIP 适配器", async () => {
    const store = new FakeProblemPackageJobStore();
    const job = store.seedImport();
    const reader = new InMemoryVerifiedImportArchiveReader();
    reader.put(
      job.sourceFileId,
      job.inputDigest,
      readProblemPackageInput({
        originalName: "problem.xml",
        content: new TextEncoder().encode("<?xml version=\"1.0\"?><fps />")
      })
    );
    let writes = 0;
    const handler = createProblemPackageImportHandler({
      jobs: store,
      archives: reader,
      writer: {
        write: async () => {
          writes += 1;
          return { problemId: "42" };
        }
      }
    });

    await expect(handler({ importJobId: job.id }, makeContext())).rejects.toMatchObject({
      code: "format_unavailable"
    });
    expect(writes).toBe(0);
  });

  it("单文件适配器会收到固定名称的原始 XML 并完成导入", async () => {
    const store = new FakeProblemPackageJobStore();
    const job = store.seedImport({ selectedFormat: "single.test" });
    const reader = new InMemoryVerifiedImportArchiveReader();
    reader.put(
      job.sourceFileId,
      job.inputDigest,
      readProblemPackageInput({
        originalName: "可能带题目名称.xml",
        content: new TextEncoder().encode("<?xml version=\"1.0\"?><fps />")
      })
    );
    const seenPaths: string[][] = [];
    const adapter: ProblemFormatAdapter = {
      id: "single.test",
      displayName: "单文件测试格式",
      version: "1.0.0",
      inputKind: "single_file",
      detect: async () => ({ confidence: 1, reason: "测试" }),
      inspect: async () => ({
        formatId: "single.test",
        problemCount: 1,
        files: [],
        issues: []
      }),
      import: async (archive, _choices) => {
        seenPaths.push(archive.list().map((entry) => entry.path));
        expect(archive.read(singleFileProblemPackagePath)).toBeDefined();
        return [fixtureProblem()];
      },
      validateExport: async () => ({
        targetFormat: "single.test",
        canExport: true,
        items: []
      }),
      export: async () => {
        throw new Error("这个测试不会导出文件。");
      }
    };
    const writes: string[] = [];
    const handler = createProblemPackageImportHandler({
      jobs: store,
      archives: reader,
      writer: {
        write: async (input) => {
          writes.push(input.problem.title);
          return { problemId: "42" };
        }
      },
      adapterCatalog: createStaticProblemFormatAdapterCatalog(
        new Map([[adapter.id, adapter]])
      )
    });

    await expect(handler({ importJobId: job.id }, makeContext())).resolves.toEqual({
      result: { importedProblemCount: 1, failedProblemCount: 0 }
    });
    expect(seenPaths).toEqual([[singleFileProblemPackagePath]]);
    expect(writes).toEqual(["Handler fixture"]);
  });

  it("写入失败时任务记录只保留固定文案，不包含题面或内部错误", async () => {
    const store = new FakeProblemPackageJobStore();
    const job = store.seedImport();
    const reader = new InMemoryVerifiedImportArchiveReader();
    reader.put(job.sourceFileId, job.inputDigest, await nativeArchiveOf(fixtureProblem()));
    const context = makeContext();
    const handler = createProblemPackageImportHandler({
      jobs: store,
      archives: reader,
      writer: {
        write: async () => {
          throw new Error(`database exploded while saving ${statementText}`);
        }
      }
    });

    await expect(handler({ importJobId: job.id }, context)).rejects.toMatchObject({
      code: "import_write_failed"
    });
    const serialized = JSON.stringify({
      job: store.imports.get(job.id),
      items: store.importItems.get(job.id),
      contextReports: context.itemReports
    });
    expect(serialized).not.toContain(statementText);
    expect(serialized).not.toContain(solutionText);
    expect(serialized).not.toContain("database exploded");
    expect(store.imports.get(job.id)?.failure).toEqual(
      safeProblemPackageFailure("import_write_failed")
    );
  });

  it("题目已经与导入项目一起提交时，重试只完成任务而不再读取或写入", async () => {
    const store = new FakeProblemPackageJobStore();
    const job = store.seedImport({
      state: "running",
      progressPercent: 60,
      report: {
        version: 1,
        phase: "writing",
        completedItems: 0,
        failedItems: 0,
        skippedItems: 0
      },
      startedAt: fixedNow
    });
    store.importItems.set(job.id, [
      problemPackageImportItemSchema.parse({
        jobId: job.id,
        position: 0,
        state: "succeeded",
        importedProblemId: "42",
        failure: null,
        finishedAt: fixedNow
      })
    ]);
    const handler = createProblemPackageImportHandler({
      jobs: store,
      archives: {
        read: async () => {
          throw new Error("已提交的导入项目不应再次读取题目包。");
        }
      },
      writer: {
        write: async () => {
          throw new Error("已提交的导入项目不应再次创建题目。");
        }
      }
    });

    await expect(handler({ importJobId: job.id }, makeContext())).resolves.toEqual({
      result: { importedProblemCount: 1, failedProblemCount: 0 }
    });
    expect(store.imports.get(job.id)).toEqual(
      expect.objectContaining({
        state: "succeeded",
        progressPercent: 100,
        report: expect.objectContaining({ completedItems: 1 })
      })
    );
  });

  it("导入失败状态无法保存时保留运行状态并交给队列重试", async () => {
    class FailingStateStore extends FakeProblemPackageJobStore {
      public override async failImportJob(): Promise<void> {
        throw new Error(`database rejected ${statementText}`);
      }
    }

    const store = new FailingStateStore();
    const job = store.seedImport();
    const handler = createProblemPackageImportHandler({
      jobs: store,
      archives: new InMemoryVerifiedImportArchiveReader(),
      writer: {
        write: async () => {
          throw new Error("输入缺失时不应写入题目。");
        }
      }
    });

    await expect(handler({ importJobId: job.id }, makeContext())).rejects.toMatchObject({
      name: "TaskStatePersistenceError",
      message: "题目包任务状态暂时无法保存。"
    });
    expect(store.imports.get(job.id)?.state).toBe("running");
    expect(JSON.stringify(store.imports.get(job.id))).not.toContain(statementText);
  });

  it("最后一次临时导入失败会用固定错误结束业务任务", async () => {
    const store = new FakeProblemPackageJobStore();
    const job = store.seedImport();
    const handler = createProblemPackageImportHandler({
      jobs: store,
      archives: {
        read: async () => {
          throw new ProblemPackageTemporaryError();
        }
      },
      writer: {
        write: async () => {
          throw new Error("读取失败时不应写入题目。");
        }
      }
    });

    await expect(
      handler(
        { importJobId: job.id },
        makeContext({ attempt: 3, maxAttempts: 3 })
      )
    ).rejects.toMatchObject({
      name: "PermanentJobError",
      code: "import_write_failed"
    });
    expect(store.imports.get(job.id)).toEqual(
      expect.objectContaining({
        state: "failed",
        failure: safeProblemPackageFailure("import_write_failed")
      })
    );
    expect(store.importItems.get(job.id)?.[0]).toEqual(
      expect.objectContaining({
        state: "failed",
        failure: safeProblemPackageFailure("import_write_failed")
      })
    );
  });

  it("已成功的任务重复领取时直接返回结果，不再写入", async () => {
    const store = new FakeProblemPackageJobStore();
    const job = store.seedImport({
      state: "succeeded",
      progressPercent: 100,
      report: {
        version: 1,
        phase: "completed",
        completedItems: 1,
        failedItems: 0,
        skippedItems: 0
      },
      startedAt: fixedNow,
      finishedAt: fixedNow
    });
    const handler = createProblemPackageImportHandler({
      jobs: store,
      archives: new InMemoryVerifiedImportArchiveReader(),
      writer: {
        write: async () => {
          throw new Error("A finished task must not import again.");
        }
      }
    });

    await expect(handler({ importJobId: job.id }, makeContext())).resolves.toEqual({
      result: { importedProblemCount: 1, failedProblemCount: 0 }
    });
  });
});

describe("题目包导出任务处理器", () => {
  it("导出任务绑定的格式版本变化后不会读取题目或写入产物", async () => {
    const store = new FakeProblemPackageJobStore();
    const job = store.seedExport();
    const changedAdapter: ProblemFormatAdapter = {
      ...urmotivNativeAdapter,
      version: "2.0.0"
    };
    const handler = createProblemPackageExportHandler({
      jobs: store,
      source: {
        readRevision: async () => {
          throw new Error("格式版本不一致时不应读取题目。");
        },
        readFile: async () => {
          throw new Error("格式版本不一致时不应读取文件。");
        }
      },
      authorization: {
        canReadProblem: async () => {
          throw new Error("格式版本不一致时不应检查题目读取权限。");
        },
        canReadFile: async () => {
          throw new Error("格式版本不一致时不应检查文件读取权限。");
        }
      },
      artifacts: {
        write: async () => {
          throw new Error("格式版本不一致时不应写入产物。");
        }
      },
      adapterCatalog: createStaticProblemFormatAdapterCatalog(
        new Map([[changedAdapter.id, changedAdapter]])
      )
    });

    await expect(handler({ exportJobId: job.id }, makeContext())).rejects.toMatchObject({
      code: "format_unavailable"
    });
    expect(store.exports.get(job.id)?.failure).toEqual(
      safeProblemPackageFailure("format_unavailable")
    );
  });

  it("成功导出固定版本并统计输出文件", async () => {
    const store = new FakeProblemPackageJobStore();
    const job = store.seedExport();
    const selection = job.problems[0];
    if (selection === undefined) {
      throw new Error("The seeded export task has no selection.");
    }
    const source = new InMemoryFixedRevisionExportReader();
    source.put(selection, fixtureProblem());
    const artifacts = new InMemoryExportArtifactWriter();
    const handler = createProblemPackageExportHandler({
      jobs: store,
      source,
      authorization: allowAll(),
      artifacts
    });

    const outcome = await handler({ exportJobId: job.id }, makeContext());

    const finished = store.exports.get(job.id);
    expect(finished).toEqual(
      expect.objectContaining({
        state: "succeeded",
        progressPercent: 100,
        resultFileId: expect.any(String)
      })
    );
    expect(finished?.report.outputFileCount).toBeGreaterThan(0);
    expect(outcome).toEqual({ result: { resultFileId: finished?.resultFileId } });
    const artifact = artifacts.get(finished?.resultFileId ?? "");
    expect(artifact?.archives).toHaveLength(1);
  });

  it("读取器返回同长度但摘要不同的字节时由处理器再次拒绝", async () => {
    const store = new FakeProblemPackageJobStore();
    const job = store.seedExport();
    const selection = job.problems[0];
    if (selection === undefined) {
      throw new Error("测试导出任务没有题目选择。");
    }
    const source = new InMemoryFixedRevisionExportReader();
    source.put(selection, fixtureProblem());
    const handler = createProblemPackageExportHandler({
      jobs: store,
      source: {
        readRevision: (input) => source.readRevision(input),
        readFile: async (input) => {
          const file = await source.readFile(input);
          if (file === undefined) return undefined;
          const changed = new Uint8Array(file.content.byteLength);
          changed.fill(0x5a);
          return { ...file, content: changed };
        }
      },
      authorization: allowAll(),
      artifacts: new InMemoryExportArtifactWriter()
    });

    await expect(handler({ exportJobId: job.id }, makeContext())).rejects.toMatchObject({
      name: "PermanentJobError",
      code: "export_source_integrity",
      message: "固定版本中的文件内容与登记信息不一致。"
    });
    expect(store.exports.get(job.id)).toEqual(
      expect.objectContaining({
        state: "failed",
        resultFileId: null,
        failure: safeProblemPackageFailure("export_source_integrity")
      })
    );
  });

  it("原子写入已完成后队列进度保存失败不会删除有效导出结果", async () => {
    const store = new FakeProblemPackageJobStore();
    const job = store.seedExport();
    const selection = job.problems[0];
    if (selection === undefined) {
      throw new Error("测试导出任务没有题目选择。");
    }
    const source = new InMemoryFixedRevisionExportReader();
    source.put(selection, fixtureProblem());
    const fileId = randomUUID();
    const discarded: string[] = [];
    const context = {
      ...makeContext(),
      updateProgress: async () => {
        throw new Error("queue progress unavailable");
      }
    };
    const handler = createProblemPackageExportHandler({
      jobs: store,
      source,
      authorization: allowAll(),
      artifacts: {
        write: async () => {
          throw new Error("支持原子写入时不应调用旧写入入口。");
        },
        writeAndComplete: async (input) => {
          await store.completeExportJob(input.exportJobId, {
            resultFileId: fileId,
            resultExpiresAt: "2026-07-27T00:00:00.000Z",
            outputFileCount: input.outputFileCount
          });
          return {
            fileId,
            expiresAt: "2026-07-27T00:00:00.000Z"
          };
        },
        discard: async (discardedFileId) => {
          discarded.push(discardedFileId);
        }
      }
    });

    const outcome = await handler({ exportJobId: job.id }, context);

    const finished = store.exports.get(job.id);
    expect(finished?.state).toBe("succeeded");
    expect(finished?.resultFileId).toBe(fileId);
    expect(discarded).toEqual([]);
    expect(outcome).toEqual({ result: { resultFileId: finished?.resultFileId } });
  });

  it("导出完成状态无法确认时保留产物并交给队列重试", async () => {
    class FailingCompletionStore extends FakeProblemPackageJobStore {
      public override async completeExportJob(): Promise<void> {
        throw new Error(`database rejected ${statementText}`);
      }
    }

    const store = new FailingCompletionStore();
    const job = store.seedExport();
    const selection = job.problems[0];
    if (selection === undefined) {
      throw new Error("测试导出任务没有题目选择。");
    }
    const source = new InMemoryFixedRevisionExportReader();
    source.put(selection, fixtureProblem());
    const fileId = randomUUID();
    const discarded: string[] = [];
    const handler = createProblemPackageExportHandler({
      jobs: store,
      source,
      authorization: allowAll(),
      artifacts: {
        write: async () => ({
          fileId,
          expiresAt: "2026-07-27T00:00:00.000Z"
        }),
        discard: async (discardedFileId) => {
          discarded.push(discardedFileId);
        }
      }
    });

    await expect(handler({ exportJobId: job.id }, makeContext())).rejects.toMatchObject({
      name: "ExportResultSaveError",
      message: "导出结果的保存状态暂时无法确认。"
    });
    expect(discarded).toEqual([]);
    expect(store.exports.get(job.id)?.state).toBe("running");
    expect(JSON.stringify(store.exports.get(job.id))).not.toContain(statementText);
  });

  it("旧写入方式完成已提交但响应丢失时复用有效结果", async () => {
    class ResponseLostStore extends FakeProblemPackageJobStore {
      public override async completeExportJob(
        jobId: string,
        result: CompleteProblemPackageExport
      ): Promise<void> {
        await super.completeExportJob(jobId, result);
        throw new Error("数据库响应在提交后丢失。");
      }
    }

    const store = new ResponseLostStore();
    const job = store.seedExport();
    const selection = job.problems[0];
    if (selection === undefined) {
      throw new Error("测试导出任务没有题目选择。");
    }
    const source = new InMemoryFixedRevisionExportReader();
    source.put(selection, fixtureProblem());
    const fileId = randomUUID();
    const discarded: string[] = [];
    const handler = createProblemPackageExportHandler({
      jobs: store,
      source,
      authorization: allowAll(),
      artifacts: {
        write: async () => ({
          fileId,
          expiresAt: "2026-07-27T00:00:00.000Z"
        }),
        discard: async (discardedFileId) => {
          discarded.push(discardedFileId);
        }
      }
    });

    await expect(handler({ exportJobId: job.id }, makeContext())).resolves.toEqual({
      result: { resultFileId: fileId }
    });
    expect(store.exports.get(job.id)).toEqual(
      expect.objectContaining({ state: "succeeded", resultFileId: fileId })
    );
    expect(discarded).toEqual([]);
  });

  it("最后一次复查发现其他导出结果已成功时清理当前产物", async () => {
    const existingFileId = randomUUID();
    class ConcurrentCompletionStore extends FakeProblemPackageJobStore {
      private readsAfterCompletionFailure = 0;

      public override async completeExportJob(): Promise<void> {
        throw new Error("数据库响应暂时不可用。");
      }

      public override async getExportJob(
        jobId: string
      ): Promise<ProblemPackageExportJob | undefined> {
        this.readsAfterCompletionFailure += 1;
        if (this.readsAfterCompletionFailure === 1) {
          throw new Error("第一次结果复查暂时不可用。");
        }
        const current = this.exports.get(jobId);
        if (current === undefined) {
          return undefined;
        }
        const completed = problemPackageExportJobSchema.parse({
          ...current,
          state: "succeeded",
          progressPercent: 100,
          report: {
            ...current.report,
            phase: "completed",
            outputFileCount: 1
          },
          resultFileId: existingFileId,
          resultExpiresAt: "2026-07-27T00:00:00.000Z",
          failure: null,
          finishedAt: fixedNow
        });
        this.exports.set(jobId, completed);
        return completed;
      }
    }

    const store = new ConcurrentCompletionStore();
    const job = store.seedExport();
    const selection = job.problems[0];
    if (selection === undefined) {
      throw new Error("测试导出任务没有题目选择。");
    }
    const source = new InMemoryFixedRevisionExportReader();
    source.put(selection, fixtureProblem());
    const currentFileId = randomUUID();
    const discarded: string[] = [];
    const handler = createProblemPackageExportHandler({
      jobs: store,
      source,
      authorization: allowAll(),
      artifacts: {
        write: async () => ({
          fileId: currentFileId,
          expiresAt: "2026-07-27T00:00:00.000Z"
        }),
        discard: async (fileId) => {
          discarded.push(fileId);
        }
      }
    });

    await expect(
      handler(
        { exportJobId: job.id },
        makeContext({ attempt: 3, maxAttempts: 3 })
      )
    ).resolves.toEqual({
      result: { resultFileId: existingFileId }
    });
    expect(discarded).toEqual([currentFileId]);
  });

  it("导出失败状态无法保存时保留运行状态并交给队列重试", async () => {
    class FailingStateStore extends FakeProblemPackageJobStore {
      public override async failExportJob(): Promise<void> {
        throw new Error(`database rejected ${statementText}`);
      }
    }

    const store = new FailingStateStore();
    const job = store.seedExport();
    const selection = job.problems[0];
    if (selection === undefined) {
      throw new Error("测试导出任务没有题目选择。");
    }
    const source = new InMemoryFixedRevisionExportReader();
    source.put(selection, fixtureProblem());
    const handler = createProblemPackageExportHandler({
      jobs: store,
      source,
      authorization: {
        canReadProblem: async () => false,
        canReadFile: async () => true
      },
      artifacts: new InMemoryExportArtifactWriter()
    });

    await expect(handler({ exportJobId: job.id }, makeContext())).rejects.toMatchObject({
      name: "TaskStatePersistenceError",
      message: "题目包任务状态暂时无法保存。"
    });
    expect(store.exports.get(job.id)?.state).toBe("running");
    expect(JSON.stringify(store.exports.get(job.id))).not.toContain(statementText);
  });

  it("权限服务暂时失败时不把导出任务记成永久失败", async () => {
    const store = new FakeProblemPackageJobStore();
    const job = store.seedExport();
    const selection = job.problems[0];
    if (selection === undefined) {
      throw new Error("测试导出任务没有题目选择。");
    }
    const source = new InMemoryFixedRevisionExportReader();
    source.put(selection, fixtureProblem());
    const handler = createProblemPackageExportHandler({
      jobs: store,
      source,
      authorization: {
        canReadProblem: async () => {
          throw new ProblemPackageTemporaryError();
        },
        canReadFile: async () => true
      },
      artifacts: new InMemoryExportArtifactWriter()
    });

    await expect(handler({ exportJobId: job.id }, makeContext())).rejects.toMatchObject({
      name: "ProblemPackageTemporaryError",
      message: "题目包任务暂时无法继续，请稍后重试。"
    });
    expect(store.exports.get(job.id)?.state).toBe("running");
    expect(store.exports.get(job.id)?.failure).toBeNull();
  });

  it("最后一次临时导出失败会用固定错误结束业务任务", async () => {
    const store = new FakeProblemPackageJobStore();
    const job = store.seedExport();
    const selection = job.problems[0];
    if (selection === undefined) {
      throw new Error("测试导出任务没有题目选择。");
    }
    const source = new InMemoryFixedRevisionExportReader();
    source.put(selection, fixtureProblem());
    const handler = createProblemPackageExportHandler({
      jobs: store,
      source,
      authorization: {
        canReadProblem: async () => {
          throw new ProblemPackageTemporaryError();
        },
        canReadFile: async () => true
      },
      artifacts: new InMemoryExportArtifactWriter()
    });

    await expect(
      handler(
        { exportJobId: job.id },
        makeContext({ attempt: 3, maxAttempts: 3 })
      )
    ).rejects.toMatchObject({
      name: "PermanentJobError",
      code: "export_write_failed"
    });
    expect(store.exports.get(job.id)).toEqual(
      expect.objectContaining({
        state: "failed",
        failure: safeProblemPackageFailure("export_write_failed")
      })
    );
  });

  it("已经失败的导出任务直接结束，不再尝试改写终态", async () => {
    const store = new FakeProblemPackageJobStore();
    const job = store.seedExport({
      state: "failed",
      report: {
        version: 1,
        phase: "failed",
        completedItems: 0,
        failedItems: 1,
        skippedItems: 0
      },
      failure: safeProblemPackageFailure("export_access_revoked"),
      startedAt: fixedNow,
      finishedAt: fixedNow
    });
    const handler = createProblemPackageExportHandler({
      jobs: store,
      source: new InMemoryFixedRevisionExportReader(),
      authorization: allowAll(),
      artifacts: new InMemoryExportArtifactWriter()
    });

    await expect(handler({ exportJobId: job.id }, makeContext())).rejects.toMatchObject({
      name: "PermanentJobError",
      code: "export_access_revoked"
    });
    expect(store.exports.get(job.id)?.state).toBe("failed");
  });

  it("原始 XML 产物按一个文件计数并保持字节不变", async () => {
    const store = new FakeProblemPackageJobStore();
    const job = store.seedExport({ targetFormat: "single.test" });
    const selection = job.problems[0];
    if (selection === undefined) {
      throw new Error("测试导出任务没有题目选择。");
    }
    const source = new InMemoryFixedRevisionExportReader();
    source.put(selection, fixtureProblem());
    const artifacts = new InMemoryExportArtifactWriter();
    const xml = new TextEncoder().encode("<?xml version=\"1.0\"?><fps />");
    const adapter: ProblemFormatAdapter = {
      id: "single.test",
      displayName: "单文件测试格式",
      version: "1.0.0",
      inputKind: "single_file",
      detect: async () => ({ confidence: 0, reason: "这个测试不识别导入文件。" }),
      inspect: async () => {
        throw new Error("这个测试不会预览导入文件。");
      },
      import: async () => {
        throw new Error("这个测试不会导入文件。");
      },
      validateExport: async () => ({
        targetFormat: "single.test",
        canExport: true,
        items: []
      }),
      export: async () => ({
        kind: "single_file",
        mediaType: "application/fps+xml",
        fileName: "problem.xml",
        content: xml
      })
    };
    const handler = createProblemPackageExportHandler({
      jobs: store,
      source,
      authorization: allowAll(),
      artifacts,
      adapterCatalog: createStaticProblemFormatAdapterCatalog(
        new Map([[adapter.id, adapter]])
      )
    });

    await expect(handler({ exportJobId: job.id }, makeContext())).resolves.toEqual({
      result: { resultFileId: expect.any(String) }
    });
    const finished = store.exports.get(job.id);
    expect(finished?.report.outputFileCount).toBe(1);
    const artifact = artifacts.get(finished?.resultFileId ?? "");
    const generated = artifact?.archives[0];
    expect(generated?.kind).toBe("single_file");
    if (generated?.kind !== "single_file") {
      throw new Error("导出结果不是预期的原始 XML。");
    }
    expect(generated.mediaType).toBe("application/fps+xml");
    expect(generated.content).toEqual(xml);
  });

  it("继续接受插件接口第一版省略 kind 的 ZIP 导出结果", async () => {
    const store = new FakeProblemPackageJobStore();
    const job = store.seedExport({ targetFormat: "legacy.zip" });
    const selection = job.problems[0];
    if (selection === undefined) {
      throw new Error("测试导出任务没有题目选择。");
    }
    const source = new InMemoryFixedRevisionExportReader();
    source.put(selection, fixtureProblem());
    const artifacts = new InMemoryExportArtifactWriter();
    const legacyAdapter: ProblemFormatAdapter = {
      id: "legacy.zip",
      displayName: "旧版 ZIP 测试格式",
      version: "1.0.0",
      detect: async () => ({ confidence: 0, reason: "这个测试不识别导入文件。" }),
      inspect: async () => {
        throw new Error("这个测试不会预览导入文件。");
      },
      import: async () => {
        throw new Error("这个测试不会导入文件。");
      },
      validateExport: async () => ({
        targetFormat: "legacy.zip",
        canExport: true,
        items: []
      }),
      export: async () => ({
        mediaType: "application/zip",
        fileName: "problem.zip",
        files: [
          {
            path: "payload.txt",
            content: new TextEncoder().encode("legacy")
          }
        ]
      })
    };
    const handler = createProblemPackageExportHandler({
      jobs: store,
      source,
      authorization: allowAll(),
      artifacts,
      adapterCatalog: createStaticProblemFormatAdapterCatalog(
        new Map([[legacyAdapter.id, legacyAdapter]])
      )
    });

    await expect(handler({ exportJobId: job.id }, makeContext())).resolves.toEqual({
      result: { resultFileId: expect.any(String) }
    });
    const finished = store.exports.get(job.id);
    const generated = artifacts.get(finished?.resultFileId ?? "")?.archives[0];
    expect(generated).toEqual(
      expect.objectContaining({
        kind: "zip",
        fileName: "problem.zip"
      })
    );
  });

  it("题目读取权限被撤销时立即失败", async () => {
    const store = new FakeProblemPackageJobStore();
    const job = store.seedExport();
    const selection = job.problems[0];
    if (selection === undefined) {
      throw new Error("The seeded export task has no selection.");
    }
    const source = new InMemoryFixedRevisionExportReader();
    source.put(selection, fixtureProblem());
    const handler = createProblemPackageExportHandler({
      jobs: store,
      source,
      authorization: { canReadProblem: async () => false, canReadFile: async () => true },
      artifacts: new InMemoryExportArtifactWriter()
    });

    await expect(handler({ exportJobId: job.id }, makeContext())).rejects.toMatchObject({
      code: "export_access_revoked"
    });
    expect(store.exports.get(job.id)).toEqual(
      expect.objectContaining({
        state: "failed",
        failure: safeProblemPackageFailure("export_access_revoked"),
        resultFileId: null
      })
    );
  });

  it("单个文件权限被撤销时失败且不读取该文件", async () => {
    const store = new FakeProblemPackageJobStore();
    const job = store.seedExport();
    const selection = job.problems[0];
    if (selection === undefined) {
      throw new Error("The seeded export task has no selection.");
    }
    const source = new InMemoryFixedRevisionExportReader();
    source.put(selection, fixtureProblem());
    const readFiles: string[] = [];
    const handler = createProblemPackageExportHandler({
      jobs: store,
      source: {
        readRevision: (input) => source.readRevision(input),
        readFile: async (input) => {
          readFiles.push(input.file.path);
          return source.readFile(input);
        }
      },
      authorization: { canReadProblem: async () => true, canReadFile: async () => false },
      artifacts: new InMemoryExportArtifactWriter(),
      maxInMemoryBytes: 1
    });

    await expect(handler({ exportJobId: job.id }, makeContext())).rejects.toMatchObject({
      code: "export_access_revoked"
    });
    expect(readFiles).toEqual([]);
    expect(store.exports.get(job.id)?.failure).toEqual(
      safeProblemPackageFailure("export_access_revoked")
    );
  });

  it("多题所选文件总量超限时不读取任何文件内容", async () => {
    const selections = [
      {
        problemId: "10",
        revisionId: randomUUID(),
        includedFileCategories: ["testdata" as const]
      },
      {
        problemId: "11",
        revisionId: randomUUID(),
        includedFileCategories: ["testdata" as const]
      }
    ];
    const store = new FakeProblemPackageJobStore();
    const job = store.seedExport({ problems: selections });
    const source = new InMemoryFixedRevisionExportReader();
    for (const selection of job.problems) {
      source.put(selection, fixtureProblem());
    }
    const readFiles: string[] = [];
    const authorizedProblems: string[] = [];
    const authorizedFiles: string[] = [];
    const handler = createProblemPackageExportHandler({
      jobs: store,
      source: {
        readRevision: (input) => source.readRevision(input),
        readFile: async (input) => {
          readFiles.push(input.file.path);
          return source.readFile(input);
        }
      },
      authorization: {
        canReadProblem: async ({ selection }) => {
          authorizedProblems.push(selection.problemId);
          return true;
        },
        canReadFile: async ({ selection }) => {
          authorizedFiles.push(selection.problemId);
          return true;
        }
      },
      artifacts: new InMemoryExportArtifactWriter(),
      maxInMemoryBytes: 7
    });

    await expect(handler({ exportJobId: job.id }, makeContext())).rejects.toMatchObject({
      code: "export_too_large"
    });
    expect(readFiles).toEqual([]);
    expect(new Set(authorizedProblems)).toEqual(new Set(["10", "11"]));
    expect(new Set(authorizedFiles)).toEqual(new Set(["10", "11"]));
    expect(store.exports.get(job.id)?.failure).toEqual(
      safeProblemPackageFailure("export_too_large")
    );
  });

  it("前面已知超限时仍先检查后续题目的读取权限", async () => {
    const selections = [
      {
        problemId: "10",
        revisionId: randomUUID(),
        includedFileCategories: ["testdata" as const]
      },
      {
        problemId: "11",
        revisionId: randomUUID(),
        includedFileCategories: ["testdata" as const]
      }
    ];
    const store = new FakeProblemPackageJobStore();
    const job = store.seedExport({ problems: selections });
    const firstSelection = job.problems[0];
    if (firstSelection === undefined) {
      throw new Error("The seeded export task has no first selection.");
    }
    const source = new InMemoryFixedRevisionExportReader();
    source.put(firstSelection, fixtureProblem());
    const checkedProblems: string[] = [];
    const readFiles: string[] = [];
    const handler = createProblemPackageExportHandler({
      jobs: store,
      source: {
        readRevision: (input) => source.readRevision(input),
        readFile: async (input) => {
          readFiles.push(input.file.path);
          return source.readFile(input);
        }
      },
      authorization: {
        canReadProblem: async ({ selection }) => {
          checkedProblems.push(selection.problemId);
          return selection.problemId !== "11";
        },
        canReadFile: async () => true
      },
      artifacts: new InMemoryExportArtifactWriter(),
      maxInMemoryBytes: 1
    });

    await expect(handler({ exportJobId: job.id }, makeContext())).rejects.toMatchObject({
      code: "export_access_revoked"
    });
    expect(checkedProblems).toEqual(["10", "11"]);
    expect(readFiles).toEqual([]);
    expect(store.exports.get(job.id)?.failure).toEqual(
      safeProblemPackageFailure("export_access_revoked")
    );
  });

  it("生成内容总量超限时停止后续题目且不写入导出包", async () => {
    const selections = ["10", "11", "12"].map((problemId) => ({
      problemId,
      revisionId: randomUUID(),
      includedFileCategories: ["testdata" as const]
    }));
    const store = new FakeProblemPackageJobStore();
    const job = store.seedExport({ problems: selections });
    const source = new InMemoryFixedRevisionExportReader();
    for (const [index, selection] of job.problems.entries()) {
      const problem = fixtureProblem();
      source.put(
        selection,
        canonicalProblemSchema.parse({
          ...problem,
          title: `Generated ${index + 1}`,
          files: problem.files.map((file) => ({
            ...file,
            content: new Uint8Array([index + 1])
          }))
        })
      );
    }

    const authorizedProblems = new Set<string>();
    const authorizedFiles = new Set<string>();
    const exportedTitles: string[] = [];
    let exportStarted = false;
    let artifactWrites = 0;
    const adapter: ProblemFormatAdapter = {
      id: "urmotiv",
      displayName: "测试格式",
      version: "1.0.0",
      detect: async () => ({ confidence: 0, reason: "测试未使用" }),
      inspect: async () => {
        throw new Error("The export test must not inspect an archive.");
      },
      import: async () => {
        throw new Error("The export test must not import an archive.");
      },
      validateExport: async () => ({
        targetFormat: "urmotiv",
        canExport: true,
        items: []
      }),
      export: async (problem) => {
        exportStarted = true;
        exportedTitles.push(problem.title);
        return {
          kind: "zip",
          mediaType: "application/zip",
          fileName: "problem.zip",
          files: [{ path: "payload.bin", content: new Uint8Array(4) }]
        };
      }
    };
    const handler = createProblemPackageExportHandler({
      jobs: store,
      source,
      authorization: {
        canReadProblem: async ({ selection }) => {
          if (!exportStarted) authorizedProblems.add(selection.problemId);
          return true;
        },
        canReadFile: async ({ selection }) => {
          if (!exportStarted) authorizedFiles.add(selection.problemId);
          return true;
        }
      },
      artifacts: {
        write: async () => {
          artifactWrites += 1;
          return {
            fileId: randomUUID(),
            expiresAt: "2026-07-27T00:00:00.000Z"
          };
        }
      },
      adapterCatalog: createStaticProblemFormatAdapterCatalog(
        new Map([["urmotiv", adapter]])
      ),
      maxInMemoryBytes: 7
    });

    await expect(handler({ exportJobId: job.id }, makeContext())).rejects.toMatchObject({
      code: "export_too_large"
    });
    expect(authorizedProblems).toEqual(new Set(["10", "11", "12"]));
    expect(authorizedFiles).toEqual(new Set(["10", "11", "12"]));
    expect(exportedTitles).toEqual(["Generated 1", "Generated 2"]);
    expect(artifactWrites).toBe(0);
    expect(store.exports.get(job.id)?.failure).toEqual(
      safeProblemPackageFailure("export_too_large")
    );
  });

  it("压缩包目录开销导致超限时提示分批导出", async () => {
    const store = new FakeProblemPackageJobStore();
    const job = store.seedExport();
    const selection = job.problems[0];
    if (selection === undefined) {
      throw new Error("The seeded export task has no selection.");
    }
    const source = new InMemoryFixedRevisionExportReader();
    source.put(selection, fixtureProblem());
    const handler = createProblemPackageExportHandler({
      jobs: store,
      source,
      authorization: allowAll(),
      artifacts: {
        write: async () => {
          throw new UnsafeArchiveError([
            {
              severity: "error",
              code: "archive_too_large",
              message: "压缩包超过当前大小限制。"
            }
          ]);
        }
      }
    });

    await expect(handler({ exportJobId: job.id }, makeContext())).rejects.toMatchObject({
      code: "export_too_large"
    });
    expect(store.exports.get(job.id)?.failure).toEqual(
      safeProblemPackageFailure("export_too_large")
    );
  });

  it("保存导出文件失败时任务失败且不泄露内部错误", async () => {
    const store = new FakeProblemPackageJobStore();
    const job = store.seedExport();
    const selection = job.problems[0];
    if (selection === undefined) {
      throw new Error("The seeded export task has no selection.");
    }
    const source = new InMemoryFixedRevisionExportReader();
    source.put(selection, fixtureProblem());
    const handler = createProblemPackageExportHandler({
      jobs: store,
      source,
      authorization: allowAll(),
      artifacts: {
        write: async () => {
          throw new Error(`object storage rejected ${statementText}`);
        }
      }
    });

    await expect(handler({ exportJobId: job.id }, makeContext())).rejects.toMatchObject({
      code: "export_write_failed"
    });
    const serialized = JSON.stringify(store.exports.get(job.id));
    expect(serialized).not.toContain(statementText);
    expect(serialized).not.toContain("object storage rejected");
  });
});
