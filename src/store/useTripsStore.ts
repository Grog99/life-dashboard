// Dedykowany store modułu Podróże — patrz docs/plans/podroze-trips.md
// ("Frontend — dedykowany store + silnik sync"). Podróże nie są już częścią dokumentu JSONB
// (AdvancedData/useAdvancedStore) — mają własne znormalizowane tabele SQL i endpointy
// `/api/v1/trips` (snapshot) + `/api/v1/trips/mutations` (batch mutacji z idempotencją +
// optymistyczną współbieżnością per rekord, kolumna `version`). Wzór 1:1 z
// src/store/useFinanceStore.ts, z dwiema różnicami specyficznymi dla Podróży:
//   1. Podróże nie mają `ownerId`/`visibility` — są zawsze wspólne (Trip nie rozszerza SharedMeta).
//   2. `Trip.progress` jest serwerowo autorytatywny (computeTripProgress w server/src/trips.mjs).
//      Klient liczy go optymistycznie LOKALNIE tą samą formułą (dla natychmiastowego UI), ale po
//      odpowiedzi serwera adoptuje autorytatywne pole `trip` zwracane przez
//      trip.create/trip.update/itinerary.create/itinerary.delete/booking.create/booking.delete.
//
// Ten plik trzyma WYŁĄCZNIE stan i akcje domenowe (optymistyczne mutacje lokalne + kolejka
// `pendingMutations`). Nie wie nic o sieci — silnik synchronizacji (src/hooks/useTripsSync.ts,
// src/server/TripsSync.tsx) obserwuje ten store z zewnątrz (`useTripsStore.subscribe`) i
// odpowiada za GET/POST, dokładnie jak FinanceSync robi to dla Finansów.
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import { z } from "zod";
import { generateId as makeId } from "../lib/id";
import { quarantineRawValue, reportStorageWarning, safeLocalStorage } from "../lib/safeStorage";
import {
  packingItemSchema,
  tripBookingSchema,
  tripItinerarySchema,
  tripSchema,
} from "../lib/schema";
import type { PackingItem, Trip, TripBooking, TripItineraryItem } from "../tripsTypes";

const STORAGE_NAME = "puls-trips";

export type TripOp =
  | "trip.create"
  | "trip.update"
  | "trip.delete"
  | "itinerary.create"
  | "itinerary.delete"
  | "booking.create"
  | "booking.update"
  | "booking.delete"
  | "packing.create"
  | "packing.update"
  | "packing.delete";

export interface PendingTripMutation {
  idempotencyKey: string;
  op: TripOp;
  payload: Record<string, unknown>;
  baseVersion?: number;
}

export interface TripMutationResult {
  idempotencyKey: string;
  status: "applied" | "duplicate" | "conflict" | "error";
  record?: unknown;
  trip?: Trip;
  currentVersion?: number;
  error?: string;
  code?: string;
}

export interface TripSnapshot {
  trips: Trip[];
  itinerary: TripItineraryItem[];
  bookings: TripBooking[];
  packing: PackingItem[];
  serverAt: string;
}

// docs/plans/podroze-trips.md "Projekt `progress`", Opcja B — 1:1 z computeTripProgress w
// server/src/trips.mjs. Dwie implementacje MUSZĄ zostać zsynchronizowane (rozjazd dałby
// "miganie" wartości po odpowiedzi serwera, patrz "Ryzyka" w planie).
function computeTripProgress(
  status: Trip["status"],
  itineraryCount: number,
  bookingCount: number,
): number {
  if (status === "archived") return 100;
  const base = status === "idea" ? 5 : 12;
  return Math.min(98, Math.max(0, base + 3 * itineraryCount + 5 * bookingCount));
}

// Pola edytowalne przez `*.update` — muszą być 1:1 zgodne z *_UPDATE_KEYS w server/src/trips.mjs.
// `progress` jest celowo pominięty w TRIP_UPDATE_KEYS: serwer go liczy sam, wysłanie go zostałoby
// odrzucone jako INVALID_CHANGES.
const TRIP_UPDATE_KEYS = [
  "name",
  "destination",
  "startDate",
  "endDate",
  "status",
  "budgetMinor",
  "currency",
  "travelers",
  "accent",
  "notes",
] as const;
const BOOKING_UPDATE_KEYS = [
  "type",
  "provider",
  "reference",
  "title",
  "startAt",
  "amountMinor",
  "paid",
] as const;

// `budgetMinor` (trip) może być jawnie wyczyszczony przez zmianę na `null` w `changes` — odróżnione
// od "nie zmieniaj" (pominięcie klucza). Skoro modale w TripsPage.tsx budują ZAWSZE pełny obiekt
// zmian (nie deltę), obecność klucza (nawet z wartością `undefined`, gdy pole formularza jest
// puste) jest tu traktowana jako intencja "wyczyść".
function pickTripChanges(changes: Partial<Trip>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of TRIP_UPDATE_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(changes, key)) continue;
    if (key === "budgetMinor") {
      out.budgetMinor = changes.budgetMinor ?? null;
    } else {
      out[key] = (changes as Record<string, unknown>)[key];
    }
  }
  return out;
}

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

// `assignedTo` (packing) może być jawnie wyczyszczony przez `null`, tak samo jak `budgetMinor`.
function pickPackingChanges(changes: Partial<PackingItem>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (changes.packed !== undefined) out.packed = changes.packed;
  if (Object.prototype.hasOwnProperty.call(changes, "assignedTo")) {
    out.assignedTo = changes.assignedTo ?? null;
  }
  return out;
}

function isUpdateOp(op: TripOp): op is "trip.update" | "booking.update" | "packing.update" {
  return op === "trip.update" || op === "booking.update" || op === "packing.update";
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
  trips: Trip[];
  itinerary: TripItineraryItem[];
  bookings: TripBooking[];
  packing: PackingItem[];
}

// Rebase konfliktu update: przyjmij świeży rekord serwera jako bazę i reaplikuj TYLKO deltę,
// którą ta mutacja próbowała zapisać (wzór: upsertByUpdateOp w useFinanceStore.ts).
function upsertByUpdateOp(op: TripOp, record: unknown, collections: Collections): Collections {
  switch (op) {
    case "trip.update":
      return { ...collections, trips: upsertById(collections.trips, record as Trip) };
    case "booking.update":
      return { ...collections, bookings: upsertById(collections.bookings, record as TripBooking) };
    case "packing.update":
      return { ...collections, packing: upsertById(collections.packing, record as PackingItem) };
    default:
      return collections;
  }
}

// Rozliczenie wyniku terminalnego (applied/duplicate, oraz conflict na *.create — id kolizja).
// Zaadoptuj autorytatywny rekord zwrócony przez serwer i — dla mutacji dzieci wpływających na
// postęp — autorytatywny `trip` (progress przeliczony serwerowo w tej samej transakcji).
function reconcileTerminal(
  mutation: PendingTripMutation,
  result: TripMutationResult,
  collections: Collections,
): Collections {
  let { trips, itinerary, bookings, packing } = collections;
  const payload = mutation.payload as { id?: string };
  switch (mutation.op) {
    case "trip.create":
    case "trip.update":
      if (result.record) trips = upsertById(trips, result.record as Trip);
      break;
    case "trip.delete":
      trips = removeById(trips, String(payload.id));
      break;
    case "itinerary.create":
      if (result.record) itinerary = upsertById(itinerary, result.record as TripItineraryItem);
      if (result.trip) trips = upsertById(trips, result.trip);
      break;
    case "itinerary.delete":
      itinerary = removeById(itinerary, String(payload.id));
      if (result.trip) trips = upsertById(trips, result.trip);
      break;
    case "booking.create":
      if (result.record) bookings = upsertById(bookings, result.record as TripBooking);
      if (result.trip) trips = upsertById(trips, result.trip);
      break;
    case "booking.update":
      if (result.record) bookings = upsertById(bookings, result.record as TripBooking);
      break;
    case "booking.delete":
      bookings = removeById(bookings, String(payload.id));
      if (result.trip) trips = upsertById(trips, result.trip);
      break;
    case "packing.create":
    case "packing.update":
      if (result.record) packing = upsertById(packing, result.record as PackingItem);
      break;
    case "packing.delete":
      packing = removeById(packing, String(payload.id));
      break;
  }
  return { trips, itinerary, bookings, packing };
}

interface TripState {
  trips: Trip[];
  itinerary: TripItineraryItem[];
  bookings: TripBooking[];
  packing: PackingItem[];
  pendingMutations: PendingTripMutation[];
  serverAt: string | null;
  hydrated: boolean;
}

interface TripActions {
  addTrip: (trip: Omit<Trip, "id" | "updatedAt" | "version" | "progress">) => string;
  updateTrip: (tripId: string, changes: Partial<Trip>) => void;
  deleteTrip: (tripId: string) => void;
  addTripItineraryItem: (item: Omit<TripItineraryItem, "id" | "updatedAt" | "version">) => string;
  deleteTripItineraryItem: (itemId: string) => void;
  addTripBooking: (booking: Omit<TripBooking, "id" | "updatedAt" | "version">) => string;
  updateTripBooking: (bookingId: string, changes: Partial<TripBooking>) => void;
  deleteTripBooking: (bookingId: string) => void;
  togglePackingItem: (itemId: string) => void;
  addPackingItem: (item: Omit<PackingItem, "id" | "updatedAt" | "version">) => void;
  updatePackingItem: (itemId: string, changes: Partial<PackingItem>) => void;
  deletePackingItem: (itemId: string) => void;
  hydrateFromSnapshot: (snapshot: TripSnapshot) => void;
  applyMutationResults: (results: TripMutationResult[]) => void;
  resetTripsData: () => void;
}

export type TripsStore = TripState & TripActions;

function emptyState(): TripState {
  return {
    trips: [],
    itinerary: [],
    bookings: [],
    packing: [],
    pendingMutations: [],
    serverAt: null,
    hydrated: false,
  };
}

const tripOpSchema = z.enum([
  "trip.create",
  "trip.update",
  "trip.delete",
  "itinerary.create",
  "itinerary.delete",
  "booking.create",
  "booking.update",
  "booking.delete",
  "packing.create",
  "packing.update",
  "packing.delete",
]);
const pendingMutationSchema = z.object({
  idempotencyKey: z.string().min(1),
  op: tripOpSchema,
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

// Liczy postęp lokalnie z aktualnego (jeszcze niepotwierdzonego serwerowo) stanu dzieci — używane
// przy każdej optymistycznej mutacji dziecka wpływającej na postęp (itinerary/booking create/delete
// oraz zmiana statusu podróży).
function localProgressForTrip(
  status: Trip["status"],
  tripId: string,
  itinerary: TripItineraryItem[],
  bookings: TripBooking[],
): number {
  return computeTripProgress(
    status,
    itinerary.filter((item) => item.tripId === tripId).length,
    bookings.filter((booking) => booking.tripId === tripId).length,
  );
}

export const useTripsStore = create<TripsStore>()(
  persist(
    (set, get) => ({
      ...emptyState(),

      addTrip: (trip) => {
        const id = makeId();
        const updatedAt = new Date().toISOString();
        const progress = computeTripProgress(trip.status, 0, 0);
        const record: Trip = { ...trip, id, version: 1, progress, updatedAt };
        set((state) => ({
          trips: [record, ...state.trips],
          pendingMutations: [
            ...state.pendingMutations,
            { idempotencyKey: makeId(), op: "trip.create", payload: { id, ...trip } },
          ],
        }));
        return id;
      },

      updateTrip: (tripId, changes) => {
        const existing = get().trips.find((trip) => trip.id === tripId);
        if (!existing) return;
        const updatedAt = new Date().toISOString();
        set((state) => {
          let nextTrip: Trip = { ...existing, ...changes, updatedAt };
          if (changes.status !== undefined) {
            nextTrip = {
              ...nextTrip,
              progress: localProgressForTrip(
                changes.status,
                tripId,
                state.itinerary,
                state.bookings,
              ),
            };
          }
          return {
            trips: upsertById(state.trips, nextTrip),
            pendingMutations: [
              ...state.pendingMutations,
              {
                idempotencyKey: makeId(),
                op: "trip.update",
                payload: { id: tripId, changes: pickTripChanges(changes) },
                baseVersion: existing.version,
              },
            ],
          };
        });
      },

      deleteTrip: (tripId) => {
        set((state) => ({
          trips: state.trips.filter((trip) => trip.id !== tripId),
          // Serwer kaskadowo usuwa dzieci (ON DELETE CASCADE) w tej samej operacji -- odbijamy to
          // lokalnie od razu zamiast wysyłać osobne mutacje itinerary/booking/packing.delete.
          itinerary: state.itinerary.filter((item) => item.tripId !== tripId),
          bookings: state.bookings.filter((booking) => booking.tripId !== tripId),
          packing: state.packing.filter((item) => item.tripId !== tripId),
          pendingMutations: [
            ...state.pendingMutations,
            { idempotencyKey: makeId(), op: "trip.delete", payload: { id: tripId } },
          ],
        }));
      },

      addTripItineraryItem: (item) => {
        const id = makeId();
        const updatedAt = new Date().toISOString();
        const record: TripItineraryItem = { ...item, id, version: 1, updatedAt };
        set((state) => {
          const itinerary = [...state.itinerary, record];
          const trip = state.trips.find((candidate) => candidate.id === item.tripId);
          const trips = trip
            ? upsertById(state.trips, {
                ...trip,
                progress: localProgressForTrip(trip.status, item.tripId, itinerary, state.bookings),
              })
            : state.trips;
          return {
            itinerary,
            trips,
            pendingMutations: [
              ...state.pendingMutations,
              { idempotencyKey: makeId(), op: "itinerary.create", payload: { id, ...item } },
            ],
          };
        });
        return id;
      },

      deleteTripItineraryItem: (itemId) => {
        set((state) => {
          const item = state.itinerary.find((candidate) => candidate.id === itemId);
          const itinerary = state.itinerary.filter((candidate) => candidate.id !== itemId);
          let trips = state.trips;
          if (item) {
            const trip = state.trips.find((candidate) => candidate.id === item.tripId);
            if (trip) {
              trips = upsertById(state.trips, {
                ...trip,
                progress: localProgressForTrip(trip.status, item.tripId, itinerary, state.bookings),
              });
            }
          }
          return {
            itinerary,
            trips,
            pendingMutations: [
              ...state.pendingMutations,
              { idempotencyKey: makeId(), op: "itinerary.delete", payload: { id: itemId } },
            ],
          };
        });
      },

      addTripBooking: (booking) => {
        const id = makeId();
        const updatedAt = new Date().toISOString();
        const record: TripBooking = { ...booking, id, version: 1, updatedAt };
        set((state) => {
          const bookings = [...state.bookings, record];
          const trip = state.trips.find((candidate) => candidate.id === booking.tripId);
          const trips = trip
            ? upsertById(state.trips, {
                ...trip,
                progress: localProgressForTrip(
                  trip.status,
                  booking.tripId,
                  state.itinerary,
                  bookings,
                ),
              })
            : state.trips;
          return {
            bookings,
            trips,
            pendingMutations: [
              ...state.pendingMutations,
              { idempotencyKey: makeId(), op: "booking.create", payload: { id, ...booking } },
            ],
          };
        });
        return id;
      },

      updateTripBooking: (bookingId, changes) => {
        const existing = get().bookings.find((booking) => booking.id === bookingId);
        if (!existing) return;
        const updatedAt = new Date().toISOString();
        set((state) => ({
          bookings: state.bookings.map((booking) =>
            booking.id === bookingId ? { ...booking, ...changes, updatedAt } : booking,
          ),
          pendingMutations: [
            ...state.pendingMutations,
            {
              idempotencyKey: makeId(),
              op: "booking.update",
              payload: { id: bookingId, changes: pickChanges(changes, BOOKING_UPDATE_KEYS) },
              baseVersion: existing.version,
            },
          ],
        }));
      },

      deleteTripBooking: (bookingId) => {
        set((state) => {
          const booking = state.bookings.find((candidate) => candidate.id === bookingId);
          const bookings = state.bookings.filter((candidate) => candidate.id !== bookingId);
          let trips = state.trips;
          if (booking) {
            const trip = state.trips.find((candidate) => candidate.id === booking.tripId);
            if (trip) {
              trips = upsertById(state.trips, {
                ...trip,
                progress: localProgressForTrip(
                  trip.status,
                  booking.tripId,
                  state.itinerary,
                  bookings,
                ),
              });
            }
          }
          return {
            bookings,
            trips,
            pendingMutations: [
              ...state.pendingMutations,
              { idempotencyKey: makeId(), op: "booking.delete", payload: { id: bookingId } },
            ],
          };
        });
      },

      togglePackingItem: (itemId) => {
        const existing = get().packing.find((item) => item.id === itemId);
        if (!existing) return;
        const updatedAt = new Date().toISOString();
        const nextPacked = !existing.packed;
        set((state) => ({
          packing: state.packing.map((item) =>
            item.id === itemId ? { ...item, packed: nextPacked, updatedAt } : item,
          ),
          pendingMutations: [
            ...state.pendingMutations,
            {
              idempotencyKey: makeId(),
              op: "packing.update",
              payload: { id: itemId, changes: { packed: nextPacked } },
              baseVersion: existing.version,
            },
          ],
        }));
      },

      addPackingItem: (item) => {
        const id = makeId();
        const updatedAt = new Date().toISOString();
        set((state) => ({
          packing: [...state.packing, { ...item, id, version: 1, updatedAt }],
          pendingMutations: [
            ...state.pendingMutations,
            { idempotencyKey: makeId(), op: "packing.create", payload: { id, ...item } },
          ],
        }));
      },

      updatePackingItem: (itemId, changes) => {
        const existing = get().packing.find((item) => item.id === itemId);
        if (!existing) return;
        const updatedAt = new Date().toISOString();
        set((state) => ({
          packing: state.packing.map((item) =>
            item.id === itemId ? { ...item, ...changes, updatedAt } : item,
          ),
          pendingMutations: [
            ...state.pendingMutations,
            {
              idempotencyKey: makeId(),
              op: "packing.update",
              payload: { id: itemId, changes: pickPackingChanges(changes) },
              baseVersion: existing.version,
            },
          ],
        }));
      },

      deletePackingItem: (itemId) => {
        set((state) => ({
          packing: state.packing.filter((item) => item.id !== itemId),
          pendingMutations: [
            ...state.pendingMutations,
            { idempotencyKey: makeId(), op: "packing.delete", payload: { id: itemId } },
          ],
        }));
      },

      hydrateFromSnapshot: (snapshot) => {
        // Nie nadpisuj lokalnego stanu, dopóki w kolejce są niewysłane mutacje — silnik sync
        // (useTripsSync) i tak wywołuje to tylko, gdy pendingMutations jest puste, ale ten guard
        // zostaje na wypadek błędu wywołania.
        if (get().pendingMutations.length > 0) return;
        try {
          set({
            trips: z.array(tripSchema).parse(snapshot.trips),
            itinerary: z.array(tripItinerarySchema).parse(snapshot.itinerary),
            bookings: z.array(tripBookingSchema).parse(snapshot.bookings),
            packing: z.array(packingItemSchema).parse(snapshot.packing),
            serverAt: snapshot.serverAt,
            hydrated: true,
          });
        } catch {
          reportStorageWarning("Nie udało się przetworzyć danych podróży z serwera");
          set({ hydrated: true });
        }
      },

      applyMutationResults: (results) => {
        set((state) => {
          const resultByKey = new Map(results.map((result) => [result.idempotencyKey, result]));
          let collections: Collections = {
            trips: state.trips,
            itinerary: state.itinerary,
            bookings: state.bookings,
            packing: state.packing,
          };
          const remaining: PendingTripMutation[] = [];
          const rebased: PendingTripMutation[] = [];

          for (const mutation of state.pendingMutations) {
            const result = resultByKey.get(mutation.idempotencyKey);
            if (!result) {
              // Mutacja dołączona do kolejki już PO wysłaniu tego batcha — poczekaj na kolejny.
              remaining.push(mutation);
              continue;
            }

            if (result.status === "error") {
              // Trwałe odrzucenie (np. TRIP_NOT_FOUND, INVALID_CHANGES, NOT_FOUND) — zdejmij z
              // kolejki, nie retry'uj w nieskończoność (parytet z Finansami/ACCOUNT_NOT_FOUND).
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

            // applied / duplicate / conflict na *.create (id już istnieje i jest widoczny —
            // zaadoptuj zwrócony rekord tak samo jak przy sukcesie).
            collections = reconcileTerminal(mutation, result, collections);
          }

          return { ...collections, pendingMutations: [...remaining, ...rebased] };
        });
      },

      resetTripsData: () => set(emptyState()),
    }),
    {
      name: STORAGE_NAME,
      version: 1,
      storage: createJSONStorage(() => safeLocalStorage),
      // `hydrated` jest znacznikiem sesji bieżącego montowania silnika sync, nie danymi trwałymi —
      // każdy świeży start strony powinien znów przejść przez hydratację z serwera.
      partialize: (state) => ({
        trips: state.trips,
        itinerary: state.itinerary,
        bookings: state.bookings,
        packing: state.packing,
        pendingMutations: state.pendingMutations,
        serverAt: state.serverAt,
      }),
      merge: (persistedState, currentState) => {
        // `persistedState` is `undefined` on a genuinely fresh install (localStorage never had
        // this key) -- zustand's persist middleware calls `merge` unconditionally, even when
        // there was nothing to deserialize. That's the normal first-run case, not corruption, so
        // it must stay silent; only an actually-present-but-wrong-shape value is a real
        // "niezgodny format" warning (patrz useFinanceStore.ts -- ta sama luka #3).
        if (persistedState === undefined) return currentState;
        if (persistedState === null || typeof persistedState !== "object") {
          reportStorageWarning(
            "Zapis podróży miał niezgodny format — zachowano bezpieczne dane startowe",
          );
          return currentState;
        }
        const state = persistedState as Record<string, unknown>;
        const trips = parseArrayField(state.trips, tripSchema);
        const itinerary = parseArrayField(state.itinerary, tripItinerarySchema);
        const bookings = parseArrayField(state.bookings, tripBookingSchema);
        const packing = parseArrayField(state.packing, packingItemSchema);
        const pendingMutations = parseArrayField(state.pendingMutations, pendingMutationSchema);
        const droppedCount =
          trips.dropped +
          itinerary.dropped +
          bookings.dropped +
          packing.dropped +
          pendingMutations.dropped;

        if (droppedCount > 0) {
          reportStorageWarning(
            "Część zapisanych danych podróży była uszkodzona i została pominięta — pozostałe pozycje zostały zachowane",
          );
          quarantineRawValue(STORAGE_NAME, JSON.stringify(persistedState));
        }

        return {
          ...currentState,
          trips: trips.items,
          itinerary: itinerary.items,
          bookings: bookings.items,
          packing: packing.items,
          pendingMutations: pendingMutations.items as PendingTripMutation[],
          serverAt: typeof state.serverAt === "string" ? state.serverAt : null,
        };
      },
    },
  ),
);
