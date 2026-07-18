import type { ReactNode } from "react";
import { Cloud, CloudOff, LoaderCircle } from "lucide-react";
import { useLifeRecordsSync } from "../hooks/useLifeRecordsSync";
import "../styles/server.css";

// Montowany najgłębiej w src/server/AuthGate.tsx, wewnątrz <SubscriptionsSync> — patrz
// docs/plans/zadania-kalendarz-notatki-nawyki-sql.md ("Montaż"). Provider jest NIEBLOKUJĄCY:
// renderuje dzieci od razu — podstrony Life (TodayPage/TasksPage/CalendarPage/NotesPage/
// HabitsPage) czytają gotowość bezpośrednio ze stanu useLifeRecordsStore (puste tablice, dopóki
// hydratacja nie dotrze).
export function LifeRecordsSync({
  children,
  onSessionExpired,
}: {
  children: ReactNode;
  onSessionExpired: () => void;
}) {
  const { syncState } = useLifeRecordsSync(onSessionExpired);

  return (
    <>
      {children}
      <div
        className={`sync-indicator sync-indicator--life sync-indicator--${syncState}`}
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
          ? "Zapisuję Puls"
          : syncState === "offline"
            ? "Puls czeka na sieć"
            : "Puls zsynchronizowany"}
      </div>
    </>
  );
}
