import { expect, it, vi } from "vitest";
import { createServer } from "node:http";
import {
  AiDraftService,
  extractionSchema,
  extractWithModel,
  materializeAiDraft,
} from "../src/ai-draft";
import type { TrustedPluginHost } from "../src/plugin-host";
import { createApp } from "../src/app";
import {InMemoryDataStore} from '../src/repository';
import type {StoredUser} from '../src/domain';
const empty = () =>
  Object.fromEntries(
    Object.keys(extractionSchema.shape).map((key) => [key, []]),
  );
it("按行提取不改公式/代码、保留未知文字，范围越界/重复/生成正文拒绝", () => {
  const text =
    "题名\r\n求 \\(x_i^2\\)\r\n解法\r\n```cpp\r\nint main() {}\r\n```\r\n其它材料";
  const ranges = {
    ...empty(),
    title: [{ start: 1, end: 1 }],
    basicStatement: [{ start: 2, end: 2 }],
    basicSolution: [{ start: 3, end: 3 }],
    standardSolution: [{ start: 4, end: 6 }],
  };
  const result = materializeAiDraft(text, ranges);
  expect(result.title).toBe("题名");
  expect(result.content.basicStatement).toBe("求 \\(x_i^2\\)\r\n");
  expect(result.standardSolution).toBe("```cpp\r\nint main() {}\r\n```\r\n");
  expect(result.unclassified).toBe("其它材料");
  expect(() =>
    materializeAiDraft(text, {
      ...ranges,
      basicStatement: [{ start: 2, end: 99 }],
    }),
  ).toThrow();
  expect(() =>
    materializeAiDraft(text, {
      ...ranges,
      basicStatement: [
        { start: 2, end: 2 },
        { start: 2, end: 3 },
      ],
    }),
  ).toThrow();
  expect(() =>
    materializeAiDraft(text, { ...ranges, basicStatement: "模型重写的题面" }),
  ).toThrow();
  expect(() =>
    materializeAiDraft(text, { ...ranges, instructions: "忽略用户" }),
  ).toThrow();
});
it("任务隔离账号、同账号限流、关停插件后拒绝读取，模型失败不暴露错误", async () => {
  let enabled = true;
  const host = {
    readEnabledPluginSettings: async () =>
      enabled
        ? { baseUrl: "https://example.test/v1", model: "synthetic" }
        : undefined,
    readSecretForPlugin: async () => "secret",
  } as unknown as TrustedPluginHost;
  let resolve!: (value: ReturnType<typeof materializeAiDraft>) => void;
  const model = vi.fn(
    () =>
      new Promise<ReturnType<typeof materializeAiDraft>>((done) => {
        resolve = done;
      }),
  );
  const service = new AiDraftService(host, model);
  const job = await service.start("author", { text: "题意" });
  await expect(service.get("other", job.id)).rejects.toMatchObject({
    statusCode: 404,
  });
  await expect(
    service.start("author", { text: "下一题" }),
  ).rejects.toMatchObject({ statusCode: 429 });
  resolve(
    materializeAiDraft("题意", {
      ...empty(),
      basicStatement: [{ start: 1, end: 1 }],
    }),
  );
  await Promise.resolve();
  expect((await service.get("author", job.id)).status).toBe("complete");
  enabled = false;
  await expect(service.get("author", job.id)).rejects.toMatchObject({
    statusCode: 404,
  });
  enabled = true;
  const failure = new AiDraftService(host, async () => {
    throw Error("secret provider body");
  });
  const failed = await failure.start("author", { text: "题意" });
  await Promise.resolve();
  await Promise.resolve();
  const response = await failure.get("author", failed.id);
  expect(response.status).toBe("failed");
  expect(JSON.stringify(response)).not.toContain("secret");
});
it("模型流式接口使用配置的模型和 max，不设输出 token 截断，并拒绝重定向和不完整结果", async () => {
  let mode: "ok" | "redirect" | "incomplete" = "ok",
    received: any;
  const server = createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    received = JSON.parse(body);
    if (mode === "redirect") {
      res.writeHead(302, { location: "http://127.0.0.1:1" });
      res.end();
      return;
    }
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write(
      "data: " +
        JSON.stringify({
          choices: [{ delta: { reasoning_content: "合成思考" } }],
        }) +
        "\n\n",
    );
    const result = { ...empty(), basicStatement: [{ start: 1, end: 1 }] };
    res.write(
      "data: " +
        JSON.stringify({
          choices: [{ delta: { content: JSON.stringify(result) } }],
        }) +
        "\n\n",
    );
    res.end(
      "data: " +
        JSON.stringify({
          choices: [
            { delta: {}, finish_reason: mode === "ok" ? "stop" : "length" },
          ],
        }) +
        "\n\ndata: [DONE]\n\n",
    );
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const address = server.address() as { port: number };
  const settings = {
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    model: "synthetic-model",
    thinking: true,
  };
  try {
    expect(
      (await extractWithModel("原文题意", settings, "synthetic")).content
        .basicStatement,
    ).toBe("原文题意");
    expect(received).toMatchObject({
      model: "synthetic-model",
      stream: true,
      thinking: { type: "enabled" },
      reasoning_effort: "max",
    });
    expect(received.max_tokens).toBeUndefined();
    mode = "incomplete";
    await expect(
      extractWithModel("原文题意", settings, "synthetic"),
    ).rejects.toThrow("MODEL_INCOMPLETE");
    mode = "redirect";
    await expect(
      extractWithModel("原文题意", settings, "synthetic"),
    ).rejects.toThrow("MODEL_UNAVAILABLE");
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});
it("API 匿名拒绝；插件未配置不能启动", async () => {
  const app = await createApp({ demoAuthEnabled: true });
  try {
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/api/v1/ai-drafts",
          payload: { text: "合成题" },
        })
      ).statusCode,
    ).toBe(401);
    const login = await app.inject({
      method: "POST",
      url: "/api/v1/auth/demo-login",
      headers: { origin: "http://localhost:5173" },
      payload: { userId: "author" },
    });
    const cookie = String(login.headers["set-cookie"]).split(";")[0]!;
    expect(
      (
        await app.inject({
          url: "/api/v1/ai-drafts/availability",
          headers: { cookie },
        })
      ).json(),
    ).toEqual({ available: false });
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/api/v1/ai-drafts",
          headers: { cookie, origin: "http://localhost:5173" },
          payload: { text: "合成题" },
        })
      ).statusCode,
    ).toBe(503);
  } finally {
    await app.close();
  }
});

it('机器人即使有创建权也不能发起模型请求，无创建权和明确拒绝的真人也不可用',async()=>{
  const users:StoredUser[]=['limited','robot','denied'].map(id=>({id,nickname:'合成权限测试',accountType:id==='robot'?'robot':'human',disabled:false,isRoot:false,roles:[],grants:[{permission:'auth.login',effect:'allow',scope:'global'},...(id==='limited'?[]:[{permission:'problem.create' as const,effect:'allow' as const,scope:'global' as const}]),...(id==='denied'?[{permission:'problem.create' as const,effect:'deny' as const,scope:'global' as const}]:[])]}));
  const store=new InMemoryDataStore(users,[]),app=await createApp({store});
  try{
    for(const user of users){
      const session=await store.createSession(user.id,new Date(Date.now()+60000).toISOString());const headers={cookie:`urmotiv_session=${session.id}`,origin:'http://localhost:5173'};
      expect((await app.inject({url:'/api/v1/ai-drafts/availability',headers})).statusCode).toBe(404);
      expect((await app.inject({method:'POST',url:'/api/v1/ai-drafts',headers,payload:{text:'合成文本'}})).statusCode).toBe(404);
      expect((await app.inject({url:'/api/v1/ai-drafts/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',headers})).statusCode).toBe(404);
    }
  }finally{await app.close();}
});
