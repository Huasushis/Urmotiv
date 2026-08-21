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

/** 确定性风险项经语义复评后的结构化处置结论。 */
export type QaDisposition =
  | "corrected"
  | "verified-false-positive"
  | "genuinely-unresolved-preserved-missing";

export const qaCoreMinimumConcurrency = 1;
export const qaCoreMaximumConcurrency = 20;
export const qaDefaultConcurrency = 14;
export const qaCliConcurrencyMinimum = 12;
export const qaCliConcurrencyDefault = 16;
export const qaCliConcurrencyMaximum = 20;

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
  /** 确定性检查发现的风险标记，供语义复评参考。 */
  readonly deterministicRisks?: readonly string[];
}

export interface QaReviewResult {
  readonly verdict: QaVerdict;
  /** 只含安全评审原因，不含模型原始输出正文。 */
  readonly reasons: readonly string[];
  /** 风险项复评后的结构化处置；无风险项可缺省。 */
  readonly disposition?: QaDisposition;
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
  /** 风险项复评后的结构化处置；无风险或未复评时为 null。 */
  readonly disposition: QaDisposition | null;
  /** 传输层记账：是否已发出请求。 */
  readonly requestIssued?: boolean;
  /** 传输层记账：是否尝试过传输。 */
  readonly transportAttempted?: boolean;
  /** 传输层记账：是否收到字节。 */
  readonly receivedBytes?: boolean;
  /** 传输层记账：重试分类。 */
  readonly retryClassification?: "retryable" | "non-retryable" | "not-attempted";
  /** 传输层记账：安全 HTTP 状态分类（如 "4xx"/"5xx"），不含原始状态码或正文。 */
  readonly httpStatusClass?: string;
}

export interface QaStateStore {
  read(id: number): Promise<QaPersistedState | null>;
  write(state: QaPersistedState): Promise<void>;
}

export interface QaRunProgress {
  readonly total: number;
  /** 已终态（含恢复跳过）并计入结果表的题号数。 */
  readonly completed: number;
  /** 正在执行评审的题号数。 */
  readonly inFlight: number;
  /** 正在等待可重试失败退避的题号数。 */
  readonly retryWaiting: number;
  /** 终态为 ERROR 的题号数。 */
  readonly terminalFailed: number;
  /** 已到达终态且为 PASS/ANOMALY 的题号数。 */
  readonly settled: number;
  /** 尚未被并发槽拾取的题号数。 */
  readonly notStarted: number;
}

export interface RunQaGateOptions {
  /** 并发上限。CLI 默认 16、上限 20；核心范围 1..20，默认 14。 */
  readonly concurrency?: number;
  /** 每次评审尝试上限；只有可重试失败才消耗。默认 3。 */
  readonly maximumAttempts?: number;
  /** 是否启用 ANOMALY 专属第二次评审。默认 true。 */
  readonly secondReviewEnabled?: boolean;
  /** 重试退避基准毫秒数。默认 3000。 */
  readonly retryDelayMs?: number;
  /** 每次聚合状态变化后的进度回调（CLI 用来计算 ETA）。 */
  readonly onProgress?: (progress: QaRunProgress) => void;
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
  /** 传输层聚合：已发出请求的题号数。 */
  readonly requestIssuedCount: number;
  /** 传输层聚合：尝试过传输的题号数。 */
  readonly transportAttemptCount: number;
  /** 传输层聚合：收到字节的题号数。 */
  readonly receivedByteCallCount: number;
  /** 传输层聚合：重试次数（不含首次）。 */
  readonly retryCount: number;
  /** 传输层聚合：安全 HTTP 状态分类计数（键为 "4xx"/"5xx"/"unknown"，值为题号数）。 */
  readonly httpStatusClassCount: ReadonlyMap<string, number>;
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

  // 传输层聚合计数器
  let requestIssuedCount = 0;
  let transportAttemptCount = 0;
  let receivedByteCallCount = 0;
  let retryCount = 0;
  const httpStatusClassCount = new Map<string, number>();

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
        disposition: null,
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

  // 进度聚合：completed=已终态；retryWaiting=正在退避等待。
  let completed = results.size;
  let inFlight = 0;
  let retryWaiting = 0;
  const emitProgress = (): void => {
    if (options.onProgress === undefined) return;
    let terminalFailed = 0;
    let settled = 0;
    for (const verdict of results.values()) {
      if (verdict === "ERROR") terminalFailed += 1;
      else settled += 1;
    }
    options.onProgress({
      total: ids.length,
      completed,
      inFlight,
      retryWaiting,
      terminalFailed,
      settled,
      notStarted: ids.length - completed - inFlight,
    });
  };
  const onRetryWait = (waiting: boolean): void => {
    retryWaiting += waiting ? 1 : -1;
    if (waiting) retryCount += 1;
    emitProgress();
  };
  emitProgress();

  const active: Promise<void>[] = [];
  let cursor = 0;
  const pump = async (): Promise<void> => {
    for (;;) {
      const next = cursor;
      cursor += 1;
      const queued = queue[next];
      if (queued === undefined) return;
      inFlight += 1;
      emitProgress();
      try {
        await runOneQueuedItem(
          queued.item,
          reviewer,
          store,
          {
            maximumAttempts,
            secondReviewEnabled,
            retryBaseDelayMs: options.retryDelayMs ?? 3_000,
            sleep,
            jitter,
            onRetryWait,
          },
          results,
          {
            onRequestIssued: () => { requestIssuedCount += 1; },
            onTransportAttempted: () => { transportAttemptCount += 1; },
            onReceivedBytes: () => { receivedByteCallCount += 1; },
            onHttpStatusClass: (cls: string) => {
              httpStatusClassCount.set(cls, (httpStatusClassCount.get(cls) ?? 0) + 1);
            },
          },
        );
      } finally {
        inFlight -= 1;
        completed += 1;
        emitProgress();
      }
      if (results.size >= ids.length) return;
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
    requestIssuedCount,
    transportAttemptCount,
    receivedByteCallCount,
    retryCount,
    httpStatusClassCount,
  };
}

function clampConcurrency(value: number): number {
  if (!Number.isInteger(value) || value < qaCoreMinimumConcurrency ||
      value > qaCoreMaximumConcurrency) {
    throw new HistoryMigrationError("INVALID_ARGUMENTS", "QA 并发数必须在 1..20 之间。");
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
    readonly onRetryWait: (waiting: boolean) => void;
  },
  results: Map<number, QaVerdict>,
  transport: {
    readonly onRequestIssued: () => void;
    readonly onTransportAttempted: () => void;
    readonly onReceivedBytes: () => void;
    readonly onHttpStatusClass: (cls: string) => void;
  },
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
      disposition: null,
    };
  }
  if (state.verdict !== null) {
    results.set(item.id, state.verdict);
    return;
  }

  const deterministic = runQaDeterministicChecks(item);
  state = { ...state, deterministicErrors: deterministic.errors, deterministicRisks: deterministic.risks };
  if (deterministic.errors.length > 0) {
    state = { ...state, verdict: "ERROR" };
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

  transport.onRequestIssued();
  transport.onTransportAttempted();

  // 有确定性风险（如 possible-fabricated-solution、attachment-refs-dropped）
  // 时不再短路：把风险标记随请求交给语义复评，得到结构化处置后记账。
  const reviewRequest = buildReviewRequest(item, false, deterministic.risks);
  try {
    const primary = await reviewWithRetries(reviewer, reviewRequest, item.id, options, "primary");
    transport.onReceivedBytes();
    state = {
      ...state,
      attemptCount: state.attemptCount + 1,
      verdict: primary.verdict,
      disposition: primary.disposition ?? null,
      requestIssued: true,
      transportAttempted: true,
      receivedBytes: true,
      retryClassification: "not-attempted",
    };
    if (state.verdict === "ANOMALY" && options.secondReviewEnabled) {
      const second = await reviewWithRetries(reviewer, buildReviewRequest(item, true, deterministic.risks), item.id, options, "second");
      state = {
        ...state,
        verdict: second.verdict,
        disposition: second.disposition ?? state.disposition,
        secondReviewCount: state.secondReviewCount + 1,
      };
    }
    await store.write(state);
    results.set(item.id, state.verdict as QaVerdict);
  } catch (error) {
    // 只有非重试型传输失败才持久化终态 ERROR 并写入传输层记账，不拒绝整个门。
    // 语义/校验失败（schema 等）和可重试耗尽（http_429 等）仍向上抛出以保持既有契约。
    if (!isQaRetryableFailure(error) && error instanceof HistoryNormalizationError) {
      const failureKind = error.failureKind;
      // 语义/校验类失败不在此处理；仍向上抛出。
      const semanticKinds = new Set(["schema", "invalid_json", "source_validation", "candidate_validation", "internal", "response_too_large"]);
      if (semanticKinds.has(failureKind)) throw error;
      const httpStatusClass = error.httpStatusClass ?? (failureKind === "http_status" ? "unknown" : "unknown");
      transport.onHttpStatusClass(httpStatusClass);
      state = {
        ...state,
        verdict: "ERROR",
        attemptCount: state.attemptCount + 1,
        requestIssued: true,
        transportAttempted: true,
        receivedBytes: false,
        retryClassification: "non-retryable",
        httpStatusClass,
      };
      await store.write(state);
      results.set(item.id, "ERROR");
      return;
    }
    throw error;
  }
}

function buildReviewRequest(
  item: QaItem,
  secondAttempt: boolean,
  deterministicRisks?: readonly string[],
): QaReviewRequest {
  return {
    id: item.id,
    sourceText: item.sourceText,
    sourceSha256: item.sourceSha256,
    candidateText: item.candidateText as string,
    secondAttempt,
    ...(deterministicRisks !== undefined && deterministicRisks.length > 0
      ? { deterministicRisks }
      : {}),
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
    readonly onRetryWait?: (waiting: boolean) => void;
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
      options.onRetryWait?.(true);
      try {
        await options.sleep(delay);
      } finally {
        options.onRetryWait?.(false);
      }
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
  // 兼容旧版状态文件（无 disposition 字段）：一律视为 null。
  let disposition: QaDisposition | null = null;
  const dispositionField = record.disposition;
  if (dispositionField !== undefined && dispositionField !== null &&
      dispositionField !== "corrected" &&
      dispositionField !== "verified-false-positive" &&
      dispositionField !== "genuinely-unresolved-preserved-missing") {
    return { ok: false };
  }
  if (typeof dispositionField === "string") {
    disposition = dispositionField as QaDisposition;
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
      disposition,
      ...(typeof record.requestIssued === "boolean" ? { requestIssued: record.requestIssued } : {}),
      ...(typeof record.transportAttempted === "boolean" ? { transportAttempted: record.transportAttempted } : {}),
      ...(typeof record.receivedBytes === "boolean" ? { receivedBytes: record.receivedBytes } : {}),
      ...(record.retryClassification === "retryable" || record.retryClassification === "non-retryable" || record.retryClassification === "not-attempted"
        ? { retryClassification: record.retryClassification } : {}),
      ...(typeof record.httpStatusClass === "string" ? { httpStatusClass: record.httpStatusClass } : {}),
    },
  };
}
