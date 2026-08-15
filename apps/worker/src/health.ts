import { createServer, type Server } from "node:http";

/**
 * worker 的就绪探针：返回最近一次向任务队列“取得进展”的时间。
 * 进展包括空闲轮询和任务租约续期，因此进程活着但没有轮询或续租时会进入陈旧状态。
 */
export interface WorkerHealthProbe {
  lastActivityAt(): number;
}

export interface WorkerHealthServerOptions {
  readonly probe: WorkerHealthProbe;
  readonly host: string;
  readonly port: number;
  readonly staleMs: number;
  readonly now?: () => number;
}

export interface WorkerHealthState {
  readonly ready: boolean;
  readonly ageMs: number;
}

export interface WorkerHealthServer {
  readonly server: Server;
  /** 返回实际绑定的端口（端口为 0 时由系统分配）。 */
  readonly port: number;
  listen(): Promise<number>;
  close(): Promise<void>;
  latest(): WorkerHealthState;
}

/**
 * 提供两个端点：
 * - GET /live：进程存在即可返回 200，用于存活探测。
 * - GET /ready：最近一次队列进展未超过 staleMs 时返回 200，否则返回 503，
 *   用于识别“进程还活着但已经卡住”的 worker。
 * 两个响应都只包含固定字段，不包含任务参数或配置值。
 */
export function createWorkerHealthServer(
  options: WorkerHealthServerOptions
): WorkerHealthServer {
  const now = options.now ?? (() => Date.now());
  let boundPort = options.port;

  const latest = (): WorkerHealthState => {
    const ageMs = Math.max(0, now() - options.probe.lastActivityAt());
    return { ready: ageMs <= options.staleMs, ageMs };
  };

  const server = createServer((request, response) => {
    response.setHeader("content-type", "application/json; charset=utf-8");
    response.setHeader("cache-control", "no-store");
    if (request.method !== "GET") {
      response.statusCode = 404;
      response.end(`{"status":"not_found","service":"urmotiv-worker"}`);
      return;
    }
    const pathname = new URL(request.url ?? "/", "http://health").pathname;
    if (pathname === "/live") {
      response.statusCode = 200;
      response.end(`{"status":"ok","service":"urmotiv-worker"}`);
      return;
    }
    if (pathname === "/ready") {
      const state = latest();
      response.statusCode = state.ready ? 200 : 503;
      response.end(
        state.ready
          ? `{"status":"ready","service":"urmotiv-worker","lastActivityMs":${state.ageMs}}`
          : `{"status":"unavailable","service":"urmotiv-worker","reason":"stale","lastActivityMs":${state.ageMs}}`
      );
      return;
    }
    response.statusCode = 404;
    response.end(`{"status":"not_found","service":"urmotiv-worker"}`);
  });

  const listen = (): Promise<number> =>
    new Promise<number>((resolve, reject) => {
      server.once("error", reject);
      server.listen(options.port, options.host, () => {
        server.removeListener("error", reject);
        const address = server.address();
        boundPort =
          typeof address === "object" && address !== null ? address.port : options.port;
        resolve(boundPort);
      });
    });

  const close = (): Promise<void> =>
    new Promise<void>((resolve, reject) => {
      server.close((error) => (error === undefined ? resolve() : reject(error)));
    });

  return { server, get port() { return boundPort; }, listen, close, latest };
}