import { describe, expect, it, vi } from "vitest";
import {
  AnklangClient,
  AnklangInvalidResponseError,
  AnklangStaleUpdateError,
  AnklangUnavailableError,
  anklangIndexUpsertRequestSchema,
  anklangIndexUpsertResponseSchema,
  anklangSettingsSchema,
  anklangV2ResultSchema,
  createAnklangCheck,
  createAnklangIndexAdapter,
  isPrivateAnklangBaseUrl,
  projectAnklangSearchResult
} from "../src/index";
import type { BeforeSubmitInput } from "@urmotiv/plugin-sdk";

const requestId = "54b70dd8-5c21-4d31-84b7-6437b303c4f2";
const contentHash = "a".repeat(64);
const settings = (overrides: Record<string, unknown> = {}) =>
  anklangSettingsSchema.parse({
    baseUrl: "http://127.0.0.1:8730",
    privateContentAuthorized: true,
    ...overrides
  });
const upsertRequest = {
  apiVersion: "1" as const,
  requestId,
  externalId: "42",
  updatedAt: "2026-08-28T00:00:00.000Z",
  problem: { title: "题目标题", basicStatement: "给出一个数并求解。" }
};
const upsertResponse = (
  outcome: "inserted" | "updated" | "unchanged",
  identity: Pick<typeof upsertRequest, "requestId" | "externalId"> = upsertRequest
) => ({
  apiVersion: "1",
  requestId: identity.requestId,
  source: "urmotiv",
  externalId: identity.externalId,
  contentHash,
  outcome
});
const input: BeforeSubmitInput = {
  problemId: "42",
  revision: 1,
  reviewRound: 1,
  contentHash,
  problem: {
    title: "题目标题",
    type: "traditional",
    tagIds: ["math"],
    basicStatement: "给出一个数并求解。",
    basicSolution: "直接计算。"
  }
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

describe("Anklang v1 index mutation", () => {
  it("uses the frozen strict PUT body and preserves inserted/replay/newer outcomes", async () => {
    expect(anklangIndexUpsertRequestSchema.parse(upsertRequest)).toEqual(upsertRequest);
    expect(anklangIndexUpsertResponseSchema.parse(upsertResponse("inserted"))).toMatchObject({
      outcome: "inserted"
    });
    const outcomes = ["inserted", "unchanged", "updated"] as const;
    const updatedRequest = {
      ...upsertRequest,
      requestId: "d1ef7c66-8d88-468a-9ca6-3874a305a6c2",
      updatedAt: "2026-08-28T00:01:00.000Z",
      problem: { ...upsertRequest.problem, title: "新标题" }
    };
    const expectedBodies = [upsertRequest, upsertRequest, updatedRequest];
    const fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      expect(String(url)).toBe("http://127.0.0.1:8730/api/v1/index/problems");
      expect(init?.method).toBe("PUT");
      expect(init?.headers).toEqual(expect.objectContaining({
        Authorization: "Bearer service-secret",
        "Cache-Control": "no-store",
        "X-Urmotiv-API-Version": "1"
      }));
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      const expectedBody = expectedBodies[fetch.mock.calls.length - 1] ?? upsertRequest;
      expect(body).toEqual(expectedBody);
      return json(
        upsertResponse(
          outcomes[fetch.mock.calls.length - 1] ?? "updated",
          expectedBody
        )
      );
    });
    const client = new AnklangClient({
      ...settings(), token: "service-secret", fetch
    });
    await expect(client.upsert(upsertRequest)).resolves.toMatchObject({ outcome: "inserted" });
    await expect(client.upsert(upsertRequest)).resolves.toMatchObject({ outcome: "unchanged" });
    await expect(client.upsert(updatedRequest)).resolves.toMatchObject({ outcome: "updated" });
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it("does not retry stale conflicts or contract errors, but retries retryable statuses", async () => {
    const staleFetch = vi.fn(async () => json({ error: "STALE_UPDATE" }, 409));
    const stale = new AnklangClient({ ...settings({ retryAttempts: 3 }), token: "service-secret", fetch: staleFetch });
    await expect(stale.upsert(upsertRequest)).rejects.toBeInstanceOf(AnklangStaleUpdateError);
    expect(staleFetch).toHaveBeenCalledTimes(1);

    const busyFetch = vi.fn(async () => json({ error: "INDEX_UNAVAILABLE" }, 503));
    const busy = new AnklangClient({ ...settings({ retryAttempts: 2 }), token: "service-secret", fetch: busyFetch });
    await expect(busy.upsert(upsertRequest)).rejects.toBeInstanceOf(AnklangUnavailableError);
    expect(busyFetch).toHaveBeenCalledTimes(2);

    const malformedFetch = vi.fn(async () => json({ apiVersion: "1" }));
    const malformed = new AnklangClient({ ...settings({ retryAttempts: 3 }), token: "service-secret", fetch: malformedFetch });
    await expect(malformed.upsert(upsertRequest)).rejects.toBeInstanceOf(AnklangInvalidResponseError);
    expect(malformedFetch).toHaveBeenCalledTimes(1);
  });

  it("查询 401 直接不可用且不伪装成 complete-empty", async () => {
    const unauthorizedFetch = vi.fn(async () => json({ error: "unauthorized" }, 401));
    const client = new AnklangClient({
      ...settings({ retryAttempts: 3 }), token: "service-secret", fetch: unauthorizedFetch
    });
    await expect(client.check({
      apiVersion: "2",
      requestId,
      contentHash,
      problem: {
        title: input.problem.title,
        type: input.problem.type,
        tagIds: input.problem.tagIds,
        basicStatement: input.problem.basicStatement
      }
    }, new AbortController().signal)).rejects.toMatchObject({ statusCode: 401 });
    expect(unauthorizedFetch).toHaveBeenCalledTimes(1);
  });

  it("does not retry non-retryable HTTP failures", async () => {
    const serverErrorFetch = vi.fn(async () => json({ error: "internal" }, 500));
    const client = new AnklangClient({
      ...settings({ retryAttempts: 3 }),
      token: "service-secret",
      fetch: serverErrorFetch
    });
    await expect(client.check({
      apiVersion: "2",
      requestId,
      contentHash,
      problem: {
        title: input.problem.title,
        type: input.problem.type,
        tagIds: input.problem.tagIds,
        basicStatement: input.problem.basicStatement
      }
    }, new AbortController().signal)).rejects.toMatchObject({ statusCode: 500 });
    expect(serverErrorFetch).toHaveBeenCalledTimes(1);
  });

  it("bounds network retries and a hanging response body by the configured timeout", async () => {
    vi.useFakeTimers();
    try {
      const startedAt = Date.now();
      let completedAt: number | undefined;
      const hangingFetch = vi.fn(() => new Promise<Response>(() => {}));
      const client = new AnklangClient({
        ...settings({ retryAttempts: 2, timeoutMs: 1_000 }),
        token: "service-secret",
        fetch: hangingFetch
      });
      const pending = client.check({
        apiVersion: "2",
        requestId,
        contentHash,
        problem: {
          title: input.problem.title,
          type: input.problem.type,
          tagIds: input.problem.tagIds,
          basicStatement: input.problem.basicStatement
        }
      }, new AbortController().signal).catch((error: unknown) => {
        completedAt = Date.now();
        throw error;
      });
      const rejection = expect(pending).rejects.toBeInstanceOf(AnklangUnavailableError);
      await vi.advanceTimersByTimeAsync(1_001);
      await rejection;
      expect(completedAt).toBeDefined();
      expect((completedAt as number) - startedAt).toBeLessThanOrEqual(1_000);

      const hangingBodyFetch = vi.fn(async () => new Response(
        new ReadableStream<Uint8Array>({ start() {} }),
        { headers: { "Content-Type": "application/json" } }
      ));
      const bodyClient = new AnklangClient({
        ...settings({ retryAttempts: 2, timeoutMs: 1_000 }),
        token: "service-secret",
        fetch: hangingBodyFetch
      });
      const bodyPending = bodyClient.check({
        apiVersion: "2",
        requestId,
        contentHash,
        problem: {
          title: input.problem.title,
          type: input.problem.type,
          tagIds: input.problem.tagIds,
          basicStatement: input.problem.basicStatement
        }
      }, new AbortController().signal);
      const bodyRejection = expect(bodyPending).rejects.toBeInstanceOf(AnklangUnavailableError);
      await vi.advanceTimersByTimeAsync(1_001);
      await bodyRejection;
      expect(hangingBodyFetch).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });
  it("enforces private URL, explicit authorization, and a nonblank token before fetch", () => {
    expect(() => new AnklangClient({ baseUrl: "https://anklang.example.test", token: "secret" })).toThrow();
    expect(() => new AnklangClient({ ...settings({ privateContentAuthorized: false }), token: "secret" })).toThrow();
    expect(() => new AnklangClient({ ...settings(), token: "  " })).toThrow();

    expect(isPrivateAnklangBaseUrl("http://169.254.169.254:8730")).toBe(true);
    expect(isPrivateAnklangBaseUrl("http://[fe80::1]:8730")).toBe(true);
  });

  it("keeps the check search-only even when Anklang sends judgment fields", async () => {
    const raw = anklangV2ResultSchema.parse({
      apiVersion: "2",
      contentHash,
      checkedAt: "2026-08-28T00:00:00.000Z",
      completion: { status: "complete", reasonCode: "complete", retryable: false },
      candidates: [{
        source: "external-catalog", externalId: "x", title: "外部题", similarity: 0.8,
        sameProblemSuggestion: true, explanation: "discard", metadata: { provider: "catalog" }
      }],
      recommendation: { blockSubmission: true, message: "discard" }
    });
    const check = createAnklangCheck({
      settings: settings({ failureBehavior: "continue" }), token: "service-secret",
      fetch: async () => json(raw)
    });
    const result = await check.run(input, { signal: new AbortController().signal });
    expect(result.decision).toBe("continue");
    if (result.decision !== "continue") throw new Error("unexpected block");
    const data = result.reviewItems?.[0]?.data as Record<string, unknown>;
    expect(data).not.toHaveProperty("recommendation");
    expect(data.candidates).toEqual([
      expect.objectContaining({ externalId: "x", similarity: 0.8, metadata: { provider: "catalog" } })
    ]);
    expect(data.candidates).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ sameProblemSuggestion: true, explanation: "discard" })
    ]));
    expect(projectAnklangSearchResult(raw)).toEqual(data);
  });
});

describe("disabled/misconfigured index bridge", () => {
  it("performs zero fetches until enabled, authorized, and secret-backed", async () => {
    const fetch = vi.fn(async () => json(upsertResponse("inserted")));
    const problem = { externalId: "42", title: "题目标题", basicStatement: "题面", updatedAt: upsertRequest.updatedAt };
    const disabled = createAnklangIndexAdapter({ readSettings: async () => undefined, readToken: async () => "secret", fetch });
    await disabled.upsert(problem);
    const unauthorized = createAnklangIndexAdapter({ readSettings: async () => settings({ privateContentAuthorized: false }), readToken: async () => "secret", fetch });
    await unauthorized.upsert(problem);
    const missingSecret = createAnklangIndexAdapter({ readSettings: async () => settings(), readToken: async () => "", fetch });
    await missingSecret.upsert(problem);
    expect(fetch).not.toHaveBeenCalled();
  });
});
