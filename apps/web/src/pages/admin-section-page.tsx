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
  publicRegistrationEnabled: boolean;
  publicSiteUrl: string;
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
      publicRegistrationEnabled: settings.publicRegistrationEnabled,
      publicSiteUrl: settings.publicSiteUrl
    });
  }, [query.data]);
  const mutation = useMutation({
    mutationFn: updateAdminGeneralSettings,
    onSuccess: (result) => {
      setDraft({
        expectedRevision: result.settings.revision,
        publicRegistrationEnabled: result.settings.publicRegistrationEnabled,
        publicSiteUrl: result.settings.publicSiteUrl
      });
      void client.invalidateQueries({ queryKey: ["admin-general-settings"] });
    }
  });
  if (query.isPending) return <LoadingState />;
  if (query.isError) return <ErrorState message={query.error.message} />;
  if (draft === null) return <LoadingState />;
  const update = (key: keyof GeneralDraft, value: string | boolean) => {
    setDraft((current) => current === null ? current : { ...current, [key]: value });
  };
  return (
    <form className="plain-panel admin-form" onSubmit={(event) => { event.preventDefault(); mutation.mutate(draft); }}>
      <p>公开注册和公开站点地址由服务端保存；生产站点必须使用 HTTPS，认证回调会使用此规范域名。</p>
      <dl>
        <dt>邮箱登录</dt><dd>{query.data.settings.emailLoginEnabled ? "已启用" : "已关闭"}</dd>
        <dt>邮件投递能力</dt><dd>{query.data.settings.emailRegistrationEnabled ? "已配置" : "未配置"}</dd>
        <dt>安全 Cookie</dt><dd>{query.data.settings.secureCookies ? "已启用" : "未启用"}</dd>
        <dt>回环 HTTP Cookie</dt><dd>{query.data.settings.loopbackInsecureCookies ? "显式允许" : "禁止"}</dd>
        <dt>允许的网页来源</dt><dd>{query.data.settings.webOrigins.join("、") || "无"}</dd>
      </dl>
      <label>
        公开站点 URL
        <input
          value={draft.publicSiteUrl}
          onChange={(event) => update("publicSiteUrl", event.target.value)}
          placeholder="https://urmotiv.example"
          required
        />
      </label>
      <label>
        <input
          type="checkbox"
          checked={draft.publicRegistrationEnabled}
          disabled={!query.data.settings.emailLoginEnabled || !query.data.settings.emailRegistrationEnabled}
          onChange={(event) => update("publicRegistrationEnabled", event.target.checked)}
        />
        允许公开注册
      </label>
      {!query.data.settings.emailRegistrationEnabled
        ? <p>当前部署未配置邮件投递，不能启用公开注册。</p>
        : null}
      <button type="submit" disabled={mutation.isPending}>保存常规设置</button>
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
