import { expect, test, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";

const mailSuffix = (): string => randomUUID().replaceAll("-", "").slice(0, 16);

async function loginAsLeader(page: Page): Promise<void> {
  await page.goto("/demo-login");
  await page.getByRole("button", { name: "组长" }).click();
  await expect(page).toHaveURL(/\/problems$/);
}

test.describe("批量创建账号", () => {
  test("通过导航进入页面并创建合成多行账号，只反馈数量", async ({ page }, testInfo) => {
    await loginAsLeader(page);
    if (testInfo.project.name === "mobile-chromium") {
      await page.getByRole("button", { name: "打开导航" }).click();
    }
    await page.getByRole("link", { name: "管理", exact: true }).click();
    await page.locator(".admin-dashboard-grid").getByRole("link", {
      name: "批量创建账号",
      exact: true
    }).click();
    await expect(page).toHaveURL(/\/admin\/accounts$/);
    await expect(page.getByRole("heading", { name: "批量创建账号" })).toBeVisible();

    const unique = mailSuffix();
    const passwordA = "SyntheticBrowserPass-A-123";
    const passwordB = "SyntheticBrowserPass-B-456";
    const input = [
      `PB-SYNTH-${unique}\t浏览器甲\tbrowser-a-${unique}@example.test\t${passwordA}`,
      `PB-SYNTH-${unique}2\t浏览器乙\tbrowser-b-${unique}@example.test\t${passwordB}`
    ].join("\n");
    const textarea = page.getByTestId("batch-account-input");
    await textarea.fill(input);
    await page.getByRole("button", { name: "创建账号" }).click();

    await expect(page.getByRole("status")).toContainText("已创建 2 个账号");
    await expect(textarea).toHaveValue("");
    await expect(page.locator("body")).not.toContainText(passwordA);
    await expect(page.locator("body")).not.toContainText(passwordB);
  });

  test("混合无效行整批失败并保留输入，不回显账号数据", async ({ page }) => {
    await loginAsLeader(page);
    await page.goto("/admin/accounts");
    const unique = mailSuffix();
    const secret = "SyntheticBrowserPass-C-789";
    const input = [
      `PB-SYNTH-${unique}3\t浏览器丙\tbrowser-c-${unique}@example.test\t${secret}`,
      `PB-SYNTH-${unique}4\t浏览器丁\tbad-email\tshort`
    ].join("\n");
    const textarea = page.getByTestId("batch-account-input");
    await textarea.fill(input);
    await page.getByRole("button", { name: "创建账号" }).click();

    const feedback = page.getByRole("alert");
    await expect(feedback).toContainText("第 2 行");
    await expect(textarea).toHaveValue(input);
    await expect(feedback).not.toContainText(`browser-c-${unique}@example.test`);
    await expect(feedback).not.toContainText(secret);
  });
});
