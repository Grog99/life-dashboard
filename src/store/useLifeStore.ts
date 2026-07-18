// Store pól osobistych Life (`scratchpad`/`intention`/`energy`/`preferences`) — synchronizowanych
// przez dokument JSONB workspace (`src/server/WorkspaceSync.tsx`), BEZ ZMIAN w tej ścieżce sync.
// Pięć kolekcji Life (`tasks`/`events`/`reminders`/`notes`/`habits`) NIE są już tu trzymane — mają
// własne znormalizowane tabele SQL i dedykowany store `src/store/useLifeRecordsStore.ts` + silnik
// sync `src/hooks/useLifeRecordsSync.ts`/`src/server/LifeRecordsSync.tsx`. Patrz
// docs/plans/zadania-kalendarz-notatki-nawyki-sql.md ("KLUCZOWE: co ZOSTAJE w JSONB, a co
// odchodzi" i "Odchudzenie useLifeStore").
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import { z } from "zod";
import { createSampleData } from "../data/sampleData";
import { energySchema, preferencesSchema } from "../lib/schema";
import { quarantineRawValue, reportStorageWarning, safeLocalStorage } from "../lib/safeStorage";
import type { Energy, LifeData, Preferences } from "../types";

const STORAGE_NAME = "puls-life-dashboard";

function parseScalarField<T>(
  value: unknown,
  schema: z.ZodType<T>,
  fallback: T,
): { value: T; dropped: number } {
  if (value === undefined) return { value: fallback, dropped: 0 };
  const result = schema.safeParse(value);
  return result.success ? { value: result.data, dropped: 0 } : { value: fallback, dropped: 1 };
}

interface LifeActions {
  setScratchpad: (value: string) => void;
  setIntention: (value: string) => void;
  setEnergy: (value: Energy) => void;
  updatePreferences: (changes: Partial<Preferences>) => void;
  replaceData: (data: LifeData) => void;
  resetData: () => void;
}

export type LifeStore = LifeData & LifeActions;

const initial = createSampleData();

export const useLifeStore = create<LifeStore>()(
  persist(
    (set) => ({
      ...initial,
      setScratchpad: (scratchpad) => set({ scratchpad }),
      setIntention: (intention) => set({ intention }),
      setEnergy: (energy) => set({ energy }),
      updatePreferences: (changes) =>
        set((state) => ({ preferences: { ...state.preferences, ...changes } })),
      replaceData: (data) => set(data),
      resetData: () => set(createSampleData()),
    }),
    {
      name: STORAGE_NAME,
      version: 1,
      storage: createJSONStorage(() => safeLocalStorage),
      merge: (persistedState, currentState) => {
        if (persistedState === undefined) return currentState;
        if (!persistedState || typeof persistedState !== "object") {
          reportStorageWarning(
            "Zapisane dane miały niezgodny format — zachowano bezpieczne dane startowe",
          );
          return currentState;
        }
        const state = persistedState as Record<string, unknown>;

        const scratchpad = parseScalarField(state.scratchpad, z.string(), currentState.scratchpad);
        const intention = parseScalarField(state.intention, z.string(), currentState.intention);
        const energy = parseScalarField(state.energy, energySchema, currentState.energy);
        const preferences = parseScalarField(
          state.preferences,
          preferencesSchema,
          currentState.preferences,
        );

        const droppedCount =
          scratchpad.dropped + intention.dropped + energy.dropped + preferences.dropped;

        if (droppedCount > 0) {
          reportStorageWarning(
            "Część zapisanych danych była uszkodzona i została pominięta — pozostałe pozycje zostały zachowane",
          );
          quarantineRawValue(STORAGE_NAME, JSON.stringify(persistedState));
        }

        return {
          ...currentState,
          scratchpad: scratchpad.value,
          intention: intention.value,
          energy: energy.value,
          preferences: preferences.value,
        };
      },
      partialize: (state) => ({
        scratchpad: state.scratchpad,
        intention: state.intention,
        energy: state.energy,
        preferences: state.preferences,
      }),
    },
  ),
);

export function exportData(): LifeData {
  const state = useLifeStore.getState();
  return {
    scratchpad: state.scratchpad,
    intention: state.intention,
    energy: state.energy,
    preferences: state.preferences,
  };
}
