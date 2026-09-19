import {act} from "react";
import {createRoot, type Root} from "react-dom/client";
import {afterEach, expect, it, vi} from "vitest";
import {SearchInput} from "./search-input";
let root: Root | undefined;
let element: HTMLDivElement | undefined;
afterEach(() => {act(() => root?.unmount()); element?.remove(); vi.useRealTimers();});
it("输入法确认前不提交，确认后只搜索最终中文，并支持回退同步", async () => {
  vi.useFakeTimers();
  const onSearch = vi.fn();
  element = document.createElement("div"); document.body.append(element);
  root = createRoot(element);
  act(() => root!.render(<SearchInput value="" onSearch={onSearch} />));
  const input = element.querySelector("input")!;
  act(() => input.dispatchEvent(new CompositionEvent("compositionstart", {bubbles: true})));
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "zhong");
    input.dispatchEvent(new Event("input", {bubbles: true}));
    input.dispatchEvent(new KeyboardEvent("keydown", {key: "Enter", isComposing: true, bubbles: true}));
  });
  await act(async () => {vi.advanceTimersByTime(500);});
  expect(onSearch).not.toHaveBeenCalled();
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "中文");
    input.dispatchEvent(new CompositionEvent("compositionend", {data: "中文", bubbles: true}));
  });
  await act(async () => {vi.advanceTimersByTime(350);});
  expect(onSearch).toHaveBeenCalledExactlyOnceWith("中文");
  act(() => root!.render(<SearchInput value="返回的条件" onSearch={onSearch} />));
  expect(input.value).toBe("返回的条件");
  await act(async () => {vi.advanceTimersByTime(500);});
  expect(onSearch).toHaveBeenCalledTimes(1);
});
