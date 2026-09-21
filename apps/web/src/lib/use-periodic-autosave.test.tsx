import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { usePeriodicAutosave } from "./use-periodic-autosave";
let dispose: () => void = () => {};
afterEach(() => {
  dispose();
  vi.useRealTimers();
});
it("连续编辑按固定间隔保存，输入法组词和失败时暂停，离开未保存页面提醒", () => {
  vi.useFakeTimers();
  const save = vi.fn(),
    element = document.createElement("div");
  document.body.append(element);
  const root = createRoot(element);
  let enabled = true,
    dirty = true;
  function View() {
    usePeriodicAutosave(save, enabled, dirty);
    return null;
  }
  dispose = () => {
    act(() => root.unmount());
    element.remove();
  };
  act(() => root.render(<View />));
  act(() => vi.advanceTimersByTime(14_000));
  expect(save).not.toHaveBeenCalled();
  act(() => {
    root.render(<View />);
    vi.advanceTimersByTime(1_000);
  });
  expect(save).toHaveBeenCalledTimes(1);
  act(() => {
    window.dispatchEvent(new Event("compositionstart"));
    vi.advanceTimersByTime(15_000);
  });
  expect(save).toHaveBeenCalledTimes(1);
  act(() => {
    window.dispatchEvent(new Event("compositionend"));
    vi.advanceTimersByTime(15_000);
  });
  expect(save).toHaveBeenCalledTimes(2);
  enabled = false;
  act(() => root.render(<View />));
  act(() => vi.advanceTimersByTime(15_000));
  expect(save).toHaveBeenCalledTimes(2);
  const event = new Event("beforeunload", { cancelable: true });
  window.dispatchEvent(event);
  expect(event.defaultPrevented).toBe(true);
  dirty = false;
  act(() => root.render(<View />));
  const clean = new Event("beforeunload", { cancelable: true });
  window.dispatchEvent(clean);
  expect(clean.defaultPrevented).toBe(false);
});
