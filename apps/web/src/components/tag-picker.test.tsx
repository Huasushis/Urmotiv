import type { ProblemTag } from "@urmotiv/contracts";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TagPicker } from "./tag-picker";

const tags: ProblemTag[] = [
  { id: "sort", name: "排序", group: "基础算法" },
  { id: "binary-search", name: "二分", group: "基础算法" },
  { id: "kmp", name: "KMP", group: "字符串" },
  { id: "sort", name: "重复的排序", group: "其他" },
];

let root: Root | undefined;
let container: HTMLDivElement | undefined;

afterEach(() => {
  if (root !== undefined) {
    act(() => root?.unmount());
  }
  container?.remove();
  root = undefined;
  container = undefined;
});

function mount(element: ReactNode): HTMLDivElement {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  act(() => root?.render(element));
  return container;
}

function buttonByText(view: HTMLElement, text: string): HTMLButtonElement {
  const button = [...view.querySelectorAll("button")].find(
    (candidate) => candidate.textContent?.trim() === text,
  );
  if (!(button instanceof HTMLButtonElement)) {
    throw new Error(`找不到按钮“${text}”。`);
  }
  return button;
}

function setSearch(view: HTMLElement, value: string): void {
  const input = view.querySelector('input[type="search"]');
  if (!(input instanceof HTMLInputElement)) {
    throw new Error("找不到知识点搜索框。");
  }
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  if (setter === undefined) {
    throw new Error("测试环境无法修改搜索框。");
  }
  act(() => {
    setter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

describe("知识点选择器", () => {
  it("按分类折叠且只显示一次重复标签，并自动展开含已选项的分类", () => {
    const onChange = vi.fn();
    const view = mount(<TagPicker tags={tags} value={["kmp"]} onChange={onChange} />);
    const groups = [...view.querySelectorAll("details")];

    expect(groups).toHaveLength(2);
    expect(view.querySelectorAll('.tag-choice[aria-pressed="true"]')).toHaveLength(1);
    expect(
      [...view.querySelectorAll(".tag-choice")].filter((item) => item.textContent === "排序"),
    ).toHaveLength(1);
    expect(groups.find((group) => group.textContent?.includes("字符串"))?.open).toBe(true);
    expect(groups.find((group) => group.textContent?.includes("基础算法"))?.open).toBe(false);

    const remove = view.querySelector('button[aria-label="移除知识点“KMP”"]');
    expect(remove).toBeInstanceOf(HTMLButtonElement);
    act(() => (remove as HTMLButtonElement).click());
    expect(onChange).toHaveBeenCalledWith([]);
  });

  it("搜索分类名称或知识点名称时只展示匹配分类并自动展开", () => {
    const view = mount(<TagPicker tags={tags} value={[]} onChange={() => undefined} />);

    setSearch(view, "基础算法");
    expect(view.querySelectorAll("details")).toHaveLength(1);
    expect(view.querySelector("details")?.open).toBe(true);
    expect(view.textContent).toContain("排序");
    expect(view.textContent).toContain("二分");

    setSearch(view, "  ＫＭＰ  ");
    expect(view.querySelectorAll("details")).toHaveLength(1);
    expect(view.textContent).toContain("字符串");
    expect(view.textContent).toContain("KMP");
    expect(view.textContent).not.toContain("排序");

    setSearch(view, "不存在");
    expect(view.querySelectorAll("details")).toHaveLength(0);
    expect(view.textContent).toContain("没有匹配的知识点或分类");
  });

  it("搜索管理员别名和帮助说明时仍显示正式名称与所属分类", () => {
    const searchable: ProblemTag = {
      id: "shortest-path",
      name: "最短路",
      group: "图论",
      description: "求带权图中两点之间的最小距离",
      aliases: ["Shortest Path", "最短路径"],
    };
    const view = mount(<TagPicker tags={[...tags, searchable]} value={[]} onChange={() => undefined} />);

    setSearch(view, " shortest path ");
    expect(view.textContent).toContain("图论");
    expect(view.textContent).toContain("最短路");
    expect(view.textContent).not.toContain("Shortest Path");

    setSearch(view, "带权图");
    expect(view.textContent).toContain("图论");
    expect(view.textContent).toContain("最短路");
    expect(view.textContent).not.toContain("最小距离");
  });

  it("同步用户折叠状态，并在搜索及搜索变化期间可靠保持匹配分类展开", async () => {
    const view = mount(<TagPicker tags={tags} value={["kmp"]} onChange={() => undefined} />);
    const initialGroup = [...view.querySelectorAll("details")].find((group) =>
      group.textContent?.includes("字符串"),
    );
    const initialSummary = initialGroup?.querySelector("summary");

    expect(initialGroup?.open).toBe(true);
    act(() => (initialSummary as HTMLElement).click());
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(initialGroup?.open).toBe(false);

    setSearch(view, "KMP");
    const searchedGroup = view.querySelector("details");
    const searchedSummary = searchedGroup?.querySelector("summary");
    expect(searchedGroup?.open).toBe(true);

    act(() => (searchedSummary as HTMLElement).click());
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(searchedGroup?.open).toBe(true);

    setSearch(view, "字符串");
    expect(view.querySelector("details")?.open).toBe(true);
    expect(view.textContent).toContain("KMP");
  });

  it("去重传入值，并在达到 30 项上限时禁用未选项", () => {
    const manyTags = Array.from(
      { length: 31 },
      (_, index): ProblemTag => ({
        id: `tag-${index + 1}`,
        name: `知识点 ${index + 1}`,
        group: "测试分类",
      }),
    );
    const selected = [...manyTags.slice(0, 30).map((tag) => tag.id), "tag-1"];
    const onChange = vi.fn();
    const view = mount(<TagPicker tags={manyTags} value={selected} onChange={onChange} />);
    const selectedChoice = buttonByText(view, "知识点 1");
    const unavailableChoice = buttonByText(view, "知识点 31");

    expect(view.textContent).toContain("30 / 30");
    expect(view.textContent).toContain("已达到 30 项上限");
    expect(selectedChoice.disabled).toBe(false);
    expect(unavailableChoice.disabled).toBe(true);

    act(() => selectedChoice.click());
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange.mock.calls[0]?.[0]).toHaveLength(29);
    expect(onChange.mock.calls[0]?.[0]).not.toContain("tag-1");
  });

  it("disabled 状态下所有增删按钮都不能修改选择", () => {
    const onChange = vi.fn();
    const view = mount(<TagPicker tags={tags} value={["sort"]} onChange={onChange} disabled />);

    expect(view.querySelector(".tag-picker")?.getAttribute("aria-disabled")).toBe("true");
    expect([...view.querySelectorAll(".tag-choice, .tag-selected-item")]).not.toHaveLength(0);
    for (const button of view.querySelectorAll(".tag-choice, .tag-selected-item")) {
      expect((button as HTMLButtonElement).disabled).toBe(true);
      act(() => (button as HTMLButtonElement).click());
    }
    expect(onChange).not.toHaveBeenCalled();
  });

  it("受控值变化后自动展开新包含已选项的分类", () => {
    const view = mount(<TagPicker tags={tags} value={[]} onChange={() => undefined} />);
    expect([...view.querySelectorAll("details")].every((group) => !group.open)).toBe(true);

    act(() => root?.render(<TagPicker tags={tags} value={["sort"]} onChange={() => undefined} />));
    const algorithmGroup = [...view.querySelectorAll("details")].find((group) =>
      group.textContent?.includes("基础算法"),
    );
    expect(algorithmGroup?.open).toBe(true);
  });

  it("不允许新选择已停用标签，但保留并允许移除受控值中的旧引用", () => {
    const inactive: ProblemTag = {
      id: "inactive",
      name: "旧知识点",
      group: "基础算法",
      itemKind: "tag",
      active: false,
      category: { id: "category.algorithm", name: "基础算法" },
    };
    const onChange = vi.fn();
    const view = mount(
      <TagPicker tags={[...tags, inactive]} value={[inactive.id]} onChange={onChange} />,
    );

    expect(buttonByText(view, "旧知识点（已停用）").classList).toContain("tag-selected-item");
    expect(view.querySelectorAll(".tag-choice")).toHaveLength(3);
    act(() => buttonByText(view, "旧知识点（已停用）").click());
    expect(onChange).toHaveBeenCalledWith([]);
  });
});
