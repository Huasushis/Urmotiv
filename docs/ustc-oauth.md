# USTC OAuth 指南

USTC OAuth 是可选的 OAuth 2.0 授权码登录（浏览器先到身份提供方授权，再由 Urmotiv 用一次性授权码换取资料）。默认关闭，不影响邮箱登录。提供方地址、客户端编号、客户端密钥和回调登记都由组织管理员完成；本文不记录任何真实地址、账号、客户端值或密钥。

## 管理页设置（当前规范）

拥有 `system.manage` 与 `user.permission.manage` 的真人管理员可以打开 `/admin/oauth`，或使用：

```text
GET /api/v1/admin/oauth/ustc
PUT /api/v1/admin/oauth/ustc
```

表单只有以下字段：**授权 URL**、**令牌 URL**、**用户资料 URL**、**回调 URL**、可选 **scopes**、客户端编号和客户端密钥。没有 issuer 或 base URL 字段。回调必须使用规范路径 `/api/v1/auth/ustc/callback`，可填写站点绝对 HTTPS 地址加该路径；保存时需要提交并发版本号。客户端编号和密钥不会出现在读取响应、审计记录或错误消息中；读取接口只返回是否已配置，表单在保存成功后清空两个输入框。客户端编号和密钥在数据库中使用服务端密钥加密保存，清除必须通过显式清除操作。

启用前必须填写三个提供方 URL、客户端编号、客户端密钥和精确回调地址。提供方 URL 和回调地址生产环境必须使用 HTTPS，不能包含账号、密码、查询参数或片段。仅在显式开启回环不安全 Cookie 的本地环境，`localhost`、`127.0.0.1` 或 `::1` 才可使用 HTTP；生产环境安全 Cookie 与 HTTPS 检查失败时拒绝保存。

## 环境变量兼容方式

旧版部署仍可在 Urmotiv 私有环境文件中设置以下变量；这是兼容入口，新部署优先使用管理页并将状态密钥保留在环境文件中：

```dotenv
URMOTIV_USTC_OAUTH_ENABLED=true
URMOTIV_USTC_OAUTH_AUTHORIZE_URL=https://oauth-provider.example/authorize
URMOTIV_USTC_OAUTH_TOKEN_URL=https://oauth-provider.example/token
URMOTIV_USTC_OAUTH_PROFILE_URL=https://oauth-provider.example/profile
URMOTIV_USTC_OAUTH_REDIRECT_URI=https://urmotiv.example.org/api/v1/auth/ustc/callback
URMOTIV_USTC_OAUTH_CLIENT_ID=由提供方后台签发的客户端编号
URMOTIV_USTC_OAUTH_CLIENT_SECRET=由提供方后台签发的客户端密钥
URMOTIV_USTC_OAUTH_STATE_SECRET=本地生成且不复用的32字节Base64URL值
URMOTIV_USTC_OAUTH_SCOPE=提供方要求的最小资料范围
```

兼容环境变量仍按同样的 HTTPS、固定回调、最小 scopes 和密钥长度规则校验；不支持 issuer 或 base URL。生产部署前运行：

```bash
bash scripts/deploy/validate-env.sh /secure/path/urmotiv.env
docker compose --env-file /secure/path/urmotiv.env config
```

环境文件权限必须为 `600`；不要把客户端密钥、状态密钥或完整 Compose 渲染结果写入 Git、日志、接口响应或截图。

## 提供方、DNS 和反向代理登记顺序

1. 为生产站点准备 HTTPS 证书和 DNS；把组织选择的公开主机名解析到反向代理，不要把此处的示例主机名当作真实值。
2. 在提供方后台手工创建 OAuth 客户端，授权类型选择授权码，登记**精确**回调 URI：`https://<你的站点>/api/v1/auth/ustc/callback`。不要在仓库、工单或聊天记录中写客户端密钥。
3. 把提供方发给组织的授权端点、令牌端点和资料端点分别写入上述三个 URL 变量；确认资料响应是 JSON，并且资料对象 `active` 为 `true`、`client_id` 与当前客户端编号一致。
4. 让反向代理把 `/` 转给 Web、`/api/` 转给 API，并保留 `Host`、`X-Forwarded-For`、`X-Forwarded-Proto`。只有确认代理来源后才填写 `URMOTIV_TRUSTED_PROXY_CIDRS`。
5. 由管理员在服务器私有环境文件中填入客户端值和随机状态密钥，运行校验和 Compose config；不要把 config 的完整渲染结果上传。
6. 打开 `/login`，点击“USTC OAuth 登录”验证授权、回调、会话建立和登出；测试失败时只记录固定错误编号和时间，不复制身份资料或授权码。

OAuth 登录状态有效期为 10 分钟，并绑定发起登录的浏览器 Cookie；换浏览器、转发 Cookie 或重复使用授权回调会被拒绝。OAuth 回调失败统一按未授权处理，不把提供方响应原文回传给浏览器。

## 身份字段映射

资料端点返回的稳定字段位于 `attributes` 对象时，Urmotiv 按下面规则解析：

| 提供方资料 | Urmotiv 字段 | 规则 |
| --- | --- | --- |
| `attributes.gid` | 外部身份 `subject` | 优先使用；若缺失才使用顶层 `id`。这是“提供方 + 稳定编号”的唯一身份键 |
| `attributes.zjhm` | `username` | 学工号；缺失时回退到 `attributes.jrzjhm` |
| `attributes.jrzjhm` | `username`（回退）和学号标识 | 仅在 `zjhm` 缺失或作为不同值的学生标识时使用 |
| `attributes.name` | `realName`、`nickname` | `realName` 使用原值；昵称使用该姓名，缺失时使用固定回退昵称“统一身份认证用户” |
| `attributes.email` | 主邮箱 | 若存在则规范化并作为已验证主邮箱保存；缺失时 OAuth 仍可登录，但不能用该身份进行邮箱登录 |
| `provider` | 外部身份来源 | 固定为 `ustc-oauth` |

只有 `gid` 和顶层 `id` 都缺失，或资料响应未激活/不属于当前客户端时，回调一定不会建立会话。`zjhm`、`jrzjhm`、`name` 和 `email` 可以缺失，缺失字段按上表处理。所有存在的资料字段仍会做长度、空白和格式校验；失败不会把原始资料写入日志。

## 首次角色和已有账号

- 第一次以某个 `ustc-oauth + subject` 登录且没有对应账号时，系统创建**人工账号**，把 `attributes.name` 作为实名、把它或固定回退值作为昵称，把 `zjhm` 或回退的 `jrzjhm` 保存为用户名/学号标识（两者都缺失时用户名为空），并自动加入内置 `contributor`（投稿人）角色。
- 新 OAuth 账号不会自动得到审题人、命题组成员、组长或系统管理员权限；需要组织的受审查权限流程后才能使用相应能力。
- 已绑定的外部身份再次登录时更新可变的用户名、实名和学号信息，但严格核对会拒绝把同一身份合并到冲突的用户名或主邮箱。
- 首位系统管理员不是 OAuth 首次登录创建的角色；全新部署必须先用服务器 TTY 执行 `bootstrap-admin`。角色、邮箱登录和恢复见[管理员指南](admin-guide.md)。

## 与邮箱登录并行

邮箱登录由 `URMOTIV_EMAIL_LOGIN_ENABLED` 控制，默认开启；OAuth 由 `URMOTIV_USTC_OAUTH_ENABLED` 控制，默认关闭。两者可以同时显示在 `/login`：OAuth 账号仍使用外部身份会话，邮箱凭据不会因 OAuth 开关而自动生成或重置。关闭 OAuth 后，既有外部绑定不会删除，但 OAuth 登录入口不可用。
