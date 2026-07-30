# 题目包与 OJ 格式转换规范

## 1. 为什么需要内部统一格式

不同 OJ 对题面、子任务、特殊判断程序和文件名的要求不同。Urmotiv 先把题目转换为一套信息完整的内部结构，
再由每个 OJ 的格式适配器负责读写。这样不会把 Hydro、洛谷或其他系统的字段直接塞进核心数据库。

“导入成功”不等于所有信息都被保留。适配器必须报告目标格式无法表达的内容，用户确认后才能继续。

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

  detect(input: ArchiveSummary): Promise<DetectionResult>;
  inspect(input: SafeArchive): Promise<ImportPreview>;
  import(input: SafeArchive, choices: ImportChoices): Promise<CanonicalProblem>;
  validateExport(problem: CanonicalProblem, options: ExportOptions): Promise<LossReport>;
  export(problem: CanonicalProblem, options: ExportOptions): Promise<GeneratedArchive>;
}
```

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
- 实现前必须以 Hydro 当前仓库代码、官方文档和真实导出样例为准，不凭记忆写文件名。
- 适配器测试保存人工构造或开源许可允许的最小样例，不能使用协会私有题目。
- 对 Hydro 特有但 Urmotiv 暂无对应项的设置保存在带来源标记的扩展字段中；再次导回 Hydro 时可恢复。
- Urmotiv 有而 Hydro 不能表达的字段进入丢失信息报告，不能写进随意命名的配置项让 Hydro 忽略。

### 4.3 后续格式

第二个通用格式优先评估 FPS XML，因为多个 OJ 能交换这种格式；Polygon、QDUOJ、UOJ 等按真实使用需求增加。
每增加一种格式都要提供格式来源、许可证说明、最小导入样例、最小导出样例和往返测试。

## 5. 导入流程

1. 上传到隔离临时目录；计算总大小和摘要。
2. 安全扫描：只接受普通文件，拒绝绝对路径、`..`、符号链接、设备文件、重名规范路径和过深目录。
3. 限制解压后总大小、单文件大小、文件数和压缩比例；超过限制直接拒绝。
4. 用户选择格式或由检测结果建议，不以最低置信度自动执行。
5. 适配器生成预览：题目数、字段映射、文件列表、错误、警告和需要选择的冲突。
6. 用户确认后创建后台任务。任务使用一次性输入快照，防止上传内容被替换。
7. 每道题在独立数据库事务中创建；批量导入允许其他题继续，但报告每题成功或失败。
8. 临时文件按保留期清理，日志只保存摘要、数量和错误位置，不保存正文。

标准 OJ 包不得调用 LLM 才能导入。只有“历史资料迁移”可以选择 LLM 辅助，并且辅助结果必须人工确认。

## 6. 导出流程

1. 用户选择题目、固定修订版本和文件类别。
2. 服务端确认每道题的题面、内部资料和比赛权限。
3. 适配器返回丢失信息报告，按严重程度分为：阻止导出、需要选择、可接受降级、提示。
4. 用户确认后创建后台任务；任务开始和读取每个文件时再次检查权限。
5. 文件写入隔离目录，生成校验值后整体上传到对象存储。
6. 下载使用短期地址；每次换取地址都重新检查用户和任务权限。
7. 到期后删除导出包。审计记录保留题号、版本、目标格式、操作者和结果，不保存包内容。

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
- 难度区间取中点后再取最近整百，并保留原始文本作为迁移备注；
- 审核人之后难以追踪的表格列不导入；
- 全程使用私有目录和私有任务队列，任何样例、快照和错误报告不得提交到 Git。

## 9. 测试清单

- 原生包完整往返，字段和 SHA-256 校验值一致；
- Hydro 官方或开源许可样例导入、导出和可接受的往返；
- 缺失输出、重复路径、大小写冲突、空文件、超限文件数；
- `../`、绝对路径、反斜杠绕过、符号链接、嵌套压缩包和压缩炸弹；
- 目标格式不支持交互题、子任务依赖或内部附件时正确阻止或警告；
- 普通用户不能导入、导出他人题目或比赛；
- 任务创建后权限撤销，后台读取和下载都失败；
- 批量导入中单题失败不留下半成品，成功题有完整审计记录。
