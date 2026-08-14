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
http://127.0.0.1:9797/profile   查看自己的真实资料字段（demo 专用，仅内存）
http://127.0.0.1:9797/logout    退出本应用（不清除校 SSO）
```

线上映射（学校反向代理）：公网 `https://<site>.ustc.edu.cn` → `127.0.0.1:9797`，
回调路径经 `/api/v1/auth/ustc/callback`。

回调路径不是任意选的：**live 模式下服务器只在注册 redirect_uri 的精确路径上服务回调**（自动从
`USTC_DEMO_REDIRECT_URI` 的路径推导；`USTC_DEMO_CALLBACK_PATH` 只有与之一致才被接受，否则拒绝启动）。
演示不提供回调别名路径——未注册的路径一律 404。

## 复用 oj.ustc.edu.cn 现有 USTC 接入做本地测试（Windows，不改生产）

已从公开无登录跳转验证（2026-08-14）：oj.ustc.edu.cn 的「Login With USTC」走 OAuth2 授权码模式，
跳转 `https://id.ustc.edu.cn/cas/oauth2.0/authorize`，**注册回调地址精确为
`https://oj.ustc.edu.cn/oauth/ustc/callback`**（路径 `/oauth/ustc/callback`）。client 由社团持有。

复用的两个硬性前提：
1. **回调地址精确相等** —— 本地用 hosts 覆盖 + 本地 TLS 代理把 `https://oj.ustc.edu.cn/oauth/ustc/callback` 原样送达演示服务；演示服务在 `/oauth/ustc/callback` 上服务回调（配置按下方写法即自动一致，无需别名路径）。
2. **持有匹配的 client_secret** —— **只能由社团网站负责人从自己的注册记录取得，直接填进本机 0600 env 文件；不要在聊天中粘贴 client_id/client_secret 等任何值**。仓库与演示不存、不搜、不记录。

> 安全注记：任何在聊天中泄露过的一次性 state、CAS 服务票据或授权码一律视为已失密/已过期，
> 不得直接使用；每次登录演示都会重新生成自己的 state，测试时凭一次全新登录进行。
> 443 是注册 URI 隐含的默认端口，IdP 会重定向到 `https://oj.ustc.edu.cn/oauth/ustc/callback`
> （不带端口），因此本地必须监听 **127.0.0.1:443**（Windows 需管理员权限运行本地代理）。
> 全程仅本机：不改 DNS、不开公网端口、不动 oj.ustc.edu.cn 生产服务。

Windows 侧步骤（PowerShell，管理员）：
1. 备份并追加 hosts（`C:\Windows\System32\drivers\etc\hosts`）：
   `127.0.0.1 oj.ustc.edu.cn`（先备份原文件；测试结束删除该行还原）。
2. 建 SSH 隧道（把本地 127.0.0.1:9798 转发到服务器上的 127.0.0.1:9797，即演示服务）：
   `ssh -N -L 9798:127.0.0.1:9797 ubuntu@<server>`
3. 建一个专用 TLS 工作目录并在其中操作（证书与 Caddyfile 放一起，便于清理）：
   ```
   New-Item -ItemType Directory -Force C:\ustc-demo-tls; cd C:\ustc-demo-tls
   ```
   安装并信任本地 CA，**必须用 `-cert-file`/`-key-file` 固定文件名**（mkcert 默认会命名成
   `oj.ustc.edu.cn+2.pem` / `oj.ustc.edu.cn+2-key.pem`，与下面 Caddyfile 引用的文件名不一致）：
   ```
   mkcert -install; mkcert -cert-file cert.pem -key-file key.pem oj.ustc.edu.cn 127.0.0.1 localhost
   ```
4. 在同一目录写 `Caddyfile`（用管理员 PowerShell 生成；也可手动保存，文件名必须是 `Caddyfile`）：
   ```
   Set-Content -Path .\Caddyfile -Encoding ascii -Value @'
   https://oj.ustc.edu.cn:443 {
     tls cert.pem key.pem
     reverse_proxy 127.0.0.1:9798 {
       header_up Host {http.request.host}
     }
   }
   '@
   ```
   `header_up Host {http.request.host}` 必须保留：演示服务只信任真实 Host。
   启动（管理员，仍在 TLS 目录内；Caddy 从当前目录读 `Caddyfile`）：
   ```
   caddy run --config .\Caddyfile
   ```
5. 服务器端配置私有 env 文件（见上一节）：`USTC_DEMO_REDIRECT_URI=https://oj.ustc.edu.cn/oauth/ustc/callback`、
   网站负责人**在本机**填入社团的 `client_id`/`client_secret`、新随机 `USTC_DEMO_SESSION_SECRET`；启动演示（先确认 SSH 隧道已连）。
6. 浏览器打开 `https://oj.ustc.edu.cn/` → 点「使用统一身份认证登录」→ 完成一次**全新** SSO → 应回到演示的登录成功页。

清理/还原（只清上面生成的东西）：Ctrl+C 停本地 Caddy → Ctrl+C 断开 SSH 隧道 → 从 hosts 删除覆盖行（用备份还原）→
删除 TLS 目录 `C:\ustc-demo-tls`（含 cert.pem、key.pem、Caddyfile）→ 可选 `mkcert -uninstall`（撤销本地 CA 信任）。
不触碰 oj.ustc.edu.cn 生产、不改 DNS、不开公网端口。

> 未拿到社团 client_secret 并确认注册回调前，不要把演示切到 live：配置按此写法会在注册路径不一致时
> 拒绝启动（fail closed）。

## 自资料页 /profile（demo 专用）

登录成功后，成功页与 `/me` 会话页都会链接到 `/profile`：在**你自己的浏览器**里查看本次登录时
身份源真实返回的 USTC profile 字段。属性如下：

- **仅认证会话可见**：要求回调注册 host 的 Host 头一致（X-Forwarded-* 永不接受），并要求有效会话；未登录、伪造会话、过期会话或错误 Host 一律不展示任何资料。
- **白名单保留值**：只有固定白名单（`active`、`id`、`attributes.gid/name/deptname/zjhm/jrzjhm/kind/email`）的值会留在服务端**内存会话**里；其余返回字段只保留字段名与类型（`attributes.deptCode` 等），值当场丢弃。
- **绝不落盘/记日志**：任何 profile 值都不写入 `accounts.json`（账户存储仍是原来的 HMAC 信封，字段不变）、不写入日志、不进入 Git。登出、会话过期或服务重启即全部丢弃——因此**服务重启后需要重新登录一次**才能再次查看。
- **演示专用**：页面带「Demo 专用 / 仅内存」说明；响应 `no-store`，并带严格 CSP（`default-src 'none'`，无脚本/图片/表单/iframe）、`Referrer-Policy: no-referrer`、`X-Content-Type-Options: nosniff`；所有值经 HTML 转义（测试覆盖恶意值）。

## 测试

```sh
/home/ubuntu/codex-urmotiv/.tools/node-v24.18.0/bin/node --test
```

覆盖：成功建档/重复登录合并、稳定身份缺失、state 缺失/不一致/重放/过期、token/profile
失败与超时（含超时日志）、opaque 与 JWT 形态 token 分类脱敏、日志脱敏、非法回调 host、
X-Forwarded-Host 伪造拒绝、精确回调路径（未注册路径 404）、cookie 属性（HttpOnly/SameSite=Lax/Secure）、
身份源 `error` 参数安全中止并销毁会话、无学工号发布时的降级建档、token/profile 响应大小上限
（Content-Length 与分块流式两种）拒绝、私有存储权限（0600/0700）、不接管无关既有本地账号、
会话 TTL/清理/登出与失败路径失效、账户存储信封完整性（损坏/MAC 不符/符号链接一律 fail closed，文件原样保留）、
自资料页（未登录/伪造会话拒绝、错误 Host 拒绝、白名单值仅限内存、非白名单字段只留名称/类型、
恶意值 HTML 转义、过期会话拒绝、登出即丢弃、store 与日志零残留、成功页指引、
畸形 Cookie/畸形 Host 容错不崩溃、X-Forwarded-Host 伪造拒绝、访问即整体清扫过期会话）。

## 安全与数据规则（本演示已内置）

- 绑定键 = 固定 `ustc` 命名空间 + 发布的不变身份字段（`attributes.gid` 优先，其次顶层 `id`）；名称/邮箱不参与唯一键。
- 校园身份号（学工号）只以 HMAC 摘要 + 存在性布尔值落盘，普通文本不进 Git/日志/页面。
- 回调 host 必须与注册 redirect host 一致（只信真实 Host 头，从不读取 X-Forwarded-Host）；state 单次使用 + 过期；会话 cookie HttpOnly/SameSite=Lax，HTTPS 下加 Secure。
- 生产端点固定为官方值（authorize/accessToken/profile/logout），覆盖必须先开测试专用开关 `USTC_DEMO_TEST_SEAM`，且仍需是合法 http(s) URL。
- 对 IdP 的 token/profile 响应做有界读取：先核 Content-Length、再按实际线上字节数拦截超大/分块/畸形响应（8192 / 16384 字节上限），超限即拒绝且不落任何内容。
- 会话 8 小时过期（`USTC_DEMO_SESSION_TTL_MS` 可调，仅允许正数，过期防禁用），访问与新建时清理；登出、回调失败与回调异常一律销毁会话并清空会话 cookie（`Max-Age=0`）。
- 账户存储 `accounts.json` 是信封 `{v, mac, data}`：JSON 损坏、信封结构不符、HMAC 不符或路径被替换成符号链接，一律拒绝登录并保留文件原样（人工核查），绝不静默覆盖。
- 令牌/授权码/profile 值永不记录、永不写入 Git；错误日志只用常量原因串（如 `token_exchange:timeout`），不带任何值。除 `/profile` 页在白名单内、仅向会话本人、仅存内存地展示外，页面只展示字段名/类型/格式分类/算法。
- `/profile` 自资料页只在注册 host + 有效会话下可访问；值仅按白名单保留在内存会话，其余字段只留名称/类型；响应 no-store + 严格 CSP + no-referrer + nosniff，所有输出经 HTML 转义。
- 不接管已存在的无关本地账号（不同 provider 或不同 subject 绝不合并）；同一 subject 若以不同学工号重现，拒绝合并并保留现场。

## 成功判定（脱敏收条）

登录成功页仅显示：固定文案「登录成功」、内部脱敏句柄（`u`+8 位十六进制）、令牌格式
（opaque / jwt-jws）、若为 JWT 则算法与声明名称/类型（无值）、profile 字段名称/类型、
校园身份号字段是否发布（不显示值）。任何真实身份值、令牌、cookie、密钥都不会出现。