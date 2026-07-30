import { randomUUID } from "node:crypto";
import {
  problemDraftSchema,
  type CreateProblemInput,
  type ManualReviewDecisionInput,
  type Problem,
  type ProblemCapabilities,
  type ProblemContent,
  type ProblemListItem,
  type ProblemListQuery,
  type ProblemListResponse,
  type Review,
  type ReviewInput,
  type ReviewItemListResponse,
  type ReviewItemView,
  type ReviewRoundSummary,
  type SessionUser,
  type SimilarityCheckResponse,
  type UpdateProblemInput
} from "@urmotiv/contracts";
import type { DatabaseExecutor } from "@urmotiv/database";
import type {
  BeforeSubmitInput,
  ReviewDecision,
  ReviewItem,
  ReviewOpinion,
  ReviewRoundSnapshot
} from "@urmotiv/plugin-sdk";
import { computeProblemContentHash } from "./database-store";
import { ApiError, conflict, forbidden, notFound, type FieldErrors } from "./errors";
import type {
  ProblemListFilters,
  StoredProblem,
  StoredReview,
  StoredReviewRule,
  StoredReviewRoundState,
  StoredUser
} from "./domain";
import {
  canEditProblem,
  canExportProblem,
  canViewProblem,
  createProblemVisibility,
  effectivePermissionNames,
  hasPermission
} from "./permissions";
import type { DataStore, ProblemRevisionAction } from "./repository";
import type {
  ReviewItemStore,
  ReviewItemVisibility,
  StoredReviewItem,
  StoredReviewItemInput
} from "./review-item-store";
import {
  DefaultReviewDecisionRunner,
  ReviewRuleUnavailableError,
  type ReviewDecisionRunner
} from "./review-decision";

/** 提交前检查的汇总结果：任何一项检查要求阻止，提交就不会发生。 */
export interface SubmitCheckOutcome {
  readonly blocked?: { readonly code: string; readonly message: string };
  readonly reviewItems: readonly StoredReviewItemInput[];
  /** 实际运行的检查数量；为 0 表示当前没有任何启用的提交前检查。 */
  readonly checksRun: number;
}

export interface SubmitCheckRunner {
  run(input: BeforeSubmitInput): Promise<SubmitCheckOutcome>;
}

export interface ProblemServiceOptions {
  now?: () => Date;
  /** 插件提交前检查；未配置时提交流程与检查无关。 */
  submitChecks?: SubmitCheckRunner;
  /** 审核条目存储；未配置时检查产生的条目会被丢弃。 */
  reviewItems?: ReviewItemStore;
  /** Evaluates the immutable rule saved for each review round. */
  reviewDecisions?: ReviewDecisionRunner;
}

function emptyContent(): ProblemContent {
  return {
    basicStatement: "",
    basicSolution: "",
    background: "",
    statement: "",
    inputFormat: "",
    outputFormat: "",
    constraints: "",
    solution: "",
    hints: ""
  };
}

function asIso(now: Date): string {
  return now.toISOString();
}

function frozenFieldErrors(
  current: StoredProblem,
  input: UpdateProblemInput
): FieldErrors | undefined {
  if (current.status !== "pending_review" && current.status !== "approved") {
    return undefined;
  }

  const errors: FieldErrors = {};
  if (input.title !== undefined && input.title !== current.title) {
    errors.title = ["待审核或已通过的题目不能直接修改题目名称。"];
  }

  if (
    input.content !== undefined &&
    input.content.basicStatement !== current.content.basicStatement
  ) {
    errors["content.basicStatement"] = ["待审核或已通过的题目不能直接修改基础题面。"];
  }

  if (
    input.content !== undefined &&
    input.content.basicSolution !== current.content.basicSolution
  ) {
    errors["content.basicSolution"] = ["待审核或已通过的题目不能直接修改基础题解。"];
  }

  return Object.keys(errors).length === 0 ? undefined : errors;
}

function mergedContent(current: ProblemContent, next: ProblemContent | undefined): ProblemContent {
  return next === undefined ? current : { ...current, ...next };
}

export class ProblemService {
  private readonly now: () => Date;
  private readonly submitChecks: SubmitCheckRunner | undefined;
  private readonly reviewItems: ReviewItemStore | undefined;
  private readonly reviewDecisions: ReviewDecisionRunner;

  public constructor(
    private readonly store: DataStore,
    options: ProblemServiceOptions = {}
  ) {
    this.now = options.now ?? (() => new Date());
    this.submitChecks = options.submitChecks;
    this.reviewItems = options.reviewItems;
    this.reviewDecisions = options.reviewDecisions ?? new DefaultReviewDecisionRunner();
  }

  public getSessionUser(user: StoredUser): SessionUser {
    const now = this.now();
    const isHuman = user.accountType === "human";
    return {
      id: user.id,
      nickname: user.nickname,
      accountType: user.accountType,
      permissions: effectivePermissionNames(user, now),
      roles: user.roles,
      isRoot: user.isRoot,
      canManageReviewPolicy:
        isHuman && hasPermission(user, "problem.status.change", {}, now),
      canManagePlugins:
        isHuman && hasPermission(user, "plugin.manage", {}, now)
    };
  }

  public async listProblems(user: StoredUser, query: ProblemListQuery): Promise<ProblemListResponse> {
    const visibility = createProblemVisibility(user, this.now());
    const filters: ProblemListFilters = {
      page: query.page,
      pageSize: query.pageSize,
      search: query.search,
      owner: query.owner,
      sort: query.sort,
      ...(query.status === undefined ? {} : { status: query.status }),
      ...(query.type === undefined ? {} : { type: query.type })
    };
    const page = await this.store.listVisibleProblems(filters, visibility);
    const items = await Promise.all(page.items.map((problem) => this.toListItem(problem, user)));
    return {
      items,
      total: page.total,
      page: query.page,
      pageSize: query.pageSize
    };
  }

  public async createProblem(user: StoredUser, input: CreateProblemInput): Promise<Problem> {
    if (!hasPermission(user, "problem.create", {}, this.now())) {
      throw forbidden();
    }
    if (
      input.judgeConfig !== undefined &&
      input.judgeConfig !== null &&
      !hasPermission(user, "problem.testdata.write", {}, this.now())
    ) {
      throw forbidden();
    }

    const tagIds = input.tagIds ?? [];
    await this.assertKnownTags(tagIds);
    const now = asIso(this.now());
    const problem: StoredProblem = {
      id: randomUUID(),
      title: input.title,
      type: input.type,
      tagIds,
      codeforcesDifficulty: input.codeforcesDifficulty ?? null,
      thinkingLevel: input.thinkingLevel ?? null,
      codingLevel: input.codingLevel ?? null,
      content: { ...emptyContent(), ...(input.content ?? {}) },
      samples: input.samples ?? [],
      judgeConfig: input.judgeConfig ?? null,
      status: "draft",
      ownerId: user.id,
      revision: 1,
      reviewRound: 0,
      createdAt: now,
      updatedAt: now
    };

    const created = await this.store.createProblem(problem);
    return this.toProblem(created, user);
  }

  public async getProblem(user: StoredUser, problemId: string): Promise<Problem> {
    const problem = await this.findVisibleProblem(user, problemId);
    return this.toProblem(problem, user);
  }

  /**
   * Returns the server-only version identifier and current permissions needed by file handlers.
   * This is deliberately separate from `getProblem`, which must never expose a revision identifier.
   */
  public async getProblemForFileAccess(
    user: StoredUser,
    problemId: string
  ): Promise<{ readonly problem: StoredProblem; readonly capabilities: ProblemCapabilities }> {
    const problem = await this.findVisibleProblem(user, problemId);
    return { problem, capabilities: this.capabilitiesFor(problem, user) };
  }

  public async updateProblem(
    user: StoredUser,
    problemId: string,
    input: UpdateProblemInput,
    revisionAction?: ProblemRevisionAction
  ): Promise<Problem> {
    const current = await this.findVisibleProblem(user, problemId);
    if (!canEditProblem(user, current, this.now())) {
      throw forbidden();
    }

    this.assertExpectedRevision(current, input.expectedRevision);
    const target = { ownerId: current.ownerId, objectId: current.id };
    const judgeConfigChanged =
      input.judgeConfig !== undefined &&
      JSON.stringify(input.judgeConfig) !== JSON.stringify(current.judgeConfig);
    if (
      judgeConfigChanged &&
      !hasPermission(user, "problem.testdata.write", target, this.now())
    ) {
      throw forbidden();
    }
    const frozenErrors = frozenFieldErrors(current, input);
    if (frozenErrors !== undefined) {
      throw conflict("题目正在审核或已通过，三个审核字段已冻结。", frozenErrors);
    }

    const nextTagIds = input.tagIds ?? current.tagIds;
    await this.assertKnownTags(nextTagIds);
    const next: StoredProblem = {
      ...current,
      title: input.title ?? current.title,
      type: input.type ?? current.type,
      tagIds: nextTagIds,
      codeforcesDifficulty:
        input.codeforcesDifficulty === undefined
          ? current.codeforcesDifficulty
          : input.codeforcesDifficulty,
      thinkingLevel: input.thinkingLevel === undefined ? current.thinkingLevel : input.thinkingLevel,
      codingLevel: input.codingLevel === undefined ? current.codingLevel : input.codingLevel,
      content: mergedContent(current.content, input.content),
      samples: input.samples ?? current.samples,
      judgeConfig:
        input.judgeConfig === undefined ? (current.judgeConfig ?? null) : input.judgeConfig,
      revision: current.revision + 1,
      updatedAt: asIso(this.now())
    };
    const updated = revisionAction === undefined
      ? await this.store.replaceProblem(next, input.expectedRevision, user.id)
      : await this.store.replaceProblemWithRevisionAction?.(
        next,
        input.expectedRevision,
        user.id,
        revisionAction
      );
    if (updated === undefined) {
      throw new Error("当前数据存储不支持带文件关联的题目修订。");
    }
    if (!updated) {
      throw conflict("题目已被其他操作修改，请刷新后重试。");
    }

    return this.toProblem(next, user);
  }

  public async submitProblem(
    user: StoredUser,
    problemId: string,
    expectedRevision: number
  ): Promise<Problem> {
    const current = await this.findVisibleProblem(user, problemId);
    if (current.ownerId !== user.id || !canEditProblem(user, current, this.now())) {
      throw forbidden();
    }

    if (current.status !== "draft" && current.status !== "rejected") {
      throw conflict("只有草稿或审核不通过的题目可以提交审核。");
    }

    this.assertExpectedRevision(current, expectedRevision);
    await this.assertKnownTags(current.tagIds);
    const requiredFieldErrors: FieldErrors = {};
    if (current.content.basicStatement.trim().length === 0) {
      requiredFieldErrors["content.basicStatement"] = ["请填写基础题面。"];
    }
    if (current.content.basicSolution.trim().length === 0) {
      requiredFieldErrors["content.basicSolution"] = ["请填写基础题解。"];
    }
    const validation = problemDraftSchema.safeParse({
      title: current.title,
      type: current.type,
      tagIds: current.tagIds,
      codeforcesDifficulty: current.codeforcesDifficulty,
      thinkingLevel: current.thinkingLevel,
      codingLevel: current.codingLevel,
      content: current.content,
      samples: current.samples,
      judgeConfig: current.judgeConfig
    });
    if (!validation.success || Object.keys(requiredFieldErrors).length > 0) {
      const fieldErrors: FieldErrors = requiredFieldErrors;
      if (!validation.success) {
        for (const issue of validation.error.issues) {
          const field = issue.path.join(".") || "problem";
          (fieldErrors[field] ??= []).push(issue.message);
        }
      }
      throw new ApiError(
        422,
        "PROBLEM_INCOMPLETE",
        "请补全提交审核所需的题目信息。",
        fieldErrors
      );
    }

    const pendingProblem: StoredProblem = {
      ...current,
      status: "pending_review",
      reviewRound: current.reviewRound + 1,
      revision: current.revision + 1,
      updatedAt: asIso(this.now())
    };
    const policy = await this.store.getReviewPolicy();
    let preparedRule: StoredReviewRule;
    try {
      preparedRule = await this.reviewDecisions.prepareRule(
        policy.ruleId,
        policy.settings,
        policy.pluginVersion
      );
    } catch (error) {
      if (error instanceof ReviewRuleUnavailableError) {
        throw reviewRuleUnavailable();
      }
      throw error;
    }
    const next: StoredProblem = {
      ...pendingProblem,
      reviewRoundState: {
        ...preparedRule,
        round: pendingProblem.reviewRound,
        status: "open",
        submittedContentHash: computeProblemContentHash(pendingProblem),
        decisionReason: null,
        countedOpinionIds: [],
        usedOpinionIds: [],
        usedReviewItemIds: [],
        decisionSource: null,
        decidedAt: null
      }
    };

    const checkItems = await this.runSubmitChecks(next);
    let updated: boolean;
    if (
      checkItems.length > 0 &&
      this.reviewItems !== undefined &&
      this.store.replaceProblemWithRevisionAction !== undefined
    ) {
      const reviewItems = this.reviewItems;
      updated = await this.store.replaceProblemWithRevisionAction(
        next,
        expectedRevision,
        user.id,
        async (_revisionId, executor) => {
          await reviewItems.append(next.id, next.reviewRound, checkItems, executor);
        }
      );
    } else {
      updated = await this.store.replaceProblem(next, expectedRevision, user.id);
      if (updated && checkItems.length > 0 && this.reviewItems !== undefined) {
        await this.reviewItems.append(next.id, next.reviewRound, checkItems);
      }
    }
    if (!updated) {
      throw conflict("题目已被其他操作修改，请刷新后重试。");
    }

    return this.toProblem(next, user);
  }

  private async runSubmitChecks(next: StoredProblem): Promise<readonly StoredReviewItemInput[]> {
    if (this.submitChecks === undefined) {
      return [];
    }
    const outcome = await this.submitChecks.run(submitCheckInputFor(next));
    if (outcome.blocked !== undefined) {
      throw new ApiError(409, "SUBMIT_BLOCKED_BY_CHECK", outcome.blocked.message, {
        submitCheck: [outcome.blocked.code]
      });
    }
    return outcome.reviewItems;
  }

  /**
   * 查看当前审核轮次的审核条目。可见级别按身份收窄：作者能看标记为“作者可见”的，
   * 审题人多看一档，有最终决定权的人能看全部。没有任何可见级别时返回空列表。
   */
  public async listReviewItems(user: StoredUser, problemId: string): Promise<ReviewItemListResponse> {
    const current = await this.findVisibleProblem(user, problemId);
    const levels = this.visibleItemLevels(user, current);
    if (levels.length === 0 || current.reviewRound < 1 || this.reviewItems === undefined) {
      return { round: current.reviewRound, items: [] };
    }
    const stored = await this.reviewItems.list(current.id, current.reviewRound, levels);
    return { round: current.reviewRound, items: stored.map(storedItemToView) };
  }

  /**
   * 手动运行一次原题检索等提交前检查。结果直接返回给页面；题目已进入审核轮次时同时
   * 保存为审核条目。这里的“建议不要提交”只是提示，不改变题目状态。
   */
  public async runManualSimilarityCheck(
    user: StoredUser,
    problemId: string
  ): Promise<SimilarityCheckResponse> {
    const current = await this.findVisibleProblem(user, problemId);
    const target = { ownerId: current.ownerId, objectId: current.id };
    const mayReview =
      hasPermission(user, "problem.review", target, this.now()) ||
      hasPermission(user, "problem.status.change", target, this.now());
    if (!canEditProblem(user, current, this.now()) && !mayReview) {
      throw forbidden();
    }
    if (this.submitChecks === undefined) {
      return { status: "unavailable", blockedAdvice: null, items: [] };
    }

    const probe: StoredProblem = {
      ...current,
      reviewRound: Math.max(1, current.reviewRound)
    };
    const outcome = await this.submitChecks.run(submitCheckInputFor(probe));
    if (outcome.checksRun === 0) {
      return { status: "unavailable", blockedAdvice: null, items: [] };
    }
    if (
      current.reviewRound >= 1 &&
      this.reviewItems !== undefined &&
      outcome.reviewItems.length > 0
    ) {
      await this.reviewItems.append(current.id, current.reviewRound, outcome.reviewItems);
    }
    const now = asIso(this.now());
    return {
      status: "completed",
      blockedAdvice: outcome.blocked ?? null,
      items: outcome.reviewItems.map((item) => inputItemToView(item, now))
    };
  }

  private visibleItemLevels(user: StoredUser, problem: StoredProblem): ReviewItemVisibility[] {
    const target = { ownerId: problem.ownerId, objectId: problem.id };
    const isAdministrator = hasPermission(user, "problem.status.change", target, this.now());
    const isReviewer =
      isAdministrator || hasPermission(user, "problem.review", target, this.now());
    const isAuthor = problem.ownerId === user.id;
    const levels: ReviewItemVisibility[] = [];
    if (isAuthor || isReviewer) {
      levels.push("author");
    }
    if (isReviewer) {
      levels.push("reviewer");
    }
    if (isAdministrator) {
      levels.push("administrator");
    }
    return levels;
  }

  public async withdrawProblem(
    user: StoredUser,
    problemId: string,
    expectedRevision: number,
    reason = "",
    requestId?: string
  ): Promise<Problem> {
    await this.findVisibleProblem(user, problemId);
    const next = await this.store.runProblemTransaction(problemId, async (transaction) => {
      const current = transaction.getProblem();
      const users = transaction.listUsers();
      const actor = users.find((candidate) => candidate.id === user.id);
      if (
        current === undefined ||
        actor === undefined ||
        !canViewProblem(createProblemVisibility(actor, this.now()), current)
      ) {
        throw notFound();
      }

      const target = { ownerId: current.ownerId, objectId: current.id };
      const isOwner = current.ownerId === actor.id && canEditProblem(actor, current, this.now());
      const canChangeStatus = hasPermission(
        actor,
        "problem.status.change",
        target,
        this.now()
      );
      if (!isOwner && !canChangeStatus) {
        throw forbidden();
      }
      if (current.status !== "pending_review" && current.status !== "approved") {
        throw conflict("只有待审核或已通过的题目可以撤回修改。");
      }
      this.assertExpectedRevision(current, expectedRevision);

      const evaluatedAt = this.now();
      const decidedAt = asIso(evaluatedAt);
      let reviewRoundState = current.reviewRoundState;
      if (current.status === "pending_review") {
        const roundState = this.requireOpenRoundState(current);
        const reviews = transaction.listReviews(current.reviewRound);
        const reviewItems = this.reviewItems === undefined
          ? []
          : await this.reviewItems.listForDecision(
              current.id,
              current.reviewRound,
              transaction.executor
            );
        const countedOpinionIds = await this.captureCountedOpinionIds(
          current,
          reviews,
          users,
          reviewItems,
          evaluatedAt,
          transaction.executor
        );
        reviewRoundState = {
          ...roundState,
          status: "withdrawn",
          decisionReason: reason.trim() || "题目已撤回修改。",
          countedOpinionIds,
          usedOpinionIds: [],
          usedReviewItemIds: [],
          decisionSource: "withdrawal",
          decidedAt,
          ...(requestId === undefined ? {} : { decisionRequestId: requestId })
        };
      }

      const updated: StoredProblem = {
        ...current,
        status: "draft",
        revision: current.revision + 1,
        updatedAt: decidedAt,
        ...(reviewRoundState === undefined ? {} : { reviewRoundState })
      };
      if (!transaction.replaceProblem(updated, expectedRevision, actor.id)) {
        throw conflict("题目已被其他操作修改，请刷新后重试。");
      }
      return updated;
    });

    return this.toProblem(next, user);
  }

  public async getReviewSummary(user: StoredUser, problemId: string): Promise<ReviewRoundSummary> {
    const problem = await this.findVisibleProblem(user, problemId);
    const target = { ownerId: problem.ownerId, objectId: problem.id };
    if (
      problem.ownerId !== user.id &&
      !hasPermission(user, "problem.review", target, this.now()) &&
      !hasPermission(user, "problem.status.change", target, this.now())
    ) {
      throw forbidden();
    }

    if (problem.reviewRound === 0) {
      throw conflict("题目尚未提交审核，因此还没有审核轮次。");
    }

    return this.aggregateReviewRound(problem, user);
  }

  public async submitReview(
    user: StoredUser,
    problemId: string,
    input: ReviewInput,
    requestId?: string
  ): Promise<ReviewRoundSummary> {
    await this.findVisibleProblem(user, problemId);
    await this.assertKnownTags(input.tagIds);
    return this.store.runProblemTransaction(problemId, async (transaction) => {
      const problem = transaction.getProblem();
      const users = transaction.listUsers();
      const actor = users.find((candidate) => candidate.id === user.id);
      if (
        problem === undefined ||
        actor === undefined ||
        !canViewProblem(createProblemVisibility(actor, this.now()), problem)
      ) {
        throw notFound();
      }

      const target = { ownerId: problem.ownerId, objectId: problem.id };
      if (!hasPermission(actor, "problem.review", target, this.now())) {
        throw forbidden();
      }
      if (problem.status !== "pending_review") {
        throw conflict("只有待审核的题目可以提交审核意见。");
      }
      if (input.expectedRound !== problem.reviewRound) {
        throw conflict("审核轮次已变化，请刷新后重试。");
      }

      const existing = transaction
        .listReviews(problem.reviewRound)
        .find((review) => review.reviewerId === actor.id);
      const now = asIso(this.now());
      const review: StoredReview = {
        ...input,
        id: existing?.id ?? randomUUID(),
        problemId: problem.id,
        reviewer: {
          id: actor.id,
          nickname: actor.nickname,
          accountType: actor.accountType
        },
        reviewerId: actor.id,
        source: actor.accountType === "robot" ? "fermata" : "human",
        createdAt: existing?.createdAt ?? now,
        updatedAt: now
      };
      transaction.upsertReview(review);

      const reviews = transaction.listReviews(problem.reviewRound);
      const roundState = this.requireOpenRoundState(problem);
      const reviewItems = this.reviewItems === undefined
        ? []
        : await this.reviewItems.listForDecision(
            problem.id,
            problem.reviewRound,
            transaction.executor
          );
      let decision: ReviewDecision;
      const evaluatedAt = this.now();
      try {
        decision = await this.reviewDecisions.evaluate(
          roundState,
          this.createReviewRoundSnapshot(problem, reviews, users, reviewItems, evaluatedAt),
          evaluatedAt,
          transaction.executor
        );
      } catch (error) {
        if (error instanceof ReviewRuleUnavailableError) {
          throw reviewRuleUnavailable();
        }
        throw error;
      }
      if (decision.decision === "pending") {
        return this.buildReviewRoundSummary(
          problem,
          reviews,
          users,
          actor,
          decision,
          true
        );
      }

      const finalStatus = decision.decision === "approve" ? "approved" : "rejected";
      const decidedAt = asIso(this.now());
      const next: StoredProblem = {
        ...problem,
        status: finalStatus,
        revision: problem.revision + 1,
        updatedAt: decidedAt,
        reviewRoundState: {
          ...roundState,
          status: finalStatus,
          decisionReason: decision.reason,
          countedOpinionIds: [...decision.usedOpinionIds],
          usedOpinionIds: [...decision.usedOpinionIds],
          usedReviewItemIds: [...decision.usedReviewItemIds],
          decisionSource: "rule",
          decidedAt,
          ...(requestId === undefined ? {} : { decisionRequestId: requestId })
        }
      };
      if (!transaction.replaceProblem(next, problem.revision, actor.id)) {
        throw conflict("题目已被其他操作修改，请刷新后重试。");
      }
      return this.buildReviewRoundSummary(next, reviews, users, actor, decision, true);
    });
  }

  public async finalizeReview(
    user: StoredUser,
    problemId: string,
    input: ManualReviewDecisionInput,
    requestId?: string
  ): Promise<ReviewRoundSummary> {
    await this.findVisibleProblem(user, problemId);
    return this.store.runProblemTransaction(problemId, async (transaction) => {
      const problem = transaction.getProblem();
      const users = transaction.listUsers();
      const actor = users.find((candidate) => candidate.id === user.id);
      if (
        problem === undefined ||
        actor === undefined ||
        !canViewProblem(createProblemVisibility(actor, this.now()), problem)
      ) {
        throw notFound();
      }
      const target = { ownerId: problem.ownerId, objectId: problem.id };
      if (
        actor.accountType !== "human" ||
        !hasPermission(actor, "problem.status.change", target, this.now())
      ) {
        throw forbidden();
      }
      if (problem.status !== "pending_review") {
        throw conflict("只有待审核的题目可以进行人工终审。");
      }
      if (problem.reviewRound !== input.expectedRound) {
        throw conflict("审核轮次已变化，请刷新后重试。");
      }
      this.assertExpectedRevision(problem, input.expectedRevision);

      const roundState = this.requireOpenRoundState(problem);
      const reviews = transaction.listReviews(problem.reviewRound);
      const evaluatedAt = this.now();
      const reviewItems = this.reviewItems === undefined
        ? []
        : await this.reviewItems.listForDecision(
            problem.id,
            problem.reviewRound,
            transaction.executor
          );
      const countedOpinionIds = await this.captureCountedOpinionIds(
        problem,
        reviews,
        users,
        reviewItems,
        evaluatedAt,
        transaction.executor
      );
      const finalStatus = input.decision === "approve" ? "approved" : "rejected";
      const decidedAt = asIso(evaluatedAt);
      const next: StoredProblem = {
        ...problem,
        status: finalStatus,
        revision: problem.revision + 1,
        updatedAt: decidedAt,
        reviewRoundState: {
          ...roundState,
          status: finalStatus,
          decisionReason: input.reason,
          countedOpinionIds,
          usedOpinionIds: [],
          usedReviewItemIds: [],
          decisionSource: "manual",
          decidedAt,
          ...(requestId === undefined ? {} : { decisionRequestId: requestId })
        }
      };
      if (!transaction.replaceProblem(next, problem.revision, actor.id)) {
        throw conflict("题目已被其他操作修改，请刷新后重试。");
      }
      return this.buildReviewRoundSummary(
        next,
        reviews,
        users,
        actor,
        {
          decision: input.decision,
          usedOpinionIds: [],
          usedReviewItemIds: [],
          reason: input.reason
        },
        true
      );
    });
  }

  private async findVisibleProblem(user: StoredUser, problemId: string): Promise<StoredProblem> {
    const problem = await this.store.findVisibleProblem(
      problemId,
      createProblemVisibility(user, this.now())
    );
    if (problem === undefined) {
      throw notFound();
    }
    return problem;
  }

  private async assertKnownTags(tagIds: string[]): Promise<void> {
    if (new Set(tagIds).size !== tagIds.length || !(await this.store.hasTags(tagIds))) {
      throw new ApiError(422, "INVALID_TAGS", "知识点中包含无效或重复项。", {
        tagIds: ["请选择存在且不重复的知识点。"]
      });
    }
  }

  private assertExpectedRevision(problem: StoredProblem, expectedRevision: number): void {
    if (problem.revision !== expectedRevision) {
      throw conflict("题目已被其他操作修改，请刷新后重试。");
    }
  }

  private async aggregateReviewRound(
    problem: StoredProblem,
    viewer: StoredUser
  ): Promise<ReviewRoundSummary> {
    const [reviews, users, reviewItems] = await Promise.all([
      this.store.listReviews(problem.id, problem.reviewRound),
      this.store.listUsers(),
      this.reviewItems === undefined
        ? Promise.resolve([])
        : this.reviewItems.listForDecision(problem.id, problem.reviewRound)
    ]);
    const roundState = this.requireRoundState(problem);
    if (roundState.status !== "open") {
      const decision = persistedDecision(roundState);
      return this.buildReviewRoundSummary(problem, reviews, users, viewer, decision, true);
    }
    // A read may refresh counters, but only submitReview can close and persist an automatic decision.
    try {
      const evaluatedAt = this.now();
      const decision = await this.reviewDecisions.evaluate(
        roundState,
        this.createReviewRoundSnapshot(problem, reviews, users, reviewItems, evaluatedAt),
        evaluatedAt
      );
      return this.buildReviewRoundSummary(problem, reviews, users, viewer, decision, true);
    } catch (error) {
      if (error instanceof ReviewRuleUnavailableError) {
        return this.buildReviewRoundSummary(problem, reviews, users, viewer, undefined, false);
      }
      throw error;
    }
  }

  private buildReviewRoundSummary(
    problem: StoredProblem,
    reviews: StoredReview[],
    users: StoredUser[],
    viewer: StoredUser,
    decision: ReviewDecision | undefined,
    decisionAvailable: boolean
  ): ReviewRoundSummary {
    const roundState = this.requireRoundState(problem);
    const countedIds = new Set(
      roundState.status === "open"
        ? decision?.usedOpinionIds ?? this.eligibleHumanOpinionIds(
            problem,
            reviews,
            users,
            this.now()
          )
        : roundState.countedOpinionIds
    );
    const countedReviews = reviews.filter((review) => countedIds.has(review.id));
    const approvals = countedReviews.filter((review) => review.verdict === "approve").length;
    const blockingReviews = countedReviews.filter((review) => review.verdict === "reject").length;
    const status = roundState.status === "open" ? "waiting" : roundState.status;
    const viewerTarget = { ownerId: problem.ownerId, objectId: problem.id };
    const viewerCanReview =
      canViewProblem(createProblemVisibility(viewer, this.now()), problem) &&
      hasPermission(viewer, "problem.review", viewerTarget, this.now());
    const viewerCanChangeStatus = hasPermission(
      viewer,
      "problem.status.change",
      viewerTarget,
      this.now()
    );
    const canReadAllPrivateNotes =
      viewerCanChangeStatus || (viewer.id !== problem.ownerId && viewerCanReview);
    const canReadDecisionReason =
      roundState.status !== "open" &&
      (viewer.id === problem.ownerId || canReadAllPrivateNotes);

    return {
      round: problem.reviewRound,
      reviews: reviews.map((review) =>
        this.toReview(
          review,
          canReadAllPrivateNotes || review.reviewerId === viewer.id
        )
      ),
      approvals,
      blockingReviews,
      requiredApprovals: requiredApprovalCount(roundState),
      status,
      ruleId: roundState.ruleId,
      decisionAvailable,
      decisionReason: canReadDecisionReason ? roundState.decisionReason : null,
      decisionSource: roundState.status === "open" ? null : roundState.decisionSource
    };
  }

  private async captureCountedOpinionIds(
    problem: StoredProblem,
    reviews: readonly StoredReview[],
    users: readonly StoredUser[],
    reviewItems: readonly StoredReviewItem[],
    evaluatedAt: Date,
    executor?: DatabaseExecutor
  ): Promise<string[]> {
    const roundState = this.requireOpenRoundState(problem);
    try {
      const decision = await this.reviewDecisions.evaluate(
        roundState,
        this.createReviewRoundSnapshot(problem, reviews, users, reviewItems, evaluatedAt),
        evaluatedAt,
        executor
      );
      return [...decision.usedOpinionIds];
    } catch (error) {
      if (!(error instanceof ReviewRuleUnavailableError)) {
        throw error;
      }
      // A broken rule must not prevent a human from closing or withdrawing a round.
      return this.eligibleHumanOpinionIds(problem, reviews, users, evaluatedAt);
    }
  }

  private eligibleHumanOpinionIds(
    problem: StoredProblem,
    reviews: readonly StoredReview[],
    users: readonly StoredUser[],
    evaluatedAt: Date
  ): string[] {
    const reviewers = new Map(users.map((candidate) => [candidate.id, candidate]));
    const target = { ownerId: problem.ownerId, objectId: problem.id };
    return reviews
      .filter((review) => {
        const reviewer = reviewers.get(review.reviewerId);
        return (
          reviewer?.accountType === "human" &&
          canViewProblem(createProblemVisibility(reviewer, evaluatedAt), problem) &&
          hasPermission(reviewer, "problem.review", target, evaluatedAt)
        );
      })
      .map((review) => review.id);
  }

  private createReviewRoundSnapshot(
    problem: StoredProblem,
    reviews: readonly StoredReview[],
    users: readonly StoredUser[],
    items: readonly StoredReviewItem[],
    evaluatedAt: Date
  ): ReviewRoundSnapshot {
    const roundState = this.requireOpenRoundState(problem);
    const usersById = new Map(users.map((user) => [user.id, user]));
    const target = { ownerId: problem.ownerId, objectId: problem.id };
    const opinions: ReviewOpinion[] = reviews.map((review) => {
      const reviewer = usersById.get(review.reviewerId);
      const reviewerCanReview = reviewer !== undefined &&
        canViewProblem(createProblemVisibility(reviewer, evaluatedAt), problem) &&
        hasPermission(reviewer, "problem.review", target, evaluatedAt);
      return {
        id: review.id,
        reviewRound: review.expectedRound,
        reviewerId: review.reviewerId,
        reviewerAccountType: reviewer?.accountType ?? "human",
        verdict: review.verdict,
        source: review.source,
        reviewerCanReview,
        updatedAt: review.updatedAt
      };
    });
    const reviewItems = items.flatMap((item): ReviewItem[] => {
      const source = item.sourcePluginId !== null
        ? { kind: "plugin" as const, id: item.sourcePluginId }
        : item.sourceUserId !== null
          ? {
              kind: item.source === "fermata" ? "robot" as const : "human" as const,
              id: item.sourceUserId
            }
          : undefined;
      if (source === undefined) {
        return [];
      }
      return [{
        id: item.id,
        type: item.type,
        source,
        visibility: item.visibility === "administrator" ? "admin" : item.visibility,
        summary: item.summary,
        data: item.data,
        contentHash: item.contentHash,
        ...(item.expiresAt === null ? {} : { expiresAt: item.expiresAt }),
        createdAt: item.createdAt
      }];
    });
    return {
      problemId: problem.id,
      round: problem.reviewRound,
      contentHash: roundState.submittedContentHash,
      opinions,
      reviewItems
    };
  }

  private requireOpenRoundState(problem: StoredProblem): StoredReviewRoundState {
    const roundState = this.requireRoundState(problem);
    if (roundState.status !== "open") {
      throw conflict("审核轮次已经结束，请刷新后重试。");
    }
    return roundState;
  }

  private requireRoundState(problem: StoredProblem): StoredReviewRoundState {
    const roundState = problem.reviewRoundState;
    if (roundState === undefined || roundState.round !== problem.reviewRound) {
      throw reviewRuleUnavailable();
    }
    return roundState;
  }

  private async toProblem(problem: StoredProblem, user: StoredUser): Promise<Problem> {
    const owner = await this.store.getUser(problem.ownerId);
    if (owner === undefined) {
      throw notFound();
    }

    const capabilities = this.capabilitiesFor(problem, user);
    return {
      id: problem.id,
      title: problem.title,
      type: problem.type,
      tagIds: [...problem.tagIds],
      codeforcesDifficulty: problem.codeforcesDifficulty,
      thinkingLevel: problem.thinkingLevel,
      codingLevel: problem.codingLevel,
      content: structuredClone(problem.content),
      samples: structuredClone(problem.samples),
      judgeConfig: capabilities.canReadTestdata
        ? structuredClone(problem.judgeConfig ?? null)
        : null,
      status: problem.status,
      owner: {
        id: owner.id,
        nickname: owner.nickname,
        accountType: owner.accountType
      },
      revision: problem.revision,
      reviewRound: problem.reviewRound,
      createdAt: problem.createdAt,
      updatedAt: problem.updatedAt,
      capabilities
    };
  }

  private async toListItem(problem: StoredProblem, user: StoredUser): Promise<ProblemListItem> {
    const full = await this.toProblem(problem, user);
    return {
      id: full.id,
      title: full.title,
      type: full.type,
      status: full.status,
      codeforcesDifficulty: full.codeforcesDifficulty,
      thinkingLevel: full.thinkingLevel,
      codingLevel: full.codingLevel,
      tagIds: full.tagIds,
      owner: full.owner,
      revision: full.revision,
      updatedAt: full.updatedAt,
      capabilities: full.capabilities
    };
  }

  private capabilitiesFor(problem: StoredProblem, user: StoredUser): ProblemCapabilities {
    const target = { ownerId: problem.ownerId, objectId: problem.id };
    const isOwner = problem.ownerId === user.id;
    const canEdit = canEditProblem(user, problem, this.now());
    const canChangeStatus = hasPermission(user, "problem.status.change", target, this.now());
    const canSubmit =
      isOwner &&
      (problem.status === "draft" || problem.status === "rejected") &&
      canEdit;
    const canWithdraw =
      (problem.status === "pending_review" || problem.status === "approved") &&
      ((isOwner && canEdit) || canChangeStatus);

    return {
      canView: true,
      canEdit,
      canEditFrozen: false,
      canSubmit,
      canWithdraw,
      canReview:
        problem.status === "pending_review" &&
        hasPermission(user, "problem.review", target, this.now()),
      canChangeStatus,
      canReadTestdata: hasPermission(user, "problem.testdata.read", target, this.now()),
      canWriteTestdata: hasPermission(user, "problem.testdata.write", target, this.now()),
      canExport: canExportProblem(user, problem, this.now()),
      canViewAccessLog: hasPermission(user, "problem.viewers.read", target, this.now())
    };
  }

  private toReview(review: StoredReview, includePrivateNote: boolean): Review {
    const { reviewerId: _reviewerId, ...result } = review;
    return includePrivateNote ? result : { ...result, privateNote: "" };
  }
}

function persistedDecision(roundState: StoredReviewRoundState): ReviewDecision {
  const decision = roundState.status === "approved"
    ? "approve"
    : roundState.status === "rejected"
      ? "reject"
      : "pending";
  return {
    decision,
    usedOpinionIds: [...roundState.usedOpinionIds],
    usedReviewItemIds: [...roundState.usedReviewItemIds],
    reason: roundState.decisionReason ?? "本轮审核已经结束。"
  };
}

function requiredApprovalCount(roundState: StoredReviewRoundState): number | null {
  const value = roundState.settings.requiredApprovals;
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : null;
}

function reviewRuleUnavailable(): ApiError {
  return new ApiError(
    503,
    "REVIEW_RULE_UNAVAILABLE",
    "当前审核规则暂时无法完成判断，本次操作没有保存。请联系组长检查规则设置。"
  );
}

function submitCheckInputFor(problem: StoredProblem): BeforeSubmitInput {
  return {
    problemId: problem.id,
    revision: problem.revision,
    reviewRound: problem.reviewRound,
    contentHash: computeProblemContentHash(problem),
    problem: {
      title: problem.title,
      type: problem.type,
      tagIds: problem.tagIds,
      basicStatement: problem.content.basicStatement,
      basicSolution: problem.content.basicSolution
    }
  };
}

function storedItemToView(item: StoredReviewItem): ReviewItemView {
  return {
    id: item.id,
    type: item.type,
    source: item.source,
    visibility: item.visibility,
    summary: item.summary,
    data: item.data,
    createdAt: item.createdAt
  };
}

function inputItemToView(item: StoredReviewItemInput, createdAt: string): ReviewItemView {
  return {
    id: randomUUID(),
    type: item.type,
    source: item.source,
    visibility: item.visibility,
    summary: item.summary,
    data: item.data,
    createdAt
  };
}
