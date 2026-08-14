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

### 5.1 附件映射完成门

分组中只要有 `action: "attachment"`，必须先运行 `init-attachments`，再逐附件人工填写计划并运行
`seal-attachments`。每个附件都必须保留原来的源绑定摘要，并明确填写受控语义角色、`public`/`internal`
可见性和作用范围。`scope.kind: "problem_groups"` 至少包含一个 target；每个 target 分别填写题目组、元数据
安全编号和安全目标名，题面资源还要逐 target 填原 Markdown 引用。同一附件可以进入多个题目组，同一目标
路径也可在不同题目组中复用，但同一组内不得冲突。`scope.kind: "batch_internal"` 只允许不直接进入题目包的
内部命题/评测候选材料，并进入独立保全清单。无法判断的项目必须写成 `unresolved`；不能省略、默认公开
或当作已忽略。`solution_original` 表示“题解原件”，只允许作为内部附件，不能冒充已经隔离验证的
`standard_solution`。题面资源使用内容摘要命名，并在私有映射中保留原 Markdown 引用到新路径的改写表。
目标扩展名只允许单段 ASCII 字母或数字，严格匹配原生包的 `[A-Za-z0-9]+` 约束；`c++`、`tar.gz` 等不能
直接成为扩展名。人工计划本身必须是权限 `0600` 的普通文件，不能经符号链接读取。

```bash
apps/api/node_modules/.bin/tsx apps/api/scripts/migrate-hist.ts init-attachments \
  --private-root <private-root> --source <private-root>/history/originals \
  --inventory <private-root>/history/catalog-001/inventory.json \
  --source-locations <private-root>/history/catalog-001/source-locations.private.json \
  --metadata <private-root>/history/metadata.json \
  --grouping <private-root>/history/grouping-001 \
  --grouping-confirmation <private-root>/history/grouping-confirmation-001.private.json \
  --out <private-root>/history/attachment-worksheet-001

apps/api/node_modules/.bin/tsx apps/api/scripts/migrate-hist.ts seal-attachments \
  --private-root <private-root> --source <private-root>/history/originals \
  --inventory <private-root>/history/catalog-001/inventory.json \
  --source-locations <private-root>/history/catalog-001/source-locations.private.json \
  --metadata <private-root>/history/metadata.json \
  --grouping <private-root>/history/grouping-001 \
  --grouping-confirmation <private-root>/history/grouping-confirmation-001.private.json \
  --worksheet <private-root>/history/attachment-worksheet-001 \
  --plan <private-root>/history/attachment-mapping-plan.private.json \
  --out <private-root>/history/attachment-mapping-001 --i-have-reviewed
```

有未知项时封存命令保留完整私有映射并最后写 `ATTACHMENT_MAPPING_BLOCKED`，随后返回失败；只有零未知项
才最后写 `ATTACHMENT_MAPPING_COMPLETE`。后续阶段的必经门是 `assert-attachments`，它会重新验证当前源
目录、inventory、grouping、人工确认、映射、目标集合、保全清单和引用改写摘要，并在结束时再次核对目录
身份与唯一状态标记。worksheet 和 mapping 从 `mkdir` 成功起就持续使用同一个稳定目录句柄：目录必须是
当前进程用户拥有的 `0700` 真目录；每个 payload/marker 都以 `O_NOFOLLOW` 打开，在同一个文件句柄的读取
前后重复验证普通文件、当前用户、`0600`、大小和纳秒级状态时间。写入先用 `O_EXCL`、`0600` 创建新文件并
`fsync`，再以不可覆盖的硬链接（让目标名指向已经完整写好的同一文件）发布并 `fsync` 目录，最终标记最后
发布；不使用阶段目录或可能覆盖目标
的 rename。发布后仍通过创建时持有的目录句柄逐文件复核，最后再按公开路径重开并比较类型、设备号、
*inode、所有者、权限和 `ctimeNs`，目录被替换或权限改坏后再恢复也会失败。打包时核心
*`packageApprovedCandidates` 会再次验证完成门签发的能力；非零附件不再固定拒绝，而是进入附件第二阶段：
*固定源字节物化、题面资源引用改写、公开/内部保存、包清单与失败回滚（见第 9 节）。能力缺失、伪造或任一
*摘要变化仍然在任何输出创建前停止，不能靠跳过 CLI 或只改 README 绕过。

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

该阶段只产生候选 JSON、只含安全摘要的 `review.json` 和 `PREPARE_COMPLETE`，不会产生 ZIP，也不表示附件
已具备打包条件。模型置信度只帮助安排复核顺序，不代表批准。等待首段有效输出的默认上限为 30 分钟；已经收到有效输出后，连续
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
  --materialized <private-root>/history/materialized-001 \
  --metadata <private-root>/history/metadata.json \
  --prepared <private-root>/history/prepared-001 \
  --approval <private-root>/history/candidate-approval.private.json \
  --attachment-source <private-root>/history/originals \
  --inventory <private-root>/history/catalog-001/inventory.json \
  --source-locations <private-root>/history/catalog-001/source-locations.private.json \
  --grouping <private-root>/history/grouping-001 \
  --grouping-confirmation <private-root>/history/grouping-confirmation-001.private.json \
  --attachment-mapping <private-root>/history/attachment-mapping-001 \
  --out <private-root>/history/packages-001 \
  --author-map-out <private-root>/history/author-map-001.private.json
```

打包前先根据上述原始清单、分组和附件目录签发一次能力。核心打包函数只接受整个 `--materialized` 目录，
自行固定使用其中的 `sources/` 与 `source-confirmation.private.json`，重新验证 `MATERIALIZE_COMPLETE`，再把
其中的 grouping 批次摘要与附件能力重新扫描得到的批次摘要严格比较；缺参数、跨批次能力、伪造能力、
BLOCKED 与 COMPLETE 并存或任一摘要变化都会在创建输出目录或作者映射前停止。之后才重新读取
物化文本并核对摘要；这些读取全部经由同一组稳定目录句柄完成，发布任何输出前还会按公开路径复核物化
目录身份，并通过同一句柄重读完成标记和全部源文件。输出文件先在输出目录内以 0600 临时写入并 fsync，
再硬链接（不可覆盖）发布，发布后逐文件复核 inode、所有者、权限、大小、ctimeNs、mtimeNs 与内容摘要，
`PACKAGE_COMPLETE` 标记最后发布；任何文件被替换、改写或 chmod 后再还原都会失败，并删除全部部分输出。
题目包报告不含题名、原题号、作者或正文；作者映射在输出目录之外的
独立私有文件中，并绑定候选摘要、题目包摘要和整批摘要。

附件第二阶段在打包时按已封存映射执行，所有字节都来自打包前重新完整核对过的只读内存快照，不接受任何新
路径：

- 固定源字节物化：每个已解决附件按定位符（`zip_entry`/`text_range`/`whole_file`）取回本次核对时已验证的
  字节，并再次核对字节长度和内容摘要与映射一致；不一致即失败。
- 题面资源引用改写：`referenceRewrites` 里的人工改写表按题目组套用到对应候选的 `basicStatement`。原引用
  必须真实出现在题面中，否则失败；改写后 `assets/<内容摘要>.<扩展名>` 与原生包的资产命名和摘要校验一致。
- 公开/内部保存：题面资源（`statement_asset`）与竞赛附件（`contestant_attachment`）按
  `assets/`、`attachments/public/` 进入题目包 ZIP；`solution_original`、`reference_implementation_candidate`
  等内部角色按 `attachments/internal/` 进入同一 ZIP 的内部附件区，导入时与对外用途分开。
  `batch_internal` 的评测/命题候选材料不进入任何题目包，按人工保全路径写入
  `<out>/internal/<preservationPath>`，目录与文件都用 `0700`/`0600` 私有权限，保全路径禁止 `..`、绝对路径
  和空段。
- 包清单：`report.json` 在含附件时记录 `attachmentCount`、每个题目包的附件条目（安全编号、摘要、语义角色、
  可见性、目标路径）以及 `preservedMaterials` 保全清单；整批摘要把这些记录一并纳入，`PACKAGE_COMPLETE`
  同样带附件计数。
- 失败回滚：任一附件字节核对、引用改写、目标路径冲突或保全写入失败都会删除整个输出目录（含内部保全目录）
  和作者映射，不留下部分输出；错误信息不含附件原路径或原引用。

含附件批次打包成功后，命令还会打印一行摘要：
`本批次含 N 个已确认附件：M 个写入内部保全目录，其余按公开/内部用途进入题目包。`
其中 `N` 与 `report.json`/`PACKAGE_COMPLETE` 的 `attachmentCount` 一致，`M` 是 `preservedMaterialCount`。

目标路径冲突（附件目标路径与题目包已有文件或另一附件重复）、保全路径之间的目录/文件冲突都会直接失败，
不做静默覆盖。附件源目录、清单、分组、确认或映射在封存后变化，会在重新验证时以与“不存在”一致的方式
失败，不会泄露附件是否存在。

本工作流能安全处理 UTF-8 文本，以及最多两层历史 ZIP 路径链中明确选择的 UTF-8 文本条目。PDF、图片、
评测数据、附件、二进制文档和无法明确划分的混合资料仍需人工处理，不能因为已有安全清单就称为完成真实
历史题目的全部迁移。审核意见不导入；它们既不进入候选，也不进入最终题目包。

## 历史审核 Gold 上游证据：为 Fermata 人工准备标定答案

`prepare-review-gold.py` 只为 Fermata 的 `reviewFlow` 准确性实验准备人工答案，不属于题目迁移和导入流程。
它放在这里是因为必须复核本目录生成的 `MATERIALIZE_COMPLETE`、`report.json` 和
`source-confirmation.private.json`；题面继续引用物化目录中的原文件，不复制到 Fermata 仓库或另一个私有
目录。

这里的封存结果**不是 Fermata 标定 loader 可直接读取的数据集 manifest**。物化源仍可能是题面、题解和迁移
备注的合并文本；这里的 `accepted`/`rejected` 也是历史二元结论，不等于 Fermata loader 的
`approve`/`request_changes`/`reject` 三态结构。后续必须有一项单独审阅、失败即关闭的私有转换步骤：先验证
本工具的完成标记，按 `source-bindings.private.json` 重新读取源文件，人工确认并生成准确的 statement、
solution 和 RobotReviewTask 输入字节，再分别计算 Fermata 内容与 Gold 文件摘要，并按 Fermata 当时的严格
schema 生成真正的数据集 manifest。没有这一步时不得把本目录传给 Fermata 或声称标定集已经就绪。

工具不会从状态文字、审核意见、题号、题名、文件名或表内顺序推断 Gold，也不会自动把表格行配给物化题目。
一次完整准备分三步：

1. `inspect` 只检查一份或两份 XLSX/SpreadsheetML XML 的安全结构，并写出安全输入编号、文件摘要、工作表
   数量、行数和列数；不读取任何列作为 Gold，也不写标题、题号、人员、单元格内容或列名。每个输入必须
   恰好只有一个工作表；工具尚未实现可靠的工作表显示顺序，遇到多个工作表会直接拒绝。XLSX 合并单元格、
   SpreadsheetML 的合并/跨列声明及倒退的显式行列索引也会直接拒绝，不能靠猜测还原表格。
2. 人工填写布局后，`init` 只把逐列明确绑定的元数据题号、身份、最终结果、比赛使用和审核意见写入
   `0600` 的 `review-worksheet.private.json`，同时生成 `confirmed: false` 的空白计划。工具不根据列名猜测
   含义，也没有“已知难度列名”黑名单：每个非空表头都必须由人填写精确的规范化表头、角色和独立确认，
   实际表头不一致或有非空表头未登记即拒绝。投题者自报难度列必须结构性标成
   `excluded_submitter_difficulty`，其他不需要的列标成 `excluded_other`；两者都不会输出。每个输入至少要有
   一个明确排除的自报难度列，布局和最终计划还要分别再次确认排除。
3. 人逐项阅读私有工作表和原审核意见，显式选择一行和一个已经确认的 `sourceId`，再填写通过/否决、是否
   比赛使用、development/holdout 和评测范围。`seal` 只接受每项都有 `confirmed: true` 的独立计划，且会
   重新读取表格、物化完成链和全部源摘要；它不替人补空值或改判断。

先把私有根及其中目录权限设为 `0700`、文件设为 `0600`。检查输入：

```bash
python3 scripts/migrate-hist/prepare-review-gold.py inspect \
  --private-root <private-root> \
  --input <private-root>/history/review-list-older.xlsx \
  --input <private-root>/history/review-list-newer.xml \
  --out <private-root>/history/review-input-inspection.private.json
```

人工查看原表后，新建 `review-layout.private.json`。列号从 1 开始，并严格递增。每个输入必须正好绑定一个
`metadata_number`、一个 `final_decision`、一个 `contest_use`，以及至少一个 `identity`、一个
`review_comment` 和一个 `excluded_submitter_difficulty`。表头行中其余所有非空列也必须登记为合适的业务
角色或 `excluded_other`，空表头列可以省略。`expectedHeader` 必须先做 Unicode NFKC 规范化、移除全部空白
并转成大小写无关形式；这里的中文示例规范化前后相同。身份列只选人工配对所需的最少字段，不要选择作者、
联系方式或其他无关列。下面假设原表正好有这六个非空表头：

```json
{
  "version": 3,
  "confirmed": true,
  "submitterDifficultyColumnsExcluded": true,
  "inputSetSha256": "inspection 中的 64 位摘要",
  "inputs": [
    {
      "inputId": "input-000001",
      "worksheetId": "worksheet-000001",
      "headerRow": 1,
      "columns": [
        {"column": 1, "role": "metadata_number", "expectedHeader": "题号", "confirmed": true},
        {"column": 2, "role": "identity", "expectedHeader": "题名", "confirmed": true},
        {"column": 3, "role": "excluded_submitter_difficulty", "expectedHeader": "投稿者自报难度", "confirmed": true},
        {"column": 4, "role": "final_decision", "expectedHeader": "最终结果", "confirmed": true},
        {"column": 5, "role": "contest_use", "expectedHeader": "比赛使用", "confirmed": true},
        {"column": 6, "role": "review_comment", "expectedHeader": "审核意见一", "confirmed": true}
      ]
    }
  ]
}
```

生成私有人工工作表和空白计划：

```bash
python3 scripts/migrate-hist/prepare-review-gold.py init \
  --private-root <private-root> \
  --input <private-root>/history/review-list-older.xlsx \
  --input <private-root>/history/review-list-newer.xml \
  --inspection <private-root>/history/review-input-inspection.private.json \
  --layout <private-root>/history/review-layout.private.json \
  --materialized <private-root>/history/materialized-001 \
  --out <private-root>/history/review-gold-worksheet-001
```

复制空白计划到一个新文件再填写。`rowId` 和 `sourceId` 必须由人对照私有工作表逐项配对；工具只在配对后
核对双方的元数据题号相同，不会据此寻找或推荐来源。`subjectId` 是跨多次数据集保持不变的私有安全身份，
用于防止同一道题改了 `caseId` 后混入 holdout。确认属于原题或重复题的样本必须填
`"evaluationScope": "originality_only"`；这类样本的封存 Gold 从结构上不含 `verdict` 和 `contestUse`，只
记录 `sameProblemAsExisting: true`，因此只能评原题识别，不能计入通过/否决或命题品味准确率。它不要求
历史最终结果单元格非空。其他样本使用 `verdict_and_taste`，必须有非空的历史最终结果；两个范围是严格的
判别联合，不能把另一范围的字段混进来：

```json
{
  "version": 3,
  "confirmed": true,
  "submitterDifficultyColumnsExcludedReconfirmed": true,
  "datasetId": "history-review-development-v1",
  "worksheetSha256": "工作表文件摘要",
  "sourceConfirmationSha256": "工作表内记录的源确认摘要",
  "cases": [
    {
      "caseId": "case-000001",
      "subjectId": "subject-000001",
      "rowId": "review-row-000001",
      "sourceId": "source-000001",
      "sourceSha256": "物化源摘要",
      "purpose": "development",
      "evaluationScope": "verdict_and_taste",
      "verdict": "accepted",
      "contestUse": "used",
      "confirmed": true
    }
  ]
}
```

原题识别样本的 case 则只把上例最后三个业务字段换成：

```json
{
  "evaluationScope": "originality_only",
  "sameProblemAsExisting": true,
  "confirmed": true
}
```

这里仅展示范围相关字段；完整 case 仍需保留 `caseId`、`subjectId`、`rowId`、`sourceId`、`sourceSha256` 和
`purpose` 等公共字段，且不得出现 `verdict` 或 `contestUse`。`verdict_and_taste` 的 `contestUse` 必须人工
明确填写为 `used`、`not_used` 或 `unknown`；不能用布尔值把“不知道”误写成“未使用”。

还要从 `tuning-history.skeleton.private.json` 复制并人工维护一份完整调参历史。凡是曾用于看结果、改提示词、
阈值或流程的样本都登记为 development；即使之后换了文件或 `caseId`，也要沿用同一 `subjectId`。同一道题
可以因历史内容版本不同而出现多个不同摘要；完全相同的 `(subjectId, contentSha256)` 不能重复，同一内容摘要
也不能归到不同题目。`seal` 还会核对当前 development：若某个历史内容摘要已经属于一个 `subjectId`，当前
计划不能把该摘要改归另一个 `subjectId`；同一题新增不同内容版本仍然允许。空历史也必须明确改成
`confirmedComplete: true`。`seal` 同时按所有历史 `subjectId` 和所有历史内容摘要拒绝 holdout 与当前或
历史 development 重叠：

```json
{
  "version": 1,
  "confirmedComplete": true,
  "developmentSamples": [
    {
      "subjectId": "subject-000001",
      "contentSha256": "曾用于调参的内容摘要"
    }
  ]
}
```

最后封存；运行这一步前仍要完整人工复核计划，不能把 `inspect` 或 `init` 当成确认：

```bash
python3 scripts/migrate-hist/prepare-review-gold.py seal \
  --private-root <private-root> \
  --input <private-root>/history/review-list-older.xlsx \
  --input <private-root>/history/review-list-newer.xml \
  --inspection <private-root>/history/review-input-inspection.private.json \
  --layout <private-root>/history/review-layout.private.json \
  --materialized <private-root>/history/materialized-001 \
  --worksheet <private-root>/history/review-gold-worksheet-001 \
  --plan <private-root>/history/review-plan-001.private.json \
  --tuning-history <private-root>/history/tuning-history.private.json \
  --out <private-root>/history/review-gold-dataset-001
```

封存目录不复制题面，只包含上游证据：

- `review-gold-evidence.private.json`：带明确 `historical_review_gold_evidence` 类型的安全 `caseId`、
  development/holdout、评测范围、物化源内容摘要、Gold 文件名与 Gold 文件摘要；它不是 Fermata manifest，
  不含姓名、题号、题名或原评语；
- `gold/<caseId>.json`：逐题规范化人工答案，不含原评语；
- `source-bindings.private.json`：把安全 `caseId` 连接回现有物化源，仅供之后受保护的私有转换步骤使用；
- `tuning-history-additions.private.json`：本次 development 项，人工合并进下一版完整调参历史；
- `REVIEW_GOLD_COMPLETE`：绑定计划、调参历史、上游证据、来源连接和全部 Gold 摘要的完成标记。

需要把这份上游证据交给 Fermata 的私有转换步骤前，先用只读命令重新验封：

```bash
python3 scripts/migrate-hist/prepare-review-gold.py verify-sealed \
  --private-root <private-root> \
  --input <private-root>/history/review-list-older.xlsx \
  --input <private-root>/history/review-list-newer.xml \
  --inspection <private-root>/history/review-input-inspection.private.json \
  --layout <private-root>/history/review-layout.private.json \
  --materialized <private-root>/history/materialized-001 \
  --worksheet <private-root>/history/review-gold-worksheet-001 \
  --plan <private-root>/history/review-plan-001.private.json \
  --tuning-history <private-root>/history/tuning-history.private.json \
  --sealed <private-root>/history/review-gold-dataset-001 \
  --verifier-code-version <可信调用方确认的40位Git提交> \
  --verifier-runner-sha256 <当前prepare-review-gold.py摘要> \
  --verifier-dependency-code-sha256 <两份固定Python依赖的代码摘要>
```

`verify-sealed` 不写文件或目录。它复用 `seal` 的完整只读重算链，重新读取一至两份原表、inspection、layout、
真实工作表行与 `rowEvidenceSha256`、物化报告与源文件清单、工作表完成标记、计划和完整调参历史；随后按计划
顺序重建并逐字节核对 evidence、bindings、additions、每份 Gold 和最后写入的完成标记。物化目录、工作表
目录、sealed 顶层及 `gold/` 都会在验证前后核对严格清单；验证期间持续持有最初打开的目录句柄，结束前还会
从同一句柄逐字节重读物化报告、全部物化源、工作表成果和 sealed 成果，并确认公开路径仍指向原设备号和
inode。额外对象、读后替换、符号链接、硬链接、非 `0600` 文件、错误目录权限或目录身份变化全部失败。
验封数据集必须至少有一条 development 样本。

成功时 stdout 只包含 UTF-8、`ensure_ascii=false`、两空格缩进并以恰好一个换行结束的
`urmotiv_review_gold_verification_attestation` JSON，stderr 为空。字段固定包含协议版本、上游 datasetId、
verifier 身份、逐层原始或规范化摘要、按 inspection 顺序的输入、按 plan 顺序的 case、安全计数和
`verificationFingerprint`；不包含私有根路径、原表路径、题面、题解、题名、人员或审核原文。指纹计算时先
移除指纹字段，再递归按键名字典序排列对象、保持数组顺序，以无空白 UTF-8 JSON 计算 SHA-256。失败时
stdout 为空，stderr 仍只有本工具固定的安全错误。

verifier 会稳定复读当前 runner，并要求摘要等于参数；依赖代码摘要固定覆盖仓库相对路径
`scripts/migrate-hist/parse-metadata.py` 和 `scripts/migrate-hist/prepare-review-gold.py`。按路径排序后，每项依次
写入“ASCII 路径字节数、冒号、路径字节、NUL、ASCII 文件字节数、冒号、文件字节、NUL”，再计算整段
SHA-256。Python 工具不自行运行 Git；可信调用方仍须在调用前后核对工作树、HEAD 和这两份文件，并把同一
提交号和摘要传入。

原始审核意见只存在 `review-worksheet.private.json`。私有根从 `/` 开始逐段以禁止跟随符号链接的目录句柄
打开；读写都锚定在该句柄，读取还会做双读、文件状态和重新打开核验，以便路径或文件在处理中被替换时
失败关闭。`init`/`seal` 创建 `output`（以及 `seal` 的 `gold`）后，会持有对应目录的句柄与设备号、inode
直到命令结束；阶段文件和完成标记都通过这些相同句柄写入。写完成标记前会在所持句柄上核对精确目录清单
和每个预期文件的完整字节，完成标记是最后一次写入；随后再按公开路径重新打开 `output`/`gold`，确认仍是
原 inode。新文件直接以最终目标名和 `O_EXCL`（目标已存在就失败）创建为 `0600`；新目录也只创建一次，
不覆盖已有对象。写文件或建目录发生异常后绝不按路径删除，因为检查身份与删除之间仍可能发生并发替换；
因此失败目录可能保留私有 partial（只写了一部分的文件），必须改用新的 `--out`，不能原地续写或覆盖。
目录中单个文件存在不表示阶段完成：只有命令最后写出的 `REVIEW_WORKSHEET_COMPLETE` 或
`REVIEW_GOLD_COMPLETE` 能完整解析，且其中全部摘要和计数经重新计算一致时，目录才有效；标记缺失、截断或
校验失败一律视为不完整。`inspect` 命令若失败，也必须丢弃该目标路径并换新文件。终端无论成功或失败都只
打印计数或固定错误，不打印原内容、原路径或人员信息。这个工具只准备人工 Gold，不调用外部模型；真实私有
数据不得在测试里运行 `seal`，应先用合成 XLSX/XML 完成测试，再由人按上述流程处理。

## 历史导入零数据库变更预检（Phase 1）

正式导入前先运行 `apps/api/scripts/preflight-history-import.ts`。命令行只允许出现环境变量名：
`--private-root-env`、`--list-metadata-env`、`--package-directory-env`、`--output-directory-env`、
`--database-url-env`、`--grouping-file-env`、`--tag-id-env`、`--git-commit-env`、
`--target-class-env`、`--principal-env`、`--execution-id-env`、`--batch-sha256-env` 和
`--source-bindings-sha256-env`；可选既有导入清单也只能用 `--import-manifest-env`。
唯一可直接传入的是非敏感整数 `--expected-record-count`。路径、连接串、库名、执行主体、标签、执行编号和
批准摘要都不得作为命令行值。不要用 shell 的 `source` 或 `.` 加载环境文件。

脚本先确认私有目录权限和全部路径边界，再逐个重新读取 ZIP：校验包字节数与摘要，用正式原生适配器解析，
独立计算样例行、附件行、存储对象数、总字节和内容清单摘要，并拒绝额外包、重复候选、重复包摘要或重复导入
清单项。批次摘要、按顺序的候选/来源绑定摘要、分组和批准环境值必须全部一致。基础题解结构性缺失只计数，
不判失败。

数据库检查在显式只读事务内验证只读开关、当前十张必需表、标签和执行主体。所有文件与数据库校验通过前
不写回执；输出路径必须是私有根内的新路径。成功只写不含原始身份值的
`history-import-preflight.private.json` 和最后发布的 `PREFLIGHT_PASS`。必须由独立复核者核对该回执及其
SHA-256 后，才把摘要通过新的环境变量交给 Phase 2。

## Phase 2 验收导入 runner

`apps/api/scripts/run-real-import.ts` 只在临时库或指定验收库执行，固定拒绝 `designated-real`。正式目标导入
属于验收通过后的独立受控步骤，本 runner 不会自动触发。

- **环境变量输入**：除 `--expected-count` 外，CLI 只接收 `*-env` 参数。私有根、包目录、元数据、分组、
  Phase 1 回执、回执目录、存储根、导入输出、管理连接、验收库名、执行主体、标签、提交、批次摘要、
  来源绑定摘要、Phase 1 回执摘要、执行编号和目标分类都必须来自命名环境变量。
- **变更前完整校验**：重新扫描全部包并重算上述清单；重新读取 Phase 1 回执和完成标记；核对三个批准摘要、
  提交/主体/标签/执行编号绑定；只读验证来源数据库十张表、标签、执行主体和目标库不存在。任一失败均不
  创建验收库、导入输出或 runner 回执。
- **快照与恢复**：新建验收库完成迁移和种子后关闭全部连接，再用 PostgreSQL `TEMPLATE` 创建库快照；
  本地存储快照按文件路径、字节数和内容摘要校验。失败恢复先建立 staging 库并验证，再原子替换目标；
  存储也用 staging/backup 原子切换。数据库和存储都恢复到精确基线并复核后才删除快照。清理失败会向上
  返回，不能写通过标记。
- **两遍导入**：第 1 遍必须为 `N/0/0`，标题编辑探针后重放必须为 `0/N/0`。重放不能新增任何表行，
  已编辑标题必须保留，题面与题解必须保持原值。
- **精确增量**：逐表核对当前完整十表集合：用户、题目、修订、修订标签、修订附件、样例、导入任务、
  导入任务项、审计事件和存储记录。样例、附件、存储对象、存储总字节和内容清单都来自包扫描结果，而非
  从数据库结果反推；缺失题解和附件只按本次清单的问题标识统计。
- **私有证明**：成功回执 `phase2-run-receipt.private.json` 只含摘要绑定、聚合计数和稳定判定码；快照清理
  完成后才最后发布 `PHASE2_RUN_PASS`。stdout/stderr 不输出路径、库名、身份、摘要、题名、正文或凭据。
- **退出码**：0 = PASS；对账、导入、恢复或清理失败 = 1；参数错误 = 2。
