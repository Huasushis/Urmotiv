import { expect, test, type Page } from "@playwright/test";
async function login(page: Page, name: RegExp) {
  await page.goto("/demo-login");
  await page.getByRole("button", { name }).click();
  await expect(page).toHaveURL(/\/problems$/);
}
test.beforeEach(async ({ page }) => {
  await login(page, /系统管理员/);
  const feed = await page.request
    .get("/api/v1/admin/announcements?pageSize=50")
    .then((r) => r.json());
  for (const item of feed.items ?? [])
    if (item.title.startsWith("合成公告 ") && item.published) {
      const { id, revision, createdAt, updatedAt, read, ...input } = item;
      await page.request.put("/api/v1/admin/announcements/" + id, {
        headers: { origin: "http://localhost:5173" },
        data: { ...input, published: false, expectedRevision: revision },
      });
    }
});
test("模板自动填入草稿，数学上下标和多行公式正确，头像菜单失焦关闭", async ({
  page,
}, info) => {
  await login(page, /投稿人/);
  const menu = page.locator(".user-menu");
  await menu.locator("summary").click();
  await expect(menu).toHaveAttribute("open", "");
  await page.locator("h1").click();
  await expect(menu).not.toHaveAttribute("open", "");
  await menu.locator("summary").click();
  await page.keyboard.press("Escape");
  await expect(menu).not.toHaveAttribute("open", "");
  await page.goto("/problems/new");
  await page.getByText("使用 Markdown 模板投稿", { exact: true }).click();
  await page.getByLabel("模板内容", { exact: true })
    .fill(String.raw`# 合成模板 ${info.project.name}

## 基础题面
行内 \(x_i^2\)，以及 $y_j^3$。
\[
\sum_{i=1}^{n} \frac{1}{i^2}
\]
## 基础题解
证明 **求和** 正确。
## 正式题解
### 推导
分步说明。
## 样例 1 输入

~~~text
1 2
~~~

## 样例 1 输出

~~~text
3
~~~
`);
  await page.getByRole("button", { name: "识别并预览" }).click();
  await expect(page.locator(".template-preview")).toContainText("1 组样例");
  await page.getByRole("button", { name: "填入创建表单" }).click();
  const editor = page.getByRole("region", { name: "基础题面", exact: true });
  if (info.project.name.startsWith("mobile"))
    await editor.getByRole("button", { name: "预览", exact: true }).click();
  await expect(editor.locator(".katex")).toHaveCount(3);
  await expect(editor.locator(".katex-error")).toHaveCount(0);
  await page.evaluate(() => document.fonts.ready);
  const metrics = await editor
    .locator(".katex")
    .first()
    .evaluate((element) => {
      const base = element.querySelector(".katex-html > .base")!;
      const script = element.querySelector(".msupsub .sizing")!;
      return {
        base: parseFloat(getComputedStyle(base).fontSize),
        script: parseFloat(getComputedStyle(script).fontSize),
        height: base.getBoundingClientRect().height,
      };
    });
  expect(metrics.script).toBeLessThan(metrics.base * 0.85);
  expect(metrics.script).toBeGreaterThan(metrics.base * 0.4);
  expect(metrics.height).toBeGreaterThan(10);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth - innerWidth,
    ),
  ).toBeLessThanOrEqual(1);
  await editor.scrollIntoViewIfNeeded();
  await page.screenshot({ path: info.outputPath("math-template.png") });
  await page.getByRole("button", { name: "选择知识点" }).click();
  await page.locator(".tag-picker-group").first().locator("summary").click();
  await page.locator(".tag-choice").first().click();
  await page.getByRole("button", { name: "创建草稿", exact: true }).click();
  await expect(page).toHaveURL(/\/problems\/\d+$/);
  const id = page.url().split("/").at(-1);
  const response = await page.request.get("/api/v1/problems/" + id);
  const body = await response.json();
  expect(body.content.solution).toContain("### 推导");
  expect(body.samples[0]).toMatchObject({ input: "1 2", output: "3" });
});

test("公告发布、受众选择、置顶、新人弹窗、已读和撤回；文档四角色可读", async ({
  page,
}, info) => {
  await login(page, /系统管理员/);
  await page.goto("/admin/announcements");
  await page.getByRole("button", { name: "发布公告", exact: true }).click();
  const title = "合成公告 " + info.project.name + " " + Date.now();
  await page.getByLabel("标题", { exact: true }).fill(title);
  await page
    .getByRole("textbox", { name: "公告内容", exact: true })
    .fill(
      "欢迎，先看 [投稿人使用文档](/guide?role=author)。\n\n公式 \\(a_i^2\\)。",
    );
  await page
    .getByRole("combobox", { name: "接收人群", exact: true })
    .selectOption("roles");
  await expect(page.getByRole("group", { name: "接收权限组" })).toBeVisible();
  await page
    .getByRole("combobox", { name: "接收人群", exact: true })
    .selectOption("newcomers");
  await page.getByLabel("注册时间不超过（天）").fill("365");
  await page.getByRole("checkbox", { name: "置顶", exact: true }).check();
  await page.getByLabel("立即发布", { exact: true }).check();
  await page.getByRole("button", { name: "保存公告", exact: true }).click();
  const article = page.locator(".announcement-item").filter({ hasText: title });
  await expect(article).toContainText("已发布");
  let id: string | undefined;
  try {
    const feed = await page.request
      .get("/api/v1/admin/announcements?pageSize=50")
      .then((r) => r.json());
    id = feed.items.find((i: { title: string }) => i.title === title).id;
    await login(page, /投稿人/);
    const popup = page.getByRole("dialog");
    await expect(popup).toBeVisible();
    await expect(popup).toContainText(title);
    await expect(popup.locator(".katex")).toHaveCount(1);
    await page.screenshot({
      path: info.outputPath("newcomer-announcement.png"),
      fullPage: true,
    });
    await popup.getByRole("button", { name: "我知道了" }).click();
    await expect(popup).toHaveCount(0);
    await page.reload();
    await expect(
      page.getByRole("heading", { name: "题目", exact: true }),
    ).toBeVisible();
    await expect(popup).toHaveCount(0);
    await page.getByRole("link", { name: /全部通知/ }).click();
    await expect(
      page.locator(".announcement-item").filter({ hasText: title }),
    ).toContainText("已读");
    await page.getByRole("link", { name: "投稿人使用文档" }).click();
    await expect(page).toHaveURL(/guide\?role=author/);
    for (const role of ["投稿人", "命题组成员", "组长", "管理员"]) {
      await page
        .getByRole("navigation", { name: "使用文档角色" })
        .getByRole("button", { name: role, exact: true })
        .click();
      await expect(page.locator(".guide-content")).not.toBeEmpty();
    }
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth - innerWidth,
      ),
    ).toBeLessThanOrEqual(1);
    await page.screenshot({
      path: info.outputPath("guide-admin.png"),
      fullPage: true,
    });
  } finally {
    await login(page, /系统管理员/);
    const feed = await page.request
      .get("/api/v1/admin/announcements?pageSize=50")
      .then((r) => r.json());
    const saved = feed.items.find((i: { id: string }) => i.id === id);
    if (saved) {
      const {
        id: target,
        revision,
        createdAt,
        updatedAt,
        read,
        ...input
      } = saved;
      const withdrawn = await page.request.put(
        "/api/v1/admin/announcements/" + target,
        {
          headers: { origin: "http://localhost:5173" },
          data: { ...input, published: false, expectedRevision: revision },
        },
      );
      expect(withdrawn.ok()).toBe(true);
    }
  }
});
