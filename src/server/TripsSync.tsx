import type { ReactNode } from "react";
import { useTripsSync } from "../hooks/useTripsSync";
import { useReportSyncStatus } from "../hooks/useReportSyncStatus";

// Montowany obok FinanceSync w src/server/AuthGate.tsx — patrz
// docs/plans/podroze-trips.md ("Montaż"). Provider jest NIEBLOKUJĄCY: renderuje dzieci od razu
// (podróże to jedna podstrona, nie blokujemy całej apki na jej hydratację) — TripsPage czyta
// gotowość bezpośrednio ze stanu useTripsStore (puste tablice, dopóki hydratacja nie dotrze).
// Stan sync raportujemy do wspólnego wskaźnika (SyncIndicator) zamiast renderować własny — patrz
// docs/plans/sync-jedno-powiadomienie.md.
export function TripsSync({
  children,
  onSessionExpired,
}: {
  children: ReactNode;
  onSessionExpired: () => void;
}) {
  const { syncState } = useTripsSync(onSessionExpired);
  useReportSyncStatus("trips", syncState);

  return <>{children}</>;
}
