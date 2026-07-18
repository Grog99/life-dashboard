import type { ReactNode } from "react";
import { Cloud, CloudOff, LoaderCircle } from "lucide-react";
import { useHealthSync } from "../hooks/useHealthSync";
import "../styles/server.css";

// Montowany wewnątrz PetsSync w src/server/AuthGate.tsx — patrz docs/plans/zdrowie-sql.md
// ("Montaż"). Provider jest NIEBLOKUJĄCY: renderuje dzieci od razu (Zdrowie to jedna podstrona,
// nie blokujemy całej apki na jej hydratację) — HealthPage czyta gotowość bezpośrednio ze stanu
// useHealthStore (puste tablice, dopóki hydratacja nie dotrze).
export function HealthSync({
  children,
  onSessionExpired,
}: {
  children: ReactNode;
  onSessionExpired: () => void;
}) {
  const { syncState } = useHealthSync(onSessionExpired);

  return (
    <>
      {children}
      <div
        className={`sync-indicator sync-indicator--health sync-indicator--${syncState}`}
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
          ? "Zapisuję zdrowie"
          : syncState === "offline"
            ? "Zdrowie czeka na sieć"
            : "Zdrowie zsynchronizowane"}
      </div>
    </>
  );
}
