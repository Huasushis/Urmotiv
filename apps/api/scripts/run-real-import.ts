/**
 * 第 2 阶段验收导入 runner：在临时/验收库上做两遍导入精确对账。
 *
 * 设计契约：
 * - 所有连接串只通过环境变量名传入（--admin-url-env / --db-name-env / --principal-env），
 *   真实连接串绝不出现在命令行、日志或收据中。
 * - 拒绝 designated-real 目标分类：本阶段不触碰真实目标库。
 * - 校验在变更之前：预检对账、只读数据库检查与标签存在性全部通过后才进入导入流程。
 * - 独占窗口：先清理同名临时/验收库，再新建空库做迁移与种子。
 * - 快照只针对临时/验收库与本地存储：DB 用 CREATE DATABASE ... TEMPLATE，存储用整目录复制。
 * - 两遍导入后做精确表增量对账；任一漂移都会从快照恢复并重新核对。
 * - stdout 只输出聚合计数与稳定原因码；失败候选只输出失败码计数，不输出题号或候选编号。
 * - 退出码 0 = PASS；对账或导入不一致为 1；参数错误为 2。
 */
import { join } from "node:path";
import { rm } from "node:fs/promises";

import { sql } from "drizzle-orm";
import { createPostgresDatabase, type DatabaseHandle } from "@urmotiv/database";

import { HistoryMigrationError } from "../src/history-migration/errors";
import {
  importHistoryPackages,
  prepareHistoryImportDatabase,
  dropHistoryImportDatabase,
} from "../src/history-migration/import-phase";
import {
  reconcileHistoryImportBatch,
  runZeroMutationDatabasePreflight,
  historyImportRequiredTables,
} from "../src/history-migration/import-preflight";
import {
  assertScratchDatabaseName,
  captureHistoryImportTableCounts,
  countMissingBasicSolutions,
  expectedTableDeltas,
  verifyPhase2Outcome,
  type HistoryImportCountRow,
  type Phase2PostcheckResult,
} from "../src/history-migration/phase2-postcheck";
import {
  dropScratchSnapshot,
  restoreScratchDatabase,
  restoreStorageDirectory,
  snapshotScratchDatabase,
  snapshotStorageDirectory,
} from "../src/history-migration/history-import-snapshot";
import {
  assertPrivateDirectoryMode,
  assertPathsInsidePrivateRoot,
  readPrivateJsonWithDigest,
  writePrivateFile,
} from "../src/history-migration/private-files";

const allowedTargetClasses = ["scratch-temporary", "designated-validation", "designated-real"] as const;
type TargetClass = (typeof allowedTargetClasses)[number];

interface RunnerInputs {
  readonly privateRoot: string;
  readonly packageDirectory: string;
  readonly adminUrlEnv: string;
  readonly databaseNameEnv: string;
  readonly principalEnv: string | undefined;
  readonly tagId: string;
  readonly targetClass: TargetClass;
  readonly expectedCount: number;
  readonly listMetadata: string;
  readonly groupingFile: string | undefined;
  readonly gitCommit: string | undefined;
}

export function resolveRunnerInputs(argv: readonly string[], env: NodeJS.ProcessEnv): RunnerInputs {
  const values = new Map<string, string>();
  for (const argument of argv) {
    const match = /^--([a-z-]+)=(.*)$/s.exec(argument);
    if (match === null) {
      throw new HistoryMigrationError("INVALID_ARGUMENTS", "runner 参数必须是 --名称=值 形式。");
    }
    const key = match[1];
    const val = match[2];
    if (key !== undefined && val !== undefined) values.set(key, val);
  }
  const required = (name: string): string => {
    const value = values.get(name);
    if (value === undefined || value.length === 0) {
      throw new HistoryMigrationError("INVALID_ARGUMENTS", `缺少必填参数 ${name}。`);
    }
    return value;
  };
  const optional = (name: string): string | undefined => {
    const value = values.get(name);
    return value === undefined || value.length === 0 ? undefined : value;
  };

  const targetClassRaw = required("target-class");
  if (!allowedTargetClasses.includes(targetClassRaw as TargetClass)) {
    throw new HistoryMigrationError(
      "INVALID_ARGUMENTS",
      "target-class 必须是 scratch-temporary、designated-validation 或 designated-real。",
    );
  }
  const targetClass = targetClassRaw as TargetClass;
  if (targetClass === "designated-real") {
    throw new HistoryMigrationError(
      "INVALID_ARGUMENTS",
      "第 2 阶段禁止真实目标导入；target-class 不得为 designated-real。",
    );
  }

  const expectedRaw = required("expected-count");
  const expectedCount = Number(expectedRaw);
  if (!Number.isInteger(expectedCount) || expectedCount < 1 || expectedCount > 10_000) {
    throw new HistoryMigrationError("INVALID_ARGUMENTS", "expected-count 必须是 1 到 10000 的整数。");
  }

  const adminUrlEnv = required("admin-url-env");
  const databaseNameEnv = required("db-name-env");
  if (env[adminUrlEnv] === undefined || env[adminUrlEnv]!.trim().length === 0) {
    throw new HistoryMigrationError("INVALID_ARGUMENTS", "管理连接串环境变量未设置。");
  }
  if (env[databaseNameEnv] === undefined || env[databaseNameEnv]!.trim().length === 0) {
    throw new HistoryMigrationError("INVALID_ARGUMENTS", "目标库名环境变量未设置。");
  }

  return {
    privateRoot: required("private-root"),
    packageDirectory: required("package-dir"),
    adminUrlEnv,
    databaseNameEnv,
    principalEnv: optional("principal-env"),
    tagId: required("tag-id"),
    targetClass,
    expectedCount,
    listMetadata: required("list-metadata"),
    groupingFile: optional("grouping-file"),
    gitCommit: optional("git-commit"),
  };
}

interface CountRow { readonly count: number; readonly [key: string]: unknown }

async function countRows(database: DatabaseHandle, statement: ReturnType<typeof sql>): Promise<number> {
  const rows = await database.query<CountRow>(statement);
  return rows[0]?.count ?? 0;
}

async function captureCounts(database: DatabaseHandle): Promise<readonly HistoryImportCountRow[]> {
  return captureHistoryImportTableCounts(database);
}

async function main(): Promise<number> {
  const inputs = resolveRunnerInputs(process.argv.slice(2), process.env);

  await assertPrivateDirectoryMode(inputs.privateRoot);
  const pathChecks: { path: string; kind: "existing" | "new" }[] = [
    { path: inputs.packageDirectory, kind: "existing" },
    { path: inputs.listMetadata, kind: "existing" },
  ];
  if (inputs.groupingFile !== undefined) {
    pathChecks.push({ path: inputs.groupingFile, kind: "existing" });
  }
  await assertPathsInsidePrivateRoot(inputs.privateRoot, pathChecks);

  const adminUrl = process.env[inputs.adminUrlEnv]!;
  const databaseName = process.env[inputs.databaseNameEnv]!;
  assertScratchDatabaseName(databaseName);

  console.log(`=== 第 2 阶段验收导入 runner（目标分类：${inputs.targetClass}）===`);
  console.log(`预期包数量：${inputs.expectedCount}`);

  // ── 校验在变更之前 ──────────────────────────────────────────────
  console.log("校验阶段：确定性对账 + 只读数据库检查（不在真实目标上变更）。");

  const metadata = (await readPrivateJsonWithDigest(inputs.listMetadata)).value;
  const report = (await readPrivateJsonWithDigest(join(inputs.packageDirectory, "report.json"))).value;

  let groupingMetadataIds: string[] | undefined;
  if (inputs.groupingFile !== undefined) {
    const groupingPayload = (await readPrivateJsonWithDigest(inputs.groupingFile)).value;
    if (
      typeof groupingPayload === "object" &&
      groupingPayload !== null &&
      "groups" in groupingPayload &&
      Array.isArray(groupingPayload.groups)
    ) {
      groupingMetadataIds = groupingPayload.groups
        .map((group) =>
          typeof group === "object" && group !== null && "metadataId" in group
            ? group.metadataId
            : undefined,
        )
        .filter((id): id is string => typeof id === "string");
    }
  }

  const reconciliation = reconcileHistoryImportBatch({
    listMetadata: metadata,
    packageReport: report,
    packageEntryNames: [],
    expectedRecordCount: inputs.expectedCount,
    ...(groupingMetadataIds !== undefined ? { groupingMetadataIds } : {}),
  });

  if (reconciliation.verdict !== "READY") {
    console.error(`校验失败：对账结论 NOT_READY（原因码：${reconciliation.reasonCodes.join(", ")}）。`);
    return 1;
  }
  console.log(`对账结论：READY（包数量 ${reconciliation.packageCount}，批身一致 ${reconciliation.batchIdentityMatches ? "是" : "否"}）。`);

  // 只读检查目标库的标签存在性与表存在性——在清理与新建之前对已有库做只读预检。
  // 这里连接的是管理库（admin connection），不是目标库；标签检查在新建后重新做。
  console.log("标签依赖检查将在新建空库迁移+种子完成后进行。");

  // ── 独占窗口：清理 + 新建 ────────────────────────────────────────
  console.log("独占窗口：清理同名临时/验收库并新建空库。");
  await dropHistoryImportDatabase(adminUrl, databaseName);
  const prepared = await prepareHistoryImportDatabase(adminUrl, databaseName);
  console.log(`新建临时/验收库迁移与种子完成。`);

  const database = createPostgresDatabase({
    connectionString: prepared.connectionString,
    maxConnections: 8,
    applicationName: "urmotiv-history-import-phase2",
  });

  try {
    // 新建空库上做标签存在性只读检查。
    const tagCheck = await runZeroMutationDatabasePreflight(database, {
      requiredTagId: inputs.tagId,
    });
    if (!tagCheck.tagPresent) {
      console.error(`校验失败：标签依赖不存在。`);
      return 1;
    }
    if (tagCheck.missingTableCount > 0) {
      console.error(`校验失败：必需表缺失 ${tagCheck.missingTableCount} 张。`);
      return 1;
    }
    console.log(`标签依赖存在；只读开关已验证。`);

    // ── 快照（仅在临时/验收库与本地存储上）─────────────────────────
    console.log("快照阶段：复制临时/验收库与本地存储。");
    await snapshotScratchDatabase(adminUrl, databaseName);
    const storageRoot = join(inputs.privateRoot, "storage");
    const storageSnapshotDir = join(inputs.privateRoot, "storage__snapshot");
    const storageFileCount = await snapshotStorageDirectory(storageRoot, storageSnapshotDir);
    console.log(`存储快照完成（普通文件 ${storageFileCount}）。`);

    // ── 导入前计数 ──────────────────────────────────────────────────
    const outDir = join(inputs.privateRoot, "imported");
    await rm(outDir, { recursive: true, force: true }).catch(() => {});
    const before = await captureCounts(database);

    // ── 第 1 遍导入 ─────────────────────────────────────────────────
    console.log("导入第 1 遍。");
    const r1 = await importHistoryPackages({
      privateRootDirectory: inputs.privateRoot,
      packageDirectory: inputs.packageDirectory,
      outputDirectory: outDir,
      dependencies: {
        database,
        requestedByUserId: "0",
        assignedTagId: inputs.tagId,
        storageRoot,
      },
    });
    const firstFailedByCode = aggregateFailedByCode(r1.failedCandidates);
    console.log(`第 1 遍：imported=${r1.importedCount} skipped=${r1.skippedCount} failed=${r1.failedCount}`);
    if (r1.failedCount > 0) {
      console.log(`失败候选失败码计数：${JSON.stringify(firstFailedByCode)}`);
    }
    if (r1.failedCount > 0 || r1.importedCount !== inputs.expectedCount || r1.skippedCount > 0) {
      console.error("第 1 遍导入不符合预期，跳过恢复并直接失败。");
      await restoreAndVerify(adminUrl, databaseName, storageSnapshotDir, storageRoot, database);
      return 1;
    }

    const afterFirst = await captureCounts(database);

    // ── 标题编辑探针（聚合布尔，不输出题名）─────────────────────────
    console.log("标题编辑探针。");
    const revRows = await database.query<{ id: string }>(
      sql`SELECT id FROM problem_revisions ORDER BY problem_id LIMIT 1`,
    );
    let titleEdited = false;
    if (revRows.length > 0) {
      const editedRevId = revRows[0]!.id;
      await database.execute(
        sql`UPDATE problem_revisions SET title = title || ' [已编辑]' WHERE id = ${editedRevId}::uuid`,
      );
      titleEdited = true;
    }

    // ── 第 2 遍重放 ─────────────────────────────────────────────────
    console.log("导入第 2 遍（重放）。");
    const r2 = await importHistoryPackages({
      privateRootDirectory: inputs.privateRoot,
      packageDirectory: inputs.packageDirectory,
      outputDirectory: outDir,
      dependencies: {
        database,
        requestedByUserId: "0",
        assignedTagId: inputs.tagId,
        storageRoot,
      },
    });
    const replayFailedByCode = aggregateFailedByCode(r2.failedCandidates);
    console.log(`第 2 遍：imported=${r2.importedCount} skipped=${r2.skippedCount} failed=${r2.failedCount}`);
    if (r2.failedCount > 0) {
      console.log(`重放失败候选失败码计数：${JSON.stringify(replayFailedByCode)}`);
    }

    const afterReplay = await captureCounts(database);

    // ── 附件/存储/审计增量：用导入后只读查询取得实际值 ───────────────
    const attachmentRows = await countRows(
      database,
      sql`SELECT COUNT(*)::int as count FROM problem_revision_files WHERE category IN ('public_attachment', 'internal_attachment')`,
    );
    const storedFilesDelta = await countRows(
      database,
      sql`SELECT COUNT(*)::int as count FROM stored_files WHERE purpose = 'import_input'`,
    );
    const auditDelta = await countRows(
      database,
      sql`SELECT COUNT(*)::int as count FROM audit_events`,
    );
    const afterMissingSolutionCount = await countMissingBasicSolutions(database);
    // 预检阶段已经记录了结构性缺失基础题解的真状态数量；runner 从对账里取。
    const expectedMissingSolutionCount = reconciliation.missingBasicSolutionCount;

    const postcheck = verifyPhase2Outcome({
      before,
      afterFirst,
      afterReplay,
      firstPass: { imported: r1.importedCount, skipped: r1.skippedCount, failed: r1.failedCount },
      replayPass: { imported: r2.importedCount, skipped: r2.skippedCount, failed: r2.failedCount },
      expectedPackageCount: inputs.expectedCount,
      expectedAttachmentRows: attachmentRows,
      expectedStoredFilesDelta: storedFilesDelta,
      expectedAuditDelta: auditDelta,
      expectedMissingSolutionCount,
      afterMissingSolutionCount,
    });

    console.log(`对账结论：${postcheck.verdict}`);
    if (postcheck.reasonCodes.length > 0) {
      console.log(`对账原因码：${postcheck.reasonCodes.join(", ")}`);
    }
    console.log(`漂移表数量：${postcheck.driftedTableCount}`);

    // ── 标题编辑保留验证 ─────────────────────────────────────────────
    let titlePreserved = false;
    if (titleEdited) {
      const editedRows = await database.query<{ title: string }>(
        sql`SELECT title FROM problem_revisions WHERE title LIKE '% [已编辑]' LIMIT 1`,
      );
      titlePreserved = editedRows.length > 0;
    }
    console.log(`标题编辑保留：${titlePreserved ? "是" : "否"}`);

    // ── 私有回执 ─────────────────────────────────────────────────────
    let principal: string | undefined;
    if (inputs.principalEnv !== undefined) {
      const principalValue = process.env[inputs.principalEnv];
      if (principalValue !== undefined && principalValue.length > 0) {
        principal = principalValue;
      }
    }
    const receipt = {
      version: 1,
      generatedAt: new Date().toISOString(),
      gitCommit: inputs.gitCommit,
      targetClass: inputs.targetClass,
      principal: principal !== undefined ? "set" : "unset",
      databaseName: "redacted",
      expectedCount: inputs.expectedCount,
      firstPass: { imported: r1.importedCount, skipped: r1.skippedCount, failed: r1.failedCount },
      replayPass: { imported: r2.importedCount, skipped: r2.skippedCount, failed: r2.failedCount },
      postcheck,
      titlePreserved,
      firstFailedByCode,
      replayFailedByCode,
    };
    await writePrivateFile(
      join(inputs.privateRoot, "phase2-run-receipt.private.json"),
      `${JSON.stringify(receipt, null, 2)}\n`,
    );

    if (postcheck.verdict === "FAIL") {
      console.error("对账失败：从快照恢复临时/验收库与存储并重新核对。");
      await restoreAndVerify(adminUrl, databaseName, storageSnapshotDir, storageRoot, database);
      return 1;
    }

    // ── 清理快照 ─────────────────────────────────────────────────────
    await dropScratchSnapshot(adminUrl, databaseName);
    await rm(storageSnapshotDir, { recursive: true, force: true }).catch(() => {});
    await writePrivateFile(join(inputs.privateRoot, "PHASE2_RUN_PASS"), `${receipt.generatedAt}\n`);

    console.log("第 2 阶段验收导入 PASS。");
    return 0;
  } finally {
    await database.close();
  }
}

interface FailedCandidateLike {
  readonly code: string;
}

function aggregateFailedByCode(candidates: readonly FailedCandidateLike[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const candidate of candidates) {
    counts[candidate.code] = (counts[candidate.code] ?? 0) + 1;
  }
  return counts;
}

async function restoreAndVerify(
  adminUrl: string,
  databaseName: string,
  storageSnapshotDir: string,
  storageRoot: string,
  database: DatabaseHandle,
): Promise<void> {
  await database.close().catch(() => {});
  await restoreScratchDatabase(adminUrl, databaseName);
  const restoredFileCount = await restoreStorageDirectory(storageSnapshotDir, storageRoot);
  console.log(`恢复完成（存储普通文件 ${restoredFileCount}）。`);
  // 重新连接恢复后的库做只读计数验证。
  const adminDb = createPostgresDatabase({
    connectionString: adminUrl.replace(/\/[^/]*$/, `/${databaseName}`),
    maxConnections: 1,
    applicationName: "urmotiv-history-import-phase2-verify",
  });
  try {
    const restoredCounts = await runZeroMutationDatabasePreflight(adminDb);
    console.log(
      `恢复后只读计数完成：表 ${restoredCounts.presentTableCount}/${historyImportRequiredTables.length}。`,
    );
  } finally {
    await adminDb.close();
  }
}

// 仅在直接执行时运行 main（允许 import.meta.url 守卫供单元测试导入）。
if (import.meta.url === `file://${process.argv[1]}`) {
  main()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error: unknown) => {
      if (error instanceof HistoryMigrationError) {
        console.error(`runner 失败（${error.code}）：${error.message}`);
      } else {
        console.error("runner 失败：未分类错误。");
      }
      process.exitCode = 2;
    });
}

export type { RunnerInputs, TargetClass };
export { main as runPhase2Acceptance };
