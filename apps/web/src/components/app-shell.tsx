import {
  ArrowLeftRight,
  BookOpen,
  ClipboardCheck,
  FilePenLine,
  ListChecks,
  Settings
} from "lucide-react";
import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import { NavLink } from "react-router-dom";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { SessionResponse } from "@urmotiv/contracts";
import { avatarUrlFor, logout } from "../lib/api";
import { clearProblemDrafts } from "../lib/client-security";

type AppShellProps = {
  session: NonNullable<SessionResponse["user"]>;
  demoEnabled: boolean;
  children: ReactNode;
};

const contestPermissions = [
  "contest.create",
  "contest.edit.own",
  "contest.edit.all",
  "contest.delete",
  "contest.export",
  "contest.risk.read"
] as const;

const transferPermissions = [
  "problem.import",
  "problem.export.own",
  "problem.export.all"
] as const;

const baseNavItems = [
  { to: "/problems", label: "题目", icon: BookOpen },
  { to: "/submissions", label: "我的投稿", icon: FilePenLine },
  { to: "/reviews", label: "待审", icon: ClipboardCheck }
];

const managementGroups = [
  {
    label: "系统",
    items: [
      { to: "/admin/settings", label: "常规设置" },
      { to: "/admin/audit", label: "审计记录" }
    ]
  },
  {
    label: "账号与权限",
    items: [
      { to: "/admin/users", label: "用户管理" },
      { to: "/admin/roles", label: "角色与权限" },
      { to: "/admin/roles/defaults", label: "默认角色" },
      { to: "/admin/service-accounts", label: "服务账号" }
    ]
  },
  {
    label: "内容与迁移",
    items: [
      { to: "/admin/accounts", label: "批量账号" },
      { to: "/admin/imports", label: "导入历史" },
      { to: "/admin/knowledge", label: "知识点目录" }
    ]
  },
  {
    label: "集成",
    items: [
      { to: "/admin/plugins", label: "插件配置" },
      { to: "/admin/oauth", label: "USTC OAuth" },
      { to: "/admin/fermata", label: "Fermata 服务" }
    ]
  }
];

function canManage(session: NonNullable<SessionResponse["user"]>): boolean {
  return session.accountType === "human" && (
    session.permissions.includes("user.create") ||
    session.canManageReviewPolicy ||
    session.canManagePlugins ||
    session.canManageTags ||
    session.canManageSystem === true ||
    session.canManagePermissions === true ||
    session.canManageProblemCatalog === true
  );
}

function buildNavItems(session: NonNullable<SessionResponse["user"]>) {
  const items = [...baseNavItems];
  if (contestPermissions.some((name) => session.permissions.includes(name))) {
    items.push({ to: "/contests", label: "组题", icon: ListChecks });
  }
  if (transferPermissions.some((name) => session.permissions.includes(name))) {
    items.push({ to: "/transfer", label: "导入导出", icon: ArrowLeftRight });
  }
  return { items, showManagement: canManage(session) };
}

function HeaderAvatar({ user }: { user: NonNullable<SessionResponse["user"]> }) {
  const [broken, setBroken] = useState(false);
  useEffect(() => {
    setBroken(false);
  }, [user.id]);
  if (!broken) {
    return (
      <img
        className="header-avatar"
        src={avatarUrlFor(user.id)}
        alt=""
        onError={() => setBroken(true)}
      />
    );
  }
  const trimmed = user.nickname.trim();
  const initial = trimmed ? Array.from(trimmed)[0]! : "?";
  return (
    <span className="header-avatar header-avatar-initial" aria-hidden="true">
      {initial}
    </span>
  );
}

export function AppShell({ session, demoEnabled, children }: AppShellProps) {
  const { items: navItems, showManagement } = buildNavItems(session);
  const client = useQueryClient();
  const signOut = useMutation({
    mutationFn: logout,
    onSuccess: () => {
      clearProblemDrafts();
      client.removeQueries({
        predicate: (query) => query.queryKey[0] !== "session"
      });
      client.getMutationCache().clear();
      void client.resetQueries({ queryKey: ["session"], exact: true });
    }
  });
  return (
    <div className="app-shell">
      <a className="skip-link" href="#main-content">
        跳到主要内容
      </a>
      <header className="global-header">
        <NavLink className="brand" to="/problems" aria-label="Urmotiv 题目">
          <span className="brand-mark">U</span>
          <span>Urmotiv</span>
        </NavLink>
        <nav className="global-nav" aria-label="主导航">
          {navItems.map(({ to, label, icon: Icon }) => (
            <NavLink key={to} to={to} className={({ isActive }) => (isActive ? "active" : "")}>
              <Icon size={16} aria-hidden="true" />
              <span>{label}</span>
            </NavLink>
          ))}
          {showManagement ? (
            <div className="global-nav-management">
              <NavLink end to="/admin" className={({ isActive }) => (isActive ? "active" : "")}>
                <Settings size={16} aria-hidden="true" />
                <span>管理</span>
              </NavLink>
              <div className="management-nav-groups" aria-label="管理分组">
                {managementGroups.map((group) => (
                  <section key={group.label} className="management-nav-group">
                    <span className="management-nav-group-label">{group.label}</span>
                    <div className="management-nav-group-items">
                      {group.items.map((item) => (
                        <NavLink end key={item.to} to={item.to} className={({ isActive }) => (isActive ? "active" : "")}>
                          {item.label}
                        </NavLink>
                      ))}
                    </div>
                  </section>
                ))}
              </div>
            </div>
          ) : null}
        </nav>
        <div className="user-context">
          <NavLink className="user-profile-link" to="/profile" aria-label="个人资料">
            <HeaderAvatar user={session} />
            <div className="user-name">
              <strong>{session.nickname}</strong>
              <span>{session.roles.join("、") || "已登录"}</span>
            </div>
          </NavLink>
          {demoEnabled ? (
            <NavLink to="/demo-login" className="quiet-link">
              切换演示账号
            </NavLink>
          ) : null}
          <button type="button" className="text-button" onClick={() => signOut.mutate()} disabled={signOut.isPending}>
            退出
          </button>
        </div>
      </header>
      <main id="main-content" className="main-content" tabIndex={-1}>{children}</main>
    </div>
  );
}
