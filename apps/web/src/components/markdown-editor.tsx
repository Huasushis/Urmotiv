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
  problemId?: string | undefined;
  onUploadImage?: ((file: File) => Promise<string>) | undefined;
  uploadDisabled?: boolean;
  readOnly?: boolean;
  frozen?: boolean;
  helper?: string;
  minRows?: number;
};

type EditorMode = "edit" | "preview";

export function MarkdownPreview({ value, problemId }: { value: string; problemId?: string | undefined }) {
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
            const controlledFile = isControlledProblemFileSource(src, problemId);
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
  problemId,
  onUploadImage,
  uploadDisabled = false,
  readOnly = false,
  frozen = false,
  helper,
  minRows = 12
}: MarkdownEditorProps) {
  const [mode, setMode] = useState<EditorMode>("edit");
  const [uploadingImage, setUploadingImage] = useState(false);
  const [imageUploadError, setImageUploadError] = useState<string | null>(null);
  const textAreaRef = useRef<HTMLTextAreaElement>(null);
  const imageInputRef = useRef<HTMLInputElement>(null);

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

  const selectImage = () => {
    if (readOnly || uploadDisabled || uploadingImage || onUploadImage === undefined) {
      return;
    }
    setImageUploadError(null);
    if (imageInputRef.current) {
      imageInputRef.current.value = "";
      imageInputRef.current.click();
    }
  };

  const uploadSelectedImage = async (file: File) => {
    const field = textAreaRef.current;
    if (field === null || onUploadImage === undefined) {
      return;
    }
    if (!["image/png", "image/jpeg", "image/gif", "image/webp"].includes(file.type.trim().toLowerCase())) {
      setImageUploadError("仅支持 PNG、JPEG、GIF 或 WebP 图片。");
      return;
    }
    const start = field.selectionStart;
    const end = field.selectionEnd;
    const selected = value.slice(start, end).trim();
    const alt = (selected || "题面图片")
      .replace(/[\r\n]+/g, " ")
      .replace(/([\\\[\]])/g, "\\$1");
    setUploadingImage(true);
    setImageUploadError(null);
    try {
      const source = await onUploadImage(file);
      const markdown = `![${alt}](${source})`;
      const next = `${value.slice(0, start)}${markdown}${value.slice(end)}`;
      onChange(next);
      requestAnimationFrame(() => {
        field.focus();
        field.setSelectionRange(start + markdown.length, start + markdown.length);
      });
    } catch (error) {
      setImageUploadError(error instanceof Error ? error.message : "图片上传失败，请稍后重试。");
    } finally {
      setUploadingImage(false);
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
    {
      label: "上传并插入图片",
      icon: Image,
      onClick: selectImage,
      disabled: uploadDisabled || onUploadImage === undefined
    },
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
        {toolButtons.map(({ icon: Icon, label: toolLabel, onClick, disabled = false }) => (
          <button
            className="icon-button"
            type="button"
            title={toolLabel}
            aria-label={toolLabel}
            onClick={onClick}
            disabled={readOnly || uploadingImage || disabled}
            key={toolLabel}
          >
            <Icon size={16} aria-hidden="true" />
          </button>
        ))}
        <input
          ref={imageInputRef}
          className="problem-file-input"
          type="file"
          accept="image/png,image/jpeg,image/gif,image/webp"
          tabIndex={-1}
          onChange={(event) => {
            const file = event.target.files?.[0];
            event.target.value = "";
            if (file !== undefined) {
              void uploadSelectedImage(file);
            }
          }}
        />
      </div>
      {uploadingImage ? <p className="editor-file-status" aria-live="polite">正在上传图片，请勿提交题目…</p> : null}
      {imageUploadError ? <p className="inline-error editor-file-error" role="alert">{imageUploadError}</p> : null}
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
            readOnly={readOnly || uploadingImage}
            rows={minRows}
            spellCheck="false"
          />
        </div>
        <div className="editor-preview-pane" aria-label={`${label} 预览`}>
          <MarkdownPreview value={value} problemId={problemId} />
        </div>
      </div>
    </section>
  );
}

function isControlledProblemFileSource(
  source: string | undefined,
  problemId: string | undefined
): boolean {
  if (source === undefined || problemId === undefined) {
    return false;
  }
  const prefix = `/api/v1/problems/${encodeURIComponent(problemId)}/files/`;
  if (!source.startsWith(prefix)) {
    return false;
  }
  const fileId = source.slice(prefix.length);
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(fileId);
}
