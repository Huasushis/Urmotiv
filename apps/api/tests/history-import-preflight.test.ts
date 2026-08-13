/**
 * 历史导入预检的确定性单测：全部使用合成数据（不含任何真实题目内容）。
 * 覆盖清单/报告/导入清单对账的硬性失败码、基础题解结构性缺失的如实计数，
 * 以及只读事务预检在 PGlite 与真实 PostgreSQL 上的行为。
 */
import { afterEach, describe, expect, it } from "vitest";

import {
  createLocalDatabase,
  createPostgresDatabase,
  migrateDatabase,
  seedCoreDatabase,
  type DatabaseHandle,
} from "@urmotiv/database";

import {
  dropHistoryImportDatabase,
  historyImportDatabaseConnectionString,
  prepareHistoryImportDatabase,
} from "../src/history-migration/import-phase";
import { HistoryMigrationError } from "../src/history-migration/errors";
import {
  historyImportRequiredTables,
  reconcileHistoryImportBatch,
  runZeroMutationDatabasePreflight,
  summarizePackageEntryNames,
  summarizePackageReport,
} from "../src/history-migration/import-preflight";

const openDatabases: DatabaseHandle[] = [];

afterEach(async () => {
  while (openDatabases.length > 0) {
    const database = openDatabases.pop();
    if (database !== undefined) await database.close();
  }
});

const digest = (character: string): string => character.repeat(64);

function candidateId(index: number): string {
  return `candidate-${String(index).padStart(6, "0")}`;
}

function makeEntry(index: number, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    candidateId: candidateId(index),
    contentSha256: digest("a"),
    sourceBindingSha256: digest("b"),
    packageSha256: digest("c"),
    packageBytes: 128,
    status: "packaged",
    ...overrides,
  };
}

function makeReport(count: number, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version: 1,
    phase: "package",
    batchSha256: digest("d"),
    packageCount: count,
    packages: Array.from({ length: count }, (_unused, index) => makeEntry(index + 1)),
    ...overrides,
  };
}

function makeMetadata(count: number): Record<string, unknown> {
  return {
    records: Array.from({ length: count }, (_unused, index) => ({
      number: String(index + 1).padStart(4, "0"),
      name: `synthetic-title-${index + 1}`,
    })),
  };
}

const completeNames = [
  "manifest.yaml",
  "checksums.sha256",
  "content/basic-statement.md",
  "content/basic-solution.md",
];
function makeReconcileInput(
  overrides: Record<string, unknown> = {},
): Parameters<typeof reconcileHistoryImportBatch>[0] {
  return {
    listMetadata: makeMetadata(3),
    packageReport: makeReport(3),
    packageEntryNames: [completeNames, completeNames, completeNames],
    expectedRecordCount: 3,
    ...overrides,
  };
}

describe("历史导入预检对账", () => {
  it("清单、报告与包结构一致时判 READY，并如实统计结构性缺失题解", () => {
    const result = reconcileHistoryImportBatch(
      makeReconcileInput({
        packageEntryNames: [
          completeNames,
          ["manifest.yaml", "checksums.sha256", "content/basic-statement.md"],
          [...completeNames, "attachments/data.bin"],
        ],
      }),
    );
    expect(result.verdict).toBe("READY");
    expect(result.packageCount).toBe(3);
    expect(result.missingBasicSolutionCount).toBe(1);
    expect(result.embeddedAttachmentCount).toBe(1);
    expect(result.importedCount).toBeUndefined();
  });

  it("报告声明包数与实际条目数不一致时判 NOT_READY", () => {
    const report = makeReport(3, { packageCount: 99 });
    const result = reconcileHistoryImportBatch(makeReconcileInput({ packageReport: report }));
    expect(result.verdict).toBe("NOT_READY");
    expect(result.reasonCodes).toContain("report_declared_count_mismatch");
  });

  it("候选编号重复时判 NOT_READY", () => {
    const report = makeReport(3, {
      packages: [makeEntry(1), makeEntry(1), makeEntry(2)],
      packageCount: 3,
    });
    const result = reconcileHistoryImportBatch(makeReconcileInput({ packageReport: report }));
    expect(result.verdict).toBe("NOT_READY");
    expect(result.reasonCodes).toContain("duplicate_candidate");
    expect(result.duplicateCandidateCount).toBe(1);
  });

  it("缺少来源绑定摘要时判 NOT_READY（绑定不含标题，身份与标题无关）", () => {
    const report = makeReport(3, {
      packages: [
        makeEntry(1, { sourceBindingSha256: undefined }),
        makeEntry(2),
        makeEntry(3),
      ],
    });
    const result = reconcileHistoryImportBatch(makeReconcileInput({ packageReport: report }));
    expect(result.verdict).toBe("NOT_READY");
    expect(result.reasonCodes).toContain("source_binding_missing");
    expect(result.missingSourceBindingCount).toBe(1);
  });

  it("空包判 NOT_READY", () => {
    const report = makeReport(3, {
      packages: [makeEntry(1, { packageBytes: 0 }), makeEntry(2), makeEntry(3)],
    });
    const result = reconcileHistoryImportBatch(makeReconcileInput({ packageReport: report }));
    expect(result.verdict).toBe("NOT_READY");
    expect(result.reasonCodes).toContain("empty_package");
  });

  it("保留材料声明数与条目数不一致时判 NOT_READY，未决附件不会被静默丢弃", () => {
    const report = makeReport(3, {
      preservedMaterialCount: 2,
      preservedMaterials: [
        {
          attachmentId: "a1",
          contentSha256: digest("e"),
          semanticRole: "batch_internal",
          preservationPath: "preserved/a.txt",
        },
      ],
    });
    const result = reconcileHistoryImportBatch(makeReconcileInput({ packageReport: report }));
    expect(result.verdict).toBe("NOT_READY");
    expect(result.reasonCodes).toContain("preserved_material_mismatch");
    expect(result.preservedMaterialCount).toBe(1);
  });

  it("附件声明数与内嵌附件不一致时判 NOT_READY", () => {
    const report = makeReport(3, { attachmentCount: 5 });
    const result = reconcileHistoryImportBatch(makeReconcileInput({ packageReport: report }));
    expect(result.verdict).toBe("NOT_READY");
    expect(result.reasonCodes).toContain("attachment_count_mismatch");
  });

  it("清单记录数与包数量不一致时判 NOT_READY", () => {
    const result = reconcileHistoryImportBatch(
      makeReconcileInput({ listMetadata: makeMetadata(4) }),
    );
    expect(result.verdict).toBe("NOT_READY");
    expect(result.reasonCodes).toContain("metadata_report_count_mismatch");
  });

  it("与权威清单期望记录数不一致时判 NOT_READY", () => {
    const result = reconcileHistoryImportBatch(makeReconcileInput({ expectedRecordCount: 2 }));
    expect(result.verdict).toBe("NOT_READY");
    expect(result.reasonCodes).toContain("expected_record_count_mismatch");
  });

  it("包条目检查缺失时判 NOT_READY", () => {
    const result = reconcileHistoryImportBatch(
      makeReconcileInput({ packageEntryNames: [completeNames] }),
    );
    expect(result.verdict).toBe("NOT_READY");
    expect(result.reasonCodes).toContain("entry_names_incomplete");
  });

  it("缺失包文件如实计数并判 NOT_READY", () => {
    const result = reconcileHistoryImportBatch(
      makeReconcileInput({
        packageEntryNames: [completeNames, [], completeNames],
        missingPackageFileCount: 1,
      }),
    );
    expect(result.verdict).toBe("NOT_READY");
    expect(result.reasonCodes).toContain("package_file_missing");
  });

  it("包内出现规范布局之外的条目时判 NOT_READY", () => {
    const result = reconcileHistoryImportBatch(
      makeReconcileInput({
        packageEntryNames: [completeNames, [...completeNames, "unexpected.bin"], completeNames],
      }),
    );
    expect(result.verdict).toBe("NOT_READY");
    expect(result.reasonCodes).toContain("unexpected_entry_names");
    expect(result.unexpectedEntryNameCount).toBe(1);
  });

  it("已有导入清单与报告摘要绑定不一致时判 NOT_READY", () => {
    const manifest = {
      version: 1,
      phase: "import",
      batchSha256: digest("f"),
      importedCount: 3,
      entries: [],
    };
    const result = reconcileHistoryImportBatch(
      makeReconcileInput({ importManifest: manifest }),
    );
    expect(result.verdict).toBe("NOT_READY");
    expect(result.reasonCodes).toContain("manifest_batch_mismatch");
  });

  it("已有导入清单数量不完整时判 NOT_READY；绑定一致且完整时旁路为 READY", () => {
    const base = {
      version: 1,
      phase: "import",
      batchSha256: digest("d"),
      entries: [],
    };
    const incomplete = reconcileHistoryImportBatch(
      makeReconcileInput({ importManifest: { ...base, importedCount: 2 } }),
    );
    expect(incomplete.reasonCodes).toContain("manifest_incomplete");
    const complete = reconcileHistoryImportBatch(
      makeReconcileInput({ importManifest: { ...base, importedCount: 3 } }),
    );
    expect(complete.verdict).toBe("READY");
    expect(complete.importedCount).toBe(3);
  });

  it("非法清单元数据以稳定错误码拒绝", () => {
    expect(() =>
      reconcileHistoryImportBatch(makeReconcileInput({ listMetadata: { records: [] } })),
    ).toThrow(HistoryMigrationError);
    try {
      reconcileHistoryImportBatch(makeReconcileInput({ listMetadata: { records: [] } }));
      throw new Error("应当被拒绝");
    } catch (error) {
      expect(error).toBeInstanceOf(HistoryMigrationError);
      expect((error as HistoryMigrationError).code).toBe("INVALID_METADATA");
    }
  });
});

describe("包条目结构统计", () => {
  it("只按路径前缀分类，不读取正文", () => {
    const summary = summarizePackageEntryNames([
      ["manifest.yaml", "checksums.sha256", "content/basic-statement.md", "content/basic-solution.md", "attachments/a.bin"],
      ["manifest.yaml", "checksums.sha256", "content/basic-statement.md"],
    ]);
    expect(summary.packagesChecked).toBe(2);
    expect(summary.missingBasicSolutionCount).toBe(1);
    expect(summary.packagesWithEmbeddedAttachments).toBe(1);
    expect(summary.embeddedAttachmentEntryCount).toBe(1);
    expect(summary.unexpectedEntryNameCount).toBe(0);
  });

  it("打包报告聚合如实核对声明数量", () => {
    const report = makeReport(2, { attachmentCount: 0 });
    const summary = summarizePackageReport(report);
    expect(summary.packageCount).toBe(2);
    expect(summary.declaredPackageCount).toBe(2);
    expect(summary.missingSourceBindingCount).toBe(0);
  });
});

describe("零数据库变更预检", () => {
  it("PGlite 迁移完成后：只读开关生效且全部必需表存在", async () => {
    const database = createLocalDatabase();
    openDatabases.push(database);
    await migrateDatabase(database);
    await seedCoreDatabase(database);
    const result = await runZeroMutationDatabasePreflight(database);
    expect(result.readOnlyEnforced).toBe(true);
    expect(result.missingTableCount).toBe(0);
    expect(result.presentTableCount).toBe(historyImportRequiredTables.length);
    expect(result.rowCounts).toHaveLength(historyImportRequiredTables.length);
    for (const row of result.rowCounts) {
      expect(row.rows).toBeGreaterThanOrEqual(0);
    }
  });

  it("PGlite 未迁移时：如实报告必需表全部缺失", async () => {
    const database = createLocalDatabase();
    openDatabases.push(database);
    const result = await runZeroMutationDatabasePreflight(database);
    expect(result.readOnlyEnforced).toBe(true);
    expect(result.missingTableCount).toBe(historyImportRequiredTables.length);
    expect(result.rowCounts).toHaveLength(0);
  });

  it("预检前后表计数完全一致，证明零数据库变更", async () => {
    const database = createLocalDatabase();
    openDatabases.push(database);
    await migrateDatabase(database);
    await seedCoreDatabase(database);
    const first = await runZeroMutationDatabasePreflight(database);
    const second = await runZeroMutationDatabasePreflight(database);
    expect(second.rowCounts).toEqual(first.rowCounts);
  });

  const adminUrl = process.env.URMOTIV_TEST_POSTGRES_ADMIN_URL;
  const describePostgres = adminUrl === undefined ? describe.skip : describe;
  describePostgres("真实 PostgreSQL 验收库", () => {
    it("在真实验收库上只读预检通过，且预检后库被清理", async () => {
      if (adminUrl === undefined) throw new Error("未建立真实 PostgreSQL 测试数据库。");
      const scratchName = "urmotiv_history_import_preflight_unit";
      await dropHistoryImportDatabase(adminUrl, scratchName);
      await prepareHistoryImportDatabase(adminUrl, scratchName);
      const database = createPostgresDatabase({
        connectionString: historyImportDatabaseConnectionString(adminUrl, scratchName),
        maxConnections: 1,
      });
      try {
        const result = await runZeroMutationDatabasePreflight(database);
        expect(result.readOnlyEnforced).toBe(true);
        expect(result.missingTableCount).toBe(0);
        expect(result.presentTableCount).toBe(historyImportRequiredTables.length);
        expect(result.serverVersion.length).toBeGreaterThan(0);
      } finally {
        await database.close();
        await dropHistoryImportDatabase(adminUrl, scratchName);
      }
    }, 300_000);
  });
});
