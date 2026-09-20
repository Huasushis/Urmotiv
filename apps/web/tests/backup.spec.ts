import { expect, test } from "@playwright/test";
import type { BackupSettingsView } from "@urmotiv/contracts";

test("完整备份设置、失败反馈、恢复确认在桌面和手机可用", async ({
  page,
}, testInfo) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.route("**/api/v1/session", (route) =>
    route.fulfill({
      json: {
        user: {
          id: "0",
          nickname: "root",
          accountType: "human",
          isRoot: true,
          roles: ["root"],
          permissions: ["system.manage"],
          canManageReviewPolicy: true,
          canManagePlugins: true,
          canManageTags: true,
          canManageSystem: true,
        },
        auth: {
          emailEnabled: true,
          emailRegistrationEnabled: false,
          ustcOAuthEnabled: false,
          casEnabled: false,
          demoEnabled: false,
        },
      },
    }),
  );
  let settings: BackupSettingsView = {
    available: true,
    revision: 1,
    enabled: false,
    address: "https://backup.example.test/dav",
    username: "synthetic",
    passwordConfigured: true,
    encryptionPasswordConfigured: false,
    intervalHours: null,
    verifiedAt: null,
    lastAttemptAt: null,
    lastSuccessAt: null,
    job: null,
  };
  let fail = true;
  let restoreCalls = 0;
  await page.route("**/api/v1/admin/backups", (route) =>
    route.fulfill({ json: settings }),
  );
  await page.route("**/api/v1/admin/backups/settings", (route) => {
    if (fail)
      return route.fulfill({
        status: 400,
        json: {
          error: {
            code: "WEBDAV_AUTH_FAILED",
            message: "WebDAV 登录失败或没有读写权限。",
          },
        },
      });
    const input = route.request().postDataJSON();
    expect(input.encryptionPassword).toBe("Synthetic-backup-password");
    settings = {
      ...settings,
      revision: 2,
      enabled: input.enabled,
      encryptionPasswordConfigured: true,
      verifiedAt: "2026-09-20T10:00:00.000Z",
    };
    return route.fulfill({ json: settings });
  });
  await page.route("**/api/v1/admin/backups/files", (route) =>
    route.fulfill({
      json: {
        items: [
          {
            name: "20260920_manual_test.urb",
            bytes: 123456,
            modifiedAt: "2026-09-20T10:00:00.000Z",
          },
        ],
      },
    }),
  );
  await page.route("**/api/v1/admin/backups/restore", (route) => {
    restoreCalls++;
    expect(route.request().postDataJSON()).toMatchObject({
      confirmation: "恢复整个站点",
      name: "20260920_manual_test.urb",
    });
    return route.fulfill({
      status: 400,
      json: {
        error: { code: "INVALID_CREDENTIALS", message: "当前密码不正确。" },
      },
    });
  });
  await page.goto("/admin/backups");
  await expect(
    page.getByRole("heading", { name: "备份与恢复", exact: true }),
  ).toBeVisible();
  await page
    .getByLabel("备份文件密码", { exact: true })
    .fill("Synthetic-backup-password");
  await page.getByLabel("启用备份与恢复").check();
  await page.getByRole("button", { name: "验证连接并保存" }).click();
  await expect(page.getByRole("alert")).toContainText("原配置保持不变");
  expect(settings.revision).toBe(1);
  fail = false;
  await page.getByRole("button", { name: "验证连接并保存" }).click();
  await expect(
    page.getByText("连接验证通过，设置已保存。", { exact: true }),
  ).toBeVisible();
  await expect(page.getByLabel("备份文件密码", { exact: true })).toHaveValue(
    "",
  );
  await page.getByRole("button", { name: "读取远端备份" }).click();
  await page.getByRole("button", { name: "选择恢复" }).click();
  await expect(
    page.getByRole("button", { name: "验证备份并恢复" }),
  ).toBeDisabled();
  await page.getByLabel("这份备份的加密密码").fill("Synthetic-old-password");
  await page.getByLabel("当前 root 登录密码").fill("Synthetic-root-password");
  await page.getByLabel("输入“恢复整个站点”确认").fill("恢复整个站点");
  await page.getByRole("button", { name: "验证备份并恢复" }).click();
  await expect(page.getByRole("alert")).toContainText("当前密码不正确");
  expect(restoreCalls).toBe(1);
  await page.getByRole("button", { name: "取消", exact: true }).click();
  await page.evaluate(() => scrollTo(0, 0));
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth - innerWidth,
    ),
  ).toBeLessThanOrEqual(1);
  await page.screenshot({
    path: testInfo.outputPath("backup-settings.png"),
    fullPage: true,
  });
  expect(errors).toEqual([]);
});
