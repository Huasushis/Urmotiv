# 入门指南

这份指南假定你负责一台部署 Urmotiv 的服务器，并希望在五分钟内看到登录页。命令只使用公开代码、占位路径和合成数据；邮箱、密码、令牌和真实题目不要写进 Git 或聊天记录。

> **先读**：在当前起始提交，干净 Docker API/Worker 构建可能因遗漏 `plugins/fps-format/package.json` 而在依赖安装阶段失败。维护者同步两个 Dockerfile 的插件清单后，下面的五分钟流程才可按原样执行；本次文档分支不修改构建配置。

## 1. 准备代码和私有环境文件

需要 Docker Engine、Docker Compose v2、OpenSSL，以及可以连接服务器的真实终端。Node.js/pnpm 只在从源码执行工作区命令时需要；生产容器已经包含运行所需文件。

```bash
git clone https://github.com/Huasushis/Urmotiv.git
cd Urmotiv
cp deploy/env.production.example /secure/path/urmotiv.env
chmod 600 /secure/path/urmotiv.env
```

`/secure/path/urmotiv.env` 是示例占位路径，请换成 Git 目录之外、只有部署管理员可读的位置。编辑这个文件，至少填写：

- `POSTGRES_USER`、`POSTGRES_PASSWORD`、`POSTGRES_DB`：PostgreSQL 账号、密码和数据库名；密码只使用模板允许的字母、数字、连字符或下划线。
- `MINIO_ROOT_USER`、`MINIO_ROOT_PASSWORD`、`S3_BUCKET`：对象存储的初始账号、密码和桶名。
- `URMOTIV_PLUGIN_SECRET_KEY`：恰好 32 字节随机值的 Base64URL 编码。不要与 OAuth/CAS 状态密钥复用。
- `URMOTIV_WEB_ORIGIN`：浏览器实际访问的完整来源（协议、主机、可选端口，不带路径）。

生成插件密钥时只在自己的终端查看，不要复制到文档：

```bash
openssl rand -base64 32 | tr '+/' '-_' | tr -d '='
```

开发机通过 SSH 只访问回环 HTTP 时，再把下面两项写入私有环境文件：

```dotenv
URMOTIV_WEB_ORIGIN=http://127.0.0.1:8080
URMOTIV_ALLOW_LOOPBACK_INSECURE_COOKIES=true
```

这是显式的回环不安全 Cookie（浏览器会在 HTTP 下发送登录 Cookie）例外，仅适用于 SSH 隧道或本机回环。公网必须使用 HTTPS，并保持该变量为 `false`。

## 2. 验证 Compose 并启动

先验证私有环境文件权限和必填变量。验证脚本只打印固定的成功或错误摘要，不要把环境文件内容贴入终端记录：

```bash
bash scripts/deploy/validate-env.sh /secure/path/urmotiv.env
docker compose --env-file /secure/path/urmotiv.env config
docker compose --env-file /secure/path/urmotiv.env up -d --build
```

默认端口如下：

| 入口 | 默认绑定 | 用途 |
| --- | --- | --- |
| Web | `127.0.0.1:8080` | 浏览器入口，反向代理到 API |
| API | Compose 网络内 `3000` | `/api/v1` HTTP 接口 |
| Worker 健康检查 | Compose 网络内 `3010` | 异步导入导出任务进程 |
| Anklang（可选 profile） | `127.0.0.1:8730` | 原题相似性检索服务 |
| Fermata（可选 profile） | `127.0.0.1:8720` | 独立审核服务的管理/任务入口 |

Compose 的 API 在首次初始化完成前不会正常提供业务登录；这是保护空数据库的预期行为，不是登录页故障。

## 3. 首次初始化管理员

在仍连接到服务器的真实 TTY（能直接读取键盘、不会把密码送入管道的终端）中执行：

```bash
docker compose --env-file /secure/path/urmotiv.env run --rm --no-deps api pnpm --filter @urmotiv/api bootstrap-admin
```

命令依次隐藏输入并要求确认：首位管理员邮箱两次、密码两次。密码至少 12 个字符。成功时终端只出现固定结果 `BOOTSTRAP_ADMIN_OK`；失败结果（例如 `BOOTSTRAP_ADMIN_TTY_REQUIRED`、`BOOTSTRAP_ADMIN_INPUT_MISMATCH` 或 `BOOTSTRAP_ADMIN_UNAVAILABLE`）只表示初始化没有完成，不要猜测账号状态，先查看服务日志摘要并重新运行。

初始化成功后重启依赖数据库状态的服务：

```bash
docker compose --env-file /secure/path/urmotiv.env up -d api web worker
```

首次管理员得到的是“系统管理员”角色：可以管理账号、权限、插件、知识点和运行设置，但不会因为这个角色自动获得最终审题权。按需再分配“审题人”“命题组成员”或“组长”。

## 4. 登录并创建第一道合成题

1. 通过 SSH 转发或本机浏览器打开 `http://127.0.0.1:8080/login`。
2. 选择“邮箱登录”，输入刚初始化的邮箱和密码。邮箱注册默认关闭；这不影响已有凭据登录。
3. 登录后进入 `/problems`，点击“新建题目”。填写题目名称、至少一个知识点和题目类型；先保存草稿。
4. 在题目工作区补充题面、题解、样例和评测设置，使用“程序与附件”上传公开附件或内部资料。
5. 点击“提交审核”。提交时客户端会携带当前修订号；如果出现版本冲突，刷新后重新确认改动。待审修订会冻结基础题面与基础题解。

普通用户完整操作顺序和权限说明见[用户指南](user-guide.md)，首位管理员和恢复流程见[管理员指南](admin-guide.md)。

## 5. 首次失败的安全处理

- **没有登录页**：执行 `docker compose --env-file /secure/path/urmotiv.env ps` 和 `docker compose --env-file /secure/path/urmotiv.env logs --tail=100 api`，确认数据库、迁移和 bootstrap 状态；不要把日志中的环境值复制出来。
- **看到 `BOOTSTRAP_ADMIN_TTY_REQUIRED`**：当前输入不是实际 TTY。退出管道、后台无终端或自动化脚本，在服务器控制台重新执行命令。
- **看到 `BOOTSTRAP_ADMIN_UNAVAILABLE`**：数据库不是未改动的全新迁移基线，或初始化已经完成。不要删除数据库；按[管理员指南](admin-guide.md)核对状态。
- **遗失管理员密码**：不能从 Web 页面绕过认证。使用真实 TTY 运行恢复命令；它要求输入两次“确认”，会撤销该管理员的现有会话，并把一次性新密码写到 `/dev/tty`。
