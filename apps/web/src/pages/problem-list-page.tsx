import {
  ChevronLeft,
  ChevronRight,
  Filter,
  Plus,
  RefreshCw,
  Search
} from "lucide-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useSearchParams, Link } from "react-router-dom";
import type {
  BatchProblemStatusAction,
  BatchProblemStatusResponse,
  ProblemListItem,
  ProblemListQuery,
  ProblemStatus,
  ProblemType,
  SessionUser
} from "@urmotiv/contracts";
import { AdminLayout } from "../components/admin-layout";
import { batchChangeProblemStatus, getSession, listProblems, listTags } from "../lib/api";
import { dateTime, difficultyText, statusText, statusTone, typeText } from "../lib/presentation";

type ProblemListPageProps = {
  ownOnly?: boolean;
  fixedStatus?: ProblemStatus;
  managementSession?: SessionUser;
};

const actionText: Record<BatchProblemStatusAction, string> = {
  submit: "提交审核",
  approve: "确认通过",
  reject: "确认不通过",
  withdraw: "撤回为草稿"
};

function canApplyAction(action: BatchProblemStatusAction, problem: ProblemListItem): boolean {
  if (!problem.capabilities.canChangeStatus) return false;
  if (action === "submit") return problem.status === "draft" || problem.status === "rejected";
  if (action === "withdraw") {
    return problem.status === "pending_review" || problem.status === "approved";
  }
  return problem.status === "pending_review";
}

export function ProblemListPage({
  ownOnly = false,
  fixedStatus,
  managementSession
}: ProblemListPageProps) {
  const queryClient = useQueryClient();
  const management = managementSession !== undefined;
  const [searchParams, setSearchParams] = useSearchParams();
  const [selected, setSelected] = useState<Map<string, ProblemListItem>>(() => new Map());
  const [action, setAction] = useState<BatchProblemStatusAction>("submit");
  const [reason, setReason] = useState("");
  const [formError, setFormError] = useState<string | null>(null);
  const [batchResult, setBatchResult] = useState<BatchProblemStatusResponse | null>(null);
  const search = searchParams.get("search") ?? "";
  const status = (searchParams.get("status") as ProblemStatus | "") || "";
  const type = (searchParams.get("type") as ProblemType | "") || "";
  const sort = (searchParams.get("sort") as ProblemListQuery["sort"]) || "updated_desc";
  const origin = searchParams.get("origin") ?? "";
  const batch = searchParams.get("batch") ?? "";
  const source = searchParams.get("source") ?? "";
  const page = Math.max(1, Number(searchParams.get("page") ?? "1") || 1);
  const pageSize = management ? 50 : 20;
  const effectiveStatus = fixedStatus ?? status;
  const mayManage = managementSession?.canManageProblemStatuses === true;

  const updateQuery = (key: string, value: string) => {
    setSearchParams((current) => {
      const next = new URLSearchParams(current);
      if (value) next.set(key, value);
      else next.delete(key);
      if (key !== "page") next.delete("page");
      return next;
    }, { replace: true });
  };

  const query: ProblemListQuery = {
    page,
    pageSize,
    search,
    owner: ownOnly ? "me" : "all",
    sort,
    ...(effectiveStatus ? { status: effectiveStatus } : {}),
    ...(type ? { type } : {}),
    ...(origin ? { origin } : {}),
    ...(batch ? { batch } : {}),
    ...(source ? { source } : {})
  };
  const problems = useQuery({
    queryKey: ["problems", query],
    queryFn: () => listProblems(query),
    placeholderData: (previous) => previous,
    enabled: !management || mayManage
  });
  const tags = useQuery({
    queryKey: ["tags"],
    queryFn: listTags,
    staleTime: 5 * 60_000,
    enabled: !management || mayManage
  });
  const session = useQuery({
    queryKey: ["session"],
    queryFn: getSession,
    staleTime: 60_000,
    enabled: managementSession === undefined
  });
  const currentSession = managementSession ?? session.data?.user ?? undefined;
  const canCreateProblem = currentSession?.permissions.includes("problem.create") ?? false;
  const tagNames = new Map(tags.data?.items.map((tag) => [tag.id, tag.name]) ?? []);
  const pages = Math.max(1, Math.ceil((problems.data?.total ?? 0) / pageSize));
  const currentEligible = (problems.data?.items ?? []).filter((problem) =>
    canApplyAction(action, problem)
  );
  const allCurrentEligibleSelected =
    currentEligible.length > 0 && currentEligible.every((problem) => selected.has(problem.id));

  const batchMutation = useMutation({
    mutationFn: batchChangeProblemStatus,
    onSuccess: async (result) => {
      setBatchResult(result);
      const succeeded = new Set(result.results.filter((item) => item.ok).map((item) => item.id));
      setSelected((current) => {
        const next = new Map(current);
        for (const id of succeeded) next.delete(id);
        return next;
      });
      await queryClient.invalidateQueries({ queryKey: ["problems"] });
    },
    onError: (error) => {
      setFormError(error instanceof Error ? error.message : "批量操作失败，请稍后重试。");
    }
  });

  const changeAction = (nextAction: BatchProblemStatusAction) => {
    setAction(nextAction);
    setFormError(null);
    setBatchResult(null);
    setSelected((current) => new Map(
      [...current].filter(([, problem]) => canApplyAction(nextAction, problem))
    ));
  };

  const toggleCurrentPage = () => {
    setFormError(null);
    setSelected((current) => {
      const next = new Map(current);
      if (allCurrentEligibleSelected) {
        for (const problem of currentEligible) next.delete(problem.id);
      } else {
        for (const problem of currentEligible) {
          if (next.size >= 200) break;
          next.set(problem.id, problem);
        }
      }
      return next;
    });
  };

  const toggleProblem = (problem: ProblemListItem) => {
    setFormError(null);
    setSelected((current) => {
      const next = new Map(current);
      if (next.has(problem.id)) next.delete(problem.id);
      else if (next.size < 200) next.set(problem.id, problem);
      return next;
    });
  };

  const runBatchAction = () => {
    setFormError(null);
    setBatchResult(null);
    if (selected.size === 0) {
      setFormError("请先选择至少一道可以执行该操作的题目。");
      return;
    }
    if (action !== "submit" && reason.trim().length === 0) {
      setFormError("请填写批量状态变更理由。");
      return;
    }
    if (!window.confirm(`确认对选中的 ${selected.size} 道题执行“${actionText[action]}”吗？`)) {
      return;
    }
    batchMutation.mutate({
      action,
      reason: reason.trim(),
      items: [...selected.values()].map((problem) => ({
        id: problem.id,
        expectedRevision: problem.revision,
        expectedRound: problem.reviewRound
      }))
    });
  };

  const filters = (
    <div className="filter-bar" aria-label="题目筛选">
      <label className="search-field">
        <Search size={16} aria-hidden="true" />
        <input
          value={search}
          onChange={(event) => updateQuery("search", event.target.value)}
          placeholder="搜索题号或名称"
        />
      </label>
      <label>
        <span>状态</span>
        <select
          value={status}
          onChange={(event) => updateQuery("status", event.target.value)}
          disabled={fixedStatus !== undefined}
        >
          <option value="">全部状态</option>
          <option value="draft">草稿</option>
          <option value="pending_review">待审核</option>
          <option value="approved">审核通过</option>
          <option value="rejected">审核不通过</option>
        </select>
      </label>
      <label>
        <span>题目类型</span>
        <select value={type} onChange={(event) => updateQuery("type", event.target.value)}>
          <option value="">全部类型</option>
          <option value="traditional">传统题</option>
          <option value="interactive">交互题</option>
          <option value="submit_answer">提交答案题</option>
        </select>
      </label>
      <label>
        <span>来源</span>
        <select value={origin} onChange={(event) => updateQuery("origin", event.target.value)}>
          <option value="">全部来源</option>
          <option value="native">本站创建</option>
          <option value="problem-package">题目包导入</option>
          <option value="ustc_history">USTC 历史题库</option>
        </select>
      </label>
      <label>
        <span>导入批次</span>
        <input
          value={batch}
          onChange={(event) => updateQuery("batch", event.target.value)}
          placeholder="批次标识"
        />
      </label>
      <label>
        <span>导入源</span>
        <input
          value={source}
          onChange={(event) => updateQuery("source", event.target.value)}
          placeholder="来源标识"
        />
      </label>
      <label>
        <span>排序</span>
        <select value={sort} onChange={(event) => updateQuery("sort", event.target.value)}>
          <option value="updated_desc">最近更新</option>
          <option value="updated_asc">最早更新</option>
          <option value="difficulty_asc">难度从低到高</option>
          <option value="difficulty_desc">难度从高到低</option>
        </select>
      </label>
      <span className="filter-count">
        <Filter size={15} aria-hidden="true" />
        {problems.data?.total ?? 0} 道
      </span>
    </div>
  );

  const managementToolbar = management ? (
    <section className="problem-batch-toolbar plain-panel" aria-labelledby="problem-batch-title">
      <div className="problem-batch-heading">
        <div>
          <p className="eyebrow">批量操作</p>
          <h2 id="problem-batch-title">已选择 {selected.size} 道题</h2>
          <p>每道题都按当前修订和审核轮次校验；失败项不会覆盖新修改。</p>
        </div>
        {selected.size > 0 ? (
          <button className="text-button" type="button" onClick={() => setSelected(new Map())}>
            清空选择
          </button>
        ) : null}
      </div>
      <div className="problem-batch-controls">
        <label className="field">
          <span>状态操作</span>
          <select
            value={action}
            disabled={batchMutation.isPending}
            onChange={(event) => changeAction(event.target.value as BatchProblemStatusAction)}
          >
            <option value="submit">提交审核</option>
            <option value="approve">确认通过</option>
            <option value="reject">确认不通过</option>
            <option value="withdraw">撤回为草稿</option>
          </select>
        </label>
        <label className="field problem-batch-reason">
          <span>{action === "submit" ? "操作说明（可选）" : "变更理由"}</span>
          <input
            value={reason}
            disabled={batchMutation.isPending}
            maxLength={2_000}
            onChange={(event) => setReason(event.target.value)}
            placeholder={action === "submit" ? "提交审核不强制填写" : "该理由会记录在审核决定中"}
          />
        </label>
        <button
          className="primary-button"
          type="button"
          disabled={batchMutation.isPending || selected.size === 0}
          onClick={runBatchAction}
        >
          {batchMutation.isPending ? "正在处理…" : `执行${actionText[action]}`}
        </button>
      </div>
      {formError ? <p className="inline-error" role="alert">{formError}</p> : null}
      {batchResult ? (
        <div className="problem-batch-result" role="status">
          <strong>
            已完成：{batchResult.results.filter((item) => item.ok).length} 道成功，
            {batchResult.results.filter((item) => !item.ok).length} 道失败。
          </strong>
          {batchResult.results.some((item) => !item.ok) ? (
            <ul>
              {batchResult.results.filter((item) => !item.ok).map((item) => (
                <li key={item.id}>{item.id}：{item.ok ? "" : item.message}</li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}
    </section>
  ) : null;

  const listContent = (
    <>
      {filters}
      {managementToolbar}
      {problems.isError ? (
        <div className="inline-error" role="alert">
          <strong>题目列表加载失败</strong>
          <span>{problems.error.message}</span>
          <button
            className="secondary-button compact-button"
            type="button"
            disabled={problems.isRefetching}
            onClick={() => void problems.refetch()}
          >
            <RefreshCw size={15} aria-hidden="true" />
            重试
          </button>
        </div>
      ) : null}

      <div className="data-table-wrap">
        <table className="data-table problem-table">
          <thead>
            <tr>
              {management ? (
                <th className="selection-column">
                  <input
                    type="checkbox"
                    aria-label="选择本页可操作题目"
                    checked={allCurrentEligibleSelected}
                    disabled={currentEligible.length === 0 || batchMutation.isPending}
                    onChange={toggleCurrentPage}
                  />
                </th>
              ) : null}
              <th>题目</th>
              <th>状态</th>
              <th>类型</th>
              <th>知识点</th>
              <th>难度</th>
              <th>作者</th>
              <th>更新</th>
            </tr>
          </thead>
          <tbody>
            {problems.isLoading ? (
              <tr>
                <td colSpan={management ? 8 : 7} className="table-message">正在加载题目…</td>
              </tr>
            ) : null}
            {!problems.isLoading && !problems.data?.items.length ? (
              <tr>
                <td colSpan={management ? 8 : 7} className="table-message">没有符合条件的题目</td>
              </tr>
            ) : null}
            {problems.data?.items.map((problem) => {
              const eligible = canApplyAction(action, problem);
              return (
                <tr key={problem.id} className={selected.has(problem.id) ? "selected-row" : undefined}>
                  {management ? (
                    <td data-label="选择" className="selection-column">
                      <input
                        type="checkbox"
                        aria-label={`选择题目 ${problem.title}`}
                        checked={selected.has(problem.id)}
                        disabled={!eligible || batchMutation.isPending}
                        onChange={() => toggleProblem(problem)}
                      />
                    </td>
                  ) : null}
                  <td data-label="题目">
                    <Link to={`/problems/${encodeURIComponent(problem.id)}`} className="problem-link">
                      <strong>{problem.title}</strong>
                      <span>{problem.id}</span>
                    </Link>
                  </td>
                  <td data-label="状态">
                    <span className={`status-badge ${statusTone[problem.status]}`}>
                      {statusText[problem.status]}
                    </span>
                  </td>
                  <td data-label="类型">{typeText[problem.type]}</td>
                  <td data-label="知识点">
                    <div className="compact-tags">
                      {problem.tagIds.slice(0, 2).map((tag) => (
                        <span key={tag}>{tagNames.get(tag) ?? tag}</span>
                      ))}
                      {problem.tagIds.length > 2 ? <span>+{problem.tagIds.length - 2}</span> : null}
                    </div>
                  </td>
                  <td data-label="难度">{difficultyText(problem.codeforcesDifficulty)}</td>
                  <td data-label="作者">{problem.owner.nickname}</td>
                  <td data-label="更新">{dateTime(problem.updatedAt)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <div className="pagination" aria-label="题目分页">
        <span>第 {Math.min(page, pages)} / {pages} 页</span>
        <div>
          <button
            className="icon-button bordered"
            type="button"
            title="上一页"
            aria-label="上一页"
            disabled={page <= 1}
            onClick={() => updateQuery("page", String(Math.max(1, page - 1)))}
          >
            <ChevronLeft size={17} aria-hidden="true" />
          </button>
          <button
            className="icon-button bordered"
            type="button"
            title="下一页"
            aria-label="下一页"
            disabled={page >= pages}
            onClick={() => updateQuery("page", String(Math.min(pages, page + 1)))}
          >
            <ChevronRight size={17} aria-hidden="true" />
          </button>
        </div>
      </div>
    </>
  );

  if (management && managementSession !== undefined) {
    return (
      <AdminLayout
        session={managementSession}
        title="题目管理"
        description="筛选题库、跨页选择题目，并按审核状态机批量提交、终审或撤回。"
        actions={canCreateProblem ? (
          <Link className="primary-button" to="/problems/new">
            <Plus size={17} aria-hidden="true" />
            新建题目
          </Link>
        ) : undefined}
      >
        {mayManage ? (
          <div className="admin-problem-management">{listContent}</div>
        ) : (
          <div className="inline-error" role="alert">当前账号没有批量管理题目状态的权限。</div>
        )}
      </AdminLayout>
    );
  }

  return (
    <section className="problem-list-page">
      <div className="page-heading list-heading">
        <div>
          <p className="eyebrow">{ownOnly ? "投稿" : fixedStatus ? "审核" : "题库"}</p>
          <h1>{ownOnly ? "我的投稿" : fixedStatus ? "待审核题目" : "题目"}</h1>
          <p>
            {ownOnly
              ? "查看自己创建的草稿和审核进度。"
              : fixedStatus
                ? "只显示当前账号可以审核或查看的待审核题目。"
                : "只显示当前账号有权查看的题目。"}
          </p>
        </div>
        {canCreateProblem ? (
          <Link className="primary-button" to="/problems/new">
            <Plus size={17} aria-hidden="true" />
            新建题目
          </Link>
        ) : null}
      </div>
      {listContent}
    </section>
  );
}
