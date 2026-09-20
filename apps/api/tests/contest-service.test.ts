import { describe, expect, it } from "vitest";
import type { PermissionGrant } from "@urmotiv/contracts";
import { ContestService } from "../src/contest-service";
import { InMemoryContestStore } from "../src/contest-store";
import { createDemoUsers, demoTags } from "../src/demo-data";
import type { StoredProblem, StoredUser } from "../src/domain";
import { InMemoryDataStore } from "../src/repository";
import {createProblemVisibility} from "../src/permissions";

const content = {
  basicStatement: "给定一个整数。",
  basicSolution: "直接输出。",
  background: "",
  statement: "",
  inputFormat: "",
  outputFormat: "",
  constraints: "",
  solution: "",
  hints: ""
};

function requireUser(users: StoredUser[], id: string): StoredUser {
  const user = users.find((candidate) => candidate.id === id);
  if (user === undefined) {
    throw new Error(`缺少测试用户 ${id}。`);
  }
  return user;
}

function approvedProblem(ownerId: string): StoredProblem {
  return {
    id: "11",
    title: "公开构造的组题测试题",
    type: "traditional",
    tagIds: ["algorithm.implementation"],
    codeforcesDifficulty: 1200,
    thinkingLevel: 2,
    codingLevel: 2,
    content,
    samples: [],
    status: "approved",
    ownerId,
    revision: 3,
    reviewRound: 1,
    createdAt: "2026-07-25T00:00:00.000Z",
    updatedAt: "2026-07-25T00:00:00.000Z"
  };
}

function makeContext(extraUsers: StoredUser[] = []) {
  const users = [...createDemoUsers(), ...extraUsers];
  const problemStore = new InMemoryDataStore(users, demoTags);
  const contestStore = new InMemoryContestStore();
  let now = new Date("2026-07-25T01:00:00.000Z");
  const service = new ContestService(problemStore, contestStore, { now: () => now });
  const author = requireUser(users, "author");
  const leader = requireUser(users, "leader");
  const robot = requireUser(users, "robot");
  return {
    users,
    problemStore,
    contestStore,
    service,
    author,
    leader,
    robot,
    setNow(value: string) {
      now = new Date(value);
    }
  };
}

async function createContest(context: ReturnType<typeof makeContext>) {
  await context.problemStore.createProblem(approvedProblem(context.author.id));
  return context.service.createContest(context.leader, {
    title: "校赛组题方案",
    description: "",
    startsAt: null,
    endsAt: null,
    members: [{ userId: context.author.id, role: "participant" }],
    problems: [{ problemId: "11", score: 100, estimatedDifficulty: 2 }]
  });
}

describe("组题与访问记录服务", () => {
  it("归档保留固定版本与原访问权限，取消归档/锁定后回草稿，删除隐藏方案但保留题目", async () => {
    const context = makeContext();
    const original = await createContest(context);
    const archived = await context.service.updateContest(context.leader, original.id, {state:"archived",expectedUpdatedAt:original.updatedAt});
    expect(archived.state).toBe("archived");
    expect(archived.problems).toEqual(original.problems);
    expect(archived.capabilities).toMatchObject({canEdit:false,canExport:true});
    for (const input of [{title:"归档后改名"}]) {
      await expect(context.service.updateContest(context.leader, original.id, {...input,expectedUpdatedAt:archived.updatedAt})).rejects.toMatchObject({statusCode:409});
    }
    await expect(context.service.getContest(context.author,original.id)).rejects.toMatchObject({statusCode:404});
    expect((await context.service.listContests(context.author)).items).toEqual([]);
    const denied = {...context.leader,grants:[...context.leader.grants,{permission:"contest.edit.all" as const,effect:"deny" as const,scope:"global" as const},{permission:"contest.export" as const,effect:"deny" as const,scope:"global" as const}]};
    await expect(context.service.getContest(denied,original.id)).rejects.toMatchObject({statusCode:404});
    await expect(context.service.updateContest(denied,original.id,{state:"draft",expectedUpdatedAt:archived.updatedAt})).rejects.toMatchObject({statusCode:404});
    const reopened=await context.service.updateContest(context.leader,original.id,{state:"draft",expectedUpdatedAt:archived.updatedAt});
    expect(reopened.problems).toEqual(original.problems);
    const locked=await context.service.updateContest(context.leader,original.id,{state:"locked",expectedUpdatedAt:reopened.updatedAt});
    const unlocked=await context.service.updateContest(context.leader,original.id,{state:"draft",expectedUpdatedAt:locked.updatedAt});
    expect(unlocked.state).toBe("draft");expect(unlocked.problems).toEqual(original.problems);
    await expect(context.service.deleteContest(context.robot,original.id,unlocked.updatedAt,crypto.randomUUID())).rejects.toMatchObject({statusCode:404});
    await expect(context.service.deleteContest(context.leader,original.id,original.updatedAt,crypto.randomUUID())).rejects.toMatchObject({statusCode:409});
    await context.service.deleteContest(context.leader,original.id,unlocked.updatedAt,crypto.randomUUID());
    expect((await context.service.listContests(context.leader)).items).toEqual([]);
    await expect(context.service.getContest(context.leader,original.id)).rejects.toMatchObject({statusCode:404});
    expect(await context.problemStore.findVisibleProblem("11",createProblemVisibility(context.author))).toBeDefined();
  });
  it("只有比赛导出权限可读方案，但不能借此修改或读取风险", async () => {
    const context = makeContext();
    const contest = await createContest(context);
    const exporter: StoredUser = { ...context.author, grants: [
      { permission: "auth.login", effect: "allow", scope: "global" },
      { permission: "contest.export", effect: "allow", scope: "global" }
    ] };
    expect((await context.service.listContests(exporter)).items).toHaveLength(1);
    expect((await context.service.getContest(exporter, contest.id)).capabilities).toMatchObject({ canExport: true, canEdit: false, canReadRisk: false });
    await expect(context.service.updateContest(exporter, contest.id, { title: "禁止修改", expectedUpdatedAt: contest.updatedAt })).rejects.toMatchObject({ statusCode: 404 });
    const denied: StoredUser = { ...exporter, grants: [...exporter.grants, { permission: "contest.export", effect: "deny", scope: "global" }] };
    await expect(context.service.getContest(denied, contest.id)).rejects.toMatchObject({ statusCode: 404 });
  });
  it("不向普通投稿人泄露组题方案是否存在", async () => {
    const context = makeContext();
    const contest = await createContest(context);

    await expect(context.service.getContest(context.author, contest.id)).rejects.toMatchObject({
      statusCode: 404
    });
    await expect(context.service.listContests(context.author)).resolves.toEqual({ items: [] });
    await expect(
      context.service.createContest(context.author, {
        title: "无权创建",
        description: "",
        startsAt: null,
        endsAt: null,
        members: [],
        problems: [{ problemId: "11", score: 100, estimatedDifficulty: null }]
      })
    ).rejects.toMatchObject({ statusCode: 403 });
  });

  it("只把参与者的访问记录计入风险，并固定题目修订", async () => {
    const context = makeContext();
    await context.problemStore.createProblem(approvedProblem(context.author.id));
    await context.service.recordProblemAccess(context.author, "11", 0);
    context.setNow("2026-07-25T01:00:15.000Z");
    await context.service.recordProblemAccess(context.author, "11", 15);
    await context.service.recordProblemAccess(context.author, "11", 15);

    const contest = await context.service.createContest(context.leader, {
      title: "风险检查",
      description: "",
      startsAt: null,
      endsAt: null,
      members: [{ userId: context.author.id, role: "participant" }],
      problems: [{ problemId: "11", score: 100, estimatedDifficulty: 2 }]
    });

    expect(contest.problems[0]).toMatchObject({
      revision: 3,
      leakRiskCount: 1,
      leakRiskEntries: [expect.objectContaining({ totalActiveSeconds: 15 })]
    });
    const access = await context.service.listProblemAccess(context.leader, "11");
    expect(access.items).toEqual([
      expect.objectContaining({ user: expect.objectContaining({ id: "author" }), totalActiveSeconds: 15 })
    ]);
  });

  it("拒绝机器人参赛、重复题目和未审核通过的题目", async () => {
    const context = makeContext();
    await context.problemStore.createProblem(approvedProblem(context.author.id));

    await expect(
      context.service.createContest(context.leader, {
        title: "机器人参赛",
        description: "",
        startsAt: null,
        endsAt: null,
        members: [{ userId: context.robot.id, role: "participant" }],
        problems: [{ problemId: "11", score: 100, estimatedDifficulty: null }]
      })
    ).rejects.toMatchObject({ code: "ROBOT_CONTEST_PARTICIPANT" });
    await expect(
      context.service.createContest(context.leader, {
        title: "重复题目",
        description: "",
        startsAt: null,
        endsAt: null,
        members: [],
        problems: [
          { problemId: "11", score: 50, estimatedDifficulty: null },
          { problemId: "11", score: 50, estimatedDifficulty: null }
        ]
      })
    ).rejects.toMatchObject({ code: "DUPLICATE_CONTEST_PROBLEM" });
  });

  it("明确拒绝任意方案编辑时，不会被自己方案的允许覆盖", async () => {
    const leader = requireUser(createDemoUsers(), "leader");
    const deny: PermissionGrant = {
      permission: "contest.edit.all",
      effect: "deny",
      scope: "global"
    };
    const restrictedLeader: StoredUser = {
      ...leader,
      id: "restricted-leader",
      nickname: "受限组长",
      grants: [...leader.grants, deny]
    };
    const context = makeContext([restrictedLeader]);
    await context.problemStore.createProblem(approvedProblem(restrictedLeader.id));
    const created = await context.service.createContest(restrictedLeader, {
      title: "受限方案",
      description: "",
      startsAt: null,
      endsAt: null,
      members: [],
      problems: [{ problemId: "11", score: 100, estimatedDifficulty: null }]
    });

    expect((await context.service.getContest(restrictedLeader, created.id)).capabilities.canEdit).toBe(false);
    await expect(context.service.updateContest(restrictedLeader, created.id, {
      title: "不能通过导出权限编辑", expectedUpdatedAt: created.updatedAt
    })).rejects.toMatchObject({
      statusCode: 404
    });
  });

  it("锁定后不能换题，并拒绝过期保存覆盖新内容", async () => {
    const context = makeContext();
    const contest = await createContest(context);
    const locked = await context.service.updateContest(context.leader, contest.id, {
      state: "locked",
      expectedUpdatedAt: contest.updatedAt
    });

    await expect(
      context.service.updateContest(context.leader, contest.id, {
        description: "试图在锁定后修改",
        expectedUpdatedAt: locked.updatedAt
      })
    ).rejects.toMatchObject({ statusCode: 409 });
    await expect(
      context.service.updateContest(context.leader, contest.id, {
        state: "archived",
        expectedUpdatedAt: contest.updatedAt
      })
    ).rejects.toMatchObject({ statusCode: 409 });
  });
});
