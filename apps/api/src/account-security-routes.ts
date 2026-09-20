import { randomBytes } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { digestSecretToken, hashPassword, normalizeEmail, verifyEmailLoginPassword } from "@urmotiv/auth";
import { accountSecurityViewSchema, changePasswordInputSchema, confirmEmailChangeInputSchema,
  requestEmailChangeInputSchema, requestPasswordResetInputSchema, resetPasswordInputSchema } from "@urmotiv/contracts";
import type { StoredSession, StoredUser } from "./domain";
import type { AccountActionToken, AccountSecurityState, DataStore } from "./repository";
import type { EmailVerificationDelivery, EmailVerificationMessage } from "./email-verification";
import { ApiError, unauthorized } from "./errors";
import { InMemoryLoginRateLimiterStorage, LoginRateLimiter } from "./login-rate-limiter";

interface AccountSecurityDependencies {
  store: DataStore;
  delivery: EmailVerificationDelivery | undefined;
  now: () => Date;
  webUrl: () => Promise<string>;
  currentSession: (request: FastifyRequest) => Promise<{ user: StoredUser; session: StoredSession } | undefined>;
  clientAddress: (request: FastifyRequest) => string | undefined;
  clearSession: (reply: FastifyReply) => void;
}

export function registerAccountSecurityRoutes(app: FastifyInstance, deps: AccountSecurityDependencies): void {
  const limiter = new LoginRateLimiter({ maxFailedAttempts: 10, windowMs: 15 * 60_000,
    storage: new InMemoryLoginRateLimiterStorage(), now: () => deps.now().getTime() });
  const pendingMail = new Set<Promise<void>>();
  app.addHook("onClose", async () => { await Promise.allSettled([...pendingMail]); });

  function limit(request: FastifyRequest): void {
    const source = deps.clientAddress(request) ?? "unknown";
    if (limiter.isBlocked(source)) throw new ApiError(429,"ACCOUNT_ACTION_RATE_LIMITED","操作过于频繁，请稍后再试。");
    limiter.recordFailure(source);
  }
  async function notImpersonating(request: FastifyRequest) {
    const current = await deps.currentSession(request);
    if (current?.session.impersonatorUserId != null) throw new ApiError(403,"IMPERSONATION_CREDENTIAL_CHANGE","切换用户期间不能修改登录方式，请重新登录本人账号。");
    return current;
  }
  async function requireSelf(request: FastifyRequest): Promise<StoredUser> {
    const current=await notImpersonating(request);
    if (!current) throw unauthorized();
    if (current.user.accountType!=="human") throw new ApiError(404,"NOT_FOUND","未找到请求的资源。");
    return current.user;
  }
  async function verifyCurrentPassword(user: StoredUser, password: string): Promise<AccountSecurityState> {
    const state=await deps.store.getAccountSecurity(user.id);
    if (!await verifyEmailLoginPassword(state?.passwordHash ?? undefined,password) || !state?.passwordHash) {
      throw new ApiError(400,"CURRENT_PASSWORD_INVALID","当前密码不正确；尚未设置密码时，可先通过已验证邮箱找回密码。");
    }
    return state;
  }
  async function sendAction(state: AccountSecurityState, purpose: AccountActionToken["purpose"], normalizedAddress: string): Promise<void> {
    if (!deps.delivery) throw new ApiError(503,"MAIL_UNAVAILABLE","邮箱服务尚未配置，请联系管理员。");
    const token="uac_"+randomBytes(32).toString("base64url");
    const expiresAt=new Date(deps.now().getTime()+30*60_000).toISOString();
    const url=new URL(await deps.webUrl());
    url.hash=`/${purpose === "password-reset" ? "reset-password" : "change-email"}?${new URLSearchParams({token})}`;
    const saved=await deps.store.replaceAccountActionToken({tokenDigest:digestSecretToken(token),userId:state.userId,
      purpose,authRevision:state.authRevision,normalizedAddress,expiresAt});
    if (!saved) throw new ApiError(409,"ACCOUNT_CHANGED","账号状态已变化，请重新登录后再试。");
    try { await deps.delivery.send({purpose,recipient:normalizedAddress,verificationUrl:url.toString(),expiresAt}); }
    catch { throw new ApiError(503,"MAIL_UNAVAILABLE","验证邮件暂时无法发送，请稍后重试。"); }
  }
  function invalidLink(): ApiError {
    return new ApiError(400,"INVALID_ACCOUNT_LINK","链接无效、已过期或账号状态已变化，请重新申请。");
  }
  function privateResponse(reply: FastifyReply): void { reply.header("cache-control","private, no-store"); }

  app.get("/api/v1/me/security",async(request,reply)=>{
    privateResponse(reply);
    const current=await deps.currentSession(request);
    if (!current) throw unauthorized();
    const state=await deps.store.getAccountSecurity(current.user.id);
    return accountSecurityViewSchema.parse({hasPassword:Boolean(state?.passwordHash),
      canChangeCredentials:current.user.accountType==="human" && current.session.impersonatorUserId==null});
  });

  app.post("/api/v1/me/password",async(request,reply)=>{
    privateResponse(reply); const user=await requireSelf(request); limit(request);
    const input=changePasswordInputSchema.parse(request.body);
    const state=await verifyCurrentPassword(user,input.currentPassword);
    const changed=await deps.store.changeAccountPassword({userId:user.id,expectedAuthRevision:state.authRevision,
      expectedPasswordHash:state.passwordHash!,newPasswordHash:await hashPassword(input.newPassword),requestId:request.id,now:deps.now().toISOString()});
    if (!changed) throw new ApiError(409,"ACCOUNT_CHANGED","账号状态已变化，请重新登录后再试。");
    deps.clearSession(reply); return {ok:true};
  });

  app.post("/api/v1/auth/password-reset/request",async(request,reply)=>{
    privateResponse(reply); await notImpersonating(request); limit(request);
    const input=requestPasswordResetInputSchema.parse(request.body);
    const normalizedAddress=normalizeEmail(input.email);
    // 存在与不存在的账号都立即得到相同响应；投递耗时和失败不暴露账号存在。
    const operation=(async()=>{
      const state=await deps.store.findPasswordRecoveryAccount(normalizedAddress);
      if (state) await sendAction(state,"password-reset",normalizedAddress);
    })().catch(()=>{ app.log.warn({code:"ACCOUNT_RECOVERY_MAIL_FAILED"},"账号恢复邮件暂未投递"); });
    pendingMail.add(operation);
    void operation.finally(()=>pendingMail.delete(operation));
    reply.code(202); return {ok:true};
  });

  app.post("/api/v1/auth/password-reset/confirm",async(request,reply)=>{
    privateResponse(reply); await notImpersonating(request); limit(request);
    const input=resetPasswordInputSchema.parse(request.body);
    const result=await deps.store.consumeAccountAction({tokenDigest:digestSecretToken(input.token),purpose:"password-reset",
      newPasswordHash:await hashPassword(input.newPassword),requestId:request.id,now:deps.now().toISOString()});
    if (!result) throw invalidLink();
    deps.clearSession(reply); return {ok:true};
  });

  app.post("/api/v1/me/email-change",async(request,reply)=>{
    privateResponse(reply); const user=await requireSelf(request); limit(request);
    const input=requestEmailChangeInputSchema.parse(request.body);
    const state=await verifyCurrentPassword(user,input.currentPassword);
    const normalizedAddress=normalizeEmail(input.newEmail);
    if (state.email?.normalizedAddress===normalizedAddress) throw new ApiError(422,"EMAIL_UNCHANGED","请填写与当前邮箱不同的新地址。");
    await sendAction(state,"email-change",normalizedAddress);
    reply.code(202); return {ok:true};
  });

  app.post("/api/v1/auth/email-change/confirm",async(request,reply)=>{
    privateResponse(reply); await notImpersonating(request); limit(request);
    const input=confirmEmailChangeInputSchema.parse(request.body);
    const result=await deps.store.consumeAccountAction({tokenDigest:digestSecretToken(input.token),purpose:"email-change",requestId:request.id,now:deps.now().toISOString()});
    if (!result) throw invalidLink();
    deps.clearSession(reply);
    let notificationSent=result.previousEmail===null;
    if (result.previousEmail && deps.delivery) {
      try {
        const message: EmailVerificationMessage={purpose:"email-changed",recipient:result.previousEmail,
          verificationUrl:await deps.webUrl(),expiresAt:deps.now().toISOString()};
        await deps.delivery.send(message); notificationSent=true;
      }
      catch { app.log.warn({code:"ACCOUNT_EMAIL_NOTIFICATION_FAILED"},"旧邮箱变更通知暂未投递"); }
    }
    return {ok:true,notificationSent};
  });
}
