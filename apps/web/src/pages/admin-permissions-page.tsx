import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  AdminManagedRole,
  AdminPermissionCatalogGroup,
  AdminPermissionEffectiveEntry,
  AdminRoleDefaults,
  AdminRoleManagementResponse,
  AdminUserListItem,
  SessionUser
} from "@urmotiv/contracts";
import {
  createAdminRole,
  getAdminRoleDefaults,
  getAdminUserPermissions,
  listAdminPermissionCatalog,
  listAdminRoles,
  listAdminUsers,
  updateAdminRole,
  updateAdminRoleDefaults,
  updateAdminUserPermissions
} from "../lib/api";

type AdminPermissionSection = "users" | "roles" | "defaults";

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

type UserPermissionDraft = {
  expectedRevision: number;
  allows: string[];
  denies: string[];
};

type SelectedRoleId = string | "new" | null;

function ErrorState({ message }: { message: string }) {
  return <div className="plain-panel error-state" role="alert">{message}</div>;
}

function SaveUncertainNotice({
  message,
  onRefresh,
  refreshing,
  refreshError
}: {
  message: string;
  onRefresh: () => void;
  refreshing: boolean;
  refreshError: string | null;
}) {
  return (
    <div className="admin-save-uncertain" role="alert">
      <p>保存失败，服务端状态未确认：{message}</p>
      <p>请先刷新确认服务端状态；确认前不要重复提交。</p>
      <button type="button" className="secondary-button" disabled={refreshing} onClick={onRefresh}>
        {refreshing ? "正在刷新确认……" : "刷新并确认服务端状态"}
      </button>
      {refreshError !== null ? <p className="inline-error">刷新仍未确认：{refreshError}</p> : null}
    </div>
  );
}

function roleToDraft(role: AdminManagedRole): RoleDraft {
  const members = Array.isArray((role as AdminManagedRole & { memberIds?: string[] }).members)
    ? role.members
    : [];
  const legacyMemberIds = (role as AdminManagedRole & { memberIds?: string[] }).memberIds ?? [];
  return {
    id: role.id,
    key: role.key,
    displayName: role.displayName,
    description: role.description,
    expectedRevision: role.revision,
    isBuiltIn: role.isBuiltIn,
    permissions: role.permissions.map((permission) => ({ ...permission })),
    userIds: members.length > 0 ? members.map((member) => member.id) : legacyMemberIds
  };
}

function sourceLabel(source: string): string {
  if (source.startsWith("role:")) return "角色基线";
  if (source === "user:allow") return "用户 allow";
  if (source === "user:deny") return "用户 deny";
  if (source === "robot:hard-deny" || source.startsWith("hard-deny")) return "硬拒绝";
  return source;
}


function rolePermissionEffect(draft: RoleDraft, name: string): "allow" | "deny" | null {
  return draft.permissions.find((permission) => permission.name === name)?.effect ?? null;
}

function updateStringList(values: string[], name: string, checked: boolean): string[] {
  if (checked) return values.includes(name) ? values : [...values, name];
  return values.filter((value) => value !== name);
}
function previewEffectiveEntries(
  entries: AdminPermissionEffectiveEntry[],
  draft: UserPermissionDraft
): AdminPermissionEffectiveEntry[] {
  return entries.map((entry) => {
    const baseSources = entry.sources.filter((source) => source !== "user:allow" && source !== "user:deny");
    const roleAllows = baseSources.some((source) =>
      source === "root:complete" ||
      source.startsWith("role:") && !source.endsWith(":deny")
    );
    const roleDenies = baseSources.some((source) => source.startsWith("role:") && source.endsWith(":deny"));
    const hardDenied = baseSources.some((source) => source === "robot:hard-deny" || source.startsWith("hard-deny"));
    const userAllows = draft.allows.includes(entry.name);
    const userDenies = draft.denies.includes(entry.name);
    return {
      ...entry,
      allowed: (roleAllows || userAllows) && !roleDenies && !userDenies && !hardDenied,
      sources: [
        ...baseSources,
        ...(userAllows ? ["user:allow"] : []),
        ...(userDenies ? ["user:deny"] : [])
      ]
    };
  });
}

function RoleMatrix({
  groups,
  draft,
  disabled,
  onToggle,
  onEffectChange
}: {
  groups: AdminPermissionCatalogGroup[];
  draft: RoleDraft;
  disabled: boolean;
  onToggle: (name: string, checked: boolean) => void;
  onEffectChange: (name: string, effect: "allow" | "deny") => void;
}) {
  const [openGroups, setOpenGroups] = useState(
    () => disabled
      ? new Set<string>()
      : new Set(groups.filter((group) => group.permissions.some((permission) => rolePermissionEffect(draft, permission.name) !== null)).map((group) => group.key))
  );
  return (
    <div className="permission-matrix">
      {groups.map((group) => {
        const selectedCount = group.permissions.filter((permission) => rolePermissionEffect(draft, permission.name) !== null).length;
        return (
          <details
            key={group.key}
            className="permission-group"
            open={openGroups.has(group.key)}
            onToggle={(event) => {
              const isOpen = event.currentTarget.open;
              setOpenGroups((current) => {
                const next = new Set(current);
                if (isOpen) next.add(group.key);
                else next.delete(group.key);
                return next;
              });
            }}
          >
            <summary>
              <span>{group.displayName}</span>
              <small>{selectedCount}/{group.permissions.length} 项已选</small>
            </summary>
            <p>{group.key}</p>
            <fieldset disabled={disabled} className="permission-group-fields">
              {group.permissions.map((permission) => {
                const effect = rolePermissionEffect(draft, permission.name);
                return (
                  <label key={permission.name} className="permission-row">
                    <input
                      type="checkbox"
                      name={`role-${draft.key}-${permission.name}`}
                      checked={effect !== null}
                      disabled={disabled}
                      onChange={(event) => onToggle(permission.name, event.target.checked)}
                    />
                    <span className="permission-row-copy">
                      <strong>{permission.displayName}</strong>
                      <small>{permission.name}：{permission.description}</small>
                    </span>
                    {effect !== null ? (
                      <select
                        aria-label={`${permission.displayName}效果`}
                        value={effect}
                        disabled={disabled}
                        onChange={(event) => onEffectChange(permission.name, event.target.value as "allow" | "deny")}
                      >
                        <option value="allow">允许</option>
                        <option value="deny">明确拒绝</option>
                      </select>
                    ) : null}
                  </label>
                );
              })}
            </fieldset>
          </details>
        );
      })}
    </div>
  );
}

type RoleMemberView = {
  id: string;
  nickname: string;
  accountType: "human" | "robot";
  enabled: boolean;
  roles?: string[];
};

function roleMembers(rolesQuery: AdminRoleManagementResponse | undefined): RoleMemberView[] {
  if (rolesQuery === undefined) return [];
  return rolesQuery.users ?? [];
}

function RolesPanel({
  catalogGroups,
  rolesQuery
}: {
  catalogGroups: AdminPermissionCatalogGroup[];
  rolesQuery: AdminRoleManagementResponse;
}) {
  const client = useQueryClient();
  const [selectedRoleId, setSelectedRoleId] = useState<SelectedRoleId>(rolesQuery.roles[0]?.id ?? null);
  const [draft, setDraft] = useState<RoleDraft | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [refreshError, setRefreshError] = useState<string | null>(null);

  useEffect(() => {
    if (selectedRoleId === "new" || selectedRoleId === null) return;
    const selected = rolesQuery.roles.find((role) => role.id === selectedRoleId);
    if (selected !== undefined && (draft === null || draft.id !== selected.id)) {
      setDraft(roleToDraft(selected));
    }
  }, [draft, rolesQuery.roles, selectedRoleId]);

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
      setSelectedRoleId(result.role.id);
      setDraft(roleToDraft(result.role));
      client.setQueryData<AdminRoleManagementResponse>(["admin-roles"], (current) => {
        if (current === undefined) return current;
        const roles = current.roles.some((role) => role.id === result.role.id)
          ? current.roles.map((role) => role.id === result.role.id ? result.role : role)
          : [...current.roles, result.role];
        return { ...current, roles };
      });
      setRefreshError(null);
    }
  });

  const refreshAfterFailure = async () => {
    setRefreshing(true);
    setRefreshError(null);
    try {
      const refreshed = await client.fetchQuery({ queryKey: ["admin-roles"], queryFn: listAdminRoles });
      const selected = refreshed.roles.find((role) => role.id === selectedRoleId);
      if (selected !== undefined) {
        setDraft(roleToDraft(selected));
      }
      mutation.reset();
    } catch (error) {
      setRefreshError(error instanceof Error ? error.message : "刷新失败。");
    } finally {
      setRefreshing(false);
    }
  };

  if (draft === null) return <div className="plain-panel" role="status">正在读取角色设置……</div>;
  const rootRole = draft.key === "root";
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
      permissions: draft.permissions.map((permission) => permission.name === name ? { ...permission, effect } : permission)
    });
  };
  const members = roleMembers(rolesQuery);

  return (
    <div className="admin-permissions-roles">
      <div className="permission-role-list plain-panel">
        <div className="admin-section-heading">
          <div>
            <h2>角色基线</h2>
            <p>角色提供基础权限；用户 allow 和用户 deny 在此基础上单独叠加。</p>
          </div>
          <button
            type="button"
            className="secondary-button"
            onClick={() => {
              setSelectedRoleId("new");
              setDraft({ id: null, key: "", displayName: "", description: "", expectedRevision: 1, isBuiltIn: false, permissions: [], userIds: [] });
              setRefreshError(null);
              mutation.reset();
            }}
          >
            新建角色
          </button>
        </div>
        <div className="permission-role-buttons" role="list" aria-label="角色列表">
          {rolesQuery.roles.map((role) => (
            <button
              type="button"
              role="listitem"
              key={role.id}
              className={selectedRoleId === role.id ? "selected" : ""}
              onClick={() => { setSelectedRoleId(role.id); setRefreshError(null); mutation.reset(); }}
            >
              <strong>{role.displayName}{role.key === "root" ? "（受保护）" : ""}</strong>
              <small>{role.key} · {role.permissions.length} 项权限</small>
            </button>
          ))}
        </div>
      </div>

      <form
        className="permission-role-editor plain-panel"
        onSubmit={(event) => {
          event.preventDefault();
          if (!rootRole && !mutation.isError) mutation.mutate(draft);
        }}
      >
        <div className="admin-section-heading">
          <div>
            <h2>{draft.id === null ? "新建自定义角色" : `编辑角色：${draft.displayName}`}</h2>
            <p>{rootRole ? "root 角色包含完整权限目录，仅供查看；服务端仍会强制 root、机器人和自我升级边界。" : "非 root 角色可以编辑完整权限目录，不受当前管理员有效权限的二次截断。"}</p>
          </div>
        </div>
        <div className="permission-role-fields">
          <label>角色标识<input value={draft.key} disabled={rootRole || draft.id !== null && draft.isBuiltIn} required onChange={(event) => updateDraft({ key: event.target.value })} /></label>
          <label>显示名称<input value={draft.displayName} disabled={rootRole || draft.id !== null && draft.isBuiltIn} required onChange={(event) => updateDraft({ displayName: event.target.value })} /></label>
          <label className="wide-field">说明<textarea value={draft.description} disabled={rootRole || draft.id !== null && draft.isBuiltIn} onChange={(event) => updateDraft({ description: event.target.value })} /></label>
        </div>
        <h3>权限目录</h3>
        <RoleMatrix key={draft.id ?? "new"} groups={catalogGroups} draft={draft} disabled={rootRole} onToggle={togglePermission} onEffectChange={changePermissionEffect} />
        <fieldset className="permission-member-list" disabled={rootRole}>
          <legend>角色成员</legend>
          {members.length === 0 ? <p>暂无可显示的成员。</p> : members.map((user) => (
            <label key={user.id} className="checkbox-row">
              <input
                type="checkbox"
                checked={draft.userIds.includes(user.id)}
                disabled={user.id === "0" || user.roles?.includes("root") === true}
                onChange={(event) => updateDraft({ userIds: event.target.checked ? [...draft.userIds, user.id] : draft.userIds.filter((id) => id !== user.id) })}
              />
              {user.nickname}（{user.accountType === "robot" ? "机器人" : "普通账号"}）
            </label>
          ))}
          <p>机器人即使拥有角色，也不能绕过服务端硬拒绝；root 账号和 root 身份不能通过此处授予。</p>
        </fieldset>
        <div className="admin-actions">
          <span>修订号：{draft.expectedRevision}</span>
          <button type="submit" className="primary-button" disabled={rootRole || mutation.isPending || mutation.isError || refreshing}>{draft.id === null ? "创建角色" : "保存角色"}</button>
        </div>
        {rootRole ? <p className="notice-line">root（受保护）：只读展示完整权限宇宙，不能修改或删除。</p> : null}
        {mutation.isError ? (
          <SaveUncertainNotice
            message={mutation.error instanceof Error ? mutation.error.message : "请求失败。"}
            onRefresh={refreshAfterFailure}
            refreshing={refreshing}
            refreshError={refreshError}
          />
        ) : null}
        {mutation.isSuccess ? <p className="admin-save-success" role="status">角色设置已保存。</p> : null}
      </form>
    </div>
  );
}

function isManageableUser(user: AdminUserListItem): boolean {
  return user.accountType === "human" && user.id !== "0" && !user.roles.includes("root");
}

function PermissionDeltaMatrix({
  catalogGroups,
  title,
  values,
  disabled,
  onToggle
}: {
  catalogGroups: AdminPermissionCatalogGroup[];
  title: string;
  values: string[];
  disabled: boolean;
  onToggle: (name: string, checked: boolean) => void;
}) {
  const [openGroups, setOpenGroups] = useState(
    () => new Set(catalogGroups.filter((group) => group.permissions.some((permission) => values.includes(permission.name))).map((group) => group.key))
  );
  return (
    <div className="permission-delta-column">
      <h4>{title}</h4>
      {catalogGroups.map((group) => {
        const selectedCount = group.permissions.filter((permission) => values.includes(permission.name)).length;
        return (
          <details
            key={group.key}
            className="permission-group"
            open={openGroups.has(group.key)}
            onToggle={(event) => {
              const isOpen = event.currentTarget.open;
              setOpenGroups((current) => {
                const next = new Set(current);
                if (isOpen) next.add(group.key);
                else next.delete(group.key);
                return next;
              });
            }}
          >
            <summary>
              <span>{group.displayName}</span>
              <small>{selectedCount}/{group.permissions.length} 项已选</small>
            </summary>
            <p>{group.key}</p>
            <fieldset className="permission-group-fields" disabled={disabled}>
              {group.permissions.map((permission) => (
                <label key={permission.name} className="permission-row compact">
                  <input
                    type="checkbox"
                    name={`${title.startsWith("用户允许") ? "user-allow" : "user-deny"}-${permission.name}`}
                    checked={values.includes(permission.name)}
                    disabled={disabled}
                    onChange={(event) => onToggle(permission.name, event.target.checked)}
                  />
                  <span className="permission-row-copy"><strong>{permission.displayName}</strong><small>{permission.name}：{permission.description}</small></span>
                </label>
              ))}
            </fieldset>
          </details>
        );
      })}
    </div>
  );
}

function UserPanel({
  catalogGroups,
  users
}: {
  catalogGroups: AdminPermissionCatalogGroup[];
  users: AdminUserListItem[];
}) {
  const client = useQueryClient();
  const humanUsers = users.filter(isManageableUser);
  const [search, setSearch] = useState("");
  const [selectedUserId, setSelectedUserId] = useState<string | null>(humanUsers[0]?.id ?? null);
  const [draft, setDraft] = useState<UserPermissionDraft | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [refreshError, setRefreshError] = useState<string | null>(null);
  const [effective, setEffective] = useState<AdminPermissionEffectiveEntry[] | null>(null);
  const usersQuery = useQuery({
    queryKey: ["admin-users", search],
    queryFn: () => listAdminUsers(search),
    staleTime: 15_000
  });
  const visibleUsers = (usersQuery.data?.items ?? humanUsers).filter(isManageableUser);
  const selectedVisibleUser = visibleUsers.find((user) => user.id === selectedUserId);
  const protectedUser = selectedVisibleUser?.id === "0" || selectedVisibleUser?.roles.includes("root") === true;
  const permissionQuery = useQuery({
    queryKey: ["admin-user-permissions", selectedUserId],
    queryFn: () => getAdminUserPermissions(selectedUserId!),
    enabled: selectedUserId !== null
  });
  const mutation = useMutation({
    mutationFn: ({ userId, input }: { userId: string; input: UserPermissionDraft }) => updateAdminUserPermissions(userId, input),
    onSuccess: (result) => {
      setDraft({ expectedRevision: result.delta.revision, allows: result.delta.allows, denies: result.delta.denies });
      setEffective(result.effective.entries);
      client.setQueryData(["admin-user-permissions", result.delta.userId], result);
      setRefreshError(null);
    }
  });

  const refreshAfterFailure = async () => {
    setRefreshing(true);
    setRefreshError(null);
    try {
      const refreshed = await permissionQuery.refetch();
      if (refreshed.error !== null && refreshed.error !== undefined) throw refreshed.error;
      if (refreshed.data === undefined) throw new Error("刷新未返回账号权限。");
      setDraft({
        expectedRevision: refreshed.data.delta.revision,
        allows: refreshed.data.delta.allows,
        denies: refreshed.data.delta.denies
      });
      setEffective(refreshed.data.effective.entries);
      mutation.reset();
    } catch (error) {
      setRefreshError(error instanceof Error ? error.message : "刷新失败。");
    } finally {
      setRefreshing(false);
    }
  };

  useEffect(() => {
    const first = visibleUsers[0]?.id ?? null;
    if (!visibleUsers.some((user) => user.id === selectedUserId) && first !== selectedUserId) {
      setDraft(null);
      setEffective(null);
      setRefreshError(null);
      mutation.reset();
    }
  }, [selectedUserId, visibleUsers]);
  useEffect(() => {
    if (permissionQuery.data === undefined) return;
    setDraft({
      expectedRevision: permissionQuery.data.delta.revision,
      allows: permissionQuery.data.delta.allows,
      denies: permissionQuery.data.delta.denies
    });
    setEffective(permissionQuery.data.effective.entries);
  }, [permissionQuery.data, selectedUserId]);

  const allPermissions = useMemo(
    () => catalogGroups.flatMap((group) => group.permissions.map((permission) => ({ ...permission, group }))),
    [catalogGroups]
  );
  const effectiveEntries = useMemo(
    () => effective === null || draft === null ? [] : previewEffectiveEntries(effective, draft),
    [draft, effective]
  );
  const noManageableUsers = selectedUserId === null && !usersQuery.isPending;
  if (permissionQuery.isError) return <ErrorState message={permissionQuery.error.message} />;
  return (
    <div className="permission-user-panel">
      <div className="admin-section-heading">
        <div>
          <h2>账号权限</h2>
          <p>只显示普通人类账号；角色基线、用户 allow additions、用户 deny removals 分开保存，冲突时用户拒绝优先。</p>
        </div>
      </div>
      <div className="permission-user-layout">
        <div className="permission-user-list plain-panel">
          <label>搜索账号<input value={search} placeholder="昵称或账号 ID" onChange={(event) => setSearch(event.target.value)} /></label>
          <div role="list" aria-label="普通账号列表">
            {visibleUsers.map((user) => (
              <button type="button" role="listitem" key={user.id} className={selectedUserId === user.id ? "selected" : ""} onClick={() => { setSelectedUserId(user.id); setDraft(null); setEffective(null); setRefreshError(null); mutation.reset(); }}>
                <strong>{user.nickname}</strong>
                <small>{user.id} · {user.roles.join("、") || "无角色"}</small>
              </button>
            ))}
            {!usersQuery.isPending && visibleUsers.length === 0 ? <p>没有匹配的普通账号。</p> : null}
          </div>
        </div>
        <div className="permission-user-editor plain-panel">
          {noManageableUsers ? (
            <div className="permission-user-empty" role="status">
              <h3>没有可管理的普通用户</h3>
              <p>root 和 root 身份受到保护；当前没有可编辑账号，页面保持只读说明，不会请求受保护资源。</p>
            </div>
          ) : selectedVisibleUser === undefined || draft === null || permissionQuery.isPending ? <p role="status">正在读取账号权限……</p> : (
            <>
              <div className="permission-user-heading">
                <div><h3>{selectedVisibleUser.nickname}</h3><p>{selectedVisibleUser.id} · 角色基线：{permissionQuery.data?.delta.roles.join("、") || "无"}</p></div>
                {protectedUser ? <span className="status-badge">root（受保护）</span> : null}
              </div>
              <p className="notice-line">生效来源：角色基线、用户 allow、用户 deny；用户拒绝（优先）覆盖同名允许，机器人还会受硬拒绝规则约束。</p>
              <div className="permission-delta-columns">
                <PermissionDeltaMatrix
                  key={`allow-${selectedUserId}-${permissionQuery.data.delta.revision}`}
                  catalogGroups={catalogGroups}
                  title="用户允许（allow additions）"
                  values={draft.allows}
                  disabled={protectedUser}
                  onToggle={(name, checked) => setDraft({ ...draft, allows: updateStringList(draft.allows, name, checked) })}
                />
                <PermissionDeltaMatrix
                  key={`deny-${selectedUserId}-${permissionQuery.data.delta.revision}`}
                  catalogGroups={catalogGroups}
                  title="用户拒绝（deny removals）"
                  values={draft.denies}
                  disabled={protectedUser}
                  onToggle={(name, checked) => setDraft({ ...draft, denies: updateStringList(draft.denies, name, checked) })}
                />
              </div>
              <EffectivePermissionPreview
                key={`${selectedUserId}-${permissionQuery.data.delta.revision}`}
                catalogGroups={catalogGroups}
                entries={effectiveEntries}
              />
              <div className="admin-actions">
                <span>修订号：{draft.expectedRevision}</span>
                <button type="button" className="primary-button" disabled={protectedUser || mutation.isPending || mutation.isError || refreshing} onClick={() => selectedUserId !== null && !mutation.isError && mutation.mutate({ userId: selectedUserId, input: draft })}>保存用户权限</button>
              </div>
              {mutation.isError ? (
                <SaveUncertainNotice
                  message={mutation.error instanceof Error ? mutation.error.message : "请求失败。"}
                  onRefresh={refreshAfterFailure}
                  refreshing={refreshing}
                  refreshError={refreshError}
                />
              ) : null}
              {mutation.isSuccess ? <p className="admin-save-success" role="status">账号权限已保存。</p> : null}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function EffectivePermissionPreview({
  catalogGroups,
  entries
}: {
  catalogGroups: AdminPermissionCatalogGroup[];
  entries: Array<{ name: string; allowed: boolean; sources: string[] }>;
}) {
  const permissionLabels = new Map(catalogGroups.flatMap((group) => group.permissions.map((permission) => [permission.name, permission.displayName] as const)));
  const knownNames = new Set(permissionLabels.keys());
  const domains = catalogGroups
    .map((group) => ({ key: group.key, displayName: group.displayName, entries: entries.filter((entry) => group.permissions.some((permission) => permission.name === entry.name)) }))
    .concat(entries.some((entry) => !knownNames.has(entry.name)) ? [{ key: "other", displayName: "其他权限", entries: entries.filter((entry) => !knownNames.has(entry.name)) }] : []);
  const [openGroups, setOpenGroups] = useState<Set<string>>(() => new Set());
  return (
    <div className="permission-effective-preview">
      <h3>生效权限预览</h3>
      <p>每项权限列出来源；同一项同时 allow 和 deny 时，以用户拒绝为准。</p>
      <div className="effective-domains">
        {domains.map((domain) => {
          const deniedCount = domain.entries.filter((entry) => !entry.allowed).length;
          const sourceCount = domain.entries.reduce((total, entry) => total + entry.sources.length, 0);
          return (
            <details
              key={domain.key}
              className="effective-domain"
              open={openGroups.has(domain.key)}
              onToggle={(event) => {
                const isOpen = event.currentTarget.open;
                setOpenGroups((current) => {
                  const next = new Set(current);
                  if (isOpen) next.add(domain.key);
                  else next.delete(domain.key);
                  return next;
                });
              }}
            >
              <summary>
                <span>{domain.displayName}</span>
                <small>{domain.entries.length} 项 · {deniedCount} 项拒绝 · {sourceCount} 个来源</small>
              </summary>
              <div className="effective-domain-entries">
                {domain.entries.map((entry) => (
                  <div key={entry.name} className={entry.allowed ? "effective-entry" : "effective-entry denied"}>
                    <strong>{permissionLabels.get(entry.name) ?? entry.name}</strong>
                    <code>{entry.name}</code>
                    <span>{entry.allowed ? "允许" : "拒绝"} · {entry.sources.map(sourceLabel).join("、") || "无来源"}</span>
                  </div>
                ))}
              </div>
            </details>
          );
        })}
      </div>
    </div>
  );
}

function DefaultsPanel({ roles, defaults, session }: { roles: AdminManagedRole[]; defaults: AdminRoleDefaults; session: SessionUser }) {
  const client = useQueryClient();
  const [draft, setDraft] = useState({ expectedRevision: defaults.revision, humanRoleKey: defaults.humanRoleKey, robotRoleKey: defaults.robotRoleKey });
  const mutation = useMutation({
    mutationFn: updateAdminRoleDefaults,
    onSuccess: (result) => {
      setDraft({ expectedRevision: result.defaults.revision, humanRoleKey: result.defaults.humanRoleKey, robotRoleKey: result.defaults.robotRoleKey });
      client.setQueryData(["admin-role-defaults"], result);
    }
  });
  useEffect(() => {
    setDraft({ expectedRevision: defaults.revision, humanRoleKey: defaults.humanRoleKey, robotRoleKey: defaults.robotRoleKey });
  }, [defaults]);
  const canEdit = session.isRoot;
  return (
    <form className="plain-panel permission-defaults" onSubmit={(event) => { event.preventDefault(); if (canEdit) mutation.mutate(draft); }}>
      <div className="admin-section-heading"><div><h2>默认角色</h2><p>新注册和首次 OAuth 创建的普通账号使用人类默认角色；机器人默认角色仍受机器人硬拒绝规则限制。</p></div></div>
      <label>普通账号默认角色<select value={draft.humanRoleKey} disabled={!canEdit} onChange={(event) => setDraft({ ...draft, humanRoleKey: event.target.value })}>{roles.filter((role) => role.key !== "root").map((role) => <option key={role.key} value={role.key}>{role.displayName}（{role.key}）</option>)}</select></label>
      <label>机器人默认角色<select value={draft.robotRoleKey} disabled={!canEdit} onChange={(event) => setDraft({ ...draft, robotRoleKey: event.target.value })}>{roles.filter((role) => role.key !== "root").map((role) => <option key={role.key} value={role.key}>{role.displayName}（{role.key}）</option>)}</select></label>
      <div className="admin-actions"><span>修订号：{draft.expectedRevision}</span><button type="submit" className="primary-button" disabled={!canEdit || mutation.isPending}>保存默认角色</button></div>
      {!canEdit ? <p className="notice-line">只有 root 可以修改默认角色；普通管理员可以查看当前配置。</p> : null}
      {mutation.isError ? <p className="inline-error" role="alert">{mutation.error.message}</p> : null}
      {mutation.isSuccess ? <p className="admin-save-success" role="status">默认角色已保存。</p> : null}
    </form>
  );
}

export function AdminPermissionsPage({
  session,
  section = "roles"
}: {
  session: SessionUser;
  section?: AdminPermissionSection;
}) {
  const needsCatalog = section !== "defaults";
  const needsRoles = section !== "users";
  const needsDefaults = section === "defaults" && session.isRoot;
  const needsUsers = section === "users";
  const catalogQuery = useQuery({ queryKey: ["admin-permission-catalog"], queryFn: listAdminPermissionCatalog, enabled: needsCatalog });
  const rolesQuery = useQuery({ queryKey: ["admin-roles"], queryFn: listAdminRoles, enabled: needsRoles });
  const defaultsQuery = useQuery({ queryKey: ["admin-role-defaults"], queryFn: getAdminRoleDefaults, enabled: needsDefaults });
  const usersQuery = useQuery({ queryKey: ["admin-users", ""], queryFn: () => listAdminUsers(), enabled: needsUsers });
  const copy = {
    users: {
      title: "用户管理",
      description: "搜索可管理普通用户，编辑用户权限增量并查看最终生效权限。"
    },
    roles: {
      title: "角色与权限",
      description: "维护角色权限基线、允许或明确拒绝的效果以及角色成员。"
    },
    defaults: {
      title: "默认角色",
      description: "说明新账号使用的人类与机器人默认角色，并在 root 权限下选择它们。"
    }
  }[section];
  if (
    needsCatalog && catalogQuery.isPending ||
    needsRoles && rolesQuery.isPending ||
    needsDefaults && defaultsQuery.isPending ||
    needsUsers && usersQuery.isPending
  ) {
    return <section className="admin-page"><div className="page-heading"><div><p className="eyebrow">管理 / {copy.title}</p><h1>{copy.title}</h1></div></div><div className="plain-panel" role="status">正在读取{copy.title}……</div></section>;
  }
  if (needsCatalog && catalogQuery.isError) return <ErrorState message={catalogQuery.error.message} />;
  if (needsRoles && rolesQuery.isError) return <ErrorState message={rolesQuery.error.message} />;
  if (needsDefaults && defaultsQuery.isError) return <ErrorState message={defaultsQuery.error.message} />;
  if (needsUsers && usersQuery.isError) return <ErrorState message={usersQuery.error.message} />;
  const catalog = catalogQuery.data;
  const roles = rolesQuery.data;
  const defaults = defaultsQuery.data?.defaults;
  return (
    <section className={`admin-page admin-permissions-page admin-permissions-page-${section}`}>
      <div className="page-heading">
        <div><p className="eyebrow">管理 / {copy.title}</p><h1>{copy.title}</h1><p>{copy.description}</p></div>
      </div>
      {section === "roles" && catalog !== undefined && roles !== undefined ? <RolesPanel catalogGroups={catalog.groups} rolesQuery={roles} /> : null}
      {section === "users" && catalog !== undefined && usersQuery.data !== undefined ? <UserPanel catalogGroups={catalog.groups} users={usersQuery.data.items} /> : null}
      {section === "defaults" && roles !== undefined ? defaults !== undefined ? <DefaultsPanel roles={roles.roles} defaults={defaults} session={session} /> : <div className="plain-panel permission-defaults"><h2>默认角色</h2><p>只有 root 可以查看和修改默认角色；当前账号可以看到受保护的只读说明。</p></div> : null}
    </section>
  );
}
