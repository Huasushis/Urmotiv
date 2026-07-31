# Urmotiv 三仓库服务器交接（2026-07-31）

## 1. 交接结论

项目已完整复制到服务器新目录：

```text
/home/ubuntu/codex-urmotiv/
├── README.md                    # 每个目录的用途和使用边界
├── AGENTS.md                    # 从 docs/server-root-agents.md 复制的顶层规则
├── HANDOFF.md                   # 本文
├── PROMPT-FOR-NEXT-AI.md        # 可直接交给新 AI 的提示词
├── Urmotiv/                     # 正式主系统仓库，含自己的 .git 和尚未提交的工作
├── Fermata/                     # 正式 AI 审题服务仓库，独立 .git
├── Anklang/                     # 正式原题检索服务仓库，独立 .git
├── previous-server-work/        # 迁移前的全部服务器实验环境与实验数据
└── validation/                  # 迁移与部署验证记录
```

用户准备从这个目录直接启动 Codex。推荐入口：

```bash
cd /home/ubuntu/codex-urmotiv
codex
```

2026-07-31 已参照 `/home/ubuntu/codex-dolly` 的结构，把本项目原先散落在主目录中的两个旧目录原样移动到 `previous-server-work/`。现在主目录只保留一个 Urmotiv 项目入口 `/home/ubuntu/codex-urmotiv`。旧实验环境和实验数据没有删除；详细映射和核验数据见 `README.md` 与 `validation/20260731-consolidation/README.md`。

主目录下的其他项目和文件不属于 Urmotiv。尤其 `/home/ubuntu/cc.sql` 明确不属于本项目，不能查找、恢复、迁移或处理。

这次使用 `scp -r -p` 从 Windows 复制了三个完整目录，包括 `.git`、未提交文件和被 Git 忽略的私有材料。Windows 的依赖链接可能被展开，复制来的 `node_modules` 可能含 Windows 平台产物，不能作为 Linux 依赖已正确安装的证据。

## 2. 新会话的第一小时

先不要改代码。按顺序执行：

```bash
cd /home/ubuntu/codex-urmotiv
sed -n '1,260p' README.md
sed -n '1,240p' AGENTS.md
sed -n '1,320p' HANDOFF.md

git -C Urmotiv status --short --branch
git -C Fermata status --short --branch
git -C Anklang status --short --branch
git -C Urmotiv log -5 --oneline --decorate
git -C Fermata log -5 --oneline --decorate
git -C Anklang log -5 --oneline --decorate

node --version || true
pnpm --version || true
python3 --version
env | grep -iE '^(http|https|all|no)_proxy=' || true
```

然后完整阅读：

- `Urmotiv/AGENTS.md`
- `Urmotiv/docs/spec.md`
- `Urmotiv/docs/permissions.md`，它是权限实现和测试的唯一依据
- `Urmotiv/docs/problem-package.md`
- `Urmotiv/docs/plugins.md` 与 `Urmotiv/docs/plugin-development.md`
- `Urmotiv/docs/deployment.md`
- `Urmotiv/docs/handoff-2026-07-27.md`、`handoff-2026-07-26.md` 作为背景
- `Fermata/AGENTS.md`、`Fermata/README.md`
- `Anklang/AGENTS.md`、`Anklang/README.md`、`Anklang/docs/plan.md`
- 根目录 `README.md` 中 `previous-server-work/` 的逐项说明；旧实验报告是准确性工作的证据，不能因代码较旧而删除

最后在不打印内容的前提下确认 `Urmotiv/private/urmotiv.txt` 存在，并在服务器本地阅读。那是用户最初的产品想法。所有功能接近完成时，要制作一份仅含“需求名称、实现位置、测试证据、未完成原因”的对照表；不要把私有原文复制到公开文档或 Git。

## 3. 服务器环境和操作边界

- 用户新增加的代理在 `127.0.0.1:10808`，HTTP 和 SOCKS5 两种方式都可用，默认变量已写入 `.bashrc`，服务器现在可访问外网。
- 用户允许安装软件和进行项目所需配置。优先把 Node.js、pnpm 和缓存放在 `/home/ubuntu/codex-urmotiv/.tools`、`.cache`，避免改变其他项目依赖的系统版本。
- Urmotiv 要求 Node.js 22 或更高，锁定的包管理器是 pnpm 10.33.0；Fermata 要求 Node.js 24 或更高。优先统一使用 Node.js 24。
- 服务器上可能还有其他正在运行的项目。只能操作本目录和能够确认属于本目录的进程；不得整理用户主目录、修改其他服务、占用已有端口或按名称批量结束 `node`/`python` 进程。
- 结束进程前记录进程号、父进程、完整命令和当前工作目录。不能确认归属就保留。
- 不要用 `source` 或 `.` 加载任何 `.env`。Fermata 使用：

  ```bash
  node scripts/run-with-env.mjs <环境文件> <命令> [参数...]
  ```

### 3.1 旧服务器资料的位置

`previous-server-work/urmotiv-codex/` 是迁移前的完整服务器工作目录，包含旧 Urmotiv/Fermata/Anklang 运行副本、数据库测试状态、浏览器测试结果、Fermata 准确性与超时实验、私有配置、Hydro 格式研究资料、Linux Node.js 和浏览器程序。它们用于复现实验、核对数据和恢复环境，不是新的正式代码来源。

`previous-server-work/codex-urmotiv-database-foundation-019f99c1/` 是较早的数据库基础实验副本。它的代码早于当前正式仓库，但依赖和当时的环境完整保留。

`previous-server-work/malformed-empty-directories-20260730/` 是一次错误命令留下的 53 个空目录，没有普通文件或链接。它仅作为事故记录保留，不参与开发。

旧资料默认只读。需要采用其中的代码时，先与正式仓库逐文件比较；需要采用其中的实验数据时，只复制到明确的私有目录。不得在旧副本中提交或推送，也不得一次性把旧目录覆盖回正式仓库。

## 4. 三个仓库的精确快照

### 4.1 Urmotiv

- 分支：`codex/review-admin`
- 业务代码基线：`2c2e776 fix: make problem package tasks retry safely`。交接、目录整理和顶层规则作为只含文档的后续提交，因此接手时的 `HEAD` 会比这个基线多一笔或多笔文档提交；以 `git log` 为准。
- 业务代码基线当时与 `origin/codex/review-admin` 一致。
- 最近的重要已提交工作：

  - `07f36c4 feat: support raw XML problem package transport`
  - `67f9154 docs: record July 31 project handoff`
  - `b26b5df fix: align Anklang plugin timeout`
  - `206ff19 fix: bound problem package archive memory`
  - `3dcc9c2 feat: add confirmed history migration workflow`
  - `3f7fe75 fix: preserve admin drafts and align plugin permissions`
  - `be831ca feat: add review and plugin administration page`

当前工作区不是干净状态，且至少包含四组不同来源的修改。不得整体暂存或整体提交。

#### A. 题目包任务与审计

主要文件：

```text
apps/api/src/app.ts
apps/api/src/problem-package-job-store.ts
apps/api/src/problem-package-runtime.ts
apps/api/src/server.ts
apps/api/src/transfer-service.ts
apps/api/tests/transfer-api.test.ts
packages/jobs/src/problem-package.ts
apps/api/src/problem-package-audit.ts          # 未跟踪
```

这是此前进行中的题目包审计与任务处理工作，不能和审核页面改动混成一个提交。先看完整差异和测试，再决定拆分。

#### B. 审核可见性、本人编辑和题目状态联动

主要文件：

```text
apps/api/src/service.ts
apps/api/tests/review-decision-flow.test.ts
apps/web/src/components/problem-tabs.tsx
apps/web/src/main.tsx
apps/web/src/pages/demo-login-page.tsx
apps/web/src/pages/problem-workspace-page.tsx
docs/permissions.md
docs/spec.md
apps/web/src/components/problem-tabs.test.tsx          # 未跟踪
apps/web/src/pages/demo-login-page.test.tsx            # 未跟踪
apps/web/src/pages/problem-workspace-page.test.ts      # 未跟踪
```

预期行为：

- 对题目有读取权限的用户可以看到当前审核轮次中允许公开的评价字段。
- `privateNote` 是只给授权审核者看的内部备注，不能因“评价互相可见”而公开。
- 用户只能编辑自己提交的评价。服务端按当前登录用户写入，不接受伪造的审核人或评价编号。
- 修改评价后重新运行该轮选中的审核决定规则；因此题目可能改为通过、需要修改或不通过，界面必须明确提醒。
- 已关闭轮次、没有可用规则或存在未保存题目改动时，界面不能伪装成可正常提交。
- 登录用户变化时清理查询缓存；未保存草稿的存储键包含用户和题号，避免同一浏览器中的账号互相看到草稿。

此前在旧服务器上，最终一轮缓存和草稿修复之前的 API/Web 类型检查通过；最后这些修复完成后，Windows 会话重启打断了目标测试，所以**当前版本尚未验证**。接手后的第一项代码工作应是静态复核这一组差异，并在新服务器运行类型检查、相关单元测试和页面测试。不得沿用较早的“通过”结论。

#### C. 历史题目分组半成品

```text
apps/api/src/history-migration/errors.ts
apps/api/src/history-migration/index.ts
apps/api/src/history-migration/grouping.ts    # 未跟踪、被中断、没有验证
```

`grouping.ts` 试图表达“一个文件可能含多题、一题可能来自多个文件”的人工分组，但工作中途被打断。它不是可用功能。先用合成的假资料补设计和测试，再处理真实历史题目。

#### D. 其他必须保留的未跟踪文件

```text
HANDOFF.md
PROMPT-FOR-NEXT-AI.md
QUICK-START.txt
docs/handoff-2026-07-27-fix.md
docs/handoff-2026-07-29-pause.md
packages/auth/test/tokens.test.ts
```

这些文件可能来自更早的工作。先读内容和差异来源；不能因为有了本文就删除，也不要未经测试混入其他提交。

### 4.2 Fermata

- 分支：`codex/accuracy-timeouts`
- 当前提交：`e558e38 fix: keep long model reviews alive safely`
- 交接时工作区干净，提交已推送并与远端一致。
- 旧服务器最后一次工程验证：类型检查通过，19 个测试文件共 255 项通过，脚本语法检查通过。

`e558e38` 解决了用户反复遇到的 499“客户端已取消”：

- 模型调用使用流式返回，即边生成边读取内容。
- 等 HTTP 响应真正结束，不因 `finish_reason=stop` 或 `[DONE]` 标记提前切断连接。
- 默认等待首段输出 30 分钟、输出停顿 10 分钟、总时限 4 小时。
- 只有服务端明确返回“请求过多”时自动重试；网络错误、服务器错误和超时不自动重复付费请求。
- 任务租约或授权丢失时才取消付费请求，并等待所有并行调用真正结束后再清理。
- 标定实验支持后台运行、安全读取环境变量、检查点和报告保护。

**不要把这些工程测试写成“AI 判断准确性通过”。准确性目前没有通过。**

迁移前的 Fermata 报告全部保留在：

- `previous-server-work/urmotiv-codex/fermata-repo/experiments/results/`：21 份结果文件；
- `previous-server-work/urmotiv-codex/fermata-accuracy-20260731/experiments/results/`：6 份准确性实验结果；
- `previous-server-work/urmotiv-codex/fermata-timeout-review-20260731/experiments/results/`：11 份超时审查结果。

这些结果没有并入 Git，也没有复制成正式仓库中的假基线。新实验开始前必须先阅读并登记它们，避免重复付费或丢失修改前证据。

已知准确性证据：

- Codeforces 难度的旧公开集只有 33 题，平均绝对误差约 281.8，误差不超过 200 的比例约 63.6%，高难题普遍低估；当前难度配置只有两个临时参考点。
- 最新思维难度与代码难度实验只完成 9/24，缺 15 个样本，也没有高分段；9 个思维难度结果全部为 2，不能据此调权重。
- 最终结论实验只有 3 个正常样本和 3 个重复构造样本。“正常成功”只检查不是拒绝，没有区分通过和需要修改。
- 整体流程实验把上游难度写成固定值，不是完整的端到端评价。
- 重复题阈值虽然出现在配置文件中，运行时仍在 `src/pipelines/verdict.ts` 使用写死的 `0.9`，尚未修复。
- 思维难度缺少对“方向正确的连续推理能走多深”的明确衡量；代码难度没有真正编译、运行样例，也没有充分评价自定义数据结构、多组成部分和边界情况；最终结论没有收到上游理由与检测信号，三类结论的标准和复核步骤也不够明确。

先做不产生模型费用的实验保护：任何 499、取消、缺失或跳过样本都让报告判定为不完整；加入唯一标签、数据集/配置/代码版本记录、原子写入且不覆盖旧报告；接通配置中的重复题阈值；禁止 `0/0` 被判定为通过；将昂贵的思维过程安全缓存到私有目录。

然后扩充人工标定集：

- Codeforces 难度、思维难度、代码难度各至少 60 题，覆盖至少三个等级。
- 最终结论至少 90 题，通过、需要修改、不通过各 30 题，并包含缺约束、题解错误、样例问题、歧义、质量问题和重复题。
- 完整流程至少 30 题。

建议的最低指标：

- Codeforces 难度平均绝对误差不超过 200，误差不超过 200 的比例至少 75%。
- 思维/代码难度完全一致至少 60%，相差不超过 1 级至少 90%，平均绝对误差不超过 0.6。
- 标准解编译成功至少 98%，样例运行成功至少 95%。
- 三类最终结论总体一致至少 80%，每类至少 75%；人工不通过被 AI 判为通过不超过 5%，人工通过被 AI 判为不通过不超过 5%。
- 关键错误发现至少 95%；真实重复题发现至少 95%，非重复题误判不通过不超过 5%。

任何提示词、处理步骤、权重或映射表修改都必须先跑完整旧方案，保留旧报告，再用新标签跑候选方案并保留两份报告对比。用户尤其强调：不要再用 120 秒总时限取消仍在正常生成的模型请求，也不要把已经付费但被客户端取消的 499 当成模型失败。

使用真实 USTC 私有题目调用外部模型前，必须先取得顶层 `AGENTS.md` 中那句明确同意；当前没有这项同意。

### 4.3 Anklang

- 分支：`codex/service-hardening`
- 当前提交：`35cf974`
- 交接时工作区干净并与远端一致。
- Python 3.11+，运行时零第三方依赖。
- 旧服务器基线曾达到完整 146 项、目标 109 项测试通过；复制和新环境建立后仍要重跑，不能把旧数字当新目录的验证结果。
- 转发模式、本地检索框架、来源接口和示例来源已存在。真实抓取源不能进入公开仓库。
- vjudge 来源按计划暂缓，原因是规模、合规、账号和代理维护风险。代理现在可用不代表这些风险消失，不要擅自开始公开爬虫。
- 旧 Anklang 的本地数据仍在 `previous-server-work/urmotiv-codex/anklang-repo/problems-data/`，不得因正式仓库没有这个目录而判断数据无用。

## 5. 历史题目：必须继续，但不能直接批量导入

私有目录当前安全摘要：`hist_problem/` 顶层有 71 个混合文件，其中 45 个 Markdown、23 个 ZIP、1 个表格、1 张图片、1 个 PDF；仓库根目录另有 `USTC题目列表.xlsx`。这些是文件容器，不是 71 道题：有些 Markdown 和 ZIP 内含多题，一道题也可能分散在多个文件中。

迁移前服务器另有 244 个私有实验文件，现完整保留在 `previous-server-work/urmotiv-codex/private/`。它们与正式仓库 `Urmotiv/private/` 中的资料不是同一批文件，不能互相替代，也不能批量导入 Git。

已有 `scripts/migrate-hist` 只接受人工提前拆好的 Markdown/文本，并要求两次确认。现有私有目录里只有清单和未确认材料，还没有可直接导入的正式题目包。

推荐的安全流程：

1. 只读扫描文件名、类型、大小和哈希，不打印题面内容。
2. 人工建立“来源文件与题目”的多对多分组；不能假定一个文件就是一道题。
3. 第一次确认后锁定来源文件哈希，防止材料在审核中被替换。
4. 生成候选字段；使用外部模型前先取得用户对私有题面的明确同意。
5. 人工逐题核对 USTC 题目列表并完成第二次确认。
6. 每道题生成一个系统原生题目包，再通过现有导入接口进入系统。

不要直接写数据库。走正式导入接口可以复用压缩包安全检查、字段校验、权限检查、审计记录和失败恢复。ZIP、PDF、图片和混合打包文件要进入人工处理队列；解压必须使用题目包规定的防路径跳出、符号链接、压缩炸弹和大小限制。

先完成 `grouping.ts` 的合成资料测试，再扫描真实目录。处理真实数据时只把结果写入 `Urmotiv/private/` 下的专用子目录，保持权限为仅当前用户可读写；不要提交生成的清单、拆分文件或题目包。

## 6. 已完成能力与仍需核实的遗留项

已提交的主线能力包括账号与权限、投题审题、题目编辑、组题、题目访问记录、题目文件、原生题目包导入导出、插件宿主、默认审核规则、插件/审核规则管理页、Anklang 和 Fermata 接口，以及 AI 附加功能的工程实现。具体以规格、代码和测试为准，不以这句话替代验收。

仍需推进或核实：

1. 当前未提交的“评价互相可见、只能编辑本人评价、评价变化触发题目状态变化”需要静态复核与服务器测试。
2. 当前未提交的题目包审计修改需要单独审阅、测试、提交。
3. 历史题目分组与实际导入尚未完成。
4. Fermata 工程超时问题已修，但准确性未达标，需要完整标定集和提示词/处理步骤迭代。
5. CAS 真实登录仍需要持有统一身份账号的用户在浏览器点一次登录，确认稳定身份字段。占位字段取不到时会返回 `subject_attribute_missing` 并列出 CAS 返回的字段名，再据此填写环境变量，无需先改代码。
6. 原始 XML 传输与任务安全重试已有提交，但 FPS XML 的完整语义转换、比赛整包导出和跨 OJ 格式矩阵要按 `problem-package.md` 继续核实；不能仅凭提交标题宣布全部完成。
7. 导入时“更新已有题目”的分支仍需先设计目标题目的编辑权限检查，不能绕过正常修改权限。
8. Docker 此前因 Docker Hub 域名解析失败没有完成容器启动。新代理可能解决下载问题，但这是部署验证，不应抢在未提交代码的复核之前，也不能影响服务器其他项目。
9. 最终必须逐条对照 `private/urmotiv.txt`，特别核实 CF 难度、题目质量、思维难度、代码难度、标签、修改建议、综合评价以及通过/需要修改/不通过，是否按用户原意组合并进入可配置审核规则。

## 7. 建议的首次验证顺序

先核对 Linux 依赖。不要信任从 Windows 复制的依赖目录；确认锁文件后在各自仓库安装：

```bash
cd /home/ubuntu/codex-urmotiv/Urmotiv
pnpm install --frozen-lockfile

cd /home/ubuntu/codex-urmotiv/Fermata
pnpm install --frozen-lockfile
```

如果锁文件检查失败，先查明是未提交锁文件变化还是平台差异，不要直接改锁文件后混入业务提交。

第一批只验证 Urmotiv 当前审核改动：

```bash
cd /home/ubuntu/codex-urmotiv/Urmotiv
pnpm --filter @urmotiv/api typecheck
pnpm --filter @urmotiv/web typecheck
pnpm --filter @urmotiv/api test -- review-decision-flow.test.ts
pnpm --filter @urmotiv/web test -- problem-tabs.test.tsx demo-login-page.test.tsx problem-workspace-page.test.ts
```

确认目标测试命令确实收集到指定文件；若脚本不转发文件参数，运行该工作区完整测试。页面行为修复后运行 Playwright 的桌面与手机视口。

第二批单独验证题目包审计与导入导出修改，包括无权创建、权限撤销后下载、压缩包异常、任务重试和审计失败路径。然后才跑 Urmotiv 完整检查：

```bash
pnpm typecheck
pnpm test
pnpm build
pnpm test:e2e
```

再验证独立服务：

```bash
cd /home/ubuntu/codex-urmotiv/Fermata
pnpm typecheck
pnpm test

cd /home/ubuntu/codex-urmotiv/Anklang
python3 -m unittest discover -s tests
```

Fermata 付费实验不要紧跟单元测试自动启动。先修实验完整性保护、确认公开数据集与预算，再用唯一标签后台运行。运行中只观察安全的进度、状态码和计数，不打印请求正文、模型原始响应或密钥。

## 8. 权限和安全验收清单

任何相关改动至少覆盖这些反例：

- 作者猜其他题号读取题面、评价、附件、任务或导出包，返回应与题目不存在一致。
- 被禁止登录或被明确拒绝权限的用户仍从角色获得允许。
- 机器人试图删除题目/用户、模拟登录、管理权限/系统或读取密钥。
- 导出任务创建后权限被撤销，旧下载地址仍被拒绝。
- 插件试图跳过核心权限检查、解除机器人固定禁止项或修改冻结字段。
- 用户伪造审核人、评价编号或编辑他人评价。
- 普通可读用户从公开评价接口得到 `privateNote`。
- 修改本人评价触发规则后，题目状态与决定一致；失败时不留下半更新状态。
- 导入压缩包包含上级路径、绝对路径、符号链接、重名、异常压缩比或超限文件。

无权限时不能从响应正文、状态差异、总数、排序、后台任务和错误信息推断私有题存在。权限判断全部在服务端完成。

## 9. 提交与推送方法

用户要求勤提交并允许推送，但 Urmotiv 当前不能整体提交。建议顺序：

1. 用 `git diff -- <精确文件>` 审阅一组改动。
2. 运行该组类型检查和目标测试。
3. 用精确路径暂存；再次用 `git diff --cached --name-status` 核对。
4. 创建只描述这一组行为的小提交并推送 `codex/review-admin`。
5. 在本文后续交接记录真实提交号、命令和结果。

Fermata 和 Anklang 当前已推送，不要为了“留下记录”创建空提交。私有数据和实验原始响应永远不提交。

## 10. 给接手智能体的首要任务

1. 确认根目录结构、迁移核验记录、工具版本和三仓库状态；正式开发只在三个根仓库中进行，旧实验资料按需只读查阅。
2. 静态复核 Urmotiv 审核可见性/本人编辑改动，特别检查缓存、草稿跨账号、内部备注泄露、关闭轮次和失败回滚。
3. 在服务器跑这组目标测试与页面测试，修复后小步提交并推送。
4. 分离并完成题目包审计改动。
5. 完成历史资料的安全分组工具和合成测试，再对照 USTC 题目列表整理真实数据。
6. 修 Fermata 实验完整性和写死阈值，建立足够大的公开标定集；准确性不达标就继续调整提示词和处理步骤，但绝不恢复短总时限。
7. 最后读取 `private/urmotiv.txt` 做全需求对照，明确哪些已实现、哪些有证据、哪些仍需用户操作或明确授权。

交接原则只有一句：保留证据、承认未验证、不要浪费付费请求、不要让私题和权限边界因为赶进度而失守。
