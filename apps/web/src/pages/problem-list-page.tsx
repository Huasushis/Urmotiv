import { ChevronLeft, ChevronRight, Filter, Plus, Search } from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { Link } from "react-router-dom";
import type { ProblemListQuery, ProblemStatus, ProblemType } from "@urmotiv/contracts";
import { listProblems, listTags } from "../lib/api";
import { dateTime, difficultyText, statusText, statusTone, typeText } from "../lib/presentation";

type ProblemListPageProps = { ownOnly?: boolean; fixedStatus?: ProblemStatus };

export function ProblemListPage({ ownOnly = false, fixedStatus }: ProblemListPageProps) {
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState<ProblemStatus | "">(fixedStatus ?? "");
  const [type, setType] = useState<ProblemType | "">("");
  const [sort, setSort] = useState<ProblemListQuery["sort"]>("updated_desc");
  const [page, setPage] = useState(1);
  const effectiveStatus = fixedStatus ?? status;

  const query: ProblemListQuery = {
    page,
    pageSize: 20,
    search,
    owner: ownOnly ? "me" : "all",
    sort,
    ...(effectiveStatus ? { status: effectiveStatus } : {}),
    ...(type ? { type } : {})
  };
  const problems = useQuery({
    queryKey: ["problems", query],
    queryFn: () => listProblems(query),
    placeholderData: (previous) => previous
  });
  const tags = useQuery({ queryKey: ["tags"], queryFn: listTags, staleTime: 5 * 60_000 });
  const tagNames = new Map(tags.data?.items.map((tag) => [tag.id, tag.name]) ?? []);
  const pages = Math.max(1, Math.ceil((problems.data?.total ?? 0) / 20));

  const resetPage = (change: () => void) => {
    setPage(1);
    change();
  };

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
        <Link className="primary-button" to="/problems/new">
          <Plus size={17} aria-hidden="true" />
          新建题目
        </Link>
      </div>

      <div className="filter-bar" aria-label="题目筛选">
        <label className="search-field">
          <Search size={16} aria-hidden="true" />
          <input
            value={search}
            onChange={(event) => resetPage(() => setSearch(event.target.value))}
            placeholder="搜索题号或名称"
          />
        </label>
        <label>
          <span>状态</span>
          <select
            value={status}
            onChange={(event) => resetPage(() => setStatus(event.target.value as ProblemStatus | ""))}
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
          <select
            value={type}
            onChange={(event) => resetPage(() => setType(event.target.value as ProblemType | ""))}
          >
            <option value="">全部类型</option>
            <option value="traditional">传统题</option>
            <option value="interactive">交互题</option>
            <option value="submit_answer">提交答案题</option>
          </select>
        </label>
        <label>
          <span>排序</span>
          <select
            value={sort}
            onChange={(event) => setSort(event.target.value as ProblemListQuery["sort"])}
          >
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

      {problems.isError ? (
        <div className="inline-error" role="alert">
          <strong>题目列表加载失败</strong>
          <span>{problems.error.message}</span>
        </div>
      ) : null}

      <div className="data-table-wrap">
        <table className="data-table problem-table">
          <thead>
            <tr>
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
                <td colSpan={7} className="table-message">
                  正在加载题目…
                </td>
              </tr>
            ) : null}
            {!problems.isLoading && !problems.data?.items.length ? (
              <tr>
                <td colSpan={7} className="table-message">
                  没有符合条件的题目
                </td>
              </tr>
            ) : null}
            {problems.data?.items.map((problem) => (
              <tr key={problem.id}>
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
            ))}
          </tbody>
        </table>
      </div>

      <div className="pagination" aria-label="题目分页">
        <span>
          第 {Math.min(page, pages)} / {pages} 页
        </span>
        <div>
          <button
            className="icon-button bordered"
            type="button"
            title="上一页"
            aria-label="上一页"
            disabled={page <= 1}
            onClick={() => setPage((value) => Math.max(1, value - 1))}
          >
            <ChevronLeft size={17} aria-hidden="true" />
          </button>
          <button
            className="icon-button bordered"
            type="button"
            title="下一页"
            aria-label="下一页"
            disabled={page >= pages}
            onClick={() => setPage((value) => Math.min(pages, value + 1))}
          >
            <ChevronRight size={17} aria-hidden="true" />
          </button>
        </div>
      </div>
    </section>
  );
}
