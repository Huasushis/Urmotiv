# 服务器部署与升级

本系统的正式部署由网站、API、后台任务进程、PostgreSQL、Redis 和 MinIO 组成。Docker Compose 是把这些相互依赖的服务按同一份配置一起启动和检查的工具。MinIO 是一个兼容 S3 的私有文件服务，用来保存测试数据、附件和导入导出包；浏览器不能直接访问它。

所有命令都在 `ssh ustc` 的专用目录运行。下面的示例使用 `/home/ubuntu/urmotiv-codex/repo`，不要在其他项目目录执行，也不要把私有环境文件放进 Git 仓库。

## 初次部署

1. 在服务器上准备私有环境文件和备份目录。环境文件含有数据库、会话和文件服务的访问凭据，必须只允许当前账号读取。

   ```bash
   install -d -m 700 /home/ubuntu/urmotiv-codex/private /home/ubuntu/urmotiv-codex/backups
   cp /home/ubuntu/urmotiv-codex/repo/deploy/env.production.example /home/ubuntu/urmotiv-codex/private/urmotiv.env
   chmod 600 /home/ubuntu/urmotiv-codex/private/urmotiv.env
   ```

   填写 `urmotiv.env` 时请使用密码管理器生成随机值。`SESSION_SECRET` 必须是足够长的随机字符串；`URMOTIV_PLUGIN_SECRET_KEY` 必须是 32 字节随机值的 Base64URL 编码（把随机字节写成只含字母、数字、下划线和短横线的文本），用于加密保存插件令牌。两者都不能复用数据库或 MinIO 密码。PostgreSQL 密码会进入连接地址，因此只使用字母、数字、连字符和下划线。`URMOTIV_WEB_ORIGIN` 写用户实际打开的网站地址，例如 `https://problems.example.edu.cn`，不能带路径。

2. 检查私有环境文件。脚本只报告缺少的字段，不会打印字段值。

   ```bash
   cd /home/ubuntu/urmotiv-codex/repo
   scripts/deploy/validate-env.sh /home/ubuntu/urmotiv-codex/private/urmotiv.env
   ```

3. 构建并启动。`migrate` 容器会先执行仓库中已经审核过的数据库迁移并创建初始 `root` 账号及角色；它不接受明文 root 密码。请在受控的后续流程中为 root 绑定邮箱并设置密码，或先完成 CAS 配置。

   ```bash
   docker compose --env-file /home/ubuntu/urmotiv-codex/private/urmotiv.env up -d --build
   docker compose --env-file /home/ubuntu/urmotiv-codex/private/urmotiv.env ps
   docker compose --env-file /home/ubuntu/urmotiv-codex/private/urmotiv.env exec -T web \
     wget -qO- http://127.0.0.1/api/v1/health
   ```

   网站默认只监听 `127.0.0.1:8080`，不会直接暴露 PostgreSQL、Redis、MinIO 或 API。对外访问应由服务器已有的 HTTPS 反向代理转发到这个地址；反向代理负责证书和 HTTP 到 HTTPS 的跳转。调试时可用 SSH 转发访问：`ssh -L 8080:127.0.0.1:8080 ustc`。

## 升级与恢复

升级前先把经过审查的代码同步到专用目录并检查当前提交；升级脚本不会自行执行 `git pull`，以免在未知代码上自动修改运行中的服务。

```bash
cd /home/ubuntu/urmotiv-codex/repo
scripts/deploy/upgrade.sh \
  /home/ubuntu/urmotiv-codex/private/urmotiv.env \
  /home/ubuntu/urmotiv-codex/backups
```

脚本按顺序验证私有配置、创建 PostgreSQL 备份、构建镜像、单独运行迁移、启动服务并检查健康状态。若迁移或健康检查失败，脚本会停止并保留容器，便于检查。不要通过删除数据库表来“回滚”迁移；应先停止服务、恢复升级前的备份，再切换回已经验证过的代码版本。

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
scripts/deploy/backup.sh \
  /home/ubuntu/urmotiv-codex/private/urmotiv.env \
  /home/ubuntu/urmotiv-codex/backups
```

备份目录也会保存敏感业务数据，应使用受控的异地备份方式保存，且不要传入 Git、聊天记录或公开文件服务。MinIO 中的文件需按对象存储的官方方式另外备份；恢复数据库时应使用同一时点的对象存储备份，避免文件记录和实际文件不一致。

## 配置边界

- 正式环境必须使用 PostgreSQL、Redis 和私有 S3 桶；应用不接受正式环境退回到本地文件数据库或单进程任务队列。
- 正式环境必须配置 `URMOTIV_PLUGIN_SECRET_KEY`。如果数据库已经保存插件令牌而这个值缺失，API 会在监听端口前停止启动，避免插件改用无认证请求。
- `URMOTIV_EMAIL_REGISTRATION_ENABLED` 默认为 `false`。在完成真实邮件验证和投递配置前，不要开启它。
- CAS 的地址、稳定身份字段和状态密钥需要在真实 USTC 联调后写入私有环境文件；确认前不能把学号当作永久唯一身份。

## 邮箱注册与验证

邮箱注册默认关闭。打开后，系统会为新账号保存未验证的邮箱和经过 Argon2id 处理的密码；用户必须点击验证邮件中的一次性链接后，才能用邮箱和密码登录。数据库只保存链接令牌的 SHA-256 摘要，链接有效期为 30 分钟，使用或过期后不能再次使用。

仓库没有内置的真实邮件发送服务，也不会把验证链接写进日志。自动化测试可在 `NODE_ENV=test` 下使用 `URMOTIV_EMAIL_DELIVERY_MODE=test` 和 `URMOTIV_EMAIL_VERIFICATION_WEB_URL` 注入内存投递箱。生产环境若尝试只靠环境变量开启 `URMOTIV_EMAIL_REGISTRATION_ENABLED=true`，API 会拒绝启动；接入真实邮件服务前，必须先实现并审查服务端投递器，再开启注册。
- Docker 卷 `postgres-data`、`redis-data`、`minio-data` 是运行数据，不能随意执行 `docker compose down -v`。这会删除数据卷。
- 日志、任务报告和故障信息不得包含题面全文、题解、测试数据、密码、令牌或密钥。

## 启用 Fermata（AI 审题服务）

Fermata 是独立的 AI 审题进程，默认不随主应用启动。启用步骤：

1. 把 Fermata 仓库与本仓库同级检出（`compose.yaml` 的 `build: ../Fermata` 依赖这个相对位置），
   或改用已发布镜像。
2. 在私有目录准备它自己的环境文件（例如 `/home/ubuntu/urmotiv-codex/private/fermata.env`），
   字段见 Fermata 仓库的 `.env.example`。加载环境变量时不要用 shell 的 `source`——值里出现
   `#`、`)` 等字符会导致报错并把密钥回显到终端；Fermata 自带 `scripts/run-with-env.mjs`
   专门解决这个问题（Docker 部署下由 compose 的 `env_file` 注入，天然没有这个风险）。
3. 在 Urmotiv 管理后台创建机器人账号并签发 API 令牌，填入 `URMOTIV_ROBOT_TOKEN`。
4. 用 profile 启动：`docker compose --profile fermata up -d`，或在环境里设置
   `COMPOSE_PROFILES=fermata` 后照常 `docker compose up -d`。
5. 在管理后台启用 `Fermata 审核服务管理` 插件，把 `baseUrl` 指向
   `http://fermata:8720`（compose 内部网络）并配置管理令牌，即可在插件页看到健康状态、
   修改轮询间隔等公开设置。

Fermata 的难度评定与等级标定实验（结果与当前校准状态）见其仓库 `experiments/results/` 与 README。

## 首次接入 USTC 统一身份认证（CAS）

系统按标准 CAS 协议接入 `id.ustc.edu.cn`，但**具体返回哪些属性字段（学号、GID、邮箱等的字段名）
必须以真实联调为准**，不能凭猜测写死。因此实现采用“配置字段名 + 失败时自曝可用字段”的方式：

1. 在私有环境文件里打开 CAS 并填入地址与占位字段名（见 `deploy/env.production.example` 的 CAS 段）：
   `URMOTIV_CAS_ENABLED=true`、登录/校验/回调地址、`URMOTIV_CAS_SUBJECT_ATTRIBUTE`（先用占位如
   `cas:user`）、`URMOTIV_CAS_STATE_SECRET`（32 字节以上随机值的 Base64URL）。
2. 部署后**用一个真实统一身份账号点一次登录**。如果占位字段取不到稳定身份，登录会失败并返回错误码
   `subject_attribute_missing`，**错误信息里会列出这次 CAS 实际返回的全部字段名**。
3. 从这个列表里挑出真正稳定唯一的字段（GID 或学号），回填 `URMOTIV_CAS_SUBJECT_ATTRIBUTE`；
   把含学号的字段名逗号分隔填进 `URMOTIV_CAS_STUDENT_ID_ATTRIBUTES`（登录时写入用户标识表，供历史
   题目按学号匹配）；邮箱、昵称字段同理填入对应变量。改完重启 api 即可。
4. 一个人可能有多个学号（本科+研究生），系统按“认证来源 + 稳定身份编号”识别账号、学号只作辅助匹配；
   稳定字段确认前不要把学号当作永久唯一主键。

这一步需要一个真实统一身份账号，只能由本人在浏览器里完成，无法在服务器端自动化。

## 历史题目迁移

协会已有题目在 `hist_problem/` 与 `USTC题目列表.xlsx`（均为私有资料，不进 Git）。迁移是一次性工作，
用 `scripts/migrate-hist/` 的工具把格式各异的历史题目规范化成原生题目包，再走导入导出页导入。完整
步骤见 `scripts/migrate-hist/README.md`，要点：

1. 用 `scp` 把 `hist_problem/` 与 `.xlsx` 传到服务器的**非 Git 私有目录**（如
   `/home/ubuntu/urmotiv-codex/private/hist`），传输后确认目标仍在 `.gitignore` 覆盖范围外的私有区。
2. `parse-metadata.py` 解析表格为 `metadata.json`（自动剔除 QQ 号等隐私、丢弃审核人列，难度取区间中点
   到整百）。
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
   确认文件格式见 `scripts/migrate-hist/README.md`。当前实现仅覆盖人工分组后的 Markdown 和纯文本；
   ZIP、PDF、图片、表格和混合资料仍须人工检查或等待后续安全提取功能。

## 把测试实例部署到 ustc 并迁移数据库

真实使用测试可以直接部署在 `ssh ustc`。数据库迁移就是标准的 PostgreSQL 备份/恢复：

```bash
# 在旧实例导出（backup.sh 也会做同样的事，产物在备份目录）
scripts/deploy/backup.sh /home/ubuntu/urmotiv-codex/private/urmotiv.env /home/ubuntu/urmotiv-codex/backups

# 在新实例恢复（见上面“升级与恢复”里的 pg_restore 示例），再切到对应代码版本 up -d
```

对象存储（MinIO）里的题目文件要按同一时点单独备份并一起迁移，避免数据库里的文件记录和实际文件对不上。
迁移完成后按上面的 CAS 联调步骤确认统一身份登录，再放开对外访问。
