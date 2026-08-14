/**
 * 纯逻辑用例用合成计数验证 verifyPhase2Outcome 的判定；
 * PGlite 集成用例验证完整表清单与按导入问题清单统计缺失题解。
 */
import { afterEach, describe, expect, it } from "vitest";

import {
  createLocalDatabase,
  migrateDatabase,
  seedCoreDatabase,
  type DatabaseHandle,
} from "@urmotiv/database";
import { sql } from "drizzle-orm";

import { historyImportRequiredTables } from "../src/history-migration/import-preflight";
import {
  assertScratchDatabaseName,
  captureHistoryImportTableCounts,
  countMissingBasicSolutionsForProblems,
  expectedTableDeltas,
  verifyPhase2Outcome,
  type HistoryImportCountRow,
} from "../src/history-migration/phase2-postcheck";
import { HistoryMigrationError } from "../src/history-migration/errors";

const openDatabases: DatabaseHandle[] = [];

afterEach(async () => {
  while (openDatabases.length > 0) {
    const database = openDatabases.pop();
    if (database !== undefined) await database.close();
  }
});

function counts(tables: Record<string, number>): HistoryImportCountRow[] {
  return Object.entries(tables).map(([table, rows]) => ({ table, rows }));
}

const allTables: Record<string, number> = {
  users: 1,
  problems: 0,
  problem_revisions: 0,
  problem_revision_tags: 0,
  problem_revision_files: 0,
  problem_samples: 0,
  import_jobs: 0,
  import_job_items: 0,
  audit_events: 0,
  stored_files: 0,
};

describe("expectedTableDeltas", () => {
  it("按导入语义生成全部十张表的预期增量", () => {
    const deltas = expectedTableDeltas({
      imported: 137,
      attachmentRows: 38,
      sampleRows: 15,
      jobItemRows: 137,
      storedFilesDelta: 175,
      auditDelta: 274,
    });
    const map = new Map(deltas.map((d) => [d.table, d.delta]));
    expect(map.get("users")).toBe(0);
    expect(map.get("problems")).toBe(137);
    expect(map.get("problem_revisions")).toBe(137);
    expect(map.get("problem_revision_tags")).toBe(137);
    expect(map.get("problem_revision_files")).toBe(38);
    expect(map.get("problem_samples")).toBe(15);
    expect(map.get("import_jobs")).toBe(137);
    expect(map.get("import_job_items")).toBe(137);
    expect(map.get("audit_events")).toBe(274);
    expect(map.get("stored_files")).toBe(175);
  });
});

describe("verifyPhase2Outcome", () => {
  const baseInput = {
    before: counts(allTables),
    afterFirst: counts({ ...allTables, problems: 3, problem_revisions: 3, problem_revision_tags: 3, import_jobs: 3, import_job_items: 3, stored_files: 3, audit_events: 6 }),
    afterReplay: counts({ ...allTables, problems: 3, problem_revisions: 3, problem_revision_tags: 3, import_jobs: 3, import_job_items: 3, stored_files: 3, audit_events: 6 }),
    firstPass: { imported: 3, skipped: 0, failed: 0 },
    replayPass: { imported: 0, skipped: 3, failed: 0 },
    expectedPackageCount: 3,
    expectedAttachmentRows: 0,
    expectedSampleRows: 0,
    expectedJobItemRows: 3,
    expectedStoredFilesDelta: 3,
    expectedAuditDelta: 6,
    expectedMissingSolutionCount: 0,
    afterMissingSolutionCount: 0,
    expectedStoredBytes: 30,
    expectedStoredContentSha256: "inventory",
    afterFirstStoredInventory: {
      fileCount: 3,
      totalBytes: 30,
      contentInventorySha256: "inventory",
    },
    afterReplayStoredInventory: {
      fileCount: 3,
      totalBytes: 30,
      contentInventorySha256: "inventory",
    },
  };

  it("全部一致时判 PASS", () => {
    const result = verifyPhase2Outcome(baseInput);
    expect(result.verdict).toBe("PASS");
    expect(result.reasonCodes).toHaveLength(0);
    expect(result.driftedTableCount).toBe(0);
  });

  it("首次导入数量不符时判 FAIL（first_import_count_mismatch）", () => {
    const result = verifyPhase2Outcome({
      ...baseInput,
      firstPass: { imported: 2, skipped: 0, failed: 0 },
    });
    expect(result.verdict).toBe("FAIL");
    expect(result.reasonCodes).toContain("first_import_count_mismatch");
  });

  it("首次导入有失败候选时判 FAIL（failed_candidates_present）", () => {
    const result = verifyPhase2Outcome({
      ...baseInput,
      firstPass: { imported: 3, skipped: 0, failed: 1 },
    });
    expect(result.verdict).toBe("FAIL");
    expect(result.reasonCodes).toContain("failed_candidates_present");
  });

  it("首次导入有跳过时判 FAIL（unexpected_skipped_first_import）", () => {
    const result = verifyPhase2Outcome({
      ...baseInput,
      firstPass: { imported: 2, skipped: 1, failed: 0 },
    });
    expect(result.verdict).toBe("FAIL");
    expect(result.reasonCodes).toContain("unexpected_skipped_first_import");
  });

  it("重放不幂等时判 FAIL（replay_not_idempotent）", () => {
    const result = verifyPhase2Outcome({
      ...baseInput,
      replayPass: { imported: 1, skipped: 2, failed: 0 },
    });
    expect(result.verdict).toBe("FAIL");
    expect(result.reasonCodes).toContain("replay_not_idempotent");
  });

  it("重放后表计数变化时判 FAIL（replay_mutation_present）", () => {
    const result = verifyPhase2Outcome({
      ...baseInput,
      afterReplay: counts({ ...allTables, problems: 4, problem_revisions: 3, problem_revision_tags: 3, import_jobs: 3, stored_files: 3, audit_events: 6 }),
    });
    expect(result.verdict).toBe("FAIL");
    expect(result.reasonCodes).toContain("replay_mutation_present");
  });

  it("表增量漂移时判 FAIL（table_delta_drift）并报告漂移表数量", () => {
    const driftedCounts = counts({
      ...allTables,
      problems: 2,
      problem_revisions: 3,
      problem_revision_tags: 3,
      import_jobs: 3,
      import_job_items: 3,
      stored_files: 3,
      audit_events: 6,
    });
    const result = verifyPhase2Outcome({
      ...baseInput,
      afterFirst: driftedCounts,
      afterReplay: driftedCounts,
    });
    expect(result.verdict).toBe("FAIL");
    expect(result.reasonCodes).toContain("table_delta_drift");
    expect(result.driftedTableCount).toBe(1);
  });

  it("基础题解状态漂移时判 FAIL（solution_state_drift）", () => {
    const result = verifyPhase2Outcome({
      ...baseInput,
      afterMissingSolutionCount: 1,
    });
    expect(result.verdict).toBe("FAIL");
    expect(result.reasonCodes).toContain("solution_state_drift");
  });

  it("存储对象数量、总字节或内容清单漂移时判 FAIL（stored_inventory_drift）", () => {
    const result = verifyPhase2Outcome({
      ...baseInput,
      afterReplayStoredInventory: {
        ...baseInput.afterReplayStoredInventory,
        totalBytes: 31,
      },
    });
    expect(result.verdict).toBe("FAIL");
    expect(result.reasonCodes).toContain("stored_inventory_drift");
  });
});

describe("assertScratchDatabaseName", () => {
  it("符合前缀的库名通过", () => {
    expect(() => assertScratchDatabaseName("urmotiv_history_import_test")).not.toThrow();
    expect(() => assertScratchDatabaseName("urmotiv_history_import_acceptance_002")).not.toThrow();
  });

  it("不符合前缀的库名以稳定错误码拒绝", () => {
    expect(() => assertScratchDatabaseName("urmotiv")).toThrow(HistoryMigrationError);
    expect(() => assertScratchDatabaseName("production_db")).toThrow(HistoryMigrationError);
    expect(() => assertScratchDatabaseName("URMOTIV_history_import_test")).toThrow(HistoryMigrationError);
  });
});

describe("PGlite 集成", () => {
  it("迁移+种子后：captureHistoryImportTableCounts 返回十张表的行数", async () => {
    const database = createLocalDatabase();
    openDatabases.push(database);
    await migrateDatabase(database);
    await seedCoreDatabase(database);
    const rows = await captureHistoryImportTableCounts(database);
    expect(rows.map((row) => row.table)).toEqual([...historyImportRequiredTables]);
    expect(rows).toHaveLength(historyImportRequiredTables.length);
    for (const row of rows) expect(row.rows).toBeGreaterThanOrEqual(0);
  });

  it("countMissingBasicSolutionsForProblems 只统计明确的问题清单", async () => {
    const database = createLocalDatabase();
    openDatabases.push(database);
    await migrateDatabase(database);
    await seedCoreDatabase(database);
    const problemIds = ["999999"];
    const missing = await countMissingBasicSolutionsForProblems(database, problemIds);
    expect(missing).toBe(0);
    const missingAgain = await countMissingBasicSolutionsForProblems(database, problemIds);
    expect(missingAgain).toBe(missing);
  });
});
