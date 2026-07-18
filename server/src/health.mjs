// Domain layer for the normalized Health (Zdrowie) module.
//
// Data model: server/migrations/011_health_normalized.sql (health_appointments, medications,
// health_measurements, health_mutations). Design source of truth: docs/plans/zdrowie-sql.md
// ("Podejście" section).
//
// This is the Health analogue of server/src/pets.mjs, but STRICTLY SIMPLER (docs/plans/
// zdrowie-sql.md "Czym Zdrowie jest PROSTSZE od Zwierząt/Auta"):
//   1. No parent/child relations at all -- health_appointments, medications, health_measurements
//      are THREE COMPLETELY INDEPENDENT, flat tables. No `pet_id`/`vehicle_id`-like FK between
//      them, no ON DELETE CASCADE between them, no orphan guard, no EXISTS-on-parent scoping.
//      Every row filters purely on itself (`visibility = 'household' OR owner_id = $user`).
//   2. No visibility cascade -- since there are no children, `*.update` changing `visibility`
//      only ever touches its own row. No cascadeHealthVisibility.
//   3. No visibility inheritance on create -- there is no parent to inherit from; every
//      `*.create` carries an EXPLICIT `visibility` (HealthPage.tsx always sets one, default
//      `private`). No resolve*Visibility variant.
//   4. No aggregate/monotonic field -- no analogue of `Vehicle.mileage`/`balanceMinor`. Every
//      update uses per-record OCC, no exceptions.
//   5. No nested JSONB array -- no analogue of `fishStock`/`travelers`. Plain scalars only.
//
// New relative to pets.mjs: `healthMeasurement.measuredAt` is a free-form timestamp string (NOT
// an ISO date) validated by `isParsableTimestamp`, and `medication.lastTakenOn` is a real toggle
// field (client computes the new value and sends it via `medication.update`), handled with the
// same `hasOwnProperty` nullable-clears-column pattern pets.mjs uses for `species`/`notes`.
//
// Like pets.mjs/car.mjs/finance.mjs/trips.mjs, this module intentionally does NOT import the zod
// schemas from src/lib/schema.ts: the server package has no TypeScript build step and no zod
// dependency. The validators below hand-roll the same rules as `healthAppointmentSchema`/
// `medicationSchema`/`healthMeasurementSchema` in src/lib/schema.ts, scoped to the subset of
// fields a mutation payload carries.
//
// Every exported function here is either pure (validators, resolveOwnerId,
// resolveVersionConflict, row->DTO mappers) or takes an already-connected `client` (a pg
// PoolClient, or the shared `pool` from db.mjs) so it can run either inside a transaction() or
// directly against the pool.

export class HealthValidationError extends Error {
  constructor(message, code = "VALIDATION_ERROR") {
    super(message);
    this.name = "HealthValidationError";
    this.code = code;
  }
}

function healthRequestError(statusCode, message, code) {
  const error = new Error(message);
  error.statusCode = statusCode;
  error.code = code;
  return error;
}

// ---------------------------------------------------------------------------
// Primitive validators (mirror src/lib/schema.ts / src/healthTypes.ts)
// ---------------------------------------------------------------------------

const ID_MAX_LENGTH = 200;
const VISIBILITIES = new Set(["private", "household"]);
const APPOINTMENT_STATUSES = new Set(["scheduled", "completed", "cancelled"]);
const MEASUREMENT_TYPES = new Set(["weight", "blood_pressure", "glucose", "temperature", "other"]);
const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const TIME_PATTERN = /^\d{2}:\d{2}$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Wzór `timestamp` z src/lib/schema.ts -- cap na długość, żeby nie przepuścić absurdalnie
// długich stringów przez `Date.parse` do kolumny `text`.
const MEASURED_AT_MAX_LENGTH = 200;

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

// New primitive relative to pets.mjs: `healthMeasurement.measuredAt` is a free-form
// Date.parse-able timestamp string (e.g. `2026-07-18T07:30`, no timezone/seconds), NOT an ISO
// date -- docs/plans/zdrowie-sql.md "Projekt pól specjalnych". Stored to `text` with no SQL cast.
function isParsableTimestamp(value) {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= MEASURED_AT_MAX_LENGTH &&
    !Number.isNaN(Date.parse(value))
  );
}

// Normalizes an optional/nullable text field to either a trimmed non-empty string or null (the
// column is nullable, matching how the migration writes `NULLIF(rec->>'…', '')`).
function normalizeOptionalText(value) {
  if (value === undefined || value === null) return null;
  const trimmed = String(value).trim();
  return trimmed.length ? trimmed : null;
}

function assertShape(condition, message, code) {
  if (!condition) throw new HealthValidationError(message, code);
}

// ---------------------------------------------------------------------------
// Security invariants (docs/ARCHITECTURE.md "Dane wspólne i prywatne")
// ---------------------------------------------------------------------------

// owner_id is always derived from the authenticated session -- a client-supplied ownerId in the
// mutation payload (if present) is always ignored. Single choke point (parity with
// pets.mjs/car.mjs/finance.mjs's resolveOwnerId).
export function resolveOwnerId(ctx) {
  return ctx.userId;
}

// Pure helper naming the core OCC decision explicitly, unit-testable in isolation (mirrors
// pets.mjs/car.mjs/finance.mjs). The authoritative check always happens in SQL
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
// Row -> DTO mapping (snake_case columns -> the HealthAppointment/Medication/HealthMeasurement
// shapes in src/healthTypes.ts). `date` columns are cast to text in SQL (`::text`) to dodge
// node-postgres's local-timezone Date parsing; `timestamptz` columns (`updated_at`) are safe to
// read as JS Date and converted with `.toISOString()`. `measured_at` is already `text` -- read
// verbatim, no cast needed anywhere.
// ---------------------------------------------------------------------------

export function appointmentRowToDto(row) {
  return {
    id: row.id,
    ownerId: row.owner_id,
    visibility: row.visibility,
    title: row.title,
    clinician: row.clinician,
    specialty: row.specialty ?? undefined,
    date: row.date,
    time: row.time,
    location: row.location ?? undefined,
    status: row.status,
    notes: row.notes ?? undefined,
    version: row.version,
    updatedAt: row.updated_at.toISOString(),
  };
}

export function medicationRowToDto(row) {
  return {
    id: row.id,
    ownerId: row.owner_id,
    visibility: row.visibility,
    name: row.name,
    dosage: row.dosage,
    schedule: row.schedule,
    active: row.active,
    lastTakenOn: row.last_taken_on ?? undefined,
    reminderTime: row.reminder_time ?? undefined,
    version: row.version,
    updatedAt: row.updated_at.toISOString(),
  };
}

export function measurementRowToDto(row) {
  return {
    id: row.id,
    ownerId: row.owner_id,
    visibility: row.visibility,
    type: row.type,
    value: row.value,
    unit: row.unit,
    measuredAt: row.measured_at,
    notes: row.notes ?? undefined,
    version: row.version,
    updatedAt: row.updated_at.toISOString(),
  };
}

const APPOINTMENT_SELECT_COLUMNS =
  "id, owner_id, visibility, title, clinician, specialty, date::text AS date, time, location, " +
  "status, notes, version, updated_at";
const MEDICATION_SELECT_COLUMNS =
  "id, owner_id, visibility, name, dosage, schedule, active, last_taken_on::text AS last_taken_on, " +
  "reminder_time, version, updated_at";
const MEASUREMENT_SELECT_COLUMNS =
  "id, owner_id, visibility, type, value, unit, measured_at, notes, version, updated_at";

// ---------------------------------------------------------------------------
// Payload validators per mutation `op`. Each returns a normalized object built only from
// allow-listed fields (never passing through unknown keys), or throws HealthValidationError.
// `ownerId`, if present in a payload, is always ignored by the caller (see resolveOwnerId) --
// these validators don't even read it.
// ---------------------------------------------------------------------------

export function validateAppointmentCreatePayload(payload) {
  assertShape(isPlainObject(payload), "Nieprawidłowy ładunek mutacji", "INVALID_PAYLOAD");
  assertShape(isId(payload.id), "Nieprawidłowy identyfikator wizyty", "INVALID_ID");
  assertShape(isNonEmptyText(payload.title, 500), "Nieprawidłowy tytuł wizyty", "INVALID_TITLE");
  assertShape(
    isNonEmptyText(payload.clinician, 500),
    "Nieprawidłowy lekarz/placówka",
    "INVALID_CLINICIAN",
  );
  if (payload.specialty !== undefined && payload.specialty !== null) {
    assertShape(
      isOptionalText(payload.specialty, 500),
      "Nieprawidłowa specjalizacja",
      "INVALID_SPECIALTY",
    );
  }
  assertShape(isIsoDate(payload.date), "Nieprawidłowa data wizyty", "INVALID_DATE");
  assertShape(isClockTime(payload.time), "Nieprawidłowa godzina wizyty", "INVALID_TIME");
  if (payload.location !== undefined && payload.location !== null) {
    assertShape(
      isOptionalText(payload.location, 1000),
      "Nieprawidłowa lokalizacja",
      "INVALID_LOCATION",
    );
  }
  assertShape(
    APPOINTMENT_STATUSES.has(payload.status),
    "Nieprawidłowy status wizyty",
    "INVALID_STATUS",
  );
  if (payload.notes !== undefined && payload.notes !== null) {
    assertShape(isOptionalText(payload.notes, 5000), "Nieprawidłowe notatki", "INVALID_NOTES");
  }
  assertShape(VISIBILITIES.has(payload.visibility), "Nieprawidłowa widoczność", "INVALID_VISIBILITY");
  return {
    id: payload.id,
    title: payload.title.trim(),
    clinician: payload.clinician.trim(),
    specialty: normalizeOptionalText(payload.specialty),
    date: payload.date,
    time: payload.time,
    location: normalizeOptionalText(payload.location),
    status: payload.status,
    notes: normalizeOptionalText(payload.notes),
    visibility: payload.visibility,
  };
}

// `visibility` IS in the update key set (docs/plans/zdrowie-sql.md "Ryzyka": HealthPage lets the
// user change an appointment's visibility after creation -- omitting it here would be a
// regression, the exact class of bug seen in Finanse). `toggleAppointmentCompleted` (HealthPage)
// simply sends `changes: { status }` through this same op.
const APPOINTMENT_UPDATE_KEYS = new Set([
  "title",
  "clinician",
  "specialty",
  "date",
  "time",
  "location",
  "status",
  "notes",
  "visibility",
]);

export function validateAppointmentUpdatePayload(payload, baseVersion) {
  assertShape(isPlainObject(payload), "Nieprawidłowy ładunek mutacji", "INVALID_PAYLOAD");
  assertShape(isId(payload.id), "Nieprawidłowy identyfikator wizyty", "INVALID_ID");
  assertShape(isPlainObject(payload.changes), "Brak zmian do zastosowania", "INVALID_CHANGES");
  for (const key of Object.keys(payload.changes)) {
    assertShape(
      APPOINTMENT_UPDATE_KEYS.has(key),
      `Pola "${key}" nie można edytować`,
      "INVALID_CHANGES",
    );
  }
  const version = normalizeRequiredVersion(baseVersion);
  const changes = {};
  const c = payload.changes;
  if (c.title !== undefined) {
    assertShape(isNonEmptyText(c.title, 500), "Nieprawidłowy tytuł wizyty", "INVALID_TITLE");
    changes.title = c.title.trim();
  }
  if (c.clinician !== undefined) {
    assertShape(isNonEmptyText(c.clinician, 500), "Nieprawidłowy lekarz/placówka", "INVALID_CLINICIAN");
    changes.clinician = c.clinician.trim();
  }
  if (Object.prototype.hasOwnProperty.call(c, "specialty")) {
    assertShape(
      c.specialty === null || isOptionalText(c.specialty, 500),
      "Nieprawidłowa specjalizacja",
      "INVALID_SPECIALTY",
    );
    changes.specialty = normalizeOptionalText(c.specialty);
  }
  if (c.date !== undefined) {
    assertShape(isIsoDate(c.date), "Nieprawidłowa data wizyty", "INVALID_DATE");
    changes.date = c.date;
  }
  if (c.time !== undefined) {
    assertShape(isClockTime(c.time), "Nieprawidłowa godzina wizyty", "INVALID_TIME");
    changes.time = c.time;
  }
  if (Object.prototype.hasOwnProperty.call(c, "location")) {
    assertShape(
      c.location === null || isOptionalText(c.location, 1000),
      "Nieprawidłowa lokalizacja",
      "INVALID_LOCATION",
    );
    changes.location = normalizeOptionalText(c.location);
  }
  if (c.status !== undefined) {
    assertShape(APPOINTMENT_STATUSES.has(c.status), "Nieprawidłowy status wizyty", "INVALID_STATUS");
    changes.status = c.status;
  }
  if (Object.prototype.hasOwnProperty.call(c, "notes")) {
    assertShape(
      c.notes === null || isOptionalText(c.notes, 5000),
      "Nieprawidłowe notatki",
      "INVALID_NOTES",
    );
    changes.notes = normalizeOptionalText(c.notes);
  }
  if (c.visibility !== undefined) {
    assertShape(VISIBILITIES.has(c.visibility), "Nieprawidłowa widoczność", "INVALID_VISIBILITY");
    changes.visibility = c.visibility;
  }
  return { id: payload.id, changes, baseVersion: version };
}

export function validateDeleteIdPayload(payload) {
  assertShape(isPlainObject(payload), "Nieprawidłowy ładunek mutacji", "INVALID_PAYLOAD");
  assertShape(isId(payload.id), "Nieprawidłowy identyfikator", "INVALID_ID");
  return { id: payload.id };
}

export function validateMedicationCreatePayload(payload) {
  assertShape(isPlainObject(payload), "Nieprawidłowy ładunek mutacji", "INVALID_PAYLOAD");
  assertShape(isId(payload.id), "Nieprawidłowy identyfikator leku", "INVALID_ID");
  assertShape(isNonEmptyText(payload.name, 500), "Nieprawidłowa nazwa leku", "INVALID_NAME");
  assertShape(isNonEmptyText(payload.dosage, 200), "Nieprawidłowa dawka", "INVALID_DOSAGE");
  assertShape(isNonEmptyText(payload.schedule, 500), "Nieprawidłowy harmonogram", "INVALID_SCHEDULE");
  assertShape(typeof payload.active === "boolean", "Nieprawidłowy status aktywności", "INVALID_ACTIVE");
  if (payload.lastTakenOn !== undefined && payload.lastTakenOn !== null) {
    assertShape(isIsoDate(payload.lastTakenOn), "Nieprawidłowa data przyjęcia", "INVALID_LAST_TAKEN_ON");
  }
  if (payload.reminderTime !== undefined && payload.reminderTime !== null) {
    assertShape(
      isClockTime(payload.reminderTime),
      "Nieprawidłowa godzina przypomnienia",
      "INVALID_REMINDER_TIME",
    );
  }
  assertShape(VISIBILITIES.has(payload.visibility), "Nieprawidłowa widoczność", "INVALID_VISIBILITY");
  return {
    id: payload.id,
    name: payload.name.trim(),
    dosage: payload.dosage.trim(),
    schedule: payload.schedule.trim(),
    active: payload.active,
    lastTakenOn: payload.lastTakenOn ?? null,
    reminderTime: payload.reminderTime ?? null,
    visibility: payload.visibility,
  };
}

// `visibility` IS in the update key set (same "Ryzyka" note as APPOINTMENT_UPDATE_KEYS).
// `toggleMedicationActive` sends `changes: { active }`; `toggleMedicationTaken` sends
// `changes: { lastTakenOn }` -- both are plain updates through this same op, the client having
// already computed the toggled value locally (docs/plans/zdrowie-sql.md "Projekt pól
// specjalnych": `lastTakenOn` is a REAL toggle, not an idempotent set).
const MEDICATION_UPDATE_KEYS = new Set([
  "name",
  "dosage",
  "schedule",
  "active",
  "reminderTime",
  "lastTakenOn",
  "visibility",
]);

export function validateMedicationUpdatePayload(payload, baseVersion) {
  assertShape(isPlainObject(payload), "Nieprawidłowy ładunek mutacji", "INVALID_PAYLOAD");
  assertShape(isId(payload.id), "Nieprawidłowy identyfikator leku", "INVALID_ID");
  assertShape(isPlainObject(payload.changes), "Brak zmian do zastosowania", "INVALID_CHANGES");
  for (const key of Object.keys(payload.changes)) {
    assertShape(
      MEDICATION_UPDATE_KEYS.has(key),
      `Pola "${key}" nie można edytować`,
      "INVALID_CHANGES",
    );
  }
  const version = normalizeRequiredVersion(baseVersion);
  const changes = {};
  const c = payload.changes;
  if (c.name !== undefined) {
    assertShape(isNonEmptyText(c.name, 500), "Nieprawidłowa nazwa leku", "INVALID_NAME");
    changes.name = c.name.trim();
  }
  if (c.dosage !== undefined) {
    assertShape(isNonEmptyText(c.dosage, 200), "Nieprawidłowa dawka", "INVALID_DOSAGE");
    changes.dosage = c.dosage.trim();
  }
  if (c.schedule !== undefined) {
    assertShape(isNonEmptyText(c.schedule, 500), "Nieprawidłowy harmonogram", "INVALID_SCHEDULE");
    changes.schedule = c.schedule.trim();
  }
  if (c.active !== undefined) {
    assertShape(typeof c.active === "boolean", "Nieprawidłowy status aktywności", "INVALID_ACTIVE");
    changes.active = c.active;
  }
  if (Object.prototype.hasOwnProperty.call(c, "reminderTime")) {
    assertShape(
      c.reminderTime === null || isClockTime(c.reminderTime),
      "Nieprawidłowa godzina przypomnienia",
      "INVALID_REMINDER_TIME",
    );
    changes.reminderTime = c.reminderTime ?? null;
  }
  // `lastTakenOn` is nullable and cleared with `null` (hasOwnProperty pattern, wzór
  // `species`/`notes` w pets.mjs) -- the client computes the real toggle locally (current value
  // === date ? null : date) and the server just persists 1:1, it does not re-derive the toggle.
  if (Object.prototype.hasOwnProperty.call(c, "lastTakenOn")) {
    assertShape(
      c.lastTakenOn === null || isIsoDate(c.lastTakenOn),
      "Nieprawidłowa data przyjęcia",
      "INVALID_LAST_TAKEN_ON",
    );
    changes.lastTakenOn = c.lastTakenOn ?? null;
  }
  if (c.visibility !== undefined) {
    assertShape(VISIBILITIES.has(c.visibility), "Nieprawidłowa widoczność", "INVALID_VISIBILITY");
    changes.visibility = c.visibility;
  }
  return { id: payload.id, changes, baseVersion: version };
}

export function validateMeasurementCreatePayload(payload) {
  assertShape(isPlainObject(payload), "Nieprawidłowy ładunek mutacji", "INVALID_PAYLOAD");
  assertShape(isId(payload.id), "Nieprawidłowy identyfikator pomiaru", "INVALID_ID");
  assertShape(MEASUREMENT_TYPES.has(payload.type), "Nieprawidłowy typ pomiaru", "INVALID_TYPE");
  assertShape(isNonEmptyText(payload.value, 200), "Nieprawidłowa wartość pomiaru", "INVALID_VALUE");
  // `unit` allows empty string (e.g. blood pressure has no unit) -- `z.string().max(100)`, NOT
  // nonEmptyText.
  assertShape(isOptionalText(payload.unit, 100), "Nieprawidłowa jednostka", "INVALID_UNIT");
  assertShape(
    isParsableTimestamp(payload.measuredAt),
    "Nieprawidłowa data/godzina pomiaru",
    "INVALID_MEASURED_AT",
  );
  if (payload.notes !== undefined && payload.notes !== null) {
    assertShape(isOptionalText(payload.notes, 5000), "Nieprawidłowe notatki", "INVALID_NOTES");
  }
  assertShape(VISIBILITIES.has(payload.visibility), "Nieprawidłowa widoczność", "INVALID_VISIBILITY");
  return {
    id: payload.id,
    type: payload.type,
    value: payload.value.trim(),
    unit: payload.unit,
    measuredAt: payload.measuredAt,
    notes: normalizeOptionalText(payload.notes),
    visibility: payload.visibility,
  };
}

// `visibility` IS in the update key set (same "Ryzyka" note as the other two).
const MEASUREMENT_UPDATE_KEYS = new Set(["type", "value", "unit", "measuredAt", "notes", "visibility"]);

export function validateMeasurementUpdatePayload(payload, baseVersion) {
  assertShape(isPlainObject(payload), "Nieprawidłowy ładunek mutacji", "INVALID_PAYLOAD");
  assertShape(isId(payload.id), "Nieprawidłowy identyfikator pomiaru", "INVALID_ID");
  assertShape(isPlainObject(payload.changes), "Brak zmian do zastosowania", "INVALID_CHANGES");
  for (const key of Object.keys(payload.changes)) {
    assertShape(
      MEASUREMENT_UPDATE_KEYS.has(key),
      `Pola "${key}" nie można edytować`,
      "INVALID_CHANGES",
    );
  }
  const version = normalizeRequiredVersion(baseVersion);
  const changes = {};
  const c = payload.changes;
  if (c.type !== undefined) {
    assertShape(MEASUREMENT_TYPES.has(c.type), "Nieprawidłowy typ pomiaru", "INVALID_TYPE");
    changes.type = c.type;
  }
  if (c.value !== undefined) {
    assertShape(isNonEmptyText(c.value, 200), "Nieprawidłowa wartość pomiaru", "INVALID_VALUE");
    changes.value = c.value.trim();
  }
  if (c.unit !== undefined) {
    assertShape(isOptionalText(c.unit, 100), "Nieprawidłowa jednostka", "INVALID_UNIT");
    changes.unit = c.unit;
  }
  if (c.measuredAt !== undefined) {
    assertShape(
      isParsableTimestamp(c.measuredAt),
      "Nieprawidłowa data/godzina pomiaru",
      "INVALID_MEASURED_AT",
    );
    changes.measuredAt = c.measuredAt;
  }
  if (Object.prototype.hasOwnProperty.call(c, "notes")) {
    assertShape(
      c.notes === null || isOptionalText(c.notes, 5000),
      "Nieprawidłowe notatki",
      "INVALID_NOTES",
    );
    changes.notes = normalizeOptionalText(c.notes);
  }
  if (c.visibility !== undefined) {
    assertShape(VISIBILITIES.has(c.visibility), "Nieprawidłowa widoczność", "INVALID_VISIBILITY");
    changes.visibility = c.visibility;
  }
  return { id: payload.id, changes, baseVersion: version };
}

// ---------------------------------------------------------------------------
// Mutation envelope + supported ops
// ---------------------------------------------------------------------------

export const SUPPORTED_HEALTH_OPS = new Set([
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

// Whole-request-shape validation, mirroring assertPetsMutationShape/assertCarMutationShape:
// called once per mutation BEFORE any DB work starts, so a malformed entry anywhere in the batch
// is rejected as a single 400 rather than silently corrupting bookkeeping for its siblings.
// Per-mutation *business* validation (bad field values, missing record, ...) is reported as
// `status: "error"` inside `results` by applyHealthMutation instead.
export function assertHealthMutationShape(mutation) {
  if (!isPlainObject(mutation)) {
    throw healthRequestError(400, "Nieprawidłowy kształt mutacji", "INVALID_HEALTH_MUTATION");
  }
  if (typeof mutation.idempotencyKey !== "string" || !UUID_PATTERN.test(mutation.idempotencyKey)) {
    throw healthRequestError(400, "Nieprawidłowy klucz idempotencji", "INVALID_IDEMPOTENCY_KEY");
  }
  if (typeof mutation.op !== "string" || !SUPPORTED_HEALTH_OPS.has(mutation.op)) {
    throw healthRequestError(400, "Nieobsługiwana operacja mutacji", "UNSUPPORTED_OP");
  }
  if (!isPlainObject(mutation.payload)) {
    throw healthRequestError(400, "Brak danych mutacji", "INVALID_HEALTH_MUTATION");
  }
  if (
    mutation.baseVersion !== undefined &&
    mutation.baseVersion !== null &&
    !Number.isInteger(mutation.baseVersion)
  ) {
    throw healthRequestError(400, "Nieprawidłowa wersja bazowa mutacji", "INVALID_HEALTH_MUTATION");
  }
}

export const MAX_HEALTH_MUTATIONS_PER_BATCH = Number(process.env.MAX_HEALTH_MUTATIONS ?? 500);
export const MAX_HEALTH_MUTATIONS_BYTES = Number(
  process.env.MAX_HEALTH_MUTATIONS_BYTES ?? 2_000_000,
);

// ---------------------------------------------------------------------------
// Snapshot read (GET /api/v1/health): household-wide records + the caller's own private records,
// for all three tables (wzór readPetsSnapshot). All three tables scope purely by their own row --
// no EXISTS-on-parent anywhere here (there is no parent).
// ---------------------------------------------------------------------------

export async function readHealthSnapshot(client, householdId, userId) {
  // Sequential, not Promise.all: `client` may be a single-connection PoolClient (e.g. when called
  // inside a transaction()), and node-postgres only supports one in-flight query per connection.
  const healthAppointments = await client.query(
    `SELECT ${APPOINTMENT_SELECT_COLUMNS} FROM health_appointments
      WHERE household_id = $1 AND (visibility = 'household' OR owner_id = $2)
      ORDER BY date, time`,
    [householdId, userId],
  );
  const medications = await client.query(
    `SELECT ${MEDICATION_SELECT_COLUMNS} FROM medications
      WHERE household_id = $1 AND (visibility = 'household' OR owner_id = $2)
      ORDER BY created_at`,
    [householdId, userId],
  );
  const healthMeasurements = await client.query(
    `SELECT ${MEASUREMENT_SELECT_COLUMNS} FROM health_measurements
      WHERE household_id = $1 AND (visibility = 'household' OR owner_id = $2)
      ORDER BY measured_at DESC, created_at DESC`,
    [householdId, userId],
  );
  return {
    healthAppointments: healthAppointments.rows.map(appointmentRowToDto),
    medications: medications.rows.map(medicationRowToDto),
    healthMeasurements: healthMeasurements.rows.map(measurementRowToDto),
  };
}

// Wspiera "Wyczyść dane aplikacji" (SettingsPage.tsx danger zone). Wzór resetPetsForUser: usuwa
// wszystko wspólne (`visibility = 'household'`) plus WYŁĄCZNIE prywatne rekordy wywołującego
// użytkownika (`owner_id = userId`) w danym gospodarstwie -- NIE cały reset gospodarstwa jak w
// trips/meals, bo Zdrowie ma dużo rekordów prywatnych. Trzy niezależne DELETE (kolejność
// dowolna -- brak FK między tabelami Zdrowia).
export async function resetHealthForUser(client, householdId, userId) {
  await client.query(
    `DELETE FROM health_appointments
      WHERE household_id = $1 AND (visibility = 'household' OR owner_id = $2)`,
    [householdId, userId],
  );
  await client.query(
    `DELETE FROM medications
      WHERE household_id = $1 AND (visibility = 'household' OR owner_id = $2)`,
    [householdId, userId],
  );
  await client.query(
    `DELETE FROM health_measurements
      WHERE household_id = $1 AND (visibility = 'household' OR owner_id = $2)`,
    [householdId, userId],
  );
}

// ---------------------------------------------------------------------------
// Shared OCC/conflict resolution helpers used by every update/delete op (mirrors pets.mjs). The
// lookup query MUST carry the same household/visibility scoping as the write it's diagnosing --
// otherwise this could leak the existence or content of another user's private record through
// the "current record" in a conflict response (docs/plans/zdrowie-sql.md "Bezpieczeństwo
// scope'u widoczności").
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
// Per-op SQL execution. Each function assumes payload/baseVersion have already been shape-checked
// by assertHealthMutationShape; they still run their own (business-rule) validators and throw
// HealthValidationError on bad input, which applyHealthMutation turns into `status: "error"`.
// ---------------------------------------------------------------------------

async function execAppointmentCreate(client, ctx, payload) {
  const data = validateAppointmentCreatePayload(payload);
  const ownerId = resolveOwnerId(ctx);
  try {
    const inserted = await client.query(
      `INSERT INTO health_appointments
         (id, household_id, owner_id, visibility, title, clinician, specialty, date, time,
          location, status, notes, version, updated_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8::date, $9, $10, $11, $12, 1, $3)
       RETURNING ${APPOINTMENT_SELECT_COLUMNS}`,
      [
        data.id,
        ctx.householdId,
        ownerId,
        data.visibility,
        data.title,
        data.clinician,
        data.specialty,
        data.date,
        data.time,
        data.location,
        data.status,
        data.notes,
      ],
    );
    return { status: "applied", record: appointmentRowToDto(inserted.rows[0]) };
  } catch (error) {
    if (error.code === "23505") {
      return resolveConflictOrError(
        client,
        `SELECT ${APPOINTMENT_SELECT_COLUMNS} FROM health_appointments
          WHERE id = $1 AND household_id = $2 AND (visibility = 'household' OR owner_id = $3)`,
        [data.id, ctx.householdId, ownerId],
        appointmentRowToDto,
        "Identyfikator jest już używany",
        "ID_TAKEN",
      );
    }
    throw error;
  }
}

async function execAppointmentUpdate(client, ctx, payload, baseVersion) {
  const { id, changes, baseVersion: version } = validateAppointmentUpdatePayload(
    payload,
    baseVersion,
  );
  const ownerId = resolveOwnerId(ctx);
  const hasSpecialty = Object.prototype.hasOwnProperty.call(changes, "specialty");
  const hasLocation = Object.prototype.hasOwnProperty.call(changes, "location");
  const hasNotes = Object.prototype.hasOwnProperty.call(changes, "notes");
  const updated = await client.query(
    `UPDATE health_appointments
        SET title = COALESCE($1, title),
            clinician = COALESCE($2, clinician),
            specialty = CASE WHEN $3 THEN $4 ELSE specialty END,
            date = COALESCE($5::date, date),
            time = COALESCE($6, time),
            location = CASE WHEN $7 THEN $8 ELSE location END,
            status = COALESCE($9, status),
            notes = CASE WHEN $10 THEN $11 ELSE notes END,
            visibility = COALESCE($12, visibility),
            version = version + 1,
            updated_at = now(),
            updated_by = $13
      WHERE id = $14 AND household_id = $15 AND version = $16
        AND (visibility = 'household' OR owner_id = $13)
      RETURNING ${APPOINTMENT_SELECT_COLUMNS}`,
    [
      changes.title ?? null,
      changes.clinician ?? null,
      hasSpecialty,
      hasSpecialty ? changes.specialty : null,
      changes.date ?? null,
      changes.time ?? null,
      hasLocation,
      hasLocation ? changes.location : null,
      changes.status ?? null,
      hasNotes,
      hasNotes ? changes.notes : null,
      changes.visibility ?? null,
      ownerId,
      id,
      ctx.householdId,
      version,
    ],
  );
  if (updated.rowCount) return { status: "applied", record: appointmentRowToDto(updated.rows[0]) };
  return resolveConflictOrError(
    client,
    `SELECT ${APPOINTMENT_SELECT_COLUMNS} FROM health_appointments
      WHERE id = $1 AND household_id = $2 AND (visibility = 'household' OR owner_id = $3)`,
    [id, ctx.householdId, ownerId],
    appointmentRowToDto,
    "Rekord nie istnieje lub jest niedostępny",
    "NOT_FOUND",
  );
}

async function execAppointmentDelete(client, ctx, payload, baseVersion) {
  const { id } = validateDeleteIdPayload(payload);
  const ownerId = resolveOwnerId(ctx);
  const version = normalizeOptionalVersion(baseVersion);
  const deleted = await client.query(
    `DELETE FROM health_appointments
      WHERE id = $1 AND household_id = $2 AND (visibility = 'household' OR owner_id = $3)
        AND ($4::integer IS NULL OR version = $4)
      RETURNING id`,
    [id, ctx.householdId, ownerId, version],
  );
  if (deleted.rowCount) return { status: "applied", record: null };
  return resolveConflictOrGone(
    client,
    `SELECT ${APPOINTMENT_SELECT_COLUMNS} FROM health_appointments
      WHERE id = $1 AND household_id = $2 AND (visibility = 'household' OR owner_id = $3)`,
    [id, ctx.householdId, ownerId],
    appointmentRowToDto,
  );
}

async function execMedicationCreate(client, ctx, payload) {
  const data = validateMedicationCreatePayload(payload);
  const ownerId = resolveOwnerId(ctx);
  try {
    const inserted = await client.query(
      `INSERT INTO medications
         (id, household_id, owner_id, visibility, name, dosage, schedule, active, last_taken_on,
          reminder_time, version, updated_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::date, $10, 1, $3)
       RETURNING ${MEDICATION_SELECT_COLUMNS}`,
      [
        data.id,
        ctx.householdId,
        ownerId,
        data.visibility,
        data.name,
        data.dosage,
        data.schedule,
        data.active,
        data.lastTakenOn,
        data.reminderTime,
      ],
    );
    return { status: "applied", record: medicationRowToDto(inserted.rows[0]) };
  } catch (error) {
    if (error.code === "23505") {
      return resolveConflictOrError(
        client,
        `SELECT ${MEDICATION_SELECT_COLUMNS} FROM medications
          WHERE id = $1 AND household_id = $2 AND (visibility = 'household' OR owner_id = $3)`,
        [data.id, ctx.householdId, ownerId],
        medicationRowToDto,
        "Identyfikator jest już używany",
        "ID_TAKEN",
      );
    }
    throw error;
  }
}

// Covers `updateMedication`, `toggleMedicationActive` (`changes: { active }`) AND
// `toggleMedicationTaken` (`changes: { lastTakenOn }`) -- all three are plain updates through
// this op, the client having already computed the (possibly toggled) value locally.
async function execMedicationUpdate(client, ctx, payload, baseVersion) {
  const { id, changes, baseVersion: version } = validateMedicationUpdatePayload(
    payload,
    baseVersion,
  );
  const ownerId = resolveOwnerId(ctx);
  const hasReminderTime = Object.prototype.hasOwnProperty.call(changes, "reminderTime");
  const hasLastTakenOn = Object.prototype.hasOwnProperty.call(changes, "lastTakenOn");
  const updated = await client.query(
    `UPDATE medications
        SET name = COALESCE($1, name),
            dosage = COALESCE($2, dosage),
            schedule = COALESCE($3, schedule),
            active = COALESCE($4, active),
            reminder_time = CASE WHEN $5 THEN $6 ELSE reminder_time END,
            last_taken_on = CASE WHEN $7 THEN $8::date ELSE last_taken_on END,
            visibility = COALESCE($9, visibility),
            version = version + 1,
            updated_at = now(),
            updated_by = $10
      WHERE id = $11 AND household_id = $12 AND version = $13
        AND (visibility = 'household' OR owner_id = $10)
      RETURNING ${MEDICATION_SELECT_COLUMNS}`,
    [
      changes.name ?? null,
      changes.dosage ?? null,
      changes.schedule ?? null,
      changes.active ?? null,
      hasReminderTime,
      hasReminderTime ? changes.reminderTime : null,
      hasLastTakenOn,
      hasLastTakenOn ? changes.lastTakenOn : null,
      changes.visibility ?? null,
      ownerId,
      id,
      ctx.householdId,
      version,
    ],
  );
  if (updated.rowCount) return { status: "applied", record: medicationRowToDto(updated.rows[0]) };
  return resolveConflictOrError(
    client,
    `SELECT ${MEDICATION_SELECT_COLUMNS} FROM medications
      WHERE id = $1 AND household_id = $2 AND (visibility = 'household' OR owner_id = $3)`,
    [id, ctx.householdId, ownerId],
    medicationRowToDto,
    "Rekord nie istnieje lub jest niedostępny",
    "NOT_FOUND",
  );
}

async function execMedicationDelete(client, ctx, payload, baseVersion) {
  const { id } = validateDeleteIdPayload(payload);
  const ownerId = resolveOwnerId(ctx);
  const version = normalizeOptionalVersion(baseVersion);
  const deleted = await client.query(
    `DELETE FROM medications
      WHERE id = $1 AND household_id = $2 AND (visibility = 'household' OR owner_id = $3)
        AND ($4::integer IS NULL OR version = $4)
      RETURNING id`,
    [id, ctx.householdId, ownerId, version],
  );
  if (deleted.rowCount) return { status: "applied", record: null };
  return resolveConflictOrGone(
    client,
    `SELECT ${MEDICATION_SELECT_COLUMNS} FROM medications
      WHERE id = $1 AND household_id = $2 AND (visibility = 'household' OR owner_id = $3)`,
    [id, ctx.householdId, ownerId],
    medicationRowToDto,
  );
}

async function execMeasurementCreate(client, ctx, payload) {
  const data = validateMeasurementCreatePayload(payload);
  const ownerId = resolveOwnerId(ctx);
  try {
    const inserted = await client.query(
      `INSERT INTO health_measurements
         (id, household_id, owner_id, visibility, type, value, unit, measured_at, notes, version,
          updated_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 1, $3)
       RETURNING ${MEASUREMENT_SELECT_COLUMNS}`,
      [
        data.id,
        ctx.householdId,
        ownerId,
        data.visibility,
        data.type,
        data.value,
        data.unit,
        data.measuredAt,
        data.notes,
      ],
    );
    return { status: "applied", record: measurementRowToDto(inserted.rows[0]) };
  } catch (error) {
    if (error.code === "23505") {
      return resolveConflictOrError(
        client,
        `SELECT ${MEASUREMENT_SELECT_COLUMNS} FROM health_measurements
          WHERE id = $1 AND household_id = $2 AND (visibility = 'household' OR owner_id = $3)`,
        [data.id, ctx.householdId, ownerId],
        measurementRowToDto,
        "Identyfikator jest już używany",
        "ID_TAKEN",
      );
    }
    throw error;
  }
}

async function execMeasurementUpdate(client, ctx, payload, baseVersion) {
  const { id, changes, baseVersion: version } = validateMeasurementUpdatePayload(
    payload,
    baseVersion,
  );
  const ownerId = resolveOwnerId(ctx);
  const hasNotes = Object.prototype.hasOwnProperty.call(changes, "notes");
  const updated = await client.query(
    `UPDATE health_measurements
        SET type = COALESCE($1, type),
            value = COALESCE($2, value),
            unit = COALESCE($3, unit),
            measured_at = COALESCE($4, measured_at),
            notes = CASE WHEN $5 THEN $6 ELSE notes END,
            visibility = COALESCE($7, visibility),
            version = version + 1,
            updated_at = now(),
            updated_by = $8
      WHERE id = $9 AND household_id = $10 AND version = $11
        AND (visibility = 'household' OR owner_id = $8)
      RETURNING ${MEASUREMENT_SELECT_COLUMNS}`,
    [
      changes.type ?? null,
      changes.value ?? null,
      changes.unit ?? null,
      changes.measuredAt ?? null,
      hasNotes,
      hasNotes ? changes.notes : null,
      changes.visibility ?? null,
      ownerId,
      id,
      ctx.householdId,
      version,
    ],
  );
  if (updated.rowCount) return { status: "applied", record: measurementRowToDto(updated.rows[0]) };
  return resolveConflictOrError(
    client,
    `SELECT ${MEASUREMENT_SELECT_COLUMNS} FROM health_measurements
      WHERE id = $1 AND household_id = $2 AND (visibility = 'household' OR owner_id = $3)`,
    [id, ctx.householdId, ownerId],
    measurementRowToDto,
    "Rekord nie istnieje lub jest niedostępny",
    "NOT_FOUND",
  );
}

async function execMeasurementDelete(client, ctx, payload, baseVersion) {
  const { id } = validateDeleteIdPayload(payload);
  const ownerId = resolveOwnerId(ctx);
  const version = normalizeOptionalVersion(baseVersion);
  const deleted = await client.query(
    `DELETE FROM health_measurements
      WHERE id = $1 AND household_id = $2 AND (visibility = 'household' OR owner_id = $3)
        AND ($4::integer IS NULL OR version = $4)
      RETURNING id`,
    [id, ctx.householdId, ownerId, version],
  );
  if (deleted.rowCount) return { status: "applied", record: null };
  return resolveConflictOrGone(
    client,
    `SELECT ${MEASUREMENT_SELECT_COLUMNS} FROM health_measurements
      WHERE id = $1 AND household_id = $2 AND (visibility = 'household' OR owner_id = $3)`,
    [id, ctx.householdId, ownerId],
    measurementRowToDto,
  );
}

async function executeHealthOp(client, ctx, op, payload, baseVersion) {
  switch (op) {
    case "appointment.create":
      return execAppointmentCreate(client, ctx, payload);
    case "appointment.update":
      return execAppointmentUpdate(client, ctx, payload, baseVersion);
    case "appointment.delete":
      return execAppointmentDelete(client, ctx, payload, baseVersion);
    case "medication.create":
      return execMedicationCreate(client, ctx, payload);
    case "medication.update":
      return execMedicationUpdate(client, ctx, payload, baseVersion);
    case "medication.delete":
      return execMedicationDelete(client, ctx, payload, baseVersion);
    case "measurement.create":
      return execMeasurementCreate(client, ctx, payload);
    case "measurement.update":
      return execMeasurementUpdate(client, ctx, payload, baseVersion);
    case "measurement.delete":
      return execMeasurementDelete(client, ctx, payload, baseVersion);
    default:
      // Unreachable when called through applyHealthMutation (assertHealthMutationShape already
      // rejected unknown ops at the request level); kept defensive in case of direct unit-test
      // calls.
      throw new HealthValidationError(`Nieobsługiwana operacja: ${op}`, "UNSUPPORTED_OP");
  }
}

// ---------------------------------------------------------------------------
// Idempotent mutation entry point. `mutation` is assumed to already have passed
// assertHealthMutationShape (server.mjs validates the whole batch upfront). ctx = { householdId,
// userId } always comes from the authenticated session, never from the request body.
// ---------------------------------------------------------------------------

export async function applyHealthMutation(client, ctx, mutation) {
  const { idempotencyKey, op, payload, baseVersion } = mutation;

  // Claim the idempotency key first, inside the same DB transaction as the operation itself: if
  // the op below throws, the whole transaction (including this claim) rolls back, so the key
  // remains free to retry. If a row already existed, this was a retry -- return the previously
  // stored result instead of running the operation again.
  const claim = await client.query(
    `INSERT INTO health_mutations (idempotency_key, household_id, user_id, op, result)
     VALUES ($1, $2, $3, $4, '{}'::jsonb)
     ON CONFLICT (idempotency_key) DO NOTHING`,
    [idempotencyKey, ctx.householdId, ctx.userId, op],
  );
  if (!claim.rowCount) {
    const existing = await client.query(
      `SELECT result FROM health_mutations WHERE idempotency_key = $1`,
      [idempotencyKey],
    );
    return existing.rows[0]?.result ?? { idempotencyKey, status: "duplicate" };
  }

  let outcome;
  try {
    outcome = await executeHealthOp(client, ctx, op, payload, baseVersion);
  } catch (error) {
    if (error instanceof HealthValidationError) {
      outcome = { status: "error", error: error.message, code: error.code };
    } else {
      throw error;
    }
  }

  const result = { idempotencyKey, ...outcome };
  await client.query(`UPDATE health_mutations SET result = $1::jsonb WHERE idempotency_key = $2`, [
    JSON.stringify(result),
    idempotencyKey,
  ]);
  return result;
}
