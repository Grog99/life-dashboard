import type { ReactNode } from "react";
import { Cloud, CloudOff, LoaderCircle } from "lucide-react";
import { useTripsSync } from "../hooks/useTripsSync";
import "../styles/server.css";

// Montowany obok FinanceSync w src/server/AuthGate.tsx — patrz
// docs/plans/podroze-trips.md ("Montaż"). Provider jest NIEBLOKUJĄCY: renderuje dzieci od razu
// (podróże to jedna podstrona, nie blokujemy całej apki na jej hydratację) — TripsPage czyta
// gotowość bezpośrednio ze stanu useTripsStore (puste tablice, dopóki hydratacja nie dotrze).
export function TripsSync({
  children,
  onSessionExpired,
}: {
  children: ReactNode;
  onSessionExpired: () => void;
}) {
  const { syncState } = useTripsSync(onSessionExpired);

  return (
    <>
      {children}
      <div
        className={`sync-indicator sync-indicator--trips sync-indicator--${syncState}`}
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
          ? "Zapisuję podróże"
          : syncState === "offline"
            ? "Podróże czekają na sieć"
            : "Podróże zsynchronizowane"}
      </div>
    </>
  );
}
