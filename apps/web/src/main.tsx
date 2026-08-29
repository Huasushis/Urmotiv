import "katex/dist/katex.min.css";
import "./styles.css";
import { QueryClient, QueryClientProvider, useQuery } from "@tanstack/react-query";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter, Navigate, Route, Routes, useLocation } from "react-router-dom";
import { AppShell } from "./components/app-shell";
import { ApiError, getSession } from "./lib/api";
import { AdminPage } from "./pages/admin-page";
import { DemoLoginPage } from "./pages/demo-login-page";
import { CreateProblemPage } from "./pages/create-problem-page";
import { ContestPage } from "./pages/contest-page";
import { ProblemListPage } from "./pages/problem-list-page";
import { ProblemWorkspacePage } from "./pages/problem-workspace-page";
import { ProfilePage } from "./pages/profile-page";
import { BatchAccountPage } from "./pages/batch-account-page";
import { TransferPage } from "./pages/transfer-page";
import { VerifyEmailPage } from "./pages/verify-email-page";

import { AdminSectionPage } from "./pages/admin-section-page";
const queryClient = new QueryClient({
  defaultOptions: {
    queries: { retry: 1, refetchOnWindowFocus: false }
  }
});

function App() {
  const location = useLocation();
  const session = useQuery({ queryKey: ["session"], queryFn: getSession, staleTime: 60_000 });
  const verificationToken = readVerificationToken(window.location.hash);

  if (verificationToken !== null) {
    return <VerifyEmailPage token={verificationToken || undefined} />;
  }

  if (location.pathname === "/login" || location.pathname === "/demo-login") {
    return <DemoLoginPage existingSession={session.data} />;
  }

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
    <AppShell session={sessionData.user} demoEnabled={sessionData.auth.demoEnabled}>
      <Routes>
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
        <Route path="/admin/accounts" element={<BatchAccountPage />} />
        <Route path="/admin/settings" element={<AdminSectionPage section="settings" session={sessionData.user} />} />
        <Route path="/admin/roles" element={<AdminSectionPage section="roles" session={sessionData.user} />} />
        <Route path="/admin/service-accounts" element={<AdminSectionPage section="service-accounts" session={sessionData.user} />} />
        <Route path="/admin/audit" element={<AdminSectionPage section="audit" session={sessionData.user} />} />
        <Route path="/admin/fermata" element={<AdminSectionPage section="fermata" session={sessionData.user} />} />
        <Route path="/admin/oauth" element={<AdminSectionPage section="oauth" session={sessionData.user} />} />
        <Route path="/admin/plugins" element={<AdminSectionPage section="plugins" session={sessionData.user} />} />
        <Route path="/admin/knowledge" element={<AdminSectionPage section="knowledge" session={sessionData.user} />} />
        <Route path="/admin/imports" element={<AdminSectionPage section="imports" session={sessionData.user} />} />
        <Route path="/admin" element={<AdminPage session={sessionData.user} />} />
        <Route path="*" element={<Navigate to="/problems" replace />} />
      </Routes>
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
      </BrowserRouter>
    </QueryClientProvider>
  </StrictMode>
);
