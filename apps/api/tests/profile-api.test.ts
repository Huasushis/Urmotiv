import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { createApp } from "../src/app";
import { avatarMaxBytes } from "../src/avatar";

const openApps: FastifyInstance[] = [];
const localOrigin = "http://localhost:5173";

function pngBytes(extra: number[] = []): Uint8Array<ArrayBuffer> {
  return new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...extra]);
}

function invalidImageBytes(): Uint8Array<ArrayBuffer> {
  return new TextEncoder().encode("这不是一张图片");
}

afterEach(async () => {
  await Promise.all(openApps.splice(0).map((app) => app.close()));
});

async function makeApp(overrides: Record<string, unknown> = {}): Promise<FastifyInstance> {
  const app = await createApp({ demoAuthEnabled: true, ...overrides });
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
  return (firstCookie as string).split(";", 1)[0] as string;
}

describe("个人资料 API", () => {
  it("未登录时个人资料与头像接口统一返回 401", async () => {
    const app = await makeApp();
    expect((await app.inject({ method: "GET", url: "/api/v1/me" })).statusCode).toBe(401);
    expect(
      (
        await app.inject({
          method: "PATCH",
          url: "/api/v1/me",
          headers: { origin: localOrigin },
          payload: {}
        })
      ).statusCode
    ).toBe(401);
    expect(
      (
        await app.inject({
          method: "PUT",
          url: "/api/v1/me/avatar",
          headers: { origin: localOrigin },
          payload: new Uint8Array([1, 2, 3])
        })
      ).statusCode
    ).toBe(401);
    expect(
      (await app.inject({ method: "DELETE", url: "/api/v1/me/avatar", headers: { origin: localOrigin } }))
        .statusCode
    ).toBe(401);
    expect(
      (
        await app.inject({
          method: "GET",
          url: "/api/v1/users/author/avatar"
        })
      ).statusCode
    ).toBe(401);
  });

  it("已停用账号无法登录，个人资料接口由此不可达", async () => {
    const app = await makeApp();
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/auth/demo-login",
      headers: { origin: localOrigin },
      payload: { userId: "disabled" }
    });
    expect(response.statusCode).toBe(401);
  });

  it("读取自己的资料返回完整字段，QQ 号只在个人资料中出现", async () => {
    const app = await makeApp();
    const cookie = await login(app, "author");
    const profile = await app.inject({ method: "GET", url: "/api/v1/me", headers: { cookie } });
    expect(profile.statusCode).toBe(200);
    expect(profile.json()).toEqual(
      expect.objectContaining({
        id: "author",
        nickname: "投稿人演示账号",
        accountType: "human",
        email: null,
        emailVerified: false,
        qq: null,
        avatarSource: "none",
        avatarUrl: null,
        studentIds: []
      })
    );

    // QQ 号不会出现在公开的用户列表里。
    const demoUsers = await app.inject({
      method: "GET",
      url: "/api/v1/auth/demo-users",
      headers: { cookie }
    });
    expect(demoUsers.statusCode).toBe(200);
    for (const item of demoUsers.json().items) {
      expect(item).not.toHaveProperty("qq");
    }
  });

  it("更新昵称与 QQ 号，非法 QQ 号被拒绝", async () => {
    const app = await makeApp();
    const cookie = await login(app, "author");

    const invalidQq = await app.inject({
      method: "PATCH",
      url: "/api/v1/me",
      headers: { cookie, origin: localOrigin },
      payload: { qq: "123" }
    });
    expect(invalidQq.statusCode).toBe(422);
    expect(invalidQq.json()).toEqual(
      expect.objectContaining({
        error: expect.objectContaining({
          code: "INVALID_INPUT",
          fieldErrors: expect.objectContaining({ qq: expect.any(Array) })
        })
      })
    );

    const updated = await app.inject({
      method: "PATCH",
      url: "/api/v1/me",
      headers: { cookie, origin: localOrigin },
      payload: { nickname: "新昵称", qq: "123456789" }
    });
    expect(updated.statusCode).toBe(200);
    expect(updated.json()).toEqual(
      expect.objectContaining({ nickname: "新昵称", qq: "123456789" })
    );

    const again = await app.inject({ method: "GET", url: "/api/v1/me", headers: { cookie } });
    expect(again.json()).toEqual(
      expect.objectContaining({ nickname: "新昵称", qq: "123456789" })
    );
  });

  it("上传头像只接受受支持的图片，超限与非法内容被拒绝", async () => {
    const app = await makeApp();
    const cookie = await login(app, "author");

    const invalid = await app.inject({
      method: "PUT",
      url: "/api/v1/me/avatar",
      headers: { cookie, origin: localOrigin, "content-type": "application/octet-stream" },
      payload: invalidImageBytes()
    });
    expect(invalid.statusCode).toBe(409);
    expect(invalid.json()).toEqual(
      expect.objectContaining({
        error: expect.objectContaining({ code: "CONFLICT" })
      })
    );

    const tooLarge = await app.inject({
      method: "PUT",
      url: "/api/v1/me/avatar",
      headers: { cookie, origin: localOrigin, "content-type": "application/octet-stream" },
      payload: Buffer.concat([
        Buffer.from(pngBytes()),
        Buffer.alloc(avatarMaxBytes)
      ])
    });
    expect(tooLarge.statusCode).toBe(413);
    expect(tooLarge.json()).toEqual(
      expect.objectContaining({
        error: expect.objectContaining({ code: "FILE_TOO_LARGE" })
      })
    );

    const uploaded = await app.inject({
      method: "PUT",
      url: "/api/v1/me/avatar",
      headers: { cookie, origin: localOrigin, "content-type": "application/octet-stream" },
      payload: Buffer.from(pngBytes([1, 2, 3]))
    });
    expect(uploaded.statusCode).toBe(200);
    expect(uploaded.json()).toEqual(
      expect.objectContaining({
        avatarSource: "uploaded",
        avatarUrl: "/api/v1/users/author/avatar"
      })
    );

    const avatar = await app.inject({
      method: "GET",
      url: "/api/v1/users/author/avatar",
      headers: { cookie }
    });
    expect(avatar.statusCode).toBe(200);
    expect(avatar.headers["content-type"]).toBe("image/png");
    expect(avatar.rawPayload).toEqual(Buffer.from(pngBytes([1, 2, 3])));
  });

  it("删除头像后来源回到 none，头像地址返回 404", async () => {
    const app = await makeApp();
    const cookie = await login(app, "author");
    await app.inject({
      method: "PUT",
      url: "/api/v1/me/avatar",
      headers: { cookie, origin: localOrigin, "content-type": "application/octet-stream" },
      payload: Buffer.from(pngBytes())
    });

    const cleared = await app.inject({
      method: "DELETE",
      url: "/api/v1/me/avatar",
      headers: { cookie, origin: localOrigin }
    });
    expect(cleared.statusCode).toBe(200);
    expect(cleared.json()).toEqual(
      expect.objectContaining({ avatarSource: "none", avatarUrl: null })
    );

    const avatar = await app.inject({
      method: "GET",
      url: "/api/v1/users/author/avatar",
      headers: { cookie }
    });
    expect(avatar.statusCode).toBe(404);
  });

  it("QQ 头像经服务端代理返回，不向浏览器暴露 QQ 号码", async () => {
    const fetchedQqNumbers: string[] = [];
    const proxiedPng = pngBytes([9, 9]);
    const fetchImpl: typeof fetch = async (url) => {
      const raw = String(url);
      const match = /nk=(\d+)/.exec(raw);
      if (match !== null) {
        fetchedQqNumbers.push(match[1]!);
      }
      return new Response(proxiedPng, { status: 200 });
    };
    const app = await makeApp({ fetchImpl });
    const cookie = await login(app, "author");

    // 未填 QQ 时选择 QQ 头像被拒绝。
    const noQq = await app.inject({
      method: "PATCH",
      url: "/api/v1/me",
      headers: { cookie, origin: localOrigin },
      payload: { avatarSource: "qq" }
    });
    expect(noQq.statusCode).toBe(409);

    await app.inject({
      method: "PATCH",
      url: "/api/v1/me",
      headers: { cookie, origin: localOrigin },
      payload: { qq: "88888888", avatarSource: "qq" }
    });
    const profile = await app.inject({ method: "GET", url: "/api/v1/me", headers: { cookie } });
    expect(profile.json()).toEqual(
      expect.objectContaining({
        qq: "88888888",
        avatarSource: "qq",
        avatarUrl: "/api/v1/users/author/avatar"
      })
    );

    // 头像地址本身不含 QQ 号码。
    expect((profile.json() as { avatarUrl: string }).avatarUrl).not.toContain("88888888");

    const avatar = await app.inject({
      method: "GET",
      url: "/api/v1/users/author/avatar",
      headers: { cookie }
    });
    expect(avatar.statusCode).toBe(200);
    expect(avatar.headers["content-type"]).toBe("image/png");
    expect(fetchedQqNumbers).toEqual(["88888888"]);
    expect(avatar.headers["cache-control"]).toBe("private, max-age=3600");

    // 公开用户列表依然不出现 QQ 号码。
    const demoUsers = await app.inject({
      method: "GET",
      url: "/api/v1/auth/demo-users",
      headers: { cookie }
    });
    for (const item of demoUsers.json().items) {
      expect(JSON.stringify(item)).not.toContain("88888888");
    }
  });

  it("QQ 头像抓取失败时头像按不存在处理，不暴露用户", async () => {
    const failingFetch: typeof fetch = async () => new Response("boom", { status: 502 });
    const app = await makeApp({ fetchImpl: failingFetch });
    const cookie = await login(app, "author");
    await app.inject({
      method: "PATCH",
      url: "/api/v1/me",
      headers: { cookie, origin: localOrigin },
      payload: { qq: "7777777", avatarSource: "qq" }
    });
    const avatar = await app.inject({
      method: "GET",
      url: "/api/v1/users/author/avatar",
      headers: { cookie }
    });
    expect(avatar.statusCode).toBe(404);
  });

  it("机器人账号不能维护个人资料，且不能被当作头像来源", async () => {
    const app = await makeApp();
    const robotCookie = await login(app, "robot");
    expect(
      (
        await app.inject({
          method: "PATCH",
          url: "/api/v1/me",
          headers: { cookie: robotCookie, origin: localOrigin },
          payload: { nickname: "机器人改名" }
        })
      ).statusCode
    ).toBe(403);
    expect(
      (
        await app.inject({
          method: "PUT",
          url: "/api/v1/me/avatar",
          headers: { cookie: robotCookie, origin: localOrigin, "content-type": "application/octet-stream" },
          payload: Buffer.from(pngBytes())
        })
      ).statusCode
    ).toBe(403);

    // 机器人没有头像，读取其头像按不存在处理。
    const humanCookie = await login(app, "author");
    const robotAvatar = await app.inject({
      method: "GET",
      url: "/api/v1/users/robot/avatar",
      headers: { cookie: humanCookie }
    });
    expect(robotAvatar.statusCode).toBe(404);
  });

  it("不存在的用户头像按 404 返回", async () => {
    const app = await makeApp();
    const cookie = await login(app, "author");
    const avatar = await app.inject({
      method: "GET",
      url: "/api/v1/users/does-not-exist/avatar",
      headers: { cookie }
    });
    expect(avatar.statusCode).toBe(404);
  });

  it("清除 QQ 号码时自动退出 QQ 头像", async () => {
    const app = await makeApp();
    const cookie = await login(app, "author");
    await app.inject({
      method: "PATCH",
      url: "/api/v1/me",
      headers: { cookie, origin: localOrigin },
      payload: { qq: "66668888", avatarSource: "qq" }
    });

    const cleared = await app.inject({
      method: "PATCH",
      url: "/api/v1/me",
      headers: { cookie, origin: localOrigin },
      payload: { qq: "" }
    });
    expect(cleared.statusCode).toBe(200);
    expect(cleared.json()).toEqual(
      expect.objectContaining({ qq: null, avatarSource: "none", avatarUrl: null })
    );
  });

  it("选择已上传头像需要先上传；选择 QQ 头像需要先填 QQ", async () => {
    const app = await makeApp();
    const cookie = await login(app, "author");

    const noUpload = await app.inject({
      method: "PATCH",
      url: "/api/v1/me",
      headers: { cookie, origin: localOrigin },
      payload: { avatarSource: "uploaded" }
    });
    expect(noUpload.statusCode).toBe(409);

    await app.inject({
      method: "PUT",
      url: "/api/v1/me/avatar",
      headers: { cookie, origin: localOrigin, "content-type": "application/octet-stream" },
      payload: Buffer.from(pngBytes())
    });
    const useUploaded = await app.inject({
      method: "PATCH",
      url: "/api/v1/me",
      headers: { cookie, origin: localOrigin },
      payload: { avatarSource: "uploaded" }
    });
    expect(useUploaded.statusCode).toBe(200);
    expect(useUploaded.json()).toEqual(
      expect.objectContaining({ avatarSource: "uploaded" })
    );

    // 已有上传头像时切回 none，字节一并清除（数据库约束要求）。
    const backToNone = await app.inject({
      method: "PATCH",
      url: "/api/v1/me",
      headers: { cookie, origin: localOrigin },
      payload: { avatarSource: "none" }
    });
    expect(backToNone.statusCode).toBe(200);
    expect(backToNone.json()).toEqual(
      expect.objectContaining({ avatarSource: "none", avatarUrl: null })
    );
    const avatar = await app.inject({
      method: "GET",
      url: "/api/v1/users/author/avatar",
      headers: { cookie }
    });
    expect(avatar.statusCode).toBe(404);
  });
});