# 服务器部署与升级

本系统的正式部署由网站、API、后台任务进程、PostgreSQL、Redis 和 MinIO 组成。Docker Compose 是把这些相互依赖的服务按同一份配置一起启动和检查的工具。MinIO 是一个兼容 S3 的私有文件服务，用来保存测试数据、附件和导入导出包；浏览器不能直接访问它。

所有命令都在 `ssh ustc` 的专用目录运行。下面的示例使用 `/home/ubuntu/urmotiv-codex/repo`，不要在其他项目目录执行，也不要把私有环境文件放进 Git 仓库。

## 初次部署

1. 在服务器上准备私有环境文件和备份目录。环境文件含有数据库、认证和文件服务的访问凭据，必须只允许当前账号读取。

   ```bash
   install -d -m 700 /home/ubuntu/urmotiv-codex/private /home/ubuntu/urmotiv-codex/backups
   cp /home/ubuntu/urmotiv-codex/repo/deploy/env.production.example /home/ubuntu/urmotiv-codex/private/urmotiv.env
   chmod 600 /home/ubuntu/urmotiv-codex/private/urmotiv.env
   ```

   填写 `urmotiv.env` 时请使用密码管理器生成随机值。`URMOTIV_PLUGIN_SECRET_KEY` 必须是 32 字节随机值的 Base64URL 编码（把随机字节写成只含字母、数字、下划线和短横线的文本），用于加密保存插件令牌，不能复用数据库或 MinIO 密码。网页会话使用服务端生成的随机令牌，数据库只保存摘要，不需要另配一个未使用的 `SESSION_SECRET`。启用 CAS 时，`URMOTIV_CAS_STATE_SECRET` 必须单独生成恰好 32 字节的无填充 Base64URL 值，也不能与前述密钥复用。PostgreSQL 密码会进入连接地址，因此只使用字母、数字、连字符和下划线。`URMOTIV_WEB_ORIGIN` 写用户实际打开的网站地址，例如 `https://problems.example.edu.cn`，不能带路径。

2. 检查私有环境文件。脚本只报告缺少的字段，不会打印字段值。

   ```bash
   cd /home/ubuntu/urmotiv-codex/repo
   bash scripts/deploy/validate-env.sh /home/ubuntu/urmotiv-codex/private/urmotiv.env
   ```

3. 构建镜像并先启动基础服务，再单独运行迁移。全新数据库迁移完成后会进入一次性的
   `open` 状态；此时 API 固定拒绝监听端口。`root` 只是不可登录的内部初始化授权者，永远不绑定
   密码、邮箱或 CAS 身份。

   ```bash
   docker compose --env-file /home/ubuntu/urmotiv-codex/private/urmotiv.env build
   docker compose --env-file /home/ubuntu/urmotiv-codex/private/urmotiv.env up -d postgres redis minio minio-init
   docker compose --env-file /home/ubuntu/urmotiv-codex/private/urmotiv.env run --rm migrate
   ```

4. 在服务器的真实终端中创建独立的首位系统管理员。不要添加 `-T`，不要通过管道或重定向提供输入；
   命令不接受邮箱或密码参数、环境变量、JSON 和密码文件。邮箱与密码各输入两次，输入均不回显。

   ```bash
   docker compose --env-file /home/ubuntu/urmotiv-codex/private/urmotiv.env run --rm --no-deps api \
     pnpm --filter @urmotiv/api bootstrap-admin
   ```

   只有固定结果 `BOOTSTRAP_ADMIN_OK` 表示已明确完成。若返回 `OUTCOME_UNKNOWN`，连接或提交结果无法确认，
   命令不会自动重试；恢复连接后重新运行会先只读检查状态，已经完成时不会再次读取凭据或创建账号。

5. 初始化明确完成后启动应用并检查状态。

   ```bash
   docker compose --env-file /home/ubuntu/urmotiv-codex/private/urmotiv.env up -d api worker web
   docker compose --env-file /home/ubuntu/urmotiv-codex/private/urmotiv.env ps
   docker compose --env-file /home/ubuntu/urmotiv-codex/private/urmotiv.env exec -T web \
     wget -qO- http://127.0.0.1/api/v1/health
   ```

   生产 API 不允许设置 `URMOTIV_DATABASE_MIGRATE=true`；迁移必须使用上面的独立命令，避免空数据库被
   普通 API 启动永久标成不可初始化。

   网站默认只监听 `127.0.0.1:8080`，不会直接暴露 PostgreSQL、Redis、MinIO 或 API。对外访问应由服务器已有的 HTTPS 反向代理转发到这个地址；反向代理负责证书和 HTTP 到 HTTPS 的跳转。调试时可用 SSH 转发访问：`ssh -L 8080:127.0.0.1:8080 ustc`。

   API 默认不信任 `X-Forwarded-For` 等转发头，只把直接建立连接的 socket 地址当作请求来源。这是安全默认值，普通部署和 SSH 调试不需要改。只有后续功能确实要按最终客户端地址限制访问，并且已经逐层确认反向代理拓扑时，才在私有环境文件中设置 `URMOTIV_TRUSTED_PROXY_CIDRS`。它只接受最多 32 个逗号分隔的 IPv4/IPv6 CIDR，不接受主机名、代理跳数、`true`、`0.0.0.0/0` 或 `::/0`。例如文档保留地址可写成 `192.0.2.0/24,2001:db8::/64`；部署时必须替换成实际代理范围，不能照抄示例。

   启用后，专用的来源地址解析器从直接 socket 开始沿 `X-Forwarded-For` 由右向左检查，只跨过明确列入清单的代理，并在第一个不可信地址停止。不能把客户端网段、整个共享容器网络或“可能用到”的私网范围加入清单，否则能直接访问 API 的进程可能伪造来源。每一层可信代理都必须安全追加 `X-Forwarded-For`；标准 `Forwarded` 头不会单独用于来源判断。Fastify 本身始终保持不信任代理模式，因此 `X-Forwarded-Host` 和 `X-Forwarded-Proto` 也不会改变应用看到的主机名或协议。调整后先在测试环境核对实际链路，再用于令牌来源限制。

## 升级与恢复

升级前先把经过审查的代码同步到专用目录并检查当前提交；升级脚本不会自行执行 `git pull`，以免在未知代码上自动修改运行中的服务。

包含 `0009_robot_review_leases` 的升级必须安排维护窗口。先停止 Fermata 的新轮询，但保持旧版 Urmotiv API
可用，让已经发出的付费模型请求继续流式读取到服务端真正结束并提交完成结果；不能主动取消，也不能恢复 120 秒
总时限。待它们全部提交完成或租约自然过期，并确认数据库中没有尚未到期或没有到期时间的机器人租约后，再完整
停止旧版 Urmotiv API，等待它属于本项目的数据库事务全部结束，然后运行迁移。

迁移发现活租约会固定失败，不会猜测其是否已经完成；发现涉及的表仍被旧请求或其他事务占用也会立即安全失败，
不会一边持锁一边等待而与旧版领取形成死锁。取得全部独占锁后，迁移会阻止旧版写入直到提交；已经自然过期的
旧租约归档为 `expired`，迁移前已经撤销的旧记录归档为 `legacy_closed`，人工审核意见保持不变。锁忙时应确认占用
事务属于本项目并等待它自然结束，再重试原迁移；不要批量结束数据库进程，也不要手工跳过门禁或删除领取记录。

```bash
cd /home/ubuntu/urmotiv-codex/repo
bash scripts/deploy/upgrade.sh \
  /home/ubuntu/urmotiv-codex/private/urmotiv.env \
  /home/ubuntu/urmotiv-codex/backups
```

脚本先验证私有配置并构建镜像；构建成功后明确停止旧 `api`、`worker`、`web` 容器并排空其数据库事务，再创建
与停机切换点一致的 PostgreSQL 备份，然后单独运行迁移、启动服务并检查健康状态。若迁移失败，应用容器保持停止而数据库等基础服务保留，
不能绕过失败强行启动；若健康检查失败，新容器保持原状以便检查。不要通过删除数据库表来“回滚”迁移；应先停止
服务、恢复升级前的备份，再切换回已经验证过的代码版本。

示例恢复命令需要在确认目标备份与停机窗口后手工执行：

```bash
docker compose --env-file /home/ubuntu/urmotiv-codex/private/urmotiv.env stop api worker web
docker compose --env-file /home/ubuntu/urmotiv-codex/private/urmotiv.env exec -T postgres \
  sh -ec 'dropdb --if-exists --username="$POSTGRES_USER" "$POSTGRES_DB" && createdb --username="$POSTGRES_USER" "$POSTGRES_DB"'
docker compose --env-file /home/ubuntu/urmotiv-codex/private/urmotiv.env exec -T postgres \
  sh -ec 'pg_restore --username="$POSTGRES_USER" --dbname="$POSTGRES_DB" --clean --if-exists' \
  < /home/ubuntu/urmotiv-codex/backups/已确认的备份文件.dump
```

恢复完成后先切回与备份兼容的代码版本，再运行 `docker compose ... up -d`。恢复命令会替换数据库内容，必须由具备恢复权限的管理员在确认备份文件后执行。

## 日常检查与备份

```bash
docker compose --env-file /home/ubuntu/urmotiv-codex/private/urmotiv.env ps
docker compose --env-file /home/ubuntu/urmotiv-codex/private/urmotiv.env logs --tail=100 api
bash scripts/deploy/backup.sh \
  /home/ubuntu/urmotiv-codex/private/urmotiv.env \
  /home/ubuntu/urmotiv-codex/backups
```

备份目录也会保存敏感业务数据，应使用受控的异地备份方式保存，且不要传入 Git、聊天记录或公开文件服务。MinIO 中的文件需按对象存储的官方方式另外备份；恢复数据库时应使用同一时点的对象存储备份，避免文件记录和实际文件不一致。

## 健康检查语义

系统区分存活（进程能响应 HTTP）与就绪（依赖可用、可以接收流量）两种状态，两个层级的判定互不影响。

### API

- `GET /api/v1/health`：存活检查。进程可响应 HTTP 即返回 `200 {"status":"ok"}`，不探测依赖。
- `GET /api/v1/health/ready`：就绪检查。持久化后端（数据库）可达时返回 `200 {"status":"ready"}`，否则返回
  `503 {"status":"unavailable"}`。检查只执行一次最廉价的查询，响应只包含固定字段，不暴露依赖地址或内部细节。

### worker（后台任务进程）

worker 自带健康服务，默认只监听 `127.0.0.1:3010`：

- `GET /live`：存活检查。进程存在即返回 `200 {"status":"ok"}`。
- `GET /ready`：就绪检查。最近一次队列进展（空闲轮询或任务租约续期）未超过 `URMOTIV_WORKER_HEALTH_STALE_MS`
  （默认 60 秒）时返回 200，否则返回 503。这样可以把“进程还活着但已经卡住”的 worker 标记为不健康。

Compose 里 worker 的健康检查每 10 秒访问一次 `/ready`，3 次失败即把容器标记为不健康（`docker compose ps` 可见）。
worker 连续多次不通过就绪检查时会主动以非零码退出，交由 `restart: unless-stopped` 重新拉起；
`URMOTIV_WORKER_HEALTH_EXIT_AFTER_UNREADY` 设为 0 可关闭主动退出，只保留健康检查的标记能力。

## 配置边界

- 正式环境必须使用 PostgreSQL、Redis 和私有 S3 桶；应用不接受正式环境退回到本地文件数据库或单进程任务队列。
- 正式环境必须配置 `URMOTIV_PLUGIN_SECRET_KEY`。如果数据库已经保存插件令牌而这个值缺失，API 会在监听端口前停止启动，避免插件改用无认证请求。
- `URMOTIV_TRUSTED_PROXY_CIDRS` 默认留空。只有明确掌握每一层代理地址并确认其正确处理转发头时才可配置；应用不会自动信任回环地址、私网、容器网络或固定跳数。
- `URMOTIV_EMAIL_REGISTRATION_ENABLED` 默认为 `false`。在完成真实邮件验证和投递配置前，不要开启它。
- CAS 的地址、稳定身份字段和状态密钥需要在真实 USTC 联调后写入私有环境文件；确认前不能把学号当作永久唯一身份。CAS 配置和状态密钥只注入 API 容器，不进入迁移、后台任务、网站或其他容器。

## 邮箱注册与验证

邮箱注册默认关闭。打开后，系统会为新账号保存未验证的邮箱和经过 Argon2id 处理的密码；用户必须点击验证邮件中的一次性链接后，才能用邮箱和密码登录。数据库只保存链接令牌的 SHA-256 摘要，链接有效期为 30 分钟，使用或过期后不能再次使用。

仓库没有内置的真实邮件发送服务，也不会把验证链接写进日志。自动化测试可在 `NODE_ENV=test` 下使用 `URMOTIV_EMAIL_DELIVERY_MODE=test` 和 `URMOTIV_EMAIL_VERIFICATION_WEB_URL` 注入内存投递箱。生产环境若尝试只靠环境变量开启 `URMOTIV_EMAIL_REGISTRATION_ENABLED=true`，API 会拒绝启动；接入真实邮件服务前，必须先实现并审查服务端投递器，再开启注册。
- Docker 卷 `postgres-data`、`redis-data`、`minio-data` 是运行数据，不能随意执行 `docker compose down -v`。这会删除数据卷。
- 日志、任务报告和故障信息不得包含题面全文、题解、测试数据、密码、令牌或密钥。

## 启用 Anklang（原题检索服务）

Anklang 是独立的原题检索服务，默认不随主应用启动，也不连接 Urmotiv 的 PostgreSQL、Redis 或
MinIO。启用步骤：

1. 把 Anklang 仓库与本仓库同级检出（`compose.yaml` 的 `build: ../Anklang` 依赖这个相对位置），
   或改用已经核对过的发布镜像。
2. 在 Anklang 仓库内准备被 Git 忽略的私有环境文件；真实服务令牌、上游地址和可选模型密钥都只放
   在这里，不要写进 `urmotiv.env`：

   ```bash
   install -d -m 700 /home/ubuntu/urmotiv-codex/Anklang/private
   cp /home/ubuntu/urmotiv-codex/Anklang/.env.example \
     /home/ubuntu/urmotiv-codex/Anklang/private/anklang.env
   chmod 600 /home/ubuntu/urmotiv-codex/Anklang/private/anklang.env
   ```

   至少填写一个长度不小于 16 的 `ANKLANG_SERVICE_TOKEN`。不要用 shell 的 `source` 或 `.` 加载
   这个文件；Compose 会通过 `env_file` 直接注入。容器内的监听地址、正式端口、强制令牌和停止宽限
   由 Compose 固定为安全值，私有文件不能把它们改成对外开放或无鉴权模式。
3. 启动可选 profile：

   ```bash
   cd /home/ubuntu/urmotiv-codex/repo
   docker compose --env-file /home/ubuntu/urmotiv-codex/private/urmotiv.env \
     --profile anklang up -d anklang
   ```

   容器以非 root 用户运行，使用只读根文件系统并移除全部额外 Linux 权限。宿主只监听
   `127.0.0.1:8730`；健康检查访问容器内的 `/api/v1/live`，不会触发外部检索。
4. 在管理后台启用“原题相似度检查”插件，把 `baseUrl` 设为 `http://anklang:8730`，并填写与
   `ANKLANG_SERVICE_TOKEN` 相同的服务令牌。插件使用 v2 接口；`partial` 或 `unavailable` 不能当成
   “没有原题”。

不带 `--profile anklang` 的普通 `docker compose up` 不会创建 Anklang 容器。不要同时运行独立
Anklang Compose 和这个 profile 占用同一个宿主端口或数据卷。

## 启用 Fermata（AI 审题服务）

Fermata 是独立的 AI 审题进程，默认不随主应用启动。启用步骤：

1. 把 Fermata 仓库与本仓库同级检出（`compose.yaml` 的 `build: ../Fermata` 依赖这个相对位置），
   或改用已发布镜像。
2. 在 Fermata 仓库内被 Git 整体忽略的私有目录准备环境文件（例如
   `/home/ubuntu/urmotiv-codex/Fermata/private/fermata.env`），
   字段见 Fermata 仓库的 `.env.example`。加载环境变量时不要用 shell 的 `source`——值里出现
   `#`、`)` 等字符会导致报错并把密钥回显到终端；Fermata 自带 `scripts/run-with-env.mjs`
   专门解决这个问题（Docker 部署下由 compose 的 `env_file` 注入，天然没有这个风险）。
3. 在 Urmotiv 管理后台创建机器人账号并签发 API 令牌，填入 `URMOTIV_ROBOT_TOKEN`。
4. 用 profile 启动：`docker compose --env-file /home/ubuntu/urmotiv-codex/private/urmotiv.env
   --profile fermata up -d fermata`，或在主环境文件里设置 `COMPOSE_PROFILES=fermata` 后照常
   `docker compose up -d`。
5. 在管理后台启用 `Fermata 审核服务管理` 插件，把 `baseUrl` 指向
   `http://fermata:8720`（compose 内部网络）并配置管理令牌，即可在插件页看到健康状态、
   修改轮询间隔等公开设置。

Fermata 的难度评定与等级标定实验（结果与当前校准状态）见其仓库 `experiments/results/` 与 README。

## 首次接入 USTC 统一身份认证（CAS）

系统按标准 CAS 协议接入 `id.ustc.edu.cn`，但**具体返回哪些属性字段（学号、GID、邮箱等的字段名）
必须以真实联调为准**，不能凭猜测写死。程序只接收明确配置的字段名，登录失败时返回固定的未登录响应，
不会在响应或日志里列出认证服务返回的字段和值：

1. 在私有环境文件里打开 CAS 并填入地址与占位字段名（见 `deploy/env.production.example` 的 CAS 段）：
   `URMOTIV_CAS_ENABLED=true`、登录/校验/回调地址、`URMOTIV_CAS_SUBJECT_ATTRIBUTE`（先用占位如
   `cas:user`）、`URMOTIV_CAS_STATE_SECRET`（恰好 32 字节随机值的无填充 Base64URL）。当前认证契约
   只有 `login`、`serviceValidate` 和本站 `callback` 三个地址，没有未使用的 base/logout 配置；正式环境
   三个地址必须全部使用 HTTPS，也不能带账号密码。回调必须精确等于 `URMOTIV_WEB_ORIGIN` 加
   `/api/v1/auth/cas/callback`，不能指向其他站点、其他路径，也不能预带查询参数或片段。
2. 部署前运行 `validate-env.sh`。CAS 开关只接受 `true` 或 `false`；为 `false` 时其余 CAS 字段可以留空，
   为 `true` 时缺项、HTTP 地址、畸形字段或长度/编码不规范的状态密钥都会在部署检查或 API 启动阶段以固定错误失败，不会输出配置值。
3. 在受控测试实例中**用一个真实统一身份账号点一次登录**，并依据 USTC 认证服务的受控文档或由身份服务
   管理员确认实际属性名称。不要通过打开调试日志、回显原始 XML 或把原始响应发到聊天来探测字段。
4. 挑出真正稳定唯一的字段（GID 或学号），回填 `URMOTIV_CAS_SUBJECT_ATTRIBUTE`；
   把含学号的字段名逗号分隔填进 `URMOTIV_CAS_STUDENT_ID_ATTRIBUTES`（登录时写入用户标识表，供历史
   题目按学号匹配）；邮箱、昵称字段同理填入对应变量。改完重启 api 即可。
5. 一个人可能有多个学号（本科+研究生），系统按“认证来源 + 稳定身份编号”识别账号、学号只作辅助匹配；
   稳定字段确认前不要把学号当作永久唯一主键。

这一步需要一个真实统一身份账号，只能由本人在浏览器里完成，无法在服务器端自动化。

## 历史题目迁移

协会已有题目在 `hist_problem/` 与 `USTC题目列表.xlsx`（均为私有资料，不进 Git）。迁移是一次性工作，
用 `scripts/migrate-hist/` 的工具把格式各异的历史题目规范化成原生题目包，再走导入导出页导入。完整
步骤见 `scripts/migrate-hist/README.md`，要点：

1. 用 `scp` 把 `hist_problem/` 与 `.xlsx` 传到服务器的**非 Git 私有目录**（如
   `/home/ubuntu/urmotiv-codex/private/hist`），传输后确认目标仍在 `.gitignore` 覆盖范围外的私有区。
2. `parse-metadata.py` 解析表格为 `metadata.json`，自动剔除 QQ 号、审核意见和投题者自填难度；难度不进入
   模型提示或候选题，必须另行独立评定。
3. 人工核对每个已经分组的文本文件与表格题号，写入第一份确认文件。确认文件同时记录整份私有元数据文件
   和每个源文本的 SHA-256 内容摘要；作者归属、元数据或源文本变化后旧确认自动失效。系统不再根据文件名
   开头的数字猜题号，也不允许同一文件或元数据被重复分配。
4. `prepare` 阶段用模型整理候选，只产出预览和不含题名、学号、原文件名或正文的审核清单，不生成题目包。
   人逐题阅读后，在第二份确认文件中批准“候选安全编号 + 内容摘要”；候选变化后旧批准自动失效。
5. `package` 阶段再次读取源文本并核对摘要，只为批准项生成原生题目包。作者学号绝不进入题目包清单或
   扩展字段，只写到 `--author-map-out` 指定的单独私有文件。映射同时带候选、题目包和整批摘要，供管理员
   导入后核对批次并处理归属。
6. 如果批量为出题人建账号麻烦、或担心他们首次 CAS 登录出问题，可以**先建一个共享的“历史导入”账号**
   （用有 `problem.import` 权限的账号）统一导入；日后再依据单独私有作者映射逐题转移。详细命令与两份
   确认文件格式见 `scripts/migrate-hist/README.md`。当前实现覆盖 Markdown、纯文本和经过完整安全检查的
   两层历史 ZIP 路径链；PDF、图片、表格、旧编码 ZIP 和无法明确划分的混合资料仍须人工处理。

## 把测试实例部署到 ustc 并迁移数据库

真实使用测试可以直接部署在 `ssh ustc`。数据库迁移就是标准的 PostgreSQL 备份/恢复：

```bash
# 在旧实例导出（backup.sh 也会做同样的事，产物在备份目录）
bash scripts/deploy/backup.sh /home/ubuntu/urmotiv-codex/private/urmotiv.env /home/ubuntu/urmotiv-codex/backups

# 在新实例恢复（见上面“升级与恢复”里的 pg_restore 示例），再切到对应代码版本 up -d
```

对象存储（MinIO）里的题目文件要按同一时点单独备份并一起迁移，避免数据库里的文件记录和实际文件对不上。
迁移完成后按上面的 CAS 联调步骤确认统一身份登录，再放开对外访问。
