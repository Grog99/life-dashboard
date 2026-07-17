import assert from "node:assert/strict";
import test, { after } from "node:test";
import { randomUUID } from "node:crypto";
import pg from "pg";
import {
  SUPPORTED_MEAL_OPS,
  applyMealMutation,
  assertMealMutationShape,
  mealSlotRowToDto,
  readMealsSnapshot,
  recipeRowToDto,
  resetMealsForHousehold,
  resolveVersionConflict,
  shoppingItemRowToDto,
  validateDeleteIdPayload,
  validateMealCreatePayload,
  validateMealUpdatePayload,
  validateRecipeCreatePayload,
  validateRecipeUpdatePayload,
  validateShoppingCreatePayload,
  validateShoppingUpdatePayload,
} from "../src/meals.mjs";

// ---------------------------------------------------------------------------
// Pure unit tests -- no database required, always run (including in CI).
// ---------------------------------------------------------------------------

test("resolveVersionConflict compares the client's assumed version against the stored one", () => {
  assert.equal(resolveVersionConflict(1, 1), true);
  assert.equal(resolveVersionConflict(1, 2), false);
  assert.equal(resolveVersionConflict("1", 1), true);
});

test("validateRecipeCreatePayload accepts a valid payload and trims/normalizes fields", () => {
  const data = validateRecipeCreatePayload({
    id: "recipe-1",
    name: " Naleśniki ",
    minutes: 20,
    servings: 4,
    tags: ["śniadanie"],
    ingredients: ["mąka 200g", "mleko 300ml"],
  });
  assert.equal(data.name, "Naleśniki");
  assert.equal(data.favorite, false, "favorite defaults to false when omitted");
  assert.deepEqual(data.tags, ["śniadanie"]);
});

test("validateRecipeCreatePayload rejects invalid minutes/servings", () => {
  assert.throws(
    () =>
      validateRecipeCreatePayload({
        id: "recipe-1",
        name: "Naleśniki",
        minutes: 0,
        servings: 4,
        tags: [],
        ingredients: [],
      }),
    (error) => error.code === "INVALID_MINUTES",
  );
  assert.throws(
    () =>
      validateRecipeCreatePayload({
        id: "recipe-1",
        name: "Naleśniki",
        minutes: 20,
        servings: 0,
        tags: [],
        ingredients: [],
      }),
    (error) => error.code === "INVALID_SERVINGS",
  );
});

test("validateRecipeUpdatePayload only allows RECIPE_UPDATE_KEYS fields", () => {
  const { changes } = validateRecipeUpdatePayload(
    { id: "recipe-1", changes: { favorite: true } },
    1,
  );
  assert.deepEqual(changes, { favorite: true });
  assert.throws(
    () => validateRecipeUpdatePayload({ id: "recipe-1", changes: { id: "other" } }, 1),
    (error) => error.code === "INVALID_CHANGES",
  );
});

test("validateRecipeUpdatePayload requires a positive integer baseVersion", () => {
  assert.throws(
    () => validateRecipeUpdatePayload({ id: "recipe-1", changes: { favorite: true } }, undefined),
    (error) => error.code === "INVALID_BASE_VERSION",
  );
  assert.throws(
    () => validateRecipeUpdatePayload({ id: "recipe-1", changes: { favorite: true } }, 0),
    (error) => error.code === "INVALID_BASE_VERSION",
  );
});

test("validateMealCreatePayload validates ISO date and meal type, tolerates a shape-valid recipeId", () => {
  assert.throws(
    () =>
      validateMealCreatePayload({
        id: "meal-1",
        date: "2026-13-40",
        type: "lunch",
        title: "Obiad",
        servings: 2,
      }),
    (error) => error.code === "INVALID_DATE",
  );
  assert.throws(
    () =>
      validateMealCreatePayload({
        id: "meal-1",
        date: "2026-08-01",
        type: "brunch",
        title: "Obiad",
        servings: 2,
      }),
    (error) => error.code === "INVALID_TYPE",
  );
  const data = validateMealCreatePayload({
    id: "meal-1",
    date: "2026-08-01",
    type: "lunch",
    recipeId: "does-not-exist-yet",
    title: "Obiad",
    servings: 2,
  });
  assert.equal(data.recipeId, "does-not-exist-yet", "shape validator does not check existence");
});

test("validateMealUpdatePayload allows explicitly clearing recipeId to null", () => {
  const { changes } = validateMealUpdatePayload({ id: "meal-1", changes: { recipeId: null } }, 1);
  assert.equal(changes.recipeId, null);
  const { changes: changesFromEmpty } = validateMealUpdatePayload(
    { id: "meal-1", changes: { recipeId: "" } },
    1,
  );
  assert.equal(changesFromEmpty.recipeId, null);
});

test("validateMealUpdatePayload only allows MEAL_UPDATE_KEYS fields", () => {
  assert.throws(
    () => validateMealUpdatePayload({ id: "meal-1", changes: { checked: true } }, 1),
    (error) => error.code === "INVALID_CHANGES",
  );
});

test("validateShoppingCreatePayload tolerates an empty category (parity with shoppingItemSchema)", () => {
  const data = validateShoppingCreatePayload({
    id: "item-1",
    name: "Mleko",
    category: "",
  });
  assert.equal(data.category, "");
  assert.equal(data.quantity, "");
  assert.equal(data.checked, false);
});

test("validateShoppingCreatePayload rejects an empty name (unlike category)", () => {
  assert.throws(
    () => validateShoppingCreatePayload({ id: "item-1", name: "   ", category: "Nabiał" }),
    (error) => error.code === "INVALID_NAME",
  );
});

test("validateShoppingUpdatePayload allows explicitly clearing assignedTo to null", () => {
  const { changes } = validateShoppingUpdatePayload(
    { id: "item-1", changes: { assignedTo: null } },
    1,
  );
  assert.equal(changes.assignedTo, null);
});

test("validateShoppingUpdatePayload only allows SHOPPING_UPDATE_KEYS fields", () => {
  assert.throws(
    () => validateShoppingUpdatePayload({ id: "item-1", changes: { sourceRecipeId: "x" } }, 1),
    (error) => error.code === "INVALID_CHANGES",
  );
});

test("validateDeleteIdPayload requires a valid id", () => {
  assert.throws(
    () => validateDeleteIdPayload({}),
    (error) => error.code === "INVALID_ID",
  );
  assert.deepEqual(validateDeleteIdPayload({ id: "item-1" }), { id: "item-1" });
});

test("assertMealMutationShape validates the whole-request envelope", () => {
  const valid = { idempotencyKey: randomUUID(), op: "recipe.create", payload: { id: "recipe-1" } };
  assert.doesNotThrow(() => assertMealMutationShape(valid));
  assert.throws(
    () => assertMealMutationShape({ ...valid, idempotencyKey: "not-a-uuid" }),
    (error) => error.statusCode === 400 && error.code === "INVALID_IDEMPOTENCY_KEY",
  );
  assert.throws(
    () => assertMealMutationShape({ ...valid, op: "recipe.archive" }),
    (error) => error.statusCode === 400 && error.code === "UNSUPPORTED_OP",
  );
  assert.throws(
    () => assertMealMutationShape({ ...valid, payload: "nope" }),
    (error) => error.statusCode === 400,
  );
  assert.equal(
    SUPPORTED_MEAL_OPS.size,
    9,
    "exactly the 9 ops the plan enumerates, no bulk ops (YAGNI)",
  );
});

test("row->DTO mappers convert snake_case/null columns and Date to the frontend shape", () => {
  const recipe = recipeRowToDto({
    id: "recipe-1",
    name: "Naleśniki",
    minutes: 20,
    servings: 4,
    tags: ["śniadanie"],
    ingredients: ["mąka 200g"],
    favorite: true,
    version: 2,
    updated_at: new Date("2026-07-01T10:00:00.000Z"),
  });
  assert.equal(recipe.updatedAt, "2026-07-01T10:00:00.000Z");
  assert.equal("ownerId" in recipe, false, "Recipe no longer extends SharedMeta");
  assert.equal("visibility" in recipe, false, "Recipe no longer extends SharedMeta");

  const mealSlot = mealSlotRowToDto({
    id: "meal-1",
    recipe_id: null,
    date: "2026-08-01",
    type: "lunch",
    title: "Obiad",
    servings: 2,
    version: 1,
    updated_at: new Date("2026-07-01T10:00:00.000Z"),
  });
  assert.equal(mealSlot.recipeId, undefined, "null recipe_id maps to undefined, not null");

  const shoppingItem = shoppingItemRowToDto({
    id: "item-1",
    source_recipe_id: null,
    name: "Mleko",
    quantity: "1L",
    category: "Nabiał",
    checked: false,
    assigned_to: null,
    version: 1,
    updated_at: new Date("2026-07-01T10:00:00.000Z"),
  });
  assert.equal(shoppingItem.sourceRecipeId, undefined);
  assert.equal(shoppingItem.assignedTo, undefined);
});

// ---------------------------------------------------------------------------
// DB-backed integration tests. `npm run test:server` in CI does not provision a Postgres instance, so
// these are automatically skipped there via a short connectivity probe (see trips.node.mjs).
//
// To run them: create+migrate a local Postgres (see server/migrations, server/src/migrate.mjs) and
// point PGHOST/PGPORT/PGUSER/PGPASSWORD/PGDATABASE (or DATABASE_URL) at it before `npm test`.
// ---------------------------------------------------------------------------

async function probeDatabase() {
  const client = new pg.Client({
    ...(process.env.DATABASE_URL
      ? { connectionString: process.env.DATABASE_URL }
      : {
          host: process.env.PGHOST ?? "db",
          port: Number(process.env.PGPORT ?? 5432),
          user: process.env.PGUSER ?? "puls",
          password: process.env.PGPASSWORD,
          database: process.env.PGDATABASE ?? "puls",
        }),
    connectionTimeoutMillis: 1500,
  });
  try {
    await client.connect();
    await client.end();
    return true;
  } catch {
    await client.end().catch(() => {});
    return false;
  }
}

const dbAvailable = await probeDatabase();

function dbTest(name, fn) {
  if (dbAvailable) {
    test(name, fn);
  } else {
    test(
      name,
      { skip: "no local Postgres reachable (see server/migrations to set one up)" },
      () => {},
    );
  }
}

let pool;
if (dbAvailable) {
  ({ pool } = await import("../src/db.mjs"));
  after(async () => {
    await pool.end();
  });
}

async function withRollback(fn) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await fn(client);
  } finally {
    await client.query("ROLLBACK").catch(() => {});
    client.release();
  }
}

async function createHouseholdAndUser(client, label) {
  const email = `meals-test-${randomUUID()}@example.com`;
  const user = await client.query(
    `INSERT INTO users(email, display_name, password_hash) VALUES ($1, $2, 'test-hash') RETURNING id`,
    [email, label],
  );
  const userId = user.rows[0].id;
  const household = await client.query(
    `INSERT INTO households(name, created_by) VALUES ($1, $2) RETURNING id`,
    [`${label} household`, userId],
  );
  const householdId = household.rows[0].id;
  await client.query(
    `INSERT INTO household_members(household_id, user_id, role) VALUES ($1, $2, 'owner')`,
    [householdId, userId],
  );
  return { householdId, userId };
}

function recipeCreatePayload(overrides = {}) {
  return {
    id: randomUUID(),
    name: "Naleśniki",
    minutes: 20,
    servings: 4,
    tags: ["śniadanie"],
    ingredients: ["mąka 200g", "mleko 300ml"],
    ...overrides,
  };
}

function mealCreatePayload(overrides = {}) {
  return {
    id: randomUUID(),
    date: "2026-08-01",
    type: "lunch",
    title: "Obiad",
    servings: 2,
    ...overrides,
  };
}

function shoppingCreatePayload(overrides = {}) {
  return {
    id: randomUUID(),
    name: "Mleko",
    quantity: "1L",
    category: "Nabiał",
    ...overrides,
  };
}

dbTest("readMealsSnapshot returns the whole household's meals (no visibility filter)", async () => {
  await withRollback(async (client) => {
    const { householdId, userId } = await createHouseholdAndUser(client, "owner");
    const ctx = { householdId, userId };
    await applyMealMutation(client, ctx, {
      idempotencyKey: randomUUID(),
      op: "recipe.create",
      payload: recipeCreatePayload({ name: "Zupa pomidorowa" }),
    });
    const snapshot = await readMealsSnapshot(client, householdId);
    assert.deepEqual(
      snapshot.recipes.map((recipe) => recipe.name),
      ["Zupa pomidorowa"],
    );
    assert.deepEqual(snapshot.mealSlots, []);
    assert.deepEqual(snapshot.shoppingItems, []);
  });
});

dbTest("household_id is always taken from the session, never from the payload", async () => {
  await withRollback(async (client) => {
    const { householdId, userId } = await createHouseholdAndUser(client, "owner");
    const other = await createHouseholdAndUser(client, "other");
    const ctx = { householdId, userId };
    const result = await applyMealMutation(client, ctx, {
      idempotencyKey: randomUUID(),
      op: "recipe.create",
      payload: recipeCreatePayload({ householdId: other.householdId }),
    });
    assert.equal(result.status, "applied");
    const snapshotForOther = await readMealsSnapshot(client, other.householdId);
    assert.deepEqual(snapshotForOther.recipes, []);
    const snapshotForOwner = await readMealsSnapshot(client, householdId);
    assert.equal(snapshotForOwner.recipes.length, 1);
  });
});

dbTest(
  "meal.create/shopping.create reject a recipeId/sourceRecipeId that doesn't exist in this household",
  async () => {
    await withRollback(async (client) => {
      const { householdId, userId } = await createHouseholdAndUser(client, "owner");
      const ctx = { householdId, userId };

      const mealResult = await applyMealMutation(client, ctx, {
        idempotencyKey: randomUUID(),
        op: "meal.create",
        payload: mealCreatePayload({ recipeId: "does-not-exist" }),
      });
      assert.equal(mealResult.status, "error");
      assert.equal(mealResult.code, "RECIPE_NOT_FOUND");

      const shoppingResult = await applyMealMutation(client, ctx, {
        idempotencyKey: randomUUID(),
        op: "shopping.create",
        payload: shoppingCreatePayload({ sourceRecipeId: "does-not-exist" }),
      });
      assert.equal(shoppingResult.status, "error");
      assert.equal(shoppingResult.code, "RECIPE_NOT_FOUND");

      // Neither error op leaves a row behind.
      const snapshot = await readMealsSnapshot(client, householdId);
      assert.deepEqual(snapshot.mealSlots, []);
      assert.deepEqual(snapshot.shoppingItems, []);
    });
  },
);

dbTest(
  "meal.update rejects switching to a recipeId that doesn't exist in this household",
  async () => {
    await withRollback(async (client) => {
      const { householdId, userId } = await createHouseholdAndUser(client, "owner");
      const ctx = { householdId, userId };
      const mealId = randomUUID();
      const created = await applyMealMutation(client, ctx, {
        idempotencyKey: randomUUID(),
        op: "meal.create",
        payload: mealCreatePayload({ id: mealId }),
      });
      const updateResult = await applyMealMutation(client, ctx, {
        idempotencyKey: randomUUID(),
        op: "meal.update",
        payload: { id: mealId, changes: { recipeId: "does-not-exist" } },
        baseVersion: created.record.version,
      });
      assert.equal(updateResult.status, "error");
      assert.equal(updateResult.code, "RECIPE_NOT_FOUND");
    });
  },
);

dbTest(
  "recipe.delete unlinks (not deletes) meal_slots/shopping_items via ON DELETE SET NULL, " +
    "and deliberately does NOT bump their version (documented plan risk, not a bug)",
  async () => {
    await withRollback(async (client) => {
      const { householdId, userId } = await createHouseholdAndUser(client, "owner");
      const ctx = { householdId, userId };
      const recipeId = randomUUID();
      await applyMealMutation(client, ctx, {
        idempotencyKey: randomUUID(),
        op: "recipe.create",
        payload: recipeCreatePayload({ id: recipeId }),
      });
      const mealId = randomUUID();
      const mealCreated = await applyMealMutation(client, ctx, {
        idempotencyKey: randomUUID(),
        op: "meal.create",
        payload: mealCreatePayload({ id: mealId, recipeId }),
      });
      const itemId = randomUUID();
      const itemCreated = await applyMealMutation(client, ctx, {
        idempotencyKey: randomUUID(),
        op: "shopping.create",
        payload: shoppingCreatePayload({ id: itemId, sourceRecipeId: recipeId }),
      });
      assert.equal(mealCreated.record.version, 1);
      assert.equal(itemCreated.record.version, 1);

      const deleteResult = await applyMealMutation(client, ctx, {
        idempotencyKey: randomUUID(),
        op: "recipe.delete",
        payload: { id: recipeId },
      });
      assert.equal(deleteResult.status, "applied");

      const snapshot = await readMealsSnapshot(client, householdId);
      assert.deepEqual(snapshot.recipes, []);
      // Children survive, still present, just unlinked.
      assert.equal(snapshot.mealSlots.length, 1);
      assert.equal(snapshot.mealSlots[0].id, mealId);
      assert.equal(snapshot.mealSlots[0].recipeId, undefined);
      // Deliberate: version does NOT bump from the FK-driven SET NULL.
      assert.equal(snapshot.mealSlots[0].version, 1);
      assert.equal(snapshot.shoppingItems.length, 1);
      assert.equal(snapshot.shoppingItems[0].id, itemId);
      assert.equal(snapshot.shoppingItems[0].sourceRecipeId, undefined);
      assert.equal(snapshot.shoppingItems[0].version, 1);
    });
  },
);

dbTest(
  "retrying a mutation with the same idempotency key returns the stored result, not a new row",
  async () => {
    await withRollback(async (client) => {
      const { householdId, userId } = await createHouseholdAndUser(client, "owner");
      const ctx = { householdId, userId };
      const mutation = {
        idempotencyKey: randomUUID(),
        op: "recipe.create",
        payload: recipeCreatePayload({ favorite: true }),
      };
      const first = await applyMealMutation(client, ctx, mutation);
      const second = await applyMealMutation(client, ctx, mutation);
      assert.equal(first.status, "applied");
      assert.deepEqual(second, first);
      const count = await client.query(
        "SELECT count(*)::int AS count FROM recipes WHERE household_id = $1",
        [householdId],
      );
      assert.equal(count.rows[0].count, 1);
    });
  },
);

dbTest(
  "OCC conflict is per-record: a stale baseVersion conflicts only for that record, " +
    "the rest of the batch still applies",
  async () => {
    await withRollback(async (client) => {
      const { householdId, userId } = await createHouseholdAndUser(client, "owner");
      const ctx = { householdId, userId };
      const staleRecipeId = randomUUID();
      const freshRecipeId = randomUUID();
      await applyMealMutation(client, ctx, {
        idempotencyKey: randomUUID(),
        op: "recipe.create",
        payload: recipeCreatePayload({ id: staleRecipeId, name: "Zupa" }),
      });
      await applyMealMutation(client, ctx, {
        idempotencyKey: randomUUID(),
        op: "recipe.create",
        payload: recipeCreatePayload({ id: freshRecipeId, name: "Sałatka" }),
      });
      // Someone else bumps staleRecipeId's version to 2 first.
      const bumped = await applyMealMutation(client, ctx, {
        idempotencyKey: randomUUID(),
        op: "recipe.update",
        payload: { id: staleRecipeId, changes: { favorite: true } },
        baseVersion: 1,
      });
      assert.equal(bumped.status, "applied");
      assert.equal(bumped.record.version, 2);

      // A "batch" of two update mutations: one stale (version 1, now conflicting), one against the
      // untouched record -- applied sequentially, matching how the server processes a real batch.
      const staleUpdate = await applyMealMutation(client, ctx, {
        idempotencyKey: randomUUID(),
        op: "recipe.update",
        payload: { id: staleRecipeId, changes: { name: "Inna zupa" } },
        baseVersion: 1,
      });
      const freshUpdate = await applyMealMutation(client, ctx, {
        idempotencyKey: randomUUID(),
        op: "recipe.update",
        payload: { id: freshRecipeId, changes: { name: "Inna sałatka" } },
        baseVersion: 1,
      });

      assert.equal(staleUpdate.status, "conflict");
      assert.equal(staleUpdate.currentVersion, 2);
      assert.equal(staleUpdate.record.name, "Zupa", "unaffected by the rejected stale update");

      assert.equal(freshUpdate.status, "applied");
      assert.equal(freshUpdate.record.name, "Inna sałatka");
    });
  },
);

dbTest("shopping.update: a stale baseVersion conflicts with the current record", async () => {
  await withRollback(async (client) => {
    const { householdId, userId } = await createHouseholdAndUser(client, "owner");
    const ctx = { householdId, userId };
    const itemId = randomUUID();
    await applyMealMutation(client, ctx, {
      idempotencyKey: randomUUID(),
      op: "shopping.create",
      payload: shoppingCreatePayload({ id: itemId }),
    });
    const firstUpdate = await applyMealMutation(client, ctx, {
      idempotencyKey: randomUUID(),
      op: "shopping.update",
      payload: { id: itemId, changes: { checked: true } },
      baseVersion: 1,
    });
    assert.equal(firstUpdate.status, "applied");
    assert.equal(firstUpdate.record.version, 2);

    const staleUpdate = await applyMealMutation(client, ctx, {
      idempotencyKey: randomUUID(),
      op: "shopping.update",
      payload: { id: itemId, changes: { checked: false } },
      baseVersion: 1,
    });
    assert.equal(staleUpdate.status, "conflict");
    assert.equal(staleUpdate.currentVersion, 2);
    assert.equal(staleUpdate.record.checked, true);
  });
});

dbTest(
  "*.delete is idempotent: a retry after the row is already gone is `applied` with a null record",
  async () => {
    await withRollback(async (client) => {
      const { householdId, userId } = await createHouseholdAndUser(client, "owner");
      const ctx = { householdId, userId };
      const itemId = randomUUID();
      await applyMealMutation(client, ctx, {
        idempotencyKey: randomUUID(),
        op: "shopping.create",
        payload: shoppingCreatePayload({ id: itemId }),
      });
      const deleteResult = await applyMealMutation(client, ctx, {
        idempotencyKey: randomUUID(),
        op: "shopping.delete",
        payload: { id: itemId },
      });
      assert.equal(deleteResult.status, "applied");

      const retryDelete = await applyMealMutation(client, ctx, {
        idempotencyKey: randomUUID(),
        op: "shopping.delete",
        payload: { id: itemId },
      });
      assert.equal(retryDelete.status, "applied");
      assert.equal(retryDelete.record, null);
    });
  },
);

dbTest(
  "resetMealsForHousehold deletes all three tables in child-before-parent order (SET NULL, not CASCADE)",
  async () => {
    await withRollback(async (client) => {
      const { householdId, userId } = await createHouseholdAndUser(client, "owner");
      const ctx = { householdId, userId };
      const recipeId = randomUUID();
      await applyMealMutation(client, ctx, {
        idempotencyKey: randomUUID(),
        op: "recipe.create",
        payload: recipeCreatePayload({ id: recipeId }),
      });
      await applyMealMutation(client, ctx, {
        idempotencyKey: randomUUID(),
        op: "meal.create",
        payload: mealCreatePayload({ recipeId }),
      });
      await applyMealMutation(client, ctx, {
        idempotencyKey: randomUUID(),
        op: "shopping.create",
        payload: shoppingCreatePayload({ sourceRecipeId: recipeId }),
      });

      await resetMealsForHousehold(client, householdId);

      const snapshot = await readMealsSnapshot(client, householdId);
      assert.deepEqual(snapshot.recipes, []);
      assert.deepEqual(snapshot.mealSlots, []);
      assert.deepEqual(snapshot.shoppingItems, []);
    });
  },
);

dbTest(
  "cross-household isolation: a recipe from another household is not visible or editable",
  async () => {
    await withRollback(async (client) => {
      const owner = await createHouseholdAndUser(client, "owner");
      const stranger = await createHouseholdAndUser(client, "stranger");
      const recipeId = randomUUID();
      await applyMealMutation(
        client,
        { householdId: owner.householdId, userId: owner.userId },
        {
          idempotencyKey: randomUUID(),
          op: "recipe.create",
          payload: recipeCreatePayload({ id: recipeId }),
        },
      );
      const strangerSnapshot = await readMealsSnapshot(client, stranger.householdId);
      assert.deepEqual(strangerSnapshot.recipes, []);
      const attempt = await applyMealMutation(
        client,
        { householdId: stranger.householdId, userId: stranger.userId },
        {
          idempotencyKey: randomUUID(),
          op: "recipe.update",
          payload: { id: recipeId, changes: { favorite: true } },
          baseVersion: 1,
        },
      );
      assert.equal(attempt.status, "error");
      assert.equal(attempt.code, "NOT_FOUND");
    });
  },
);
