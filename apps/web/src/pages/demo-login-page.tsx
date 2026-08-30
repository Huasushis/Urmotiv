import { LogIn, ShieldCheck } from "lucide-react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { useState } from "react";
import type { SessionResponse } from "@urmotiv/contracts";
import {
  casStartUrl,
  ustcOAuthStartUrl,
  accountLogin,
  demoLogin,
  emailRegister,
  resendEmailVerification
} from "../lib/api";
import { clearProblemDrafts } from "../lib/client-security";

const demoAccounts = [
  { id: "author", title: "投稿人", description: "创建、编辑和提交自己的题目" },
  { id: "reviewer", title: "审题人", description: "查看待审核题目并提交审核意见" },
  { id: "member", title: "命题组成员", description: "补充资料、配置数据并参与组题" },
  { id: "leader", title: "组长", description: "查看最终状态、导入和导出入口" },
  { id: "administrator", title: "系统管理员", description: "管理插件、账号和系统运行设置" },
  { id: "robot", title: "审核机器人", description: "检查固定禁止操作不会被绕过" },
  { id: "denied", title: "受限账号", description: "检查明确拒绝优先的界面反馈" }
];

export function DemoLoginPage({ existingSession }: { existingSession: SessionResponse | undefined }) {
  const client = useQueryClient();
  const navigate = useNavigate();
  const [identifier, setIdentifier] = useState("");
  const [password, setPassword] = useState("");
  const [nickname, setNickname] = useState("");
  const [registering, setRegistering] = useState(false);
  const [verificationPending, setVerificationPending] = useState(false);
  const auth = existingSession?.auth;
  const complete = (session: SessionResponse) => {
    clearProblemDrafts();
    client.clear();
    client.setQueryData(["session"], session);
    navigate("/problems");
  };
  const login = useMutation({ mutationFn: demoLogin, onSuccess: complete });
  const accountLoginAction = useMutation({
    mutationFn: () => accountLogin({ identifier, password }),
    onSuccess: complete
  });
  const emailRegistrationAction = useMutation({
    mutationFn: () => emailRegister({ email: identifier, password, nickname }),
    onSuccess: () => setVerificationPending(true)
  });
  const resendAction = useMutation({
    mutationFn: () => resendEmailVerification(identifier),
    onSuccess: () => setVerificationPending(true)
  });

  return (
    <div className="login-page">
      <section className="login-intro">
        <div className="brand compact"><span className="brand-mark">U</span><span>Urmotiv</span></div>
        <h1>题库协作，从一份可审阅的草稿开始</h1>
        <p>登录后可按已授予的权限投题、审题和整理题目资料。系统会在服务端再次核对权限。</p>
        {existingSession?.user ? <p className="notice-line">当前已作为“{existingSession.user.nickname}”登录。</p> : null}
      </section>
      <section className="login-panel" aria-labelledby="login-title">
        <div className="section-title">
          <div><p className="eyebrow">账号登录</p><h2 id="login-title">进入 Urmotiv</h2></div>
          <ShieldCheck size={22} aria-hidden="true" />
        </div>
        <form className="login-form" onSubmit={(event) => {
            event.preventDefault();
            if (registering) {
              emailRegistrationAction.mutate();
              return;
            }
            accountLoginAction.mutate();
          }}>
            {registering ? <label>昵称<input value={nickname} onChange={(event) => setNickname(event.target.value)} required maxLength={120} /></label> : null}
            <label>{registering ? "邮箱" : "用户名或邮箱"}<input type={registering ? "email" : "text"} autoComplete={registering ? "email" : "username"} value={identifier} onChange={(event) => setIdentifier(event.target.value)} required /></label>
            <label>密码<input type="password" autoComplete={registering ? "new-password" : "current-password"} value={password} onChange={(event) => setPassword(event.target.value)} required minLength={registering ? 12 : 8} /></label>
            <button type="submit" className="primary-button" disabled={accountLoginAction.isPending || emailRegistrationAction.isPending}>{registering ? "发送验证邮件" : "登录"}</button>
            {auth?.emailRegistrationEnabled ? (
              <button type="button" className="text-button" onClick={() => setRegistering((value) => !value)}>{registering ? "已有账号，去登录" : "注册新账号"}</button>
            ) : null}
          </form>
        {verificationPending ? (
          <div className="notice-line" role="status">
            验证邮件已安排发送。请打开邮件中的链接完成验证，再使用邮箱和密码登录。
            <button type="button" className="text-button" disabled={resendAction.isPending} onClick={() => resendAction.mutate()}>
              没有收到？重新发送
            </button>
          </div>
        ) : null}
        {auth?.ustcOAuthEnabled ? <button type="button" className="cas-button" onClick={() => { window.location.assign(ustcOAuthStartUrl("/problems")); }}>使用 USTC OAuth2 统一身份认证登录</button> : null}
        {auth?.casEnabled ? <button type="button" className="cas-button" onClick={() => { window.location.assign(casStartUrl("/problems")); }}>使用统一身份认证登录</button> : null}
        {auth?.demoEnabled ? <div className="demo-login-section"><p className="eyebrow">开发演示</p><div className="demo-account-list">{demoAccounts.map((account) => <button type="button" className="demo-account" key={account.id} disabled={login.isPending} onClick={() => login.mutate(account.id)}><span><strong>{account.title}</strong><small>{account.description}</small></span><LogIn size={17} aria-hidden="true" /></button>)}</div></div> : null}
        {auth?.emailEnabled === false ? <p className="notice-line">普通账号密码登录已关闭；root 恢复账号仍可在此登录。</p> : null}
        {accountLoginAction.error ? <p className="form-error">{accountLoginAction.error.message}</p> : null}
        {emailRegistrationAction.error ? <p className="form-error">{emailRegistrationAction.error.message}</p> : null}
        {resendAction.error ? <p className="form-error">{resendAction.error.message}</p> : null}
        {login.error ? <p className="form-error">{login.error.message}</p> : null}
      </section>
    </div>
  );
}
