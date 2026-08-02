import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
  problemJudgeConfigSchema,
  type PermissionGrant,
  type ProblemJudgeConfig,
  type ProblemSample,
  type ProblemTag
} from "@urmotiv/contracts";
import type { DatabaseExecutor, DatabaseHandle } from "@urmotiv/database";
import { type SQL, sql } from "drizzle-orm";
import type {
  ProblemListFilters,
  StoredProblem,
  StoredReviewPolicy,
  StoredReviewRoundState,
  StoredReview,
  StoredSession,
  StoredUser,
  VisibleProblemPage,
} from "./domain";
import type { ProblemPermissionFilter, ProblemVisibility } from "./permissions";
import type {
  DataStore,
  EmailCredential,
  EmailRegistration,
  EmailVerificationTarget,
  EmailVerificationToken,
  ExternalIdentity,
  ProblemRevisionAction,
  ProblemTransaction
} from "./repository";
import { initialReviewPolicyRule } from "./review-decision";

const maximumDatabaseId = 9_223_372_036_854_775_807n;
interface UserRow extends Record<string, unknown> {
  id: string;
  nickname: string;
  account_type: "human" | "robot";
  disabled: boolean;
}

interface RoleRow extends Record<string, unknown> {
  user_id: string;
  display_name: string;
}

interface GrantRow extends Record<string, unknown> {
  user_id: string;
  permission_name: string;
  effect: "allow" | "deny";
  scope: "global" | "own" | "object";
  object_type: string | null;
  object_id: string | null;
  expires_at: Date | string | null;
}

interface ProblemRow extends Record<string, unknown> {
  id: string;
  owner_id: string;
  status: StoredProblem["status"];
  current_revision: number;
  current_review_round: number;
  created_at: Date | string;
  updated_at: Date | string;
  revision_id: string;
  title: string;
  type: StoredProblem["type"];
  codeforces_difficulty: number | null;
  thinking_level: number | null;
  coding_level: number | null;
  basic_statement: string;
  basic_solution: string;
  background: string;
  statement: string;
  input_format: string;
  output_format: string;
  constraints: string;
  solution: string;
  hints: string;
  judge_config: unknown;
  review_round_status: StoredReviewRoundState["status"] | null;
  review_rule_id: string | null;
  review_rule_version: string | null;
  review_rule_settings: unknown;
  submitted_content_hash: string | null;
  decision_reason: string | null;
  counted_opinion_ids: unknown;
  used_opinion_ids: unknown;
  used_review_item_ids: unknown;
  decision_source: StoredReviewRoundState["decisionSource"];
  decided_at: Date | string | null;
}

interface ReviewRow extends Record<string, unknown> {
  id: string;
  problem_id: string;
  expected_round: number;
  reviewer_id: string;
  reviewer_nickname: string;
  reviewer_account_type: "human" | "robot";
  source: StoredReview["source"];
  verdict: StoredReview["verdict"];
  codeforces_difficulty: number;
  quality_level: number;
  originality_level: number | null;
  thinking_level: number;
  coding_level: number;
  improvements: string;
  public_comment: string;
  private_note: string;
  created_at: Date | string;
  updated_at: Date | string;
}

function copy<T>(value: T): T {
  return structuredClone(value);
}

function parseDatabaseId(value: string): bigint | undefined {
  if (!/^(0|[1-9]\d*)$/.test(value)) {
    return undefined;
  }

  const id = BigInt(value);
  return id <= maximumDatabaseId ? id : undefined;
}

function requireDatabaseId(value: string, label: string): bigint {
  const id = parseDatabaseId(value);
  if (id === undefined) {
    throw new Error(`${label}不是有效的数据库编号。`);
  }
  return id;
}

function toIso(value: Date | string): string {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) {
    throw new Error("数据库返回了无效时间。");
  }
  return date.toISOString();
}

function toNullableNumber(value: number | null): number | null {
  return value === null ? null : Number(value);
}

function parseJudgeConfig(value: unknown): ProblemJudgeConfig | null {
  if (
    value === null ||
    value === undefined ||
    (typeof value === "object" && !Array.isArray(value) && Object.keys(value).length === 0)
  ) {
    return null;
  }
  const parsed = problemJudgeConfigSchema.safeParse(value);
  if (!parsed.success) {
    throw new Error("数据库中的评测配置不符合当前数据结构。");
  }
  return parsed.data;
}

function parseJsonObject(value: unknown, label: string): Record<string, unknown> {
  const parsed = typeof value === "string" ? JSON.parse(value) as unknown : value;
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`${label}不是有效对象。`);
  }
  return parsed as Record<string, unknown>;
}

function parseStringArray(value: unknown, label: string): string[] {
  const parsed = typeof value === "string" ? JSON.parse(value) as unknown : value;
  if (!Array.isArray(parsed) || parsed.some((item) => typeof item !== "string")) {
    throw new Error(`${label}不是有效文本数组。`);
  }
  return [...parsed];
}

function sqlList(values: readonly (bigint | string)[], cast?: "uuid"): SQL {
  return sql.join(
    values.map((value) => (cast === "uuid" ? sql`${value}::uuid` : sql`${value}`)),
    sql`, `,
  );
}

async function hasActiveTags(
  executor: DatabaseExecutor,
  tagIds: readonly string[],
): Promise<boolean> {
  const uniqueTagIds = [...new Set(tagIds)];
  if (uniqueTagIds.length === 0) {
    return true;
  }
  const rows = await executor.query<{ count: number | string }>(sql`
    SELECT count(*)::integer AS count
    FROM tags
    WHERE is_active = true AND item_kind = 'tag' AND id IN (${sqlList(uniqueTagIds)})
  `);
  return Number(rows[0]?.count ?? 0) === uniqueTagIds.length;
}

export function computeProblemContentHash(problem: StoredProblem): string {
  return contentHash(problem);
}

function contentHash(problem: StoredProblem): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        title: problem.title,
        type: problem.type,
        tagIds: problem.tagIds,
        codeforcesDifficulty: problem.codeforcesDifficulty,
        thinkingLevel: problem.thinkingLevel,
        codingLevel: problem.codingLevel,
        content: problem.content,
        samples: problem.samples,
        judgeConfig: problem.judgeConfig ?? null,
        status: problem.status,
      }),
      "utf8",
    )
    .digest("hex");
}

function sessionDigest(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}


async function upsertStudentIdentifiers(
  executor: DatabaseExecutor,
  userId: bigint,
  studentIds: readonly { readonly attribute: string; readonly value: string }[] | undefined,
): Promise<void> {
  for (const identifier of studentIds ?? []) {
    const value = identifier.value.trim();
    if (value.length === 0 || value.length > 255) {
      continue;
    }
    // (kind, source, value) 全局唯一：同一学号已经绑定到其他账号时保持不动，
    // 留给管理员按“歧义需人工确认”的规则处理，不自动改绑。
    await executor.execute(sql`
      INSERT INTO user_identifiers (id, user_id, kind, value, source)
      VALUES (${randomUUID()}::uuid, ${userId}, 'student_id', ${value}, ${identifier.attribute})
      ON CONFLICT (kind, source, value) DO NOTHING
    `);
  }
}

export async function loadUsers(
  executor: DatabaseExecutor,
  requestedIds?: readonly bigint[],
): Promise<StoredUser[]> {
  if (requestedIds?.length === 0) {
    return [];
  }

  const userFilter = requestedIds === undefined
    ? sql`WHERE u.account_type IN ('human', 'robot')`
    : sql`WHERE u.account_type IN ('human', 'robot') AND u.id IN (${sqlList(requestedIds)})`;
  const membershipFilter =
    requestedIds === undefined ? sql`` : sql`AND membership.user_id IN (${sqlList(requestedIds)})`;
  const directGrantFilter =
    requestedIds === undefined
      ? sql``
      : sql`AND grant_record.subject_user_id IN (${sqlList(requestedIds)})`;
  const roleGrantFilter =
    requestedIds === undefined ? sql`` : sql`AND membership.user_id IN (${sqlList(requestedIds)})`;

  // A transaction executor is backed by one node-postgres client. Its queries
  // must be awaited in order; concurrent client.query calls are deprecated and
  // can make authentication observe or complete statements unpredictably.
  const userRows = await executor.query<UserRow>(sql`
      SELECT
        u.id::text AS id,
        u.nickname,
        u.account_type,
        (u.disabled_at IS NOT NULL) AS disabled
      FROM users u
      ${userFilter}
      ORDER BY u.id
    `);
  const roleRows = await executor.query<RoleRow>(sql`
      SELECT membership.user_id::text AS user_id, role.display_name
      FROM role_memberships membership
      JOIN users user_record
        ON user_record.id = membership.user_id
       AND user_record.account_type IN ('human', 'robot')
      JOIN roles role ON role.id = membership.role_id
      WHERE membership.revoked_at IS NULL
        AND (membership.expires_at IS NULL OR membership.expires_at > now())
        ${membershipFilter}
      ORDER BY role.display_name, role.id
    `);
  const grantRows = await executor.query<GrantRow>(sql`
      SELECT
        grant_record.subject_user_id::text AS user_id,
        grant_record.permission_name,
        grant_record.effect,
        grant_record.scope,
        grant_record.object_type,
        grant_record.object_id,
        grant_record.expires_at
      FROM permission_grants grant_record
      JOIN users user_record
        ON user_record.id = grant_record.subject_user_id
       AND user_record.account_type IN ('human', 'robot')
      WHERE grant_record.subject_user_id IS NOT NULL
        AND grant_record.revoked_at IS NULL
        ${directGrantFilter}
      UNION ALL
      SELECT
        membership.user_id::text AS user_id,
        grant_record.permission_name,
        grant_record.effect,
        grant_record.scope,
        grant_record.object_type,
        grant_record.object_id,
        grant_record.expires_at
      FROM role_memberships membership
      JOIN users user_record
        ON user_record.id = membership.user_id
       AND user_record.account_type IN ('human', 'robot')
      JOIN permission_grants grant_record ON grant_record.subject_role_id = membership.role_id
      WHERE membership.revoked_at IS NULL
        AND (membership.expires_at IS NULL OR membership.expires_at > now())
        AND grant_record.revoked_at IS NULL
        ${roleGrantFilter}
    `);

  const rolesByUser = new Map<string, string[]>();
  for (const row of roleRows) {
    const roles = rolesByUser.get(row.user_id) ?? [];
    roles.push(row.display_name);
    rolesByUser.set(row.user_id, roles);
  }

  const grantsByUser = new Map<string, PermissionGrant[]>();
  for (const row of grantRows) {
    if (row.scope === "object") {
      const expectedObjectType = row.permission_name.startsWith("problem.")
        ? "problem"
        : row.permission_name.startsWith("contest.")
          ? "contest"
          : undefined;
      if (expectedObjectType === undefined || row.object_type !== expectedObjectType) {
        continue;
      }
    }

    const grants = grantsByUser.get(row.user_id) ?? [];
    grants.push({
      permission: row.permission_name,
      effect: row.effect,
      scope: row.scope,
      ...(row.object_id === null ? {} : { objectId: row.object_id }),
      ...(row.expires_at === null ? {} : { expiresAt: toIso(row.expires_at) }),
    });
    grantsByUser.set(row.user_id, grants);
  }

  return userRows.map((row) => ({
    id: row.id,
    nickname: row.nickname,
    accountType: row.account_type,
    disabled: row.disabled,
    roles: rolesByUser.get(row.id) ?? [],
    grants: grantsByUser.get(row.id) ?? [],
    isRoot: row.id === "0",
  }));
}

async function loadProblemRows(
  executor: DatabaseExecutor,
  where: SQL,
  suffix: SQL = sql``,
  includeDeleted = false,
): Promise<ProblemRow[]> {
  return executor.query<ProblemRow>(sql`
    SELECT
      problem.id::text AS id,
      problem.owner_id::text AS owner_id,
      problem.status,
      problem.current_revision,
      problem.current_review_round,
      problem.created_at,
      problem.updated_at,
      revision.id::text AS revision_id,
      revision.title,
      revision.type,
      revision.codeforces_difficulty,
      revision.thinking_level,
      revision.coding_level,
      revision.basic_statement,
      revision.basic_solution,
      revision.background,
      revision.statement,
      revision.input_format,
      revision.output_format,
      revision.constraints,
      revision.solution,
      revision.hints,
      revision.judge_config,
      current_round.status AS review_round_status,
      current_round.rule_id AS review_rule_id,
      current_round.rule_version AS review_rule_version,
      current_round.rule_settings AS review_rule_settings,
      submitted_revision.content_hash AS submitted_content_hash,
      current_round.decision_reason,
      current_round.counted_opinion_ids,
      current_round.used_opinion_ids,
      current_round.used_review_item_ids,
      current_round.decision_source,
      current_round.decided_at
    FROM problems problem
    JOIN problem_revisions revision
      ON revision.problem_id = problem.id
      AND revision.revision = problem.current_revision
    LEFT JOIN review_rounds current_round
      ON current_round.problem_id = problem.id
      AND current_round.round = problem.current_review_round
    LEFT JOIN problem_revisions submitted_revision
      ON submitted_revision.id = current_round.submitted_revision_id
    WHERE ${includeDeleted ? sql`true` : sql`problem.deleted_at IS NULL`} AND (${where})
    ${suffix}
  `);
}

async function hydrateProblems(
  executor: DatabaseExecutor,
  rows: readonly ProblemRow[],
): Promise<StoredProblem[]> {
  if (rows.length === 0) {
    return [];
  }

  const revisionIds = rows.map((row) => row.revision_id);
  const [tagRows, sampleRows] = await Promise.all([
    executor.query<{ revision_id: string; tag_id: string }>(sql`
      SELECT revision_id::text AS revision_id, tag_id
      FROM problem_revision_tags
      WHERE revision_id IN (${sqlList(revisionIds, "uuid")})
      ORDER BY tag_id
    `),
    executor.query<{
      id: string;
      revision_id: string;
      input: string;
      output: string;
      explanation: string;
    }>(sql`
      SELECT id::text AS id, revision_id::text AS revision_id, input, output, explanation
      FROM problem_samples
      WHERE revision_id IN (${sqlList(revisionIds, "uuid")})
      ORDER BY revision_id, position
    `),
  ]);

  const tagsByRevision = new Map<string, string[]>();
  for (const row of tagRows) {
    const tagIds = tagsByRevision.get(row.revision_id) ?? [];
    tagIds.push(row.tag_id);
    tagsByRevision.set(row.revision_id, tagIds);
  }

  const samplesByRevision = new Map<string, ProblemSample[]>();
  for (const row of sampleRows) {
    const samples = samplesByRevision.get(row.revision_id) ?? [];
    samples.push({
      id: row.id,
      input: row.input,
      output: row.output,
      explanation: row.explanation,
    });
    samplesByRevision.set(row.revision_id, samples);
  }

  return rows.map((row) => ({
    id: row.id,
    revisionId: row.revision_id,
    title: row.title,
    type: row.type,
    tagIds: tagsByRevision.get(row.revision_id) ?? [],
    codeforcesDifficulty: toNullableNumber(row.codeforces_difficulty),
    thinkingLevel: toNullableNumber(row.thinking_level),
    codingLevel: toNullableNumber(row.coding_level),
    content: {
      basicStatement: row.basic_statement,
      basicSolution: row.basic_solution,
      background: row.background,
      statement: row.statement,
      inputFormat: row.input_format,
      outputFormat: row.output_format,
      constraints: row.constraints,
      solution: row.solution,
      hints: row.hints,
    },
    samples: samplesByRevision.get(row.revision_id) ?? [],
    judgeConfig: parseJudgeConfig(row.judge_config),
    status: row.status,
    ownerId: row.owner_id,
    revision: Number(row.current_revision),
    reviewRound: Number(row.current_review_round),
    ...(row.review_rule_id === null
      ? {}
      : {
          reviewRoundState: {
            round: Number(row.current_review_round),
            status: row.review_round_status ?? "open",
            ruleId: row.review_rule_id,
            pluginVersion: row.review_rule_version ?? "1.0.0",
            settings: parseJsonObject(row.review_rule_settings, "审核规则设置"),
            submittedContentHash: row.submitted_content_hash ?? "",
            decisionReason: row.decision_reason,
            countedOpinionIds: parseStringArray(
              row.counted_opinion_ids ?? [],
              "审核汇总意见编号"
            ),
            usedOpinionIds: parseStringArray(row.used_opinion_ids ?? [], "审核决定意见编号"),
            usedReviewItemIds: parseStringArray(
              row.used_review_item_ids ?? [],
              "审核决定条目编号"
            ),
            decisionSource: row.decision_source,
            decidedAt: row.decided_at === null ? null : toIso(row.decided_at)
          }
        }),
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
  }));
}

function numericObjectIds(values: readonly string[]): bigint[] {
  return [...new Set(values)]
    .map(parseDatabaseId)
    .filter((value): value is bigint => value !== undefined);
}

function objectIdCondition(column: SQL, ids: readonly bigint[]): SQL | undefined {
  return ids.length === 0 ? undefined : sql`${column} IN (${sqlList(ids)})`;
}

export function visibilityCondition(visibility: ProblemVisibility): SQL | undefined {
  const viewerId = parseDatabaseId(visibility.viewerId);
  if (viewerId === undefined || visibility.viewAll.globalDeny || visibility.viewOwn.globalDeny) {
    return undefined;
  }

  const allowConditions: SQL[] = [];
  if (visibility.viewAll.globalAllow) {
    allowConditions.push(sql`true`);
  }

  const allAllowedIds = numericObjectIds(visibility.viewAll.allowedObjectIds);
  const allObjectAllow = objectIdCondition(sql`problem.id`, allAllowedIds);
  if (allObjectAllow !== undefined) {
    allowConditions.push(allObjectAllow);
  }

  if (visibility.viewAll.ownAllow) {
    allowConditions.push(sql`problem.owner_id = ${viewerId}`);
  }

  if (visibility.viewOwn.globalAllow || visibility.viewOwn.ownAllow) {
    allowConditions.push(sql`problem.owner_id = ${viewerId}`);
  }

  const ownAllowedIds = numericObjectIds(visibility.viewOwn.allowedObjectIds);
  const ownObjectAllow = objectIdCondition(sql`problem.id`, ownAllowedIds);
  if (ownObjectAllow !== undefined) {
    allowConditions.push(sql`(problem.owner_id = ${viewerId} AND ${ownObjectAllow})`);
  }

  if (allowConditions.length === 0) {
    return undefined;
  }

  const denyConditions: SQL[] = [];
  const deniedIds = numericObjectIds([
    ...visibility.viewAll.deniedObjectIds,
    ...visibility.viewOwn.deniedObjectIds,
  ]);
  const objectDeny = objectIdCondition(sql`problem.id`, deniedIds);
  if (objectDeny !== undefined) {
    denyConditions.push(sql`NOT (${objectDeny})`);
  }

  if (visibility.viewAll.ownDeny || visibility.viewOwn.ownDeny) {
    denyConditions.push(sql`problem.owner_id <> ${viewerId}`);
  }

  const allowed = sql`(${sql.join(allowConditions, sql` OR `)})`;
  return denyConditions.length === 0
    ? allowed
    : sql`${allowed} AND (${sql.join(denyConditions, sql` AND `)})`;
}

export function problemPermissionCondition(
  permission: ProblemPermissionFilter,
): SQL | undefined {
  const viewerId = parseDatabaseId(permission.viewerId);
  const rule = permission.rule;
  if (viewerId === undefined || rule.globalDeny) {
    return undefined;
  }

  const allowConditions: SQL[] = [];
  if (rule.globalAllow) {
    allowConditions.push(sql`true`);
  }
  const allowedObjectIds = numericObjectIds(rule.allowedObjectIds);
  const objectAllow = objectIdCondition(sql`problem.id`, allowedObjectIds);
  if (objectAllow !== undefined) {
    allowConditions.push(objectAllow);
  }
  if (rule.ownAllow) {
    allowConditions.push(sql`problem.owner_id = ${viewerId}`);
  }
  if (allowConditions.length === 0) {
    return undefined;
  }

  const denyConditions: SQL[] = [];
  const deniedObjectIds = numericObjectIds(rule.deniedObjectIds);
  const objectDeny = objectIdCondition(sql`problem.id`, deniedObjectIds);
  if (objectDeny !== undefined) {
    denyConditions.push(sql`NOT (${objectDeny})`);
  }
  if (rule.ownDeny) {
    denyConditions.push(sql`problem.owner_id <> ${viewerId}`);
  }

  const allowed = sql`(${sql.join(allowConditions, sql` OR `)})`;
  return denyConditions.length === 0
    ? allowed
    : sql`${allowed} AND (${sql.join(denyConditions, sql` AND `)})`;
}

async function insertProblemRevision(
  executor: DatabaseExecutor,
  problem: StoredProblem,
  problemId: bigint,
  changedByUserId: bigint,
  changeReason: string,
  previousRevisionId?: string,
): Promise<string> {
  const revisionId = randomUUID();
  await executor.execute(sql`
    INSERT INTO problem_revisions (
      id,
      problem_id,
      revision,
      status,
      title,
      type,
      codeforces_difficulty,
      thinking_level,
      coding_level,
      basic_statement,
      basic_solution,
      background,
      statement,
      input_format,
      output_format,
      constraints,
      solution,
      hints,
      judge_config,
      changed_fields,
      content_hash,
      change_reason,
      created_by_user_id,
      created_at
    ) VALUES (
      ${revisionId}::uuid,
      ${problemId},
      ${problem.revision},
      ${problem.status}::problem_status,
      ${problem.title},
      ${problem.type}::problem_type,
      ${problem.codeforcesDifficulty},
      ${problem.thinkingLevel},
      ${problem.codingLevel},
      ${problem.content.basicStatement},
      ${problem.content.basicSolution},
      ${problem.content.background},
      ${problem.content.statement},
      ${problem.content.inputFormat},
      ${problem.content.outputFormat},
      ${problem.content.constraints},
      ${problem.content.solution},
      ${problem.content.hints},
      ${JSON.stringify(problem.judgeConfig ?? {})}::jsonb,
      '[]'::jsonb,
      ${contentHash(problem)},
      ${changeReason},
      ${changedByUserId},
      ${problem.updatedAt}::timestamptz
    )
  `);

  for (const tagId of problem.tagIds) {
    await executor.execute(sql`
      INSERT INTO problem_revision_tags (revision_id, tag_id)
      VALUES (${revisionId}::uuid, ${tagId})
    `);
  }

  for (const [position, sample] of problem.samples.entries()) {
    await executor.execute(sql`
      INSERT INTO problem_samples (id, revision_id, position, input, output, explanation)
      VALUES (
        ${sample.id}::uuid,
        ${revisionId}::uuid,
        ${position},
        ${sample.input},
        ${sample.output},
        ${sample.explanation}
      )
    `);
  }

  if (previousRevisionId !== undefined) {
    await executor.execute(sql`
      INSERT INTO problem_revision_files (revision_id, file_id, category, logical_path, position)
      SELECT ${revisionId}::uuid, relation.file_id, relation.category,
             relation.logical_path, relation.position
      FROM problem_revision_files relation
      JOIN stored_files file ON file.id = relation.file_id
      WHERE relation.revision_id = ${previousRevisionId}::uuid
        AND file.purpose = 'problem'
        AND file.deleted_at IS NULL
        AND (file.expires_at IS NULL OR file.expires_at > now())
    `);
  }

  return revisionId;
}

/**
 * Tag-reference writers take the catalogue state lock before any problem row.
 * Catalogue mutations take the same row exclusively before touching tags or
 * problems, so neither side can form a problem -> tag / tag -> problem cycle.
 */
async function lockTagCatalogReferenceWindow(executor: DatabaseExecutor): Promise<number> {
  const rows = await executor.query<{ version: number }>(sql`
    SELECT version
    FROM tag_catalog_state
    WHERE singleton = true
    FOR SHARE
  `);
  const version = Number(rows[0]?.version);
  if (!Number.isSafeInteger(version) || version < 1) {
    throw new Error("知识点目录版本缺失。");
  }
  return version;
}

export interface TagCatalogProblemRevisionInput {
  readonly problemId: string;
  readonly expectedRevision: number;
  readonly expectedRevisionId: string;
  readonly targetTagId: string;
  readonly replacementTagId?: string;
  readonly actorUserId: string;
  readonly updatedAt: string;
}

/**
 * Creates the immutable management revision used by catalog deactivation.
 * The caller must already hold the problem/current-revision locks. This helper
 * deliberately returns only success/failure and never exposes problem content
 * to the catalog API response or audit metadata.
 */
export async function createTagCatalogProblemRevision(
  executor: DatabaseExecutor,
  input: TagCatalogProblemRevisionInput,
): Promise<boolean> {
  const problemId = parseDatabaseId(input.problemId);
  const actorUserId = parseDatabaseId(input.actorUserId);
  if (problemId === undefined || actorUserId === undefined) {
    return false;
  }

  const problem = (
    await hydrateProblems(
      executor,
      await loadProblemRows(executor, sql`problem.id = ${problemId}`, sql``, true),
    )
  )[0];
  if (
    problem === undefined
    || problem.revision !== input.expectedRevision
    || problem.revisionId !== input.expectedRevisionId
    || !problem.tagIds.includes(input.targetTagId)
  ) {
    return false;
  }

  const nextTags = new Set(problem.tagIds.filter((tagId) => tagId !== input.targetTagId));
  // A replacement is only a safety net for a sole-tag problem. Multi-tag
  // problems retain their other tags and must not gain unrelated metadata.
  if (nextTags.size === 0 && input.replacementTagId !== undefined) {
    nextTags.add(input.replacementTagId);
  }
  const tagIds = [...nextTags].sort();
  if (tagIds.length < 1 || tagIds.length > 30) {
    return false;
  }

  const nextProblem: StoredProblem = {
    ...copy(problem),
    tagIds,
    revision: problem.revision + 1,
    updatedAt: input.updatedAt,
  };
  const revisionId = await insertProblemRevision(
    executor,
    nextProblem,
    problemId,
    actorUserId,
    "知识点目录停用管理修订",
    problem.revisionId,
  );
  // Package format extensions belong to the immutable revision as well. They
  // are not part of StoredProblem, so copy them explicitly instead of silently
  // resetting them on this administrative metadata-only revision.
  await executor.execute(sql`
    UPDATE problem_revisions next_revision
    SET format_extensions = previous_revision.format_extensions,
        changed_fields = '["tagIds"]'::jsonb
    FROM problem_revisions previous_revision
    WHERE next_revision.id = ${revisionId}::uuid
      AND previous_revision.id = ${problem.revisionId}::uuid
  `);
  const updated = await executor.query<{ id: string }>(sql`
    UPDATE problems
    SET current_revision = ${nextProblem.revision},
        updated_at = ${input.updatedAt}::timestamptz
    WHERE id = ${problemId}
      AND current_revision = ${input.expectedRevision}
    RETURNING id::text AS id
  `);
  return updated.length === 1;
}

async function insertReviewRound(
  executor: DatabaseExecutor,
  problem: StoredProblem,
  problemId: bigint,
  revisionId: string,
  submittedByUserId: bigint,
): Promise<void> {
  const initialRule = initialReviewPolicyRule();
  const roundState: StoredReviewRoundState = problem.reviewRoundState ?? {
    ...initialRule,
    round: problem.reviewRound,
    status: "open",
    submittedContentHash: contentHash(problem),
    decisionReason: null,
    countedOpinionIds: [],
    usedOpinionIds: [],
    usedReviewItemIds: [],
    decisionSource: null,
    decidedAt: null
  };
  if (
    roundState.round !== problem.reviewRound ||
    roundState.status !== "open" ||
    roundState.submittedContentHash !== contentHash(problem)
  ) {
    throw new Error("新审核轮次的规则快照与提交修订不一致。");
  }
  await executor.execute(sql`
    INSERT INTO review_rounds (
      id,
      problem_id,
      round,
      submitted_revision_id,
      status,
      rule_id,
      rule_version,
      rule_settings,
      submitted_by_user_id,
      created_at
    ) VALUES (
      ${randomUUID()}::uuid,
      ${problemId},
      ${problem.reviewRound},
      ${revisionId}::uuid,
      'open',
      ${roundState.ruleId},
      ${roundState.pluginVersion},
      ${JSON.stringify(roundState.settings)}::jsonb,
      ${submittedByUserId},
      ${problem.updatedAt}::timestamptz
    )
  `);
}

async function replaceProblemInTransaction(
  executor: DatabaseExecutor,
  problem: StoredProblem,
  expectedRevision: number,
  changedByUserId: string | undefined,
  revisionAction?: ProblemRevisionAction,
): Promise<boolean> {
  const problemId = parseDatabaseId(problem.id);
  if (problemId === undefined) {
    return false;
  }

  await lockTagCatalogReferenceWindow(executor);

  const lockedRows = await executor.query<{
    current_revision: number;
    current_review_round: number;
    status: StoredProblem["status"];
  }>(sql`
    SELECT current_revision, current_review_round, status
    FROM problems
    WHERE id = ${problemId} AND deleted_at IS NULL
    FOR UPDATE
  `);
  const current = lockedRows[0];
  if (
    current === undefined ||
    Number(current.current_revision) !== expectedRevision ||
    problem.revision !== expectedRevision + 1 ||
    (problem.reviewRound !== Number(current.current_review_round) &&
      problem.reviewRound !== Number(current.current_review_round) + 1)
  ) {
    return false;
  }

  if (Number(current.current_review_round) > 0) {
    await executor.query<{ id: string }>(sql`
      SELECT id::text AS id
      FROM review_rounds
      WHERE problem_id = ${problemId}
        AND round = ${Number(current.current_review_round)}
      FOR UPDATE
    `);
  }

  if (
    problem.reviewRound === Number(current.current_review_round) + 1 &&
    problem.status !== "pending_review"
  ) {
    return false;
  }

  const currentRevisionRows = await executor.query<{ id: string }>(sql`
    SELECT id::text AS id
    FROM problem_revisions
    WHERE problem_id = ${problemId}
      AND revision = ${expectedRevision}
  `);
  const previousRevisionId = currentRevisionRows[0]?.id;
  if (previousRevisionId === undefined) {
    throw new Error("Current problem revision is missing.");
  }

  const actorId = requireDatabaseId(changedByUserId ?? problem.ownerId, "修订操作者编号");
  const revisionId = await insertProblemRevision(
    executor,
    problem,
    problemId,
    actorId,
    "保存题目修订",
    previousRevisionId,
  );
  const updated = await executor.query<{ id: string }>(sql`
    UPDATE problems
    SET status = ${problem.status}::problem_status,
        current_revision = ${problem.revision},
        current_review_round = ${problem.reviewRound},
        status_changed_by_user_id = CASE
          WHEN status <> ${problem.status}::problem_status THEN ${actorId}
          ELSE status_changed_by_user_id
        END,
        updated_at = ${problem.updatedAt}::timestamptz
    WHERE id = ${problemId} AND current_revision = ${expectedRevision}
    RETURNING id::text AS id
  `);
  if (updated.length !== 1) {
    throw new Error("保存题目修订时数据库状态发生变化。");
  }

  if (problem.reviewRound === Number(current.current_review_round) + 1) {
    await insertReviewRound(executor, problem, problemId, revisionId, actorId);
  }
  await revisionAction?.(revisionId, executor);

  if (current.status === "pending_review" && problem.status !== "pending_review") {
    const roundStatus =
      problem.status === "approved"
        ? "approved"
        : problem.status === "rejected"
          ? "rejected"
          : "withdrawn";
    const roundState = problem.reviewRoundState;
    if (
      roundState === undefined ||
      roundState.round !== Number(current.current_review_round) ||
      roundState.status !== roundStatus ||
      roundState.decisionSource === null ||
      roundState.decidedAt === null
    ) {
      throw new Error("审核轮次结束时缺少完整决定记录。");
    }
    await executor.execute(sql`
      UPDATE review_rounds
      SET status = ${roundStatus}::review_round_status,
          decided_by_user_id = ${actorId},
          decision_reason = ${roundState.decisionReason},
          counted_opinion_ids = ${JSON.stringify(roundState.countedOpinionIds)}::jsonb,
          used_opinion_ids = ${JSON.stringify(roundState.usedOpinionIds)}::jsonb,
          used_review_item_ids = ${JSON.stringify(roundState.usedReviewItemIds)}::jsonb,
          decision_source = ${roundState.decisionSource},
          decided_at = ${roundState.decidedAt}::timestamptz
      WHERE problem_id = ${problemId}
        AND round = ${Number(current.current_review_round)}
        AND status = 'open'
    `);
    await executor.execute(sql`
      UPDATE review_assignments
      SET closed_at = ${roundState.decidedAt}::timestamptz,
          closure_reason = 'round_closed',
          closed_by_user_id = ${actorId},
          revoked_at = ${roundState.decidedAt}::timestamptz,
          revoked_by_user_id = ${actorId}
      WHERE round_id = (
        SELECT id
        FROM review_rounds
        WHERE problem_id = ${problemId}
          AND round = ${Number(current.current_review_round)}
      )
        AND assignment_kind = 'robot'
        AND closure_reason IS NULL
    `);
    if (roundState.decisionRequestId !== undefined) {
      await executor.execute(sql`
        INSERT INTO audit_events (
          actor_user_id, request_id, action, object_type, object_id, result, metadata
        ) VALUES (
          ${actorId},
          ${roundState.decisionRequestId}::uuid,
          'problem.review.decide',
          'problem',
          ${problem.id},
          'success',
          ${JSON.stringify({
            round: roundState.round,
            status: roundState.status,
            decisionSource: roundState.decisionSource,
            ruleId: roundState.ruleId,
            ruleVersion: roundState.pluginVersion
          })}::jsonb
        )
      `);
    }
  }

  return true;
}

async function loadReviews(
  executor: DatabaseExecutor,
  problemId: bigint,
  round?: number,
): Promise<StoredReview[]> {
  const roundFilter = round === undefined ? sql`` : sql`AND review_round.round = ${round}`;
  const rows = await executor.query<ReviewRow>(sql`
    SELECT
      opinion.id::text AS id,
      review_round.problem_id::text AS problem_id,
      review_round.round AS expected_round,
      opinion.reviewer_user_id::text AS reviewer_id,
      reviewer.nickname AS reviewer_nickname,
      reviewer.account_type AS reviewer_account_type,
      opinion.source,
      opinion.verdict,
      opinion.codeforces_difficulty,
      opinion.quality_level,
      opinion.originality_level,
      opinion.thinking_level,
      opinion.coding_level,
      opinion.improvements,
      opinion.public_comment,
      opinion.private_note,
      opinion.created_at,
      opinion.updated_at
    FROM review_opinions opinion
    JOIN review_rounds review_round ON review_round.id = opinion.round_id
    JOIN users reviewer ON reviewer.id = opinion.reviewer_user_id
    WHERE review_round.problem_id = ${problemId}
      AND opinion.is_active = true
      AND reviewer.account_type IN ('human', 'robot')
      ${roundFilter}
    ORDER BY opinion.created_at, opinion.id
  `);
  if (rows.length === 0) {
    return [];
  }

  const opinionIds = rows.map((row) => row.id);
  const tagRows = await executor.query<{ opinion_id: string; tag_id: string }>(sql`
    SELECT opinion_id::text AS opinion_id, tag_id
    FROM review_opinion_tags
    WHERE opinion_id IN (${sqlList(opinionIds, "uuid")})
    ORDER BY tag_id
  `);
  const tagsByOpinion = new Map<string, string[]>();
  for (const row of tagRows) {
    const tagIds = tagsByOpinion.get(row.opinion_id) ?? [];
    tagIds.push(row.tag_id);
    tagsByOpinion.set(row.opinion_id, tagIds);
  }

  return rows.map((row) => ({
    id: row.id,
    problemId: row.problem_id,
    reviewerId: row.reviewer_id,
    reviewer: {
      id: row.reviewer_id,
      nickname: row.reviewer_nickname,
      accountType: row.reviewer_account_type,
    },
    source: row.source,
    verdict: row.verdict,
    codeforcesDifficulty: Number(row.codeforces_difficulty),
    qualityLevel: Number(row.quality_level),
    originalityLevel: toNullableNumber(row.originality_level),
    thinkingLevel: Number(row.thinking_level),
    codingLevel: Number(row.coding_level),
    tagIds: tagsByOpinion.get(row.id) ?? [],
    improvements: row.improvements,
    publicComment: row.public_comment,
    privateNote: row.private_note,
    expectedRound: Number(row.expected_round),
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
  }));
}

async function writeReview(
  executor: DatabaseExecutor,
  expectedProblemId: bigint,
  review: StoredReview,
): Promise<void> {
  const reviewProblemId = requireDatabaseId(review.problemId, "审核意见中的题目编号");
  if (reviewProblemId !== expectedProblemId) {
    throw new Error("审核意见与当前题目不匹配。");
  }
  const reviewerId = requireDatabaseId(review.reviewerId, "审题人编号");
  const roundRows = await executor.query<{ id: string }>(sql`
    SELECT id::text AS id
    FROM review_rounds
    WHERE problem_id = ${expectedProblemId} AND round = ${review.expectedRound}
  `);
  const roundId = roundRows[0]?.id;
  if (roundId === undefined) {
    throw new Error("审核轮次不存在。");
  }

  const written = await executor.query<{ id: string }>(sql`
    INSERT INTO review_opinions (
      id,
      round_id,
      reviewer_user_id,
      source,
      verdict,
      codeforces_difficulty,
      quality_level,
      originality_level,
      thinking_level,
      coding_level,
      improvements,
      public_comment,
      private_note,
      created_at,
      updated_at
    ) VALUES (
      ${review.id}::uuid,
      ${roundId}::uuid,
      ${reviewerId},
      ${review.source}::review_source,
      ${review.verdict}::review_verdict,
      ${review.codeforcesDifficulty},
      ${review.qualityLevel},
      ${review.originalityLevel},
      ${review.thinkingLevel},
      ${review.codingLevel},
      ${review.improvements},
      ${review.publicComment},
      ${review.privateNote},
      ${review.createdAt}::timestamptz,
      ${review.updatedAt}::timestamptz
    )
    ON CONFLICT (id) DO UPDATE
    SET source = EXCLUDED.source,
        verdict = EXCLUDED.verdict,
        codeforces_difficulty = EXCLUDED.codeforces_difficulty,
        quality_level = EXCLUDED.quality_level,
        originality_level = EXCLUDED.originality_level,
        thinking_level = EXCLUDED.thinking_level,
        coding_level = EXCLUDED.coding_level,
        improvements = EXCLUDED.improvements,
        public_comment = EXCLUDED.public_comment,
        private_note = EXCLUDED.private_note,
        updated_at = EXCLUDED.updated_at
    WHERE review_opinions.round_id = EXCLUDED.round_id
      AND review_opinions.reviewer_user_id = EXCLUDED.reviewer_user_id
      AND review_opinions.is_active = true
    RETURNING id::text AS id
  `);
  if (written.length !== 1) {
    throw new Error("审核意见只能由原提交者在原审核轮次内更新。");
  }
  await executor.execute(sql`
    DELETE FROM review_opinion_tags WHERE opinion_id = ${review.id}::uuid
  `);
  for (const tagId of review.tagIds) {
    await executor.execute(sql`
      INSERT INTO review_opinion_tags (opinion_id, tag_id)
      VALUES (${review.id}::uuid, ${tagId})
    `);
  }
}

export class DatabaseDataStore implements DataStore {
  public constructor(private readonly handle: DatabaseHandle) {}

  public async getUser(userId: string): Promise<StoredUser | undefined> {
    const id = parseDatabaseId(userId);
    if (id === undefined) {
      return undefined;
    }
    return (await loadUsers(this.handle, [id]))[0];
  }

  public async listUsers(): Promise<StoredUser[]> {
    return loadUsers(this.handle);
  }

  public async findEmailCredential(normalizedEmail: string): Promise<EmailCredential | undefined> {
    const rows = await this.handle.query<{ user_id: string; password_hash: string | null }>(sql`
      SELECT email.user_id::text AS user_id, user_record.password_hash
      FROM user_emails email
      JOIN users user_record ON user_record.id = email.user_id
      WHERE email.normalized_address = ${normalizedEmail}
        AND email.verified_at IS NOT NULL
        AND user_record.disabled_at IS NULL
      LIMIT 1
    `);
    const row = rows[0];
    if (row === undefined || row.password_hash === null) {
      return undefined;
    }
    const user = await this.getUser(row.user_id);
    return user === undefined ? undefined : { user, passwordHash: row.password_hash };
  }

  public async registerEmailUser(input: EmailRegistration): Promise<StoredUser | undefined> {
    try {
      return await this.handle.transaction(async (transaction) => {
        const inserted = await transaction.query<{ id: string }>(sql`
          INSERT INTO users (nickname, account_type, password_hash)
          VALUES (${input.nickname}, 'human', ${input.passwordHash})
          RETURNING id::text AS id
        `);
        const userId = inserted[0]?.id;
        if (userId === undefined) {
          throw new Error("创建邮箱账号时未获得用户编号。");
        }
        const databaseUserId = requireDatabaseId(userId, "用户编号");
        await transaction.execute(sql`
          INSERT INTO user_emails (
            id, user_id, address, normalized_address, is_primary, verified_at
          ) VALUES (
            ${randomUUID()}::uuid,
            ${databaseUserId},
            ${input.displayEmail},
            ${input.normalizedEmail},
            true,
            NULL
          )
        `);
        const contributor = await transaction.query<{ id: string }>(sql`
          SELECT id::text AS id FROM roles WHERE key = 'contributor' LIMIT 1
        `);
        const roleId = contributor[0]?.id;
        if (roleId === undefined) {
          throw new Error("投稿人角色尚未初始化。");
        }
        await transaction.execute(sql`
          INSERT INTO role_memberships (id, user_id, role_id, granted_by_user_id, reason)
          VALUES (
            ${randomUUID()}::uuid,
            ${databaseUserId},
            ${roleId}::uuid,
            0,
            '邮箱注册'
          )
        `);
        return (await loadUsers(transaction, [databaseUserId]))[0];
      });
    } catch (error) {
      if (isUniqueViolation(error)) {
        return undefined;
      }
      throw error;
    }
  }

  public async findPendingEmailVerification(
    normalizedEmail: string
  ): Promise<EmailVerificationTarget | undefined> {
    const rows = await this.handle.query<{ user_id: string; normalized_address: string }>(sql`
      SELECT user_id::text AS user_id, normalized_address
      FROM user_emails
      WHERE normalized_address = ${normalizedEmail}
        AND verified_at IS NULL
      LIMIT 1
    `);
    const row = rows[0];
    return row === undefined
      ? undefined
      : { userId: row.user_id, normalizedEmail: row.normalized_address };
  }

  public async replaceEmailVerificationToken(input: EmailVerificationToken): Promise<void> {
    const userId = requireDatabaseId(input.userId, "用户编号");
    await this.handle.transaction(async (transaction) => {
      await transaction.execute(sql`
        UPDATE email_verification_tokens
        SET consumed_at = COALESCE(consumed_at, now())
        WHERE user_id = ${userId}
          AND normalized_address = ${input.normalizedEmail}
          AND consumed_at IS NULL
      `);
      await transaction.execute(sql`
        INSERT INTO email_verification_tokens (
          token_digest, user_id, normalized_address, expires_at
        ) VALUES (
          ${input.tokenDigest},
          ${userId},
          ${input.normalizedEmail},
          ${input.expiresAt}::timestamptz
        )
      `);
    });
  }

  public async consumeEmailVerificationToken(tokenDigest: string, now: string): Promise<string | undefined> {
    const rows = await this.handle.query<{ user_id: string }>(sql`
      WITH consumed AS (
        UPDATE email_verification_tokens
        SET consumed_at = ${now}::timestamptz
        WHERE token_digest = ${tokenDigest}
          AND consumed_at IS NULL
          AND expires_at > ${now}::timestamptz
        RETURNING user_id, normalized_address
      ), verified AS (
        UPDATE user_emails email
        SET verified_at = COALESCE(email.verified_at, ${now}::timestamptz),
            updated_at = ${now}::timestamptz
        FROM consumed
        WHERE email.user_id = consumed.user_id
          AND email.normalized_address = consumed.normalized_address
        RETURNING email.user_id
      )
      UPDATE users user_record
      SET auth_revision = auth_revision + 1,
          updated_at = ${now}::timestamptz
      FROM verified
      WHERE user_record.id = verified.user_id
      RETURNING user_record.id::text AS user_id
    `);
    return rows[0]?.user_id;
  }

  public async findOrCreateExternalUser(input: ExternalIdentity): Promise<StoredUser> {
    return this.handle.transaction(async (transaction) => {
      const existing = await transaction.query<{ user_id: string }>(sql`
        SELECT user_id::text AS user_id
        FROM external_identities
        WHERE provider = ${input.provider} AND subject = ${input.subject}
        LIMIT 1
      `);
      const existingId = existing[0]?.user_id;
      if (existingId !== undefined) {
        const existingUserId = requireDatabaseId(existingId, "用户编号");
        await transaction.execute(sql`
          UPDATE external_identities
          SET last_authenticated_at = now(), updated_at = now()
          WHERE provider = ${input.provider} AND subject = ${input.subject}
        `);
        await upsertStudentIdentifiers(transaction, existingUserId, input.studentIds);
        const user = (await loadUsers(transaction, [existingUserId]))[0];
        if (user === undefined) {
          throw new Error("统一身份认证绑定的账号不存在。");
        }
        return user;
      }

      const inserted = await transaction.query<{ id: string }>(sql`
        INSERT INTO users (nickname, account_type)
        VALUES (${input.nickname}, 'human')
        RETURNING id::text AS id
      `);
      const userId = inserted[0]?.id;
      if (userId === undefined) {
        throw new Error("创建统一身份认证账号时未获得用户编号。");
      }
      const databaseUserId = requireDatabaseId(userId, "用户编号");
      await transaction.execute(sql`
        INSERT INTO external_identities (
          id, user_id, provider, subject, profile, last_authenticated_at
        ) VALUES (
          ${randomUUID()}::uuid,
          ${databaseUserId},
          ${input.provider},
          ${input.subject},
          ${JSON.stringify({})}::jsonb,
          now()
        )
      `);
      await upsertStudentIdentifiers(transaction, databaseUserId, input.studentIds);
      if (input.email !== undefined) {
        await transaction.execute(sql`
          INSERT INTO user_emails (
            id, user_id, address, normalized_address, is_primary, verified_at
          ) VALUES (
            ${randomUUID()}::uuid,
            ${databaseUserId},
            ${input.email},
            ${input.email},
            true,
            now()
          )
          ON CONFLICT (normalized_address) DO NOTHING
        `);
      }
      const contributor = await transaction.query<{ id: string }>(sql`
        SELECT id::text AS id FROM roles WHERE key = 'contributor' LIMIT 1
      `);
      const roleId = contributor[0]?.id;
      if (roleId === undefined) {
        throw new Error("投稿人角色尚未初始化。");
      }
      await transaction.execute(sql`
        INSERT INTO role_memberships (id, user_id, role_id, granted_by_user_id, reason)
        VALUES (${randomUUID()}::uuid, ${databaseUserId}, ${roleId}::uuid, 0, '统一身份认证首次登录')
      `);
      const user = (await loadUsers(transaction, [databaseUserId]))[0];
      if (user === undefined) {
        throw new Error("统一身份认证账号创建后无法读取。");
      }
      return user;
    });
  }

  public async putLoginState(nonceDigest: string, expiresAt: string): Promise<void> {
    await this.handle.execute(sql`
      INSERT INTO login_states (nonce_digest, expires_at)
      VALUES (${nonceDigest}, ${expiresAt}::timestamptz)
      ON CONFLICT (nonce_digest) DO UPDATE
      SET expires_at = EXCLUDED.expires_at, consumed_at = NULL
    `);
  }

  public async consumeLoginState(nonceDigest: string, now: string): Promise<boolean> {
    const rows = await this.handle.query<{ nonce_digest: string }>(sql`
      UPDATE login_states
      SET consumed_at = ${now}::timestamptz
      WHERE nonce_digest = ${nonceDigest}
        AND consumed_at IS NULL
        AND expires_at > ${now}::timestamptz
      RETURNING nonce_digest
    `);
    return rows.length === 1;
  }

  public async revokeUserSessions(userId: string): Promise<void> {
    const databaseUserId = requireDatabaseId(userId, "用户编号");
    await this.handle.transaction(async (transaction) => {
      await transaction.execute(sql`
        UPDATE users
        SET auth_revision = auth_revision + 1, updated_at = now()
        WHERE id = ${databaseUserId}
      `);
      await transaction.execute(sql`
        UPDATE sessions
        SET revoked_at = COALESCE(revoked_at, now())
        WHERE user_id = ${databaseUserId}
      `);
    });
  }

  public async createSession(userId: string, expiresAt: string): Promise<StoredSession> {
    const databaseUserId = requireDatabaseId(userId, "用户编号");
    const authRows = await this.handle.query<{ auth_revision: number }>(sql`
      SELECT auth_revision
      FROM users
      WHERE id = ${databaseUserId} AND disabled_at IS NULL
    `);
    const authRevision = authRows[0]?.auth_revision;
    if (authRevision === undefined) {
      throw new Error("无法为不存在或已停用的用户创建会话。");
    }

    const token = randomBytes(32).toString("base64url");
    await this.handle.execute(sql`
      INSERT INTO sessions (id, token_digest, user_id, auth_revision, expires_at)
      VALUES (
        ${randomUUID()}::uuid,
        ${sessionDigest(token)},
        ${databaseUserId},
        ${Number(authRevision)},
        ${expiresAt}::timestamptz
      )
    `);
    return { id: token, userId, expiresAt };
  }

  public async getSession(sessionId: string): Promise<StoredSession | undefined> {
    const rows = await this.handle.query<{
      user_id: string;
      expires_at: Date | string;
    }>(sql`
      SELECT session_record.user_id::text AS user_id, session_record.expires_at
      FROM sessions session_record
      JOIN users user_record ON user_record.id = session_record.user_id
      WHERE session_record.token_digest = ${sessionDigest(sessionId)}
        AND session_record.revoked_at IS NULL
        AND session_record.expires_at > now()
        AND session_record.auth_revision = user_record.auth_revision
        AND user_record.disabled_at IS NULL
    `);
    const row = rows[0];
    if (row === undefined) {
      return undefined;
    }
    return { id: sessionId, userId: row.user_id, expiresAt: toIso(row.expires_at) };
  }

  public async deleteSession(sessionId: string): Promise<void> {
    await this.handle.execute(sql`
      UPDATE sessions
      SET revoked_at = COALESCE(revoked_at, now())
      WHERE token_digest = ${sessionDigest(sessionId)}
    `);
  }

  public async listTags(): Promise<ProblemTag[]> {
    const rows = await this.handle.query<{
      id: string;
      name: string;
      category_id: string;
      category_name: string;
      is_active: boolean;
    }>(sql`
      SELECT
        leaf.id,
        leaf.name,
        category.id AS category_id,
        category.name AS category_name,
        leaf.is_active
      FROM tags leaf
      JOIN tags category
        ON category.id = leaf.parent_id
       AND category.item_kind = 'category'
      WHERE leaf.item_kind = 'tag'
      ORDER BY category.sort_order, category.id, leaf.sort_order, leaf.name, leaf.id
    `);
    return rows.map((row) => ({
      id: row.id,
      name: row.name,
      group: row.category_name,
      itemKind: "tag",
      active: row.is_active,
      category: { id: row.category_id, name: row.category_name }
    }));
  }

  public async hasTags(tagIds: string[]): Promise<boolean> {
    return hasActiveTags(this.handle, tagIds);
  }

  public async createProblem(problem: StoredProblem): Promise<StoredProblem> {
    return this.createProblemInTransaction(problem);
  }

  /**
   * 与 replaceProblemWithRevisionAction 对称：在创建题目的同一个数据库事务里，
   * 于首个修订写入后调用回调。回调失败时题目、修订和回调里的全部写入一起撤销。
   */
  public async createProblemWithRevisionAction(
    problem: StoredProblem,
    action: ProblemRevisionAction,
  ): Promise<StoredProblem> {
    return this.createProblemInTransaction(problem, action);
  }

  private async createProblemInTransaction(
    problem: StoredProblem,
    revisionAction?: ProblemRevisionAction,
  ): Promise<StoredProblem> {
    const ownerId = requireDatabaseId(problem.ownerId, "题目作者编号");
    return this.handle.transaction(async (transaction) => {
      await lockTagCatalogReferenceWindow(transaction);
      const inserted = await transaction.query<{ id: string }>(sql`
        INSERT INTO problems (
          owner_id,
          status,
          current_revision,
          current_review_round,
          created_at,
          updated_at
        ) VALUES (
          ${ownerId},
          ${problem.status}::problem_status,
          ${problem.revision},
          ${problem.reviewRound},
          ${problem.createdAt}::timestamptz,
          ${problem.updatedAt}::timestamptz
        )
        RETURNING id::text AS id
      `);
      const id = inserted[0]?.id;
      if (id === undefined) {
        throw new Error("数据库没有返回新题目的编号。");
      }
      const databaseId = requireDatabaseId(id, "新题目编号");
      const stored = { ...copy(problem), id };
      const revisionId = await insertProblemRevision(
        transaction,
        stored,
        databaseId,
        ownerId,
        "创建题目",
      );
      await revisionAction?.(revisionId, transaction);
      if (stored.reviewRound > 0) {
        if (stored.status !== "pending_review") {
          throw new Error("新建带审核轮次的题目必须处于待审核状态。");
        }
        await insertReviewRound(transaction, stored, databaseId, revisionId, ownerId);
      }
      return stored;
    });
  }

  public async findVisibleProblem(
    problemId: string,
    visibility: ProblemVisibility,
  ): Promise<StoredProblem | undefined> {
    const id = parseDatabaseId(problemId);
    const visibilitySql = visibilityCondition(visibility);
    if (id === undefined || visibilitySql === undefined) {
      return undefined;
    }
    const rows = await loadProblemRows(this.handle, sql`problem.id = ${id} AND (${visibilitySql})`);
    return (await hydrateProblems(this.handle, rows))[0];
  }

  public async listVisibleProblems(
    filters: ProblemListFilters,
    visibility: ProblemVisibility,
  ): Promise<VisibleProblemPage> {
    const visibilitySql = visibilityCondition(visibility);
    const viewerId = parseDatabaseId(visibility.viewerId);
    if (visibilitySql === undefined || viewerId === undefined) {
      return { items: [], total: 0 };
    }

    const conditions: SQL[] = [visibilitySql];
    if (filters.owner === "me") {
      conditions.push(sql`problem.owner_id = ${viewerId}`);
    }
    if (filters.status !== undefined) {
      conditions.push(sql`problem.status = ${filters.status}::problem_status`);
    }
    if (filters.type !== undefined) {
      conditions.push(sql`revision.type = ${filters.type}::problem_type`);
    }
    if (filters.search.length > 0) {
      conditions.push(sql`strpos(lower(revision.title), lower(${filters.search})) > 0`);
    }
    const where = sql.join(conditions, sql` AND `);
    const countRows = await this.handle.query<{ count: number | string }>(sql`
      SELECT count(*)::integer AS count
      FROM problems problem
      JOIN problem_revisions revision
        ON revision.problem_id = problem.id
        AND revision.revision = problem.current_revision
      WHERE problem.deleted_at IS NULL AND (${where})
    `);

    const order =
      filters.sort === "updated_desc"
        ? sql`problem.updated_at DESC, problem.id DESC`
        : filters.sort === "updated_asc"
          ? sql`problem.updated_at ASC, problem.id ASC`
          : filters.sort === "difficulty_asc"
            ? sql`revision.codeforces_difficulty ASC NULLS LAST, problem.id ASC`
            : sql`revision.codeforces_difficulty DESC NULLS LAST, problem.id ASC`;
    const offset = (filters.page - 1) * filters.pageSize;
    const rows = await loadProblemRows(
      this.handle,
      where,
      sql`ORDER BY ${order} LIMIT ${filters.pageSize} OFFSET ${offset}`,
    );
    return {
      items: await hydrateProblems(this.handle, rows),
      total: Number(countRows[0]?.count ?? 0),
    };
  }

  public async replaceProblem(
    problem: StoredProblem,
    expectedRevision: number,
    changedByUserId?: string,
  ): Promise<boolean> {
    return this.handle.transaction((transaction) =>
      replaceProblemInTransaction(transaction, problem, expectedRevision, changedByUserId),
    );
  }

  public async replaceProblemWithRevisionAction(
    problem: StoredProblem,
    expectedRevision: number,
    changedByUserId: string | undefined,
    action: ProblemRevisionAction,
  ): Promise<boolean> {
    return this.handle.transaction((transaction) =>
      replaceProblemInTransaction(
        transaction,
        problem,
        expectedRevision,
        changedByUserId,
        action,
      ),
    );
  }

  public async listReviews(problemId: string, round: number): Promise<StoredReview[]> {
    const id = parseDatabaseId(problemId);
    return id === undefined ? [] : loadReviews(this.handle, id, round);
  }

  public async getReviewPolicy(): Promise<StoredReviewPolicy> {
    const rows = await this.handle.query<{
      rule_id: string;
      rule_version: string;
      rule_settings: unknown;
      revision: number;
      updated_by_user_id: string | null;
      updated_at: Date | string;
    }>(sql`
      SELECT
        rule_id,
        rule_version,
        rule_settings,
        revision,
        updated_by_user_id::text AS updated_by_user_id,
        updated_at
      FROM review_policy
      WHERE singleton = true
    `);
    const row = rows[0];
    if (row === undefined) {
      throw new Error("审核规则全局设置不存在。");
    }
    return {
      ruleId: row.rule_id,
      pluginVersion: row.rule_version,
      settings: parseJsonObject(row.rule_settings, "审核规则全局设置"),
      revision: Number(row.revision),
      updatedByUserId: row.updated_by_user_id,
      updatedAt: toIso(row.updated_at)
    };
  }

  public async replaceReviewPolicy(
    policy: StoredReviewPolicy,
    expectedRevision: number,
    actorUserId: string,
    requestId: string
  ): Promise<boolean> {
    const actorId = requireDatabaseId(actorUserId, "审核规则修改人编号");
    if (
      policy.revision !== expectedRevision + 1 ||
      policy.updatedByUserId !== actorUserId
    ) {
      return false;
    }
    return this.handle.transaction(async (transaction) => {
      const current = await transaction.query<{ revision: number }>(sql`
        SELECT revision FROM review_policy WHERE singleton = true FOR UPDATE
      `);
      if (Number(current[0]?.revision ?? 0) !== expectedRevision) {
        return false;
      }
      const updated = await transaction.query<{ revision: number }>(sql`
        UPDATE review_policy
        SET rule_id = ${policy.ruleId},
            rule_version = ${policy.pluginVersion},
            rule_settings = ${JSON.stringify(policy.settings)}::jsonb,
            revision = ${policy.revision},
            updated_by_user_id = ${actorId},
            updated_at = ${policy.updatedAt}::timestamptz
        WHERE singleton = true AND revision = ${expectedRevision}
        RETURNING revision
      `);
      if (updated.length !== 1) {
        return false;
      }
      await transaction.execute(sql`
        INSERT INTO audit_events (
          actor_user_id, request_id, action, object_type, object_id, result, metadata
        ) VALUES (
          ${actorId},
          ${requestId}::uuid,
          'review.policy.update',
          'review_policy',
          ${policy.ruleId},
          'success',
          ${JSON.stringify({
            ruleId: policy.ruleId,
            ruleVersion: policy.pluginVersion,
            revision: policy.revision
          })}::jsonb
        )
      `);
      return true;
    });
  }

  public async runProblemTransaction<T>(
    problemId: string,
    operation: (transaction: ProblemTransaction) => T | Promise<T>,
  ): Promise<T> {
    const id = parseDatabaseId(problemId);
    if (id === undefined) {
      return operation({
        getProblem: () => undefined,
        getTagCatalogVersion: () => 1,
        lockUserForAuthorization: async () => undefined,
        listUsers: () => [],
        listReviews: () => [],
        hasTags: async (tagIds) => tagIds.length === 0,
        upsertReview: () => {
          throw new Error("审核意见与当前题目不匹配。");
        },
        replaceProblem: () => false,
        writeReviewSuggestionAudit: async () => undefined,
      });
    }

    return this.handle.transaction(async (executor) => {
      const tagCatalogVersion = await lockTagCatalogReferenceWindow(executor);
      await executor.query<{ id: string }>(sql`
        SELECT id::text AS id
        FROM problems
        WHERE id = ${id} AND deleted_at IS NULL
        FOR UPDATE
      `);
      await executor.query<{ id: string }>(sql`
        SELECT review_round.id::text AS id
        FROM review_rounds review_round
        JOIN problems problem
          ON problem.id = review_round.problem_id
         AND problem.current_review_round = review_round.round
        WHERE problem.id = ${id}
        FOR UPDATE OF review_round
      `);
      let problem = (
        await hydrateProblems(executor, await loadProblemRows(executor, sql`problem.id = ${id}`))
      )[0];
      const users = await loadUsers(executor);
      const reviews = new Map(
        (await loadReviews(executor, id)).map((review) => [
          `${review.expectedRound}:${review.reviewerId}`,
          copy(review),
        ]),
      );
      const changedReviews = new Set<string>();
      const afterReviewWrites: Array<(executor: DatabaseExecutor) => Promise<void>> = [];
      let pendingReplacement:
        | { problem: StoredProblem; expectedRevision: number; changedByUserId?: string }
        | undefined;

      const transaction: ProblemTransaction = {
        executor,
        getProblem: () => (problem === undefined ? undefined : copy(problem)),
        getTagCatalogVersion: () => tagCatalogVersion,
        lockUserForAuthorization: async (userId) => {
          const userDatabaseId = parseDatabaseId(userId);
          if (userDatabaseId === undefined) {
            return undefined;
          }

          // Keep this order aligned with every permission writer: the problem
          // and current round are already locked, then the actor, memberships,
          // and grants are locked in stable primary-key order. Locking existing
          // rows does not protect writers that insert grants without first
          // taking the actor row, hence the explicit user-row-first protocol.
          const lockedUsers = await executor.query<{ id: string }>(sql`
            SELECT id::text AS id
            FROM users
            WHERE id = ${userDatabaseId}
            FOR UPDATE
          `);
          if (lockedUsers.length === 0) {
            return undefined;
          }
          await executor.query<{ id: string }>(sql`
            SELECT membership.id::text AS id
            FROM role_memberships membership
            WHERE membership.user_id = ${userDatabaseId}
            ORDER BY membership.id
            FOR UPDATE OF membership
          `);
          await executor.query<{ id: string }>(sql`
            SELECT grant_record.id::text AS id
            FROM permission_grants grant_record
            WHERE grant_record.subject_user_id = ${userDatabaseId}
               OR grant_record.subject_role_id IN (
                 SELECT membership.role_id
                 FROM role_memberships membership
                 WHERE membership.user_id = ${userDatabaseId}
               )
            ORDER BY grant_record.id
            FOR UPDATE OF grant_record
          `);
          return (await loadUsers(executor, [userDatabaseId]))[0];
        },
        listUsers: () => users.map(copy),
        listReviews: (round) =>
          [...reviews.values()]
            .filter((review) => review.expectedRound === round)
            .map(copy)
            .sort((left, right) => left.createdAt.localeCompare(right.createdAt)),
        hasTags: (tagIds) => hasActiveTags(executor, tagIds),
        upsertReview: (review) => {
          if (review.problemId !== problemId) {
            throw new Error("审核意见与当前题目不匹配。");
          }
          const key = `${review.expectedRound}:${review.reviewerId}`;
          reviews.set(key, copy(review));
          changedReviews.add(key);
        },
        replaceProblem: (next, expectedRevision, changedByUserId) => {
          if (
            problem === undefined ||
            next.id !== problemId ||
            problem.revision !== expectedRevision
          ) {
            return false;
          }
          problem = copy(next);
          pendingReplacement = {
            problem: copy(next),
            expectedRevision,
            ...(changedByUserId === undefined ? {} : { changedByUserId }),
          };
          return true;
        },
        writeReviewSuggestionAudit: async (event) => {
          if (event.problemId !== problemId) {
            throw new Error("审核建议审计与当前题目不匹配。");
          }
          const actorId = requireDatabaseId(event.actorUserId, "审核建议操作者编号");
          await executor.execute(sql`
            INSERT INTO audit_events (
              actor_user_id, request_id, action, object_type, object_id, result, metadata
            ) VALUES (
              ${actorId},
              ${event.requestId}::uuid,
              'problem.review.suggestions.apply',
              'problem',
              ${event.problemId},
              'success',
              ${JSON.stringify({
                round: event.round,
                previousRevision: event.previousRevision,
                nextRevision: event.nextRevision,
                fields: event.fields,
                opinionCount: event.opinionCount,
              })}::jsonb
            )
          `);
        },
        afterReviewWrites: (action) => {
          afterReviewWrites.push(action);
        },
      };

      const result = await operation(transaction);
      for (const key of changedReviews) {
        const review = reviews.get(key);
        if (review !== undefined) {
          await writeReview(executor, id, review);
        }
      }
      for (const action of afterReviewWrites) {
        await action(executor);
      }
      if (pendingReplacement !== undefined) {
        const replaced = await replaceProblemInTransaction(
          executor,
          pendingReplacement.problem,
          pendingReplacement.expectedRevision,
          pendingReplacement.changedByUserId,
        );
        if (!replaced) {
          throw new Error("题目修订号在事务中发生冲突。");
        }
      }
      return result;
    });
  }
}

function isUniqueViolation(error: unknown): boolean {
  if (typeof error !== "object" || error === null) {
    return false;
  }
  if ("code" in error && error.code === "23505") {
    return true;
  }
  return "cause" in error && isUniqueViolation(error.cause);
}
