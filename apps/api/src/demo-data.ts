import type { CorePermission, PermissionGrant, ProblemTag } from "@urmotiv/contracts";
import type { StoredUser } from "./domain";

function allow(permission: CorePermission, scope: PermissionGrant["scope"] = "global"): PermissionGrant {
  return { permission, effect: "allow", scope };
}

function deny(permission: CorePermission, scope: PermissionGrant["scope"] = "global"): PermissionGrant {
  return { permission, effect: "deny", scope };
}

const contributorGrants = [
  allow("auth.login"),
  allow("problem.create"),
  allow("problem.view.own", "own"),
  allow("problem.edit.own", "own"),
  allow("problem.delete.own", "own")
];

const reviewerGrants = [
  ...contributorGrants,
  allow("problem.view.all"),
  allow("problem.review"),
  allow("problem.testdata.read")
];

const memberGrants = [
  ...reviewerGrants,
  allow("problem.edit.all"),
  allow("problem.testdata.write"),
  allow("problem.viewers.read"),
  allow("contest.create"),
  allow("contest.edit.own", "own"),
  allow("contest.risk.read")
];

const leaderGrants = [
  ...memberGrants,
  allow("problem.status.change"),
  allow("problem.access.grant"),
  allow("problem.import"),
  allow("problem.export.all"),
  allow("contest.edit.all"),
  allow("contest.delete"),
  allow("contest.export"),
  allow("tag.manage"),
  allow("user.create")
];

const administratorGrants = [
  allow("auth.login"),
  allow("user.create"),
  allow("user.delete"),
  allow("user.permission.manage"),
  allow("system.manage"),
  allow("plugin.manage"),
  allow("service_account.manage"),
  allow("tag.manage"),
  allow("audit.read")
];

function demoUser(
  id: string,
  nickname: string,
  roles: string[],
  grants: PermissionGrant[],
  accountType: StoredUser["accountType"] = "human"
): StoredUser {
  return {
    id,
    nickname,
    accountType,
    disabled: false,
    roles,
    grants,
    isRoot: false
  };
}

export function createDemoUsers(): StoredUser[] {
  return [
    demoUser("author", "投稿人演示账号", ["投稿人"], contributorGrants),
    demoUser("reviewer", "审题人演示账号", ["审题人"], reviewerGrants),
    demoUser("member", "命题组成员演示账号", ["命题组成员"], memberGrants),
    demoUser("leader", "组长演示账号", ["组长"], leaderGrants),
    demoUser(
      "administrator",
      "系统管理员演示账号",
      ["系统管理员"],
      administratorGrants
    ),
    demoUser("robot", "审核机器人演示账号", ["审题机器人"], reviewerGrants, "robot"),
    demoUser(
      "denied",
      "明确拒绝演示账号",
      ["审题人", "受限账号"],
      [...reviewerGrants, deny("problem.view.all")]
    )
  ];
}

export const demoTags: ProblemTag[] = [
  {
    id: "algorithm.implementation",
    name: "模拟",
    group: "算法",
    itemKind: "tag",
    active: true,
    category: { id: "demo.category.algorithm", name: "算法" }
  },
  {
    id: "data-structure.graph",
    name: "图论",
    group: "数据结构与图",
    itemKind: "tag",
    active: true,
    category: { id: "demo.category.data-structure-graph", name: "数据结构与图" }
  },
  {
    id: "dynamic-programming",
    name: "动态规划",
    group: "算法",
    itemKind: "tag",
    active: true,
    category: { id: "demo.category.algorithm", name: "算法" }
  },
  {
    id: "math.number-theory",
    name: "数论",
    group: "数学",
    itemKind: "tag",
    active: true,
    category: { id: "demo.category.math", name: "数学" }
  },
  {
    id: "string",
    name: "字符串",
    group: "基础",
    itemKind: "tag",
    active: true,
    category: { id: "demo.category.basic", name: "基础" }
  }
];
