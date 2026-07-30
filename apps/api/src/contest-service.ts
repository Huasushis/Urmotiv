import type {
  Contest,
  ContestListItem,
  ContestListResponse,
  ContestProblemInput,
  CreateContestInput,
  ProblemAccessListResponse,
  UpdateContestInput,
  UserSummary
} from "@urmotiv/contracts";
import { ApiError, conflict, forbidden, notFound } from "./errors";
import type { StoredProblem, StoredUser } from "./domain";
import { canEditContest, createProblemVisibility, hasPermission } from "./permissions";
import type { DataStore } from "./repository";
import type {
  ContestMemberRecord,
  ContestProblemSnapshot,
  ContestRecord,
  ContestStore,
  ContestWriteRecord
} from "./contest-store";

export interface ContestServiceOptions {
  readonly now?: () => Date;
}

function userSummary(user: StoredUser): UserSummary {
  return { id: user.id, nickname: user.nickname, accountType: user.accountType };
}

function contestTarget(contest: ContestRecord): { id: string; creatorId: string } {
  return { id: contest.id, creatorId: contest.creator.id };
}

export class ContestService {
  private readonly now: () => Date;

  public constructor(
    private readonly problemStore: DataStore,
    private readonly contestStore: ContestStore,
    options: ContestServiceOptions = {}
  ) {
    this.now = options.now ?? (() => new Date());
  }

  public async listContests(user: StoredUser): Promise<ContestListResponse> {
    const contests = (await this.contestStore.listContests()).filter((contest) =>
      canEditContest(user, contestTarget(contest), this.now())
    );
    return { items: contests.map((contest) => this.toListItem(contest, user)) };
  }

  public async getContest(user: StoredUser, contestId: string): Promise<Contest> {
    const contest = await this.requireVisibleContest(user, contestId);
    return this.toContest(contest, user);
  }

  public async createContest(user: StoredUser, input: CreateContestInput): Promise<Contest> {
    if (!hasPermission(user, "contest.create", {}, this.now())) {
      throw forbidden();
    }
    const writeRecord = await this.resolveWriteRecord(user, input, "draft");
    const created = await this.contestStore.createContest(writeRecord);
    return this.toContest(created, user);
  }

  public async updateContest(
    user: StoredUser,
    contestId: string,
    input: UpdateContestInput
  ): Promise<Contest> {
    const current = await this.requireVisibleContest(user, contestId);
    if (current.state === "archived") {
      throw conflict("已归档的组题方案不能继续修改。");
    }

    const changesLockedContent =
      input.title !== undefined ||
      input.description !== undefined ||
      input.startsAt !== undefined ||
      input.endsAt !== undefined ||
      input.members !== undefined ||
      input.problems !== undefined;
    if (current.state === "locked" && (changesLockedContent || input.state !== "archived")) {
      throw conflict("组题方案锁定后只能归档，不能更换题目、成员或比赛信息。");
    }

    const mergedMembers = input.members ?? current.members.map((member) => ({
      userId: member.user.id,
      role: member.role
    }));
    const mergedProblems = input.problems ?? current.problems.map((problem) => ({
      problemId: problem.problemId,
      score: problem.score,
      estimatedDifficulty: problem.estimatedDifficulty
    }));
    const writeRecord = await this.resolveWriteRecord(
      user,
      {
        title: input.title ?? current.title,
        description: input.description ?? current.description,
        startsAt: input.startsAt === undefined ? current.startsAt : input.startsAt,
        endsAt: input.endsAt === undefined ? current.endsAt : input.endsAt,
        members: mergedMembers,
        problems: mergedProblems
      },
      input.state ?? current.state,
      input.problems === undefined ? current : undefined
    );
    const updated = await this.contestStore.replaceContest(
      contestId,
      writeRecord,
      input.expectedUpdatedAt
    );
    if (updated === undefined) {
      throw conflict("组题方案已被其他操作修改，请刷新后重试。");
    }
    return this.toContest(updated, user);
  }

  public async recordProblemAccess(
    user: StoredUser,
    problemId: string,
    activeSeconds: number
  ): Promise<void> {
    const problem = await this.findVisibleProblem(user, problemId);
    await this.contestStore.recordProblemAccess({
      problemId,
      revision: problem.revision,
      user: userSummary(user),
      activeSeconds,
      occurredAt: this.now().toISOString()
    });
  }

  public async listProblemAccess(
    user: StoredUser,
    problemId: string
  ): Promise<ProblemAccessListResponse> {
    const problem = await this.findVisibleProblem(user, problemId);
    if (
      !hasPermission(
        user,
        "problem.viewers.read",
        { ownerId: problem.ownerId, objectId: problem.id },
        this.now()
      )
    ) {
      throw forbidden();
    }
    return { items: await this.contestStore.listProblemAccess(problemId) };
  }

  private async requireVisibleContest(user: StoredUser, contestId: string): Promise<ContestRecord> {
    const contest = await this.contestStore.getContest(contestId);
    if (
      contest === undefined ||
      !canEditContest(user, contestTarget(contest), this.now())
    ) {
      throw notFound();
    }
    return contest;
  }

  private async resolveWriteRecord(
    user: StoredUser,
    input: Omit<CreateContestInput, never>,
    state: ContestRecord["state"],
    fixedProblems?: ContestRecord
  ): Promise<ContestWriteRecord> {
    const users = await this.problemStore.listUsers();
    const usersById = new Map(users.map((candidate) => [candidate.id, candidate]));
    const memberIds = new Set<string>();
    const members: ContestMemberRecord[] = [];
    for (const member of input.members) {
      if (memberIds.has(member.userId)) {
        throw new ApiError(422, "DUPLICATE_CONTEST_MEMBER", "参赛者或管理员不能重复添加。", {
          members: ["请移除重复的成员。"]
        });
      }
      memberIds.add(member.userId);
      const candidate = usersById.get(member.userId);
      if (candidate === undefined || candidate.disabled) {
        throw new ApiError(422, "INVALID_CONTEST_MEMBER", "成员列表中包含不存在或已停用的账号。", {
          members: ["请选择仍可使用的账号。"]
        });
      }
      if (member.role === "participant" && candidate.accountType === "robot") {
        throw new ApiError(422, "ROBOT_CONTEST_PARTICIPANT", "机器人账号不能作为比赛参与者。", {
          members: ["请移除机器人账号。"]
        });
      }
      members.push({ user: userSummary(candidate), role: member.role });
    }
    const existingCreator = members.find((member) => member.user.id === user.id);
    if (existingCreator === undefined) {
      members.push({ user: userSummary(user), role: "manager" });
    } else if (existingCreator.role !== "manager") {
      members[members.indexOf(existingCreator)] = { ...existingCreator, role: "manager" };
    }

    const problemIds = new Set<string>();
    const problems: ContestProblemSnapshot[] = [];
    for (const problemInput of input.problems) {
      if (problemIds.has(problemInput.problemId)) {
        throw new ApiError(422, "DUPLICATE_CONTEST_PROBLEM", "同一道题不能在一个方案中重复出现。", {
          problems: ["请移除重复题目。"]
        });
      }
      problemIds.add(problemInput.problemId);
      const fixed = fixedProblems?.problems.find(
        (problem) => problem.problemId === problemInput.problemId
      );
      if (fixed !== undefined) {
        problems.push({
          problemId: fixed.problemId,
          revision: fixed.revision,
          title: fixed.title,
          score: problemInput.score,
          estimatedDifficulty: problemInput.estimatedDifficulty
        });
        continue;
      }
      const problem = await this.findVisibleProblem(user, problemInput.problemId);
      if (problem.status !== "approved") {
        throw new ApiError(422, "CONTEST_PROBLEM_NOT_APPROVED", "组题只能选择已经审核通过的题目。", {
          problems: [`题目 ${problemInput.problemId} 尚未审核通过。`]
        });
      }
      problems.push(this.problemSnapshot(problemInput, problem));
    }

    return {
      title: input.title,
      description: input.description,
      state,
      startsAt: input.startsAt,
      endsAt: input.endsAt,
      creator: userSummary(user),
      members,
      problems
    };
  }

  private problemSnapshot(
    input: ContestProblemInput,
    problem: StoredProblem
  ): ContestProblemSnapshot {
    return {
      problemId: problem.id,
      revision: problem.revision,
      title: problem.title,
      score: input.score,
      estimatedDifficulty: input.estimatedDifficulty
    };
  }

  private async findVisibleProblem(user: StoredUser, problemId: string): Promise<StoredProblem> {
    const problem = await this.problemStore.findVisibleProblem(
      problemId,
      createProblemVisibility(user, this.now())
    );
    if (problem === undefined) {
      throw notFound();
    }
    return problem;
  }

  private capabilities(contest: ContestRecord, user: StoredUser) {
    const target = { ownerId: contest.creator.id, objectId: contest.id };
    return {
      canEdit: contest.state !== "archived" && canEditContest(user, contestTarget(contest), this.now()),
      canDelete: hasPermission(user, "contest.delete", target, this.now()),
      canExport: hasPermission(user, "contest.export", target, this.now()),
      canReadRisk: hasPermission(user, "contest.risk.read", target, this.now())
    };
  }

  private toContest(contest: ContestRecord, user: StoredUser): Contest {
    const capabilities = this.capabilities(contest, user);
    return {
      ...contest,
      problems: contest.problems.map((problem) => ({
        position: problem.position,
        problemId: problem.problemId,
        revisionId: problem.revisionId,
        revision: problem.revision,
        title: problem.title,
        score: problem.score,
        estimatedDifficulty: problem.estimatedDifficulty,
        leakRiskCount: capabilities.canReadRisk ? problem.riskEntries.length : 0,
        leakRiskEntries: capabilities.canReadRisk ? problem.riskEntries : []
      })),
      capabilities
    };
  }

  private toListItem(contest: ContestRecord, user: StoredUser): ContestListItem {
    const capabilities = this.capabilities(contest, user);
    return {
      id: contest.id,
      title: contest.title,
      state: contest.state,
      startsAt: contest.startsAt,
      endsAt: contest.endsAt,
      creator: contest.creator,
      problemCount: contest.problems.length,
      participantCount: contest.members.filter((member) => member.role === "participant").length,
      leakRiskCount: capabilities.canReadRisk
        ? contest.problems.reduce((sum, problem) => sum + problem.riskEntries.length, 0)
        : 0,
      createdAt: contest.createdAt,
      updatedAt: contest.updatedAt,
      capabilities
    };
  }
}
