import { readFile } from "node:fs/promises";
import { runQaGate, type QaItem, qaCliConcurrencyMinimum } from "../src/history-migration/qa-gate";
import { createDeepSeekReviewClient } from "../src/history-migration/qa-review-client";

export {
  runQaGate,
  runQaDeterministicChecks,
  createFileQaStateStore,
  isQaRetryableFailure,
  attachmentRefsLostFromSource,
  sourceHasSolutionMarker,
  collectMarkdownRefs,
  qaStateFileName,
  qaCliConcurrencyMinimum,
} from "../src/history-migration/qa-gate";
export type {
  QaItem,
  QaVerdict,
  QaReviewer,
  QaReviewRequest,
  QaReviewResult,
  QaPersistedState,
  QaStateStore,
  RunQaGateOptions,
  RunQaGateResult,
} from "../src/history-migration/qa-gate";
export { createDeepSeekReviewClient } from "../src/history-migration/qa-review-client";
export type {
  DeepSeekReviewClientOptions,
} from "../src/history-migration/qa-review-client";

const qaCliMaximum = 16;

interface CliItemManifestEntry {
  readonly id: number;
  readonly source: string;
  readonly sourceSha256: string;
  readonly candidate: string | null;
  readonly expectedSourceId: string;
  readonly sourceMappingSha256: string;
}

interface CliItemManifest {
  readonly version: 1;
  readonly items: readonly CliItemManifestEntry[];
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main(process.argv.slice(2), process.env).then(
    (code) => {
      process.exitCode = code;
    },
    (error) => {
      console.error(error);
      process.exitCode = 70;
    },
  );
}

async function main(argv: readonly string[], env: NodeJS.ProcessEnv): Promise<number> {
  const outcome = await runCliGate({
    manifestPath: readArg(argv, "--items-manifest"),
    requestedConcurrency: Number(readArg(argv, "--concurrency", String(qaCliConcurrencyMinimum))),
    stateDirectory: readArg(argv, "--state", "state"),
    env,
  });
  console.log(
    `QA 汇总：共 ${outcome.total} 题，PASS ${outcome.pass}，ANOMALY ${outcome.anomaly}，ERROR ${outcome.error}。`,
  );
  if (!outcome.ok) {
    console.error("QA 门失败：仍有 ERROR 状态题号，不允许继续。");
    return 1;
  }
  return 0;
}

async function runCliGate(options: {
  readonly manifestPath: string;
  readonly requestedConcurrency: number;
  readonly stateDirectory: string;
  readonly env: NodeJS.ProcessEnv;
}): Promise<{ readonly total: number; readonly pass: number; readonly anomaly: number; readonly error: number; readonly ok: boolean }> {
  const concurrency = sanitizeConcurrency(options.requestedConcurrency);
  const manifest = await readItemsManifestConfig(options.manifestPath);
  const store = await createFileQaStateStore(options.stateDirectory);
  const reviewer = createDeepSeekReviewClient({
    baseUrl: requireEnv(options.env, "AETHER_BASE_URL"),
    apiKey: requireEnv(options.env, "AETHER_API_KEY"),
    model: options.env["MIGRATE_MODEL"] ?? "deepseek-v4-flash",
  });
  const items: QaItem[] = manifest.items.map((entry) => ({
    id: entry.id,
    sourceText: entry.source,
    sourceSha256: entry.sourceSha256,
    candidateText: entry.candidate,
    expectedSourceId: entry.expectedSourceId,
    sourceMappingSha256: entry.sourceMappingSha256,
  }));
  const result = await runQaGate(items, reviewer, store, { concurrency });
  return {
    ok: result.error === 0,
    total: result.total,
    pass: result.pass,
    anomaly: result.anomaly,
    error: result.error,
  };
}

function requireEnv(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name];
  if (value === undefined || value.length === 0) {
    throw new TypeError(`缺少环境变量 ${name}。`);
  }
  return value;
}

function sanitizeConcurrency(value: number): number {
  if (!Number.isInteger(value) || value < qaCliConcurrencyMinimum || value > qaCliMaximum) {
    throw new TypeError(`--concurrency 必须在 ${qaCliConcurrencyMinimum}..${qaCliMaximum} 之间。`);
  }
  return value;
}

async function readItemsManifestConfig(pathValue: string): Promise<CliItemManifest> {
  const content = await readFile(pathValue, "utf8");
  const parsed = JSON.parse(content) as CliItemManifest;
  if (parsed.version !== 1 || !Array.isArray(parsed.items)) {
    throw new TypeError("--items-manifest 必须是 version 1 的对象并提供 items 数组。");
  }
  for (const entry of parsed.items) {
    if (typeof entry.id !== "number" ||
        typeof entry.source !== "string" ||
        typeof entry.expectedSourceId !== "string" ||
        typeof entry.sourceMappingSha256 !== "string" ||
        (entry.candidate !== null && typeof entry.candidate !== "string")) {
      throw new TypeError("--items-manifest 条目字段类型不正确。");
    }
  }
  return parsed;
}

function readArg(argv: readonly string[], name: string, fallback?: string): string {
  const index = argv.indexOf(name);
  if (index >= 0 && argv.length > index + 1) {
    return (argv[index + 1] as string);
  }
  if (fallback !== undefined) return fallback;
  throw new TypeError(`缺少参数 ${name}。`);
}
