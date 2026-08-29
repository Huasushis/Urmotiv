import { sql } from "drizzle-orm";
import {
  type AnyPgColumn,
  bigint,
  boolean,
  char,
  check,
  customType,
  foreignKey,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  smallint,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar
} from "drizzle-orm/pg-core";

/**
 * PostgreSQL bytea 列（二进制字节）。当前 drizzle 版本未内置 bytea 构建器，
 * 用 customType 声明为驱动层直接透传的 Uint8Array。
 */
export const bytea = customType<{ data: Uint8Array }>({
  dataType() {
    return "bytea";
  }
});

export type JsonObject = Record<string, unknown>;
export type JsonValue = boolean | number | string | null | JsonObject | JsonValue[];

const emptyObject = sql`'{}'::jsonb`;
const emptyArray = sql`'[]'::jsonb`;

export const accountType = pgEnum("account_type", ["human", "robot", "service"]);
export const permissionEffect = pgEnum("permission_effect", ["allow", "deny"]);
export const permissionScope = pgEnum("permission_scope", ["global", "own", "object"]);
export const problemType = pgEnum("problem_type", [
  "traditional",
  "interactive",
  "submit_answer"
]);
export const problemStatus = pgEnum("problem_status", [
  "draft",
  "pending_review",
  "approved",
  "rejected"
]);
export const reviewRoundStatus = pgEnum("review_round_status", [
  "open",
  "approved",
  "rejected",
  "withdrawn"
]);
export const reviewVerdict = pgEnum("review_verdict", [
  "approve",
  "request_changes",
  "reject"
]);
export const reviewSource = pgEnum("review_source", [
  "human",
  "anklang",
  "fermata",
  "plugin"
]);
export const reviewItemVisibility = pgEnum("review_item_visibility", [
  "author",
  "reviewer",
  "administrator"
]);
export const pluginState = pgEnum("plugin_state", [
  "enabled",
  "disabled",
  "failed"
]);
export const filePurpose = pgEnum("file_purpose", [
  "problem",
  "import_input",
  "export_output",
  "temporary"
]);
export const problemFileCategory = pgEnum("problem_file_category", [
  "statement_image",
  "public_attachment",
  "internal_attachment",
  "testdata",
  "checker",
  "interactor",
  "answer_checker",
  "standard_solution"
]);
export const contestState = pgEnum("contest_state", [
  "draft",
  "locked",
  "archived"
]);
export const contestMemberRole = pgEnum("contest_member_role", [
  "participant",
  "manager"
]);
export const taskState = pgEnum("task_state", [
  "queued",
  "running",
  "succeeded",
  "failed",
  "cancelled"
]);
export const problemPackageJobKind = pgEnum("problem_package_job_kind", [
  "import",
  "export"
]);
export const auditResult = pgEnum("audit_result", ["success", "denied", "failure"]);
export const adminBootstrapStatus = pgEnum("admin_bootstrap_status", [
  "blocked",
  "open",
  "completed"
]);
export const reviewAssignmentKind = pgEnum("review_assignment_kind", ["human", "robot"]);
export const reviewAssignmentClosureReason = pgEnum("review_assignment_closure_reason", [
  "completed",
  "expired",
  "round_closed",
  "permission_revoked",
  "content_changed",
  "abandoned",
  "legacy_closed"
]);
export const reviewAssignmentOperation = pgEnum("review_assignment_operation", [
  "renew",
  "complete"
]);
export const tagItemKind = pgEnum("tag_item_kind", ["category", "tag"]);

export const adminBootstrapState = pgTable(
  "admin_bootstrap_state",
  {
    singleton: boolean("singleton").primaryKey().default(true),
    status: adminBootstrapStatus("status").notNull().default("blocked"),
    openedAt: timestamp("opened_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow()
  },
  (table) => [
    check("admin_bootstrap_state_singleton_ck", sql`${table.singleton} = true`),
    check(
      "admin_bootstrap_state_timestamps_ck",
      sql`(${table.status} = 'blocked' AND ${table.openedAt} IS NULL AND ${table.completedAt} IS NULL) OR (${table.status} = 'open' AND ${table.openedAt} IS NOT NULL AND ${table.completedAt} IS NULL) OR (${table.status} = 'completed' AND ${table.openedAt} IS NOT NULL AND ${table.completedAt} IS NOT NULL AND ${table.completedAt} >= ${table.openedAt})`
    )
  ]
);

export const users = pgTable(
  "users",
  {
    id: bigint("id", { mode: "bigint" })
      .primaryKey()
      .generatedByDefaultAsIdentity({ name: "users_id_seq", startWith: 1 }),
    nickname: varchar("nickname", { length: 120 }).notNull(),
    username: varchar("username", { length: 255 }),
    realName: varchar("real_name", { length: 120 }),
    accountType: accountType("account_type").notNull().default("human"),
    passwordHash: text("password_hash"),
    authRevision: integer("auth_revision").notNull().default(1),
    passwordChangedAt: timestamp("password_changed_at", { withTimezone: true }),
    disabledAt: timestamp("disabled_at", { withTimezone: true }),
    disabledReason: varchar("disabled_reason", { length: 500 }),
    qq: varchar("qq", { length: 20 }),
    avatarSource: varchar("avatar_source", { length: 10 })
      .notNull()
      .default("none"),
    avatar: bytea("avatar"),
    avatarMediaType: varchar("avatar_media_type", { length: 40 }),
    avatarUpdatedAt: timestamp("avatar_updated_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow()
  },
  (table) => [
    check("users_nonnegative_id_ck", sql`${table.id} >= 0`),
    check(
      "users_username_not_blank_ck",
      sql`${table.username} IS NULL OR length(btrim(${table.username})) > 0`
    ),
    check(
      "users_real_name_not_blank_ck",
      sql`${table.realName} IS NULL OR length(btrim(${table.realName})) > 0`
    ),
    check("users_auth_revision_ck", sql`${table.authRevision} > 0`),
    check(
      "users_root_is_human_ck",
      sql`${table.id} <> 0 OR ${table.accountType} = 'human'`
    ),
    check(
      "users_qq_format_ck",
      sql`${table.qq} IS NULL OR ${table.qq} ~ '^[1-9][0-9]{4,10}$'`
    ),
    check(
      "users_avatar_source_ck",
      sql`${table.avatarSource} IN ('none', 'qq', 'uploaded')`
    ),
    check(
      "users_avatar_source_bytes_ck",
      sql`(${table.avatarSource} = 'none' AND ${table.avatar} IS NULL AND ${table.avatarMediaType} IS NULL)
        OR (${table.avatarSource} = 'uploaded' AND ${table.avatar} IS NOT NULL AND ${table.avatarMediaType} IS NOT NULL)
        OR (${table.avatarSource} = 'qq' AND ${table.avatar} IS NULL AND ${table.avatarMediaType} IS NULL AND ${table.qq} IS NOT NULL)`
    ),
    index("users_account_type_idx").on(table.accountType),
    index("users_active_idx").on(table.disabledAt),
    index("users_qq_idx").on(table.qq).where(sql`${table.qq} IS NOT NULL`)
  ]
);

export const systemSettings = pgTable(
  "system_settings",
  {
    id: varchar("id", { length: 32 }).primaryKey(),
    enabled: boolean("enabled").notNull().default(false),
    authorizeUrl: text("authorize_url").notNull().default(""),
    tokenUrl: text("token_url").notNull().default(""),
    profileUrl: text("profile_url").notNull().default(""),
    redirectUri: text("redirect_uri").notNull().default("/api/v1/auth/ustc/callback"),
    scope: text("scope").notNull().default(""),
    publicRegistrationEnabled: boolean("public_registration_enabled").notNull().default(false),
    publicSiteUrl: text("public_site_url").notNull().default(""),
    clientIdEncrypted: text("client_id_encrypted"),
    clientSecretEncrypted: text("client_secret_encrypted"),
    revision: integer("revision").notNull().default(1),
    updatedByUserId: bigint("updated_by_user_id", { mode: "bigint" }).references(() => users.id, {
      onDelete: "set null"
    }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow()
  },
  (table) => [check("system_settings_revision_ck", sql`${table.revision} > 0`)]
);

export const userEmails = pgTable(
  "user_emails",
  {
    id: uuid("id").primaryKey(),
    userId: bigint("user_id", { mode: "bigint" })
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    address: varchar("address", { length: 320 }).notNull(),
    normalizedAddress: varchar("normalized_address", { length: 320 }).notNull(),
    isPrimary: boolean("is_primary").notNull().default(false),
    verifiedAt: timestamp("verified_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow()
  },
  (table) => [
    uniqueIndex("user_emails_normalized_uq").on(table.normalizedAddress),
    uniqueIndex("user_emails_one_primary_uq")
      .on(table.userId)
      .where(sql`${table.isPrimary} = true`),
    index("user_emails_user_idx").on(table.userId),
    check(
      "user_emails_normalized_ck",
      sql`${table.normalizedAddress} = lower(btrim(${table.normalizedAddress}))`
    ),
    check("user_emails_not_blank_ck", sql`length(btrim(${table.address})) > 0`)
  ]
);

export const externalIdentities = pgTable(
  "external_identities",
  {
    id: uuid("id").primaryKey(),
    userId: bigint("user_id", { mode: "bigint" })
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    provider: varchar("provider", { length: 80 }).notNull(),
    subject: varchar("subject", { length: 255 }).notNull(),
    profile: jsonb("profile").$type<JsonObject>().notNull().default(emptyObject),
    lastAuthenticatedAt: timestamp("last_authenticated_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow()
  },
  (table) => [
    uniqueIndex("external_identities_provider_subject_uq").on(
      table.provider,
      table.subject
    ),
    index("external_identities_user_idx").on(table.userId),
    check("external_identities_provider_ck", sql`length(btrim(${table.provider})) > 0`),
    check("external_identities_subject_ck", sql`length(btrim(${table.subject})) > 0`)
  ]
);

export const userIdentifiers = pgTable(
  "user_identifiers",
  {
    id: uuid("id").primaryKey(),
    userId: bigint("user_id", { mode: "bigint" })
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    kind: varchar("kind", { length: 80 }).notNull(),
    value: varchar("value", { length: 255 }).notNull(),
    source: varchar("source", { length: 120 }).notNull(),
    validFrom: timestamp("valid_from", { withTimezone: true }),
    validUntil: timestamp("valid_until", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow()
  },
  (table) => [
    uniqueIndex("user_identifiers_source_value_uq").on(
      table.kind,
      table.source,
      table.value
    ),
    index("user_identifiers_user_idx").on(table.userId),
    index("user_identifiers_lookup_idx").on(table.kind, table.value),
    check(
      "user_identifiers_valid_range_ck",
      sql`${table.validUntil} IS NULL OR ${table.validFrom} IS NULL OR ${table.validUntil} > ${table.validFrom}`
    )
  ]
);

export const permissionDefinitions = pgTable(
  "permission_definitions",
  {
    name: varchar("name", { length: 160 }).primaryKey(),
    displayName: varchar("display_name", { length: 120 }).notNull(),
    description: text("description").notNull(),
    source: varchar("source", { length: 160 }).notNull().default("core"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow()
  },
  (table) => [
    check(
      "permission_definitions_name_ck",
      sql`${table.name} ~ '^[a-z0-9]+([._-][a-z0-9]+)*$'`
    ),
    index("permission_definitions_source_idx").on(table.source)
  ]
);

export const roles = pgTable(
  "roles",
  {
    id: uuid("id").primaryKey(),
    key: varchar("key", { length: 80 }).notNull(),
    displayName: varchar("display_name", { length: 120 }).notNull(),
    description: text("description").notNull(),
    isBuiltIn: boolean("is_built_in").notNull().default(false),
    revision: integer("revision").notNull().default(1),
    createdByUserId: bigint("created_by_user_id", { mode: "bigint" }).references(
      () => users.id,
      { onDelete: "set null" }
    ),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow()
  },
  (table) => [
    uniqueIndex("roles_key_uq").on(table.key),
    check("roles_key_ck", sql`${table.key} ~ '^[a-z0-9]+([_-][a-z0-9]+)*$'`)
  ]
);

export const roleMemberships = pgTable(
  "role_memberships",
  {
    id: uuid("id").primaryKey(),
    userId: bigint("user_id", { mode: "bigint" })
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    roleId: uuid("role_id")
      .notNull()
      .references(() => roles.id, { onDelete: "cascade" }),
    grantedByUserId: bigint("granted_by_user_id", { mode: "bigint" })
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    reason: varchar("reason", { length: 500 }).notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    revokedByUserId: bigint("revoked_by_user_id", { mode: "bigint" }).references(
      () => users.id,
      { onDelete: "restrict" }
    ),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow()
  },
  (table) => [
    uniqueIndex("role_memberships_active_uq")
      .on(table.userId, table.roleId)
      .where(sql`${table.revokedAt} IS NULL`),
    index("role_memberships_role_idx").on(table.roleId),
    check(
      "role_memberships_revoke_ck",
      sql`(${table.revokedAt} IS NULL AND ${table.revokedByUserId} IS NULL) OR (${table.revokedAt} IS NOT NULL AND ${table.revokedByUserId} IS NOT NULL)`
    ),
    check(
      "role_memberships_expiry_ck",
      sql`${table.expiresAt} IS NULL OR ${table.expiresAt} > ${table.createdAt}`
    )
  ]
);

export const permissionGrants = pgTable(
  "permission_grants",
  {
    id: uuid("id").primaryKey(),
    subjectUserId: bigint("subject_user_id", { mode: "bigint" }).references(() => users.id, {
      onDelete: "cascade"
    }),
    subjectRoleId: uuid("subject_role_id").references(() => roles.id, {
      onDelete: "cascade"
    }),
    permissionName: varchar("permission_name", { length: 160 })
      .notNull()
      .references(() => permissionDefinitions.name, { onDelete: "restrict" }),
    effect: permissionEffect("effect").notNull(),
    scope: permissionScope("scope").notNull(),
    objectType: varchar("object_type", { length: 80 }),
    objectId: varchar("object_id", { length: 160 }),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    grantedByUserId: bigint("granted_by_user_id", { mode: "bigint" })
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    reason: varchar("reason", { length: 500 }).notNull(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    revokedByUserId: bigint("revoked_by_user_id", { mode: "bigint" }).references(
      () => users.id,
      { onDelete: "restrict" }
    ),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow()
  },
  (table) => [
    index("permission_grants_user_lookup_idx").on(
      table.subjectUserId,
      table.permissionName,
      table.effect,
      table.scope
    ),
    index("permission_grants_role_lookup_idx").on(
      table.subjectRoleId,
      table.permissionName,
      table.effect,
      table.scope
    ),
    index("permission_grants_object_lookup_idx").on(table.objectType, table.objectId),
    check(
      "permission_grants_one_subject_ck",
      sql`num_nonnulls(${table.subjectUserId}, ${table.subjectRoleId}) = 1`
    ),
    check(
      "permission_grants_scope_ck",
      sql`(${table.scope} = 'object' AND ${table.objectType} IS NOT NULL AND ${table.objectId} IS NOT NULL) OR (${table.scope} <> 'object' AND ${table.objectType} IS NULL AND ${table.objectId} IS NULL)`
    ),
    check(
      "permission_grants_revoke_ck",
      sql`(${table.revokedAt} IS NULL AND ${table.revokedByUserId} IS NULL) OR (${table.revokedAt} IS NOT NULL AND ${table.revokedByUserId} IS NOT NULL)`
    )
  ]
);

export const sessions = pgTable(
  "sessions",
  {
    id: uuid("id").primaryKey(),
    tokenDigest: char("token_digest", { length: 64 }).notNull(),
    userId: bigint("user_id", { mode: "bigint" })
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    impersonatorUserId: bigint("impersonator_user_id", { mode: "bigint" }).references(
      () => users.id,
      { onDelete: "cascade" }
    ),
    authRevision: integer("auth_revision").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow()
  },
  (table) => [
    uniqueIndex("sessions_token_digest_uq").on(table.tokenDigest),
    index("sessions_user_active_idx").on(table.userId, table.expiresAt),
    index("sessions_expiry_idx").on(table.expiresAt),
    check("sessions_digest_ck", sql`${table.tokenDigest} ~ '^[0-9a-f]{64}$'`),
    check("sessions_auth_revision_ck", sql`${table.authRevision} > 0`),
    check("sessions_expiry_ck", sql`${table.expiresAt} > ${table.createdAt}`),
    check(
      "sessions_impersonator_ck",
      sql`${table.impersonatorUserId} IS NULL OR ${table.impersonatorUserId} <> ${table.userId}`
    )
  ]
);

/** One-time CAS login states. Only a SHA-256 digest of the random state nonce is stored. */
export const loginStates = pgTable(
  "login_states",
  {
    nonceDigest: char("nonce_digest", { length: 64 }).primaryKey(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    consumedAt: timestamp("consumed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow()
  },
  (table) => [
    index("login_states_expiry_idx").on(table.expiresAt),
    check("login_states_digest_ck", sql`${table.nonceDigest} ~ '^[0-9a-f]{64}$'`)
  ]
);

/** One-time email verification records. The original verification token is never stored. */
export const emailVerificationTokens = pgTable(
  "email_verification_tokens",
  {
    tokenDigest: char("token_digest", { length: 64 }).primaryKey(),
    userId: bigint("user_id", { mode: "bigint" })
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    normalizedAddress: varchar("normalized_address", { length: 320 }).notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    consumedAt: timestamp("consumed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow()
  },
  (table) => [
    index("email_verification_tokens_user_email_idx").on(table.userId, table.normalizedAddress),
    index("email_verification_tokens_expiry_idx").on(table.expiresAt),
    check(
      "email_verification_tokens_digest_ck",
      sql`${table.tokenDigest} ~ '^[0-9a-f]{64}$'`
    ),
    check("email_verification_tokens_not_blank_ck", sql`length(btrim(${table.normalizedAddress})) > 0`)
  ]
);

export const apiTokens = pgTable(
  "api_tokens",
  {
    id: uuid("id").primaryKey(),
    userId: bigint("user_id", { mode: "bigint" })
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    name: varchar("name", { length: 120 }).notNull(),
    tokenPrefix: varchar("token_prefix", { length: 24 }).notNull(),
    tokenDigest: char("token_digest", { length: 64 }).notNull(),
    sourceCidrs: jsonb("source_cidrs").$type<string[]>().notNull().default(emptyArray),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    createdByUserId: bigint("created_by_user_id", { mode: "bigint" })
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow()
  },
  (table) => [
    uniqueIndex("api_tokens_digest_uq").on(table.tokenDigest),
    index("api_tokens_user_active_idx").on(table.userId, table.expiresAt),
    check("api_tokens_digest_ck", sql`${table.tokenDigest} ~ '^[0-9a-f]{64}$'`),
    check(
      "api_tokens_expiry_ck",
      sql`${table.expiresAt} IS NULL OR ${table.expiresAt} > ${table.createdAt}`
    )
  ]
);

export const apiTokenPermissions = pgTable(
  "api_token_permissions",
  {
    id: uuid("id").primaryKey(),
    tokenId: uuid("token_id")
      .notNull()
      .references(() => apiTokens.id, { onDelete: "cascade" }),
    permissionName: varchar("permission_name", { length: 160 })
      .notNull()
      .references(() => permissionDefinitions.name, { onDelete: "restrict" }),
    effect: permissionEffect("effect").notNull().default("allow"),
    scope: permissionScope("scope").notNull(),
    objectType: varchar("object_type", { length: 80 }),
    objectId: varchar("object_id", { length: 160 })
  },
  (table) => [
    index("api_token_permissions_lookup_idx").on(
      table.tokenId,
      table.permissionName,
      table.effect
    ),
    check(
      "api_token_permissions_scope_ck",
      sql`(${table.scope} = 'object' AND ${table.objectType} IS NOT NULL AND ${table.objectId} IS NOT NULL) OR (${table.scope} <> 'object' AND ${table.objectType} IS NULL AND ${table.objectId} IS NULL)`
    )
  ]
);

export const installedPlugins = pgTable(
  "installed_plugins",
  {
    id: varchar("id", { length: 160 }).primaryKey(),
    displayName: varchar("display_name", { length: 120 }).notNull(),
    version: varchar("version", { length: 80 }).notNull(),
    apiVersion: varchar("api_version", { length: 40 }).notNull(),
    source: varchar("source", { length: 500 }).notNull(),
    manifestDigest: char("manifest_digest", { length: 64 }).notNull(),
    state: pluginState("state").notNull().default("disabled"),
    failureCode: varchar("failure_code", { length: 120 }),
    installedByUserId: bigint("installed_by_user_id", { mode: "bigint" })
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    installedAt: timestamp("installed_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow()
  },
  (table) => [
    check("installed_plugins_id_ck", sql`${table.id} ~ '^[a-z0-9]+([._-][a-z0-9]+)*$'`),
    check(
      "installed_plugins_digest_ck",
      sql`${table.manifestDigest} ~ '^[0-9a-f]{64}$'`
    ),
    index("installed_plugins_state_idx").on(table.state)
  ]
);

export const pluginSettings = pgTable(
  "plugin_settings",
  {
    pluginId: varchar("plugin_id", { length: 160 })
      .primaryKey()
      .references(() => installedPlugins.id, { onDelete: "cascade" }),
    settings: jsonb("settings").$type<JsonObject>().notNull().default(emptyObject),
    revision: integer("revision").notNull().default(1),
    updatedByUserId: bigint("updated_by_user_id", { mode: "bigint" })
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow()
  },
  (table) => [check("plugin_settings_revision_ck", sql`${table.revision} > 0`)]
);

export const pluginSecrets = pgTable(
  "plugin_secrets",
  {
    pluginId: varchar("plugin_id", { length: 160 })
      .notNull()
      .references(() => installedPlugins.id, { onDelete: "cascade" }),
    name: varchar("name", { length: 120 }).notNull(),
    encryptedValue: text("encrypted_value").notNull(),
    keyVersion: integer("key_version").notNull(),
    updatedByUserId: bigint("updated_by_user_id", { mode: "bigint" })
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow()
  },
  (table) => [
    primaryKey({ columns: [table.pluginId, table.name], name: "plugin_secrets_pk" }),
    check("plugin_secrets_key_version_ck", sql`${table.keyVersion} > 0`)
  ]
);

// The migration adds the deferred current-version constraint after both tables exist.
export const problems = pgTable(
  "problems",
  {
    id: bigint("id", { mode: "bigint" })
      .primaryKey()
      .generatedByDefaultAsIdentity({ name: "problems_id_seq", startWith: 1 }),
    ownerId: bigint("owner_id", { mode: "bigint" })
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    status: problemStatus("status").notNull().default("draft"),
    currentRevision: integer("current_revision").notNull().default(1),
    currentReviewRound: integer("current_review_round").notNull().default(0),
    origin: varchar("origin", { length: 100 }).notNull().default("native"),
    importBatch: varchar("import_batch", { length: 200 }),
    importSource: varchar("import_source", { length: 200 }),
    statusChangedByUserId: bigint("status_changed_by_user_id", { mode: "bigint" }).references(
      () => users.id,
      { onDelete: "restrict" }
    ),
    statusReason: varchar("status_reason", { length: 500 }),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    deletedByUserId: bigint("deleted_by_user_id", { mode: "bigint" }).references(
      () => users.id,
      { onDelete: "restrict" }
    ),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow()
  },
  (table) => [
    check("problems_positive_revision_ck", sql`${table.currentRevision} > 0`),
    check("problems_review_round_ck", sql`${table.currentReviewRound} >= 0`),
    check(
      "problems_delete_ck",
      sql`(${table.deletedAt} IS NULL AND ${table.deletedByUserId} IS NULL) OR (${table.deletedAt} IS NOT NULL AND ${table.deletedByUserId} IS NOT NULL)`
    ),
    index("problems_owner_status_idx").on(table.ownerId, table.status),
    index("problems_status_updated_idx").on(table.status, table.updatedAt),
    index("problems_not_deleted_idx").on(table.id).where(sql`${table.deletedAt} IS NULL`)
  ]
);

export const problemRevisions = pgTable(
  "problem_revisions",
  {
    id: uuid("id").primaryKey(),
    problemId: bigint("problem_id", { mode: "bigint" })
      .notNull()
      .references(() => problems.id, { onDelete: "cascade" }),
    revision: integer("revision").notNull(),
    status: problemStatus("status").notNull(),
    title: varchar("title", { length: 200 }).notNull(),
    type: problemType("type").notNull(),
    codeforcesDifficulty: smallint("codeforces_difficulty"),
    thinkingLevel: smallint("thinking_level"),
    codingLevel: smallint("coding_level"),
    basicStatement: text("basic_statement").notNull(),
    basicSolution: text("basic_solution"),
    background: text("background").notNull().default(""),
    statement: text("statement").notNull().default(""),
    inputFormat: text("input_format").notNull().default(""),
    outputFormat: text("output_format").notNull().default(""),
    constraints: text("constraints").notNull().default(""),
    solution: text("solution").notNull().default(""),
    hints: text("hints").notNull().default(""),
    judgeConfig: jsonb("judge_config").$type<JsonObject>().notNull().default(emptyObject),
    formatExtensions: jsonb("format_extensions")
      .$type<JsonObject>()
      .notNull()
      .default(emptyObject),
    changedFields: jsonb("changed_fields").$type<string[]>().notNull().default(emptyArray),
    contentHash: char("content_hash", { length: 64 }).notNull(),
    changeReason: varchar("change_reason", { length: 500 }).notNull(),
    createdByUserId: bigint("created_by_user_id", { mode: "bigint" })
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow()
  },
  (table) => [
    uniqueIndex("problem_revisions_problem_revision_uq").on(table.problemId, table.revision),
    uniqueIndex("problem_revisions_problem_id_id_uq").on(table.problemId, table.id),
    index("problem_revisions_problem_created_idx").on(table.problemId, table.createdAt),
    index("problem_revisions_content_hash_idx").on(table.contentHash),
    index("problem_revisions_title_lower_idx").on(sql`lower(${table.title})`),
    check("problem_revisions_revision_ck", sql`${table.revision} > 0`),
    check("problem_revisions_title_ck", sql`length(btrim(${table.title})) > 0`),
    check(
      "problem_revisions_cf_difficulty_ck",
      sql`${table.codeforcesDifficulty} IS NULL OR (${table.codeforcesDifficulty} BETWEEN 800 AND 3500 AND ${table.codeforcesDifficulty} % 100 = 0)`
    ),
    check(
      "problem_revisions_thinking_level_ck",
      sql`${table.thinkingLevel} IS NULL OR ${table.thinkingLevel} BETWEEN 1 AND 5`
    ),
    check(
      "problem_revisions_coding_level_ck",
      sql`${table.codingLevel} IS NULL OR ${table.codingLevel} BETWEEN 1 AND 5`
    ),
    check(
      "problem_revisions_content_hash_ck",
      sql`${table.contentHash} ~ '^[0-9a-f]{64}$'`
    )
  ]
);

export const tags = pgTable(
  "tags",
  {
    id: varchar("id", { length: 120 }).primaryKey(),
    parentId: varchar("parent_id", { length: 120 }).references(
      (): AnyPgColumn => tags.id,
      { onDelete: "restrict" }
    ),
    name: varchar("name", { length: 80 }).notNull(),
    normalizedName: varchar("normalized_name", { length: 160 }).notNull(),
    itemKind: tagItemKind("item_kind").notNull(),
    groupName: varchar("group_name", { length: 80 }).notNull(),
    description: text("description").notNull().default(""),
    sortOrder: integer("sort_order").notNull().default(0),
    isActive: boolean("is_active").notNull().default(true),
    createdByUserId: bigint("created_by_user_id", { mode: "bigint" }).references(
      () => users.id,
      { onDelete: "set null" }
    ),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow()
  },
  (table) => [
    uniqueIndex("tags_parent_normalized_name_uq").on(
      sql`COALESCE(${table.parentId}, '')`,
      table.normalizedName
    ),
    index("tags_group_sort_idx").on(table.groupName, table.sortOrder),
    index("tags_parent_sort_idx").on(table.parentId, table.sortOrder, table.id),
    check("tags_not_self_parent_ck", sql`${table.parentId} IS NULL OR ${table.parentId} <> ${table.id}`),
    check("tags_id_format_ck", sql`${table.id} ~ '^[a-z0-9]+(?:[._-][a-z0-9]+)*$'`),
    check(
      "tags_name_ck",
      sql`length(regexp_replace(normalize(${table.name}, NFKC), '^[[:space:]]+|[[:space:]]+$', '', 'g')) > 0`
    ),
    check(
      "tags_normalized_name_ck",
      sql`length(${table.normalizedName}) > 0 AND ${table.normalizedName} = lower(regexp_replace(normalize(${table.name}, NFKC), '^[[:space:]]+|[[:space:]]+$', '', 'g'))`
    ),
    check(
      "tags_structure_ck",
      sql`(${table.itemKind} = 'category' AND ${table.parentId} IS NULL) OR (${table.itemKind} = 'tag' AND ${table.parentId} IS NOT NULL)`
    )
  ]
);

export const tagAliases = pgTable(
  "tag_aliases",
  {
    id: uuid("id").primaryKey(),
    tagId: varchar("tag_id", { length: 120 })
      .notNull()
      .references(() => tags.id, { onDelete: "restrict" }),
    name: varchar("name", { length: 160 }).notNull(),
    normalizedName: varchar("normalized_name", { length: 160 }).notNull(),
    createdByUserId: bigint("created_by_user_id", { mode: "bigint" }).references(
      () => users.id,
      { onDelete: "set null" }
    ),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow()
  },
  (table) => [
    uniqueIndex("tag_aliases_normalized_name_uq").on(table.normalizedName),
    index("tag_aliases_tag_idx").on(table.tagId, table.createdAt),
    check(
      "tag_aliases_name_ck",
      sql`length(regexp_replace(normalize(${table.name}, NFKC), '^[[:space:]]+|[[:space:]]+$', '', 'g')) > 0`
    ),
    check(
      "tag_aliases_normalized_name_ck",
      sql`length(${table.normalizedName}) > 0 AND ${table.normalizedName} = lower(regexp_replace(normalize(${table.name}, NFKC), '^[[:space:]]+|[[:space:]]+$', '', 'g'))`
    )
  ]
);

export const tagCatalogState = pgTable(
  "tag_catalog_state",
  {
    singleton: boolean("singleton").primaryKey().default(true),
    version: integer("version").notNull().default(1),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow()
  },
  (table) => [
    check("tag_catalog_state_singleton_ck", sql`${table.singleton} = true`),
    check("tag_catalog_state_version_ck", sql`${table.version} > 0`)
  ]
);

export const tagDeactivationPreviews = pgTable(
  "tag_deactivation_previews",
  {
    id: uuid("id").primaryKey(),
    actorUserId: bigint("actor_user_id", { mode: "bigint" })
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    targetTagId: varchar("target_tag_id", { length: 120 })
      .notNull()
      .references(() => tags.id, { onDelete: "restrict" }),
    replacementTagId: varchar("replacement_tag_id", { length: 120 }).references(
      () => tags.id,
      { onDelete: "restrict" }
    ),
    catalogVersion: integer("catalog_version").notNull(),
    currentProblemCount: integer("current_problem_count").notNull(),
    soleCurrentTagCount: integer("sole_current_tag_count").notNull(),
    historicalRevisionCount: integer("historical_revision_count").notNull(),
    reviewOpinionCount: integer("review_opinion_count").notNull(),
    childTagCount: integer("child_tag_count").notNull(),
    impactDigest: char("impact_digest", { length: 64 }).notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    usedAt: timestamp("used_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow()
  },
  (table) => [
    index("tag_deactivation_previews_expiry_idx").on(table.expiresAt, table.usedAt),
    check("tag_deactivation_previews_version_ck", sql`${table.catalogVersion} > 0`),
    check(
      "tag_deactivation_previews_counts_ck",
      sql`${table.currentProblemCount} >= 0 AND ${table.soleCurrentTagCount} BETWEEN 0 AND ${table.currentProblemCount} AND ${table.historicalRevisionCount} >= 0 AND ${table.reviewOpinionCount} >= 0 AND ${table.childTagCount} >= 0`
    ),
    check("tag_deactivation_previews_digest_ck", sql`${table.impactDigest} ~ '^[0-9a-f]{64}$'`),
    check("tag_deactivation_previews_expiry_ck", sql`${table.expiresAt} > ${table.createdAt}`),
    check(
      "tag_deactivation_previews_used_ck",
      sql`${table.usedAt} IS NULL OR ${table.usedAt} BETWEEN ${table.createdAt} AND ${table.expiresAt}`
    ),
    check(
      "tag_deactivation_previews_replacement_ck",
      sql`${table.replacementTagId} IS NULL OR ${table.replacementTagId} <> ${table.targetTagId}`
    )
  ]
);

export const problemRevisionTags = pgTable(
  "problem_revision_tags",
  {
    revisionId: uuid("revision_id")
      .notNull()
      .references(() => problemRevisions.id, { onDelete: "cascade" }),
    tagId: varchar("tag_id", { length: 120 })
      .notNull()
      .references(() => tags.id, { onDelete: "restrict" })
  },
  (table) => [
    primaryKey({ columns: [table.revisionId, table.tagId], name: "problem_revision_tags_pk" }),
    index("problem_revision_tags_tag_idx").on(table.tagId, table.revisionId)
  ]
);

export const problemSamples = pgTable(
  "problem_samples",
  {
    id: uuid("id").notNull(),
    revisionId: uuid("revision_id")
      .notNull()
      .references(() => problemRevisions.id, { onDelete: "cascade" }),
    position: smallint("position").notNull(),
    input: text("input").notNull(),
    output: text("output").notNull(),
    explanation: text("explanation").notNull().default("")
  },
  (table) => [
    primaryKey({ columns: [table.revisionId, table.id], name: "problem_samples_pk" }),
    uniqueIndex("problem_samples_revision_position_uq").on(table.revisionId, table.position),
    check("problem_samples_position_ck", sql`${table.position} >= 0`)
  ]
);

export const storedFiles = pgTable(
  "stored_files",
  {
    id: uuid("id").primaryKey(),
    purpose: filePurpose("purpose").notNull(),
    storageKey: varchar("storage_key", { length: 1024 }).notNull(),
    originalName: varchar("original_name", { length: 500 }).notNull(),
    mediaType: varchar("media_type", { length: 255 }).notNull(),
    byteSize: bigint("byte_size", { mode: "bigint" }).notNull(),
    sha256: char("sha256", { length: 64 }).notNull(),
    createdByUserId: bigint("created_by_user_id", { mode: "bigint" })
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow()
  },
  (table) => [
    uniqueIndex("stored_files_storage_key_uq").on(table.storageKey),
    index("stored_files_expiry_idx").on(table.expiresAt),
    index("stored_files_digest_idx").on(table.sha256, table.byteSize),
    check("stored_files_size_ck", sql`${table.byteSize} >= 0`),
    check("stored_files_sha256_ck", sql`${table.sha256} ~ '^[0-9a-f]{64}$'`)
  ]
);

export const problemRevisionFiles = pgTable(
  "problem_revision_files",
  {
    revisionId: uuid("revision_id")
      .notNull()
      .references(() => problemRevisions.id, { onDelete: "cascade" }),
    fileId: uuid("file_id")
      .notNull()
      .references(() => storedFiles.id, { onDelete: "restrict" }),
    category: problemFileCategory("category").notNull(),
    logicalPath: varchar("logical_path", { length: 1024 }).notNull(),
    position: integer("position").notNull().default(0)
  },
  (table) => [
    primaryKey({ columns: [table.revisionId, table.fileId], name: "problem_revision_files_pk" }),
    uniqueIndex("problem_revision_files_path_uq").on(table.revisionId, table.logicalPath),
    index("problem_revision_files_file_idx").on(table.fileId),
    check("problem_revision_files_position_ck", sql`${table.position} >= 0`),
    check(
      "problem_revision_files_path_ck",
      sql`${table.logicalPath} !~ '(^/|\\\\|(^|/)\\.\\.(/|$))'`
    )
  ]
);

export const reviewRounds = pgTable(
  "review_rounds",
  {
    id: uuid("id").primaryKey(),
    problemId: bigint("problem_id", { mode: "bigint" })
      .notNull()
      .references(() => problems.id, { onDelete: "cascade" }),
    round: integer("round").notNull(),
    submittedRevisionId: uuid("submitted_revision_id")
      .notNull()
      .references(() => problemRevisions.id, { onDelete: "restrict" }),
    status: reviewRoundStatus("status").notNull().default("open"),
    ruleId: varchar("rule_id", { length: 160 }).notNull(),
    ruleVersion: varchar("rule_version", { length: 80 }).notNull(),
    ruleSettings: jsonb("rule_settings").$type<JsonObject>().notNull().default(emptyObject),
    submittedByUserId: bigint("submitted_by_user_id", { mode: "bigint" })
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    decidedByUserId: bigint("decided_by_user_id", { mode: "bigint" }).references(
      () => users.id,
      { onDelete: "restrict" }
    ),
    decisionReason: varchar("decision_reason", { length: 2000 }),
    countedOpinionIds: jsonb("counted_opinion_ids").$type<string[]>().notNull().default(emptyArray),
    usedOpinionIds: jsonb("used_opinion_ids").$type<string[]>().notNull().default(emptyArray),
    usedReviewItemIds: jsonb("used_review_item_ids").$type<string[]>().notNull().default(emptyArray),
    decisionSource: varchar("decision_source", { length: 20 }),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow()
  },
  (table) => [
    uniqueIndex("review_rounds_problem_round_uq").on(table.problemId, table.round),
    uniqueIndex("review_rounds_id_submitted_revision_uq").on(
      table.id,
      table.submittedRevisionId
    ),
    uniqueIndex("review_rounds_one_open_uq")
      .on(table.problemId)
      .where(sql`${table.status} = 'open'`),
    index("review_rounds_status_created_idx").on(table.status, table.createdAt),
    foreignKey({
      columns: [table.problemId, table.submittedRevisionId],
      foreignColumns: [problemRevisions.problemId, problemRevisions.id],
      name: "review_rounds_problem_revision_fk"
    }).onDelete("restrict"),
    check("review_rounds_round_ck", sql`${table.round} > 0`),
    check(
      "review_rounds_decision_ck",
      sql`(${table.status} = 'open' AND ${table.decidedAt} IS NULL AND ${table.decidedByUserId} IS NULL) OR (${table.status} <> 'open' AND ${table.decidedAt} IS NOT NULL)`
    ),
    check(
      "review_rounds_counted_opinions_ck",
      sql`jsonb_typeof(${table.countedOpinionIds}) = 'array'`
    ),
    check("review_rounds_used_opinions_ck", sql`jsonb_typeof(${table.usedOpinionIds}) = 'array'`),
    check("review_rounds_used_items_ck", sql`jsonb_typeof(${table.usedReviewItemIds}) = 'array'`),
    check(
      "review_rounds_decision_source_ck",
      sql`(${table.status} = 'open' AND ${table.decisionSource} IS NULL) OR (${table.status} <> 'open' AND ${table.decisionSource} IN ('rule', 'manual', 'withdrawal'))`
    )
  ]
);

export const reviewPolicy = pgTable(
  "review_policy",
  {
    singleton: boolean("singleton").primaryKey().default(true),
    ruleId: varchar("rule_id", { length: 160 }).notNull(),
    ruleVersion: varchar("rule_version", { length: 80 }).notNull(),
    ruleSettings: jsonb("rule_settings").$type<JsonObject>().notNull().default(emptyObject),
    revision: integer("revision").notNull().default(1),
    updatedByUserId: bigint("updated_by_user_id", { mode: "bigint" }).references(
      () => users.id,
      { onDelete: "restrict" }
    ),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow()
  },
  (table) => [
    check("review_policy_singleton_ck", sql`${table.singleton} = true`),
    check("review_policy_revision_ck", sql`${table.revision} > 0`),
    check("review_policy_settings_ck", sql`jsonb_typeof(${table.ruleSettings}) = 'object'`)
  ]
);

export const reviewOpinions = pgTable(
  "review_opinions",
  {
    id: uuid("id").primaryKey(),
    roundId: uuid("round_id")
      .notNull()
      .references(() => reviewRounds.id, { onDelete: "cascade" }),
    reviewerUserId: bigint("reviewer_user_id", { mode: "bigint" })
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    source: reviewSource("source").notNull(),
    verdict: reviewVerdict("verdict").notNull(),
    codeforcesDifficulty: smallint("codeforces_difficulty").notNull(),
    qualityLevel: smallint("quality_level").notNull(),
    originalityLevel: smallint("originality_level"),
    thinkingLevel: smallint("thinking_level").notNull(),
    codingLevel: smallint("coding_level").notNull(),
    improvements: text("improvements").notNull(),
    publicComment: text("public_comment").notNull().default(""),
    privateNote: text("private_note").notNull().default(""),
    isActive: boolean("is_active").notNull().default(true),
    invalidatedAt: timestamp("invalidated_at", { withTimezone: true }),
    invalidationReason: varchar("invalidation_reason", { length: 500 }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow()
  },
  (table) => [
    uniqueIndex("review_opinions_active_reviewer_uq")
      .on(table.roundId, table.reviewerUserId)
      .where(sql`${table.isActive} = true`),
    index("review_opinions_round_verdict_idx").on(table.roundId, table.verdict),
    check(
      "review_opinions_cf_difficulty_ck",
      sql`${table.codeforcesDifficulty} BETWEEN 800 AND 3500 AND ${table.codeforcesDifficulty} % 100 = 0`
    ),
    check("review_opinions_quality_level_ck", sql`${table.qualityLevel} BETWEEN 1 AND 5`),
    check(
      "review_opinions_originality_level_ck",
      sql`${table.originalityLevel} IS NULL OR ${table.originalityLevel} BETWEEN 1 AND 5`
    ),
    check("review_opinions_thinking_level_ck", sql`${table.thinkingLevel} BETWEEN 1 AND 5`),
    check("review_opinions_coding_level_ck", sql`${table.codingLevel} BETWEEN 1 AND 5`),
    check("review_opinions_improvements_ck", sql`length(btrim(${table.improvements})) > 0`),
    check(
      "review_opinions_invalidation_ck",
      sql`(${table.isActive} = true AND ${table.invalidatedAt} IS NULL AND ${table.invalidationReason} IS NULL) OR (${table.isActive} = false AND ${table.invalidatedAt} IS NOT NULL AND ${table.invalidationReason} IS NOT NULL)`
    )
  ]
);

export const reviewAssignments = pgTable(
  "review_assignments",
  {
    id: uuid("id").primaryKey(),
    roundId: uuid("round_id")
      .notNull()
      .references(() => reviewRounds.id, { onDelete: "cascade" }),
    reviewerUserId: bigint("reviewer_user_id", { mode: "bigint" })
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    assignedByUserId: bigint("assigned_by_user_id", { mode: "bigint" })
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    reason: varchar("reason", { length: 500 }).notNull().default(""),
    assignmentKind: reviewAssignmentKind("assignment_kind").notNull(),
    claimedProblemRevision: integer("claimed_problem_revision"),
    claimedSubmittedRevisionId: uuid("claimed_submitted_revision_id"),
    claimedTagCatalogVersion: integer("claimed_tag_catalog_version"),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    revokedByUserId: bigint("revoked_by_user_id", { mode: "bigint" }).references(
      () => users.id,
      { onDelete: "restrict" }
    ),
    closedAt: timestamp("closed_at", { withTimezone: true }),
    closureReason: reviewAssignmentClosureReason("closure_reason"),
    closedByUserId: bigint("closed_by_user_id", { mode: "bigint" }).references(
      () => users.id,
      { onDelete: "restrict" }
    ),
    lastRenewalRequestId: uuid("last_renewal_request_id"),
    lastRenewalPayloadDigest: char("last_renewal_payload_digest", { length: 64 }),
    lastRenewalResult: jsonb("last_renewal_result").$type<JsonObject>(),
    lastRenewalAuditId: bigint("last_renewal_audit_id", { mode: "bigint" }).references(
      () => auditEvents.id,
      { onDelete: "restrict" }
    ),
    completionRequestId: uuid("completion_request_id"),
    completionPayloadDigest: char("completion_payload_digest", { length: 64 }),
    completionResult: jsonb("completion_result").$type<JsonObject>(),
    completionAuditId: bigint("completion_audit_id", { mode: "bigint" }).references(
      () => auditEvents.id,
      { onDelete: "restrict" }
    ),
    completionOpinionId: uuid("completion_opinion_id").references(() => reviewOpinions.id, {
      onDelete: "restrict"
    }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow()
  },
  (table) => [
    uniqueIndex("review_assignments_active_reviewer_uq")
      .on(table.roundId, table.reviewerUserId)
      .where(sql`${table.revokedAt} IS NULL`),
    uniqueIndex("review_assignments_completion_request_uq")
      .on(table.id, table.completionRequestId)
      .where(sql`${table.completionRequestId} IS NOT NULL`),
    index("review_assignments_reviewer_idx").on(table.reviewerUserId, table.expiresAt),
    check(
      "review_assignments_revoke_ck",
      sql`(${table.revokedAt} IS NULL AND ${table.revokedByUserId} IS NULL) OR (${table.revokedAt} IS NOT NULL AND ${table.revokedByUserId} IS NOT NULL)`
    ),
    check(
      "review_assignments_expiry_ck",
      sql`${table.expiresAt} IS NULL OR ${table.expiresAt} > ${table.createdAt}`
    ),
    check(
      "review_assignments_claimed_revision_ck",
      sql`(
        ${table.assignmentKind} = 'human'
        AND ${table.claimedProblemRevision} IS NULL
        AND ${table.claimedSubmittedRevisionId} IS NULL
        AND ${table.claimedTagCatalogVersion} IS NULL
      ) OR (
        ${table.assignmentKind} = 'robot'
        AND ${table.claimedProblemRevision} IS NOT NULL
        AND ${table.claimedProblemRevision} > 0
        AND ${table.claimedSubmittedRevisionId} IS NOT NULL
        AND (
          ${table.claimedTagCatalogVersion} > 0
          OR (
            ${table.claimedTagCatalogVersion} IS NULL
            AND ${table.closureReason} IS NOT NULL
          )
        )
        AND ${table.expiresAt} IS NOT NULL
      )`
    ),
    check(
      "review_assignments_lifecycle_ck",
      sql`(
        ${table.closureReason} IS NULL
        AND ${table.closedAt} IS NULL
        AND ${table.closedByUserId} IS NULL
        AND ${table.revokedAt} IS NULL
        AND ${table.revokedByUserId} IS NULL
      ) OR (
        ${table.closureReason} IS NOT NULL
        AND ${table.closedAt} IS NOT NULL
        AND ${table.closedByUserId} IS NOT NULL
        AND ${table.revokedAt} = ${table.closedAt}
        AND ${table.revokedByUserId} = ${table.closedByUserId}
      )`
    ),
    check(
      "review_assignments_last_renewal_ck",
      sql`num_nonnulls(
        ${table.lastRenewalRequestId},
        ${table.lastRenewalPayloadDigest},
        ${table.lastRenewalResult},
        ${table.lastRenewalAuditId}
      ) IN (0, 4)
      AND (
        ${table.lastRenewalPayloadDigest} IS NULL
        OR ${table.lastRenewalPayloadDigest} ~ '^[0-9a-f]{64}$'
      )
      AND (
        ${table.lastRenewalResult} IS NULL
        OR jsonb_typeof(${table.lastRenewalResult}) = 'object'
      )`
    ),
    check(
      "review_assignments_completion_ck",
      sql`(
        ${table.closureReason} = 'completed'
        AND num_nonnulls(
          ${table.completionRequestId},
          ${table.completionPayloadDigest},
          ${table.completionResult},
          ${table.completionAuditId},
          ${table.completionOpinionId}
        ) = 5
      ) OR (
        ${table.closureReason} IS DISTINCT FROM 'completed'
        AND num_nonnulls(
          ${table.completionRequestId},
          ${table.completionPayloadDigest},
          ${table.completionResult},
          ${table.completionAuditId},
          ${table.completionOpinionId}
        ) = 0
      )`
    ),
    check(
      "review_assignments_completion_digest_ck",
      sql`${table.completionPayloadDigest} IS NULL OR ${table.completionPayloadDigest} ~ '^[0-9a-f]{64}$'`
    ),
    check(
      "review_assignments_completion_result_ck",
      sql`${table.completionResult} IS NULL OR jsonb_typeof(${table.completionResult}) = 'object'`
    ),
    foreignKey({
      columns: [table.roundId, table.claimedSubmittedRevisionId],
      foreignColumns: [reviewRounds.id, reviewRounds.submittedRevisionId],
      name: "review_assignments_claimed_round_fk"
    }).onDelete("restrict")
  ]
);

export const reviewAssignmentOperations = pgTable(
  "review_assignment_operations",
  {
    assignmentId: uuid("assignment_id")
      .notNull()
      .references(() => reviewAssignments.id, { onDelete: "restrict" }),
    requestId: uuid("request_id").notNull(),
    operation: reviewAssignmentOperation("operation").notNull(),
    payloadDigest: char("payload_digest", { length: 64 }).notNull(),
    result: jsonb("result").$type<JsonObject>().notNull(),
    auditEventId: bigint("audit_event_id", { mode: "bigint" })
      .notNull()
      .references(() => auditEvents.id, { onDelete: "restrict" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow()
  },
  (table) => [
    primaryKey({
      columns: [table.assignmentId, table.requestId],
      name: "review_assignment_operations_pk"
    }),
    index("review_assignment_operations_audit_idx").on(table.auditEventId),
    check(
      "review_assignment_operations_digest_ck",
      sql`${table.payloadDigest} ~ '^[0-9a-f]{64}$'`
    ),
    check(
      "review_assignment_operations_result_ck",
      sql`jsonb_typeof(${table.result}) = 'object'`
    )
  ]
);

export const reviewOpinionTags = pgTable(
  "review_opinion_tags",
  {
    opinionId: uuid("opinion_id")
      .notNull()
      .references(() => reviewOpinions.id, { onDelete: "cascade" }),
    tagId: varchar("tag_id", { length: 120 })
      .notNull()
      .references(() => tags.id, { onDelete: "restrict" })
  },
  (table) => [
    primaryKey({ columns: [table.opinionId, table.tagId], name: "review_opinion_tags_pk" }),
    index("review_opinion_tags_tag_idx").on(table.tagId)
  ]
);

export const reviewItems = pgTable(
  "review_items",
  {
    id: uuid("id").primaryKey(),
    roundId: uuid("round_id")
      .notNull()
      .references(() => reviewRounds.id, { onDelete: "cascade" }),
    type: varchar("type", { length: 160 }).notNull(),
    source: reviewSource("source").notNull(),
    sourceUserId: bigint("source_user_id", { mode: "bigint" }).references(() => users.id, {
      onDelete: "restrict"
    }),
    sourcePluginId: varchar("source_plugin_id", { length: 160 }).references(
      () => installedPlugins.id,
      { onDelete: "set null" }
    ),
    visibility: reviewItemVisibility("visibility").notNull(),
    summary: varchar("summary", { length: 500 }).notNull(),
    data: jsonb("data").$type<JsonValue>().notNull(),
    contentHash: char("content_hash", { length: 64 }).notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow()
  },
  (table) => [
    index("review_items_round_type_idx").on(table.roundId, table.type),
    index("review_items_content_hash_idx").on(table.contentHash),
    check("review_items_summary_ck", sql`length(btrim(${table.summary})) > 0`),
    check("review_items_content_hash_ck", sql`${table.contentHash} ~ '^[0-9a-f]{64}$'`),
    check(
      "review_items_source_ck",
      sql`num_nonnulls(${table.sourceUserId}, ${table.sourcePluginId}) >= 1`
    )
  ]
);

export const problemAccessAggregates = pgTable(
  "problem_access_aggregates",
  {
    problemId: bigint("problem_id", { mode: "bigint" })
      .notNull()
      .references(() => problems.id, { onDelete: "cascade" }),
    userId: bigint("user_id", { mode: "bigint" })
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    firstAccessedAt: timestamp("first_accessed_at", { withTimezone: true }).notNull(),
    lastAccessedAt: timestamp("last_accessed_at", { withTimezone: true }).notNull(),
    totalActiveSeconds: bigint("total_active_seconds", { mode: "bigint" })
      .notNull()
      .default(0n),
    lastRevisionId: uuid("last_revision_id")
      .notNull()
      .references(() => problemRevisions.id, { onDelete: "restrict" }),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow()
  },
  (table) => [
    primaryKey({ columns: [table.problemId, table.userId], name: "problem_access_aggregates_pk" }),
    index("problem_access_aggregates_user_idx").on(table.userId, table.lastAccessedAt),
    foreignKey({
      columns: [table.problemId, table.lastRevisionId],
      foreignColumns: [problemRevisions.problemId, problemRevisions.id],
      name: "problem_access_aggregates_problem_revision_fk"
    }).onDelete("restrict"),
    check(
      "problem_access_aggregates_time_ck",
      sql`${table.lastAccessedAt} >= ${table.firstAccessedAt}`
    ),
    check(
      "problem_access_aggregates_duration_ck",
      sql`${table.totalActiveSeconds} >= 0`
    )
  ]
);

export const contests = pgTable(
  "contests",
  {
    id: bigint("id", { mode: "bigint" })
      .primaryKey()
      .generatedByDefaultAsIdentity({ name: "contests_id_seq", startWith: 1 }),
    title: varchar("title", { length: 200 }).notNull(),
    description: text("description").notNull().default(""),
    state: contestState("state").notNull().default("draft"),
    startsAt: timestamp("starts_at", { withTimezone: true }),
    endsAt: timestamp("ends_at", { withTimezone: true }),
    createdByUserId: bigint("created_by_user_id", { mode: "bigint" })
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow()
  },
  (table) => [
    index("contests_creator_state_idx").on(table.createdByUserId, table.state),
    check("contests_title_ck", sql`length(btrim(${table.title})) > 0`),
    check(
      "contests_time_range_ck",
      sql`${table.endsAt} IS NULL OR ${table.startsAt} IS NULL OR ${table.endsAt} > ${table.startsAt}`
    )
  ]
);

export const contestMembers = pgTable(
  "contest_members",
  {
    contestId: bigint("contest_id", { mode: "bigint" })
      .notNull()
      .references(() => contests.id, { onDelete: "cascade" }),
    userId: bigint("user_id", { mode: "bigint" })
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    role: contestMemberRole("role").notNull().default("participant"),
    addedByUserId: bigint("added_by_user_id", { mode: "bigint" })
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow()
  },
  (table) => [
    primaryKey({ columns: [table.contestId, table.userId], name: "contest_members_pk" }),
    index("contest_members_user_idx").on(table.userId, table.contestId)
  ]
);

export const contestProblems = pgTable(
  "contest_problems",
  {
    contestId: bigint("contest_id", { mode: "bigint" })
      .notNull()
      .references(() => contests.id, { onDelete: "cascade" }),
    position: smallint("position").notNull(),
    problemId: bigint("problem_id", { mode: "bigint" })
      .notNull()
      .references(() => problems.id, { onDelete: "restrict" }),
    revisionId: uuid("revision_id")
      .notNull()
      .references(() => problemRevisions.id, { onDelete: "restrict" }),
    score: integer("score").notNull(),
    estimatedDifficulty: smallint("estimated_difficulty"),
    leakRisk: jsonb("leak_risk").$type<JsonObject>().notNull().default(emptyObject),
    addedByUserId: bigint("added_by_user_id", { mode: "bigint" })
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow()
  },
  (table) => [
    primaryKey({ columns: [table.contestId, table.position], name: "contest_problems_pk" }),
    uniqueIndex("contest_problems_problem_uq").on(table.contestId, table.problemId),
    index("contest_problems_revision_idx").on(table.revisionId),
    foreignKey({
      columns: [table.problemId, table.revisionId],
      foreignColumns: [problemRevisions.problemId, problemRevisions.id],
      name: "contest_problems_problem_revision_fk"
    }).onDelete("restrict"),
    check("contest_problems_position_ck", sql`${table.position} >= 0`),
    check("contest_problems_score_ck", sql`${table.score} > 0`),
    check(
      "contest_problems_difficulty_ck",
      sql`${table.estimatedDifficulty} IS NULL OR ${table.estimatedDifficulty} BETWEEN 1 AND 5`
    )
  ]
);

export const importJobs = pgTable(
  "import_jobs",
  {
    id: uuid("id").primaryKey(),
    requestedByUserId: bigint("requested_by_user_id", { mode: "bigint" })
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    clientRequestDigest: char("client_request_digest", { length: 64 }),
    sourceFileId: uuid("source_file_id")
      .notNull()
      .references(() => storedFiles.id, { onDelete: "restrict" }),
    detectedFormat: varchar("detected_format", { length: 160 }),
    selectedFormat: varchar("selected_format", { length: 160 }).notNull(),
    selectedFormatVersion: varchar("selected_format_version", { length: 80 }).notNull(),
    inputDigest: char("input_digest", { length: 64 }).notNull(),
    choices: jsonb("choices").$type<JsonObject>().notNull().default(emptyObject),
    state: taskState("state").notNull().default("queued"),
    progressPercent: smallint("progress_percent").notNull().default(0),
    report: jsonb("report").$type<JsonObject>().notNull().default(emptyObject),
    failureCode: varchar("failure_code", { length: 120 }),
    failureMessage: varchar("failure_message", { length: 1000 }),
    idempotencyKey: varchar("idempotency_key", { length: 160 }).notNull(),
    startedAt: timestamp("started_at", { withTimezone: true }),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    executionAttempt: integer("execution_attempt").notNull().default(0),
    leaseId: uuid("lease_id"),
    leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow()
  },
  (table) => [
    uniqueIndex("import_jobs_request_idempotency_uq").on(
      table.requestedByUserId,
      table.idempotencyKey
    ),
    index("import_jobs_state_created_idx").on(table.state, table.createdAt),
    index("import_jobs_lease_expiry_idx")
      .on(table.leaseExpiresAt)
      .where(sql`state = 'running' AND lease_expires_at IS NOT NULL`),
    check("import_jobs_digest_ck", sql`${table.inputDigest} ~ '^[0-9a-f]{64}$'`),
    check(
      "import_jobs_client_request_digest_ck",
      sql`${table.clientRequestDigest} IS NULL OR ${table.clientRequestDigest} ~ '^[0-9a-f]{64}$'`
    ),
    check(
      "import_jobs_selected_format_version_ck",
      sql`${table.selectedFormatVersion} ~ '^[0-9A-Za-z]+([._+-][0-9A-Za-z]+)*$'`
    ),
    check(
      "import_jobs_progress_ck",
      sql`${table.progressPercent} BETWEEN 0 AND 100`
    ),
    check(
      "import_jobs_execution_attempt_ck",
      sql`${table.executionAttempt} >= 0`
    )
  ]
);

export const importJobItems = pgTable(
  "import_job_items",
  {
    jobId: uuid("job_id")
      .notNull()
      .references(() => importJobs.id, { onDelete: "cascade" }),
    position: integer("position").notNull(),
    sourceLabel: varchar("source_label", { length: 200 }).notNull(),
    state: taskState("state").notNull().default("queued"),
    importedProblemId: bigint("imported_problem_id", { mode: "bigint" }).references(
      () => problems.id,
      { onDelete: "set null" }
    ),
    report: jsonb("report").$type<JsonObject>().notNull().default(emptyObject),
    failureCode: varchar("failure_code", { length: 120 }),
    failureMessage: varchar("failure_message", { length: 1000 }),
    finishedAt: timestamp("finished_at", { withTimezone: true })
  },
  (table) => [
    primaryKey({ columns: [table.jobId, table.position], name: "import_job_items_pk" }),
    check("import_job_items_position_ck", sql`${table.position} >= 0`)
  ]
);

export const exportJobs = pgTable(
  "export_jobs",
  {
    id: uuid("id").primaryKey(),
    requestedByUserId: bigint("requested_by_user_id", { mode: "bigint" })
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    clientRequestDigest: char("client_request_digest", { length: 64 }),
    targetFormat: varchar("target_format", { length: 160 }).notNull(),
    targetFormatVersion: varchar("target_format_version", { length: 80 }).notNull(),
    options: jsonb("options").$type<JsonObject>().notNull().default(emptyObject),
    lossReport: jsonb("loss_report").$type<JsonObject>().notNull().default(emptyObject),
    state: taskState("state").notNull().default("queued"),
    progressPercent: smallint("progress_percent").notNull().default(0),
    report: jsonb("report").$type<JsonObject>().notNull().default(emptyObject),
    resultFileId: uuid("result_file_id").references(() => storedFiles.id, {
      onDelete: "set null"
    }),
    failureCode: varchar("failure_code", { length: 120 }),
    failureMessage: varchar("failure_message", { length: 1000 }),
    idempotencyKey: varchar("idempotency_key", { length: 160 }).notNull(),
    resultExpiresAt: timestamp("result_expires_at", { withTimezone: true }),
    startedAt: timestamp("started_at", { withTimezone: true }),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow()
  },
  (table) => [
    uniqueIndex("export_jobs_request_idempotency_uq").on(
      table.requestedByUserId,
      table.idempotencyKey
    ),
    index("export_jobs_state_created_idx").on(table.state, table.createdAt),
    index("export_jobs_result_expiry_idx").on(table.resultExpiresAt),
    check(
      "export_jobs_client_request_digest_ck",
      sql`${table.clientRequestDigest} IS NULL OR ${table.clientRequestDigest} ~ '^[0-9a-f]{64}$'`
    ),
    check(
      "export_jobs_target_format_version_ck",
      sql`${table.targetFormatVersion} ~ '^[0-9A-Za-z]+([._+-][0-9A-Za-z]+)*$'`
    ),
    check(
      "export_jobs_progress_ck",
      sql`${table.progressPercent} BETWEEN 0 AND 100`
    ),
    check(
      "export_jobs_result_ck",
      sql`${table.state} <> 'succeeded' OR (${table.resultFileId} IS NOT NULL AND ${table.resultExpiresAt} IS NOT NULL)`
    )
  ]
);

export const exportJobProblems = pgTable(
  "export_job_problems",
  {
    jobId: uuid("job_id")
      .notNull()
      .references(() => exportJobs.id, { onDelete: "cascade" }),
    position: integer("position").notNull(),
    problemId: bigint("problem_id", { mode: "bigint" })
      .notNull()
      .references(() => problems.id, { onDelete: "restrict" }),
    revisionId: uuid("revision_id")
      .notNull()
      .references(() => problemRevisions.id, { onDelete: "restrict" }),
    includedFileCategories: jsonb("included_file_categories")
      .$type<string[]>()
      .notNull()
      .default(emptyArray)
  },
  (table) => [
    primaryKey({ columns: [table.jobId, table.position], name: "export_job_problems_pk" }),
    uniqueIndex("export_job_problems_problem_uq").on(table.jobId, table.problemId),
    index("export_job_problems_revision_idx").on(table.revisionId),
    foreignKey({
      columns: [table.problemId, table.revisionId],
      foreignColumns: [problemRevisions.problemId, problemRevisions.id],
      name: "export_job_problems_problem_revision_fk"
    }).onDelete("restrict"),
    check("export_job_problems_position_ck", sql`${table.position} >= 0`)
  ]
);

export const problemPackageJobOutbox = pgTable(
  "problem_package_job_outbox",
  {
    jobId: uuid("job_id").primaryKey(),
    jobKind: problemPackageJobKind("job_kind").notNull(),
    importJobId: uuid("import_job_id"),
    exportJobId: uuid("export_job_id"),
    deliveryGeneration: integer("delivery_generation").notNull().default(1),
    maxDeliveryGenerations: smallint("max_delivery_generations").notNull().default(3),
    queueJobId: uuid("queue_job_id").notNull(),
    queueJobIds: uuid("queue_job_ids").array().notNull(),
    queueIdempotencyScope: varchar("queue_idempotency_scope", { length: 200 }).notNull(),
    queueIdempotencyKey: varchar("queue_idempotency_key", { length: 200 }).notNull(),
    queueRequestDigest: char("queue_request_digest", { length: 64 }).notNull(),
    maxAttempts: smallint("max_attempts").notNull(),
    timeoutMs: integer("timeout_ms").notNull(),
    nextDispatchAt: timestamp("next_dispatch_at", { withTimezone: true }),
    dispatchAttempts: integer("dispatch_attempts").notNull().default(0),
    dispatchClaimId: uuid("dispatch_claim_id"),
    dispatchClaimedBy: varchar("dispatch_claimed_by", { length: 200 }),
    dispatchClaimedAt: timestamp("dispatch_claimed_at", { withTimezone: true }),
    dispatchClaimExpiresAt: timestamp("dispatch_claim_expires_at", {
      withTimezone: true
    }),
    dispatchClaimGeneration: integer("dispatch_claim_generation"),
    dispatchClaimQueueJobId: uuid("dispatch_claim_queue_job_id"),
    lastDispatchedAt: timestamp("last_dispatched_at", { withTimezone: true }),
    lastDispatchErrorCode: varchar("last_dispatch_error_code", { length: 120 }),
    executionFence: bigint("execution_fence", { mode: "bigint" }).notNull().default(0n),
    executionDeliveryGeneration: integer("execution_delivery_generation"),
    executionQueueJobId: uuid("execution_queue_job_id"),
    executionQueueLeaseId: uuid("execution_queue_lease_id"),
    executionWorkerId: varchar("execution_worker_id", { length: 200 }),
    executionQueueAttempt: smallint("execution_queue_attempt"),
    executionClaimedAt: timestamp("execution_claimed_at", { withTimezone: true }),
    executionLeaseExpiresAt: timestamp("execution_lease_expires_at", {
      withTimezone: true
    }),
    retiredAt: timestamp("retired_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow()
  },
  (table) => [
    check(
      "problem_package_job_outbox_parent_ck",
      sql`(${table.jobKind} = 'import' AND ${table.importJobId} = ${table.jobId} AND ${table.exportJobId} IS NULL AND ${table.queueIdempotencyScope} = 'problem-package-import') OR (${table.jobKind} = 'export' AND ${table.exportJobId} = ${table.jobId} AND ${table.importJobId} IS NULL AND ${table.queueIdempotencyScope} = 'problem-package-export')`
    ),
    check(
      "problem_package_job_outbox_queue_identity_ck",
      sql`${table.deliveryGeneration} BETWEEN 1 AND ${table.maxDeliveryGenerations} AND ${table.maxDeliveryGenerations} BETWEEN 1 AND 20 AND ${table.queueJobId} <> ${table.jobId} AND array_ndims(${table.queueJobIds}) = 1 AND array_lower(${table.queueJobIds}, 1) = 1 AND array_upper(${table.queueJobIds}, 1) = ${table.deliveryGeneration} AND ${table.queueJobIds}[${table.deliveryGeneration}] = ${table.queueJobId} AND array_position(${table.queueJobIds}, NULL) IS NULL AND ${table.queueIdempotencyKey} = ${table.queueJobId}::text AND ${table.queueRequestDigest} ~ '^[0-9a-f]{64}$' AND ${table.maxAttempts} BETWEEN 1 AND 20 AND ${table.timeoutMs} BETWEEN 100 AND 86400000`
    ),
    check(
      "problem_package_job_outbox_dispatch_ck",
      sql`${table.dispatchAttempts} >= 0 AND num_nonnulls(${table.dispatchClaimId}, ${table.dispatchClaimedBy}, ${table.dispatchClaimedAt}, ${table.dispatchClaimExpiresAt}, ${table.dispatchClaimGeneration}, ${table.dispatchClaimQueueJobId}) IN (0, 6) AND (${table.dispatchClaimId} IS NULL OR (${table.dispatchAttempts} > 0 AND ${table.dispatchClaimGeneration} = ${table.deliveryGeneration} AND ${table.dispatchClaimQueueJobId} = ${table.queueJobId} AND ${table.dispatchClaimExpiresAt} > ${table.dispatchClaimedAt} AND length(btrim(${table.dispatchClaimedBy})) > 0 AND ${table.dispatchClaimedBy} !~ '[[:cntrl:]]')) AND (${table.lastDispatchErrorCode} IS NULL OR ${table.lastDispatchErrorCode} ~ '^[a-z0-9]+(?:[._-][a-z0-9]+)*$')`
    ),
    check(
      "problem_package_job_outbox_execution_ck",
      sql`${table.executionFence} >= 0 AND (num_nonnulls(${table.executionDeliveryGeneration}, ${table.executionQueueJobId}, ${table.executionQueueLeaseId}, ${table.executionWorkerId}, ${table.executionQueueAttempt}, ${table.executionClaimedAt}, ${table.executionLeaseExpiresAt}) = 0 OR (${table.executionFence} > 0 AND ${table.lastDispatchedAt} IS NOT NULL AND ${table.nextDispatchAt} IS NULL AND num_nonnulls(${table.executionDeliveryGeneration}, ${table.executionQueueJobId}, ${table.executionQueueLeaseId}, ${table.executionWorkerId}, ${table.executionQueueAttempt}, ${table.executionClaimedAt}, ${table.executionLeaseExpiresAt}) = 7 AND ${table.executionDeliveryGeneration} = ${table.deliveryGeneration} AND ${table.executionQueueJobId} = ${table.queueJobId} AND ${table.executionQueueAttempt} BETWEEN 1 AND 20 AND ${table.executionQueueAttempt} <= ${table.maxAttempts} AND ${table.executionLeaseExpiresAt} > ${table.executionClaimedAt} AND length(btrim(${table.executionWorkerId})) > 0 AND ${table.executionWorkerId} !~ '[[:cntrl:]]'))`
    ),
    check(
      "problem_package_job_outbox_lifecycle_ck",
      sql`${table.retiredAt} IS NULL OR (${table.nextDispatchAt} IS NULL AND num_nonnulls(${table.dispatchClaimId}, ${table.dispatchClaimedBy}, ${table.dispatchClaimedAt}, ${table.dispatchClaimExpiresAt}, ${table.dispatchClaimGeneration}, ${table.dispatchClaimQueueJobId}) = 0 AND num_nonnulls(${table.executionDeliveryGeneration}, ${table.executionQueueJobId}, ${table.executionQueueLeaseId}, ${table.executionWorkerId}, ${table.executionQueueAttempt}, ${table.executionClaimedAt}, ${table.executionLeaseExpiresAt}) = 0)`
    ),
    check(
      "problem_package_job_outbox_timestamps_ck",
      sql`${table.updatedAt} >= ${table.createdAt} AND (${table.nextDispatchAt} IS NULL OR ${table.nextDispatchAt} >= ${table.createdAt}) AND (${table.lastDispatchedAt} IS NULL OR ${table.lastDispatchedAt} >= ${table.createdAt}) AND (${table.retiredAt} IS NULL OR ${table.retiredAt} >= ${table.createdAt})`
    ),
    uniqueIndex("problem_package_job_outbox_import_uq")
      .on(table.importJobId)
      .where(sql`${table.importJobId} IS NOT NULL`),
    uniqueIndex("problem_package_job_outbox_export_uq")
      .on(table.exportJobId)
      .where(sql`${table.exportJobId} IS NOT NULL`),
    uniqueIndex("problem_package_job_outbox_queue_job_uq").on(table.queueJobId),
    uniqueIndex("problem_package_job_outbox_queue_identity_uq").on(
      table.queueIdempotencyScope,
      table.queueIdempotencyKey
    ),
    index("problem_package_job_outbox_ready_idx")
      .on(
        table.nextDispatchAt,
        table.dispatchClaimExpiresAt,
        table.createdAt,
        table.jobId
      )
      .where(sql`${table.retiredAt} IS NULL AND ${table.nextDispatchAt} IS NOT NULL`),
    index("problem_package_job_outbox_execution_expiry_idx")
      .on(
        table.executionLeaseExpiresAt,
        table.executionDeliveryGeneration,
        table.executionQueueJobId,
        table.jobId
      )
      .where(
        sql`${table.retiredAt} IS NULL AND ${table.executionQueueLeaseId} IS NOT NULL`
      )
  ]
);

export const auditEvents = pgTable(
  "audit_events",
  {
    id: bigint("id", { mode: "bigint" })
      .primaryKey()
      .generatedAlwaysAsIdentity({ name: "audit_events_id_seq", startWith: 1 }),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull().defaultNow(),
    actorUserId: bigint("actor_user_id", { mode: "bigint" }).references(() => users.id, {
      onDelete: "restrict"
    }),
    subjectUserId: bigint("subject_user_id", { mode: "bigint" }).references(() => users.id, {
      onDelete: "restrict"
    }),
    requestId: uuid("request_id").notNull(),
    action: varchar("action", { length: 160 }).notNull(),
    objectType: varchar("object_type", { length: 80 }).notNull(),
    objectId: varchar("object_id", { length: 160 }),
    result: auditResult("result").notNull(),
    reasonCode: varchar("reason_code", { length: 160 }),
    metadata: jsonb("metadata").$type<JsonObject>().notNull().default(emptyObject)
  },
  (table) => [
    index("audit_events_occurred_idx").on(table.occurredAt),
    index("audit_events_actor_occurred_idx").on(table.actorUserId, table.occurredAt),
    index("audit_events_object_occurred_idx").on(
      table.objectType,
      table.objectId,
      table.occurredAt
    ),
    index("audit_events_request_idx").on(table.requestId),
    check("audit_events_action_ck", sql`length(btrim(${table.action})) > 0`),
    check("audit_events_object_type_ck", sql`length(btrim(${table.objectType})) > 0`)
  ]
);
