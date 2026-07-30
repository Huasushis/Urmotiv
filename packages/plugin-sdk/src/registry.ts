import type { ProblemFormatAdapter } from "@urmotiv/problem-package";
import { corePermissions } from "@urmotiv/contracts";
import { z } from "zod";
import {
  type BeforeSubmitCheck,
  type BeforeSubmitInput,
  type BeforeSubmitResult,
  beforeSubmitInputSchema,
  beforeSubmitResultSchema,
  type ReviewDecision,
  type ReviewDecisionRule,
  type ReviewOpinion,
  reviewDecisionSchema,
  type ReviewItem,
  type ReviewItemInput,
  reviewItemInputSchema,
  type ReviewItemType,
  type ReviewRoundSnapshot,
  reviewRoundSnapshotSchema,
  type PluginManifest,
  pluginManifestSchema
} from "./types";

const registrationIdSchema = z
  .string()
  .min(1)
  .max(160)
  .regex(/^[a-z0-9]+(?:[._-][a-z0-9]+)*$/);

const timeoutSchema = z.number().int().min(1).max(300_000);
const corePermissionNames = new Set<string>(corePermissions);

interface StoredReviewItemType {
  readonly type: string;
  readonly displayName: string;
  parse(data: unknown): unknown;
}

interface StoredReviewDecisionRule {
  readonly id: string;
  readonly displayName: string;
  readonly supportedReviewItemTypes: ReadonlySet<string>;
  parseSettings(settings: unknown): unknown;
  evaluate(input: ReviewRoundSnapshot, settings: unknown): Promise<unknown>;
}

export class PluginRegistryError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "PluginRegistryError";
  }
}

export class PluginRegistry {
  readonly #manifests = new Map<string, PluginManifest>();
  readonly #beforeSubmitChecks = new Map<string, BeforeSubmitCheck>();
  readonly #reviewItemTypes = new Map<string, StoredReviewItemType>();
  readonly #reviewRules = new Map<string, StoredReviewDecisionRule>();
  readonly #formatAdapters = new Map<string, ProblemFormatAdapter>();
  #registeringPluginId: string | undefined;
  #locked = false;

  public registerPluginManifest(manifest: unknown): void {
    this.ensureOpen();
    const parsed = pluginManifestSchema.parse(manifest);
    const permissionPrefix = `${parsed.id}.`;
    for (const permission of parsed.permissions) {
      if (corePermissionNames.has(permission)) {
        throw new PluginRegistryError(`插件不能声明核心权限 ${permission}。`);
      }
      if (!permission.startsWith(permissionPrefix)) {
        throw new PluginRegistryError(
          `插件权限 ${permission} 必须以 ${permissionPrefix} 开头，表明它属于这个插件。`
        );
      }
    }
    if (this.#manifests.has(parsed.id)) {
      throw new PluginRegistryError(`插件 ${parsed.id} 已经注册。`);
    }
    this.#manifests.set(
      parsed.id,
      Object.freeze({ ...parsed, permissions: [...parsed.permissions] })
    );
  }

  public registerBeforeSubmitCheck(check: BeforeSubmitCheck): void {
    this.ensureOpen();
    const id = registrationIdSchema.parse(check.id);
    this.ensureOwnedRegistration(id);
    z.string().trim().min(1).max(120).parse(check.displayName);
    timeoutSchema.parse(check.timeoutMs);
    z.enum(["block", "continue"]).parse(check.failureBehavior);
    ensureFunction(check.run, "提交前检查必须提供运行函数。");
    if (this.#beforeSubmitChecks.has(id)) {
      throw new PluginRegistryError(`提交前检查 ${id} 已经注册。`);
    }
    const stored = Object.freeze({
      id,
      displayName: check.displayName,
      timeoutMs: check.timeoutMs,
      failureBehavior: check.failureBehavior,
      run: check.run.bind(check)
    });
    this.#beforeSubmitChecks.set(id, stored);
  }

  public registerReviewItemType<TData>(itemType: ReviewItemType<TData>): void {
    this.ensureOpen();
    const type = registrationIdSchema.parse(itemType.type);
    this.ensureOwnedRegistration(type);
    z.string().trim().min(1).max(120).parse(itemType.displayName);
    ensureFunction(itemType.dataSchema.parse, "审核条目类型必须提供数据校验。"
    );
    if (this.#reviewItemTypes.has(type)) {
      throw new PluginRegistryError(`审核条目类型 ${type} 已经注册。`);
    }
    this.#reviewItemTypes.set(
      type,
      Object.freeze({
        type,
        displayName: itemType.displayName,
        parse: (data: unknown): TData => itemType.dataSchema.parse(data)
      })
    );
  }

  public registerReviewDecisionRule<TSettings>(rule: ReviewDecisionRule<TSettings>): void {
    this.ensureOpen();
    const id = registrationIdSchema.parse(rule.id);
    this.ensureOwnedRegistration(id);
    z.string().trim().min(1).max(120).parse(rule.displayName);
    ensureFunction(rule.settingsSchema.parse, "审核规则必须提供设置校验。"
    );
    ensureFunction(rule.evaluate, "审核规则必须提供判断函数。");
    if (this.#reviewRules.has(id)) {
      throw new PluginRegistryError(`审核规则 ${id} 已经注册。`);
    }

    const supportedTypes = new Set(
      rule.supportedReviewItemTypes.map((type) => registrationIdSchema.parse(type))
    );
    const evaluate = rule.evaluate.bind(rule);
    this.#reviewRules.set(
      id,
      Object.freeze({
        id,
        displayName: rule.displayName,
        supportedReviewItemTypes: supportedTypes,
        parseSettings: (settings: unknown): TSettings => rule.settingsSchema.parse(settings),
        evaluate: async (input: ReviewRoundSnapshot, settings: unknown): Promise<unknown> =>
          evaluate(input, settings as TSettings)
      })
    );
  }

  public registerProblemFormatAdapter(adapter: ProblemFormatAdapter): void {
    this.ensureOpen();
    const id = registrationIdSchema.parse(adapter.id);
    this.ensureOwnedRegistration(id);
    z.string().trim().min(1).max(120).parse(adapter.displayName);
    z.string().trim().min(1).max(80).parse(adapter.version);
    const inputKind = z.enum(["zip", "single_file"]).parse(adapter.inputKind ?? "zip");
    ensureFunction(adapter.detect, "题目包格式必须提供识别函数。");
    ensureFunction(adapter.inspect, "题目包格式必须提供预览函数。");
    ensureFunction(adapter.import, "题目包格式必须提供导入函数。");
    ensureFunction(adapter.validateExport, "题目包格式必须提供导出检查函数。");
    ensureFunction(adapter.export, "题目包格式必须提供导出函数。");
    if (this.#formatAdapters.has(id)) {
      throw new PluginRegistryError(`题目包格式 ${id} 已经注册。`);
    }
    this.#formatAdapters.set(
      id,
      Object.freeze({
        id,
        displayName: adapter.displayName,
        version: adapter.version,
        inputKind,
        detect: adapter.detect.bind(adapter),
        inspect: adapter.inspect.bind(adapter),
        import: adapter.import.bind(adapter),
        validateExport: adapter.validateExport.bind(adapter),
        export: adapter.export.bind(adapter)
      })
    );
  }

  /** Locks registration after startup so request-time code cannot replace handlers. */
  public lock(): void {
    if (this.#registeringPluginId !== undefined) {
      throw new PluginRegistryError("插件钩子注册尚未结束，不能锁定注册表。");
    }
    this.#locked = true;
  }

  /**
   * Runs a bundled plugin's registration code while checking that every hook
   * name belongs to that plugin. The host calls this only during startup.
   */
  public registerPluginHooks(pluginId: string, register: () => void): void {
    this.ensureOpen();
    const parsedPluginId = registrationIdSchema.parse(pluginId);
    if (!this.#manifests.has(parsedPluginId)) {
      throw new PluginRegistryError(`插件 ${parsedPluginId} 尚未登记清单。`);
    }
    if (this.#registeringPluginId !== undefined) {
      throw new PluginRegistryError("不能在一个插件注册过程中嵌套注册另一个插件。");
    }
    this.#registeringPluginId = parsedPluginId;
    try {
      register();
    } finally {
      this.#registeringPluginId = undefined;
    }
  }

  public isLocked(): boolean {
    return this.#locked;
  }

  public listBeforeSubmitChecks(): readonly {
    readonly id: string;
    readonly displayName: string;
  }[] {
    return [...this.#beforeSubmitChecks.values()].map(({ id, displayName }) => ({
      id,
      displayName
    }));
  }

  public listPluginManifests(): readonly PluginManifest[] {
    return [...this.#manifests.values()].map((manifest) => ({
      ...manifest,
      permissions: [...manifest.permissions]
    }));
  }

  public listReviewRules(): readonly { readonly id: string; readonly displayName: string }[] {
    return [...this.#reviewRules.values()].map(({ id, displayName }) => ({ id, displayName }));
  }

  /** Validates rule settings and returns the defaults-filled value used at runtime. */
  public normalizeReviewRuleSettings(ruleId: string, settings: unknown): unknown {
    this.ensureLocked();
    const rule = this.#reviewRules.get(ruleId);
    if (rule === undefined) {
      throw new PluginRegistryError(`没有注册审核规则 ${ruleId}。`);
    }
    return structuredClone(rule.parseSettings(settings));
  }

  public listProblemFormatAdapters(): readonly {
    readonly id: string;
    readonly displayName: string;
    readonly version: string;
  }[] {
    return [...this.#formatAdapters.values()].map(({ id, displayName, version }) => ({
      id,
      displayName,
      version
    }));
  }

  public getProblemFormatAdapter(id: string): ProblemFormatAdapter {
    this.ensureLocked();
    const adapter = this.#formatAdapters.get(id);
    if (adapter === undefined) {
      throw new PluginRegistryError(`没有注册题目包格式 ${id}。`);
    }
    return adapter;
  }

  /**
   * Runs checks in the explicit administrator-configured order. A later block
   * discards every earlier continue result, so a check can never grant access
   * or permission that another check denied.
   */
  public async runBeforeSubmit(
    input: BeforeSubmitInput,
    orderedCheckIds: readonly string[],
    signal?: AbortSignal
  ): Promise<BeforeSubmitResult> {
    this.ensureLocked();
    const parsedInput = deepFreeze(beforeSubmitInputSchema.parse(input));
    ensureUniqueIds(orderedCheckIds, "提交前检查顺序中有重复编号。");
    const reviewItems: ReviewItemInput[] = [];

    for (const checkId of orderedCheckIds) {
      const check = this.#beforeSubmitChecks.get(checkId);
      if (check === undefined) {
        throw new PluginRegistryError(`没有注册提交前检查 ${checkId}。`);
      }

      let result: BeforeSubmitResult;
      try {
        result = beforeSubmitResultSchema.parse(
          await runCheckWithTimeout(check, parsedInput, signal)
        );
        if (result.decision === "continue") {
          for (const item of result.reviewItems ?? []) {
            reviewItems.push(this.validateReviewItemInput(item, parsedInput.contentHash));
          }
        }
      } catch (error) {
        if (error instanceof CheckCancelledError) {
          return {
            decision: "block",
            code: "submission_cancelled",
            message: "题目提交已取消。"
          };
        }
        if (check.failureBehavior === "block") {
          return {
            decision: "block",
            code:
              error instanceof CheckTimeoutError ? "plugin_check_timeout" : "plugin_check_failed",
            message:
              error instanceof CheckTimeoutError
                ? `${check.displayName}没有在规定时间内完成，题目尚未提交。`
                : `${check.displayName}未能完成，题目尚未提交。`
          };
        }
        continue;
      }

      if (result.decision === "block") {
        return result;
      }
    }

    return reviewItems.length === 0
      ? { decision: "continue" }
      : { decision: "continue", reviewItems };
  }

  public async evaluateReviewDecision(
    ruleId: string,
    input: ReviewRoundSnapshot,
    settings: unknown,
    evaluatedAt: number = Date.now()
  ): Promise<ReviewDecision> {
    this.ensureLocked();
    const rule = this.#reviewRules.get(ruleId);
    if (rule === undefined) {
      throw new PluginRegistryError(`没有注册审核规则 ${ruleId}。`);
    }

    const parsedInput = reviewRoundSnapshotSchema.parse(input);
    const opinions = latestEligibleOpinions(parsedInput);
    const reviewItems = parsedInput.reviewItems
      .filter(
        (item) =>
          rule.supportedReviewItemTypes.has(item.type) &&
          item.contentHash === parsedInput.contentHash &&
          (item.expiresAt === undefined || Date.parse(item.expiresAt) > evaluatedAt)
      )
      .map((item) => this.validateStoredReviewItem(item));
    const ruleInput = deepFreeze({ ...parsedInput, opinions, reviewItems });
    const parsedSettings = rule.parseSettings(settings);
    const decision = reviewDecisionSchema.parse(await rule.evaluate(ruleInput, parsedSettings));
    validateReviewDecisionReferences(
      decision,
      ruleInput,
      rule.supportedReviewItemTypes,
      evaluatedAt
    );
    return decision;
  }

  private validateReviewItemInput(
    item: ReviewItemInput,
    expectedContentHash: string
  ): ReviewItemInput {
    const parsedItem = reviewItemInputSchema.parse(item);
    if (parsedItem.contentHash !== expectedContentHash) {
      throw new PluginRegistryError("审核条目对应的题目内容已经变化，不能复用。"
      );
    }
    const itemType = this.#reviewItemTypes.get(parsedItem.type);
    if (itemType === undefined) {
      throw new PluginRegistryError(`没有注册审核条目类型 ${parsedItem.type}。`);
    }
    return { ...parsedItem, data: itemType.parse(parsedItem.data) };
  }

  private validateStoredReviewItem(item: ReviewItem): ReviewItem {
    const itemType = this.#reviewItemTypes.get(item.type);
    if (itemType === undefined) {
      throw new PluginRegistryError(`没有注册审核条目类型 ${item.type}。`);
    }
    return { ...item, data: itemType.parse(item.data) };
  }

  private ensureOpen(): void {
    if (this.#locked) {
      throw new PluginRegistryError("插件注册已经结束，不能在请求过程中修改。"
      );
    }
  }

  private ensureLocked(): void {
    if (!this.#locked) {
      throw new PluginRegistryError("插件注册尚未锁定，不能开始处理请求。"
      );
    }
  }

  private ensureOwnedRegistration(id: string): void {
    if (this.#registeringPluginId === undefined) {
      return;
    }
    if (!id.startsWith(`${this.#registeringPluginId}.`)) {
      throw new PluginRegistryError(
        `插件 ${this.#registeringPluginId} 不能注册不属于自己的钩子 ${id}。`
      );
    }
  }
}

/** Returns a block if any result blocks, independent of continue result order. */
export function combineBeforeSubmitResults(
  results: readonly BeforeSubmitResult[]
): BeforeSubmitResult {
  const parsedResults = results.map((result) => beforeSubmitResultSchema.parse(result));
  const block = parsedResults.find((result) => result.decision === "block");
  if (block !== undefined) {
    return block;
  }

  const reviewItems = parsedResults.flatMap((result) =>
    result.decision === "continue" ? (result.reviewItems ?? []) : []
  );
  return reviewItems.length === 0
    ? { decision: "continue" }
    : { decision: "continue", reviewItems };
}

class CheckTimeoutError extends Error {}
class CheckCancelledError extends Error {}

async function runCheckWithTimeout(
  check: BeforeSubmitCheck,
  input: BeforeSubmitInput,
  parentSignal?: AbortSignal
): Promise<BeforeSubmitResult> {
  if (parentSignal?.aborted === true) {
    throw new CheckCancelledError();
  }

  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let removeParentListener: (() => void) | undefined;
  const interruption = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new CheckTimeoutError());
    }, check.timeoutMs);

    if (parentSignal !== undefined) {
      const cancel = (): void => {
        controller.abort();
        reject(new CheckCancelledError());
      };
      parentSignal.addEventListener("abort", cancel, { once: true });
      removeParentListener = () => parentSignal.removeEventListener("abort", cancel);
      if (parentSignal.aborted) {
        cancel();
      }
    }
  });

  try {
    const checkResult = controller.signal.aborted
      ? Promise.reject<BeforeSubmitResult>(new CheckCancelledError())
      : Promise.resolve(check.run(input, { signal: controller.signal }));
    return await Promise.race([
      checkResult,
      interruption
    ]);
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
    removeParentListener?.();
  }
}

function validateReviewDecisionReferences(
  decision: ReviewDecision,
  input: ReviewRoundSnapshot,
  supportedItemTypes: ReadonlySet<string>,
  evaluatedAt: number
): void {
  ensureUniqueIds(decision.usedOpinionIds, "审核规则重复引用了同一份意见。"
  );
  ensureUniqueIds(decision.usedReviewItemIds, "审核规则重复引用了同一条审核信息。"
  );

  const usableOpinions = new Set(
    input.opinions.map((opinion) => opinion.id)
  );
  if (decision.usedOpinionIds.some((id) => !usableOpinions.has(id))) {
    throw new PluginRegistryError("审核规则引用了旧轮次或已失效的意见。"
    );
  }

  const usableItems = new Set(
    input.reviewItems
      .filter(
        (item) =>
          supportedItemTypes.has(item.type) &&
          item.contentHash === input.contentHash &&
          (item.expiresAt === undefined || Date.parse(item.expiresAt) > evaluatedAt)
      )
      .map((item) => item.id)
  );
  if (decision.usedReviewItemIds.some((id) => !usableItems.has(id))) {
    throw new PluginRegistryError("审核规则引用了未声明支持的审核信息。"
    );
  }
}

function latestEligibleOpinions(input: ReviewRoundSnapshot): ReviewOpinion[] {
  const latestByReviewer = new Map<string, ReviewOpinion>();

  for (const opinion of input.opinions) {
    if (opinion.reviewRound !== input.round) {
      continue;
    }
    const previous = latestByReviewer.get(opinion.reviewerId);
    if (previous === undefined || Date.parse(opinion.updatedAt) > Date.parse(previous.updatedAt)) {
      latestByReviewer.set(opinion.reviewerId, opinion);
    }
  }

  const eligibleReviewerIds = new Set(
    [...latestByReviewer.values()]
      .filter((opinion) => opinion.reviewerCanReview)
      .map((opinion) => opinion.reviewerId)
  );
  return [...latestByReviewer.values()]
    .filter((opinion) => eligibleReviewerIds.has(opinion.reviewerId))
    .sort((left, right) => left.reviewerId.localeCompare(right.reviewerId));
}

function ensureUniqueIds(ids: readonly string[], message: string): void {
  if (new Set(ids).size !== ids.length) {
    throw new PluginRegistryError(message);
  }
}

function ensureFunction(
  value: unknown,
  message: string
): void {
  if (typeof value !== "function") {
    throw new PluginRegistryError(message);
  }
}

function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== "object" || value instanceof Uint8Array) {
    return value;
  }
  if (!Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) {
      deepFreeze(child);
    }
    Object.freeze(value);
  }
  return value;
}
