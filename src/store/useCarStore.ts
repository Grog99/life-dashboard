// Dedykowany store modułu Auto (Car) — patrz docs/plans/auto-car.md
// ("Frontend — dedykowany store + silnik sync"). Auto nie jest już częścią dokumentu JSONB
// (AdvancedData/useAdvancedStore) — ma własne znormalizowane tabele SQL i endpointy
// `/api/v1/car` (snapshot) + `/api/v1/car/mutations` (batch mutacji z idempotencją +
// optymistyczną współbieżnością per rekord, kolumna `version`). Wzór 1:1 z
// src/store/useFinanceStore.ts (Auto ZACHOWUJE ownerId/visibility, tak jak Finanse — w
// odróżnieniu od Podróży/Meals), z dwiema różnicami specyficznymi dla Auta:
//   1. `Vehicle.mileage` NIE idzie przez `vehicle.update` — dedykowana akcja `setVehicleMileage`
//      wysyła mutację `vehicle.mileage`, BEZ `baseVersion` i BEZ bumpowania `version` (analog
//      `balanceMinor`). Lokalnie liczymy optymistyczne `Math.max` (ten sam `GREATEST` co serwer);
//      po odpowiedzi ZAWSZE adoptujemy zwrócony `record` — zarówno przy `applied` (nasza wartość
//      wygrała lub zrównała się), jak i przy `conflict` (serwer ma wyższą, autorytatywną wartość
//      wprowadzoną równolegle przez inne urządzenie — patrz docs/plans/auto-car.md "Uwagi dla
//      frontendu" #1). To NIE jest cichy rebase-i-retry jak przy zwykłym OCC — mutacja się nie
//      powtarza, bo wynik (max obu) już został osiągnięty.
//   2. `vehicle.create`/`vehicle.update` mogą zwrócić `deadlines` (terminy inspection/insurance
//      upsertowane atomowo na serwerze) — store NIE wstawia/aktualizuje tych terminów lokalnie
//      przy optymistycznej mutacji (usunięcie heurystyki po `title` z dawnego `saveVehicle`);
//      adoptuje je wyłącznie z wyniku serwera (`vehicle.create` zawsze 2 elementy, `vehicle.update`
//      0–2 w zależności od tego, czy `inspectionDate`/`insuranceDate` się zmieniły).
//
// Ten plik trzyma WYŁĄCZNIE stan i akcje domenowe (optymistyczne mutacje lokalne + kolejka
// `pendingMutations`). Nie wie nic o sieci — silnik synchronizacji (src/hooks/useCarSync.ts,
// src/server/CarSync.tsx) obserwuje ten store z zewnątrz (`useCarStore.subscribe`) i odpowiada
// za GET/POST, dokładnie jak FinanceSync robi to dla Finansów.
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import { z } from "zod";
import { generateId as makeId } from "../lib/id";
import { quarantineRawValue, reportStorageWarning, safeLocalStorage } from "../lib/safeStorage";
import { carExpenseSchema, vehicleDeadlineSchema, vehicleSchema } from "../lib/schema";
import type { CarExpense, Vehicle, VehicleDeadline } from "../carTypes";

const STORAGE_NAME = "puls-car";

export type CarOp =
  | "vehicle.create"
  | "vehicle.update"
  | "vehicle.mileage"
  | "vehicle.delete"
  | "expense.create"
  | "expense.delete"
  | "deadline.create"
  | "deadline.update"
  | "deadline.delete";

export interface PendingCarMutation {
  idempotencyKey: string;
  op: CarOp;
  payload: Record<string, unknown>;
  baseVersion?: number;
}

export interface CarMutationResult {
  idempotencyKey: string;
  status: "applied" | "duplicate" | "conflict" | "error";
  record?: unknown;
  vehicle?: Vehicle;
  deadlines?: VehicleDeadline[];
  currentVersion?: number;
  error?: string;
  code?: string;
}

export interface CarSnapshot {
  vehicles: Vehicle[];
  carExpenses: CarExpense[];
  vehicleDeadlines: VehicleDeadline[];
  serverAt: string;
}

// Pola edytowalne przez `vehicle.update` — muszą być 1:1 zgodne z VEHICLE_UPDATE_KEYS w
// server/src/car.mjs. `mileage` jest celowo pominięty (idzie przez `vehicle.mileage`),
// `ownerId`/`visibility` też (niezmienne po utworzeniu, parytet z `account.update`).
const VEHICLE_UPDATE_KEYS = [
  "name",
  "make",
  "model",
  "year",
  "plate",
  "fuelType",
  "inspectionDate",
  "insuranceDate",
  "color",
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

// Tylko `vehicle.update`/`deadline.update` niosą `baseVersion` i podlegają cichemu rebase'owi
// przy konflikcie. `vehicle.mileage` jest z tego wyłączony (patrz komentarz na górze pliku) —
// mimo że może zwrócić `status: "conflict"`, to NIE jest sygnał do ponowienia z nową bazą.
function isUpdateOp(op: CarOp): op is "vehicle.update" | "deadline.update" {
  return op === "vehicle.update" || op === "deadline.update";
}

function upsertById<T extends { id: string }>(list: T[], record: T): T[] {
  const index = list.findIndex((item) => item.id === record.id);
  if (index === -1) return [record, ...list];
  const next = list.slice();
  next[index] = record;
  return next;
}

function upsertManyById<T extends { id: string }>(list: T[], records: T[]): T[] {
  return records.reduce((acc, record) => upsertById(acc, record), list);
}

function removeById<T extends { id: string }>(list: T[], id: string): T[] {
  return list.filter((item) => item.id !== id);
}

interface Collections {
  vehicles: Vehicle[];
  carExpenses: CarExpense[];
  vehicleDeadlines: VehicleDeadline[];
}

// Rebase konfliktu update: przyjmij świeży rekord serwera jako bazę i reaplikuj TYLKO deltę,
// którą ta mutacja próbowała zapisać (wzór: upsertByUpdateOp w useFinanceStore.ts/useTripsStore.ts).
function upsertByUpdateOp(op: CarOp, record: unknown, collections: Collections): Collections {
  switch (op) {
    case "vehicle.update":
      return { ...collections, vehicles: upsertById(collections.vehicles, record as Vehicle) };
    case "deadline.update":
      return {
        ...collections,
        vehicleDeadlines: upsertById(collections.vehicleDeadlines, record as VehicleDeadline),
      };
    default:
      return collections;
  }
}

// Rozliczenie wyniku terminalnego: applied/duplicate dla każdej operacji, ORAZ conflict dla
// `*.create` (kolizja id — patrz reconcileTerminal w useTripsStore.ts) i dla `vehicle.mileage`
// (konflikt = serwer ma autorytatywną wyższą wartość do zaadoptowania od razu, nie do rebase'u).
function reconcileTerminal(
  mutation: PendingCarMutation,
  result: CarMutationResult,
  collections: Collections,
): Collections {
  let { vehicles, carExpenses, vehicleDeadlines } = collections;
  const payload = mutation.payload as { id?: string };
  switch (mutation.op) {
    case "vehicle.create":
      if (result.record) vehicles = upsertById(vehicles, result.record as Vehicle);
      if (result.deadlines) vehicleDeadlines = upsertManyById(vehicleDeadlines, result.deadlines);
      break;
    case "vehicle.update":
      // Trafia tu tylko applied/duplicate (conflict na vehicle.update idzie przez rebase powyżej).
      if (result.record) vehicles = upsertById(vehicles, result.record as Vehicle);
      if (result.deadlines) vehicleDeadlines = upsertManyById(vehicleDeadlines, result.deadlines);
      break;
    case "vehicle.mileage":
      // applied LUB conflict — w obu przypadkach adoptuj zwrócony rekord (autorytatywne max).
      if (result.record) vehicles = upsertById(vehicles, result.record as Vehicle);
      break;
    case "vehicle.delete":
      vehicles = removeById(vehicles, String(payload.id));
      carExpenses = carExpenses.filter((expense) => expense.vehicleId !== payload.id);
      vehicleDeadlines = vehicleDeadlines.filter((deadline) => deadline.vehicleId !== payload.id);
      break;
    case "expense.create":
      if (result.record) carExpenses = upsertById(carExpenses, result.record as CarExpense);
      if (result.vehicle) vehicles = upsertById(vehicles, result.vehicle);
      break;
    case "expense.delete":
      carExpenses = removeById(carExpenses, String(payload.id));
      break;
    case "deadline.create":
    case "deadline.update":
      if (result.record)
        vehicleDeadlines = upsertById(vehicleDeadlines, result.record as VehicleDeadline);
      break;
    case "deadline.delete":
      vehicleDeadlines = removeById(vehicleDeadlines, String(payload.id));
      break;
  }
  return { vehicles, carExpenses, vehicleDeadlines };
}

interface CarState {
  vehicles: Vehicle[];
  carExpenses: CarExpense[];
  vehicleDeadlines: VehicleDeadline[];
  pendingMutations: PendingCarMutation[];
  serverAt: string | null;
  hydrated: boolean;
}

interface CarActions {
  addVehicle: (vehicle: Omit<Vehicle, "id" | "updatedAt" | "version">) => string;
  updateVehicle: (vehicleId: string, changes: Partial<Vehicle>) => void;
  setVehicleMileage: (vehicleId: string, mileage: number) => void;
  deleteVehicle: (vehicleId: string) => void;
  addCarExpense: (expense: Omit<CarExpense, "id" | "updatedAt" | "version">) => string;
  removeCarExpense: (expenseId: string) => void;
  addDeadline: (deadline: {
    vehicleId: string;
    title: string;
    dueDate?: string;
    dueMileage?: number;
  }) => string;
  removeDeadline: (deadlineId: string) => void;
  toggleVehicleDeadline: (deadlineId: string) => void;
  hydrateFromSnapshot: (snapshot: CarSnapshot) => void;
  applyMutationResults: (results: CarMutationResult[]) => void;
  resetCarData: () => void;
}

export type CarStore = CarState & CarActions;

function emptyState(): CarState {
  return {
    vehicles: [],
    carExpenses: [],
    vehicleDeadlines: [],
    pendingMutations: [],
    serverAt: null,
    hydrated: false,
  };
}

const carOpSchema = z.enum([
  "vehicle.create",
  "vehicle.update",
  "vehicle.mileage",
  "vehicle.delete",
  "expense.create",
  "expense.delete",
  "deadline.create",
  "deadline.update",
  "deadline.delete",
]);
const pendingMutationSchema = z.object({
  idempotencyKey: z.string().min(1),
  op: carOpSchema,
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

export const useCarStore = create<CarStore>()(
  persist(
    (set, get) => ({
      ...emptyState(),

      addVehicle: (vehicle) => {
        const id = makeId();
        const updatedAt = new Date().toISOString();
        const record: Vehicle = { ...vehicle, id, version: 1, updatedAt };
        set((state) => ({
          vehicles: [...state.vehicles, record],
          pendingMutations: [
            ...state.pendingMutations,
            { idempotencyKey: makeId(), op: "vehicle.create", payload: { id, ...vehicle } },
          ],
        }));
        return id;
      },

      updateVehicle: (vehicleId, changes) => {
        const existing = get().vehicles.find((vehicle) => vehicle.id === vehicleId);
        if (!existing) return;
        const updatedAt = new Date().toISOString();
        const allowedChanges = pickChanges(
          changes as Record<string, unknown>,
          VEHICLE_UPDATE_KEYS,
        ) as Partial<Vehicle>;
        set((state) => ({
          vehicles: upsertById(state.vehicles, { ...existing, ...allowedChanges, updatedAt }),
          pendingMutations: [
            ...state.pendingMutations,
            {
              idempotencyKey: makeId(),
              op: "vehicle.update",
              payload: { id: vehicleId, changes: allowedChanges },
              baseVersion: existing.version,
            },
          ],
        }));
      },

      // Monotoniczne, lokalnie optymistyczne (ten sam `GREATEST` co serwer) — BEZ `baseVersion`,
      // odpowiedź (applied lub conflict) zawsze niesie autorytatywną wartość do zaadoptowania
      // (patrz applyMutationResults / reconcileTerminal, case "vehicle.mileage").
      setVehicleMileage: (vehicleId, mileage) => {
        const existing = get().vehicles.find((vehicle) => vehicle.id === vehicleId);
        if (!existing) return;
        const updatedAt = new Date().toISOString();
        set((state) => ({
          vehicles: upsertById(state.vehicles, {
            ...existing,
            mileage: Math.max(existing.mileage, mileage),
            updatedAt,
          }),
          pendingMutations: [
            ...state.pendingMutations,
            {
              idempotencyKey: makeId(),
              op: "vehicle.mileage",
              payload: { id: vehicleId, mileage },
            },
          ],
        }));
      },

      // Bez dedykowanego przycisku w UI dziś (docs/plans/auto-car.md: brak wejścia z CarPage.tsx) —
      // istnieje dla symetrii store'u z resztą operacji i pod ewentualną przyszłą kaskadę. Serwer
      // kaskadowo usuwa dzieci (ON DELETE CASCADE) w tej samej operacji — odbijamy to lokalnie
      // od razu, tak jak `deleteTrip` w useTripsStore.ts.
      deleteVehicle: (vehicleId) => {
        set((state) => ({
          vehicles: state.vehicles.filter((vehicle) => vehicle.id !== vehicleId),
          carExpenses: state.carExpenses.filter((expense) => expense.vehicleId !== vehicleId),
          vehicleDeadlines: state.vehicleDeadlines.filter(
            (deadline) => deadline.vehicleId !== vehicleId,
          ),
          pendingMutations: [
            ...state.pendingMutations,
            { idempotencyKey: makeId(), op: "vehicle.delete", payload: { id: vehicleId } },
          ],
        }));
      },

      // Efekt uboczny podbicia przebiegu liczony optymistycznie lokalnie (ten sam `GREATEST`) i
      // nadpisany autorytatywnym `vehicle` z wyniku serwera, gdy payload niósł `mileage`.
      addCarExpense: (expense) => {
        const id = makeId();
        const updatedAt = new Date().toISOString();
        const record: CarExpense = { ...expense, id, version: 1, updatedAt };
        set((state) => ({
          carExpenses: [record, ...state.carExpenses],
          vehicles:
            expense.mileage !== undefined
              ? state.vehicles.map((vehicle) =>
                  vehicle.id === expense.vehicleId
                    ? {
                        ...vehicle,
                        mileage: Math.max(vehicle.mileage, expense.mileage!),
                        updatedAt,
                      }
                    : vehicle,
                )
              : state.vehicles,
          pendingMutations: [
            ...state.pendingMutations,
            { idempotencyKey: makeId(), op: "expense.create", payload: { id, ...expense } },
          ],
        }));
        return id;
      },

      // Nie cofa przebiegu (parytet z dziś — usunięcie kosztu nie obniża `mileage`).
      removeCarExpense: (expenseId) => {
        set((state) => ({
          carExpenses: state.carExpenses.filter((expense) => expense.id !== expenseId),
          pendingMutations: [
            ...state.pendingMutations,
            { idempotencyKey: makeId(), op: "expense.delete", payload: { id: expenseId } },
          ],
        }));
      },

      // Zawsze `kind: "custom"` — serwer i tak nie czyta `kind` z payloadu (walidator go nie
      // przyjmuje), więc nawet nie próbujemy go wysłać.
      addDeadline: (deadline) => {
        const id = makeId();
        const updatedAt = new Date().toISOString();
        const record: VehicleDeadline = {
          id,
          vehicleId: deadline.vehicleId,
          kind: "custom",
          title: deadline.title,
          dueDate: deadline.dueDate,
          dueMileage: deadline.dueMileage,
          completed: false,
          version: 1,
          updatedAt,
        };
        set((state) => ({
          vehicleDeadlines: [...state.vehicleDeadlines, record],
          pendingMutations: [
            ...state.pendingMutations,
            {
              idempotencyKey: makeId(),
              op: "deadline.create",
              payload: {
                id,
                vehicleId: deadline.vehicleId,
                title: deadline.title,
                dueDate: deadline.dueDate,
                dueMileage: deadline.dueMileage,
                completed: false,
              },
            },
          ],
        }));
        return id;
      },

      // Usuwa dowolny termin, także auto-generowany inspection/insurance (parytet z dzisiejszym
      // `removeDeadline`) — kolejny `vehicle.update` dotykający tej daty odtworzy go przez upsert.
      removeDeadline: (deadlineId) => {
        set((state) => ({
          vehicleDeadlines: state.vehicleDeadlines.filter((deadline) => deadline.id !== deadlineId),
          pendingMutations: [
            ...state.pendingMutations,
            { idempotencyKey: makeId(), op: "deadline.delete", payload: { id: deadlineId } },
          ],
        }));
      },

      toggleVehicleDeadline: (deadlineId) => {
        const existing = get().vehicleDeadlines.find((deadline) => deadline.id === deadlineId);
        if (!existing) return;
        const updatedAt = new Date().toISOString();
        const nextCompleted = !existing.completed;
        set((state) => ({
          vehicleDeadlines: state.vehicleDeadlines.map((deadline) =>
            deadline.id === deadlineId
              ? { ...deadline, completed: nextCompleted, updatedAt }
              : deadline,
          ),
          pendingMutations: [
            ...state.pendingMutations,
            {
              idempotencyKey: makeId(),
              op: "deadline.update",
              payload: { id: deadlineId, changes: { completed: nextCompleted } },
              baseVersion: existing.version,
            },
          ],
        }));
      },

      hydrateFromSnapshot: (snapshot) => {
        // Nie nadpisuj lokalnego stanu, dopóki w kolejce są niewysłane mutacje — silnik sync
        // (useCarSync) i tak wywołuje to tylko, gdy pendingMutations jest puste, ale ten guard
        // zostaje na wypadek błędu wywołania.
        if (get().pendingMutations.length > 0) return;
        try {
          set({
            vehicles: z.array(vehicleSchema).parse(snapshot.vehicles),
            carExpenses: z.array(carExpenseSchema).parse(snapshot.carExpenses),
            vehicleDeadlines: z.array(vehicleDeadlineSchema).parse(snapshot.vehicleDeadlines),
            serverAt: snapshot.serverAt,
            hydrated: true,
          });
        } catch {
          reportStorageWarning("Nie udało się przetworzyć danych samochodu z serwera");
          set({ hydrated: true });
        }
      },

      applyMutationResults: (results) => {
        set((state) => {
          const resultByKey = new Map(results.map((result) => [result.idempotencyKey, result]));
          let collections: Collections = {
            vehicles: state.vehicles,
            carExpenses: state.carExpenses,
            vehicleDeadlines: state.vehicleDeadlines,
          };
          const remaining: PendingCarMutation[] = [];
          const rebased: PendingCarMutation[] = [];

          for (const mutation of state.pendingMutations) {
            const result = resultByKey.get(mutation.idempotencyKey);
            if (!result) {
              // Mutacja dołączona do kolejki już PO wysłaniu tego batcha — poczekaj na kolejny.
              remaining.push(mutation);
              continue;
            }

            if (result.status === "error") {
              // Trwałe odrzucenie (np. VEHICLE_NOT_FOUND, INVALID_CHANGES, NOT_FOUND) — zdejmij z
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

            // applied / duplicate / conflict na *.create (kolizja id) / conflict na
            // vehicle.mileage (autorytatywna wartość do zaadoptowania) — zaadoptuj zwrócony
            // rekord tak samo jak przy sukcesie (patrz reconcileTerminal).
            collections = reconcileTerminal(mutation, result, collections);
          }

          return { ...collections, pendingMutations: [...remaining, ...rebased] };
        });
      },

      resetCarData: () => set(emptyState()),
    }),
    {
      name: STORAGE_NAME,
      version: 1,
      storage: createJSONStorage(() => safeLocalStorage),
      // `hydrated` jest znacznikiem sesji bieżącego montowania silnika sync, nie danymi trwałymi —
      // każdy świeży start strony powinien znów przejść przez hydratację z serwera.
      partialize: (state) => ({
        vehicles: state.vehicles,
        carExpenses: state.carExpenses,
        vehicleDeadlines: state.vehicleDeadlines,
        pendingMutations: state.pendingMutations,
        serverAt: state.serverAt,
      }),
      merge: (persistedState, currentState) => {
        // `persistedState` is `undefined` on a genuinely fresh install (localStorage never had
        // this key) -- zustand's persist middleware calls `merge` unconditionally, even when
        // there was nothing to deserialize. That's the normal first-run case, not corruption, so
        // it must stay silent; only an actually-present-but-wrong-shape value is a real
        // "niezgodny format" warning (patrz useFinanceStore.ts/useTripsStore.ts -- ta sama luka #3).
        if (persistedState === undefined) return currentState;
        if (persistedState === null || typeof persistedState !== "object") {
          reportStorageWarning(
            "Zapis samochodu miał niezgodny format — zachowano bezpieczne dane startowe",
          );
          return currentState;
        }
        const state = persistedState as Record<string, unknown>;
        const vehicles = parseArrayField(state.vehicles, vehicleSchema);
        const carExpenses = parseArrayField(state.carExpenses, carExpenseSchema);
        const vehicleDeadlines = parseArrayField(state.vehicleDeadlines, vehicleDeadlineSchema);
        const pendingMutations = parseArrayField(state.pendingMutations, pendingMutationSchema);
        const droppedCount =
          vehicles.dropped +
          carExpenses.dropped +
          vehicleDeadlines.dropped +
          pendingMutations.dropped;

        if (droppedCount > 0) {
          reportStorageWarning(
            "Część zapisanych danych samochodu była uszkodzona i została pominięta — pozostałe pozycje zostały zachowane",
          );
          quarantineRawValue(STORAGE_NAME, JSON.stringify(persistedState));
        }

        return {
          ...currentState,
          vehicles: vehicles.items,
          carExpenses: carExpenses.items,
          vehicleDeadlines: vehicleDeadlines.items,
          pendingMutations: pendingMutations.items as PendingCarMutation[],
          serverAt: typeof state.serverAt === "string" ? state.serverAt : null,
        };
      },
    },
  ),
);
