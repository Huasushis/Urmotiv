import {randomUUID} from "node:crypto";
import {afterEach,expect,it} from "vitest";
import {createLocalDatabase,migrateDatabase,seedCoreDatabase,type LocalDatabaseHandle} from "@urmotiv/database";
import {sql} from "drizzle-orm";
import {createApp} from "../src/app";
import {DatabaseDataStore} from "../src/database-store";
import {DatabaseContestStore} from "../src/database-contest-store";
import {databaseDemoUserIds as ids,seedDatabaseDemoData} from "../src/database-demo";
import type {FastifyInstance} from "fastify";
const origin="http://localhost:5173";
const databases:LocalDatabaseHandle[]=[];const apps:FastifyInstance[]=[];
afterEach(async()=>{for(const app of apps.splice(0))await app.close();for(const db of databases.splice(0))await db.close();});
async function fixture(){
  const db=createLocalDatabase();databases.push(db);await migrateDatabase(db);await seedCoreDatabase(db);await seedDatabaseDemoData(db);
  const store=new DatabaseDataStore(db);const contests=new DatabaseContestStore(db);
  const app=await createApp({store,contestStore:contests,demoAuthEnabled:true,demoUserIds:Object.values(ids)});apps.push(app);
  const login=async(id:string)=>{const r=await app.inject({method:"POST",url:"/api/v1/auth/demo-login",headers:{origin},payload:{userId:id}});expect(r.statusCode).toBe(200);return String(r.headers['set-cookie']).split(';')[0]!;};
  const problem=await store.createProblem({id:randomUUID(),title:"合成账号迁移题",type:"traditional",tagIds:["catalog.tag.02.09"],codeforcesDifficulty:null,thinkingLevel:null,codingLevel:null,
    content:{basicStatement:"合成题意",basicSolution:"合成解答",background:"",statement:"",inputFormat:"",outputFormat:"",constraints:"",solution:"",hints:""},samples:[],status:"approved",ownerId:ids.author,revision:1,reviewRound:0,createdAt:new Date().toISOString(),updatedAt:new Date().toISOString()});
  const contest=await contests.createContest({title:"合成历史比赛",description:"",state:"archived",startsAt:null,endsAt:null,
    creator:{id:ids.author,nickname:"合成作者",accountType:"human"},members:[],problems:[{problemId:problem.id,revision:1,title:problem.title,score:100,estimatedDifficulty:null}]});
  const remove=(userId:string,cookie:string)=>app.inject({method:"DELETE",url:'/api/v1/admin/users/'+userId,headers:{cookie,origin},payload:{confirm:true}});
  return{db,store,contests,app,login,problem,contest,remove};
}
it("删除账号转移题目比赛，保留版本和审计，撤销登录并从管理列表移除",async()=>{
  const{db,store,contests,app,login,problem,contest,remove}=await fixture();
  const author=await login(ids.author);const admin=await login(ids.administrator);
  await db.execute(sql`INSERT INTO audit_events(actor_user_id,request_id,action,object_type,object_id,result,metadata) VALUES(${BigInt(ids.author)},${randomUUID()}::uuid,'synthetic.history','problem',${problem.id},'success','{}'::jsonb)`);
  const before=await db.query(sql`SELECT * FROM audit_events WHERE action='synthetic.history'`);
  const response=await remove(ids.author,admin);expect(response.statusCode).toBe(200);
  expect(await store.getUser(ids.author)).toBeUndefined();
  expect((await app.inject({method:"GET",url:"/api/v1/me",headers:{cookie:author}})).statusCode).toBe(401);
  const list=await app.inject({method:"GET",url:"/api/v1/admin/users",headers:{cookie:admin}});
  expect(list.json().items.some((user:{id:string})=>user.id===ids.author)).toBe(false);
  expect(await db.query(sql`SELECT owner_id::text,current_revision FROM problems WHERE id=${BigInt(problem.id)}`)).toEqual([{owner_id:ids.administrator,current_revision:1}]);
  expect((await contests.getContest(contest.id))?.creator.id).toBe(ids.administrator);
  expect((await contests.getContest(contest.id))?.problems[0]?.revisionId).toBe(contest.problems[0]?.revisionId);
  expect(await db.query(sql`SELECT * FROM audit_events WHERE action='synthetic.history'`)).toEqual(before);
  expect(await db.query(sql`SELECT count(*)::int AS n FROM audit_events WHERE action='admin.user.delete'`)).toEqual([{n:1}]);
  expect((await remove(ids.author,admin)).statusCode).toBe(404);
});
it("拒绝普通账号、机器人、模拟登录、自删和删除 root",async()=>{
  const{db,store,login,remove}=await fixture();const admin=await login(ids.administrator);const author=await login(ids.author);
  expect((await remove(ids.reviewer,author)).statusCode).toBe(404);
  expect((await remove("0",admin)).statusCode).toBe(404);
  expect((await remove(ids.administrator,admin)).statusCode).toBe(404);
  for(const permission of ['user.delete','problem.edit.all','contest.edit.all'])await db.execute(sql`INSERT INTO permission_grants(id,subject_user_id,permission_name,effect,scope,granted_by_user_id,reason) VALUES(${randomUUID()}::uuid,${BigInt(ids.robot)},${permission},'allow','global',0,'合成测试')`);
  expect((await remove(ids.author,await login(ids.robot))).statusCode).toBe(404);
  const switched=await store.createSession(ids.administrator,new Date(Date.now()+60000).toISOString(),"0");
  expect((await remove(ids.author,'urmotiv_session='+switched.id)).statusCode).toBe(404);
  expect(await store.getUser(ids.author)).toBeDefined();
});
it("对象明确拒绝阻止转移，失败不留下部分删除",async()=>{
  const{db,store,login,problem,remove}=await fixture();const admin=await login(ids.administrator);
  await db.execute(sql`INSERT INTO permission_grants(id,subject_user_id,permission_name,effect,scope,object_type,object_id,granted_by_user_id,reason) VALUES(${randomUUID()}::uuid,${BigInt(ids.administrator)},'problem.edit.all','deny','object','problem',${problem.id},0,'合成拒绝')`);
  expect((await remove(ids.author,admin)).statusCode).toBe(404);
  expect(await store.getUser(ids.author)).toBeDefined();
  expect(await db.query(sql`SELECT owner_id::text FROM problems WHERE id=${BigInt(problem.id)}`)).toEqual([{owner_id:ids.author}]);
});
it("审计写入失败回滚归属、账号和会话",async()=>{
  const{db,store,login,problem,app,remove}=await fixture();const admin=await login(ids.administrator);const author=await login(ids.author);
  await db.execute(sql`CREATE FUNCTION synthetic_block_user_removal_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action='admin.user.delete' THEN RAISE EXCEPTION 'SYNTHETIC_AUDIT_FAILURE'; END IF; RETURN NEW; END $$`);
  await db.execute(sql`CREATE TRIGGER synthetic_user_removal_audit BEFORE INSERT ON audit_events FOR EACH ROW EXECUTE FUNCTION synthetic_block_user_removal_audit()`);
  expect((await remove(ids.author,admin)).statusCode).toBe(500);
  expect(await store.getUser(ids.author)).toBeDefined();
  expect((await app.inject({method:"GET",url:"/api/v1/me",headers:{cookie:author}})).statusCode).toBe(200);
  expect(await db.query(sql`SELECT owner_id::text FROM problems WHERE id=${BigInt(problem.id)}`)).toEqual([{owner_id:ids.author}]);
});
