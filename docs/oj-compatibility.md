# OJ 题目包兼容性与证据边界

本文记录 Urmotiv 原生题目包、Hydro 题目包、FPS XML 和 Polygon 题目包的上游依据、
当前接入状态及已知损失。核对日期为 **2026-08-02（UTC）**。本文及其中矩阵只是该日期的
证据快照，不是运行时配置、兼容承诺或后续范围清单。外部格式会变化；实现前应把上游提交固定下来，
并以对应提交的代码和格式文件重新核对，不能只凭本文或产品版本号猜测。

下文的“适配器”是把某种 OJ 题目包与系统统一格式互相转换的组件。

本文中的“支持”只表示格式转换能力，不表示有权复制、公开或再分发包内题面、题解、测试数据、
程序和附件。格式或实现代码的许可证也不会自动给题目内容重新授权。

## 1. 状态定义

- **现已实现**：生产内置适配器已经接线，具有识别、预览、导入、导出和相应自动化测试。
- **仅传输基础**：核心能安全携带这种文件形态，但不理解其中的 OJ 语义；不能据此声称已兼容格式。
- **计划**：没有生产内置适配器，不可导入、导出或往返。
- **完整往返**：对 Urmotiv 当前统一结构中受支持的字段和文件字节，导出后重新导入保持一致。
- **受限往返**：只对明确列出的交集成立；其余字段会被拒绝、保存在来源扩展中但不生效，或产生丢失报告。

## 2. 格式来源、版本和当前结论

| 格式 | 可确认的格式依据与版本 | 上游或本站代码许可证 | 容器与题目数 | Urmotiv 当前状态 |
| --- | --- | --- | --- | --- |
| Urmotiv 原生 | 本仓库 `format: urmotiv-problem`、`formatVersion: 1`；适配器 `1.0.0` | 本仓库 MIT | 单题 ZIP；多选时另包一层下载 ZIP，不是原生多题格式 | **现已实现**；导入、导出、完整往返 |
| Hydro | [官方格式页](https://docs.hydro.ac/docs/Hydro/user/problem-format)没有单独的格式版本号；当前适配器 `0.1.0` 固定核对上游提交 [`591dbd31c00ac54aa0381a85eed375c25f6bd829`](https://github.com/hydro-dev/Hydro/tree/591dbd31c00ac54aa0381a85eed375c25f6bd829)，内部来源标记为 `hydro-591dbd31-2026-07-25` | 固定提交的根 [`LICENSE`](https://github.com/hydro-dev/Hydro/blob/591dbd31c00ac54aa0381a85eed375c25f6bd829/LICENSE) 和 [`package.json`](https://github.com/hydro-dev/Hydro/blob/591dbd31c00ac54aa0381a85eed375c25f6bd829/package.json) 标为 AGPL-3.0-only；不据此推断题目内容许可证 | ZIP；官方目录图允许出现多个题目目录，当前适配器只接收其中恰好一题 | **现已实现但为受限子集**；只有人工构造的合成夹具往返测试，尚无获许可的上游真实导出样例证据 |
| FPS XML | 上游把 [`fps.current.dtd`](https://github.com/zhblue/freeproblemset/blob/master/fps.current.dtd)称为最新定义；DTD（XML 的结构约束文件）的 `fps@version` 只是可选文本，没有枚举或语义版本约束，也没有已确认的正式发布标签 | 上游仓库 LGPL-3.0；[README](https://github.com/zhblue/freeproblemset)另行说明“准确兼容”不限制实现软件许可证，修改或衍生格式则有 LGPL 和开源实现要求 | 单个 XML；根元素允许 `item*`，所以可含零到多题 | **仅传输基础**；严格 UTF-8 原始 `.xml` 可安全进入适配器层，但没有 FPS 语义适配器，不能导入、导出或往返 |
| Polygon | 官方站当前显示 `Polygon 0.2-r3280`；这是平台修订号，不是题目包结构版本。官方 [API 文档](https://codeforces.github.io/polygon-misc/API)持续更新，但没有给题目包声明独立版本号 | 官方站声明版权；官方 [`Codeforces/polygon-misc`](https://github.com/Codeforces/polygon-misc)仓库未提供可确认的开源许可证，不能推定可复制样例或包内容 | 每道题下载一个 ZIP；另有单题 `problem.xml` 和比赛 `contest.xml` 描述文件 | **计划**；没有生产适配器、导入、导出或往返测试 |

“Hydro 5.x”或“Polygon 0.2-r3280”这类产品版本不能替代格式版本。Hydro 和 Polygon 都没有在上述
一手来源中提供可供适配器直接校验的独立格式版本号；因此实现应记录所核对的上游提交或文档快照日期，
并通过严格结构校验、显式丢失报告和互操作测试（与外部实现互相导入）控制变化。

## 3. 当前接入状态

生产题目包运行时目前只内置 `urmotiv` 和 `hydro` 两个适配器。原始 XML 分支只是统一传输能力；测试中的
假 FPS 适配器只证明字节能被送入和送出，不能证明 FPS 字段已被解析。

这里的“内置”描述当前硬编码接线：`packages/jobs/src/problem-package-handlers.ts` 直接把 Hydro 适配器放入
`builtinProblemPackageAdapters`。管理后台虽然登记了同名内置插件，但题目包运行时尚未读取它的启停状态；
所以目前停用 `org.ustc.urmotiv.hydro-format` **不会**关闭 Hydro 的识别、导入或导出。该状态不是期望的
插件开关语义，也不能把下表当作可执行配置。实现边界另见[插件规范](plugins.md)和
[Hydro 适配器说明](../plugins/hydro-format/README.md)。

| 能力 | Urmotiv 原生 | Hydro | FPS XML | Polygon |
| --- | --- | --- | --- | --- |
| 生产内置识别与预览 | 已实现 | 已实现，且明确拒绝多题包 | 未实现 | 未实现 |
| 导入统一结构 | 已实现 | 已实现受限子集 | 未实现 | 未实现 |
| 从统一结构导出 | 已实现 | 已实现受限子集，并先生成丢失报告 | 未实现 | 未实现 |
| 自动化往返 | 完整统一结构的人工合成夹具 | 支持交集的人工合成夹具 | 无；只有原始 XML 传输测试 | 无 |
| 与外部实现互相导入的证据 | 本站自有格式，不适用 | 尚缺获明确许可的官方或上游真实导出样例 | 无 | 无 |
| 单次导入多题 | 不支持 | 不支持 | 格式本身允许，但当前任务模型不支持 | 不支持 |
| 多题导出 | 外层 ZIP 内放多个单题包 | 外层 ZIP 内放多个单题包 | 将来若实现，单题 XML 可直接放入外层 ZIP | 未实现 |
| 比赛整体导入/导出 | 未实现 | 未实现 | DTD 无比赛结构 | 未实现；`contest.xml` 也尚未接入 |

多题导出的外层 ZIP 只是批量下载容器：它没有比赛题序、比赛设置、权限或赛制信息，不能称为比赛包，
也不能当作任一 OJ 的原生多题格式。

当前统一适配器接口的 `import` 一次只返回一个 `CanonicalProblem`，后台导入任务也只写入位置 `0`。
因此 FPS 的 `item*` 和任何多题 Hydro ZIP 都需要先设计批量预览、逐题选择、逐题事务和失败报告，
不能在适配器里默默只取第一题。

## 4. 上游格式字段矩阵

本节只比较核对日期时一手来源能确认的**格式表达能力**，不代表 Urmotiv 已实现相应转换，也不是产品路线图
或验收结果。“未见”表示在所列规范或官方接口中没有得到足够证据，不等于上游产品绝对没有该能力。

| 字段或能力 | Urmotiv 原生 v1 | Hydro 上游格式 | FPS `fps.current.dtd` | Polygon 官方包/API |
| --- | --- | --- | --- | --- |
| 标题、来源编号 | 标题；可选来源系统、题号和修订 | `title`/`name`、`pid` | `title+`、`url?`、`source?`、`remote_oj?`、`remote_id?` | 题目 ID、名称、修订；描述文件另有自身结构 |
| 题型 | 传统、交互、提交答案 | `type` 可表达普通、交互、通信、提交答案、客观和远程评测等 | 无统一题型字段；`spj`、`tpj`、`interactor` 只能提供部分线索 | `interactive` 等题目信息，配合 checker/interactor 和资源配置 |
| 题面结构 | 单语言 Markdown；背景、题意、输入、输出、限制、提示等固定分区 | 多份 `problem_语言.md` Markdown；题面分区由 Markdown 约定表达 | `description`、`input`、`output`、`hint` 为 XML 普通文本（PCDATA）；元素可重复但 DTD 没有语言属性 | 多语言 statement；name、legend、input、output、scoring、interaction、notes、tutorial 分区 |
| 样例 | 有序输入、输出和独立解释 | Markdown 中的成对代码块；解释通常落回题面小节 | `sample_input*` 与 `sample_output*`，DTD 未声明配对键 | statement 内容及 statement 用测试字段可表达；具体包映射需按固定包版本验证 |
| 题解和程序解答 | 一份结构化题解文本；另有标准程序文件类别 | `solution/*.md` 和 `std/`；上游代码行为允许目录中出现多文件 | `solution*`，每份必须带 `language`；另有 `prepend*`、`template*`、`append*` | tutorial；多份 solution，带 MA/OK/RJ/TL/TO/TM/WA/PE/ML/NR/RE 等标签 |
| 标签、难度 | 多标签；Codeforces、思维和代码难度 | `tag`；0 到 10 的 `difficulty` | DTD 未见标签或难度字段 | 标签可读写；官方 API 未给出与 Urmotiv 三套难度一一对应的字段 |
| 时间、内存 | 毫秒、MiB；可有逐点覆盖 | 全局、子任务和逐点限制；还可按语言设置倍率 | `time_limit+`、`memory_limit+`，`unit` 是不受约束的可选文本 | 官方 API 使用毫秒和 MB；测试/测试组另有配置 |
| 静态测试数据 | 输入、可选输出、分数、子任务归属 | `cases` 或 `subtasks[].cases` 引用 `testdata/` 文件 | `test_input*`、`test_output*`，可选 `name` | 手工测试或生成测试；可记录 points、group、statement 用输入输出等 |
| 子任务、依赖和计分 | 子任务、依赖；sum/min/max；整数分数 | 子任务、`if` 依赖、sum/min/max；全局与逐点分数 | DTD 未见子任务、依赖或计分字段 | 测试组、组依赖、COMPLETE_GROUP/EACH_TEST 和反馈策略；points 可为两位小数 |
| 特殊判断 | 标准或一份特殊判断程序 | `checker_type`、`checker` | `spj?`，可选语言 | checker、checker tests；资源还可声明编译/运行阶段和适用资产 |
| 交互、提交答案 | 一份 interactor 或 answer checker | interactor；提交答案通过题型和 checker 表达 | `interactor?`、`tpj?` | interactor；交互题信息；其他准确映射需核对固定题目包 |
| validator、生成器 | 统一结构没有原生字段 | config 可有 `validator`、`manager` 等，另有更多评测专用设置 | 没有 validator；根级 `generator*` 只有名称、URL 和文本，不是明确的逐题生成程序结构 | validator、额外 validator、validator tests、测试生成脚本和生成测试 |
| 资源和附件 | 资源、测试数据、评测程序、标准程序、公开附件、内部附件，保留目录和字节 | `additional_file/`、`testdata/`、`std/` 等；没有 Urmotiv 内部附件可见性 | `img*` 内含 `src+`、`base64+`；程序正文放在对应 XML 元素 | statement resource、resource/source/aux 文件及高级编译/运行属性 |
| 校验值、来源扩展 | 每个包文件有 SHA-256；任意 JSON 来源扩展 | 上游格式未见与原生包等价的全包校验清单；适配器可在本站扩展中保存来源配置 | DTD 未见全包校验清单 | API 可返回部分内容摘要；未确认与原生包等价的全包校验清单 |
| 比赛元数据 | 无 | 单题格式无 | 无 | 有单独 `contest.xml` 和 `contest.problems`；官方文档未证明存在一个含全部单题包的比赛 ZIP |

## 5. Urmotiv 原生 v1

### 5.1 已实现

原生适配器版本是 `1.0.0`，清单要求 `format: urmotiv-problem` 和 `formatVersion: 1`。它读取和写入：

- 标题、题型、标签和三套难度；
- 固定 Markdown 分区、样例及样例解释；
- 全局限制、子任务、依赖、数据点、sum/min/max 计分、标准/特殊判断、交互程序和答案判断程序；
- 资源、测试数据、评测程序、标准程序、公开附件和内部附件；
- 来源系统、来源题号、来源修订和 JSON 扩展；
- 除校验清单自身外，包内全部文件的 SHA-256 校验值。

对这套统一结构，仓库已有导出后重新导入的字段与文件字节往返测试。导出时排除仍被评测配置引用的
文件会被阻止。

### 5.2 明确边界

原生 v1 不是任意 OJ 信息的无损超集。它目前没有原生表示：

- 多语言题面和多语言教程；
- validator、生成器及生成脚本语义；
- 多份程序解答及“正确/错误/超时”等解答标签；
- Polygon 的编译/运行资源阶段、反馈策略、两位小数分数等专用设置；
- 比赛题序、赛制、权限、作者、审核意见和访问记录。

来源扩展可以保留适配器明确实现的 JSON 信息，但“放进扩展”不等于本站评测、编辑器或目标 OJ 会使用它，
也不能用扩展绕过丢失报告。

## 6. Hydro

### 6.1 一手依据

Hydro [题目包格式](https://docs.hydro.ac/docs/Hydro/user/problem-format)把它定义为用于系统间交换的 ZIP；
官方 [题目文档](https://docs.hydro.ac/docs/Hydro/user/problem)说明可上传 Hydro 导出 ZIP，并把 FPS 导入列为
单独插件能力；[测试数据格式](https://docs.hydro.ac/docs/Hydro/user/testdata)定义题型、限制、checker、interactor、
cases、subtasks、依赖、额外文件和按语言倍率等配置。

Urmotiv 适配器固定核对提交 `591dbd31c00ac54aa0381a85eed375c25f6bd829` 的以下上游实现：

- [`packages/hydrooj/src/model/problem.ts`](https://github.com/hydro-dev/Hydro/blob/591dbd31c00ac54aa0381a85eed375c25f6bd829/packages/hydrooj/src/model/problem.ts)
- [`packages/ui-default/components/zipDownloader/index.ts`](https://github.com/hydro-dev/Hydro/blob/591dbd31c00ac54aa0381a85eed375c25f6bd829/packages/ui-default/components/zipDownloader/index.ts)
- [`packages/common/types.ts`](https://github.com/hydro-dev/Hydro/blob/591dbd31c00ac54aa0381a85eed375c25f6bd829/packages/common/types.ts)

同一固定提交的根 `LICENSE` 与 `package.json` 都标为 **AGPL-3.0-only**。这项结论只针对所核对提交，
不从后续分支、商业发行方式或题目包内容反推许可证；本仓库的详细说明见
[`plugins/hydro-format/LICENSE-NOTICE.md`](../plugins/hydro-format/LICENSE-NOTICE.md)。

### 6.2 已实现的交集

当前适配器识别一个题目目录中的 `problem.yaml`、一份选定的 Markdown 题面、至多一份 Markdown 题解、
`testdata/config.yaml`、测试数据、`additional_file/` 和 `std/`。它可以映射：

- 标题、题号、标签和传统/交互/提交答案三种本站题型；
- 常用题面分区、样例、题解；
- 时间、内存、数据点、子任务、依赖、sum/min/max 子任务计分；
- 标准或特殊判断、交互程序、答案判断程序；
- 公开附件、资源、测试数据和标准程序。

Hydro 题号、0 到 10 难度、原始题面、题面文件名、根目录和完整可校验配置会写进 `extensions.hydro`。
再次导出 Hydro 时，未被统一字段重建覆盖的来源配置会优先恢复。

### 6.3 导入损失和拒绝条件

- 一个 ZIP 中不是恰好一个 `problem.yaml` 时停止导入；不会只取第一题。
- 多语言题面必须明确选择一份。适配器已经定义 `statementFile` 选择，但当前公开导入请求没有传递
  适配器专用的 `values` 选择字段，后台总是以“创建新题”且无额外选择启动，因此需要选择的包目前不能走完公开流程。
- `communication`、`objective` 和 `remote_judge` 在本站没有等价题型，当前会拒绝导入，不会改成普通题。
- 多于一份 `solution/*.md` 会被拒绝，因为统一结构无法无损区分多份题解。
- Hydro 难度原值只保存在来源扩展，不自动换算成本站难度。
- `owner`、提交/通过统计和 `hidden` 不作为题目内容导入。
- 未识别的一级 Markdown 分区会提示，并保留在基础题面原文中；不会猜成某个结构字段。
- `subType`、`langs`、`target`、`manager`、`validator`、`num_processes`、`multi_pass`、
  `user_extra_files`、`judge_extra_files`、`filename`、`detail`、`time_limit_rate` 和
  `memory_limit_rate` 会保存在来源配置中，但当前本站评测配置不使用它们。
- `redirect`、`key`、`template` 和 `answers` 同样没有统一评测字段；适配器的输入结构校验可以保留原值，当前评测转换
  不消费它们，且只有这些设置而没有可识别数据点的包会导入失败。
- 同时存在 `cases` 和 `subtasks` 时按 Hydro 行为只把 `cases` 转为本站评测配置，另一个结构只留在来源扩展。
- 无法归类的目录、缺失的配置引用、映射后重名，以及题型缺少必需输出或评测程序时停止导入。

### 6.4 导出损失和拒绝条件

- 本站三套难度不会猜测换算；只有来自 Hydro 扩展的原难度可以写回。
- 样例解释没有独立 Hydro 字段，会改写为题面小节并报告警告。
- 内部附件没有等价可见范围，导出会被阻止，不能降级成公开附件。
- Hydro 相关目录会压平到单层文件名；路径变化会警告，重名会阻止导出。
- 全局计分只能是 sum；总分、子任务分数和数据点分数必须满足当前适配器确认的 Hydro 范围，否则阻止导出。
- 特殊判断、交互或提交答案需要明确的 Hydro checker 类型。适配器支持 `checkerType` 选择，但当前公开导出
  请求也不传适配器专用的 `values` 选择字段，所以缺少来源类型的题目目前会停在 `choice`，无法由公开流程补选。
- 资源会进入 `additional_file/`；题面引用必须由用户确认改成 Hydro 的 `file://文件名` 形式。

因此 Hydro 当前只能称为**受限往返**。人工构造的合成夹具证明已支持交集在本实现内可以往返，但没有证明它与某个
真实 Hydro 部署的所有导入、导出变体互操作。补这种证据时只能使用独立创作的合成包，或内容许可证明确
允许保存和再分发的上游样例。

## 7. FPS XML

### 7.1 上游格式能表达什么

FPS 上游 README 将其描述为 XML 题目交换标准，并把 `fps.current.dtd` 作为最新定义。DTD 规定：

- 根元素是 `fps (generator*, item*)`，所以一个文件可以包含多题；
- 每个 `item` 包含标题、URL、时间、内存、题面、输入输出、样例、测试数据、提示、来源、零到多份带语言的
  solution，以及可选 spj、tpj、interactor、远程 OJ 信息和内嵌图片；
- `fps@version`、`fps@url` 和时间/内存的 `unit` 都只是可选 CDATA，没有受约束的版本或单位枚举。

因此不能仅看 `version="1.2"` 就假定字段、单位或实现行为，也不能按样例输入输出和测试输入输出的数组下标
静默配对。正式实现前应固定 `fps.current.dtd` 的具体提交，并为缺名、重名、数量不一致、未知单位和重复字段
制定显式规则。

### 7.2 当前只有传输基础

核心目前能接收文件名以 `.xml` 结尾、严格 UTF-8、具有可识别 XML 文件头且未超限的原始单文件，并把它以
固定安全路径 `problem.xml` 交给适配器。它不解析元素、不验证 FPS DTD、不读取题目数，也没有生产 FPS
适配器。因此：

- 上传一个 FPS XML 不等于可以预览或导入；生产内置格式列表不会识别它；
- 测试中的假单文件适配器只证明原始 XML 字节不会被额外包成 ZIP；
- FPS 多题文件不能套进当前“一次返回一个题目、只写位置 0”的导入任务；
- 没有字段丢失报告、导出器或往返测试。

将来解析时必须禁用 DTD/实体解析和外部实体、外部网络或本地文件访问。若要按 DTD 校验，应把经过审阅并
固定提交的格式定义文件作为只读资源由程序主动选择，不能跟随文档中的 `DOCTYPE` 去下载或读取任意地址。

### 7.3 预计需要明确处理的损失

- 多个 `item` 必须拆成逐题预览和逐题事务，不能静默丢弃。
- FPS 可有多份带语言的 solution，以及 prepend/template/append；统一结构没有完整对应项。
- FPS 没有本站标签、三套难度、子任务、依赖和计分结构；导入不能编造这些值。
- FPS 的文本格式、重复 title/description 的含义和单位值未被当前 DTD 充分约束；遇到歧义必须要求选择或拒绝。
- 图片是 XML 内 base64；转换为文件时要重新做总量、类型、路径和引用检查。
- `spj`、`tpj`、`interactor` 的语言、编译方式和运行约定不等于本站程序引用，导出前必须报告不可表达的设置。

## 8. Polygon

### 8.1 一手来源能确认的能力

Polygon 官方站说明它覆盖题面、生成器、正确和故意错误的模型解答、评测与自动验证。官方 API 文档确认：

- 对题目 URL 发 POST 可下载 ZIP；可指定修订和 `standard`、`linux`、`windows` 包类型；
- `standard` 包不含生成后的测试，但含 Windows 可执行文件及通过 Wine 运行的脚本；`linux` 包含生成后的测试
  且不含编译产物；`windows` 包含生成后的测试和 Windows 编译产物；
- 单题 `problem.xml` 是题目描述文件；`contest.xml` 是单独的比赛描述文件，二者都不是 FPS XML；
- API 可读写多语言题面和教程、statement resources、checker/interactor、validator 和额外 validator、
  checker/validator tests、resource/source/aux 文件、多份带结果标签（verdict）的 solution、测试生成脚本、手工或生成测试、
  测试组、分数、依赖和反馈策略。

官方 API 没有证明 `contest.xml` 就是包含所有单题包的比赛归档，也没有提供一个可据此宣布完整兼容的题目包
结构版本。接入时必须先选定确切包类型和上游修订，取得有权使用的最小包，再逐字段验证。

### 8.2 当前状态和预计损失

Urmotiv 没有 Polygon 适配器。原始 XML 传输底座不能解析 `problem.xml`，更不能代替包含大量文件的 Polygon
ZIP。因此 Polygon 当前全部属于计划状态。

即使以后接入，下列内容也没有当前统一结构的无损对应项：

- 多语言题面和教程；
- validator、额外 validator、validator/checker 自测；
- 生成脚本、尚未生成的测试和包类型差异；
- 多份 solution 及 MA/OK/WA/TL/RE 等标签；
- resource 的编译/运行阶段和适用资产；
- 测试组反馈策略、两位小数分数及 Polygon 专用运行设置；
- 比赛描述、题序和比赛设置。

Polygon 包可能包含脚本和平台相关可执行文件。导入端只能把内容当作不会执行的普通文件检查和保存，绝不能执行包内
程序，也不能通过导入触发编译、生成测试或 Wine。路径跳转、符号链接、重名、嵌套压缩包、压缩炸弹和总量
限制仍必须在适配器看到内容前由核心拒绝。

## 9. 许可证和测试样例边界

以下规则同时适用于自动化测试样例、与外部实现互相导入的手工测试和文档示例：

1. Urmotiv 的 MIT 许可证只覆盖本仓库代码和由权利人以该许可证发布的材料，不给导出的私有题目重新授权。
2. Hydro 上游代码的 AGPL-3.0-only 约束 Hydro 代码本身；“ZIP 格式公开”不表示任意 Hydro 导出题目可进入 Git。
   本适配器应保持独立实现，不复制上游源代码或题目内容。
3. FPS 仓库是 LGPL-3.0，README 对准确兼容和衍生格式另有明确说明；即使如此，`fps-examples` 中每道题的
   题面、数据、题解和第三方素材仍需逐项确认权利，不能从“仓库公开”推断可再分发。
4. Polygon 官方站和官方辅助仓库没有提供已确认的开放题目包许可证。未取得题目作者及所有附件/程序的明确
   许可时，不得把 Polygon 包或从中抽取的内容提交为测试样例。
5. “公开可下载”“比赛已经使用过”“格式仓库采用开源许可证”都不是题目内容许可。合适的持久测试样例应由项目
   独立创作，或附带明确覆盖题面、题解、测试数据、程序和附件的可再分发许可证及来源记录。
6. 私有题目、模型原始回答、账号和密钥不得进入 Git、测试快照、日志、错误信息或本文。互操作失败只记录
   格式、数量、大小、摘要、固定错误码和安全字段路径。

本文不是法律意见。遇到来源不清、混合许可证或比赛资料授权范围不明时，默认不保存、不提交、不再分发。

## 10. 后续实现准入条件

### 10.1 Hydro 完成外部互操作闭环

- 先让公开 API/UI 能传递 `statementFile`、`checkerType` 等适配器选择，并补权限和失败路径测试；
- 使用独立创作或许可明确的包，在固定上游提交对应的 Hydro 环境中完成“Hydro 导出 → Urmotiv 导入”和
  “Urmotiv 导出 → Hydro 导入”；
- 报告必须列出格式、上游提交、适配器版本、样例许可证、字段断言和明确损失，不保存正文或原始包。

### 10.2 FPS 语义适配器

- 固定 `fps.current.dtd` 的具体提交，并只使用安全 XML 解析器配置；
- 先扩展导入接口支持多题，再实现 `item*`，不能先做只取第一题的临时版本；
- 为单位、重复字段、样例/测试配对、富文本、base64 图片和程序语言制定拒绝或选择规则；
- 补单题、多题、恶意 XML、导入、导出、丢失报告和往返测试。

### 10.3 Polygon 适配器

- 先选定 `standard`、`linux` 或 `windows` 中的目标包类型和固定上游修订；第一版不应接收含可执行文件并
  可能诱发执行的变体；
- 取得有权持久保存的独立最小测试样例和对应 `problem.xml`，确认包布局后再写结构校验；
- 为多语言、生成器/validator、多份 solution、资源高级属性和测试组策略逐项给出保留、拒绝或丢失规则；
- 比赛 `contest.xml` 作为单独设计，不混进单题适配器或现有批量下载外层 ZIP。

## 11. 本仓库实现证据

- 原生格式规范：[`docs/problem-package.md`](problem-package.md)
- 统一结构和原生版本：[`packages/problem-package/src/schema.ts`](../packages/problem-package/src/schema.ts)
- 原生适配器：[`packages/problem-package/src/native.ts`](../packages/problem-package/src/native.ts)
- 原生往返测试：[`packages/problem-package/test/native-roundtrip.test.ts`](../packages/problem-package/test/native-roundtrip.test.ts)
- ZIP/原始 XML 输入边界：[`packages/problem-package/src/input.ts`](../packages/problem-package/src/input.ts)
- 适配器一次返回一题的接口：[`packages/problem-package/src/adapter.ts`](../packages/problem-package/src/adapter.ts)
- 生产内置适配器和后台任务：[`packages/jobs/src/problem-package-handlers.ts`](../packages/jobs/src/problem-package-handlers.ts)
- Hydro 适配器说明：[`plugins/hydro-format/README.md`](../plugins/hydro-format/README.md)
- Hydro 适配器和显式损失规则：[`plugins/hydro-format/src/adapter.ts`](../plugins/hydro-format/src/adapter.ts)
- Hydro 上游修订与 schema：[`plugins/hydro-format/src/schema.ts`](../plugins/hydro-format/src/schema.ts)
- Hydro 人工合成夹具往返测试：[`plugins/hydro-format/test/adapter.test.ts`](../plugins/hydro-format/test/adapter.test.ts)
- 本仓库许可证：[`LICENSE`](../LICENSE)
