# 部署指南

本指南描述当前仓库的 Docker Compose 部署。Compose（用一个 YAML 文件编排多个容器的工具）包含 PostgreSQL、Redis、MinIO、迁移任务、API、异步 Worker 和 Web；Anklang、Fermata 作为显式 profile（可选服务组）启动。所有密码、令牌、外部服务地址和题目资料都放在 Git 之外。


## 环境文件

从模板复制一份只由部署管理员读取的环境文件：

```bash
cp deploy/env.production.example /secure/path/urmotiv.env
chmod 600 /secure/path/urmotiv.env
bash scripts/deploy/validate-env.sh /secure/path/urmotiv.env
```

`validate-env.sh` 会检查文件确实存在、权限为 `600`，并检查这些必填变量：

```dotenv
POSTGRES_USER=change-me
POSTGRES_PASSWORD=change-me
POSTGRES_DB=urmotiv
MINIO_ROOT_USER=change-me
MINIO_ROOT_PASSWORD=change-me
S3_BUCKET=urmotiv
URMOTIV_PLUGIN_SECRET_KEY=由本地随机生成器产生的32字节Base64URL值
URMOTIV_WEB_ORIGIN=https://urmotiv.example.org
```

上面是结构示例，不是可直接用于生产的凭据。`URMOTIV_PLUGIN_SECRET_KEY` 必须是恰好 32 字节随机值的无填充 Base64URL；不要与 `URMOTIV_USTC_OAUTH_STATE_SECRET` 或 `URMOTIV_CAS_STATE_SECRET` 复用。模板还提供 `S3_REGION`、`JOB_REDIS_PREFIX`、`URMOTIV_EMAIL_LOGIN_ENABLED`、`URMOTIV_EMAIL_REGISTRATION_ENABLED` 等可选设置。

先在不输出私有值的前提下渲染 Compose：

```bash
docker compose --env-file /secure/path/urmotiv.env config
```

不要把 `config` 的完整输出粘贴到工单或聊天，因为渲染结果可能包含环境值。

## 本地回环 HTTP（必须显式选择）

默认 Web 端口只绑定到服务器回环地址：`127.0.0.1:${URMOTIV_HTTP_PORT:-8080}`。用 SSH 转发访问时，私有环境文件必须明确写：

```dotenv
URMOTIV_WEB_ORIGIN=http://127.0.0.1:8080
URMOTIV_ALLOW_LOOPBACK_INSECURE_COOKIES=true
URMOTIV_HTTP_PORT=8080
```

`URMOTIV_ALLOW_LOOPBACK_INSECURE_COOKIES=true` 只允许精确的 localhost/127.0.0.1/[::1] HTTP 来源使用非 Secure Cookie。它不是公网开关；公网、共享网络或没有 SSH 隔离的环境必须保持 `false` 并使用 HTTPS。

启动本地栈：

```bash
docker compose --env-file /secure/path/urmotiv.env up -d --build
docker compose --env-file /secure/path/urmotiv.env ps
```

在服务器外的浏览器通过 SSH 转发：

```bash
ssh -N -L 8080:127.0.0.1:8080 your-user@your-server
```

然后打开 `http://127.0.0.1:8080/login`。首次启动后要在真实服务器 TTY 执行 `bootstrap-admin`，见[管理员指南](admin-guide.md)。

## 生产 HTTPS

生产入口应由现有反向代理或负载均衡器终止 HTTPS，再把流量转给 Compose 的 Web 服务。设置：

```dotenv
URMOTIV_WEB_ORIGIN=https://urmotiv.example.org
URMOTIV_ALLOW_LOOPBACK_INSECURE_COOKIES=false
URMOTIV_TRUSTED_PROXY_CIDRS=精确的反向代理IPv4或IPv6 CIDR
```

`URMOTIV_WEB_ORIGIN` 必须是浏览器实际访问的协议、主机和可选端口，不能带路径。反向代理需要：

- `/` 转发到 Web 容器；Web 再把 `/api/` 转发到 API 容器。
- 保留 `Host`、`X-Forwarded-For` 和 `X-Forwarded-Proto`，并只在代理地址确实属于 `URMOTIV_TRUSTED_PROXY_CIDRS` 时填写该变量。
- 对上传设置足够的请求体上限。内置 nginx 示例为 `128m`；API 的单文件路由上限为 `512 MiB`，若业务需要更大文件，必须在每一层代理明确调整并重新评估风险。
- 不要把 API、PostgreSQL、Redis、MinIO 或可选 Anklang/Fermata 端口直接暴露到公网；Compose 默认只发布 Web、Anklang 和 Fermata 的回环端口。

生产 HTTPS 下 OAuth/CAS 回调和 Cookie 都使用安全来源。不要通过设置回环例外来“修复”证书、代理头或来源配置问题。

## 端口和可选服务

| 服务 | Compose 内部地址/默认发布 | 作用 |
| --- | --- | --- |
| Web | `127.0.0.1:8080` → 容器 `80` | 浏览器入口和 `/api/` 代理 |
| API | `api:3000`（不发布到主机） | `/api/v1` 接口 |
| Worker | `worker:3010`（不发布到主机） | 异步任务健康服务 `/ready` |
| PostgreSQL | `postgres:5432`（不发布到主机） | 业务数据库 |
| Redis | `redis:6379`（不发布到主机） | 任务队列 |
| MinIO | Compose 网络内 `minio:9000` | S3 兼容对象存储 |
| Anklang | `127.0.0.1:8730`，profile `anklang` | 原题相似性检索；独立数据库和令牌 |
| Fermata | `127.0.0.1:8720`，profile `fermata` | 独立审核服务；不共享 Urmotiv 数据库 |

启用可选服务前，确认对应独立仓库与其被 Git 忽略的私有环境文件已经准备好；Compose 会按相对构建上下文和私有 `env_file` 检查它们，缺任一文件时显式选择该 profile 的 `config`/`up` 命令会失败。主 Urmotiv 环境文件只保留插件所需的服务地址和加密密钥设置。准备好外部前置条件后分别启动：

```bash
docker compose --env-file /secure/path/urmotiv.env --profile anklang up -d --build
docker compose --env-file /secure/path/urmotiv.env --profile fermata up -d --build
```

也可以设置 `COMPOSE_PROFILES=anklang,fermata` 后执行普通 `up`；不要为验证方便把外部私有 `env_file` 复制到 Urmotiv 仓库。

Urmotiv 中的 Anklang 插件只接受 `http://127.0.0.1:8730`、`localhost`、`host.docker.internal`、RFC1918/链路本地/ULA 字面量或单标签容器服务名；不得填写公网地址、账号密码、路径、查询或片段。管理员必须在确认 Anklang 自己的数据库、对象存储和 embedding 链路全程留在批准私有边界后，才把 `privateContentAuthorized` 从默认 `false` 改为 `true`。两个插件密钥分开保存：`serviceToken` 认证 Urmotiv→Anklang 服务请求，`embeddingApiKey` 是嵌入提供方写密钥；`embeddingProvider`（`baseUrl`/`model`/`dimension`）是普通设置，地址只允许 HTTPS 或仅供隔离测试的本地/私有 HTTP。查询与索引同步前插件都会先认证地 PUT `/api/v1/admin/embedding-provider` 供给提供方；未配置时查询不可用、索引跳过，绝不伪装成“没有相似题”。`serviceToken` 使用插件密钥保存，不会出现在 `/api/v1/admin/plugins` 响应。一个完整的设置请求示例见 `plugins/anklang/README.md`。

Anklang 查询只生成仅检索结果候选参考，绝不执行 Urmotiv 的模型审核、推荐工作流或最终裁决。提交同步通过 `ProblemService` 的窄索引适配器调用冻结的 `PUT /api/v1/index/problems`：成功 submit、`pending_review`/`approved` 标题变更、冻结 `basicStatement` 变更才同步；solution-only、draft/rejected、无变化和删除不发请求。`retryAttempts` 为 1–3 次（默认 2），仅网络/超时/408/429/502/503/504 重试；401、409、数据结构约束错误不重试。`indexTimeoutMs` 为 1–30 秒（默认 10 秒），同步失败不回滚已经提交的 Urmotiv 修订，也不伪装成“没有相似题”。

每个返回/保存的候选先移除当前题目自身候选，再按请求用户权限查找 Urmotiv 候选；未知、隐藏和明确拒绝完全等价并静默丢弃，授权的 Urmotiv 候选使用当前标题且丢弃 Anklang URL、`metadata`（附加信息）/判断字段。过滤失败时拒绝返回/保存。Fermata 仅读取 Urmotiv 自有检查属性。

Node 24 合成 E2E 只在没有生产 Anklang 监听器时运行；它使用临时数据库和回环模拟模型服务，不调用外部服务。端口占用会立即失败且不会停止现有进程：

```bash
ANKLANG_SOURCE_DIR=/path/to/anklang \
  pnpm --filter @urmotiv/plugin-anklang e2e:synthetic
```

## 健康检查

API 提供两个无需登录的检查：

```bash
curl --fail http://127.0.0.1:8080/api/v1/health
curl --fail http://127.0.0.1:8080/api/v1/health/ready
```

`/health` 返回 `{"status":"ok","service":"urmotiv-api"}`；`/health/ready` 在数据库可连接时返回 `200` 和 `{"status":"ready",...}`，数据库不可用时返回 `503` 和 `status: unavailable`。Compose API 健康检查使用容器内的 `/api/v1/health`，Worker 使用 `http://127.0.0.1:3010/ready`，Web 使用其代理后的 `/api/v1/health`。

健康检查通过不代表管理员 bootstrap 已完成，也不代表 OAuth、邮件投递、Anklang 或 Fermata 已配置。登录问题要结合 bootstrap 状态和应用日志摘要判断。

## 首次启动顺序

Compose 会先等待 PostgreSQL、Redis 和 MinIO 初始化，再运行迁移任务；API 依赖迁移成功。全新数据库随后需要真实 TTY：

```bash
docker compose --env-file /secure/path/urmotiv.env run --rm --no-deps api pnpm --filter @urmotiv/api bootstrap-admin
docker compose --env-file /secure/path/urmotiv.env up -d api web worker
```

初始化前的 API 业务访问被阻塞是预期安全状态。管理员恢复、角色和备份见[管理员指南](admin-guide.md)。

## 升级

升级脚本参数固定为“私有环境文件、备份目录”，并按以下顺序执行：验证环境、构建镜像、停止 API/Worker/Web、备份 PostgreSQL、运行迁移、重新启动、轮询 Web 健康检查：

```bash
bash scripts/deploy/upgrade.sh /secure/path/urmotiv.env /secure/path/backups
```

脚本成功会打印“升级完成，健康检查通过。”；失败时保留服务和备份，使用下面的命令查看摘要：

```bash
docker compose --env-file /secure/path/urmotiv.env ps
docker compose --env-file /secure/path/urmotiv.env logs --tail=100 api worker web migrate
```

不要用 `docker compose down -v` 作为升级或排障手段；它会删除数据库/对象存储卷，且不是回滚。升级前要确保备份目录已加密并可读取；对象存储附件不包含在 PostgreSQL dump 中，需要另行快照或备份。

## 故障排查

### Web 打不开或返回 502

检查 `web` 和 `api` 的容器状态、`api` 健康检查以及反向代理上游地址。外部代理应访问 Web 的 `/api/v1/health`，不要绕过来源/安全 Cookie 配置直连 API。

### API 一直不健康

按顺序确认 PostgreSQL/Redis/MinIO 健康、`migrate` 已成功、私有环境必填项完整，再查看 `/api/v1/health/ready` 和 API 日志摘要。`URMOTIV_WEB_ORIGIN` 若带路径、OAuth 回调来源不一致或密钥格式不合规，API 会拒绝启动。

### 能看到登录页但不能登录

先确认管理员 bootstrap 已成功并重启 `api web worker`。邮箱登录由 `URMOTIV_EMAIL_LOGIN_ENABLED` 控制，默认开启；邮箱注册由 `URMOTIV_EMAIL_REGISTRATION_ENABLED` 控制，默认关闭。注册若开启，还需要正式的邮件投递实现，不能在生产使用测试投递模式。

### OAuth 回调失败

确认提供商登记的回调精确等于 `URMOTIV_WEB_ORIGIN` 加 `/api/v1/auth/ustc/callback`，且生产使用 HTTPS；检查所有 OAuth 变量只出现一次，并让 `URMOTIV_USTC_OAUTH_STATE_SECRET` 与其他密钥不同。具体字段映射见[USTC OAuth 指南](ustc-oauth.md)。

### 导入上传被拒绝

内置 nginx 的请求体上限为 `128m`，题目包接口还检查归档大小和路径安全。确认上传格式已注册、预览没有错误，并检查 `/transfer` 任务的固定失败编号。不要关闭压缩包安全检查，也不要把原始题面或失败响应贴到日志。

### 插件调用超时或提交被阻止

管理员在 `/admin` 检查插件状态、设置版本和声明密钥是否已配置。提交前检查的超时/失败行为由插件设置决定；阻止行为不能靠客户端重试绕过。Anklang 和 Fermata 的服务日志、令牌和原始响应应分别在各自受控环境中排查。
