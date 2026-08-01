import { randomUUID } from "node:crypto";
import type { DatabaseExecutor, DatabaseHandle } from "@urmotiv/database";
import { sql } from "drizzle-orm";
import { z } from "zod";

/**
 * 审核条目是挂在某一审核轮次上的结构化参考信息（例如原题相似度结果、AI 分析摘要）。
 * 它不是审核意见，不参与通过人数计算；审核规则只会读取自己声明支持的条目类型。
 */

export const reviewItemVisibilities = ["author", "reviewer", "administrator"] as const;
export type ReviewItemVisibility = (typeof reviewItemVisibilities)[number];

const storedReviewItemInputSchema = z
  .object({
    type: z
      .string()
      .min(1)
      .max(160)
      .regex(/^[a-z0-9]+(?:[._-][a-z0-9]+)*$/),
    /** 数据库中的来源枚举；插件条目写插件编号，人和机器人写用户编号。 */
    source: z.enum(["human", "anklang", "fermata", "plugin"]),
    sourceUserId: z.string().regex(/^(0|[1-9]\d*)$/).optional(),
    sourcePluginId: z.string().min(1).max(160).optional(),
    visibility: z.enum(reviewItemVisibilities),
    summary: z.string().trim().min(1).max(500),
    data: z.unknown(),
    contentHash: z.string().regex(/^[a-f0-9]{64}$/),
    expiresAt: z.string().datetime({ offset: true }).nullable().optional()
  })
  .strict()
  .superRefine((value, context) => {
    if (value.sourceUserId === undefined && value.sourcePluginId === undefined) {
      context.addIssue({
        code: "custom",
        path: ["sourceUserId"],
        message: "审核条目必须注明来源用户或来源插件。"
      });
    }
  });

export type StoredReviewItemInput = z.input<typeof storedReviewItemInputSchema>;

export interface StoredReviewItem {
  readonly id: string;
  readonly round: number;
  readonly type: string;
  readonly source: "human" | "anklang" | "fermata" | "plugin";
  readonly sourceUserId: string | null;
  readonly sourcePluginId: string | null;
  readonly visibility: ReviewItemVisibility;
  readonly summary: string;
  readonly data: unknown;
  readonly contentHash: string;
  readonly expiresAt: string | null;
  readonly createdAt: string;
}

export interface ReviewItemStore {
  /** 追加到指定题目的指定轮次；轮次必须已经存在。 */
  append(
    problemId: string,
    round: number,
    items: readonly StoredReviewItemInput[],
    executor?: DatabaseExecutor
  ): Promise<void>;
  /**
   * 在活动轮次中替换同一插件、类型和内容摘要的旧结果。手动重试使用这个入口，
   * 避免重复结果同时成为有效审核条目；关闭轮次固定拒绝。
   */
  replacePluginItems(
    problemId: string,
    round: number,
    items: readonly StoredReviewItemInput[],
    executor?: DatabaseExecutor
  ): Promise<void>;
  /** 只返回指定可见级别集合内、未过期的条目。 */
  list(
    problemId: string,
    round: number,
    visibleLevels: readonly ReviewItemVisibility[],
    executor?: DatabaseExecutor
  ): Promise<StoredReviewItem[]>;
  /** Core-only read used by a decision rule; visibility still controls later API display. */
  listForDecision(
    problemId: string,
    round: number,
    executor?: DatabaseExecutor
  ): Promise<StoredReviewItem[]>;
}

export class ReviewItemStoreError extends Error {
  public constructor(
    public readonly code: "ROUND_NOT_FOUND" | "WRITE_FAILED",
    message: string
  ) {
    super(message);
    this.name = "ReviewItemStoreError";
  }
}

interface ReviewItemRow extends Record<string, unknown> {
  id: string;
  round: number;
  type: string;
  source: string;
  source_user_id: string | null;
  source_plugin_id: string | null;
  visibility: string;
  summary: string;
  data: unknown;
  content_hash: string;
  expires_at: Date | string | null;
  created_at: Date | string;
}

export class DatabaseReviewItemStore implements ReviewItemStore {
  public constructor(
    private readonly database: DatabaseHandle,
    private readonly now: () => Date = () => new Date()
  ) {}

  public async append(
    problemId: string,
    round: number,
    items: readonly StoredReviewItemInput[],
    executor: DatabaseExecutor = this.database
  ): Promise<void> {
    if (items.length === 0) {
      return;
    }
    const problemDatabaseId = parseDatabaseId(problemId);
    if (problemDatabaseId === undefined || !Number.isInteger(round) || round < 1) {
      throw new ReviewItemStoreError("ROUND_NOT_FOUND", "审核轮次不存在。");
    }

    const roundRows = await executor.query<{ id: string }>(sql`
      SELECT id::text AS id
      FROM review_rounds
      WHERE problem_id = ${problemDatabaseId} AND round = ${round}
    `);
    const roundId = roundRows[0]?.id;
    if (roundId === undefined) {
      throw new ReviewItemStoreError("ROUND_NOT_FOUND", "审核轮次不存在。");
    }

    for (const rawItem of items) {
      const item = storedReviewItemInputSchema.parse(rawItem);
      await executor.execute(sql`
        INSERT INTO review_items (
          id, round_id, type, source, source_user_id, source_plugin_id,
          visibility, summary, data, content_hash, expires_at
        ) VALUES (
          ${randomUUID()}::uuid,
          ${roundId}::uuid,
          ${item.type},
          ${item.source}::review_source,
          ${item.sourceUserId === undefined ? null : BigInt(item.sourceUserId)},
          ${item.sourcePluginId ?? null},
          ${item.visibility}::review_item_visibility,
          ${item.summary},
          ${JSON.stringify(item.data ?? null)}::jsonb,
          ${item.contentHash},
          ${item.expiresAt ?? null}::timestamptz
        )
      `);
    }
  }

  public async replacePluginItems(
    problemId: string,
    round: number,
    items: readonly StoredReviewItemInput[],
    executor?: DatabaseExecutor
  ): Promise<void> {
    if (items.length === 0) {
      return;
    }
    const problemDatabaseId = parseDatabaseId(problemId);
    const parsedItems = items.map((item) => storedReviewItemInputSchema.parse(item));
    if (
      problemDatabaseId === undefined ||
      !Number.isInteger(round) ||
      round < 1 ||
      parsedItems.some((item) => item.sourcePluginId === undefined)
    ) {
      throw new ReviewItemStoreError("ROUND_NOT_FOUND", "活动审核轮次不存在。");
    }

    const replace = async (activeExecutor: DatabaseExecutor): Promise<void> => {
      const rows = await activeExecutor.query<{ id: string; status: string }>(sql`
        SELECT id::text AS id, status::text AS status
        FROM review_rounds
        WHERE problem_id = ${problemDatabaseId} AND round = ${round}
        FOR UPDATE
      `);
      const row = rows[0];
      if (row === undefined || row.status !== "open") {
        throw new ReviewItemStoreError("ROUND_NOT_FOUND", "活动审核轮次不存在。");
      }
      for (const item of parsedItems) {
        await activeExecutor.execute(sql`
          DELETE FROM review_items
          WHERE round_id = ${row.id}::uuid
            AND type = ${item.type}
            AND source_plugin_id = ${item.sourcePluginId ?? null}
            AND content_hash = ${item.contentHash}
        `);
      }
      await this.append(problemId, round, parsedItems, activeExecutor);
    };
    if (executor !== undefined) {
      await replace(executor);
      return;
    }
    await this.database.transaction(replace);
  }

  public async list(
    problemId: string,
    round: number,
    visibleLevels: readonly ReviewItemVisibility[],
    executor: DatabaseExecutor = this.database
  ): Promise<StoredReviewItem[]> {
    const problemDatabaseId = parseDatabaseId(problemId);
    const levels = [...new Set(visibleLevels)].filter((level) =>
      (reviewItemVisibilities as readonly string[]).includes(level)
    );
    if (problemDatabaseId === undefined || levels.length === 0 || round < 1) {
      return [];
    }

    const rows = await executor.query<ReviewItemRow>(sql`
      SELECT
        item.id::text AS id,
        round.round AS round,
        item.type,
        item.source::text AS source,
        item.source_user_id::text AS source_user_id,
        item.source_plugin_id,
        item.visibility::text AS visibility,
        item.summary,
        item.data,
        item.content_hash,
        item.expires_at,
        item.created_at
      FROM review_items item
      JOIN review_rounds round ON round.id = item.round_id
      WHERE round.problem_id = ${problemDatabaseId}
        AND round.round = ${round}
        AND item.visibility IN (${sql.join(
          levels.map((level) => sql`${level}::review_item_visibility`),
          sql`, `
        )})
        AND (item.expires_at IS NULL OR item.expires_at > ${this.now().toISOString()}::timestamptz)
      ORDER BY item.created_at ASC, item.id ASC
    `);
    return rows.map(toStoredReviewItem);
  }

  public async listForDecision(
    problemId: string,
    round: number,
    executor: DatabaseExecutor = this.database
  ): Promise<StoredReviewItem[]> {
    return this.list(problemId, round, reviewItemVisibilities, executor);
  }
}

/** 测试与轻量模式使用的内存实现，行为与数据库版一致但不校验轮次存在。 */
export class InMemoryReviewItemStore implements ReviewItemStore {
  readonly #items = new Map<string, StoredReviewItem[]>();
  readonly #now: () => Date;

  public constructor(now: () => Date = () => new Date()) {
    this.#now = now;
  }

  public async append(
    problemId: string,
    round: number,
    items: readonly StoredReviewItemInput[]
  ): Promise<void> {
    const key = `${problemId}:${round}`;
    const bucket = this.#items.get(key) ?? [];
    for (const rawItem of items) {
      const item = storedReviewItemInputSchema.parse(rawItem);
      bucket.push({
        id: randomUUID(),
        round,
        type: item.type,
        source: item.source,
        sourceUserId: item.sourceUserId ?? null,
        sourcePluginId: item.sourcePluginId ?? null,
        visibility: item.visibility,
        summary: item.summary,
        data: structuredClone(item.data ?? null),
        contentHash: item.contentHash,
        expiresAt: item.expiresAt ?? null,
        createdAt: this.#now().toISOString()
      });
    }
    this.#items.set(key, bucket);
  }

  public async replacePluginItems(
    problemId: string,
    round: number,
    items: readonly StoredReviewItemInput[],
    _executor?: DatabaseExecutor
  ): Promise<void> {
    const key = `${problemId}:${round}`;
    let bucket = this.#items.get(key) ?? [];
    for (const rawItem of items) {
      const item = storedReviewItemInputSchema.parse(rawItem);
      if (item.sourcePluginId === undefined) {
        throw new ReviewItemStoreError("WRITE_FAILED", "替换插件审核条目时缺少插件来源。");
      }
      bucket = bucket.filter(
        (existing) =>
          existing.type !== item.type ||
          existing.sourcePluginId !== item.sourcePluginId ||
          existing.contentHash !== item.contentHash
      );
      bucket.push({
        id: randomUUID(),
        round,
        type: item.type,
        source: item.source,
        sourceUserId: item.sourceUserId ?? null,
        sourcePluginId: item.sourcePluginId,
        visibility: item.visibility,
        summary: item.summary,
        data: structuredClone(item.data ?? null),
        contentHash: item.contentHash,
        expiresAt: item.expiresAt ?? null,
        createdAt: this.#now().toISOString()
      });
    }
    this.#items.set(key, bucket);
  }

  public async list(
    problemId: string,
    round: number,
    visibleLevels: readonly ReviewItemVisibility[]
  ): Promise<StoredReviewItem[]> {
    const levels = new Set(visibleLevels);
    return (this.#items.get(`${problemId}:${round}`) ?? [])
      .filter(
        (item) =>
          levels.has(item.visibility) &&
          (item.expiresAt === null || Date.parse(item.expiresAt) > this.#now().getTime())
      )
      .map((item) => ({ ...item, data: structuredClone(item.data) }));
  }

  public async listForDecision(
    problemId: string,
    round: number
  ): Promise<StoredReviewItem[]> {
    return this.list(problemId, round, reviewItemVisibilities);
  }
}

function toStoredReviewItem(row: ReviewItemRow): StoredReviewItem {
  const data = typeof row.data === "string" ? JSON.parse(row.data) : row.data;
  return {
    id: row.id,
    round: Number(row.round),
    type: row.type,
    source: row.source as StoredReviewItem["source"],
    sourceUserId: row.source_user_id,
    sourcePluginId: row.source_plugin_id,
    visibility: row.visibility as ReviewItemVisibility,
    summary: row.summary,
    data,
    contentHash: row.content_hash,
    expiresAt: row.expires_at === null
      ? null
      : (row.expires_at instanceof Date ? row.expires_at : new Date(row.expires_at)).toISOString(),
    createdAt: (row.created_at instanceof Date
      ? row.created_at
      : new Date(row.created_at)
    ).toISOString()
  };
}

function parseDatabaseId(value: string): bigint | undefined {
  return /^(0|[1-9]\d*)$/.test(value) ? BigInt(value) : undefined;
}
