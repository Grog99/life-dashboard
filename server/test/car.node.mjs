import assert from "node:assert/strict";
import test, { after } from "node:test";
import { randomUUID } from "node:crypto";
import pg from "pg";
import {
  CarValidationError,
  SUPPORTED_CAR_OPS,
  applyCarMutation,
  assertCarMutationShape,
  carExpenseRowToDto,
  readCarSnapshot,
  resetCarForUser,
  resolveExpenseVisibility,
  resolveOwnerId,
  resolveVersionConflict,
  upsertAutoDeadline,
  validateCarExpenseCreatePayload,
  validateDeadlineCreatePayload,
  validateDeadlineUpdatePayload,
  validateDeleteIdPayload,
  validateVehicleCreatePayload,
  validateVehicleMileagePayload,
  validateVehicleUpdatePayload,
  vehicleDeadlineRowToDto,
  vehicleRowToDto,
} from "../src/car.mjs";

// ---------------------------------------------------------------------------
// Pure unit tests -- no database required, always run (including in CI).
// ---------------------------------------------------------------------------

test("resolveOwnerId always returns the session user, never a client-supplied value", () => {
  const ctx = { userId: "session-user", householdId: "household-1" };
  assert.equal(resolveOwnerId(ctx), "session-user");
});

test("resolveExpenseVisibility inherits from the vehicle unless the client sets a valid one", () => {
  assert.equal(resolveExpenseVisibility(undefined, "private"), "private");
  assert.equal(resolveExpenseVisibility(undefined, "household"), "household");
  assert.equal(resolveExpenseVisibility("household", "private"), "household");
  assert.equal(resolveExpenseVisibility("not-a-visibility", "private"), "private");
});

test("resolveVersionConflict compares the client's assumed version against the stored one", () => {
  assert.equal(resolveVersionConflict(1, 1), true);
  assert.equal(resolveVersionConflict(1, 2), false);
  assert.equal(resolveVersionConflict("1", 1), true);
});

function vehiclePayload(overrides = {}) {
  return {
    id: "vehicle-1",
    name: "Auto",
    make: "Toyota",
    model: "Corolla",
    year: 2020,
    plate: "WA12345",
    mileage: 1000,
    fuelType: "petrol",
    inspectionDate: "2026-08-01",
    insuranceDate: "2026-09-01",
    color: "#397763",
    visibility: "household",
    ...overrides,
  };
}

test("validateVehicleCreatePayload accepts a valid payload and never reads/forwards ownerId", () => {
  const data = validateVehicleCreatePayload(vehiclePayload({ ownerId: "someone-else" }));
  assert.equal(data.name, "Auto");
  assert.equal("ownerId" in data, false, "the validator does not read or forward ownerId");
});

test("validateVehicleCreatePayload rejects invalid fields", () => {
  assert.throws(() => validateVehicleCreatePayload({}), CarValidationError);
  assert.throws(
    () => validateVehicleCreatePayload(vehiclePayload({ fuelType: "not-a-fuel" })),
    (error) => error.code === "INVALID_FUEL_TYPE",
  );
  assert.throws(
    () => validateVehicleCreatePayload(vehiclePayload({ year: 1800 })),
    (error) => error.code === "INVALID_YEAR",
  );
  assert.throws(
    () => validateVehicleCreatePayload(vehiclePayload({ mileage: -1 })),
    (error) => error.code === "INVALID_MILEAGE",
  );
  assert.throws(
    () => validateVehicleCreatePayload(vehiclePayload({ inspectionDate: "not-a-date" })),
    (error) => error.code === "INVALID_INSPECTION_DATE",
  );
  assert.throws(
    () => validateVehicleCreatePayload(vehiclePayload({ visibility: "public" })),
    (error) => error.code === "INVALID_VISIBILITY",
  );
});

test("validateVehicleUpdatePayload rejects mileage/ownerId/visibility as editable fields", () => {
  assert.throws(
    () => validateVehicleUpdatePayload({ id: "vehicle-1", changes: { mileage: 5000 } }, 1),
    (error) => error.code === "INVALID_CHANGES",
  );
  assert.throws(
    () => validateVehicleUpdatePayload({ id: "vehicle-1", changes: { ownerId: "x" } }, 1),
    (error) => error.code === "INVALID_CHANGES",
  );
  assert.throws(
    () => validateVehicleUpdatePayload({ id: "vehicle-1", changes: { visibility: "private" } }, 1),
    (error) => error.code === "INVALID_CHANGES",
  );
});

test("validateVehicleUpdatePayload requires a positive integer baseVersion", () => {
  assert.throws(
    () => validateVehicleUpdatePayload({ id: "vehicle-1", changes: { name: "X" } }, undefined),
    (error) => error.code === "INVALID_BASE_VERSION",
  );
  assert.throws(
    () => validateVehicleUpdatePayload({ id: "vehicle-1", changes: { name: "X" } }, 0),
    (error) => error.code === "INVALID_BASE_VERSION",
  );
  const { changes, baseVersion } = validateVehicleUpdatePayload(
    { id: "vehicle-1", changes: { name: " X " } },
    3,
  );
  assert.equal(changes.name, "X");
  assert.equal(baseVersion, 3);
});

test("validateVehicleMileagePayload requires a non-negative integer mileage", () => {
  assert.throws(
    () => validateVehicleMileagePayload({ id: "vehicle-1", mileage: -1 }),
    (error) => error.code === "INVALID_MILEAGE",
  );
  assert.deepEqual(validateVehicleMileagePayload({ id: "vehicle-1", mileage: 500 }), {
    id: "vehicle-1",
    mileage: 500,
  });
});

test("validateCarExpenseCreatePayload leaves visibility undefined when the client omits it", () => {
  const data = validateCarExpenseCreatePayload({
    id: "exp-1",
    vehicleId: "vehicle-1",
    date: "2026-07-01",
    type: "fuel",
    amountMinor: 15000,
    mileage: 1200,
    liters: 40,
    title: "Tankowanie",
  });
  assert.equal(data.visibility, undefined);
  assert.throws(
    () => validateCarExpenseCreatePayload({ ...data, id: "exp-2", date: "2026-13-40" }),
    (error) => error.code === "INVALID_DATE",
  );
  assert.throws(
    () => validateCarExpenseCreatePayload({ ...data, id: "exp-3", type: "not-a-type" }),
    (error) => error.code === "INVALID_TYPE",
  );
});

test("validateDeadlineCreatePayload doesn't accept a kind field at all (custom is implicit)", () => {
  const data = validateDeadlineCreatePayload({
    id: "dl-1",
    vehicleId: "vehicle-1",
    title: "Wymiana opon",
    dueDate: "2026-10-01",
    kind: "inspection", // must be silently ignored -- validator doesn't even read it
  });
  assert.equal("kind" in data, false);
  assert.throws(
    () => validateDeadlineCreatePayload({ id: "dl-1", vehicleId: "vehicle-1", title: "" }),
    (error) => error.code === "INVALID_TITLE",
  );
});

test("validateDeadlineUpdatePayload only allows completed/title/dueDate/dueMileage", () => {
  const { changes } = validateDeadlineUpdatePayload(
    { id: "dl-1", changes: { completed: true } },
    1,
  );
  assert.deepEqual(changes, { completed: true });
  assert.throws(
    () => validateDeadlineUpdatePayload({ id: "dl-1", changes: { vehicleId: "other" } }, 1),
    (error) => error.code === "INVALID_CHANGES",
  );
});

test("validateDeadlineUpdatePayload allows clearing dueDate/dueMileage to null", () => {
  const { changes } = validateDeadlineUpdatePayload(
    { id: "dl-1", changes: { dueDate: null, dueMileage: null } },
    1,
  );
  assert.equal(changes.dueDate, null);
  assert.equal(changes.dueMileage, null);
});

test("validateDeleteIdPayload requires a valid id", () => {
  assert.throws(
    () => validateDeleteIdPayload({}),
    (error) => error.code === "INVALID_ID",
  );
  assert.deepEqual(validateDeleteIdPayload({ id: "vehicle-1" }), { id: "vehicle-1" });
});

test("assertCarMutationShape validates the whole-request envelope", () => {
  const valid = {
    idempotencyKey: randomUUID(),
    op: "vehicle.create",
    payload: { id: "vehicle-1" },
  };
  assert.doesNotThrow(() => assertCarMutationShape(valid));
  assert.throws(
    () => assertCarMutationShape({ ...valid, idempotencyKey: "not-a-uuid" }),
    (error) => error.statusCode === 400 && error.code === "INVALID_IDEMPOTENCY_KEY",
  );
  assert.throws(
    () => assertCarMutationShape({ ...valid, op: "vehicle.archive" }),
    (error) => error.statusCode === 400 && error.code === "UNSUPPORTED_OP",
  );
  assert.throws(
    () => assertCarMutationShape({ ...valid, payload: "nope" }),
    (error) => error.statusCode === 400,
  );
  assert.equal(SUPPORTED_CAR_OPS.has("vehicle.archive"), false, "vehicle.archive is out of scope");
});

test("row->DTO mappers convert snake_case/bigint-as-string/Date columns to the frontend shape", () => {
  const vehicle = vehicleRowToDto({
    id: "vehicle-1",
    owner_id: "user-1",
    visibility: "household",
    name: "Auto",
    make: "Toyota",
    model: "Corolla",
    year: 2020,
    plate: "WA12345",
    mileage: 1000,
    fuel_type: "petrol",
    inspection_date: "2026-08-01",
    insurance_date: "2026-09-01",
    color: "#397763",
    version: 2,
    updated_at: new Date("2026-07-01T10:00:00.000Z"),
  });
  assert.equal(vehicle.inspectionDate, "2026-08-01");
  assert.equal(vehicle.updatedAt, "2026-07-01T10:00:00.000Z");

  const expense = carExpenseRowToDto({
    id: "exp-1",
    owner_id: "user-1",
    visibility: "household",
    vehicle_id: "vehicle-1",
    date: "2026-07-01",
    type: "fuel",
    amount_minor: "15000", // bigint columns arrive as strings from node-postgres
    mileage: 1200,
    liters: 40,
    title: "Tankowanie",
    version: 1,
    updated_at: new Date("2026-07-01T10:00:00.000Z"),
  });
  assert.equal(expense.amountMinor, 15000);
  assert.equal(typeof expense.amountMinor, "number");
  assert.equal(expense.date, "2026-07-01");

  const deadline = vehicleDeadlineRowToDto({
    id: "dl-1",
    vehicle_id: "vehicle-1",
    kind: "inspection",
    title: "Badanie techniczne",
    due_date: "2026-08-01",
    due_mileage: null,
    completed: false,
    version: 1,
    updated_at: new Date("2026-07-01T10:00:00.000Z"),
  });
  assert.equal(deadline.dueDate, "2026-08-01");
  assert.equal(deadline.dueMileage, undefined);
});

// ---------------------------------------------------------------------------
// DB-backed integration tests. `npm run test:server` in CI (.github/workflows/ci.yml) does not
// provision a Postgres instance, so these are automatically skipped there via a short connectivity
// probe rather than being deleted or mocked -- they exercise the real SQL (OCC predicates, the
// partial unique index for the inspection/insurance upsert, the monotonic GREATEST mileage clamp)
// against a real database.
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
  const email = `car-test-${randomUUID()}@example.com`;
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
    [`car-test-${randomUUID()}@example.com`, label],
  );
  const userId = user.rows[0].id;
  await client.query(
    `INSERT INTO household_members(household_id, user_id, role) VALUES ($1, $2, 'member')`,
    [householdId, userId],
  );
  return userId;
}

function tripVehiclePayload(overrides = {}) {
  return {
    id: randomUUID(),
    name: "Auto",
    make: "Toyota",
    model: "Corolla",
    year: 2020,
    plate: "WA12345",
    mileage: 1000,
    fuelType: "petrol",
    inspectionDate: "2026-08-01",
    insuranceDate: "2026-09-01",
    color: "#397763",
    visibility: "household",
    ...overrides,
  };
}

dbTest(
  "vehicle.create atomically establishes inspection/insurance deadlines with the given dates",
  async () => {
    await withRollback(async (client) => {
      const { householdId, userId } = await createHouseholdAndUser(client, "owner");
      const ctx = { householdId, userId };
      const result = await applyCarMutation(client, ctx, {
        idempotencyKey: randomUUID(),
        op: "vehicle.create",
        payload: tripVehiclePayload(),
      });
      assert.equal(result.status, "applied");
      assert.equal(result.deadlines.length, 2);
      const inspection = result.deadlines.find((deadline) => deadline.kind === "inspection");
      const insurance = result.deadlines.find((deadline) => deadline.kind === "insurance");
      assert.equal(inspection.dueDate, "2026-08-01");
      assert.equal(insurance.dueDate, "2026-09-01");
      assert.equal(inspection.completed, false);
    });
  },
);

dbTest(
  "vehicle.update changing inspectionDate/insuranceDate upserts the matching deadline by kind " +
    "without resetting an already-completed one",
  async () => {
    await withRollback(async (client) => {
      const { householdId, userId } = await createHouseholdAndUser(client, "owner");
      const ctx = { householdId, userId };
      const vehicleId = randomUUID();
      const created = await applyCarMutation(client, ctx, {
        idempotencyKey: randomUUID(),
        op: "vehicle.create",
        payload: tripVehiclePayload({ id: vehicleId }),
      });
      const inspection = created.deadlines.find((deadline) => deadline.kind === "inspection");

      // Mark the auto-generated inspection deadline as completed directly (deadline.update).
      const completed = await applyCarMutation(client, ctx, {
        idempotencyKey: randomUUID(),
        op: "deadline.update",
        payload: { id: inspection.id, changes: { completed: true } },
        baseVersion: inspection.version,
      });
      assert.equal(completed.status, "applied");
      assert.equal(completed.record.completed, true);

      // Editing the vehicle's inspectionDate upserts the SAME row (matched by kind, not id) and must
      // NOT reset `completed` back to false.
      const updated = await applyCarMutation(client, ctx, {
        idempotencyKey: randomUUID(),
        op: "vehicle.update",
        payload: { id: vehicleId, changes: { inspectionDate: "2027-01-01" } },
        baseVersion: 1,
      });
      assert.equal(updated.status, "applied");
      assert.equal(updated.deadlines.length, 1);
      assert.equal(updated.deadlines[0].kind, "inspection");
      assert.equal(updated.deadlines[0].id, inspection.id);
      assert.equal(updated.deadlines[0].dueDate, "2027-01-01");
      assert.equal(
        updated.deadlines[0].completed,
        true,
        "editing the date must not un-complete it",
      );
    });
  },
);

dbTest(
  "vehicle.mileage is monotonic: two concurrent bumps both resolve to the maximum, and a rollback " +
    "attempt is rejected as a conflict carrying the authoritative (higher) value",
  async () => {
    await withRollback(async (client) => {
      const { householdId, userId } = await createHouseholdAndUser(client, "owner");
      const ctx = { householdId, userId };
      const vehicleId = randomUUID();
      await applyCarMutation(client, ctx, {
        idempotencyKey: randomUUID(),
        op: "vehicle.create",
        payload: tripVehiclePayload({ id: vehicleId, mileage: 1000 }),
      });

      // Two "concurrent" bumps: 1500 then 1200 (out of order/lower) -- both must resolve at 1500.
      const first = await applyCarMutation(client, ctx, {
        idempotencyKey: randomUUID(),
        op: "vehicle.mileage",
        payload: { id: vehicleId, mileage: 1500 },
      });
      assert.equal(first.status, "applied");
      assert.equal(first.record.mileage, 1500);

      const rollback = await applyCarMutation(client, ctx, {
        idempotencyKey: randomUUID(),
        op: "vehicle.mileage",
        payload: { id: vehicleId, mileage: 1200 },
      });
      assert.equal(rollback.status, "conflict");
      assert.equal(
        rollback.record.mileage,
        1500,
        "authoritative (higher) value returned, not lost",
      );

      // vehicle.mileage never bumps `version` (it's not OCC) -- both calls above must leave it at 1.
      assert.equal(first.record.version, 1);
      assert.equal(rollback.record.version, 1);
    });
  },
);

dbTest(
  "expense.create with a mileage reading bumps the vehicle's mileage monotonically as a side effect",
  async () => {
    await withRollback(async (client) => {
      const { householdId, userId } = await createHouseholdAndUser(client, "owner");
      const ctx = { householdId, userId };
      const vehicleId = randomUUID();
      await applyCarMutation(client, ctx, {
        idempotencyKey: randomUUID(),
        op: "vehicle.create",
        payload: tripVehiclePayload({ id: vehicleId, mileage: 1000 }),
      });

      const expenseResult = await applyCarMutation(client, ctx, {
        idempotencyKey: randomUUID(),
        op: "expense.create",
        payload: {
          id: randomUUID(),
          vehicleId,
          date: "2026-07-01",
          type: "fuel",
          amountMinor: 15000,
          mileage: 1300,
          liters: 40,
          title: "Tankowanie",
        },
      });
      assert.equal(expenseResult.status, "applied");
      assert.equal(expenseResult.vehicle.mileage, 1300);

      // A lower mileage reading on a subsequent expense must NOT roll the counter back.
      const lowerExpense = await applyCarMutation(client, ctx, {
        idempotencyKey: randomUUID(),
        op: "expense.create",
        payload: {
          id: randomUUID(),
          vehicleId,
          date: "2026-07-02",
          type: "fuel",
          amountMinor: 12000,
          mileage: 1100,
          liters: 35,
          title: "Tankowanie 2",
        },
      });
      assert.equal(lowerExpense.status, "applied");
      assert.equal(
        lowerExpense.vehicle.mileage,
        1300,
        "expense.create's mileage bump is monotonic too",
      );

      // An expense with no mileage reading must not carry a `vehicle` in its result at all.
      const noMileageExpense = await applyCarMutation(client, ctx, {
        idempotencyKey: randomUUID(),
        op: "expense.create",
        payload: {
          id: randomUUID(),
          vehicleId,
          date: "2026-07-03",
          type: "parking",
          amountMinor: 500,
          title: "Parking",
        },
      });
      assert.equal(noMileageExpense.status, "applied");
      assert.equal(noMileageExpense.vehicle, undefined);
    });
  },
);

dbTest(
  "a private record's existence/content is never leaked through another member's conflict response",
  async () => {
    await withRollback(async (client) => {
      const owner = await createHouseholdAndUser(client, "owner");
      const otherUserId = await addHouseholdMember(client, owner.householdId, "other");
      const vehicleId = randomUUID();
      await applyCarMutation(
        client,
        { householdId: owner.householdId, userId: owner.userId },
        {
          idempotencyKey: randomUUID(),
          op: "vehicle.create",
          payload: tripVehiclePayload({ id: vehicleId, visibility: "private" }),
        },
      );
      // Another household member attempting to update the owner's private vehicle must get a plain
      // NOT_FOUND -- not a conflict that would leak the private record's current version/content.
      const attempt = await applyCarMutation(
        client,
        { householdId: owner.householdId, userId: otherUserId },
        {
          idempotencyKey: randomUUID(),
          op: "vehicle.update",
          payload: { id: vehicleId, changes: { name: "Podmienione" } },
          baseVersion: 1,
        },
      );
      assert.equal(attempt.status, "error");
      assert.equal(attempt.code, "NOT_FOUND");

      const snapshotForOther = await readCarSnapshot(client, owner.householdId, otherUserId);
      assert.deepEqual(snapshotForOther.vehicles, []);
    });
  },
);

dbTest(
  "readCarSnapshot returns household-wide vehicles/expenses plus only the caller's own private " +
    "ones, and vehicle_deadlines are scoped through EXISTS on the parent vehicle",
  async () => {
    await withRollback(async (client) => {
      const owner = await createHouseholdAndUser(client, "owner");
      const otherUserId = await addHouseholdMember(client, owner.householdId, "other");
      const ctxOwner = { householdId: owner.householdId, userId: owner.userId };
      const ctxOther = { householdId: owner.householdId, userId: otherUserId };

      const sharedVehicleId = randomUUID();
      await applyCarMutation(client, ctxOwner, {
        idempotencyKey: randomUUID(),
        op: "vehicle.create",
        payload: tripVehiclePayload({
          id: sharedVehicleId,
          name: "Wspólne",
          visibility: "household",
        }),
      });
      const privateOwnerVehicleId = randomUUID();
      await applyCarMutation(client, ctxOwner, {
        idempotencyKey: randomUUID(),
        op: "vehicle.create",
        payload: tripVehiclePayload({
          id: privateOwnerVehicleId,
          name: "Prywatne właściciela",
          visibility: "private",
        }),
      });
      const privateOtherVehicleId = randomUUID();
      await applyCarMutation(client, ctxOther, {
        idempotencyKey: randomUUID(),
        op: "vehicle.create",
        payload: tripVehiclePayload({
          id: privateOtherVehicleId,
          name: "Prywatne innego",
          visibility: "private",
        }),
      });

      const snapshotForOwner = await readCarSnapshot(client, owner.householdId, owner.userId);
      assert.deepEqual(snapshotForOwner.vehicles.map((vehicle) => vehicle.name).sort(), [
        "Prywatne właściciela",
        "Wspólne",
      ]);
      // Each vehicle.create seeded 2 deadlines (inspection/insurance); the owner sees exactly the
      // deadlines of the vehicles visible to them (shared + their own private one), never the other
      // member's private vehicle's deadlines, even though vehicle_deadlines has no visibility column
      // of its own -- access must be scoped through EXISTS on the parent vehicle.
      assert.equal(snapshotForOwner.vehicleDeadlines.length, 4);
      assert.ok(
        snapshotForOwner.vehicleDeadlines.every(
          (deadline) =>
            deadline.vehicleId === sharedVehicleId || deadline.vehicleId === privateOwnerVehicleId,
        ),
      );

      const snapshotForOther = await readCarSnapshot(client, owner.householdId, otherUserId);
      assert.deepEqual(snapshotForOther.vehicles.map((vehicle) => vehicle.name).sort(), [
        "Prywatne innego",
        "Wspólne",
      ]);
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
        op: "vehicle.create",
        payload: tripVehiclePayload(),
      };
      const first = await applyCarMutation(client, ctx, mutation);
      const second = await applyCarMutation(client, ctx, mutation);
      assert.equal(first.status, "applied");
      // `second` comes back from a jsonb column, which drops undefined-valued keys (e.g. an unset
      // dueMileage) that `first` still carries in memory -- both serialize identically over the real
      // HTTP response, so compare them post-JSON round-trip rather than as raw JS objects.
      assert.deepEqual(second, JSON.parse(JSON.stringify(first)));
      const count = await client.query(
        "SELECT count(*)::int AS count FROM vehicles WHERE household_id = $1",
        [householdId],
      );
      assert.equal(count.rows[0].count, 1);
    });
  },
);

dbTest(
  "resetCarForUser (Settings 'Wyczyść dane aplikacji') deletes shared records and the caller's own " +
    "private records, but never another member's private records",
  async () => {
    await withRollback(async (client) => {
      const owner = await createHouseholdAndUser(client, "owner");
      const otherUserId = await addHouseholdMember(client, owner.householdId, "other");
      const ctxOwner = { householdId: owner.householdId, userId: owner.userId };
      const ctxOther = { householdId: owner.householdId, userId: otherUserId };

      await applyCarMutation(client, ctxOwner, {
        idempotencyKey: randomUUID(),
        op: "vehicle.create",
        payload: tripVehiclePayload({ name: "Wspólne", visibility: "household" }),
      });
      await applyCarMutation(client, ctxOwner, {
        idempotencyKey: randomUUID(),
        op: "vehicle.create",
        payload: tripVehiclePayload({ name: "Prywatne właściciela", visibility: "private" }),
      });
      await applyCarMutation(client, ctxOther, {
        idempotencyKey: randomUUID(),
        op: "vehicle.create",
        payload: tripVehiclePayload({ name: "Prywatne innego", visibility: "private" }),
      });

      await resetCarForUser(client, owner.householdId, owner.userId);

      const snapshotForOwner = await readCarSnapshot(client, owner.householdId, owner.userId);
      assert.deepEqual(snapshotForOwner.vehicles, []);
      assert.deepEqual(snapshotForOwner.vehicleDeadlines, []);
      const snapshotForOther = await readCarSnapshot(client, owner.householdId, otherUserId);
      assert.deepEqual(
        snapshotForOther.vehicles.map((vehicle) => vehicle.name),
        ["Prywatne innego"],
        "the other member's private vehicle must survive the owner's reset",
      );
    });
  },
);

dbTest(
  "upsertAutoDeadline used directly relies on the (vehicle_id, kind) partial unique index",
  async () => {
    await withRollback(async (client) => {
      const { householdId, userId } = await createHouseholdAndUser(client, "owner");
      const ctx = { householdId, userId };
      const vehicleId = randomUUID();
      await applyCarMutation(client, ctx, {
        idempotencyKey: randomUUID(),
        op: "vehicle.create",
        payload: tripVehiclePayload({ id: vehicleId }),
      });
      const first = await upsertAutoDeadline(
        client,
        ctx,
        vehicleId,
        "inspection",
        "Badanie techniczne",
        "2026-08-01",
      );
      const second = await upsertAutoDeadline(
        client,
        ctx,
        vehicleId,
        "inspection",
        "Badanie techniczne",
        "2026-09-01",
      );
      assert.equal(
        first.id,
        second.id,
        "the partial unique index keeps a single row per (vehicle_id, kind)",
      );
      assert.equal(second.dueDate, "2026-09-01");
      const count = await client.query(
        "SELECT count(*)::int AS count FROM vehicle_deadlines WHERE vehicle_id = $1 AND kind = 'inspection'",
        [vehicleId],
      );
      assert.equal(count.rows[0].count, 1);
    });
  },
);
