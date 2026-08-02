# 插件开发教程

本文是 [插件规范](plugins.md) 的配套教程，面向"要动手写一个插件"的开发者：具体要建哪些文件、调用哪些
真实接口、一个插件从写完代码到真正跑起来要经过哪几步。插件的设计原则、安全边界和各钩子的业务含义以
plugins.md 为准，本文不重复那些内容，只在需要时引用它。本文所有字段名、函数签名和错误文案都对照当前
仓库源码核实；如果本文与真实代码不一致，请以源码为准——这说明代码已经变化，本文该更新了。

## 1. 你能写的是哪一种插件

plugins.md 把插件分成两类：随主仓库发布的**内置插件**，和管理员从本地包安装、记录来源和版本的**受信任
插件**。但读一遍 `apps/api/src/plugin-host.ts` 就会发现，`TrustedPluginHost` 的构造函数目前只接受
`source` 字段以 `builtin:` 开头的定义，别的一律拒绝并抛出：

> 插件宿主只接受随服务发布的内置插件，不会加载外部代码。

也就是说，**当前能写、能跑的只有内置插件**：插件代码是这个仓库里的一个工作区包，被 `apps/api` 用普通
TypeScript `import` 编译进服务器一起启动。不存在"管理员上传一个包、重启后生效"的动态加载机制——清单里
的 `serverEntry` 字段目前也没有任何代码会真的去 `require`/`import` 它，纯粹是给人看的说明性路径。本文
教的就是这一种：写一个工作区包，然后把它接进服务器。

再提前说明两处后面会反复用到的现状，避免你以为是自己漏看了什么：

- **没有运行时"卸载"操作**：内置插件的状态只有"启用/停用/失败"三种（`enabled`/`disabled`/`failed`），
  没有第四种"已卸载"。因为插件代码是编译进服务器的，真正的"卸载"等于把这条注册从代码里删掉、重新构建
  部署，不是管理员在页面上点一下就能做到的运行时操作。plugins.md 里提到的"卸载"，实际含义都是这种
  代码级别的移除。
- **管理后台还没有自动生成的设置表单**：plugins.md 第 7 节描述的"JSON Schema 生成受控表单"目前只实现
  了后一半——服务端会校验 JSON Schema（第 7 节详述），但 `apps/web` 里还没有任何页面根据这份 Schema
  画出输入框；管理员今天只能直接调 `PATCH /api/v1/admin/plugins/:pluginId` 传 JSON。

仓库里已经有三个内置插件可以直接读源码：`plugins/review-default/`（最简单，一个审核决定规则）、
`plugins/anklang/`（进阶，一个提交前检查 + 审核条目类型 + 缓存 + 外部服务调用）、
`plugins/hydro-format/`（一个完整的题目包格式适配器）。本文会反复引用前两个，第三个在第 6.3 节提到。

## 2. 插件目录长什么样

以最简单的 `plugins/review-default/` 为例，一个插件包是这样一套文件：

```text
plugins/review-default/
  package.json
  urmotiv-plugin.json
  settings.schema.json
  src/index.ts
  test/review-rule.test.ts
  tsconfig.json
  README.md
```

逐个说明：

**package.json**——普通的工作区包描述，不发布到公共 npm：

```json
{
  "name": "@urmotiv/plugin-review-default",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "exports": { ".": { "types": "./src/index.ts", "import": "./src/index.ts" } },
  "scripts": { "build": "tsc --noEmit", "typecheck": "tsc --noEmit", "test": "vitest run" },
  "dependencies": { "@urmotiv/plugin-sdk": "workspace:*", "zod": "latest" },
  "devDependencies": { "@types/node": "latest", "typescript": "latest", "vitest": "latest" }
}
```

注意 `exports` 直接指向 `src/index.ts` 源码，`build`/`typecheck` 脚本都只是 `tsc --noEmit`（只做类型
检查，不产出任何文件）。这意味着**这个包目前根本不会产出 `dist/index.js`**，尽管它自己的清单里
`serverEntry` 写的是 `dist/index.js`。原因见第 1 节：真正跑起来靠的是 `apps/api` 直接 `import` 这个包
的 TypeScript 源码（第 5 节展开），`serverEntry` 目前只是声明性字段，不需要你真的去配一套构建流程产出
它指向的文件。

仓库根目录的 `pnpm-workspace.yaml` 已经把 `plugins/*` 纳入工作区扫描范围：

```yaml
packages:
  - apps/*
  - packages/*
  - plugins/*
```

所以新建一个 `plugins/<你的插件名>/package.json` 会被自动识别为工作区包，不需要改这份配置。

**urmotiv-plugin.json**——清单文件，只描述插件，不执行代码。第 3 节逐字段讲解。

**settings.schema.json**——一份 JSON Schema（描述字段类型、必填项和限制的普通 JSON 文件，本身不是代码）。
这是给"设置"用的，第 7 节讲这条链路具体怎么走。

**src/index.ts**——真正的逻辑：定义你的检查/规则/条目类型，并导出一个 `register*(registry)` 函数，供
服务器在启动时调用它去注册钩子。

**test/**——用 vitest 写的单测，第 11 节讲测试要求。

**tsconfig.json**：

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": { "noEmit": true, "types": ["node"] },
  "include": ["src/**/*.ts", "test/**/*.ts"]
}
```

继承仓库根目录的 `tsconfig.base.json`，和其他工作区包写法一致。

**README.md**——用大白话说明插件做什么、数据流向哪里、需要什么权限、修改设置有什么影响、失败会怎样、
禁用/卸载后数据会怎样。这是 plugins.md 第 11 节明确要求的交付物，`review-default` 和 `anklang` 的
README 都是照这个提纲写的，直接参考即可。

## 3. 清单文件（urmotiv-plugin.json）字段详解

清单会被 `@urmotiv/plugin-sdk` 里的 `pluginManifestSchema` 校验（`.strict()`，意味着出现任何未列出的
字段都会直接报错，不会被静默忽略）：

```ts
export const pluginManifestSchema = z.object({
  id: pluginIdSchema,
  name: z.string().trim().min(1).max(120),
  version: z.string().regex(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/),
  apiVersion: z.literal("1"),
  serverEntry: z.string().min(1).max(240).optional(),
  workerEntry: z.string().min(1).max(240).optional(),
  webEntry: z.string().min(1).max(240).optional(),
  permissions: z.array(pluginIdSchema).max(100).default([]),
  settingsSchema: z.string().min(1).max(240).optional()
}).strict();
```

| 字段 | 说明 |
| --- | --- |
| `id` | 稳定编号，正则 `^[a-z0-9]+(?:[.-][a-z0-9]+)+$`，长度 3–160。只能用小写字母、数字，以 `.` 或 `-` 分隔，且至少要有一个分隔符（不能是单个词）。约定用域名倒序，如 `org.ustc.urmotiv.anklang`；没有域名也可以用组织前缀，只要保证全局唯一。界面显示的是 `name`，`id` 只是程序内部编号，不会给普通用户看。 |
| `name` | 1–120 字符的中文/易懂名称。 |
| `version` | 标准 semver，允许预发布后缀（如 `1.0.0-beta.1`）。 |
| `apiVersion` | 目前唯一合法值是字面量 `"1"`（`@urmotiv/plugin-sdk` 导出的 `pluginApiVersion` 常量），写别的值清单直接校验失败。 |
| `serverEntry` / `workerEntry` / `webEntry` | 可选字符串（1–240 字符），分别声明服务端、后台任务、前端扩展代码入口路径。**现状**：这三个字段目前都只是声明性的——`TrustedPluginHost` 不会读取它们做任何动态加载；`webEntry` 对应的"前端扩展位渲染"机制在 `apps/web` 里还没有实现；`workerEntry` 对应的"插件自己的后台任务类型"在 `PluginRegistry` 里也没有对应的注册方法（详见第 6.4 节）。写这两个字段目前更多是把设计意图留在清单里，不代表功能已经存在。 |
| `permissions` | 字符串数组，每一项也要满足 `pluginIdSchema`。`registerPluginManifest` 会做两条强制检查（见 `packages/plugin-sdk/src/registry.ts`）：① 不能和任何核心权限（`@urmotiv/contracts` 的 `corePermissions`，如 `problem.review`、`system.manage`）同名，否则抛 `PluginRegistryError`："插件不能声明核心权限 ...。"；② 必须以 `${插件id}.` 开头，否则抛"插件权限 ... 必须以 ... 开头，表明它属于这个插件。"第 9 节详细讲权限。 |
| `settingsSchema` | 可选字符串，指向本插件目录下的 JSON Schema 文件名（约定 `settings.schema.json`）。**注意**：这只是清单里的一个"文件名"，服务器目前不会自动去读取这个路径——真正会被校验的 JSON Schema 内容，是接线时（第 5 节）以内联对象的形式再写一遍。 |

## 4. 从零写一个最小审核规则插件

这一节完整走一遍写一个插件包的过程：注册一个 `ReviewDecisionRule`（审核决定规则），读取自己的设置，
返回一个决定。这个钩子的意思是：给定当前审核轮次里的意见快照，判断题目应该"继续等待"、"通过"还是
"不通过"。

我们写一个比默认规则更简单的"一票否决"规则：只要有人给了不通过意见就直接判不通过；没有不通过意见、且
通过票数达到设置里的门槛，就判通过；否则继续等待。插件 id 沿用 plugins.md 里自己举的例子
`org.example.review-rule`，这样和规范文档能对上。

先看 `packages/plugin-sdk/src/types.ts` 里这个钩子的真实类型：

```ts
export interface ReviewDecisionRule<TSettings> {
  readonly id: string;
  readonly displayName: string;
  readonly supportedReviewItemTypes: readonly string[];
  readonly settingsSchema: z.ZodType<TSettings>;
  evaluate(input: ReviewRoundSnapshot, settings: TSettings): Promise<ReviewDecision> | ReviewDecision;
}
```

`ReviewRoundSnapshot` 里的 `opinions` 字段，在真正通过 `registry.evaluateReviewDecision(...)` 调用时，
已经被核心预处理过——只保留当前轮次、每位审题人只留最新一条、并且已经排除了"当前已无审核权限"的审题人
（见 `registry.ts` 的 `latestEligibleOpinions`）。所以下面这个 `evaluate` 不需要自己再做一遍轮次/去重/
权限过滤，直接按 `verdict` 计数即可。（如果你担心这个函数将来被脱离 registry 单独调用——比如写单测时
直接 `import` 后调用——那就应该像 `review-default` 的 `latestUsableOpinions` 那样自己重新过滤一遍，
不依赖调用方帮你把关。）

每条 `opinion` 还固定包含 `codeforcesDifficulty`、`qualityLevel`、`thinkingLevel`、`codingLevel`、
`tagIds` 和 `improvements`。插件可以把质量、难度或知识点门槛写进自己的 `settingsSchema`，由管理员选择
这条规则并保存设置，再在 `evaluate` 中读取这些公开结构化字段。`privateNote`、题目名称、题面、题解和附件不在
快照中；输入经过 `.strict()` 校验并在调用前冻结，插件也不能在判断过程中改写它。

`plugins/example-review-rule/src/index.ts`：

```ts
import type { PluginRegistry, ReviewDecisionRule, ReviewRoundSnapshot } from "@urmotiv/plugin-sdk";
import { z } from "zod";

export const exampleReviewRuleId = "org.example.review-rule.veto";

export const exampleReviewRuleSettingsSchema = z
  .object({
    requiredApprovals: z.number().int().min(1).max(20).default(2)
  })
  .strict();

export type ExampleReviewRuleSettings = z.infer<typeof exampleReviewRuleSettingsSchema>;

export const exampleReviewDecisionRule: ReviewDecisionRule<ExampleReviewRuleSettings> = {
  id: exampleReviewRuleId,
  displayName: "示例：一票否决审核规则",
  supportedReviewItemTypes: [],
  settingsSchema: exampleReviewRuleSettingsSchema,

  evaluate(input: ReviewRoundSnapshot, settings: ExampleReviewRuleSettings) {
    const rejections = input.opinions.filter((opinion) => opinion.verdict === "reject");
    const approvals = input.opinions.filter((opinion) => opinion.verdict === "approve");

    if (rejections.length > 0) {
      return {
        decision: "reject",
        usedOpinionIds: rejections.map((opinion) => opinion.id),
        usedReviewItemIds: [],
        reason: `有 ${rejections.length} 份不通过意见，一票否决。`
      };
    }

    if (approvals.length >= settings.requiredApprovals) {
      return {
        decision: "approve",
        usedOpinionIds: approvals.map((opinion) => opinion.id),
        usedReviewItemIds: [],
        reason: `已有 ${approvals.length} 份通过意见，达到所需的 ${settings.requiredApprovals} 份。`
      };
    }

    return {
      decision: "pending",
      usedOpinionIds: input.opinions.map((opinion) => opinion.id),
      usedReviewItemIds: [],
      reason: `目前有 ${approvals.length} 份通过意见，还需要达到 ${settings.requiredApprovals} 份。`
    };
  }
};

export function registerExampleReviewRule(registry: PluginRegistry): void {
  registry.registerReviewDecisionRule(exampleReviewDecisionRule);
}
```

几个必须遵守的地方（都是 `PluginRegistry.registerReviewDecisionRule`/`evaluateReviewDecision` 真实做的
校验，写错了会在注册或调用时直接抛错，不是风格建议）：

- `decision` 只能是 `"pending" | "approve" | "reject"`；`reason` 必须是 1–2000 字符的非空文本。
- `usedOpinionIds` 里的每个 id 都必须来自 `input.opinions`（也就是当前轮次、去重、仍有权限的那些）；
  引用一个旧轮次或已经无权限的意见 id，会被拒绝并抛"审核规则引用了旧轮次或已失效的意见。"
- `usedReviewItemIds` 只能引用 `supportedReviewItemTypes` 里声明过的条目类型；这个例子不使用审核条目，
  声明了空数组，所以 `usedReviewItemIds` 必须永远是 `[]`。
- 返回对象里不能多写字段——`reviewDecisionSchema` 是 `.strict()` 的。

配套的 `urmotiv-plugin.json`、`settings.schema.json`、`package.json`、`tsconfig.json` 照抄第 2、3 节的
`review-default` 写法，把 `id` 换成 `org.example.review-rule`、包名换成
`@urmotiv/plugin-example-review-rule` 即可，这里不重复贴。测试写法参考第 11 节。

写完这些文件，这个插件**还不会运行**——下一节把它接进服务器。

## 5. 把插件接进服务器

`apps/api/src/builtin-plugins.ts` 导出的 `createBuiltinPluginDefinitions()` 返回一个
`TrustedPluginDefinition[]`，这是服务器唯一认识的插件清单来源。`TrustedPluginHost` 的构造函数会依次对
每一项做这几件事（见 `apps/api/src/plugin-host.ts`）：

1. 检查 `source` 是否以 `builtin:` 开头，不是就整个拒绝启动；
2. 用 `pluginManifestSchema` 校验 `manifest`，登记进 registry；
3. 如果这条定义带了 `registerHooks`，调用
   `registry.registerPluginHooks(manifest.id, () => definition.registerHooks(registry))`——这一步顺带
   保证你在 `registerHooks` 里只能注册以 `${manifest.id}.` 开头的钩子编号，想注册别的插件的编号会直接
   抛"不属于自己的钩子"；
4. 记下清单和（如果有的）`settingsSchema`；
5. 所有定义处理完之后统一调用一次 `registry.lock()`，此后任何 `register*` 调用都会失败。

给第 4 节写的插件接线，需要两步：

**第一步**，在 `apps/api/package.json` 的 `dependencies` 里加一行工作区依赖（照着已有的
`@urmotiv/plugin-anklang` 依赖抄）：

```json
"@urmotiv/plugin-example-review-rule": "workspace:*",
```

**第二步**，在 `createBuiltinPluginDefinitions()` 返回的数组里追加一项：

```ts
import { registerExampleReviewRule } from "@urmotiv/plugin-example-review-rule";

// ……在 createBuiltinPluginDefinitions() 的返回数组里追加：
{
  source: "builtin:example-review-rule",
  manifest: {
    id: "org.example.review-rule",
    name: "示例插件：一票否决审核规则",
    version: "1.0.0",
    apiVersion: "1",
    serverEntry: "dist/index.js",
    permissions: [],
    settingsSchema: "settings.schema.json"
  },
  settingsSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      requiredApprovals: { type: "integer", minimum: 1, maximum: 20, default: 2 }
    }
  },
  registerHooks: registerExampleReviewRule
}
```

这里直接把插件包导出的注册函数传给 `registerHooks`。这跟 anklang 的写法不一样——`builtin-plugins.ts`
里 anklang 那条用的是 `createAnklangHookRegistrar(runtime)`，一个返回注册函数的工厂，而不是直接传导出的
函数。原因是两类钩子拿设置的方式不同：

- `ReviewDecisionRule.evaluate(input, settings)` 里 `settings` 是调用方传进来的参数——谁调用
  `evaluateReviewDecision(ruleId, snapshot, settings)`，就负责读好当前设置再传进去。规则本身不用关心
  设置从哪来，所以 `registerExampleReviewRule(registry)` 只需要 `registry` 一个参数。
- `BeforeSubmitCheck.run(input, context)` 的签名里根本没有 `settings` 参数（`context` 只有一个
  `signal`）。检查自己必须在 `run` 内部去读当前设置和密钥，这就要求 `registerHooks` 在注册时提前拿到
  一个能读设置/密钥/缓存的"运行时"对象，闭包捕获它——这正是第 7 节要讲的 `AnklangHookRuntime` 模式。

**这一步做完之后，规则会不会真的决定审核结果？** 会。内置插件和管理员启用的受信任插件通过
`registerHooks` 把规则登记到运行中的 registry；提交或修改意见后，API 会调用
`TrustedPluginHost.evaluateReviewDecision(...)`，并在同一事务内保存意见和可能发生的状态变化。每个审核
轮次在提交题目时固定规则编号、插件版本和设置，之后修改全局策略不会偷偷改变正在进行的轮次。插件停用、超时、
抛错或返回畸形结果时，本次意见和状态变化一起回滚，并向调用者返回固定的“审核规则不可用”错误。

## 6. 其余几类钩子的最小示例

`PluginRegistry` 一共提供五个 `register*` 方法（`packages/plugin-sdk/src/registry.ts`）：
`registerBeforeSubmitCheck`、`registerReviewItemType`、`registerReviewDecisionRule`（第 4 节已经讲过）、
`registerProblemFormatAdapter`，以及不产生业务钩子、只登记插件本身的 `registerPluginManifest`。接线方式
都和第 5 节一样：写好之后在 `builtin-plugins.ts` 里通过 `registerHooks` 传进去。

### 6.1 提交前检查（beforeSubmit check）

用于"提交题目前要不要挡下来"这类判断，核心权限、字段、状态检查通过后，写入待审核状态前运行。适合做
同步、不依赖外部服务的规则性检查；如果要调用外部服务、需要支持超时和取消，参考 `plugins/anklang/src/index.ts`
的写法（`run(input, context)` 用 `context.signal` 传播取消）。

```ts
registry.registerBeforeSubmitCheck({
  id: "org.example.review-rule.title-guard",
  displayName: "标题禁用词检查",
  timeoutMs: 2_000,
  failureBehavior: "continue",
  run(input) {
    const bannedWords = ["测试勿用"];
    const hit = bannedWords.find((word) => input.problem.title.includes(word));
    if (hit !== undefined) {
      return {
        decision: "block",
        code: "title_banned_word",
        message: `标题包含禁用词"${hit}"，请修改后再提交。`
      };
    }
    return { decision: "continue" };
  }
});
```

`id`、`displayName`、`timeoutMs`（1–300000 毫秒）、`failureBehavior`（`"block"` 或 `"continue"`）都会被
`registerBeforeSubmitCheck` 校验；`run` 必须是函数，否则直接抛错。第 8 节详细讲这个钩子的调用语义。

### 6.2 审核条目类型（review item type）

用于把某种检查/分析的结果，登记成一种独立的"审核条目"结构，供审核页展示、供审核规则读取：

```ts
registry.registerReviewItemType({
  type: "org.example.review-rule.note",
  displayName: "示例说明",
  dataSchema: z.object({ message: z.string().min(1).max(500) }).strict()
});
```

`dataSchema` 是一个 Zod 类型（`zod` 是这个项目里到处使用的运行时数据校验库：先用 TypeScript 写出想要的
结构，再用 `.parse()` 在运行时真正校验一遍数据是否符合）。注意 plugins.md 强调过的边界：审核规则只能读
取自己在 `supportedReviewItemTypes` 里显式声明支持的条目类型，不能把任意插件产生的文本当作通过票——
`registry.evaluateReviewDecision` 会按这个规则过滤 `reviewItems`，规则代码里读不到没声明支持的类型。

### 6.3 题目包格式适配器（problem format adapter）

用于让某种 OJ 的题目包格式可以被导入/导出，接口定义在 [problem-package.md](problem-package.md)：

```ts
interface ProblemFormatAdapter {
  id: string;
  displayName: string;
  version: string;
  inputKind?: "zip" | "single_file";
  detect(input: ArchiveSummary): Promise<DetectionResult>;
  inspect(input: SafeArchive): Promise<ImportPreview>;
  import(input: SafeArchive, choices: ImportChoices): Promise<CanonicalProblem>;
  validateExport(problem: CanonicalProblem, options: ExportOptions): Promise<LossReport>;
  export(problem: CanonicalProblem, options: ExportOptions): Promise<GeneratedArchive>;
}
```

`inputKind` 说明导入文件是 ZIP，还是一个未经压缩的原始文件。旧插件没有填写时按 ZIP 处理；
原始单文件插件必须明确填写 `single_file`，当前只接受 `.xml`。核心会在识别、预览和后台导入时
重复核对，插件不能把 ZIP 内的同名文件当成原始 XML。

`GeneratedArchive` 也要明确填写 `kind`。ZIP 结果使用 `kind: "zip"` 和 `files`；
原始 XML 使用 `kind: "single_file"` 和 `content`。单题原始 XML 会直接下载，多题时作为外层 ZIP
里的普通文件，不能与 ZIP 结果混在同一次导出中。已经安装的第一版插件若只返回 `files`，
运行时仍按 ZIP 处理；新代码应明确填写，避免含义不清。

注册方式一样：

```ts
registry.registerProblemFormatAdapter(myFormatAdapter);
```

这段是注册接口的目标用法，不代表现有 Hydro 适配器已经这样接线。当前
`packages/jobs/src/problem-package-handlers.ts` 仍直接导入 Hydro 适配器并放进固定映射，管理后台的启停状态
不会改变题目包运行时；详见[插件规范](plugins.md)第 4.5 节和
[OJ 题目包兼容性文档](oj-compatibility.md)第 3 节。

`registerProblemFormatAdapter` 会校验 `id`/`displayName`/`version`/`inputKind`，并确认 `detect`/`inspect`/`import`/
`validateExport`/`export` 都是函数。但格式适配器几乎不可能只靠 `@urmotiv/plugin-sdk` 写完——
`ArchiveSummary`/`SafeArchive`/`CanonicalProblem`/`LossReport` 这些类型和构造它们要用到的运行时校验都在
`@urmotiv/problem-package` 包里，你的插件需要直接依赖它（`plugins/hydro-format/package.json` 就同时依赖
了 `@urmotiv/plugin-sdk` 和 `@urmotiv/problem-package`）。`plugins/hydro-format/` 是仓库里唯一一个完整
实现（含 Markdown/YAML 解析和人工合成夹具测试），可作为实现结构参考；它的夹具不是 Hydro 真实导出样例，
也不证明外部互操作。写格式适配器还要遵守 [problem-package.md](problem-package.md) 第 9 节的测试清单和
[OJ 题目包兼容性文档](oj-compatibility.md)的证据边界，不要凭空造字段。

### 6.4 后台任务类型与前端扩展位：现在能在哪声明

plugins.md 第 4.5 节和第 7 节分别提到"插件可注册自己的后台任务类型"和"核心提供固定的前端扩展位"。读完
`packages/plugin-sdk/src/registry.ts` 会发现：**`PluginRegistry` 目前没有 `registerBackgroundTask`
或者 `registerWebExtension` 这类方法**。清单里的 `workerEntry`/`webEntry` 字段只是把这两个位置"声明"
出来，暂时没有配套的注册接口去消费它们：

- 后台任务的运行时（`@urmotiv/jobs` 包的 `JobWorker`/`LocalJobQueue`）已经存在，`apps/api/src/server.ts`
  里能看到核心自己是怎么注册任务处理器的（`registerProblemPackageHandlers(packageWorker, {...})`），但
  这是核心代码直接接线，不是插件通过 SDK 自主注册的机制。如果你的插件确实需要后台任务，目前只能仿照
  anklang 的方式——在 `beforeSubmit` 检查内部自己发起异步调用（比如直接 `fetch` 一个外部服务），或者找
  维护者把一个任务处理器的注册点通过运行时对象注入给你（就像第 7 节 `AnklangHookRuntime` 拿到 `cache`
  那样），没有现成模板可以直接复制。
- 前端扩展位同理：`apps/web/src` 里目前没有任何代码读取 `AdminPlugin` 或者按 `webEntry` 动态挂载组件。
  已经上线的"审核条目展示（外部分析区域）"和编辑页"查重"按钮，是前端直接为审核条目/相似度检查写的固定
  UI，不是一套任何插件都能挂进去的通用扩展机制。

写插件时如果需要这两类能力，先确认这里的现状是否已经变化，而不要假设 SDK 已经提供了对应方法。

## 7. 插件如何拿到自己的设置和密钥

### 7.1 设置：从 JSON Schema 到真正生效

链路目前是这样的（对照 `apps/api/src/plugin-host.ts`）：

1. 你在 `builtin-plugins.ts` 的 `TrustedPluginDefinition.settingsSchema` 里给出一份 JSON Schema（普通
   对象，字段包括 `type`/`properties`/`required`/`additionalProperties`/`minimum`/`maximum`/
   `minLength`/`maxLength`/`format`/`enum`/`default` 等，由 `plugin-host.ts` 内部的 `jsonSchemaSchema`
   校验其自身结构）。
2. 管理员（需要具备核心权限 `plugin.manage`；明确拒绝始终优先，见
   `apps/api/src/app.ts` 的 `requirePluginManager`）调用
   `PATCH /api/v1/admin/plugins/:pluginId`，body 里带 `settings` 字段。
3. `TrustedPluginHost.update()` 用你给的 JSON Schema 对提交的对象做服务端校验（`applySchema` 函数）：
   补默认值、检查必填项、按 `additionalProperties` 决定是拒绝还是放行未声明字段、检查
   字符串/数字/布尔/数组/对象的基本类型和范围。校验通过才会存进 `plugin_settings` 表，并写一条
   `plugin.update` 审计记录。
4. 你的钩子代码在运行时通过 `TrustedPluginHost.readEnabledPluginSettings(pluginId)` 读取当前设置——
   只有插件处于 `enabled` 状态才会返回值，否则返回 `undefined`。拿到的是校验过的原始 JSON，你的插件
   代码通常会再用自己的 Zod schema `.parse()` 一遍，拿到强类型的值（JSON Schema 是"给管理端看的、比较
   宽松的"校验，Zod schema 才是你代码里真正依赖的、更严格的类型来源，两次校验各司其职，不是重复劳动）。

**现状说明**：管理页会根据这份结构自动生成常用的文字、数字、开关和下拉输入框，服务端仍会在保存时
重新校验。数组字段目前只显示为不可在页面修改；需要数组设置的插件应先提供专门界面，或由管理员直接调用
接口提交，不能把未校验的文本当作数组保存。

**一个容易忽略的坑**：如果你的 JSON Schema 没有显式写 `"additionalProperties": false`，`applySchema`
遇到未声明的字段不会报错，而是原样透传保存（不做任何类型检查）。`review-default` 和 `anklang` 的
`settings.schema.json` 都显式写了这一项，写自己的插件时不要漏掉。

### 7.2 密钥：单独加密，永不回显明文

密钥（比如 anklang 要用的服务令牌）走另一条路径，不能和普通设置混在一起保存：

- 密钥名要满足 `pluginSecretNameSchema`：以字母开头，之后允许字母/数字/下划线/点/短横线，1–120 字符
  （`@urmotiv/contracts` 的 `pluginSecretNameSchema`）。anklang 用的密钥名是 `serviceToken`
  （`anklangServiceTokenSecretName` 常量）。
- 管理员通过同一个 `PATCH /api/v1/admin/plugins/:pluginId` 接口，在 `secrets` 字段里传 `{ 密钥名: 明文值 }`。
  `TrustedPluginHost.update()` 用 `AesGcmPluginSecretBox`（AES-256-GCM 是一种能隐藏内容并检测篡改的加密方式；
  它需要一个 32 字节的服务器密钥，来自环境变量 `URMOTIV_PLUGIN_SECRET_KEY`，使用 Base64URL 编码，也就是
  把随机字节写成只含字母、数字、下划线和短横线的文本）加密后
  才存进 `plugin_secrets` 表；没有配置
  这个环境变量时不能写入密钥。如果数据库里已经存在插件密钥，服务会在监听端口前停止启动，避免插件
  把读取失败误当成“没有设置密钥”。没有保存过插件密钥的轻量模式仍可不配置这个变量。
- 管理接口的返回值和审计记录里永远不出现明文——只有内部名称、中文名称、说明、是否已配置和末尾提示。
  长度超过 4 个字符时，末尾提示是最后 4 个字符；更短的值统一显示 `****`，防止把完整值重新显示出来。
  `apps/api/tests/plugin-host.test.ts` 专门断言过管理响应和审计记录都不包含密钥原文。
- 你的钩子代码运行时用 `TrustedPluginHost.readSecretForPlugin(pluginId, name)` 按名字申请一个密钥——
  这个方法故意没有"列出所有密钥"的版本，且内部会先做一次 `requestScope(pluginId)`（插件必须处于启用
  状态才能读到）。没有对应记录时返回 `undefined`；已有记录但服务器不能解密时抛出固定错误，不返回密文、
  密钥名或底层加密错误，也不会改用无认证请求继续执行。

anklang 是这条链路的完整真实例子，`apps/api/src/server.ts` 里能看到服务器启动时怎么把这一切接起来：

```ts
let pluginHostReference: TrustedPluginHost | undefined;
const anklangRuntime: AnklangHookRuntime = {
  readSettings: async () => pluginHostReference?.readEnabledPluginSettings(anklangPluginId),
  readToken: async () => {
    if (pluginHostReference === undefined) return undefined;
    return pluginHostReference.readSecretForPlugin(anklangPluginId, anklangServiceTokenSecretName);
  },
  cache: createProcessAnklangCache()
};
const pluginSecretBox = createPluginSecretBox(process.env.URMOTIV_PLUGIN_SECRET_KEY);
const pluginHost = new TrustedPluginHost(
  createBuiltinPluginDefinitions({ anklang: anklangRuntime }),
  new DatabasePluginStore(database),
  pluginSecretBox
);
pluginHostReference = pluginHost;
```

这里有个不易注意但很重要的写法：`pluginHostReference` 是一个先声明为 `undefined`、构造完 `pluginHost`
后才赋值的变量。之所以要绕这一圈，是因为 `anklangRuntime` 在 `TrustedPluginHost` 构造函数**执行期间**
就需要存在（构造函数会立刻调用 `registerHooks`），但它内部的 `readSettings`/`readToken` 又需要反过来
调用这个还没构造完的 `pluginHost` 自己——用一个可变的外部引用打破这个先有鸡还是先有蛋的循环依赖。

对应到 `builtin-plugins.ts` 里，anklang 这条注册用的是一个"运行时工厂"：

```ts
function createAnklangHookRegistrar(runtime: AnklangHookRuntime): (registry: PluginRegistry) => void {
  return (registry) => {
    registry.registerReviewItemType({ /* … */ });
    registry.registerBeforeSubmitCheck({
      id: anklangCheckId,
      displayName: "原题相似度检查",
      timeoutMs: 125_000,
      failureBehavior: "block",
      run: async (input, context) => {
        const rawSettings = await runtime.readSettings();
        if (rawSettings === undefined) return { decision: "continue" };
        const settings = anklangSettingsSchema.parse(rawSettings);
        const token = await runtime.readToken();
        // …用 settings、token、runtime.cache 构造真正的检查逻辑，再手动包一层超时/取消……
      }
    });
  };
}
```

每次 `run` 被调用都重新 `readSettings()`/`readToken()`，管理员改配置后不需要重启服务器就能生效；如果
插件当前被停用（`readSettings()` 返回 `undefined`），检查直接放行，不报错——因为“已启用”这件事在更外层
的 `TrustedPluginHost.requestScope` 已经判断过一次了（第 8 节展开）。

## 8. 插件如何"中断"提交

提交题目是这样拆成三个阶段的：**核心检查 → 提交前插件（beforeSubmit）→ 数据库事务**。插件只能在第二
阶段插一脚，返回"继续"或"阻止"，不能直接修改所有者、权限、状态或冻结字段——这几件事永远只由核心在第三
阶段的事务里完成。

真实调用顺序在 `apps/api/src/app.ts` 的 `createSubmitCheckRunner`：

```ts
async run(input) {
  const checkIds = await host.listEnabledBeforeSubmitCheckIds();
  const collected: StoredReviewItemInput[] = [];
  for (const checkId of checkIds) {
    const result = await host.runBeforeSubmit(input, [checkId]);
    if (result.decision === "block") {
      return { blocked: { code: result.code, message: result.message }, reviewItems: [], checksRun: checkIds.length };
    }
    // 把 result.reviewItems 收集起来，带上是哪个插件产生的……
  }
  return { reviewItems: collected, checksRun: checkIds.length };
}
```

也就是说：已启用的检查按顺序**逐个**执行（不是一次性甩给 registry 去跑一整条数组），只要有一个检查
返回 `block`，立刻停止并把这个结果当成整次提交的结果；前面已经 `continue` 的检查产生的审核条目会被
丢弃（不会先斩后奏地写进数据库）。

单个检查的返回值遵守这个结构（`beforeSubmitResultSchema`，`.strict()`）：

```ts
type BeforeSubmitResult =
  | { decision: "continue"; reviewItems?: ReviewItemInput[] }
  | { decision: "block"; code: string; message: string; details?: unknown };
```

超时和失败降级：每个检查有自己的 `timeoutMs`（1–300000 毫秒）和 `failureBehavior`
（`"block"` 或 `"continue"`）。`PluginRegistry.runBeforeSubmit` 内部用 `AbortController` + `setTimeout`
包住 `run()`：

- 超时或抛错时，`failureBehavior: "block"` 的检查会让整次提交失败（`plugin_check_timeout` /
  `plugin_check_failed`），`"continue"` 的检查则当作没发生，跳到下一个检查；
- 返回的数据结构不符合 schema（比如多写了字段、少写了必填字段）也会被当成"失败"处理，走上面同一套
  `failureBehavior` 逻辑——不会被静默忽略；
- 提交被用户主动取消（外部传入的 `AbortSignal` 已经 `aborted`）时，不管 `failureBehavior` 是什么，都
  直接返回 `submission_cancelled`，这个优先级最高。

边界（`packages/plugin-sdk/README.md` 和 registry 代码都反复强调）：插件只能返回审核条目或阻止原因，
不能把核心已经做出的拒绝改成允许，也不能绕过 `problem.frozen.edit` 之类的冻结字段规则——这些判断在
"核心检查"阶段就已经完成，插件拿到的 `BeforeSubmitInput` 本身就是已经通过核心检查之后的快照。

## 9. 权限

插件可以在清单的 `permissions` 里声明属于自己的权限，比如 anklang 声明的
`org.ustc.urmotiv.anklang.configure`（配置这个插件）和 `org.ustc.urmotiv.anklang.results.read`
（查看它产生的结果）。`registerPluginManifest` 会强制两条规则：不能和核心权限同名，必须以
`${插件id}.` 开头（第 3 节已经给出具体错误文案）。

这些权限登记之后，走的是和核心权限完全相同的授权机制——`@urmotiv/contracts` 里
`PermissionGrant.permission` 的类型是 `CorePermission | (string & {})`，本来就允许任意字符串，插件权限
和核心权限一样可以被授予某个角色、某个用户，或者针对某个对象单独授予/拒绝。具体的判定顺序（账号状态 →
账号类型限制 → 对象范围 → 明确拒绝 → 允许 → 状态规则）见 [permissions.md](permissions.md)，插件权限
同样遵守这一套，不是另一套逻辑。

插件权限不能做的事（plugins.md 第 6 节，这里是真实约束，不是建议）：

- 不能创建和核心权限同名的权限（注册时直接报错）；
- 不能把自己的权限解释成核心权限——检查 `problem.review` 的地方不会因为插件权限而放行；
- 不能自动给安装者或 root 以外的账号授权——授权永远是管理员在角色/授权页面里的一个明确动作；
- 不能解除机器人固定禁止项（`robotHardDeniedPermissions`，如 `system.manage`、`plugin.manage`）——这一
  层在账号类型阶段就拦下了，插件、角色、单题授权都改不了；
- 停用或卸载时不能留下"默认允许"的未知权限——一个从未被管理员明确授予过的插件权限，任何账号都不会因为
  它存在就自动拥有。

另外提一句区分：上面这些是**插件自己声明、保护插件自己资源**的权限；插件管理接口本身
（`GET`/`PATCH /api/v1/admin/plugins/...`）受的是**核心权限**保护，`apps/api/src/app.ts` 的
`requirePluginManager` 要求具备 `plugin.manage`；如果同一权限同时存在允许和明确拒绝，仍按明确拒绝处理。
`system.manage` 用于修改站点、认证和存储等系统设置，不是插件管理的附加条件。

## 10. 数据库使用

plugins.md 第 5 节给出的原则是：插件如果要保存数据，必须用自己编号生成的稳定前缀、通过核心提供的事务
接口访问、不能拿到数据库超级用户连接，卸载后默认保留数据。

**现状说明**：本仓库目前所有内置插件都没有自己的数据表——`review-default` 完全不读数据库；`anklang`
的可复用完整相似度结果缓存（`AnklangCache`）在 `apps/api/src/server.ts` 里是 `createProcessAnklangCache()`，一个
纯内存 `Map`，进程重启就清空，不落库。真正落库的只有核心统一提供的三张表
（`installed_plugins`/`plugin_settings`/`plugin_secrets`，`apps/api/src/database-plugin-store.ts`），
所有插件的设置和密钥都存在这几张共享表里，按 `plugin_id` 区分，不是"每个插件一套自己的表"。

也就是说，如果你的插件确实需要超出"设置 + 密钥"之外的私有数据（比如缓存要跨进程重启保留、要落盘的分析
结果），这条路目前在仓库里没有现成样板可抄，需要新增迁移和数据访问代码，并且必须遵守 plugins.md 第 5
节的原则：自己的表名前缀、走核心事务接口、不要绕过已经做过权限检查的服务直接查核心表（比如查
`problems` 表要走已经做过 `canViewProblem`/`canExportProblem` 检查的服务层，不要自己拼 SQL 直接查）。

## 11. 测试要求清单

对照 plugins.md 第 11 节，下面每一项给出这个仓库里已经存在的真实参考（没有真实参考的如实说明）：

| 要求 | 参考位置 |
| --- | --- |
| 清单和设置数据结构测试 | `plugins/review-default/test/review-rule.test.ts` 的 `describe("plugin files")`：直接读 `urmotiv-plugin.json` 和 `settings.schema.json`，断言 `pluginManifestSchema.parse(manifest).apiVersion === "1"`、默认值和文档一致。 |
| 主程序接口版本兼容测试 | 同上，`apiVersion` 断言；`apps/api/tests/plugin-host.test.ts` 也会在构造 `TrustedPluginHost` 时校验清单，版本不兼容会在启动阶段直接抛错。 |
| 权限拒绝、机器人固定限制和字段冻结测试 | `apps/api/tests/plugin-host.test.ts` 与 `apps/api/tests/plugin-admin-http.test.ts`：拒绝外部来源、拒绝与核心权限同名、拒绝越界注册钩子、插件未启用时 `requestScope`/`runBeforeSubmit` 全部拒绝，并验证管理接口只接受具备 `plugin.manage` 的人类账号且明确拒绝优先。字段冻结相关的越权测试见 [permissions.md](permissions.md) 第 7 节的清单，插件不能让这些测试变松。 |
| 超时、取消、返回畸形数据和外部服务不可用测试 | `packages/plugin-sdk/test/registry.test.ts` 的"treats malformed output as a failed required check"；`plugins/anklang/test/anklang.test.ts` 用 `vi.fn` 模拟 fetch，测试内容摘要不匹配、返回体超限、命中缓存时不发请求、`blockWhenRecommended` 时响应体不泄露候选详情。 |
| 数据库迁移升级与回退说明 | 本仓库目前没有任何插件带 `migrations/` 目录（第 10 节已说明现状），暂无可参考的真实例子；如果你的插件确实需要迁移，请遵守 plugins.md 第 3 节"数据库迁移只在管理员确认的升级步骤执行，不在普通请求中自动执行"。 |
| 若有界面，桌面和手机截图检查 | 插件统一管理页的保存、冲突处理、密钥不回显和手机布局见 `apps/web/tests/admin.spec.ts`；插件若再提供自己的业务页面，也应按同样的桌面与手机视口补测试。 |
| 若为格式适配器，按题目包规范提供安全与往返测试 | `plugins/hydro-format/test/adapter.test.ts` + `fixtures.ts`；总体测试清单见 [problem-package.md](problem-package.md) 第 9 节。 |
| README，说明作用、数据流向、权限、设置、失败影响和卸载结果 | `plugins/review-default/README.md`、`plugins/anklang/README.md`——两份都是按这个提纲写的，直接参考格式。 |

## 12. 常见错误对照表

| 错误做法 | 会发生什么 | 正确做法 |
| --- | --- | --- |
| 返回结果里多写了字段（比如 `continue` 结果里顺手加个调试字段） | `beforeSubmitResultSchema`/`reviewDecisionSchema`/`pluginManifestSchema` 等全部是 `.strict()`，多余字段直接导致校验失败，而不是被忽略；`failureBehavior: "block"` 的检查会因此挡住整次提交 | 只返回类型定义里允许的字段；需要携带额外信息用 `details`（beforeSubmit 阻止结果里唯一允许的自由字段） |
| 把密钥写进普通 `settings` 而不是 `secrets` | 明文进入 `plugin_settings` 表、审计记录、以及未来任何读取设置的地方——没有任何掩码保护 | 密钥一律走 `secrets` 字段，由 `AesGcmPluginSecretBox` 加密存储，运行时用 `readSecretForPlugin(pluginId, name)` 按名字读取 |
| 钩子里绕过核心服务直接查核心表 | 拿到的数据没有经过权限和范围检查，可能读到无权查看的题目、试题、审核意见 | 只通过核心已经做过权限检查的服务读取数据；插件宿主本来就不会给你数据库连接 |
| 插件权限不带 `${插件id}.` 前缀，或和核心权限同名 | `registerPluginManifest` 直接抛 `PluginRegistryError`，插件在启动阶段就无法注册 | 权限编号必须以自己的插件 id 开头，且不能出现在 `@urmotiv/contracts` 的 `corePermissions` 里 |
| 审核决定规则引用了 `input.opinions`/`input.reviewItems` 之外的 id | `evaluateReviewDecision` 内部的 `validateReviewDecisionReferences` 直接抛"审核规则引用了旧轮次或已失效的意见"/"...未声明支持的审核信息" | `usedOpinionIds`/`usedReviewItemIds` 只能引用传入快照里实际给到的 id；条目类型要在 `supportedReviewItemTypes` 里显式声明才能被引用 |
| `settings.schema.json` 忘记写 `"additionalProperties": false` | `TrustedPluginHost` 的 `applySchema` 会把任何未声明字段原样透传保存，不做类型检查，形同虚设的校验 | 对象类型的 schema 都显式写 `"additionalProperties": false`，像 `review-default`/`anklang` 那样 |
| beforeSubmit 检查里发起网络请求却不管 `context.signal` | 提交被取消或超时之后，请求仍在后台运行，可能造成资源泄漏或返回结果与已取消的提交对不上 | 参考 anklang 的写法：把 `context.signal` 一路传给 `fetch`，父信号取消时用 `AbortController` 联动取消 |
| 把 beforeSubmit 返回的 `reviewItems` 当成"通过票" | 审核规则读不到没有在自己 `supportedReviewItemTypes` 里声明的条目类型，这是故意的边界，不是 bug | 审核条目只是信息展示；真正影响审核结果，要在规则里显式声明支持这个条目类型并在 `evaluate` 里读它 |
| manifest 的 `id` 用了大写字母、下划线，或者只有一段没有分隔符 | `pluginIdSchema` 的正则是 `^[a-z0-9]+(?:[.-][a-z0-9]+)+$`，不满足直接校验失败 | 全小写字母数字，`.`/`-` 分隔，至少两段，建议用域名倒序 |
| 写完 `plugins/<name>/` 就以为插件会自动运行 | 目前没有任何代码会动态加载 `serverEntry`；不接线，插件的注册函数永远不会被调用 | 必须在 `apps/api/src/builtin-plugins.ts` 的 `createBuiltinPluginDefinitions()` 里追加一条 `TrustedPluginDefinition`，需要运行时依赖时用工厂函数包一层 `registerHooks`（第 5、7 节） |
