# Anklang 接入插件

`org.ustc.urmotiv.anklang`（插件版本 `0.3.0`）是 Urmotiv 的受信任内置插件。它调用独立 Anklang 服务做原题相似性检索，并把候选与完成状态作为 Urmotiv 的审核条目参考数据；它不是流程、权限、审核状态或最终裁决的权威。

## 管理员配置与隐私闸门

插件管理端点需要核心 `plugin.manage` 权限。先在 `/api/v1/admin/plugins` 读取当前 `revision`，再用带 `expectedRevision` 的 PATCH 保存设置。令牌只从环境变量通过声明的插件密钥 `serviceToken` 提交；建议使用权限为 `0600` 的 curl cookie-jar（保存登录 Cookie 的文件）：

```bash
export URMOTIV_COOKIE_JAR=/secure/path/urmotiv.cookies
read -rsp 'Anklang service token: ' ANKLANG_SERVICE_TOKEN
printf '\n'
export ANKLANG_SERVICE_TOKEN
jq -n '{
  expectedRevision: 1,
  state: "enabled",
  settings: {
    baseUrl: "http://127.0.0.1:8730",
    apiVersion: "2",
    privateContentAuthorized: true,
    timeoutMs: 120000,
    indexTimeoutMs: 10000,
    retryAttempts: 2,
    failureBehavior: "continue",
    minimumSimilarityToShow: 0.3,
    cacheMinutes: 1440
  },
  secrets: { serviceToken: env.ANKLANG_SERVICE_TOKEN },
  clearSecrets: []
}' | curl -X PATCH "$URMOTIV_URL/api/v1/admin/plugins/org.ustc.urmotiv.anklang" \
  --cookie "$URMOTIV_COOKIE_JAR" \
  -H 'Content-Type: application/json' \
  --data-binary @-
```

`URMOTIV_COOKIE_JAR` 应指向一个权限为 `0600` 的保存登录 Cookie 的文件；不要把令牌写进 JSON 字面量、shell 历史或日志。管理响应只显示 `configured` 和遮罩后缀，绝不返回原文。

`baseUrl` 只允许语法上的本地/私有地址：`localhost`、`host.docker.internal`、回环/RFC1918/链路本地/IPv6 ULA 字面量，或不含点的单标签容器服务名。不得带账号密码、路径、查询参数或片段；公网主机名/IP 会在设置校验阶段拒绝。`privateContentAuthorized` 默认为 `false`，管理员只有在确认 Anklang 的数据库、对象存储和嵌入链路全部留在批准边界内后才能改为 `true`。未授权、缺少非空 `serviceToken`、插件停用或设置无效时，插件在发出任何请求前拒绝继续。

令牌必须在上面的经过认证的管理员请求正文中传输这一次，随后仅以加密形式静态保存，并只在运行时内存中读取；发送到 Anklang 时只出现在 `Authorization`，不会出现在设置/UI 响应、审核条目、错误、日志或缓存键中。

## 查询边界

默认查询 `POST /api/v2/checks/similarity`；明确选择旧版时才查询 `/api/v1/checks/similarity`。查询只发送 `title`、`type`、`tagIds`、`basicStatement` 和 `contentHash`，不发送基础题解、完整题解、测试数据、附件、作者/用户、权限、审核意见或 Fermata 数据。HTTP 请求禁止重定向，响应必须是严格 JSON，正文上限 2 MB，并使用 `Cache-Control: no-store`。

Anklang 的 `recommendation`、`sameProblemSuggestion`、`explanation` 等判断字段会在插件边界被丢弃。Urmotiv 保存的条目只能包含候选、完成/复用状态和必要来源数据；接受候选永远产生 `continue`，不会因为相似度或远端建议拦截提交。`failureBehavior` 只控制无法取得配置检查时的 `block`/`continue`：

- `block`：超时、网络/认证失败、契约错误或非完整结果使提交失败；
- `continue`：记录固定的 `unavailable`/`partial` 参考条目并继续提交；这些状态不伪装成“没有相似题”。

`retryAttempts` 是每个请求的最多请求次数，范围 1–3、默认 2。只有超时、网络错误、408、429、502、503、504 重试；401、409、契约/响应数据结构约束错误不重试。查询与索引同步都采用绝对超时和 2 MB 上限；查询 `timeoutMs` 范围 1–120 秒，索引 `indexTimeoutMs` 范围 1–30 秒、默认 10 秒。

完整结果允许在 `cacheMinutes` 上限内复用，只有 Anklang 明确返回 `reuse.policy=allowed` 才写本地进程缓存；`partial`/`unavailable` 或 `no-store` 不缓存，不改变已提交题目的权威状态。

## 索引同步边界

成功的 Urmotiv 本地提交之后，内置窄适配器才会尽力调用 Anklang 冻结接口 `PUT /api/v1/index/problems`。请求严格是：

```json
{
  "apiVersion": "1",
  "requestId": "00000000-0000-4000-8000-000000000001",
  "externalId": "42",
  "updatedAt": "2026-08-28T00:00:00.000Z",
  "problem": {
    "title": "题目标题",
    "basicStatement": "基础题面"
  }
}
```

响应严格包含 `apiVersion`、同一 `requestId`/`externalId`、`source: "urmotiv"`、`contentHash` 和 `outcome`；`outcome` 只能是 `"inserted"`、`"updated"` 或 `"unchanged"`。索引同步只包含 `pending_review` 或 `approved` 题目：每次成功 submit 都同步；这些状态允许的标题变化同步；管理员冻结字段路径只有 `basicStatement` 变化同步，solution-only 变化不同步。draft/rejected 的普通编辑、无变化和其他字段变化不发请求，也没有删除同步。

本地数据库提交先完成，适配器随后等待有界的尽力请求。失败、超时、401、409 或 503 都不能回滚本地成功，也不能把提交报告为失败；停用或错误配置时不会发 HTTP 请求。

## 候选权限过滤

每次手动或提交前检查结果都先移除 `source: "urmotiv"` 且 `externalId` 等于当前题目 ID 的当前题目自身候选。其他 Urmotiv 候选必须通过现有的按请求用户权限查找；未知、隐藏和明确拒绝统一静默丢弃，不计入数量/摘要，也不暴露存在性。通过查找的候选使用 Urmotiv 当前标题，并丢弃 Anklang 提供的 URL、`metadata`（附加信息）和判断字段。外部来源候选保留为参考数据，但同样不带任何判断字段。过滤、标题替换或摘要重建失败时拒绝返回/保存，绝不会变成“空结果”。

过滤发生在审核条目保存和 API 返回之前。核心的通用插件权限、机器人硬拒绝和明确拒绝优先级仍由 Urmotiv 授权系统决定；Fermata 只能读取 Urmotiv 已保存的检查属性。

## 合成 E2E

命令只启动指定的本地 Anklang 源码、回环模拟嵌入模型服务和临时数据库；它拒绝占用中的 `127.0.0.1:8730`，不会停止现有服务或调用外部模型服务。Node 24 运行：

```bash
ANKLANG_SOURCE_DIR=/path/to/anklang \
  pnpm --filter @urmotiv/plugin-anklang e2e:synthetic
```

也可复制命令参数形式：

```bash
pnpm --filter @urmotiv/plugin-anklang e2e:synthetic -- --source-dir /path/to/anklang
```

工具使用真实插件客户端完成首次写入、相同请求重放、更新标题和查询命中，最后总是终止自己创建的子进程、关闭模拟模型服务、删除临时目录。输出仅包含步骤状态，不包含题面、响应正文或令牌。
