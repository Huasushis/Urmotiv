import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { access, chmod, mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { connect, createServer, type Socket } from "node:net";
import { spawnSync } from "node:child_process";

import { sql } from "drizzle-orm";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import {
  createPostgresDatabase,
  migrateDatabase,
  seedCoreDatabase,
  type DatabaseHandle,
} from "@urmotiv/database";
import { createFileStorage, type FileStorage } from "@urmotiv/storage";
import {
  urmotivNativeAdapter,
  writeZipArchive,
  type CanonicalProblem,
} from "@urmotiv/problem-package";

import {
  preflightPassMarkerName,
  preflightReceiptName,
  runHistoryImportPreflight,
  type HistoryImportPreflightHooks,
} from "../scripts/preflight-history-import";
import {
  completeFormalFinalizationCleanup,
  computeFormalAdminFingerprintSha256,
  computeFormalTargetFingerprintSha256,
  computeStorageRootIdentitySha256,
  formalBackupVerifiedMarkerName,
  formalCleanupPendingEvidenceName,
  formalPassMarkerName,
  formalReceiptName,
  formalRetiredPassReceiptName,
  formalRetiredPassMarkerName,
  formalPassRetirementEvidenceName,
  formalRestoreRefusedMarkerName,
  formalRollbackVerifiedMarkerName,
  parsePostgresIdentity,
  runFormalImport,
  runFormalImportBound,
} from "../scripts/run-formal-import";
import { readFormalRecoveryState } from "../src/history-migration/formal-recovery-state";
import {
  completePhase2TerminalCleanup,
  runPhase2Bound,
  type Phase2RunnerHooks,
} from "../scripts/run-real-import";
import { databaseDemoUserIds, seedDatabaseDemoData } from "../src/database-demo";
import {
  prepareHistoryCandidates,
  verifyApprovedPackageSourceIdentities,
  type HistoryNormalizer,
} from "../src/history-migration/core";
import { sha256Hex } from "../src/history-migration/digests";
import { captureLiveMaintenanceIdentity } from "../src/history-migration/live-maintenance-identity";
import {
  dropHistoryImportDatabase,
  historyImportDatabaseConnectionString,
  packageReportPayloadSchema,
  prepareHistoryImportDatabase,
} from "../src/history-migration/import-phase";
import {
  historyImportRequiredTables,
  recomputePackageBatchIdentity,
  recomputeSourceBindingsIdentity,
} from "../src/history-migration/import-preflight";
import {
  permittedPhase2EvidenceRoot,
  type ExecutionProvenance,
} from "../src/history-migration/execution-provenance";
import {
  captureDatabaseContentInventory,
  captureStorageInventory,
  dropScratchSnapshot,
  restoreStorageDirectory,
  snapshotScratchDatabase,
} from "../src/history-migration/history-import-snapshot";
import {
  captureHistoryImportTableCounts,
  captureStoredFileInventory,
  expectedTableDeltas,
  type HistoryImportCountRow,
} from "../src/history-migration/phase2-postcheck";
// 不再需要 registerOwnedDatabase——隔离集群方案中子进程在一次性容器内
// 自由创建/删除数据库，父进程拆除整个容器即可。无需逐库登记。
const adminUrl = process.env.URMOTIV_TEST_POSTGRES_ADMIN_URL;
const acceptanceMode = process.env.URMOTIV_PHASE2_RUNNER_ACCEPTANCE === "1";
const acceptanceCommit = process.env.URMOTIV_PHASE2_ACCEPTANCE_COMMIT;
const describePostgres = adminUrl === undefined && !acceptanceMode ? describe.skip : describe;
// 从 adminUrl 解析主集群端口——不再硬编码 5434。
const primaryPort = adminUrl !== undefined ? parseInt(new URL(adminUrl).port, 10) : 5434;
const temporaryDirectories: string[] = [];
const temporaryDatabaseNames: string[] = [];
function registerDatabase(name: string): void {
  temporaryDatabaseNames.push(name);
}
// 独立于 temporaryDatabaseNames 的持久失败标记。
// 即使后续 afterEach 成功删除了残留库并清空了列表，
// 此标记仍保持 true，确保 afterAll 报告失败。
let cleanupEverFailed = false;
const encoder = new TextEncoder();
const tagId = "catalog.tag.01.01";
const evidenceRoot = permittedPhase2EvidenceRoot();

interface SyntheticBatch {
  readonly root: string;
  readonly packageDirectory: string;
  readonly listMetadata: string;
  readonly groupingFile: string;
  readonly materializedDirectory: string;
  readonly preparedDirectory: string;
  readonly approvalFile: string;
  readonly preflightOutput: string;
  readonly runnerReceiptDirectory: string;
  readonly storageRoot: string;
  readonly importOutputDirectory: string;
  readonly report: ReturnType<typeof packageReportPayloadSchema.parse>;
}

function scratchName(label: string): string {
  const runToken = process.env.URMOTIV_TEST_RUN_TOKEN;
  const idPart =
    runToken !== undefined && runToken.length > 0
      ? runToken
      : `${process.pid}${randomUUID().replaceAll("-", "").slice(0, 8)}`;
  const suffix = `${label}${idPart}`.slice(0, 57);
  return `urmotiv_history_import_${suffix}`;
}
function formalDbName(label: string): string {
  const runToken = process.env.URMOTIV_TEST_RUN_TOKEN;
  const idPart =
    runToken !== undefined && runToken.length > 0
      ? runToken
      : `${process.pid}${randomUUID().replaceAll("-", "").slice(0, 8)}`;
  return `urmotiv_formal_${label}_${idPart}`;
}

function candidateIdForSource(index: number): string {
  return `candidate-${String((index - 1) * 30 + 1).padStart(6, "0")}`;
}

async function privateDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  await chmod(path, 0o700);
}

async function privateFile(path: string, content: string | Uint8Array): Promise<void> {
  await writeFile(path, content, { mode: 0o600 });
  await chmod(path, 0o600);
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function assertNode24(): void {
  if (process.versions.node.split(".")[0] !== "24") {
    throw new Error("Phase-2 PostgreSQL 验收必须使用 Node 24。");
  }
}

// 例外：等待真实 PostgreSQL 容器的平台就绪，只有进程外探测可判定，
// 无法用假定时器驱动。
function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

interface TcpProxyHandle {
  readonly url: string;
  setTarget(port: number): void;
  setTarget(host: string, port: number): void;
  stop(): Promise<void>;
}

/**
 * 启动 TCP 代理：连接串文本不变，只有代理背后的真实端点被改指。
 * 密码和主机从 adminUrl 解析——不再硬编码 test-password/127.0.0.1:5434。
 */
async function startTcpProxy(initialTargetPort: number): Promise<TcpProxyHandle> {
  const adminUrl = process.env.URMOTIV_TEST_POSTGRES_ADMIN_URL;
  if (adminUrl === undefined) {
    throw new Error("活身份代理需要 URMOTIV_TEST_POSTGRES_ADMIN_URL。");
  }
  const parsed = new URL(adminUrl);
  const proxyPassword = decodeURIComponent(parsed.password);
  const proxyHost = parsed.hostname;
  let targetHost = proxyHost;
  let targetPort = initialTargetPort;
  const clients = new Set<Socket>();
  const upstreams = new Set<Socket>();
  const proxy = createServer((client) => {
    clients.add(client);
    const upstream = connect({ host: targetHost, port: targetPort });
    upstreams.add(upstream);
    const teardown = (): void => {
      client.destroy();
      upstream.destroy();
      clients.delete(client);
      upstreams.delete(upstream);
    };
    // 双端关闭联动：应用侧断开（含突然销毁）必须同步切断上游，
    // 否则代理进程退场后仍有半开套接字把 PostgreSQL 后端会话钉在
    // "idle" 状态，阻塞之后的 DROP DATABASE（55006）。
    client.on("close", () => {
      upstream.destroy();
      clients.delete(client);
      upstreams.delete(upstream);
    });
    upstream.on("close", () => teardown());
    client.on("error", () => teardown());
    upstream.on("error", () => teardown());
    client.pipe(upstream);
    upstream.pipe(client);
  });
  await new Promise<void>((resolve, reject) => {
    proxy.once("error", reject);
    proxy.listen(0, proxyHost, () => resolve());
  });
  const address = proxy.address();
  if (typeof address === "string" || address === null) {
    throw new Error("活身份代理端口不可用。");
  }
  return {
    url: `postgres://postgres:${encodeURIComponent(proxyPassword)}@${proxyHost}:${address.port}/postgres`,
    setTarget(portOrHost: number | string, port?: number) {
      if (typeof portOrHost === "string" && typeof port === "number") {
        targetHost = portOrHost;
        targetPort = port;
      } else if (typeof portOrHost === "number") {
        targetPort = portOrHost;
      }
    },
    async stop() {
      for (const socket of clients) socket.destroy();
      for (const socket of upstreams) socket.destroy();
      await new Promise<void>((resolve) => proxy.close(() => resolve()));
    },
  };
}

async function postgresReady(connectionString: string, attempts: number): Promise<boolean> {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const probe = createPostgresDatabase({
        connectionString,
        maxConnections: 1,
        applicationName: "urmotiv-live-identity-probe",
      });
      await probe.query(sql`select 1 as one`);
      await probe.close();
      return true;
    } catch {
      await sleep(500);
    }
  }
  return false;
}

async function freePort(): Promise<number> {
  const reservation = createServer();
  await new Promise<void>((resolve, reject) => {
    reservation.once("error", reject);
    reservation.listen(0, "127.0.0.1", () => resolve());
  });
  const address = reservation.address();
  if (typeof address === "string" || address === null) throw new Error("无法分配活身份端口。");
  const port = address.port;
  await new Promise<void>((resolve) => reservation.close(() => resolve()));
  return port;
}

/**
 * 从 secondCluster.url 解析次集群的主机名和端口。
 * 用于 TCP 代理改指到次集群。
 */
function parseClusterEndpoint(url: string): { host: string; port: number } {
  const parsed = new URL(url);
  return { host: parsed.hostname, port: parseInt(parsed.port, 10) || 5432 };
}

/**
 * 获取第二集群：如果父进程提供了 URMOTIV_TEST_SECONDARY_PG_URL，直接使用
 * （gate9 隔离模式——子进程无 Docker 权限）。否则自行创建 Docker 容器
 * （独立运行模式——需要 Docker 访问权限）。
 */
function startSecondCluster(containerName: string, port: number): { url: string; stop(): void } {
  const secondaryUrl = process.env.URMOTIV_TEST_SECONDARY_PG_URL;
  if (secondaryUrl !== undefined) {
    // 父进程已创建次集群——子进程只使用 URL，不调用 docker。
    return {
      url: secondaryUrl,
      stop() {
        // 无操作——父进程负责拆除。
      },
    };
  }
  // 独立运行模式：自行创建 Docker 容器。
  spawnSync("docker", ["rm", "-f", containerName], { encoding: "utf8" });
  const image =
    process.env.URMOTIV_LIVEIDENT_PG_IMAGE ?? "docker.m.daocloud.io/library/postgres:17-alpine";
  const run = spawnSync(
    "docker",
    ["run", "-d", "--rm", "--name", containerName, "-p", `127.0.0.1:${String(port)}:5432`,
      "-e", "POSTGRES_USER=postgres", "-e", "POSTGRES_PASSWORD=test-password",
      "-e", "POSTGRES_DB=postgres", image],
    { encoding: "utf8" },
  );
  if (run.status !== 0) {
    throw new Error(`无法启动第二活身份集群（docker 不可用或冲突）。${run.stderr}`);
  }
  return {
    url: `postgres://postgres:test-password@127.0.0.1:${String(port)}/postgres`,
    stop() {
      spawnSync("docker", ["rm", "-f", containerName], { encoding: "utf8" });
    },
  };
}

function canonicalProblem(index: number): CanonicalProblem {
  const hasAttachment = index <= 38;
  return {
    title: `合成验收题目 ${index}`,
    type: "traditional",
    tags: [],
    difficulty: {},
    content: {
      basicStatement: `# 合成验收题目 ${index}\n\n仅用于自动化验证。`,
      basicSolution: index <= 7 ? null : index === 8 ? "" : `合成题解 ${index}`,
      background: "",
      statement: "",
      inputFormat: "",
      outputFormat: "",
      constraints: "",
      solution: "",
      hints: "",
    },
    samples: index <= 15
      ? [{ input: `${index}\n`, output: `${index}\n`, explanation: "合成样例" }]
      : [],
    files: hasAttachment
      ? [{
          path: `attachments/public/synthetic-${index}.txt`,
          category: "public_attachment",
          content: encoder.encode(`synthetic-attachment-${index}`),
        }]
      : [],
    provenance: { sourceSystem: "ustc-history-private" },
    extensions: {},
  };
}

function syntheticNormalizer(): HistoryNormalizer {
  return {
    async normalize({ sourceId }) {
      const index = Number(sourceId.slice("source-".length));
      const problem = canonicalProblem(index);
      return {
        problems: [{
          title: problem.title,
          type: problem.type,
          basicStatement: problem.content.basicStatement,
          basicSolution: problem.content.basicSolution,
          background: problem.content.background,
          statement: problem.content.statement,
          inputFormat: problem.content.inputFormat,
          outputFormat: problem.content.outputFormat,
          constraints: problem.content.constraints,
          solution: problem.content.solution,
          hints: problem.content.hints,
          samples: problem.samples,
          tags: [],
          confidence: 1,
          migrationNote: "synthetic-phase2-acceptance",
        }],
      };
    },
  };
}

async function writeSyntheticMaterialization(
  materializedDirectory: string,
  metadataFileSha256: string,
  count: number,
): Promise<void> {
  const sourceDirectory = join(materializedDirectory, "sources");
  await privateDirectory(sourceDirectory);
  const mappings = [];
  const sources = [];
  const sourceSet = [];
  for (let index = 1; index <= count; index += 1) {
    const sourceId = `source-${String(index).padStart(6, "0")}`;
    const sourcePath = `synthetic-source-${String(index).padStart(6, "0")}.md`;
    const sourceText = `synthetic source body ${index}`;
    const sourceBytes = encoder.encode(sourceText);
    const sourceSha256 = sha256Hex(sourceBytes);
    await privateFile(join(sourceDirectory, sourcePath), sourceBytes);
    mappings.push({
      sourcePath,
      sourceSha256,
      metadataNumber: String(index),
    });
    sources.push({
      groupId: `group-${String(index).padStart(6, "0")}`,
      sourceId,
      sourceSha256,
      fragmentCount: 1,
      byteLength: sourceBytes.byteLength,
      characterCount: sourceText.length,
      status: "ready_for_prepare",
    });
    sourceSet.push({ sourceId, sourceSha256, byteLength: sourceBytes.byteLength });
  }
  const sourceConfirmation = {
    version: 1,
    confirmed: true,
    metadataFileSha256,
    mappings,
  };
  const groupingBatchSha256 = sha256Hex("synthetic-phase2-grouping");
  const report = {
    version: 2,
    phase: "materialize",
    sourceInventorySha256: sha256Hex("synthetic-phase2-source-inventory"),
    groupingBatchSha256,
    fragmentCount: count,
    sourceCount: count,
    unresolvedItemCount: 0,
    sources,
  };
  const marker = {
    version: 2,
    phase: "materialize",
    reportSha256: sha256Hex(JSON.stringify(report)),
    sourceConfirmationSha256: sha256Hex(JSON.stringify(sourceConfirmation)),
    sourceSetSha256: sha256Hex(JSON.stringify({ version: 1, sources: sourceSet })),
    groupingBatchSha256,
    sourceCount: count,
    fragmentCount: count,
    unresolvedItemCount: 0,
  };
  await privateFile(
    join(materializedDirectory, "source-confirmation.private.json"),
    `${JSON.stringify(sourceConfirmation, null, 2)}\n`,
  );
  await privateFile(join(materializedDirectory, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
  await privateFile(
    join(materializedDirectory, "MATERIALIZE_COMPLETE"),
    `${JSON.stringify(marker, null, 2)}\n`,
  );
}

async function createSyntheticBatch(count: number): Promise<SyntheticBatch> {
  await privateDirectory(evidenceRoot);
  const root = join(evidenceRoot, `runner-${process.pid}-${randomUUID()}`);
  temporaryDirectories.push(root);
  await privateDirectory(root);
  const materializedDirectory = join(root, "materialized");
  const preparedDirectory = join(root, "prepared");
  const packageDirectory = join(root, "package-output");
  const packageFilesDirectory = join(packageDirectory, "packages");
  const preflightOutput = join(root, "preflight");
  const runnerReceiptDirectory = join(root, "runner");
  const storageRoot = join(root, "storage");
  const importOutputDirectory = join(root, "import-output");
  await Promise.all([
    privateDirectory(materializedDirectory),
    privateDirectory(packageFilesDirectory),
    privateDirectory(preflightOutput),
    privateDirectory(runnerReceiptDirectory),
    privateDirectory(storageRoot),
  ]);

  const listMetadata = join(root, "list-metadata.json");
  const metadata = {
    records: Array.from({ length: count }, (_unused, index) => ({
      number: String(index + 1),
      name: `合成元数据 ${index + 1}`,
      authorStudentId: `SYNTHETIC-${String(index + 1).padStart(6, "0")}`,
      status: "",
      contest: "",
      note: "",
    })),
  };
  const metadataText = `${JSON.stringify(metadata, null, 2)}\n`;
  await privateFile(listMetadata, metadataText);
  await writeSyntheticMaterialization(
    materializedDirectory,
    sha256Hex(metadataText),
    count,
  );
  await prepareHistoryCandidates({
    privateRootDirectory: evidenceRoot,
    sourceDirectory: join(materializedDirectory, "sources"),
    metadataFile: listMetadata,
    sourceConfirmationFile: join(materializedDirectory, "source-confirmation.private.json"),
    outputDirectory: preparedDirectory,
    normalizer: syntheticNormalizer(),
    operationTag: `phase2-${randomUUID()}`,
    executionIdentity: {
      version: 1,
      codeSha256: sha256Hex("synthetic-normalizer-code"),
      promptSha256: sha256Hex("synthetic-normalizer-prompt"),
      modelSha256: sha256Hex("synthetic-normalizer-model"),
      configSha256: sha256Hex("synthetic-normalizer-config"),
    },
  });

  const approvals = [];
  for (let index = 1; index <= count; index += 1) {
    const candidateId = candidateIdForSource(index);
    const candidate = JSON.parse(
      await readFile(join(preparedDirectory, "candidates", `${candidateId}.json`), "utf8"),
    ) as { readonly contentSha256: string };
    approvals.push({ candidateId, contentSha256: candidate.contentSha256, decision: "approved" });
  }
  const approvalFile = join(root, "candidate-approval.private.json");
  await privateFile(
    approvalFile,
    `${JSON.stringify({ version: 1, confirmed: true, approvals }, null, 2)}\n`,
  );
  const authoritative = await verifyApprovedPackageSourceIdentities({
    privateRootDirectory: evidenceRoot,
    materializedDirectory,
    metadataFile: listMetadata,
    preparedDirectory,
    approvalFile,
  });

  const entries = [];
  for (let index = 1; index <= count; index += 1) {
    const identity = authoritative[index - 1];
    if (identity === undefined) throw new Error("synthetic authoritative identity missing");
    const problem = canonicalProblem(index);
    const generated = await urmotivNativeAdapter.export(problem, {});
    if (generated.kind === "single_file") throw new Error("原生适配器必须生成 ZIP。");
    const packageBytes = writeZipArchive(generated.files, { allowNestedArchives: true });
    await privateFile(join(packageFilesDirectory, `${identity.candidateId}.zip`), packageBytes);
    const attachment = problem.files[0];
    entries.push({
      candidateId: identity.candidateId,
      contentSha256: identity.contentSha256,
      sourceBindingSha256: identity.sourceBindingSha256,
      packageSha256: sha256Hex(packageBytes),
      packageBytes: packageBytes.byteLength,
      status: "packaged" as const,
      attachments: attachment === undefined
        ? []
        : [{
            attachmentId: `synthetic-attachment-${index}`,
            contentSha256: sha256Hex(attachment.content),
            semanticRole: "statement_support",
            visibility: "public",
            targetPath: attachment.path,
          }],
    });
  }
  const draft = packageReportPayloadSchema.parse({
    version: 1,
    phase: "package",
    batchSha256: "0".repeat(64),
    packageCount: count,
    packages: entries,
    attachmentCount: Math.min(count, 38),
    preservedMaterialCount: 0,
    preservedMaterials: [],
  });
  const report = packageReportPayloadSchema.parse({
    ...draft,
    batchSha256: recomputePackageBatchIdentity(draft),
  });
  await privateFile(join(packageDirectory, "report.json"), `${JSON.stringify(report)}\n`);
  await privateFile(
    join(packageDirectory, "PACKAGE_COMPLETE"),
    `${JSON.stringify({ version: 1, phase: "package", packageCount: count })}\n`,
  );

  const groupingFile = join(root, "grouping.json");
  await privateFile(
    groupingFile,
    `${JSON.stringify({
      groups: Array.from({ length: count }, (_unused, index) => ({
        metadataId: `M-${String(index + 1).padStart(7, "0")}`,
      })),
    })}\n`,
  );
  return {
    root,
    packageDirectory,
    listMetadata,
    groupingFile,
    materializedDirectory,
    preparedDirectory,
    approvalFile,
    preflightOutput,
    runnerReceiptDirectory,
    storageRoot,
    importOutputDirectory,
    report,
  };
}

function preflightArguments(): string[] {
  return [
    "--private-root-env=PRIVATE_ROOT",
    "--list-metadata-env=LIST_METADATA",
    "--package-directory-env=PACKAGE_DIRECTORY",
    "--output-directory-env=PREFLIGHT_OUTPUT",
    "--materialized-directory-env=MATERIALIZED_DIRECTORY",
    "--prepared-directory-env=PREPARED_DIRECTORY",
    "--approval-file-env=APPROVAL_FILE",
    "--database-url-env=DATABASE_URL",
    "--grouping-file-env=GROUPING_FILE",
    "--tag-id-env=TAG_ID",
    "--git-commit-env=GIT_COMMIT",
    "--target-class-env=TARGET_CLASS",
    "--principal-env=PRINCIPAL",
    "--execution-id-env=EXECUTION_ID",
    "--batch-sha256-env=BATCH_SHA256",
    "--source-bindings-sha256-env=SOURCE_BINDINGS_SHA256",
  ];
}

function runnerArguments(): string[] {
  return [
    "--private-root-env=PRIVATE_ROOT",
    "--package-directory-env=PACKAGE_DIRECTORY",
    "--list-metadata-env=LIST_METADATA",
    "--grouping-file-env=GROUPING_FILE",
    "--materialized-directory-env=MATERIALIZED_DIRECTORY",
    "--prepared-directory-env=PREPARED_DIRECTORY",
    "--approval-file-env=APPROVAL_FILE",
    "--preflight-receipt-env=PREFLIGHT_RECEIPT",
    "--receipt-directory-env=RECEIPT_DIRECTORY",
    "--storage-root-env=STORAGE_ROOT",
    "--import-output-directory-env=IMPORT_OUTPUT_DIRECTORY",
    "--admin-url-env=ADMIN_URL",
    "--db-name-env=DATABASE_NAME",
    "--principal-env=PRINCIPAL",
    "--tag-id-env=TAG_ID",
    "--git-commit-env=GIT_COMMIT",
    "--batch-sha256-env=BATCH_SHA256",
    "--source-bindings-sha256-env=SOURCE_BINDINGS_SHA256",
    "--preflight-receipt-sha256-env=PREFLIGHT_RECEIPT_SHA256",
    "--execution-id-env=EXECUTION_ID",
    "--target-class-env=TARGET_CLASS",
  ];
}

function formalArguments(): string[] {
  return [
    "--private-root-env=PRIVATE_ROOT",
    "--package-directory-env=PACKAGE_DIRECTORY",
    "--list-metadata-env=LIST_METADATA",
    "--grouping-file-env=GROUPING_FILE",
    "--materialized-directory-env=MATERIALIZED_DIRECTORY",
    "--prepared-directory-env=PREPARED_DIRECTORY",
    "--approval-file-env=APPROVAL_FILE",
    "--preflight-receipt-env=PREFLIGHT_RECEIPT",
    "--phase2-receipt-env=PHASE2_RECEIPT",
    "--target-approval-env=TARGET_APPROVAL",
    "--output-directory-env=FORMAL_OUTPUT",
    "--storage-root-env=STORAGE_ROOT",
    "--import-output-directory-env=IMPORT_OUTPUT_DIRECTORY",
    "--database-url-env=DATABASE_URL",
    "--admin-url-env=ADMIN_URL",
    "--principal-env=PRINCIPAL",
    "--tag-id-env=TAG_ID",
    "--git-commit-env=GIT_COMMIT",
    "--execution-id-env=EXECUTION_ID",
    "--target-class-env=TARGET_CLASS",
    "--batch-sha256-env=BATCH_SHA256",
    "--source-bindings-sha256-env=SOURCE_BINDINGS_SHA256",
  ];
}

async function formalEnvironment(
  batch: SyntheticBatch,
  databaseUrl: string,
  adminUrlValue: string,
  targetApprovalFile: string,
  outputDirectory: string,
  storageRoot: string,
  importOutputDirectory: string,
  executionId: string,
): Promise<NodeJS.ProcessEnv> {
  const base = await approvedEnvironment(batch, databaseUrl, executionId);
  return {
    ...base,
    PREFLIGHT_RECEIPT: join(batch.preflightOutput, preflightReceiptName),
    PHASE2_RECEIPT: join(batch.runnerReceiptDirectory, "phase2-run-receipt.private.json"),
    TARGET_APPROVAL: targetApprovalFile,
    ADMIN_URL: adminUrlValue,
    FORMAL_OUTPUT: outputDirectory,
    STORAGE_ROOT: storageRoot,
    IMPORT_OUTPUT_DIRECTORY: importOutputDirectory,
    TARGET_CLASS: "designated-real",
    // 测试缝（hook/故障注入）在 Vitest 运行时且仅对回环合成正式目标生效。
    VITEST: "true",
  };
}

interface FormalApprovalDocuments {
  readonly preflightReceiptSha256: string;
  readonly phase2ReceiptSha256: string;
  readonly scratchDatabaseFingerprintSha256: string;
  readonly formalTargetFingerprintSha256: string;
  readonly gitCommitSha256: string;
  readonly branchName: string;
  readonly expectedFormalImportCount: number;
  readonly prestateDatabaseInventorySha256: string;
  readonly prestateStorageInventorySha256: string;
  readonly storageRootIdentitySha256: string;
  readonly adminTargetFingerprintSha256: string;
}

async function writeFormalTargetApproval(
  targetApprovalFile: string,
  documents: FormalApprovalDocuments,
): Promise<void> {
  const generatedAt = new Date().toISOString();
  await privateFile(
    targetApprovalFile,
    `${JSON.stringify(
      {
        version: 2,
        generatedAt,
        expiresAt: new Date(Date.parse(generatedAt) + 60 * 60 * 1000).toISOString(),
        nonce: randomUUID().replaceAll("-", "").slice(0, 32),
        approvedByActorSha256: sha256Hex("actor-v1|synthetic-e2e-operator"),
        ...documents,
      },
      null,
      2,
    )}\n`,
  );
}

function formalTargetIdentity(connectionString: string): {
  readonly host: string;
  readonly port: string;
  readonly user: string;
  readonly database: string;
} {
  const parsed = new URL(connectionString);
  return {
    host: parsed.hostname,
    port: parsed.port === "" ? "5432" : parsed.port,
    user: decodeURIComponent(parsed.username),
    database: decodeURIComponent(parsed.pathname.replace(/^\//, "")),
  };
}

function provenanceHooks(): HistoryImportPreflightHooks & Phase2RunnerHooks {
  if (acceptanceMode) return {};
  return {
    verifyProvenance: async (commit): Promise<ExecutionProvenance> => ({
      commit,
      codeInventorySha256: sha256Hex("synthetic-code-inventory"),
      codeInventoryEntryCount: 1,
    }),
  };
}

async function approvedEnvironment(
  batch: SyntheticBatch,
  sourceConnectionString: string,
  executionId: string,
): Promise<NodeJS.ProcessEnv> {
  if (acceptanceMode && !/^[a-f0-9]{40}$/.test(acceptanceCommit ?? "")) {
    throw new Error("专用验收缺少完整批准提交摘要。");
  }
  return {
    PRIVATE_ROOT: evidenceRoot,
    LIST_METADATA: batch.listMetadata,
    PACKAGE_DIRECTORY: batch.packageDirectory,
    MATERIALIZED_DIRECTORY: batch.materializedDirectory,
    PREPARED_DIRECTORY: batch.preparedDirectory,
    APPROVAL_FILE: batch.approvalFile,
    PREFLIGHT_OUTPUT: batch.preflightOutput,
    DATABASE_URL: sourceConnectionString,
    GROUPING_FILE: batch.groupingFile,
    TAG_ID: tagId,
    GIT_COMMIT: acceptanceMode ? acceptanceCommit : "0".repeat(40),
    TARGET_CLASS: "scratch-temporary",
    PRINCIPAL: databaseDemoUserIds.leader,
    EXECUTION_ID: executionId,
    BATCH_SHA256: batch.report.batchSha256,
    SOURCE_BINDINGS_SHA256: recomputeSourceBindingsIdentity(batch.report),
    VITEST: "true",
  };
}

async function runApprovedPreflight(
  batch: SyntheticBatch,
  sourceConnectionString: string,
  executionId: string,
): Promise<NodeJS.ProcessEnv> {
  const env = await approvedEnvironment(batch, sourceConnectionString, executionId);
  expect(await runHistoryImportPreflight(preflightArguments(), env, provenanceHooks())).toBe(0);
  const preflightReceipt = join(batch.preflightOutput, preflightReceiptName);
  const receiptBytes = await readFile(preflightReceipt);
  return {
    ...env,
    PREFLIGHT_RECEIPT: preflightReceipt,
    PREFLIGHT_RECEIPT_SHA256: sha256Hex(receiptBytes),
    RECEIPT_DIRECTORY: batch.runnerReceiptDirectory,
    STORAGE_ROOT: batch.storageRoot,
    IMPORT_OUTPUT_DIRECTORY: batch.importOutputDirectory,
  };
}

function countMap(rows: readonly HistoryImportCountRow[]): Map<string, number> {
  return new Map(rows.map((row) => [row.table, row.rows]));
}

async function databaseExists(database: DatabaseHandle, name: string): Promise<boolean> {
  const rows = await database.query<{ total: bigint }>(
    sql`select count(*)::bigint as total from pg_database where datname = ${name}`,
  );
  return Number(rows[0]?.total ?? 0) === 1;
}
async function databaseExistsByName(database: DatabaseHandle, name: string): Promise<boolean> {
  return databaseExists(database, name);
}

function trackDatabaseFamily(name: string): void {
  // 跟踪数据库族的每个可能成员，包括世代快照。
  // 清理时逐一断言删除成功，绝不遗漏或预先删除。
  registerDatabase(name);
  registerDatabase(`${name}__snapshot`);
  registerDatabase(`${name}__snapshot_g1`);
  registerDatabase(`${name}__snapshot_g2`);
  registerDatabase(`${name}__restore`);
  registerDatabase(`${name}__failed`);
}

afterEach(async () => {
  // Gate 6 残留保证：清理不得在删除成功前丢弃名称（splice 会遗忘失败的
  // 删除，被下一轮随机覆盖）。先快照待清理列表，逐一删除，删除后断言
  // 该库在 pg_database 中已消失；全部断言通过后才从跟踪列表移除。
  if (adminUrl !== undefined) {
    const pending = [...temporaryDatabaseNames].reverse();
    const remaining: string[] = [];
    for (const name of pending) {
      try {
        if (/^urmotiv_formal_/u.test(name)) {
          const admin = createPostgresDatabase({ connectionString: adminUrl, maxConnections: 1 });
          await admin.execute(sql`drop database if exists ${sql.identifier(name)} with (force)`);
          await admin.close();
        } else {
          await dropHistoryImportDatabase(adminUrl, name);
        }
      } catch {
        // 删除失败：保留名称，不遗忘，让后续断言报错。
        remaining.push(name);
        cleanupEverFailed = true;
      }
      // 断言该库已消失：即使 drop 报错也检查，确保残留被暴露。
      const checkAdmin = createPostgresDatabase({ connectionString: adminUrl, maxConnections: 1 });
      const stillExists = await databaseExistsByName(checkAdmin, name);
      await checkAdmin.close();
      if (stillExists) {
        remaining.push(name);
        cleanupEverFailed = true;
      }
    }
    // 只在全部清理成功后清空跟踪列表；残留则保留供下一轮重试。
    if (remaining.length === 0) {
      temporaryDatabaseNames.splice(0);
    } else {
      temporaryDatabaseNames.splice(0, temporaryDatabaseNames.length, ...remaining);
    }
  }
  for (const directory of temporaryDirectories.splice(0)) {
    await rm(directory, { recursive: true, force: true });
  }
});

afterAll(() => {
  // 清理失败硬门：即使后续 afterEach 成功删除了残留库并清空了列表，
  // cleanupEverFailed 仍保持 true，确保曾经发生的清理失败不被遗忘。
  if (temporaryDatabaseNames.length !== 0) {
    throw new Error(
      `PG 清理未完成，残留数据库: ${temporaryDatabaseNames.join(", ")}`,
    );
  }
  if (cleanupEverFailed) {
    throw new Error(
      "PG 清理过程中曾发生删除失败（cleanupEverFailed），即使后续恢复仍判定为失败。",
    );
  }
});
describePostgres("Phase-2 runner 真实 PostgreSQL 验收", () => {
  it("137 个权威来源包精确导入并以 0/137 幂等重放", async () => {
    assertNode24();
    if (adminUrl === undefined) throw new Error("缺少 PostgreSQL 管理连接配置。");
    const sourceName = scratchName("src");
    const targetName = scratchName("ok");
    trackDatabaseFamily(sourceName);
    trackDatabaseFamily(targetName);
    await prepareHistoryImportDatabase(adminUrl, sourceName);
    const sourceConnectionString = historyImportDatabaseConnectionString(adminUrl, sourceName);
    const sourceDatabase = createPostgresDatabase({
      connectionString: sourceConnectionString,
      maxConnections: 1,
    });
    const before = await captureHistoryImportTableCounts(sourceDatabase);
    await sourceDatabase.close();

    const batch = await createSyntheticBatch(137);
    const env = await runApprovedPreflight(batch, sourceConnectionString, "synthetic-success");
    env.ADMIN_URL = sourceConnectionString;
    env.DATABASE_NAME = targetName;
    expect(await runPhase2Bound(runnerArguments(), env, provenanceHooks())).toBe(0);

    const receiptBytes = await readFile(
      join(batch.runnerReceiptDirectory, "phase2-run-receipt.private.json"),
    );
    const receipt = JSON.parse(receiptBytes.toString("utf8")) as Record<string, unknown>;
    expect(receipt).toMatchObject({
      version: 3,
      packageCount: 137,
      firstPass: { imported: 137, skipped: 0, failed: 0 },
      replayPass: { imported: 0, skipped: 137, failed: 0 },
      postcheck: { verdict: "PASS", reasonCodes: [], driftedTableCount: 0 },
      titleProbePassed: true,
      solutionStates: { nullCount: 7, emptyCount: 1 },
      attachmentCount: 38,
      storedObjectCount: 175,
      verdict: "PASS",
    });
    expect(JSON.stringify(receipt)).not.toContain("合成验收题目");
    expect(await exists(join(batch.runnerReceiptDirectory, "PHASE2_RUN_PASS"))).toBe(true);
    expect(await exists(join(batch.runnerReceiptDirectory, "storage.snapshot"))).toBe(false);
    expect(await exists(join(batch.runnerReceiptDirectory, "PHASE2_RECOVERY_IN_PROGRESS"))).toBe(false);
    const runnerTemplate = JSON.parse(
      await readFile(
        join(batch.runnerReceiptDirectory, "phase2-target-approval-template.private.json"),
        "utf8",
      ),
    ) as {
      preflightReceiptSha256: string;
      phase2ReceiptSha256: string;
      scratchDatabaseFingerprintSha256: string;
    };
    const preflightReceiptBytes = await readFile(join(batch.preflightOutput, preflightReceiptName));
    expect(runnerTemplate.preflightReceiptSha256).toBe(sha256Hex(preflightReceiptBytes));
    expect(runnerTemplate.phase2ReceiptSha256).toBe(sha256Hex(receiptBytes));
    expect(runnerTemplate.scratchDatabaseFingerprintSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(receipt.scratchDatabaseFingerprintSha256).toBe(
      runnerTemplate.scratchDatabaseFingerprintSha256,
    );

    const targetDatabase = createPostgresDatabase({
      connectionString: historyImportDatabaseConnectionString(adminUrl, targetName),
      maxConnections: 1,
    });
    const after = await captureHistoryImportTableCounts(targetDatabase);
    const databaseStorage = await captureStoredFileInventory(targetDatabase);
    await targetDatabase.close();
    const beforeMap = countMap(before);
    const afterMap = countMap(after);
    for (const expectation of expectedTableDeltas({
      imported: 137,
      attachmentRows: 38,
      sampleRows: 15,
      jobItemRows: 137,
      storedFilesDelta: 175,
      auditDelta: 274,
    })) {
      expect((afterMap.get(expectation.table) ?? 0) - (beforeMap.get(expectation.table) ?? 0)).toBe(
        expectation.delta,
      );
    }
    const physicalStorage = await captureStorageInventory(batch.storageRoot);
    expect(physicalStorage.fileCount).toBe(175);
    expect(databaseStorage).toEqual({
      fileCount: physicalStorage.fileCount,
      totalBytes: physicalStorage.totalBytes,
      contentInventorySha256: physicalStorage.contentInventorySha256,
    });

    const adminDatabase = createPostgresDatabase({ connectionString: adminUrl, maxConnections: 1 });
    expect(await databaseExists(adminDatabase, `${targetName}__snapshot`)).toBe(false);
    expect(await databaseExists(adminDatabase, `${targetName}__restore`)).toBe(false);
    expect(await databaseExists(adminDatabase, `${targetName}__failed`)).toBe(false);
    await adminDatabase.close();
    if (acceptanceMode) {
      console.log(
        `Phase-2 route receipt: phase2-run-receipt.private.json sha256=${sha256Hex(receiptBytes)}`,
      );
    }
  }, 300_000);

  it("故障恢复、数据库快照损坏与清理失败均关闭验收", async () => {
    assertNode24();
    if (adminUrl === undefined) throw new Error("缺少 PostgreSQL 管理连接配置。");
    const sourceName = scratchName("fsrc");
    trackDatabaseFamily(sourceName);
    await prepareHistoryImportDatabase(adminUrl, sourceName);
    const sourceConnectionString = historyImportDatabaseConnectionString(adminUrl, sourceName);
    const sourceDatabase = createPostgresDatabase({
      connectionString: sourceConnectionString,
      maxConnections: 1,
    });
    const expectedCounts = await captureHistoryImportTableCounts(sourceDatabase);
    const expectedStored = await captureStoredFileInventory(sourceDatabase);
    await sourceDatabase.close();

    const rollbackTarget = scratchName("roll");
    trackDatabaseFamily(rollbackTarget);
    const rollbackBatch = await createSyntheticBatch(1);
    const rollbackEnv = await runApprovedPreflight(
      rollbackBatch,
      sourceConnectionString,
      "synthetic-rollback",
    );
    rollbackEnv.ADMIN_URL = sourceConnectionString;
    rollbackEnv.DATABASE_NAME = rollbackTarget;
    expect(
      await runPhase2Bound(runnerArguments(), rollbackEnv, {
        ...provenanceHooks(),
        afterFirstPass: async () => {
          throw new Error("synthetic fault after first pass");
        },
      }),
    ).toBe(1);
    const restoredDatabase = createPostgresDatabase({
      connectionString: historyImportDatabaseConnectionString(adminUrl, rollbackTarget),
      maxConnections: 1,
    });
    expect(await captureHistoryImportTableCounts(restoredDatabase)).toEqual(expectedCounts);
    expect(await captureStoredFileInventory(restoredDatabase)).toEqual(expectedStored);
    await restoredDatabase.close();
    expect((await captureStorageInventory(rollbackBatch.storageRoot)).fileCount).toBe(0);
    expect(await exists(join(rollbackBatch.runnerReceiptDirectory, "phase2-run-receipt.private.json"))).toBe(false);
    expect(await exists(join(rollbackBatch.runnerReceiptDirectory, "PHASE2_RUN_PASS"))).toBe(false);
    expect(await exists(join(rollbackBatch.runnerReceiptDirectory, "storage.snapshot"))).toBe(false);
    expect(await exists(join(rollbackBatch.runnerReceiptDirectory, "PHASE2_RECOVERY_IN_PROGRESS"))).toBe(false);

    const corruptTarget = scratchName("corrupt");
    trackDatabaseFamily(corruptTarget);
    const corruptBatch = await createSyntheticBatch(1);
    const corruptEnv = await runApprovedPreflight(
      corruptBatch,
      sourceConnectionString,
      "synthetic-corruption",
    );
    corruptEnv.ADMIN_URL = sourceConnectionString;
    corruptEnv.DATABASE_NAME = corruptTarget;
    let corruptionStage = "not-started";
    expect(
      await runPhase2Bound(runnerArguments(), corruptEnv, {
        ...provenanceHooks(),
        afterFirstPass: async () => {
          const snapshotDatabase = createPostgresDatabase({
            connectionString: historyImportDatabaseConnectionString(
              adminUrl,
              `${corruptTarget}__snapshot`,
            ),
            maxConnections: 1,
          });
          corruptionStage = "connected";
          try {
            const beforeCorruption = await captureDatabaseContentInventory(
              snapshotDatabase,
              historyImportRequiredTables,
            );
            corruptionStage = "captured-before";
            const changedRows = await snapshotDatabase.query<{ readonly id: string }>(
              sql`update "public"."users"
                  set nickname = nickname || ' changed'
                  where id = ${databaseDemoUserIds.leader}
                  returning id::text as id`,
            );
            corruptionStage = `updated-${changedRows.length}`;
            if (changedRows.length !== 1) {
              throw new Error("snapshot corruption did not mutate a row");
            }
            const afterCorruption = await captureDatabaseContentInventory(
              snapshotDatabase,
              historyImportRequiredTables,
            );
            corruptionStage = "captured-after";
            console.log(
              `数据库快照损坏摘要变化: ${
                beforeCorruption.contentSha256 !== afterCorruption.contentSha256 ? "是" : "否"
              }`,
            );
            if (beforeCorruption.contentSha256 === afterCorruption.contentSha256) {
              throw new Error("database inventory did not detect snapshot corruption");
            }
            corruptionStage = "digest-changed";
          } finally {
            await snapshotDatabase.close();
          }
          throw new Error("synthetic database snapshot corruption");
        },
      }),
    ).toBe(1);
    expect(corruptionStage).toBe("digest-changed");
    expect(await exists(join(corruptBatch.runnerReceiptDirectory, "phase2-run-receipt.private.json"))).toBe(false);
    expect(await exists(join(corruptBatch.runnerReceiptDirectory, "PHASE2_RUN_PASS"))).toBe(false);
    expect(await exists(join(corruptBatch.runnerReceiptDirectory, "storage.snapshot"))).toBe(true);
    expect(await exists(join(corruptBatch.runnerReceiptDirectory, "PHASE2_RECOVERY_IN_PROGRESS"))).toBe(true);
    const adminDatabase = createPostgresDatabase({ connectionString: adminUrl, maxConnections: 1 });
    expect(await databaseExists(adminDatabase, `${corruptTarget}__snapshot`)).toBe(true);
    await adminDatabase.close();

    const cleanupTarget = scratchName("clean");
    trackDatabaseFamily(cleanupTarget);
    const cleanupBatch = await createSyntheticBatch(1);
    const cleanupEnv = await runApprovedPreflight(
      cleanupBatch,
      sourceConnectionString,
      "synthetic-cleanup-failure",
    );
    cleanupEnv.ADMIN_URL = sourceConnectionString;
    cleanupEnv.DATABASE_NAME = cleanupTarget;
    const cleanupSnapshotDir = join(cleanupBatch.runnerReceiptDirectory, "storage.snapshot");
    let cleanupStage = "not-started";
    expect(
      await runPhase2Bound(runnerArguments(), cleanupEnv, {
        ...provenanceHooks(),
        beforeSnapshotCleanup: async () => {
          // 真实的部分删除失败：先确证性地删掉一半文件，再制造一个
          // 不可删除的驻留目录，并在任何终删开始前抛出（模拟被喊停）。
          const names = (await readdir(cleanupSnapshotDir)).filter((name) => name !== "blocked");
          expect(names.length).toBeGreaterThan(0);
          cleanupStage = "partially-deleted";
          for (let index = 0; index < names.length; index += 2) {
            await rm(join(cleanupSnapshotDir, names[index]!), { recursive: true, force: false });
          }
          const blockedDirectory = join(cleanupSnapshotDir, "blocked");
          await mkdir(blockedDirectory);
          await privateFile(join(blockedDirectory, "locked.txt"), "locked");
          await chmod(blockedDirectory, 0o500);
          // 终删前的真实驻留故障：删到一半被喊停。进入恢复证据分支，
          // 任何终删都未开始，规范名数据库快照必须仍然保留。
          throw new Error("synthetic pre-terminal storage deletion arrest");
        },
      }),
    ).toBe(1);
    expect(cleanupStage).toBe("partially-deleted");
    expect(await exists(join(cleanupBatch.runnerReceiptDirectory, "phase2-run-receipt.private.json"))).toBe(false);
    expect(await exists(join(cleanupBatch.runnerReceiptDirectory, "PHASE2_RUN_PASS"))).toBe(false);
    expect(await exists(join(cleanupBatch.runnerReceiptDirectory, "storage.snapshot"))).toBe(true);
    expect(await exists(join(cleanupBatch.runnerReceiptDirectory, "PHASE2_CLEANUP_IN_PROGRESS"))).toBe(true);
    expect(await exists(join(cleanupBatch.runnerReceiptDirectory, "PHASE2_CLEANUP_REFUSED"))).toBe(true);
    expect(await exists(join(cleanupBatch.runnerReceiptDirectory, "PHASE2_RECOVERY_IN_PROGRESS"))).toBe(false);
    expect(await exists(join(cleanupBatch.preflightOutput, preflightPassMarkerName))).toBe(true);
    const cleanupEvidence = JSON.parse(
      await readFile(
        join(cleanupBatch.runnerReceiptDirectory, "cleanup-recovery-evidence.private.json"),
        "utf8",
      ),
    ) as {
      databaseSnapshotMatchesExecution: boolean;
      storageRecoveryMatchesExecution: boolean;
      databaseSnapshotRetained: boolean;
      storageRecoveryRetained: boolean;
      databaseSnapshotContentSha256: string;
      executionDatabaseContentSha256: string;
      storageRecoveryContentSha256: string;
    };
    expect(cleanupEvidence).toMatchObject({
      databaseSnapshotMatchesExecution: true,
      storageRecoveryMatchesExecution: true,
      databaseSnapshotRetained: true,
      storageRecoveryRetained: true,
    });
    expect(cleanupEvidence.databaseSnapshotContentSha256).toBe(
      cleanupEvidence.executionDatabaseContentSha256,
    );
    expect(cleanupEvidence.storageRecoveryContentSha256).not.toBe("");
    const recoverySnapshotDirectory = join(cleanupBatch.runnerReceiptDirectory, "storage.recovery");
    expect(await exists(recoverySnapshotDirectory)).toBe(true);
    // 恢复可行性证明（文件系统）：重建的快照可以把目标存储完整恢复到干净目录，
    // 且与执行后现场一致（恢复快照与保留的数据库快照描述同一状态）。
    const restoredStorageRoot = join(cleanupBatch.root, "storage-restored-from-recovery");
    await privateDirectory(restoredStorageRoot);
    await restoreStorageDirectory(
      recoverySnapshotDirectory,
      restoredStorageRoot,
      await captureStorageInventory(cleanupBatch.storageRoot),
    );
    // 恢复可行性证明（数据库）：保留的模板快照能重建出与执行后现场完全一致的库。
    const restoreDatabaseName = `${cleanupTarget}__restore`;
    const cleanupAdmin = createPostgresDatabase({ connectionString: adminUrl, maxConnections: 1 });
    const cleanupTargetDatabase = createPostgresDatabase({
      connectionString: historyImportDatabaseConnectionString(adminUrl, cleanupTarget),
      maxConnections: 1,
    });
    try {
      const executionCounts = await captureHistoryImportTableCounts(cleanupTargetDatabase);
      const executionStored = await captureStoredFileInventory(cleanupTargetDatabase);
      expect(await databaseExists(cleanupAdmin, `${cleanupTarget}__snapshot`)).toBe(true);
      await cleanupAdmin.execute(
        sql`create database ${sql.identifier(restoreDatabaseName)} template ${sql.identifier(
          `${cleanupTarget}__snapshot`,
        )}`,
      );
      const restoredFromSnapshot = createPostgresDatabase({
        connectionString: historyImportDatabaseConnectionString(adminUrl, restoreDatabaseName),
        maxConnections: 1,
      });
      try {
        expect(await captureHistoryImportTableCounts(restoredFromSnapshot)).toEqual(executionCounts);
        expect(await captureStoredFileInventory(restoredFromSnapshot)).toEqual(executionStored);
      } finally {
        await restoredFromSnapshot.close();
      }
    } finally {
      await cleanupTargetDatabase.close();
      await cleanupAdmin.close();
    }
    await chmod(join(cleanupSnapshotDir, "blocked"), 0o700);

    // 终删阶段驻留故障：钩子正常结束，进入终删序列后隔离目录清理被不可
    // 删除目录挡住（存储改名隔离本身可以完成）。数据库快照此时已删除，
    // 证据必须如实报告 scratch_terminal_pending（已退役待清理）而非可回滚
    // 的 scratch_terminal_failed：数据库快照未保留、terminalRecoveryCapable
    // 为 false，隔离目录保留在 storage.snapshot.terminal-trash。
    const terminalCleanupTarget = scratchName("term");
    trackDatabaseFamily(terminalCleanupTarget);
    const terminalCleanupBatch = await createSyntheticBatch(1);
    const terminalCleanupEnv = await runApprovedPreflight(
      terminalCleanupBatch,
      sourceConnectionString,
      "synthetic-terminal-cleanup-failure",
    );
    terminalCleanupEnv.ADMIN_URL = sourceConnectionString;
    terminalCleanupEnv.DATABASE_NAME = terminalCleanupTarget;
    const terminalCleanupSnapshotDir = join(
      terminalCleanupBatch.runnerReceiptDirectory,
      "storage.snapshot",
    );
    expect(
      await runPhase2Bound(runnerArguments(), terminalCleanupEnv, {
        ...provenanceHooks(),
        beforeSnapshotCleanup: async () => {
          const blockedDirectory = join(terminalCleanupSnapshotDir, "blocked");
          await mkdir(blockedDirectory);
          await privateFile(join(blockedDirectory, "locked.txt"), "locked");
          await chmod(blockedDirectory, 0o500);
        },
      }),
    ).toBe(1);
    expect(
      await exists(
        join(terminalCleanupBatch.runnerReceiptDirectory, "phase2-run-receipt.private.json"),
      ),
    ).toBe(false);
    expect(
      await exists(join(terminalCleanupBatch.runnerReceiptDirectory, "PHASE2_CLEANUP_IN_PROGRESS")),
    ).toBe(true);
    const terminalEvidence = JSON.parse(
      await readFile(
        join(terminalCleanupBatch.runnerReceiptDirectory, "cleanup-recovery-evidence.private.json"),
        "utf8",
      ),
    ) as {
      recoveryPhase: string;
      databaseSnapshotName: string | null;
      databaseSnapshotRetained: boolean;
      storageCanonicalPresent: boolean;
      storageTrashPresent: boolean;
      terminalRecoveryCapable: boolean;
      storageRecoveryMatchesExecution: boolean;
    };
    expect(terminalEvidence).toMatchObject({
      recoveryPhase: "scratch_terminal_pending",
      databaseSnapshotName: null,
      databaseSnapshotRetained: false,
      storageCanonicalPresent: false,
      storageTrashPresent: true,
      terminalRecoveryCapable: false,
      storageRecoveryMatchesExecution: true,
    });
    const terminalTrashDirectory = `${terminalCleanupSnapshotDir}.terminal-trash`;
    expect(await exists(terminalTrashDirectory)).toBe(true);
    expect(await exists(terminalCleanupSnapshotDir)).toBe(false);
    // 测试钩子留下的驻留文件不属于执行现场：解锁后清掉，恢复隔离目录
    // 与本批次执行现场一致，续做终删才允许完成。
    await chmod(join(terminalTrashDirectory, "blocked"), 0o700);
    await rm(join(terminalTrashDirectory, "blocked"), { recursive: true });
    // 幂等续做（必须使用与运行期一致的管理员连接）：隔离残留被回收，
    // 进入 scratch_finalized。
    expect(
      (
        await completePhase2TerminalCleanup({
          receiptDirectory: terminalCleanupBatch.runnerReceiptDirectory,
          adminUrl: sourceConnectionString,
          databaseName: terminalCleanupTarget,
        })
      ).phase,
    ).toBe("scratch_finalized");
    expect(await exists(terminalTrashDirectory)).toBe(false);
    expect(await exists(terminalCleanupSnapshotDir)).toBe(false);
    // 数据库快照删除后的喊停故障（afterTerminalDatabaseDrop）：成对代已
    // 退役，证据必须保持 scratch_terminal_pending 且 terminalRecoveryCapable
    // 为 false，绝不允许报告可回滚的终删失败。
    const postDropTarget = scratchName("termhook");
    trackDatabaseFamily(postDropTarget);
    const postDropBatch = await createSyntheticBatch(1);
    const postDropEnv = await runApprovedPreflight(
      postDropBatch,
      sourceConnectionString,
      "synthetic-post-retirement-arrest",
    );
    postDropEnv.ADMIN_URL = sourceConnectionString;
    postDropEnv.DATABASE_NAME = postDropTarget;
    expect(
      await runPhase2Bound(runnerArguments(), postDropEnv, {
        ...provenanceHooks(),
        cleanupFaults: {
          afterTerminalDatabaseDrop: async () => {
            throw new Error("synthetic post-retirement arrest");
          },
        },
      }),
    ).toBe(1);
    const postDropEvidence = JSON.parse(
      await readFile(
        join(postDropBatch.runnerReceiptDirectory, "cleanup-recovery-evidence.private.json"),
        "utf8",
      ),
    ) as {
      recoveryPhase: string;
      databaseSnapshotRetained: boolean;
      storageCanonicalPresent: boolean;
      storageTrashPresent: boolean;
      terminalRecoveryCapable: boolean;
    };
    expect(postDropEvidence).toMatchObject({
      recoveryPhase: "scratch_terminal_pending",
      databaseSnapshotRetained: false,
      storageCanonicalPresent: false,
      storageTrashPresent: true,
      terminalRecoveryCapable: false,
    });
    const postDropTrash = `${postDropBatch.runnerReceiptDirectory}/storage.snapshot.terminal-trash`;
    expect(await exists(postDropTrash)).toBe(true);
    expect(
      (
        await completePhase2TerminalCleanup({
          receiptDirectory: postDropBatch.runnerReceiptDirectory,
          adminUrl: sourceConnectionString,
          databaseName: postDropTarget,
        })
      ).phase,
    ).toBe("scratch_finalized");
    expect(await exists(postDropTrash)).toBe(false);

    // 终态写盘前喊停（beforeTerminalFinalizedWrite）：数据库快照与隔离
    // 存储均已删除，证据相位仍是 pending；幂等续做直接完成终态且不报错。
    const preFinalizeTarget = scratchName("termfinal");
    trackDatabaseFamily(preFinalizeTarget);
    const preFinalizeBatch = await createSyntheticBatch(1);
    const preFinalizeEnv = await runApprovedPreflight(
      preFinalizeBatch,
      sourceConnectionString,
      "synthetic-pre-finalize-arrest",
    );
    preFinalizeEnv.ADMIN_URL = sourceConnectionString;
    preFinalizeEnv.DATABASE_NAME = preFinalizeTarget;
    expect(
      await runPhase2Bound(runnerArguments(), preFinalizeEnv, {
        ...provenanceHooks(),
        cleanupFaults: {
          beforeTerminalFinalizedWrite: async () => {
            throw new Error("synthetic pre-finalize arrest");
          },
        },
      }),
    ).toBe(1);
    const preFinalizeEvidence = JSON.parse(
      await readFile(
        join(preFinalizeBatch.runnerReceiptDirectory, "cleanup-recovery-evidence.private.json"),
        "utf8",
      ),
    ) as {
      recoveryPhase: string;
      databaseSnapshotRetained: boolean;
      storageCanonicalPresent: boolean;
      storageTrashPresent: boolean;
      terminalRecoveryCapable: boolean;
    };
    expect(preFinalizeEvidence).toMatchObject({
      recoveryPhase: "scratch_terminal_pending",
      databaseSnapshotRetained: false,
      storageCanonicalPresent: false,
      storageTrashPresent: false,
      terminalRecoveryCapable: false,
    });
    expect(
      (
        await completePhase2TerminalCleanup({
          receiptDirectory: preFinalizeBatch.runnerReceiptDirectory,
          adminUrl: sourceConnectionString,
          databaseName: preFinalizeTarget,
        })
      ).phase,
    ).toBe("scratch_finalized");
    expect(
      await exists(
        join(preFinalizeBatch.runnerReceiptDirectory, "PHASE2_CLEANUP_REFUSED"),
      ),
    ).toBe(false);

    // 终删续做的身份绑定：错误的管理员连接必须零效果拒绝，现场保持。
    const wrongIdentityTarget = scratchName("wrongid");
    trackDatabaseFamily(wrongIdentityTarget);
    const wrongIdentityBatch = await createSyntheticBatch(1);
    const wrongIdentityEnv = await runApprovedPreflight(
      wrongIdentityBatch,
      sourceConnectionString,
      "synthetic-wrong-identity-terminal",
    );
    wrongIdentityEnv.ADMIN_URL = sourceConnectionString;
    wrongIdentityEnv.DATABASE_NAME = wrongIdentityTarget;
    expect(
      await runPhase2Bound(runnerArguments(), wrongIdentityEnv, {
        ...provenanceHooks(),
        cleanupFaults: {
          afterTerminalDatabaseDrop: async () => {
            throw new Error("synthetic wrong-identity arrest");
          },
        },
      }),
    ).toBe(1);
    await expect(
      completePhase2TerminalCleanup({
        receiptDirectory: wrongIdentityBatch.runnerReceiptDirectory,
        adminUrl,
        databaseName: wrongIdentityTarget,
      }),
    ).rejects.toThrow("管理员连接与中断证据不匹配");
    const wrongIdentityState = await readFormalRecoveryState(
      wrongIdentityBatch.runnerReceiptDirectory,
    );
    expect(wrongIdentityState?.phase).toBe("scratch_terminal_pending");
    const wrongIdentityTrash = `${wrongIdentityBatch.runnerReceiptDirectory}/storage.snapshot.terminal-trash`;
    expect(await exists(wrongIdentityTrash)).toBe(true);
    expect(
      (
        await completePhase2TerminalCleanup({
          receiptDirectory: wrongIdentityBatch.runnerReceiptDirectory,
          adminUrl: sourceConnectionString,
          databaseName: wrongIdentityTarget,
        })
      ).phase,
    ).toBe("scratch_finalized");
    expect(await exists(wrongIdentityTrash)).toBe(false);
    // Gate 5：终删证据与恢复状态机世代绑定 — 缺失/篡改任一摘要都
    // 零效果拒绝；清理完成后用同一份有效证据重放是幂等成功，
    // 篡改后重放仍然拒绝。
    const bindingTarget = scratchName("bindev");
    trackDatabaseFamily(bindingTarget);
    const bindingBatch = await createSyntheticBatch(1);
    const bindingEnv = await runApprovedPreflight(
      bindingBatch,
      sourceConnectionString,
      "synthetic-binding-evidence-terminal",
    );
    bindingEnv.ADMIN_URL = sourceConnectionString;
    bindingEnv.DATABASE_NAME = bindingTarget;
    expect(
      await runPhase2Bound(runnerArguments(), bindingEnv, {
        ...provenanceHooks(),
        cleanupFaults: {
          afterTerminalDatabaseDrop: async () => {
            throw new Error("synthetic binding-evidence arrest");
          },
        },
      }),
    ).toBe(1);
    const bindingEvidencePath = join(
      bindingBatch.runnerReceiptDirectory,
      "cleanup-recovery-evidence.private.json",
    );
    const bindingEvidenceJson = await readFile(bindingEvidencePath, "utf8");
    const patchBindingEvidence = (mutate: (record: Record<string, unknown>) => void) =>
      writeFile(
        bindingEvidencePath,
        `${JSON.stringify(
          (() => {
            const record = JSON.parse(bindingEvidenceJson) as Record<string, unknown>;
            mutate(record);
            return record;
          })(),
          null,
          2,
        )}\n`,
        { mode: 0o600 },
      );
    const bindingTrash = `${bindingBatch.runnerReceiptDirectory}/storage.snapshot.terminal-trash`;
    expect(await exists(bindingTrash)).toBe(true);
    // 1) 世代绑定摘要缺失：拒绝且现场保持。
    await patchBindingEvidence((record) => {
      delete record.scratchRecoveryBindingSha256;
    });
    await expect(
      completePhase2TerminalCleanup({
        receiptDirectory: bindingBatch.runnerReceiptDirectory,
        adminUrl: sourceConnectionString,
        databaseName: bindingTarget,
      }),
    ).rejects.toThrow("世代绑定不一致");
    expect((await readFormalRecoveryState(bindingBatch.runnerReceiptDirectory))?.phase).toBe(
      "scratch_terminal_pending",
    );
    expect(await exists(bindingTrash)).toBe(true);
    // 2) 世代绑定摘要被篡改（长度不变、内容翻转）：拒绝且现场保持。
    await patchBindingEvidence((record) => {
      const original = String(record.scratchRecoveryBindingSha256 ?? "");
      record.scratchRecoveryBindingSha256 = original === ""
        ? "0".repeat(64)
        : `${original[0] === "0" ? "1" : "0"}${original.slice(1)}`;
    });
    await expect(
      completePhase2TerminalCleanup({
        receiptDirectory: bindingBatch.runnerReceiptDirectory,
        adminUrl: sourceConnectionString,
        databaseName: bindingTarget,
      }),
    ).rejects.toThrow("世代绑定不一致");
    expect((await readFormalRecoveryState(bindingBatch.runnerReceiptDirectory))?.phase).toBe(
      "scratch_terminal_pending",
    );
    expect(await exists(bindingTrash)).toBe(true);
    // 3) 恢复状态摘要被篡改：绑定仍合法但摘要不匹配，拒绝且现场保持。
    await patchBindingEvidence((record) => {
      const original = String(record.recoveryStateSha256 ?? "");
      record.recoveryStateSha256 = `${original[0] === "0" || original === "" ? "1" : "0"}${(original || "0".repeat(63)).slice(1)}`;
    });
    await expect(
      completePhase2TerminalCleanup({
        receiptDirectory: bindingBatch.runnerReceiptDirectory,
        adminUrl: sourceConnectionString,
        databaseName: bindingTarget,
      }),
    ).rejects.toThrow("恢复状态摘要与状态机不匹配");
    expect((await readFormalRecoveryState(bindingBatch.runnerReceiptDirectory))?.phase).toBe(
      "scratch_terminal_pending",
    );
    expect(await exists(bindingTrash)).toBe(true);
    // 4) 恢复逐字段都是原始有效证据：真实终删进入 scratch_finalized。
    await writeFile(bindingEvidencePath, `${JSON.stringify(JSON.parse(bindingEvidenceJson), null, 2)}\n`, {
      mode: 0o600,
    });
    expect(
      (
        await completePhase2TerminalCleanup({
          receiptDirectory: bindingBatch.runnerReceiptDirectory,
          adminUrl: sourceConnectionString,
          databaseName: bindingTarget,
        })
      ).phase,
    ).toBe("scratch_finalized");
    expect(await exists(bindingTrash)).toBe(false);
    // 5) 终删后重放同一份有效证据：幂等成功，不执行任何清理。
    expect(
      (
        await completePhase2TerminalCleanup({
          receiptDirectory: bindingBatch.runnerReceiptDirectory,
          adminUrl: sourceConnectionString,
          databaseName: bindingTarget,
        })
      ).phase,
    ).toBe("scratch_finalized");
    // 6) 终删后重放被篡改的世代绑定：仍然拒绝。
    await patchBindingEvidence((record) => {
      const original = String(record.scratchRecoveryBindingSha256 ?? "0".repeat(64));
      record.scratchRecoveryBindingSha256 = `${original[0] === "0" ? "1" : "0"}${original.slice(1)}`;
    });
    await expect(
      completePhase2TerminalCleanup({
        receiptDirectory: bindingBatch.runnerReceiptDirectory,
        adminUrl: sourceConnectionString,
        databaseName: bindingTarget,
      }),
    ).rejects.toThrow("世代绑定不一致");
    // 换代窗口故障：存储新代已提升为规范名、数据库 g2 尚未提升时被喊停。
    // 证据必须如实呈现“规范存储在场、规范数据库空缺、g2 数据库保留”的
    // 错位现场；此时终删续做必须拒绝（相位不属于终删中断相位）。
    const generationTarget = scratchName("gen");
    trackDatabaseFamily(generationTarget);
    const generationBatch = await createSyntheticBatch(1);
    const generationEnv = await runApprovedPreflight(
      generationBatch,
      sourceConnectionString,
      "synthetic-generation-arrest",
    );
    generationEnv.ADMIN_URL = sourceConnectionString;
    generationEnv.DATABASE_NAME = generationTarget;
    expect(
      await runPhase2Bound(runnerArguments(), generationEnv, {
        ...provenanceHooks(),
        cleanupFaults: {
          afterStorageSnapshotPromoted: async () => {
            throw new Error("synthetic generation promotion arrest");
          },
        },
      }),
    ).toBe(1);
    const generationEvidence = JSON.parse(
      await readFile(
        join(generationBatch.runnerReceiptDirectory, "cleanup-recovery-evidence.private.json"),
        "utf8",
      ),
    ) as {
      recoveryPhase: string;
      databaseSnapshotName: string | null;
      databaseSnapshotMatchesExecution: boolean;
      databaseSnapshotRetained: boolean;
      storageCanonicalPresent: boolean;
      storageCanonicalMatchesExecution: boolean;
      storageNextPresent: boolean;
    };
    expect(generationEvidence).toMatchObject({
      recoveryPhase: "scratch_retiring_g1",
      databaseSnapshotName: "g2",
      databaseSnapshotMatchesExecution: true,
      databaseSnapshotRetained: true,
      storageCanonicalPresent: true,
      storageCanonicalMatchesExecution: true,
      storageNextPresent: false,
    });
    await expect(
      completePhase2TerminalCleanup({
        receiptDirectory: generationBatch.runnerReceiptDirectory,
        adminUrl,
        databaseName: generationTarget,
      }),
    ).rejects.toThrow("不允许续做");
  }, 300_000);
  it(
    "Gate 5 活身份绑定：文本不变的端点改指/集群替换被新活连接识破，零效果拒绝，同一活身份重放幂等",
    { timeout: 600_000 },
    async () => {
      assertNode24();
      if (adminUrl === undefined) throw new Error("缺少 PostgreSQL 管理连接配置。");
      // 授权验收集群是 5434；另起一次性第二集群（不同 initdb 指纹、不同
      // 监听端口），中间放一个可拨号的 TCP 代理：验收与管理连接串文本
      // 从头到尾不变，只有代理背后的真实端点被改指 —— 文本哈希必然
      // 通过，唯一能识破的就是新活连接采集的服务器端口/集群指纹。
      const clusterPort = await freePort();
      const containerName = `urmotiv-liveident-${process.pid}`;
      const secondCluster = startSecondCluster(containerName, clusterPort);
      const proxy = await startTcpProxy(primaryPort);
      try {
        expect(await postgresReady(secondCluster.url, 60)).toBe(true);
        const liveSourceName = scratchName("livsrc");
        trackDatabaseFamily(liveSourceName);
        await prepareHistoryImportDatabase(proxy.url, liveSourceName);
        const liveSourceConnection = historyImportDatabaseConnectionString(
          proxy.url,
          liveSourceName,
        );
        const liveTarget = scratchName("liveident");
        trackDatabaseFamily(liveTarget);
        const liveBatch = await createSyntheticBatch(1);
        const liveEnv = await runApprovedPreflight(
          liveBatch,
          liveSourceConnection,
          "synthetic-live-identity-terminal",
        );
        liveEnv.ADMIN_URL = liveSourceConnection;
        liveEnv.DATABASE_NAME = liveTarget;
        expect(
          await runPhase2Bound(runnerArguments(), liveEnv, {
            ...provenanceHooks(),
            cleanupFaults: {
              afterTerminalDatabaseDrop: async () => {
                throw new Error("synthetic live-identity arrest");
              },
            },
          }),
        ).toBe(1);
        const liveEvidencePath = join(
          liveBatch.runnerReceiptDirectory,
          "cleanup-recovery-evidence.private.json",
        );
        const liveEvidenceJson = await readFile(liveEvidencePath, "utf8");
        const patchLiveEvidence = (mutate: (record: Record<string, unknown>) => void) =>
          writeFile(
            liveEvidencePath,
            `${JSON.stringify(
              (() => {
                const record = JSON.parse(liveEvidenceJson) as Record<string, unknown>;
                mutate(record);
                return record;
              })(),
              null,
              2,
            )}\n`,
            { mode: 0o600 },
          );
        const liveEvidence = JSON.parse(liveEvidenceJson) as Record<string, unknown>;
        // 文本门（管理员连接 sha256）必须通过 —— 证明本次拒绝只可能来自活身份。
        expect(liveEvidence.adminUrlSha256).toBe(sha256Hex(`admin-url-v1|${liveSourceConnection}`));
        const frozenIdentity = liveEvidence.maintenanceLiveIdentity as Record<string, unknown>;
        expect(typeof frozenIdentity).toBe("object");
        for (const field of ["serverAddress", "serverPort", "user", "database", "clusterIdentity"]) {
          expect(typeof frozenIdentity[field]).toBe("string");
          expect(String(frozenIdentity[field]).length).toBeGreaterThan(0);
        }
        expect(String(liveEvidence.cleanupRecoveryIdentitySha256 ?? "").length).toBe(64);
        const liveTrash = `${liveBatch.runnerReceiptDirectory}/storage.snapshot.terminal-trash`;
        expect(await exists(liveTrash)).toBe(true);
        // 1) 端点被改指到第二集群（文本不变）：零效果拒绝。
        { const se = parseClusterEndpoint(secondCluster.url); proxy.setTarget(se.host, se.port); };
        await expect(
          completePhase2TerminalCleanup({
            receiptDirectory: liveBatch.runnerReceiptDirectory,
            adminUrl: liveSourceConnection,
            databaseName: liveTarget,
          }),
        ).rejects.toThrow("活身份");
        expect(
          (await readFormalRecoveryState(liveBatch.runnerReceiptDirectory))?.phase,
        ).toBe("scratch_terminal_pending");
        expect(await exists(liveTrash)).toBe(true);
        const adminA = createPostgresDatabase({ connectionString: adminUrl, maxConnections: 1 });
        try {
          expect(await databaseExists(adminA, liveTarget)).toBe(true);
        } finally {
          await adminA.close();
        }
        // 2) 指针摆回原集群（同一活身份）：续做成功，接着幂等重放成功。
        proxy.setTarget(primaryPort);
        expect(
          (
            await completePhase2TerminalCleanup({
              receiptDirectory: liveBatch.runnerReceiptDirectory,
              adminUrl: liveSourceConnection,
              databaseName: liveTarget,
            })
          ).phase,
        ).toBe("scratch_finalized");
        expect(await exists(liveTrash)).toBe(false);
        expect(
          (
            await completePhase2TerminalCleanup({
              receiptDirectory: liveBatch.runnerReceiptDirectory,
              adminUrl: liveSourceConnection,
              databaseName: liveTarget,
            })
          ).phase,
        ).toBe("scratch_finalized");
        // 3) 证据里活身份字段缺失/篡改：fail-closed 拒绝（终删后重放也要拒）。
        await patchLiveEvidence((record) => {
          const identity = record.maintenanceLiveIdentity as Record<string, unknown>;
          identity.clusterIdentity = "";
        });
        await expect(
          completePhase2TerminalCleanup({
            receiptDirectory: liveBatch.runnerReceiptDirectory,
            adminUrl: liveSourceConnection,
            databaseName: liveTarget,
          }),
        ).rejects.toThrow("缺少字段 集群指纹");
        await patchLiveEvidence((record) => {
          const original = String(record.cleanupRecoveryIdentitySha256 ?? "");
          record.cleanupRecoveryIdentitySha256 = original === ""
            ? "0".repeat(64)
            : `${original[0] === "0" ? "1" : "0"}${original.slice(1)}`;
        });
        await expect(
          completePhase2TerminalCleanup({
            receiptDirectory: liveBatch.runnerReceiptDirectory,
            adminUrl: liveSourceConnection,
            databaseName: liveTarget,
          }),
        ).rejects.toThrow("绑定摘要与中断证据不一致");
        await writeFile(liveEvidencePath, liveEvidenceJson, { mode: 0o600 });
        expect(
          (
            await completePhase2TerminalCleanup({
              receiptDirectory: liveBatch.runnerReceiptDirectory,
              adminUrl: liveSourceConnection,
              databaseName: liveTarget,
            })
          ).phase,
        ).toBe("scratch_finalized");
      } finally {
        await proxy.stop();
        secondCluster.stop();
      }
    },
  );
  it(
    "Gate 5 复核边界：活身份冻结后被改指，建库/绑定两条路径都零破坏性失败关闭",
    { timeout: 600_000 },
    async () => {
      assertNode24();
      if (adminUrl === undefined) throw new Error("缺少 PostgreSQL 管理连接配置。");
      const clusterPort = await freePort();
      const containerName = `urmotiv-livebound-${process.pid}`;
      const secondCluster = startSecondCluster(containerName, clusterPort);
      const proxy = await startTcpProxy(primaryPort);
      try {
        expect(await postgresReady(secondCluster.url, 60)).toBe(true);
        const liveSourceName = scratchName("lbsrc");
        trackDatabaseFamily(liveSourceName);
        // B 上预先建好同名库：复核连接能在 B 成功打开，身份复核本身
        // （集群指纹不一致）才是拒绝原因，而不是连带连接失败顺带关门。
        await prepareHistoryImportDatabase(secondCluster.url, liveSourceName);
        await prepareHistoryImportDatabase(proxy.url, liveSourceName);
        const liveSourceConnection = historyImportDatabaseConnectionString(
          proxy.url,
          liveSourceName,
        );
        // 冻结维护活身份（指向 A 集群）。
        const frozen = await captureLiveMaintenanceIdentity(liveSourceConnection);
        // (a) 管理连接复核：冻结之后、第一条 DDL（建库）之前改指到 B。
        // 建库函数自身要先用同一条新连接复核身份 —— 复核失败，任何集群都不落库。
        const repointedTarget = scratchName("lbddl");
        trackDatabaseFamily(repointedTarget);
        { const se = parseClusterEndpoint(secondCluster.url); proxy.setTarget(se.host, se.port); };
        await expect(
          prepareHistoryImportDatabase(liveSourceConnection, repointedTarget, frozen),
        ).rejects.toThrow("维护活身份");
        proxy.setTarget(primaryPort);
        const adminA = createPostgresDatabase({ connectionString: adminUrl, maxConnections: 1 });
        const adminB = createPostgresDatabase({
          connectionString: secondCluster.url,
          maxConnections: 1,
        });
        try {
          expect(await databaseExists(adminA, repointedTarget)).toBe(false);
          expect(await databaseExists(adminB, repointedTarget)).toBe(false);
        } finally {
          await adminA.close();
          await adminB.close();
        }
        // (b) 绑定运行边界：afterLiveIdentityVerified 注入缝把端点改指到 B，
        // 运行必须失败关闭（exits 1），A/B 都不出现目标库或任何快照工件。
        const boundTarget = scratchName("lbbind");
        trackDatabaseFamily(boundTarget);
        const boundBatch = await createSyntheticBatch(1);
        const boundEnv = await runApprovedPreflight(
          boundBatch,
          liveSourceConnection,
          "synthetic-live-boundary",
        );
        boundEnv.ADMIN_URL = liveSourceConnection;
        boundEnv.DATABASE_NAME = boundTarget;
        let hookFired = false;
        const exitCode = await runPhase2Bound(runnerArguments(), boundEnv, {
          ...provenanceHooks(),
          afterLiveIdentityVerified: async () => {
            hookFired = true;
            { const se = parseClusterEndpoint(secondCluster.url); proxy.setTarget(se.host, se.port); };
          },
        });
        expect(hookFired).toBe(true);
        expect(exitCode).toBe(1);
        proxy.setTarget(primaryPort);
        const probeA = createPostgresDatabase({ connectionString: adminUrl, maxConnections: 1 });
        const probeB = createPostgresDatabase({
          connectionString: secondCluster.url,
          maxConnections: 1,
        });
        try {
          for (const suffix of ["", "__snapshot", "__snapshot_g1", "__snapshot_g2", "__restore", "__failed"]) {
            const name = `${boundTarget}${suffix}`;
            expect(await databaseExists(probeA, name)).toBe(false);
            expect(await databaseExists(probeB, name)).toBe(false);
          }
        } finally {
          await probeA.close();
          await probeB.close();
        }
        expect(await readFormalRecoveryState(boundBatch.runnerReceiptDirectory)).toBeUndefined();
        expect(await readdir(boundBatch.runnerReceiptDirectory)).toEqual([]);
      } finally {
        await proxy.stop();
        secondCluster.stop();
      }
    },
  );
  it("正式导入：带外批准书门禁、伪造拒绝、v4 单遍收据与中途故障双向回滚", async () => {
    assertNode24();
    if (adminUrl === undefined) throw new Error("缺少 PostgreSQL 管理连接配置。");
    // 正式目标库：名称不能落入临时验收范围，结构与种子与验收库一致；
    // 名称同时满足合成正式测试缝范围，让 hook/故障注入只能在测试内生效。
    const formalDatabaseName = formalDbName("main");
    registerDatabase(formalDatabaseName);
    registerDatabase(`${formalDatabaseName}__formal_backup`);
    const formalAdmin = createPostgresDatabase({ connectionString: adminUrl, maxConnections: 1 });
    let formalDropped = false;
    const extraProductionDrops: string[] = [];
    try {
      await formalAdmin.execute(
        sql`create database ${sql.identifier(formalDatabaseName)}`,
      );
      const formalConnectionString = historyImportDatabaseConnectionString(
        adminUrl,
        formalDatabaseName,
      );
      const formalPreparation = createPostgresDatabase({
        connectionString: formalConnectionString,
        maxConnections: 4,
      });
      try {
        await migrateDatabase(formalPreparation);
        await seedCoreDatabase(formalPreparation);
        await seedDatabaseDemoData(formalPreparation);
      } finally {
        await formalPreparation.close();
      }
      // 同一批次完整跑通第 1 阶段预检与第 2 阶段临时库验收，
      // 收据与带外模板文件本身就出自这两个阶段。
      const formalSourceName = scratchName("formsrc");
      trackDatabaseFamily(formalSourceName);
      await prepareHistoryImportDatabase(adminUrl, formalSourceName);
      const formalSourceConnectionString = historyImportDatabaseConnectionString(
        adminUrl,
        formalSourceName,
      );
      const formalBatch = await createSyntheticBatch(6);
      const formalSeedEnv = await runApprovedPreflight(
        formalBatch,
        formalSourceConnectionString,
        "synthetic-formal-phase1",
      );
      formalSeedEnv.ADMIN_URL = formalSourceConnectionString;
      const formalRunnerTarget = scratchName("formrun");
      trackDatabaseFamily(formalRunnerTarget);
      formalSeedEnv.DATABASE_NAME = formalRunnerTarget;
      expect(
        await runPhase2Bound(runnerArguments(), formalSeedEnv, provenanceHooks()),
      ).toBe(0);
      // 临时库验收必须留下绑定实际临时库身份的模板；批准书由操作员
      // 在收据目录之外带外发布，正式命令只读取核对。
      const phase2ReceiptBytes = await readFile(
        join(formalBatch.runnerReceiptDirectory, "phase2-run-receipt.private.json"),
      );
      const runnerTemplate = JSON.parse(
        await readFile(
          join(
            formalBatch.runnerReceiptDirectory,
            "phase2-target-approval-template.private.json",
          ),
          "utf8",
        ),
      ) as {
        preflightReceiptSha256: string;
        phase2ReceiptSha256: string;
        scratchDatabaseFingerprintSha256: string;
      };
      const preflightReceiptBytesForFormal = await readFile(
        join(formalBatch.preflightOutput, preflightReceiptName),
      );
      expect(runnerTemplate.preflightReceiptSha256).toBe(
        sha256Hex(preflightReceiptBytesForFormal),
      );
      expect(runnerTemplate.phase2ReceiptSha256).toBe(sha256Hex(phase2ReceiptBytes));
      expect(runnerTemplate.scratchDatabaseFingerprintSha256).toMatch(/^[a-f0-9]{64}$/);
      expect(
        JSON.parse(phase2ReceiptBytes.toString("utf8")).scratchDatabaseFingerprintSha256,
      ).toBe(runnerTemplate.scratchDatabaseFingerprintSha256);
      const formalTargetApprovalFile = join(
        formalBatch.root,
        "formal-target-approval.private.json",
      );
      const formalTargetFingerprint = computeFormalTargetFingerprintSha256(
        formalTargetIdentity(formalConnectionString),
      );
      const formalBaselineClient = createPostgresDatabase({
        connectionString: formalConnectionString,
        maxConnections: 1,
      });
      const formalBefore = await captureHistoryImportTableCounts(formalBaselineClient);
      const formalBeforeDatabaseInventory = await captureDatabaseContentInventory(
        formalBaselineClient,
        historyImportRequiredTables,
      );
      await formalBaselineClient.close();
      const formalGitCommit = sha256Hex(
        process.env.URMOTIV_PHASE2_ACCEPTANCE_COMMIT ?? "0".repeat(40),
      );
      const formalAdminIdentity = parsePostgresIdentity(adminUrl);
      const formalAdminFingerprint = computeFormalAdminFingerprintSha256({
        host: formalAdminIdentity.host,
        port: formalAdminIdentity.port,
        user: formalAdminIdentity.user,
        database: formalAdminIdentity.database,
      });
      const formalBaseDocuments = {
        preflightReceiptSha256: runnerTemplate.preflightReceiptSha256,
        phase2ReceiptSha256: runnerTemplate.phase2ReceiptSha256,
        scratchDatabaseFingerprintSha256: runnerTemplate.scratchDatabaseFingerprintSha256,
        gitCommitSha256: formalGitCommit,
        branchName: "synthetic-formal-phase1",
        expectedFormalImportCount: 6,
        prestateDatabaseInventorySha256: formalBeforeDatabaseInventory.contentSha256,
        adminTargetFingerprintSha256: formalAdminFingerprint,
      } satisfies Omit<
        FormalApprovalDocuments,
        "formalTargetFingerprintSha256" | "prestateStorageInventorySha256" | "storageRootIdentitySha256"
      >;
      const formalHooks = {
        verifyProvenance: provenanceHooks().verifyProvenance,
        runPreflight: async (preflightArgv: readonly string[], preflightEnv: NodeJS.ProcessEnv) =>
          runHistoryImportPreflight(preflightArgv, preflightEnv, provenanceHooks()),
      };

      // （一 b）门禁 1：实时执行授权先于任何作业/来源/输出/数据库副作用。
      const denialStorageRoot = join(formalBatch.root, "formal-denial-storage");
      await privateDirectory(denialStorageRoot);
      const denialApprovalFile = join(
        formalBatch.root,
        "formal-target-approval-denial.private.json",
      );
      await writeFormalTargetApproval(denialApprovalFile, {
        ...formalBaseDocuments,
        formalTargetFingerprintSha256: formalTargetFingerprint,
        prestateStorageInventorySha256: (
          await captureStorageInventory(denialStorageRoot)
        ).contentInventorySha256,
        storageRootIdentitySha256: await computeStorageRootIdentitySha256(
          denialStorageRoot,
        ),
      });
      const denialOutput = join(formalBatch.root, "formal-output-denied");
      const denialEnv = await formalEnvironment(
        formalBatch,
        formalConnectionString,
        adminUrl,
        denialApprovalFile,
        denialOutput,
        denialStorageRoot,
        join(formalBatch.root, "formal-import-output-denied"),
        "synthetic-formal-phase1",
      );
      denialEnv.PRINCIPAL = databaseDemoUserIds.denied;
      expect(await runFormalImportBound(formalArguments(), denialEnv, {}, formalHooks)).toBe(1);
      expect(await exists(denialOutput)).toBe(false);
      const denialBaseCheck = createPostgresDatabase({
        connectionString: formalConnectionString,
        maxConnections: 1,
      });
      expect(await captureHistoryImportTableCounts(denialBaseCheck)).toEqual(formalBefore);
      await denialBaseCheck.close();
      // nonce 零核销：本次拒绝不得产生核销声明，也不得把该 nonce 写入日志。
      const denialApproval = JSON.parse(
        await readFile(denialApprovalFile, "utf8"),
      ) as { nonce: string };
      const denialNonceSha256 = sha256Hex(`nonce-v1|${denialApproval.nonce}`);
      expect(
        await exists(join(evidenceRoot, `formal-approval-log.${denialNonceSha256}.claim`)),
      ).toBe(false);
      if (await exists(join(evidenceRoot, "formal-approval-log"))) {
        const formalApprovalLog = await readFile(join(evidenceRoot, "formal-approval-log"), "utf8");
        expect(
          formalApprovalLog
            .split("\n")
            .map((line) => line.split("\t")[0])
            .includes(denialNonceSha256),
        ).toBe(false);
      }
      // （一 c）真正生产入口的实时执行授权拒绝：直接调用 runFormalImport
      // （不接受 hook/故障面/调用方给定权力），授权由服务端按 PRINCIPAL 实时
      // 解析，授权先于任何作业/来源/暂存/输出/备份/存储/数据库副作用。
      // 目标库使用非 urmotiv_ 前缀通过生产名称闸门，证明拒绝与命名无关。
      const productionDenialDatabaseName = `formaldenial_${process.pid}${randomUUID()
        .replaceAll("-", "")
        .slice(0, 8)}`;
      extraProductionDrops.push(
        productionDenialDatabaseName,
        `${productionDenialDatabaseName}__formal_backup`,
      );
      // formaldenial_* 数据库在隔离集群内创建，无需登记——容器拆除即清理。
      await formalAdmin.execute(
        sql`create database ${sql.identifier(productionDenialDatabaseName)}`,
      );
      const productionDenialConnectionString = historyImportDatabaseConnectionString(
        adminUrl,
        productionDenialDatabaseName,
      );
      const productionDenialPreparation = createPostgresDatabase({
        connectionString: productionDenialConnectionString,
        maxConnections: 4,
      });
      try {
        await migrateDatabase(productionDenialPreparation);
        await seedCoreDatabase(productionDenialPreparation);
        await seedDatabaseDemoData(productionDenialPreparation);
      } finally {
        await productionDenialPreparation.close();
      }
      const productionDenialBaselineClient = createPostgresDatabase({
        connectionString: productionDenialConnectionString,
        maxConnections: 1,
      });
      const productionDenialBefore = await captureHistoryImportTableCounts(
        productionDenialBaselineClient,
      );
      await productionDenialBaselineClient.close();
      const productionDenialOutput = join(formalBatch.root, "formal-output-denied-production");
      const productionDenialImportOutput = join(
        formalBatch.root,
        "formal-import-output-denied-production",
      );
      const productionDenialEnv = await formalEnvironment(
        formalBatch,
        productionDenialConnectionString,
        adminUrl,
        denialApprovalFile,
        productionDenialOutput,
        denialStorageRoot,
        productionDenialImportOutput,
        "synthetic-formal-phase1",
      );
      productionDenialEnv.PRINCIPAL = databaseDemoUserIds.denied;
      expect(await runFormalImport(formalArguments(), productionDenialEnv)).toBe(1);
      expect(await exists(productionDenialOutput)).toBe(false);
      expect(await exists(productionDenialImportOutput)).toBe(false);
      const productionDenialCheck = createPostgresDatabase({
        connectionString: productionDenialConnectionString,
        maxConnections: 1,
      });
      expect(await captureHistoryImportTableCounts(productionDenialCheck)).toEqual(
        productionDenialBefore,
      );
      await productionDenialCheck.close();
      expect((await captureStorageInventory(denialStorageRoot)).fileCount).toBe(0);
      expect(await databaseExists(formalAdmin, `${productionDenialDatabaseName}__formal_backup`)).toBe(
        false,
      );
      expect(await exists(join(evidenceRoot, `formal-approval-log.${denialNonceSha256}.claim`))).toBe(
        false,
      );
      await privateDirectory(join(formalBatch.root, "formal-storage-forged"));
      const forgedApprovalFile = join(
        formalBatch.root,
        "formal-target-approval-forged.private.json",
      );
      const forgedStorageRoot = join(formalBatch.root, "formal-storage-forged");
      await writeFormalTargetApproval(forgedApprovalFile, {
        ...formalBaseDocuments,
        formalTargetFingerprintSha256: "f".repeat(64),
        prestateStorageInventorySha256: (await captureStorageInventory(forgedStorageRoot))
          .contentInventorySha256,
        storageRootIdentitySha256: await computeStorageRootIdentitySha256(forgedStorageRoot),
      });
      const forgedOutput = join(formalBatch.root, "formal-output-forged");
      const forgedEnv = await formalEnvironment(
        formalBatch,
        formalConnectionString,
        adminUrl,
        forgedApprovalFile,
        forgedOutput,
        forgedStorageRoot,
        join(formalBatch.root, "formal-import-output-forged"),
        "synthetic-formal-phase1",
      );
      expect(await runFormalImportBound(formalArguments(), forgedEnv, {}, formalHooks)).toBe(1);
      expect(await exists(forgedOutput)).toBe(false);
      const forgedCheck = createPostgresDatabase({
        connectionString: formalConnectionString,
        maxConnections: 1,
      });
      expect(await captureHistoryImportTableCounts(forgedCheck)).toEqual(formalBefore);
      await forgedCheck.close();
      expect(await databaseExists(formalAdmin, `${formalDatabaseName}__formal_backup`)).toBe(false);

      // （二）真实中途故障：注入的存储层在第 3 次发布时故障，
      // 此时数据库行与文件对象均已部分存在，必须整体还原并证明等价。
      const rollbackStorageRoot = join(formalBatch.root, "formal-rollback-storage");
      await privateDirectory(rollbackStorageRoot);
      const rollbackApprovalFile = join(
        formalBatch.root,
        "formal-target-approval-rollback.private.json",
      );
      await writeFormalTargetApproval(rollbackApprovalFile, {
        ...formalBaseDocuments,
        formalTargetFingerprintSha256: formalTargetFingerprint,
        prestateStorageInventorySha256: (await captureStorageInventory(rollbackStorageRoot))
          .contentInventorySha256,
        storageRootIdentitySha256: await computeStorageRootIdentitySha256(rollbackStorageRoot),
      });
      const rollbackOutput = join(formalBatch.root, "formal-rollback-output");
      const rollbackImportOutput = join(formalBatch.root, "formal-rollback-import-output");
      const rollbackEnv = await formalEnvironment(
        formalBatch,
        formalConnectionString,
        adminUrl,
        rollbackApprovalFile,
        rollbackOutput,
        rollbackStorageRoot,
        rollbackImportOutput,
        "synthetic-formal-phase1",
      );
      const realStorage = createFileStorage({
        kind: "local",
        rootDirectory: rollbackStorageRoot,
        limits: { maxBytes: 2_000_000 },
      });
      let storagePublishCount = 0;
      const failingStorage: FileStorage = {
        stage: (input) => realStorage.stage(input),
        publish: async (staged) => {
          storagePublishCount += 1;
          if (storagePublishCount > 2) {
            throw new Error("synthetic mid-batch storage failure");
          }
          return realStorage.publish(staged);
        },
        discard: (staged) => realStorage.discard(staged),
        open: (stored) => realStorage.open(stored),
        delete: (stored) => realStorage.delete(stored),
      };
      expect(
        await runFormalImportBound(
          formalArguments(),
          rollbackEnv,
          { storage: failingStorage },
          formalHooks,
        ),
      ).toBe(1);
      expect(storagePublishCount).toBeGreaterThanOrEqual(3);
      expect(await exists(join(rollbackOutput, formalRollbackVerifiedMarkerName))).toBe(true);
      expect(await exists(join(rollbackOutput, formalRestoreRefusedMarkerName))).toBe(false);
      const rollbackReceipt = JSON.parse(
        await readFile(join(rollbackOutput, formalReceiptName), "utf8"),
      ) as { verdict: "PASS" | "FAIL"; rollback: { storageRestored: boolean; databaseRestored: boolean } };
      expect(rollbackReceipt).toMatchObject({
        verdict: "FAIL",
        rollback: { storageRestored: true, databaseRestored: true },
      });
      const rollbackCheck = createPostgresDatabase({
        connectionString: formalConnectionString,
        maxConnections: 1,
      });
      expect(await captureHistoryImportTableCounts(rollbackCheck)).toEqual(formalBefore);
      await rollbackCheck.close();
      expect((await captureStorageInventory(rollbackStorageRoot)).fileCount).toBe(0);
      expect(await databaseExists(formalAdmin, `${formalDatabaseName}__formal_backup`)).toBe(false);
      expect(await exists(join(rollbackOutput, "formal.storage.before.snapshot"))).toBe(false);
      // （二 b）收尾故障：在独立合成正式目标库上验证成功承诺之后的清理失败。
      // PASS 收据与 success_committed 必须在两个完好恢复副本都存在时落盘；注入
      // 的收尾失败只能进入 cleanup_incomplete（退出 0、PASS 标记保留、恢复副本
      // 保留、待清证据写盘），已提交数据绝不回退；随后由
      // completeFormalFinalizationCleanup 幂等续做完成副本销毁。
      const cleanupFaultDatabaseName = formalDbName("cleanup");
      registerDatabase(cleanupFaultDatabaseName);
      registerDatabase(`${cleanupFaultDatabaseName}__formal_backup`);
      await formalAdmin.execute(
        sql`create database ${sql.identifier(cleanupFaultDatabaseName)}`,
      );
      const cleanupFaultConnectionString = historyImportDatabaseConnectionString(
        adminUrl,
        cleanupFaultDatabaseName,
      );
      const cleanupFaultPreparation = createPostgresDatabase({
        connectionString: cleanupFaultConnectionString,
        maxConnections: 4,
      });
      try {
        await migrateDatabase(cleanupFaultPreparation);
        await seedCoreDatabase(cleanupFaultPreparation);
        await seedDatabaseDemoData(cleanupFaultPreparation);
      } finally {
        await cleanupFaultPreparation.close();
      }
      const cleanupFaultBaselineClient = createPostgresDatabase({
        connectionString: cleanupFaultConnectionString,
        maxConnections: 1,
      });
      const cleanupFaultBefore = await captureHistoryImportTableCounts(
        cleanupFaultBaselineClient,
      );
      const cleanupFaultBeforeInventory = await captureDatabaseContentInventory(
        cleanupFaultBaselineClient,
        historyImportRequiredTables,
      );
      await cleanupFaultBaselineClient.close();
      const cleanupFaultStorageRoot = join(formalBatch.root, "formal-cleanup-fault-storage");
      await privateDirectory(cleanupFaultStorageRoot);
      const cleanupFaultApprovalFile = join(
        formalBatch.root,
        "formal-target-approval-cleanup-fault.private.json",
      );
      await writeFormalTargetApproval(cleanupFaultApprovalFile, {
        ...formalBaseDocuments,
        formalTargetFingerprintSha256: computeFormalTargetFingerprintSha256(
          formalTargetIdentity(cleanupFaultConnectionString),
        ),
        prestateDatabaseInventorySha256: cleanupFaultBeforeInventory.contentSha256,
        prestateStorageInventorySha256: (await captureStorageInventory(cleanupFaultStorageRoot))
          .contentInventorySha256,
        storageRootIdentitySha256: await computeStorageRootIdentitySha256(cleanupFaultStorageRoot),
      });
      const cleanupFaultOutput = join(formalBatch.root, "formal-cleanup-fault-output");
      const cleanupFaultImportOutput = join(formalBatch.root, "formal-cleanup-fault-import-output");
      const cleanupFaultEnv = await formalEnvironment(
        formalBatch,
        cleanupFaultConnectionString,
        adminUrl,
        cleanupFaultApprovalFile,
        cleanupFaultOutput,
        cleanupFaultStorageRoot,
        cleanupFaultImportOutput,
        "synthetic-formal-phase1",
      );
      expect(
        await runFormalImportBound(
          formalArguments(),
          cleanupFaultEnv,
          {
            finalization: {
              afterPassReceiptWrite: async () => {
                throw new Error("synthetic after-pass-receipt cleanup failure");
              },
            },
          },
          formalHooks,
        ),
      ).toBe(0);
      expect(await exists(join(cleanupFaultOutput, formalPassMarkerName))).toBe(true);
      expect(await exists(join(cleanupFaultOutput, formalRollbackVerifiedMarkerName))).toBe(false);
      expect(await exists(join(cleanupFaultOutput, formalRestoreRefusedMarkerName))).toBe(false);
      expect(
        await databaseExists(formalAdmin, `${cleanupFaultDatabaseName}__formal_backup`),
      ).toBe(true);
      expect(await exists(join(cleanupFaultOutput, "formal.storage.before.snapshot"))).toBe(true);
      const cleanupFaultReceipt = JSON.parse(
        await readFile(join(cleanupFaultOutput, formalReceiptName), "utf8"),
      ) as { version: number; verdict: "PASS" | "FAIL" };
      expect(cleanupFaultReceipt).toMatchObject({ version: 4, verdict: "PASS" });
      const cleanupFaultPendingEvidence = JSON.parse(
        await readFile(join(cleanupFaultOutput, formalCleanupPendingEvidenceName), "utf8"),
      ) as {
        receiptVerdict: string;
        passReceiptWritten: boolean;
        recoveryPhase: string;
        databaseBackupRetained: boolean;
        storageSnapshotRetained: boolean;
        recoveryStateSha256: string;
      };
      expect(cleanupFaultPendingEvidence).toMatchObject({
        receiptVerdict: "PASS",
        passReceiptWritten: true,
        recoveryPhase: "cleanup_incomplete",
        databaseBackupRetained: true,
        storageSnapshotRetained: true,
      });
      expect(cleanupFaultPendingEvidence.recoveryStateSha256).toMatch(/^[a-f0-9]{64}$/);
      const cleanupFaultCheck = createPostgresDatabase({
        connectionString: cleanupFaultConnectionString,
        maxConnections: 1,
      });
      const cleanupFaultAfter = await captureHistoryImportTableCounts(cleanupFaultCheck);
      await cleanupFaultCheck.close();
      const cleanupFaultBeforeMap = countMap(cleanupFaultBefore);
      const cleanupFaultAfterMap = countMap(cleanupFaultAfter);
      for (const expectation of expectedTableDeltas({
        imported: 6,
        attachmentRows: 6,
        sampleRows: 6,
        jobItemRows: 6,
        storedFilesDelta: 12,
        auditDelta: 12,
      })) {
        expect(
          (cleanupFaultAfterMap.get(expectation.table) ?? 0) -
            (cleanupFaultBeforeMap.get(expectation.table) ?? 0),
        ).toBe(expectation.delta);
      }
      expect((await captureStorageInventory(cleanupFaultStorageRoot)).fileCount).toBe(12);
      // Gate 4 幂等补做：销毁两个恢复副本并进入 finalized。
      // Gate 4 身份绑定：错误维护连接必须零效果拒绝（相位不变、两个恢复
      // 副本都在）。批准书绑定的是 postgres 库连接指纹。
      await expect(
        completeFormalFinalizationCleanup({
          outputDirectory: cleanupFaultOutput,
          adminUrl: adminUrl.replace(/\/postgres$/, "/template1"),
        }),
      ).rejects.toThrow(/身份与批准书不一致|身份与备份证据不一致|维护连接/);
      expect((await readFormalRecoveryState(cleanupFaultOutput))?.phase).toBe(
        "cleanup_incomplete",
      );
      expect(
        await databaseExists(formalAdmin, `${cleanupFaultDatabaseName}__formal_backup`),
      ).toBe(true);
      expect(await exists(join(cleanupFaultOutput, "formal.storage.before.snapshot"))).toBe(true);
      expect(
        await completeFormalFinalizationCleanup({
          outputDirectory: cleanupFaultOutput,
          adminUrl,
        }),
      ).toEqual({ phase: "finalized" });
      expect(
        await databaseExists(formalAdmin, `${cleanupFaultDatabaseName}__formal_backup`),
      ).toBe(false);
      expect(await exists(join(cleanupFaultOutput, "formal.storage.before.snapshot"))).toBe(false);
      expect((await readFormalRecoveryState(cleanupFaultOutput))?.phase).toBe("finalized");
      // （二 c）拒绝收据故障缝：写盘前把收据路径占为目录。运行必须拒绝
      // 产出任何结论文本：无收据、无 PASS 标记、阶段停留在 rollback_verified、
      // 数据库行与存储处处零残留、临时备份库不存在。
      const refusalFaultDatabaseName = formalDbName("refusal");
      registerDatabase(refusalFaultDatabaseName);
      registerDatabase(`${refusalFaultDatabaseName}__formal_backup`);
      await formalAdmin.execute(sql`create database ${sql.identifier(refusalFaultDatabaseName)}`);
      const refusalFaultConnectionString = historyImportDatabaseConnectionString(
        adminUrl,
        refusalFaultDatabaseName,
      );
      const refusalFaultPreparation = createPostgresDatabase({
        connectionString: refusalFaultConnectionString,
        maxConnections: 4,
      });
      try {
        await migrateDatabase(refusalFaultPreparation);
        await seedCoreDatabase(refusalFaultPreparation);
        await seedDatabaseDemoData(refusalFaultPreparation);
      } finally {
        await refusalFaultPreparation.close();
      }
      const refusalFaultBaselineClient = createPostgresDatabase({
        connectionString: refusalFaultConnectionString,
        maxConnections: 1,
      });
      const refusalFaultBefore = await captureHistoryImportTableCounts(
        refusalFaultBaselineClient,
      );
      const refusalFaultBeforeInventory = await captureDatabaseContentInventory(
        refusalFaultBaselineClient,
        historyImportRequiredTables,
      );
      await refusalFaultBaselineClient.close();
      const refusalFaultStorageRoot = join(formalBatch.root, "formal-refusal-fault-storage");
      await privateDirectory(refusalFaultStorageRoot);
      const refusalFaultApprovalFile = join(
        formalBatch.root,
        "formal-target-approval-refusal-fault.private.json",
      );
      await writeFormalTargetApproval(refusalFaultApprovalFile, {
        ...formalBaseDocuments,
        formalTargetFingerprintSha256: computeFormalTargetFingerprintSha256(
          formalTargetIdentity(refusalFaultConnectionString),
        ),
        prestateDatabaseInventorySha256: refusalFaultBeforeInventory.contentSha256,
        prestateStorageInventorySha256: (await captureStorageInventory(refusalFaultStorageRoot))
          .contentInventorySha256,
        storageRootIdentitySha256: await computeStorageRootIdentitySha256(refusalFaultStorageRoot),
      });
      const refusalOutput = join(formalBatch.root, "formal-refusal-fault-output");
      const refusalImportOutput = join(formalBatch.root, "formal-refusal-fault-import-output");
      const refusalEnv = await formalEnvironment(
        formalBatch,
        refusalFaultConnectionString,
        adminUrl,
        refusalFaultApprovalFile,
        refusalOutput,
        refusalFaultStorageRoot,
        refusalImportOutput,
        "synthetic-formal-phase1",
      );
      const refusalRealStorage = createFileStorage({
        kind: "local",
        rootDirectory: refusalFaultStorageRoot,
        limits: { maxBytes: 2_000_000 },
      });
      let refusalPublishCount = 0;
      const refusalFailingStorage: FileStorage = {
        stage: (input) => refusalRealStorage.stage(input),
        publish: async (staged) => {
          refusalPublishCount += 1;
          if (refusalPublishCount > 2) {
            throw new Error("synthetic refusal-seam storage failure");
          }
          return refusalRealStorage.publish(staged);
        },
        discard: (staged) => refusalRealStorage.discard(staged),
        open: (stored) => refusalRealStorage.open(stored),
        delete: (stored) => refusalRealStorage.delete(stored),
      };
      expect(
        await runFormalImportBound(
          formalArguments(),
          refusalEnv,
          {
            storage: refusalFailingStorage,
            refusal: {
              beforeRefusalReceiptWrite: async () => {
                await mkdir(join(refusalOutput, formalReceiptName), { recursive: true });
              },
            },
          },
          formalHooks,
        ),
      ).toBe(1);
      expect((await stat(join(refusalOutput, formalReceiptName))).isDirectory()).toBe(true);
      expect(await exists(join(refusalOutput, formalPassMarkerName))).toBe(false);
      expect(await exists(join(refusalOutput, formalPassRetirementEvidenceName))).toBe(true);
      expect(await exists(join(refusalOutput, formalRetiredPassReceiptName))).toBe(false);
      expect(await exists(join(refusalOutput, formalRollbackVerifiedMarkerName))).toBe(true);
      expect(await exists(join(refusalOutput, formalRestoreRefusedMarkerName))).toBe(false);
      const refusalCheck = createPostgresDatabase({
        connectionString: refusalFaultConnectionString,
        maxConnections: 1,
      });
      expect(await captureHistoryImportTableCounts(refusalCheck)).toEqual(refusalFaultBefore);
      await refusalCheck.close();
      expect((await captureStorageInventory(refusalFaultStorageRoot)).fileCount).toBe(0);
      expect(await databaseExists(formalAdmin, `${refusalFaultDatabaseName}__formal_backup`)).toBe(
        false,
      );
      expect((await readFormalRecoveryState(refusalOutput))?.phase).toBe("rollback_verified");
      // （四）权威 PASS 双工件退役：先让权威 PASS 收据与标记落盘
      // （beforeSuccessCommittedWrite 故障缝），随后回滚中的拒绝收据写盘
      // 也被路径占用。运行必须退出 1，且规范名上不再存在权威 PASS 工件：
      // 收据位被目录占用（丢弃任何权威性）、标记退役、PASS 收据只残留在
      // retired 副本；双方退役证据在案；数据库与存储回滚无泄漏。
      const retireFaultDatabaseName = formalDbName("retire");
      registerDatabase(retireFaultDatabaseName);
      registerDatabase(`${retireFaultDatabaseName}__formal_backup`);
      await formalAdmin.execute(sql`create database ${sql.identifier(retireFaultDatabaseName)}`);
      const retireFaultConnectionString = historyImportDatabaseConnectionString(
        adminUrl,
        retireFaultDatabaseName,
      );
      const retireFaultPreparation = createPostgresDatabase({
        connectionString: retireFaultConnectionString,
        maxConnections: 4,
      });
      try {
        await migrateDatabase(retireFaultPreparation);
        await seedCoreDatabase(retireFaultPreparation);
        await seedDatabaseDemoData(retireFaultPreparation);
      } finally {
        await retireFaultPreparation.close();
      }
      const retireFaultBaselineClient = createPostgresDatabase({
        connectionString: retireFaultConnectionString,
        maxConnections: 1,
      });
      const retireFaultBefore = await captureHistoryImportTableCounts(
        retireFaultBaselineClient,
      );
      const retireFaultBeforeInventory = await captureDatabaseContentInventory(
        retireFaultBaselineClient,
        historyImportRequiredTables,
      );
      await retireFaultBaselineClient.close();
      const retireFaultStorageRoot = join(formalBatch.root, "formal-retire-fault-storage");
      await privateDirectory(retireFaultStorageRoot);
      const retireFaultApprovalFile = join(
        formalBatch.root,
        "formal-target-approval-retire-fault.private.json",
      );
      await writeFormalTargetApproval(retireFaultApprovalFile, {
        ...formalBaseDocuments,
        formalTargetFingerprintSha256: computeFormalTargetFingerprintSha256(
          formalTargetIdentity(retireFaultConnectionString),
        ),
        prestateDatabaseInventorySha256: retireFaultBeforeInventory.contentSha256,
        prestateStorageInventorySha256: (await captureStorageInventory(retireFaultStorageRoot))
          .contentInventorySha256,
        storageRootIdentitySha256: await computeStorageRootIdentitySha256(retireFaultStorageRoot),
      });
      const retireOutput = join(formalBatch.root, "formal-retire-fault-output");
      const retireImportOutput = join(formalBatch.root, "formal-retire-fault-import-output");
      const retireEnv = await formalEnvironment(
        formalBatch,
        retireFaultConnectionString,
        adminUrl,
        retireFaultApprovalFile,
        retireOutput,
        retireFaultStorageRoot,
        retireImportOutput,

        "synthetic-formal-phase1",
      );
      const retireRealStorage = createFileStorage({
        kind: "local",
        rootDirectory: retireFaultStorageRoot,
        limits: { maxBytes: 2_000_000 },
      });
      expect(
        await runFormalImportBound(
          formalArguments(),
          retireEnv,
          {
            storage: retireRealStorage,
            finalization: {
              beforeSuccessCommittedWrite: async () => {
                throw new Error("synthetic post-pass commit failure");
              },
            },
            refusal: {
              beforeRefusalReceiptWrite: async () => {
                await mkdir(join(retireOutput, formalReceiptName), { recursive: true });
              },
            },
          },
          formalHooks,
        ),
      ).toBe(1);
      // 权威工件：规范名上绝无 PASS 收据或标记。
      expect((await stat(join(retireOutput, formalReceiptName))).isDirectory()).toBe(true);
      expect(await exists(join(retireOutput, formalPassMarkerName))).toBe(false);
      // 非权威残留：退役副本 + 双方退役证据 + 已验证回滚标记。
      expect(await exists(join(retireOutput, formalRetiredPassReceiptName))).toBe(true);
      expect(await exists(join(retireOutput, formalRetiredPassMarkerName))).toBe(true);
      expect(await exists(join(retireOutput, formalPassRetirementEvidenceName))).toBe(true);
      expect(await exists(join(retireOutput, formalRollbackVerifiedMarkerName))).toBe(true);
      expect(await exists(join(retireOutput, formalRestoreRefusedMarkerName))).toBe(false);
      // 回滚语义：数据库、存储、临时备份库均复原/清除。
      const retireCheck = createPostgresDatabase({
        connectionString: retireFaultConnectionString,
        maxConnections: 1,
      });
      expect(await captureHistoryImportTableCounts(retireCheck)).toEqual(retireFaultBefore);
      await retireCheck.close();
      expect((await captureStorageInventory(retireFaultStorageRoot)).fileCount).toBe(0);
      expect(await databaseExists(formalAdmin, `${retireFaultDatabaseName}__formal_backup`)).toBe(
        false,
      );
      expect((await readFormalRecoveryState(retireOutput))?.phase).toBe("rollback_verified");

       // （三）正确批准书：单遍导入 + 独立自证核对 + v4 通过收据。

      const formalStorageRoot = join(formalBatch.root, "formal-storage");
      await privateDirectory(formalStorageRoot);
      await writeFormalTargetApproval(formalTargetApprovalFile, {
        ...formalBaseDocuments,
        formalTargetFingerprintSha256: formalTargetFingerprint,
        prestateStorageInventorySha256: (await captureStorageInventory(formalStorageRoot))
          .contentInventorySha256,
        storageRootIdentitySha256: await computeStorageRootIdentitySha256(formalStorageRoot),
      });
      const formalOutputDirectory = join(formalBatch.root, "formal-output");
      const formalImportOutputDirectory = join(formalBatch.root, "formal-import-output");
      const formalEnvironmentValue = await formalEnvironment(
        formalBatch,
        formalConnectionString,
        adminUrl,
        formalTargetApprovalFile,
        formalOutputDirectory,
        formalStorageRoot,
        formalImportOutputDirectory,
        "synthetic-formal-phase1",
      );
      expect(
        await runFormalImportBound(formalArguments(), formalEnvironmentValue, {}, formalHooks),
      ).toBe(0);
      const formalReceipt = JSON.parse(
        await readFile(join(formalOutputDirectory, formalReceiptName), "utf8"),
      ) as {
        version: number;
        singlePass: boolean;
        packageCount: number;
        storedObjectCount: number;
        verdict: "PASS" | "FAIL";
        backupVerifiedBeforeMutation: boolean;
        postcheck: {
          verdict: string;
          authoritativeInventoryEquality: Record<string, boolean>;
        };
      };
      expect(formalReceipt).toMatchObject({
        version: 4,
        singlePass: true,
        packageCount: 6,
        verdict: "PASS",
        backupVerifiedBeforeMutation: true,
        postcheck: {
          verdict: "PASS",
          authoritativeInventoryEquality: {
            revisionContent: true,
            solutionStates: true,
            attachmentCount: true,
            tableDeltas: true,
            titleUnmodified: true,
            storage: true,
            storedFiles: true,
          },
        },
      });
      expect(await exists(join(formalOutputDirectory, formalPassMarkerName))).toBe(true);
      expect(await exists(join(formalOutputDirectory, formalBackupVerifiedMarkerName))).toBe(true);
      expect(await exists(join(formalOutputDirectory, formalRollbackVerifiedMarkerName))).toBe(false);
      expect(await exists(join(formalOutputDirectory, formalRestoreRefusedMarkerName))).toBe(false);
      expect(await exists(join(formalOutputDirectory, "formal.backup.evidence.available"))).toBe(false);
      expect(await exists(join(formalOutputDirectory, "formal.storage.before.snapshot"))).toBe(false);
      expect(await databaseExists(formalAdmin, `${formalDatabaseName}__formal_backup`)).toBe(false);
      const formalDatabase = createPostgresDatabase({
        connectionString: formalConnectionString,
        maxConnections: 1,
      });
      const formalCounts = await captureHistoryImportTableCounts(formalDatabase);
      await formalDatabase.close();
      const formalBeforeMap = countMap(formalBefore);
      const formalAfterMap = countMap(formalCounts);
      for (const expectation of expectedTableDeltas({
        imported: 6,
        attachmentRows: 6,
        sampleRows: 6,
        jobItemRows: 6,
        storedFilesDelta: 12,
        auditDelta: 12,
      })) {
        expect(
          (formalAfterMap.get(expectation.table) ?? 0) -
            (formalBeforeMap.get(expectation.table) ?? 0),
        ).toBe(expectation.delta);
      }
      const formalStorage = await captureStorageInventory(formalStorageRoot);
      expect(formalStorage.fileCount).toBe(formalReceipt.storedObjectCount);
      const phase2ReceiptForFormal = JSON.parse(phase2ReceiptBytes.toString("utf8")) as {
        storedObjectCount: number;
      };
      expect(formalReceipt.storedObjectCount).toBe(phase2ReceiptForFormal.storedObjectCount);

      // （四）原样重放到新的输出目录：已入库批次按聚合判定拒绝，
      // 回滚已证明，数据不得有任何新增。批准书是带外新签发的（新 nonce），
      // 但预状态必须是当前已入库状态，以确保拒绝只来自聚合判定。
      const formalOutputSecond = join(formalBatch.root, "formal-output-second");
      const secondApprovalFile = join(
        formalBatch.root,
        "formal-target-approval-second.private.json",
      );
      const secondBeforeDatabaseInventory = await (async () => {
        const client = createPostgresDatabase({
          connectionString: formalConnectionString,
          maxConnections: 1,
        });
        try {
          return await captureDatabaseContentInventory(client, historyImportRequiredTables);
        } finally {
          await client.close();
        }
      })();
      await writeFormalTargetApproval(secondApprovalFile, {
        ...formalBaseDocuments,
        formalTargetFingerprintSha256: formalTargetFingerprint,
        prestateDatabaseInventorySha256: secondBeforeDatabaseInventory.contentSha256,
        prestateStorageInventorySha256: (await captureStorageInventory(formalStorageRoot))
          .contentInventorySha256,
        storageRootIdentitySha256: await computeStorageRootIdentitySha256(formalStorageRoot),
      });
      const formalSecondEnv = await formalEnvironment(
        formalBatch,
        formalConnectionString,
        adminUrl,
        secondApprovalFile,
        formalOutputSecond,
        formalStorageRoot,
        join(formalBatch.root, "formal-import-output-second"),
        "synthetic-formal-phase1",
      );
      expect(await runFormalImportBound(formalArguments(), formalSecondEnv, {}, formalHooks)).toBe(1);
      expect(await exists(join(formalOutputSecond, formalPassMarkerName))).toBe(false);
      expect(await exists(join(formalOutputSecond, formalRollbackVerifiedMarkerName))).toBe(true);
      const formalDatabaseAfterReplay = createPostgresDatabase({
        connectionString: formalConnectionString,
        maxConnections: 1,
      });
      expect(await captureHistoryImportTableCounts(formalDatabaseAfterReplay)).toEqual(
        formalCounts,
      );
      await formalDatabaseAfterReplay.close();
      expect((await captureStorageInventory(formalStorageRoot)).fileCount).toBe(
        formalReceipt.storedObjectCount,
      );
    if (acceptanceMode) {
      const acceptanceDirectory = process.env.URMOTIV_PHASE2_ACCEPTANCE_DIR;
      if (acceptanceDirectory === undefined) {
        throw new Error("专用验收缺少证据输出根目录。");
      }
      const formalReceiptBytes = await readFile(join(formalOutputDirectory, formalReceiptName));
      const phase2ReceiptJson = JSON.parse(phase2ReceiptBytes.toString("utf8")) as {
        inputBindings?: Record<string, unknown>;
      };
      const inputBindings = phase2ReceiptJson.inputBindings ?? {};
      const bindings: Record<string, unknown | null> = {};
      for (const key of [
        "batchSha256",
        "manifestIdentitySha256",
        "manifestContentBindingsSha256",
        "codeInventorySha256",
        "codeInventoryEntryCount",
      ]) {
        bindings[key] = (inputBindings as Record<string, unknown>)[key] ?? null;
      }
      const shard = {
        version: 1,
        generatedAt: new Date().toISOString(),
        route: "formal",
        headCommit: acceptanceCommit,
        preflightReceiptFileSha256: runnerTemplate.preflightReceiptSha256,
        phase2ReceiptFileSha256: runnerTemplate.phase2ReceiptSha256,
        formalReceiptFileSha256: sha256Hex(formalReceiptBytes),
        formalExitCode: 0,
        // 合成库上的通过永远只表示实现就绪；真实 PASS 只能来自正式目标库。
        formalTargetSynthetic: formalDatabaseName.startsWith("urmotiv_formal_"),
        formalVerdict: formalDatabaseName.startsWith("urmotiv_formal_")
          ? "SYNTHETIC_READINESS"
          : "REAL_PASS",
        bindings,
      };
      await writeFile(
        join(acceptanceDirectory, "shard-runner.private.json"),
        `${JSON.stringify(shard, null, 2)}\n`,
      );
    }
  } finally {
    for (const extraDrop of extraProductionDrops) {
      await formalAdmin.execute(
        sql`drop database if exists ${sql.identifier(extraDrop)} with (force)`,
      );
    }
    await formalAdmin.execute(
      sql`drop database if exists ${sql.identifier(formalDatabaseName)} with (force)`,
    );
    formalDropped = true;
    await formalAdmin.close();
  }
    expect(formalDropped).toBe(true);
  }, 300_000);
  it("Gate 6 延迟终止与残留验证：活动连接异步回收后快照成功，清理后全部族成员消失", async () => {
    assertNode24();
    if (adminUrl === undefined) throw new Error("缺少 PostgreSQL 管理连接配置。");
    const g6Name = scratchName("g6src");
    trackDatabaseFamily(g6Name);
    await prepareHistoryImportDatabase(adminUrl, g6Name);
    const scratchConnStr = historyImportDatabaseConnectionString(adminUrl, g6Name);

    // 先捕获空 scratch 库的实际内容清单作为快照比对基线。
    const baselineDb = createPostgresDatabase({ connectionString: scratchConnStr, maxConnections: 1 });
    const baselineInventory = await captureDatabaseContentInventory(
      baselineDb,
      historyImportRequiredTables,
    );
    await baselineDb.close();

    // 在 scratch 库上打开一个长连接，模拟异步后端：先查询保持会话存活，
    // 然后在 setTimeout 后关闭。snapshotScratchDatabase 内部的
    // terminateConnections 应轮询 pg_stat_activity 直到归零后再建快照。
    const holdDb = createPostgresDatabase({ connectionString: scratchConnStr, maxConnections: 1 });
    // 抑制 pg_terminate_backend 引起的预期连接错误事件，避免 unhandled rejection。
    holdDb.client.on("error", () => { /* 预期被终止 */ });
    await holdDb.execute(sql`select 1`);
    // 延迟 800ms 关闭——超过 3 个轮询周期（250ms × 3），验证轮询确实等待。
    const holdClose = new Promise<void>((resolve) => {
      setTimeout(() => { holdDb.close().then(() => resolve()).catch(() => resolve()); }, 800);
    });

    // 快照应成功：terminateConnections 轮询等待活动连接归零。
    const snapshotInventory = await snapshotScratchDatabase(
      adminUrl,
      g6Name,
      historyImportRequiredTables,
      baselineInventory,
    );
    expect(snapshotInventory.tableCount).toBe(historyImportRequiredTables.length);
    await holdClose;

    // 断言快照库存在。
    const checkAdmin = createPostgresDatabase({ connectionString: adminUrl, maxConnections: 1 });
    expect(await databaseExists(checkAdmin, `${g6Name}__snapshot`)).toBe(true);
    await checkAdmin.close();

    // 清理：删除快照和 scratch 库，然后断言全部族成员消失。
    await dropScratchSnapshot(adminUrl, g6Name);
    await dropHistoryImportDatabase(adminUrl, g6Name);

    // Gate 6 残留断言：逐一检查每个跟踪的族成员在 pg_database 中已消失。
    const verifyAdmin = createPostgresDatabase({ connectionString: adminUrl, maxConnections: 1 });
    for (const member of [
      g6Name,
      `${g6Name}__snapshot`,
      `${g6Name}__snapshot_g1`,
      `${g6Name}__snapshot_g2`,
      `${g6Name}__restore`,
      `${g6Name}__failed`,
    ]) {
      expect(await databaseExists(verifyAdmin, member)).toBe(false);
    }
    await verifyAdmin.close();
  }, 120_000);
});

const faultInjectDescribe =
  process.env.URMOTIV_TEST_PG_FAULT_INJECT === "1" && adminUrl !== undefined
    ? describe
    : describe.skip;
faultInjectDescribe(
  "PG 清理持久失败验证（故障注入：首次删除失败，后续恢复，套件仍失败）",
  () => {
    it("通过真实 drop/catch 路径注入首次删除失败，后续尽力删除成功，套件仍失败且最终残留为零", async () => {
      const faultDbName = scratchName("fault_inject");
      registerDatabase(faultDbName);
      const faultAdmin = createPostgresDatabase({ connectionString: adminUrl!, maxConnections: 1 });
      await faultAdmin.execute(sql`create database ${sql.identifier(faultDbName)}`);
      await faultAdmin.close();

      // 故障注入：保持一个连接到目标库。dropHistoryImportDatabase 使用
      // DROP DATABASE IF EXISTS（无 WITH (FORCE)），存在活动连接时会失败。
      // 这让真实 afterEach 清理路径的 catch 块被触发。
      const holdConn = createPostgresDatabase({
        connectionString: historyImportDatabaseConnectionString(adminUrl!, faultDbName),
        maxConnections: 1,
      });
      // 强制连接池立即建立连接并保持，使 DROP DATABASE 因活动连接而失败。
      await holdConn.execute(sql`select 1 as keepalive`);
      // 真实清理路径（与 afterEach 相同）：dropHistoryImportDatabase 失败 → catch。
      try {
        await dropHistoryImportDatabase(adminUrl!, faultDbName);
      } catch {
        cleanupEverFailed = true;
      }
      // stillExists 检查（与 afterEach 相同）。
      const checkAdmin = createPostgresDatabase({ connectionString: adminUrl!, maxConnections: 1 });
      const stillExists = await databaseExistsByName(checkAdmin, faultDbName);
      await checkAdmin.close();
      if (stillExists) {
        cleanupEverFailed = true;
      }
      expect(cleanupEverFailed).toBe(true);

      // 释放连接后尽力删除（后续恢复）。
      await holdConn.close();
      await dropHistoryImportDatabase(adminUrl!, faultDbName);
      const idx = temporaryDatabaseNames.indexOf(faultDbName);
      if (idx !== -1) temporaryDatabaseNames.splice(idx, 1);

      // 最终状态：残留为零，列表清空，但 cleanupEverFailed 仍为 true。
      const finalCheck = createPostgresDatabase({ connectionString: adminUrl!, maxConnections: 1 });
      const finalExists = await databaseExistsByName(finalCheck, faultDbName);
      await finalCheck.close();
      expect(finalExists).toBe(false);
      expect(temporaryDatabaseNames.length).toBe(0);
      expect(cleanupEverFailed).toBe(true);
      // afterAll 将因 cleanupEverFailed === true 抛出——预期行为。
    }, 60_000);
  },
);
