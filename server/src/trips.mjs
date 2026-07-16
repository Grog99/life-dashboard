// Domain layer for the normalized Trips (Podróże) module.
//
// Data model: server/migrations/007_trips_normalized.sql (trips, trip_itinerary, trip_bookings,
// packing_items, trip_mutations). Design source of truth: docs/plans/podroze-trips.md ("Podejście").
// This is the Trips analogue of server/src/finance.mjs -- same shape, same conventions -- with the
// two structural differences the plan calls out explicitly:
//   1. Trips have NO owner_id/visibility columns at all -- they are always household-wide, so every
//      query here scopes exclusively by household_id (never `visibility = 'household' OR owner_id = …`).
//      The household id always comes from the authenticated session (ctx.householdId), never the payload.
//   2. `Trip.progress` is never client-writable. Validators for trip.create/trip.update don't even read
//      a `progress` field from the payload; it is always (re)computed server-side from authoritative
//      COUNT(*) queries against trip_itinerary/trip_bookings, in the same transaction as the mutation
//      that can affect it (trip.create, trip.update when status changes, itinerary.create/delete,
//      booking.create/delete). packing_items mutations never touch progress.
//
// Like finance.mjs, this module intentionally does NOT import the zod schemas from src/lib/schema.ts:
// the server package has no TypeScript build step and no zod dependency. The validators below hand-roll
// the same rules as tripSchema/tripItinerarySchema/tripBookingSchema/packingItemSchema.
//
// Every exported function here is either pure (validators, computeTripProgress, resolveVersionConflict,
// row->DTO mappers) or takes an already-connected `client` (a pg PoolClient, or the shared `pool` from
// db.mjs) so it can run either inside a transaction() or directly against the pool.

export class TripValidationError extends Error {
  constructor(message, code = "VALIDATION_ERROR") {
    super(message);
    this.name = "TripValidationError";
    this.code = code;
  }
}

function tripRequestError(statusCode, message, code) {
  const error = new Error(message);
  error.statusCode = statusCode;
  error.code = code;
  return error;
}

// ---------------------------------------------------------------------------
// Primitive validators (mirror src/lib/schema.ts / src/tripsTypes.ts)
// ---------------------------------------------------------------------------

const ID_MAX_LENGTH = 200;
const CURRENCIES = new Set(["PLN", "EUR", "USD", "GBP"]);
const TRIP_STATUSES = new Set(["idea", "planning", "active", "archived"]);
const TRIP_ACCENTS = new Set(["terracotta", "ocean", "forest", "violet"]);
const ITINERARY_TYPES = new Set(["transport", "stay", "activity", "food", "other"]);
const BOOKING_TYPES = new Set(["flight", "train", "stay", "car", "activity"]);
const PACKING_CATEGORIES = new Set(["documents", "clothes", "electronics", "health", "other"]);
const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const TIME_PATTERN = /^\d{2}:\d{2}$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_TRAVELERS = 50;

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isId(value) {
  return typeof value === "string" && value.length >= 1 && value.length <= ID_MAX_LENGTH;
}

function isNonEmptyText(value, maxLength) {
  return typeof value === "string" && value.trim().length > 0 && value.length <= maxLength;
}

function isOptionalText(value, maxLength) {
  return typeof value === "string" && value.length <= maxLength;
}

function isSafeMoney(value) {
  return typeof value === "number" && Number.isSafeInteger(value);
}

function isIsoDate(value) {
  if (typeof value !== "string" || !ISO_DATE_PATTERN.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  return (
    parsed.getUTCFullYear() === year &&
    parsed.getUTCMonth() === month - 1 &&
    parsed.getUTCDate() === day
  );
}

function isClockTime(value) {
  return typeof value === "string" && TIME_PATTERN.test(value);
}

function isIsoDateTime(value) {
  return typeof value === "string" && value.length <= 60 && !Number.isNaN(Date.parse(value));
}

function isTravelersArray(value) {
  return (
    Array.isArray(value) &&
    value.length <= MAX_TRAVELERS &&
    value.every((item) => typeof item === "string" && item.length >= 1 && item.length <= 200)
  );
}

function assertShape(condition, message, code) {
  if (!condition) throw new TripValidationError(message, code);
}

// ---------------------------------------------------------------------------
// Security invariant (docs/ARCHITECTURE.md "Dane wspólne i prywatne" + plan "Odróżnianie
// prywatne/wspólne"): trips have no owner_id/visibility at all -- they are always household-wide.
// Every query in this module scopes exclusively by household_id, which always comes from the
// authenticated session (ctx.householdId), never from a client-supplied payload field.
// ---------------------------------------------------------------------------

// Pure helper naming the core OCC decision explicitly, unit-testable in isolation (mirrors
// finance.mjs's resolveVersionConflict). The authoritative check always happens in SQL
// (`WHERE version = $baseVersion`).
export function resolveVersionConflict(baseVersion, currentVersion) {
  return Number(baseVersion) === Number(currentVersion);
}

// docs/plans/podroze-trips.md "Projekt `progress`", Opcja B (rekomendacja): `archived` always caps at
// 100 regardless of children; otherwise the base for the trip's status plus a per-child bump, clamped
// to a shared cap of 98. Recomputed from authoritative COUNT(*) queries, never incremented in place --
// this is what eliminates the read-modify-write race the plan documents ("Dowód (a)").
export function computeTripProgress(status, itineraryCount, bookingCount) {
  if (status === "archived") return 100;
  const base = status === "idea" ? 5 : 12;
  const raw = base + 3 * Number(itineraryCount || 0) + 5 * Number(bookingCount || 0);
  return Math.min(98, Math.max(0, raw));
}

function normalizeRequiredVersion(baseVersion) {
  assertShape(
    Number.isInteger(baseVersion) && baseVersion >= 1,
    "Wymagana prawidłowa wersja rekordu (baseVersion)",
    "INVALID_BASE_VERSION",
  );
  return baseVersion;
}

function normalizeOptionalVersion(baseVersion) {
  if (baseVersion === undefined || baseVersion === null) return null;
  assertShape(
    Number.isInteger(baseVersion) && baseVersion >= 1,
    "Nieprawidłowa wersja rekordu (baseVersion)",
    "INVALID_BASE_VERSION",
  );
  return baseVersion;
}

// ---------------------------------------------------------------------------
// Row -> DTO mapping (snake_case columns -> the Trip/TripItineraryItem/TripBooking/PackingItem shapes
// in src/tripsTypes.ts). `bigint` columns arrive from node-postgres as strings, coerced with Number();
// `date` columns are cast to text in SQL (`::text`) to dodge node-postgres's local-timezone Date
// parsing; `timestamptz` columns are safe to read as JS Date and converted with `.toISOString()`.
// `travelers` (jsonb) comes back already parsed into a JS array by node-postgres.
// ---------------------------------------------------------------------------

export function tripRowToDto(row) {
  return {
    id: row.id,
    name: row.name,
    destination: row.destination,
    startDate: row.start_date,
    endDate: row.end_date,
    status: row.status,
    budgetMinor: row.budget_minor === null || row.budget_minor === undefined
      ? undefined
      : Number(row.budget_minor),
    currency: row.currency,
    travelers: Array.isArray(row.travelers) ? row.travelers : [],
    progress: row.progress,
    accent: row.accent,
    notes: row.notes,
    version: row.version,
    updatedAt: row.updated_at.toISOString(),
  };
}

export function itineraryRowToDto(row) {
  return {
    id: row.id,
    tripId: row.trip_id,
    date: row.date,
    time: row.time,
    title: row.title,
    type: row.type,
    location: row.location ?? undefined,
    costMinor: row.cost_minor === null || row.cost_minor === undefined
      ? undefined
      : Number(row.cost_minor),
    booked: row.booked,
    notes: row.notes ?? undefined,
    version: row.version,
    updatedAt: row.updated_at.toISOString(),
  };
}

export function bookingRowToDto(row) {
  return {
    id: row.id,
    tripId: row.trip_id,
    itineraryItemId: row.itinerary_item_id ?? undefined,
    type: row.type,
    provider: row.provider,
    reference: row.reference,
    title: row.title,
    startAt: row.start_at.toISOString(),
    amountMinor: Number(row.amount_minor),
    paid: row.paid,
    version: row.version,
    updatedAt: row.updated_at.toISOString(),
  };
}

export function packingRowToDto(row) {
  return {
    id: row.id,
    tripId: row.trip_id,
    name: row.name,
    category: row.category,
    packed: row.packed,
    assignedTo: row.assigned_to ?? undefined,
    version: row.version,
    updatedAt: row.updated_at.toISOString(),
  };
}

const TRIP_SELECT_COLUMNS =
  "id, name, destination, start_date::text AS start_date, end_date::text AS end_date, status, " +
  "budget_minor, currency, travelers, progress, accent, notes, version, updated_at";
const ITINERARY_SELECT_COLUMNS =
  "id, trip_id, date::text AS date, time, title, type, location, cost_minor, booked, notes, " +
  "version, updated_at";
const BOOKING_SELECT_COLUMNS =
  "id, trip_id, itinerary_item_id, type, provider, reference, title, start_at, amount_minor, paid, " +
  "version, updated_at";
const PACKING_SELECT_COLUMNS =
  "id, trip_id, name, category, packed, assigned_to, version, updated_at";

// ---------------------------------------------------------------------------
// Payload validators per mutation `op`. Each returns a normalized object built only from allow-listed
// fields, or throws TripValidationError. None of them read/forward a `progress` field -- the server is
// its sole author (docs/plans/podroze-trips.md: "klient przestaje je nadpisywać").
// ---------------------------------------------------------------------------

export function validateTripCreatePayload(payload) {
  assertShape(isPlainObject(payload), "Nieprawidłowy ładunek mutacji", "INVALID_PAYLOAD");
  assertShape(isId(payload.id), "Nieprawidłowy identyfikator podróży", "INVALID_ID");
  assertShape(isNonEmptyText(payload.name, 500), "Nieprawidłowa nazwa podróży", "INVALID_NAME");
  assertShape(
    isNonEmptyText(payload.destination, 500),
    "Nieprawidłowy cel podróży",
    "INVALID_DESTINATION",
  );
  assertShape(isIsoDate(payload.startDate), "Nieprawidłowa data rozpoczęcia", "INVALID_START_DATE");
  assertShape(isIsoDate(payload.endDate), "Nieprawidłowa data zakończenia", "INVALID_END_DATE");
  assertShape(
    payload.endDate >= payload.startDate,
    "Data zakończenia nie może być wcześniejsza niż data rozpoczęcia",
    "INVALID_DATE_RANGE",
  );
  assertShape(TRIP_STATUSES.has(payload.status), "Nieprawidłowy status podróży", "INVALID_STATUS");
  if (payload.budgetMinor !== undefined && payload.budgetMinor !== null) {
    assertShape(
      isSafeMoney(payload.budgetMinor) && payload.budgetMinor >= 0,
      "Nieprawidłowy budżet podróży",
      "INVALID_BUDGET",
    );
  }
  assertShape(CURRENCIES.has(payload.currency), "Nieprawidłowa waluta", "INVALID_CURRENCY");
  assertShape(
    isTravelersArray(payload.travelers ?? []),
    "Nieprawidłowa lista podróżników",
    "INVALID_TRAVELERS",
  );
  assertShape(TRIP_ACCENTS.has(payload.accent), "Nieprawidłowy akcent kolorystyczny", "INVALID_ACCENT");
  if (payload.notes !== undefined && payload.notes !== null) {
    assertShape(
      typeof payload.notes === "string" && payload.notes.length <= 5000,
      "Nieprawidłowa notatka",
      "INVALID_NOTES",
    );
  }
  return {
    id: payload.id,
    name: payload.name.trim(),
    destination: payload.destination.trim(),
    startDate: payload.startDate,
    endDate: payload.endDate,
    status: payload.status,
    budgetMinor: payload.budgetMinor ?? null,
    currency: payload.currency,
    travelers: payload.travelers ?? [],
    accent: payload.accent,
    notes: (payload.notes ?? "").trim(),
  };
}

const TRIP_UPDATE_KEYS = new Set([
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
]);

// `progress` is deliberately not in TRIP_UPDATE_KEYS -- a client sending it is rejected as an
// unrecognized change (INVALID_CHANGES), the same choke point account.update uses for balanceMinor.
export function validateTripUpdatePayload(payload, baseVersion) {
  assertShape(isPlainObject(payload), "Nieprawidłowy ładunek mutacji", "INVALID_PAYLOAD");
  assertShape(isId(payload.id), "Nieprawidłowy identyfikator podróży", "INVALID_ID");
  assertShape(isPlainObject(payload.changes), "Brak zmian do zastosowania", "INVALID_CHANGES");
  for (const key of Object.keys(payload.changes)) {
    assertShape(TRIP_UPDATE_KEYS.has(key), `Pola "${key}" nie można edytować`, "INVALID_CHANGES");
  }
  const version = normalizeRequiredVersion(baseVersion);
  const changes = {};
  const c = payload.changes;
  if (c.name !== undefined) {
    assertShape(isNonEmptyText(c.name, 500), "Nieprawidłowa nazwa podróży", "INVALID_NAME");
    changes.name = c.name.trim();
  }
  if (c.destination !== undefined) {
    assertShape(isNonEmptyText(c.destination, 500), "Nieprawidłowy cel podróży", "INVALID_DESTINATION");
    changes.destination = c.destination.trim();
  }
  if (c.startDate !== undefined) {
    assertShape(isIsoDate(c.startDate), "Nieprawidłowa data rozpoczęcia", "INVALID_START_DATE");
    changes.startDate = c.startDate;
  }
  if (c.endDate !== undefined) {
    assertShape(isIsoDate(c.endDate), "Nieprawidłowa data zakończenia", "INVALID_END_DATE");
    changes.endDate = c.endDate;
  }
  if (changes.startDate !== undefined && changes.endDate !== undefined) {
    assertShape(
      changes.endDate >= changes.startDate,
      "Data zakończenia nie może być wcześniejsza niż data rozpoczęcia",
      "INVALID_DATE_RANGE",
    );
  }
  if (c.status !== undefined) {
    assertShape(TRIP_STATUSES.has(c.status), "Nieprawidłowy status podróży", "INVALID_STATUS");
    changes.status = c.status;
  }
  if (Object.prototype.hasOwnProperty.call(c, "budgetMinor")) {
    if (c.budgetMinor === null) {
      changes.budgetMinor = null;
    } else {
      assertShape(
        isSafeMoney(c.budgetMinor) && c.budgetMinor >= 0,
        "Nieprawidłowy budżet podróży",
        "INVALID_BUDGET",
      );
      changes.budgetMinor = c.budgetMinor;
    }
  }
  if (c.currency !== undefined) {
    assertShape(CURRENCIES.has(c.currency), "Nieprawidłowa waluta", "INVALID_CURRENCY");
    changes.currency = c.currency;
  }
  if (c.travelers !== undefined) {
    assertShape(isTravelersArray(c.travelers), "Nieprawidłowa lista podróżników", "INVALID_TRAVELERS");
    changes.travelers = c.travelers;
  }
  if (c.accent !== undefined) {
    assertShape(TRIP_ACCENTS.has(c.accent), "Nieprawidłowy akcent kolorystyczny", "INVALID_ACCENT");
    changes.accent = c.accent;
  }
  if (c.notes !== undefined) {
    assertShape(
      c.notes === null || (typeof c.notes === "string" && c.notes.length <= 5000),
      "Nieprawidłowa notatka",
      "INVALID_NOTES",
    );
    changes.notes = c.notes ?? "";
  }
  return { id: payload.id, changes, baseVersion: version };
}

export function validateDeleteIdPayload(payload) {
  assertShape(isPlainObject(payload), "Nieprawidłowy ładunek mutacji", "INVALID_PAYLOAD");
  assertShape(isId(payload.id), "Nieprawidłowy identyfikator", "INVALID_ID");
  return { id: payload.id };
}

export function validateItineraryCreatePayload(payload) {
  assertShape(isPlainObject(payload), "Nieprawidłowy ładunek mutacji", "INVALID_PAYLOAD");
  assertShape(isId(payload.id), "Nieprawidłowy identyfikator punktu planu", "INVALID_ID");
  assertShape(isId(payload.tripId), "Nieprawidłowy identyfikator podróży", "INVALID_TRIP_ID");
  assertShape(isIsoDate(payload.date), "Nieprawidłowa data punktu planu", "INVALID_DATE");
  assertShape(isClockTime(payload.time), "Nieprawidłowa godzina punktu planu", "INVALID_TIME");
  assertShape(isNonEmptyText(payload.title, 500), "Nieprawidłowy tytuł punktu planu", "INVALID_TITLE");
  assertShape(ITINERARY_TYPES.has(payload.type), "Nieprawidłowy typ punktu planu", "INVALID_TYPE");
  if (payload.location !== undefined && payload.location !== null) {
    assertShape(isOptionalText(payload.location, 500), "Nieprawidłowa lokalizacja", "INVALID_LOCATION");
  }
  if (payload.costMinor !== undefined && payload.costMinor !== null) {
    assertShape(
      isSafeMoney(payload.costMinor) && payload.costMinor >= 0,
      "Nieprawidłowy koszt",
      "INVALID_COST",
    );
  }
  if (payload.booked !== undefined) {
    assertShape(typeof payload.booked === "boolean", "Nieprawidłowa flaga rezerwacji", "INVALID_BOOKED");
  }
  if (payload.notes !== undefined && payload.notes !== null) {
    assertShape(isOptionalText(payload.notes, 5000), "Nieprawidłowa notatka", "INVALID_NOTES");
  }
  return {
    id: payload.id,
    tripId: payload.tripId,
    date: payload.date,
    time: payload.time,
    title: payload.title.trim(),
    type: payload.type,
    location: payload.location || undefined,
    costMinor: payload.costMinor ?? undefined,
    booked: Boolean(payload.booked),
    notes: payload.notes || undefined,
  };
}

export function validateBookingCreatePayload(payload) {
  assertShape(isPlainObject(payload), "Nieprawidłowy ładunek mutacji", "INVALID_PAYLOAD");
  assertShape(isId(payload.id), "Nieprawidłowy identyfikator rezerwacji", "INVALID_ID");
  assertShape(isId(payload.tripId), "Nieprawidłowy identyfikator podróży", "INVALID_TRIP_ID");
  // itinerary_item_id is deliberately not FK-checked -- deleting the plan point must not break the
  // booking (docs/plans/podroze-trips.md "Luźne itinerary_item_id w rezerwacjach"). Shape-only check.
  if (payload.itineraryItemId !== undefined && payload.itineraryItemId !== null) {
    assertShape(
      isId(payload.itineraryItemId),
      "Nieprawidłowy identyfikator punktu planu",
      "INVALID_ITINERARY_ITEM_ID",
    );
  }
  assertShape(BOOKING_TYPES.has(payload.type), "Nieprawidłowy typ rezerwacji", "INVALID_TYPE");
  if (payload.provider !== undefined && payload.provider !== null) {
    assertShape(isOptionalText(payload.provider, 500), "Nieprawidłowy dostawca", "INVALID_PROVIDER");
  }
  if (payload.reference !== undefined && payload.reference !== null) {
    assertShape(isOptionalText(payload.reference, 500), "Nieprawidłowy numer referencyjny", "INVALID_REFERENCE");
  }
  assertShape(isNonEmptyText(payload.title, 500), "Nieprawidłowy tytuł rezerwacji", "INVALID_TITLE");
  assertShape(isIsoDateTime(payload.startAt), "Nieprawidłowa data/godzina rezerwacji", "INVALID_START_AT");
  assertShape(
    isSafeMoney(payload.amountMinor) && payload.amountMinor >= 0,
    "Nieprawidłowa kwota rezerwacji",
    "INVALID_AMOUNT",
  );
  if (payload.paid !== undefined) {
    assertShape(typeof payload.paid === "boolean", "Nieprawidłowa flaga opłacenia", "INVALID_PAID");
  }
  return {
    id: payload.id,
    tripId: payload.tripId,
    itineraryItemId: payload.itineraryItemId || undefined,
    type: payload.type,
    provider: (payload.provider ?? "").trim(),
    reference: (payload.reference ?? "").trim(),
    title: payload.title.trim(),
    startAt: payload.startAt,
    amountMinor: payload.amountMinor,
    paid: Boolean(payload.paid),
  };
}

// UI only ever exposes toggling `paid` today (TripsPage.tsx), but the update op accepts the full set
// of editable booking fields (parity with how account.update exposes more than the UI currently uses).
const BOOKING_UPDATE_KEYS = new Set([
  "type",
  "provider",
  "reference",
  "title",
  "startAt",
  "amountMinor",
  "paid",
]);

export function validateBookingUpdatePayload(payload, baseVersion) {
  assertShape(isPlainObject(payload), "Nieprawidłowy ładunek mutacji", "INVALID_PAYLOAD");
  assertShape(isId(payload.id), "Nieprawidłowy identyfikator rezerwacji", "INVALID_ID");
  assertShape(isPlainObject(payload.changes), "Brak zmian do zastosowania", "INVALID_CHANGES");
  for (const key of Object.keys(payload.changes)) {
    assertShape(BOOKING_UPDATE_KEYS.has(key), `Pola "${key}" nie można edytować`, "INVALID_CHANGES");
  }
  const version = normalizeRequiredVersion(baseVersion);
  const changes = {};
  const c = payload.changes;
  if (c.type !== undefined) {
    assertShape(BOOKING_TYPES.has(c.type), "Nieprawidłowy typ rezerwacji", "INVALID_TYPE");
    changes.type = c.type;
  }
  if (c.provider !== undefined) {
    assertShape(isOptionalText(c.provider ?? "", 500), "Nieprawidłowy dostawca", "INVALID_PROVIDER");
    changes.provider = c.provider ?? "";
  }
  if (c.reference !== undefined) {
    assertShape(isOptionalText(c.reference ?? "", 500), "Nieprawidłowy numer referencyjny", "INVALID_REFERENCE");
    changes.reference = c.reference ?? "";
  }
  if (c.title !== undefined) {
    assertShape(isNonEmptyText(c.title, 500), "Nieprawidłowy tytuł rezerwacji", "INVALID_TITLE");
    changes.title = c.title.trim();
  }
  if (c.startAt !== undefined) {
    assertShape(isIsoDateTime(c.startAt), "Nieprawidłowa data/godzina rezerwacji", "INVALID_START_AT");
    changes.startAt = c.startAt;
  }
  if (c.amountMinor !== undefined) {
    assertShape(
      isSafeMoney(c.amountMinor) && c.amountMinor >= 0,
      "Nieprawidłowa kwota rezerwacji",
      "INVALID_AMOUNT",
    );
    changes.amountMinor = c.amountMinor;
  }
  if (c.paid !== undefined) {
    assertShape(typeof c.paid === "boolean", "Nieprawidłowa flaga opłacenia", "INVALID_PAID");
    changes.paid = c.paid;
  }
  return { id: payload.id, changes, baseVersion: version };
}

export function validatePackingCreatePayload(payload) {
  assertShape(isPlainObject(payload), "Nieprawidłowy ładunek mutacji", "INVALID_PAYLOAD");
  assertShape(isId(payload.id), "Nieprawidłowy identyfikator przedmiotu", "INVALID_ID");
  assertShape(isId(payload.tripId), "Nieprawidłowy identyfikator podróży", "INVALID_TRIP_ID");
  assertShape(isNonEmptyText(payload.name, 500), "Nieprawidłowa nazwa przedmiotu", "INVALID_NAME");
  assertShape(PACKING_CATEGORIES.has(payload.category), "Nieprawidłowa kategoria", "INVALID_CATEGORY");
  if (payload.packed !== undefined) {
    assertShape(typeof payload.packed === "boolean", "Nieprawidłowa flaga spakowania", "INVALID_PACKED");
  }
  if (payload.assignedTo !== undefined && payload.assignedTo !== null) {
    assertShape(isOptionalText(payload.assignedTo, 500), "Nieprawidłowy przypisany podróżnik", "INVALID_ASSIGNED_TO");
  }
  return {
    id: payload.id,
    tripId: payload.tripId,
    name: payload.name.trim(),
    category: payload.category,
    packed: Boolean(payload.packed),
    assignedTo: payload.assignedTo || undefined,
  };
}

// Parity with today's UI (togglePackingItem -> `changes: { packed }`; the bulk `assignedTo` rename on
// traveler-name edit -> a series of `packing.update` with `changes: { assignedTo }`). No other field is
// edited in place today (YAGNI, docs/plans/podroze-trips.md Non-goals).
const PACKING_UPDATE_KEYS = new Set(["packed", "assignedTo"]);

export function validatePackingUpdatePayload(payload, baseVersion) {
  assertShape(isPlainObject(payload), "Nieprawidłowy ładunek mutacji", "INVALID_PAYLOAD");
  assertShape(isId(payload.id), "Nieprawidłowy identyfikator przedmiotu", "INVALID_ID");
  assertShape(isPlainObject(payload.changes), "Brak zmian do zastosowania", "INVALID_CHANGES");
  for (const key of Object.keys(payload.changes)) {
    assertShape(PACKING_UPDATE_KEYS.has(key), `Pola "${key}" nie można edytować`, "INVALID_CHANGES");
  }
  const version = normalizeRequiredVersion(baseVersion);
  const changes = {};
  const c = payload.changes;
  if (c.packed !== undefined) {
    assertShape(typeof c.packed === "boolean", "Nieprawidłowa flaga spakowania", "INVALID_PACKED");
    changes.packed = c.packed;
  }
  if (Object.prototype.hasOwnProperty.call(c, "assignedTo")) {
    if (c.assignedTo === null) {
      changes.assignedTo = null;
    } else {
      assertShape(isOptionalText(c.assignedTo, 500), "Nieprawidłowy przypisany podróżnik", "INVALID_ASSIGNED_TO");
      changes.assignedTo = c.assignedTo;
    }
  }
  return { id: payload.id, changes, baseVersion: version };
}

// ---------------------------------------------------------------------------
// Mutation envelope + supported ops
// ---------------------------------------------------------------------------

export const SUPPORTED_TRIP_OPS = new Set([
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

// Whole-request-shape validation, mirroring assertFinanceMutationShape: called once per mutation
// BEFORE any DB work starts, so one malformed entry can't partially poison sibling mutations'
// bookkeeping. Per-mutation *business* validation (bad field values, missing trip, ...) is reported as
// `status: "error"` inside `results` by applyTripMutation instead.
export function assertTripMutationShape(mutation) {
  if (!isPlainObject(mutation)) {
    throw tripRequestError(400, "Nieprawidłowy kształt mutacji", "INVALID_TRIP_MUTATION");
  }
  if (typeof mutation.idempotencyKey !== "string" || !UUID_PATTERN.test(mutation.idempotencyKey)) {
    throw tripRequestError(400, "Nieprawidłowy klucz idempotencji", "INVALID_IDEMPOTENCY_KEY");
  }
  if (typeof mutation.op !== "string" || !SUPPORTED_TRIP_OPS.has(mutation.op)) {
    throw tripRequestError(400, "Nieobsługiwana operacja mutacji", "UNSUPPORTED_OP");
  }
  if (!isPlainObject(mutation.payload)) {
    throw tripRequestError(400, "Brak danych mutacji", "INVALID_TRIP_MUTATION");
  }
  if (
    mutation.baseVersion !== undefined &&
    mutation.baseVersion !== null &&
    !Number.isInteger(mutation.baseVersion)
  ) {
    throw tripRequestError(400, "Nieprawidłowa wersja bazowa mutacji", "INVALID_TRIP_MUTATION");
  }
}

export const MAX_TRIP_MUTATIONS_PER_BATCH = Number(process.env.MAX_TRIP_MUTATIONS ?? 500);
export const MAX_TRIP_MUTATIONS_BYTES = Number(process.env.MAX_TRIP_MUTATIONS_BYTES ?? 2_000_000);

// ---------------------------------------------------------------------------
// Snapshot read (GET /api/v1/trips): whole household, no visibility filter -- trips are always shared.
// ---------------------------------------------------------------------------

export async function readTripsSnapshot(client, householdId) {
  // Sequential, not Promise.all: `client` may be a single-connection PoolClient, and node-postgres
  // only supports one in-flight query per connection (see finance.mjs's readFinanceSnapshot).
  const trips = await client.query(
    `SELECT ${TRIP_SELECT_COLUMNS} FROM trips WHERE household_id = $1 ORDER BY start_date, created_at`,
    [householdId],
  );
  const itinerary = await client.query(
    `SELECT ${ITINERARY_SELECT_COLUMNS} FROM trip_itinerary WHERE household_id = $1
      ORDER BY date, time, created_at`,
    [householdId],
  );
  const bookings = await client.query(
    `SELECT ${BOOKING_SELECT_COLUMNS} FROM trip_bookings WHERE household_id = $1 ORDER BY start_at`,
    [householdId],
  );
  const packing = await client.query(
    `SELECT ${PACKING_SELECT_COLUMNS} FROM packing_items WHERE household_id = $1 ORDER BY created_at`,
    [householdId],
  );
  return {
    trips: trips.rows.map(tripRowToDto),
    itinerary: itinerary.rows.map(itineraryRowToDto),
    bookings: bookings.rows.map(bookingRowToDto),
    packing: packing.rows.map(packingRowToDto),
  };
}

// Wspiera "Wyczyść dane aplikacji" (SettingsPage.tsx danger zone). Simpler than Finance's equivalent:
// trips have no private records at all, so this unconditionally clears the whole household's trip data
// -- itinerary/bookings/packing cascade-delete via the trips FK (ON DELETE CASCADE).
export async function resetTripsForHousehold(client, householdId) {
  await client.query(`DELETE FROM trips WHERE household_id = $1`, [householdId]);
}

// ---------------------------------------------------------------------------
// Shared OCC/conflict resolution helpers used by every update/delete op (mirrors finance.mjs).
// ---------------------------------------------------------------------------

async function resolveConflictOrError(
  client,
  query,
  params,
  mapper,
  notFoundMessage,
  notFoundCode,
) {
  const existing = await client.query(query, params);
  if (existing.rowCount) {
    const row = existing.rows[0];
    return { status: "conflict", record: mapper(row), currentVersion: row.version };
  }
  return { status: "error", error: notFoundMessage, code: notFoundCode };
}

// Deletion is idempotent by design (plan: "dla delete: jeśli rekord już zniknął, potraktuj jako
// sukces") -- a missing row is `applied`, not an error.
async function resolveConflictOrGone(client, query, params, mapper) {
  const existing = await client.query(query, params);
  if (!existing.rowCount) return { status: "applied", record: null };
  const row = existing.rows[0];
  return { status: "conflict", record: mapper(row), currentVersion: row.version };
}

// ---------------------------------------------------------------------------
// Server-authoritative `progress` recompute (docs/plans/podroze-trips.md "Projekt `progress`", Opcja
// B). Always called from inside the SAME transaction as the child mutation that can affect it. Does
// NOT touch `trips.version` -- progress recompute never consumes the parent's OCC token (two
// concurrent itinerary.create calls on the same trip both apply and both count toward progress).
// Returns the updated Trip DTO, or null if the trip no longer exists (defensive; shouldn't happen since
// callers already confirmed the trip row via the FK/household check before invoking this).
// ---------------------------------------------------------------------------

async function recomputeTripProgress(client, tripId, householdId) {
  const tripResult = await client.query(`SELECT status FROM trips WHERE id = $1 AND household_id = $2`, [
    tripId,
    householdId,
  ]);
  if (!tripResult.rowCount) return null;
  const status = tripResult.rows[0].status;
  const itineraryCount = await client.query(
    `SELECT count(*)::int AS count FROM trip_itinerary WHERE trip_id = $1`,
    [tripId],
  );
  const bookingCount = await client.query(
    `SELECT count(*)::int AS count FROM trip_bookings WHERE trip_id = $1`,
    [tripId],
  );
  const progress = computeTripProgress(
    status,
    itineraryCount.rows[0].count,
    bookingCount.rows[0].count,
  );
  const updated = await client.query(
    `UPDATE trips SET progress = $1, updated_at = now() WHERE id = $2 AND household_id = $3
     RETURNING ${TRIP_SELECT_COLUMNS}`,
    [progress, tripId, householdId],
  );
  return updated.rows[0] ? tripRowToDto(updated.rows[0]) : null;
}

// ---------------------------------------------------------------------------
// Per-op SQL execution. Each function assumes payload/baseVersion have already been shape-checked by
// assertTripMutationShape; they still run their own (business-rule) validators and throw
// TripValidationError on bad input, which applyTripMutation turns into `status: "error"`.
// ---------------------------------------------------------------------------

async function execTripCreate(client, ctx, payload) {
  const data = validateTripCreatePayload(payload);
  const initialProgress = computeTripProgress(data.status, 0, 0);
  try {
    const inserted = await client.query(
      `INSERT INTO trips
         (id, household_id, name, destination, start_date, end_date, status, budget_minor, currency,
          travelers, progress, accent, notes, version, updated_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11, $12, $13, 1, $14)
       RETURNING ${TRIP_SELECT_COLUMNS}`,
      [
        data.id,
        ctx.householdId,
        data.name,
        data.destination,
        data.startDate,
        data.endDate,
        data.status,
        data.budgetMinor,
        data.currency,
        JSON.stringify(data.travelers),
        initialProgress,
        data.accent,
        data.notes,
        ctx.userId,
      ],
    );
    return { status: "applied", record: tripRowToDto(inserted.rows[0]) };
  } catch (error) {
    if (error.code === "23505") {
      return resolveConflictOrError(
        client,
        `SELECT ${TRIP_SELECT_COLUMNS} FROM trips WHERE id = $1 AND household_id = $2`,
        [data.id, ctx.householdId],
        tripRowToDto,
        "Identyfikator jest już używany",
        "ID_TAKEN",
      );
    }
    throw error;
  }
}

async function execTripUpdate(client, ctx, payload, baseVersion) {
  const { id, changes, baseVersion: version } = validateTripUpdatePayload(payload, baseVersion);
  const hasBudgetChange = Object.prototype.hasOwnProperty.call(changes, "budgetMinor");
  const updated = await client.query(
    `UPDATE trips
        SET name = COALESCE($1, name),
            destination = COALESCE($2, destination),
            start_date = COALESCE($3, start_date),
            end_date = COALESCE($4, end_date),
            status = COALESCE($5, status),
            budget_minor = CASE WHEN $6 THEN $7 ELSE budget_minor END,
            currency = COALESCE($8, currency),
            travelers = COALESCE($9::jsonb, travelers),
            accent = COALESCE($10, accent),
            notes = COALESCE($11, notes),
            version = version + 1,
            updated_at = now(),
            updated_by = $12
      WHERE id = $13 AND household_id = $14 AND version = $15
      RETURNING ${TRIP_SELECT_COLUMNS}`,
    [
      changes.name ?? null,
      changes.destination ?? null,
      changes.startDate ?? null,
      changes.endDate ?? null,
      changes.status ?? null,
      hasBudgetChange,
      hasBudgetChange ? changes.budgetMinor : null,
      changes.currency ?? null,
      changes.travelers !== undefined ? JSON.stringify(changes.travelers) : null,
      changes.accent ?? null,
      changes.notes ?? null,
      ctx.userId,
      id,
      ctx.householdId,
      version,
    ],
  );
  if (!updated.rowCount) {
    return resolveConflictOrError(
      client,
      `SELECT ${TRIP_SELECT_COLUMNS} FROM trips WHERE id = $1 AND household_id = $2`,
      [id, ctx.householdId],
      tripRowToDto,
      "Rekord nie istnieje lub jest niedostępny",
      "NOT_FOUND",
    );
  }
  let record = tripRowToDto(updated.rows[0]);
  // Status change can move the base of the progress formula (and archived forces 100) -- recompute
  // from authoritative child counts in the same transaction (plan: "trip.update gdy zmienia się status").
  if (Object.prototype.hasOwnProperty.call(changes, "status")) {
    const recomputed = await recomputeTripProgress(client, id, ctx.householdId);
    if (recomputed) record = recomputed;
  }
  return { status: "applied", record };
}

async function execTripDelete(client, ctx, payload, baseVersion) {
  const { id } = validateDeleteIdPayload(payload);
  const version = normalizeOptionalVersion(baseVersion);
  const deleted = await client.query(
    `DELETE FROM trips WHERE id = $1 AND household_id = $2 AND ($3::integer IS NULL OR version = $3)
     RETURNING id`,
    [id, ctx.householdId, version],
  );
  if (deleted.rowCount) return { status: "applied", record: null };
  return resolveConflictOrGone(
    client,
    `SELECT ${TRIP_SELECT_COLUMNS} FROM trips WHERE id = $1 AND household_id = $2`,
    [id, ctx.householdId],
    tripRowToDto,
  );
}

async function execItineraryCreate(client, ctx, payload) {
  const data = validateItineraryCreatePayload(payload);
  const tripCheck = await client.query(`SELECT id FROM trips WHERE id = $1 AND household_id = $2`, [
    data.tripId,
    ctx.householdId,
  ]);
  if (!tripCheck.rowCount) {
    return { status: "error", error: "Podróż nie istnieje lub jest niedostępna", code: "TRIP_NOT_FOUND" };
  }
  try {
    const inserted = await client.query(
      `INSERT INTO trip_itinerary
         (id, household_id, trip_id, date, time, title, type, location, cost_minor, booked, notes,
          version, updated_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 1, $12)
       RETURNING ${ITINERARY_SELECT_COLUMNS}`,
      [
        data.id,
        ctx.householdId,
        data.tripId,
        data.date,
        data.time,
        data.title,
        data.type,
        data.location ?? null,
        data.costMinor ?? null,
        data.booked,
        data.notes ?? null,
        ctx.userId,
      ],
    );
    const trip = await recomputeTripProgress(client, data.tripId, ctx.householdId);
    return {
      status: "applied",
      record: itineraryRowToDto(inserted.rows[0]),
      trip: trip ?? undefined,
    };
  } catch (error) {
    if (error.code === "23505") {
      return resolveConflictOrError(
        client,
        `SELECT ${ITINERARY_SELECT_COLUMNS} FROM trip_itinerary WHERE id = $1 AND household_id = $2`,
        [data.id, ctx.householdId],
        itineraryRowToDto,
        "Identyfikator jest już używany",
        "ID_TAKEN",
      );
    }
    throw error;
  }
}

async function execItineraryDelete(client, ctx, payload, baseVersion) {
  const { id } = validateDeleteIdPayload(payload);
  const version = normalizeOptionalVersion(baseVersion);
  const deleted = await client.query(
    `DELETE FROM trip_itinerary
      WHERE id = $1 AND household_id = $2 AND ($3::integer IS NULL OR version = $3)
     RETURNING trip_id`,
    [id, ctx.householdId, version],
  );
  if (!deleted.rowCount) {
    return resolveConflictOrGone(
      client,
      `SELECT ${ITINERARY_SELECT_COLUMNS} FROM trip_itinerary WHERE id = $1 AND household_id = $2`,
      [id, ctx.householdId],
      itineraryRowToDto,
    );
  }
  const trip = await recomputeTripProgress(client, deleted.rows[0].trip_id, ctx.householdId);
  return { status: "applied", record: null, trip: trip ?? undefined };
}

async function execBookingCreate(client, ctx, payload) {
  const data = validateBookingCreatePayload(payload);
  const tripCheck = await client.query(`SELECT id FROM trips WHERE id = $1 AND household_id = $2`, [
    data.tripId,
    ctx.householdId,
  ]);
  if (!tripCheck.rowCount) {
    return { status: "error", error: "Podróż nie istnieje lub jest niedostępna", code: "TRIP_NOT_FOUND" };
  }
  try {
    const inserted = await client.query(
      `INSERT INTO trip_bookings
         (id, household_id, trip_id, itinerary_item_id, type, provider, reference, title, start_at,
          amount_minor, paid, version, updated_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 1, $12)
       RETURNING ${BOOKING_SELECT_COLUMNS}`,
      [
        data.id,
        ctx.householdId,
        data.tripId,
        data.itineraryItemId ?? null,
        data.type,
        data.provider,
        data.reference,
        data.title,
        data.startAt,
        data.amountMinor,
        data.paid,
        ctx.userId,
      ],
    );
    const trip = await recomputeTripProgress(client, data.tripId, ctx.householdId);
    return {
      status: "applied",
      record: bookingRowToDto(inserted.rows[0]),
      trip: trip ?? undefined,
    };
  } catch (error) {
    if (error.code === "23505") {
      return resolveConflictOrError(
        client,
        `SELECT ${BOOKING_SELECT_COLUMNS} FROM trip_bookings WHERE id = $1 AND household_id = $2`,
        [data.id, ctx.householdId],
        bookingRowToDto,
        "Identyfikator jest już używany",
        "ID_TAKEN",
      );
    }
    throw error;
  }
}

async function execBookingUpdate(client, ctx, payload, baseVersion) {
  const { id, changes, baseVersion: version } = validateBookingUpdatePayload(payload, baseVersion);
  const updated = await client.query(
    `UPDATE trip_bookings
        SET type = COALESCE($1, type),
            provider = COALESCE($2, provider),
            reference = COALESCE($3, reference),
            title = COALESCE($4, title),
            start_at = COALESCE($5, start_at),
            amount_minor = COALESCE($6, amount_minor),
            paid = COALESCE($7, paid),
            version = version + 1,
            updated_at = now(),
            updated_by = $8
      WHERE id = $9 AND household_id = $10 AND version = $11
      RETURNING ${BOOKING_SELECT_COLUMNS}`,
    [
      changes.type ?? null,
      changes.provider ?? null,
      changes.reference ?? null,
      changes.title ?? null,
      changes.startAt ?? null,
      changes.amountMinor ?? null,
      changes.paid ?? null,
      ctx.userId,
      id,
      ctx.householdId,
      version,
    ],
  );
  if (updated.rowCount) return { status: "applied", record: bookingRowToDto(updated.rows[0]) };
  return resolveConflictOrError(
    client,
    `SELECT ${BOOKING_SELECT_COLUMNS} FROM trip_bookings WHERE id = $1 AND household_id = $2`,
    [id, ctx.householdId],
    bookingRowToDto,
    "Rekord nie istnieje lub jest niedostępny",
    "NOT_FOUND",
  );
}

async function execBookingDelete(client, ctx, payload, baseVersion) {
  const { id } = validateDeleteIdPayload(payload);
  const version = normalizeOptionalVersion(baseVersion);
  const deleted = await client.query(
    `DELETE FROM trip_bookings
      WHERE id = $1 AND household_id = $2 AND ($3::integer IS NULL OR version = $3)
     RETURNING trip_id`,
    [id, ctx.householdId, version],
  );
  if (!deleted.rowCount) {
    return resolveConflictOrGone(
      client,
      `SELECT ${BOOKING_SELECT_COLUMNS} FROM trip_bookings WHERE id = $1 AND household_id = $2`,
      [id, ctx.householdId],
      bookingRowToDto,
    );
  }
  const trip = await recomputeTripProgress(client, deleted.rows[0].trip_id, ctx.householdId);
  return { status: "applied", record: null, trip: trip ?? undefined };
}

async function execPackingCreate(client, ctx, payload) {
  const data = validatePackingCreatePayload(payload);
  const tripCheck = await client.query(`SELECT id FROM trips WHERE id = $1 AND household_id = $2`, [
    data.tripId,
    ctx.householdId,
  ]);
  if (!tripCheck.rowCount) {
    return { status: "error", error: "Podróż nie istnieje lub jest niedostępna", code: "TRIP_NOT_FOUND" };
  }
  try {
    const inserted = await client.query(
      `INSERT INTO packing_items (id, household_id, trip_id, name, category, packed, assigned_to, version, updated_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 1, $8)
       RETURNING ${PACKING_SELECT_COLUMNS}`,
      [
        data.id,
        ctx.householdId,
        data.tripId,
        data.name,
        data.category,
        data.packed,
        data.assignedTo ?? null,
        ctx.userId,
      ],
    );
    return { status: "applied", record: packingRowToDto(inserted.rows[0]) };
  } catch (error) {
    if (error.code === "23505") {
      return resolveConflictOrError(
        client,
        `SELECT ${PACKING_SELECT_COLUMNS} FROM packing_items WHERE id = $1 AND household_id = $2`,
        [data.id, ctx.householdId],
        packingRowToDto,
        "Identyfikator jest już używany",
        "ID_TAKEN",
      );
    }
    throw error;
  }
}

async function execPackingUpdate(client, ctx, payload, baseVersion) {
  const { id, changes, baseVersion: version } = validatePackingUpdatePayload(payload, baseVersion);
  const hasAssignedToChange = Object.prototype.hasOwnProperty.call(changes, "assignedTo");
  const updated = await client.query(
    `UPDATE packing_items
        SET packed = COALESCE($1, packed),
            assigned_to = CASE WHEN $2 THEN $3 ELSE assigned_to END,
            version = version + 1,
            updated_at = now(),
            updated_by = $4
      WHERE id = $5 AND household_id = $6 AND version = $7
      RETURNING ${PACKING_SELECT_COLUMNS}`,
    [
      changes.packed ?? null,
      hasAssignedToChange,
      hasAssignedToChange ? changes.assignedTo : null,
      ctx.userId,
      id,
      ctx.householdId,
      version,
    ],
  );
  if (updated.rowCount) return { status: "applied", record: packingRowToDto(updated.rows[0]) };
  return resolveConflictOrError(
    client,
    `SELECT ${PACKING_SELECT_COLUMNS} FROM packing_items WHERE id = $1 AND household_id = $2`,
    [id, ctx.householdId],
    packingRowToDto,
    "Rekord nie istnieje lub jest niedostępny",
    "NOT_FOUND",
  );
}

async function execPackingDelete(client, ctx, payload, baseVersion) {
  const { id } = validateDeleteIdPayload(payload);
  const version = normalizeOptionalVersion(baseVersion);
  const deleted = await client.query(
    `DELETE FROM packing_items
      WHERE id = $1 AND household_id = $2 AND ($3::integer IS NULL OR version = $3)
     RETURNING id`,
    [id, ctx.householdId, version],
  );
  if (deleted.rowCount) return { status: "applied", record: null };
  return resolveConflictOrGone(
    client,
    `SELECT ${PACKING_SELECT_COLUMNS} FROM packing_items WHERE id = $1 AND household_id = $2`,
    [id, ctx.householdId],
    packingRowToDto,
  );
}

async function executeTripOp(client, ctx, op, payload, baseVersion) {
  switch (op) {
    case "trip.create":
      return execTripCreate(client, ctx, payload);
    case "trip.update":
      return execTripUpdate(client, ctx, payload, baseVersion);
    case "trip.delete":
      return execTripDelete(client, ctx, payload, baseVersion);
    case "itinerary.create":
      return execItineraryCreate(client, ctx, payload);
    case "itinerary.delete":
      return execItineraryDelete(client, ctx, payload, baseVersion);
    case "booking.create":
      return execBookingCreate(client, ctx, payload);
    case "booking.update":
      return execBookingUpdate(client, ctx, payload, baseVersion);
    case "booking.delete":
      return execBookingDelete(client, ctx, payload, baseVersion);
    case "packing.create":
      return execPackingCreate(client, ctx, payload);
    case "packing.update":
      return execPackingUpdate(client, ctx, payload, baseVersion);
    case "packing.delete":
      return execPackingDelete(client, ctx, payload, baseVersion);
    default:
      // Unreachable when called through applyTripMutation (assertTripMutationShape already rejected
      // unknown ops at the request level); kept defensive in case of direct unit-test calls.
      throw new TripValidationError(`Nieobsługiwana operacja: ${op}`, "UNSUPPORTED_OP");
  }
}

// ---------------------------------------------------------------------------
// Idempotent mutation entry point. `mutation` is assumed to already have passed
// assertTripMutationShape (server.mjs validates the whole batch upfront). ctx = { householdId, userId }
// always comes from the authenticated session, never from the request body.
// ---------------------------------------------------------------------------

export async function applyTripMutation(client, ctx, mutation) {
  const { idempotencyKey, op, payload, baseVersion } = mutation;

  // Claim the idempotency key first, inside the same DB transaction as the operation itself: if the op
  // below throws, the whole transaction (including this claim) rolls back, so the key remains free to
  // retry. If a row already existed, this was a retry -- return the previously stored result instead of
  // running the operation again.
  const claim = await client.query(
    `INSERT INTO trip_mutations (idempotency_key, household_id, user_id, op, result)
     VALUES ($1, $2, $3, $4, '{}'::jsonb)
     ON CONFLICT (idempotency_key) DO NOTHING`,
    [idempotencyKey, ctx.householdId, ctx.userId, op],
  );
  if (!claim.rowCount) {
    const existing = await client.query(`SELECT result FROM trip_mutations WHERE idempotency_key = $1`, [
      idempotencyKey,
    ]);
    return existing.rows[0]?.result ?? { idempotencyKey, status: "duplicate" };
  }

  let outcome;
  try {
    outcome = await executeTripOp(client, ctx, op, payload, baseVersion);
  } catch (error) {
    if (error instanceof TripValidationError) {
      outcome = { status: "error", error: error.message, code: error.code };
    } else {
      throw error;
    }
  }

  const result = { idempotencyKey, ...outcome };
  await client.query(`UPDATE trip_mutations SET result = $1::jsonb WHERE idempotency_key = $2`, [
    JSON.stringify(result),
    idempotencyKey,
  ]);
  return result;
}
