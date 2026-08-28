import { describe, expect, it, vi } from "vitest";
import {
  AnklangClient,
  anklangSettingsSchema,
  createAnklangCheck,
  createAnklangIndexAdapter,
  isValidEmbeddingProviderBaseUrl
} from "../src/index";

const contentHash = "a".repeat(64);
const baseSettings = {
  baseUrl: "http://127.0.0.1:8730",
  apiVersion: "2" as const,
  privateContentAuthorized: true,
  timeoutMs: 120_000,
  indexTimeoutMs: 10_000,
  retryAttempts: 1
};
const providerConfig = {
  baseUrl: "https://emb.example.com/v1",
  model: "bge-m3",
  dimension: 1024
};
const problem = {
  externalId: "42",
  title: "题目标题",
  basicStatement: "给出一个数并求解。",
  updatedAt: "2026-08-28T00:00:00.000Z"
};
const upsertResponse = () => ({
  apiVersion: "1",
  requestId: "54b70dd8-5c21-4d31-84b7-6437b303c4f2",
  source: "urmotiv",
  externalId: problem.externalId,
  contentHash,
  outcome: "inserted"
});
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

describe("Anklang embedding provider provisioning", () => {
  it("accepts HTTPS provider URLs and safe local/private HTTP; rejects unsafe HTTP and credentials/query/fragment", () => {
    expect(isValidEmbeddingProviderBaseUrl("https://emb.example.com/v1")).toBe(true);
    expect(isValidEmbeddingProviderBaseUrl("https://emb.example.com")).toBe(true);
    expect(isValidEmbeddingProviderBaseUrl("http://127.0.0.1:8000")).toBe(true);
    expect(isValidEmbeddingProviderBaseUrl("http://10.0.0.9/embed")).toBe(true);
    expect(isValidEmbeddingProviderBaseUrl("http://emb.example.com/v1")).toBe(false);
    expect(isValidEmbeddingProviderBaseUrl("https://user:pw@emb.example.com/v1")).toBe(false);
    expect(isValidEmbeddingProviderBaseUrl("https://emb.example.com/v1?api-version=1")).toBe(false);
    expect(isValidEmbeddingProviderBaseUrl("https://emb.example.com/v1#section")).toBe(false);
    expect(isValidEmbeddingProviderBaseUrl("ftp://emb.example.com/v1")).toBe(false);
  });

  it("accepts bounded embeddingProvider settings and rejects empty model or invalid dimension", () => {
    const parsed = anklangSettingsSchema.safeParse({
      ...baseSettings,
      embeddingProvider: providerConfig
    });
    expect(parsed.success).toBe(true);
    expect(
      anklangSettingsSchema.safeParse({
        ...baseSettings,
        embeddingProvider: { ...providerConfig, model: "" }
      }).success
    ).toBe(false);
    expect(
      anklangSettingsSchema.safeParse({
        ...baseSettings,
        embeddingProvider: { ...providerConfig, dimension: 0 }
      }).success
    ).toBe(false);
    expect(
      anklangSettingsSchema.safeParse({
        ...baseSettings,
        embeddingProvider: { ...providerConfig, dimension: 1.5 }
      }).success
    ).toBe(false);
  });

  it("authenticated GET/PUT/DELETE against the versioned provisioning contract never echo the api key", async () => {
    const calls: string[] = [];
    const fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      const target = String(url);
      calls.push(`${method} ${target}`);
      expect(target).toBe("http://127.0.0.1:8730/api/v1/admin/embedding-provider");
      expect(init?.headers).toEqual(
        expect.objectContaining({
          Authorization: "Bearer service-secret",
          Accept: "application/json",
          "Cache-Control": "no-store"
        })
      );
      if (method === "PUT") {
        expect(JSON.parse(String(init?.body))).toEqual({
          ...providerConfig,
          apiKey: "emb-secret"
        });
        return json({ configured: true, ...providerConfig });
      }
      if (method === "GET") {
        return json({ configured: true, ...providerConfig });
      }
      if (method === "DELETE") {
        return json({ configured: false });
      }
      throw new Error(`unexpected provisioning method ${method}`);
    });
    const client = new AnklangClient({
      ...baseSettings,
      token: "service-secret",
      fetch
    });

    const initial = await client.getEmbeddingProvider();
    expect(initial).toEqual({ configured: true, ...providerConfig });

    const provisioned = await client.putEmbeddingProvider({
      ...providerConfig,
      apiKey: "emb-secret"
    });
    expect(provisioned).toEqual({ configured: true, ...providerConfig });

    const cleared = await client.deleteEmbeddingProvider();
    expect(cleared).toEqual({ configured: false });
    expect(calls).toEqual([
      "GET http://127.0.0.1:8730/api/v1/admin/embedding-provider",
      "PUT http://127.0.0.1:8730/api/v1/admin/embedding-provider",
      "DELETE http://127.0.0.1:8730/api/v1/admin/embedding-provider"
    ]);
  });

  it("provisions the provider from plugin settings and secrets before upsert", async () => {
    const calls: string[] = [];
    const fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      calls.push(`${init?.method ?? "GET"} ${String(url)}`);
      if (String(url).endsWith("/api/v1/admin/embedding-provider")) {
        expect(JSON.parse(String(init?.body))).toEqual({ ...providerConfig, apiKey: "emb-secret" });
        return json({ configured: true, ...providerConfig });
      }
      if (String(url).endsWith("/api/v1/index/problems")) {
        const body = JSON.parse(String(init?.body)) as { requestId: string; externalId: string };
        return json({ ...upsertResponse(), requestId: body.requestId, externalId: body.externalId });
      }
      throw new Error(`unexpected url ${String(url)}`);
    });
    const adapter = createAnklangIndexAdapter({
      readSettings: async () => ({ ...baseSettings, embeddingProvider: providerConfig }),
      readToken: async () => "service-secret",
      readEmbeddingApiKey: async () => "emb-secret",
      fetch
    });
    await expect(adapter.upsert(problem)).resolves.toMatchObject({ outcome: "inserted" });
    expect(calls).toEqual([
      "PUT http://127.0.0.1:8730/api/v1/admin/embedding-provider",
      "PUT http://127.0.0.1:8730/api/v1/index/problems"
    ]);
  });

  it("missing/cleared/malformed provider config makes the upsert a zero-call no-op", async () => {
    const missingProviderFetch = vi.fn();
    const adapter = createAnklangIndexAdapter({
      readSettings: async () => baseSettings,
      readToken: async () => "service-secret",
      readEmbeddingApiKey: async () => "emb-secret",
      fetch: missingProviderFetch
    });
    await expect(adapter.upsert(problem)).resolves.toBeUndefined();
    expect(missingProviderFetch).not.toHaveBeenCalled();

    const missingApiKeyFetch = vi.fn();
    const adapter2 = createAnklangIndexAdapter({
      readSettings: async () => ({ ...baseSettings, embeddingProvider: providerConfig }),
      readToken: async () => "service-secret",
      readEmbeddingApiKey: async () => undefined,
      fetch: missingApiKeyFetch
    });
    await expect(adapter2.upsert(problem)).resolves.toBeUndefined();
    expect(missingApiKeyFetch).not.toHaveBeenCalled();
  });

  it("disabled plugin performs zero fetches, including provisioning", async () => {
    const fetch = vi.fn();
    const adapter = createAnklangIndexAdapter({
      readSettings: async () => undefined,
      readToken: async () => "service-secret",
      readEmbeddingApiKey: async () => "emb-secret",
      fetch
    });
    await expect(adapter.upsert(problem)).resolves.toBeUndefined();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("provisions the provider before an enabled query and treats missing config as unavailable, never no candidates", async () => {
    const calls: string[] = [];
    const checkFetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      calls.push(`${init?.method ?? "GET"} ${String(url)}`);
      if (String(url).endsWith("/api/v1/admin/embedding-provider")) {
        return json({ configured: true, ...providerConfig });
      }
      if (String(url).endsWith("/api/v2/checks/similarity")) {
        return json({
          apiVersion: "2",
          contentHash,
          checkedAt: "2026-08-28T00:00:00.000Z",
          completion: { status: "complete", reasonCode: "complete", retryable: false },
          candidates: [{
            source: "外部题库", externalId: "s1", title: "相似题", similarity: 0.81,
            sameProblemSuggestion: false
          }],
          recommendation: { blockSubmission: false, message: "请继续人工核对。" },
          reuse: { policy: "allowed", expiresAt: "2026-08-28T01:00:00.000Z" }
        });
      }
      throw new Error(`unexpected url ${String(url)}`);
    });
    const check = createAnklangCheck({
      settings: anklangSettingsSchema.parse({ ...baseSettings, embeddingProvider: providerConfig }),
      token: "service-secret",
      embeddingApiKey: "emb-secret",
      fetch: checkFetch
    });
    const output = await check.run(
      {
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
      },
      { signal: new AbortController().signal }
    );
    expect(output.decision).toBe("continue");
    expect(calls).toEqual([
      "PUT http://127.0.0.1:8730/api/v1/admin/embedding-provider",
      "POST http://127.0.0.1:8730/api/v2/checks/similarity"
    ]);

    const missingApiKey = createAnklangCheck({
      settings: anklangSettingsSchema.parse({
        ...baseSettings,
        embeddingProvider: providerConfig,
        failureBehavior: "continue"
      }),
      token: "service-secret",
      fetch: checkFetch
    });
    const unavailable = await missingApiKey.run(
      {
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
      },
      { signal: new AbortController().signal }
    );
    expect(unavailable.decision).toBe("continue");
    if (unavailable.decision === "continue") {
      const item = unavailable.reviewItems?.[0];
      expect(item?.data).toMatchObject({
        apiVersion: "2",
        completion: { status: "unavailable" },
        candidates: []
      });
    }
    // 密钥被清除（或从未配置）时不得发起任何网络请求。
    expect(checkFetch).toHaveBeenCalledTimes(2);
  });
});
