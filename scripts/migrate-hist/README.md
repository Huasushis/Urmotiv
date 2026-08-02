# 历史题目迁移工具

历史资料可能是一份文件含多题，也可能一道题分散在多份文件中。工具不会从文件名、题名或排列顺序猜对应
关系，而是先建立只含安全编号和摘要的清单，再由人明确选择片段、组成题目分组。分组确认和候选内容批准
是两次不同确认；模型生成的候选不会直接成为可导入题目包。

“内容摘要”是完整内容的 SHA-256 指纹。源文件、片段、元数据或分组顺序只要发生变化，旧确认就会失效。

本版把私有位置清单升级为路径链格式（`version: 2`），完整登记标记升级为 `version: 3`，并完全移除了
自填难度元数据（包括旧 `difficultyGuess`、`difficultyText` 和过渡版本字段）。旧清单、旧元数据和由它们
生成的分组确认不能接着使用；请原样保留旧报告作为证据，再用新的输出目录重新执行元数据解析、清单和
人工核对。工具不会自动改写旧确认。

## 安全红线

- 历史题目、表格、位置清单、确认文件、候选、题目包和作者映射只放在服务器非 Git 私有目录中。
- 不根据文件名开头的数字、题名、作者、目录或模型输出顺序自动配对。元数据题号和每个片段的归属都由人
  明确填写。
- 允许“一文件多题”和“一题多文件”，但必须用明确的文本范围、压缩包安全条目或完整文本片段表达。
  同一片段用于多组、两个片段互相重叠时，还要逐项填写共用确认；工具不会静默去重。
- 原路径和嵌套 ZIP 的逐层路径链只写进 `source-locations.private.json`。`inventory.json`、物化报告和
  命令行输出只含安全编号、摘要、计数和大小，不含原文件名、题名、学号或正文。
- 清单会拒绝符号链接、特殊文件、不安全路径、大小写或 Unicode 冲突路径。ZIP 在读取任何条目前检查路径
  跳出、链接、设备、重复/冲突路径、加密、Zip64、压缩炸弹、大小与 CRC 完整性。历史资料额外只允许
  “外层批量 ZIP -> 一层单题 ZIP -> 普通文件”，根 ZIP 算第一层；更深嵌套固定进入人工队列。条目数、
  全部层级累计解压大小和从根包计算的累计压缩比例也有统一上限，不能用多个分别合规的内层包绕过。
  外层包内也只有扩展名明确为 `.zip` 的条目才递归；`.xlsx`、`.docx` 等 ZIP 容器仍是普通附件叶子。
  内层 `.zip` 无法完整解析或没有普通叶子时，整份源进入人工队列，不会把它当附件或静默略过。
- 只有扩展名明确为 `.zip` 的源文件会进入上述历史压缩包流程。`.xlsx`、`.docx` 等格式虽然内部也是 ZIP
  容器，仍作为不透明人工源登记，不会被误拆成题目文件。这个历史专用流程不会放宽正式题目包格式；正式
  导入仍拒绝嵌套压缩包。
- 单个源文件最多 128 MiB，本批源文件原始大小合计最多 512 MiB；源文件和所有 ZIP 声明记录合计最多
  5,000 项。真正送入后续
  整理流程的单题文本最多 2,000,000 个 UTF-8 存储字节、500,000 个 JavaScript 字符单位；超限直接
  拒绝，不截断。
- 所有输出都要求新路径。工具先写私有临时文件再发布，遇到同名文件立即停止，不覆盖上次结果。只有带
  `*_COMPLETE` 标记且标记内摘要与同阶段报告、清单和文本重新计算结果一致的目录才是完整结果。
- 作者学号只写入 `--author-map-out` 指定的独立私有文件。如果模型结果带出已知学号或原文件路径，工具
  会停止。

以下示例用 `<private-root>/history` 代表部署约定的非 Git 私有目录。不要把它替换成仓库中的跟踪目录，也
不要用 shell 的 `source` 或 `.` 读取模型密钥。

## 0. 解析私有元数据

`parse-metadata.py` 用 Python 标准库读取一份或多份 `.xlsx`，完全丢弃投题者自填难度、QQ 号和全部审核意见
列；这些列不进入 `metadata.json`，也不参与后续元数据摘要。输出仍含作者学号，所以 `metadata.json` 仍是
私有文件。旧难度字段会被严格格式校验拒绝。为避免题名中夹带的自报分数绕过这条规则，整理模型只收到
人工物化后的源文本，不收到元数据题名或其他元数据字段。任何输入表（包括后追加的第二份题目表）中的
投题者自报难度都不是真值；Fermata 难度准确性标定不得读取或引用它，后续难度必须来自独立人工复核或
可靠标定。

命令行把最后一个参数视为新建的输出 JSON，其前面一个或多个参数都视为输入 XLSX。记录先按命令行给出的
文件顺序合并，每个文件内再按工作表行顺序保留；不会按题号或文件名重排。所有输入合计最多 10,000 条
记录，规范化后的题号必须在全部文件间唯一；跨文件重复也会让整次命令失败，且不产生输出。

```bash
python3 scripts/migrate-hist/parse-metadata.py \
  <private-root>/history/list-older.xlsx \
  <private-root>/history/list-newer.xlsx \
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
- `INVENTORY_COMPLETE`：完整写完标记、三份文件各自的摘要和安全计数。

后续每一步都会先重新计算 `inventory.json`、`source-locations.private.json` 和 `manual-review.json` 的摘要，
并与 `INVENTORY_COMPLETE` 比较。只复制其中一份文件、手工修改人工队列或使用旧版不含这些摘要的标记都
会失败；不能把不同清单目录中的文件拼成一次登记结果。

`.md`、`.txt` 会作为 UTF-8 文本登记；通过完整安全检查的 `.zip` 会按最终普通文件条目登记，内层 ZIP
容器本身不会成为可选题目片段；PDF、图片、表格和其他二进制文件只登记为待人工处理的完整文件，不会自动
提取或猜题目。扩展名虽然是 ZIP、但未通过严格安全检查的旧文件也只作为不透明完整文件进入人工队列，
不会放宽检查或尝试解压。

旧 ZIP 的非 ASCII 文件名没有明确声明 UTF-8 时，核心读取器固定拒绝。确需迁移时，在隔离的私有目录中逐包
转换：先锁定原包摘要，再由人工明确选择一种旧编码；使用经过审阅且同样限制路径、链接、条目数、解压总量
和压缩比例的离线工具，只把人工确认需要的文本转成新的 UTF-8 `.md`/`.txt`；记录原摘要、转换后摘要、所选
编码和 `confirmed: true`。原包和转换文本一起重新建立清单，通过 `manualSourceDispositions.converted`
明确关联。禁止自动猜编码、直接改核心 ZIP 解码规则，或把重新打包后的文件冒充原包。

如果个别文件无法作为普通文件安全读取或超过源文件上限，命令返回失败，且不会写出 `inventory.json` 或
完成标记。新输出目录中只保留
`inventory-failures.private.json` 和 `INVENTORY_FAILED`：终端仍不显示原路径，失败文件的安全编号、
原路径、固定错误码和不含正文的失败原因码只写在权限收紧的私有失败清单中，供人工定位后换一个新输出
目录重试。

## 2. init-grouping：生成空白核对材料

先生成一个新的空白工作目录：

```bash
apps/api/node_modules/.bin/tsx apps/api/scripts/migrate-hist.ts init-grouping \
  --private-root <private-root> \
  --inventory <private-root>/history/catalog-001/inventory.json \
  --source-locations <private-root>/history/catalog-001/source-locations.private.json \
  --metadata <private-root>/history/metadata.json \
  --out <private-root>/history/worksheet-001
```

输出的 `worksheet.json` 只列元数据、文本源、压缩包及条目的安全编号和必要计数；
`grouping-plan.skeleton.private.json` 是所有数组均为空的计划骨架；
`grouping-validation.initial.json` 用安全编号列出尚未处理的类别和范围。三者都不含原路径、题号、题名、
正文或自动匹配建议。`WORKSHEET_COMPLETE` 固定写有 `reviewed: false`，不能代替之后的
`--i-have-reviewed`。把骨架复制到新的私有计划文件后再人工填写，保留空白原件便于对照。
`metadata-000001` 等编号严格按当前 `metadata.json` 的记录顺序生成；人工对照原元数据确认，不能据此猜测
与同序号源文件相配。元数据重排会改变整文件摘要，使旧分组完成标记和确认失效。

## 3. 人工编写分组计划

对照私有位置清单、原资料和 `metadata.json`，新建 `grouping-plan.private.json`。计划只写选择范围，不用
人手计算摘要：

```json
{
  "version": 2,
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
      "metadataId": "metadata-000001",
      "fragmentIds": ["fragment-000001", "fragment-000002"]
    }
  ],
  "sharingConfirmations": [],
  "metadataDispositions": [],
  "zipEntryDispositions": [],
  "textRangeDispositions": [],
  "manualSourceDispositions": []
}
```

文本范围从 0 开始，左闭右开；计数方式与页面编辑器一致，通常一个汉字算 1，大多数表情符号算 2。
`whole_file` 只适用于清单中 `kind` 明确为 `text` 的非空 UTF-8 文本。人工队列中的 `file`、PDF、图片、
旧 ZIP 或其他不透明文件即使字节碰巧能解码，也不能用 `whole_file` 绕过转换。需要导入其中的文本时，先
在私有目录人工转成并复核新的 `.md`/`.txt`，把原件和转换件一起重新建立清单，再用
`manualSourceDispositions` 的 `convertedSourceId` 明确关联。当前不自动执行 `pdf_pages`。

所有项目必须恰好被选入分组或明确处置：

- 每条元数据必须进入一个组，或用 `metadataDispositions` 明确标为 `deferred`/`ignored`；
- 每个 ZIP 条目必须由 `zip_entry` 选择，或在 `zipEntryDispositions` 中标为
  `deferred`/`attachment`/`ignored`；
- 每个文本字符单位必须落在已选片段或 `textRangeDispositions` 的明确范围内；范围不能重叠，也不能切开
  一个表情等 Unicode 字符的代理项对；
- 每个 `file`/PDF 人工源都必须在 `manualSourceDispositions` 中选择
  `converted`/`deferred`/`attachment`/`ignored`，填写人工理由并写 `confirmed: true`。

每项处置都必须有非空人工理由。安全校验报告只保存理由摘要，不保存理由原文；正式分组和最终人工确认会
绑定理由原文及处置顺序的摘要。`converted` 还要求 `convertedSourceId` 指向本次清单里的文本源，而且该
文本必须实际进入一个题目组，不能只写一个没有使用的安全编号。

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

## 4. seal-grouping：由当前内容补齐片段摘要并验证完整性

```bash
apps/api/node_modules/.bin/tsx apps/api/scripts/migrate-hist.ts seal-grouping \
  --private-root <private-root> \
  --source <private-root>/history/originals \
  --inventory <private-root>/history/catalog-001/inventory.json \
  --source-locations <private-root>/history/catalog-001/source-locations.private.json \
  --metadata <private-root>/history/metadata.json \
  --plan <private-root>/history/grouping-plan.private.json \
  --out <private-root>/history/grouping-001
```

这一步先验证 `INVENTORY_COMPLETE`，再重新扫描整个源目录、复核源文件与 ZIP 条目摘要，并验证每个选择
范围和人工处置。成功目录包括 `grouping.private.json`、只含安全编号的
`grouping-validation.json` 和绑定二者摘要的 `GROUPING_COMPLETE`；正式分组仍未得到人工确认。

只要有未分组元数据、未覆盖文本范围、未选且未处置的 ZIP 条目、未处置人工源，或者根本没有题目组，
命令就失败。失败目录只写安全校验报告与 `GROUPING_INCOMPLETE`，不会写
`GROUPING_COMPLETE`。因此不能再用“未引用源文件数量为 0”代替逐条完整性检查。

## 5. confirm-grouping：单独确认正式分组

完整阅读正式分组并与原资料、元数据逐项核对后，才运行：

```bash
apps/api/node_modules/.bin/tsx apps/api/scripts/migrate-hist.ts confirm-grouping \
  --private-root <private-root> \
  --inventory <private-root>/history/catalog-001/inventory.json \
  --source-locations <private-root>/history/catalog-001/source-locations.private.json \
  --metadata <private-root>/history/metadata.json \
  --grouping <private-root>/history/grouping-001 \
  --out <private-root>/history/grouping-confirmation-001.private.json \
  --i-have-reviewed
```

`--i-have-reviewed` 不能省略。命令先重新验证 `GROUPING_COMPLETE` 和安全报告，再把源清单、私有位置清单、
人工队列、完整元数据文件、片段集合、分组、所有人工处置及完整性报告摘要一起写入确认。任一项变化都会
使确认失效。

## 6. materialize：生成一题一文件的确认文本

```bash
apps/api/node_modules/.bin/tsx apps/api/scripts/migrate-hist.ts materialize \
  --private-root <private-root> \
  --source <private-root>/history/originals \
  --inventory <private-root>/history/catalog-001/inventory.json \
  --source-locations <private-root>/history/catalog-001/source-locations.private.json \
  --metadata <private-root>/history/metadata.json \
  --grouping <private-root>/history/grouping-001 \
  --grouping-confirmation <private-root>/history/grouping-confirmation-001.private.json \
  --out <private-root>/history/materialized-001
```

物化前再次扫描整个源目录并核对源文件、ZIP 条目、片段摘要和人工确认。输出包括：

- `sources/source-000001.md`：按人工顺序合并的一题一文件文本，只使用安全文件名；
- `source-confirmation.private.json`：后续 `prepare`/`package` 使用的第一份源映射确认；
- `report.json`：只含安全编号、摘要、长度、计数和状态；
- `MATERIALIZE_COMPLETE`：绑定安全报告、源映射、全部输出文本集合和分组确认的完整写完标记。

物化前再次验证 `GROUPING_COMPLETE`、完整性报告及人工确认。报告固定要求 `unresolvedItemCount: 0`；延期、
作为附件或忽略的项目仍保留在之前已确认的处置摘要中，不会因为没有进入输出文本而消失。

## 7. prepare：调用模型生成待批准候选

在把私有题面或题解发送给外部模型前，必须先取得用户明确许可。不要用 shell 解释环境文件；使用 Fermata
仓库的安全启动脚本：

```bash
node ../Fermata/scripts/run-with-env.mjs <private-model-env> \
  apps/api/node_modules/.bin/tsx apps/api/scripts/migrate-hist.ts prepare \
    --private-root <private-root> \
    --materialized <private-root>/history/materialized-001 \
    --metadata <private-root>/history/metadata.json \
    --out <private-root>/history/prepared-001 \
    --run-tag history-prepare-20260802-a
```

在创建模型客户端和发出任何请求前，CLI 会重新读取全部物化文本，并验证 `MATERIALIZE_COMPLETE` 与
`report.json`、`source-confirmation.private.json`、输出文件集合的摘要和计数完全一致。缺少标记、报告被
改写、增加/删除文本或混用另一次物化结果都会停止。

该阶段只产生候选 JSON、只含安全摘要的 `review.json` 和 `PREPARE_COMPLETE`，不会产生 ZIP。模型置信度
只帮助安排复核顺序，不代表批准。等待首段有效输出的默认上限为 30 分钟；已经收到有效输出后，连续
10 分钟没有新有效内容才判为停顿。只要仍在持续输出就没有总时限，并一直读取到服务端 HTTP 响应真正
结束。只有明确的 429 限流响应会重试；499、主动取消、输出中断或缺少完整结束都直接判失败且不重试，
不能拿不完整候选继续。响应和单个候选 JSON 超过 10,000,000 字节会拒绝，不截断。

`--run-tag` 是本次付费操作的唯一标签。私有检查点只保存它的摘要，不保存标签原文。工具会在每次 HTTP
请求前同步写入不可覆盖的 `active` 登记，绑定源内容、代码、提示词、模型、配置和本次操作身份的安全摘要；
代码身份由运行时实际读取的 prepare、传输、结构校验、摘要和私有文件安全实现字节共同计算，不依赖人工
记得修改版本字符串。
只有读到服务端真正的 HTTP 正文结束、协议与候选结构都通过后，才写入 `completed`。HTTP 状态（499 单列）、
取消、连接、首段超时、输出停顿、协议、结构、非完整 EOF、JSON、UTF-8 和超限等失败只以固定原因码写入，
不保存响应正文或底层异常。

任何失败或无法确认结束的请求都会永久使该输出目录保持不完整；工具会保留 `PREPARE_INCOMPLETE`、逐题
请求登记和每次运行的安全计数报告，不再删除未完成输出。进程中断后，可以用完全相同的输入、运行标签、
代码、提示词、模型和配置，加 `--resume` 续跑：

```bash
node ../Fermata/scripts/run-with-env.mjs <private-model-env> \
  apps/api/node_modules/.bin/tsx apps/api/scripts/migrate-hist.ts prepare \
    --private-root <private-root> \
    --materialized <private-root>/history/materialized-001 \
    --metadata <private-root>/history/metadata.json \
    --out <private-root>/history/prepared-001 \
    --run-tag history-prepare-20260802-a \
    --resume
```

续跑只处理从未登记开始的题；已经完成、已经失败或只有 `active` 而无法确认是否到达服务端的请求都不会
再次发送。后两类会让整份报告继续保持不完整，需要使用新的输出目录和新的唯一运行标签开启另一轮，不能
在原目录中抹掉证据。旧版没有 `run.json` 和逐题检查点的 prepare 输出不能续跑；尤其迁移前那次调用不能
推断为未发送或已完成，必须保留原目录，并用新输出目录、新标签明确开始新运行。
`package` 同样只接受带新版运行身份、逐题完成链和一致审核清单的 `PREPARE_COMPLETE`；旧版完成标记或与
`PREPARE_INCOMPLETE` 并存的目录会固定拒绝，不能绕过续跑门直接打包。

## 8. 人工批准候选内容

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

## 9. package：批准后生成题目包

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

本工作流能安全处理 UTF-8 文本，以及最多两层历史 ZIP 路径链中明确选择的 UTF-8 文本条目。PDF、图片、
评测数据、附件、二进制文档和无法明确划分的混合资料仍需人工处理，不能因为已有安全清单就称为完成真实
历史题目的全部迁移。审核意见不导入；它们既不进入候选，也不进入最终题目包。
