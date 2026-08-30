import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createLocalDatabase,
  migrateDatabase,
  seedCoreDatabase,
  type LocalDatabaseHandle
} from "@urmotiv/database";
import { sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DatabaseDataStore } from "../src/database-store";
import { ProblemService } from "../src/service";

let database: LocalDatabaseHandle;
let temporaryDirectory = "";

beforeEach(async () => {
  temporaryDirectory = await mkdtemp(join(tmpdir(), "urmotiv-problem-delete-"));
  database = createLocalDatabase({ dataDirectory: temporaryDirectory });
  await migrateDatabase(database);
  await seedCoreDatabase(database);
});

afterEach(async () => {
  await database.close();
  await rm(temporaryDirectory, { recursive: true, force: true });
});

describe("题目软删除", () => {
  it("删除与安全审计同事务提交，审计失败时不留下半删除状态", async () => {
    const store = new DatabaseDataStore(database);
    const service = new ProblemService(store);
    const root = await store.getUser("0");
    const tag = (await store.listTags()).find((item) => item.active !== false);
    expect(root).toBeDefined();
    expect(tag).toBeDefined();
    const problem = await service.createProblem(root!, {
      title: "合成删除测试题",
      type: "traditional",
      tagIds: [tag!.id],
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
        hints: ""
      }
    });

    await expect(
      service.deleteProblem(root!, problem.id, problem.revision, "invalid-request-id")
    ).rejects.toBeDefined();
    const afterFailure = await database.query<{ deleted: boolean }>(sql`
      SELECT deleted_at IS NOT NULL AS deleted
      FROM problems WHERE id = ${BigInt(problem.id)}
    `);
    expect(afterFailure).toEqual([{ deleted: false }]);
    const failedAudits = await database.query<{ total: number }>(sql`
      SELECT count(*)::integer AS total
      FROM audit_events
      WHERE action = 'problem.delete' AND object_id = ${problem.id}
    `);
    expect(failedAudits).toEqual([{ total: 0 }]);

    await service.deleteProblem(root!, problem.id, problem.revision, randomUUID());
    const afterSuccess = await database.query<{
      deleted: boolean;
      deleted_by_user_id: string;
    }>(sql`
      SELECT deleted_at IS NOT NULL AS deleted,
             deleted_by_user_id::text AS deleted_by_user_id
      FROM problems WHERE id = ${BigInt(problem.id)}
    `);
    expect(afterSuccess).toEqual([{ deleted: true, deleted_by_user_id: "0" }]);
    const audits = await database.query<{ action: string; metadata: unknown }>(sql`
      SELECT action, metadata
      FROM audit_events
      WHERE action = 'problem.delete' AND object_id = ${problem.id}
    `);
    expect(audits).toEqual([{
      action: "problem.delete",
      metadata: { revision: problem.revision, status: "draft" }
    }]);
    await expect(service.getProblem(root!, problem.id)).rejects.toMatchObject({
      statusCode: 404,
      code: "NOT_FOUND"
    });
  });
});
