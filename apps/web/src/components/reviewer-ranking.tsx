import { useQuery } from "@tanstack/react-query";
import { useSearchParams } from "react-router-dom";
import { getReviewerLeaderboard } from "../lib/api";
export function ReviewerRanking() {
  const [params, setParams] = useSearchParams();
  const sort = params.get("sort") === "accuracy" ? "accuracy" : "reviewed";
  const raw = Number(params.get("page") ?? 1),
    page = Number.isInteger(raw) && raw > 0 && raw <= 100000 ? raw : 1;
  const ranking = useQuery({
    queryKey: ["reviewer-ranking", sort, page],
    queryFn: () => getReviewerLeaderboard({ sort, page, pageSize: 30 }),
  });
  const pages = Math.max(1, Math.ceil((ranking.data?.total ?? 0) / 30));
  return (
    <>
      <section className="plain-panel leaderboard-panel" aria-label="审题排名">
        <div className="leaderboard-toolbar">
          <span>{ranking.data?.total ?? 0} 位审题人</span>
          <label>
            排序方式
            <select
              value={sort}
              onChange={(e) =>
                setParams({ kind: "reviewers", sort: e.target.value })
              }
            >
              <option value="reviewed">已审题数</option>
              <option value="accuracy">结果一致率（正确率）</option>
            </select>
          </label>
        </div>
        {ranking.isPending ? (
          <p role="status">正在读取榜单…</p>
        ) : ranking.error ? (
          <p role="alert">
            暂时无法读取榜单。
            <button onClick={() => void ranking.refetch()}>重试</button>
          </p>
        ) : ranking.data?.items.length ? (
          <table className="leaderboard-table reviewer-table">
            <thead>
              <tr>
                <th>排名 / 审题人</th>
                <th>已审</th>
                <th>已定案</th>
                <th>一致率</th>
              </tr>
            </thead>
            <tbody>
              {ranking.data.items.map((row, index) => (
                <tr key={row.id}>
                  <th scope="row">
                    <span className="leaderboard-person">
                      <span className="leaderboard-rank">
                        {(page - 1) * 30 + index + 1}
                      </span>
                      <span>{row.nickname}</span>
                    </span>
                  </th>
                  <td>{row.reviewed}</td>
                  <td>{row.decided}</td>
                  <td>
                    {row.accuracy === null
                      ? "—"
                      : (100 * row.accuracy).toFixed(1) + "%"}
                    <small className="review-matched">
                      {row.matched} / {row.decided}
                    </small>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <p>暂无人工审题记录。</p>
        )}
        <nav className="leaderboard-pagination" aria-label="榜单分页">
          <button
            className="secondary-button"
            disabled={page === 1}
            onClick={() =>
              setParams({ kind: "reviewers", sort, page: String(page - 1) })
            }
          >
            上一页
          </button>
          <span>
            {page} / {pages}
          </span>
          <button
            className="secondary-button"
            disabled={page >= pages}
            onClick={() =>
              setParams({ kind: "reviewers", sort, page: String(page + 1) })
            }
          >
            下一页
          </button>
        </nav>
      </section>
      <p className="muted-note leaderboard-explanation">
        已审按题目去重，多轮或修改意见不重复计数。结果一致率＝与最终结果一致的题数
        /
        可比较的已定案题数：明确“通过”对最终通过，明确“不通过”对最终不通过。只比较当前轮次；待审、撤回、旧轮次和“需要修改”不进入分母。无可比较样本显示
        —，按一致率排序时置后。仅统计有效人工意见，排除机器人、已删除题目和停用账号；同率优先样本多者。这是与站点结果的一致程度，不是独立的审题能力评测，也不保证最终结论正确。
      </p>
    </>
  );
}
