import { sql } from "drizzle-orm";
import type { DatabaseExecutor } from "@urmotiv/database";
import type {
  ReviewerLeaderboardQuery,
  ReviewerLeaderboardResponse,
  ReviewerStatistics,
} from "@urmotiv/contracts";
import type { StoredProblem, StoredReview, StoredUser } from "./domain";
export const emptyReviewerStatistics = (): ReviewerStatistics => ({
  reviewed: 0,
  decided: 0,
  matched: 0,
  accuracy: null,
});
// 每人每题只计一次；一致率只使用当前已定案轮次中的明确通过/拒绝意见。
export async function databaseReviewerStatistics(
  database: DatabaseExecutor,
  query: ReviewerLeaderboardQuery,
  userId?: string,
): Promise<ReviewerLeaderboardResponse> {
  const order =
    query.sort === "accuracy"
      ? sql`accuracy DESC NULLS LAST,decided DESC,reviewed DESC,totals.id ASC`
      : sql`reviewed DESC,decided DESC,totals.id ASC`;
  const result = await database.query<{
    total: number;
    items: ReviewerLeaderboardResponse["items"];
  }>(sql`
    WITH contribution AS (
      SELECT u.id,u.nickname,r.problem_id,
        bool_or(r.round=p.current_review_round AND p.status IN ('approved','rejected') AND r.status::text=p.status::text AND o.verdict IN ('approve','reject')) AS decided,
        bool_or(r.round=p.current_review_round AND r.status::text=p.status::text AND ((p.status='approved' AND o.verdict='approve') OR (p.status='rejected' AND o.verdict='reject'))) AS matched
      FROM review_opinions o JOIN review_rounds r ON r.id=o.round_id JOIN problems p ON p.id=r.problem_id JOIN users u ON u.id=o.reviewer_user_id
      WHERE o.is_active=true AND o.source='human' AND u.account_type='human' AND u.disabled_at IS NULL AND u.deleted_at IS NULL AND p.deleted_at IS NULL ${userId === undefined ? sql`` : sql`AND u.id=${BigInt(userId)}`}
      GROUP BY u.id,u.nickname,r.problem_id
    ), totals AS (
      SELECT id,nickname,count(*)::int AS reviewed,count(*) FILTER(WHERE decided)::int AS decided,count(*) FILTER(WHERE decided AND matched)::int AS matched,
        (count(*) FILTER(WHERE decided AND matched))::double precision/nullif(count(*) FILTER(WHERE decided),0) AS accuracy
      FROM contribution GROUP BY id,nickname
    ), selected AS (SELECT id::text,nickname,reviewed,decided,matched,accuracy FROM totals ORDER BY ${order} LIMIT ${query.pageSize} OFFSET ${(query.page - 1) * query.pageSize})
    SELECT (SELECT count(*)::int FROM totals) AS total,coalesce((SELECT jsonb_agg(selected) FROM selected),'[]'::jsonb) AS items
  `);
  return { ...result[0]!, page: query.page, pageSize: query.pageSize };
}
export function memoryReviewerStatistics(
  users: Iterable<StoredUser>,
  problems: ReadonlyMap<string, StoredProblem>,
  reviews: Iterable<StoredReview>,
): ReviewerLeaderboardResponse["items"] {
  const eligible = new Map(
    [...users]
      .filter((user) => !user.disabled && user.accountType === "human")
      .map((user) => [user.id, user]),
  );
  const byReviewer = new Map<string, Map<string, StoredReview>>();
  for (const review of reviews) {
    if (
      review.source !== "human" ||
      !eligible.has(review.reviewerId) ||
      !problems.has(review.problemId)
    )
      continue;
    const items = byReviewer.get(review.reviewerId) ?? new Map();
    const previous = items.get(review.problemId);
    if (!previous || previous.expectedRound < review.expectedRound)
      items.set(review.problemId, review);
    byReviewer.set(review.reviewerId, items);
  }
  return [...byReviewer].map(([id, items]) => {
    const result = {
      id,
      nickname: eligible.get(id)!.nickname,
      ...emptyReviewerStatistics(),
      reviewed: items.size,
    };
    for (const review of items.values()) {
      const p = problems.get(review.problemId)!;
      if (
        p.reviewRound !== review.expectedRound ||
        !["approved", "rejected"].includes(p.status) ||
        review.verdict === "request_changes"
      )
        continue;
      result.decided++;
      if (
        (p.status === "approved" && review.verdict === "approve") ||
        (p.status === "rejected" && review.verdict === "reject")
      )
        result.matched++;
    }
    result.accuracy = result.decided ? result.matched / result.decided : null;
    return result;
  });
}
