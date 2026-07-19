import type { ReactNode } from "react";
import { useLifeRecordsSync } from "../hooks/useLifeRecordsSync";
import { useReportSyncStatus } from "../hooks/useReportSyncStatus";

// Montowany najgłębiej w src/server/AuthGate.tsx, wewnątrz <SubscriptionsSync> — patrz
// docs/plans/zadania-kalendarz-notatki-nawyki-sql.md ("Montaż"). Provider jest NIEBLOKUJĄCY:
// renderuje dzieci od razu — podstrony Life (TodayPage/TasksPage/CalendarPage/NotesPage/
// HabitsPage) czytają gotowość bezpośrednio ze stanu useLifeRecordsStore (puste tablice, dopóki
// hydratacja nie dotrze). Stan sync raportujemy do wspólnego wskaźnika (SyncIndicator) zamiast
// renderować własny — patrz docs/plans/sync-jedno-powiadomienie.md.
export function LifeRecordsSync({
  children,
  onSessionExpired,
}: {
  children: ReactNode;
  onSessionExpired: () => void;
}) {
  const { syncState } = useLifeRecordsSync(onSessionExpired);
  useReportSyncStatus("life", syncState);

  return <>{children}</>;
}
