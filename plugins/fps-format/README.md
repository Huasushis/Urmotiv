# FPS XML 题目包格式适配器

这个内置插件在 Urmotiv 的统一题目结构与 FPS XML 之间转换。它只处理`未解压的单个原始 XML`
（`single_file`）：导入时读取固定路径 `problem.xml`，导出时生成单个原始 XML 文件，不再包 ZIP。
当前支持范围和外部互操作证据边界见 [OJ 题目包兼容性文档](../../docs/oj-compatibility.md)。

## 支持的 FPS 内容

按上游 [`fps.current.dtd`](https://github.com/zhblue/freeproblemset/blob/7782b3815fd40f5bba95b5d7b90e3fbefafae656/fps.current.dtd)
（固定提交 `7782b3815fd40f5bba95b5d7b90e3fbefafae656`，2026-05-20）定义的最小交集：

- `fps` 根元素下的恰好一个 `item`；`generator*` 只作名目信息，不会导入；
- `title`、`url?`、`time_limit+`、`memory_limit+`、`description`、`input?`、`output?`、`hint?`；
- `sample_input*` 与 `sample_output*`（按出现顺序配对，数量不一致时拒绝）；
- `test_input*` 与 `test_output*`（必须有 `name`，按名称配对，生成测试数据文件）；
- `solution*`、`prepend*`、`template*`、`append*`、`spj?`、`tpj?`、`interactor?` 的程序正文；
- `img*` 的 `src+base64` 内嵌图片；
- `source?`、`remote_oj?`、`remote_id?` 来源信息。

`fps@version` 和 `fps@url` 只是可选文本，不参与语义判断；本站不根据版本号猜测字段或单位行为。

## 数据如何流动

- 导入前，核心已完成原始 XML 的 UTF-8 和安全文件名检查；适配器只接收这个已经检查的文件，
  不自行解压或执行包内程序。
- `description`/`input`/`output`/`hint`/`title` 映射到本站题面字段；样例映射到样例。
- FPS 没有标签、难度、子任务、依赖、计分结构，导入不编造这些值。
- FPS 的时间、内存限制文本转换为毫秒/MiB 后只随来源信息保留；本站不能在没有分数结构的情况下
  发明评测配置，因此 FPS 导入不生成评测配置，也不猜测评测命令行行为。
- `solution` 是程序正文（带语言），`prepend/template/append` 和 `spj/tpj/interactor` 是评测程序正文；
  统一结构没有它们的无损对应项，全部只写入带 `fps` 来源标记的扩展中，再次导出 FPS 时恢复。
- `img` 解码为资源文件进入 `assets/`，引用路径重新检查。
- 适配器不读取数据库、不检查或授予权限，也不创建后台任务；这些由 API 与后台任务在服务端完成。

## 导入拒绝条件

- 根元素不是 `fps`，或包含 `DOCTYPE`/`ENTITY` 声明；
- `item` 数量不是恰好一道（0 道或多道都被拒绝，不默默取第一道）；
- `title`/`description`/`time_limit`/`memory_limit` 缺失或重复，或其他元素重复；
- 未声明的 FPS 元素或属性、不受支持的时间/内存单位、非十进制正数的限制值；
- `sample_input` 与 `sample_output` 数量不一致；
- `test_input`/`test_output` 缺少 `name`、名称不安全、以 `.out` 结尾会造成输出混淆、映射后重复；
- `solution`/`prepend`/`template`/`append` 缺少语言属性；
- `img` 的 `src` 不安全、base64 无法解码，或不是恰好一个 `src` 和一个 `base64`。

失败只返回文件位置和简短原因，不返回题面、题解、测试数据或程序正文。

## 导出前确认

导出前会产生丢失信息报告：

- 无法表达的字段（约束、背景）和本站标签、难度、样例解释写成警告，不写入导出包；
- 内部或公开附件会改变可见范围，阻止导出；
- 交互型、提交答案型或特殊判断（`spj`/`interactor`/`tpj`）只有原包保存了程序正文时才能导出；
- 独立的标准程序文件只有原包保存了 solution 程序正文时才能导出；
- 有测试数据但没有评测配置和来源信息时无法确定成对名称，阻止导出。

## 格式依据与许可证

格式依据是上游 [`zhblue/freeproblemset`](https://github.com/zhblue/freeproblemset) 的
`fps.current.dtd`，固定提交 `7782b3815fd40f5bba95b5d7b90e3fbefafae656`（2026-05-20）。
上游仓库标为 LGPL-3.0；README 对准确兼容和衍生格式另有说明。本插件是独立实现，不复制上游代码、
题目、数据或程序。测试只使用本仓库人工构造的最小合成夹具；其中题目、题面、数据点和程序文本
不来自任何 OJ 或协会资料，不能称为 FPS 真实导出样例或外部互操作证据。

解析时使用禁用 DTD/实体声明的安全配置（对 `DOCTYPE`/`ENTITY` 直接拒绝），不解析外部实体，
不访问外部网络或本地文件。「支持」只表示格式转换能力，不表示有权复制、公开或再分发包内题面、
数据、程序或附件。
