// Dedykowany store modułu Finanse — patrz docs/plans/model-synchronizacji-danych.md
// ("Frontend — dedykowany store + silnik sync"). Finanse nie są już częścią dokumentu JSONB
// (AdvancedData/useAdvancedStore) — mają własne znormalizowane tabele SQL i endpointy
// `/api/v1/finance` (snapshot) + `/api/v1/finance/mutations` (batch mutacji z idempotencją +
// optymistyczną współbieżnością per rekord, kolumna `version`).
//
// Ten plik trzyma WYŁĄCZNIE stan i akcje domenowe (optymistyczne mutacje lokalne + kolejka
// `pendingMutations`). Nie wie nic o sieci — silnik synchronizacji (src/hooks/useFinanceSync.ts,
// src/server/FinanceSync.tsx) obserwuje ten store z zewnątrz (`useFinanceStore.subscribe`) i
// odpowiada za GET/POST, dokładnie jak WorkspaceSync robi to dla reszty modułów.
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import { z } from "zod";
import { generateId as makeId } from "../lib/id";
import { quarantineRawValue, reportStorageWarning, safeLocalStorage } from "../lib/safeStorage";
import {
  financeAccountSchema,
  financeBudgetSchema,
  financeTransactionSchema,
  savingsGoalSchema,
} from "../lib/schema";
import type { FinanceAccount, FinanceBudget, FinanceTransaction, SavingsGoal } from "../financeTypes";

const STORAGE_NAME = "puls-finance";

export type FinanceOp =
  | "account.create"
  | "account.update"
  | "transaction.create"
  | "transaction.import"
  | "transaction.delete"
  | "budget.create"
  | "budget.update"
  | "budget.delete"
  | "goal.create"
  | "goal.update"
  | "goal.delete";

export interface PendingFinanceMutation {
  idempotencyKey: string;
  op: FinanceOp;
  payload: Record<string, unknown>;
  baseVersion?: number;
}

export interface FinanceMutationResult {
  idempotencyKey: string;
  status: "applied" | "duplicate" | "conflict" | "error";
  record?: unknown;
  account?: FinanceAccount;
  currentVersion?: number;
  error?: string;
  code?: string;
}

export interface FinanceSnapshot {
  accounts: FinanceAccount[];
  transactions: FinanceTransaction[];
  budgets: FinanceBudget[];
  goals: SavingsGoal[];
  serverAt: string;
}

// Pola edytowalne przez `*.update` — muszą być 1:1 zgodne z BUDGET_UPDATE_KEYS/GOAL_UPDATE_KEYS w
// server/src/finance.mjs. Nie ma tu odpowiednika dla kont: FinancePage.tsx nie ma dziś (i wciąż
// nie ma) żadnej ścieżki edycji istniejącego rachunku — `account.update` istnieje po stronie API,
// ale klient go nie wywołuje (patrz Non-goals w docs/plans/model-synchronizacji-danych.md).
// `visibility` JEST edytowalne dla celów (w odróżnieniu od kont) — FinancePage.tsx pozwala zmienić
// widoczność istniejącego celu w modalu edycji i to działało w dzisiejszym modelu JSONB; `ownerId`
// zostaje pominięty (właściciel ustalony z sesji przy tworzeniu, nie zmienia się przy edycji).
const BUDGET_UPDATE_KEYS = ["category", "limitMinor", "currency", "color"] as const;
const GOAL_UPDATE_KEYS = [
  "name",
  "targetMinor",
  "savedMinor",
  "currency",
  "deadline",
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

function isUpdateOp(op: FinanceOp): op is "account.update" | "budget.update" | "goal.update" {
  return op === "account.update" || op === "budget.update" || op === "goal.update";
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

interface Collections {
  accounts: FinanceAccount[];
  transactions: FinanceTransaction[];
  budgets: FinanceBudget[];
  goals: SavingsGoal[];
}

// Rebase konfliktu update: przyjmij świeży rekord serwera jako bazę i reaplikuj TYLKO deltę,
// którą ta mutacja próbowała zapisać (docs/plans/model-synchronizacji-danych.md: "cichy rebase").
function upsertByUpdateOp(op: FinanceOp, record: unknown, collections: Collections): Collections {
  switch (op) {
    case "account.update":
      return { ...collections, accounts: upsertById(collections.accounts, record as FinanceAccount) };
    case "budget.update":
      return { ...collections, budgets: upsertById(collections.budgets, record as FinanceBudget) };
    case "goal.update":
      return { ...collections, goals: upsertById(collections.goals, record as SavingsGoal) };
    default:
      return collections;
  }
}

// Rozliczenie wyniku terminalnego (applied/duplicate, oraz conflict na *.create — patrz niżej):
// zaadoptuj autorytatywny rekord (i ewentualne saldo konta) zwrócony przez serwer.
function reconcileTerminal(
  mutation: PendingFinanceMutation,
  result: FinanceMutationResult,
  collections: Collections,
): Collections {
  let { accounts, transactions, budgets, goals } = collections;
  const payload = mutation.payload;
  switch (mutation.op) {
    case "account.create":
    case "account.update":
      if (result.record) accounts = upsertById(accounts, result.record as FinanceAccount);
      break;
    case "budget.create":
    case "budget.update":
      if (result.record) budgets = upsertById(budgets, result.record as FinanceBudget);
      break;
    case "goal.create":
    case "goal.update":
      if (result.record) goals = upsertById(goals, result.record as SavingsGoal);
      break;
    case "transaction.create":
      if (result.record) transactions = upsertById(transactions, result.record as FinanceTransaction);
      if (result.account) accounts = upsertById(accounts, result.account);
      break;
    case "transaction.delete":
      transactions = removeById(transactions, String(payload.id));
      if (result.account) accounts = upsertById(accounts, result.account);
      break;
    case "budget.delete":
      budgets = removeById(budgets, String(payload.id));
      break;
    case "goal.delete":
      goals = removeById(goals, String(payload.id));
      break;
    case "transaction.import": {
      const record = result.record as
        | { transactions: FinanceTransaction[]; addedCount: number; duplicateCount: number }
        | undefined;
      const sentTransactions = (payload.transactions as Array<{ id: string }> | undefined) ?? [];
      const sentIds = new Set(sentTransactions.map((item) => item.id));
      const returned = record?.transactions ?? [];
      const returnedById = new Map(returned.map((item) => [item.id, item]));
      // Wiersze wysłane w tej mutacji, których serwer NIE zwrócił, zderzyły się z częściowym
      // unikalnym indeksem fingerprintu na serwerze (dedup, do którego lokalny check przed
      // wysyłką nie miał dostępu — np. równoległy import z drugiego urządzenia) — usuń je z
      // lokalnego stanu optymistycznego, bo serwer ich nie przyjął.
      transactions = transactions
        .filter((item) => !sentIds.has(item.id) || returnedById.has(item.id))
        .map((item) => returnedById.get(item.id) ?? item);
      break;
    }
  }
  return { accounts, transactions, budgets, goals };
}

interface FinanceState {
  accounts: FinanceAccount[];
  transactions: FinanceTransaction[];
  budgets: FinanceBudget[];
  goals: SavingsGoal[];
  pendingMutations: PendingFinanceMutation[];
  serverAt: string | null;
  hydrated: boolean;
}

interface FinanceActions {
  addAccount: (account: Omit<FinanceAccount, "id" | "updatedAt" | "version">) => string;
  addTransaction: (transaction: Omit<FinanceTransaction, "id" | "updatedAt" | "version">) => string;
  importTransactions: (
    transactions: Array<Omit<FinanceTransaction, "id" | "updatedAt" | "version">>,
  ) => { added: number; duplicates: number };
  deleteTransaction: (transactionId: string) => void;
  addBudget: (budget: Omit<FinanceBudget, "id" | "updatedAt" | "version">) => string;
  updateBudget: (budgetId: string, changes: Partial<FinanceBudget>) => void;
  deleteBudget: (budgetId: string) => void;
  addSavingsGoal: (goal: Omit<SavingsGoal, "id" | "updatedAt" | "version">) => string;
  updateSavingsGoal: (goalId: string, changes: Partial<SavingsGoal>) => void;
  deleteSavingsGoal: (goalId: string) => void;
  hydrateFromSnapshot: (snapshot: FinanceSnapshot) => void;
  applyMutationResults: (results: FinanceMutationResult[]) => void;
  resetFinanceData: () => void;
}

export type FinanceStore = FinanceState & FinanceActions;

function emptyState(): FinanceState {
  return {
    accounts: [],
    transactions: [],
    budgets: [],
    goals: [],
    pendingMutations: [],
    serverAt: null,
    hydrated: false,
  };
}

const financeOpSchema = z.enum([
  "account.create",
  "account.update",
  "transaction.create",
  "transaction.import",
  "transaction.delete",
  "budget.create",
  "budget.update",
  "budget.delete",
  "goal.create",
  "goal.update",
  "goal.delete",
]);
const pendingMutationSchema = z.object({
  idempotencyKey: z.string().min(1),
  op: financeOpSchema,
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

export const useFinanceStore = create<FinanceStore>()(
  persist(
    (set, get) => ({
      ...emptyState(),

      addAccount: (account) => {
        const id = makeId();
        const updatedAt = new Date().toISOString();
        const record: FinanceAccount = { ...account, id, version: 1, updatedAt };
        set((state) => ({
          accounts: [...state.accounts, record],
          pendingMutations: [
            ...state.pendingMutations,
            { idempotencyKey: makeId(), op: "account.create", payload: { id, ...account } },
          ],
        }));
        return id;
      },

      addTransaction: (transaction) => {
        const id = makeId();
        const updatedAt = new Date().toISOString();
        const record: FinanceTransaction = { ...transaction, id, version: 1, updatedAt };
        set((state) => ({
          transactions: [record, ...state.transactions],
          accounts: state.accounts.map((account) =>
            account.id === transaction.accountId
              ? { ...account, balanceMinor: account.balanceMinor + transaction.amountMinor, updatedAt }
              : account,
          ),
          pendingMutations: [
            ...state.pendingMutations,
            { idempotencyKey: makeId(), op: "transaction.create", payload: { id, ...transaction } },
          ],
        }));
        return id;
      },

      importTransactions: (transactions) => {
        const existing = new Set(
          get()
            .transactions.map((transaction) => transaction.fingerprint)
            .filter(Boolean),
        );
        let duplicates = 0;
        const updatedAt = new Date().toISOString();
        const accepted = transactions
          .filter((transaction) => {
            if (transaction.fingerprint && existing.has(transaction.fingerprint)) {
              duplicates += 1;
              return false;
            }
            if (transaction.fingerprint) existing.add(transaction.fingerprint);
            return true;
          })
          .map((transaction) => ({ ...transaction, id: makeId(), version: 1, updatedAt }));
        if (accepted.length) {
          set((state) => ({
            transactions: [...accepted, ...state.transactions],
            // Importowane wyciągi opisują historyczne ruchy już odzwierciedlone w aktualnym
            // saldzie konta — replay tutaj policzyłby je podwójnie (parytet z dawnym
            // useAdvancedStore.importTransactions i server/src/finance.mjs execTransactionImport).
            pendingMutations: [
              ...state.pendingMutations,
              {
                idempotencyKey: makeId(),
                op: "transaction.import",
                payload: {
                  transactions: accepted.map((item) => ({
                    id: item.id,
                    accountId: item.accountId,
                    bookedOn: item.bookedOn,
                    amountMinor: item.amountMinor,
                    currency: item.currency,
                    merchant: item.merchant,
                    title: item.title,
                    category: item.category,
                    source: item.source,
                    fingerprint: item.fingerprint,
                    notes: item.notes,
                    ownerId: item.ownerId,
                    visibility: item.visibility,
                  })),
                },
              },
            ],
          }));
        }
        return { added: accepted.length, duplicates };
      },

      deleteTransaction: (transactionId) => {
        const transaction = get().transactions.find((item) => item.id === transactionId);
        if (!transaction) return;
        const updatedAt = new Date().toISOString();
        set((state) => ({
          transactions: state.transactions.filter((item) => item.id !== transactionId),
          accounts:
            transaction.source !== "csv"
              ? state.accounts.map((account) =>
                  account.id === transaction.accountId
                    ? { ...account, balanceMinor: account.balanceMinor - transaction.amountMinor, updatedAt }
                    : account,
                )
              : state.accounts,
          pendingMutations: [
            ...state.pendingMutations,
            { idempotencyKey: makeId(), op: "transaction.delete", payload: { id: transactionId } },
          ],
        }));
      },

      addBudget: (budget) => {
        const id = makeId();
        const updatedAt = new Date().toISOString();
        const record: FinanceBudget = { ...budget, id, version: 1, updatedAt };
        set((state) => ({
          budgets: [...state.budgets, record],
          pendingMutations: [
            ...state.pendingMutations,
            { idempotencyKey: makeId(), op: "budget.create", payload: { id, ...budget } },
          ],
        }));
        return id;
      },

      updateBudget: (budgetId, changes) => {
        const existing = get().budgets.find((item) => item.id === budgetId);
        if (!existing) return;
        const updatedAt = new Date().toISOString();
        set((state) => ({
          budgets: state.budgets.map((budget) =>
            budget.id === budgetId ? { ...budget, ...changes, updatedAt } : budget,
          ),
          pendingMutations: [
            ...state.pendingMutations,
            {
              idempotencyKey: makeId(),
              op: "budget.update",
              payload: { id: budgetId, changes: pickChanges(changes, BUDGET_UPDATE_KEYS) },
              baseVersion: existing.version,
            },
          ],
        }));
      },

      deleteBudget: (budgetId) => {
        set((state) => ({
          budgets: state.budgets.filter((budget) => budget.id !== budgetId),
          pendingMutations: [
            ...state.pendingMutations,
            { idempotencyKey: makeId(), op: "budget.delete", payload: { id: budgetId } },
          ],
        }));
      },

      addSavingsGoal: (goal) => {
        const id = makeId();
        const updatedAt = new Date().toISOString();
        const record: SavingsGoal = { ...goal, id, version: 1, updatedAt };
        set((state) => ({
          goals: [...state.goals, record],
          pendingMutations: [
            ...state.pendingMutations,
            { idempotencyKey: makeId(), op: "goal.create", payload: { id, ...goal } },
          ],
        }));
        return id;
      },

      updateSavingsGoal: (goalId, changes) => {
        const existing = get().goals.find((item) => item.id === goalId);
        if (!existing) return;
        const updatedAt = new Date().toISOString();
        set((state) => ({
          goals: state.goals.map((goal) =>
            goal.id === goalId ? { ...goal, ...changes, updatedAt } : goal,
          ),
          pendingMutations: [
            ...state.pendingMutations,
            {
              idempotencyKey: makeId(),
              op: "goal.update",
              payload: { id: goalId, changes: pickChanges(changes, GOAL_UPDATE_KEYS) },
              baseVersion: existing.version,
            },
          ],
        }));
      },

      deleteSavingsGoal: (goalId) => {
        set((state) => ({
          goals: state.goals.filter((goal) => goal.id !== goalId),
          pendingMutations: [
            ...state.pendingMutations,
            { idempotencyKey: makeId(), op: "goal.delete", payload: { id: goalId } },
          ],
        }));
      },

      hydrateFromSnapshot: (snapshot) => {
        // Nie nadpisuj lokalnego stanu, dopóki w kolejce są niewysłane mutacje — silnik sync
        // (useFinanceSync) i tak wywołuje to tylko, gdy pendingMutations jest puste, ale ten
        // guard zostaje na wypadek błędu wywołania.
        if (get().pendingMutations.length > 0) return;
        try {
          set({
            accounts: z.array(financeAccountSchema).parse(snapshot.accounts),
            transactions: z.array(financeTransactionSchema).parse(snapshot.transactions),
            budgets: z.array(financeBudgetSchema).parse(snapshot.budgets),
            goals: z.array(savingsGoalSchema).parse(snapshot.goals),
            serverAt: snapshot.serverAt,
            hydrated: true,
          });
        } catch {
          reportStorageWarning("Nie udało się przetworzyć danych finansowych z serwera");
          set({ hydrated: true });
        }
      },

      applyMutationResults: (results) => {
        set((state) => {
          const resultByKey = new Map(results.map((result) => [result.idempotencyKey, result]));
          let collections: Collections = {
            accounts: state.accounts,
            transactions: state.transactions,
            budgets: state.budgets,
            goals: state.goals,
          };
          const remaining: PendingFinanceMutation[] = [];
          const rebased: PendingFinanceMutation[] = [];

          for (const mutation of state.pendingMutations) {
            const result = resultByKey.get(mutation.idempotencyKey);
            if (!result) {
              // Mutacja dołączona do kolejki już PO wysłaniu tego batcha — poczekaj na kolejny.
              remaining.push(mutation);
              continue;
            }

            if (result.status === "error") {
              // Trwałe odrzucenie (np. BUDGET_CATEGORY_DUPLICATE, ACCOUNT_NOT_FOUND, ID_TAKEN,
              // FINGERPRINT_DUPLICATE, NOT_FOUND) — zdejmij z kolejki, nie retry'uj w nieskończoność.
              continue;
            }

            if (result.status === "conflict" && isUpdateOp(mutation.op)) {
              // Cichy rebase: przyjmij świeży rekord serwera jako bazę i reaplikuj TYLKO deltę,
              // którą ta mutacja próbowała zapisać, z nowym idempotencyKey (klucz "conflict" jest
              // już trwale zapisany w finance_mutations — ponowna wysyłka z TYM SAMYM kluczem
              // zwróciłaby ten sam skonfliktowany wynik z pamięci podręcznej serwera zamiast
              // faktycznie spróbować ponownie).
              const freshRecord = result.record as Record<string, unknown> | undefined;
              const currentVersion = result.currentVersion;
              if (!freshRecord || currentVersion === undefined) continue;
              const payload = mutation.payload as { id: string; changes: Record<string, unknown> };
              collections = upsertByUpdateOp(mutation.op, { ...freshRecord, ...payload.changes }, collections);
              rebased.push({
                idempotencyKey: makeId(),
                op: mutation.op,
                payload: { id: payload.id, changes: payload.changes },
                baseVersion: currentVersion,
              });
              continue;
            }

            // applied / duplicate / conflict na *.create (id już istnieje i jest widoczny —
            // zaadoptuj zwrócony rekord tak samo jak przy sukcesie).
            collections = reconcileTerminal(mutation, result, collections);
          }

          return { ...collections, pendingMutations: [...remaining, ...rebased] };
        });
      },

      resetFinanceData: () => set(emptyState()),
    }),
    {
      name: STORAGE_NAME,
      version: 1,
      storage: createJSONStorage(() => safeLocalStorage),
      // `hydrated` jest znacznikiem sesji bieżącego montowania silnika sync, nie danymi trwałymi —
      // każdy świeży start strony powinien znów przejść przez hydratację z serwera.
      partialize: (state) => ({
        accounts: state.accounts,
        transactions: state.transactions,
        budgets: state.budgets,
        goals: state.goals,
        pendingMutations: state.pendingMutations,
        serverAt: state.serverAt,
      }),
      merge: (persistedState, currentState) => {
        // `persistedState` is `undefined` on a genuinely fresh install (localStorage never had
        // this key) -- zustand's persist middleware calls `merge` unconditionally, even when
        // there was nothing to deserialize (see node_modules/zustand/esm/middleware.mjs `hydrate`).
        // That's the normal first-run case, not corruption, so it must stay silent; only an
        // actually-present-but-wrong-shape value is a real "niezgodny format" warning.
        if (persistedState === undefined) return currentState;
        if (persistedState === null || typeof persistedState !== "object") {
          reportStorageWarning(
            "Zapis finansów miał niezgodny format — zachowano bezpieczne dane startowe",
          );
          return currentState;
        }
        const state = persistedState as Record<string, unknown>;
        const accounts = parseArrayField(state.accounts, financeAccountSchema);
        const transactions = parseArrayField(state.transactions, financeTransactionSchema);
        const budgets = parseArrayField(state.budgets, financeBudgetSchema);
        const goals = parseArrayField(state.goals, savingsGoalSchema);
        const pendingMutations = parseArrayField(state.pendingMutations, pendingMutationSchema);
        const droppedCount =
          accounts.dropped +
          transactions.dropped +
          budgets.dropped +
          goals.dropped +
          pendingMutations.dropped;

        if (droppedCount > 0) {
          reportStorageWarning(
            "Część zapisanych danych finansowych była uszkodzona i została pominięta — pozostałe pozycje zostały zachowane",
          );
          quarantineRawValue(STORAGE_NAME, JSON.stringify(persistedState));
        }

        return {
          ...currentState,
          accounts: accounts.items,
          transactions: transactions.items,
          budgets: budgets.items,
          goals: goals.items,
          pendingMutations: pendingMutations.items as PendingFinanceMutation[],
          serverAt: typeof state.serverAt === "string" ? state.serverAt : null,
        };
      },
    },
  ),
);
