import { expect, test } from "@playwright/test";
import { UstcOAuthClient } from "../../../packages/auth/src/ustc-oauth";
import { createApp } from "../../api/src/app";
import { InMemoryEmailVerificationOutbox } from "../../api/src/email-verification";
import { InMemoryDataStore } from "../../api/src/repository";
import { createDemoUsers, demoTags } from "../../api/src/demo-data";

test("自由用户名账号绑定学校身份，独立显示认证资料，再解绑并以原账号登录",async({page},testInfo)=>{
  const origin="http://127.0.0.1:5173";
  const store=new InMemoryDataStore(createDemoUsers(),demoTags);
  const outbox=new InMemoryEmailVerificationOutbox();
  const client=new UstcOAuthClient({configuration:{
    authorizeUrl:"https://id.ustc.edu.cn/cas/oauth2.0/authorize",tokenUrl:"https://id.ustc.edu.cn/cas/oauth2.0/accessToken",profileUrl:"https://id.ustc.edu.cn/cas/oauth2.0/profile",
    redirectUri:origin+"/api/v1/auth/ustc/callback",clientId:"synthetic-client",clientSecret:"synthetic-client-secret"},
    stateSecret:Buffer.alloc(32,7),allowLoopbackInsecureRedirect:true,
    resolveHostAddresses:async()=>["93.184.216.34"],
    states:{put:(nonce,expires)=>store.putLoginState(nonce,expires),consume:(nonce,now)=>store.consumeLoginState(nonce,now)},
    fetch:async(input)=>String(input).endsWith("/accessToken")?new Response(JSON.stringify({access_token:"synthetic-access"})):new Response(JSON.stringify({active:true,id:"synthetic-gid",client_id:"synthetic-client",attributes:{gid:"synthetic-gid",zjhm:"PB22000088",name:"认证姓名",email:"campus@example.test"}}))});
  const app=await createApp({store,allowedOrigins:[origin],secureCookies:false,allowLoopbackInsecureCookies:true,
    ustcOAuthClient:client,emailRegistrationEnabled:true,emailVerificationDelivery:outbox,emailVerificationWebUrl:origin});
  const address=await app.listen({host:"127.0.0.1",port:0});
  let providerFailure:string|null=null;
  let callbackStatus:number|null=null;
  let callbackSessionPresent=false;
  let callbackBindingPresent=false;
  const finish=client.finishLogin.bind(client);
  client.finishLogin=async input=>{try{return await finish(input);}catch(error){providerFailure=(error as {code?:string}).code??"unknown";throw error;}};
  const password="synthetic-browser-link-password";
  try {
    await app.inject({method:"POST",url:"/api/v1/auth/email-register",headers:{origin},payload:{username:"FreeAlias",nickname:"自选昵称",email:"local@example.test",password}});
    const verificationToken=new URLSearchParams(new URL(outbox.messages[0]!.verificationUrl).hash.split("?")[1]).get("token");
    await app.inject({method:"POST",url:"/api/v1/auth/email-verification/verify",headers:{origin},payload:{token:verificationToken}});
    await page.route("**/api/v1/**",async route=>{
      const url=new URL(route.request().url());
      if(url.pathname.endsWith('/ustc/callback')) {
        const headers=await route.request().allHeaders();
        callbackSessionPresent=(headers.cookie??'').includes('urmotiv_session=');
        callbackBindingPresent=(headers.cookie??'').includes('urmotiv_ustc_binding_');
      }
      const response=await route.fetch({url:address+url.pathname+url.search,maxRedirects:0});
      if(url.pathname.endsWith('/ustc/callback')) callbackStatus=response.status();
      await route.fulfill({response});
    });
    await page.route("https://id.ustc.edu.cn/**",async route=>{
      const state=new URL(route.request().url()).searchParams.get("state")!;
      const callback=origin+"/api/v1/auth/ustc/callback?"+new URLSearchParams({state,code:"synthetic-code"});
      // 新导航会再次经过路由转发；模拟 HTTP 重定向链会绕过后续 Playwright route。
      await route.fulfill({contentType:"text/html; charset=utf-8",body:`<a href="${callback.replaceAll("&","&amp;")}">确认合成身份</a>`});
    });
    const login=async()=>{
      await page.goto("/login");await page.getByLabel("用户名或邮箱",{exact:true}).fill("FreeAlias");
      await page.getByLabel("密码",{exact:true}).fill(password);await page.getByRole("button",{name:"登录",exact:true}).click();
      await expect(page).toHaveURL(/\/problems$/);
    };
    await login();await page.goto("/profile");
    const panel=page.getByRole("region",{name:"关联登录"});
    await panel.getByLabel("验证当前密码",{exact:true}).fill(password);
    await panel.getByRole("button",{name:"绑定 USTC 身份",exact:true}).click();
    await page.getByRole("link",{name:"确认合成身份",exact:true}).click();
    await expect.poll(()=>({identity:new URL(page.url()).searchParams.get('identity'),providerFailure,callbackStatus,callbackSessionPresent,callbackBindingPresent})).toEqual({identity:'linked',providerFailure:null,callbackStatus:302,callbackSessionPresent:true,callbackBindingPresent:true});
    await expect(panel.getByText("PB22000088",{exact:true})).toBeVisible();
    await expect(panel.getByText("认证姓名",{exact:true}).last()).toBeVisible();
    await expect(panel.getByText("campus@example.test",{exact:true})).toBeVisible();
    await expect(page.getByTestId("profile-username")).toHaveValue("FreeAlias");
    await expect(page.getByTestId("profile-email")).toHaveValue("local@example.test");
    expect(await page.evaluate(()=>document.documentElement.scrollWidth-innerWidth)).toBeLessThanOrEqual(1);
    await page.evaluate(()=>window.scrollTo(0,0));
    await page.screenshot({path:testInfo.outputPath("linked-identity.png"),fullPage:true});
    await panel.getByLabel("验证当前密码",{exact:true}).fill(password);
    page.once("dialog",dialog=>dialog.accept());
    await panel.getByRole("button",{name:"解绑此身份",exact:true}).click();
    await expect(page).toHaveURL(/identity=unlinked/);
    await login();await page.goto("/profile");
    await expect(panel.getByText("尚未绑定第三方身份。用户名无需与学号相同。",{exact:true})).toBeVisible();
    expect(await store.hasExternalIdentity("ustc-oauth","synthetic-gid")).toBe(false);
  } finally {await app.close();}
});
