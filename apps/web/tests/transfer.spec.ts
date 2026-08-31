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

async function enableHydroFormatPlugin(page: Page): Promise<void> {
  await page.goto("/demo-login");
  await page.getByRole("button", { name: /系统管理员/ }).click();
  await expect(page).toHaveURL(/\/problems$/);
  const response = await page.request.get("/api/v1/admin/plugins");
  expect(response.ok()).toBe(true);
  const body = (await response.json()) as {
    items: Array<{ id: string; state: string; settingsRevision: number }>;
  };
  const plugin = body.items.find((item) => item.id === "org.ustc.urmotiv.hydro-format");
  if (plugin === undefined) {
    throw new Error("测试环境没有注册 Hydro 格式插件。");
  }
  if (plugin.state !== "enabled") {
    const updated = await page.request.patch(
      "/api/v1/admin/plugins/org.ustc.urmotiv.hydro-format",
      {
        headers: { Origin: "http://127.0.0.1:5173" },
        data: { expectedRevision: plugin.settingsRevision, state: "enabled" }
      }
    );
    expect(updated.ok(), await updated.text()).toBe(true);
  }
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

function hydroMultiPackageZip(titles: readonly string[]): Buffer {
  const encoder = new TextEncoder();
  const files = titles.flatMap((title, index) => {
    const root = `problem-${index + 1}`;
    return [
      {
        path: `${root}/problem.yaml`,
        content: encoder.encode([
          `title: ${title}`,
          "tag:",
          "  - algorithm.implementation"
        ].join("\n"))
      },
      {
        path: `${root}/problem.md`,
        content: encoder.encode([
          "# Description",
          "",
          `这是第 ${index + 1} 道公开合成导入测试题。`,
          "",
          "# Format",
          "",
          "输入一个整数并原样输出。"
        ].join("\n"))
      },
      {
        path: `${root}/solution/solution.md`,
        content: encoder.encode("直接输出输入。\n")
      },
      {
        path: `${root}/testdata/config.yaml`,
        content: encoder.encode([
          "time: 1000ms",
          "memory: 256m",
          "cases:",
          "  - input: 001.in",
          "    output: 001.out",
          "    score: 100"
        ].join("\n"))
      },
      { path: `${root}/testdata/001.in`, content: encoder.encode(`${index + 1}\n`) },
      { path: `${root}/testdata/001.out`, content: encoder.encode(`${index + 1}\n`) }
    ];
  });
  return Buffer.from(writeZipArchive(files));
}

test("组长自动识别并导入一个含多题的 Hydro 题目包", async ({ page }, testInfo) => {
  await enableHydroFormatPlugin(page);
  await loginAsLeader(page);
  await page.goto("/transfer");
  await expect(page.getByRole("heading", { name: "导入导出" })).toBeVisible();

  const titles = ["Hydro 多题导入示例一", "Hydro 多题导入示例二"] as const;
  const zip = hydroMultiPackageZip(titles);
  await page.locator('input[type="file"]').setInputFiles({
    name: "e2e-hydro-multiple.zip",
    mimeType: "application/zip",
    buffer: zip
  });

  await expect(page.locator(".plain-list li").filter({ hasText: "Hydro 题目包" })).toBeVisible({
    timeout: 15_000
  });
  await expect(page.getByLabel("来源格式")).toHaveValue("hydro");
  await page.getByRole("button", { name: /查看内容/ }).click();
  const previewMetadata = page.locator(".metadata-list").nth(1);
  await expect(previewMetadata.locator("dd").first()).toHaveText("2", { timeout: 15_000 });

  await page.getByRole("button", { name: /确认导入/ }).click();
  const problemLinks = page.getByRole("link", { name: /查看题目/ });
  await expect(problemLinks).toHaveCount(2, { timeout: 30_000 });
  await page.screenshot({ path: testInfo.outputPath("transfer-import-done.png"), fullPage: true });

  await problemLinks.first().click();
  await expect(page.getByRole("heading", { name: titles[0] })).toBeVisible({
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
  for (const label of ["导入", "导出"]) {
    const box = await page.getByRole("button", { name: label, exact: true }).boundingBox();
    expect(box?.height ?? 0).toBeGreaterThanOrEqual(44);
  }

  await page.getByRole("button", { name: "导出", exact: true }).click();
  const overflowAfterSwitch = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth
  );
  expect(overflowAfterSwitch).toBeLessThanOrEqual(1);
  await page.screenshot({ path: testInfo.outputPath("transfer-mobile.png"), fullPage: true });
});

test("题目工作台提供原题检索按钮，未形成可信结果时不会显示成阴性", async ({ page }) => {
  await loginAsLeader(page);
  await page.goto("/problems/new");
  await page.getByLabel("题目名称").fill("查重按钮联调题");
  await page.getByRole("button", { name: "选择知识点" }).click();
  await page.locator(".tag-picker-group summary").first().click();
  await page.locator(".tag-choice").first().click();
  await page.locator('section[aria-label="基础题面"] textarea').fill("给定 n，输出 n。");
  await page.locator('section[aria-label="基础题解"] textarea').fill("直接输出。");
  await page.getByRole("button", { name: "创建草稿" }).click();
  await expect(page.getByRole("heading", { name: "查重按钮联调题" })).toBeVisible();

  await page.getByRole("button", { name: /原题检索/ }).click();
  await expect(page.getByText(/原题检索未能形成可信结果/)).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText(/未发现需要关注的相似题目/)).toHaveCount(0);
});

test("原题检索候选展示来源链接、题号和可展开题面", async ({ page }, testInfo) => {
  await page.route("**/api/v1/problems/*/similarity-check", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        status: "completed",
        blockedAdvice: null,
        items: [{
          id: "synthetic-anklang-result",
          type: "org.ustc.urmotiv.anklang.similarity",
          source: "anklang",
          visibility: "author",
          summary: "发现 1 道候选题，需人工核对。",
          createdAt: "2026-08-31T13:00:00.000Z",
          data: {
            apiVersion: "2",
            checkedAt: "2026-08-31T13:00:00.000Z",
            completion: { status: "complete" },
            candidates: [{
              source: "yuantiji",
              externalId: "CF-1000A",
              title: "公开合成相似题",
              url: "https://example.test/problems/CF-1000A",
              similarity: 0.91,
              statement: "# 公开合成题面\n\n给定一个整数，输出它本身。",
              metadata: { search_provider: "yuantiji" }
            }]
          }
        }]
      })
    });
  });

  await loginAsLeader(page);
  await page.goto("/problems/new");
  await page.getByLabel("题目名称").fill(`候选展示联调题-${testInfo.project.name}`);
  await page.getByRole("button", { name: "选择知识点" }).click();
  await page.locator(".tag-picker-group summary").first().click();
  await page.locator(".tag-choice").first().click();
  await page.locator('section[aria-label="基础题面"] textarea').fill("给定 x，输出 x。");
  await page.locator('section[aria-label="基础题解"] textarea').fill("直接输出。");
  await page.getByRole("button", { name: "创建草稿" }).click();
  await page.getByRole("button", { name: /原题检索/ }).click();

  const candidate = page.locator(".candidate-item").filter({ hasText: "公开合成相似题" });
  await expect(candidate.getByRole("link", { name: /公开合成相似题/ }))
    .toHaveAttribute("href", "https://example.test/problems/CF-1000A");
  await expect(candidate.getByText("题号 CF-1000A")).toBeVisible();
  await expect(candidate.getByText("经 yuantiji 检索")).toBeVisible();
  await candidate.getByText("查看题面").click();
  await expect(candidate.getByRole("heading", { name: "公开合成题面" })).toBeVisible();
  await expect(candidate.getByText("给定一个整数，输出它本身。")).toBeVisible();
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth
  );
  expect(overflow).toBeLessThanOrEqual(1);
  await page.screenshot({
    path: testInfo.outputPath(`anklang-candidate-${testInfo.project.name}.png`),
    fullPage: true
  });
});
