import type { ReactNode } from "react";
import { Cloud, CloudOff, LoaderCircle } from "lucide-react";
import { usePetsSync } from "../hooks/usePetsSync";
import "../styles/server.css";

// Montowany wewnątrz CarSync w src/server/AuthGate.tsx — patrz docs/plans/zwierzeta-sql.md
// ("Montaż"). Provider jest NIEBLOKUJĄCY: renderuje dzieci od razu (zwierzęta to jedna podstrona,
// nie blokujemy całej apki na jej hydratację) — PetsPage czyta gotowość bezpośrednio ze stanu
// usePetsStore (puste tablice, dopóki hydratacja nie dotrze).
export function PetsSync({
  children,
  onSessionExpired,
}: {
  children: ReactNode;
  onSessionExpired: () => void;
}) {
  const { syncState } = usePetsSync(onSessionExpired);

  return (
    <>
      {children}
      <div
        className={`sync-indicator sync-indicator--pets sync-indicator--${syncState}`}
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
          ? "Zapisuję zwierzęta"
          : syncState === "offline"
            ? "Zwierzęta czekają na sieć"
            : "Zwierzęta zsynchronizowane"}
      </div>
    </>
  );
}
