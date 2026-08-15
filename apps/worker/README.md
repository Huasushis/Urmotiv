# @urmotiv/worker

worker 是执行后台任务的独立进程。每种任务先注册一个处理器，注册完成后调用 `run`。开始运行后注册表会锁定，防止插件或
其他代码在运行途中替换处理器。未知任务不会执行，而是以 `unknown_job_type` 失败。

```ts
import { JobWorker, PermanentJobError } from "@urmotiv/worker";

const worker = new JobWorker(queue, {
  workerId: "worker-1",
  leaseMs: 30_000,
  pollIntervalMs: 500
});

worker.register("problem.export", async (payload, context) => {
  if (context.signal.aborted) {
    throw new PermanentJobError("cancelled", "任务已取消。");
  }

  await context.updateProgress(50);
  await context.putItemReport({
    itemId: "0",
    state: "succeeded",
    resultId: "stored-file-id"
  });
  return { result: { resultFileId: "stored-file-id" } };
});

await worker.run();
```

处理器超过任务的 `timeoutMs` 后会收到取消信号并进入重试。JavaScript 不能强行停止已经运行的函数，因此处理器必须定期检查
`context.signal`，数据库写入和外部请求也应支持取消。不可重试的、安全且不含私密内容的错误可以使用
`PermanentJobError`；其他异常只保存统一说明，不保存原始错误文字。

收到 `SIGINT` 或 `SIGTERM` 时，`src/server.ts` 停止领取新任务，等待当前任务结束，再关闭队列连接。生产环境没有
`REDIS_URL` 时拒绝启动。当前入口只提供队列连接和进程生命周期；导入、导出和插件处理器必须在应用组合层注册，不能让
worker 直接读取 API 的内部文件或绕过数据库权限检查。

## 健康检查

`src/server.ts` 会启动一个内部健康服务（只监听回环地址），供容器健康检查使用：

- `GET /live`：进程存在即返回 200。
- `GET /ready`：最近一次队列进展未超过 `URMOTIV_WORKER_HEALTH_STALE_MS`（默认 60 秒）时返回 200，否则返回
  503。队列进展包括空闲轮询和任务租约续期，因此“进程还活着但事件循环或续租已经卡住”时会进入不健康状态。

连续不通过就绪检查达到 `URMOTIV_WORKER_HEALTH_EXIT_AFTER_UNREADY` 次（默认 3 次，设为 0 关闭）时，进程主动以
非零码退出，由容器的 `restart` 策略重新拉起。相关环境变量：

- `WORKER_HEALTH_HOST`（默认 `127.0.0.1`）与 `WORKER_HEALTH_PORT`（默认 `3010`）：健康服务的监听地址。
- `URMOTIV_WORKER_HEALTH_STALE_MS`（默认 `60000`）：判定 worker 卡住的最近进展时间差。
- `URMOTIV_WORKER_HEALTH_EXIT_AFTER_UNREADY`（默认 `3`）：连续不通过多少次后主动退出，`0` 表示关闭。

默认日志只有：

```json
{"jobId":"...","outcome":"succeeded","attempt":1}
```

日志中不包含任务类型、参数、处理器错误、题面、题解、测试数据或配置值。
