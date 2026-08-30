import { NavLink, useLocation } from "react-router-dom";
import type { ReactNode } from "react";
import type { SessionUser } from "@urmotiv/contracts";

export type AdminNavigationItem = {
  readonly to: string;
  readonly label: string;
};

export type AdminNavigationGroup = {
  readonly label: string;
  readonly items: readonly AdminNavigationItem[];
};

export function canOpenAdmin(session: SessionUser): boolean {
  return session.accountType === "human" && (
    session.canManageReviewPolicy ||
    session.canManagePlugins ||
    session.canManageTags ||
    session.canManageSystem === true ||
    session.canManagePermissions === true ||
    session.canManageServiceAccounts === true ||
    session.canReadAudit === true ||
    session.canManageProblemCatalog === true ||
    session.canManageOAuth === true ||
    session.permissions.includes("user.create")
  );
}

export function adminNavigationGroups(session: SessionUser): AdminNavigationGroup[] {
  const canReview = session.accountType === "human" && session.canManageReviewPolicy;
  const canManagePlugins = session.accountType === "human" && session.canManagePlugins;
  const canManageTags = session.accountType === "human" && session.canManageTags;
  const canManageSystem = session.accountType === "human" && session.canManageSystem === true;
  const canManagePermissions = session.accountType === "human" && session.canManagePermissions === true;
  const canManageServiceAccounts = session.accountType === "human" && session.canManageServiceAccounts === true;
  const canReadAudit = session.accountType === "human" && session.canReadAudit === true;
  const canManageProblemCatalog = session.accountType === "human" && session.canManageProblemCatalog === true;
  const canManageOAuth = session.accountType === "human" && session.canManageOAuth === true;
  const canCreateUsers = session.accountType === "human" && session.permissions.includes("user.create");

  return [
    {
      label: "管理",
      items: canOpenAdmin(session) ? [{ to: "/admin", label: "概览" }] : []
    },
    {
      label: "题库",
      items: [
        ...(canReview ? [{ to: "/admin/review", label: "审核规则" }] : []),
        ...(canManageTags ? [{ to: "/admin/knowledge", label: "知识点目录" }] : []),
        ...(canManageProblemCatalog ? [{ to: "/problems", label: "题库" }] : []),
        ...(canManageProblemCatalog ? [{ to: "/admin/imports", label: "导入记录" }] : [])
      ]
    },
    {
      label: "用户与权限",
      items: [
        ...(canManagePermissions ? [{ to: "/admin/users", label: "用户管理" }] : []),
        ...(canManagePermissions ? [{ to: "/admin/roles", label: "角色与权限" }] : []),
        ...(canManagePermissions ? [{ to: "/admin/roles/defaults", label: "默认角色" }] : []),
        ...(canCreateUsers ? [{ to: "/admin/accounts", label: "批量创建账号" }] : []),
        ...(canManageServiceAccounts ? [{ to: "/admin/service-accounts", label: "服务账号" }] : [])
      ]
    },
    {
      label: "系统",
      items: [
        ...(canManageSystem ? [{ to: "/admin/settings", label: "常规设置" }] : []),
        ...(canManageOAuth ? [{ to: "/admin/oauth", label: "统一身份认证" }] : []),
        ...(canReadAudit ? [{ to: "/admin/audit", label: "审计记录" }] : [])
      ]
    },
    {
      label: "扩展",
      items: canManagePlugins ? [{ to: "/admin/plugins", label: "插件" }] : []
    }
  ].filter((group) => group.items.length > 0);
}

export function AdminLayout({
  session,
  title,
  description,
  children,
  actions
}: {
  session: SessionUser;
  title: string;
  description?: string;
  children: ReactNode;
  actions?: ReactNode;
}) {
  const groups = adminNavigationGroups(session);
  const location = useLocation();
  const currentLabel = groups
    .flatMap((group) => group.items)
    .find((item) => item.to === location.pathname)?.label ?? title;
  return (
    <section className="admin-page">
      <div className="admin-layout">
        <details className="admin-mobile-navigation" key={location.pathname}>
          <summary>
            <span>管理栏目</span>
            <strong>{currentLabel}</strong>
          </summary>
          <nav aria-label="管理导航（移动端）">
            {groups.map((group) => (
              <section key={group.label}>
                <h2>{group.label}</h2>
                <div>
                  {group.items.map((item) => (
                    <NavLink
                      end
                      key={item.to}
                      to={item.to}
                      className={({ isActive }) => isActive ? "active" : ""}
                    >
                      {item.label}
                    </NavLink>
                  ))}
                </div>
              </section>
            ))}
          </nav>
        </details>
        <div className="admin-content">
          <header className="admin-page-header">
            <div>
              <p className="eyebrow">控制面板</p>
              <h1>{title}</h1>
              {description ? <p>{description}</p> : null}
            </div>
            {actions ? <div className="admin-page-actions">{actions}</div> : null}
          </header>
          {children}
        </div>
        <aside className="admin-sidebar">
          <nav className="admin-section-nav" aria-label="管理导航">
            {groups.map((group) => (
              <section key={group.label} className="admin-sidebar-group">
                <h2>{group.label}</h2>
                <div>
                  {group.items.map((item) => (
                    <NavLink
                      end
                      key={item.to}
                      to={item.to}
                      className={({ isActive }) => `admin-section-link${isActive ? " active" : ""}`}
                    >
                      {item.label}
                    </NavLink>
                  ))}
                </div>
              </section>
            ))}
          </nav>
        </aside>
      </div>
    </section>
  );
}
