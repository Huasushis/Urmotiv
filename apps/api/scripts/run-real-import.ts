/**
 * Real PostgreSQL two-pass import proof for the 137-problem history pipeline.
 * Uses the formal importHistoryPackages function on a clean PG database.
 */
import {
  importHistoryPackages,
  prepareHistoryImportDatabase,
  dropHistoryImportDatabase,
} from "../src/history-migration/index";
import { createPostgresDatabase } from "@urmotiv/database";
import { sql } from "drizzle-orm";
import { rm } from "node:fs/promises";

const ADMIN_URL = "postgresql://urmotiv:testpassword@127.0.0.1:5433/urmotiv";
const DB_NAME = "urmotiv_history_import_acceptance_001";

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const getOpt = (name: string): string => {
    const idx = args.indexOf(name);
    if (idx === -1 || idx + 1 >= args.length) throw new Error(`Missing: ${name}`);
    return args[idx + 1];
  };

  const privateRoot = getOpt("--private-root");
  const packageDir = getOpt("--package-dir");
  const tagId = getOpt("--tag-id");

  console.log("=== Real PostgreSQL Two-Pass Import Proof ===");

  // Drop any existing DB, then prepare fresh
  console.log("Dropping existing database...");
  await dropHistoryImportDatabase(ADMIN_URL, DB_NAME);

  console.log("Preparing fresh database (migrations + seed)...");
  const prepared = await prepareHistoryImportDatabase(ADMIN_URL, DB_NAME);
  console.log(`Database: ${prepared.databaseName}`);

  const database = createPostgresDatabase({
    connectionString: prepared.connectionString,
    maxConnections: 8,
    applicationName: "urmotiv-history-import-acceptance",
  });

  // Clean any previous import output
  const outDir = `${privateRoot}/imported`;
  await rm(outDir, { recursive: true, force: true }).catch(() => {});

  // === Pass 1 ===
  console.log("\n=== Pass 1: First import ===");
  const r1 = await importHistoryPackages({
    privateRootDirectory: privateRoot,
    packageDirectory: packageDir,
    outputDirectory: outDir,
    dependencies: {
      database,
      requestedByUserId: "0",
      assignedTagId: tagId,
      storageRoot: `${privateRoot}/storage`,
    },
  });
  console.log(`imported=${r1.importedCount} skipped=${r1.skippedCount} failed=${r1.failedCount}`);
  if (r1.failedCount > 0) {
    for (const f of r1.failedCandidates) {
      console.log(`  FAILED: ${f.candidateId} code=${f.code}`);
    }
  }

  // Count problems in DB
  const { rows: countRows } = await database.execute(
    sql`SELECT COUNT(*)::int as count FROM problems`,
  );
  const totalProblems = countRows[0].count;

  // === Edit one title ===
  console.log("\n=== Editing one title before replay ===");
  const { rows: revRows } = await database.execute(
    sql`SELECT id, problem_id, title FROM problem_revisions ORDER BY problem_id LIMIT 1`,
  );
  let editedRevId: string | null = null;
  let originalTitle = "";
  if (revRows.length > 0) {
    editedRevId = revRows[0].id;
    originalTitle = revRows[0].title;
    const editedTitle = `${originalTitle} [已编辑]`;
    await database.execute(sql`UPDATE problem_revisions SET title = ${editedTitle} WHERE id = ${editedRevId}::uuid`);
    console.log(`Edited revision ${editedRevId}: "${originalTitle.slice(0, 30)}..." -> "${editedTitle.slice(0, 30)}..."`);
  }

  // === Pass 2: Replay ===
  console.log("\n=== Pass 2: Replay ===");
  const r2 = await importHistoryPackages({
    privateRootDirectory: privateRoot,
    packageDirectory: packageDir,
    outputDirectory: outDir,
    dependencies: {
      database,
      requestedByUserId: "0",
      assignedTagId: tagId,
      storageRoot: `${privateRoot}/storage`,
    },
  });
  console.log(`imported=${r2.importedCount} skipped=${r2.skippedCount} failed=${r2.failedCount}`);

  // === Verify title preserved ===
  console.log("\n=== Verifying title edit preserved ===");
  let titlePreserved = false;
  if (editedRevId) {
    const { rows: editRows } = await database.execute(
      sql`SELECT title FROM problem_revisions WHERE id = ${editedRevId}::uuid`,
    );
    if (editRows.length > 0) {
      titlePreserved = editRows[0].title.includes("[已编辑]");
      console.log(`Title after replay: "${editRows[0].title.slice(0, 50)}..."`);
    }
  }

  // === Verify statement/solution ===
  console.log("\n=== Verifying statement/solution ===");
  const { rows: stmtRows } = await database.execute(
    sql`SELECT COUNT(*)::int as count FROM problem_revisions WHERE basic_statement IS NOT NULL AND length(basic_statement) > 0`,
  );
  const { rows: solRows } = await database.execute(
    sql`SELECT COUNT(*)::int as count FROM problem_revisions WHERE basic_solution IS NOT NULL AND length(basic_solution) > 0`,
  );
  const { rows: nullSolRows } = await database.execute(
    sql`SELECT COUNT(*)::int as count FROM problem_revisions WHERE basic_solution IS NULL OR length(basic_solution) = 0`,
  );
  console.log(`basic_statement present: ${stmtRows[0].count}`);
  console.log(`basic_solution present: ${solRows[0].count}`);
  console.log(`basic_solution NULL/empty (truthful missing): ${nullSolRows[0].count}`);

  // === Verify tags ===
  const { rows: tagRows } = await database.execute(
    sql`SELECT COUNT(*)::int as count FROM problem_revision_tags WHERE tag_id = ${tagId}`,
  );
  console.log(`Problems with assigned tag: ${tagRows[0].count}`);

  // === Verify import jobs ===
  const { rows: jobRows } = await database.execute(
    sql`SELECT COUNT(*)::int as count FROM import_jobs`,
  );
  console.log(`Import jobs: ${jobRows[0].count}`);

  // === Verify stored_files ===
  const { rows: fileRows } = await database.execute(
    sql`SELECT COUNT(*)::int as count FROM stored_files WHERE purpose = 'import_input'`,
  );
  console.log(`Stored files (import_input): ${fileRows[0].count}`);

  // === Summary ===
  console.log("\n=== SUMMARY ===");
  console.log(`PASS exact-creation-count: ${r1.importedCount === 137} (imported=${r1.importedCount}, expected=137)`);
  console.log(`PASS replay-zero: ${r2.importedCount === 0} (imported=${r2.importedCount})`);
  console.log(`PASS title-edit-preserved: ${titlePreserved}`);
  console.log(`PASS total-problems: ${totalProblems === 137} (total=${totalProblems})`);
  console.log(`PASS statement-present: ${stmtRows[0].count === 137} (count=${stmtRows[0].count})`);
  console.log(`PASS tags-assigned: ${tagRows[0].count === 137} (count=${tagRows[0].count})`);
  console.log(`PASS import-jobs: ${jobRows[0].count === 137} (count=${jobRows[0].count})`);
  console.log(`PASS stored-files: ${fileRows[0].count === 137} (count=${fileRows[0].count})`);
  console.log(`INFO solution-present: ${solRows[0].count} (missing: ${nullSolRows[0].count})`);

  await database.close();
  console.log("\nDone.");
}

void main().catch((error) => {
  console.error("FATAL:", error instanceof Error ? error.message : String(error));
  process.exit(1);
});
