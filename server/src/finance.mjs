// Domain layer for the normalized Finance module.
//
// Data model: server/migrations/006_finance_normalized.sql (finance_accounts, finance_transactions,
// finance_budgets, finance_goals, finance_mutations). Design source of truth:
// docs/plans/model-synchronizacji-danych.md ("Podejście" section).
//
// This module intentionally does NOT import the zod schemas from src/lib/schema.ts: workspace.mjs
// (the closest existing precedent for server-side validation of client-shaped data) does not import
// from src/ either -- the server package has no TypeScript build step and no zod dependency. Instead,
// the validators below hand-roll the exact same rules as `financeAccountSchema`/`financeTransactionSchema`/
// `financeBudgetSchema`/`savingsGoalSchema` in src/lib/schema.ts, scoped to the subset of fields a
// mutation payload carries -- `id` is client-generated (crypto.randomUUID()) and included, but
// `version`/`updatedAt` are always assigned by the server.
//
// Every exported function here is either pure (validators, resolveVersionConflict, resolveOwnerId,
// resolveTransactionVisibility, row->DTO mappers) or takes an already-connected `client` (a pg
// PoolClient, or the shared `pool` from db.mjs -- both expose `.query(text, params)`) so it can run
// either inside a transaction() or directly against the pool, exactly like workspace.mjs's functions.

export class FinanceValidationError extends Error {
  constructor(message, code = "VALIDATION_ERROR") {
    super(message);
    this.name = "FinanceValidationError";
    this.code = code;
  }
}

function financeRequestError(statusCode, message, code) {
  const error = new Error(message);
  error.statusCode = statusCode;
  error.code = code;
  return error;
}

// ---------------------------------------------------------------------------
// Primitive validators (mirror src/lib/schema.ts: idSchema, currencySchema, safeMoney, isoDate, ...)
// ---------------------------------------------------------------------------

const ID_MAX_LENGTH = 200;
const CURRENCIES = new Set(["PLN", "EUR", "USD", "GBP"]);
const ACCOUNT_TYPES = new Set(["checking", "savings", "cash", "credit"]);
const TRANSACTION_SOURCES = new Set(["manual", "csv", "subscription", "trip", "car"]);
const VISIBILITIES = new Set(["private", "household"]);
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

function assertShape(condition, message, code) {
  if (!condition) throw new FinanceValidationError(message, code);
}

// Mirrors FinancePage.tsx's `normalizeCategoryName` exactly: budget category uniqueness ignores
// currency by design (docs/KNOWN_ISSUES.md #4), and no DB uniqueness constraint was added on purpose
// (server/migrations/006_finance_normalized.sql). Keeping the same JS locale-aware comparison instead
// of a SQL `lower()` avoids any Postgres-collation vs. V8-locale mismatch for Polish diacritics.
export function normalizeCategoryName(value) {
  return String(value ?? "")
    .trim()
    .toLocaleLowerCase("pl");
}

// ---------------------------------------------------------------------------
// Security invariants (docs/ARCHITECTURE.md "Dane wspólne i prywatne")
// ---------------------------------------------------------------------------

// owner_id is always derived from the authenticated session -- a client-supplied ownerId in the
// mutation payload (if present) is always ignored. This is the single choke point that enforces it.
export function resolveOwnerId(ctx) {
  return ctx.userId;
}

// transaction.create without an explicit visibility inherits it from the parent account (today's UI
// behavior, preserved 1:1 -- see docs/plans/model-synchronizacji-danych.md "Odróżnianie prywatne/wspólne").
export function resolveTransactionVisibility(payloadVisibility, accountVisibility) {
  return payloadVisibility === "private" || payloadVisibility === "household"
    ? payloadVisibility
    : accountVisibility;
}

// Pure helper naming the core OCC decision explicitly (docs/plans/model-synchronizacji-danych.md
// "Wersjonowanie i saldo"): true when the client's assumed version still matches the stored one, i.e.
// no conflict. The authoritative check always happens in SQL (`WHERE version = $baseVersion`); this
// function exists so the decision itself is unit-testable in isolation.
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
// Row -> DTO mapping (snake_case columns -> the FinanceAccount/FinanceTransaction/FinanceBudget/
// SavingsGoal shapes in src/financeTypes.ts). `bigint` columns come back from node-postgres as
// strings (to avoid precision loss), so they're explicitly coerced with Number(); `date` columns are
// cast to text in SQL (`::text`) to avoid node-postgres's local-timezone Date parsing of DATE columns;
// `timestamptz` columns are safe to read as JS Date objects and converted with `.toISOString()`.
// ---------------------------------------------------------------------------

export function accountRowToDto(row) {
  return {
    id: row.id,
    ownerId: row.owner_id,
    visibility: row.visibility,
    name: row.name,
    type: row.type,
    balanceMinor: Number(row.balance_minor),
    currency: row.currency,
    color: row.color,
    archived: row.archived,
    version: row.version,
    updatedAt: row.updated_at.toISOString(),
  };
}

export function transactionRowToDto(row) {
  return {
    id: row.id,
    ownerId: row.owner_id,
    visibility: row.visibility,
    accountId: row.account_id,
    bookedOn: row.booked_on,
    amountMinor: Number(row.amount_minor),
    currency: row.currency,
    merchant: row.merchant,
    title: row.title,
    category: row.category,
    source: row.source,
    fingerprint: row.fingerprint ?? undefined,
    notes: row.notes ?? undefined,
    version: row.version,
    updatedAt: row.updated_at.toISOString(),
  };
}

export function budgetRowToDto(row) {
  return {
    id: row.id,
    category: row.category,
    limitMinor: Number(row.limit_minor),
    currency: row.currency,
    color: row.color,
    version: row.version,
    updatedAt: row.updated_at.toISOString(),
  };
}

export function goalRowToDto(row) {
  return {
    id: row.id,
    ownerId: row.owner_id,
    visibility: row.visibility,
    name: row.name,
    targetMinor: Number(row.target_minor),
    savedMinor: Number(row.saved_minor),
    currency: row.currency,
    deadline: row.deadline ?? undefined,
    version: row.version,
    updatedAt: row.updated_at.toISOString(),
  };
}

const ACCOUNT_SELECT_COLUMNS =
  "id, owner_id, visibility, name, type, balance_minor, currency, color, archived, version, updated_at";
const TRANSACTION_SELECT_COLUMNS =
  "id, owner_id, visibility, account_id, booked_on::text AS booked_on, amount_minor, currency, " +
  "merchant, title, category, source, fingerprint, notes, version, updated_at";
const BUDGET_SELECT_COLUMNS = "id, category, limit_minor, currency, color, version, updated_at";
const GOAL_SELECT_COLUMNS =
  "id, owner_id, visibility, name, target_minor, saved_minor, currency, deadline::text AS deadline, " +
  "version, updated_at";

// ---------------------------------------------------------------------------
// Payload validators per mutation `op`. Each returns a normalized object built only from allow-listed
// fields (never passing through unknown keys), or throws FinanceValidationError. `ownerId`, if present
// in a payload, is always ignored by the caller (see resolveOwnerId) -- these validators don't even
// read it.
// ---------------------------------------------------------------------------

export function validateAccountCreatePayload(payload) {
  assertShape(isPlainObject(payload), "Nieprawidłowy ładunek mutacji", "INVALID_PAYLOAD");
  assertShape(isId(payload.id), "Nieprawidłowy identyfikator konta", "INVALID_ID");
  assertShape(isNonEmptyText(payload.name, 500), "Nieprawidłowa nazwa konta", "INVALID_NAME");
  assertShape(ACCOUNT_TYPES.has(payload.type), "Nieprawidłowy typ konta", "INVALID_TYPE");
  assertShape(
    isSafeMoney(payload.balanceMinor),
    "Nieprawidłowe saldo początkowe",
    "INVALID_AMOUNT",
  );
  assertShape(CURRENCIES.has(payload.currency), "Nieprawidłowa waluta", "INVALID_CURRENCY");
  assertShape(
    typeof payload.color === "string" && payload.color.length <= 32,
    "Nieprawidłowy kolor",
    "INVALID_COLOR",
  );
  assertShape(
    typeof payload.archived === "boolean",
    "Nieprawidłowa flaga archiwizacji",
    "INVALID_ARCHIVED",
  );
  assertShape(
    VISIBILITIES.has(payload.visibility),
    "Nieprawidłowa widoczność",
    "INVALID_VISIBILITY",
  );
  return {
    id: payload.id,
    name: payload.name.trim(),
    type: payload.type,
    balanceMinor: payload.balanceMinor,
    currency: payload.currency,
    color: payload.color,
    archived: payload.archived,
    visibility: payload.visibility,
  };
}

const ACCOUNT_UPDATE_KEYS = new Set(["name", "type", "currency", "color", "archived"]);

// balanceMinor/ownerId/visibility are deliberately not editable here: balance only ever moves via the
// additive transaction.create/transaction.delete delta (see execTransactionCreate/execTransactionDelete),
// and changing ownership/visibility after creation is a sensitive operation this pilot doesn't implement
// (docs/plans/model-synchronizacji-danych.md Non-goals: "Brak nowych funkcji Finansów").
export function validateAccountUpdatePayload(payload, baseVersion) {
  assertShape(isPlainObject(payload), "Nieprawidłowy ładunek mutacji", "INVALID_PAYLOAD");
  assertShape(isId(payload.id), "Nieprawidłowy identyfikator konta", "INVALID_ID");
  assertShape(isPlainObject(payload.changes), "Brak zmian do zastosowania", "INVALID_CHANGES");
  for (const key of Object.keys(payload.changes)) {
    assertShape(
      ACCOUNT_UPDATE_KEYS.has(key),
      `Pola "${key}" nie można edytować`,
      "INVALID_CHANGES",
    );
  }
  const version = normalizeRequiredVersion(baseVersion);
  const changes = {};
  if (payload.changes.name !== undefined) {
    assertShape(
      isNonEmptyText(payload.changes.name, 500),
      "Nieprawidłowa nazwa konta",
      "INVALID_NAME",
    );
    changes.name = payload.changes.name.trim();
  }
  if (payload.changes.type !== undefined) {
    assertShape(ACCOUNT_TYPES.has(payload.changes.type), "Nieprawidłowy typ konta", "INVALID_TYPE");
    changes.type = payload.changes.type;
  }
  if (payload.changes.currency !== undefined) {
    assertShape(
      CURRENCIES.has(payload.changes.currency),
      "Nieprawidłowa waluta",
      "INVALID_CURRENCY",
    );
    changes.currency = payload.changes.currency;
  }
  if (payload.changes.color !== undefined) {
    assertShape(
      typeof payload.changes.color === "string" && payload.changes.color.length <= 32,
      "Nieprawidłowy kolor",
      "INVALID_COLOR",
    );
    changes.color = payload.changes.color;
  }
  if (payload.changes.archived !== undefined) {
    assertShape(
      typeof payload.changes.archived === "boolean",
      "Nieprawidłowa flaga archiwizacji",
      "INVALID_ARCHIVED",
    );
    changes.archived = payload.changes.archived;
  }
  return { id: payload.id, changes, baseVersion: version };
}

export function validateTransactionCreatePayload(payload) {
  assertShape(isPlainObject(payload), "Nieprawidłowy ładunek mutacji", "INVALID_PAYLOAD");
  assertShape(isId(payload.id), "Nieprawidłowy identyfikator transakcji", "INVALID_ID");
  assertShape(isId(payload.accountId), "Nieprawidłowy identyfikator konta", "INVALID_ACCOUNT_ID");
  assertShape(isIsoDate(payload.bookedOn), "Nieprawidłowa data transakcji", "INVALID_DATE");
  assertShape(isSafeMoney(payload.amountMinor), "Nieprawidłowa kwota", "INVALID_AMOUNT");
  assertShape(CURRENCIES.has(payload.currency), "Nieprawidłowa waluta", "INVALID_CURRENCY");
  assertShape(
    typeof payload.merchant === "string" && payload.merchant.length <= 1000,
    "Nieprawidłowy sprzedawca",
    "INVALID_MERCHANT",
  );
  assertShape(
    isNonEmptyText(payload.title, 500),
    "Nieprawidłowy tytuł transakcji",
    "INVALID_TITLE",
  );
  assertShape(isNonEmptyText(payload.category, 500), "Nieprawidłowa kategoria", "INVALID_CATEGORY");
  assertShape(
    TRANSACTION_SOURCES.has(payload.source),
    "Nieprawidłowe źródło transakcji",
    "INVALID_SOURCE",
  );
  if (payload.fingerprint !== undefined && payload.fingerprint !== null) {
    assertShape(
      typeof payload.fingerprint === "string" && payload.fingerprint.length <= 500,
      "Nieprawidłowy fingerprint",
      "INVALID_FINGERPRINT",
    );
  }
  if (payload.notes !== undefined && payload.notes !== null) {
    assertShape(
      typeof payload.notes === "string" && payload.notes.length <= 5000,
      "Nieprawidłowa notatka",
      "INVALID_NOTES",
    );
  }
  if (payload.visibility !== undefined) {
    assertShape(
      VISIBILITIES.has(payload.visibility),
      "Nieprawidłowa widoczność",
      "INVALID_VISIBILITY",
    );
  }
  return {
    id: payload.id,
    accountId: payload.accountId,
    bookedOn: payload.bookedOn,
    amountMinor: payload.amountMinor,
    currency: payload.currency,
    merchant: payload.merchant,
    title: payload.title.trim(),
    category: payload.category.trim(),
    source: payload.source,
    fingerprint: payload.fingerprint || undefined,
    notes: payload.notes || undefined,
    visibility: payload.visibility,
  };
}

const MAX_FINANCE_IMPORT_ROWS = 5000;

export function validateTransactionImportPayload(payload) {
  assertShape(isPlainObject(payload), "Nieprawidłowy ładunek mutacji", "INVALID_PAYLOAD");
  assertShape(
    Array.isArray(payload.transactions),
    "Brak listy transakcji do zaimportowania",
    "INVALID_TRANSACTIONS",
  );
  assertShape(
    payload.transactions.length <= MAX_FINANCE_IMPORT_ROWS,
    "Import zawiera zbyt wiele wierszy",
    "IMPORT_TOO_LARGE",
  );
  return payload.transactions.map((item) => validateTransactionCreatePayload(item));
}

export function validateDeleteIdPayload(payload) {
  assertShape(isPlainObject(payload), "Nieprawidłowy ładunek mutacji", "INVALID_PAYLOAD");
  assertShape(isId(payload.id), "Nieprawidłowy identyfikator", "INVALID_ID");
  return { id: payload.id };
}

export function validateBudgetCreatePayload(payload) {
  assertShape(isPlainObject(payload), "Nieprawidłowy ładunek mutacji", "INVALID_PAYLOAD");
  assertShape(isId(payload.id), "Nieprawidłowy identyfikator budżetu", "INVALID_ID");
  assertShape(
    isNonEmptyText(payload.category, 500),
    "Nieprawidłowa kategoria budżetu",
    "INVALID_CATEGORY",
  );
  assertShape(
    isSafeMoney(payload.limitMinor) && payload.limitMinor >= 0,
    "Nieprawidłowy limit budżetu",
    "INVALID_LIMIT",
  );
  assertShape(CURRENCIES.has(payload.currency), "Nieprawidłowa waluta", "INVALID_CURRENCY");
  assertShape(
    typeof payload.color === "string" && payload.color.length <= 32,
    "Nieprawidłowy kolor",
    "INVALID_COLOR",
  );
  return {
    id: payload.id,
    category: payload.category.trim(),
    limitMinor: payload.limitMinor,
    currency: payload.currency,
    color: payload.color,
  };
}

const BUDGET_UPDATE_KEYS = new Set(["category", "limitMinor", "currency", "color"]);

export function validateBudgetUpdatePayload(payload, baseVersion) {
  assertShape(isPlainObject(payload), "Nieprawidłowy ładunek mutacji", "INVALID_PAYLOAD");
  assertShape(isId(payload.id), "Nieprawidłowy identyfikator budżetu", "INVALID_ID");
  assertShape(isPlainObject(payload.changes), "Brak zmian do zastosowania", "INVALID_CHANGES");
  for (const key of Object.keys(payload.changes)) {
    assertShape(BUDGET_UPDATE_KEYS.has(key), `Pola "${key}" nie można edytować`, "INVALID_CHANGES");
  }
  const version = normalizeRequiredVersion(baseVersion);
  const changes = {};
  if (payload.changes.category !== undefined) {
    assertShape(
      isNonEmptyText(payload.changes.category, 500),
      "Nieprawidłowa kategoria budżetu",
      "INVALID_CATEGORY",
    );
    changes.category = payload.changes.category.trim();
  }
  if (payload.changes.limitMinor !== undefined) {
    assertShape(
      isSafeMoney(payload.changes.limitMinor) && payload.changes.limitMinor >= 0,
      "Nieprawidłowy limit budżetu",
      "INVALID_LIMIT",
    );
    changes.limitMinor = payload.changes.limitMinor;
  }
  if (payload.changes.currency !== undefined) {
    assertShape(
      CURRENCIES.has(payload.changes.currency),
      "Nieprawidłowa waluta",
      "INVALID_CURRENCY",
    );
    changes.currency = payload.changes.currency;
  }
  if (payload.changes.color !== undefined) {
    assertShape(
      typeof payload.changes.color === "string" && payload.changes.color.length <= 32,
      "Nieprawidłowy kolor",
      "INVALID_COLOR",
    );
    changes.color = payload.changes.color;
  }
  return { id: payload.id, changes, baseVersion: version };
}

export function validateGoalCreatePayload(payload) {
  assertShape(isPlainObject(payload), "Nieprawidłowy ładunek mutacji", "INVALID_PAYLOAD");
  assertShape(isId(payload.id), "Nieprawidłowy identyfikator celu", "INVALID_ID");
  assertShape(isNonEmptyText(payload.name, 500), "Nieprawidłowa nazwa celu", "INVALID_NAME");
  assertShape(
    isSafeMoney(payload.targetMinor) && payload.targetMinor >= 0,
    "Nieprawidłowa kwota docelowa",
    "INVALID_TARGET",
  );
  assertShape(
    isSafeMoney(payload.savedMinor) && payload.savedMinor >= 0,
    "Nieprawidłowa zaoszczędzona kwota",
    "INVALID_SAVED",
  );
  assertShape(CURRENCIES.has(payload.currency), "Nieprawidłowa waluta", "INVALID_CURRENCY");
  if (payload.deadline !== undefined && payload.deadline !== null) {
    assertShape(isIsoDate(payload.deadline), "Nieprawidłowy termin celu", "INVALID_DEADLINE");
  }
  assertShape(
    VISIBILITIES.has(payload.visibility),
    "Nieprawidłowa widoczność",
    "INVALID_VISIBILITY",
  );
  return {
    id: payload.id,
    name: payload.name.trim(),
    targetMinor: payload.targetMinor,
    savedMinor: payload.savedMinor,
    currency: payload.currency,
    deadline: payload.deadline || undefined,
    visibility: payload.visibility,
  };
}

// visibility JEST edytowalne (w odróżnieniu od account.update) — FinancePage.tsx pozwala zmienić
// widoczność istniejącego celu w modalu edycji, i to działało w dzisiejszym modelu JSONB. owner_id
// zostaje bez zmian (właściciel ustalony przy tworzeniu, z sesji) — zmienia się tylko visibility.
const GOAL_UPDATE_KEYS = new Set([
  "name",
  "targetMinor",
  "savedMinor",
  "currency",
  "deadline",
  "visibility",
]);

export function validateGoalUpdatePayload(payload, baseVersion) {
  assertShape(isPlainObject(payload), "Nieprawidłowy ładunek mutacji", "INVALID_PAYLOAD");
  assertShape(isId(payload.id), "Nieprawidłowy identyfikator celu", "INVALID_ID");
  assertShape(isPlainObject(payload.changes), "Brak zmian do zastosowania", "INVALID_CHANGES");
  for (const key of Object.keys(payload.changes)) {
    assertShape(GOAL_UPDATE_KEYS.has(key), `Pola "${key}" nie można edytować`, "INVALID_CHANGES");
  }
  const version = normalizeRequiredVersion(baseVersion);
  const changes = {};
  if (payload.changes.name !== undefined) {
    assertShape(
      isNonEmptyText(payload.changes.name, 500),
      "Nieprawidłowa nazwa celu",
      "INVALID_NAME",
    );
    changes.name = payload.changes.name.trim();
  }
  if (payload.changes.targetMinor !== undefined) {
    assertShape(
      isSafeMoney(payload.changes.targetMinor) && payload.changes.targetMinor >= 0,
      "Nieprawidłowa kwota docelowa",
      "INVALID_TARGET",
    );
    changes.targetMinor = payload.changes.targetMinor;
  }
  if (payload.changes.savedMinor !== undefined) {
    assertShape(
      isSafeMoney(payload.changes.savedMinor) && payload.changes.savedMinor >= 0,
      "Nieprawidłowa zaoszczędzona kwota",
      "INVALID_SAVED",
    );
    changes.savedMinor = payload.changes.savedMinor;
  }
  if (payload.changes.currency !== undefined) {
    assertShape(
      CURRENCIES.has(payload.changes.currency),
      "Nieprawidłowa waluta",
      "INVALID_CURRENCY",
    );
    changes.currency = payload.changes.currency;
  }
  if (payload.changes.deadline !== undefined) {
    assertShape(
      payload.changes.deadline === null || isIsoDate(payload.changes.deadline),
      "Nieprawidłowy termin celu",
      "INVALID_DEADLINE",
    );
    changes.deadline = payload.changes.deadline;
  }
  if (payload.changes.visibility !== undefined) {
    assertShape(
      VISIBILITIES.has(payload.changes.visibility),
      "Nieprawidłowa widoczność celu",
      "INVALID_VISIBILITY",
    );
    changes.visibility = payload.changes.visibility;
  }
  return { id: payload.id, changes, baseVersion: version };
}

// ---------------------------------------------------------------------------
// Mutation envelope + supported ops
// ---------------------------------------------------------------------------

export const SUPPORTED_FINANCE_OPS = new Set([
  "account.create",
  "account.update",
  "transaction.create",
  "transaction.import",
  "transaction.delete",
  "budget.create",
  "budget.update",
  "budget.delete",
  "goal.create",
  "goal.update",
  "goal.delete",
]);

// Whole-request-shape validation (docs/plans/model-synchronizacji-danych.md: "Globalny 409/400 tylko
// dla błędów całego żądania... zły kształt body"). Called once per mutation BEFORE any DB work starts,
// so a malformed entry anywhere in the batch is rejected as a single 400 rather than silently
// corrupting bookkeeping for its siblings. Per-mutation *business* validation (bad field values,
// missing account, duplicate budget category, ...) is a different, softer failure mode -- see
// applyFinanceMutation, which reports those as `status: "error"` inside `results` instead.
export function assertFinanceMutationShape(mutation) {
  if (!isPlainObject(mutation)) {
    throw financeRequestError(400, "Nieprawidłowy kształt mutacji", "INVALID_FINANCE_MUTATION");
  }
  if (typeof mutation.idempotencyKey !== "string" || !UUID_PATTERN.test(mutation.idempotencyKey)) {
    throw financeRequestError(400, "Nieprawidłowy klucz idempotencji", "INVALID_IDEMPOTENCY_KEY");
  }
  if (typeof mutation.op !== "string" || !SUPPORTED_FINANCE_OPS.has(mutation.op)) {
    throw financeRequestError(400, "Nieobsługiwana operacja mutacji", "UNSUPPORTED_OP");
  }
  if (!isPlainObject(mutation.payload)) {
    throw financeRequestError(400, "Brak danych mutacji", "INVALID_FINANCE_MUTATION");
  }
  if (
    mutation.baseVersion !== undefined &&
    mutation.baseVersion !== null &&
    !Number.isInteger(mutation.baseVersion)
  ) {
    throw financeRequestError(
      400,
      "Nieprawidłowa wersja bazowa mutacji",
      "INVALID_FINANCE_MUTATION",
    );
  }
}

export const MAX_FINANCE_MUTATIONS_PER_BATCH = Number(process.env.MAX_FINANCE_MUTATIONS ?? 500);
export const MAX_FINANCE_MUTATIONS_BYTES = Number(
  process.env.MAX_FINANCE_MUTATIONS_BYTES ?? 2_000_000,
);

// ---------------------------------------------------------------------------
// Snapshot read (GET /api/v1/finance): household-wide records + the caller's own private records,
// analogous to mergeWorkspaceData but expressed directly as a SQL WHERE instead of a JS merge.
// ---------------------------------------------------------------------------

export async function readFinanceSnapshot(client, householdId, userId) {
  // Sequential, not Promise.all: `client` may be a single-connection PoolClient (e.g. when called
  // inside a transaction()), and node-postgres only supports one in-flight query per connection --
  // concurrent unawaited calls on the same client are deprecated. `pool` itself would tolerate
  // concurrent calls (each checks out its own connection), but this stays correct for both callers.
  const accounts = await client.query(
    `SELECT ${ACCOUNT_SELECT_COLUMNS} FROM finance_accounts
      WHERE household_id = $1 AND (visibility = 'household' OR owner_id = $2)
      ORDER BY created_at`,
    [householdId, userId],
  );
  const transactions = await client.query(
    `SELECT ${TRANSACTION_SELECT_COLUMNS} FROM finance_transactions
      WHERE household_id = $1 AND (visibility = 'household' OR owner_id = $2)
      ORDER BY booked_on DESC, created_at DESC`,
    [householdId, userId],
  );
  const budgets = await client.query(
    `SELECT ${BUDGET_SELECT_COLUMNS} FROM finance_budgets WHERE household_id = $1 ORDER BY created_at`,
    [householdId],
  );
  const goals = await client.query(
    `SELECT ${GOAL_SELECT_COLUMNS} FROM finance_goals
      WHERE household_id = $1 AND (visibility = 'household' OR owner_id = $2)
      ORDER BY created_at`,
    [householdId, userId],
  );
  return {
    accounts: accounts.rows.map(accountRowToDto),
    transactions: transactions.rows.map(transactionRowToDto),
    budgets: budgets.rows.map(budgetRowToDto),
    goals: goals.rows.map(goalRowToDto),
  };
}

// Wspiera "Wyczyść dane aplikacji" w Ustawieniach (SettingsPage.tsx danger zone). Przed normalizacji
// finance ta strefa po prostu nadpisywała cały dokument JSONB pustymi tablicami (przez
// replaceAdvancedData + zwykły PUT /api/v1/workspace), co i tak trwale usuwało finance ze
// wspólnego dokumentu ORAZ z prywatnego dokumentu wywołującego użytkownika (ale NIGDY z prywatnych
// rekordów innych domowników — te żyją w ich własnym wierszu user_workspace_states). Ta funkcja
// odtwarza dokładnie ten sam zakres na znormalizowanych tabelach: usuwa wszystko wspólne
// (`visibility = 'household'`) plus WYŁĄCZNIE prywatne rekordy wywołującego użytkownika
// (`owner_id = userId`) w danym gospodarstwie. Budżety nie mają owner_id/visibility (zawsze
// wspólne), więc usuwane są w całości dla gospodarstwa -- tak jak dziś.
export async function resetFinanceForUser(client, householdId, userId) {
  await client.query(
    `DELETE FROM finance_transactions
      WHERE household_id = $1 AND (visibility = 'household' OR owner_id = $2)`,
    [householdId, userId],
  );
  await client.query(
    `DELETE FROM finance_accounts
      WHERE household_id = $1 AND (visibility = 'household' OR owner_id = $2)`,
    [householdId, userId],
  );
  await client.query(`DELETE FROM finance_budgets WHERE household_id = $1`, [householdId]);
  await client.query(
    `DELETE FROM finance_goals
      WHERE household_id = $1 AND (visibility = 'household' OR owner_id = $2)`,
    [householdId, userId],
  );
}

// ---------------------------------------------------------------------------
// Shared OCC/conflict resolution helpers used by every update/delete op.
// ---------------------------------------------------------------------------

// Used after a 0-row UPDATE (version mismatch or record not visible/missing) and after a 23505 on
// create (id already taken). The lookup query MUST carry the same household/visibility scoping as the
// write it's diagnosing -- otherwise this could leak the existence or content of another user's
// private record, or another household's record, through the "current record" in a conflict response.
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

// Same idea for deletes, but "not found" means "already deleted" -- deletion is idempotent by design
// (docs/plans/model-synchronizacji-danych.md: "dla delete: jeśli rekord już zniknął, potraktuj jako
// sukces"), so a missing row is `applied`, not an error.
async function resolveConflictOrGone(client, query, params, mapper) {
  const existing = await client.query(query, params);
  if (!existing.rowCount) return { status: "applied", record: null };
  const row = existing.rows[0];
  return { status: "conflict", record: mapper(row), currentVersion: row.version };
}

async function assertBudgetCategoryAvailable(client, householdId, category, excludeId) {
  const existing = await client.query(
    `SELECT id, category FROM finance_budgets WHERE household_id = $1`,
    [householdId],
  );
  const normalized = normalizeCategoryName(category);
  const duplicate = existing.rows.some(
    (row) => row.id !== excludeId && normalizeCategoryName(row.category) === normalized,
  );
  if (duplicate) {
    throw new FinanceValidationError(
      "Budżet dla tej kategorii już istnieje",
      "BUDGET_CATEGORY_DUPLICATE",
    );
  }
}

// ---------------------------------------------------------------------------
// Per-op SQL execution. Each function assumes payload/baseVersion have already been shape-checked by
// assertFinanceMutationShape; they still run their own (business-rule) validators and throw
// FinanceValidationError on bad input, which applyFinanceMutation turns into `status: "error"`.
// ---------------------------------------------------------------------------

async function execAccountCreate(client, ctx, payload) {
  const data = validateAccountCreatePayload(payload);
  const ownerId = resolveOwnerId(ctx);
  try {
    const inserted = await client.query(
      `INSERT INTO finance_accounts
         (id, household_id, owner_id, visibility, name, type, balance_minor, currency, color, archived,
          version, updated_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 1, $3)
       RETURNING ${ACCOUNT_SELECT_COLUMNS}`,
      [
        data.id,
        ctx.householdId,
        ownerId,
        data.visibility,
        data.name,
        data.type,
        data.balanceMinor,
        data.currency,
        data.color,
        data.archived,
      ],
    );
    return { status: "applied", record: accountRowToDto(inserted.rows[0]) };
  } catch (error) {
    if (error.code === "23505") {
      return resolveConflictOrError(
        client,
        `SELECT ${ACCOUNT_SELECT_COLUMNS} FROM finance_accounts
          WHERE id = $1 AND household_id = $2 AND (visibility = 'household' OR owner_id = $3)`,
        [data.id, ctx.householdId, ownerId],
        accountRowToDto,
        "Identyfikator jest już używany",
        "ID_TAKEN",
      );
    }
    throw error;
  }
}

async function execAccountUpdate(client, ctx, payload, baseVersion) {
  const { id, changes, baseVersion: version } = validateAccountUpdatePayload(payload, baseVersion);
  const ownerId = resolveOwnerId(ctx);
  const updated = await client.query(
    `UPDATE finance_accounts
        SET name = COALESCE($1, name),
            type = COALESCE($2, type),
            currency = COALESCE($3, currency),
            color = COALESCE($4, color),
            archived = COALESCE($5, archived),
            version = version + 1,
            updated_at = now(),
            updated_by = $6
      WHERE id = $7 AND household_id = $8 AND version = $9
        AND (visibility = 'household' OR owner_id = $6)
      RETURNING ${ACCOUNT_SELECT_COLUMNS}`,
    [
      changes.name ?? null,
      changes.type ?? null,
      changes.currency ?? null,
      changes.color ?? null,
      changes.archived ?? null,
      ownerId,
      id,
      ctx.householdId,
      version,
    ],
  );
  if (updated.rowCount) return { status: "applied", record: accountRowToDto(updated.rows[0]) };
  return resolveConflictOrError(
    client,
    `SELECT ${ACCOUNT_SELECT_COLUMNS} FROM finance_accounts
      WHERE id = $1 AND household_id = $2 AND (visibility = 'household' OR owner_id = $3)`,
    [id, ctx.householdId, ownerId],
    accountRowToDto,
    "Rekord nie istnieje lub jest niedostępny",
    "NOT_FOUND",
  );
}

async function execTransactionCreate(client, ctx, payload) {
  const data = validateTransactionCreatePayload(payload);
  const ownerId = resolveOwnerId(ctx);
  const accountResult = await client.query(
    `SELECT visibility FROM finance_accounts
      WHERE id = $1 AND household_id = $2 AND (visibility = 'household' OR owner_id = $3)`,
    [data.accountId, ctx.householdId, ownerId],
  );
  if (!accountResult.rowCount) {
    return {
      status: "error",
      error: "Rachunek nie istnieje lub jest niedostępny",
      code: "ACCOUNT_NOT_FOUND",
    };
  }
  const visibility = resolveTransactionVisibility(
    data.visibility,
    accountResult.rows[0].visibility,
  );
  try {
    const inserted = await client.query(
      `INSERT INTO finance_transactions
         (id, household_id, account_id, owner_id, visibility, booked_on, amount_minor, currency,
          merchant, title, category, source, fingerprint, notes, version, updated_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, 1, $4)
       RETURNING ${TRANSACTION_SELECT_COLUMNS}`,
      [
        data.id,
        ctx.householdId,
        data.accountId,
        ownerId,
        visibility,
        data.bookedOn,
        data.amountMinor,
        data.currency,
        data.merchant,
        data.title,
        data.category,
        data.source,
        data.fingerprint ?? null,
        data.notes ?? null,
      ],
    );
    // Balance is an additive delta, not a versioned field: this is the core property of the
    // refactor (docs/plans/model-synchronizacji-danych.md "Wersjonowanie i saldo") -- two concurrent
    // transaction.create mutations against the same account both apply, they never conflict.
    const accountUpdate = await client.query(
      `UPDATE finance_accounts SET balance_minor = balance_minor + $1, updated_at = now()
        WHERE id = $2
        RETURNING ${ACCOUNT_SELECT_COLUMNS}`,
      [data.amountMinor, data.accountId],
    );
    return {
      status: "applied",
      record: transactionRowToDto(inserted.rows[0]),
      account: accountUpdate.rows[0] ? accountRowToDto(accountUpdate.rows[0]) : undefined,
    };
  } catch (error) {
    if (error.code === "23505") {
      if (error.constraint === "finance_transactions_fingerprint_unique_idx") {
        return {
          status: "error",
          error: "Transakcja o tym odcisku (fingerprint) już istnieje",
          code: "FINGERPRINT_DUPLICATE",
        };
      }
      return resolveConflictOrError(
        client,
        `SELECT ${TRANSACTION_SELECT_COLUMNS} FROM finance_transactions
          WHERE id = $1 AND household_id = $2 AND (visibility = 'household' OR owner_id = $3)`,
        [data.id, ctx.householdId, ownerId],
        transactionRowToDto,
        "Identyfikator jest już używany",
        "ID_TAKEN",
      );
    }
    throw error;
  }
}

async function execTransactionImport(client, ctx, payload) {
  const items = validateTransactionImportPayload(payload);
  const ownerId = resolveOwnerId(ctx);
  const added = [];
  let duplicateCount = 0;
  const accountVisibilityCache = new Map();
  for (const data of items) {
    let accountVisibility = accountVisibilityCache.get(data.accountId);
    if (accountVisibility === undefined) {
      const accountResult = await client.query(
        `SELECT visibility FROM finance_accounts
          WHERE id = $1 AND household_id = $2 AND (visibility = 'household' OR owner_id = $3)`,
        [data.accountId, ctx.householdId, ownerId],
      );
      if (!accountResult.rowCount) {
        throw new FinanceValidationError(
          `Rachunek ${data.accountId} nie istnieje lub jest niedostępny`,
          "ACCOUNT_NOT_FOUND",
        );
      }
      accountVisibility = accountResult.rows[0].visibility;
      accountVisibilityCache.set(data.accountId, accountVisibility);
    }
    const visibility = resolveTransactionVisibility(data.visibility, accountVisibility);
    // Dedup relies on the partial unique index (household_id, fingerprint) WHERE fingerprint IS NOT
    // NULL (server/migrations/006_finance_normalized.sql) -- rows without a fingerprint always insert.
    const inserted = await client.query(
      `INSERT INTO finance_transactions
         (id, household_id, account_id, owner_id, visibility, booked_on, amount_minor, currency,
          merchant, title, category, source, fingerprint, notes, version, updated_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, 1, $4)
       ON CONFLICT (household_id, fingerprint) WHERE fingerprint IS NOT NULL DO NOTHING
       RETURNING ${TRANSACTION_SELECT_COLUMNS}`,
      [
        data.id,
        ctx.householdId,
        data.accountId,
        ownerId,
        visibility,
        data.bookedOn,
        data.amountMinor,
        data.currency,
        data.merchant,
        data.title,
        data.category,
        data.source,
        data.fingerprint ?? null,
        data.notes ?? null,
      ],
    );
    if (inserted.rowCount) added.push(transactionRowToDto(inserted.rows[0]));
    else duplicateCount += 1;
  }
  // Imported statements describe historical movements already reflected in the account's current
  // balance; replaying them into balance_minor would double-count (parity with today's
  // `importTransactions` in src/store/useAdvancedStore.ts).
  return {
    status: "applied",
    record: { transactions: added, addedCount: added.length, duplicateCount },
  };
}

async function execTransactionDelete(client, ctx, payload, baseVersion) {
  const { id } = validateDeleteIdPayload(payload);
  const ownerId = resolveOwnerId(ctx);
  const version = normalizeOptionalVersion(baseVersion);
  const deleted = await client.query(
    `DELETE FROM finance_transactions
      WHERE id = $1 AND household_id = $2 AND (visibility = 'household' OR owner_id = $3)
        AND ($4::integer IS NULL OR version = $4)
      RETURNING account_id, amount_minor, source`,
    [id, ctx.householdId, ownerId, version],
  );
  if (!deleted.rowCount) {
    return resolveConflictOrGone(
      client,
      `SELECT ${TRANSACTION_SELECT_COLUMNS} FROM finance_transactions
        WHERE id = $1 AND household_id = $2 AND (visibility = 'household' OR owner_id = $3)`,
      [id, ctx.householdId, ownerId],
      transactionRowToDto,
    );
  }
  const row = deleted.rows[0];
  let account;
  // CSV imports never touched the balance in the first place, so deleting one doesn't reverse it
  // either (parity with today's `deleteTransaction`).
  if (row.source !== "csv") {
    const accountUpdate = await client.query(
      `UPDATE finance_accounts SET balance_minor = balance_minor - $1, updated_at = now()
        WHERE id = $2
        RETURNING ${ACCOUNT_SELECT_COLUMNS}`,
      [row.amount_minor, row.account_id],
    );
    account = accountUpdate.rows[0] ? accountRowToDto(accountUpdate.rows[0]) : undefined;
  }
  return { status: "applied", record: null, account };
}

async function execBudgetCreate(client, ctx, payload) {
  const data = validateBudgetCreatePayload(payload);
  await assertBudgetCategoryAvailable(client, ctx.householdId, data.category, null);
  try {
    const inserted = await client.query(
      `INSERT INTO finance_budgets (id, household_id, category, limit_minor, currency, color, version, updated_by)
       VALUES ($1, $2, $3, $4, $5, $6, 1, $7)
       RETURNING ${BUDGET_SELECT_COLUMNS}`,
      [
        data.id,
        ctx.householdId,
        data.category,
        data.limitMinor,
        data.currency,
        data.color,
        resolveOwnerId(ctx),
      ],
    );
    return { status: "applied", record: budgetRowToDto(inserted.rows[0]) };
  } catch (error) {
    if (error.code === "23505") {
      return resolveConflictOrError(
        client,
        `SELECT ${BUDGET_SELECT_COLUMNS} FROM finance_budgets WHERE id = $1 AND household_id = $2`,
        [data.id, ctx.householdId],
        budgetRowToDto,
        "Identyfikator jest już używany",
        "ID_TAKEN",
      );
    }
    throw error;
  }
}

async function execBudgetUpdate(client, ctx, payload, baseVersion) {
  const { id, changes, baseVersion: version } = validateBudgetUpdatePayload(payload, baseVersion);
  if (changes.category !== undefined) {
    await assertBudgetCategoryAvailable(client, ctx.householdId, changes.category, id);
  }
  const updated = await client.query(
    `UPDATE finance_budgets
        SET category = COALESCE($1, category),
            limit_minor = COALESCE($2, limit_minor),
            currency = COALESCE($3, currency),
            color = COALESCE($4, color),
            version = version + 1,
            updated_at = now(),
            updated_by = $5
      WHERE id = $6 AND household_id = $7 AND version = $8
      RETURNING ${BUDGET_SELECT_COLUMNS}`,
    [
      changes.category ?? null,
      changes.limitMinor ?? null,
      changes.currency ?? null,
      changes.color ?? null,
      resolveOwnerId(ctx),
      id,
      ctx.householdId,
      version,
    ],
  );
  if (updated.rowCount) return { status: "applied", record: budgetRowToDto(updated.rows[0]) };
  return resolveConflictOrError(
    client,
    `SELECT ${BUDGET_SELECT_COLUMNS} FROM finance_budgets WHERE id = $1 AND household_id = $2`,
    [id, ctx.householdId],
    budgetRowToDto,
    "Rekord nie istnieje lub jest niedostępny",
    "NOT_FOUND",
  );
}

async function execBudgetDelete(client, ctx, payload, baseVersion) {
  const { id } = validateDeleteIdPayload(payload);
  const version = normalizeOptionalVersion(baseVersion);
  const deleted = await client.query(
    `DELETE FROM finance_budgets WHERE id = $1 AND household_id = $2 AND ($3::integer IS NULL OR version = $3)
     RETURNING id`,
    [id, ctx.householdId, version],
  );
  if (deleted.rowCount) return { status: "applied", record: null };
  return resolveConflictOrGone(
    client,
    `SELECT ${BUDGET_SELECT_COLUMNS} FROM finance_budgets WHERE id = $1 AND household_id = $2`,
    [id, ctx.householdId],
    budgetRowToDto,
  );
}

async function execGoalCreate(client, ctx, payload) {
  const data = validateGoalCreatePayload(payload);
  const ownerId = resolveOwnerId(ctx);
  try {
    const inserted = await client.query(
      `INSERT INTO finance_goals
         (id, household_id, owner_id, visibility, name, target_minor, saved_minor, currency, deadline,
          version, updated_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 1, $3)
       RETURNING ${GOAL_SELECT_COLUMNS}`,
      [
        data.id,
        ctx.householdId,
        ownerId,
        data.visibility,
        data.name,
        data.targetMinor,
        data.savedMinor,
        data.currency,
        data.deadline ?? null,
      ],
    );
    return { status: "applied", record: goalRowToDto(inserted.rows[0]) };
  } catch (error) {
    if (error.code === "23505") {
      return resolveConflictOrError(
        client,
        `SELECT ${GOAL_SELECT_COLUMNS} FROM finance_goals
          WHERE id = $1 AND household_id = $2 AND (visibility = 'household' OR owner_id = $3)`,
        [data.id, ctx.householdId, ownerId],
        goalRowToDto,
        "Identyfikator jest już używany",
        "ID_TAKEN",
      );
    }
    throw error;
  }
}

async function execGoalUpdate(client, ctx, payload, baseVersion) {
  const { id, changes, baseVersion: version } = validateGoalUpdatePayload(payload, baseVersion);
  const ownerId = resolveOwnerId(ctx);
  const hasDeadlineChange = Object.prototype.hasOwnProperty.call(changes, "deadline");
  const updated = await client.query(
    `UPDATE finance_goals
        SET name = COALESCE($1, name),
            target_minor = COALESCE($2, target_minor),
            saved_minor = COALESCE($3, saved_minor),
            currency = COALESCE($4, currency),
            deadline = CASE WHEN $5 THEN $6::date ELSE deadline END,
            visibility = COALESCE($7, visibility),
            version = version + 1,
            updated_at = now(),
            updated_by = $8
      WHERE id = $9 AND household_id = $10 AND version = $11
        AND (visibility = 'household' OR owner_id = $8)
      RETURNING ${GOAL_SELECT_COLUMNS}`,
    [
      changes.name ?? null,
      changes.targetMinor ?? null,
      changes.savedMinor ?? null,
      changes.currency ?? null,
      hasDeadlineChange,
      changes.deadline ?? null,
      changes.visibility ?? null,
      ownerId,
      id,
      ctx.householdId,
      version,
    ],
  );
  if (updated.rowCount) return { status: "applied", record: goalRowToDto(updated.rows[0]) };
  return resolveConflictOrError(
    client,
    `SELECT ${GOAL_SELECT_COLUMNS} FROM finance_goals
      WHERE id = $1 AND household_id = $2 AND (visibility = 'household' OR owner_id = $3)`,
    [id, ctx.householdId, ownerId],
    goalRowToDto,
    "Rekord nie istnieje lub jest niedostępny",
    "NOT_FOUND",
  );
}

async function execGoalDelete(client, ctx, payload, baseVersion) {
  const { id } = validateDeleteIdPayload(payload);
  const ownerId = resolveOwnerId(ctx);
  const version = normalizeOptionalVersion(baseVersion);
  const deleted = await client.query(
    `DELETE FROM finance_goals
      WHERE id = $1 AND household_id = $2 AND (visibility = 'household' OR owner_id = $3)
        AND ($4::integer IS NULL OR version = $4)
      RETURNING id`,
    [id, ctx.householdId, ownerId, version],
  );
  if (deleted.rowCount) return { status: "applied", record: null };
  return resolveConflictOrGone(
    client,
    `SELECT ${GOAL_SELECT_COLUMNS} FROM finance_goals
      WHERE id = $1 AND household_id = $2 AND (visibility = 'household' OR owner_id = $3)`,
    [id, ctx.householdId, ownerId],
    goalRowToDto,
  );
}

async function executeFinanceOp(client, ctx, op, payload, baseVersion) {
  switch (op) {
    case "account.create":
      return execAccountCreate(client, ctx, payload);
    case "account.update":
      return execAccountUpdate(client, ctx, payload, baseVersion);
    case "transaction.create":
      return execTransactionCreate(client, ctx, payload);
    case "transaction.import":
      return execTransactionImport(client, ctx, payload);
    case "transaction.delete":
      return execTransactionDelete(client, ctx, payload, baseVersion);
    case "budget.create":
      return execBudgetCreate(client, ctx, payload);
    case "budget.update":
      return execBudgetUpdate(client, ctx, payload, baseVersion);
    case "budget.delete":
      return execBudgetDelete(client, ctx, payload, baseVersion);
    case "goal.create":
      return execGoalCreate(client, ctx, payload);
    case "goal.update":
      return execGoalUpdate(client, ctx, payload, baseVersion);
    case "goal.delete":
      return execGoalDelete(client, ctx, payload, baseVersion);
    default:
      // Unreachable when called through applyFinanceMutation (assertFinanceMutationShape already
      // rejected unknown ops at the request level); kept defensive in case of direct unit-test calls.
      throw new FinanceValidationError(`Nieobsługiwana operacja: ${op}`, "UNSUPPORTED_OP");
  }
}

// ---------------------------------------------------------------------------
// Idempotent mutation entry point. `mutation` is assumed to already have passed
// assertFinanceMutationShape (server.mjs validates the whole batch upfront). ctx = { householdId, userId }
// always comes from the authenticated session, never from the request body.
// ---------------------------------------------------------------------------

export async function applyFinanceMutation(client, ctx, mutation) {
  const { idempotencyKey, op, payload, baseVersion } = mutation;

  // Claim the idempotency key first, inside the same DB transaction as the operation itself: if the
  // op below throws, the whole transaction (including this claim) rolls back, so the key remains free
  // to retry. If a row already existed, this was a retry -- return the previously stored result
  // instead of running the operation again.
  const claim = await client.query(
    `INSERT INTO finance_mutations (idempotency_key, household_id, user_id, op, result)
     VALUES ($1, $2, $3, $4, '{}'::jsonb)
     ON CONFLICT (idempotency_key) DO NOTHING`,
    [idempotencyKey, ctx.householdId, ctx.userId, op],
  );
  if (!claim.rowCount) {
    const existing = await client.query(
      `SELECT result FROM finance_mutations WHERE idempotency_key = $1`,
      [idempotencyKey],
    );
    return existing.rows[0]?.result ?? { idempotencyKey, status: "duplicate" };
  }

  let outcome;
  try {
    outcome = await executeFinanceOp(client, ctx, op, payload, baseVersion);
  } catch (error) {
    if (error instanceof FinanceValidationError) {
      outcome = { status: "error", error: error.message, code: error.code };
    } else {
      throw error;
    }
  }

  const result = { idempotencyKey, ...outcome };
  await client.query(`UPDATE finance_mutations SET result = $1::jsonb WHERE idempotency_key = $2`, [
    JSON.stringify(result),
    idempotencyKey,
  ]);
  return result;
}
