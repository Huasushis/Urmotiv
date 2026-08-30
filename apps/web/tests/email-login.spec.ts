import { expect, test } from "@playwright/test";

const syntheticEmail = "synthetic-e2e@example.test";
const syntheticPassword = "synthetic-e2e-password";

// The isolated database seed is intentionally opt-in so the normal demo E2E suite
// never assumes a real account or a persistent test database.
test.describe("合成邮箱登录与会话边界", () => {
  test.skip(
    process.env.URMOTIV_EMAIL_E2E !== "1",
    "requires the isolated synthetic email-login stack"
  );

  test("邮箱登录、权限边界、退出后会话拒绝", async ({ page }) => {
    await page.goto("/login");
    await expect(page.getByRole("heading", { name: "进入 Urmotiv" })).toBeVisible();
    await page.getByLabel("用户名或邮箱").fill(syntheticEmail);
    await page.getByLabel("密码").fill(syntheticPassword);
    await page.getByRole("button", { name: "登录", exact: true }).click();
    await expect(page).toHaveURL(/\/problems$/);

    const denied = await page.request.get("/api/v1/admin/plugins");
    expect(denied.status()).toBe(404);

    await page.getByRole("button", { name: "退出" }).click();
    await expect(page).toHaveURL(/\/login$/);
    const afterLogout = await page.request.get("/api/v1/me");
    expect(afterLogout.status()).toBe(401);
  });
});

test.describe("邮箱登录失败路径的界面一致性（路由注入，不依赖真实账号）", () => {
  const loginEndpoint = "**/api/v1/auth/email-login";
  const deniedBody = {
    error: { code: "UNAUTHENTICATED", message: "请先登录后再继续。" }
  };
  const limitedBody = {
    error: { code: "LOGIN_RATE_LIMITED", message: "登录尝试过于频繁，请稍后再试。" }
  };

  test("用户名登录表单在桌面和手机视口内完整可见", async ({ page }, testInfo) => {
    await page.goto("/login");
    await expect(page.getByLabel("用户名或邮箱")).toBeVisible();
    await expect(page.getByRole("button", { name: "登录", exact: true })).toBeVisible();
    const layout = await page.evaluate(() => ({
      bodyWidth: document.body.scrollWidth,
      viewportWidth: window.innerWidth,
      panel: document.querySelector(".login-panel")?.getBoundingClientRect().toJSON()
    }));
    expect(layout.bodyWidth).toBeLessThanOrEqual(layout.viewportWidth);
    expect(layout.panel).toBeDefined();
    expect(layout.panel!.left).toBeGreaterThanOrEqual(0);
    expect(layout.panel!.right).toBeLessThanOrEqual(layout.viewportWidth);
    await page.screenshot({ path: testInfo.outputPath("login-page.png"), fullPage: true });
  });

  test("错误口令 / 邮箱未知 / 账号停用显示同一个通用 401 提示", async ({ page }) => {
    let attempts = 0;
    await page.route(loginEndpoint, async (route) => {
      attempts += 1;
      await route.fulfill({ status: 401, contentType: "application/json", body: JSON.stringify(deniedBody) });
    });
    const cases = [
      { email: "synthetic-e2e@example.test", password: "wrong-password-for-this" },
      { email: "absent-user@example.test", password: "does-not-matter-123" },
      { email: "disabled.synthetic@example.test", password: "does-not-matter-123" }
    ];
    for (const item of cases) {
      await page.goto("/login");
      await expect(page.getByRole("heading", { name: "进入 Urmotiv" })).toBeVisible();
      await page.getByLabel("用户名或邮箱").fill(item.email);
      await page.getByLabel("密码").fill(item.password);
      await page.getByRole("button", { name: "登录", exact: true }).click();
      await expect(page.getByText("请先登录后再继续。")).toBeVisible();
      await expect(page.getByText("登录尝试过于频繁")).toHaveCount(0);
    }
    expect(attempts).toBe(3);
  });

  test("来源限流的 429 显示固定通用提示且不含邮箱", async ({ page }) => {
    let seenBody: string | undefined;
    await page.route(loginEndpoint, async (route) => {
      seenBody = route.request().postData() ?? "";
      await route.fulfill({ status: 429, contentType: "application/json", body: JSON.stringify(limitedBody) });
    });
    await page.goto("/login");
    await expect(page.getByRole("heading", { name: "进入 Urmotiv" })).toBeVisible();
    await page.getByLabel("用户名或邮箱").fill("limited.synthetic@example.test");
    await page.getByLabel("密码").fill("does-not-matter-123");
    await page.getByRole("button", { name: "登录", exact: true }).click();
    await expect(page.getByText("登录尝试过于频繁，请稍后再试。")).toBeVisible();
    // 页面提示只来自服务端固定消息，不渲染用户邮箱。
    await expect(page.getByText("limited.synthetic@example.test")).toHaveCount(0);
    expect(seenBody).toContain("limited.synthetic@example.test");
    expect(seenBody).not.toContain("请先登录后再继续。");
  });

  test("成功登录提交正确的邮箱/密码且不显示任何错误", async ({ page }) => {
    let seenBody: string | undefined;
    await page.route(loginEndpoint, async (route) => {
      seenBody = route.request().postData() ?? "";
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          user: { id: "1", nickname: "合成登录账号", accountType: "human", username: null, roles: ["投稿人"] },
          auth: { emailEnabled: true, emailRegistrationEnabled: false, ustcOAuthEnabled: false, casEnabled: false, demoEnabled: true }
        })
      });
    });
    await page.goto("/login");
    await expect(page.getByRole("heading", { name: "进入 Urmotiv" })).toBeVisible();
    await page.getByLabel("用户名或邮箱").fill("synthetic-e2e@example.test");
    await page.getByLabel("密码").fill("synthetic-e2e-password");
    await page.getByRole("button", { name: "登录", exact: true }).click();
    const parsed = JSON.parse(seenBody ?? "{}") as { email?: string; password?: string };
    expect(parsed.email).toBe("synthetic-e2e@example.test");
    expect(parsed.password).toBe("synthetic-e2e-password");
    await expect(page.getByText("请先登录后再继续。")).toHaveCount(0);
    await expect(page.getByText("登录尝试过于频繁")).toHaveCount(0);
  });

  test("root 用户名只调用专用登录入口", async ({ page }) => {
    let rootBody: string | undefined;
    let ordinaryLoginRequests = 0;
    await page.route("**/api/v1/auth/root-login", async (route) => {
      rootBody = route.request().postData() ?? "";
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          user: {
            id: "0",
            nickname: "root",
            accountType: "human",
            username: "root",
            permissions: [],
            roles: ["root"],
            isRoot: true,
            canManageReviewPolicy: true,
            canManagePlugins: true,
            canManageTags: true
          },
          auth: {
            emailEnabled: true,
            emailRegistrationEnabled: false,
            ustcOAuthEnabled: false,
            casEnabled: false,
            demoEnabled: false
          }
        })
      });
    });
    await page.route("**/api/v1/auth/{email-login,username-login}", async (route) => {
      ordinaryLoginRequests += 1;
      await route.abort();
    });
    await page.goto("/login");
    await page.getByLabel("用户名或邮箱").fill("root");
    await page.getByLabel("密码").fill("synthetic-root-password");
    await page.getByRole("button", { name: "登录", exact: true }).click();
    await expect(page).toHaveURL(/\/problems$/);
    expect(JSON.parse(rootBody ?? "{}")).toEqual({
      identifier: "root",
      password: "synthetic-root-password"
    });
    expect(ordinaryLoginRequests).toBe(0);
  });
});
