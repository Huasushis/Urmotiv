import {
  adminAuditEventSchema,
  adminGeneralSettingsSchema,
  adminPermissionSchema,
  adminRoleSchema,
  adminServiceAccountSchema,
  adminManagedRoleSchema,
  adminRoleManagementResponseSchema,
  type AdminAuditEvent,
  type AdminGeneralSettings,
  type AdminPermission,
  type AdminRole,
  type AdminManagedRole,
  type AdminRoleManagementResponse,
  type CreateAdminRoleInput,
  type UpdateAdminRoleInput,
  type AdminServiceAccount,
  type UpdateAdminGeneralSettingsInput,
  type UpdateUstcOAuthSettingsInput,
  type UstcOAuthSettings
} from "@urmotiv/contracts";
import { isApprovedUstcOAuthEndpoint, ustcOAuthCallbackPath, ustcOAuthEndpointContract } from "@urmotiv/auth";
import { sql, type SQL } from "drizzle-orm";
import { corePermissionDefinitions, builtinRoleDefinitions, type DatabaseHandle } from "@urmotiv/database";
import type { StoredUser } from "./domain";
import { ApiError, conflict, notFound } from "./errors";
import { hasPermission } from "./permissions";
import {
  InMemoryRoleManagementStore,
  assertRoleMutationSafety,
  createAdminRoleMutationContext,
  type RoleManagementStore,
  type AdminRoleMutationContext,
  type StoredAdminRole
} from "./admin-role-service";
import type { DataStore } from "./repository";
import type { PluginSecretBox } from "./plugin-host";

export interface StoredUstcOAuthSettings {
  readonly enabled: boolean;
  readonly authorizeUrl: string;
  readonly tokenUrl: string;
  readonly profileUrl: string;
  readonly redirectUri: string;
  readonly scope: string;
  readonly clientIdEncrypted: string | null;
  readonly clientSecretEncrypted: string | null;
  readonly revision: number;
  readonly overrideConfigured: boolean;
}

export interface RuntimeUstcOAuthSettings {
  readonly enabled: true;
  readonly authorizeUrl: string;
  readonly tokenUrl: string;
  readonly profileUrl: string;
  readonly redirectUri: string;
  readonly scope: string;
  readonly clientId: string;
  readonly clientSecret: string;
}

export interface StoredGeneralSettings {
  readonly publicRegistrationEnabled: boolean;
  readonly publicSiteUrl: string;
  readonly revision: number;
}


export interface AdminAuditEventInput {
  readonly actorUserId: string;
  readonly requestId: string;
  readonly action: string;
  readonly objectType: string;
  readonly objectId?: string;
  readonly result: "success" | "failure";
  readonly reasonCode?: string;
  readonly metadata?: Record<string, unknown>;
}

export interface AdminSettingsStore {
  getGeneralSettings(): Promise<StoredGeneralSettings>;
  updateGeneralSettings(
    expectedRevision: number,
    settings: StoredGeneralSettings,
    event: AdminAuditEventInput
  ): Promise<StoredGeneralSettings>;
  getUstcOAuthSettings(): Promise<StoredUstcOAuthSettings>;
  updateUstcOAuthSettings(
    expectedRevision: number,
    settings: StoredUstcOAuthSettings,
    event: AdminAuditEventInput
  ): Promise<StoredUstcOAuthSettings>;
  listAuditEvents(page: number, pageSize: number): Promise<{ items: AdminAuditEvent[]; total: number }>;
  encryptSecret(value: string): string;
  decryptSecret(value: string): string;
}
const canonicalCallbackPath = ustcOAuthCallbackPath;
const defaultUstcSettings: StoredUstcOAuthSettings = {
  enabled: false,
  authorizeUrl: "",
  tokenUrl: "",
  profileUrl: "",
  redirectUri: canonicalCallbackPath,
  scope: "",
  clientIdEncrypted: null,
  clientSecretEncrypted: null,
  revision: 1,
  overrideConfigured: false
};
const defaultGeneralSettings: StoredGeneralSettings = {
  publicRegistrationEnabled: false,
  publicSiteUrl: "http://localhost:5173",
  revision: 1
};

function copy<T>(value: T): T {
  return structuredClone(value);
}
function parseAuditEvent(raw: unknown): AdminAuditEvent {
  return adminAuditEventSchema.parse(raw);
}

export class InMemoryAdminSettingsStore implements AdminSettingsStore {
  private settings: StoredUstcOAuthSettings = copy(defaultUstcSettings);
  private generalSettings: StoredGeneralSettings = copy(defaultGeneralSettings);
  private readonly audits: AdminAuditEvent[] = [];

  public constructor(initialGeneralSettings?: Partial<StoredGeneralSettings>) {
    if (initialGeneralSettings !== undefined) {
      this.generalSettings = {
        ...this.generalSettings,
        ...initialGeneralSettings
      };
    }
  }

  public async getGeneralSettings(): Promise<StoredGeneralSettings> {
    return copy(this.generalSettings);
  }

  public async updateGeneralSettings(
    expectedRevision: number,
    settings: StoredGeneralSettings,
    event: AdminAuditEventInput
  ): Promise<StoredGeneralSettings> {
    if (expectedRevision !== this.generalSettings.revision) {
      throw conflict("设置已被其他管理员修改，请刷新后重试。");
    }
    this.generalSettings = copy(settings);
    this.audits.unshift({
      id: String(this.audits.length + 1),
      occurredAt: new Date().toISOString(),
      action: event.action,
      objectType: event.objectType,
      result: event.result,
      reasonCode: event.reasonCode ?? null
    });
    return copy(this.generalSettings);
  }

  public async getUstcOAuthSettings(): Promise<StoredUstcOAuthSettings> {
    return copy(this.settings);
  }

  public async updateUstcOAuthSettings(
    expectedRevision: number,
    settings: StoredUstcOAuthSettings,
    event: AdminAuditEventInput
  ): Promise<StoredUstcOAuthSettings> {
    if (expectedRevision !== this.settings.revision) {
      throw conflict("设置已被其他管理员修改，请刷新后重试。");
    }
    this.settings = copy({ ...settings, overrideConfigured: true });
    this.audits.unshift({
      id: String(this.audits.length + 1),
      occurredAt: new Date().toISOString(),
      action: event.action,
      objectType: event.objectType,
      result: event.result,
      reasonCode: event.reasonCode ?? null
    });
    return copy(this.settings);
  }

  public encryptSecret(value: string): string {
    return `memory:${Buffer.from(value, "utf8").toString("base64url")}`;
  }
  public decryptSecret(value: string): string {
    if (!value.startsWith("memory:")) throw new ApiError(503, "SECRET_STORAGE_UNAVAILABLE", "密钥读取服务暂不可用。");
    try {
      return Buffer.from(value.slice("memory:".length), "base64url").toString("utf8");
    } catch {
      throw new ApiError(503, "SECRET_STORAGE_UNAVAILABLE", "密钥读取服务暂不可用。");
    }
  }

  public async listAuditEvents(page: number, pageSize: number): Promise<{ items: AdminAuditEvent[]; total: number }> {
    const start = (page - 1) * pageSize;
    return {
      items: this.audits.slice(start, start + pageSize).map(parseAuditEvent),
      total: this.audits.length
    };
  }
}

interface AuditRow extends Record<string, unknown> {
  id: string;
  occurred_at: Date | string;
  action: string;
  object_type: string;
  result: "success" | "failure";
  reason_code: string | null;
}

function databaseId(value: string): bigint {
  if (!/^(0|[1-9]\d*)$/.test(value)) {
    throw new Error("管理员审计用户编号无效。");
  }
  return BigInt(value);
}

function asIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

export class DatabaseAdminSettingsStore implements AdminSettingsStore {
  public constructor(
    private readonly database: DatabaseHandle,
    private readonly secretBox?: PluginSecretBox
  ) {}

  public encryptSecret(value: string): string {
    if (this.secretBox === undefined) {
      throw new ApiError(503, "SECRET_STORAGE_UNAVAILABLE", "密钥保存服务暂不可用。");
    }
    return this.secretBox.encrypt(value);
  }
  public decryptSecret(value: string): string {
    if (this.secretBox === undefined) {
      throw new ApiError(503, "SECRET_STORAGE_UNAVAILABLE", "密钥读取服务暂不可用。");
    }
    try {
      return this.secretBox.decrypt(value);
    } catch {
      throw new ApiError(503, "SECRET_STORAGE_UNAVAILABLE", "密钥读取服务暂不可用。");
    }
  }

  public async getGeneralSettings(): Promise<StoredGeneralSettings> {
    const rows = await this.database.query<{
      public_registration_enabled: boolean;
      public_site_url: string;
      revision: number;
    }>(sql`
      SELECT public_registration_enabled, public_site_url, revision
      FROM system_settings WHERE id = 'global'
    `);
    const row = rows[0];
    if (row === undefined) return copy(defaultGeneralSettings);
    return {
      publicRegistrationEnabled: row.public_registration_enabled,
      publicSiteUrl: row.public_site_url || defaultGeneralSettings.publicSiteUrl,
      revision: Number(row.revision)
    };
  }

  public async updateGeneralSettings(
    expectedRevision: number,
    settings: StoredGeneralSettings,
    event: AdminAuditEventInput
  ): Promise<StoredGeneralSettings> {
    const actorId = databaseId(event.actorUserId);
    return this.database.transaction(async (transaction) => {
      const rows = await transaction.query<{ revision: number }>(sql`
        SELECT revision FROM system_settings WHERE id = 'global' FOR UPDATE
      `);
      const currentRevision = Number(rows[0]?.revision ?? 1);
      if (currentRevision !== expectedRevision) {
        throw conflict("设置已被其他管理员修改，请刷新后重试。");
      }
      await transaction.execute(sql`
        INSERT INTO system_settings (
          id, public_registration_enabled, public_site_url, revision, updated_by_user_id
        ) VALUES (
          'global', ${settings.publicRegistrationEnabled}, ${settings.publicSiteUrl},
          ${expectedRevision + 1}, ${actorId}
        ) ON CONFLICT (id) DO UPDATE SET
          public_registration_enabled = EXCLUDED.public_registration_enabled,
          public_site_url = EXCLUDED.public_site_url,
          revision = EXCLUDED.revision,
          updated_by_user_id = EXCLUDED.updated_by_user_id,
          updated_at = now()
      `);
      await transaction.execute(sql`
        INSERT INTO audit_events (
          actor_user_id, request_id, action, object_type, object_id, result, reason_code, metadata
        ) VALUES (
          ${actorId}, ${event.requestId}::uuid, ${event.action}, ${event.objectType},
          ${event.objectId ?? "global"}, ${event.result}, ${event.reasonCode ?? null},
          ${JSON.stringify(event.metadata ?? {})}::jsonb
        )
      `);
      return this.getGeneralSettingsFrom(transaction);
    });
  }

  public async getUstcOAuthSettings(): Promise<StoredUstcOAuthSettings> {
    return this.getUstcOAuthSettingsFrom(this.database);
  }

  public async updateUstcOAuthSettings(
    expectedRevision: number,
    settings: StoredUstcOAuthSettings,
    event: AdminAuditEventInput
  ): Promise<StoredUstcOAuthSettings> {
    const actorId = databaseId(event.actorUserId);
    return this.database.transaction(async (transaction) => {
      const rows = await transaction.query<{ revision: number }>(sql`
        SELECT revision FROM system_oauth_settings WHERE id = 'global' FOR UPDATE
      `);
      const currentRevision = Number(rows[0]?.revision ?? 1);
      if (currentRevision !== expectedRevision) {
        throw conflict("OAuth 设置已被其他管理员修改，请刷新后重试。");
      }
      await transaction.execute(sql`
        INSERT INTO system_oauth_settings (
          id, enabled, authorize_url, token_url, profile_url, redirect_uri, scope,
          client_id_encrypted, client_secret_encrypted, revision, updated_by_user_id
        ) VALUES (
          'global', ${settings.enabled}, ${settings.authorizeUrl}, ${settings.tokenUrl},
          ${settings.profileUrl}, ${settings.redirectUri}, ${settings.scope},
          ${settings.clientIdEncrypted}, ${settings.clientSecretEncrypted},
          ${expectedRevision + 1}, ${actorId}
        ) ON CONFLICT (id) DO UPDATE SET
          enabled = EXCLUDED.enabled,
          authorize_url = EXCLUDED.authorize_url,
          token_url = EXCLUDED.token_url,
          profile_url = EXCLUDED.profile_url,
          redirect_uri = EXCLUDED.redirect_uri,
          scope = EXCLUDED.scope,
          client_id_encrypted = EXCLUDED.client_id_encrypted,
          client_secret_encrypted = EXCLUDED.client_secret_encrypted,
          revision = EXCLUDED.revision,
          updated_by_user_id = EXCLUDED.updated_by_user_id,
          updated_at = now()
      `);
      await transaction.execute(sql`
        INSERT INTO audit_events (
          actor_user_id, request_id, action, object_type, object_id, result, reason_code, metadata
        ) VALUES (
          ${actorId}, ${event.requestId}::uuid, ${event.action}, ${event.objectType},
          ${event.objectId ?? "global"}, ${event.result}, ${event.reasonCode ?? null},
          ${JSON.stringify(event.metadata ?? {})}::jsonb
        )
      `);
      return this.getUstcOAuthSettingsFrom(transaction);
    });
  }

  public async listAuditEvents(page: number, pageSize: number): Promise<{ items: AdminAuditEvent[]; total: number }> {
    const start = (page - 1) * pageSize;
    const [rows, totals] = await Promise.all([
      this.database.query<AuditRow>(sql`
        SELECT id::text AS id, occurred_at, action, object_type, result, reason_code
        FROM audit_events ORDER BY occurred_at DESC, id DESC LIMIT ${pageSize} OFFSET ${start}
      `),
      this.database.query<{ total: number }>(sql`SELECT count(*)::integer AS total FROM audit_events`)
    ]);
    return {
      items: rows.map((row) => parseAuditEvent({
        id: row.id,
        occurredAt: asIso(row.occurred_at),
        action: row.action,
        objectType: row.object_type,
        result: row.result,
        reasonCode: row.reason_code
      })),
      total: Number(totals[0]?.total ?? 0)
    };
  }

  private async getGeneralSettingsFrom(
    executor: { query<T extends Record<string, unknown>>(query: SQL): Promise<T[]> }
  ): Promise<StoredGeneralSettings> {
    const rows = await executor.query<{
      public_registration_enabled: boolean;
      public_site_url: string;
      revision: number;
    }>(sql`
      SELECT public_registration_enabled, public_site_url, revision
      FROM system_settings WHERE id = 'global'
    `);
    const row = rows[0];
    if (row === undefined) return copy(defaultGeneralSettings);
    return {
      publicRegistrationEnabled: row.public_registration_enabled,
      publicSiteUrl: row.public_site_url || defaultGeneralSettings.publicSiteUrl,
      revision: Number(row.revision)
    };
  }

  private async getUstcOAuthSettingsFrom(
    executor: { query<T extends Record<string, unknown>>(query: SQL): Promise<T[]> }
  ): Promise<StoredUstcOAuthSettings> {
    const rows = await executor.query<{
      enabled: boolean;
      authorize_url: string;
      token_url: string;
      profile_url: string;
      redirect_uri: string;
      scope: string;
      client_id_encrypted: string | null;
      client_secret_encrypted: string | null;
      revision: number;
    }>(sql`
      SELECT enabled, authorize_url, token_url, profile_url, redirect_uri, scope,
             client_id_encrypted, client_secret_encrypted, revision
      FROM system_oauth_settings WHERE id = 'global'
    `);
    const row = rows[0];
    if (row === undefined) return copy(defaultUstcSettings);
    return {
      enabled: row.enabled,
      authorizeUrl: row.authorize_url,
      tokenUrl: row.token_url,
      profileUrl: row.profile_url,
      redirectUri: row.redirect_uri,
      scope: row.scope,
      clientIdEncrypted: row.client_id_encrypted,
      clientSecretEncrypted: row.client_secret_encrypted,
      revision: Number(row.revision),
      overrideConfigured: true
    };
  }
}

export interface AdminServiceOptions {
  readonly store: DataStore;
  readonly settingsStore?: AdminSettingsStore;
  readonly secureCookies: boolean;
  readonly allowLoopbackInsecureCookies: boolean;
  readonly emailLoginEnabled: boolean;
  readonly emailRegistrationEnabled: boolean;
  readonly allowedOrigins: readonly string[];
  readonly roleManagementStore?: RoleManagementStore;
  readonly tokenConfigured?: (userId: string) => Promise<boolean>;
  readonly now?: () => Date;
}
export class AdminService {
  private readonly settingsStore: AdminSettingsStore;
  private readonly roleManagementStore: RoleManagementStore;
  private readonly now: () => Date;

  public constructor(private readonly options: AdminServiceOptions) {
    this.settingsStore = options.settingsStore ?? new InMemoryAdminSettingsStore();
    this.roleManagementStore = options.roleManagementStore ?? new InMemoryRoleManagementStore();
    this.now = options.now ?? (() => new Date());
  }

  public listRoles(): AdminRole[] {
    return builtinRoleDefinitions.map((role) => adminRoleSchema.parse({
      key: role.key,
      displayName: role.displayName,
      description: role.description,
      permissions: [...role.permissions]
    }));
  }

  public listPermissions(): AdminPermission[] {
    return Object.entries(corePermissionDefinitions).map(([name, value]) => adminPermissionSchema.parse({
      name,
      displayName: value.displayName,
      description: value.description
    }));
  }
  public async listRoleManagement(): Promise<AdminRoleManagementResponse> {
    const [storedRoles, users] = await Promise.all([
      this.roleManagementStore.listRoles(),
      this.options.store.listUsers()
    ]);
    const publicUsers = users.map((user) => ({
      id: user.id,
      nickname: user.nickname,
      accountType: user.accountType,
      enabled: !user.disabled
    }));
    const usersById = new Map(publicUsers.map((user) => [user.id, user]));
    const roles = storedRoles.map((role) => adminManagedRoleSchema.parse({
      id: role.id,
      key: role.key,
      displayName: role.displayName,
      description: role.description,
      isBuiltIn: role.isBuiltIn,
      revision: role.revision,
      permissions: role.permissions,
      members: role.memberIds.flatMap((id) => {
        const member = usersById.get(id);
        return member === undefined ? [] : [member];
      })
    }));
    return adminRoleManagementResponseSchema.parse({
      roles,
      permissions: this.listPermissions(),
      users: publicUsers
    });
  }

  public async createRole(
    user: StoredUser,
    input: CreateAdminRoleInput,
    requestId: string
  ): Promise<{ role: AdminManagedRole }> {
    this.assertRoleManager(user);
    const context = this.roleMutationContext(user, requestId);
    await this.validateRoleInput(input.permissions, input.userIds);
    assertRoleMutationSafety(input, context);
    const role = await this.roleManagementStore.createRole(input, context);
    return { role: await this.toPublicManagedRole(role) };
  }

  public async updateRole(
    user: StoredUser,
    roleId: string,
    input: UpdateAdminRoleInput,
    requestId: string
  ): Promise<{ role: AdminManagedRole }> {
    this.assertRoleManager(user);
    const context = this.roleMutationContext(user, requestId);
    await this.validateRoleInput(input.permissions, input.userIds);
    const role = await this.roleManagementStore.updateRole(roleId, input, context);
    return { role: await this.toPublicManagedRole(role) };
  }

  public async getGeneralSettings(): Promise<AdminGeneralSettings> {
    const current = await this.settingsStore.getGeneralSettings();
    return adminGeneralSettingsSchema.parse({
      emailLoginEnabled: this.options.emailLoginEnabled,
      emailRegistrationEnabled: this.options.emailRegistrationEnabled,
      publicRegistrationEnabled: current.publicRegistrationEnabled,
      publicSiteUrl: current.publicSiteUrl,
      secureCookies: this.options.secureCookies,
      loopbackInsecureCookies: this.options.allowLoopbackInsecureCookies,
      webOrigins: [...this.options.allowedOrigins],
      revision: current.revision
    });
  }

  public async updateGeneralSettings(
    user: StoredUser,
    input: UpdateAdminGeneralSettingsInput,
    requestId: string
  ): Promise<AdminGeneralSettings> {
    this.assertSystemManager(user);
    const current = await this.settingsStore.getGeneralSettings();
    if (input.expectedRevision !== current.revision) {
      throw conflict("设置已被其他管理员修改，请刷新后重试。");
    }
    if (input.publicRegistrationEnabled && !this.options.emailRegistrationEnabled) {
      throw new ApiError(422, "PUBLIC_REGISTRATION_UNAVAILABLE", "当前服务未配置可用的邮箱注册能力。");
    }
    const publicSiteUrl = this.validatePublicSiteUrl(input.publicSiteUrl);
    const currentOAuth = await this.settingsStore.getUstcOAuthSettings();
    if (currentOAuth.overrideConfigured) {
      this.validateRedirect(currentOAuth.redirectUri, publicSiteUrl);
    }
    const saved = await this.settingsStore.updateGeneralSettings(current.revision, {
      publicRegistrationEnabled: input.publicRegistrationEnabled,
      publicSiteUrl,
      revision: current.revision + 1
    }, {
      actorUserId: user.id,
      requestId,
      action: "system.general_settings.update",
      objectType: "system_settings",
      objectId: "global",
      result: "success"
    });
    return adminGeneralSettingsSchema.parse({
      emailLoginEnabled: this.options.emailLoginEnabled,
      emailRegistrationEnabled: this.options.emailRegistrationEnabled,
      publicRegistrationEnabled: saved.publicRegistrationEnabled,
      publicSiteUrl: saved.publicSiteUrl,
      secureCookies: this.options.secureCookies,
      loopbackInsecureCookies: this.options.allowLoopbackInsecureCookies,
      webOrigins: [...this.options.allowedOrigins],
      revision: saved.revision
    });
  }

  public async isPublicRegistrationEnabled(): Promise<boolean> {
    if (!this.options.emailLoginEnabled || !this.options.emailRegistrationEnabled) return false;
    return (await this.settingsStore.getGeneralSettings()).publicRegistrationEnabled;
  }
  public async isUstcOAuthEnabled(fallback: boolean): Promise<boolean> {
    const current = await this.settingsStore.getUstcOAuthSettings();
    if (!current.overrideConfigured) return fallback;
    return current.enabled;
  }

  public async getRuntimeUstcOAuthSettings(): Promise<RuntimeUstcOAuthSettings | { enabled: false } | undefined> {
    const current = await this.settingsStore.getUstcOAuthSettings();
    if (!current.overrideConfigured) return undefined;
    if (!current.enabled) return { enabled: false };
    if (current.clientIdEncrypted === null || current.clientSecretEncrypted === null) {
      throw new ApiError(503, "OAUTH_SECRET_UNAVAILABLE", "USTC OAuth 密钥暂不可用。");
    }
    const general = await this.settingsStore.getGeneralSettings();
    this.validateRedirect(current.redirectUri, general.publicSiteUrl);
    let redirectUri = current.redirectUri;
    if (redirectUri.startsWith("/")) {
      try {
        redirectUri = new URL(redirectUri, general.publicSiteUrl).toString();
      } catch {
        throw new ApiError(503, "OAUTH_REDIRECT_INVALID", "公开站点地址暂不可用。");
      }
    }
    return {
      enabled: true,
      authorizeUrl: current.authorizeUrl,
      tokenUrl: current.tokenUrl,
      profileUrl: current.profileUrl,
      redirectUri,
      scope: current.scope,
      clientId: this.settingsStore.decryptSecret(current.clientIdEncrypted),
      clientSecret: this.settingsStore.decryptSecret(current.clientSecretEncrypted)
    };
  }


  public async listServiceAccounts(): Promise<AdminServiceAccount[]> {
    const users = await this.options.store.listUsers();
    const result: AdminServiceAccount[] = [];
    for (const user of users) {
      if (user.accountType !== "robot") continue;
      result.push(adminServiceAccountSchema.parse({
        id: user.id,
        nickname: user.nickname,
        accountType: "robot",
        enabled: !user.disabled,
        tokenConfigured: await (this.options.tokenConfigured?.(user.id) ?? Promise.resolve(false))
      }));
    }
    return result;
  }

  public async getUstcOAuthSettings(user: StoredUser): Promise<{ settings: UstcOAuthSettings }> {
    this.assertOAuthManager(user);
    const current = await this.settingsStore.getUstcOAuthSettings();
    return { settings: this.toPublicUstcSettings(current) };
  }

  public async updateUstcOAuthSettings(
    user: StoredUser,
    input: UpdateUstcOAuthSettingsInput,
    requestId: string
  ): Promise<{ settings: UstcOAuthSettings }> {
    this.assertOAuthManager(user);
    const current = await this.settingsStore.getUstcOAuthSettings();
    if (input.expectedRevision !== current.revision) {
      throw conflict("OAuth 设置已被其他管理员修改，请刷新后重试。");
    }
    const general = await this.settingsStore.getGeneralSettings();
    const clientIdChanged = input.clearClientId
      ? current.clientIdEncrypted !== null
      : input.clientId.trim().length > 0 &&
        (current.clientIdEncrypted === null ||
          this.settingsStore.decryptSecret(current.clientIdEncrypted) !== input.clientId);
    const identityChanged =
      current.authorizeUrl !== input.authorizeUrl ||
      current.tokenUrl !== input.tokenUrl ||
      current.profileUrl !== input.profileUrl ||
      current.redirectUri !== input.redirectUri ||
      clientIdChanged;
    const clearingDisabledOverride = input.clearClientSecret && !input.enabled;
    if (
      current.clientSecretEncrypted !== null &&
      identityChanged &&
      input.clientSecret === undefined &&
      !clearingDisabledOverride
    ) {
      throw new ApiError(422, "OAUTH_SECRET_REENTRY_REQUIRED", "修改 OAuth 端点、客户端或回调来源前必须重新输入客户端密钥。");
    }
    const nextSecret = input.clearClientSecret
      ? null
      : input.clientSecret === undefined
        ? current.clientSecretEncrypted
        : this.encryptSecret(input.clientSecret);
    const next: StoredUstcOAuthSettings = {
      enabled: input.enabled,
      authorizeUrl: input.authorizeUrl,
      tokenUrl: input.tokenUrl,
      profileUrl: input.profileUrl,
      redirectUri: input.redirectUri,
      scope: input.scope,
      clientIdEncrypted: input.clearClientId
        ? null
        : input.clientId.trim().length === 0
          ? current.clientIdEncrypted
          : this.encryptSecret(input.clientId),
      clientSecretEncrypted: nextSecret,
      revision: current.revision + 1,
      overrideConfigured: true
    };
    this.validateUstcSettings(next, general.publicSiteUrl);
    const saved = await this.settingsStore.updateUstcOAuthSettings(current.revision, next, {
      actorUserId: user.id,
      requestId,
      action: "auth.ustc_oauth.settings.update",
      objectType: "system_oauth_settings",
      objectId: "global",
      result: "success",
      metadata: { secretChanged: input.clientSecret !== undefined || input.clearClientSecret }
    });
    return { settings: this.toPublicUstcSettings(saved) };
  }

  public async listAudit(page: number, pageSize: number): Promise<{ items: AdminAuditEvent[]; total: number }> {
    return this.settingsStore.listAuditEvents(page, pageSize);
  }

  private async toPublicManagedRole(role: StoredAdminRole): Promise<AdminManagedRole> {
    const users = await this.options.store.listUsers();
    const usersById = new Map(users.map((user) => [user.id, user]));
    return adminManagedRoleSchema.parse({
      id: role.id,
      key: role.key,
      displayName: role.displayName,
      description: role.description,
      isBuiltIn: role.isBuiltIn,
      revision: role.revision,
      permissions: role.permissions,
      members: role.memberIds.flatMap((id) => {
        const user = usersById.get(id);
        return user === undefined
          ? []
          : [{
              id: user.id,
              nickname: user.nickname,
              accountType: user.accountType,
              enabled: !user.disabled
            }];
      })
    });
  }

  private roleMutationContext(user: StoredUser, requestId: string): AdminRoleMutationContext {
    return createAdminRoleMutationContext(user, requestId, this.now());
  }

  private async validateRoleInput(
    permissions: readonly { name: string; effect: "allow" | "deny" }[],
    userIds: readonly string[]
  ): Promise<void> {
    const knownPermissions = new Set(this.listPermissions().map((permission) => permission.name));
    const seenPermissions = new Set<string>();
    for (const permission of permissions) {
      if (!knownPermissions.has(permission.name)) {
        throw new ApiError(422, "ROLE_PERMISSION_UNKNOWN", "角色包含未知权限。");
      }
      if (seenPermissions.has(permission.name)) {
        throw new ApiError(422, "ROLE_PERMISSION_DUPLICATE", "角色不能重复设置同一权限。");
      }
      seenPermissions.add(permission.name);
    }
    const users = await this.options.store.listUsers();
    const knownUsers = new Set(users.map((candidate) => candidate.id));
    if (userIds.some((id) => !knownUsers.has(id))) {
      throw new ApiError(422, "ROLE_USER_NOT_FOUND", "角色成员中包含不存在的账号。");
    }
    if (new Set(userIds).size !== userIds.length) {
      throw new ApiError(422, "ROLE_USER_DUPLICATE", "角色成员不能重复。");
    }
  }

  private assertSystemManager(user: StoredUser): void {
    if (user.accountType !== "human" || !hasPermission(user, "system.manage", {}, this.now())) {
      throw notFound();
    }
  }

  private assertRoleManager(user: StoredUser): void {
    if (user.accountType !== "human" || !hasPermission(user, "user.permission.manage", {}, this.now())) {
      throw notFound();
    }
  }

  private assertOAuthManager(user: StoredUser): void {
    if (
      user.accountType !== "human" ||
      !hasPermission(user, "system.manage", {}, this.now()) ||
      !hasPermission(user, "user.permission.manage", {}, this.now())
    ) {
      throw notFound();
    }
  }

  private encryptSecret(value: string): string {
    return this.settingsStore.encryptSecret(value);
  }

  private validateUstcSettings(settings: StoredUstcOAuthSettings, publicSiteUrl: string): void {
    const endpoints = [
      [settings.authorizeUrl, ustcOAuthEndpointContract.authorizePath],
      [settings.tokenUrl, ustcOAuthEndpointContract.tokenPath],
      [settings.profileUrl, ustcOAuthEndpointContract.profilePath]
    ] as const;
    for (const [field, path] of endpoints) {
      if (field.length > 0 || settings.enabled) {
        this.validateProviderUrl(field, path);
      }
    }
    this.validateRedirect(settings.redirectUri, publicSiteUrl);
    if (!settings.enabled) return;
    if (!settings.clientIdEncrypted || !settings.clientSecretEncrypted) {
      throw new ApiError(
        422,
        "OAUTH_CREDENTIALS_REQUIRED",
        "启用 USTC OAuth 前必须配置客户端编号和客户端密钥。"
      );
    }
  }

  private validateProviderUrl(
    value: string,
    path: typeof ustcOAuthEndpointContract.authorizePath |
      typeof ustcOAuthEndpointContract.tokenPath |
      typeof ustcOAuthEndpointContract.profilePath
  ): void {
    if (!isApprovedUstcOAuthEndpoint(value, path)) {
      throw new ApiError(422, "OAUTH_ENDPOINT_NOT_APPROVED", "OAuth 地址必须精确使用已批准的 USTC HTTPS authority/path。");
    }
  }

  private validateRedirect(value: string, publicSiteUrl?: string): void {
    if (value === canonicalCallbackPath) return;
    let parsed: URL;
    try {
      parsed = new URL(value);
    } catch {
      throw new ApiError(422, "OAUTH_REDIRECT_INVALID", "回调地址必须使用站点地址加固定回调路径。");
    }
    if (parsed.pathname !== canonicalCallbackPath || parsed.search || parsed.hash || parsed.username || parsed.password) {
      throw new ApiError(422, "OAUTH_REDIRECT_INVALID", "回调地址必须精确指向固定回调路径。");
    }
    if (publicSiteUrl !== undefined) {
      let site: URL;
      try {
        site = new URL(publicSiteUrl);
      } catch {
        throw new ApiError(422, "OAUTH_REDIRECT_INVALID", "公开站点地址无效，无法校验回调地址。");
      }
      if (parsed.origin !== site.origin) {
        throw new ApiError(422, "OAUTH_REDIRECT_ORIGIN_MISMATCH", "OAuth 回调地址必须与公开站点地址同源。");
      }
    }
    if (parsed.protocol !== "https:") {
      if (!(
        parsed.protocol === "http:" &&
        this.options.allowLoopbackInsecureCookies &&
        ["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname)
      )) {
        throw new ApiError(422, "OAUTH_REDIRECT_INSECURE", "生产回调地址必须使用 HTTPS。");
      }
    }
    if (this.options.secureCookies && parsed.protocol !== "https:") {
      throw new ApiError(422, "OAUTH_REDIRECT_INSECURE", "安全 Cookie 模式不允许 HTTP 回调地址。");
    }
  }

  private validatePublicSiteUrl(value: string): string {
    let parsed: URL;
    try {
      parsed = new URL(value);
    } catch {
      throw new ApiError(422, "PUBLIC_SITE_URL_INVALID", "公开站点地址必须是完整 URL。");
    }
    if (
      parsed.username ||
      parsed.password ||
      parsed.search ||
      parsed.hash ||
      parsed.pathname !== "/"
    ) {
      throw new ApiError(422, "PUBLIC_SITE_URL_INVALID", "公开站点地址只能包含协议、域名和端口。");
    }
    const allowedOrigins = new Set(
      this.options.allowedOrigins.flatMap((origin) => {
        try {
          return [new URL(origin).origin];
        } catch {
          return [];
        }
      })
    );
    if (!allowedOrigins.has(parsed.origin)) {
      throw new ApiError(422, "PUBLIC_SITE_ORIGIN_NOT_ALLOWED", "公开站点地址必须使用部署配置的 Web origin。");
    }
    if (parsed.protocol === "https:") return parsed.origin;
    if (
      parsed.protocol === "http:" &&
      !this.options.secureCookies &&
      this.options.allowLoopbackInsecureCookies &&
      ["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname)
    ) {
      return parsed.origin;
    }
    throw new ApiError(422, "PUBLIC_SITE_URL_INSECURE", "生产公开站点地址必须使用 HTTPS；仅允许显式开启的回环地址使用 HTTP。");
  }

  private toPublicUstcSettings(settings: StoredUstcOAuthSettings): UstcOAuthSettings {
    return {
      enabled: settings.enabled,
      authorizeUrl: settings.authorizeUrl,
      tokenUrl: settings.tokenUrl,
      profileUrl: settings.profileUrl,
      redirectUri: settings.redirectUri,
      scope: settings.scope,
      clientIdConfigured: Boolean(settings.clientIdEncrypted),
      clientSecretConfigured: settings.clientSecretEncrypted !== null,
      revision: settings.revision
    };
  }
}

export { canonicalCallbackPath, defaultUstcSettings };
