import { ArrowLeft, FilePlus2 } from "lucide-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import type { ProblemType } from "@urmotiv/contracts";
import { MarkdownEditor } from "../components/markdown-editor";
import { TagPicker } from "../components/tag-picker";
import { createProblem, getSession, listTags } from "../lib/api";

export function CreateProblemPage() {
  const navigate = useNavigate();
  const client = useQueryClient();
  const tags = useQuery({ queryKey: ["tags"], queryFn: listTags, staleTime: 5 * 60_000 });
  const session = useQuery({ queryKey: ["session"], queryFn: getSession, staleTime: 60_000 });
  const canCreateProblem = session.data?.user?.permissions.includes("problem.create") ?? false;
  const sessionReady = session.status !== "pending";
  const [title, setTitle] = useState("");
  const [type, setType] = useState<ProblemType>("traditional");
  const [tagIds, setTagIds] = useState<string[]>([]);
  const [difficulty, setDifficulty] = useState("");
  const [thinkingLevel, setThinkingLevel] = useState("");
  const [codingLevel, setCodingLevel] = useState("");
  const [basicStatement, setBasicStatement] = useState("");
  const [basicSolution, setBasicSolution] = useState("");

  const create = useMutation({
    mutationFn: createProblem,
    onSuccess: (problem) => {
      client.invalidateQueries({ queryKey: ["problems"] });
      navigate(`/problems/${encodeURIComponent(problem.id)}`);
    }
  });

  const submit = () => {
    create.mutate({
      title,
      type,
      tagIds,
      codeforcesDifficulty: difficulty ? Number(difficulty) : null,
      thinkingLevel: thinkingLevel ? Number(thinkingLevel) as 1 | 2 | 3 | 4 | 5 : null,
      codingLevel: codingLevel ? Number(codingLevel) as 1 | 2 | 3 | 4 | 5 : null,
      content: {
        basicStatement,
        basicSolution,
        background: "",
        statement: "",
        inputFormat: "",
        outputFormat: "",
        constraints: "",
        solution: "",
        hints: ""
      },
      samples: [],
      judgeConfig: null
    });
  };

  if (sessionReady && !canCreateProblem) {
    return (
      <section className="create-problem-page">
        <div className="centered-message" role="alert">
          <FilePlus2 size={28} aria-hidden="true" />
          <h1>当前账号不能新建题目</h1>
          <p>你没有问题目创建权限，只能查看自己和可访问的题目。</p>
          <Link to="/problems">返回题目列表</Link>
        </div>
      </section>
    );
  }

  return (
    <section className="create-problem-page">
      <div className="page-heading">
        <div>
          <Link className="back-link" to="/problems">
            <ArrowLeft size={16} aria-hidden="true" />
            返回题目列表
          </Link>
          <p className="eyebrow">投稿</p>
          <h1>新建题目</h1>
          <p>先建立可审阅的草稿，之后再补充样例、数据和附件。</p>
        </div>
        <FilePlus2 className="page-heading-icon" size={32} aria-hidden="true" />
      </div>

      <div className="form-section">
        <div className="section-heading">
          <span>01</span>
          <div>
            <h2>基本信息</h2>
            <p>题目名称、类型和至少一个知识点是提交审核前的必填项。</p>
          </div>
        </div>
        <div className="form-grid">
          <label className="field wide">
            <span>题目名称</span>
            <input value={title} onChange={(event) => setTitle(event.target.value)} maxLength={200} />
          </label>
          <label className="field">
            <span>题目类型</span>
            <select value={type} onChange={(event) => setType(event.target.value as ProblemType)}>
              <option value="traditional">传统题</option>
              <option value="interactive">交互题</option>
              <option value="submit_answer">提交答案题</option>
            </select>
          </label>
          <label className="field">
            <span>CF 难度（可选）</span>
            <input
              value={difficulty}
              onChange={(event) => setDifficulty(event.target.value)}
              type="number"
              min={800}
              max={3500}
              step={100}
              placeholder="例如 1600"
            />
          </label>
          <label className="field">
            <span>思维难度（可选）</span>
            <select value={thinkingLevel} onChange={(event) => setThinkingLevel(event.target.value)}>
              <option value="">暂不填写</option>
              <option value="1">1</option>
              <option value="2">2</option>
              <option value="3">3</option>
              <option value="4">4</option>
              <option value="5">5</option>
            </select>
          </label>
          <label className="field">
            <span>代码难度（可选）</span>
            <select value={codingLevel} onChange={(event) => setCodingLevel(event.target.value)}>
              <option value="">暂不填写</option>
              <option value="1">1</option>
              <option value="2">2</option>
              <option value="3">3</option>
              <option value="4">4</option>
              <option value="5">5</option>
            </select>
          </label>
          <div className="field wide">
            <span>知识点</span>
            {tags.isLoading ? <p className="field-help">正在加载知识点…</p> : null}
            {tags.isError ? <p className="form-error">{tags.error.message}</p> : null}
            <TagPicker tags={tags.data?.items ?? []} value={tagIds} onChange={setTagIds} />
          </div>
        </div>
      </div>

      <div className="form-section">
        <div className="section-heading">
          <span>02</span>
          <div>
            <h2>基础审核内容</h2>
            <p>进入待审核后，这两项会冻结，题目名称仍可修改；驳回后可以继续修改。</p>
          </div>
        </div>
        <MarkdownEditor
          label="基础题面"
          value={basicStatement}
          onChange={setBasicStatement}
          helper="用简洁文字说明任务、输入和输出，不必在此阶段写完整数据范围。"
        />
        <MarkdownEditor
          label="基础题解"
          value={basicSolution}
          onChange={setBasicSolution}
          helper="说明主要思路和正确性理由，方便审题人判断题目是否成立。"
        />
      </div>

      {create.error ? <div className="inline-error">{create.error.message}</div> : null}
      <div className="sticky-form-actions">
        <span>创建后仍是草稿，不会直接进入审核。</span>
        <button
          className="primary-button"
          type="button"
          disabled={!title.trim() || create.isPending}
          onClick={submit}
        >
          {create.isPending ? "正在创建…" : "创建草稿"}
        </button>
      </div>
    </section>
  );
}
