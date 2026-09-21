import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import type { EmailNotificationPreferences } from "@urmotiv/contracts";
import { getEmailNotifications, saveEmailNotifications } from "../lib/api";

export function EmailNotificationsPanel() {
  const client = useQueryClient();
  const settings = useQuery({
    queryKey: ["email-notifications"],
    queryFn: getEmailNotifications,
    retry: false,
  });
  const save = useMutation({
    mutationFn: saveEmailNotifications,
    onSuccess: (value) => client.setQueryData(["email-notifications"], value),
  });
  const labels: Record<keyof EmailNotificationPreferences, string> = {
    newReview: "收到新审核意见（包括 AI 审题）",
    approved: "题目审核通过",
    rejected: "题目审核不通过",
  };
  return (
    <section
      className="plain-panel account-security-panel"
      aria-labelledby="email-notification-title"
    >
      <h2 id="email-notification-title">邮件通知</h2>
      <p className="muted-note">
        默认开启，发送到已验证的联系邮箱。邮件只含状态摘要和站内链接；你可以分别关闭，不影响站内审核记录。
      </p>
      {settings.isPending ? (
        <p role="status">正在读取通知设置…</p>
      ) : settings.error ? (
        <p role="alert">
          无法读取通知设置。
          <button
            className="secondary-button"
            onClick={() => void settings.refetch()}
          >
            重试
          </button>
        </p>
      ) : settings.data ? (
        <div className="email-notification-options">
          {(Object.keys(labels) as (keyof EmailNotificationPreferences)[]).map(
            (key) => (
              <label className="checkbox-label" key={key}>
                <input
                  type="checkbox"
                  checked={(save.isPending ? save.variables : settings.data)?.[key] ?? settings.data[key]}
                  disabled={save.isPending}
                  onChange={(event) =>
                    save.mutate({
                      ...settings.data!,
                      [key]: event.target.checked,
                    })
                  }
                />
                {labels[key]}
              </label>
            ),
          )}
        </div>
      ) : null}
      {save.error ? (
        <p role="alert">保存失败，原设置保持不变，请重试。</p>
      ) : save.isSuccess ? (
        <p className="muted-note" role="status">
          通知设置已保存。
        </p>
      ) : null}
    </section>
  );
}
