import { randomUUID } from "node:crypto";
import type { DatabaseExecutor } from "@urmotiv/database";
import type { ProblemTag, ReviewSuggestionField } from "@urmotiv/contracts";
import type {
  ProblemListFilters,
  StoredProblem,
  StoredReviewPolicy,
  StoredReview,
  StoredSession,
  StoredUser,
  VisibleProblemPage
} from "./domain";
import { canViewProblem, type ProblemVisibility } from "./permissions";
import { initialReviewPolicyRule } from "./review-decision";

/**
 * Runs after a new immutable problem revision has been written but before its
 * transaction commits. It is only used for metadata that must change with the
 * revision, such as a file association.
 */
export type ProblemRevisionAction = (
  revisionId: string,
  executor: DatabaseExecutor
) => Promise<void>;

export interface ReviewSuggestionAuditEvent {
  readonly actorUserId: string;
  readonly requestId: string;
  readonly problemId: string;
  readonly round: number;
  readonly previousRevision: number;
  readonly nextRevision: number;
  readonly fields: readonly ReviewSuggestionField[];
  readonly opinionCount: number;
}

export interface FrozenFieldEditAuditEvent {
  readonly actorUserId: string;
  readonly requestId: string;
  readonly problemId: string;
  readonly round: number;
  readonly previousRevision: number;
  readonly nextRevision: number;
  readonly fields: readonly ("basicStatement" | "basicSolution")[];
  readonly reason: string;
}

export interface ProblemTransaction {
  getProblem(): StoredProblem | undefined;
  /** 当前事务已在任何题目行之前取得共享锁的知识点目录版本。 */
  getTagCatalogVersion(): number;
  /**
   * Reloads one actor while locking every existing row that contributes to
   * authentication and authorization. Permission writers must take the same
   * user-row-first lock before changing memberships or grants.
   */
  lockUserForAuthorization(userId: string): Promise<StoredUser | undefined>;
  listUsers(): StoredUser[];
  listReviews(round: number): StoredReview[];
  hasTags(tagIds: readonly string[]): Promise<boolean>;
  upsertReview(review: StoredReview): void;
  replaceProblem(
    problem: StoredProblem,
    expectedRevision: number,
    changedByUserId?: string
  ): boolean;
  writeReviewSuggestionAudit(event: ReviewSuggestionAuditEvent): Promise<void>;
  writeFrozenFieldEditAudit(event: FrozenFieldEditAuditEvent): Promise<void>;
  /** Database-only hook: runs after opinion rows are durable in this transaction and before problem state writes. */
  afterReviewWrites?(action: (executor: DatabaseExecutor) => Promise<void>): void;
  /** Database transactions expose their executor only so related core stores can share it. */
  readonly executor?: DatabaseExecutor;
}

export interface DataStore {
  getUser(userId: string): Promise<StoredUser | undefined>;
  listUsers(): Promise<StoredUser[]>;
  findEmailCredential(normalizedEmail: string): Promise<EmailCredential | undefined>;
  registerEmailUser(input: EmailRegistration): Promise<StoredUser | undefined>;
  findPendingEmailVerification(normalizedEmail: string): Promise<EmailVerificationTarget | undefined>;
  replaceEmailVerificationToken(input: EmailVerificationToken): Promise<void>;
  consumeEmailVerificationToken(tokenDigest: string, now: string): Promise<string | undefined>;
  findOrCreateExternalUser(input: ExternalIdentity): Promise<StoredUser>;
  putLoginState(nonceDigest: string, expiresAt: string): Promise<void>;
  consumeLoginState(nonceDigest: string, now: string): Promise<boolean>;
  revokeUserSessions(userId: string): Promise<void>;
  createSession(userId: string, expiresAt: string): Promise<StoredSession>;
  getSession(sessionId: string): Promise<StoredSession | undefined>;
  deleteSession(sessionId: string): Promise<void>;
  listTags(): Promise<ProblemTag[]>;
  hasTags(tagIds: string[]): Promise<boolean>;
  createProblem(problem: StoredProblem): Promise<StoredProblem>;
  findVisibleProblem(problemId: string, visibility: ProblemVisibility): Promise<StoredProblem | undefined>;
  listVisibleProblems(
    filters: ProblemListFilters,
    visibility: ProblemVisibility
  ): Promise<VisibleProblemPage>;
  replaceProblem(
    problem: StoredProblem,
    expectedRevision: number,
    changedByUserId?: string
  ): Promise<boolean>;
  replaceProblemWithRevisionAction?(
    problem: StoredProblem,
    expectedRevision: number,
    changedByUserId: string | undefined,
    action: ProblemRevisionAction
  ): Promise<boolean>;
  listReviews(problemId: string, round: number): Promise<StoredReview[]>;
  getReviewPolicy(): Promise<StoredReviewPolicy>;
  replaceReviewPolicy(
    policy: StoredReviewPolicy,
    expectedRevision: number,
    actorUserId: string,
    requestId: string
  ): Promise<boolean>;
  runProblemTransaction<T>(
    problemId: string,
    operation: (transaction: ProblemTransaction) => T | Promise<T>
  ): Promise<T>;
}

export interface EmailCredential {
  readonly user: StoredUser;
  readonly passwordHash: string;
}

export interface EmailRegistration {
  readonly normalizedEmail: string;
  readonly displayEmail: string;
  readonly passwordHash: string;
  readonly nickname: string;
}

export interface EmailVerificationTarget {
  readonly userId: string;
  readonly normalizedEmail: string;
}

export interface EmailVerificationToken extends EmailVerificationTarget {
  readonly tokenDigest: string;
  readonly expiresAt: string;
}

export interface ExternalIdentity {
  readonly provider: string;
  readonly subject: string;
  readonly nickname: string;
  readonly email?: string;
  /** 认证来源返回的学号等用户标识；只用于历史资料匹配，不作为身份主键。 */
  readonly studentIds?: readonly { readonly attribute: string; readonly value: string }[];
}

function copy<T>(value: T): T {
  return structuredClone(value);
}

function sortProblems(problems: StoredProblem[], sort: ProblemListFilters["sort"]): StoredProblem[] {
  return problems.sort((left, right) => {
    if (sort === "updated_desc") {
      return right.updatedAt.localeCompare(left.updatedAt) || right.id.localeCompare(left.id);
    }

    if (sort === "updated_asc") {
      return left.updatedAt.localeCompare(right.updatedAt) || left.id.localeCompare(right.id);
    }

    if (left.codeforcesDifficulty === null && right.codeforcesDifficulty === null) {
      return left.id.localeCompare(right.id);
    }
    if (left.codeforcesDifficulty === null) {
      return 1;
    }
    if (right.codeforcesDifficulty === null) {
      return -1;
    }

    const leftDifficulty = left.codeforcesDifficulty;
    const rightDifficulty = right.codeforcesDifficulty;
    const direction = sort === "difficulty_asc" ? 1 : -1;
    return direction * (leftDifficulty - rightDifficulty) || left.id.localeCompare(right.id);
  });
}

export class InMemoryDataStore implements DataStore {
  private readonly users = new Map<string, StoredUser>();
  private readonly tags = new Map<string, ProblemTag>();
  private readonly sessions = new Map<string, StoredSession>();
  private readonly problems = new Map<string, StoredProblem>();
  private readonly reviews = new Map<string, StoredReview>();
  private readonly emailCredentials = new Map<string, { userId: string; passwordHash: string; verified: boolean }>();
  private readonly emailVerificationTokens = new Map<string, EmailVerificationToken & { consumed: boolean }>();
  private readonly externalIdentities = new Map<string, string>();
  private readonly loginStates = new Map<string, { expiresAt: string; consumed: boolean }>();
  private nextUserId = 1_000_000;
  private readonly problemLocks = new Map<string, Promise<void>>();
  private reviewPolicy: StoredReviewPolicy;

  public constructor(users: StoredUser[], tags: ProblemTag[]) {
    for (const user of users) {
      this.users.set(user.id, copy(user));
    }

    for (const tag of tags) {
      this.tags.set(tag.id, copy(tag));
    }
    const initialRule = initialReviewPolicyRule();
    this.reviewPolicy = {
      ...initialRule,
      revision: 1,
      updatedByUserId: null,
      updatedAt: new Date(0).toISOString()
    };
  }

  public async getUser(userId: string): Promise<StoredUser | undefined> {
    const user = this.users.get(userId);
    return user === undefined ? undefined : copy(user);
  }

  public async listUsers(): Promise<StoredUser[]> {
    return [...this.users.values()].map(copy);
  }

  public async findEmailCredential(normalizedEmail: string): Promise<EmailCredential | undefined> {
    const credential = this.emailCredentials.get(normalizedEmail);
    if (credential === undefined || !credential.verified) {
      return undefined;
    }
    const user = this.users.get(credential.userId);
    return user === undefined ? undefined : { user: copy(user), passwordHash: credential.passwordHash };
  }

  public async registerEmailUser(input: EmailRegistration): Promise<StoredUser | undefined> {
    if (this.emailCredentials.has(input.normalizedEmail)) {
      return undefined;
    }
    const user: StoredUser = {
      id: String(this.nextUserId++),
      nickname: input.nickname,
      accountType: "human",
      disabled: false,
      roles: ["投稿人"],
      grants: contributorGrants(),
      isRoot: false
    };
    this.users.set(user.id, copy(user));
    this.emailCredentials.set(input.normalizedEmail, {
      userId: user.id,
      passwordHash: input.passwordHash,
      verified: false
    });
    return copy(user);
  }

  public async findPendingEmailVerification(
    normalizedEmail: string
  ): Promise<EmailVerificationTarget | undefined> {
    const credential = this.emailCredentials.get(normalizedEmail);
    if (credential === undefined || credential.verified) {
      return undefined;
    }
    return { userId: credential.userId, normalizedEmail };
  }

  public async replaceEmailVerificationToken(input: EmailVerificationToken): Promise<void> {
    for (const [digest, token] of this.emailVerificationTokens) {
      if (token.userId === input.userId && token.normalizedEmail === input.normalizedEmail && !token.consumed) {
        this.emailVerificationTokens.delete(digest);
      }
    }
    this.emailVerificationTokens.set(input.tokenDigest, { ...copy(input), consumed: false });
  }

  public async consumeEmailVerificationToken(tokenDigest: string, now: string): Promise<string | undefined> {
    const token = this.emailVerificationTokens.get(tokenDigest);
    if (token === undefined || token.consumed || Date.parse(token.expiresAt) <= Date.parse(now)) {
      return undefined;
    }
    const credential = this.emailCredentials.get(token.normalizedEmail);
    if (credential === undefined || credential.userId !== token.userId) {
      return undefined;
    }
    token.consumed = true;
    credential.verified = true;
    return token.userId;
  }

  public async findOrCreateExternalUser(input: ExternalIdentity): Promise<StoredUser> {
    const key = `${input.provider}\u0000${input.subject}`;
    const existingId = this.externalIdentities.get(key);
    if (existingId !== undefined) {
      const existing = this.users.get(existingId);
      if (existing !== undefined) {
        return copy(existing);
      }
    }
    const user: StoredUser = {
      id: String(this.nextUserId++),
      nickname: input.nickname,
      accountType: "human",
      disabled: false,
      roles: ["投稿人"],
      grants: contributorGrants(),
      isRoot: false
    };
    this.users.set(user.id, copy(user));
    this.externalIdentities.set(key, user.id);
    return copy(user);
  }

  public async putLoginState(nonceDigest: string, expiresAt: string): Promise<void> {
    this.loginStates.set(nonceDigest, { expiresAt, consumed: false });
  }

  public async consumeLoginState(nonceDigest: string, now: string): Promise<boolean> {
    const state = this.loginStates.get(nonceDigest);
    if (state === undefined || state.consumed || Date.parse(state.expiresAt) <= Date.parse(now)) {
      return false;
    }
    state.consumed = true;
    return true;
  }

  public async revokeUserSessions(userId: string): Promise<void> {
    for (const [sessionId, session] of this.sessions) {
      if (session.userId === userId) {
        this.sessions.delete(sessionId);
      }
    }
  }

  public async createSession(userId: string, expiresAt: string): Promise<StoredSession> {
    const session: StoredSession = { id: randomUUID(), userId, expiresAt };
    this.sessions.set(session.id, session);
    return copy(session);
  }

  public async getSession(sessionId: string): Promise<StoredSession | undefined> {
    const session = this.sessions.get(sessionId);
    return session === undefined ? undefined : copy(session);
  }

  public async deleteSession(sessionId: string): Promise<void> {
    this.sessions.delete(sessionId);
  }

  public async listTags(): Promise<ProblemTag[]> {
    return [...this.tags.values()]
      .map(copy)
      .sort((left, right) => left.name.localeCompare(right.name));
  }

  public async hasTags(tagIds: string[]): Promise<boolean> {
    return tagIds.every((tagId) => {
      const tag = this.tags.get(tagId);
      return tag !== undefined && tag.active !== false;
    });
  }

  public async createProblem(problem: StoredProblem): Promise<StoredProblem> {
    this.problems.set(problem.id, copy(problem));
    return copy(problem);
  }

  public async findVisibleProblem(
    problemId: string,
    visibility: ProblemVisibility
  ): Promise<StoredProblem | undefined> {
    const problem = this.problems.get(problemId);
    if (problem === undefined || !canViewProblem(visibility, problem)) {
      return undefined;
    }

    return copy(problem);
  }

  public async listVisibleProblems(
    filters: ProblemListFilters,
    visibility: ProblemVisibility
  ): Promise<VisibleProblemPage> {
    const search = filters.search.toLocaleLowerCase();
    const visible = [...this.problems.values()].filter((problem) => {
      if (!canViewProblem(visibility, problem)) {
        return false;
      }

      if (filters.owner === "me" && problem.ownerId !== visibility.viewerId) {
        return false;
      }

      if (filters.status !== undefined && problem.status !== filters.status) {
        return false;
      }

      if (filters.type !== undefined && problem.type !== filters.type) {
        return false;
      }

      return search.length === 0 || problem.title.toLocaleLowerCase().includes(search);
    });
    const total = visible.length;
    const start = (filters.page - 1) * filters.pageSize;
    const items = sortProblems(visible, filters.sort).slice(start, start + filters.pageSize).map(copy);
    return { items, total };
  }

  public async replaceProblem(
    problem: StoredProblem,
    expectedRevision: number,
    _changedByUserId?: string
  ): Promise<boolean> {
    return this.withProblemLock(problem.id, () => {
      const existing = this.problems.get(problem.id);
      if (existing === undefined || existing.revision !== expectedRevision) {
        return false;
      }

      this.problems.set(problem.id, copy(problem));
      return true;
    });
  }

  public async listReviews(problemId: string, round: number): Promise<StoredReview[]> {
    return [...this.reviews.values()]
      .filter((review) => review.problemId === problemId && review.expectedRound === round)
      .map(copy)
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  }

  public async getReviewPolicy(): Promise<StoredReviewPolicy> {
    return copy(this.reviewPolicy);
  }

  public async replaceReviewPolicy(
    policy: StoredReviewPolicy,
    expectedRevision: number,
    _actorUserId: string,
    _requestId: string
  ): Promise<boolean> {
    if (
      this.reviewPolicy.revision !== expectedRevision ||
      policy.revision !== expectedRevision + 1
    ) {
      return false;
    }
    this.reviewPolicy = copy(policy);
    return true;
  }

  public async runProblemTransaction<T>(
    problemId: string,
    operation: (transaction: ProblemTransaction) => T | Promise<T>
  ): Promise<T> {
    return this.withProblemLock(problemId, async () => {
      let problem = this.problems.get(problemId);
      problem = problem === undefined ? undefined : copy(problem);
      const users = [...this.users.values()].map(copy);
      const reviews = new Map(
        [...this.reviews.entries()]
          .filter(([, review]) => review.problemId === problemId)
          .map(([key, review]) => [key, copy(review)] as const)
      );

      const transaction: ProblemTransaction = {
        getProblem: () => (problem === undefined ? undefined : copy(problem)),
        getTagCatalogVersion: () => 1,
        lockUserForAuthorization: async (userId) => {
          const lockedUser = this.users.get(userId);
          return lockedUser === undefined ? undefined : copy(lockedUser);
        },
        listUsers: () => users.map(copy),
        listReviews: (round) =>
          [...reviews.values()]
            .filter((review) => review.expectedRound === round)
            .map(copy)
            .sort((left, right) => left.createdAt.localeCompare(right.createdAt)),
        hasTags: async (tagIds) =>
          tagIds.every((tagId) => {
            const tag = this.tags.get(tagId);
            return tag !== undefined && tag.active !== false;
          }),
        upsertReview: (review) => {
          if (review.problemId !== problemId) {
            throw new Error("审核意见与当前题目不匹配。");
          }
          const key = `${review.problemId}:${review.expectedRound}:${review.reviewerId}`;
          reviews.set(key, copy(review));
        },
        replaceProblem: (nextProblem, expectedRevision, _changedByUserId) => {
          if (
            problem === undefined ||
            nextProblem.id !== problemId ||
            problem.revision !== expectedRevision
          ) {
            return false;
          }
          problem = copy(nextProblem);
          return true;
        },
        writeReviewSuggestionAudit: async () => undefined,
        writeFrozenFieldEditAudit: async () => undefined
      };

      const result = await operation(transaction);
      if (problem !== undefined) {
        this.problems.set(problemId, copy(problem));
      }
      for (const [key, review] of this.reviews) {
        if (review.problemId === problemId) {
          this.reviews.delete(key);
        }
      }
      for (const [key, review] of reviews) {
        this.reviews.set(key, copy(review));
      }
      return result;
    });
  }

  private async withProblemLock<T>(problemId: string, operation: () => T | Promise<T>): Promise<T> {
    const previous = this.problemLocks.get(problemId) ?? Promise.resolve();
    let release = (): void => {};
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.then(() => current);
    this.problemLocks.set(problemId, tail);
    await previous;

    try {
      return await operation();
    } finally {
      release();
      if (this.problemLocks.get(problemId) === tail) {
        this.problemLocks.delete(problemId);
      }
    }
  }
}

function contributorGrants(): StoredUser["grants"] {
  return [
    "auth.login",
    "problem.create",
    "problem.view.own",
    "problem.edit.own",
    "problem.delete.own"
  ].map((permission) => ({ permission, effect: "allow" as const, scope: permission.endsWith(".own") ? "own" as const : "global" as const }));
}
