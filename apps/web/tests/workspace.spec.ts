import { expect, test, type Page } from "@playwright/test";

const localOrigin = "http://127.0.0.1:5173";

async function loginAsAuthor(page: Page) {
  await page.goto("/demo-login");
  await page.getByRole("button", { name: /投稿人/ }).click();
  await expect(page).toHaveURL(/\/problems$/);
}

async function loginAs(page: Page, name: RegExp) {
  await page.goto("/demo-login");
  await page.getByRole("button", { name }).click();
  await expect(page).toHaveURL(/\/problems$/);
  const response = await page.request.get("/api/v1/session");
  expect(response.ok()).toBe(true);
  return (await response.json()) as { user: { id: string } };
}

async function postJson(page: Page, path: string, data: unknown) {
  const response = await page.request.post(path, {
    data,
    headers: { Origin: localOrigin }
  });
  const body = await response.text();
  expect(response.ok(), `${path}: ${body}`).toBe(true);
  return JSON.parse(body) as Record<string, unknown>;
}

test("邮箱验证链接在桌面和手机上显示可操作的确认页", async ({ page }) => {
  await page.goto("/#/verify-email?token=uve_abcdefghijklmnopqrstuvwxyz0123456789");
  await expect(page.getByRole("heading", { name: "确认邮箱后再登录" })).toBeVisible();
  await expect(page.getByRole("button", { name: "确认邮箱" })).toBeVisible();
});

test("投稿人可以创建带 Markdown 内容的草稿并看到六个工作区标签", async ({ page }, testInfo) => {
  await loginAsAuthor(page);
  await page.getByRole("link", { name: "新建题目" }).click();
  await page.getByLabel("题目名称").fill("页面联调示例题");
  await page.locator(".tag-choice").first().click();
  await page.locator('section[aria-label="基础题面"] textarea').fill("求 $1+1$ 的值。");
  await page.locator('section[aria-label="基础题解"] textarea').fill("直接计算即可。");
  await page.getByRole("button", { name: "创建草稿" }).click();

  await expect(page.getByRole("heading", { name: "页面联调示例题" })).toBeVisible();
  for (const label of ["概要", "题面", "样例与约束", "数据与评测", "题解与资料", "审核记录"]) {
    await expect(page.getByRole("button", { name: label })).toBeVisible();
  }
  await page.screenshot({ path: testInfo.outputPath("problem-workspace.png"), fullPage: true });
});

test("手机视口中的 Markdown 编辑器在编辑和预览间切换", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "mobile-chromium", "只检查手机布局");
  await loginAsAuthor(page);
  await page.goto("/problems/new");
  const editor = page.locator('section[aria-label="基础题面"]');
  await editor.locator("textarea").fill("## 小标题\n\n公式 $a+b$。");
  await editor.getByRole("button", { name: "预览" }).click();
  await expect(editor.getByRole("heading", { name: "小标题" })).toBeVisible();
  await expect(editor.locator(".katex")).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("mobile-markdown-preview.png"), fullPage: true });
});

test("组长把审核通过的固定题目版本加入组题方案", async ({ page }, testInfo) => {
  const authorSession = await loginAs(page, /投稿人/);
  const problem = await postJson(page, "/api/v1/problems", {
    title: `组题联调题-${testInfo.project.name}-${Date.now()}`,
    type: "traditional",
    tagIds: ["algorithm.implementation"],
    content: {
      basicStatement: "给定两个整数，输出它们的和。",
      basicSolution: "直接相加。",
      background: "",
      statement: "",
      inputFormat: "",
      outputFormat: "",
      constraints: "",
      solution: "",
      hints: ""
    },
    samples: []
  });
  const problemId = problem.id as string;
  await page.request.get(`/api/v1/problems/${problemId}`);
  const submitted = await postJson(page, `/api/v1/problems/${problemId}/submit`, {
    expectedRevision: problem.revision
  });

  await loginAs(page, /审题人/);
  await postJson(page, `/api/v1/problems/${problemId}/reviews`, {
    verdict: "approve",
    codeforcesDifficulty: 1200,
    qualityLevel: 4,
    thinkingLevel: 2,
    codingLevel: 2,
    tagIds: [],
    improvements: "题意和解法完整。",
    privateNote: "",
    expectedRound: submitted.reviewRound
  });

  await loginAs(page, /组长/);
  await postJson(page, `/api/v1/problems/${problemId}/reviews`, {
    verdict: "approve",
    codeforcesDifficulty: 1200,
    qualityLevel: 4,
    thinkingLevel: 2,
    codingLevel: 2,
    tagIds: [],
    improvements: "同意通过。",
    privateNote: "",
    expectedRound: submitted.reviewRound
  });

  await page.goto("/contests");
  await page.getByRole("button", { name: "新建方案" }).click();
  const contestTitle = `校赛方案-${testInfo.project.name}`;
  await page.getByLabel("方案名称").fill(contestTitle);
  await page.getByLabel("参与者账号编号").fill(authorSession.user.id);
  const problemRow = page.locator(".contest-problem-table tbody tr").first();
  await problemRow.locator('input:not([type="number"])').fill(problemId);
  await page.getByRole("button", { name: "创建方案" }).click();

  await expect(page.getByRole("heading", { name: contestTitle })).toBeVisible();
  await expect(page.getByText("第 3 版")).toBeVisible();
  await expect(page.getByText("1 人", { exact: true })).toBeVisible();
  await expect(page.getByText(authorSession.user.id, { exact: true })).toBeVisible();
  await expect(page.locator(".contest-detail-table td").nth(4)).toBeVisible();
  const pageFitsViewport = await page.evaluate(
    () => document.documentElement.scrollWidth <= document.documentElement.clientWidth
  );
  expect(pageFitsViewport).toBe(true);
  await page.screenshot({ path: testInfo.outputPath("contest-workbench.png"), fullPage: true });
});
