import { defaultReviewRuleId } from "@urmotiv/plugin-review-default";
import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app";
import { createDemoUsers, demoTags } from "../src/demo-data";
import type { StoredUser } from "../src/domain";
import { InMemoryDataStore } from "../src/repository";

const origin = "http://localhost:5173";
const privateCacheControl = "private, no-store";
const settingsFieldName = "requiredApprovals";
const openApps: FastifyInstance[] = [];

afterEach(async () => {
  await Promise.all(openApps.splice(0).map(async (app) => app.close()));
});

async function makeApp(users: StoredUser[] = createDemoUsers()): Promise<FastifyInstance> {
  const app = await createApp({
    store: new InMemoryDataStore(users, demoTags),
    demoAuthEnabled: true,
    demoUserIds: users.map((user) => user.id)
  });
  openApps.push(app);
  return app;
}

async function login(app: FastifyInstance, userId: string): Promise<string> {
  const response = await app.inject({
    method: "POST",
    url: "/api/v1/auth/demo-login",
    headers: { origin },
    payload: { userId }
  });
  expect(response.statusCode).toBe(200);
  const setCookie = response.headers["set-cookie"];
  const firstCookie = Array.isArray(setCookie) ? setCookie[0] : setCookie;
  expect(firstCookie).toBeTypeOf("string");
  return (firstCookie as string).split(";", 1)[0]!;
}

function policyInput(expectedRevision: number, requiredApprovals: number) {
  return {
    ruleId: defaultReviewRuleId,
    settings: {
      requiredApprovals,
      maximumRejections: 0,
      countRobotReviews: false
    },
    expectedRevision
  };
}

describe("审核规则 HTTP 接口", () => {
  it("成功读写以及版本冲突和设置错误均禁止缓存", async () => {
    const app = await makeApp();
    const leaderCookie = await login(app, "leader");

    const initial = await app.inject({
      method: "GET",
      url: "/api/v1/review-policy",
      headers: { cookie: leaderCookie }
    });
    expect(initial.statusCode).toBe(200);
    expect(initial.headers["cache-control"]).toBe(privateCacheControl);
    expect(initial.json()).toMatchObject({
      selectedRuleId: defaultReviewRuleId,
      revision: 1
    });

    const invalid = await app.inject({
      method: "PATCH",
      url: "/api/v1/review-policy",
      headers: { cookie: leaderCookie, origin },
      payload: policyInput(1, 0)
    });
    expect(invalid.statusCode).toBe(422);
    expect(invalid.headers["cache-control"]).toBe(privateCacheControl);

    const updated = await app.inject({
      method: "PATCH",
      url: "/api/v1/review-policy",
      headers: { cookie: leaderCookie, origin },
      payload: policyInput(1, 3)
    });
    expect(updated.statusCode).toBe(200);
    expect(updated.headers["cache-control"]).toBe(privateCacheControl);
    expect(updated.json()).toMatchObject({
      selectedRuleId: defaultReviewRuleId,
      settings: { requiredApprovals: 3 },
      revision: 2
    });

    const stale = await app.inject({
      method: "PATCH",
      url: "/api/v1/review-policy",
      headers: { cookie: leaderCookie, origin },
      payload: policyInput(1, 4)
    });
    expect(stale.statusCode).toBe(409);
    expect(stale.headers["cache-control"]).toBe(privateCacheControl);
  });

  it("无最终决定权限时不能读取或修改，也不会得到规则和设置名称", async () => {
    const app = await makeApp();
    const reviewerCookie = await login(app, "reviewer");

    const read = await app.inject({
      method: "GET",
      url: "/api/v1/review-policy",
      headers: { cookie: reviewerCookie }
    });
    expect(read.statusCode).toBe(403);
    expect(read.headers["cache-control"]).toBe(privateCacheControl);
    expect(read.json()).toMatchObject({
      error: { code: "FORBIDDEN", message: "你没有执行此操作的权限。" }
    });
    expect(read.body).not.toContain(defaultReviewRuleId);
    expect(read.body).not.toContain(settingsFieldName);

    const write = await app.inject({
      method: "PATCH",
      url: "/api/v1/review-policy",
      headers: { cookie: reviewerCookie, origin },
      payload: policyInput(1, 9)
    });
    expect(write.statusCode).toBe(403);
    expect(write.headers["cache-control"]).toBe(privateCacheControl);
    expect(write.json()).toMatchObject({
      error: { code: "FORBIDDEN", message: "你没有执行此操作的权限。" }
    });
    expect(write.body).not.toContain(defaultReviewRuleId);
    expect(write.body).not.toContain(settingsFieldName);
  });

  it("无权账号提交畸形正文时先按权限拒绝，不返回字段结构", async () => {
    const demoUsers = createDemoUsers();
    const reviewer = demoUsers.find((user) => user.id === "reviewer");
    const leader = demoUsers.find((user) => user.id === "leader");
    if (reviewer === undefined || leader === undefined) {
      throw new Error("测试账号缺失");
    }
    const explicitlyDenied: StoredUser = {
      ...leader,
      id: "review-policy-denied",
      nickname: "明确拒绝账号",
      grants: [
        ...leader.grants,
        {
          permission: "review.policy.manage",
          effect: "deny",
          scope: "global"
        }
      ]
    };
    const robot: StoredUser = {
      ...leader,
      id: "review-policy-robot",
      nickname: "机器人账号",
      accountType: "robot"
    };
    const blockedUsers = [reviewer, explicitlyDenied, robot];
    const app = await makeApp(blockedUsers);

    for (const user of blockedUsers) {
      const cookie = await login(app, user.id);
      const response = await app.inject({
        method: "PATCH",
        url: "/api/v1/review-policy",
        headers: { cookie, origin },
        payload: {
          ruleId: 7,
          settings: "不应进入正文校验",
          expectedRevision: "invalid"
        }
      });

      expect(response.statusCode, user.id).toBe(403);
      expect(response.headers["cache-control"], user.id).toBe(privateCacheControl);
      expect(response.json(), user.id).toMatchObject({
        error: { code: "FORBIDDEN", message: "你没有执行此操作的权限。" }
      });
      expect(response.body, user.id).not.toContain("ruleId");
      expect(response.body, user.id).not.toContain("expectedRevision");
      expect(response.body, user.id).not.toContain(defaultReviewRuleId);
      expect(response.body, user.id).not.toContain(settingsFieldName);
    }
  });
});
