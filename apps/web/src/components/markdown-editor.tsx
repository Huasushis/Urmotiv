import {
  Bold,
  Code2,
  Heading2,
  Image,
  Italic,
  Link,
  Redo2,
  Sigma,
  Table2,
  Undo2
} from "lucide-react";
import { useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import rehypeKatex from "rehype-katex";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";

type MarkdownEditorProps = {
  label: string;
  value: string;
  onChange: (value: string) => void;
  readOnly?: boolean;
  frozen?: boolean;
  helper?: string;
  minRows?: number;
};

type EditorMode = "edit" | "preview";

export function MarkdownPreview({ value }: { value: string }) {
  if (!value.trim()) {
    return <p className="empty-preview">暂无内容</p>;
  }

  return (
    <div className="markdown-body">
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkMath]}
        rehypePlugins={[rehypeKatex]}
        components={{
          img: ({ src, alt }) => {
            const controlledFile =
              typeof src === "string" && /^\/api\/v1\/files\/[A-Za-z0-9-]+(?:\?.*)?$/.test(src);
            if (!controlledFile) {
              return <span className="blocked-markdown-image">外部图片已隐藏</span>;
            }
            return <img src={src} alt={alt ?? ""} loading="lazy" referrerPolicy="no-referrer" />;
          }
        }}
      >
        {value}
      </ReactMarkdown>
    </div>
  );
}

export function MarkdownEditor({
  label,
  value,
  onChange,
  readOnly = false,
  frozen = false,
  helper,
  minRows = 12
}: MarkdownEditorProps) {
  const [mode, setMode] = useState<EditorMode>("edit");
  const textAreaRef = useRef<HTMLTextAreaElement>(null);

  const insert = (prefix: string, suffix: string, placeholder: string) => {
    const field = textAreaRef.current;
    if (!field || readOnly) {
      return;
    }
    const start = field.selectionStart;
    const end = field.selectionEnd;
    const selected = value.slice(start, end) || placeholder;
    const next = `${value.slice(0, start)}${prefix}${selected}${suffix}${value.slice(end)}`;
    onChange(next);
    requestAnimationFrame(() => {
      field.focus();
      field.setSelectionRange(start + prefix.length, start + prefix.length + selected.length);
    });
  };

  const applyHistory = (command: "undo" | "redo") => {
    if (!readOnly) {
      document.execCommand(command);
      textAreaRef.current?.focus();
    }
  };

  const toolButtons = [
    { label: "撤销", icon: Undo2, onClick: () => applyHistory("undo") },
    { label: "重做", icon: Redo2, onClick: () => applyHistory("redo") },
    { label: "二级标题", icon: Heading2, onClick: () => insert("## ", "", "标题") },
    { label: "粗体", icon: Bold, onClick: () => insert("**", "**", "重点") },
    { label: "斜体", icon: Italic, onClick: () => insert("*", "*", "强调") },
    { label: "行内代码", icon: Code2, onClick: () => insert("`", "`", "代码") },
    { label: "链接", icon: Link, onClick: () => insert("[", "](https://)", "链接文字") },
    { label: "图片引用", icon: Image, onClick: () => insert("![", "](/api/v1/files/文件编号)", "图片说明") },
    {
      label: "表格",
      icon: Table2,
      onClick: () => insert("\n| 列 1 | 列 2 |\n| --- | --- |\n| ", " | 内容 |\n", "内容")
    },
    { label: "公式", icon: Sigma, onClick: () => insert("$", "$", "x^2") }
  ];

  return (
    <section className="markdown-editor" aria-label={label}>
      <div className="editor-heading">
        <div>
          <h3>{label}</h3>
          {helper ? <p>{helper}</p> : null}
        </div>
        {frozen ? <span className="frozen-note">审核期间已冻结</span> : null}
      </div>
      <div className="editor-toolbar" aria-label={`${label} 编辑工具`}>
        {toolButtons.map(({ icon: Icon, label: toolLabel, onClick }) => (
          <button
            className="icon-button"
            type="button"
            title={toolLabel}
            aria-label={toolLabel}
            onClick={onClick}
            disabled={readOnly}
            key={toolLabel}
          >
            <Icon size={16} aria-hidden="true" />
          </button>
        ))}
      </div>
      <div className="mobile-editor-mode" role="group" aria-label="手机编辑视图">
        <button
          type="button"
          className={mode === "edit" ? "selected" : ""}
          onClick={() => setMode("edit")}
        >
          编辑
        </button>
        <button
          type="button"
          className={mode === "preview" ? "selected" : ""}
          onClick={() => setMode("preview")}
        >
          预览
        </button>
      </div>
      <div className={`editor-columns mode-${mode}`}>
        <div className="editor-input-pane">
          <textarea
            ref={textAreaRef}
            value={value}
            onChange={(event) => onChange(event.target.value)}
            placeholder="使用 Markdown 编写内容"
            readOnly={readOnly}
            rows={minRows}
            spellCheck="false"
          />
        </div>
        <div className="editor-preview-pane" aria-label={`${label} 预览`}>
          <MarkdownPreview value={value} />
        </div>
      </div>
    </section>
  );
}
