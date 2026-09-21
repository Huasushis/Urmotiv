import { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import type { AiDraftResult, ProblemTag } from "@urmotiv/contracts";
import { getAiDraftAvailability, getAiDraft, startAiDraft } from "../lib/api";
import { MarkdownPreview } from "./markdown-editor";
import { TagPicker } from "./tag-picker";
export function AiDraftImport({
  onApply,
  onCreate,
  tagIds,
  tags,
  onTagsChange,
  creating,
}: {
  onApply: (result: AiDraftResult) => void;
  onCreate: (result: AiDraftResult) => void;
  tagIds: string[];
  tags: ProblemTag[];
  onTagsChange: (ids: string[]) => void;
  creating: boolean;
}) {
  const available = useQuery({
    queryKey: ["ai-draft-availability"],
    queryFn: getAiDraftAvailability,
    retry: false,
    staleTime: 60_000,
  });
  const [text, setText] = useState(""),
    [jobId, setJobId] = useState<string | null>(null);
  const start = useMutation({
    mutationFn: startAiDraft,
    onSuccess: (job) => setJobId(job.id),
  });
  const job = useQuery({
    queryKey: ["ai-draft", jobId],
    queryFn: () => getAiDraft(jobId!),
    enabled: !!jobId,
    retry: false,
    refetchInterval: (query) =>
      query.state.data?.status === "running" ? 5000 : false,
  });
  const running =
    start.isPending ||
    (!!jobId && (job.isPending || job.data?.status === "running"));
  if (!available.data?.available) return null;
  const result = job.data?.result;
  return (
    <details className="problem-template-import ai-draft-import">
      <summary>AI 快速建题：粘贴题面、题解和标程</summary>
      <p>
        模型只选择原文行号，服务器提取对应文本，不润色、不补造。确认内容后填入草稿表单，所有内容仍可编辑。
      </p>
      <label>
        整段投稿材料
        <textarea
          value={text}
          rows={10}
          maxLength={200000}
          disabled={running}
          onChange={(event) => {
            setText(event.target.value);
            setJobId(null);
          }}
          placeholder="可以包含基础题面、题解、输入输出、样例和 std / 标程。"
        />
      </label>
      <button
        className="secondary-button"
        type="button"
        disabled={!text.trim() || running}
        onClick={() => {
          setJobId(null);
          start.mutate(text);
        }}
      >
        {running ? "正在识别…" : "自动识别"}
      </button>
      {running ? (
        <p role="status">
          正在等待模型完成；无需重复点击。当前页面保留你的原文。
        </p>
      ) : null}
      {start.error || job.error || job.data?.error ? (
        <p role="alert">
          {job.data?.error ?? "无法完成识别，请稍后重试。未创建任何题目。"}
        </p>
      ) : null}
      {result ? (
        <section className="template-preview">
          <h3>{result.title}</h3>
          <h4>基础题面</h4>
          <MarkdownPreview value={result.content.basicStatement} />
          <h4>基础题解</h4>
          <MarkdownPreview value={result.content.basicSolution ?? ""} />
          <p>
            {result.samples.length} 组样例；
            {result.standardSolution
              ? "包含标程，将原样放入正式题解供后续整理。"
              : "没有识别出标程。"}
          </p>
          <details>
            <summary>查看全部提取字段</summary>
            {Object.entries(result.content).map(([key, value]) => (
              <div key={key}>
                <strong>
                  {
                    (
                      {
                        background: "背景",
                        statement: "正式题面",
                        inputFormat: "输入格式",
                        outputFormat: "输出格式",
                        constraints: "约束",
                        solution: "正式题解",
                        hints: "提示",
                        basicStatement: "基础题面",
                        basicSolution: "基础题解",
                      } as Record<string, string>
                    )[key]
                  }
                </strong>
                <pre>{value || "（未提供）"}</pre>
              </div>
            ))}
            {result.samples.map((sample, index) => (
              <div key={sample.id}>
                <strong>样例 {index + 1}</strong>
                <pre>{sample.input}</pre>
                <pre>{sample.output}</pre>
                <pre>{sample.explanation}</pre>
              </div>
            ))}
            {result.standardSolution ? (
              <pre>{result.standardSolution}</pre>
            ) : null}
          </details>
          {result.unclassified.trim() ? (
            <details open>
              <summary>
                尚未分类的原文（确认后保留在正式题解中，避免泄露解法）
              </summary>
              <pre>{result.unclassified}</pre>
            </details>
          ) : null}
        <TagPicker
          inline
            tags={tags}
            value={tagIds}
            onChange={onTagsChange}
            disabled={creating}
          />
          <p className="muted-note">
            选择至少一个知识点，即可直接建立草稿。不会自动提交审核。
          </p>
          <div className="inline-actions">
            <button
              className="primary-button"
              type="button"
              disabled={creating || tagIds.length === 0}
              onClick={() => onCreate(result)}
            >
              {creating ? "正在创建…" : "确认并创建草稿"}
            </button>
            <button
              className="secondary-button"
              type="button"
              disabled={creating}
              onClick={() => onApply(result)}
            >
              确认并填入草稿表单
            </button>
          </div>
        </section>
      ) : null}
    </details>
  );
}
