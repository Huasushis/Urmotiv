# 版本化 API 与契约

Urmotiv 的 HTTP API 当前版本是 `/api/v1`。请求和响应由 `@urmotiv/contracts` 中的 Zod（运行时数据校验器）模式校验；新增字段不会让客户端可以跳过既有必填字段，未知字段在严格模式下会被拒绝。除健康检查、登录入口和 OAuth 回调外，业务接口都需要浏览器会话 Cookie；机器人接口使用 `Authorization: Bearer` 令牌。

## 地址、会话和错误

如果 Web 与 API 由同一个 Compose 栈提供，浏览器请求相对地址 `/api/v1/...`；独立 API 客户端把 `http(s)://<站点>/api/v1` 作为基地址。会话请求包含 Cookie，服务端不会把会话令牌放进 JSON：

```http
GET /api/v1/session
Accept: application/json
```

未登录时的最小响应形状是：

```json
{
  "user": null,
  "auth": {
    "emailEnabled": true,
    "emailRegistrationEnabled": false,
    "ustcOAuthEnabled": false,
    "casEnabled": false,
    "demoEnabled": false
  }
}
```

错误统一包装为 `error` 对象，包含面向用户的 `message`；可能附带 `requestId` 和字段错误 `fieldErrors`。客户端应按 HTTP 状态和错误内容处理，不要把服务端栈或外部服务原始响应展示给用户。

| 状态 | 典型含义 |
| --- | --- |
| `400` | 查询参数、OAuth 登录状态或请求格式无效 |
| `401` | 没有有效会话/令牌，或登录凭据不正确 |
| `403` | 已登录但缺少明确操作权限 |
| `404` | 资源不存在，或调用者无权知道该资源存在；二者故意不可区分 |
| `409` | 修订号、审核轮次、幂等键或其他并发条件冲突 |
| `413` | 文件/题目包超过请求上限 |
| `415` | 二进制上传没有使用 `application/octet-stream` |
| `422` | JSON 通过基础解析但不符合业务字段约束 |
| `500`/`503` | 服务内部或依赖不可用；使用 `requestId` 查受控日志 |

`404` 掩码尤其适用于私有题目、文件、导出任务、插件管理和机器人任务；客户端不要根据耗时、标题列表数量或错误差异推断资源存在。

## 认证路由

| 方法与路径 | 需要 | 说明 |
| --- | --- | --- |
| `GET /api/v1/session` | 无 | 返回当前用户与已启用的登录方式 |
| `POST /api/v1/auth/email-login` | 无 | JSON `{ "email", "password" }`；成功设置 HttpOnly 会话 Cookie |
| `POST /api/v1/auth/username-login` | 无 | JSON `{ "username", "password" }`；用户名忽略大小写，root 不走此入口 |
| `POST /api/v1/auth/root-login` | 无 | 仅接受固定标识 `root`/`0` 与服务器 TTY 恢复生成的口令；成功设置 HttpOnly 会话 Cookie |
| `POST /api/v1/auth/email-register` | 无 | 仅在邮箱注册显式开启且配置投递时可用；返回验证等待状态 |
| `POST /api/v1/auth/email-verification/resend` | 无 | 重新发送验证邮件 |
| `POST /api/v1/auth/email-verification/verify` | 无 | JSON `{ "token" }`，消费一次性验证令牌 |
| `POST /api/v1/auth/logout` | 会话可选 | 撤销当前会话 |
| `GET /api/v1/auth/ustc/start?returnPath=/login` | 无 | OAuth 开始入口；会设置浏览器绑定 Cookie 并重定向到提供方 |
| `GET /api/v1/auth/ustc/callback` | OAuth Cookie | 提供方回调；生产回调 URI 必须精确为 `URMOTIV_WEB_ORIGIN` 加此路径 |
| `GET /api/v1/auth/cas/start`、`GET /api/v1/auth/cas/callback` | 无/票据 Cookie | 经典 CAS 仅在显式配置时启用，与 USTC OAuth 并行而不互相替代 |

## 健康检查

| 方法与路径 | 结果 |
| --- | --- |
| `GET /api/v1/health` | API 进程存活时返回 `200`、`status: "ok"` 和 `service: "urmotiv-api"` |
| `GET /api/v1/health/ready` | 数据库可连接时返回 `200`、`status: "ready"`；不可连接返回 `503`、`status: "unavailable"` 与 `checks.database` |

健康检查不需要登录，也不代表 bootstrap、邮件、OAuth 或外部插件已经配置。

## 题目与审核路由

题目编号在路由中使用 `:problemId`；API 会验证编号格式并再次按权限过滤。

| 方法与路径 | 说明 |
| --- | --- |
| `GET /api/v1/tags` | 读取当前公开知识点目录 |
| `GET /api/v1/problems` | 按查询条件列出调用者可见题目 |
| `POST /api/v1/problems` | 用题目草稿创建题目 |
| `GET /api/v1/problems/:problemId` | 读取当前可见修订和能力字段 |
| `PATCH /api/v1/problems/:problemId` | 带 `expectedRevision` 更新非冻结内容 |
| `POST /api/v1/problems/:problemId/frozen-fields` | 带原因修改冻结的基础题面/基础题解；需要专门权限 |
| `POST /api/v1/problems/:problemId/submit` | JSON `{ "expectedRevision": 1 }` 提交当前修订 |
| `POST /api/v1/problems/:problemId/withdraw` | 带 `expectedRevision` 和可选 `reason` 撤回 |
| `GET /api/v1/problems/:problemId/reviews` | 当前审核轮次的意见和统计 |
| `POST /api/v1/problems/:problemId/reviews` | 提交一份当前轮次人工/机器人审核意见 |
| `POST /api/v1/problems/:problemId/review-decision` | 有 `problem.status.change` 时确认最终状态 |
| `GET /api/v1/problems/:problemId/review-items` | 读取调用者有权看到的插件/机器人审核条目 |
| `GET /api/v1/problems/:problemId/review-suggestions` | 读取可应用的审核建议 |
| `POST /api/v1/problems/:problemId/review-suggestions/apply` | 按当前轮次/修订号应用选中的建议字段 |
| `POST /api/v1/problems/:problemId/similarity-check` | 只运行 Anklang 相似性查询；结果不是流程或终审决定 |
| `POST /api/v1/problems/:problemId/access-heartbeat` | 记录当前用户活动秒数 |
| `GET /api/v1/problems/:problemId/access` | 有 `problem.viewers.read` 时读取访问记录 |

创建题目的最小请求可以直接通过 `createProblemInputSchema` 校验：

```json
{
  "title": "两数之和（合成示例）",
  "type": "traditional",
  "tagIds": ["algorithm.implementation"]
}
```

题型只能是 `traditional`、`interactive` 或 `submit_answer`；题目必须至少有一个知识点。编辑题面时 `content` 可以包含 `basicStatement`、`basicSolution`、`background`、`statement`、`inputFormat`、`outputFormat`、`constraints`、`solution`、`hints`，每个 Markdown 字段最多 500,000 个字符。

### 评测配置

`judgeConfig` 使用版本 `1`：时间上限单位为毫秒（正数，最多 600,000），内存单位为 MiB（正数，最多 262,144），总分为正整数。子任务编号、数据点编号不可重复，依赖不能成环；没有子任务时，数据点分值之和必须等于总分。交互程序和答案判断程序不能同时设置。

## 文件路由

文件正文只通过二进制请求传输，文件元数据通过 JSON/查询参数传输；题面 Markdown 只保存受权限检查的站内引用。

| 方法与路径 | 说明 |
| --- | --- |
| `GET /api/v1/problems/:problemId/files` | 列出当前用户可见的文件 |
| `PUT /api/v1/problems/:problemId/files` | `application/octet-stream`；查询参数包括 `expectedRevision`、`category`、`logicalPath`、`originalName`、`mediaType`，可选 `position`、`replaceExisting`、`bindJudgeProgram` |
| `GET /api/v1/problems/:problemId/files/:fileId` | 受权限检查的私有下载；响应为文件正文 |
| `DELETE /api/v1/problems/:problemId/files/:fileId` | JSON `{ "expectedRevision": 1 }` 删除当前版本文件 |

类别包括 `statement_image`、`public_attachment`、`internal_attachment`、`testdata`、`checker`、`interactor`、`answer_checker`、`standard_solution`。逻辑路径必须是无绝对前缀、无反斜杠和无 `.`/`..` 段的相对路径。单次 API 文件路由最大请求体为 512 MiB；默认 Web nginx 还限制为 128 MiB。

## 组题方案路由

| 方法与路径 | 说明 |
| --- | --- |
| `GET /api/v1/contests` | 列出当前用户可编辑的组题方案 |
| `POST /api/v1/contests` | 创建组题方案；至少一题，题目必须为已通过状态 |
| `GET /api/v1/contests/:contestId` | 读取方案和调用者能力 |
| `PATCH /api/v1/contests/:contestId` | 带 `expectedUpdatedAt` 更新草稿；锁定后只能归档 |

创建请求的合法形状示例（题目编号 `1` 仅为合成契约值，部署时替换为实际已通过题目）：

```json
{
  "title": "春季赛组题（合成示例）",
  "description": "用于验证组题契约的安全示例。",
  "startsAt": null,
  "endsAt": null,
  "members": [
    { "userId": "0", "role": "manager" }
  ],
  "problems": [
    { "problemId": "1", "score": 100, "estimatedDifficulty": 3 }
  ]
}
```

状态为 `draft`、`locked` 或 `archived`；锁定会固定题目修订、成员和比赛信息，不能用 PATCH 替换锁定内容。

## 题目包导入导出路由

| 方法与路径 | 说明 |
| --- | --- |
| `POST /api/v1/transfer/uploads?originalName=...` | 上传二进制题目包，返回临时 `fileId`、大小、摘要、过期时间和格式检测结果 |
| `POST /api/v1/transfer/imports/preview` | JSON `{ "fileId": "00000000-0000-4000-8000-000000000001", "formatId": "hydro" }` 预览，不写入题库；`fileId` 应使用上传响应的真实 UUID |
| `POST /api/v1/transfer/imports` | 需要 `problem.import`；根据预览结果创建导入任务，服务端再次检查权限和题目包安全性 |
| `GET /api/v1/transfer/imports` | 需要 `problem.import`；非 `problem.view.all` 仅返回本人。分页读取导入历史摘要，不会返回原始文件名、请求人或不可见题目标识 |
| `GET /api/v1/transfer/imports/:jobId` | 任务本人或 `problem.view.all`；查询导入任务阶段和结果 |
| `POST /api/v1/transfer/exports` | 带题目固定修订、文件类别和幂等键创建导出任务 |
| `GET /api/v1/transfer/exports/:jobId` | 查询导出任务 |
| `GET /api/v1/transfer/exports/:jobId/download` | 成功任务的受权限检查下载 |

当前格式编号由内置插件提供：`hydro`、`fps`。上传、预览、创建任务和下载都再次执行权限/安全检查；任务响应只返回编号、状态、计数和提示，不返回题面、题解或文件正文。摘要和 UUID 应使用上传/预览响应实际返回的值，不要在客户端伪造。

## 管理和机器人路由

| 方法与路径 | 需要 | 说明 |
| --- | --- | --- |
| `GET /api/v1/me`、`PATCH /api/v1/me` | 会话 | 读取/更新自己的昵称、邮箱等资料 |
| `PUT /api/v1/me/avatar`、`DELETE /api/v1/me/avatar` | 会话 | 上传或删除自己的头像；上传为二进制，最大 512 KiB |
| `GET /api/v1/users/:userId/avatar` | 目标可见 | 受权限检查的头像下载，无头像返回 404 |
| `POST /api/v1/admin/accounts/batch` | `user.create` | Tab 分隔的批量账号文本，每批最多 100 行 |
| `GET /api/v1/admin/settings` | `system.manage` | 读取系统运行设置摘要，不返回密钥 |
| `GET /api/v1/admin/roles`、`GET /api/v1/admin/permissions` | `user.permission.manage` | 读取内置角色和权限目录 |
| `GET /api/v1/admin/service-accounts` | `service_account.manage` | 列出机器人账号摘要，不返回令牌 |
| `GET /api/v1/admin/audit` | `audit.read` | 分页读取安全审计摘要，不返回题面、密钥或原始模型响应 |
| `GET/PUT /api/v1/admin/oauth/ustc` | 人类管理员且同时具备 `system.manage`、`user.permission.manage` | 读取/更新 USTC OAuth 配置；响应只表示客户端密钥是否已配置 |
| `GET /api/v1/admin/fermata/health`、`GET/PUT /api/v1/admin/fermata/settings`、`POST /api/v1/admin/fermata/wake` | `plugin.manage` + `system.manage` | 查看和控制 Fermata 内置插件；令牌只在插件内部使用 |
| `GET /api/v1/admin/plugins` | `plugin.manage` + `system.manage` | 查看受信任内置插件状态和声明密钥是否已配置 |
| `PATCH /api/v1/admin/plugins/:pluginId` | `plugin.manage` + `system.manage` | 带 `expectedRevision` 更新状态、设置或清除已声明密钥 |
| `GET /api/v1/tag-catalog` | 已登录 | 读取公开知识点目录 |
| `GET /api/v1/admin/tag-catalog` | `tag.manage` | 查看知识点目录和版本 |
| `POST /api/v1/admin/tag-catalog/items` | `tag.manage` | 新增知识点 |
| `PATCH /api/v1/admin/tag-catalog/items/:tagId` | `tag.manage` | 更新知识点 |
| `POST /api/v1/admin/tag-catalog/items/:tagId/aliases` | `tag.manage` | 新增别名 |
| `PATCH /api/v1/admin/tag-catalog/items/:tagId/aliases/:aliasId` | `tag.manage` | 更新别名 |
| `DELETE /api/v1/admin/tag-catalog/items/:tagId/aliases/:aliasId` | `tag.manage` | 删除别名 |
| `POST /api/v1/admin/tag-catalog/items/:tagId/deactivation-preview` | `tag.manage` | 预览停用影响 |
| `POST /api/v1/admin/tag-catalog/items/:tagId/deactivate` | `tag.manage` | 确认停用 |
| `GET /api/v1/review-policy` | 已登录 | 查看当前审核策略 |
| `PATCH /api/v1/review-policy` | 策略管理权限 | 更新审核策略 |
| `GET/POST /api/v1/admin/service-accounts/:userId/tokens` | `service_account.manage` | 列出/创建机器人令牌 |
| `POST /api/v1/admin/service-accounts/:userId/tokens/:tokenId/rotate` | `service_account.manage` | 轮换并只显示一次新令牌 |
| `DELETE /api/v1/admin/service-accounts/:userId/tokens/:tokenId` | `service_account.manage` | 撤销机器人令牌 |
| `POST /api/v1/robot/review-tasks/claim` | Bearer 机器人令牌 | 领取有权限的待审任务 |
| `POST /api/v1/robot/review-tasks/:assignmentId/renew` | 同一令牌 | 在租约内续租 |
| `POST /api/v1/robot/review-tasks/:assignmentId/complete` | 同一令牌 | 提交当前修订的审核意见 |

机器人硬拒绝和权限优先级见[权限参考](permissions.md)与[管理员指南](admin-guide.md)。

## Anklang 内置适配器 API

Anklang 查询和索引是插件到独立服务的内部 API，不是公开的 Urmotiv `/api/v1` 路由。插件只接受语法上的本地/私有 `baseUrl`（无凭据、路径、查询或片段），并要求管理员显式设置 `privateContentAuthorized: true`；默认 `false`，且运行时必须有非空 `serviceToken` 插件密钥。密钥永远不会出现在管理设置响应、审核条目或日志中。

查询使用现有 Anklang `POST /api/v2/checks/similarity`（仅显式 v1 迁移配置使用 `/api/v1/checks/similarity`），只发送标题、题型、标签、基础题面和内容摘要。响应必须是严格 JSON，最多 2 MB、禁止重定向并按 `Cache-Control: no-store` 处理。插件投影为仅检索结果：候选与完成/复用状态可保存，`recommendation`、`sameProblemSuggestion`、`explanation` 等判断字段会被删除；相似候选不会产生 Urmotiv 裁决或阻止提交。`failureBehavior` 只处理无法取得配置检查的情况。`retryAttempts` 范围 1–3（默认 2），只对网络/超时/408/429/502/503/504 重试；401、409 和数据结构约束错误不重试，最终都保持 unavailable 语义而不是空成功。
成功 submit、`pending_review`/`approved` 题目的标题变更、冻结 `basicStatement` 变更，才通过注入 `ProblemService` 的窄适配器执行 `PUT /api/v1/index/problems`。索引超时 `indexTimeoutMs` 范围 1–30 秒（默认 10 秒），请求严格为：

```http
PUT /api/v1/index/problems
Authorization: Bearer <serviceToken>
Content-Type: application/json
Cache-Control: no-store
```

```json
{
  "apiVersion": "1",
  "requestId": "00000000-0000-4000-8000-000000000001",
  "externalId": "42",
  "updatedAt": "2026-08-28T00:00:00.000Z",
  "problem": { "title": "题目标题", "basicStatement": "基础题面" }
}
```

成功响应示例（`outcome` 也可以是 `updated` 或 `unchanged`）：

```json
{
  "apiVersion": "1",
  "requestId": "00000000-0000-4000-8000-000000000001",
  "source": "urmotiv",
  "externalId": "42",
  "contentHash": "0000000000000000000000000000000000000000000000000000000000000000",
  "outcome": "inserted"
}
```

409 `STALE_UPDATE` 和 503 `INDEX_UNAVAILABLE` 不会回滚 Urmotiv 已提交的本地修改。draft/rejected、solution-only、无变化和删除均无同步；插件停用、设置错误、授权为 false 或缺少密钥时不会发 HTTP 请求。

返回或保存审核条目前，Urmotiv 会移除当前题目自身候选；其他 Urmotiv 来源候选必须按当前请求用户权限查找。未知、隐藏和明确拒绝统一静默丢弃，授权候选使用当前 Urmotiv 标题并去掉 Anklang URL、`metadata`（附加信息）和判断字段；外部来源候选保留为非判断参考。过滤失败时拒绝返回/保存，不转成完整空结果。

合成 Node 24 E2E（仅本地模拟向量服务、临时 DB，端口被占用即失败且不会停止现有服务）：

```bash
ANKLANG_SOURCE_DIR=/path/to/anklang \
  pnpm --filter @urmotiv/plugin-anklang e2e:synthetic
```

详见 [Anklang 插件说明](../plugins/anklang/README.md)。

## 兼容性和升级规则

- `/api/v1` 是当前稳定路由前缀；不要依赖未列出的内部路径。删除或变更字段时应发布新的 API 版本，而不是静默改变 v1 的含义。
- `expectedRevision`、`expectedRound`、`expectedUpdatedAt`、任务摘要和幂等键是并发保护的一部分；收到 `409` 时刷新资源并重新计算请求，不能盲目重放旧正文。
- 插件清单的 `apiVersion` 当前为字符串 `"1"`；插件自己的版本使用三段数字形式。Anklang 上游查询有自己的 `"1"`/`"2"` 服务版本，不能当作 Urmotiv API 版本。
- 完整的权限作用域、私有资源掩码和题目包限制分别见[权限参考](permissions.md)和[题目包参考](problem-package.md)。
