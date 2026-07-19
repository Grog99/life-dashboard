import type { ReactNode } from "react";
import { useFinanceSync } from "../hooks/useFinanceSync";
import { useReportSyncStatus } from "../hooks/useReportSyncStatus";

// Montowany obok WorkspaceSync w src/server/AuthGate.tsx — patrz
// docs/plans/model-synchronizacji-danych.md ("Montaż"). Provider jest NIEBLOKUJĄCY: renderuje
// dzieci od razu (finanse to jedna podstrona, nie blokujemy całej apki na jej hydratację) —
// FinancePage czyta gotowość bezpośrednio ze stanu useFinanceStore (puste tablice, dopóki
// hydratacja nie dotrze). Stan sync raportujemy do wspólnego wskaźnika (SyncIndicator) zamiast
// renderować własny — patrz docs/plans/sync-jedno-powiadomienie.md.
export function FinanceSync({
  children,
  onSessionExpired,
}: {
  children: ReactNode;
  onSessionExpired: () => void;
}) {
  const { syncState } = useFinanceSync(onSessionExpired);
  useReportSyncStatus("finance", syncState);

  return <>{children}</>;
}
