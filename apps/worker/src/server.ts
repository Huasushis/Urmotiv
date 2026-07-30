import { createConfiguredQueue, readWorkerConfig } from "./config";
import { JobWorker } from "./worker";

async function main(): Promise<void> {
  const config = readWorkerConfig(process.env);
  const queue = await createConfiguredQueue(config);
  const worker = new JobWorker(queue, {
    workerId: config.workerId,
    leaseMs: config.leaseMs,
    pollIntervalMs: config.pollIntervalMs
  });

  let stopping = false;
  const stop = (): void => {
    if (stopping) {
      return;
    }
    stopping = true;
    void worker.stop().catch(() => undefined);
  };

  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);

  try {
    await worker.run();
  } finally {
    await queue.close();
  }
}

try {
  await main();
} catch {
  process.exitCode = 1;
  process.stderr.write('{"service":"worker","outcome":"failed"}\n');
}
