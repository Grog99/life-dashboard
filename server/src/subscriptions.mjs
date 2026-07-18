// Domain layer for the normalized Subscriptions (Subskrypcje) module.
//
// Data model: server/migrations/012_subscriptions_normalized.sql (subscriptions,
// subscription_mutations). Design source of truth: docs/plans/subskrypcje-sql.md ("Podejście"
// section, "Backend" file entry).
//
// This is the SIMPLEST module in the whole normalized series (docs/plans/subskrypcje-sql.md "Czym
// Subskrypcje są PROSTSZE od Zdrowia/Zwierząt"): ONE flat table, no parent/child relations at all
// (unlike pets.mjs's three tables or health.mjs's three tables), no visibility cascade (no
// children to cascade to), no visibility inheritance on create (every `subscription.create`
// carries an EXPLICIT `visibility`), no aggregate/monotonic field (every update uses per-record
// OCC, no exceptions), no special fields (no free-form timestamp, no real toggle -- `renew`/
// `togglePause` are plain `subscription.update` calls with client-computed absolute values). The
// only nullable/optional field is `cancelUrl`, handled with the same `hasOwnProperty`
// nullable-clears-column pattern pets.mjs/health.mjs use for `species`/`notes`.
//
// Like health.mjs/pets.mjs/car.mjs/finance.mjs/trips.mjs, this module intentionally does NOT
// import the zod schemas from src/lib/schema.ts: the server package has no TypeScript build step
// and no zod dependency. The validators below hand-roll the same rules as `subscriptionSchema` in
// src/lib/schema.ts, scoped to the subset of fields a mutation payload carries.
//
// Every exported function here is either pure (validators, resolveOwnerId,
// resolveVersionConflict, row->DTO mapper) or takes an already-connected `client` (a pg
// PoolClient, or the shared `pool` from db.mjs) so it can run either inside a transaction() or
// directly against the pool.

export class SubscriptionValidationError extends Error {
  constructor(message, code = "VALIDATION_ERROR") {
    super(message);
    this.name = "SubscriptionValidationError";
    this.code = code;
  }
}

function subscriptionRequestError(statusCode, message, code) {
  const error = new Error(message);
  error.statusCode = statusCode;
  error.code = code;
  return error;
}

// ---------------------------------------------------------------------------
// Primitive validators (mirror src/lib/schema.ts / src/subscriptionsTypes.ts)
// ---------------------------------------------------------------------------

const ID_MAX_LENGTH = 200;
const VISIBILITIES = new Set(["private", "household"]);
const CURRENCIES = new Set(["PLN", "EUR", "USD", "GBP"]);
const CYCLES = new Set(["monthly", "quarterly", "yearly"]);
const STATUSES = new Set(["active", "trial", "paused", "cancelled"]);
const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CANCEL_URL_MAX_LENGTH = 2000;

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

// Wzór `z.string().url()` z src/lib/schema.ts -- wymaga parsowalnego URL-a z protokołem
// http/https (odrzuca np. `javascript:`), cap 2000 znaków (kolumna `cancel_url text`).
function isCancelUrl(value) {
  if (typeof value !== "string" || value.length === 0 || value.length > CANCEL_URL_MAX_LENGTH) {
    return false;
  }
  try {
    const parsed = new URL(value);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

function isSafeMoney(value) {
  return typeof value === "number" && Number.isSafeInteger(value);
}

function isReminderDays(value) {
  return Number.isInteger(value) && value >= 0 && value <= 365;
}

// Normalizes an optional/nullable text field to either a trimmed non-empty string or null (the
// column is nullable, matching how the migration writes `NULLIF(rec->>'…', '')`).
function normalizeOptionalText(value) {
  if (value === undefined || value === null) return null;
  const trimmed = String(value).trim();
  return trimmed.length ? trimmed : null;
}

function assertShape(condition, message, code) {
  if (!condition) throw new SubscriptionValidationError(message, code);
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
// health.mjs/pets.mjs). The authoritative check always happens in SQL (`WHERE version =
// $baseVersion`).
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
// Row -> DTO mapping (snake_case columns -> the Subscription shape in src/subscriptionsTypes.ts).
// `next_payment` is cast to text in SQL (`::text`) to dodge node-postgres's local-timezone Date
// parsing; `amount_minor` (bigint) comes back as a string from node-postgres and is coerced with
// `Number()` (parity with car.mjs/health.mjs's bigint columns); `updated_at` (timestamptz) is safe
// to read as a JS Date and converted with `.toISOString()`.
// ---------------------------------------------------------------------------

export function subscriptionRowToDto(row) {
  return {
    id: row.id,
    ownerId: row.owner_id,
    visibility: row.visibility,
    name: row.name,
    category: row.category,
    amountMinor: Number(row.amount_minor),
    currency: row.currency,
    cycle: row.cycle,
    nextPayment: row.next_payment,
    payer: row.payer,
    status: row.status,
    reminderDays: row.reminder_days,
    color: row.color,
    cancelUrl: row.cancel_url ?? undefined,
    version: row.version,
    updatedAt: row.updated_at.toISOString(),
  };
}

const SUBSCRIPTION_SELECT_COLUMNS =
  "id, owner_id, visibility, name, category, amount_minor, currency, cycle, " +
  "next_payment::text AS next_payment, payer, status, reminder_days, color, cancel_url, " +
  "version, updated_at";

// ---------------------------------------------------------------------------
// Payload validators per mutation `op`. Each returns a normalized object built only from
// allow-listed fields (never passing through unknown keys), or throws
// SubscriptionValidationError. `ownerId`, if present in a payload, is always ignored by the
// caller (see resolveOwnerId) -- these validators don't even read it.
// ---------------------------------------------------------------------------

export function validateSubscriptionCreatePayload(payload) {
  assertShape(isPlainObject(payload), "Nieprawidłowy ładunek mutacji", "INVALID_PAYLOAD");
  assertShape(isId(payload.id), "Nieprawidłowy identyfikator subskrypcji", "INVALID_ID");
  assertShape(isNonEmptyText(payload.name, 500), "Nieprawidłowa nazwa subskrypcji", "INVALID_NAME");
  assertShape(isNonEmptyText(payload.category, 500), "Nieprawidłowa kategoria", "INVALID_CATEGORY");
  assertShape(
    isSafeMoney(payload.amountMinor) && payload.amountMinor >= 0,
    "Nieprawidłowa kwota",
    "INVALID_AMOUNT",
  );
  assertShape(CURRENCIES.has(payload.currency), "Nieprawidłowa waluta", "INVALID_CURRENCY");
  assertShape(CYCLES.has(payload.cycle), "Nieprawidłowy cykl płatności", "INVALID_CYCLE");
  assertShape(
    isIsoDate(payload.nextPayment),
    "Nieprawidłowa data następnej płatności",
    "INVALID_NEXT_PAYMENT",
  );
  assertShape(isOptionalText(payload.payer, 200), "Nieprawidłowy płatnik", "INVALID_PAYER");
  assertShape(STATUSES.has(payload.status), "Nieprawidłowy status subskrypcji", "INVALID_STATUS");
  assertShape(
    isReminderDays(payload.reminderDays),
    "Nieprawidłowa liczba dni przypomnienia",
    "INVALID_REMINDER_DAYS",
  );
  assertShape(isOptionalText(payload.color, 32), "Nieprawidłowy kolor", "INVALID_COLOR");
  if (payload.cancelUrl !== undefined && payload.cancelUrl !== null) {
    assertShape(
      isCancelUrl(payload.cancelUrl),
      "Nieprawidłowy adres URL anulowania",
      "INVALID_CANCEL_URL",
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
    category: payload.category.trim(),
    amountMinor: payload.amountMinor,
    currency: payload.currency,
    cycle: payload.cycle,
    nextPayment: payload.nextPayment,
    payer: payload.payer,
    status: payload.status,
    reminderDays: payload.reminderDays,
    color: payload.color,
    cancelUrl: normalizeOptionalText(payload.cancelUrl),
    visibility: payload.visibility,
  };
}

// `visibility` IS in the update key set (docs/plans/subskrypcje-sql.md "Ryzyka": modal edycji
// subskrypcji pozwala zmienić `visibility` po utworzeniu -- pominięcie tu byłoby regresją, tej
// samej klasy błędu co luka #1 z "Status po wdrożeniu" Finansów). `renew`/`togglePause`
// (SubscriptionsPage.tsx) liczą absolutne nowe wartości lokalnie i wysyłają je jako `changes`
// (`{ nextPayment, status }` / `{ status }`) przez ten sam op -- to nie prawdziwe toggle, tylko
// zwykłe update-y z policzoną zmianą (brak hazardu podwójnego flipu).
const SUBSCRIPTION_UPDATE_KEYS = new Set([
  "name",
  "category",
  "amountMinor",
  "currency",
  "cycle",
  "nextPayment",
  "payer",
  "status",
  "reminderDays",
  "color",
  "cancelUrl",
  "visibility",
]);

export function validateSubscriptionUpdatePayload(payload, baseVersion) {
  assertShape(isPlainObject(payload), "Nieprawidłowy ładunek mutacji", "INVALID_PAYLOAD");
  assertShape(isId(payload.id), "Nieprawidłowy identyfikator subskrypcji", "INVALID_ID");
  assertShape(isPlainObject(payload.changes), "Brak zmian do zastosowania", "INVALID_CHANGES");
  for (const key of Object.keys(payload.changes)) {
    assertShape(
      SUBSCRIPTION_UPDATE_KEYS.has(key),
      `Pola "${key}" nie można edytować`,
      "INVALID_CHANGES",
    );
  }
  const version = normalizeRequiredVersion(baseVersion);
  const changes = {};
  const c = payload.changes;
  if (c.name !== undefined) {
    assertShape(isNonEmptyText(c.name, 500), "Nieprawidłowa nazwa subskrypcji", "INVALID_NAME");
    changes.name = c.name.trim();
  }
  if (c.category !== undefined) {
    assertShape(isNonEmptyText(c.category, 500), "Nieprawidłowa kategoria", "INVALID_CATEGORY");
    changes.category = c.category.trim();
  }
  if (c.amountMinor !== undefined) {
    assertShape(
      isSafeMoney(c.amountMinor) && c.amountMinor >= 0,
      "Nieprawidłowa kwota",
      "INVALID_AMOUNT",
    );
    changes.amountMinor = c.amountMinor;
  }
  if (c.currency !== undefined) {
    assertShape(CURRENCIES.has(c.currency), "Nieprawidłowa waluta", "INVALID_CURRENCY");
    changes.currency = c.currency;
  }
  if (c.cycle !== undefined) {
    assertShape(CYCLES.has(c.cycle), "Nieprawidłowy cykl płatności", "INVALID_CYCLE");
    changes.cycle = c.cycle;
  }
  if (c.nextPayment !== undefined) {
    assertShape(
      isIsoDate(c.nextPayment),
      "Nieprawidłowa data następnej płatności",
      "INVALID_NEXT_PAYMENT",
    );
    changes.nextPayment = c.nextPayment;
  }
  if (c.payer !== undefined) {
    assertShape(isOptionalText(c.payer, 200), "Nieprawidłowy płatnik", "INVALID_PAYER");
    changes.payer = c.payer;
  }
  if (c.status !== undefined) {
    assertShape(STATUSES.has(c.status), "Nieprawidłowy status subskrypcji", "INVALID_STATUS");
    changes.status = c.status;
  }
  if (c.reminderDays !== undefined) {
    assertShape(
      isReminderDays(c.reminderDays),
      "Nieprawidłowa liczba dni przypomnienia",
      "INVALID_REMINDER_DAYS",
    );
    changes.reminderDays = c.reminderDays;
  }
  if (c.color !== undefined) {
    assertShape(isOptionalText(c.color, 32), "Nieprawidłowy kolor", "INVALID_COLOR");
    changes.color = c.color;
  }
  // `cancelUrl` is nullable and cleared with `null`/omission (hasOwnProperty pattern, wzór
  // `species`/`notes` w pets.mjs/health.mjs).
  if (Object.prototype.hasOwnProperty.call(c, "cancelUrl")) {
    assertShape(
      c.cancelUrl === null || isCancelUrl(c.cancelUrl),
      "Nieprawidłowy adres URL anulowania",
      "INVALID_CANCEL_URL",
    );
    changes.cancelUrl = normalizeOptionalText(c.cancelUrl);
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

// ---------------------------------------------------------------------------
// Mutation envelope + supported ops
// ---------------------------------------------------------------------------

export const SUPPORTED_SUBSCRIPTION_OPS = new Set([
  "subscription.create",
  "subscription.update",
  "subscription.delete",
]);

// Whole-request-shape validation, mirroring assertHealthMutationShape/assertPetsMutationShape:
// called once per mutation BEFORE any DB work starts, so a malformed entry anywhere in the batch
// is rejected as a single 400 rather than silently corrupting bookkeeping for its siblings.
// Per-mutation *business* validation (bad field values, missing record, ...) is reported as
// `status: "error"` inside `results` by applySubscriptionMutation instead.
export function assertSubscriptionMutationShape(mutation) {
  if (!isPlainObject(mutation)) {
    throw subscriptionRequestError(
      400,
      "Nieprawidłowy kształt mutacji",
      "INVALID_SUBSCRIPTION_MUTATION",
    );
  }
  if (typeof mutation.idempotencyKey !== "string" || !UUID_PATTERN.test(mutation.idempotencyKey)) {
    throw subscriptionRequestError(
      400,
      "Nieprawidłowy klucz idempotencji",
      "INVALID_IDEMPOTENCY_KEY",
    );
  }
  if (typeof mutation.op !== "string" || !SUPPORTED_SUBSCRIPTION_OPS.has(mutation.op)) {
    throw subscriptionRequestError(400, "Nieobsługiwana operacja mutacji", "UNSUPPORTED_OP");
  }
  if (!isPlainObject(mutation.payload)) {
    throw subscriptionRequestError(400, "Brak danych mutacji", "INVALID_SUBSCRIPTION_MUTATION");
  }
  if (
    mutation.baseVersion !== undefined &&
    mutation.baseVersion !== null &&
    !Number.isInteger(mutation.baseVersion)
  ) {
    throw subscriptionRequestError(
      400,
      "Nieprawidłowa wersja bazowa mutacji",
      "INVALID_SUBSCRIPTION_MUTATION",
    );
  }
}

export const MAX_SUBSCRIPTION_MUTATIONS_PER_BATCH = Number(
  process.env.MAX_SUBSCRIPTION_MUTATIONS ?? 500,
);
export const MAX_SUBSCRIPTION_MUTATIONS_BYTES = Number(
  process.env.MAX_SUBSCRIPTION_MUTATIONS_BYTES ?? 2_000_000,
);

// ---------------------------------------------------------------------------
// Snapshot read (GET /api/v1/subscriptions): household-wide records + the caller's own private
// records (wzór readHealthSnapshot/readPetsSnapshot). Sorted by `next_payment` -- parytet z
// dzisiejszym sortem listy (SubscriptionsPage.tsx).
// ---------------------------------------------------------------------------

export async function readSubscriptionsSnapshot(client, householdId, userId) {
  const subscriptions = await client.query(
    `SELECT ${SUBSCRIPTION_SELECT_COLUMNS} FROM subscriptions
      WHERE household_id = $1 AND (visibility = 'household' OR owner_id = $2)
      ORDER BY next_payment`,
    [householdId, userId],
  );
  return { subscriptions: subscriptions.rows.map(subscriptionRowToDto) };
}

// Wspiera "Wyczyść dane aplikacji" (SettingsPage.tsx danger zone). Wzór resetHealthForUser/
// resetPetsForUser: usuwa wszystko wspólne (`visibility = 'household'`) plus WYŁĄCZNIE prywatne
// rekordy wywołującego użytkownika (`owner_id = userId`) w danym gospodarstwie -- NIE bezwarunkowy
// reset gospodarstwa jak w trips/meals, bo Subskrypcje mają rekordy prywatne. Prywatne rekordy
// innych domowników zostają nietknięte.
export async function resetSubscriptionsForUser(client, householdId, userId) {
  await client.query(
    `DELETE FROM subscriptions
      WHERE household_id = $1 AND (visibility = 'household' OR owner_id = $2)`,
    [householdId, userId],
  );
}

// ---------------------------------------------------------------------------
// Shared OCC/conflict resolution helpers used by every update/delete op (mirrors health.mjs/
// pets.mjs). The lookup query MUST carry the same household/visibility scoping as the write it's
// diagnosing -- otherwise this could leak the existence or content of another user's private
// record through the "current record" in a conflict response (docs/plans/subskrypcje-sql.md
// "Bezpieczeństwo scope'u widoczności").
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
// by assertSubscriptionMutationShape; they still run their own (business-rule) validators and
// throw SubscriptionValidationError on bad input, which applySubscriptionMutation turns into
// `status: "error"`.
// ---------------------------------------------------------------------------

async function execSubscriptionCreate(client, ctx, payload) {
  const data = validateSubscriptionCreatePayload(payload);
  const ownerId = resolveOwnerId(ctx);
  try {
    const inserted = await client.query(
      `INSERT INTO subscriptions
         (id, household_id, owner_id, visibility, name, category, amount_minor, currency, cycle,
          next_payment, payer, status, reminder_days, color, cancel_url, version, updated_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::date, $11, $12, $13, $14, $15, 1, $3)
       RETURNING ${SUBSCRIPTION_SELECT_COLUMNS}`,
      [
        data.id,
        ctx.householdId,
        ownerId,
        data.visibility,
        data.name,
        data.category,
        data.amountMinor,
        data.currency,
        data.cycle,
        data.nextPayment,
        data.payer,
        data.status,
        data.reminderDays,
        data.color,
        data.cancelUrl,
      ],
    );
    return { status: "applied", record: subscriptionRowToDto(inserted.rows[0]) };
  } catch (error) {
    if (error.code === "23505") {
      return resolveConflictOrError(
        client,
        `SELECT ${SUBSCRIPTION_SELECT_COLUMNS} FROM subscriptions
          WHERE id = $1 AND household_id = $2 AND (visibility = 'household' OR owner_id = $3)`,
        [data.id, ctx.householdId, ownerId],
        subscriptionRowToDto,
        "Identyfikator jest już używany",
        "ID_TAKEN",
      );
    }
    throw error;
  }
}

async function execSubscriptionUpdate(client, ctx, payload, baseVersion) {
  const {
    id,
    changes,
    baseVersion: version,
  } = validateSubscriptionUpdatePayload(payload, baseVersion);
  const ownerId = resolveOwnerId(ctx);
  const hasCancelUrl = Object.prototype.hasOwnProperty.call(changes, "cancelUrl");
  const updated = await client.query(
    `UPDATE subscriptions
        SET name = COALESCE($1, name),
            category = COALESCE($2, category),
            amount_minor = COALESCE($3, amount_minor),
            currency = COALESCE($4, currency),
            cycle = COALESCE($5, cycle),
            next_payment = COALESCE($6::date, next_payment),
            payer = COALESCE($7, payer),
            status = COALESCE($8, status),
            reminder_days = COALESCE($9, reminder_days),
            color = COALESCE($10, color),
            cancel_url = CASE WHEN $11 THEN $12 ELSE cancel_url END,
            visibility = COALESCE($13, visibility),
            version = version + 1,
            updated_at = now(),
            updated_by = $14
      WHERE id = $15 AND household_id = $16 AND version = $17
        AND (visibility = 'household' OR owner_id = $14)
      RETURNING ${SUBSCRIPTION_SELECT_COLUMNS}`,
    [
      changes.name ?? null,
      changes.category ?? null,
      changes.amountMinor ?? null,
      changes.currency ?? null,
      changes.cycle ?? null,
      changes.nextPayment ?? null,
      changes.payer ?? null,
      changes.status ?? null,
      changes.reminderDays ?? null,
      changes.color ?? null,
      hasCancelUrl,
      hasCancelUrl ? changes.cancelUrl : null,
      changes.visibility ?? null,
      ownerId,
      id,
      ctx.householdId,
      version,
    ],
  );
  if (updated.rowCount) {
    return { status: "applied", record: subscriptionRowToDto(updated.rows[0]) };
  }
  return resolveConflictOrError(
    client,
    `SELECT ${SUBSCRIPTION_SELECT_COLUMNS} FROM subscriptions
      WHERE id = $1 AND household_id = $2 AND (visibility = 'household' OR owner_id = $3)`,
    [id, ctx.householdId, ownerId],
    subscriptionRowToDto,
    "Rekord nie istnieje lub jest niedostępny",
    "NOT_FOUND",
  );
}

async function execSubscriptionDelete(client, ctx, payload, baseVersion) {
  const { id } = validateDeleteIdPayload(payload);
  const ownerId = resolveOwnerId(ctx);
  const version = normalizeOptionalVersion(baseVersion);
  const deleted = await client.query(
    `DELETE FROM subscriptions
      WHERE id = $1 AND household_id = $2 AND (visibility = 'household' OR owner_id = $3)
        AND ($4::integer IS NULL OR version = $4)
      RETURNING id`,
    [id, ctx.householdId, ownerId, version],
  );
  if (deleted.rowCount) return { status: "applied", record: null };
  return resolveConflictOrGone(
    client,
    `SELECT ${SUBSCRIPTION_SELECT_COLUMNS} FROM subscriptions
      WHERE id = $1 AND household_id = $2 AND (visibility = 'household' OR owner_id = $3)`,
    [id, ctx.householdId, ownerId],
    subscriptionRowToDto,
  );
}

async function executeSubscriptionOp(client, ctx, op, payload, baseVersion) {
  switch (op) {
    case "subscription.create":
      return execSubscriptionCreate(client, ctx, payload);
    case "subscription.update":
      return execSubscriptionUpdate(client, ctx, payload, baseVersion);
    case "subscription.delete":
      return execSubscriptionDelete(client, ctx, payload, baseVersion);
    default:
      // Unreachable when called through applySubscriptionMutation
      // (assertSubscriptionMutationShape already rejected unknown ops at the request level); kept
      // defensive in case of direct unit-test calls.
      throw new SubscriptionValidationError(`Nieobsługiwana operacja: ${op}`, "UNSUPPORTED_OP");
  }
}

// ---------------------------------------------------------------------------
// Idempotent mutation entry point. `mutation` is assumed to already have passed
// assertSubscriptionMutationShape (server.mjs validates the whole batch upfront). ctx =
// { householdId, userId } always comes from the authenticated session, never from the request
// body.
// ---------------------------------------------------------------------------

export async function applySubscriptionMutation(client, ctx, mutation) {
  const { idempotencyKey, op, payload, baseVersion } = mutation;

  // Claim the idempotency key first, inside the same DB transaction as the operation itself: if
  // the op below throws, the whole transaction (including this claim) rolls back, so the key
  // remains free to retry. If a row already existed, this was a retry -- return the previously
  // stored result instead of running the operation again.
  const claim = await client.query(
    `INSERT INTO subscription_mutations (idempotency_key, household_id, user_id, op, result)
     VALUES ($1, $2, $3, $4, '{}'::jsonb)
     ON CONFLICT (idempotency_key) DO NOTHING`,
    [idempotencyKey, ctx.householdId, ctx.userId, op],
  );
  if (!claim.rowCount) {
    const existing = await client.query(
      `SELECT result FROM subscription_mutations WHERE idempotency_key = $1`,
      [idempotencyKey],
    );
    return existing.rows[0]?.result ?? { idempotencyKey, status: "duplicate" };
  }

  let outcome;
  try {
    outcome = await executeSubscriptionOp(client, ctx, op, payload, baseVersion);
  } catch (error) {
    if (error instanceof SubscriptionValidationError) {
      outcome = { status: "error", error: error.message, code: error.code };
    } else {
      throw error;
    }
  }

  const result = { idempotencyKey, ...outcome };
  await client.query(
    `UPDATE subscription_mutations SET result = $1::jsonb WHERE idempotency_key = $2`,
    [JSON.stringify(result), idempotencyKey],
  );
  return result;
}
