# Fermata 审核服务接入说明（操作员指南）

本文面向 Urmotiv 系统管理员，说明如何配置和使用 Fermata 审核服务。Fermata 是独立运行的
AI 审题服务，有自己的数据库和模型配置，不与 Urmotiv 共享数据库。Urmotiv 通过带版本号的
HTTP 接口调用 Fermata 的管理端口，不直接执行模型推理。

## 前提

- Fermata 服务已部署并能通过 HTTP 访问。
- 你在 Urmotiv 中同时拥有 `plugin.manage` 和 `system.manage` 权限。
- Fermata 管理员已生成管理令牌并安全交付给你。

## 审核如何触发

Fermata 不是在 Urmotiv 的“提交审核”请求里同步运行。它使用一个单独的机器人账号，按公开设置中的轮询间隔主动领取处于 `pending_review`（待审核）的任务；“立即检查”只会跳过当前等待，马上再轮询一次。领取后任务带有租约，Fermata 在处理期间续租，完成后把结构化审核意见提交回当前审核轮次。

机器人意见是否会直接参与自动通过/不通过，由 Urmotiv 的“审核规则”决定。默认设置“计算机器人意见”为关闭，因此 Fermata 意见默认只作为可见参考，不会单独改变题目状态；人工审题意见仍按人数规则汇总，拥有 `problem.status.change` 的人工管理员也可以填写理由后直接执行人工终审。

## 配置步骤

### 1. 建立 Fermata 的机器人身份

在 Urmotiv 的“管理 → 服务账号”创建一个机器人账号，并为它生成仅包含所需权限的令牌。典型审题令牌需要 `auth.login`、`problem.view.all`、`problem.review` 和 `problem.testdata.read`。令牌只显示一次，应写入 Fermata 私有环境中的 `URMOTIV_ROBOT_TOKEN`；`URMOTIV_BASE_URL` 必须是从 Fermata 运行环境实际能够访问到的 Urmotiv 地址。Fermata 位于独立容器时，`127.0.0.1` 指向 Fermata 容器自身，不能用它代指宿主机上的 Urmotiv。

Urmotiv 不会自动把令牌写进另一个服务的环境，也不会在以后重新显示令牌。机器人令牌与下文的 Fermata 管理令牌是两个不同方向、不同用途的凭据。

### 2. 配置并启用 Fermata 控制插件

在 Urmotiv 管理后台的插件管理页面找到 `org.ustc.urmotiv.fermata-control`，先提交设置，再单独启用插件：

- **服务地址**（`baseUrl`）：Fermata 的 HTTP 根地址，例如 `http://fermata.internal:4100`。只接受不含账号密码的 `http://` 或 `https://` 地址。
- **超时毫秒数**（`timeoutMs`）：等待 Fermata 响应的最大时间，当前范围由插件设置模式校验。
- **管理令牌**（`fermataManagementToken`）：Fermata 管理员提供的管理令牌，以加密字段保存，保存后不在任何响应、日志或审计中回显明文。

提交设置时带当前 `settingsRevision`；设置冲突返回 `409`。配置保存不会自动改变插件状态：确认服务可达后，在同一插件卡片执行启用；修改设置和令牌不需要重启，每次调用都会重新读取最新值。

控制插件只负责 Urmotiv 调用 Fermata 的健康、公开设置和立即检查接口；它不会代替上一步的机器人身份，也不会仅凭“启用插件”就开始模型审核。

### 3. 验证连通性

调用健康检查接口确认 Urmotiv 能到达 Fermata：

```
GET /api/v1/admin/fermata/health
```

正常返回类似：

```json
{
  "health": {
    "status": "ok",
    "service": "fermata",
    "apiVersion": "1",
    "workerRunning": true,
    "activeTasks": 0,
    "checkedAt": "2026-08-15T10:00:00.000Z"
  }
}
```

## 管理接口一览

| 方法 | 路径 | 用途 |
|------|------|------|
| GET | `/api/v1/admin/fermata/health` | 查看 Fermata 运行状态 |
| GET | `/api/v1/admin/fermata/settings` | 读取 Fermata 公开设置 |
| PUT | `/api/v1/admin/fermata/settings` | 更新 Fermata 公开设置 |
| POST | `/api/v1/admin/fermata/wake` | 通知 Fermata 立即检查一次新任务 |

所有接口要求同时具备 `plugin.manage` 和 `system.manage` 权限。无权访问的请求返回 404，不泄露端点存在性。
机器人账号即使同时被错误分配 `plugin.manage` 和 `system.manage` 也不能访问，因为机器人固定禁止 `plugin.manage`。

所有响应头包含 `cache-control: private, no-store`，防止管理内容被缓存。

## 更新设置

更新 Fermata 设置需要带当前修订编号，防止覆盖他人的同时修改：

```
PUT /api/v1/admin/fermata/settings
Content-Type: application/json

{
  "expectedRevision": 4,
  "settings": {
    "enabled": true,
    "pollingIntervalSeconds": 30,
    "maximumConcurrentTasks": 2,
    "modelProfileName": "review-balanced",
    "experimentVersion": "experiment-2026-07"
  }
}
```

`settings` 中不包含任何密钥字段。Fermata 的模型密钥由 Fermata 自己管理，Urmotiv 响应中
只返回 `secretsConfigured` 布尔值，说明 Fermata 是否已配置密钥。

## 错误处理

| HTTP 状态码 | 错误代码 | 含义 |
|-------------|---------|------|
| 503 | `FERMATA_NOT_CONFIGURED` | 插件未启用、服务地址未配置或管理令牌未设置 |
| 503 | `FERMATA_UNAVAILABLE` | Fermata 不可达或请求超时 |
| 502 | `FERMATA_REQUEST_FAILED` | Fermata 返回了非 2xx 状态码 |
| 502 | `FERMATA_RESPONSE_INVALID` | Fermata 返回的内容不符合版本 1 接口约定 |
| 422 | `VALIDATION_ERROR` | 请求体不符合输入校验要求 |

所有错误响应的 `message` 字段只包含操作员可读的中文提示，不包含管理令牌、Fermata 原始
错误体、网络错误细节或内部堆栈。服务端日志会记录 `code` 和内部摘要，但不记录令牌。

## 安全规则

- 管理令牌以加密字段保存在 Urmotiv 插件密钥存储中，永不回显明文。
- 响应、日志、审计元数据和错误体中不包含令牌。
- 无权访问与不存在的端点返回相同的 404，不泄露 Fermata 是否启用。
- 机器人账号固定禁止 `plugin.manage`，任何插件都不能解除。
- 明确拒绝永远优先于角色或插件允许。
