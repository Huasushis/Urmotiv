import { createHash, randomUUID } from "node:crypto";
import {
  normalizeTagName,
  type ManagedTagCatalogResponse,
  type TagCatalogItem,
  type TagCatalogResponse,
  type TagDeactivationImpact,
  type TagDeactivationPreview,
} from "@urmotiv/contracts";
import type { DatabaseExecutor, DatabaseHandle } from "@urmotiv/database";
import { sql } from "drizzle-orm";
import {
  createTagCatalogProblemRevision,
  loadUsers,
} from "./database-store";
import { ApiError, conflict, forbidden, notFound } from "./errors";
import { hasPermission } from "./permissions";

const databaseIdPattern = /^(0|[1-9]\d*)$/u;
const catalogItemIdPattern = /^[a-z0-9]+(?:[._-][a-z0-9]+)*$/u;
const deactivationPreviewLifetimeMs = 10 * 60 * 1_000;

interface TagRow extends Record<string, unknown> {
  id: string;
  parent_id: string | null;
  name: string;
  normalized_name: string;
  item_kind: "category" | "tag";
  description: string;
  sort_order: number;
  is_active: boolean;
  parent_name: string | null;
  parent_active: boolean | null;
}

interface AliasRow extends Record<string, unknown> {
  id: string;
  tag_id: string;
  name: string;
  normalized_name: string;
}

interface AffectedProblemRow extends Record<string, unknown> {
  problem_id: string;
  current_revision: number;
  revision_id: string;
}

interface PreviewRow extends Record<string, unknown> {
  id: string;
  actor_user_id: string;
  target_tag_id: string;
  replacement_tag_id: string | null;
  catalog_version: number;
  current_problem_count: number;
  sole_current_tag_count: number;
  historical_revision_count: number;
  review_opinion_count: number;
  child_tag_count: number;
  impact_digest: string;
  expires_at: Date | string;
  used_at: Date | string | null;
}

interface ImpactSnapshot {
  readonly impact: TagDeactivationImpact;
  readonly affectedProblems: readonly {
    readonly problemId: string;
    readonly currentRevision: number;
    readonly revisionId: string;
    readonly tagIds: readonly string[];
  }[];
}

export interface CreateCatalogItemInput {
  readonly expectedVersion: number;
  readonly id: string;
  readonly itemKind: "category" | "tag";
  readonly parentId: string | null;
  readonly name: string;
  readonly description: string;
  readonly sortOrder: number;
}

export interface UpdateCatalogItemInput {
  readonly expectedVersion: number;
  readonly name?: string | undefined;
  readonly description?: string | undefined;
  readonly parentId?: string | null | undefined;
  readonly sortOrder?: number | undefined;
  readonly active?: boolean | undefined;
}

export interface CatalogMutationResult {
  readonly version: number;
}

function invalidInput(message: string): ApiError {
  return new ApiError(422, "INVALID_INPUT", message);
}

function toIso(value: Date | string): string {
  const parsed = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(parsed.getTime())) {
    throw new Error("知识点目录时间无效。");
  }
  return parsed.toISOString();
}

function databaseErrorCode(error: unknown): string | undefined {
  const visited = new Set<object>();
  let current = error;
  for (let depth = 0; depth < 8; depth += 1) {
    if (typeof current !== "object" || current === null || visited.has(current)) {
      return undefined;
    }
    visited.add(current);
    if ("code" in current && typeof current.code === "string") {
      return current.code;
    }
    current = "cause" in current ? current.cause : undefined;
  }
  return undefined;
}

function requireActorId(value: string): bigint {
  if (!databaseIdPattern.test(value)) {
    throw forbidden();
  }
  const parsed = BigInt(value);
  if (parsed > 9_223_372_036_854_775_807n) {
    throw forbidden();
  }
  return parsed;
}

function mapTag(row: TagRow, aliases: readonly string[]): TagCatalogItem {
  if (row.item_kind === "category") {
    return {
      id: row.id,
      name: row.name,
      description: row.description,
      sortOrder: Number(row.sort_order),
      active: row.is_active,
      itemKind: "category",
      parentId: null,
    };
  }
  if (row.parent_id === null || row.parent_name === null) {
    throw new Error("叶子知识点缺少分类。");
  }
  return {
    id: row.id,
    name: row.name,
    group: row.parent_name,
    itemKind: "tag",
    active: row.is_active,
    category: { id: row.parent_id, name: row.parent_name },
    description: row.description,
    aliases: [...aliases],
    normalizedName: row.normalized_name,
    parentId: row.parent_id,
    sortOrder: Number(row.sort_order),
  };
}

async function lockManagingActor(
  executor: DatabaseExecutor,
  actorUserId: string,
  evaluatedAt: Date,
): Promise<bigint> {
  const actorId = requireActorId(actorUserId);
  const locked = await executor.query<{ id: string }>(sql`
    SELECT id::text AS id
    FROM users
    WHERE id = ${actorId}
    FOR UPDATE
  `);
  if (locked.length !== 1) {
    throw forbidden();
  }
  // Keep this user-row-first order aligned with all permission writers.
  await executor.query<{ id: string }>(sql`
    SELECT membership.id::text AS id
    FROM role_memberships membership
    WHERE membership.user_id = ${actorId}
    ORDER BY membership.id
    FOR UPDATE OF membership
  `);
  await executor.query<{ id: string }>(sql`
    SELECT grant_record.id::text AS id
    FROM permission_grants grant_record
    WHERE grant_record.subject_user_id = ${actorId}
       OR grant_record.subject_role_id IN (
         SELECT membership.role_id
         FROM role_memberships membership
         WHERE membership.user_id = ${actorId}
       )
    ORDER BY grant_record.id
    FOR UPDATE OF grant_record
  `);
  const actor = (await loadUsers(executor, [actorId]))[0];
  if (
    actor === undefined
    || actor.accountType !== "human"
    || !hasPermission(actor, "tag.manage", {}, evaluatedAt)
  ) {
    throw forbidden();
  }
  return actorId;
}

/**
 * Reject obvious unauthorized traffic before it can queue on the global
 * catalogue write lock. This check is only a load-shedding guard: every
 * operation still locks and revalidates the actor after taking the catalogue
 * lock, so revocation and explicit deny races remain fail-closed.
 */
async function precheckManagingActor(
  executor: DatabaseExecutor,
  actorUserId: string,
  evaluatedAt: Date,
): Promise<void> {
  const actorId = requireActorId(actorUserId);
  const actor = (await loadUsers(executor, [actorId]))[0];
  if (
    actor === undefined
    || actor.accountType !== "human"
    || !hasPermission(actor, "tag.manage", {}, evaluatedAt)
  ) {
    throw forbidden();
  }
}

async function lockCatalogVersion(executor: DatabaseExecutor): Promise<number> {
  const rows = await executor.query<{ version: number }>(sql`
    SELECT version
    FROM tag_catalog_state
    WHERE singleton = true
    FOR UPDATE
  `);
  const version = Number(rows[0]?.version);
  if (!Number.isSafeInteger(version) || version < 1) {
    throw new Error("知识点目录版本缺失。");
  }
  return version;
}

function requireExpectedVersion(actual: number, expected: number): void {
  if (actual !== expected) {
    throw conflict("知识点目录已被其他操作修改，请刷新后重试。");
  }
}

async function bumpCatalogVersion(
  executor: DatabaseExecutor,
  beforeVersion: number,
  updatedAt: string,
): Promise<number> {
  const rows = await executor.query<{ version: number }>(sql`
    UPDATE tag_catalog_state
    SET version = version + 1,
        updated_at = ${updatedAt}::timestamptz
    WHERE singleton = true AND version = ${beforeVersion}
    RETURNING version
  `);
  const afterVersion = Number(rows[0]?.version);
  if (afterVersion !== beforeVersion + 1) {
    throw conflict("知识点目录已被其他操作修改，请刷新后重试。");
  }
  return afterVersion;
}

async function writeCatalogAudit(
  executor: DatabaseExecutor,
  input: {
    readonly actorId: bigint;
    readonly requestId: string;
    readonly action: string;
    readonly objectId: string;
    readonly metadata: Record<string, unknown>;
  },
): Promise<void> {
  await executor.execute(sql`
    INSERT INTO audit_events (
      actor_user_id, request_id, action, object_type, object_id, result, metadata
    ) VALUES (
      ${input.actorId},
      ${input.requestId}::uuid,
      ${input.action},
      'tag_catalog_item',
      ${input.objectId},
      'success',
      ${JSON.stringify(input.metadata)}::jsonb
    )
  `);
}

async function queryCatalog(
  executor: DatabaseExecutor,
  includeInactive: boolean,
  aliasesByTagId: ReadonlyMap<string, readonly string[]>,
): Promise<TagCatalogItem[]> {
  const rows = await executor.query<TagRow>(sql`
    SELECT
      item.id,
      item.parent_id,
      item.name,
      item.normalized_name,
      item.item_kind,
      item.description,
      item.sort_order,
      item.is_active,
      parent.name AS parent_name,
      parent.is_active AS parent_active
    FROM tags item
    LEFT JOIN tags parent ON parent.id = item.parent_id
    WHERE ${includeInactive
      ? sql`true`
      : sql`item.is_active = true AND (item.item_kind = 'category' OR parent.is_active = true)`}
    ORDER BY
      CASE WHEN item.item_kind = 'category' THEN item.sort_order ELSE parent.sort_order END,
      COALESCE(item.parent_id, item.id),
      CASE WHEN item.item_kind = 'category' THEN -2147483648 ELSE item.sort_order END,
      item.id
  `);
  return rows.map((row) => mapTag(row, aliasesByTagId.get(row.id) ?? []));
}

async function queryAliases(executor: DatabaseExecutor): Promise<ManagedTagCatalogResponse["aliases"]> {
  const rows = await executor.query<AliasRow>(sql`
    SELECT id::text AS id, tag_id, name, normalized_name
    FROM tag_aliases
    ORDER BY tag_id, created_at, id
  `);
  return rows.map((row) => ({
    id: row.id,
    tagId: row.tag_id,
    name: row.name,
    normalizedName: row.normalized_name,
  }));
}

function indexAliasNames(
  aliases: ManagedTagCatalogResponse["aliases"],
): ReadonlyMap<string, readonly string[]> {
  const aliasesByTagId = new Map<string, string[]>();
  for (const alias of aliases) {
    const names = aliasesByTagId.get(alias.tagId) ?? [];
    names.push(alias.name);
    aliasesByTagId.set(alias.tagId, names);
  }
  return aliasesByTagId;
}

async function loadTagForUpdate(
  executor: DatabaseExecutor,
  tagId: string,
): Promise<TagRow | undefined> {
  const rows = await executor.query<TagRow>(sql`
    SELECT
      item.id,
      item.parent_id,
      item.name,
      item.normalized_name,
      item.item_kind,
      item.description,
      item.sort_order,
      item.is_active,
      parent.name AS parent_name,
      parent.is_active AS parent_active
    FROM tags item
    LEFT JOIN tags parent ON parent.id = item.parent_id
    WHERE item.id = ${tagId}
    FOR UPDATE OF item
  `);
  return rows[0];
}

async function requireActiveLeaf(
  executor: DatabaseExecutor,
  tagId: string,
): Promise<TagRow> {
  const tag = await loadTagForUpdate(executor, tagId);
  if (tag === undefined || tag.item_kind !== "tag" || !tag.is_active) {
    throw invalidInput("替代知识点必须是当前启用的叶子标签。");
  }
  return tag;
}

async function assertUniqueSiblingName(
  executor: DatabaseExecutor,
  parentId: string | null,
  normalizedName: string,
  excludedId?: string,
): Promise<void> {
  const rows = await executor.query<{ id: string }>(sql`
    SELECT id
    FROM tags
    WHERE parent_id IS NOT DISTINCT FROM ${parentId}
      AND normalized_name = ${normalizedName}
      ${excludedId === undefined ? sql`` : sql`AND id <> ${excludedId}`}
    LIMIT 1
  `);
  if (rows.length !== 0) {
    throw conflict("同一分类下已经存在标准化名称相同的目录项。");
  }
}

async function assertCatalogNameDoesNotMatchAlias(
  executor: DatabaseExecutor,
  normalizedName: string,
): Promise<void> {
  const rows = await executor.query<{ id: string }>(sql`
    SELECT id::text AS id
    FROM tag_aliases
    WHERE normalized_name = ${normalizedName}
    LIMIT 1
  `);
  if (rows.length !== 0) {
    throw conflict("该标准化名称已经被知识点别名使用，会造成匹配歧义。");
  }
}

async function assertAliasDoesNotMatchCatalogName(
  executor: DatabaseExecutor,
  normalizedName: string,
): Promise<void> {
  const rows = await executor.query<{ id: string }>(sql`
    SELECT id
    FROM tags
    WHERE normalized_name = ${normalizedName}
    LIMIT 1
  `);
  if (rows.length !== 0) {
    throw conflict("该标准化别名已经是目录项名称，会造成匹配歧义。");
  }
}

async function loadImpactSnapshot(
  executor: DatabaseExecutor,
  targetTagId: string,
  lockCurrentProblems: boolean,
): Promise<ImpactSnapshot> {
  const affectedRows = await executor.query<AffectedProblemRow>(sql`
    SELECT
      problem.id::text AS problem_id,
      problem.current_revision,
      revision.id::text AS revision_id
    FROM problems problem
    JOIN problem_revisions revision
      ON revision.problem_id = problem.id
     AND revision.revision = problem.current_revision
    JOIN problem_revision_tags link
      ON link.revision_id = revision.id
     AND link.tag_id = ${targetTagId}
    ORDER BY problem.id
    ${lockCurrentProblems ? sql`FOR UPDATE OF problem, revision` : sql``}
  `);

  const revisionIds = affectedRows.map((row) => row.revision_id);
  const tagRows = revisionIds.length === 0
    ? []
    : await executor.query<{ revision_id: string; tag_id: string }>(sql`
        SELECT revision_id::text AS revision_id, tag_id
        FROM problem_revision_tags
        WHERE revision_id IN (${sql.join(
          revisionIds.map((revisionId) => sql`${revisionId}::uuid`),
          sql`, `,
        )})
        ORDER BY revision_id, tag_id
      `);
  const tagsByRevision = new Map<string, string[]>();
  for (const row of tagRows) {
    const tags = tagsByRevision.get(row.revision_id) ?? [];
    tags.push(row.tag_id);
    tagsByRevision.set(row.revision_id, tags);
  }
  const affectedProblems = affectedRows.map((row) => ({
    problemId: row.problem_id,
    currentRevision: Number(row.current_revision),
    revisionId: row.revision_id,
    tagIds: tagsByRevision.get(row.revision_id) ?? [],
  }));

  const historicalRows = await executor.query<{ count: number }>(sql`
    SELECT count(*)::integer AS count
    FROM problem_revision_tags link
    JOIN problem_revisions revision ON revision.id = link.revision_id
    WHERE link.tag_id = ${targetTagId}
      AND NOT EXISTS (
        SELECT 1
        FROM problems problem
        WHERE problem.id = revision.problem_id
          AND problem.current_revision = revision.revision
      )
  `);
  const opinionRows = await executor.query<{ count: number }>(sql`
    SELECT count(*)::integer AS count
    FROM review_opinion_tags
    WHERE tag_id = ${targetTagId}
  `);
  const childRows = await executor.query<{ count: number }>(sql`
    SELECT count(*)::integer AS count
    FROM tags
    WHERE parent_id = ${targetTagId}
  `);

  return {
    impact: {
      currentProblemCount: affectedProblems.length,
      soleCurrentTagCount: affectedProblems.filter((problem) => problem.tagIds.length === 1).length,
      historicalRevisionCount: Number(historicalRows[0]?.count ?? 0),
      reviewOpinionCount: Number(opinionRows[0]?.count ?? 0),
      childTagCount: Number(childRows[0]?.count ?? 0),
    },
    affectedProblems,
  };
}

function impactDigest(input: {
  readonly targetTagId: string;
  readonly replacementTagId?: string;
  readonly catalogVersion: number;
  readonly snapshot: ImpactSnapshot;
}): string {
  return createHash("sha256")
    .update(JSON.stringify({
      targetTagId: input.targetTagId,
      replacementTagId: input.replacementTagId ?? null,
      catalogVersion: input.catalogVersion,
      impact: input.snapshot.impact,
      affectedProblems: input.snapshot.affectedProblems,
    }), "utf8")
    .digest("hex");
}

function sameImpact(left: TagDeactivationImpact, row: PreviewRow): boolean {
  return left.currentProblemCount === Number(row.current_problem_count)
    && left.soleCurrentTagCount === Number(row.sole_current_tag_count)
    && left.historicalRevisionCount === Number(row.historical_revision_count)
    && left.reviewOpinionCount === Number(row.review_opinion_count)
    && left.childTagCount === Number(row.child_tag_count);
}

export class DatabaseTagCatalogService {
  public constructor(
    private readonly database: DatabaseHandle,
    private readonly now: () => Date = () => new Date(),
  ) {}

  private async transaction<T>(work: (executor: DatabaseExecutor) => Promise<T>): Promise<T> {
    try {
      return await this.database.transaction(work);
    } catch (error) {
      if (error instanceof ApiError) {
        throw error;
      }
      const code = databaseErrorCode(error);
      if (code === "40001" || code === "40P01" || code === "23505") {
        throw conflict("知识点目录已被其他操作修改，请刷新后重试。");
      }
      throw error;
    }
  }

  public async listPublicCatalog(): Promise<TagCatalogResponse> {
    return this.database.transaction(async (transaction) => {
      // The shared version lock makes the returned tree and version one
      // coherent snapshot without blocking other catalog readers.
      const versionRows = await transaction.query<{ version: number }>(sql`
        SELECT version
        FROM tag_catalog_state
        WHERE singleton = true
        FOR SHARE
      `);
      const version = Number(versionRows[0]?.version);
      if (!Number.isSafeInteger(version) || version < 1) {
        throw new Error("知识点目录版本缺失。");
      }
      const aliases = await queryAliases(transaction);
      return {
        version,
        // Inactive entries are safe global catalogue metadata and are needed
        // to render immutable historical references. Selection controls still
        // filter on `active` and the write path rejects inactive identifiers.
        items: await queryCatalog(transaction, true, indexAliasNames(aliases)),
      };
    });
  }

  public async listManagedCatalog(actorUserId: string): Promise<ManagedTagCatalogResponse> {
    return this.transaction(async (transaction) => {
      await precheckManagingActor(transaction, actorUserId, this.now());
      const version = await lockCatalogVersion(transaction);
      await lockManagingActor(transaction, actorUserId, this.now());
      const aliases = await queryAliases(transaction);
      return {
        version,
        items: await queryCatalog(transaction, true, indexAliasNames(aliases)),
        aliases,
      };
    });
  }

  public async createItem(
    actorUserId: string,
    requestId: string,
    input: CreateCatalogItemInput,
  ): Promise<CatalogMutationResult> {
    return this.transaction(async (transaction) => {
      const evaluatedAt = this.now();
      await precheckManagingActor(transaction, actorUserId, evaluatedAt);
      const beforeVersion = await lockCatalogVersion(transaction);
      const actorId = await lockManagingActor(transaction, actorUserId, evaluatedAt);
      requireExpectedVersion(beforeVersion, input.expectedVersion);
      if (!catalogItemIdPattern.test(input.id)) {
        throw invalidInput("知识点稳定编号格式不正确。");
      }
      if (input.itemKind === "category" && input.parentId !== null) {
        throw invalidInput("分类不能设置上级分类。");
      }
      if (input.itemKind === "tag" && input.parentId === null) {
        throw invalidInput("叶子知识点必须属于一个分类。");
      }
      if ((await loadTagForUpdate(transaction, input.id)) !== undefined) {
        throw conflict("该知识点稳定编号已经存在，不能重复使用。");
      }

      let groupName = input.name;
      if (input.itemKind === "tag") {
        const parent = await loadTagForUpdate(transaction, input.parentId!);
        if (parent === undefined || parent.item_kind !== "category" || !parent.is_active) {
          throw invalidInput("叶子知识点必须属于当前启用的分类。");
        }
        groupName = parent.name;
      }
      const normalizedName = normalizeTagName(input.name);
      await assertUniqueSiblingName(transaction, input.parentId, normalizedName);
      await assertCatalogNameDoesNotMatchAlias(transaction, normalizedName);
      await transaction.execute(sql`
        INSERT INTO tags (
          id, parent_id, name, normalized_name, item_kind, group_name,
          description, sort_order, is_active, created_by_user_id, updated_at
        ) VALUES (
          ${input.id},
          ${input.parentId},
          ${input.name},
          ${normalizedName},
          ${input.itemKind}::tag_item_kind,
          ${groupName},
          ${input.description},
          ${input.sortOrder},
          true,
          ${actorId},
          ${evaluatedAt.toISOString()}::timestamptz
        )
      `);
      const afterVersion = await bumpCatalogVersion(
        transaction,
        beforeVersion,
        evaluatedAt.toISOString(),
      );
      await writeCatalogAudit(transaction, {
        actorId,
        requestId,
        action: "tag.catalog.create",
        objectId: input.id,
        metadata: {
          beforeVersion,
          afterVersion,
          itemKind: input.itemKind,
          parentId: input.parentId,
        },
      });
      return { version: afterVersion };
    });
  }

  public async updateItem(
    actorUserId: string,
    requestId: string,
    tagId: string,
    input: UpdateCatalogItemInput,
  ): Promise<CatalogMutationResult> {
    return this.transaction(async (transaction) => {
      const evaluatedAt = this.now();
      await precheckManagingActor(transaction, actorUserId, evaluatedAt);
      const beforeVersion = await lockCatalogVersion(transaction);
      const actorId = await lockManagingActor(transaction, actorUserId, evaluatedAt);
      requireExpectedVersion(beforeVersion, input.expectedVersion);
      const current = await loadTagForUpdate(transaction, tagId);
      if (current === undefined) {
        throw notFound();
      }
      if (input.active === false) {
        throw invalidInput("停用知识点必须先预览影响并使用一次性确认标识。");
      }

      const name = input.name ?? current.name;
      const description = input.description ?? current.description;
      const parentId = input.parentId === undefined ? current.parent_id : input.parentId;
      const sortOrder = input.sortOrder ?? Number(current.sort_order);
      const active = input.active ?? current.is_active;
      if (current.item_kind === "category" && parentId !== null) {
        throw invalidInput("分类不能设置上级分类。");
      }
      if (current.item_kind === "tag" && parentId === null) {
        throw invalidInput("叶子知识点必须属于一个分类。");
      }

      let groupName = current.item_kind === "category" ? name : current.parent_name;
      if (current.item_kind === "tag") {
        const parent = await loadTagForUpdate(transaction, parentId!);
        if (parent === undefined || parent.item_kind !== "category" || !parent.is_active) {
          throw invalidInput("叶子知识点必须属于当前启用的分类。");
        }
        groupName = parent.name;
      }
      if (groupName === null) {
        throw new Error("叶子知识点缺少分类名称。");
      }
      const normalizedName = normalizeTagName(name);
      await assertUniqueSiblingName(transaction, parentId, normalizedName, tagId);
      if (normalizedName !== current.normalized_name) {
        await assertCatalogNameDoesNotMatchAlias(transaction, normalizedName);
      }

      const changedFields = [
        ...(name === current.name ? [] : ["name"]),
        ...(description === current.description ? [] : ["description"]),
        ...(parentId === current.parent_id ? [] : ["parentId"]),
        ...(sortOrder === Number(current.sort_order) ? [] : ["sortOrder"]),
        ...(active === current.is_active ? [] : ["active"]),
      ];
      if (changedFields.length === 0) {
        throw invalidInput("目录项没有发生变化。");
      }
      await transaction.execute(sql`
        UPDATE tags
        SET parent_id = ${parentId},
            name = ${name},
            normalized_name = ${normalizedName},
            group_name = ${groupName},
            description = ${description},
            sort_order = ${sortOrder},
            is_active = ${active},
            updated_at = ${evaluatedAt.toISOString()}::timestamptz
        WHERE id = ${tagId}
      `);
      if (current.item_kind === "category" && name !== current.name) {
        await transaction.execute(sql`
          UPDATE tags
          SET group_name = ${name},
              updated_at = ${evaluatedAt.toISOString()}::timestamptz
          WHERE parent_id = ${tagId}
        `);
      }
      const afterVersion = await bumpCatalogVersion(
        transaction,
        beforeVersion,
        evaluatedAt.toISOString(),
      );
      await writeCatalogAudit(transaction, {
        actorId,
        requestId,
        action: !current.is_active && active ? "tag.catalog.restore" : "tag.catalog.update",
        objectId: tagId,
        metadata: {
          beforeVersion,
          afterVersion,
          itemKind: current.item_kind,
          changedFields,
          ...(changedFields.includes("parentId") ? { parentId } : {}),
        },
      });
      return { version: afterVersion };
    });
  }

  public async createAlias(
    actorUserId: string,
    requestId: string,
    tagId: string,
    input: { readonly expectedVersion: number; readonly name: string },
  ): Promise<CatalogMutationResult & { readonly aliasId: string }> {
    return this.transaction(async (transaction) => {
      const evaluatedAt = this.now();
      await precheckManagingActor(transaction, actorUserId, evaluatedAt);
      const beforeVersion = await lockCatalogVersion(transaction);
      const actorId = await lockManagingActor(transaction, actorUserId, evaluatedAt);
      requireExpectedVersion(beforeVersion, input.expectedVersion);
      const target = await loadTagForUpdate(transaction, tagId);
      if (target === undefined) {
        throw notFound();
      }
      if (target.item_kind !== "tag") {
        throw invalidInput("别名只能关联叶子知识点。");
      }
      const normalizedName = normalizeTagName(input.name);
      await assertAliasDoesNotMatchCatalogName(transaction, normalizedName);
      const duplicate = await transaction.query<{ id: string }>(sql`
        SELECT id::text AS id
        FROM tag_aliases
        WHERE normalized_name = ${normalizedName}
        LIMIT 1
      `);
      if (duplicate.length !== 0) {
        throw conflict("该标准化别名已经存在。");
      }
      const aliasId = randomUUID();
      await transaction.execute(sql`
        INSERT INTO tag_aliases (
          id, tag_id, name, normalized_name, created_by_user_id, created_at
        ) VALUES (
          ${aliasId}::uuid,
          ${tagId},
          ${input.name},
          ${normalizedName},
          ${actorId},
          ${evaluatedAt.toISOString()}::timestamptz
        )
      `);
      const afterVersion = await bumpCatalogVersion(
        transaction,
        beforeVersion,
        evaluatedAt.toISOString(),
      );
      await writeCatalogAudit(transaction, {
        actorId,
        requestId,
        action: "tag.catalog.alias.create",
        objectId: tagId,
        metadata: { beforeVersion, afterVersion, aliasId },
      });
      return { version: afterVersion, aliasId };
    });
  }

  public async deleteAlias(
    actorUserId: string,
    requestId: string,
    tagId: string,
    aliasId: string,
    expectedVersion: number,
  ): Promise<CatalogMutationResult> {
    return this.transaction(async (transaction) => {
      const evaluatedAt = this.now();
      await precheckManagingActor(transaction, actorUserId, evaluatedAt);
      const beforeVersion = await lockCatalogVersion(transaction);
      const actorId = await lockManagingActor(transaction, actorUserId, evaluatedAt);
      requireExpectedVersion(beforeVersion, expectedVersion);
      const target = await loadTagForUpdate(transaction, tagId);
      if (target === undefined) {
        throw notFound();
      }
      const aliases = await transaction.query<{ id: string }>(sql`
        SELECT id::text AS id
        FROM tag_aliases
        WHERE id = ${aliasId}::uuid AND tag_id = ${tagId}
        FOR UPDATE
      `);
      if (aliases.length !== 1) {
        throw notFound();
      }
      await transaction.execute(sql`
        DELETE FROM tag_aliases WHERE id = ${aliasId}::uuid AND tag_id = ${tagId}
      `);
      const afterVersion = await bumpCatalogVersion(
        transaction,
        beforeVersion,
        evaluatedAt.toISOString(),
      );
      await writeCatalogAudit(transaction, {
        actorId,
        requestId,
        action: "tag.catalog.alias.delete",
        objectId: tagId,
        metadata: { beforeVersion, afterVersion, aliasId },
      });
      return { version: afterVersion };
    });
  }

  public async updateAlias(
    actorUserId: string,
    requestId: string,
    tagId: string,
    aliasId: string,
    input: { readonly expectedVersion: number; readonly name: string },
  ): Promise<CatalogMutationResult> {
    return this.transaction(async (transaction) => {
      const evaluatedAt = this.now();
      await precheckManagingActor(transaction, actorUserId, evaluatedAt);
      const beforeVersion = await lockCatalogVersion(transaction);
      const actorId = await lockManagingActor(transaction, actorUserId, evaluatedAt);
      requireExpectedVersion(beforeVersion, input.expectedVersion);
      const target = await loadTagForUpdate(transaction, tagId);
      if (target === undefined) {
        throw notFound();
      }
      if (target.item_kind !== "tag") {
        throw invalidInput("别名只能关联叶子知识点。");
      }
      const aliases = await transaction.query<{ name: string; normalized_name: string }>(sql`
        SELECT name, normalized_name
        FROM tag_aliases
        WHERE id = ${aliasId}::uuid AND tag_id = ${tagId}
        FOR UPDATE
      `);
      const current = aliases[0];
      if (current === undefined) {
        throw notFound();
      }
      const normalizedName = normalizeTagName(input.name);
      await assertAliasDoesNotMatchCatalogName(transaction, normalizedName);
      if (current.name === input.name && current.normalized_name === normalizedName) {
        throw invalidInput("别名没有发生变化。");
      }
      const duplicate = await transaction.query<{ id: string }>(sql`
        SELECT id::text AS id
        FROM tag_aliases
        WHERE normalized_name = ${normalizedName}
          AND id <> ${aliasId}::uuid
        LIMIT 1
      `);
      if (duplicate.length !== 0) {
        throw conflict("该标准化别名已经存在。");
      }
      await transaction.execute(sql`
        UPDATE tag_aliases
        SET name = ${input.name}, normalized_name = ${normalizedName}
        WHERE id = ${aliasId}::uuid AND tag_id = ${tagId}
      `);
      const afterVersion = await bumpCatalogVersion(
        transaction,
        beforeVersion,
        evaluatedAt.toISOString(),
      );
      await writeCatalogAudit(transaction, {
        actorId,
        requestId,
        action: "tag.catalog.alias.update",
        objectId: tagId,
        metadata: { beforeVersion, afterVersion, aliasId },
      });
      return { version: afterVersion };
    });
  }

  public async previewDeactivation(
    actorUserId: string,
    tagId: string,
    replacementTagId?: string,
  ): Promise<TagDeactivationPreview> {
    return this.transaction(async (transaction) => {
      const evaluatedAt = this.now();
      await precheckManagingActor(transaction, actorUserId, evaluatedAt);
      const catalogVersion = await lockCatalogVersion(transaction);
      const actorId = await lockManagingActor(transaction, actorUserId, evaluatedAt);
      const target = await loadTagForUpdate(transaction, tagId);
      if (target === undefined) {
        throw notFound();
      }
      if (!target.is_active) {
        throw conflict("该目录项已经停用，请刷新目录。");
      }
      if (replacementTagId === tagId) {
        throw invalidInput("替代知识点不能与待停用知识点相同。");
      }
      if (replacementTagId !== undefined) {
        if (target.item_kind !== "tag") {
          throw invalidInput("分类停用不能设置替代知识点。");
        }
        await requireActiveLeaf(transaction, replacementTagId);
      }

      const snapshot = await loadImpactSnapshot(transaction, tagId, false);
      const confirmationId = randomUUID();
      const createdAt = evaluatedAt.toISOString();
      const expiresAt = new Date(
        evaluatedAt.getTime() + deactivationPreviewLifetimeMs,
      ).toISOString();
      const digest = impactDigest({
        targetTagId: tagId,
        ...(replacementTagId === undefined ? {} : { replacementTagId }),
        catalogVersion,
        snapshot,
      });
      await transaction.execute(sql`
        INSERT INTO tag_deactivation_previews (
          id, actor_user_id, target_tag_id, replacement_tag_id, catalog_version,
          current_problem_count, sole_current_tag_count, historical_revision_count,
          review_opinion_count, child_tag_count, impact_digest, expires_at, created_at
        ) VALUES (
          ${confirmationId}::uuid,
          ${actorId},
          ${tagId},
          ${replacementTagId ?? null},
          ${catalogVersion},
          ${snapshot.impact.currentProblemCount},
          ${snapshot.impact.soleCurrentTagCount},
          ${snapshot.impact.historicalRevisionCount},
          ${snapshot.impact.reviewOpinionCount},
          ${snapshot.impact.childTagCount},
          ${digest},
          ${expiresAt}::timestamptz,
          ${createdAt}::timestamptz
        )
      `);
      return { confirmationId, catalogVersion, expiresAt, impact: snapshot.impact };
    });
  }

  public async confirmDeactivation(
    actorUserId: string,
    requestId: string,
    tagId: string,
    confirmationId: string,
    catalogVersion: number,
  ): Promise<CatalogMutationResult> {
    return this.transaction(async (transaction) => {
      const evaluatedAt = this.now();
      const evaluatedAtIso = evaluatedAt.toISOString();
      await precheckManagingActor(transaction, actorUserId, evaluatedAt);
      const beforeVersion = await lockCatalogVersion(transaction);
      const actorId = await lockManagingActor(transaction, actorUserId, evaluatedAt);
      requireExpectedVersion(beforeVersion, catalogVersion);
      const previews = await transaction.query<PreviewRow>(sql`
        SELECT
          id::text AS id,
          actor_user_id::text AS actor_user_id,
          target_tag_id,
          replacement_tag_id,
          catalog_version,
          current_problem_count,
          sole_current_tag_count,
          historical_revision_count,
          review_opinion_count,
          child_tag_count,
          impact_digest,
          expires_at,
          used_at
        FROM tag_deactivation_previews
        WHERE id = ${confirmationId}::uuid
        FOR UPDATE
      `);
      const preview = previews[0];
      if (
        preview === undefined
        || preview.actor_user_id !== actorUserId
        || preview.target_tag_id !== tagId
        || Number(preview.catalog_version) !== catalogVersion
        || preview.used_at !== null
        || Date.parse(toIso(preview.expires_at)) <= evaluatedAt.getTime()
      ) {
        throw conflict("停用确认已经失效，请重新预览影响。");
      }

      const target = await loadTagForUpdate(transaction, tagId);
      if (target === undefined || !target.is_active) {
        throw conflict("停用目标已经变化，请重新预览影响。");
      }
      const replacementTagId = preview.replacement_tag_id ?? undefined;
      if (replacementTagId !== undefined) {
        await requireActiveLeaf(transaction, replacementTagId);
      }
      const snapshot = await loadImpactSnapshot(transaction, tagId, true);
      const digest = impactDigest({
        targetTagId: tagId,
        ...(replacementTagId === undefined ? {} : { replacementTagId }),
        catalogVersion,
        snapshot,
      });
      if (digest !== preview.impact_digest || !sameImpact(snapshot.impact, preview)) {
        throw conflict("停用影响已经变化，请重新预览影响。");
      }
      if (target.item_kind === "category" && snapshot.impact.childTagCount > 0) {
        throw conflict("分类仍有子标签，不能停用。");
      }
      if (
        target.item_kind === "tag"
        && snapshot.impact.soleCurrentTagCount > 0
        && replacementTagId === undefined
      ) {
        throw conflict("有题目仅使用这一枚知识点，请选择替代知识点后重新预览。");
      }

      for (const problem of snapshot.affectedProblems) {
        const needsReplacement = problem.tagIds.length === 1;
        const created = await createTagCatalogProblemRevision(transaction, {
          problemId: problem.problemId,
          expectedRevision: problem.currentRevision,
          expectedRevisionId: problem.revisionId,
          targetTagId: tagId,
          ...(!needsReplacement || replacementTagId === undefined
            ? {}
            : { replacementTagId }),
          actorUserId,
          updatedAt: evaluatedAtIso,
        });
        if (!created) {
          throw conflict("停用影响已经变化，请重新预览影响。");
        }
      }

      const deactivated = await transaction.query<{ id: string }>(sql`
        UPDATE tags
        SET is_active = false,
            updated_at = ${evaluatedAtIso}::timestamptz
        WHERE id = ${tagId} AND is_active = true
        RETURNING id
      `);
      if (deactivated.length !== 1) {
        throw conflict("停用目标已经变化，请重新预览影响。");
      }
      await transaction.execute(sql`
        UPDATE tag_deactivation_previews
        SET used_at = ${evaluatedAtIso}::timestamptz
        WHERE id = ${confirmationId}::uuid AND used_at IS NULL
      `);
      const afterVersion = await bumpCatalogVersion(
        transaction,
        beforeVersion,
        evaluatedAtIso,
      );
      await writeCatalogAudit(transaction, {
        actorId,
        requestId,
        action: "tag.catalog.deactivate",
        objectId: tagId,
        metadata: {
          beforeVersion,
          afterVersion,
          currentProblemCount: snapshot.impact.currentProblemCount,
          soleCurrentTagCount: snapshot.impact.soleCurrentTagCount,
          historicalRevisionCount: snapshot.impact.historicalRevisionCount,
          reviewOpinionCount: snapshot.impact.reviewOpinionCount,
          childTagCount: snapshot.impact.childTagCount,
          usedReplacement:
            replacementTagId !== undefined && snapshot.impact.soleCurrentTagCount > 0,
          replacementTagId:
            replacementTagId !== undefined && snapshot.impact.soleCurrentTagCount > 0
              ? replacementTagId
              : null,
        },
      });
      return { version: afterVersion };
    });
  }
}
