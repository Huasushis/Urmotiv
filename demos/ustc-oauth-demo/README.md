# USTC 统一身份认证 OAuth2 登录演示

最小独立演示（Node 24 内置模块，零依赖）。真正接入 USTC 统一身份认证（OAuth 2.0 授权码模式）之前的就绪演示：
- 未配置身份源时自动处于 **readiness** 模式，只提供 `/health`、`/`、`/me`，**绝不发起 OAuth**。
- 配置了经制度注册的 client 后进入 **live** 模式，`/login` 才会跳转到 `https://id.ustc.edu.cn/cas/oauth2.0/authorize`。

## 制度前提（必须先完成，官方要求）

官方文档：https://id.ustc.edu.cn/doc/developer/ （访问 2026-08-14）。新应用官方只推荐 OAuth 2.0 授权码模式；
**只有校内部署且域名属于 `*.ustc.edu.cn` 的应用才能接入**；localhost/loopback 回调无法注册。

1. 网站负责人/管理员在网络安全工作平台完成建站申请及网站备案：https://netsecurity.ustc.edu.cn/
2. 提交统一身份认证接入申请：https://service.ustc.edu.cn/fe/taskCenter/one/application?app_id=234
   - 协议申请：OAuth2.0（授权码模式）
   - 回调地址（redirect_uri）精确写：`https://<site>.ustc.edu.cn/api/v1/auth/ustc/callback`
   - 申请导出属性（最小集）：`gid`（稳定身份）、`zjhm`/`id`（学工号/校园身份号）、`email`、`name`
   - 管理员批准后发放 `client_id`、`client_secret`，并按应用配置属性发布。
   - 联系人：`wf0229@ustc.edu.cn`（省级/网络信息中心）。
3. 把 `client_id`、`client_secret` 等写进**拥有者私有** env 文件（见下文配置），不要入库。

官方端点（已验证）：authorize `https://id.ustc.edu.cn/cas/oauth2.0/authorize`；accessToken
`https://id.ustc.edu.cn/cas/oauth2.0/accessToken`（POST，authorization_code）；profile
`https://id.ustc.edu.cn/cas/oauth2.0/profile`（POST access_token）。登出 `https://id.ustc.edu.cn/cas/logout`。

## 配置（完全私有；占位/弱密钥一律拒绝）

示例见 `.env.example`。把真实值放入拥有者私有文件，例如：

```
/home/ubuntu/codex-urmotiv/Urmotiv/private/ustc-oauth-demo/demo.env   (chmod 600)
```

必填：`USTC_DEMO_CLIENT_ID`、`USTC_DEMO_CLIENT_SECRET`、`USTC_DEMO_SESSION_SECRET`（≥32 随机）、
`USTC_DEMO_REDIRECT_URI`（必须是 https 的 `*.ustc.edu.cn`，否则拒绝启动）、`USTC_DEMO_DATA_DIR`
（私有目录，在 worktree 之外，0600 文件/0700 目录）。

## 启动

```sh
cd demos/ustc-oauth-demo
# 就绪模式（无配置）：先验证本地一切正常
/home/ubuntu/codex-urmotiv/.tools/node-v24.18.0/bin/node server.mjs   # 需 USTC_DEMO_DATA_DIR
# 正式模式：
USTC_DEMO_ENV_FILE=/home/ubuntu/codex-urmotiv/Urmotiv/private/ustc-oauth-demo/demo.env sh run.sh
```

默认绑定 `127.0.0.1:9797`（避免 3000/5173/8080）。浏览器访问：

```
http://127.0.0.1:9797/          首页
http://127.0.0.1:9797/login     发起 OAuth（live 模式）
http://127.0.0.1:9797/me        会话
http://127.0.0.1:9797/logout    退出本应用（不清除校 SSO）
```

线上映射（学校反向代理）：公网 `https://<site>.ustc.edu.cn` → `127.0.0.1:9797`，
回调路径经 `/api/v1/auth/ustc/callback`。

## 测试

```sh
/home/ubuntu/codex-urmotiv/.tools/node-v24.18.0/bin/node --test
```

覆盖：成功建档/重复登录合并、稳定身份缺失、state 缺失/不一致/重放/过期、token/profile
失败与超时、opaque 与 JWT 形态 token 分类脱敏、日志脱敏、非法回调 host、私有存储权限（0600/0700）、
不接管无关既有本地账号。

## 安全与数据规则（本演示已内置）

- 绑定键 = 固定 `ustc` 命名空间 + 发布的不变身份字段（`attributes.gid` 优先，其次顶层 `id`）；名称/邮箱不参与唯一键。
- 校园身份号（学工号）只以 HMAC 摘要 + 存在性布尔值落盘，普通文本不进 Git/日志/页面。
- 回调 host 必须与注册 redirect host 一致；state 单次使用 + 过期；会话 cookie HttpOnly/SameSite=Lax，HTTPS 下加 Secure。
- 令牌/授权码/profile 值永不记录、永不写入 Git；页面只展示字段名/类型/格式分类/算法。
- 不接管已存在的无关本地账号（不同 provider 或不同 subject 绝不合并）。

## 成功判定（脱敏收条）

登录成功页仅显示：固定文案「登录成功」、内部脱敏句柄（`u`+8 位十六进制）、令牌格式
（opaque / jwt-jws）、若为 JWT 则算法与声明名称/类型（无值）、profile 字段名称/类型、
校园身份号字段是否发布（不显示值）。任何真实身份值、令牌、cookie、密钥都不会出现。