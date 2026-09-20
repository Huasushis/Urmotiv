import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import { chmod } from "node:fs/promises";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import {
  createPostgresDatabase,
  migrateDatabase,
  type PostgresDatabaseHandle,
} from "@urmotiv/database";
import { StorageError, type FileStorage } from "@urmotiv/storage";
import { sql } from "drizzle-orm";
import { createPluginSecretBox } from "../plugin-host";
import { BackupError } from "./webdav";
import {
  backupFileSchema,
  entryStream,
  hashStream,
  openBackupArchive,
  verifyBackupEntries,
  writeBackupArchive,
  type BackupFile,
} from "./archive";
import type { BackupEngine, PreparedRestore } from "./service";

function pgEnvironment(connectionString: string): NodeJS.ProcessEnv {
  const url = new URL(connectionString);
  return {
    ...process.env,
    PGHOST: url.hostname,
    PGPORT: url.port || "5432",
    PGDATABASE: decodeURIComponent(url.pathname.slice(1)),
    PGUSER: decodeURIComponent(url.username),
    PGPASSWORD: decodeURIComponent(url.password),
    PGSSLMODE: url.searchParams.get("sslmode") ?? "prefer",
    PGAPPNAME: "urmotiv-backup",
    PGOPTIONS: "-c statement_timeout=0",
  };
}
async function runPg(
  tool: "pg_dump" | "pg_restore",
  connectionString: string,
  args: string[],
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(tool, args, {
      env: pgEnvironment(connectionString),
      stdio: ["ignore", "ignore", "pipe"],
    });
    child.stderr.resume();
    child.once("error", () =>
      reject(
        new BackupError(
          "BACKUP_DATABASE_TOOLS_UNAVAILABLE",
          "服务器缺少 PostgreSQL 备份工具，请检查部署镜像。",
        ),
      ),
    );
    child.once("close", (code) =>
      code === 0
        ? resolve()
        : reject(
            new BackupError(
              tool === "pg_dump"
                ? "BACKUP_DATABASE_EXPORT_FAILED"
                : "BACKUP_DATABASE_IMPORT_FAILED",
              tool === "pg_dump"
                ? "数据库快照导出失败，未生成完整备份。"
                : "数据库恢复失败，在线数据库事务未提交。",
            ),
          ),
    );
  });
}
async function pendingJobs(database: PostgresDatabaseHandle): Promise<boolean> {
  const rows = await database.query<{ busy: boolean }>(
    sql`SELECT EXISTS(SELECT 1 FROM import_jobs WHERE state IN('queued','running') UNION ALL SELECT 1 FROM export_jobs WHERE state IN('queued','running')) AS busy`,
  );
  return rows[0]?.busy === true;
}
export class PostgresBackupEngine implements BackupEngine {
  constructor(
    private readonly options: {
      database: PostgresDatabaseHandle;
      connectionString: string;
      storage: FileStorage;
      storageKeyForId: (id: string) => string;
      secretKey: string;
      runCommand?: typeof runPg;
    },
  ) {}
  private run(
    tool: "pg_dump" | "pg_restore",
    connection: string,
    args: string[],
  ) {
    return (this.options.runCommand ?? runPg)(tool, connection, args);
  }
  async assertRestoreIdle(): Promise<void> {
    if (await pendingJobs(this.options.database))
      throw new BackupError(
        "BACKUP_TASKS_BUSY",
        "导入或导出任务仍在运行，请完成后再恢复站点。",
      );
    const active = await this.options.database.query<{ busy: boolean }>(
      sql`SELECT EXISTS(SELECT 1 FROM review_assignments WHERE assignment_kind='robot' AND closure_reason IS NULL AND expires_at>now()) AS busy`,
    );
    if (active[0]?.busy)
      throw new BackupError(
        "BACKUP_REVIEW_BUSY",
        "仍有外部审题任务在处理，请等待其完成后再恢复，避免中断模型请求。",
      );
  }
  async create(
    target: string,
    password: string,
    kind: "manual" | "scheduled" | "before-restore",
    progress: (phase: string) => void,
  ): Promise<void> {
    const database = this.options.database;
    if (await pendingJobs(database))
      throw new BackupError(
        "BACKUP_TASKS_BUSY",
        "请等待当前导入/导出完成后再备份。",
      );
    progress("正在生成一致的数据库快照");
    const client = await database.client.connect();
    let files: BackupFile[] = [];
    let schemaVersion = 0;
    let createdAt = "";
    const dump = target + ".database";
    try {
      await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
      const busy = (
        await client.query(
          "SELECT EXISTS(SELECT 1 FROM import_jobs WHERE state IN('queued','running') UNION ALL SELECT 1 FROM export_jobs WHERE state IN('queued','running')) AS busy",
        )
      ).rows[0]?.busy;
      if (busy)
        throw new BackupError(
          "BACKUP_TASKS_BUSY",
          "导入或导出刚刚开始，请等待其完成后重新备份。",
        );
      const snapshotRow = (
        await client.query<{ snapshot: string; snapshot_at: Date }>(
          "SELECT pg_export_snapshot() AS snapshot,transaction_timestamp() AS snapshot_at",
        )
      ).rows[0]!;
      const snapshot = snapshotRow.snapshot;
      createdAt = snapshotRow.snapshot_at.toISOString();
      schemaVersion = Number(
        (
          await client.query(
            "SELECT max(created_at)::text AS version FROM drizzle.__drizzle_migrations",
          )
        ).rows[0].version,
      );
      const result = await client.query(
        "SELECT id::text,original_name,media_type,byte_size::text,sha256,storage_key FROM stored_files WHERE deleted_at IS NULL AND (expires_at IS NULL OR expires_at>now()) ORDER BY id",
      );
      files = result.rows.map((row) =>
        backupFileSchema.parse({
          id: row.id,
          originalName: row.original_name,
          mediaType: row.media_type,
          byteSize: Number(row.byte_size),
          sha256: row.sha256,
          storageKey: row.storage_key,
        }),
      );
      await this.run("pg_dump", this.options.connectionString, [
        "--format=custom",
        "--compress=0",
        "--no-owner",
        "--no-privileges",
        "--snapshot",
        snapshot,
        "--file",
        dump,
      ]);
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
    await chmod(dump, 0o600);
    progress("正在打包并加密题目附件");
    await writeBackupArchive({
      target,
      password,
      manifest: {
        format: 1,
        createdAt,
        schemaVersion,
        secretKey: this.options.secretKey,
        fileCount: files.length,
        kind,
      },
      databaseFile: dump,
      files,
      openFile: (file) => this.options.storage.open(file),
      onFile: (done, total) => progress(`正在加密附件 ${done} / ${total}`),
    });
  }
  async prepareRestore(
    source: string,
    password: string,
    workDir: string,
    progress: (phase: string) => void,
  ): Promise<PreparedRestore> {
    progress("正在校验加密密码与完整性");
    const backup = await openBackupArchive(
      source,
      password,
      join(workDir, "restore.pack"),
    );
    await verifyBackupEntries(backup);
    const currentVersion = Number(
      (
        await this.options.database.query<{ version: string }>(
          sql`SELECT max(created_at)::text AS version FROM drizzle.__drizzle_migrations`,
        )
      )[0]?.version ?? 0,
    );
    if (backup.manifest.schemaVersion > currentVersion)
      throw new BackupError(
        "BACKUP_NEWER_VERSION",
        "备份来自更新的数据库版本，请先升级站点再恢复。",
      );
    const dump = join(workDir, "restore.database");
    await pipeline(
      entryStream(backup, backup.database),
      createWriteStream(dump, { flags: "wx", mode: 0o600 }),
    );
    const name = "urmotiv_restore_" + randomUUID().replaceAll("-", "");
    const url = new URL(this.options.connectionString);
    url.pathname = "/" + name;
    let staging: PostgresDatabaseHandle | undefined;
    let created = false;
    const dispose = async () => {
      await staging?.close();
      staging = undefined;
      if (created) {
        await this.options.database.client.query(`DROP DATABASE "${name}"`);
        created = false;
      }
    };
    try {
      progress("正在临时数据库中演练恢复");
      try {
        await this.options.database.client.query(
          `CREATE DATABASE "${name}" TEMPLATE template0`,
        );
        created = true;
      } catch {
        throw new BackupError(
          "BACKUP_STAGING_UNAVAILABLE",
          "数据库账号没有创建临时恢复库的权限，或数据库空间不足。在线数据未变。",
        );
      }
      await this.run("pg_restore", url.href, [
        "--single-transaction",
        "--no-owner",
        "--no-privileges",
        "--exit-on-error",
        "--dbname",
        name,
        dump,
      ]);
      staging = createPostgresDatabase({
        connectionString: url.href,
        maxConnections: 2,
        applicationName: "urmotiv-restore-staging",
      });
      await migrateDatabase(staging);
      if (await pendingJobs(staging))
        throw new BackupError(
          "BACKUP_PENDING_JOBS",
          "这份备份包含尚未完成的导入/导出，不可直接恢复。",
        );
      const root = await staging.query<{ usable: boolean }>(
        sql`SELECT (password_hash IS NOT NULL AND disabled_at IS NULL AND deleted_at IS NULL) AS usable FROM users WHERE id=0`,
      );
      if (root[0]?.usable !== true)
        throw new BackupError(
          "BACKUP_ROOT_UNAVAILABLE",
          "备份中没有可用的 root 本地账号，已停止恢复。",
        );
      const expected = await staging.query<{
        id: string;
        sha256: string;
        bytes: string;
      }>(
        sql`SELECT id::text,sha256,byte_size::text AS bytes FROM stored_files WHERE deleted_at IS NULL AND (expires_at IS NULL OR expires_at>${backup.manifest.createdAt}::timestamptz)`,
      );
      const supplied = new Map(
        backup.files.map((entry) => [entry.file!.id, entry]),
      );
      if (
        expected.length !== backup.files.length ||
        expected.some(
          (file) =>
            supplied.get(file.id)?.sha256 !== file.sha256 ||
            supplied.get(file.id)?.bytes !== Number(file.bytes),
        )
      )
        throw new BackupError(
          "BACKUP_FILES_INCOMPLETE",
          "备份附件与数据库记录不一致，在线数据未替换。",
        );
      const originalBox = createPluginSecretBox(backup.manifest.secretKey),
        currentBox = createPluginSecretBox(this.options.secretKey);
      if (!originalBox || !currentBox)
        throw new BackupError(
          "BACKUP_SECRET_KEY_INVALID",
          "备份缺少恢复站内加密设置所需的密钥。",
        );
      for (const table of [
        {
          name: "system_settings",
          keys: ["id"],
          columns: [
            "smtp_password_encrypted",
            "client_id_encrypted",
            "client_secret_encrypted",
          ],
        },
        {
          name: "system_oauth_settings",
          keys: ["id"],
          columns: ["client_id_encrypted", "client_secret_encrypted"],
        },
        {
          name: "plugin_secrets",
          keys: ["plugin_id", "name"],
          columns: ["encrypted_value"],
        },
      ]) {
        const rows = await staging.query(
          sql`SELECT * FROM ${sql.identifier(table.name)}`,
        );
        for (const row of rows)
          for (const column of table.columns)
            if (typeof row[column] === "string") {
              let encrypted: string;
              try {
                encrypted = currentBox.encrypt(
                  originalBox.decrypt(row[column] as string),
                );
              } catch {
                throw new BackupError(
                  "BACKUP_SECRET_KEY_INVALID",
                  "备份的站内设置无法解密，在线数据未替换。",
                );
              }
              const where = sql.join(
                table.keys.map(
                  (key) => sql`${sql.identifier(key)}=${row[key]}`,
                ),
                sql` AND `,
              );
              await staging.execute(
                sql`UPDATE ${sql.identifier(table.name)} SET ${sql.identifier(column)}=${encrypted} WHERE ${where}`,
              );
            }
      }
      let completed = 0;
      for (const entry of backup.files) {
        const file = entry.file!,
          targetKey = this.options.storageKeyForId(file.id);
        let existing: Awaited<ReturnType<typeof hashStream>> | undefined;
        try {
          existing = await hashStream(
            await this.options.storage.open({
              id: file.id,
              storageKey: targetKey,
            }),
          );
        } catch (error) {
          if (
            !(error instanceof StorageError) ||
            error.code !== "OBJECT_NOT_FOUND"
          )
            throw error;
        }
        if (
          existing &&
          (existing.bytes !== file.byteSize || existing.sha256 !== file.sha256)
        )
          throw new BackupError(
            "BACKUP_STORAGE_CONFLICT",
            "附件编号与在线内容冲突，已停止恢复，未覆盖在线附件。",
          );
        if (!existing) {
          const staged = await this.options.storage.stage({
            id: file.id,
            originalName: file.originalName,
            mediaType: file.mediaType,
            content: entryStream(backup, entry),
          });
          const published = await this.options.storage.publish(staged);
          if (published.storageKey !== targetKey)
            throw new BackupError(
              "BACKUP_STORAGE_CONFLICT",
              "恢复附件存储位置不符合当前部署配置。",
            );
        }
        await staging.execute(
          sql`UPDATE stored_files SET storage_key=${targetKey} WHERE id=${file.id}::uuid`,
        );
        progress(`正在核验恢复附件 ${++completed} / ${backup.files.length}`);
      }
      await staging.execute(sql`DELETE FROM sessions`);
      await staging.execute(sql`DELETE FROM login_states`);
      await staging.execute(sql`DELETE FROM account_action_tokens`);
      await staging.execute(sql`DELETE FROM email_verification_tokens`);
      await staging.execute(
        sql`UPDATE users SET auth_revision=auth_revision+1`,
      );
      await staging.execute(
        sql`UPDATE review_assignments SET closed_at=now(),closure_reason='abandoned',closed_by_user_id=0,revoked_at=now(),revoked_by_user_id=0 WHERE assignment_kind='robot' AND closure_reason IS NULL`,
      );
      await staging.execute(
        sql`INSERT INTO audit_events(actor_user_id,request_id,action,object_type,result,metadata) VALUES(0,${randomUUID()}::uuid,'system.backup.restore','system','success','{}'::jsonb)`,
      );
      const preparedDump = join(workDir, "prepared.database");
      await this.run("pg_dump", url.href, [
        "--format=custom",
        "--compress=0",
        "--no-owner",
        "--no-privileges",
        "--file",
        preparedDump,
      ]);
      await chmod(preparedDump, 0o600);
      return {
        apply: async () => {
          await this.run("pg_restore", this.options.connectionString, [
            "--clean",
            "--if-exists",
            "--single-transaction",
            "--no-owner",
            "--no-privileges",
            "--exit-on-error",
            "--dbname",
            decodeURIComponent(
              new URL(this.options.connectionString).pathname.slice(1),
            ),
            preparedDump,
          ]);
        },
        dispose,
      };
    } catch (error) {
      await dispose().catch(() => undefined);
      throw error;
    }
  }
}
