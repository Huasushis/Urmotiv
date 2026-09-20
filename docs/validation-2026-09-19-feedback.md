# 生产试用修复记录（2026-09-19）

## 本批已验证

- 权限组查询同时读取 global 和 own 授权。真实数据库测试验证 root 包含全部 34 项核心权限，投稿人保留查看、编辑、删除本人草稿的权限。
- 权限管理员不再受通用授权上限限制。9 月 20 日进一步按产品要求允许调整自身业务授权；仍不能转授 root，运行时明确拒绝和机器人固定禁止项不变。
- 用户管理单独添加/移除权限组，保留同组其他成员，版本冲突不会覆盖并发更改。角色页不再列出账号复选框。
- 持有模拟登录权限的真人管理员可切换到普通用户；旧会话失效，只按目标权限操作，退出须重新登录。
- 插件密钥清空复选框不在异步状态更新中读取已经失效的事件对象；重复勾选不白屏。
- 令牌轮换需确认；已撤销/过期令牌默认收起，历史列表每页 10 条。
- 题目搜索在中文输入法组合结束后延迟提交，不在拼音输入中更新查询。
- 青色、轻玻璃质感界面；角色、用户、设置、插件、服务账号页面完成桌面和手机检查。

## 实际检查

均在服务器、Node 24 下执行，测试只用一个 worker：

```sh
pnpm --filter @urmotiv/api exec vitest run tests/admin-security-red.test.ts tests/admin-security-database.test.ts tests/p1-identity-permissions.test.ts --maxWorkers=1 --no-file-parallelism
pnpm --filter @urmotiv/api exec vitest run tests/p1-identity-permissions.test.ts tests/p1-identity-audit-attribution.test.ts --maxWorkers=1 --no-file-parallelism
pnpm --filter @urmotiv/web exec vitest run src/pages/admin-permissions-page.test.tsx src/pages/admin-page.test.tsx src/components/search-input.test.tsx src/pages/problem-list-page.test.tsx --maxWorkers=1 --no-file-parallelism
pnpm --filter @urmotiv/web exec playwright test tests/admin.spec.ts --workers=1
pnpm --filter @urmotiv/web exec playwright test tests/admin.spec.ts --grep '角色页展示|服务账号页面|系统管理员保存插件' --workers=1
```

API 第一组 24 项通过；增加管理员切换用例后的第二组 7 项通过。Web 第一组 34 项通过；补充成员变更测试后单独重跑权限页 14 项通过。
浏览器首轮 14 项通过、6 项按视口跳过，2 项旧断言因历史令牌默认收起失败；更新断言并补上轮换取消、密钥重复勾选及 root 目录后，复验 5 项通过、1 项按视口跳过。
API/Web 类型检查、构建通过。截图是合成账号环境，人工检查了桌面权限页和手机用户页；不包含生产私有数据。

## 后续账号修复

后续账号修复另批验证：注册允许自由用户名，重复用户名返回可读提示；邮箱未验证前不能用用户名绕过验证。`api.test.ts` 与 `login-security.test.ts` 18 项通过；增加冲突提示后重跑 `api.test.ts` 与 `registration-username-database.test.ts` 15 项通过。桌面/手机 `email-registration.spec.ts` 4 项通过。机器人权限组入口复用用户管理组件，`admin.spec.ts --grep '服务账号页面'` 桌面/手机 2 项通过；其权限仍受服务端固定禁止项约束。

`90e850e` 的 Web 全量 24 文件、152 项通过。生产桌面/手机复验 root 全目录、权限组入口及插件密钥反复勾选，零页面异常；注册页实测接受自由用户名。临时会话已撤销，没有保存或清空生产密钥。
补查题目工作区后统一吸顶标题与导航高度，并加深浅色文字；桌面/360px 手机的对比度、触屏控件和创建工作区检查 4 项通过，增加滚动遮挡断言后对应 2 项通过，生产构建通过。

## 作者 AI 审题开关

新建表单默认勾选“允许 AI 审题”，可在创建前取消；题目概要提供同一选择，待审时也可调整。服务端只允许有本题编辑权的真人作者或有本题状态管理权的真人管理员，事务内重读权限、检查修订号。机器人不可调整。
新字段只进入创建请求，普通编辑不重置历史设置；保存失败还原开关，已有未保存编辑时暂时禁用开关。关闭不删除已有意见，任务领取、续租、完成继续检查该标志。

验证：机器人接口完整 22 项通过；补充新建关闭、普通编辑保留、作者开关、无权读者、明确拒绝与机器人拒绝后，针对 2 项通过。Web 受影响 33 项通过，开关异步交互修正后组件 18 项通过。真实 API 浏览器验证管理员及作者流程，作者新建关闭、开启后刷新、关闭后刷新在桌面手机均通过。API 构建、Web 类型检查和生产构建通过。截图使用合成题目。

最终 Web 全量 24 文件 154 项通过。

## 后续进展

本文件记录第一批验收，不是最新功能清单。随后已经交付 Fermata 完整模型配置、联系方式、公开榜单、比赛整包导出、题号整理与新增题，以及邮箱/密码/第三方账号绑定，使用入口见 [用户指南](user-guide.md)。统一身份仍关闭，关联流程的自动化验证不代表已开通外部学校客户端。
第三方身份边界见 [账号与第三方登录](account-linking-design.md)。
