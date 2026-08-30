import { randomUUID } from "node:crypto";
import { builtinRoleDefinitions, type DatabaseExecutor } from "@urmotiv/database";
import type { CorePermission, PermissionGrant, ProblemTag, ReviewSuggestionField } from "@urmotiv/contracts";
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
import {
  BatchAccountConflictError,
  normalizeUsernameKey,
  type HashedBatchAccount
} from "./batch-account";
import type { BatchAccountAuditEvent, BatchAccountAuditWriter } from "./account-audit";
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
  getPrimaryEmail(userId: string): Promise<{ readonly address: string; readonly verified: boolean } | undefined>;
  listUserIdentifiers(
    userId: string
  ): Promise<readonly { readonly attribute: string; readonly value: string }[]>;
  updateUserProfile(
    userId: string,
    patch: {
      readonly nickname?: string;
      readonly qq?: string | null;
      readonly avatarSource?: "none" | "qq" | "uploaded";
    }
  ): Promise<StoredUser | undefined>;
  setUserAvatar(
    userId: string,
    mediaType: string,
    content: Uint8Array
  ): Promise<StoredUser | undefined>;
  getUserAvatar(
    userId: string
  ): Promise<{ readonly mediaType: string; readonly content: Uint8Array; readonly updatedAt: string } | undefined>;
  clearUserAvatar(userId: string): Promise<StoredUser | undefined>;
  findRootCredential(): Promise<RootCredential | undefined>;
  findUsernameCredential(username: string): Promise<EmailCredential | undefined>;
  findEmailCredential(normalizedEmail: string): Promise<EmailCredential | undefined>;
  getUserPermissionDelta(userId: string): Promise<UserPermissionDelta>;
  replaceUserPermissionDelta(input: ReplaceUserPermissionDeltaInput): Promise<UserPermissionDelta>;
  replaceUserPermissionDeltaAtomic(input: UserPermissionDeltaAtomicInput): Promise<UserPermissionDelta>;
  setDefaultRoleKeys?(keys: { readonly humanRoleKey: string; readonly robotRoleKey: string }): void;
  registerEmailUser(input: EmailRegistration): Promise<StoredUser | undefined>;
  createEmailUsersBatch(
    input: BatchAccountCreationInput,
    auditWriter?: BatchAccountAuditWriter
  ): Promise<BatchAccountCreationResult>;
  findPendingEmailVerification(normalizedEmail: string): Promise<EmailVerificationTarget | undefined>;
  replaceEmailVerificationToken(input: EmailVerificationToken): Promise<void>;
  consumeEmailVerificationToken(tokenDigest: string, now: string): Promise<string | undefined>;
  hasExternalIdentity(provider: string, subject: string): Promise<boolean>;
  findOrCreateExternalUser(input: ExternalIdentity): Promise<StoredUser>;
  putLoginState(nonceDigest: string, expiresAt: string): Promise<void>;
  consumeLoginState(nonceDigest: string, now: string): Promise<boolean>;
  revokeUserSessions(userId: string): Promise<void>;
  createSession(
    userId: string,
    expiresAt: string,
    impersonatorUserId?: string | null
  ): Promise<StoredSession>;
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
  /** 就绪检查：确认持久化后端可达；不可达时抛出异常。 */
  ping?(): Promise<void>;
}

export interface UserPermissionDelta {
  readonly userId: string;
  readonly allows: readonly CorePermission[];
  readonly denies: readonly CorePermission[];
  readonly revision: number;
}

export interface ReplaceUserPermissionDeltaInput {
  readonly userId: string;
  readonly expectedRevision: number;
  readonly allows: readonly CorePermission[];
  readonly denies: readonly CorePermission[];
  readonly actorUserId: string;
  readonly requestId: string;
}
export interface UserPermissionDeltaAtomicInput extends ReplaceUserPermissionDeltaInput {
  readonly authorizationUserId: string;
  readonly authorizeActor: (actor: StoredUser, target: StoredUser) => void | Promise<void>;
  readonly writeAudit: (executor: DatabaseExecutor | undefined) => Promise<void>;
}

export interface RootCredential {
  readonly user: StoredUser;
  readonly passwordHash: string;
}
export type EmailCredential = RootCredential;

export interface EmailRegistration {
  readonly normalizedEmail: string;
  readonly displayEmail: string;
  readonly passwordHash: string;
  readonly nickname: string;
}

export interface BatchAccountCreationInput {
  readonly actorUserId: string;
  readonly effectiveUserId?: string;
  readonly requestId: string;
  readonly accounts: readonly HashedBatchAccount[];
}

export interface BatchAccountCreationResult {
  readonly createdCount: number;
  readonly totalCount: number;
}

export interface EmailVerificationTarget {
  readonly userId: string;
  readonly normalizedEmail: string;
}

export interface EmailVerificationToken extends EmailVerificationTarget {
  readonly tokenDigest: string;
  readonly expiresAt: string;
}
export class ExternalIdentityCollisionError extends Error {
  public constructor() {
    super("外部身份资料与现有账号绑定冲突。");
    this.name = "ExternalIdentityCollisionError";
  }
}


export interface ExternalIdentity {
  readonly provider: string;
  readonly subject: string;
  readonly nickname: string;
  readonly username?: string;
  readonly realName?: string;
  readonly email?: string;
  /** OAuth2 使用严格模式：学工号、邮箱或同一 subject 的用户名冲突一律失败。 */
  readonly strictReconciliation?: boolean;
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
  private readonly baselineGrants = new Map<string, PermissionGrant[]>();
  private readonly permissionDeltas = new Map<string, UserPermissionDelta>();
  private permissionDeltaTransactionQueue: Promise<void> = Promise.resolve();
  private readonly tags = new Map<string, ProblemTag>();
  private readonly sessions = new Map<string, StoredSession>();
  private readonly problems = new Map<string, StoredProblem>();
  private readonly reviews = new Map<string, StoredReview>();
  private readonly emailCredentials = new Map<string, { userId: string; passwordHash: string; verified: boolean }>();
  private readonly externalIdentities = new Map<string, string>();
  private readonly emailVerificationTokens = new Map<string, EmailVerificationToken & { consumed: boolean }>();
  private defaultRoleKeys = { humanRoleKey: "contributor", robotRoleKey: "reviewer" };
  private readonly rootPasswordHash: string | undefined;
  private readonly loginStates = new Map<string, { expiresAt: string; consumed: boolean }>();
  private readonly primaryEmails = new Map<string, { address: string; verified: boolean }>();
  public readonly batchAccountAuditEvents: BatchAccountAuditEvent[] = [];
  private readonly userIdentifiers = new Map<
    string,
    readonly { attribute: string; value: string }[]
  >();
  private readonly avatarContents = new Map<
    string,
    { mediaType: string; content: Uint8Array; updatedAt: string }
  >();
  private nextUserId = 1_000_000;
  private readonly problemLocks = new Map<string, Promise<void>>();
  private reviewPolicy: StoredReviewPolicy;

  /** 内存后端总是可达。 */
  public async ping(): Promise<void> {
    return undefined;
  }

  public constructor(
    users: StoredUser[],
    tags: ProblemTag[],
    options: { readonly rootPasswordHash?: string } = {}
  ) {
    this.rootPasswordHash = options.rootPasswordHash;
    for (const user of users) {
      const stored = copy(user);
      this.users.set(user.id, stored);
      this.baselineGrants.set(user.id, copy(stored.grants));
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
  private defaultRoleKey(accountType: "human" | "robot"): string {
    return accountType === "human" ? this.defaultRoleKeys.humanRoleKey : this.defaultRoleKeys.robotRoleKey;
  }

  private defaultRoleDefinition(accountType: "human" | "robot") {
    const key = this.defaultRoleKey(accountType);
    return builtinRoleDefinitions.find((role) => role.key === key);
  }

  private defaultRoleGrants(accountType: "human" | "robot"): StoredUser["grants"] {
    const role = this.defaultRoleDefinition(accountType);
    return role === undefined
      ? contributorGrants()
      : role.permissions.map((permission) => ({
          permission,
          effect: "allow" as const,
          scope: permission.endsWith(".own") ? "own" as const : "global" as const
        }));
  }

  public async getUser(userId: string): Promise<StoredUser | undefined> {
    const user = this.users.get(userId);
    return user === undefined ? undefined : copy(user);
  }

  public async listUsers(): Promise<StoredUser[]> {
    return [...this.users.values()].map(copy);
  }

  public async getPrimaryEmail(
    userId: string
  ): Promise<{ readonly address: string; readonly verified: boolean } | undefined> {
    const entry = this.primaryEmails.get(userId);
    return entry === undefined ? undefined : { ...entry };
  }

  public async listUserIdentifiers(
    userId: string
  ): Promise<readonly { readonly attribute: string; readonly value: string }[]> {
    return (this.userIdentifiers.get(userId) ?? []).map(copy);
  }

  public async updateUserProfile(
    userId: string,
    patch: {
      readonly nickname?: string;
      readonly qq?: string | null;
      readonly avatarSource?: "none" | "qq" | "uploaded";
    }
  ): Promise<StoredUser | undefined> {
    const user = this.users.get(userId);
    if (user === undefined) {
      return undefined;
    }
    if (patch.nickname !== undefined) {
      user.nickname = patch.nickname;
    }
    if (patch.qq !== undefined) {
      user.qq = patch.qq;
    }
    if (patch.avatarSource !== undefined) {
      user.avatarSource = patch.avatarSource;
      if (patch.avatarSource !== "uploaded") {
        this.avatarContents.delete(userId);
      }
    }
    return copy(user);
  }

  public async setUserAvatar(
    userId: string,
    mediaType: string,
    content: Uint8Array
  ): Promise<StoredUser | undefined> {
    const user = this.users.get(userId);
    if (user === undefined) {
      return undefined;
    }
    this.avatarContents.set(userId, {
      mediaType,
      content: copy(content),
      updatedAt: new Date().toISOString()
    });
    user.avatarSource = "uploaded";
    return copy(user);
  }

  public async getUserAvatar(
    userId: string
  ): Promise<{ readonly mediaType: string; readonly content: Uint8Array; readonly updatedAt: string } | undefined> {
    const entry = this.avatarContents.get(userId);
    return entry === undefined ? undefined : { ...entry, content: copy(entry.content) };
  }

  public async clearUserAvatar(userId: string): Promise<StoredUser | undefined> {
    const user = this.users.get(userId);
    if (user === undefined) {
      return undefined;
    }
    this.avatarContents.delete(userId);
    user.avatarSource = "none";
    return copy(user);
  }

  public async findEmailCredential(normalizedEmail: string): Promise<EmailCredential | undefined> {
    const credential = this.emailCredentials.get(normalizedEmail);
    if (credential === undefined || !credential.verified) {
      return undefined;
    }
    const user = this.users.get(credential.userId);
    return user === undefined ? undefined : { user: copy(user), passwordHash: credential.passwordHash };
  }
  public async findRootCredential(): Promise<RootCredential | undefined> {
    const user = this.users.get("0");
    if (
      user === undefined ||
      !user.isRoot ||
      user.accountType !== "human" ||
      user.disabled ||
      this.rootPasswordHash === undefined
    ) {
      return undefined;
    }
    return { user: copy(user), passwordHash: this.rootPasswordHash };
  }

  public async findUsernameCredential(username: string): Promise<EmailCredential | undefined> {
    const normalizedUsername = username.trim().toLocaleLowerCase();
    const user = [...this.users.values()].find((candidate) =>
      !candidate.isRoot &&
      candidate.username?.trim().toLocaleLowerCase() === normalizedUsername
    );
    if (user === undefined || user.disabled) {
      return undefined;
    }
    const credential = [...this.emailCredentials.values()].find((candidate) =>
      candidate.userId === user.id && candidate.verified
    );
    return credential === undefined
      ? undefined
      : { user: copy(user), passwordHash: credential.passwordHash };
  }

  public async getUserPermissionDelta(userId: string): Promise<UserPermissionDelta> {
    const delta = this.permissionDeltas.get(userId);
    return delta === undefined
      ? { userId, allows: [], denies: [], revision: 1 }
      : copy(delta);
  }

  public async replaceUserPermissionDelta(
    input: ReplaceUserPermissionDeltaInput
  ): Promise<UserPermissionDelta> {
    const user = this.users.get(input.userId);
    if (user === undefined) {
      throw new Error("USER_NOT_FOUND");
    }
    const current = await this.getUserPermissionDelta(input.userId);
    if (current.revision !== input.expectedRevision) {
      throw new Error("PERMISSION_DELTA_CONFLICT");
    }
    const allows = [...new Set(input.allows)];
    const denies = [...new Set(input.denies)];
    const next: UserPermissionDelta = {
      userId: input.userId,
      allows,
      denies,
      revision: current.revision + 1
    };
    this.permissionDeltas.set(input.userId, next);
    const baseline = this.baselineGrants.get(input.userId) ?? [];
    user.grants = [
      ...copy(baseline),
      ...allows.map((permission) => ({ permission, effect: "allow" as const, scope: "global" as const })),
      ...denies.map((permission) => ({ permission, effect: "deny" as const, scope: "global" as const }))
    ];
    return copy(next);
  }
  public replaceUserPermissionDeltaAtomic(
    input: UserPermissionDeltaAtomicInput
  ): Promise<UserPermissionDelta> {
    const operation = this.permissionDeltaTransactionQueue.then(async () => {
      const orderedUserIds = [...new Set([input.actorUserId, input.authorizationUserId, input.userId])].sort();
      const lockedUsers = orderedUserIds.map((userId) => this.users.get(userId));
      if (lockedUsers.some((user) => user === undefined)) {
        throw new Error("USER_NOT_FOUND");
      }
      const actor = this.users.get(input.authorizationUserId)!;
      const target = this.users.get(input.userId)!;
      await input.authorizeActor(copy(actor), copy(target));
      const current = await this.getUserPermissionDelta(input.userId);
      if (current.revision !== input.expectedRevision) {
        throw new Error("PERMISSION_DELTA_CONFLICT");
      }
      const allows = [...new Set(input.allows)];
      const denies = [...new Set(input.denies)];
      const next: UserPermissionDelta = {
        userId: input.userId,
        allows,
        denies,
        revision: current.revision + 1
      };
      const previousDelta = this.permissionDeltas.get(input.userId);
      const previousGrants = copy(target.grants);
      this.permissionDeltas.set(input.userId, next);
      const baseline = this.baselineGrants.get(input.userId) ?? [];
      target.grants = [
        ...copy(baseline),
        ...allows.map((permission) => ({ permission, effect: "allow" as const, scope: "global" as const })),
        ...denies.map((permission) => ({ permission, effect: "deny" as const, scope: "global" as const }))
      ];
      try {
        await input.writeAudit(undefined);
      } catch (error) {
        if (previousDelta === undefined) {
          this.permissionDeltas.delete(input.userId);
        } else {
          this.permissionDeltas.set(input.userId, previousDelta);
        }
        target.grants = previousGrants;
        throw error;
      }
      return copy(next);
    });
    this.permissionDeltaTransactionQueue = operation.then(
      () => undefined,
      () => undefined
    );
    return operation;
  }
  public setDefaultRoleKeys(keys: { readonly humanRoleKey: string; readonly robotRoleKey: string }): void {
    this.defaultRoleKeys = {
      humanRoleKey: keys.humanRoleKey,
      robotRoleKey: keys.robotRoleKey
    };
  }


  public async registerEmailUser(input: EmailRegistration): Promise<StoredUser | undefined> {
    if (this.emailCredentials.has(input.normalizedEmail)) {
      return undefined;
    }
    const defaultRoleKey = this.defaultRoleKey("human");
    const defaultRole = this.defaultRoleDefinition("human");
    const user: StoredUser = {
      id: String(this.nextUserId++),
      nickname: input.nickname,
      accountType: "human",
      disabled: false,
      roles: [defaultRole?.displayName ?? defaultRoleKey],
      grants: this.defaultRoleGrants("human"),
      isRoot: false
    };
    this.users.set(user.id, copy(user));
    this.baselineGrants.set(user.id, copy(user.grants));
    this.emailCredentials.set(input.normalizedEmail, {
      userId: user.id,
      passwordHash: input.passwordHash,
      verified: false
    });
    this.primaryEmails.set(user.id, { address: input.displayEmail, verified: false });
    return copy(user);
  }
  public async createEmailUsersBatch(
    input: BatchAccountCreationInput,
    auditWriter?: BatchAccountAuditWriter
  ): Promise<BatchAccountCreationResult> {
    const emailOwners = new Set(this.emailCredentials.keys());
    const usernameOwners = new Set(
      [...this.users.values()]
        .map((user) => user.username)
        .filter((username): username is string => username !== undefined && username !== null)
        .map(normalizeUsernameKey)
    );
    const identityOwners = new Set(
      [...this.userIdentifiers.values()].flatMap((identifiers) =>
        identifiers.map((identifier) => normalizeUsernameKey(identifier.value))
      )
    );
    const conflicts: Record<string, string[]> = {};
    for (const account of input.accounts) {
      if (emailOwners.has(account.normalizedEmail)) {
        conflicts[`lines.${account.line}`] = ["邮箱或用户名已被其他账号使用。"];
      }
      if (
        account.username !== null &&
        (
          usernameOwners.has(normalizeUsernameKey(account.username)) ||
          identityOwners.has(normalizeUsernameKey(account.username))
        )
      ) {
        conflicts[`lines.${account.line}`] = ["邮箱或用户名已被其他账号使用。"];
      }
    }
    if (Object.keys(conflicts).length > 0) {
      throw new BatchAccountConflictError(conflicts);
    }

    const nextUsers = new Map(this.users);
    const nextBaselineGrants = new Map(this.baselineGrants);
    const nextEmailCredentials = new Map(this.emailCredentials);
    const nextPrimaryEmails = new Map(this.primaryEmails);
    let nextUserId = this.nextUserId;
    const defaultRoleKey = this.defaultRoleKey("human");
    const defaultRole = this.defaultRoleDefinition("human");
    for (const account of input.accounts) {
      const user: StoredUser = {
        id: String(nextUserId++),
        nickname: account.nickname,
        accountType: "human",
        disabled: false,
        roles: [defaultRole?.displayName ?? defaultRoleKey],
        grants: this.defaultRoleGrants("human"),
        isRoot: false,
        username: account.username
      };
      nextUsers.set(user.id, copy(user));
      nextBaselineGrants.set(user.id, copy(user.grants));
      nextEmailCredentials.set(account.normalizedEmail, {
        userId: user.id,
        passwordHash: account.passwordHash,
        verified: true
      });
      nextPrimaryEmails.set(user.id, { address: account.displayEmail, verified: true });
    }
    const event = {
      actorUserId: input.actorUserId,
      ...(input.effectiveUserId === undefined ? {} : { effectiveUserId: input.effectiveUserId }),
      requestId: input.requestId,
      accountCount: input.accounts.length
    };
    if (auditWriter === undefined) {
      this.batchAccountAuditEvents.push(copy(event));
    } else {
      await auditWriter.write(event);
    }

    this.users.clear();
    for (const [id, user] of nextUsers) {
      this.users.set(id, user);
    }
    this.emailCredentials.clear();
    for (const [email, credential] of nextEmailCredentials) {
      this.emailCredentials.set(email, credential);
    }
    this.primaryEmails.clear();
    for (const [userId, email] of nextPrimaryEmails) {
      this.primaryEmails.set(userId, email);
    }
    this.baselineGrants.clear();
    for (const [id, grants] of nextBaselineGrants) {
      this.baselineGrants.set(id, grants);
    }
    this.nextUserId = nextUserId;
    return { createdCount: input.accounts.length, totalCount: input.accounts.length };
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

  public async hasExternalIdentity(provider: string, subject: string): Promise<boolean> {
    return this.externalIdentities.has(`${provider}\u0000${subject}`);
  }

  public async findOrCreateExternalUser(input: ExternalIdentity): Promise<StoredUser> {
    const key = `${input.provider}\u0000${input.subject}`;
    const existingId = this.externalIdentities.get(key);
    if (existingId !== undefined) {
      const existing = this.users.get(existingId);
      if (existing !== undefined) {
        if (
          input.strictReconciliation === true &&
          input.username !== undefined &&
          existing.username !== undefined &&
          existing.username !== null &&
          existing.username !== input.username
        ) {
          throw new ExternalIdentityCollisionError();
        }
        if (input.strictReconciliation === true) {
          for (const [userId, identifiers] of this.userIdentifiers) {
            if (
              userId !== existing.id &&
              input.studentIds?.some((candidate) =>
                identifiers.some(
                  (current) =>
                    current.attribute === candidate.attribute &&
                    current.value === candidate.value
                )
              )
            ) {
              throw new ExternalIdentityCollisionError();
            }
          }
          if (input.email !== undefined) {
            for (const [userId, email] of this.primaryEmails) {
              if (userId !== existing.id && email.address === input.email) {
                throw new ExternalIdentityCollisionError();
              }
            }
            const currentEmail = this.primaryEmails.get(existing.id);
            if (currentEmail !== undefined && currentEmail.address !== input.email) {
              throw new ExternalIdentityCollisionError();
            }
          }
        }
        const reconciled: StoredUser = {
          ...existing,
          ...(input.username === undefined ? {} : { username: input.username }),
          ...(input.realName === undefined ? {} : { realName: input.realName })
        };
        this.users.set(existing.id, copy(reconciled));
        if (input.email !== undefined && this.primaryEmails.get(existing.id) === undefined) {
          this.primaryEmails.set(existing.id, { address: input.email, verified: true });
        }
        if (input.studentIds !== undefined && input.studentIds.length > 0) {
          const current = this.userIdentifiers.get(existing.id) ?? [];
          this.userIdentifiers.set(
            existing.id,
            [
              ...current,
              ...input.studentIds.filter(
                (candidate) =>
                  !current.some(
                    (item) =>
                      item.attribute === candidate.attribute &&
                      item.value === candidate.value
                  )
              )
            ].map((item) => ({ attribute: item.attribute, value: item.value }))
          );
        }
        return copy(reconciled);
      }
    }
    if (input.strictReconciliation === true) {
      const inputUsername = input.username;
      if (
        inputUsername !== undefined &&
        [...this.users.values()].some((candidate) =>
          candidate.username !== undefined &&
          candidate.username !== null &&
          normalizeUsernameKey(candidate.username) === normalizeUsernameKey(inputUsername)
        )
      ) {
        throw new ExternalIdentityCollisionError();
      }
      for (const identifiers of this.userIdentifiers.values()) {
        if (
          input.studentIds?.some((candidate) =>
            identifiers.some(
              (current) =>
                current.attribute === candidate.attribute &&
                current.value === candidate.value
            )
          )
        ) {
          throw new ExternalIdentityCollisionError();
        }
      }
      if (
        input.email !== undefined &&
        [...this.primaryEmails.values()].some((email) => email.address === input.email)
      ) {
        throw new ExternalIdentityCollisionError();
      }
    }
    const defaultRoleKey = this.defaultRoleKey("human");
    const defaultRole = this.defaultRoleDefinition("human");
    const user: StoredUser = {
      id: String(this.nextUserId++),
      nickname: input.nickname,
      accountType: "human",
      disabled: false,
      roles: [defaultRole?.displayName ?? defaultRoleKey],
      grants: this.defaultRoleGrants("human"),
      isRoot: false,
      username: input.username ?? null,
      realName: input.realName ?? null,
      qq: null,
      avatarSource: "none"
    };
    this.users.set(user.id, copy(user));
    this.baselineGrants.set(user.id, copy(user.grants));
    this.externalIdentities.set(key, user.id);
    if (input.email !== undefined) {
      this.primaryEmails.set(user.id, { address: input.email, verified: true });
    }
    if (input.studentIds !== undefined && input.studentIds.length > 0) {
      this.userIdentifiers.set(
        user.id,
        input.studentIds.map((item) => ({ attribute: item.attribute, value: item.value }))
      );
    }
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
      if (session.userId === userId || session.impersonatorUserId === userId) {
        this.sessions.delete(sessionId);
      }
    }
  }

  public async createSession(
    userId: string,
    expiresAt: string,
    impersonatorUserId?: string | null
  ): Promise<StoredSession> {
    const session: StoredSession = {
      id: randomUUID(),
      userId,
      expiresAt,
      ...(impersonatorUserId === undefined ? {} : { impersonatorUserId })
    };
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

      if (filters.origin !== undefined && (problem.origin ?? "native") !== filters.origin) {
        return false;
      }

      if (filters.batch !== undefined && (problem.importBatch ?? null) !== filters.batch) {
        return false;
      }

      if (filters.source !== undefined && (problem.importSource ?? null) !== filters.source) {
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
