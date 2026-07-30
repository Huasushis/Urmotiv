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
import { TrustedPluginHost } from "../src/plugin-host";
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
  blockSubmission: boolean;
  failWith?: Error;
}

function fakeAnklangFetch(state: FakeAnklang): AnklangFetch {
  return async (_input, init) => {
    state.calls += 1;
    if (state.failWith !== undefined) {
      throw state.failWith;
    }
    const request = JSON.parse(String(init?.body ?? "{}")) as { contentHash: string };
    const result = {
      apiVersion: "1",
      contentHash: request.contentHash,
      checkedAt: new Date().toISOString(),
      candidates: [
        {
          source: "yuantiji",
          externalId: "cf-1234A",
          title: "非常相似的公开题目",
          url: "https://example.test/problem/1234A",
          similarity: 0.92,
          sameProblemSuggestion: state.blockSubmission,
          explanation: "题面结构与数据范围几乎一致。"
        }
      ],
      recommendation: {
        blockSubmission: state.blockSubmission,
        message: state.blockSubmission
          ? "发现高度相似的公开题目，建议不要提交。"
          : "未发现需要拦截的相似题目。"
      }
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
  const host = new TrustedPluginHost(
    createBuiltinPluginDefinitions({ anklang: runtime }),
    new DatabasePluginStore(database)
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
    reviewItems: new DatabaseReviewItemStore(database)
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
      tagIds: ["algorithm.implementation"],
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
      settings: { baseUrl: "http://anklang.test", ...settings }
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

  it("查重建议拦截时提交被阻止，题目保持草稿", async () => {
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
    expect(submitted.statusCode).toBe(409);
    expect(submitted.body).toContain("建议不要提交");

    const reloaded = await app.inject({
      method: "GET",
      url: `/api/v1/problems/${draft.id}`,
      headers: { cookie: author }
    });
    expect((reloaded.json() as { status: string; revision: number }).status).toBe("draft");
    expect((reloaded.json() as { revision: number }).revision).toBe(draft.revision);
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
    expect(state.calls).toBe(1);
  });

  it("已有令牌但无法解密时不发送无认证请求", async () => {
    const state: FakeAnklang = { calls: 0, blockSubmission: false };
    const { app, database, host } = await makeHookedApp(state);
    await enableAnklang(host);
    const encryptedMarker = "anklang-ciphertext-must-not-appear";
    await database.execute(sql`
      INSERT INTO plugin_secrets (
        plugin_id, name, encrypted_value, key_version, masked_suffix, value_length,
        updated_by_user_id
      ) VALUES (
        ${anklangPluginId}, ${anklangServiceTokenSecretName}, ${encryptedMarker}, 1,
        'tail', 20, 0
      )
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
});
