import { expect, test, type Page } from "@playwright/test";
import {
  canonicalProblemSchema,
  urmotivNativeAdapter,
  writeZipArchive
} from "@urmotiv/problem-package";

async function loginAsLeader(page: Page): Promise<void> {
  await page.goto("/demo-login");
  await page.getByRole("button", { name: /组长/ }).click();
  await expect(page).toHaveURL(/\/problems$/);
}

async function nativePackageZip(title: string): Promise<Buffer> {
  const problem = canonicalProblemSchema.parse({
    title,
    type: "traditional",
    tags: ["algorithm.implementation"],
    difficulty: { codeforces: 1600 },
    content: {
      basicStatement: "给定整数 n，输出 n。",
      basicSolution: "直接输出输入。"
    },
    samples: [{ input: "5", output: "5", explanation: "" }],
    files: [
      {
        path: "judge/testdata/001.in",
        category: "testdata",
        content: new TextEncoder().encode("5\n")
      }
    ],
    extensions: {}
  });
  const generated = await urmotivNativeAdapter.export(problem, {
    exportedAt: "2026-07-26T00:00:00.000Z"
  });
  if (generated.kind !== "zip") {
    throw new Error("原生题目包必须导出为 ZIP。");
  }
  return Buffer.from(writeZipArchive(generated.files));
}

test("组长在导入导出页完成整包导入并能打开新题目", async ({ page }, testInfo) => {
  await loginAsLeader(page);
  await page.goto("/transfer");
  await expect(page.getByRole("heading", { name: "导入导出" })).toBeVisible();

  const zip = await nativePackageZip("端到端导入示例题");
  await page.locator('input[type="file"]').setInputFiles({
    name: "e2e-problem.zip",
    mimeType: "application/zip",
    buffer: zip
  });

  await expect(page.getByText(/Urmotiv 完整包/).first()).toBeVisible({ timeout: 15_000 });
  await page.getByRole("button", { name: /查看内容/ }).click();
  await expect(page.getByText("端到端导入示例题").first()).toBeVisible({ timeout: 15_000 });

  await page.getByRole("button", { name: /确认导入/ }).click();
  const problemLink = page.getByRole("link", { name: /查看题目/ }).first();
  await expect(problemLink).toBeVisible({ timeout: 30_000 });
  await page.screenshot({ path: testInfo.outputPath("transfer-import-done.png"), fullPage: true });

  await problemLink.click();
  await expect(page.getByRole("heading", { name: "端到端导入示例题" })).toBeVisible({
    timeout: 15_000
  });
});

test("组长创建导出任务后出现有效的下载入口", async ({ page }, testInfo) => {
  await loginAsLeader(page);

  // 桌面与手机项目并行运行；标题带项目名可避免两个项目生成同一份包而互相竞争。
  const zip = await nativePackageZip(`端到端导出示例题-${testInfo.project.name}`);
  const uploadResponse = await page.request.post(
    "/api/v1/transfer/uploads?originalName=e2e-export.zip",
    {
      headers: {
        Origin: "http://127.0.0.1:5173",
        "Content-Type": "application/octet-stream"
      },
      data: zip
    }
  );
  expect(uploadResponse.ok()).toBe(true);
  const upload = (await uploadResponse.json()) as { fileId: string; sha256: string };
  const importResponse = await page.request.post("/api/v1/transfer/imports", {
    headers: { Origin: "http://127.0.0.1:5173" },
    data: {
      fileId: upload.fileId,
      sha256: upload.sha256,
      formatId: "urmotiv",
      idempotencyKey: `e2e-import-${testInfo.project.name}-${upload.fileId}`
    }
  });
  expect(importResponse.ok()).toBe(true);
  const importJob = (await importResponse.json()) as { id: string };

  let importedProblemId: string | null = null;
  for (let attempt = 0; attempt < 40 && importedProblemId === null; attempt += 1) {
    const status = await page.request.get(`/api/v1/transfer/imports/${importJob.id}`);
    const body = (await status.json()) as {
      state: string;
      items: Array<{ importedProblemId: string | null }>;
    };
    if (body.state === "succeeded") {
      importedProblemId = body.items[0]?.importedProblemId ?? null;
      break;
    }
    if (body.state === "failed") {
      throw new Error("导入任务失败，导出测试无法继续。");
    }
    await page.waitForTimeout(500);
  }
  expect(importedProblemId).not.toBeNull();

  await page.goto("/transfer");
  await page.getByRole("button", { name: "导出", exact: true }).click();
  await page.getByLabel(/题目编号/).fill(importedProblemId ?? "");
  await page.getByRole("button", { name: /检查格式差异/ }).click();
  await expect(page.getByText(/可导出/).first()).toBeVisible({ timeout: 15_000 });

  await page.getByRole("button", { name: /创建导出任务/ }).click();
  const downloadLink = page.getByRole("link", { name: /下载题目包/ }).first();
  await expect(downloadLink).toBeVisible({ timeout: 30_000 });
  await page.screenshot({ path: testInfo.outputPath("transfer-export-done.png"), fullPage: true });

  const href = await downloadLink.getAttribute("href");
  expect(href).toContain("/transfer/exports/");
  const downloaded = await page.request.get(href ?? "");
  expect(downloaded.ok()).toBe(true);
  expect(downloaded.headers()["content-type"]).toBe("application/zip");
});

test("手机视口下导入导出页没有横向溢出", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "mobile-chromium", "只检查手机布局");
  await loginAsLeader(page);
  await page.goto("/transfer");
  await expect(page.getByRole("heading", { name: "导入导出" })).toBeVisible();

  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth
  );
  expect(overflow).toBeLessThanOrEqual(1);

  await page.getByRole("button", { name: "导出", exact: true }).click();
  const overflowAfterSwitch = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth
  );
  expect(overflowAfterSwitch).toBeLessThanOrEqual(1);
  await page.screenshot({ path: testInfo.outputPath("transfer-mobile.png"), fullPage: true });
});

test("题目工作台提供原题检索按钮，插件未启用时给出明确提示", async ({ page }) => {
  await loginAsLeader(page);
  await page.goto("/problems/new");
  await page.getByLabel("题目名称").fill("查重按钮联调题");
  await page.locator(".tag-choice").first().click();
  await page.locator('section[aria-label="基础题面"] textarea').fill("给定 n，输出 n。");
  await page.locator('section[aria-label="基础题解"] textarea').fill("直接输出。");
  await page.getByRole("button", { name: "创建草稿" }).click();
  await expect(page.getByRole("heading", { name: "查重按钮联调题" })).toBeVisible();

  await page.getByRole("button", { name: /原题检索/ }).click();
  await expect(page.getByText("原题检索插件未启用")).toBeVisible({ timeout: 15_000 });
});
