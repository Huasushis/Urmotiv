import type { FastifyInstance, FastifyRequest } from "fastify";
import {
  backupSettingsInputSchema,
  restoreBackupInputSchema,
} from "@urmotiv/contracts";
import { ApiError } from "../errors";
import { BackupError } from "./webdav";
import type { BackupService } from "./service";

export class RestoreMaintenance {
  private active = false;
  private readonly requests = new Set<object>();
  attach(app: FastifyInstance) {
    app.addHook("onRequest", async (request, reply) => {
      const path = request.url.split("?")[0]!;
      if (
        path.startsWith("/api/v1/admin/backups") ||
        path.startsWith("/api/v1/health")
      )
        return;
      if (this.active) {
        reply
          .code(503)
          .send({
            error: {
              code: "SITE_RESTORING",
              message: "站点正在恢复备份，请稍后再试。",
            },
          });
        return;
      }
      this.requests.add(request);
    });
    app.addHook("onResponse", async (request) => {
      this.requests.delete(request);
    });
  }
  async enter(assertIdle: () => Promise<void>) {
    if (this.active)
      throw new BackupError("BACKUP_BUSY", "站点已经在恢复备份。");
    await assertIdle();
    this.active = true;
    try {
      const deadline = Date.now() + 30_000;
      while (this.requests.size) {
        if (Date.now() > deadline)
          throw new BackupError(
            "BACKUP_REQUESTS_BUSY",
            "还有未完成的站点操作，请稍后重试恢复。",
          );
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      await assertIdle();
    } catch (error) {
      this.active = false;
      throw error;
    }
  }
  leave() {
    this.active = false;
  }
}

export function registerBackupRoutes(
  app: FastifyInstance,
  options: {
    service?: BackupService;
    requireRoot: (request: FastifyRequest, password?: string) => Promise<void>;
  },
) {
  const service = () => {
    if (!options.service)
      throw new ApiError(
        503,
        "BACKUP_UNAVAILABLE",
        "完整备份仅在已配置备份目录与加密密钥的 PostgreSQL 部署中可用。",
      );
    return options.service;
  };
  async function safe<T>(work: () => Promise<T>): Promise<T> {
    try {
      return await work();
    } catch (error) {
      if (error instanceof BackupError)
        throw new ApiError(
          error.code === "BACKUP_BUSY" ||
          error.code === "BACKUP_SETTINGS_CONFLICT"
            ? 409
            : 400,
          error.code,
          error.message,
        );
      throw error;
    }
  }
  app.get("/api/v1/admin/backups", async (request, reply) => {
    reply.header("cache-control", "private, no-store");
    await options.requireRoot(request);
    return service().view();
  });
  app.put("/api/v1/admin/backups/settings", async (request, reply) => {
    reply.header("cache-control", "private, no-store");
    await options.requireRoot(request);
    const input = backupSettingsInputSchema.parse(request.body);
    return safe(() => service().configure(input));
  });
  app.get("/api/v1/admin/backups/files", async (request, reply) => {
    reply.header("cache-control", "private, no-store");
    await options.requireRoot(request);
    return safe(() => service().list());
  });
  app.post("/api/v1/admin/backups/run", async (request, reply) => {
    reply.header("cache-control", "private, no-store");
    await options.requireRoot(request);
    const job = await safe(() => service().startBackup());
    reply.code(202);
    return { job };
  });
  app.post("/api/v1/admin/backups/restore", async (request, reply) => {
    reply.header("cache-control", "private, no-store");
    await options.requireRoot(request);
    const input = restoreBackupInputSchema.parse(request.body);
    await options.requireRoot(request, input.currentPassword);
    const job = await safe(() =>
      service().startRestore(input.name, input.encryptionPassword),
    );
    reply.code(202);
    return { job };
  });
}
