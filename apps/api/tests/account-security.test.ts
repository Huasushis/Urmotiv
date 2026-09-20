import { afterEach, describe, expect, it, vi } from "vitest";
import { hashPassword } from "@urmotiv/auth";
import type { FastifyInstance } from "fastify";
import { createApp } from "../src/app";
import { InMemoryEmailVerificationOutbox } from "../src/email-verification";
import { InMemoryDataStore } from "../src/repository";
import { createDemoUsers, demoTags } from "../src/demo-data";

const origin="http://localhost:5173";
const password="synthetic-current-password";
const nextPassword="synthetic-next-password";
const openApps:FastifyInstance[]=[];
afterEach(async()=>{await Promise.all(openApps.splice(0).map(app=>app.close()));});
function token(url:string):string {return new URLSearchParams(new URL(url).hash.split("?")[1]).get("token")!;}
async function setup() {
  const outbox=new InMemoryEmailVerificationOutbox();
  const users=createDemoUsers();
  users.find(user=>user.id==="administrator")!.grants.push({permission:"user.impersonate",effect:"allow",scope:"global"});
  const store=new InMemoryDataStore(users,demoTags);
  let now=new Date();
  const app=await createApp({store,emailRegistrationEnabled:true,emailVerificationDelivery:outbox,emailVerificationWebUrl:origin,now:()=>now});
  openApps.push(app);
  const post=(path:string,data:Record<string,unknown>,cookie?:string)=>app.inject({method:"POST",url:path,headers:{origin,...(cookie?{cookie}:{})},payload:data});
  await post("/api/v1/auth/email-register",{email:"security@example.test",password,nickname:"合成账号"});
  await post("/api/v1/auth/email-verification/verify",{token:token(outbox.messages[0]!.verificationUrl)});
  const login=await post("/api/v1/auth/email-login",{email:"security@example.test",password});
  expect(login.statusCode).toBe(200);
  const cookie=String(login.headers["set-cookie"]).split(";")[0]!;
  const userId=login.json().user.id;
  return {app,store,outbox,post,cookie,userId,advance:()=>{now=new Date(now.getTime()+31*60_000);}};
}

describe("账号密码与邮箱变更",()=>{
  it("root 可用现有本地密码修改密码，不依赖统一身份或邮箱",async()=>{
    const store=new InMemoryDataStore([{id:"0",nickname:"root",accountType:"human",disabled:false,isRoot:true,roles:["root"],grants:[{permission:"auth.login",effect:"allow",scope:"global"}]}],demoTags,{rootPasswordHash:await hashPassword(password)});
    const app=await createApp({store});openApps.push(app);
    const signed=await app.inject({method:"POST",url:"/api/v1/auth/root-login",headers:{origin},payload:{identifier:"root",password}});
    expect(signed.statusCode).toBe(200);
    const cookie=String(signed.headers["set-cookie"]).split(";")[0]!;
    expect((await app.inject({method:"POST",url:"/api/v1/me/password",headers:{origin,cookie},payload:{currentPassword:password,newPassword:nextPassword}})).statusCode).toBe(200);
    expect((await app.inject({method:"POST",url:"/api/v1/auth/root-login",headers:{origin},payload:{identifier:"root",password:nextPassword}})).statusCode).toBe(200);
  });

  it("重发使旧恢复链接失效，过期链接不能修改密码",async()=>{
    const {post,outbox,advance}=await setup();
    await post("/api/v1/auth/password-reset/request",{email:"security@example.test"});
    await vi.waitFor(()=>expect(outbox.messages.filter(item=>item.purpose==="password-reset")).toHaveLength(1));
    const first=token(outbox.messages.at(-1)!.verificationUrl);
    await post("/api/v1/auth/password-reset/request",{email:"security@example.test"});
    await vi.waitFor(()=>expect(outbox.messages.filter(item=>item.purpose==="password-reset")).toHaveLength(2));
    const second=token(outbox.messages.at(-1)!.verificationUrl);
    expect((await post("/api/v1/auth/password-reset/confirm",{token:first,newPassword:nextPassword})).statusCode).toBe(400);
    advance();
    expect((await post("/api/v1/auth/password-reset/confirm",{token:second,newPassword:nextPassword})).statusCode).toBe(400);
    expect((await post("/api/v1/auth/email-login",{email:"security@example.test",password})).statusCode).toBe(200);
  });
  it("开始验证后密码被修改，旧凭据不能再建立新会话",async()=>{
    const {store,post,userId}=await setup();
    const find=store.findEmailCredential.bind(store);
    vi.spyOn(store,"findEmailCredential").mockImplementationOnce(async address=>{
      const old=await find(address);
      const state=(await store.getAccountSecurity(userId))!;
      await store.changeAccountPassword({userId,expectedAuthRevision:state.authRevision,expectedPasswordHash:state.passwordHash!,newPasswordHash:"synthetic-concurrent-replacement",requestId:crypto.randomUUID(),now:new Date().toISOString()});
      return old;
    });
    expect((await post("/api/v1/auth/email-login",{email:"security@example.test",password})).statusCode).toBe(401);
  });
  it("修改密码需当前密码和本人会话，成功后旧密码与所有旧会话失效",async()=>{
    const {app,store,post,cookie,userId}=await setup();
    const second=await store.createSession(userId,new Date(Date.now()+60_000).toISOString());
    expect((await post("/api/v1/me/password",{currentPassword:password,newPassword:nextPassword})).statusCode).toBe(401);
    expect((await post("/api/v1/me/password",{currentPassword:"wrong",newPassword:nextPassword},cookie)).statusCode).toBe(400);
    expect((await post("/api/v1/me/password",{currentPassword:password,newPassword:nextPassword},cookie)).statusCode).toBe(200);
    expect((await app.inject({method:"GET",url:"/api/v1/me",headers:{cookie}})).statusCode).toBe(401);
    expect(await store.getSession(second.id)).toBeUndefined();
    expect((await post("/api/v1/auth/email-login",{email:"security@example.test",password})).statusCode).toBe(401);
    expect((await post("/api/v1/auth/email-login",{email:"security@example.test",password:nextPassword})).statusCode).toBe(200);
  });

  it("找回请求不区分账号存在，链接限定用途且只可消费一次",async()=>{
    const {app,post,outbox,cookie}=await setup();
    const known=await post("/api/v1/auth/password-reset/request",{email:"security@example.test"});
    const unknown=await post("/api/v1/auth/password-reset/request",{email:"unknown@example.test"});
    expect(known.statusCode).toBe(202);expect(unknown.statusCode).toBe(202);expect(known.json()).toEqual(unknown.json());
    await vi.waitFor(()=>expect(outbox.messages.some(message=>message.purpose==="password-reset")).toBe(true));
    const recovery=token(outbox.messages.find(message=>message.purpose==="password-reset")!.verificationUrl);
    expect((await post("/api/v1/auth/email-change/confirm",{token:recovery})).statusCode).toBe(400);
    expect((await post("/api/v1/auth/password-reset/confirm",{token:recovery,newPassword:nextPassword})).statusCode).toBe(200);
    expect((await post("/api/v1/auth/password-reset/confirm",{token:recovery,newPassword:password})).statusCode).toBe(400);
    expect((await app.inject({method:"GET",url:"/api/v1/me",headers:{cookie}})).statusCode).toBe(401);
    expect((await post("/api/v1/auth/email-login",{email:"security@example.test",password:nextPassword})).statusCode).toBe(200);
  });

  it("验证前保留旧邮箱，验证后绑定新邮箱、通知旧邮箱并撤销旧会话",async()=>{
    const {app,store,post,outbox,cookie,userId}=await setup();
    expect((await post("/api/v1/me/email-change",{currentPassword:password,newEmail:"NEW@example.test"},cookie)).statusCode).toBe(202);
    expect((await store.getPrimaryEmail(userId))?.address).toBe("security@example.test");
    expect(await store.findEmailCredential("new@example.test")).toBeUndefined();
    const message=outbox.messages.find(item=>item.purpose==="email-change")!;
    const result=await post("/api/v1/auth/email-change/confirm",{token:token(message.verificationUrl)});
    expect(result.statusCode).toBe(200);expect(result.json()).toEqual({ok:true,notificationSent:true});
    expect((await store.getPrimaryEmail(userId))).toEqual({address:"new@example.test",verified:true});
    expect(await store.findEmailCredential("security@example.test")).toBeUndefined();
    expect((await store.findEmailCredential("new@example.test"))?.user.id).toBe(userId);
    expect(outbox.messages.find(item=>item.purpose==="email-changed")?.recipient).toBe("security@example.test");
    expect((await app.inject({method:"GET",url:"/api/v1/me",headers:{cookie}})).statusCode).toBe(401);
    expect((await post("/api/v1/auth/email-change/confirm",{token:token(message.verificationUrl)})).statusCode).toBe(400);
  });

  it("过期或冲突的邮箱链接不改变旧地址；恢复请求按来源限流",async()=>{
    const {store,post,outbox,cookie,userId,advance}=await setup();
    await post("/api/v1/auth/email-register",{email:"occupied@example.test",password,nickname:"合成另一账号"});
    await post("/api/v1/me/email-change",{currentPassword:password,newEmail:"occupied@example.test"},cookie);
    const conflict=token(outbox.messages.find(item=>item.purpose==="email-change")!.verificationUrl);
    expect((await post("/api/v1/auth/email-change/confirm",{token:conflict})).statusCode).toBe(400);
    await post("/api/v1/me/email-change",{currentPassword:password,newEmail:"fresh@example.test"},cookie);
    const fresh=token(outbox.messages.filter(item=>item.purpose==="email-change").at(-1)!.verificationUrl);
    advance();
    expect((await post("/api/v1/auth/email-change/confirm",{token:fresh})).statusCode).toBe(400);
    expect((await store.getPrimaryEmail(userId))?.address).toBe("security@example.test");
    for(let index=0;index<9;index++) expect((await post("/api/v1/auth/password-reset/request",{email:"missing@example.test"})).statusCode).toBe(202);
    expect((await post("/api/v1/auth/password-reset/request",{email:"missing@example.test"})).statusCode).toBe(429);
  });

  it("机器人和模拟登录不能更改凭据，错误来源拒绝请求",async()=>{
    const {app,store,post,cookie,userId}=await setup();
    const impersonated=await store.createSession(userId,new Date(Date.now()+60_000).toISOString(),"administrator");
    const actingCookie=`urmotiv_session=${impersonated.id}`;
    for(const path of ["/api/v1/me/password","/api/v1/me/email-change","/api/v1/auth/password-reset/request","/api/v1/auth/email-change/confirm"]) {
      expect((await post(path,{},actingCookie)).statusCode).toBe(403);
    }
    const robot=await store.createSession("robot",new Date(Date.now()+60_000).toISOString());
    expect((await post("/api/v1/me/password",{},`urmotiv_session=${robot.id}`)).statusCode).toBe(404);
    expect((await app.inject({method:"POST",url:"/api/v1/me/password",headers:{origin:"https://other.example.test",cookie},payload:{currentPassword:password,newPassword:nextPassword}})).statusCode).toBe(403);
  });
});
