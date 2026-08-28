# Fermata 审核服务接入说明（操作员指南）

本文面向 Urmotiv 系统管理员，说明如何配置和使用 Fermata 审核服务。Fermata 是独立运行的
AI 审题服务，有自己的数据库和模型配置，不与 Urmotiv 共享数据库。Urmotiv 通过带版本号的
HTTP 接口调用 Fermata 的管理端口，不直接执行模型推理。

## 前提

- Fermata 服务已部署并能通过 HTTP 访问。
- 你在 Urmotiv 中同时拥有 `plugin.manage` 和 `system.manage` 权限。
- Fermata 管理员已生成管理令牌并安全交付给你。

## 配置步骤

### 1. 配置并启用 Fermata 控制插件

在 Urmotiv 管理后台的插件管理页面找到 `org.ustc.urmotiv.fermata-control`，先提交设置，再单独启用插件：

- **服务地址**（`baseUrl`）：Fermata 的 HTTP 根地址，例如 `http://fermata.internal:4100`。只接受不含账号密码的 `http://` 或 `https://` 地址。
- **超时毫秒数**（`timeoutMs`）：等待 Fermata 响应的最大时间，当前范围由插件设置模式校验。
- **管理令牌**（`fermataManagementToken`）：Fermata 管理员提供的管理令牌，以加密字段保存，保存后不在任何响应、日志或审计中回显明文。

提交设置时带当前 `settingsRevision`；设置冲突返回 `409`。配置保存不会自动改变插件状态：确认服务可达后，在同一插件卡片执行启用；修改设置和令牌不需要重启，每次调用都会重新读取最新值。

### 2. 验证连通性

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
