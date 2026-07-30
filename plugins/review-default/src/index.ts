import {
  type PluginRegistry,
  type ReviewDecisionRule,
  type ReviewOpinion,
  type ReviewRoundSnapshot
} from "@urmotiv/plugin-sdk";
import { z } from "zod";

export const defaultReviewRuleId = "org.ustc.urmotiv.review-default.count";

export const defaultReviewRuleSettingsSchema = z
  .object({
    requiredApprovals: z.number().int().min(1).max(100).default(2),
    maximumRejections: z.number().int().min(0).max(100).default(0),
    countRobotReviews: z.boolean().default(false)
  })
  .strict();

export type DefaultReviewRuleSettings = z.infer<typeof defaultReviewRuleSettingsSchema>;

export const defaultReviewDecisionRule: ReviewDecisionRule<DefaultReviewRuleSettings> = {
  id: defaultReviewRuleId,
  displayName: "默认审核人数规则",
  supportedReviewItemTypes: [],
  settingsSchema: defaultReviewRuleSettingsSchema,

  evaluate(input: ReviewRoundSnapshot, settings: DefaultReviewRuleSettings) {
    const usableOpinions = latestUsableOpinions(input, settings.countRobotReviews);
    const approvals = usableOpinions.filter((opinion) => opinion.verdict === "approve");
    const rejections = usableOpinions.filter((opinion) => opinion.verdict === "reject");
    const usedOpinionIds = usableOpinions.map((opinion) => opinion.id);

    if (rejections.length > settings.maximumRejections) {
      return {
        decision: "reject",
        usedOpinionIds,
        usedReviewItemIds: [],
        reason: `有 ${rejections.length} 份有效的不通过意见，超过允许的 ${settings.maximumRejections} 份。`
      };
    }

    if (approvals.length >= settings.requiredApprovals) {
      return {
        decision: "approve",
        usedOpinionIds,
        usedReviewItemIds: [],
        reason: `已有 ${approvals.length} 份有效的通过意见，达到所需的 ${settings.requiredApprovals} 份。`
      };
    }

    return {
      decision: "pending",
      usedOpinionIds,
      usedReviewItemIds: [],
      reason: `目前有 ${approvals.length} 份有效的通过意见，还需要达到 ${settings.requiredApprovals} 份。`
    };
  }
};

export function registerDefaultReviewPlugin(registry: PluginRegistry): void {
  registry.registerReviewDecisionRule(defaultReviewDecisionRule);
}

function latestUsableOpinions(
  input: ReviewRoundSnapshot,
  countRobotReviews: boolean
): readonly ReviewOpinion[] {
  const byReviewer = new Map<string, ReviewOpinion>();

  for (const opinion of input.opinions) {
    if (opinion.reviewRound !== input.round || !opinion.reviewerCanReview) {
      continue;
    }
    if (opinion.reviewerAccountType === "robot" && !countRobotReviews) {
      continue;
    }

    const previous = byReviewer.get(opinion.reviewerId);
    if (previous === undefined || Date.parse(opinion.updatedAt) > Date.parse(previous.updatedAt)) {
      byReviewer.set(opinion.reviewerId, opinion);
    }
  }

  return [...byReviewer.values()].sort((left, right) =>
    left.reviewerId.localeCompare(right.reviewerId)
  );
}
