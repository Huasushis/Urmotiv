import { Download, FileUp } from "lucide-react";
import { useState } from "react";
import {
  parseProblemTemplate,
  problemTemplate,
  templateSections,
  type ParsedProblemTemplate,
} from "../lib/problem-template";
export function ProblemTemplateImport({
  onApply,
}: {
  onApply: (draft: ParsedProblemTemplate) => void;
}) {
  const [source, setSource] = useState(""),
    [preview, setPreview] = useState<ParsedProblemTemplate | null>(null),
    [error, setError] = useState("");
  return (
    <details className="template-import">
      <summary>使用 Markdown 模板投稿</summary>
      <div className="template-import-body">
        <div className="admin-actions">
          <button
            className="secondary-button"
            onClick={() => {
              const url = URL.createObjectURL(
                new Blob([problemTemplate], {
                  type: "text/markdown;charset=utf-8",
                }),
              );
              const link = document.createElement("a");
              link.href = url;
              link.download = "urmotiv-template.md";
              link.click();
              setTimeout(() => URL.revokeObjectURL(url), 1000);
            }}
          >
            <Download size={16} />
            下载空白模板
          </button>
          <label className="secondary-button template-upload">
            <FileUp size={16} />
            选择 Markdown 文件
            <input
              type="file"
              accept=".md,.markdown,text/markdown,text/plain"
              onChange={async (event) => {
                const file = event.target.files?.[0];
                event.target.value = "";
                if (!file) return;
                if (file.size > 1_000_000) {
                  setError("模板文件不能超过 1 MB。");
                  return;
                }
                try {
                  setSource(await file.text());
                  setPreview(null);
                  setError("");
                } catch {
                  setError("无法读取这个文件。");
                }
              }}
            />
          </label>
        </div>
        <label className="field">
          模板内容
          <textarea
            rows={10}
            value={source}
            onChange={(event) => {
              setSource(event.target.value);
              setPreview(null);
            }}
            maxLength={1000000}
          />
        </label>
        <button
          className="secondary-button"
          onClick={() => {
            try {
              setPreview(parseProblemTemplate(source));
              setError("");
            } catch (reason) {
              setPreview(null);
              setError(
                reason instanceof Error ? reason.message : "无法识别模板。",
              );
            }
          }}
        >
          识别并预览
        </button>
        {error ? <p role="alert">{error}</p> : null}
        {preview ? (
          <div className="template-preview">
            <h3>{preview.title}</h3>
            <ul>
              {Object.entries(templateSections)
                .filter(([, key]) => preview.content[key])
                .map(([label, key]) => (
                  <li key={key}>
                    {label}：{preview.content[key]?.length ?? 0} 字符
                  </li>
                ))}
            </ul>
            <p>{preview.samples.length} 组样例</p>
            <button className="primary-button" onClick={() => onApply(preview)}>
              填入创建表单
            </button>
          </div>
        ) : null}
      </div>
    </details>
  );
}
