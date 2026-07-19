// Prezentacyjny store statusu synchronizacji — patrz docs/plans/sync-jedno-powiadomienie.md.
// Każdy z providerów sync (WorkspaceSync/FinanceSync/…/LifeRecordsSync) raportuje tu swój stan
// przez hook useReportSyncStatus, a jeden komponent SyncIndicator czyta stan ZBIORCZY. Dzięki temu
// zamiast 9 osobnych wskaźników jest jeden. Ten store NIE dotyka logiki synchronizacji — trzyma
// wyłącznie surowe stany do wyświetlenia.
import { create } from "zustand";

export type ModuleSyncState = "synced" | "saving" | "offline" | "conflict";

interface SyncStatusStore {
  states: Record<string, ModuleSyncState>;
  report: (module: string, state: ModuleSyncState) => void;
  clear: (module: string) => void;
}

export const useSyncStatusStore = create<SyncStatusStore>((set) => ({
  states: {},
  report: (module, state) =>
    set((current) => {
      // Bez zmiany stanu nie tworzymy nowej referencji — unikamy zbędnych re-renderów SyncIndicatora.
      if (current.states[module] === state) return current;
      return { states: { ...current.states, [module]: state } };
    }),
  clear: (module) =>
    set((current) => {
      if (!(module in current.states)) return current;
      const next = { ...current.states };
      delete next[module];
      return { states: next };
    }),
}));

// Priorytet zbiorczy: offline > conflict > saving > synced. Offline jest najważniejszy dla
// użytkownika (dane niewysłane), potem trwające scalanie konfliktu, potem zwykły zapis. Pusta mapa
// (brak zamontowanych modułów) traktujemy jako "synced" — wskaźnik i tak jest wtedy chowany.
export function aggregateSyncState(states: Record<string, ModuleSyncState>): ModuleSyncState {
  const values = Object.values(states);
  if (values.includes("offline")) return "offline";
  if (values.includes("conflict")) return "conflict";
  if (values.includes("saving")) return "saving";
  return "synced";
}
