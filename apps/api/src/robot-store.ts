import { createHash, randomUUID } from "node:crypto";
import type { DatabaseHandle } from "@urmotiv/database";
import { sql } from "drizzle-orm";

/**
 * 机器人审题链路的数据库操作：令牌认证、待审轮次候选、领取租约的创建/续租/结束。
 * 这里不做权限计算——调用方必须先加载机器人用户并按普通权限规则判断；
 * 错误信息不区分“令牌不存在”“已撤销”“已过期”，一律按认证失败处理。
 */

const databaseIdPattern = /^(0|[1-9]\d*)$/;

export interface RobotTokenIdentity {
  readonly userId: string;
  readonly tokenId: string;
}

export interface RobotRoundCandidate {
  readonly roundId: string;
  readonly problemId: string;
  readonly round: number;
}

export interface RobotAssignment {
  readonly id: string;
  readonly roundId: string;
  readonly problemId: string;
  readonly round: number;
  readonly reviewerUserId: string;
  readonly expiresAt: string;
}

export function digestRobotToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

export class DatabaseRobotStore {
  public constructor(
    private readonly database: DatabaseHandle,
    private readonly now: () => Date = () => new Date()
  ) {}

  /** 认证成功时更新最近使用时间并返回令牌归属；任何一步不满足都返回 undefined。 */
  public async authenticateToken(token: string): Promise<RobotTokenIdentity | undefined> {
    if (token.length < 16 || token.length > 4_096) {
      return undefined;
    }
    const digest = digestRobotToken(token);
    const nowIso = this.now().toISOString();
    const rows = await this.database.query<{ id: string; user_id: string }>(sql`
      UPDATE api_tokens
      SET last_used_at = ${nowIso}::timestamptz
      WHERE token_digest = ${digest}
        AND revoked_at IS NULL
        AND (expires_at IS NULL OR expires_at > ${nowIso}::timestamptz)
      RETURNING id::text AS id, user_id::text AS user_id
    `);
    const row = rows[0];
    return row === undefined ? undefined : { tokenId: row.id, userId: row.user_id };
  }

  /**
   * 该机器人尚未处理的待审轮次：轮次开放、题目仍处于待审、当前轮，且这个机器人
   * 既没有有效意见也没有未过期的领取记录。可见性由调用方逐题再检查。
   */
  public async listOpenRoundCandidates(
    reviewerUserId: string,
    limit: number
  ): Promise<RobotRoundCandidate[]> {
    const reviewerId = requireDatabaseId(reviewerUserId);
    const nowIso = this.now().toISOString();
    const rows = await this.database.query<{
      round_id: string;
      problem_id: string;
      round: number;
    }>(sql`
      SELECT round.id::text AS round_id, round.problem_id::text AS problem_id, round.round
      FROM review_rounds round
      JOIN problems problem
        ON problem.id = round.problem_id
       AND problem.deleted_at IS NULL
       AND problem.status = 'pending_review'
       AND problem.current_review_round = round.round
      WHERE round.status = 'open'
        AND NOT EXISTS (
          SELECT 1 FROM review_opinions opinion
          WHERE opinion.round_id = round.id AND opinion.reviewer_user_id = ${reviewerId}
        )
        AND NOT EXISTS (
          SELECT 1 FROM review_assignments assignment
          WHERE assignment.round_id = round.id
            AND assignment.reviewer_user_id = ${reviewerId}
            AND assignment.revoked_at IS NULL
            AND (assignment.expires_at IS NULL OR assignment.expires_at > ${nowIso}::timestamptz)
        )
      ORDER BY round.created_at ASC, round.id ASC
      LIMIT ${Math.min(Math.max(1, limit), 50)}
    `);
    return rows.map((row) => ({
      roundId: row.round_id,
      problemId: row.problem_id,
      round: Number(row.round)
    }));
  }

  /** 建立领取记录。同一机器人对同一轮的重复领取由唯一索引拒绝，返回 undefined。 */
  public async createAssignment(
    roundId: string,
    reviewerUserId: string,
    leaseSeconds: number
  ): Promise<RobotAssignment | undefined> {
    const reviewerId = requireDatabaseId(reviewerUserId);
    const expiresAt = new Date(this.now().getTime() + leaseSeconds * 1_000).toISOString();
    try {
      const rows = await this.database.query<AssignmentRow>(sql`
        WITH inserted AS (
          INSERT INTO review_assignments (
            id, round_id, reviewer_user_id, assigned_by_user_id, reason, expires_at
          ) VALUES (
            ${randomUUID()}::uuid, ${roundId}::uuid, ${reviewerId}, ${reviewerId},
            '机器人自动领取待审任务', ${expiresAt}::timestamptz
          )
          RETURNING id, round_id, reviewer_user_id, expires_at
        )
        SELECT inserted.id::text AS id,
               inserted.round_id::text AS round_id,
               round.problem_id::text AS problem_id,
               round.round,
               inserted.reviewer_user_id::text AS reviewer_user_id,
               inserted.expires_at
        FROM inserted
        JOIN review_rounds round ON round.id = inserted.round_id
      `);
      const row = rows[0];
      return row === undefined ? undefined : toAssignment(row);
    } catch {
      return undefined;
    }
  }

  /** 查找属于该机器人的、未撤销的领取记录。 */
  public async findAssignment(
    assignmentId: string,
    reviewerUserId: string
  ): Promise<RobotAssignment | undefined> {
    if (!/^[0-9a-f-]{36}$/i.test(assignmentId)) {
      return undefined;
    }
    const reviewerId = requireDatabaseId(reviewerUserId);
    const rows = await this.database.query<AssignmentRow>(sql`
      SELECT assignment.id::text AS id,
             assignment.round_id::text AS round_id,
             round.problem_id::text AS problem_id,
             round.round,
             assignment.reviewer_user_id::text AS reviewer_user_id,
             assignment.expires_at
      FROM review_assignments assignment
      JOIN review_rounds round ON round.id = assignment.round_id
      WHERE assignment.id = ${assignmentId}::uuid
        AND assignment.reviewer_user_id = ${reviewerId}
        AND assignment.revoked_at IS NULL
    `);
    const row = rows[0];
    return row === undefined ? undefined : toAssignment(row);
  }

  /** 乐观续租：当前到期时间必须与调用者见到的一致，且尚未过期。 */
  public async renewAssignment(
    assignmentId: string,
    reviewerUserId: string,
    expectedExpiresAt: string,
    leaseSeconds: number
  ): Promise<string | undefined> {
    const reviewerId = requireDatabaseId(reviewerUserId);
    const nowIso = this.now().toISOString();
    const nextExpiresAt = new Date(this.now().getTime() + leaseSeconds * 1_000).toISOString();
    const rows = await this.database.query<{ id: string }>(sql`
      UPDATE review_assignments
      SET expires_at = ${nextExpiresAt}::timestamptz
      WHERE id = ${assignmentId}::uuid
        AND reviewer_user_id = ${reviewerId}
        AND revoked_at IS NULL
        AND expires_at = ${expectedExpiresAt}::timestamptz
        AND expires_at > ${nowIso}::timestamptz
      RETURNING id::text AS id
    `);
    return rows.length === 1 ? nextExpiresAt : undefined;
  }

  /** 任务完成或放弃时结束租约。 */
  public async closeAssignment(assignmentId: string, reviewerUserId: string): Promise<void> {
    const reviewerId = requireDatabaseId(reviewerUserId);
    await this.database.execute(sql`
      UPDATE review_assignments
      SET revoked_at = ${this.now().toISOString()}::timestamptz,
          revoked_by_user_id = ${reviewerId}
      WHERE id = ${assignmentId}::uuid
        AND reviewer_user_id = ${reviewerId}
        AND revoked_at IS NULL
    `);
  }

  /** 完成任务的审计记录；只保存模型配置名称和实验版本，不含题面或意见正文。 */
  public async writeCompletionAudit(input: {
    readonly reviewerUserId: string;
    readonly problemId: string;
    readonly assignmentId: string;
    readonly experimentVersion: string;
    readonly modelProfileName: string;
    readonly result: "success" | "failure";
  }): Promise<void> {
    await this.database.execute(sql`
      INSERT INTO audit_events (
        actor_user_id, request_id, action, object_type, object_id, result, metadata
      ) VALUES (
        ${requireDatabaseId(input.reviewerUserId)},
        ${randomUUID()}::uuid,
        'robot.review.complete',
        'problem',
        ${input.problemId},
        ${input.result},
        ${JSON.stringify({
          assignmentId: input.assignmentId,
          experimentVersion: input.experimentVersion,
          modelProfileName: input.modelProfileName
        })}::jsonb
      )
    `);
  }
}

interface AssignmentRow extends Record<string, unknown> {
  id: string;
  round_id: string;
  problem_id: string;
  round: number;
  reviewer_user_id: string;
  expires_at: Date | string;
}

function toAssignment(row: AssignmentRow): RobotAssignment {
  return {
    id: row.id,
    roundId: row.round_id,
    problemId: row.problem_id,
    round: Number(row.round),
    reviewerUserId: row.reviewer_user_id,
    expiresAt: (row.expires_at instanceof Date
      ? row.expires_at
      : new Date(row.expires_at)
    ).toISOString()
  };
}

function requireDatabaseId(value: string): bigint {
  if (!databaseIdPattern.test(value)) {
    throw new Error("机器人用户编号无效。");
  }
  return BigInt(value);
}
