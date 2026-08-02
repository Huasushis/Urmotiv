import { randomUUID } from "node:crypto";
import {
  createLocalDatabase,
  migrateDatabase,
  seedCoreDatabase,
  type LocalDatabaseHandle,
} from "@urmotiv/database";
import { sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app";
import { databaseDemoUserIds, seedDatabaseDemoData } from "../src/database-demo";
import { DatabaseDataStore } from "../src/database-store";
import { ProblemService } from "../src/service";
import { DatabaseTagCatalogService } from "../src/tag-catalog-service";

const origin = "http://localhost:5173";
const openApps: FastifyInstance[] = [];
const openDatabases: LocalDatabaseHandle[] = [];

afterEach(async () => {
  await Promise.all(openApps.splice(0).map((app) => app.close()));
  await Promise.all(openDatabases.splice(0).map((database) => database.close()));
});

async function context(now?: () => Date): Promise<{
  readonly app: FastifyInstance;
  readonly database: LocalDatabaseHandle;
  readonly store: DatabaseDataStore;
  readonly catalog: DatabaseTagCatalogService;
  readonly problems: ProblemService;
}> {
  const database = createLocalDatabase();
  openDatabases.push(database);
  await migrateDatabase(database);
  await seedCoreDatabase(database);
  await seedDatabaseDemoData(database);
  const store = new DatabaseDataStore(database);
  const catalog = new DatabaseTagCatalogService(database, now);
  const app = await createApp({
    demoAuthEnabled: true,
    store,
    tagCatalog: catalog,
    demoUserIds: Object.values(databaseDemoUserIds),
  });
  openApps.push(app);
  return { app, database, store, catalog, problems: new ProblemService(store) };
}

async function login(app: FastifyInstance, userId: string): Promise<string> {
  const response = await app.inject({
    method: "POST",
    url: "/api/v1/auth/demo-login",
    headers: { origin },
    payload: { userId },
  });
  expect(response.statusCode).toBe(200);
  const setCookie = response.headers["set-cookie"];
  const firstCookie = Array.isArray(setCookie) ? setCookie[0] : setCookie;
  expect(firstCookie).toBeTypeOf("string");
  return (firstCookie as string).split(";", 1)[0] as string;
}

async function managementVersion(app: FastifyInstance, cookie: string): Promise<number> {
  const response = await app.inject({
    method: "GET",
    url: "/api/v1/admin/tag-catalog",
    headers: { cookie },
  });
  expect(response.statusCode).toBe(200);
  return (response.json() as { version: number }).version;
}

describe("知识点目录管理 API", () => {
  it("公开目录带版本且管理端在事务中拒绝缺权、明确拒绝和机器人", async () => {
    const { app, database } = await context();
    await database.execute(sql`
      INSERT INTO permission_grants (
        id, subject_user_id, permission_name, effect, scope, granted_by_user_id, reason
      ) VALUES
        (${randomUUID()}::uuid, ${BigInt(databaseDemoUserIds.robot)},
         'tag.manage', 'allow', 'global', 0, '验证机器人固定拒绝'),
        (${randomUUID()}::uuid, ${BigInt(databaseDemoUserIds.denied)},
         'tag.manage', 'allow', 'global', 0, '验证明确拒绝优先'),
        (${randomUUID()}::uuid, ${BigInt(databaseDemoUserIds.denied)},
         'tag.manage', 'deny', 'global', 0, '验证明确拒绝优先')
    `);

    const authorCookie = await login(app, databaseDemoUserIds.author);
    const robotCookie = await login(app, databaseDemoUserIds.robot);
    const deniedCookie = await login(app, databaseDemoUserIds.denied);
    const leaderCookie = await login(app, databaseDemoUserIds.leader);

    const publicCatalog = await app.inject({
      method: "GET",
      url: "/api/v1/tag-catalog",
      headers: { cookie: authorCookie },
    });
    expect(publicCatalog.statusCode).toBe(200);
    const publicBody = publicCatalog.json() as {
      version: number;
      items: Array<{ itemKind: string; active: boolean }>;
    };
    expect(publicBody.version).toBe(1);
    expect(publicBody.items.length).toBeGreaterThan(200);
    expect(publicBody.items.every((item) => item.active)).toBe(true);
    expect(publicBody.items.some((item) => item.itemKind === "category")).toBe(true);
    expect(publicBody.items.some((item) => item.itemKind === "tag")).toBe(true);

    for (const cookie of [authorCookie, robotCookie, deniedCookie]) {
      const denied = await app.inject({
        method: "GET",
        url: "/api/v1/admin/tag-catalog",
        headers: { cookie },
      });
      expect(denied.statusCode).toBe(403);
      const deniedMutation = await app.inject({
        method: "POST",
        url: "/api/v1/admin/tag-catalog/items",
        headers: { cookie, origin },
        payload: {
          expectedVersion: 1,
          id: "test.tag.denied-write",
          itemKind: "tag",
          parentId: "catalog.category.01",
          name: "不得写入的合成标签",
          description: "",
          sortOrder: 0,
        },
      });
      expect(deniedMutation.statusCode).toBe(403);
    }
    const allowed = await app.inject({
      method: "GET",
      url: "/api/v1/admin/tag-catalog",
      headers: { cookie: leaderCookie },
    });
    expect(allowed.statusCode).toBe(200);
    expect(allowed.json()).toEqual(expect.objectContaining({ version: 1, aliases: [] }));
    expect(await database.query<{ count: number }>(sql`
      SELECT count(*)::integer AS count FROM tags WHERE id = 'test.tag.denied-write'
    `)).toEqual([{ count: 0 }]);
  });

  it("版本化管理新增、重命名、移动、排序、恢复和叶子别名", async () => {
    const { app } = await context();
    const leaderCookie = await login(app, databaseDemoUserIds.leader);
    const authorCookie = await login(app, databaseDemoUserIds.author);

    const category = await app.inject({
      method: "POST",
      url: "/api/v1/admin/tag-catalog/items",
      headers: { cookie: leaderCookie, origin },
      payload: {
        expectedVersion: 1,
        id: "test.category.catalog",
        itemKind: "category",
        parentId: null,
        name: "合成分类甲",
        description: "仅用于测试",
        sortOrder: 100,
      },
    });
    expect(category.statusCode).toBe(200);
    expect(category.json()).toEqual({ version: 2 });

    const leaf = await app.inject({
      method: "POST",
      url: "/api/v1/admin/tag-catalog/items",
      headers: { cookie: leaderCookie, origin },
      payload: {
        expectedVersion: 2,
        id: "test.tag.catalog",
        itemKind: "tag",
        parentId: "test.category.catalog",
        name: "合成叶子",
        description: "仅用于测试",
        sortOrder: 0,
      },
    });
    expect(leaf.statusCode).toBe(200);
    expect(leaf.json()).toEqual({ version: 3 });

    const staleRename = await app.inject({
      method: "PATCH",
      url: "/api/v1/admin/tag-catalog/items/test.tag.catalog",
      headers: { cookie: leaderCookie, origin },
      payload: { expectedVersion: 2, name: "不应写入" },
    });
    expect(staleRename.statusCode).toBe(409);

    const updated = await app.inject({
      method: "PATCH",
      url: "/api/v1/admin/tag-catalog/items/test.tag.catalog",
      headers: { cookie: leaderCookie, origin },
      payload: {
        expectedVersion: 3,
        name: "合成叶子乙",
        parentId: "catalog.category.02",
        sortOrder: 77,
      },
    });
    expect(updated.statusCode).toBe(200);
    expect(updated.json()).toEqual({ version: 4 });

    for (const ambiguousAlias of ["合成叶子乙", "模拟"]) {
      const rejectedAlias = await app.inject({
        method: "POST",
        url: "/api/v1/admin/tag-catalog/items/test.tag.catalog/aliases",
        headers: { cookie: leaderCookie, origin },
        payload: { expectedVersion: 4, name: ambiguousAlias },
      });
      expect(rejectedAlias.statusCode).toBe(409);
    }

    const alias = await app.inject({
      method: "POST",
      url: "/api/v1/admin/tag-catalog/items/test.tag.catalog/aliases",
      headers: { cookie: leaderCookie, origin },
      payload: { expectedVersion: 4, name: "　ＴＥＳＴ Alias　" },
    });
    expect(alias.statusCode).toBe(200);
    const aliasBody = alias.json() as { version: number; aliasId: string };
    expect(aliasBody.version).toBe(5);
    expect(aliasBody.aliasId).toMatch(/^[0-9a-f-]{36}$/u);

    const publicTagsWithAlias = await app.inject({
      method: "GET",
      url: "/api/v1/tags",
      headers: { cookie: authorCookie },
    });
    expect(publicTagsWithAlias.statusCode).toBe(200);
    expect(publicTagsWithAlias.json()).toEqual(expect.objectContaining({
      version: 5,
      items: expect.arrayContaining([
        expect.objectContaining({
          id: "test.tag.catalog",
          description: "仅用于测试",
          aliases: ["ＴＥＳＴ Alias"],
        }),
      ]),
    }));

    const itemCollidesWithAlias = await app.inject({
      method: "POST",
      url: "/api/v1/admin/tag-catalog/items",
      headers: { cookie: leaderCookie, origin },
      payload: {
        expectedVersion: 5,
        id: "test.category.alias-collision",
        itemKind: "category",
        parentId: null,
        name: "test alias",
        description: "",
        sortOrder: 0,
      },
    });
    expect(itemCollidesWithAlias.statusCode).toBe(409);
    const renameCollidesWithAlias = await app.inject({
      method: "PATCH",
      url: "/api/v1/admin/tag-catalog/items/test.tag.catalog",
      headers: { cookie: leaderCookie, origin },
      payload: { expectedVersion: 5, name: "TEST ALIAS" },
    });
    expect(renameCollidesWithAlias.statusCode).toBe(409);
    const aliasUpdateCollidesWithItem = await app.inject({
      method: "PATCH",
      url: `/api/v1/admin/tag-catalog/items/test.tag.catalog/aliases/${aliasBody.aliasId}`,
      headers: { cookie: leaderCookie, origin },
      payload: { expectedVersion: 5, name: "模拟" },
    });
    expect(aliasUpdateCollidesWithItem.statusCode).toBe(409);
    expect(await managementVersion(app, leaderCookie)).toBe(5);

    const genericDeactivate = await app.inject({
      method: "PATCH",
      url: "/api/v1/admin/tag-catalog/items/test.tag.catalog",
      headers: { cookie: leaderCookie, origin },
      payload: { expectedVersion: 5, active: false },
    });
    expect(genericDeactivate.statusCode).toBe(422);
    expect(await managementVersion(app, leaderCookie)).toBe(5);

    const updatedAlias = await app.inject({
      method: "PATCH",
      url: `/api/v1/admin/tag-catalog/items/test.tag.catalog/aliases/${aliasBody.aliasId}`,
      headers: { cookie: leaderCookie, origin },
      payload: { expectedVersion: 5, name: "更新后的合成别名" },
    });
    expect(updatedAlias.statusCode).toBe(200);
    expect(updatedAlias.json()).toEqual({ version: 6 });

    const deletedAlias = await app.inject({
      method: "DELETE",
      url: `/api/v1/admin/tag-catalog/items/test.tag.catalog/aliases/${aliasBody.aliasId}`,
      headers: { cookie: leaderCookie, origin },
      payload: { expectedVersion: 6 },
    });
    expect(deletedAlias.statusCode).toBe(200);
    expect(deletedAlias.json()).toEqual({ version: 7 });

    const managed = await app.inject({
      method: "GET",
      url: "/api/v1/admin/tag-catalog",
      headers: { cookie: leaderCookie },
    });
    const managedBody = managed.json() as {
      version: number;
      items: Array<Record<string, unknown>>;
      aliases: unknown[];
    };
    expect(managedBody.version).toBe(7);
    expect(managedBody.aliases).toEqual([]);
    expect(managedBody.items).toContainEqual(expect.objectContaining({
      id: "test.tag.catalog",
      itemKind: "tag",
      parentId: "catalog.category.02",
      name: "合成叶子乙",
      sortOrder: 77,
    }));
  });

  it("停用确认原子创建管理修订，失败全回滚且不泄露私有题目标识", async () => {
    const { app, database, store, catalog, problems } = await context();
    const leaderCookie = await login(app, databaseDemoUserIds.leader);
    const authorCookie = await login(app, databaseDemoUserIds.author);
    const author = await store.getUser(databaseDemoUserIds.author);
    const reviewer = await store.getUser(databaseDemoUserIds.reviewer);
    if (author === undefined || reviewer === undefined) {
      throw new Error("演示用户缺失。");
    }

    const createdTag = await app.inject({
      method: "POST",
      url: "/api/v1/admin/tag-catalog/items",
      headers: { cookie: leaderCookie, origin },
      payload: {
        expectedVersion: 1,
        id: "test.tag.deactivate",
        itemKind: "tag",
        parentId: "catalog.category.01",
        name: "待停用合成标签",
        description: "仅用于测试",
        sortOrder: 999,
      },
    });
    expect(createdTag.statusCode).toBe(200);

    const draftInput = {
      type: "traditional" as const,
      codeforcesDifficulty: null,
      thinkingLevel: null,
      codingLevel: null,
      content: {
        basicStatement: "合成私有题面标记，不得出现在目录响应。",
        basicSolution: "合成私有题解标记，不得出现在目录响应。",
        background: "",
        statement: "",
        inputFormat: "",
        outputFormat: "",
        constraints: "",
        solution: "",
        hints: "",
      },
    };
    const multiple = await problems.createProblem(author, {
      ...draftInput,
      title: "合成私有题目甲",
      tagIds: ["test.tag.deactivate", "catalog.tag.01.02"],
    });
    const pending = await problems.submitProblem(author, multiple.id, multiple.revision);
    await problems.submitReview(reviewer, multiple.id, {
      verdict: "approve",
      codeforcesDifficulty: 1200,
      qualityLevel: 3,
      originalityLevel: 3,
      thinkingLevel: 2,
      codingLevel: 1,
      tagIds: ["test.tag.deactivate"],
      improvements: "合成改进建议",
      publicComment: "",
      privateNote: "合成私密意见",
      expectedRound: pending.reviewRound,
    });
    const sole = await problems.createProblem(author, {
      ...draftInput,
      title: "合成私有题目乙",
      tagIds: ["test.tag.deactivate"],
    });
    await database.execute(sql`
      UPDATE problem_revisions
      SET format_extensions = '{"synthetic":"preserved"}'::jsonb
      WHERE problem_id = ${BigInt(multiple.id)} AND revision = ${pending.revision}
    `);

    const noReplacement = await app.inject({
      method: "POST",
      url: "/api/v1/admin/tag-catalog/items/test.tag.deactivate/deactivation-preview",
      headers: { cookie: leaderCookie, origin },
      payload: {},
    });
    expect(noReplacement.statusCode).toBe(200);
    const noReplacementBody = noReplacement.json() as {
      confirmationId: string;
      catalogVersion: number;
      expiresAt: string;
      impact: Record<string, number>;
    };
    expect(Object.keys(noReplacementBody).sort()).toEqual([
      "catalogVersion",
      "confirmationId",
      "expiresAt",
      "impact",
    ]);
    expect(noReplacement.body).not.toContain("合成私有题目");
    expect(noReplacement.body).not.toContain("合成私有题面");
    expect(noReplacementBody.catalogVersion).toBe(2);
    expect(noReplacementBody.impact).toEqual({
      currentProblemCount: 2,
      soleCurrentTagCount: 1,
      historicalRevisionCount: 1,
      reviewOpinionCount: 1,
      childTagCount: 0,
    });
    const rejected = await app.inject({
      method: "POST",
      url: "/api/v1/admin/tag-catalog/items/test.tag.deactivate/deactivate",
      headers: { cookie: leaderCookie, origin },
      payload: {
        confirmationId: noReplacementBody.confirmationId,
        catalogVersion: noReplacementBody.catalogVersion,
      },
    });
    expect(rejected.statusCode).toBe(409);

    const withReplacement = await app.inject({
      method: "POST",
      url: "/api/v1/admin/tag-catalog/items/test.tag.deactivate/deactivation-preview",
      headers: { cookie: leaderCookie, origin },
      payload: { replacementTagId: "catalog.tag.01.01" },
    });
    expect(withReplacement.statusCode).toBe(200);
    const preview = withReplacement.json() as {
      confirmationId: string;
      catalogVersion: number;
    };

    await expect(catalog.confirmDeactivation(
      databaseDemoUserIds.leader,
      "not-a-uuid",
      "test.tag.deactivate",
      preview.confirmationId,
      preview.catalogVersion,
    )).rejects.toBeDefined();
    expect(await managementVersion(app, leaderCookie)).toBe(2);
    expect(await database.query<{ is_active: boolean }>(sql`
      SELECT is_active FROM tags WHERE id = 'test.tag.deactivate'
    `)).toEqual([{ is_active: true }]);
    expect(await database.query<{ id: string; current_revision: number }>(sql`
      SELECT id::text AS id, current_revision
      FROM problems
      WHERE id IN (${BigInt(multiple.id)}, ${BigInt(sole.id)})
      ORDER BY id
    `)).toEqual([
      { id: multiple.id, current_revision: pending.revision },
      { id: sole.id, current_revision: sole.revision },
    ]);

    const confirmed = await app.inject({
      method: "POST",
      url: "/api/v1/admin/tag-catalog/items/test.tag.deactivate/deactivate",
      headers: { cookie: leaderCookie, origin },
      payload: {
        confirmationId: preview.confirmationId,
        catalogVersion: preview.catalogVersion,
      },
    });
    expect(confirmed.statusCode).toBe(200);
    expect(confirmed.json()).toEqual({ version: 3 });

    const historicalCatalog = await app.inject({
      method: "GET",
      url: "/api/v1/tags",
      headers: { cookie: authorCookie },
    });
    expect(historicalCatalog.statusCode).toBe(200);
    expect(historicalCatalog.json()).toEqual(expect.objectContaining({
      version: 3,
      items: expect.arrayContaining([
        expect.objectContaining({
          id: "test.tag.deactivate",
          name: "待停用合成标签",
          active: false,
          description: "仅用于测试",
          aliases: [],
        }),
      ]),
    }));
    expect(historicalCatalog.body).not.toContain("合成私有题目");
    expect(historicalCatalog.body).not.toContain("合成私有题面");

    const currentRows = await database.query<{
      problem_id: string;
      current_revision: number;
      tag_id: string;
    }>(sql`
      SELECT problem.id::text AS problem_id, problem.current_revision, link.tag_id
      FROM problems problem
      JOIN problem_revisions revision
        ON revision.problem_id = problem.id
       AND revision.revision = problem.current_revision
      JOIN problem_revision_tags link ON link.revision_id = revision.id
      WHERE problem.id IN (${BigInt(multiple.id)}, ${BigInt(sole.id)})
      ORDER BY problem.id, link.tag_id
    `);
    expect(currentRows).toEqual([
      { problem_id: multiple.id, current_revision: pending.revision + 1, tag_id: "catalog.tag.01.02" },
      { problem_id: sole.id, current_revision: sole.revision + 1, tag_id: "catalog.tag.01.01" },
    ]);
    const historicalTarget = await database.query<{ count: number }>(sql`
      SELECT count(*)::integer AS count
      FROM problem_revision_tags link
      JOIN problem_revisions revision ON revision.id = link.revision_id
      WHERE revision.problem_id IN (${BigInt(multiple.id)}, ${BigInt(sole.id)})
        AND link.tag_id = 'test.tag.deactivate'
    `);
    expect(historicalTarget).toEqual([{ count: 3 }]);
    expect(await database.query<{ count: number }>(sql`
      SELECT count(*)::integer AS count
      FROM review_opinion_tags
      WHERE tag_id = 'test.tag.deactivate'
    `)).toEqual([{ count: 1 }]);
    expect(await database.query<{ format_extensions: unknown }>(sql`
      SELECT format_extensions
      FROM problem_revisions
      WHERE problem_id = ${BigInt(multiple.id)}
        AND revision = ${pending.revision + 1}
    `)).toEqual([{ format_extensions: { synthetic: "preserved" } }]);

    const audits = await database.query<{ metadata: unknown }>(sql`
      SELECT metadata
      FROM audit_events
      WHERE action = 'tag.catalog.deactivate'
    `);
    expect(audits).toHaveLength(1);
    const auditMetadata = audits[0]?.metadata as Record<string, unknown>;
    expect(Object.keys(auditMetadata).sort()).toEqual([
      "afterVersion",
      "beforeVersion",
      "childTagCount",
      "currentProblemCount",
      "historicalRevisionCount",
      "replacementTagId",
      "reviewOpinionCount",
      "soleCurrentTagCount",
      "usedReplacement",
    ]);
    const auditText = JSON.stringify(auditMetadata);
    expect(auditText).not.toContain("合成私有题目");

    const replay = await app.inject({
      method: "POST",
      url: "/api/v1/admin/tag-catalog/items/test.tag.deactivate/deactivate",
      headers: { cookie: leaderCookie, origin },
      payload: {
        confirmationId: preview.confirmationId,
        catalogVersion: preview.catalogVersion,
      },
    });
    expect(replay.statusCode).toBe(409);

    const restored = await app.inject({
      method: "PATCH",
      url: "/api/v1/admin/tag-catalog/items/test.tag.deactivate",
      headers: { cookie: leaderCookie, origin },
      payload: { expectedVersion: 3, active: true },
    });
    expect(restored.statusCode).toBe(200);
    expect(restored.json()).toEqual({ version: 4 });
    const restoredCurrentCount = await database.query<{ count: number }>(sql`
      SELECT count(*)::integer AS count
      FROM problems problem
      JOIN problem_revisions revision
        ON revision.problem_id = problem.id
       AND revision.revision = problem.current_revision
      JOIN problem_revision_tags link ON link.revision_id = revision.id
      WHERE link.tag_id = 'test.tag.deactivate'
    `);
    expect(restoredCurrentCount).toEqual([{ count: 0 }]);
  });

  it("有子项的分类即使完成预览也不能停用", async () => {
    const { app } = await context();
    const leaderCookie = await login(app, databaseDemoUserIds.leader);
    const previewResponse = await app.inject({
      method: "POST",
      url: "/api/v1/admin/tag-catalog/items/catalog.category.01/deactivation-preview",
      headers: { cookie: leaderCookie, origin },
      payload: {},
    });
    expect(previewResponse.statusCode).toBe(200);
    const preview = previewResponse.json() as {
      confirmationId: string;
      catalogVersion: number;
      impact: { childTagCount: number };
    };
    expect(preview.impact.childTagCount).toBeGreaterThan(0);
    const confirmed = await app.inject({
      method: "POST",
      url: "/api/v1/admin/tag-catalog/items/catalog.category.01/deactivate",
      headers: { cookie: leaderCookie, origin },
      payload: {
        confirmationId: preview.confirmationId,
        catalogVersion: preview.catalogVersion,
      },
    });
    expect(confirmed.statusCode).toBe(409);
    expect(await managementVersion(app, leaderCookie)).toBe(1);
  });

  it("确认标识过期或替代项不是启用叶子时拒绝且不消费目录状态", async () => {
    let currentTime = new Date("2030-01-01T00:00:00.000Z");
    const { app, database } = await context(() => currentTime);
    const leaderCookie = await login(app, databaseDemoUserIds.leader);
    const created = await app.inject({
      method: "POST",
      url: "/api/v1/admin/tag-catalog/items",
      headers: { cookie: leaderCookie, origin },
      payload: {
        expectedVersion: 1,
        id: "test.tag.expiry",
        itemKind: "tag",
        parentId: "catalog.category.01",
        name: "确认过期合成标签",
        description: "",
        sortOrder: 0,
      },
    });
    expect(created.statusCode).toBe(200);

    const invalidReplacement = await app.inject({
      method: "POST",
      url: "/api/v1/admin/tag-catalog/items/test.tag.expiry/deactivation-preview",
      headers: { cookie: leaderCookie, origin },
      payload: { replacementTagId: "catalog.category.01" },
    });
    expect(invalidReplacement.statusCode).toBe(422);
    expect(await managementVersion(app, leaderCookie)).toBe(2);

    const previewResponse = await app.inject({
      method: "POST",
      url: "/api/v1/admin/tag-catalog/items/test.tag.expiry/deactivation-preview",
      headers: { cookie: leaderCookie, origin },
      payload: {},
    });
    expect(previewResponse.statusCode).toBe(200);
    const preview = previewResponse.json() as {
      confirmationId: string;
      catalogVersion: number;
    };
    currentTime = new Date("2030-01-01T00:10:01.000Z");
    const expired = await app.inject({
      method: "POST",
      url: "/api/v1/admin/tag-catalog/items/test.tag.expiry/deactivate",
      headers: { cookie: leaderCookie, origin },
      payload: {
        confirmationId: preview.confirmationId,
        catalogVersion: preview.catalogVersion,
      },
    });
    expect(expired.statusCode).toBe(409);
    expect(await managementVersion(app, leaderCookie)).toBe(2);
    expect(await database.query<{ is_active: boolean }>(sql`
      SELECT is_active FROM tags WHERE id = 'test.tag.expiry'
    `)).toEqual([{ is_active: true }]);
  });

  it("停用也更新软删除题目的当前修订，避免遗留无效的活动引用", async () => {
    const { database, store, catalog, problems } = await context();
    const administrator = databaseDemoUserIds.administrator;
    await catalog.createItem(administrator, randomUUID(), {
      expectedVersion: 1,
      id: "test.tag.deleted-problem",
      itemKind: "tag",
      parentId: "catalog.category.01",
      name: "软删除题目合成标签",
      description: "",
      sortOrder: 0,
    });
    const author = await store.getUser(databaseDemoUserIds.author);
    if (author === undefined) throw new Error("演示作者缺失。");
    const problem = await problems.createProblem(author, {
      title: "软删除合成题",
      type: "traditional",
      tagIds: ["test.tag.deleted-problem", "catalog.tag.01.01"],
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
    await database.execute(sql`
      UPDATE problems
      SET deleted_at = now(), deleted_by_user_id = ${BigInt(author.id)}
      WHERE id = ${BigInt(problem.id)}
    `);
    const preview = await catalog.previewDeactivation(
      administrator,
      "test.tag.deleted-problem",
    );
    expect(preview.impact).toEqual({
      currentProblemCount: 1,
      soleCurrentTagCount: 0,
      historicalRevisionCount: 0,
      reviewOpinionCount: 0,
      childTagCount: 0,
    });
    await expect(catalog.confirmDeactivation(
      administrator,
      randomUUID(),
      "test.tag.deleted-problem",
      preview.confirmationId,
      preview.catalogVersion,
    )).resolves.toEqual({ version: 3 });
    expect(await database.query<{
      current_revision: number;
      deleted: boolean;
      tag_id: string;
    }>(sql`
      SELECT
        problem.current_revision,
        (problem.deleted_at IS NOT NULL) AS deleted,
        link.tag_id
      FROM problems problem
      JOIN problem_revisions revision
        ON revision.problem_id = problem.id
       AND revision.revision = problem.current_revision
      JOIN problem_revision_tags link ON link.revision_id = revision.id
      WHERE problem.id = ${BigInt(problem.id)}
    `)).toEqual([{
      current_revision: 2,
      deleted: true,
      tag_id: "catalog.tag.01.01",
    }]);
    expect(await database.query<{ count: number }>(sql`
      SELECT count(*)::integer AS count
      FROM problem_revision_tags link
      JOIN problem_revisions revision ON revision.id = link.revision_id
      WHERE revision.problem_id = ${BigInt(problem.id)}
        AND link.tag_id = 'test.tag.deleted-problem'
    `)).toEqual([{ count: 1 }]);
  });
});
