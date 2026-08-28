# 插件开发指南

本指南面向要为 Urmotiv 增加提交前检查、审核规则或题目包格式的 TypeScript 开发者。插件是**受信任的内置代码**：当前宿主不会在运行时上传并执行任意 npm 包。开发者需要把插件放进本仓库工作区、通过类型检查和测试，并由维护者把它编译进 API/Worker 后重新部署。

## 1. 版本和清单

当前插件 SDK API 版本为字符串 `"1"`。清单由 `@urmotiv/plugin-sdk` 的 `pluginManifestSchema` 严格校验：

| 字段 | 规则 |
| --- | --- |
| `id` | 3–160 个字符；小写字母/数字分段，分隔符只能是 `.`、`-`，例如 `org.example.title-guard` |
| `name` | 1–120 个非空字符 |
| `version` | `主版本.次版本.修订号`，可带预发布后缀，例如 `1.0.0`、`1.0.0-beta.1` |
| `apiVersion` | 当前固定为字符串 `"1"`，不是数字 `1` |
| `serverEntry`/`workerEntry`/`webEntry` | 可选入口路径，每项最多 240 个字符 |
| `permissions` | 最多 100 个；每个必须以 `<id>.` 开头，不能声明任何 Urmotiv 核心权限 |
| `settingsSchema` | 可选 JSON Schema 文件名；它只描述受限设置表单，不执行代码 |

最小清单（JSON 可直接解析并通过清单模式）：

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

设置文件 `settings.schema.json` 示例（可直接解析并通过当前受限设置模式）：

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "additionalProperties": false,
  "required": ["mode"],
  "properties": {
    "mode": {
      "type": "string",
      "enum": ["report", "block"],
      "default": "report",
      "title": "检查模式"
    }
  }
}
```

注册时还会检查每个回调编号都以插件 ID 开头；例如清单 ID 是 `org.example.title-guard`，检查编号可以是 `org.example.title-guard.before-submit`，不能冒用另一个插件或核心权限的命名空间。

### 当前内置清单

| 插件 ID | 版本 | 能力 |
| --- | --- | --- |
| `org.ustc.urmotiv.review-default` | `1.0.0` | 默认审核人数决策规则 |
| `org.ustc.urmotiv.anklang` | `0.2.0` | 原题相似性检索提交前检查 |
| `org.ustc.urmotiv.fermata-control` | `0.1.0` | Fermata 管理健康/设置/唤醒接口 |
| `org.ustc.urmotiv.hydro-format` | `0.1.0` | Hydro ZIP 题目包适配器 |
| `org.ustc.urmotiv.fps-format` | `0.1.0` | FPS XML 单文件适配器 |

除默认审核人数规则外，外部服务和格式插件初始可能为停用；以 `/api/v1/admin/plugins` 返回的状态为准。

## 2. 创建、安装和启用

### 在工作区创建插件

工作区已经把 `plugins/*` 作为 pnpm workspace（工作区包集合）。可以参照 `plugins/review-default` 创建一个目录，例如：

```text
plugins/example-title-guard/
├── package.json
├── tsconfig.json
├── urmotiv-plugin.json
└── src/index.ts
```

`package.json` 的最小结构：

```json
{
  "name": "@urmotiv/plugin-example-title-guard",
  "version": "1.0.0",
  "private": true,
  "type": "module",
  "exports": {
    ".": {
      "types": "./src/index.ts",
      "import": "./src/index.ts"
    }
  },
  "scripts": {
    "build": "tsc --noEmit",
    "typecheck": "tsc --noEmit",
    "test": "vitest run"
  },
  "dependencies": {
    "@urmotiv/plugin-sdk": "workspace:*",
    "zod": "latest"
  },
  "devDependencies": {
    "@types/node": "latest",
    "typescript": "latest",
    "vitest": "latest"
  }
}
```

`tsconfig.json` 可沿用仓库其他插件的 `tsconfig.base.json` 约定；不要把生成的 `dist/` 或本地密钥提交到 Git。新增 workspace 包后运行一次 `pnpm install` 更新锁文件（锁文件变更一并提交；CI/干净环境再使用 `--frozen-lockfile`）。维护者把包加入 API 的 `createBuiltinPluginDefinitions()` 返回数组，提供 `source: "builtin:example-title-guard"` 和 `registerHooks`，然后重建 API/Worker 镜像；这一步是当前宿主的“安装”，不是 Web 上传。

### 在管理员界面启用

重部署并初始化插件记录后，具有 `plugin.manage` 的管理员打开 `/admin`，确认插件的 ID、版本和 `requiresRestart`，再使用启用操作。HTTP 等价请求是：

```http
PATCH /api/v1/admin/plugins/org.example.title-guard
Content-Type: application/json

{"expectedRevision":1,"state":"enabled"}
```

请求必须至少修改 `state`、`settings`、`secrets` 或 `clearSecrets` 之一；`expectedRevision` 不匹配返回 `409`，插件不存在或调用者无管理权限按 `404` 返回。禁用时把 `state` 改为 `"disabled"`。禁用插件的提交前检查、审核规则和题目包格式都不会被宿主选用；重新启用后才会进入下一次调用。

### 设置和密钥

如果插件声明 `settingsSchema`，管理员在 `/admin` 的插件卡片填写设置；宿主先用受限表单模式解析，再由插件运行时 Zod 模式复核并填默认值。`settings` 必须是 JSON 对象，值只能是 JSON 值。需要外部服务令牌时在内置定义中声明 `secretDefinitions`（名称只能匹配 `[A-Za-z][A-Za-z0-9_.-]*`），管理员只提交密钥原文一次；宿主用 `URMOTIV_PLUGIN_SECRET_KEY` 加密保存，页面只显示已配置和最多四个末尾字符。

插件只能读取**自己声明的、自己命名空间的一个密钥**，没有列出其他密钥的 API，也不能读取数据库、会话 Cookie、密码或其他插件的设置。密钥存储不可用时插件启动/调用失败，不应回退到日志或硬编码值。

## 3. SDK 生命周期、钩子和数据

注册只在 API/Worker 启动期间进行，随后注册表锁定；请求处理时不能替换回调。`PluginRegistry` 提供四种注册能力：

### 提交前检查

```ts
import type { PluginRegistry } from "@urmotiv/plugin-sdk";

export function registerExamplePlugin(registry: PluginRegistry): void {
  registry.registerBeforeSubmitCheck({
    id: "org.example.title-guard.before-submit",
    displayName: "示例标题检查",
    timeoutMs: 1_000,
    failureBehavior: "block",
    run(input, { signal }) {
      if (signal.aborted) {
        return {
          decision: "block",
          code: "example_cancelled",
          message: "检查已取消，题目尚未提交。"
        };
      }
      if (input.problem.title.includes("禁止")) {
        return {
          decision: "block",
          code: "example_title_blocked",
          message: "题目标题需要修改。"
        };
      }
      return { decision: "continue" };
    }
  });
}
```

`BeforeSubmitInput` 包含 `problemId`、正整数 `revision`/`reviewRound`、64 位小写内容摘要和题目的 `title`、`type`、`tagIds`、基础题面/题解。输入会深度冻结，插件不能原地修改。`run` 必须返回下列之一：

- `{ decision: "continue" }`，或带最多 100 条审核条目的 `reviewItems`；
- `{ decision: "block", code, message, details? }`，`code` 只能使用小写字母、数字、点、下划线和连字符。

检查应尽早响应 `AbortSignal`，不要把基础题解、内部附件或外部服务原始响应复制到日志/审核条目。

### 审核条目类型

```ts
import { z } from "zod";

registry.registerReviewItemType({
  type: "org.example.title-guard.note",
  displayName: "示例检查详情",
  dataSchema: z.object({ matched: z.boolean() }).strict()
});
```

条目输入还需要 `visibility`（`author`、`reviewer` 或 `admin`）、非空 `summary`、JSON `data` 和当前题目内容摘要；可选 `expiresAt` 必须是日期时间。服务端再次校验类型、摘要和可见性，旧修订条目不会进入新轮次。

### 审核决策规则

```ts
import type { ReviewDecisionRule, ReviewRoundSnapshot } from "@urmotiv/plugin-sdk";

const exampleRuleSettingsSchema = z
  .object({ required: z.number().int().min(1).default(1) })
  .strict();
type ExampleRuleSettings = z.infer<typeof exampleRuleSettingsSchema>;

const exampleRule: ReviewDecisionRule<ExampleRuleSettings> = {
  id: "org.example.title-guard.rule",
  displayName: "示例审核规则",
  supportedReviewItemTypes: ["org.example.title-guard.note"],
  settingsSchema: exampleRuleSettingsSchema,
  evaluate(snapshot: ReviewRoundSnapshot, settings: ExampleRuleSettings) {
    const approvals = snapshot.opinions.filter((opinion) => opinion.verdict === "approve");
    return {
      decision: approvals.length >= settings.required ? "approve" : "pending",
      usedOpinionIds: approvals.map((opinion) => opinion.id),
      usedReviewItemIds: [],
      reason: "示例规则按当前轮次的通过意见计数。"
    };
  }
};

registry.registerReviewDecisionRule(exampleRule);
```

`ReviewRoundSnapshot` 只包含当前轮次的意见、审核条目和内容摘要。决策只能引用当前轮次的意见 ID，以及该规则声明支持、摘要匹配且未过期的审核条目 ID；旧轮次或未声明类型会被拒绝。意见来源可能是 `human`、`anklang`、`fermata` 或 `plugin`，但规则仍不能绕过 Urmotiv 的状态权限。

### 题目包格式适配器

格式插件调用 `registerProblemFormatAdapter`，提供 `id`、`displayName`、`version` 和五个函数：`detect(ArchiveSummary)`、`inspect(SafeArchive)`、`import(SafeArchive, ImportChoices)`、`validateExport(CanonicalProblem, ExportOptions)`、`export(CanonicalProblem, ExportOptions)`。返回 ZIP 时列出安全相对路径和 `Uint8Array`；单文件格式必须明确 `inputKind: "single_file"`。Worker 在写出前会再次检查路径、大小和压缩包安全。

## 4. 权限、拒绝优先级和隐私边界

插件清单的 `permissions` 只是插件自己声明的命名空间能力，不是对 Urmotiv 核心权限的申请。插件不能声明或授予 `auth.login`、`problem.*`、`user.*`、`system.manage`、`plugin.manage` 等核心权限；服务端的用户权限检查仍然优先。

对同一对象的权限判断遵循：账号停用/无 `auth.login` 先拒绝；任何匹配的明确拒绝优先于允许；全局拒绝优先于对象允许；`own` 只匹配所有者；过期授权不匹配；机器人账号的硬拒绝不可被角色、插件或令牌解除。插件不能把 `continue` 当作授予访问权，也不能把审核条目当作公开题面。

插件应遵守这些边界：

- 不读取或记录密码、会话 Cookie、Bearer 令牌、客户端密钥、对象存储真实地址、内部附件和未授权题面。
- 外部 HTTP 只发送完成任务所需的最小、已获授权字段；设置超时，使用 `AbortSignal`，限制响应大小，不把原始响应写入错误消息。
- 公开附件、内部附件、测试数据、标准程序和评测程序按题目文件权限处理；题面 Markdown 只引用受权限检查的站内文件地址。
- Anklang 只做原题相似性检索，支持实时添加后查询并返回查询结果。题目的查重/检查信息属于 Urmotiv 问题属性，插件可以添加，Fermata 可以读取；Anklang 不是流程、审核状态、权限或最终裁决的权威。

## 5. 错误、超时、重试和“不存在”

### 启动和输入错误

清单字段、注册编号、设置表单、审核条目或决策返回值不符合模式时，注册/调用会失败；不要捕获后当作成功。重复注册、跨插件编号和注册表锁定后的修改会抛出 `PluginRegistryError`。管理员设置错误会以 `422` 级配置错误返回，版本冲突是 `409`。

### 检查超时和取消

`timeoutMs` 范围为 1–300,000 毫秒。宿主用 `AbortController` 中止超时检查：

- `failureBehavior: "block"` → 返回 `plugin_check_timeout`，题目不会提交；
- `failureBehavior: "continue"` → 丢弃该检查的结果，继续后续检查；
- 上游请求被取消 → 返回 `submission_cancelled`。

宿主按管理员配置顺序逐个调用一次，不自动重试；插件自己的外部请求若重试，必须有次数/总时长上限、尊重信号，并避免重复写入。后续检查返回明确 `block` 时，之前的 `continue` 和审核条目都不能抵消拒绝。

### 资源不存在与权限掩码

`TrustedPluginHost` 找不到插件、插件未启用或版本/清单摘要与数据库记录不一致时，插件不可调用。`GET /api/v1/admin/plugins` 和 `PATCH /api/v1/admin/plugins/:pluginId` 对没有 `plugin.manage` 的用户统一返回 `404`，不泄露插件存在性；导入导出任务、题目和文件同样把无权访问按 `404` 处理。插件错误消息不能通过标题、文件名、计数、耗时或外部原文泄露被掩码资源。

## 6. 可运行的最小插件和测试

将上一节的 `registerExamplePlugin` 保存为 `src/index.ts`，将清单保存为 `urmotiv-plugin.json`，然后由维护者在 API 内置定义中绑定：

```ts
import manifest from "./urmotiv-plugin.json" with { type: "json" };
import { registerExamplePlugin } from "@urmotiv/plugin-example-title-guard";

{
  source: "builtin:example-title-guard",
  initialState: "disabled",
  requiresRestart: false,
  manifest,
  registerHooks: registerExamplePlugin
}
```

如果当前 TypeScript 配置不允许 JSON import，也可以在内置定义中写入与清单相同的对象；关键约束是 `source` 必须以 `builtin:` 开头，注册函数只能在启动阶段执行。测试不需要数据库，可以直接锁定注册表并运行一次通过和一次阻止：

```ts
import { describe, expect, it } from "vitest";
import { PluginRegistry } from "@urmotiv/plugin-sdk";
import { registerExamplePlugin } from "../src/index";

const manifest = {
  id: "org.example.title-guard",
  name: "示例标题检查",
  version: "1.0.0",
  apiVersion: "1",
  serverEntry: "dist/index.js",
  permissions: []
} as const;

function input(title: string) {
  return {
    problemId: "synthetic-problem",
    revision: 1,
    reviewRound: 1,
    contentHash: "0".repeat(64),
    problem: {
      title,
      type: "traditional" as const,
      tagIds: ["algorithm.implementation"],
      basicStatement: "合成题面",
      basicSolution: null
    }
  };
}

describe("example title guard", () => {
  it("continues for a safe title", async () => {
    const registry = new PluginRegistry();
    registry.registerPluginManifest(manifest);
    registry.registerPluginHooks(manifest.id, () => registerExamplePlugin(registry));
    registry.lock();
    await expect(
      registry.runBeforeSubmit(input("合成示例"), ["org.example.title-guard.before-submit"])
    ).resolves.toEqual({ decision: "continue" });
  });

  it("blocks the configured title", async () => {
    const registry = new PluginRegistry();
    registry.registerPluginManifest(manifest);
    registry.registerPluginHooks(manifest.id, () => registerExamplePlugin(registry));
    registry.lock();
    await expect(
      registry.runBeforeSubmit(input("禁止标题"), ["org.example.title-guard.before-submit"])
    ).resolves.toMatchObject({ decision: "block", code: "example_title_blocked" });
  });
});
```

在插件目录运行，不要把凭据带入命令行：

```bash
pnpm install
pnpm --filter @urmotiv/plugin-example-title-guard typecheck
pnpm --filter @urmotiv/plugin-example-title-guard test
```

测试重点应覆盖模式拒绝、`AbortSignal` 取消、超时策略、明确拒绝优先、旧轮次条目过滤和外部服务不可用；不应断言日志文字或数据库内部实现。

## 7. 调试与发布清单

调试时使用合成题目、合成 URL 和本地假响应；日志只能记录插件 ID、版本、固定错误编号、耗时和请求 ID，不能记录密钥、题面、题解、令牌或上游响应正文。管理员在 `/admin` 查看状态和设置修订；API 健康检查只证明进程/数据库可用，不证明外部服务或插件配置正确。

发布前逐项确认：

1. `urmotiv-plugin.json` 通过清单模式，版本和 `apiVersion: "1"` 正确，所有注册编号以插件 ID 开头。
2. 所有设置和审核条目有严格运行时模式；外部调用有超时、取消和有界重试。
3. 插件不声明核心权限，不读取跨插件密钥/数据库，不绕过题目文件可见性。
4. 最小测试、插件包 typecheck/build 和 API/Worker 构建通过；插件进入 `createBuiltinPluginDefinitions()` 并由代码审查批准。Docker 镜像依赖阶段使用显式插件清单，新增包还必须在 `Dockerfile.api` 和 `Dockerfile.worker` 的依赖复制列表中登记 `package.json`，否则干净构建不会安装该包。
5. 在隔离环境先安装/启用/停用/设置更新，确认 `settingsRevision` 冲突和 `requiresRestart` 行为，再发布镜像并按[部署指南](deployment.md)升级。
6. 更新插件版本或清单后，旧数据库记录不能被静默当作新代码；宿主会比较版本、API 版本、来源和清单摘要，不一致时保持不可用。
