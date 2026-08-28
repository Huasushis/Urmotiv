import { createHash, randomBytes, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { createConnection } from "node:net";
import { AnklangClient } from "../src/index.ts";

const port = 8730;
const host = "127.0.0.1";
const token = randomBytes(24).toString("base64url");
const externalId = "synthetic-e2e-problem";
const basicStatement = "Find the synthetic shortest path.";
const normalizedStatement = basicStatement.replace(/\r\n?/gu, "\n").trim();
const contentHash = createHash("sha256").update(normalizedStatement, "utf8").digest("hex");

function assert(condition: unknown, status: string): asserts condition {
  if (!condition) {
    throw new Error(status);
  }
}

function checkPort(): Promise<boolean> {
  const { promise, resolve } = Promise.withResolvers<boolean>();
  const socket = createConnection({ host, port });
  const finish = (occupied: boolean): void => {
    socket.destroy();
    resolve(occupied);
  };
  socket.once("connect", () => finish(true));
  socket.once("error", (error: NodeJS.ErrnoException) => {
    finish(error.code === "ECONNREFUSED" ? false : true);
  });
  return promise;
}

function waitForPort(child: ChildProcess): Promise<void> {
  const { promise, resolve, reject } = Promise.withResolvers<void>();
  const deadline = Date.now() + 30_000;
  const probe = (): void => {
    if (child.exitCode !== null || child.signalCode !== null) {
      reject(new Error("anklang_source_exited"));
      return;
    }
    const socket = createConnection({ host, port });
    socket.once("connect", () => {
      socket.destroy();
      resolve();
    });
    socket.once("error", () => {
      socket.destroy();
      if (Date.now() >= deadline) {
        reject(new Error("anklang_source_not_ready"));
      } else {
        setTimeout(probe, 100);
      }
    });
  };
  probe();
  return promise;
}

function sourceDirectory(): string {
  const separator = process.argv.indexOf("--");
  const commandArgs =
    separator < 0 ? process.argv.slice(2) : process.argv.slice(separator + 1);
  const sourceFlag = commandArgs.indexOf("--source-dir");
  const fromFlag = sourceFlag < 0 ? undefined : commandArgs[sourceFlag + 1];
  const value = fromFlag ?? process.env.ANKLANG_SOURCE_DIR;
  assert(value !== undefined && value.length > 0, "missing_source_dir");
  return resolve(value);
}

async function delay(milliseconds: number): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, milliseconds);
  await promise;
}

function childTermination(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve();
  }
  const { promise, resolve } = Promise.withResolvers<void>();
  child.once("close", () => resolve());
  child.once("error", () => resolve());
  return promise;
}

async function closeChild(child: ChildProcess | undefined): Promise<void> {
  if (child === undefined || child.exitCode !== null || child.signalCode !== null) {
    return;
  }
  const terminated = childTermination(child);
  child.kill("SIGTERM");
  await Promise.race([terminated, delay(2_000)]);
  if (child.exitCode === null && child.signalCode === null) {
    child.kill("SIGKILL");
    await terminated;
  }
}

function embeddingResponseBody(requestBody: string): string {
  try {
    const parsed = JSON.parse(requestBody) as { input?: unknown };
    const count = Array.isArray(parsed.input) ? parsed.input.length : 1;
    return JSON.stringify({
      object: "list",
      data: Array.from({ length: Math.max(1, Math.min(count, 32)) }, (_, index) => ({
        object: "embedding",
        index,
        embedding: [0.25, 0.5, 0.75]
      })),
      model: "synthetic-embedding",
      usage: { prompt_tokens: 1, total_tokens: 1 }
    });
  } catch {
    return JSON.stringify({ error: { message: "synthetic_embedding_request" } });
  }
}

const steps: Record<string, string> = {};
let source: ChildProcess | undefined;
let embedding: ReturnType<typeof createServer> | undefined;
let tempDir: string | undefined;

try {
  assert(!(await checkPort()), "port_8730_occupied");
  const sourceDir = sourceDirectory();
  tempDir = await mkdtemp(join(tmpdir(), "urmotiv-anklang-e2e-"));
  embedding = createServer((request, response) => {
    if (request.method !== "POST" || request.url !== "/v1/embeddings") {
      request.resume();
      response.statusCode = 404;
      response.end();
      return;
    }
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk: string) => {
      body += chunk;
    });
    request.on("end", () => {
      response.statusCode = 200;
      response.setHeader("Content-Type", "application/json");
      response.end(embeddingResponseBody(body));
    });
  });
  const { promise: embeddingReady, resolve: resolveEmbedding, reject: rejectEmbedding } =
    Promise.withResolvers<void>();
  embedding.once("error", rejectEmbedding);
  embedding.listen(0, host, () => resolveEmbedding());
  await embeddingReady;
  const embeddingAddress = embedding.address();
  assert(typeof embeddingAddress === "object" && embeddingAddress !== null, "embedding_not_ready");
  const embeddingBaseUrl = `http://${host}:${embeddingAddress.port}/v1`;

  source = spawn("python3", ["-m", "ui.server"], {
    cwd: sourceDir,
    stdio: ["ignore", "ignore", "ignore"],
    env: {
      ...process.env,
      ANKLANG_BIND_HOST: host,
      ANKLANG_PORT: String(port),
      ANKLANG_LOCAL_DB_PATH: join(tempDir, "anklang.sqlite"),
      ANKLANG_REQUIRE_SERVICE_TOKEN: "true",
      ANKLANG_SERVICE_TOKEN: token,
      DASHSCOPE_BASE_URL: embeddingBaseUrl,
      DASHSCOPE_API_KEY: "synthetic-dashscope-key",
      DASHSCOPE_EMBEDDING_MODEL: "synthetic-embedding",
      DASHSCOPE_EMBEDDING_DIM: "3",
      HTTP_PROXY: "",
      HTTPS_PROXY: "",
      ALL_PROXY: "",
      http_proxy: "",
      https_proxy: "",
      all_proxy: "",
      NO_PROXY: `${host},localhost`,
      no_proxy: `${host},localhost`
    }
  });
  await waitForPort(source);
  steps.source = "ready";

  const client = new AnklangClient({
    baseUrl: `http://${host}:${port}`,
    privateContentAuthorized: true,
    token,
    retryAttempts: 2,
    timeoutMs: 10_000,
    indexTimeoutMs: 10_000
  });
  const firstRequest = {
    apiVersion: "1" as const,
    requestId: randomUUID(),
    externalId,
    updatedAt: "2026-08-28T00:00:00.000Z",
    problem: { title: "Synthetic original", basicStatement }
  };
  const inserted = await client.upsert(firstRequest);
  assert(inserted.outcome === "inserted", "upsert_insert_failed");
  steps.insert = inserted.outcome;
  const replayed = await client.upsert(firstRequest);
  assert(replayed.outcome === "unchanged", "upsert_replay_failed");
  steps.replay = replayed.outcome;
  const renamed = await client.upsert({
    ...firstRequest,
    requestId: randomUUID(),
    updatedAt: "2026-08-28T00:01:00.000Z",
    problem: { ...firstRequest.problem, title: "Synthetic renamed original" }
  });
  assert(renamed.outcome === "updated", "upsert_title_update_failed");
  steps.titleUpdate = renamed.outcome;

  const result = await client.check({
    apiVersion: "2",
    requestId: randomUUID(),
    contentHash,
    problem: {
      title: "Synthetic renamed original",
      type: "traditional",
      tagIds: ["synthetic"],
      basicStatement
    }
  }, new AbortController().signal);
  assert(result.candidates.some((candidate) => candidate.externalId === externalId), "query_hit_missing");
  steps.query = "hit";
  console.log(JSON.stringify({ status: "passed", steps }));
} catch (error) {
  const known: Record<string, true> = {
    port_8730_occupied: true,
    missing_source_dir: true,
    anklang_source_exited: true,
    anklang_source_not_ready: true,
    embedding_not_ready: true,
    upsert_insert_failed: true,
    upsert_replay_failed: true,
    upsert_title_update_failed: true,
    query_hit_missing: true
  };
  const reason =
    error instanceof Error && known[error.message] === true
      ? error.message
      : "synthetic_e2e_failed";
  console.error(JSON.stringify({ status: "failed", reason }));
  process.exitCode = 1;
} finally {
  await closeChild(source);
  const { promise: embeddingClosed, resolve: resolveEmbeddingClosed } = Promise.withResolvers<void>();
  embedding?.close(() => resolveEmbeddingClosed());
  if (embedding === undefined) resolveEmbeddingClosed();
  await embeddingClosed;
  if (tempDir !== undefined) {
    await rm(tempDir, { recursive: true, force: true });
  }
}
