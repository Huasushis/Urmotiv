import type { DatabaseExecutor, DatabaseHandle } from "@urmotiv/database";
import { sql } from "drizzle-orm";
import {
  PluginRevisionConflictError,
  type PluginAuditEvent,
  type PluginSecretRecord,
  type PluginStore,
  type PluginUpdateAttemptAudit,
  type PluginUpdateSuccessAudit,
  type StoredPlugin
} from "./plugin-host";

type PluginState = "enabled" | "disabled" | "failed";

interface PluginRow extends Record<string, unknown> {
  id: string;
  display_name: string;
  version: string;
  api_version: string;
  source: string;
  manifest_digest: string;
  state: PluginState;
  failure_code: string | null;
  settings: Record<string, unknown> | string | null;
  settings_revision: number | string | null;
}

interface SecretRow extends Record<string, unknown> {
  plugin_id: string;
  name: string;
  encrypted_value: string;
  masked_suffix: string;
  value_length: number | string | null;
}

function databaseId(value: string): bigint {
  if (!/^(0|[1-9]\d*)$/.test(value)) throw new Error("插件操作用户编号无效。");
  return BigInt(value);
}

function jsonObject(value: Record<string, unknown> | string | null): Record<string, unknown> {
  if (value === null) return {};
  if (typeof value === "string") {
    const parsed: unknown = JSON.parse(value);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? parsed as Record<string, unknown> : {};
  }
  return value;
}

function toPlugin(row: PluginRow, secrets: readonly SecretRow[]): StoredPlugin {
  return {
    id: row.id,
    displayName: row.display_name,
    version: row.version,
    apiVersion: row.api_version,
    source: row.source,
    manifestDigest: row.manifest_digest,
    state: row.state,
    failureCode: row.failure_code,
    settings: jsonObject(row.settings),
    settingsRevision: Number(row.settings_revision ?? 1),
    secrets: secrets.map((secret) => ({
      name: secret.name,
      encryptedValue: secret.encrypted_value,
      maskedSuffix: secret.masked_suffix,
      valueLength: secret.value_length === null ? null : Number(secret.value_length)
    }))
  };
}

export class DatabasePluginStore implements PluginStore {
  public constructor(private readonly database: DatabaseHandle) {}

  public async list(): Promise<StoredPlugin[]> {
    const rows = await this.database.query<PluginRow>(sql`
      SELECT p.id, p.display_name, p.version, p.api_version, p.source, p.manifest_digest,
             p.state, p.failure_code, s.settings, s.revision AS settings_revision
      FROM installed_plugins p
      LEFT JOIN plugin_settings s ON s.plugin_id = p.id
      ORDER BY p.id
    `);
    const secrets = await this.database.query<SecretRow>(sql`
      SELECT plugin_id, name, encrypted_value, masked_suffix, value_length
      FROM plugin_secrets ORDER BY plugin_id, name
    `);
    return rows.map((row) => toPlugin(row, secrets.filter((secret) => secret.plugin_id === row.id)));
  }

  public async get(
    pluginId: string,
    executor: DatabaseExecutor = this.database
  ): Promise<StoredPlugin | undefined> {
    const rows = await executor.query<PluginRow>(sql`
      SELECT p.id, p.display_name, p.version, p.api_version, p.source, p.manifest_digest,
             p.state, p.failure_code, s.settings, s.revision AS settings_revision
      FROM installed_plugins p LEFT JOIN plugin_settings s ON s.plugin_id = p.id WHERE p.id = ${pluginId}
    `);
    const row = rows[0];
    if (row === undefined) return undefined;
    const secrets = await executor.query<SecretRow>(sql`
      SELECT plugin_id, name, encrypted_value, masked_suffix, value_length
      FROM plugin_secrets WHERE plugin_id = ${pluginId}
    `);
    return toPlugin(row, secrets);
  }

  public async hasStoredSecrets(): Promise<boolean> {
    const rows = await this.database.query<{ has_secrets: boolean }>(sql`
      SELECT EXISTS (SELECT 1 FROM plugin_secrets) AS has_secrets
    `);
    return rows[0]?.has_secrets === true;
  }

  public async upsertInstalled(plugin: Omit<StoredPlugin, "settings" | "settingsRevision" | "secrets">): Promise<void> {
    await this.database.execute(sql`
      INSERT INTO installed_plugins (
        id, display_name, version, api_version, source, manifest_digest, state, failure_code, installed_by_user_id
      ) VALUES (
        ${plugin.id}, ${plugin.displayName}, ${plugin.version}, ${plugin.apiVersion}, ${plugin.source},
        ${plugin.manifestDigest}, ${plugin.state}, NULL, 0
      ) ON CONFLICT (id) DO UPDATE SET
        display_name = EXCLUDED.display_name, version = EXCLUDED.version, api_version = EXCLUDED.api_version,
        source = EXCLUDED.source, manifest_digest = EXCLUDED.manifest_digest, updated_at = now()
    `);
  }

  public async updateAndAudit(
    pluginId: string,
    input: {
      expectedRevision: number;
      state?: PluginState;
      settings?: Record<string, unknown>;
      encryptedSecrets?: readonly PluginSecretRecord[];
      clearSecretNames?: readonly string[];
      actorUserId: string;
    },
    event: PluginUpdateSuccessAudit
  ): Promise<StoredPlugin | undefined> {
    return this.database.transaction(async (transaction) => {
      const changed = await this.updateInTransaction(transaction, pluginId, input);
      if (changed === undefined) return undefined;
      await this.writeAuditWithExecutor(transaction, event);
      return this.get(pluginId, transaction);
    });
  }

  public async appendAudit(event: PluginUpdateAttemptAudit): Promise<void> {
    await this.writeAuditWithExecutor(this.database, event);
  }

  private async updateInTransaction(
    transaction: DatabaseExecutor,
    pluginId: string,
    input: {
      expectedRevision: number;
      state?: PluginState;
      settings?: Record<string, unknown>;
      encryptedSecrets?: readonly PluginSecretRecord[];
      clearSecretNames?: readonly string[];
      actorUserId: string;
    }
  ): Promise<true | undefined> {
    const actorId = databaseId(input.actorUserId);
    const found = await transaction.query<{ id: string }>(sql`
      SELECT id FROM installed_plugins WHERE id = ${pluginId} FOR UPDATE
    `);
    if (found.length === 0) return undefined;
    const settingsRows = await transaction.query<{
      settings: Record<string, unknown> | string | null;
      revision: number | string;
    }>(sql`
      SELECT settings, revision FROM plugin_settings WHERE plugin_id = ${pluginId} FOR UPDATE
    `);
    const currentSettings = settingsRows[0];
    const currentRevision = Number(currentSettings?.revision ?? 1);
    if (currentRevision !== input.expectedRevision) {
      throw new PluginRevisionConflictError();
    }
    const nextSettings = input.settings ?? jsonObject(currentSettings?.settings ?? null);

    if (input.state !== undefined) {
      await transaction.execute(sql`
        UPDATE installed_plugins SET state = ${input.state}, failure_code = NULL, updated_at = now()
        WHERE id = ${pluginId}
      `);
    }
    await transaction.execute(sql`
      INSERT INTO plugin_settings (plugin_id, settings, revision, updated_by_user_id)
      VALUES (${pluginId}, ${JSON.stringify(nextSettings)}::jsonb, ${currentRevision + 1}, ${actorId})
      ON CONFLICT (plugin_id) DO UPDATE SET
        settings = EXCLUDED.settings, revision = EXCLUDED.revision,
        updated_by_user_id = EXCLUDED.updated_by_user_id, updated_at = now()
    `);
    for (const name of input.clearSecretNames ?? []) {
      await transaction.execute(sql`
        DELETE FROM plugin_secrets WHERE plugin_id = ${pluginId} AND name = ${name}
      `);
    }
    for (const secret of input.encryptedSecrets ?? []) {
      await transaction.execute(sql`
        INSERT INTO plugin_secrets (
          plugin_id, name, encrypted_value, key_version, masked_suffix, value_length,
          updated_by_user_id
        ) VALUES (
          ${pluginId}, ${secret.name}, ${secret.encryptedValue}, 1, ${secret.maskedSuffix},
          ${secret.valueLength}, ${actorId}
        )
        ON CONFLICT (plugin_id, name) DO UPDATE SET
          encrypted_value = EXCLUDED.encrypted_value, masked_suffix = EXCLUDED.masked_suffix,
          value_length = EXCLUDED.value_length,
          updated_by_user_id = EXCLUDED.updated_by_user_id, updated_at = now()
      `);
    }
    return true;
  }

  private async writeAuditWithExecutor(
    executor: DatabaseExecutor,
    event: PluginAuditEvent
  ): Promise<void> {
    await executor.execute(sql`
      INSERT INTO audit_events (
        actor_user_id, request_id, action, object_type, object_id, result, reason_code, metadata
      ) VALUES (
        ${databaseId(event.actorUserId)}, ${event.requestId}::uuid, ${event.action}, 'plugin',
        ${event.pluginId}, ${event.result}, ${event.reasonCode}, ${JSON.stringify(event.metadata)}::jsonb
      )
    `);
  }
}
