import { test, expect } from "@playwright/test";
test("插件页读取运行日志，筛选、失败提示和窄屏布局", async ({ page }, info) => {
  await page.route("**/api/v1/admin/fermata/settings", (route) =>
    route.fulfill({
      json: {
        settings: {
          enabled: true,
          pollingIntervalSeconds: 60,
          maximumConcurrentTasks: 2,
          modelProfileName: "synthetic",
          experimentVersion: "synthetic",
        },
        revision: 1,
        secretsConfigured: true,
      },
    }),
  );
  await page.route("**/api/v1/admin/fermata/health", (route) =>
    route.fulfill({
      json: {
        health: {
          status: "ok",
          service: "fermata",
          apiVersion: "1",
          workerRunning: true,
          activeTasks: 1,
          checkedAt: "2026-09-21T00:00:00.000Z",
        },
      },
    }),
  );
  let failed = false;
  await page.route("**/api/v1/admin/fermata/logs?*", (route) =>
    route.fulfill(
      failed
        ? {
            status: 503,
            json: {
              error: {
                code: "FERMATA_UNAVAILABLE",
                message: "暂时无法读取运行日志。",
              },
            },
          }
        : {
            json: {
              startedAt: "2026-09-21T00:00:00.000Z",
              items: [
                {
                  id: 1,
                  time: "2026-09-21T00:00:01.000Z",
                  level: "ERROR",
                  message: "领取任务失败",
                  errorCode: "LLM_HTTP_ERROR",
                  details: { statusCode: 503 },
                },
              ],
            },
          },
    ),
  );
  await page.goto("/demo-login");
  await page.getByRole("button", { name: /系统管理员/ }).click();
  await expect(page).toHaveURL(/\/problems$/);
  await page.goto("/admin/fermata");
  await expect(
    page.getByRole("heading", { name: "运行日志", exact: true }),
  ).toBeVisible();
  await expect(page.locator(".runtime-log-list")).toContainText("领取任务失败");
  await expect(page.locator(".runtime-log-list")).toContainText(
    "LLM_HTTP_ERROR",
  );
  await page
    .getByRole("combobox", { name: "级别", exact: true })
    .selectOption("ERROR");
  await page.locator(".fermata-logs").scrollIntoViewIfNeeded();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth - innerWidth,
    ),
  ).toBeLessThanOrEqual(1);
  await page.screenshot({ path: info.outputPath("fermata-logs.png") });
  failed = true;
  await page.getByRole("button", { name: "刷新日志", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("暂时无法读取运行日志");
});
