// Domain layer for the normalized Car (Auto) module.
//
// Data model: server/migrations/009_car_normalized.sql (vehicles, car_expenses, vehicle_deadlines,
// car_mutations). Design source of truth: docs/plans/auto-car.md ("Podejście" section).
//
// This is the Car analogue of server/src/finance.mjs (owner_id/visibility preserved, unlike
// trips.mjs/meals.mjs which dropped it) mixed with server/src/trips.mjs's parent+children shape
// (vehicle -> car_expenses/vehicle_deadlines by vehicle_id). Two structural differences from both:
//   1. `Vehicle.mileage` is NOT editable through vehicle.update -- it moves exclusively through the
//      dedicated `vehicle.mileage` mutation (monotonic `GREATEST`, no baseVersion, no version bump) and
//      as a side effect of `expense.create` when the payload carries a `mileage`. This mirrors
//      `balanceMinor` being cut out of `account.update` in finance.mjs.
//   2. `vehicle_deadlines` has NO owner_id/visibility columns at all -- it inherits visibility from its
//      parent vehicle. Every access/conflict query against it filters through `EXISTS` on `vehicles`
//      instead of a `visibility = 'household' OR owner_id = $user` clause on its own row.
//
// Like finance.mjs/trips.mjs, this module intentionally does NOT import the zod schemas from
// src/lib/schema.ts: the server package has no TypeScript build step and no zod dependency. The
// validators below hand-roll the same rules as `vehicleSchema`/`carExpenseSchema`/`vehicleDeadlineSchema`
// in src/lib/schema.ts, scoped to the subset of fields a mutation payload carries.
//
// Every exported function here is either pure (validators, resolveOwnerId, resolveExpenseVisibility,
// resolveVersionConflict, row->DTO mappers) or takes an already-connected `client` (a pg PoolClient, or
// the shared `pool` from db.mjs) so it can run either inside a transaction() or directly against the pool.

import { randomUUID } from "node:crypto";

export class CarValidationError extends Error {
  constructor(message, code = "VALIDATION_ERROR") {
    super(message);
    this.name = "CarValidationError";
    this.code = code;
  }
}

function carRequestError(statusCode, message, code) {
  const error = new Error(message);
  error.statusCode = statusCode;
  error.code = code;
  return error;
}

// ---------------------------------------------------------------------------
// Primitive validators (mirror src/lib/schema.ts / src/carTypes.ts)
// ---------------------------------------------------------------------------

const ID_MAX_LENGTH = 200;
const VISIBILITIES = new Set(["private", "household"]);
const FUEL_TYPES = new Set(["petrol", "diesel", "hybrid", "electric"]);
const EXPENSE_TYPES = new Set(["fuel", "service", "insurance", "parking", "other"]);
const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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

function isNonNegativeInteger(value) {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
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

function assertShape(condition, message, code) {
  if (!condition) throw new CarValidationError(message, code);
}

// ---------------------------------------------------------------------------
// Security invariants (docs/ARCHITECTURE.md "Dane wspólne i prywatne")
// ---------------------------------------------------------------------------

// owner_id is always derived from the authenticated session -- a client-supplied ownerId in the
// mutation payload (if present) is always ignored. This is the single choke point that enforces it
// (parity with finance.mjs's resolveOwnerId).
export function resolveOwnerId(ctx) {
  return ctx.userId;
}

// expense.create without an explicit visibility inherits it from the parent vehicle (today's UI
// behavior, preserved 1:1 -- wzór resolveTransactionVisibility, finance.mjs).
export function resolveExpenseVisibility(payloadVisibility, vehicleVisibility) {
  return payloadVisibility === "private" || payloadVisibility === "household"
    ? payloadVisibility
    : vehicleVisibility;
}

// Pure helper naming the core OCC decision explicitly, unit-testable in isolation (mirrors
// finance.mjs's resolveVersionConflict). The authoritative check always happens in SQL
// (`WHERE version = $baseVersion`).
export function resolveVersionConflict(baseVersion, currentVersion) {
  return Number(baseVersion) === Number(currentVersion);
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
// Row -> DTO mapping (snake_case columns -> the Vehicle/CarExpense/VehicleDeadline shapes in
// src/carTypes.ts). `bigint` columns arrive from node-postgres as strings, coerced with Number();
// `date` columns are cast to text in SQL (`::text`) to dodge node-postgres's local-timezone Date
// parsing; `timestamptz` columns are safe to read as JS Date and converted with `.toISOString()`.
// ---------------------------------------------------------------------------

export function vehicleRowToDto(row) {
  return {
    id: row.id,
    ownerId: row.owner_id,
    visibility: row.visibility,
    name: row.name,
    make: row.make,
    model: row.model,
    year: row.year,
    plate: row.plate,
    mileage: row.mileage,
    fuelType: row.fuel_type,
    inspectionDate: row.inspection_date,
    insuranceDate: row.insurance_date,
    color: row.color,
    version: row.version,
    updatedAt: row.updated_at.toISOString(),
  };
}

export function carExpenseRowToDto(row) {
  return {
    id: row.id,
    ownerId: row.owner_id,
    visibility: row.visibility,
    vehicleId: row.vehicle_id,
    date: row.date,
    type: row.type,
    amountMinor: Number(row.amount_minor),
    mileage: row.mileage ?? undefined,
    liters: row.liters ?? undefined,
    title: row.title,
    version: row.version,
    updatedAt: row.updated_at.toISOString(),
  };
}

export function vehicleDeadlineRowToDto(row) {
  return {
    id: row.id,
    vehicleId: row.vehicle_id,
    kind: row.kind,
    title: row.title,
    dueDate: row.due_date ?? undefined,
    dueMileage: row.due_mileage ?? undefined,
    completed: row.completed,
    version: row.version,
    updatedAt: row.updated_at.toISOString(),
  };
}

const VEHICLE_SELECT_COLUMNS =
  "id, owner_id, visibility, name, make, model, year, plate, mileage, fuel_type, " +
  "inspection_date::text AS inspection_date, insurance_date::text AS insurance_date, color, " +
  "version, updated_at";
const CAR_EXPENSE_SELECT_COLUMNS =
  "id, owner_id, visibility, vehicle_id, date::text AS date, type, amount_minor, mileage, liters, " +
  "title, version, updated_at";
const DEADLINE_SELECT_COLUMNS =
  "id, vehicle_id, kind, title, due_date::text AS due_date, due_mileage, completed, version, updated_at";

// ---------------------------------------------------------------------------
// Payload validators per mutation `op`. Each returns a normalized object built only from allow-listed
// fields (never passing through unknown keys), or throws CarValidationError. `ownerId`, if present in a
// payload, is always ignored by the caller (see resolveOwnerId) -- these validators don't even read it.
// ---------------------------------------------------------------------------

export function validateVehicleCreatePayload(payload) {
  assertShape(isPlainObject(payload), "Nieprawidłowy ładunek mutacji", "INVALID_PAYLOAD");
  assertShape(isId(payload.id), "Nieprawidłowy identyfikator pojazdu", "INVALID_ID");
  assertShape(isNonEmptyText(payload.name, 500), "Nieprawidłowa nazwa pojazdu", "INVALID_NAME");
  if (payload.make !== undefined && payload.make !== null) {
    assertShape(isOptionalText(payload.make, 200), "Nieprawidłowa marka", "INVALID_MAKE");
  }
  if (payload.model !== undefined && payload.model !== null) {
    assertShape(isOptionalText(payload.model, 200), "Nieprawidłowy model", "INVALID_MODEL");
  }
  assertShape(
    Number.isInteger(payload.year) && payload.year >= 1886 && payload.year <= 2200,
    "Nieprawidłowy rok produkcji",
    "INVALID_YEAR",
  );
  if (payload.plate !== undefined && payload.plate !== null) {
    assertShape(
      isOptionalText(payload.plate, 50),
      "Nieprawidłowa tablica rejestracyjna",
      "INVALID_PLATE",
    );
  }
  assertShape(isNonNegativeInteger(payload.mileage), "Nieprawidłowy przebieg", "INVALID_MILEAGE");
  assertShape(FUEL_TYPES.has(payload.fuelType), "Nieprawidłowy rodzaj paliwa", "INVALID_FUEL_TYPE");
  assertShape(
    isIsoDate(payload.inspectionDate),
    "Nieprawidłowa data przeglądu",
    "INVALID_INSPECTION_DATE",
  );
  assertShape(
    isIsoDate(payload.insuranceDate),
    "Nieprawidłowa data ubezpieczenia",
    "INVALID_INSURANCE_DATE",
  );
  assertShape(
    typeof payload.color === "string" && payload.color.length <= 32,
    "Nieprawidłowy kolor",
    "INVALID_COLOR",
  );
  assertShape(
    VISIBILITIES.has(payload.visibility),
    "Nieprawidłowa widoczność",
    "INVALID_VISIBILITY",
  );
  return {
    id: payload.id,
    name: payload.name.trim(),
    make: (payload.make ?? "").trim(),
    model: (payload.model ?? "").trim(),
    year: payload.year,
    plate: (payload.plate ?? "").trim(),
    mileage: payload.mileage,
    fuelType: payload.fuelType,
    inspectionDate: payload.inspectionDate,
    insuranceDate: payload.insuranceDate,
    color: payload.color,
    visibility: payload.visibility,
  };
}

const VEHICLE_UPDATE_KEYS = new Set([
  "name",
  "make",
  "model",
  "year",
  "plate",
  "fuelType",
  "inspectionDate",
  "insuranceDate",
  "color",
]);

// `mileage` is deliberately not in VEHICLE_UPDATE_KEYS -- it only ever moves through the dedicated
// vehicle.mileage mutation (monotonic GREATEST) or as a side effect of expense.create (docs/plans/
// auto-car.md "Projekt mileage", parity with balanceMinor being cut from account.update in
// finance.mjs). `ownerId`/`visibility` are also not editable here (parity with account.update --
// changing ownership/visibility after creation is out of scope).
export function validateVehicleUpdatePayload(payload, baseVersion) {
  assertShape(isPlainObject(payload), "Nieprawidłowy ładunek mutacji", "INVALID_PAYLOAD");
  assertShape(isId(payload.id), "Nieprawidłowy identyfikator pojazdu", "INVALID_ID");
  assertShape(isPlainObject(payload.changes), "Brak zmian do zastosowania", "INVALID_CHANGES");
  for (const key of Object.keys(payload.changes)) {
    assertShape(
      VEHICLE_UPDATE_KEYS.has(key),
      `Pola "${key}" nie można edytować`,
      "INVALID_CHANGES",
    );
  }
  const version = normalizeRequiredVersion(baseVersion);
  const changes = {};
  const c = payload.changes;
  if (c.name !== undefined) {
    assertShape(isNonEmptyText(c.name, 500), "Nieprawidłowa nazwa pojazdu", "INVALID_NAME");
    changes.name = c.name.trim();
  }
  if (c.make !== undefined) {
    assertShape(isOptionalText(c.make ?? "", 200), "Nieprawidłowa marka", "INVALID_MAKE");
    changes.make = c.make ?? "";
  }
  if (c.model !== undefined) {
    assertShape(isOptionalText(c.model ?? "", 200), "Nieprawidłowy model", "INVALID_MODEL");
    changes.model = c.model ?? "";
  }
  if (c.year !== undefined) {
    assertShape(
      Number.isInteger(c.year) && c.year >= 1886 && c.year <= 2200,
      "Nieprawidłowy rok produkcji",
      "INVALID_YEAR",
    );
    changes.year = c.year;
  }
  if (c.plate !== undefined) {
    assertShape(
      isOptionalText(c.plate ?? "", 50),
      "Nieprawidłowa tablica rejestracyjna",
      "INVALID_PLATE",
    );
    changes.plate = c.plate ?? "";
  }
  if (c.fuelType !== undefined) {
    assertShape(FUEL_TYPES.has(c.fuelType), "Nieprawidłowy rodzaj paliwa", "INVALID_FUEL_TYPE");
    changes.fuelType = c.fuelType;
  }
  if (c.inspectionDate !== undefined) {
    assertShape(
      isIsoDate(c.inspectionDate),
      "Nieprawidłowa data przeglądu",
      "INVALID_INSPECTION_DATE",
    );
    changes.inspectionDate = c.inspectionDate;
  }
  if (c.insuranceDate !== undefined) {
    assertShape(
      isIsoDate(c.insuranceDate),
      "Nieprawidłowa data ubezpieczenia",
      "INVALID_INSURANCE_DATE",
    );
    changes.insuranceDate = c.insuranceDate;
  }
  if (c.color !== undefined) {
    assertShape(
      typeof c.color === "string" && c.color.length <= 32,
      "Nieprawidłowy kolor",
      "INVALID_COLOR",
    );
    changes.color = c.color;
  }
  return { id: payload.id, changes, baseVersion: version };
}

export function validateVehicleMileagePayload(payload) {
  assertShape(isPlainObject(payload), "Nieprawidłowy ładunek mutacji", "INVALID_PAYLOAD");
  assertShape(isId(payload.id), "Nieprawidłowy identyfikator pojazdu", "INVALID_ID");
  assertShape(isNonNegativeInteger(payload.mileage), "Nieprawidłowy przebieg", "INVALID_MILEAGE");
  return { id: payload.id, mileage: payload.mileage };
}

export function validateDeleteIdPayload(payload) {
  assertShape(isPlainObject(payload), "Nieprawidłowy ładunek mutacji", "INVALID_PAYLOAD");
  assertShape(isId(payload.id), "Nieprawidłowy identyfikator", "INVALID_ID");
  return { id: payload.id };
}

export function validateCarExpenseCreatePayload(payload) {
  assertShape(isPlainObject(payload), "Nieprawidłowy ładunek mutacji", "INVALID_PAYLOAD");
  assertShape(isId(payload.id), "Nieprawidłowy identyfikator kosztu", "INVALID_ID");
  assertShape(isId(payload.vehicleId), "Nieprawidłowy identyfikator pojazdu", "INVALID_VEHICLE_ID");
  assertShape(isIsoDate(payload.date), "Nieprawidłowa data kosztu", "INVALID_DATE");
  assertShape(EXPENSE_TYPES.has(payload.type), "Nieprawidłowy typ kosztu", "INVALID_TYPE");
  assertShape(
    isSafeMoney(payload.amountMinor) && payload.amountMinor >= 0,
    "Nieprawidłowa kwota kosztu",
    "INVALID_AMOUNT",
  );
  if (payload.mileage !== undefined && payload.mileage !== null) {
    assertShape(isNonNegativeInteger(payload.mileage), "Nieprawidłowy przebieg", "INVALID_MILEAGE");
  }
  if (payload.liters !== undefined && payload.liters !== null) {
    assertShape(
      typeof payload.liters === "number" && payload.liters > 0,
      "Nieprawidłowa liczba litrów",
      "INVALID_LITERS",
    );
  }
  assertShape(isNonEmptyText(payload.title, 500), "Nieprawidłowy tytuł kosztu", "INVALID_TITLE");
  if (payload.visibility !== undefined) {
    assertShape(
      VISIBILITIES.has(payload.visibility),
      "Nieprawidłowa widoczność",
      "INVALID_VISIBILITY",
    );
  }
  return {
    id: payload.id,
    vehicleId: payload.vehicleId,
    date: payload.date,
    type: payload.type,
    amountMinor: payload.amountMinor,
    mileage: payload.mileage ?? undefined,
    liters: payload.liters ?? undefined,
    title: payload.title.trim(),
    visibility: payload.visibility,
  };
}

// deadline.create is only ever issued by the UI for the user's own "custom" deadlines (docs/plans/
// auto-car.md "Projekt terminów": "deadline.create z UI zawsze tworzy kind='custom'") -- `inspection`/
// `insurance` deadlines are exclusively server-authored via upsertAutoDeadline from
// execVehicleCreate/execVehicleUpdate. This validator doesn't even accept a `kind` field.
export function validateDeadlineCreatePayload(payload) {
  assertShape(isPlainObject(payload), "Nieprawidłowy ładunek mutacji", "INVALID_PAYLOAD");
  assertShape(isId(payload.id), "Nieprawidłowy identyfikator terminu", "INVALID_ID");
  assertShape(isId(payload.vehicleId), "Nieprawidłowy identyfikator pojazdu", "INVALID_VEHICLE_ID");
  assertShape(isNonEmptyText(payload.title, 500), "Nieprawidłowy tytuł terminu", "INVALID_TITLE");
  if (payload.dueDate !== undefined && payload.dueDate !== null) {
    assertShape(isIsoDate(payload.dueDate), "Nieprawidłowy termin", "INVALID_DUE_DATE");
  }
  if (payload.dueMileage !== undefined && payload.dueMileage !== null) {
    assertShape(
      isNonNegativeInteger(payload.dueMileage),
      "Nieprawidłowy przebieg docelowy",
      "INVALID_DUE_MILEAGE",
    );
  }
  if (payload.completed !== undefined) {
    assertShape(
      typeof payload.completed === "boolean",
      "Nieprawidłowa flaga ukończenia",
      "INVALID_COMPLETED",
    );
  }
  return {
    id: payload.id,
    vehicleId: payload.vehicleId,
    title: payload.title.trim(),
    dueDate: payload.dueDate || undefined,
    dueMileage: payload.dueMileage ?? undefined,
    completed: Boolean(payload.completed),
  };
}

// Parity with today's UI: toggleVehicleDeadline only ever sends `changes: { completed }`, but the
// update op accepts the full set of editable fields (parity with how booking.update in trips.mjs
// exposes more than the UI currently uses).
const DEADLINE_UPDATE_KEYS = new Set(["completed", "title", "dueDate", "dueMileage"]);

export function validateDeadlineUpdatePayload(payload, baseVersion) {
  assertShape(isPlainObject(payload), "Nieprawidłowy ładunek mutacji", "INVALID_PAYLOAD");
  assertShape(isId(payload.id), "Nieprawidłowy identyfikator terminu", "INVALID_ID");
  assertShape(isPlainObject(payload.changes), "Brak zmian do zastosowania", "INVALID_CHANGES");
  for (const key of Object.keys(payload.changes)) {
    assertShape(
      DEADLINE_UPDATE_KEYS.has(key),
      `Pola "${key}" nie można edytować`,
      "INVALID_CHANGES",
    );
  }
  const version = normalizeRequiredVersion(baseVersion);
  const changes = {};
  const c = payload.changes;
  if (c.completed !== undefined) {
    assertShape(
      typeof c.completed === "boolean",
      "Nieprawidłowa flaga ukończenia",
      "INVALID_COMPLETED",
    );
    changes.completed = c.completed;
  }
  if (c.title !== undefined) {
    assertShape(isNonEmptyText(c.title, 500), "Nieprawidłowy tytuł terminu", "INVALID_TITLE");
    changes.title = c.title.trim();
  }
  if (Object.prototype.hasOwnProperty.call(c, "dueDate")) {
    assertShape(
      c.dueDate === null || isIsoDate(c.dueDate),
      "Nieprawidłowy termin",
      "INVALID_DUE_DATE",
    );
    changes.dueDate = c.dueDate;
  }
  if (Object.prototype.hasOwnProperty.call(c, "dueMileage")) {
    assertShape(
      c.dueMileage === null || isNonNegativeInteger(c.dueMileage),
      "Nieprawidłowy przebieg docelowy",
      "INVALID_DUE_MILEAGE",
    );
    changes.dueMileage = c.dueMileage;
  }
  return { id: payload.id, changes, baseVersion: version };
}

// ---------------------------------------------------------------------------
// Mutation envelope + supported ops
// ---------------------------------------------------------------------------

export const SUPPORTED_CAR_OPS = new Set([
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

// Whole-request-shape validation, mirroring assertFinanceMutationShape/assertTripMutationShape: called
// once per mutation BEFORE any DB work starts, so a malformed entry anywhere in the batch is rejected
// as a single 400 rather than silently corrupting bookkeeping for its siblings. Per-mutation *business*
// validation (bad field values, missing vehicle, ...) is reported as `status: "error"` inside `results`
// by applyCarMutation instead.
export function assertCarMutationShape(mutation) {
  if (!isPlainObject(mutation)) {
    throw carRequestError(400, "Nieprawidłowy kształt mutacji", "INVALID_CAR_MUTATION");
  }
  if (typeof mutation.idempotencyKey !== "string" || !UUID_PATTERN.test(mutation.idempotencyKey)) {
    throw carRequestError(400, "Nieprawidłowy klucz idempotencji", "INVALID_IDEMPOTENCY_KEY");
  }
  if (typeof mutation.op !== "string" || !SUPPORTED_CAR_OPS.has(mutation.op)) {
    throw carRequestError(400, "Nieobsługiwana operacja mutacji", "UNSUPPORTED_OP");
  }
  if (!isPlainObject(mutation.payload)) {
    throw carRequestError(400, "Brak danych mutacji", "INVALID_CAR_MUTATION");
  }
  if (
    mutation.baseVersion !== undefined &&
    mutation.baseVersion !== null &&
    !Number.isInteger(mutation.baseVersion)
  ) {
    throw carRequestError(400, "Nieprawidłowa wersja bazowa mutacji", "INVALID_CAR_MUTATION");
  }
}

export const MAX_CAR_MUTATIONS_PER_BATCH = Number(process.env.MAX_CAR_MUTATIONS ?? 500);
export const MAX_CAR_MUTATIONS_BYTES = Number(process.env.MAX_CAR_MUTATIONS_BYTES ?? 2_000_000);

// ---------------------------------------------------------------------------
// Snapshot read (GET /api/v1/car): household-wide records + the caller's own private records for
// vehicles/car_expenses (wzór readFinanceSnapshot). vehicle_deadlines has no visibility of its own --
// access is filtered through EXISTS on the parent vehicle (docs/plans/auto-car.md "Snapshot read").
// ---------------------------------------------------------------------------

export async function readCarSnapshot(client, householdId, userId) {
  // Sequential, not Promise.all: `client` may be a single-connection PoolClient (e.g. when called
  // inside a transaction()), and node-postgres only supports one in-flight query per connection.
  const vehicles = await client.query(
    `SELECT ${VEHICLE_SELECT_COLUMNS} FROM vehicles
      WHERE household_id = $1 AND (visibility = 'household' OR owner_id = $2)
      ORDER BY created_at`,
    [householdId, userId],
  );
  const carExpenses = await client.query(
    `SELECT ${CAR_EXPENSE_SELECT_COLUMNS} FROM car_expenses
      WHERE household_id = $1 AND (visibility = 'household' OR owner_id = $2)
      ORDER BY date DESC, created_at DESC`,
    [householdId, userId],
  );
  const vehicleDeadlines = await client.query(
    `SELECT ${DEADLINE_SELECT_COLUMNS} FROM vehicle_deadlines
      WHERE household_id = $1
        AND EXISTS (
          SELECT 1 FROM vehicles v
           WHERE v.id = vehicle_deadlines.vehicle_id AND v.household_id = $1
             AND (v.visibility = 'household' OR v.owner_id = $2)
        )
      ORDER BY created_at`,
    [householdId, userId],
  );
  return {
    vehicles: vehicles.rows.map(vehicleRowToDto),
    carExpenses: carExpenses.rows.map(carExpenseRowToDto),
    vehicleDeadlines: vehicleDeadlines.rows.map(vehicleDeadlineRowToDto),
  };
}

// Wspiera "Wyczyść dane aplikacji" (SettingsPage.tsx danger zone). Wzór resetFinanceForUser: usuwa
// wszystko wspólne (`visibility = 'household'`) plus WYŁĄCZNIE prywatne rekordy wywołującego użytkownika
// (`owner_id = userId`) w danym gospodarstwie -- NIE cały reset gospodarstwa jak w trips/meals, bo Auto
// ma rekordy prywatne. Kolejność: najpierw car_expenses (dzieci), potem vehicles (rodzic) -- kaskada FK
// (`ON DELETE CASCADE`) usuwa car_expenses/vehicle_deadlines dotkniętych pojazdów automatycznie, ale
// usuwamy car_expenses jawnie najpierw dla symetrii z finance.mjs i żeby nie polegać wyłącznie na
// kaskadzie dla rekordów, których pojazd akurat NIE jest usuwany w tym wywołaniu.
export async function resetCarForUser(client, householdId, userId) {
  await client.query(
    `DELETE FROM car_expenses
      WHERE household_id = $1 AND (visibility = 'household' OR owner_id = $2)`,
    [householdId, userId],
  );
  await client.query(
    `DELETE FROM vehicles
      WHERE household_id = $1 AND (visibility = 'household' OR owner_id = $2)`,
    [householdId, userId],
  );
}

// ---------------------------------------------------------------------------
// Shared OCC/conflict resolution helpers used by every update/delete op (mirrors finance.mjs/trips.mjs).
// The lookup query MUST carry the same household/visibility scoping as the write it's diagnosing --
// otherwise this could leak the existence or content of another user's private record through the
// "current record" in a conflict response (docs/plans/auto-car.md "Bezpieczeństwo scope'u widoczności").
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

// Deletion is idempotent by design -- a missing row is `applied`, not an error.
async function resolveConflictOrGone(client, query, params, mapper) {
  const existing = await client.query(query, params);
  if (!existing.rowCount) return { status: "applied", record: null };
  const row = existing.rows[0];
  return { status: "conflict", record: mapper(row), currentVersion: row.version };
}

// ---------------------------------------------------------------------------
// Auto-upsert of the two stable-`kind` deadlines (`inspection`/`insurance`), called from the SAME
// transaction as execVehicleCreate/execVehicleUpdate (docs/plans/auto-car.md "Projekt terminów").
// Relies on the partial unique index `(vehicle_id, kind) WHERE kind IN ('inspection','insurance')`
// (server/migrations/009_car_normalized.sql) for the ON CONFLICT target. The UPDATE branch touches
// ONLY `due_date` (+ bookkeeping) -- it never resets `completed` or overwrites `title`, so an already
// completed auto-deadline stays completed when the underlying date is edited later (parity with
// today's client behavior, CarPage.tsx:255).
// ---------------------------------------------------------------------------

export async function upsertAutoDeadline(client, ctx, vehicleId, kind, title, dueDate) {
  const id = randomUUID();
  const result = await client.query(
    `INSERT INTO vehicle_deadlines
       (id, household_id, vehicle_id, kind, title, due_date, completed, version, updated_by)
     VALUES ($1, $2, $3, $4, $5, $6, false, 1, $7)
     ON CONFLICT (vehicle_id, kind) WHERE kind IN ('inspection', 'insurance')
     DO UPDATE SET due_date = EXCLUDED.due_date, version = vehicle_deadlines.version + 1,
                   updated_at = now(), updated_by = EXCLUDED.updated_by
     RETURNING ${DEADLINE_SELECT_COLUMNS}`,
    [id, ctx.householdId, vehicleId, kind, title, dueDate, ctx.userId],
  );
  return vehicleDeadlineRowToDto(result.rows[0]);
}

// ---------------------------------------------------------------------------
// Per-op SQL execution. Each function assumes payload/baseVersion have already been shape-checked by
// assertCarMutationShape; they still run their own (business-rule) validators and throw
// CarValidationError on bad input, which applyCarMutation turns into `status: "error"`.
// ---------------------------------------------------------------------------

async function execVehicleCreate(client, ctx, payload) {
  const data = validateVehicleCreatePayload(payload);
  const ownerId = resolveOwnerId(ctx);
  try {
    const inserted = await client.query(
      `INSERT INTO vehicles
         (id, household_id, owner_id, visibility, name, make, model, year, plate, mileage, fuel_type,
          inspection_date, insurance_date, color, version, updated_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, 1, $3)
       RETURNING ${VEHICLE_SELECT_COLUMNS}`,
      [
        data.id,
        ctx.householdId,
        ownerId,
        data.visibility,
        data.name,
        data.make,
        data.model,
        data.year,
        data.plate,
        data.mileage,
        data.fuelType,
        data.inspectionDate,
        data.insuranceDate,
        data.color,
      ],
    );
    const record = vehicleRowToDto(inserted.rows[0]);
    // vehicle.create atomically establishes both stable-kind deadlines in the same transaction
    // (docs/plans/auto-car.md "Projekt terminów") -- no client-side heuristic on `title` anymore.
    const inspectionDeadline = await upsertAutoDeadline(
      client,
      ctx,
      record.id,
      "inspection",
      "Badanie techniczne",
      data.inspectionDate,
    );
    const insuranceDeadline = await upsertAutoDeadline(
      client,
      ctx,
      record.id,
      "insurance",
      "Odnowienie OC/AC",
      data.insuranceDate,
    );
    return { status: "applied", record, deadlines: [inspectionDeadline, insuranceDeadline] };
  } catch (error) {
    if (error.code === "23505") {
      return resolveConflictOrError(
        client,
        `SELECT ${VEHICLE_SELECT_COLUMNS} FROM vehicles
          WHERE id = $1 AND household_id = $2 AND (visibility = 'household' OR owner_id = $3)`,
        [data.id, ctx.householdId, ownerId],
        vehicleRowToDto,
        "Identyfikator jest już używany",
        "ID_TAKEN",
      );
    }
    throw error;
  }
}

async function execVehicleUpdate(client, ctx, payload, baseVersion) {
  const { id, changes, baseVersion: version } = validateVehicleUpdatePayload(payload, baseVersion);
  const ownerId = resolveOwnerId(ctx);
  const updated = await client.query(
    `UPDATE vehicles
        SET name = COALESCE($1, name),
            make = COALESCE($2, make),
            model = COALESCE($3, model),
            year = COALESCE($4, year),
            plate = COALESCE($5, plate),
            fuel_type = COALESCE($6, fuel_type),
            inspection_date = COALESCE($7::date, inspection_date),
            insurance_date = COALESCE($8::date, insurance_date),
            color = COALESCE($9, color),
            version = version + 1,
            updated_at = now(),
            updated_by = $10
      WHERE id = $11 AND household_id = $12 AND version = $13
        AND (visibility = 'household' OR owner_id = $10)
      RETURNING ${VEHICLE_SELECT_COLUMNS}`,
    [
      changes.name ?? null,
      changes.make ?? null,
      changes.model ?? null,
      changes.year ?? null,
      changes.plate ?? null,
      changes.fuelType ?? null,
      changes.inspectionDate ?? null,
      changes.insuranceDate ?? null,
      changes.color ?? null,
      ownerId,
      id,
      ctx.householdId,
      version,
    ],
  );
  if (!updated.rowCount) {
    return resolveConflictOrError(
      client,
      `SELECT ${VEHICLE_SELECT_COLUMNS} FROM vehicles
        WHERE id = $1 AND household_id = $2 AND (visibility = 'household' OR owner_id = $3)`,
      [id, ctx.householdId, ownerId],
      vehicleRowToDto,
      "Rekord nie istnieje lub jest niedostępny",
      "NOT_FOUND",
    );
  }
  const record = vehicleRowToDto(updated.rows[0]);
  // Changing inspectionDate/insuranceDate auto-upserts the matching stable-kind deadline in the SAME
  // transaction (docs/plans/auto-car.md "Projekt terminów"). This does NOT consume the vehicle's OCC
  // token -- the deadline rows are separate, versioned independently.
  const deadlines = [];
  if (changes.inspectionDate !== undefined) {
    deadlines.push(
      await upsertAutoDeadline(
        client,
        ctx,
        id,
        "inspection",
        "Badanie techniczne",
        changes.inspectionDate,
      ),
    );
  }
  if (changes.insuranceDate !== undefined) {
    deadlines.push(
      await upsertAutoDeadline(
        client,
        ctx,
        id,
        "insurance",
        "Odnowienie OC/AC",
        changes.insuranceDate,
      ),
    );
  }
  return { status: "applied", record, deadlines: deadlines.length ? deadlines : undefined };
}

// Monotonic, non-OCC mutation (analog `balanceMinor`, docs/plans/auto-car.md "Projekt mileage"): the
// SQL clamps to `GREATEST(mileage, $new)` and only commits the row when `$new >= mileage`, so two
// concurrent bumps both resolve to the maximum without a lost update -- no `baseVersion`, no `version`
// bump (bumping it would false-conflict a concurrent vehicle.update).
async function execVehicleMileage(client, ctx, payload) {
  const { id, mileage } = validateVehicleMileagePayload(payload);
  const ownerId = resolveOwnerId(ctx);
  const updated = await client.query(
    `UPDATE vehicles
        SET mileage = GREATEST(mileage, $1), updated_at = now(), updated_by = $2
      WHERE id = $3 AND household_id = $4 AND (visibility = 'household' OR owner_id = $2)
        AND $1 >= mileage
      RETURNING ${VEHICLE_SELECT_COLUMNS}`,
    [mileage, ownerId, id, ctx.householdId],
  );
  if (updated.rowCount) return { status: "applied", record: vehicleRowToDto(updated.rows[0]) };
  // rowCount = 0: either the vehicle exists but $new < current mileage (conflict -- client should
  // adopt the authoritative, higher value), or it doesn't exist/isn't visible to this user (NOT_FOUND).
  // The diagnostic SELECT carries the exact same visibility scope as the write above.
  const existing = await client.query(
    `SELECT ${VEHICLE_SELECT_COLUMNS} FROM vehicles
      WHERE id = $1 AND household_id = $2 AND (visibility = 'household' OR owner_id = $3)`,
    [id, ctx.householdId, ownerId],
  );
  if (existing.rowCount) {
    const row = existing.rows[0];
    return { status: "conflict", record: vehicleRowToDto(row), currentVersion: row.version };
  }
  return { status: "error", error: "Pojazd nie istnieje lub jest niedostępny", code: "NOT_FOUND" };
}

// No dedicated UI entry point today (docs/plans/auto-car.md: "vehicle.delete — dziś brak dedykowanego
// UI usuwania pojazdu"), modeled for symmetry with the rest of the module and for `reset`/cascade
// consistency. `baseVersion` is optional (parity with account/goal delete).
async function execVehicleDelete(client, ctx, payload, baseVersion) {
  const { id } = validateDeleteIdPayload(payload);
  const ownerId = resolveOwnerId(ctx);
  const version = normalizeOptionalVersion(baseVersion);
  const deleted = await client.query(
    `DELETE FROM vehicles
      WHERE id = $1 AND household_id = $2 AND (visibility = 'household' OR owner_id = $3)
        AND ($4::integer IS NULL OR version = $4)
      RETURNING id`,
    [id, ctx.householdId, ownerId, version],
  );
  if (deleted.rowCount) return { status: "applied", record: null };
  return resolveConflictOrGone(
    client,
    `SELECT ${VEHICLE_SELECT_COLUMNS} FROM vehicles
      WHERE id = $1 AND household_id = $2 AND (visibility = 'household' OR owner_id = $3)`,
    [id, ctx.householdId, ownerId],
    vehicleRowToDto,
  );
}

async function execCarExpenseCreate(client, ctx, payload) {
  const data = validateCarExpenseCreatePayload(payload);
  const ownerId = resolveOwnerId(ctx);
  const vehicleResult = await client.query(
    `SELECT visibility FROM vehicles
      WHERE id = $1 AND household_id = $2 AND (visibility = 'household' OR owner_id = $3)`,
    [data.vehicleId, ctx.householdId, ownerId],
  );
  if (!vehicleResult.rowCount) {
    return {
      status: "error",
      error: "Pojazd nie istnieje lub jest niedostępny",
      code: "VEHICLE_NOT_FOUND",
    };
  }
  const visibility = resolveExpenseVisibility(data.visibility, vehicleResult.rows[0].visibility);
  try {
    const inserted = await client.query(
      `INSERT INTO car_expenses
         (id, household_id, vehicle_id, owner_id, visibility, date, type, amount_minor, mileage,
          liters, title, version, updated_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 1, $4)
       RETURNING ${CAR_EXPENSE_SELECT_COLUMNS}`,
      [
        data.id,
        ctx.householdId,
        data.vehicleId,
        ownerId,
        visibility,
        data.date,
        data.type,
        data.amountMinor,
        data.mileage ?? null,
        data.liters ?? null,
        data.title,
      ],
    );
    const record = carExpenseRowToDto(inserted.rows[0]);
    // Side effect of adding an expense with a mileage reading: bump the vehicle's mileage monotonically
    // (docs/plans/auto-car.md "Efekt uboczny przebiegu przy expense.create", parity with today's client
    // `addCarExpense`). Same GREATEST formula as execVehicleMileage, no OCC, no version bump.
    let vehicle;
    if (data.mileage !== undefined) {
      const vehicleUpdate = await client.query(
        `UPDATE vehicles SET mileage = GREATEST(mileage, $1), updated_at = now()
          WHERE id = $2
          RETURNING ${VEHICLE_SELECT_COLUMNS}`,
        [data.mileage, data.vehicleId],
      );
      vehicle = vehicleUpdate.rows[0] ? vehicleRowToDto(vehicleUpdate.rows[0]) : undefined;
    }
    return { status: "applied", record, vehicle };
  } catch (error) {
    if (error.code === "23505") {
      return resolveConflictOrError(
        client,
        `SELECT ${CAR_EXPENSE_SELECT_COLUMNS} FROM car_expenses
          WHERE id = $1 AND household_id = $2 AND (visibility = 'household' OR owner_id = $3)`,
        [data.id, ctx.householdId, ownerId],
        carExpenseRowToDto,
        "Identyfikator jest już używany",
        "ID_TAKEN",
      );
    }
    throw error;
  }
}

// `expense.delete` never reverses the mileage bump (docs/plans/auto-car.md: "Nie cofa przebiegu",
// parity with today's `removeExpense`). `baseVersion` is optional (UI never edits/reads a version for
// expenses today -- parity with transaction.delete).
async function execCarExpenseDelete(client, ctx, payload, baseVersion) {
  const { id } = validateDeleteIdPayload(payload);
  const ownerId = resolveOwnerId(ctx);
  const version = normalizeOptionalVersion(baseVersion);
  const deleted = await client.query(
    `DELETE FROM car_expenses
      WHERE id = $1 AND household_id = $2 AND (visibility = 'household' OR owner_id = $3)
        AND ($4::integer IS NULL OR version = $4)
      RETURNING id`,
    [id, ctx.householdId, ownerId, version],
  );
  if (deleted.rowCount) return { status: "applied", record: null };
  return resolveConflictOrGone(
    client,
    `SELECT ${CAR_EXPENSE_SELECT_COLUMNS} FROM car_expenses
      WHERE id = $1 AND household_id = $2 AND (visibility = 'household' OR owner_id = $3)`,
    [id, ctx.householdId, ownerId],
    carExpenseRowToDto,
  );
}

async function execDeadlineCreate(client, ctx, payload) {
  const data = validateDeadlineCreatePayload(payload);
  const ownerId = resolveOwnerId(ctx);
  const vehicleCheck = await client.query(
    `SELECT id FROM vehicles
      WHERE id = $1 AND household_id = $2 AND (visibility = 'household' OR owner_id = $3)`,
    [data.vehicleId, ctx.householdId, ownerId],
  );
  if (!vehicleCheck.rowCount) {
    return {
      status: "error",
      error: "Pojazd nie istnieje lub jest niedostępny",
      code: "VEHICLE_NOT_FOUND",
    };
  }
  try {
    const inserted = await client.query(
      `INSERT INTO vehicle_deadlines
         (id, household_id, vehicle_id, kind, title, due_date, due_mileage, completed, version,
          updated_by)
       VALUES ($1, $2, $3, 'custom', $4, $5, $6, $7, 1, $8)
       RETURNING ${DEADLINE_SELECT_COLUMNS}`,
      [
        data.id,
        ctx.householdId,
        data.vehicleId,
        data.title,
        data.dueDate ?? null,
        data.dueMileage ?? null,
        data.completed,
        ownerId,
      ],
    );
    return { status: "applied", record: vehicleDeadlineRowToDto(inserted.rows[0]) };
  } catch (error) {
    if (error.code === "23505") {
      return resolveConflictOrError(
        client,
        `SELECT ${DEADLINE_SELECT_COLUMNS} FROM vehicle_deadlines
          WHERE id = $1 AND household_id = $2
            AND EXISTS (
              SELECT 1 FROM vehicles v
               WHERE v.id = vehicle_deadlines.vehicle_id AND v.household_id = $2
                 AND (v.visibility = 'household' OR v.owner_id = $3)
            )`,
        [data.id, ctx.householdId, ownerId],
        vehicleDeadlineRowToDto,
        "Identyfikator jest już używany",
        "ID_TAKEN",
      );
    }
    throw error;
  }
}

async function execDeadlineUpdate(client, ctx, payload, baseVersion) {
  const { id, changes, baseVersion: version } = validateDeadlineUpdatePayload(payload, baseVersion);
  const ownerId = resolveOwnerId(ctx);
  const hasDueDateChange = Object.prototype.hasOwnProperty.call(changes, "dueDate");
  const hasDueMileageChange = Object.prototype.hasOwnProperty.call(changes, "dueMileage");
  const updated = await client.query(
    `UPDATE vehicle_deadlines
        SET completed = COALESCE($1, completed),
            title = COALESCE($2, title),
            due_date = CASE WHEN $3 THEN $4::date ELSE due_date END,
            due_mileage = CASE WHEN $5 THEN $6 ELSE due_mileage END,
            version = version + 1,
            updated_at = now(),
            updated_by = $7
      WHERE id = $8 AND household_id = $9 AND version = $10
        AND EXISTS (
          SELECT 1 FROM vehicles v
           WHERE v.id = vehicle_deadlines.vehicle_id AND v.household_id = $9
             AND (v.visibility = 'household' OR v.owner_id = $7)
        )
      RETURNING ${DEADLINE_SELECT_COLUMNS}`,
    [
      changes.completed ?? null,
      changes.title ?? null,
      hasDueDateChange,
      hasDueDateChange ? changes.dueDate : null,
      hasDueMileageChange,
      hasDueMileageChange ? changes.dueMileage : null,
      ownerId,
      id,
      ctx.householdId,
      version,
    ],
  );
  if (updated.rowCount) {
    return { status: "applied", record: vehicleDeadlineRowToDto(updated.rows[0]) };
  }
  return resolveConflictOrError(
    client,
    `SELECT ${DEADLINE_SELECT_COLUMNS} FROM vehicle_deadlines
      WHERE id = $1 AND household_id = $2
        AND EXISTS (
          SELECT 1 FROM vehicles v
           WHERE v.id = vehicle_deadlines.vehicle_id AND v.household_id = $2
             AND (v.visibility = 'household' OR v.owner_id = $3)
        )`,
    [id, ctx.householdId, ownerId],
    vehicleDeadlineRowToDto,
    "Rekord nie istnieje lub jest niedostępny",
    "NOT_FOUND",
  );
}

// Deletes any deadline, including server-auto-generated inspection/insurance ones (parity with
// today's `removeDeadline`, docs/plans/auto-car.md "Projekt terminów"). Deleting an auto-kind here does
// NOT recreate it -- the next vehicle.update touching that date will upsert it again.
async function execDeadlineDelete(client, ctx, payload, baseVersion) {
  const { id } = validateDeleteIdPayload(payload);
  const ownerId = resolveOwnerId(ctx);
  const version = normalizeOptionalVersion(baseVersion);
  const deleted = await client.query(
    `DELETE FROM vehicle_deadlines
      WHERE id = $1 AND household_id = $2 AND ($3::integer IS NULL OR version = $3)
        AND EXISTS (
          SELECT 1 FROM vehicles v
           WHERE v.id = vehicle_deadlines.vehicle_id AND v.household_id = $2
             AND (v.visibility = 'household' OR v.owner_id = $4)
        )
      RETURNING id`,
    [id, ctx.householdId, version, ownerId],
  );
  if (deleted.rowCount) return { status: "applied", record: null };
  return resolveConflictOrGone(
    client,
    `SELECT ${DEADLINE_SELECT_COLUMNS} FROM vehicle_deadlines
      WHERE id = $1 AND household_id = $2
        AND EXISTS (
          SELECT 1 FROM vehicles v
           WHERE v.id = vehicle_deadlines.vehicle_id AND v.household_id = $2
             AND (v.visibility = 'household' OR v.owner_id = $3)
        )`,
    [id, ctx.householdId, ownerId],
    vehicleDeadlineRowToDto,
  );
}

async function executeCarOp(client, ctx, op, payload, baseVersion) {
  switch (op) {
    case "vehicle.create":
      return execVehicleCreate(client, ctx, payload);
    case "vehicle.update":
      return execVehicleUpdate(client, ctx, payload, baseVersion);
    case "vehicle.mileage":
      return execVehicleMileage(client, ctx, payload);
    case "vehicle.delete":
      return execVehicleDelete(client, ctx, payload, baseVersion);
    case "expense.create":
      return execCarExpenseCreate(client, ctx, payload);
    case "expense.delete":
      return execCarExpenseDelete(client, ctx, payload, baseVersion);
    case "deadline.create":
      return execDeadlineCreate(client, ctx, payload);
    case "deadline.update":
      return execDeadlineUpdate(client, ctx, payload, baseVersion);
    case "deadline.delete":
      return execDeadlineDelete(client, ctx, payload, baseVersion);
    default:
      // Unreachable when called through applyCarMutation (assertCarMutationShape already rejected
      // unknown ops at the request level); kept defensive in case of direct unit-test calls.
      throw new CarValidationError(`Nieobsługiwana operacja: ${op}`, "UNSUPPORTED_OP");
  }
}

// ---------------------------------------------------------------------------
// Idempotent mutation entry point. `mutation` is assumed to already have passed
// assertCarMutationShape (server.mjs validates the whole batch upfront). ctx = { householdId, userId }
// always comes from the authenticated session, never from the request body.
// ---------------------------------------------------------------------------

export async function applyCarMutation(client, ctx, mutation) {
  const { idempotencyKey, op, payload, baseVersion } = mutation;

  // Claim the idempotency key first, inside the same DB transaction as the operation itself: if the op
  // below throws, the whole transaction (including this claim) rolls back, so the key remains free to
  // retry. If a row already existed, this was a retry -- return the previously stored result instead of
  // running the operation again.
  const claim = await client.query(
    `INSERT INTO car_mutations (idempotency_key, household_id, user_id, op, result)
     VALUES ($1, $2, $3, $4, '{}'::jsonb)
     ON CONFLICT (idempotency_key) DO NOTHING`,
    [idempotencyKey, ctx.householdId, ctx.userId, op],
  );
  if (!claim.rowCount) {
    const existing = await client.query(
      `SELECT result FROM car_mutations WHERE idempotency_key = $1`,
      [idempotencyKey],
    );
    return existing.rows[0]?.result ?? { idempotencyKey, status: "duplicate" };
  }

  let outcome;
  try {
    outcome = await executeCarOp(client, ctx, op, payload, baseVersion);
  } catch (error) {
    if (error instanceof CarValidationError) {
      outcome = { status: "error", error: error.message, code: error.code };
    } else {
      throw error;
    }
  }

  const result = { idempotencyKey, ...outcome };
  await client.query(`UPDATE car_mutations SET result = $1::jsonb WHERE idempotency_key = $2`, [
    JSON.stringify(result),
    idempotencyKey,
  ]);
  return result;
}
