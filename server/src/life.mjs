// Domain layer for the normalized Life module (Zadania/Kalendarz/Przypomnienia/Notatki/Nawyki).
//
// Data model: server/migrations/013_life_normalized.sql (tasks, events, reminders, notes, habits,
// life_mutations). Design source of truth: docs/plans/zadania-kalendarz-notatki-nawyki-sql.md
// ("Podejście"/"Ops mutacji"/"Projekt pól specjalnych" sections).
//
// This is the Life analogue of server/src/health.mjs -- structurally the closest precedent in the
// series (docs/plans/zadania-kalendarz-notatki-nawyki-sql.md "Czym Life RÓŻNI SIĘ"): FIVE
// completely independent, flat tables. No FK between them (only to households/users), no
// visibility cascade, no visibility inheritance on create (every `*.create` carries an EXPLICIT
// `visibility`), no aggregate/monotonic field (every update uses per-record OCC, no exceptions).
//
// Three complications with no precedent earlier in the series:
//   1. `recurrence` (jsonb, nullable) + `series_id`/`series_index` (plain columns) on tasks/events.
//      Window materialization stays client-side (src/lib/recurrence.ts) -- this module writes
//      these fields 1:1 without interpreting them. Occurrence rows use a DETERMINISTIC id
//      (`${seriesId}#${seriesIndex}`) -- a collision on `*.create` is EXPECTED (two devices
//      computing the same id for the same logical occurrence) and is handled the same way as any
//      other PK conflict: resolveConflictOrError returns `{status:"conflict", record,
//      currentVersion}` with code `ID_TAKEN` (the frontend then adopts the server's record as if
//      it were `applied` -- that reconciliation lives in useLifeRecordsStore, not here).
//   2. `habits.completed_dates` (jsonb array of iso-dates) is overwritten as an ABSOLUTE SET on
//      every `habit.update` (the client recomputes the whole array locally and sends it), not a
//      real per-date flip -- same shape as `fish_stock` in pets.mjs, but always present (`NOT
//      NULL DEFAULT '[]'`) rather than nullable.
//   3. `reminders.notified_at` is the only column in this series written by BOTH the worker
//      (writeback after a successful push, WITHOUT bumping `version` -- see worker.mjs) AND the
//      client (`snoozeReminder` clears it, `markReminderNotified` sets it, both via
//      `reminder.update`). This module treats it as an ordinary nullable timestamptz column from
//      the mutation side; the worker's own writeback query lives in worker.mjs, not here.
//
// Like health.mjs/pets.mjs/car.mjs/finance.mjs, this module intentionally does NOT import the zod
// schemas from src/lib/schema.ts: the server package has no TypeScript build step and no zod
// dependency. The validators below hand-roll the same rules as `taskSchema`/`eventSchema`/
// `reminderSchema`/`noteSchema`/`habitSchema` (+ `recurrenceSchema`) in src/lib/schema.ts, scoped
// to the subset of fields a mutation payload carries.
//
// Every exported function here is either pure (validators, resolveOwnerId,
// resolveVersionConflict, row->DTO mappers) or takes an already-connected `client` (a pg
// PoolClient, or the shared `pool` from db.mjs) so it can run either inside a transaction() or
// directly against the pool.

export class LifeValidationError extends Error {
  constructor(message, code = "VALIDATION_ERROR") {
    super(message);
    this.name = "LifeValidationError";
    this.code = code;
  }
}

function lifeRequestError(statusCode, message, code) {
  const error = new Error(message);
  error.statusCode = statusCode;
  error.code = code;
  return error;
}

// ---------------------------------------------------------------------------
// Primitive validators (mirror src/lib/schema.ts / src/types.ts)
// ---------------------------------------------------------------------------

const ID_MAX_LENGTH = 200;
const VISIBILITIES = new Set(["private", "household"]);
const TASK_STATUSES = new Set(["todo", "done"]);
const PRIORITIES = new Set(["low", "medium", "high"]);
const ENERGIES = new Set(["low", "medium", "high"]);
const EVENT_KINDS = new Set(["meeting", "focus", "personal"]);
const EVENT_SOURCES = new Set(["manual", "google"]);
const NOTE_COLORS = new Set(["cream", "mint", "sky", "lilac"]);
const HABIT_ICONS = new Set(["water", "walk", "read", "stretch", "meditate"]);
const RECURRENCE_FREQS = new Set(["daily", "weekly", "monthly"]);
const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const TIME_PATTERN = /^\d{2}:\d{2}$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Wzór `timestamp` z src/lib/schema.ts -- cap na długość, żeby nie przepuścić absurdalnie
// długich stringów przez `Date.parse` do kolumny `text`/`timestamptz`.
const TIMESTAMP_MAX_LENGTH = 200;
const NOTE_CONTENT_MAX_LENGTH = 100_000;
const MAX_COMPLETED_DATES = 5000;

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

// Free-form Date.parse-able timestamp string (NOT an iso date) -- used for
// `task.completedAt`/`reminder.notifiedAt` (timestamptz columns, cast explicitly in SQL) and
// `event.externalUpdatedAt` (text column, no cast -- Google Calendar free-form timestamp, wzór
// `measuredAt` w health.mjs).
function isParsableTimestamp(value) {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= TIMESTAMP_MAX_LENGTH &&
    !Number.isNaN(Date.parse(value))
  );
}

function isPositiveInteger(value) {
  return Number.isInteger(value) && value > 0;
}

export function isSeriesIndex(value) {
  return Number.isInteger(value) && value >= 0;
}

// Absolute-set validator for `habit.completedDates` (docs/plans/…"Projekt pól specjalnych": toggle
// sends the WHOLE recomputed array, not a single date) -- array of iso-dates, capped so a runaway
// client can't push an unbounded jsonb blob.
export function validateCompletedDates(value) {
  return (
    Array.isArray(value) &&
    value.length <= MAX_COMPLETED_DATES &&
    value.every((item) => isIsoDate(item))
  );
}

// `note.content` allows empty string (noteSchema: z.string().max(100_000), no .min(1)) -- NOT
// nonEmptyText.
export function isNoteContent(value) {
  return typeof value === "string" && value.length <= NOTE_CONTENT_MAX_LENGTH;
}

// Mirrors `recurrenceSchema` (src/lib/schema.ts): `freq`, `interval` (int >= 1), `weekdays?`
// (int 1-7, min 1 entry, only meaningful for weekly but not enforced here -- the server is
// passive/pass-through, per plan "Backend jest pasywny wobec logiki serii"), `count?` (int >= 1),
// `anchorDate` (isoDate), `anchorTime?` (clockTime). Returns a normalized plain object (only
// allow-listed keys) written 1:1 to the `recurrence` jsonb column via JSON.stringify.
export function validateRecurrence(value) {
  assertShape(isPlainObject(value), "Nieprawidłowa reguła powtarzalności", "INVALID_RECURRENCE");
  assertShape(
    RECURRENCE_FREQS.has(value.freq),
    "Nieprawidłowa częstotliwość powtarzalności",
    "INVALID_RECURRENCE",
  );
  assertShape(
    Number.isInteger(value.interval) && value.interval >= 1,
    "Nieprawidłowy odstęp powtarzalności",
    "INVALID_RECURRENCE",
  );
  const result = { freq: value.freq, interval: value.interval };
  if (value.weekdays !== undefined) {
    assertShape(
      Array.isArray(value.weekdays) &&
        value.weekdays.length >= 1 &&
        value.weekdays.every((day) => Number.isInteger(day) && day >= 1 && day <= 7),
      "Nieprawidłowe dni tygodnia powtarzalności",
      "INVALID_RECURRENCE",
    );
    result.weekdays = value.weekdays;
  }
  if (value.count !== undefined) {
    assertShape(
      Number.isInteger(value.count) && value.count >= 1,
      "Nieprawidłowy limit wystąpień serii",
      "INVALID_RECURRENCE",
    );
    result.count = value.count;
  }
  assertShape(
    isIsoDate(value.anchorDate),
    "Nieprawidłowa data kotwicy serii",
    "INVALID_RECURRENCE",
  );
  result.anchorDate = value.anchorDate;
  if (value.anchorTime !== undefined) {
    assertShape(
      isClockTime(value.anchorTime),
      "Nieprawidłowa godzina kotwicy serii",
      "INVALID_RECURRENCE",
    );
    result.anchorTime = value.anchorTime;
  }
  return result;
}

// Normalizes an optional/nullable text field to either a trimmed non-empty string or null (the
// column is nullable, matching how the migration writes `NULLIF(rec->>'…', '')`).
function normalizeOptionalText(value) {
  if (value === undefined || value === null) return null;
  const trimmed = String(value).trim();
  return trimmed.length ? trimmed : null;
}

function assertShape(condition, message, code) {
  if (!condition) throw new LifeValidationError(message, code);
}

// `task.create`/`event.create` require `seriesId`/`seriesIndex`/`recurrence` to appear ALL
// TOGETHER (a series occurrence) or NOT AT ALL (a one-off record) -- docs/plans/…"Ops mutacji":
// "walidator odrzuca połowiczny zestaw". Not enforced on `*.update` -- individual series fields
// stay independently editable there (UPDATE_KEYS), written 1:1 without interpretation.
function validateSeriesFields(payload) {
  const hasSeriesId = payload.seriesId !== undefined && payload.seriesId !== null;
  const hasSeriesIndex = payload.seriesIndex !== undefined && payload.seriesIndex !== null;
  const hasRecurrence = payload.recurrence !== undefined && payload.recurrence !== null;
  const presentCount = [hasSeriesId, hasSeriesIndex, hasRecurrence].filter(Boolean).length;
  assertShape(
    presentCount === 0 || presentCount === 3,
    "Pola wystąpienia serii (seriesId/seriesIndex/recurrence) muszą wystąpić razem albo wcale",
    "INVALID_SERIES_FIELDS",
  );
  if (presentCount === 0) return { seriesId: null, seriesIndex: null, recurrence: null };
  assertShape(isId(payload.seriesId), "Nieprawidłowy identyfikator serii", "INVALID_SERIES_ID");
  assertShape(
    isSeriesIndex(payload.seriesIndex),
    "Nieprawidłowy indeks wystąpienia serii",
    "INVALID_SERIES_INDEX",
  );
  return {
    seriesId: payload.seriesId,
    seriesIndex: payload.seriesIndex,
    recurrence: validateRecurrence(payload.recurrence),
  };
}

// ---------------------------------------------------------------------------
// Security invariants (docs/ARCHITECTURE.md "Dane wspólne i prywatne")
// ---------------------------------------------------------------------------

// owner_id is always derived from the authenticated session -- a client-supplied ownerId in the
// mutation payload (if present) is always ignored. Single choke point (parity with
// health.mjs/pets.mjs/car.mjs/finance.mjs's resolveOwnerId).
export function resolveOwnerId(ctx) {
  return ctx.userId;
}

// Pure helper naming the core OCC decision explicitly, unit-testable in isolation (mirrors
// health.mjs/pets.mjs/car.mjs/finance.mjs). The authoritative check always happens in SQL
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
// Row -> DTO mapping (snake_case columns -> the Task/CalendarEvent/Reminder/Note/Habit shapes in
// src/types.ts). `date` columns are cast to text in SQL (`::text`) to dodge node-postgres's
// local-timezone Date parsing; `timestamptz` columns (`updated_at`/`created_at`/`completed_at`/
// `notified_at`) are safe to read as JS Date and converted with `.toISOString()`.
// `recurrence`/`completed_dates` (jsonb) come back already parsed by node-postgres. `time`/
// `start_time`/`end_time`/`external_updated_at` are `text` -- read verbatim, no cast needed.
// ---------------------------------------------------------------------------

export function taskRowToDto(row) {
  return {
    id: row.id,
    ownerId: row.owner_id,
    visibility: row.visibility,
    title: row.title,
    description: row.description ?? undefined,
    status: row.status,
    priority: row.priority,
    date: row.date ?? undefined,
    time: row.time ?? undefined,
    estimatedMinutes: row.estimated_minutes ?? undefined,
    category: row.category,
    isFocus: row.is_focus,
    energy: row.energy,
    completedAt: row.completed_at ? row.completed_at.toISOString() : undefined,
    seriesId: row.series_id ?? undefined,
    seriesIndex: row.series_index ?? undefined,
    recurrence: row.recurrence ?? undefined,
    version: row.version,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

export function eventRowToDto(row) {
  return {
    id: row.id,
    ownerId: row.owner_id,
    visibility: row.visibility,
    title: row.title,
    date: row.date,
    startTime: row.start_time,
    endTime: row.end_time,
    kind: row.kind,
    location: row.location ?? undefined,
    notes: row.notes ?? undefined,
    source: row.source ?? undefined,
    externalId: row.external_id ?? undefined,
    externalUpdatedAt: row.external_updated_at ?? undefined,
    seriesId: row.series_id ?? undefined,
    seriesIndex: row.series_index ?? undefined,
    recurrence: row.recurrence ?? undefined,
    version: row.version,
    updatedAt: row.updated_at.toISOString(),
  };
}

export function reminderRowToDto(row) {
  return {
    id: row.id,
    ownerId: row.owner_id,
    visibility: row.visibility,
    title: row.title,
    date: row.date,
    time: row.time,
    done: row.done,
    notifiedAt: row.notified_at ? row.notified_at.toISOString() : undefined,
    version: row.version,
    updatedAt: row.updated_at.toISOString(),
  };
}

export function noteRowToDto(row) {
  return {
    id: row.id,
    ownerId: row.owner_id,
    visibility: row.visibility,
    title: row.title,
    content: row.content,
    color: row.color,
    pinned: row.pinned,
    version: row.version,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

export function habitRowToDto(row) {
  return {
    id: row.id,
    ownerId: row.owner_id,
    visibility: row.visibility,
    name: row.name,
    icon: row.icon,
    targetLabel: row.target_label,
    completedDates: Array.isArray(row.completed_dates) ? row.completed_dates : [],
    version: row.version,
    updatedAt: row.updated_at.toISOString(),
  };
}

const TASK_SELECT_COLUMNS =
  "id, owner_id, visibility, title, description, status, priority, date::text AS date, time, " +
  "estimated_minutes, category, is_focus, energy, completed_at, series_id, series_index, " +
  "recurrence, version, created_at, updated_at";
const EVENT_SELECT_COLUMNS =
  "id, owner_id, visibility, title, date::text AS date, start_time, end_time, kind, location, " +
  "notes, source, external_id, external_updated_at, series_id, series_index, recurrence, " +
  "version, updated_at";
const REMINDER_SELECT_COLUMNS =
  "id, owner_id, visibility, title, date::text AS date, time, done, notified_at, version, updated_at";
const NOTE_SELECT_COLUMNS =
  "id, owner_id, visibility, title, content, color, pinned, version, created_at, updated_at";
const HABIT_SELECT_COLUMNS =
  "id, owner_id, visibility, name, icon, target_label, completed_dates, version, updated_at";

// ---------------------------------------------------------------------------
// Payload validators per mutation `op`. Each returns a normalized object built only from
// allow-listed fields (never passing through unknown keys), or throws LifeValidationError.
// `ownerId`, if present in a payload, is always ignored by the caller (see resolveOwnerId) --
// these validators don't even read it.
// ---------------------------------------------------------------------------

export function validateTaskCreatePayload(payload) {
  assertShape(isPlainObject(payload), "Nieprawidłowy ładunek mutacji", "INVALID_PAYLOAD");
  assertShape(isId(payload.id), "Nieprawidłowy identyfikator zadania", "INVALID_ID");
  assertShape(isNonEmptyText(payload.title, 500), "Nieprawidłowy tytuł zadania", "INVALID_TITLE");
  if (payload.description !== undefined && payload.description !== null) {
    assertShape(
      isOptionalText(payload.description, 5000),
      "Nieprawidłowy opis zadania",
      "INVALID_DESCRIPTION",
    );
  }
  assertShape(TASK_STATUSES.has(payload.status), "Nieprawidłowy status zadania", "INVALID_STATUS");
  assertShape(
    PRIORITIES.has(payload.priority),
    "Nieprawidłowy priorytet zadania",
    "INVALID_PRIORITY",
  );
  if (payload.date !== undefined && payload.date !== null) {
    assertShape(isIsoDate(payload.date), "Nieprawidłowa data zadania", "INVALID_DATE");
  }
  if (payload.time !== undefined && payload.time !== null) {
    assertShape(isClockTime(payload.time), "Nieprawidłowa godzina zadania", "INVALID_TIME");
  }
  if (payload.estimatedMinutes !== undefined && payload.estimatedMinutes !== null) {
    assertShape(
      isPositiveInteger(payload.estimatedMinutes),
      "Nieprawidłowy szacowany czas trwania",
      "INVALID_ESTIMATED_MINUTES",
    );
  }
  assertShape(
    isNonEmptyText(payload.category, 500),
    "Nieprawidłowa kategoria zadania",
    "INVALID_CATEGORY",
  );
  assertShape(
    typeof payload.isFocus === "boolean",
    "Nieprawidłowa flaga fokusu",
    "INVALID_IS_FOCUS",
  );
  assertShape(ENERGIES.has(payload.energy), "Nieprawidłowy poziom energii", "INVALID_ENERGY");
  if (payload.completedAt !== undefined && payload.completedAt !== null) {
    assertShape(
      isParsableTimestamp(payload.completedAt),
      "Nieprawidłowy znacznik ukończenia",
      "INVALID_COMPLETED_AT",
    );
  }
  assertShape(
    VISIBILITIES.has(payload.visibility),
    "Nieprawidłowa widoczność",
    "INVALID_VISIBILITY",
  );
  const series = validateSeriesFields(payload);
  return {
    id: payload.id,
    title: payload.title.trim(),
    description: normalizeOptionalText(payload.description),
    status: payload.status,
    priority: payload.priority,
    date: payload.date ?? null,
    time: payload.time ?? null,
    estimatedMinutes: payload.estimatedMinutes ?? null,
    category: payload.category.trim(),
    isFocus: payload.isFocus,
    energy: payload.energy,
    completedAt: payload.completedAt ?? null,
    visibility: payload.visibility,
    seriesId: series.seriesId,
    seriesIndex: series.seriesIndex,
    recurrence: series.recurrence,
  };
}

// `visibility` IS in the update key set (docs/plans/…"Ryzyka": modale edycji pozwalają zmienić
// widoczność po utworzeniu -- pominięcie tego pola byłoby regresją klasy "goal visibility" z
// Finansów). `toggleTask`/`toggleFocus`/`moveTaskToTomorrow` all send `changes: {...}` through
// this same op, the client having already computed the toggled value locally.
const TASK_UPDATE_KEYS = new Set([
  "title",
  "description",
  "status",
  "priority",
  "date",
  "time",
  "estimatedMinutes",
  "category",
  "isFocus",
  "energy",
  "completedAt",
  "visibility",
  "seriesId",
  "seriesIndex",
  "recurrence",
]);

export function validateTaskUpdatePayload(payload, baseVersion) {
  assertShape(isPlainObject(payload), "Nieprawidłowy ładunek mutacji", "INVALID_PAYLOAD");
  assertShape(isId(payload.id), "Nieprawidłowy identyfikator zadania", "INVALID_ID");
  assertShape(isPlainObject(payload.changes), "Brak zmian do zastosowania", "INVALID_CHANGES");
  for (const key of Object.keys(payload.changes)) {
    assertShape(TASK_UPDATE_KEYS.has(key), `Pola "${key}" nie można edytować`, "INVALID_CHANGES");
  }
  const version = normalizeRequiredVersion(baseVersion);
  const changes = {};
  const c = payload.changes;
  if (c.title !== undefined) {
    assertShape(isNonEmptyText(c.title, 500), "Nieprawidłowy tytuł zadania", "INVALID_TITLE");
    changes.title = c.title.trim();
  }
  if (Object.prototype.hasOwnProperty.call(c, "description")) {
    assertShape(
      c.description === null || isOptionalText(c.description, 5000),
      "Nieprawidłowy opis zadania",
      "INVALID_DESCRIPTION",
    );
    changes.description = normalizeOptionalText(c.description);
  }
  if (c.status !== undefined) {
    assertShape(TASK_STATUSES.has(c.status), "Nieprawidłowy status zadania", "INVALID_STATUS");
    changes.status = c.status;
  }
  if (c.priority !== undefined) {
    assertShape(PRIORITIES.has(c.priority), "Nieprawidłowy priorytet zadania", "INVALID_PRIORITY");
    changes.priority = c.priority;
  }
  if (Object.prototype.hasOwnProperty.call(c, "date")) {
    assertShape(c.date === null || isIsoDate(c.date), "Nieprawidłowa data zadania", "INVALID_DATE");
    changes.date = c.date ?? null;
  }
  if (Object.prototype.hasOwnProperty.call(c, "time")) {
    assertShape(
      c.time === null || isClockTime(c.time),
      "Nieprawidłowa godzina zadania",
      "INVALID_TIME",
    );
    changes.time = c.time ?? null;
  }
  if (Object.prototype.hasOwnProperty.call(c, "estimatedMinutes")) {
    assertShape(
      c.estimatedMinutes === null || isPositiveInteger(c.estimatedMinutes),
      "Nieprawidłowy szacowany czas trwania",
      "INVALID_ESTIMATED_MINUTES",
    );
    changes.estimatedMinutes = c.estimatedMinutes ?? null;
  }
  if (c.category !== undefined) {
    assertShape(
      isNonEmptyText(c.category, 500),
      "Nieprawidłowa kategoria zadania",
      "INVALID_CATEGORY",
    );
    changes.category = c.category.trim();
  }
  if (c.isFocus !== undefined) {
    assertShape(typeof c.isFocus === "boolean", "Nieprawidłowa flaga fokusu", "INVALID_IS_FOCUS");
    changes.isFocus = c.isFocus;
  }
  if (c.energy !== undefined) {
    assertShape(ENERGIES.has(c.energy), "Nieprawidłowy poziom energii", "INVALID_ENERGY");
    changes.energy = c.energy;
  }
  if (Object.prototype.hasOwnProperty.call(c, "completedAt")) {
    assertShape(
      c.completedAt === null || isParsableTimestamp(c.completedAt),
      "Nieprawidłowy znacznik ukończenia",
      "INVALID_COMPLETED_AT",
    );
    changes.completedAt = c.completedAt ?? null;
  }
  if (c.visibility !== undefined) {
    assertShape(VISIBILITIES.has(c.visibility), "Nieprawidłowa widoczność", "INVALID_VISIBILITY");
    changes.visibility = c.visibility;
  }
  if (Object.prototype.hasOwnProperty.call(c, "seriesId")) {
    assertShape(
      c.seriesId === null || isId(c.seriesId),
      "Nieprawidłowy identyfikator serii",
      "INVALID_SERIES_ID",
    );
    changes.seriesId = c.seriesId ?? null;
  }
  if (Object.prototype.hasOwnProperty.call(c, "seriesIndex")) {
    assertShape(
      c.seriesIndex === null || isSeriesIndex(c.seriesIndex),
      "Nieprawidłowy indeks wystąpienia serii",
      "INVALID_SERIES_INDEX",
    );
    changes.seriesIndex = c.seriesIndex ?? null;
  }
  // `recurrence`/`seriesId`/`seriesIndex` are independently editable on update (no "all three or
  // none" group check here -- that only applies to `*.create`, see validateSeriesFields):
  // `updateSeries` may rewrite the recurrence rule alone.
  if (Object.prototype.hasOwnProperty.call(c, "recurrence")) {
    changes.recurrence = c.recurrence === null ? null : validateRecurrence(c.recurrence);
  }
  return { id: payload.id, changes, baseVersion: version };
}

export function validateDeleteIdPayload(payload) {
  assertShape(isPlainObject(payload), "Nieprawidłowy ładunek mutacji", "INVALID_PAYLOAD");
  assertShape(isId(payload.id), "Nieprawidłowy identyfikator", "INVALID_ID");
  return { id: payload.id };
}

export function validateEventCreatePayload(payload) {
  assertShape(isPlainObject(payload), "Nieprawidłowy ładunek mutacji", "INVALID_PAYLOAD");
  assertShape(isId(payload.id), "Nieprawidłowy identyfikator wydarzenia", "INVALID_ID");
  assertShape(
    isNonEmptyText(payload.title, 500),
    "Nieprawidłowy tytuł wydarzenia",
    "INVALID_TITLE",
  );
  assertShape(isIsoDate(payload.date), "Nieprawidłowa data wydarzenia", "INVALID_DATE");
  assertShape(
    isClockTime(payload.startTime),
    "Nieprawidłowa godzina rozpoczęcia",
    "INVALID_START_TIME",
  );
  assertShape(
    isClockTime(payload.endTime),
    "Nieprawidłowa godzina zakończenia",
    "INVALID_END_TIME",
  );
  assertShape(EVENT_KINDS.has(payload.kind), "Nieprawidłowy rodzaj wydarzenia", "INVALID_KIND");
  if (payload.location !== undefined && payload.location !== null) {
    assertShape(
      isOptionalText(payload.location, 1000),
      "Nieprawidłowa lokalizacja",
      "INVALID_LOCATION",
    );
  }
  if (payload.notes !== undefined && payload.notes !== null) {
    assertShape(isOptionalText(payload.notes, 5000), "Nieprawidłowe notatki", "INVALID_NOTES");
  }
  if (payload.source !== undefined && payload.source !== null) {
    assertShape(
      EVENT_SOURCES.has(payload.source),
      "Nieprawidłowe źródło wydarzenia",
      "INVALID_SOURCE",
    );
  }
  if (payload.externalId !== undefined && payload.externalId !== null) {
    assertShape(
      isOptionalText(payload.externalId, 500),
      "Nieprawidłowy identyfikator zewnętrzny",
      "INVALID_EXTERNAL_ID",
    );
  }
  if (payload.externalUpdatedAt !== undefined && payload.externalUpdatedAt !== null) {
    assertShape(
      isParsableTimestamp(payload.externalUpdatedAt),
      "Nieprawidłowy znacznik aktualizacji zewnętrznej",
      "INVALID_EXTERNAL_UPDATED_AT",
    );
  }
  assertShape(
    VISIBILITIES.has(payload.visibility),
    "Nieprawidłowa widoczność",
    "INVALID_VISIBILITY",
  );
  const series = validateSeriesFields(payload);
  return {
    id: payload.id,
    title: payload.title.trim(),
    date: payload.date,
    startTime: payload.startTime,
    endTime: payload.endTime,
    kind: payload.kind,
    location: normalizeOptionalText(payload.location),
    notes: normalizeOptionalText(payload.notes),
    source: payload.source ?? null,
    externalId: normalizeOptionalText(payload.externalId),
    externalUpdatedAt: payload.externalUpdatedAt ?? null,
    visibility: payload.visibility,
    seriesId: series.seriesId,
    seriesIndex: series.seriesIndex,
    recurrence: series.recurrence,
  };
}

// `visibility` IS in the update key set (same "Ryzyka" note as TASK_UPDATE_KEYS); `updateEventSeries`
// propagates `visibility` across the WHOLE series (frontend concern, useLifeRecordsStore.ts) but the
// server just applies whatever single-row `changes` it's given.
const EVENT_UPDATE_KEYS = new Set([
  "title",
  "date",
  "startTime",
  "endTime",
  "kind",
  "location",
  "notes",
  "source",
  "externalId",
  "externalUpdatedAt",
  "visibility",
  "seriesId",
  "seriesIndex",
  "recurrence",
]);

export function validateEventUpdatePayload(payload, baseVersion) {
  assertShape(isPlainObject(payload), "Nieprawidłowy ładunek mutacji", "INVALID_PAYLOAD");
  assertShape(isId(payload.id), "Nieprawidłowy identyfikator wydarzenia", "INVALID_ID");
  assertShape(isPlainObject(payload.changes), "Brak zmian do zastosowania", "INVALID_CHANGES");
  for (const key of Object.keys(payload.changes)) {
    assertShape(EVENT_UPDATE_KEYS.has(key), `Pola "${key}" nie można edytować`, "INVALID_CHANGES");
  }
  const version = normalizeRequiredVersion(baseVersion);
  const changes = {};
  const c = payload.changes;
  if (c.title !== undefined) {
    assertShape(isNonEmptyText(c.title, 500), "Nieprawidłowy tytuł wydarzenia", "INVALID_TITLE");
    changes.title = c.title.trim();
  }
  if (c.date !== undefined) {
    assertShape(isIsoDate(c.date), "Nieprawidłowa data wydarzenia", "INVALID_DATE");
    changes.date = c.date;
  }
  if (c.startTime !== undefined) {
    assertShape(
      isClockTime(c.startTime),
      "Nieprawidłowa godzina rozpoczęcia",
      "INVALID_START_TIME",
    );
    changes.startTime = c.startTime;
  }
  if (c.endTime !== undefined) {
    assertShape(isClockTime(c.endTime), "Nieprawidłowa godzina zakończenia", "INVALID_END_TIME");
    changes.endTime = c.endTime;
  }
  if (c.kind !== undefined) {
    assertShape(EVENT_KINDS.has(c.kind), "Nieprawidłowy rodzaj wydarzenia", "INVALID_KIND");
    changes.kind = c.kind;
  }
  if (Object.prototype.hasOwnProperty.call(c, "location")) {
    assertShape(
      c.location === null || isOptionalText(c.location, 1000),
      "Nieprawidłowa lokalizacja",
      "INVALID_LOCATION",
    );
    changes.location = normalizeOptionalText(c.location);
  }
  if (Object.prototype.hasOwnProperty.call(c, "notes")) {
    assertShape(
      c.notes === null || isOptionalText(c.notes, 5000),
      "Nieprawidłowe notatki",
      "INVALID_NOTES",
    );
    changes.notes = normalizeOptionalText(c.notes);
  }
  if (Object.prototype.hasOwnProperty.call(c, "source")) {
    assertShape(
      c.source === null || EVENT_SOURCES.has(c.source),
      "Nieprawidłowe źródło wydarzenia",
      "INVALID_SOURCE",
    );
    changes.source = c.source ?? null;
  }
  if (Object.prototype.hasOwnProperty.call(c, "externalId")) {
    assertShape(
      c.externalId === null || isOptionalText(c.externalId, 500),
      "Nieprawidłowy identyfikator zewnętrzny",
      "INVALID_EXTERNAL_ID",
    );
    changes.externalId = normalizeOptionalText(c.externalId);
  }
  if (Object.prototype.hasOwnProperty.call(c, "externalUpdatedAt")) {
    assertShape(
      c.externalUpdatedAt === null || isParsableTimestamp(c.externalUpdatedAt),
      "Nieprawidłowy znacznik aktualizacji zewnętrznej",
      "INVALID_EXTERNAL_UPDATED_AT",
    );
    changes.externalUpdatedAt = c.externalUpdatedAt ?? null;
  }
  if (c.visibility !== undefined) {
    assertShape(VISIBILITIES.has(c.visibility), "Nieprawidłowa widoczność", "INVALID_VISIBILITY");
    changes.visibility = c.visibility;
  }
  if (Object.prototype.hasOwnProperty.call(c, "seriesId")) {
    assertShape(
      c.seriesId === null || isId(c.seriesId),
      "Nieprawidłowy identyfikator serii",
      "INVALID_SERIES_ID",
    );
    changes.seriesId = c.seriesId ?? null;
  }
  if (Object.prototype.hasOwnProperty.call(c, "seriesIndex")) {
    assertShape(
      c.seriesIndex === null || isSeriesIndex(c.seriesIndex),
      "Nieprawidłowy indeks wystąpienia serii",
      "INVALID_SERIES_INDEX",
    );
    changes.seriesIndex = c.seriesIndex ?? null;
  }
  if (Object.prototype.hasOwnProperty.call(c, "recurrence")) {
    changes.recurrence = c.recurrence === null ? null : validateRecurrence(c.recurrence);
  }
  return { id: payload.id, changes, baseVersion: version };
}

export function validateReminderCreatePayload(payload) {
  assertShape(isPlainObject(payload), "Nieprawidłowy ładunek mutacji", "INVALID_PAYLOAD");
  assertShape(isId(payload.id), "Nieprawidłowy identyfikator przypomnienia", "INVALID_ID");
  assertShape(
    isNonEmptyText(payload.title, 500),
    "Nieprawidłowy tytuł przypomnienia",
    "INVALID_TITLE",
  );
  assertShape(isIsoDate(payload.date), "Nieprawidłowa data przypomnienia", "INVALID_DATE");
  assertShape(isClockTime(payload.time), "Nieprawidłowa godzina przypomnienia", "INVALID_TIME");
  if (payload.done !== undefined) {
    assertShape(
      typeof payload.done === "boolean",
      "Nieprawidłowy status przypomnienia",
      "INVALID_DONE",
    );
  }
  if (payload.notifiedAt !== undefined && payload.notifiedAt !== null) {
    assertShape(
      isParsableTimestamp(payload.notifiedAt),
      "Nieprawidłowy znacznik powiadomienia",
      "INVALID_NOTIFIED_AT",
    );
  }
  assertShape(
    VISIBILITIES.has(payload.visibility),
    "Nieprawidłowa widoczność",
    "INVALID_VISIBILITY",
  );
  return {
    id: payload.id,
    title: payload.title.trim(),
    date: payload.date,
    time: payload.time,
    done: payload.done ?? false,
    notifiedAt: payload.notifiedAt ?? null,
    visibility: payload.visibility,
  };
}

// `visibility` IS in the update key set (same "Ryzyka" note). `toggleReminder` sends `changes:
// {done}`; `snoozeReminder` sends `changes: {date, time, notifiedAt: null}`;
// `markReminderNotified` sends `changes: {notifiedAt}` -- all plain updates through this op, the
// client having already computed the (possibly toggled) value locally. `notified_at` is ALSO
// written by the worker directly in SQL (worker.mjs), without going through this validator/op.
const REMINDER_UPDATE_KEYS = new Set(["title", "date", "time", "done", "notifiedAt", "visibility"]);

export function validateReminderUpdatePayload(payload, baseVersion) {
  assertShape(isPlainObject(payload), "Nieprawidłowy ładunek mutacji", "INVALID_PAYLOAD");
  assertShape(isId(payload.id), "Nieprawidłowy identyfikator przypomnienia", "INVALID_ID");
  assertShape(isPlainObject(payload.changes), "Brak zmian do zastosowania", "INVALID_CHANGES");
  for (const key of Object.keys(payload.changes)) {
    assertShape(
      REMINDER_UPDATE_KEYS.has(key),
      `Pola "${key}" nie można edytować`,
      "INVALID_CHANGES",
    );
  }
  const version = normalizeRequiredVersion(baseVersion);
  const changes = {};
  const c = payload.changes;
  if (c.title !== undefined) {
    assertShape(isNonEmptyText(c.title, 500), "Nieprawidłowy tytuł przypomnienia", "INVALID_TITLE");
    changes.title = c.title.trim();
  }
  if (c.date !== undefined) {
    assertShape(isIsoDate(c.date), "Nieprawidłowa data przypomnienia", "INVALID_DATE");
    changes.date = c.date;
  }
  if (c.time !== undefined) {
    assertShape(isClockTime(c.time), "Nieprawidłowa godzina przypomnienia", "INVALID_TIME");
    changes.time = c.time;
  }
  if (c.done !== undefined) {
    assertShape(typeof c.done === "boolean", "Nieprawidłowy status przypomnienia", "INVALID_DONE");
    changes.done = c.done;
  }
  if (Object.prototype.hasOwnProperty.call(c, "notifiedAt")) {
    assertShape(
      c.notifiedAt === null || isParsableTimestamp(c.notifiedAt),
      "Nieprawidłowy znacznik powiadomienia",
      "INVALID_NOTIFIED_AT",
    );
    changes.notifiedAt = c.notifiedAt ?? null;
  }
  if (c.visibility !== undefined) {
    assertShape(VISIBILITIES.has(c.visibility), "Nieprawidłowa widoczność", "INVALID_VISIBILITY");
    changes.visibility = c.visibility;
  }
  return { id: payload.id, changes, baseVersion: version };
}

export function validateNoteCreatePayload(payload) {
  assertShape(isPlainObject(payload), "Nieprawidłowy ładunek mutacji", "INVALID_PAYLOAD");
  assertShape(isId(payload.id), "Nieprawidłowy identyfikator notatki", "INVALID_ID");
  assertShape(isNonEmptyText(payload.title, 500), "Nieprawidłowy tytuł notatki", "INVALID_TITLE");
  assertShape(isNoteContent(payload.content), "Nieprawidłowa treść notatki", "INVALID_CONTENT");
  assertShape(NOTE_COLORS.has(payload.color), "Nieprawidłowy kolor notatki", "INVALID_COLOR");
  assertShape(
    typeof payload.pinned === "boolean",
    "Nieprawidłowa flaga przypięcia",
    "INVALID_PINNED",
  );
  assertShape(
    VISIBILITIES.has(payload.visibility),
    "Nieprawidłowa widoczność",
    "INVALID_VISIBILITY",
  );
  return {
    id: payload.id,
    title: payload.title.trim(),
    content: payload.content,
    color: payload.color,
    pinned: payload.pinned,
    visibility: payload.visibility,
  };
}

// `visibility` IS in the update key set (same "Ryzyka" note).
const NOTE_UPDATE_KEYS = new Set(["title", "content", "color", "pinned", "visibility"]);

export function validateNoteUpdatePayload(payload, baseVersion) {
  assertShape(isPlainObject(payload), "Nieprawidłowy ładunek mutacji", "INVALID_PAYLOAD");
  assertShape(isId(payload.id), "Nieprawidłowy identyfikator notatki", "INVALID_ID");
  assertShape(isPlainObject(payload.changes), "Brak zmian do zastosowania", "INVALID_CHANGES");
  for (const key of Object.keys(payload.changes)) {
    assertShape(NOTE_UPDATE_KEYS.has(key), `Pola "${key}" nie można edytować`, "INVALID_CHANGES");
  }
  const version = normalizeRequiredVersion(baseVersion);
  const changes = {};
  const c = payload.changes;
  if (c.title !== undefined) {
    assertShape(isNonEmptyText(c.title, 500), "Nieprawidłowy tytuł notatki", "INVALID_TITLE");
    changes.title = c.title.trim();
  }
  if (c.content !== undefined) {
    assertShape(isNoteContent(c.content), "Nieprawidłowa treść notatki", "INVALID_CONTENT");
    changes.content = c.content;
  }
  if (c.color !== undefined) {
    assertShape(NOTE_COLORS.has(c.color), "Nieprawidłowy kolor notatki", "INVALID_COLOR");
    changes.color = c.color;
  }
  if (c.pinned !== undefined) {
    assertShape(typeof c.pinned === "boolean", "Nieprawidłowa flaga przypięcia", "INVALID_PINNED");
    changes.pinned = c.pinned;
  }
  if (c.visibility !== undefined) {
    assertShape(VISIBILITIES.has(c.visibility), "Nieprawidłowa widoczność", "INVALID_VISIBILITY");
    changes.visibility = c.visibility;
  }
  return { id: payload.id, changes, baseVersion: version };
}

export function validateHabitCreatePayload(payload) {
  assertShape(isPlainObject(payload), "Nieprawidłowy ładunek mutacji", "INVALID_PAYLOAD");
  assertShape(isId(payload.id), "Nieprawidłowy identyfikator nawyku", "INVALID_ID");
  assertShape(isNonEmptyText(payload.name, 500), "Nieprawidłowa nazwa nawyku", "INVALID_NAME");
  assertShape(HABIT_ICONS.has(payload.icon), "Nieprawidłowa ikona nawyku", "INVALID_ICON");
  assertShape(
    isNonEmptyText(payload.targetLabel, 500),
    "Nieprawidłowy opis celu nawyku",
    "INVALID_TARGET_LABEL",
  );
  if (payload.completedDates !== undefined) {
    assertShape(
      validateCompletedDates(payload.completedDates),
      "Nieprawidłowe daty ukończenia nawyku",
      "INVALID_COMPLETED_DATES",
    );
  }
  assertShape(
    VISIBILITIES.has(payload.visibility),
    "Nieprawidłowa widoczność",
    "INVALID_VISIBILITY",
  );
  return {
    id: payload.id,
    name: payload.name.trim(),
    icon: payload.icon,
    targetLabel: payload.targetLabel.trim(),
    completedDates: Array.isArray(payload.completedDates) ? payload.completedDates : [],
    visibility: payload.visibility,
  };
}

// `visibility` IS in the update key set (same "Ryzyka" note). `toggleHabit` sends `changes:
// {completedDates}` -- the client recomputes the WHOLE array locally (absolute set, not a real
// flip, docs/plans/…"Projekt pól specjalnych") and this op just persists it 1:1.
const HABIT_UPDATE_KEYS = new Set(["name", "icon", "targetLabel", "completedDates", "visibility"]);

export function validateHabitUpdatePayload(payload, baseVersion) {
  assertShape(isPlainObject(payload), "Nieprawidłowy ładunek mutacji", "INVALID_PAYLOAD");
  assertShape(isId(payload.id), "Nieprawidłowy identyfikator nawyku", "INVALID_ID");
  assertShape(isPlainObject(payload.changes), "Brak zmian do zastosowania", "INVALID_CHANGES");
  for (const key of Object.keys(payload.changes)) {
    assertShape(HABIT_UPDATE_KEYS.has(key), `Pola "${key}" nie można edytować`, "INVALID_CHANGES");
  }
  const version = normalizeRequiredVersion(baseVersion);
  const changes = {};
  const c = payload.changes;
  if (c.name !== undefined) {
    assertShape(isNonEmptyText(c.name, 500), "Nieprawidłowa nazwa nawyku", "INVALID_NAME");
    changes.name = c.name.trim();
  }
  if (c.icon !== undefined) {
    assertShape(HABIT_ICONS.has(c.icon), "Nieprawidłowa ikona nawyku", "INVALID_ICON");
    changes.icon = c.icon;
  }
  if (c.targetLabel !== undefined) {
    assertShape(
      isNonEmptyText(c.targetLabel, 500),
      "Nieprawidłowy opis celu nawyku",
      "INVALID_TARGET_LABEL",
    );
    changes.targetLabel = c.targetLabel.trim();
  }
  if (c.completedDates !== undefined) {
    assertShape(
      validateCompletedDates(c.completedDates),
      "Nieprawidłowe daty ukończenia nawyku",
      "INVALID_COMPLETED_DATES",
    );
    changes.completedDates = c.completedDates;
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

export const SUPPORTED_LIFE_OPS = new Set([
  "task.create",
  "task.update",
  "task.delete",
  "event.create",
  "event.update",
  "event.delete",
  "reminder.create",
  "reminder.update",
  "reminder.delete",
  "note.create",
  "note.update",
  "note.delete",
  "habit.create",
  "habit.update",
  "habit.delete",
]);

// Whole-request-shape validation, mirroring assertHealthMutationShape/assertSubscriptionMutationShape:
// called once per mutation BEFORE any DB work starts, so a malformed entry anywhere in the batch
// is rejected as a single 400 rather than silently corrupting bookkeeping for its siblings.
// Per-mutation *business* validation (bad field values, missing record, ...) is reported as
// `status: "error"` inside `results` by applyLifeMutation instead.
export function assertLifeMutationShape(mutation) {
  if (!isPlainObject(mutation)) {
    throw lifeRequestError(400, "Nieprawidłowy kształt mutacji", "INVALID_LIFE_MUTATION");
  }
  if (typeof mutation.idempotencyKey !== "string" || !UUID_PATTERN.test(mutation.idempotencyKey)) {
    throw lifeRequestError(400, "Nieprawidłowy klucz idempotencji", "INVALID_IDEMPOTENCY_KEY");
  }
  if (typeof mutation.op !== "string" || !SUPPORTED_LIFE_OPS.has(mutation.op)) {
    throw lifeRequestError(400, "Nieobsługiwana operacja mutacji", "UNSUPPORTED_OP");
  }
  if (!isPlainObject(mutation.payload)) {
    throw lifeRequestError(400, "Brak danych mutacji", "INVALID_LIFE_MUTATION");
  }
  if (
    mutation.baseVersion !== undefined &&
    mutation.baseVersion !== null &&
    !Number.isInteger(mutation.baseVersion)
  ) {
    throw lifeRequestError(400, "Nieprawidłowa wersja bazowa mutacji", "INVALID_LIFE_MUTATION");
  }
}

// Higher default than Health (1000 vs 500, docs/plans/…"Endpointy REST": materializacja
// bezterminowych serii + `updateSeries` mogą wygenerować kilkadziesiąt mutacji naraz --
// `SERIES_WINDOW=10` × kilka serii + edycje).
export const MAX_LIFE_MUTATIONS_PER_BATCH = Number(process.env.MAX_LIFE_MUTATIONS ?? 1000);
export const MAX_LIFE_MUTATIONS_BYTES = Number(process.env.MAX_LIFE_MUTATIONS_BYTES ?? 2_000_000);

// ---------------------------------------------------------------------------
// Snapshot read (GET /api/v1/life): household-wide records + the caller's own private records,
// for all five tables (wzór readHealthSnapshot). Every table scopes purely by its own row -- no
// EXISTS-on-parent anywhere here (there is no parent/child relation in Life).
// ---------------------------------------------------------------------------

export async function readLifeSnapshot(client, householdId, userId) {
  // Sequential, not Promise.all: `client` may be a single-connection PoolClient (e.g. when called
  // inside a transaction()), and node-postgres only supports one in-flight query per connection.
  const tasks = await client.query(
    `SELECT ${TASK_SELECT_COLUMNS} FROM tasks
      WHERE household_id = $1 AND (visibility = 'household' OR owner_id = $2)
      ORDER BY created_at`,
    [householdId, userId],
  );
  const events = await client.query(
    `SELECT ${EVENT_SELECT_COLUMNS} FROM events
      WHERE household_id = $1 AND (visibility = 'household' OR owner_id = $2)
      ORDER BY date, start_time`,
    [householdId, userId],
  );
  const reminders = await client.query(
    `SELECT ${REMINDER_SELECT_COLUMNS} FROM reminders
      WHERE household_id = $1 AND (visibility = 'household' OR owner_id = $2)
      ORDER BY date, time`,
    [householdId, userId],
  );
  const notes = await client.query(
    `SELECT ${NOTE_SELECT_COLUMNS} FROM notes
      WHERE household_id = $1 AND (visibility = 'household' OR owner_id = $2)
      ORDER BY pinned DESC, created_at DESC`,
    [householdId, userId],
  );
  const habits = await client.query(
    `SELECT ${HABIT_SELECT_COLUMNS} FROM habits
      WHERE household_id = $1 AND (visibility = 'household' OR owner_id = $2)
      ORDER BY created_at`,
    [householdId, userId],
  );
  return {
    tasks: tasks.rows.map(taskRowToDto),
    events: events.rows.map(eventRowToDto),
    reminders: reminders.rows.map(reminderRowToDto),
    notes: notes.rows.map(noteRowToDto),
    habits: habits.rows.map(habitRowToDto),
  };
}

// Wspiera "Wyczyść dane aplikacji" (SettingsPage.tsx danger zone). Wzór resetHealthForUser: usuwa
// wszystko wspólne (`visibility = 'household'`) plus WYŁĄCZNIE prywatne rekordy wywołującego
// użytkownika (`owner_id = userId`) w danym gospodarstwie -- NIE cały reset gospodarstwa, bo Life
// ma dużo rekordów prywatnych. Pięć niezależnych DELETE (kolejność dowolna -- brak FK między
// tabelami Life).
export async function resetLifeForUser(client, householdId, userId) {
  await client.query(
    `DELETE FROM tasks WHERE household_id = $1 AND (visibility = 'household' OR owner_id = $2)`,
    [householdId, userId],
  );
  await client.query(
    `DELETE FROM events WHERE household_id = $1 AND (visibility = 'household' OR owner_id = $2)`,
    [householdId, userId],
  );
  await client.query(
    `DELETE FROM reminders WHERE household_id = $1 AND (visibility = 'household' OR owner_id = $2)`,
    [householdId, userId],
  );
  await client.query(
    `DELETE FROM notes WHERE household_id = $1 AND (visibility = 'household' OR owner_id = $2)`,
    [householdId, userId],
  );
  await client.query(
    `DELETE FROM habits WHERE household_id = $1 AND (visibility = 'household' OR owner_id = $2)`,
    [householdId, userId],
  );
}

// ---------------------------------------------------------------------------
// Shared OCC/conflict resolution helpers used by every update/delete op (mirrors health.mjs). The
// lookup query MUST carry the same household/visibility scoping as the write it's diagnosing --
// otherwise this could leak the existence or content of another user's private record through the
// "current record" in a conflict response (docs/plans/…"Bezpieczeństwo scope'u widoczności").
// ---------------------------------------------------------------------------

// `conflictCode` (optional) is attached to the `status:"conflict"` branch itself -- distinct from
// `notFoundCode`, which only tags the `status:"error"` branch below. The five `*.create` call
// sites (23505 unique-violation on the deterministic series-occurrence id) pass "ID_TAKEN" here so
// the conflict response matches the documented contract (`{status:"conflict", code:"ID_TAKEN",
// record, currentVersion}`, see the module header comment and docs/plans/…"Ops mutacji"); the five
// `*.update` call sites (stale baseVersion) intentionally omit it -- an ordinary per-record OCC
// conflict has no error code, only Health/Subscriptions-style `{status, record, currentVersion}`.
async function resolveConflictOrError(
  client,
  query,
  params,
  mapper,
  notFoundMessage,
  notFoundCode,
  conflictCode,
) {
  const existing = await client.query(query, params);
  if (existing.rowCount) {
    const row = existing.rows[0];
    const conflict = { status: "conflict", record: mapper(row), currentVersion: row.version };
    if (conflictCode) conflict.code = conflictCode;
    return conflict;
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
// by assertLifeMutationShape; they still run their own (business-rule) validators and throw
// LifeValidationError on bad input, which applyLifeMutation turns into `status: "error"`.
// A unique-violation (23505) on `*.create` -- expected for deterministic series-occurrence ids --
// resolves to `{status:"conflict", code:"ID_TAKEN"}` exactly like any other create conflict; the
// frontend adopts the server record on ID_TAKEN the same way it does on `applied`.
// ---------------------------------------------------------------------------

async function execTaskCreate(client, ctx, payload) {
  const data = validateTaskCreatePayload(payload);
  const ownerId = resolveOwnerId(ctx);
  // A unique-violation (23505, EXPECTED for deterministic series-occurrence ids) aborts the
  // surrounding transaction at the Postgres protocol level -- any further statement on the same
  // connection fails with 25P02 ("current transaction is aborted") until a ROLLBACK is issued. The
  // caller (server.mjs) runs this whole mutation inside one transaction() that must still COMMIT
  // afterwards (sibling mutations in later requests reuse the connection from the pool), so the
  // diagnostic SELECT in the catch block below needs the sub-transaction rolled back to this
  // savepoint first, or it would itself throw 25P02 instead of returning a graceful ID_TAKEN.
  await client.query("SAVEPOINT life_create");
  try {
    const inserted = await client.query(
      `INSERT INTO tasks
         (id, household_id, owner_id, visibility, title, description, status, priority, date, time,
          estimated_minutes, category, is_focus, energy, completed_at, series_id, series_index,
          recurrence, version, updated_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::date, $10, $11, $12, $13, $14, $15::timestamptz,
               $16, $17, $18::jsonb, 1, $3)
       RETURNING ${TASK_SELECT_COLUMNS}`,
      [
        data.id,
        ctx.householdId,
        ownerId,
        data.visibility,
        data.title,
        data.description,
        data.status,
        data.priority,
        data.date,
        data.time,
        data.estimatedMinutes,
        data.category,
        data.isFocus,
        data.energy,
        data.completedAt,
        data.seriesId,
        data.seriesIndex,
        data.recurrence === null ? null : JSON.stringify(data.recurrence),
      ],
    );
    return { status: "applied", record: taskRowToDto(inserted.rows[0]) };
  } catch (error) {
    if (error.code === "23505") {
      await client.query("ROLLBACK TO SAVEPOINT life_create");
      return resolveConflictOrError(
        client,
        `SELECT ${TASK_SELECT_COLUMNS} FROM tasks
          WHERE id = $1 AND household_id = $2 AND (visibility = 'household' OR owner_id = $3)`,
        [data.id, ctx.householdId, ownerId],
        taskRowToDto,
        "Identyfikator jest już używany",
        "ID_TAKEN",
        "ID_TAKEN",
      );
    }
    throw error;
  }
}

async function execTaskUpdate(client, ctx, payload, baseVersion) {
  const { id, changes, baseVersion: version } = validateTaskUpdatePayload(payload, baseVersion);
  const ownerId = resolveOwnerId(ctx);
  const hasDescription = Object.prototype.hasOwnProperty.call(changes, "description");
  const hasDate = Object.prototype.hasOwnProperty.call(changes, "date");
  const hasTime = Object.prototype.hasOwnProperty.call(changes, "time");
  const hasEstimatedMinutes = Object.prototype.hasOwnProperty.call(changes, "estimatedMinutes");
  const hasCompletedAt = Object.prototype.hasOwnProperty.call(changes, "completedAt");
  const hasSeriesId = Object.prototype.hasOwnProperty.call(changes, "seriesId");
  const hasSeriesIndex = Object.prototype.hasOwnProperty.call(changes, "seriesIndex");
  const hasRecurrence = Object.prototype.hasOwnProperty.call(changes, "recurrence");
  const updated = await client.query(
    `UPDATE tasks
        SET title = COALESCE($1, title),
            status = COALESCE($2, status),
            priority = COALESCE($3, priority),
            category = COALESCE($4, category),
            is_focus = COALESCE($5, is_focus),
            energy = COALESCE($6, energy),
            description = CASE WHEN $7 THEN $8 ELSE description END,
            date = CASE WHEN $9 THEN $10::date ELSE date END,
            time = CASE WHEN $11 THEN $12 ELSE time END,
            estimated_minutes = CASE WHEN $13 THEN $14 ELSE estimated_minutes END,
            completed_at = CASE WHEN $15 THEN $16::timestamptz ELSE completed_at END,
            series_id = CASE WHEN $17 THEN $18 ELSE series_id END,
            series_index = CASE WHEN $19 THEN $20 ELSE series_index END,
            recurrence = CASE WHEN $21 THEN $22::jsonb ELSE recurrence END,
            visibility = COALESCE($23, visibility),
            version = version + 1,
            updated_at = now(),
            updated_by = $24
      WHERE id = $25 AND household_id = $26 AND version = $27
        AND (visibility = 'household' OR owner_id = $24)
      RETURNING ${TASK_SELECT_COLUMNS}`,
    [
      changes.title ?? null,
      changes.status ?? null,
      changes.priority ?? null,
      changes.category ?? null,
      changes.isFocus ?? null,
      changes.energy ?? null,
      hasDescription,
      hasDescription ? changes.description : null,
      hasDate,
      hasDate ? changes.date : null,
      hasTime,
      hasTime ? changes.time : null,
      hasEstimatedMinutes,
      hasEstimatedMinutes ? changes.estimatedMinutes : null,
      hasCompletedAt,
      hasCompletedAt ? changes.completedAt : null,
      hasSeriesId,
      hasSeriesId ? changes.seriesId : null,
      hasSeriesIndex,
      hasSeriesIndex ? changes.seriesIndex : null,
      hasRecurrence,
      hasRecurrence
        ? changes.recurrence === null
          ? null
          : JSON.stringify(changes.recurrence)
        : null,
      changes.visibility ?? null,
      ownerId,
      id,
      ctx.householdId,
      version,
    ],
  );
  if (updated.rowCount) return { status: "applied", record: taskRowToDto(updated.rows[0]) };
  return resolveConflictOrError(
    client,
    `SELECT ${TASK_SELECT_COLUMNS} FROM tasks
      WHERE id = $1 AND household_id = $2 AND (visibility = 'household' OR owner_id = $3)`,
    [id, ctx.householdId, ownerId],
    taskRowToDto,
    "Rekord nie istnieje lub jest niedostępny",
    "NOT_FOUND",
  );
}

async function execTaskDelete(client, ctx, payload, baseVersion) {
  const { id } = validateDeleteIdPayload(payload);
  const ownerId = resolveOwnerId(ctx);
  const version = normalizeOptionalVersion(baseVersion);
  const deleted = await client.query(
    `DELETE FROM tasks
      WHERE id = $1 AND household_id = $2 AND (visibility = 'household' OR owner_id = $3)
        AND ($4::integer IS NULL OR version = $4)
      RETURNING id`,
    [id, ctx.householdId, ownerId, version],
  );
  if (deleted.rowCount) return { status: "applied", record: null };
  return resolveConflictOrGone(
    client,
    `SELECT ${TASK_SELECT_COLUMNS} FROM tasks
      WHERE id = $1 AND household_id = $2 AND (visibility = 'household' OR owner_id = $3)`,
    [id, ctx.householdId, ownerId],
    taskRowToDto,
  );
}

async function execEventCreate(client, ctx, payload) {
  const data = validateEventCreatePayload(payload);
  const ownerId = resolveOwnerId(ctx);
  // See execTaskCreate's comment: a unique-violation aborts the transaction at the protocol level,
  // so the diagnostic SELECT below needs a savepoint rollback first or it would itself throw 25P02.
  await client.query("SAVEPOINT life_create");
  try {
    const inserted = await client.query(
      `INSERT INTO events
         (id, household_id, owner_id, visibility, title, date, start_time, end_time, kind, location,
          notes, source, external_id, external_updated_at, series_id, series_index, recurrence,
          version, updated_by)
       VALUES ($1, $2, $3, $4, $5, $6::date, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16,
               $17::jsonb, 1, $3)
       RETURNING ${EVENT_SELECT_COLUMNS}`,
      [
        data.id,
        ctx.householdId,
        ownerId,
        data.visibility,
        data.title,
        data.date,
        data.startTime,
        data.endTime,
        data.kind,
        data.location,
        data.notes,
        data.source,
        data.externalId,
        data.externalUpdatedAt,
        data.seriesId,
        data.seriesIndex,
        data.recurrence === null ? null : JSON.stringify(data.recurrence),
      ],
    );
    return { status: "applied", record: eventRowToDto(inserted.rows[0]) };
  } catch (error) {
    if (error.code === "23505") {
      await client.query("ROLLBACK TO SAVEPOINT life_create");
      return resolveConflictOrError(
        client,
        `SELECT ${EVENT_SELECT_COLUMNS} FROM events
          WHERE id = $1 AND household_id = $2 AND (visibility = 'household' OR owner_id = $3)`,
        [data.id, ctx.householdId, ownerId],
        eventRowToDto,
        "Identyfikator jest już używany",
        "ID_TAKEN",
        "ID_TAKEN",
      );
    }
    throw error;
  }
}

async function execEventUpdate(client, ctx, payload, baseVersion) {
  const { id, changes, baseVersion: version } = validateEventUpdatePayload(payload, baseVersion);
  const ownerId = resolveOwnerId(ctx);
  const hasLocation = Object.prototype.hasOwnProperty.call(changes, "location");
  const hasNotes = Object.prototype.hasOwnProperty.call(changes, "notes");
  const hasSource = Object.prototype.hasOwnProperty.call(changes, "source");
  const hasExternalId = Object.prototype.hasOwnProperty.call(changes, "externalId");
  const hasExternalUpdatedAt = Object.prototype.hasOwnProperty.call(changes, "externalUpdatedAt");
  const hasSeriesId = Object.prototype.hasOwnProperty.call(changes, "seriesId");
  const hasSeriesIndex = Object.prototype.hasOwnProperty.call(changes, "seriesIndex");
  const hasRecurrence = Object.prototype.hasOwnProperty.call(changes, "recurrence");
  const updated = await client.query(
    `UPDATE events
        SET title = COALESCE($1, title),
            date = COALESCE($2::date, date),
            start_time = COALESCE($3, start_time),
            end_time = COALESCE($4, end_time),
            kind = COALESCE($5, kind),
            location = CASE WHEN $6 THEN $7 ELSE location END,
            notes = CASE WHEN $8 THEN $9 ELSE notes END,
            source = CASE WHEN $10 THEN $11 ELSE source END,
            external_id = CASE WHEN $12 THEN $13 ELSE external_id END,
            external_updated_at = CASE WHEN $14 THEN $15 ELSE external_updated_at END,
            series_id = CASE WHEN $16 THEN $17 ELSE series_id END,
            series_index = CASE WHEN $18 THEN $19 ELSE series_index END,
            recurrence = CASE WHEN $20 THEN $21::jsonb ELSE recurrence END,
            visibility = COALESCE($22, visibility),
            version = version + 1,
            updated_at = now(),
            updated_by = $23
      WHERE id = $24 AND household_id = $25 AND version = $26
        AND (visibility = 'household' OR owner_id = $23)
      RETURNING ${EVENT_SELECT_COLUMNS}`,
    [
      changes.title ?? null,
      changes.date ?? null,
      changes.startTime ?? null,
      changes.endTime ?? null,
      changes.kind ?? null,
      hasLocation,
      hasLocation ? changes.location : null,
      hasNotes,
      hasNotes ? changes.notes : null,
      hasSource,
      hasSource ? changes.source : null,
      hasExternalId,
      hasExternalId ? changes.externalId : null,
      hasExternalUpdatedAt,
      hasExternalUpdatedAt ? changes.externalUpdatedAt : null,
      hasSeriesId,
      hasSeriesId ? changes.seriesId : null,
      hasSeriesIndex,
      hasSeriesIndex ? changes.seriesIndex : null,
      hasRecurrence,
      hasRecurrence
        ? changes.recurrence === null
          ? null
          : JSON.stringify(changes.recurrence)
        : null,
      changes.visibility ?? null,
      ownerId,
      id,
      ctx.householdId,
      version,
    ],
  );
  if (updated.rowCount) return { status: "applied", record: eventRowToDto(updated.rows[0]) };
  return resolveConflictOrError(
    client,
    `SELECT ${EVENT_SELECT_COLUMNS} FROM events
      WHERE id = $1 AND household_id = $2 AND (visibility = 'household' OR owner_id = $3)`,
    [id, ctx.householdId, ownerId],
    eventRowToDto,
    "Rekord nie istnieje lub jest niedostępny",
    "NOT_FOUND",
  );
}

async function execEventDelete(client, ctx, payload, baseVersion) {
  const { id } = validateDeleteIdPayload(payload);
  const ownerId = resolveOwnerId(ctx);
  const version = normalizeOptionalVersion(baseVersion);
  const deleted = await client.query(
    `DELETE FROM events
      WHERE id = $1 AND household_id = $2 AND (visibility = 'household' OR owner_id = $3)
        AND ($4::integer IS NULL OR version = $4)
      RETURNING id`,
    [id, ctx.householdId, ownerId, version],
  );
  if (deleted.rowCount) return { status: "applied", record: null };
  return resolveConflictOrGone(
    client,
    `SELECT ${EVENT_SELECT_COLUMNS} FROM events
      WHERE id = $1 AND household_id = $2 AND (visibility = 'household' OR owner_id = $3)`,
    [id, ctx.householdId, ownerId],
    eventRowToDto,
  );
}

async function execReminderCreate(client, ctx, payload) {
  const data = validateReminderCreatePayload(payload);
  const ownerId = resolveOwnerId(ctx);
  // See execTaskCreate's comment: a unique-violation aborts the transaction at the protocol level,
  // so the diagnostic SELECT below needs a savepoint rollback first or it would itself throw 25P02.
  await client.query("SAVEPOINT life_create");
  try {
    const inserted = await client.query(
      `INSERT INTO reminders
         (id, household_id, owner_id, visibility, title, date, time, done, notified_at, version,
          updated_by)
       VALUES ($1, $2, $3, $4, $5, $6::date, $7, $8, $9::timestamptz, 1, $3)
       RETURNING ${REMINDER_SELECT_COLUMNS}`,
      [
        data.id,
        ctx.householdId,
        ownerId,
        data.visibility,
        data.title,
        data.date,
        data.time,
        data.done,
        data.notifiedAt,
      ],
    );
    return { status: "applied", record: reminderRowToDto(inserted.rows[0]) };
  } catch (error) {
    if (error.code === "23505") {
      await client.query("ROLLBACK TO SAVEPOINT life_create");
      return resolveConflictOrError(
        client,
        `SELECT ${REMINDER_SELECT_COLUMNS} FROM reminders
          WHERE id = $1 AND household_id = $2 AND (visibility = 'household' OR owner_id = $3)`,
        [data.id, ctx.householdId, ownerId],
        reminderRowToDto,
        "Identyfikator jest już używany",
        "ID_TAKEN",
        "ID_TAKEN",
      );
    }
    throw error;
  }
}

async function execReminderUpdate(client, ctx, payload, baseVersion) {
  const { id, changes, baseVersion: version } = validateReminderUpdatePayload(payload, baseVersion);
  const ownerId = resolveOwnerId(ctx);
  const hasNotifiedAt = Object.prototype.hasOwnProperty.call(changes, "notifiedAt");
  const updated = await client.query(
    `UPDATE reminders
        SET title = COALESCE($1, title),
            date = COALESCE($2::date, date),
            time = COALESCE($3, time),
            done = COALESCE($4, done),
            notified_at = CASE WHEN $5 THEN $6::timestamptz ELSE notified_at END,
            visibility = COALESCE($7, visibility),
            version = version + 1,
            updated_at = now(),
            updated_by = $8
      WHERE id = $9 AND household_id = $10 AND version = $11
        AND (visibility = 'household' OR owner_id = $8)
      RETURNING ${REMINDER_SELECT_COLUMNS}`,
    [
      changes.title ?? null,
      changes.date ?? null,
      changes.time ?? null,
      changes.done ?? null,
      hasNotifiedAt,
      hasNotifiedAt ? changes.notifiedAt : null,
      changes.visibility ?? null,
      ownerId,
      id,
      ctx.householdId,
      version,
    ],
  );
  if (updated.rowCount) return { status: "applied", record: reminderRowToDto(updated.rows[0]) };
  return resolveConflictOrError(
    client,
    `SELECT ${REMINDER_SELECT_COLUMNS} FROM reminders
      WHERE id = $1 AND household_id = $2 AND (visibility = 'household' OR owner_id = $3)`,
    [id, ctx.householdId, ownerId],
    reminderRowToDto,
    "Rekord nie istnieje lub jest niedostępny",
    "NOT_FOUND",
  );
}

async function execReminderDelete(client, ctx, payload, baseVersion) {
  const { id } = validateDeleteIdPayload(payload);
  const ownerId = resolveOwnerId(ctx);
  const version = normalizeOptionalVersion(baseVersion);
  const deleted = await client.query(
    `DELETE FROM reminders
      WHERE id = $1 AND household_id = $2 AND (visibility = 'household' OR owner_id = $3)
        AND ($4::integer IS NULL OR version = $4)
      RETURNING id`,
    [id, ctx.householdId, ownerId, version],
  );
  if (deleted.rowCount) return { status: "applied", record: null };
  return resolveConflictOrGone(
    client,
    `SELECT ${REMINDER_SELECT_COLUMNS} FROM reminders
      WHERE id = $1 AND household_id = $2 AND (visibility = 'household' OR owner_id = $3)`,
    [id, ctx.householdId, ownerId],
    reminderRowToDto,
  );
}

async function execNoteCreate(client, ctx, payload) {
  const data = validateNoteCreatePayload(payload);
  const ownerId = resolveOwnerId(ctx);
  // See execTaskCreate's comment: a unique-violation aborts the transaction at the protocol level,
  // so the diagnostic SELECT below needs a savepoint rollback first or it would itself throw 25P02.
  await client.query("SAVEPOINT life_create");
  try {
    const inserted = await client.query(
      `INSERT INTO notes
         (id, household_id, owner_id, visibility, title, content, color, pinned, version, updated_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 1, $3)
       RETURNING ${NOTE_SELECT_COLUMNS}`,
      [
        data.id,
        ctx.householdId,
        ownerId,
        data.visibility,
        data.title,
        data.content,
        data.color,
        data.pinned,
      ],
    );
    return { status: "applied", record: noteRowToDto(inserted.rows[0]) };
  } catch (error) {
    if (error.code === "23505") {
      await client.query("ROLLBACK TO SAVEPOINT life_create");
      return resolveConflictOrError(
        client,
        `SELECT ${NOTE_SELECT_COLUMNS} FROM notes
          WHERE id = $1 AND household_id = $2 AND (visibility = 'household' OR owner_id = $3)`,
        [data.id, ctx.householdId, ownerId],
        noteRowToDto,
        "Identyfikator jest już używany",
        "ID_TAKEN",
        "ID_TAKEN",
      );
    }
    throw error;
  }
}

async function execNoteUpdate(client, ctx, payload, baseVersion) {
  const { id, changes, baseVersion: version } = validateNoteUpdatePayload(payload, baseVersion);
  const ownerId = resolveOwnerId(ctx);
  const updated = await client.query(
    `UPDATE notes
        SET title = COALESCE($1, title),
            content = COALESCE($2, content),
            color = COALESCE($3, color),
            pinned = COALESCE($4, pinned),
            visibility = COALESCE($5, visibility),
            version = version + 1,
            updated_at = now(),
            updated_by = $6
      WHERE id = $7 AND household_id = $8 AND version = $9
        AND (visibility = 'household' OR owner_id = $6)
      RETURNING ${NOTE_SELECT_COLUMNS}`,
    [
      changes.title ?? null,
      changes.content ?? null,
      changes.color ?? null,
      changes.pinned ?? null,
      changes.visibility ?? null,
      ownerId,
      id,
      ctx.householdId,
      version,
    ],
  );
  if (updated.rowCount) return { status: "applied", record: noteRowToDto(updated.rows[0]) };
  return resolveConflictOrError(
    client,
    `SELECT ${NOTE_SELECT_COLUMNS} FROM notes
      WHERE id = $1 AND household_id = $2 AND (visibility = 'household' OR owner_id = $3)`,
    [id, ctx.householdId, ownerId],
    noteRowToDto,
    "Rekord nie istnieje lub jest niedostępny",
    "NOT_FOUND",
  );
}

async function execNoteDelete(client, ctx, payload, baseVersion) {
  const { id } = validateDeleteIdPayload(payload);
  const ownerId = resolveOwnerId(ctx);
  const version = normalizeOptionalVersion(baseVersion);
  const deleted = await client.query(
    `DELETE FROM notes
      WHERE id = $1 AND household_id = $2 AND (visibility = 'household' OR owner_id = $3)
        AND ($4::integer IS NULL OR version = $4)
      RETURNING id`,
    [id, ctx.householdId, ownerId, version],
  );
  if (deleted.rowCount) return { status: "applied", record: null };
  return resolveConflictOrGone(
    client,
    `SELECT ${NOTE_SELECT_COLUMNS} FROM notes
      WHERE id = $1 AND household_id = $2 AND (visibility = 'household' OR owner_id = $3)`,
    [id, ctx.householdId, ownerId],
    noteRowToDto,
  );
}

async function execHabitCreate(client, ctx, payload) {
  const data = validateHabitCreatePayload(payload);
  const ownerId = resolveOwnerId(ctx);
  // See execTaskCreate's comment: a unique-violation aborts the transaction at the protocol level,
  // so the diagnostic SELECT below needs a savepoint rollback first or it would itself throw 25P02.
  await client.query("SAVEPOINT life_create");
  try {
    const inserted = await client.query(
      `INSERT INTO habits
         (id, household_id, owner_id, visibility, name, icon, target_label, completed_dates,
          version, updated_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, 1, $3)
       RETURNING ${HABIT_SELECT_COLUMNS}`,
      [
        data.id,
        ctx.householdId,
        ownerId,
        data.visibility,
        data.name,
        data.icon,
        data.targetLabel,
        JSON.stringify(data.completedDates),
      ],
    );
    return { status: "applied", record: habitRowToDto(inserted.rows[0]) };
  } catch (error) {
    if (error.code === "23505") {
      await client.query("ROLLBACK TO SAVEPOINT life_create");
      return resolveConflictOrError(
        client,
        `SELECT ${HABIT_SELECT_COLUMNS} FROM habits
          WHERE id = $1 AND household_id = $2 AND (visibility = 'household' OR owner_id = $3)`,
        [data.id, ctx.householdId, ownerId],
        habitRowToDto,
        "Identyfikator jest już używany",
        "ID_TAKEN",
        "ID_TAKEN",
      );
    }
    throw error;
  }
}

async function execHabitUpdate(client, ctx, payload, baseVersion) {
  const { id, changes, baseVersion: version } = validateHabitUpdatePayload(payload, baseVersion);
  const ownerId = resolveOwnerId(ctx);
  const hasCompletedDates = Object.prototype.hasOwnProperty.call(changes, "completedDates");
  const updated = await client.query(
    `UPDATE habits
        SET name = COALESCE($1, name),
            icon = COALESCE($2, icon),
            target_label = COALESCE($3, target_label),
            completed_dates = COALESCE($4::jsonb, completed_dates),
            visibility = COALESCE($5, visibility),
            version = version + 1,
            updated_at = now(),
            updated_by = $6
      WHERE id = $7 AND household_id = $8 AND version = $9
        AND (visibility = 'household' OR owner_id = $6)
      RETURNING ${HABIT_SELECT_COLUMNS}`,
    [
      changes.name ?? null,
      changes.icon ?? null,
      changes.targetLabel ?? null,
      hasCompletedDates ? JSON.stringify(changes.completedDates) : null,
      changes.visibility ?? null,
      ownerId,
      id,
      ctx.householdId,
      version,
    ],
  );
  if (updated.rowCount) return { status: "applied", record: habitRowToDto(updated.rows[0]) };
  return resolveConflictOrError(
    client,
    `SELECT ${HABIT_SELECT_COLUMNS} FROM habits
      WHERE id = $1 AND household_id = $2 AND (visibility = 'household' OR owner_id = $3)`,
    [id, ctx.householdId, ownerId],
    habitRowToDto,
    "Rekord nie istnieje lub jest niedostępny",
    "NOT_FOUND",
  );
}

async function execHabitDelete(client, ctx, payload, baseVersion) {
  const { id } = validateDeleteIdPayload(payload);
  const ownerId = resolveOwnerId(ctx);
  const version = normalizeOptionalVersion(baseVersion);
  const deleted = await client.query(
    `DELETE FROM habits
      WHERE id = $1 AND household_id = $2 AND (visibility = 'household' OR owner_id = $3)
        AND ($4::integer IS NULL OR version = $4)
      RETURNING id`,
    [id, ctx.householdId, ownerId, version],
  );
  if (deleted.rowCount) return { status: "applied", record: null };
  return resolveConflictOrGone(
    client,
    `SELECT ${HABIT_SELECT_COLUMNS} FROM habits
      WHERE id = $1 AND household_id = $2 AND (visibility = 'household' OR owner_id = $3)`,
    [id, ctx.householdId, ownerId],
    habitRowToDto,
  );
}

async function executeLifeOp(client, ctx, op, payload, baseVersion) {
  switch (op) {
    case "task.create":
      return execTaskCreate(client, ctx, payload);
    case "task.update":
      return execTaskUpdate(client, ctx, payload, baseVersion);
    case "task.delete":
      return execTaskDelete(client, ctx, payload, baseVersion);
    case "event.create":
      return execEventCreate(client, ctx, payload);
    case "event.update":
      return execEventUpdate(client, ctx, payload, baseVersion);
    case "event.delete":
      return execEventDelete(client, ctx, payload, baseVersion);
    case "reminder.create":
      return execReminderCreate(client, ctx, payload);
    case "reminder.update":
      return execReminderUpdate(client, ctx, payload, baseVersion);
    case "reminder.delete":
      return execReminderDelete(client, ctx, payload, baseVersion);
    case "note.create":
      return execNoteCreate(client, ctx, payload);
    case "note.update":
      return execNoteUpdate(client, ctx, payload, baseVersion);
    case "note.delete":
      return execNoteDelete(client, ctx, payload, baseVersion);
    case "habit.create":
      return execHabitCreate(client, ctx, payload);
    case "habit.update":
      return execHabitUpdate(client, ctx, payload, baseVersion);
    case "habit.delete":
      return execHabitDelete(client, ctx, payload, baseVersion);
    default:
      // Unreachable when called through applyLifeMutation (assertLifeMutationShape already
      // rejected unknown ops at the request level); kept defensive in case of direct unit-test
      // calls.
      throw new LifeValidationError(`Nieobsługiwana operacja: ${op}`, "UNSUPPORTED_OP");
  }
}

// ---------------------------------------------------------------------------
// Idempotent mutation entry point. `mutation` is assumed to already have passed
// assertLifeMutationShape (server.mjs validates the whole batch upfront). ctx = { householdId,
// userId } always comes from the authenticated session, never from the request body.
// ---------------------------------------------------------------------------

export async function applyLifeMutation(client, ctx, mutation) {
  const { idempotencyKey, op, payload, baseVersion } = mutation;

  // Claim the idempotency key first, inside the same DB transaction as the operation itself: if
  // the op below throws, the whole transaction (including this claim) rolls back, so the key
  // remains free to retry. If a row already existed, this was a retry -- return the previously
  // stored result instead of running the operation again.
  const claim = await client.query(
    `INSERT INTO life_mutations (idempotency_key, household_id, user_id, op, result)
     VALUES ($1, $2, $3, $4, '{}'::jsonb)
     ON CONFLICT (idempotency_key) DO NOTHING`,
    [idempotencyKey, ctx.householdId, ctx.userId, op],
  );
  if (!claim.rowCount) {
    const existing = await client.query(
      `SELECT result FROM life_mutations WHERE idempotency_key = $1`,
      [idempotencyKey],
    );
    return existing.rows[0]?.result ?? { idempotencyKey, status: "duplicate" };
  }

  let outcome;
  try {
    outcome = await executeLifeOp(client, ctx, op, payload, baseVersion);
  } catch (error) {
    if (error instanceof LifeValidationError) {
      outcome = { status: "error", error: error.message, code: error.code };
    } else {
      throw error;
    }
  }

  const result = { idempotencyKey, ...outcome };
  await client.query(`UPDATE life_mutations SET result = $1::jsonb WHERE idempotency_key = $2`, [
    JSON.stringify(result),
    idempotencyKey,
  ]);
  return result;
}
