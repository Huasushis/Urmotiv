import { createLocalDatabase, migrateDatabase, seedCoreDatabase, type LocalDatabaseHandle } from "@urmotiv/database";
import { createProblemInputSchema } from "@urmotiv/contracts";
import { sql } from "drizzle-orm";
import { afterEach, beforeEach, expect, it } from "vitest";
import { databaseDemoUserIds, seedDatabaseDemoData } from "../src/database-demo";
import { DatabaseDataStore } from "../src/database-store";
import { importHistoricalReviews } from "../src/historical-reviews";
import { ProblemService } from "../src/service";

let database: LocalDatabaseHandle;
beforeEach(async () => {
  database = createLocalDatabase();
  await migrateDatabase(database);
  await seedCoreDatabase(database);
  await seedDatabaseDemoData(database);
});
afterEach(async () => { await database.close(); });

async function plan(conclusions: Array<"A" | "B" | "C" | "D">) {
  const store = new DatabaseDataStore(database);
  const service = new ProblemService(store);
  const actor = await store.getUser(databaseDemoUserIds.leader);
  if (!actor) throw new Error("fixture missing");
  const records = [];
  for (const [index, conclusion] of conclusions.entries()) {
    const problem = await service.createProblem(actor, createProblemInputSchema.parse({
      title: `合成历史审核 ${index}`, type: "traditional", tagIds: ["catalog.tag.02.09"],
      content: { basicStatement: "输出输入的整数。", basicSolution: conclusion === "B" ? null : "读取并输出。" }
    }));
    const [revision] = await database.query<{ hash: string }>(sql`
      SELECT content_hash AS hash FROM problem_revisions WHERE problem_id = ${BigInt(problem.id)} AND revision = 1
    `);
    records.push({ problemId: problem.id, expectedRevision: 1, expectedContentHash: revision!.hash,
      review: { version: 1 as const, sourceSha256: "a".repeat(64), sourceNumber: 59 + index, conclusion,
        sections: [{ label: "正确性核验", content: "合成验证记录。" }, { label: "建议难度", content: "" }]
      }
    });
  }
  return { version: 1, actorUserId: actor.id, records,
    disableExternalReview: records.map(({ review: _review, ...binding }) => binding) };
}

it("原文和四类结论完整保留，不伪造数值评分；预演无写入、重复导入不重复建轮次", async () => {
  const input = await plan(["A", "B", "C", "D"]);
  expect(await importHistoricalReviews(database, input)).toMatchObject({ applied: false, imported: 4 });
  expect((await database.query<{ n: number }>(sql`SELECT count(*)::int n FROM review_rounds`))[0]?.n).toBe(0);
  expect(await importHistoricalReviews(database, input, true)).toMatchObject({ applied: true, imported: 4 });
  expect(await importHistoricalReviews(database, input, true)).toMatchObject({ imported: 0, unchanged: 4 });
  const stored = await database.query<{ status: string; external_review_enabled: boolean }>(sql`
    SELECT status, external_review_enabled FROM problems ORDER BY id
  `);
  expect(stored.map((p) => p.status)).toEqual(["approved", "pending_review", "pending_review", "rejected"]);
  expect(stored.every((p) => p.external_review_enabled === false)).toBe(true);
  expect((await database.query<{ n: number }>(sql`SELECT count(*)::int n FROM review_opinions`))[0]?.n).toBe(0);
  const items = await database.query<{ data: unknown }>(sql`SELECT data FROM review_items ORDER BY data->>'sourceNumber'`);
  expect(items.map((item) => item.data)).toEqual(input.records.map((record) => record.review));
});

it("错配、版本冲突或整批中途失败会完整回滚", async () => {
  const input = await plan(["A", "D"]);
  const wrong = structuredClone(input);
  wrong.records[1]!.expectedContentHash = "b".repeat(64);
  wrong.disableExternalReview[1]!.expectedContentHash = "b".repeat(64);
  await expect(importHistoricalReviews(database, wrong, true)).rejects.toThrow("BINDING_MISMATCH");
  await database.execute(sql`UPDATE problems SET status = 'pending_review' WHERE id = ${BigInt(input.records[1]!.problemId)}`);
  await expect(importHistoricalReviews(database, input, true)).rejects.toThrow();
  expect((await database.query<{ n: number }>(sql`SELECT count(*)::int n FROM review_rounds`))[0]?.n).toBe(0);
  expect((await database.query<{ n: number }>(sql`SELECT count(*)::int n FROM problems WHERE external_review_enabled = false`))[0]?.n).toBe(0);
});

it("作者和机器人不能导入审核，既有轮次不能被迁移覆盖", async () => {
  const input = await plan(["A"]);
  for (const actorUserId of [databaseDemoUserIds.author, databaseDemoUserIds.robot]) {
    await expect(importHistoricalReviews(database, { ...input, actorUserId }, true)).rejects.toThrow("FORBIDDEN");
  }
  await database.execute(sql`UPDATE problems SET status = 'pending_review' WHERE id = ${BigInt(input.records[0]!.problemId)}`);
  await expect(importHistoricalReviews(database, input, true)).rejects.toThrow("EXISTING_REVIEW");
});
