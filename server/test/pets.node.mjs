import assert from "node:assert/strict";
import test, { after } from "node:test";
import { randomUUID } from "node:crypto";
import pg from "pg";
import {
  PetValidationError,
  SUPPORTED_PETS_OPS,
  applyPetsMutation,
  assertPetsMutationShape,
  petExpenseRowToDto,
  petRowToDto,
  petVisitRowToDto,
  readPetsSnapshot,
  resetPetsForUser,
  resolveExpenseVisibility,
  resolveOwnerId,
  resolveVersionConflict,
  resolveVisitVisibility,
  validateDeleteIdPayload,
  validatePetCreatePayload,
  validatePetExpenseCreatePayload,
  validatePetUpdatePayload,
  validatePetVisitCreatePayload,
  validatePetVisitUpdatePayload,
} from "../src/pets.mjs";

// ---------------------------------------------------------------------------
// Pure unit tests -- no database required, always run (including in CI).
// ---------------------------------------------------------------------------

test("resolveOwnerId always returns the session user, never a client-supplied value", () => {
  const ctx = { userId: "session-user", householdId: "household-1" };
  assert.equal(resolveOwnerId(ctx), "session-user");
});

test("resolveExpenseVisibility inherits from the pet unless the client sets a valid one", () => {
  assert.equal(resolveExpenseVisibility(undefined, "private"), "private");
  assert.equal(resolveExpenseVisibility(undefined, "household"), "household");
  assert.equal(resolveExpenseVisibility("household", "private"), "household");
  assert.equal(resolveExpenseVisibility("not-a-visibility", "private"), "private");
});

test("resolveVisitVisibility inherits from the pet unless the client sets a valid one", () => {
  assert.equal(resolveVisitVisibility(undefined, "private"), "private");
  assert.equal(resolveVisitVisibility(undefined, "household"), "household");
  assert.equal(resolveVisitVisibility("private", "household"), "private");
  assert.equal(resolveVisitVisibility("not-a-visibility", "household"), "household");
});

test("resolveVersionConflict compares the client's assumed version against the stored one", () => {
  assert.equal(resolveVersionConflict(1, 1), true);
  assert.equal(resolveVersionConflict(1, 2), false);
  assert.equal(resolveVersionConflict("1", 1), true);
});

// `isFishStockArray` (wzór `isTravelersArray` z trips.mjs) is a private helper in pets.mjs -- not
// exported (see the module's `export function`/`export const` list). It's exercised here through its
// only two callers, `validatePetCreatePayload`/`validatePetUpdatePayload`, both of which surface a
// shape violation as `PetValidationError` with `code === "INVALID_FISH_STOCK"`.
function petPayload(overrides = {}) {
  return {
    id: "pet-1",
    name: "Kot",
    kind: "cat",
    color: "#397763",
    species: "Brytyjski krótkowłosy",
    birthDate: "2020-01-01",
    notes: "Lubi spać",
    visibility: "household",
    ...overrides,
  };
}

test("fishStock validation (validatePetCreatePayload) accepts well-shaped entries and rejects malformed ones", () => {
  assert.deepEqual(
    validatePetCreatePayload(petPayload({ kind: "aquarium", fishStock: [] })).fishStock,
    [],
  );
  const wellShaped = [
    { id: "f1", species: "Neon", count: 5 },
    { id: "f2", species: "Gupik", count: 0 },
  ];
  assert.deepEqual(
    validatePetCreatePayload(petPayload({ kind: "aquarium", fishStock: wellShaped })).fishStock,
    wellShaped,
  );
  // `fishStock: null`/absent is allowed (not every pet is an aquarium) -- the validator only runs
  // the shape check when the field is present and non-null.
  assert.doesNotThrow(() => validatePetCreatePayload(petPayload({ fishStock: null })));

  const invalidCode = (error) => error.code === "INVALID_FISH_STOCK";
  assert.throws(
    () => validatePetCreatePayload(petPayload({ fishStock: "not-an-array" })),
    invalidCode,
  );
  assert.throws(
    () => validatePetCreatePayload(petPayload({ fishStock: [{ species: "Neon", count: 5 }] })),
    invalidCode,
    "missing id",
  );
  assert.throws(
    () => validatePetCreatePayload(petPayload({ fishStock: [{ id: "f1", count: 5 }] })),
    invalidCode,
    "missing species",
  );
  assert.throws(
    () =>
      validatePetCreatePayload(petPayload({ fishStock: [{ id: "f1", species: "", count: 5 }] })),
    invalidCode,
    "empty species",
  );
  assert.throws(
    () =>
      validatePetCreatePayload(
        petPayload({ fishStock: [{ id: "f1", species: "Neon", count: -1 }] }),
      ),
    invalidCode,
    "negative count",
  );
  assert.throws(
    () =>
      validatePetCreatePayload(
        petPayload({ fishStock: [{ id: "f1", species: "Neon", count: 1.5 }] }),
      ),
    invalidCode,
    "non-integer count",
  );
  assert.throws(
    () =>
      validatePetCreatePayload(
        petPayload({ fishStock: [{ id: "f1", species: "Neon", count: "5" }] }),
      ),
    invalidCode,
    "count as string",
  );
});

test("fishStock validation caps the array at 500 entries (validatePetCreatePayload and validatePetUpdatePayload)", () => {
  const atCap = Array.from({ length: 500 }, (_, i) => ({
    id: `f${i}`,
    species: "Neon",
    count: 1,
  }));
  assert.deepEqual(
    validatePetCreatePayload(petPayload({ kind: "aquarium", fishStock: atCap })).fishStock,
    atCap,
  );
  const overCap = [...atCap, { id: "f500", species: "Neon", count: 1 }];
  assert.throws(
    () => validatePetCreatePayload(petPayload({ fishStock: overCap })),
    (error) => error.code === "INVALID_FISH_STOCK",
  );
  assert.throws(
    () => validatePetUpdatePayload({ id: "pet-1", changes: { fishStock: overCap } }, 1),
    (error) => error.code === "INVALID_FISH_STOCK",
  );
});

test("validatePetCreatePayload accepts a valid payload and never reads/forwards ownerId", () => {
  const data = validatePetCreatePayload(petPayload({ ownerId: "someone-else" }));
  assert.equal(data.name, "Kot");
  assert.equal("ownerId" in data, false, "the validator does not read or forward ownerId");
});

test("validatePetCreatePayload rejects invalid fields", () => {
  assert.throws(() => validatePetCreatePayload({}), PetValidationError);
  assert.throws(
    () => validatePetCreatePayload(petPayload({ kind: "not-a-kind" })),
    (error) => error.code === "INVALID_KIND",
  );
  assert.throws(
    () => validatePetCreatePayload(petPayload({ visibility: "public" })),
    (error) => error.code === "INVALID_VISIBILITY",
  );
  assert.throws(
    () => validatePetCreatePayload(petPayload({ birthDate: "not-a-date" })),
    (error) => error.code === "INVALID_BIRTH_DATE",
  );
  assert.throws(
    () => validatePetCreatePayload(petPayload({ fishStock: [{ id: "f1" }] })),
    (error) => error.code === "INVALID_FISH_STOCK",
  );
  assert.throws(
    () => validatePetCreatePayload(petPayload({ name: "" })),
    (error) => error.code === "INVALID_NAME",
  );
});

test("validatePetUpdatePayload only allows PET_UPDATE_KEYS (owner_id is never editable)", () => {
  assert.throws(
    () => validatePetUpdatePayload({ id: "pet-1", changes: { ownerId: "other-user" } }, 1),
    (error) => error.code === "INVALID_CHANGES",
  );
  assert.throws(
    () => validatePetUpdatePayload({ id: "pet-1", changes: { householdId: "other" } }, 1),
    (error) => error.code === "INVALID_CHANGES",
  );
  const { changes, baseVersion } = validatePetUpdatePayload(
    { id: "pet-1", changes: { name: " Reksio ", visibility: "private" } },
    2,
  );
  assert.equal(changes.name, "Reksio");
  assert.equal(changes.visibility, "private");
  assert.equal(baseVersion, 2);
});

test("validatePetUpdatePayload requires a positive integer baseVersion", () => {
  assert.throws(
    () => validatePetUpdatePayload({ id: "pet-1", changes: { name: "X" } }, undefined),
    (error) => error.code === "INVALID_BASE_VERSION",
  );
  assert.throws(
    () => validatePetUpdatePayload({ id: "pet-1", changes: { name: "X" } }, 0),
    (error) => error.code === "INVALID_BASE_VERSION",
  );
});

test("validatePetUpdatePayload allows clearing species/birthDate/notes to null", () => {
  const { changes } = validatePetUpdatePayload(
    { id: "pet-1", changes: { species: null, birthDate: null, notes: null } },
    1,
  );
  assert.equal(changes.species, null);
  assert.equal(changes.birthDate, null);
  assert.equal(changes.notes, null);
});

test("validateDeleteIdPayload requires a valid id", () => {
  assert.throws(
    () => validateDeleteIdPayload({}),
    (error) => error.code === "INVALID_ID",
  );
  assert.deepEqual(validateDeleteIdPayload({ id: "pet-1" }), { id: "pet-1" });
});

test("validatePetExpenseCreatePayload leaves visibility undefined when the client omits it", () => {
  const data = validatePetExpenseCreatePayload({
    id: "exp-1",
    petId: "pet-1",
    date: "2026-07-01",
    type: "food",
    amountMinor: 5000,
    title: "Karma",
  });
  assert.equal(data.visibility, undefined);
  assert.throws(
    () => validatePetExpenseCreatePayload({ ...data, id: "exp-2", date: "2026-13-40" }),
    (error) => error.code === "INVALID_DATE",
  );
  assert.throws(
    () => validatePetExpenseCreatePayload({ ...data, id: "exp-3", type: "not-a-type" }),
    (error) => error.code === "INVALID_TYPE",
  );
  assert.throws(
    () => validatePetExpenseCreatePayload({ ...data, id: "exp-4", amountMinor: -1 }),
    (error) => error.code === "INVALID_AMOUNT",
  );
});

test("validatePetVisitCreatePayload validates date/time/status", () => {
  const base = {
    id: "visit-1",
    petId: "pet-1",
    title: "Kontrola",
    clinician: "Dr. Kowalska",
    date: "2026-07-01",
    time: "10:30",
    status: "scheduled",
  };
  const data = validatePetVisitCreatePayload(base);
  assert.equal(data.visibility, undefined);
  assert.throws(
    () => validatePetVisitCreatePayload({ ...base, time: "10-30" }),
    (error) => error.code === "INVALID_TIME",
  );
  assert.throws(
    () => validatePetVisitCreatePayload({ ...base, status: "not-a-status" }),
    (error) => error.code === "INVALID_STATUS",
  );
  assert.throws(
    () => validatePetVisitCreatePayload({ ...base, clinician: "" }),
    (error) => error.code === "INVALID_CLINICIAN",
  );
});

test("validatePetVisitUpdatePayload only allows VISIT_UPDATE_KEYS (petId/ownerId are never editable)", () => {
  assert.throws(
    () => validatePetVisitUpdatePayload({ id: "visit-1", changes: { petId: "other-pet" } }, 1),
    (error) => error.code === "INVALID_CHANGES",
  );
  assert.throws(
    () => validatePetVisitUpdatePayload({ id: "visit-1", changes: { ownerId: "other" } }, 1),
    (error) => error.code === "INVALID_CHANGES",
  );
  // togglePetVisitCompleted sends exactly this shape.
  const { changes } = validatePetVisitUpdatePayload(
    { id: "visit-1", changes: { status: "completed" } },
    3,
  );
  assert.deepEqual(changes, { status: "completed" });
});

test("assertPetsMutationShape validates the whole-request envelope", () => {
  const valid = {
    idempotencyKey: randomUUID(),
    op: "pet.create",
    payload: { id: "pet-1" },
  };
  assert.doesNotThrow(() => assertPetsMutationShape(valid));
  assert.throws(
    () => assertPetsMutationShape({ ...valid, idempotencyKey: "not-a-uuid" }),
    (error) => error.statusCode === 400 && error.code === "INVALID_IDEMPOTENCY_KEY",
  );
  assert.throws(
    () => assertPetsMutationShape({ ...valid, op: "pet.archive" }),
    (error) => error.statusCode === 400 && error.code === "UNSUPPORTED_OP",
  );
  assert.throws(
    () => assertPetsMutationShape({ ...valid, payload: "nope" }),
    (error) => error.statusCode === 400,
  );
  assert.equal(SUPPORTED_PETS_OPS.has("expense.update"), false, "expense.update is out of scope (YAGNI)");
});

test("row->DTO mappers convert snake_case/bigint-as-string/Date columns to the frontend shape", () => {
  const pet = petRowToDto({
    id: "pet-1",
    owner_id: "user-1",
    visibility: "household",
    name: "Kot",
    kind: "cat",
    color: "#397763",
    species: "Brytyjski",
    birth_date: "2020-01-01",
    fish_stock: null,
    notes: null,
    version: 2,
    updated_at: new Date("2026-07-01T10:00:00.000Z"),
  });
  assert.equal(pet.birthDate, "2020-01-01");
  assert.equal(pet.updatedAt, "2026-07-01T10:00:00.000Z");
  assert.equal(pet.notes, undefined);

  const expense = petExpenseRowToDto({
    id: "exp-1",
    owner_id: "user-1",
    visibility: "household",
    pet_id: "pet-1",
    date: "2026-07-01",
    type: "food",
    amount_minor: "5000", // bigint columns arrive as strings from node-postgres
    title: "Karma",
    notes: null,
    version: 1,
    updated_at: new Date("2026-07-01T10:00:00.000Z"),
  });
  assert.equal(expense.amountMinor, 5000);
  assert.equal(typeof expense.amountMinor, "number");

  const visit = petVisitRowToDto({
    id: "visit-1",
    owner_id: "user-1",
    visibility: "household",
    pet_id: "pet-1",
    title: "Kontrola",
    clinician: "Dr. Kowalska",
    specialty: null,
    date: "2026-07-01",
    time: "10:30",
    location: null,
    status: "scheduled",
    notes: null,
    version: 1,
    updated_at: new Date("2026-07-01T10:00:00.000Z"),
  });
  assert.equal(visit.date, "2026-07-01");
  assert.equal(visit.specialty, undefined);
});

test("petRowToDto exposes fishStock as undefined (never an empty array) when the column is null/absent", () => {
  assert.equal(
    petRowToDto({
      id: "pet-1",
      owner_id: "user-1",
      visibility: "household",
      name: "Reksio",
      kind: "dog",
      color: "#000",
      species: null,
      birth_date: null,
      fish_stock: null,
      notes: null,
      version: 1,
      updated_at: new Date("2026-07-01T10:00:00.000Z"),
    }).fishStock,
    undefined,
  );
  assert.equal(
    petRowToDto({
      id: "pet-1",
      owner_id: "user-1",
      visibility: "household",
      name: "Reksio",
      kind: "dog",
      color: "#000",
      species: null,
      birth_date: null,
      fish_stock: undefined,
      notes: null,
      version: 1,
      updated_at: new Date("2026-07-01T10:00:00.000Z"),
    }).fishStock,
    undefined,
  );
  const aquarium = petRowToDto({
    id: "pet-2",
    owner_id: "user-1",
    visibility: "household",
    name: "Akwarium",
    kind: "aquarium",
    color: "#000",
    species: null,
    birth_date: null,
    fish_stock: [{ id: "f1", species: "Neon", count: 5 }],
    notes: null,
    version: 1,
    updated_at: new Date("2026-07-01T10:00:00.000Z"),
  });
  assert.deepEqual(aquarium.fishStock, [{ id: "f1", species: "Neon", count: 5 }]);
});

// ---------------------------------------------------------------------------
// DB-backed integration tests. `npm run test:server` in CI (.github/workflows/ci.yml) does not
// provision a Postgres instance, so these are automatically skipped there via a short connectivity
// probe rather than being deleted or mocked -- they exercise the real SQL (OCC predicates, the
// visibility cascade transaction, the orphan-child guard) against a real database.
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
  const email = `pets-test-${randomUUID()}@example.com`;
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

async function addHouseholdMember(client, householdId, label) {
  const user = await client.query(
    `INSERT INTO users(email, display_name, password_hash) VALUES ($1, $2, 'test-hash') RETURNING id`,
    [`pets-test-${randomUUID()}@example.com`, label],
  );
  const userId = user.rows[0].id;
  await client.query(
    `INSERT INTO household_members(household_id, user_id, role) VALUES ($1, $2, 'member')`,
    [householdId, userId],
  );
  return userId;
}

function dbPetPayload(overrides = {}) {
  return {
    id: randomUUID(),
    name: "Kot",
    kind: "cat",
    color: "#397763",
    species: "Brytyjski krótkowłosy",
    birthDate: "2020-01-01",
    notes: "Lubi spać",
    visibility: "household",
    ...overrides,
  };
}

dbTest(
  "pet.create derives owner_id from the session, ignoring any ownerId in the payload",
  async () => {
    await withRollback(async (client) => {
      const owner = await createHouseholdAndUser(client, "owner");
      const impersonated = await addHouseholdMember(client, owner.householdId, "other");
      const ctx = { householdId: owner.householdId, userId: owner.userId };
      const result = await applyPetsMutation(client, ctx, {
        idempotencyKey: randomUUID(),
        op: "pet.create",
        payload: dbPetPayload({ ownerId: impersonated }),
      });
      assert.equal(result.status, "applied");
      assert.equal(result.record.ownerId, owner.userId);
      assert.notEqual(result.record.ownerId, impersonated);
    });
  },
);

dbTest(
  "pet.create normalizes variant fields by kind: aquarium never carries species/birthDate, " +
    "non-aquarium never carries fishStock, regardless of what the payload sent",
  async () => {
    await withRollback(async (client) => {
      const { householdId, userId } = await createHouseholdAndUser(client, "owner");
      const ctx = { householdId, userId };

      const aquarium = await applyPetsMutation(client, ctx, {
        idempotencyKey: randomUUID(),
        op: "pet.create",
        payload: dbPetPayload({
          kind: "aquarium",
          species: "should be dropped",
          birthDate: "2020-01-01",
          fishStock: [{ id: "f1", species: "Neon", count: 5 }],
        }),
      });
      assert.equal(aquarium.status, "applied");
      assert.equal(aquarium.record.species, undefined);
      assert.equal(aquarium.record.birthDate, undefined);
      assert.deepEqual(aquarium.record.fishStock, [{ id: "f1", species: "Neon", count: 5 }]);

      const cat = await applyPetsMutation(client, ctx, {
        idempotencyKey: randomUUID(),
        op: "pet.create",
        payload: dbPetPayload({
          kind: "cat",
          species: "Brytyjski",
          birthDate: "2020-01-01",
          fishStock: [{ id: "f1", species: "should be dropped", count: 1 }],
        }),
      });
      assert.equal(cat.status, "applied");
      assert.equal(cat.record.fishStock, undefined);
      assert.equal(cat.record.species, "Brytyjski");
      assert.equal(cat.record.birthDate, "2020-01-01");
    });
  },
);

dbTest(
  "pet.update normalizes variant fields by kind in both directions, server-side",
  async () => {
    await withRollback(async (client) => {
      const { householdId, userId } = await createHouseholdAndUser(client, "owner");
      const ctx = { householdId, userId };
      const petId = randomUUID();
      await applyPetsMutation(client, ctx, {
        idempotencyKey: randomUUID(),
        op: "pet.create",
        payload: dbPetPayload({ id: petId, kind: "cat", species: "Brytyjski", birthDate: "2020-01-01" }),
      });

      // cat -> aquarium: species/birthDate must be zeroed even though the client didn't say so, and
      // fishStock (sent in this same update) must be stored.
      const toAquarium = await applyPetsMutation(client, ctx, {
        idempotencyKey: randomUUID(),
        op: "pet.update",
        payload: {
          id: petId,
          changes: { kind: "aquarium", fishStock: [{ id: "f1", species: "Neon", count: 3 }] },
        },
        baseVersion: 1,
      });
      assert.equal(toAquarium.status, "applied");
      assert.equal(toAquarium.record.species, undefined);
      assert.equal(toAquarium.record.birthDate, undefined);
      assert.deepEqual(toAquarium.record.fishStock, [{ id: "f1", species: "Neon", count: 3 }]);

      // aquarium -> dog: fishStock must be zeroed even though the client didn't explicitly clear it.
      const toDog = await applyPetsMutation(client, ctx, {
        idempotencyKey: randomUUID(),
        op: "pet.update",
        payload: { id: petId, changes: { kind: "dog", species: "Owczarek", birthDate: "2019-05-01" } },
        baseVersion: 2,
      });
      assert.equal(toDog.status, "applied");
      assert.equal(toDog.record.fishStock, undefined);
      assert.equal(toDog.record.species, "Owczarek");
      assert.equal(toDog.record.birthDate, "2019-05-01");
    });
  },
);

dbTest(
  "pet.update changing visibility cascades visibility/owner_id onto all of the pet's expenses and " +
    "visits in the same transaction",
  async () => {
    await withRollback(async (client) => {
      const owner = await createHouseholdAndUser(client, "owner");
      const other = await addHouseholdMember(client, owner.householdId, "other");
      const ctx = { householdId: owner.householdId, userId: owner.userId };
      const petId = randomUUID();
      await applyPetsMutation(client, ctx, {
        idempotencyKey: randomUUID(),
        op: "pet.create",
        payload: dbPetPayload({ id: petId, visibility: "household" }),
      });
      const expenseId = randomUUID();
      await applyPetsMutation(client, ctx, {
        idempotencyKey: randomUUID(),
        op: "expense.create",
        payload: {
          id: expenseId,
          petId,
          date: "2026-07-01",
          type: "food",
          amountMinor: 5000,
          title: "Karma",
        },
      });
      const visitId = randomUUID();
      await applyPetsMutation(client, ctx, {
        idempotencyKey: randomUUID(),
        op: "visit.create",
        payload: {
          id: visitId,
          petId,
          title: "Kontrola",
          clinician: "Dr. Kowalska",
          date: "2026-07-10",
          time: "10:00",
          status: "scheduled",
        },
      });

      // Sanity: both children inherited the parent's 'household' visibility and are visible to the
      // other household member before the cascade.
      const before = await readPetsSnapshot(client, owner.householdId, other);
      assert.equal(before.petExpenses.length, 1);
      assert.equal(before.petVisits.length, 1);

      const flipped = await applyPetsMutation(client, ctx, {
        idempotencyKey: randomUUID(),
        op: "pet.update",
        payload: { id: petId, changes: { visibility: "private" } },
        baseVersion: 1,
      });
      assert.equal(flipped.status, "applied");
      assert.equal(flipped.record.visibility, "private");

      // The cascade must have run in the SAME transaction: the other member can no longer see the
      // pet, its expense, or its visit.
      const after = await readPetsSnapshot(client, owner.householdId, other);
      assert.deepEqual(after.pets, []);
      assert.deepEqual(after.petExpenses, []);
      assert.deepEqual(after.petVisits, []);

      // The owner still sees everything, now privately owned/version-bumped.
      const ownerView = await readPetsSnapshot(client, owner.householdId, owner.userId);
      assert.equal(ownerView.petExpenses[0].visibility, "private");
      assert.equal(ownerView.petExpenses[0].ownerId, owner.userId);
      assert.equal(ownerView.petExpenses[0].version, 2);
      assert.equal(ownerView.petVisits[0].visibility, "private");
      assert.equal(ownerView.petVisits[0].ownerId, owner.userId);
      assert.equal(ownerView.petVisits[0].version, 2);
    });
  },
);

dbTest(
  "the conflict-diagnosis query for pet.update carries the same visibility scope as the write, so " +
    "a private record's existence/content is never leaked to another household member",
  async () => {
    await withRollback(async (client) => {
      const owner = await createHouseholdAndUser(client, "owner");
      const otherUserId = await addHouseholdMember(client, owner.householdId, "other");
      const petId = randomUUID();
      await applyPetsMutation(
        client,
        { householdId: owner.householdId, userId: owner.userId },
        {
          idempotencyKey: randomUUID(),
          op: "pet.create",
          payload: dbPetPayload({ id: petId, visibility: "private" }),
        },
      );
      // Another household member attempting to update the owner's private pet must get a plain
      // NOT_FOUND -- not a conflict that would leak the private record's current version/content.
      const attempt = await applyPetsMutation(
        client,
        { householdId: owner.householdId, userId: otherUserId },
        {
          idempotencyKey: randomUUID(),
          op: "pet.update",
          payload: { id: petId, changes: { name: "Podmienione" } },
          baseVersion: 1,
        },
      );
      assert.equal(attempt.status, "error");
      assert.equal(attempt.code, "NOT_FOUND");
      assert.equal("record" in attempt, false, "no record leaked in the error response");

      const snapshotForOther = await readPetsSnapshot(client, owner.householdId, otherUserId);
      assert.deepEqual(snapshotForOther.pets, []);
    });
  },
);

dbTest(
  "expense.create/visit.create reject an orphaned petId: missing entirely, or outside the caller's " +
    "visibility scope (another member's private pet)",
  async () => {
    await withRollback(async (client) => {
      const owner = await createHouseholdAndUser(client, "owner");
      const otherUserId = await addHouseholdMember(client, owner.householdId, "other");
      const ctxOwner = { householdId: owner.householdId, userId: owner.userId };
      const ctxOther = { householdId: owner.householdId, userId: otherUserId };

      const missingPetExpense = await applyPetsMutation(client, ctxOwner, {
        idempotencyKey: randomUUID(),
        op: "expense.create",
        payload: {
          id: randomUUID(),
          petId: "does-not-exist",
          date: "2026-07-01",
          type: "food",
          amountMinor: 5000,
          title: "Karma",
        },
      });
      assert.equal(missingPetExpense.status, "error");
      assert.equal(missingPetExpense.code, "PET_NOT_FOUND");

      const missingPetVisit = await applyPetsMutation(client, ctxOwner, {
        idempotencyKey: randomUUID(),
        op: "visit.create",
        payload: {
          id: randomUUID(),
          petId: "does-not-exist",
          title: "Kontrola",
          clinician: "Dr. Kowalska",
          date: "2026-07-01",
          time: "10:00",
          status: "scheduled",
        },
      });
      assert.equal(missingPetVisit.status, "error");
      assert.equal(missingPetVisit.code, "PET_NOT_FOUND");

      // The pet exists, but it's owner's PRIVATE profile -- out of `other`'s visibility scope.
      const privatePetId = randomUUID();
      await applyPetsMutation(client, ctxOwner, {
        idempotencyKey: randomUUID(),
        op: "pet.create",
        payload: dbPetPayload({ id: privatePetId, visibility: "private" }),
      });
      const outOfScopeExpense = await applyPetsMutation(client, ctxOther, {
        idempotencyKey: randomUUID(),
        op: "expense.create",
        payload: {
          id: randomUUID(),
          petId: privatePetId,
          date: "2026-07-01",
          type: "food",
          amountMinor: 5000,
          title: "Karma",
        },
      });
      assert.equal(outOfScopeExpense.status, "error");
      assert.equal(outOfScopeExpense.code, "PET_NOT_FOUND");
    });
  },
);

dbTest(
  "expense.create/visit.create without an explicit visibility inherit the parent pet's visibility",
  async () => {
    await withRollback(async (client) => {
      const { householdId, userId } = await createHouseholdAndUser(client, "owner");
      const ctx = { householdId, userId };
      const petId = randomUUID();
      await applyPetsMutation(client, ctx, {
        idempotencyKey: randomUUID(),
        op: "pet.create",
        payload: dbPetPayload({ id: petId, visibility: "private" }),
      });

      const expense = await applyPetsMutation(client, ctx, {
        idempotencyKey: randomUUID(),
        op: "expense.create",
        payload: {
          id: randomUUID(),
          petId,
          date: "2026-07-01",
          type: "food",
          amountMinor: 5000,
          title: "Karma",
        },
      });
      assert.equal(expense.status, "applied");
      assert.equal(expense.record.visibility, "private");

      const visit = await applyPetsMutation(client, ctx, {
        idempotencyKey: randomUUID(),
        op: "visit.create",
        payload: {
          id: randomUUID(),
          petId,
          title: "Kontrola",
          clinician: "Dr. Kowalska",
          date: "2026-07-01",
          time: "10:00",
          status: "scheduled",
        },
      });
      assert.equal(visit.status, "applied");
      assert.equal(visit.record.visibility, "private");

      // An explicit visibility on the child overrides inheritance.
      const sharedExpense = await applyPetsMutation(client, ctx, {
        idempotencyKey: randomUUID(),
        op: "expense.create",
        payload: {
          id: randomUUID(),
          petId,
          date: "2026-07-02",
          type: "vet",
          amountMinor: 10000,
          title: "Wizyta",
          visibility: "household",
        },
      });
      assert.equal(sharedExpense.record.visibility, "household");
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
        op: "pet.create",
        payload: dbPetPayload(),
      };
      const first = await applyPetsMutation(client, ctx, mutation);
      const second = await applyPetsMutation(client, ctx, mutation);
      assert.equal(first.status, "applied");
      assert.deepEqual(second, JSON.parse(JSON.stringify(first)));
      const count = await client.query(
        "SELECT count(*)::int AS count FROM pets WHERE household_id = $1",
        [householdId],
      );
      assert.equal(count.rows[0].count, 1);
    });
  },
);

dbTest(
  "resetPetsForUser (Settings 'Wyczyść dane aplikacji') deletes shared records and the caller's own " +
    "private records, but never another member's private records",
  async () => {
    await withRollback(async (client) => {
      const owner = await createHouseholdAndUser(client, "owner");
      const otherUserId = await addHouseholdMember(client, owner.householdId, "other");
      const ctxOwner = { householdId: owner.householdId, userId: owner.userId };
      const ctxOther = { householdId: owner.householdId, userId: otherUserId };

      await applyPetsMutation(client, ctxOwner, {
        idempotencyKey: randomUUID(),
        op: "pet.create",
        payload: dbPetPayload({ name: "Wspólny", visibility: "household" }),
      });
      const ownerPrivatePetId = randomUUID();
      await applyPetsMutation(client, ctxOwner, {
        idempotencyKey: randomUUID(),
        op: "pet.create",
        payload: dbPetPayload({ id: ownerPrivatePetId, name: "Prywatny właściciela", visibility: "private" }),
      });
      await applyPetsMutation(client, ctxOwner, {
        idempotencyKey: randomUUID(),
        op: "expense.create",
        payload: {
          id: randomUUID(),
          petId: ownerPrivatePetId,
          date: "2026-07-01",
          type: "food",
          amountMinor: 1000,
          title: "Karma",
        },
      });
      const otherPrivatePetId = randomUUID();
      await applyPetsMutation(client, ctxOther, {
        idempotencyKey: randomUUID(),
        op: "pet.create",
        payload: dbPetPayload({ id: otherPrivatePetId, name: "Prywatny innego", visibility: "private" }),
      });
      await applyPetsMutation(client, ctxOther, {
        idempotencyKey: randomUUID(),
        op: "expense.create",
        payload: {
          id: randomUUID(),
          petId: otherPrivatePetId,
          date: "2026-07-01",
          type: "food",
          amountMinor: 2000,
          title: "Karma innego",
        },
      });

      await resetPetsForUser(client, owner.householdId, owner.userId);

      const snapshotForOwner = await readPetsSnapshot(client, owner.householdId, owner.userId);
      assert.deepEqual(snapshotForOwner.pets, []);
      assert.deepEqual(snapshotForOwner.petExpenses, []);

      const snapshotForOther = await readPetsSnapshot(client, owner.householdId, otherUserId);
      assert.deepEqual(
        snapshotForOther.pets.map((pet) => pet.name),
        ["Prywatny innego"],
        "the other member's private pet must survive the owner's reset",
      );
      assert.equal(
        snapshotForOther.petExpenses.length,
        1,
        "the other member's private expense must survive the owner's reset",
      );
    });
  },
);
