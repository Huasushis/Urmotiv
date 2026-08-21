import { expect, test, type Route } from "@playwright/test";

async function fulfillJson(route: Route, body: unknown, status = 200): Promise<void> {
  await route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
}

test("CAS 登录启动失败时显示确定的安全错误且返回后可继续演示登录", async ({ page }) => {
  // 用路由拦截固定模拟会话与 CAS 启动失败，不依赖真实 CAS 服务，保证结果确定。
  await page.route("**/api/v1/session", async (route) => {
    await fulfillJson(route, {
      user: null,
      auth: {
        emailEnabled: true,
        emailRegistrationEnabled: false,
        ustcOAuthEnabled: false,
        casEnabled: true,
        demoEnabled: true
      }
    });
  });
  await page.route("**/api/v1/auth/cas/start*", async (route) => {
    await fulfillJson(
      route,
      {
        error: {
          code: "INVALID_CAS_START",
          message: "统一身份认证登录请求无效。",
          requestId: "e2e-cas-failure"
        }
      },
      400
    );
  });

  await page.goto("/demo-login");
  const casButton = page.getByRole("button", { name: "使用统一身份认证登录" });
  await expect(casButton).toBeVisible();

  await casButton.click();
  await expect(page).toHaveURL(/\/api\/v1\/auth\/cas\/start/);

  // 失败响应是确定的安全错误码，不泄露堆栈或内部路径。
  await expect(page.locator("body")).toContainText("INVALID_CAS_START");
  await expect(page.locator("body")).not.toContainText("stack");
  await expect(page.locator("body")).not.toContainText("at ");

  // 返回登录页后仍能正常使用演示账号登录，说明 CAS 失败不破坏登录流程。
  await page.goBack();
  await expect(casButton).toBeVisible();
  await page.getByRole("button", { name: /投稿人/ }).click();
  await expect(page).toHaveURL(/\/problems$/);
});

test("CAS 回调票据无效时显示确定的安全错误", async ({ page }) => {
  // 模拟真实回调失败：票据校验不通过时服务端返回 401 固定错误。
  await page.route(
    /\/api\/v1\/auth\/cas\/callback[?]ticket=expired/,
    async (route) => {
      await fulfillJson(
        route,
        {
          error: {
            code: "UNAUTHENTICATED",
            message: "请先登录后再继续。",
            requestId: "e2e-cas-callback-failure"
          }
        },
        401
      );
    }
  );

  await page.goto(
    "/api/v1/auth/cas/callback?ticket=expired&state=e2e-state"
  );

  await expect(page.locator("body")).toContainText("UNAUTHENTICATED");
  await expect(page.locator("body")).not.toContainText("stack");
  await expect(page.locator("body")).not.toContainText("ticket=expired");
});