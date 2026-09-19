import {useEffect, useRef, useState, type InputHTMLAttributes} from "react";

type SearchInputProps = Omit<InputHTMLAttributes<HTMLInputElement>, "value" | "onChange" | "onSubmit"> & {
  value: string;
  onSearch: (value: string) => void;
};

/** 保留输入法候选文字，确认输入后再更新搜索条件。 */
export function SearchInput({value, onSearch, ...props}: SearchInputProps) {
  const [draft, setDraft] = useState(value);
  const [composing, setComposing] = useState(false);
  const callback = useRef(onSearch);
  callback.current = onSearch;
  useEffect(() => { setDraft(value); }, [value]);
  useEffect(() => {
    if (composing || draft === value) return;
    const timer = window.setTimeout(() => callback.current(draft), 350);
    return () => window.clearTimeout(timer);
  }, [draft, value, composing]);
  return <input {...props} value={draft}
    onChange={event => setDraft(event.currentTarget.value)}
    onCompositionStart={() => setComposing(true)}
    onCompositionEnd={event => {setDraft(event.currentTarget.value); setComposing(false);}}
    onKeyDown={event => {
      props.onKeyDown?.(event);
      if (event.key === "Enter" && !composing && !event.nativeEvent.isComposing && event.keyCode !== 229) {
        event.preventDefault(); callback.current(draft);
      }
    }} />;
}
