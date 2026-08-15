import { createConfiguredQueue, readWorkerConfig } from "./config";
import { createWorkerHealthServer } from "./health";
import { JobWorker } from "./worker";

async function main(): Promise<void> {
  const config = readWorkerConfig(process.env);
  const queue = await createConfiguredQueue(config);
  const worker = new JobWorker(queue, {
    workerId: config.workerId,
    leaseMs: config.leaseMs,
    pollIntervalMs: config.pollIntervalMs
  });
  const health = createWorkerHealthServer({
    probe: worker,
    host: config.healthHost,
    port: config.healthPort,
    staleMs: config.healthStaleMs
  });

  let stopping = false;
  let exitCode = 0;
  const terminate = (code: number): void => {
    if (stopping) {
      return;
    }
    stopping = true;
    exitCode = code;
    void (async () => {
      await health.close().catch(() => undefined);
      await worker.stop().catch(() => undefined);
      await queue.close().catch(() => undefined);
    })();
  };

  process.once("SIGINT", () => terminate(0));
  process.once("SIGTERM", () => terminate(0));

  // 卡住检测：多次连续超过就绪阈值时主动以非零码退出，交给容器的
  // restart 策略重新拉起。设为 0 可关闭主动退出，只保留健康检查的标记能力。
  let consecutiveUnready = 0;
  const watchdog =
    config.healthExitAfterUnready === 0
      ? undefined
      : setInterval(() => {
          if (stopping) {
            return;
          }
          if (health.latest().ready) {
            consecutiveUnready = 0;
            return;
          }
          consecutiveUnready += 1;
          if (consecutiveUnready >= config.healthExitAfterUnready) {
            process.stderr.write(
              '{"service":"worker","outcome":"unhealthy_exit","reason":"stale"}\n'
            );
            terminate(2);
          }
        }, Math.max(1_000, Math.floor(config.healthStaleMs / 3)));

  try {
    const healthPort = await health.listen();
    process.stdout.write(
      `{"service":"worker","outcome":"listening","healthPort":${healthPort}}\n`
    );
    await worker.run();
  } finally {
    if (watchdog !== undefined) {
      clearInterval(watchdog);
    }
    if (!stopping) {
      await health.close().catch(() => undefined);
      await worker.stop().catch(() => undefined);
      await queue.close();
    }
  }
  process.exitCode = exitCode;
}

try {
  await main();
} catch {
  process.exitCode = 1;
  process.stderr.write('{"service":"worker","outcome":"failed"}\n');
}
