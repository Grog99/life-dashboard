// Dedykowany store modułu Zwierzęta (Pets) — patrz docs/plans/zwierzeta-sql.md ("Frontend —
// dedykowany store + silnik sync"). Zwierzęta nie są już częścią dokumentu JSONB
// (AdvancedData/useAdvancedStore) — mają własne znormalizowane tabele SQL i endpointy
// `/api/v1/pets` (snapshot) + `/api/v1/pets/mutations` (batch mutacji z idempotencją +
// optymistyczną współbieżnością per rekord, kolumna `version`). Wzór 1:1 z
// src/store/useCarStore.ts, ale STRICTLY PROŚCIEJSZY (docs/plans/zwierzeta-sql.md "Czym Zwierzęta
// są PROSTSZE od Auta"):
//   1. Brak pola agregującego/monotonicznego (żadnego odpowiednika `vehicle.mileage`) — wszystkie
//      mutacje to zwykłe create / OCC-update / delete.
//   2. Brak dzieci auto-generowanych po `kind` (żadnego odpowiednika `vehicleDeadlines`
//      upsertowanych przy `vehicle.create`/`vehicle.update`) — `petVisits` są w całości tworzone
//      przez użytkownika.
//   3. OBA dzieci (`petExpenses`, `petVisits`) mają WŁASNĄ `visibility`/`ownerId` (jak
//      `carExpenses`), więc `addPetExpense`/`addPetVisit` niosą je w payloadzie tak jak
//      `addCarExpense`.
// Nowe względem Auta: `Pet.fishStock` (wariant `kind === 'aquarium'`) to zagnieżdżona tablica
// niesiona w CAŁOŚCI w `pet.create`/`pet.update` — bez własnej wersji/kolizji (wzór
// `Trip.travelers`, last-write-wins na całym profilu przez OCC profilu).
//
// Ten plik trzyma WYŁĄCZNIE stan i akcje domenowe (optymistyczne mutacje lokalne + kolejka
// `pendingMutations`). Nie wie nic o sieci — silnik synchronizacji (src/hooks/usePetsSync.ts,
// src/server/PetsSync.tsx) obserwuje ten store z zewnątrz (`usePetsStore.subscribe`) i odpowiada
// za GET/POST, dokładnie jak CarSync robi to dla Auta.
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import { z } from "zod";
import { generateId as makeId } from "../lib/id";
import { quarantineRawValue, reportStorageWarning, safeLocalStorage } from "../lib/safeStorage";
import { petExpenseSchema, petSchema, petVisitSchema } from "../lib/schema";
import type { Pet, PetExpense, PetVisit } from "../petsTypes";

const STORAGE_NAME = "puls-pets";

export type PetsOp =
  | "pet.create"
  | "pet.update"
  | "pet.delete"
  | "expense.create"
  | "expense.delete"
  | "visit.create"
  | "visit.update"
  | "visit.delete";

export interface PendingPetsMutation {
  idempotencyKey: string;
  op: PetsOp;
  payload: Record<string, unknown>;
  baseVersion?: number;
}

export interface PetsMutationResult {
  idempotencyKey: string;
  status: "applied" | "duplicate" | "conflict" | "error";
  record?: unknown;
  currentVersion?: number;
  error?: string;
  code?: string;
}

export interface PetsSnapshot {
  pets: Pet[];
  petExpenses: PetExpense[];
  petVisits: PetVisit[];
  serverAt: string;
}

// Pola edytowalne przez `pet.update` — muszą być 1:1 zgodne z PET_UPDATE_KEYS w
// server/src/pets.mjs. W ODRÓŻNIENIU od `vehicle.update` (VEHICLE_UPDATE_KEYS w useCarStore.ts),
// `visibility` JEST tu edytowalna — PetsPage pozwala dziś zmienić widoczność istniejącego profilu
// (docs/plans/zwierzeta-sql.md "Ryzyka": pominięcie byłoby regresją względem dzisiejszego
// splitWorkspaceData). Zmiana kaskaduje na dzieci po stronie serwera w tej samej transakcji.
const PET_UPDATE_KEYS = [
  "name",
  "kind",
  "color",
  "species",
  "birthDate",
  "fishStock",
  "notes",
  "visibility",
] as const;

// Pola edytowalne przez `visit.update` — 1:1 zgodne z VISIT_UPDATE_KEYS w server/src/pets.mjs.
// `togglePetVisitCompleted` przechodzi przez ten sam op z `changes: { status }`.
const VISIT_UPDATE_KEYS = [
  "title",
  "clinician",
  "specialty",
  "date",
  "time",
  "location",
  "status",
  "notes",
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

// Tylko `pet.update`/`visit.update` niosą `baseVersion` i podlegają cichemu rebase'owi przy
// konflikcie (wzór isUpdateOp w useCarStore.ts). Delete-y są idempotentne (brak rekordu =
// applied), create-y na kolizję id trafiają do reconcileTerminal jak każdy inny wynik terminalny.
function isUpdateOp(op: PetsOp): op is "pet.update" | "visit.update" {
  return op === "pet.update" || op === "visit.update";
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
  pets: Pet[];
  petExpenses: PetExpense[];
  petVisits: PetVisit[];
}

// Rebase konfliktu update: przyjmij świeży rekord serwera jako bazę i reaplikuj TYLKO deltę,
// którą ta mutacja próbowała zapisać (wzór: upsertByUpdateOp w useCarStore.ts).
function upsertByUpdateOp(op: PetsOp, record: unknown, collections: Collections): Collections {
  switch (op) {
    case "pet.update":
      return { ...collections, pets: upsertById(collections.pets, record as Pet) };
    case "visit.update":
      return { ...collections, petVisits: upsertById(collections.petVisits, record as PetVisit) };
    default:
      return collections;
  }
}

// Rozliczenie wyniku terminalnego: applied/duplicate dla każdej operacji, ORAZ conflict dla
// `*.create` (kolizja id, wzór reconcileTerminal w useCarStore.ts/useTripsStore.ts).
function reconcileTerminal(
  mutation: PendingPetsMutation,
  result: PetsMutationResult,
  collections: Collections,
): Collections {
  let { pets, petExpenses, petVisits } = collections;
  const payload = mutation.payload as { id?: string };
  switch (mutation.op) {
    case "pet.create":
      if (result.record) pets = upsertById(pets, result.record as Pet);
      break;
    case "pet.update":
      // Trafia tu tylko applied/duplicate (conflict na pet.update idzie przez rebase powyżej).
      if (result.record) pets = upsertById(pets, result.record as Pet);
      break;
    case "pet.delete":
      pets = removeById(pets, String(payload.id));
      petExpenses = petExpenses.filter((expense) => expense.petId !== payload.id);
      petVisits = petVisits.filter((visit) => visit.petId !== payload.id);
      break;
    case "expense.create":
      if (result.record) petExpenses = upsertById(petExpenses, result.record as PetExpense);
      break;
    case "expense.delete":
      petExpenses = removeById(petExpenses, String(payload.id));
      break;
    case "visit.create":
      if (result.record) petVisits = upsertById(petVisits, result.record as PetVisit);
      break;
    case "visit.update":
      // Trafia tu tylko applied/duplicate (conflict na visit.update idzie przez rebase powyżej).
      if (result.record) petVisits = upsertById(petVisits, result.record as PetVisit);
      break;
    case "visit.delete":
      petVisits = removeById(petVisits, String(payload.id));
      break;
  }
  return { pets, petExpenses, petVisits };
}

interface PetsState {
  pets: Pet[];
  petExpenses: PetExpense[];
  petVisits: PetVisit[];
  pendingMutations: PendingPetsMutation[];
  serverAt: string | null;
  hydrated: boolean;
}

interface PetsActions {
  addPet: (pet: Omit<Pet, "id" | "version" | "updatedAt">) => string;
  updatePet: (petId: string, changes: Partial<Pet>) => void;
  deletePet: (petId: string) => void;
  addPetExpense: (expense: Omit<PetExpense, "id" | "version" | "updatedAt">) => string;
  deletePetExpense: (expenseId: string) => void;
  addPetVisit: (visit: Omit<PetVisit, "id" | "version" | "updatedAt">) => string;
  updatePetVisit: (visitId: string, changes: Partial<PetVisit>) => void;
  deletePetVisit: (visitId: string) => void;
  togglePetVisitCompleted: (visitId: string) => void;
  hydrateFromSnapshot: (snapshot: PetsSnapshot) => void;
  applyMutationResults: (results: PetsMutationResult[]) => void;
  resetPetsData: () => void;
}

export type PetsStore = PetsState & PetsActions;

function emptyState(): PetsState {
  return {
    pets: [],
    petExpenses: [],
    petVisits: [],
    pendingMutations: [],
    serverAt: null,
    hydrated: false,
  };
}

const petsOpSchema = z.enum([
  "pet.create",
  "pet.update",
  "pet.delete",
  "expense.create",
  "expense.delete",
  "visit.create",
  "visit.update",
  "visit.delete",
]);
const pendingMutationSchema = z.object({
  idempotencyKey: z.string().min(1),
  op: petsOpSchema,
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

export const usePetsStore = create<PetsStore>()(
  persist(
    (set, get) => ({
      ...emptyState(),

      addPet: (pet) => {
        const id = makeId();
        const updatedAt = new Date().toISOString();
        const record: Pet = { ...pet, id, version: 1, updatedAt };
        set((state) => ({
          pets: [...state.pets, record],
          pendingMutations: [
            ...state.pendingMutations,
            { idempotencyKey: makeId(), op: "pet.create", payload: { id, ...pet } },
          ],
        }));
        return id;
      },

      updatePet: (petId, changes) => {
        const existing = get().pets.find((pet) => pet.id === petId);
        if (!existing) return;
        const updatedAt = new Date().toISOString();
        const allowedChanges = pickChanges(
          changes as Record<string, unknown>,
          PET_UPDATE_KEYS,
        ) as Partial<Pet>;
        set((state) => ({
          pets: upsertById(state.pets, { ...existing, ...allowedChanges, updatedAt }),
          pendingMutations: [
            ...state.pendingMutations,
            {
              idempotencyKey: makeId(),
              op: "pet.update",
              payload: { id: petId, changes: allowedChanges },
              baseVersion: existing.version,
            },
          ],
        }));
      },

      // Kaskada usunięcia (profil + jego wydatki/wizyty) odbita natychmiast lokalnie — serwer
      // usuwa dzieci przez FK CASCADE w tej samej operacji (wzór deleteVehicle w useCarStore.ts).
      deletePet: (petId) => {
        set((state) => ({
          pets: state.pets.filter((pet) => pet.id !== petId),
          petExpenses: state.petExpenses.filter((expense) => expense.petId !== petId),
          petVisits: state.petVisits.filter((visit) => visit.petId !== petId),
          pendingMutations: [
            ...state.pendingMutations,
            { idempotencyKey: makeId(), op: "pet.delete", payload: { id: petId } },
          ],
        }));
      },

      addPetExpense: (expense) => {
        const id = makeId();
        const updatedAt = new Date().toISOString();
        const record: PetExpense = { ...expense, id, version: 1, updatedAt };
        set((state) => ({
          petExpenses: [record, ...state.petExpenses],
          pendingMutations: [
            ...state.pendingMutations,
            { idempotencyKey: makeId(), op: "expense.create", payload: { id, ...expense } },
          ],
        }));
        return id;
      },

      // Brak `expense.update` (YAGNI, docs/plans/zwierzeta-sql.md "Non-goals": dzisiejsze UI tylko
      // dodaje/usuwa wydatki).
      deletePetExpense: (expenseId) => {
        set((state) => ({
          petExpenses: state.petExpenses.filter((expense) => expense.id !== expenseId),
          pendingMutations: [
            ...state.pendingMutations,
            { idempotencyKey: makeId(), op: "expense.delete", payload: { id: expenseId } },
          ],
        }));
      },

      addPetVisit: (visit) => {
        const id = makeId();
        const updatedAt = new Date().toISOString();
        const record: PetVisit = { ...visit, id, version: 1, updatedAt };
        set((state) => ({
          petVisits: [...state.petVisits, record],
          pendingMutations: [
            ...state.pendingMutations,
            { idempotencyKey: makeId(), op: "visit.create", payload: { id, ...visit } },
          ],
        }));
        return id;
      },

      updatePetVisit: (visitId, changes) => {
        const existing = get().petVisits.find((visit) => visit.id === visitId);
        if (!existing) return;
        const updatedAt = new Date().toISOString();
        const allowedChanges = pickChanges(
          changes as Record<string, unknown>,
          VISIT_UPDATE_KEYS,
        ) as Partial<PetVisit>;
        set((state) => ({
          petVisits: upsertById(state.petVisits, { ...existing, ...allowedChanges, updatedAt }),
          pendingMutations: [
            ...state.pendingMutations,
            {
              idempotencyKey: makeId(),
              op: "visit.update",
              payload: { id: visitId, changes: allowedChanges },
              baseVersion: existing.version,
            },
          ],
        }));
      },

      deletePetVisit: (visitId) => {
        set((state) => ({
          petVisits: state.petVisits.filter((visit) => visit.id !== visitId),
          pendingMutations: [
            ...state.pendingMutations,
            { idempotencyKey: makeId(), op: "visit.delete", payload: { id: visitId } },
          ],
        }));
      },

      // Liczy nowy status LOKALNIE z bieżącego rekordu (jak dzisiejszy useAdvancedStore) i wysyła
      // visit.update z `changes: { status }` — wzór docs/plans/zwierzeta-sql.md "Ops mutacji".
      togglePetVisitCompleted: (visitId) => {
        const existing = get().petVisits.find((visit) => visit.id === visitId);
        if (!existing) return;
        const updatedAt = new Date().toISOString();
        const nextStatus: PetVisit["status"] =
          existing.status === "completed" ? "scheduled" : "completed";
        set((state) => ({
          petVisits: state.petVisits.map((visit) =>
            visit.id === visitId ? { ...visit, status: nextStatus, updatedAt } : visit,
          ),
          pendingMutations: [
            ...state.pendingMutations,
            {
              idempotencyKey: makeId(),
              op: "visit.update",
              payload: { id: visitId, changes: { status: nextStatus } },
              baseVersion: existing.version,
            },
          ],
        }));
      },

      hydrateFromSnapshot: (snapshot) => {
        // Nie nadpisuj lokalnego stanu, dopóki w kolejce są niewysłane mutacje — silnik sync
        // (usePetsSync) i tak wywołuje to tylko, gdy pendingMutations jest puste, ale ten guard
        // zostaje na wypadek błędu wywołania (wzór useCarStore.ts).
        if (get().pendingMutations.length > 0) return;
        try {
          set({
            pets: z.array(petSchema).parse(snapshot.pets),
            petExpenses: z.array(petExpenseSchema).parse(snapshot.petExpenses),
            petVisits: z.array(petVisitSchema).parse(snapshot.petVisits),
            serverAt: snapshot.serverAt,
            hydrated: true,
          });
        } catch {
          reportStorageWarning("Nie udało się przetworzyć danych zwierząt z serwera");
          set({ hydrated: true });
        }
      },

      applyMutationResults: (results) => {
        set((state) => {
          const resultByKey = new Map(results.map((result) => [result.idempotencyKey, result]));
          let collections: Collections = {
            pets: state.pets,
            petExpenses: state.petExpenses,
            petVisits: state.petVisits,
          };
          const remaining: PendingPetsMutation[] = [];
          const rebased: PendingPetsMutation[] = [];

          for (const mutation of state.pendingMutations) {
            const result = resultByKey.get(mutation.idempotencyKey);
            if (!result) {
              // Mutacja dołączona do kolejki już PO wysłaniu tego batcha — poczekaj na kolejny.
              remaining.push(mutation);
              continue;
            }

            if (result.status === "error") {
              // Trwałe odrzucenie (np. PET_NOT_FOUND, INVALID_CHANGES, NOT_FOUND) — zdejmij z
              // kolejki, nie retry'uj w nieskończoność.
              continue;
            }

            if (result.status === "conflict" && isUpdateOp(mutation.op)) {
              // Cichy rebase: przyjmij świeży rekord serwera jako bazę i reaplikuj TYLKO deltę,
              // którą ta mutacja próbowała zapisać, z nowym idempotencyKey.
              const freshRecord = result.record as Record<string, unknown> | undefined;
              const currentVersion = result.currentVersion;
              if (!freshRecord || currentVersion === undefined) continue;
              const payload = mutation.payload as { id: string; changes: Record<string, unknown> };
              collections = upsertByUpdateOp(
                mutation.op,
                { ...freshRecord, ...payload.changes },
                collections,
              );
              rebased.push({
                idempotencyKey: makeId(),
                op: mutation.op,
                payload: { id: payload.id, changes: payload.changes },
                baseVersion: currentVersion,
              });
              continue;
            }

            // applied / duplicate / conflict na *.create (kolizja id) — zaadoptuj zwrócony rekord
            // tak samo jak przy sukcesie (patrz reconcileTerminal).
            collections = reconcileTerminal(mutation, result, collections);
          }

          return { ...collections, pendingMutations: [...remaining, ...rebased] };
        });
      },

      resetPetsData: () => set(emptyState()),
    }),
    {
      name: STORAGE_NAME,
      version: 1,
      storage: createJSONStorage(() => safeLocalStorage),
      // `hydrated` jest znacznikiem sesji bieżącego montowania silnika sync, nie danymi trwałymi —
      // każdy świeży start strony powinien znów przejść przez hydratację z serwera.
      partialize: (state) => ({
        pets: state.pets,
        petExpenses: state.petExpenses,
        petVisits: state.petVisits,
        pendingMutations: state.pendingMutations,
        serverAt: state.serverAt,
      }),
      merge: (persistedState, currentState) => {
        // `persistedState` is `undefined` on a genuinely fresh install (localStorage never had
        // this key) -- zustand's persist middleware calls `merge` unconditionally, even when
        // there was nothing to deserialize. That's the normal first-run case, not corruption, so
        // it must stay silent; only an actually-present-but-wrong-shape value is a real
        // "niezgodny format" warning (patrz useCarStore.ts -- ta sama luka #3).
        if (persistedState === undefined) return currentState;
        if (persistedState === null || typeof persistedState !== "object") {
          reportStorageWarning(
            "Zapis zwierząt miał niezgodny format — zachowano bezpieczne dane startowe",
          );
          return currentState;
        }
        const state = persistedState as Record<string, unknown>;
        const pets = parseArrayField(state.pets, petSchema);
        const petExpenses = parseArrayField(state.petExpenses, petExpenseSchema);
        const petVisits = parseArrayField(state.petVisits, petVisitSchema);
        const pendingMutations = parseArrayField(state.pendingMutations, pendingMutationSchema);
        const droppedCount =
          pets.dropped + petExpenses.dropped + petVisits.dropped + pendingMutations.dropped;

        if (droppedCount > 0) {
          reportStorageWarning(
            "Część zapisanych danych zwierząt była uszkodzona i została pominięta — pozostałe pozycje zostały zachowane",
          );
          quarantineRawValue(STORAGE_NAME, JSON.stringify(persistedState));
        }

        return {
          ...currentState,
          pets: pets.items,
          petExpenses: petExpenses.items,
          petVisits: petVisits.items,
          pendingMutations: pendingMutations.items as PendingPetsMutation[],
          serverAt: typeof state.serverAt === "string" ? state.serverAt : null,
        };
      },
    },
  ),
);
