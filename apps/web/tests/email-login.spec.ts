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
    await page.getByLabel("邮箱").fill(syntheticEmail);
    await page.getByLabel("密码").fill(syntheticPassword);
    await page.getByRole("button", { name: "邮箱登录" }).click();
    await expect(page).toHaveURL(/\/problems$/);

    const denied = await page.request.get("/api/v1/admin/plugins");
    expect(denied.status()).toBe(404);

    await page.getByRole("button", { name: "退出" }).click();
    await expect(page).toHaveURL(/\/login$/);
    const afterLogout = await page.request.get("/api/v1/me");
    expect(afterLogout.status()).toBe(401);
  });
});
