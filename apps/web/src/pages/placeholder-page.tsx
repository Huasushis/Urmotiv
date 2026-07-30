import type { LucideIcon } from "lucide-react";

type PlaceholderPageProps = {
  icon: LucideIcon;
  eyebrow: string;
  title: string;
  description: string;
  details: string[];
};

export function PlaceholderPage({ icon: Icon, eyebrow, title, description, details }: PlaceholderPageProps) {
  return (
    <section className="placeholder-page">
      <div className="page-heading">
        <div>
          <p className="eyebrow">{eyebrow}</p>
          <h1>{title}</h1>
          <p>{description}</p>
        </div>
        <Icon className="page-heading-icon" size={32} aria-hidden="true" />
      </div>
      <div className="plain-panel">
        <h2>这一页会围绕以下信息工作</h2>
        <ul className="plain-list">
          {details.map((detail) => (
            <li key={detail}>{detail}</li>
          ))}
        </ul>
      </div>
    </section>
  );
}
