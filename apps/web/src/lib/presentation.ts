import type { ProblemStatus, ProblemType } from "@urmotiv/contracts";

export const statusText: Record<ProblemStatus, string> = {
  draft: "草稿",
  pending_review: "待审核",
  approved: "审核通过",
  rejected: "审核不通过"
};

export const typeText: Record<ProblemType, string> = {
  traditional: "传统题",
  interactive: "交互题",
  submit_answer: "提交答案题"
};

export const statusTone: Record<ProblemStatus, "neutral" | "warning" | "success" | "danger"> = {
  draft: "neutral",
  pending_review: "warning",
  approved: "success",
  rejected: "danger"
};

export const frozenFields = new Set(["title", "content.basicStatement", "content.basicSolution"]);

export function isFrozen(status: ProblemStatus, field: string): boolean {
  return (status === "pending_review" || status === "approved") && frozenFields.has(field);
}

export function dateTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "—";
  }

  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit"
  }).format(date);
}

export function difficultyText(value: number | null): string {
  return value === null ? "未填写" : String(value);
}

export function duration(seconds: number): string {
  if (seconds < 60) {
    return `${seconds} 秒`;
  }
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  return remainder === 0 ? `${minutes} 分钟` : `${minutes} 分 ${remainder} 秒`;
}

export function reviewVerdictText(verdict: "approve" | "request_changes" | "reject"): string {
  if (verdict === "approve") {
    return "通过";
  }
  if (verdict === "reject") {
    return "不通过";
  }
  return "需要修改";
}
