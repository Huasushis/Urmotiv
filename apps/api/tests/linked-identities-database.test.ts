import { mkdtemp, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLocalDatabase, migrateDatabase, seedCoreDatabase } from "@urmotiv/database";
import { sql } from "drizzle-orm";
import { expect, it } from "vitest";
import { DatabaseDataStore } from "../src/database-store";
import type { ExternalIdentity } from "../src/repository";

it("关联身份事务保留本地账号、隔离学校资料、保护最后登录方式并拒绝并发抢绑",async()=>{
  const directory=await mkdtemp(join(tmpdir(),"urmotiv-identities-"));
  const database=createLocalDatabase({dataDirectory:directory});
  try {
    await migrateDatabase(database);await seedCoreDatabase(database);
    const store=new DatabaseDataStore(database);
    const expiry=new Date(Date.now()+600_000).toISOString();const now=new Date().toISOString();
    const owner=(await store.registerEmailUser({username:"FreeAlias",nickname:"本地昵称",normalizedEmail:"local@example.test",displayEmail:"local@example.test",passwordHash:"synthetic-hash"}))!;
    const other=(await store.registerEmailUser({username:"OtherAlias",nickname:"另一个昵称",normalizedEmail:"other@example.test",displayEmail:"other@example.test",passwordHash:"synthetic-other"}))!;
    await store.replaceEmailVerificationToken({userId:owner.id,normalizedEmail:"local@example.test",tokenDigest:"a".repeat(64),expiresAt:expiry});
    await store.consumeEmailVerificationToken("a".repeat(64),now);
    const identity:ExternalIdentity={provider:"ustc-oauth",subject:"synthetic-gid",nickname:"学校昵称",username:"PB22000001",realName:"认证姓名",email:"campus@example.test",emailVerified:false,studentIds:[{attribute:"zjhm",value:"PB22000001"}],decoupled:true,strictReconciliation:true};
    let security=(await store.getAccountSecurity(owner.id))!;
    const originalRevision=security.authRevision;
    const linked=await store.linkExternalIdentity({userId:owner.id,expectedAuthRevision:security.authRevision,identity,requestId:randomUUID(),now});
    expect(linked).toMatchObject({id:owner.id,username:"FreeAlias",nickname:"本地昵称",realName:"认证姓名"});
    expect((await store.getPrimaryEmail(owner.id))?.address).toBe("local@example.test");
    expect((await store.listLinkedIdentities(owner.id))[0]).toMatchObject({subject:identity.subject,studentId:"PB22000001",realName:"认证姓名",email:"campus@example.test"});
    await expect(store.linkExternalIdentity({userId:owner.id,expectedAuthRevision:originalRevision,identity,requestId:randomUUID(),now})).rejects.toThrow();
    await store.findOrCreateExternalUser({...identity,username:"PB23000002",realName:"新的认证姓名",email:"new-campus@example.test",studentIds:[{attribute:"zjhm",value:"PB23000002"}]});
    expect((await store.getUser(owner.id))).toMatchObject({username:"FreeAlias",realName:"认证姓名"});
    expect((await store.listLinkedIdentities(owner.id))[0]).toMatchObject({studentId:"PB23000002",realName:"新的认证姓名"});
    security=(await store.getAccountSecurity(owner.id))!;
    const unlink={userId:owner.id,provider:identity.provider,subject:identity.subject,expectedAuthRevision:security.authRevision,expectedPasswordHash:security.passwordHash!,localLoginEnabled:false,otherEnabledProviders:[],requestId:randomUUID(),now};
    expect(await store.unlinkExternalIdentity(unlink)).toBe(false);
    expect(await store.hasExternalIdentity(identity.provider,identity.subject)).toBe(true);
    expect(await store.unlinkExternalIdentity({...unlink,localLoginEnabled:true})).toBe(true);
    await expect(store.createSession(owner.id,expiry,undefined,undefined,{provider:identity.provider,subject:identity.subject})).rejects.toThrow("登录凭据已经改变");
    const first=(await store.getAccountSecurity(owner.id))!;const second=(await store.getAccountSecurity(other.id))!;
    const competing={...identity,subject:"contested-gid"};
    const outcomes=await Promise.allSettled([first,second].map(state=>store.linkExternalIdentity({userId:state.userId,expectedAuthRevision:state.authRevision,identity:competing,requestId:randomUUID(),now})));
    expect(outcomes.filter(result=>result.status==="fulfilled")).toHaveLength(1);
    const winner=outcomes.find(result=>result.status==="fulfilled") as PromiseFulfilledResult<typeof owner>;
    const winnerId=winner.value.id;
    // 模拟旧版本已存在的同一提供方多个关联，解绑指定编号不能删掉另一个。
    await database.execute(sql`insert into external_identities(id,user_id,provider,subject,profile) values(${randomUUID()}::uuid,${winnerId},'ustc-oauth','legacy-extra-gid','{}'::jsonb)`);
    const winnerState=(await store.getAccountSecurity(winnerId))!;
    expect(await store.unlinkExternalIdentity({userId:winnerId,provider:"ustc-oauth",subject:"contested-gid",expectedAuthRevision:winnerState.authRevision,expectedPasswordHash:winnerState.passwordHash!,localLoginEnabled:false,otherEnabledProviders:["ustc-oauth"],requestId:randomUUID(),now})).toBe(true);
    expect(await store.hasExternalIdentity("ustc-oauth","legacy-extra-gid")).toBe(true);
    expect(await store.hasExternalIdentity("ustc-oauth","contested-gid")).toBe(false);
  } finally {await database.close();await rm(directory,{recursive:true,force:true});}
});
