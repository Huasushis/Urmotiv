# @urmotiv/database

这个包保存 Urmotiv 的数据库表、迁移和首次初始化方法。迁移是按版本依次执行的数据库修改步骤。
Drizzle 是把 TypeScript 表定义转换成 PostgreSQL 查询的库；这里导出的表定义供 API 和后台任务使用，
业务代码不应复制一份表结构。

## 两种运行方式

- 服务器使用 PostgreSQL，通过 `createPostgresDatabase` 创建连接池，也就是一组可以重复使用的数据库连接。
- 无 Docker 的轻量开发模式使用 PGlite。PGlite 是运行在同一进程里的小型 PostgreSQL，数据可以保存到单个目录，
  通过 `createLocalDatabase({ dataDirectory: ".data/database" })` 打开。

两种方式运行同一份迁移。PGlite 适合开发界面和小规模测试，不代替服务器的 PostgreSQL 备份、并发和容量测试。
按照仓库约定，安装依赖、执行迁移和运行测试都在 `ssh ustc` 指向的服务器完成，本机只编辑文件。

API 服务按以下环境变量选择数据库：

- 设置 `DATABASE_URL` 时连接 PostgreSQL。生产环境必须设置这个值，不会在连接失败或漏配时改用内存数据。
- 开发环境没有设置 `DATABASE_URL` 时使用 PGlite。`URMOTIV_PGLITE_PATH` 留空会保存到
  `.data/database`，也可以把它改为服务器上的另一个私有目录。
- PGlite 启动时会执行仓库中的迁移。开发环境 PostgreSQL 只有在明确设置 `URMOTIV_DATABASE_MIGRATE=true`
  时才随 API 启动执行迁移。生产 API 固定拒绝进程内迁移，必须先运行独立迁移命令，避免全新数据库
  绕过首位管理员初始化保护。
- 只有 `URMOTIV_DEMO_AUTH=true` 与 `URMOTIV_DEMO_SEED=true` 同时设置时，才会创建人工演示账号和知识点。
  生产环境拒绝演示登录，因此也不会创建这些数据。

```ts
import {
  createPostgresDatabase,
  migrateDatabase,
  seedCoreDatabase
} from "@urmotiv/database";

const connectionString = process.env.DATABASE_URL;
if (connectionString === undefined) {
  throw new Error("服务器没有设置 DATABASE_URL");
}

const database = createPostgresDatabase({
  connectionString
});

await migrateDatabase(database);
await seedCoreDatabase(database);
```

连接地址必须来自服务器环境，不能写进代码、迁移、测试快照或日志。调用方退出时应执行
`await database.close()`。

## 数据如何分组

- `users`、`user_emails`、`external_identities` 和 `user_identifiers` 保存账号、邮箱、USTC 统一身份登录返回的身份，
  以及学号等可变标识。标准化后的邮箱在全站唯一。
- `roles`、`role_memberships`、`permission_definitions` 和 `permission_grants` 保存角色与授权。
  同一操作可以同时有允许和拒绝记录；API 必须先查拒绝，只要有一条匹配的拒绝就停止。
- `sessions` 和 `api_tokens` 只保存随机令牌的 SHA-256 摘要，也就是可用于核对令牌但无法还原原文的固定长度指纹，
  不保存浏览器或机器人拿到的原始令牌。
  `auth_revision` 用于在密码、邮箱或权限变化后让旧会话失效。
- `problems` 保存题目所有者、状态和当前版本号；`problem_revisions`、`problem_samples`、
  `problem_revision_tags` 与 `problem_revision_files` 保存每个版本的完整内容。
- `review_rounds`、`review_assignments`、`review_opinions` 和 `review_items` 保存每次提交后的审核过程、
  当前审题分配和意见。旧轮次不会被新轮次覆盖。
- `problem_access_aggregates` 只累计首次访问、最后访问和页面实际活动秒数，不把页面在后台打开的时间算进去。
- `contests`、`contest_members` 和 `contest_problems` 保存组题。每道比赛题固定到一个明确题目版本，
  后续编辑不会悄悄改变已组好的比赛。
- `stored_files` 只保存文件大小、SHA-256 校验值和对象存储位置，文件内容不进入数据库。
- `import_jobs`、`import_job_items`、`export_jobs` 和 `export_job_problems` 保存后台任务、固定版本和简短结果。
  导出文件过期时间也在任务中记录。
- `installed_plugins` 与 `plugin_settings` 保存插件和普通设置。插件密钥单独放在 `plugin_secrets`，
  其中只能保存服务器加密后的内容。
- `audit_events` 保存重要操作的操作者、目标、结果和请求编号。数据库拒绝更新或删除这张表中的已有记录。

审计事件的 `metadata`、任务的 `report` 和插件设置使用 JSON，也就是能按字段保存简单结构的文本数据，
但不得写入题面全文、题解、测试数据、密码、令牌或密钥。JSON 只是为了保存结构不固定的简短信息，
不会降低保密要求。

## 题目版本更新

“按预期版本更新”是指保存时带上页面最初读到的版本号。如果另一名用户已经先保存，数据库更新不到任何行，
API 应返回冲突并让用户重新载入，不能覆盖新内容。一次正常保存需要放在同一个数据库事务中；事务是一组
要么全部成功、要么全部撤销的操作：

1. 用 `WHERE id = ? AND current_revision = ?` 更新 `problems`，并把版本号加一；
2. 插入新的 `problem_revisions` 行以及该版本的样例、标签和文件关系；
3. 提交事务。

`problems_current_revision_fk` 是延后到事务结束才检查的外键。外键是数据库用来确认一条记录确实指向另一条
已有记录的约束；这里先允许上述两步暂时不完整，提交前再确认当前版本确实存在。
如果第一步没有更新到行，必须回滚整个事务。待审和已通过题目的三个冻结字段仍由 API 比较新旧值并拒绝修改；数据库版本号不能替代这项检查。

## 首次初始化

`seedCoreDatabase` 可以重复执行。它会创建：

- 编号固定为 `0` 的 `root` 用户；
- 权限文档中的核心权限；
- 投稿人、审题人、命题组成员、组长、系统管理员和 root 六个初始角色；
- root 用户的角色关系。

初始化不会覆盖已经存在的角色授权。`root` 是不可登录的内部初始化授权者，固定使用编号 `0` 和昵称
`root`，不会绑定密码、邮箱、CAS 身份、会话或 API 令牌。不得把它当作真人管理员账号。

独立迁移命令会为“一次性的首管理员初始化”维护一个资格标记。迁移文件本身始终把标记建成
`blocked`（不可用）；只有独立的 `pnpm --filter @urmotiv/api migrate` 命令在迁移前确认数据库
完全没有非系统对象，并在迁移与默认初始化后再次确认数据库只有正式初始数据时，才会把标记改成
`open`。API 普通启动、重复执行迁移、旧库升级以及已经发生过中断的初始化都不会打开它。

这个保护不是清库工具。若首次迁移中断并留下 `blocked`，只能在运维人员确认数据库尚无任何业务数据、
也没有需要保留的初始化结果后，删除并重新创建整个目标数据库，再重新运行独立迁移命令。不能删除表、
改迁移记录或手工更新资格标记来伪装成全新数据库；已有数据库应保留 `blocked`。标记一旦进入
`completed` 就不能回到其他状态。

全新 PostgreSQL 数据库的独立迁移成功后，API 会在监听端口前检查到 `open` 并拒绝启动。管理员必须在
真实终端中运行 `pnpm --filter @urmotiv/api bootstrap-admin`。命令不接受参数、管道、重定向、JSON、
密码文件或环境变量中的账号凭据；邮箱和密码各输入两次，四次输入均不回显。它会创建一个独立的普通人类
账号，为其写入 Argon2id 密码、已验证主邮箱和内置 `system_administrator` 角色，然后把标记改为
`completed`。用户、邮箱、角色关系、安全审计和标记更新同处一个事务；任何一步失败都会回滚。

命令只输出固定结果码，不输出邮箱、账号编号、密码摘要或数据库错误。若返回 `OUTCOME_UNKNOWN`，说明连接
或提交结果无法确认；命令不会自动重试。恢复连接后可以重新运行，程序会先只读检查标记，已完成时不会再次
询问凭据或创建账号。

普通邮箱账号至少保留一个邮箱、机器人固定禁止项、拒绝优先、题目字段冻结、附件读取和导出下载的再次授权检查，
都需要 API 在事务中执行。数据库约束负责阻止明显无效或互相矛盾的数据，但它不能知道当前请求者是否有权操作。

用户、题目和比赛编号在数据库中使用 `bigint`，它是能保存很大整数的字段。TypeScript 读取后得到原生 `bigint`；
API 必须调用 `.toString()` 把编号转换成十进制字符串，不能先转成普通 `number`，否则编号很大时可能改变数值。

## 迁移与检查

首个迁移在 `migrations/0000_initial.sql`。Drizzle 的迁移记录文件在 `migrations/meta/_journal.json`，
应用启动不能自行生成迁移，只能执行仓库中已经审核过的文件。

在 USTC 服务器仓库根目录运行：

```bash
pnpm install
pnpm --filter @urmotiv/database typecheck
pnpm --filter @urmotiv/database test
pnpm --filter @urmotiv/database build
```

需要修改表结构时，先改 `src/schema.ts`，再在服务器生成迁移并人工检查 SQL：

```bash
pnpm --filter @urmotiv/database migration:generate
```

重点检查删除列、改变类型、唯一约束和外键是否会损坏已有数据。生产升级前先备份 PostgreSQL，再由升级脚本调用
`migrateDatabase`。首个迁移没有自动回退脚本；恢复失败升级应使用升级前备份，而不是猜测性删除表。
