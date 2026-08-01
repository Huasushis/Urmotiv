# Urmotiv

Urmotiv 是 USTC 算法竞赛协会命题组使用的题库与命题协作系统。它覆盖投题、审题、组题、
题目访问记录、完整题目包导入导出和插件扩展，但不执行代码评测。

仓库目前以 [产品与技术规格](docs/spec.md) 为实现基线。权限规则见
[权限设计](docs/permissions.md)，题目导入导出见 [题目包规范](docs/problem-package.md)，
插件工作方式见 [插件规范](docs/plugins.md)。
文件存储、后台任务和 worker 的接口与配置见
[文件存储与后台任务](docs/storage-and-jobs.md)。

## 仓库边界

- `Urmotiv`：网站、API、后台任务和插件宿主。
- `Anklang`：独立原题检索服务，通过插件与 Urmotiv 通信。
- `Fermata`：独立 AI 审题服务，使用受限机器人账号调用 Urmotiv API。

真实题目、历史资料、表格和密钥不会进入 Git。根目录的 `.gitignore` 已明确屏蔽这些内容。

## 计划中的运行方式

- 开发与测试：代码在当前工作区编辑，构建、测试、数据库和浏览器联调统一在 `ssh ustc` 服务器进行。
- 服务器：Docker Compose 运行 Web/API、后台任务、PostgreSQL、Redis 和对象存储；测试端口通过 SSH 转发访问。
- 轻量入口：代码保留无需 Docker 的开发入口，便于故障排查，但不作为本项目的正式测试环境。
- 测试：`pnpm test`、`pnpm test:e2e`、`pnpm build`。

正式服务器的全新数据库必须先运行独立迁移，再通过真实终端运行
`pnpm --filter @urmotiv/api bootstrap-admin` 创建独立的首位系统管理员。内部 `root` 账号不可登录，
不能绑定真人邮箱、密码或 CAS 身份。完整顺序和固定失败结果见[服务器部署文档](docs/deployment.md)。

脚手架完成后，本节会补充可直接执行的服务器安装、初始化、端口转发和升级命令。
