# 题目包与 OJ 格式转换规范

## 1. 为什么需要内部统一格式

不同 OJ 对题面、子任务、特殊判断程序和文件名的要求不同。Urmotiv 先把题目转换为一套信息完整的内部结构，
再由每个 OJ 的格式适配器负责读写。这样不会把 Hydro、洛谷或其他系统的字段直接塞进核心数据库。

“导入成功”不等于所有信息都被保留。适配器必须报告目标格式无法表达的内容，用户确认后才能继续。

题目资料可以用两种文件形式传入系统：

- `zip`：一个 ZIP 压缩包，里面可以有题面、数据和其他文件；
- `single_file`：一个未经压缩的原始文件。当前基础能力只接受文件名以 `.xml` 结尾、全部内容是
  严格 UTF-8 且文件开头符合 XML 写法的内容，为以后接入 FPS XML 等格式做准备；这一阶段并不解析 FPS。

上传和后台任务使用同一个安全读取函数。文件名以 `.xml` 结尾时只按原始 XML 检查，发现 ZIP
标记、无法识别的 XML 文件头或超限内容都会直接失败，不会再改按 ZIP 猜测。为兼容原有上传，
其他文件名仍只按 ZIP 检查；如果内容不是完整且安全的 ZIP，也不会改按 XML 猜测。
单个 XML 通过检查后，在提供给格式适配器的安全文件集合里固定使用 `problem.xml`，不带入用户上传的文件名。

## 2. Urmotiv 原生题目包

原生包是 ZIP 文件，媒体类型为 `application/vnd.urmotiv.problem+zip`。包内只允许 UTF-8 文件名和 `/` 分隔的相对路径。

```text
manifest.yaml
content/
  basic-statement.md
  basic-solution.md
  background.md
  statement.md
  input.md
  output.md
  constraints.md
  solution.md
  hints.md
samples/
  samples.yaml
assets/
  <内容摘要>.<扩展名>
judge/
  config.yaml
  testdata/
    001.in
    001.out
  checker/
  interactor/
  answer-checker/
solutions/
  std/
attachments/
  public/
  internal/
checksums.sha256
```

空分区可以省略。路径不包含题目名称、作者邮箱或学号，避免文件名泄露个人信息。

### 2.1 `manifest.yaml`

```yaml
format: urmotiv-problem
formatVersion: 1
exportedAt: 2026-07-25T00:00:00Z
problem:
  title: 示例题
  type: traditional
  tags:
    - graph.shortest-path
  difficulty:
    codeforces: 1600
    thinkingLevel: 3
    codingLevel: 2
  content:
    basicStatement: content/basic-statement.md
    basicSolution: content/basic-solution.md
    statement: content/statement.md
  samples: samples/samples.yaml
  judge: judge/config.yaml
provenance:
  sourceSystem: urmotiv
  sourceProblemId: "123"
  sourceRevision: "7"
```

说明：

- `format` 和 `formatVersion` 必填；读取未知大版本时必须拒绝，不能猜测。
- `sourceProblemId` 只用于提示冲突，不作为导入后的内部编号。
- 作者、审核、访问记录、比赛归属和权限默认不进入题目包。管理员迁移站点时使用单独的备份工具。
- `thinkingLevel` 与 `codingLevel` 只有在评分标准版本一致时才导入为正式值，否则作为导入备注等待确认。

### 2.2 样例

`samples/samples.yaml` 按顺序保存：

```yaml
version: 1
samples:
  - input: |-
      2 4
    output: |-
      8
    explanation: 两个数相乘。
```

样例直接保存在清单中，避免把样例误当成正式测试数据。

### 2.3 评测配置

`judge/config.yaml` 表达数据点和子任务，不绑定某个评测机命令行：

```yaml
version: 1
limits:
  timeMs: 1000
  memoryMiB: 512
scoring:
  total: 100
  subtaskMode: sum
subtasks:
  - id: 0
    score: 40
    method: sum
    dependsOn: []
  - id: 1
    score: 60
    method: sum
    dependsOn: [0]
testcases:
  - id: "001"
    input: judge/testdata/001.in
    output: judge/testdata/001.out
    subtaskId: 0
    score: 20
    timeMs: 1000
    memoryMiB: 512
checker:
  type: standard
```

交互题使用 `interactor`，提交答案题使用 `answerChecker`；不适用的配置不得同时出现。时间统一为毫秒，内存统一为 MiB，
避免适配器猜单位。

### 2.4 校验值

`checksums.sha256` 列出除自身外每个文件的 SHA-256 值和规范路径。导入时在解析任何 Markdown 引用或程序文件前校验。
相同资源以内容摘要命名，可避免重复和覆盖。

## 3. 格式适配器接口

每个适配器提供以下能力：

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

`inputKind` 表示这个格式读取 ZIP 还是原始单文件。旧适配器没有这个字段时按 `zip` 处理。
上传识别、预览和后台导入都会核对它，ZIP 内即使恰好有一个 `problem.xml`，也不能借此冒充原始单文件。

导出结果也明确分为两种，避免调用方猜测是否还要再压缩：

```ts
type GeneratedArchive =
  | {
      kind?: "zip";
      mediaType: string;
      fileName: string;
      files: readonly GeneratedArchiveFile[];
    }
  | {
      kind: "single_file";
      mediaType: string;
      fileName: string;
      content: Uint8Array;
    };
```

`zip` 的行为与原来相同，后台重新检查文件路径后生成 ZIP。`single_file` 当前必须生成 `.xml`
文件和可识别的 XML 文件头；单题导出直接保存这些字节，并保留适配器给出的媒体类型，
也就是下载响应中说明“这是什么文件”的标准值，不会再包一层 ZIP。
这里把 ZIP 的 `kind` 写成可选只是为了让按插件接口第一版编写的旧代码仍能重新编译；
新插件应明确填写 `kind: "zip"`，后台也会把旧写法补成这个明确值后再继续处理。

这些方法的日常含义是：

- `detect`：只看少量文件名和清单，判断像不像自己的格式；不能执行包内代码。
- `inspect`：列出题目、字段、文件和错误，供用户预览；不写数据库。
- `import`：把已确认内容转换成内部统一结构。
- `validateExport`：在导出前说明哪些字段会丢失、降级或需要用户选择。
- `export`：生成目标 OJ 的压缩包。

适配器不能直接给用户授予题目权限、修改原题、读取其他题目或绕过统一的文件安全检查。

## 4. 首批格式

### 4.1 Urmotiv 原生格式

- 目标：完整、可逆、适合备份单题和在 Urmotiv 实例间迁移。
- 要求：导出后重新导入，所有已支持字段、Markdown、文件字节和配置保持一致。
- 冲突：相同来源编号只提示；默认创建新题，用户可选择更新自己有编辑权的现有题目。

### 4.2 Hydro

- 目标：导入 Hydro 导出的标准题目包，并把资料齐全的 Urmotiv 题目导出成 Hydro 可接受的包。
- 实现和复核必须固定 Hydro 上游提交，并以该提交的代码和官方文档为准，不凭记忆或产品版本号写文件名。
- 仓库内适配器测试只保存独立人工构造的最小合成夹具，不能使用协会私有题目，也不能把夹具称为 Hydro
  真实导出样例。与外部实现互相导入是另一类证据，只能使用独立创作或明确许可保存和再分发的包。
- 对 Hydro 特有但 Urmotiv 暂无对应项的设置保存在带来源标记的扩展字段中；再次导回 Hydro 时可恢复。
- Urmotiv 有而 Hydro 不能表达的字段进入丢失信息报告，不能写进随意命名的配置项让 Hydro 忽略。

固定提交、当前支持交集、许可证和仍缺的互操作证据见 [OJ 题目包兼容性文档](oj-compatibility.md)；
适配器自己的边界见 [Hydro 适配器说明](../plugins/hydro-format/README.md)。

### 4.3 后续格式

第二个通用格式优先评估 FPS XML，因为多个 OJ 能交换这种格式；Polygon、QDUOJ、UOJ 等按真实使用需求增加。
每增加一种格式都要提供格式来源、许可证说明、最小导入样例、最小导出样例和往返测试。

## 5. 导入流程

1. 上传到隔离临时目录；计算总大小和摘要，并按上面的固定规则区分 ZIP 与原始 XML。
2. ZIP 安全扫描只接受普通文件，拒绝绝对路径、`..`、符号链接、设备文件、重名规范路径和过深目录；
   原始 XML 放入固定的安全路径。
3. ZIP 限制解压后总大小、单文件大小、文件数和压缩比例；原始 XML 同样受原始文件和单文件大小限制。
   超过限制直接拒绝。
4. 用户选择格式或由检测结果建议，不以最低置信度自动执行。
5. 适配器生成预览：题目数、字段映射、文件列表、错误、警告和需要选择的冲突。
6. 用户确认后创建后台任务。任务使用一次性输入快照，并固定当时已启用的适配器编号和版本；执行时再次从
   受信任格式目录解析并比较，防止上传内容被替换，也防止插件停用或升级后换用另一份实现。
7. 每道题在独立数据库事务中创建；批量导入允许其他题继续，但报告每题成功或失败。
8. 临时文件按保留期清理，日志只保存摘要、数量和错误位置，不保存正文。

标准 OJ 包不得调用 LLM 才能导入。只有“历史资料迁移”可以选择 LLM 辅助，并且辅助结果必须人工确认。

当前导入实现会把整个上传文件和 ZIP 解压结果放在内存中处理，因此默认限制为：原始上传文件不超过
128 MiB（134,217,728 字节），ZIP 内单个文件或原始 XML 不超过 128 MiB，全部文件解压后的总量不超过
128 MiB，文件数不超过 10,000。三项大小限制分别检查，不能用“压缩后很小”绕过解压后的限制。
这只是当前实现保护服务器内存的边界，不是 Urmotiv、Hydro 或 FPS 格式本身的限制；题目编辑页面
单独上传的附件仍按文件存储设置处理，不受题目包上传上限影响。

处理过程中可能同时保留原始上传文件、解压内容和检查时使用的副本，实际占用会明显高于 128 MiB，
最坏情况下约为 512 MiB 再加上解压程序本身的开销。部署时必须限制同时处理的题目包数量。
将来若要支持更大的合法题目包，应改为分段读取或使用受限的临时文件，再单独提高这些上限。

## 6. 导出流程

1. 用户选择题目、固定修订版本和文件类别。
2. 服务端确认每道题的题面、内部资料和比赛权限。
3. 适配器返回丢失信息报告，按严重程度分为：阻止导出、需要选择、可接受降级、提示。
4. 用户确认后创建后台任务，固定当时已启用的适配器编号和版本；任务开始时重新解析并比较适配器，读取每个
   文件时再次检查权限。
5. 文件写入隔离目录，生成校验值后整体上传到对象存储。
6. 下载使用短期地址；每次换取地址都重新检查用户和任务权限。
7. 到期后删除导出包。审计记录保留题号、版本、目标格式、操作者和结果，不保存包内容。

上传成功、导入预览、导入任务创建、单题导入完成、导出预览、导出任务创建、导出完成和下载成功都要
写入不可修改的审计记录。审计元数据只保存格式编号与版本、文件种类、数量和是否可导出等固定字段；标题、文件名、
逻辑路径、题面、题解、附件内容和适配器原始消息都不能进入审计记录。无权题目的导出预览只能记录请求数量
和整体结果，不能记录用户提交的题号。

会改变数据库状态的操作必须把状态修改和审计写入放在同一个事务中；审计写入失败时整体回滚，并清理能够
确认没有被提交引用的对象文件。预览和下载虽然不修改业务状态，审计写入失败时也不能先返回预览内容或文件
字节，只返回固定的暂时不可用错误。无法确认数据库事务是否已经提交时，不得删除可能已被成功记录引用的对象。

选择一道题时，`zip` 结果仍下载为该题的目标格式 ZIP，`single_file` 结果直接下载为适配器生成的
原始 XML。选择多道题时，系统先按相同的安全规则分别生成每道题的最终文件，再把它们放进一个多题导出
外层 ZIP。ZIP 格式的每道题仍是一个内层 ZIP，且其内部仍禁止嵌套压缩包；原始 XML 则直接成为外层 ZIP
里的普通文件，不会再包一层。

一次多题导出不能混合 ZIP 与原始 XML。原始 XML 的文件名按 Unicode 规范形式和大小写检查，
重名时直接失败，不能覆盖。原有 ZIP 适配器通常为每道题返回相同的固定文件名，为保持现有行为，
外层包会继续按顺序增加 `2-`、`3-` 前缀；增加前缀后仍有冲突时失败。
这个外层包只是便于一次下载多道题，不包含比赛题序、比赛设置或权限，也不代表某场比赛的完整导出。

当前多题导出会在内存中组装全部字节。外层 ZIP、其中单个单题包、以及全部单题包的字节总和都以
128 MiB（134,217,728 字节）为上限；外层目录还会占少量空间，所以接近上限时也可能被拒绝。
即使对象存储允许更大的文件，这一限制也不会自动增大，避免一次导出占用过多内存。
后台任务会先检查所有题目和文件的读取权限，再按已保存的文件大小计算本次所选文件的总量；
总量超过 128 MiB 时不会读取任何文件内容，用户需要减少题目或分批导出。
转换每道题后，系统还会累计目标格式尚未压缩的文件大小；累计超过 128 MiB 时立即停止，
不再转换后续题目，也不会留下可下载的半成品。

默认导出不包含：作者联系方式、审核意见、访问记录、权限、比赛信息、内部来源令牌、插件私有设置。

## 7. 丢失信息报告

报告必须可供程序和人阅读：

```json
{
  "targetFormat": "hydro",
  "canExport": true,
  "items": [
    {
      "severity": "warning",
      "path": "problem.difficulty.thinkingLevel",
      "message": "目标格式没有思维难度字段，该值不会进入导出包。"
    }
  ]
}
```

界面只使用普通中文说明；`path` 用于定位字段和自动化测试。

## 8. 历史资料迁移

私有历史资料可能是 Markdown、PDF、图片、单题 ZIP、混合批量 ZIP 或表格。迁移工具与标准导入分开：

- 先建立文件清单和题目分组，不把压缩包中每个文件误认为一道题；
- 显示原文预览和目标字段，允许人工调整；
- PDF 解析或 LLM 规范化只产生候选内容，不能自动覆盖已有题目；
- 源文件与表格记录的对应关系必须先由人确认；第一次确认同时锁定整份私有元数据和源文本的内容摘要。
  候选内容还要用“候选安全编号 + 完整内容摘要”再次批准，两次确认不能合并；元数据、原文、候选题目或
  审核备注变化都会使旧确认失效；
- 学号匹配到预创建账号时显示歧义，不能把同一学号或姓名自动当成同一人；
- 作者学号只保存在单独的私有映射文件中，不进入题目包清单、扩展字段、文件名或迁移报告；私有映射要带
  候选内容摘要、题目包摘要和整批摘要，避免不同批次使用相同安全编号时误配；
- 投题者自填难度不进入解析后元数据、模型提示、候选题或标定真值；难度必须另行独立评定；
- QQ、审核意见和其他不需要的表格列不导入；
- 全程使用私有目录和私有任务队列，任何样例、快照和错误报告不得提交到 Git。

## 9. 测试清单

- 原生包完整往返，字段和 SHA-256 校验值一致；
- 原始 XML 与 ZIP 明确分开；ZIP 改名为 `.xml`、XML 改成其他名称、其他文件和损坏 ZIP 都固定失败；
- 上传后同长度内容发生变化时，预览和后台任务都因 SHA-256 校验值不一致而失败；
- 导出固定修订时，任务把文件大小和 SHA-256 一起绑定到读取快照；对象存储或元数据发生同长度变化时，
  以固定完整性错误结束，不重新封装变化后的字节，也不在报告中记录文件名或存储位置；
- 单题原始 XML 保持文件字节和适配器给出的媒体类型，多题原始 XML 直接放进外层 ZIP；
- 多题导出混合两种文件形式、原始 XML 重名或总量超限时不留下半成品；
- Hydro 官方或开源许可样例导入、导出和可接受的往返；
- 缺失输出、重复路径、大小写冲突、空文件、超限文件数；
- `../`、绝对路径、反斜杠绕过、符号链接、嵌套压缩包和压缩炸弹；
- 目标格式不支持交互题、子任务依赖或内部附件时正确阻止或警告；
- 普通用户不能导入、导出他人题目或比赛；
- 任务创建后权限撤销，后台读取和下载都失败；
- 批量导入中单题失败不留下半成品，成功题有完整审计记录。
- 上传、预览、任务创建、单题导入完成、导出完成和下载的审计失败路径不泄露内容，也不留下无审计的成功状态。
