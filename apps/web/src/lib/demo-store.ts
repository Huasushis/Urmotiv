import type {
  CreateProblemInput,
  Problem,
  ProblemCapabilities,
  ProblemListQuery,
  ProblemListResponse,
  ProblemStatus,
  ReviewInput,
  ReviewRoundSummary,
  SessionResponse,
  UpdateProblemInput
} from "@urmotiv/contracts";
import { ApiError } from "./api";

const storageKey = "urmotiv.web.demo.problems.v1";
const sessionKey = "urmotiv.web.demo.session.v1";
const now = () => new Date().toISOString();

const demoUsers = {
  author: { id: "author", nickname: "谢清", accountType: "human" as const, roles: ["投稿人"] },
  reviewer: { id: "reviewer", nickname: "林澈", accountType: "human" as const, roles: ["审题人"] },
  member: { id: "member", nickname: "周遥", accountType: "human" as const, roles: ["命题组成员"] },
  leader: { id: "leader", nickname: "顾岚", accountType: "human" as const, roles: ["组长"] },
  robot: { id: "robot", nickname: "审核助手", accountType: "robot" as const, roles: ["自动审核"] },
  denied: { id: "denied", nickname: "受限账号", accountType: "human" as const, roles: ["投稿人"] }
};

type DemoUserId = keyof typeof demoUsers;

const initialProblems: Problem[] = [
  {
    id: "p-2026-004",
    title: "交错的航线",
    type: "traditional",
    status: "draft",
    tagIds: ["graph.shortest-path", "graph.dag"],
    codeforcesDifficulty: 1600,
    thinkingLevel: 3,
    codingLevel: 3,
    content: {
      basicStatement:
        "给定一张有向无环图，求从起点到终点的最短路径数。答案对 $998244353$ 取模。",
      basicSolution: "按拓扑序动态规划。令 $dp[v]$ 表示到达 $v$ 的方案数。",
      background: "一支测绘队需要在多条航线中安排最短行程。",
      statement: "图有 $n$ 个点、$m$ 条边。请输出最短路条数。",
      inputFormat: "第一行给出 $n,m,s,t$，之后每行给出一条有向边。",
      outputFormat: "输出一行答案。",
      constraints: "$1 \\le n,m \\le 2\\times10^5$。",
      solution: "",
      hints: "先确认图中的距离如何计算。"
    },
    samples: [
      {
        id: "30edda7d-2424-4d97-9fde-4c3d850e3a15",
        input: "4 4 1 4\n1 2\n1 3\n2 4\n3 4",
        output: "2",
        explanation: "有两条长度相同的最短路径。"
      }
    ],
    judgeConfig: null,
    owner: { id: "author", nickname: "谢清", accountType: "human" },
    revision: 3,
    reviewRound: 0,
    createdAt: "2026-07-24T03:20:00.000Z",
    updatedAt: "2026-07-25T01:40:00.000Z",
    capabilities: emptyCapabilities()
  },
  {
    id: "p-2026-003",
    title: "镜面序列",
    type: "traditional",
    status: "pending_review",
    tagIds: ["data-structure.segment-tree", "offline"],
    codeforcesDifficulty: 1900,
    thinkingLevel: 4,
    codingLevel: 4,
    content: {
      basicStatement: "维护一个序列，支持区间翻转与查询最长连续相同元素。",
      basicSolution: "线段树记录左右端点、最长段和懒标记。",
      background: "",
      statement: "",
      inputFormat: "",
      outputFormat: "",
      constraints: "",
      solution: "",
      hints: ""
    },
    samples: [],
    judgeConfig: null,
    owner: { id: "member", nickname: "周遥", accountType: "human" },
    revision: 7,
    reviewRound: 1,
    createdAt: "2026-07-20T05:00:00.000Z",
    updatedAt: "2026-07-24T09:15:00.000Z",
    capabilities: emptyCapabilities()
  },
  {
    id: "p-2026-001",
    title: "最短回声",
    type: "interactive",
    status: "approved",
    tagIds: ["graph.shortest-path"],
    codeforcesDifficulty: 2100,
    thinkingLevel: 4,
    codingLevel: 4,
    content: {
      basicStatement: "通过有限次询问恢复隐藏图的一条最短路径。",
      basicSolution: "用分治缩小路径所在的层。",
      background: "",
      statement: "",
      inputFormat: "",
      outputFormat: "",
      constraints: "",
      solution: "",
      hints: ""
    },
    samples: [],
    judgeConfig: null,
    owner: { id: "leader", nickname: "顾岚", accountType: "human" },
    revision: 12,
    reviewRound: 1,
    createdAt: "2026-07-18T02:30:00.000Z",
    updatedAt: "2026-07-23T03:45:00.000Z",
    capabilities: emptyCapabilities()
  }
];

const tags = [
  { id: "graph.shortest-path", name: "最短路", group: "图论" },
  { id: "graph.dag", name: "有向无环图", group: "图论" },
  { id: "data-structure.segment-tree", name: "线段树", group: "数据结构" },
  { id: "offline", name: "离线处理", group: "算法技巧" },
  { id: "dp", name: "动态规划", group: "算法基础" },
  { id: "math", name: "数论", group: "数学" }
];

function emptyCapabilities(): ProblemCapabilities {
  return {
    canView: false,
    canEdit: false,
    canEditFrozen: false,
    canSubmit: false,
    canWithdraw: false,
    canReview: false,
    canChangeStatus: false,
    canReadTestdata: false,
    canWriteTestdata: false,
    canExport: false,
    canViewAccessLog: false
  };
}

function currentUserId(): DemoUserId {
  const saved = window.localStorage.getItem(sessionKey);
  return saved && saved in demoUsers ? (saved as DemoUserId) : "author";
}

function permissionsFor(userId: DemoUserId, problem: Problem): ProblemCapabilities {
  const isOwner = problem.owner.id === userId;
  const isDraftLike = problem.status === "draft" || problem.status === "rejected";
  const all = userId === "leader";
  const member = userId === "member";
  const reviewer = userId === "reviewer";
  const robot = userId === "robot";
  const denied = userId === "denied";

  if (denied) {
    return emptyCapabilities();
  }
  if (all) {
    return {
      canView: true,
      canEdit: true,
      canEditFrozen: false,
      canSubmit: isDraftLike,
      canWithdraw: problem.status === "pending_review" || problem.status === "approved",
      canReview: problem.status === "pending_review",
      canChangeStatus: true,
      canReadTestdata: true,
      canWriteTestdata: true,
      canExport: true,
      canViewAccessLog: true
    };
  }
  if (member) {
    return {
      canView: true,
      canEdit: true,
      canEditFrozen: false,
      canSubmit: isOwner && isDraftLike,
      canWithdraw: isOwner && (problem.status === "pending_review" || problem.status === "approved"),
      canReview: problem.status === "pending_review",
      canChangeStatus: false,
      canReadTestdata: true,
      canWriteTestdata: true,
      canExport: isOwner,
      canViewAccessLog: true
    };
  }
  if (reviewer || robot) {
    return {
      ...emptyCapabilities(),
      canView: true,
      canReview: problem.status === "pending_review",
      canReadTestdata: reviewer
    };
  }
  if (isOwner) {
    return {
      ...emptyCapabilities(),
      canView: true,
      canEdit: isDraftLike,
      canSubmit: isDraftLike,
      canWithdraw: problem.status === "pending_review" || problem.status === "approved",
      canExport: true
    };
  }
  return emptyCapabilities();
}

function decorate(problem: Problem): Problem {
  const userId = currentUserId();
  return { ...problem, capabilities: permissionsFor(userId, problem) };
}

function loadProblems(): Problem[] {
  const saved = window.localStorage.getItem(storageKey);
  if (!saved) {
    return initialProblems;
  }
  try {
    return JSON.parse(saved) as Problem[];
  } catch {
    return initialProblems;
  }
}

function saveProblems(problems: Problem[]): void {
  window.localStorage.setItem(storageKey, JSON.stringify(problems));
}

function findProblem(id: string): { problem: Problem; index: number; all: Problem[] } {
  const all = loadProblems();
  const index = all.findIndex((problem) => problem.id === id);
  if (index < 0) {
    throw new ApiError("题目不存在或你没有查看权限。", 404);
  }
  const problem = all[index];
  if (!problem) {
    throw new ApiError("题目不存在或你没有查看权限。", 404);
  }
  return { problem, index, all };
}

function requireEdit(problem: Problem): void {
  if (!decorate(problem).capabilities.canEdit) {
    throw new ApiError("你没有修改这道题的权限。", 403);
  }
}

function requireRevision(problem: Problem, expected: number): void {
  if (problem.revision !== expected) {
    throw new ApiError("题目已被其他人修改，请刷新后再试。", 409);
  }
}

function contentWithDefaults(input: CreateProblemInput["content"]): Problem["content"] {
  return {
    basicStatement: input?.basicStatement ?? "",
    basicSolution: input?.basicSolution ?? "",
    background: input?.background ?? "",
    statement: input?.statement ?? "",
    inputFormat: input?.inputFormat ?? "",
    outputFormat: input?.outputFormat ?? "",
    constraints: input?.constraints ?? "",
    solution: input?.solution ?? "",
    hints: input?.hints ?? ""
  };
}

export async function getDemoSession(): Promise<SessionResponse> {
  const saved = window.localStorage.getItem(sessionKey);
  if (!saved || !(saved in demoUsers)) {
    return {
      user: null,
      auth: { emailEnabled: false, emailRegistrationEnabled: false, casEnabled: false, demoEnabled: true }
    };
  }
  const user = demoUsers[saved as DemoUserId];
  const canManageReviewPolicy = saved === "leader";
  return {
    user: {
      id: user.id,
      nickname: user.nickname,
      accountType: user.accountType,
      roles: user.roles,
      isRoot: false,
      permissions: canManageReviewPolicy ? ["problem.status.change"] : [],
      canManageReviewPolicy,
      canManagePlugins: false
    },
    auth: { emailEnabled: false, emailRegistrationEnabled: false, casEnabled: false, demoEnabled: true }
  };
}

export async function demoLogin(userId: string): Promise<SessionResponse> {
  if (!(userId in demoUsers)) {
    throw new ApiError("未找到演示账号。", 404);
  }
  window.localStorage.setItem(sessionKey, userId);
  return getDemoSession();
}

export async function listDemoTags() {
  return { items: tags };
}

export async function listDemoProblems(query: ProblemListQuery): Promise<ProblemListResponse> {
  let items = loadProblems().map(decorate).filter((problem) => problem.capabilities.canView);
  if (query.owner === "me") {
    items = items.filter((problem) => problem.owner.id === currentUserId());
  }
  if (query.search) {
    const needle = query.search.toLocaleLowerCase();
    items = items.filter((problem) => problem.title.toLocaleLowerCase().includes(needle));
  }
  if (query.status) {
    items = items.filter((problem) => problem.status === query.status);
  }
  if (query.type) {
    items = items.filter((problem) => problem.type === query.type);
  }
  items.sort((left, right) => {
    if (query.sort === "difficulty_asc") {
      return (left.codeforcesDifficulty ?? Infinity) - (right.codeforcesDifficulty ?? Infinity);
    }
    if (query.sort === "difficulty_desc") {
      return (right.codeforcesDifficulty ?? -Infinity) - (left.codeforcesDifficulty ?? -Infinity);
    }
    return query.sort === "updated_asc"
      ? left.updatedAt.localeCompare(right.updatedAt)
      : right.updatedAt.localeCompare(left.updatedAt);
  });
  const start = (query.page - 1) * query.pageSize;
  return {
    items: items.slice(start, start + query.pageSize),
    total: items.length,
    page: query.page,
    pageSize: query.pageSize
  };
}

export async function getDemoProblem(id: string): Promise<Problem> {
  const { problem } = findProblem(id);
  const decorated = decorate(problem);
  if (!decorated.capabilities.canView) {
    throw new ApiError("题目不存在或你没有查看权限。", 404);
  }
  return decorated;
}

export async function createDemoProblem(input: CreateProblemInput): Promise<Problem> {
  const user = demoUsers[currentUserId()];
  if (user.id === "denied" || user.accountType === "robot") {
    throw new ApiError("当前账号没有新建题目的权限。", 403);
  }
  const created: Problem = {
    id: `p-demo-${Date.now()}`,
    title: input.title,
    type: input.type ?? "traditional",
    status: "draft",
    tagIds: input.tagIds ?? [],
    codeforcesDifficulty: input.codeforcesDifficulty ?? null,
    thinkingLevel: input.thinkingLevel ?? null,
    codingLevel: input.codingLevel ?? null,
    content: contentWithDefaults(input.content),
    samples: input.samples ?? [],
    judgeConfig: input.judgeConfig ?? null,
    owner: { id: user.id, nickname: user.nickname, accountType: user.accountType },
    revision: 1,
    reviewRound: 0,
    createdAt: now(),
    updatedAt: now(),
    capabilities: emptyCapabilities()
  };
  saveProblems([created, ...loadProblems()]);
  return decorate(created);
}

export async function updateDemoProblem(id: string, input: UpdateProblemInput): Promise<Problem> {
  const { problem, index, all } = findProblem(id);
  requireEdit(problem);
  requireRevision(problem, input.expectedRevision);
  const frozen = problem.status === "pending_review" || problem.status === "approved";
  if (
    frozen &&
    ((input.title !== undefined && input.title !== problem.title) ||
      (input.content?.basicStatement !== undefined &&
        input.content.basicStatement !== problem.content.basicStatement) ||
      (input.content?.basicSolution !== undefined &&
        input.content.basicSolution !== problem.content.basicSolution))
  ) {
    throw new ApiError("待审核或审核通过后，名称、基础题面和基础题解不能修改。", 409);
  }
  const next: Problem = {
    ...problem,
    ...(input.title !== undefined ? { title: input.title } : {}),
    ...(input.type !== undefined ? { type: input.type } : {}),
    ...(input.tagIds !== undefined ? { tagIds: input.tagIds } : {}),
    ...(input.codeforcesDifficulty !== undefined
      ? { codeforcesDifficulty: input.codeforcesDifficulty }
      : {}),
    ...(input.thinkingLevel !== undefined ? { thinkingLevel: input.thinkingLevel } : {}),
    ...(input.codingLevel !== undefined ? { codingLevel: input.codingLevel } : {}),
    content: { ...problem.content, ...(input.content ?? {}) },
    samples: input.samples ?? problem.samples,
    revision: problem.revision + 1,
    updatedAt: now(),
    capabilities: emptyCapabilities()
  };
  all[index] = next;
  saveProblems(all);
  return decorate(next);
}

export async function submitDemoProblem(id: string, expectedRevision: number): Promise<Problem> {
  const { problem, index, all } = findProblem(id);
  const capabilities = decorate(problem).capabilities;
  if (!capabilities.canSubmit) {
    throw new ApiError("当前状态下不能提交这道题。", 409);
  }
  requireRevision(problem, expectedRevision);
  if (!problem.title || !problem.tagIds.length || !problem.content.basicStatement || !problem.content.basicSolution) {
    throw new ApiError("请补齐题目名称、知识点、基础题面和基础题解后再提交。", 400);
  }
  const next = {
    ...problem,
    status: "pending_review" as ProblemStatus,
    reviewRound: problem.reviewRound + 1,
    revision: problem.revision + 1,
    updatedAt: now()
  };
  all[index] = next;
  saveProblems(all);
  return decorate(next);
}

export async function withdrawDemoProblem(id: string, expectedRevision: number): Promise<Problem> {
  const { problem, index, all } = findProblem(id);
  if (!decorate(problem).capabilities.canWithdraw) {
    throw new ApiError("当前账号不能撤回这道题。", 403);
  }
  requireRevision(problem, expectedRevision);
  const next = {
    ...problem,
    status: "draft" as ProblemStatus,
    revision: problem.revision + 1,
    updatedAt: now()
  };
  all[index] = next;
  saveProblems(all);
  return decorate(next);
}

const reviewsByProblem: Record<string, ReviewRoundSummary> = {
  "p-2026-003": {
    round: 1,
    reviews: [],
    approvals: 0,
    blockingReviews: 0,
    requiredApprovals: 2,
    status: "waiting",
    ruleId: "org.ustc.urmotiv.review-default.count",
    decisionAvailable: true,
    decisionReason: "目前还没有有效的通过意见。",
    decisionSource: "rule"
  }
};

export async function listDemoReviews(id: string): Promise<ReviewRoundSummary> {
  const { problem } = findProblem(id);
  if (!decorate(problem).capabilities.canView) {
    throw new ApiError("题目不存在或你没有查看权限。", 404);
  }
  return (
    reviewsByProblem[id] ?? {
      round: Math.max(1, problem.reviewRound),
      reviews: [],
      approvals: 0,
      blockingReviews: 0,
      requiredApprovals: 2,
      status: "waiting",
      ruleId: "org.ustc.urmotiv.review-default.count",
      decisionAvailable: true,
      decisionReason: "目前还没有有效的通过意见。",
      decisionSource: "rule"
    }
  );
}

export async function createDemoReview(id: string, input: ReviewInput): Promise<ReviewRoundSummary> {
  const { problem, index, all } = findProblem(id);
  if (!decorate(problem).capabilities.canReview) {
    throw new ApiError("你不能提交这道题的审核意见。", 403);
  }
  if (input.expectedRound !== problem.reviewRound) {
    throw new ApiError("审核轮次已经变化，请刷新后再提交。", 409);
  }
  const user = demoUsers[currentUserId()];
  const current = await listDemoReviews(id);
  const item = {
    ...input,
    id: `review-${Date.now()}`,
    problemId: id,
    reviewer: { id: user.id, nickname: user.nickname, accountType: user.accountType },
    source: user.accountType === "robot" ? ("fermata" as const) : ("human" as const),
    createdAt: now(),
    updatedAt: now()
  };
  const withoutMine = current.reviews.filter((review) => review.reviewer.id !== user.id);
  const reviews = [...withoutMine, item];
  const approvals = reviews.filter((review) => review.verdict === "approve").length;
  const blockingReviews = reviews.filter((review) => review.verdict === "reject").length;
  const summary: ReviewRoundSummary = {
    ...current,
    reviews,
    approvals,
    blockingReviews,
    status: blockingReviews > 0
      ? "rejected"
      : approvals >= (current.requiredApprovals ?? Number.POSITIVE_INFINITY)
        ? "approved"
        : "waiting",
    decisionAvailable: true,
    decisionReason: blockingReviews > 0
      ? "存在有效的不通过意见。"
      : `目前有 ${approvals} 份有效的通过意见。`,
    decisionSource: "rule"
  };
  reviewsByProblem[id] = summary;
  if (summary.status === "approved" || summary.status === "rejected") {
    all[index] = {
      ...problem,
      status: summary.status === "approved" ? "approved" : "rejected",
      revision: problem.revision + 1,
      updatedAt: now()
    };
    saveProblems(all);
  }
  return summary;
}
