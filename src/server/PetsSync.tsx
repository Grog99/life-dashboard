import type { ReactNode } from "react";
import { usePetsSync } from "../hooks/usePetsSync";
import { useReportSyncStatus } from "../hooks/useReportSyncStatus";

// Montowany wewnątrz CarSync w src/server/AuthGate.tsx — patrz docs/plans/zwierzeta-sql.md
// ("Montaż"). Provider jest NIEBLOKUJĄCY: renderuje dzieci od razu (zwierzęta to jedna podstrona,
// nie blokujemy całej apki na jej hydratację) — PetsPage czyta gotowość bezpośrednio ze stanu
// usePetsStore (puste tablice, dopóki hydratacja nie dotrze). Stan sync raportujemy do wspólnego
// wskaźnika (SyncIndicator) zamiast renderować własny — patrz docs/plans/sync-jedno-powiadomienie.md.
export function PetsSync({
  children,
  onSessionExpired,
}: {
  children: ReactNode;
  onSessionExpired: () => void;
}) {
  const { syncState } = usePetsSync(onSessionExpired);
  useReportSyncStatus("pets", syncState);

  return <>{children}</>;
}
