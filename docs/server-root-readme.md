# codex-urmotiv 服务器目录说明

这是 Urmotiv、Fermata、Anklang 三个仓库以及全部服务器实验资料的唯一项目根目录。进入服务器后从这里启动 Codex：

```bash
cd /home/ubuntu/codex-urmotiv
codex
```

主目录下的其他文件和项目不在本项目范围内。不能凭文件名猜测归属；`/home/ubuntu/cc.sql` 明确不属于本项目，不得查找、恢复或处理。

## 根目录

| 路径 | 用途 | 是否用于正式开发 |
| --- | --- | --- |
| `Urmotiv/` | 题库与命题协作主系统，独立 Git 仓库 | 是 |
| `Fermata/` | AI 审题服务，独立 Git 仓库 | 是 |
| `Anklang/` | 原题检索服务，独立 Git 仓库 | 是 |
| `previous-server-work/` | 迁移前的服务器实验环境、实验数据、私有配置和工具原样归档 | 否，默认只读 |
| `validation/` | 目录迁移、部署和测试的安全核验记录 | 只写安全摘要 |
| `AGENTS.md` | 整个根目录必须遵守的开发与安全规则 | 必须先读 |
| `HANDOFF.md` | 当前代码状态、遗留任务和准确性证据 | 必须先读 |
| `PROMPT-FOR-NEXT-AI.md` | 可直接交给新 AI 的接手提示词 | 启动时使用 |

三个正式仓库来自 Windows 工作区的完整复制，含 `.git` 和尚未提交工作。复制来的 `node_modules` 可能带有 Windows 平台文件，不能当作 Linux 依赖已经安装；在服务器根据锁文件重新核对依赖。

## previous-server-work

这个目录参照 `/home/ubuntu/codex-dolly/previous-server-work/` 的整理方式：旧环境不删、不混入正式仓库，完整放在一个清楚命名的目录中。不要在这里创建新业务提交。

### `previous-server-work/urmotiv-codex/`

这是迁移前完整的服务器工作目录，约 3.64 GB。移动前后保持 65,857 个普通文件、2,736 个链接和 8,889 个目录。主要内容：

| 子路径 | 用途 | 处理规则 |
| --- | --- | --- |
| `repo/` | 旧 Urmotiv 服务器副本，含数据库测试状态、构建结果和浏览器测试截图 | 只用于恢复与对照，正式代码以根目录 `Urmotiv/` 为准 |
| `fermata-repo/` | 旧 Fermata 运行环境，含私有环境配置和 21 份实验结果 | 环境文件不得直接显示或提交；结果用于准确性基线 |
| `anklang-repo/` | 旧 Anklang 运行环境和本地检索数据 | 数据未迁入正式仓库，保留待核对 |
| `fermata-accuracy-20260731/` | 准确性实验快照，含 6 份结果 | 保留修改前证据，不能只留新报告 |
| `fermata-timeout-review-20260731/` | 长时间模型调用与 499 问题的审查快照，含 11 份结果 | 用于复核超时修复，不再使用 120 秒总时限 |
| `agent-plugin-secret-startup-20260730-a/` | 插件密钥启动失败路径的隔离测试副本 | 含测试数据库状态，不能未核对就删 |
| `private/` | 244 个旧服务器私有实验文件和安全环境配置 | 仅当前用户读取，不进入 Git、日志或聊天 |
| `research/hydro-format/` | Hydro 题目包格式研究资料，共 40 个文件 | 后续扩展导入导出格式时查阅 |
| `browsers/` | Playwright 浏览器程序 | 可复用；只有新浏览器安装并验证后才可清理 |
| `node-v24.18.0-linux-x64/` | Linux Node.js 24 运行环境 | 可复用，避免误用 Windows 依赖 |
| `node-v24.18.0-linux-x64.tar.xz` | 上述 Node.js 的原始压缩包 | 属于可重新下载资料，但当前先保留 |
| `contest-*-latest.png` | 最近一次桌面与手机页面检查截图 | 只作界面证据，不代表当前未提交代码已通过 |
| `private-compose-check.env`、`fermata-repo/.env` | 私有环境配置 | 权限保持 `600`，禁止 `source` 或 `.` 加载 |

旧 `repo/` 中还有约 188 MB 数据库状态；插件隔离副本中另有约 128 MB 数据库状态。这些是数据库直接使用的文件目录，用来恢复当时测试状态，不能与 SQL 导出文件或正式部署数据库混为一谈。

### `previous-server-work/codex-urmotiv-database-foundation-019f99c1/`

这是 2026-07-25 左右建立的数据库基础实验副本，约 658 MB。移动前后保持 27,627 个普通文件、1,182 个链接和 4,323 个目录。它没有当前正式仓库缺少的独有路径，但同名文件内容可能代表较早阶段，删除前仍需逐文件核对；依赖和 Linux Node.js 也保留在其中。

### `previous-server-work/malformed-empty-directories-20260730/`

这是一次错误命令留下的异常目录结构，共 53 个目录，没有普通文件或链接。它不参与开发，仅作为事故记录保留，避免在未说明的情况下直接删除。

## validation

`validation/20260731-consolidation/README.md` 记录本次从三个顶层目录归并为一个根目录的来源、目标和核验数字。后续验证记录不得包含题面、题解、测试数据、密钥、模型原始回答或私有文件名清单。

## 使用规则

1. 正式改代码只进入根目录的 `Urmotiv/`、`Fermata/`、`Anklang/`。
2. 旧实验资料默认只读。要采用其中内容，先复制到明确的私有工作目录或逐文件移植代码，不能整目录覆盖正式仓库。
3. 不得从旧副本提交或推送；它们可能没有完整 Git 历史，也可能含私有文件。
4. 不得清理 `previous-server-work/`，除非先证明相应数据已经迁移、实验可复现，并得到用户明确同意。
5. 服务器进程只能按进程号、父进程、完整命令和工作目录确认归属后结束，不能按名称批量结束 Node.js 或 Python。

## Urmotiv 管理员凭据恢复

管理员初始化完成后，只有现场真实 TTY 可以执行恢复。命令不接受参数；它会要求两次输入 `确认`，在一个事务中锁定唯一符合条件的内置 `system_administrator` 人类本地密码账号，递增认证版本、撤销全部现有会话并写入不含秘密的审计记录。零个或多个候选、停用账号、根账号、机器人/服务账号、非管理员账号以及失效成员关系都会安全失败。

恢复命令只在事务成功提交后，通过 `/dev/tty` 写出账号标识和新密码各一次；标准输出只会收到固定结果码，密码不会进入参数、环境变量、日志、错误或审计。若账号有已验证邮箱，账号标识就是该邮箱，否则显示内部编号。操作者应立即使用新密码登录，并在安全位置按部署流程保存或轮换它。

仅 SSH 本机回环 HTTP 测试可将 `URMOTIV_WEB_ORIGIN` 精确设为 `http://127.0.0.1:8080`（也接受 `localhost` 或 `[::1]` 的回环主机）并显式设置 `URMOTIV_ALLOW_LOOPBACK_INSECURE_COOKIES=true`。生产默认仍使用 Secure Cookie；非回环 HTTP origin 或非回环 opt-in 会阻止 API 启动。

在已构建并已迁移的 Compose API 镜像中，使用以下命令执行恢复。不要把密码写入 shell 历史或重定向；命令必须在真实 TTY 中直接运行：

```bash
docker compose --project-name urmotiv-final-20260828 --env-file /home/ubuntu/codex-urmotiv/Urmotiv/private/urmotiv.env -f /home/ubuntu/codex-urmotiv/.tools/worktrees/urmotiv-final-integration-20260828/compose.yaml run --rm --no-deps api pnpm --filter @urmotiv/api recover-admin-credentials
```

用户本人而不是 OMP 必须运行该命令；新账号标识和密码只会在 `/dev/tty` 显示一次，然后登录 `http://127.0.0.1:8080/login`。
