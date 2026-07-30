import type { ProblemAccessRecord, UserSummary } from "@urmotiv/contracts";
import type { DatabaseExecutor, DatabaseHandle } from "@urmotiv/database";
import { sql } from "drizzle-orm";
import type {
  ContestMemberRecord,
  ContestProblemRecord,
  ContestRecord,
  ContestRiskRecord,
  ContestStore,
  ContestWriteRecord,
  RecordProblemAccessInput
} from "./contest-store";

const maximumDatabaseId = 9_223_372_036_854_775_807n;

interface ContestRow extends Record<string, unknown> {
  id: string;
  title: string;
  description: string;
  state: ContestRecord["state"];
  starts_at: Date | string | null;
  ends_at: Date | string | null;
  creator_id: string;
  creator_nickname: string;
  creator_account_type: "human" | "robot";
  created_at: Date | string;
  updated_at: Date | string;
}
interface MemberRow extends Record<string, unknown> {
  contest_id: string;
  user_id: string;
  nickname: string;
  account_type: "human" | "robot";
  role: ContestMemberRecord["role"];
}

interface ContestProblemRow extends Record<string, unknown> {
  contest_id: string;
  position: number;
  problem_id: string;
  revision_id: string;
  revision: number;
  title: string;
  score: number;
  estimated_difficulty: number | null;
}

interface RiskRow extends Record<string, unknown> {
  contest_id: string;
  problem_id: string;
  user_id: string;
  nickname: string;
  account_type: "human" | "robot";
  first_accessed_at: Date | string;
  last_accessed_at: Date | string;
  total_active_seconds: string | number | bigint;
}

function parseDatabaseId(value: string): bigint | undefined {
  if (!/^(0|[1-9]\d*)$/.test(value)) {
    return undefined;
  }
  const parsed = BigInt(value);
  return parsed <= maximumDatabaseId ? parsed : undefined;
}

function requireDatabaseId(value: string, label: string): bigint {
  const parsed = parseDatabaseId(value);
  if (parsed === undefined) {
    throw new Error(`${label}不是有效的数据库编号。`);
  }
  return parsed;
}

function toIso(value: Date | string): string {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) {
    throw new Error("数据库返回了无效时间。");
  }
  return date.toISOString();
}

function nullableIso(value: Date | string | null): string | null {
  return value === null ? null : toIso(value);
}

function summary(id: string, nickname: string, accountType: "human" | "robot"): UserSummary {
  return { id, nickname, accountType };
}

export class DatabaseContestStore implements ContestStore {
  public constructor(private readonly handle: DatabaseHandle) {}

  public async listContests(): Promise<ContestRecord[]> {
    const ids = await this.handle.query<{ id: string }>(sql`
      SELECT id::text AS id
      FROM contests
      WHERE deleted_at IS NULL
      ORDER BY updated_at DESC, id DESC
    `);
    const contests = await Promise.all(ids.map((row) => this.getContest(row.id)));
    return contests.filter((contest): contest is ContestRecord => contest !== undefined);
  }

  public async getContest(contestId: string): Promise<ContestRecord | undefined> {
    const id = parseDatabaseId(contestId);
    if (id === undefined) {
      return undefined;
    }
    return this.loadContest(this.handle, id);
  }

  public async createContest(input: ContestWriteRecord): Promise<ContestRecord> {
    return this.handle.transaction(async (transaction) => {
      const inserted = await transaction.query<{ id: string }>(sql`
        INSERT INTO contests (
          title, description, state, starts_at, ends_at, created_by_user_id
        ) VALUES (
          ${input.title},
          ${input.description},
          ${input.state}::contest_state,
          ${input.startsAt}::timestamptz,
          ${input.endsAt}::timestamptz,
          ${requireDatabaseId(input.creator.id, "创建者编号")}
        )
        RETURNING id::text AS id
      `);
      const contestId = inserted[0]?.id;
      if (contestId === undefined) {
        throw new Error("数据库没有返回新组题方案的编号。");
      }
      const databaseContestId = requireDatabaseId(contestId, "组题方案编号");
      await this.writeMembersAndProblems(transaction, databaseContestId, input);
      const contest = await this.loadContest(transaction, databaseContestId);
      if (contest === undefined) {
        throw new Error("新组题方案写入后无法读取。");
      }
      return contest;
    });
  }

  public async replaceContest(
    contestId: string,
    input: ContestWriteRecord,
    expectedUpdatedAt: string
  ): Promise<ContestRecord | undefined> {
    const id = parseDatabaseId(contestId);
    if (id === undefined) {
      return undefined;
    }
    return this.handle.transaction(async (transaction) => {
      const updated = await transaction.query<{ id: string }>(sql`
        UPDATE contests
        SET title = ${input.title},
            description = ${input.description},
            state = ${input.state}::contest_state,
            starts_at = ${input.startsAt}::timestamptz,
            ends_at = ${input.endsAt}::timestamptz,
            updated_at = now()
        WHERE id = ${id}
          AND deleted_at IS NULL
          AND updated_at = ${expectedUpdatedAt}::timestamptz
        RETURNING id::text AS id
      `);
      if (updated.length === 0) {
        return undefined;
      }
      await transaction.execute(sql`DELETE FROM contest_members WHERE contest_id = ${id}`);
      await transaction.execute(sql`DELETE FROM contest_problems WHERE contest_id = ${id}`);
      await this.writeMembersAndProblems(transaction, id, input);
      return this.loadContest(transaction, id);
    });
  }

  public async recordProblemAccess(input: RecordProblemAccessInput): Promise<void> {
    const problemId = requireDatabaseId(input.problemId, "题目编号");
    const userId = requireDatabaseId(input.user.id, "用户编号");
    await this.handle.execute(sql`
      INSERT INTO problem_access_aggregates (
        problem_id,
        user_id,
        first_accessed_at,
        last_accessed_at,
        total_active_seconds,
        last_revision_id,
        updated_at
      )
      SELECT
        problem_record.id,
        ${userId},
        ${input.occurredAt}::timestamptz,
        ${input.occurredAt}::timestamptz,
        0,
        revision_record.id,
        ${input.occurredAt}::timestamptz
      FROM problems problem_record
      JOIN problem_revisions revision_record
        ON revision_record.problem_id = problem_record.id
       AND revision_record.revision = ${input.revision}
      WHERE problem_record.id = ${problemId} AND problem_record.deleted_at IS NULL
      ON CONFLICT (problem_id, user_id) DO UPDATE
      SET total_active_seconds = problem_access_aggregates.total_active_seconds + LEAST(
            ${input.activeSeconds}::bigint,
            GREATEST(
              0::bigint,
              floor(extract(epoch FROM (
                EXCLUDED.last_accessed_at - problem_access_aggregates.last_accessed_at
              )))::bigint
            )
          ),
          last_accessed_at = EXCLUDED.last_accessed_at,
          last_revision_id = EXCLUDED.last_revision_id,
          updated_at = EXCLUDED.updated_at
    `);
  }

  public async listProblemAccess(problemId: string): Promise<ProblemAccessRecord[]> {
    const id = parseDatabaseId(problemId);
    if (id === undefined) {
      return [];
    }
    const rows = await this.handle.query<{
      user_id: string;
      nickname: string;
      account_type: "human" | "robot";
      first_accessed_at: Date | string;
      last_accessed_at: Date | string;
      total_active_seconds: string | number | bigint;
      last_revision: number;
    }>(sql`
      SELECT
        access_record.user_id::text AS user_id,
        user_record.nickname,
        user_record.account_type,
        access_record.first_accessed_at,
        access_record.last_accessed_at,
        access_record.total_active_seconds,
        revision_record.revision AS last_revision
      FROM problem_access_aggregates access_record
      JOIN users user_record ON user_record.id = access_record.user_id
      JOIN problem_revisions revision_record ON revision_record.id = access_record.last_revision_id
      WHERE access_record.problem_id = ${id}
        AND user_record.account_type IN ('human', 'robot')
      ORDER BY access_record.last_accessed_at DESC, access_record.user_id
    `);
    return rows.map((row) => ({
      user: summary(row.user_id, row.nickname, row.account_type),
      firstAccessedAt: toIso(row.first_accessed_at),
      lastAccessedAt: toIso(row.last_accessed_at),
      totalActiveSeconds: Number(row.total_active_seconds),
      lastRevision: Number(row.last_revision)
    }));
  }

  private async writeMembersAndProblems(
    executor: DatabaseExecutor,
    contestId: bigint,
    input: ContestWriteRecord
  ): Promise<void> {
    for (const member of input.members) {
      await executor.execute(sql`
        INSERT INTO contest_members (
          contest_id, user_id, role, added_by_user_id
        ) VALUES (
          ${contestId},
          ${requireDatabaseId(member.user.id, "成员编号")},
          ${member.role}::contest_member_role,
          ${requireDatabaseId(input.creator.id, "创建者编号")}
        )
      `);
    }

    for (const [position, problem] of input.problems.entries()) {
      const revision = await executor.query<{ id: string }>(sql`
        SELECT revision_record.id::text AS id
        FROM problems problem_record
        JOIN problem_revisions revision_record
          ON revision_record.problem_id = problem_record.id
         AND revision_record.revision = ${problem.revision}
        WHERE problem_record.id = ${requireDatabaseId(problem.problemId, "题目编号")}
          AND problem_record.deleted_at IS NULL
        LIMIT 1
      `);
      const revisionId = revision[0]?.id;
      if (revisionId === undefined) {
        throw new Error(`题目 ${problem.problemId} 的指定修订不存在。`);
      }
      await executor.execute(sql`
        INSERT INTO contest_problems (
          contest_id,
          position,
          problem_id,
          revision_id,
          score,
          estimated_difficulty,
          leak_risk,
          added_by_user_id
        ) VALUES (
          ${contestId},
          ${position},
          ${requireDatabaseId(problem.problemId, "题目编号")},
          ${revisionId}::uuid,
          ${problem.score},
          ${problem.estimatedDifficulty},
          '{}'::jsonb,
          ${requireDatabaseId(input.creator.id, "创建者编号")}
        )
      `);
    }
  }

  private async loadContest(
    executor: DatabaseExecutor,
    contestId: bigint
  ): Promise<ContestRecord | undefined> {
    const contestRows = await executor.query<ContestRow>(sql`
      SELECT
        contest_record.id::text AS id,
        contest_record.title,
        contest_record.description,
        contest_record.state,
        contest_record.starts_at,
        contest_record.ends_at,
        creator.id::text AS creator_id,
        creator.nickname AS creator_nickname,
        creator.account_type AS creator_account_type,
        contest_record.created_at,
        contest_record.updated_at
      FROM contests contest_record
      JOIN users creator ON creator.id = contest_record.created_by_user_id
      WHERE contest_record.id = ${contestId}
        AND contest_record.deleted_at IS NULL
        AND creator.account_type IN ('human', 'robot')
      LIMIT 1
    `);
    const contest = contestRows[0];
    if (contest === undefined) {
      return undefined;
    }

    const [memberRows, problemRows, riskRows] = await Promise.all([
      executor.query<MemberRow>(sql`
        SELECT
          member.contest_id::text AS contest_id,
          user_record.id::text AS user_id,
          user_record.nickname,
          user_record.account_type,
          member.role
        FROM contest_members member
        JOIN users user_record ON user_record.id = member.user_id
        WHERE member.contest_id = ${contestId}
          AND user_record.account_type IN ('human', 'robot')
        ORDER BY member.role, user_record.nickname, user_record.id
      `),
      executor.query<ContestProblemRow>(sql`
        SELECT
          contest_problem.contest_id::text AS contest_id,
          contest_problem.position,
          contest_problem.problem_id::text AS problem_id,
          contest_problem.revision_id::text AS revision_id,
          revision_record.revision,
          revision_record.title,
          contest_problem.score,
          contest_problem.estimated_difficulty
        FROM contest_problems contest_problem
        JOIN problem_revisions revision_record ON revision_record.id = contest_problem.revision_id
        WHERE contest_problem.contest_id = ${contestId}
        ORDER BY contest_problem.position
      `),
      executor.query<RiskRow>(sql`
        SELECT
          contest_problem.contest_id::text AS contest_id,
          contest_problem.problem_id::text AS problem_id,
          user_record.id::text AS user_id,
          user_record.nickname,
          user_record.account_type,
          access_record.first_accessed_at,
          access_record.last_accessed_at,
          access_record.total_active_seconds
        FROM contest_problems contest_problem
        JOIN contest_members member
          ON member.contest_id = contest_problem.contest_id
         AND member.role = 'participant'
        JOIN problem_access_aggregates access_record
          ON access_record.problem_id = contest_problem.problem_id
         AND access_record.user_id = member.user_id
        JOIN users user_record ON user_record.id = member.user_id
        WHERE contest_problem.contest_id = ${contestId}
          AND user_record.account_type IN ('human', 'robot')
        ORDER BY contest_problem.position, access_record.last_accessed_at DESC
      `)
    ]);

    const risksByProblem = new Map<string, ContestRiskRecord[]>();
    for (const row of riskRows) {
      const entries = risksByProblem.get(row.problem_id) ?? [];
      entries.push({
        user: summary(row.user_id, row.nickname, row.account_type),
        firstAccessedAt: toIso(row.first_accessed_at),
        lastAccessedAt: toIso(row.last_accessed_at),
        totalActiveSeconds: Number(row.total_active_seconds)
      });
      risksByProblem.set(row.problem_id, entries);
    }

    const members: ContestMemberRecord[] = memberRows.map((row) => ({
      user: summary(row.user_id, row.nickname, row.account_type),
      role: row.role
    }));
    const problems: ContestProblemRecord[] = problemRows.map((row) => ({
      position: Number(row.position),
      problemId: row.problem_id,
      revisionId: row.revision_id,
      revision: Number(row.revision),
      title: row.title,
      score: Number(row.score),
      estimatedDifficulty:
        row.estimated_difficulty === null ? null : Number(row.estimated_difficulty),
      riskEntries: risksByProblem.get(row.problem_id) ?? []
    }));

    return {
      id: contest.id,
      title: contest.title,
      description: contest.description,
      state: contest.state,
      startsAt: nullableIso(contest.starts_at),
      endsAt: nullableIso(contest.ends_at),
      creator: summary(
        contest.creator_id,
        contest.creator_nickname,
        contest.creator_account_type
      ),
      members,
      problems,
      createdAt: toIso(contest.created_at),
      updatedAt: toIso(contest.updated_at)
    };
  }
}
