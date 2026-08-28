# 插件契约参考

Urmotiv 插件是编译进服务端的受信任代码单元。当前宿主只从 `createBuiltinPluginDefinitions()` 注册内置插件，不提供管理员上传任意 JavaScript/TypeScript 包后立即执行的能力；安装新插件需要代码审查、构建和重新部署。

## 当前清单版本

插件清单由 `@urmotiv/plugin-sdk` 的 `pluginManifestSchema` 校验：

- `id`：3–160 个字符，使用小写字母、数字和 `.`/`-` 分段，例如 `org.example.guard`。
- `name`：1–120 个字符。
- `version`：三段数字版本，可带预发布后缀，例如 `1.2.3` 或 `1.2.3-beta.1`。
- `apiVersion`：当前固定为字符串 `"1"`。
- `serverEntry`、`workerEntry`、`webEntry`：可选入口路径；当前服务端回调由内置定义绑定。
- `permissions`：最多 100 个、每个必须以该插件的 `id + "."` 开头；不能声明 Urmotiv 核心权限。
- `settingsSchema`：可选的设置表单文件名。

最小清单示例是可被当前模式解析的 JSON：

```json
{
  "id": "org.example.title-guard",
  "name": "示例标题检查",
  "version": "1.0.0",
  "apiVersion": "1",
  "serverEntry": "dist/index.js",
  "permissions": []
}
```

## 注册、启停和设置

服务启动时依次解析清单、注册回调、校验设置/审核规则，最后锁定注册表；锁定后请求处理期间不能替换回调。管理员在 `/admin` 查看当前内置插件的来源、版本、状态、设置修订号和密钥遮罩，并通过 `PATCH /api/v1/admin/plugins/:pluginId` 提交 `expectedRevision` 与 `state`/`settings`/`secrets`/`clearSecrets` 之一。没有 `plugin.manage` 的用户访问这些端点按 `404` 处理。

`enabled`/`disabled`/`failed` 是当前宿主使用的状态；`failed` 表示启动或运行校验失败，宿主不会调用该插件。`requiresRestart` 为真时，保存设置后必须重启服务；密钥原文只在写入时提交，之后页面只显示已配置和最多四个末尾字符。默认启用状态由内置定义决定（默认审核人数规则启用，外部服务和格式插件按部署配置决定）。

设置表单是受限 JSON Schema（不是任意脚本）：只允许 object、array、string、number、integer、boolean；属性名不能是 `__proto__`、`prototype` 或 `constructor`；对象最多 100 个属性、表单深度最多 12 层。每个插件自己校验运行时设置并填充默认值。

## 生命周期和受支持的回调

插件代码只在启动阶段通过 `registry.registerPluginHooks(pluginId, register)` 注册以下能力：

1. **提交前检查**：`registerBeforeSubmitCheck` 收到冻结的题目输入和 `AbortSignal`，返回 `continue`（可带审核条目）或 `block`（代码、消息和可选 JSON 详情）。管理员按顺序启用这些检查。
2. **审核条目类型**：`registerReviewItemType` 为结构化 `data` 提供运行时校验；条目可见性是 `author`、`reviewer` 或 `admin`。
3. **审核决策规则**：`registerReviewDecisionRule` 收到当前轮次快照，返回 `pending`、`approve` 或 `reject`，并只能引用当前轮次的意见/审核条目。
4. **题目包格式适配器**：`registerProblemFormatAdapter` 提供 `detect`、`inspect`、`import`、`validateExport`、`export`，用于导入导出工作流；当前内置 `hydro` 和 `fps`。

没有通用事件总线；插件不能在请求期间动态注册 HTTP 路由、直接读取数据库或更换其他插件的回调。完整的最小插件、测试和发布步骤见[插件开发指南](plugin-development.md)。

## 失败、超时和权限边界

- 清单、设置或注册回调不符合契约会使插件启动失败，不会以“忽略错误”的方式上线。
- 每个提交前检查的 `timeoutMs` 必须为 1–300,000 毫秒。超时会中止 `AbortSignal`；`failureBehavior: "block"` 返回 `plugin_check_timeout` 并阻止提交，`"continue"` 则跳过该检查继续执行。宿主按管理员顺序运行一次，不会自动重试；插件若调用外部服务，必须自己尊重信号并采用有界重试。
- 检查返回 `block` 时立即停止，之前的 `continue` 结果不能抵消明确拒绝；超时/失败的阻止策略也不能由客户端重试绕过。
- 插件权限只能是插件命名空间权限，不能获得 `problem.*`、`user.*`、`system.manage` 或其他核心权限。核心授权仍由服务端统一执行，明确拒绝永远优先于允许。
- 私密题面、题解、内部附件、令牌、密码和对象存储地址不能写入日志、审核条目或外部请求。审核条目只能保存必要的结构化结果，并绑定当前题目内容摘要和可见性。
- 管理员无权访问插件，或请求不存在的插件，统一是 `404`；不能用状态、响应时间或错误信息探测插件存在性。

## Urmotiv、Anklang 与 Fermata 的边界

Anklang 只做原题相似性检索，支持实时添加后查询，并返回查询结果。题目的查重/检查信息是 Urmotiv 的问题属性：插件可以添加，Fermata 可以读取。Anklang 不拥有 Urmotiv 的流程、审核状态、权限或最终裁决；Fermata 的建议也不替代人工审核或 Urmotiv 的状态规则。
