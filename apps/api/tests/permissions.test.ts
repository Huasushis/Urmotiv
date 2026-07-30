import { describe, expect, it } from "vitest";
import { createDemoUsers } from "../src/demo-data";
import {
  canEditProblem,
  canExportProblem,
  canViewProblem,
  createProblemVisibility,
  hasPermission
} from "../src/permissions";

describe("权限计算", () => {
  it("机器人即使错误获得管理员允许项，固定禁止仍然优先", () => {
    const robot = createDemoUsers().find((user) => user.id === "robot");
    if (robot === undefined) {
      throw new Error("缺少机器人演示账号");
    }

    const wronglyConfiguredRobot = {
      ...robot,
      grants: [...robot.grants, { permission: "system.manage" as const, effect: "allow" as const, scope: "global" as const }]
    };
    expect(hasPermission(wronglyConfiguredRobot, "system.manage")).toBe(false);
  });

  it("同一权限的明确拒绝压过允许", () => {
    const user = createDemoUsers().find((item) => item.id === "denied");
    if (user === undefined) {
      throw new Error("缺少明确拒绝演示账号");
    }

    expect(hasPermission(user, "problem.view.all", { objectId: "any", ownerId: "author" })).toBe(false);
  });

  it("查看自己题目的允许项不会扩大成查看所有题目", () => {
    const user = createDemoUsers().find((item) => item.id === "author");
    if (user === undefined) {
      throw new Error("缺少投稿人演示账号");
    }

    const broadlyScopedGrant = {
      ...user,
      grants: user.grants.map((grant) =>
        grant.permission === "problem.view.own" ? { ...grant, scope: "global" as const } : grant
      )
    };
    const visibility = createProblemVisibility(broadlyScopedGrant);
    expect(canViewProblem(visibility, { id: "own", ownerId: user.id })).toBe(true);
    expect(canViewProblem(visibility, { id: "other", ownerId: "another-user" })).toBe(false);
  });

  it("两类查看权限中的任一匹配拒绝都会阻止读取", () => {
    const user = createDemoUsers().find((item) => item.id === "reviewer");
    if (user === undefined) {
      throw new Error("缺少审题人演示账号");
    }

    const globalDeny = createProblemVisibility({
      ...user,
      grants: [
        ...user.grants,
        { permission: "problem.view.own", effect: "deny", scope: "global" }
      ]
    });
    expect(canViewProblem(globalDeny, { id: "global", ownerId: "another-user" })).toBe(false);

    const objectDeny = createProblemVisibility({
      ...user,
      grants: [
        ...user.grants,
        {
          permission: "problem.view.own",
          effect: "deny",
          scope: "object",
          objectId: "blocked"
        }
      ]
    });
    expect(canViewProblem(objectDeny, { id: "blocked", ownerId: "another-user" })).toBe(false);

    const ownDeny = createProblemVisibility({
      ...user,
      grants: [
        ...user.grants,
        { permission: "problem.view.own", effect: "deny", scope: "own" }
      ]
    });
    expect(canViewProblem(ownDeny, { id: "owned", ownerId: user.id })).toBe(false);
  });

  it("编辑自己的题目不能绕过任一编辑权限中的拒绝", () => {
    const user = createDemoUsers().find((item) => item.id === "author");
    if (user === undefined) {
      throw new Error("缺少投稿人演示账号");
    }

    const permissionDenied = {
      ...user,
      grants: [
        ...user.grants,
        { permission: "problem.edit.all" as const, effect: "deny" as const, scope: "global" as const }
      ]
    };
    expect(canEditProblem(permissionDenied, { id: "owned", ownerId: user.id })).toBe(false);

    const member = createDemoUsers().find((item) => item.id === "member");
    if (member === undefined) {
      throw new Error("缺少命题组成员演示账号");
    }
    const ownPermissionDenied = {
      ...member,
      grants: [
        ...member.grants,
        { permission: "problem.edit.own" as const, effect: "deny" as const, scope: "own" as const }
      ]
    };
    expect(canEditProblem(ownPermissionDenied, { id: "owned", ownerId: member.id })).toBe(false);
  });

  it("导出自己的题目不能用 own 允许绕过 all 拒绝", () => {
    const user = createDemoUsers().find((item) => item.id === "author");
    if (user === undefined) {
      throw new Error("缺少投稿人演示账号");
    }

    const permissionDenied = {
      ...user,
      grants: [
        ...user.grants,
        { permission: "problem.export.own" as const, effect: "allow" as const, scope: "own" as const },
        { permission: "problem.export.all" as const, effect: "deny" as const, scope: "global" as const }
      ]
    };
    expect(canExportProblem(permissionDenied, { id: "owned", ownerId: user.id })).toBe(false);

    const leader = createDemoUsers().find((item) => item.id === "leader");
    if (leader === undefined) {
      throw new Error("缺少组长演示账号");
    }
    const ownPermissionDenied = {
      ...leader,
      grants: [
        ...leader.grants,
        { permission: "problem.export.own" as const, effect: "deny" as const, scope: "own" as const }
      ]
    };
    expect(canExportProblem(ownPermissionDenied, { id: "owned", ownerId: leader.id })).toBe(false);
  });
});
