import "./styles.css";
import { QueryClient, QueryClientProvider, useQuery } from "@tanstack/react-query";
import { StrictMode, Suspense, lazy, useEffect } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter, Navigate, Route, Routes, useLocation } from "react-router-dom";
import { AppShell } from "./components/app-shell";
import { SiteFooter } from "./components/site-footer";
import { ApiError, getSession } from "./lib/api";
import { DemoLoginPage } from "./pages/demo-login-page";
import { ProblemListPage } from "./pages/problem-list-page";
import { ProfilePage } from "./pages/profile-page";
import { VerifyEmailPage } from "./pages/verify-email-page";
import { LeaderboardPage } from "./pages/leaderboard-page";
import { AccountActionPage, PasswordRecoveryPage } from "./pages/account-recovery-page";

import { PageLoadBoundary } from "./components/page-load-boundary";

const loaders = {
  guide:()=>import('./pages/guide-page'),
  announcements:()=>import('./pages/announcements-page'),
  backup: () => import("./pages/backup-page"),
  admin: () => import("./pages/admin-page"),
  create: () => import("./pages/create-problem-page"),
  contest: () => import("./pages/contest-page"),
  workspace: () => import("./pages/problem-workspace-page"),
  batch: () => import("./pages/batch-account-page"),
  transfer: () => import("./pages/transfer-page"),
  fermata: () => import("./pages/fermata-admin-page"),
  section: () => import("./pages/admin-section-page"),
  permissions: () => import("./pages/admin-permissions-page")
};
const AdminPage=lazy(()=>loaders.admin().then(m=>({default:m.AdminPage})));
const GuidePage=lazy(()=>loaders.guide().then(m=>({default:m.GuidePage})));
const AnnouncementsPage=lazy(()=>loaders.announcements().then(m=>({default:m.AnnouncementsPage})));
const BackupPage=lazy(()=>loaders.backup().then(m=>({default:m.BackupPage})));
const CreateProblemPage=lazy(()=>loaders.create().then(m=>({default:m.CreateProblemPage})));
const ContestPage=lazy(()=>loaders.contest().then(m=>({default:m.ContestPage})));
const ProblemWorkspacePage=lazy(()=>loaders.workspace().then(m=>({default:m.ProblemWorkspacePage})));
const BatchAccountPage=lazy(()=>loaders.batch().then(m=>({default:m.BatchAccountPage})));
const TransferPage=lazy(()=>loaders.transfer().then(m=>({default:m.TransferPage})));
const FermataAdminPage=lazy(()=>loaders.fermata().then(m=>({default:m.FermataAdminPage})));
const AdminSectionPage=lazy(()=>loaders.section().then(m=>({default:m.AdminSectionPage})));
const AdminPermissionsPage=lazy(()=>loaders.permissions().then(m=>({default:m.AdminPermissionsPage})));

function loadRoute(path:string):Promise<unknown>|undefined {
  if(path==='/guide')return loaders.guide();
  if(path==='/notifications'||path==='/admin/announcements')return loaders.announcements();
  if(path==='/admin/backups')return loaders.backup();
  if(path==='/problems/new')return loaders.create();
  if(/^\/problems\/[^/]+$/.test(path))return loaders.workspace();
  if(path==='/contests')return loaders.contest();
  if(path==='/transfer')return loaders.transfer();
  if(path==='/admin/accounts')return loaders.batch();
  if(path==='/admin/fermata')return loaders.fermata();
  if(/^\/admin\/(users|roles)(\/|$)/.test(path))return loaders.permissions();
  if(/^\/admin\/(settings|service-accounts|audit|oauth|imports)$/.test(path))return loaders.section();
  if(path.startsWith('/admin')&&path!=='/admin/problems')return loaders.admin();
}
const queryClient = new QueryClient({
  defaultOptions: {
    queries: { retry: 1, refetchOnWindowFocus: false }
  }
});

function App() {
  const location = useLocation();
  const session = useQuery({ queryKey: ["session"], queryFn: getSession, staleTime: 60_000 });
  useEffect(()=>{void loadRoute(location.pathname)?.catch(()=>undefined);},[location.pathname]);
  const verificationToken = readVerificationToken(window.location.hash);

  const actionMatch = /^#\/(reset-password|change-email)(?:\?|$)/.exec(window.location.hash);
  if (actionMatch) {
    const token = new URLSearchParams(window.location.hash.split("?")[1] ?? "").get("token") ?? "";
    return <AccountActionPage purpose={actionMatch[1] === "reset-password" ? "password-reset" : "email-change"} token={token} />;
  }
  if (location.pathname === "/forgot-password") return <PasswordRecoveryPage />;

  if (verificationToken !== null) {
    return <VerifyEmailPage token={verificationToken || undefined} />;
  }

  if (location.pathname === "/login" || location.pathname === "/demo-login") {
    return <DemoLoginPage existingSession={session.data} />;
  }

  if (location.pathname === "/leaderboard" && !session.data?.user) {
    return <LeaderboardPage publicView />;
  }
  if(location.pathname==='/guide'&&!session.data?.user)return <Suspense fallback={<p role="status">正在读取文档…</p>}><GuidePage/></Suspense>;

  if (session.isLoading) {
    return <div className="centered-message">正在确认登录状态…</div>;
  }
  if (session.isError) {
    if (session.error instanceof ApiError && session.error.status === 401) {
      return <Navigate to="/login" replace />;
    }
    return (
      <div className="centered-message error-message">
        <h1>暂时无法连接服务端</h1>
        <p>{session.error.message}</p>
        <p>请通过 SSH 转发访问服务端，或在专用演示环境设置 VITE_DEMO_FALLBACK=true。</p>
      </div>
    );
  }

  const sessionData = session.data;
  if (!sessionData) {
    return <div className="centered-message">正在确认登录状态…</div>;
  }

  if (!sessionData.user) {
    return <Navigate to="/login" replace />;
  }

  return (
    <AppShell session={sessionData.user} identity={sessionData.identity} demoEnabled={sessionData.auth.demoEnabled}>
      <PageLoadBoundary key={location.pathname}><Suspense fallback={<p className="centered-message" role="status">正在加载页面…</p>}><Routes>
        <Route path="/" element={<Navigate to="/problems" replace />} />
        <Route path="/problems" element={<ProblemListPage />} />
        <Route path="/problems/new" element={<CreateProblemPage />} />
        <Route
          path="/problems/:problemId"
          element={
            <ProblemWorkspacePage
              key={sessionData.user.id}
              currentUserId={sessionData.user.id}
            />
          }
        />
        <Route path="/submissions" element={<ProblemListPage ownOnly />} />
        <Route path="/reviews" element={<ProblemListPage fixedStatus="pending_review" />} />
        <Route path="/contests" element={<ContestPage />} />
        <Route path="/transfer" element={<TransferPage />} />
        <Route path="/profile" element={<ProfilePage />} />
        <Route path="/guide" element={<GuidePage/>} />
        <Route path="/notifications" element={<AnnouncementsPage session={sessionData.user}/>} />
        <Route path="/admin/announcements" element={<AnnouncementsPage session={sessionData.user} manage/>} />
        <Route path="/leaderboard" element={<LeaderboardPage />} />
        <Route path="/admin/accounts" element={<BatchAccountPage />} />
        <Route path="/admin/problems" element={<ProblemListPage managementSession={sessionData.user} />} />
        <Route path="/admin/settings" element={<AdminSectionPage section="settings" session={sessionData.user} />} />
        <Route path="/admin/backups" element={<BackupPage session={sessionData.user} />} />
        <Route path="/admin/users" element={<AdminPermissionsPage section="users" session={sessionData.user} />} />
        <Route path="/admin/roles" element={<AdminPermissionsPage section="roles" session={sessionData.user} />} />
        <Route path="/admin/roles/defaults" element={<AdminPermissionsPage section="defaults" session={sessionData.user} />} />
        <Route path="/admin/service-accounts" element={<AdminSectionPage section="service-accounts" session={sessionData.user} />} />
        <Route path="/admin/audit" element={<AdminSectionPage section="audit" session={sessionData.user} />} />
        <Route path="/admin/oauth" element={<AdminSectionPage section="oauth" session={sessionData.user} />} />
        <Route path="/admin/review" element={<AdminPage section="review" session={sessionData.user} />} />
        <Route path="/admin/plugins" element={<AdminPage section="plugins" session={sessionData.user} />} />
        <Route path="/admin/fermata" element={<FermataAdminPage session={sessionData.user} />} />
        <Route path="/admin/knowledge" element={<AdminPage section="knowledge" session={sessionData.user} />} />
        <Route path="/admin/imports" element={<AdminSectionPage section="imports" session={sessionData.user} />} />
        <Route path="/admin" element={<AdminPage session={sessionData.user} />} />
        <Route path="*" element={<Navigate to="/problems" replace />} />
      </Routes></Suspense></PageLoadBoundary>
    </AppShell>
  );
}

function readVerificationToken(hash: string): string | null {
  if (!hash.startsWith("#/verify-email")) {
    return null;
  }
  const queryStart = hash.indexOf("?");
  if (queryStart < 0) {
    return "";
  }
  return new URLSearchParams(hash.slice(queryStart + 1)).get("token") ?? "";
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <App />
        <SiteFooter />
      </BrowserRouter>
    </QueryClientProvider>
  </StrictMode>
);
