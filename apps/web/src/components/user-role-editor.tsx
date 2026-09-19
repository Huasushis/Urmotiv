import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { AdminManagedRole } from "@urmotiv/contracts";
import { listAdminRoles, updateAdminRole } from "../lib/api";

/** Membership changes reuse the versioned role API so other members are preserved. */
export function UserRoleEditor({ userId, protectedUser = false }: { userId: string; protectedUser?: boolean }) {
  const client = useQueryClient();
  const [selectedRole, setSelectedRole] = useState("");
  const roles = useQuery({ queryKey: ["admin-roles"], queryFn: listAdminRoles });
  const mutation = useMutation({
    mutationFn: ({ role, add }: { role: AdminManagedRole; add: boolean }) => updateAdminRole(role.id, {
      key: role.key,
      displayName: role.displayName,
      description: role.description,
      expectedRevision: role.revision,
      permissions: role.permissions,
      userIds: [...new Set([
        ...role.members.map(member => member.id).filter(id => id !== userId),
        ...(add ? [userId] : [])
      ])]
    }),
    onSuccess: async () => {
      setSelectedRole("");
      await Promise.all([
        client.invalidateQueries({ queryKey: ["admin-roles"] }),
        client.invalidateQueries({ queryKey: ["admin-users"] }),
        client.invalidateQueries({ queryKey: ["admin-user-permissions", userId] })
      ]);
    }
  });
  if (protectedUser) return <section className="user-role-editor"><h4>所属权限组</h4><p>root · 全部核心权限，不可转授。</p></section>;
  const assigned = roles.data?.roles.filter(role => role.members.some(member => member.id === userId)) ?? [];
  const available = roles.data?.roles.filter(role => role.key !== "root" && !role.members.some(member => member.id === userId)) ?? [];
  const change = (role: AdminManagedRole, add: boolean) => {
    if (window.confirm(`${add ? "授予" : "移除"}此账号的「${role.displayName}」权限组？保存后立即生效；未保存的权限微调将重新读取。`)) {
      mutation.mutate({ role, add });
    }
  };
  return <section className="user-role-editor" aria-label="所属权限组">
    <h4>所属权限组</h4>
    {roles.isPending ? <p role="status">正在读取权限组……</p> : null}
    {roles.error ? <p role="alert">{roles.error.message}</p> : null}
    <div className="user-role-memberships">
      {assigned.map(role => <div key={role.id} className="user-role-membership">
        <span>{role.displayName}</span>
        <button type="button" className="text-button" disabled={mutation.isPending || mutation.isError || role.key === "root"} onClick={() => change(role, false)} aria-label={`移除${role.displayName}权限组`}>移除</button>
      </div>)}
      {roles.isSuccess && assigned.length === 0 ? <p>尚未分配权限组。</p> : null}
    </div>
    <div className="user-role-add">
      <select aria-label="选择要添加的权限组" value={selectedRole} onChange={event => setSelectedRole(event.target.value)} disabled={mutation.isPending}>
        <option value="">选择权限组</option>
        {available.map(role => <option key={role.id} value={role.id}>{role.displayName}</option>)}
      </select>
      <button type="button" className="secondary-button" disabled={!selectedRole || mutation.isPending || mutation.isError} onClick={() => {
        const role = available.find(candidate => candidate.id === selectedRole);
        if (role) change(role, true);
      }}>添加权限组</button>
    </div>
    {mutation.error ? <div role="alert"><p>{mutation.error.message}</p><button type="button" className="text-button" onClick={async () => {
      const result = await roles.refetch();
      if (!result.error) mutation.reset();
    }}>刷新权限组后重试</button></div> : null}
    {mutation.isSuccess ? <p role="status">所属权限组已更新。</p> : null}
  </section>;
}
