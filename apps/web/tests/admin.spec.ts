import { expect, test, type Page, type Route } from "@playwright/test";

async function loginAs(page: Page, accountName: RegExp): Promise<void> {
  await page.goto("/demo-login");
  await page.getByRole("button", { name: accountName }).click();
  await expect(page).toHaveURL(/\/problems$/);
}

const reviewPolicy = {
  selectedRuleId: "org.ustc.urmotiv.review-default.count",
  selectedPluginVersion: "1.0.0",
  settings: {
    requiredApprovals: 2,
    maximumRejections: 0,
    countRobotReviews: false
  },
  revision: 6,
  selectedRuleAvailable: true,
  availableRules: [
    {
      id: "org.ustc.urmotiv.review-default.count",
      displayName: "默认人数规则",
      pluginVersion: "1.0.0",
      settingsSchema: {
        type: "object",
        properties: {
          requiredApprovals: {
            type: "integer",
            minimum: 1,
            maximum: 100,
            default: 2,
            title: "通过所需人数"
          },
          maximumRejections: {
            type: "integer",
            minimum: 0,
            maximum: 100,
            default: 0,
            title: "允许的不通过人数"
          },
          countRobotReviews: {
            type: "boolean",
            default: false,
            title: "计算机器人意见"
          }
        }
      }
    }
  ]
};

const plugin = {
  id: "org.ustc.urmotiv.anklang",
  name: "原题检索",
  version: "0.1.0",
  apiVersion: "v1-private-detail",
  source: "server-only-source",
  state: "disabled",
  failureCode: null,
  settings: {
    baseUrl: "https://search.internal",
    timeoutMs: 30000,
    failureBehavior: "block",
    blockWhenRecommended: true,
    minimumSimilarityToShow: 0.3,
    cacheMinutes: 1440
  },
  settingsManagedBy: "plugin",
  settingsSchema: {
    type: "object",
    required: ["baseUrl"],
    properties: {
      baseUrl: {
        type: "string",
        format: "uri",
        title: "Anklang 服务地址"
      },
      timeoutMs: {
        type: "integer",
        minimum: 1000,
        maximum: 120000,
        title: "最长等待时间（毫秒）"
      }
    }
  },
  reviewRuleIds: [],
  settingsRevision: 4,
  secrets: [
    {
      name: "serviceToken",
      label: "访问令牌",
      description: "用于确认题库系统的请求。",
      configured: true,
      maskedSuffix: "a9Qx"
    }
  ],
  requiresRestart: false
};

async function fulfillJson(route: Route, body: unknown, status = 200): Promise<void> {
  await route.fulfill({
    status,
    contentType: "application/json",
    body: JSON.stringify(body)
  });
}

test("无管理权限的账号直接访问管理页时不会读取管理接口", async ({ page }) => {
  let managementRequestCount = 0;
  await page.route("**/api/v1/admin/plugins", async (route) => {
    managementRequestCount += 1;
    await fulfillJson(route, { items: [plugin] });
  });
  await page.route("**/api/v1/review-policy", async (route) => {
    managementRequestCount += 1;
    await fulfillJson(route, reviewPolicy);
  });

  await loginAs(page, /投稿人/);
  await page.goto("/admin");

  await expect(page.getByText("当前账号没有可用的管理设置")).toBeVisible();
  await expect(page.getByRole("link", { name: "管理" })).toHaveCount(0);
  expect(managementRequestCount).toBe(0);
  await expect(page.getByText(plugin.name)).toHaveCount(0);
});

test("组长保存审核规则，冲突时保留输入并可主动重新读取", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop-chromium", "保存流程只需运行一次");
  let readCount = 0;
  let submittedBody: unknown;
  await page.route("**/api/v1/review-policy", async (route) => {
    if (route.request().method() === "GET") {
      readCount += 1;
      await fulfillJson(
        route,
        readCount === 1
          ? reviewPolicy
          : {
              ...reviewPolicy,
              revision: 7,
              settings: { ...reviewPolicy.settings, requiredApprovals: 4 }
            }
      );
      return;
    }
    submittedBody = route.request().postDataJSON();
    await fulfillJson(
      route,
      {
        error: {
          code: "revision_conflict",
          message: "审核规则已被其他操作修改，请刷新后重试。"
        }
      },
      409
    );
  });

  await loginAs(page, /组长/);
  await page.goto("/admin");
  const requiredApprovals = page.getByLabel("通过所需人数");
  await requiredApprovals.fill("3");
  await page.getByRole("button", { name: "保存审核规则" }).click();

  await expect(page.getByText("其他人已经修改了审核规则")).toBeVisible();
  await expect(requiredApprovals).toHaveValue("3");
  expect(submittedBody).toEqual({
    ruleId: reviewPolicy.selectedRuleId,
    settings: { ...reviewPolicy.settings, requiredApprovals: 3 },
    expectedRevision: 6
  });

  await page.getByRole("button", { name: "放弃本页输入并重新读取" }).click();
  await expect(requiredApprovals).toHaveValue("4");
  await page.screenshot({ path: testInfo.outputPath("admin-review-desktop.png"), fullPage: true });
});

test("系统管理员保存插件设置后密钥输入框恢复为空", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop-chromium", "保存流程只需运行一次");
  let submittedBody: Record<string, unknown> | undefined;
  await page.route("**/api/v1/admin/plugins", async (route) => {
    await fulfillJson(route, { items: [plugin] });
  });
  await page.route("**/api/v1/admin/plugins/org.ustc.urmotiv.anklang", async (route) => {
    submittedBody = route.request().postDataJSON() as Record<string, unknown>;
    await fulfillJson(route, {
      item: {
        ...plugin,
        settings: { ...plugin.settings, timeoutMs: 45000 },
        settingsRevision: 5,
        secrets: [{ ...plugin.secrets[0], maskedSuffix: "tKey" }]
      }
    });
  });

  await loginAs(page, /系统管理员/);
  await page.goto("/admin");
  await expect(page.getByRole("heading", { name: "原题检索" })).toBeVisible();
  const timeout = page.getByLabel("最长等待时间（毫秒）");
  const secret = page.getByLabel("访问令牌");
  await timeout.fill("45000");
  await secret.fill("temporary-test-key");
  await page.getByRole("button", { name: "保存插件设置" }).click();

  await expect(page.getByText("插件设置已保存")).toBeVisible();
  await expect(secret).toHaveValue("");
  await expect(page.getByText(/末尾四个字符为 tKey/)).toBeVisible();
  expect(submittedBody).toEqual({
    expectedRevision: 4,
    settings: { ...plugin.settings, timeoutMs: 45000 },
    secrets: { serviceToken: "temporary-test-key" }
  });
  await expect(page.getByText(plugin.apiVersion)).toHaveCount(0);
  await expect(page.getByText(plugin.source)).toHaveCount(0);
  await page.screenshot({ path: testInfo.outputPath("admin-plugin-desktop.png"), fullPage: true });
});

test("手机视口中的插件设置没有横向溢出", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "mobile-chromium", "只检查手机布局");
  await page.route("**/api/v1/admin/plugins", async (route) => {
    await fulfillJson(route, { items: [plugin] });
  });

  await loginAs(page, /系统管理员/);
  await page.goto("/admin");
  await expect(page.getByRole("heading", { name: "原题检索" })).toBeVisible();

  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth
  );
  expect(overflow).toBeLessThanOrEqual(1);
  await page.screenshot({ path: testInfo.outputPath("admin-plugins-mobile.png"), fullPage: true });
});
