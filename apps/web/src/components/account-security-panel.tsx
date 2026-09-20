import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "react-router-dom";
import { changeMyPassword, getAccountSecurity, requestMyEmailChange, initializeMyPassword } from "../lib/api";
import { clearProblemDrafts } from "../lib/client-security";

export function AccountSecurityPanel() {
  const query=useQuery({queryKey:["account-security"],queryFn:getAccountSecurity,retry:false,staleTime:30_000});
  const [currentPassword,setCurrentPassword]=useState("");
  const [newPassword,setNewPassword]=useState("");
  const [confirmedPassword,setConfirmedPassword]=useState("");
  const [emailPassword,setEmailPassword]=useState("");
  const [newEmail,setNewEmail]=useState("");
  const [validationError,setValidationError]=useState("");
  const client=useQueryClient();
  const navigate=useNavigate();
  const password=useMutation({mutationFn:()=>query.data?.hasPassword?changeMyPassword({currentPassword,newPassword}):initializeMyPassword(newPassword),onSuccess:()=>{
    clearProblemDrafts();client.clear();navigate("/login?security=password-changed",{replace:true});
  }});
  const email=useMutation({mutationFn:()=>requestMyEmailChange({currentPassword:emailPassword,newEmail}),onSuccess:()=>{
    setEmailPassword("");setNewEmail("");
  }});
  return <section id="account-security" className="plain-panel account-security-panel" aria-label="账号安全">
    <div className="section-title"><div><p className="eyebrow">登录与联系</p><h2>账号安全</h2></div></div>
    {query.isPending ? <p role="status">正在读取登录方式…</p> : query.isError ? <p role="alert">暂时无法读取账号安全设置。</p> : !query.data.canChangeCredentials ?
      <p className="notice-line">切换用户期间或机器人账号不能修改登录凭据。请重新登录本人账号。</p> : <>
      {!query.data.hasPassword ? <p className="notice-line">{query.data.canInitializePassword?"刚完成身份认证，可以在下方设置本地密码。":"还没有设置本地密码。请先验证联系邮箱，再通过找回密码设置；也可重新使用学校身份登录后设置。"} <Link to="/forgot-password">找回密码</Link> · <Link to="/login">重新认证</Link></p> : null}
      <div className="account-security-grid">
        <form className="form-grid" onSubmit={event=>{
          event.preventDefault();setValidationError("");
          if(newPassword!==confirmedPassword){setValidationError("两次输入的新密码不一致。");return;}
          password.mutate();
        }}>
          <h3>{query.data.hasPassword?"修改密码":"设置初始密码"}</h3>
          {query.data.hasPassword?<label>当前密码<input type="password" autoComplete="current-password" value={currentPassword} onChange={event=>setCurrentPassword(event.target.value)} required maxLength={1024} /></label>:null}
          <label>新密码<input type="password" autoComplete="new-password" value={newPassword} onChange={event=>setNewPassword(event.target.value)} required minLength={12} maxLength={1024} /></label>
          <label>再次输入新密码<input type="password" autoComplete="new-password" value={confirmedPassword} onChange={event=>setConfirmedPassword(event.target.value)} required minLength={12} maxLength={1024} /></label>
          <small>至少 12 个字符。成功后需要重新登录，其他设备的旧会话也会退出。</small>
          <button className="primary-button" type="submit" disabled={(!query.data.hasPassword&&!query.data.canInitializePassword)||password.isPending}>{password.isPending?"正在保存…":query.data.hasPassword?"修改密码并重新登录":"设置密码并重新登录"}</button>
          {validationError||password.error ? <p role="alert" className="form-error">{validationError||password.error?.message}</p> : null}
        </form>
        <form className="form-grid" onSubmit={event=>{event.preventDefault();email.mutate();}}>
          <h3>更换邮箱</h3>
          <label>确认当前密码<input type="password" autoComplete="current-password" value={emailPassword} onChange={event=>setEmailPassword(event.target.value)} required maxLength={1024} /></label>
          <label>新邮箱<input type="email" autoComplete="email" value={newEmail} onChange={event=>setNewEmail(event.target.value)} required maxLength={320} /></label>
          <small>验证新邮箱后才会切换，并向原已验证邮箱发送通知。用户名、题目和权限不变。</small>
          <button className="primary-button" type="submit" disabled={!query.data.hasPassword||email.isPending}>{email.isPending?"正在发送…":"发送新邮箱验证链接"}</button>
          {email.isSuccess ? <p role="status" className="notice-line">验证邮件已发送。确认前旧邮箱保持不变；确认后请使用新邮箱或用户名重新登录。</p> : null}
          {email.error ? <p role="alert" className="form-error">{email.error.message}</p> : null}
        </form>
      </div>
    </>}
  </section>;
}
