import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  createAdminRole,
  getAdminGeneralSettings,
  getAdminUstcOAuthSettings,
  getFermataHealth,
  getFermataSettings,
  listAdminAudit,
  listAdminPlugins,
  listAdminRoles,
  listAdminServiceAccounts,
  listImportHistory,
  listManagedTagCatalog,
  updateAdminGeneralSettings,
  updateAdminRole,
  updateAdminUstcOAuthSettings
} from "../lib/api";
import type {
  AdminManagedRole,
  AdminRoleManagementResponse,
  SessionUser
} from "@urmotiv/contracts";

export type AdminSection =
  | "settings"
  | "roles"
  | "service-accounts"
  | "audit"
  | "fermata"
  | "oauth"
  | "plugins"
  | "knowledge"
  | "imports";

function ErrorState({ message }: { message: string }) {
  return <div className="plain-panel error-state" role="alert">{message}</div>;
}

function LoadingState() {
  return <div className="plain-panel" role="status">正在读取服务端数据……</div>;
}

function SectionFrame({ section, children }: { section: AdminSection; children: React.ReactNode }) {
  const labels: Record<AdminSection, string> = {
    settings: "常规设置",
    roles: "角色与权限",
    "service-accounts": "服务账号与令牌",
    audit: "审计记录",
    fermata: "Fermata 服务",
    oauth: "USTC OAuth",
    plugins: "插件配置",
    knowledge: "知识点目录",
    imports: "导入历史"
  };
  return (
    <section className="admin-page admin-section-page">
      <div className="page-heading">
        <div>
          <p className="eyebrow">管理 / {labels[section]}</p>
          <h1>{labels[section]}</h1>
        </div>
      </div>
      <p><a href="/admin">返回管理首页</a></p>
      {children}
    </section>
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

type RoleDraft = {
  id: string | null;
  key: string;
  displayName: string;
  description: string;
  expectedRevision: number;
  isBuiltIn: boolean;
  permissions: Array<{ name: string; effect: "allow" | "deny" }>;
  userIds: string[];
};

function roleToDraft(role: AdminManagedRole): RoleDraft {
  return {
    id: role.id,
    key: role.key,
    displayName: role.displayName,
    description: role.description,
    expectedRevision: role.revision,
    isBuiltIn: role.isBuiltIn,
    permissions: role.permissions.map((permission) => ({ ...permission })),
    userIds: role.members.map((member) => member.id)
  };
}

function RolesSection() {
  const client = useQueryClient();
  const query = useQuery({ queryKey: ["admin-roles"], queryFn: listAdminRoles });
  const [draft, setDraft] = useState<RoleDraft | null>(null);
  useEffect(() => {
    if (query.data === undefined || draft !== null) return;
    const first = query.data.roles[0];
    if (first !== undefined) setDraft(roleToDraft(first));
  }, [query.data, draft]);
  const mutation = useMutation({
    mutationFn: (value: RoleDraft) => {
      const payload = {
        key: value.key,
        displayName: value.displayName,
        description: value.description,
        permissions: value.permissions,
        userIds: value.userIds
      };
      return value.id === null
        ? createAdminRole(payload)
        : updateAdminRole(value.id, { ...payload, expectedRevision: value.expectedRevision });
    },
    onSuccess: (result) => {
      setDraft(roleToDraft(result.role));
      void client.invalidateQueries({ queryKey: ["admin-roles"] });
    }
  });
  if (query.isPending) return <LoadingState />;
  if (query.isError) return <ErrorState message={query.error.message} />;
  if (draft === null) return <LoadingState />;
  const selectRole = (role: AdminManagedRole) => {
    setDraft(roleToDraft(role));
    mutation.reset();
  };
  const updateDraft = (patch: Partial<RoleDraft>) => {
    setDraft((current) => current === null ? current : { ...current, ...patch });
  };
  const togglePermission = (name: string, checked: boolean) => {
    const permissions = checked
      ? [...draft.permissions, { name, effect: "allow" as const }]
      : draft.permissions.filter((permission) => permission.name !== name);
    updateDraft({ permissions });
  };
  const changePermissionEffect = (name: string, effect: "allow" | "deny") => {
    updateDraft({
      permissions: draft.permissions.map((permission) =>
        permission.name === name ? { ...permission, effect } : permission
      )
    });
  };
  const toggleUser = (id: string, checked: boolean) => {
    updateDraft({ userIds: checked ? [...draft.userIds, id] : draft.userIds.filter((value) => value !== id) });
  };
  return (
    <div className="admin-two-column">
      <div className="plain-panel">
        <div className="section-heading">
          <h2>角色</h2>
          <button
            type="button"
            onClick={() => {
              setDraft({
                id: null,
                key: "",
                displayName: "",
                description: "",
                expectedRevision: 1,
                isBuiltIn: false,
                permissions: [],
                userIds: []
              });
              mutation.reset();
            }}
          >
            新建自定义角色
          </button>
        </div>
        <ul>
          {query.data.roles.map((role) => (
            <li key={role.id}>
              <button type="button" onClick={() => selectRole(role)}>
                {role.displayName}{role.isBuiltIn ? "（内置）" : ""}
              </button>
              <small>成员 {role.members.length} 人，权限 {role.permissions.length} 项</small>
            </li>
          ))}
        </ul>
        <h2>可用权限</h2>
        <ul>
          {query.data.permissions.map((permission) => (
            <li key={permission.name}>
              <strong>{permission.displayName}</strong>（{permission.name}）：{permission.description}
            </li>
          ))}
        </ul>
      </div>
      <form className="plain-panel admin-form" onSubmit={(event) => { event.preventDefault(); mutation.mutate(draft); }}>
        <h2>{draft.id === null ? "新建角色" : `编辑：${draft.displayName}`}</h2>
        {draft.isBuiltIn ? <p>内置角色的名称和权限不可修改；可以调整成员归属。</p> : null}
        <label>角色标识<input value={draft.key} disabled={draft.isBuiltIn} required onChange={(event) => updateDraft({ key: event.target.value })} /></label>
        <label>显示名称<input value={draft.displayName} disabled={draft.isBuiltIn} required onChange={(event) => updateDraft({ displayName: event.target.value })} /></label>
        <label>说明<textarea value={draft.description} disabled={draft.isBuiltIn} onChange={(event) => updateDraft({ description: event.target.value })} /></label>
        <fieldset disabled={draft.isBuiltIn}>
          <legend>权限</legend>
          {query.data.permissions.map((permission) => {
            const grant = draft.permissions.find((item) => item.name === permission.name);
            return (
              <label key={permission.name} className="checkbox-row">
                <input
                  type="checkbox"
                  checked={grant !== undefined}
                  onChange={(event) => togglePermission(permission.name, event.target.checked)}
                />
                {permission.displayName}
                {grant !== undefined ? (
                  <select value={grant.effect} onChange={(event) => changePermissionEffect(permission.name, event.target.value as "allow" | "deny")}>
                    <option value="allow">允许</option>
                    <option value="deny">明确拒绝</option>
                  </select>
                ) : null}
              </label>
            );
          })}
        </fieldset>
        <fieldset>
          <legend>分配账号</legend>
          {query.data.users.map((user) => (
            <label key={user.id} className="checkbox-row">
              <input type="checkbox" checked={draft.userIds.includes(user.id)} onChange={(event) => toggleUser(user.id, event.target.checked)} />
              {user.nickname}（{user.accountType === "robot" ? "机器人" : "人类"}{user.enabled ? "" : "，已停用"}）
            </label>
          ))}
          <p>机器人即使被分配角色，仍受服务端机器人硬拒绝规则约束。</p>
        </fieldset>
        <button type="submit" disabled={mutation.isPending}>{draft.id === null ? "创建角色" : "保存角色"}</button>
        {mutation.isError ? <p role="alert">{mutation.error.message}</p> : null}
        {mutation.isSuccess ? <p role="status">角色设置已保存。</p> : null}
      </form>
    </div>
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

function FermataSection() {
  const health = useQuery({ queryKey: ["admin-fermata-health"], queryFn: getFermataHealth });
  const settings = useQuery({ queryKey: ["admin-fermata-settings"], queryFn: getFermataSettings });
  if (health.isPending || settings.isPending) return <LoadingState />;
  if (health.isError) return <ErrorState message={health.error.message} />;
  if (settings.isError) return <ErrorState message={settings.error.message} />;
  return (
    <div className="admin-two-column">
      <div className="plain-panel"><h2>服务状态</h2><p>{health.data.health.status}，工作进程{health.data.health.workerRunning ? "运行中" : "未运行"}，活动任务 {health.data.health.activeTasks}</p></div>
      <div className="plain-panel"><h2>公开设置</h2><dl><dt>启用</dt><dd>{settings.data.settings.enabled ? "是" : "否"}</dd><dt>轮询间隔</dt><dd>{settings.data.settings.pollingIntervalSeconds} 秒</dd><dt>模型配置</dt><dd>{settings.data.settings.modelProfileName}</dd><dt>实验版本</dt><dd>{settings.data.settings.experimentVersion}</dd></dl></div>
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

function PluginsSection() {
  const query = useQuery({ queryKey: ["admin-plugins"], queryFn: listAdminPlugins });
  if (query.isPending) return <LoadingState />;
  if (query.isError) return <ErrorState message={query.error.message} />;
  return <div className="plain-panel"><h2>内置插件</h2><ul>{query.data.items.map((plugin) => <li key={plugin.id}><strong>{plugin.name}</strong> {plugin.version}：{plugin.state === "enabled" ? "已启用" : plugin.failureCode ?? "未启用"}</li>)}</ul><p>本页面只管理已内置插件配置；不提供 ZIP/GitHub 安装或动态执行入口。</p></div>;
}

function KnowledgeSection() {
  const query = useQuery({ queryKey: ["admin-tag-catalog"], queryFn: listManagedTagCatalog });
  if (query.isPending) return <LoadingState />;
  if (query.isError) return <ErrorState message={query.error.message} />;
  return <div className="plain-panel"><h2>知识点目录</h2><ul>{query.data.items.map((tag) => <li key={tag.id}>{tag.name}（{tag.itemKind === "tag" ? tag.group : tag.description}）</li>)}</ul></div>;
}

function ImportHistorySection() {
  const query = useQuery({ queryKey: ["import-history"], queryFn: () => listImportHistory() });
  if (query.isPending) return <LoadingState />;
  if (query.isError) return <ErrorState message={query.error.message} />;
  return <div className="plain-panel"><h2>导入历史</h2><ul>{query.data.items.map((item) => <li key={item.id}>{item.state}，完成 {item.completedItems} 项，失败 {item.failedItems} 项，导入题目 {item.importedProblemIds.length} 项</li>)}</ul>{query.data.items.length === 0 ? <p>当前账号没有可显示的导入记录。</p> : null}</div>;
}

export function AdminSectionPage({ section, session: _session }: { section: AdminSection; session: SessionUser }) {
  const content = useMemo(() => {
    switch (section) {
      case "settings": return <SettingsSection />;
      case "roles": return <RolesSection />;
      case "service-accounts": return <ServiceAccountsSection />;
      case "audit": return <AuditSection />;
      case "fermata": return <FermataSection />;
      case "oauth": return <OAuthSection />;
      case "plugins": return <PluginsSection />;
      case "knowledge": return <KnowledgeSection />;
      case "imports": return <ImportHistorySection />;
    }
  }, [section]);
  return <SectionFrame section={section}>{content}</SectionFrame>;
}
