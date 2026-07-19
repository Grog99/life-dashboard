import type { ReactNode } from "react";
import { useSubscriptionsSync } from "../hooks/useSubscriptionsSync";
import { useReportSyncStatus } from "../hooks/useReportSyncStatus";

// Montowany wewnątrz HealthSync w src/server/AuthGate.tsx — patrz docs/plans/subskrypcje-sql.md
// ("Montaż"). Provider jest NIEBLOKUJĄCY: renderuje dzieci od razu (Subskrypcje to jedna
// podstrona, nie blokujemy całej apki na jej hydratację) — SubscriptionsPage czyta gotowość
// bezpośrednio ze stanu useSubscriptionsStore (pusta tablica, dopóki hydratacja nie dotrze).
// Stan sync raportujemy do wspólnego wskaźnika (SyncIndicator) zamiast renderować własny — patrz
// docs/plans/sync-jedno-powiadomienie.md.
export function SubscriptionsSync({
  children,
  onSessionExpired,
}: {
  children: ReactNode;
  onSessionExpired: () => void;
}) {
  const { syncState } = useSubscriptionsSync(onSessionExpired);
  useReportSyncStatus("subscriptions", syncState);

  return <>{children}</>;
}
