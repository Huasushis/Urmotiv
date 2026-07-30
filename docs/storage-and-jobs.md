# 文件存储与后台任务

本文说明文件、任务队列和 worker 的公共边界。接口细节分别见
[`@urmotiv/storage`](../packages/storage/README.md)、[`@urmotiv/jobs`](../packages/jobs/README.md) 和
[`@urmotiv/worker`](../apps/worker/README.md)。

## 运行方式

轻量模式使用 `.data/storage` 和单进程内存队列，不需要 Docker。正式服务器使用兼容 S3 的对象存储和 Redis。
S3 是保存文件的服务；Redis 是保存排队状态并协调多个 worker 的服务。两种模式通过相同 TypeScript 接口调用。

生产环境必须满足：

- worker 设置 `REDIS_URL`，没有时拒绝启动；
- 文件服务使用 `S3_ENDPOINT`、`S3_REGION`、`S3_BUCKET` 和服务器提供的访问凭据；
- S3 存储桶不能公开读取，浏览器不能直接根据内部位置下载；
- API 在上传、发布、读取、导出任务创建和导出下载时分别检查权限；
- worker 只接收已经固定的任务编号和版本编号，不把题面或密钥放入日志和任务报告。

## 配置字段

`.env.example` 只列字段名，不给出可误用的开发值。具体含义如下：

| 字段 | 含义 |
| --- | --- |
| `REDIS_URL` | Redis 连接地址；生产 worker 必填 |
| `JOB_REDIS_PREFIX` | Redis 中任务键的共同前缀，默认 `urmotiv:jobs` |
| `JOB_LEASE_MS` | 一次领取任务的有效时间，默认 30000 毫秒 |
| `JOB_RETRY_DELAY_MS` | 可重试失败后再次领取前的等待时间，默认 1000 毫秒 |
| `WORKER_ID` | worker 实例编号；未设置时运行时随机生成 |
| `WORKER_POLL_INTERVAL_MS` | 没有任务时再次检查的间隔，默认 500 毫秒 |
| `STORAGE_LOCAL_ROOT` | 轻量模式文件目录，默认 `.data/storage` |
| `STORAGE_MAX_FILE_BYTES` | 上传入口允许的单文件最大字节数 |
| `S3_ENDPOINT` | S3 兼容服务地址 |
| `S3_REGION` | S3 区域；兼容服务也应给出固定值 |
| `S3_BUCKET` | 私有存储桶名称 |
| `S3_ACCESS_KEY` | S3 访问编号，只能在服务器环境中提供 |
| `S3_SECRET_KEY` | S3 密钥，只能在服务器环境中提供 |
| `S3_FORCE_PATH_STYLE` | 兼容服务需要路径形式访问时设为 `true` |

大小、媒体类型和压缩包安全上限应由调用方按文件类别传给存储接口，不能只依赖一个全站默认值。例如题面图片、公开附件、
测试数据和导入 ZIP 应分别设置允许类型和大小。

## 权限与任务结果

存储包没有用户信息，因此不能替 API 做权限检查。数据库保存的 `storageKey` 只是内部位置，不是下载凭据。读取文件前必须从
文件关系查到题目和类别，再执行 `docs/permissions.md` 中的权限规则。导出任务创建时检查一次，worker 读取每道题和每个文件时
再检查一次，用户换取下载内容时还要再检查一次。权限撤销后，旧任务编号和旧下载入口都不能继续使用。

worker 失败时只记录稳定错误编号和普通说明。逐项报告可以保存来源条目编号、导入后的题目编号或导出文件编号，但不得保存
题面全文、题解、测试数据、原始压缩包内容、密码、令牌或密钥。

## USTC 服务器检查

依赖安装和所有执行都在 `ssh ustc` 指向的服务器完成。本机只编辑和静态检查。服务器同步代码后运行：

```bash
pnpm install
pnpm --filter @urmotiv/storage typecheck
pnpm --filter @urmotiv/storage test
pnpm --filter @urmotiv/storage build
pnpm --filter @urmotiv/jobs typecheck
pnpm --filter @urmotiv/jobs test
pnpm --filter @urmotiv/jobs build
pnpm --filter @urmotiv/worker typecheck
pnpm --filter @urmotiv/worker test
pnpm --filter @urmotiv/worker build
```

S3 和 Redis 的单元测试使用内存或假实现，不需要连接真实服务。正式接线完成后，再在 USTC 的隔离测试桶和 Redis 测试库做
连接检查；不能使用协会真实题目作为测试文件。
