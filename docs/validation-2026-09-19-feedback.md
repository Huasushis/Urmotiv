# 生产试用修复记录（2026-09-19）

## 本批已验证

- 权限组查询同时读取 global 和 own 授权。真实数据库测试验证 root 包含全部 34 项核心权限，投稿人保留查看、编辑、删除本人草稿的权限。
- 权限管理员不再受通用授权上限限制；给自己提权、转授 root、机器人固定禁止项仍拒绝。
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

## 仍未交付

这不是整项目完成报告。Fermata 完整模型配置、联系方式、公开榜单、作者 AI 开关、比赛整包导出、题号整理与新增题导入，以及邮箱/密码/第三方账号绑定仍按当前验收清单继续。
第三方身份的新设计见 [账号与第三方登录调整方案](account-linking-design.md)，该文档明确区分方案与已上线能力。
