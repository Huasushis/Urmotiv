/**
 * 历史导入预检 CLI：确定性对账 + 零数据库变更检查（第 2 阶段真实导入前的收尾核对）。
 * 只输出聚合计数与稳定状态码；绝不打印题号、题目名称、候选正文、私有路径或连接串。
 * 收据与通过标记写入明确指定的服务器私有目录。
 *
 * 用法（所有路径必须位于 --private-root 内）：
 *     --private-root=<服务器私有目录> \
 *     --list-metadata=<清单元数据 JSON> \
 *     --package-directory=<打包输出目录（report.json + packages/*.zip）> \
 *     --output-directory=<预检输出目录> \
 *     --expected-record-count=<权威清单记录数> \
 *     --database-url-env=<承载连接串的环境变量名> \
 *     [--import-manifest=<已有导入批次 manifest>] \
 *     [--grouping-file=<分组阶段私有清单 JSON>] \
 *     [--tag-id=<依赖标签标识>] \
 *     [--git-commit=<当前代码提交>] \
 *     [--target-class=scratch-temporary|designated-validation|designated-real] \
 *     [--principal-env=<存放执行主体标识的环境变量名>]
 *
 * --database-url-env 只给出环境变量名，连接串本身不出现在命令行、日志或收据中。
 * 数据库侧使用显式只读事务：任何写操作都会被数据库直接拒绝。
 * 退出码 0 = READY；任何不一致、缺表或只读开关不可用都会以 1 退出；参数错误为 2。
 */
import { join } from "node:path";
import { readdir } from "node:fs/promises";

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
import { sha256Hex } from "../src/history-migration/digests";
import {
  assertPathsInsidePrivateRoot,
  assertPrivateDirectoryMode,
  privateRegularFileExists,
  readPrivateJsonWithDigest,
  readPrivateRegularBytes,
  removePrivateRegularFile,
  writePrivateFile,
} from "../src/history-migration/private-files";

const allowedTargetClasses = ["scratch-temporary", "designated-validation", "designated-real"] as const;
type TargetClass = (typeof allowedTargetClasses)[number];

interface PreflightArguments {
  readonly privateRoot: string;
  readonly listMetadata: string;
  readonly packageDirectory: string;
  readonly outputDirectory: string;
  readonly expectedRecordCount: number;
  readonly databaseUrlEnv: string;
  readonly importManifest: string | undefined;
  readonly groupingFile: string | undefined;
  readonly tagId: string | undefined;
  readonly gitCommit: string | undefined;
  readonly targetClass: TargetClass | undefined;
  readonly principalEnv: string | undefined;
}

function parseArguments(argv: readonly string[]): PreflightArguments {
  const values = new Map<string, string>();
  for (const argument of argv) {
    const match = /^--([a-z-]+)=(.*)$/s.exec(argument);
    if (match === null) {
      throw new HistoryMigrationError("INVALID_ARGUMENTS", "预检参数必须是 --名称=值 形式。");
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
  const expectedRaw = required("expected-record-count");
  const expectedRecordCount = Number(expectedRaw);
  if (!Number.isInteger(expectedRecordCount) || expectedRecordCount < 1 || expectedRecordCount > 10_000) {
    throw new HistoryMigrationError("INVALID_ARGUMENTS", "expected-record-count 必须是 1 到 10000 的整数。");
  }
  const targetClassRaw = optional("target-class");
  let targetClass: TargetClass | undefined;
  if (targetClassRaw !== undefined) {
    if (!allowedTargetClasses.includes(targetClassRaw as TargetClass)) {
      throw new HistoryMigrationError(
        "INVALID_ARGUMENTS",
        "target-class 必须是 scratch-temporary、designated-validation 或 designated-real。",
      );
    }
    targetClass = targetClassRaw as TargetClass;
  }
  return {
    privateRoot: required("private-root"),
    listMetadata: required("list-metadata"),
    packageDirectory: required("package-directory"),
    outputDirectory: required("output-directory"),
    expectedRecordCount,
    databaseUrlEnv: required("database-url-env"),
    importManifest: optional("import-manifest"),
    groupingFile: optional("grouping-file"),
    tagId: optional("tag-id"),
    gitCommit: optional("git-commit"),
    targetClass,
    principalEnv: optional("principal-env"),
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
  if (args.groupingFile !== undefined) {
    pathChecks.push({ path: args.groupingFile, kind: "existing" });
  }
  await assertPathsInsidePrivateRoot(args.privateRoot, pathChecks);

  const metadata = (await readPrivateJsonWithDigest(args.listMetadata)).value;
  const report = (await readPrivateJsonWithDigest(join(args.packageDirectory, "report.json"))).value;
  const reportParsed = packageReportPayloadSchema.parse(report);

  // 逐包读取磁盘字节并核对：条目结构、字节数、摘要重算、未登记额外包。
  const entryNames: string[][] = [];
  let missingPackageFileCount = 0;
  let packageBytesMismatchCount = 0;
  let packageDigestMismatchCount = 0;
  const expectedPackageFiles = new Set<string>();
  for (const entry of reportParsed.packages) {
    const fileName = `${entry.candidateId}.zip`;
    expectedPackageFiles.add(fileName);
    const packagePath = join(args.packageDirectory, "packages", fileName);
    try {
      const bytes = await readPrivateRegularBytes(packagePath, maximumImportPackageBytes);
      const archive = readZipArchive(bytes);
      entryNames.push(archive.summary.entries.map((item) => item.path));
      if (bytes.byteLength !== entry.packageBytes) packageBytesMismatchCount += 1;
      if (sha256Hex(bytes) !== entry.packageSha256) packageDigestMismatchCount += 1;
    } catch {
      missingPackageFileCount += 1;
      entryNames.push([]);
    }
  }

  // 拒绝磁盘上存在但报告未登记的包文件。
  let unreportedExtraPackageCount = 0;
  const packagesDir = join(args.packageDirectory, "packages");
  let diskFiles: string[];
  try {
    diskFiles = await readdir(packagesDir);
  } catch {
    diskFiles = [];
  }
  for (const fileName of diskFiles) {
    if (fileName.endsWith(".zip") && !expectedPackageFiles.has(fileName)) {
      unreportedExtraPackageCount += 1;
    }
  }

  // 包条目检查缺失的包不得静默算作已核对：核对数量不足会在对账里判 NOT_READY。
  const contentSummary = summarizePackageEntryNames(entryNames);

  // 分组阶段私有清单：提供时读取安全编号列表，机械核对题号↔安全编号连接。
  let groupingMetadataIds: string[] | undefined;
  if (args.groupingFile !== undefined) {
    const groupingPayload = (await readPrivateJsonWithDigest(args.groupingFile)).value;
    if (
      typeof groupingPayload === "object" &&
      groupingPayload !== null &&
      "groups" in groupingPayload &&
      Array.isArray(groupingPayload.groups)
    ) {
      groupingMetadataIds = groupingPayload.groups
        .map((group) => (typeof group === "object" && group !== null && "metadataId" in group ? group.metadataId : undefined))
        .filter((id): id is string => typeof id === "string");
    }
  }

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
    packageBytesMismatchCount,
    packageDigestMismatchCount,
    unreportedExtraPackageCount,
    ...(groupingMetadataIds !== undefined ? { groupingMetadataIds } : {}),
  });

  // 数据库连接串只通过环境变量传入，命令行只接受变量名。
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
    databaseResult = await runZeroMutationDatabasePreflight(database, {
      ...(args.tagId !== undefined ? { requiredTagId: args.tagId } : {}),
    });
  } finally {
    await database.close();
  }

  // 执行主体标识只从环境变量读取，值只写入私有回执，不出现在 stdout。
  let principal: string | undefined;
  if (args.principalEnv !== undefined) {
    const principalValue = process.env[args.principalEnv];
    if (principalValue !== undefined && principalValue.length > 0) {
      principal = principalValue;
    }
  }

  const tagPresent = databaseResult.tagPresent === true;
  const tagSatisfied = args.tagId === undefined || tagPresent;

  const ready =
    reconciliation.verdict === "READY" &&
    databaseResult.readOnlyEnforced &&
    databaseResult.missingTableCount === 0 &&
    tagSatisfied;

  const receipt = {
    version: 1,
    generatedAt: new Date().toISOString(),
    gitCommit: args.gitCommit,
    targetClass: args.targetClass,
    principal: principal !== undefined ? "set" : "unset",
    reconciliation,
    packagesChecked: contentSummary.packagesChecked,
    packagesWithEmbeddedAttachments: contentSummary.packagesWithEmbeddedAttachments,
    missingPackageFileCount,
    packageBytesMismatchCount,
    packageDigestMismatchCount,
    unreportedExtraPackageCount,
    database: {
      serverVersion: databaseResult.serverVersion,
      readOnlyEnforced: databaseResult.readOnlyEnforced,
      presentTableCount: databaseResult.presentTableCount,
      missingTableCount: databaseResult.missingTableCount,
      requiredTableCount: historyImportRequiredTables.length,
      rowCounts: databaseResult.rowCounts,
      tagId: args.tagId,
      tagPresent: databaseResult.tagPresent,
    },
    tagSatisfied,
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

  // stdout 只输出聚合计数与稳定原因码，绝不输出题号、题名、摘要或路径。
  console.log(`预检清单记录数: ${reconciliation.listRecordCount}`);
  console.log(`预检包数量: ${reconciliation.packageCount}`);
  console.log(`预检保留材料数: ${reconciliation.preservedMaterialCount}`);
  console.log(`预检内嵌附件数: ${reconciliation.embeddedAttachmentCount}`);
  console.log(`结构性缺失基础题解的包数: ${reconciliation.missingBasicSolutionCount}`);
  console.log(`缺失包文件数: ${missingPackageFileCount}`);
  console.log(`包字节数不一致: ${packageBytesMismatchCount}`);
  console.log(`包摘要不一致: ${packageDigestMismatchCount}`);
  console.log(`未登记额外包: ${unreportedExtraPackageCount}`);
  console.log(`批次身份一致: ${reconciliation.batchIdentityMatches ? "是" : "否"}`);
  if (reconciliation.groupingJoin !== undefined) {
    console.log(`分组连接匹配: ${reconciliation.groupingJoin.matchedIdentityCount}/${reconciliation.groupingJoin.groupingIdentityCount}`);
    console.log(`分组连接重复: ${reconciliation.groupingJoin.duplicateIdentityCount}`);
  }
  console.log(`数据库只读开关已验证: ${databaseResult.readOnlyEnforced ? "是" : "否"}`);
  console.log(
    `数据库必需表存在: ${databaseResult.presentTableCount}/${historyImportRequiredTables.length}`,
  );
  if (args.tagId !== undefined) {
    console.log(`标签依赖存在: ${databaseResult.tagPresent === true ? "是" : "否"}`);
  }
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
