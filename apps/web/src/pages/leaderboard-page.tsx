import { useQuery } from "@tanstack/react-query";
import { Link, useSearchParams } from "react-router-dom";
import { Trophy } from "lucide-react";
import type { LeaderboardQuery } from "@urmotiv/contracts";
import { getLeaderboard } from "../lib/api";
import { BrandMark } from "../components/brand-mark";

export function LeaderboardPage({ publicView = false }: { publicView?: boolean }) {
  const [params,setParams] = useSearchParams();
  const requestedSort=params.get("sort");
  const sort: LeaderboardQuery["sort"] = requestedSort === "approved" || requestedSort === "rejected" ? requestedSort : "submitted";
  const requestedPage=Number(params.get("page") ?? 1);
  const page=Number.isInteger(requestedPage) && requestedPage>=1 && requestedPage<=100_000 ? requestedPage : 1;
  const pageSize=30;
  const ranking=useQuery({queryKey:["leaderboard",sort,page],queryFn:()=>getLeaderboard({sort,page,pageSize})});
  const pages=Math.max(1,Math.ceil((ranking.data?.total??0)/pageSize));
  const content=<div className="leaderboard-page">
    <header className="page-heading"><div><p className="eyebrow">每一份投稿都值得被看见</p><h1><Trophy size={30} aria-hidden="true" /> 投稿榜单</h1>
      <p>一起让题库更丰富。这里记录大家正式提交过的题目。</p></div></header>
    <section className="plain-panel leaderboard-panel" aria-label="投稿排名">
      <div className="leaderboard-toolbar"><span>{ranking.data ? `${ranking.data.total} 位投稿人` : "投稿人"}</span>
        <label>排序方式<select value={sort} onChange={event=>setParams({sort:event.target.value,page:"1"})}>
          <option value="submitted">投稿数</option><option value="approved">通过数</option><option value="rejected">拒绝数</option>
        </select></label></div>
      {ranking.isPending ? <p role="status">正在读取榜单…</p> : ranking.isError ? <div role="alert"><p>暂时无法读取榜单。</p><button type="button" className="secondary-button" onClick={()=>void ranking.refetch()}>重新读取</button></div> : <>
        {ranking.data.items.length ? <table className="leaderboard-table"><thead><tr><th scope="col">排名 / 投稿人</th><th scope="col" aria-sort={sort==="submitted"?"descending":"none"}>投稿</th><th scope="col" aria-sort={sort==="approved"?"descending":"none"}>通过</th><th scope="col" aria-sort={sort==="rejected"?"descending":"none"}>拒绝</th></tr></thead>
          <tbody>{ranking.data.items.map((row,index)=><tr key={row.id}><th scope="row"><span className="leaderboard-person"><span className={`leaderboard-rank${page===1&&index<3?" podium":""}`}>{(page-1)*pageSize+index+1}</span><span>{row.nickname}</span></span></th><td>{row.submitted}</td><td>{row.approved}</td><td>{row.rejected}</td></tr>)}</tbody>
        </table> : <p className="empty-state">{page>1?"这一页没有投稿人，请返回上一页。":"还没有正式投稿，期待你的第一道题。"}</p>}
      </>}
      <nav className="leaderboard-pagination" aria-label="榜单分页"><button type="button" className="secondary-button" disabled={page<=1||ranking.isPending} onClick={()=>setParams({sort,page:String(page-1)})}>上一页</button><span>{page} / {pages}</span><button type="button" className="secondary-button" disabled={page>=pages||ranking.isPending} onClick={()=>setParams({sort,page:String(page+1)})}>下一页</button></nav>
    </section>
    <p className="muted-note leaderboard-explanation">投稿数按题目去重，重复送审不重复计数；未提交的草稿、已删除题目和迁移的历史题库不计入。通过与拒绝按题目当前状态统计。榜单仅公开昵称和汇总数量，不公开题目内容或联系方式。</p>
  </div>;
  if(!publicView) return content;
  return <div className="app-shell"><header className="global-header public-header"><div className="global-header-inner"><Link to="/leaderboard" className="brand"><BrandMark /><span>Urmotiv</span></Link><Link to="/login" className="secondary-button">登录 / 注册</Link></div></header><main className="main-content">{content}</main></div>;
}
