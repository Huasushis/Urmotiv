import { useState } from "react";
import { MarkdownPreview } from "./markdown-editor";
import { sourceLanguages, sourcePreview, type StandardProgram } from "../lib/standard-program";
export function StandardProgramEditor({
  value,
  onChange,
  readOnly = false,
}: {
  value: StandardProgram;
  onChange: (value: StandardProgram) => void;
  readOnly?: boolean;
}) {
  const [preview, setPreview] = useState(false);
  return (
    <section className="standard-program-editor" aria-label="标准程序源码">
      <div className="inline-actions">
        <label>
          程序语言
          <select
            value={value.language}
            disabled={readOnly}
            onChange={(event) => onChange({ ...value, language: event.target.value })}
          >
            {sourceLanguages.map((language) => (
              <option key={language.id} value={language.id}>
                {language.name}
              </option>
            ))}
          </select>
        </label>
        <button type="button" className="secondary-button" onClick={() => setPreview(!preview)}>
          {preview ? "编辑源码" : "高亮预览"}
        </button>
      </div>
      {preview || readOnly ? (
        <MarkdownPreview value={sourcePreview(value.source, value.language)} />
      ) : (
        <label className="field">
          标准程序（std）
          <textarea
            className="source-textarea"
            aria-label="标准程序（std）"
            spellCheck={false}
            rows={16}
            maxLength={500000}
            value={value.source}
            onChange={(event) => onChange({ ...value, source: event.target.value })}
          />
        </label>
      )}
      <p className="field-help">
        直接粘贴源码，无需上传文件。仅作者及有内部资料权限的人可读；本站不编译或运行代码。
      </p>
    </section>
  );
}
