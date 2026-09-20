import { Code2 } from "lucide-react";

export function SiteFooter() {
  return (
    <footer className="site-footer">
      <span>用 Urmotiv 编写下一道好题</span>
      <a
        href="https://github.com/Huasushis/Urmotiv"
        target="_blank"
        rel="noopener noreferrer"
      >
        <Code2 size={16} aria-hidden="true" />在 GitHub 查看项目
      </a>
    </footer>
  );
}
