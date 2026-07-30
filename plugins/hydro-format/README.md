# Hydro 题目包格式适配器

这个内置插件在 Urmotiv 的统一题目结构与 Hydro 题目包之间转换。它只处理单道题：导入时读取一个题目目录，导出时生成一个题目目录中的文件清单，外层后台任务再负责创建 ZIP 文件。

## 支持的 Hydro 文件

按 Hydro 官方仓库当前的导入与下载实现，本适配器识别下列单题目录内容：

```text
<题目目录>/
  problem.yaml
  problem.md 或 problem_语言.md
  solution/*.md
  testdata/
    config.yaml
    <数据点、判断程序或交互程序>
  additional_file/
  std/
```

`problem.yaml` 至少需要 `title`。题面优先读取 `problem.md`；有多份语言题面时，预览会提示，导入必须明确选择其中一份。`testdata/config.yaml` 中的时间、内存、数据点、子任务、判断程序和交互程序会转换为 Urmotiv 的评测配置。普通题缺少输出文件、交互题缺少交互程序、提交答案题缺少自定义判断程序时会停止导入，不会猜测含义。

Hydro 的题面是普通 Markdown。适配器会识别 `Background`、`Description`、`Format`、`Samples`、`Limitation` 和 `Hint` 这些一级分区；未识别的分区保留在基础题面中，并在预览中提示。样例使用 Hydro 常见的 `input1`、`output1` 代码块；样例解释在导出时写成题面中的解释小节。

## 数据如何流动

- 导入前，核心先完成压缩包安全检查。适配器只接收这个已检查的文件清单，不能自行解压或执行包内程序。
- Hydro 的题号、0 到 10 难度和 Hydro 专用配置保存为带 `hydro` 来源标记的扩展信息。再次导出 Hydro 时会优先恢复这些信息。
- 题面、题解、数据点、公开附件和标准程序进入 Urmotiv 的对应分区。Hydro 没有内部附件的可见范围概念，因此含内部附件的导出会被阻止。
- 适配器不读取数据库、不检查或授予权限，也不创建后台任务；这些由 API 与后台任务在服务端完成。

## 导出前的确认

导出前会产生丢失信息报告。以下情况需要处理后才能导出：

- 评测配置引用的文件被排除；
- 要导出的文件在 Hydro 的单层目录中重名；
- 内部附件会变成公开附件；
- 使用特殊判断、交互或提交答案题，但没有明确 Hydro 运行判断程序的类型；
- 总分、子任务计分方式或数据点归属无法被 Hydro 表达。

Hydro 不能直接表达的本站难度会报告为警告，不会擅自换算。资源文件会放入 `additional_file/`，题面需要使用 Hydro 的 `file://文件名` 引用方式时会给出提示。

## 安全与失败影响

所有 ZIP 路径、重复名、大小写冲突、符号链接、嵌套压缩包、压缩比例和文件数量由核心题目包组件在读取内容前检查。适配器还会拒绝不安全的 Hydro 文件名、未知目录层级、缺失的配置引用和无法明确归类的多题压缩包。失败只返回文件位置和简短原因，不返回题面、题解或测试数据内容。

禁用插件后，已经导入题目的核心字段仍可读；仅 Hydro 来源扩展信息不会再用于格式转换。插件没有设置项、没有密钥，也不声明任何权限。

## 格式依据与许可证

格式依据是 Hydro 官方仓库 [`hydro-dev/Hydro`](https://github.com/hydro-dev/Hydro)，校对提交为 `591dbd31c00ac54aa0381a85eed375c25f6bd829`（2026-07-25）。重点核对了：

- `packages/hydrooj/src/model/problem.ts` 的题目导入、导出目录和文件名逻辑；
- `packages/ui-default/components/zipDownloader/index.ts` 的网页下载文件布局；
- `packages/common/types.ts` 的 `ProblemConfigFile` 字段。

Hydro 仓库采用 **AGPL-3.0-or-later OR Proprietary**。本插件没有复制 Hydro 的源代码、题目、测试数据或资源文件；这里只根据公开格式行为编写独立实现。使用者如计划复制、修改或分发 Hydro 本身的代码，应自行遵守 Hydro 的许可证。

`test/fixtures.ts` 中的题目、题面、数据点和程序文本均为人工构造的最小公开测试夹具，不来自任何 OJ 或协会资料。
