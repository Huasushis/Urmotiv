import { useEffect, useRef } from "react";

/** 防抖之外的最长保存间隔：连续输入也会落盘，输入法组词期间不提交半成品。 */
export function usePeriodicAutosave(
  save: () => void,
  enabled: boolean,
  dirty: boolean,
) {
  const current = useRef({ save, enabled, dirty });
  current.current = { save, enabled, dirty };
  const composing = useRef(false);
  useEffect(() => {
    const start = () => {
      composing.current = true;
    };
    const end = () => {
      composing.current = false;
    };
    const tick = () => {
      if (current.current.enabled && !composing.current) current.current.save();
    };
    const warn = (event: BeforeUnloadEvent) => {
      if (current.current.dirty) {
        event.preventDefault();
        event.returnValue = "";
      }
    };
    const timer = window.setInterval(tick, 15_000);
    window.addEventListener("compositionstart", start);
    window.addEventListener("compositionend", end);
    window.addEventListener("beforeunload", warn);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("compositionstart", start);
      window.removeEventListener("compositionend", end);
      window.removeEventListener("beforeunload", warn);
    };
  }, []);
  return composing;
}
