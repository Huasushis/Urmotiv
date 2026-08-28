import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createLocalDatabase,
  type LocalDatabaseHandle,
  migrateDatabase,
  seedCoreDatabase
} from "@urmotiv/database";
import type { AnklangFetch } from "@urmotiv/plugin-anklang";
import { sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app";
import {
  anklangPluginId,
  anklangServiceTokenSecretName,
  createBuiltinPluginDefinitions,
  type AnklangHookRuntime
} from "../src/builtin-plugins";
import { DatabaseContestStore } from "../src/database-contest-store";
import { databaseDemoUserIds, seedDatabaseDemoData } from "../src/database-demo";
import { DatabaseDataStore } from "../src/database-store";
import {
  AesGcmPluginSecretBox,
  TrustedPluginHost,
  type TrustedPluginDefinition
} from "../src/plugin-host";
import { DatabasePluginStore } from "../src/database-plugin-store";
import { DatabaseReviewItemStore } from "../src/review-item-store";

const localOrigin = "http://localhost:5173";
const statementText = "查重链路测试题面：给定 n 求 n。";

const openApps: FastifyInstance[] = [];
const openDatabases: LocalDatabaseHandle[] = [];

let temporaryDirectory = "";

beforeEach(async () => {
  temporaryDirectory = await mkdtemp(join(tmpdir(), "urmotiv-submit-hooks-"));
});

afterEach(async () => {
  await Promise.all(openApps.splice(0).map((app) => app.close()));
  await Promise.all(openDatabases.splice(0).map((database) => database.close()));
  await rm(temporaryDirectory, { recursive: true, force: true });
});

interface FakeAnklang {
  calls: number;
  indexCalls?: number;
  blockSubmission: boolean;
  completionStatus?: "complete" | "partial" | "unavailable";
  candidateIds?: string[];
  failWith?: Error;
  beforeResponse?: () => Promise<void>;
  includeBlockingOtherCheck?: boolean;
}
function fakeAnklangFetch(state: FakeAnklang): AnklangFetch {
  return async (input, init) => {
    if (String(input).endsWith("/api/v1/index/problems")) {
      state.indexCalls = (state.indexCalls ?? 0) + 1;
      const request = JSON.parse(String(init?.body ?? "{}")) as {
        requestId: string;
        externalId: string;
      };
      return new Response(JSON.stringify({
        apiVersion: "1",
        requestId: request.requestId,
        source: "urmotiv",
        externalId: request.externalId,
        contentHash: "a".repeat(64),
        outcome: "inserted"
      }), { status: 200, headers: { "content-type": "application/json" } });
    }
    state.calls += 1;
    if (state.failWith !== undefined) {
      throw state.failWith;
    }
    await state.beforeResponse?.();
    const request = JSON.parse(String(init?.body ?? "{}")) as {
      apiVersion: string;
      contentHash: string;
    };
    expect(request.apiVersion).toBe("2");
    const completionStatus = state.completionStatus ?? "complete";
    const checkedAt = new Date();
    const result = {
      apiVersion: "2",
      contentHash: request.contentHash,
      checkedAt: checkedAt.toISOString(),
      completion:
        completionStatus === "complete"
          ? { status: "complete", reasonCode: "complete", retryable: false }
          : {
              status: completionStatus,
              reasonCode:
                completionStatus === "partial" ? "search_partial" : "service_unavailable",
              retryable: true
            },
      candidates:
        completionStatus === "unavailable"
          ? []
          : (state.candidateIds ?? ["cf-1234A"]).map((externalId) => ({
              source: state.candidateIds === undefined ? "yuantiji" : "urmotiv",
              externalId,
              title: "上游题目标题",
              url: "https://example.test/problem/1234A",
              similarity: 0.92,
              sameProblemSuggestion: state.blockSubmission,
              explanation: "题面结构与数据范围几乎一致。"
            })),
      recommendation: {
        blockSubmission: completionStatus === "unavailable" ? false : state.blockSubmission,
        message: state.blockSubmission
          ? "发现高度相似的公开题目，建议不要提交。"
          : "未发现需要拦截的相似题目。"
      },
      reuse:
        completionStatus === "complete"
          ? {
              policy: "allowed",
              expiresAt: new Date(checkedAt.getTime() + 60 * 60_000).toISOString()
            }
          : { policy: "no-store" }
    };
    return new Response(JSON.stringify(result), {
      status: 200,
      headers: { "content-type": "application/json" }
    });
  };
}

async function makeHookedApp(state: FakeAnklang): Promise<{
  app: FastifyInstance;
  database: LocalDatabaseHandle;
  host: TrustedPluginHost;
}> {
  const database = createLocalDatabase({
    dataDirectory: join(temporaryDirectory, `database-${randomUUID()}`)
  });
  openDatabases.push(database);
  await migrateDatabase(database);
  await seedCoreDatabase(database);
  await seedDatabaseDemoData(database);

  let hostReference: TrustedPluginHost | undefined;
  const cacheEntries = new Map<string, { value: unknown; expiresAtMs: number }>();
  const runtime: AnklangHookRuntime = {
    readSettings: async () => hostReference?.readEnabledPluginSettings(anklangPluginId),
    readToken: async () => hostReference?.readSecretForPlugin(
      anklangPluginId,
      anklangServiceTokenSecretName
    ),
    cache: {
      async get(contentHash) {
        const entry = cacheEntries.get(contentHash);
        if (entry === undefined || entry.expiresAtMs <= Date.now()) {
          return undefined;
        }
        return entry.value;
      },
      async set(contentHash, result, expiresAt) {
        cacheEntries.set(contentHash, { value: result, expiresAtMs: Date.parse(expiresAt) });
      }
    },
    fetch: fakeAnklangFetch(state)
  };
  const definitions: TrustedPluginDefinition[] = [
    ...createBuiltinPluginDefinitions({ anklang: runtime })
  ];
  if (state.includeBlockingOtherCheck) {
    definitions.push({
      source: "builtin:test-other-check",
      initialState: "enabled",
      manifest: {
        id: "org.example.other-check",
        name: "合成的其他提交检查",
        version: "1.0.0",
        apiVersion: "1",
        permissions: []
      },
      registerHooks(registry) {
        registry.registerBeforeSubmitCheck({
          id: "org.example.other-check.before-submit",
          displayName: "合成的其他提交检查",
          timeoutMs: 1_000,
          failureBehavior: "block",
          run: () => ({
            decision: "block",
            code: "other_check_blocked",
            message: "其他提交检查的合成阻止。"
          })
        });
      }
    });
  }
  const host = new TrustedPluginHost(
    definitions,
    new DatabasePluginStore(database),
    new AesGcmPluginSecretBox(Buffer.alloc(32, 6))
  );
  hostReference = host;

  const store = new DatabaseDataStore(database);
  const app = await createApp({
    demoAuthEnabled: true,
    store,
    contestStore: new DatabaseContestStore(database),
    demoUserIds: Object.values(databaseDemoUserIds),
    demoLoginUserIds: databaseDemoUserIds,
    pluginHost: host,
    reviewItems: new DatabaseReviewItemStore(database),
    ...(runtime.fetch === undefined ? {} : { anklangFetch: runtime.fetch })
  });
  openApps.push(app);
  return { app, database, host };
}

async function login(app: FastifyInstance, userId: string): Promise<string> {
  const response = await app.inject({
    method: "POST",
    url: "/api/v1/auth/demo-login",
    headers: { origin: localOrigin },
    payload: { userId }
  });
  expect(response.statusCode).toBe(200);
  const setCookie = response.headers["set-cookie"];
  const firstCookie = Array.isArray(setCookie) ? setCookie[0] : setCookie;
  return (firstCookie as string).split(";", 1)[0] as string;
}

async function createDraft(app: FastifyInstance, cookie: string): Promise<{ id: string; revision: number }> {
  const response = await app.inject({
    method: "POST",
    url: "/api/v1/problems",
    headers: { cookie, origin: localOrigin },
    payload: {
      title: "查重链路演示题",
      type: "traditional",
      tagIds: ["catalog.tag.02.09"],
      content: {
        basicStatement: statementText,
        basicSolution: "直接输出。",
        background: "",
        statement: "",
        inputFormat: "",
        outputFormat: "",
        constraints: "",
        solution: "",
        hints: ""
      }
    }
  });
  expect(response.statusCode).toBe(200);
  return response.json() as { id: string; revision: number };
}

async function enableAnklang(host: TrustedPluginHost, settings: Record<string, unknown> = {}): Promise<void> {
  const updated = await host.update(
    anklangPluginId,
    {
      expectedRevision: 1,
      clearSecrets: [],
      state: "enabled",
      settings: { baseUrl: "http://127.0.0.1:8730", privateContentAuthorized: true, ...settings },
      secrets: { [anklangServiceTokenSecretName]: "test-service-token" }
    },
    "0",
    randomUUID()
  );
  expect(updated?.state).toBe("enabled");
}

describe("提交前查重链路", () => {
  it("提交时运行查重，结果保存为审核条目并按身份可见", async () => {
    const state: FakeAnklang = { calls: 0, blockSubmission: false };
    const { app, host } = await makeHookedApp(state);
    await enableAnklang(host);
    const author = await login(app, databaseDemoUserIds.author);
    const reviewer = await login(app, databaseDemoUserIds.reviewer);
    const denied = await login(app, databaseDemoUserIds.denied);
    const draft = await createDraft(app, author);

    const submitted = await app.inject({
      method: "POST",
      url: `/api/v1/problems/${draft.id}/submit`,
      headers: { cookie: author, origin: localOrigin },
      payload: { expectedRevision: draft.revision }
    });
    expect(submitted.statusCode).toBe(200);
    expect((submitted.json() as { status: string }).status).toBe("pending_review");
    expect(state.calls).toBe(1);
    expect(state.indexCalls).toBe(1);

    for (const cookie of [author, reviewer]) {
      const items = await app.inject({
        method: "GET",
        url: `/api/v1/problems/${draft.id}/review-items`,
        headers: { cookie }
      });
      expect(items.statusCode).toBe(200);
      const body = items.json() as {
        round: number;
        items: Array<{ type: string; source: string; summary: string; data: { candidates: unknown[] } }>;
      };
      expect(body.round).toBe(1);
      expect(body.items).toHaveLength(1);
      expect(body.items[0]).toEqual(
        expect.objectContaining({
          type: "org.ustc.urmotiv.anklang.similarity",
          source: "anklang"
        })
      );
      expect(body.items[0]?.data.candidates).toHaveLength(1);
    }

    const deniedItems = await app.inject({
      method: "GET",
      url: `/api/v1/problems/${draft.id}/review-items`,
      headers: { cookie: denied }
    });
    expect(deniedItems.statusCode).toBe(404);
    expect(deniedItems.body).not.toContain("相似");
  });

  it("Anklang 建议字段不会拦截提交，题目进入审核", async () => {
    const state: FakeAnklang = { calls: 0, blockSubmission: true };
    const { app, host } = await makeHookedApp(state);
    await enableAnklang(host);
    const author = await login(app, databaseDemoUserIds.author);
    const draft = await createDraft(app, author);

    const submitted = await app.inject({
      method: "POST",
      url: `/api/v1/problems/${draft.id}/submit`,
      headers: { cookie: author, origin: localOrigin },
      payload: { expectedRevision: draft.revision }
    });
    expect(submitted.statusCode).toBe(200);
    expect(submitted.body).not.toContain("建议不要提交");

    const reloaded = await app.inject({
      method: "GET",
      url: `/api/v1/problems/${draft.id}`,
      headers: { cookie: author }
    });
    expect((reloaded.json() as { status: string; revision: number }).status).toBe("pending_review");
    expect((reloaded.json() as { revision: number }).revision).toBe(draft.revision + 1);
  });

  it("活动审核轮次的重复手动检查替换同源结果而不重复追加", async () => {
    const state: FakeAnklang = { calls: 0, blockSubmission: false };
    const { app, host } = await makeHookedApp(state);
    await enableAnklang(host);
    const author = await login(app, databaseDemoUserIds.author);
    const draft = await createDraft(app, author);
    const submitted = await app.inject({
      method: "POST",
      url: `/api/v1/problems/${draft.id}/submit`,
      headers: { cookie: author, origin: localOrigin },
      payload: { expectedRevision: draft.revision }
    });
    expect(submitted.statusCode).toBe(200);

    for (let index = 0; index < 2; index += 1) {
      const checked = await app.inject({
        method: "POST",
        url: `/api/v1/problems/${draft.id}/similarity-check`,
        headers: { cookie: author, origin: localOrigin },
        payload: {}
      });
      expect(checked.statusCode).toBe(200);
      expect(checked.json()).toMatchObject({ status: "completed" });
    }
    const items = await app.inject({
      method: "GET",
      url: `/api/v1/problems/${draft.id}/review-items`,
      headers: { cookie: author }
    });
    expect((items.json() as { items: unknown[] }).items).toHaveLength(1);
    expect(state.calls).toBe(1);
  });

  it("草稿阶段可以手动查重，结果不落库且第二次命中缓存", async () => {
    const state: FakeAnklang = { calls: 0, blockSubmission: false };
    const { app, host } = await makeHookedApp(state);
    await enableAnklang(host);
    const author = await login(app, databaseDemoUserIds.author);
    const denied = await login(app, databaseDemoUserIds.denied);
    const draft = await createDraft(app, author);

    const checked = await app.inject({
      method: "POST",
      url: `/api/v1/problems/${draft.id}/similarity-check`,
      headers: { cookie: author, origin: localOrigin },
      payload: {}
    });
    expect(checked.statusCode).toBe(200);
    const body = checked.json() as {
      status: string;
      blockedAdvice: unknown;
      items: Array<{ type: string }>;
    };
    expect(body.status).toBe("completed");
    expect(body.blockedAdvice).toBeNull();
    expect(body.items).toHaveLength(1);
    expect(state.calls).toBe(1);

    const secondCheck = await app.inject({
      method: "POST",
      url: `/api/v1/problems/${draft.id}/similarity-check`,
      headers: { cookie: author, origin: localOrigin },
      payload: {}
    });
    expect(secondCheck.statusCode).toBe(200);
    expect(state.calls).toBe(1);

    const items = await app.inject({
      method: "GET",
      url: `/api/v1/problems/${draft.id}/review-items`,
      headers: { cookie: author }
    });
    expect((items.json() as { round: number; items: unknown[] }).items).toHaveLength(0);

    const deniedCheck = await app.inject({
      method: "POST",
      url: `/api/v1/problems/${draft.id}/similarity-check`,
      headers: { cookie: denied, origin: localOrigin },
      payload: {}
    });
    expect(deniedCheck.statusCode).toBe(404);
    expect(state.calls).toBe(1);

    const unknownCheck = await app.inject({
      method: "POST",
      url: "/api/v1/problems/999999999999/similarity-check",
      headers: { cookie: author, origin: localOrigin },
      payload: {}
    });
    expect(unknownCheck.statusCode).toBe(deniedCheck.statusCode);
    const deniedJson = deniedCheck.json() as {
      error: { code: string; message: string; requestId?: string };
    };
    const unknownJson = unknownCheck.json() as {
      error: { code: string; message: string; requestId?: string };
    };
    expect(deniedJson.error.code).toBe("NOT_FOUND");
    expect(unknownJson.error.code).toBe("NOT_FOUND");
    expect(unknownJson.error.message).toBe(deniedJson.error.message);
    expect(deniedJson.error.requestId).toBeDefined();
    expect(unknownJson.error.requestId).toBeDefined();
    expect(unknownJson.error.requestId).not.toBe(deniedJson.error.requestId);
    expect(state.calls).toBe(1);
  });

  it("手动完整检索忽略 Anklang 建议字段并返回候选", async () => {
    const state: FakeAnklang = { calls: 0, blockSubmission: true };
    const { app, host } = await makeHookedApp(state);
    await enableAnklang(host);
    const author = await login(app, databaseDemoUserIds.author);
    const draft = await createDraft(app, author);

    const checked = await app.inject({
      method: "POST",
      url: `/api/v1/problems/${draft.id}/similarity-check`,
      headers: { cookie: author, origin: localOrigin },
      payload: {}
    });

    expect(checked.statusCode).toBe(200);
    const body = checked.json() as {
      status: string;
      blockedAdvice: unknown;
      items: Array<{ data: Record<string, unknown> }>;
    };
    expect(body.status).toBe("completed");
    expect(body.blockedAdvice).toBeNull();
    expect(body.items).toHaveLength(1);
    expect(body.items[0]?.data).not.toHaveProperty("recommendation");
  });

  it("手动查重只运行 Anklang，不受其他提交前检查冒充或阻止", async () => {
    const state: FakeAnklang = {
      calls: 0,
      blockSubmission: false,
      includeBlockingOtherCheck: true
    };
    const { app, host } = await makeHookedApp(state);
    await enableAnklang(host);
    const author = await login(app, databaseDemoUserIds.author);
    const draft = await createDraft(app, author);

    const checked = await app.inject({
      method: "POST",
      url: `/api/v1/problems/${draft.id}/similarity-check`,
      headers: { cookie: author, origin: localOrigin },
      payload: {}
    });
    expect(checked.statusCode).toBe(200);
    expect(checked.json()).toMatchObject({ status: "completed", blockedAdvice: null });
    expect(checked.body).not.toContain("其他提交检查");
    expect(state.calls).toBe(1);
  });

  it("手动查重严格区分 partial 与 unavailable，非完整结果不会伪装成阴性", async () => {
    for (const completionStatus of ["partial", "unavailable"] as const) {
      const state: FakeAnklang = { calls: 0, blockSubmission: false, completionStatus };
      const { app, host } = await makeHookedApp(state);
      await enableAnklang(host, { failureBehavior: "continue" });
      const author = await login(app, databaseDemoUserIds.author);
      const draft = await createDraft(app, author);

      const checked = await app.inject({
        method: "POST",
        url: `/api/v1/problems/${draft.id}/similarity-check`,
        headers: { cookie: author, origin: localOrigin },
        payload: {}
      });
      expect(checked.statusCode).toBe(200);
      expect(checked.json()).toMatchObject({
        status: completionStatus,
        blockedAdvice: null,
        items: [
          {
            source: "anklang",
            data: { completion: { status: completionStatus }, reuse: { policy: "no-store" } }
          }
        ]
      });
      expect(checked.body).not.toContain("完整检索没有发现");
    }
  });

  it("continue 模式把网络失败记为固定 unavailable，且不泄露异常或题面", async () => {
    const marker = "network-secret-marker";
    const state: FakeAnklang = {
      calls: 0,
      blockSubmission: false,
      failWith: new Error(marker)
    };
    const { app, host } = await makeHookedApp(state);
    await enableAnklang(host, { failureBehavior: "continue" });
    const author = await login(app, databaseDemoUserIds.author);
    const draft = await createDraft(app, author);

    const checked = await app.inject({
      method: "POST",
      url: `/api/v1/problems/${draft.id}/similarity-check`,
      headers: { cookie: author, origin: localOrigin },
      payload: {}
    });
    expect(checked.statusCode).toBe(200);
    expect(checked.json()).toMatchObject({
      status: "unavailable",
      blockedAdvice: null,
      items: [{ data: { completion: { status: "unavailable" }, candidates: [] } }]
    });
    expect(checked.body).not.toContain(marker);
    expect(checked.body).not.toContain(statementText);
  });

  it("手动长请求结束后发现修订变化就丢弃旧结果", async () => {
    let markStarted: (() => void) | undefined;
    let releaseResponse: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const release = new Promise<void>((resolve) => {
      releaseResponse = resolve;
    });
    const state: FakeAnklang = {
      calls: 0,
      blockSubmission: false,
      beforeResponse: async () => {
        markStarted?.();
        await release;
      }
    };
    const { app, host } = await makeHookedApp(state);
    await enableAnklang(host);
    const author = await login(app, databaseDemoUserIds.author);
    const draft = await createDraft(app, author);

    const checking = app.inject({
      method: "POST",
      url: `/api/v1/problems/${draft.id}/similarity-check`,
      headers: { cookie: author, origin: localOrigin },
      payload: {}
    });
    await started;
    const updated = await app.inject({
      method: "PATCH",
      url: `/api/v1/problems/${draft.id}`,
      headers: { cookie: author, origin: localOrigin },
      payload: { expectedRevision: draft.revision, title: "并发修改后的合成题" }
    });
    expect(updated.statusCode).toBe(200);
    releaseResponse?.();

    const stale = await checking;
    expect(stale.statusCode).toBe(409);
    expect(stale.body).not.toContain("非常相似");
    expect(stale.body).not.toContain(statementText);
  });

  it("手动长请求结束后账号被停用就不返回或保存旧结果", async () => {
    let markStarted: (() => void) | undefined;
    let releaseResponse: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const release = new Promise<void>((resolve) => {
      releaseResponse = resolve;
    });
    const state: FakeAnklang = {
      calls: 0,
      blockSubmission: false,
      beforeResponse: async () => {
        markStarted?.();
        await release;
      }
    };
    const { app, database, host } = await makeHookedApp(state);
    const author = await login(app, databaseDemoUserIds.author);
    const draft = await createDraft(app, author);
    const submitted = await app.inject({
      method: "POST",
      url: `/api/v1/problems/${draft.id}/submit`,
      headers: { cookie: author, origin: localOrigin },
      payload: { expectedRevision: draft.revision }
    });
    expect(submitted.statusCode).toBe(200);
    await enableAnklang(host);

    const checking = app.inject({
      method: "POST",
      url: `/api/v1/problems/${draft.id}/similarity-check`,
      headers: { cookie: author, origin: localOrigin },
      payload: {}
    });
    await started;
    await database.execute(sql`
      UPDATE users
      SET disabled_at = now()
      WHERE id = ${BigInt(databaseDemoUserIds.author)}
    `);
    releaseResponse?.();

    const denied = await checking;
    expect(denied.statusCode).toBe(401);
    expect(denied.body).not.toContain("非常相似");
    expect(denied.body).not.toContain(statementText);
    const saved = await database.query<{ count: number }>(sql`
      SELECT count(*)::integer AS count
      FROM review_items item
      JOIN review_rounds round_record ON round_record.id = item.round_id
      WHERE round_record.problem_id = ${BigInt(draft.id)}
    `);
    expect(saved).toEqual([{ count: 0 }]);
  });

  it("插件停用时提交不运行查重；失败按设置降级不拦截", async () => {
    const state: FakeAnklang = { calls: 0, blockSubmission: false };
    const { app, host } = await makeHookedApp(state);
    const author = await login(app, databaseDemoUserIds.author);
    const draft = await createDraft(app, author);

    const submitted = await app.inject({
      method: "POST",
      url: `/api/v1/problems/${draft.id}/submit`,
      headers: { cookie: author, origin: localOrigin },
      payload: { expectedRevision: draft.revision }
    });
    expect(submitted.statusCode).toBe(200);
    expect(state.calls).toBe(0);

    await enableAnklang(host, { failureBehavior: "continue" });
    state.failWith = new Error("网络不可达");
    const secondDraft = await createDraft(app, author);
    const secondSubmit = await app.inject({
      method: "POST",
      url: `/api/v1/problems/${secondDraft.id}/submit`,
      headers: { cookie: author, origin: localOrigin },
      payload: { expectedRevision: secondDraft.revision }
    });
    expect(secondSubmit.statusCode).toBe(200);
    expect(state.calls).toBe(2);
  });

  it("已有令牌但无法解密时不发送无认证请求", async () => {
    const state: FakeAnklang = { calls: 0, blockSubmission: false };
    const { app, database, host } = await makeHookedApp(state);
    await enableAnklang(host);
    const encryptedMarker = "anklang-ciphertext-must-not-appear";
    await database.execute(sql`
      UPDATE plugin_secrets
      SET encrypted_value = ${encryptedMarker},
          key_version = 1,
          masked_suffix = 'tail',
          value_length = 20,
          updated_by_user_id = 0
      WHERE plugin_id = ${anklangPluginId}
        AND name = ${anklangServiceTokenSecretName}
    `);
    const author = await login(app, databaseDemoUserIds.author);
    const draft = await createDraft(app, author);

    const submitted = await app.inject({
      method: "POST",
      url: `/api/v1/problems/${draft.id}/submit`,
      headers: { cookie: author, origin: localOrigin },
      payload: { expectedRevision: draft.revision }
    });
    expect(submitted.statusCode).toBe(409);
    expect(submitted.json()).toMatchObject({
      error: { code: "SUBMIT_BLOCKED_BY_CHECK" }
    });
    expect(submitted.body).not.toContain(encryptedMarker);
    expect(submitted.body).not.toContain(anklangServiceTokenSecretName);
    expect(state.calls).toBe(0);
  });
  it("submit 过滤 self/unknown Urmotiv 候选并用权限过滤后的当前标题重建摘要", async () => {
    const state: FakeAnklang = { calls: 0, blockSubmission: false };
    const { app, host } = await makeHookedApp(state);
    await enableAnklang(host);
    const author = await login(app, databaseDemoUserIds.author);
    const visible = await createDraft(app, author);
    const target = await createDraft(app, author);
    state.candidateIds = [target.id, visible.id, "999999999999"];

    const submitted = await app.inject({
      method: "POST",
      url: `/api/v1/problems/${target.id}/submit`,
      headers: { cookie: author, origin: localOrigin },
      payload: { expectedRevision: target.revision }
    });
    expect(submitted.statusCode).toBe(200);
    const items = await app.inject({
      method: "GET",
      url: `/api/v1/problems/${target.id}/review-items`,
      headers: { cookie: author }
    });
    const body = items.json() as {
      items: Array<{ summary: string; data: { candidates: Array<Record<string, unknown>> } }>;
    };
    expect(body.items[0]?.data.candidates).toEqual([
      expect.objectContaining({ source: "urmotiv", externalId: visible.id, title: "查重链路演示题" })
    ]);
    expect(body.items[0]?.summary).toContain("1 道候选");
  });
});
