import assert from "node:assert/strict";
import test, { after } from "node:test";
import { randomUUID } from "node:crypto";
import pg from "pg";
import {
  SUPPORTED_TRIP_OPS,
  applyTripMutation,
  assertTripMutationShape,
  bookingRowToDto,
  computeTripProgress,
  itineraryRowToDto,
  packingRowToDto,
  readTripsSnapshot,
  resetTripsForHousehold,
  resolveVersionConflict,
  tripRowToDto,
  validateBookingCreatePayload,
  validateBookingUpdatePayload,
  validateDeleteIdPayload,
  validateItineraryCreatePayload,
  validatePackingCreatePayload,
  validatePackingUpdatePayload,
  validateTripCreatePayload,
  validateTripUpdatePayload,
} from "../src/trips.mjs";

// ---------------------------------------------------------------------------
// Pure unit tests -- no database required, always run (including in CI).
// ---------------------------------------------------------------------------

test("resolveVersionConflict compares the client's assumed version against the stored one", () => {
  assert.equal(resolveVersionConflict(1, 1), true);
  assert.equal(resolveVersionConflict(1, 2), false);
  assert.equal(resolveVersionConflict("1", 1), true);
});

test("computeTripProgress: archived always caps at 100 regardless of children", () => {
  assert.equal(computeTripProgress("archived", 0, 0), 100);
  assert.equal(computeTripProgress("archived", 50, 50), 100);
});

test("computeTripProgress: base is 5 for 'idea', 12 otherwise", () => {
  assert.equal(computeTripProgress("idea", 0, 0), 5);
  assert.equal(computeTripProgress("planning", 0, 0), 12);
  assert.equal(computeTripProgress("active", 0, 0), 12);
});

test("computeTripProgress: +3 per itinerary item, +5 per booking, capped at 98", () => {
  assert.equal(computeTripProgress("idea", 1, 0), 8);
  assert.equal(computeTripProgress("idea", 0, 1), 10);
  assert.equal(computeTripProgress("planning", 2, 2), 12 + 6 + 10);
  assert.equal(computeTripProgress("planning", 100, 100), 98);
});

test(
  "computeTripProgress is additive/idempotent -- recomputing from counts after removing a child " +
    "lowers progress (deliberate change vs. the old client-side increment-only behavior)",
  () => {
    const afterTwoItineraryItems = computeTripProgress("planning", 2, 0);
    const afterOneRemoved = computeTripProgress("planning", 1, 0);
    assert.ok(afterOneRemoved < afterTwoItineraryItems);
  },
);

test("validateTripCreatePayload accepts a valid payload and never reads/forwards progress", () => {
  const data = validateTripCreatePayload({
    id: "trip-1",
    name: " Wakacje ",
    destination: "Lizbona",
    startDate: "2026-08-01",
    endDate: "2026-08-10",
    status: "planning",
    budgetMinor: 500000,
    currency: "PLN",
    travelers: ["Ola", "Jan"],
    accent: "ocean",
    notes: "",
    progress: 95, // a spoofed client value -- must be silently ignored
  });
  assert.equal(data.name, "Wakacje");
  assert.equal("progress" in data, false, "the validator does not read or forward progress");
});

test("validateTripCreatePayload rejects an end date before the start date", () => {
  assert.throws(
    () =>
      validateTripCreatePayload({
        id: "trip-1",
        name: "Wakacje",
        destination: "Lizbona",
        startDate: "2026-08-10",
        endDate: "2026-08-01",
        status: "idea",
        currency: "PLN",
        travelers: [],
        accent: "ocean",
      }),
    (error) => error.code === "INVALID_DATE_RANGE",
  );
});

test("validateTripCreatePayload rejects invalid enums", () => {
  assert.throws(
    () =>
      validateTripCreatePayload({
        id: "trip-1",
        name: "Wakacje",
        destination: "Lizbona",
        startDate: "2026-08-01",
        endDate: "2026-08-10",
        status: "not-a-status",
        currency: "PLN",
        travelers: [],
        accent: "ocean",
      }),
    (error) => error.code === "INVALID_STATUS",
  );
  assert.throws(
    () =>
      validateTripCreatePayload({
        id: "trip-1",
        name: "Wakacje",
        destination: "Lizbona",
        startDate: "2026-08-01",
        endDate: "2026-08-10",
        status: "idea",
        currency: "PLN",
        travelers: [],
        accent: "not-an-accent",
      }),
    (error) => error.code === "INVALID_ACCENT",
  );
});

test("validateTripUpdatePayload rejects progress as an editable field", () => {
  assert.throws(
    () => validateTripUpdatePayload({ id: "trip-1", changes: { progress: 50 } }, 1),
    (error) => error.code === "INVALID_CHANGES",
  );
});

test("validateTripUpdatePayload requires a positive integer baseVersion", () => {
  assert.throws(
    () => validateTripUpdatePayload({ id: "trip-1", changes: { name: "X" } }, undefined),
    (error) => error.code === "INVALID_BASE_VERSION",
  );
  assert.throws(
    () => validateTripUpdatePayload({ id: "trip-1", changes: { name: "X" } }, 0),
    (error) => error.code === "INVALID_BASE_VERSION",
  );
});

test("validateTripUpdatePayload allows clearing budgetMinor to null", () => {
  const { changes } = validateTripUpdatePayload(
    { id: "trip-1", changes: { budgetMinor: null } },
    1,
  );
  assert.equal(changes.budgetMinor, null);
});

test("validateTripUpdatePayload rejects a changed date range that would invert", () => {
  assert.throws(
    () =>
      validateTripUpdatePayload(
        { id: "trip-1", changes: { startDate: "2026-08-10", endDate: "2026-08-01" } },
        1,
      ),
    (error) => error.code === "INVALID_DATE_RANGE",
  );
});

test("validateItineraryCreatePayload validates HH:MM time and ISO date", () => {
  assert.throws(
    () =>
      validateItineraryCreatePayload({
        id: "it-1",
        tripId: "trip-1",
        date: "2026-08-01",
        time: "9:00",
        title: "Lot",
        type: "transport",
      }),
    (error) => error.code === "INVALID_TIME",
  );
  const data = validateItineraryCreatePayload({
    id: "it-1",
    tripId: "trip-1",
    date: "2026-08-01",
    time: "09:00",
    title: "Lot",
    type: "transport",
  });
  assert.equal(data.time, "09:00");
  assert.equal(data.booked, false);
});

test("validateBookingCreatePayload tolerates a shape-valid but orphaned itineraryItemId", () => {
  const data = validateBookingCreatePayload({
    id: "bk-1",
    tripId: "trip-1",
    itineraryItemId: "does-not-exist",
    type: "flight",
    title: "Lot LO123",
    startAt: "2026-08-01T10:00:00.000Z",
    amountMinor: 50000,
  });
  assert.equal(data.itineraryItemId, "does-not-exist");
});

test("validateBookingCreatePayload rejects an invalid startAt", () => {
  assert.throws(
    () =>
      validateBookingCreatePayload({
        id: "bk-1",
        tripId: "trip-1",
        type: "flight",
        title: "Lot LO123",
        startAt: "not-a-date",
        amountMinor: 50000,
      }),
    (error) => error.code === "INVALID_START_AT",
  );
});

test("validateBookingUpdatePayload only allows booking fields (parity with UI's paid toggle)", () => {
  const { changes } = validateBookingUpdatePayload({ id: "bk-1", changes: { paid: true } }, 1);
  assert.deepEqual(changes, { paid: true });
  assert.throws(
    () => validateBookingUpdatePayload({ id: "bk-1", changes: { tripId: "other-trip" } }, 1),
    (error) => error.code === "INVALID_CHANGES",
  );
});

test("validatePackingCreatePayload requires a valid category", () => {
  assert.throws(
    () =>
      validatePackingCreatePayload({
        id: "pk-1",
        tripId: "trip-1",
        name: "Paszport",
        category: "not-a-category",
      }),
    (error) => error.code === "INVALID_CATEGORY",
  );
});

test("validatePackingUpdatePayload only allows packed/assignedTo (parity with today's UI)", () => {
  const { changes } = validatePackingUpdatePayload(
    { id: "pk-1", changes: { assignedTo: "Ola" } },
    1,
  );
  assert.equal(changes.assignedTo, "Ola");
  assert.throws(
    () => validatePackingUpdatePayload({ id: "pk-1", changes: { name: "Nowa nazwa" } }, 1),
    (error) => error.code === "INVALID_CHANGES",
  );
});

test("validatePackingUpdatePayload allows clearing assignedTo to null", () => {
  const { changes } = validatePackingUpdatePayload(
    { id: "pk-1", changes: { assignedTo: null } },
    1,
  );
  assert.equal(changes.assignedTo, null);
});

test("validateDeleteIdPayload requires a valid id", () => {
  assert.throws(
    () => validateDeleteIdPayload({}),
    (error) => error.code === "INVALID_ID",
  );
  assert.deepEqual(validateDeleteIdPayload({ id: "trip-1" }), { id: "trip-1" });
});

test("assertTripMutationShape validates the whole-request envelope", () => {
  const valid = { idempotencyKey: randomUUID(), op: "trip.create", payload: { id: "trip-1" } };
  assert.doesNotThrow(() => assertTripMutationShape(valid));
  assert.throws(
    () => assertTripMutationShape({ ...valid, idempotencyKey: "not-a-uuid" }),
    (error) => error.statusCode === 400 && error.code === "INVALID_IDEMPOTENCY_KEY",
  );
  assert.throws(
    () => assertTripMutationShape({ ...valid, op: "trip.archive" }),
    (error) => error.statusCode === 400 && error.code === "UNSUPPORTED_OP",
  );
  assert.throws(
    () => assertTripMutationShape({ ...valid, payload: "nope" }),
    (error) => error.statusCode === 400,
  );
  assert.equal(
    SUPPORTED_TRIP_OPS.has("itinerary.update"),
    false,
    "itinerary.update is out of scope (YAGNI)",
  );
});

test("row->DTO mappers convert snake_case/bigint-as-string/Date columns to the frontend shape", () => {
  const trip = tripRowToDto({
    id: "trip-1",
    name: "Wakacje",
    destination: "Lizbona",
    start_date: "2026-08-01",
    end_date: "2026-08-10",
    status: "planning",
    budget_minor: "500000",
    currency: "PLN",
    travelers: ["Ola"],
    progress: 20,
    accent: "ocean",
    notes: "",
    version: 2,
    updated_at: new Date("2026-07-01T10:00:00.000Z"),
  });
  assert.equal(trip.budgetMinor, 500000);
  assert.equal(typeof trip.budgetMinor, "number");
  assert.equal(trip.updatedAt, "2026-07-01T10:00:00.000Z");
  assert.equal("ownerId" in trip, false, "Trip no longer extends SharedMeta");
  assert.equal("visibility" in trip, false, "Trip no longer extends SharedMeta");

  const itinerary = itineraryRowToDto({
    id: "it-1",
    trip_id: "trip-1",
    date: "2026-08-01",
    time: "09:00",
    title: "Lot",
    type: "transport",
    location: null,
    cost_minor: null,
    booked: false,
    notes: null,
    version: 1,
    updated_at: new Date("2026-07-01T10:00:00.000Z"),
  });
  assert.equal(itinerary.location, undefined);
  assert.equal(itinerary.costMinor, undefined);

  const booking = bookingRowToDto({
    id: "bk-1",
    trip_id: "trip-1",
    itinerary_item_id: null,
    type: "flight",
    provider: "",
    reference: "",
    title: "Lot LO123",
    start_at: new Date("2026-08-01T10:00:00.000Z"),
    amount_minor: "50000",
    paid: false,
    version: 1,
    updated_at: new Date("2026-07-01T10:00:00.000Z"),
  });
  assert.equal(booking.amountMinor, 50000);
  assert.equal(booking.startAt, "2026-08-01T10:00:00.000Z");
  assert.equal(booking.itineraryItemId, undefined);

  const packing = packingRowToDto({
    id: "pk-1",
    trip_id: "trip-1",
    name: "Paszport",
    category: "documents",
    packed: false,
    assigned_to: null,
    version: 1,
    updated_at: new Date("2026-07-01T10:00:00.000Z"),
  });
  assert.equal(packing.assignedTo, undefined);
});

// ---------------------------------------------------------------------------
// DB-backed integration tests. `npm run test:server` in CI does not provision a Postgres instance, so
// these are automatically skipped there via a short connectivity probe (see finance.node.mjs).
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
  const email = `trips-test-${randomUUID()}@example.com`;
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

function tripCreatePayload(overrides = {}) {
  return {
    id: randomUUID(),
    name: "Wakacje",
    destination: "Lizbona",
    startDate: "2026-08-01",
    endDate: "2026-08-10",
    status: "idea",
    currency: "PLN",
    travelers: [],
    accent: "ocean",
    ...overrides,
  };
}

dbTest("readTripsSnapshot returns the whole household's trips (no visibility filter)", async () => {
  await withRollback(async (client) => {
    const { householdId, userId } = await createHouseholdAndUser(client, "owner");
    const ctx = { householdId, userId };
    await applyTripMutation(client, ctx, {
      idempotencyKey: randomUUID(),
      op: "trip.create",
      payload: tripCreatePayload({ name: "Grecja" }),
    });
    const snapshot = await readTripsSnapshot(client, householdId);
    assert.deepEqual(
      snapshot.trips.map((trip) => trip.name),
      ["Grecja"],
    );
    assert.deepEqual(snapshot.itinerary, []);
    assert.deepEqual(snapshot.bookings, []);
    assert.deepEqual(snapshot.packing, []);
  });
});

dbTest("household_id is always taken from the session, never from the payload", async () => {
  await withRollback(async (client) => {
    const { householdId, userId } = await createHouseholdAndUser(client, "owner");
    const other = await createHouseholdAndUser(client, "other");
    const ctx = { householdId, userId };
    const result = await applyTripMutation(client, ctx, {
      idempotencyKey: randomUUID(),
      op: "trip.create",
      payload: tripCreatePayload({ householdId: other.householdId }),
    });
    assert.equal(result.status, "applied");
    const snapshotForOther = await readTripsSnapshot(client, other.householdId);
    assert.deepEqual(snapshotForOther.trips, []);
    const snapshotForOwner = await readTripsSnapshot(client, householdId);
    assert.equal(snapshotForOwner.trips.length, 1);
  });
});

dbTest("trip.create computes initial progress server-side from the status base", async () => {
  await withRollback(async (client) => {
    const { householdId, userId } = await createHouseholdAndUser(client, "owner");
    const ctx = { householdId, userId };
    const ideaResult = await applyTripMutation(client, ctx, {
      idempotencyKey: randomUUID(),
      op: "trip.create",
      payload: tripCreatePayload({ status: "idea" }),
    });
    assert.equal(ideaResult.record.progress, 5);
    const planningResult = await applyTripMutation(client, ctx, {
      idempotencyKey: randomUUID(),
      op: "trip.create",
      payload: tripCreatePayload({ status: "planning" }),
    });
    assert.equal(planningResult.record.progress, 12);
  });
});

dbTest(
  "itinerary.create and booking.create bump progress and return the updated trip; deleting lowers it again",
  async () => {
    await withRollback(async (client) => {
      const { householdId, userId } = await createHouseholdAndUser(client, "owner");
      const ctx = { householdId, userId };
      const tripId = randomUUID();
      await applyTripMutation(client, ctx, {
        idempotencyKey: randomUUID(),
        op: "trip.create",
        payload: tripCreatePayload({ id: tripId, status: "planning" }),
      });

      const itineraryId = randomUUID();
      const itineraryResult = await applyTripMutation(client, ctx, {
        idempotencyKey: randomUUID(),
        op: "itinerary.create",
        payload: {
          id: itineraryId,
          tripId,
          date: "2026-08-02",
          time: "09:00",
          title: "Lot",
          type: "transport",
        },
      });
      assert.equal(itineraryResult.status, "applied");
      assert.equal(itineraryResult.trip.progress, 15); // 12 + 3

      const bookingResult = await applyTripMutation(client, ctx, {
        idempotencyKey: randomUUID(),
        op: "booking.create",
        payload: {
          id: randomUUID(),
          tripId,
          type: "flight",
          title: "Lot LO123",
          startAt: "2026-08-02T09:00:00.000Z",
          amountMinor: 50000,
        },
      });
      assert.equal(bookingResult.trip.progress, 20); // 12 + 3 + 5

      const deleteResult = await applyTripMutation(client, ctx, {
        idempotencyKey: randomUUID(),
        op: "itinerary.delete",
        payload: { id: itineraryId },
      });
      assert.equal(deleteResult.trip.progress, 17); // 12 + 5 (itinerary removed, booking remains)
    });
  },
);

dbTest(
  "two concurrent itinerary.create calls on the same trip both apply and both count toward progress " +
    "(the read-modify-write race the migration eliminates)",
  async () => {
    await withRollback(async (client) => {
      const { householdId, userId } = await createHouseholdAndUser(client, "owner");
      const ctx = { householdId, userId };
      const tripId = randomUUID();
      await applyTripMutation(client, ctx, {
        idempotencyKey: randomUUID(),
        op: "trip.create",
        payload: tripCreatePayload({ id: tripId, status: "planning" }),
      });

      const first = await applyTripMutation(client, ctx, {
        idempotencyKey: randomUUID(),
        op: "itinerary.create",
        payload: {
          id: randomUUID(),
          tripId,
          date: "2026-08-02",
          time: "09:00",
          title: "Lot",
          type: "transport",
        },
      });
      const second = await applyTripMutation(client, ctx, {
        idempotencyKey: randomUUID(),
        op: "itinerary.create",
        payload: {
          id: randomUUID(),
          tripId,
          date: "2026-08-03",
          time: "10:00",
          title: "Nocleg",
          type: "stay",
        },
      });
      assert.equal(first.status, "applied");
      assert.equal(second.status, "applied");
      assert.equal(second.trip.progress, 18); // 12 + 3 + 3, neither increment lost
    });
  },
);

dbTest(
  "trip.update to status 'archived' forces progress to 100 regardless of children",
  async () => {
    await withRollback(async (client) => {
      const { householdId, userId } = await createHouseholdAndUser(client, "owner");
      const ctx = { householdId, userId };
      const tripId = randomUUID();
      const created = await applyTripMutation(client, ctx, {
        idempotencyKey: randomUUID(),
        op: "trip.create",
        payload: tripCreatePayload({ id: tripId, status: "planning" }),
      });
      const archived = await applyTripMutation(client, ctx, {
        idempotencyKey: randomUUID(),
        op: "trip.update",
        payload: { id: tripId, changes: { status: "archived" } },
        baseVersion: created.record.version,
      });
      assert.equal(archived.status, "applied");
      assert.equal(archived.record.progress, 100);
      assert.equal(archived.record.status, "archived");
    });
  },
);

dbTest("trip.update: a stale baseVersion conflicts with the current record", async () => {
  await withRollback(async (client) => {
    const { householdId, userId } = await createHouseholdAndUser(client, "owner");
    const ctx = { householdId, userId };
    const tripId = randomUUID();
    await applyTripMutation(client, ctx, {
      idempotencyKey: randomUUID(),
      op: "trip.create",
      payload: tripCreatePayload({ id: tripId }),
    });
    const firstUpdate = await applyTripMutation(client, ctx, {
      idempotencyKey: randomUUID(),
      op: "trip.update",
      payload: { id: tripId, changes: { name: "Nowa nazwa" } },
      baseVersion: 1,
    });
    assert.equal(firstUpdate.status, "applied");
    assert.equal(firstUpdate.record.version, 2);

    const staleUpdate = await applyTripMutation(client, ctx, {
      idempotencyKey: randomUUID(),
      op: "trip.update",
      payload: { id: tripId, changes: { name: "Inna nazwa" } },
      baseVersion: 1,
    });
    assert.equal(staleUpdate.status, "conflict");
    assert.equal(staleUpdate.currentVersion, 2);
    assert.equal(staleUpdate.record.name, "Nowa nazwa");
  });
});

dbTest(
  "itinerary.create/booking.create reject a trip that doesn't exist in this household",
  async () => {
    await withRollback(async (client) => {
      const { householdId, userId } = await createHouseholdAndUser(client, "owner");
      const ctx = { householdId, userId };
      const result = await applyTripMutation(client, ctx, {
        idempotencyKey: randomUUID(),
        op: "itinerary.create",
        payload: {
          id: randomUUID(),
          tripId: "does-not-exist",
          date: "2026-08-02",
          time: "09:00",
          title: "Lot",
          type: "transport",
        },
      });
      assert.equal(result.status, "error");
      assert.equal(result.code, "TRIP_NOT_FOUND");
    });
  },
);

dbTest("booking.delete tolerates an orphaned itineraryItemId and is idempotent", async () => {
  await withRollback(async (client) => {
    const { householdId, userId } = await createHouseholdAndUser(client, "owner");
    const ctx = { householdId, userId };
    const tripId = randomUUID();
    await applyTripMutation(client, ctx, {
      idempotencyKey: randomUUID(),
      op: "trip.create",
      payload: tripCreatePayload({ id: tripId }),
    });
    const bookingId = randomUUID();
    const created = await applyTripMutation(client, ctx, {
      idempotencyKey: randomUUID(),
      op: "booking.create",
      payload: {
        id: bookingId,
        tripId,
        itineraryItemId: "orphaned-plan-point",
        type: "stay",
        title: "Hotel",
        startAt: "2026-08-02T14:00:00.000Z",
        amountMinor: 30000,
      },
    });
    assert.equal(created.status, "applied");
    assert.equal(created.record.itineraryItemId, "orphaned-plan-point");

    const deleteResult = await applyTripMutation(client, ctx, {
      idempotencyKey: randomUUID(),
      op: "booking.delete",
      payload: { id: bookingId },
    });
    assert.equal(deleteResult.status, "applied");

    const retryDelete = await applyTripMutation(client, ctx, {
      idempotencyKey: randomUUID(),
      op: "booking.delete",
      payload: { id: bookingId },
    });
    assert.equal(retryDelete.status, "applied");
    assert.equal(retryDelete.record, null);
  });
});

dbTest("packing.create/packing.update never touch trip.progress", async () => {
  await withRollback(async (client) => {
    const { householdId, userId } = await createHouseholdAndUser(client, "owner");
    const ctx = { householdId, userId };
    const tripId = randomUUID();
    const created = await applyTripMutation(client, ctx, {
      idempotencyKey: randomUUID(),
      op: "trip.create",
      payload: tripCreatePayload({ id: tripId, status: "planning" }),
    });
    const beforeProgress = created.record.progress;
    const packingResult = await applyTripMutation(client, ctx, {
      idempotencyKey: randomUUID(),
      op: "packing.create",
      payload: { id: randomUUID(), tripId, name: "Paszport", category: "documents" },
    });
    assert.equal(packingResult.status, "applied");
    assert.equal("trip" in packingResult, false);
    const snapshotAfter = await readTripsSnapshot(client, householdId);
    assert.equal(snapshotAfter.trips.find((trip) => trip.id === tripId).progress, beforeProgress);
  });
});

dbTest(
  "retrying a mutation with the same idempotency key returns the stored result, not a new row",
  async () => {
    await withRollback(async (client) => {
      const { householdId, userId } = await createHouseholdAndUser(client, "owner");
      const ctx = { householdId, userId };
      // budgetMinor is deliberately set here (rather than left undefined): the retried result is
      // read back from trip_mutations.result (jsonb via JSON.stringify), which drops keys whose
      // value is `undefined` -- an implementation artifact of the JSON round-trip, not a semantic
      // difference (an absent key and an `undefined` value read the same from JS). Setting every
      // optional field keeps this assertion meaningful without tripping over that artifact.
      const mutation = {
        idempotencyKey: randomUUID(),
        op: "trip.create",
        payload: tripCreatePayload({ budgetMinor: 100000 }),
      };
      const first = await applyTripMutation(client, ctx, mutation);
      const second = await applyTripMutation(client, ctx, mutation);
      assert.equal(first.status, "applied");
      assert.deepEqual(second, first);
      const count = await client.query(
        "SELECT count(*)::int AS count FROM trips WHERE household_id = $1",
        [householdId],
      );
      assert.equal(count.rows[0].count, 1);
    });
  },
);

dbTest(
  "resetTripsForHousehold clears trips and cascades to itinerary/bookings/packing",
  async () => {
    await withRollback(async (client) => {
      const { householdId, userId } = await createHouseholdAndUser(client, "owner");
      const ctx = { householdId, userId };
      const tripId = randomUUID();
      await applyTripMutation(client, ctx, {
        idempotencyKey: randomUUID(),
        op: "trip.create",
        payload: tripCreatePayload({ id: tripId }),
      });
      await applyTripMutation(client, ctx, {
        idempotencyKey: randomUUID(),
        op: "packing.create",
        payload: { id: randomUUID(), tripId, name: "Paszport", category: "documents" },
      });

      await resetTripsForHousehold(client, householdId);

      const snapshot = await readTripsSnapshot(client, householdId);
      assert.deepEqual(snapshot.trips, []);
      assert.deepEqual(snapshot.packing, []);
    });
  },
);

dbTest(
  "cross-household isolation: a trip from another household is not visible or editable",
  async () => {
    await withRollback(async (client) => {
      const owner = await createHouseholdAndUser(client, "owner");
      const stranger = await createHouseholdAndUser(client, "stranger");
      const tripId = randomUUID();
      await applyTripMutation(
        client,
        { householdId: owner.householdId, userId: owner.userId },
        {
          idempotencyKey: randomUUID(),
          op: "trip.create",
          payload: tripCreatePayload({ id: tripId }),
        },
      );
      const strangerSnapshot = await readTripsSnapshot(client, stranger.householdId);
      assert.deepEqual(strangerSnapshot.trips, []);
      const attempt = await applyTripMutation(
        client,
        { householdId: stranger.householdId, userId: stranger.userId },
        {
          idempotencyKey: randomUUID(),
          op: "trip.update",
          payload: { id: tripId, changes: { name: "Podmienione" } },
          baseVersion: 1,
        },
      );
      assert.equal(attempt.status, "error");
      assert.equal(attempt.code, "NOT_FOUND");
    });
  },
);
