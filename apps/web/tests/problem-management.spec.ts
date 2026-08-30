import { expect, test, type Page, type Route } from "@playwright/test";

async function fulfillJson(route: Route, body: unknown, status = 200): Promise<void> {
  await route.fulfill({
    status,
    contentType: "application/json",
    body: JSON.stringify(body)
  });
}

async function loginAsAdministrator(page: Page): Promise<void> {
  await page.goto("/demo-login");
  await page.getByRole("button", { name: /系统管理员/ }).click();
  await expect(page).toHaveURL(/problems$/);
}

const capabilities = {
  canView: true,
  canEdit: true,
  canEditTitle: true,
  canEditFrozen: true,
  canSubmit: false,
  canWithdraw: true,
  canReview: true,
  canChangeStatus: true,
  canReadTestdata: true,
  canWriteTestdata: true,
  canExport: true,
  canViewAccessLog: true,
  canDelete: true
};

const items = [
  {
    id: "manage-draft",
    title: "批量管理草稿示例",
    type: "traditional",
    status: "draft",
    codeforcesDifficulty: 1200,
    thinkingLevel: 2,
    codingLevel: 2,
    tagIds: ["algorithm.implementation"],
    owner: { id: "author", nickname: "投稿人", accountType: "human" },
    revision: 3,
    reviewRound: 0,
    updatedAt: "2026-08-30T00:00:00.000Z",
    capabilities,
    origin: "native",
    importBatch: null,
    importSource: null
  },
  {
    id: "manage-pending",
    title: "批量管理待审示例",
    type: "traditional",
    status: "pending_review",
    codeforcesDifficulty: 1600,
    thinkingLevel: 3,
    codingLevel: 3,
    tagIds: ["algorithm.implementation"],
    owner: { id: "author", nickname: "投稿人", accountType: "human" },
    revision: 8,
    reviewRound: 2,
    updatedAt: "2026-08-30T01:00:00.000Z",
    capabilities,
    origin: "ustc_history",
    importBatch: "safe-batch",
    importSource: "safe-source"
  }
];

test("系统管理员在桌面和手机上批量修改题目状态", async ({ page }, testInfo) => {
  let submitted: unknown;
  await page.route("**/api/v1/problems?*", async (route) => {
    await fulfillJson(route, { items, total: items.length, page: 1, pageSize: 50 });
  });
  await page.route("**/api/v1/tags", async (route) => {
    await fulfillJson(route, {
      items: [{
        id: "algorithm.implementation",
        name: "模拟",
        group: "算法",
        itemKind: "tag",
        active: true,
        category: { id: "category.algorithm", name: "算法" }
      }]
    });
  });
  await page.route("**/api/v1/admin/problems/status", async (route) => {
    submitted = route.request().postDataJSON();
    await fulfillJson(route, {
      results: [{ id: "manage-pending", ok: true, status: "approved", revision: 9 }]
    });
  });

  await loginAsAdministrator(page);
  await page.goto("/admin/problems");
  await expect(page.getByRole("heading", { name: "题目管理" })).toBeVisible();
  if (testInfo.project.name === "mobile-chromium") {
    await expect(page.locator(".admin-mobile-navigation summary")).toContainText("题目管理");
  } else {
    await expect(page.getByRole("link", { name: "题目管理" }).first()).toBeVisible();
  }
  await expect(page.getByText("批量管理草稿示例")).toBeVisible();
  await expect(page.getByText("批量管理待审示例")).toBeVisible();

  await page.getByLabel("状态操作").selectOption("approve");
  await expect(page.getByRole("checkbox", { name: "选择题目 批量管理草稿示例" })).toBeDisabled();
  await page.getByRole("checkbox", { name: "选择题目 批量管理待审示例" }).check();
  await page.getByLabel("变更理由").fill("管理员已完成人工复核。");
  page.once("dialog", (dialog) => void dialog.accept());
  await page.getByRole("button", { name: "执行确认通过" }).click();

  await expect(page.getByText(/1 道成功/)).toBeVisible();
  expect(submitted).toEqual({
    action: "approve",
    reason: "管理员已完成人工复核。",
    items: [{
      id: "manage-pending",
      expectedRevision: 8,
      expectedRound: 2
    }]
  });
  await page.screenshot({
    path: testInfo.outputPath(`problem-management-${testInfo.project.name}.png`),
    fullPage: true
  });
});
