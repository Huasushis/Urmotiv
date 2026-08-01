# 历史题目迁移工具

历史资料可能是一份文件含多题，也可能一道题分散在多份文件中。工具不会从文件名、题名或排列顺序猜对应
关系，而是先建立只含安全编号和摘要的清单，再由人明确选择片段、组成题目分组。分组确认和候选内容批准
是两次不同确认；模型生成的候选不会直接成为可导入题目包。

“内容摘要”是完整内容的 SHA-256 指纹。源文件、片段、元数据或分组顺序只要发生变化，旧确认就会失效。

## 安全红线

- 历史题目、表格、位置清单、确认文件、候选、题目包和作者映射只放在服务器非 Git 私有目录中。
- 不根据文件名开头的数字、题名、作者、目录或模型输出顺序自动配对。元数据题号和每个片段的归属都由人
  明确填写。
- 允许“一文件多题”和“一题多文件”，但必须用明确的文本范围、压缩包安全条目或完整文本片段表达。
  同一片段用于多组、两个片段互相重叠时，还要逐项填写共用确认；工具不会静默去重。
- 原路径只写进 `source-locations.private.json`。`inventory.json`、物化报告和命令行输出只含安全编号、
  摘要、计数和大小，不含原文件名、题名、学号或正文。
- 清单会拒绝符号链接、特殊文件、不安全路径、大小写或 Unicode 冲突路径。ZIP 在读取任何条目前检查路径
  跳出、链接、设备、重复/冲突路径、加密、Zip64、嵌套压缩包、压缩炸弹、大小与 CRC 完整性。
- 单个源文件最多 128 MiB，本批源文件原始大小合计最多 512 MiB，最多 10,000 个源文件。真正送入后续
  整理流程的单题文本最多 2,000,000 个 UTF-8 存储字节、500,000 个 JavaScript 字符单位；超限直接
  拒绝，不截断。
- 所有输出都要求新路径。工具先写私有临时文件再发布，遇到同名文件立即停止，不覆盖上次结果。只有带
  `*_COMPLETE` 标记的目录才是完整结果。
- 作者学号只写入 `--author-map-out` 指定的独立私有文件。如果模型结果或难度文字带出已知学号或原文件
  路径，工具会停止。

以下示例用 `<private-root>/history` 代表部署约定的非 Git 私有目录。不要把它替换成仓库中的跟踪目录，也
不要用 shell 的 `source` 或 `.` 读取模型密钥。

## 0. 解析私有元数据

`parse-metadata.py` 用 Python 标准库读取 `.xlsx`，主动丢弃 QQ 号与审核人列。输出仍含作者学号，所以
`metadata.json` 仍是私有文件。

```bash
python3 scripts/migrate-hist/parse-metadata.py \
  <private-root>/history/list.xlsx \
  <private-root>/history/metadata.json
```

## 1. inventory：建立源清单

源目录只放这一批要核对的原始资料，输出必须在源目录之外：

```bash
apps/api/node_modules/.bin/tsx apps/api/scripts/migrate-hist.ts inventory \
  --private-root <private-root> \
  --source <private-root>/history/originals \
  --out <private-root>/history/catalog-001
```

输出包括：

- `inventory.json`：安全编号、类型、字节数、字符数或 ZIP 条目安全编号及摘要，不含原路径；
- `source-locations.private.json`：安全编号到原相对路径的私有对照，只供人工查看和后续复核；
- `manual-review.json`：只含仍需人工处理的安全编号和固定原因码，不含原路径或正文；
- `INVENTORY_COMPLETE`：完整写完标记及安全计数。

`.md`、`.txt` 会作为 UTF-8 文本登记；通过完整安全检查的 ZIP 会按条目登记；PDF、图片和其他二进制文件
只登记为待人工处理的完整文件，不会自动提取或猜题目。扩展名虽然是 ZIP、但未通过严格安全检查的旧文件
也只作为不透明完整文件进入人工队列，不会放宽检查或尝试解压。

如果个别文件无法作为普通文件安全读取或超过源文件上限，命令返回失败，且不会写出 `inventory.json` 或
完成标记。新输出目录中只保留
`inventory-failures.private.json` 和 `INVENTORY_FAILED`：终端仍不显示原路径，失败文件的安全编号、
原路径、固定错误码和不含正文的失败原因码只写在权限收紧的私有失败清单中，供人工定位后换一个新输出
目录重试。

## 2. 人工编写分组计划

对照私有位置清单、原资料和 `metadata.json`，新建 `grouping-plan.private.json`。计划只写选择范围，不用
人手计算摘要：

```json
{
  "version": 1,
  "fragments": [
    {
      "fragmentId": "fragment-000001",
      "sourceId": "source-000001",
      "selection": { "kind": "text_range", "start": 0, "end": 1200 }
    },
    {
      "fragmentId": "fragment-000002",
      "sourceId": "source-000002",
      "selection": { "kind": "zip_entry", "entryId": "entry-000003" }
    }
  ],
  "groups": [
    {
      "groupId": "group-000001",
      "metadataNumber": "元数据中的题号",
      "fragmentIds": ["fragment-000001", "fragment-000002"]
    }
  ],
  "sharingConfirmations": []
}
```

文本范围从 0 开始，左闭右开；计数方式与页面编辑器一致，通常一个汉字算 1，大多数表情符号算 2。
`whole_file` 只适用于能够完整解码为非空 UTF-8 文本的普通文件。当前不自动执行 `pdf_pages`；PDF 或图片
必须先在私有目录人工转成经过复核的文本，再重新建立清单。

如果同一片段确实要用于两个题目组，加入：

```json
{
  "kind": "shared_fragment",
  "fragmentId": "fragment-000001",
  "groupIds": ["group-000001", "group-000002"],
  "confirmed": true
}
```

如果两个文本范围、PDF 页段、相同 ZIP 条目或完整文件互相重叠，加入：

```json
{
  "kind": "overlapping_fragments",
  "fragmentIds": ["fragment-000001", "fragment-000002"],
  "confirmed": true
}
```

每项真实共用都要有且只能有一条确认；多余确认同样会被拒绝。每个已定义片段必须进入至少一个组，同一条
元数据不能分给多个组。

## 3. seal-grouping：由当前内容补齐片段摘要

```bash
apps/api/node_modules/.bin/tsx apps/api/scripts/migrate-hist.ts seal-grouping \
  --private-root <private-root> \
  --source <private-root>/history/originals \
  --inventory <private-root>/history/catalog-001/inventory.json \
  --source-locations <private-root>/history/catalog-001/source-locations.private.json \
  --metadata <private-root>/history/metadata.json \
  --plan <private-root>/history/grouping-plan.private.json \
  --out <private-root>/history/grouping-001.private.json
```

这一步重新扫描整个源目录、复核源文件与 ZIP 条目摘要，并验证每个选择范围。输出正式分组文件，给每个片段
补上由实际内容计算的摘要；它仍未得到人工确认。

## 4. confirm-grouping：单独确认正式分组

完整阅读正式分组并与原资料、元数据逐项核对后，才运行：

```bash
apps/api/node_modules/.bin/tsx apps/api/scripts/migrate-hist.ts confirm-grouping \
  --private-root <private-root> \
  --inventory <private-root>/history/catalog-001/inventory.json \
  --metadata <private-root>/history/metadata.json \
  --grouping <private-root>/history/grouping-001.private.json \
  --out <private-root>/history/grouping-confirmation-001.private.json \
  --i-have-reviewed
```

`--i-have-reviewed` 不能省略。确认同时锁定源清单、完整元数据文件、片段集合、分组与片段顺序。

## 5. materialize：生成一题一文件的确认文本

```bash
apps/api/node_modules/.bin/tsx apps/api/scripts/migrate-hist.ts materialize \
  --private-root <private-root> \
  --source <private-root>/history/originals \
  --inventory <private-root>/history/catalog-001/inventory.json \
  --source-locations <private-root>/history/catalog-001/source-locations.private.json \
  --metadata <private-root>/history/metadata.json \
  --grouping <private-root>/history/grouping-001.private.json \
  --grouping-confirmation <private-root>/history/grouping-confirmation-001.private.json \
  --out <private-root>/history/materialized-001
```

物化前再次扫描整个源目录并核对源文件、ZIP 条目、片段摘要和人工确认。输出包括：

- `sources/source-000001.md`：按人工顺序合并的一题一文件文本，只使用安全文件名；
- `source-confirmation.private.json`：后续 `prepare`/`package` 使用的第一份源映射确认；
- `report.json`：只含安全编号、摘要、长度、计数和状态；
- `MATERIALIZE_COMPLETE`：完整写完标记。

报告会明确给出仍未进入任何片段的源文件数量。只要数量不为零，就不能声称这一批历史资料已全部处理。

## 6. prepare：调用模型生成待批准候选

在把私有题面或题解发送给外部模型前，必须先取得用户明确许可。不要用 shell 解释环境文件；使用 Fermata
仓库的安全启动脚本：

```bash
node ../Fermata/scripts/run-with-env.mjs <private-model-env> \
  apps/api/node_modules/.bin/tsx apps/api/scripts/migrate-hist.ts prepare \
    --private-root <private-root> \
    --source <private-root>/history/materialized-001/sources \
    --metadata <private-root>/history/metadata.json \
    --source-confirmation <private-root>/history/materialized-001/source-confirmation.private.json \
    --out <private-root>/history/prepared-001
```

该阶段只产生候选 JSON、只含安全摘要的 `review.json` 和 `PREPARE_COMPLETE`，不会产生 ZIP。模型置信度
只帮助安排复核顺序，不代表批准。每次请求最多等待 600 秒，失败最多尝试 3 次；响应和单个候选 JSON
超过 10,000,000 字节会拒绝，不截断。

## 7. 人工批准候选内容

逐题阅读候选后，把 `candidateId` 与 `contentSha256` 原样写入第二份确认文件：

```json
{
  "version": 1,
  "confirmed": true,
  "approvals": [
    {
      "candidateId": "candidate-000001",
      "contentSha256": "候选文件中记录的 64 位摘要",
      "decision": "approved"
    }
  ]
}
```

修改候选后摘要会变化，必须重新阅读并填写新摘要。分组确认、源映射确认和候选批准不能共用。

## 8. package：批准后生成题目包

```bash
apps/api/node_modules/.bin/tsx apps/api/scripts/migrate-hist.ts package \
  --private-root <private-root> \
  --source <private-root>/history/materialized-001/sources \
  --metadata <private-root>/history/metadata.json \
  --source-confirmation <private-root>/history/materialized-001/source-confirmation.private.json \
  --prepared <private-root>/history/prepared-001 \
  --approval <private-root>/history/candidate-approval.private.json \
  --out <private-root>/history/packages-001 \
  --author-map-out <private-root>/history/author-map-001.private.json
```

打包前再次读取物化文本并核对摘要。题目包报告不含题名、原题号、作者或正文；作者映射在输出目录之外的
独立私有文件中，并绑定候选摘要、题目包摘要和整批摘要。

本工作流能安全处理 UTF-8 文本和安全 ZIP 中明确选择的 UTF-8 文本条目。PDF、图片、评测数据、附件、
二进制文档和无法明确划分的混合资料仍需人工处理，不能因为已有安全清单就称为完成真实历史题目的全部迁移。
