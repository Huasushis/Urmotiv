# @urmotiv/jobs

这个包定义后台任务记录和任务队列。后台任务是把耗时操作放到队列中执行，页面只需要查询状态和进度，不必一直保持请求。

## 状态与进度

- `queued`：等待执行；
- `running`：某个 worker 已领取；
- `succeeded`：成功完成；
- `failed`：重试结束后仍失败，或遇到明确不可重试的错误；
- `cancelled`：尚未完成时被取消。

进度为 0 到 100 的整数，只能增加。`itemReports` 保存逐题或逐文件的简短结果；报告只放项目编号、结果编号、稳定错误编号
和短说明，不得放题面、题解、测试数据、密码、令牌或密钥。

## 幂等与重试

幂等是指同一个请求重复到达时只产生一次结果。入队时必须传 `idempotencyScope` 和 `idempotencyKey`：前者通常是用户编号，
后者是该用户这次请求的编号。队列还会计算任务类型、参数、超时和重试上限的 SHA-256。相同范围和键再次入队会返回已有
任务；内容不同则报 `IDEMPOTENCY_CONFLICT`，不能悄悄复用。

导入和导出分别使用 `problem.import`、`problem.export`。队列参数只保存 `importJobId` 或 `exportJobId`，也就是数据库任务编号；
worker 根据编号读取已经固定的来源文件、题目版本和选项。不要把题面、题解、测试数据或完整导入选择复制进队列参数。

处理器也必须能安全重复执行，因为 worker 可能在完成业务写入后、报告成功前断开。创建题目、生成导出包和通知外部服务时，
业务数据库仍要用任务编号或独立幂等键建立唯一约束。

## 租约

租约是有截止时间的任务认领记录。worker 领取任务后定期调用 `renewLease` 延长截止时间；worker 退出或失联后，
`recoverExpiredLeases` 会把任务重新排队。每次领取会增加 `attempt`，达到 `maxAttempts` 后任务进入 `failed`，不再执行。
只有持有当前租约编号的 worker 能更新进度、报告、完成或标记失败。

```ts
import { LocalJobQueue } from "@urmotiv/jobs";

const queue = new LocalJobQueue({ retryDelayMs: 1000 });
const job = await queue.enqueue({
  type: "problem.export",
  payload: { exportJobId: "11111111-1111-4111-8111-111111111111" },
  idempotencyScope: "user-42",
  idempotencyKey: "request-2026-07-26",
  maxAttempts: 3,
  timeoutMs: 15 * 60 * 1000
});
```

`LocalJobQueue` 只适合单进程轻量模式，进程退出后记录会消失。生产环境使用 `connectRedisJobQueue`；Redis 是保存队列状态并让
多个 worker 协调领取任务的服务。实现使用 Redis 官方 Node.js 客户端，并通过 Redis 内的一次性脚本操作保证同一任务不会被
两个 worker 同时领取。任务参数、结果和逐项报告在 Redis 内保持原始 JSON 字符串，续租不会改变空数组等数据形状。

测试使用本地队列，不要求本机或测试环境提供真实 Redis。Redis 集成测试应在 USTC 服务器的独立测试库执行。
