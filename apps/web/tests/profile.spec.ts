import { expect, test, type Page } from "@playwright/test";

const tinyPng = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64"
);

async function loginAsLeader(page: Page): Promise<void> {
  await page.goto("/demo-login");
  await page.getByRole("button", { name: /组长/ }).click();
  await expect(page).toHaveURL(/\/problems$/);
}

test("组长可以查看资料并保存昵称与 QQ 号码", async ({ page }, testInfo) => {
  await loginAsLeader(page);
  await page.goto("/profile");
  await expect(page.getByRole("heading", { name: "账号与头像" })).toBeVisible();

  const nicknameInput = page.locator('input[maxlength="120"]');
  const qqInput = page.locator('input[placeholder*="5–11"]');
  await expect(nicknameInput).toBeVisible();
  await expect(qqInput).toBeVisible();
  await expect(page.locator('input[readonly]')).toBeDisabled();

  await nicknameInput.fill("端到端测评组长");
  await qqInput.fill("123456789");
  await page.getByRole("button", { name: "保存资料" }).click();
  await expect(page.getByTestId("save-success")).toContainText("资料已保存");

  const qqSourceButton = page.getByTestId("avatar-source-qq");
  await expect(qqSourceButton).toBeEnabled();
  await qqSourceButton.click();
  await expect(qqSourceButton).toHaveAttribute("aria-checked", "true");
  await page.screenshot({ path: testInfo.outputPath("profile-saved.png"), fullPage: true });
});

test("上传头像后可通过来源按钮切换，删除后回到默认头像", async ({ page }) => {
  await loginAsLeader(page);
  await page.goto("/profile");
  await expect(page.getByRole("heading", { name: "账号与头像" })).toBeVisible();

  await page.locator('input[type="file"]').setInputFiles({
    name: "avatar.png",
    mimeType: "image/png",
    buffer: tinyPng
  });
  const uploadedButton = page.getByTestId("avatar-source-uploaded");
  await expect(uploadedButton).toHaveAttribute("aria-checked", "true");
  await expect(page.locator(".avatar-preview-frame img")).toHaveAttribute(
    "src",
    /\/api\/v1\/users\/[^/]+\/avatar/
  );

  await page.getByTestId("avatar-source-none").click();
  await expect(page.locator(".avatar-preview-frame img")).toHaveCount(0);
  await expect(page.getByTestId("avatar-initial")).toBeVisible();
  await expect(uploadedButton).toBeDisabled();
});

test("非法图片格式展示客户端错误，不会发起上传", async ({ page }) => {
  await loginAsLeader(page);
  await page.goto("/profile");
  await expect(page.getByRole("heading", { name: "账号与头像" })).toBeVisible();

  await page.locator('input[type="file"]').setInputFiles({
    name: "avatar.pdf",
    mimeType: "application/pdf",
    buffer: Buffer.from("%PDF-1.4")
  });
  await expect(page.getByTestId("avatar-upload-error")).toContainText("只支持");
  await expect(page.getByTestId("avatar-source-uploaded")).toBeDisabled();
});

test("未登录访问个人资料页被重定向到登录", async ({ page }) => {
  await page.goto("/profile");
  await expect(page).toHaveURL(/\/login/);
});

test("手机视口个人资料页无横向溢出，表单可操作", async ({ page }, testInfo) => {
  const mobile = testInfo.project.name === "mobile-chromium";
  await loginAsLeader(page);
  await page.goto("/profile");
  await expect(page.getByRole("heading", { name: "账号与头像" })).toBeVisible();

  if (mobile) {
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth
    );
    expect(overflow).toBeLessThanOrEqual(0);
  }

  await page.locator('input[maxlength="120"]').fill("移动端昵称");
  await page.getByRole("button", { name: "保存资料" }).click();
  await expect(page.getByTestId("save-success")).toContainText("资料已保存");

  const uploadButtonBox = await page.getByTestId("avatar-upload-button").boundingBox();
  expect(uploadButtonBox?.height ?? 0).toBeGreaterThanOrEqual(mobile ? 44 : 32);
  await page.screenshot({ path: testInfo.outputPath("profile-mobile.png"), fullPage: true });
});