import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import {
  pluginSettingsFormSchema,
  type AdminPlugin,
  type ParsedUpdatePluginInput,
  type PluginSettingsFormSchema
} from "@urmotiv/contracts";
import type { DatabaseExecutor } from "@urmotiv/database";
import {
  pluginManifestSchema,
  PluginRegistry,
  type BeforeSubmitInput,
  type BeforeSubmitResult,
  type PluginManifest,
  type ReviewDecision,
  type ReviewRoundSnapshot
} from "@urmotiv/plugin-sdk";
import { z } from "zod";

type JsonObject = Record<string, unknown>;

const stateSchema = z.enum(["enabled", "disabled", "failed"]);

export interface PluginSecretRecord {
  readonly name: string;
  readonly encryptedValue: string;
  readonly maskedSuffix: string;
  readonly valueLength: number | null;
}

export class PluginRevisionConflictError extends Error {
  public constructor() {
    super("插件设置已被其他管理员修改，请刷新后重试。");
    this.name = "PluginRevisionConflictError";
  }
}

export class PluginConfigurationError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "PluginConfigurationError";
  }
}

export class PluginSecretStorageUnavailableError extends Error {
  public constructor() {
    super("插件密钥保存配置不可用，请检查 URMOTIV_PLUGIN_SECRET_KEY。");
    this.name = "PluginSecretStorageUnavailableError";
  }
}

export class PluginUnavailableError extends Error {
  public constructor() {
    super("插件未启用，不能在请求中调用它的钩子。");
    this.name = "PluginUnavailableError";
  }
}

export interface StoredPlugin {
  readonly id: string;
  readonly displayName: string;
  readonly version: string;
  readonly apiVersion: string;
  readonly source: string;
  readonly manifestDigest: string;
  readonly state: z.infer<typeof stateSchema>;
  readonly failureCode: string | null;
  readonly settings: JsonObject;
  readonly settingsRevision: number;
  readonly secrets: readonly PluginSecretRecord[];
}

export type PluginUpdateFailureReason =
  | "permission_denied"
  | "invalid_input"
  | "plugin_not_found"
  | "revision_conflict"
  | "invalid_plugin_settings"
  | "internal_error";

export interface PluginUpdateSuccessAudit {
  readonly actorUserId: string;
  readonly requestId: string;
  readonly action: "plugin.update";
  readonly pluginId: string;
  readonly result: "success";
  readonly reasonCode: null;
  readonly metadata: {
    readonly changedState: boolean;
    readonly changedSettings: boolean;
    readonly changedSecretNames: readonly string[];
    readonly clearedSecretNames: readonly string[];
  };
}

export interface PluginUpdateAttemptAudit {
  readonly actorUserId: string;
  readonly requestId: string;
  readonly action: "plugin.update";
  readonly pluginId: string | null;
  readonly result: "denied" | "failure";
  readonly reasonCode: PluginUpdateFailureReason;
  readonly metadata: Record<string, never>;
}

export type PluginAuditEvent = PluginUpdateSuccessAudit | PluginUpdateAttemptAudit;

export interface PluginStore {
  list(): Promise<StoredPlugin[]>;
  get(pluginId: string, executor?: DatabaseExecutor): Promise<StoredPlugin | undefined>;
  hasStoredSecrets(): Promise<boolean>;
  upsertInstalled(plugin: Omit<StoredPlugin, "settings" | "settingsRevision" | "secrets">): Promise<void>;
  updateAndAudit(
    pluginId: string,
    input: {
      expectedRevision: number;
      state?: z.infer<typeof stateSchema>;
      settings?: JsonObject;
      encryptedSecrets?: readonly PluginSecretRecord[];
      clearSecretNames?: readonly string[];
      actorUserId: string;
    },
    event: PluginUpdateSuccessAudit
  ): Promise<StoredPlugin | undefined>;
  appendAudit(event: PluginUpdateAttemptAudit): Promise<void>;
}

export interface PluginSecretBox {
  encrypt(value: string): string;
  decrypt(value: string): string;
}

/** Encrypts plugin secrets with a server-provided 32-byte key. */
export class AesGcmPluginSecretBox implements PluginSecretBox {
  public constructor(private readonly key: Buffer) {
    if (key.length !== 32) {
      throw new Error("插件密钥保存需要 32 字节的服务器密钥。");
    }
  }

  public encrypt(value: string): string {
    const nonce = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key, nonce);
    const encrypted = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
    return Buffer.concat([nonce, cipher.getAuthTag(), encrypted]).toString("base64url");
  }

  public decrypt(value: string): string {
    const raw = Buffer.from(value, "base64url");
    if (raw.length < 29) {
      throw new Error("插件密钥保存内容无效。");
    }
    const decipher = createDecipheriv("aes-256-gcm", this.key, raw.subarray(0, 12));
    decipher.setAuthTag(raw.subarray(12, 28));
    return Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString("utf8");
  }
}

export function createPluginSecretBox(
  encodedKey: string | undefined
): AesGcmPluginSecretBox | undefined {
  if (encodedKey === undefined || encodedKey.length === 0) {
    return undefined;
  }
  if (!/^[A-Za-z0-9_-]{43}$/.test(encodedKey)) {
    throw new PluginSecretStorageUnavailableError();
  }
  let key: Buffer;
  try {
    key = Buffer.from(encodedKey, "base64url");
  } catch {
    throw new PluginSecretStorageUnavailableError();
  }
  if (key.length !== 32 || key.toString("base64url") !== encodedKey) {
    throw new PluginSecretStorageUnavailableError();
  }
  return new AesGcmPluginSecretBox(key);
}

export interface PluginSecretDefinition {
  readonly name: string;
  readonly label: string;
  readonly description: string;
}

export interface TrustedPluginDefinition {
  readonly manifest: unknown;
  /** A local build path or package name. It is shown to administrators, not fetched. */
  readonly source: string;
  readonly settingsSchema?: unknown;
  /** Settings descriptions for review rules registered by this plugin. */
  readonly reviewRuleSettingsSchemas?: Readonly<Record<string, unknown>>;
  /** Names of encrypted credentials the plugin is allowed to request. */
  readonly secretNames?: readonly string[];
  /** Chinese labels and descriptions shown without exposing secret values. */
  readonly secretDefinitions?: readonly PluginSecretDefinition[];
  /** State used only for the first installation; an existing administrator choice is preserved. */
  readonly initialState?: "enabled" | "disabled";
  readonly requiresRestart?: boolean;
  /** Only code compiled into this server may use this callback. */
  readonly registerHooks?: (registry: PluginRegistry) => void;
}

interface RegisteredPlugin {
  readonly manifest: PluginManifest;
  readonly source: string;
  readonly settingsSchema: PluginSettingsFormSchema | undefined;
  readonly settingsManagedBy: "plugin" | "review_policy" | "none";
  readonly reviewRuleSettingsSchemas: ReadonlyMap<string, PluginSettingsFormSchema>;
  readonly secretDefinitions: readonly PluginSecretDefinition[];
  readonly initialState: "enabled" | "disabled";
  readonly requiresRestart: boolean;
}

/**
 * The loader only accepts definitions bundled with the server. It reads no
 * package from the network or filesystem and never evaluates untrusted code.
 */
export class TrustedPluginHost {
  readonly #registry = new PluginRegistry();
  readonly #plugins = new Map<string, RegisteredPlugin>();

  public constructor(
    definitions: readonly TrustedPluginDefinition[],
    private readonly store: PluginStore,
    private readonly secretBox?: PluginSecretBox
  ) {
    for (const definition of definitions) {
      if (!definition.source.startsWith("builtin:")) {
        throw new Error("插件宿主只接受随服务发布的内置插件，不会加载外部代码。");
      }
      const manifest = pluginManifestSchema.parse(definition.manifest);
      this.#registry.registerPluginManifest(manifest);
      const settingsSchema = definition.settingsSchema === undefined
        ? undefined
        : pluginSettingsFormSchema.parse(definition.settingsSchema);
      const reviewRuleSettingsSchemas = new Map<string, PluginSettingsFormSchema>();
      for (const [ruleId, schema] of Object.entries(definition.reviewRuleSettingsSchemas ?? {})) {
        if (!ruleId.startsWith(`${manifest.id}.`)) {
          throw new Error(`审核规则 ${ruleId} 不属于插件 ${manifest.id}。`);
        }
        reviewRuleSettingsSchemas.set(ruleId, pluginSettingsFormSchema.parse(schema));
      }
      const secretDefinitions = new Map<string, PluginSecretDefinition>();
      for (const candidate of definition.secretDefinitions ?? []) {
        const parsed = {
          name: z.string().min(1).max(120).parse(candidate.name),
          label: z.string().trim().min(1).max(120).parse(candidate.label),
          description: z.string().trim().min(1).max(500).parse(candidate.description)
        };
        if (secretDefinitions.has(parsed.name)) {
          throw new Error(`插件 ${manifest.id} 重复声明了密钥名称。`);
        }
        secretDefinitions.set(parsed.name, parsed);
      }
      for (const name of [...new Set(definition.secretNames ?? [])]) {
        if (!secretDefinitions.has(name)) {
          secretDefinitions.set(name, {
            name,
            label: "插件密钥",
            description: "由插件在运行时使用的加密信息。"
          });
        }
      }
      for (const name of secretDefinitions.keys()) {
        if (!/^[A-Za-z][A-Za-z0-9_.-]*$/.test(name) || name.length > 120) {
          throw new Error(`插件 ${manifest.id} 的密钥名称无效。`);
        }
      }
      if (definition.registerHooks !== undefined) {
        this.#registry.registerPluginHooks(manifest.id, () => definition.registerHooks!(this.#registry));
      }
      this.#plugins.set(manifest.id, {
        manifest,
        source: definition.source,
        settingsSchema,
        settingsManagedBy: settingsSchema !== undefined
          ? "plugin"
          : reviewRuleSettingsSchemas.size > 0 ? "review_policy" : "none",
        reviewRuleSettingsSchemas,
        secretDefinitions: [...secretDefinitions.values()],
        initialState: definition.initialState ?? "disabled",
        requiresRestart: definition.requiresRestart ?? true
      });
    }
    this.#registry.lock();
    for (const plugin of this.#plugins.values()) {
      const actualRuleIds = this.reviewRuleIdsForPlugin(plugin.manifest.id).sort();
      const describedRuleIds = [...plugin.reviewRuleSettingsSchemas.keys()].sort();
      if (
        actualRuleIds.length !== describedRuleIds.length ||
        actualRuleIds.some((ruleId, index) => ruleId !== describedRuleIds[index])
      ) {
        throw new Error(
          `插件 ${plugin.manifest.id} 的审核规则与设置说明必须逐项对应。`
        );
      }
    }
  }

  public async initialize(): Promise<void> {
    if (this.secretBox === undefined && await this.store.hasStoredSecrets()) {
      throw new PluginSecretStorageUnavailableError();
    }
    for (const plugin of this.#plugins.values()) {
      await this.store.upsertInstalled({
        id: plugin.manifest.id,
        displayName: plugin.manifest.name,
        version: plugin.manifest.version,
        apiVersion: plugin.manifest.apiVersion,
        source: plugin.source,
        manifestDigest: manifestDigest(plugin.manifest),
        state: plugin.initialState,
        failureCode: null
      });
    }
  }

  public async list(): Promise<AdminPlugin[]> {
    const stored = new Map((await this.store.list()).map((plugin) => [plugin.id, plugin]));
    return [...this.#plugins.values()].map((plugin) => toAdminPlugin(
      stored.get(plugin.manifest.id),
      plugin,
      this.reviewRuleIdsForPlugin(plugin.manifest.id)
    ));
  }

  public async update(
    pluginId: string,
    input: ParsedUpdatePluginInput,
    actorUserId: string,
    requestId: string
  ): Promise<AdminPlugin | undefined> {
    const plugin = this.#plugins.get(pluginId);
    if (plugin === undefined) {
      return undefined;
    }
    const existing = await this.store.get(pluginId);
    if (existing === undefined) {
      return undefined;
    }
    if (existing.settingsRevision !== input.expectedRevision) {
      throw new PluginRevisionConflictError();
    }
    if (input.settings !== undefined && plugin.settingsManagedBy !== "plugin") {
      throw new PluginConfigurationError(
        plugin.settingsManagedBy === "review_policy"
          ? "该插件的设置请在审核规则区域修改。"
          : "该插件没有可修改的普通设置。"
      );
    }
    const candidateSettings = input.settings ?? existing.settings;
    let settings: JsonObject | undefined;
    try {
      settings = input.settings === undefined && (
        input.state !== "enabled" || plugin.settingsManagedBy !== "plugin"
      )
        ? undefined
        : validateSettings(plugin.settingsSchema, candidateSettings);
    } catch (error) {
      throw new PluginConfigurationError(
        error instanceof Error ? error.message : "插件设置不符合要求。"
      );
    }
    const clearSecretNames = [...new Set(input.clearSecrets ?? [])];
    const submittedSecretNames = Object.keys(input.secrets ?? {});
    for (const name of [...clearSecretNames, ...submittedSecretNames]) {
      if (!plugin.secretDefinitions.some((secret) => secret.name === name)) {
        throw new PluginConfigurationError("提交了该插件未声明的密钥名称。");
      }
    }
    if (clearSecretNames.some((name) => submittedSecretNames.includes(name))) {
      throw new PluginConfigurationError("同一个密钥不能同时保存和清除。");
    }
    let encryptedSecrets: PluginSecretRecord[] | undefined;
    if (input.secrets !== undefined) {
      if (this.secretBox === undefined) {
        throw new PluginSecretStorageUnavailableError();
      }
      encryptedSecrets = Object.entries(input.secrets).map(([name, value]) => ({
        name,
        encryptedValue: this.secretBox!.encrypt(value),
        maskedSuffix: maskedSecretSuffix(value),
        valueLength: value.length
      }));
    }
    const update = {
      expectedRevision: input.expectedRevision,
      ...(input.state === undefined ? {} : { state: input.state }),
      ...(settings === undefined ? {} : { settings }),
      ...(encryptedSecrets === undefined ? {} : { encryptedSecrets }),
      ...(clearSecretNames.length === 0 ? {} : { clearSecretNames }),
      actorUserId
    };
    const event: PluginUpdateSuccessAudit = {
      actorUserId,
      requestId,
      action: "plugin.update",
      pluginId,
      result: "success",
      reasonCode: null,
      metadata: {
        changedState: input.state !== undefined,
        changedSettings: input.settings !== undefined,
        changedSecretNames: submittedSecretNames,
        clearedSecretNames: clearSecretNames
      }
    };
    const updated = await this.store.updateAndAudit(pluginId, update, event);
    if (updated === undefined) {
      return undefined;
    }
    return toAdminPlugin(updated, plugin, this.reviewRuleIdsForPlugin(pluginId));
  }

  /** Records only fixed details about an unsuccessful plugin update attempt. */
  public async recordUpdateAttempt(input: {
    readonly actorUserId: string;
    readonly requestId: string;
    readonly pluginId: string | null;
    readonly result: "denied" | "failure";
    readonly reasonCode: PluginUpdateFailureReason;
  }): Promise<void> {
    await this.store.appendAudit({
      ...input,
      action: "plugin.update",
      metadata: {}
    });
  }

  /** Gives a plugin only its own enabled state; no database or cross-plugin access. */
  public async requestScope(
    pluginId: string,
    executor?: DatabaseExecutor
  ): Promise<{ readonly pluginId: string; readonly enabled: true }> {
    const plugin = this.#plugins.get(pluginId);
    const stored = plugin === undefined ? undefined : await this.store.get(pluginId, executor);
    if (plugin === undefined || stored === undefined || stored.state !== "enabled") {
      throw new PluginUnavailableError();
    }
    return Object.freeze({ pluginId, enabled: true as const });
  }

  /** 只在插件已启用时返回其设置；供插件自己的钩子在运行时读取当前配置。 */
  public async readEnabledPluginSettings(pluginId: string): Promise<unknown | undefined> {
    const plugin = this.#plugins.get(pluginId);
    const stored = plugin === undefined ? undefined : await this.store.get(pluginId);
    if (plugin === undefined || stored === undefined || stored.state !== "enabled") {
      return undefined;
    }
    return stored.settings;
  }

  /** 已注册且所属插件当前启用的提交前检查编号，按注册顺序返回。 */
  public async listEnabledBeforeSubmitCheckIds(): Promise<readonly string[]> {
    const enabled: string[] = [];
    for (const check of this.#registry.listBeforeSubmitChecks()) {
      try {
        await this.requestScope(this.pluginIdForRegistration(check.id));
        enabled.push(check.id);
      } catch (error) {
        if (!(error instanceof PluginUnavailableError)) throw error;
      }
    }
    return enabled;
  }

  public async runBeforeSubmit(
    input: BeforeSubmitInput,
    orderedCheckIds: readonly string[],
    signal?: AbortSignal
  ): Promise<BeforeSubmitResult> {
    for (const checkId of orderedCheckIds) {
      await this.requestScope(this.pluginIdForRegistration(checkId));
    }
    return this.#registry.runBeforeSubmit(input, orderedCheckIds, signal);
  }

  public async evaluateReviewDecision(
    ruleId: string,
    input: ReviewRoundSnapshot,
    settings: unknown,
    evaluatedAt?: number,
    executor?: DatabaseExecutor
  ): Promise<ReviewDecision> {
    await this.requestScope(this.pluginIdForRegistration(ruleId), executor);
    return this.#registry.evaluateReviewDecision(ruleId, input, settings, evaluatedAt);
  }

  /** Lists review rules whose owning bundled plugin is currently enabled. */
  public async listEnabledReviewRules(): Promise<readonly {
    readonly id: string;
    readonly displayName: string;
    readonly pluginVersion: string;
    readonly settingsSchema: PluginSettingsFormSchema | null;
  }[]> {
    const enabled: Array<{
      id: string;
      displayName: string;
      pluginVersion: string;
      settingsSchema: PluginSettingsFormSchema | null;
    }> = [];
    for (const rule of this.#registry.listReviewRules()) {
      const pluginId = this.pluginIdForRegistration(rule.id);
      try {
        await this.requestScope(pluginId);
      } catch (error) {
        if (error instanceof PluginUnavailableError) {
          continue;
        }
        throw error;
      }
      const plugin = this.#plugins.get(pluginId);
      if (plugin !== undefined) {
        enabled.push({
          ...rule,
          pluginVersion: plugin.manifest.version,
          settingsSchema: plugin.reviewRuleSettingsSchemas.get(rule.id) ?? null
        });
      }
    }
    return enabled;
  }

  /**
   * Confirms that a rule is registered and enabled, then fills defaults using
   * the rule's own runtime validator. The returned value is safe to snapshot.
   */
  public async prepareReviewRule(
    ruleId: string,
    settings: unknown,
    executor?: DatabaseExecutor
  ): Promise<{
    readonly ruleId: string;
    readonly displayName: string;
    readonly pluginVersion: string;
    readonly settings: unknown;
  }> {
    const rule = this.#registry.listReviewRules().find((candidate) => candidate.id === ruleId);
    if (rule === undefined) {
      throw new Error("审核规则没有登记。");
    }
    const pluginId = this.pluginIdForRegistration(ruleId);
    await this.requestScope(pluginId, executor);
    const plugin = this.#plugins.get(pluginId);
    if (plugin === undefined) {
      throw new Error("审核规则所属插件没有登记。");
    }
    return {
      ruleId,
      displayName: rule.displayName,
      pluginVersion: plugin.manifest.version,
      settings: this.#registry.normalizeReviewRuleSettings(ruleId, settings)
    };
  }

  /**
   * Internal hook code can ask for one named secret belonging to its own
   * enabled plugin. This method intentionally has no list operation.
   */
  public async readSecretForPlugin(pluginId: string, name: string): Promise<string | undefined> {
    await this.requestScope(pluginId);
    const registered = this.#plugins.get(pluginId);
    if (
      registered === undefined ||
      !registered.secretDefinitions.some((secret) => secret.name === name)
    ) {
      return undefined;
    }
    const plugin = await this.store.get(pluginId);
    const secret = plugin?.secrets.find((item) => item.name === name);
    if (secret === undefined) {
      return undefined;
    }
    if (this.secretBox === undefined) {
      throw new PluginSecretStorageUnavailableError();
    }
    try {
      return this.secretBox.decrypt(secret.encryptedValue);
    } catch {
      throw new PluginSecretStorageUnavailableError();
    }
  }

  /** 根据钩子编号找出它属于哪个插件；找不到时抛错。 */
  public pluginIdForCheckId(registrationId: string): string {
    return this.pluginIdForRegistration(registrationId);
  }

  private pluginIdForRegistration(registrationId: string): string {
    const matched = [...this.#plugins.keys()]
      .filter((pluginId) => registrationId.startsWith(`${pluginId}.`))
      .sort((left, right) => right.length - left.length)[0];
    if (matched === undefined) {
      throw new Error("钩子没有登记所属插件，不能调用。");
    }
    return matched;
  }

  private reviewRuleIdsForPlugin(pluginId: string): string[] {
    return this.#registry.listReviewRules()
      .filter((rule) => this.pluginIdForRegistration(rule.id) === pluginId)
      .map((rule) => rule.id);
  }
}

function manifestDigest(manifest: PluginManifest): string {
  return createHash("sha256").update(JSON.stringify(manifest)).digest("hex");
}

function maskedSecretSuffix(value: string): string {
  return value.length <= 4 ? "****" : value.slice(-4);
}

function toAdminPlugin(
  stored: StoredPlugin | undefined,
  registered: RegisteredPlugin,
  reviewRuleIds: readonly string[]
): AdminPlugin {
  const storedSecrets = new Map((stored?.secrets ?? []).map((secret) => [secret.name, secret]));
  return {
    id: registered.manifest.id,
    name: registered.manifest.name,
    version: registered.manifest.version,
    apiVersion: registered.manifest.apiVersion,
    source: registered.source,
    state: stored?.state ?? "disabled",
    failureCode: stored?.failureCode ?? null,
    settings: registered.settingsManagedBy === "plugin" ? stored?.settings ?? {} : {},
    settingsManagedBy: registered.settingsManagedBy,
    settingsSchema: registered.settingsSchema ?? null,
    reviewRuleIds: [...reviewRuleIds],
    settingsRevision: stored?.settingsRevision ?? 1,
    secrets: registered.secretDefinitions.map((definition) => {
      const secret = storedSecrets.get(definition.name);
      return secret === undefined
        ? { ...definition, configured: false, maskedSuffix: "" }
        : {
            ...definition,
            configured: true,
            maskedSuffix:
              secret.valueLength !== null &&
              secret.valueLength > 4 &&
              secret.maskedSuffix.length === 4
                ? secret.maskedSuffix
                : "****"
          };
    }),
    requiresRestart: registered.requiresRestart
  };
}

function validateSettings(schema: PluginSettingsFormSchema | undefined, value: JsonObject): JsonObject {
  if (schema === undefined) {
    if (Object.keys(value).length > 0) {
      throw new Error("该插件没有可保存的普通设置。");
    }
    return {};
  }
  const parsed = applySchema(schema, value, "settings");
  if (!isObject(parsed)) {
    throw new Error("插件设置必须是对象。");
  }
  return parsed;
}

function applySchema(schema: PluginSettingsFormSchema, value: unknown, path: string): unknown {
  if (value === undefined) {
    if (schema.default === undefined) return undefined;
    value = structuredClone(schema.default);
  }
  if (schema.enum !== undefined && !schema.enum.some((candidate) => Object.is(candidate, value))) {
    throw new Error(`${path} 不在允许值中。`);
  }
  if (
    schema.oneOf !== undefined &&
    !schema.oneOf.some((choice) => Object.is(choice.const, value))
  ) {
    throw new Error(`${path} 不在允许值中。`);
  }
  if (schema.type === "object") {
    if (!isObject(value)) throw new Error(`${path} 必须是对象。`);
    const properties = schema.properties ?? {};
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(value)) {
        if (!Object.hasOwn(properties, key)) {
          throw new Error(`${path}.${key} 不是允许的设置项。`);
        }
      }
    }
    const result: JsonObject = {};
    for (const [key, child] of Object.entries(properties)) {
      const childValue = applySchema(child, value[key], `${path}.${key}`);
      if (childValue !== undefined) result[key] = childValue;
    }
    for (const key of schema.required ?? []) {
      if (!Object.hasOwn(result, key)) throw new Error(`${path}.${key} 是必填项。`);
    }
    if (schema.additionalProperties !== false) {
      for (const [key, item] of Object.entries(value)) {
        if (!Object.hasOwn(properties, key)) result[key] = item;
      }
    }
    return result;
  }
  if (schema.type === "array") {
    if (!Array.isArray(value)) throw new Error(`${path} 必须是数组。`);
    return schema.items === undefined ? value : value.map((item, index) => applySchema(schema.items!, item, `${path}[${index}]`));
  }
  if (schema.type === "string") {
    if (typeof value !== "string") throw new Error(`${path} 必须是文本。`);
    if (schema.minLength !== undefined && value.length < schema.minLength) throw new Error(`${path} 太短。`);
    if (schema.maxLength !== undefined && value.length > schema.maxLength) throw new Error(`${path} 太长。`);
    if (schema.format === "uri") {
      let url: URL;
      try {
        url = new URL(value);
      } catch {
        throw new Error(`${path} 必须是有效地址。`);
      }
      if (
        (url.protocol !== "http:" && url.protocol !== "https:") ||
        url.username.length > 0 ||
        url.password.length > 0 ||
        url.search.length > 0 ||
        url.hash.length > 0
      ) {
        throw new Error(`${path} 必须是没有账号密码、查询参数或片段的 HTTP 或 HTTPS 地址。`);
      }
    }
    return value;
  }
  if (schema.type === "boolean") {
    if (typeof value !== "boolean") throw new Error(`${path} 必须是真或假。`);
    return value;
  }
  if (schema.type === "number" || schema.type === "integer") {
    if (typeof value !== "number" || !Number.isFinite(value) || (schema.type === "integer" && !Number.isInteger(value))) throw new Error(`${path} 必须是${schema.type === "integer" ? "整数" : "数字"}。`);
    if (schema.minimum !== undefined && value < schema.minimum) throw new Error(`${path} 不能小于 ${schema.minimum}。`);
    if (schema.maximum !== undefined && value > schema.maximum) throw new Error(`${path} 不能大于 ${schema.maximum}。`);
    return value;
  }
  return value;
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export class InMemoryPluginStore implements PluginStore {
  readonly plugins = new Map<string, StoredPlugin>();
  readonly auditEvents: PluginAuditEvent[] = [];

  public async list(): Promise<StoredPlugin[]> { return [...this.plugins.values()].map(copy); }
  public async get(
    pluginId: string,
    _executor?: DatabaseExecutor
  ): Promise<StoredPlugin | undefined> {
    const plugin = this.plugins.get(pluginId); return plugin === undefined ? undefined : copy(plugin);
  }
  public async hasStoredSecrets(): Promise<boolean> {
    return [...this.plugins.values()].some((plugin) => plugin.secrets.length > 0);
  }
  public async upsertInstalled(plugin: Omit<StoredPlugin, "settings" | "settingsRevision" | "secrets">): Promise<void> {
    const existing = this.plugins.get(plugin.id);
    this.plugins.set(plugin.id, {
      ...plugin,
      state: existing?.state ?? plugin.state,
      failureCode: existing?.failureCode ?? null,
      settings: existing?.settings ?? {},
      settingsRevision: existing?.settingsRevision ?? 1,
      secrets: existing?.secrets ?? []
    });
  }
  public async updateAndAudit(
    pluginId: string,
    input: {
      expectedRevision: number;
      state?: z.infer<typeof stateSchema>;
      settings?: JsonObject;
      encryptedSecrets?: readonly PluginSecretRecord[];
      clearSecretNames?: readonly string[];
      actorUserId: string;
    },
    event: PluginUpdateSuccessAudit
  ): Promise<StoredPlugin | undefined> {
    const existing = this.plugins.get(pluginId);
    if (existing === undefined) return undefined;
    if (existing.settingsRevision !== input.expectedRevision) {
      throw new PluginRevisionConflictError();
    }
    const secretMap = new Map(existing.secrets.map((secret) => [secret.name, secret]));
    for (const name of input.clearSecretNames ?? []) secretMap.delete(name);
    for (const secret of input.encryptedSecrets ?? []) secretMap.set(secret.name, secret);
    const updated: StoredPlugin = {
      ...existing,
      ...(input.state === undefined ? {} : { state: input.state }),
      ...(input.state === undefined ? {} : { failureCode: null }),
      ...(input.settings === undefined ? {} : { settings: structuredClone(input.settings) }),
      settingsRevision: existing.settingsRevision + 1,
      secrets: [...secretMap.values()].map(copy)
    };
    const copiedEvent = copy(event);
    this.plugins.set(pluginId, updated);
    this.auditEvents.push(copiedEvent);
    return copy(updated);
  }
  public async appendAudit(event: PluginUpdateAttemptAudit): Promise<void> {
    this.auditEvents.push(copy(event));
  }
}

function copy<T>(value: T): T { return structuredClone(value); }
