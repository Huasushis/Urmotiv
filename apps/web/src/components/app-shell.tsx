import {
  ArrowLeftRight,
  BookOpen,
  ChevronDown,
  ClipboardCheck,
  FilePenLine,
  ListChecks,
  LogOut,
  Menu,
  Settings,
  UserRound,
  X
} from "lucide-react";
import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import { NavLink } from "react-router-dom";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { SessionResponse } from "@urmotiv/contracts";
import { avatarUrlFor, logout } from "../lib/api";
import { clearProblemDrafts } from "../lib/client-security";
import { canOpenAdmin } from "./admin-layout";

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

function buildNavItems(session: NonNullable<SessionResponse["user"]>) {
  const items = [...baseNavItems];
  if (contestPermissions.some((name) => session.permissions.includes(name))) {
    items.push({ to: "/contests", label: "组题", icon: ListChecks });
  }
  if (transferPermissions.some((name) => session.permissions.includes(name))) {
    items.push({ to: "/transfer", label: "导入导出", icon: ArrowLeftRight });
  }
  return { items, showManagement: canOpenAdmin(session) };
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
  const [mobileNavigationOpen, setMobileNavigationOpen] = useState(false);
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
        <div className="global-header-inner">
          <NavLink className="brand" to="/problems" aria-label="Urmotiv 题目">
            <span className="brand-mark">U</span>
            <span>Urmotiv</span>
          </NavLink>
          <button
            type="button"
            className="mobile-nav-toggle"
            aria-label={mobileNavigationOpen ? "关闭导航" : "打开导航"}
            aria-expanded={mobileNavigationOpen}
            onClick={() => setMobileNavigationOpen((open) => !open)}
          >
            {mobileNavigationOpen ? <X size={20} aria-hidden="true" /> : <Menu size={20} aria-hidden="true" />}
          </button>
          <nav className={`global-nav${mobileNavigationOpen ? " open" : ""}`} aria-label="主导航">
            {navItems.map(({ to, label, icon: Icon }) => (
              <NavLink
                key={to}
                to={to}
                onClick={() => setMobileNavigationOpen(false)}
                className={({ isActive }) => (isActive ? "active" : "")}
              >
                <Icon size={16} aria-hidden="true" />
                <span>{label}</span>
              </NavLink>
            ))}
            {showManagement ? (
              <NavLink
                to="/admin"
                onClick={() => setMobileNavigationOpen(false)}
                className={({ isActive }) => (isActive ? "active" : "")}
              >
                <Settings size={16} aria-hidden="true" />
                <span>管理</span>
              </NavLink>
            ) : null}
          </nav>
          <details className="user-menu">
            <summary aria-label="打开账号菜单">
              <HeaderAvatar user={session} />
              <span className="user-menu-name">{session.nickname}</span>
              <ChevronDown size={15} aria-hidden="true" />
            </summary>
            <div className="user-menu-popover">
              <div className="user-menu-identity">
                <strong>{session.nickname}</strong>
                <span>用户 #{session.id}</span>
              </div>
              <NavLink to="/profile">
                <UserRound size={16} aria-hidden="true" />
                个人资料
              </NavLink>
              {showManagement ? (
                <NavLink to="/admin">
                  <Settings size={16} aria-hidden="true" />
                  控制面板
                </NavLink>
              ) : null}
              {demoEnabled ? <NavLink to="/demo-login">切换演示账号</NavLink> : null}
              <button type="button" onClick={() => signOut.mutate()} disabled={signOut.isPending}>
                <LogOut size={16} aria-hidden="true" />
                {signOut.isPending ? "正在退出…" : "退出登录"}
              </button>
            </div>
          </details>
        </div>
      </header>
      <main id="main-content" className="main-content" tabIndex={-1}>{children}</main>
    </div>
  );
}
