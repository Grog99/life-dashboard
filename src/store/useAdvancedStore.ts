import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import { z } from "zod";
import { createAdvancedData } from "../data/advancedData";
import { quarantineRawValue, reportStorageWarning, safeLocalStorage } from "../lib/safeStorage";
import { generateId as makeId } from "../lib/id";
import {
  hideAmountsSchema,
  householdMemberSchema,
  householdNameSchema,
  subscriptionSchema,
} from "../lib/schema";
import type { AdvancedData, AdvancedDataWithHealth, Subscription } from "../advancedTypes";

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
  addSubscription: (subscription: Omit<Subscription, "id">) => string;
  updateSubscription: (subscriptionId: string, changes: Partial<Subscription>) => void;
  deleteSubscription: (subscriptionId: string) => void;
  replaceAdvancedData: (data: AdvancedData) => void;
  resetAdvancedData: () => void;
}

export type AdvancedStore = AdvancedDataWithHealth & AdvancedActions;

export const useAdvancedStore = create<AdvancedStore>()(
  persist(
    (set) => ({
      ...createAdvancedData(),
      toggleHideAmounts: () => set((state) => ({ hideAmounts: !state.hideAmounts })),
      addSubscription: (subscription) => {
        const id = makeId();
        set((state) => ({ subscriptions: [{ ...subscription, id }, ...state.subscriptions] }));
        return id;
      },
      updateSubscription: (subscriptionId, changes) =>
        set((state) => ({
          subscriptions: state.subscriptions.map((subscription) =>
            subscription.id === subscriptionId ? { ...subscription, ...changes } : subscription,
          ),
        })),
      deleteSubscription: (subscriptionId) =>
        set((state) => ({
          subscriptions: state.subscriptions.filter(
            (subscription) => subscription.id !== subscriptionId,
          ),
        })),
      replaceAdvancedData: (data) => set({ ...data }),
      resetAdvancedData: () => set(createAdvancedData()),
    }),
    {
      name: STORAGE_NAME,
      version: 1,
      storage: createJSONStorage(() => safeLocalStorage),
      merge: (persistedState, currentState) => {
        if (!persistedState || typeof persistedState !== "object") {
          reportStorageWarning(
            "Zapis modułów miał niezgodny format — zachowano bezpieczne dane startowe",
          );
          return currentState;
        }
        const state = persistedState as Record<string, unknown>;

        const subscriptions = parseArrayField(state.subscriptions, subscriptionSchema);
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

        const arrayFields = [subscriptions, householdMembers];
        const droppedCount =
          arrayFields.reduce((sum, field) => sum + field.dropped, 0) +
          householdName.dropped +
          hideAmounts.dropped;

        if (droppedCount > 0) {
          reportStorageWarning(
            "Część zapisanych danych modułów była uszkodzona i została pominięta — pozostałe pozycje zostały zachowane",
          );
          quarantineRawValue(STORAGE_NAME, JSON.stringify(persistedState));
        }

        return {
          ...currentState,
          subscriptions: subscriptions.items,
          householdMembers: householdMembers.items,
          householdName: householdName.value,
          hideAmounts: hideAmounts.value,
        };
      },
      partialize: (state) => ({
        subscriptions: state.subscriptions,
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
    subscriptions: state.subscriptions,
    householdMembers: state.householdMembers,
    householdName: state.householdName,
    hideAmounts: state.hideAmounts,
  };
}
