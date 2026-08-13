/**
 * 历史导入第 1 阶段预检 CLI：确定性对账 + 零数据库变更检查（第 2 阶段真实
 * 导入前的收尾核对）。只输出聚合计数与稳定状态码；绝不打印题号、题目名称、
 * 候选正文、私有路径或连接串。收据与通过标记写入明确指定的服务器私有目录。
 *
 * 用法（所有路径必须位于 --private-root 内）：
 *   tsx scripts/preflight-history-import.ts \
 *     --private-root=<服务器私有目录> \
 *     --list-metadata=<清单元数据 JSON> \
 *     --package-directory=<打包输出目录（report.json + packages/*.zip）> \
 *     --output-directory=<预检输出目录> \
 *     --expected-record-count=<权威清单记录数> \
 *     --database-url-env=<承载连接串的环境变量名> \
 *     [--import-manifest=<已有导入批次 manifest>]
 *
 * --database-url-env 只给出环境变量名，连接串本身不出现在命令行、日志或
 * 收据中。数据库侧使用显式只读事务：任何写操作都会被数据库直接拒绝。
 * 退出码 0 = READY；任何不一致、缺表或只读开关不可用都会以 1 退出。
 */
import { join } from "node:path";

import { createPostgresDatabase } from "@urmotiv/database";
import { readZipArchive } from "@urmotiv/problem-package";

import { HistoryMigrationError } from "../src/history-migration/errors";
import {
  maximumImportPackageBytes,
  packageReportPayloadSchema,
} from "../src/history-migration/import-phase";
import {
  historyImportRequiredTables,
  reconcileHistoryImportBatch,
  runZeroMutationDatabasePreflight,
  summarizePackageEntryNames,
  type HistoryImportReconciliation,
  type ZeroMutationDatabaseResult,
} from "../src/history-migration/import-preflight";
import {
  assertPathsInsidePrivateRoot,
  assertPrivateDirectoryMode,
  privateRegularFileExists,
  readPrivateJsonWithDigest,
  readPrivateRegularBytes,
  removePrivateRegularFile,
  writePrivateFile,
} from "../src/history-migration/private-files";

interface PreflightArguments {
  readonly privateRoot: string;
  readonly listMetadata: string;
  readonly packageDirectory: string;
  readonly outputDirectory: string;
  readonly expectedRecordCount: number;
  readonly databaseUrlEnv: string;
  readonly importManifest: string | undefined;
}

function parseArguments(argv: readonly string[]): PreflightArguments {
  const values = new Map<string, string>();
  for (const argument of argv) {
    const match = /^--([a-z-]+)=(.*)$/s.exec(argument);
    if (match === null) {
      throw new HistoryMigrationError("INVALID_ARGUMENTS", "预检参数必须是 --名称=值 形式。");
    }
    values.set(match[1], match[2]);
  }
  const required = (name: string): string => {
    const value = values.get(name);
    if (value === undefined || value.length === 0) {
      throw new HistoryMigrationError("INVALID_ARGUMENTS", `缺少必填参数 ${name}。`);
    }
    return value;
  };
  const expectedRaw = required("expected-record-count");
  const expectedRecordCount = Number(expectedRaw);
  if (!Number.isInteger(expectedRecordCount) || expectedRecordCount < 1 || expectedRecordCount > 10_000) {
    throw new HistoryMigrationError("INVALID_ARGUMENTS", "expected-record-count 必须是 1 到 10000 的整数。");
  }
  const importManifest = values.get("import-manifest");
  return {
    privateRoot: required("private-root"),
    listMetadata: required("list-metadata"),
    packageDirectory: required("package-directory"),
    outputDirectory: required("output-directory"),
    expectedRecordCount,
    databaseUrlEnv: required("database-url-env"),
    importManifest: importManifest === undefined || importManifest.length === 0 ? undefined : importManifest,
  };
}

const preflightReceiptName = "history-import-preflight.private.json";
const preflightPassMarkerName = "PREFLIGHT_PASS";

async function main(): Promise<number> {
  const args = parseArguments(process.argv.slice(2));
  await assertPrivateDirectoryMode(args.privateRoot);
  const pathChecks: { path: string; kind: "existing" | "new" }[] = [
    { path: args.listMetadata, kind: "existing" },
    { path: args.packageDirectory, kind: "existing" },
    { path: args.outputDirectory, kind: "existing" },
    { path: join(args.outputDirectory, preflightReceiptName), kind: "new" },
    { path: join(args.outputDirectory, preflightPassMarkerName), kind: "new" },
  ];
  if (args.importManifest !== undefined) {
    pathChecks.push({ path: args.importManifest, kind: "existing" });
  }
  await assertPathsInsidePrivateRoot(args.privateRoot, pathChecks);

  const metadata = (await readPrivateJsonWithDigest(args.listMetadata)).value;
  const report = (await readPrivateJsonWithDigest(join(args.packageDirectory, "report.json"))).value;
  const reportParsed = packageReportPayloadSchema.parse(report);

  const entryNames: string[][] = [];
  let missingPackageFileCount = 0;
  for (const entry of reportParsed.packages) {
    const packagePath = join(args.packageDirectory, "packages", `${entry.candidateId}.zip`);
    try {
      const bytes = await readPrivateRegularBytes(packagePath, maximumImportPackageBytes);
      const archive = readZipArchive(bytes);
      entryNames.push(archive.summary.entries.map((item) => item.path));
    } catch {
      missingPackageFileCount += 1;
      entryNames.push([]);
    }
  }
  // 包条目检查缺失的包不得静默算作已核对：核对数量不足会在对账里判 NOT_READY。
  const contentSummary = summarizePackageEntryNames(entryNames);

  let manifest: unknown;
  if (args.importManifest !== undefined) {
    manifest = (await readPrivateJsonWithDigest(args.importManifest)).value;
  }

  const reconciliation: HistoryImportReconciliation = reconcileHistoryImportBatch({
    listMetadata: metadata,
    packageReport: report,
    packageEntryNames: entryNames,
    expectedRecordCount: args.expectedRecordCount,
    importManifest: manifest,
    missingPackageFileCount,
  });

  const databaseUrl = process.env[args.databaseUrlEnv];
  if (databaseUrl === undefined || databaseUrl.trim().length === 0) {
    throw new HistoryMigrationError(
      "INVALID_ARGUMENTS",
      "数据库连接串环境变量未设置；预检不会发起真实导入。",
    );
  }
  const database = createPostgresDatabase({ connectionString: databaseUrl, maxConnections: 1 });
  let databaseResult: ZeroMutationDatabaseResult;
  try {
    databaseResult = await runZeroMutationDatabasePreflight(database);
  } finally {
    await database.close();
  }

  const ready =
    reconciliation.verdict === "READY" &&
    databaseResult.readOnlyEnforced &&
    databaseResult.missingTableCount === 0;
  const receipt = {
    version: 1,
    generatedAt: new Date().toISOString(),
    reconciliation,
    packagesChecked: contentSummary.packagesChecked,
    packagesWithEmbeddedAttachments: contentSummary.packagesWithEmbeddedAttachments,
    missingPackageFileCount,
    database: {
      serverVersion: databaseResult.serverVersion,
      readOnlyEnforced: databaseResult.readOnlyEnforced,
      presentTableCount: databaseResult.presentTableCount,
      missingTableCount: databaseResult.missingTableCount,
      requiredTableCount: historyImportRequiredTables.length,
      rowCounts: databaseResult.rowCounts,
    },
    verdict: ready ? "READY" : "NOT_READY",
  };
  await writePrivateFile(
    join(args.outputDirectory, preflightReceiptName),
    `${JSON.stringify(receipt, null, 2)}\n`,
  );
  const markerPath = join(args.outputDirectory, preflightPassMarkerName);
  if (ready) {
    await writePrivateFile(markerPath, `${receipt.generatedAt}\n`);
  } else if (await privateRegularFileExists(markerPath)) {
    await removePrivateRegularFile(markerPath);
  }

  console.log(`预检清单记录数: ${reconciliation.listRecordCount}`);
  console.log(`预检包数量: ${reconciliation.packageCount}`);
  console.log(`预检保留材料数: ${reconciliation.preservedMaterialCount}`);
  console.log(`预检内嵌附件数: ${reconciliation.embeddedAttachmentCount}`);
  console.log(`结构性缺失基础题解的包数: ${reconciliation.missingBasicSolutionCount}`);
  console.log(`缺失包文件数: ${missingPackageFileCount}`);
  console.log(`数据库只读开关已验证: ${databaseResult.readOnlyEnforced ? "是" : "否"}`);
  console.log(
    `数据库必需表存在: ${databaseResult.presentTableCount}/${historyImportRequiredTables.length}`,
  );
  if (reconciliation.reasonCodes.length > 0) {
    console.log(`不一致原因码: ${reconciliation.reasonCodes.join(", ")}`);
  }
  console.log(`预检结论: ${receipt.verdict}`);
  return ready ? 0 : 1;
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error: unknown) => {
    if (error instanceof HistoryMigrationError) {
      console.error(`预检失败（${error.code}）：${error.message}`);
    } else {
      console.error("预检失败：未分类错误。");
    }
    process.exitCode = 2;
  });
