import { expect, test } from "@playwright/test";
import type { Contest } from "@urmotiv/contracts";

const timestamp = "2026-09-20T00:00:00.000Z";
const contest: Contest = {
  id: "88", title: "合成比赛整包导出", description: "比赛固定题目版本，后续修改不影响本次导出。", state: "archived",
  startsAt: null, endsAt: null, creator: { id: "1", nickname: "合成组题人", accountType: "human" },
  members: [], createdAt: timestamp, updatedAt: timestamp,
  capabilities: { canEdit: false, canDelete: false, canExport: true, canReadRisk: false },
  problems: ["88", "89"].map((problemId, position) => ({
    problemId, position, revisionId: `00000000-0000-4000-8000-0000000000${position + 10}`,
    revision: 2, title: `合成题目 ${position + 1}`, score: 100, estimatedDifficulty: null,
    leakRiskCount: 0, leakRiskEntries: []
  }))
};

test("比赛页导出全部固定版本，只展示启用格式，生成下载入口并处理方案已变化", async ({ page }, testInfo) => {
  let rejectPreview = false;
  const requests: Record<string, unknown>[] = [];
  const jobId = "00000000-0000-4000-8000-000000000099";
  await page.route("**/api/v1/contests", route => route.fulfill({ json: { items: [{ ...contest,
    problemCount: 2, participantCount: 0, leakRiskCount: 0
  }] } }));
  await page.route("**/api/v1/contests/88", route => route.fulfill({ json: contest }));
  await page.route("**/api/v1/transfer/formats", route => route.fulfill({ json: { items: [
    { id: "urmotiv", displayName: "Urmotiv" }, { id: "hydro", displayName: "Hydro" }
  ] } }));
  await page.route("**/api/v1/transfer/exports/preview", route => {
    requests.push(route.request().postDataJSON());
    return rejectPreview ? route.fulfill({ status: 409, json: { error: { code: "CONFLICT", message: "比赛方案已更新，请刷新后重新导出。", requestId: jobId } } }) :
      route.fulfill({ json: { targetFormat: "hydro", canExport: true, problems: contest.problems.map(problem => ({
        problemId: problem.problemId, revisionId: problem.revisionId, title: problem.title, status: "ready", items: []
      })) } });
  });
  const job = { id: jobId, state: "succeeded", progressPercent: 100, phase: "completed", targetFormat: "hydro", problemCount: 2,
    resultReady: true, resultExpiresAt: "2030-01-01T00:00:00.000Z", failure: null, createdAt: timestamp, finishedAt: timestamp };
  await page.route("**/api/v1/transfer/exports", route => { requests.push(route.request().postDataJSON()); return route.fulfill({ json: job }); });
  await page.route(`**/api/v1/transfer/exports/${jobId}`, route => route.fulfill({ json: job }));
  await page.goto("/demo-login");
  await page.getByRole("button", { name: /组长/ }).click();
  await expect(page).toHaveURL(/\/problems$/);
  await page.goto("/contests?view=archived");
  await page.getByRole("button", { name: "导出比赛题目包", exact: true }).click();
  const panel = page.getByRole("region", { name: "导出比赛题目包", exact: true });
  await expect(panel).toContainText("全部 2 道题");
  await expect(panel.getByRole("textbox")).toHaveCount(0);
  await expect(panel.getByRole("combobox", { name: "目标格式" }).locator("option")).toHaveCount(2);
  await panel.getByRole("combobox", { name: "目标格式" }).selectOption("hydro");
  await panel.getByRole("button", { name: "检查格式差异" }).click();
  await expect(panel.getByRole("button", { name: "创建导出任务", exact: true })).toBeEnabled();
  await panel.getByRole("button", { name: "创建导出任务", exact: true }).click();
  await expect(panel.getByRole("link", { name: "下载题目包" })).toBeVisible();
  expect(requests).toHaveLength(2);
  for (const request of requests) expect(request).toMatchObject({ contest: { id: "88", expectedUpdatedAt: timestamp },
    problems: [{ problemId: "88" }, { problemId: "89" }] });
  expect(requests[1]).toMatchObject({ problems: contest.problems.map(({ problemId, revisionId }) => ({ problemId, revisionId })) });
  await expect(panel.getByRole("link", { name: "下载题目包" })).toHaveAttribute("href", `/api/v1/transfer/exports/${jobId}/download`);
  expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(1);
  await page.evaluate(() => scrollTo(0, 0));
  await page.screenshot({ path: testInfo.outputPath("contest-export.png"), fullPage: true });
  rejectPreview = true;
  await panel.getByRole("combobox", { name: "目标格式" }).selectOption("urmotiv");
  await panel.getByRole("button", { name: "检查格式差异" }).click();
  await expect(panel).toContainText("比赛方案已更新，请刷新后重新导出。");
  await expect(panel.getByRole("link", { name: "下载题目包" })).toHaveCount(0);
});
