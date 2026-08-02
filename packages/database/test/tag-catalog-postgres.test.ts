import { randomUUID } from "node:crypto";
import { type SQL, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createPostgresDatabase,
  migrateDatabase,
  type PostgresDatabaseHandle,
  seedCoreDatabase,
} from "../src";

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

async function errorIncludes(operation: Promise<unknown>, expected: string): Promise<boolean> {
  try {
    await operation;
    return false;
  } catch (error) {
    let current: unknown = error;
    const seen = new Set<unknown>();
    while (typeof current === "object" && current !== null && !seen.has(current)) {
      seen.add(current);
      if ("message" in current && String(current.message).includes(expected)) return true;
      current = "cause" in current ? current.cause : undefined;
    }
    return false;
  }
}

function blockedOperation(
  database: PostgresDatabaseHandle,
  statement: SQL,
  expectedError: string,
): { backendPid: Promise<number>; result: Promise<boolean> } {
  const started = deferred<number>();
  const result = errorIncludes(
    database.transaction(async (transaction) => {
      const rows = await transaction.query<{ backend_pid: number }>(sql`
      SELECT pg_backend_pid()::integer AS backend_pid
    `);
      const backendPid = rows[0]?.backend_pid;
      if (!Number.isSafeInteger(backendPid) || backendPid === undefined) {
        throw new Error("无法取得并发测试连接编号。");
      }
      started.resolve(backendPid);
      await transaction.execute(statement);
    }),
    expectedError,
  );
  return { backendPid: started.promise, result };
}

async function waitForBlockedLock(
  database: PostgresDatabaseHandle,
  backendPid: number,
): Promise<boolean> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const rows = await database.query<{ waiting: number }>(sql`
      SELECT count(*)::integer AS waiting
      FROM pg_stat_activity
      WHERE pid = ${backendPid}
        AND datname = current_database()
        AND wait_event_type = 'Lock'
    `);
    if ((rows[0]?.waiting ?? 0) > 0) return true;
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
  return false;
}

async function expectCurrentTagBoundarySerialization(
  primary: PostgresDatabaseHandle,
  concurrent: PostgresDatabaseHandle,
  firstChange: SQL,
  secondChange: SQL,
): Promise<void> {
  const firstChanged = deferred();
  const secondChanged = deferred();
  const allowFirstValidation = deferred();
  const firstValidated = deferred();
  const allowSecondValidation = deferred();
  const releaseFirst = deferred();
  const secondStarted = deferred<number>();

  const firstTransaction = primary.transaction(async (transaction) => {
    await transaction.execute(firstChange);
    firstChanged.resolve();
    await allowFirstValidation.promise;
    await transaction.execute(sql`
      SET CONSTRAINTS problem_revision_tags_current_count_guard IMMEDIATE
    `);
    firstValidated.resolve();
    await releaseFirst.promise;
  });
  const secondResult = errorIncludes(
    concurrent.transaction(async (transaction) => {
      const rows = await transaction.query<{ backend_pid: number }>(sql`
        SELECT pg_backend_pid()::integer AS backend_pid
      `);
      const backendPid = rows[0]?.backend_pid;
      if (!Number.isSafeInteger(backendPid) || backendPid === undefined) {
        throw new Error("无法取得并发测试连接编号。");
      }
      secondStarted.resolve(backendPid);
      await transaction.execute(secondChange);
      secondChanged.resolve();
      await allowSecondValidation.promise;
      await transaction.execute(sql`
        SET CONSTRAINTS problem_revision_tags_current_count_guard IMMEDIATE
      `);
    }),
    "CURRENT_PROBLEM_TAG_COUNT_INVALID",
  );

  await Promise.all([firstChanged.promise, secondChanged.promise]);
  allowFirstValidation.resolve();
  await firstValidated.promise;
  allowSecondValidation.resolve();
  const waiting = await waitForBlockedLock(primary, await secondStarted.promise);
  releaseFirst.resolve();
  await firstTransaction;
  const rejectedAtBoundary = await secondResult;
  expect(waiting).toBe(true);
  expect(rejectedAtBoundary).toBe(true);
}

describePostgres("tag catalog locking on real PostgreSQL", () => {
  let databaseName = "";
  let primary: PostgresDatabaseHandle | undefined;
  let concurrent: PostgresDatabaseHandle | undefined;

  beforeAll(async () => {
    if (adminUrl === undefined) return;
    const nextDatabaseName = `urmotiv_tags_${process.pid}_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
    const admin = createPostgresDatabase({
      connectionString: adminUrl,
      maxConnections: 1,
      applicationName: "urmotiv-tag-test-admin",
    });
    try {
      await admin.execute(sql`CREATE DATABASE ${sql.identifier(nextDatabaseName)}`);
    } finally {
      await admin.close();
    }
    databaseName = nextDatabaseName;
    const connectionString = databaseConnectionString(adminUrl, databaseName);
    primary = createPostgresDatabase({
      connectionString,
      maxConnections: 2,
      statementTimeoutMs: 10_000,
      applicationName: "urmotiv-tag-test-primary",
    });
    concurrent = createPostgresDatabase({
      connectionString,
      maxConnections: 2,
      statementTimeoutMs: 10_000,
      applicationName: "urmotiv-tag-test-concurrent",
    });
    await migrateDatabase(primary);
    await seedCoreDatabase(primary);
    await primary.transaction(async (transaction) => {
      await transaction.execute(sql`
        INSERT INTO problems (id, owner_id, current_revision) VALUES (9301, 0, 1)
      `);
      await transaction.execute(sql`
        INSERT INTO problem_revisions (
          id, problem_id, revision, status, title, type, basic_statement, basic_solution,
          content_hash, change_reason, created_by_user_id
        ) VALUES
          ('93000000-0000-4000-8000-000000000001', 9301, 1, 'draft', '并发合成题一',
           'traditional', '合成题面', '合成题解', repeat('5', 64), '合成修订', 0),
          ('93000000-0000-4000-8000-000000000002', 9301, 2, 'draft', '并发合成题二',
           'traditional', '合成题面', '合成题解', repeat('6', 64), '合成修订', 0),
          ('93000000-0000-4000-8000-000000000003', 9301, 3, 'draft', '并发合成题三',
           'traditional', '合成题面', '合成题解', repeat('7', 64), '合成修订', 0)
      `);
      await transaction.execute(sql`
        INSERT INTO problem_revision_tags (revision_id, tag_id)
        VALUES ('93000000-0000-4000-8000-000000000001', 'catalog.tag.01.03')
      `);
    });
  });

  afterAll(async () => {
    await primary?.close();
    await concurrent?.close();
    if (adminUrl === undefined || databaseName.length === 0) return;
    const admin = createPostgresDatabase({
      connectionString: adminUrl,
      maxConnections: 1,
      applicationName: "urmotiv-tag-test-cleanup",
    });
    try {
      await admin.execute(sql`DROP DATABASE ${sql.identifier(databaseName)}`);
    } finally {
      await admin.close();
    }
  });

  it("serializes reference creation and deactivation in both lock orders", async () => {
    if (primary === undefined || concurrent === undefined) {
      throw new Error("未建立真实 PostgreSQL 测试数据库。");
    }

    const inserted = deferred();
    const releaseInsert = deferred();
    const referenceFirst = primary.transaction(async (transaction) => {
      await transaction.execute(sql`
        INSERT INTO problem_revision_tags (revision_id, tag_id)
        VALUES ('93000000-0000-4000-8000-000000000002', 'catalog.tag.01.01')
      `);
      inserted.resolve();
      await releaseInsert.promise;
      await transaction.execute(sql`
        UPDATE problems SET current_revision = 2 WHERE id = 9301
      `);
    });
    await inserted.promise;
    const blockedDeactivation = blockedOperation(
      concurrent,
      sql`
        UPDATE tags SET is_active = false WHERE id = 'catalog.tag.01.01'
      `,
      "TAG_STILL_USED_BY_CURRENT_REVISION",
    );
    expect(await waitForBlockedLock(primary, await blockedDeactivation.backendPid)).toBe(true);
    releaseInsert.resolve();
    await referenceFirst;
    expect(await blockedDeactivation.result).toBe(true);

    const deactivated = deferred();
    const releaseDeactivation = deferred();
    const deactivationFirst = primary.transaction(async (transaction) => {
      await transaction.execute(sql`
        UPDATE tags SET is_active = false WHERE id = 'catalog.tag.01.02'
      `);
      deactivated.resolve();
      await releaseDeactivation.promise;
    });
    await deactivated.promise;
    const blockedReference = blockedOperation(
      concurrent,
      sql`
        INSERT INTO problem_revision_tags (revision_id, tag_id)
        VALUES ('93000000-0000-4000-8000-000000000003', 'catalog.tag.01.02')
      `,
      "TAG_REFERENCE_REQUIRES_ACTIVE_LEAF",
    );
    expect(await waitForBlockedLock(primary, await blockedReference.backendPid)).toBe(true);
    releaseDeactivation.resolve();
    await deactivationFirst;
    expect(await blockedReference.result).toBe(true);

    const inactiveReferences = await primary.query<{ count: number }>(sql`
      SELECT count(*)::integer AS count
      FROM problem_revision_tags link
      JOIN tags tag ON tag.id = link.tag_id
      WHERE tag.is_active = false
    `);
    expect(inactiveReferences).toEqual([{ count: 0 }]);

    await primary.execute(sql`
      INSERT INTO problem_revision_tags (revision_id, tag_id) VALUES
        ('93000000-0000-4000-8000-000000000003', 'catalog.tag.01.04'),
        ('93000000-0000-4000-8000-000000000003', 'catalog.tag.01.05')
    `);

    const switched = deferred();
    const releaseSwitch = deferred();
    const switchFirst = primary.transaction(async (transaction) => {
      await transaction.execute(sql`
        UPDATE problems SET current_revision = 3 WHERE id = 9301
      `);
      await transaction.execute(sql`
        SET CONSTRAINTS problems_current_tag_count_guard IMMEDIATE
      `);
      switched.resolve();
      await releaseSwitch.promise;
    });
    await switched.promise;
    const blockedAfterSwitch = blockedOperation(
      concurrent,
      sql`UPDATE tags SET is_active = false WHERE id = 'catalog.tag.01.05'`,
      "TAG_STILL_USED_BY_CURRENT_REVISION",
    );
    expect(await waitForBlockedLock(primary, await blockedAfterSwitch.backendPid)).toBe(true);
    releaseSwitch.resolve();
    await switchFirst;
    expect(await blockedAfterSwitch.result).toBe(true);

    const deactivatedBeforeSwitch = deferred();
    const releaseBeforeSwitch = deferred();
    const deactivationBeforeSwitch = primary.transaction(async (transaction) => {
      await transaction.execute(sql`
        UPDATE tags SET is_active = false WHERE id = 'catalog.tag.01.03'
      `);
      deactivatedBeforeSwitch.resolve();
      await releaseBeforeSwitch.promise;
    });
    await deactivatedBeforeSwitch.promise;
    const switchStarted = deferred<number>();
    const blockedSwitchResult = errorIncludes(
      concurrent.transaction(async (transaction) => {
        const rows = await transaction.query<{ backend_pid: number }>(sql`
        SELECT pg_backend_pid()::integer AS backend_pid
      `);
        const backendPid = rows[0]?.backend_pid;
        if (!Number.isSafeInteger(backendPid) || backendPid === undefined) {
          throw new Error("无法取得并发测试连接编号。");
        }
        switchStarted.resolve(backendPid);
        await transaction.execute(sql`
        UPDATE problems SET current_revision = 1 WHERE id = 9301
      `);
        await transaction.execute(sql`
        SET CONSTRAINTS problems_current_tag_count_guard IMMEDIATE
      `);
      }),
      "CURRENT_PROBLEM_TAG_REFERENCE_INVALID",
    );
    expect(await waitForBlockedLock(primary, await switchStarted.promise)).toBe(true);
    releaseBeforeSwitch.resolve();
    await deactivationBeforeSwitch;
    expect(await blockedSwitchResult).toBe(true);

    const currentRevision = await primary.query<{ current_revision: number }>(sql`
      SELECT current_revision FROM problems WHERE id = 9301
    `);
    expect(currentRevision).toEqual([{ current_revision: 3 }]);

    await primary.execute(sql`
      INSERT INTO tags (
        id, parent_id, name, normalized_name, item_kind, group_name
      ) VALUES
        ('test.category.reference-first', NULL, '并发分类一', '并发分类一', 'category', '并发分类一'),
        ('test.category.deactivate-first', NULL, '并发分类二', '并发分类二', 'category', '并发分类二')
    `);

    const childInserted = deferred();
    const releaseChild = deferred();
    const childFirst = primary.transaction(async (transaction) => {
      await transaction.execute(sql`
        INSERT INTO tags (
          id, parent_id, name, normalized_name, item_kind, group_name
        ) VALUES (
          'test.tag.reference-first', 'test.category.reference-first',
          '并发子标签一', '并发子标签一', 'tag', '并发分类一'
        )
      `);
      childInserted.resolve();
      await releaseChild.promise;
    });
    await childInserted.promise;
    const blockedCategoryDeactivation = blockedOperation(
      concurrent,
      sql`
        UPDATE tags SET is_active = false WHERE id = 'test.category.reference-first'
      `,
      "TAG_CATEGORY_HAS_CHILDREN",
    );
    expect(await waitForBlockedLock(primary, await blockedCategoryDeactivation.backendPid)).toBe(
      true,
    );
    releaseChild.resolve();
    await childFirst;
    expect(await blockedCategoryDeactivation.result).toBe(true);

    const categoryDeactivated = deferred();
    const releaseCategory = deferred();
    const categoryFirst = primary.transaction(async (transaction) => {
      await transaction.execute(sql`
        UPDATE tags SET is_active = false WHERE id = 'test.category.deactivate-first'
      `);
      categoryDeactivated.resolve();
      await releaseCategory.promise;
    });
    await categoryDeactivated.promise;
    const blockedChildCreation = blockedOperation(
      concurrent,
      sql`
        INSERT INTO tags (
          id, parent_id, name, normalized_name, item_kind, group_name
        ) VALUES (
          'test.tag.deactivate-first', 'test.category.deactivate-first',
          '并发子标签二', '并发子标签二', 'tag', '并发分类二'
        )
      `,
      "TAG_PARENT_REQUIRES_ACTIVE_CATEGORY",
    );
    expect(await waitForBlockedLock(primary, await blockedChildCreation.backendPid)).toBe(true);
    releaseCategory.resolve();
    await categoryFirst;
    expect(await blockedChildCreation.result).toBe(true);
  });

  it("serializes concurrent changes at the one-tag and thirty-tag boundaries", async () => {
    if (primary === undefined || concurrent === undefined) {
      throw new Error("未建立真实 PostgreSQL 测试数据库。");
    }

    await primary.transaction(async (transaction) => {
      await transaction.execute(sql`
        INSERT INTO problems (id, owner_id, current_revision) VALUES
          (9311, 0, 1),
          (9321, 0, 1)
      `);
      await transaction.execute(sql`
        INSERT INTO problem_revisions (
          id, problem_id, revision, status, title, type, basic_statement, basic_solution,
          content_hash, change_reason, created_by_user_id
        ) VALUES
          ('93110000-0000-4000-8000-000000000001', 9311, 1, 'draft', '并发下界合成题',
           'traditional', '合成题面', '合成题解', repeat('a', 64), '合成修订', 0),
          ('93210000-0000-4000-8000-000000000001', 9321, 1, 'draft', '并发上界合成题',
           'traditional', '合成题面', '合成题解', repeat('b', 64), '合成修订', 0)
      `);
      await transaction.execute(sql`
        INSERT INTO problem_revision_tags (revision_id, tag_id)
        SELECT '93110000-0000-4000-8000-000000000001', id
        FROM tags
        WHERE item_kind = 'tag' AND is_active = true AND id LIKE 'catalog.tag.%'
        ORDER BY id
        LIMIT 2
      `);
      await transaction.execute(sql`
        INSERT INTO problem_revision_tags (revision_id, tag_id)
        SELECT '93210000-0000-4000-8000-000000000001', id
        FROM tags
        WHERE item_kind = 'tag' AND is_active = true AND id LIKE 'catalog.tag.%'
        ORDER BY id
        LIMIT 29
      `);
    });

    await expectCurrentTagBoundarySerialization(
      primary,
      concurrent,
      sql`
        DELETE FROM problem_revision_tags
        WHERE revision_id = '93110000-0000-4000-8000-000000000001'
          AND tag_id = (
            SELECT tag_id
            FROM problem_revision_tags
            WHERE revision_id = '93110000-0000-4000-8000-000000000001'
            ORDER BY tag_id
            LIMIT 1
          )
      `,
      sql`
        DELETE FROM problem_revision_tags
        WHERE revision_id = '93110000-0000-4000-8000-000000000001'
          AND tag_id = (
            SELECT tag_id
            FROM problem_revision_tags
            WHERE revision_id = '93110000-0000-4000-8000-000000000001'
            ORDER BY tag_id DESC
            LIMIT 1
          )
      `,
    );
    await expectCurrentTagBoundarySerialization(
      primary,
      concurrent,
      sql`
        INSERT INTO problem_revision_tags (revision_id, tag_id)
        SELECT '93210000-0000-4000-8000-000000000001', tag.id
        FROM tags tag
        WHERE tag.item_kind = 'tag'
          AND tag.is_active = true
          AND tag.id LIKE 'catalog.tag.%'
          AND NOT EXISTS (
            SELECT 1
            FROM problem_revision_tags link
            WHERE link.revision_id = '93210000-0000-4000-8000-000000000001'
              AND link.tag_id = tag.id
          )
        ORDER BY tag.id
        LIMIT 1
      `,
      sql`
        INSERT INTO problem_revision_tags (revision_id, tag_id)
        SELECT '93210000-0000-4000-8000-000000000001', tag.id
        FROM tags tag
        WHERE tag.item_kind = 'tag'
          AND tag.is_active = true
          AND tag.id LIKE 'catalog.tag.%'
          AND NOT EXISTS (
            SELECT 1
            FROM problem_revision_tags link
            WHERE link.revision_id = '93210000-0000-4000-8000-000000000001'
              AND link.tag_id = tag.id
          )
        ORDER BY tag.id DESC
        LIMIT 1
      `,
    );

    const counts = await primary.query<{ problem_id: string; tag_count: number }>(sql`
      SELECT revision.problem_id::text AS problem_id, count(*)::integer AS tag_count
      FROM problem_revisions revision
      JOIN problem_revision_tags link ON link.revision_id = revision.id
      WHERE revision.problem_id IN (9311, 9321)
      GROUP BY revision.problem_id
      ORDER BY revision.problem_id
    `);
    expect(counts).toEqual([
      { problem_id: "9311", tag_count: 1 },
      { problem_id: "9321", tag_count: 30 },
    ]);
  });

  it("serializes historical tag changes with making that revision current in both lock orders", async () => {
    if (primary === undefined || concurrent === undefined) {
      throw new Error("未建立真实 PostgreSQL 测试数据库。");
    }

    await primary.transaction(async (transaction) => {
      await transaction.execute(sql`
        INSERT INTO problems (id, owner_id, current_revision) VALUES
          (9331, 0, 1),
          (9341, 0, 1)
      `);
      await transaction.execute(sql`
        INSERT INTO problem_revisions (
          id, problem_id, revision, status, title, type, basic_statement, basic_solution,
          content_hash, change_reason, created_by_user_id
        ) VALUES
          ('93310000-0000-4000-8000-000000000001', 9331, 1, 'draft', '历史改动先行合成题一',
           'traditional', '合成题面', '合成题解', repeat('c', 64), '合成修订', 0),
          ('93310000-0000-4000-8000-000000000002', 9331, 2, 'draft', '历史改动先行合成题二',
           'traditional', '合成题面', '合成题解', repeat('d', 64), '合成修订', 0),
          ('93410000-0000-4000-8000-000000000001', 9341, 1, 'draft', '切换先行合成题一',
           'traditional', '合成题面', '合成题解', repeat('e', 64), '合成修订', 0),
          ('93410000-0000-4000-8000-000000000002', 9341, 2, 'draft', '切换先行合成题二',
           'traditional', '合成题面', '合成题解', repeat('f', 64), '合成修订', 0)
      `);
      await transaction.execute(sql`
        INSERT INTO problem_revision_tags (revision_id, tag_id) VALUES
          ('93310000-0000-4000-8000-000000000001', 'catalog.tag.02.01'),
          ('93310000-0000-4000-8000-000000000002', 'catalog.tag.02.02'),
          ('93410000-0000-4000-8000-000000000001', 'catalog.tag.02.01'),
          ('93410000-0000-4000-8000-000000000002', 'catalog.tag.02.02')
      `);
    });

    const historicalValidated = deferred();
    const releaseHistoricalChange = deferred();
    const historicalChangeFirst = primary.transaction(async (transaction) => {
      await transaction.execute(sql`
        DELETE FROM problem_revision_tags
        WHERE revision_id = '93310000-0000-4000-8000-000000000002'
          AND tag_id = 'catalog.tag.02.02'
      `);
      await transaction.execute(sql`
        SET CONSTRAINTS problem_revision_tags_current_count_guard IMMEDIATE
      `);
      historicalValidated.resolve();
      await releaseHistoricalChange.promise;
    });
    await historicalValidated.promise;
    const blockedSwitch = blockedOperation(
      concurrent,
      sql`UPDATE problems SET current_revision = 2 WHERE id = 9331`,
      "CURRENT_PROBLEM_TAG_COUNT_INVALID",
    );
    const switchWaited = await waitForBlockedLock(primary, await blockedSwitch.backendPid);
    releaseHistoricalChange.resolve();
    await historicalChangeFirst;
    const switchRejected = await blockedSwitch.result;
    expect(switchWaited).toBe(true);
    expect(switchRejected).toBe(true);

    const switchValidated = deferred();
    const releaseSwitch = deferred();
    const switchFirst = primary.transaction(async (transaction) => {
      await transaction.execute(sql`
        UPDATE problems SET current_revision = 2 WHERE id = 9341
      `);
      await transaction.execute(sql`
        SET CONSTRAINTS problems_current_tag_count_guard IMMEDIATE
      `);
      switchValidated.resolve();
      await releaseSwitch.promise;
    });
    await switchValidated.promise;
    const blockedHistoricalChange = blockedOperation(
      concurrent,
      sql`
        DELETE FROM problem_revision_tags
        WHERE revision_id = '93410000-0000-4000-8000-000000000002'
          AND tag_id = 'catalog.tag.02.02'
      `,
      "CURRENT_PROBLEM_TAG_COUNT_INVALID",
    );
    const historicalChangeWaited = await waitForBlockedLock(
      primary,
      await blockedHistoricalChange.backendPid,
    );
    releaseSwitch.resolve();
    await switchFirst;
    const historicalChangeRejected = await blockedHistoricalChange.result;
    expect(historicalChangeWaited).toBe(true);
    expect(historicalChangeRejected).toBe(true);

    const finalRows = await primary.query<{
      problem_id: string;
      current_revision: number;
      current_tag_count: number;
    }>(sql`
      SELECT
        problem.id::text AS problem_id,
        problem.current_revision,
        count(link.tag_id)::integer AS current_tag_count
      FROM problems problem
      JOIN problem_revisions revision
        ON revision.problem_id = problem.id
       AND revision.revision = problem.current_revision
      LEFT JOIN problem_revision_tags link ON link.revision_id = revision.id
      WHERE problem.id IN (9331, 9341)
      GROUP BY problem.id, problem.current_revision
      ORDER BY problem.id
    `);
    expect(finalRows).toEqual([
      { problem_id: "9331", current_revision: 1, current_tag_count: 1 },
      { problem_id: "9341", current_revision: 2, current_tag_count: 1 },
    ]);
  });
});
