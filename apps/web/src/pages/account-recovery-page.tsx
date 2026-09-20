import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "react-router-dom";
import { confirmEmailChange, confirmPasswordReset, requestPasswordReset } from "../lib/api";
import { clearProblemDrafts } from "../lib/client-security";

export function PasswordRecoveryPage() {
  const [email,setEmail]=useState("");
  const action=useMutation({mutationFn:()=>requestPasswordReset(email)});
  return <main className="centered-message"><section className="plain-panel verification-panel account-recovery-panel">
    <p className="eyebrow">账号恢复</p><h1>找回密码</h1>
    <p>填写账号已验证的联系邮箱。如果可以恢复，我们会发送一个 30 分钟内有效的链接。</p>
    <form className="form-grid" onSubmit={event=>{event.preventDefault();action.mutate();}}>
      <label>邮箱<input type="email" autoComplete="email" required maxLength={320} value={email} onChange={event=>setEmail(event.target.value)} /></label>
      <button className="primary-button" disabled={action.isPending}>{action.isPending?"正在提交…":"发送找回链接"}</button>
    </form>
    {action.isSuccess?<p role="status" className="notice-line">如果该邮箱可用于恢复账号，邮件将很快送达。请检查收件箱和垃圾邮件。</p>:null}
    {action.error?<p role="alert" className="form-error">{action.error.message}</p>:null}
    <Link to="/login">返回登录</Link>
  </section></main>;
}

export function AccountActionPage({purpose,token}:{purpose:"password-reset"|"email-change";token:string}) {
  const [password,setPassword]=useState("");
  const [confirmation,setConfirmation]=useState("");
  const [error,setError]=useState("");
  const client=useQueryClient();
  const navigate=useNavigate();
  const action=useMutation({mutationFn:async()=>{
    if(!/^uac_[A-Za-z0-9_-]{43}$/.test(token)) throw Error("验证链接不完整，请重新申请。");
    if(purpose==="password-reset") return {...await confirmPasswordReset(token,password),notificationSent:true};
    return confirmEmailChange(token);
  },onSuccess:result=>{
    clearProblemDrafts();client.clear();
    const path=`/login?security=${purpose==="password-reset"?"password-reset":"email-changed"}${result.notificationSent?"":"&notification=failed"}`;
    window.history.replaceState(null,"",path);navigate(path,{replace:true});
  }});
  return <main className="centered-message"><section className="plain-panel verification-panel account-recovery-panel">
    <p className="eyebrow">账号验证</p><h1>{purpose==="password-reset"?"设置新密码":"确认更换邮箱"}</h1>
    <p>链接只能使用一次。完成后旧会话将退出，请重新登录。</p>
    <form className="form-grid" onSubmit={event=>{event.preventDefault();setError("");
      if(purpose==="password-reset"&&password!==confirmation){setError("两次输入的密码不一致。");return;}action.mutate();}}>
      {purpose==="password-reset"?<>
        <label>新密码<input type="password" autoComplete="new-password" minLength={12} maxLength={1024} required value={password} onChange={event=>setPassword(event.target.value)} /></label>
        <label>再次输入新密码<input type="password" autoComplete="new-password" minLength={12} maxLength={1024} required value={confirmation} onChange={event=>setConfirmation(event.target.value)} /></label>
      </>:null}
      <button className="primary-button" disabled={action.isPending||!token}>{action.isPending?"正在处理…":purpose==="password-reset"?"保存新密码":"确认新邮箱"}</button>
    </form>
    {error||action.error?<p role="alert" className="form-error">{error||action.error?.message}</p>:null}
    <Link to={purpose==="password-reset"?"/forgot-password":"/profile"}>{purpose==="password-reset"?"重新申请找回密码":"返回个人资料重新申请"}</Link> · <Link to="/login">返回登录</Link>
  </section></main>;
}
