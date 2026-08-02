import { randomUUID } from "node:crypto";
import {
  type ApplyReviewSuggestionsInput,
  problemDraftSchema,
  type CreateProblemInput,
  type ManualReviewDecisionInput,
  type Problem,
  type ProblemCapabilities,
  type ProblemContent,
  type ProblemJudgeConfig,
  type ProblemListItem,
  type ProblemListQuery,
  type ProblemListResponse,
  type Review,
  type ReviewInput,
  type ReviewItemListResponse,
  type ReviewItemView,
  type ReviewRoundSummary,
  type ReviewSuggestionView,
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
import { ApiError, conflict, forbidden, notFound, unauthorized, type FieldErrors } from "./errors";
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
import type { DataStore, ProblemRevisionAction, ProblemTransaction } from "./repository";
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
  /** 原题检索的完成状态；未启用 Anklang 时不提供。 */
  readonly similarityStatus?: "complete" | "partial" | "unavailable";
}

export interface SubmitCheckRunner {
  run(input: BeforeSubmitInput): Promise<SubmitCheckOutcome>;
  runSimilarity(input: BeforeSubmitInput): Promise<SubmitCheckOutcome>;
}

export interface ProblemServiceOptions {
  now?: () => Date;
  /** 插件提交前检查；未配置时提交流程与检查无关。 */
  submitChecks?: SubmitCheckRunner;
  /** 审核条目存储；未配置时检查产生的条目会被丢弃。 */
  reviewItems?: ReviewItemStore;
  /** Evaluates the immutable rule saved for each review round. */
  reviewDecisions?: ReviewDecisionRunner;
  /**
   * Runs inside the transaction after a new revision and its copied file relations exist.
   * Production uses this to validate judge-program references and remove superseded programs.
   */
  judgeConfigRevisionAction?: (
    problem: StoredProblem,
    revisionId: string,
    executor: DatabaseExecutor
  ) => Promise<void>;
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

type SuggestedReviewValues = ReviewSuggestionView["suggested"];

function reviewSuggestionUnavailable(): ApiError {
  return conflict("当前审核轮次没有可用的冻结建议，请刷新后重试。");
}

function isDifficultyLevel(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= 5;
}

function medianLevel(values: readonly number[]): number {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) {
    return sorted[middle] as number;
  }
  return Math.floor(((sorted[middle - 1] as number) + (sorted[middle] as number)) / 2 + 0.5);
}

function aggregateFrozenReviewSuggestions(
  problem: StoredProblem,
  roundState: StoredReviewRoundState,
  reviews: readonly StoredReview[]
): SuggestedReviewValues & { readonly opinionCount: number } {
  const countedOpinionIds = roundState.countedOpinionIds;
  if (
    countedOpinionIds.length === 0 ||
    countedOpinionIds.length > 10_000 ||
    new Set(countedOpinionIds).size !== countedOpinionIds.length
  ) {
    throw reviewSuggestionUnavailable();
  }

  const reviewsById = new Map<string, StoredReview>();
  for (const review of reviews) {
    if (reviewsById.has(review.id)) {
      throw reviewSuggestionUnavailable();
    }
    reviewsById.set(review.id, review);
  }

  const countedReviews = countedOpinionIds.map((id) => {
    const review = reviewsById.get(id);
    if (
      review === undefined ||
      review.problemId !== problem.id ||
      review.expectedRound !== problem.reviewRound
    ) {
      throw reviewSuggestionUnavailable();
    }
    if (
      !Number.isInteger(review.codeforcesDifficulty) ||
      review.codeforcesDifficulty < 800 ||
      review.codeforcesDifficulty > 3500 ||
      review.codeforcesDifficulty % 100 !== 0 ||
      !isDifficultyLevel(review.qualityLevel) ||
      (review.originalityLevel !== null && !isDifficultyLevel(review.originalityLevel)) ||
      !isDifficultyLevel(review.thinkingLevel) ||
      !isDifficultyLevel(review.codingLevel)
    ) {
      throw reviewSuggestionUnavailable();
    }
    return review;
  });

  const tagIds = [...new Set(countedReviews.flatMap((review) => review.tagIds))].sort();
  if (
    tagIds.length > 30 ||
    tagIds.some((tagId) => tagId.length === 0 || tagId.length > 120)
  ) {
    throw reviewSuggestionUnavailable();
  }

  const averageCodeforcesDifficulty = countedReviews.reduce(
    (sum, review) => sum + review.codeforcesDifficulty,
    0
  ) / countedReviews.length;
  const originalityLevels = countedReviews.flatMap((review) =>
    review.originalityLevel === null ? [] : [review.originalityLevel]
  );
  return {
    codeforcesDifficulty: Math.floor(averageCodeforcesDifficulty / 100 + 0.5) * 100,
    thinkingLevel: medianLevel(countedReviews.map((review) => review.thinkingLevel)),
    codingLevel: medianLevel(countedReviews.map((review) => review.codingLevel)),
    tagIds,
    qualityLevel: medianLevel(countedReviews.map((review) => review.qualityLevel)),
    originalityLevel: originalityLevels.length === 0 ? null : medianLevel(originalityLevels),
    opinionCount: countedReviews.length
  };
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

function judgeConfigTypeErrors(
  type: StoredProblem["type"],
  config: ProblemJudgeConfig | null | undefined
): FieldErrors | undefined {
  if (config === null || config === undefined) {
    return undefined;
  }

  const errors: FieldErrors = {};
  if (type === "traditional") {
    if (config.interactor !== undefined) {
      errors["judgeConfig.interactor"] = ["传统题不能设置交互程序。"];
    }
    if (config.answerChecker !== undefined) {
      errors["judgeConfig.answerChecker"] = ["传统题不能设置答案判断程序。"];
    }
  } else if (type === "interactive") {
    if (config.checker !== undefined) {
      errors["judgeConfig.checker"] = ["交互题不能设置传统题判断程序。"];
    }
    if (config.answerChecker !== undefined) {
      errors["judgeConfig.answerChecker"] = ["交互题不能设置答案判断程序。"];
    }
  } else {
    if (config.checker !== undefined) {
      errors["judgeConfig.checker"] = ["提交答案题不能设置传统题判断程序。"];
    }
    if (config.interactor !== undefined) {
      errors["judgeConfig.interactor"] = ["提交答案题不能设置交互程序。"];
    }
  }

  return Object.keys(errors).length === 0 ? undefined : errors;
}

function assertJudgeConfigMatchesType(
  type: StoredProblem["type"],
  config: ProblemJudgeConfig | null | undefined
): void {
  const errors = judgeConfigTypeErrors(type, config);
  if (errors !== undefined) {
    throw new ApiError(
      422,
      "INVALID_JUDGE_CONFIG",
      "评测程序配置与题目类型不一致。",
      errors
    );
  }
}

function assertCreateHasNoJudgeProgramReference(
  config: ProblemJudgeConfig | null | undefined
): void {
  const hasReference =
    config?.checker?.type === "special" ||
    config?.interactor !== undefined ||
    config?.answerChecker !== undefined;
  if (hasReference) {
    throw new ApiError(
      422,
      "INVALID_JUDGE_PROGRAM_REFERENCE",
      "请先创建题目，再通过数据与评测页上传并绑定评测程序。"
    );
  }
}

export class ProblemService {
  private readonly now: () => Date;
  private readonly submitChecks: SubmitCheckRunner | undefined;
  private readonly reviewItems: ReviewItemStore | undefined;
  private readonly reviewDecisions: ReviewDecisionRunner;
  private readonly judgeConfigRevisionAction: ProblemServiceOptions["judgeConfigRevisionAction"];

  public constructor(
    private readonly store: DataStore,
    options: ProblemServiceOptions = {}
  ) {
    this.now = options.now ?? (() => new Date());
    this.submitChecks = options.submitChecks;
    this.reviewItems = options.reviewItems;
    this.reviewDecisions = options.reviewDecisions ?? new DefaultReviewDecisionRunner();
    this.judgeConfigRevisionAction = options.judgeConfigRevisionAction;
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
        isHuman && hasPermission(user, "plugin.manage", {}, now),
      canManageTags:
        isHuman && hasPermission(user, "tag.manage", {}, now)
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
    assertJudgeConfigMatchesType(input.type, input.judgeConfig);
    assertCreateHasNoJudgeProgramReference(input.judgeConfig);

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
    this.assertExpectedRevision(current, input.expectedRevision);
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
    assertJudgeConfigMatchesType(next.type, next.judgeConfig);
    const combinedRevisionAction = this.judgeConfigRevisionAction === undefined
      ? revisionAction
      : async (revisionId: string, executor: DatabaseExecutor) => {
          await revisionAction?.(revisionId, executor);
          await this.judgeConfigRevisionAction?.(next, revisionId, executor);
        };
    const updated = combinedRevisionAction === undefined
      ? await this.store.replaceProblem(next, input.expectedRevision, user.id)
      : await this.store.replaceProblemWithRevisionAction?.(
        next,
        input.expectedRevision,
        user.id,
        combinedRevisionAction
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
    assertJudgeConfigMatchesType(current.type, current.judgeConfig);
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
    const initialInput = submitCheckInputFor(probe);
    const outcome = await this.submitChecks.runSimilarity(initialInput);

    return this.store.runProblemTransaction(problemId, async (transaction) => {
      const refreshedUser = await transaction.lockUserForAuthorization(user.id);
      const checkedAt = this.now();
      if (
        refreshedUser === undefined ||
        refreshedUser.disabled ||
        !hasPermission(refreshedUser, "auth.login", {}, checkedAt)
      ) {
        throw unauthorized();
      }
      const refreshed = transaction.getProblem();
      if (
        refreshed === undefined ||
        !canViewProblem(createProblemVisibility(refreshedUser, checkedAt), refreshed)
      ) {
        throw notFound();
      }
      const refreshedTarget = { ownerId: refreshed.ownerId, objectId: refreshed.id };
      const mayStillReview =
        hasPermission(refreshedUser, "problem.review", refreshedTarget, checkedAt) ||
        hasPermission(refreshedUser, "problem.status.change", refreshedTarget, checkedAt);
      if (!canEditProblem(refreshedUser, refreshed, checkedAt) && !mayStillReview) {
        throw forbidden();
      }
      const refreshedProbe: StoredProblem = {
        ...refreshed,
        reviewRound: Math.max(1, refreshed.reviewRound)
      };
      if (
        refreshed.revision !== current.revision ||
        refreshed.reviewRound !== current.reviewRound ||
        refreshed.status !== current.status ||
        submitCheckInputFor(refreshedProbe).contentHash !== initialInput.contentHash
      ) {
        throw conflict("题目已在检索期间发生变化，请重新检查。");
      }
      if (outcome.checksRun === 0 || outcome.similarityStatus === undefined) {
        return { status: "unavailable", blockedAdvice: null, items: [] };
      }
      if (
        refreshed.status === "pending_review" &&
        refreshed.reviewRound >= 1 &&
        this.reviewItems !== undefined &&
        outcome.reviewItems.length > 0
      ) {
        await this.reviewItems.replacePluginItems(
          refreshed.id,
          refreshed.reviewRound,
          outcome.reviewItems,
          transaction.executor
        );
      }
      const blockedAdvice =
        outcome.blocked?.code === "anklang_similar_problem" ||
        outcome.blocked?.code === "anklang_partial_same_problem"
          ? outcome.blocked
          : null;
      return {
        status: outcome.similarityStatus === "complete" ? "completed" : outcome.similarityStatus,
        blockedAdvice,
        items: outcome.reviewItems.map((item) => inputItemToView(item, asIso(checkedAt)))
      };
    });
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
    if (problem.reviewRound === 0) {
      throw conflict("题目尚未提交审核，因此还没有审核轮次。");
    }

    return this.aggregateReviewRound(problem, user);
  }

  public async getReviewSuggestions(
    user: StoredUser,
    problemId: string
  ): Promise<ReviewSuggestionView> {
    await this.findVisibleProblem(user, problemId);
    return this.store.runProblemTransaction(problemId, async (transaction) => {
      const problem = transaction.getProblem();
      const actor = transaction.listUsers().find((candidate) => candidate.id === user.id);
      const evaluatedAt = this.now();
      if (
        problem === undefined ||
        actor === undefined ||
        !canViewProblem(createProblemVisibility(actor, evaluatedAt), problem)
      ) {
        throw notFound();
      }

      const roundState = this.requireApprovedSuggestionRound(problem);
      const aggregate = aggregateFrozenReviewSuggestions(
        problem,
        roundState,
        transaction.listReviews(problem.reviewRound)
      );
      const target = { ownerId: problem.ownerId, objectId: problem.id };
      const { opinionCount, ...suggested } = aggregate;
      return {
        round: problem.reviewRound,
        opinionCount,
        current: {
          codeforcesDifficulty: problem.codeforcesDifficulty,
          thinkingLevel: problem.thinkingLevel,
          codingLevel: problem.codingLevel,
          tagIds: [...problem.tagIds]
        },
        suggested,
        canApply:
          actor.accountType === "human" &&
          hasPermission(actor, "problem.status.change", target, evaluatedAt) &&
          canEditProblem(actor, problem, evaluatedAt)
      };
    });
  }

  public async applyReviewSuggestions(
    user: StoredUser,
    problemId: string,
    input: ApplyReviewSuggestionsInput,
    requestId: string
  ): Promise<Problem> {
    await this.findVisibleProblem(user, problemId);
    const updated = await this.store.runProblemTransaction(problemId, async (transaction) => {
      const problem = transaction.getProblem();
      const actor = transaction.listUsers().find((candidate) => candidate.id === user.id);
      const evaluatedAt = this.now();
      if (
        problem === undefined ||
        actor === undefined ||
        !canViewProblem(createProblemVisibility(actor, evaluatedAt), problem)
      ) {
        throw notFound();
      }

      const target = { ownerId: problem.ownerId, objectId: problem.id };
      if (
        actor.accountType !== "human" ||
        !hasPermission(actor, "problem.status.change", target, evaluatedAt) ||
        !canEditProblem(actor, problem, evaluatedAt)
      ) {
        throw forbidden();
      }
      const roundState = this.requireApprovedSuggestionRound(problem);
      if (input.expectedRound !== problem.reviewRound) {
        throw conflict("审核轮次已变化，请刷新后重试。");
      }
      this.assertExpectedRevision(problem, input.expectedRevision);

      const aggregate = aggregateFrozenReviewSuggestions(
        problem,
        roundState,
        transaction.listReviews(problem.reviewRound)
      );
      const selectedFields = new Set(input.fields);
      if (
        selectedFields.has("tagIds") &&
        (aggregate.tagIds.length === 0 || !(await transaction.hasTags(aggregate.tagIds)))
      ) {
        throw reviewSuggestionUnavailable();
      }
      const next: StoredProblem = {
        ...problem,
        codeforcesDifficulty: selectedFields.has("codeforcesDifficulty")
          ? aggregate.codeforcesDifficulty
          : problem.codeforcesDifficulty,
        thinkingLevel: selectedFields.has("thinkingLevel")
          ? aggregate.thinkingLevel
          : problem.thinkingLevel,
        codingLevel: selectedFields.has("codingLevel")
          ? aggregate.codingLevel
          : problem.codingLevel,
        tagIds: selectedFields.has("tagIds") ? [...aggregate.tagIds] : [...problem.tagIds],
        revision: problem.revision + 1,
        updatedAt: asIso(evaluatedAt)
      };
      if (!transaction.replaceProblem(next, problem.revision, actor.id)) {
        throw conflict("题目已被其他操作修改，请刷新后重试。");
      }
      await transaction.writeReviewSuggestionAudit({
        actorUserId: actor.id,
        requestId,
        problemId: problem.id,
        round: problem.reviewRound,
        previousRevision: problem.revision,
        nextRevision: next.revision,
        fields: [...input.fields],
        opinionCount: aggregate.opinionCount
      });
      return next;
    });
    return this.toProblem(updated, user);
  }

  public async submitReview(
    user: StoredUser,
    problemId: string,
    input: ReviewInput,
    requestId?: string
  ): Promise<ReviewRoundSummary> {
    await this.findVisibleProblem(user, problemId);
    const result = await this.store.runProblemTransaction(problemId, (transaction) =>
      this.submitReviewInTransaction(transaction, user, problemId, input, requestId)
    );
    return result.summary;
  }

  /**
   * Shares the caller's already locked problem transaction. Robot completion
   * uses this entry point so its opinion, lease closure, round decision and
   * audit record either all commit or all roll back.
   */
  public async submitReviewInTransaction(
    transaction: ProblemTransaction,
    user: StoredUser,
    problemId: string,
    input: ReviewInput,
    requestId?: string,
  ): Promise<{ readonly summary: ReviewRoundSummary; readonly opinionId: string }> {
      const problem = transaction.getProblem();
      const users = transaction.listUsers();
      const storedActor = users.find((candidate) => candidate.id === user.id);
      const actor = user.accountType === "robot" ? user : storedActor;
      if (
        problem === undefined ||
        problem.id !== problemId ||
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
      if (actor.accountType === "human" && input.originalityLevel == null) {
        throw new ApiError(
          422,
          "ORIGINALITY_LEVEL_REQUIRED",
          "人工审核意见必须填写原创性等级。",
          { originalityLevel: ["请选择 1 至 5 的原创性等级。"] }
        );
      }
      if (
        new Set(input.tagIds).size !== input.tagIds.length ||
        !(await transaction.hasTags(input.tagIds))
      ) {
        throw new ApiError(422, "INVALID_TAGS", "知识点中包含无效或重复项。", {
          tagIds: ["请选择存在且不重复的知识点。"]
        });
      }

      const existing = transaction
        .listReviews(problem.reviewRound)
        .find((review) => review.reviewerId === actor.id);
      const now = asIso(this.now());
      const review: StoredReview = {
        ...input,
        originalityLevel: input.originalityLevel ?? null,
        publicComment: input.publicComment ?? "",
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
      const effectiveUsers = users.map((candidate) =>
        candidate.id === actor.id ? actor : candidate
      );
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
          this.createReviewRoundSnapshot(problem, reviews, effectiveUsers, reviewItems, evaluatedAt),
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
        return {
          opinionId: review.id,
          summary: this.buildReviewRoundSummary(
            problem,
            reviews,
            effectiveUsers,
            actor,
            decision,
            true
          )
        };
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
      return {
        opinionId: review.id,
        summary: this.buildReviewRoundSummary(
          next,
          reviews,
          effectiveUsers,
          actor,
          decision,
          true
        )
      };
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
    if (
      tagIds.length < 1 ||
      tagIds.length > 30 ||
      new Set(tagIds).size !== tagIds.length ||
      !(await this.store.hasTags(tagIds))
    ) {
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
      viewerCanChangeStatus || viewerCanReview;
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
        codeforcesDifficulty: review.codeforcesDifficulty,
        qualityLevel: review.qualityLevel,
        originalityLevel: review.originalityLevel,
        thinkingLevel: review.thinkingLevel,
        codingLevel: review.codingLevel,
        tagIds: [...review.tagIds],
        improvements: review.improvements,
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

  private requireApprovedSuggestionRound(problem: StoredProblem): StoredReviewRoundState {
    const roundState = problem.reviewRoundState;
    if (
      problem.status !== "approved" ||
      problem.reviewRound <= 0 ||
      roundState === undefined ||
      roundState.round !== problem.reviewRound ||
      roundState.status !== "approved"
    ) {
      throw conflict("只有当前审核轮次已经通过并关闭的题目可以使用审核建议。");
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
