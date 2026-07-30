import { randomUUID } from "node:crypto";
import type {
  ContestMemberRole,
  ContestState,
  ProblemAccessRecord,
  UserSummary
} from "@urmotiv/contracts";

export interface ContestMemberRecord {
  readonly user: UserSummary;
  readonly role: ContestMemberRole;
}

export interface ContestRiskRecord {
  readonly user: UserSummary;
  readonly firstAccessedAt: string;
  readonly lastAccessedAt: string;
  readonly totalActiveSeconds: number;
}

export interface ContestProblemRecord {
  readonly position: number;
  readonly problemId: string;
  readonly revisionId: string;
  readonly revision: number;
  readonly title: string;
  readonly score: number;
  readonly estimatedDifficulty: number | null;
  readonly riskEntries: ContestRiskRecord[];
}

export interface ContestRecord {
  readonly id: string;
  readonly title: string;
  readonly description: string;
  readonly state: ContestState;
  readonly startsAt: string | null;
  readonly endsAt: string | null;
  readonly creator: UserSummary;
  readonly members: ContestMemberRecord[];
  readonly problems: ContestProblemRecord[];
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface ContestProblemSnapshot {
  readonly problemId: string;
  readonly revision: number;
  readonly title: string;
  readonly score: number;
  readonly estimatedDifficulty: number | null;
}

export interface ContestWriteRecord {
  readonly title: string;
  readonly description: string;
  readonly state: ContestState;
  readonly startsAt: string | null;
  readonly endsAt: string | null;
  readonly creator: UserSummary;
  readonly members: ContestMemberRecord[];
  readonly problems: ContestProblemSnapshot[];
}

export interface RecordProblemAccessInput {
  readonly problemId: string;
  readonly revision: number;
  readonly user: UserSummary;
  readonly activeSeconds: number;
  readonly occurredAt: string;
}

export interface ContestStore {
  listContests(): Promise<ContestRecord[]>;
  getContest(contestId: string): Promise<ContestRecord | undefined>;
  createContest(input: ContestWriteRecord): Promise<ContestRecord>;
  replaceContest(
    contestId: string,
    input: ContestWriteRecord,
    expectedUpdatedAt: string
  ): Promise<ContestRecord | undefined>;
  recordProblemAccess(input: RecordProblemAccessInput): Promise<void>;
  listProblemAccess(problemId: string): Promise<ProblemAccessRecord[]>;
}

interface MemoryAccessRecord extends ProblemAccessRecord {
  user: UserSummary;
}

function copy<T>(value: T): T {
  return structuredClone(value);
}

function nextIso(previous: string, now: Date): string {
  const previousTime = Date.parse(previous);
  const currentTime = now.getTime();
  return new Date(currentTime > previousTime ? currentTime : previousTime + 1).toISOString();
}

export class InMemoryContestStore implements ContestStore {
  private readonly contests = new Map<string, ContestRecord>();
  private readonly accessRecords = new Map<string, MemoryAccessRecord>();
  private nextContestId = 1;

  public async listContests(): Promise<ContestRecord[]> {
    return [...this.contests.values()]
      .map((contest) => this.withCurrentRisk(contest))
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  }

  public async getContest(contestId: string): Promise<ContestRecord | undefined> {
    const contest = this.contests.get(contestId);
    return contest === undefined ? undefined : this.withCurrentRisk(contest);
  }

  public async createContest(input: ContestWriteRecord): Promise<ContestRecord> {
    const now = new Date().toISOString();
    const contest = this.fromWriteRecord(String(this.nextContestId++), input, now, now);
    this.contests.set(contest.id, contest);
    return this.withCurrentRisk(contest);
  }

  public async replaceContest(
    contestId: string,
    input: ContestWriteRecord,
    expectedUpdatedAt: string
  ): Promise<ContestRecord | undefined> {
    const existing = this.contests.get(contestId);
    if (existing === undefined || existing.updatedAt !== expectedUpdatedAt) {
      return undefined;
    }
    const updatedAt = nextIso(existing.updatedAt, new Date());
    const contest = this.fromWriteRecord(
      contestId,
      input,
      existing.createdAt,
      updatedAt,
      existing
    );
    this.contests.set(contestId, contest);
    return this.withCurrentRisk(contest);
  }

  public async recordProblemAccess(input: RecordProblemAccessInput): Promise<void> {
    const key = `${input.problemId}:${input.user.id}`;
    const existing = this.accessRecords.get(key);
    if (existing === undefined) {
      this.accessRecords.set(key, {
        user: copy(input.user),
        firstAccessedAt: input.occurredAt,
        lastAccessedAt: input.occurredAt,
        totalActiveSeconds: 0,
        lastRevision: input.revision
      });
      return;
    }

    const elapsedSeconds = Math.max(
      0,
      Math.floor((Date.parse(input.occurredAt) - Date.parse(existing.lastAccessedAt)) / 1_000)
    );
    existing.totalActiveSeconds += Math.min(input.activeSeconds, elapsedSeconds);
    existing.lastAccessedAt = input.occurredAt;
    existing.lastRevision = input.revision;
  }

  public async listProblemAccess(problemId: string): Promise<ProblemAccessRecord[]> {
    const prefix = `${problemId}:`;
    return [...this.accessRecords.entries()]
      .filter(([key]) => key.startsWith(prefix))
      .map(([, record]) => copy(record))
      .sort((left, right) => right.lastAccessedAt.localeCompare(left.lastAccessedAt));
  }

  private fromWriteRecord(
    id: string,
    input: ContestWriteRecord,
    createdAt: string,
    updatedAt: string,
    previous?: ContestRecord
  ): ContestRecord {
    return {
      id,
      title: input.title,
      description: input.description,
      state: input.state,
      startsAt: input.startsAt,
      endsAt: input.endsAt,
      creator: copy(input.creator),
      members: copy(input.members),
      problems: input.problems.map((problem, position) => ({
        ...copy(problem),
        position,
        revisionId:
          previous?.problems.find(
            (existing) =>
              existing.problemId === problem.problemId &&
              existing.revision === problem.revision
          )?.revisionId ?? randomUUID(),
        riskEntries: []
      })),
      createdAt,
      updatedAt
    };
  }

  private withCurrentRisk(contest: ContestRecord): ContestRecord {
    const participantIds = new Set(
      contest.members
        .filter((member) => member.role === "participant")
        .map((member) => member.user.id)
    );
    return {
      ...copy(contest),
      problems: contest.problems.map((problem) => ({
        ...copy(problem),
        riskEntries: [...this.accessRecords.values()]
          .filter(
            (record) =>
              participantIds.has(record.user.id) &&
              this.accessRecords.get(`${problem.problemId}:${record.user.id}`) === record
          )
          .map((record) => ({
            user: copy(record.user),
            firstAccessedAt: record.firstAccessedAt,
            lastAccessedAt: record.lastAccessedAt,
            totalActiveSeconds: record.totalActiveSeconds
          }))
      }))
    };
  }
}
