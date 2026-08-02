import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createPostgresDatabase,
  migrateDatabase,
  seedCoreDatabase,
  type PostgresDatabaseHandle
} from "@urmotiv/database";
import { canonicalProblemSchema } from "@urmotiv/problem-package";
import { LocalFileStorage } from "@urmotiv/storage";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { databaseDemoUserIds, seedDatabaseDemoData } from "../src/database-demo";
import { DatabaseDataStore } from "../src/database-store";
import { DatabaseProblemPackageJobStore } from "../src/problem-package-job-store";
import { DatabaseProblemPackageAuditWriter } from "../src/problem-package-audit";
import { DatabaseImportedProblemWriter } from "../src/problem-package-runtime";
import { ProblemFileStore } from "../src/problem-file-store";

const adminUrl = process.env.URMOTIV_TEST_POSTGRES_ADMIN_URL;
const describePostgres = adminUrl === undefined ? describe.skip : describe;

function databaseConnectionString(connectionString: string, databaseName: string): string {
  const queryIndex = connectionString.indexOf("?");
  const endpoint = queryIndex === -1 ? connectionString : connectionString.slice(0, queryIndex);
  const query = queryIndex === -1 ? "" : connectionString.slice(queryIndex);
  const separator = endpoint.lastIndexOf("/");
  if (separator < "postgresql://".length) {
    throw new Error("测试数据库连接地址无效。");
  }
  return `${endpoint.slice(0, separator + 1)}${databaseName}${query}`;
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve = (): void => undefined;
  const promise = new Promise<void>((innerResolve) => {
    resolve = innerResolve;
  });
  return { promise, resolve };
}

async function waitForBlockedLock(
  database: PostgresDatabaseHandle,
  applicationName: string
): Promise<boolean> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const rows = await database.query<{ waiting: number }>(sql`
      SELECT count(*)::integer AS waiting
      FROM pg_stat_activity
      WHERE datname = current_database()
        AND application_name = ${applicationName}
        AND wait_event_type = 'Lock'
    `);
    if (Number(rows[0]?.waiting ?? 0) > 0) return true;
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
  return false;
}

const syntheticProblem = canonicalProblemSchema.parse({
  title: "并发撤权合成题",
  type: "traditional",
  tags: ["catalog.tag.02.09"],
  difficulty: {},
  content: {
    basicStatement: "合成题面。",
    basicSolution: "合成题解。",
    background: "",
    statement: "",
    inputFormat: "",
    outputFormat: "",
    constraints: "",
    solution: "",
    hints: ""
  },
  samples: [],
  files: [],
  extensions: {}
});

describePostgres("题目包导入权限的真实 PostgreSQL 竞态", () => {
  let databaseName = "";
  let primary: PostgresDatabaseHandle | undefined;
  let concurrent: PostgresDatabaseHandle | undefined;
  let storageRoot = "";

  beforeAll(async () => {
    if (adminUrl === undefined) return;
    databaseName = `urmotiv_package_auth_${process.pid}_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
    if (!/^urmotiv_package_auth_[a-z0-9_]+$/u.test(databaseName)) {
      throw new Error("测试数据库名称无效。");
    }
    const admin = createPostgresDatabase({
      connectionString: adminUrl,
      maxConnections: 1,
      applicationName: "urmotiv-package-auth-admin"
    });
    try {
      await admin.execute(sql`CREATE DATABASE ${sql.identifier(databaseName)}`);
    } finally {
      await admin.close();
    }
    const connectionString = databaseConnectionString(adminUrl, databaseName);
    primary = createPostgresDatabase({
      connectionString,
      maxConnections: 4,
      statementTimeoutMs: 10_000,
      applicationName: "urmotiv-package-auth-primary"
    });
    concurrent = createPostgresDatabase({
      connectionString,
      maxConnections: 4,
      statementTimeoutMs: 10_000,
      applicationName: "urmotiv-package-auth-concurrent"
    });
    storageRoot = await mkdtemp(join(tmpdir(), "urmotiv-package-auth-"));
    await migrateDatabase(primary);
    await seedCoreDatabase(primary);
    await seedDatabaseDemoData(primary);
  });

  afterAll(async () => {
    await primary?.close();
    await concurrent?.close();
    if (storageRoot.length > 0) {
      await rm(storageRoot, { recursive: true, force: true });
    }
    if (adminUrl === undefined || databaseName.length === 0) return;
    const admin = createPostgresDatabase({
      connectionString: adminUrl,
      maxConnections: 1,
      applicationName: "urmotiv-package-auth-cleanup"
    });
    try {
      await admin.execute(sql`DROP DATABASE ${sql.identifier(databaseName)}`);
    } finally {
      await admin.close();
    }
  });

  it("遵守用户行优先协议的撤权先提交时，最终导入事务等待后完整拒绝", async () => {
    if (primary === undefined || concurrent === undefined) {
      throw new Error("未建立真实 PostgreSQL 测试数据库。");
    }
    const requesterId = databaseDemoUserIds.leader;
    const sourceFileId = randomUUID();
    const inputDigest = "a".repeat(64);
    const primaryMetadata = new ProblemFileStore(primary);
    await primaryMetadata.createStoredFile({
      id: sourceFileId,
      purpose: "import_input",
      storageKey: `synthetic/${sourceFileId}`,
      originalName: "synthetic.zip",
      mediaType: "application/zip",
      byteSize: 0,
      sha256: inputDigest,
      createdByUserId: requesterId,
      expiresAt: new Date(Date.now() + 60_000).toISOString()
    });
    const jobs = new DatabaseProblemPackageJobStore(primary);
    const job = await jobs.createImportJob({
      requestedByUserId: requesterId,
      clientRequestDigest: "b".repeat(64),
      sourceFileId,
      inputDigest,
      selectedFormat: "urmotiv",
      selectedFormatVersion: "1.0.0",
      choices: { conflictAction: "create" },
      itemCount: 1,
      idempotencyKey: "postgres-import-revocation-race"
    });
    await jobs.startImportJob(job.id);
    const beforeProblems = await primary.query<{ count: number }>(sql`
      SELECT count(*)::integer AS count FROM problems
    `);

    const denyInserted = deferred();
    const releaseRevocation = deferred();
    const revocation = primary.transaction(async (transaction) => {
      await transaction.query<{ id: string }>(sql`
        SELECT id::text AS id
        FROM users
        WHERE id = ${BigInt(requesterId)}
        FOR UPDATE
      `);
      await transaction.execute(sql`
        INSERT INTO permission_grants (
          id, subject_user_id, permission_name, effect, scope,
          granted_by_user_id, reason
        ) VALUES (
          ${randomUUID()}::uuid, ${BigInt(requesterId)},
          'problem.import', 'deny', 'global', 0, '测试：遵守用户行优先协议撤权'
        )
      `);
      denyInserted.resolve();
      await releaseRevocation.promise;
    });
    await denyInserted.promise;

    const storage = new LocalFileStorage({
      rootDirectory: storageRoot,
      limits: { maxBytes: 1024 * 1024 }
    });
    const writer = new DatabaseImportedProblemWriter({
      database: concurrent,
      store: new DatabaseDataStore(concurrent),
      metadata: new ProblemFileStore(concurrent),
      storage,
      audit: new DatabaseProblemPackageAuditWriter(concurrent)
    });
    const write = writer
      .write({
        importJobId: job.id,
        position: 0,
        requestedByUserId: requesterId,
        choices: { conflictAction: "create" },
        problem: syntheticProblem,
        signal: new AbortController().signal
      })
      .then(
        (value) => ({ value, error: undefined }),
        (error: unknown) => ({ value: undefined, error })
      );
    let blocked = false;
    try {
      blocked = await waitForBlockedLock(
        primary,
        "urmotiv-package-auth-concurrent"
      );
    } finally {
      releaseRevocation.resolve();
    }
    await revocation;

    expect(blocked).toBe(true);
    const { value, error: failure } = await write;
    expect(value).toBeUndefined();
    expect(failure).toMatchObject({
      name: "ImportAccessRevokedError",
      message: "当前已没有导入题目包的权限。"
    });
    expect(JSON.stringify(failure)).not.toContain(syntheticProblem.title);
    expect(JSON.stringify(failure)).not.toContain(syntheticProblem.content.basicStatement);
    expect(await primary.query<{ count: number }>(sql`
      SELECT count(*)::integer AS count FROM problems
    `)).toEqual(beforeProblems);
    expect(await primary.query<{ count: number }>(sql`
      SELECT count(*)::integer AS count
      FROM import_job_items
      WHERE job_id = ${job.id}::uuid
        AND imported_problem_id IS NOT NULL
    `)).toEqual([{ count: 0 }]);
    expect(await primary.query<{ count: number }>(sql`
      SELECT count(*)::integer AS count
      FROM audit_events
      WHERE request_id = ${job.id}::uuid
        AND action = 'problem.package.import.item.complete'
    `)).toEqual([{ count: 0 }]);
  });
});
