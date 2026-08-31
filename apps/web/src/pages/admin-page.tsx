import {
  AlertTriangle,
  BookOpenCheck,
  CheckCircle2,
  KeyRound,
  Loader2,
  RefreshCw,
  Save,
  ShieldAlert
} from "lucide-react";
import { Link } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import type {
  AdminPlugin,
  AdminPluginListResponse,
  ReviewPolicyView,
  SessionUser,
  UpdatePluginRequest
} from "@urmotiv/contracts";
import { applySettingsFormDefaults, SettingsForm } from "../components/settings-form";
import { TagCatalogAdmin } from "../components/tag-catalog-admin";
import { AdminLayout, adminNavigationGroups, canOpenAdmin } from "../components/admin-layout";
import {
  ApiError,
  applyAdminAnklangConfiguration,
  getReviewPolicy,
  listAdminPlugins,
  testAdminAnklangConfiguration,
  updateAdminPlugin,
  updateReviewPolicy
} from "../lib/api";
import { isAccessBoundaryError } from "../lib/client-security";

export type AdminPageSection = "dashboard" | "review" | "plugins" | "knowledge";

const pluginStateText: Record<AdminPlugin["state"], string> = {
  enabled: "已启用",
  disabled: "已停用",
  failed: "启动失败"
};

const pluginStateTone: Record<AdminPlugin["state"], string> = {
  enabled: "success",
  disabled: "neutral",
  failed: "danger"
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function settingsWithDefaults(
  schema: ReviewPolicyView["availableRules"][number]["settingsSchema"]
): ReviewPolicyView["settings"] {
  if (schema === null) {
    return {};
  }
  const value = applySettingsFormDefaults(schema, {});
  return isRecord(value) ? value : {};
}

function sameSettings(left: Record<string, unknown>, right: Record<string, unknown>): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "保存失败，请稍后重试。";
}

export function AdminPage({
  session,
  section = "dashboard"
}: {
  session: SessionUser;
  section?: AdminPageSection;
}) {
  const client = useQueryClient();
  const canReview = session.accountType === "human" && session.canManageReviewPolicy;
  const canManagePlugins = session.accountType === "human" && session.canManagePlugins;
  const canManageTags = session.accountType === "human" && session.canManageTags;
  const navigationItems = adminNavigationGroups(session)
    .flatMap((group) => group.items)
    .filter((item) => item.to !== "/admin");
  const resolvedSection: AdminPageSection = section === "dashboard" && navigationItems.length === 1
    ? navigationItems[0]?.to === "/admin/review"
      ? "review"
      : navigationItems[0]?.to === "/admin/plugins"
        ? "plugins"
        : navigationItems[0]?.to === "/admin/knowledge"
          ? "knowledge"
          : "dashboard"
    : section;
  useEffect(() => {
    if (!canReview) {
      client.removeQueries({ queryKey: ["review-policy"] });
    }
    if (!canManagePlugins) {
      client.removeQueries({ queryKey: ["admin-plugins"] });
    }
    if (!canManageTags) {
      client.removeQueries({ queryKey: ["admin-tag-catalog"] });
    }
  }, [canManagePlugins, canManageTags, canReview, client, session.id]);

  if (!canOpenAdmin(session)) {
    return (
      <section className="admin-page admin-no-access">
        <div className="page-heading">
          <div>
            <p className="eyebrow">管理</p>
            <h1>站点管理</h1>
            <p>当前账号没有可用的管理设置。权限由服务端核对，无法从此页面查看设置内容。</p>
          </div>
          <ShieldAlert className="page-heading-icon" size={32} aria-hidden="true" />
        </div>
        <div className="plain-panel" role="status">
          <h2>无法打开管理设置</h2>
          <p>如需调整审核规则、插件或知识点目录，请联系负责账号权限的管理员。</p>
        </div>
      </section>
    );
  }

  if (resolvedSection === "review") {
    return (
      <AdminLayout session={session} title="审核规则" description="设置审核意见如何汇总；每次保存都会由服务端重新核对权限。">
        {canReview ? <ReviewPolicySection key={session.id} currentUserId={session.id} /> : <AdminNotFound />}
      </AdminLayout>
    );
  }

  if (resolvedSection === "plugins") {
    return (
      <AdminLayout session={session} title="插件" description="管理已安装插件及各插件相互隔离的设置和密钥。">
        {canManagePlugins ? <PluginSection key={session.id} currentUserId={session.id} /> : <AdminNotFound />}
      </AdminLayout>
    );
  }

  if (resolvedSection === "knowledge") {
    return (
      <AdminLayout session={session} title="知识点目录" description="维护分组、知识点和它们的层级关系。">
        {canManageTags ? <TagCatalogAdmin key={session.id} currentUserId={session.id} /> : <AdminNotFound />}
      </AdminLayout>
    );
  }

  const groups = adminNavigationGroups(session)
    .map((group) => ({ ...group, items: group.items.filter((item) => item.to !== "/admin") }))
    .filter((group) => group.items.length > 0);
  return (
    <AdminLayout session={session} title="控制面板" description="站点、题库、用户和插件设置均从右侧分组进入。">
      <div className="admin-dashboard-grid">
        {groups.map((group) => (
          <section key={group.label} className="plain-panel admin-dashboard-group">
            <h2>{group.label}</h2>
            <div>
              {group.items.map((item) => <Link key={item.to} to={item.to}>{item.label}<span aria-hidden="true">›</span></Link>)}
            </div>
          </section>
        ))}
      </div>
    </AdminLayout>
  );
}

function AdminNotFound() {
  return <div className="plain-panel" role="status">设置不存在或当前账号不能访问。</div>;
}

type ReviewDraft = {
  ruleId: string;
  pluginVersion: string;
  settings: ReviewPolicyView["settings"];
  revision: number;
};

function reviewDraftFrom(view: ReviewPolicyView): ReviewDraft {
  return {
    ruleId: view.selectedRuleId,
    pluginVersion: view.selectedPluginVersion,
    settings: { ...view.settings },
    revision: view.revision
  };
}

function ReviewPolicySection({ currentUserId }: { currentUserId: string }) {
  const client = useQueryClient();
  const [draft, setDraft] = useState<ReviewDraft | null>(null);
  const [conflict, setConflict] = useState(false);
  const [reloading, setReloading] = useState(false);
  const [accessDenied, setAccessDenied] = useState(false);
  const policy = useQuery({
    queryKey: ["review-policy", currentUserId],
    queryFn: getReviewPolicy,
    retry: false,
    enabled: !accessDenied
  });
  const queryAccessDenied = policy.isError && isAccessBoundaryError(policy.error);
  useEffect(() => {
    if (!queryAccessDenied) {
      return;
    }
    setAccessDenied(true);
    setDraft(null);
    setConflict(false);
    client.removeQueries({ queryKey: ["review-policy", currentUserId], exact: true });
  }, [client, currentUserId, queryAccessDenied]);
  useEffect(() => {
    setAccessDenied(false);
    setDraft(null);
    setConflict(false);
  }, [currentUserId]);

  useEffect(() => {
    if (policy.data !== undefined && draft === null) {
      setDraft(reviewDraftFrom(policy.data));
    }
  }, [draft, policy.data]);

  const save = useMutation({
    mutationFn: (value: ReviewDraft) =>
      updateReviewPolicy({
        ruleId: value.ruleId,
        settings: value.settings,
        expectedRevision: value.revision
      }),
    onSuccess: (result) => {
      client.setQueryData(["review-policy", currentUserId], result);
      setDraft(reviewDraftFrom(result));
      setConflict(false);
    },
    onError: (error) => {
      if (isAccessBoundaryError(error)) {
        setAccessDenied(true);
        setDraft(null);
        setConflict(false);
        client.removeQueries({ queryKey: ["review-policy", currentUserId], exact: true });
        return;
      }
      if (error instanceof ApiError && error.status === 409) {
        setConflict(true);
      }
    }
  });
  if (accessDenied || queryAccessDenied) {
    return (
      <div className="plain-panel admin-load-error" role="alert">
        <ShieldAlert size={20} aria-hidden="true" />
        <div>
          <h2>审核规则不存在</h2>
          <p>设置不存在或当前账号不能访问。</p>
        </div>
      </div>
    );
  }

  if (policy.isError && policy.data === undefined) {
    return (
      <div className="plain-panel admin-load-error" role="alert">
        <AlertTriangle size={20} aria-hidden="true" />
        <div>
          <h2>审核规则暂时无法读取</h2>
          <p>{errorMessage(policy.error)}</p>
          <button type="button" className="secondary-button" onClick={() => void policy.refetch()}>
            <RefreshCw size={15} aria-hidden="true" />
            重试
          </button>
        </div>
      </div>
    );
  }

  if (policy.isLoading || policy.data === undefined || draft === null) {
    return (
      <div className="admin-loading" role="status">
        <Loader2 className="spin" size={18} aria-hidden="true" />
        正在读取审核规则…
      </div>
    );
  }

  const selectedRule = policy.data.availableRules.find(
    (rule) => rule.id === draft.ruleId && rule.pluginVersion === draft.pluginVersion
  );
  const currentRuleIsAvailable = selectedRule !== undefined;
  const hasChanges =
    draft.ruleId !== policy.data.selectedRuleId ||
    draft.pluginVersion !== policy.data.selectedPluginVersion ||
    !sameSettings(draft.settings, policy.data.settings);

  const reload = async () => {
    setReloading(true);
    try {
      const result = await policy.refetch();
      if (result.isSuccess && result.data !== undefined) {
        setDraft(reviewDraftFrom(result.data));
        setConflict(false);
        save.reset();
      }
    } finally {
      setReloading(false);
    }
  };

  return (
    <div className="admin-single-layout">
      <section className="admin-editor" aria-labelledby="review-policy-title">
        <div className="admin-section-heading">
          <div>
            <p className="eyebrow">审核结果</p>
            <h2 id="review-policy-title">审核规则</h2>
            <p>选择如何把当前一轮的有效审核意见汇总为通过、不通过或继续等待。</p>
          </div>
          <BookOpenCheck size={22} aria-hidden="true" />
        </div>

        {!policy.data.selectedRuleAvailable ? (
          <div className="warning-note" role="status">
            <AlertTriangle size={17} aria-hidden="true" />
            当前保存的规则已经不可用。请选择一个可用规则并保存，题目才能继续自动汇总审核结果。
          </div>
        ) : null}

        {policy.data.availableRules.length === 0 ? (
          <div className="admin-empty">
            <h3>没有可用的审核规则</h3>
            <p>请先让系统管理员修复或启用提供审核规则的插件。</p>
          </div>
        ) : (
          <>
            <label className="field admin-rule-select">
              <span>使用的规则</span>
              <select
                value={currentRuleIsAvailable ? draft.ruleId : ""}
                disabled={save.isPending}
                onChange={(event) => {
                  const rule = policy.data.availableRules.find(
                    (candidate) => candidate.id === event.currentTarget.value
                  );
                  if (rule === undefined) {
                    return;
                  }
                  setDraft({
                    ruleId: rule.id,
                    pluginVersion: rule.pluginVersion,
                    settings:
                      rule.id === policy.data.selectedRuleId
                        ? { ...policy.data.settings }
                        : settingsWithDefaults(rule.settingsSchema),
                    revision: draft.revision
                  });
                  setConflict(false);
                  save.reset();
                }}
              >
                {!currentRuleIsAvailable ? <option value="">当前规则不可用</option> : null}
                {policy.data.availableRules.map((rule) => (
                  <option key={rule.id} value={rule.id}>
                    {rule.displayName}
                  </option>
                ))}
              </select>
              <small>更换规则时会显示新规则需要的设置，保存后才会生效。</small>
            </label>

            {selectedRule?.settingsSchema ? (
              <SettingsForm
                schema={selectedRule.settingsSchema}
                value={draft.settings}
                disabled={save.isPending}
                idPrefix="review-rule"
                onChange={(settings) => {
                  setDraft({ ...draft, settings });
                  setConflict(false);
                  save.reset();
                }}
              />
            ) : selectedRule ? (
              <p className="notice-line">这个规则没有需要调整的内容。</p>
            ) : null}
          </>
        )}

        {conflict ? (
          <div className="admin-conflict" role="alert">
            <AlertTriangle size={18} aria-hidden="true" />
            <div>
              <strong>其他人已经修改了审核规则</strong>
              <p>本页输入仍然保留。重新读取会放弃这些输入并显示最新设置。</p>
              <button
                type="button"
                className="secondary-button compact-button"
                disabled={reloading}
                onClick={() => void reload()}
              >
                <RefreshCw className={reloading ? "spin" : ""} size={14} aria-hidden="true" />
                放弃本页输入并重新读取
              </button>
            </div>
          </div>
        ) : null}
        {save.isError && !conflict ? (
          <p className="inline-error" role="alert">
            <AlertTriangle size={16} aria-hidden="true" />
            {errorMessage(save.error)}
          </p>
        ) : null}
        {save.isSuccess && !hasChanges ? (
          <p className="admin-save-success" role="status">
            <CheckCircle2 size={16} aria-hidden="true" />
            审核规则已保存。
          </p>
        ) : null}

        <div className="admin-actions">
          <span>{hasChanges ? "有尚未保存的修改" : "当前显示的是已保存设置"}</span>
          <button
            type="button"
            className="primary-button"
            disabled={!hasChanges || !currentRuleIsAvailable || save.isPending}
            onClick={() => save.mutate(draft)}
          >
            {save.isPending ? (
              <Loader2 className="spin" size={16} aria-hidden="true" />
            ) : (
              <Save size={16} aria-hidden="true" />
            )}
            保存审核规则
          </button>
        </div>
      </section>
    </div>
  );
}

function PluginSection({
  currentUserId,
  onOpenReviewPolicy
}: {
  currentUserId: string;
  onOpenReviewPolicy?: (() => void) | undefined;
}) {
  const client = useQueryClient();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [accessDenied, setAccessDenied] = useState(false);
  const plugins = useQuery({
    queryKey: ["admin-plugins", currentUserId],
    queryFn: listAdminPlugins,
    retry: false,
    enabled: !accessDenied
  });
  const queryAccessDenied = plugins.isError && isAccessBoundaryError(plugins.error);
  useEffect(() => {
    if (!queryAccessDenied) {
      return;
    }
    setAccessDenied(true);
    setSelectedId(null);
    client.removeQueries({ queryKey: ["admin-plugins", currentUserId], exact: true });
  }, [client, currentUserId, queryAccessDenied]);
  useEffect(() => {
    setAccessDenied(false);
    setSelectedId(null);
  }, [currentUserId]);

  useEffect(() => {
    const items = plugins.data?.items ?? [];
    if (items.length > 0 && !items.some((plugin) => plugin.id === selectedId)) {
      setSelectedId(items[0]?.id ?? null);
    }
  }, [plugins.data, selectedId]);
  if (accessDenied || queryAccessDenied) {
    return (
      <div className="plain-panel admin-load-error" role="alert">
        <ShieldAlert size={20} aria-hidden="true" />
        <div>
          <h2>插件设置不存在</h2>
          <p>设置不存在或当前账号不能访问。</p>
        </div>
      </div>
    );
  }

  if (plugins.isLoading) {
    return (
      <div className="admin-loading" role="status">
        <Loader2 className="spin" size={18} aria-hidden="true" />
        正在读取插件设置…
      </div>
    );
  }

  if (plugins.data === undefined) {
    return (
      <div className="plain-panel admin-load-error" role="alert">
        <AlertTriangle size={20} aria-hidden="true" />
        <div>
          <h2>插件设置暂时无法读取</h2>
          <p>{errorMessage(plugins.error)}</p>
          <button type="button" className="secondary-button" onClick={() => void plugins.refetch()}>
            <RefreshCw size={15} aria-hidden="true" />
            重试
          </button>
        </div>
      </div>
    );
  }

  if (plugins.data.items.length === 0) {
    return (
      <div className="plain-panel admin-empty">
        <h2>没有可用的内置插件</h2>
        <p>插件随受信任的 Urmotiv 发布版本提供；页面不支持安装、下载或动态加载插件。</p>
      </div>
    );
  }

  const selected = plugins.data.items.find((plugin) => plugin.id === selectedId);
  const replacePlugin = (next: AdminPlugin) => {
    client.setQueryData<AdminPluginListResponse>(
      ["admin-plugins", currentUserId],
      (current) => ({
        items: (current?.items ?? []).map((plugin) => (plugin.id === next.id ? next : plugin))
      })
    );
  };
  const reloadPlugin = async (pluginId: string): Promise<AdminPlugin | undefined> => {
    const result = await plugins.refetch();
    return result.isSuccess
      ? result.data?.items.find((plugin) => plugin.id === pluginId)
      : undefined;
  };

  return (
    <div className="admin-plugin-layout">
      <aside className="admin-plugin-list" aria-label="插件列表">
        <div className="admin-plugin-list-heading">
          <strong>已安装插件</strong>
          <span>{plugins.data.items.length}</span>
        </div>
        {plugins.data.items.map((plugin) => (
          <button
            type="button"
            key={plugin.id}
            className={plugin.id === selectedId ? "selected" : ""}
            aria-current={plugin.id === selectedId ? "true" : undefined}
            onClick={() => setSelectedId(plugin.id)}
          >
            <span>
              <strong>{plugin.name}</strong>
              <small>版本 {plugin.version}</small>
            </span>
            <span className={`status-badge ${pluginStateTone[plugin.state]}`}>
              {pluginStateText[plugin.state]}
            </span>
          </button>
        ))}
      </aside>
      {selected ? (
        <PluginEditor
          key={selected.id}
          plugin={selected}
          onSaved={replacePlugin}
          onReload={reloadPlugin}
          onAccessDenied={() => {
            setAccessDenied(true);
            setSelectedId(null);
            client.removeQueries({ queryKey: ["admin-plugins", currentUserId], exact: true });
          }}
          onOpenReviewPolicy={onOpenReviewPolicy}
        />
      ) : null}
    </div>
  );
}

function PluginEditor({
  plugin,
  onSaved,
  onReload,
  onAccessDenied,
  onOpenReviewPolicy,
}: {
  plugin: AdminPlugin;
  onSaved: (plugin: AdminPlugin) => void;
  onReload: (pluginId: string) => Promise<AdminPlugin | undefined>;
  onAccessDenied: () => void;
  onOpenReviewPolicy?: (() => void) | undefined;
}) {
  const [saved, setSaved] = useState(plugin);
  const [enabled, setEnabled] = useState(plugin.state === "enabled");
  const [stateTouched, setStateTouched] = useState(false);
  const [settings, setSettings] = useState<AdminPlugin["settings"]>({ ...plugin.settings });
  const [secretValues, setSecretValues] = useState<Record<string, string>>({});
  const [clearSecrets, setClearSecrets] = useState<string[]>([]);
  const [conflict, setConflict] = useState(false);
  const [reloading, setReloading] = useState(false);

  const resetFrom = (next: AdminPlugin) => {
    setSaved(next);
    setEnabled(next.state === "enabled");
    setStateTouched(false);
    setSettings({ ...next.settings });
    setSecretValues({});
    setClearSecrets([]);
    setConflict(false);
  };

  const applyMutation = useMutation({
    mutationFn: applyAdminAnklangConfiguration,
    onError: (error) => {
      if (isAccessBoundaryError(error)) {
        onAccessDenied();
      }
    }
  });

  const mutation = useMutation({
    mutationFn: (input: UpdatePluginRequest) => updateAdminPlugin(saved.id, input),
    onSuccess: (result) => {
      onSaved(result);
      resetFrom(result);
      if (result.id === "org.ustc.urmotiv.anklang" && result.state === "enabled") {
        applyMutation.mutate();
      }
    },
    onError: (error) => {
      if (isAccessBoundaryError(error)) {
        setSecretValues({});
        setClearSecrets([]);
        onAccessDenied();
        return;
      }
      if (error instanceof ApiError && error.status === 409) {
        setConflict(true);
      }
    }
  });
  const stateChanged =
    stateTouched && (saved.state === "failed" || enabled !== (saved.state === "enabled"));
  const settingsChanged =
    saved.settingsManagedBy === "plugin" && !sameSettings(settings, saved.settings);
  const enteredSecrets = Object.fromEntries(
    Object.entries(secretValues).filter(([, value]) => value.length > 0)
  );
  const testMutation = useMutation({
    mutationFn: () => testAdminAnklangConfiguration({
      settings,
      secrets: enteredSecrets,
      clearSecrets
    }),
    onError: (error) => {
      if (isAccessBoundaryError(error)) {
        setSecretValues({});
        setClearSecrets([]);
        onAccessDenied();
      }
    }
  });
  const hasChanges =
    stateChanged ||
    settingsChanged ||
    Object.keys(enteredSecrets).length > 0 ||
    clearSecrets.length > 0;

  const savePlugin = () => {
    const input: UpdatePluginRequest = {
      expectedRevision: saved.settingsRevision,
      ...(stateChanged ? { state: enabled ? "enabled" : "disabled" } : {}),
      ...(settingsChanged ? { settings } : {}),
      ...(Object.keys(enteredSecrets).length > 0 ? { secrets: enteredSecrets } : {}),
      ...(clearSecrets.length > 0 ? { clearSecrets } : {})
    };
    mutation.mutate(input);
  };

  const reload = async () => {
    setReloading(true);
    try {
      const next = await onReload(saved.id);
      if (next !== undefined) {
        resetFrom(next);
        mutation.reset();
      }
    } finally {
      setReloading(false);
    }
  };

  return (
    <section className="admin-plugin-editor" aria-labelledby="plugin-editor-title">
      <div className="admin-section-heading plugin-editor-heading">
        <div>
          <p className="eyebrow">插件设置</p>
          <h2 id="plugin-editor-title">{saved.name}</h2>
          <p>版本 {saved.version}</p>
        </div>
        <span className={`status-badge ${pluginStateTone[saved.state]}`}>
          {pluginStateText[saved.state]}
        </span>
      </div>

      {saved.state === "failed" ? (
        <div className="warning-note" role="status">
          <AlertTriangle size={17} aria-hidden="true" />
          插件上次启动失败。可先检查设置，再选择启用并保存；如果仍然失败，需要查看服务端的安全日志。
        </div>
      ) : null}

      <div className="admin-plugin-state">
        <label className="settings-form-toggle">
          <input
            type="checkbox"
            checked={enabled}
            disabled={mutation.isPending}
            onChange={(event) => {
              setEnabled(event.currentTarget.checked);
              setStateTouched(true);
              setConflict(false);
              mutation.reset();
              testMutation.reset();
              applyMutation.reset();
            }}
          />
          <span>启用这个插件</span>
        </label>
        <small>停用后，插件提供的检查或外部服务连接不会继续运行。</small>
      </div>

      {saved.settingsManagedBy === "review_policy" ? (
        <div className="admin-managed-elsewhere">
          <BookOpenCheck size={19} aria-hidden="true" />
          <div>
            <strong>这个插件的设置由审核规则管理</strong>
            <p>规则需要的人数和计数方式请在“审核规则”中修改，避免两处设置互相覆盖。</p>
            {onOpenReviewPolicy ? (
              <button type="button" className="secondary-button compact-button" onClick={onOpenReviewPolicy}>
                打开审核规则
              </button>
            ) : (
              <small>请联系有审核规则管理权限的成员修改。</small>
            )}
          </div>
        </div>
      ) : saved.settingsManagedBy === "plugin" && saved.settingsSchema ? (
        <SettingsForm
          schema={saved.settingsSchema}
          value={settings}
          disabled={mutation.isPending}
          idPrefix={`plugin-${saved.id}`}
          onChange={(value) => {
            setSettings(value);
            setConflict(false);
            mutation.reset();
            testMutation.reset();
            applyMutation.reset();
          }}
        />
      ) : (
        <p className="notice-line">这个插件没有需要调整的普通设置。</p>
      )}

      {saved.secrets.length > 0 ? (
        <fieldset className="admin-secret-group">
          <legend>
            <KeyRound size={17} aria-hidden="true" />
            访问凭据
          </legend>
          <p>这里保存的是连接外部服务所需的秘密内容。页面不会读取已保存的完整值，留空会保持原值。</p>
          <div className="admin-secret-list">
            {saved.secrets.map((secret) => {
              const clearing = clearSecrets.includes(secret.name);
              return (
                <div className="admin-secret-field" key={secret.name}>
                  <label className="field">
                    <span>{secret.label}</span>
                    <input
                      type="password"
                      value={secretValues[secret.name] ?? ""}
                      maxLength={16_384}
                      autoComplete="new-password"
                      placeholder={secret.configured ? "留空以保持已保存内容" : "输入新的内容"}
                      disabled={mutation.isPending || clearing}
                      aria-describedby={`secret-${secret.name}-description`}
                      onChange={(event) => {
                        const value = event.currentTarget.value;
                        setSecretValues((current) => ({ ...current, [secret.name]: value }));
                        if (value.length > 0) {
                          setClearSecrets((current) => current.filter((name) => name !== secret.name));
                        }
                        setConflict(false);
                        mutation.reset();
                        testMutation.reset();
                        applyMutation.reset();
                      }}
                    />
                    <small id={`secret-${secret.name}-description`}>{secret.description}</small>
                    <small className="admin-secret-status">
                      {secret.configured ? "已配置" : "尚未配置"}
                    </small>
                  </label>
                  <label className="admin-clear-secret">
                    <input
                      type="checkbox"
                      checked={clearing}
                      disabled={!secret.configured || mutation.isPending}
                      onChange={(event) => {
                        setClearSecrets((current) =>
                          event.currentTarget.checked
                            ? [...current.filter((name) => name !== secret.name), secret.name]
                            : current.filter((name) => name !== secret.name)
                        );
                        if (event.currentTarget.checked) {
                          setSecretValues((current) => ({ ...current, [secret.name]: "" }));
                        }
                        setConflict(false);
                        mutation.reset();
                        testMutation.reset();
                        applyMutation.reset();
                      }}
                    />
                    明确清除已保存内容
                  </label>
                </div>
              );
            })}
          </div>
        </fieldset>
      ) : null}

      {saved.requiresRestart ? (
        <p className="warning-note">
          <RefreshCw size={16} aria-hidden="true" />
          保存后需要重启服务，新的设置才会用于插件运行。
        </p>
      ) : null}

      {saved.id === "org.ustc.urmotiv.anklang" ? (
        <section className="admin-connection-test" aria-label="Anklang 连接测试">
          <div>
            <strong>连接测试</strong>
            <p>使用当前输入发送固定测试文本，不保存设置，也不会发送题库中的题面。</p>
          </div>
          <button
            type="button"
            className="secondary-button"
            disabled={mutation.isPending || testMutation.isPending}
            onClick={() => testMutation.mutate()}
          >
            <RefreshCw className={testMutation.isPending ? "spin" : ""} size={15} aria-hidden="true" />
            测试当前输入
          </button>
          {testMutation.isSuccess ? (
            <p className="admin-save-success" role="status">
              <CheckCircle2 size={16} aria-hidden="true" />
              {testMutation.data.embedding === null
                ? "Anklang 与 yuantiji 连接正常；当前模式不需要嵌入模型。"
                : `Anklang、检索来源和 ${testMutation.data.embedding.model} 嵌入接口均正常。`}
            </p>
          ) : null}
          {testMutation.isError ? (
            <p className="inline-error" role="alert">
              <AlertTriangle size={16} aria-hidden="true" />
              {errorMessage(testMutation.error)}
            </p>
          ) : null}
          <div className="admin-connection-apply">
            <button
              type="button"
              className="secondary-button"
              disabled={hasChanges || mutation.isPending || applyMutation.isPending || saved.state !== "enabled"}
              onClick={() => applyMutation.mutate()}
            >
              <RefreshCw className={applyMutation.isPending ? "spin" : ""} size={15} aria-hidden="true" />
              应用已保存设置 / 刷新状态
            </button>
          </div>
          {applyMutation.isSuccess ? (
            <p className="admin-save-success" role="status">
              <CheckCircle2 size={16} aria-hidden="true" />
              {applyMutation.data.provider.rebuild?.state === "running"
                ? `设置已应用，正在后台重建向量：${applyMutation.data.provider.rebuild.processed}/${applyMutation.data.provider.rebuild.total}。`
                : applyMutation.data.search.mode === "yuantiji"
                  ? "设置已应用：仅使用 yuantiji，不需要本地嵌入模型。"
                  : applyMutation.data.provider.rebuild?.state === "failed"
                    ? "设置已应用，但上一次向量重建失败；请检查嵌入接口后重试。"
                    : "设置已应用，本地向量索引可用。"}
            </p>
          ) : null}
          {applyMutation.isError ? (
            <p className="inline-error" role="alert">
              <AlertTriangle size={16} aria-hidden="true" />
              {errorMessage(applyMutation.error)}
            </p>
          ) : null}
        </section>
      ) : null}

      {conflict ? (
        <div className="admin-conflict" role="alert">
          <AlertTriangle size={18} aria-hidden="true" />
          <div>
            <strong>其他人已经修改了这个插件</strong>
            <p>本页输入仍然保留。重新读取会放弃这些输入并显示最新设置。</p>
            <button
              type="button"
              className="secondary-button compact-button"
              disabled={reloading}
              onClick={() => void reload()}
            >
              <RefreshCw className={reloading ? "spin" : ""} size={14} aria-hidden="true" />
              放弃本页输入并重新读取
            </button>
          </div>
        </div>
      ) : null}
      {mutation.isError && !conflict ? (
        <p className="inline-error" role="alert">
          <AlertTriangle size={16} aria-hidden="true" />
          {errorMessage(mutation.error)}
        </p>
      ) : null}
      {mutation.isSuccess && !hasChanges ? (
        <p className="admin-save-success" role="status">
          <CheckCircle2 size={16} aria-hidden="true" />
          {saved.id === "org.ustc.urmotiv.anklang"
            ? applyMutation.isPending
              ? "插件设置已保存，正在应用到 Anklang。"
              : "插件设置已保存。"
            : "插件设置已保存。这里表示配置已经写入，不代表外部服务已经连通。"}
        </p>
      ) : null}

      <div className="admin-actions">
        <span>{hasChanges ? "有尚未保存的修改" : "当前显示的是已保存设置"}</span>
        <button
          type="button"
          className="primary-button"
          disabled={!hasChanges || mutation.isPending}
          onClick={savePlugin}
        >
          {mutation.isPending ? (
            <Loader2 className="spin" size={16} aria-hidden="true" />
          ) : (
            <Save size={16} aria-hidden="true" />
          )}
          保存插件设置
        </button>
      </div>
    </section>
  );
}
