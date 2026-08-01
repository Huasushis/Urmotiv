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

幂等是指同一个请求重复到达时只产生一次结果。入队调用方必须先生成 UUID 格式的 `jobId`，并在请求结果丢失后的重投中
继续使用这个编号；同时必须传 `idempotencyScope` 和 `idempotencyKey`，前者通常是用户编号，后者是该用户这次请求的编号。
队列会计算任务类型、参数、超时和重试上限的 SHA-256。任务编号、请求摘要、幂等范围和键全部相同才返回已有任务，任一项
冲突都固定报 `IDEMPOTENCY_CONFLICT`，不能悄悄复用。Redis 中的幂等索引原子保存任务编号与请求摘要；索引或任务记录单边
缺失时只按相同编号、相同摘要和相同幂等身份修复。已有任务处于运行中或结束状态时，重投不会把它覆盖回排队状态。

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
  jobId: "11111111-1111-4111-8111-111111111111",
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

Redis 键统一放在 `${JOB_REDIS_PREFIX}:v2:` 命名空间；升级时不会把旧布局误当成当前任务。租约截止时间、续租、失败后的再次
可领取时间和过期回收都使用 Redis 服务器的 `TIME`，不采信 API 或 worker 所在机器的时钟。一次过期回收最多在单段脚本中
检查 100 个租约，调用方会继续分批直到当时已过期的项目处理完。部署边界是单个 Redis 主节点；如果部署层或 Sentinel
对外提供一个当前主节点的连接地址，也可以使用该地址，但本客户端不发现或管理 Sentinel。当前脚本不支持 Redis Cluster，
不能把这些键分散到多个槽位。

普通单元测试使用本地队列，不要求 Redis。真实 Redis 集成测试必须使用隔离实例或隔离数据库，并显式设置
`URMOTIV_REDIS_TEST_URL`；未设置时该测试文件会标记为跳过。测试使用每个用例独有的前缀，不能清空共享数据库。
