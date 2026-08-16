import { randomUUID } from "node:crypto";
import {
  createPostgresDatabase,
  migrateDatabase,
  seedCoreDatabase,
  type PostgresDatabaseHandle,
} from "@urmotiv/database";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { databaseDemoUserIds, seedDatabaseDemoData } from "../src/database-demo";
import { DatabaseDataStore } from "../src/database-store";
import { ProblemService } from "../src/service";
import { DatabaseTagCatalogService } from "../src/tag-catalog-service";
// 不再需要 registerOwnedDatabase——隔离集群方案中数据库在一次性容器内创建。

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

function deferred<T = void>(): { promise: Promise<T>; resolve: (value?: T) => void } {
  let resolve = (_value?: T): void => undefined;
  const promise = new Promise<T>((innerResolve) => {
    resolve = (value?: T) => innerResolve(value as T);
  });
  return { promise, resolve };
}

async function waitForBlockedLock(
  database: PostgresDatabaseHandle,
  applicationName: string,
): Promise<boolean> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const rows = await database.query<{ waiting: number }>(sql`
      SELECT count(*)::integer AS waiting
      FROM pg_stat_activity
      WHERE datname = current_database()
        AND application_name = ${applicationName}
        AND wait_event_type = 'Lock'
    `);
    if (Number(rows[0]?.waiting ?? 0) > 0) {
      return true;
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
  return false;
}

describePostgres("知识点目录服务的真实 PostgreSQL 竞态", () => {
  let databaseName = "";
  let primary: PostgresDatabaseHandle | undefined;
  let concurrent: PostgresDatabaseHandle | undefined;
  let primaryCatalog: DatabaseTagCatalogService | undefined;
  let concurrentCatalog: DatabaseTagCatalogService | undefined;

  beforeAll(async () => {
    if (adminUrl === undefined) return;
    databaseName = `urmotiv_tag_api_${process.pid}_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
    if (!/^urmotiv_tag_api_[a-z0-9_]+$/u.test(databaseName)) {
      throw new Error("测试数据库名称无效。");
    }
    const admin = createPostgresDatabase({
      connectionString: adminUrl,
      maxConnections: 1,
      applicationName: "urmotiv-tag-api-admin",
    });
    try {
      await admin.execute(sql`CREATE DATABASE ${sql.identifier(databaseName)}`);
      // 隔离集群方案中无需登记——容器拆除即清理。
    } finally {
      await admin.close();
    }
    const connectionString = databaseConnectionString(adminUrl, databaseName);
    primary = createPostgresDatabase({
      connectionString,
      maxConnections: 4,
      statementTimeoutMs: 10_000,
      applicationName: "urmotiv-tag-api-primary",
    });
    concurrent = createPostgresDatabase({
      connectionString,
      maxConnections: 4,
      statementTimeoutMs: 10_000,
      applicationName: "urmotiv-tag-api-concurrent",
    });
    await migrateDatabase(primary);
    await seedCoreDatabase(primary);
    await seedDatabaseDemoData(primary);
    primaryCatalog = new DatabaseTagCatalogService(primary);
    concurrentCatalog = new DatabaseTagCatalogService(concurrent);
  });

  afterAll(async () => {
    await primary?.close();
    await concurrent?.close();
    if (adminUrl === undefined || databaseName.length === 0) return;
    const admin = createPostgresDatabase({
      connectionString: adminUrl,
      maxConnections: 1,
      applicationName: "urmotiv-tag-api-cleanup",
    });
    try {
      await admin.execute(sql`DROP DATABASE ${sql.identifier(databaseName)}`);
    } finally {
      await admin.close();
    }
  });

  it("撤权先持锁时管理请求等待提交后拒绝，版本与审计均不变化", async () => {
    if (primary === undefined || concurrentCatalog === undefined) {
      throw new Error("未建立真实 PostgreSQL 测试数据库。");
    }
    const revoked = deferred();
    const releaseRevocation = deferred();
    const leaderId = BigInt(databaseDemoUserIds.leader);
    const revocation = primary.transaction(async (transaction) => {
      await transaction.query<{ id: string }>(sql`
        SELECT id::text AS id FROM users WHERE id = ${leaderId} FOR UPDATE
      `);
      await transaction.query<{ id: string }>(sql`
        SELECT id::text AS id
        FROM role_memberships
        WHERE user_id = ${leaderId}
        ORDER BY id
        FOR UPDATE
      `);
      await transaction.execute(sql`
        UPDATE role_memberships
        SET revoked_at = now(), revoked_by_user_id = 0
        WHERE user_id = ${leaderId} AND revoked_at IS NULL
      `);
      revoked.resolve();
      await releaseRevocation.promise;
    });
    await revoked.promise;
    const denied = concurrentCatalog.createItem(
      databaseDemoUserIds.leader,
      randomUUID(),
      {
        expectedVersion: 1,
        id: "test.tag.revoked-race",
        itemKind: "tag",
        parentId: "catalog.category.01",
        name: "撤权竞态合成标签",
        description: "",
        sortOrder: 0,
      },
    );
    expect(await waitForBlockedLock(primary, "urmotiv-tag-api-concurrent")).toBe(true);
    releaseRevocation.resolve();
    await revocation;
    await expect(denied).rejects.toMatchObject({ statusCode: 403, code: "FORBIDDEN" });
    expect(await primary.query<{ version: number }>(sql`
      SELECT version FROM tag_catalog_state WHERE singleton = true
    `)).toEqual([{ version: 1 }]);
    expect(await primary.query<{ count: number }>(sql`
      SELECT count(*)::integer AS count FROM tags WHERE id = 'test.tag.revoked-race'
    `)).toEqual([{ count: 0 }]);
    expect(await primary.query<{ count: number }>(sql`
      SELECT count(*)::integer AS count
      FROM audit_events
      WHERE object_id = 'test.tag.revoked-race'
    `)).toEqual([{ count: 0 }]);
  });

  it("同版本管理写入只提交一个，旧预览在当前修订并发变化后完整回滚", async () => {
    if (
      primary === undefined
      || concurrent === undefined
      || primaryCatalog === undefined
      || concurrentCatalog === undefined
    ) {
      throw new Error("未建立真实 PostgreSQL 测试数据库。");
    }
    const administrator = databaseDemoUserIds.administrator;
    const attempts = await Promise.allSettled([
      primaryCatalog.createItem(administrator, randomUUID(), {
        expectedVersion: 1,
        id: "test.tag.pg-race-a",
        itemKind: "tag",
        parentId: "catalog.category.01",
        name: "目录版本竞态甲",
        description: "",
        sortOrder: 901,
      }),
      concurrentCatalog.createItem(administrator, randomUUID(), {
        expectedVersion: 1,
        id: "test.tag.pg-race-b",
        itemKind: "tag",
        parentId: "catalog.category.01",
        name: "目录版本竞态乙",
        description: "",
        sortOrder: 902,
      }),
    ]);
    expect(attempts.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(attempts.filter((result) => result.status === "rejected")).toHaveLength(1);
    const rejected = attempts.find((result) => result.status === "rejected");
    expect(rejected).toMatchObject({ reason: { statusCode: 409, code: "CONFLICT" } });
    const createdRows = await primary.query<{ id: string }>(sql`
      SELECT id
      FROM tags
      WHERE id IN ('test.tag.pg-race-a', 'test.tag.pg-race-b')
      ORDER BY id
    `);
    expect(createdRows).toHaveLength(1);
    const targetTagId = createdRows[0]?.id;
    if (targetTagId === undefined) {
      throw new Error("并发创建没有留下目标标签。");
    }
    expect(await primary.query<{ version: number }>(sql`
      SELECT version FROM tag_catalog_state WHERE singleton = true
    `)).toEqual([{ version: 2 }]);

    const store = new DatabaseDataStore(primary);
    const problemService = new ProblemService(store);
    const author = await store.getUser(databaseDemoUserIds.author);
    if (author === undefined) throw new Error("演示作者缺失。");
    const problem = await problemService.createProblem(author, {
      title: "真实数据库并发合成题",
      type: "traditional",
      tagIds: [targetTagId, "catalog.tag.01.01"],
      codeforcesDifficulty: null,
      thinkingLevel: null,
      codingLevel: null,
      content: {
        basicStatement: "合成题面",
        basicSolution: "合成题解",
        background: "",
        statement: "",
        inputFormat: "",
        outputFormat: "",
        constraints: "",
        solution: "",
        hints: "",
      },
    });
    const preview = await primaryCatalog.previewDeactivation(administrator, targetTagId);

    const revisionChanged = deferred();
    const releaseRevision = deferred();
    const concurrentRevision = problemService.updateProblem(
      author,
      problem.id,
      {
        expectedRevision: problem.revision,
        content: { ...problem.content, background: "合法的并发非标签修订" },
      },
      async () => {
        // Pause after the normal immutable revision and its unchanged tag set
        // have been written, but before that transaction commits.
        revisionChanged.resolve();
        await releaseRevision.promise;
      },
    );
    await revisionChanged.promise;
    const confirmation = concurrentCatalog.confirmDeactivation(
      administrator,
      randomUUID(),
      targetTagId,
      preview.confirmationId,
      preview.catalogVersion,
    );
    expect(await waitForBlockedLock(primary, "urmotiv-tag-api-concurrent")).toBe(true);
    releaseRevision.resolve();
    await concurrentRevision;
    await expect(confirmation).rejects.toMatchObject({ statusCode: 409, code: "CONFLICT" });

    expect(await primary.query<{ version: number }>(sql`
      SELECT version FROM tag_catalog_state WHERE singleton = true
    `)).toEqual([{ version: 2 }]);
    expect(await primary.query<{ is_active: boolean }>(sql`
      SELECT is_active FROM tags WHERE id = ${targetTagId}
    `)).toEqual([{ is_active: true }]);
    expect(await primary.query<{ count: number }>(sql`
      SELECT count(*)::integer AS count
      FROM audit_events
      WHERE action = 'tag.catalog.deactivate' AND object_id = ${targetTagId}
    `)).toEqual([{ count: 0 }]);

    const freshPreview = await primaryCatalog.previewDeactivation(administrator, targetTagId);
    await expect(primaryCatalog.confirmDeactivation(
      administrator,
      randomUUID(),
      targetTagId,
      freshPreview.confirmationId,
      freshPreview.catalogVersion,
    )).resolves.toEqual({ version: 3 });
    expect(await primary.query<{ current_revision: number }>(sql`
      SELECT current_revision FROM problems WHERE id = ${BigInt(problem.id)}
    `)).toEqual([{ current_revision: problem.revision + 2 }]);
    expect(await primary.query<{ is_active: boolean }>(sql`
      SELECT is_active FROM tags WHERE id = ${targetTagId}
    `)).toEqual([{ is_active: false }]);
  });

  it("目录管理先锁版本和标签时普通修订在锁题目前等待，避免反向死锁", async () => {
    if (primary === undefined || concurrent === undefined) {
      throw new Error("未建立真实 PostgreSQL 测试数据库。");
    }
    const primaryStore = new DatabaseDataStore(primary);
    const concurrentProblems = new ProblemService(new DatabaseDataStore(concurrent));
    const author = await primaryStore.getUser(databaseDemoUserIds.author);
    if (author === undefined) throw new Error("演示作者缺失。");
    const problem = await new ProblemService(primaryStore).createProblem(author, {
      title: "目录锁序合成题",
      type: "traditional",
      tagIds: ["catalog.tag.01.01"],
      codeforcesDifficulty: null,
      thinkingLevel: null,
      codingLevel: null,
      content: {
        basicStatement: "合成题面",
        basicSolution: "合成题解",
        background: "",
        statement: "",
        inputFormat: "",
        outputFormat: "",
        constraints: "",
        solution: "",
        hints: "",
      },
    });

    const catalogLocked = deferred();
    const inspectProblemLock = deferred();
    const manager = primary.transaction(async (transaction) => {
      await transaction.query<{ version: number }>(sql`
        SELECT version FROM tag_catalog_state WHERE singleton = true FOR UPDATE
      `);
      await transaction.query<{ id: string }>(sql`
        SELECT id FROM tags WHERE id = 'catalog.tag.01.01' FOR UPDATE
      `);
      catalogLocked.resolve();
      await inspectProblemLock.promise;
      const freelyLocked = await transaction.query<{ id: string }>(sql`
        SELECT id::text AS id
        FROM problems
        WHERE id = ${BigInt(problem.id)}
        FOR UPDATE NOWAIT
      `);
      expect(freelyLocked).toEqual([{ id: problem.id }]);
    });
    await catalogLocked.promise;

    const update = concurrentProblems.updateProblem(author, problem.id, {
      expectedRevision: problem.revision,
      content: { ...problem.content, background: "锁序更新" },
    });
    expect(await waitForBlockedLock(primary, "urmotiv-tag-api-concurrent")).toBe(true);
    inspectProblemLock.resolve();
    await manager;
    await expect(update).resolves.toMatchObject({ revision: problem.revision + 1 });
  });
});
