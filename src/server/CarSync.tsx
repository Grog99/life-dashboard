import type { ReactNode } from "react";
import { useCarSync } from "../hooks/useCarSync";
import { useReportSyncStatus } from "../hooks/useReportSyncStatus";

// Montowany obok MealsSync w src/server/AuthGate.tsx — patrz docs/plans/auto-car.md ("Montaż").
// Provider jest NIEBLOKUJĄCY: renderuje dzieci od razu (samochód to jedna podstrona, nie
// blokujemy całej apki na jej hydratację) — CarPage czyta gotowość bezpośrednio ze stanu
// useCarStore (puste tablice, dopóki hydratacja nie dotrze). Stan sync raportujemy do wspólnego
// wskaźnika (SyncIndicator) zamiast renderować własny — patrz docs/plans/sync-jedno-powiadomienie.md.
export function CarSync({
  children,
  onSessionExpired,
}: {
  children: ReactNode;
  onSessionExpired: () => void;
}) {
  const { syncState } = useCarSync(onSessionExpired);
  useReportSyncStatus("car", syncState);

  return <>{children}</>;
}
