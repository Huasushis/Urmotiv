import { randomUUID } from "node:crypto";
import {
  createSafeArchive,
  canonicalProblemSchema,
  urmotivNativeAdapter,
  type CanonicalProblem
} from "@urmotiv/problem-package";
import {
  problemPackageExportJobSchema,
  problemPackageImportItemSchema,
  problemPackageImportJobSchema,
  problemPackageJobReportSchema,
  safeProblemPackageFailure,
  type CompleteProblemPackageExport,
  type CreateProblemPackageExportJob,
  type CreateProblemPackageImportJob,
  type ImportItemOutcome,
  type ProblemPackageExportJob,
  type ProblemPackageFailureCode,
  type ProblemPackageImportItem,
  type ProblemPackageImportJob,
  type ProblemPackageJobReport,
  type ProblemPackageJobStore
} from "@urmotiv/jobs";
import type { JobItemReport } from "@urmotiv/jobs";
import { describe, expect, it } from "vitest";
import {
  InMemoryExportArtifactWriter,
  InMemoryFixedRevisionExportReader,
  InMemoryVerifiedImportArchiveReader,
  createProblemPackageExportHandler,
  createProblemPackageImportHandler,
  type ExportReadAuthorization,
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
      sourceFileId: randomUUID(),
      inputDigest: "a".repeat(64),
      detectedFormat: null,
      selectedFormat: "urmotiv",
      choices: { conflictAction: "create" },
      itemCount: 1,
      state: "queued",
      progressPercent: 0,
      report: initialReport(),
      failure: null,
      idempotencyKey: "import-1",
      startedAt: null,
      finishedAt: null,
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
      targetFormat: "urmotiv",
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

function makeContext(): JobHandlerContext & { readonly itemReports: JobItemReport[] } {
  const itemReports: JobItemReport[] = [];
  return {
    jobId: randomUUID(),
    attempt: 1,
    signal: new AbortController().signal,
    itemReports,
    updateProgress: async () => {},
    putItemReport: async (report) => {
      itemReports.push(structuredClone(report));
    }
  };
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

async function nativeArchiveOf(problem: CanonicalProblem) {
  const generated = await urmotivNativeAdapter.export(problem, { exportedAt: fixedNow });
  return createSafeArchive(
    generated.files.map((file) => ({
      path: file.path,
      kind: "file" as const,
      compressedSize: file.content.byteLength,
      uncompressedSize: file.content.byteLength,
      content: file.content
    }))
  );
}

function allowAll(): ExportReadAuthorization {
  return {
    canReadProblem: async () => true,
    canReadFile: async () => true
  };
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
      artifacts: new InMemoryExportArtifactWriter()
    });

    await expect(handler({ exportJobId: job.id }, makeContext())).rejects.toMatchObject({
      code: "export_access_revoked"
    });
    expect(readFiles).toEqual([]);
    expect(store.exports.get(job.id)?.failure).toEqual(
      safeProblemPackageFailure("export_access_revoked")
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
