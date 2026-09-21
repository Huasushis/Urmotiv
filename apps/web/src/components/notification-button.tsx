import { Bell, BookOpen } from "lucide-react";
import { lazy, Suspense, useState } from "react";
import { Link, useLocation } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { listAnnouncements } from "../lib/api";
const Popup = lazy(() =>
  import("./announcement-popup").then((m) => ({
    default: m.AnnouncementPopup,
  })),
);
export function NotificationButton({ userId }: { userId: string }) {
  const [dismissed, setDismissed] = useState(false),
    location = useLocation();
  const feed = useQuery({
    queryKey: ["announcements", userId, "popup"],
    queryFn: () => listAnnouncements(1, false, true),
    staleTime: 60000,
    retry: false,
  });
  const first = feed.data?.items[0];
  return (
    <div className="header-utilities">
      <Link
        to="/guide"
        className="icon-button"
        aria-label="使用文档"
        title="使用文档"
      >
        <BookOpen size={19} />
      </Link>
      <Link
        to="/notifications"
        className="icon-button notification-button"
        aria-label={`全部通知${feed.data?.unread ? `，${feed.data.unread} 条未读` : ""}`}
        title="全部通知"
      >
        <Bell size={19} />
        {feed.data?.unread ? <span className="notification-dot" /> : null}
      </Link>
      {!dismissed &&
      first &&
      ["/", "/problems", "/submissions", "/reviews", "/leaderboard"].includes(
        location.pathname,
      ) ? (
        <Suspense fallback={null}>
          <Popup item={first} onClose={() => setDismissed(true)} />
        </Suspense>
      ) : null}
    </div>
  );
}
