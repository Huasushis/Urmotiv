import { AlertTriangle, Archive, ArrowDownToLine, ArrowUpFromLine, Download, FileArchive, Loader2 } from "lucide-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import type { ExportPreviewResponse, ImportJobView, PackageFileCategory } from "@urmotiv/contracts";
import {
  createExportJob,
  createImportJob,
  exportDownloadUrl,
  getExportJob,
  getImportJob,
  getSession,
  listImportHistory,
  previewExport,
  previewImport,
  uploadProblemPackage
} from "../lib/api";
import { dateTime } from "../lib/presentation";
import { isAccessBoundaryError } from "../lib/client-security";

type TransferMode = "import" | "export";
type SourceFormat = "urmotiv" | "hydro";

type ImportJobItem = ImportJobView["items"][number];
type TransferJobPhase = ImportJobView["phase"];
type TransferJobState = ImportJobView["state"];
type ExportPreviewProblem = ExportPreviewResponse["problems"][number];
type LossSeverity = ExportPreviewProblem["items"][number]["severity"];

const sourceFormatText: Record<SourceFormat, string> = {
  urmotiv: "Urmotiv 完整包",
  hydro: "Hydro 题目包"
};

const phaseText: Record<TransferJobPhase, string> = {
  queued: "排队中",
  reading: "读取包",
  converting: "整理内容",
  writing: "写入题库",
  completed: "完成",
  failed: "失败",
  blocked: "需要处理"
};

const severityLabel: Record<LossSeverity, string> = {
  error: "错误",
  choice: "需要选择",
  warning: "警告",
  info: "提示"
};

const severityClass: Record<LossSeverity, string> = {
  error: "issue-error",
  choice: "issue-choice",
  warning: "issue-warning",
  info: "issue-info"
};

const exportStatusText: Record<ExportPreviewProblem["status"], string> = {
  ready: "可导出",
  blocked: "需要处理",
  not_found: "题目不存在或无权访问"
};

const exportStatusTone: Record<ExportPreviewProblem["status"], "success" | "warning" | "danger"> = {
  ready: "success",
  blocked: "warning",
  not_found: "danger"
};

type CategoryGroupKey =
  | "asset"
  | "public_attachment"
  | "testdata"
  | "judge_programs"
  | "standard_solution"
  | "internal_attachment";

const categoryGroups: {
  key: CategoryGroupKey;
  label: string;
  categories: PackageFileCategory[];
  defaultChecked: boolean;
}[] = [
  { key: "asset", label: "题面资源", categories: ["asset"], defaultChecked: true },
  { key: "public_attachment", label: "公开附件", categories: ["public_attachment"], defaultChecked: true },
  { key: "testdata", label: "测试数据", categories: ["testdata"], defaultChecked: true },
  {
    key: "judge_programs",
    label: "评测程序",
    categories: ["checker", "interactor", "answer_checker"],
    defaultChecked: true
  },
  { key: "standard_solution", label: "标准程序", categories: ["standard_solution"], defaultChecked: true },
  { key: "internal_attachment", label: "内部附件", categories: ["internal_attachment"], defaultChecked: false }
];

function defaultCategoryChecks(): Record<CategoryGroupKey, boolean> {
  const entries = categoryGroups.map((group) => [group.key, group.defaultChecked] as const);
  return Object.fromEntries(entries) as Record<CategoryGroupKey, boolean>;
}

function formatBytes(byteSize: number): string {
  if (byteSize < 1024) {
    return `${byteSize} B`;
  }
  const units = ["KB", "MB", "GB", "TB"];
  let value = byteSize / 1024;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  return `${value.toFixed(value >= 10 ? 0 : 1)} ${units[unitIndex]}`;
}

function parseIdList(text: string): string[] {
  const parts = text
    .split(/[\s,，]+/)
    .map((part) => part.trim())
    .filter(Boolean);
  return [...new Set(parts)];
}

function isJobFinished(state: TransferJobState | undefined): boolean {
  return state === "succeeded" || state === "failed" || state === "cancelled";
}

export function TransferPage() {
  const client = useQueryClient();
  const [searchParams, setSearchParams] = useSearchParams();
  const historyTab = searchParams.get("tab") === "history";
  const [mode, setMode] = useState<TransferMode>("import");
  const session = useQuery({ queryKey: ["session"], queryFn: getSession, staleTime: 60_000 });
  const currentUserId = session.data?.user?.id ?? "";
  const permissions = session.data?.user?.permissions ?? [];
  const canImport = permissions.includes("problem.import");
  const canExport = permissions.includes("problem.export.own") ||
    permissions.includes("problem.export.all");
  const canTransfer = canImport || canExport;
  const history = useQuery({
    queryKey: ["import-history", currentUserId],
    queryFn: () => listImportHistory(),
    enabled: historyTab && canImport
  });
  useEffect(() => {
    if (!canImport) {
      client.removeQueries({ queryKey: ["transfer-import-job"] });
      if (canExport) {
        setMode("export");
      }
    }
    if (!canExport) {
      client.removeQueries({ queryKey: ["transfer-export-job"] });
      if (canImport) {
        setMode("import");
      }
    }
  }, [canExport, canImport, client, currentUserId]);
  return (
    <section className="transfer-page">
      <div className="page-heading">
        <div>
          <p className="eyebrow">题目包</p>
          <h1>导入导出</h1>
          <p>完整题目包包含题面、样例、数据、限制、程序和附件，不只是题目列表。</p>
        </div>
        <Archive className="page-heading-icon" size={32} aria-hidden="true" />
      </div>

      {session.status === "pending" ? null : !canTransfer ? (
        <div className="centered-message" role="alert">
          <Archive size={28} aria-hidden="true" />
          <h1>当前账号不能导入或导出</h1>
          <p>你没有题目导入或导出权限，只能管理自己有权限的题目。</p>
          <Link to="/problems">返回题目列表</Link>
        </div>
      ) : (
        <>
          <div className="segmented-control transfer-mode" role="group" aria-label="导入或导出">
            {canImport ? (
              <button
                type="button"
                className={!historyTab && mode === "import" ? "selected" : ""}
                onClick={() => {
                  setMode("import");
                  setSearchParams({}, { replace: true });
                }}
              >
                <ArrowUpFromLine size={16} aria-hidden="true" />
                导入
              </button>
            ) : null}
            {canExport ? (
              <button
                type="button"
                className={!historyTab && mode === "export" ? "selected" : ""}
                onClick={() => {
                  setMode("export");
                  setSearchParams({}, { replace: true });
                }}
              >
                <ArrowDownToLine size={16} aria-hidden="true" />
                导出
              </button>
            ) : null}
            {canImport ? (
              <button
                type="button"
                className={historyTab ? "selected" : ""}
                onClick={() => setSearchParams({ tab: "history" }, { replace: true })}
              >
                导入历史
              </button>
            ) : null}
          </div>
          {historyTab && canImport ? (
            history.isPending ? <div className="plain-panel">正在读取导入历史……</div>
              : history.isError ? <div className="plain-panel" role="alert">{history.error.message}</div>
                : <div className="plain-panel"><h2>导入历史</h2><ul>{history.data.items.map((item) => <li key={item.id}>{item.state}，完成 {item.completedItems} 项，失败 {item.failedItems} 项，导入题目 {item.importedProblemIds.length} 项</li>)}</ul>{history.data.items.length === 0 ? <p>当前账号没有可显示的导入记录。</p> : null}</div>
          ) : mode === "import" && canImport
            ? <ImportSection currentUserId={currentUserId} />
            : mode === "export" && canExport
              ? <ExportSection currentUserId={currentUserId} />
              : null}
          </>
      )}
    </section>
  );
}

function JobProgressView({
  phase,
  progressPercent,
  state
}: {
  phase: TransferJobPhase;
  progressPercent: number;
  state: TransferJobState;
}) {
  return (
    <div className="job-progress">
      <div className="job-progress-heading">
        <span>{phaseText[phase]}</span>
        <span>{progressPercent}%</span>
      </div>
      <div
        className="progress-bar"
        role="progressbar"
        aria-valuenow={progressPercent}
        aria-valuemin={0}
        aria-valuemax={100}
      >
        <div className="progress-bar-fill" style={{ width: `${progressPercent}%` }} />
      </div>
      {state === "cancelled" ? <p className="text-faint">任务已取消。</p> : null}
    </div>
  );
}

function ImportResultList({ items }: { items: ImportJobItem[] }) {
  if (items.length === 0) {
    return null;
  }
  return (
    <ul className="transfer-result-list">
      {items.map((item) => (
        <li key={item.position}>
          <span className="text-faint">第 {item.position + 1} 题</span>{" "}
          {item.importedProblemId ? (
            <Link to={`/problems/${item.importedProblemId}`}>查看题目 {item.importedProblemId}</Link>
          ) : item.failure ? (
            <span className="form-error">{item.failure.message}</span>
          ) : (
            <span className="text-faint">处理中…</span>
          )}
        </li>
      ))}
    </ul>
  );
}

function ImportSection({ currentUserId }: { currentUserId: string }) {
  const client = useQueryClient();
  const [fileName, setFileName] = useState("");
  const [formatId, setFormatId] = useState<SourceFormat>("urmotiv");
  const [importJobId, setImportJobId] = useState<string | null>(null);
  const [accessDenied, setAccessDenied] = useState(false);

  const upload = useMutation({
    mutationFn: uploadProblemPackage,
    onSuccess: (result) => {
      const best = [...result.detected].sort((a, b) => b.confidence - a.confidence)[0];
      setFormatId(best && (best.formatId === "urmotiv" || best.formatId === "hydro") ? best.formatId : "urmotiv");
    }
  });
  const preview = useMutation({ mutationFn: previewImport });
  const createImport = useMutation({
    mutationFn: createImportJob,
    onSuccess: (job) => {
      setImportJobId(job.id);
      void client.invalidateQueries({ queryKey: ["problems"] });
    }
  });
  const importJobQuery = useQuery({
    queryKey: ["transfer-import-job", currentUserId, importJobId],
    queryFn: () => getImportJob(importJobId as string),
    enabled: importJobId !== null,
    retry: false,
    refetchInterval: (query) => (isJobFinished(query.state.data?.state) ? false : 1500)
  });
  useEffect(() => {
    if (importJobQuery.data?.state !== "succeeded") return;
    void client.invalidateQueries({ queryKey: ["problems"] });
    void client.invalidateQueries({ queryKey: ["import-history", currentUserId] });
  }, [client, currentUserId, importJobQuery.data?.state]);
  const denied = [upload.error, preview.error, createImport.error, importJobQuery.error]
    .some(isAccessBoundaryError);
  useEffect(() => {
    if (!denied) {
      return;
    }
    setAccessDenied(true);
    setFileName("");
    setImportJobId(null);
    upload.reset();
    preview.reset();
    createImport.reset();
    client.removeQueries({ queryKey: ["transfer-import-job", currentUserId] });
  }, [client, currentUserId, denied]);
  useEffect(() => {
    setAccessDenied(false);
    setFileName("");
    setFormatId("urmotiv");
    setImportJobId(null);
    upload.reset();
    preview.reset();
    createImport.reset();
  }, [currentUserId]);

  const resetProgress = () => {
    preview.reset();
    createImport.reset();
    setImportJobId(null);
  };

  const detected = [...(upload.data?.detected ?? [])].sort((a, b) => b.confidence - a.confidence);
  const hasBlockingIssue = preview.data?.issues.some((issue) => issue.severity === "error") ?? false;
  const job = importJobQuery.data;
  if (accessDenied || denied) {
    return (
      <div className="centered-message" role="alert">
        <Archive size={28} aria-hidden="true" />
        <h2>导入任务不存在</h2>
        <p>任务不存在或当前账号不能访问。</p>
      </div>
    );
  }

  return (
    <div className="transfer-layout">
      <div className="transfer-main">
        <section className="plain-panel">
          <div className="section-title">
            <div>
              <p className="eyebrow">第 1 步</p>
              <h2>选择题目包</h2>
            </div>
            <FileArchive size={22} aria-hidden="true" />
          </div>
          <label className="drop-field">
            <input
              type="file"
              accept=".zip,application/zip,application/vnd.urmotiv.problem+zip"
              disabled={upload.isPending}
              onChange={(event) => {
                const file = event.target.files?.[0];
                resetProgress();
                upload.reset();
                if (!file) {
                  setFileName("");
                  return;
                }
                setFileName(file.name);
                upload.mutate(file);
              }}
            />
            <ArrowUpFromLine size={24} aria-hidden="true" />
            <strong>{fileName || "选择 ZIP 题目包"}</strong>
            <span>支持 Urmotiv 完整包和 Hydro 导出的题目包</span>
          </label>

          {upload.isPending ? (
            <p className="notice-line">
              <Loader2 className="spin" size={14} aria-hidden="true" /> 正在上传并识别…
            </p>
          ) : null}
          {upload.error ? <p className="form-error">{upload.error.message}</p> : null}

          {upload.data ? (
            <>
              <dl className="metadata-list">
                <div>
                  <dt>文件大小</dt>
                  <dd>{formatBytes(upload.data.byteSize)}</dd>
                </div>
                <div>
                  <dt>SHA-256</dt>
                  <dd>{upload.data.sha256.slice(0, 12)}…</dd>
                </div>
                <div>
                  <dt>上传有效期至</dt>
                  <dd>{dateTime(upload.data.expiresAt)}</dd>
                </div>
              </dl>

              {detected.length > 0 ? (
                <div className="field">
                  <span>识别结果</span>
                  <ul className="plain-list">
                    {detected.map((item) => (
                      <li key={item.formatId}>
                        <strong>{item.displayName}</strong>（置信度 {Math.round(item.confidence * 100)}%）—— {item.reason}
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}

              <label className="field">
                <span>来源格式</span>
                <select
                  value={formatId}
                  onChange={(event) => {
                    setFormatId(event.target.value as SourceFormat);
                    resetProgress();
                  }}
                >
                  <option value="urmotiv">{sourceFormatText.urmotiv}</option>
                  <option value="hydro">{sourceFormatText.hydro}</option>
                </select>
              </label>
            </>
          ) : null}
        </section>

        {upload.data ? (
          <section className="plain-panel">
            <div className="section-title">
              <div>
                <p className="eyebrow">第 2 步</p>
                <h2>预览</h2>
              </div>
            </div>
            <button
              className="secondary-button"
              type="button"
              disabled={preview.isPending}
              onClick={() => {
                if (!upload.data) {
                  return;
                }
                resetProgress();
                preview.mutate({ fileId: upload.data.fileId, formatId });
              }}
            >
              {preview.isPending ? "正在读取…" : "查看内容"}
            </button>
            {preview.error ? <p className="form-error">{preview.error.message}</p> : null}

            {preview.data ? (
              <>
                <dl className="metadata-list">
                  <div>
                    <dt>题目数量</dt>
                    <dd>{preview.data.problemCount}</dd>
                  </div>
                  <div>
                    <dt>标题</dt>
                    <dd>{preview.data.title ?? "未提供"}</dd>
                  </div>
                  <div>
                    <dt>文件数量</dt>
                    <dd>{preview.data.files.length}</dd>
                  </div>
                </dl>
                {preview.data.files.length === 0 ? (
                  <p className="table-message">预览中没有可展示的文件。</p>
                ) : null}
                <div className="file-list">
                  <ul>
                    {preview.data.files.slice(0, 50).map((path) => (
                      <li key={path}>{path}</li>
                    ))}
                  </ul>
                  {preview.data.files.length > 50 ? (
                    <p className="text-faint">等 {preview.data.files.length - 50} 个文件</p>
                  ) : null}
                </div>
                {preview.data.issues.length > 0 ? (
                  <ul className="issue-list">
                    {preview.data.issues.map((issue, index) => (
                      <li key={index} className={`issue-item ${severityClass[issue.severity]}`}>
                        <span className="issue-severity">{severityLabel[issue.severity]}</span>
                        {issue.path ? <code>{issue.path}</code> : null}
                        <span>{issue.message}</span>
                      </li>
                    ))}
                  </ul>
                ) : null}
              </>
            ) : null}
          </section>
        ) : null}

        {preview.data ? (
          <section className="plain-panel">
            <div className="section-title">
              <div>
                <p className="eyebrow">第 3 步</p>
                <h2>确认导入</h2>
              </div>
            </div>
            {importJobId === null ? (
              <button
                className="primary-button"
                type="button"
                disabled={hasBlockingIssue || createImport.isPending || !upload.data}
                onClick={() => {
                  if (!upload.data) {
                    return;
                  }
                  createImport.mutate({
                    fileId: upload.data.fileId,
                    sha256: upload.data.sha256,
                    formatId,
                    idempotencyKey: crypto.randomUUID()
                  });
                }}
              >
                确认导入
              </button>
            ) : null}
            {hasBlockingIssue && importJobId === null ? (
              <p className="text-faint">预览中存在错误，需要先处理才能导入。</p>
            ) : null}
            {createImport.error ? <p className="form-error">{createImport.error.message}</p> : null}

            {job ? (
              <>
                <JobProgressView phase={job.phase} progressPercent={job.progressPercent} state={job.state} />
                {job.items.length > 1 ? (
                  <p className="text-faint">
                    共 {job.items.length} 项，已完成 {job.completedItems} 项
                    {job.failedItems > 0 ? `，失败 ${job.failedItems} 项` : ""}
                  </p>
                ) : null}
                {job.failure ? <p className="form-error">{job.failure.message}</p> : null}
                <ImportResultList items={job.items} />
              </>
            ) : null}
          </section>
        ) : null}
      </div>

      <aside className="plain-panel transfer-notes">
        <h2>导入前会检查</h2>
        <ul className="check-list">
          <li>压缩包中是否有非法路径、符号链接或重名文件</li>
          <li>解压大小、文件数量和压缩比例是否超过限制</li>
          <li>题面、数据点和程序能否整理为系统需要的题目信息</li>
          <li>同来源题目是否与已有内容冲突</li>
        </ul>
        <p className="warning-note">
          <AlertTriangle size={16} aria-hidden="true" />
          系统会先显示预览和警告，确认后由服务器在后台处理，并在页面显示进度。
        </p>
      </aside>
    </div>
  );
}

function ExportSection({ currentUserId }: { currentUserId: string }) {
  const client = useQueryClient();
  const [problemIdsText, setProblemIdsText] = useState("");
  const [targetFormat, setTargetFormat] = useState<SourceFormat>("urmotiv");
  const [categoryChecks, setCategoryChecks] = useState<Record<CategoryGroupKey, boolean>>(defaultCategoryChecks());
  const [exportJobId, setExportJobId] = useState<string | null>(null);
  const [accessDenied, setAccessDenied] = useState(false);

  const preview = useMutation({ mutationFn: previewExport });
  const createExport = useMutation({
    mutationFn: createExportJob,
    onSuccess: (job) => setExportJobId(job.id)
  });
  const exportJobQuery = useQuery({
    queryKey: ["transfer-export-job", currentUserId, exportJobId],
    queryFn: () => getExportJob(exportJobId as string),
    enabled: exportJobId !== null,
    retry: false,
    refetchInterval: (query) => (isJobFinished(query.state.data?.state) ? false : 1500)
  });
  const denied = [preview.error, createExport.error, exportJobQuery.error]
    .some(isAccessBoundaryError);
  useEffect(() => {
    if (!denied) {
      return;
    }
    setAccessDenied(true);
    setProblemIdsText("");
    setExportJobId(null);
    preview.reset();
    createExport.reset();
    client.removeQueries({ queryKey: ["transfer-export-job", currentUserId] });
  }, [client, currentUserId, denied]);
  useEffect(() => {
    setAccessDenied(false);
    setProblemIdsText("");
    setTargetFormat("urmotiv");
    setCategoryChecks(defaultCategoryChecks());
    setExportJobId(null);
    preview.reset();
    createExport.reset();
  }, [currentUserId]);

  const resetProgress = () => {
    preview.reset();
    createExport.reset();
    setExportJobId(null);
  };

  const problemIds = parseIdList(problemIdsText);
  const includeFileCategories = categoryGroups
    .filter((group) => categoryChecks[group.key])
    .flatMap((group) => group.categories);
  const job = exportJobQuery.data;
  if (accessDenied || denied) {
    return (
      <div className="centered-message" role="alert">
        <Archive size={28} aria-hidden="true" />
        <h2>导出任务不存在</h2>
        <p>任务不存在或当前账号不能访问。</p>
      </div>
    );
  }

  return (
    <div className="transfer-layout">
      <div className="transfer-main">
        <section className="plain-panel">
          <div className="section-title">
            <div>
              <p className="eyebrow">第 1 步</p>
              <h2>选择导出内容</h2>
            </div>
            <ArrowDownToLine size={22} aria-hidden="true" />
          </div>
          <label className="field">
            <span>题目编号</span>
            <textarea
              rows={3}
              placeholder="输入有权导出的题目编号，可用逗号、空格或换行分隔多个编号"
              value={problemIdsText}
              onChange={(event) => {
                setProblemIdsText(event.target.value);
                resetProgress();
              }}
            />
          </label>
          <label className="field">
            <span>目标格式</span>
            <select
              value={targetFormat}
              onChange={(event) => {
                setTargetFormat(event.target.value as SourceFormat);
                resetProgress();
              }}
            >
              <option value="urmotiv">{sourceFormatText.urmotiv}</option>
              <option value="hydro">{sourceFormatText.hydro}</option>
            </select>
          </label>
          <fieldset className="checkbox-group">
            <legend>包含内容</legend>
            {categoryGroups.map((group) => (
              <label key={group.key}>
                <input
                  type="checkbox"
                  checked={categoryChecks[group.key]}
                  onChange={(event) => {
                    setCategoryChecks((current) => ({ ...current, [group.key]: event.target.checked }));
                    resetProgress();
                  }}
                />
                {group.label}
              </label>
            ))}
          </fieldset>
          <button
            className="primary-button"
            type="button"
            disabled={problemIds.length === 0 || preview.isPending}
            onClick={() =>
              preview.mutate({
                targetFormat,
                problems: problemIds.map((problemId) => ({ problemId, includeFileCategories }))
              })
            }
          >
            {preview.isPending ? "正在检查…" : "检查格式差异"}
          </button>
          {preview.error ? <p className="form-error">{preview.error.message}</p> : null}

          {preview.data ? (
            <div className="export-preview-list">
              {preview.data.problems.length === 0 ? (
                <p className="table-message">没有找到可导出的题目，请检查题目编号是否有导出权限。</p>
              ) : null}
              {preview.data.problems.map((problem) => (
                <div key={problem.problemId} className="export-preview-item">
                  <div className="export-preview-item-heading">
                    <strong>{problem.title ?? problem.problemId}</strong>
                    {problem.title ? <span className="text-faint">{problem.problemId}</span> : null}
                    <span className={`status-badge ${exportStatusTone[problem.status]}`}>
                      {exportStatusText[problem.status]}
                    </span>
                  </div>
                  {problem.items.length > 0 ? (
                    <ul className="issue-list">
                      {problem.items.map((item, index) => (
                        <li key={index} className={`issue-item ${severityClass[item.severity]}`}>
                          <span className="issue-severity">{severityLabel[item.severity]}</span>
                          {item.path ? <code>{item.path}</code> : null}
                          <span>{item.message}</span>
                        </li>
                      ))}
                    </ul>
                  ) : null}
                </div>
              ))}
            </div>
          ) : null}
        </section>

        {preview.data ? (
          <section className="plain-panel">
            <div className="section-title">
              <div>
                <p className="eyebrow">第 2 步</p>
                <h2>创建导出任务</h2>
              </div>
            </div>
            {exportJobId === null ? (
              <button
                className="primary-button"
                type="button"
                disabled={!preview.data.canExport || createExport.isPending}
                onClick={() => {
                  if (!preview.data) {
                    return;
                  }
                  const revisionByProblemId = new Map(
                    preview.data.problems.map((problem) => [problem.problemId, problem.revisionId] as const)
                  );
                  createExport.mutate({
                    targetFormat,
                    problems: problemIds.map((problemId) => {
                      const revisionId = revisionByProblemId.get(problemId);
                      return {
                        problemId,
                        includeFileCategories,
                        ...(revisionId ? { revisionId } : {})
                      };
                    }),
                    idempotencyKey: crypto.randomUUID()
                  });
                }}
              >
                创建导出任务
              </button>
            ) : null}
            {!preview.data.canExport && exportJobId === null ? (
              <p className="text-faint">存在无法导出的题目，需要先处理才能创建任务。</p>
            ) : null}
            {createExport.error ? <p className="form-error">{createExport.error.message}</p> : null}

            {job ? (
              <>
                <JobProgressView phase={job.phase} progressPercent={job.progressPercent} state={job.state} />
                {job.failure ? <p className="form-error">{job.failure.message}</p> : null}
                {job.resultReady ? (
                  <div className="export-download-row">
                    <a className="primary-button" href={exportDownloadUrl(job.id)} download>
                      <Download size={16} aria-hidden="true" />
                      下载题目包
                    </a>
                    {job.resultExpiresAt ? (
                      <span className="text-faint">{dateTime(job.resultExpiresAt)} 前有效</span>
                    ) : null}
                  </div>
                ) : null}
              </>
            ) : null}
          </section>
        ) : null}
      </div>

      <aside className="plain-panel transfer-notes">
        <h2>生成前会再次确认</h2>
        <ul className="check-list">
          <li>题目修订版本和每一类文件的查看权限</li>
          <li>目标 OJ 无法保存的字段和需要人工选择的内容</li>
          <li>任务开始、读取文件和下载时的当前权限</li>
        </ul>
        <p className="warning-note">
          <AlertTriangle size={16} aria-hidden="true" />
          下载地址短期有效；权限被撤销后，旧地址也不能继续使用。
        </p>
      </aside>
    </div>
  );
}
