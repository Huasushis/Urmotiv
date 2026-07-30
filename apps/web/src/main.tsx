import "katex/dist/katex.min.css";
import "./styles.css";
import { QueryClient, QueryClientProvider, useQuery } from "@tanstack/react-query";
import { Settings } from "lucide-react";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter, Navigate, Route, Routes, useLocation } from "react-router-dom";
import { AppShell } from "./components/app-shell";
import { ApiError, getSession } from "./lib/api";
import { DemoLoginPage } from "./pages/demo-login-page";
import { PlaceholderPage } from "./pages/placeholder-page";
import { CreateProblemPage } from "./pages/create-problem-page";
import { ContestPage } from "./pages/contest-page";
import { ProblemListPage } from "./pages/problem-list-page";
import { ProblemWorkspacePage } from "./pages/problem-workspace-page";
import { TransferPage } from "./pages/transfer-page";
import { VerifyEmailPage } from "./pages/verify-email-page";

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
        <Route path="/problems/:problemId" element={<ProblemWorkspacePage />} />
        <Route path="/submissions" element={<ProblemListPage ownOnly />} />
        <Route path="/reviews" element={<ProblemListPage fixedStatus="pending_review" />} />
        <Route path="/contests" element={<ContestPage />} />
        <Route path="/transfer" element={<TransferPage />} />
        <Route
          path="/admin"
          element={
            <PlaceholderPage
              icon={Settings}
              eyebrow="管理"
              title="站点管理"
              description="账号、权限和插件设置都由服务端再次确认，页面上的隐藏按钮不是权限控制。"
              details={["管理知识点和成员时保留审计记录", "机器人不能取得固定禁止的操作", "密钥只显示是否配置，不在页面返回完整值"]}
            />
          }
        />
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
