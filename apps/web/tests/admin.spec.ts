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
  version: "0.4.0",
  apiVersion: "1",
  source: "server-only-source",
  state: "disabled",
  failureCode: null,
  settings: {
    baseUrl: "http://127.0.0.1:8730",
    timeoutMs: 30000,
    privateContentAuthorized: false,
    failureBehavior: "block",
    minimumSimilarityToShow: 0.3,
    cacheMinutes: 1440,
    embeddingProvider: {
      baseUrl: "https://emb.example.com/v1",
      model: "bge-m3",
      dimension: 1024
    }
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
      },
      privateContentAuthorized: {
        type: "boolean",
        default: false,
        title: "允许将题面发送给 Anklang",
        description: "Anklang 查重和索引必须接收题目名称与基础题面。"
      },
      embeddingProvider: {
        type: "object",
        required: ["baseUrl", "model", "dimension"],
        title: "嵌入提供方",
        properties: {
          baseUrl: {
            type: "string",
            format: "uri",
            title: "嵌入提供方地址"
          },
          model: {
            type: "string",
            minLength: 1,
            maxLength: 200,
            title: "嵌入模型名称"
          },
          dimension: {
            type: "integer",
            minimum: 1,
            maximum: 4096,
            title: "嵌入向量维度"
          }
        }
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
      configured: true
    },
    {
      name: "embeddingApiKey",
      label: "嵌入提供方 API 密钥",
      description: "Anklang 调用嵌入模型提供方时使用；与访问令牌用途不同。",
      configured: true
    }
  ],
  requiresRestart: false
};

const tagCatalog = {
  version: 12,
  items: [
    {
      id: "category.graph",
      itemKind: "category",
      parentId: null,
      name: "图论",
      description: "图上的算法",
      sortOrder: 1,
      active: true
    },
    {
      id: "tag.shortest-path",
      itemKind: "tag",
      parentId: "category.graph",
      name: "最短路",
      group: "图论",
      description: "求带权图中的最小距离",
      normalizedName: "最短路",
      sortOrder: 1,
      active: true,
      category: { id: "category.graph", name: "图论" },
      aliases: ["Shortest Path"]
    },
    {
      id: "tag.graph-traversal",
      itemKind: "tag",
      parentId: "category.graph",
      name: "图遍历",
      group: "图论",
      description: "遍历图上的节点和边",
      normalizedName: "图遍历",
      sortOrder: 2,
      active: true,
      category: { id: "category.graph", name: "图论" },
      aliases: []
    }
  ],
  aliases: [
    {
      id: "33333333-3333-4333-8333-333333333333",
      tagId: "tag.shortest-path",
      name: "最短路径",
      normalizedName: "最短路径"
    }
  ]
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
  await page.goto("/admin/review");
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
        settings: {
          ...plugin.settings,
          timeoutMs: 45000,
          embeddingProvider: {
            baseUrl: "https://emb2.example.com/v1",
            model: "bge-large",
            dimension: 2048
          }
        },
        settingsRevision: 5,
        secrets: plugin.secrets.map((item) => ({ ...item }))
      }
    });
  });

  await loginAs(page, /系统管理员/);
  await page.goto("/admin/plugins");
  await expect(page.getByRole("heading", { name: "原题检索" })).toBeVisible();
  const timeout = page.getByLabel("最长等待时间（毫秒）");
  const providerBaseUrl = page.getByLabel(/嵌入提供方地址/);
  const providerModel = page.getByLabel(/嵌入模型名称/);
  const providerDimension = page.getByLabel(/嵌入向量维度/);
  const secret = page.getByLabel(/^访问令牌/);
  const embeddingKey = page.getByLabel(/^嵌入提供方 API 密钥/);
  await expect(providerBaseUrl).toHaveValue("https://emb.example.com/v1");
  await expect(providerModel).toHaveValue("bge-m3");
  await expect(providerDimension).toHaveValue("1024");
  const privateContentAuthorization = page.getByRole("checkbox", { name: /允许将题面发送给 Anklang/ });
  await expect(privateContentAuthorization).not.toBeChecked();
  const privateContentAuthorizationBox = await privateContentAuthorization.boundingBox();
  expect(privateContentAuthorizationBox?.width ?? 0).toBeLessThanOrEqual(20);
  expect(privateContentAuthorizationBox?.height ?? 0).toBeLessThanOrEqual(20);
  await timeout.fill("45000");
  await providerBaseUrl.fill("https://emb2.example.com/v1");
  await providerModel.fill("bge-large");
  await providerDimension.fill("2048");
  await secret.fill("temporary-test-key");
  await embeddingKey.fill("temporary-embedding-key");
  await page.getByRole("button", { name: "保存插件设置" }).click();

  await expect(page.getByText("插件设置已保存")).toBeVisible();
  await expect(secret).toHaveValue("");
  await expect(embeddingKey).toHaveValue("");
  await expect(page.getByText("已配置")).toHaveCount(2);
  await expect(page.getByText(/末尾四个字符/)).toHaveCount(0);
  expect(submittedBody).toEqual({
    expectedRevision: 4,
    settings: {
      ...plugin.settings,
      timeoutMs: 45000,
      embeddingProvider: {
        baseUrl: "https://emb2.example.com/v1",
        model: "bge-large",
        dimension: 2048
      }
    },
    secrets: {
      serviceToken: "temporary-test-key",
      embeddingApiKey: "temporary-embedding-key"
    }
  });
  await expect(page.getByText(plugin.source)).toHaveCount(0);
  await page.screenshot({ path: testInfo.outputPath("admin-plugin-desktop.png"), fullPage: true });
});

const generalSettings = {
  settings: {
    emailLoginEnabled: true,
    emailRegistrationEnabled: false,
    publicRegistrationEnabled: false,
    publicSiteUrl: "https://urmotiv.example.test",
    smtpConfigured: true,
    smtpHost: "smtp.example.test",
    smtpPort: 587,
    smtpSecure: false,
    smtpUsername: "mailer",
    smtpFromEmail: "noreply@example.test",
    smtpFromName: "Urmotiv",
    smtpPasswordConfigured: true,
    secureCookies: true,
    loopbackInsecureCookies: false,
    webOrigins: ["https://urmotiv.example.test"],
    revision: 3
  }
};

test("常规设置按分组排列且复选框保持正常尺寸", async ({ page }, testInfo) => {
  await page.route("**/api/v1/admin/settings", async (route) => {
    await fulfillJson(route, generalSettings);
  });
  await loginAs(page, /系统管理员/);
  await page.goto("/admin/settings");

  await expect(page.getByRole("heading", { name: "常规设置" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "账号注册与登录" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "SMTP 发信" })).toBeVisible();
  const toggles = page.locator(".settings-toggle-row input[type=checkbox]");
  await expect(toggles).toHaveCount(4);
  for (const toggle of await toggles.all()) {
    const box = await toggle.boundingBox();
    expect(box?.width ?? 0).toBeLessThanOrEqual(20);
    expect(box?.height ?? 0).toBeLessThanOrEqual(20);
  }
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth
  );
  expect(overflow).toBeLessThanOrEqual(1);
  if (testInfo.project.name === "mobile-chromium") {
    await expect(page.locator(".admin-mobile-navigation")).toBeVisible();
  } else {
    await expect(page.locator(".admin-sidebar")).toBeVisible();
  }
  await page.screenshot({ path: testInfo.outputPath(`admin-settings-${testInfo.project.name}.png`), fullPage: true });
});

test("服务账号页面可以生成并撤销机器人令牌", async ({ page }, testInfo) => {
  const tokenId = "77777777-7777-4777-8777-777777777777";
  const rawToken = `urv_${"A".repeat(43)}`;
  let items: Array<Record<string, unknown>> = [];
  let accounts: Array<Record<string, unknown>> = [];
  let submitted: Record<string, unknown> | undefined;
  await page.route("**/api/v1/admin/service-accounts", async (route) => {
    if (route.request().method() === "POST") {
      const payload = route.request().postDataJSON() as { nickname: string };
      const item = { id: "901", nickname: payload.nickname, accountType: "robot", enabled: true, tokenConfigured: false };
      accounts = [item];
      await fulfillJson(route, { item }, 201);
      return;
    }
    await fulfillJson(route, { items: accounts.map((account) => ({ ...account, tokenConfigured: items.some((item) => item.revokedAt === null) })) });
  });
  await page.route("**/api/v1/admin/service-accounts/901", async (route) => {
    const payload = route.request().postDataJSON() as { enabled: boolean };
    accounts = accounts.map((account) => ({ ...account, enabled: payload.enabled }));
    await fulfillJson(route, { item: accounts[0] });
  });
  await page.route("**/api/v1/admin/service-accounts/901/tokens**", async (route) => {
    const method = route.request().method();
    if (method === "GET") {
      await fulfillJson(route, { items });
      return;
    }
    if (method === "POST" && route.request().url().endsWith("/tokens")) {
      submitted = route.request().postDataJSON() as Record<string, unknown>;
      const item = {
        id: tokenId,
        name: submitted.name,
        displayPrefix: "urv_AAAAAAAA",
        permissions: submitted.permissions,
        sourceCidrs: submitted.sourceCidrs,
        expiresAt: submitted.expiresAt,
        lastUsedAt: null,
        revokedAt: null,
        createdAt: "2026-08-30T12:00:00.000Z"
      };
      items = [item];
      await fulfillJson(route, { item, token: rawToken });
      return;
    }
    if (method === "DELETE") {
      items = items.map((item) => ({ ...item, revokedAt: "2026-08-30T12:05:00.000Z" }));
      await fulfillJson(route, { item: items[0] });
      return;
    }
    await fulfillJson(route, { error: { message: "测试请求不匹配。" } }, 500);
  });

  await loginAs(page, /系统管理员/);
  await page.goto("/admin/service-accounts");
  await expect(page.getByText("还没有机器人账号，请先在上方创建。")).toBeVisible();
  await page.getByLabel("新机器人名称").fill("审题机器人");
  await page.getByRole("button", { name: "创建", exact: true }).click();
  await expect(page.getByRole("heading", { name: "审题机器人" })).toBeVisible();
  await page.getByLabel("用途名称").fill("浏览器审题令牌");
  await page.getByRole("button", { name: "生成令牌" }).click();

  const secret = page.getByLabel("新机器人令牌");
  await expect(secret).toHaveValue(rawToken);
  expect(submitted?.permissions).toEqual([
    "auth.login",
    "problem.view.all",
    "problem.review",
    "problem.testdata.read"
  ]);
  await page.getByRole("button", { name: "我已保存" }).click();
  await expect(secret).toHaveCount(0);
  await expect(page.getByRole("button", { name: "轮换" })).toBeVisible();

  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "撤销" }).click();
  await expect(page.getByText("已撤销", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "撤销" })).toHaveCount(0);
  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "停用账号" }).click();
  await expect(page.getByRole("button", { name: "重新启用" })).toBeVisible();
  await page.getByRole("button", { name: "重新启用" }).click();
  await expect(page.getByRole("button", { name: "停用账号" })).toBeVisible();
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth
  );
  expect(overflow).toBeLessThanOrEqual(1);
  await page.screenshot({ path: testInfo.outputPath(`admin-service-accounts-${testInfo.project.name}.png`), fullPage: true });
});

test("手机视口中的插件设置没有横向溢出", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "mobile-chromium", "只检查手机布局");
  await page.route("**/api/v1/admin/plugins", async (route) => {
    await fulfillJson(route, { items: [plugin] });
  });

  await loginAs(page, /系统管理员/);
  await page.goto("/admin/plugins");
  await expect(page.getByRole("heading", { name: "原题检索" })).toBeVisible();

  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth
  );
  expect(overflow).toBeLessThanOrEqual(1);
  const mobileNavigation = page.locator(".admin-mobile-navigation");
  await expect(mobileNavigation).toBeVisible();
  await expect(mobileNavigation.locator("summary")).toContainText("插件");
  await expect(page.locator(".admin-sidebar")).toBeHidden();
  const navigationBox = await mobileNavigation.locator("summary").boundingBox();
  expect(navigationBox?.height ?? 0).toBeGreaterThanOrEqual(44);
  await page.screenshot({ path: testInfo.outputPath("admin-plugins-mobile.png"), fullPage: true });
});

test("手机视口中的审核规则没有横向溢出", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "mobile-chromium", "只检查手机布局");
  await page.route("**/api/v1/review-policy", async (route) => {
    await fulfillJson(route, reviewPolicy);
  });

  await loginAs(page, /组长/);
  await page.goto("/admin/review");
  await expect(page.getByRole("heading", { name: "审核规则", level: 1 })).toBeVisible();

  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth
  );
  expect(overflow).toBeLessThanOrEqual(1);
  await page.screenshot({ path: testInfo.outputPath("admin-review-mobile.png"), fullPage: true });
});

test("知识点管理员可以展开分类并查看安全的停用影响汇总", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop-chromium", "完整停用预览流程只需运行一次");
  await page.route("**/api/v1/admin/plugins", async (route) => {
    await fulfillJson(route, { items: [plugin] });
  });
  await page.route("**/api/v1/admin/tag-catalog", async (route) => {
    await fulfillJson(route, tagCatalog);
  });
  await page.route("**/api/v1/admin/tag-catalog/items/tag.shortest-path/deactivation-preview", async (route) => {
    await fulfillJson(route, {
      confirmationId: "44444444-4444-4444-8444-444444444444",
      catalogVersion: 12,
      expiresAt: "2026-08-02T12:00:00.000Z",
      impact: {
        currentProblemCount: 3,
        soleCurrentTagCount: 1,
        historicalRevisionCount: 7,
        reviewOpinionCount: 2,
        childTagCount: 0
      }
    });
  });

  await loginAs(page, /系统管理员/);
  await page.goto("/admin/knowledge");
  await expect(page.getByText("目录版本 12")).toBeVisible();
  await page.getByRole("button", { name: /图论/ }).first().click();
  await page.getByRole("button", { name: "最短路" }).click();
  await expect(page.getByRole("textbox", { name: "别名“最短路径”" })).toHaveValue("最短路径");
  await page.getByRole("button", { name: "预览停用影响" }).click();

  const impact = page.getByLabel("停用影响汇总");
  await expect(impact.getByText("当前题目", { exact: true })).toBeVisible();
  await expect(impact.getByText("历史修订", { exact: true })).toBeVisible();
  await expect(impact.getByText("审题意见", { exact: true })).toBeVisible();
  await expect(impact.getByText("直属子标签", { exact: true })).toBeVisible();
  await expect(impact.getByText(/历史修订和审题意见会保留原引用/)).toBeVisible();
  await expect(page.getByRole("button", { name: /确认停用“最短路”/ })).toBeDisabled();
  await expect(page.getByText(/私密题目甲|private-author-id/)).toHaveCount(0);
  await page.screenshot({ path: testInfo.outputPath("admin-tags-desktop.png"), fullPage: true });
});

test("手机视口中的知识点目录可展开且没有横向溢出", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "mobile-chromium", "只检查手机布局");
  await page.route("**/api/v1/admin/plugins", async (route) => {
    await fulfillJson(route, { items: [plugin] });
  });
  await page.route("**/api/v1/admin/tag-catalog", async (route) => {
    await fulfillJson(route, tagCatalog);
  });

  await loginAs(page, /系统管理员/);
  await page.goto("/admin/knowledge");
  await page.getByRole("button", { name: /图论/ }).first().click();
  await page.getByRole("button", { name: "最短路" }).click();
  await expect(page.getByRole("heading", { name: "最短路" })).toBeVisible();

  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth
  );
  expect(overflow).toBeLessThanOrEqual(1);
  await page.screenshot({ path: testInfo.outputPath("admin-tags-mobile.png"), fullPage: true });
});
