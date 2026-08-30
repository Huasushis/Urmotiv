import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  corePermissions,
  robotHardDeniedPermissions,
  type CorePermission,
  type CreateServiceAccountTokenInput,
  type ServiceAccountToken,
  type SessionUser
} from "@urmotiv/contracts";
import {
  createAdminServiceAccount,
  createServiceAccountToken,
  getAdminGeneralSettings,
  getAdminUstcOAuthSettings,
  listAdminAudit,
  listAdminServiceAccounts,
  listServiceAccountTokens,
  listImportHistory,
  revokeServiceAccountToken,
  rotateServiceAccountToken,
  updateAdminServiceAccount,
  updateAdminGeneralSettings,
  updateAdminUstcOAuthSettings
} from "../lib/api";
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

function SettingsToggle({
  label,
  description,
  checked,
  disabled = false,
  onChange
}: {
  label: string;
  description?: string;
  checked: boolean;
  disabled?: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <label className="settings-toggle-row">
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(event) => onChange(event.currentTarget.checked)}
      />
      <span>
        <strong>{label}</strong>
        {description ? <small>{description}</small> : null}
      </span>
    </label>
  );
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
        <div className="settings-section-controls">
          <label>公开站点 URL<input value={draft.publicSiteUrl} onChange={(event) => update("publicSiteUrl", event.target.value)} placeholder="https://urmotiv.example" required /></label>
        </div>
      </section>
      <section className="settings-form-section">
        <div><h2>账号注册与登录</h2><p>root 登录不受这里的邮箱登录开关影响。</p></div>
        <div className="settings-section-controls settings-toggle-list">
          <SettingsToggle
            label="允许用户名或邮箱登录"
            description="关闭后，root 仍可使用用户名登录进行恢复。"
            checked={draft.emailLoginEnabled}
            onChange={(checked) => update("emailLoginEnabled", checked)}
          />
          <SettingsToggle
            label="允许访客通过邮箱注册账号"
            description="需要先完整配置下方 SMTP 发信服务。"
            checked={draft.publicRegistrationEnabled}
            onChange={(checked) => update("publicRegistrationEnabled", checked)}
          />
        </div>
      </section>
      <section className="settings-form-section">
        <div>
          <h2>SMTP 发信</h2>
          <p>SMTP 是向邮箱发送验证码的标准服务。当前状态：{query.data.settings.smtpConfigured ? "已可用" : "未完整配置"}。</p>
        </div>
        <div className="settings-section-controls">
          <div className="settings-field-grid">
            <label>SMTP 主机<input value={draft.smtpHost} onChange={(event) => update("smtpHost", event.target.value)} placeholder="smtp.example.com" /></label>
            <label>端口<input type="number" min={1} max={65535} value={draft.smtpPort} onChange={(event) => update("smtpPort", Number(event.target.value))} /></label>
            <label>用户名<input value={draft.smtpUsername} onChange={(event) => update("smtpUsername", event.target.value)} autoComplete="off" /></label>
            <label>密码{query.data.settings.smtpPasswordConfigured ? "（已保存；留空不修改）" : ""}<input type="password" value={draft.smtpPassword} onChange={(event) => update("smtpPassword", event.target.value)} autoComplete="new-password" /></label>
            <label>发件邮箱<input type="email" value={draft.smtpFromEmail} onChange={(event) => update("smtpFromEmail", event.target.value)} placeholder="noreply@example.com" /></label>
            <label>发件人名称<input value={draft.smtpFromName} onChange={(event) => update("smtpFromName", event.target.value)} /></label>
          </div>
          <div className="settings-toggle-list">
            <SettingsToggle
              label="连接后立即使用 TLS"
              description="通常用于 465 端口；587 会自动升级为加密连接。"
              checked={draft.smtpSecure}
              onChange={(checked) => update("smtpSecure", checked)}
            />
            {query.data.settings.smtpPasswordConfigured ? (
              <SettingsToggle
                label="清除已保存的 SMTP 密码"
                description="保存后立即清除；不勾选则留空密码输入框不会修改现有值。"
                checked={draft.clearSmtpPassword}
                onChange={(checked) => update("clearSmtpPassword", checked)}
              />
            ) : null}
          </div>
        </div>
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


const robotHardDeniedPermissionSet = new Set<CorePermission>(robotHardDeniedPermissions);
const defaultRobotTokenPermissions: CorePermission[] = [
  "auth.login",
  "problem.view.all",
  "problem.review",
  "problem.testdata.read"
];
const permissionLabels: Partial<Record<CorePermission, string>> = {
  "auth.login": "登录并认证机器人请求",
  "user.create": "创建普通账号",
  "problem.create": "创建题目",
  "problem.view.own": "查看自己创建的题目",
  "problem.edit.own": "编辑自己创建的题目",
  "problem.view.all": "查看全部题目",
  "problem.edit.all": "编辑全部题目",
  "problem.review": "领取任务并提交审题意见",
  "problem.status.change": "更改题目状态",
  "problem.frozen.edit": "修改冻结题面与题解",
  "problem.access.grant": "设置题目访问者",
  "problem.viewers.read": "查看题目访问者",
  "problem.import": "导入题目",
  "problem.export.own": "导出自己创建的题目",
  "problem.export.all": "导出全部题目",
  "problem.testdata.read": "读取测试数据和内部附件",
  "problem.testdata.write": "写入测试数据和内部附件",
  "contest.create": "创建比赛",
  "contest.edit.own": "编辑自己创建的比赛",
  "contest.edit.all": "编辑全部比赛",
  "contest.export": "导出比赛",
  "contest.risk.read": "查看泄题风险"
};
const robotTokenPermissionOptions = corePermissions.filter(
  (permission) => !robotHardDeniedPermissionSet.has(permission)
);

type TokenDraft = {
  name: string;
  permissions: CorePermission[];
  sourceCidrs: string;
  expiresAt: string;
};

function initialTokenDraft(): TokenDraft {
  return {
    name: "审题机器人令牌",
    permissions: [...defaultRobotTokenPermissions],
    sourceCidrs: "",
    expiresAt: ""
  };
}

function tokenInputFromDraft(draft: TokenDraft): CreateServiceAccountTokenInput {
  return {
    name: draft.name.trim(),
    permissions: draft.permissions,
    sourceCidrs: draft.sourceCidrs
      .split(/[\n,]+/u)
      .map((item) => item.trim())
      .filter((item) => item.length > 0),
    expiresAt: draft.expiresAt.length === 0 ? null : new Date(draft.expiresAt).toISOString()
  };
}

function tokenInputFromExisting(token: ServiceAccountToken): CreateServiceAccountTokenInput {
  return {
    name: token.name,
    permissions: token.permissions,
    sourceCidrs: token.sourceCidrs,
    expiresAt: token.expiresAt
  };
}

function formatDateTime(value: string | null): string {
  if (value === null) return "无";
  return new Intl.DateTimeFormat("zh-CN", {
    dateStyle: "medium",
    timeStyle: "short"
  }).format(new Date(value));
}

function tokenStatus(token: ServiceAccountToken): string {
  if (token.revokedAt !== null) return "已撤销";
  if (token.expiresAt !== null && Date.parse(token.expiresAt) <= Date.now()) return "已过期";
  return "可用";
}

function ServiceAccountsSection() {
  const client = useQueryClient();
  const accounts = useQuery({ queryKey: ["admin-service-accounts"], queryFn: listAdminServiceAccounts });
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [draft, setDraft] = useState<TokenDraft>(initialTokenDraft);
  const [newAccountName, setNewAccountName] = useState("");
  const [revealedToken, setRevealedToken] = useState<string | null>(null);
  const [copyState, setCopyState] = useState<"idle" | "copied" | "failed">("idle");
  useEffect(() => {
    if (accounts.data === undefined) return;
    if (accounts.data.items.some((item) => item.id === selectedId)) return;
    setSelectedId(accounts.data.items.find((item) => item.enabled)?.id ?? accounts.data.items[0]?.id ?? null);
  }, [accounts.data, selectedId]);
  const requireSelectedId = (): string => {
    if (selectedId === null) throw new Error("请先选择机器人账号。");
    return selectedId;
  };
  const tokens = useQuery({
    queryKey: ["admin-service-account-tokens", selectedId],
    queryFn: () => listServiceAccountTokens(requireSelectedId()),
    enabled: selectedId !== null,
    retry: false
  });
  const refresh = async () => {
    await Promise.all([
      client.invalidateQueries({ queryKey: ["admin-service-accounts"] }),
      client.invalidateQueries({ queryKey: ["admin-service-account-tokens", selectedId] })
    ]);
  };
  const accountCreated = useMutation({
    mutationFn: () => createAdminServiceAccount({ nickname: newAccountName }),
    onSuccess: async (result) => {
      setNewAccountName("");
      setSelectedId(result.item.id);
      await client.invalidateQueries({ queryKey: ["admin-service-accounts"] });
    }
  });
  const accountUpdated = useMutation({
    mutationFn: ({ userId, enabled }: { userId: string; enabled: boolean }) =>
      updateAdminServiceAccount(userId, { enabled }),
    onSuccess: async (result) => {
      setRevealedToken(null);
      await Promise.all([
        client.invalidateQueries({ queryKey: ["admin-service-accounts"] }),
        client.invalidateQueries({ queryKey: ["admin-service-account-tokens", result.item.id] })
      ]);
    }
  });
  const created = useMutation({
    mutationFn: () => createServiceAccountToken(requireSelectedId(), tokenInputFromDraft(draft)),
    onSuccess: async (result) => {
      setRevealedToken(result.token);
      setCopyState("idle");
      setDraft(initialTokenDraft());
      await refresh();
    }
  });
  const rotated = useMutation({
    mutationFn: (token: ServiceAccountToken) =>
      rotateServiceAccountToken(requireSelectedId(), token.id, tokenInputFromExisting(token)),
    onSuccess: async (result) => {
      setRevealedToken(result.token);
      setCopyState("idle");
      await refresh();
    }
  });
  const revoked = useMutation({
    mutationFn: (tokenId: string) => revokeServiceAccountToken(requireSelectedId(), tokenId),
    onSuccess: refresh
  });
  const selectAccount = (id: string) => {
    setSelectedId(id);
    setRevealedToken(null);
    setCopyState("idle");
    created.reset();
    rotated.reset();
    revoked.reset();
  };
  if (accounts.isPending) return <LoadingState />;
  if (accounts.isError) return <ErrorState message={accounts.error.message} />;
  const selected = accounts.data.items.find((item) => item.id === selectedId);
  return (
    <div className="service-account-layout">
      <section className="plain-panel service-account-list-panel">
        <div className="admin-section-heading">
          <div>
            <h2>机器人账号</h2>
            <p>选择账号后管理它的 API 令牌。</p>
          </div>
        </div>
        <form
          className="service-account-create"
          onSubmit={(event) => {
            event.preventDefault();
            accountCreated.mutate();
          }}
        >
          <label htmlFor="new-service-account-name">新机器人名称</label>
          <div>
            <input
              id="new-service-account-name"
              required
              maxLength={120}
              value={newAccountName}
              onChange={(event) => setNewAccountName(event.currentTarget.value)}
              placeholder="例如：Fermata 审题机器人"
            />
            <button type="submit" className="primary-button" disabled={accountCreated.isPending}>
              {accountCreated.isPending ? "创建中…" : "创建"}
            </button>
          </div>
          {accountCreated.isError ? <p className="inline-error" role="alert">{accountCreated.error.message}</p> : null}
        </form>
        <div className="service-account-list" role="list">
          {accounts.data.items.map((item) => (
            <button
              type="button"
              key={item.id}
              className={item.id === selectedId ? "active" : ""}
              onClick={() => selectAccount(item.id)}
            >
              <span><strong>{item.nickname}</strong><small>{item.enabled ? "账号已启用" : "账号已停用"}</small></span>
              <span className={`status-pill ${item.tokenConfigured ? "success" : "neutral"}`}>
                {item.tokenConfigured ? "有令牌" : "无令牌"}
              </span>
            </button>
          ))}
        </div>
        {accounts.data.items.length === 0 ? <p className="admin-empty">还没有机器人账号，请先在上方创建。</p> : null}
        <p className="field-help">账号角色和权限在“用户管理”与“角色与权限”中调整；令牌只能收窄权限，不能扩大权限。</p>
      </section>

      <section className="plain-panel service-account-detail-panel">
        {selected === undefined ? (
          <div className="admin-empty"><h2>没有可管理的机器人账号</h2><p>请先在账号权限体系中准备机器人账号。</p></div>
        ) : (
          <>
            <div className="admin-section-heading">
              <div>
                <h2>{selected.nickname}</h2>
                <p>{selected.enabled ? "可创建、轮换和撤销令牌。" : "账号已停用，现有令牌无法认证。"}</p>
              </div>
              <div className="service-account-status-actions">
                <span className={`status-pill ${selected.enabled ? "success" : "danger"}`}>{selected.enabled ? "启用" : "停用"}</span>
                <button
                  type="button"
                  className={selected.enabled ? "danger-button" : "secondary-button"}
                  disabled={accountUpdated.isPending}
                  onClick={() => {
                    if (
                      !selected.enabled ||
                      window.confirm(`确认停用机器人“${selected.nickname}”？它的现有令牌会同时撤销。`)
                    ) {
                      accountUpdated.mutate({ userId: selected.id, enabled: !selected.enabled });
                    }
                  }}
                >
                  {selected.enabled ? "停用账号" : "重新启用"}
                </button>
              </div>
            </div>
            {accountUpdated.isError ? <p className="inline-error" role="alert">{accountUpdated.error.message}</p> : null}

            {revealedToken !== null ? (
              <div className="token-secret-panel" role="status">
                <strong>新令牌只显示这一次</strong>
                <p>立即复制到机器人的私有配置；离开或关闭后只能轮换，无法恢复。</p>
                <div>
                  <input aria-label="新机器人令牌" readOnly value={revealedToken} onFocus={(event) => event.currentTarget.select()} />
                  <button
                    type="button"
                    className="secondary-button"
                    onClick={async () => {
                      try {
                        await navigator.clipboard.writeText(revealedToken);
                        setCopyState("copied");
                      } catch {
                        setCopyState("failed");
                      }
                    }}
                  >复制</button>
                  <button type="button" className="secondary-button" onClick={() => setRevealedToken(null)}>我已保存</button>
                </div>
                {copyState === "copied" ? <small>已复制。</small> : null}
                {copyState === "failed" ? <small>浏览器未允许复制，请手动选中复制。</small> : null}
              </div>
            ) : null}

            <details className="service-token-create" open={tokens.data?.items.length === 0}>
              <summary>生成新令牌</summary>
              <form
                onSubmit={(event) => {
                  event.preventDefault();
                  created.mutate();
                }}
              >
                <label>用途名称<input required maxLength={120} value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.currentTarget.value })} /></label>
                <label>允许来源地址（可选）<textarea rows={3} value={draft.sourceCidrs} onChange={(event) => setDraft({ ...draft, sourceCidrs: event.currentTarget.value })} placeholder="每行一个 IP 或 CIDR；留空表示不限制" /><small>例如 192.0.2.10 或 192.0.2.0/24。服务端仍会按可信代理配置判断真实来源。</small></label>
                <label>到期时间（可选）<input type="datetime-local" value={draft.expiresAt} onChange={(event) => setDraft({ ...draft, expiresAt: event.currentTarget.value })} /></label>
                <fieldset className="service-account-permissions">
                  <legend>令牌权限</legend>
                  <p>必须保留“登录并认证机器人请求”。通常审题机器人只需要默认选中的四项。</p>
                  <div>
                    {robotTokenPermissionOptions.map((permission) => (
                      <label key={permission} className="checkbox-row">
                        <input
                          type="checkbox"
                          checked={draft.permissions.includes(permission)}
                          disabled={permission === "auth.login"}
                          onChange={(event) => setDraft({
                            ...draft,
                            permissions: event.currentTarget.checked
                              ? [...draft.permissions, permission]
                              : draft.permissions.filter((item) => item !== permission)
                          })}
                        />
                        <span>{permissionLabels[permission] ?? permission}<small>{permission}</small></span>
                      </label>
                    ))}
                  </div>
                </fieldset>
                <button type="submit" className="primary-button" disabled={!selected.enabled || created.isPending}>{created.isPending ? "正在生成…" : "生成令牌"}</button>
                {created.isError ? <p className="inline-error" role="alert">{created.error.message}</p> : null}
              </form>
            </details>

            <div className="service-token-list-heading"><h3>已有令牌</h3><span>{tokens.data?.items.length ?? 0} 个</span></div>
            {tokens.isPending ? <p role="status">正在读取令牌……</p> : null}
            {tokens.isError ? <p className="inline-error" role="alert">{tokens.error.message}</p> : null}
            <div className="service-token-list">
              {tokens.data?.items.map((token) => {
                const active = tokenStatus(token) === "可用";
                return (
                  <article key={token.id}>
                    <div>
                      <strong>{token.name}</strong>
                      <span className={`status-pill ${active ? "success" : "neutral"}`}>{tokenStatus(token)}</span>
                    </div>
                    <dl>
                      <div><dt>前缀</dt><dd><code>{token.displayPrefix}</code></dd></div>
                      <div><dt>创建时间</dt><dd>{formatDateTime(token.createdAt)}</dd></div>
                      <div><dt>到期时间</dt><dd>{formatDateTime(token.expiresAt)}</dd></div>
                      <div><dt>最近使用</dt><dd>{formatDateTime(token.lastUsedAt)}</dd></div>
                    </dl>
                    <p>{token.permissions.map((permission) => permissionLabels[permission] ?? permission).join("、")}</p>
                    {token.sourceCidrs.length > 0 ? <p>来源限制：{token.sourceCidrs.join("、")}</p> : <p>来源限制：无</p>}
                    {active ? (
                      <div className="service-token-actions">
                        <button type="button" className="secondary-button" disabled={rotated.isPending} onClick={() => rotated.mutate(token)}>轮换</button>
                        <button
                          type="button"
                          className="danger-button"
                          disabled={revoked.isPending}
                          onClick={() => {
                            if (window.confirm(`确认撤销令牌“${token.name}”？使用它的机器人会立即无法认证。`)) revoked.mutate(token.id);
                          }}
                        >撤销</button>
                      </div>
                    ) : null}
                  </article>
                );
              })}
            </div>
            {rotated.isError ? <p className="inline-error" role="alert">{rotated.error.message}</p> : null}
            {revoked.isError ? <p className="inline-error" role="alert">{revoked.error.message}</p> : null}
          </>
        )}
      </section>
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
      <section className="settings-form-section">
        <div><h2>登录状态</h2><p>决定登录页是否显示统一身份认证入口，以及首次登录能否自动建立本地账号。</p></div>
        <div className="settings-section-controls settings-toggle-list">
          <SettingsToggle
            label="启用 USTC OAuth"
            description="开启前请确认下方端点、客户端编号和密钥均已填写。"
            checked={draft.enabled}
            onChange={(checked) => update("enabled", checked)}
          />
          <SettingsToggle
            label="首次统一身份登录时自动创建账号"
            description="关闭后，只允许已经绑定过统一身份的账号登录。"
            checked={draft.autoCreateUsers}
            onChange={(checked) => update("autoCreateUsers", checked)}
          />
        </div>
      </section>
      <section className="settings-form-section">
        <div><h2>OAuth 端点</h2><p>分别填写学校提供的授权、换取令牌和读取个人资料地址。</p></div>
        <div className="settings-section-controls settings-field-stack">
          <label>授权 URL<input value={draft.authorizeUrl} onChange={(event) => update("authorizeUrl", event.target.value)} required={draft.enabled} /></label>
          <label>令牌 URL<input value={draft.tokenUrl} onChange={(event) => update("tokenUrl", event.target.value)} required={draft.enabled} /></label>
          <label>个人资料 URL<input value={draft.profileUrl} onChange={(event) => update("profileUrl", event.target.value)} required={draft.enabled} /></label>
          <label>回调 URL（固定路径）<input value={draft.redirectUri} onChange={(event) => update("redirectUri", event.target.value)} required={draft.enabled} /></label>
          <label>作用域<input value={draft.scope} onChange={(event) => update("scope", event.target.value)} placeholder="openid profile" /></label>
        </div>
      </section>
      <section className="settings-form-section">
        <div><h2>客户端凭据</h2><p>编号和密钥只写入服务端；读取接口只返回是否已经配置。</p></div>
        <div className="settings-section-controls">
          <div className="settings-field-grid">
            <label>客户端编号{query.data.settings.clientIdConfigured ? "（已配置；重新输入才会替换）" : ""}<input value={draft.clientId} onChange={(event) => update("clientId", event.target.value)} required={draft.enabled && !query.data.settings.clientIdConfigured} autoComplete="off" /></label>
            <label>客户端密钥{query.data.settings.clientSecretConfigured ? "（已配置；重新输入才会替换）" : ""}<input type="password" value={draft.clientSecret} onChange={(event) => update("clientSecret", event.target.value)} autoComplete="new-password" required={draft.enabled && !query.data.settings.clientSecretConfigured && !draft.clearClientSecret} /></label>
          </div>
          <div className="settings-toggle-list">
            <SettingsToggle label="清除已保存的客户端编号" checked={draft.clearClientId} onChange={(checked) => update("clearClientId", checked)} />
            <SettingsToggle label="清除已保存的客户端密钥" checked={draft.clearClientSecret} onChange={(checked) => update("clearClientSecret", checked)} />
          </div>
        </div>
      </section>
      <button type="submit" className="primary-button" disabled={mutation.isPending}>{mutation.isPending ? "正在保存…" : "保存 OAuth 设置"}</button>
      {mutation.isError ? <p className="inline-error" role="alert">{mutation.error.message}</p> : null}
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
