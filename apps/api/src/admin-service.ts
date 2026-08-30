import {
  corePermissions,
  robotHardDeniedPermissions,
  adminAuditEventSchema,
  adminGeneralSettingsSchema,
  adminPermissionSchema,
  adminPermissionCatalogResponseSchema,
  adminRoleDefaultsResponseSchema,
  adminUserPermissionDeltaResponseSchema,
  adminUsersResponseSchema,
  adminRoleSchema,
  adminServiceAccountSchema,
  adminManagedRoleSchema,
  adminRoleManagementResponseSchema,
  type AdminAuditEvent,
  type AdminGeneralSettings,
  type AdminPermission,
  type AdminPermissionCatalogResponse,
  type AdminRole,
  type AdminManagedRole,
  type AdminRoleDefaults,
  type AdminRoleDefaultsResponse,
  type AdminRoleManagementResponse,
  type AdminServiceAccount,
  type AdminUserPermissionDeltaResponse,
  type AdminUsersResponse,
  type CreateAdminRoleInput,
  type UpdateAdminRoleInput,
  type UpdateAdminRoleDefaultsInput,
  type UpdateAdminGeneralSettingsInput,
  type UpdateUstcOAuthSettingsInput,
  type UstcOAuthSettings
} from "@urmotiv/contracts";
import { isApprovedUstcOAuthEndpoint, ustcOAuthCallbackPath, ustcOAuthEndpointContract } from "@urmotiv/auth";
import { corePermissionDefinitions, builtinRoleDefinitions, type DatabaseExecutor, type DatabaseHandle } from "@urmotiv/database";
import { type SQL, sql } from "drizzle-orm";
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
import type { DataStore, ReplaceUserPermissionDeltaInput, UserPermissionDelta } from "./repository";
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
  readonly subjectUserId?: string;
  readonly requestId: string;
  readonly action: string;
  readonly objectType: string;
  readonly objectId?: string;
  readonly result: "success" | "failure";
  readonly reasonCode?: string;
  readonly metadata?: Record<string, unknown>;
}
export interface AdminMutationAuditContext {
  readonly auditActorUserId?: string;
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
  recordAuditEvent(event: AdminAuditEventInput): Promise<void>;
  recordAuditEventInTransaction?(executor: DatabaseExecutor, event: AdminAuditEventInput): Promise<void>;
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

  public async recordAuditEvent(event: AdminAuditEventInput): Promise<void> {
    this.audits.unshift({
      id: String(this.audits.length + 1),
      occurredAt: new Date().toISOString(),
      action: event.action,
      objectType: event.objectType,
      result: event.result,
      reasonCode: event.reasonCode ?? null
    });
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

  public async recordAuditEventInTransaction(
    executor: DatabaseExecutor,
    event: AdminAuditEventInput
  ): Promise<void> {
    const actorId = databaseId(event.actorUserId);
    const subjectId = event.subjectUserId === undefined ? null : databaseId(event.subjectUserId);
    await executor.execute(sql`
      INSERT INTO audit_events (
        actor_user_id, subject_user_id, request_id, action, object_type, object_id,
        result, reason_code, metadata
      ) VALUES (
        ${actorId}, ${subjectId}, ${event.requestId}::uuid, ${event.action}, ${event.objectType},
        ${event.objectId ?? "global"}, ${event.result}, ${event.reasonCode ?? null},
        ${JSON.stringify(event.metadata ?? {})}::jsonb
      )
    `);
  }

  public async recordAuditEvent(event: AdminAuditEventInput): Promise<void> {
    await this.recordAuditEventInTransaction(this.database, event);
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
  public async listPermissionCatalog(): Promise<AdminPermissionCatalogResponse> {
    const groups = new Map<string, { displayName: string; permissions: AdminPermission[] }>([
      ["accounts", { displayName: "账号与权限", permissions: [] }],
      ["content", { displayName: "题目与附件", permissions: [] }],
      ["review", { displayName: "审题与状态", permissions: [] }],
      ["contest", { displayName: "组题与比赛", permissions: [] }],
      ["integration", { displayName: "插件与系统", permissions: [] }]
    ]);
    for (const permission of this.listPermissions()) {
      const key =
        permission.name.startsWith("problem.") || permission.name === "tag.manage"
          ? "content"
          : permission.name.startsWith("contest.")
            ? "contest"
            : permission.name.startsWith("review.")
              ? "review"
              : permission.name.startsWith("plugin.") ||
                  permission.name.startsWith("service_account.") ||
                  permission.name === "system.manage"
                ? "integration"
                : "accounts";
      groups.get(key)!.permissions.push(permission);
    }
    return adminPermissionCatalogResponseSchema.parse({
      groups: [...groups].map(([key, group]) => ({ key, ...group }))
    });
  }

  public async listManagedUsers(search = "", page = 1, pageSize = 30): Promise<AdminUsersResponse> {
    const normalizedSearch = search.trim().toLocaleLowerCase();
    const users = (await this.options.store.listUsers()).filter((user) =>
      normalizedSearch.length === 0 ||
      user.id.toLocaleLowerCase().includes(normalizedSearch) ||
      user.nickname.toLocaleLowerCase().includes(normalizedSearch) ||
      user.username?.toLocaleLowerCase().includes(normalizedSearch) === true
    ).sort((left, right) => left.nickname.localeCompare(right.nickname, "zh-CN"));
    const offset = (page - 1) * pageSize;
    return adminUsersResponseSchema.parse({
      items: users.slice(offset, offset + pageSize).map((user) => ({
        id: user.id,
        nickname: user.nickname,
        username: user.username ?? null,
        accountType: user.accountType,
        enabled: !user.disabled,
        roles: user.roles
      })),
      total: users.length,
      page,
      pageSize
    });
  }

  public async getManagedUserPermissionDelta(
    actor: StoredUser,
    userId: string
  ): Promise<AdminUserPermissionDeltaResponse> {
    const target = await this.options.store.getUser(userId);
    this.assertPermissionDeltaManager(actor, target);
    return this.buildUserPermissionDelta(target!);
  }
  public async updateManagedUserPermissionDelta(
    actor: StoredUser,
    userId: string,
    input: {
      expectedRevision: number;
      allows: readonly string[];
      denies: readonly string[];
    },
    requestId: string,
    auditContext: AdminMutationAuditContext = {}
  ): Promise<AdminUserPermissionDeltaResponse> {
    const target = await this.options.store.getUser(userId);
    this.assertPermissionDeltaManager(actor, target);
    const known = new Set<string>(corePermissions);
    const allows = [...new Set(input.allows)];
    const denies = [...new Set(input.denies)];
    if (
      allows.some((permission) => !known.has(permission)) ||
      denies.some((permission) => !known.has(permission))
    ) {
      throw new ApiError(422, "PERMISSION_UNKNOWN", "包含未知权限。");
    }
    if (!actor.isRoot && actor.id !== "0" && (
      allows.includes("user.impersonate") ||
      denies.includes("user.impersonate") ||
      target!.isRoot
    )) {
      throw new ApiError(403, "ROOT_PRIVILEGE_REQUIRED", "只有 root 可以管理 root 等价权限。");
    }
    if (target!.isRoot) {
      throw new ApiError(409, "ROOT_DELTA_IMMUTABLE", "root 账号的完整权限不可改为用户增量。");
    }
    const auditActorUserId = auditContext.auditActorUserId ?? actor.id;
    const auditEvent: AdminAuditEventInput = {
      actorUserId: auditActorUserId,
      subjectUserId: userId,
      requestId,
      action: "admin.user_permission_delta.update",
      objectType: "user",
      objectId: userId,
      result: "success",
      metadata: {
        allows,
        denies,
        effectiveUserId: actor.id
      }
    };
    let delta: UserPermissionDelta;
    try {
      delta = await this.options.store.replaceUserPermissionDeltaAtomic({
        userId,
        expectedRevision: input.expectedRevision,
        allows: allows as ReplaceUserPermissionDeltaInput["allows"],
        denies: denies as ReplaceUserPermissionDeltaInput["denies"],
        actorUserId: auditActorUserId,
        authorizationUserId: actor.id,
        requestId,
        authorizeActor: (currentActor, currentTarget) => {
          this.assertPermissionDeltaManager(currentActor, currentTarget);
          if (!currentActor.isRoot && currentActor.id !== "0" && (
            allows.includes("user.impersonate") ||
            denies.includes("user.impersonate") ||
            currentTarget.isRoot
          )) {
            throw new ApiError(403, "ROOT_PRIVILEGE_REQUIRED", "只有 root 可以管理 root 等价权限。");
          }
          if (currentTarget.isRoot) {
            throw new ApiError(409, "ROOT_DELTA_IMMUTABLE", "root 账号的完整权限不可改为用户增量。");
          }
        },
        writeAudit: async (executor) => {
          try {
            if (executor === undefined) {
              await this.settingsStore.recordAuditEvent(auditEvent);
              return;
            }
            if (this.settingsStore.recordAuditEventInTransaction === undefined) {
              throw new Error("AUDIT_TRANSACTION_UNAVAILABLE");
            }
            await this.settingsStore.recordAuditEventInTransaction(executor, auditEvent);
          } catch {
            throw new Error("AUDIT_WRITE_FAILED");
          }
        }
      });
    } catch (error) {
      if (error instanceof Error && error.message === "PERMISSION_DELTA_CONFLICT") {
        throw conflict("用户权限增量已被其他管理员修改，请刷新后重试。");
      }
      if (error instanceof Error && error.message === "USER_NOT_FOUND") {
        throw notFound();
      }
      if (error instanceof Error && error.message === "AUDIT_WRITE_FAILED") {
        throw new ApiError(503, "AUDIT_WRITE_FAILED", "审计记录暂时无法写入，权限修改未提交。");
      }
      throw error;
    }
    const updated = await this.options.store.getUser(userId);
    return this.buildUserPermissionDelta(updated!);
  }

  public async getRoleDefaults(actor: StoredUser): Promise<AdminRoleDefaultsResponse> {
    this.assertRootManager(actor);
    return adminRoleDefaultsResponseSchema.parse({
      defaults: await this.roleManagementStore.getRoleDefaults()
    });
  }
  public async updateRoleDefaults(
    actor: StoredUser,
    input: UpdateAdminRoleDefaultsInput,
    requestId: string,
    auditContext: AdminMutationAuditContext = {}
  ): Promise<AdminRoleDefaultsResponse> {
    this.assertRootManager(actor);
    const defaults = await this.roleManagementStore.updateRoleDefaults(
      input,
      this.roleMutationContext(actor, requestId, auditContext)
    );
    this.options.store.setDefaultRoleKeys?.(defaults);
    await this.settingsStore.recordAuditEvent(this.auditedAdminEvent(actor, auditContext, {
      requestId,
      action: "admin.role_defaults.update",
      objectType: "role_defaults",
      objectId: "global",
      result: "success"
    }));
    return adminRoleDefaultsResponseSchema.parse({ defaults });
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
    requestId: string,
    auditContext: AdminMutationAuditContext = {}
  ): Promise<{ role: AdminManagedRole }> {
    this.assertRoleManager(user);
    const context = this.roleMutationContext(user, requestId, auditContext);
    await this.validateRoleInput(input.permissions, input.userIds);
    assertRoleMutationSafety(input, context);
    const role = await this.roleManagementStore.createRole(input, context);
    const response = { role: await this.toPublicManagedRole(role) };
    await this.settingsStore.recordAuditEvent(this.auditedAdminEvent(user, auditContext, {
      requestId,
      action: "admin.role.create",
      objectType: "role",
      objectId: role.id,
      result: "success"
    }));
    return response;
  }

  public async updateRole(
    user: StoredUser,
    roleId: string,
    input: UpdateAdminRoleInput,
    requestId: string,
    auditContext: AdminMutationAuditContext = {}
  ): Promise<{ role: AdminManagedRole }> {
    this.assertRoleManager(user);
    const context = this.roleMutationContext(user, requestId, auditContext);
    await this.validateRoleInput(input.permissions, input.userIds);
    const role = await this.roleManagementStore.updateRole(roleId, input, context);
    const response = { role: await this.toPublicManagedRole(role) };
    await this.settingsStore.recordAuditEvent(this.auditedAdminEvent(user, auditContext, {
      requestId,
      action: "admin.role.update",
      objectType: "role",
      objectId: role.id,
      result: "success"
    }));
    return response;
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
    requestId: string,
    auditContext: AdminMutationAuditContext = {}
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
    }, this.auditedAdminEvent(user, auditContext, {
      requestId,
      action: "system.general_settings.update",
      objectType: "system_settings",
      objectId: "global",
      result: "success"
    }));
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
    requestId: string,
    auditContext: AdminMutationAuditContext = {}
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
    const saved = await this.settingsStore.updateUstcOAuthSettings(current.revision, next, this.auditedAdminEvent(user, auditContext, {
      requestId,
      action: "auth.ustc_oauth.settings.update",
      objectType: "system_oauth_settings",
      objectId: "global",
      result: "success",
      metadata: { secretChanged: input.clientSecret !== undefined || input.clearClientSecret }
    }));
    return { settings: this.toPublicUstcSettings(saved) };
  }

  public async listAudit(page: number, pageSize: number): Promise<{ items: AdminAuditEvent[]; total: number }> {
    return this.settingsStore.listAuditEvents(page, pageSize);
  }
  public async recordAuditEvent(event: AdminAuditEventInput): Promise<void> {
    await this.settingsStore.recordAuditEvent(event);
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

  private async rolesForUser(user: StoredUser): Promise<StoredAdminRole[]> {
    const roles = await this.roleManagementStore.listRoles();
    return roles.filter((role) =>
      role.memberIds.includes(user.id) ||
      user.roles.includes(role.key) ||
      user.roles.includes(role.displayName) ||
      (user.isRoot && role.key === "root")
    );
  }

  private async buildUserPermissionDelta(user: StoredUser): Promise<AdminUserPermissionDeltaResponse> {
    const [roles, delta] = await Promise.all([
      this.rolesForUser(user),
      this.options.store.getUserPermissionDelta(user.id)
    ]);
    const allowed = new Set<string>();
    const denied = new Set<string>();
    const sources = new Map<string, Set<string>>();
    const addSource = (permission: string, source: string): void => {
      const entries = sources.get(permission) ?? new Set<string>();
      entries.add(source);
      sources.set(permission, entries);
    };
    for (const role of roles) {
      for (const permission of role.permissions) {
        if (!corePermissions.includes(permission.name as typeof corePermissions[number])) continue;
        addSource(permission.name, `role:${role.key}${permission.effect === "deny" ? ":deny" : ""}`);
        (permission.effect === "deny" ? denied : allowed).add(permission.name);
      }
    }
    if (user.isRoot && user.id === "0") {
      for (const permission of corePermissions) {
        allowed.add(permission);
        addSource(permission, "root:complete");
      }
    }
    for (const permission of delta.allows) {
      allowed.add(permission);
      addSource(permission, "user:allow");
    }
    for (const permission of delta.denies) {
      denied.add(permission);
      addSource(permission, "user:deny");
    }
    const hardDenied = new Set<string>(
      user.accountType === "robot" ? robotHardDeniedPermissions : []
    );
    for (const permission of hardDenied) {
      denied.add(permission);
      addSource(permission, "robot:hard-deny");
    }
    const entries = corePermissions.map((name) => ({
      name,
      allowed: allowed.has(name) && !denied.has(name),
      sources: [...(sources.get(name) ?? new Set(["none"]))]
    }));
    return adminUserPermissionDeltaResponseSchema.parse({
      delta: {
        userId: user.id,
        roles: roles.map((role) => role.key),
        allows: delta.allows,
        denies: delta.denies,
        effective: entries.filter((entry) => entry.allowed).map((entry) => entry.name),
        revision: delta.revision
      },
      effective: {
        permissions: entries.filter((entry) => entry.allowed).map((entry) => entry.name),
        entries
      }
    });
  }

  private assertPermissionDeltaManager(actor: StoredUser, target: StoredUser | undefined): void {
    if (
      actor.accountType !== "human" ||
      !hasPermission(actor, "user.permission.manage", {}, this.now()) ||
      target === undefined ||
      target.accountType === "robot" ||
      (target.isRoot && !(actor.isRoot && actor.id === "0"))
    ) {
      throw notFound();
    }
  }

  private assertRootManager(actor: StoredUser): void {
    if (actor.accountType !== "human" || !actor.isRoot || actor.id !== "0") {
      throw notFound();
    }
  }

  private roleMutationContext(
    user: StoredUser,
    requestId: string,
    auditContext: AdminMutationAuditContext = {}
  ): AdminRoleMutationContext {
    return createAdminRoleMutationContext(user, requestId, this.now(), auditContext.auditActorUserId);
  }

  private auditedAdminEvent(
    user: StoredUser,
    auditContext: AdminMutationAuditContext,
    event: Omit<AdminAuditEventInput, "actorUserId">
  ): AdminAuditEventInput {
    const effectiveUserId = auditContext.auditActorUserId !== undefined && auditContext.auditActorUserId !== user.id
      ? user.id
      : undefined;
    const metadata = effectiveUserId === undefined
      ? event.metadata
      : { ...event.metadata, effectiveUserId };
    return {
      actorUserId: auditContext.auditActorUserId ?? user.id,
      ...event,
      ...(metadata === undefined ? {} : { metadata })
    };
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
