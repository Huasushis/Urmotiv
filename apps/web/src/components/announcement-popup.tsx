import { useEffect, useRef } from "react";
import { Link } from "react-router-dom";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { Announcement } from "@urmotiv/contracts";
import { readAnnouncement } from "../lib/api";
import { MarkdownPreview } from "./markdown-editor";
export function AnnouncementPopup({
  item,
  onClose,
}: {
  item: Announcement;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null),
    client = useQueryClient();
  useEffect(() => {
    const dialog = ref.current;
    dialog?.showModal();
    return () => dialog?.close();
  }, []);
  const read = useMutation({
    mutationFn: () => readAnnouncement(item.id, item.revision),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: ["announcements"] });
      onClose();
    },
  });
  return (
    <dialog
      ref={ref}
      className="announcement-dialog"
      aria-labelledby="announcement-title"
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
    >
      <header>
        <h2 id="announcement-title">{item.title}</h2>
        <time>{new Date(item.updatedAt).toLocaleDateString("zh-CN")}</time>
      </header>
      <div className="announcement-body">
        <MarkdownPreview value={item.body} />
      </div>
      {read.error ? <p role="alert">{read.error.message}</p> : null}
      <footer>
        <Link to="/notifications" onClick={onClose}>
          全部通知
        </Link>
        <div className="admin-actions">
          <button className="secondary-button" onClick={onClose}>
            稍后阅读
          </button>
          <button
            className="primary-button"
            disabled={read.isPending}
            onClick={() => read.mutate()}
          >
            我知道了
          </button>
        </div>
      </footer>
    </dialog>
  );
}
