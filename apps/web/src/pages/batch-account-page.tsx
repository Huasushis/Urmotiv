import { useMutation, useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { ApiError, createBatchAccounts, getSession } from "../lib/api";

function lineLabel(field: string): string {
  const match = /^lines\.(\d+)$/u.exec(field);
  return match === null ? "输入内容" : `第 ${match[1]} 行`;
}

export function BatchAccountPage() {
  const session = useQuery({ queryKey: ["session"], queryFn: getSession, staleTime: 60_000 });
  const [text, setText] = useState("");
  const create = useMutation({
    mutationFn: () => createBatchAccounts(text),
    onSuccess: () => setText("")
  });
  const canCreateAccounts = session.data?.user?.permissions.includes("user.create") ?? false;
  const sessionReady = session.status !== "pending";
  const apiError = create.error instanceof ApiError ? create.error : undefined;

  if (sessionReady && !canCreateAccounts) {
    return (
      <section className="admin-no-access">
        <div className="page-heading">
          <div>
            <p className="eyebrow">账号管理</p>
            <h1>批量创建账号</h1>
          </div>
        </div>
        <div className="plain-panel">
          <h2>没有访问权限</h2>
          <p>当前账号没有创建账号的权限。</p>
        </div>
      </section>
    );
  }

  return (
    <section className="batch-account-page">
      <div className="page-heading">
        <div>
          <p className="eyebrow">账号管理</p>
          <h1>批量创建账号</h1>
          <p>为已有成员一次创建多个登录账号。服务端会先完整检查整批内容，失败时不会创建任何账号。</p>
        </div>
      </div>

      <form
        className="plain-panel"
        onSubmit={(event) => {
          event.preventDefault();
          create.mutate();
        }}
      >
        <div className="field wide">
          <label htmlFor="batch-account-input">账号内容</label>
          <textarea
            id="batch-account-input"
            data-testid="batch-account-input"
            aria-label="批量账号内容"
            autoComplete="off"
            spellCheck={false}
            rows={12}
            value={text}
            onChange={(event) => {
              create.reset();
              setText(event.target.value);
            }}
          />
          <p className="field-help">
            每个非空行使用 Tab 分隔四列：用户名（可留空）、昵称、邮箱、密码。密码会按原样处理，空行会忽略；每批最多 100 行。创建成功后只显示数量，不会再次显示或返回密码。
          </p>
        </div>

        {create.isSuccess ? (
          <p className="notice-line" role="status">
            已创建 {create.data.createdCount} 个账号。
          </p>
        ) : null}
        {create.error ? (
          <div className="inline-error" role="alert">
            <p>{apiError?.message ?? "账号创建失败，请稍后重试。"}</p>
            {apiError?.fieldErrors !== undefined ? (
              <ul>
                {Object.entries(apiError.fieldErrors).map(([field, messages]) => (
                  <li key={field}>
                    {lineLabel(field)}：{messages.join(" ")}
                  </li>
                ))}
              </ul>
            ) : null}
          </div>
        ) : null}

        <div className="sticky-form-actions">
          <button className="primary-button" type="submit" disabled={create.isPending}>
            {create.isPending ? "正在创建…" : "创建账号"}
          </button>
        </div>
      </form>
    </section>
  );
}
