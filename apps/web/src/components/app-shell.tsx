import {
  ArrowLeftRight,
  BookOpen,
  ClipboardCheck,
  FilePenLine,
  ListChecks,
  Settings
} from "lucide-react";
import type { ReactNode } from "react";
import { NavLink } from "react-router-dom";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { SessionResponse } from "@urmotiv/contracts";
import { logout } from "../lib/api";

type AppShellProps = {
  session: NonNullable<SessionResponse["user"]>;
  demoEnabled: boolean;
  children: ReactNode;
};

const baseNavItems = [
  { to: "/problems", label: "题目", icon: BookOpen },
  { to: "/submissions", label: "我的投稿", icon: FilePenLine },
  { to: "/reviews", label: "待审", icon: ClipboardCheck },
  { to: "/contests", label: "组题", icon: ListChecks },
  { to: "/transfer", label: "导入导出", icon: ArrowLeftRight }
];

export function AppShell({ session, demoEnabled, children }: AppShellProps) {
  const navItems = session.canManageReviewPolicy || session.canManagePlugins
    ? [...baseNavItems, { to: "/admin", label: "管理", icon: Settings }]
    : baseNavItems;
  const client = useQueryClient();
  const signOut = useMutation({
    mutationFn: logout,
    onSuccess: () => {
      client.removeQueries({
        predicate: (query) => query.queryKey[0] !== "session"
      });
      client.getMutationCache().clear();
      void client.resetQueries({ queryKey: ["session"], exact: true });
    }
  });
  return (
    <div className="app-shell">
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
        </nav>
        <div className="user-context">
          <div className="user-name">
            <strong>{session.nickname}</strong>
            <span>{session.roles.join("、") || "已登录"}</span>
          </div>
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
      <main className="main-content">{children}</main>
    </div>
  );
}
