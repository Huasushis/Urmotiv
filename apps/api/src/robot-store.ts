import { createHash, randomUUID } from "node:crypto";
import {
  corePermissions,
  isIpAddressAllowedByCidrs,
  normalizeServiceAccountSourceCidr,
  robotHardDeniedPermissions,
} from "@urmotiv/contracts";
import type { DatabaseHandle } from "@urmotiv/database";
import { sql } from "drizzle-orm";
import {
  loadUsers,
  problemPermissionCondition,
  visibilityCondition,
} from "./database-store";
import type { StoredUser } from "./domain";
import {
  hasPermission,
  type ProblemPermissionFilter,
  type ProblemVisibility,
  restrictRobotUserToTokenPermissions,
} from "./permissions";

/**
 * 机器人审题链路的数据库操作：令牌认证、待审轮次候选、领取租约的创建/续租/结束。
 * 令牌认证在一致的数据库快照中加载账号权限，再按令牌权限收窄；具体题目权限仍由调用方检查。
 * 错误信息不区分“令牌不存在”“已撤销”“已过期”，一律按认证失败处理。
 */

const databaseIdPattern = /^(0|[1-9]\d*)$/;
const corePermissionSet = new Set<string>(corePermissions);
const robotHardDeniedPermissionSet = new Set<string>(robotHardDeniedPermissions);

export interface RobotTokenIdentity {
  readonly userId: string;
  readonly tokenId: string;
  /** Account grants narrowed to the names allowed by this token. */
  readonly user: StoredUser;
}

export interface RobotRoundCandidate {
  readonly roundId: string;
  readonly problemId: string;
  readonly ownerId: string;
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
    private readonly now: () => Date = () => new Date(),
  ) {}

  /**
   * Validate the account, token policy and source address in one database
   * transaction. last_used_at is written only after every authentication
   * condition has passed.
   */
  public async authenticateToken(
    token: string,
    clientAddress: string | undefined,
  ): Promise<RobotTokenIdentity | undefined> {
    if (token.length < 16 || token.length > 4_096) {
      return undefined;
    }
    const digest = digestRobotToken(token);
    const now = this.now();
    const nowIso = now.toISOString();
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        return await this.database.transaction(async (transaction) => {
          // This must be the first statement: loadUsers issues several queries,
          // and every account/token decision must observe one database snapshot.
          await transaction.execute(sql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ`);
          const rows = await transaction.query<AuthenticationRow>(sql`
        SELECT api_token.id::text AS token_id,
               api_token.user_id::text AS user_id,
               api_token.source_cidrs
        FROM api_tokens api_token
        JOIN users account ON account.id = api_token.user_id
        WHERE api_token.token_digest = ${digest}
          AND api_token.revoked_at IS NULL
          AND (api_token.expires_at IS NULL OR api_token.expires_at > ${nowIso}::timestamptz)
          AND account.account_type = 'robot'
          AND account.disabled_at IS NULL
        FOR UPDATE
      `);
          const row = rows[0];
          if (row === undefined) return undefined;

          const sourceCidrs = parseStoredSourceCidrs(row.source_cidrs);
          if (sourceCidrs === undefined || !isIpAddressAllowedByCidrs(clientAddress, sourceCidrs)) {
            return undefined;
          }

          const permissionRows = await transaction.query<TokenPermissionRow>(sql`
        SELECT permission_name, effect, scope, object_type, object_id
        FROM api_token_permissions
        WHERE token_id = ${row.token_id}::uuid
        ORDER BY permission_name, id
        FOR UPDATE
      `);
          const permissionNames = parseStoredTokenPermissions(permissionRows);
          if (permissionNames === undefined) return undefined;

          const accountUser = (await loadUsers(transaction, [requireDatabaseId(row.user_id)]))[0];
          const user =
            accountUser === undefined
              ? undefined
              : restrictRobotUserToTokenPermissions(accountUser, new Set(permissionNames));
          if (user === undefined || !hasPermission(user, "auth.login", {}, now)) {
            return undefined;
          }

          const listedPermissionNames = sql.join(
            permissionNames.map((permission) => sql`${permission}`),
            sql`, `,
          );
          const updated = await transaction.query<{ id: string }>(sql`
        WITH active_login_grants AS (
          SELECT grant_record.effect, grant_record.scope
          FROM permission_grants grant_record
          WHERE grant_record.subject_user_id = ${requireDatabaseId(row.user_id)}
            AND grant_record.permission_name = 'auth.login'
            AND grant_record.revoked_at IS NULL
            AND (grant_record.expires_at IS NULL OR grant_record.expires_at > ${nowIso}::timestamptz)
          UNION ALL
          SELECT grant_record.effect, grant_record.scope
          FROM role_memberships membership
          JOIN permission_grants grant_record
            ON grant_record.subject_role_id = membership.role_id
          WHERE membership.user_id = ${requireDatabaseId(row.user_id)}
            AND membership.revoked_at IS NULL
            AND (membership.expires_at IS NULL OR membership.expires_at > ${nowIso}::timestamptz)
            AND grant_record.permission_name = 'auth.login'
            AND grant_record.revoked_at IS NULL
            AND (grant_record.expires_at IS NULL OR grant_record.expires_at > ${nowIso}::timestamptz)
        )
        UPDATE api_tokens AS api_token
        SET last_used_at = ${nowIso}::timestamptz
        FROM users account
        WHERE api_token.id = ${row.token_id}::uuid
          AND api_token.user_id = account.id
          AND api_token.user_id = ${requireDatabaseId(row.user_id)}
          AND api_token.token_digest = ${digest}
          AND api_token.revoked_at IS NULL
          AND (api_token.expires_at IS NULL OR api_token.expires_at > ${nowIso}::timestamptz)
          AND api_token.source_cidrs = ${JSON.stringify(sourceCidrs)}::jsonb
          AND account.account_type = 'robot'
          AND account.disabled_at IS NULL
          AND (
            SELECT count(*)::integer
            FROM api_token_permissions permission
            WHERE permission.token_id = api_token.id
          ) = ${permissionNames.length}
          AND NOT EXISTS (
            SELECT 1
            FROM api_token_permissions permission
            WHERE permission.token_id = api_token.id
              AND (
                permission.effect <> 'allow'
                OR permission.scope <> 'global'
                OR permission.object_type IS NOT NULL
                OR permission.object_id IS NOT NULL
                OR permission.permission_name NOT IN (${listedPermissionNames})
              )
          )
          AND EXISTS (
            SELECT 1 FROM active_login_grants
            WHERE effect = 'allow' AND scope = 'global'
          )
          AND NOT EXISTS (
            SELECT 1 FROM active_login_grants
            WHERE effect = 'deny' AND scope = 'global'
          )
        RETURNING api_token.id::text AS id
      `);
          if (updated.length !== 1) return undefined;
          return { tokenId: row.token_id, userId: row.user_id, user };
        });
      } catch (error) {
        if (attempt === 0 && isSerializationFailure(error)) {
          continue;
        }
        throw error;
      }
    }
    throw new Error("机器人令牌认证重试状态无效。");
  }

  /**
   * 该机器人尚未处理的待审轮次：轮次开放、题目仍处于待审、当前轮，且这个机器人
   * 既没有有效意见也没有未过期的领取记录。可见性和审题权限在 SQL 中预筛选，
   * 调用方仍须对实际返回的题目逐题复核。
   */
  public async listOpenRoundCandidates(
    reviewerUserId: string,
    limit: number,
    visibility: ProblemVisibility,
    reviewPermission: ProblemPermissionFilter,
  ): Promise<RobotRoundCandidate[]> {
    const reviewerId = requireDatabaseId(reviewerUserId);
    if (
      visibility.viewerId !== reviewerUserId ||
      reviewPermission.viewerId !== reviewerUserId
    ) {
      return [];
    }
    const visibilitySql = visibilityCondition(visibility);
    const reviewPermissionSql = problemPermissionCondition(reviewPermission);
    if (visibilitySql === undefined || reviewPermissionSql === undefined) return [];
    const nowIso = this.now().toISOString();
    const rows = await this.database.query<{
      round_id: string;
      problem_id: string;
      owner_id: string;
      round: number;
    }>(sql`
      SELECT round.id::text AS round_id,
             round.problem_id::text AS problem_id,
             problem.owner_id::text AS owner_id,
             round.round
      FROM review_rounds round
      JOIN problems problem
        ON problem.id = round.problem_id
       AND problem.deleted_at IS NULL
       AND problem.status = 'pending_review'
       AND problem.current_review_round = round.round
      WHERE round.status = 'open'
        AND (${visibilitySql})
        AND (${reviewPermissionSql})
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
      ownerId: row.owner_id,
      round: Number(row.round),
    }));
  }

  /** 建立领取记录。同一机器人对同一轮的重复领取由唯一索引拒绝，返回 undefined。 */
  public async createAssignment(
    roundId: string,
    reviewerUserId: string,
    leaseSeconds: number,
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
    reviewerUserId: string,
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
    leaseSeconds: number,
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
          modelProfileName: input.modelProfileName,
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

interface AuthenticationRow extends Record<string, unknown> {
  token_id: string;
  user_id: string;
  source_cidrs: unknown;
}

interface TokenPermissionRow extends Record<string, unknown> {
  permission_name: string;
  effect: string;
  scope: string;
  object_type: string | null;
  object_id: string | null;
}

function parseStoredSourceCidrs(value: unknown): string[] | undefined {
  let parsed: unknown;
  try {
    parsed = typeof value === "string" ? (JSON.parse(value) as unknown) : value;
  } catch {
    return undefined;
  }
  if (!Array.isArray(parsed) || parsed.length > 32) return undefined;

  const result: string[] = [];
  const seen = new Set<string>();
  for (const item of parsed) {
    if (typeof item !== "string") return undefined;
    const normalized = normalizeServiceAccountSourceCidr(item);
    if (normalized === undefined || normalized !== item || seen.has(normalized)) {
      return undefined;
    }
    seen.add(normalized);
    result.push(normalized);
  }
  return result;
}

function parseStoredTokenPermissions(rows: readonly TokenPermissionRow[]): string[] | undefined {
  if (rows.length === 0 || rows.length > 64) return undefined;

  const result: string[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    if (
      !corePermissionSet.has(row.permission_name) ||
      robotHardDeniedPermissionSet.has(row.permission_name) ||
      row.effect !== "allow" ||
      row.scope !== "global" ||
      row.object_type !== null ||
      row.object_id !== null ||
      seen.has(row.permission_name)
    ) {
      return undefined;
    }
    seen.add(row.permission_name);
    result.push(row.permission_name);
  }
  return seen.has("auth.login") ? result : undefined;
}

function isSerializationFailure(error: unknown): boolean {
  const seen = new Set<object>();
  let current = error;
  for (let depth = 0; depth < 8; depth += 1) {
    if (typeof current !== "object" || current === null || seen.has(current)) {
      return false;
    }
    seen.add(current);
    if ("code" in current && current.code === "40001") {
      return true;
    }
    if (!("cause" in current)) {
      return false;
    }
    current = current.cause;
  }
  return false;
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
    ).toISOString(),
  };
}

function requireDatabaseId(value: string): bigint {
  if (!databaseIdPattern.test(value)) {
    throw new Error("机器人用户编号无效。");
  }
  return BigInt(value);
}
