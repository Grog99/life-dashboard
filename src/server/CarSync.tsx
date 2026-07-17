import type { ReactNode } from "react";
import { Cloud, CloudOff, LoaderCircle } from "lucide-react";
import { useCarSync } from "../hooks/useCarSync";
import "../styles/server.css";

// Montowany obok MealsSync w src/server/AuthGate.tsx — patrz docs/plans/auto-car.md ("Montaż").
// Provider jest NIEBLOKUJĄCY: renderuje dzieci od razu (samochód to jedna podstrona, nie
// blokujemy całej apki na jej hydratację) — CarPage czyta gotowość bezpośrednio ze stanu
// useCarStore (puste tablice, dopóki hydratacja nie dotrze).
export function CarSync({
  children,
  onSessionExpired,
}: {
  children: ReactNode;
  onSessionExpired: () => void;
}) {
  const { syncState } = useCarSync(onSessionExpired);

  return (
    <>
      {children}
      <div
        className={`sync-indicator sync-indicator--car sync-indicator--${syncState}`}
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
          ? "Zapisuję samochód"
          : syncState === "offline"
            ? "Samochód czeka na sieć"
            : "Samochód zsynchronizowany"}
      </div>
    </>
  );
}
