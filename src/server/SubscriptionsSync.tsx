import type { ReactNode } from "react";
import { Cloud, CloudOff, LoaderCircle } from "lucide-react";
import { useSubscriptionsSync } from "../hooks/useSubscriptionsSync";
import "../styles/server.css";

// Montowany wewnątrz HealthSync w src/server/AuthGate.tsx — patrz docs/plans/subskrypcje-sql.md
// ("Montaż"). Provider jest NIEBLOKUJĄCY: renderuje dzieci od razu (Subskrypcje to jedna
// podstrona, nie blokujemy całej apki na jej hydratację) — SubscriptionsPage czyta gotowość
// bezpośrednio ze stanu useSubscriptionsStore (pusta tablica, dopóki hydratacja nie dotrze).
export function SubscriptionsSync({
  children,
  onSessionExpired,
}: {
  children: ReactNode;
  onSessionExpired: () => void;
}) {
  const { syncState } = useSubscriptionsSync(onSessionExpired);

  return (
    <>
      {children}
      <div
        className={`sync-indicator sync-indicator--subscriptions sync-indicator--${syncState}`}
        role="status"
      >
        {syncState === "saving" ? (
          <LoaderCircle size={13} className="spin" />
        ) : syncState === "offline" ? (
          <CloudOff size={13} />
        ) : (
          <Cloud size={13} />
        )}
        {syncState === "saving"
          ? "Zapisuję subskrypcje"
          : syncState === "offline"
            ? "Subskrypcje czekają na sieć"
            : "Subskrypcje zsynchronizowane"}
      </div>
    </>
  );
}
