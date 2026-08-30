# 题目包与格式适配器参考

Urmotiv 的导入/导出先经过统一安全层，再交给已启用的受信任格式插件。安全层负责归档读取、权限、任务、审计和对象存储；格式插件只负责字段转换，不能读数据库、授予权限、创建后台任务或执行题目包中的程序。

## 当前支持的输入

- `hydro`：Hydro 题目目录，作为 ZIP 上传。既可在根目录放一道题，也可在 ZIP 根部放多个直属题目目录；每个目录识别 `problem.yaml`、`problem.md`/语言题面、`solution/`、`testdata/config.yaml`、`additional_file/` 和 `std/` 等受支持文件。
- `fps`：FPS XML 原始文件，使用 `single_file` 输入类型；一个 XML 可包含多个 `item`，上传内容必须是严格 UTF-8 且安全的 XML，不会把 XML 再包成 ZIP。

两种格式都只处理一题。当前格式插件默认可以处于停用状态；导入/导出前，在 `/admin` 确认相应插件已启用且版本与任务绑定一致。任务排队后插件停用、升级或清单改变，会以固定的“格式当前不可用”失败，不会静默换用另一份实现。

## 统一导入流程

1. `POST /api/v1/transfer/uploads` 以 `application/octet-stream` 上传；查询参数 `originalName` 只用于检测，不直接作为解压路径。
2. 核心安全层区分 ZIP 与原始 XML：`.xml` 文件按单文件 XML 检查，其他文件名按 ZIP 检查；不会因为内容猜测而切换另一种解释。
3. ZIP 只允许普通文件和 UTF-8、`/` 分隔的相对路径；拒绝绝对路径、`..`、反斜杠、符号链接、设备文件、重复规范路径、嵌套压缩包和压缩炸弹。
4. 检查条目数、单文件/总解压大小、压缩比、文件名和媒体类型；失败只返回固定错误位置和简短原因，不返回题面、题解、测试数据或程序正文。
5. 选择格式后调用适配器 `detect`、`inspect` 生成预览。预览只列出题目数、文件清单、字段映射、警告和错误，不写数据库。
6. 用户确认冲突策略后创建异步任务。任务固定输入文件摘要、格式 ID、适配器版本和幂等键；Worker 执行时重新检查插件仍受信任且启用。
当前题目包解析器默认边界：上传原始包不超过 128 MiB，ZIP 解压后总量不超过 128 MiB，单文件不超过 128 MiB，条目不超过 10,000 个，路径深度不超过 16、路径长度不超过 240 个字符，压缩比不超过 200；嵌套归档被拒绝。API 的一般文件请求体上限为 512 MiB，但更大的题目包仍会被题目包安全层拒绝；内置 Web nginx 默认请求体上限为 128 MiB。

## 统一导出流程

1. 选择可见题目、固定修订和目标格式；可选公开附件、内部附件、测试数据、评测程序和标准程序。
2. 服务端先确认题目状态、文件权限和选择内容，再调用适配器 `validateExport` 生成丢失信息报告。
3. 报告中的 `error` 会阻止导出；`warning` 说明目标格式无法无损表达但用户可以确认；不把内部附件自动转成公开附件。
4. 创建任务时固定题目修订、所选文件类别、输入摘要、适配器 ID/版本和幂等键。Worker 写出前再次检查所有文件和路径。
5. 单题 ZIP 适配器输出单题文件集合后由 Worker 生成 ZIP；`single_file` 适配器直接输出 XML。多题下载才由 Worker 生成外层 ZIP，不能混合 ZIP 与原始单文件。
6. 下载地址短期有效，每次换取下载都重新检查题目、任务和文件权限。过期任务/权限撤销不会被旧地址绕过。

默认导出不包含作者联系方式、审核意见、访问记录、权限、比赛信息、内部令牌、插件私有设置或内部附件。具体选择仍以预览中的权限与损失报告为准。

## 适配器接口

格式插件通过 `@urmotiv/plugin-sdk` 注册如下接口：

```ts
interface ProblemFormatAdapter {
  id: string;
  displayName: string;
  version: string;
  inputKind?: "zip" | "single_file";

  detect(input: ArchiveSummary): Promise<DetectionResult>;
  inspect(input: SafeArchive): Promise<ImportPreview>;
  import(input: SafeArchive, choices: ImportChoices): Promise<readonly CanonicalProblem[]>;
  validateExport(problem: CanonicalProblem, options: ExportOptions): Promise<LossReport>;
  export(problem: CanonicalProblem, options: ExportOptions): Promise<GeneratedArchive>;
}
```

旧适配器省略 `inputKind` 时按 ZIP 处理；原始文件适配器必须明确写 `single_file`。ZIP 输出是 `{ mediaType, fileName, files }`，单文件输出是 `{ kind: "single_file", mediaType, fileName, content }`。Worker 会再次验证生成的路径和大小，不能把适配器返回的字节直接当成可信 ZIP。

## Hydro 映射要点

Hydro 的 `problem.yaml` 至少需要 `title`；题面从 `problem.md` 或明确选择的语言题面读取。`testdata/config.yaml` 的时间、内存、数据点、子任务、判断程序和交互程序映射到 Urmotiv 评测配置；普通题缺少输出文件、交互题缺少交互程序或提交答案题缺少自定义判断程序时停止导入，不猜测含义。

Hydro 的题面分区包括 `Background`、`Description`、`Format`、`Samples`、`Limitation`、`Hint`；未知分区保留并在预览中提示。Hydro 没有内部附件的可见范围概念，含内部附件的导出会被阻止。本站难度不能表达时只报告警告，不擅自换算。

## FPS XML 映射要点

FPS 输入必须有至少一个 `fps/item`，多个 `item` 会按出现顺序分别导入；不接受 `DOCTYPE`/`ENTITY`。支持题名、时间/内存限制、题面、样例、测试输入输出、解答程序、前后置程序、特殊判断、交互程序和内嵌图片等当前交集；未声明元素/属性、重复必填元素、配对不一致、危险名称、非正数限制值或无法解码图片会拒绝。

FPS 没有标签、难度、子任务、依赖或计分结构，导入不会编造这些值；时间/内存和不能无损表达的字段会留在来源扩展或损失报告。内部附件会阻止导出；需要特殊判断、交互、答案判断或标准程序时，必须有原始程序正文才能导出。

## 丢失信息报告

报告同时供程序和人阅读，示例是合法 JSON：

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

`severity` 为 `error`、`warning`、`info`；`path` 只用于定位字段，不应包含作者邮箱、学号、对象存储地址或文件正文。

## 失败和安全边界

- 适配器不能执行包内脚本、访问外部网络或读取数据库；任何程序正文都是待转换的字节。
- 失败响应和任务记录只保存固定错误编号、计数、格式 ID/版本、有限路径位置和摘要；不保存题面、题解、测试数据或上游原文。
- 导入目标冲突必须明确选择 `create` 或 `update`；更新前再次检查调用者对目标题目的编辑权。
- 题目包来源摘要、文件摘要和幂等键用于防止重复导入与替换；不能用标题猜测来源或覆盖后来授权修改。
- 预览、创建任务和下载都不能绕过 `404` 的未授权即未找到语义；撤销权限后，后台读取和下载同样失败。

格式依据、许可证和当前互操作证据见[OJ 兼容说明](oj-compatibility.md)。插件注册、启停、测试和发布见[插件开发指南](plugin-development.md)；用户操作见[用户指南](user-guide.md)。
