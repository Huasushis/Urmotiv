import { randomUUID } from "node:crypto";
import { getTableName, isTable, sql } from "drizzle-orm";
import type { DatabaseExecutor, DatabaseHandle } from "./client";
import * as databaseSchema from "./schema";
import { hasExactDefaultCoreSeed } from "./seed";

const migrationLockKeyOne = 1_431_453_001;
const migrationLockKeyTwo = 1_651_666_804;
const expectedMigrationCount = 17;

const seededPublicTables = new Set([
  "admin_bootstrap_state",
  "permission_definitions",
  "permission_grants",
  "review_policy",
  "role_memberships",
  "roles",
  "tag_catalog_state",
  "tags",
  "users"
]);

const formalPublicTableNames = Object.values(databaseSchema)
  .flatMap((value) => isTable(value) ? [getTableName(value)] : [])
  .sort(compareText);

const expectedSequenceStates = [
  { schema: "drizzle", name: "__drizzle_migrations_id_seq", last_value: "16", is_called: true },
  { schema: "public", name: "audit_events_id_seq", last_value: "1", is_called: false },
  { schema: "public", name: "contests_id_seq", last_value: "1", is_called: false },
  { schema: "public", name: "problems_id_seq", last_value: "1", is_called: false },
  { schema: "public", name: "users_id_seq", last_value: "1", is_called: false }
] as const;

export type AdminBootstrapStatus = "blocked" | "open" | "completed";

export interface AdminBootstrapStateRecord {
  readonly status: AdminBootstrapStatus;
  readonly openedAt: string | null;
  readonly completedAt: string | null;
}

export interface AdminBootstrapMigrationLease {
  readonly backendProcessId: number;
}

export type AdminBootstrapOpenResult =
  | "opened"
  | "baseline_mismatch"
  | "lock_lost"
  | "state_not_blocked";

export interface AdminBootstrapAdministratorInput {
  /** Already-normalized address. Plain passwords must never cross this boundary. */
  readonly normalizedEmail: string;
  readonly passwordHash: string;
}

export type AdminBootstrapCompletionResult =
  | "completed"
  | "not_open"
  | "baseline_mismatch"
  | "role_invalid";

export async function tryAcquireAdminBootstrapMigrationLease(
  handle: DatabaseHandle
): Promise<AdminBootstrapMigrationLease | undefined> {
  const rows = await handle.query<{
    backend_process_id: number;
    acquired: boolean;
  }>(sql`
    SELECT
      pg_backend_pid()::integer AS backend_process_id,
      pg_try_advisory_lock(
        ${migrationLockKeyOne}::integer,
        ${migrationLockKeyTwo}::integer
      ) AS acquired
  `);
  const row = rows[0];
  if (
    rows.length !== 1
    || row?.acquired !== true
    || !Number.isSafeInteger(row.backend_process_id)
    || row.backend_process_id <= 0
  ) {
    return undefined;
  }
  return { backendProcessId: row.backend_process_id };
}

export async function releaseAdminBootstrapMigrationLease(
  executor: DatabaseExecutor,
  lease: AdminBootstrapMigrationLease
): Promise<boolean> {
  const rows = await executor.query<{ released: boolean }>(sql`
    SELECT CASE
      WHEN pg_backend_pid()::integer = ${lease.backendProcessId}
        AND EXISTS (
          SELECT 1
          FROM pg_locks
          WHERE locktype = 'advisory'
            AND pid = pg_backend_pid()
            AND classid = ${migrationLockKeyOne}::oid
            AND objid = ${migrationLockKeyTwo}::oid
            AND objsubid = 2
            AND granted = true
        )
      THEN pg_advisory_unlock(
        ${migrationLockKeyOne}::integer,
        ${migrationLockKeyTwo}::integer
      )
      ELSE false
    END AS released
  `);
  return rows.length === 1 && rows[0]?.released === true;
}

/**
 * A fresh deployment may use only an otherwise untouched database. The public
 * namespace itself and PostgreSQL's built-in plpgsql extension are the only
 * non-system entries accepted before migrations run.
 */
export async function isDatabaseEmptyForAdminBootstrap(
  executor: DatabaseExecutor
): Promise<boolean> {
  const rows = await executor.query<{ is_empty: boolean }>(sql`
    WITH non_system_namespaces AS (
      SELECT oid, nspname
      FROM pg_namespace
      WHERE substring(nspname FROM 1 FOR 3) <> 'pg_'
        AND nspname <> 'information_schema'
    ), unexpected AS (
      SELECT 1 AS present
      FROM non_system_namespaces
      WHERE nspname <> 'public'
      UNION ALL
      SELECT 1
      FROM pg_class object
      JOIN pg_namespace namespace ON namespace.oid = object.relnamespace
      WHERE namespace.nspname = 'public'
      UNION ALL
      SELECT 1
      FROM pg_proc object
      JOIN pg_namespace namespace ON namespace.oid = object.pronamespace
      WHERE namespace.nspname = 'public'
      UNION ALL
      SELECT 1
      FROM pg_type object
      JOIN pg_namespace namespace ON namespace.oid = object.typnamespace
      WHERE namespace.nspname = 'public'
      UNION ALL
      SELECT 1
      FROM pg_collation object
      JOIN pg_namespace namespace ON namespace.oid = object.collnamespace
      WHERE namespace.nspname = 'public'
      UNION ALL
      SELECT 1
      FROM pg_conversion object
      JOIN pg_namespace namespace ON namespace.oid = object.connamespace
      WHERE namespace.nspname = 'public'
      UNION ALL
      SELECT 1
      FROM pg_operator object
      JOIN pg_namespace namespace ON namespace.oid = object.oprnamespace
      WHERE namespace.nspname = 'public'
      UNION ALL
      SELECT 1
      FROM pg_opclass object
      JOIN pg_namespace namespace ON namespace.oid = object.opcnamespace
      WHERE namespace.nspname = 'public'
      UNION ALL
      SELECT 1
      FROM pg_opfamily object
      JOIN pg_namespace namespace ON namespace.oid = object.opfnamespace
      WHERE namespace.nspname = 'public'
      UNION ALL
      SELECT 1
      FROM pg_ts_config object
      JOIN pg_namespace namespace ON namespace.oid = object.cfgnamespace
      WHERE namespace.nspname = 'public'
      UNION ALL
      SELECT 1
      FROM pg_ts_dict object
      JOIN pg_namespace namespace ON namespace.oid = object.dictnamespace
      WHERE namespace.nspname = 'public'
      UNION ALL
      SELECT 1
      FROM pg_ts_parser object
      JOIN pg_namespace namespace ON namespace.oid = object.prsnamespace
      WHERE namespace.nspname = 'public'
      UNION ALL
      SELECT 1
      FROM pg_ts_template object
      JOIN pg_namespace namespace ON namespace.oid = object.tmplnamespace
      WHERE namespace.nspname = 'public'
      UNION ALL
      SELECT 1 FROM pg_extension WHERE extname <> 'plpgsql'
      UNION ALL
      SELECT 1 FROM pg_event_trigger
      UNION ALL
      SELECT 1 FROM pg_publication
      UNION ALL
      SELECT 1 FROM pg_subscription
      UNION ALL
      SELECT 1 FROM pg_foreign_data_wrapper
      UNION ALL
      SELECT 1 FROM pg_foreign_server
      UNION ALL
      SELECT 1 FROM pg_user_mapping
      UNION ALL
      SELECT 1 FROM pg_default_acl
      UNION ALL
      SELECT 1 FROM pg_largeobject_metadata
    )
    SELECT NOT EXISTS (SELECT 1 FROM unexpected) AS is_empty
  `);
  return rows.length === 1 && rows[0]?.is_empty === true;
}

export async function readAdminBootstrapState(
  executor: DatabaseExecutor
): Promise<AdminBootstrapStateRecord> {
  return parseStateRows(await executor.query<StateRow>(sql`
    SELECT status::text AS status, opened_at, completed_at
    FROM admin_bootstrap_state
    WHERE singleton = true
  `));
}

/**
 * Opens the one-time bootstrap only while the original migration session still
 * owns its lock and the database exactly matches the default seed. The advisory
 * lock is released before this transaction commits, so a lost connection cannot
 * leave a committed open state merely because cleanup did not run.
 */
export async function openAdminBootstrapForFreshSeed(
  handle: DatabaseHandle,
  lease: AdminBootstrapMigrationLease
): Promise<AdminBootstrapOpenResult> {
  return handle.transaction(async (transaction) => {
    if (!await transactionOwnsMigrationLease(transaction, lease)) {
      return "lock_lost";
    }

    await lockFreshSeedBaseline(transaction);

    const state = parseStateRows(await transaction.query<StateRow>(sql`
      SELECT status::text AS status, opened_at, completed_at
      FROM admin_bootstrap_state
      WHERE singleton = true
      FOR UPDATE
    `));
    if (state.status !== "blocked") {
      return "state_not_blocked";
    }
    if (!await hasExactFreshSeedBaseline(transaction, state, "blocked")) {
      return "baseline_mismatch";
    }

    const updated = await transaction.query<{ status: string }>(sql`
      UPDATE admin_bootstrap_state
      SET status = 'open', opened_at = transaction_timestamp(), updated_at = transaction_timestamp()
      WHERE singleton = true AND status = 'blocked'
      RETURNING status::text AS status
    `);
    if (updated.length !== 1 || updated[0]?.status !== "open") {
      throw new Error("URMOTIV_ADMIN_BOOTSTRAP_OPEN_FAILED");
    }
    if (!await releaseAdminBootstrapMigrationLease(transaction, lease)) {
      throw new Error("URMOTIV_ADMIN_BOOTSTRAP_LOCK_LOST");
    }
    return "opened";
  });
}

/**
 * Creates the first normal administrator without turning the seed-only root
 * account into a login identity. Callers must create the Argon2id digest before
 * entering this transaction so password hashing never holds database locks.
 */
export async function completeAdminBootstrap(
  handle: DatabaseHandle,
  input: AdminBootstrapAdministratorInput
): Promise<AdminBootstrapCompletionResult> {
  validateAdministratorInput(input);

  const emailId = randomUUID();
  const membershipId = randomUUID();
  const requestId = randomUUID();

  return handle.transaction(async (transaction) => {
    await transaction.execute(sql`
      SELECT pg_advisory_xact_lock(
        ${migrationLockKeyOne}::integer,
        ${migrationLockKeyTwo}::integer
      )
    `);
    await lockFreshSeedBaseline(transaction);

    const state = parseStateRows(await transaction.query<StateRow>(sql`
      SELECT status::text AS status, opened_at, completed_at
      FROM admin_bootstrap_state
      WHERE singleton = true
      FOR UPDATE
    `));
    if (state.status !== "open") {
      return "not_open";
    }
    if (!await hasExactFreshSeedBaseline(transaction, state, "open")) {
      return "baseline_mismatch";
    }

    const administratorRoles = await transaction.query<{
      id: string;
      is_built_in: boolean;
    }>(sql`
      SELECT id::text AS id, is_built_in
      FROM roles
      WHERE key = 'system_administrator'
    `);
    const administratorRole = administratorRoles[0];
    if (
      administratorRoles.length !== 1
      || administratorRole === undefined
      || administratorRole.is_built_in !== true
    ) {
      return "role_invalid";
    }

    const insertedUsers = await transaction.query<{ id: string }>(sql`
      INSERT INTO users (
        nickname,
        account_type,
        password_hash,
        password_changed_at
      ) VALUES (
        '系统管理员',
        'human',
        ${input.passwordHash},
        transaction_timestamp()
      )
      RETURNING id::text AS id
    `);
    const administrator = insertedUsers[0];
    if (insertedUsers.length !== 1 || administrator === undefined) {
      throw new Error("URMOTIV_ADMIN_BOOTSTRAP_WRITE_FAILED");
    }

    await transaction.execute(sql`
      INSERT INTO user_emails (
        id,
        user_id,
        address,
        normalized_address,
        is_primary,
        verified_at
      ) VALUES (
        ${emailId}::uuid,
        ${BigInt(administrator.id)},
        ${input.normalizedEmail},
        ${input.normalizedEmail},
        true,
        transaction_timestamp()
      )
    `);
    await transaction.execute(sql`
      INSERT INTO role_memberships (
        id,
        user_id,
        role_id,
        granted_by_user_id,
        reason
      ) VALUES (
        ${membershipId}::uuid,
        ${BigInt(administrator.id)},
        ${administratorRole.id}::uuid,
        0,
        '服务器控制台首次初始化'
      )
    `);
    await transaction.execute(sql`
      INSERT INTO audit_events (
        actor_user_id,
        subject_user_id,
        request_id,
        action,
        object_type,
        object_id,
        result,
        metadata
      ) VALUES (
        NULL,
        ${BigInt(administrator.id)},
        ${requestId}::uuid,
        'admin.bootstrap.complete',
        'user',
        ${administrator.id},
        'success',
        '{"channel":"server_tty","roleKey":"system_administrator"}'::jsonb
      )
    `);

    const completed = await transaction.query<{ status: string }>(sql`
      UPDATE admin_bootstrap_state
      SET
        status = 'completed',
        completed_at = transaction_timestamp(),
        updated_at = transaction_timestamp()
      WHERE singleton = true AND status = 'open'
      RETURNING status::text AS status
    `);
    if (completed.length !== 1 || completed[0]?.status !== "completed") {
      throw new Error("URMOTIV_ADMIN_BOOTSTRAP_WRITE_FAILED");
    }
    return "completed";
  });
}

interface StateRow extends Record<string, unknown> {
  readonly status: string;
  readonly opened_at: Date | string | null;
  readonly completed_at: Date | string | null;
}

async function lockFreshSeedBaseline(executor: DatabaseExecutor): Promise<void> {
  const relations = [
    sql`${sql.identifier("drizzle")}.${sql.identifier("__drizzle_migrations")}`,
    ...formalPublicTableNames.map(
      (name) => sql`${sql.identifier("public")}.${sql.identifier(name)}`
    )
  ];
  await executor.execute(sql`
    LOCK TABLE ${sql.join(relations, sql`, `)} IN ACCESS EXCLUSIVE MODE
  `);
}

async function transactionOwnsMigrationLease(
  executor: DatabaseExecutor,
  lease: AdminBootstrapMigrationLease
): Promise<boolean> {
  const rows = await executor.query<{ owned: boolean }>(sql`
    SELECT (
      pg_backend_pid()::integer = ${lease.backendProcessId}
      AND EXISTS (
        SELECT 1
        FROM pg_locks
        WHERE locktype = 'advisory'
          AND pid = pg_backend_pid()
          AND classid = ${migrationLockKeyOne}::oid
          AND objid = ${migrationLockKeyTwo}::oid
          AND objsubid = 2
          AND granted = true
      )
    ) AS owned
  `);
  return rows.length === 1 && rows[0]?.owned === true;
}

async function hasExactFreshSeedBaseline(
  executor: DatabaseExecutor,
  lockedState: AdminBootstrapStateRecord,
  expectedStatus: "blocked" | "open"
): Promise<boolean> {
  if (
    lockedState.status !== expectedStatus
    || (expectedStatus === "blocked"
      ? lockedState.openedAt !== null
      : lockedState.openedAt === null)
    || lockedState.completedAt !== null
  ) {
    return false;
  }

  const namespaces = await executor.query<{ name: string }>(sql`
    SELECT nspname AS name
    FROM pg_namespace
    WHERE substring(nspname FROM 1 FOR 3) <> 'pg_'
      AND nspname <> 'information_schema'
    ORDER BY nspname
  `);
  if (!sameRows(namespaces, [{ name: "drizzle" }, { name: "public" }])) {
    return false;
  }

  const publicRelations = await executor.query<{ name: string; kind: string }>(sql`
    SELECT object.relname AS name, object.relkind::text AS kind
    FROM pg_class object
    JOIN pg_namespace namespace ON namespace.oid = object.relnamespace
    WHERE namespace.nspname = 'public'
      AND object.relkind IN ('r', 'p', 'v', 'm', 'f')
    ORDER BY object.relname
  `);
  const expectedRelations = formalPublicTableNames.map((name) => ({ name, kind: "r" }));
  if (!sameRows(publicRelations, expectedRelations)) {
    return false;
  }

  const migrationRelations = await executor.query<{ name: string; kind: string }>(sql`
    SELECT object.relname AS name, object.relkind::text AS kind
    FROM pg_class object
    JOIN pg_namespace namespace ON namespace.oid = object.relnamespace
    WHERE namespace.nspname = 'drizzle'
      AND object.relkind IN ('r', 'p', 'v', 'm', 'f')
    ORDER BY object.relname
  `);
  if (!sameRows(migrationRelations, [{ name: "__drizzle_migrations", kind: "r" }])) {
    return false;
  }

  const sequenceNames = await executor.query<{ schema: string; name: string }>(sql`
    SELECT namespace.nspname AS schema, object.relname AS name
    FROM pg_class object
    JOIN pg_namespace namespace ON namespace.oid = object.relnamespace
    WHERE namespace.nspname IN ('drizzle', 'public')
      AND object.relkind = 'S'
    ORDER BY namespace.nspname, object.relname
  `);
  if (!sameRows(
    sequenceNames,
    expectedSequenceStates.map(({ schema, name }) => ({ schema, name }))
  )) {
    return false;
  }

  for (const expected of expectedSequenceStates) {
    const sequenceState = await executor.query<{ last_value: string; is_called: boolean }>(sql`
      SELECT last_value::text AS last_value, is_called
      FROM ${sql.identifier(expected.schema)}.${sql.identifier(expected.name)}
    `);
    if (
      expectedStatus === "blocked"
      || expected.schema === "drizzle"
    ) {
      if (!sameRows(sequenceState, [{
        last_value: expected.last_value,
        is_called: expected.is_called
      }])) {
        return false;
      }
      continue;
    }
    const value = sequenceState[0];
    if (
      sequenceState.length !== 1
      || value === undefined
      || !/^[1-9][0-9]*$/u.test(value.last_value)
      || typeof value.is_called !== "boolean"
    ) {
      return false;
    }
  }

  const migrationRows = await executor.query<{ count: number }>(sql`
    SELECT count(*)::integer AS count
    FROM drizzle.__drizzle_migrations
  `);
  if (migrationRows.length !== 1 || migrationRows[0]?.count !== expectedMigrationCount) {
    return false;
  }

  if (!await hasExactDefaultCoreSeed(executor)) {
    return false;
  }

  const tagCatalogRows = await executor.query<{
    version: number;
    category_count: number;
    tag_count: number;
    invalid_count: number;
    catalog_digest: string;
  }>(sql`
    SELECT
      state.version::integer AS version,
      count(*) FILTER (WHERE item.item_kind = 'category')::integer AS category_count,
      count(*) FILTER (WHERE item.item_kind = 'tag')::integer AS tag_count,
      count(*) FILTER (
        WHERE item.is_active <> true
          OR item.created_by_user_id IS NOT NULL
          OR item.id NOT LIKE 'catalog.%'
      )::integer AS invalid_count,
      md5(string_agg(
        item.id || chr(31)
          || COALESCE(item.parent_id, '') || chr(31)
          || item.name || chr(31)
          || item.normalized_name || chr(31)
          || item.item_kind::text || chr(31)
          || item.group_name || chr(31)
          || item.description || chr(31)
          || item.sort_order::text || chr(31)
          || item.is_active::text,
        chr(30) ORDER BY item.id
      )) AS catalog_digest
    FROM tag_catalog_state state
    CROSS JOIN tags item
    WHERE state.singleton = true
    GROUP BY state.version
  `);
  if (!sameRows(tagCatalogRows, [{
    version: 1,
    category_count: 22,
    tag_count: 243,
    invalid_count: 0,
    catalog_digest: "715372cf332347084df82c6c63937e79"
  }])) {
    return false;
  }

  const policyRows = await executor.query<{
    singleton: boolean;
    rule_id: string;
    rule_version: string;
    settings_match: boolean;
    revision: number;
    updated_by_is_null: boolean;
  }>(sql`
    SELECT
      singleton,
      rule_id,
      rule_version,
      rule_settings = '{"requiredApprovals":2,"maximumRejections":0,"countRobotReviews":false}'::jsonb AS settings_match,
      revision::integer AS revision,
      updated_by_user_id IS NULL AS updated_by_is_null
    FROM review_policy
  `);
  if (!sameRows(policyRows, [{
    singleton: true,
    rule_id: "org.ustc.urmotiv.review-default.count",
    rule_version: "1.0.0",
    settings_match: true,
    revision: 1,
    updated_by_is_null: true
  }])) {
    return false;
  }

  for (const tableName of formalPublicTableNames) {
    if (seededPublicTables.has(tableName)) {
      continue;
    }
    const rows = await executor.query<{ has_rows: boolean }>(sql`
      SELECT EXISTS (
        SELECT 1
        FROM ${sql.identifier("public")}.${sql.identifier(tableName)}
        LIMIT 1
      ) AS has_rows
    `);
    if (rows.length !== 1 || rows[0]?.has_rows !== false) {
      return false;
    }
  }
  return true;
}

function parseStateRows(rows: readonly StateRow[]): AdminBootstrapStateRecord {
  const row = rows[0];
  if (
    rows.length !== 1
    || row === undefined
    || !isAdminBootstrapStatus(row.status)
  ) {
    throw new Error("URMOTIV_ADMIN_BOOTSTRAP_STATE_INVALID");
  }
  const parsed = {
    status: row.status,
    openedAt: normalizeTimestamp(row.opened_at),
    completedAt: normalizeTimestamp(row.completed_at)
  };
  if (
    (parsed.status === "blocked"
      && (parsed.openedAt !== null || parsed.completedAt !== null))
    || (parsed.status === "open"
      && (parsed.openedAt === null || parsed.completedAt !== null))
    || (parsed.status === "completed"
      && (
        parsed.openedAt === null
        || parsed.completedAt === null
        || Date.parse(parsed.completedAt) < Date.parse(parsed.openedAt)
      ))
  ) {
    throw new Error("URMOTIV_ADMIN_BOOTSTRAP_STATE_INVALID");
  }
  return parsed;
}

function isAdminBootstrapStatus(value: string): value is AdminBootstrapStatus {
  return value === "blocked" || value === "open" || value === "completed";
}

function normalizeTimestamp(value: Date | string | null): string | null {
  if (value === null) {
    return null;
  }
  const parsed = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(parsed.getTime())) {
    throw new Error("URMOTIV_ADMIN_BOOTSTRAP_STATE_INVALID");
  }
  return parsed.toISOString();
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function sameRows(actual: unknown, expected: unknown): boolean {
  return JSON.stringify(actual) === JSON.stringify(expected);
}

function validateAdministratorInput(input: AdminBootstrapAdministratorInput): void {
  if (
    input.normalizedEmail.length === 0
    || input.normalizedEmail.length > 320
    || input.normalizedEmail !== input.normalizedEmail.trim().toLocaleLowerCase("en-US")
    || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(input.normalizedEmail)
    || input.passwordHash.length > 2_048
    || !/^\$argon2id\$v=\d+\$m=\d+,t=\d+,p=\d+\$[A-Za-z0-9+/_-]+={0,2}\$[A-Za-z0-9+/_-]+={0,2}$/u.test(
      input.passwordHash
    )
  ) {
    throw new Error("URMOTIV_ADMIN_BOOTSTRAP_INPUT_INVALID");
  }
}
