// Domain layer for the normalized Meals (Posiłki) module.
//
// Data model: server/migrations/008_meals_normalized.sql (recipes, meal_slots, shopping_items,
// meal_mutations). Design source of truth: docs/plans/lista-zakupow-meals.md ("Podejście").
// This is the Meals analogue of server/src/trips.mjs -- same shape, same conventions -- with the
// structural differences the plan calls out explicitly:
//   1. Meals have NO owner_id/visibility columns at all -- all three collections are always
//      household-wide, so every query here scopes exclusively by household_id (never
//      `visibility = 'household' OR owner_id = …`). The household id always comes from the
//      authenticated session (ctx.householdId), never the payload.
//   2. Meals has NO aggregate field (no `progress`/`balanceMinor` equivalent) -- there is no
//      recompute step analogous to computeTripProgress. Every mutation here is independent.
//   3. `recipes` -> `meal_slots`/`shopping_items` uses `ON DELETE SET NULL`, not `CASCADE`
//      (recipe.delete unlinks children, it never removes them -- decision #6 of the plan). This
//      changes resetMealsForHousehold: it cannot rely on a cascade from `recipes` and must delete
//      all three tables explicitly, children before parent.
//
// Like trips.mjs/finance.mjs, this module intentionally does NOT import the zod schemas from
// src/lib/schema.ts: the server package has no TypeScript build step and no zod dependency. The
// validators below hand-roll the same rules as recipeSchema/mealSlotSchema/shoppingItemSchema.
//
// Every exported function here is either pure (validators, resolveVersionConflict, row->DTO
// mappers) or takes an already-connected `client` (a pg PoolClient, or the shared `pool` from
// db.mjs) so it can run either inside a transaction() or directly against the pool.

export class MealValidationError extends Error {
  constructor(message, code = "VALIDATION_ERROR") {
    super(message);
    this.name = "MealValidationError";
    this.code = code;
  }
}

function mealRequestError(statusCode, message, code) {
  const error = new Error(message);
  error.statusCode = statusCode;
  error.code = code;
  return error;
}

// ---------------------------------------------------------------------------
// Primitive validators (mirror src/lib/schema.ts / src/mealsTypes.ts)
// ---------------------------------------------------------------------------

const ID_MAX_LENGTH = 200;
const MEAL_TYPES = new Set(["breakfast", "lunch", "dinner"]);
const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_TAGS = 50;
const MAX_INGREDIENTS = 500;

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

function isPositiveInt(value, max) {
  return Number.isInteger(value) && value > 0 && value <= max;
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

function isStringArray(value, maxItems, maxItemLength) {
  return (
    Array.isArray(value) &&
    value.length <= maxItems &&
    value.every((item) => typeof item === "string" && item.length <= maxItemLength)
  );
}

function assertShape(condition, message, code) {
  if (!condition) throw new MealValidationError(message, code);
}

// ---------------------------------------------------------------------------
// Security invariant (docs/ARCHITECTURE.md "Dane wspólne i prywatne" + plan "Odróżnianie
// prywatne/wspólne"): meals have no owner_id/visibility at all -- they are always household-wide.
// Every query in this module scopes exclusively by household_id, which always comes from the
// authenticated session (ctx.householdId), never from a client-supplied payload field.
// ---------------------------------------------------------------------------

// Pure helper naming the core OCC decision explicitly, unit-testable in isolation (mirrors
// trips.mjs's resolveVersionConflict). The authoritative check always happens in SQL
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
// Row -> DTO mapping (snake_case columns -> the Recipe/MealSlot/ShoppingItem shapes in
// src/mealsTypes.ts). `date` is cast to text in SQL (`::text`) to dodge node-postgres's
// local-timezone Date parsing; `timestamptz` columns are safe to read as JS Date and converted
// with `.toISOString()`. `tags`/`ingredients` (jsonb) come back already parsed into JS arrays by
// node-postgres.
// ---------------------------------------------------------------------------

export function recipeRowToDto(row) {
  return {
    id: row.id,
    name: row.name,
    minutes: row.minutes,
    servings: row.servings,
    tags: Array.isArray(row.tags) ? row.tags : [],
    ingredients: Array.isArray(row.ingredients) ? row.ingredients : [],
    favorite: row.favorite,
    version: row.version,
    updatedAt: row.updated_at.toISOString(),
  };
}

export function mealSlotRowToDto(row) {
  return {
    id: row.id,
    date: row.date,
    type: row.type,
    recipeId: row.recipe_id ?? undefined,
    title: row.title,
    servings: row.servings,
    version: row.version,
    updatedAt: row.updated_at.toISOString(),
  };
}

export function shoppingItemRowToDto(row) {
  return {
    id: row.id,
    name: row.name,
    quantity: row.quantity,
    category: row.category,
    checked: row.checked,
    assignedTo: row.assigned_to ?? undefined,
    sourceRecipeId: row.source_recipe_id ?? undefined,
    version: row.version,
    updatedAt: row.updated_at.toISOString(),
  };
}

const RECIPE_SELECT_COLUMNS =
  "id, name, minutes, servings, tags, ingredients, favorite, version, updated_at";
const MEAL_SLOT_SELECT_COLUMNS =
  "id, recipe_id, date::text AS date, type, title, servings, version, updated_at";
const SHOPPING_ITEM_SELECT_COLUMNS =
  "id, source_recipe_id, name, quantity, category, checked, assigned_to, version, updated_at";

// ---------------------------------------------------------------------------
// Payload validators per mutation `op`. Each returns a normalized object built only from
// allow-listed fields, or throws MealValidationError.
// ---------------------------------------------------------------------------

export function validateRecipeCreatePayload(payload) {
  assertShape(isPlainObject(payload), "Nieprawidłowy ładunek mutacji", "INVALID_PAYLOAD");
  assertShape(isId(payload.id), "Nieprawidłowy identyfikator przepisu", "INVALID_ID");
  assertShape(isNonEmptyText(payload.name, 500), "Nieprawidłowa nazwa przepisu", "INVALID_NAME");
  assertShape(
    isPositiveInt(payload.minutes, 1440),
    "Nieprawidłowy czas przygotowania",
    "INVALID_MINUTES",
  );
  assertShape(
    isPositiveInt(payload.servings, 100),
    "Nieprawidłowa liczba porcji",
    "INVALID_SERVINGS",
  );
  assertShape(
    isStringArray(payload.tags ?? [], MAX_TAGS, 100),
    "Nieprawidłowa lista tagów",
    "INVALID_TAGS",
  );
  assertShape(
    isStringArray(payload.ingredients ?? [], MAX_INGREDIENTS, 1000),
    "Nieprawidłowa lista składników",
    "INVALID_INGREDIENTS",
  );
  if (payload.favorite !== undefined) {
    assertShape(
      typeof payload.favorite === "boolean",
      "Nieprawidłowa flaga ulubionych",
      "INVALID_FAVORITE",
    );
  }
  return {
    id: payload.id,
    name: payload.name.trim(),
    minutes: payload.minutes,
    servings: payload.servings,
    tags: payload.tags ?? [],
    ingredients: payload.ingredients ?? [],
    favorite: Boolean(payload.favorite),
  };
}

const RECIPE_UPDATE_KEYS = new Set([
  "name",
  "minutes",
  "servings",
  "tags",
  "ingredients",
  "favorite",
]);

export function validateRecipeUpdatePayload(payload, baseVersion) {
  assertShape(isPlainObject(payload), "Nieprawidłowy ładunek mutacji", "INVALID_PAYLOAD");
  assertShape(isId(payload.id), "Nieprawidłowy identyfikator przepisu", "INVALID_ID");
  assertShape(isPlainObject(payload.changes), "Brak zmian do zastosowania", "INVALID_CHANGES");
  for (const key of Object.keys(payload.changes)) {
    assertShape(RECIPE_UPDATE_KEYS.has(key), `Pola "${key}" nie można edytować`, "INVALID_CHANGES");
  }
  const version = normalizeRequiredVersion(baseVersion);
  const changes = {};
  const c = payload.changes;
  if (c.name !== undefined) {
    assertShape(isNonEmptyText(c.name, 500), "Nieprawidłowa nazwa przepisu", "INVALID_NAME");
    changes.name = c.name.trim();
  }
  if (c.minutes !== undefined) {
    assertShape(
      isPositiveInt(c.minutes, 1440),
      "Nieprawidłowy czas przygotowania",
      "INVALID_MINUTES",
    );
    changes.minutes = c.minutes;
  }
  if (c.servings !== undefined) {
    assertShape(isPositiveInt(c.servings, 100), "Nieprawidłowa liczba porcji", "INVALID_SERVINGS");
    changes.servings = c.servings;
  }
  if (c.tags !== undefined) {
    assertShape(isStringArray(c.tags, MAX_TAGS, 100), "Nieprawidłowa lista tagów", "INVALID_TAGS");
    changes.tags = c.tags;
  }
  if (c.ingredients !== undefined) {
    assertShape(
      isStringArray(c.ingredients, MAX_INGREDIENTS, 1000),
      "Nieprawidłowa lista składników",
      "INVALID_INGREDIENTS",
    );
    changes.ingredients = c.ingredients;
  }
  if (c.favorite !== undefined) {
    assertShape(
      typeof c.favorite === "boolean",
      "Nieprawidłowa flaga ulubionych",
      "INVALID_FAVORITE",
    );
    changes.favorite = c.favorite;
  }
  return { id: payload.id, changes, baseVersion: version };
}

export function validateDeleteIdPayload(payload) {
  assertShape(isPlainObject(payload), "Nieprawidłowy ładunek mutacji", "INVALID_PAYLOAD");
  assertShape(isId(payload.id), "Nieprawidłowy identyfikator", "INVALID_ID");
  return { id: payload.id };
}

export function validateMealCreatePayload(payload) {
  assertShape(isPlainObject(payload), "Nieprawidłowy ładunek mutacji", "INVALID_PAYLOAD");
  assertShape(isId(payload.id), "Nieprawidłowy identyfikator posiłku", "INVALID_ID");
  assertShape(isIsoDate(payload.date), "Nieprawidłowa data posiłku", "INVALID_DATE");
  assertShape(MEAL_TYPES.has(payload.type), "Nieprawidłowy typ posiłku", "INVALID_TYPE");
  if (payload.recipeId !== undefined && payload.recipeId !== null) {
    assertShape(
      isId(payload.recipeId),
      "Nieprawidłowy identyfikator przepisu",
      "INVALID_RECIPE_ID",
    );
  }
  assertShape(isNonEmptyText(payload.title, 500), "Nieprawidłowy tytuł posiłku", "INVALID_TITLE");
  assertShape(
    isPositiveInt(payload.servings, 100),
    "Nieprawidłowa liczba porcji",
    "INVALID_SERVINGS",
  );
  return {
    id: payload.id,
    date: payload.date,
    type: payload.type,
    recipeId: payload.recipeId || undefined,
    title: payload.title.trim(),
    servings: payload.servings,
  };
}

const MEAL_UPDATE_KEYS = new Set(["recipeId", "title", "servings", "date", "type"]);

export function validateMealUpdatePayload(payload, baseVersion) {
  assertShape(isPlainObject(payload), "Nieprawidłowy ładunek mutacji", "INVALID_PAYLOAD");
  assertShape(isId(payload.id), "Nieprawidłowy identyfikator posiłku", "INVALID_ID");
  assertShape(isPlainObject(payload.changes), "Brak zmian do zastosowania", "INVALID_CHANGES");
  for (const key of Object.keys(payload.changes)) {
    assertShape(MEAL_UPDATE_KEYS.has(key), `Pola "${key}" nie można edytować`, "INVALID_CHANGES");
  }
  const version = normalizeRequiredVersion(baseVersion);
  const changes = {};
  const c = payload.changes;
  if (c.date !== undefined) {
    assertShape(isIsoDate(c.date), "Nieprawidłowa data posiłku", "INVALID_DATE");
    changes.date = c.date;
  }
  if (c.type !== undefined) {
    assertShape(MEAL_TYPES.has(c.type), "Nieprawidłowy typ posiłku", "INVALID_TYPE");
    changes.type = c.type;
  }
  if (Object.prototype.hasOwnProperty.call(c, "recipeId")) {
    if (c.recipeId === null || c.recipeId === "") {
      changes.recipeId = null;
    } else {
      assertShape(isId(c.recipeId), "Nieprawidłowy identyfikator przepisu", "INVALID_RECIPE_ID");
      changes.recipeId = c.recipeId;
    }
  }
  if (c.title !== undefined) {
    assertShape(isNonEmptyText(c.title, 500), "Nieprawidłowy tytuł posiłku", "INVALID_TITLE");
    changes.title = c.title.trim();
  }
  if (c.servings !== undefined) {
    assertShape(isPositiveInt(c.servings, 100), "Nieprawidłowa liczba porcji", "INVALID_SERVINGS");
    changes.servings = c.servings;
  }
  return { id: payload.id, changes, baseVersion: version };
}

export function validateShoppingCreatePayload(payload) {
  assertShape(isPlainObject(payload), "Nieprawidłowy ładunek mutacji", "INVALID_PAYLOAD");
  assertShape(isId(payload.id), "Nieprawidłowy identyfikator pozycji", "INVALID_ID");
  assertShape(isNonEmptyText(payload.name, 500), "Nieprawidłowa nazwa pozycji", "INVALID_NAME");
  if (payload.quantity !== undefined && payload.quantity !== null) {
    assertShape(isOptionalText(payload.quantity, 200), "Nieprawidłowa ilość", "INVALID_QUANTITY");
  }
  // Parity with shoppingItemSchema (src/lib/schema.ts): `category` is a required string field but
  // NOT wrapped in nonEmptyText there, so an empty string is a legal category (unlike `name`).
  assertShape(isOptionalText(payload.category, 200), "Nieprawidłowa kategoria", "INVALID_CATEGORY");
  if (payload.checked !== undefined) {
    assertShape(
      typeof payload.checked === "boolean",
      "Nieprawidłowa flaga odhaczenia",
      "INVALID_CHECKED",
    );
  }
  if (payload.assignedTo !== undefined && payload.assignedTo !== null) {
    assertShape(
      isOptionalText(payload.assignedTo, 200),
      "Nieprawidłowy przypisany domownik",
      "INVALID_ASSIGNED_TO",
    );
  }
  if (payload.sourceRecipeId !== undefined && payload.sourceRecipeId !== null) {
    assertShape(
      isId(payload.sourceRecipeId),
      "Nieprawidłowy identyfikator przepisu",
      "INVALID_RECIPE_ID",
    );
  }
  return {
    id: payload.id,
    name: payload.name.trim(),
    quantity: (payload.quantity ?? "").trim(),
    category: payload.category.trim(),
    checked: Boolean(payload.checked),
    assignedTo: payload.assignedTo || undefined,
    sourceRecipeId: payload.sourceRecipeId || undefined,
  };
}

const SHOPPING_UPDATE_KEYS = new Set(["checked", "name", "quantity", "category", "assignedTo"]);

export function validateShoppingUpdatePayload(payload, baseVersion) {
  assertShape(isPlainObject(payload), "Nieprawidłowy ładunek mutacji", "INVALID_PAYLOAD");
  assertShape(isId(payload.id), "Nieprawidłowy identyfikator pozycji", "INVALID_ID");
  assertShape(isPlainObject(payload.changes), "Brak zmian do zastosowania", "INVALID_CHANGES");
  for (const key of Object.keys(payload.changes)) {
    assertShape(
      SHOPPING_UPDATE_KEYS.has(key),
      `Pola "${key}" nie można edytować`,
      "INVALID_CHANGES",
    );
  }
  const version = normalizeRequiredVersion(baseVersion);
  const changes = {};
  const c = payload.changes;
  if (c.checked !== undefined) {
    assertShape(
      typeof c.checked === "boolean",
      "Nieprawidłowa flaga odhaczenia",
      "INVALID_CHECKED",
    );
    changes.checked = c.checked;
  }
  if (c.name !== undefined) {
    assertShape(isNonEmptyText(c.name, 500), "Nieprawidłowa nazwa pozycji", "INVALID_NAME");
    changes.name = c.name.trim();
  }
  if (c.quantity !== undefined) {
    assertShape(isOptionalText(c.quantity ?? "", 200), "Nieprawidłowa ilość", "INVALID_QUANTITY");
    changes.quantity = c.quantity ?? "";
  }
  if (c.category !== undefined) {
    assertShape(isOptionalText(c.category, 200), "Nieprawidłowa kategoria", "INVALID_CATEGORY");
    changes.category = c.category;
  }
  if (Object.prototype.hasOwnProperty.call(c, "assignedTo")) {
    if (c.assignedTo === null) {
      changes.assignedTo = null;
    } else {
      assertShape(
        isOptionalText(c.assignedTo, 200),
        "Nieprawidłowy przypisany domownik",
        "INVALID_ASSIGNED_TO",
      );
      changes.assignedTo = c.assignedTo;
    }
  }
  return { id: payload.id, changes, baseVersion: version };
}

// ---------------------------------------------------------------------------
// Mutation envelope + supported ops
// ---------------------------------------------------------------------------

export const SUPPORTED_MEAL_OPS = new Set([
  "recipe.create",
  "recipe.update",
  "recipe.delete",
  "meal.create",
  "meal.update",
  "meal.delete",
  "shopping.create",
  "shopping.update",
  "shopping.delete",
]);

// Whole-request-shape validation, mirroring assertTripMutationShape: called once per mutation
// BEFORE any DB work starts, so one malformed entry can't partially poison sibling mutations'
// bookkeeping. Per-mutation *business* validation (bad field values, missing recipe, ...) is
// reported as `status: "error"` inside `results` by applyMealMutation instead.
export function assertMealMutationShape(mutation) {
  if (!isPlainObject(mutation)) {
    throw mealRequestError(400, "Nieprawidłowy kształt mutacji", "INVALID_MEAL_MUTATION");
  }
  if (typeof mutation.idempotencyKey !== "string" || !UUID_PATTERN.test(mutation.idempotencyKey)) {
    throw mealRequestError(400, "Nieprawidłowy klucz idempotencji", "INVALID_IDEMPOTENCY_KEY");
  }
  if (typeof mutation.op !== "string" || !SUPPORTED_MEAL_OPS.has(mutation.op)) {
    throw mealRequestError(400, "Nieobsługiwana operacja mutacji", "UNSUPPORTED_OP");
  }
  if (!isPlainObject(mutation.payload)) {
    throw mealRequestError(400, "Brak danych mutacji", "INVALID_MEAL_MUTATION");
  }
  if (
    mutation.baseVersion !== undefined &&
    mutation.baseVersion !== null &&
    !Number.isInteger(mutation.baseVersion)
  ) {
    throw mealRequestError(400, "Nieprawidłowa wersja bazowa mutacji", "INVALID_MEAL_MUTATION");
  }
}

export const MAX_MEAL_MUTATIONS_PER_BATCH = Number(process.env.MAX_MEAL_MUTATIONS ?? 500);
export const MAX_MEAL_MUTATIONS_BYTES = Number(process.env.MAX_MEAL_MUTATIONS_BYTES ?? 2_000_000);

// ---------------------------------------------------------------------------
// Snapshot read (GET /api/v1/meals): whole household, no visibility filter -- meals are always
// shared.
// ---------------------------------------------------------------------------

export async function readMealsSnapshot(client, householdId) {
  // Sequential, not Promise.all: `client` may be a single-connection PoolClient, and node-postgres
  // only supports one in-flight query per connection (see trips.mjs's readTripsSnapshot).
  const recipes = await client.query(
    `SELECT ${RECIPE_SELECT_COLUMNS} FROM recipes WHERE household_id = $1 ORDER BY created_at`,
    [householdId],
  );
  const mealSlots = await client.query(
    `SELECT ${MEAL_SLOT_SELECT_COLUMNS} FROM meal_slots WHERE household_id = $1
      ORDER BY date, type, created_at`,
    [householdId],
  );
  const shoppingItems = await client.query(
    `SELECT ${SHOPPING_ITEM_SELECT_COLUMNS} FROM shopping_items WHERE household_id = $1
      ORDER BY created_at`,
    [householdId],
  );
  return {
    recipes: recipes.rows.map(recipeRowToDto),
    mealSlots: mealSlots.rows.map(mealSlotRowToDto),
    shoppingItems: shoppingItems.rows.map(shoppingItemRowToDto),
  };
}

// Wspiera "Wyczyść dane aplikacji" (SettingsPage.tsx danger zone). Unlike Trips (which relies on
// `ON DELETE CASCADE` from `trips`), the `recipes` FK here is `ON DELETE SET NULL` -- a bare
// `DELETE FROM recipes` would NOT remove meal_slots/shopping_items, only unlink them. Delete all
// three tables explicitly, children before parent (docs/plans/lista-zakupow-meals.md "Ryzyka").
export async function resetMealsForHousehold(client, householdId) {
  await client.query(`DELETE FROM shopping_items WHERE household_id = $1`, [householdId]);
  await client.query(`DELETE FROM meal_slots WHERE household_id = $1`, [householdId]);
  await client.query(`DELETE FROM recipes WHERE household_id = $1`, [householdId]);
}

// ---------------------------------------------------------------------------
// Shared OCC/conflict resolution helpers used by every update/delete op (mirrors trips.mjs).
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

// Checks that a recipe exists in the caller's household before an insert/update that would
// otherwise fail with 23503 (foreign_key_violation) on a bad recipeId/sourceRecipeId
// (docs/plans/lista-zakupow-meals.md "meal.create/shopping.create a walidacja recipeId", wzór
// tripCheck w execItineraryCreate).
async function recipeExists(client, recipeId, householdId) {
  if (!recipeId) return true;
  const result = await client.query(`SELECT id FROM recipes WHERE id = $1 AND household_id = $2`, [
    recipeId,
    householdId,
  ]);
  return Boolean(result.rowCount);
}

// ---------------------------------------------------------------------------
// Per-op SQL execution. Each function assumes payload/baseVersion have already been shape-checked
// by assertMealMutationShape; they still run their own (business-rule) validators and throw
// MealValidationError on bad input, which applyMealMutation turns into `status: "error"`.
// ---------------------------------------------------------------------------

async function execRecipeCreate(client, ctx, payload) {
  const data = validateRecipeCreatePayload(payload);
  try {
    const inserted = await client.query(
      `INSERT INTO recipes (id, household_id, name, minutes, servings, tags, ingredients, favorite, version, updated_by)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8, 1, $9)
       RETURNING ${RECIPE_SELECT_COLUMNS}`,
      [
        data.id,
        ctx.householdId,
        data.name,
        data.minutes,
        data.servings,
        JSON.stringify(data.tags),
        JSON.stringify(data.ingredients),
        data.favorite,
        ctx.userId,
      ],
    );
    return { status: "applied", record: recipeRowToDto(inserted.rows[0]) };
  } catch (error) {
    if (error.code === "23505") {
      return resolveConflictOrError(
        client,
        `SELECT ${RECIPE_SELECT_COLUMNS} FROM recipes WHERE id = $1 AND household_id = $2`,
        [data.id, ctx.householdId],
        recipeRowToDto,
        "Identyfikator jest już używany",
        "ID_TAKEN",
      );
    }
    throw error;
  }
}

async function execRecipeUpdate(client, ctx, payload, baseVersion) {
  const { id, changes, baseVersion: version } = validateRecipeUpdatePayload(payload, baseVersion);
  const updated = await client.query(
    `UPDATE recipes
        SET name = COALESCE($1, name),
            minutes = COALESCE($2, minutes),
            servings = COALESCE($3, servings),
            tags = COALESCE($4::jsonb, tags),
            ingredients = COALESCE($5::jsonb, ingredients),
            favorite = COALESCE($6, favorite),
            version = version + 1,
            updated_at = now(),
            updated_by = $7
      WHERE id = $8 AND household_id = $9 AND version = $10
      RETURNING ${RECIPE_SELECT_COLUMNS}`,
    [
      changes.name ?? null,
      changes.minutes ?? null,
      changes.servings ?? null,
      changes.tags !== undefined ? JSON.stringify(changes.tags) : null,
      changes.ingredients !== undefined ? JSON.stringify(changes.ingredients) : null,
      changes.favorite ?? null,
      ctx.userId,
      id,
      ctx.householdId,
      version,
    ],
  );
  if (updated.rowCount) return { status: "applied", record: recipeRowToDto(updated.rows[0]) };
  return resolveConflictOrError(
    client,
    `SELECT ${RECIPE_SELECT_COLUMNS} FROM recipes WHERE id = $1 AND household_id = $2`,
    [id, ctx.householdId],
    recipeRowToDto,
    "Rekord nie istnieje lub jest niedostępny",
    "NOT_FOUND",
  );
}

// Plain DELETE with optional OCC -- the FK `ON DELETE SET NULL` unlinks meal_slots.recipe_id and
// shopping_items.source_recipe_id automatically (docs/plans/lista-zakupow-meals.md "Ryzyka": this
// does NOT bump those children's `version`; the client unlinks them locally/optimistically).
async function execRecipeDelete(client, ctx, payload, baseVersion) {
  const { id } = validateDeleteIdPayload(payload);
  const version = normalizeOptionalVersion(baseVersion);
  const deleted = await client.query(
    `DELETE FROM recipes WHERE id = $1 AND household_id = $2 AND ($3::integer IS NULL OR version = $3)
     RETURNING id`,
    [id, ctx.householdId, version],
  );
  if (deleted.rowCount) return { status: "applied", record: null };
  return resolveConflictOrGone(
    client,
    `SELECT ${RECIPE_SELECT_COLUMNS} FROM recipes WHERE id = $1 AND household_id = $2`,
    [id, ctx.householdId],
    recipeRowToDto,
  );
}

async function execMealCreate(client, ctx, payload) {
  const data = validateMealCreatePayload(payload);
  if (data.recipeId && !(await recipeExists(client, data.recipeId, ctx.householdId))) {
    return {
      status: "error",
      error: "Przepis nie istnieje lub jest niedostępny",
      code: "RECIPE_NOT_FOUND",
    };
  }
  try {
    const inserted = await client.query(
      `INSERT INTO meal_slots (id, household_id, recipe_id, date, type, title, servings, version, updated_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 1, $8)
       RETURNING ${MEAL_SLOT_SELECT_COLUMNS}`,
      [
        data.id,
        ctx.householdId,
        data.recipeId ?? null,
        data.date,
        data.type,
        data.title,
        data.servings,
        ctx.userId,
      ],
    );
    return { status: "applied", record: mealSlotRowToDto(inserted.rows[0]) };
  } catch (error) {
    if (error.code === "23505") {
      return resolveConflictOrError(
        client,
        `SELECT ${MEAL_SLOT_SELECT_COLUMNS} FROM meal_slots WHERE id = $1 AND household_id = $2`,
        [data.id, ctx.householdId],
        mealSlotRowToDto,
        "Identyfikator jest już używany",
        "ID_TAKEN",
      );
    }
    throw error;
  }
}

async function execMealUpdate(client, ctx, payload, baseVersion) {
  const { id, changes, baseVersion: version } = validateMealUpdatePayload(payload, baseVersion);
  if (
    Object.prototype.hasOwnProperty.call(changes, "recipeId") &&
    changes.recipeId &&
    !(await recipeExists(client, changes.recipeId, ctx.householdId))
  ) {
    return {
      status: "error",
      error: "Przepis nie istnieje lub jest niedostępny",
      code: "RECIPE_NOT_FOUND",
    };
  }
  const hasRecipeIdChange = Object.prototype.hasOwnProperty.call(changes, "recipeId");
  const updated = await client.query(
    `UPDATE meal_slots
        SET recipe_id = CASE WHEN $1 THEN $2 ELSE recipe_id END,
            date = COALESCE($3, date),
            type = COALESCE($4, type),
            title = COALESCE($5, title),
            servings = COALESCE($6, servings),
            version = version + 1,
            updated_at = now(),
            updated_by = $7
      WHERE id = $8 AND household_id = $9 AND version = $10
      RETURNING ${MEAL_SLOT_SELECT_COLUMNS}`,
    [
      hasRecipeIdChange,
      hasRecipeIdChange ? changes.recipeId : null,
      changes.date ?? null,
      changes.type ?? null,
      changes.title ?? null,
      changes.servings ?? null,
      ctx.userId,
      id,
      ctx.householdId,
      version,
    ],
  );
  if (updated.rowCount) return { status: "applied", record: mealSlotRowToDto(updated.rows[0]) };
  return resolveConflictOrError(
    client,
    `SELECT ${MEAL_SLOT_SELECT_COLUMNS} FROM meal_slots WHERE id = $1 AND household_id = $2`,
    [id, ctx.householdId],
    mealSlotRowToDto,
    "Rekord nie istnieje lub jest niedostępny",
    "NOT_FOUND",
  );
}

async function execMealDelete(client, ctx, payload, baseVersion) {
  const { id } = validateDeleteIdPayload(payload);
  const version = normalizeOptionalVersion(baseVersion);
  const deleted = await client.query(
    `DELETE FROM meal_slots WHERE id = $1 AND household_id = $2 AND ($3::integer IS NULL OR version = $3)
     RETURNING id`,
    [id, ctx.householdId, version],
  );
  if (deleted.rowCount) return { status: "applied", record: null };
  return resolveConflictOrGone(
    client,
    `SELECT ${MEAL_SLOT_SELECT_COLUMNS} FROM meal_slots WHERE id = $1 AND household_id = $2`,
    [id, ctx.householdId],
    mealSlotRowToDto,
  );
}

async function execShoppingCreate(client, ctx, payload) {
  const data = validateShoppingCreatePayload(payload);
  if (data.sourceRecipeId && !(await recipeExists(client, data.sourceRecipeId, ctx.householdId))) {
    return {
      status: "error",
      error: "Przepis nie istnieje lub jest niedostępny",
      code: "RECIPE_NOT_FOUND",
    };
  }
  try {
    const inserted = await client.query(
      `INSERT INTO shopping_items
         (id, household_id, source_recipe_id, name, quantity, category, checked, assigned_to, version, updated_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 1, $9)
       RETURNING ${SHOPPING_ITEM_SELECT_COLUMNS}`,
      [
        data.id,
        ctx.householdId,
        data.sourceRecipeId ?? null,
        data.name,
        data.quantity,
        data.category,
        data.checked,
        data.assignedTo ?? null,
        ctx.userId,
      ],
    );
    return { status: "applied", record: shoppingItemRowToDto(inserted.rows[0]) };
  } catch (error) {
    if (error.code === "23505") {
      return resolveConflictOrError(
        client,
        `SELECT ${SHOPPING_ITEM_SELECT_COLUMNS} FROM shopping_items WHERE id = $1 AND household_id = $2`,
        [data.id, ctx.householdId],
        shoppingItemRowToDto,
        "Identyfikator jest już używany",
        "ID_TAKEN",
      );
    }
    throw error;
  }
}

async function execShoppingUpdate(client, ctx, payload, baseVersion) {
  const { id, changes, baseVersion: version } = validateShoppingUpdatePayload(payload, baseVersion);
  const hasAssignedToChange = Object.prototype.hasOwnProperty.call(changes, "assignedTo");
  const updated = await client.query(
    `UPDATE shopping_items
        SET checked = COALESCE($1, checked),
            name = COALESCE($2, name),
            quantity = COALESCE($3, quantity),
            category = COALESCE($4, category),
            assigned_to = CASE WHEN $5 THEN $6 ELSE assigned_to END,
            version = version + 1,
            updated_at = now(),
            updated_by = $7
      WHERE id = $8 AND household_id = $9 AND version = $10
      RETURNING ${SHOPPING_ITEM_SELECT_COLUMNS}`,
    [
      changes.checked ?? null,
      changes.name ?? null,
      changes.quantity ?? null,
      changes.category ?? null,
      hasAssignedToChange,
      hasAssignedToChange ? changes.assignedTo : null,
      ctx.userId,
      id,
      ctx.householdId,
      version,
    ],
  );
  if (updated.rowCount) return { status: "applied", record: shoppingItemRowToDto(updated.rows[0]) };
  return resolveConflictOrError(
    client,
    `SELECT ${SHOPPING_ITEM_SELECT_COLUMNS} FROM shopping_items WHERE id = $1 AND household_id = $2`,
    [id, ctx.householdId],
    shoppingItemRowToDto,
    "Rekord nie istnieje lub jest niedostępny",
    "NOT_FOUND",
  );
}

async function execShoppingDelete(client, ctx, payload, baseVersion) {
  const { id } = validateDeleteIdPayload(payload);
  const version = normalizeOptionalVersion(baseVersion);
  const deleted = await client.query(
    `DELETE FROM shopping_items
      WHERE id = $1 AND household_id = $2 AND ($3::integer IS NULL OR version = $3)
     RETURNING id`,
    [id, ctx.householdId, version],
  );
  if (deleted.rowCount) return { status: "applied", record: null };
  return resolveConflictOrGone(
    client,
    `SELECT ${SHOPPING_ITEM_SELECT_COLUMNS} FROM shopping_items WHERE id = $1 AND household_id = $2`,
    [id, ctx.householdId],
    shoppingItemRowToDto,
  );
}

async function executeMealOp(client, ctx, op, payload, baseVersion) {
  switch (op) {
    case "recipe.create":
      return execRecipeCreate(client, ctx, payload);
    case "recipe.update":
      return execRecipeUpdate(client, ctx, payload, baseVersion);
    case "recipe.delete":
      return execRecipeDelete(client, ctx, payload, baseVersion);
    case "meal.create":
      return execMealCreate(client, ctx, payload);
    case "meal.update":
      return execMealUpdate(client, ctx, payload, baseVersion);
    case "meal.delete":
      return execMealDelete(client, ctx, payload, baseVersion);
    case "shopping.create":
      return execShoppingCreate(client, ctx, payload);
    case "shopping.update":
      return execShoppingUpdate(client, ctx, payload, baseVersion);
    case "shopping.delete":
      return execShoppingDelete(client, ctx, payload, baseVersion);
    default:
      // Unreachable when called through applyMealMutation (assertMealMutationShape already
      // rejected unknown ops at the request level); kept defensive in case of direct unit-test
      // calls.
      throw new MealValidationError(`Nieobsługiwana operacja: ${op}`, "UNSUPPORTED_OP");
  }
}

// ---------------------------------------------------------------------------
// Idempotent mutation entry point. `mutation` is assumed to already have passed
// assertMealMutationShape (server.mjs validates the whole batch upfront). ctx = { householdId,
// userId } always comes from the authenticated session, never from the request body.
// ---------------------------------------------------------------------------

export async function applyMealMutation(client, ctx, mutation) {
  const { idempotencyKey, op, payload, baseVersion } = mutation;

  // Claim the idempotency key first, inside the same DB transaction as the operation itself: if
  // the op below throws, the whole transaction (including this claim) rolls back, so the key
  // remains free to retry. If a row already existed, this was a retry -- return the previously
  // stored result instead of running the operation again.
  const claim = await client.query(
    `INSERT INTO meal_mutations (idempotency_key, household_id, user_id, op, result)
     VALUES ($1, $2, $3, $4, '{}'::jsonb)
     ON CONFLICT (idempotency_key) DO NOTHING`,
    [idempotencyKey, ctx.householdId, ctx.userId, op],
  );
  if (!claim.rowCount) {
    const existing = await client.query(
      `SELECT result FROM meal_mutations WHERE idempotency_key = $1`,
      [idempotencyKey],
    );
    return existing.rows[0]?.result ?? { idempotencyKey, status: "duplicate" };
  }

  let outcome;
  try {
    outcome = await executeMealOp(client, ctx, op, payload, baseVersion);
  } catch (error) {
    if (error instanceof MealValidationError) {
      outcome = { status: "error", error: error.message, code: error.code };
    } else {
      throw error;
    }
  }

  const result = { idempotencyKey, ...outcome };
  await client.query(`UPDATE meal_mutations SET result = $1::jsonb WHERE idempotency_key = $2`, [
    JSON.stringify(result),
    idempotencyKey,
  ]);
  return result;
}
