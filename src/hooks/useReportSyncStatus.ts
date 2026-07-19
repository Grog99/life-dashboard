// Reużywalny hook: provider sync raportuje swój stan do wspólnego useSyncStatusStore, a przy
// odmontowaniu (np. zmiana gospodarstwa/przelogowanie -> zmiana `key` w AuthGate) czyści swój wpis,
// żeby stary stan nie „przyklejał się" do zbiorczego wskaźnika. Patrz docs/plans/sync-jedno-powiadomienie.md.
import { useEffect } from "react";
import { useSyncStatusStore, type ModuleSyncState } from "../store/useSyncStatusStore";

export function useReportSyncStatus(module: string, state: ModuleSyncState) {
  useEffect(() => {
    useSyncStatusStore.getState().report(module, state);
  }, [module, state]);

  useEffect(() => {
    return () => useSyncStatusStore.getState().clear(module);
  }, [module]);
}
