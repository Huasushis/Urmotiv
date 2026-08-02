import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sql } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";
import {
  createLocalDatabase,
  type LocalDatabaseHandle,
  migrateDatabase,
  seedCoreDatabase,
} from "../src";

const databases: LocalDatabaseHandle[] = [];
const directories: string[] = [];

function createDatabase(): LocalDatabaseHandle {
  const database = createLocalDatabase();
  databases.push(database);
  return database;
}

function migrationFolderThrough(lastIndex: number): string {
  const source = new URL("../migrations/", import.meta.url);
  const directory = mkdtempSync(join(tmpdir(), "urmotiv-tag-migrations-"));
  directories.push(directory);
  mkdirSync(join(directory, "meta"), { recursive: true });
  const journal = JSON.parse(readFileSync(new URL("meta/_journal.json", source), "utf8")) as {
    entries: Array<{ idx: number; tag: string }>;
  };
  const entries = journal.entries.filter((entry) => entry.idx <= lastIndex);
  for (const entry of entries) {
    cpSync(new URL(`${entry.tag}.sql`, source), join(directory, `${entry.tag}.sql`));
  }
  writeFileSync(join(directory, "meta", "_journal.json"), JSON.stringify({ ...journal, entries }), {
    encoding: "utf8",
    mode: 0o600,
  });
  return directory;
}

afterEach(async () => {
  await Promise.all(databases.splice(0).map((database) => database.close()));
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("tag catalog migration", () => {
  it("installs the exact initial two-level catalog", async () => {
    const database = createDatabase();
    await migrateDatabase(database);

    const counts = await database.query<{
      categories: number;
      tags: number;
      version: number;
    }>(sql`
      SELECT
        count(*) FILTER (WHERE item_kind = 'category')::integer AS categories,
        count(*) FILTER (WHERE item_kind = 'tag')::integer AS tags,
        (SELECT version::integer FROM tag_catalog_state WHERE singleton = true) AS version
      FROM tags
    `);
    expect(counts).toEqual([{ categories: 22, tags: 243, version: 1 }]);

    const landmarks = await database.query<{
      id: string;
      name: string;
      parent_id: string | null;
      item_kind: string;
    }>(sql`
      SELECT id, name, parent_id, item_kind::text AS item_kind
      FROM tags
      WHERE id IN (
        'catalog.category.01', 'catalog.tag.01.01', 'catalog.tag.04.15',
        'catalog.tag.15.13', 'catalog.tag.22.08'
      )
      ORDER BY id
    `);
    expect(landmarks).toEqual([
      { id: "catalog.category.01", name: "基础", parent_id: null, item_kind: "category" },
      {
        id: "catalog.tag.01.01",
        name: "变量操作",
        parent_id: "catalog.category.01",
        item_kind: "tag",
      },
      {
        id: "catalog.tag.04.15",
        name: "最长公共子序列（LCS）",
        parent_id: "catalog.category.04",
        item_kind: "tag",
      },
      {
        id: "catalog.tag.15.13",
        name: "快速幂",
        parent_id: "catalog.category.15",
        item_kind: "tag",
      },
      { id: "catalog.tag.22.08", name: "贡献", parent_id: "catalog.category.22", item_kind: "tag" },
    ]);
  });

  it("upgrades the old demo groups into separate legacy categories without rewriting ids or references", async () => {
    const database = createDatabase();
    await migrateDatabase(database, { migrationsFolder: migrationFolderThrough(10) });
    await seedCoreDatabase(database);
    await database.transaction(async (transaction) => {
      await transaction.execute(sql`
        INSERT INTO tags (id, name, group_name, is_active) VALUES
          ('legacy.basic', '字符串', '基础', true),
          ('legacy.math', '数论', '数学', true)
      `);
      await transaction.execute(sql`
        INSERT INTO problems (id, owner_id, current_revision, current_review_round)
        VALUES (8901, 0, 1, 1)
      `);
      await transaction.execute(sql`
        INSERT INTO problem_revisions (
          id, problem_id, revision, status, title, type, basic_statement, basic_solution,
          content_hash, change_reason, created_by_user_id
        ) VALUES (
          '89000000-0000-4000-8000-000000000001', 8901, 1, 'draft', '旧演示合成题',
          'traditional', '合成题面', '合成题解', repeat('9', 64), '合成修订', 0
        )
      `);
      await transaction.execute(sql`
        INSERT INTO problem_revision_tags (revision_id, tag_id) VALUES
          ('89000000-0000-4000-8000-000000000001', 'legacy.basic'),
          ('89000000-0000-4000-8000-000000000001', 'legacy.math')
      `);
      await transaction.execute(sql`
        INSERT INTO review_rounds (
          id, problem_id, round, submitted_revision_id, status, rule_id, rule_version,
          submitted_by_user_id
        ) VALUES (
          '89000000-0000-4000-8000-000000000002', 8901, 1,
          '89000000-0000-4000-8000-000000000001', 'open', 'fixture', '1', 0
        )
      `);
      await transaction.execute(sql`
        INSERT INTO review_opinions (
          id, round_id, reviewer_user_id, source, verdict, codeforces_difficulty,
          quality_level, originality_level, thinking_level, coding_level, improvements
        ) VALUES (
          '89000000-0000-4000-8000-000000000003',
          '89000000-0000-4000-8000-000000000002', 0, 'human', 'approve', 1200,
          3, 3, 2, 2, '合成旧意见'
        )
      `);
      await transaction.execute(sql`
        INSERT INTO review_opinion_tags (opinion_id, tag_id)
        VALUES ('89000000-0000-4000-8000-000000000003', 'legacy.math')
      `);
    });
    await migrateDatabase(database);

    const rows = await database.query<{
      id: string;
      parent_id: string;
      parent_name: string;
      item_kind: string;
      revision_reference_count: number;
      opinion_reference_count: number;
    }>(sql`
      SELECT
        leaf.id,
        leaf.parent_id,
        parent.name AS parent_name,
        leaf.item_kind::text AS item_kind,
        (SELECT count(*)::integer FROM problem_revision_tags link WHERE link.tag_id = leaf.id)
          AS revision_reference_count,
        (SELECT count(*)::integer FROM review_opinion_tags link WHERE link.tag_id = leaf.id)
          AS opinion_reference_count
      FROM tags leaf
      JOIN tags parent ON parent.id = leaf.parent_id AND parent.item_kind = 'category'
      WHERE leaf.id IN ('legacy.basic', 'legacy.math')
      ORDER BY leaf.id
    `);
    expect(rows).toEqual([
      {
        id: "legacy.basic",
        parent_id: expect.stringMatching(/^legacy\.category\.[0-9a-f]{32}$/u),
        parent_name: expect.stringMatching(/^基础（旧分组 [0-9a-f]{8}）$/u),
        item_kind: "tag",
        revision_reference_count: 1,
        opinion_reference_count: 0,
      },
      {
        id: "legacy.math",
        parent_id: expect.stringMatching(/^legacy\.category\.[0-9a-f]{32}$/u),
        parent_name: expect.stringMatching(/^数学（旧分组 [0-9a-f]{8}）$/u),
        item_kind: "tag",
        revision_reference_count: 1,
        opinion_reference_count: 1,
      },
    ]);
    expect(rows[0]?.parent_id).not.toBe(rows[1]?.parent_id);
  });

  it.each([
    {
      label: "invalid stable id",
      insert: sql`INSERT INTO tags (id, name, group_name) VALUES ('INVALID ID', '合成标签', '合成旧分组')`,
      error: "TAG_CATALOG_STABLE_ID_INVALID",
    },
    {
      label: "normalized leaf name collision",
      insert: sql`
        INSERT INTO tags (id, name, group_name) VALUES
          ('legacy.one', 'KMP', '合成旧分组'),
          ('legacy.two', 'ＫＭＰ', '合成旧分组')
      `,
      error: "TAG_CATALOG_NORMALIZED_NAME_CONFLICT",
    },
    {
      label: "name made blank after NFKC and whitespace trimming",
      insert: sql`
        INSERT INTO tags (id, name, group_name)
        VALUES ('legacy.blank', E'\t　\t', '合成旧分组')
      `,
      error: "TAG_CATALOG_NORMALIZED_NAME_CONFLICT",
    },
  ])("fails with a fixed safe error for $label", async ({ insert, error }) => {
    const database = createDatabase();
    await migrateDatabase(database, { migrationsFolder: migrationFolderThrough(10) });
    await database.execute(insert);
    await expect(migrateDatabase(database)).rejects.toThrow(error);
  });

  it.each([
    { withInactiveTag: false, error: "TAG_CATALOG_CURRENT_TAG_COUNT_INVALID" },
    { withInactiveTag: true, error: "TAG_CATALOG_CURRENT_REFERENCE_INVALID" },
  ])("rejects invalid current revisions with $error", async ({ withInactiveTag, error }) => {
    const database = createDatabase();
    await migrateDatabase(database, { migrationsFolder: migrationFolderThrough(10) });
    await seedCoreDatabase(database);
    await database.transaction(async (transaction) => {
      await transaction.execute(sql`
        INSERT INTO problems (id, owner_id, current_revision) VALUES (9001, 0, 1)
      `);
      await transaction.execute(sql`
        INSERT INTO problem_revisions (
          id, problem_id, revision, status, title, type, basic_statement, basic_solution,
          content_hash, change_reason, created_by_user_id
        ) VALUES (
          '90000000-0000-4000-8000-000000000001', 9001, 1, 'draft', '迁移门禁合成题',
          'traditional', '合成题面', '合成题解', repeat('8', 64), '合成修订', 0
        )
      `);
      if (withInactiveTag) {
        await transaction.execute(sql`
          INSERT INTO tags (id, name, group_name, is_active)
          VALUES ('legacy.inactive', '合成停用标签', '合成迁移分组', false)
        `);
        await transaction.execute(sql`
          INSERT INTO problem_revision_tags (revision_id, tag_id)
          VALUES ('90000000-0000-4000-8000-000000000001', 'legacy.inactive')
        `);
      }
    });
    await expect(migrateDatabase(database)).rejects.toThrow(error);
  });
});

describe("tag catalog database invariants", () => {
  it("rejects category and inactive references while keeping inactive historical links readable", async () => {
    const database = createDatabase();
    await migrateDatabase(database);
    await seedCoreDatabase(database);

    await database.transaction(async (transaction) => {
      await transaction.execute(sql`
        INSERT INTO problems (id, owner_id, current_revision) VALUES (9101, 0, 1)
      `);
      await transaction.execute(sql`
        INSERT INTO problem_revisions (
          id, problem_id, revision, status, title, type, basic_statement, basic_solution,
          content_hash, change_reason, created_by_user_id
        ) VALUES
          ('91000000-0000-4000-8000-000000000001', 9101, 1, 'draft', '合成题一',
           'traditional', '合成题面', '合成题解', repeat('1', 64), '合成修订', 0),
          ('91000000-0000-4000-8000-000000000002', 9101, 2, 'draft', '合成题二',
           'traditional', '合成题面', '合成题解', repeat('2', 64), '合成修订', 0)
      `);
      await transaction.execute(sql`
        INSERT INTO problem_revision_tags (revision_id, tag_id) VALUES
          ('91000000-0000-4000-8000-000000000001', 'catalog.tag.01.01'),
          ('91000000-0000-4000-8000-000000000002', 'catalog.tag.01.02')
      `);
      await transaction.execute(sql`
        UPDATE problems SET current_revision = 2 WHERE id = 9101
      `);
      await transaction.execute(sql`
        INSERT INTO review_rounds (
          id, problem_id, round, submitted_revision_id, status, rule_id, rule_version,
          submitted_by_user_id
        ) VALUES (
          '91000000-0000-4000-8000-000000000010', 9101, 1,
          '91000000-0000-4000-8000-000000000001', 'open', 'fixture', '1', 0
        )
      `);
      await transaction.execute(sql`
        INSERT INTO review_opinions (
          id, round_id, reviewer_user_id, source, verdict, codeforces_difficulty,
          quality_level, originality_level, thinking_level, coding_level, improvements
        ) VALUES (
          '91000000-0000-4000-8000-000000000011',
          '91000000-0000-4000-8000-000000000010', 0, 'human', 'approve', 1200,
          3, 3, 2, 2, '合成历史意见'
        )
      `);
      await transaction.execute(sql`
        INSERT INTO review_opinion_tags (opinion_id, tag_id)
        VALUES ('91000000-0000-4000-8000-000000000011', 'catalog.tag.01.01')
      `);
    });

    await expect(
      database.execute(sql`
      INSERT INTO problem_revision_tags (revision_id, tag_id)
      VALUES ('91000000-0000-4000-8000-000000000002', 'catalog.category.01')
    `),
    ).rejects.toMatchObject({ cause: { message: "TAG_REFERENCE_REQUIRES_ACTIVE_LEAF" } });

    await database.execute(sql`
      UPDATE tags SET is_active = false WHERE id = 'catalog.tag.01.01'
    `);
    const historical = await database.query<{ name: string; is_active: boolean }>(sql`
      SELECT tag.name, tag.is_active
      FROM problem_revision_tags link
      JOIN tags tag ON tag.id = link.tag_id
      WHERE link.revision_id = '91000000-0000-4000-8000-000000000001'
    `);
    expect(historical).toEqual([{ name: "变量操作", is_active: false }]);
    const historicalOpinion = await database.query<{ name: string; is_active: boolean }>(sql`
      SELECT tag.name, tag.is_active
      FROM review_opinion_tags link
      JOIN tags tag ON tag.id = link.tag_id
      WHERE link.opinion_id = '91000000-0000-4000-8000-000000000011'
    `);
    expect(historicalOpinion).toEqual([{ name: "变量操作", is_active: false }]);

    await expect(
      database.execute(sql`
      INSERT INTO problem_revision_tags (revision_id, tag_id)
      VALUES ('91000000-0000-4000-8000-000000000002', 'catalog.tag.01.01')
    `),
    ).rejects.toMatchObject({ cause: { message: "TAG_REFERENCE_REQUIRES_ACTIVE_LEAF" } });
    await expect(
      database.execute(sql`
      UPDATE problem_revision_tags
      SET revision_id = '91000000-0000-4000-8000-000000000002'
      WHERE revision_id = '91000000-0000-4000-8000-000000000001'
        AND tag_id = 'catalog.tag.01.01'
    `),
    ).rejects.toMatchObject({ cause: { message: "TAG_REFERENCE_OWNER_IMMUTABLE" } });
    await expect(
      database.execute(sql`
      UPDATE review_opinion_tags
      SET opinion_id = '91000000-0000-4000-8000-000000000099'
      WHERE opinion_id = '91000000-0000-4000-8000-000000000011'
    `),
    ).rejects.toMatchObject({ cause: { message: "TAG_REFERENCE_OWNER_IMMUTABLE" } });
    await expect(
      database.execute(sql`
      UPDATE problem_revision_tags
      SET tag_id = tag_id
      WHERE revision_id = '91000000-0000-4000-8000-000000000001'
        AND tag_id = 'catalog.tag.01.01'
    `),
    ).rejects.toMatchObject({ cause: { message: "TAG_REFERENCE_REQUIRES_ACTIVE_LEAF" } });
    await expect(
      database.transaction(async (transaction) => {
        await transaction.execute(sql`
        UPDATE problems SET current_revision = 1 WHERE id = 9101
      `);
      }),
    ).rejects.toThrow("CURRENT_PROBLEM_TAG_REFERENCE_INVALID");
    await expect(
      database.execute(sql`
      UPDATE review_opinion_tags
      SET tag_id = 'catalog.category.01'
      WHERE opinion_id = '91000000-0000-4000-8000-000000000011'
    `),
    ).rejects.toMatchObject({ cause: { message: "TAG_REFERENCE_REQUIRES_ACTIVE_LEAF" } });
    await expect(
      database.execute(sql`
      INSERT INTO tag_aliases (id, tag_id, name, normalized_name)
      VALUES ('91000000-0000-4000-8000-000000000003', 'catalog.category.01', '合成别名', '合成别名')
    `),
    ).rejects.toMatchObject({ cause: { message: "TAG_ALIAS_REQUIRES_LEAF" } });
    await expect(
      database.execute(sql`
      INSERT INTO tag_aliases (id, tag_id, name, normalized_name)
      VALUES ('91000000-0000-4000-8000-000000000004', 'catalog.tag.01.01', '旧变量操作', '旧变量操作')
    `),
    ).resolves.toBeDefined();
  });

  it("enforces one through thirty distinct tags on every current revision at commit", async () => {
    const database = createDatabase();
    await migrateDatabase(database);
    await seedCoreDatabase(database);

    await expect(
      database.transaction(async (transaction) => {
        await transaction.execute(sql`
        INSERT INTO problems (id, owner_id, current_revision) VALUES (9201, 0, 1)
      `);
        await transaction.execute(sql`
        INSERT INTO problem_revisions (
          id, problem_id, revision, status, title, type, basic_statement, basic_solution,
          content_hash, change_reason, created_by_user_id
        ) VALUES (
          '92000000-0000-4000-8000-000000000001', 9201, 1, 'draft', '零标签合成题',
          'traditional', '合成题面', '合成题解', repeat('3', 64), '合成修订', 0
        )
      `);
      }),
    ).rejects.toThrow("CURRENT_PROBLEM_TAG_COUNT_INVALID");

    await expect(
      database.transaction(async (transaction) => {
        await transaction.execute(sql`
        INSERT INTO problems (id, owner_id, current_revision) VALUES (9202, 0, 1)
      `);
        await transaction.execute(sql`
        INSERT INTO problem_revisions (
          id, problem_id, revision, status, title, type, basic_statement, basic_solution,
          content_hash, change_reason, created_by_user_id
        ) VALUES (
          '92000000-0000-4000-8000-000000000002', 9202, 1, 'draft', '超量标签合成题',
          'traditional', '合成题面', '合成题解', repeat('4', 64), '合成修订', 0
        )
      `);
        await transaction.execute(sql`
        INSERT INTO problem_revision_tags (revision_id, tag_id)
        SELECT '92000000-0000-4000-8000-000000000002', id
        FROM tags WHERE item_kind = 'tag' AND is_active = true ORDER BY id LIMIT 31
      `);
      }),
    ).rejects.toThrow("CURRENT_PROBLEM_TAG_COUNT_INVALID");
  });

  it("locks the owning problem before deferred validation rereads its current tags", async () => {
    const database = createDatabase();
    await migrateDatabase(database);

    const functions = await database.query<{ body: string }>(sql`
      SELECT procedure.prosrc AS body
      FROM pg_proc procedure
      JOIN pg_namespace namespace ON namespace.oid = procedure.pronamespace
      WHERE namespace.nspname = 'public'
        AND procedure.proname = 'validate_current_problem_revision_tags'
    `);
    expect(functions).toHaveLength(1);
    const body = functions[0]?.body.replaceAll(/\s+/gu, " ") ?? "";
    const ownerLookup = body.indexOf("SELECT revision.problem_id INTO checked_problem_id");
    const problemLock = body.indexOf(
      "FROM public.problems problem WHERE problem.id = checked_problem_id FOR UPDATE",
    );
    const currentRevisionLookup = body.indexOf(
      "SELECT revision.id INTO checked_revision_id",
      problemLock,
    );
    const orderedTagLock = body.indexOf(
      "ORDER BY link.tag_id FOR SHARE OF tag",
      currentRevisionLookup,
    );
    expect(ownerLookup).toBeGreaterThanOrEqual(0);
    expect(problemLock).toBeGreaterThan(ownerLookup);
    expect(currentRevisionLookup).toBeGreaterThan(problemLock);
    expect(orderedTagLock).toBeGreaterThan(currentRevisionLookup);
    expect(body.slice(ownerLookup, problemLock)).not.toContain("current_revision");

    const triggers = await database.query<{
      name: string;
      deferrable: boolean;
      initially_deferred: boolean;
    }>(sql`
      SELECT
        tgname AS name,
        tgdeferrable AS deferrable,
        tginitdeferred AS initially_deferred
      FROM pg_trigger
      WHERE tgname IN (
        'problems_current_tag_count_guard',
        'problem_revision_tags_current_count_guard'
      )
      ORDER BY tgname
    `);
    expect(triggers).toEqual([
      {
        name: "problem_revision_tags_current_count_guard",
        deferrable: true,
        initially_deferred: true,
      },
      {
        name: "problems_current_tag_count_guard",
        deferrable: true,
        initially_deferred: true,
      },
    ]);
  });

  it("keeps item identity and kind immutable and rejects leaves under inactive categories", async () => {
    const database = createDatabase();
    await migrateDatabase(database);

    await database.execute(sql`
      INSERT INTO tags (
        id, parent_id, name, normalized_name, item_kind, group_name, is_active
      ) VALUES (
        'test.category.inactive', NULL, '合成空分类', '合成空分类',
        'category', '合成空分类', false
      )
    `);
    await expect(
      database.execute(sql`
      INSERT INTO tags (
        id, parent_id, name, normalized_name, item_kind, group_name
      ) VALUES (
        'test.tag.orphan', 'test.category.inactive', '合成孤立标签', '合成孤立标签',
        'tag', '合成空分类'
      )
    `),
    ).rejects.toMatchObject({ cause: { message: "TAG_PARENT_REQUIRES_ACTIVE_CATEGORY" } });
    await expect(
      database.execute(sql`
      UPDATE tags SET item_kind = 'tag', parent_id = 'catalog.category.01'
      WHERE id = 'catalog.category.22'
    `),
    ).rejects.toMatchObject({ cause: { message: "TAG_ITEM_KIND_IMMUTABLE" } });
    await expect(
      database.execute(sql`
      UPDATE tags SET id = 'catalog.tag.01.01.renamed'
      WHERE id = 'catalog.tag.01.01'
    `),
    ).rejects.toMatchObject({ cause: { message: "TAG_STABLE_ID_IMMUTABLE" } });
    await expect(
      database.execute(sql`
      INSERT INTO tag_aliases (id, tag_id, name, normalized_name)
      VALUES ('94000000-0000-4000-8000-000000000001', 'catalog.tag.01.01', ' ＫＭＰ ', 'ＫＭＰ')
    `),
    ).rejects.toThrow();
  });

  it("normalizes names after NFKC and whitespace trimming for items and aliases", async () => {
    const database = createDatabase();
    await migrateDatabase(database);

    await expect(
      database.execute(sql`
      INSERT INTO tags (
        id, parent_id, name, normalized_name, item_kind, group_name
      ) VALUES (
        'test.category.normalized', NULL, E'　ＡＢＣ\t', 'abc', 'category', '合成分组'
      )
    `),
    ).resolves.toBeDefined();
    await expect(
      database.execute(sql`
      INSERT INTO tags (
        id, parent_id, name, normalized_name, item_kind, group_name
      ) VALUES (
        'test.category.normalized-conflict', NULL, 'ABC', 'abc', 'category', '合成分组'
      )
    `),
    ).rejects.toThrow();
    await expect(
      database.execute(sql`
      INSERT INTO tags (
        id, parent_id, name, normalized_name, item_kind, group_name
      ) VALUES (
        'test.category.blank', NULL, E'\t　\t', '', 'category', '合成分组'
      )
    `),
    ).rejects.toThrow();

    await expect(
      database.execute(sql`
      INSERT INTO tag_aliases (id, tag_id, name, normalized_name)
      VALUES (
        '95000000-0000-4000-8000-000000000001', 'catalog.tag.01.01',
        E'\t　ＫＭＰ　', 'kmp'
      )
    `),
    ).resolves.toBeDefined();
    await expect(
      database.execute(sql`
      INSERT INTO tag_aliases (id, tag_id, name, normalized_name)
      VALUES (
        '95000000-0000-4000-8000-000000000002', 'catalog.tag.01.02', 'KMP', 'kmp'
      )
    `),
    ).rejects.toThrow();
    await expect(
      database.execute(sql`
      INSERT INTO tag_aliases (id, tag_id, name, normalized_name)
      VALUES (
        '95000000-0000-4000-8000-000000000003', 'catalog.tag.01.02', E'\t　', ''
      )
    `),
    ).rejects.toThrow();
  });

  it("never lets the reusable core seed restore or rename administrator-managed catalog rows", async () => {
    const database = createDatabase();
    await migrateDatabase(database);
    await seedCoreDatabase(database);
    await database.execute(sql`
      UPDATE tags
      SET name = '变量读写', normalized_name = '变量读写', is_active = false
      WHERE id = 'catalog.tag.01.01'
    `);

    await seedCoreDatabase(database);
    const rows = await database.query<{
      name: string;
      normalized_name: string;
      is_active: boolean;
    }>(sql`
      SELECT name, normalized_name, is_active
      FROM tags WHERE id = 'catalog.tag.01.01'
    `);
    expect(rows).toEqual([
      {
        name: "变量读写",
        normalized_name: "变量读写",
        is_active: false,
      },
    ]);
  });
});
