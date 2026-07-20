import type { LucideIcon } from "lucide-react";

interface StatCardProps {
  icon: LucideIcon;
  label: string;
  value: string;
  sub?: string;
  accent?: boolean;
  iconTone?: "amber" | "violet";
}

// Prezentacyjny odpowiednik markupu `module-stat-card` (identyczny dziś w Pets/Car/Meals/
// Subscriptions, patrz docs/plans/podzial-duzych-stron.md "Jedyna wspólna ekstrakcja: StatCard").
export function StatCard({ icon: Icon, label, value, sub, accent, iconTone }: StatCardProps) {
  return (
    <article className={`module-stat-card${accent ? " module-stat-card--accent" : ""}`}>
      <span
        className={`module-stat-card__icon${iconTone ? ` module-stat-card__icon--${iconTone}` : ""}`}
      >
        <Icon size={19} />
      </span>
      <div>
        <span>{label}</span>
        <strong>{value}</strong>
        {sub && <small>{sub}</small>}
      </div>
    </article>
  );
}
