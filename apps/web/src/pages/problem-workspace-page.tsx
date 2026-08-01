import {
  BookOpenText,
  Check,
  ClipboardList,
  Database,
  FileText,
  Info,
  Lightbulb,
  ListChecks,
  RefreshCw,
  RotateCcw,
  Search,
  Send,
  TriangleAlert,
  X
} from "lucide-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";
import type { Problem, SimilarityCheckResponse, UpdateProblemInput } from "@urmotiv/contracts";
import {
  getProblem,
  recordProblemActivity,
  runSimilarityCheck,
  submitProblem,
  updateProblem,
  withdrawProblem
} from "../lib/api";
import { statusText, statusTone } from "../lib/presentation";
import {
  DataAndJudgeTab,
  OverviewTab,
  ReviewItemCard,
  ReviewTab,
  SamplesTab,
  SolutionTab,
  StatementTab,
  type ProblemUpdater
} from "../components/problem-tabs";

const tabs = [
  { id: "overview", label: "概要", icon: Info },
  { id: "statement", label: "题面", icon: FileText },
  { id: "samples", label: "样例与约束", icon: ListChecks },
  { id: "judge", label: "数据与评测", icon: Database },
  { id: "solution", label: "题解与资料", icon: Lightbulb },
  { id: "reviews", label: "审核记录", icon: ClipboardList }
] as const;

type TabId = (typeof tabs)[number]["id"];
type SaveState = "saved" | "dirty" | "saving" | "failed";

export function localDraftKey(currentUserId: string, problemId: string): string {
  return `urmotiv.web.unsaved.${encodeURIComponent(currentUserId)}.${encodeURIComponent(problemId)}`;
}

function legacyLocalDraftKey(problemId: string): string {
  return `urmotiv.web.unsaved.${problemId}`;
}

function updateInput(problem: Problem): UpdateProblemInput {
  return {
    expectedRevision: problem.revision,
    title: problem.title,
    type: problem.type,
    tagIds: problem.tagIds,
    codeforcesDifficulty: problem.codeforcesDifficulty,
    thinkingLevel: problem.thinkingLevel,
    codingLevel: problem.codingLevel,
    content: problem.content,
    samples: problem.samples,
    judgeConfig: problem.judgeConfig
  };
}

export function ProblemWorkspacePage({ currentUserId }: { currentUserId: string }) {
  const { problemId = "" } = useParams();
  const [searchParams, setSearchParams] = useSearchParams();
  const requestedTab = searchParams.get("tab");
  const activeTab = tabs.some((tab) => tab.id === requestedTab) ? (requestedTab as TabId) : "overview";
  const client = useQueryClient();
  const problemQuery = useQuery({
    queryKey: ["problem", problemId, currentUserId],
    queryFn: () => getProblem(problemId),
    enabled: Boolean(problemId)
  });
  const [working, setWorking] = useState<Problem | null>(null);
  const [dirty, setDirty] = useState(false);
  const [saveState, setSaveState] = useState<SaveState>("saved");
  const editNumber = useRef(0);

  useEffect(() => {
    if (!problemQuery.data?.id) {
      return;
    }
    const id = problemQuery.data.id;
    let visibleSince = document.visibilityState === "visible" ? Date.now() : null;
    const flush = () => {
      if (visibleSince === null) {
        return;
      }
      const seconds = Math.min(60, Math.floor((Date.now() - visibleSince) / 1_000));
      visibleSince = document.visibilityState === "visible" ? Date.now() : null;
      if (seconds > 0) {
        void recordProblemActivity(id, seconds).catch(() => undefined);
      }
    };
    const onVisibilityChange = () => {
      if (document.visibilityState === "hidden") {
        flush();
        visibleSince = null;
      } else {
        visibleSince = Date.now();
      }
    };
    const timer = window.setInterval(flush, 15_000);
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      flush();
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [problemQuery.data?.id]);

  useEffect(() => {
    if (problemQuery.data && !dirty) {
      window.sessionStorage.removeItem(legacyLocalDraftKey(problemQuery.data.id));
      const rawDraft = window.sessionStorage.getItem(
        localDraftKey(currentUserId, problemQuery.data.id)
      );
      if (rawDraft) {
        try {
          const localDraft = JSON.parse(rawDraft) as Problem;
          if (localDraft.id === problemQuery.data.id && localDraft.revision === problemQuery.data.revision) {
            setWorking(localDraft);
            setDirty(true);
            setSaveState("failed");
            return;
          }
        } catch {
          window.sessionStorage.removeItem(localDraftKey(currentUserId, problemQuery.data.id));
        }
      }
      setWorking(problemQuery.data);
      setSaveState("saved");
    }
  }, [currentUserId, problemQuery.data, dirty]);

  const save = useMutation({
    mutationFn: ({ problem }: { problem: Problem; edit: number }) =>
      updateProblem(problem.id, updateInput(problem)),
    onMutate: () => setSaveState("saving"),
    onSuccess: (saved, variables) => {
      client.setQueryData(["problem", saved.id, currentUserId], saved);
      window.sessionStorage.removeItem(localDraftKey(currentUserId, saved.id));
      if (variables.edit === editNumber.current) {
        setWorking(saved);
        setDirty(false);
        setSaveState("saved");
      } else {
        setWorking((current) => (current ? { ...current, revision: saved.revision } : saved));
        setSaveState("dirty");
      }
    },
    onError: (_error, variables) => {
      window.sessionStorage.setItem(
        localDraftKey(currentUserId, variables.problem.id),
        JSON.stringify(variables.problem)
      );
      setSaveState("failed");
    }
  });

  const saveNow = useCallback(() => {
    if (!working || !dirty || save.isPending || !working.capabilities.canEdit) {
      return;
    }
    save.mutate({ problem: working, edit: editNumber.current });
  }, [working, dirty, save]);

  useEffect(() => {
    if (!dirty || save.isPending || saveState === "failed" || !working?.capabilities.canEdit) {
      return;
    }
    const timer = window.setTimeout(saveNow, 1200);
    return () => window.clearTimeout(timer);
  }, [dirty, save.isPending, saveNow, saveState, working?.capabilities.canEdit]);

  const update: ProblemUpdater = (updater) => {
    setWorking((current) => (current ? updater(current) : current));
    editNumber.current += 1;
    setDirty(true);
    setSaveState("dirty");
  };

  const statusAction = useMutation({
    mutationFn: async (action: "submit" | "withdraw") => {
      if (!working) {
        throw new Error("题目尚未加载完成。");
      }
      return action === "submit"
        ? submitProblem(working.id, working.revision)
        : withdrawProblem(working.id, working.revision);
    },
    onSuccess: (saved) => {
      client.setQueryData(["problem", saved.id, currentUserId], saved);
      window.sessionStorage.removeItem(localDraftKey(currentUserId, saved.id));
      client.invalidateQueries({ queryKey: ["problems"] });
      client.invalidateQueries({ queryKey: ["reviews", saved.id] });
      setWorking(saved);
      setDirty(false);
      setSaveState("saved");
    }
  });

  const similarityCheck = useMutation({
    mutationFn: () => {
      if (!working) {
        throw new Error("题目尚未加载完成。");
      }
      return runSimilarityCheck(working.id);
    },
    onSuccess: () => {
      if (working) {
        client.invalidateQueries({ queryKey: ["review-items", working.id] });
      }
    }
  });

  if (problemQuery.isLoading || !working) {
    if (problemQuery.isError) {
      return (
        <div className="centered-message error-message">
          <TriangleAlert size={28} aria-hidden="true" />
          <h1>无法打开题目</h1>
          <p>{problemQuery.error.message}</p>
          <Link to="/problems">返回题目列表</Link>
        </div>
      );
    }
    return <div className="centered-message">正在打开题目…</div>;
  }

  const canSubmit = working.capabilities.canSubmit && (working.status === "draft" || working.status === "rejected");
  const canWithdraw =
    working.capabilities.canWithdraw && (working.status === "pending_review" || working.status === "approved");
  const saveText = {
    saved: "已保存",
    dirty: "有未保存修改",
    saving: "正在保存",
    failed: "保存失败"
  }[saveState];

  return (
    <section className="problem-workspace">
      <header className="workspace-header">
        <div className="workspace-title">
          <BookOpenText size={22} aria-hidden="true" />
          <div>
            <span>{working.id}</span>
            <h1>{working.title}</h1>
          </div>
        </div>
        <div className="workspace-state">
          <span className={`status-badge ${statusTone[working.status]}`}>{statusText[working.status]}</span>
          <span className={`save-status ${saveState}`}>
            {saveState === "saved" ? <Check size={14} aria-hidden="true" /> : null}
            {saveState === "saving" ? <RefreshCw className="spin" size={14} aria-hidden="true" /> : null}
            {saveText}
          </span>
          {saveState === "failed" ? (
            <button className="secondary-button compact-button" type="button" onClick={saveNow}>
              <RefreshCw size={15} aria-hidden="true" />
              重试保存
            </button>
          ) : null}
          {working.capabilities.canEdit || working.capabilities.canReview ? (
            <button
              className="secondary-button"
              type="button"
              disabled={similarityCheck.isPending}
              onClick={() => similarityCheck.mutate()}
            >
              {similarityCheck.isPending ? (
                <RefreshCw className="spin" size={16} aria-hidden="true" />
              ) : (
                <Search size={16} aria-hidden="true" />
              )}
              原题检索
            </button>
          ) : null}
          {canSubmit ? (
            <button
              className="primary-button"
              type="button"
              disabled={dirty || save.isPending || statusAction.isPending}
              title={dirty ? "请等待当前修改保存完成" : undefined}
              onClick={() => statusAction.mutate("submit")}
            >
              <Send size={16} aria-hidden="true" />
              {working.status === "rejected" ? "重新提交" : "提交审核"}
            </button>
          ) : null}
          {canWithdraw ? (
            <button
              className="secondary-button"
              type="button"
              disabled={dirty || statusAction.isPending}
              onClick={() => statusAction.mutate("withdraw")}
            >
              <RotateCcw size={16} aria-hidden="true" />
              {working.status === "approved" ? "撤回修改" : "撤回投稿"}
            </button>
          ) : null}
        </div>
      </header>

      {(save.error || statusAction.error) ? (
        <div className="inline-error workspace-error" role="alert">
          {(save.error ?? statusAction.error)?.message}
        </div>
      ) : null}
      {similarityCheck.error ? (
        <div className="inline-error workspace-error" role="alert">
          {similarityCheck.error.message}
        </div>
      ) : null}
      {similarityCheck.data ? (
        <SimilarityCheckPanel result={similarityCheck.data} onDismiss={() => similarityCheck.reset()} />
      ) : null}

      <nav className="workspace-tabs" aria-label="题目工作区">
        {tabs.map(({ id, label, icon: Icon }) => (
          <button
            key={id}
            type="button"
            className={activeTab === id ? "active" : ""}
            onClick={() => setSearchParams(id === "overview" ? {} : { tab: id }, { replace: true })}
          >
            <Icon size={16} aria-hidden="true" />
            {label}
          </button>
        ))}
      </nav>

      <div className="workspace-body">
        {activeTab === "overview" ? <OverviewTab problem={working} update={update} /> : null}
        {activeTab === "statement" ? <StatementTab problem={working} update={update} /> : null}
        {activeTab === "samples" ? <SamplesTab problem={working} update={update} /> : null}
        {activeTab === "judge" ? <DataAndJudgeTab problem={working} update={update} /> : null}
        {activeTab === "solution" ? <SolutionTab problem={working} update={update} /> : null}
        {activeTab === "reviews" ? (
          <ReviewTab
            problem={working}
            currentUserId={currentUserId}
            submissionBlocked={dirty || save.isPending || saveState === "failed"}
            onStatusChange={(status) => {
              setWorking((current) => current === null ? current : { ...current, status });
            }}
          />
        ) : null}
      </div>
    </section>
  );
}

/** 手动"原题检索"的结果；不属于任何标签页，切换标签页时保持可见。 */
function SimilarityCheckPanel({
  result,
  onDismiss
}: {
  result: SimilarityCheckResponse;
  onDismiss: () => void;
}) {
  return (
    <div className="plain-panel similarity-check-panel">
      <div className="similarity-check-heading">
        <span>
          <Search size={16} aria-hidden="true" />
          原题检索结果
        </span>
        <button className="icon-button" type="button" aria-label="关闭原题检索结果" onClick={onDismiss}>
          <X size={15} aria-hidden="true" />
        </button>
      </div>
      {result.status === "unavailable" ? (
        <p className="empty-state">原题检索插件未启用。</p>
      ) : (
        <>
          {result.blockedAdvice ? (
            <p className="warning-note">
              <TriangleAlert size={16} aria-hidden="true" />
              建议不要提交：{result.blockedAdvice.message}
            </p>
          ) : null}
          {result.items.length === 0 ? (
            <p className="empty-state">未发现需要关注的相似题目。</p>
          ) : (
            <div className="analysis-item-list">
              {result.items.map((item) => (
                <ReviewItemCard key={item.id} item={item} defaultExpanded />
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}
