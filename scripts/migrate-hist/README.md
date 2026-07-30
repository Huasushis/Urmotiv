# 历史题目迁移工具

历史资料可能是 Markdown、PDF、图片或混合压缩包，不能靠文件名猜题号，也不能让模型整理完就直接导入。
本工具第一阶段只处理已经人工分组的 Markdown 或纯文本，并把“生成候选”和“生成题目包”分开。

“内容摘要”是根据完整内容计算出的 SHA-256 值。它像一张内容指纹：文件或候选只要改了一个字符，摘要就会
变化，旧确认随即失效。

## 安全红线

- 历史题目、表格、确认文件、候选、题目包和作者映射都只放在服务器
  `/home/ubuntu/urmotiv-codex/private/` 下的非 Git 目录。
- 不根据文件名开头的数字、题名或姓名自动配对。每个源文件必须在第一份确认文件中明确写出对应元数据题号。
- 同一源文件或同一条元数据不能重复分配。一个源文件含多道题时，先在私有目录人工拆成独立文本，再重新确认；
  不允许按模型输出顺序猜对应关系。
- 源文本文件最多 2,000,000 个 UTF-8 存储字节，解码后的文本长度最多 500,000。这里的文本长度与
  页面编辑器一致：通常一个汉字算 1，大多数表情符号算 2。任一上限超出都会直接拒绝，不截取前一部分。
- 输出文件名只使用 `source-000001`、`candidate-000001` 这类安全编号。审核清单和报告只写安全编号、
  内容摘要、长度和状态，不写题名、学号、原文件名或正文。
- 作者学号只写入 `--author-map-out` 指定的单独私有文件；不会进入候选、题目包清单或扩展字段。
  如果模型结果或难度文字含有当前记录的学号、原文件路径或原文件名，工具会停止，不会生成候选。
- 输出目录和作者映射文件必须是新路径。工具用临时文件完整写好后再发布，发现同名文件就停止，不覆盖。
  正常失败会清理本次新建的输出；如果机器突然断电，缺少 `PREPARE_COMPLETE` 或 `PACKAGE_COMPLETE`
  的目录只能作为故障现场保留，不能导入其中的文件，应换一个新输出路径重跑。

## 0. 解析私有元数据

`parse-metadata.py` 用 Python 标准库读取 `.xlsx`，主动丢弃 QQ 号与审核人列。输出仍含作者学号，
所以 `metadata.json` 仍是私有文件。

```bash
python3 parse-metadata.py \
  /home/ubuntu/urmotiv-codex/private/history/list.xlsx \
  /home/ubuntu/urmotiv-codex/private/history/metadata.json
```

## 1. 人工确认源文件映射

先对 `metadata.json` 和已经人工分组的每个 `.md` 或 `.txt` 计算完整文件摘要，再建立
`source-confirmation.private.json`：

```bash
sha256sum /home/ubuntu/urmotiv-codex/private/history/metadata.json
sha256sum /home/ubuntu/urmotiv-codex/private/history/grouped-text/人工分组后的文件.md
```

```json
{
  "version": 1,
  "confirmed": true,
  "metadataFileSha256": "metadata.json 的 64 位小写 SHA-256",
  "mappings": [
    {
      "sourcePath": "人工分组后的文件.md",
      "sourceSha256": "64 位小写 SHA-256",
      "metadataNumber": "表格中的题号"
    }
  ]
}
```

`confirmed: true` 表示人已经逐项核对。元数据文件摘要会锁定整份表格解析结果，其中包括作者学号；
任何一条作者归属或其他元数据变化后，第一次确认都会失效。确认文件缺失、摘要变化、元数据题号不存在
或发生重复分配时，`prepare` 和 `package` 都会停止。

## 2. prepare：只生成候选

不要用 shell 的 `source` 读取环境文件。使用 Fermata 仓库的 `run-with-env.mjs`，避免特殊字符被 shell
解释或回显：

```bash
node <fermata仓库>/scripts/run-with-env.mjs <私有环境文件> \
  apps/api/node_modules/.bin/tsx apps/api/scripts/migrate-hist.ts prepare \
    --private-root /home/ubuntu/urmotiv-codex/private \
    --source /home/ubuntu/urmotiv-codex/private/history/grouped-text \
    --metadata /home/ubuntu/urmotiv-codex/private/history/metadata.json \
    --source-confirmation /home/ubuntu/urmotiv-codex/private/history/source-confirmation.private.json \
    --out /home/ubuntu/urmotiv-codex/private/history/prepared-001
```

该阶段只产生：

- `prepared-001/candidates/candidate-000001.json`：供人阅读的候选内容；
- `prepared-001/review.json`：只含安全编号、摘要、长度和待批准状态；
- `prepared-001/PREPARE_COMPLETE`：完整写完的标记。

这里不会产生 ZIP。模型置信度只帮助安排复核顺序，不代表批准。
每次模型请求最多等待 600 秒，这个时间同时覆盖响应头和完整响应正文；失败时最多尝试 3 次，每次单独计时，
两次重试前分别等待 3 秒和 6 秒。模型响应超过 10,000,000 字节会直接拒绝，不读取为无限大的对象。
单个候选 JSON 也使用同一上限，超过上限就失败，不截断。
`--private-root` 是本次迁移允许使用的服务器私有目录；其余输入和输出只要有一个落到该目录之外，
命令就会停止，避免误把候选或作者映射写进仓库。工具只能检查“是否位于这个边界内”，不能判断操作者
是否误把仓库目录当成私有目录；因此该参数必须使用部署约定的非 Git 私有目录。

## 3. 人工批准候选内容

逐题阅读候选后，把准备阶段给出的 `candidateId` 与 `contentSha256` 原样写入第二份确认文件：

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

源文件映射确认与候选内容批准是两次不同确认，不能共用一份文件。修改候选后摘要会变化，必须重新阅读并
填写新摘要。一个源文件拆出了多个候选时，工具拒绝把它们都分给同一条元数据；应先人工拆分源文件，
重新执行前两步。

## 4. package：批准后生成题目包

```bash
apps/api/node_modules/.bin/tsx apps/api/scripts/migrate-hist.ts package \
  --private-root /home/ubuntu/urmotiv-codex/private \
  --source /home/ubuntu/urmotiv-codex/private/history/grouped-text \
  --metadata /home/ubuntu/urmotiv-codex/private/history/metadata.json \
  --source-confirmation /home/ubuntu/urmotiv-codex/private/history/source-confirmation.private.json \
  --prepared /home/ubuntu/urmotiv-codex/private/history/prepared-001 \
  --approval /home/ubuntu/urmotiv-codex/private/history/candidate-approval.private.json \
  --out /home/ubuntu/urmotiv-codex/private/history/packages-001 \
  --author-map-out /home/ubuntu/urmotiv-codex/private/history/author-map-001.private.json
```

打包前会再次读取源文本并核对摘要；准备后改过原文时旧确认会失效。
`packages-001/packages/` 只含批准后的 Urmotiv 原生题目包，`packages-001/report.json` 只含安全编号、
摘要、包大小和状态。作者映射在输出目录之外的独立私有文件中，每条同时保存候选内容摘要和题目包摘要，
文件还保存整批题目包的摘要；拿错批次时可以被程序发现。导入后再由管理员人工处理题目归属。

本批代码只安全处理已经人工分组的 `.md` 和 `.txt`。ZIP、PDF、图片、表格以及没有明确结构的混合资料
仍要进入人工检查或后续提取队列，不能称为已经完成真实 `hist_problem` 的全部迁移。当前不要手工把压缩包
直接解到仓库，也不要把附件送入模型；先在服务器私有目录中完成检查和人工分组。
