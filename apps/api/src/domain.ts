import type {
  PermissionGrant,
  ProblemContent,
  ProblemJudgeConfig,
  ProblemSample,
  ProblemStatus,
  ProblemType,
  Review,
  UserSummary
} from "@urmotiv/contracts";

export interface StoredUser extends UserSummary {
  disabled: boolean;
  roles: string[];
  grants: PermissionGrant[];
  isRoot: boolean;
}

export interface StoredProblem {
  id: string;
  /** Internal immutable revision identifier; it is never sent in the public API. */
  revisionId?: string;
  title: string;
  type: ProblemType;
  tagIds: string[];
  codeforcesDifficulty: number | null;
  thinkingLevel: number | null;
  codingLevel: number | null;
  content: ProblemContent;
  samples: ProblemSample[];
  judgeConfig?: ProblemJudgeConfig | null;
  status: ProblemStatus;
  ownerId: string;
  revision: number;
  reviewRound: number;
  /** The immutable rule and result for the current review round. */
  reviewRoundState?: StoredReviewRoundState;
  createdAt: string;
  updatedAt: string;
}

export interface StoredReviewRule {
  readonly ruleId: string;
  readonly pluginVersion: string;
  readonly settings: Record<string, unknown>;
}

export interface StoredReviewPolicy extends StoredReviewRule {
  readonly revision: number;
  readonly updatedByUserId: string | null;
  readonly updatedAt: string;
}

export interface StoredReviewRoundState extends StoredReviewRule {
  readonly round: number;
  readonly status: "open" | "approved" | "rejected" | "withdrawn";
  readonly submittedContentHash: string;
  readonly decisionReason: string | null;
  /** Opinion ids frozen for the approval/rejection counters when the round closes. */
  readonly countedOpinionIds: readonly string[];
  /** Evidence used only by an automatic rule decision. */
  readonly usedOpinionIds: readonly string[];
  readonly usedReviewItemIds: readonly string[];
  readonly decisionSource: "rule" | "manual" | "withdrawal" | null;
  readonly decidedAt: string | null;
  /** Present only while writing an audit event in the same transaction. */
  readonly decisionRequestId?: string;
}

export interface StoredReview extends Review {
  reviewerId: string;
}

export interface StoredSession {
  id: string;
  userId: string;
  expiresAt: string;
}

export interface ProblemListFilters {
  page: number;
  pageSize: number;
  search: string;
  status?: ProblemStatus;
  type?: ProblemType;
  owner: "me" | "all";
  sort: "updated_desc" | "updated_asc" | "difficulty_asc" | "difficulty_desc";
}

export interface VisibleProblemPage {
  items: StoredProblem[];
  total: number;
}
