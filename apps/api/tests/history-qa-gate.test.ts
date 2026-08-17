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
import {
  createDeepSeekReviewClient,
  qaReviewThinkingBudgetTokens,
} from "../src/history-migration/qa-review-client";

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
      disposition: null,
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

describe("runQaGate 风险标记项处置与防臆造", () => {
  /** 构造带 possible-fabricated-solution 风险的题号项。 */
  function makeFabricatedRiskItem(id: number): QaItem {
    const source = sourceTextFor(id);
    return makeItemForSource(id, source, makeCandidateForSource(source, id, { solution: "候选臆造的题解" }));
  }

  it("风险标记项不再短路：请求携带 deterministicRisks，处置写入终态", async () => {
    const requests: QaReviewRequest[] = [];
    const reviewer: QaReviewer = async (request) => {
      requests.push(request);
      return { verdict: "PASS", reasons: ["人工式核对后确认误报。"], disposition: "verified-false-positive" };
    };
    const item = makeFabricatedRiskItem(21);
    const store = memoryStore();
    const result = await runQaGate([item], reviewer, store, fastOptions);
    expect(result.error).toBe(0);
    expect(result.account.map((entry) => entry.verdict)).toEqual(["PASS"]);
    expect(requests).toHaveLength(1);
    expect(requests[0]?.deterministicRisks).toContain("possible-fabricated-solution");
    const persisted = await store.read(21);
    expect(persisted?.verdict).toBe("PASS");
    expect(persisted?.disposition).toBe("verified-false-positive");
  });

  it("二次评审保留主评审处置：secondary 未给处置时不抹掉", async () => {
    const reviewer: QaReviewer = async (request) => {
      if (request.secondAttempt) {
        return { verdict: "ANOMALY", reasons: ["复核仍异常。"] };
      }
      return { verdict: "ANOMALY", reasons: ["主评审异常。"], disposition: "corrected" };
    };
    const store = memoryStore();
    const result = await runQaGate([makeFabricatedRiskItem(22)], reviewer, store, fastOptions);
    expect(result.anomaly).toBe(1);
    const persisted = await store.read(22);
    expect(persisted?.disposition).toBe("corrected");
    expect(persisted?.secondReviewCount).toBe(1);
  });

  it("二次评审提供了处置时覆盖主评审处置", async () => {
    const reviewer: QaReviewer = async (request) => {
      if (request.secondAttempt) {
        return { verdict: "ANOMALY", reasons: ["复核确认缺失。"], disposition: "genuinely-unresolved-preserved-missing" };
      }
      return { verdict: "ANOMALY", reasons: ["主评审异常。"], disposition: "corrected" };
    };
    const store = memoryStore();
    await runQaGate([makeFabricatedRiskItem(24)], reviewer, store, fastOptions);
    const persisted = await store.read(24);
    expect(persisted?.disposition).toBe("genuinely-unresolved-preserved-missing");
  });

  it("clean 项不带 risks 也不要求处置：终态 disposition 为 null", async () => {
    const requests: QaReviewRequest[] = [];
    const reviewer: QaReviewer = async (request) => {
      requests.push(request);
      return resultFor("PASS");
    };
    const store = memoryStore();
    await runQaGate([makeItem(25, makeCandidate(25))], reviewer, store, fastOptions);
    expect(requests[0]?.deterministicRisks).toBeUndefined();
    const persisted = await store.read(25);
    expect(persisted?.verdict).toBe("PASS");
    expect(persisted?.disposition).toBeNull();
  });

  it("防臆造：QA 门只记 verdict/处置，不写候选内容；候选原文不落库", async () => {
    const candidate = makeCandidate(26);
    const store = memoryStore();
    await runQaGate([makeItem(26, candidate)], createStaticReviewer("PASS"), store, fastOptions);
    const persisted = await store.read(26);
    expect(persisted).toBeDefined();
    const keys = persisted ? Object.keys(persisted) : [];
    expect(keys).not.toContain("candidateText");
    expect(keys).not.toContain("problem");
    expect(persisted?.id).toBe(26);
  });

  it("非重试型 schema 失败不重放：只调用一次并整门失败，状态保持未终态", async () => {
    const item = makeFabricatedRiskItem(27);
    const spy = createReviewerSpy(() => {
      throw new HistoryNormalizationError("schema", "评审输出 schema 不符。");
    });
    const store = memoryStore();
    await expect(runQaGate([item], spy.reviewer, store, {
      ...fastOptions,
      concurrency: 1,
      maximumAttempts: 3,
    })).rejects.toThrow("评审输出 schema 不符");
    expect(spy.calls).toHaveLength(1);
    expect(await store.read(27)).toBeNull();
  });
});

describe("两阶段真实客户端 + 有界重试（传输注入）", () => {
  function sseChunk(payload: unknown): string {
    return `data: ${JSON.stringify(payload)}\n\n`;
  }
  function sseDelta(payload: unknown): string {
    return sseChunk({ choices: [{ delta: payload }] });
  }
  function sseDone(): string {
    return sseChunk({ choices: [] });
  }
  function streamResponse(chunks: readonly string[]): Response {
    const encoder = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
        controller.close();
      },
    });
    return new Response(body) as Response;
  }
  function transportClient(fetchImpl: (input: URL, init: RequestInit) => Promise<Response>): {
    readonly reviewer: QaReviewer;
    readonly fetchCalls: () => number;
  } {
    let calls = 0;
    const reviewer = createDeepSeekReviewClient({
      baseUrl: "https://example.test/v1/",
      apiKey: "test-key",
      model: "deepseek-v4-flash",
      fetch: async (input, init) => {
        calls += 1;
        return fetchImpl(input, init);
      },
    });
    return { reviewer, fetchCalls: () => calls };
  }

  it("零字节后重试成功：第 1 次空流，第 2 次起正常，最终 PASS 且不重复完成", async () => {
    const item = makeItem(31, makeCandidate(31));
    let fetchCount = 0;
    const { reviewer, fetchCalls } = transportClient(async (_input: URL, init: RequestInit) => {
      fetchCount += 1;
      const body = JSON.parse(init.body as string) as { readonly thinking: { readonly type: string } };
      if (fetchCount === 1 || body.thinking.type === "enabled") {
        if (fetchCount === 1) return streamResponse([]);
        return streamResponse([sseDelta({ reasoning_content: "复评推理。", content: "正文" }), sseDone()]);
      }
      return streamResponse([
        sseDelta({ content: '{"verdict":"PASS","reasons":["复评通过。"]}' }),
        sseDone(),
      ]);
    });
    const store = memoryStore();
    const result = await runQaGate([item], reviewer, store, {
      ...fastOptions,
      concurrency: 1,
      maximumAttempts: 3,
    });
    expect(result.pass).toBe(1);
    expect(result.error).toBe(0);
    expect(result.total).toBe(1);
    expect(fetchCalls()).toBe(3);
    const persisted = await store.read(31);
    expect(persisted?.verdict).toBe("PASS");
    expect(persisted?.attemptCount).toBe(1);
  });

  it("零字节持续失败：到达尝试上限后整门失败，不重复记账", async () => {
    const item = makeItem(32, makeCandidate(32));
    const { reviewer, fetchCalls } = transportClient(async () => streamResponse([]));
    const store = memoryStore();
    await expect(
      runQaGate([item], reviewer, store, { ...fastOptions, concurrency: 1, maximumAttempts: 3 }),
    ).rejects.toMatchObject({ failureKind: "connection" });
    expect(fetchCalls()).toBe(3);
    expect(await store.read(32)).toBeNull();
  });

  it("部分字节失败只尝试一次：阶段一有字节后阶段二输出非法，不重放", async () => {
    const item = makeItem(33, makeCandidate(33));
    let stage1Calls = 0;
    const { reviewer, fetchCalls } = transportClient(async (_input: URL, init: RequestInit) => {
      if (JSON.parse(init.body as string).thinking.type === "enabled") {
        stage1Calls += 1;
        return streamResponse([sseDelta({ reasoning_content: "部分推理。" }), sseDone()]);
      }
      return streamResponse([sseDelta({ content: "{not json" }), sseDone()]);
    });
    const store = memoryStore();
    await expect(
      runQaGate([item], reviewer, store, { ...fastOptions, concurrency: 1, maximumAttempts: 3 }),
    ).rejects.toMatchObject({ failureKind: "invalid_json" });
    expect(stage1Calls).toBe(1);
    expect(fetchCalls()).toBe(2);
    expect(await store.read(33)).toBeNull();
  });

  it("429 到达尝试上限后整门失败，每次评审只记一次完成", async () => {
    const item = makeItem(34, makeCandidate(34));
    const { reviewer, fetchCalls } = transportClient(async (_input: URL, _init: RequestInit) =>
      new Response("", { status: 429 }) as Response,
    );
    const store = memoryStore();
    await expect(
      runQaGate([item], reviewer, store, { ...fastOptions, concurrency: 1, maximumAttempts: 3 }),
    ).rejects.toMatchObject({ failureKind: "http_429" });
    expect(fetchCalls()).toBe(3);
    expect(await store.read(34)).toBeNull();
  });

  it("不泄露原始响应：persisted state 与结果只含结构化字段", async () => {
    const candidate = makeCandidate(35);
    const item = makeItem(35, candidate);
    const { reviewer } = transportClient(async (_input: URL, init: RequestInit) => {
      const body = JSON.parse(init.body as string) as { readonly thinking: { readonly type: string } };
      if (body.thinking.type === "enabled") {
        return streamResponse([sseDelta({ reasoning_content: "评审推理与原始材料。", content: candidate }),
          sseDone()]);
      }
      return streamResponse([
        sseDelta({ content: '{"verdict":"PASS","disposition":"verified-false-positive","reasons":["复评通过。"]}' }),
        sseDone(),
      ]);
    });
    const store = memoryStore();
    await runQaGate([item], reviewer, store, { ...fastOptions, concurrency: 1 });
    const persisted = await store.read(35);
    expect(persisted?.verdict).toBe("PASS");
    expect(persisted?.disposition).toBe("verified-false-positive");
    for (const key of ["sourceText", "candidateText", "problem", "content"]) {
      expect(JSON.stringify(persisted)).not.toContain(`"${key}":`);
    }
    expect(JSON.stringify(persisted)).not.toContain("评审推理与原始材料");
  });

  it("阶段一请求保持最大推理序列化形态（thinking 启用、含预算、无 response_format）", async () => {
    const item = makeItem(36, makeCandidate(36));
    const stageOneBodies: Record<string, unknown>[] = [];
    const { reviewer } = transportClient(async (_input: URL, init: RequestInit) => {
      const body = JSON.parse(init.body as string) as Record<string, unknown>;
      if ((body.thinking as { readonly type: string }).type === "enabled") {
        stageOneBodies.push(body);
        return streamResponse([sseDelta({ reasoning_content: "推理", content: "正文" }), sseDone()]);
      }
      return streamResponse([sseDelta({ content: '{"verdict":"PASS","reasons":["通过。"]}' }), sseDone()]);
    });
    await runQaGate([item], reviewer, memoryStore(), { ...fastOptions, concurrency: 1 });
    expect(stageOneBodies).toHaveLength(1);
    expect(stageOneBodies[0]?.response_format).toBeUndefined();
    expect(stageOneBodies[0]?.thinking).toEqual({ type: "enabled", budget_tokens: qaReviewThinkingBudgetTokens });
  });
});

function createStaticReviewer(verdict: "PASS" | "ANOMALY" | "ERROR"): QaReviewer {
  return async () => resultFor(verdict);
}

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
      disposition: null,
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
      disposition: null,
    };
    await fileStore.write(firstState);
    await expect(readFile(join(directory, qaStateFileName(5)), "utf8")).resolves.toContain("ERROR");
    await rm(join(directory, qaStateFileName(5)));
    await expect(fileStore.read(5)).resolves.toBeNull();
  });
});
