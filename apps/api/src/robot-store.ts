import { createHash, randomUUID } from "node:crypto";
import {
  corePermissions,
  isIpAddressAllowedByCidrs,
  normalizeServiceAccountSourceCidr,
  robotHardDeniedPermissions,
  type ProblemType,
} from "@urmotiv/contracts";
import type { DatabaseExecutor, DatabaseHandle } from "@urmotiv/database";
import { sql } from "drizzle-orm";
import {
  loadUsers,
  problemPermissionCondition,
  visibilityCondition,
} from "./database-store";
import type { StoredProblem, StoredUser } from "./domain";
import {
  canViewProblem,
  createProblemVisibility,
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
  /** Parsed peer address used for the successful authentication decision. */
  readonly clientAddress: string | undefined;
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
  readonly claimedProblemRevision: number;
  readonly claimedSubmittedRevisionId: string;
}

export type RobotOperationOutcome<Result> =
  | { readonly kind: "success"; readonly result: Result; readonly replayed: boolean }
  | { readonly kind: "not_found" }
  | { readonly kind: "conflict" };

export interface PreparedRobotCompletion {
  readonly assignment: RobotAssignment;
  readonly user: StoredUser;
  readonly requestId: string;
  readonly payloadDigest: string;
}

export interface RobotRenewalResult {
  readonly assignmentId: string;
  readonly leaseExpiresAt: string;
}

export interface RobotCompletionResult {
  readonly assignmentId: string;
  readonly accepted: true;
  readonly problemStatus: "pending_review" | "approved" | "rejected";
}

export function digestRobotOperationPayload(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex");
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
          // Keep every statement current after it has waited for the explicit
          // account -> token -> policy locks. REPEATABLE READ would make a burst
          // of requests on one token serialize into avoidable 40001 failures.
          await transaction.execute(sql`SET TRANSACTION ISOLATION LEVEL READ COMMITTED`);
          const lookupRows = await transaction.query<TokenLookupRow>(sql`
        SELECT id::text AS token_id, user_id::text AS user_id
        FROM api_tokens
        WHERE token_digest = ${digest}
        LIMIT 1
      `);
          const lookup = lookupRows[0];
          if (lookup === undefined) return undefined;
          const accountRows = await transaction.query<AccountLockRow>(sql`
        SELECT id::text AS user_id, account_type, disabled_at
        FROM users
        WHERE id = ${requireDatabaseId(lookup.user_id)}
        FOR SHARE
      `);
          const account = accountRows[0];
          if (
            account === undefined
            || account.account_type !== "robot"
            || account.disabled_at !== null
          ) {
            return undefined;
          }
          const rows = await transaction.query<AuthenticationRow>(sql`
        SELECT id::text AS token_id,
               user_id::text AS user_id,
               source_cidrs
        FROM api_tokens
        WHERE id = ${lookup.token_id}::uuid
          AND user_id = ${requireDatabaseId(lookup.user_id)}
          AND token_digest = ${digest}
          AND revoked_at IS NULL
          AND (expires_at IS NULL OR expires_at > ${nowIso}::timestamptz)
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

          await lockAccountPolicyRows(transaction, row.user_id, "UPDATE");

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
          return { tokenId: row.token_id, userId: row.user_id, user, clientAddress };
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
    supportedProblemTypes?: readonly ProblemType[],
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
    const supportedTypeCondition = supportedProblemTypes === undefined
      ? sql`true`
      : sql`revision.type IN (${sql.join(
          supportedProblemTypes.map((type) => sql`${type}::problem_type`),
          sql`, `,
        )})`;
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
      JOIN problem_revisions revision
        ON revision.problem_id = problem.id
       AND revision.revision = problem.current_revision
      WHERE round.status = 'open'
        AND (${supportedTypeCondition})
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

  /** Non-locking lookup used only to choose the problem lock acquired by the operation transaction. */
  public async findAssignmentTarget(
    assignmentId: string,
    reviewerUserId: string,
  ): Promise<{ readonly problemId: string } | undefined> {
    if (!/^[0-9a-f-]{36}$/i.test(assignmentId)) {
      return undefined;
    }
    const reviewerId = requireDatabaseId(reviewerUserId);
    const rows = await this.database.query<{ problem_id: string }>(sql`
      SELECT round.problem_id::text AS problem_id
      FROM review_assignments assignment
      JOIN review_rounds round ON round.id = assignment.round_id
      WHERE assignment.id = ${assignmentId}::uuid
        AND assignment.reviewer_user_id = ${reviewerId}
    `);
    const row = rows[0];
    return row === undefined ? undefined : { problemId: row.problem_id };
  }

  /**
   * The caller already owns the problem and current-round locks. This method
   * next locks this robot's assignment rows, then revalidates the token and
   * account policy before writing the claim and its audit event.
   */
  public async claimAssignmentInTransaction(
    executor: DatabaseExecutor,
    identity: RobotTokenIdentity,
    problem: StoredProblem,
    roundId: string,
    leaseSeconds: number,
    requestId: string,
  ): Promise<{ readonly assignment: RobotAssignment; readonly user: StoredUser } | undefined> {
    const reviewerId = requireDatabaseId(identity.userId);
    const problemId = requireDatabaseId(problem.id);
    const roundRows = await executor.query<LockedRoundRow>(sql`
      SELECT round.id::text AS id,
             round.round,
             round.status,
             round.submitted_revision_id::text AS submitted_revision_id
      FROM review_rounds round
      WHERE round.id = ${roundId}::uuid
        AND round.problem_id = ${problemId}
        AND round.round = ${problem.reviewRound}
      FOR UPDATE
    `);
    const round = roundRows[0];
    if (
      round === undefined
      || round.status !== "open"
      || problem.status !== "pending_review"
    ) {
      return undefined;
    }

    const existingAssignments = await executor.query<AssignmentRow>(sql`
      SELECT assignment.id::text AS id,
             assignment.round_id::text AS round_id,
             round.problem_id::text AS problem_id,
             round.round,
             assignment.reviewer_user_id::text AS reviewer_user_id,
             assignment.expires_at,
             assignment.claimed_problem_revision,
             assignment.claimed_submitted_revision_id::text AS claimed_submitted_revision_id,
             assignment.closure_reason
      FROM review_assignments assignment
      JOIN review_rounds round ON round.id = assignment.round_id
      WHERE assignment.round_id = ${roundId}::uuid
        AND assignment.reviewer_user_id = ${reviewerId}
      ORDER BY assignment.created_at, assignment.id
      FOR UPDATE OF assignment
    `);
    const nowIso = this.now().toISOString();
    const user = await this.revalidateIdentityInTransaction(executor, identity);
    if (!canRobotReviewProblem(user, problem, this.now())) {
      return undefined;
    }
    for (const existing of existingAssignments) {
      if (existing.closure_reason !== null) continue;
      if (toIso(existing.expires_at) > nowIso) {
        return undefined;
      }
      await closeAssignment(
        executor,
        existing,
        "expired",
        identity.userId,
        requestId,
        nowIso,
      );
    }
    const existingOpinions = await executor.query<{ id: string }>(sql`
      SELECT id::text AS id
      FROM review_opinions
      WHERE round_id = ${roundId}::uuid
        AND reviewer_user_id = ${reviewerId}
        AND is_active = true
      FOR UPDATE
    `);
    if (existingOpinions.length !== 0) {
      return undefined;
    }

    const assignmentId = randomUUID();
    const expiresAt = new Date(this.now().getTime() + leaseSeconds * 1_000).toISOString();
    const inserted = await executor.query<AssignmentRow>(sql`
      INSERT INTO review_assignments (
        id,
        round_id,
        reviewer_user_id,
        assigned_by_user_id,
        reason,
        assignment_kind,
        claimed_problem_revision,
        claimed_submitted_revision_id,
        expires_at
      ) VALUES (
        ${assignmentId}::uuid,
        ${roundId}::uuid,
        ${reviewerId},
        ${reviewerId},
        '机器人自动领取待审任务',
        'robot',
        ${problem.revision},
        ${round.submitted_revision_id}::uuid,
        ${expiresAt}::timestamptz
      )
      RETURNING id::text AS id,
                round_id::text AS round_id,
                ${problem.id}::text AS problem_id,
                ${round.round}::integer AS round,
                reviewer_user_id::text AS reviewer_user_id,
                expires_at,
                claimed_problem_revision,
                claimed_submitted_revision_id::text AS claimed_submitted_revision_id,
                closure_reason
    `);
    const row = inserted[0];
    if (row === undefined) {
      throw new Error("机器人领取记录写入失败。");
    }
    await insertRobotAudit(executor, {
      actorUserId: identity.userId,
      requestId,
      action: "robot.review.claim",
      problemId: problem.id,
      result: "success",
      metadata: {
        assignmentId,
        round: problem.reviewRound,
        claimedProblemRevision: problem.revision,
      },
    });
    return { assignment: toAssignment(row), user };
  }

  public async renewAssignmentInTransaction(
    executor: DatabaseExecutor,
    identity: RobotTokenIdentity,
    problem: StoredProblem,
    assignmentId: string,
    input: {
      readonly requestId: string;
      readonly expectedLeaseExpiresAt: string;
      readonly leaseSeconds: number;
    },
    payloadDigest: string,
  ): Promise<RobotOperationOutcome<RobotRenewalResult>> {
    const assignment = await lockAssignment(executor, assignmentId, identity.userId);
    if (assignment === undefined || assignment.problem_id !== problem.id) {
      return { kind: "not_found" };
    }
    const user = await this.revalidateIdentityInTransaction(executor, identity);
    if (user === undefined) {
      const auditId = await closeAssignment(
        executor,
        assignment,
        "permission_revoked",
        identity.userId,
        input.requestId,
        this.now().toISOString(),
      );
      if (auditId !== undefined) {
        await rememberFailedOperation(executor, {
          assignmentId,
          requestId: input.requestId,
          operation: "renew",
          payloadDigest,
          outcome: "not_found",
          auditId,
        });
      }
      return { kind: "not_found" };
    }
    if (!canRobotReviewProblem(user, problem, this.now())) {
      const auditId = await closeAssignment(
        executor,
        assignment,
        "permission_revoked",
        identity.userId,
        input.requestId,
        this.now().toISOString(),
      );
      if (auditId !== undefined) {
        await rememberFailedOperation(executor, {
          assignmentId,
          requestId: input.requestId,
          operation: "renew",
          payloadDigest,
          outcome: "not_found",
          auditId,
        });
      }
      return { kind: "not_found" };
    }
    const replay = await readOperation(executor, assignmentId, input.requestId);
    if (replay !== undefined) {
      if (replay.operation !== "renew" || replay.payload_digest !== payloadDigest) {
        return { kind: "conflict" };
      }
      const failure = parseStoredFailureOutcome(replay.result);
      if (failure !== undefined) return { kind: failure };
      const result = parseRenewalResult(replay.result);
      return result === undefined
        ? { kind: "conflict" }
        : { kind: "success", result, replayed: true };
    }

    const policyFailure = assignmentPolicyFailure(assignment, problem, user, this.now());
    if (policyFailure !== undefined) {
      const auditId = await closeAssignment(
        executor,
        assignment,
        policyFailure,
        identity.userId,
        input.requestId,
        this.now().toISOString(),
      );
      if (auditId !== undefined) {
        await rememberFailedOperation(executor, {
          assignmentId,
          requestId: input.requestId,
          operation: "renew",
          payloadDigest,
          outcome: "not_found",
          auditId,
        });
      }
      return { kind: "not_found" };
    }
    if (toIso(assignment.expires_at) !== input.expectedLeaseExpiresAt) {
      await recordRejectedOperation(executor, assignment, {
        requestId: input.requestId,
        operation: "renew",
        payloadDigest,
        outcome: "not_found",
        reasonCode: "lease_snapshot_mismatch",
      });
      return { kind: "not_found" };
    }

    const nextExpiresAt = new Date(this.now().getTime() + input.leaseSeconds * 1_000).toISOString();
    const result: RobotRenewalResult = { assignmentId, leaseExpiresAt: nextExpiresAt };
    const updated = await executor.query<{ id: string }>(sql`
      UPDATE review_assignments
      SET expires_at = ${nextExpiresAt}::timestamptz
      WHERE id = ${assignmentId}::uuid
        AND closure_reason IS NULL
        AND expires_at = ${input.expectedLeaseExpiresAt}::timestamptz
      RETURNING id::text AS id
    `);
    if (updated.length !== 1) {
      await recordRejectedOperation(executor, assignment, {
        requestId: input.requestId,
        operation: "renew",
        payloadDigest,
        outcome: "not_found",
        reasonCode: "lease_changed",
      });
      return { kind: "not_found" };
    }
    const auditId = await insertRobotAudit(executor, {
      actorUserId: identity.userId,
      requestId: input.requestId,
      action: "robot.review.renew",
      problemId: problem.id,
      result: "success",
      metadata: { assignmentId, round: assignment.round },
    });
    await executor.execute(sql`
      INSERT INTO review_assignment_operations (
        assignment_id, request_id, operation, payload_digest, result, audit_event_id
      ) VALUES (
        ${assignmentId}::uuid,
        ${input.requestId}::uuid,
        'renew',
        ${payloadDigest},
        ${JSON.stringify(result)}::jsonb,
        ${auditId}
      )
    `);
    await executor.execute(sql`
      UPDATE review_assignments
      SET last_renewal_request_id = ${input.requestId}::uuid,
          last_renewal_payload_digest = ${payloadDigest},
          last_renewal_result = ${JSON.stringify(result)}::jsonb,
          last_renewal_audit_id = ${auditId}
      WHERE id = ${assignmentId}::uuid
    `);
    return { kind: "success", result, replayed: false };
  }

  public async prepareCompletionInTransaction(
    executor: DatabaseExecutor,
    identity: RobotTokenIdentity,
    problem: StoredProblem,
    assignmentId: string,
    input: {
      readonly requestId: string;
      readonly expectedLeaseExpiresAt: string;
      readonly expectedProblemRevision: number;
    },
    payloadDigest: string,
  ): Promise<
    | RobotOperationOutcome<RobotCompletionResult>
    | { readonly kind: "ready"; readonly prepared: PreparedRobotCompletion }
  > {
    const assignment = await lockAssignment(executor, assignmentId, identity.userId);
    if (assignment === undefined || assignment.problem_id !== problem.id) {
      return { kind: "not_found" };
    }
    const user = await this.revalidateIdentityInTransaction(executor, identity);
    if (user === undefined) {
      const auditId = await closeAssignment(
        executor,
        assignment,
        "permission_revoked",
        identity.userId,
        input.requestId,
        this.now().toISOString(),
      );
      if (auditId !== undefined) {
        await rememberFailedOperation(executor, {
          assignmentId,
          requestId: input.requestId,
          operation: "complete",
          payloadDigest,
          outcome: "not_found",
          auditId,
        });
      }
      return { kind: "not_found" };
    }
    if (!canRobotReviewProblem(user, problem, this.now())) {
      const auditId = await closeAssignment(
        executor,
        assignment,
        "permission_revoked",
        identity.userId,
        input.requestId,
        this.now().toISOString(),
      );
      if (auditId !== undefined) {
        await rememberFailedOperation(executor, {
          assignmentId,
          requestId: input.requestId,
          operation: "complete",
          payloadDigest,
          outcome: "not_found",
          auditId,
        });
      }
      return { kind: "not_found" };
    }
    const replay = await readOperation(executor, assignmentId, input.requestId);
    if (replay !== undefined) {
      if (replay.operation !== "complete" || replay.payload_digest !== payloadDigest) {
        return { kind: "conflict" };
      }
      const failure = parseStoredFailureOutcome(replay.result);
      if (failure !== undefined) return { kind: failure };
      const result = parseCompletionResult(replay.result);
      return result === undefined
        ? { kind: "conflict" }
        : { kind: "success", result, replayed: true };
    }

    const policyFailure = assignmentPolicyFailure(assignment, problem, user, this.now());
    if (policyFailure !== undefined) {
      const auditId = await closeAssignment(
        executor,
        assignment,
        policyFailure,
        identity.userId,
        input.requestId,
        this.now().toISOString(),
      );
      const outcome = policyFailure === "expired" ? "conflict" : "not_found";
      if (auditId !== undefined) {
        await rememberFailedOperation(executor, {
          assignmentId,
          requestId: input.requestId,
          operation: "complete",
          payloadDigest,
          outcome,
          auditId,
        });
      }
      return { kind: outcome };
    }
    if (
      toIso(assignment.expires_at) !== input.expectedLeaseExpiresAt
      || Number(assignment.claimed_problem_revision) !== input.expectedProblemRevision
    ) {
      await recordRejectedOperation(executor, assignment, {
        requestId: input.requestId,
        operation: "complete",
        payloadDigest,
        outcome: "conflict",
        reasonCode: "lease_snapshot_mismatch",
      });
      return { kind: "conflict" };
    }
    return {
      kind: "ready",
      prepared: {
        assignment: toAssignment(assignment),
        user,
        requestId: input.requestId,
        payloadDigest,
      },
    };
  }

  /** Called after the opinion write while all problem/round/assignment locks remain held. */
  public async finishCompletionInTransaction(
    executor: DatabaseExecutor,
    prepared: PreparedRobotCompletion,
    result: RobotCompletionResult,
    opinionId: string,
    metadata: {
      readonly experimentVersion: string;
      readonly modelProfileName: string;
    },
  ): Promise<void> {
    const auditId = await insertRobotAudit(executor, {
      actorUserId: prepared.user.id,
      requestId: prepared.requestId,
      action: "robot.review.complete",
      problemId: prepared.assignment.problemId,
      result: "success",
      metadata: {
        assignmentId: prepared.assignment.id,
        round: prepared.assignment.round,
        experimentVersion: metadata.experimentVersion,
        modelProfileName: metadata.modelProfileName,
      },
    });
    const closedAt = this.now().toISOString();
    const updated = await executor.query<{ id: string }>(sql`
      UPDATE review_assignments
      SET closed_at = ${closedAt}::timestamptz,
          closure_reason = 'completed',
          closed_by_user_id = ${requireDatabaseId(prepared.user.id)},
          revoked_at = ${closedAt}::timestamptz,
          revoked_by_user_id = ${requireDatabaseId(prepared.user.id)},
          completion_request_id = ${prepared.requestId}::uuid,
          completion_payload_digest = ${prepared.payloadDigest},
          completion_result = ${JSON.stringify(result)}::jsonb,
          completion_audit_id = ${auditId},
          completion_opinion_id = ${opinionId}::uuid
      WHERE id = ${prepared.assignment.id}::uuid
        AND closure_reason IS NULL
      RETURNING id::text AS id
    `);
    if (updated.length !== 1) {
      throw new Error("机器人完成记录在事务中发生变化。");
    }
    await executor.execute(sql`
      INSERT INTO review_assignment_operations (
        assignment_id, request_id, operation, payload_digest, result, audit_event_id
      ) VALUES (
        ${prepared.assignment.id}::uuid,
        ${prepared.requestId}::uuid,
        'complete',
        ${prepared.payloadDigest},
        ${JSON.stringify(result)}::jsonb,
        ${auditId}
      )
    `);
  }

  private async revalidateIdentityInTransaction(
    executor: DatabaseExecutor,
    identity: RobotTokenIdentity,
  ): Promise<StoredUser | undefined> {
    const nowIso = this.now().toISOString();
    const accountRows = await executor.query<AccountLockRow>(sql`
      SELECT id::text AS user_id, account_type, disabled_at
      FROM users
      WHERE id = ${requireDatabaseId(identity.userId)}
      FOR SHARE
    `);
    const accountRow = accountRows[0];
    if (
      accountRow === undefined
      || accountRow.account_type !== "robot"
      || accountRow.disabled_at !== null
    ) {
      return undefined;
    }
    const tokenRows = await executor.query<AuthenticationRow>(sql`
      SELECT id::text AS token_id,
             user_id::text AS user_id,
             source_cidrs
      FROM api_tokens
      WHERE id = ${identity.tokenId}::uuid
        AND user_id = ${requireDatabaseId(identity.userId)}
        AND revoked_at IS NULL
        AND (expires_at IS NULL OR expires_at > ${nowIso}::timestamptz)
      FOR SHARE
    `);
    const token = tokenRows[0];
    if (token === undefined) return undefined;
    const sourceCidrs = parseStoredSourceCidrs(token.source_cidrs);
    if (
      sourceCidrs === undefined
      || !isIpAddressAllowedByCidrs(identity.clientAddress, sourceCidrs)
    ) {
      return undefined;
    }
    const permissions = await executor.query<TokenPermissionRow>(sql`
      SELECT permission_name, effect, scope, object_type, object_id
      FROM api_token_permissions
      WHERE token_id = ${identity.tokenId}::uuid
      ORDER BY permission_name, id
      FOR SHARE
    `);
    const permissionNames = parseStoredTokenPermissions(permissions);
    if (permissionNames === undefined) return undefined;

    await lockAccountPolicyRows(executor, identity.userId, "SHARE");
    const account = (await loadUsers(executor, [requireDatabaseId(identity.userId)]))[0];
    const user = account === undefined
      ? undefined
      : restrictRobotUserToTokenPermissions(account, new Set(permissionNames));
    return user !== undefined && hasPermission(user, "auth.login", {}, this.now())
      ? user
      : undefined;
  }
}

interface AssignmentRow extends Record<string, unknown> {
  id: string;
  round_id: string;
  problem_id: string;
  round: number;
  reviewer_user_id: string;
  expires_at: Date | string;
  claimed_problem_revision: number;
  claimed_submitted_revision_id: string;
  closure_reason:
    | "completed"
    | "expired"
    | "round_closed"
    | "permission_revoked"
    | "content_changed"
    | "abandoned"
    | "legacy_closed"
    | null;
  round_status?: "open" | "approved" | "rejected" | "withdrawn";
  submitted_revision_id?: string;
}

interface LockedRoundRow extends Record<string, unknown> {
  id: string;
  round: number;
  status: "open" | "approved" | "rejected" | "withdrawn";
  submitted_revision_id: string;
}

interface OperationRow extends Record<string, unknown> {
  operation: "renew" | "complete";
  payload_digest: string;
  result: unknown;
}

interface AuthenticationRow extends Record<string, unknown> {
  token_id: string;
  user_id: string;
  source_cidrs: unknown;
}

interface TokenLookupRow extends Record<string, unknown> {
  token_id: string;
  user_id: string;
}

interface AccountLockRow extends Record<string, unknown> {
  user_id: string;
  account_type: string;
  disabled_at: Date | string | null;
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

async function lockAccountPolicyRows(
  executor: DatabaseExecutor,
  userId: string,
  strength: "SHARE" | "UPDATE",
): Promise<void> {
  const databaseUserId = requireDatabaseId(userId);
  if (strength === "UPDATE") {
    await executor.query<{ id: string }>(sql`
      SELECT membership.id::text AS id
      FROM role_memberships membership
      WHERE membership.user_id = ${databaseUserId}
      ORDER BY membership.id
      FOR UPDATE
    `);
    await executor.query<{ id: string }>(sql`
      SELECT grant_record.id::text AS id
      FROM permission_grants grant_record
      WHERE grant_record.subject_user_id = ${databaseUserId}
         OR grant_record.subject_role_id IN (
           SELECT membership.role_id
           FROM role_memberships membership
           WHERE membership.user_id = ${databaseUserId}
         )
      ORDER BY grant_record.id
      FOR UPDATE
    `);
    return;
  }
  await executor.query<{ id: string }>(sql`
    SELECT membership.id::text AS id
    FROM role_memberships membership
    WHERE membership.user_id = ${databaseUserId}
    ORDER BY membership.id
    FOR SHARE
  `);
  await executor.query<{ id: string }>(sql`
    SELECT grant_record.id::text AS id
    FROM permission_grants grant_record
    WHERE grant_record.subject_user_id = ${databaseUserId}
       OR grant_record.subject_role_id IN (
         SELECT membership.role_id
         FROM role_memberships membership
         WHERE membership.user_id = ${databaseUserId}
       )
    ORDER BY grant_record.id
    FOR SHARE
  `);
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
    expiresAt: toIso(row.expires_at),
    claimedProblemRevision: Number(row.claimed_problem_revision),
    claimedSubmittedRevisionId: row.claimed_submitted_revision_id,
  };
}

function toIso(value: Date | string): string {
  const parsed = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(parsed.getTime())) {
    throw new Error("机器人领取记录包含无效时间。");
  }
  return parsed.toISOString();
}

async function lockAssignment(
  executor: DatabaseExecutor,
  assignmentId: string,
  reviewerUserId: string,
): Promise<AssignmentRow | undefined> {
  if (!/^[0-9a-f-]{36}$/i.test(assignmentId)) return undefined;
  const rows = await executor.query<AssignmentRow>(sql`
    SELECT assignment.id::text AS id,
           assignment.round_id::text AS round_id,
           round.problem_id::text AS problem_id,
           round.round,
           round.status AS round_status,
           round.submitted_revision_id::text AS submitted_revision_id,
           assignment.reviewer_user_id::text AS reviewer_user_id,
           assignment.expires_at,
           assignment.claimed_problem_revision,
           assignment.claimed_submitted_revision_id::text AS claimed_submitted_revision_id,
           assignment.closure_reason
    FROM review_assignments assignment
    JOIN review_rounds round ON round.id = assignment.round_id
    WHERE assignment.id = ${assignmentId}::uuid
      AND assignment.reviewer_user_id = ${requireDatabaseId(reviewerUserId)}
      AND assignment.assignment_kind = 'robot'
    FOR UPDATE OF assignment
  `);
  return rows[0];
}

function canRobotReviewProblem(
  user: StoredUser | undefined,
  problem: StoredProblem,
  evaluatedAt: Date,
): user is StoredUser {
  if (user === undefined || user.accountType !== "robot") return false;
  const target = { ownerId: problem.ownerId, objectId: problem.id };
  return canViewProblem(createProblemVisibility(user, evaluatedAt), problem)
    && hasPermission(user, "problem.review", target, evaluatedAt);
}

function assignmentPolicyFailure(
  assignment: AssignmentRow,
  problem: StoredProblem,
  user: StoredUser,
  evaluatedAt: Date,
): "expired" | "round_closed" | "permission_revoked" | "content_changed" | undefined {
  if (assignment.closure_reason !== null) return "round_closed";
  if (Date.parse(toIso(assignment.expires_at)) <= evaluatedAt.getTime()) return "expired";
  if (
    problem.status !== "pending_review"
    || problem.reviewRound !== Number(assignment.round)
    || assignment.round_status !== "open"
  ) {
    return "round_closed";
  }
  if (
    problem.revision !== Number(assignment.claimed_problem_revision)
    || assignment.claimed_submitted_revision_id !== assignment.submitted_revision_id
  ) {
    return "content_changed";
  }
  return canRobotReviewProblem(user, problem, evaluatedAt) ? undefined : "permission_revoked";
}

async function closeAssignment(
  executor: DatabaseExecutor,
  assignment: AssignmentRow,
  reason: "expired" | "round_closed" | "permission_revoked" | "content_changed" | "abandoned",
  actorUserId: string,
  requestId: string,
  closedAt: string,
): Promise<bigint | undefined> {
  if (assignment.closure_reason !== null) return undefined;
  const updated = await executor.query<{ id: string }>(sql`
    UPDATE review_assignments
    SET closed_at = ${closedAt}::timestamptz,
        closure_reason = ${reason}::review_assignment_closure_reason,
        closed_by_user_id = ${requireDatabaseId(actorUserId)},
        revoked_at = ${closedAt}::timestamptz,
        revoked_by_user_id = ${requireDatabaseId(actorUserId)}
    WHERE id = ${assignment.id}::uuid
      AND closure_reason IS NULL
    RETURNING id::text AS id
  `);
  if (updated.length !== 1) return undefined;
  return insertRobotAudit(executor, {
    actorUserId,
    requestId,
    action: "robot.review.assignment.close",
    problemId: assignment.problem_id,
    result: reason === "permission_revoked" ? "denied" : "failure",
    reasonCode: reason,
    metadata: {
      assignmentId: assignment.id,
      round: assignment.round,
      closureReason: reason,
    },
  });
}

async function rememberFailedOperation(
  executor: DatabaseExecutor,
  input: {
    readonly assignmentId: string;
    readonly requestId: string;
    readonly operation: "renew" | "complete";
    readonly payloadDigest: string;
    readonly outcome: "not_found" | "conflict";
    readonly auditId: bigint;
  },
): Promise<void> {
  await executor.execute(sql`
    INSERT INTO review_assignment_operations (
      assignment_id, request_id, operation, payload_digest, result, audit_event_id
    ) VALUES (
      ${input.assignmentId}::uuid,
      ${input.requestId}::uuid,
      ${input.operation}::review_assignment_operation,
      ${input.payloadDigest},
      ${JSON.stringify({ outcome: input.outcome })}::jsonb,
      ${input.auditId}
    )
    ON CONFLICT (assignment_id, request_id) DO NOTHING
  `);
}

async function recordRejectedOperation(
  executor: DatabaseExecutor,
  assignment: AssignmentRow,
  input: {
    readonly requestId: string;
    readonly operation: "renew" | "complete";
    readonly payloadDigest: string;
    readonly outcome: "not_found" | "conflict";
    readonly reasonCode: "lease_snapshot_mismatch" | "lease_changed";
  },
): Promise<void> {
  const auditId = await insertRobotAudit(executor, {
    actorUserId: assignment.reviewer_user_id,
    requestId: input.requestId,
    action: `robot.review.${input.operation}`,
    problemId: assignment.problem_id,
    result: "failure",
    reasonCode: input.reasonCode,
    metadata: {
      assignmentId: assignment.id,
      round: assignment.round,
    },
  });
  await rememberFailedOperation(executor, {
    assignmentId: assignment.id,
    requestId: input.requestId,
    operation: input.operation,
    payloadDigest: input.payloadDigest,
    outcome: input.outcome,
    auditId,
  });
}

async function insertRobotAudit(
  executor: DatabaseExecutor,
  input: {
    readonly actorUserId: string;
    readonly requestId: string;
    readonly action: string;
    readonly problemId: string;
    readonly result: "success" | "denied" | "failure";
    readonly reasonCode?: string;
    readonly metadata: Readonly<Record<string, string | number>>;
  },
): Promise<bigint> {
  const rows = await executor.query<{ id: string }>(sql`
    INSERT INTO audit_events (
      actor_user_id, request_id, action, object_type, object_id, result, reason_code, metadata
    ) VALUES (
      ${requireDatabaseId(input.actorUserId)},
      ${input.requestId}::uuid,
      ${input.action},
      'problem',
      ${input.problemId},
      ${input.result}::audit_result,
      ${input.reasonCode ?? null},
      ${JSON.stringify(input.metadata)}::jsonb
    )
    RETURNING id::text AS id
  `);
  const id = rows[0]?.id;
  if (id === undefined || !databaseIdPattern.test(id)) {
    throw new Error("机器人审计记录写入失败。");
  }
  return BigInt(id);
}

async function readOperation(
  executor: DatabaseExecutor,
  assignmentId: string,
  requestId: string,
): Promise<OperationRow | undefined> {
  const rows = await executor.query<OperationRow>(sql`
    SELECT operation, payload_digest, result
    FROM review_assignment_operations
    WHERE assignment_id = ${assignmentId}::uuid
      AND request_id = ${requestId}::uuid
    FOR UPDATE
  `);
  return rows[0];
}

function parseJsonObject(value: unknown): Record<string, unknown> | undefined {
  let parsed: unknown;
  try {
    parsed = typeof value === "string" ? JSON.parse(value) as unknown : value;
  } catch {
    return undefined;
  }
  return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
    ? parsed as Record<string, unknown>
    : undefined;
}

function parseStoredFailureOutcome(value: unknown): "not_found" | "conflict" | undefined {
  const parsed = parseJsonObject(value);
  if (parsed === undefined || Object.keys(parsed).length !== 1) return undefined;
  return parsed.outcome === "not_found" || parsed.outcome === "conflict"
    ? parsed.outcome
    : undefined;
}

function parseRenewalResult(value: unknown): RobotRenewalResult | undefined {
  const parsed = parseJsonObject(value);
  return parsed !== undefined
    && typeof parsed.assignmentId === "string"
    && /^[0-9a-f-]{36}$/i.test(parsed.assignmentId)
    && typeof parsed.leaseExpiresAt === "string"
    && Number.isFinite(Date.parse(parsed.leaseExpiresAt))
    ? { assignmentId: parsed.assignmentId, leaseExpiresAt: new Date(parsed.leaseExpiresAt).toISOString() }
    : undefined;
}

function parseCompletionResult(value: unknown): RobotCompletionResult | undefined {
  const parsed = parseJsonObject(value);
  if (
    parsed === undefined
    || typeof parsed.assignmentId !== "string"
    || !/^[0-9a-f-]{36}$/i.test(parsed.assignmentId)
    || parsed.accepted !== true
    || !new Set(["pending_review", "approved", "rejected"]).has(String(parsed.problemStatus))
  ) {
    return undefined;
  }
  return {
    assignmentId: parsed.assignmentId,
    accepted: true,
    problemStatus: parsed.problemStatus as RobotCompletionResult["problemStatus"],
  };
}

function requireDatabaseId(value: string): bigint {
  if (!databaseIdPattern.test(value)) {
    throw new Error("机器人用户编号无效。");
  }
  return BigInt(value);
}
