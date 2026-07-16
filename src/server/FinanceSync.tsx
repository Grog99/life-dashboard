import type { ReactNode } from "react";
import { Cloud, CloudOff, LoaderCircle } from "lucide-react";
import { useFinanceSync } from "../hooks/useFinanceSync";
import "../styles/server.css";

// Montowany obok WorkspaceSync w src/server/AuthGate.tsx — patrz
// docs/plans/model-synchronizacji-danych.md ("Montaż"). Provider jest NIEBLOKUJĄCY: renderuje
// dzieci od razu (finanse to jedna podstrona, nie blokujemy całej apki na jej hydratację) —
// FinancePage czyta gotowość bezpośrednio ze stanu useFinanceStore (puste tablice, dopóki
// hydratacja nie dotrze).
export function FinanceSync({
  children,
  onSessionExpired,
}: {
  children: ReactNode;
  onSessionExpired: () => void;
}) {
  const { syncState } = useFinanceSync(onSessionExpired);

  return (
    <>
      {children}
      <div
        className={`sync-indicator sync-indicator--finance sync-indicator--${syncState}`}
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
          ? "Zapisuję finanse"
          : syncState === "offline"
            ? "Finanse czekają na sieć"
            : "Finanse zsynchronizowane"}
      </div>
    </>
  );
}
