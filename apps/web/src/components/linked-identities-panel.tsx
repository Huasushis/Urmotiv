import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useSearchParams } from "react-router-dom";
import { getLinkedIdentities, startUstcIdentityLink, unlinkIdentity } from "../lib/api";
import { clearProblemDrafts } from "../lib/client-security";

export function LinkedIdentitiesPanel() {
  const identities=useQuery({queryKey:["linked-identities"],queryFn:getLinkedIdentities,retry:false,staleTime:30_000});
  const [password,setPassword]=useState("");
  const [params]=useSearchParams();
  const client=useQueryClient();const navigate=useNavigate();
  const link=useMutation({mutationFn:()=>startUstcIdentityLink(password),onSuccess:result=>{setPassword("");window.location.assign(result.authorizeUrl);}});
  const unlink=useMutation({mutationFn:(identity:{provider:string;subject:string})=>unlinkIdentity(identity.provider,identity.subject,password),onSuccess:()=>{
    setPassword("");clearProblemDrafts();client.clear();navigate("/login?identity=unlinked",{replace:true});
  }});
  const settings=identities.data;
  return <section className="plain-panel linked-identities-panel" aria-label="关联登录">
    <div className="section-title"><div><p className="eyebrow">学校身份</p><h2>关联登录</h2></div></div>
    <p>学校认证资料单独展示。绑定保持现有用户名、联系邮箱、投稿和权限，学校身份以 gid/id 唯一识别。</p>
    {params.get("identity")==="linked"?<p className="notice-line" role="status">学校身份已绑定，可以用它登录当前账号。</p>:null}
    {params.get("identity")==="conflict"?<p className="form-error" role="alert">此学校身份已有其他关联，或当前账号已经绑定另一个学校身份。请核对账号后重试。</p>:null}
    {identities.isPending?<p role="status">正在读取关联身份…</p>:identities.isError?<p role="alert">暂时无法读取关联身份。</p>:settings?<>
      {!settings.ustcEnabled?<p className="muted-note">学校统一身份认证暂未启用，已有绑定记录继续保留。</p>:null}
      {!settings.items.length?<p className="empty-state">尚未绑定第三方身份。用户名无需与学号相同。</p>:null}
      {settings.canManage && (settings.ustcEnabled || settings.items.length>0)?<form className="form-grid identity-actions" onSubmit={event=>{
        event.preventDefault();if(settings.ustcEnabled && !settings.items.some(item=>item.provider==="ustc-oauth"))link.mutate();
      }}>
        <label>验证当前密码<input type="password" autoComplete="current-password" value={password} onChange={event=>setPassword(event.target.value)} required maxLength={1024} disabled={!settings.hasPassword} /></label>
        <small>先输入当前密码，再绑定或解绑。解绑后须保留可用登录方式；尚无密码时，可在上方“账号安全”设置本地密码。</small>
        {!settings.items.some(item=>item.provider==="ustc-oauth")?<button type="submit" className="primary-button" disabled={!settings.ustcEnabled||!settings.hasPassword||!password||link.isPending||unlink.isPending}>{link.isPending?"正在前往学校认证…":"绑定 USTC 身份"}</button>:null}
      </form>:null}
      {settings.items.map(identity=><section className="linked-identity-card" key={identity.provider+":"+identity.subject}>
        <h3>{identity.provider==="ustc-oauth"?"中国科学技术大学":identity.provider==="ustc-cas"?"USTC CAS":identity.provider}</h3>
        <dl className="identity-attributes">
          <div><dt>身份编号（gid/id）</dt><dd>{identity.subject}</dd></div>
          <div><dt>认证学号</dt><dd>{identity.studentId||"上次认证未记录"}</dd></div>
          <div><dt>认证姓名</dt><dd>{identity.realName||"上次认证未记录"}</dd></div>
          <div><dt>学校提供的邮箱</dt><dd>{identity.email||"未提供"}</dd></div>
        </dl>
        <button type="button" className="secondary-button" disabled={!settings.canManage||!settings.hasPassword||unlink.isPending||link.isPending||!password} onClick={()=>{
          if(window.confirm("解绑后将退出登录。请确认仍有可用的邮箱或用户名密码等登录方式。继续解绑吗？")) unlink.mutate(identity);
        }}>解绑此身份</button>
      </section>)}
      {!settings.canManage?<p className="muted-note">root、机器人和模拟登录会话不能绑定或解绑学校身份。</p>:null}
      {link.error||unlink.error?<p className="form-error" role="alert">{link.error?.message||unlink.error?.message}</p>:null}
    </>:null}
  </section>;
}
