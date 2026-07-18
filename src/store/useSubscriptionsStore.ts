// Dedykowany store modułu Subskrypcje (Subscriptions) — patrz docs/plans/subskrypcje-sql.md
// ("Frontend — dedykowany store + silnik sync"). Subskrypcje nie są już częścią dokumentu JSONB
// (AdvancedData/useAdvancedStore) — mają własną znormalizowaną tabelę SQL i endpointy
// `/api/v1/subscriptions` (snapshot) + `/api/v1/subscriptions/mutations` (batch mutacji z
// idempotencją + optymistyczną współbieżnością per rekord, kolumna `version`). Wzór 1:1 z
// src/store/useHealthStore.ts, ale STRICTLY PROŚCIEJSZY (docs/plans/subskrypcje-sql.md "Czym
// Subskrypcje są PROSTSZE od Zdrowia/Zwierząt"):
//   1. Jedna płaska kolekcja, nie trzy — jeden zestaw mutacji `subscription.create/update/delete`.
//   2. Brak relacji rodzic/dziecko, brak kaskady, brak pola agregującego/monotonicznego — każdy
//      update to zwykły OCC-update per rekord.
//   3. `renew`/`togglePause` w SubscriptionsPage.tsx NIE mają dedykowanych akcji store'u — liczą
//      absolutne nowe wartości lokalnie (`nextPayment`/`status`) i wołają zwykłe
//      `updateSubscription(id, { ... })`, dokładnie jak dziś w useAdvancedStore.
//
// Ten plik trzyma WYŁĄCZNIE stan i akcje domenowe (optymistyczne mutacje lokalne + kolejka
// `pendingMutations`). Nie wie nic o sieci — silnik synchronizacji
// (src/hooks/useSubscriptionsSync.ts, src/server/SubscriptionsSync.tsx) obserwuje ten store z
// zewnątrz (`useSubscriptionsStore.subscribe`) i odpowiada za GET/POST, dokładnie jak HealthSync
// robi to dla Zdrowia.
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import { z } from "zod";
import { generateId as makeId } from "../lib/id";
import { quarantineRawValue, reportStorageWarning, safeLocalStorage } from "../lib/safeStorage";
import { subscriptionSchema } from "../lib/schema";
import type { Subscription } from "../subscriptionsTypes";

const STORAGE_NAME = "puls-subscriptions";

export type SubscriptionOp = "subscription.create" | "subscription.update" | "subscription.delete";

export interface PendingSubscriptionMutation {
  idempotencyKey: string;
  op: SubscriptionOp;
  payload: Record<string, unknown>;
  baseVersion?: number;
}

export interface SubscriptionMutationResult {
  idempotencyKey: string;
  status: "applied" | "duplicate" | "conflict" | "error";
  record?: unknown;
  currentVersion?: number;
  error?: string;
  code?: string;
}

export interface SubscriptionsSnapshot {
  subscriptions: Subscription[];
  serverAt: string;
}

// Pola edytowalne przez `subscription.update` — muszą być 1:1 zgodne z
// SUBSCRIPTION_UPDATE_KEYS w server/src/subscriptions.mjs. `visibility` JEST tu edytowalna —
// SubscriptionsPage pozwala dziś zmienić widoczność istniejącej subskrypcji przez modal edycji
// (docs/plans/subskrypcje-sql.md "Ryzyka": pominięcie byłoby regresją klasy „goal visibility” z
// Finansów). Subskrypcje są płaskie — zmiana widoczności NIE kaskaduje nigdzie (brak dzieci).
const SUBSCRIPTION_UPDATE_KEYS = [
  "name",
  "category",
  "amountMinor",
  "currency",
  "cycle",
  "nextPayment",
  "payer",
  "status",
  "reminderDays",
  "color",
  "cancelUrl",
  "visibility",
] as const;

function pickChanges<T extends Record<string, unknown>>(
  source: T,
  keys: readonly string[],
): Record<string, unknown> {
  const changes: Record<string, unknown> = {};
  for (const key of keys) {
    if (source[key] !== undefined) changes[key] = source[key];
  }
  return changes;
}

function isUpdateOp(op: SubscriptionOp): op is "subscription.update" {
  return op === "subscription.update";
}

function upsertById<T extends { id: string }>(list: T[], record: T): T[] {
  const index = list.findIndex((item) => item.id === record.id);
  if (index === -1) return [record, ...list];
  const next = list.slice();
  next[index] = record;
  return next;
}

function removeById<T extends { id: string }>(list: T[], id: string): T[] {
  return list.filter((item) => item.id !== id);
}

// Rozliczenie wyniku terminalnego: applied/duplicate dla każdej operacji, ORAZ conflict dla
// `subscription.create` (kolizja id, wzór reconcileTerminal w useHealthStore.ts/usePetsStore.ts).
function reconcileTerminal(
  mutation: PendingSubscriptionMutation,
  result: SubscriptionMutationResult,
  subscriptions: Subscription[],
): Subscription[] {
  const payload = mutation.payload as { id?: string };
  switch (mutation.op) {
    case "subscription.create":
      return result.record ? upsertById(subscriptions, result.record as Subscription) : subscriptions;
    case "subscription.update":
      // Trafia tu tylko applied/duplicate (conflict idzie przez cichy rebase powyżej).
      return result.record ? upsertById(subscriptions, result.record as Subscription) : subscriptions;
    case "subscription.delete":
      return removeById(subscriptions, String(payload.id));
    default:
      return subscriptions;
  }
}

interface SubscriptionsState {
  subscriptions: Subscription[];
  pendingMutations: PendingSubscriptionMutation[];
  serverAt: string | null;
  hydrated: boolean;
}

interface SubscriptionsActions {
  addSubscription: (subscription: Omit<Subscription, "id" | "version" | "updatedAt">) => string;
  updateSubscription: (subscriptionId: string, changes: Partial<Subscription>) => void;
  deleteSubscription: (subscriptionId: string) => void;
  hydrateFromSnapshot: (snapshot: SubscriptionsSnapshot) => void;
  applyMutationResults: (results: SubscriptionMutationResult[]) => void;
  resetSubscriptionsData: () => void;
}

export type SubscriptionsStore = SubscriptionsState & SubscriptionsActions;

function emptyState(): SubscriptionsState {
  return {
    subscriptions: [],
    pendingMutations: [],
    serverAt: null,
    hydrated: false,
  };
}

const subscriptionOpSchema = z.enum([
  "subscription.create",
  "subscription.update",
  "subscription.delete",
]);
const pendingMutationSchema = z.object({
  idempotencyKey: z.string().min(1),
  op: subscriptionOpSchema,
  payload: z.record(z.string(), z.unknown()),
  baseVersion: z.number().int().min(1).optional(),
});

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

export const useSubscriptionsStore = create<SubscriptionsStore>()(
  persist(
    (set, get) => ({
      ...emptyState(),

      addSubscription: (subscription) => {
        const id = makeId();
        const updatedAt = new Date().toISOString();
        const record: Subscription = { ...subscription, id, version: 1, updatedAt };
        set((state) => ({
          subscriptions: [record, ...state.subscriptions],
          pendingMutations: [
            ...state.pendingMutations,
            {
              idempotencyKey: makeId(),
              op: "subscription.create",
              payload: { id, ...subscription },
            },
          ],
        }));
        return id;
      },

      updateSubscription: (subscriptionId, changes) => {
        const existing = get().subscriptions.find(
          (subscription) => subscription.id === subscriptionId,
        );
        if (!existing) return;
        const updatedAt = new Date().toISOString();
        const allowedChanges = pickChanges(
          changes as Record<string, unknown>,
          SUBSCRIPTION_UPDATE_KEYS,
        ) as Partial<Subscription>;
        set((state) => ({
          subscriptions: upsertById(state.subscriptions, {
            ...existing,
            ...allowedChanges,
            updatedAt,
          }),
          pendingMutations: [
            ...state.pendingMutations,
            {
              idempotencyKey: makeId(),
              op: "subscription.update",
              payload: { id: subscriptionId, changes: allowedChanges },
              baseVersion: existing.version,
            },
          ],
        }));
      },

      deleteSubscription: (subscriptionId) => {
        set((state) => ({
          subscriptions: state.subscriptions.filter(
            (subscription) => subscription.id !== subscriptionId,
          ),
          pendingMutations: [
            ...state.pendingMutations,
            { idempotencyKey: makeId(), op: "subscription.delete", payload: { id: subscriptionId } },
          ],
        }));
      },

      hydrateFromSnapshot: (snapshot) => {
        // Nie nadpisuj lokalnego stanu, dopóki w kolejce są niewysłane mutacje — silnik sync
        // (useSubscriptionsSync) i tak wywołuje to tylko, gdy pendingMutations jest puste, ale ten
        // guard zostaje na wypadek błędu wywołania (wzór useHealthStore.ts/usePetsStore.ts).
        if (get().pendingMutations.length > 0) return;
        try {
          set({
            subscriptions: z.array(subscriptionSchema).parse(snapshot.subscriptions),
            serverAt: snapshot.serverAt,
            hydrated: true,
          });
        } catch {
          reportStorageWarning("Nie udało się przetworzyć danych subskrypcji z serwera");
          set({ hydrated: true });
        }
      },

      applyMutationResults: (results) => {
        set((state) => {
          const resultByKey = new Map(results.map((result) => [result.idempotencyKey, result]));
          let subscriptions = state.subscriptions;
          const remaining: PendingSubscriptionMutation[] = [];
          const rebased: PendingSubscriptionMutation[] = [];

          for (const mutation of state.pendingMutations) {
            const result = resultByKey.get(mutation.idempotencyKey);
            if (!result) {
              // Mutacja dołączona do kolejki już PO wysłaniu tego batcha — poczekaj na kolejny.
              remaining.push(mutation);
              continue;
            }

            if (result.status === "error") {
              // Trwałe odrzucenie (np. NOT_FOUND, INVALID_CANCEL_URL) — zdejmij z kolejki, nie
              // retry'uj w nieskończoność.
              continue;
            }

            if (result.status === "conflict" && isUpdateOp(mutation.op)) {
              // Cichy rebase: przyjmij świeży rekord serwera jako bazę i reaplikuj TYLKO deltę,
              // którą ta mutacja próbowała zapisać, z nowym idempotencyKey.
              const freshRecord = result.record as Record<string, unknown> | undefined;
              const currentVersion = result.currentVersion;
              if (!freshRecord || currentVersion === undefined) continue;
              const payload = mutation.payload as { id: string; changes: Record<string, unknown> };
              subscriptions = upsertById(subscriptions, {
                ...freshRecord,
                ...payload.changes,
              } as unknown as Subscription);
              rebased.push({
                idempotencyKey: makeId(),
                op: mutation.op,
                payload: { id: payload.id, changes: payload.changes },
                baseVersion: currentVersion,
              });
              continue;
            }

            // applied / duplicate / conflict na `subscription.create` (kolizja id) — zaadoptuj
            // zwrócony rekord tak samo jak przy sukcesie (patrz reconcileTerminal).
            subscriptions = reconcileTerminal(mutation, result, subscriptions);
          }

          return { subscriptions, pendingMutations: [...remaining, ...rebased] };
        });
      },

      resetSubscriptionsData: () => set(emptyState()),
    }),
    {
      name: STORAGE_NAME,
      version: 1,
      storage: createJSONStorage(() => safeLocalStorage),
      // `hydrated` jest znacznikiem sesji bieżącego montowania silnika sync, nie danymi trwałymi —
      // każdy świeży start strony powinien znów przejść przez hydratację z serwera.
      partialize: (state) => ({
        subscriptions: state.subscriptions,
        pendingMutations: state.pendingMutations,
        serverAt: state.serverAt,
      }),
      merge: (persistedState, currentState) => {
        // `persistedState` is `undefined` on a genuinely fresh install (localStorage never had
        // this key) -- zustand's persist middleware calls `merge` unconditionally, even when
        // there was nothing to deserialize. That's the normal first-run case, not corruption, so
        // it must stay silent; only an actually-present-but-wrong-shape value is a real
        // "niezgodny format" warning (patrz useHealthStore.ts/usePetsStore.ts/useCarStore.ts --
        // ta sama luka #3).
        if (persistedState === undefined) return currentState;
        if (persistedState === null || typeof persistedState !== "object") {
          reportStorageWarning(
            "Zapis subskrypcji miał niezgodny format — zachowano bezpieczne dane startowe",
          );
          return currentState;
        }
        const state = persistedState as Record<string, unknown>;
        const subscriptions = parseArrayField(state.subscriptions, subscriptionSchema);
        const pendingMutations = parseArrayField(state.pendingMutations, pendingMutationSchema);
        const droppedCount = subscriptions.dropped + pendingMutations.dropped;

        if (droppedCount > 0) {
          reportStorageWarning(
            "Część zapisanych danych subskrypcji była uszkodzona i została pominięta — pozostałe pozycje zostały zachowane",
          );
          quarantineRawValue(STORAGE_NAME, JSON.stringify(persistedState));
        }

        return {
          ...currentState,
          subscriptions: subscriptions.items,
          pendingMutations: pendingMutations.items as PendingSubscriptionMutation[],
          serverAt: typeof state.serverAt === "string" ? state.serverAt : null,
        };
      },
    },
  ),
);
