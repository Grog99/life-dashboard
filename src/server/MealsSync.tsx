import type { ReactNode } from "react";
import { useMealsSync } from "../hooks/useMealsSync";
import { useReportSyncStatus } from "../hooks/useReportSyncStatus";

// Montowany obok TripsSync w src/server/AuthGate.tsx — patrz
// docs/plans/lista-zakupow-meals.md ("Montaż"). Provider jest NIEBLOKUJĄCY: renderuje dzieci od
// razu (posiłki to jedna podstrona, nie blokujemy całej apki na jej hydratację) — MealsPage czyta
// gotowość bezpośrednio ze stanu useMealsStore (puste tablice, dopóki hydratacja nie dotrze).
// Stan sync raportujemy do wspólnego wskaźnika (SyncIndicator) zamiast renderować własny — patrz
// docs/plans/sync-jedno-powiadomienie.md.
export function MealsSync({
  children,
  onSessionExpired,
}: {
  children: ReactNode;
  onSessionExpired: () => void;
}) {
  const { syncState } = useMealsSync(onSessionExpired);
  useReportSyncStatus("meals", syncState);

  return <>{children}</>;
}
