// Jeden zbiorczy wskaźnik synchronizacji — zastępuje 9 osobnych wskaźników z providerów sync.
// Montowany raz w src/server/AuthGate.tsx. Czyta stan ZBIORCZY z useSyncStatusStore i chowa się,
// gdy wszystko jest zsynchronizowane (po krótkim „Zsynchronizowano"). Patrz
// docs/plans/sync-jedno-powiadomienie.md.
import { useEffect, useRef, useState } from "react";
import { Cloud, CloudOff, LoaderCircle } from "lucide-react";
import { aggregateSyncState, useSyncStatusStore } from "../store/useSyncStatusStore";
import "../styles/server.css";

// Jak długo pokazujemy „Zsynchronizowano" po zakończeniu synchronizacji, zanim wskaźnik zniknie.
const SYNCED_LINGER_MS = 1600;

export function SyncIndicator() {
  const aggregate = useSyncStatusStore((state) => aggregateSyncState(state.states));
  const [visible, setVisible] = useState(false);
  // Czy od ostatniego ukrycia widzieliśmy jakąkolwiek aktywność (saving/offline/conflict) — tylko
  // wtedy warto pokazać domykające „Zsynchronizowano". Bez tego wskaźnik migałby przy starcie.
  const wasActive = useRef(false);

  useEffect(() => {
    if (aggregate !== "synced") {
      wasActive.current = true;
      setVisible(true);
      return;
    }
    if (!wasActive.current) {
      setVisible(false);
      return;
    }
    setVisible(true);
    const timer = window.setTimeout(() => {
      setVisible(false);
      wasActive.current = false;
    }, SYNCED_LINGER_MS);
    return () => window.clearTimeout(timer);
  }, [aggregate]);

  if (!visible) return null;

  const label =
    aggregate === "saving"
      ? "Synchronizuję…"
      : aggregate === "offline"
        ? "Zmiany czekają na sieć"
        : aggregate === "conflict"
          ? "Scalam zmiany"
          : "Zsynchronizowano";

  return (
    <div className={`sync-indicator sync-indicator--${aggregate}`} role="status">
      {aggregate === "saving" || aggregate === "conflict" ? (
        <LoaderCircle size={13} className="spin" />
      ) : aggregate === "offline" ? (
        <CloudOff size={13} />
      ) : (
        <Cloud size={13} />
      )}
      {label}
    </div>
  );
}
