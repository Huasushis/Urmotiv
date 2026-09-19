import { createHash, randomUUID } from "node:crypto";
import { importedReviewDataSchema, importedReviewItemType } from "@urmotiv/contracts";
import type { DatabaseExecutor, DatabaseHandle } from "@urmotiv/database";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { computeProblemContentHash, DatabaseDataStore, lockUserPolicyForAuthorization } from "./database-store";
import { hasPermission } from "./permissions";
import { DatabaseReviewItemStore } from "./review-item-store";
import { ProblemService } from "./service";

const bindingSchema = z.object({
  problemId: z.string().regex(/^[1-9]\d*$/),
  expectedRevision: z.number().int().positive(),
  expectedContentHash: z.string().regex(/^[a-f0-9]{64}$/)
}).strict();

export const historicalReviewImportSchema = z.object({
  version: z.literal(1),
  actorUserId: z.string().regex(/^(0|[1-9]\d*)$/),
  records: z.array(bindingSchema.extend({ review: importedReviewDataSchema })).min(1).max(1_000),
  disableExternalReview: z.array(bindingSchema).max(1_000)
}).strict().superRefine((input, context) => {
  for (const values of [input.records.map((r) => r.problemId),
    input.records.map((r) => `${r.review.sourceSha256}:${r.review.sourceNumber}`),
    input.disableExternalReview.map((r) => r.problemId)]) {
    if (new Set(values).size !== values.length) context.addIssue({ code: "custom", message: "重复的历史记录对应关系。" });
  }
});

const conclusionText = { A: "可直接入库", B: "小修后可用", C: "大修后复验", D: "淘汰或不建议" };
class DryRunRollback extends Error {}

/** Offline administrator import. Reuses normal authorization, revision and decision logic. */
export async function importHistoricalReviews(database: DatabaseHandle, raw: unknown, apply = false) {
  const input = historicalReviewImportSchema.parse(raw);
  const result = { applied: apply, imported: 0, unchanged: 0, disabled: 0 };
  try {
    await database.transaction(async (executor) => {
      // Every operation participates in this one transaction, including the dry run.
      const scoped = { ...database, ...executor,
        transaction: <T>(work: (transaction: DatabaseExecutor) => Promise<T>) => work(executor)
      } as DatabaseHandle;
      const store = new DatabaseDataStore(scoped);
      const items = new DatabaseReviewItemStore(scoped);
      const service = new ProblemService(store, { reviewItems: items });
      const actor = await lockUserPolicyForAuthorization(executor, BigInt(input.actorUserId));
      if (!actor || actor.accountType !== "human" || !hasPermission(actor, "auth.login") ||
          !hasPermission(actor, "problem.status.change") || !hasPermission(actor, "problem.view.all")) {
        throw new Error("HISTORY_IMPORT_FORBIDDEN");
      }
      await executor.query(sql`SELECT version FROM tag_catalog_state WHERE singleton = true FOR SHARE`);
      const bindings = new Map<string, z.infer<typeof bindingSchema>>();
      for (const binding of [...input.records, ...input.disableExternalReview]) {
        const old = bindings.get(binding.problemId);
        if (old && (old.expectedRevision !== binding.expectedRevision || old.expectedContentHash !== binding.expectedContentHash)) {
          throw new Error("HISTORY_IMPORT_BINDING_CONFLICT");
        }
        bindings.set(binding.problemId, binding);
      }
      const skipped = new Set<string>();
      for (const record of input.records) {
        const previous = await executor.query<{ data: unknown; problem_id: string }>(sql`
          SELECT item.data, round.problem_id::text AS problem_id FROM review_items item JOIN review_rounds round ON round.id = item.round_id
          WHERE item.type = ${importedReviewItemType}
            AND item.data->>'sourceSha256' = ${record.review.sourceSha256}
            AND item.data->>'sourceNumber' = ${String(record.review.sourceNumber)}
        `);
        if (previous.length > 0) {
          if (previous.length !== 1 || previous[0]?.problem_id !== record.problemId || JSON.stringify(importedReviewDataSchema.parse(previous[0]?.data)) !== JSON.stringify(record.review)) {
            throw new Error("HISTORY_IMPORT_RECORD_CONFLICT");
          }
          skipped.add(record.problemId);
        }
      }
      // Verify the complete binding set before modifying anything. IDs alone are not evidence.
      for (const binding of [...bindings.values()].sort((a, b) => Number(a.problemId) - Number(b.problemId))) {
        const visible = await service.getProblem(actor, binding.problemId);
        if (!hasPermission(actor, "problem.status.change", { ownerId: visible.owner.id, objectId: visible.id })) {
          throw new Error("HISTORY_IMPORT_FORBIDDEN");
        }
        const rows = await executor.query<{ revision: number; hash: string; enabled: boolean }>(sql`
          SELECT p.current_revision AS revision, r.content_hash AS hash, p.external_review_enabled AS enabled
          FROM problems p JOIN problem_revisions r ON r.problem_id = p.id AND r.revision = p.current_revision
          WHERE p.id = ${BigInt(binding.problemId)} AND p.deleted_at IS NULL FOR UPDATE OF p
        `);
        const alreadyDisabled = rows[0]?.enabled === false &&
          !input.records.some((record) => record.problemId === binding.problemId);
        if (!rows[0] || (!skipped.has(binding.problemId) &&
            ((!alreadyDisabled && rows[0].revision !== binding.expectedRevision) || rows[0].hash !== binding.expectedContentHash))) {
          throw new Error("HISTORY_IMPORT_BINDING_MISMATCH");
        }
      }
      for (const binding of input.disableExternalReview) {
        const problem = await service.getProblem(actor, binding.problemId);
        if (problem.externalReviewEnabled !== false) {
          await service.updateExternalReview(actor, problem.id, { enabled: false, expectedRevision: problem.revision });
          result.disabled++;
        }
      }
      for (const record of input.records) {
        if (skipped.has(record.problemId)) { result.unchanged++; continue; }
        let problem = await service.getProblem(actor, record.problemId);
        if (problem.status !== "draft" && problem.status !== "rejected") {
          throw new Error("HISTORY_IMPORT_EXISTING_REVIEW");
        }
        if (problem.externalReviewEnabled !== false) {
          problem = await service.updateExternalReview(actor, problem.id, { enabled: false, expectedRevision: problem.revision });
        }
        const summary = `历史审核：${conclusionText[record.review.conclusion]}`;
        const stored = await store.runProblemTransaction(problem.id, async (transaction) => transaction.getProblem());
        if (!stored) throw new Error("HISTORY_IMPORT_BINDING_MISMATCH");
        const policy = await store.getReviewPolicy();
        const pending = { ...stored, status: "pending_review" as const, revision: stored.revision + 1,
          reviewRound: stored.reviewRound + 1, updatedAt: new Date().toISOString() };
        // Historical records may legitimately lack a solution. Preserve that absence;
        // do not invent content to pass the validation for a new submission.
        pending.reviewRoundState = { ruleId: policy.ruleId, pluginVersion: policy.pluginVersion, settings: policy.settings,
          round: pending.reviewRound, status: "open", submittedContentHash: computeProblemContentHash(pending),
          decisionReason: null, countedOpinionIds: [], usedOpinionIds: [], usedReviewItemIds: [], decisionSource: null, decidedAt: null };
        const importedItem = {
          type: importedReviewItemType, source: "human", sourceUserId: actor.id,
          visibility: "author", summary, data: record.review,
          contentHash: createHash("sha256").update(JSON.stringify(record.review)).digest("hex")
        } as const;
        const saved = await store.replaceProblemWithRevisionAction(pending, stored.revision, actor.id,
          async (_revisionId, transaction) => { await items.append(pending.id, pending.reviewRound, [importedItem], transaction); });
        if (!saved) throw new Error("HISTORY_IMPORT_BINDING_MISMATCH");
        problem = await service.getProblem(actor, problem.id);
        if (record.review.conclusion === "A" || record.review.conclusion === "D") {
          await service.finalizeReview(actor, problem.id, {
            expectedRound: problem.reviewRound, expectedRevision: problem.revision,
            decision: record.review.conclusion === "A" ? "approve" : "reject", reason: summary
          }, randomUUID());
        }
        await executor.execute(sql`
          INSERT INTO audit_events (actor_user_id, request_id, action, object_type, object_id, result, metadata)
          VALUES (${BigInt(actor.id)}, ${randomUUID()}::uuid, 'problem.review.import', 'problem', ${problem.id}, 'success',
            ${JSON.stringify({ sourceSha256: record.review.sourceSha256, sourceNumber: record.review.sourceNumber })}::jsonb)
        `);
        result.imported++;
      }
      if (!apply) throw new DryRunRollback();
    });
  } catch (error) {
    if (!(error instanceof DryRunRollback)) throw error;
  }
  return result;
}
