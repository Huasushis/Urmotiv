import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ManagedTagCatalogResponse } from "@urmotiv/contracts";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  confirmTagDeactivation: vi.fn(),
  createTagAlias: vi.fn(),
  createTagCatalogItem: vi.fn(),
  deleteTagAlias: vi.fn(),
  listManagedTagCatalog: vi.fn(),
  previewTagDeactivation: vi.fn(),
  updateTagAlias: vi.fn(),
  updateTagCatalogItem: vi.fn(),
}));

vi.mock("../lib/api", async (importOriginal) => {
  const original = await importOriginal<typeof import("../lib/api")>();
  return { ...original, ...api };
});

import { ApiError } from "../lib/api";
import { TagCatalogAdmin } from "./tag-catalog-admin";

const catalog: ManagedTagCatalogResponse = {
  version: 7,
  items: [
    {
      id: "category.algorithm",
      itemKind: "category",
      parentId: null,
      name: "基础算法",
      description: "常见算法方法",
      sortOrder: 10,
      active: true,
    },
    {
      id: "category.graph",
      itemKind: "category",
      parentId: null,
      name: "图论",
      description: "图上的算法",
      sortOrder: 20,
      active: true,
    },
    {
      id: "tag.sort",
      itemKind: "tag",
      parentId: "category.algorithm",
      name: "排序",
      group: "基础算法",
      description: "把元素按规则排列",
      normalizedName: "排序",
      sortOrder: 1,
      active: true,
      category: { id: "category.algorithm", name: "基础算法" },
      aliases: ["Sorting"],
    },
    {
      id: "tag.shortest-path",
      itemKind: "tag",
      parentId: "category.graph",
      name: "最短路",
      group: "图论",
      description: "求最小距离",
      normalizedName: "最短路",
      sortOrder: 1,
      active: true,
      category: { id: "category.graph", name: "图论" },
      aliases: ["Shortest Path"],
    },
  ],
  aliases: [
    {
      id: "11111111-1111-4111-8111-111111111111",
      tagId: "tag.shortest-path",
      name: "最短路径",
      normalizedName: "最短路径",
    },
  ],
};

let root: Root | undefined;
let container: HTMLDivElement | undefined;

function mount(element: ReactNode): HTMLDivElement {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  act(() => root?.render(<QueryClientProvider client={client}>{element}</QueryClientProvider>));
  return container;
}

async function waitFor(assertion: () => void): Promise<void> {
  let latestError: unknown;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      assertion();
      return;
    } catch (error) {
      latestError = error;
      await act(async () => new Promise((resolve) => setTimeout(resolve, 5)));
    }
  }
  throw latestError;
}

function button(view: HTMLElement, name: string): HTMLButtonElement {
  const result = [...view.querySelectorAll<HTMLButtonElement>("button")]
    .find((candidate) => candidate.textContent?.includes(name));
  if (result === undefined) throw new Error(`找不到按钮：${name}`);
  return result;
}

async function click(target: HTMLButtonElement): Promise<void> {
  await act(async () => target.click());
}

async function changeValue(
  element: HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement,
  value: string,
): Promise<void> {
  await act(async () => {
    const prototype = element instanceof HTMLSelectElement
      ? HTMLSelectElement.prototype
      : element instanceof HTMLTextAreaElement
        ? HTMLTextAreaElement.prototype
        : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(prototype, "value")?.set;
    if (setter === undefined) throw new Error("测试环境无法修改表单值");
    setter.call(element, value);
    element.dispatchEvent(new Event(element instanceof HTMLSelectElement ? "change" : "input", { bubbles: true }));
  });
}

afterEach(() => {
  if (root !== undefined) act(() => root?.unmount());
  container?.remove();
  root = undefined;
  container = undefined;
  vi.resetAllMocks();
});

describe("知识点目录后台", () => {
  it("按分类展开叶子并可改名、移动、排序和修改帮助说明", async () => {
    const movedCatalog: ManagedTagCatalogResponse = {
      ...catalog,
      version: 8,
      items: catalog.items.map((item) => item.itemKind === "tag" && item.id === "tag.shortest-path"
        ? { ...item, name: "单源最短路", parentId: "category.algorithm", group: "基础算法", sortOrder: 4, description: "更新后的说明", category: { id: "category.algorithm", name: "基础算法" } }
        : item),
    };
    api.listManagedTagCatalog.mockResolvedValueOnce(catalog).mockResolvedValueOnce(movedCatalog);
    api.updateTagCatalogItem.mockResolvedValue({ version: 8 });
    const view = mount(<TagCatalogAdmin />);

    await waitFor(() => expect(view.textContent).toContain("目录版本 7"));
    await click(button(view, "图论"));
    await click(button(view, "最短路"));
    expect(view.querySelector<HTMLInputElement>('input[aria-label="别名“最短路径”"]')?.value).toBe("最短路径");
    expect(view.textContent).toContain("求最小距离");

    const editor = view.querySelector<HTMLElement>(".tag-admin-editor");
    const fields = editor?.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>(".tag-admin-form-grid input, .tag-admin-form-grid select, .tag-admin-form-grid textarea");
    expect(fields).toHaveLength(4);
    await changeValue(fields![0] as HTMLInputElement, "单源最短路");
    await changeValue(fields![1] as HTMLSelectElement, "category.algorithm");
    await changeValue(fields![2] as HTMLInputElement, "4");
    await changeValue(fields![3] as HTMLTextAreaElement, "更新后的说明");
    await click(button(editor!, "保存目录项"));

    await waitFor(() => expect(api.updateTagCatalogItem).toHaveBeenCalledWith("tag.shortest-path", {
      expectedVersion: 7,
      name: "单源最短路",
      description: "更新后的说明",
      parentId: "category.algorithm",
      sortOrder: 4,
    }));
    await waitFor(() => expect(view.textContent).toContain("目录版本 8"));
  });

  it("目录版本冲突时保留输入，只有主动刷新成功后才替换", async () => {
    const refreshed: ManagedTagCatalogResponse = { ...catalog, version: 9 };
    api.listManagedTagCatalog.mockResolvedValueOnce(catalog).mockResolvedValueOnce(refreshed);
    api.updateTagCatalogItem.mockRejectedValue(new ApiError("版本冲突", 409));
    const view = mount(<TagCatalogAdmin />);

    await waitFor(() => expect(view.textContent).toContain("目录版本 7"));
    const name = view.querySelector<HTMLInputElement>(".tag-admin-editor .tag-admin-form-grid input:not([type=number])");
    expect(name).not.toBeNull();
    await changeValue(name!, "新的分类名称");
    await click(button(view.querySelector(".tag-admin-editor")!, "保存目录项"));
    await waitFor(() => expect(view.textContent).toContain("知识点目录已经被其他人修改"));
    expect(name?.value).toBe("新的分类名称");

    await click(button(view, "放弃本页输入并重新读取"));
    await waitFor(() => expect(view.textContent).toContain("目录版本 9"));
    expect(view.querySelector<HTMLInputElement>(".tag-admin-editor .tag-admin-form-grid input:not([type=number])")?.value).toBe("基础算法");
  });

  it("写入成功后读到更高目录版本时阻止用旧字段覆盖并发修改", async () => {
    const concurrentlyUpdated: ManagedTagCatalogResponse = {
      ...catalog,
      version: 9,
      items: catalog.items.map((item) => item.id === "tag.shortest-path"
        ? { ...item, description: "另一位管理员刚保存的说明" }
        : item),
      aliases: [
        ...catalog.aliases,
        {
          id: "88888888-8888-4888-8888-888888888888",
          tagId: "tag.shortest-path",
          name: "SP",
          normalizedName: "sp",
        },
      ],
    };
    api.listManagedTagCatalog
      .mockResolvedValueOnce(catalog)
      .mockResolvedValueOnce(concurrentlyUpdated);
    api.createTagAlias.mockResolvedValue({
      version: 8,
      aliasId: "88888888-8888-4888-8888-888888888888",
    });
    const view = mount(<TagCatalogAdmin />);

    await waitFor(() => expect(view.textContent).toContain("目录版本 7"));
    await click(button(view, "图论"));
    await click(button(view, "最短路"));
    const description = view.querySelector<HTMLTextAreaElement>(
      ".tag-admin-editor .tag-admin-form-grid textarea",
    );
    await changeValue(description!, "我的未保存说明");
    await changeValue(view.querySelector<HTMLInputElement>(".tag-admin-alias-new input")!, "SP");
    await click(button(view, "添加别名"));

    await waitFor(() => expect(view.textContent).toContain("知识点目录已经被其他人修改"));
    expect(view.textContent).toContain("别名已新增");
    expect(description?.value).toBe("我的未保存说明");
    expect(button(view, "保存目录项").disabled).toBe(true);
  });

  it("两步停用只显示聚合影响，唯一标签题选择替代项并重新预览后才能确认", async () => {
    const sameNamedReplacements = [
      {
        ...catalog.items.find((item) => item.id === "tag.sort" && item.itemKind === "tag")!,
        id: "tag.shared-name.algorithm",
        name: "同名知识点",
        sortOrder: 8,
      },
      {
        ...catalog.items.find((item) => item.id === "tag.shortest-path" && item.itemKind === "tag")!,
        id: "tag.shared-name.graph",
        name: "同名知识点",
        sortOrder: 8,
      },
    ];
    const catalogWithSameNames: ManagedTagCatalogResponse = {
      ...catalog,
      items: [...catalog.items, ...sameNamedReplacements],
    };
    const afterDeactivate: ManagedTagCatalogResponse = {
      ...catalogWithSameNames,
      version: 8,
      items: catalogWithSameNames.items.map((item) => item.id === "tag.shortest-path" ? { ...item, active: false } : item),
    };
    api.listManagedTagCatalog.mockResolvedValueOnce(catalogWithSameNames).mockResolvedValueOnce(afterDeactivate);
    api.previewTagDeactivation.mockResolvedValue({
      confirmationId: "22222222-2222-4222-8222-222222222222",
      catalogVersion: 7,
      expiresAt: "2026-08-02T12:00:00.000Z",
      impact: {
        currentProblemCount: 5,
        soleCurrentTagCount: 2,
        historicalRevisionCount: 9,
        reviewOpinionCount: 4,
        childTagCount: 0,
      },
    });
    api.confirmTagDeactivation.mockResolvedValue({ version: 8 });
    const view = mount(<TagCatalogAdmin />);

    await waitFor(() => expect(view.textContent).toContain("目录版本 7"));
    await click(button(view, "图论"));
    await click(button(view, "最短路"));
    const replacementOptions = [...view.querySelectorAll<HTMLOptionElement>(".tag-admin-replacement option")]
      .map((option) => option.textContent);
    expect(replacementOptions).toContain("基础算法 / 同名知识点");
    expect(replacementOptions).toContain("图论 / 同名知识点");
    await click(button(view, "预览停用影响"));
    await waitFor(() => expect(view.textContent).toContain("其中仅有这个标签的题目"));
    expect(view.textContent).toContain("历史修订和审题意见会保留原引用");
    const confirm = button(view, "确认停用");
    expect(confirm.disabled).toBe(true);

    const replacement = view.querySelector<HTMLSelectElement>(".tag-admin-replacement select");
    await changeValue(replacement!, "tag.sort");
    expect(view.textContent).not.toContain("其中仅有这个标签的题目");
    await click(button(view, "预览停用影响"));
    await waitFor(() => expect(api.previewTagDeactivation).toHaveBeenLastCalledWith("tag.shortest-path", { replacementTagId: "tag.sort" }));
    await click(button(view, "确认停用"));

    await waitFor(() => expect(api.confirmTagDeactivation).toHaveBeenCalledWith("tag.shortest-path", {
      confirmationId: "22222222-2222-4222-8222-222222222222",
      catalogVersion: 7,
    }));
    expect(view.textContent).not.toContain("题目标题");
  });

  it("可以新增分类并由页面生成不会随名称变化的稳定编号", async () => {
    const createdCategory = {
      id: "custom.category.generated",
      itemKind: "category" as const,
      parentId: null,
      name: "新分类",
      description: "新增分类说明",
      sortOrder: 30,
      active: true,
    };
    api.listManagedTagCatalog
      .mockResolvedValueOnce(catalog)
      .mockImplementationOnce(async () => ({ ...catalog, version: 8, items: [...catalog.items, createdCategory] }));
    api.createTagCatalogItem.mockResolvedValue({ version: 8 });
    const view = mount(<TagCatalogAdmin />);

    await waitFor(() => expect(view.textContent).toContain("目录版本 7"));
    await click(button(view, "新增分类"));
    const panel = view.querySelector<HTMLElement>(".tag-admin-create");
    const fields = panel?.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>("input, textarea");
    await changeValue(fields![0] as HTMLInputElement, "新分类");
    await changeValue(fields![1] as HTMLInputElement, "30");
    await changeValue(fields![2] as HTMLTextAreaElement, "新增分类说明");
    await click(button(panel!, "确认新增"));

    await waitFor(() => expect(api.createTagCatalogItem).toHaveBeenCalledTimes(1));
    expect(api.createTagCatalogItem).toHaveBeenCalledWith({
      expectedVersion: 7,
      id: expect.stringMatching(/^custom\.category\.[a-z0-9]+$/),
      itemKind: "category",
      parentId: null,
      name: "新分类",
      description: "新增分类说明",
      sortOrder: 30,
    });
  });

  it("可以新增、改名和删除叶子知识点别名", async () => {
    const aliasId = "55555555-5555-4555-8555-555555555555";
    const withAlias: ManagedTagCatalogResponse = {
      ...catalog,
      version: 8,
      aliases: [...catalog.aliases, { id: aliasId, tagId: "tag.shortest-path", name: "SP", normalizedName: "sp" }],
    };
    const renamedAlias: ManagedTagCatalogResponse = {
      ...withAlias,
      version: 9,
      aliases: withAlias.aliases.map((alias) => alias.id === aliasId ? { ...alias, name: "Shortest-Path", normalizedName: "shortest-path" } : alias),
    };
    const withoutAlias: ManagedTagCatalogResponse = {
      ...renamedAlias,
      version: 10,
      aliases: renamedAlias.aliases.filter((alias) => alias.id !== aliasId),
    };
    api.listManagedTagCatalog
      .mockResolvedValueOnce(catalog)
      .mockResolvedValueOnce(withAlias)
      .mockResolvedValueOnce(renamedAlias)
      .mockResolvedValueOnce(withoutAlias);
    api.createTagAlias.mockResolvedValue({ version: 8, aliasId });
    api.updateTagAlias.mockResolvedValue({ version: 9 });
    api.deleteTagAlias.mockResolvedValue({ version: 10 });
    const view = mount(<TagCatalogAdmin />);

    await waitFor(() => expect(view.textContent).toContain("目录版本 7"));
    await click(button(view, "图论"));
    await click(button(view, "最短路"));
    const unsavedDescription = view.querySelector<HTMLTextAreaElement>(
      ".tag-admin-editor .tag-admin-form-grid textarea",
    );
    await changeValue(unsavedDescription!, "尚未保存的目录说明");
    const confirmSwitch = vi.spyOn(window, "confirm").mockReturnValue(false);
    await click(button(view, "基础算法"));
    expect(confirmSwitch).toHaveBeenCalledOnce();
    expect(view.querySelector<HTMLHeadingElement>("#tag-editor-title")?.textContent).toBe("最短路");
    expect(unsavedDescription?.value).toBe("尚未保存的目录说明");
    await changeValue(view.querySelector<HTMLInputElement>(".tag-admin-alias-new input")!, "SP");
    await click(button(view, "添加别名"));
    await waitFor(() => expect(api.createTagAlias).toHaveBeenCalledWith("tag.shortest-path", { expectedVersion: 7, name: "SP" }));
    expect(view.querySelector<HTMLTextAreaElement>(
      ".tag-admin-editor .tag-admin-form-grid textarea",
    )?.value).toBe("尚未保存的目录说明");

    const aliasInput = view.querySelector<HTMLInputElement>('input[aria-label="别名“SP”"]');
    await changeValue(aliasInput!, "Shortest-Path");
    const aliasRow = aliasInput?.closest<HTMLElement>(".tag-admin-alias-row");
    await click(button(aliasRow!, "保存"));
    await waitFor(() => expect(api.updateTagAlias).toHaveBeenCalledWith("tag.shortest-path", aliasId, { expectedVersion: 8, name: "Shortest-Path" }));

    await click(view.querySelector<HTMLButtonElement>('button[aria-label="删除别名“Shortest-Path”"]')!);
    await waitFor(() => expect(api.deleteTagAlias).toHaveBeenCalledWith("tag.shortest-path", aliasId, { expectedVersion: 9 }));
  });

  it("停用分类有子标签时不会提供连带确认，停用项可以单独恢复", async () => {
    const inactiveCatalog: ManagedTagCatalogResponse = {
      ...catalog,
      version: 8,
      items: catalog.items.map((item) => item.id === "tag.sort" ? { ...item, active: false } : item),
    };
    const restoredCatalog: ManagedTagCatalogResponse = {
      ...inactiveCatalog,
      version: 9,
      items: inactiveCatalog.items.map((item) => item.id === "tag.sort" ? { ...item, active: true } : item),
    };
    api.listManagedTagCatalog
      .mockResolvedValueOnce(catalog)
      .mockResolvedValueOnce(inactiveCatalog)
      .mockResolvedValueOnce(restoredCatalog);
    api.previewTagDeactivation
      .mockResolvedValueOnce({
        confirmationId: "66666666-6666-4666-8666-666666666666",
        catalogVersion: 7,
        expiresAt: "2026-08-02T12:00:00.000Z",
        impact: {
          currentProblemCount: 0,
          soleCurrentTagCount: 0,
          historicalRevisionCount: 0,
          reviewOpinionCount: 0,
          childTagCount: 1,
        },
      })
      .mockResolvedValueOnce({
        confirmationId: "77777777-7777-4777-8777-777777777777",
        catalogVersion: 7,
        expiresAt: "2026-08-02T12:00:00.000Z",
        impact: {
          currentProblemCount: 0,
          soleCurrentTagCount: 0,
          historicalRevisionCount: 0,
          reviewOpinionCount: 0,
          childTagCount: 0,
        },
      });
    api.confirmTagDeactivation.mockResolvedValue({ version: 8 });
    api.updateTagCatalogItem.mockResolvedValue({ version: 9 });
    const view = mount(<TagCatalogAdmin />);

    await waitFor(() => expect(view.textContent).toContain("目录版本 7"));
    await click(button(view, "预览停用影响"));
    await waitFor(() => expect(view.textContent).toContain("这个分类仍有子标签"));
    expect(button(view, "确认停用").disabled).toBe(true);
    expect(api.confirmTagDeactivation).not.toHaveBeenCalled();

    await click(button(view, "基础算法"));
    await click(button(view, "排序"));
    await click(button(view, "预览停用影响"));
    await waitFor(() => expect(button(view, "确认停用").disabled).toBe(false));
    await click(button(view, "确认停用"));
    await waitFor(() => expect(view.textContent).toContain("恢复这个知识点"));
    await click(button(view, "恢复启用"));
    await waitFor(() => expect(api.updateTagCatalogItem).toHaveBeenCalledWith("tag.sort", { expectedVersion: 8, active: true }));
  });
});
