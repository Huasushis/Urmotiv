import { randomUUID } from "node:crypto";
import { LocalJobQueue, connectRedisJobQueue, type JobQueue } from "@urmotiv/jobs";
import { z } from "zod";

const pollInterval = z.coerce.number().int().min(10).max(60_000);
const leaseDuration = z.coerce.number().int().min(100).max(24 * 60 * 60 * 1_000);
const retryDelay = z.coerce.number().int().min(0).max(24 * 60 * 60 * 1_000);
const healthPortSchema = z.coerce.number().int().min(1).max(65_535);
const healthStaleSchema = z.coerce.number().int().min(1_000).max(24 * 60 * 60 * 1_000);
const healthExitAfterSchema = z.coerce.number().int().min(0).max(60);

export interface WorkerConfig {
  readonly workerId: string;
  readonly pollIntervalMs: number;
  readonly leaseMs: number;
  readonly retryDelayMs: number;
  readonly healthHost: string;
  readonly healthPort: number;
  readonly healthStaleMs: number;
  readonly healthExitAfterUnready: number;
  readonly redis:
    | { readonly enabled: false }
    | { readonly enabled: true; readonly url: string; readonly prefix: string };
}

export function readWorkerConfig(
  environment: Readonly<Record<string, string | undefined>>
): WorkerConfig {
  const redisUrl = environment.REDIS_URL?.trim() ?? "";
  if (environment.NODE_ENV === "production" && redisUrl.length === 0) {
    throw new Error("生产环境必须设置 REDIS_URL，不能使用单进程任务队列。");
  }

  const pollIntervalMs = parseInteger(
    environment.WORKER_POLL_INTERVAL_MS,
    500,
    pollInterval,
    "WORKER_POLL_INTERVAL_MS"
  );
  const leaseMs = parseInteger(environment.JOB_LEASE_MS, 30_000, leaseDuration, "JOB_LEASE_MS");
  const retryDelayMs = parseInteger(
    environment.JOB_RETRY_DELAY_MS,
    1_000,
    retryDelay,
    "JOB_RETRY_DELAY_MS"
  );
  const healthHost = environment.WORKER_HEALTH_HOST?.trim() || "127.0.0.1";
  const healthPort = parseInteger(
    environment.WORKER_HEALTH_PORT,
    3010,
    healthPortSchema,
    "WORKER_HEALTH_PORT"
  );
  const healthStaleMs = parseInteger(
    environment.URMOTIV_WORKER_HEALTH_STALE_MS,
    60_000,
    healthStaleSchema,
    "URMOTIV_WORKER_HEALTH_STALE_MS"
  );
  const healthExitAfterUnready = parseInteger(
    environment.URMOTIV_WORKER_HEALTH_EXIT_AFTER_UNREADY,
    3,
    healthExitAfterSchema,
    "URMOTIV_WORKER_HEALTH_EXIT_AFTER_UNREADY"
  );

  return {
    workerId: environment.WORKER_ID?.trim() || `worker-${randomUUID()}`,
    pollIntervalMs,
    leaseMs,
    retryDelayMs,
    healthHost,
    healthPort,
    healthStaleMs,
    healthExitAfterUnready,
    redis:
      redisUrl.length === 0
        ? { enabled: false }
        : {
            enabled: true,
            url: z.string().url().parse(redisUrl),
            prefix: environment.JOB_REDIS_PREFIX?.trim() || "urmotiv:jobs"
          }
  };
}

export async function createConfiguredQueue(config: WorkerConfig): Promise<JobQueue> {
  if (!config.redis.enabled) {
    return new LocalJobQueue({ retryDelayMs: config.retryDelayMs });
  }
  return connectRedisJobQueue({
    url: config.redis.url,
    prefix: config.redis.prefix,
    retryDelayMs: config.retryDelayMs
  });
}

function parseInteger(
  value: string | undefined,
  fallback: number,
  schema: z.ZodType<number>,
  name: string
): number {
  const result = schema.safeParse(value ?? fallback);
  if (!result.success) {
    throw new Error(`${name} 必须是有效整数。`);
  }
  return result.data;
}
