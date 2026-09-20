import {
  AlertTriangle,
  Archive,
  CalendarDays,
  ChevronRight,
  Download,
  ListChecks,
  LockKeyhole,
  Plus,
  Trash2,
  Users,
  X
} from "lucide-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import type { Contest, CreateContestInput } from "@urmotiv/contracts";
import {
  createContest,
  deleteContest,
  getContest,
  getSession,
  listContests,
  updateContest
} from "../lib/api";
import { duration } from "../lib/presentation";
import { ExportSection } from "./transfer-page";

const stateText = {
  draft: "草稿",
  locked: "已锁定",
  archived: "已归档"
} as const;

type ProblemRow = {
  key: string;
  problemId: string;
  score: number;
  estimatedDifficulty: string;
};

function newProblemRow(): ProblemRow {
  return { key: crypto.randomUUID(), problemId: "", score: 100, estimatedDifficulty: "" };
}

function parseDate(value: string): string | null {
  if (!value) {
    return null;
  }
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : null;
}

function dateTime(value: string | null): string {
  return value === null
    ? "未设置"
    : new Intl.DateTimeFormat("zh-CN", { dateStyle: "medium", timeStyle: "short" }).format(
        new Date(value)
      );
}

export function ContestPage() {
  const client = useQueryClient();
  const session = useQuery({ queryKey: ["session"], queryFn: getSession, staleTime: 60_000 });
  const contests = useQuery({ queryKey: ["contests"], queryFn: listContests });
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [searchParams, setSearchParams] = useSearchParams();
  const view = searchParams.get("view") === "archived" ? "archived" : searchParams.get("view") === "all" ? "all" : "active";
  const visibleContests = (contests.data?.items ?? []).filter(contest => view === "all" || (contest.state === "archived") === (view === "archived"));
  const selectView = (next: string) => {
    setSearchParams(current => { const updated = new URLSearchParams(current); updated.set("view", next); return updated; });
    setCreating(false);
  };

  useEffect(() => {
    if (!visibleContests.some(contest => contest.id === selectedId)) setSelectedId(visibleContests[0]?.id ?? null);
  }, [contests.data, selectedId, view]);

  const selected = useQuery({
    queryKey: ["contest", selectedId],
    queryFn: () => getContest(selectedId as string),
    enabled: selectedId !== null && !creating
  });
  const canCreate = session.data?.user?.permissions.includes("contest.create") ?? false;
  const canViewContests = session.data?.user?.permissions.some((permission) =>
    permission === "contest.create" ||
    permission === "contest.edit.own" ||
    permission === "contest.edit.all" ||
    permission === "contest.export" ||
    permission === "contest.risk.read"
  ) ?? false;

  const refreshContest = (contest: Contest) => {
    client.setQueryData(["contest", contest.id], contest);
    client.setQueryData(["contests"], (current: Awaited<ReturnType<typeof listContests>> | undefined) => current === undefined ? current : {
      ...current, items: current.items.map(item => item.id === contest.id ? {...item, state:contest.state, updatedAt:contest.updatedAt} : item)
    });
    if (contest.state === "archived") selectView("archived");
    else if (view === "archived") selectView("active");
    void client.invalidateQueries({ queryKey: ["contests"] });
  };

  if (session.status !== "pending" && !canViewContests) {
    return (
      <section className="contest-page">
        <div className="centered-message" role="alert">
          <ListChecks size={28} aria-hidden="true" />
          <h1>当前账号不能查看组题方案</h1>
          <p>你没有比赛方案相关权限，只能访问有权限的题目。</p>
          <Link to="/problems">返回题目列表</Link>
        </div>
      </section>
    );
  }

  return (
    <section className="contest-page">
      <div className="page-heading contest-heading">
        <div>
          <p className="eyebrow">比赛方案</p>
          <h1>组题</h1>
          <p>题目加入方案时固定当前修订，访问风险按参赛者实时比对。</p>
        </div>
        {canCreate ? (
          <button
            className={creating ? "secondary-button" : "primary-button"}
            type="button"
            onClick={() => setCreating((value) => !value)}
          >
            {creating ? <X size={16} aria-hidden="true" /> : <Plus size={16} aria-hidden="true" />}
            {creating ? "取消新建" : "新建方案"}
          </button>
        ) : null}
      </div>

      {contests.isError ? <div className="inline-error">{contests.error.message}</div> : null}
      <nav className="contest-views" aria-label="比赛方案分类">
        {([['active','进行中'],['archived','已归档'],['all','全部']] as const).map(([key,label]) => <button
          key={key} type="button" aria-pressed={view === key} onClick={() => selectView(key)}>
          {key === 'archived' ? <Archive size={16} aria-hidden="true" /> : null}{label}
          <span>{(contests.data?.items ?? []).filter(item => key === 'all' || (item.state === 'archived') === (key === 'archived')).length}</span>
        </button>)}
      </nav>
      <div className="contest-layout">
        <aside className="contest-index" aria-label="组题方案列表">
          <div className="contest-index-heading">
            <strong>方案</strong>
            <span>{visibleContests.length}</span>
          </div>
          {contests.isLoading ? <p className="contest-empty">正在加载…</p> : null}
          {!contests.isLoading && visibleContests.length === 0 ? (
            <p className="contest-empty">{view === 'archived' ? '暂无已归档方案。比赛结束后，可在方案详情中归档。' : '当前分类没有可查看的方案，可以切换到已归档或新建方案。'}</p>
          ) : null}
          {visibleContests.map((contest) => (
            <button
              type="button"
              className={`contest-index-item ${selectedId === contest.id && !creating ? "active" : ""}`}
              key={contest.id}
              onClick={() => {
                setCreating(false);
                setSelectedId(contest.id);
              }}
            >
              <span>
                <strong>{contest.title}</strong>
                <small>
                  {contest.problemCount} 题 · {contest.participantCount} 名参与者
                </small>
              </span>
              <span className={`contest-state ${contest.state}`}>{stateText[contest.state]}</span>
              <ChevronRight size={16} aria-hidden="true" />
            </button>
          ))}
        </aside>

        <div className="contest-main">
          {creating ? (
            <ContestCreateForm
              onCreated={async (contest) => {
                refreshContest(contest);
                await client.invalidateQueries({ queryKey: ["contests"] });
                selectView("active");
                setSelectedId(contest.id);
                setCreating(false);
              }}
            />
          ) : selected.isLoading ? (
            <div className="contest-empty large">正在打开方案…</div>
          ) : selected.isError ? (
            <div className="inline-error">{selected.error.message}</div>
          ) : selected.data && visibleContests.some(item => item.id === selected.data.id) ? (
            <ContestDetail key={selected.data.id} contest={selected.data} currentUserId={session.data?.user?.id ?? ""} onChanged={refreshContest} onDeleted={() => {
              client.removeQueries({queryKey:["contest",selectedId],exact:true});
              client.setQueryData(["contests"],(current:Awaited<ReturnType<typeof listContests>>|undefined)=>current?{...current,items:current.items.filter(item=>item.id!==selectedId)}:current);
              setSelectedId(null);
              void client.invalidateQueries({queryKey:["contests"]});
            }} />
          ) : (
            <div className="contest-empty large">
              <ListChecks size={28} aria-hidden="true" />
              <span>选择一个方案查看内容。</span>
            </div>
          )}
        </div>
      </div>
    </section>
  );
}

function ContestCreateForm({ onCreated }: { onCreated: (contest: Contest) => void }) {
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [startsAt, setStartsAt] = useState("");
  const [endsAt, setEndsAt] = useState("");
  const [participantText, setParticipantText] = useState("");
  const [problems, setProblems] = useState<ProblemRow[]>([newProblemRow()]);
  const create = useMutation({ mutationFn: createContest, onSuccess: onCreated });

  const updateProblem = <Key extends keyof ProblemRow>(
    key: string,
    field: Key,
    value: ProblemRow[Key]
  ) => {
    setProblems((rows) => rows.map((row) => (row.key === key ? { ...row, [field]: value } : row)));
  };
  const participantIds = [...new Set(participantText.split(/[\s,，]+/).filter(Boolean))];
  const validProblems = problems.filter((row) => row.problemId.trim().length > 0);
  const canSubmit = title.trim().length > 0 && validProblems.length === problems.length;

  const submit = () => {
    const input: CreateContestInput = {
      title,
      description,
      startsAt: parseDate(startsAt),
      endsAt: parseDate(endsAt),
      members: participantIds.map((userId) => ({ userId, role: "participant" })),
      problems: problems.map((row) => ({
        problemId: row.problemId.trim(),
        score: row.score,
        estimatedDifficulty: row.estimatedDifficulty ? Number(row.estimatedDifficulty) : null
      }))
    };
    create.mutate(input);
  };

  return (
    <section className="contest-form" aria-labelledby="contest-create-title">
      <div className="section-title">
        <div>
          <p className="eyebrow">新方案</p>
          <h2 id="contest-create-title">比赛信息</h2>
        </div>
        <CalendarDays size={21} aria-hidden="true" />
      </div>
      <div className="form-grid contest-form-grid">
        <label className="field wide">
          <span>方案名称</span>
          <input value={title} onChange={(event) => setTitle(event.target.value)} maxLength={200} />
        </label>
        <label className="field">
          <span>开始时间</span>
          <input type="datetime-local" value={startsAt} onChange={(event) => setStartsAt(event.target.value)} />
        </label>
        <label className="field">
          <span>结束时间</span>
          <input type="datetime-local" value={endsAt} onChange={(event) => setEndsAt(event.target.value)} />
        </label>
        <label className="field wide">
          <span>备注</span>
          <textarea rows={3} value={description} onChange={(event) => setDescription(event.target.value)} />
        </label>
        <label className="field wide">
          <span>参与者账号编号</span>
          <textarea
            rows={3}
            value={participantText}
            onChange={(event) => setParticipantText(event.target.value)}
            placeholder="每行一个编号"
          />
        </label>
      </div>

      <div className="section-title contest-problem-heading">
        <div>
          <p className="eyebrow">题目</p>
          <h2>顺序与分值</h2>
        </div>
        <button
          className="secondary-button compact-button"
          type="button"
          onClick={() => setProblems((rows) => [...rows, newProblemRow()])}
        >
          <Plus size={15} aria-hidden="true" />
          添加题目
        </button>
      </div>
      <div className="data-table-wrap">
        <table className="data-table contest-problem-table">
          <thead>
            <tr>
              <th>顺序</th>
              <th>题目编号</th>
              <th>分值</th>
              <th>预计难度</th>
              <th aria-label="操作" />
            </tr>
          </thead>
          <tbody>
            {problems.map((row, index) => (
              <tr key={row.key}>
                <td data-label="顺序">{index + 1}</td>
                <td data-label="题目编号">
                  <input value={row.problemId} onChange={(event) => updateProblem(row.key, "problemId", event.target.value)} />
                </td>
                <td data-label="分值">
                  <input type="number" min={1} value={row.score} onChange={(event) => updateProblem(row.key, "score", Number(event.target.value))} />
                </td>
                <td data-label="预计难度">
                  <select value={row.estimatedDifficulty} onChange={(event) => updateProblem(row.key, "estimatedDifficulty", event.target.value)}>
                    <option value="">未设置</option>
                    {[1, 2, 3, 4, 5].map((level) => <option value={level} key={level}>{level}</option>)}
                  </select>
                </td>
                <td data-label="操作">
                  <button
                    className="icon-button danger-icon"
                    type="button"
                    aria-label={`删除第 ${index + 1} 道题`}
                    title="删除题目"
                    disabled={problems.length === 1}
                    onClick={() => setProblems((rows) => rows.filter((item) => item.key !== row.key))}
                  >
                    <Trash2 size={15} aria-hidden="true" />
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {create.error ? <p className="form-error">{create.error.message}</p> : null}
      <div className="contest-form-actions">
        <button className="primary-button" type="button" disabled={!canSubmit || create.isPending} onClick={submit}>
          {create.isPending ? "正在创建…" : "创建方案"}
        </button>
      </div>
    </section>
  );
}

function ContestDetail({ contest, currentUserId, onChanged, onDeleted }: { contest: Contest; currentUserId: string; onChanged: (contest: Contest) => void; onDeleted: () => void }) {
  const [exporting, setExporting] = useState(false);
  const changeState = useMutation({
    mutationFn: (state: "draft" | "locked" | "archived") =>
      updateContest(contest.id, { state, expectedUpdatedAt: contest.updatedAt }),
    onSuccess: onChanged
  });
  const remove = useMutation({mutationFn:()=>deleteContest(contest.id,contest.updatedAt),onSuccess:onDeleted});
  const participants = contest.members.filter((member) => member.role === "participant");
  return (
    <article className="contest-detail">
      <header className="contest-detail-header">
        <div>
          <div className="contest-detail-id">方案 {contest.id}</div>
          <h2>{contest.title}</h2>
          {contest.description ? <p>{contest.description}</p> : null}
        </div>
        <div className="inline-actions">
          <span className={`contest-state ${contest.state}`}>{stateText[contest.state]}</span>
          {contest.capabilities.canExport ? <button className="secondary-button compact-button" type="button" aria-expanded={exporting} onClick={() => setExporting((value) => !value)}>
            <Download size={15} aria-hidden="true" />{exporting ? "收起导出" : "导出比赛题目包"}
          </button> : null}
          {contest.state === "draft" && contest.capabilities.canEdit ? (
            <button className="secondary-button compact-button" type="button" disabled={changeState.isPending} onClick={() => {
              if (window.confirm("锁定后暂停修改题目、成员和比赛信息；有权限时可取消锁定。确定锁定？")) changeState.mutate("locked");
            }}>
              <LockKeyhole size={15} aria-hidden="true" />
              锁定
            </button>
          ) : null}
          {contest.state !== "archived" && contest.capabilities.canEdit ? (
            <button className="secondary-button compact-button" type="button" disabled={changeState.isPending} onClick={() => {
              if (window.confirm("归档后方案只读，仍可查看和导出；可取消归档回到草稿。不会公开私有题目。确定归档？")) changeState.mutate("archived");
            }}>
              <Archive size={15} aria-hidden="true" />
              归档比赛
            </button>
          ) : null}
          {contest.state !== "draft" && contest.capabilities.canChangeState ? <button type="button" className="secondary-button compact-button" disabled={changeState.isPending||remove.isPending} onClick={()=>{
            if(window.confirm("恢复为草稿后可以继续编辑方案，已选题目的固定版本保持不变。确定继续？"))changeState.mutate("draft");
          }}>{contest.state === "archived" ? "取消归档" : "取消锁定"}</button> : null}
          {contest.capabilities.canDelete ? <button type="button" className="danger-button compact-button" disabled={remove.isPending||changeState.isPending} onClick={()=>{
            if(window.confirm("确定删除这个比赛方案？删除后不再出现在列表，原有导出链接失效；题库里的题目不会删除。没有回收站入口。"))remove.mutate();
          }}><Trash2 size={15} aria-hidden="true" />删除比赛</button> : null}
        </div>
      </header>
      {changeState.error ? <div className="inline-error" role="alert">{changeState.error.message}</div> : null}
      {remove.error ? <div className="inline-error" role="alert">{remove.error.message}</div> : null}
      {contest.state === "archived" ? <p className="contest-archive-notice"><Archive size={18} aria-hidden="true" /><span>此比赛已归档，方案与题目版本只读保留。可取消归档回到草稿；仍按原权限查看和导出，不会因此公开题目。</span></p> : null}
      {exporting && contest.capabilities.canExport ? <section aria-label="导出比赛题目包" className="contest-detail-section">
        <ExportSection key={`${currentUserId}:${contest.id}:${contest.updatedAt}`} currentUserId={currentUserId} contest={contest} />
      </section> : null}
      <dl className="contest-metadata">
        <div><dt>创建者</dt><dd>{contest.creator.nickname}</dd></div>
        <div><dt>开始</dt><dd>{dateTime(contest.startsAt)}</dd></div>
        <div><dt>结束</dt><dd>{dateTime(contest.endsAt)}</dd></div>
        <div><dt>参与者</dt><dd>{participants.length}</dd></div>
      </dl>

      <section className="contest-detail-section">
        <div className="section-title">
          <div><p className="eyebrow">题目版本</p><h3>题目顺序</h3></div>
          <ListChecks size={19} aria-hidden="true" />
        </div>
        <div className="data-table-wrap">
          <table className="data-table contest-detail-table">
            <thead><tr><th>顺序</th><th>题目</th><th>固定修订</th><th>分值</th><th>风险</th></tr></thead>
<tbody>
            {contest.problems.length === 0 ? (
              <tr>
                <td colSpan={5} className="table-message">
                  方案里还没有题目。
                </td>
              </tr>
            ) : null}
            {contest.problems.map((problem) => (
              <tr key={problem.problemId}>
                <td data-label="顺序">{problem.position + 1}</td>
                <td data-label="题目">
                  <span className="contest-problem-name">
                    <strong>{problem.title}</strong>
                    <small>{problem.problemId}</small>
                  </span>
                </td>
                <td data-label="固定修订">第 {problem.revision} 版</td>
                <td data-label="分值">{problem.score}</td>
                <td data-label="风险">
                  {contest.capabilities.canReadRisk ? (
                    problem.leakRiskCount > 0 ? <span className="risk-count"><AlertTriangle size={14} />{problem.leakRiskCount} 人</span> : <span className="risk-clear">未发现</span>
                  ) : <span className="text-faint">不可查看</span>}
                </td>
              </tr>
            ))}
          </tbody>
          </table>
        </div>
      </section>

      <div className="contest-lower-grid">
        <section className="contest-detail-section">
          <div className="section-title"><div><p className="eyebrow">人员</p><h3>参与者</h3></div><Users size={19} /></div>
          {participants.length === 0 ? <p className="contest-empty">没有参与者。</p> : (
            <ul className="participant-list">
              {participants.map((member) => <li key={member.user.id}><strong>{member.user.nickname}</strong><span>{member.user.id}</span></li>)}
            </ul>
          )}
        </section>
        <section className="contest-detail-section">
          <div className="section-title"><div><p className="eyebrow">访问风险</p><h3>曾读题的参与者</h3></div><AlertTriangle size={19} /></div>
          {!contest.capabilities.canReadRisk ? <p className="contest-empty">当前账号不能查看访问记录。</p> : null}
          {contest.capabilities.canReadRisk && contest.problems.every((problem) => problem.leakRiskCount === 0) ? <p className="contest-empty">未发现参与者访问过这些题目。</p> : null}
          <div className="risk-list">
            {contest.problems.flatMap((problem) => problem.leakRiskEntries.map((entry) => (
              <div className="risk-entry" key={`${problem.problemId}:${entry.user.id}`}>
                <AlertTriangle size={15} aria-hidden="true" />
                <span><strong>{entry.user.nickname}</strong><small>{problem.title} · {duration(entry.totalActiveSeconds)} · 最后访问 {dateTime(entry.lastAccessedAt)}</small></span>
              </div>
            )))}
          </div>
        </section>
      </div>
    </article>
  );
}
