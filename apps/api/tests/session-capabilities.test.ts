import {
  sessionResponseSchema,
  type PermissionGrant
} from "@urmotiv/contracts";
import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app";
import type { StoredUser } from "../src/domain";
import { demoTags } from "../src/demo-data";
import { InMemoryDataStore } from "../src/repository";

const origin = "http://localhost:5173";
const openApps: FastifyInstance[] = [];

afterEach(async () => {
  await Promise.all(openApps.splice(0).map(async (app) => app.close()));
});

function grant(
  permission: PermissionGrant["permission"],
  options: {
    effect?: PermissionGrant["effect"];
    scope?: PermissionGrant["scope"];
    objectId?: string;
  } = {}
): PermissionGrant {
  return {
    permission,
    effect: options.effect ?? "allow",
    scope: options.scope ?? "global",
    ...(options.objectId === undefined ? {} : { objectId: options.objectId })
  };
}

function createUser(
  id: string,
  accountType: StoredUser["accountType"],
  grants: PermissionGrant[],
  roles: string[] = []
): StoredUser {
  return {
    id,
    nickname: `会话测试账号 ${id}`,
    accountType,
    disabled: false,
    roles,
    isRoot: false,
    grants: [grant("auth.login"), ...grants]
  };
}

async function makeApp(users: StoredUser[]): Promise<FastifyInstance> {
  const app = await createApp({
    store: new InMemoryDataStore(users, demoTags),
    demoAuthEnabled: true,
    demoUserIds: users.map((user) => user.id)
  });
  openApps.push(app);
  return app;
}

async function readSession(app: FastifyInstance, userId: string) {
  const login = await app.inject({
    method: "POST",
    url: "/api/v1/auth/demo-login",
    headers: { origin },
    payload: { userId }
  });
  expect(login.statusCode).toBe(200);
  const setCookie = login.headers["set-cookie"];
  const firstCookie = Array.isArray(setCookie) ? setCookie[0] : setCookie;
  expect(firstCookie).toBeTypeOf("string");

  const response = await app.inject({
    method: "GET",
    url: "/api/v1/session",
    headers: { cookie: (firstCookie as string).split(";", 1)[0]! }
  });
  expect(response.statusCode).toBe(200);
  return sessionResponseSchema.parse(response.json()).user;
}

describe("会话中的管理能力", () => {
  it("只在拥有所需全局权限的人类账号上返回管理能力", async () => {
    const reviewManager = createUser("review-manager", "human", [
      grant("problem.status.change")
    ]);
    const pluginManager = createUser("plugin-manager", "human", [grant("plugin.manage")]);
    const tagManager = createUser("tag-manager", "human", [grant("tag.manage")]);
    const app = await makeApp([reviewManager, pluginManager, tagManager]);

    await expect(readSession(app, reviewManager.id)).resolves.toMatchObject({
      canManageReviewPolicy: true,
      canManagePlugins: false,
      canManageTags: false
    });
    await expect(readSession(app, pluginManager.id)).resolves.toMatchObject({
      canManageReviewPolicy: false,
      canManagePlugins: true,
      canManageTags: false
    });
    await expect(readSession(app, tagManager.id)).resolves.toMatchObject({
      canManageReviewPolicy: false,
      canManagePlugins: false,
      canManageTags: true
    });
  });

  it("自己的对象或指定对象范围不会被当成全局管理权限", async () => {
    const scopedUser = createUser("scoped", "human", [
      grant("problem.status.change", { scope: "object", objectId: "problem-1" }),
      grant("plugin.manage", { scope: "own" }),
      grant("tag.manage", { scope: "object", objectId: "tag-1" }),
      grant("system.manage")
    ]);
    const app = await makeApp([scopedUser]);

    await expect(readSession(app, scopedUser.id)).resolves.toMatchObject({
      canManageReviewPolicy: false,
      canManagePlugins: false,
      canManageTags: false
    });
  });

  it("明确拒绝优先于同一权限的允许", async () => {
    const deniedUser = createUser("denied", "human", [
      grant("problem.status.change"),
      grant("problem.status.change", { effect: "deny" }),
      grant("plugin.manage"),
      grant("plugin.manage", { effect: "deny" }),
      grant("tag.manage"),
      grant("tag.manage", { effect: "deny" })
    ]);
    const app = await makeApp([deniedUser]);

    await expect(readSession(app, deniedUser.id)).resolves.toMatchObject({
      canManageReviewPolicy: false,
      canManagePlugins: false,
      canManageTags: false
    });
  });

  it("机器人即使有管理员角色和全局允许也没有这两项管理能力", async () => {
    const robot = createUser(
      "robot-manager",
      "robot",
      [
        grant("problem.status.change"),
        grant("plugin.manage"),
        grant("tag.manage"),
        grant("system.manage")
      ],
      ["组长", "系统管理员"]
    );
    const app = await makeApp([robot]);

    await expect(readSession(app, robot.id)).resolves.toMatchObject({
      canManageReviewPolicy: false,
      canManagePlugins: false,
      canManageTags: false
    });
  });
});
