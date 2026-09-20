import { expect, test } from "@playwright/test";
import { createApp } from "../../api/src/app";
import { InMemoryEmailVerificationOutbox } from "../../api/src/email-verification";

test("修改密码、验证换邮箱和邮件找回通过同一账号完整往返",async({page},testInfo)=>{
  const origin="http://127.0.0.1:5173";
  const outbox=new InMemoryEmailVerificationOutbox();
  const app=await createApp({allowedOrigins:[origin],emailRegistrationEnabled:true,emailVerificationDelivery:outbox,emailVerificationWebUrl:origin});
  const originalPassword="synthetic-browser-before";
  const newPassword="synthetic-browser-after";
  const recoveryPassword="synthetic-browser-recovered";
  try {
    await app.inject({method:"POST",url:"/api/v1/auth/email-register",headers:{origin},payload:{username:"SyntheticMember",nickname:"合成投稿人",email:"before@example.test",password:originalPassword}});
    const verificationToken=new URLSearchParams(new URL(outbox.messages[0]!.verificationUrl).hash.split("?")[1]).get("token");
    await app.inject({method:"POST",url:"/api/v1/auth/email-verification/verify",headers:{origin},payload:{token:verificationToken}});
    // 浏览器请求经过真实 Fastify 路由，投递使用仅测试可读的内存邮箱；没有公开取票接口。
    await page.route("**/api/v1/**",async route=>{
      const request=route.request();
      const response=await app.inject({method:request.method() as "GET"|"POST"|"PATCH",url:new URL(request.url()).pathname+new URL(request.url()).search,
        headers:request.headers(),...(request.postData()===null?{}:{payload:request.postData()!})});
      const headers:Record<string,string>={};
      for(const [key,value] of Object.entries(response.headers)) if(value!==undefined) headers[key]=Array.isArray(value)?value.join(", "):String(value);
      await route.fulfill({status:response.statusCode,headers,body:response.rawPayload});
    });
    const login=async(identifier:string,password:string)=>{
      await page.goto("/login");
      await page.getByLabel("用户名或邮箱",{exact:true}).fill(identifier);
      await page.getByLabel("密码",{exact:true}).fill(password);
      await page.getByRole("button",{name:"登录",exact:true}).click();
      await expect(page).toHaveURL(/\/problems$/);
    };
    await login("SyntheticMember",originalPassword);
    await page.goto("/profile");
    const panel=page.getByRole("region",{name:"账号安全"});
    await panel.getByLabel("当前密码",{exact:true}).fill(originalPassword);
    await panel.getByLabel("新密码",{exact:true}).fill(newPassword);
    await panel.getByLabel("再次输入新密码",{exact:true}).fill(newPassword);
    await panel.getByRole("button",{name:"修改密码并重新登录"}).click();
    await expect(page).toHaveURL(/security=password-changed/);
    await login("SyntheticMember",newPassword);
    await page.goto("/profile");
    await panel.getByLabel("确认当前密码",{exact:true}).fill(newPassword);
    await panel.getByLabel("新邮箱",{exact:true}).fill("after@example.test");
    await panel.getByRole("button",{name:"发送新邮箱验证链接"}).click();
    await expect(panel.getByRole("status")).toContainText("验证邮件已发送");
    const change=outbox.messages.find(message=>message.purpose==="email-change")!;
    await page.goto(change.verificationUrl);
    await page.getByRole("button",{name:"确认新邮箱",exact:true}).click();
    await expect(page).toHaveURL(/security=email-changed/);
    expect(outbox.messages.some(message=>message.purpose==="email-changed"&&message.recipient==="before@example.test")).toBe(true);
    await page.getByRole("link",{name:"忘记密码？"}).click();
    await page.getByLabel("邮箱",{exact:true}).fill("after@example.test");
    await page.getByRole("button",{name:"发送找回链接",exact:true}).click();
    await expect(page.getByRole("status")).toContainText("如果该邮箱可用于恢复账号");
    await expect.poll(()=>outbox.messages.some(message=>message.purpose==="password-reset")).toBe(true);
    const recovery=outbox.messages.find(message=>message.purpose==="password-reset")!;
    await page.goto(recovery.verificationUrl);
    await page.getByRole("heading",{name:"设置新密码",exact:true}).waitFor();
    await page.screenshot({path:testInfo.outputPath("password-recovery.png"),fullPage:true});
    await page.getByLabel("新密码",{exact:true}).fill(recoveryPassword);
    await page.getByLabel("再次输入新密码",{exact:true}).fill(recoveryPassword);
    await page.getByRole("button",{name:"保存新密码",exact:true}).click();
    await expect(page).toHaveURL(/security=password-reset/);
    await login("after@example.test",recoveryPassword);
    await page.goto("/profile");
    await expect(page.getByTestId("profile-email")).toHaveValue("after@example.test");
    await expect(page.getByTestId("profile-username")).toHaveValue("SyntheticMember");
    expect(await page.evaluate(()=>document.documentElement.scrollWidth-innerWidth)).toBeLessThanOrEqual(1);
    await page.screenshot({path:testInfo.outputPath("account-security.png"),fullPage:true});
  } finally {await app.close();}
});
