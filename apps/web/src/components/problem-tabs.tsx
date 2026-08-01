import {
  AlertTriangle,
  ChevronDown,
  ChevronUp,
  ExternalLink,
  FileCode2,
  FileUp,
  LockKeyhole,
  Plus,
  Search,
  ShieldCheck,
  Trash2
} from "lucide-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { z } from "zod";
import type {
  Problem,
  ProblemJudgeConfig,
  ProblemSample,
  ReviewInput,
  ReviewItemView,
  ReviewSuggestionField
} from "@urmotiv/contracts";
import {
  ApiError,
  applyReviewSuggestions,
  createReview,
  getProblem,
  getReviewSuggestions,
  listReviewItems,
  listReviews,
  listTags
} from "../lib/api";
import { dateTime, isFrozen, reviewVerdictText, statusText, typeText } from "../lib/presentation";
import { MarkdownEditor } from "./markdown-editor";
import {
  JudgeProgramPanel,
  ProblemFilesPanel,
  useStatementImageUploader
} from "./problem-files";
import { TagPicker } from "./tag-picker";

export type ProblemUpdater = (updater: (problem: Problem) => Problem) => void;

type ProblemTabProps = {
  problem: Problem;
  update: ProblemUpdater;
  fileUploadsDisabled?: boolean;
  onFileRevisionChange?: ((revision: number) => void) | undefined;
  onFileUploadPendingChange?: ((pending: boolean) => void) | undefined;
  onJudgeProgramBound?: ((revision: number, judgeConfig: ProblemJudgeConfig) => void) | undefined;
};

function setContent(problem: Problem, key: keyof Problem["content"], value: string): Problem {
  return { ...problem, content: { ...problem.content, [key]: value } };
}

function judgeConfigForType(
  config: ProblemJudgeConfig | null,
  type: Problem["type"]
): ProblemJudgeConfig | null {
  if (config === null) return null;
  const {
    checker: _checker,
    interactor: _interactor,
    answerChecker: _answerChecker,
    ...withoutProgram
  } = config;
  return type === "traditional"
    ? { ...withoutProgram, checker: { type: "standard" } }
    : withoutProgram;
}

export function OverviewTab({ problem, update }: ProblemTabProps) {
  const tags = useQuery({ queryKey: ["tags"], queryFn: listTags, staleTime: 5 * 60_000 });
  const canEdit = problem.capabilities.canEdit;
  const titleFrozen = isFrozen(problem.status, "title") && !problem.capabilities.canEditFrozen;

  return (
    <div className="workspace-section overview-tab">
      <div className="section-heading workspace-section-heading">
        <span>01</span>
        <div>
          <h2>概要</h2>
          <p>用于检索、审核和组题的基础信息。</p>
        </div>
      </div>

      <div className="form-grid">
        <label className="field wide">
          <span>题目名称</span>
          <input
            value={problem.title}
            onChange={(event) => update((current) => ({ ...current, title: event.target.value }))}
            disabled={!canEdit || titleFrozen}
          />
          {titleFrozen ? <small>进入审核后名称已冻结；撤回或驳回后可继续修改。</small> : null}
        </label>
        <label className="field">
          <span>题目类型</span>
          <select
            value={problem.type}
            onChange={(event) =>
              update((current) => {
                const type = event.target.value as Problem["type"];
                return {
                  ...current,
                  type,
                  judgeConfig: judgeConfigForType(current.judgeConfig, type)
                };
              })
            }
            disabled={!canEdit}
          >
            <option value="traditional">传统题</option>
            <option value="interactive">交互题</option>
            <option value="submit_answer">提交答案题</option>
          </select>
        </label>
        <label className="field">
          <span>CF 难度</span>
          <input
            type="number"
            min={800}
            max={3500}
            step={100}
            value={problem.codeforcesDifficulty ?? ""}
            onChange={(event) =>
              update((current) => ({
                ...current,
                codeforcesDifficulty: event.target.value ? Number(event.target.value) : null
              }))
            }
            disabled={!canEdit}
            placeholder="800–3500"
          />
        </label>
        <div className="field wide">
          <span>知识点</span>
          {tags.isError ? <p className="form-error">{tags.error.message}</p> : null}
          <TagPicker
            tags={tags.data?.items ?? []}
            value={problem.tagIds}
            onChange={(tagIds) => update((current) => ({ ...current, tagIds }))}
            disabled={!canEdit}
          />
        </div>
        <label className="field">
          <span>思维难度</span>
          <select value={problem.thinkingLevel ?? ""} disabled>
            <option value="">暂不填写</option>
            <option value="1">1</option>
            <option value="2">2</option>
            <option value="3">3</option>
            <option value="4">4</option>
            <option value="5">5</option>
          </select>
          <small>评分标准确认后开放填写。</small>
        </label>
        <label className="field">
          <span>代码难度</span>
          <select value={problem.codingLevel ?? ""} disabled>
            <option value="">暂不填写</option>
            <option value="1">1</option>
            <option value="2">2</option>
            <option value="3">3</option>
            <option value="4">4</option>
            <option value="5">5</option>
          </select>
          <small>评分标准确认后开放填写。</small>
        </label>
      </div>

      <dl className="metadata-list">
        <div><dt>作者</dt><dd>{problem.owner.nickname}</dd></div>
        <div><dt>当前状态</dt><dd>{statusText[problem.status]}</dd></div>
        <div><dt>当前修订</dt><dd>第 {problem.revision} 版</dd></div>
        <div><dt>审核轮次</dt><dd>{problem.reviewRound ? `第 ${problem.reviewRound} 轮` : "尚未提交"}</dd></div>
        <div><dt>题目类型</dt><dd>{typeText[problem.type]}</dd></div>
        <div><dt>最近更新</dt><dd>{dateTime(problem.updatedAt)}</dd></div>
      </dl>
    </div>
  );
}

export function StatementTab({
  problem,
  update,
  fileUploadsDisabled = false,
  onFileRevisionChange,
  onFileUploadPendingChange
}: ProblemTabProps) {
  const canEdit = problem.capabilities.canEdit;
  const basicFrozen = isFrozen(problem.status, "content.basicStatement") && !problem.capabilities.canEditFrozen;
  const uploadStatementImage = useStatementImageUploader(problem, {
    onRevisionChange: onFileRevisionChange,
    onPendingChange: onFileUploadPendingChange
  });

  const editor = (label: string, key: keyof Problem["content"], helper: string, frozen = false) => (
    <MarkdownEditor
      label={label}
      value={problem.content[key]}
      onChange={(value) => update((current) => setContent(current, key, value))}
      problemId={problem.id}
      onUploadImage={uploadStatementImage}
      uploadDisabled={fileUploadsDisabled}
      readOnly={!canEdit || frozen}
      frozen={frozen}
      helper={helper}
    />
  );

  return (
    <div className="workspace-section stacked-editors">
      {editor("基础题面", "basicStatement", "这是审题人判断任务是否清楚、是否成立的稳定版本。", basicFrozen)}
      {editor("题目背景", "background", "可选。只保留与理解任务有关的背景。")}
      {editor("题目描述", "statement", "完整说明需要完成的任务。")}
      <div className="two-editor-grid">
        {editor("输入格式", "inputFormat", "逐项说明输入内容和顺序。")}
        {editor("输出格式", "outputFormat", "说明需要输出的值及格式。")}
      </div>
    </div>
  );
}

function newSample(): ProblemSample {
  return { id: crypto.randomUUID(), input: "", output: "", explanation: "" };
}

export function SamplesTab({ problem, update }: ProblemTabProps) {
  const canEdit = problem.capabilities.canEdit;
  const updateSample = (id: string, field: keyof Omit<ProblemSample, "id">, value: string) => {
    update((current) => ({
      ...current,
      samples: current.samples.map((sample) => (sample.id === id ? { ...sample, [field]: value } : sample))
    }));
  };

  return (
    <div className="workspace-section samples-tab">
      <div className="section-title samples-title">
        <div>
          <p className="eyebrow">样例</p>
          <h2>样例输入与输出</h2>
        </div>
        <button
          className="secondary-button"
          type="button"
          disabled={!canEdit}
          onClick={() => update((current) => ({ ...current, samples: [...current.samples, newSample()] }))}
        >
          <Plus size={16} aria-hidden="true" />
          添加样例
        </button>
      </div>

      {problem.samples.length === 0 ? <p className="empty-state">还没有样例。</p> : null}
      <div className="sample-list">
        {problem.samples.map((sample, index) => (
          <section className="sample-item" key={sample.id}>
            <div className="sample-item-heading">
              <h3>样例 {index + 1}</h3>
              <button
                className="icon-button danger-icon"
                type="button"
                title="删除样例"
                aria-label={`删除样例 ${index + 1}`}
                disabled={!canEdit}
                onClick={() =>
                  update((current) => ({
                    ...current,
                    samples: current.samples.filter((item) => item.id !== sample.id)
                  }))
                }
              >
                <Trash2 size={16} aria-hidden="true" />
              </button>
            </div>
            <div className="sample-io-grid">
              <label className="field">
                <span>输入</span>
                <textarea
                  rows={7}
                  value={sample.input}
                  onChange={(event) => updateSample(sample.id, "input", event.target.value)}
                  readOnly={!canEdit}
                />
              </label>
              <label className="field">
                <span>输出</span>
                <textarea
                  rows={7}
                  value={sample.output}
                  onChange={(event) => updateSample(sample.id, "output", event.target.value)}
                  readOnly={!canEdit}
                />
              </label>
            </div>
            <label className="field">
              <span>解释（可选）</span>
              <textarea
                rows={3}
                value={sample.explanation}
                onChange={(event) => updateSample(sample.id, "explanation", event.target.value)}
                readOnly={!canEdit}
              />
            </label>
          </section>
        ))}
      </div>

      <MarkdownEditor
        label="数据范围与限制"
        value={problem.content.constraints}
        onChange={(value) => update((current) => setContent(current, "constraints", value))}
        readOnly={!canEdit}
        helper="说明变量范围、保证条件和必要的特殊情况。"
      />
    </div>
  );
}

function createJudgeConfig(type: Problem["type"]): ProblemJudgeConfig {
  const base: ProblemJudgeConfig = {
    version: 1,
    limits: { timeMs: 1000, memoryMiB: 512 },
    scoring: { total: 100, subtaskMode: "sum" },
    subtasks: [],
    testcases: []
  };
  return type === "traditional" ? { ...base, checker: { type: "standard" } } : base;
}

function setJudgeTestcases(
  config: ProblemJudgeConfig,
  testcases: ProblemJudgeConfig["testcases"]
): ProblemJudgeConfig {
  const total = config.subtasks.length === 0
    ? Math.max(1, testcases.reduce((sum, testcase) => sum + testcase.score, 0))
    : config.scoring.total;
  return { ...config, testcases, scoring: { ...config.scoring, total } };
}

function setJudgeSubtasks(
  config: ProblemJudgeConfig,
  subtasks: ProblemJudgeConfig["subtasks"]
): ProblemJudgeConfig {
  return {
    ...config,
    subtasks,
    scoring: {
      ...config.scoring,
      total: Math.max(1, subtasks.reduce((sum, subtask) => sum + subtask.score, 0))
    }
  };
}

export function DataAndJudgeTab({
  problem,
  update,
  fileUploadsDisabled,
  onFileUploadPendingChange,
  onJudgeProgramBound
}: ProblemTabProps) {
  const canRead = problem.capabilities.canReadTestdata;
  const canWrite = problem.capabilities.canWriteTestdata;
  const config = problem.judgeConfig;

  if (!canRead) {
    return (
      <div className="workspace-section permission-empty">
        <LockKeyhole size={28} aria-hidden="true" />
        <h2>内部评测资料不可见</h2>
        <p>当前账号没有查看测试数据、标准程序和内部附件的权限。</p>
      </div>
    );
  }

  if (config === null) {
    return (
      <div className="workspace-section judge-tab permission-empty">
        <FileCode2 size={28} aria-hidden="true" />
        <h2>还没有评测配置</h2>
        <p>创建后可记录时间、内存、数据点、子任务和判断程序。文件将单独上传并由服务器核对。</p>
        {canWrite ? (
          <button
            className="primary-button"
            type="button"
            onClick={() => update((current) => ({
              ...current,
              judgeConfig: createJudgeConfig(current.type)
            }))}
          >
            创建评测配置
          </button>
        ) : null}
      </div>
    );
  }

  const change = (apply: (current: ProblemJudgeConfig) => ProblemJudgeConfig) => {
    if (!canWrite) {
      return;
    }
    update((current) =>
      current.judgeConfig === null
        ? current
        : { ...current, judgeConfig: apply(current.judgeConfig) }
    );
  };
  const nextId = () => {
    const used = new Set(config.testcases.map((testcase) => testcase.id));
    let value = 1;
    while (used.has(String(value).padStart(3, "0"))) {
      value += 1;
    }
    return String(value).padStart(3, "0");
  };
  const addTestcase = () => {
    const id = nextId();
    change((current) =>
      setJudgeTestcases(current, [
        ...current.testcases,
        {
          id,
          input: "judge/testdata/" + id + ".in",
          ...(problem.type === "submit_answer" ? {} : { output: "judge/testdata/" + id + ".out" }),
          score: current.testcases.length === 0 ? current.scoring.total : 0
        }
      ])
    );
  };
  const changeTestcase = (
    id: string,
    apply: (testcase: ProblemJudgeConfig["testcases"][number]) => ProblemJudgeConfig["testcases"][number]
  ) => {
    change((current) =>
      setJudgeTestcases(
        current,
        current.testcases.map((testcase) => testcase.id === id ? apply(testcase) : testcase)
      )
    );
  };
  const addSubtask = () => {
    change((current) => {
      const id = Math.max(-1, ...current.subtasks.map((subtask) => subtask.id)) + 1;
      return setJudgeSubtasks(current, [
        ...current.subtasks,
        {
          id,
          score: current.subtasks.length === 0 ? current.scoring.total : 0,
          method: "sum",
          dependsOn: []
        }
      ]);
    });
  };

  return (
    <div className="workspace-section judge-tab">
      <div className="section-title">
        <div>
          <p className="eyebrow">数据与评测</p>
          <h2>测试数据与限制</h2>
        </div>
        {canWrite ? (
          <div className="inline-actions">
            <button className="secondary-button" type="button" onClick={addTestcase}>
              <Plus size={16} aria-hidden="true" />
              添加数据点
            </button>
            <button className="secondary-button" type="button" onClick={addSubtask}>
              <Plus size={16} aria-hidden="true" />
              添加子任务
            </button>
          </div>
        ) : null}
      </div>

      <div className="form-grid judge-settings-grid">
        <label className="field">
          <span>默认时间（毫秒）</span>
          <input
            type="number"
            min={1}
            value={config.limits.timeMs}
            disabled={!canWrite}
            onChange={(event) => change((current) => ({
              ...current,
              limits: { ...current.limits, timeMs: Math.max(1, Number(event.target.value)) }
            }))}
          />
        </label>
        <label className="field">
          <span>默认内存（MiB）</span>
          <input
            type="number"
            min={1}
            value={config.limits.memoryMiB}
            disabled={!canWrite}
            onChange={(event) => change((current) => ({
              ...current,
              limits: { ...current.limits, memoryMiB: Math.max(1, Number(event.target.value)) }
            }))}
          />
        </label>
        <label className="field">
          <span>记分方式</span>
          <select
            value={config.scoring.subtaskMode}
            disabled={!canWrite}
            onChange={(event) => change((current) => ({
              ...current,
              scoring: {
                ...current.scoring,
                subtaskMode: event.target.value as ProblemJudgeConfig["scoring"]["subtaskMode"]
              }
            }))}
          >
            <option value="sum">加和</option>
            <option value="min">取最小值</option>
            <option value="max">取最大值</option>
          </select>
        </label>
        <label className="field">
          <span>总分</span>
          <input type="number" value={config.scoring.total} readOnly />
          <small>{config.subtasks.length > 0 ? "由子任务分值合计。" : "由数据点分值合计。"}</small>
        </label>
      </div>

      <div className="data-table-wrap">
        <table className="data-table judge-table">
          <thead>
            <tr>
              <th>数据点</th>
              <th>输入</th>
              <th>输出</th>
              <th>时间（毫秒）</th>
              <th>内存（MiB）</th>
              <th>分值</th>
              <th>子任务</th>
              {canWrite ? <th aria-label="操作" /> : null}
            </tr>
          </thead>
          <tbody>
            {config.testcases.length === 0 ? (
              <tr><td className="table-message" colSpan={canWrite ? 8 : 7}>还没有数据点。</td></tr>
            ) : null}
            {config.testcases.map((testcase) => (
              <tr key={testcase.id}>
                <td data-label="数据点"><strong>{testcase.id}</strong></td>
                <td data-label="输入"><input value={testcase.input} disabled={!canWrite} onChange={(event) => changeTestcase(testcase.id, (current) => ({ ...current, input: event.target.value }))} /></td>
                <td data-label="输出"><input value={testcase.output ?? ""} disabled={!canWrite} onChange={(event) => changeTestcase(testcase.id, (current) => event.target.value.trim() ? { ...current, output: event.target.value } : (({ output: _output, ...rest }) => rest)(current))} /></td>
                <td data-label="时间"><input type="number" min={1} value={testcase.timeMs ?? config.limits.timeMs} disabled={!canWrite} onChange={(event) => changeTestcase(testcase.id, (current) => ({ ...current, timeMs: Math.max(1, Number(event.target.value)) }))} /></td>
                <td data-label="内存"><input type="number" min={1} value={testcase.memoryMiB ?? config.limits.memoryMiB} disabled={!canWrite} onChange={(event) => changeTestcase(testcase.id, (current) => ({ ...current, memoryMiB: Math.max(1, Number(event.target.value)) }))} /></td>
                <td data-label="分值"><input type="number" min={0} value={testcase.score} disabled={!canWrite} onChange={(event) => changeTestcase(testcase.id, (current) => ({ ...current, score: Math.max(0, Number(event.target.value)) }))} /></td>
                <td data-label="子任务">
                  <select
                    value={testcase.subtaskId ?? ""}
                    disabled={!canWrite}
                    onChange={(event) => changeTestcase(testcase.id, (current) => {
                      const { subtaskId: _subtaskId, ...withoutSubtask } = current;
                      return event.target.value === ""
                        ? withoutSubtask
                        : { ...withoutSubtask, subtaskId: Number(event.target.value) };
                    })}
                  >
                    <option value="">不分组</option>
                    {config.subtasks.map((subtask) => <option value={subtask.id} key={subtask.id}>#{subtask.id}</option>)}
                  </select>
                </td>
                {canWrite ? <td><button className="icon-button danger-icon" type="button" title="删除数据点" aria-label={"删除数据点 " + testcase.id} onClick={() => change((current) => setJudgeTestcases(current, current.testcases.filter((item) => item.id !== testcase.id)))}><Trash2 size={15} /></button></td> : null}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {config.subtasks.length > 0 ? (
        <section className="subtask-config">
          <div className="section-title"><div><p className="eyebrow">子任务</p><h3>分组与分值</h3></div></div>
          {config.subtasks.map((subtask) => (
            <div className="subtask-row" key={subtask.id}>
              <strong>#{subtask.id}</strong>
              <label className="field"><span>分值</span><input type="number" min={0} value={subtask.score} disabled={!canWrite} onChange={(event) => change((current) => setJudgeSubtasks(current, current.subtasks.map((item) => item.id === subtask.id ? { ...item, score: Math.max(0, Number(event.target.value)) } : item)))} /></label>
              <label className="field"><span>方式</span><select value={subtask.method} disabled={!canWrite} onChange={(event) => change((current) => setJudgeSubtasks(current, current.subtasks.map((item) => item.id === subtask.id ? { ...item, method: event.target.value as ProblemJudgeConfig["scoring"]["subtaskMode"] } : item)))}><option value="sum">加和</option><option value="min">取最小值</option><option value="max">取最大值</option></select></label>
              {canWrite ? <button className="icon-button danger-icon" type="button" title="删除子任务" aria-label={"删除子任务 " + subtask.id} onClick={() => change((current) => {
                const testcases = current.testcases.map((testcase) => {
                  if (testcase.subtaskId !== subtask.id) return testcase;
                  const { subtaskId: _subtaskId, ...withoutSubtask } = testcase;
                  return withoutSubtask;
                });
                return setJudgeSubtasks({ ...current, testcases }, current.subtasks.filter((item) => item.id !== subtask.id));
              })}><Trash2 size={15} /></button> : null}
            </div>
          ))}
        </section>
      ) : null}

      {onJudgeProgramBound !== undefined ? (
        <JudgeProgramPanel
          problem={problem}
          uploadsDisabled={fileUploadsDisabled ?? false}
          onPendingChange={onFileUploadPendingChange}
          onBound={onJudgeProgramBound}
        />
      ) : null}
    </div>
  );
}

type TestcaseRow = {
  id: string;
  input: string;
  output: string;
  timeMs: number;
  memoryMiB: number;
  score: number;
  group: string;
};

function LegacyDataAndJudgeTab({ problem }: { problem: Problem }) {
  const [rows, setRows] = useState<TestcaseRow[]>([]);
  const [selectedFiles, setSelectedFiles] = useState<string[]>([]);
  const canRead = problem.capabilities.canReadTestdata;
  const canWrite = problem.capabilities.canWriteTestdata;

  if (!canRead) {
    return (
      <div className="workspace-section permission-empty">
        <LockKeyhole size={28} aria-hidden="true" />
        <h2>内部评测资料不可见</h2>
        <p>你可以编辑题面，但当前权限不包含测试数据、标准程序和内部附件。</p>
      </div>
    );
  }

  const updateRow = <Key extends keyof TestcaseRow>(
    id: string,
    field: Key,
    value: TestcaseRow[Key]
  ) => {
    setRows((current) => current.map((row) => (row.id === id ? { ...row, [field]: value } : row)));
  };
  const addRow = () => {
    const next = String(rows.length + 1).padStart(3, "0");
    setRows((current) => [
      ...current,
      { id: next, input: `${next}.in`, output: `${next}.out`, timeMs: 1000, memoryMiB: 512, score: 0, group: "0" }
    ]);
  };

  const programTitle =
    problem.type === "traditional"
      ? "判断输出的程序"
      : problem.type === "interactive"
        ? "交互程序"
        : "评分程序";
  const programHelp =
    problem.type === "traditional"
      ? "大多数题使用标准比较；答案不唯一时，可上传一个程序来判断选手输出是否正确。"
      : problem.type === "interactive"
        ? "交互程序负责在运行过程中与选手程序交换信息。"
        : "评分程序读取选手提交的答案并计算得分。";

  return (
    <div className="workspace-section judge-tab">
      <div className="section-title">
        <div>
          <p className="eyebrow">数据点</p>
          <h2>测试数据与限制</h2>
        </div>
        {canWrite ? (
          <div className="inline-actions">
            <label className="secondary-button file-button">
              <FileUp size={16} aria-hidden="true" />
              选择 ZIP 或散文件
              <input
                type="file"
                accept=".zip,.in,.out,application/zip"
                multiple
                onChange={(event) => setSelectedFiles(Array.from(event.target.files ?? [], (file) => file.name))}
              />
            </label>
            <button className="secondary-button" type="button" onClick={addRow}>
              <Plus size={16} aria-hidden="true" />
              添加数据点
            </button>
          </div>
        ) : null}
      </div>

      {selectedFiles.length ? (
        <p className="selected-file-line">已选择 {selectedFiles.length} 个文件，保存前会检查配对和文件路径。</p>
      ) : null}

      <div className="data-table-wrap">
        <table className="data-table judge-table">
          <thead>
            <tr>
              <th>数据点</th>
              <th>输入</th>
              <th>输出</th>
              <th>时间（毫秒）</th>
              <th>内存（MiB）</th>
              <th>分值</th>
              <th>子任务</th>
              {canWrite ? <th aria-label="操作" /> : null}
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr><td className="table-message" colSpan={canWrite ? 8 : 7}>还没有数据点。</td></tr>
            ) : null}
            {rows.map((row) => (
              <tr key={row.id}>
                <td data-label="数据点"><strong>{row.id}</strong></td>
                <td data-label="输入"><input value={row.input} disabled={!canWrite} onChange={(e) => updateRow(row.id, "input", e.target.value)} /></td>
                <td data-label="输出"><input value={row.output} disabled={!canWrite} onChange={(e) => updateRow(row.id, "output", e.target.value)} /></td>
                <td data-label="时间"><input type="number" min={1} value={row.timeMs} disabled={!canWrite} onChange={(e) => updateRow(row.id, "timeMs", Number(e.target.value))} /></td>
                <td data-label="内存"><input type="number" min={1} value={row.memoryMiB} disabled={!canWrite} onChange={(e) => updateRow(row.id, "memoryMiB", Number(e.target.value))} /></td>
                <td data-label="分值"><input type="number" min={0} value={row.score} disabled={!canWrite} onChange={(e) => updateRow(row.id, "score", Number(e.target.value))} /></td>
                <td data-label="子任务"><input value={row.group} disabled={!canWrite} onChange={(e) => updateRow(row.id, "group", e.target.value)} /></td>
                {canWrite ? (
                  <td><button className="icon-button danger-icon" type="button" title="删除数据点" aria-label={`删除数据点 ${row.id}`} onClick={() => setRows((current) => current.filter((item) => item.id !== row.id))}><Trash2 size={15} /></button></td>
                ) : null}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="field-help">子任务用于把若干数据点分组计分；总分和前置关系会在保存时检查。</p>

      <section className="program-upload">
        <div>
          <FileCode2 size={21} aria-hidden="true" />
          <div><h3>{programTitle}</h3><p>{programHelp}</p></div>
        </div>
        {canWrite ? <label className="secondary-button file-button">选择程序文件<input type="file" /></label> : <span>只读</span>}
      </section>
    </div>
  );
}

export function SolutionTab({
  problem,
  update,
  fileUploadsDisabled = false,
  onFileRevisionChange,
  onFileUploadPendingChange
}: ProblemTabProps) {
  const canEdit = problem.capabilities.canEdit;
  const basicFrozen = isFrozen(problem.status, "content.basicSolution") && !problem.capabilities.canEditFrozen;
  const uploadStatementImage = useStatementImageUploader(problem, {
    onRevisionChange: onFileRevisionChange,
    onPendingChange: onFileUploadPendingChange
  });
  return (
    <div className="workspace-section stacked-editors">
      <MarkdownEditor
        label="基础题解"
        value={problem.content.basicSolution}
        onChange={(value) => update((current) => setContent(current, "basicSolution", value))}
        problemId={problem.id}
        onUploadImage={uploadStatementImage}
        uploadDisabled={fileUploadsDisabled}
        readOnly={!canEdit || basicFrozen}
        frozen={basicFrozen}
        helper="审核时使用的核心思路，进入待审核后保持不变。"
      />
      <MarkdownEditor
        label="正式题解"
        value={problem.content.solution}
        onChange={(value) => update((current) => setContent(current, "solution", value))}
        problemId={problem.id}
        onUploadImage={uploadStatementImage}
        uploadDisabled={fileUploadsDisabled}
        readOnly={!canEdit}
        helper="补充正确性证明、复杂度分析和实现细节。"
      />
      <MarkdownEditor
        label="提示"
        value={problem.content.hints}
        onChange={(value) => update((current) => setContent(current, "hints", value))}
        problemId={problem.id}
        onUploadImage={uploadStatementImage}
        uploadDisabled={fileUploadsDisabled}
        readOnly={!canEdit}
        helper="可选。按比赛需要拆分为逐步提示。"
        minRows={7}
      />

      <ProblemFilesPanel
        problem={problem}
        uploadsDisabled={fileUploadsDisabled}
        onRevisionChange={onFileRevisionChange}
        onPendingChange={onFileUploadPendingChange}
      />
    </div>
  );
}

const sourceName = {
  human: "人工审核",
  anklang: "原题检索服务",
  fermata: "AI 审核服务",
  plugin: "扩展检查"
};

const reviewItemSourceLabel: Record<ReviewItemView["source"], string> = {
  human: "人工",
  anklang: "原题检索",
  fermata: "AI 审核",
  plugin: "插件"
};

/** anklang 原题相似度条目的 data 结构；其余来源的条目不假定这个形状。 */
const anklangSimilarityType = "org.ustc.urmotiv.anklang.similarity";
const anklangSimilarityDataSchema = z.object({
  apiVersion: z.enum(["1", "2"]),
  checkedAt: z.string(),
  completion: z
    .object({
      status: z.enum(["complete", "partial", "unavailable"])
    })
    .optional(),
  candidates: z.array(
    z.object({
      source: z.string(),
      externalId: z.string(),
      title: z.string(),
      url: z.string().optional(),
      similarity: z.number(),
      sameProblemSuggestion: z.boolean().optional(),
      explanation: z.string().optional()
    })
  ),
  recommendation: z.object({
    blockSubmission: z.boolean(),
    message: z.string()
  })
});
type AnklangSimilarityData = z.infer<typeof anklangSimilarityDataSchema>;

function AnklangCandidates({ data }: { data: AnklangSimilarityData }) {
  const completionStatus = data.apiVersion === "1" ? "complete" : data.completion?.status;
  return (
    <div className="candidate-panel">
      {data.recommendation.message ? (
        <p className={data.recommendation.blockSubmission ? "warning-note" : "notice-line"}>
          {data.recommendation.blockSubmission ? <AlertTriangle size={16} aria-hidden="true" /> : null}
          {data.recommendation.message}
        </p>
      ) : null}
      {completionStatus === "partial" ? (
        <p className="warning-note">本次检索只完成了一部分，不能把这些候选当作完整查重结果。</p>
      ) : null}
      {completionStatus === "unavailable" ? (
        <p className="warning-note">本次检索未能形成可信候选，请稍后重试。</p>
      ) : null}
      {data.candidates.length === 0 ? (
        completionStatus === "complete" ? (
          <p className="empty-state">完整检索没有发现相似的历史题目。</p>
        ) : null
      ) : (
        <ul className="candidate-list">
          {data.candidates.map((candidate, index) => (
            <li
              className={`candidate-item${candidate.sameProblemSuggestion ? " candidate-flagged" : ""}`}
              key={`${candidate.source}:${candidate.externalId}:${index}`}
            >
              <div className="candidate-heading">
                {candidate.url ? (
                  <a href={candidate.url} target="_blank" rel="noreferrer noopener">
                    {candidate.title}
                    <ExternalLink size={12} aria-hidden="true" />
                  </a>
                ) : (
                  <strong>{candidate.title}</strong>
                )}
                <span className="candidate-similarity">{Math.round(candidate.similarity * 100)}%</span>
              </div>
              {candidate.explanation ? <p>{candidate.explanation}</p> : null}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** 外部分析条目卡片；手动查重结果和"外部分析"历史列表共用同一渲染。 */
export function ReviewItemCard({
  item,
  defaultExpanded = false
}: {
  item: ReviewItemView;
  defaultExpanded?: boolean;
}) {
  const [expanded, setExpanded] = useState(defaultExpanded);
  const parsedAnklang =
    item.type === anklangSimilarityType ? anklangSimilarityDataSchema.safeParse(item.data) : null;

  return (
    <article className="analysis-item">
      <div className="analysis-item-header">
        <span className="status-badge neutral">{reviewItemSourceLabel[item.source]}</span>
        <p>{item.summary}</p>
        <span className="text-faint">{dateTime(item.createdAt)}</span>
      </div>
      {parsedAnklang?.success ? (
        <>
          <button className="text-button" type="button" onClick={() => setExpanded((value) => !value)}>
            {expanded ? <ChevronUp size={14} aria-hidden="true" /> : <ChevronDown size={14} aria-hidden="true" />}
            {expanded ? "收起候选" : "展开候选"}
          </button>
          {expanded ? <AnklangCandidates data={parsedAnklang.data} /> : null}
        </>
      ) : null}
    </article>
  );
}

export function ReviewTab({
  problem,
  currentUserId,
  submissionBlocked = false,
  onStatusChange,
  onProblemChange
}: {
  problem: Problem;
  currentUserId: string;
  submissionBlocked?: boolean;
  onStatusChange?: (status: Problem["status"]) => void;
  onProblemChange?: (problem: Problem) => void;
}) {
  const client = useQueryClient();
  const reviews = useQuery({
    queryKey: ["reviews", problem.id, problem.reviewRound, currentUserId],
    queryFn: () => listReviews(problem.id),
    enabled: problem.reviewRound > 0
  });
  const summary = reviews.data;
  const reviewItems = useQuery({
    queryKey: ["review-items", problem.id, problem.reviewRound, currentUserId],
    queryFn: () => listReviewItems(problem.id),
    enabled: problem.reviewRound > 0
  });
  const tags = useQuery({
    queryKey: ["tags"],
    queryFn: listTags,
    staleTime: 5 * 60_000,
    enabled: problem.reviewRound > 0
  });
  const suggestions = useQuery({
    queryKey: ["review-suggestions", problem.id, problem.reviewRound, problem.revision],
    queryFn: () => getReviewSuggestions(problem.id),
    enabled: problem.status === "approved" && summary?.status === "approved"
  });
  const [verdict, setVerdict] = useState<ReviewInput["verdict"]>("request_changes");
  const [difficulty, setDifficulty] = useState(problem.codeforcesDifficulty ?? 1600);
  const [quality, setQuality] = useState(3);
  const [originality, setOriginality] = useState<number | "">("");
  const [thinking, setThinking] = useState(3);
  const [coding, setCoding] = useState(3);
  const [tagIds, setTagIds] = useState<string[]>([]);
  const [improvements, setImprovements] = useState("");
  const [publicComment, setPublicComment] = useState("");
  const [privateNote, setPrivateNote] = useState("");
  const [selectedSuggestionFields, setSelectedSuggestionFields] = useState<ReviewSuggestionField[]>([]);
  const [suggestionConfirmationOpen, setSuggestionConfirmationOpen] = useState(false);
  const [suggestionNotice, setSuggestionNotice] = useState<string | null>(null);
  const [loadedReviewVersion, setLoadedReviewVersion] = useState<string | null>(null);
  const ownReview = summary?.reviews.find((review) => review.reviewer.id === currentUserId);
  const reviewVersion = summary === undefined
    ? null
    : JSON.stringify([
        problem.id,
        currentUserId,
        summary.round,
        ownReview?.id ?? "new",
        ownReview?.updatedAt ?? "",
        ownReview?.verdict ?? "",
        ownReview?.codeforcesDifficulty ?? null,
        ownReview?.qualityLevel ?? null,
        ownReview?.originalityLevel ?? null,
        ownReview?.thinkingLevel ?? null,
        ownReview?.codingLevel ?? null,
        ownReview?.tagIds ?? [],
        ownReview?.improvements ?? "",
        ownReview?.publicComment ?? "",
        ownReview?.privateNote ?? ""
      ]);

  useEffect(() => {
    if (reviewVersion === null || reviewVersion === loadedReviewVersion) {
      return;
    }
    setVerdict(ownReview?.verdict ?? "request_changes");
    setDifficulty(ownReview?.codeforcesDifficulty ?? problem.codeforcesDifficulty ?? 1600);
    setQuality(ownReview?.qualityLevel ?? 3);
    setOriginality(ownReview?.originalityLevel ?? "");
    setThinking(ownReview?.thinkingLevel ?? 3);
    setCoding(ownReview?.codingLevel ?? 3);
    setTagIds(ownReview?.tagIds ?? []);
    setImprovements(ownReview?.improvements ?? "");
    setPublicComment(ownReview?.publicComment ?? "");
    setPrivateNote(ownReview?.privateNote ?? "");
    setLoadedReviewVersion(reviewVersion);
  }, [loadedReviewVersion, ownReview, problem.codeforcesDifficulty, reviewVersion]);

  const suggestionVersion = suggestions.data === undefined
    ? null
    : `${problem.id}:${problem.revision}:${suggestions.data.round}`;

  useEffect(() => {
    setSelectedSuggestionFields([]);
    setSuggestionConfirmationOpen(false);
  }, [suggestionVersion]);

  useEffect(() => {
    setSuggestionNotice(null);
  }, [problem.id]);

  const submit = useMutation({
    mutationFn: (input: ReviewInput) => createReview(problem.id, input),
    onSuccess: (summary) => {
      client.setQueryData(
        ["reviews", problem.id, problem.reviewRound, currentUserId],
        summary
      );
      if (summary.status === "approved" || summary.status === "rejected") {
        onStatusChange?.(summary.status);
      }
      client.invalidateQueries({ queryKey: ["problem", problem.id] });
      client.invalidateQueries({ queryKey: ["problems"] });
    }
  });

  const applySuggestions = useMutation({
    mutationFn: (fields: ReviewSuggestionField[]) =>
      applyReviewSuggestions(problem.id, {
        expectedRound: problem.reviewRound,
        expectedRevision: problem.revision,
        fields
      }),
    onSuccess: (updated) => {
      client.setQueryData(["problem", updated.id, currentUserId], updated);
      client.invalidateQueries({ queryKey: ["problem", updated.id] });
      client.invalidateQueries({ queryKey: ["problems"] });
      client.invalidateQueries({ queryKey: ["review-suggestions", updated.id] });
      setSelectedSuggestionFields([]);
      setSuggestionConfirmationOpen(false);
      setSuggestionNotice("所选字段已经写回题目，请按最新值继续工作。");
      onProblemChange?.(updated);
    },
    onError: async (error) => {
      setSuggestionConfirmationOpen(false);
      if (error instanceof ApiError && error.status === 409) {
        setSelectedSuggestionFields([]);
        try {
          const latest = await getProblem(problem.id);
          client.setQueryData(["problem", latest.id, currentUserId], latest);
          onProblemChange?.(latest);
          setSuggestionNotice("题目刚刚发生了变化，已经重新读取最新版本。请重新核对后再确认。");
        } catch {
          // 刷新失败时仍保持当前页面的真实旧值，不做任何本地写回。
          setSuggestionNotice("题目刚刚发生了变化，但最新版本暂时无法读取。当前页面没有写回任何修改，请刷新后重新核对。");
        }
        await client.invalidateQueries({ queryKey: ["problem", problem.id] });
        await client.invalidateQueries({ queryKey: ["review-suggestions", problem.id] });
        return;
      }
      setSuggestionNotice(
        error instanceof ApiError && (error.status === 403 || error.status === 404)
          ? "当前无法执行这项操作。请刷新后重试。"
          : "写回失败，题目没有被修改。请稍后重试。"
      );
    }
  });

  if (problem.reviewRound === 0) {
    return (
      <div className="workspace-section permission-empty">
        <ClipboardListIcon />
        <h2>尚未进入审核</h2>
        <p>题目第一次提交后会新建审核轮次，后续重新提交会保留旧轮次记录。</p>
      </div>
    );
  }

  const tagNameById = new Map((tags.data?.items ?? []).map((tag) => [tag.id, tag.name]));
  const tagListText = (ids: string[]) =>
    ids.length === 0 ? "未设置" : ids.map((id) => tagNameById.get(id) ?? id).join("、");
  const editableSuggestionRows: Array<{
    field: ReviewSuggestionField;
    label: string;
    current: string;
    suggested: string;
  }> = suggestions.data === undefined
    ? []
    : [
        {
          field: "codeforcesDifficulty",
          label: "CF 难度",
          current: suggestions.data.current.codeforcesDifficulty?.toString() ?? "未设置",
          suggested: suggestions.data.suggested.codeforcesDifficulty.toString()
        },
        {
          field: "thinkingLevel",
          label: "思维难度",
          current: suggestions.data.current.thinkingLevel?.toString() ?? "未设置",
          suggested: suggestions.data.suggested.thinkingLevel.toString()
        },
        {
          field: "codingLevel",
          label: "代码难度",
          current: suggestions.data.current.codingLevel?.toString() ?? "未设置",
          suggested: suggestions.data.suggested.codingLevel.toString()
        },
        {
          field: "tagIds",
          label: "知识点",
          current: tagListText(suggestions.data.current.tagIds),
          suggested: tagListText(suggestions.data.suggested.tagIds)
        }
      ];
  const toggleSuggestionField = (field: ReviewSuggestionField) => {
    setSelectedSuggestionFields((current) =>
      current.includes(field)
        ? current.filter((candidate) => candidate !== field)
        : [...current, field]
    );
    setSuggestionConfirmationOpen(false);
    setSuggestionNotice(null);
  };
  const canEditOwnReview =
    problem.capabilities.canReview &&
    problem.status === "pending_review" &&
    summary?.status === "waiting" &&
    summary.decisionAvailable;
  const displayedStatus =
    summary?.status === "approved" || summary?.status === "rejected"
      ? summary.status
      : problem.status;

  return (
    <div className="workspace-section review-tab">
      <div className="review-summary">
        <div><span>当前轮次</span><strong>第 {summary?.round ?? problem.reviewRound} 轮</strong></div>
        <div><span>通过意见</span><strong>{summary?.approvals ?? 0}{summary?.requiredApprovals === null ? "" : ` / ${summary?.requiredApprovals ?? 2}`}</strong></div>
        <div><span>阻止通过</span><strong>{summary?.blockingReviews ?? 0}</strong></div>
        <div><span>题目状态</span><strong>{statusText[displayedStatus]}</strong></div>
      </div>

      {summary?.decisionAvailable === false ? (
        <div className="inline-error">当前审核规则暂时不可用，新的审核意见不会被保存，请联系组长检查设置。</div>
      ) : summary?.decisionReason ? (
        <p className="review-decision-reason">{summary.decisionReason}</p>
      ) : null}

      <section className="external-analysis-section">
        <div className="section-title">
          <div>
            <p className="eyebrow">参考信息</p>
            <h2>外部分析</h2>
          </div>
          <Search size={19} aria-hidden="true" />
        </div>
        {reviewItems.isError ? <div className="inline-error">{reviewItems.error.message}</div> : null}
        {reviewItems.isLoading ? <p className="empty-state">正在加载外部分析…</p> : null}
        {!reviewItems.isLoading && reviewItems.data?.items.length === 0 ? (
          <p className="empty-state">本轮暂无外部分析。</p>
        ) : null}
        {reviewItems.data && reviewItems.data.items.length > 0 ? (
          <div className="analysis-item-list">
            {reviewItems.data.items.map((item) => (
              <ReviewItemCard key={item.id} item={item} />
            ))}
          </div>
        ) : null}
      </section>

      {problem.status === "approved" && summary?.status === "approved" ? (
        <section className="review-suggestions plain-panel" aria-labelledby="review-suggestions-title">
          <div className="section-title">
            <div>
              <p className="eyebrow">轮次结束后汇总</p>
              <h2 id="review-suggestions-title">审核建议</h2>
            </div>
            <ShieldCheck size={21} aria-hidden="true" />
          </div>
          {suggestions.isLoading ? <p className="empty-state">正在汇总本轮审核建议…</p> : null}
          {suggestions.isError ? (
            <div className="inline-error" role="alert">审核建议暂时无法读取。</div>
          ) : null}
          {suggestions.data ? (
            <>
              <p className="review-suggestion-intro">
                以下结果来自本轮结束时计入决定的 {suggestions.data.opinionCount} 份评价。请逐项核对，系统不会默认写回任何字段。
              </p>
              <div className="review-suggestion-list">
                {editableSuggestionRows.map((row) => {
                  const selected = selectedSuggestionFields.includes(row.field);
                  return (
                    <div className="review-suggestion-row" key={row.field}>
                      <div className="review-suggestion-label">
                        {suggestions.data.canApply ? (
                          <label>
                            <input
                              type="checkbox"
                              checked={selected}
                              disabled={submissionBlocked || applySuggestions.isPending}
                              onChange={() => toggleSuggestionField(row.field)}
                              aria-label={`写回${row.label}`}
                            />
                            <span>{row.label}</span>
                          </label>
                        ) : (
                          <strong>{row.label}</strong>
                        )}
                      </div>
                      <div><span>当前值</span><strong>{row.current}</strong></div>
                      <div><span>建议值</span><strong>{row.suggested}</strong></div>
                    </div>
                  );
                })}
                <div className="review-suggestion-row readonly">
                  <div className="review-suggestion-label"><strong>题目质量</strong><span>只读汇总</span></div>
                  <div><span>当前值</span><strong>无对应题目字段</strong></div>
                  <div><span>建议值</span><strong>{suggestions.data.suggested.qualityLevel}</strong></div>
                </div>
                <div className="review-suggestion-row readonly">
                  <div className="review-suggestion-label"><strong>原创性</strong><span>只读汇总</span></div>
                  <div><span>当前值</span><strong>无对应题目字段</strong></div>
                  <div>
                    <span>建议值</span>
                    <strong>{suggestions.data.suggested.originalityLevel ?? "未提供"}</strong>
                  </div>
                </div>
              </div>
              {!suggestions.data.canApply ? (
                <p className="field-help review-suggestion-permission" role="note">
                  你可以查看这些建议，但当前账号不能把它们写回题目。
                </p>
              ) : suggestionConfirmationOpen ? (
                <div className="review-suggestion-confirmation" role="group" aria-label="确认写回审核建议">
                  <p>确认后只会写回已经勾选的字段，并生成新的题目修订。是否继续？</p>
                  <div className="inline-actions">
                    <button
                      className="secondary-button"
                      type="button"
                      disabled={submissionBlocked || applySuggestions.isPending}
                      onClick={() => setSuggestionConfirmationOpen(false)}
                    >
                      取消
                    </button>
                    <button
                      className="primary-button"
                      type="button"
                      disabled={submissionBlocked || selectedSuggestionFields.length === 0 || applySuggestions.isPending}
                      onClick={() => applySuggestions.mutate(selectedSuggestionFields)}
                    >
                      {applySuggestions.isPending ? "正在写回…" : "确认写回"}
                    </button>
                  </div>
                </div>
              ) : (
                <button
                  className="primary-button review-suggestion-continue"
                  type="button"
                  disabled={submissionBlocked || selectedSuggestionFields.length === 0 || applySuggestions.isPending}
                  onClick={() => setSuggestionConfirmationOpen(true)}
                >
                  继续确认所选字段
                </button>
              )}
              {suggestions.data.canApply && submissionBlocked ? (
                <p className="field-help review-suggestion-permission" role="note">
                  请先保存题目工作区中的修改，再写回审核建议。
                </p>
              ) : null}
              {suggestionNotice ? (
                <p
                  className={applySuggestions.isError ? "inline-error" : "notice-line"}
                  role={applySuggestions.isError ? "alert" : "status"}
                >
                  {suggestionNotice}
                </p>
              ) : null}
            </>
          ) : null}
        </section>
      ) : null}

      {reviews.isError ? <div className="inline-error">{reviews.error.message}</div> : null}
      <div className="review-layout">
        <section className="review-history">
          <div className="section-title"><div><p className="eyebrow">记录</p><h2>本轮审核意见</h2></div></div>
          {reviews.isLoading ? <p className="empty-state">正在加载审核记录…</p> : null}
          {!reviews.isLoading && !summary?.reviews.length ? <p className="empty-state">本轮还没有审核意见。</p> : null}
          {summary?.reviews.map((review) => {
            const isOwnReview = review.reviewer.id === currentUserId;
            return (
              <article className="review-item" key={review.id}>
                <header>
                  <div>
                    <strong>{review.reviewer.nickname}</strong>
                    <span>{isOwnReview ? "我的评价 · " : ""}{sourceName[review.source]}</span>
                  </div>
                  <span className={`review-verdict ${review.verdict}`}>{reviewVerdictText(review.verdict)}</span>
                </header>
                <dl>
                  <div><dt>CF 难度</dt><dd>{review.codeforcesDifficulty}</dd></div>
                  <div><dt>题目质量</dt><dd>{review.qualityLevel}</dd></div>
                  <div><dt>原创性</dt><dd>{review.originalityLevel ?? "未提供"}</dd></div>
                  <div><dt>思维难度</dt><dd>{review.thinkingLevel}</dd></div>
                  <div><dt>代码难度</dt><dd>{review.codingLevel}</dd></div>
                </dl>
                {review.tagIds.length > 0 ? (
                  <div className="compact-tags" aria-label="建议知识点">
                    {review.tagIds.map((tagId) => (
                      <span key={tagId}>{tagNameById.get(tagId) ?? tagId}</span>
                    ))}
                  </div>
                ) : null}
                <p>{review.improvements}</p>
                {review.publicComment ? (
                  <div className="review-public-comment">
                    <strong>公开评论</strong>
                    <p>{review.publicComment}</p>
                  </div>
                ) : null}
                {review.privateNote ? <p className="private-note"><LockKeyhole size={14} />{review.privateNote}</p> : null}
                <footer>{dateTime(review.updatedAt)}</footer>
              </article>
            );
          })}
          {summary !== undefined && summary.status !== "waiting" ? (
            <p className="field-help">
              <LockKeyhole size={14} />
              本轮审核已经结束，所有意见均为只读。
            </p>
          ) : null}
        </section>

        {canEditOwnReview ? (
          <section className="review-form plain-panel">
            <div className="section-title">
              <div>
                <p className="eyebrow">你的意见</p>
                <h2>{ownReview ? "修改我的评价" : "提交我的评价"}</h2>
              </div>
              <ShieldCheck size={21} />
            </div>
            <label className="field"><span>结论</span><select value={verdict} onChange={(e) => setVerdict(e.target.value as ReviewInput["verdict"])}><option value="approve">通过</option><option value="request_changes">需要修改</option><option value="reject">不通过</option></select></label>
            <label className="field"><span>CF 难度</span><input type="number" min={800} max={3500} step={100} value={difficulty} onChange={(e) => setDifficulty(Number(e.target.value))} /></label>
            <div className="three-field-grid">
              <LevelSelect label="题目质量" value={quality} onChange={setQuality} />
              <LevelSelect label="思维难度" value={thinking} onChange={setThinking} />
              <LevelSelect label="代码难度" value={coding} onChange={setCoding} />
            </div>
            <label className="field">
              <span>原创性（必填）</span>
              <select
                value={originality}
                onChange={(event) => setOriginality(event.target.value === "" ? "" : Number(event.target.value))}
              >
                <option value="" disabled>请选择 1–5</option>
                <option value={1}>1</option>
                <option value={2}>2</option>
                <option value={3}>3</option>
                <option value={4}>4</option>
                <option value={5}>5</option>
              </select>
              <small>根据目前查到的资料，评价题目想法的新颖程度；这不等于认定题目抄袭或未抄袭。</small>
            </label>
            <div className="field">
              <span>建议知识点（可选）</span>
              <TagPicker
                tags={tags.data?.items ?? []}
                value={tagIds}
                onChange={setTagIds}
                disabled={tags.isLoading || tags.isError}
              />
              {tags.isError ? <small>知识点暂时无法读取，原有选择会继续保留。</small> : null}
            </div>
            <label className="field"><span>主要改进点</span><textarea rows={6} value={improvements} onChange={(e) => setImprovements(e.target.value)} placeholder="说明需要修改的内容；如果通过，说明判断依据。" /></label>
            <label className="field">
              <span>公开评论（可选）</span>
              <textarea rows={3} value={publicComment} onChange={(event) => setPublicComment(event.target.value)} />
              <small>所有能查看题目的人都能看到，请不要填写只供审题人查看的内容。</small>
            </label>
            <label className="field"><span>仅审题人可见备注（可选）</span><textarea rows={3} value={privateNote} onChange={(e) => setPrivateNote(e.target.value)} /></label>
            {submit.error ? <p className="form-error">{submit.error.message}</p> : null}
            <button
              className="primary-button"
              type="button"
              disabled={!improvements.trim() || originality === "" || submit.isPending || submissionBlocked}
              onClick={() => {
                if (originality === "") return;
                submit.mutate({
                  verdict,
                  codeforcesDifficulty: difficulty,
                  qualityLevel: quality,
                  originalityLevel: originality,
                  thinkingLevel: thinking,
                  codingLevel: coding,
                  tagIds,
                  improvements,
                  publicComment,
                  privateNote,
                  expectedRound: problem.reviewRound
                });
              }}
            >
              {submit.isPending ? "正在保存…" : ownReview ? "保存修改" : "提交审核意见"}
            </button>
            <p className="field-help" role="note">
              <AlertTriangle size={14} />
              保存后会立即重新执行审核规则，题目可能因此直接通过或不通过；轮次结束后不能再修改。
            </p>
            {submissionBlocked ? (
              <p className="field-help" role="note">
                请先保存题目工作区中的修改，再保存审核意见。
              </p>
            ) : null}
          </section>
        ) : null}
      </div>
    </div>
  );
}

function LevelSelect({ label, value, onChange }: { label: string; value: number; onChange: (value: number) => void }) {
  return <label className="field"><span>{label}</span><select value={value} onChange={(e) => onChange(Number(e.target.value))}><option value={1}>1</option><option value={2}>2</option><option value={3}>3</option><option value={4}>4</option><option value={5}>5</option></select></label>;
}

function ClipboardListIcon() {
  return <ShieldCheck size={28} aria-hidden="true" />;
}
