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
import type {
  Problem,
  ProblemJudgeConfig,
  SimilarityCheckResponse,
  UpdateProblemInput
} from "@urmotiv/contracts";
import {
  getProblem,
  recordProblemActivity,
  runSimilarityCheck,
  submitProblem,
  updateProblem,
  withdrawProblem
} from "../lib/api";
import { statusText, statusTone } from "../lib/presentation";
import { isAccessBoundaryError } from "../lib/client-security";
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
  if (!problem.capabilities.canEdit && problem.capabilities.canEditTitle) {
    return { expectedRevision: problem.revision, title: problem.title };
  }
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
  const [accessRevoked, setAccessRevoked] = useState(false);
  const accessRevokedRef = useRef(false);
  const problemQueryKey = ["problem", problemId, currentUserId] as const;
  const problemQuery = useQuery({
    queryKey: problemQueryKey,
    queryFn: () => getProblem(problemId),
    enabled: Boolean(problemId) && !accessRevoked,
    retry: (failureCount, error) => !isAccessBoundaryError(error) && failureCount < 3
  });
  const [working, setWorking] = useState<Problem | null>(null);
  const [dirty, setDirty] = useState(false);
  const [saveState, setSaveState] = useState<SaveState>("saved");
  const [fileUploadsInFlight, setFileUploadsInFlight] = useState(0);
  const fileUploadPending = fileUploadsInFlight > 0;
  const editNumber = useRef(0);
  const clearPrivateProblemState = useCallback((id: string) => {
    const queryKey = ["problem", problemId, currentUserId] as const;
    accessRevokedRef.current = true;
    setAccessRevoked(true);
    setWorking(null);
    setDirty(false);
    setSaveState("saved");
    setFileUploadsInFlight(0);
    window.sessionStorage.removeItem(localDraftKey(currentUserId, id));
    window.sessionStorage.removeItem(legacyLocalDraftKey(id));
    void client.cancelQueries({ queryKey, exact: true }).finally(() => {
      client.removeQueries({ queryKey, exact: true });
    });
  }, [client, currentUserId, problemId]);
  useEffect(() => {
    accessRevokedRef.current = false;
    setAccessRevoked(false);
    setWorking(null);
    setDirty(false);
  }, [currentUserId, problemId]);
  useEffect(() => {
    if (problemQuery.isError && isAccessBoundaryError(problemQuery.error)) {
      clearPrivateProblemState(problemId);
    }
  }, [clearPrivateProblemState, problemId, problemQuery.error, problemQuery.isError]);

  useEffect(() => {
    if (accessRevoked || problemQuery.isError || !problemQuery.data?.id) {
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
  }, [accessRevoked, problemQuery.data?.id, problemQuery.isError]);

  useEffect(() => {
    if (problemQuery.data && !problemQuery.isError && !dirty) {
      setAccessRevoked(false);
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
  }, [currentUserId, problemQuery.data, problemQuery.isError, dirty]);

  const save = useMutation({
    mutationFn: ({ problem }: { problem: Problem; edit: number }) =>
      updateProblem(problem.id, updateInput(problem)),
    onMutate: () => setSaveState("saving"),
    onSuccess: (saved, variables) => {
      if (accessRevokedRef.current) {
        return;
      }
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
    onError: (error, variables) => {
      if (isAccessBoundaryError(error)) {
        clearPrivateProblemState(variables.problem.id);
        return;
      }
      window.sessionStorage.setItem(
        localDraftKey(currentUserId, variables.problem.id),
        JSON.stringify(variables.problem)
      );
      setSaveState("failed");
    }
  });

  const saveNow = useCallback(() => {
    if (!working || !dirty || save.isPending || fileUploadPending) {
      return;
    }
    if (!working.capabilities.canEdit && !working.capabilities.canEditTitle) {
      return;
    }
    save.mutate({ problem: working, edit: editNumber.current });
  }, [working, dirty, save, fileUploadPending]);

  useEffect(() => {
    if (
      !dirty ||
      save.isPending ||
      fileUploadPending ||
      saveState === "failed" ||
      (!working?.capabilities.canEdit && !working?.capabilities.canEditTitle)
    ) {
      return;
    }
    const timer = window.setTimeout(saveNow, 1200);
    return () => window.clearTimeout(timer);
  }, [dirty, fileUploadPending, save.isPending, saveNow, saveState, working?.capabilities.canEdit, working?.capabilities.canEditTitle]);

  const update: ProblemUpdater = (updater) => {
    setWorking((current) => (current ? updater(current) : current));
    editNumber.current += 1;
    setDirty(true);
    setSaveState("dirty");
  };

  const synchronizeFileRevision = useCallback((revision: number) => {
    if (accessRevokedRef.current) {
      return;
    }
    setWorking((current) => current === null ? current : { ...current, revision });
    client.setQueryData<Problem>(
      ["problem", problemId, currentUserId],
      (current) => current === undefined ? current : { ...current, revision }
    );
    void client.invalidateQueries({ queryKey: ["problem", problemId, currentUserId] });
  }, [client, currentUserId, problemId]);

  const updateFileUploadPending = useCallback((pending: boolean) => {
    setFileUploadsInFlight((current) => pending ? current + 1 : Math.max(0, current - 1));
  }, []);

  const synchronizeJudgeProgramBinding = useCallback((
    revision: number,
    judgeConfig: ProblemJudgeConfig
  ) => {
    if (accessRevokedRef.current) {
      return;
    }
    setWorking((current) => current === null
      ? current
      : { ...current, revision, judgeConfig });
    client.setQueryData<Problem>(
      ["problem", problemId, currentUserId],
      (current) => current === undefined
        ? current
        : { ...current, revision, judgeConfig }
    );
    void client.invalidateQueries({ queryKey: ["problem", problemId, currentUserId] });
  }, [client, currentUserId, problemId]);

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
      if (accessRevokedRef.current) {
        return;
      }
      client.setQueryData(["problem", saved.id, currentUserId], saved);
      window.sessionStorage.removeItem(localDraftKey(currentUserId, saved.id));
      client.invalidateQueries({ queryKey: ["problems"] });
      client.invalidateQueries({ queryKey: ["reviews", saved.id] });
      setWorking(saved);
      setDirty(false);
      setSaveState("saved");
    },
    onError: (error) => {
      if (isAccessBoundaryError(error)) {
        clearPrivateProblemState(problemId);
      }
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
    },
    onError: (error) => {
      if (isAccessBoundaryError(error)) {
        clearPrivateProblemState(problemId);
      }
    }
  });

  if (accessRevoked || (problemQuery.isError && isAccessBoundaryError(problemQuery.error))) {
    return (
      <div className="centered-message error-message" role="alert">
        <TriangleAlert size={28} aria-hidden="true" />
        <h1>题目不存在</h1>
        <p>题目不存在或当前账号不能访问。</p>
        <Link to="/problems">返回题目列表</Link>
      </div>
    );
  }

  if (problemQuery.isLoading || !working) {
    if (problemQuery.isError) {
      return (
        <div className="centered-message error-message" role="alert">
          <TriangleAlert size={28} aria-hidden="true" />
          <h1>暂时无法打开题目</h1>
          <p>请稍后重试。</p>
          <div className="inline-actions">
            <button
              className="secondary-button"
              type="button"
              disabled={problemQuery.isFetching}
              onClick={() => void problemQuery.refetch()}
            >
              <RefreshCw size={15} aria-hidden="true" />
              重试
            </button>
            <Link to="/problems">返回题目列表</Link>
          </div>
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
              disabled={dirty || save.isPending || fileUploadPending || statusAction.isPending}
              title={dirty || fileUploadPending ? "请等待当前修改和文件上传完成" : undefined}
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
              disabled={dirty || fileUploadPending || statusAction.isPending}
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

      <nav
        className="workspace-tabs"
        aria-label="题目工作区"
        role="tablist"
        onKeyDown={(event) => {
          const currentIndex = tabs.findIndex((tab) => tab.id === activeTab);
          let nextIndex: number | null = null;
          if (event.key === "ArrowRight") {
            nextIndex = (currentIndex + 1) % tabs.length;
          } else if (event.key === "ArrowLeft") {
            nextIndex = (currentIndex - 1 + tabs.length) % tabs.length;
          } else if (event.key === "Home") {
            nextIndex = 0;
          } else if (event.key === "End") {
            nextIndex = tabs.length - 1;
          }
          if (nextIndex === null) {
            return;
          }
          event.preventDefault();
          const next = tabs[nextIndex];
          if (next === undefined) {
            return;
          }
          setSearchParams(next.id === "overview" ? {} : { tab: next.id }, { replace: true });
          const nextElement = document.getElementById(`workspace-tab-${next.id}`);
          if (nextElement instanceof HTMLButtonElement) {
            nextElement.focus();
          }
        }}
      >
        {tabs.map(({ id, label, icon: Icon }) => (
          <button
            key={id}
            id={`workspace-tab-${id}`}
            type="button"
            role="tab"
            aria-selected={activeTab === id}
            aria-controls="workspace-tabpanel"
            tabIndex={activeTab === id ? 0 : -1}
            className={activeTab === id ? "active" : ""}
            onClick={() => setSearchParams(id === "overview" ? {} : { tab: id }, { replace: true })}
          >
            <Icon size={16} aria-hidden="true" />
            {label}
          </button>
        ))}
      </nav>

      <div
        className="workspace-body"
        id="workspace-tabpanel"
        role="tabpanel"
        aria-labelledby={`workspace-tab-${activeTab}`}
      >
        {activeTab === "overview" ? <OverviewTab problem={working} update={update} /> : null}
        {activeTab === "statement" ? (
          <StatementTab
            problem={working}
            update={update}
            fileUploadsDisabled={dirty || save.isPending || fileUploadPending}
            onFileRevisionChange={synchronizeFileRevision}
            onFileUploadPendingChange={updateFileUploadPending}
          />
        ) : null}
        {activeTab === "samples" ? <SamplesTab problem={working} update={update} /> : null}
        {activeTab === "judge" ? (
          <DataAndJudgeTab
            problem={working}
            update={update}
            fileUploadsDisabled={dirty || save.isPending || fileUploadPending}
            onFileUploadPendingChange={updateFileUploadPending}
            onJudgeProgramBound={synchronizeJudgeProgramBinding}
          />
        ) : null}
        {activeTab === "solution" ? (
          <SolutionTab
            problem={working}
            update={update}
            fileUploadsDisabled={dirty || save.isPending || fileUploadPending}
            onFileRevisionChange={synchronizeFileRevision}
            onFileUploadPendingChange={updateFileUploadPending}
          />
        ) : null}
        {activeTab === "reviews" ? (
          <ReviewTab
            problem={working}
            currentUserId={currentUserId}
            submissionBlocked={dirty || save.isPending || saveState === "failed"}
            onStatusChange={(status) => {
              setWorking((current) => current === null ? current : { ...current, status });
            }}
            onProblemChange={(updated) => {
              setWorking(updated);
              setDirty(false);
              setSaveState("saved");
            }}
          />
        ) : null}
      </div>
    </section>
  );
}

/** 手动"原题检索"的结果；不属于任何标签页，切换标签页时保持可见。 */
export function SimilarityCheckPanel({
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
      {result.status === "partial" ? (
        <p className="warning-note">
          <TriangleAlert size={16} aria-hidden="true" />
          本次检索只完成了一部分，候选仅供人工核对，不能视为完整查重。
        </p>
      ) : null}
      {result.status === "unavailable" ? (
        <p className="warning-note">
          <TriangleAlert size={16} aria-hidden="true" />
          原题检索未能形成可信结果，请稍后重试或联系管理员。
        </p>
      ) : null}
      {result.blockedAdvice ? (
        <p className="warning-note">
          <TriangleAlert size={16} aria-hidden="true" />
          建议不要提交：{result.blockedAdvice.message}
        </p>
      ) : null}
      {result.items.length === 0 ? (
        result.status === "completed" && result.blockedAdvice === null ? (
          <p className="empty-state">完整检索未发现需要关注的相似题目。</p>
        ) : null
      ) : (
        <div className="analysis-item-list">
          {result.items.map((item) => (
            <ReviewItemCard key={item.id} item={item} defaultExpanded />
          ))}
        </div>
      )}
    </div>
  );
}
