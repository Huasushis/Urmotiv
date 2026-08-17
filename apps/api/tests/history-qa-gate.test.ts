import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import { beforeEach, describe, expect, it } from "vitest";
import { sha256Hex, candidateContentDigest } from "../src/history-migration/digests";
import {
  runQaGate,
  createFileQaStateStore,
  qaStateFileName,
  runQaDeterministicChecks,
  collectMarkdownRefs,
  sourceHasSolutionMarker,
  type QaItem,
  type QaReviewer,
  type QaReviewRequest,
  type QaReviewResult,
  type QaPersistedState,
  type QaStateStore,
} from "../src/history-migration/qa-gate";
import { HistoryNormalizationError } from "../src/history-migration/errors";

const sourceMappingHex = sha256Hex("synthetic-mapping");

function sourceIdFor(id: number): string {
  return `source-${String(id).padStart(6, "0")}`;
}

function sourceTextFor(id: number): string {
  return `# 题目 ${id}\n这是第 ${id} 题的原始材料，不含题解小节。`;
}

function sourceTextWithSolution(id: number): string {
  return `# 题目 ${id}\n原文带有题解小节。\n## 参考程序\nint main() { return 0; }`;
}

function sourceTextWithAttachmentRef(id: number): string {
  return `# 题目 ${id}\n附件 ![图样](pic.png) 与 [说明](doc.txt)。`;
}

function makeCandidateForSource(allText: string, id: number, fields?: {
  readonly solution?: string;
  readonly statement?: string;
  readonly basicStatement?: string;
  readonly sourceId?: string;
}): string {
  const sourceId = fields?.sourceId ?? sourceIdFor(id);
  const sourceDigest = sha256Hex(allText);
  const baseContent = {
    basicStatement: fields?.basicStatement ?? allText,
    basicSolution: null,
    background: "",
    statement: fields?.statement ?? "",
    inputFormat: "",
    outputFormat: "",
    constraints: "",
    solution: fields?.solution ?? "",
    hints: "",
  };
  const problem = {
    title: `题目 ${id}`,
    type: "traditional" as const,
    tags: [] as string[],
    difficulty: {},
    content: baseContent,
    samples: [] as never[],
    files: [],
    extensions: {},
  };
  const contentSha256 = candidateContentDigest({
    sourceId,
    sourceContentSha256: sourceDigest,
    sourceMappingSha256: sourceMappingHex,
    modelConfidence: 0.98,
    normalizationNote: "合成测试候选。",
    problem,
  });
  const record = {
    version: 1,
    candidateId: `candidate-${String(id).padStart(6, "0")}`,
    sourceId,
    sourceContentSha256: sourceDigest,
    sourceMappingSha256: sourceMappingHex,
    contentSha256,
    modelConfidence: 0.98,
    normalizationNote: "合成测试候选。",
    problem,
  };
  return JSON.stringify(record);
}

function makeCandidate(id: number): string {
  return makeCandidateForSource(sourceTextFor(id), id);
}

function makeItem(id: number, candidate: string | null): QaItem {
  return makeItemForSource(id, sourceTextFor(id), candidate);
}

function makeItemForSource(id: number, allText: string, candidate: string | null): QaItem {
  return {
    id,
    sourceText: allText,
    sourceSha256: sha256Hex(allText),
    candidateText: candidate,
    expectedSourceId: sourceIdFor(id),
    sourceMappingSha256: sourceMappingHex,
  };
}

function memoryStore(seed: readonly QaPersistedState[] = []): QaStateStore {
  const map = new Map<number, QaPersistedState>(
    seed.map((state) => [state.id, state] as const),
  );
  return {
    async read(id: number): Promise<QaPersistedState | null> {
      return map.get(id) ?? null;
    },
    async write(state: QaPersistedState): Promise<void> {
      map.set(state.id, state);
    },
  };
}

function createReviewerSpy(
  respond: (request: QaReviewRequest) => QaReviewResult | Promise<QaReviewResult>,
): { readonly reviewer: QaReviewer; readonly calls: QaReviewRequest[]; readonly maxConcurrent: number } {
  const calls: QaReviewRequest[] = [];
  let inFlight = 0;
  let maxInFlight = 0;
  const reviewer: QaReviewer = async (request) => {
    inFlight += 1;
    maxInFlight = Math.max(maxInFlight, inFlight);
    calls.push(request);
    try {
      return await respond(request);
    } finally {
      inFlight -= 1;
    }
  };
  return { reviewer, calls, maxConcurrent: maxInFlight };
}

function resultFor(
  verdict: "PASS" | "ANOMALY" | "ERROR",
  reason = "评审结论。",
): QaReviewResult {
  return { verdict, reasons: [reason] };
}

const noopSleep = async (): Promise<void> => {};
const zeroJitter = (): number => 0;

// 每个用例都注入 sleep/jitter，避免真实时钟。
const fastOptions = {
  concurrency: 4,
  maximumAttempts: 3,
  retryBaseDelayMs: 10,
  sleep: noopSleep,
  jitter: zeroJitter,
} as const;

/** 无真实时钟的屏障：release 前所有并发调用停在 gate 上。 */
function createTurnstile(): {
  readonly reviewer: QaReviewer;
  readonly release: () => void;
  readonly inFlight: () => number;
  readonly calls: () => number;
} {
  let resolveGate: (() => void) | null = null;
  const gate = new Promise<void>((resolve) => { resolveGate = resolve; });
  let inFlight = 0;
  let totalCalls = 0;
  const callCount = (): number => totalCalls;
  return {
    reviewer: async () => {
      inFlight += 1;
      totalCalls += 1;
      await gate;
      inFlight -= 1;
      return resultFor("PASS");
    },
    release: () => { resolveGate?.(); resolveGate = null; },
    inFlight: () => inFlight,
    calls: callCount,
  };
}

/** 轮询直到条件成立或达到迭代上限返回 false；无真实时钟。 */
async function eventually(condition: () => boolean, iterations = 1_000): Promise<boolean> {
  for (let index = 0; index < iterations; index += 1) {
    if (condition()) return true;
    await Promise.resolve();
  }
  return condition();
}

describe("runQaDeterministicChecks 确定性机械检查", () => {
  it("候选缺失返回 missing-candidate", () => {
    expect(runQaDeterministicChecks(makeItem(1, null)).errors).toContain("missing-candidate");
  });

  it("源文本摘要不一致返回 source-text-digest-mismatch", () => {
    const item = makeItem(1, makeCandidate(1));
    const checks = runQaDeterministicChecks({ ...item, sourceSha256: sha256Hex("其他文本") });
    expect(checks.errors).toContain("source-text-digest-mismatch");
  });

  it("候选 JSON 损坏返回 candidate-invalid-json", () => {
    expect(runQaDeterministicChecks(makeItem(1, "{ not json")).errors).toContain("candidate-invalid-json");
  });

  it("候选 schema 不符返回 candidate-schema-invalid", () => {
    expect(runQaDeterministicChecks(makeItem(1, JSON.stringify({ version: 1 }))).errors)
      .toContain("candidate-schema-invalid");
  });

  it("题解标志识别正确", () => {
    expect(sourceHasSolutionMarker("# 参考程序")).toBe(true);
    expect(sourceHasSolutionMarker("# 题解")).toBe(true);
    expect(sourceHasSolutionMarker("无题解内容")).toBe(false);
    expect(sourceHasSolutionMarker("std.cpp 见附件")).toBe(true);
  });

  it("原文附件引用全文保留时不告警；候选缺引用时告警", () => {
    const source = sourceTextWithAttachmentRef(5);
    const refs = collectMarkdownRefs(source);
    expect(refs.size).toBe(2);
    const candidateWithRefs = makeCandidateForSource(source, 5, {
      statement: "![图样](pic.png) 与 [说明](doc.txt)。",
    });
    const kept = runQaDeterministicChecks(makeItemForSource(5, source, candidateWithRefs));
    expect(kept.risks).not.toContain("attachment-refs-dropped");

    const candidateMissingRefs = makeCandidateForSource(source, 5, {
      basicStatement: "题面未保留附件。",
      statement: "附件未保留。",
    });
    const dropped = runQaDeterministicChecks(makeItemForSource(5, source, candidateMissingRefs));
    expect(dropped.risks).toContain("attachment-refs-dropped");
  });

  it("源题解小节存在但候选题解为空 → expected-solution-missing 风险；反之 → possible-fabricated-solution 风险", () => {
    const withSolution = sourceTextWithSolution(9);
    const missing = runQaDeterministicChecks(
      makeItemForSource(9, withSolution, makeCandidateForSource(withSolution, 9)),
    );
    expect(missing.risks).toContain("expected-solution-missing");

    const plain = sourceTextFor(9);
    const fabricated = runQaDeterministicChecks(
      makeItemForSource(9, plain, makeCandidateForSource(plain, 9, { solution: "完整伪解题解" })),
    );
    expect(fabricated.risks).toContain("possible-fabricated-solution");
  });
});

describe("runQaGate 有界并发与重试", () => {
  it("并发上限生效：同刻 in-flight 不超过配置值", async () => {
    const items = Array.from({ length: 12 }, (_, index) => makeItem(index + 1, makeCandidate(index + 1)));
    const turnstile = createTurnstile();
    const gatePromise = runQaGate(items, turnstile.reviewer, memoryStore(), fastOptions);
    const reached = await eventually(() => turnstile.calls() >= 4);
    expect(reached).toBe(true);
    expect(turnstile.inFlight()).toBeLessThanOrEqual(4);
    turnstile.release();
    const result = await gatePromise;
    expect(result.pass).toBe(12);
    expect(result.anomaly).toBe(0);
    expect(result.error).toBe(0);
    expect(result.total).toBe(12);
  });

  it("429 可重试：第 2 次成功，第三次不再调用；attempt 记账未溢出", async () => {
    const item = makeItem(3, makeCandidate(3));
    let attempts = 0;
    const spy = createReviewerSpy(() => {
      attempts += 1;
      if (attempts === 1) {
        throw new HistoryNormalizationError("http_429", "限流，稍后重试。");
      }
      return resultFor("PASS");
    });
    const store = memoryStore();
    const result = await runQaGate([item], spy.reviewer, store, {
      ...fastOptions,
      concurrency: 1,
      maximumAttempts: 3,
    });
    expect(attempts).toBe(2);
    expect(spy.calls).toHaveLength(2);
    expect(result.pass).toBe(1);
  });

  it("可重试 429 一直失败超过上限后整门失败（fail-loud，不臆造 ERROR）", async () => {
    const item = makeItem(4, makeCandidate(4));
    const spy = createReviewerSpy(() => {
      throw new HistoryNormalizationError("http_429", "限流。");
    });
    const store = memoryStore();
    await expect(
      runQaGate([item], spy.reviewer, store, {
        ...fastOptions,
        concurrency: 1,
        maximumAttempts: 2,
      }),
    ).rejects.toThrow("限流");
    expect(spy.calls).toHaveLength(2);
  });

  it("全部题号都能拿到 verdict：无跳过、无未处理", async () => {
    const items = Array.from({ length: 8 }, (_, index) => makeItem(index + 1, makeCandidate(index + 1)));
    const result = await runQaGate(items, createReviewerSpy(() => resultFor("PASS")).reviewer, memoryStore(), fastOptions);
    expect(result.total).toBe(8);
    expect(result.pass + result.anomaly + result.error).toBe(8);
    expect(new Set(result.account.map((entry) => entry.id)).size).toBe(8);
  });

  it("ANOMALY 会触发第二次评审；PASS 不触发", async () => {
    const requests: QaReviewRequest[] = [];
    const reviewer: QaReviewer = async (request) => {
      requests.push(request);
      return request.secondAttempt ? resultFor("PASS") : resultFor("ANOMALY", "需要复核。");
    };
    const result = await runQaGate([makeItem(6, makeCandidate(6))], reviewer, memoryStore(), fastOptions);
    expect(result.anomaly).toBe(0);
    expect(result.pass).toBe(1);
    const secondAttempts = requests.filter((request) => request.secondAttempt);
    const primaryAttempts = requests.filter((request) => !request.secondAttempt);
    expect(primaryAttempts).toHaveLength(1);
    expect(secondAttempts).toHaveLength(1);
    expect(secondAttempts[0]?.id).toBe(6);
  });

  it("disables second review via option", async () => {
    const spy = createReviewerSpy((request) =>
      request.secondAttempt ? resultFor("PASS") : resultFor("ANOMALY"));
    const result = await runQaGate([makeItem(11, makeCandidate(11))], spy.reviewer, memoryStore(), {
      ...fastOptions,
      secondReviewEnabled: false,
    });
    expect(result.anomaly).toBe(1);
    expect(spy.calls).toHaveLength(1);
  });

  it("恢复：已终态题号跳过评审，直接计入结果", async () => {
    const seed: QaPersistedState = {
      version: 1,
      id: 2,
      deterministicErrors: [],
      deterministicRisks: [],
      verdict: "ANOMALY",
      attemptCount: 0,
      secondReviewCount: 0,
    };
    const items = [makeItem(1, makeCandidate(1)), makeItem(2, makeCandidate(2)), makeItem(3, makeCandidate(3))];
    const spy = createReviewerSpy(() => resultFor("PASS"));
    const result = await runQaGate(items, spy.reviewer, memoryStore([seed]), fastOptions);
    expect(spy.calls.map((call) => call.id).sort((a, b) => a - b)).toEqual([1, 3]);
    expect(result.account.map((entry) => [entry.id, entry.verdict as string])).toEqual([
      [1, "PASS"],
      [2, "ANOMALY"],
      [3, "PASS"],
    ]);
    expect(result.pass).toBe(2);
    expect(result.anomaly).toBe(1);
  });
});

describe("createFileQaStateStore 文件后端", () => {
  let directory: string;
  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "history-qa-gate-"));
  });
  it("写读往返并保护为 0600", async () => {
    const store = await createFileQaStateStore(directory);
    const state: QaPersistedState = {
      version: 1,
      id: 17,
      deterministicErrors: [],
      deterministicRisks: [],
      verdict: "PASS",
      attemptCount: 0,
      secondReviewCount: 0,
    };
    await store.write(state);
    expect(await store.read(17)).toEqual(state);
    const info = await stat(join(directory, qaStateFileName(17)));
    expect(info.mode & 0o777).toBe(0o600);
  });

  it("损坏状态文件报错而不是静默失败", async () => {
    const store = await createFileQaStateStore(directory);
    await writeFile(join(directory, qaStateFileName(1)), "坏 JSON", "utf8");
    await expect(store.read(1)).rejects.toThrow("状态文件损坏");
  });

  it("从文件恢复：二次运行跳过已终态题号", async () => {
    const fileStore = await createFileQaStateStore(directory);
    const firstState: QaPersistedState = {
      version: 1,
      id: 5,
      deterministicErrors: [],
      deterministicRisks: [],
      verdict: "ERROR",
      attemptCount: 0,
      secondReviewCount: 0,
    };
    await fileStore.write(firstState);
    await expect(readFile(join(directory, qaStateFileName(5)), "utf8")).resolves.toContain("ERROR");
    await rm(join(directory, qaStateFileName(5)));
    await expect(fileStore.read(5)).resolves.toBeNull();
  });
});
