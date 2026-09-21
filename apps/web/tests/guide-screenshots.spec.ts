import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { expect, test } from "@playwright/test";
test("指南插图只取本机合成演示站点，四类入口可操作", async ({ page }, info) => {
  await page.goto("/demo-login");
  await page.getByRole("button", { name: /系统管理员/ }).click();
  await expect(page).toHaveURL(/\/problems$/);
  const shots = [
    ["author", "/problems/new", "新建题目"],
    ["member", "/reviews", "待审题目"],
    ["leader", "/contests", "组题"],
    ["admin", "/admin/announcements", "公告管理"],
  ] as const;
  const directory = resolve("public/help-assets");
  if (
    process.env.UPDATE_GUIDE_IMAGES === "1" &&
    info.project.name === "desktop-chromium"
  )
    await mkdir(directory, { recursive: true });
  for (const [name, url] of shots) {
    await page.goto(url);
    await expect(page.locator("h1").first()).toBeVisible();
    await expect(page.getByText("正在加载页面…")).toHaveCount(0);
    if (name === "author") {
      await page
        .getByRole("textbox", { name: "题目名称", exact: true })
        .fill("示例：把一个想法整理成题目");
    }
    if (name === "admin")
      await page.getByRole("button", { name: "发布公告", exact: true }).click();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth - innerWidth,
      ),
    ).toBeLessThanOrEqual(1);
    await page.screenshot({ path: info.outputPath(name + ".png") });
    if (
      process.env.UPDATE_GUIDE_IMAGES === "1" &&
      info.project.name === "desktop-chromium"
    )
      await page.screenshot({
        path: resolve(directory, name + ".jpg"),
        type: "jpeg",
        quality: 82,
      });
  }
});
