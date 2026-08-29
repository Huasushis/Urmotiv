# Urmotiv

Urmotiv 是面向命题协作的题库系统：命题人编写 Markdown 题面与题解，审核人按服务端策略协作审题，管理员管理权限、导入任务和内置服务。

## 目录

- [安全](#安全)
- [背景](#背景)
- [前置条件](#前置条件)
- [安装](#安装)
- [启动](#启动)
- [首次登录](#首次登录)
- [导入与查找题目](#导入与查找题目)
- [管理设置](#管理设置)
- [内置插件](#内置插件)
- [测试与部署](#测试与部署)
- [API 与文档](#api-与文档)
- [支持](#支持)
- [参与贡献](#参与贡献)
- [许可证](#许可证)

## 安全

- 所有权限在 API 服务端检查；无权读取的对象统一按不存在返回，不返回标题、文件名、计数或筛选总数。
- 机器人账号固定不能删除用户、模拟登录、管理权限、管理系统、管理插件、管理令牌或查看审计记录；显式拒绝优先于角色和插件授权。
- 题目包导入会检查路径穿越、符号链接、重复路径、压缩炸弹、超限文件和覆盖冲突；Urmotiv 不执行选手代码或任意插件代码。
- OAuth 客户端编号与密钥只写入服务端，数据库保存加密值；读取接口只返回“是否已配置”。生产环境要求 HTTPS 与安全 Cookie。发现问题请参见[支持](#支持)，不要在公开 issue 中提交题面、答案、令牌或环境文件。

## 背景

题库内容、审核意见、附件和导入任务需要统一的权限边界与可追踪操作记录。Urmotiv 将题目正文以 Markdown 保存，使用版本与审核轮次保留协作历史，并把外部服务放在带版本的 HTTP 接口后。AI 审题服务 Fermata 和原题检索服务 Anklang 是独立项目，不共享 Urmotiv 数据库。

## 前置条件

- Node.js 22 或更高版本。
- pnpm 10（仓库声明的包管理器版本）。
- PostgreSQL、S3 兼容对象存储（生产环境推荐 MinIO）和 Docker Compose。
- 仅本地演示可使用内置 demo 登录；生产环境必须配置真实认证、数据库、对象存储、`URMOTIV_PLUGIN_SECRET_KEY` 和网页来源。

## 安装

```bash
pnpm install --frozen-lockfile
```

生产环境准备私有环境文件后，先运行：

```bash
bash scripts/deploy/validate-env.sh /绝对路径/urmotiv.env
```

环境文件应为权限 `600`，不要将它加入 Git。

## 启动

开发模式同时启动 API 和网页：

```bash
pnpm dev
```

网页默认地址是 `http://localhost:5173`；API 健康检查是 `http://localhost:3000/api/v1/health`。首次开发可在环境中显式开启 demo 登录，不要在生产环境开启。

## 首次登录

本地登录和外部登录是两条不同路径：开发环境可以使用已配置的 demo 账号；普通生产账号按部署启用的邮箱验证、CAS 或 USTC OAuth 流程登录。服务器紧急维护时，恢复后的固定 root 账号只走本地 `/api/v1/auth/root-login`，不走邮箱、CAS 或 USTC OAuth，也不作为日常账号。

root 本地凭据恢复必须在真实服务器 TTY 执行，使用固定命令：

```bash
docker compose --env-file /secure/path/urmotiv.env exec api pnpm --filter @urmotiv/api recover-root-credentials
```

`recover-root-credentials` 会在访问数据库、生成凭据或写入秘密前拒绝非 TTY；禁止使用 `docker compose run`、管道或重定向。命令要求两次隐藏输入“确认”，固定结果只写标准输出；新凭据值只写入服务器 `/dev/tty`，不会进入 API、日志或审计记录。

## 导入与查找题目

在“导入”页面上传受支持的题目包，先查看检测结果与预览，再确认导入。导入成功后，题库缓存会刷新；“导入历史”只展示当前账号或当前权限允许查看的摘要，不展示原始文件名和其他账号的私有内容。题库页支持状态、来源、导入批次和导入源筛选，筛选条件会保存在 URL 查询参数中，便于复制和返回。

题面与题解使用 Markdown；题目附件按公开图片、公开文件、内部题解附件和评测数据区分权限。没有 `problem.view` 或相应导入权限时，API 按题目不存在处理。

## 管理设置

拥有相应服务端能力的系统管理员在“管理”首页可以点击进入这些路径：

- **常规设置**：查看邮箱登录、注册、Cookie 安全模式和网页来源等当前服务配置。
- **用户权限**：`/admin/users`，查看账号并维护单个用户的允许/拒绝增量。
- **角色与权限**：`/admin/roles`，查看内置角色并管理自定义角色。
- **默认角色**：`/admin/roles/defaults`，维护人工账号和机器人账号的默认角色。
- **服务账号与令牌**：查看机器人账号状态；令牌创建、撤销和下载不会在页面显示令牌值。
- **审计记录**：查看不含题面、答案和密钥的操作摘要。
- **Fermata 服务**：查看 AI 审题服务健康状态和公开配置。
- **USTC OAuth**：分别填写授权 URL、令牌 URL、用户资料 URL、回调 URL和可选 scopes；固定回调路径为 `/api/v1/auth/ustc/callback`。客户端编号与密钥保存后输入框清空，读取只返回配置状态。
- **插件配置**：管理已内置插件配置，不提供 ZIP/GitHub 安装、更新、卸载或任意代码执行。
- **知识点目录**：查看和维护知识点分类与标签。

OAuth 的 HTTP 回环开发例外必须显式开启；生产环境不接受 HTTP 回调或非安全 Cookie。旧版回调地址仅保留服务端兼容处理，新配置统一使用上述规范路径。

## 内置插件

当前插件宿主只加载随 Urmotiv 发布并经过信任配置的内置插件。可在管理页查看插件状态和服务配置；插件不能解除机器人账号硬拒绝、显式拒绝、私有对象隐藏或密钥读取边界。外部插件安装和动态执行尚未纳入当前信任模型。

## 测试与部署

受影响包的类型检查与测试：

```bash
pnpm --filter @urmotiv/contracts typecheck
pnpm --filter @urmotiv/api typecheck
pnpm --filter @urmotiv/api test -- tests/final-integration-red.test.ts
pnpm --filter @urmotiv/web typecheck
pnpm --filter @urmotiv/web test -- src/pages/admin-page.test.tsx
```

构建全部工作区：

```bash
pnpm build
```

部署前先验证环境文件，再使用真实备份目录执行迁移、备份和滚动更新：

```bash
bash scripts/deploy/upgrade.sh /绝对路径/urmotiv.env /绝对路径/备份目录
```

部署脚本会执行数据库迁移并检查 `web` 容器内的 API 健康端点。不要重建或删除题库、对象存储和数据库服务；升级前后应由运维核对题目、修订和对象安全计数。

## API 与文档

- API 总览：[docs/api-contracts.md](docs/api-contracts.md)
- 产品规格：[docs/spec.md](docs/spec.md)
- 权限：[docs/permissions.md](docs/permissions.md)
- 题目包：[docs/problem-package.md](docs/problem-package.md)
- 管理员指南：[docs/admin-guide.md](docs/admin-guide.md)
- USTC OAuth：[docs/ustc-oauth.md](docs/ustc-oauth.md)
- Fermata 集成：[docs/fermata-integration.md](docs/fermata-integration.md)
- 插件边界：[docs/plugins.md](docs/plugins.md)
- 用户指南：[docs/user-guide.md](docs/user-guide.md)
- 部署：[docs/deployment.md](docs/deployment.md)

API 前缀为 `/api/v1`；健康检查为 `/api/v1/health`。接口请求和错误响应中的请求编号可用于内部排查，但不应与题面或密钥一起发送。

## 支持

请先阅读相关文档，再在项目 issue 中提交最小可复现步骤、版本、受影响 API 路径和脱敏错误编号。不要提交私有题面、题解、附件、模型原始回答、账号、密码、令牌或环境文件。安全漏洞请通过私下渠道联系维护者，并等待确认后再公开披露。

## 参与贡献

提交前请保持变更小而完整：先确认服务端权限和数据隐私边界，再补充能证明可观察行为的测试。运行受影响工作区的类型检查、测试和构建；页面变更还需用桌面与手机尺寸检查主要点击路径。贡献不得加入插件安装器、任意代码执行或动态包加载，也不得将私有资料复制到 Git。

## 许可证

本项目使用 [MIT License](LICENSE)。
