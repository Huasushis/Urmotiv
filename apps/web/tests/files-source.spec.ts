import { expect, test } from "@playwright/test";
test("作者编辑源码、切换语言、刷新读取与删除误传附件", async ({ page }, info) => {
  await page.goto("/demo-login");
  await page.getByRole("button", { name: /投稿人/ }).click();
  await expect(page).toHaveURL(/\/problems$/);
  const tags = await page.request.get("/api/v1/tags").then((r) => r.json());
  const draft = await page.request
    .post("/api/v1/problems", {
      headers: { origin: "http://localhost:5173" },
      data: {
        title: "合成源码编辑验收",
        type: "traditional",
        tagIds: [tags.items[0].id],
        externalReviewEnabled: false,
        content: {
          basicStatement: "输出零。",
          basicSolution: "输出零。",
          background: "",
          statement: "",
          inputFormat: "",
          outputFormat: "",
          constraints: "",
          solution: "",
          hints: "",
        },
      },
    })
    .then((r) => r.json());
  await page.goto(`/problems/${draft.id}?tab=solution`);
  const panel = page.getByRole("region", { name: "标准程序", exact: true });
  await panel
    .getByRole("textbox", { name: "标准程序（std）", exact: true })
    .fill("int main() { return 0; }\n");
  await panel.getByRole("button", { name: "保存标准程序", exact: true }).click();
  await expect(panel.getByText("标准程序已保存。", { exact: true })).toBeVisible();
  await page.reload();
  await expect(panel.getByRole("textbox", { name: "标准程序（std）", exact: true })).toHaveValue(
    "int main() { return 0; }\n",
  );
  await panel.getByRole("combobox", { name: "程序语言", exact: true }).selectOption("python");
  await panel
    .getByRole("textbox", { name: "标准程序（std）", exact: true })
    .fill("for i in range(3):\n    print(i)\n");
  await panel.getByRole("button", { name: "保存标准程序", exact: true }).click();
  await expect(panel.getByText("标准程序已保存。", { exact: true })).toBeVisible();
  await panel.getByRole("button", { name: "高亮预览", exact: true }).click();
  await expect(panel.locator(".hljs-keyword").first()).toBeVisible();
  const files = await page.request.get(`/api/v1/problems/${draft.id}/files`).then((r) => r.json());
  expect(files.items).toHaveLength(1);
  expect(files.items[0].originalName).toBe("std.py");
  expect(files.items[0].logicalPath).toMatch(/\.py$/);
  await panel.scrollIntoViewIfNeeded();
  await page.screenshot({ path: info.outputPath("source-editor.png") });
  const materials = page.getByRole("region", { name: "程序与附件", exact: true });
  await materials
    .locator("input[type=file]")
    .first()
    .setInputFiles({
      name: "wrong.txt",
      mimeType: "text/plain",
      buffer: Buffer.from("synthetic attachment"),
    });
  const remove = materials.getByRole("button", { name: "删除 wrong.txt", exact: true });
  await expect(remove).toBeVisible();
  page.once("dialog", (dialog) => dialog.dismiss());
  await remove.click();
  await expect(remove).toBeVisible();
  page.once("dialog", (dialog) => dialog.accept());
  await remove.click();
  await expect(remove).toHaveCount(0);
  page.once("dialog", (dialog) => dialog.accept());
  await materials.getByRole("button", { name: "删除 std.py", exact: true }).click();
  await expect(materials.getByRole("button", { name: "删除 std.py", exact: true })).toHaveCount(0);
  await expect(panel.getByRole("textbox", { name: "标准程序（std）", exact: true })).toHaveValue(
    "",
  );
  await page.reload();
  expect(
    (await page.request.get(`/api/v1/problems/${draft.id}/files`).then((r) => r.json())).items,
  ).toHaveLength(0);
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth - innerWidth),
  ).toBeLessThanOrEqual(1);
});

test("AI 提取 std 独立保存，上传失败重试不重复建题", async ({ page }) => {
  await page.goto("/demo-login");
  await page.getByRole("button", { name: /投稿人/ }).click();
  await expect(page).toHaveURL(/\/problems$/);
  const tags = await page.request.get("/api/v1/tags").then((r) => r.json());
  await page.route("**/api/v1/ai-drafts/availability", (route) =>
    route.fulfill({ json: { available: true } }),
  );
  const id = "55555555-5555-4555-8555-555555555555";
  await page.route("**/api/v1/ai-drafts", (route) =>
    route.fulfill({ json: { id, status: "running" } }),
  );
  await page.route("**/api/v1/ai-drafts/" + id, (route) =>
    route.fulfill({
      json: {
        id,
        status: "complete",
        result: {
          title: "合成 AI 标程",
          content: {
            basicStatement: "输出零。",
            basicSolution: "直接输出。",
            background: "",
            statement: "",
            inputFormat: "",
            outputFormat: "",
            constraints: "",
            solution: "说明",
            hints: "",
          },
          samples: [],
          standardSolution: "```python\nprint(0)\n```",
          unclassified: "",
        },
      },
    }),
  );
  let creates = 0,
    uploads = 0;
  page.on("request", (request) => {
    if (request.method() === "POST" && new URL(request.url()).pathname === "/api/v1/problems")
      creates++;
  });
  await page.route("**/api/v1/problems/*/files?**", async (route) => {
    uploads++;
    if (uploads === 1)
      await route.fulfill({ status: 503, json: { error: { message: "合成临时存储故障" } } });
    else await route.continue();
  });
  await page.goto("/problems/new");
  await page.getByText("AI 快速建题：粘贴题面、题解和标程", { exact: true }).click();
  await page.getByRole("textbox", { name: "整段投稿材料" }).fill("合成材料");
  await page.getByRole("button", { name: "自动识别", exact: true }).click();
  await page.getByRole("button", { name: "确认并填入草稿表单", exact: true }).click();
  await expect(page.getByRole("textbox", { name: "标准程序（std）", exact: true })).toHaveValue(
    "print(0)",
  );
  await expect(page.getByRole("combobox", { name: "程序语言", exact: true })).toHaveValue("python");
  // 用正式标签控件填写知识点。
  const picker = page.locator(".form-grid").getByRole("button", { name: /选择知识点/ });
  await picker.click();
  await page.locator(".form-grid .tag-picker-group").first().locator("summary").click();
  await page.locator(".form-grid .tag-choice").first().click();
  await page.getByRole("button", { name: "创建草稿", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("草稿已经建立");
  await page.getByRole("button", { name: "重试保存标准程序", exact: true }).click();
  await expect(page).toHaveURL(/\/problems\/\d+$/);
  expect(creates).toBe(1);
  expect(uploads).toBe(2);
  const problemId = new URL(page.url()).pathname.split("/").pop();
  const problem = await page.request.get(`/api/v1/problems/${problemId}`).then((r) => r.json());
  expect(problem.content.solution).toBe("说明");
  expect(problem.content.solution).not.toContain("print");
  const files = await page.request.get(`/api/v1/problems/${problemId}/files`).then((r) => r.json());
  expect(files.items[0].category).toBe("standard_solution");
  expect(files.items[0].originalName).toBe("std.py");
});
