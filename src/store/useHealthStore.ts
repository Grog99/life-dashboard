// Dedykowany store modułu Zdrowie (Health) — patrz docs/plans/zdrowie-sql.md ("Frontend —
// dedykowany store + silnik sync"). Zdrowie nie jest już częścią dokumentu JSONB
// (AdvancedData/useAdvancedStore) — ma własne znormalizowane tabele SQL i endpointy
// `/api/v1/health` (snapshot) + `/api/v1/health/mutations` (batch mutacji z idempotencją +
// optymistyczną współbieżnością per rekord, kolumna `version`). Wzór 1:1 z
// src/store/usePetsStore.ts, ale STRICTLY PROŚCIEJSZY (docs/plans/zdrowie-sql.md "Czym Zdrowie
// jest PROSTSZE od Zwierząt/Auta"):
//   1. Brak pola agregującego/monotonicznego (żadnego odpowiednika `vehicle.mileage`) — wszystkie
//      mutacje to zwykłe create / OCC-update / delete.
//   2. Brak relacji rodzic/dziecko — `healthAppointments`/`medications`/`healthMeasurements` są
//      trzema CAŁKOWICIE NIEZALEŻNYMI kolekcjami płaskimi (żaden analog `petId`/`vehicleId`).
//      Usunięcie jednego rekordu nigdy nie kaskaduje do innej kolekcji.
//   3. Toggle-e (`toggleAppointmentCompleted` w HealthPage.tsx woła po prostu istniejące
//      `updateHealthAppointment(id, { status })` — nie ma dedykowanej akcji store'u dla wizyt,
//      dokładnie jak dziś w useAdvancedStore) — ALE `toggleMedicationTaken`/`toggleMedicationActive`
//      MAJĄ dedykowane akcje, bo liczą nowy stan z bieżącego rekordu (jak `togglePetVisitCompleted`).
//
// Ten plik trzyma WYŁĄCZNIE stan i akcje domenowe (optymistyczne mutacje lokalne + kolejka
// `pendingMutations`). Nie wie nic o sieci — silnik synchronizacji (src/hooks/useHealthSync.ts,
// src/server/HealthSync.tsx) obserwuje ten store z zewnątrz (`useHealthStore.subscribe`) i
// odpowiada za GET/POST, dokładnie jak PetsSync robi to dla Zwierząt.
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import { z } from "zod";
import { generateId as makeId } from "../lib/id";
import { quarantineRawValue, reportStorageWarning, safeLocalStorage } from "../lib/safeStorage";
import {
  healthAppointmentSchema,
  healthMeasurementSchema,
  medicationSchema,
} from "../lib/schema";
import type { HealthAppointment, HealthMeasurement, Medication } from "../healthTypes";

const STORAGE_NAME = "puls-health";

export type HealthOp =
  | "appointment.create"
  | "appointment.update"
  | "appointment.delete"
  | "medication.create"
  | "medication.update"
  | "medication.delete"
  | "measurement.create"
  | "measurement.update"
  | "measurement.delete";

export interface PendingHealthMutation {
  idempotencyKey: string;
  op: HealthOp;
  payload: Record<string, unknown>;
  baseVersion?: number;
}

export interface HealthMutationResult {
  idempotencyKey: string;
  status: "applied" | "duplicate" | "conflict" | "error";
  record?: unknown;
  currentVersion?: number;
  error?: string;
  code?: string;
}

export interface HealthSnapshot {
  healthAppointments: HealthAppointment[];
  medications: Medication[];
  healthMeasurements: HealthMeasurement[];
  serverAt: string;
}

// Pola edytowalne przez `appointment.update` — muszą być 1:1 zgodne z APPOINTMENT_UPDATE_KEYS
// w server/src/health.mjs. `visibility` JEST tu edytowalna — HealthPage pozwala dziś zmienić
// widoczność istniejącej wizyty (parytet z dzisiejszym splitWorkspaceData). Zdrowie jest płaskie
// — zmiana widoczności NIE kaskaduje nigdzie (brak dzieci).
const APPOINTMENT_UPDATE_KEYS = [
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

// 1:1 zgodne z MEDICATION_UPDATE_KEYS w server/src/health.mjs.
const MEDICATION_UPDATE_KEYS = [
  "name",
  "dosage",
  "schedule",
  "active",
  "reminderTime",
  "lastTakenOn",
  "visibility",
] as const;

// 1:1 zgodne z MEASUREMENT_UPDATE_KEYS w server/src/health.mjs.
const MEASUREMENT_UPDATE_KEYS = [
  "type",
  "value",
  "unit",
  "measuredAt",
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

// Wszystkie trzy `*.update` niosą `baseVersion` i podlegają cichemu rebase'owi przy konflikcie
// (wzór isUpdateOp w useCarStore.ts/usePetsStore.ts). Delete-y są idempotentne (brak rekordu =
// applied), create-y na kolizję id trafiają do reconcileTerminal jak każdy inny wynik terminalny.
function isUpdateOp(
  op: HealthOp,
): op is "appointment.update" | "medication.update" | "measurement.update" {
  return op === "appointment.update" || op === "medication.update" || op === "measurement.update";
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
  healthAppointments: HealthAppointment[];
  medications: Medication[];
  healthMeasurements: HealthMeasurement[];
}

// Rebase konfliktu update: przyjmij świeży rekord serwera jako bazę i reaplikuj TYLKO deltę,
// którą ta mutacja próbowała zapisać (wzór: upsertByUpdateOp w useCarStore.ts/usePetsStore.ts).
function upsertByUpdateOp(op: HealthOp, record: unknown, collections: Collections): Collections {
  switch (op) {
    case "appointment.update":
      return {
        ...collections,
        healthAppointments: upsertById(collections.healthAppointments, record as HealthAppointment),
      };
    case "medication.update":
      return { ...collections, medications: upsertById(collections.medications, record as Medication) };
    case "measurement.update":
      return {
        ...collections,
        healthMeasurements: upsertById(collections.healthMeasurements, record as HealthMeasurement),
      };
    default:
      return collections;
  }
}

// Rozliczenie wyniku terminalnego: applied/duplicate dla każdej operacji, ORAZ conflict dla
// `*.create` (kolizja id, wzór reconcileTerminal w useCarStore.ts/usePetsStore.ts).
function reconcileTerminal(
  mutation: PendingHealthMutation,
  result: HealthMutationResult,
  collections: Collections,
): Collections {
  let { healthAppointments, medications, healthMeasurements } = collections;
  const payload = mutation.payload as { id?: string };
  switch (mutation.op) {
    case "appointment.create":
      if (result.record) healthAppointments = upsertById(healthAppointments, result.record as HealthAppointment);
      break;
    case "appointment.update":
      // Trafia tu tylko applied/duplicate (conflict idzie przez rebase powyżej).
      if (result.record) healthAppointments = upsertById(healthAppointments, result.record as HealthAppointment);
      break;
    case "appointment.delete":
      healthAppointments = removeById(healthAppointments, String(payload.id));
      break;
    case "medication.create":
      if (result.record) medications = upsertById(medications, result.record as Medication);
      break;
    case "medication.update":
      if (result.record) medications = upsertById(medications, result.record as Medication);
      break;
    case "medication.delete":
      medications = removeById(medications, String(payload.id));
      break;
    case "measurement.create":
      if (result.record) healthMeasurements = upsertById(healthMeasurements, result.record as HealthMeasurement);
      break;
    case "measurement.update":
      if (result.record) healthMeasurements = upsertById(healthMeasurements, result.record as HealthMeasurement);
      break;
    case "measurement.delete":
      healthMeasurements = removeById(healthMeasurements, String(payload.id));
      break;
  }
  return { healthAppointments, medications, healthMeasurements };
}

interface HealthState {
  healthAppointments: HealthAppointment[];
  medications: Medication[];
  healthMeasurements: HealthMeasurement[];
  pendingMutations: PendingHealthMutation[];
  serverAt: string | null;
  hydrated: boolean;
}

interface HealthActions {
  addHealthAppointment: (
    appointment: Omit<HealthAppointment, "id" | "version" | "updatedAt">,
  ) => string;
  updateHealthAppointment: (appointmentId: string, changes: Partial<HealthAppointment>) => void;
  deleteHealthAppointment: (appointmentId: string) => void;
  addMedication: (medication: Omit<Medication, "id" | "version" | "updatedAt">) => string;
  updateMedication: (medicationId: string, changes: Partial<Medication>) => void;
  deleteMedication: (medicationId: string) => void;
  toggleMedicationTaken: (medicationId: string, date: string) => void;
  toggleMedicationActive: (medicationId: string) => void;
  addHealthMeasurement: (
    measurement: Omit<HealthMeasurement, "id" | "version" | "updatedAt">,
  ) => string;
  updateHealthMeasurement: (measurementId: string, changes: Partial<HealthMeasurement>) => void;
  deleteHealthMeasurement: (measurementId: string) => void;
  hydrateFromSnapshot: (snapshot: HealthSnapshot) => void;
  applyMutationResults: (results: HealthMutationResult[]) => void;
  resetHealthData: () => void;
}

export type HealthStore = HealthState & HealthActions;

function emptyState(): HealthState {
  return {
    healthAppointments: [],
    medications: [],
    healthMeasurements: [],
    pendingMutations: [],
    serverAt: null,
    hydrated: false,
  };
}

const healthOpSchema = z.enum([
  "appointment.create",
  "appointment.update",
  "appointment.delete",
  "medication.create",
  "medication.update",
  "medication.delete",
  "measurement.create",
  "measurement.update",
  "measurement.delete",
]);
const pendingMutationSchema = z.object({
  idempotencyKey: z.string().min(1),
  op: healthOpSchema,
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

export const useHealthStore = create<HealthStore>()(
  persist(
    (set, get) => ({
      ...emptyState(),

      addHealthAppointment: (appointment) => {
        const id = makeId();
        const updatedAt = new Date().toISOString();
        const record: HealthAppointment = { ...appointment, id, version: 1, updatedAt };
        set((state) => ({
          healthAppointments: [...state.healthAppointments, record],
          pendingMutations: [
            ...state.pendingMutations,
            {
              idempotencyKey: makeId(),
              op: "appointment.create",
              payload: { id, ...appointment },
            },
          ],
        }));
        return id;
      },

      updateHealthAppointment: (appointmentId, changes) => {
        const existing = get().healthAppointments.find(
          (appointment) => appointment.id === appointmentId,
        );
        if (!existing) return;
        const updatedAt = new Date().toISOString();
        const allowedChanges = pickChanges(
          changes as Record<string, unknown>,
          APPOINTMENT_UPDATE_KEYS,
        ) as Partial<HealthAppointment>;
        set((state) => ({
          healthAppointments: upsertById(state.healthAppointments, {
            ...existing,
            ...allowedChanges,
            updatedAt,
          }),
          pendingMutations: [
            ...state.pendingMutations,
            {
              idempotencyKey: makeId(),
              op: "appointment.update",
              payload: { id: appointmentId, changes: allowedChanges },
              baseVersion: existing.version,
            },
          ],
        }));
      },

      deleteHealthAppointment: (appointmentId) => {
        set((state) => ({
          healthAppointments: state.healthAppointments.filter(
            (appointment) => appointment.id !== appointmentId,
          ),
          pendingMutations: [
            ...state.pendingMutations,
            { idempotencyKey: makeId(), op: "appointment.delete", payload: { id: appointmentId } },
          ],
        }));
      },

      addMedication: (medication) => {
        const id = makeId();
        const updatedAt = new Date().toISOString();
        const record: Medication = { ...medication, id, version: 1, updatedAt };
        set((state) => ({
          medications: [...state.medications, record],
          pendingMutations: [
            ...state.pendingMutations,
            { idempotencyKey: makeId(), op: "medication.create", payload: { id, ...medication } },
          ],
        }));
        return id;
      },

      updateMedication: (medicationId, changes) => {
        const existing = get().medications.find((medication) => medication.id === medicationId);
        if (!existing) return;
        const updatedAt = new Date().toISOString();
        const allowedChanges = pickChanges(
          changes as Record<string, unknown>,
          MEDICATION_UPDATE_KEYS,
        ) as Partial<Medication>;
        set((state) => ({
          medications: upsertById(state.medications, { ...existing, ...allowedChanges, updatedAt }),
          pendingMutations: [
            ...state.pendingMutations,
            {
              idempotencyKey: makeId(),
              op: "medication.update",
              payload: { id: medicationId, changes: allowedChanges },
              baseVersion: existing.version,
            },
          ],
        }));
      },

      deleteMedication: (medicationId) => {
        set((state) => ({
          medications: state.medications.filter((medication) => medication.id !== medicationId),
          pendingMutations: [
            ...state.pendingMutations,
            { idempotencyKey: makeId(), op: "medication.delete", payload: { id: medicationId } },
          ],
        }));
      },

      // Liczy nowy `lastTakenOn` LOKALNIE z bieżącego rekordu (current === date ? null : date) i
      // wysyła medication.update z `changes: { lastTakenOn }` — serwer NIE liczy toggle'a, tylko
      // zapisuje przysłaną wartość (docs/plans/zdrowie-sql.md "Ops mutacji"). `null` czyści
      // last_taken_on w bazie.
      toggleMedicationTaken: (medicationId, date) => {
        const existing = get().medications.find((medication) => medication.id === medicationId);
        if (!existing) return;
        const updatedAt = new Date().toISOString();
        const nextLastTakenOn = existing.lastTakenOn === date ? undefined : date;
        set((state) => ({
          medications: state.medications.map((medication) =>
            medication.id === medicationId
              ? { ...medication, lastTakenOn: nextLastTakenOn, updatedAt }
              : medication,
          ),
          pendingMutations: [
            ...state.pendingMutations,
            {
              idempotencyKey: makeId(),
              op: "medication.update",
              payload: { id: medicationId, changes: { lastTakenOn: nextLastTakenOn ?? null } },
              baseVersion: existing.version,
            },
          ],
        }));
      },

      // Liczy nowy `active` LOKALNIE z bieżącego rekordu i wysyła medication.update z
      // `changes: { active }` — wzór togglePetVisitCompleted.
      toggleMedicationActive: (medicationId) => {
        const existing = get().medications.find((medication) => medication.id === medicationId);
        if (!existing) return;
        const updatedAt = new Date().toISOString();
        const nextActive = !existing.active;
        set((state) => ({
          medications: state.medications.map((medication) =>
            medication.id === medicationId
              ? { ...medication, active: nextActive, updatedAt }
              : medication,
          ),
          pendingMutations: [
            ...state.pendingMutations,
            {
              idempotencyKey: makeId(),
              op: "medication.update",
              payload: { id: medicationId, changes: { active: nextActive } },
              baseVersion: existing.version,
            },
          ],
        }));
      },

      addHealthMeasurement: (measurement) => {
        const id = makeId();
        const updatedAt = new Date().toISOString();
        const record: HealthMeasurement = { ...measurement, id, version: 1, updatedAt };
        set((state) => ({
          healthMeasurements: [record, ...state.healthMeasurements],
          pendingMutations: [
            ...state.pendingMutations,
            { idempotencyKey: makeId(), op: "measurement.create", payload: { id, ...measurement } },
          ],
        }));
        return id;
      },

      updateHealthMeasurement: (measurementId, changes) => {
        const existing = get().healthMeasurements.find(
          (measurement) => measurement.id === measurementId,
        );
        if (!existing) return;
        const updatedAt = new Date().toISOString();
        const allowedChanges = pickChanges(
          changes as Record<string, unknown>,
          MEASUREMENT_UPDATE_KEYS,
        ) as Partial<HealthMeasurement>;
        set((state) => ({
          healthMeasurements: upsertById(state.healthMeasurements, {
            ...existing,
            ...allowedChanges,
            updatedAt,
          }),
          pendingMutations: [
            ...state.pendingMutations,
            {
              idempotencyKey: makeId(),
              op: "measurement.update",
              payload: { id: measurementId, changes: allowedChanges },
              baseVersion: existing.version,
            },
          ],
        }));
      },

      deleteHealthMeasurement: (measurementId) => {
        set((state) => ({
          healthMeasurements: state.healthMeasurements.filter(
            (measurement) => measurement.id !== measurementId,
          ),
          pendingMutations: [
            ...state.pendingMutations,
            { idempotencyKey: makeId(), op: "measurement.delete", payload: { id: measurementId } },
          ],
        }));
      },

      hydrateFromSnapshot: (snapshot) => {
        // Nie nadpisuj lokalnego stanu, dopóki w kolejce są niewysłane mutacje — silnik sync
        // (useHealthSync) i tak wywołuje to tylko, gdy pendingMutations jest puste, ale ten guard
        // zostaje na wypadek błędu wywołania (wzór usePetsStore.ts/useCarStore.ts).
        if (get().pendingMutations.length > 0) return;
        try {
          set({
            healthAppointments: z.array(healthAppointmentSchema).parse(snapshot.healthAppointments),
            medications: z.array(medicationSchema).parse(snapshot.medications),
            healthMeasurements: z.array(healthMeasurementSchema).parse(snapshot.healthMeasurements),
            serverAt: snapshot.serverAt,
            hydrated: true,
          });
        } catch {
          reportStorageWarning("Nie udało się przetworzyć danych zdrowia z serwera");
          set({ hydrated: true });
        }
      },

      applyMutationResults: (results) => {
        set((state) => {
          const resultByKey = new Map(results.map((result) => [result.idempotencyKey, result]));
          let collections: Collections = {
            healthAppointments: state.healthAppointments,
            medications: state.medications,
            healthMeasurements: state.healthMeasurements,
          };
          const remaining: PendingHealthMutation[] = [];
          const rebased: PendingHealthMutation[] = [];

          for (const mutation of state.pendingMutations) {
            const result = resultByKey.get(mutation.idempotencyKey);
            if (!result) {
              // Mutacja dołączona do kolejki już PO wysłaniu tego batcha — poczekaj na kolejny.
              remaining.push(mutation);
              continue;
            }

            if (result.status === "error") {
              // Trwałe odrzucenie (np. NOT_FOUND, INVALID_CHANGES) — zdejmij z kolejki, nie
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

      resetHealthData: () => set(emptyState()),
    }),
    {
      name: STORAGE_NAME,
      version: 1,
      storage: createJSONStorage(() => safeLocalStorage),
      // `hydrated` jest znacznikiem sesji bieżącego montowania silnika sync, nie danymi trwałymi —
      // każdy świeży start strony powinien znów przejść przez hydratację z serwera.
      partialize: (state) => ({
        healthAppointments: state.healthAppointments,
        medications: state.medications,
        healthMeasurements: state.healthMeasurements,
        pendingMutations: state.pendingMutations,
        serverAt: state.serverAt,
      }),
      merge: (persistedState, currentState) => {
        // `persistedState` is `undefined` on a genuinely fresh install (localStorage never had
        // this key) -- zustand's persist middleware calls `merge` unconditionally, even when
        // there was nothing to deserialize. That's the normal first-run case, not corruption, so
        // it must stay silent; only an actually-present-but-wrong-shape value is a real
        // "niezgodny format" warning (patrz usePetsStore.ts/useCarStore.ts -- ta sama luka #3).
        if (persistedState === undefined) return currentState;
        if (persistedState === null || typeof persistedState !== "object") {
          reportStorageWarning(
            "Zapis zdrowia miał niezgodny format — zachowano bezpieczne dane startowe",
          );
          return currentState;
        }
        const state = persistedState as Record<string, unknown>;
        const healthAppointments = parseArrayField(state.healthAppointments, healthAppointmentSchema);
        const medications = parseArrayField(state.medications, medicationSchema);
        const healthMeasurements = parseArrayField(state.healthMeasurements, healthMeasurementSchema);
        const pendingMutations = parseArrayField(state.pendingMutations, pendingMutationSchema);
        const droppedCount =
          healthAppointments.dropped +
          medications.dropped +
          healthMeasurements.dropped +
          pendingMutations.dropped;

        if (droppedCount > 0) {
          reportStorageWarning(
            "Część zapisanych danych zdrowia była uszkodzona i została pominięta — pozostałe pozycje zostały zachowane",
          );
          quarantineRawValue(STORAGE_NAME, JSON.stringify(persistedState));
        }

        return {
          ...currentState,
          healthAppointments: healthAppointments.items,
          medications: medications.items,
          healthMeasurements: healthMeasurements.items,
          pendingMutations: pendingMutations.items as PendingHealthMutation[],
          serverAt: typeof state.serverAt === "string" ? state.serverAt : null,
        };
      },
    },
  ),
);
