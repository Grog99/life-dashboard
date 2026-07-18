import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import { z } from "zod";
import { createAdvancedData } from "../data/advancedData";
import { quarantineRawValue, reportStorageWarning, safeLocalStorage } from "../lib/safeStorage";
import { hideAmountsSchema, householdMemberSchema, householdNameSchema } from "../lib/schema";
import type { AdvancedData, AdvancedDataWithHealth } from "../advancedTypes";

const STORAGE_NAME = "puls-advanced-dashboard";

function parseArrayField<T>(value: unknown, schema: z.ZodType<T>): { items: T[]; dropped: number } {
  if (value === undefined) return { items: [], dropped: 0 };
  if (!Array.isArray(value)) return { items: [], dropped: 1 };
  let dropped = 0;
  const items: T[] = [];
  for (const raw of value) {
    const result = schema.safeParse(raw);
    if (result.success) items.push(result.data);
    else dropped += 1;
  }
  return { items, dropped };
}

function parseScalarField<T>(
  value: unknown,
  schema: z.ZodType<T>,
  fallback: T,
): { value: T; dropped: number } {
  if (value === undefined) return { value: fallback, dropped: 0 };
  const result = schema.safeParse(value);
  return result.success ? { value: result.data, dropped: 0 } : { value: fallback, dropped: 1 };
}

interface AdvancedActions {
  toggleHideAmounts: () => void;
  replaceAdvancedData: (data: AdvancedData) => void;
  resetAdvancedData: () => void;
}

export type AdvancedStore = AdvancedDataWithHealth & AdvancedActions;

export const useAdvancedStore = create<AdvancedStore>()(
  persist(
    (set) => ({
      ...createAdvancedData(),
      toggleHideAmounts: () => set((state) => ({ hideAmounts: !state.hideAmounts })),
      replaceAdvancedData: (data) => set({ ...data }),
      resetAdvancedData: () => set(createAdvancedData()),
    }),
    {
      name: STORAGE_NAME,
      version: 1,
      storage: createJSONStorage(() => safeLocalStorage),
      merge: (persistedState, currentState) => {
        // `persistedState` is `undefined` on a genuinely fresh install (localStorage never had
        // this key) -- zustand's persist middleware calls `merge` unconditionally, even when
        // there was nothing to deserialize. That's the normal first-run case, not corruption, so
        // it must stay silent; only an actually-present-but-wrong-shape value is a real
        // "niezgodny format" warning (patrz useFinanceStore.ts/useCarStore.ts -- ta sama luka #3).
        if (persistedState === undefined) return currentState;
        if (persistedState === null || typeof persistedState !== "object") {
          reportStorageWarning(
            "Zapis modułów miał niezgodny format — zachowano bezpieczne dane startowe",
          );
          return currentState;
        }
        const state = persistedState as Record<string, unknown>;

        const householdMembers = parseArrayField(state.householdMembers, householdMemberSchema);
        const householdName = parseScalarField(
          state.householdName,
          householdNameSchema,
          currentState.householdName,
        );
        const hideAmounts = parseScalarField(
          state.hideAmounts,
          hideAmountsSchema,
          currentState.hideAmounts,
        );

        const droppedCount = householdMembers.dropped + householdName.dropped + hideAmounts.dropped;

        if (droppedCount > 0) {
          reportStorageWarning(
            "Część zapisanych danych modułów była uszkodzona i została pominięta — pozostałe pozycje zostały zachowane",
          );
          quarantineRawValue(STORAGE_NAME, JSON.stringify(persistedState));
        }

        return {
          ...currentState,
          householdMembers: householdMembers.items,
          householdName: householdName.value,
          hideAmounts: hideAmounts.value,
        };
      },
      partialize: (state) => ({
        householdMembers: state.householdMembers,
        householdName: state.householdName,
        hideAmounts: state.hideAmounts,
      }),
    },
  ),
);

export function exportAdvancedData(): AdvancedDataWithHealth {
  const state = useAdvancedStore.getState();
  return {
    householdMembers: state.householdMembers,
    householdName: state.householdName,
    hideAmounts: state.hideAmounts,
  };
}
