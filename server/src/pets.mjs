// Domain layer for the normalized Pets (Zwierzęta) module.
//
// Data model: server/migrations/010_pets_normalized.sql (pets, pet_expenses, pet_visits,
// pet_mutations). Design source of truth: docs/plans/zwierzeta-sql.md ("Podejście" section).
//
// This is the Pets analogue of server/src/car.mjs (owner_id/visibility preserved on the parent,
// like vehicles) but STRICTLY SIMPLER (docs/plans/zwierzeta-sql.md "Czym Zwierzęta są PROSTSZE od
// Auta"):
//   1. No aggregate/monotonic field -- there is no analogue of `Vehicle.mileage`. Every mutation is
//      a plain create / OCC-update / delete. No `execVehicleMileage`, no `upsertAutoDeadline`.
//   2. No server-authored children -- `pet_visits` are entirely user-created (unlike
//      `vehicle_deadlines`'s auto-upserted inspection/insurance rows).
//   3. BOTH children (`pet_expenses`, `pet_visits`) have their OWN `owner_id`/`visibility` columns
//      (unlike `vehicle_deadlines`, which has none and scopes through `EXISTS` on the parent
//      vehicle). Every access/conflict query against pet_expenses/pet_visits filters on its own row
//      (`visibility = 'household' OR owner_id = $user`), never through `EXISTS`.
//
// New relative to Car: `Pet.fishStock` (the `kind === 'aquarium'` variant) is a nested JSONB array
// column on `pets`, wzór `Trip.travelers` in trips.mjs -- it travels atomically with the parent
// record, with no version/collision of its own (last-write-wins on the whole `pets` row via OCC).
//
// Like car.mjs/finance.mjs/trips.mjs, this module intentionally does NOT import the zod schemas
// from src/lib/schema.ts: the server package has no TypeScript build step and no zod dependency.
// The validators below hand-roll the same rules as `petSchema`/`petExpenseSchema`/`petVisitSchema`
// in src/lib/schema.ts, scoped to the subset of fields a mutation payload carries.
//
// Every exported function here is either pure (validators, resolveOwnerId,
// resolveExpenseVisibility/resolveVisitVisibility, resolveVersionConflict, row->DTO mappers) or
// takes an already-connected `client` (a pg PoolClient, or the shared `pool` from db.mjs) so it can
// run either inside a transaction() or directly against the pool.

export class PetValidationError extends Error {
  constructor(message, code = "VALIDATION_ERROR") {
    super(message);
    this.name = "PetValidationError";
    this.code = code;
  }
}

function petRequestError(statusCode, message, code) {
  const error = new Error(message);
  error.statusCode = statusCode;
  error.code = code;
  return error;
}

// ---------------------------------------------------------------------------
// Primitive validators (mirror src/lib/schema.ts / src/petsTypes.ts)
// ---------------------------------------------------------------------------

const ID_MAX_LENGTH = 200;
const VISIBILITIES = new Set(["private", "household"]);
const PET_KINDS = new Set(["rabbit", "dog", "cat", "guinea_pig", "aquarium", "other"]);
const EXPENSE_TYPES = new Set(["food", "vet", "accessories", "grooming", "other"]);
const VISIT_STATUSES = new Set(["scheduled", "completed", "cancelled"]);
const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const TIME_PATTERN = /^\d{2}:\d{2}$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_FISH_STOCK = 500;

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

function isClockTime(value) {
  return typeof value === "string" && TIME_PATTERN.test(value);
}

// Wzór isTravelersArray z trips.mjs -- hand-rolled mirror of fishStockEntrySchema
// (src/lib/schema.ts): { id, species, count }[], cap 500 (parity with `.max(500)`).
function isFishStockArray(value) {
  return (
    Array.isArray(value) &&
    value.length <= MAX_FISH_STOCK &&
    value.every(
      (item) =>
        isPlainObject(item) &&
        isId(item.id) &&
        isNonEmptyText(item.species, 500) &&
        isNonNegativeInteger(item.count),
    )
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
  if (!condition) throw new PetValidationError(message, code);
}

// ---------------------------------------------------------------------------
// Security invariants (docs/ARCHITECTURE.md "Dane wspólne i prywatne")
// ---------------------------------------------------------------------------

// owner_id is always derived from the authenticated session -- a client-supplied ownerId in the
// mutation payload (if present) is always ignored. This is the single choke point that enforces it
// (parity with car.mjs/finance.mjs's resolveOwnerId).
export function resolveOwnerId(ctx) {
  return ctx.userId;
}

// expense.create without an explicit visibility inherits it from the parent pet (today's UI
// behavior, preserved 1:1 -- wzór resolveTransactionVisibility/resolveExpenseVisibility, finance.mjs
// / car.mjs).
export function resolveExpenseVisibility(payloadVisibility, petVisibility) {
  return payloadVisibility === "private" || payloadVisibility === "household"
    ? payloadVisibility
    : petVisibility;
}

// visit.create without an explicit visibility inherits it from the parent pet, same rule as
// resolveExpenseVisibility (docs/plans/zwierzeta-sql.md "Decyzje ustalone z góry" #5).
export function resolveVisitVisibility(payloadVisibility, petVisibility) {
  return payloadVisibility === "private" || payloadVisibility === "household"
    ? payloadVisibility
    : petVisibility;
}

// Pure helper naming the core OCC decision explicitly, unit-testable in isolation (mirrors
// car.mjs/finance.mjs's resolveVersionConflict). The authoritative check always happens in SQL
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
// Row -> DTO mapping (snake_case columns -> the Pet/PetExpense/PetVisit shapes in src/petsTypes.ts).
// `bigint` columns arrive from node-postgres as strings, coerced with Number(); `date` columns are
// cast to text in SQL (`::text`) to dodge node-postgres's local-timezone Date parsing; `timestamptz`
// columns are safe to read as JS Date and converted with `.toISOString()`. `fish_stock` (jsonb) comes
// back already parsed into a JS array (or null) by node-postgres.
// ---------------------------------------------------------------------------

export function petRowToDto(row) {
  return {
    id: row.id,
    ownerId: row.owner_id,
    visibility: row.visibility,
    name: row.name,
    kind: row.kind,
    color: row.color,
    species: row.species ?? undefined,
    birthDate: row.birth_date ?? undefined,
    fishStock: Array.isArray(row.fish_stock) ? row.fish_stock : undefined,
    notes: row.notes ?? undefined,
    version: row.version,
    updatedAt: row.updated_at.toISOString(),
  };
}

export function petExpenseRowToDto(row) {
  return {
    id: row.id,
    ownerId: row.owner_id,
    visibility: row.visibility,
    petId: row.pet_id,
    date: row.date,
    type: row.type,
    amountMinor: Number(row.amount_minor),
    title: row.title,
    notes: row.notes ?? undefined,
    version: row.version,
    updatedAt: row.updated_at.toISOString(),
  };
}

export function petVisitRowToDto(row) {
  return {
    id: row.id,
    ownerId: row.owner_id,
    visibility: row.visibility,
    petId: row.pet_id,
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

const PET_SELECT_COLUMNS =
  "id, owner_id, visibility, name, kind, color, species, birth_date::text AS birth_date, " +
  "fish_stock, notes, version, updated_at";
const PET_EXPENSE_SELECT_COLUMNS =
  "id, owner_id, visibility, pet_id, date::text AS date, type, amount_minor, title, notes, " +
  "version, updated_at";
const PET_VISIT_SELECT_COLUMNS =
  "id, owner_id, visibility, pet_id, title, clinician, specialty, date::text AS date, time, " +
  "location, status, notes, version, updated_at";

// ---------------------------------------------------------------------------
// Payload validators per mutation `op`. Each returns a normalized object built only from allow-listed
// fields (never passing through unknown keys), or throws PetValidationError. `ownerId`, if present in
// a payload, is always ignored by the caller (see resolveOwnerId) -- these validators don't even read
// it.
// ---------------------------------------------------------------------------

export function validatePetCreatePayload(payload) {
  assertShape(isPlainObject(payload), "Nieprawidłowy ładunek mutacji", "INVALID_PAYLOAD");
  assertShape(isId(payload.id), "Nieprawidłowy identyfikator zwierzęcia", "INVALID_ID");
  assertShape(isNonEmptyText(payload.name, 500), "Nieprawidłowa nazwa zwierzęcia", "INVALID_NAME");
  assertShape(PET_KINDS.has(payload.kind), "Nieprawidłowy typ zwierzęcia", "INVALID_KIND");
  assertShape(
    typeof payload.color === "string" && payload.color.length <= 32,
    "Nieprawidłowy kolor",
    "INVALID_COLOR",
  );
  if (payload.species !== undefined && payload.species !== null) {
    assertShape(isOptionalText(payload.species, 500), "Nieprawidłowy gatunek/rasa", "INVALID_SPECIES");
  }
  if (payload.birthDate !== undefined && payload.birthDate !== null) {
    assertShape(isIsoDate(payload.birthDate), "Nieprawidłowa data urodzenia", "INVALID_BIRTH_DATE");
  }
  if (payload.fishStock !== undefined && payload.fishStock !== null) {
    assertShape(isFishStockArray(payload.fishStock), "Nieprawidłowa obsada akwarium", "INVALID_FISH_STOCK");
  }
  if (payload.notes !== undefined && payload.notes !== null) {
    assertShape(isOptionalText(payload.notes, 5000), "Nieprawidłowe notatki", "INVALID_NOTES");
  }
  assertShape(VISIBILITIES.has(payload.visibility), "Nieprawidłowa widoczność", "INVALID_VISIBILITY");
  return {
    id: payload.id,
    name: payload.name.trim(),
    kind: payload.kind,
    color: payload.color,
    species: normalizeOptionalText(payload.species),
    birthDate: payload.birthDate || null,
    fishStock: Array.isArray(payload.fishStock) ? payload.fishStock : [],
    notes: normalizeOptionalText(payload.notes),
    visibility: payload.visibility,
  };
}

// `visibility` IS in the update key set (in contrast to Car's `vehicle.update`, which does not
// expose it) -- docs/plans/zwierzeta-sql.md "Ryzyka": PetsPage lets the user change visibility of an
// existing profile after creation, so omitting it here would be a regression vs. today's
// splitWorkspaceData behavior. Changing `kind` is also allowed here (unlike Car's `fuelType`, which
// IS editable but has no variant-field side effects) -- see execPetUpdate for the authoritative
// per-`kind` normalization of species/birthDate/fishStock this triggers.
const PET_UPDATE_KEYS = new Set([
  "name",
  "kind",
  "color",
  "species",
  "birthDate",
  "fishStock",
  "notes",
  "visibility",
]);

export function validatePetUpdatePayload(payload, baseVersion) {
  assertShape(isPlainObject(payload), "Nieprawidłowy ładunek mutacji", "INVALID_PAYLOAD");
  assertShape(isId(payload.id), "Nieprawidłowy identyfikator zwierzęcia", "INVALID_ID");
  assertShape(isPlainObject(payload.changes), "Brak zmian do zastosowania", "INVALID_CHANGES");
  for (const key of Object.keys(payload.changes)) {
    assertShape(PET_UPDATE_KEYS.has(key), `Pola "${key}" nie można edytować`, "INVALID_CHANGES");
  }
  const version = normalizeRequiredVersion(baseVersion);
  const changes = {};
  const c = payload.changes;
  if (c.name !== undefined) {
    assertShape(isNonEmptyText(c.name, 500), "Nieprawidłowa nazwa zwierzęcia", "INVALID_NAME");
    changes.name = c.name.trim();
  }
  if (c.kind !== undefined) {
    assertShape(PET_KINDS.has(c.kind), "Nieprawidłowy typ zwierzęcia", "INVALID_KIND");
    changes.kind = c.kind;
  }
  if (c.color !== undefined) {
    assertShape(
      typeof c.color === "string" && c.color.length <= 32,
      "Nieprawidłowy kolor",
      "INVALID_COLOR",
    );
    changes.color = c.color;
  }
  if (Object.prototype.hasOwnProperty.call(c, "species")) {
    assertShape(
      c.species === null || isOptionalText(c.species, 500),
      "Nieprawidłowy gatunek/rasa",
      "INVALID_SPECIES",
    );
    changes.species = normalizeOptionalText(c.species);
  }
  if (Object.prototype.hasOwnProperty.call(c, "birthDate")) {
    assertShape(
      c.birthDate === null || isIsoDate(c.birthDate),
      "Nieprawidłowa data urodzenia",
      "INVALID_BIRTH_DATE",
    );
    changes.birthDate = c.birthDate ?? null;
  }
  if (Object.prototype.hasOwnProperty.call(c, "fishStock")) {
    assertShape(
      c.fishStock === null || isFishStockArray(c.fishStock),
      "Nieprawidłowa obsada akwarium",
      "INVALID_FISH_STOCK",
    );
    changes.fishStock = Array.isArray(c.fishStock) ? c.fishStock : [];
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

export function validatePetExpenseCreatePayload(payload) {
  assertShape(isPlainObject(payload), "Nieprawidłowy ładunek mutacji", "INVALID_PAYLOAD");
  assertShape(isId(payload.id), "Nieprawidłowy identyfikator wydatku", "INVALID_ID");
  assertShape(isId(payload.petId), "Nieprawidłowy identyfikator zwierzęcia", "INVALID_PET_ID");
  assertShape(isIsoDate(payload.date), "Nieprawidłowa data wydatku", "INVALID_DATE");
  assertShape(EXPENSE_TYPES.has(payload.type), "Nieprawidłowy typ wydatku", "INVALID_TYPE");
  assertShape(
    isSafeMoney(payload.amountMinor) && payload.amountMinor >= 0,
    "Nieprawidłowa kwota wydatku",
    "INVALID_AMOUNT",
  );
  assertShape(isNonEmptyText(payload.title, 500), "Nieprawidłowy tytuł wydatku", "INVALID_TITLE");
  if (payload.notes !== undefined && payload.notes !== null) {
    assertShape(isOptionalText(payload.notes, 5000), "Nieprawidłowe notatki", "INVALID_NOTES");
  }
  if (payload.visibility !== undefined) {
    assertShape(VISIBILITIES.has(payload.visibility), "Nieprawidłowa widoczność", "INVALID_VISIBILITY");
  }
  return {
    id: payload.id,
    petId: payload.petId,
    date: payload.date,
    type: payload.type,
    amountMinor: payload.amountMinor,
    title: payload.title.trim(),
    notes: normalizeOptionalText(payload.notes),
    visibility: payload.visibility,
  };
}

export function validatePetVisitCreatePayload(payload) {
  assertShape(isPlainObject(payload), "Nieprawidłowy ładunek mutacji", "INVALID_PAYLOAD");
  assertShape(isId(payload.id), "Nieprawidłowy identyfikator wizyty", "INVALID_ID");
  assertShape(isId(payload.petId), "Nieprawidłowy identyfikator zwierzęcia", "INVALID_PET_ID");
  assertShape(isNonEmptyText(payload.title, 500), "Nieprawidłowy tytuł wizyty", "INVALID_TITLE");
  assertShape(isNonEmptyText(payload.clinician, 500), "Nieprawidłowy weterynarz/placówka", "INVALID_CLINICIAN");
  if (payload.specialty !== undefined && payload.specialty !== null) {
    assertShape(isOptionalText(payload.specialty, 500), "Nieprawidłowa specjalizacja", "INVALID_SPECIALTY");
  }
  assertShape(isIsoDate(payload.date), "Nieprawidłowa data wizyty", "INVALID_DATE");
  assertShape(isClockTime(payload.time), "Nieprawidłowa godzina wizyty", "INVALID_TIME");
  if (payload.location !== undefined && payload.location !== null) {
    assertShape(isOptionalText(payload.location, 1000), "Nieprawidłowa lokalizacja", "INVALID_LOCATION");
  }
  assertShape(VISIT_STATUSES.has(payload.status), "Nieprawidłowy status wizyty", "INVALID_STATUS");
  if (payload.notes !== undefined && payload.notes !== null) {
    assertShape(isOptionalText(payload.notes, 5000), "Nieprawidłowe notatki", "INVALID_NOTES");
  }
  if (payload.visibility !== undefined) {
    assertShape(VISIBILITIES.has(payload.visibility), "Nieprawidłowa widoczność", "INVALID_VISIBILITY");
  }
  return {
    id: payload.id,
    petId: payload.petId,
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

// `visibility` IS in the update key set (parity with PET_UPDATE_KEYS, same "Ryzyka" note --
// PetsPage lets the user change a visit's visibility after creation). `togglePetVisitCompleted`
// (PetsPage.tsx) sends `changes: { status }` through this same op.
const VISIT_UPDATE_KEYS = new Set([
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

export function validatePetVisitUpdatePayload(payload, baseVersion) {
  assertShape(isPlainObject(payload), "Nieprawidłowy ładunek mutacji", "INVALID_PAYLOAD");
  assertShape(isId(payload.id), "Nieprawidłowy identyfikator wizyty", "INVALID_ID");
  assertShape(isPlainObject(payload.changes), "Brak zmian do zastosowania", "INVALID_CHANGES");
  for (const key of Object.keys(payload.changes)) {
    assertShape(VISIT_UPDATE_KEYS.has(key), `Pola "${key}" nie można edytować`, "INVALID_CHANGES");
  }
  const version = normalizeRequiredVersion(baseVersion);
  const changes = {};
  const c = payload.changes;
  if (c.title !== undefined) {
    assertShape(isNonEmptyText(c.title, 500), "Nieprawidłowy tytuł wizyty", "INVALID_TITLE");
    changes.title = c.title.trim();
  }
  if (c.clinician !== undefined) {
    assertShape(
      isNonEmptyText(c.clinician, 500),
      "Nieprawidłowy weterynarz/placówka",
      "INVALID_CLINICIAN",
    );
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
    assertShape(VISIT_STATUSES.has(c.status), "Nieprawidłowy status wizyty", "INVALID_STATUS");
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

// ---------------------------------------------------------------------------
// Mutation envelope + supported ops
// ---------------------------------------------------------------------------

export const SUPPORTED_PETS_OPS = new Set([
  "pet.create",
  "pet.update",
  "pet.delete",
  "expense.create",
  "expense.delete",
  "visit.create",
  "visit.update",
  "visit.delete",
]);

// Whole-request-shape validation, mirroring assertCarMutationShape/assertFinanceMutationShape:
// called once per mutation BEFORE any DB work starts, so a malformed entry anywhere in the batch is
// rejected as a single 400 rather than silently corrupting bookkeeping for its siblings.
// Per-mutation *business* validation (bad field values, missing pet, ...) is reported as
// `status: "error"` inside `results` by applyPetsMutation instead.
export function assertPetsMutationShape(mutation) {
  if (!isPlainObject(mutation)) {
    throw petRequestError(400, "Nieprawidłowy kształt mutacji", "INVALID_PETS_MUTATION");
  }
  if (typeof mutation.idempotencyKey !== "string" || !UUID_PATTERN.test(mutation.idempotencyKey)) {
    throw petRequestError(400, "Nieprawidłowy klucz idempotencji", "INVALID_IDEMPOTENCY_KEY");
  }
  if (typeof mutation.op !== "string" || !SUPPORTED_PETS_OPS.has(mutation.op)) {
    throw petRequestError(400, "Nieobsługiwana operacja mutacji", "UNSUPPORTED_OP");
  }
  if (!isPlainObject(mutation.payload)) {
    throw petRequestError(400, "Brak danych mutacji", "INVALID_PETS_MUTATION");
  }
  if (
    mutation.baseVersion !== undefined &&
    mutation.baseVersion !== null &&
    !Number.isInteger(mutation.baseVersion)
  ) {
    throw petRequestError(400, "Nieprawidłowa wersja bazowa mutacji", "INVALID_PETS_MUTATION");
  }
}

export const MAX_PETS_MUTATIONS_PER_BATCH = Number(process.env.MAX_PETS_MUTATIONS ?? 500);
export const MAX_PETS_MUTATIONS_BYTES = Number(process.env.MAX_PETS_MUTATIONS_BYTES ?? 2_000_000);

// ---------------------------------------------------------------------------
// Snapshot read (GET /api/v1/pets): household-wide records + the caller's own private records, for
// all three tables (wzór readCarSnapshot). Unlike vehicle_deadlines, BOTH pet_expenses and pet_visits
// have their own visibility -- no EXISTS-on-parent scoping anywhere here.
// ---------------------------------------------------------------------------

export async function readPetsSnapshot(client, householdId, userId) {
  // Sequential, not Promise.all: `client` may be a single-connection PoolClient (e.g. when called
  // inside a transaction()), and node-postgres only supports one in-flight query per connection.
  const pets = await client.query(
    `SELECT ${PET_SELECT_COLUMNS} FROM pets
      WHERE household_id = $1 AND (visibility = 'household' OR owner_id = $2)
      ORDER BY created_at`,
    [householdId, userId],
  );
  const petExpenses = await client.query(
    `SELECT ${PET_EXPENSE_SELECT_COLUMNS} FROM pet_expenses
      WHERE household_id = $1 AND (visibility = 'household' OR owner_id = $2)
      ORDER BY date DESC, created_at DESC`,
    [householdId, userId],
  );
  const petVisits = await client.query(
    `SELECT ${PET_VISIT_SELECT_COLUMNS} FROM pet_visits
      WHERE household_id = $1 AND (visibility = 'household' OR owner_id = $2)
      ORDER BY date, time`,
    [householdId, userId],
  );
  return {
    pets: pets.rows.map(petRowToDto),
    petExpenses: petExpenses.rows.map(petExpenseRowToDto),
    petVisits: petVisits.rows.map(petVisitRowToDto),
  };
}

// Wspiera "Wyczyść dane aplikacji" (SettingsPage.tsx danger zone). Wzór resetCarForUser: usuwa
// wszystko wspólne (`visibility = 'household'`) plus WYŁĄCZNIE prywatne rekordy wywołującego
// użytkownika (`owner_id = userId`) w danym gospodarstwie -- NIE cały reset gospodarstwa jak w
// trips/meals, bo Zwierzęta mają rekordy prywatne. Kolejność: pet_expenses, potem pet_visits
// (dzieci), potem pets (rodzic) -- kaskada FK (`ON DELETE CASCADE`) usuwa pet_expenses/pet_visits
// dotkniętych profili automatycznie, ale usuwamy je jawnie najpierw dla symetrii z car.mjs i żeby
// nie polegać wyłącznie na kaskadzie dla rekordów, których profil akurat NIE jest usuwany w tym
// wywołaniu (np. wydatek/wizyta prywatna wywołującego przy wspólnym profilu-rodzicu).
export async function resetPetsForUser(client, householdId, userId) {
  await client.query(
    `DELETE FROM pet_expenses
      WHERE household_id = $1 AND (visibility = 'household' OR owner_id = $2)`,
    [householdId, userId],
  );
  await client.query(
    `DELETE FROM pet_visits
      WHERE household_id = $1 AND (visibility = 'household' OR owner_id = $2)`,
    [householdId, userId],
  );
  await client.query(
    `DELETE FROM pets
      WHERE household_id = $1 AND (visibility = 'household' OR owner_id = $2)`,
    [householdId, userId],
  );
}

// ---------------------------------------------------------------------------
// Shared OCC/conflict resolution helpers used by every update/delete op (mirrors car.mjs/finance.mjs).
// The lookup query MUST carry the same household/visibility scoping as the write it's diagnosing --
// otherwise this could leak the existence or content of another user's private record through the
// "current record" in a conflict response (docs/plans/zwierzeta-sql.md "Bezpieczeństwo scope'u
// widoczności").
// ---------------------------------------------------------------------------

async function resolveConflictOrError(client, query, params, mapper, notFoundMessage, notFoundCode) {
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
// Per-op SQL execution. Each function assumes payload/baseVersion have already been shape-checked by
// assertPetsMutationShape; they still run their own (business-rule) validators and throw
// PetValidationError on bad input, which applyPetsMutation turns into `status: "error"`.
// ---------------------------------------------------------------------------

async function execPetCreate(client, ctx, payload) {
  const data = validatePetCreatePayload(payload);
  const ownerId = resolveOwnerId(ctx);
  // Normalization of variant fields by `kind` (docs/plans/zwierzeta-sql.md "Ryzyka": pułapka
  // serializacji `undefined`) -- authoritative on the server regardless of what the client sent:
  // aquarium never carries species/birthDate, non-aquarium never carries fishStock.
  const isAquarium = data.kind === "aquarium";
  const species = isAquarium ? null : data.species;
  const birthDate = isAquarium ? null : data.birthDate;
  const fishStock = isAquarium ? data.fishStock : null;
  try {
    const inserted = await client.query(
      `INSERT INTO pets
         (id, household_id, owner_id, visibility, name, kind, color, species, birth_date,
          fish_stock, notes, version, updated_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::date, $10::jsonb, $11, 1, $3)
       RETURNING ${PET_SELECT_COLUMNS}`,
      [
        data.id,
        ctx.householdId,
        ownerId,
        data.visibility,
        data.name,
        data.kind,
        data.color,
        species,
        birthDate,
        fishStock === null ? null : JSON.stringify(fishStock),
        data.notes,
      ],
    );
    return { status: "applied", record: petRowToDto(inserted.rows[0]) };
  } catch (error) {
    if (error.code === "23505") {
      return resolveConflictOrError(
        client,
        `SELECT ${PET_SELECT_COLUMNS} FROM pets
          WHERE id = $1 AND household_id = $2 AND (visibility = 'household' OR owner_id = $3)`,
        [data.id, ctx.householdId, ownerId],
        petRowToDto,
        "Identyfikator jest już używany",
        "ID_TAKEN",
      );
    }
    throw error;
  }
}

// Cascades a visibility change onto the pet's children in the SAME transaction (docs/plans/
// zwierzeta-sql.md "Ops mutacji" / "Ryzyka": faithful reproduction of today's splitWorkspaceData --
// a profile turned private must not leave previously-shared expenses/visits visible to the rest of
// the household). Only touches rows whose visibility actually differs from the new value, so it
// doesn't needlessly bump the version of children that already match.
async function cascadePetVisibility(client, householdId, petId, petOwnerId, newVisibility, actorId) {
  await client.query(
    `UPDATE pet_expenses
        SET visibility = $1, owner_id = $2, version = version + 1, updated_at = now(), updated_by = $3
      WHERE pet_id = $4 AND household_id = $5 AND visibility <> $1`,
    [newVisibility, petOwnerId, actorId, petId, householdId],
  );
  await client.query(
    `UPDATE pet_visits
        SET visibility = $1, owner_id = $2, version = version + 1, updated_at = now(), updated_by = $3
      WHERE pet_id = $4 AND household_id = $5 AND visibility <> $1`,
    [newVisibility, petOwnerId, actorId, petId, householdId],
  );
}

async function execPetUpdate(client, ctx, payload, baseVersion) {
  const { id, changes, baseVersion: version } = validatePetUpdatePayload(payload, baseVersion);
  const ownerId = resolveOwnerId(ctx);
  const hasSpecies = Object.prototype.hasOwnProperty.call(changes, "species");
  const hasBirthDate = Object.prototype.hasOwnProperty.call(changes, "birthDate");
  const hasFishStock = Object.prototype.hasOwnProperty.call(changes, "fishStock");
  const hasNotes = Object.prototype.hasOwnProperty.call(changes, "notes");
  const updated = await client.query(
    `UPDATE pets
        SET name = COALESCE($1, name),
            kind = COALESCE($2, kind),
            color = COALESCE($3, color),
            species = CASE
              WHEN COALESCE($2, kind) = 'aquarium' THEN NULL
              WHEN $4 THEN $5
              ELSE species
            END,
            birth_date = CASE
              WHEN COALESCE($2, kind) = 'aquarium' THEN NULL
              WHEN $6 THEN $7::date
              ELSE birth_date
            END,
            fish_stock = CASE
              WHEN COALESCE($2, kind) <> 'aquarium' THEN NULL
              WHEN $8 THEN $9::jsonb
              ELSE fish_stock
            END,
            notes = CASE WHEN $10 THEN $11 ELSE notes END,
            visibility = COALESCE($12, visibility),
            version = version + 1,
            updated_at = now(),
            updated_by = $13
      WHERE id = $14 AND household_id = $15 AND version = $16
        AND (visibility = 'household' OR owner_id = $13)
      RETURNING ${PET_SELECT_COLUMNS}`,
    [
      changes.name ?? null,
      changes.kind ?? null,
      changes.color ?? null,
      hasSpecies,
      hasSpecies ? changes.species : null,
      hasBirthDate,
      hasBirthDate ? changes.birthDate : null,
      hasFishStock,
      hasFishStock ? JSON.stringify(changes.fishStock ?? []) : null,
      hasNotes,
      hasNotes ? changes.notes : null,
      changes.visibility ?? null,
      ownerId,
      id,
      ctx.householdId,
      version,
    ],
  );
  if (!updated.rowCount) {
    return resolveConflictOrError(
      client,
      `SELECT ${PET_SELECT_COLUMNS} FROM pets
        WHERE id = $1 AND household_id = $2 AND (visibility = 'household' OR owner_id = $3)`,
      [id, ctx.householdId, ownerId],
      petRowToDto,
      "Rekord nie istnieje lub jest niedostępny",
      "NOT_FOUND",
    );
  }
  const record = petRowToDto(updated.rows[0]);
  if (changes.visibility !== undefined) {
    await cascadePetVisibility(client, ctx.householdId, id, record.ownerId, record.visibility, ownerId);
  }
  return { status: "applied", record };
}

// `pet.delete` -- dziś `deletePet` (PetsPage.tsx) usuwa profil oraz jego wydatki/wizyty. Kaskada FK
// (`ON DELETE CASCADE`) usuwa pet_expenses/pet_visits automatycznie. `baseVersion` optional (parity
// with vehicle.delete).
async function execPetDelete(client, ctx, payload, baseVersion) {
  const { id } = validateDeleteIdPayload(payload);
  const ownerId = resolveOwnerId(ctx);
  const version = normalizeOptionalVersion(baseVersion);
  const deleted = await client.query(
    `DELETE FROM pets
      WHERE id = $1 AND household_id = $2 AND (visibility = 'household' OR owner_id = $3)
        AND ($4::integer IS NULL OR version = $4)
      RETURNING id`,
    [id, ctx.householdId, ownerId, version],
  );
  if (deleted.rowCount) return { status: "applied", record: null };
  return resolveConflictOrGone(
    client,
    `SELECT ${PET_SELECT_COLUMNS} FROM pets
      WHERE id = $1 AND household_id = $2 AND (visibility = 'household' OR owner_id = $3)`,
    [id, ctx.householdId, ownerId],
    petRowToDto,
  );
}

async function execPetExpenseCreate(client, ctx, payload) {
  const data = validatePetExpenseCreatePayload(payload);
  const ownerId = resolveOwnerId(ctx);
  const petResult = await client.query(
    `SELECT visibility FROM pets
      WHERE id = $1 AND household_id = $2 AND (visibility = 'household' OR owner_id = $3)`,
    [data.petId, ctx.householdId, ownerId],
  );
  if (!petResult.rowCount) {
    return { status: "error", error: "Zwierzę nie istnieje lub jest niedostępne", code: "PET_NOT_FOUND" };
  }
  const visibility = resolveExpenseVisibility(data.visibility, petResult.rows[0].visibility);
  try {
    const inserted = await client.query(
      `INSERT INTO pet_expenses
         (id, household_id, pet_id, owner_id, visibility, date, type, amount_minor, title, notes,
          version, updated_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 1, $4)
       RETURNING ${PET_EXPENSE_SELECT_COLUMNS}`,
      [
        data.id,
        ctx.householdId,
        data.petId,
        ownerId,
        visibility,
        data.date,
        data.type,
        data.amountMinor,
        data.title,
        data.notes,
      ],
    );
    return { status: "applied", record: petExpenseRowToDto(inserted.rows[0]) };
  } catch (error) {
    if (error.code === "23505") {
      return resolveConflictOrError(
        client,
        `SELECT ${PET_EXPENSE_SELECT_COLUMNS} FROM pet_expenses
          WHERE id = $1 AND household_id = $2 AND (visibility = 'household' OR owner_id = $3)`,
        [data.id, ctx.householdId, ownerId],
        petExpenseRowToDto,
        "Identyfikator jest już używany",
        "ID_TAKEN",
      );
    }
    throw error;
  }
}

// No `expense.update` (YAGNI, docs/plans/zwierzeta-sql.md "Non-goals": today's UI only adds/removes
// expenses). `baseVersion` is optional (UI never edits/reads a version for expenses today -- parity
// with car.mjs's execCarExpenseDelete).
async function execPetExpenseDelete(client, ctx, payload, baseVersion) {
  const { id } = validateDeleteIdPayload(payload);
  const ownerId = resolveOwnerId(ctx);
  const version = normalizeOptionalVersion(baseVersion);
  const deleted = await client.query(
    `DELETE FROM pet_expenses
      WHERE id = $1 AND household_id = $2 AND (visibility = 'household' OR owner_id = $3)
        AND ($4::integer IS NULL OR version = $4)
      RETURNING id`,
    [id, ctx.householdId, ownerId, version],
  );
  if (deleted.rowCount) return { status: "applied", record: null };
  return resolveConflictOrGone(
    client,
    `SELECT ${PET_EXPENSE_SELECT_COLUMNS} FROM pet_expenses
      WHERE id = $1 AND household_id = $2 AND (visibility = 'household' OR owner_id = $3)`,
    [id, ctx.householdId, ownerId],
    petExpenseRowToDto,
  );
}

async function execPetVisitCreate(client, ctx, payload) {
  const data = validatePetVisitCreatePayload(payload);
  const ownerId = resolveOwnerId(ctx);
  const petResult = await client.query(
    `SELECT visibility FROM pets
      WHERE id = $1 AND household_id = $2 AND (visibility = 'household' OR owner_id = $3)`,
    [data.petId, ctx.householdId, ownerId],
  );
  if (!petResult.rowCount) {
    return { status: "error", error: "Zwierzę nie istnieje lub jest niedostępne", code: "PET_NOT_FOUND" };
  }
  const visibility = resolveVisitVisibility(data.visibility, petResult.rows[0].visibility);
  try {
    const inserted = await client.query(
      `INSERT INTO pet_visits
         (id, household_id, pet_id, owner_id, visibility, title, clinician, specialty, date, time,
          location, status, notes, version, updated_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, 1, $4)
       RETURNING ${PET_VISIT_SELECT_COLUMNS}`,
      [
        data.id,
        ctx.householdId,
        data.petId,
        ownerId,
        visibility,
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
    return { status: "applied", record: petVisitRowToDto(inserted.rows[0]) };
  } catch (error) {
    if (error.code === "23505") {
      return resolveConflictOrError(
        client,
        `SELECT ${PET_VISIT_SELECT_COLUMNS} FROM pet_visits
          WHERE id = $1 AND household_id = $2 AND (visibility = 'household' OR owner_id = $3)`,
        [data.id, ctx.householdId, ownerId],
        petVisitRowToDto,
        "Identyfikator jest już używany",
        "ID_TAKEN",
      );
    }
    throw error;
  }
}

// Covers both `updatePetVisit` and `togglePetVisitCompleted` (PetsPage.tsx) -- the latter simply
// sends `changes: { status }` with a client-computed toggle value.
async function execPetVisitUpdate(client, ctx, payload, baseVersion) {
  const { id, changes, baseVersion: version } = validatePetVisitUpdatePayload(payload, baseVersion);
  const ownerId = resolveOwnerId(ctx);
  const hasSpecialty = Object.prototype.hasOwnProperty.call(changes, "specialty");
  const hasLocation = Object.prototype.hasOwnProperty.call(changes, "location");
  const hasNotes = Object.prototype.hasOwnProperty.call(changes, "notes");
  const updated = await client.query(
    `UPDATE pet_visits
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
      RETURNING ${PET_VISIT_SELECT_COLUMNS}`,
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
  if (updated.rowCount) return { status: "applied", record: petVisitRowToDto(updated.rows[0]) };
  return resolveConflictOrError(
    client,
    `SELECT ${PET_VISIT_SELECT_COLUMNS} FROM pet_visits
      WHERE id = $1 AND household_id = $2 AND (visibility = 'household' OR owner_id = $3)`,
    [id, ctx.householdId, ownerId],
    petVisitRowToDto,
    "Rekord nie istnieje lub jest niedostępny",
    "NOT_FOUND",
  );
}

async function execPetVisitDelete(client, ctx, payload, baseVersion) {
  const { id } = validateDeleteIdPayload(payload);
  const ownerId = resolveOwnerId(ctx);
  const version = normalizeOptionalVersion(baseVersion);
  const deleted = await client.query(
    `DELETE FROM pet_visits
      WHERE id = $1 AND household_id = $2 AND (visibility = 'household' OR owner_id = $3)
        AND ($4::integer IS NULL OR version = $4)
      RETURNING id`,
    [id, ctx.householdId, ownerId, version],
  );
  if (deleted.rowCount) return { status: "applied", record: null };
  return resolveConflictOrGone(
    client,
    `SELECT ${PET_VISIT_SELECT_COLUMNS} FROM pet_visits
      WHERE id = $1 AND household_id = $2 AND (visibility = 'household' OR owner_id = $3)`,
    [id, ctx.householdId, ownerId],
    petVisitRowToDto,
  );
}

async function executePetsOp(client, ctx, op, payload, baseVersion) {
  switch (op) {
    case "pet.create":
      return execPetCreate(client, ctx, payload);
    case "pet.update":
      return execPetUpdate(client, ctx, payload, baseVersion);
    case "pet.delete":
      return execPetDelete(client, ctx, payload, baseVersion);
    case "expense.create":
      return execPetExpenseCreate(client, ctx, payload);
    case "expense.delete":
      return execPetExpenseDelete(client, ctx, payload, baseVersion);
    case "visit.create":
      return execPetVisitCreate(client, ctx, payload);
    case "visit.update":
      return execPetVisitUpdate(client, ctx, payload, baseVersion);
    case "visit.delete":
      return execPetVisitDelete(client, ctx, payload, baseVersion);
    default:
      // Unreachable when called through applyPetsMutation (assertPetsMutationShape already rejected
      // unknown ops at the request level); kept defensive in case of direct unit-test calls.
      throw new PetValidationError(`Nieobsługiwana operacja: ${op}`, "UNSUPPORTED_OP");
  }
}

// ---------------------------------------------------------------------------
// Idempotent mutation entry point. `mutation` is assumed to already have passed
// assertPetsMutationShape (server.mjs validates the whole batch upfront). ctx = { householdId, userId }
// always comes from the authenticated session, never from the request body.
// ---------------------------------------------------------------------------

export async function applyPetsMutation(client, ctx, mutation) {
  const { idempotencyKey, op, payload, baseVersion } = mutation;

  // Claim the idempotency key first, inside the same DB transaction as the operation itself: if the
  // op below throws, the whole transaction (including this claim) rolls back, so the key remains
  // free to retry. If a row already existed, this was a retry -- return the previously stored result
  // instead of running the operation again.
  const claim = await client.query(
    `INSERT INTO pet_mutations (idempotency_key, household_id, user_id, op, result)
     VALUES ($1, $2, $3, $4, '{}'::jsonb)
     ON CONFLICT (idempotency_key) DO NOTHING`,
    [idempotencyKey, ctx.householdId, ctx.userId, op],
  );
  if (!claim.rowCount) {
    const existing = await client.query(
      `SELECT result FROM pet_mutations WHERE idempotency_key = $1`,
      [idempotencyKey],
    );
    return existing.rows[0]?.result ?? { idempotencyKey, status: "duplicate" };
  }

  let outcome;
  try {
    outcome = await executePetsOp(client, ctx, op, payload, baseVersion);
  } catch (error) {
    if (error instanceof PetValidationError) {
      outcome = { status: "error", error: error.message, code: error.code };
    } else {
      throw error;
    }
  }

  const result = { idempotencyKey, ...outcome };
  await client.query(`UPDATE pet_mutations SET result = $1::jsonb WHERE idempotency_key = $2`, [
    JSON.stringify(result),
    idempotencyKey,
  ]);
  return result;
}
