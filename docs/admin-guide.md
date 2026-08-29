# 管理员指南

“系统管理员”负责账号、权限、运行设置和插件；“组长”负责题目终审和组题。两者可以由同一名人工用户兼任，但系统管理员角色本身不会自动获得最终审题权。

## 首次管理员与恢复

### 首次初始化

全新迁移数据库会先进入 bootstrap（首次初始化）阻塞状态。服务在管理员创建前不开放正常业务登录。使用真实服务器 TTY 执行：

```bash
docker compose --env-file /secure/path/urmotiv.env run --rm --no-deps api pnpm --filter @urmotiv/api bootstrap-admin
```

命令会隐藏读取邮箱两次和密码两次，密码长度必须为 12–1024 个字符；输入不一致或非 TTY 会失败。成功输出固定字符串 `BOOTSTRAP_ADMIN_OK`，并创建一名新的人工“系统管理员”，不会把无密码的 seed root（仅用于初始化/恢复的种子账号）变成可登录身份。成功后：

```bash
docker compose --env-file /secure/path/urmotiv.env up -d api web worker
```

不要通过 CI、管道、聊天机器人或重定向传入凭据。首位管理员邮箱作为已验证邮箱保存；邮箱注册仍默认关闭。

### 遗失密码恢复

恢复只针对已完成 bootstrap 后**恰好一名**仍启用、具内置“系统管理员”角色且已有本地密码的人工管理员。服务器操作员必须在真实 TTY 执行；用下面的 `compose exec` 精确命令（容器内 `/dev/tty` 直接连到操作员终端）：

```bash
docker compose --env-file /secure/path/urmotiv.env exec api pnpm --filter @urmotiv/api recover-admin-credentials
```

**禁止使用 `docker compose run`**：`run` 创建的进程由编排层转发 TTY，恢复输出可能被记录进容器日志或保留一次性容器，违背“密码永远只出现在服务器 TTY”的保证。命令要求在两个隐藏提示中各输入一次 `确认`。成功输出 `RECOVER_ADMIN_CREDENTIALS_OK`，新账号标识和随机新密码只写入服务器的 `/dev/tty`，不会出现在 API、日志或审计记录中。恢复会使该管理员的所有现有 Web 会话立即失效；新密码只由操作员在服务器 TTY 当场记下并登录修改，**绝不通过即时通讯、邮件或其他渠道分享或传输**。

### root 本地恢复

bootstrap 完成后，固定 `root` 仍没有本地凭据；紧急维护时只能在真实服务器 TTY 执行：

```bash
docker compose --env-file /secure/path/urmotiv.env exec api pnpm --filter @urmotiv/api recover-root-credentials
```

命令在访问数据库、生成凭据或写入秘密前检查输入和输出都是真实 TTY；禁止使用 `docker compose run`、管道或重定向。操作员需两次隐藏输入“确认”，固定结果只写标准输出，凭据值只写入服务器 `/dev/tty`，不进入 API、日志或审计记录。恢复后的 root 只能从专用本地入口登录，不走邮箱、CAS 或 OAuth。

### 执行前的路径金丝雀

恢复本身不读取数据库、环境值或调用口令生成之前，就要求输入输出都是真实 TTY。先用同一个精确路径做一次非机密的随机标记金丝雀，确认能到达真实 TTY；随机标记可以直接生成（例如 `/dev/urandom` 前 16 字节的十六进制）：

```bash
CANARY_MARKER=$(od -An -N16 -tx1 /dev/urandom | tr -d ' \n')
docker compose --env-file /secure/path/urmotiv.env exec api pnpm --filter @urmotiv/api recover-admin-credentials --canary "$CANARY_MARKER"
```

金丝雀与恢复共用同一条 `/dev/tty` 写入边界：非机密标记只经该边界送达操作员终端一次，stdout 只报告固定结果与次数（`RECOVER_ADMIN_CREDENTIALS_CANARY_OK count=1`），不会读取数据库、环境内容或生成口令。用 `-T`（强制非 TTY）执行同一金丝雀会立即输出 `RECOVER_ADMIN_CREDENTIALS_TTY_REQUIRED`，证实非 TTY 路径在任何数据库连接、口令生成或 TTY 写入之前失败关闭：

```bash
docker compose --env-file /secure/path/urmotiv.env exec -T api pnpm --filter @urmotiv/api recover-admin-credentials --canary "$CANARY_MARKER"
```

常见固定结果：

| 结果 | 含义 |
| --- | --- |
| `RECOVER_ADMIN_CREDENTIALS_TTY_REQUIRED` | 输入或输出不是实际 TTY（例如 `-T`）；在真实 TTY 重试；发生在任何数据库访问或口令生成之前 |
| `RECOVER_ADMIN_CREDENTIALS_CANARY_OK` | 带 `--canary <marker>` 的金丝雀：只报告标记存在与出现次数，未触碰数据库或口令 |
| `RECOVER_ADMIN_CREDENTIALS_CONFIRMATION_REQUIRED` | 两次确认不是精确的“确认” |
| `RECOVER_ADMIN_CREDENTIALS_UNAVAILABLE` | bootstrap 未完成、候选管理员不是恰好一名，或账号已停用 |
| `RECOVER_ADMIN_CREDENTIALS_POSTGRES_REQUIRED` | 环境文件没有 `DATABASE_URL` |
| `RECOVER_ADMIN_CREDENTIALS_INPUT_ABORTED` | 操作员中止了隐藏输入 |
| `OUTCOME_UNKNOWN` | 操作结果不能安全确认；不要再次猜测执行，先核对数据库和审计状态 |

这项设计故意没有 Web“忘记密码”后门；操作员不能在不接触服务器 TTY 的情况下代替管理员重置密码。

### 邮箱登录限流

`/api/v1/auth/email-login` 只按解析后的来源地址（远端或受信代理后的地址）做服务端限流：同一来源在窗口内失败次数超过上限后，连续尝试统一返回通用的 `429 LOGIN_RATE_LIMITED`，响应不含任何邮箱或账号信息。限流绝不按邮箱或账号键控，窗口过期后自动恢复，成功登录立即清除该来源的失败记录；地址无法解析时放行。演示登录、OAuth/CAS 与其余认证入口不参与此限流。

## 角色和权限模型

权限（允许执行某类操作的名称）可以通过内置角色继承，也可以有按用户、角色或单个对象的明确允许/拒绝记录。权限还可以设置过期时间。当前内置角色如下：

| 角色键 | 显示名 | 用途 |
| --- | --- | --- |
| `contributor` | 投稿人 | 创建、查看和编辑自己的题目 |
| `reviewer` | 审题人 | 查看可见待审题目并提交审题意见；可读取内部评测资料 |
| `problem_setter` | 命题组成员 | 编辑可见题目、维护评测资料、组题和查看访问风险 |
| `leader` | 组长 | 终审题目、授予单题访问权、管理组题、题目包导入导出和知识点 |
| `system_administrator` | 系统管理员 | 账号、权限、系统设置、插件、机器人账号、知识点和审计 |
| `root` | root | 仅用于首次配置和紧急恢复的种子角色；不应作为日常登录身份 |

核心权限包括 `auth.login`、`problem.create`、`problem.view.own`/`problem.view.all`、`problem.edit.own`/`problem.edit.all`、`problem.review`、`problem.status.change`、`problem.frozen.edit`、`problem.import`、`problem.export.own`/`problem.export.all`、`problem.testdata.read`/`problem.testdata.write`、`contest.*`、`plugin.manage`、`user.create` 和 `audit.read`。完整名称与作用域见[权限参考](permissions.md)。

本版本的管理页面路径为 `/admin/users`、`/admin/roles` 和 `/admin/roles/defaults`，分别用于用户权限增量、角色权限和默认角色维护；角色管理 API 使用 `GET/POST /api/v1/admin/roles` 和 `PUT /api/v1/admin/roles/:roleId`，可创建自定义角色、设置每项权限的允许或明确拒绝、分配人工账号或机器人账号。内置角色的名称和权限不可修改，但可以调整成员归属；服务端仍会检查 `user.permission.manage`，机器人账号不能通过角色解除固定禁止。所有修改都按角色修订号乐观并发检查并写入审计记录，冲突时应刷新后重试；不要直接在生产数据库临时写 SQL。

### 明确拒绝优先

同一权限同时存在允许和拒绝时，只要有一条匹配的活动拒绝就失败。判断顺序是：

1. 停用账号或没有 `auth.login`，全部操作失败。
2. 全局拒绝优先于全局允许；单题拒绝优先于自己的或全局允许。
3. `own`（本人拥有的对象）只匹配对象所有者；`object`（指定对象）只匹配给定题目/比赛。
4. 权限过期后不再匹配。
5. 机器人硬拒绝最后仍然生效，插件和令牌不能解除。

读取题目、附件、导出任务或后台资源时，如果请求者没有资格知道它是否存在，服务统一返回 `404 Not Found`（不存在），而不是暴露“有资源但无权访问”的差异。该语义也适用于 `/admin/plugins` 及其配置接口；合法用户的字段校验/版本冲突仍会按各自错误返回。

## 机器人账号和令牌

机器人账号用于受控的审核任务，不是人类账号，也不能用于比赛参赛。系统固定禁止机器人：删除用户、模拟登录、管理用户权限、管理系统、管理插件、管理机器人账号、管理知识点、删除题目、删除比赛、读取审计记录。账号允许的权限还会与 API 令牌的权限取交集；令牌只能收窄权限，不能增加允许或抹掉拒绝。

机器人令牌在创建或轮换时只显示一次原文；数据库只保存不可还原的校验摘要。使用独立的保密通道交给机器人，不能放在题目、插件设置明文、日志或 Git。令牌丢失时轮换而不是尝试恢复原文。

机器人审核接口的主要路由为：

- `POST /api/v1/robot/review-tasks/claim`：按令牌领取有权限的待审任务。
- `POST /api/v1/robot/review-tasks/:assignmentId/renew`：在租约（任务暂时归该机器人处理的期限）内续租。
- `POST /api/v1/robot/review-tasks/:assignmentId/complete`：提交一份当前修订的审核意见。

租约过期、题目修订或知识点目录变化会使任务不可继续；旧任务不会因为重试而覆盖新轮次。

## `/admin` 管理面板

登录后访问 `/admin`，服务端会再次检查 `plugin.manage` 和 `system.manage` 或相应管理权限：

- **插件**：查看内置插件状态、版本、声明的密钥是否已配置，并提交启用/停用/设置更新。每次更新使用当前 `settingsRevision`；冲突时刷新后重试。密钥只显示“已配置”标记，不会回显完整值或任何字符。
- **知识点目录**：维护知识点、分类、别名和停用预览；停用前先处理仍在使用的题目，历史题目不会隐式改写。
- **审核策略**：调整默认审核人数规则；修改后只影响新的审核轮次，不改变已经固定的历史意见。

插件页面显示 `requiresRestart` 时，配置会保存但要按部署流程重启对应服务。当前宿主只加载编译进服务端的受信任内置插件，没有上传并即时执行任意插件包的管理按钮。

## 备份与恢复

数据库备份脚本要求两个参数：私有环境文件和备份目录；它会先验证环境文件权限为 `600`，再以 PostgreSQL custom 格式写出备份，并把备份目录设为仅所有者可读：

```bash
bash scripts/deploy/backup.sh /secure/path/urmotiv.env /secure/path/backups
```

备份目录和环境文件都应位于 Git 目录之外，并由组织自己的加密/离线策略保护。脚本只备份 PostgreSQL；对象存储中的题目附件需要按其存储服务的生命周期和快照策略另外备份，不能假设数据库 dump 包含文件内容。

恢复前停止会写入数据库的应用，确认备份来源和目标数据库，再把 custom dump 通过标准输入交给 Compose 内的 `pg_restore`：

```bash
docker compose --env-file /secure/path/urmotiv.env stop api worker web
cat /secure/path/backups/postgres-YYYYMMDDTHHMMSSZ.dump | docker compose --env-file /secure/path/urmotiv.env exec -T postgres sh -c 'pg_restore --clean --if-exists --no-owner --dbname="$POSTGRES_DB" --format=custom -'
docker compose --env-file /secure/path/urmotiv.env up -d --remove-orphans
```

`YYYYMMDDTHHMMSSZ` 只是备份文件名的合成示例；不要照抄不存在的文件名。恢复会覆盖目标数据库中的当前数据，先在隔离数据库演练并保留恢复前快照。恢复后检查 `docker compose ... ps`、`GET /api/v1/health` 和管理员登录；如果恢复的是 bootstrap 未完成的快照，必须重新走一次 TTY 初始化。

升级脚本会按“校验环境 → 构建 → 停止应用 → 备份 → 运行迁移 → 启动 → 健康检查”的顺序执行：

```bash
bash scripts/deploy/upgrade.sh /secure/path/urmotiv.env /secure/path/backups
```

升级失败时不要删除卷或数据库；查看固定错误摘要和服务日志，保留备份后再决定回滚镜像或恢复数据库。生产 HTTPS、健康检查和 SSH 转发步骤见[部署指南](deployment.md)。
