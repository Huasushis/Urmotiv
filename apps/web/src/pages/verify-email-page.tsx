import { useMutation } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { verifyEmail } from "../lib/api";

export function VerifyEmailPage({ token }: { token: string | undefined }) {
  const navigate = useNavigate();
  const verification = useMutation({
    mutationFn: () => {
      if (token === undefined) {
        return Promise.reject(new Error("验证链接不完整，请重新申请验证邮件。"));
      }
      return verifyEmail(token);
    },
    onSuccess: () => {
      window.history.replaceState(null, "", "/login");
      navigate("/login", { replace: true });
    }
  });
  return (
    <main className="centered-message">
      <section className="plain-panel verification-panel">
        <p className="eyebrow">邮箱验证</p>
        <h1>确认邮箱后再登录</h1>
        <p>验证链接只可使用一次，完成后请回到登录页使用邮箱和密码登录。</p>
        <button type="button" className="primary-button" onClick={() => verification.mutate()} disabled={verification.isPending || token === undefined}>
          {verification.isPending ? "正在验证…" : "确认邮箱"}
        </button>
        {verification.isSuccess ? <p className="notice-line">验证完成，正在回到登录页。</p> : null}
        {verification.error ? <p className="form-error">{verification.error.message}</p> : null}
      </section>
    </main>
  );
}
