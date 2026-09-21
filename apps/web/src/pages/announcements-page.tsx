import { useState } from "react";
import { Link } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronLeft, ChevronRight, Plus, Pin, Save } from "lucide-react";
import type {
  Announcement,
  AnnouncementInput,
  SessionUser,
} from "@urmotiv/contracts";
import {
  announcementRoles,
  listAnnouncements,
  readAnnouncement,
  saveAnnouncement,
} from "../lib/api";
import { AdminLayout } from "../components/admin-layout";
import { MarkdownEditor, MarkdownPreview } from "../components/markdown-editor";
const empty: AnnouncementInput = {
  title: "",
  body: "",
  audience: "newcomers",
  roleIds: [],
  newcomerDays: 30,
  pinned: false,
  popup: true,
  published: false,
};
export function AnnouncementsPage({
  session,
  manage = false,
}: {
  session: SessionUser;
  manage?: boolean;
}) {
  const allowed =
    !manage || session.permissions.includes("announcement.manage");
  const [page, setPage] = useState(1),
    [draft, setDraft] = useState<AnnouncementInput | null>(null),
    [editing, setEditing] = useState<Announcement | null>(null);
  const client = useQueryClient();
  const feed = useQuery({
    queryKey: ["announcements", session.id, manage, page],
    queryFn: () => listAnnouncements(page, manage),
    enabled: allowed,
    retry: false,
  });
  const roles = useQuery({
    queryKey: ["announcement-roles", session.id],
    queryFn: announcementRoles,
    enabled: allowed && manage,
  });
  const save = useMutation({
    mutationFn: () => saveAnnouncement(draft!, editing?.id, editing?.revision),
    onSuccess: () => {
      setDraft(null);
      setEditing(null);
      void client.invalidateQueries({ queryKey: ["announcements"] });
    },
  });
  const read = useMutation({
    mutationFn: (item: Announcement) =>
      readAnnouncement(item.id, item.revision),
    onSuccess: () =>
      void client.invalidateQueries({ queryKey: ["announcements"] }),
  });
  const content = (
    <>
      {!allowed ? (
        <p role="alert">公告管理不存在或当前账号不能访问。</p>
      ) : (
        <>
          <div className="announcement-heading">
            <p>
              {manage
                ? "已发布的公告可撤回为草稿，修改后接收人会看到新版本。"
                : "公告与使用提醒"}{" "}
              · <Link to="/guide">使用文档</Link>
            </p>
            {manage ? (
              <button
                className="primary-button"
                onClick={() => {
                  setEditing(null);
                  setDraft({ ...empty });
                  save.reset();
                }}
              >
                <Plus size={16} />
                发布公告
              </button>
            ) : null}
          </div>
          {draft ? (
            <form
              className="announcement-editor"
              onSubmit={(event) => {
                event.preventDefault();
                save.mutate();
              }}
            >
              <label className="field">
                标题
                <input
                  value={draft.title}
                  maxLength={160}
                  required
                  onChange={(event) =>
                    setDraft({ ...draft, title: event.target.value })
                  }
                />
              </label>
              <MarkdownEditor
                label="公告内容"
                value={draft.body}
                onChange={(body) => setDraft({ ...draft, body })}
                minRows={8}
              />
              <div className="form-grid">
                <label className="field">
                  接收人群
                  <select
                    value={draft.audience}
                    onChange={(event) =>
                      setDraft({
                        ...draft,
                        audience: event.target
                          .value as AnnouncementInput["audience"],
                      })
                    }
                  >
                    <option value="newcomers">新人</option>
                    <option value="all">所有登录用户</option>
                    <option value="roles">指定权限组</option>
                  </select>
                </label>
                {draft.audience === "newcomers" ? (
                  <label className="field">
                    注册时间不超过（天）
                    <input
                      type="number"
                      min={1}
                      max={365}
                      value={draft.newcomerDays}
                      onChange={(event) =>
                        setDraft({
                          ...draft,
                          newcomerDays: Number(event.target.value),
                        })
                      }
                    />
                  </label>
                ) : null}
              </div>
              {draft.audience === "roles" ? (
                <fieldset>
                  <legend>接收权限组</legend>
                  {roles.data?.items.map((role) => (
                    <label className="checkbox-row" key={role.id}>
                      <input
                        type="checkbox"
                        checked={draft.roleIds.includes(role.id)}
                        onChange={(event) =>
                          setDraft({
                            ...draft,
                            roleIds: event.target.checked
                              ? [...draft.roleIds, role.id]
                              : draft.roleIds.filter((id) => id !== role.id),
                          })
                        }
                      />
                      {role.name}
                    </label>
                  ))}
                  {roles.error ? (
                    <p role="alert">{roles.error.message}</p>
                  ) : null}
                </fieldset>
              ) : null}
              <div className="announcement-toggles">
                {(
                  [
                    ["pinned", "置顶"],
                    ["popup", "未读时弹窗"],
                    ["published", "立即发布"],
                  ] as const
                ).map(([key, label]) => (
                  <label className="checkbox-row" key={key}>
                    <input
                      type="checkbox"
                      checked={draft[key]}
                      onChange={(event) =>
                        setDraft({ ...draft, [key]: event.target.checked })
                      }
                    />
                    {label}
                  </label>
                ))}
              </div>
              <div className="admin-actions">
                <button
                  type="button"
                  className="secondary-button"
                  onClick={() => setDraft(null)}
                >
                  取消
                </button>
                <button
                  className="primary-button"
                  disabled={save.isPending || !draft.body.trim()}
                >
                  <Save size={16} />
                  保存公告
                </button>
              </div>
              {save.error ? <p role="alert">{save.error.message}</p> : null}
            </form>
          ) : null}
          {feed.isPending ? (
            <p role="status">正在读取公告…</p>
          ) : feed.error ? (
            <p role="alert">{feed.error.message}</p>
          ) : feed.data?.items.length === 0 ? (
            <p className="empty-preview">暂无通知</p>
          ) : null}
          <div className="announcement-list">
            {feed.data?.items.map((item) => (
              <article className="announcement-item" key={item.id}>
                <header>
                  <h2>
                    {item.pinned ? <Pin size={16} aria-label="置顶" /> : null}
                    {item.title}
                  </h2>
                  <time>
                    {new Date(item.updatedAt).toLocaleString("zh-CN")}
                  </time>
                </header>
                <MarkdownPreview value={item.body} />
                <footer>
                  {manage ? (
                    <>
                      <span>
                        {item.published ? "已发布" : "草稿"} ·{" "}
                        {item.audience === "all"
                          ? "所有登录用户"
                          : item.audience === "newcomers"
                            ? "新人"
                            : "指定权限组"}
                      </span>
                      <button
                        className="secondary-button"
                        onClick={() => {
                          setEditing(item);
                          setDraft({
                            title: item.title,
                            body: item.body,
                            audience: item.audience,
                            roleIds: item.roleIds,
                            newcomerDays: item.newcomerDays,
                            pinned: item.pinned,
                            popup: item.popup,
                            published: item.published,
                          });
                          save.reset();
                          scrollTo(0, 0);
                        }}
                      >
                        编辑公告
                      </button>
                    </>
                  ) : item.read ? (
                    <span>已读</span>
                  ) : (
                    <button
                      className="secondary-button"
                      disabled={read.isPending}
                      onClick={() => read.mutate(item)}
                    >
                      标记已读
                    </button>
                  )}
                </footer>
              </article>
            ))}
          </div>
          {read.error ? <p role="alert">{read.error.message}</p> : null}
          <nav className="announcement-pagination" aria-label="公告分页">
            <button
              className="icon-button"
              title="上一页"
              aria-label="上一页"
              disabled={page === 1}
              onClick={() => setPage(page - 1)}
            >
              <ChevronLeft size={18} />
            </button>
            <span>
              第 {page} 页 · {feed.data?.total ?? 0} 条
            </span>
            <button
              className="icon-button"
              title="下一页"
              aria-label="下一页"
              disabled={page * 20 >= (feed.data?.total ?? 0)}
              onClick={() => setPage(page + 1)}
            >
              <ChevronRight size={18} />
            </button>
          </nav>
        </>
      )}
    </>
  );
  return manage ? (
    <AdminLayout session={session} title="公告管理">
      {content}
    </AdminLayout>
  ) : (
    <section className="notifications-page">
      <h1>全部通知</h1>
      {content}
    </section>
  );
}
