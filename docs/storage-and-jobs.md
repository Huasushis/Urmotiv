# 文件存储与后台任务

Urmotiv 的文件元数据在 PostgreSQL，文件正文在兼容 S3 的私有对象存储；导入导出等耗时操作由 Redis 队列交给 Worker。S3（保存对象的服务）和 Redis（保存队列状态的服务）只作为实现依赖，不能替 API 决定权限。

## 运行边界

生产环境的 Worker 必须有 `REDIS_URL`；对象存储至少需要 `S3_ENDPOINT`、`S3_REGION`、`S3_BUCKET`、`S3_ACCESS_KEY` 和 `S3_SECRET_KEY`。存储桶不能公开读取，浏览器不能根据内部 `storageKey` 直接下载。API 在上传、题目提交、导入导出任务创建、Worker 读取和最终下载时分别重算权限。

轻量开发模式可以使用本地 `STORAGE_LOCAL_ROOT` 和进程内队列；该模式不适合多实例生产或保存真实题目资料。生产 Compose 默认使用 MinIO 与 Redis，并通过网络别名连接：

| 变量 | 用途 | 默认/要求 |
| --- | --- | --- |
| `REDIS_URL` | Worker 与 API 的队列连接 | 生产必填 |
| `JOB_REDIS_PREFIX` | 队列键共同前缀 | 默认 `urmotiv:jobs` |
| `JOB_LEASE_MS` | 任务租约时长 | 默认 30,000 毫秒 |
| `JOB_RETRY_DELAY_MS` | 可重试失败的等待时间 | 默认 1,000 毫秒 |
| `WORKER_ID` | Worker 实例标识 | 未设置时运行时生成 |
| `WORKER_POLL_INTERVAL_MS` | 空队列轮询间隔 | 默认 500 毫秒 |
| `STORAGE_LOCAL_ROOT` | 轻量模式文件根目录 | 默认 `.data/storage` |
| `STORAGE_MAX_FILE_BYTES` | 存储入口单文件上限 | 由部署设置 |
| `S3_ENDPOINT` | S3 兼容服务地址 | 生产必填 |
| `S3_REGION` | S3 区域 | 生产必填 |
| `S3_BUCKET` | 私有存储桶 | 生产必填 |
| `S3_FORCE_PATH_STYLE` | 是否使用路径式 S3 请求 | 兼容服务按需设为 `true` |

`S3_ACCESS_KEY` 和 `S3_SECRET_KEY` 只放在私有环境文件，不能放进插件设置、题目包、日志或 API 响应。上传入口还会按文件类别检查媒体类型、逻辑路径和大小；题目包另有 128 MiB 解压安全边界。

## 任务一致性和权限

任务记录包含固定题目修订、输入摘要、适配器 ID/版本、文件类别和幂等键。Redis 租约和重试时间使用 Redis 服务端时钟；重试必须复用原任务编号和幂等键，不能覆盖运行中或已结束任务。停用插件、版本不一致、题目修订变化或权限撤销都会让 Worker 失败，不会静默换用新内容。

导出和下载有三次权限检查：创建任务时、Worker 读取文件时、用户换取下载时。权限撤销后，旧任务编号、对象地址和下载链接都不能绕过 `404` 掩码。失败报告只保存稳定错误编号、计数和必要相对位置，不保存题面、题解、测试数据、程序正文、密码、令牌或密钥。

## 运维检查

部署和健康检查命令见[部署指南](deployment.md)。备份时要同时备份 PostgreSQL 和对象存储；数据库 dump 不包含附件正文，恢复数据库后必须从对象存储快照恢复对应对象。不要使用 `docker compose down -v` 进行排障或升级。
