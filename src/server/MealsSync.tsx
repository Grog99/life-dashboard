import type { ReactNode } from "react";
import { Cloud, CloudOff, LoaderCircle } from "lucide-react";
import { useMealsSync } from "../hooks/useMealsSync";
import "../styles/server.css";

// Montowany obok TripsSync w src/server/AuthGate.tsx — patrz
// docs/plans/lista-zakupow-meals.md ("Montaż"). Provider jest NIEBLOKUJĄCY: renderuje dzieci od
// razu (posiłki to jedna podstrona, nie blokujemy całej apki na jej hydratację) — MealsPage czyta
// gotowość bezpośrednio ze stanu useMealsStore (puste tablice, dopóki hydratacja nie dotrze).
export function MealsSync({
  children,
  onSessionExpired,
}: {
  children: ReactNode;
  onSessionExpired: () => void;
}) {
  const { syncState } = useMealsSync(onSessionExpired);

  return (
    <>
      {children}
      <div
        className={`sync-indicator sync-indicator--meals sync-indicator--${syncState}`}
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
          ? "Zapisuję posiłki"
          : syncState === "offline"
            ? "Posiłki czekają na sieć"
            : "Posiłki zsynchronizowane"}
      </div>
    </>
  );
}
