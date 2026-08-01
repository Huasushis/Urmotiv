import { expect, test, type Locator, type Page } from "@playwright/test";

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

async function pasteImage(
  field: Locator,
  file: { name: string; mimeType: string; buffer: Buffer }
) {
  return field.evaluate(
    (element, payload) => {
      if (!(element instanceof HTMLTextAreaElement)) {
        throw new Error("找不到 Markdown 编辑框。");
      }
      element.focus();
      element.setSelectionRange(element.value.length, element.value.length);
      const bytes = Uint8Array.from(atob(payload.base64), (character) => character.charCodeAt(0));
      const clipboard = new DataTransfer();
      clipboard.items.add(new File([bytes], payload.name, { type: payload.mimeType }));
      const event = new ClipboardEvent("paste", {
        bubbles: true,
        cancelable: true,
        clipboardData: clipboard
      });
      element.dispatchEvent(event);
      return event.defaultPrevented;
    },
    { name: file.name, mimeType: file.mimeType, base64: file.buffer.toString("base64") }
  );
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

test("题面图片与公开附件可以上传、预览和下载", async ({ page }, testInfo) => {
  await loginAsAuthor(page);
  const problem = await postJson(page, "/api/v1/problems", {
    title: `文件联调题-${testInfo.project.name}-${Date.now()}`,
    type: "traditional",
    tagIds: ["algorithm.implementation"],
    content: {
      basicStatement: "给定一个整数，原样输出。",
      basicSolution: "直接输出输入值。",
      background: "",
      statement: "粘贴前正文",
      inputFormat: "",
      outputFormat: "",
      constraints: "",
      solution: "",
      hints: ""
    },
    samples: []
  });
  const problemId = problem.id as string;
  await page.goto(`/problems/${problemId}?tab=statement`);

  const editor = page.locator('section[aria-label="题目描述"]');
  const imageButton = editor.getByRole("button", { name: "上传并插入图片" });
  await expect(imageButton).toBeEnabled();

  const wrongFileChooser = page.waitForEvent("filechooser");
  await imageButton.click();
  await (await wrongFileChooser).setFiles({
    name: "not-an-image.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("synthetic text", "utf8")
  });
  await expect(editor.getByRole("alert")).toContainText("仅支持 PNG、JPEG、GIF 或 WebP 图片");
  await expect(editor.locator("textarea")).not.toHaveValue(/\/api\/v1\/problems\//);

  const statementField = editor.locator("textarea");
  const forgedPasteHandled = await pasteImage(statementField, {
    name: "forged.png",
    mimeType: "image/png",
    buffer: Buffer.from("synthetic text", "utf8")
  });
  expect(forgedPasteHandled).toBe(true);
  await expect(editor.getByRole("alert")).toHaveText("图片上传失败，请稍后重试。");
  await expect(statementField).toHaveValue("粘贴前正文");

  const validPasteHandled = await pasteImage(statementField, {
    name: "synthetic.png",
    mimeType: "image/png",
    buffer: Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
      "base64"
    )
  });
  expect(validPasteHandled).toBe(true);

  await expect(statementField).toHaveValue(
    new RegExp(`^粘贴前正文!\\[题面图片\\]\\(/api/v1/problems/${problemId}/files/[0-9a-f-]+\\)$`)
  );
  await expect(imageButton).toBeEnabled();
  if (testInfo.project.name === "mobile-chromium") {
    await editor.getByRole("button", { name: "预览" }).click();
  }
  const previewImage = editor.locator(".markdown-body img");
  await expect(previewImage).toBeVisible();
  await expect.poll(() => previewImage.evaluate((image: HTMLImageElement) => image.naturalWidth)).toBeGreaterThan(0);

  await page.getByRole("button", { name: "题解与资料" }).click();
  const attachmentButton = page.getByRole("button", { name: "选择公开附件" });
  await expect(attachmentButton).toBeEnabled();
  const attachmentChooser = page.waitForEvent("filechooser");
  await attachmentButton.click();
  await (await attachmentChooser).setFiles({
    name: "synthetic-note.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("synthetic attachment", "utf8")
  });

  const attachmentRow = page.locator(".problem-file-row", { hasText: "synthetic-note.txt" });
  await expect(attachmentRow).toBeVisible();
  const downloadStarted = page.waitForEvent("download");
  await attachmentRow.getByRole("link", { name: "下载" }).click();
  const download = await downloadStarted;
  expect(download.suggestedFilename()).toBe("synthetic-note.txt");

  const pageFitsViewport = await page.evaluate(
    () => document.documentElement.scrollWidth <= document.documentElement.clientWidth
  );
  expect(pageFitsViewport).toBe(true);
  await page.screenshot({ path: testInfo.outputPath("problem-files.png"), fullPage: true });
});

test("评价公开字段、本人修改和状态联动在桌面与手机上保持一致", async ({ page }, testInfo) => {
  await loginAsAuthor(page);
  const problem = await postJson(page, "/api/v1/problems", {
    title: `审核页面联调题-${testInfo.project.name}-${Date.now()}`,
    type: "traditional",
    tagIds: ["algorithm.implementation"],
    content: {
      basicStatement: "给定一个整数，原样输出。",
      basicSolution: "直接输出输入值。",
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
  const submitted = await postJson(page, `/api/v1/problems/${problemId}/submit`, {
    expectedRevision: problem.revision
  });

  await loginAs(page, /审题人/);
  await page.goto(`/problems/${problemId}?tab=reviews`);
  await expect(page.getByRole("heading", { name: "提交我的评价" })).toBeVisible();
  await page.getByLabel("结论").selectOption("request_changes");
  await page.getByLabel("主要改进点").fill("请补充负数输入的说明。");
  await page.getByLabel("仅审题人可见备注（可选）").fill("内部复核备注，不向作者公开。");
  await page.getByRole("button", { name: "提交审核意见" }).click();
  await expect(page.getByText("我的评价 · 人工审核")).toBeVisible();
  await expect(page.locator(".review-item").getByText("请补充负数输入的说明。")).toBeVisible();

  await loginAs(page, /投稿人/);
  await page.goto(`/problems/${problemId}?tab=reviews`);
  await expect(page.getByText("请补充负数输入的说明。")).toBeVisible();
  await expect(page.getByText("内部复核备注，不向作者公开。")).toHaveCount(0);
  await expect(page.locator(".review-form")).toHaveCount(0);

  await loginAs(page, /审题人/);
  await page.goto(`/problems/${problemId}?tab=reviews`);
  await expect(page.getByRole("heading", { name: "修改我的评价" })).toBeVisible();
  await expect(page.getByLabel("主要改进点")).toHaveValue("请补充负数输入的说明。");
  await page.getByLabel("结论").selectOption("reject");
  await page.getByLabel("主要改进点").fill("题面缺少必要约束，暂不通过。");
  await page.getByRole("button", { name: "保存修改" }).click();

  await expect(page.locator(".review-summary").getByText("审核不通过")).toBeVisible();
  await expect(page.getByText("本轮审核已经结束，所有意见均为只读。")).toBeVisible();
  await expect(page.locator(".review-form")).toHaveCount(0);
  expect(submitted.reviewRound).toBe(1);
  const pageFitsViewport = await page.evaluate(
    () => document.documentElement.scrollWidth <= document.documentElement.clientWidth
  );
  expect(pageFitsViewport).toBe(true);
  await page.screenshot({ path: testInfo.outputPath("review-workflow.png"), fullPage: true });
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
