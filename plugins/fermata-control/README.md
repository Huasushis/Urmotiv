# Fermata 审核服务管理插件

Fermata 作为独立服务运行，并用机器人账号主动领取 Urmotiv 的待审任务。这个插件只让有权限的管理员查看服务状态、
修改非密钥设置和通知服务立即检查新任务，不在 Urmotiv 进程中运行模型。

## 管理接口

插件调用 Fermata 的以下版本 1 接口：

- `GET /api/v1/health`：运行状态、当前任务数和检查时间；
- `GET /api/v1/settings/public`：是否启用、轮询间隔、并发数、模型配置名称和实验版本；
- `PUT /api/v1/settings/public`：带当前修订编号更新上述设置，防止覆盖他人的同时修改；
- `POST /api/v1/actions/wake`：通知 Fermata 立即检查一次任务。

管理令牌放在 Urmotiv 的插件密钥存储中。普通设置和 Fermata 响应都不允许包含模型密钥；响应中只返回
`secretsConfigured`，说明 Fermata 自己是否已经配置密钥。

## 当前接入状态

内置插件已经能保存服务地址、等待时间和加密后的管理令牌。`FermataControlClient` 类已有独立测试，
Urmotiv API 通过 `FermataControlService` 把它接到了管理员 HTTP 路由，有 `plugin.manage` 权限的管理员
可以查看状态、读取/修改非密钥设置和触发立即检查。所有路由的权限检查与插件管理一致：无权访问统一返回 404，
不泄露端点存在性；插件未启用、未配置地址或缺少管理令牌时返回 503；Fermata 不可达、超时或返回不符合
契约时返回 503/502，响应中不包含令牌或 Fermata 原始错误体。操作员文档见 `docs/fermata-integration.md`。

## 机器人审核接口

Fermata 使用自己的 Urmotiv 机器人令牌领取有期限的任务。任务固定题目修订、审核轮次和内容摘要，续期或提交时如果这些
信息已经变化，Urmotiv 会拒绝旧结果。机器人意见默认不计入自动通过人数，是否计入由当前审核规则明确配置。

机器人固定不能删除题目或用户、模拟其他账号、修改权限、管理系统或读取密钥；给机器人错误分配管理员角色也不能解除这些限制。
