import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLocalDatabase, migrateDatabase, seedCoreDatabase } from "@urmotiv/database";
import { sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/app";
import { DatabaseDataStore } from "../src/database-store";
import { InMemoryDataStore } from "../src/repository";
import type { StoredProblem, StoredUser } from "../src/domain";

function user(id: string, overrides: Partial<StoredUser> = {}): StoredUser {
  return { id, nickname: `投稿人 ${id}`, accountType: "human", disabled: false, roles: [], isRoot: false,
    grants: [{ permission: "auth.login", effect: "allow", scope: "global" }], ...overrides };
}
function problem(id: string, ownerId: string, status: StoredProblem["status"], extra: Partial<StoredProblem> = {}): StoredProblem {
  return { id, ownerId, title: "合成私有题名", type: "traditional", tagIds: ["catalog.tag.02.09"], codeforcesDifficulty: null,
    thinkingLevel: null, codingLevel: null, content: { basicStatement: "合成内容", basicSolution: "合成解答", background: "", statement: "", inputFormat: "", outputFormat: "", constraints: "", solution: "", hints: "" },
    samples: [], status, revision: 1, reviewRound: 0, createdAt: "2026-09-19T00:00:00.000Z", updatedAt: "2026-09-19T00:00:00.000Z", ...extra };
}

describe("投稿联系与公开榜单", () => {
  it("联系资料仅人工用户管理员可读，明确拒绝和模拟登录不继承管理员权限", async () => {
    const manager = user("20");
    manager.grants.push({permission:"user.permission.manage",effect:"allow",scope:"global"});
    manager.grants.push({permission:"user.impersonate",effect:"allow",scope:"global"});
    const denied=user("21",{grants:[...manager.grants,{permission:"user.permission.manage",effect:"deny",scope:"global"}]});
    const robot=user("22",{accountType:"robot",grants:manager.grants});
    const owner=user("10",{username:"SyntheticStudent",realName:"合成姓名",qq:"123456789"});
    const store=new InMemoryDataStore([owner,manager,denied,robot],[]);
    const app=await createApp({store});
    try {
      const request={method:"GET" as const,url:"/api/v1/admin/users/10/contact"};
      expect((await app.inject(request)).statusCode).toBe(401);
      for(const account of [owner,denied,robot]) {
        const session=await store.createSession(account.id,new Date(Date.now()+60000).toISOString());
        for(const id of ["10","missing"]) expect((await app.inject({...request,url:`/api/v1/admin/users/${id}/contact`,headers:{cookie:`urmotiv_session=${session.id}`}})).statusCode).toBe(404);
      }
      const impersonated=await store.createSession(owner.id,new Date(Date.now()+60000).toISOString(),manager.id);
      expect((await app.inject({...request,headers:{cookie:`urmotiv_session=${impersonated.id}`}})).statusCode).toBe(404);
      const session=await store.createSession(manager.id,new Date(Date.now()+60000).toISOString());
      const response=await app.inject({...request,headers:{cookie:`urmotiv_session=${session.id}`}});
      expect(response.statusCode).toBe(200);
      expect(response.headers["cache-control"]).toBe("private, no-store");
      expect(response.json()).toMatchObject({id:owner.id,qq:owner.qq,username:owner.username,realName:owner.realName});
      expect(response.json()).not.toHaveProperty("grants");
      expect((await app.inject({...request,url:"/api/v1/admin/users/missing/contact",headers:{cookie:`urmotiv_session=${session.id}`}})).statusCode).toBe(404);
    } finally {await app.close();}
  });

  it("游客可排序分页，只返回昵称和汇总，不统计草稿、迁移题、机器人或停用账号", async () => {
    const store=new InMemoryDataStore([user("10",{qq:"123456789",realName:"合成私密姓名"}),user("11"),user("12",{disabled:true}),user("13",{accountType:"robot"})],[]);
    for(const item of [problem("1","10","approved"),problem("2","10","rejected"),problem("3","10","draft",{reviewRound:2}),
      problem("4","11","approved"),problem("5","11","approved",{origin:"problem-package",importSource:"problem-package"}),problem("6","10","draft"),
      problem("7","10","approved",{origin:"problem-package",importSource:"synthetic-history-migration",reviewRound:1}),problem("8","12","approved"),problem("9","13","approved")]) await store.createProblem(item);
    const app=await createApp({store});
    try {
      const response=await app.inject({method:"GET",url:"/api/v1/leaderboard?pageSize=1"});
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({items:[{id:"10",nickname:"投稿人 10",submitted:3,approved:1,rejected:1}],total:2,page:1,pageSize:1});
      for(const hidden of ["123456789","合成私密姓名","合成私有题名","合成内容","合成解答","email","username"]) expect(response.body).not.toContain(hidden);
      const approved=await app.inject({method:"GET",url:"/api/v1/leaderboard?sort=approved&pageSize=1"});
      expect(approved.json().items[0].id).toBe("11");
      const rejected=await app.inject({method:"GET",url:"/api/v1/leaderboard?sort=rejected&pageSize=1"});
      expect(rejected.json().items[0].id).toBe("10");
      const second=await app.inject({method:"GET",url:"/api/v1/leaderboard?page=2&pageSize=1"});
      expect(second.json().items[0].id).toBe("11");
      const empty=await app.inject({method:"GET",url:"/api/v1/leaderboard?page=99"});
      expect(empty.json()).toMatchObject({items:[],total:2});
      expect((await app.inject({method:"GET",url:"/api/v1/leaderboard?search=private"})).statusCode).toBe(422);
      expect((await app.inject({method:"GET",url:"/api/v1/leaderboard?pageSize=10000"})).statusCode).toBe(422);
    } finally {await app.close();}
  });

  it("数据库聚合与内存规则一致，保留空页总数，删除题目立即移出统计", async () => {
    const directory=await mkdtemp(join(tmpdir(),"urmotiv-community-"));
    const database=createLocalDatabase({dataDirectory:directory});
    try {
      await migrateDatabase(database); await seedCoreDatabase(database);
      const store=new DatabaseDataStore(database);
      const first=await store.registerEmailUser({nickname:"合成甲",normalizedEmail:"first@example.test",displayEmail:"first@example.test",passwordHash:"synthetic"});
      const second=await store.registerEmailUser({nickname:"合成乙",normalizedEmail:"second@example.test",displayEmail:"second@example.test",passwordHash:"synthetic"});
      const one=await store.createProblem(problem("1",first!.id,"approved"));
      await store.createProblem(problem("2",first!.id,"rejected"));
      await store.createProblem(problem("3",first!.id,"draft"));
      await store.createProblem(problem("4",first!.id,"approved",{origin:"problem-package",importSource:"synthetic-history-migration"}));
      await store.createProblem(problem("5",second!.id,"approved",{origin:"problem-package",importSource:"problem-package"}));
      await store.createProblem(problem("6",second!.id,"approved"));
      const result=await store.listLeaderboard({sort:"approved",page:1,pageSize:1});
      expect(result).toEqual({items:[{id:second!.id,nickname:"合成乙",submitted:2,approved:2,rejected:0}],total:2,page:1,pageSize:1});
      expect((await store.listLeaderboard({sort:"rejected",page:1,pageSize:30})).items[0]?.id).toBe(first!.id);
      expect(await store.listLeaderboard({sort:"submitted",page:10,pageSize:30})).toMatchObject({total:2,items:[]});
      await database.execute(sql`update problems set deleted_at=now(), deleted_by_user_id=${first!.id} where id=${one.id}`);
      expect((await store.listLeaderboard({sort:"submitted",page:1,pageSize:30})).items.find(row=>row.id===first!.id)).toMatchObject({submitted:1,approved:0,rejected:1});
    } finally {await database.close();await rm(directory,{recursive:true,force:true});}
  });
});
