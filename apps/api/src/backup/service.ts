import { randomUUID } from "node:crypto";
import {
  mkdir,
  readFile,
  writeFile,
  rename,
  mkdtemp,
  rm,
} from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import {
  backupJobSchema,
  type BackupJob,
  type BackupSettingsInput,
  type BackupSettingsView,
} from "@urmotiv/contracts";
import type { PluginSecretBox } from "../plugin-host";
import { BackupError, WebDavClient, type WebDavCredentials } from "./webdav";
import { maximumBackupBytes } from "./archive";

export interface PreparedRestore {
  apply(): Promise<void>;
  dispose(): Promise<void>;
}
export interface BackupEngine {
  create(
    target: string,
    password: string,
    kind: "manual" | "scheduled" | "before-restore",
    progress: (phase: string) => void,
  ): Promise<void>;
  prepareRestore(
    source: string,
    password: string,
    workDir: string,
    progress: (phase: string) => void,
  ): Promise<PreparedRestore>;
}
const storedSchema = z
  .object({
    revision: z.number().int().positive(),
    enabled: z.boolean(),
    address: z.string(),
    username: z.string(),
    passwordEncrypted: z.string().nullable(),
    encryptionPasswordEncrypted: z.string().nullable(),
    intervalHours: z.number().int().nullable(),
    verifiedAt: z.string().datetime().nullable(),
    lastAttemptAt: z.string().datetime().nullable(),
    lastSuccessAt: z.string().datetime().nullable(),
    job: backupJobSchema.nullable(),
  })
  .strict();
type Stored = z.infer<typeof storedSchema>;
export interface BackupServiceOptions {
  directory: string;
  secretBox: PluginSecretBox;
  engine: BackupEngine;
  defaults?: WebDavCredentials;
  maintenance: { enter: () => Promise<void>; leave: () => void };
  client?: (credentials: WebDavCredentials) => WebDavClient;
}
export class BackupService {
  private settings!: Stored;
  private busy = false;
  private saving: Promise<void> = Promise.resolve();
  private timer: ReturnType<typeof setInterval> | undefined;
  private operation: Promise<void> | undefined;
  private constructor(private readonly options: BackupServiceOptions) {}
  static async open(options: BackupServiceOptions): Promise<BackupService> {
    const service = new BackupService(options);
    await mkdir(options.directory, { recursive: true, mode: 0o700 });
    try {
      service.settings = storedSchema.parse(
        JSON.parse(
          await readFile(join(options.directory, "settings.json"), "utf8"),
        ),
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT")
        throw new BackupError(
          "BACKUP_SETTINGS_INVALID",
          "备份设置文件无法读取，请检查私有设置目录。",
        );
      service.settings = {
        revision: 1,
        enabled: false,
        address: options.defaults?.address ?? "",
        username: options.defaults?.username ?? "",
        passwordEncrypted: options.defaults?.password
          ? options.secretBox.encrypt(options.defaults.password)
          : null,
        encryptionPasswordEncrypted: null,
        intervalHours: null,
        verifiedAt: null,
        lastAttemptAt: null,
        lastSuccessAt: null,
        job: null,
      };
    }
    if (service.settings.job?.status === "running") {
      service.settings.job = {
        ...service.settings.job,
        status: "failed",
        phase: "interrupted",
        finishedAt: new Date().toISOString(),
        errorCode: "BACKUP_INTERRUPTED",
        message:
          "服务在上次操作完成前重启。请检查记录后重新操作，未确认完成的备份不会用于恢复。",
      };
      await service.persist();
    }
    return service;
  }
  view(): BackupSettingsView {
    const {
      passwordEncrypted,
      encryptionPasswordEncrypted,
      ...publicSettings
    } = this.settings;
    return {
      ...structuredClone(publicSettings),
      available: true,
      passwordConfigured: !!passwordEncrypted,
      encryptionPasswordConfigured: !!encryptionPasswordEncrypted,
    };
  }
  private client(settings: Stored = this.settings): WebDavClient {
    if (!settings.address || !settings.passwordEncrypted)
      throw new BackupError(
        "BACKUP_NOT_CONFIGURED",
        "请先填写并验证 WebDAV 连接。",
      );
    const credentials = {
      address: settings.address,
      username: settings.username,
      password: this.options.secretBox.decrypt(settings.passwordEncrypted),
    };
    return this.options.client?.(credentials) ?? new WebDavClient(credentials);
  }
  private encryptionPassword(): string {
    if (!this.settings.encryptionPasswordEncrypted)
      throw new BackupError(
        "BACKUP_PASSWORD_REQUIRED",
        "请先设置独立的备份加密密码。",
      );
    return this.options.secretBox.decrypt(
      this.settings.encryptionPasswordEncrypted,
    );
  }
  async configure(input: BackupSettingsInput): Promise<BackupSettingsView> {
    if (this.busy)
      throw new BackupError(
        "BACKUP_BUSY",
        "备份或恢复正在运行，结束后再修改配置。",
      );
    if (input.expectedRevision !== this.settings.revision)
      throw new BackupError(
        "BACKUP_SETTINGS_CONFLICT",
        "备份设置已变化，请刷新后重试。",
      );
    this.busy = true;
    try {
      const next: Stored = {
        ...this.settings,
        revision: input.expectedRevision + 1,
        enabled: input.enabled,
        address: input.address,
        username: input.username,
        intervalHours: input.intervalHours,
        passwordEncrypted:
          input.password === undefined
            ? this.settings.passwordEncrypted
            : this.options.secretBox.encrypt(input.password),
        encryptionPasswordEncrypted:
          input.encryptionPassword === undefined
            ? this.settings.encryptionPasswordEncrypted
            : this.options.secretBox.encrypt(input.encryptionPassword),
      };
      if (next.enabled && !next.encryptionPasswordEncrypted)
        throw new BackupError(
          "BACKUP_PASSWORD_REQUIRED",
          "启用备份前请设置独立加密密码。",
        );
      await this.client(next).verify();
      next.verifiedAt = new Date().toISOString();
      // 先写磁盘再替换运行配置，失败时继续使用原配置。
      await this.persist(next);
      this.settings = next;
      return this.view();
    } finally {
      this.busy = false;
    }
  }
  async list() {
    return { items: await this.client().list() };
  }
  async startBackup(
    kind: "manual" | "scheduled" = "manual",
  ): Promise<BackupJob> {
    this.assertReady();
    const client = this.client(),
      password = this.encryptionPassword();
    await this.begin("backup");
    this.operation = this.execute(async (workDir) => {
      const name = this.name(kind),
        file = join(workDir, "backup.urb");
      await this.options.engine.create(file, password, kind, (phase) =>
        this.progress(phase),
      );
      this.progress("正在上传加密备份");
      await client.upload(name, file);
      this.settings.job!.backupName = name;
      this.settings.lastSuccessAt = new Date().toISOString();
    });
    return structuredClone(this.settings.job!);
  }
  async startRestore(name: string, password: string): Promise<BackupJob> {
    this.assertReady();
    const client = this.client(),
      currentPassword = this.encryptionPassword();
    await this.begin("restore");
    this.operation = this.execute(async (workDir) => {
      let prepared: PreparedRestore | undefined;
      let maintenance = false;
      try {
        this.progress("正在下载并校验备份");
        const source = join(workDir, "restore.urb");
        await client.download(name, source, maximumBackupBytes);
        prepared = await this.options.engine.prepareRestore(
          source,
          password,
          workDir,
          (phase) => this.progress(phase),
        );
        this.progress("正在等待站点完成当前操作");
        await this.options.maintenance.enter();
        maintenance = true;
        const safetyName = this.name("before-restore"),
          safetyFile = join(workDir, "before-restore.urb");
        await this.options.engine.create(
          safetyFile,
          currentPassword,
          "before-restore",
          (phase) => this.progress(phase),
        );
        this.progress("正在保留恢复前的完整快照");
        await client.upload(safetyName, safetyFile);
        this.settings.job!.safetyBackupName = safetyName;
        await this.persist();
        this.progress("正在替换数据库，请勿关闭服务");
        await prepared.apply();
        this.settings.job!.backupName = name;
      } finally {
        if (maintenance) this.options.maintenance.leave();
        await prepared?.dispose().catch(() => undefined);
      }
    });
    return structuredClone(this.settings.job!);
  }
  private assertReady() {
    if (this.busy)
      throw new BackupError("BACKUP_BUSY", "已有备份或恢复正在运行。");
    if (!this.settings.enabled || !this.settings.verifiedAt)
      throw new BackupError("BACKUP_DISABLED", "请先验证连接并启用备份功能。");
  }
  private async begin(operation: BackupJob["operation"]) {
    this.busy = true;
    const now = new Date().toISOString();
    this.settings.lastAttemptAt = now;
    this.settings.job = {
      id: randomUUID(),
      operation,
      status: "running",
      phase: "准备中",
      startedAt: now,
      finishedAt: null,
      backupName: null,
      safetyBackupName: null,
      errorCode: null,
      message: null,
    };
    try {
      await this.persist();
    } catch (error) {
      this.busy = false;
      throw error;
    }
  }
  private async execute(
    work: (directory: string) => Promise<void>,
  ): Promise<void> {
    let directory: string | undefined;
    try {
      directory = await mkdtemp(join(this.options.directory, "job-"));
      await work(directory);
      this.settings.job!.status = "succeeded";
      this.settings.job!.phase = "已完成";
    } catch (error) {
      Object.assign(this.settings.job!, {
        status: "failed",
        phase: "失败",
        errorCode: error instanceof BackupError ? error.code : "BACKUP_FAILED",
        message:
          error instanceof BackupError
            ? error.message
            : "操作未完成，请检查备份服务配置或联系部署管理员。",
      });
    } finally {
      this.settings.job!.finishedAt = new Date().toISOString();
      try {
        await this.persist();
      } catch {
        Object.assign(this.settings.job!, {
          status: "failed",
          errorCode: "BACKUP_STATUS_WRITE_FAILED",
          message: "操作记录未能持久化，请检查磁盘空间并核对备份列表。",
        });
      } finally {
        this.busy = false;
        if (directory)
          await rm(directory, { recursive: true, force: true }).catch(
            () => undefined,
          );
      }
    }
  }
  private progress(phase: string) {
    if (this.settings.job) this.settings.job.phase = phase;
  }
  private name(kind: string) {
    return (
      new Date().toISOString().replace(/[-:.]/g, "") +
      "_" +
      kind +
      "_" +
      randomUUID() +
      ".urb"
    );
  }
  private persist(value: Stored = this.settings): Promise<void> {
    const serialized = JSON.stringify(value);
    const save = this.saving.then(async () => {
      const next = join(
        this.options.directory,
        "settings-" + randomUUID() + ".tmp",
      );
      await writeFile(next, serialized, { mode: 0o600, flag: "wx" });
      await rename(next, join(this.options.directory, "settings.json"));
    });
    this.saving = save.catch(() => undefined);
    return save;
  }
  startSchedule() {
    this.timer = setInterval(() => {
      const interval = this.settings.intervalHours;
      if (
        this.busy ||
        !this.settings.enabled ||
        !interval ||
        !this.settings.verifiedAt
      )
        return;
      const last = Date.parse(
        this.settings.lastAttemptAt ?? this.settings.verifiedAt,
      );
      if (Date.now() - last >= interval * 3_600_000)
        void this.startBackup("scheduled").catch(() => undefined);
    }, 60_000);
    this.timer.unref();
  }
  async close() {
    if (this.timer) clearInterval(this.timer);
    await this.operation;
    await this.saving;
  }
}
