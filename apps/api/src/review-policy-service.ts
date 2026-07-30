import type {
  ReviewPolicyView,
  UpdateReviewPolicyInput
} from "@urmotiv/contracts";
import type { StoredUser } from "./domain";
import type { StoredReviewRule } from "./domain";
import { ApiError, conflict, forbidden } from "./errors";
import { hasPermission } from "./permissions";
import type { DataStore } from "./repository";
import {
  ReviewRuleUnavailableError,
  type ReviewDecisionRunner
} from "./review-decision";

export class ReviewPolicyService {
  public constructor(
    private readonly store: DataStore,
    private readonly decisions: ReviewDecisionRunner,
    private readonly now: () => Date = () => new Date()
  ) {}

  public assertCanManage(user: StoredUser): void {
    if (
      user.accountType !== "human" ||
      !hasPermission(user, "problem.status.change", {}, this.now())
    ) {
      throw forbidden();
    }
  }

  public async get(user: StoredUser): Promise<ReviewPolicyView> {
    this.assertCanManage(user);
    const [policy, availableRules] = await Promise.all([
      this.store.getReviewPolicy(),
      this.decisions.listAvailableRules()
    ]);
    return {
      selectedRuleId: policy.ruleId,
      selectedPluginVersion: policy.pluginVersion,
      settings: structuredClone(policy.settings),
      revision: policy.revision,
      selectedRuleAvailable: availableRules.some(
        (rule) => rule.id === policy.ruleId && rule.pluginVersion === policy.pluginVersion
      ),
      availableRules: [...availableRules]
    };
  }

  public async update(
    user: StoredUser,
    input: UpdateReviewPolicyInput,
    requestId: string
  ): Promise<ReviewPolicyView> {
    this.assertCanManage(user);
    let prepared: StoredReviewRule;
    try {
      prepared = await this.decisions.prepareRule(input.ruleId, input.settings);
    } catch (error) {
      if (error instanceof ReviewRuleUnavailableError) {
        throw new ApiError(
          422,
          "REVIEW_RULE_UNAVAILABLE",
          "所选审核规则当前未启用，或它的设置不符合要求。"
        );
      }
      throw error;
    }

    const next = {
      ...prepared,
      revision: input.expectedRevision + 1,
      updatedByUserId: user.id,
      updatedAt: this.now().toISOString()
    };
    if (!await this.store.replaceReviewPolicy(next, input.expectedRevision, user.id, requestId)) {
      throw conflict("审核规则已被其他操作修改，请刷新后重试。");
    }
    return this.get(user);
  }

}
