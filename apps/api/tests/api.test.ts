import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { createApp } from "../src/app";
import { CasClient } from "@urmotiv/auth";
import { InMemoryEmailVerificationOutbox } from "../src/email-verification";

const fullContent = {
  basicStatement: "给定一个整数，输出它本身。",
  basicSolution: "直接输出输入即可。",
  background: "",
  statement: "",
  inputFormat: "",
  outputFormat: "",
  constraints: "",
  solution: "",
  hints: ""
};

const openApps: FastifyInstance[] = [];
const localOrigin = "http://localhost:5173";

afterEach(async () => {
  await Promise.all(openApps.splice(0).map((app) => app.close()));
});

async function makeApp(): Promise<FastifyInstance> {
  const app = await createApp({ demoAuthEnabled: true });
  openApps.push(app);
  return app;
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
  expect(firstCookie).toBeTypeOf("string");
  return (firstCookie as string).split(";", 1)[0] as string;
}

async function createDraft(app: FastifyInstance, cookie: string): Promise<Record<string, unknown>> {
  const response = await app.inject({
    method: "POST",
    url: "/api/v1/problems",
    headers: { cookie, origin: localOrigin },
    payload: {
      title: "演示题目",
      type: "traditional",
      tagIds: ["algorithm.implementation"],
      content: fullContent
    }
  });
  expect(response.statusCode).toBe(200);
  return response.json() as Record<string, unknown>;
}

describe("题目 API", () => {
  it("邮箱注册、登录失败和撤销全部会话都由服务端核验", async () => {
    const outbox = new InMemoryEmailVerificationOutbox();
    const app = await createApp({
      emailRegistrationEnabled: true,
      emailVerificationDelivery: outbox,
      emailVerificationWebUrl: "http://localhost:5173"
    });
    openApps.push(app);
    const registration = await app.inject({
      method: "POST",
      url: "/api/v1/auth/email-register",
      headers: { origin: localOrigin },
      payload: { email: "new.user@example.test", password: "safe-password-123", nickname: "新用户" }
    });
    expect(registration.statusCode).toBe(202);
    expect(registration.json()).toEqual({ ok: true, verificationPending: true });
    expect(outbox.messages).toHaveLength(1);
    const verificationUrl = new URL(outbox.messages[0]!.verificationUrl);
    const token = new URLSearchParams(verificationUrl.hash.split("?", 2)[1]).get("token");
    expect(token).toMatch(/^uve_/);

    const incorrectPassword = await app.inject({
      method: "POST",
      url: "/api/v1/auth/email-login",
      headers: { origin: localOrigin },
      payload: { email: "new.user@example.test", password: "incorrect-password" }
    });
    expect(incorrectPassword.statusCode).toBe(401);

    const verify = await app.inject({
      method: "POST",
      url: "/api/v1/auth/email-verification/verify",
      headers: { origin: localOrigin },
      payload: { token }
    });
    expect(verify.statusCode).toBe(200);
    const replay = await app.inject({
      method: "POST",
      url: "/api/v1/auth/email-verification/verify",
      headers: { origin: localOrigin },
      payload: { token }
    });
    expect(replay.statusCode).toBe(400);

    const signedIn = await app.inject({
      method: "POST",
      url: "/api/v1/auth/email-login",
      headers: { origin: localOrigin },
      payload: { email: "new.user@example.test", password: "safe-password-123" }
    });
    expect(signedIn.statusCode).toBe(200);
    const cookie = (Array.isArray(signedIn.headers["set-cookie"])
      ? signedIn.headers["set-cookie"][0]
      : signedIn.headers["set-cookie"])?.split(";", 1)[0] as string;
    expect(cookie).toContain("urmotiv_session=");

    const logoutAll = await app.inject({
      method: "POST",
      url: "/api/v1/auth/logout-all",
      headers: { cookie, origin: localOrigin }
    });
    expect(logoutAll.statusCode).toBe(200);
    const revokedSession = await app.inject({ method: "GET", url: "/api/v1/session", headers: { cookie } });
    expect(revokedSession.json()).toEqual(expect.objectContaining({ user: null }));

    const resendUnknown = await app.inject({
      method: "POST",
      url: "/api/v1/auth/email-verification/resend",
      headers: { origin: localOrigin },
      payload: { email: "not-registered@example.test" }
    });
    expect(resendUnknown.statusCode).toBe(202);
    expect(outbox.messages).toHaveLength(1);
  });

  it("requires delivery configuration before email registration can be enabled", async () => {
    await expect(createApp({ emailRegistrationEnabled: true })).rejects.toThrow(
      "启用邮箱注册前必须配置服务端邮件投递和验证页面地址"
    );
  });

  it("resending a verification email invalidates the older link", async () => {
    const outbox = new InMemoryEmailVerificationOutbox();
    const app = await createApp({
      emailRegistrationEnabled: true,
      emailVerificationDelivery: outbox,
      emailVerificationWebUrl: "http://localhost:5173"
    });
    openApps.push(app);
    const registration = await app.inject({
      method: "POST",
      url: "/api/v1/auth/email-register",
      headers: { origin: localOrigin },
      payload: { email: "resend.user@example.test", password: "safe-password-123", nickname: "Resend user" }
    });
    expect(registration.statusCode).toBe(202);
    const oldToken = new URLSearchParams(new URL(outbox.messages[0]!.verificationUrl).hash.split("?", 2)[1]).get("token");

    const resend = await app.inject({
      method: "POST",
      url: "/api/v1/auth/email-verification/resend",
      headers: { origin: localOrigin },
      payload: { email: "resend.user@example.test" }
    });
    expect(resend.statusCode).toBe(202);
    const newToken = new URLSearchParams(new URL(outbox.messages[1]!.verificationUrl).hash.split("?", 2)[1]).get("token");
    expect(newToken).not.toBe(oldToken);

    const oldLink = await app.inject({
      method: "POST",
      url: "/api/v1/auth/email-verification/verify",
      headers: { origin: localOrigin },
      payload: { token: oldToken }
    });
    expect(oldLink.statusCode).toBe(400);
    const newLink = await app.inject({
      method: "POST",
      url: "/api/v1/auth/email-verification/verify",
      headers: { origin: localOrigin },
      payload: { token: newToken }
    });
    expect(newLink.statusCode).toBe(200);
  });

  it("CAS 只接受一次性状态和配置的稳定身份字段", async () => {
    const states = new Map<string, { expiresAt: string; consumed: boolean }>();
    const casClient = new CasClient({
      configuration: {
        loginUrl: "https://id.example/cas/login",
        validateUrl: "https://id.example/cas/serviceValidate",
        callbackUrl: "http://localhost:3000/api/v1/auth/cas/callback",
        subjectAttribute: "accountId",
        nicknameAttribute: "name",
        studentIdAttributes: []
      },
      stateSecret: Buffer.alloc(32, 3),
      states: {
        put: async (digest, expiresAt) => { states.set(digest, { expiresAt, consumed: false }); },
        consume: async (digest, now) => {
          const state = states.get(digest);
          if (state === undefined || state.consumed || Date.parse(state.expiresAt) <= Date.parse(now)) return false;
          state.consumed = true;
          return true;
        }
      },
      fetch: async () => new Response(
        "<cas:serviceResponse xmlns:cas=\"http://www.yale.edu/tp/cas\"><cas:authenticationSuccess><cas:user>not-the-subject</cas:user><cas:attributes><cas:accountId>stable-account</cas:accountId><cas:name>CAS 用户</cas:name></cas:attributes></cas:authenticationSuccess></cas:serviceResponse>",
        { status: 200 }
      )
    });
    const app = await createApp({ casClient });
    openApps.push(app);
    const start = await app.inject({ method: "GET", url: "/api/v1/auth/cas/start?returnPath=%2Fproblems" });
    expect(start.statusCode).toBe(302);
    const loginLocation = new URL(start.headers.location as string);
    const serviceUrl = new URL(loginLocation.searchParams.get("service") as string);
    const state = serviceUrl.searchParams.get("state") as string;
    const bindingCookieHeader = Array.isArray(start.headers["set-cookie"])
      ? start.headers["set-cookie"][0]
      : start.headers["set-cookie"];
    expect(bindingCookieHeader).toBeTypeOf("string");
    const bindingCookie = bindingCookieHeader!.split(";", 1)[0]!;
    const callback = await app.inject({
      method: "GET",
      url: `/api/v1/auth/cas/callback?state=${encodeURIComponent(state)}&ticket=ticket-1`,
      headers: { cookie: bindingCookie }
    });
    expect(callback.statusCode).toBe(302);
    expect(callback.headers.location).toBe("/problems");
    const replay = await app.inject({
      method: "GET",
      url: `/api/v1/auth/cas/callback?state=${encodeURIComponent(state)}&ticket=ticket-2`,
      headers: { cookie: bindingCookie }
    });
    expect(replay.statusCode).toBe(401);
  });

  it("默认关闭演示登录并在会话信息中如实返回", async () => {
    const app = await createApp();
    openApps.push(app);

    const session = await app.inject({ method: "GET", url: "/api/v1/session" });
    expect(session.statusCode).toBe(200);
    expect(session.json()).toEqual(
      expect.objectContaining({ auth: expect.objectContaining({ demoEnabled: false }) })
    );

    const users = await app.inject({ method: "GET", url: "/api/v1/auth/demo-users" });
    expect(users.statusCode).toBe(404);
    const loginResponse = await app.inject({
      method: "POST",
      url: "/api/v1/auth/demo-login",
      headers: { origin: localOrigin },
      payload: { userId: "author" }
    });
    expect(loginResponse.statusCode).toBe(404);
  });

  it("允许两个本机开发来源并拒绝未配置来源", async () => {
    const app = await makeApp();
    const allowed = await app.inject({
      method: "POST",
      url: "/api/v1/auth/demo-login",
      headers: { origin: "http://127.0.0.1:5173" },
      payload: { userId: "author" }
    });
    expect(allowed.statusCode).toBe(200);
    const allowedCookieHeader = allowed.headers["set-cookie"];
    const allowedCookie = (
      Array.isArray(allowedCookieHeader) ? allowedCookieHeader[0] : allowedCookieHeader
    )?.split(";", 1)[0];
    expect(allowedCookie).toBeTypeOf("string");

    const cookieWriteWithoutOrigin = await app.inject({
      method: "POST",
      url: "/api/v1/problems",
      headers: { cookie: allowedCookie as string },
      payload: { title: "缺少来源", type: "traditional" }
    });
    expect(cookieWriteWithoutOrigin.statusCode).toBe(403);

    const denied = await app.inject({
      method: "POST",
      url: "/api/v1/auth/demo-login",
      headers: { origin: "https://untrusted.example" },
      payload: { userId: "author" }
    });
    expect(denied.statusCode).toBe(403);
    expect(denied.json()).toEqual({
      error: expect.objectContaining({ code: "FORBIDDEN" })
    });

    const missingOrigin = await app.inject({
      method: "POST",
      url: "/api/v1/auth/demo-login",
      payload: { userId: "author" }
    });
    expect(missingOrigin.statusCode).toBe(403);

    const nullOrigin = await app.inject({
      method: "POST",
      url: "/api/v1/auth/demo-login",
      headers: { origin: "null" },
      payload: { userId: "author" }
    });
    expect(nullOrigin.statusCode).toBe(403);
  });

  it("创建题目后，只让有查看权的用户读取", async () => {
    const app = await makeApp();
    const authorCookie = await login(app, "author");
    const problem = await createDraft(app, authorCookie);
    const problemId = problem.id as string;

    const ownRead = await app.inject({
      method: "GET",
      url: `/api/v1/problems/${problemId}`,
      headers: { cookie: authorCookie }
    });
    expect(ownRead.statusCode).toBe(200);

    const deniedCookie = await login(app, "denied");
    const foreignRead = await app.inject({
      method: "GET",
      url: `/api/v1/problems/${problemId}`,
      headers: { cookie: deniedCookie }
    });
    expect(foreignRead.statusCode).toBe(404);
    expect(foreignRead.json()).toEqual({
      error: expect.objectContaining({ code: "NOT_FOUND" })
    });

    const foreignReviews = await app.inject({
      method: "GET",
      url: `/api/v1/problems/${problemId}/reviews`,
      headers: { cookie: deniedCookie }
    });
    expect(foreignReviews.statusCode).toBe(404);

    const hiddenList = await app.inject({
      method: "GET",
      url: "/api/v1/problems",
      headers: { cookie: deniedCookie }
    });
    expect(hiddenList.statusCode).toBe(200);
    expect(hiddenList.json()).toEqual(expect.objectContaining({ items: [], total: 0 }));

    const foreignUpdate = await app.inject({
      method: "PATCH",
      url: `/api/v1/problems/${problemId}`,
      headers: { cookie: deniedCookie, origin: localOrigin },
      payload: { expectedRevision: 1, title: "不能看到也不能修改" }
    });
    expect(foreignUpdate.statusCode).toBe(404);
  });

  it("提交后只冻结基础题面和基础题解，题目名称可继续编辑", async () => {
    const app = await makeApp();
    const authorCookie = await login(app, "author");
    const problem = await createDraft(app, authorCookie);
    const problemId = problem.id as string;

    const submit = await app.inject({
      method: "POST",
      url: `/api/v1/problems/${problemId}/submit`,
      headers: { cookie: authorCookie, origin: localOrigin },
      payload: { expectedRevision: 1 }
    });
    expect(submit.statusCode).toBe(200);

    const leaderCookie = await login(app, "leader");
    const leaderView = await app.inject({
      method: "GET",
      url: `/api/v1/problems/${problemId}`,
      headers: { cookie: leaderCookie }
    });
    expect(leaderView.statusCode).toBe(200);
    expect(leaderView.json()).toEqual(
      expect.objectContaining({
        capabilities: expect.objectContaining({ canEditFrozen: true, canEditTitle: true })
      })
    );

    // 题目名称在待审核状态可编辑（有编辑权限的用户）。
    const leaderTitleUpdate = await app.inject({
      method: "PATCH",
      url: `/api/v1/problems/${problemId}`,
      headers: { cookie: leaderCookie, origin: localOrigin },
      payload: { expectedRevision: 2, title: "组长可以修改名称" }
    });
    expect(leaderTitleUpdate.statusCode).toBe(200);
    expect(leaderTitleUpdate.json()).toEqual(
      expect.objectContaining({ title: "组长可以修改名称", revision: 3 })
    );

    // 作者也可以编辑名称。
    const authorTitleUpdate = await app.inject({
      method: "PATCH",
      url: `/api/v1/problems/${problemId}`,
      headers: { cookie: authorCookie, origin: localOrigin },
      payload: { expectedRevision: 3, title: "作者也可以改名称" }
    });
    expect(authorTitleUpdate.statusCode).toBe(200);
    expect(authorTitleUpdate.json()).toEqual(
      expect.objectContaining({ title: "作者也可以改名称", revision: 4 })
    );

    // 基础题面和基础题解仍然冻结。
    const frozenStatementUpdate = await app.inject({
      method: "PATCH",
      url: `/api/v1/problems/${problemId}`,
      headers: { cookie: authorCookie, origin: localOrigin },
      payload: {
        expectedRevision: 4,
        content: { ...fullContent, basicStatement: "不能修改的题面" }
      }
    });
    expect(frozenStatementUpdate.statusCode).toBe(409);
    expect(frozenStatementUpdate.json()).toEqual({
      error: expect.objectContaining({
        code: "CONFLICT",
        fieldErrors: expect.objectContaining({ "content.basicStatement": expect.any(Array) })
      })
    });

    const frozenSolutionUpdate = await app.inject({
      method: "PATCH",
      url: `/api/v1/problems/${problemId}`,
      headers: { cookie: authorCookie, origin: localOrigin },
      payload: {
        expectedRevision: 4,
        content: { ...fullContent, basicSolution: "不能修改的题解" }
      }
    });
    expect(frozenSolutionUpdate.statusCode).toBe(409);
    expect(frozenSolutionUpdate.json()).toEqual({
      error: expect.objectContaining({
        code: "CONFLICT",
        fieldErrors: expect.objectContaining({ "content.basicSolution": expect.any(Array) })
      })
    });

    // 非冻结内容仍可补充。
    const editableContent = { ...fullContent, background: "这部分可在审核中继续完善。" };
    const normalUpdate = await app.inject({
      method: "PATCH",
      url: `/api/v1/problems/${problemId}`,
      headers: { cookie: authorCookie, origin: localOrigin },
      payload: { expectedRevision: 4, content: editableContent }
    });
    expect(normalUpdate.statusCode).toBe(200);
    expect(normalUpdate.json()).toEqual(
      expect.objectContaining({ status: "pending_review", revision: 5 })
    );
  });

  it("持有冻结编辑权限的组长可改基础题面题解，无权限者与显式拒绝者仍被拦截", async () => {
    const app = await makeApp();
    const authorCookie = await login(app, "author");
    const problem = await createDraft(app, authorCookie);
    const problemId = problem.id as string;
    const submit = await app.inject({
      method: "POST",
      url: `/api/v1/problems/${problemId}/submit`,
      headers: { cookie: authorCookie, origin: localOrigin },
      payload: { expectedRevision: 1 }
    });
    expect(submit.statusCode).toBe(200);

    // 组长持 problem.frozen.edit，待审核状态下可修改冻结的基础题面。
    const leaderCookie = await login(app, "leader");
    const leaderFrozenEdit = await app.inject({
      method: "PATCH",
      url: `/api/v1/problems/${problemId}`,
      headers: { cookie: leaderCookie, origin: localOrigin },
      payload: {
        expectedRevision: 2,
        content: { ...fullContent, basicStatement: "组长在审核中补充的题面" }
      }
    });
    expect(leaderFrozenEdit.statusCode).toBe(200);
    expect(leaderFrozenEdit.json()).toEqual(
      expect.objectContaining({
        status: "pending_review",
        revision: 3,
        content: expect.objectContaining({ basicStatement: "组长在审核中补充的题面" })
      })
    );

    // 审题人没有题目编辑权限，整个修改被拒绝（403）。
    const reviewerCookie = await login(app, "reviewer");
    const reviewerFrozenEdit = await app.inject({
      method: "PATCH",
      url: `/api/v1/problems/${problemId}`,
      headers: { cookie: reviewerCookie, origin: localOrigin },
      payload: {
        expectedRevision: 3,
        content: { ...fullContent, basicSolution: "审题人不能改的题解" }
      }
    });
    expect(reviewerFrozenEdit.statusCode).toBe(403);

    // 命题组成员有编辑权限但没有冻结编辑权限，改基础题解被冻结规则拒绝（409）。
    const memberCookie = await login(app, "member");
    const memberFrozenEdit = await app.inject({
      method: "PATCH",
      url: `/api/v1/problems/${problemId}`,
      headers: { cookie: memberCookie, origin: localOrigin },
      payload: {
        expectedRevision: 3,
        content: { ...fullContent, basicSolution: "成员不能改的题解" }
      }
    });
    expect(memberFrozenEdit.statusCode).toBe(409);
    expect(memberFrozenEdit.json()).toEqual({
      error: expect.objectContaining({
        code: "CONFLICT",
        fieldErrors: expect.objectContaining({ "content.basicSolution": expect.any(Array) })
      })
    });

    // 显式 deny 优先于角色权限，被拒绝的组长同样被拦截。
    const deniedLeaderCookie = await login(app, "frozenDeniedLeader");
    const deniedFrozenEdit = await app.inject({
      method: "PATCH",
      url: `/api/v1/problems/${problemId}`,
      headers: { cookie: deniedLeaderCookie, origin: localOrigin },
      payload: {
        expectedRevision: 3,
        content: { ...fullContent, basicStatement: "被拒绝的组长不能改" }
      }
    });
    expect(deniedFrozenEdit.statusCode).toBe(409);
    expect(deniedFrozenEdit.json()).toEqual({
      error: expect.objectContaining({
        code: "CONFLICT",
        fieldErrors: expect.objectContaining({ "content.basicStatement": expect.any(Array) })
      })
    });

    // 作者仍无冻结编辑权限。
    const authorFrozenEdit = await app.inject({
      method: "PATCH",
      url: `/api/v1/problems/${problemId}`,
      headers: { cookie: authorCookie, origin: localOrigin },
      payload: {
        expectedRevision: 3,
        content: { ...fullContent, basicStatement: "作者不能改的题面" }
      }
    });
    expect(authorFrozenEdit.statusCode).toBe(409);
  });

  it("已通过题目只有冻结编辑权限持有者可修改基础字段", async () => {
    const app = await makeApp();
    const authorCookie = await login(app, "author");
    const problem = await createDraft(app, authorCookie);
    const problemId = problem.id as string;
    const submit = await app.inject({
      method: "POST",
      url: `/api/v1/problems/${problemId}/submit`,
      headers: { cookie: authorCookie, origin: localOrigin },
      payload: { expectedRevision: 1 }
    });
    expect(submit.statusCode).toBe(200);

    const reviewBody = {
      verdict: "approve",
      codeforcesDifficulty: 1200,
      qualityLevel: 3,
      originalityLevel: 3,
      thinkingLevel: 2,
      codingLevel: 1,
      tagIds: ["algorithm.implementation"],
      improvements: "可以补充边界情况说明。",
      expectedRound: 1
    };
    const robotCookie = await login(app, "robot");
    const reviewerCookie = await login(app, "reviewer");
    const memberCookie = await login(app, "member");
    const [robotReview, reviewerReview, memberReview] = await Promise.all([
      app.inject({
        method: "POST",
        url: `/api/v1/problems/${problemId}/reviews`,
        headers: { cookie: robotCookie, origin: localOrigin },
        payload: reviewBody
      }),
      app.inject({
        method: "POST",
        url: `/api/v1/problems/${problemId}/reviews`,
        headers: { cookie: reviewerCookie, origin: localOrigin },
        payload: reviewBody
      }),
      app.inject({
        method: "POST",
        url: `/api/v1/problems/${problemId}/reviews`,
        headers: { cookie: memberCookie, origin: localOrigin },
        payload: reviewBody
      })
    ]);
    expect(robotReview.statusCode).toBe(200);
    expect(reviewerReview.statusCode).toBe(200);
    expect(memberReview.statusCode).toBe(200);

    const approved = await app.inject({
      method: "GET",
      url: `/api/v1/problems/${problemId}`,
      headers: { cookie: authorCookie }
    });
    expect(approved.statusCode).toBe(200);
    const approvedBody = approved.json() as Record<string, unknown>;
    expect(approvedBody).toEqual(expect.objectContaining({ status: "approved" }));
    const approvedRevision = approvedBody.revision as number;

    // 组长可修改已通过题目的基础题解。
    const leaderCookie = await login(app, "leader");
    const leaderFrozenEdit = await app.inject({
      method: "PATCH",
      url: `/api/v1/problems/${problemId}`,
      headers: { cookie: leaderCookie, origin: localOrigin },
      payload: {
        expectedRevision: approvedRevision,
        content: { ...fullContent, basicSolution: "组长修正的已通过题解" }
      }
    });
    expect(leaderFrozenEdit.statusCode).toBe(200);
    expect(leaderFrozenEdit.json()).toEqual(
      expect.objectContaining({
        status: "approved",
        revision: approvedRevision + 1,
        content: expect.objectContaining({ basicSolution: "组长修正的已通过题解" })
      })
    );

    // 作者对已通过题目的基础题面仍被冻结。
    const authorFrozenEdit = await app.inject({
      method: "PATCH",
      url: `/api/v1/problems/${problemId}`,
      headers: { cookie: authorCookie, origin: localOrigin },
      payload: {
        expectedRevision: approvedRevision + 1,
        content: { ...fullContent, basicStatement: "作者不能在通过后改题面" }
      }
    });
    expect(authorFrozenEdit.statusCode).toBe(409);
    expect(authorFrozenEdit.json()).toEqual({
      error: expect.objectContaining({
        code: "CONFLICT",
        fieldErrors: expect.objectContaining({ "content.basicStatement": expect.any(Array) })
      })
    });
  });

  it("审核意见按当前轮次聚合，并在两个通过意见后更新状态", async () => {
    const app = await makeApp();
    const authorCookie = await login(app, "author");
    const problem = await createDraft(app, authorCookie);
    const problemId = problem.id as string;
    const submit = await app.inject({
      method: "POST",
      url: `/api/v1/problems/${problemId}/submit`,
      headers: { cookie: authorCookie, origin: localOrigin },
      payload: { expectedRevision: 1 }
    });
    expect(submit.statusCode).toBe(200);

    const reviewBody = {
      verdict: "approve",
      codeforcesDifficulty: 1200,
      qualityLevel: 3,
      originalityLevel: 3,
      thinkingLevel: 2,
      codingLevel: 1,
      tagIds: ["algorithm.implementation"],
      improvements: "可以补充边界情况说明。",
      expectedRound: 1
    };
    const robotCookie = await login(app, "robot");
    const robotReview = await app.inject({
      method: "POST",
      url: `/api/v1/problems/${problemId}/reviews`,
      headers: { cookie: robotCookie, origin: localOrigin },
      payload: reviewBody
    });
    expect(robotReview.statusCode).toBe(200);
    expect(robotReview.json()).toEqual(
      expect.objectContaining({
        status: "waiting",
        approvals: 0,
        reviews: [expect.objectContaining({ source: "fermata" })]
      })
    );

    const reviewerCookie = await login(app, "reviewer");
    const memberCookie = await login(app, "member");
    const [firstReview, secondReview] = await Promise.all([
      app.inject({
        method: "POST",
        url: `/api/v1/problems/${problemId}/reviews`,
        headers: { cookie: reviewerCookie, origin: localOrigin },
        payload: reviewBody
      }),
      app.inject({
        method: "POST",
        url: `/api/v1/problems/${problemId}/reviews`,
        headers: { cookie: memberCookie, origin: localOrigin },
        payload: reviewBody
      })
    ]);
    expect(firstReview.statusCode).toBe(200);
    expect(secondReview.statusCode).toBe(200);
    const summaries = [firstReview.json(), secondReview.json()];
    expect(summaries.map((summary) => summary.status).sort()).toEqual(["approved", "waiting"]);
    expect(summaries.map((summary) => summary.approvals).sort()).toEqual([1, 2]);

    const approved = await app.inject({
      method: "GET",
      url: `/api/v1/problems/${problemId}`,
      headers: { cookie: authorCookie }
    });
    expect(approved.statusCode).toBe(200);
    expect(approved.json()).toEqual(expect.objectContaining({ status: "approved" }));
  });

  it("公开评论对作者可见，私密备注只对审核相关成员可见", async () => {
    const app = await makeApp();
    const authorCookie = await login(app, "author");
    const problem = await createDraft(app, authorCookie);
    const problemId = problem.id as string;
    const submit = await app.inject({
      method: "POST",
      url: `/api/v1/problems/${problemId}/submit`,
      headers: { cookie: authorCookie, origin: localOrigin },
      payload: { expectedRevision: 1 }
    });
    expect(submit.statusCode).toBe(200);

    const reviewerCookie = await login(app, "reviewer");
    const reviewPayload = {
      verdict: "request_changes",
      codeforcesDifficulty: 1200,
      qualityLevel: 3,
      originalityLevel: 3,
      thinkingLevel: 2,
      codingLevel: 1,
      tagIds: ["algorithm.implementation"],
      improvements: "补充边界说明。",
      publicComment: "这条公开评论可供作者修改题目时参考。",
      privateNote: "仅审核相关成员可见",
      expectedRound: 1
    };
    const review = await app.inject({
      method: "POST",
      url: `/api/v1/problems/${problemId}/reviews`,
      headers: { cookie: reviewerCookie, origin: localOrigin },
      payload: reviewPayload
    });
    expect(review.statusCode).toBe(200);
    const updatedReview = await app.inject({
      method: "POST",
      url: `/api/v1/problems/${problemId}/reviews`,
      headers: { cookie: reviewerCookie, origin: localOrigin },
      payload: {
        ...reviewPayload,
        publicComment: "更新后的公开评论仍然对作者可见。"
      }
    });
    expect(updatedReview.statusCode).toBe(200);
    expect(updatedReview.json().reviews).toEqual([
      expect.objectContaining({ publicComment: "更新后的公开评论仍然对作者可见。" })
    ]);

    const readReview = async (cookie: string): Promise<{
      publicComment: string;
      privateNote: string;
    }> => {
      const response = await app.inject({
        method: "GET",
        url: `/api/v1/problems/${problemId}/reviews`,
        headers: { cookie }
      });
      expect(response.statusCode).toBe(200);
      return response.json().reviews[0] as { publicComment: string; privateNote: string };
    };

    expect(await readReview(authorCookie)).toEqual(expect.objectContaining({
      publicComment: "更新后的公开评论仍然对作者可见。",
      privateNote: ""
    }));
    expect((await readReview(reviewerCookie)).privateNote).toBe("仅审核相关成员可见");
    expect((await readReview(await login(app, "member"))).privateNote)
      .toBe("仅审核相关成员可见");
    expect((await readReview(await login(app, "leader"))).privateNote)
      .toBe("仅审核相关成员可见");
  });

  it("拒绝浏览器提交的状态字段和过期修订号", async () => {
    const app = await makeApp();
    const authorCookie = await login(app, "author");
    const problem = await createDraft(app, authorCookie);
    const problemId = problem.id as string;

    const forbiddenField = await app.inject({
      method: "PATCH",
      url: `/api/v1/problems/${problemId}`,
      headers: { cookie: authorCookie, origin: localOrigin },
      payload: { expectedRevision: 1, status: "approved" }
    });
    expect(forbiddenField.statusCode).toBe(422);

    const staleUpdate = await app.inject({
      method: "PATCH",
      url: `/api/v1/problems/${problemId}`,
      headers: { cookie: authorCookie, origin: localOrigin },
      payload: { expectedRevision: 9, title: "新的标题" }
    });
    expect(staleUpdate.statusCode).toBe(409);
  });
});
