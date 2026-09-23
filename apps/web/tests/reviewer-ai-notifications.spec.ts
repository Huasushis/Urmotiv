import { expect, test } from "@playwright/test";
test("邮件分类偏好真实保存，审题榜排序和待审筛选，窄屏无溢出", async ({
  page,
}, info) => {
  await page.goto("/demo-login");
  await page.getByRole("button", { name: /审题人/ }).click();
  await expect(page).toHaveURL(/\/problems$/);
  await page.goto("/profile");
  const section = page.getByRole("region", { name: "邮件通知" });
  const check = section.getByLabel("题目审核通过", { exact: true });
  await expect(check).toBeVisible();
  const before = await check.isChecked();
  await check.click();
  await expect(section.getByRole("status")).toHaveText("通知设置已保存。");
  await expect(check).toBeChecked({ checked: !before });
  await page.reload();
  await expect(check).toBeChecked({ checked: !before });
  await check.click();
  await expect(section.getByRole("status")).toHaveText("通知设置已保存。");
  await page.goto("/reviews?reviewed=unreviewed");
  await expect(page.getByRole("combobox", { name: "我的审核" })).toHaveValue(
    "unreviewed",
  );
  await expect(page.getByText(/我已审/).first()).toBeVisible();
  for (const status of ["", "approved", "rejected"]) {
    await page.goto("/problems" + (status ? "?status=" + status : ""));
    await expect(page.locator(".review-counts").first()).toBeVisible();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth - innerWidth,
      ),
    ).toBeLessThanOrEqual(1);
  }
  await page.goto("/leaderboard?kind=reviewers");
  await expect(page.getByRole("heading", { name: "审题人榜" })).toBeVisible();
  await page
    .getByRole("combobox", { name: "排序方式" })
    .selectOption("accuracy");
  await expect(page).toHaveURL(/sort=accuracy/);
  await expect(page.getByText(/只比较当前轮次/)).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth - innerWidth,
    ),
  ).toBeLessThanOrEqual(1);
  await page.screenshot({ path: info.outputPath("reviewer-ranking.png") });
});
test("AI 提取预览保留代码和未分类原文，确认后创建可编辑草稿", async ({
  page,
}, info) => {
  const source =
    "合成 AI 题目\n原文题意 \\(a_i^2\\)\n原文解法\n```cpp\nint main() {}\n```\n剩余资料";
  const result = {
    title: "合成 AI 题目 " + info.project.name,
    content: {
      basicStatement: "原文题意 \\(a_i^2\\)",
      basicSolution: "原文解法",
      background: "",
      statement: "",
      inputFormat: "",
      outputFormat: "",
      constraints: "",
      solution: "",
      hints: "",
    },
    samples: [],
    standardSolution: "```cpp\nint main() {}\n```",
    unclassified: "剩余资料",
  };
  const id = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  await page.route("**/api/v1/ai-drafts/availability", (route) =>
    route.fulfill({ json: { available: true } }),
  );
  await page.route("**/api/v1/ai-drafts", async (route) => {
    expect(route.request().postDataJSON()).toEqual({ text: source });
    await route.fulfill({ status: 202, json: { id, status: "running" } });
  });
  await page.route("**/api/v1/ai-drafts/" + id, (route) =>
    route.fulfill({ json: { id, status: "complete", result } }),
  );
  await page.goto("/demo-login");
  await page.getByRole("button", { name: /投稿人/ }).click();
  await expect(page).toHaveURL(/\/problems$/);
  await page.goto("/problems/new");
  await page
    .getByText("AI 快速建题：粘贴题面、题解和标程", { exact: true })
    .click();
  await page.getByLabel("整段投稿材料").fill(source);
  await page.getByRole("button", { name: "自动识别", exact: true }).click();
  await expect(
    page.getByText("尚未分类的原文（确认后保留在正式题解中，避免泄露解法）"),
  ).toBeVisible();
  await page.screenshot({ path: info.outputPath("ai-preview.png") });
  const preview = page.locator(".ai-draft-import");
  await preview.getByRole("button", { name: "选择知识点" }).click();
  await preview.locator(".tag-picker-group").first().locator("summary").click();
  await preview.locator(".tag-choice").first().click();
  await preview
    .getByRole("button", { name: "确认并创建草稿", exact: true })
    .click();
  await expect(page).toHaveURL(/\/problems\/\d+$/);
  const problem = await page.request
    .get("/api/v1/problems/" + page.url().split("/").at(-1))
    .then((r) => r.json());
  expect(problem.status).toBe("draft");
  expect(problem.content.basicStatement).toBe(result.content.basicStatement);
  expect(problem.content.solution).not.toContain(result.standardSolution);
  const files=await page.request.get(`/api/v1/problems/${problem.id}/files`).then(r=>r.json());
  expect(files.items).toEqual(expect.arrayContaining([expect.objectContaining({category:'standard_solution',originalName:'std.cpp'})]));
  expect(problem.content.solution).toContain("剩余资料");
  expect(problem.content.hints).toBe("");
});
