# Urmotiv

Urmotiv 是面向竞赛组织者的题库与命题协作系统：把题目草稿、题面资料、审题意见、组题方案和受控的导入导出放在同一套权限模型下。它不是在线评测机，也不会编译或执行参赛者代码。

## 适合什么场景

- 投稿人写题、补充 Markdown 题面和附件，再提交到审题流程。
- 审题人按当前题目版本留下通过、要求修改或不通过意见。
- 命题组成员维护评测程序和内部资料，组长固定版本后组装比赛。
- 管理员为组织配置账号、角色、知识点、插件和备份策略。
- 需要迁移时，对 Hydro 或 FPS XML 题目包先预览、再导入；也可以导出可见题目的固定版本。

## 主要能力

- **版本化题目工作区**：题面、题解、样例、难度、知识点、评测限制和文件随修订版本保存。
- **明确的审题状态**：草稿 → 待审 → 通过或不通过；待审版本的基础题面和基础题解会冻结，紧急修改必须填写原因。
- **分层文件访问**：公开附件、内部附件、测试数据、标准程序和评测程序使用不同类别与权限。
- **可审计的权限**：允许和明确拒绝都记录；单题拒绝优先于允许，机器人账号还有不可绕过的硬性禁用项。
- **组题与风险信息**：比赛草案固定题目修订；有权限的命题组成员可以查看访问记录和泄题风险提示。
- **受信任插件**：提交前检查、审核条目、审核规则和题目包格式在服务端注册；插件不能授予核心权限。
- **独立服务边界**：Anklang 只做原题相似性检索，支持实时添加后查询并返回查询结果。题目的查重/检查信息属于 Urmotiv 的题目属性，插件可以写入，Fermata 可以读取；Anklang 不是流程、审核状态或权限的权威。

## 当前界面入口

本地 Compose 默认把 Web 发布到 `http://127.0.0.1:8080`。打开 `/login` 登录；登录后使用左侧导航：

- `/problems`：题目列表；`/problems/new`：新建草稿。
- `/contests`：组题方案和比赛草案。
- `/transfer`：题目包导入与导出。
- `/profile`：自己的昵称、邮箱和头像。
- `/admin`：仅有管理权限的账号可见，用于插件、知识点和审核策略。

首次部署还没有可登录的管理员。必须在服务器控制台用一次性 TTY（直接连接到终端的输入输出）初始化；服务在此之前会保持阻塞，详见[五分钟上手](docs/getting-started.md)和[管理员指南](docs/admin-guide.md)。

## 五分钟上手

1. 准备 Docker Engine 与 Docker Compose v2；从上游仓库获取代码：

   ```bash
   git clone https://github.com/Huasushis/Urmotiv.git
   cd Urmotiv
   ```

2. 将 `deploy/env.production.example` 复制到 Git 目录之外的私有环境文件（权限 `600`），填写数据库、对象存储、站点来源和插件密钥。生成 32 字节 Base64URL 插件密钥可用：

   ```bash
   openssl rand -base64 32 | tr '+/' '-_' | tr -d '='
   ```

3. 本地 HTTP 仅用于回环访问时，明确设置 `URMOTIV_WEB_ORIGIN=http://127.0.0.1:8080` 与 `URMOTIV_ALLOW_LOOPBACK_INSECURE_COOKIES=true`；不要把这两个设置用于公网。验证并启动：

   ```bash
   bash scripts/deploy/validate-env.sh /secure/path/urmotiv.env
   docker compose --env-file /secure/path/urmotiv.env config
   docker compose --env-file /secure/path/urmotiv.env up -d --build
   ```

4. 在仍连接到服务器的真实终端运行一次管理员初始化（邮箱和密码输入时不回显）：

   ```bash
   docker compose --env-file /secure/path/urmotiv.env run --rm --no-deps api pnpm --filter @urmotiv/api bootstrap-admin
   docker compose --env-file /secure/path/urmotiv.env up -d api web worker
   ```

   看到 `BOOTSTRAP_ADMIN_OK` 后，浏览器打开 `http://127.0.0.1:8080/login`，选择“邮箱登录”。邮箱注册默认关闭；OAuth 默认关闭，均不会替代这次首次初始化。

完整的变量表、SSH 转发、HTTPS 和升级步骤见[部署指南](docs/deployment.md)。

## 文档导航

| 目标 | 文档 |
| --- | --- |
| 第一次部署、登录、创建并提交题目 | [入门指南](docs/getting-started.md) |
| 投稿、审题、Markdown、附件、组题和导入导出 | [用户指南](docs/user-guide.md) |
| 首位管理员、角色、机器人、恢复、备份 | [管理员指南](docs/admin-guide.md) |
| Docker、回环 HTTP、HTTPS、健康检查和升级 | [部署指南](docs/deployment.md) |
| USTC OAuth 配置、回调与身份字段 | [USTC OAuth 指南](docs/ustc-oauth.md) |
| `/api/v1` 路由与稳定请求/响应约定 | [版本化 API 与契约](docs/api-contracts.md) |
| 受信任插件的清单、钩子、测试和发布 | [插件开发指南](docs/plugin-development.md) |
| 权限作用域、允许/拒绝优先级 | [权限参考](docs/permissions.md) |
| Hydro/FPS 题目包结构与安全规则 | [题目包参考](docs/problem-package.md) |
| 内置题库格式与 OJ 兼容说明 | [OJ 兼容说明](docs/oj-compatibility.md) |
| Fermata 管理接口与错误处理 | [Fermata 接入说明](docs/fermata-integration.md) |
| 文件存储、Redis 队列和 Worker 边界 | [文件存储与后台任务](docs/storage-and-jobs.md) |
| 知识点目录和管理规则 | [知识点目录规格](docs/tag-taxonomy.md) |

## 状态与已知限制

当前仓库版本为 `0.1.0`。已实现题目协作、审题、组题、附件、题目包传输、权限和受信任内置插件；生产使用前仍应按部署指南接入邮件投递服务或明确关闭邮箱注册，并为外部服务分别设置凭据。

- Urmotiv 不运行参赛者程序，不提供编译器、沙箱或评测机。
- 插件宿主只加载编译进服务端的受信任内置代码；当前没有管理员上传任意插件包并即时执行的能力。
- Anklang、Fermata 是独立服务；服务不可用时的提交行为由各插件设置决定，不能把上游结果当作 Urmotiv 的最终审核决定。
- 首次管理员初始化与遗失管理员密码恢复都要求真实服务器 TTY；恢复会撤销该管理员现有会话，并把新密码只写到服务器控制台。

## 许可证与上游来源

本仓库以 MIT License 发布，许可证文本见 [`LICENSE`](LICENSE)。公开上游仓库为 <https://github.com/Huasushis/Urmotiv>；本 README 描述的是该仓库当前源码和契约，不承诺未列出的外部服务能力。
