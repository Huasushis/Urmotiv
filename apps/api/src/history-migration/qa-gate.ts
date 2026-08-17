import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { candidateContentDigest, sha256Hex } from "./digests";
import { HistoryMigrationError, HistoryNormalizationError } from "./errors";
import {
  historyCandidateRecordSchema,
  type HistoryCandidateRecord,
} from "./schema";

/**
 * 156 题的语义 QA 门：确定性机械检查 + 可注入的源对候选评审钩子，
 * 只有 ANOMALY 才再次评审；每个题号最终必须有且仅有一个 verdict，
 * 不允许跳过。核心不读 Git、不写正式库，只按题号记账并产出安全汇总。
 */

export type QaVerdict = "PASS" | "ANOMALY" | "ERROR";

export const qaCoreMinimumConcurrency = 1;
export const qaCoreMaximumConcurrency = 16;
export const qaDefaultConcurrency = 14;
export const qaCliConcurrencyMinimum = 12;

export interface QaItem {
  /** 题号（1..N），财务验收按题号计数。 */
  readonly id: number;
  /** 聚合后的原始材料文本（对应已人工确认分组的源）。 */
  readonly sourceText: string;
  /** 原始材料文本 sha256，用于机械确权。 */
  readonly sourceSha256: string;
  /** 候选记录序列化 JSON；为 null 表示该题尚未产出候选。 */
  readonly candidateText: string | null;
  /** 该候选应绑定的源安全编号。 */
  readonly expectedSourceId: string;
  /** 该候选应绑定的确认源映射摘要。 */
  readonly sourceMappingSha256: string;
}

export interface QaReviewRequest {
  readonly id: number;
  readonly sourceText: string;
  readonly sourceSha256: string;
  readonly candidateText: string;
  /** true 表示 ANOMALY 后的第二次评审；false 表示首次源对候选评审。 */
  readonly secondAttempt: boolean;
}

export interface QaReviewResult {
  readonly verdict: QaVerdict;
  /** 只含安全评审原因，不含模型原始输出正文。 */
  readonly reasons: readonly string[];
}

export type QaReviewer = (request: QaReviewRequest) => Promise<QaReviewResult>;

/**
 * 每个题号的持久化评审状态：确定性检查后按题号记账，支持恢复。
 * 持久化只写题号和 verdict，不写源文本或候选正文。
 */
export interface QaPersistedState {
  readonly version: 1;
  readonly id: number;
  readonly deterministicErrors: readonly string[];
  readonly deterministicRisks: readonly string[];
  readonly verdict: QaVerdict | null;
  readonly attemptCount: number;
  readonly secondReviewCount: number;
}

export interface QaStateStore {
  read(id: number): Promise<QaPersistedState | null>;
  write(state: QaPersistedState): Promise<void>;
}

export interface RunQaGateOptions {
  /** 并发上限。CLI 强制 12..16；核心范围 1..16，默认 14。 */
  readonly concurrency?: number;
  /** 每次评审尝试上限；只有可重试失败才消耗。默认 3。 */
  readonly maximumAttempts?: number;
  /** 是否启用 ANOMALY 专属第二次评审。默认 true。 */
  readonly secondReviewEnabled?: boolean;
  /** 重试退避基准毫秒数。默认 3000。 */
  readonly retryBaseDelayMs?: number;
  /** 只供合成测试注入的等待函数，避免真实延迟。 */
  readonly sleep?: (ms: number) => Promise<void>;
  /** 只供合成测试注入的抖动，使测试确定性。 */
  readonly jitter?: () => number;
}

export interface RunQaGateResult {
  readonly pass: number;
  readonly anomaly: number;
  readonly error: number;
  readonly total: number;
  readonly account: readonly { readonly id: number; readonly verdict: QaVerdict }[];
}

const retryableKinds: ReadonlySet<string> = new Set([
  "http_429",
  "connection",
  "first_output_timeout",
  "output_idle_timeout",
]);

/** 只有服务端 429 与传输中断类失败允许重试；模型校验失败不回退。 */
export function isQaRetryableFailure(error: unknown): error is HistoryNormalizationError {
  return (
    error instanceof HistoryNormalizationError && retryableKinds.has(error.failureKind)
  );
}

function defaultSleep(ms: number): Promise<void> {
  const { promise, resolve } = deferred<void>();
  setTimeout(resolve, ms);
  return promise;
}

function deferred<T>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
  readonly reject: (reason?: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function defaultJitter(): number {
  return Math.random();
}

/**
 * 确定性的机械检查，不调用模型：候选缺失或 JSON 破坏、schema 不符、
 * 源摘要不一致、源编号或确认映射不符、附件引用被丢弃、题解疑似臆造或缺失。
 */
export function runQaDeterministicChecks(item: QaItem): {
  readonly errors: readonly string[];
  readonly risks: readonly string[];
} {
  const errors: string[] = [];
  const risks: string[] = [];
  if (item.candidateText === null) {
    return { errors: ["missing-candidate"], risks: [] };
  }
  const sourceDigest = sha256Hex(item.sourceText);
  if (sourceDigest !== item.sourceSha256) {
    return { errors: ["source-text-digest-mismatch"], risks: [] };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(item.candidateText) as unknown;
  } catch {
    return { errors: ["candidate-invalid-json"], risks: [] };
  }
  const recordResult = historyCandidateRecordSchema.safeParse(parsed);
  if (!recordResult.success) {
    return { errors: ["candidate-schema-invalid"], risks: [] };
  }
  const record = recordResult.data as HistoryCandidateRecord;
  if (record.sourceId !== item.expectedSourceId) {
    return { errors: ["candidate-source-mismatch"], risks: [] };
  }
  if (record.sourceContentSha256 !== sourceDigest) {
    return { errors: ["source-content-digest-mismatch"], risks: [] };
  }
  if (record.sourceMappingSha256 !== item.sourceMappingSha256) {
    return { errors: ["source-mapping-digest-mismatch"], risks: [] };
  }
  if (record.contentSha256 !== recomputeCandidateDigest(record, sourceDigest)) {
    return { errors: ["candidate-content-digest-mismatch"], risks: [] };
  }
  const problemText = [
    record.problem.content.basicStatement,
    record.problem.content.background,
    record.problem.content.statement,
    record.problem.content.inputFormat,
    record.problem.content.outputFormat,
    record.problem.content.constraints,
    record.problem.content.basicSolution ?? "",
    record.problem.content.solution,
    record.problem.content.hints,
    ...record.problem.samples.flatMap((sample) => [
      sample.input,
      sample.output,
      sample.explanation,
    ]),
  ].join("\n");
  const dropped = attachmentRefsLostFromSource(item.sourceText, problemText);
  if (dropped) {
    risks.push("attachment-refs-dropped");
  }
  if (sourceHasSolutionMarker(item.sourceText) && !candidateHasSolution(record)) {
    risks.push("expected-solution-missing");
  }
  if (!sourceHasSolutionMarker(item.sourceText) && candidateHasSolution(record)) {
    risks.push("possible-fabricated-solution");
  }
  return { errors, risks };
}

function recomputeCandidateDigest(
  record: HistoryCandidateRecord,
  sourceDigest: string,
): string {
  return candidateContentDigest({
    sourceId: record.sourceId,
    sourceContentSha256: sourceDigest,
    sourceMappingSha256: record.sourceMappingSha256,
    modelConfidence: record.modelConfidence,
    normalizationNote: record.normalizationNote,
    problem: record.problem,
  });
}

/**
 * 原文附件引用是否全部出现在候选文本中；任一引用丢失返回 true。
 * 采用 Markdown 链接/图片引用的一致性核对，不猜测附件内容。
 */
export function attachmentRefsLostFromSource(sourceText: string, candidateText: string): boolean {
  const sourceRefs = collectMarkdownRefs(sourceText);
  const candidateRefs = collectMarkdownRefs(candidateText);
  for (const ref of sourceRefs) {
    if (!candidateRefs.has(ref)) return true;
  }
  return false;
}

export function collectMarkdownRefs(text: string): ReadonlySet<string> {
  const refs = new Set<string>();
  const imagePattern = /!\[([^\]]*)\]\(([^)]+)\)/g;
  const linkPattern = /\[([^\]]*)\]\(([^)]+)\)/g;
  let match: RegExpExecArray | null;
  while ((match = imagePattern.exec(text)) !== null) {
    const target = match[2];
    if (target === undefined || target.length === 0 || target.length >= 1_000) continue;
    const label = match[1];
    refs.add(`${label ?? ""} ${target}`.trim());
  }
  while ((match = linkPattern.exec(text)) !== null) {
    const target = match[2];
    if (target === undefined || target.length === 0 || target.length >= 1_000) continue;
    const label = match[1];
    refs.add(`${label ?? ""} ${target}`.trim());
  }
  return refs;
}

/** 原文是否含明确题解段落标记；只识别常见小节标题，不确定时保持 false。 */
export function sourceHasSolutionMarker(text: string): boolean {
  return /(^|\s)#{1,6}\s*(?:题解|解答|参考程序|标准程序|参考答案|分析|解析)\s*$|std\.cpp\b/im.test(text);
}

function candidateHasSolution(record: HistoryCandidateRecord): boolean {
  return record.problem.content.solution.trim().length > 0 ||
    (record.problem.content.basicSolution ?? "").trim().length > 0;
}

/**
 * 按题号并发执行：确定性检查，未失败者运行评审钩子（ANOMALY 才二次）。
 * 恢复：每个题号持久化，跳过已有终态；失败重试有上限；结束前强制校验
 * 恰好 N 项且每题都有 verdict。
 */
export async function runQaGate(
  items: readonly QaItem[],
  reviewer: QaReviewer,
  store: QaStateStore,
  options: RunQaGateOptions = {},
): Promise<RunQaGateResult> {
  const concurrency = clampConcurrency(options.concurrency ?? qaDefaultConcurrency);
  const maximumAttempts = clampAttempts(options.maximumAttempts ?? 3);
  const secondReviewEnabled = options.secondReviewEnabled ?? true;
  const sleep = options.sleep ?? defaultSleep;
  const jitter = options.jitter ?? defaultJitter;
  const ids = items.map((item) => item.id);
  const idSet = new Set(ids);
  if (idSet.size !== ids.length) {
    throw new HistoryMigrationError("INVALID_ARGUMENTS", "同一题号不能重复进入 QA 门。");
  }

  const prepared = await Promise.all(
    items.map(async (item) => {
      const prior = await store.read(item.id);
      if (prior !== null && prior.verdict !== null) {
        return { item, state: prior };
      }
      const initial: QaPersistedState = {
        version: 1,
        id: item.id,
        deterministicErrors: [],
        deterministicRisks: [],
        verdict: null,
        attemptCount: 0,
        secondReviewCount: 0,
      };
      return { item, state: initial };
    }),
  );

  const queue = prepared.filter((entry) => entry.state.verdict === null);
  const results = new Map<number, QaVerdict>(
    prepared
      .filter((entry) => entry.state.verdict !== null)
      .map((entry) => [entry.item.id, entry.state.verdict as QaVerdict]),
  );

  const active: Promise<void>[] = [];
  let cursor = 0;
  const pump = async (): Promise<void> => {
    for (;;) {
      const next = cursor;
      cursor += 1;
      const queued = queue[next];
      if (queued === undefined) return;
      await runOneQueuedItem(
        queued.item,
        reviewer,
        store,
        {
          maximumAttempts,
          secondReviewEnabled,
          retryBaseDelayMs: options.retryBaseDelayMs ?? 3_000,
          sleep,
          jitter,
        },
        results,
      );
    }
  };
  for (let slot = 0; slot < Math.min(concurrency, queue.length); slot += 1) {
    active.push(pump());
  }
  await Promise.all(active);

  let pass = 0;
  let anomaly = 0;
  let error = 0;
  for (const id of idSet) {
    const verdict = results.get(id);
    if (verdict === undefined) {
      throw new HistoryMigrationError("INTERNAL_ERROR", `题号 ${id} 缺少 QA 结论。`);
    }
    if (verdict === "PASS") pass += 1;
    else if (verdict === "ANOMALY") anomaly += 1;
    else error += 1;
  }

  return {
    pass,
    anomaly,
    error,
    total: ids.length,
    account: [...idSet]
      .sort((left, right) => left - right)
      .map((id) => ({ id, verdict: results.get(id) as QaVerdict })),
  };
}

function clampConcurrency(value: number): number {
  if (!Number.isInteger(value) || value < qaCoreMinimumConcurrency ||
      value > qaCoreMaximumConcurrency) {
    throw new HistoryMigrationError("INVALID_ARGUMENTS", "QA 并发数必须在 1..16 之间。");
  }
  return value;
}

function clampAttempts(value: number): number {
  if (!Number.isInteger(value) || value < 1 || value > 10) {
    throw new HistoryMigrationError("INVALID_ARGUMENTS", "QA 评审尝试次数必须在 1..10 之间。");
  }
  return value;
}

async function runOneQueuedItem(
  item: QaItem,
  reviewer: QaReviewer,
  store: QaStateStore,
  options: {
    readonly maximumAttempts: number;
    readonly secondReviewEnabled: boolean;
    readonly retryBaseDelayMs: number;
    readonly sleep: (ms: number) => Promise<void>;
    readonly jitter: () => number;
  },
  results: Map<number, QaVerdict>,
): Promise<void> {
  let state = await store.read(item.id);
  if (state === null) {
    state = {
      version: 1,
      id: item.id,
      deterministicErrors: [],
      deterministicRisks: [],
      verdict: null,
      attemptCount: 0,
      secondReviewCount: 0,
    };
  }
  if (state.verdict !== null) {
    results.set(item.id, state.verdict);
    return;
  }

  const deterministic = runQaDeterministicChecks(item);
  state = { ...state, deterministicErrors: deterministic.errors, deterministicRisks: deterministic.risks };
  if (deterministic.errors.length > 0 || deterministic.risks.length > 0) {
    state = { ...state, verdict: deterministic.errors.length > 0 ? "ERROR" : "ANOMALY" };
    await store.write(state);
    results.set(item.id, state.verdict as QaVerdict);
    return;
  }
  if (item.candidateText === null) {
    state = { ...state, verdict: "ANOMALY" };
    await store.write(state);
    results.set(item.id, state.verdict as QaVerdict);
    return;
  }

  const primary = await reviewWithRetries(reviewer, buildReviewRequest(item, false), item.id, options, "primary");
  state = { ...state, attemptCount: state.attemptCount + 1, verdict: primary.verdict };
  if (state.verdict === "ANOMALY" && options.secondReviewEnabled) {
    const second = await reviewWithRetries(reviewer, buildReviewRequest(item, true), item.id, options, "second");
    state = { ...state, verdict: second.verdict, secondReviewCount: state.secondReviewCount + 1 };
  }
  await store.write(state);
  results.set(item.id, state.verdict as QaVerdict);
}

function buildReviewRequest(item: QaItem, secondAttempt: boolean): QaReviewRequest {
  return {
    id: item.id,
    sourceText: item.sourceText,
    sourceSha256: item.sourceSha256,
    candidateText: item.candidateText as string,
    secondAttempt,
  };
}

async function reviewWithRetries(
  reviewer: QaReviewer,
  request: QaReviewRequest,
  id: number,
  options: {
    readonly maximumAttempts: number;
    readonly retryBaseDelayMs: number;
    readonly sleep: (ms: number) => Promise<void>;
    readonly jitter: () => number;
  },
  purpose: "primary" | "second",
): Promise<QaReviewResult> {
  for (let attempt = 1; attempt <= options.maximumAttempts; attempt += 1) {
    try {
      return await reviewer(request);
    } catch (error) {
      if (!isQaRetryable(error, attempt, options.maximumAttempts)) {
        throw wrapNonRetryable(error, id, purpose);
      }
      const delay = Math.floor(options.retryBaseDelayMs * attempt * (0.5 + options.jitter()));
      await options.sleep(delay);
    }
  }
  throw new HistoryMigrationError("INTERNAL_ERROR", `${id} 评审重试循环异常结束。`);
}

function isQaRetryable(error: unknown, attempt: number, maximumAttempts: number): boolean {
  return isQaRetryableFailure(error) && attempt < maximumAttempts;
}

function wrapNonRetryable(error: unknown, id: number, purpose: string): never {
  if (error instanceof HistoryNormalizationError || error instanceof HistoryMigrationError) {
    throw error;
  }
  const safeMessage = `题号 ${id} 的${purpose}评审失败。`;
  if (error instanceof Error) {
    throw new HistoryMigrationError("INTERNAL_ERROR", `${safeMessage} 原因分类：${error.name}。`, {
      cause: error,
    });
  }
  throw new HistoryMigrationError("INTERNAL_ERROR", safeMessage);
}

export function qaStateFileName(id: number): string {
  return `qa-${String(id).padStart(6, "0")}.state.json`;
}

/**
 * 文件后端：写 `.data/` 下的题号状态文件并以 0600 保护，恢复读取
 * 已存在文件；只持久化题号与 verdict，不落原文正文。
 */
export async function createFileQaStateStore(directory: string): Promise<QaStateStore> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const resolved = resolve(directory);
  return {
    async read(id: number): Promise<QaPersistedState | null> {
      const filePath = join(resolved, qaStateFileName(id));
      let content: string;
      try {
        content = await readFile(filePath, "utf8");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw error;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(content) as unknown;
      } catch {
        throw new HistoryMigrationError("INTERNAL_ERROR", `题号 ${id} 的状态文件损坏。`);
      }
      const check = structuredQaStateCheck(parsed);
      if (!check.ok) {
        throw new HistoryMigrationError("INTERNAL_ERROR", `题号 ${id} 的状态文件格式错误。`);
      }
      return check.value;
    },
    async write(state: QaPersistedState): Promise<void> {
      const filePath = join(resolved, qaStateFileName(state.id));
      const temporaryPath = `${filePath}.tmp`;
      await writeFile(temporaryPath, JSON.stringify(state), { mode: 0o600 });
      await rename(temporaryPath, filePath);
    },
  };
}

function structuredQaStateCheck(value: unknown):
  | { readonly ok: true; readonly value: QaPersistedState }
  | { readonly ok: false } {
  if (typeof value !== "object" || value === null) return { ok: false };
  const record = value as Record<string, unknown>;
  if (record.version !== 1 || typeof record.id !== "number") return { ok: false };
  for (const arrayField of ["deterministicErrors", "deterministicRisks"] as const) {
    const field = record[arrayField];
    if (!Array.isArray(field) || !field.every((entry) => typeof entry === "string")) {
      return { ok: false };
    }
  }
  const verdictField = record.verdict;
  if (verdictField !== null && verdictField !== "PASS" && verdictField !== "ANOMALY" &&
      verdictField !== "ERROR") {
    return { ok: false };
  }
  if (typeof record.attemptCount !== "number" || typeof record.secondReviewCount !== "number") {
    return { ok: false };
  }
  return {
    ok: true,
    value: {
      version: 1,
      id: record.id,
      deterministicErrors: record.deterministicErrors as string[],
      deterministicRisks: record.deterministicRisks as string[],
      verdict: verdictField as QaVerdict | null,
      attemptCount: record.attemptCount as number,
      secondReviewCount: record.secondReviewCount as number,
    },
  };
}
