import type { ReactNode } from "react";
import { useHealthSync } from "../hooks/useHealthSync";
import { useReportSyncStatus } from "../hooks/useReportSyncStatus";

// Montowany wewnątrz PetsSync w src/server/AuthGate.tsx — patrz docs/plans/zdrowie-sql.md
// ("Montaż"). Provider jest NIEBLOKUJĄCY: renderuje dzieci od razu (Zdrowie to jedna podstrona,
// nie blokujemy całej apki na jej hydratację) — HealthPage czyta gotowość bezpośrednio ze stanu
// useHealthStore (puste tablice, dopóki hydratacja nie dotrze). Stan sync raportujemy do wspólnego
// wskaźnika (SyncIndicator) zamiast renderować własny — patrz docs/plans/sync-jedno-powiadomienie.md.
export function HealthSync({
  children,
  onSessionExpired,
}: {
  children: ReactNode;
  onSessionExpired: () => void;
}) {
  const { syncState } = useHealthSync(onSessionExpired);
  useReportSyncStatus("health", syncState);

  return <>{children}</>;
}
