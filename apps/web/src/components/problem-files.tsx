import { Download, File as FileIcon, FileCode2, Image, Paperclip, Upload } from "lucide-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useRef } from "react";
import type {
  JudgeProgramFileCategory,
  Problem,
  ProblemFileCategory,
  ProblemJudgeConfig
} from "@urmotiv/contracts";
import {
  listProblemFiles,
  problemFileDownloadUrl,
  problemFileReferenceUrl,
  uploadProblemFile,
  type ProblemFileUploadResponse
} from "../lib/api";

export const statementImageMediaTypes = [
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp"
] as const;

const statementImageMediaTypeSet: ReadonlySet<string> = new Set(statementImageMediaTypes);

const categoryLabels: Record<ProblemFileCategory, string> = {
  statement_image: "题面图片",
  public_attachment: "公开附件",
  internal_attachment: "内部附件",
  testdata: "测试数据",
  checker: "特殊判断程序",
  interactor: "交互程序",
  answer_checker: "答案判断程序",
  standard_solution: "标准程序"
};

const logicalPathPrefixes: Record<ProblemFileCategory, string> = {
  statement_image: "assets",
  public_attachment: "attachments/public",
  internal_attachment: "attachments/internal",
  testdata: "judge/testdata",
  checker: "judge/checker",
  interactor: "judge/interactor",
  answer_checker: "judge/answer-checker",
  standard_solution: "solutions/std"
};

const imageExtensions: Record<(typeof statementImageMediaTypes)[number], string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp"
};

type FileUploadCallbacks = {
  onRevisionChange?: ((revision: number) => void) | undefined;
  onPendingChange?: ((pending: boolean) => void) | undefined;
};

type ProblemFileUploader = (
  file: File,
  category: ProblemFileCategory
) => Promise<ProblemFileUploadResponse>;

export function isSupportedStatementImage(file: File): boolean {
  return statementImageMediaTypeSet.has(file.type.trim().toLowerCase());
}

export function makeProblemFileLogicalPath(
  file: File,
  category: ProblemFileCategory
): string {
  const normalizedMediaType = file.type.trim().toLowerCase();
  const imageExtension = statementImageMediaTypeSet.has(normalizedMediaType)
    ? imageExtensions[normalizedMediaType as keyof typeof imageExtensions]
    : undefined;
  const originalExtension = file.name.match(/\.([A-Za-z0-9]{1,12})$/)?.[1]?.toLowerCase();
  const extension = imageExtension ?? originalExtension;
  return `${logicalPathPrefixes[category]}/${crypto.randomUUID()}${extension ? `.${extension}` : ""}`;
}

export function useProblemFileUploader(
  problem: Pick<Problem, "id" | "revision">,
  callbacks: FileUploadCallbacks = {}
): ProblemFileUploader {
  const client = useQueryClient();
  const pending = useRef(false);
  const { onPendingChange, onRevisionChange } = callbacks;

  return useCallback(
    async (file: File, category: ProblemFileCategory) => {
      if (pending.current) {
        throw new Error("另一个文件仍在上传，请稍候。");
      }
      if (category === "statement_image" && !isSupportedStatementImage(file)) {
        throw new Error("仅支持 PNG、JPEG、GIF 或 WebP 图片。");
      }

      pending.current = true;
      onPendingChange?.(true);
      try {
        const result = await uploadProblemFile(problem.id, {
          file,
          expectedRevision: problem.revision,
          category,
          logicalPath: makeProblemFileLogicalPath(file, category)
        });
        onRevisionChange?.(result.revision);
        void client.invalidateQueries({ queryKey: ["problem-files", problem.id] });
        return result;
      } finally {
        pending.current = false;
        onPendingChange?.(false);
      }
    },
    [client, onPendingChange, onRevisionChange, problem.id, problem.revision]
  );
}

export function useStatementImageUploader(
  problem: Pick<Problem, "id" | "revision">,
  callbacks: FileUploadCallbacks = {}
): (file: File) => Promise<string> {
  const upload = useProblemFileUploader(problem, callbacks);
  return useCallback(
    async (file: File) => {
      const result = await upload(file, "statement_image");
      return problemFileReferenceUrl(problem.id, result.item.id);
    },
    [problem.id, upload]
  );
}

export function judgeProgramCategoryForType(
  type: Problem["type"]
): JudgeProgramFileCategory {
  if (type === "traditional") return "checker";
  if (type === "interactive") return "interactor";
  return "answer_checker";
}

export function bindJudgeProgramConfig(
  config: ProblemJudgeConfig | null,
  type: Problem["type"],
  source: string
): ProblemJudgeConfig {
  const current = config ?? {
    version: 1 as const,
    limits: { timeMs: 1000, memoryMiB: 512 },
    scoring: { total: 100, subtaskMode: "sum" as const },
    subtasks: [],
    testcases: []
  };
  const {
    checker: _checker,
    interactor: _interactor,
    answerChecker: _answerChecker,
    ...withoutProgram
  } = current;
  if (type === "traditional") {
    return { ...withoutProgram, checker: { type: "special", source } };
  }
  if (type === "interactive") {
    return { ...withoutProgram, interactor: { source } };
  }
  return { ...withoutProgram, answerChecker: { source } };
}

export function judgeProgramSource(problem: Pick<Problem, "type" | "judgeConfig">): string | undefined {
  const config = problem.judgeConfig;
  if (config === null) return undefined;
  if (problem.type === "traditional") {
    return config.checker?.type === "special" ? config.checker.source : undefined;
  }
  if (problem.type === "interactive") return config.interactor?.source;
  return config.answerChecker?.source;
}

type JudgeProgramPanelProps = {
  problem: Problem;
  uploadsDisabled?: boolean;
  onBound: (revision: number, judgeConfig: ProblemJudgeConfig) => void;
  onPendingChange?: ((pending: boolean) => void) | undefined;
};

export function JudgeProgramPanel({
  problem,
  uploadsDisabled = false,
  onBound,
  onPendingChange
}: JudgeProgramPanelProps) {
  const client = useQueryClient();
  const input = useRef<HTMLInputElement>(null);
  const category = judgeProgramCategoryForType(problem.type);
  const source = judgeProgramSource(problem);
  const files = useQuery({
    queryKey: ["problem-files", problem.id, problem.revision],
    queryFn: () => listProblemFiles(problem.id)
  });
  const upload = useMutation({
    mutationFn: async (file: File) => {
      onPendingChange?.(true);
      return uploadProblemFile(problem.id, {
        file,
        expectedRevision: problem.revision,
        category,
        logicalPath: makeProblemFileLogicalPath(file, category),
        bindJudgeProgram: true
      });
    },
    onSuccess: (result) => {
      onBound(
        result.revision,
        bindJudgeProgramConfig(problem.judgeConfig, problem.type, result.item.logicalPath)
      );
      void client.invalidateQueries({ queryKey: ["problem-files", problem.id] });
    },
    onSettled: () => onPendingChange?.(false)
  });
  const boundFile = source === undefined
    ? undefined
    : files.data?.items.find(
        (file) => file.category === category && file.logicalPath === source
      );
  const title = categoryLabels[category];
  const description = problem.type === "traditional"
    ? "答案不唯一时上传特殊判断程序；未绑定程序时使用标准比较。"
    : problem.type === "interactive"
      ? "交互程序在评测时与选手程序交换信息。"
      : "答案判断程序读取提交文件并判断得分。";
  const busy = uploadsDisabled || upload.isPending;

  return (
    <section className="program-upload" aria-label={title}>
      <div>
        <FileCode2 size={21} aria-hidden="true" />
        <div>
          <h3>{title}</h3>
          <p>{description}</p>
        </div>
      </div>

      <div className="inline-actions">
        {source === undefined ? (
          <p className="file-help">
            {problem.type === "traditional" ? "当前使用标准比较。" : `尚未绑定${title}。`}
          </p>
        ) : files.isLoading ? (
          <p className="file-help">正在核对已绑定程序…</p>
        ) : boundFile === undefined ? (
          <p className="inline-error file-error" role="alert">已保存的程序文件不可用，请重新上传。</p>
        ) : (
          <div className="problem-file-row">
            <span className="problem-file-kind"><FileCode2 size={16} aria-hidden="true" />已绑定</span>
            <span className="problem-file-name" title={boundFile.originalName}>{boundFile.originalName}</span>
            <span className="problem-file-size">{formatByteSize(boundFile.byteSize)}</span>
            <a
              className="secondary-button compact-button"
              href={problemFileDownloadUrl(problem.id, boundFile.id)}
              download={boundFile.originalName}
            >
              <Download size={15} aria-hidden="true" />
              下载
            </a>
          </div>
        )}

        {files.isError ? <p className="inline-error file-error" role="alert">{files.error.message}</p> : null}
        {upload.error ? <p className="inline-error file-error" role="alert">{upload.error.message}</p> : null}
        {upload.isPending ? <p className="file-help" aria-live="polite">正在上传并绑定，请勿保存其他修改…</p> : null}
        {uploadsDisabled && !upload.isPending ? (
          <p className="file-help">请先等待当前修改保存完成，再更换评测程序。</p>
        ) : null}

        {problem.capabilities.canEdit && problem.capabilities.canWriteTestdata ? (
          <>
            <input
              ref={input}
              className="problem-file-input"
              type="file"
              tabIndex={-1}
              onChange={(event) => {
                const file = event.target.files?.[0];
                event.target.value = "";
                if (file !== undefined) upload.mutate(file);
              }}
            />
            <button
              className="secondary-button"
              type="button"
              disabled={busy}
              onClick={() => input.current?.click()}
            >
              <Upload size={15} aria-hidden="true" />
              {source === undefined ? `上传并绑定${title}` : `更换${title}`}
            </button>
          </>
        ) : (
          <span className="file-help">只读</span>
        )}
      </div>
    </section>
  );
}

type ProblemFilesPanelProps = {
  problem: Problem;
  uploadsDisabled?: boolean;
} & FileUploadCallbacks;

export function ProblemFilesPanel({
  problem,
  uploadsDisabled = false,
  onRevisionChange,
  onPendingChange
}: ProblemFilesPanelProps) {
  const files = useQuery({
    queryKey: ["problem-files", problem.id, problem.revision],
    queryFn: () => listProblemFiles(problem.id)
  });
  const uploadFile = useProblemFileUploader(problem, { onRevisionChange, onPendingChange });
  const upload = useMutation({
    mutationFn: ({ file, category }: { file: File; category: ProblemFileCategory }) =>
      uploadFile(file, category)
  });
  const busy = uploadsDisabled || upload.isPending;

  return (
    <section className="materials-section" aria-label="程序与附件">
      <div className="section-title">
        <div><p className="eyebrow">文件</p><h2>程序与附件</h2></div>
        <Paperclip size={21} aria-hidden="true" />
      </div>

      <div className="materials-grid">
        <FilePickerCard
          title="公开附件"
          description="可随公开题面一起导出"
          icon={Paperclip}
          buttonLabel="选择公开附件"
          disabled={busy || !problem.capabilities.canEdit}
          onSelect={(file) => upload.mutate({ file, category: "public_attachment" })}
        />
        <FilePickerCard
          title="内部附件"
          description="仅有内部资料权限的人可下载"
          icon={FileIcon}
          buttonLabel="选择内部附件"
          disabled={busy || !problem.capabilities.canEdit || !problem.capabilities.canWriteTestdata}
          onSelect={(file) => upload.mutate({ file, category: "internal_attachment" })}
        />
        <FilePickerCard
          title="标准程序"
          description="用于核对答案，不会出现在公开题面"
          icon={FileCode2}
          buttonLabel="选择标准程序"
          disabled={busy || !problem.capabilities.canEdit || !problem.capabilities.canWriteTestdata}
          onSelect={(file) => upload.mutate({ file, category: "standard_solution" })}
        />
      </div>

      {uploadsDisabled && !upload.isPending ? (
        <p className="file-help">请先等待题目正文保存完成，再选择文件。</p>
      ) : null}
      {upload.isPending ? <p className="file-help" aria-live="polite">正在上传文件，请勿提交题目…</p> : null}
      {upload.error ? <p className="inline-error file-error" role="alert">{upload.error.message}</p> : null}
      {files.isError ? <p className="inline-error file-error" role="alert">{files.error.message}</p> : null}

      <div className="problem-file-list" aria-busy={files.isLoading}>
        <div className="problem-file-list-heading">
          <strong>当前版本的文件</strong>
          <span>{files.data ? `${files.data.items.length} 个` : "正在读取…"}</span>
        </div>
        {files.data?.items.length === 0 ? <p className="empty-state">还没有可见文件。</p> : null}
        {files.data?.items.map((file) => (
          <div className="problem-file-row" key={file.id}>
            <span className="problem-file-kind">
              {file.category === "statement_image" ? <Image size={16} aria-hidden="true" /> : <FileIcon size={16} aria-hidden="true" />}
              {categoryLabels[file.category]}
            </span>
            <span className="problem-file-name" title={file.originalName}>{file.originalName}</span>
            <span className="problem-file-size">{formatByteSize(file.byteSize)}</span>
            <a
              className="secondary-button compact-button"
              href={problemFileDownloadUrl(problem.id, file.id)}
              download={file.originalName}
            >
              <Download size={15} aria-hidden="true" />
              下载
            </a>
          </div>
        ))}
      </div>
    </section>
  );
}

type FilePickerCardProps = {
  title: string;
  description: string;
  buttonLabel: string;
  disabled: boolean;
  icon: typeof Upload;
  onSelect: (file: File) => void;
};

function FilePickerCard({
  title,
  description,
  buttonLabel,
  disabled,
  icon: Icon,
  onSelect
}: FilePickerCardProps) {
  const input = useRef<HTMLInputElement>(null);
  return (
    <div>
      <span className="material-card-title"><Icon size={17} aria-hidden="true" /><strong>{title}</strong></span>
      <span>{description}</span>
      <input
        ref={input}
        className="problem-file-input"
        type="file"
        tabIndex={-1}
        onChange={(event) => {
          const file = event.target.files?.[0];
          event.target.value = "";
          if (file !== undefined) {
            onSelect(file);
          }
        }}
      />
      <button
        className="secondary-button"
        type="button"
        disabled={disabled}
        onClick={() => input.current?.click()}
      >
        <Upload size={15} aria-hidden="true" />
        {buttonLabel}
      </button>
    </div>
  );
}

function formatByteSize(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KiB`;
  }
  return `${(bytes / 1024 / 1024).toFixed(1)} MiB`;
}
