import { z } from "zod";

const urlOrPath = z.string().trim().max(2048);

export const adminGeneralSettingsSchema = z.object({
  emailLoginEnabled: z.boolean(),
  emailRegistrationEnabled: z.boolean(),
  publicRegistrationEnabled: z.boolean(),
  publicSiteUrl: z.string(),
  smtpConfigured: z.boolean(),
  smtpHost: z.string().max(253),
  smtpPort: z.number().int().min(1).max(65_535),
  smtpSecure: z.boolean(),
  smtpUsername: z.string().max(512),
  smtpFromEmail: z.string().max(320),
  smtpFromName: z.string().max(200),
  smtpPasswordConfigured: z.boolean(),
  secureCookies: z.boolean(),
  loopbackInsecureCookies: z.boolean(),
  webOrigins: z.array(z.string()).max(32),
  revision: z.number().int().positive()
}).strict();
export type AdminGeneralSettings = z.infer<typeof adminGeneralSettingsSchema>;

export const updateAdminGeneralSettingsInputSchema = z.object({
  expectedRevision: z.number().int().positive(),
  publicRegistrationEnabled: z.boolean(),
  publicSiteUrl: urlOrPath,
  emailLoginEnabled: z.boolean().optional(),
  smtpHost: z.string().trim().max(253).optional(),
  smtpPort: z.number().int().min(1).max(65_535).optional(),
  smtpSecure: z.boolean().optional(),
  smtpUsername: z.string().trim().max(512).optional(),
  smtpFromEmail: z.string().trim().max(320).optional(),
  smtpFromName: z.string().trim().max(200).optional(),
  smtpPassword: z.string().max(4096).optional(),
  clearSmtpPassword: z.boolean().default(false)
}).strict().superRefine((value, context) => {
  if (value.smtpPassword !== undefined && value.clearSmtpPassword) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["smtpPassword"], message: "不能同时设置和清除 SMTP 密码。" });
  }
});
export type UpdateAdminGeneralSettingsInput = z.infer<typeof updateAdminGeneralSettingsInputSchema>;

export const ustcOAuthSettingsSchema = z.object({
  enabled: z.boolean(),
  authorizeUrl: urlOrPath,
  tokenUrl: urlOrPath,
  profileUrl: urlOrPath,
  redirectUri: urlOrPath,
  scope: z.string().trim().max(1024),
  clientIdConfigured: z.boolean(),
  clientSecretConfigured: z.boolean(),
  revision: z.number().int().positive()
}).strict();
export type UstcOAuthSettings = z.infer<typeof ustcOAuthSettingsSchema>;

export const updateUstcOAuthSettingsInputSchema = z.object({
  expectedRevision: z.number().int().positive(),
  enabled: z.boolean(),
  authorizeUrl: urlOrPath,
  tokenUrl: urlOrPath,
  profileUrl: urlOrPath,
  redirectUri: urlOrPath,
  scope: z.string().trim().max(1024),
  clientId: z.string().trim().max(512),
  clearClientId: z.boolean().default(false),
  clientSecret: z.string().max(4096).optional(),
  clearClientSecret: z.boolean().default(false)
}).strict().superRefine((value, context) => {
  if (value.clientSecret !== undefined && value.clientSecret.length < 16) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["clientSecret"], message: "客户端密钥至少需要 16 个字符。" });
  }
  if (value.clientSecret !== undefined && value.clearClientSecret) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["clientSecret"], message: "不能同时设置和清除客户端密钥。" });
  }
});
export type UpdateUstcOAuthSettingsInput = z.infer<typeof updateUstcOAuthSettingsInputSchema>;

export const adminSettingsQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20)
}).strict();

export const adminRoleSchema = z.object({
  key: z.string(),
  displayName: z.string(),
  description: z.string(),
  permissions: z.array(z.string())
}).strict();
export const adminRolesResponseSchema = z.object({ roles: z.array(adminRoleSchema) }).strict();

export const adminPermissionSchema = z.object({
  name: z.string(),
  displayName: z.string(),
  description: z.string()
}).strict();
export const adminPermissionsResponseSchema = z.object({ permissions: z.array(adminPermissionSchema) }).strict();

export const adminServiceAccountSchema = z.object({
  id: z.string(),
  nickname: z.string(),
  accountType: z.literal("robot"),
  enabled: z.boolean(),
  tokenConfigured: z.boolean()
}).strict();
export const adminServiceAccountsResponseSchema = z.object({
  items: z.array(adminServiceAccountSchema)
}).strict();

export const adminAuditEventSchema = z.object({
  id: z.string(),
  occurredAt: z.string(),
  action: z.string(),
  objectType: z.string(),
  result: z.string(),
  reasonCode: z.string().nullable()
}).strict();
export const adminAuditResponseSchema = z.object({
  items: z.array(adminAuditEventSchema),
  total: z.number().int().nonnegative()
}).strict();

export type AdminRole = z.infer<typeof adminRoleSchema>;
export type AdminPermission = z.infer<typeof adminPermissionSchema>;
export type AdminServiceAccount = z.infer<typeof adminServiceAccountSchema>;
export type AdminAuditEvent = z.infer<typeof adminAuditEventSchema>;
export type AdminRolesResponse = z.infer<typeof adminRolesResponseSchema>;
export type AdminPermissionsResponse = z.infer<typeof adminPermissionsResponseSchema>;
export type AdminServiceAccountsResponse = z.infer<typeof adminServiceAccountsResponseSchema>;
export type AdminAuditResponse = z.infer<typeof adminAuditResponseSchema>;

export const importHistoryQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),

  pageSize: z.coerce.number().int().min(1).max(100).default(20),
  state: z.enum(["queued", "running", "succeeded", "failed", "cancelled"]).optional(),
  format: z.string().trim().max(64).optional()
}).strict();

export const importHistoryItemSchema = z.object({
  id: z.string(),
  state: z.enum(["queued", "running", "succeeded", "failed", "cancelled"]),
  phase: z.string().nullable(),
  progressPercent: z.number().int().min(0).max(100),
  completedItems: z.number().int().nonnegative(),
  failedItems: z.number().int().nonnegative(),
  selectedFormat: z.string().nullable(),
  createdAt: z.string(),
  finishedAt: z.string().nullable(),
  importedProblemIds: z.array(z.string())
}).strict();
export const importHistoryResponseSchema = z.object({
  items: z.array(importHistoryItemSchema),
  page: z.number().int().positive(),
  pageSize: z.number().int().positive(),
  total: z.number().int().nonnegative()
}).strict();
export type ImportHistoryQuery = z.infer<typeof importHistoryQuerySchema>;
export type ImportHistoryResponse = z.infer<typeof importHistoryResponseSchema>;
export type ImportHistoryItem = z.infer<typeof importHistoryItemSchema>;
export const adminRolePermissionSchema = z.object({
  name: z.string().trim().min(1).max(160),
  effect: z.enum(["allow", "deny"])
}).strict();

export const adminRoleMemberSchema = z.object({
  id: z.string().trim().min(1).max(80),
  nickname: z.string().trim().min(1).max(120),
  accountType: z.enum(["human", "robot"]),
  enabled: z.boolean()
}).strict();

export const adminManagedRoleSchema = z.object({
  id: z.string().uuid(),
  key: z.string().trim().min(1).max(80).regex(/^[a-z0-9]+(?:[_-][a-z0-9]+)*$/),
  displayName: z.string().trim().min(1).max(120),
  description: z.string().trim().max(2_000),
  isBuiltIn: z.boolean(),
  revision: z.number().int().positive(),
  permissions: z.array(adminRolePermissionSchema).max(500),
  members: z.array(adminRoleMemberSchema).max(5_000)
}).strict();

export const adminRoleManagementResponseSchema = z.object({
  roles: z.array(adminManagedRoleSchema),
  permissions: z.array(adminPermissionSchema),
  users: z.array(adminRoleMemberSchema)
}).strict();

export const createAdminRoleInputSchema = z.object({
  key: z.string().trim().min(1).max(80).regex(/^[a-z0-9]+(?:[_-][a-z0-9]+)*$/),
  displayName: z.string().trim().min(1).max(120),
  description: z.string().trim().max(2_000),
  permissions: z.array(adminRolePermissionSchema).max(500),
  userIds: z.array(z.string().trim().min(1).max(80)).max(5_000)
}).strict();
export type CreateAdminRoleInput = z.infer<typeof createAdminRoleInputSchema>;

export const updateAdminRoleInputSchema = createAdminRoleInputSchema.extend({
  expectedRevision: z.number().int().positive()
}).strict();
export type UpdateAdminRoleInput = z.infer<typeof updateAdminRoleInputSchema>;

export const adminRoleResponseSchema = z.object({
  role: adminManagedRoleSchema
}).strict();
export type AdminRolePermission = z.infer<typeof adminRolePermissionSchema>;
export type AdminRoleMember = z.infer<typeof adminRoleMemberSchema>;
export type AdminManagedRole = z.infer<typeof adminManagedRoleSchema>;
export type AdminRoleManagementResponse = z.infer<typeof adminRoleManagementResponseSchema>;
export type AdminRoleResponse = z.infer<typeof adminRoleResponseSchema>;

export const adminPermissionCatalogGroupSchema = z.object({
  key: z.string().trim().min(1).max(40),
  displayName: z.string().trim().min(1).max(80),
  permissions: z.array(adminPermissionSchema).max(100)
}).strict();
export const adminPermissionCatalogResponseSchema = z.object({
  groups: z.array(adminPermissionCatalogGroupSchema).max(20)
}).strict();
export type AdminPermissionCatalogGroup = z.infer<typeof adminPermissionCatalogGroupSchema>;
export type AdminPermissionCatalogResponse = z.infer<typeof adminPermissionCatalogResponseSchema>;

export const adminUserListItemSchema = z.object({
  id: z.string().trim().min(1).max(80),
  nickname: z.string().trim().min(1).max(120),
  username: z.string().trim().min(1).max(80).nullable().optional(),
  accountType: z.enum(["human", "robot"]),
  enabled: z.boolean(),
  roles: z.array(z.string()).max(100)
}).strict();
export const adminUsersResponseSchema = z.object({
  items: z.array(adminUserListItemSchema).max(100),
  total: z.number().int().nonnegative(),
  page: z.number().int().positive().default(1),
  pageSize: z.number().int().min(1).max(100).default(30)
}).strict();
export type AdminUserListItem = z.infer<typeof adminUserListItemSchema>;
export type AdminUsersResponse = z.infer<typeof adminUsersResponseSchema>;

export const adminUserPermissionDeltaSchema = z.object({
  userId: z.string().trim().min(1).max(80),
  roles: z.array(z.string()).max(100),
  allows: z.array(z.string()).max(500),
  denies: z.array(z.string()).max(500),
  effective: z.array(z.string()).max(500),
  revision: z.number().int().positive()
}).strict();
export const updateAdminUserPermissionDeltaInputSchema = z.object({
  expectedRevision: z.number().int().positive(),
  allows: z.array(z.string().trim().min(1).max(160)).max(500),
  denies: z.array(z.string().trim().min(1).max(160)).max(500)
}).strict();
export type UpdateAdminUserPermissionDeltaInput = z.infer<typeof updateAdminUserPermissionDeltaInputSchema>;
export const adminPermissionEffectiveEntrySchema = z.object({
  name: z.string().trim().min(1).max(160),
  allowed: z.boolean(),
  sources: z.array(z.string().trim().min(1).max(160)).max(20)
}).strict();
export const adminUserPermissionDeltaResponseSchema = z.object({
  delta: adminUserPermissionDeltaSchema,
  effective: z.object({
    permissions: z.array(z.string()).max(500),
    entries: z.array(adminPermissionEffectiveEntrySchema).max(500)
  }).strict()
}).strict();
export type AdminPermissionEffectiveEntry = z.infer<typeof adminPermissionEffectiveEntrySchema>;
export type AdminUserPermissionDeltaResponse = z.infer<typeof adminUserPermissionDeltaResponseSchema>;

export const adminRoleDefaultsSchema = z.object({
  humanRoleKey: z.string().trim().min(1).max(80),
  robotRoleKey: z.string().trim().min(1).max(80),
  revision: z.number().int().positive()
}).strict();
export const adminRoleDefaultsResponseSchema = z.object({
  defaults: adminRoleDefaultsSchema
}).strict();
export const updateAdminRoleDefaultsInputSchema = z.object({
  expectedRevision: z.number().int().positive(),
  humanRoleKey: z.string().trim().min(1).max(80),
  robotRoleKey: z.string().trim().min(1).max(80)
}).strict();
export type AdminRoleDefaults = z.infer<typeof adminRoleDefaultsSchema>;
export type AdminRoleDefaultsResponse = z.infer<typeof adminRoleDefaultsResponseSchema>;
export type UpdateAdminRoleDefaultsInput = z.infer<typeof updateAdminRoleDefaultsInputSchema>;
