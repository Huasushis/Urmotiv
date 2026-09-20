import { expect, test } from "@playwright/test";

test("导入相对图片通过当前题目附件读取，失败时不请求外部资源", async ({ page }, testInfo) => {
  await page.goto("/demo-login");
  await page.getByRole("button", { name: /投稿人/ }).click();
  await expect(page).toHaveURL(/\/problems$/);
  const origin = "http://127.0.0.1:5173";
  const created = await page.request.post("/api/v1/problems", { headers: { origin }, data: {
    title: "合成导入图片检查", type: "traditional", tagIds: ["catalog.tag.02.09"],
    content: { basicStatement: "合成题意", basicSolution: "合成解答", statement: "![合成图](./assets/%E7%A4%BA%E6%84%8F%E5%9B%BE.png)" }, externalReviewEnabled: false
  } });
  expect(created.ok()).toBe(true);
  const problem = await created.json();
  const parameters = new URLSearchParams({ expectedRevision: String(problem.revision), category: "statement_image", logicalPath: "assets/示意图.png", originalName: "示意图.png", mediaType: "image/png" });
  const uploaded = await page.request.put(`/api/v1/problems/${problem.id}/files?${parameters}`, {
    headers: { origin, "content-type": "application/octet-stream" },
    data: Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64")
  });
  expect(uploaded.ok()).toBe(true);
  const open = async () => {
    await page.goto(`/problems/${problem.id}?tab=statement`);
    const editor = page.locator('section[aria-label="题目描述"]');
    if (testInfo.project.name === "mobile-chromium") await editor.getByRole("button", { name: "预览", exact: true }).click();
    return editor;
  };
  const editor = await open();
  const image = editor.locator(".markdown-body img");
  await expect(image).toHaveAttribute("src", new RegExp(`/api/v1/problems/${problem.id}/files/[0-9a-f-]+$`));
  await expect.poll(() => image.evaluate((element: HTMLImageElement) => element.naturalWidth)).toBe(1);
  expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(1);
  await page.evaluate(() => scrollTo(0, 0));
  await page.screenshot({ path: testInfo.outputPath("imported-image.png"), fullPage: true });
  await page.route(`**/api/v1/problems/${problem.id}/files`, route => route.fulfill({ status: 404, json: { error: { code: "NOT_FOUND", message: "未找到请求的资源。", requestId: "00000000-0000-4000-8000-000000000001" } } }));
  const unavailable = await open();
  await expect(unavailable).toContainText("题面图片不可用");
  await expect(unavailable.locator(".markdown-body img")).toHaveCount(0);
});
