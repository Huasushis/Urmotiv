import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  getAdminGeneralSettings,
  getAdminUstcOAuthSettings,
  listAdminAudit,
  listAdminServiceAccounts,
  listImportHistory,
  updateAdminGeneralSettings,
  updateAdminUstcOAuthSettings
} from "../lib/api";
import type { SessionUser } from "@urmotiv/contracts";
import { AdminLayout } from "../components/admin-layout";

export type AdminSection =
  | "settings"
  | "service-accounts"
  | "audit"
  | "oauth"
  | "imports";

function ErrorState({ message }: { message: string }) {
  return <div className="plain-panel error-state" role="alert">{message}</div>;
}

function LoadingState() {
  return <div className="plain-panel" role="status">正在读取服务端数据……</div>;
}

function SectionFrame({ section, session, children }: { section: AdminSection; session: SessionUser; children: React.ReactNode }) {
  const labels: Record<AdminSection, string> = {
    settings: "常规设置",
    "service-accounts": "服务账号与令牌",
    audit: "审计记录",
    oauth: "统一身份认证",
    imports: "导入历史"
  };
  return (
    <AdminLayout session={session} title={labels[section]}>
      {children}
    </AdminLayout>
  );
}

type GeneralDraft = {
  expectedRevision: number;
  emailLoginEnabled: boolean;
  publicRegistrationEnabled: boolean;
  publicSiteUrl: string;
  smtpHost: string;
  smtpPort: number;
  smtpSecure: boolean;
  smtpUsername: string;
  smtpFromEmail: string;
  smtpFromName: string;
  smtpPassword: string;
  clearSmtpPassword: boolean;
};

function SettingsSection() {
  const client = useQueryClient();
  const query = useQuery({ queryKey: ["admin-general-settings"], queryFn: getAdminGeneralSettings });
  const [draft, setDraft] = useState<GeneralDraft | null>(null);
  useEffect(() => {
    if (query.data === undefined) return;
    const settings = query.data.settings;
    setDraft((current) => current ?? {
      expectedRevision: settings.revision,
      emailLoginEnabled: settings.emailLoginEnabled,
      publicRegistrationEnabled: settings.publicRegistrationEnabled,
      publicSiteUrl: settings.publicSiteUrl,
      smtpHost: settings.smtpHost,
      smtpPort: settings.smtpPort,
      smtpSecure: settings.smtpSecure,
      smtpUsername: settings.smtpUsername,
      smtpFromEmail: settings.smtpFromEmail,
      smtpFromName: settings.smtpFromName,
      smtpPassword: "",
      clearSmtpPassword: false
    });
  }, [query.data]);
  const mutation = useMutation({
    mutationFn: updateAdminGeneralSettings,
    onSuccess: (result) => {
      setDraft({
        expectedRevision: result.settings.revision,
        emailLoginEnabled: result.settings.emailLoginEnabled,
        publicRegistrationEnabled: result.settings.publicRegistrationEnabled,
        publicSiteUrl: result.settings.publicSiteUrl,
        smtpHost: result.settings.smtpHost,
        smtpPort: result.settings.smtpPort,
        smtpSecure: result.settings.smtpSecure,
        smtpUsername: result.settings.smtpUsername,
        smtpFromEmail: result.settings.smtpFromEmail,
        smtpFromName: result.settings.smtpFromName,
        smtpPassword: "",
        clearSmtpPassword: false
      });
      void client.invalidateQueries({ queryKey: ["admin-general-settings"] });
    }
  });
  if (query.isPending) return <LoadingState />;
  if (query.isError) return <ErrorState message={query.error.message} />;
  if (draft === null) return <LoadingState />;
  const update = (key: keyof GeneralDraft, value: string | boolean | number) => {
    setDraft((current) => current === null ? current : { ...current, [key]: value });
  };
  return (
    <form className="plain-panel admin-form" onSubmit={(event) => { event.preventDefault(); mutation.mutate(draft); }}>
      <section className="settings-form-section">
        <div><h2>站点</h2><p>认证回调和邮件链接使用这个地址；生产环境必须是 HTTPS。</p></div>
        <label>公开站点 URL<input value={draft.publicSiteUrl} onChange={(event) => update("publicSiteUrl", event.target.value)} placeholder="https://urmotiv.example" required /></label>
      </section>
      <section className="settings-form-section">
        <div><h2>账号注册与登录</h2><p>root 登录不受这里的邮箱登录开关影响。</p></div>
        <label className="checkbox-row"><input type="checkbox" checked={draft.emailLoginEnabled} onChange={(event) => update("emailLoginEnabled", event.target.checked)} />允许用户名或邮箱登录</label>
        <label className="checkbox-row"><input type="checkbox" checked={draft.publicRegistrationEnabled} onChange={(event) => update("publicRegistrationEnabled", event.target.checked)} />允许访客通过邮箱注册账号</label>
      </section>
      <section className="settings-form-section">
        <div>
          <h2>SMTP 发信</h2>
          <p>SMTP 是向邮箱发送验证码的标准服务。当前状态：{query.data.settings.smtpConfigured ? "已可用" : "未完整配置"}。</p>
        </div>
        <div className="settings-field-grid">
          <label>SMTP 主机<input value={draft.smtpHost} onChange={(event) => update("smtpHost", event.target.value)} placeholder="smtp.example.com" /></label>
          <label>端口<input type="number" min={1} max={65535} value={draft.smtpPort} onChange={(event) => update("smtpPort", Number(event.target.value))} /></label>
          <label>用户名<input value={draft.smtpUsername} onChange={(event) => update("smtpUsername", event.target.value)} autoComplete="off" /></label>
          <label>密码{query.data.settings.smtpPasswordConfigured ? "（已保存；留空不修改）" : ""}<input type="password" value={draft.smtpPassword} onChange={(event) => update("smtpPassword", event.target.value)} autoComplete="new-password" /></label>
          <label>发件邮箱<input type="email" value={draft.smtpFromEmail} onChange={(event) => update("smtpFromEmail", event.target.value)} placeholder="noreply@example.com" /></label>
          <label>发件人名称<input value={draft.smtpFromName} onChange={(event) => update("smtpFromName", event.target.value)} /></label>
        </div>
        <label className="checkbox-row"><input type="checkbox" checked={draft.smtpSecure} onChange={(event) => update("smtpSecure", event.target.checked)} />连接后立即使用 TLS（通常用于 465 端口；587 会自动升级为加密连接）</label>
        {query.data.settings.smtpPasswordConfigured ? <label className="checkbox-row"><input type="checkbox" checked={draft.clearSmtpPassword} onChange={(event) => update("clearSmtpPassword", event.target.checked)} />清除已保存的 SMTP 密码</label> : null}
      </section>
      <section className="settings-runtime-note">
        <h2>部署安全状态</h2>
        <p>安全 Cookie：{query.data.settings.secureCookies ? "启用" : "关闭"}；允许网页来源：{query.data.settings.webOrigins.join("、") || "无"}。</p>
      </section>
      <button type="submit" className="primary-button" disabled={mutation.isPending}>{mutation.isPending ? "正在保存…" : "保存常规设置"}</button>
      {mutation.isError ? <p role="alert">{mutation.error.message}</p> : null}
      {mutation.isSuccess ? <p role="status">常规设置已保存。</p> : null}
    </form>
  );
}


function ServiceAccountsSection() {
  const query = useQuery({ queryKey: ["admin-service-accounts"], queryFn: listAdminServiceAccounts });
  if (query.isPending) return <LoadingState />;
  if (query.isError) return <ErrorState message={query.error.message} />;
  return (
    <div className="plain-panel">
      <h2>机器人服务账号</h2>
      <table><thead><tr><th>名称</th><th>状态</th><th>令牌</th></tr></thead><tbody>
        {query.data.items.map((item) => <tr key={item.id}><td>{item.nickname}</td><td>{item.enabled ? "启用" : "停用"}</td><td>{item.tokenConfigured ? "已配置" : "未配置"}</td></tr>)}
      </tbody></table>
      <p>令牌创建和撤销继续使用服务端的服务账号接口；页面不会显示令牌值。</p>
    </div>
  );
}

function AuditSection() {
  const query = useQuery({ queryKey: ["admin-audit"], queryFn: () => listAdminAudit() });
  if (query.isPending) return <LoadingState />;
  if (query.isError) return <ErrorState message={query.error.message} />;
  return (
    <div className="plain-panel">
      <h2>最近操作（共 {query.data.total} 条）</h2>
      <table><thead><tr><th>时间</th><th>操作</th><th>对象</th><th>结果</th></tr></thead><tbody>
        {query.data.items.map((item) => <tr key={item.id}><td>{item.occurredAt}</td><td>{item.action}</td><td>{item.objectType}</td><td>{item.result}</td></tr>)}
      </tbody></table>
    </div>
  );
}

type OAuthDraft = {
  enabled: boolean;
  autoCreateUsers: boolean;
  authorizeUrl: string;
  tokenUrl: string;
  profileUrl: string;
  redirectUri: string;
  scope: string;
  clientId: string;
  clearClientId: boolean;
  clientSecret: string;
  clearClientSecret: boolean;
  expectedRevision: number;
};

function OAuthSection() {
  const client = useQueryClient();
  const query = useQuery({ queryKey: ["admin-ustc-oauth"], queryFn: getAdminUstcOAuthSettings });
  const [draft, setDraft] = useState<OAuthDraft | null>(null);
  useEffect(() => {
    if (query.data === undefined) return;
    const settings = query.data.settings;
    setDraft((current) => current ?? {
      enabled: settings.enabled,
      autoCreateUsers: settings.autoCreateUsers,
      authorizeUrl: settings.authorizeUrl,
      tokenUrl: settings.tokenUrl,
      profileUrl: settings.profileUrl,
      redirectUri: settings.redirectUri,
      scope: settings.scope,
      clientId: "",
      clearClientId: false,
      clientSecret: "",
      clearClientSecret: false,
      expectedRevision: settings.revision
    });
  }, [query.data]);
  const mutation = useMutation({
    mutationFn: updateAdminUstcOAuthSettings,
    onSuccess: (result) => {
      setDraft({
        enabled: result.settings.enabled,
        autoCreateUsers: result.settings.autoCreateUsers,
        authorizeUrl: result.settings.authorizeUrl,
        tokenUrl: result.settings.tokenUrl,
        profileUrl: result.settings.profileUrl,
        redirectUri: result.settings.redirectUri,
        scope: result.settings.scope,
        clientId: "",
        clearClientId: false,
        clientSecret: "",
        clearClientSecret: false,
        expectedRevision: result.settings.revision
      });
      void client.invalidateQueries({ queryKey: ["admin-ustc-oauth"] });
    }
  });
  if (query.isPending) return <LoadingState />;
  if (query.isError) return <ErrorState message={query.error.message} />;
  if (draft === null) return <LoadingState />;
  const update = (key: keyof OAuthDraft, value: string | boolean) => setDraft((current) => current === null ? current : { ...current, [key]: value });
  return (
    <form className="plain-panel admin-form" onSubmit={(event) => { event.preventDefault(); mutation.mutate(draft); }}>
      <p>客户端编号和密钥只写入服务端；保存成功后表单会清空这两个输入框，读取接口只返回是否已配置。</p>
      <label><input type="checkbox" checked={draft.enabled} onChange={(event) => update("enabled", event.target.checked)} /> 启用 USTC OAuth</label>
      <label className="checkbox-row"><input type="checkbox" checked={draft.autoCreateUsers} onChange={(event) => update("autoCreateUsers", event.target.checked)} />首次统一身份登录时自动创建账号</label>
      <label>授权 URL<input value={draft.authorizeUrl} onChange={(event) => update("authorizeUrl", event.target.value)} required={draft.enabled} /></label>
      <label>令牌 URL<input value={draft.tokenUrl} onChange={(event) => update("tokenUrl", event.target.value)} required={draft.enabled} /></label>
      <label>个人资料 URL<input value={draft.profileUrl} onChange={(event) => update("profileUrl", event.target.value)} required={draft.enabled} /></label>
      <label>回调 URL（固定路径）<input value={draft.redirectUri} onChange={(event) => update("redirectUri", event.target.value)} required={draft.enabled} /></label>
      <label>作用域<input value={draft.scope} onChange={(event) => update("scope", event.target.value)} placeholder="openid profile" /></label>
      <label>客户端编号{query.data.settings.clientIdConfigured ? "（已配置；重新输入才会替换）" : ""}<input value={draft.clientId} onChange={(event) => update("clientId", event.target.value)} required={draft.enabled && !query.data.settings.clientIdConfigured} /></label>
      <label><input type="checkbox" checked={draft.clearClientId} onChange={(event) => update("clearClientId", event.target.checked)} /> 清除已保存客户端编号</label>
      <label>客户端密钥{query.data.settings.clientSecretConfigured ? "（已配置；重新输入才会替换）" : ""}<input type="password" value={draft.clientSecret} onChange={(event) => update("clientSecret", event.target.value)} autoComplete="new-password" required={draft.enabled && !query.data.settings.clientSecretConfigured && !draft.clearClientSecret} /></label>
      <label><input type="checkbox" checked={draft.clearClientSecret} onChange={(event) => update("clearClientSecret", event.target.checked)} /> 清除已保存密钥</label>
      <button type="submit" disabled={mutation.isPending}>保存 OAuth 设置</button>
      {mutation.isError ? <p role="alert">{mutation.error.message}</p> : null}
      {mutation.isSuccess ? <p role="status">已保存；客户端编号和密钥输入框已清空。</p> : null}
    </form>
  );
}

function ImportHistorySection() {
  const query = useQuery({ queryKey: ["import-history"], queryFn: () => listImportHistory() });
  if (query.isPending) return <LoadingState />;
  if (query.isError) return <ErrorState message={query.error.message} />;
  return <div className="plain-panel"><h2>导入历史</h2><ul>{query.data.items.map((item) => <li key={item.id}>{item.state}，完成 {item.completedItems} 项，失败 {item.failedItems} 项，导入题目 {item.importedProblemIds.length} 项</li>)}</ul>{query.data.items.length === 0 ? <p>当前账号没有可显示的导入记录。</p> : null}</div>;
}

export function AdminSectionPage({ section, session }: { section: AdminSection; session: SessionUser }) {
  const content = useMemo(() => {
    switch (section) {
      case "settings": return <SettingsSection />;
      case "service-accounts": return <ServiceAccountsSection />;
      case "audit": return <AuditSection />;
      case "oauth": return <OAuthSection />;
      case "imports": return <ImportHistorySection />;
    }
  }, [section]);
  return <SectionFrame section={section} session={session}>{content}</SectionFrame>;
}
