import {
  defaultReviewDecisionRule,
  defaultReviewRuleId,
  defaultReviewRuleSettingsSchema
} from "@urmotiv/plugin-review-default";
import type { AvailableReviewRule } from "@urmotiv/contracts";
import type { DatabaseExecutor } from "@urmotiv/database";
import type { ReviewDecision, ReviewRoundSnapshot } from "@urmotiv/plugin-sdk";
import type { StoredReviewRule } from "./domain";
import { TrustedPluginHost } from "./plugin-host";

const defaultPluginVersion = "1.0.0";
const reviewDecisionTimeoutMs = 2_000;

export interface ReviewDecisionRunner {
  listAvailableRules(): Promise<readonly AvailableReviewRule[]>;
  prepareRule(
    ruleId: string,
    settings: Record<string, unknown>,
    expectedPluginVersion?: string,
    executor?: DatabaseExecutor
  ): Promise<StoredReviewRule>;
  evaluate(
    rule: StoredReviewRule,
    snapshot: ReviewRoundSnapshot,
    evaluatedAt: Date,
    executor?: DatabaseExecutor
  ): Promise<ReviewDecision>;
}

export class ReviewRuleUnavailableError extends Error {
  public constructor() {
    super("当前审核规则不可用。");
    this.name = "ReviewRuleUnavailableError";
  }
}

export function initialReviewPolicyRule(): StoredReviewRule {
  return {
    ruleId: defaultReviewRuleId,
    pluginVersion: defaultPluginVersion,
    settings: defaultReviewRuleSettingsSchema.parse({})
  };
}

export class PluginReviewDecisionRunner implements ReviewDecisionRunner {
  public constructor(private readonly host: TrustedPluginHost) {}

  public async listAvailableRules(): Promise<readonly AvailableReviewRule[]> {
    return this.host.listEnabledReviewRules();
  }

  public async prepareRule(
    ruleId: string,
    settings: Record<string, unknown>,
    expectedPluginVersion?: string,
    executor?: DatabaseExecutor
  ): Promise<StoredReviewRule> {
    try {
      const prepared = await this.host.prepareReviewRule(ruleId, settings, executor);
      if (
        expectedPluginVersion !== undefined &&
        prepared.pluginVersion !== expectedPluginVersion
      ) {
        throw new ReviewRuleUnavailableError();
      }
      return {
        ruleId: prepared.ruleId,
        pluginVersion: prepared.pluginVersion,
        settings: requireSettingsObject(prepared.settings)
      };
    } catch {
      throw new ReviewRuleUnavailableError();
    }
  }

  public async evaluate(
    rule: StoredReviewRule,
    snapshot: ReviewRoundSnapshot,
    evaluatedAt: Date,
    executor?: DatabaseExecutor
  ): Promise<ReviewDecision> {
    try {
      const prepared = await this.prepareRule(
        rule.ruleId,
        rule.settings,
        rule.pluginVersion,
        executor
      );
      return await withTimeout(
        this.host.evaluateReviewDecision(
          prepared.ruleId,
          snapshot,
          prepared.settings,
          evaluatedAt.getTime(),
          executor
        )
      );
    } catch {
      throw new ReviewRuleUnavailableError();
    }
  }
}

/** Used by direct service tests; production always injects the plugin-host runner. */
export class DefaultReviewDecisionRunner implements ReviewDecisionRunner {
  public async listAvailableRules(): Promise<readonly AvailableReviewRule[]> {
    return [{
      id: defaultReviewRuleId,
      displayName: defaultReviewDecisionRule.displayName,
      pluginVersion: defaultPluginVersion,
      settingsSchema: null
    }];
  }

  public async prepareRule(
    ruleId: string,
    settings: Record<string, unknown>,
    expectedPluginVersion?: string,
    _executor?: DatabaseExecutor
  ): Promise<StoredReviewRule> {
    if (
      ruleId !== defaultReviewRuleId ||
      (expectedPluginVersion !== undefined && expectedPluginVersion !== defaultPluginVersion)
    ) {
      throw new ReviewRuleUnavailableError();
    }
    try {
      return {
        ruleId,
        pluginVersion: defaultPluginVersion,
        settings: defaultReviewRuleSettingsSchema.parse(settings)
      };
    } catch {
      throw new ReviewRuleUnavailableError();
    }
  }

  public async evaluate(
    rule: StoredReviewRule,
    snapshot: ReviewRoundSnapshot,
    _evaluatedAt: Date,
    _executor?: DatabaseExecutor
  ): Promise<ReviewDecision> {
    const prepared = await this.prepareRule(rule.ruleId, rule.settings, rule.pluginVersion);
    return defaultReviewDecisionRule.evaluate(
      snapshot,
      defaultReviewRuleSettingsSchema.parse(prepared.settings)
    );
  }
}

function requireSettingsObject(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ReviewRuleUnavailableError();
  }
  return structuredClone(value as Record<string, unknown>);
}

async function withTimeout<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new ReviewRuleUnavailableError()), reviewDecisionTimeoutMs);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}
