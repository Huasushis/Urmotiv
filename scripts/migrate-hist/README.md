# 历史题目迁移工具

把协会积累的历史题目（`hist_problem/`，格式各异：单题 Markdown、含图片的 ZIP、一个文件多道题、
编号区间、PDF）用一个便宜的大模型规范化成 Urmotiv 的统一题目结构，产出可走既有导入管线的原生
题目包，并为每一题写出预览 JSON 供人工确认后再导入。

## 安全红线

- 历史题目与 `USTC题目列表.xlsx` 是协会私有资料，**只在服务器非 Git 私有目录处理**，
  输入、预览、原生包都不进 Git（`.gitignore` 已覆盖 `hist_problem/`；服务器上放在
  `/home/ubuntu/urmotiv-codex/private/` 下）。
- QQ 号等个人隐私在元数据解析阶段就被剔除；审核人之后难以追踪的列不导入。
- 规范化调用的模型密钥来自环境变量，不写进任何输出或日志；日志只打印编号与长度。

## 两步流程

### 1. 解析元数据（剔除隐私）

`parse-metadata.py` 用 Python 标准库读 `.xlsx`，输出迁移需要的字段（题号、名称、难度猜测、
出题人学号、状态、比赛、备注），主动丢弃 QQ 号与审核人列。难度从名称里的数字区间取中点、
四舍五入到整百。

```bash
python3 parse-metadata.py /私有目录/list.xlsx /私有目录/metadata.json
```

### 2. 逐题规范化 → 原生包

`apps/api/scripts/migrate-hist.ts` 借用 API 工作区的 `@urmotiv/problem-package`（生成原生包）和
`@urmotiv/contracts`（结构校验）。它遍历题面 Markdown，为每个源文件调一次大模型，整理成结构化
题目（多题文件会被拆成多项），再产出原生题目包与预览 JSON。

```bash
# 在服务器 repo 目录，用 run-with-env 加载含 AETHER_* 的环境文件（不要用 shell source）
node <fermata仓库>/scripts/run-with-env.mjs <env文件> \
  apps/api/node_modules/.bin/tsx apps/api/scripts/migrate-hist.ts \
    --source /私有目录/hist \
    --metadata /私有目录/metadata.json \
    --out /私有目录/output \
    [--only 15,3,4,5] [--limit 10]
```

参数：`--only` 只处理指定题号（逗号分隔）；`--limit` 限制处理数量，便于分批。默认模型
`deepseek-v4-flash`，可用 `MIGRATE_MODEL` 覆盖。

产出：
- `output/previews/<题号>.json`：规范化后的题目，**导入前必须人工逐题预览确认**（模型可能漏读或
  误判，`extensions.migration.confidence` 是模型自评的置信度，低的优先复核）；
- `output/packages/<题号>.zip`：Urmotiv 原生题目包，确认无误后走导入导出页的“导入”上传即可；
- `output/report.json`：每题的标题、置信度、题面长度、是否有题解、迁移备注、失败原因汇总。

## 已知处置

- **ZIP 里的题目**：先把 ZIP 解压到私有目录下同名 `.md`（图片等二进制附件在人工确认阶段单独通过
  题目文件上传界面补传，不进入模型）。
- **一个文件多道题 / 编号区间**（如 `3,4,5-待审核.md`、`28~45.zip`）：模型会拆成多项，输出
  `<题号>-1`、`<题号>-2`……逐题预览。
- **PDF 题面**：`parse-metadata` 不处理 PDF；如需迁移 PDF 题目，先人工或用工具转成 Markdown 再放进
  源目录。
- **缺题解**：模型会在 `basicSolution` 里标注“（迁移时缺题解，待补充）”，`report.json` 的
  `hasSolution=false` 便于筛出来补。

## 与账号的关系

原生包不含作者身份。历史题目的出题人学号保留在 `extensions.migration.authorStudentId`，供导入后
按学号匹配预创建账号。若批量为出题人建账号麻烦、或担心他们首次统一身份登录时出问题，可以先用一个
共享的“历史导入”账号统一导入，之后再由管理员按学号归属逐步转移——具体见 `docs/deployment.md`
的历史数据迁移一节。
