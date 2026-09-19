import { expect, test } from "@playwright/test";

// 浏览器测试只使用合成数据；真实投递由 SMTP 接口测试和部署后的收信验证覆盖。
test("邮箱注册入口、发送提示和链接确认在桌面与手机可用", async ({ page }, testInfo) => {
  await page.route("**/api/v1/session", (route) => route.fulfill({ json: {
    user: null,
    auth: { emailEnabled: true, emailRegistrationEnabled: true, ustcOAuthEnabled: false, casEnabled: false, demoEnabled: false }
  } }));
  let registrations = 0;
  await page.route("**/api/v1/auth/email-register", async (route) => {
    expect(route.request().postDataJSON()).toEqual({
      username: "自由Alias", email: "registration@example.test", password: "synthetic-password-123", nickname: "注册测试"
    });
    registrations += 1;
    await route.fulfill({ status: 202, json: { ok: true, verificationPending: true } });
  });
  await page.goto("/login");
  await expect(page.getByRole("button", { name: /统一身份/ })).toHaveCount(0);
  await page.getByRole("button", { name: "注册新账号" }).click();
  await page.getByLabel("用户名", { exact: true }).fill("自由Alias");
  await page.getByLabel("昵称", { exact: true }).fill("注册测试");
  await page.getByLabel("邮箱", { exact: true }).fill("registration@example.test");
  await page.getByLabel("密码", { exact: true }).fill("synthetic-password-123");
  await page.getByRole("button", { name: "发送验证邮件" }).click();
  await expect(page.getByRole("status")).toContainText("请打开邮件中的链接完成验证");
  expect(registrations).toBe(1);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath("email-registration.png"), fullPage: true });

  const token = `uve_${"x".repeat(43)}`;
  await page.route("**/api/v1/auth/email-verification/verify", async (route) => {
    expect(route.request().postDataJSON()).toEqual({ token });
    await route.fulfill({ json: { ok: true } });
  });
  await page.goto(`/#/verify-email?token=${token}`);
  await expect(page.getByRole("heading", { name: "确认邮箱后再登录" })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath("email-verification.png"), fullPage: true });
  await page.getByRole("button", { name: "确认邮箱", exact: true }).click();
  await expect(page).toHaveURL(/\/login$/);
  await expect(page.getByLabel("用户名或邮箱")).toBeVisible();
});

test("关闭注册后隐藏注册入口，邮箱登录仍可使用", async ({ page }) => {
  await page.route("**/api/v1/session", (route) => route.fulfill({ json: {
    user: null,
    auth: { emailEnabled: true, emailRegistrationEnabled: false, ustcOAuthEnabled: false, casEnabled: false, demoEnabled: false }
  } }));
  await page.goto("/login");
  await expect(page.getByLabel("用户名或邮箱")).toBeVisible();
  await expect(page.getByRole("button", { name: "注册新账号" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: /统一身份/ })).toHaveCount(0);
});
