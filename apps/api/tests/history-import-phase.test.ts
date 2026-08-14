import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import {
  createPostgresDatabase,
  type DatabaseHandle,
  type PostgresDatabaseHandle,
} from "@urmotiv/database";
import {
  readZipArchive,
  UnsafeArchiveError,
  defaultArchiveSafetyLimits,
  urmotivNativeAdapter,
  nativeProblemMediaType,
  writeZipArchive,
  type CanonicalProblem,
} from "@urmotiv/problem-package";
import {
  type HistoryImportJobStore,
  type ImportJobReplayResult,
  type ProblemPackageJobStore,
  type ProblemPackageImportJob,
  type ProblemPackageExportJob,
  type ProblemPackageImportItem,
  type ProblemPackageJobReport,
  type ProblemPackageFailureCode,
  type ImportItemOutcome,
  type CreateProblemPackageImportJob,
  type CreateProblemPackageExportJob,
  type CompleteProblemPackageExport,
  type HistoryImportRecoveryStore,
  type HistoryImportJobClaim,
  type AtomicImportedProblemWriter,
  type ProblemPackageImportChoices,
} from "@urmotiv/jobs";
import {
  LocalFileStorage,
  type FileStorage,
  type StageFileInput,
  type StagedFile,
  type StoredFile,
} from "@urmotiv/storage";
import { deflateRawSync } from "node:zlib";
import { ProblemFileStore } from "../src/problem-file-store";
import { DatabaseProblemPackageJobStore } from "../src/problem-package-job-store";
import {
  DatabaseImportedProblemWriter,
  ServiceImportExecutionAuthorization,
} from "../src/problem-package-runtime";
import { DatabaseDataStore } from "../src/database-store";
import { DatabaseProblemPackageAuditWriter } from "../src/problem-package-audit";
import { databaseDemoUserIds } from "../src/database-demo";
import {
  dropHistoryImportDatabase,
  historyImportDatabaseConnectionString,
  importHistoryPackages,
  prepareHistoryImportDatabase,
  type HistoryImportPublisher,
} from "../src/history-migration/import-phase";
import { sha256Hex } from "../src/history-migration/digests";
import type { CreateStoredFileInput, StoredFileRecord } from "@urmotiv/contracts";
import { readPrivateJson } from "../src/history-migration/private-files";
const adminUrl = process.env.URMOTIV_TEST_POSTGRES_ADMIN_URL;
const describePostgres = adminUrl === undefined ? describe.skip : describe;

const temporaryDirectories: string[] = [];
const temporaryDatabaseNames: string[] = [];

describePostgres("历史题目正式导入桥接", () => {
  let primary: PostgresDatabaseHandle | undefined;

  beforeAll(async () => {
    if (adminUrl === undefined) return;
    const databaseName = `urmotiv_history_import_${process.pid}_${randomUUID()
      .replaceAll("-", "")
      .slice(0, 12)}`;
    temporaryDatabaseNames.push(databaseName);
    await prepareHistoryImportDatabase(adminUrl, databaseName);
    primary = createPostgresDatabase({
      connectionString: historyImportDatabaseConnectionString(adminUrl, databaseName),
      maxConnections: 8,
      applicationName: "urmotiv-history-import-test",
    });
  });

  afterAll(async () => {
    await primary?.close();
    if (adminUrl === undefined) return;
    for (const databaseName of temporaryDatabaseNames.splice(0)) {
      await dropHistoryImportDatabase(adminUrl, databaseName);
    }
  });

  afterEach(async () => {
    await Promise.all(
      temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
    );
  });

  it("正式导入成功：题目以指定标签写入、清单与完成标记发布", async () => {
    if (primary === undefined) throw new Error("未建立真实 PostgreSQL 测试数据库。");
    const root = await createPrivateRoot();
    const packageDirectory = join(root, "package-output");
    const outputDirectory = join(root, "import-output");
    await mkdir(join(packageDirectory, "packages"), { mode: 0o700, recursive: true });
    const packaged = await createSyntheticPackage(packageDirectory, "candidate-000001");
    await writePackageReport(packageDirectory, [packaged]);

    const dependencies = importDependencies(primary, join(root, "storage"));
    const result = await importHistoryPackages({
      privateRootDirectory: root,
      packageDirectory,
      outputDirectory,
      dependencies,
    });
    expect(result).toEqual({
      packageCount: 1,
      importedCount: 1,
      skippedCount: 0,
      failedCount: 0,
      failedCandidateIds: [],
      failedCandidates: [],
    });
    expect(await countProblems(primary)).toBe(1);

    const imported = await readImportedProblem(primary);
    expect(imported).toMatchObject({ title: "合成题目 candidate-000001" });
    const tagRows = await primary.query<{ tag_id: string }>(sql`
      SELECT tag_id
      FROM problem_revision_tags
      WHERE revision_id = ${imported.revisionId}::uuid
    `);
    expect(tagRows).toEqual([{ tag_id: "catalog.tag.01.01" }]);

    const jobRows = await primary.query<{ count: number }>(sql`
      SELECT count(*)::integer AS count FROM import_jobs
    `);
    expect(Number(jobRows[0]?.count ?? 0)).toBe(1);
    const jobItems = await primary.query<{ state: string; imported_problem_id: string }>(sql`
      SELECT state::text AS state, imported_problem_id::text AS imported_problem_id
      FROM import_job_items
    `);
    expect(jobItems).toEqual([
      { state: "succeeded", imported_problem_id: String(imported.problemId) },
    ]);

    const manifest = JSON.parse(
      await readFile(join(outputDirectory, "import-manifest.private.json"), "utf8"),
    );
    expect(manifest.importedCount).toBe(1);
    expect(manifest.entries).toEqual([
      expect.objectContaining({
        candidateId: "candidate-000001",
        packageSha256: packaged.packageSha256,
        problemId: String(imported.problemId),
      }),
    ]);
    const completeMarker = JSON.parse(
      await readFile(join(outputDirectory, "IMPORT_COMPLETE"), "utf8"),
    );
    expect(completeMarker).toMatchObject({
      version: 1,
      phase: "import",
      importedCount: 1,
    });
  });

  it("幂等重跑：清单跳过已导入包，数据库不产生重复题目", async () => {
    if (primary === undefined) throw new Error("未建立真实 PostgreSQL 测试数据库。");
    const root = await createPrivateRoot();
    const packageDirectory = join(root, "package-output");
    const outputDirectory = join(root, "import-output");
    await mkdir(join(packageDirectory, "packages"), { mode: 0o700, recursive: true });
    const packaged = await createSyntheticPackage(packageDirectory, "candidate-000001");
    await writePackageReport(packageDirectory, [packaged]);

    const dependencies = importDependencies(primary, join(root, "storage"));
    const first = await importHistoryPackages({
      privateRootDirectory: root,
      packageDirectory,
      outputDirectory,
      dependencies,
    });
    expect(first.importedCount).toBe(1);
    const problemsAfterFirst = await countProblems(primary);

    const second = await importHistoryPackages({
      privateRootDirectory: root,
      packageDirectory,
      outputDirectory,
      dependencies,
    });
    expect(second).toEqual({
      packageCount: 1,
      importedCount: 0,
      skippedCount: 1,
      failedCount: 0,
      failedCandidateIds: [],
      failedCandidates: [],
    });
    expect(await countProblems(primary)).toBe(problemsAfterFirst);
  });

  it("权限不足：任务失败、题目不落库（等价于未找到，无数据泄漏）", async () => {
    if (primary === undefined) throw new Error("未建立真实 PostgreSQL 测试数据库。");
    const root = await createPrivateRoot();
    const packageDirectory = join(root, "package-output");
    const outputDirectory = join(root, "import-output");
    await mkdir(join(packageDirectory, "packages"), { mode: 0o700, recursive: true });
    const packaged = await createSyntheticPackage(packageDirectory, "candidate-000001");
    await writePackageReport(packageDirectory, [packaged]);
    const problemsBefore = await countProblems(primary);
    const jobsBefore = await countImportJobs(primary);

    const result = await importHistoryPackages({
      privateRootDirectory: root,
      packageDirectory,
      outputDirectory,
      dependencies: {
        ...importDependencies(primary, join(root, "storage")),
        requestedByUserId: databaseDemoUserIds.reviewer,
      },
    });
    expect(result).toEqual({
      packageCount: 1,
      importedCount: 0,
      skippedCount: 0,
      failedCount: 1,
      failedCandidateIds: ["candidate-000001"],
      failedCandidates: [{ candidateId: "candidate-000001", code: "internal_failure" }],
    });
    // 题目没有落库（等价于未找到，无数据泄漏）。
    expect(await countProblems(primary)).toBe(problemsBefore);

    const items = await primary.query<{ state: string; failure_code: string }>(sql`
      SELECT state::text AS state, failure_code::text AS failure_code
      FROM import_job_items
      WHERE job_id IN (
        SELECT id FROM import_jobs
        WHERE requested_by_user_id = ${databaseDemoUserIds.reviewer}
      )
    `);
    expect(items).toEqual([{ state: "failed", failure_code: "import_access_revoked" }]);
    const jobs = await primary.query<{ state: string }>(sql`
      SELECT state::text AS state
      FROM import_jobs
      WHERE requested_by_user_id = ${databaseDemoUserIds.reviewer}
    `);
    expect(jobs).toEqual([{ state: "failed" }]);
    expect(await countImportJobs(primary)).toBe(jobsBefore + 1);
    // 失败不发布完成标记。
    await expect(readFile(join(outputDirectory, "IMPORT_COMPLETE"), "utf8")).rejects.toBeDefined();
  });
  it("无明确授权上下文不可导入：不存在的主体直接拒绝，不留下任何任务痕迹", async () => {
    if (primary === undefined) throw new Error("未建立真实 PostgreSQL 测试数据库。");
    const root = await createPrivateRoot();
    const packageDirectory = join(root, "package-output");
    const outputDirectory = join(root, "import-output");
    await mkdir(join(packageDirectory, "packages"), { mode: 0o700, recursive: true });
    const packaged = await createSyntheticPackage(packageDirectory, "candidate-000001");
    await writePackageReport(packageDirectory, [packaged]);
    const problemsBefore = await countProblems(primary);
    const jobsBefore = await countImportJobs(primary);

    await expect(
      importHistoryPackages({
        privateRootDirectory: root,
        packageDirectory,
        outputDirectory,
        dependencies: {
          ...importDependencies(primary, join(root, "storage")),
          requestedByUserId: "no-such-user",
        },
      }),
    ).rejects.toMatchObject({ code: "NOT_AUTHORIZED" });
    // 等价于未找到：不落库，不留任务。
    expect(await countProblems(primary)).toBe(problemsBefore);
    expect(await countImportJobs(primary)).toBe(jobsBefore);
    // 失败不发布完成标记。
    await expect(readFile(join(outputDirectory, "IMPORT_COMPLETE"), "utf8")).rejects.toBeDefined();
  });

  it("角色权限不足：任务落入失败状态且不落库（与平台导入语义一致）", async () => {
    if (primary === undefined) throw new Error("未建立真实 PostgreSQL 测试数据库。");
    const root = await createPrivateRoot();
    const packageDirectory = join(root, "package-output");
    const outputDirectory = join(root, "import-output");
    await mkdir(join(packageDirectory, "packages"), { mode: 0o700, recursive: true });
    const packaged = await createSyntheticPackage(packageDirectory, "candidate-000001");
    await writePackageReport(packageDirectory, [packaged]);
    const problemsBefore = await countProblems(primary);

    const result = await importHistoryPackages({
      privateRootDirectory: root,
      packageDirectory,
      outputDirectory,
      dependencies: {
        ...importDependencies(primary, join(root, "storage")),
        requestedByUserId: databaseDemoUserIds.reviewer,
      },
    });
    expect(result.importedCount).toBe(0);
    expect(result.failedCount).toBe(1);
    expect(await countProblems(primary)).toBe(problemsBefore);
  });


  it("一个包损坏时其余包继续导入，修复后重跑只处理失败包", async () => {
    if (primary === undefined) throw new Error("未建立真实 PostgreSQL 测试数据库。");
    const root = await createPrivateRoot();
    const packageDirectory = join(root, "package-output");
    const outputDirectory = join(root, "import-output");
    await mkdir(join(packageDirectory, "packages"), { mode: 0o700, recursive: true });
    const first = await createSyntheticPackage(packageDirectory, "candidate-000001");
    const second = await createSyntheticPackage(packageDirectory, "candidate-000002");
    await writePackageReport(packageDirectory, [first, second]);
    // 损坏第二个包：内容与包报告摘要不一致。
    await writeFile(
      join(packageDirectory, "packages", "candidate-000002.zip"),
      new TextEncoder().encode("corrupted-candidate-000002"),
    );

    const dependencies = importDependencies(primary, join(root, "storage"));
    const problemsBefore = await countProblems(primary);
    const firstRun = await importHistoryPackages({
      privateRootDirectory: root,
      packageDirectory,
      outputDirectory,
      dependencies,
    });
    expect(firstRun).toEqual({
      packageCount: 2,
      importedCount: 1,
      skippedCount: 0,
      failedCount: 1,
      failedCandidateIds: ["candidate-000002"],
      failedCandidates: [{ candidateId: "candidate-000002", code: "SOURCE_DIGEST_MISMATCH" }],
    });
    expect(await countProblems(primary)).toBe(problemsBefore + 1);

    // 修复损坏包（重新生成一致摘要）后重跑：已导入包被跳过，只补失败包。
    const repairedSecond = await createSyntheticPackage(packageDirectory, "candidate-000002");
    await writePackageReport(packageDirectory, [first, repairedSecond]);
    const secondRun = await importHistoryPackages({
      privateRootDirectory: root,
      packageDirectory,
      outputDirectory,
      dependencies,
    });
    expect(secondRun).toEqual({
      packageCount: 2,
      importedCount: 1,
      skippedCount: 1,
      failedCount: 0,
      failedCandidateIds: [],
      failedCandidates: [],
    });
    expect(await countProblems(primary)).toBe(problemsBefore + 2);
  });

  // ---- 有界包读取与尺寸强制（scope 1）----

  it("包文件大小与报告声明的 packageBytes 不一致时拒绝导入", async () => {
    if (primary === undefined) throw new Error("未建立真实 PostgreSQL 测试数据库。");
    const root = await createPrivateRoot();
    const packageDirectory = join(root, "package-output");
    const outputDirectory = join(root, "import-output");
    await mkdir(join(packageDirectory, "packages"), { mode: 0o700, recursive: true });
    const packaged = await createSyntheticPackage(packageDirectory, "candidate-000001");
    // 声明一个与实际大小不同的 packageBytes。
    await writePackageReport(packageDirectory, [
      { ...packaged, packageBytes: packaged.packageBytes + 100 },
    ]);
    const problemsBefore = await countProblems(primary);
    const result = await importHistoryPackages({
      privateRootDirectory: root,
      packageDirectory,
      outputDirectory,
      dependencies: importDependencies(primary, join(root, "storage")),
    });
    expect(result).toEqual({
      packageCount: 1,
      importedCount: 0,
      skippedCount: 0,
      failedCount: 1,
      failedCandidateIds: ["candidate-000001"],
      failedCandidates: [{ candidateId: "candidate-000001", code: "SOURCE_DIGEST_MISMATCH" }],
    });
    expect(await countProblems(primary)).toBe(problemsBefore);
  });

  it("包文件被替换为符号链接时拒绝导入", async () => {
    if (primary === undefined) throw new Error("未建立真实 PostgreSQL 测试数据库。");
    const root = await createPrivateRoot();
    const packageDirectory = join(root, "package-output");
    const outputDirectory = join(root, "import-output");
    await mkdir(join(packageDirectory, "packages"), { mode: 0o700, recursive: true });
    const packaged = await createSyntheticPackage(packageDirectory, "candidate-000001");
    await writePackageReport(packageDirectory, [packaged]);
    // 用符号链接替换真实 zip。
    const target = join(root, "malicious-target.zip");
    await writeFile(target, Buffer.alloc(0));
    await rm(join(packageDirectory, "packages", "candidate-000001.zip"));
    await symlink(target, join(packageDirectory, "packages", "candidate-000001.zip"));
    const problemsBefore = await countProblems(primary);
    const result = await importHistoryPackages({
      privateRootDirectory: root,
      packageDirectory,
      outputDirectory,
      dependencies: importDependencies(primary, join(root, "storage")),
    });
    expect(result.failedCount).toBe(1);
    expect(result.failedCandidateIds).toEqual(["candidate-000001"]);
    expect(await countProblems(primary)).toBe(problemsBefore);
  });

  // ---- 压缩包安全：遍历/符号链接/炸弹/碰撞/限制（scope 2）----

  it("包含路径遍历条目的压缩包在导入阶段被拒绝", async () => {
    if (primary === undefined) throw new Error("未建立真实 PostgreSQL 测试数据库。");
    const root = await createPrivateRoot();
    const packageDirectory = join(root, "package-output");
    const outputDirectory = join(root, "import-output");
    await mkdir(join(packageDirectory, "packages"), { mode: 0o700, recursive: true });
    // 构造一个含路径遍历的压缩包。
    const maliciousZip = buildRawZip([
      { path: "problem.json", content: new TextEncoder().encode("{}") },
      { path: "../secret.txt", content: new TextEncoder().encode("leaked") },
    ]);
    const packageSha256 = sha256Hex(maliciousZip);
    const packageBytes = maliciousZip.byteLength;
    await writeFile(join(packageDirectory, "packages", "candidate-000001.zip"), maliciousZip);
    await writePackageReport(packageDirectory, [
      {
        candidateId: "candidate-000001",
        contentSha256: sha256Hex(new TextEncoder().encode("{}")),
        packageSha256,
        packageBytes,
      },
    ]);
    const problemsBefore = await countProblems(primary);
    const result = await importHistoryPackages({
      privateRootDirectory: root,
      packageDirectory,
      outputDirectory,
      dependencies: importDependencies(primary, join(root, "storage")),
    });
    expect(result.failedCount).toBe(1);
    expect(await countProblems(primary)).toBe(problemsBefore);
  });

  it("含符号链接条目的压缩包在导入阶段被拒绝", async () => {
    if (primary === undefined) throw new Error("未建立真实 PostgreSQL 测试数据库。");
    const root = await createPrivateRoot();
    const packageDirectory = join(root, "package-output");
    const outputDirectory = join(root, "import-output");
    await mkdir(join(packageDirectory, "packages"), { mode: 0o700, recursive: true });
    // 构造一个含符号链接条目的压缩包（unix mode = symlink）。
    const maliciousZip = buildRawZip([
      { path: "assets/link", content: new TextEncoder().encode("/etc/passwd"), symlink: true },
    ]);
    const packageSha256 = sha256Hex(maliciousZip);
    const packageBytes = maliciousZip.byteLength;
    await writeFile(join(packageDirectory, "packages", "candidate-000001.zip"), maliciousZip);
    await writePackageReport(packageDirectory, [
      {
        candidateId: "candidate-000001",
        contentSha256: "0".repeat(64),
        packageSha256,
        packageBytes,
      },
    ]);
    const problemsBefore = await countProblems(primary);
    const result = await importHistoryPackages({
      privateRootDirectory: root,
      packageDirectory,
      outputDirectory,
      dependencies: importDependencies(primary, join(root, "storage")),
    });
    expect(result.failedCount).toBe(1);
    expect(await countProblems(primary)).toBe(problemsBefore);
  });

  it("压缩比超限（压缩炸弹）的压缩包在导入阶段被拒绝", async () => {
    if (primary === undefined) throw new Error("未建立真实 PostgreSQL 测试数据库。");
    // 验证 readZipArchive 层面拒绝。
    const highRatioBytes = buildRawZip([
      {
        path: "judge/testdata/001.in",
        content: Buffer.alloc(100_000, 0x41),
      },
    ]);
    // readZipArchive 在解压前检查压缩比，超限应拒绝。
    expect(() => readZipArchive(highRatioBytes, { maxCompressionRatio: 20 })).toThrow(
      UnsafeArchiveError,
    );
  });

  it("条目数超限的压缩包在导入阶段被拒绝", async () => {
    // 直接在 readZipArchive 层面验证。
    const entries: { path: string; content: Uint8Array }[] = [];
    for (let i = 0; i < defaultArchiveSafetyLimits.maxEntries + 1; i++) {
      entries.push({
        path: `file_${i}.txt`,
        content: new TextEncoder().encode(`content_${i}`),
      });
    }
    const zipBytes = buildRawZip(entries);
    expect(() => readZipArchive(zipBytes)).toThrow(UnsafeArchiveError);
  });

  // ---- 事务回滚与故障恢复（scope 3）----

  it("写入失败后导入任务标记失败、题目不落库", async () => {
    if (primary === undefined) throw new Error("未建立真实 PostgreSQL 测试数据库。");
    const root = await createPrivateRoot();
    const packageDirectory = join(root, "package-output");
    const outputDirectory = join(root, "import-output");
    await mkdir(join(packageDirectory, "packages"), { mode: 0o700, recursive: true });
    const packaged = await createSyntheticPackage(packageDirectory, "candidate-000001");
    await writePackageReport(packageDirectory, [packaged]);
    const problemsBefore = await countProblems(primary);
    const jobsBefore = await countImportJobs(primary);
    // 使用 reviewer 权限（无导入权限）使写入阶段失败。
    const result = await importHistoryPackages({
      privateRootDirectory: root,
      packageDirectory,
      outputDirectory,
      dependencies: {
        ...importDependencies(primary, join(root, "storage")),
        requestedByUserId: databaseDemoUserIds.reviewer,
      },
    });
    expect(result.failedCount).toBe(1);
    expect(await countProblems(primary)).toBe(problemsBefore);
    expect(await countImportJobs(primary)).toBe(jobsBefore + 1);
    // 任务状态为 failed。
    const jobs = await primary.query<{ state: string }>(sql`
      SELECT state::text AS state FROM import_jobs
      WHERE requested_by_user_id = ${databaseDemoUserIds.reviewer}
        AND input_digest = ${packaged.packageSha256}
    `);
    expect(jobs).toEqual([{ state: "failed" }]);
    // 失败不发布完成标记。
    await expect(readFile(join(outputDirectory, "IMPORT_COMPLETE"), "utf8")).rejects.toBeDefined();
    // 重跑（恢复正常权限）仍然成功——数据库一致。
    const retry = await importHistoryPackages({
      privateRootDirectory: root,
      packageDirectory,
      outputDirectory: join(root, "import-output-retry"),
      dependencies: importDependencies(primary, join(root, "storage")),
    });
    expect(retry.importedCount).toBe(1);
    expect(await countProblems(primary)).toBe(problemsBefore + 1);
  });

  // ---- 存储文件摘要/大小/媒体类型/用途断言（scope 4）----

  it("导入后 stored_files 记录 inputDigest、byteSize、mediaType、purpose 与原始包一致", async () => {
    if (primary === undefined) throw new Error("未建立真实 PostgreSQL 测试数据库。");
    const root = await createPrivateRoot();
    const packageDirectory = join(root, "package-output");
    const outputDirectory = join(root, "import-output");
    await mkdir(join(packageDirectory, "packages"), { mode: 0o700, recursive: true });
    const packaged = await createSyntheticPackage(packageDirectory, "candidate-000001");
    await writePackageReport(packageDirectory, [packaged]);
    await importHistoryPackages({
      privateRootDirectory: root,
      packageDirectory,
      outputDirectory,
      dependencies: importDependencies(primary, join(root, "storage")),
    });
    const storedRows = await primary.query<{
      purpose: string;
      media_type: string;
      byte_size: string;
      sha256: string;
    }>(sql`
      SELECT purpose::text, media_type::text, byte_size::text, sha256::text
      FROM stored_files
      WHERE purpose = 'import_input' AND sha256 = ${packaged.packageSha256}
    `);
    expect(storedRows).toHaveLength(1);
    expect(storedRows[0]?.purpose).toBe("import_input");
    expect(storedRows[0]?.media_type).toBe(nativeProblemMediaType);
    expect(Number(storedRows[0]?.byte_size)).toBe(packaged.packageBytes);
    expect(storedRows[0]?.sha256).toBe(packaged.packageSha256);
    // import_jobs 的 input_digest 也应与包摘要一致。
    const jobRows = await primary.query<{ input_digest: string }>(sql`
      SELECT input_digest::text FROM import_jobs
      WHERE input_digest = ${packaged.packageSha256}
    `);
    expect(jobRows[0]?.input_digest).toBe(packaged.packageSha256);
  });

  // ---- 清单绑定当前批次、拒绝过期复用（scope 5）----

  it("修复包后重跑：已导入的包被跳过，修复的包重新导入（清单按 candidateId+sha 绑定）", async () => {
    if (primary === undefined) throw new Error("未建立真实 PostgreSQL 测试数据库。");
    const root = await createPrivateRoot();
    const packageDirectory = join(root, "package-output");
    const outputDirectory = join(root, "import-output");
    await mkdir(join(packageDirectory, "packages"), { mode: 0o700, recursive: true });
    const first = await createSyntheticPackage(packageDirectory, "candidate-000001");
    const second = await createSyntheticPackage(packageDirectory, "candidate-000002");
    await writePackageReport(packageDirectory, [first, second]);
    // 损坏第二个包。
    await writeFile(
      join(packageDirectory, "packages", "candidate-000002.zip"),
      new TextEncoder().encode("corrupted-candidate-000002"),
    );
    const problemsBefore = await countProblems(primary);
    const firstRun = await importHistoryPackages({
      privateRootDirectory: root,
      packageDirectory,
      outputDirectory,
      dependencies: importDependencies(primary, join(root, "storage")),
    });
    expect(firstRun.importedCount).toBe(1);
    expect(firstRun.failedCandidateIds).toEqual(["candidate-000002"]);
    // 读取第一次运行后的清单。
    const manifestAfterFirst = JSON.parse(
      await readFile(join(outputDirectory, "import-manifest.private.json"), "utf8"),
    );
    expect(manifestAfterFirst.entries).toHaveLength(1);
    expect(manifestAfterFirst.entries[0].candidateId).toBe("candidate-000001");
    // 修复第二个包后重跑。
    const repairedSecond = await createSyntheticPackage(packageDirectory, "candidate-000002");
    await writePackageReport(packageDirectory, [first, repairedSecond]);
    const secondRun = await importHistoryPackages({
      privateRootDirectory: root,
      packageDirectory,
      outputDirectory,
      dependencies: importDependencies(primary, join(root, "storage")),
    });
    expect(secondRun.importedCount).toBe(1);
    expect(secondRun.skippedCount).toBe(1);
    expect(secondRun.failedCount).toBe(0);
    expect(await countProblems(primary)).toBe(problemsBefore + 2);
    // 清单现在包含两个条目，batchSha256 更新为新报告的批次。
    const manifestAfterSecond = JSON.parse(
      await readFile(join(outputDirectory, "import-manifest.private.json"), "utf8"),
    );
    expect(manifestAfterSecond.entries).toHaveLength(2);
  });

  it("清单条目与当前报告 packageSha256 不一致时视为过期，不被跳过", async () => {
    if (primary === undefined) throw new Error("未建立真实 PostgreSQL 测试数据库。");
    const root = await createPrivateRoot();
    const packageDirectory = join(root, "package-output");
    const outputDirectory = join(root, "import-output");
    await mkdir(join(packageDirectory, "packages"), { mode: 0o700, recursive: true });
    const packaged = await createSyntheticPackage(packageDirectory, "candidate-000001");
    await writePackageReport(packageDirectory, [packaged]);
    await importHistoryPackages({
      privateRootDirectory: root,
      packageDirectory,
      outputDirectory,
      dependencies: importDependencies(primary, join(root, "storage")),
    });
    // 重新生成包（不同内容 -> 不同 sha），但保持 candidateId 不变。
    const repackaged = await createSyntheticPackage(packageDirectory, "candidate-000001");
    await writePackageReport(packageDirectory, [repackaged]);
    // 包已替换：清除旧源意图日志（旧 UUID 属于旧包，不可复用）。
    await rm(join(outputDirectory, "journal"), { recursive: true, force: true });
    const problemsBefore = await countProblems(primary);
    const result = await importHistoryPackages({
      privateRootDirectory: root,
      packageDirectory,
      outputDirectory,
      dependencies: importDependencies(primary, join(root, "storage")),
    });
    // 旧条目 sha 不匹配 -> 不跳过，重新导入。
    expect(result.importedCount).toBe(1);
    expect(result.skippedCount).toBe(0);
    expect(await countProblems(primary)).toBe(problemsBefore + 1);
  });

  // ---- 调试/错误表面不泄漏私有内容（scope 6）----

  it("HISTORY_IMPORT_DEBUG=1 时调试输出只含候选编号和分类码，不含路径或正文", async () => {
    if (primary === undefined) throw new Error("未建立真实 PostgreSQL 测试数据库。");
    const root = await createPrivateRoot();
    const packageDirectory = join(root, "package-output");
    const outputDirectory = join(root, "import-output");
    await mkdir(join(packageDirectory, "packages"), { mode: 0o700, recursive: true });
    const packaged = await createSyntheticPackage(packageDirectory, "candidate-000001");
    await writePackageReport(packageDirectory, [packaged]);
    // 损坏包以触发调试输出。
    await writeFile(
      join(packageDirectory, "packages", "candidate-000001.zip"),
      new TextEncoder().encode("corrupted"),
    );
    const originalEnv = process.env.HISTORY_IMPORT_DEBUG;
    process.env.HISTORY_IMPORT_DEBUG = "1";
    const captured: string[] = [];
    const originalError = console.error;
    console.error = (...args: unknown[]) => {
      captured.push(args.map(String).join(" "));
    };
    try {
      await importHistoryPackages({
        privateRootDirectory: root,
        packageDirectory,
        outputDirectory,
        dependencies: importDependencies(primary, join(root, "storage")),
      });
    } finally {
      console.error = originalError;
      if (originalEnv === undefined) delete process.env.HISTORY_IMPORT_DEBUG;
      else process.env.HISTORY_IMPORT_DEBUG = originalEnv;
    }
    const debugOutput = captured.join("\n");
    expect(debugOutput).toContain("candidate-000001");
    // 不应包含完整路径（私有根目录路径）。
    expect(debugOutput).not.toContain(root);
    expect(debugOutput).not.toContain(packageDirectory);
    // 不应包含正文片段。
    expect(debugOutput).not.toContain("合成题目");
  });

  // ---- 任务报告/导入 ID/幂等/原子清单（scope 7）----

  it("成功导入后任务报告为 completed 且 item 报告 succeeded", async () => {
    if (primary === undefined) throw new Error("未建立真实 PostgreSQL 测试数据库。");
    const root = await createPrivateRoot();
    const packageDirectory = join(root, "package-output");
    const outputDirectory = join(root, "import-output");
    await mkdir(join(packageDirectory, "packages"), { mode: 0o700, recursive: true });
    const packaged = await createSyntheticPackage(packageDirectory, "candidate-000001");
    await writePackageReport(packageDirectory, [packaged]);
    await importHistoryPackages({
      privateRootDirectory: root,
      packageDirectory,
      outputDirectory,
      dependencies: importDependencies(primary, join(root, "storage")),
    });
    const jobReport = await primary.query<{ report: unknown; state: string }>(sql`
      SELECT report::text, state::text FROM import_jobs
      WHERE input_digest = ${packaged.packageSha256}
    `);
    expect(jobReport).toHaveLength(1);
    const report = JSON.parse(String(jobReport[0]?.report));
    expect(report.phase).toBe("completed");
    expect(report.completedItems).toBe(1);
    expect(report.failedItems).toBe(0);
    expect(report.skippedItems).toBe(0);
    expect(jobReport[0]?.state).toBe("succeeded");
    const itemReport = await primary.query<{ report: unknown; state: string }>(sql`
      SELECT report::text, state::text FROM import_job_items
      WHERE job_id IN (
        SELECT id FROM import_jobs WHERE input_digest = ${packaged.packageSha256}
      )
    `);
    expect(itemReport).toHaveLength(1);
    expect(itemReport[0]?.state).toBe("succeeded");
  });

  it("幂等重跑不产生重复 import_jobs（idempotencyKey=packageSha256）", async () => {
    if (primary === undefined) throw new Error("未建立真实 PostgreSQL 测试数据库。");
    const root = await createPrivateRoot();
    const packageDirectory = join(root, "package-output");
    const outputDirectory = join(root, "import-output");
    await mkdir(join(packageDirectory, "packages"), { mode: 0o700, recursive: true });
    const packaged = await createSyntheticPackage(packageDirectory, "candidate-000001");
    await writePackageReport(packageDirectory, [packaged]);
    await importHistoryPackages({
      privateRootDirectory: root,
      packageDirectory,
      outputDirectory,
      dependencies: importDependencies(primary, join(root, "storage")),
    });
    const jobsBefore = await countImportJobs(primary);
    await importHistoryPackages({
      privateRootDirectory: root,
      packageDirectory,
      outputDirectory,
      dependencies: importDependencies(primary, join(root, "storage")),
    });
    expect(await countImportJobs(primary)).toBe(jobsBefore);
  });

  it("清单文件为有效 JSON 且包含 batchSha256、importedCount、entries", async () => {
    if (primary === undefined) throw new Error("未建立真实 PostgreSQL 测试数据库。");
    const root = await createPrivateRoot();
    const packageDirectory = join(root, "package-output");
    const outputDirectory = join(root, "import-output");
    await mkdir(join(packageDirectory, "packages"), { mode: 0o700, recursive: true });
    const packaged = await createSyntheticPackage(packageDirectory, "candidate-000001");
    await writePackageReport(packageDirectory, [packaged]);
    await importHistoryPackages({
      privateRootDirectory: root,
      packageDirectory,
      outputDirectory,
      dependencies: importDependencies(primary, join(root, "storage")),
    });
    const manifest = JSON.parse(
      await readFile(join(outputDirectory, "import-manifest.private.json"), "utf8"),
    );
    expect(manifest.version).toBe(1);
    expect(manifest.phase).toBe("import");
    expect(manifest.batchSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(manifest.importedCount).toBe(1);
    expect(manifest.entries).toHaveLength(1);
    expect(manifest.entries[0]).toMatchObject({
      candidateId: "candidate-000001",
      packageSha256: packaged.packageSha256,
    });
  });

  // ---- 完成标记批次绑定（correctness item 1）----

  it("先完成一批，再换新批次全部成功：完成标记更新为当前批次", async () => {
    if (primary === undefined) throw new Error("未建立真实 PostgreSQL 测试数据库。");
    const root = await createPrivateRoot();
    const packageDirectory = join(root, "package-output");
    const outputDirectory = join(root, "import-output");
    await mkdir(join(packageDirectory, "packages"), { mode: 0o700, recursive: true });
    // 第一批：1 个包，全部成功。
    const first = await createSyntheticPackage(packageDirectory, "candidate-000001");
    await writePackageReport(packageDirectory, [first]);
    await importHistoryPackages({
      privateRootDirectory: root,
      packageDirectory,
      outputDirectory,
      dependencies: importDependencies(primary, join(root, "storage")),
    });
    const markerAfterFirst = JSON.parse(
      await readFile(join(outputDirectory, "IMPORT_COMPLETE"), "utf8"),
    );
    expect(markerAfterFirst.batchSha256).toBeDefined();
    const firstBatchSha = markerAfterFirst.batchSha256;
    // 第二批：不同的包（不同 candidateId → 不同 batchSha256），全部成功。
    const second = await createSyntheticPackage(packageDirectory, "candidate-000002");
    await writePackageReport(packageDirectory, [second]);
    await importHistoryPackages({
      privateRootDirectory: root,
      packageDirectory,
      outputDirectory,
      dependencies: importDependencies(primary, join(root, "storage")),
    });
    const markerAfterSecond = JSON.parse(
      await readFile(join(outputDirectory, "IMPORT_COMPLETE"), "utf8"),
    );
    // 标记已更新为当前批次，不再是旧批次。
    expect(markerAfterSecond.batchSha256).not.toBe(firstBatchSha);
    expect(markerAfterSecond.batchSha256).toBeDefined();
    // 清单也更新为当前批次。
    const manifestAfterSecond = JSON.parse(
      await readFile(join(outputDirectory, "import-manifest.private.json"), "utf8"),
    );
    expect(manifestAfterSecond.batchSha256).toBe(markerAfterSecond.batchSha256);
  });

  it("先完成一批，再换新批次部分失败：完成标记被移除，不残留旧批次标记", async () => {
    if (primary === undefined) throw new Error("未建立真实 PostgreSQL 测试数据库。");
    const root = await createPrivateRoot();
    const packageDirectory = join(root, "package-output");
    const outputDirectory = join(root, "import-output");
    await mkdir(join(packageDirectory, "packages"), { mode: 0o700, recursive: true });
    // 第一批：1 个包，全部成功 → 写入完成标记。
    const first = await createSyntheticPackage(packageDirectory, "candidate-000001");
    await writePackageReport(packageDirectory, [first]);
    await importHistoryPackages({
      privateRootDirectory: root,
      packageDirectory,
      outputDirectory,
      dependencies: importDependencies(primary, join(root, "storage")),
    });
    expect(await readFile(join(outputDirectory, "IMPORT_COMPLETE"), "utf8")).toBeDefined();
    // 第二批：1 个好包 + 1 个损坏包 → 有失败 → 标记应被移除。
    const good = await createSyntheticPackage(packageDirectory, "candidate-000002");
    const corrupted = await createSyntheticPackage(packageDirectory, "candidate-000003");
    await writePackageReport(packageDirectory, [good, corrupted]);
    await writeFile(
      join(packageDirectory, "packages", "candidate-000003.zip"),
      new TextEncoder().encode("corrupted"),
    );
    const result = await importHistoryPackages({
      privateRootDirectory: root,
      packageDirectory,
      outputDirectory,
      dependencies: importDependencies(primary, join(root, "storage")),
    });
    expect(result.failedCount).toBe(1);
    // 完成标记应不存在（旧批次标记已移除，新批次未完成不写标记）。
    await expect(readFile(join(outputDirectory, "IMPORT_COMPLETE"), "utf8")).rejects.toBeDefined();
    // 清单仍更新为当前批次（含已导入的条目）。
    const manifest = JSON.parse(
      await readFile(join(outputDirectory, "import-manifest.private.json"), "utf8"),
    );
expect(manifest.batchSha256).toBeDefined();
    expect(manifest.importedCount).toBe(1);
  });
});

describePostgres("导入任务认领与租约围栏", () => {
  let primary: PostgresDatabaseHandle | undefined;
  let store: DatabaseProblemPackageJobStore | undefined;

  beforeAll(async () => {
    if (adminUrl === undefined) return;
    const databaseName = `urmotiv_history_import_claim_${process.pid}_${randomUUID()
      .replaceAll("-", "")
      .slice(0, 12)}`;
    temporaryDatabaseNames.push(databaseName);
    await prepareHistoryImportDatabase(adminUrl, databaseName);
    primary = createPostgresDatabase({
      connectionString: historyImportDatabaseConnectionString(adminUrl, databaseName),
      maxConnections: 8,
      applicationName: "urmotiv-history-claim-test",
    });
    store = new DatabaseProblemPackageJobStore(primary);
  });

  afterAll(async () => {
    await primary?.close();
    if (adminUrl === undefined) return;
    for (const databaseName of temporaryDatabaseNames.splice(0)) {
      await dropHistoryImportDatabase(adminUrl, databaseName);
    }
  });

  /**
   * 通过完整导入流程产出一个 succeeded 任务，用于测试 reconstruct 路径。
   */
  async function seedSucceededJob(): Promise<ProblemPackageImportJob> {
    if (primary === undefined || store === undefined) throw new Error("测试数据库未建立。");
    const root = await createPrivateRoot();
    const packageDirectory = join(root, "package-output");
    const outputDirectory = join(root, "import-output");
    await mkdir(join(packageDirectory, "packages"), { mode: 0o700, recursive: true });
    const packaged = await createSyntheticPackage(packageDirectory, "candidate-000001");
    await writePackageReport(packageDirectory, [packaged]);
    await importHistoryPackages({
      privateRootDirectory: root,
      packageDirectory,
      outputDirectory,
      dependencies: importDependencies(primary, join(root, "storage")),
    });
    const rows = await primary.query<{ id: string }>(sql`
      SELECT id::text AS id FROM import_jobs LIMIT 1
    `);
    const id = String(rows[0]!.id);
    const job = await store.getImportJob(id);
    if (job === undefined) throw new Error("任务不存在。");
    return job;
  }

  /**
   * 直接构造一个 queued 任务（不走完整导入）。先插入 stored_files 行，
   * 因为 DB createImportJob 会校验 sourceFileId 存在且 sha256 匹配。
   */
  async function seedQueuedJob(digest: string): Promise<ProblemPackageImportJob> {
    if (primary === undefined || store === undefined) throw new Error("测试数据库未建立。");
    const sourceFileId = randomUUID();
    await primary.execute(sql`
      INSERT INTO stored_files (id, purpose, storage_key, original_name, media_type, byte_size, sha256, created_by_user_id)
      VALUES (
        ${sourceFileId}::uuid, 'import_input',
        ${`objects/${sourceFileId}`}, 'synthetic.zip', 'application/zip',
        1, ${digest},
        ${databaseDemoUserIds.leader}::bigint
      )
    `);
    return store.createImportJob({
      requestedByUserId: databaseDemoUserIds.leader,
      clientRequestDigest: digest,
      sourceFileId,
      inputDigest: digest,
      selectedFormat: urmotivNativeAdapter.id,
      selectedFormatVersion: urmotivNativeAdapter.version,
      choices: { conflictAction: "create" },
      itemCount: 1,
      idempotencyKey: digest,
      auditRequestId: randomUUID(),
    });
  }

  it("succeeded 任务重放重建：不重写，返回 reconstruct", async () => {
    if (store === undefined) throw new Error("store 未建立。");
    const job = await seedSucceededJob();
    expect(job.state).toBe("succeeded");
    const claim = await store.claimOrRecoverImportJob({ jobId: job.id, leaseDurationMs: 60_000 });
    expect(claim?.kind).toBe("reconstruct");
    if (claim?.kind === "reconstruct") {
      expect(claim.job.id).toBe(job.id);
      expect(claim.items).toHaveLength(1);
      expect(claim.items[0]!.state).toBe("succeeded");
      expect(claim.items[0]!.importedProblemId).not.toBeNull();
    }
  });

  it("queued 任务认领为 running，带新租约", async () => {
    if (store === undefined) throw new Error("store 未建立。");
    const job = await seedQueuedJob(sha256Hex(randomUUID()));
    const claim = await store.claimOrRecoverImportJob({ jobId: job.id, leaseDurationMs: 60_000 });
    expect(claim?.kind).toBe("claimed");
    if (claim?.kind === "claimed") {
      expect(claim.job.state).toBe("running");
      expect(claim.job.leaseId).toBe(claim.leaseId);
      expect(claim.job.leaseExpiresAt).not.toBeNull();
      expect(claim.job.executionAttempt).toBe(0);
    }
  });

  it("running + 活跃租约 → busy，不修改任务", async () => {
    if (store === undefined) throw new Error("store 未建立。");
    const job = await seedQueuedJob(sha256Hex(randomUUID()));
    const first = await store.claimOrRecoverImportJob({ jobId: job.id, leaseDurationMs: 60_000 });
    expect(first?.kind).toBe("claimed");
    const second = await store.claimOrRecoverImportJob({ jobId: job.id, leaseDurationMs: 60_000 });
    expect(second?.kind).toBe("busy");
    const after = await store.getImportJob(job.id);
    expect(after?.state).toBe("running");
    expect(after?.leaseId).toBe(first?.kind === "claimed" ? first.leaseId : null);
  });

  it("running + 过期租约被收回，attempt 递增、换新租约", async () => {
    if (store === undefined) throw new Error("store 未建立。");
    const job = await seedQueuedJob(sha256Hex(randomUUID()));
    const first = await store.claimOrRecoverImportJob({ jobId: job.id, leaseDurationMs: -1 });
    expect(first?.kind).toBe("claimed");
    const second = await store.claimOrRecoverImportJob({ jobId: job.id, leaseDurationMs: 60_000 });
    expect(second?.kind).toBe("claimed");
    if (second?.kind === "claimed") {
      expect(second.job.executionAttempt).toBe(1);
      expect(second.leaseId).not.toBe(first?.kind === "claimed" ? first.leaseId : undefined);
    }
  });

  it("failed 任务（无提交条目）安全重置认领", async () => {
    if (store === undefined) throw new Error("store 未建立。");
    const job = await seedQueuedJob(sha256Hex(randomUUID()));
    await store.startImportJob(job.id);
    await store.failImportJob(job.id, "import_access_revoked", {
      version: 1,
      phase: "failed",
      completedItems: 0,
      failedItems: 1,
      skippedItems: 0,
    });
    const failed = await store.getImportJob(job.id);
    expect(failed?.state).toBe("failed");
    const claim = await store.claimOrRecoverImportJob({ jobId: job.id, leaseDurationMs: 60_000 });
    expect(claim?.kind).toBe("claimed");
    if (claim?.kind === "claimed") {
      expect(claim.job.state).toBe("running");
      expect(claim.job.failure).toBeNull();
      expect(claim.job.executionAttempt).toBe(1);
    }
  });

  it("renewImportJobLease 只有持约者能续约（围栏）", async () => {
    if (store === undefined) throw new Error("store 未建立。");
    const job = await seedQueuedJob(sha256Hex(randomUUID()));
    const claim = await store.claimOrRecoverImportJob({ jobId: job.id, leaseDurationMs: 60_000 });
    if (claim?.kind !== "claimed") throw new Error("认领失败。");
    // 错误租约（围栏）被拒绝。
    expect(
      await store.renewImportJobLease({ jobId: job.id, leaseId: randomUUID(), leaseDurationMs: 60_000 }),
    ).toBe(false);
    // 正确租约成功续约。
    expect(
      await store.renewImportJobLease({ jobId: job.id, leaseId: claim.leaseId, leaseDurationMs: 60_000 }),
    ).toBe(true);
  });
});

describePostgres("导入故障注入与恢复收敛", () => {
  let primary: PostgresDatabaseHandle | undefined;

  beforeAll(async () => {
    if (adminUrl === undefined) return;
    const databaseName = `urmotiv_history_import_fault_${process.pid}_${randomUUID()
      .replaceAll("-", "")
      .slice(0, 12)}`;
    temporaryDatabaseNames.push(databaseName);
    await prepareHistoryImportDatabase(adminUrl, databaseName);
    primary = createPostgresDatabase({
      connectionString: historyImportDatabaseConnectionString(adminUrl, databaseName),
      maxConnections: 8,
      applicationName: "urmotiv-history-fault-test",
    });
  });

  afterAll(async () => {
    await primary?.close();
    if (adminUrl === undefined) return;
    for (const databaseName of temporaryDatabaseNames.splice(0)) {
      await dropHistoryImportDatabase(adminUrl, databaseName);
    }
  });

  afterEach(async () => {
    await Promise.all(
      temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
    );
  });

  async function setupPackage(candidateId: string): Promise<{
    root: string;
    packageDirectory: string;
    outputDirectory: string;
    packaged: { candidateId: string; contentSha256: string; packageSha256: string; packageBytes: number };
  }> {
    const root = await createPrivateRoot();
    const packageDirectory = join(root, "package-output");
    const outputDirectory = join(root, "import-output");
    await mkdir(join(packageDirectory, "packages"), { mode: 0o700, recursive: true });
    const packaged = await createSyntheticPackage(packageDirectory, candidateId);
    await writePackageReport(packageDirectory, [packaged]);
    return { root, packageDirectory, outputDirectory, packaged };
  }

  // ── (1) 五个故障点注入 ──

  it("故障点1：stored_files 写入成功但响应丢失 → 即时回读收敛，持久化身份完整链接", async () => {
    if (primary === undefined) throw new Error("未建立测试数据库。");
    const { root, packageDirectory, outputDirectory, packaged } = await setupPackage("candidate-000001");
    const storageRoot = join(root, "storage");
    const baseStore = new ProblemFileStore(primary);
    const faultFileStore = new FaultInjectingProblemFileStore(baseStore);
    faultFileStore.injectCreateStoredFileResponseLossOnce(new Error("simulated createStoredFile response loss"));
    // 委托成功后抛出（响应丢失）：生产代码即时回读已提交行、逐字段验证、继续。
    const result = await importHistoryPackages({
      privateRootDirectory: root,
      packageDirectory,
      outputDirectory,
      dependencies: {
        ...importDependencies(primary, storageRoot),
        store: faultFileStore,
      },
    });
    expect(result.importedCount).toBe(1);
    expect(result.failedCount).toBe(0);

    // ── 精确验证持久化身份链接 ──
    // stored_files：单行，sha256/byteSize/purpose 与原始包一致。
    const fileRows = await primary.query<{
      id: string; sha256: string; byte_size: number; purpose: string; storage_key: string; original_name: string; media_type: string; created_by_user_id: string;
    }>(sql`
      SELECT id::text, sha256, byte_size, purpose, storage_key, original_name, media_type, created_by_user_id::text
      FROM stored_files WHERE deleted_at IS NULL
    `);
    expect(fileRows.length).toBe(1);
    const fileRow = fileRows[0]!;
    expect(fileRow.sha256).toBe(packaged.packageSha256);
    expect(Number(fileRow.byte_size)).toBe(packaged.packageBytes);
    expect(fileRow.purpose).toBe("import_input");
    const sourceFileId = fileRow.id;

    // 物理存储对象存在（storage_key 以 objects/UUID 开头）。
    expect(fileRow.storage_key).toMatch(/^objects\/[0-9a-f-]{36}$/u);
    const storageUuid = fileRow.storage_key.replace("objects/", "");
    expect(fileRow.id).toBe(storageUuid);

    // import_jobs：单行，sourceFileId 链接 stored_files，inputDigest=packageSha256。
    const jobRows = await primary.query<{
      id: string; source_file_id: string; input_digest: string; selected_format: string; state: string; idempotency_key: string; requested_by_user_id: string;
    }>(sql`
      SELECT id::text, source_file_id::text, input_digest, selected_format, state::text, idempotency_key, requested_by_user_id::text
      FROM import_jobs
    `);
    expect(jobRows.length).toBe(1);
    const jobRow = jobRows[0]!;
    expect(jobRow.source_file_id).toBe(sourceFileId);
    expect(jobRow.input_digest).toBe(packaged.packageSha256);
    expect(jobRow.idempotency_key).toBe(packaged.packageSha256);
    expect(jobRow.state).toBe("succeeded");
    const jobId = jobRow.id;

    // import_job_items：单行，jobId 链接 import_jobs，position=0，importedProblemId 非空。
    const itemRows = await primary.query<{
      job_id: string; position: number; imported_problem_id: string | null;
    }>(sql`
      SELECT job_id::text, position, imported_problem_id::text FROM import_job_items
    `);
    expect(itemRows.length).toBe(1);
    const itemRow = itemRows[0]!;
    expect(itemRow.job_id).toBe(jobId);
    expect(itemRow.position).toBe(0);
    expect(itemRow.imported_problem_id).not.toBeNull();
    const problemId = itemRow.imported_problem_id!;

    // problems：单行，id 链接 import_job_items.importedProblemId。
    const problemRows = await primary.query<{ id: string }>(sql`
      SELECT id::text FROM problems
    `);
    expect(problemRows.length).toBe(1);
    expect(problemRows[0]!.id).toBe(problemId);

    // audit_events：import.create 事件链接 import_jobs.id，request_id 非空。
    const auditRows = await primary.query<{ request_id: string; object_id: string }>(sql`
      SELECT request_id::text, object_id::text FROM audit_events
      WHERE action = 'problem.package.import.create'
    `);
    expect(auditRows.length).toBe(1);
    expect(auditRows[0]!.object_id).toBe(jobId);
    expect(auditRows[0]!.request_id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u);

    // 无重复/删除：count 断言。
    expect(await countStoredFiles(primary)).toBe(1);
    expect(await countImportJobs(primary)).toBe(1);
    expect(await countProblems(primary)).toBe(1);
  });

  it("故障点2：存储发布失败 → 丢弃 staged 对象，重跑成功", async () => {
    if (primary === undefined) throw new Error("未建立测试数据库。");
    const { root, packageDirectory, outputDirectory } = await setupPackage("candidate-000002");
    const storageRoot = join(root, "storage");
    const baseStorage = new LocalFileStorage({ rootDirectory: storageRoot, limits: { maxBytes: 256 * 1024 * 1024 } });
    const faultStorage = new FaultInjectingStorage(baseStorage);
    faultStorage.injectOnce("publish", new Error("simulated publish failure"));
    const firstResult = await importHistoryPackages({
      privateRootDirectory: root,
      packageDirectory,
      outputDirectory,
      dependencies: {
        ...importDependencies(primary, storageRoot),
        storage: faultStorage,
      },
    });
    expect(firstResult.failedCount).toBe(1);
    // Retry without fault: should succeed
    const result = await importHistoryPackages({
      privateRootDirectory: root,
      packageDirectory,
      outputDirectory: join(root, "import-output-2"),
      dependencies: importDependencies(primary, storageRoot),
    });
    expect(result.importedCount).toBe(1);
  });

  it("故障点3：清单发布失败 → 抛出异常，重跑成功（清单幂等覆盖）", async () => {
    if (primary === undefined) throw new Error("未建立测试数据库。");
    const { root, packageDirectory, outputDirectory } = await setupPackage("candidate-000003");
    const storageRoot = join(root, "storage");
    const faultPublisher = new FaultInjectingPublisher({
      writeManifest: async (p, d) => writeFile(p, d, { mode: 0o600 }),
      writeComplete: async (p, d) => writeFile(p, d, { mode: 0o600 }),
      removeComplete: async (p) => rm(p, { force: true }).catch(() => undefined),
    });
    faultPublisher.injectOnce("writeManifest", new Error("simulated manifest write failure"));
    await expect(
      importHistoryPackages({
        privateRootDirectory: root,
        packageDirectory,
        outputDirectory,
        dependencies: {
          ...importDependencies(primary, storageRoot),
          publisher: faultPublisher,
        },
      }),
    ).rejects.toBeDefined();
    // Verify problem was still imported despite manifest failure
    expect(await countProblems(primary)).toBeGreaterThanOrEqual(1);
    // Retry: manifest write succeeds. Package was already imported (reconstruct path),
    // so it counts as imported this run (not skipped, since no manifest existed).
    const result = await importHistoryPackages({
      privateRootDirectory: root,
      packageDirectory,
      outputDirectory,
      dependencies: importDependencies(primary, storageRoot),
    });
    expect(result.importedCount).toBe(1);
    expect(result.skippedCount).toBe(0);
  });

  it("故障点4：完成标记发布失败 → 抛出异常，重跑发布标记", async () => {
    if (primary === undefined) throw new Error("未建立测试数据库。");
    const { root, packageDirectory, outputDirectory } = await setupPackage("candidate-000004");
    const storageRoot = join(root, "storage");
    const faultPublisher = new FaultInjectingPublisher({
      writeManifest: async (p, d) => writeFile(p, d, { mode: 0o600 }),
      writeComplete: async (p, d) => writeFile(p, d, { mode: 0o600 }),
      removeComplete: async (p) => rm(p, { force: true }).catch(() => undefined),
    });
    faultPublisher.injectOnce("writeComplete", new Error("simulated complete marker failure"));
    await expect(
      importHistoryPackages({
        privateRootDirectory: root,
        packageDirectory,
        outputDirectory,
        dependencies: {
          ...importDependencies(primary, storageRoot),
          publisher: faultPublisher,
        },
      }),
    ).rejects.toBeDefined();
    // Retry: should succeed and write the complete marker
    const result = await importHistoryPackages({
      privateRootDirectory: root,
      packageDirectory,
      outputDirectory,
      dependencies: importDependencies(primary, storageRoot),
    });
    expect(result.skippedCount).toBe(1);
    await expect(readFile(join(outputDirectory, "IMPORT_COMPLETE"), "utf8")).resolves.toBeDefined();
  });

  it("故障点5：旧标记移除失败 → 抛出异常，重跑成功", async () => {
    if (primary === undefined) throw new Error("未建立测试数据库。");
    const { root, packageDirectory, outputDirectory } = await setupPackage("candidate-000005");
    const storageRoot = join(root, "storage");
    // First run: successful import to create a complete marker
    await importHistoryPackages({
      privateRootDirectory: root,
      packageDirectory,
      outputDirectory,
      dependencies: importDependencies(primary, storageRoot),
    });
    // Second run with a new batch where removeComplete fails
    const root2 = await createPrivateRoot();
    const packageDirectory2 = join(root2, "package-output");
    const outputDirectory2 = join(root2, "import-output");
    await mkdir(join(packageDirectory2, "packages"), { mode: 0o700, recursive: true });
    const packaged2 = await createSyntheticPackage(packageDirectory2, "candidate-000006");
    await writePackageReport(packageDirectory2, [packaged2]);
    const faultPublisher = new FaultInjectingPublisher({
      writeManifest: async (p, d) => writeFile(p, d, { mode: 0o600 }),
      writeComplete: async (p, d) => writeFile(p, d, { mode: 0o600 }),
      removeComplete: async (p) => rm(p, { force: true }).catch(() => undefined),
    });
    faultPublisher.injectOnce("removeComplete", new Error("simulated remove failure"));
    await expect(
      importHistoryPackages({
        privateRootDirectory: root2,
        packageDirectory: packageDirectory2,
        outputDirectory: outputDirectory2,
        dependencies: {
          ...importDependencies(primary, join(root2, "storage")),
          publisher: faultPublisher,
        },
      }),
    ).rejects.toBeDefined();
    // Retry without fault: should succeed
    const result = await importHistoryPackages({
      privateRootDirectory: root2,
      packageDirectory: packageDirectory2,
      outputDirectory: outputDirectory2,
      dependencies: importDependencies(primary, join(root2, "storage")),
    });
    expect(result.importedCount).toBe(1);
  });

  // ── (2) 并发/重复重试收敛 ──

  it("并发重复导入收敛：两次同时导入同一包，只产生一个题目", async () => {
    if (primary === undefined) throw new Error("未建立测试数据库。");
    const { root, packageDirectory, outputDirectory } = await setupPackage("candidate-000010");
    const storageRoot = join(root, "storage");
    const deps = importDependencies(primary, storageRoot);
    // Run two imports concurrently with different output dirs but same package
    const [result1, result2] = await Promise.all([
      importHistoryPackages({
        privateRootDirectory: root,
        packageDirectory,
        outputDirectory,
        dependencies: deps,
      }),
      importHistoryPackages({
        privateRootDirectory: root,
        packageDirectory,
        outputDirectory: join(root, "import-output-b"),
        dependencies: deps,
      }),
    ]);
    // At most one may fail (LEASE_BUSY when the other holds the lease).
    // At least one must succeed.
    expect(result1.failedCount + result2.failedCount).toBeLessThanOrEqual(1);
    expect(result1.importedCount + result2.importedCount).toBeGreaterThanOrEqual(1);
    // Exactly one problem should exist for this candidate.
    expect(await countProblemsByTitle(primary, "合成题目 candidate-000010")).toBe(1);
    // Exactly one import job should exist (idempotency key dedup).
    const jobCount = await primary.query<{ count: number }>(sql`
      SELECT count(*)::integer AS count FROM import_jobs
      WHERE input_digest = (
        SELECT input_digest FROM import_jobs
        WHERE source_file_id IN (
          SELECT id FROM stored_files WHERE original_name = 'candidate-000010.zip'
        ) LIMIT 1
      )
    `);
    expect(Number(jobCount[0]?.count ?? 0)).toBe(1);
  });

  it("源意图日志重放：写入完成前崩溃后重跑，复用既有 storage UUID 和 stored_files 行", async () => {
    if (primary === undefined) throw new Error("未建立测试数据库。");
    const { root, packageDirectory, outputDirectory } = await setupPackage("candidate-000011");
    const storageRoot = join(root, "storage");
    // Inject writer response-loss: writer commits the problem to DB,
    // but throws (simulating crash after commit, before complete marker).
    const baseDeps = importDependencies(primary, storageRoot);
    const defaultWriter = new DatabaseImportedProblemWriter({
      database: primary,
      store: new DatabaseDataStore(primary),
      metadata: new ProblemFileStore(primary),
      storage: new LocalFileStorage({ rootDirectory: storageRoot, limits: { maxBytes: 256 * 1024 * 1024 } }),
      audit: new DatabaseProblemPackageAuditWriter(primary),
    });
    const faultWriter = new FaultInjectingWriter(defaultWriter);
    faultWriter.injectWriteResponseLossOnce(new Error("simulated writer response loss"));
    // First run: writer commits problem to DB, then throws (response loss).
    // Import flow detects committed item and recovers success — first run succeeds.
    const firstResult = await importHistoryPackages({
      privateRootDirectory: root,
      packageDirectory,
      outputDirectory,
      dependencies: { ...baseDeps, writer: faultWriter },
    });
    expect(firstResult.importedCount).toBe(1);
    expect(firstResult.failedCount).toBe(0);
    // Read the source-intent journal — it should exist from the first run
    const journalPath = join(outputDirectory, "journal", "candidate-000011.private.json");
    const journal = (await readPrivateJson(journalPath)) as { storageUuid: string };
    expect(journal.storageUuid).toBeDefined();
    const uuidFromJournal = journal.storageUuid;
    // The stored_files row should already exist (created before writer)
    const rowsBefore = await primary.query<{ id: string }>(sql`
      SELECT id::text AS id FROM stored_files WHERE id = ${uuidFromJournal}::uuid
    `);
    expect(rowsBefore.length).toBe(1);
    expect(rowsBefore[0]!.id).toBe(uuidFromJournal);
    // Retry without fault: should skip (first run already succeeded and wrote manifest entry)
    const result = await importHistoryPackages({
      privateRootDirectory: root,
      packageDirectory,
      outputDirectory,
      dependencies: importDependencies(primary, storageRoot),
    });
    expect(result.skippedCount).toBe(1);
    expect(result.importedCount).toBe(0);
    // After retry, the same UUID should still be in stored_files (no new row)
    const rowsAfter = await primary.query<{ id: string }>(sql`
      SELECT id::text AS id FROM stored_files WHERE id = ${uuidFromJournal}::uuid
    `);
    expect(rowsAfter.length).toBe(1);
    expect(rowsAfter[0]!.id).toBe(uuidFromJournal);
    // Exactly one problem
    expect(await countProblemsByTitle(primary, "合成题目 candidate-000011")).toBe(1);
  });

  it("过期租约围栏：stale token 不能完成或标记失败，job 状态不变", async () => {
    if (primary === undefined) throw new Error("未建立测试数据库。");
    const store = new DatabaseProblemPackageJobStore(primary);
    const { root, packageDirectory, outputDirectory } = await setupPackage("candidate-000012");
    const storageRoot = join(root, "storage");
    // First run: import succeeds, job is succeeded
    await importHistoryPackages({
      privateRootDirectory: root,
      packageDirectory,
      outputDirectory,
      dependencies: importDependencies(primary, storageRoot),
    });
    // Get the job
    const rows = await primary.query<{ id: string }>(sql`
      SELECT id::text AS id FROM import_jobs LIMIT 1
    `);
    const jobId = String(rows[0]!.id);
    // Try fenced complete with a stale token — should fail
    const completed = await store.fencedCompleteImportJob({
      jobId,
      leaseId: randomUUID(), // wrong token
      report: { version: 1, phase: "completed", completedItems: 1, failedItems: 0, skippedItems: 0 },
    });
    expect(completed).toBe(false);
    // Try fenced fail with a stale token — should fail
    const failed = await store.fencedFailImportJob({
      jobId,
      leaseId: randomUUID(), // wrong token
      position: 0,
      code: "internal_failure",
      report: { version: 1, phase: "failed", completedItems: 0, failedItems: 1, skippedItems: 0 },
    });
    // Job should still be succeeded
    const job = await store.getImportJob(jobId);
    expect(job?.state).toBe("succeeded");
  });

  it("stale token 写入围栏：写入器拒绝过期/错误租约的提交", async () => {
    if (primary === undefined) throw new Error("未建立测试数据库。");
    const store = new DatabaseProblemPackageJobStore(primary);
    const { root, packageDirectory, outputDirectory } = await setupPackage("candidate-000014");
    const storageRoot = join(root, "storage");
    // Import normally to create job + stored_files
    await importHistoryPackages({
      privateRootDirectory: root,
      packageDirectory,
      outputDirectory,
      dependencies: importDependencies(primary, storageRoot),
    });
    // Get the job and its original lease
    const jobRows = await primary.query<{ id: string; lease_id: string | null }>(sql`
      SELECT ij.id::text AS id, ij.lease_id::text AS lease_id
      FROM import_jobs ij
      JOIN stored_files sf ON sf.id = ij.source_file_id
      WHERE sf.original_name = 'candidate-000014.zip'
      LIMIT 1
    `);
    expect(jobRows.length).toBe(1);
    const jobId = jobRows[0]!.id;
    // The job is succeeded. Attempt fenced complete with wrong lease — should be rejected.
    const staleComplete = await store.fencedCompleteImportJob({
      jobId,
      leaseId: randomUUID(),
      report: { version: 1, phase: "completed", completedItems: 1, failedItems: 0, skippedItems: 0 },
    });
    expect(staleComplete).toBe(false);
    // Attempt fenced fail with wrong lease — should be rejected.
    const staleFail = await store.fencedFailImportJob({
      jobId,
      leaseId: randomUUID(),
      position: 0,
      code: "internal_failure",
      report: { version: 1, phase: "failed", completedItems: 0, failedItems: 1, skippedItems: 0 },
    });
    expect(staleFail).toBe(false);
    // Now test the writer's own lease fence directly.
    // Create a queued job, claim it, then call writer with a wrong lease.
    const digest = sha256Hex(randomUUID());
    const sourceFileId = randomUUID();
    await primary.execute(sql`
      INSERT INTO stored_files (id, purpose, storage_key, original_name, media_type, byte_size, sha256, created_by_user_id)
      VALUES (
        ${sourceFileId}::uuid, 'import_input',
        ${`objects/${sourceFileId}`}, 'synthetic.zip', 'application/zip',
        1, ${digest},
        ${databaseDemoUserIds.leader}::bigint
      )
    `);
    const queuedJob = await store.createImportJob({
      requestedByUserId: databaseDemoUserIds.leader,
      clientRequestDigest: digest,
      sourceFileId,
      inputDigest: digest,
      selectedFormat: urmotivNativeAdapter.id,
      selectedFormatVersion: urmotivNativeAdapter.version,
      choices: { conflictAction: "create" },
      itemCount: 1,
      idempotencyKey: digest,
      auditRequestId: randomUUID(),
    });
    const claim = await store.claimOrRecoverImportJob({ jobId: queuedJob.id, leaseDurationMs: 60_000 });
    if (claim?.kind !== "claimed") throw new Error(`Expected claimed, got ${claim?.kind}`);
    const writer = new DatabaseImportedProblemWriter({
      database: primary,
      store: new DatabaseDataStore(primary),
      metadata: new ProblemFileStore(primary),
      storage: new LocalFileStorage({ rootDirectory: join(root, "storage"), limits: { maxBytes: 256 * 1024 * 1024 } }),
      audit: new DatabaseProblemPackageAuditWriter(primary),
    });
    // Writer should reject a wrong leaseId — the FOR UPDATE lease check fails.
    await expect(
      writer.write({
        importJobId: queuedJob.id,
        position: 0,
        requestedByUserId: databaseDemoUserIds.leader,
        choices: { conflictAction: "create" },
        problem: {
          title: "stale-writer-fence-test",
          type: "traditional",
          tags: ["catalog.tag.01.01"],
          difficulty: {},
          content: { basicStatement: "test", basicSolution: "test", background: "", statement: "", inputFormat: "", outputFormat: "", constraints: "", solution: "", hints: "" },
          samples: [],
          files: [],
          extensions: {},
        },
        signal: new AbortController().signal,
        leaseId: randomUUID(), // wrong lease — writer must reject
      }),
    ).rejects.toBeDefined();
    // No extra problem should have been created
    expect(await countProblemsByTitle(primary, "stale-writer-fence-test")).toBe(0);
  });

  it("exactly-one：导入后恰有一个 problem/source/stored_files/job 和完整链接", async () => {
    if (primary === undefined) throw new Error("未建立测试数据库。");
    const { root, packageDirectory, outputDirectory } = await setupPackage("candidate-000013");
    const storageRoot = join(root, "storage");
    await importHistoryPackages({
      privateRootDirectory: root,
      packageDirectory,
      outputDirectory,
      dependencies: importDependencies(primary, storageRoot),
    });
    // Count only data from this test's import (previous tests share the DB)
    const title = "合成题目 candidate-000013";
    const fileCount = await primary.query<{ count: number }>(sql`
      SELECT count(*)::integer AS count FROM stored_files
      WHERE original_name = 'candidate-000013.zip'
    `);
    expect(Number(fileCount[0]?.count ?? 0)).toBe(1);
    expect(await countProblemsByTitle(primary, title)).toBe(1);
    // Verify linkage: problem → import_job_items → import_jobs
    const linkage = await primary.query<{
      problem_id: number;
      revision_id: string;
      job_id: string;
      imported_problem_id: number;
    }>(sql`
      SELECT
        pr.problem_id::int AS problem_id,
        pr.id::text AS revision_id,
        ij.id::text AS job_id,
        iji.imported_problem_id::int AS imported_problem_id
      FROM problem_revisions pr
      JOIN import_job_items iji ON iji.imported_problem_id = pr.problem_id
      JOIN import_jobs ij ON ij.id = iji.job_id
      WHERE pr.title = ${title}
      LIMIT 1
    `);
    expect(linkage.length).toBe(1);
    expect(linkage[0]!.imported_problem_id).toBe(linkage[0]!.problem_id);
    expect(linkage[0]!.job_id).toBeDefined();
    // Verify stored_files → import_jobs linkage (source file)
    const sourceLink = await primary.query<{ sf_id: string; ij_id: string }>(sql`
      SELECT sf.id::text AS sf_id, ij.id::text AS ij_id
      FROM stored_files sf
      JOIN import_jobs ij ON ij.source_file_id = sf.id
      WHERE sf.original_name = 'candidate-000013.zip'
      LIMIT 1
    `);
    expect(sourceLink.length).toBe(1);
    expect(sourceLink[0]!.sf_id).toBeDefined();
    // Verify physical source object exists in storage (not just DB metadata).
    const storageKey = await primary.query<{ storage_key: string }>(sql`
      SELECT storage_key FROM stored_files WHERE original_name = 'candidate-000013.zip' LIMIT 1
    `);
    const physicalPath = join(storageRoot, storageKey[0]!.storage_key);
    await expect(stat(physicalPath)).resolves.toBeDefined();
    // Verify exactly one import_job_items row for this job.
    const itemCount = await primary.query<{ count: number }>(sql`
      SELECT count(*)::integer AS count FROM import_job_items
      WHERE job_id = ${linkage[0]!.job_id}::uuid
    `);
    expect(Number(itemCount[0]?.count ?? 0)).toBe(1);
  });

  it("对抗：共享 v1 日志/.v2 sidecar，不兼容绑定 → 恰好一个获胜方，失败方 SOURCE_INTENT_MISMATCH 无覆盖", async () => {
    if (primary === undefined) throw new Error("未建立测试数据库。");
    const { root, packageDirectory, packaged } = await setupPackage("candidate-000099");
    const storageRoot = join(root, "storage");
    // 创建第二个拥有 problem.import 权限的测试用户（leader 角色）。
    // 两个竞争者都是真正授权的——失败只可能因日志绑定不匹配，不会因权限缺失。
    const secondLeaderId = "9000000000000010";
    await primary.execute(sql`
      INSERT INTO users (id, nickname, account_type)
      VALUES (${BigInt(secondLeaderId)}, '第二组长测试账号', 'human'::account_type)
      ON CONFLICT (id) DO NOTHING
    `);
    await primary.execute(sql`
      INSERT INTO role_memberships (id, user_id, role_id, granted_by_user_id, reason)
      SELECT
        ${randomUUID()}::uuid,
        ${BigInt(secondLeaderId)},
        role.id,
        0,
        '测试用第二组长'
      FROM roles role
      WHERE role.key = 'leader'
      ON CONFLICT DO NOTHING
    `);

    // 两个竞争者共享同一 output 目录 → 同一 v1 日志路径 + 同一 .v2 sidecar 路径。
    // 使用不同 requestedByUserId → 不同 SourceIntentExpected → 不兼容的 v2 载荷。
    // O_EXCL sidecar 选出唯一获胜方；失败方回读获胜方 sidecar 时因 requester 不匹配
    // 抛出 SOURCE_INTENT_MISMATCH，绝不覆盖。
    const sharedOutput = join(root, "import-shared");
    const journalDir = join(sharedOutput, "journal");
    await mkdir(journalDir, { mode: 0o700, recursive: true });
    const v1Uuid = randomUUID();
    const v1Payload = {
      version: 1,
      candidateId: "candidate-000099",
      packageSha256: packaged.packageSha256,
      packageBytes: packaged.packageBytes,
      storageUuid: v1Uuid,
      originalName: "candidate-000099.zip",
      mediaType: nativeProblemMediaType,
    };
    await writeFile(join(journalDir, "candidate-000099.private.json"), JSON.stringify(v1Payload, null, 2) + "\n", { mode: 0o600 });

    // 并发运行两个导入——不同 requester（均授权），共享 output/DB/存储。Promise.allSettled 真正重叠。
    const [settledA, settledB] = await Promise.allSettled([
      importHistoryPackages({
        privateRootDirectory: root,
        packageDirectory,
        outputDirectory: sharedOutput,
        dependencies: { ...importDependencies(primary, storageRoot), requestedByUserId: databaseDemoUserIds.leader },
      }),
      importHistoryPackages({
        privateRootDirectory: root,
        packageDirectory,
        outputDirectory: sharedOutput,
        dependencies: { ...importDependencies(primary, storageRoot), requestedByUserId: secondLeaderId },
      }),
    ]);
    expect(settledA.status).toBe("fulfilled");
    expect(settledB.status).toBe("fulfilled");
    const resultA = settledA.status === "fulfilled" ? settledA.value : null;
    const resultB = settledB.status === "fulfilled" ? settledB.value : null;
    expect(resultA).not.toBeNull();
    expect(resultB).not.toBeNull();
    // 恰好一个成功导入（获胜方），失败方 importedCount=0/failedCount=1。
    expect(resultA!.importedCount + resultB!.importedCount).toBe(1);
    const winnerIsA = resultA!.importedCount === 1;
    const winnerResult = winnerIsA ? resultA! : resultB!;
    const loserResult = winnerIsA ? resultB! : resultA!;
    expect(loserResult.importedCount).toBe(0);
    expect(loserResult.failedCount).toBe(1);
    expect(loserResult.failedCandidateIds).toContain("candidate-000099");
    // 失败方的稳定消毒码必须是 SOURCE_INTENT_MISMATCH（不是权限错误）。
    expect(loserResult.failedCandidates).toEqual([
      { candidateId: "candidate-000099", code: "SOURCE_INTENT_MISMATCH" },
    ]);
    // 获胜方无失败。
    expect(winnerResult.failedCount).toBe(0);

    // 恰好一个 .v2 sidecar 持久化载荷（共享路径，O_EXCL 选出一个写入者）。
    const sidecarPath = join(sharedOutput, "journal", "candidate-000099.private.json.v2");
    const sidecar = JSON.parse(await readFile(sidecarPath, "utf8"));
    // ── 完整 v2 载荷绑定断言 ──
    const winnerUserId = winnerIsA ? databaseDemoUserIds.leader : secondLeaderId;
    expect(sidecar.version).toBe(2);
    expect(sidecar.candidateId).toBe("candidate-000099");
    expect(sidecar.packageSha256).toBe(packaged.packageSha256);
    expect(sidecar.packageBytes).toBe(packaged.packageBytes);
    // 保留 v1 UUID。
    expect(sidecar.storageUuid).toBe(v1Uuid);
    expect(sidecar.expectedStorageKey).toBe(`objects/${v1Uuid}`);
    expect(sidecar.originalName).toBe("candidate-000099.zip");
    expect(sidecar.mediaType).toBe(nativeProblemMediaType);
    expect(sidecar.purpose).toBe("import_input");
    // 获胜方的完整身份绑定：requester。
    expect(sidecar.requestedByUserId).toBe(winnerUserId);
    // 所有摘要。
    expect(sidecar.idempotencyKey).toBe(packaged.packageSha256);
    expect(sidecar.clientRequestDigest).toBe(packaged.packageSha256);
    expect(sidecar.inputDigest).toBe(packaged.packageSha256);
    // format/version。
    expect(sidecar.selectedFormat).toBe(urmotivNativeAdapter.id);
    expect(sidecar.selectedFormatVersion).toBe(urmotivNativeAdapter.version);
    // choicesDigest 非空且为 SHA-256 格式。
    expect(sidecar.choicesDigest).toMatch(/^[0-9a-f]{64}$/u);
    // itemCount/position。
    expect(sidecar.itemCount).toBe(1);
    expect(sidecar.position).toBe(0);
    // auditRequestId：UUID v5 格式。
    expect(sidecar.auditRequestId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u);
    expect(sidecar.phase).toBe("intent_confirmed");
    expect(sidecar.jobId).toBeNull();
    expect(sidecar.problemId).toBeNull();

    // 恰好一个 stored_files 行（获胜方的确定性 UUID）。
    expect(await countStoredFiles(primary, packaged.packageSha256)).toBe(1);
    // 恰好一个 import job。
    const jobCount = await primary.query<{ count: number }>(sql`
      SELECT count(*)::integer AS count FROM import_jobs WHERE idempotency_key = ${packaged.packageSha256}
    `);
    expect(Number(jobCount[0]?.count ?? 0)).toBe(1);
    // 恰好一个 problem。
    expect(await countProblemsByTitle(primary, "合成题目 candidate-000099")).toBe(1);

    // 失败方未覆盖获胜方 sidecar：sidecar 中的 requester 仍为获胜方。
    const loserUserId = winnerIsA ? secondLeaderId : databaseDemoUserIds.leader;
    expect(sidecar.requestedByUserId).not.toBe(loserUserId);
  });

  it("对抗：真正重叠 Promise.allSettled 同操作 → 恰好一个物理对象/行/链接，无残留 staging", async () => {
    if (primary === undefined) throw new Error("未建立测试数据库。");
    const { root, packageDirectory, packaged } = await setupPackage("candidate-000097");
    const storageRoot = join(root, "storage");
    // 真正重叠：Promise.allSettled 并发，不同 output 目录，同一 DB+存储。
    // 确定性 UUID 确保两个竞争者收敛至同一 objects/<id> 路径——单一物理对象。
    // 所有权安全 staging 确保每个竞争者只删除自己的 staging 文件。
    const [settledA, settledB] = await Promise.allSettled([
      importHistoryPackages({ privateRootDirectory: root, packageDirectory, outputDirectory: join(root, "import-a"), dependencies: importDependencies(primary, storageRoot) }),
      importHistoryPackages({ privateRootDirectory: root, packageDirectory, outputDirectory: join(root, "import-b"), dependencies: importDependencies(primary, storageRoot) }),
    ]);
    expect(settledA.status).toBe("fulfilled");
    expect(settledB.status).toBe("fulfilled");
    const resultA = settledA.status === "fulfilled" ? settledA.value : null;
    const resultB = settledB.status === "fulfilled" ? settledB.value : null;
    expect(resultA).not.toBeNull();
    expect(resultB).not.toBeNull();
    // 至少一个成功导入（幂等键去重）。
    expect(resultA!.importedCount + resultB!.importedCount).toBeGreaterThanOrEqual(1);
    // 物理对象恰好 1：objects 目录下只有一个文件。
    const objectFiles = await readdir(join(storageRoot, "objects"));
    expect(objectFiles.length).toBe(1);
    // 无残留 staging .part 文件：遍历 staging 目录下所有子目录，应为空。
    const stagingEntries = await readdir(join(storageRoot, "staging"), { withFileTypes: true });
    for (const entry of stagingEntries) {
      if (entry.isDirectory()) {
        const subEntries = await readdir(join(storageRoot, "staging", entry.name));
        expect(subEntries.length).toBe(0);
      }
    }
    // stored_files 行恰好 1（同一确定性 UUID）。
    expect(await countStoredFiles(primary, packaged.packageSha256)).toBe(1);
    // import job 恰好 1。
    const jobCount = await primary.query<{ count: number }>(sql`
      SELECT count(*)::integer AS count FROM import_jobs WHERE idempotency_key = ${packaged.packageSha256}
    `);
    expect(Number(jobCount[0]?.count ?? 0)).toBe(1);
    // import_job_items 恰好 1。
    const itemCount = await primary.query<{ count: number }>(sql`
      SELECT count(*)::integer AS count FROM import_job_items iji
      JOIN import_jobs ij ON iji.job_id = ij.id
      WHERE ij.idempotency_key = ${packaged.packageSha256}
    `);
    expect(Number(itemCount[0]?.count ?? 0)).toBe(1);
    // problem 恰好 1。
    expect(await countProblemsByTitle(primary, "合成题目 candidate-000097")).toBe(1);
    // 完整链接：stored_files → import_jobs → import_job_items → problems。
    const linkage = await primary.query<{ storage_key: string; job_id: string; imported_problem_id: number }>(sql`
      SELECT sf.storage_key, ij.id::text AS job_id, iji.imported_problem_id::int AS imported_problem_id
      FROM stored_files sf
      JOIN import_jobs ij ON ij.source_file_id = sf.id
      JOIN import_job_items iji ON iji.job_id = ij.id
      WHERE sf.sha256 = ${packaged.packageSha256}
    `);
    expect(linkage.length).toBe(1);
    expect(linkage[0]!.storage_key).toMatch(/^objects\//u);
    expect(linkage[0]!.imported_problem_id).toBeGreaterThan(0);
    // audit_events 链接恰好 1，确定性 UUID v5。
    const auditRows = await primary.query<{ request_id: string }>(sql`
      SELECT request_id::text FROM audit_events
      WHERE action = 'problem.package.import.create'
      AND object_id IN (SELECT id::text FROM import_jobs WHERE idempotency_key = ${packaged.packageSha256})
    `);
    expect(auditRows.length).toBe(1);
    expect(auditRows[0]!.request_id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u);
  });

  it("对抗：createImportJob 返回不匹配 + 发布前幂等命中 → fail-closed，零新物理对象/行", async () => {
    if (primary === undefined) throw new Error("未建立测试数据库。");
    const { root, packageDirectory, packaged } = await setupPackage("candidate-000098");
    const storageRoot = join(root, "storage");
    const realStore = new DatabaseProblemPackageJobStore(primary);
    // 篡改 createImportJob 返回值的 sourceFileId——立即验证必须 fail-closed。
    const tamperingStore = new (class extends FaultInjectingJobStore {
      public override async createImportJob(input: CreateProblemPackageImportJob): Promise<ProblemPackageImportJob> {
        const job = await super.createImportJob(input);
        return { ...job, sourceFileId: randomUUID() };
      }
    })(realStore);
    const result = await importHistoryPackages({
      privateRootDirectory: root,
      packageDirectory,
      outputDirectory: join(root, "import-create"),
      dependencies: { ...importDependencies(primary, storageRoot), jobStore: tamperingStore },
    });
    // createImportJob 返回不匹配 → fail-closed。
    expect(result.importedCount).toBe(0);
    expect(result.failedCandidateIds).toContain("candidate-000098");
    // 稳定消毒码：createImportJob 返回不匹配 → SOURCE_INTENT_MISMATCH。
    expect(result.failedCandidates).toEqual([
      { candidateId: "candidate-000098", code: "SOURCE_INTENT_MISMATCH" },
    ]);
    // 零新 problem 被导入。
    // ── 发布前幂等命中不匹配 → fail-closed BEFORE stage/publish，零新物理对象/行 ──
    // 第一次导入使用 v1 日志（随机 UUID），成功创建 job/stored_files/problem。
    // 第二次导入使用不同 output 目录（无 v1 日志）→ 确定性 UUID 与 v1 UUID 不同。
    // 发布前 findImportJobForReplay 找到第一次的 job，但 journal.storageUuid ≠ job.sourceFileId
    // → SOURCE_INTENT_MISMATCH → fail-closed，零新物理对象/零新存储行。
    const { root: root2, packageDirectory: pkg2, packaged: packaged2 } = await setupPackage("candidate-000096");
    const storageRoot2 = join(root2, "storage");
    // 第一次导入：预置 v1 日志（随机 UUID）。
    const outputFirst = join(root2, "import-v1");
    const journalDirFirst = join(outputFirst, "journal");
    await mkdir(journalDirFirst, { mode: 0o700, recursive: true });
    const v1Uuid2 = randomUUID();
    await writeFile(
      join(journalDirFirst, "candidate-000096.private.json"),
      JSON.stringify({
        version: 1,
        candidateId: "candidate-000096",
        packageSha256: packaged2.packageSha256,
        packageBytes: packaged2.packageBytes,
        storageUuid: v1Uuid2,
        originalName: "candidate-000096.zip",
        mediaType: nativeProblemMediaType,
      }, null, 2) + "\n",
      { mode: 0o600 },
    );
    const firstResult = await importHistoryPackages({
      privateRootDirectory: root2,
      packageDirectory: pkg2,
      outputDirectory: outputFirst,
      dependencies: importDependencies(primary, storageRoot2),
    });
    expect(firstResult.importedCount).toBe(1);
    // 第一次导入后：1 stored_files, 1 job, 1 problem。
    expect(await countStoredFiles(primary, packaged2.packageSha256)).toBe(1);
    const jobCountBefore = await primary.query<{ count: number }>(sql`
      SELECT count(*)::integer AS count FROM import_jobs WHERE idempotency_key = ${packaged2.packageSha256}
    `);
    expect(Number(jobCountBefore[0]?.count ?? 0)).toBe(1);

    // 第二次导入：不同 output 目录（无 v1 日志）→ 确定性 UUID ≠ v1 UUID。
    // 发布前幂等检查发现既有 job，但 sourceFileId 不匹配 → fail-closed。
    const objectsBefore = await readdir(join(storageRoot2, "objects"));
    const result2 = await importHistoryPackages({
      privateRootDirectory: root2,
      packageDirectory: pkg2,
      outputDirectory: join(root2, "import-det"),
      dependencies: importDependencies(primary, storageRoot2),
    });
    // fail-closed：零新导入。
    expect(result2.importedCount).toBe(0);
    expect(result2.failedCount).toBe(1);
    expect(result2.failedCandidateIds).toContain("candidate-000096");
    // 稳定消毒码：发布前幂等命中但 sourceFileId 不匹配 → SOURCE_INTENT_MISMATCH。
    expect(result2.failedCandidates).toEqual([
      { candidateId: "candidate-000096", code: "SOURCE_INTENT_MISMATCH" },
    ]);
    // 零新物理对象（objects 目录未增长）。
    const objectsAfter = await readdir(join(storageRoot2, "objects"));
    expect(objectsAfter.length).toBe(objectsBefore.length);
    // 零新 stored_files 行。
    expect(await countStoredFiles(primary, packaged2.packageSha256)).toBe(1);
    // 零新 import job。
    const jobCountAfter = await primary.query<{ count: number }>(sql`
      SELECT count(*)::integer AS count FROM import_jobs WHERE idempotency_key = ${packaged2.packageSha256}
    `);
    expect(Number(jobCountAfter[0]?.count ?? 0)).toBe(1);
    // problem 仍为 1（第一次导入的）。
    expect(await countProblemsByTitle(primary, "合成题目 candidate-000096")).toBe(1);
  });

  it("对抗：createImportJob 成功但回查信封缺失 → fail-closed SOURCE_INTENT_MISMATCH", async () => {
    if (primary === undefined) throw new Error("未建立测试数据库。");
    const { root, packageDirectory, packaged } = await setupPackage("candidate-000095");
    const storageRoot = join(root, "storage");
    const realStore = new DatabaseProblemPackageJobStore(primary);
    // createImportJob 成功后，成功路径的 findImportJobForReplay 返回 undefined。
    // 第一次 findImportJobForReplay（发布前检查）正常返回 undefined（无既有 job）。
    // 第二次 findImportJobForReplay（成功路径回查）返回 undefined → fail-closed。
    let replayCallCount = 0;
    const missingReplayStore = new (class extends FaultInjectingJobStore {
      public override async findImportJobForReplay(
        input: { requestedByUserId: string; idempotencyKey: string; clientRequestDigest: string },
      ): Promise<ImportJobReplayResult | undefined> {
        const result = await super.findImportJobForReplay(input);
        replayCallCount += 1;
        // 第一次调用（发布前检查）：正常返回（无既有 job → undefined）。
        // 第二次调用（成功路径回查）：模拟回查信封缺失 → undefined。
        if (replayCallCount === 2) return undefined;
        return result;
      }
    })(realStore);
    const result = await importHistoryPackages({
      privateRootDirectory: root,
      packageDirectory,
      outputDirectory: join(root, "import-missing-replay"),
      dependencies: { ...importDependencies(primary, storageRoot), jobStore: missingReplayStore },
    });
    // createImportJob 成功但回查信封缺失 → fail-closed。
    expect(result.importedCount).toBe(0);
    expect(result.failedCandidateIds).toContain("candidate-000095");
    // 稳定消毒码：回查信封缺失 → SOURCE_INTENT_MISMATCH。
    expect(result.failedCandidates).toEqual([
      { candidateId: "candidate-000095", code: "SOURCE_INTENT_MISMATCH" },
    ]);
    // 零新 problem 被导入。
    expect(await countProblemsByTitle(primary, "合成题目 candidate-000095")).toBe(0);
  });

  // ── (4) 各效果边界响应丢失：重放收敛、无重复效果 ──

  it("响应丢失：存储发布成功但响应丢失 → 候选失败但对象已持久化，重放收敛且对象唯一", async () => {
    if (primary === undefined) throw new Error("未建立测试数据库。");
    const { root, packageDirectory, outputDirectory, packaged } = await setupPackage("candidate-000111");
    const storageRoot = join(root, "storage");
    const baseStorage = new LocalFileStorage({ rootDirectory: storageRoot, limits: { maxBytes: 256 * 1024 * 1024 } });
    const faultStorage = new FaultInjectingStorage(baseStorage);
    faultStorage.injectResponseLossOnce("publish", new Error("simulated publish response loss"));
    // 首次运行：对象已发布（效果已发生）但响应丢失 → 候选失败。
    const first = await importHistoryPackages({
      privateRootDirectory: root,
      packageDirectory,
      outputDirectory,
      dependencies: { ...importDependencies(primary, storageRoot), storage: faultStorage },
    });
    expect(first.importedCount).toBe(0);
    expect(first.failedCount).toBe(1);
    const objectEntries = await readdir(join(storageRoot, "objects"));
    expect(objectEntries.length).toBe(1);
    // 源意图日志停留在 storage_publish_pending（效果未确认）。
    const journalPath = join(outputDirectory, "journal", "candidate-000111.private.json");
    const journalBefore = (await readPrivateJson(journalPath)) as { phase: string };
    expect(journalBefore.phase).toBe("storage_publish_pending");
    // 重放（无故障）：收敛为成功，且不产生重复对象/行/题目。
    const retry = await importHistoryPackages({
      privateRootDirectory: root,
      packageDirectory,
      outputDirectory,
      dependencies: importDependencies(primary, storageRoot),
    });
    expect(retry.importedCount).toBe(1);
    expect(retry.failedCount).toBe(0);
    expect((await readdir(join(storageRoot, "objects"))).length).toBe(1);
    expect(await countStoredFiles(primary, packaged.packageSha256)).toBe(1);
    expect(await countProblemsByTitle(primary, "合成题目 candidate-000111")).toBe(1);
    const journalAfter = (await readPrivateJson(journalPath)) as { phase: string; jobId: string | null; problemId: string | null };
    expect(journalAfter.phase).toBe("writer_commit_confirmed");
    expect(journalAfter.jobId).not.toBeNull();
    expect(journalAfter.problemId).not.toBeNull();
  });

  it("响应丢失：createImportJob 成功但响应丢失 → 即时回读收敛，日志持久化 jobId，重放跳过", async () => {
    if (primary === undefined) throw new Error("未建立测试数据库。");
    const { root, packageDirectory, outputDirectory, packaged } = await setupPackage("candidate-000112");
    const storageRoot = join(root, "storage");
    const baseStore = new DatabaseProblemPackageJobStore(primary);
    const faultJobStore = new FaultInjectingJobStore(baseStore);
    faultJobStore.injectResponseLossOnce("createImportJob", new Error("simulated createImportJob response loss"));
    // 首次运行：任务已创建（效果已发生）但响应丢失 → 生产代码回读已提交任务、逐字段验证、继续完成。
    const first = await importHistoryPackages({
      privateRootDirectory: root,
      packageDirectory,
      outputDirectory,
      dependencies: { ...importDependencies(primary, storageRoot), jobStore: faultJobStore },
    });
    expect(first.importedCount).toBe(1);
    expect(first.failedCount).toBe(0);
    // 恰好一个任务/对象/stored_files/题目。
    expect((await readdir(join(storageRoot, "objects"))).length).toBe(1);
    expect(await countStoredFiles(primary, packaged.packageSha256)).toBe(1);
    expect(await countProblemsByTitle(primary, "合成题目 candidate-000112")).toBe(1);
    const jobRows = await primary.query<{ count: number }>(sql`
      SELECT count(*)::integer AS count
      FROM import_jobs j
      JOIN import_job_items i ON i.job_id = j.id
      WHERE j.idempotency_key = ${packaged.packageSha256}
    `);
    expect(Number(jobRows[0]?.count ?? 0)).toBe(1);
    // 日志已推进到 writer_commit_confirmed，jobId 持久化且指向真实任务。
    const journalPath = join(outputDirectory, "journal", "candidate-000112.private.json");
    const journal = (await readPrivateJson(journalPath)) as { phase: string; jobId: string | null; problemId: string | null };
    expect(journal.phase).toBe("writer_commit_confirmed");
    expect(journal.jobId).not.toBeNull();
    expect(journal.problemId).not.toBeNull();
    const jobById = await baseStore.getImportJob(journal.jobId!);
    expect(jobById?.state).toBe("succeeded");
    // 重放（无故障）：清单已含条目 → 跳过，计数不变。
    const retry = await importHistoryPackages({
      privateRootDirectory: root,
      packageDirectory,
      outputDirectory,
      dependencies: importDependencies(primary, storageRoot),
    });
    expect(retry.skippedCount).toBe(1);
    expect(retry.importedCount).toBe(0);
    expect(await countStoredFiles(primary, packaged.packageSha256)).toBe(1);
    expect(await countProblemsByTitle(primary, "合成题目 candidate-000112")).toBe(1);
  });

  it("响应丢失：写入器提交成功但响应丢失 → 回读收敛，日志持久化并绑定 jobId/problemId，重放跳过", async () => {
    if (primary === undefined) throw new Error("未建立测试数据库。");
    const { root, packageDirectory, outputDirectory, packaged } = await setupPackage("candidate-000113");
    const storageRoot = join(root, "storage");
    const baseStore = new DatabaseProblemPackageJobStore(primary);
    const baseWriter = new DatabaseImportedProblemWriter({
      database: primary,
      store: new DatabaseDataStore(primary),
      metadata: new ProblemFileStore(primary),
      storage: new LocalFileStorage({ rootDirectory: storageRoot, limits: { maxBytes: 256 * 1024 * 1024 } }),
      audit: new DatabaseProblemPackageAuditWriter(primary),
    });
    const faultWriter = new FaultInjectingWriter(baseWriter);
    faultWriter.injectWriteResponseLossOnce(new Error("simulated writer response loss"));
    // 首次运行：题目已提交（效果已发生）但响应丢失 → 生产代码回读任务条目、围栏完成、返回成功。
    const first = await importHistoryPackages({
      privateRootDirectory: root,
      packageDirectory,
      outputDirectory,
      dependencies: { ...importDependencies(primary, storageRoot), jobStore: baseStore, writer: faultWriter },
    });
    expect(first.importedCount).toBe(1);
    expect(first.failedCount).toBe(0);
    // 日志达到 writer_commit_confirmed，jobId/problemId 持久化且与真实 DB 身份一致。
    const journalPath = join(outputDirectory, "journal", "candidate-000113.private.json");
    const journal = (await readPrivateJson(journalPath)) as { phase: string; jobId: string | null; problemId: string | null };
    expect(journal.phase).toBe("writer_commit_confirmed");
    expect(journal.jobId).not.toBeNull();
    expect(journal.problemId).not.toBeNull();
    const completedJob = await baseStore.getImportJob(journal.jobId!);
    expect(completedJob?.state).toBe("succeeded");
    const committedProblem = await readImportedProblem(primary);
    expect(committedProblem.title).toBe("合成题目 candidate-000113");
    expect(journal.problemId).toBe(String(committedProblem.problemId));
    const items = await baseStore.getImportItems(journal.jobId!);
    expect(items.length).toBe(1);
    expect(items[0]?.state).toBe("succeeded");
    expect(items[0]?.importedProblemId).toBe(journal.problemId);
    // 重放（无故障）：跳过，计数不变，日志身份不变。
    const retry = await importHistoryPackages({
      privateRootDirectory: root,
      packageDirectory,
      outputDirectory,
      dependencies: importDependencies(primary, storageRoot),
    });
    expect(retry.skippedCount).toBe(1);
    expect(retry.importedCount).toBe(0);
    expect(await countStoredFiles(primary, packaged.packageSha256)).toBe(1);
    expect(await countProblemsByTitle(primary, "合成题目 candidate-000113")).toBe(1);
    const journalAfterRetry = (await readPrivateJson(journalPath)) as { phase: string; jobId: string | null; problemId: string | null };
    expect(journalAfterRetry.phase).toBe("writer_commit_confirmed");
    expect(journalAfterRetry.jobId).toBe(journal.jobId);
    expect(journalAfterRetry.problemId).toBe(journal.problemId);
  });

  it("响应丢失：stored_files 持久化成功但响应丢失 → 即时回读收敛，日志持久化，重放跳过", async () => {
    if (primary === undefined) throw new Error("未建立测试数据库。");
    const { root, packageDirectory, outputDirectory, packaged } = await setupPackage("candidate-000118");
    const storageRoot = join(root, "storage");
    const baseStore = new ProblemFileStore(primary);
    const faultFileStore = new FaultInjectingProblemFileStore(baseStore);
    faultFileStore.injectCreateStoredFileResponseLossOnce(new Error("simulated createStoredFile response loss"));
    // 首次运行：stored_files 行已提交但响应丢失 → 生产代码即时回读、逐字段验证、继续完成。
    const first = await importHistoryPackages({
      privateRootDirectory: root,
      packageDirectory,
      outputDirectory,
      dependencies: { ...importDependencies(primary, storageRoot), store: faultFileStore },
    });
    expect(first.importedCount).toBe(1);
    expect(first.failedCount).toBe(0);
    // 恰好一个 stored_files 行/对象/任务/题目。
    const fileRows = await primary.query<{ count: number }>(sql`
      SELECT count(*)::integer AS count FROM stored_files
      WHERE deleted_at IS NULL AND sha256 = ${packaged.packageSha256}
    `);
    expect(Number(fileRows[0]?.count ?? 0)).toBe(1);
    expect((await readdir(join(storageRoot, "objects"))).length).toBe(1);
    expect(await countStoredFiles(primary, packaged.packageSha256)).toBe(1);
    expect(await countProblemsByTitle(primary, "合成题目 candidate-000118")).toBe(1);
    const journalPath = join(outputDirectory, "journal", "candidate-000118.private.json");
    const journal = (await readPrivateJson(journalPath)) as { phase: string; jobId: string | null; problemId: string | null };
    expect(journal.phase).toBe("writer_commit_confirmed");
    expect(journal.jobId).not.toBeNull();
    expect(journal.problemId).not.toBeNull();
    // 重放（无故障）：清单已含条目 → 跳过，计数不变。
    const retry = await importHistoryPackages({
      privateRootDirectory: root,
      packageDirectory,
      outputDirectory,
      dependencies: importDependencies(primary, storageRoot),
    });
    expect(retry.skippedCount).toBe(1);
    expect(retry.importedCount).toBe(0);
    expect(await countStoredFiles(primary, packaged.packageSha256)).toBe(1);
    expect(await countProblemsByTitle(primary, "合成题目 candidate-000118")).toBe(1);
  });

  it("响应丢失：清单发布成功但响应丢失 → 抛出异常但清单已持久化，重放收敛且不重写清单", async () => {
    if (primary === undefined) throw new Error("未建立测试数据库。");
    const { root, packageDirectory, outputDirectory, packaged } = await setupPackage("candidate-000114");
    const storageRoot = join(root, "storage");
    const manifestWrites: string[] = [];
    const completeWrites: string[] = [];
    const countingPublisher: HistoryImportPublisher = {
      writeManifest: async (manifestPath: string, payload: string) => {
        manifestWrites.push(payload);
        await writeFile(manifestPath, payload, { mode: 0o600 });
      },
      writeComplete: async (completePath: string, payload: string) => {
        completeWrites.push(payload);
        await writeFile(completePath, payload, { mode: 0o600 });
      },
      removeComplete: async (completePath: string) => {
        await rm(completePath, { force: true });
      },
    };
    const faultPublisher = new FaultInjectingPublisher(countingPublisher);
    faultPublisher.injectResponseLossOnce("writeManifest", new Error("simulated writeManifest response loss"));
    // 首次运行：清单已写入（效果已发生）但响应丢失 → 批次发布抛出。
    await expect(
      importHistoryPackages({
        privateRootDirectory: root,
        packageDirectory,
        outputDirectory,
        dependencies: { ...importDependencies(primary, storageRoot), publisher: faultPublisher },
      }),
    ).rejects.toBeDefined();
    // 题目已导入；清单已持久化。
    expect(await countProblemsByTitle(primary, "合成题目 candidate-000114")).toBe(1);
    const manifestPath = join(outputDirectory, "import-manifest.private.json");
    expect((await stat(manifestPath)).isFile()).toBe(true);
    // 重放（无故障）：清单已含条目 → 跳过；发布日志推进到 complete_publish_confirmed。
    const retry = await importHistoryPackages({
      privateRootDirectory: root,
      packageDirectory,
      outputDirectory,
      dependencies: importDependencies(primary, storageRoot),
    });
    expect(retry.skippedCount).toBe(1);
    expect(retry.importedCount).toBe(0);
    expect(await countProblemsByTitle(primary, "合成题目 candidate-000114")).toBe(1);
    const completePath = join(outputDirectory, "IMPORT_COMPLETE");
    expect((await stat(completePath)).isFile()).toBe(true);
    // 批次发布日志：身份绑定 batchSha256，摘要绑定实际发布内容，阶段完成。
    const batchJournal = (await readPrivateJson(join(outputDirectory, "batch-publication.private.json"))) as {
      version: number;
      batchSha256: string;
      manifestPayloadDigest: string;
      completePayloadDigest: string;
      phase: string;
    };
    expect(batchJournal.version).toBe(1);
    expect(batchJournal.batchSha256).toBe(sha256Hex(JSON.stringify([packaged.packageSha256])));
    expect(batchJournal.phase).toBe("complete_publish_confirmed");
    expect(batchJournal.manifestPayloadDigest).toBe(sha256Hex(await readFile(manifestPath)));
    expect(batchJournal.completePayloadDigest).toBe(sha256Hex(await readFile(completePath)));
  });

  it("响应丢失：完成标记发布成功但响应丢失 → 抛出异常，重放跳过且清单只写一次", async () => {
    if (primary === undefined) throw new Error("未建立测试数据库。");
    const { root, packageDirectory, outputDirectory, packaged } = await setupPackage("candidate-000115");
    const storageRoot = join(root, "storage");
    const manifestWrites: string[] = [];
    const completeWrites: string[] = [];
    const countingPublisher: HistoryImportPublisher = {
      writeManifest: async (manifestPath: string, payload: string) => {
        manifestWrites.push(payload);
        await writeFile(manifestPath, payload, { mode: 0o600 });
      },
      writeComplete: async (completePath: string, payload: string) => {
        completeWrites.push(payload);
        await writeFile(completePath, payload, { mode: 0o600 });
      },
      removeComplete: async (completePath: string) => {
        await rm(completePath, { force: true });
      },
    };
    const faultPublisher = new FaultInjectingPublisher(countingPublisher);
    faultPublisher.injectResponseLossOnce("writeComplete", new Error("simulated writeComplete response loss"));
    // 首次运行：完成标记已写入但响应丢失 → 批次发布抛出。
    await expect(
      importHistoryPackages({
        privateRootDirectory: root,
        packageDirectory,
        outputDirectory,
        dependencies: { ...importDependencies(primary, storageRoot), publisher: faultPublisher },
      }),
    ).rejects.toBeDefined();
    expect(manifestWrites.length).toBe(1);
    expect(completeWrites.length).toBe(1);
    // 重放（无故障）：发布日志已确认清单 → 不重写清单；完成标记补写。
    const retry = await importHistoryPackages({
      privateRootDirectory: root,
      packageDirectory,
      outputDirectory,
      dependencies: { ...importDependencies(primary, storageRoot), publisher: countingPublisher },
    });
    expect(retry.skippedCount).toBe(1);
    expect(retry.importedCount).toBe(0);
    expect(manifestWrites.length).toBe(1);
    expect(completeWrites.length).toBe(2);
    expect(await countProblemsByTitle(primary, "合成题目 candidate-000115")).toBe(1);
    const completePath = join(outputDirectory, "IMPORT_COMPLETE");
    expect((await stat(completePath)).isFile()).toBe(true);
    const batchJournal = (await readPrivateJson(join(outputDirectory, "batch-publication.private.json"))) as {
      batchSha256: string;
      phase: string;
    };
    expect(batchJournal.batchSha256).toBe(sha256Hex(JSON.stringify([packaged.packageSha256])));
    expect(batchJournal.phase).toBe("complete_publish_confirmed");
  });

  it("批次发布日志：成功导入后持久化身份与精确摘要，重放不重写任何发布效果", async () => {
    if (primary === undefined) throw new Error("未建立测试数据库。");
    const { root, packageDirectory, outputDirectory, packaged } = await setupPackage("candidate-000117");
    const storageRoot = join(root, "storage");
    const manifestWrites: string[] = [];
    const completeWrites: string[] = [];
    const countingPublisher: HistoryImportPublisher = {
      writeManifest: async (manifestPath: string, payload: string) => {
        manifestWrites.push(payload);
        await writeFile(manifestPath, payload, { mode: 0o600 });
      },
      writeComplete: async (completePath: string, payload: string) => {
        completeWrites.push(payload);
        await writeFile(completePath, payload, { mode: 0o600 });
      },
      removeComplete: async (completePath: string) => {
        await rm(completePath, { force: true });
      },
    };
    const first = await importHistoryPackages({
      privateRootDirectory: root,
      packageDirectory,
      outputDirectory,
      dependencies: { ...importDependencies(primary, storageRoot), publisher: countingPublisher },
    });
    expect(first.importedCount).toBe(1);
    expect(manifestWrites.length).toBe(1);
    expect(completeWrites.length).toBe(1);
    const batchJournal = (await readPrivateJson(join(outputDirectory, "batch-publication.private.json"))) as {
      version: number;
      batchSha256: string;
      manifestPayloadDigest: string;
      completePayloadDigest: string;
      phase: string;
    };
    expect(batchJournal.version).toBe(1);
    expect(batchJournal.batchSha256).toBe(sha256Hex(JSON.stringify([packaged.packageSha256])));
    expect(batchJournal.phase).toBe("complete_publish_confirmed");
    const manifestPath = join(outputDirectory, "import-manifest.private.json");
    const completePath = join(outputDirectory, "IMPORT_COMPLETE");
    expect(batchJournal.manifestPayloadDigest).toBe(sha256Hex(await readFile(manifestPath)));
    expect(batchJournal.completePayloadDigest).toBe(sha256Hex(await readFile(completePath)));
    const retry = await importHistoryPackages({
      privateRootDirectory: root,
      packageDirectory,
      outputDirectory,
      dependencies: { ...importDependencies(primary, storageRoot), publisher: countingPublisher },
    });
    expect(retry.skippedCount).toBe(1);
    expect(retry.importedCount).toBe(0);
    expect(manifestWrites.length).toBe(1);
    expect(completeWrites.length).toBe(1);
    const journalAfterRetry = (await readPrivateJson(join(outputDirectory, "batch-publication.private.json"))) as {
      phase: string;
    };
    expect(journalAfterRetry.phase).toBe("complete_publish_confirmed");
    // R2 修正：已确认不变的批次重放不得移除持久完成标记。
    expect((await stat(completePath)).isFile()).toBe(true);
    expect(await countProblemsByTitle(primary, "合成题目 candidate-000117")).toBe(1);
  });

  it("响应丢失：完成标记移除成功但响应丢失 → 抛出异常但故障关闭顺序已生效，重放成功收敛", async () => {
    if (primary === undefined) throw new Error("未建立测试数据库。");
    const { root, packageDirectory, outputDirectory, packaged } = await setupPackage("candidate-000116");
    const storageRoot = join(root, "storage");
    const faultPublisher = new FaultInjectingPublisher({
      writeManifest: async (manifestPath: string, payload: string) =>
        writeFile(manifestPath, payload, { mode: 0o600 }),
      writeComplete: async (completePath: string, payload: string) =>
        writeFile(completePath, payload, { mode: 0o600 }),
      removeComplete: async (completePath: string) => rm(completePath, { force: true }),
    });
    faultPublisher.injectResponseLossOnce("removeComplete", new Error("simulated removeComplete response loss"));
    // 首次运行：移除动作已生效但响应丢失 → 批次发布抛出（清单/标记未写入）。
    await expect(
      importHistoryPackages({
        privateRootDirectory: root,
        packageDirectory,
        outputDirectory,
        dependencies: { ...importDependencies(primary, storageRoot), publisher: faultPublisher },
      }),
    ).rejects.toBeDefined();
    // 题目已导入；故障关闭顺序生效：无完成标记。
    expect(await countProblemsByTitle(primary, "合成题目 candidate-000116")).toBe(1);
    await expect(stat(join(outputDirectory, "IMPORT_COMPLETE"))).rejects.toBeDefined();
    // 重放（无故障）：清单未写入 → 重放按已成功任务重建，恰好一个题目。
    const retry = await importHistoryPackages({
      privateRootDirectory: root,
      packageDirectory,
      outputDirectory,
      dependencies: importDependencies(primary, storageRoot),
    });
    expect(retry.importedCount).toBe(1);
    expect(retry.failedCount).toBe(0);
    expect(await countProblemsByTitle(primary, "合成题目 candidate-000116")).toBe(1);
    expect((await stat(join(outputDirectory, "IMPORT_COMPLETE"))).isFile()).toBe(true);
    const batchJournal = (await readPrivateJson(join(outputDirectory, "batch-publication.private.json"))) as {
      batchSha256: string;
      phase: string;
    };
    expect(batchJournal.batchSha256).toBe(sha256Hex(JSON.stringify([packaged.packageSha256])));
    expect(batchJournal.phase).toBe("complete_publish_confirmed");
  });

  it("耦合陈旧工人：A 写入后租约过期，B 认领恢复并完成，A 的围栏完成/失败均被拒绝，收敛到唯一 problem/job", async () => {
    if (primary === undefined) throw new Error("未建立测试数据库。");
    const store = new DatabaseProblemPackageJobStore(primary);
    const { root } = await setupPackage("candidate-000131");
    const digest = sha256Hex(randomUUID());
    const sourceFileId = randomUUID();
    await primary.execute(sql`
      INSERT INTO stored_files (id, purpose, storage_key, original_name, media_type, byte_size, sha256, created_by_user_id)
      VALUES (
        ${sourceFileId}::uuid, 'import_input',
        ${`objects/${sourceFileId}`}, 'synthetic-000131.zip', 'application/zip',
        1, ${digest},
        ${databaseDemoUserIds.leader}::bigint
      )
    `);
    const queuedJob = await store.createImportJob({
      requestedByUserId: databaseDemoUserIds.leader,
      clientRequestDigest: digest,
      sourceFileId,
      inputDigest: digest,
      selectedFormat: urmotivNativeAdapter.id,
      selectedFormatVersion: urmotivNativeAdapter.version,
      choices: { conflictAction: "create" },
      itemCount: 1,
      idempotencyKey: digest,
      auditRequestId: randomUUID(),
    });
    const jobId = queuedJob.id;
    const writer = new DatabaseImportedProblemWriter({
      database: primary,
      store: new DatabaseDataStore(primary),
      metadata: new ProblemFileStore(primary),
      storage: new LocalFileStorage({ rootDirectory: join(root, "storage"), limits: { maxBytes: 256 * 1024 * 1024 } }),
      audit: new DatabaseProblemPackageAuditWriter(primary),
    });
    // 工人 A：认领并写入题目（租约 A 活跃）。
    const claimA = await store.claimOrRecoverImportJob({ jobId, leaseDurationMs: 60_000 });
    expect(claimA?.kind).toBe("claimed");
    if (claimA?.kind !== "claimed") throw new Error("A 认领失败。");
    const leaseA = claimA.leaseId;
    const problemTitle = "耦合陈旧工人 candidate-000131";
    const written = await writer.write({
      importJobId: jobId,
      position: 0,
      requestedByUserId: databaseDemoUserIds.leader,
      choices: { conflictAction: "create" },
      problem: {
        title: problemTitle,
        type: "traditional",
        tags: ["catalog.tag.01.01"],
        difficulty: {},
        content: { basicStatement: "test", basicSolution: "test", background: "", statement: "", inputFormat: "", outputFormat: "", constraints: "", solution: "", hints: "" },
        samples: [],
        files: [],
        extensions: {},
      },
      signal: new AbortController().signal,
      leaseId: leaseA,
    });
    const problemId = written.problemId;
    expect(await countProblemsByTitle(primary, problemTitle)).toBe(1);
    // 工人 A 的租约过期（模拟 A 失联/停顿超过租约期）。
    await primary.execute(sql`
      UPDATE import_jobs
      SET lease_expires_at = now() - interval '1 second'
      WHERE id = ${jobId}::uuid AND lease_id = ${leaseA}::uuid
    `);
    // 工人 B：认领恢复（attempt 递增、换新租约 B）。
    const claimB = await store.claimOrRecoverImportJob({ jobId, leaseDurationMs: 60_000 });
    expect(claimB?.kind).toBe("claimed");
    if (claimB?.kind !== "claimed") throw new Error("B 认领失败。");
    const leaseB = claimB.leaseId;
    expect(leaseB).not.toBe(leaseA);
    expect(claimB.job.executionAttempt).toBeGreaterThan(claimA.job.executionAttempt);
    // 工人 B：围栏完成 → 成功。
    const completedByB = await store.fencedCompleteImportJob({
      jobId,
      leaseId: leaseB,
      report: { version: 1, phase: "completed", completedItems: 1, failedItems: 0, skippedItems: 0 },
    });
    expect(completedByB).toBe(true);
    // 工人 A：陈旧的围栏完成/失败均被拒绝；任务保持 B 完成的 succeeded。
    const staleCompleteByA = await store.fencedCompleteImportJob({
      jobId,
      leaseId: leaseA,
      report: { version: 1, phase: "completed", completedItems: 1, failedItems: 0, skippedItems: 0 },
    });
    expect(staleCompleteByA).toBe(false);
    const staleFailByA = await store.fencedFailImportJob({
      jobId,
      leaseId: leaseA,
      position: 0,
      code: "internal_failure",
      report: { version: 1, phase: "failed", completedItems: 0, failedItems: 1, skippedItems: 0 },
    });
    expect(staleFailByA).toBe(false);
    // 收敛：唯一 job、唯一 item、唯一 problem；item 保留 A 写入的 problemId；job succeeded。
    const finalJob = await store.getImportJob(jobId);
    expect(finalJob?.state).toBe("succeeded");
    expect(finalJob?.executionAttempt).toBe(claimB.job.executionAttempt);
    const items = await store.getImportItems(jobId);
    expect(items.length).toBe(1);
    expect(items[0]?.state).toBe("succeeded");
    expect(items[0]?.importedProblemId).toBe(problemId);
    expect(await countProblemsByTitle(primary, problemTitle)).toBe(1);
    const jobCount = await primary.query<{ count: number }>(sql`
      SELECT count(*)::integer AS count FROM import_jobs WHERE id = ${jobId}::uuid
    `);
    expect(Number(jobCount[0]?.count ?? 0)).toBe(1);
  });
});


// ---------------------------------------------------------------------------
// 测试助手
// ---------------------------------------------------------------------------


async function createPrivateRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "urmotiv-history-import-"));
  await chmod(root, 0o700);
  temporaryDirectories.push(root);
  return root;
}

function importDependencies(
  database: DatabaseHandle,
  storageRoot: string,
): {
  readonly database: DatabaseHandle;
  readonly storageRoot: string;
  readonly assignedTagId: string;
  readonly requestedByUserId: string;
  readonly authorization: ServiceImportExecutionAuthorization;
} {
  const store = new DatabaseDataStore(database);
  return {
    database,
    storageRoot,
    assignedTagId: "catalog.tag.01.01",
    requestedByUserId: databaseDemoUserIds.leader,
    authorization: new ServiceImportExecutionAuthorization({
      getUser: (userId) => store.getUser(userId),
    }),
  };
}

async function syntheticProblem(candidateId: string): Promise<CanonicalProblem> {
  return {
    title: `合成题目 ${candidateId}`,
    type: "traditional",
    tags: [],
    difficulty: { codeforces: 800, thinkingLevel: 1, codingLevel: 1 },
    content: {
      basicStatement: `# 合成题目 ${candidateId}\n\n这是合成测试字节，不含任何真实题目内容。`,
      basicSolution: `合成答案 ${candidateId}`,
      background: "",
      statement: "",
      inputFormat: "",
      outputFormat: "",
      constraints: "",
      solution: "",
      hints: "",
    },
    samples: [],
    files: [],
    extensions: {},
  };
}

async function createSyntheticPackage(
  directory: string,
  candidateId: string,
): Promise<{
  candidateId: string;
  contentSha256: string;
  packageSha256: string;
  packageBytes: number;
}> {
  // 只生成一次 zip：摘要必须来自实际写入磁盘的字节。
  const problem = await syntheticProblem(candidateId);
  const generated = await urmotivNativeAdapter.export(problem, {});
  if (generated.kind === "single_file") {
    throw new Error("原生适配器必须产出 zip。");
  }
  const zipBytes = writeZipArchive(generated.files, { allowNestedArchives: true });
  await writeFile(join(directory, "packages", `${candidateId}.zip`), zipBytes);
  return {
    candidateId,
    contentSha256: sha256Hex(new TextEncoder().encode(problem.content.basicStatement)),
    packageSha256: sha256Hex(zipBytes),
    packageBytes: zipBytes.byteLength,
  };
}

async function writePackageReport(
  packageDirectory: string,
  entries: ReadonlyArray<{
    candidateId: string;
    contentSha256: string;
    packageSha256: string;
    packageBytes: number;
  }>,
): Promise<void> {
  const payload = {
    version: 1,
    phase: "package",
    batchSha256: sha256Hex(JSON.stringify(entries.map((entry) => entry.packageSha256))),
    packageCount: entries.length,
    packages: entries.map((entry) => ({
      candidateId: entry.candidateId,
      contentSha256: entry.contentSha256,
      packageSha256: entry.packageSha256,
      packageBytes: entry.packageBytes,
      status: "packaged",
      attachments: [],
    })),
  };
  await writeFile(join(packageDirectory, "report.json"), JSON.stringify(payload));
  await writeFile(
    join(packageDirectory, "PACKAGE_COMPLETE"),
    JSON.stringify({ version: 1, phase: "package", packageCount: entries.length }),
  );
}

async function countProblems(database: DatabaseHandle): Promise<number> {
  const rows = await database.query<{ count: number }>(sql`
    SELECT count(*)::integer AS count FROM problems
  `);
  return Number(rows[0]?.count ?? 0);
}

async function countImportJobs(database: DatabaseHandle): Promise<number> {
  const rows = await database.query<{ count: number }>(sql`
    SELECT count(*)::integer AS count FROM import_jobs
  `);
  return Number(rows[0]?.count ?? 0);
}

async function readImportedProblem(database: DatabaseHandle): Promise<{
  problemId: number;
  revisionId: string;
  title: string;
}> {
  const rows = await database.query<{
    problem_id: number;
    revision_id: string;
    title: string;
  }>(sql`
    SELECT
      pr.problem_id::int AS problem_id,
      pr.id::text AS revision_id,
      pr.title AS title
    FROM problem_revisions pr
    ORDER BY pr.created_at DESC
    LIMIT 1
  `);
  const row = rows[0];
  if (row === undefined) {
    throw new Error("导入测试题目不存在。");
  }
  return {
    problemId: Number(row.problem_id),
    revisionId: String(row.revision_id),
    title: String(row.title),
  };
}

// ---------------------------------------------------------------------------
// 故障注入包装器（复用既有依赖注入接口，非测试专用旁路）
// ---------------------------------------------------------------------------

/**
 * 包装 ProblemPackageJobStore，在指定方法第 N 次调用时抛出异常。
 * 用完即弃——每个测试创建自己的实例。
 */
class FaultInjectingJobStore implements HistoryImportJobStore {
  readonly #inner: HistoryImportJobStore;
  readonly #faults: Map<string, { remaining: number; error: Error }>;
  readonly #responseLossFaults: Map<string, { remaining: number; error: Error }>;

  public constructor(inner: HistoryImportJobStore) {
    this.#inner = inner;
    this.#faults = new Map();
    this.#responseLossFaults = new Map();
  }

  /** 在指定方法下一次调用时抛出 error。 */
  public injectOnce(method: keyof ProblemPackageJobStore, error: Error): void {
    this.#faults.set(String(method), { remaining: 1, error });
  }

  /** 先执行成功，再抛出（效果已发生但响应丢失）。 */
  public injectResponseLossOnce(method: "createImportJob", error: Error): void {
    this.#responseLossFaults.set(method, { remaining: 1, error });
  }

  #check(method: keyof ProblemPackageJobStore): void {
    const fault = this.#faults.get(String(method));
    if (fault !== undefined) {
      if (fault.remaining <= 0) {
        this.#faults.delete(String(method));
      } else {
        fault.remaining -= 1;
        throw fault.error;
      }
    }
  }

  async #checkResponseLoss<T>(method: string, result: T): Promise<T> {
    const fault = this.#responseLossFaults.get(method);
    if (fault !== undefined && fault.remaining > 0) {
      fault.remaining -= 1;
      if (fault.remaining <= 0) this.#responseLossFaults.delete(method);
      throw fault.error;
    }
    return result;
  }


  public async createImportJob(
    input: CreateProblemPackageImportJob,
  ): Promise<ProblemPackageImportJob> {
    this.#check("createImportJob");
    const result = await this.#inner.createImportJob(input);
    return this.#checkResponseLoss("createImportJob", result);
  }
  public async createExportJob(
    input: CreateProblemPackageExportJob,
  ): Promise<ProblemPackageExportJob> {
    return this.#inner.createExportJob(input);
  }
  public async getImportJob(jobId: string): Promise<ProblemPackageImportJob | undefined> {
    return this.#inner.getImportJob(jobId);
  }
  public async getImportItems(jobId: string): Promise<readonly ProblemPackageImportItem[]> {
    return this.#inner.getImportItems(jobId);
  }
  public async getExportJob(jobId: string): Promise<ProblemPackageExportJob | undefined> {
    return this.#inner.getExportJob(jobId);
  }
  public async startImportJob(jobId: string): Promise<ProblemPackageImportJob | undefined> {
    this.#check("startImportJob");
    return this.#inner.startImportJob(jobId);
  }
  public async startExportJob(jobId: string): Promise<ProblemPackageExportJob | undefined> {
    return this.#inner.startExportJob(jobId);
  }
  public async updateImportJob(
    jobId: string,
    progressPercent: number,
    report: ProblemPackageJobReport,
  ): Promise<void> {
    return this.#inner.updateImportJob(jobId, progressPercent, report);
  }
  public async updateExportJob(
    jobId: string,
    progressPercent: number,
    report: ProblemPackageJobReport,
  ): Promise<void> {
    return this.#inner.updateExportJob(jobId, progressPercent, report);
  }
  public async recordImportItem(
    jobId: string,
    position: number,
    outcome: ImportItemOutcome,
  ): Promise<void> {
    this.#check("recordImportItem");
    return this.#inner.recordImportItem(jobId, position, outcome);
  }
  public async completeImportJob(jobId: string, report: ProblemPackageJobReport): Promise<void> {
    this.#check("completeImportJob");
    return this.#inner.completeImportJob(jobId, report);
  }
  public async completeExportJob(
    jobId: string,
    result: CompleteProblemPackageExport,
  ): Promise<void> {
    return this.#inner.completeExportJob(jobId, result);
  }
  public async failImportJob(
    jobId: string,
    code: ProblemPackageFailureCode,
    report: ProblemPackageJobReport,
  ): Promise<void> {
    return this.#inner.failImportJob(jobId, code, report);
  }
  public async failExportJob(jobId: string, code: ProblemPackageFailureCode): Promise<void> {
    return this.#inner.failExportJob(jobId, code);
  }
  public async findImportJobForReplay(
    input: { requestedByUserId: string; idempotencyKey: string; clientRequestDigest: string },
  ): Promise<ImportJobReplayResult | undefined> {
    return this.#inner.findImportJobForReplay(input);
  }
  public async findExportJobForReplay(
    input: { requestedByUserId: string; idempotencyKey: string },
  ): Promise<ProblemPackageExportJob | undefined> {
    return this.#inner.findExportJobForReplay(input);
  }
  public async claimOrRecoverImportJob(input: {
    readonly jobId: string;
    readonly leaseDurationMs: number;
  }): Promise<HistoryImportJobClaim | undefined> {
    return this.#inner.claimOrRecoverImportJob(input);
  }
  public async renewImportJobLease(input: {
    readonly jobId: string;
    readonly leaseId: string;
    readonly leaseDurationMs: number;
  }): Promise<boolean> {
    return this.#inner.renewImportJobLease(input);
  }
  public async fencedCompleteImportJob(input: {
    readonly jobId: string;
    readonly leaseId: string;
    readonly report: ProblemPackageJobReport;
  }): Promise<boolean> {
    return this.#inner.fencedCompleteImportJob(input);
  }
  public async fencedFailImportJob(input: {
    readonly jobId: string;
    readonly leaseId: string;
    readonly position: number;
    readonly code: ProblemPackageFailureCode;
    readonly report: ProblemPackageJobReport;
  }): Promise<boolean> {
    return this.#inner.fencedFailImportJob(input);
  }
}

/**
 * 包装 FileStorage，在指定方法第 N 次调用时抛出异常。
 * 支持两种故障模式：
 * - injectOnce: 在调用前抛出（效果未发生）
 * - injectResponseLossOnce: 先执行成功，再抛出（效果已发生但响应丢失）
 */
class FaultInjectingStorage implements FileStorage {
  readonly #inner: FileStorage;
  readonly #faults: Map<string, { remaining: number; error: Error }>;
  readonly #responseLossFaults: Map<string, { remaining: number; error: Error }>;

  public constructor(inner: FileStorage) {
    this.#inner = inner;
    this.#faults = new Map();
    this.#responseLossFaults = new Map();
  }

  public injectOnce(method: "stage" | "publish" | "discard", error: Error): void {
    this.#faults.set(method, { remaining: 1, error });
  }

  public injectResponseLossOnce(method: "publish" | "delete", error: Error): void {
    this.#responseLossFaults.set(method, { remaining: 1, error });
  }

  #check(method: string): void {
    const fault = this.#faults.get(method);
    if (fault !== undefined) {
      if (fault.remaining <= 0) {
        this.#faults.delete(method);
      } else {
        fault.remaining -= 1;
        throw fault.error;
      }
    }
  }

  async #checkResponseLoss<T>(method: string, result: T): Promise<T> {
    const fault = this.#responseLossFaults.get(method);
    if (fault !== undefined && fault.remaining > 0) {
      fault.remaining -= 1;
      if (fault.remaining <= 0) this.#responseLossFaults.delete(method);
      throw fault.error;
    }
    return result;
  }

  public async stage(input: StageFileInput): Promise<StagedFile> {
    this.#check("stage");
    return this.#inner.stage(input);
  }
  public async publish(stagedFile: StagedFile): Promise<StoredFile> {
    this.#check("publish");
    const result = await this.#inner.publish(stagedFile);
    return this.#checkResponseLoss("publish", result);
  }
  public async discard(stagedFile: StagedFile): Promise<void> {
    return this.#inner.discard(stagedFile);
  }
  public async open(
    storedFile: Pick<StoredFile, "id" | "storageKey">,
  ): Promise<AsyncIterable<Uint8Array>> {
    return this.#inner.open(storedFile);
  }
  public async delete(storedFile: Pick<StoredFile, "id" | "storageKey">): Promise<void> {
    const result = await this.#inner.delete(storedFile);
    return this.#checkResponseLoss("delete", result);
  }
}

/**
 * 包装 HistoryImportPublisher，在指定方法下一次调用时抛出异常。
 * 用于验证发布失败下的恢复语义和故障关闭顺序。
 */
class FaultInjectingPublisher implements HistoryImportPublisher {
  readonly #inner: HistoryImportPublisher;
  readonly #faults: Map<string, { remaining: number; error: Error }>;
  readonly #responseLossFaults: Map<string, { remaining: number; error: Error }>;

  public constructor(inner: HistoryImportPublisher) {
    this.#inner = inner;
    this.#faults = new Map();
    this.#responseLossFaults = new Map();
  }

  public injectOnce(method: "writeManifest" | "writeComplete" | "removeComplete", error: Error): void {
    this.#faults.set(method, { remaining: 1, error });
  }

  public injectResponseLossOnce(method: "writeManifest" | "writeComplete" | "removeComplete", error: Error): void {
    this.#responseLossFaults.set(method, { remaining: 1, error });
  }

  #check(method: string): void {
    const fault = this.#faults.get(method);
    if (fault !== undefined) {
      if (fault.remaining <= 0) {
        this.#faults.delete(method);
      } else {
        fault.remaining -= 1;
        throw fault.error;
      }
    }
  }

  async #checkResponseLoss(method: string, inner: () => Promise<void>): Promise<void> {
    await inner();
    const fault = this.#responseLossFaults.get(method);
    if (fault !== undefined && fault.remaining > 0) {
      fault.remaining -= 1;
      if (fault.remaining <= 0) this.#responseLossFaults.delete(method);
      throw fault.error;
    }
  }

  public async writeManifest(manifestPath: string, payload: string): Promise<void> {
    this.#check("writeManifest");
    return this.#checkResponseLoss("writeManifest", () => this.#inner.writeManifest(manifestPath, payload));
  }
  public async writeComplete(completePath: string, payload: string): Promise<void> {
    this.#check("writeComplete");
    return this.#checkResponseLoss("writeComplete", () => this.#inner.writeComplete(completePath, payload));
  }
  public async removeComplete(completePath: string): Promise<void> {
    this.#check("removeComplete");
    return this.#checkResponseLoss("removeComplete", () => this.#inner.removeComplete(completePath));
  }
}

/**
 * 包装 HistoryImportRecoveryStore，在指定方法下一次调用时抛出异常或返回特定结果。
 */
class FaultInjectingRecoveryStore implements HistoryImportRecoveryStore {
  readonly #inner: HistoryImportRecoveryStore;
  readonly #throwFaults: Map<string, { remaining: number; error: Error }>;
  readonly #returnFaults: Map<string, { remaining: number; value: unknown }>;

  public constructor(inner: HistoryImportRecoveryStore) {
    this.#inner = inner;
    this.#throwFaults = new Map();
    this.#returnFaults = new Map();
  }

  public injectThrowOnce(
    method: "claimOrRecoverImportJob" | "renewImportJobLease" | "fencedCompleteImportJob" | "fencedFailImportJob",
    error: Error,
  ): void {
    this.#throwFaults.set(method, { remaining: 1, error });
  }

  public injectReturnOnce(
    method: "fencedCompleteImportJob" | "fencedFailImportJob",
    value: boolean,
  ): void {
    this.#returnFaults.set(method, { remaining: 1, value });
  }

  #checkThrow(method: string): void {
    const fault = this.#throwFaults.get(method);
    if (fault !== undefined) {
      if (fault.remaining <= 0) {
        this.#throwFaults.delete(method);
      } else {
        fault.remaining -= 1;
        throw fault.error;
      }
    }
  }

  #checkReturn<T>(method: string, fallback: () => Promise<T>): Promise<T> {
    const fault = this.#returnFaults.get(method);
    if (fault !== undefined && fault.remaining > 0) {
      fault.remaining -= 1;
      if (fault.remaining <= 0) this.#returnFaults.delete(method);
      return Promise.resolve(fault.value as T);
    }
    return fallback();
  }

  public async claimOrRecoverImportJob(input: {
    readonly jobId: string;
    readonly leaseDurationMs: number;
  }): Promise<HistoryImportJobClaim | undefined> {
    this.#checkThrow("claimOrRecoverImportJob");
    return this.#inner.claimOrRecoverImportJob(input);
  }

  public async renewImportJobLease(input: {
    readonly jobId: string;
    readonly leaseId: string;
    readonly leaseDurationMs: number;
  }): Promise<boolean> {
    this.#checkThrow("renewImportJobLease");
    return this.#inner.renewImportJobLease(input);
  }

  public async fencedCompleteImportJob(input: {
    readonly jobId: string;
    readonly leaseId: string;
    readonly report: ProblemPackageJobReport;
  }): Promise<boolean> {
    this.#checkThrow("fencedCompleteImportJob");
    return this.#checkReturn("fencedCompleteImportJob", () => this.#inner.fencedCompleteImportJob(input));
  }

  public async fencedFailImportJob(input: {
    readonly jobId: string;
    readonly leaseId: string;
    readonly position: number;
    readonly code: ProblemPackageFailureCode;
    readonly report: ProblemPackageJobReport;
  }): Promise<boolean> {
    this.#checkThrow("fencedFailImportJob");
    return this.#checkReturn("fencedFailImportJob", () => this.#inner.fencedFailImportJob(input));
  }
}

/**
 * 包装 AtomicImportedProblemWriter，支持响应丢失（先提交成功再抛出）。
 */
class FaultInjectingWriter implements AtomicImportedProblemWriter {
  readonly #inner: AtomicImportedProblemWriter;
  #responseLossRemaining = 0;
  #responseLossError: Error | null = null;

  public constructor(inner: AtomicImportedProblemWriter) {
    this.#inner = inner;
  }

  public injectWriteResponseLossOnce(error: Error): void {
    this.#responseLossRemaining = 1;
    this.#responseLossError = error;
  }

  public async write(input: {
    readonly importJobId: string;
    readonly position: number;
    readonly requestedByUserId: string;
    readonly choices: ProblemPackageImportChoices;
    readonly problem: CanonicalProblem;
    readonly signal: AbortSignal;
    readonly leaseId?: string;
  }): Promise<{ readonly problemId: string }> {
    const result = await this.#inner.write(input);
    if (this.#responseLossRemaining > 0 && this.#responseLossError !== null) {
      this.#responseLossRemaining -= 1;
      const err = this.#responseLossError;
      this.#responseLossError = null;
      throw err;
    }
    return result;
  }
}

/**
 * 包装 ProblemFileStore，支持 createStoredFile 响应丢失（先提交成功再抛出）。
 */
class FaultInjectingProblemFileStore {
  readonly #inner: ProblemFileStore;
  #responseLossRemaining = 0;
  #responseLossError: Error | null = null;

  public constructor(inner: ProblemFileStore) {
    this.#inner = inner;
  }

  public injectCreateStoredFileResponseLossOnce(error: Error): void {
    this.#responseLossRemaining = 1;
    this.#responseLossError = error;
  }

  public async createStoredFile(input: CreateStoredFileInput): Promise<StoredFileRecord> {
    const result = await this.#inner.createStoredFile(input);
    if (this.#responseLossRemaining > 0 && this.#responseLossError !== null) {
      this.#responseLossRemaining -= 1;
      const err = this.#responseLossError;
      this.#responseLossError = null;
      throw err;
    }
    return result;
  }

  public async findStoredFile(fileId: string): Promise<StoredFileRecord | undefined> {
    return this.#inner.findStoredFile(fileId);
  }
}

async function countStoredFiles(database: DatabaseHandle, sha256?: string): Promise<number> {
  const rows = await database.query<{ count: number }>(sql`
    SELECT count(*)::integer AS count FROM stored_files
    ${sha256 !== undefined ? sql`WHERE sha256 = ${sha256}` : sql``}
  `);
  return Number(rows[0]?.count ?? 0);
}

async function countProblemsByTitle(database: DatabaseHandle, title: string): Promise<number> {
  const rows = await database.query<{ count: number }>(sql`
    SELECT count(*)::integer AS count FROM problem_revisions WHERE title = ${title}
  `);
  return Number(rows[0]?.count ?? 0);
}

// ---------------------------------------------------------------------------
// 对抗性压缩包构造助手
// ---------------------------------------------------------------------------

const testEncoder = new TextEncoder();

function crc32Of(content: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of content) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

interface RawZipEntry {
  readonly path: string;
  readonly content?: Uint8Array;
  readonly symlink?: boolean;
}

function buildRawZip(entries: readonly RawZipEntry[]): Uint8Array {
  const localParts: Uint8Array[] = [];
  const centralParts: Uint8Array[] = [];
  let offset = 0;

  for (const entry of entries) {
    const nameBytes = testEncoder.encode(entry.path);
    const content = entry.content ?? new Uint8Array(0);
    const method = 8;
    const stored = new Uint8Array(deflateRawSync(content));
    const declaredSize = content.byteLength;
    const checksum = crc32Of(content);
    const flags = 0x0800;
    const externalAttrs = entry.symlink ? 0o120777 << 16 : 0o100644 << 16;

    const local = new Uint8Array(30 + nameBytes.byteLength);
    const localView = new DataView(local.buffer);
    localView.setUint32(0, 0x04034b50, true);
    localView.setUint16(4, 20, true);
    localView.setUint16(6, flags, true);
    localView.setUint16(8, method, true);
    localView.setUint32(14, checksum, true);
    localView.setUint32(18, stored.byteLength, true);
    localView.setUint32(22, declaredSize, true);
    localView.setUint16(26, nameBytes.byteLength, true);
    local.set(nameBytes, 30);

    const central = new Uint8Array(46 + nameBytes.byteLength);
    const centralView = new DataView(central.buffer);
    centralView.setUint32(0, 0x02014b50, true);
    centralView.setUint16(4, 0x031e, true);
    centralView.setUint16(6, 20, true);
    centralView.setUint16(8, flags, true);
    centralView.setUint16(10, method, true);
    centralView.setUint32(16, checksum, true);
    centralView.setUint32(20, stored.byteLength, true);
    centralView.setUint32(24, declaredSize, true);
    centralView.setUint16(28, nameBytes.byteLength, true);
    centralView.setUint32(38, externalAttrs, true);
    centralView.setUint32(42, offset, true);
    central.set(nameBytes, 46);

    localParts.push(local, stored);
    centralParts.push(central);
    offset += local.byteLength + stored.byteLength;
  }

  const centralSize = centralParts.reduce((total, part) => total + part.byteLength, 0);
  const end = new Uint8Array(22);
  const endView = new DataView(end.buffer);
  endView.setUint32(0, 0x06054b50, true);
  endView.setUint16(8, entries.length, true);
  endView.setUint16(10, entries.length, true);
  endView.setUint32(12, centralSize, true);
  endView.setUint32(16, offset, true);

  const archive = new Uint8Array(offset + centralSize + 22);
  let cursor = 0;
  for (const part of [...localParts, ...centralParts, end]) {
    archive.set(part, cursor);
    cursor += part.byteLength;
  }
  return archive;
}
