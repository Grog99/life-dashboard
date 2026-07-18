import assert from "node:assert/strict";
import test, { after } from "node:test";
import { randomUUID } from "node:crypto";
import pg from "pg";
import {
  HealthValidationError,
  SUPPORTED_HEALTH_OPS,
  applyHealthMutation,
  appointmentRowToDto,
  assertHealthMutationShape,
  measurementRowToDto,
  medicationRowToDto,
  readHealthSnapshot,
  resetHealthForUser,
  resolveOwnerId,
  resolveVersionConflict,
  validateAppointmentCreatePayload,
  validateAppointmentUpdatePayload,
  validateDeleteIdPayload,
  validateMeasurementCreatePayload,
  validateMeasurementUpdatePayload,
  validateMedicationCreatePayload,
  validateMedicationUpdatePayload,
} from "../src/health.mjs";

// ---------------------------------------------------------------------------
// Pure unit tests -- no database required, always run (including in CI).
// ---------------------------------------------------------------------------

test("resolveOwnerId always returns the session user, never a client-supplied value", () => {
  const ctx = { userId: "session-user", householdId: "household-1" };
  assert.equal(resolveOwnerId(ctx), "session-user");
});

test("resolveVersionConflict compares the client's assumed version against the stored one", () => {
  assert.equal(resolveVersionConflict(1, 1), true);
  assert.equal(resolveVersionConflict(1, 2), false);
  assert.equal(resolveVersionConflict("1", 1), true);
});

function appointmentPayload(overrides = {}) {
  return {
    id: "appt-1",
    title: "Kontrola",
    clinician: "Dr. Kowalska",
    specialty: "Kardiolog",
    date: "2026-07-20",
    time: "10:30",
    location: "Przychodnia",
    status: "scheduled",
    notes: "Na czczo",
    visibility: "household",
    ...overrides,
  };
}

test("validateAppointmentCreatePayload accepts a well-shaped payload and never reads/forwards ownerId", () => {
  const data = validateAppointmentCreatePayload(appointmentPayload({ ownerId: "someone-else" }));
  assert.equal(data.title, "Kontrola");
  assert.equal(data.visibility, "household");
  assert.equal("ownerId" in data, false, "the validator does not read or forward ownerId");
});

test("validateAppointmentCreatePayload rejects invalid fields", () => {
  assert.throws(() => validateAppointmentCreatePayload({}), HealthValidationError);
  assert.throws(
    () => validateAppointmentCreatePayload(appointmentPayload({ title: "" })),
    (error) => error.code === "INVALID_TITLE",
  );
  assert.throws(
    () => validateAppointmentCreatePayload(appointmentPayload({ clinician: "" })),
    (error) => error.code === "INVALID_CLINICIAN",
  );
  assert.throws(
    () => validateAppointmentCreatePayload(appointmentPayload({ date: "not-a-date" })),
    (error) => error.code === "INVALID_DATE",
  );
  assert.throws(
    () => validateAppointmentCreatePayload(appointmentPayload({ time: "10-30" })),
    (error) => error.code === "INVALID_TIME",
  );
  assert.throws(
    () => validateAppointmentCreatePayload(appointmentPayload({ status: "not-a-status" })),
    (error) => error.code === "INVALID_STATUS",
  );
  assert.throws(
    () => validateAppointmentCreatePayload(appointmentPayload({ visibility: "public" })),
    (error) => error.code === "INVALID_VISIBILITY",
  );
});

test("validateAppointmentUpdatePayload only allows APPOINTMENT_UPDATE_KEYS, including visibility", () => {
  assert.throws(
    () => validateAppointmentUpdatePayload({ id: "appt-1", changes: { ownerId: "other" } }, 1),
    (error) => error.code === "INVALID_CHANGES",
  );
  // `visibility` IS editable -- explicit regression coverage for the Finance-era bug where
  // `*.update` silently dropped visibility changes.
  const { changes, baseVersion } = validateAppointmentUpdatePayload(
    { id: "appt-1", changes: { title: " Nowy tytuł ", visibility: "private" } },
    2,
  );
  assert.equal(changes.title, "Nowy tytuł");
  assert.equal(changes.visibility, "private");
  assert.equal(baseVersion, 2);
});

test("validateAppointmentUpdatePayload requires a positive integer baseVersion", () => {
  assert.throws(
    () => validateAppointmentUpdatePayload({ id: "appt-1", changes: { title: "X" } }, undefined),
    (error) => error.code === "INVALID_BASE_VERSION",
  );
  assert.throws(
    () => validateAppointmentUpdatePayload({ id: "appt-1", changes: { title: "X" } }, 0),
    (error) => error.code === "INVALID_BASE_VERSION",
  );
});

test("validateAppointmentUpdatePayload allows clearing specialty/location/notes to null, and toggleAppointmentCompleted's exact shape", () => {
  const { changes } = validateAppointmentUpdatePayload(
    { id: "appt-1", changes: { specialty: null, location: null, notes: null } },
    1,
  );
  assert.equal(changes.specialty, null);
  assert.equal(changes.location, null);
  assert.equal(changes.notes, null);

  // toggleAppointmentCompleted (HealthPage.tsx) sends exactly this shape.
  const toggled = validateAppointmentUpdatePayload(
    { id: "appt-1", changes: { status: "completed" } },
    3,
  );
  assert.deepEqual(toggled.changes, { status: "completed" });
});

test("validateDeleteIdPayload requires a valid id", () => {
  assert.throws(
    () => validateDeleteIdPayload({}),
    (error) => error.code === "INVALID_ID",
  );
  assert.deepEqual(validateDeleteIdPayload({ id: "appt-1" }), { id: "appt-1" });
});

function medicationPayload(overrides = {}) {
  return {
    id: "med-1",
    name: "Ibuprom",
    dosage: "200mg",
    schedule: "1x dziennie",
    active: true,
    lastTakenOn: "2026-07-18",
    reminderTime: "08:00",
    visibility: "household",
    ...overrides,
  };
}

test("validateMedicationCreatePayload accepts a well-shaped payload and never reads/forwards ownerId", () => {
  const data = validateMedicationCreatePayload(medicationPayload({ ownerId: "someone-else" }));
  assert.equal(data.name, "Ibuprom");
  assert.equal(data.lastTakenOn, "2026-07-18");
  assert.equal("ownerId" in data, false);
});

test("validateMedicationCreatePayload rejects invalid fields", () => {
  assert.throws(() => validateMedicationCreatePayload({}), HealthValidationError);
  assert.throws(
    () => validateMedicationCreatePayload(medicationPayload({ name: "" })),
    (error) => error.code === "INVALID_NAME",
  );
  assert.throws(
    () => validateMedicationCreatePayload(medicationPayload({ dosage: "" })),
    (error) => error.code === "INVALID_DOSAGE",
  );
  assert.throws(
    () => validateMedicationCreatePayload(medicationPayload({ schedule: "" })),
    (error) => error.code === "INVALID_SCHEDULE",
  );
  assert.throws(
    () => validateMedicationCreatePayload(medicationPayload({ active: "yes" })),
    (error) => error.code === "INVALID_ACTIVE",
  );
  assert.throws(
    () => validateMedicationCreatePayload(medicationPayload({ lastTakenOn: "not-a-date" })),
    (error) => error.code === "INVALID_LAST_TAKEN_ON",
  );
  assert.throws(
    () => validateMedicationCreatePayload(medicationPayload({ reminderTime: "8am" })),
    (error) => error.code === "INVALID_REMINDER_TIME",
  );
});

test("validateMedicationUpdatePayload only allows MEDICATION_UPDATE_KEYS, including visibility", () => {
  assert.throws(
    () => validateMedicationUpdatePayload({ id: "med-1", changes: { ownerId: "other" } }, 1),
    (error) => error.code === "INVALID_CHANGES",
  );
  const { changes } = validateMedicationUpdatePayload(
    { id: "med-1", changes: { name: " Nowa nazwa ", visibility: "private" } },
    1,
  );
  assert.equal(changes.name, "Nowa nazwa");
  assert.equal(changes.visibility, "private");
});

test("validateMedicationUpdatePayload treats lastTakenOn as a real client-computed toggle: null clears the column, a date sets it, and it is never re-derived server-side", () => {
  // toggleMedicationTaken (useHealthStore.ts) sends `changes: { lastTakenOn }` with the value it
  // already computed locally -- the validator must persist exactly what it's given, both
  // directions, using the hasOwnProperty pattern (not `undefined` == "leave unchanged").
  const cleared = validateMedicationUpdatePayload(
    { id: "med-1", changes: { lastTakenOn: null } },
    1,
  );
  assert.equal(cleared.changes.lastTakenOn, null);

  const set = validateMedicationUpdatePayload(
    { id: "med-1", changes: { lastTakenOn: "2026-07-18" } },
    1,
  );
  assert.equal(set.changes.lastTakenOn, "2026-07-18");

  // omitted entirely -- not part of `changes` at all (distinct from explicit null).
  const omitted = validateMedicationUpdatePayload({ id: "med-1", changes: { name: "X" } }, 1);
  assert.equal("lastTakenOn" in omitted.changes, false);

  assert.throws(
    () =>
      validateMedicationUpdatePayload({ id: "med-1", changes: { lastTakenOn: "not-a-date" } }, 1),
    (error) => error.code === "INVALID_LAST_TAKEN_ON",
  );

  // toggleMedicationActive sends exactly this shape.
  const activeToggle = validateMedicationUpdatePayload(
    { id: "med-1", changes: { active: false } },
    2,
  );
  assert.deepEqual(activeToggle.changes, { active: false });
});

function measurementPayload(overrides = {}) {
  return {
    id: "measure-1",
    type: "blood_pressure",
    value: "120/80",
    unit: "mmHg",
    measuredAt: "2026-07-18T07:30",
    notes: "Rano, przed śniadaniem",
    visibility: "household",
    ...overrides,
  };
}

test("validateMeasurementCreatePayload accepts a well-shaped payload and never reads/forwards ownerId", () => {
  const data = validateMeasurementCreatePayload(measurementPayload({ ownerId: "someone-else" }));
  assert.equal(data.value, "120/80");
  assert.equal(data.measuredAt, "2026-07-18T07:30");
  assert.equal("ownerId" in data, false);
});

test("validateMeasurementCreatePayload's measuredAt uses isParsableTimestamp (Date.parse), NOT isIsoDate: free-form datetime strings pass, garbage is rejected", () => {
  // `${date}T${time}` (HealthPage.tsx's construction) has no seconds/timezone -- a plain isoDate
  // regex (`^\d{4}-\d{2}-\d{2}$`) would reject this outright, so this specifically exercises the
  // new isParsableTimestamp primitive rather than the appointment/measurement `date` validator.
  assert.doesNotThrow(() =>
    validateMeasurementCreatePayload(measurementPayload({ measuredAt: "2026-07-18T07:30" })),
  );
  // A bare ISO date (no time component) is still Date.parse-able.
  assert.doesNotThrow(() =>
    validateMeasurementCreatePayload(measurementPayload({ measuredAt: "2026-07-18" })),
  );
  // Anything Date.parse can make sense of, however unconventional, is accepted -- this is
  // deliberately permissive (free-form text field, not a strict ISO date).
  assert.doesNotThrow(() =>
    validateMeasurementCreatePayload(measurementPayload({ measuredAt: "July 18, 2026" })),
  );

  const invalidMeasuredAt = (error) => error.code === "INVALID_MEASURED_AT";
  assert.throws(
    () => validateMeasurementCreatePayload(measurementPayload({ measuredAt: "not-a-timestamp" })),
    invalidMeasuredAt,
  );
  assert.throws(
    () => validateMeasurementCreatePayload(measurementPayload({ measuredAt: "" })),
    invalidMeasuredAt,
    "empty string",
  );
  assert.throws(
    () => validateMeasurementCreatePayload(measurementPayload({ measuredAt: 123 })),
    invalidMeasuredAt,
    "non-string",
  );
  assert.throws(
    () => validateMeasurementCreatePayload(measurementPayload({ measuredAt: "x".repeat(201) })),
    invalidMeasuredAt,
    "over the 200-char cap",
  );
});

test("validateMeasurementCreatePayload allows an empty unit (blood pressure has none) but rejects an empty value", () => {
  assert.equal(validateMeasurementCreatePayload(measurementPayload({ unit: "" })).unit, "");
  assert.throws(
    () => validateMeasurementCreatePayload(measurementPayload({ value: "" })),
    (error) => error.code === "INVALID_VALUE",
  );
  assert.throws(
    () => validateMeasurementCreatePayload(measurementPayload({ type: "not-a-type" })),
    (error) => error.code === "INVALID_TYPE",
  );
});

test("validateMeasurementUpdatePayload only allows MEASUREMENT_UPDATE_KEYS, including visibility, and reuses isParsableTimestamp for measuredAt", () => {
  assert.throws(
    () => validateMeasurementUpdatePayload({ id: "measure-1", changes: { ownerId: "other" } }, 1),
    (error) => error.code === "INVALID_CHANGES",
  );
  const { changes } = validateMeasurementUpdatePayload(
    { id: "measure-1", changes: { measuredAt: "2026-07-19T08:00", visibility: "private" } },
    1,
  );
  assert.equal(changes.measuredAt, "2026-07-19T08:00");
  assert.equal(changes.visibility, "private");
  assert.throws(
    () =>
      validateMeasurementUpdatePayload(
        { id: "measure-1", changes: { measuredAt: "not-a-timestamp" } },
        1,
      ),
    (error) => error.code === "INVALID_MEASURED_AT",
  );
});

test("assertHealthMutationShape validates the whole-request envelope", () => {
  const valid = {
    idempotencyKey: randomUUID(),
    op: "appointment.create",
    payload: { id: "appt-1" },
  };
  assert.doesNotThrow(() => assertHealthMutationShape(valid));
  assert.throws(
    () => assertHealthMutationShape({ ...valid, idempotencyKey: "not-a-uuid" }),
    (error) => error.statusCode === 400 && error.code === "INVALID_IDEMPOTENCY_KEY",
  );
  assert.throws(
    () => assertHealthMutationShape({ ...valid, op: "appointment.archive" }),
    (error) => error.statusCode === 400 && error.code === "UNSUPPORTED_OP",
  );
  assert.throws(
    () => assertHealthMutationShape({ ...valid, payload: "nope" }),
    (error) => error.statusCode === 400,
  );
  assert.equal(
    SUPPORTED_HEALTH_OPS.has("appointment.complete"),
    false,
    "toggling completion is done via appointment.update{changes:{status}}, not a dedicated op",
  );
});

test("row->DTO mappers convert snake_case/bigint-as-string/Date columns to the frontend shape", () => {
  const appointment = appointmentRowToDto({
    id: "appt-1",
    owner_id: "user-1",
    visibility: "household",
    title: "Kontrola",
    clinician: "Dr. Kowalska",
    specialty: null,
    date: "2026-07-20",
    time: "10:30",
    location: null,
    status: "scheduled",
    notes: null,
    version: 1,
    updated_at: new Date("2026-07-01T10:00:00.000Z"),
  });
  assert.equal(appointment.date, "2026-07-20");
  assert.equal(appointment.specialty, undefined);
  assert.equal(appointment.updatedAt, "2026-07-01T10:00:00.000Z");

  const medication = medicationRowToDto({
    id: "med-1",
    owner_id: "user-1",
    visibility: "household",
    name: "Ibuprom",
    dosage: "200mg",
    schedule: "1x dziennie",
    active: true,
    last_taken_on: null,
    reminder_time: "08:00",
    version: 2,
    updated_at: new Date("2026-07-01T10:00:00.000Z"),
  });
  assert.equal(medication.lastTakenOn, undefined);
  assert.equal(medication.reminderTime, "08:00");

  const measurement = measurementRowToDto({
    id: "measure-1",
    owner_id: "user-1",
    visibility: "household",
    type: "blood_pressure",
    value: "120/80",
    unit: "mmHg",
    measured_at: "2026-07-18T07:30",
    notes: null,
    version: 1,
    updated_at: new Date("2026-07-01T10:00:00.000Z"),
  });
  assert.equal(measurement.measuredAt, "2026-07-18T07:30");
  assert.equal(measurement.notes, undefined);
});

// ---------------------------------------------------------------------------
// DB-backed integration tests. `npm run test:server` in CI (.github/workflows/ci.yml) does not
// provision a Postgres instance, so these are automatically skipped there via a short connectivity
// probe rather than being deleted or mocked -- they exercise the real SQL (OCC predicates, the
// visibility scoping on conflict lookups, idempotency claims) against a real database.
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
  const email = `health-test-${randomUUID()}@example.com`;
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
    [`health-test-${randomUUID()}@example.com`, label],
  );
  const userId = user.rows[0].id;
  await client.query(
    `INSERT INTO household_members(household_id, user_id, role) VALUES ($1, $2, 'member')`,
    [householdId, userId],
  );
  return userId;
}

function dbAppointmentPayload(overrides = {}) {
  return {
    id: randomUUID(),
    title: "Kontrola",
    clinician: "Dr. Kowalska",
    date: "2026-07-20",
    time: "10:30",
    status: "scheduled",
    visibility: "household",
    ...overrides,
  };
}

function dbMedicationPayload(overrides = {}) {
  return {
    id: randomUUID(),
    name: "Ibuprom",
    dosage: "200mg",
    schedule: "1x dziennie",
    active: true,
    visibility: "household",
    ...overrides,
  };
}

function dbMeasurementPayload(overrides = {}) {
  return {
    id: randomUUID(),
    type: "blood_pressure",
    value: "120/80",
    unit: "mmHg",
    measuredAt: "2026-07-18T07:30",
    visibility: "household",
    ...overrides,
  };
}

dbTest(
  "appointment.create derives owner_id from the session, ignoring any ownerId in the payload",
  async () => {
    await withRollback(async (client) => {
      const owner = await createHouseholdAndUser(client, "owner");
      const impersonated = await addHouseholdMember(client, owner.householdId, "other");
      const ctx = { householdId: owner.householdId, userId: owner.userId };
      const result = await applyHealthMutation(client, ctx, {
        idempotencyKey: randomUUID(),
        op: "appointment.create",
        payload: dbAppointmentPayload({ ownerId: impersonated }),
      });
      assert.equal(result.status, "applied");
      assert.equal(result.record.ownerId, owner.userId);
      assert.notEqual(result.record.ownerId, impersonated);
    });
  },
);

dbTest(
  "medication.create/measurement.create also derive owner_id from the session, ignoring the payload",
  async () => {
    await withRollback(async (client) => {
      const owner = await createHouseholdAndUser(client, "owner");
      const impersonated = await addHouseholdMember(client, owner.householdId, "other");
      const ctx = { householdId: owner.householdId, userId: owner.userId };

      const medication = await applyHealthMutation(client, ctx, {
        idempotencyKey: randomUUID(),
        op: "medication.create",
        payload: dbMedicationPayload({ ownerId: impersonated }),
      });
      assert.equal(medication.record.ownerId, owner.userId);

      const measurement = await applyHealthMutation(client, ctx, {
        idempotencyKey: randomUUID(),
        op: "measurement.create",
        payload: dbMeasurementPayload({ ownerId: impersonated }),
      });
      assert.equal(measurement.record.ownerId, owner.userId);
    });
  },
);

dbTest(
  "the conflict-diagnosis query for *.update carries the same visibility scope as the write, so " +
    "a private record's existence/content is never leaked to another household member",
  async () => {
    await withRollback(async (client) => {
      const owner = await createHouseholdAndUser(client, "owner");
      const otherUserId = await addHouseholdMember(client, owner.householdId, "other");
      const appointmentId = randomUUID();
      await applyHealthMutation(
        client,
        { householdId: owner.householdId, userId: owner.userId },
        {
          idempotencyKey: randomUUID(),
          op: "appointment.create",
          payload: dbAppointmentPayload({ id: appointmentId, visibility: "private" }),
        },
      );
      // Another household member attempting to update the owner's private appointment must get a
      // plain NOT_FOUND -- not a conflict that would leak the private record's current
      // version/content.
      const attempt = await applyHealthMutation(
        client,
        { householdId: owner.householdId, userId: otherUserId },
        {
          idempotencyKey: randomUUID(),
          op: "appointment.update",
          payload: { id: appointmentId, changes: { title: "Podmienione" } },
          baseVersion: 1,
        },
      );
      assert.equal(attempt.status, "error");
      assert.equal(attempt.code, "NOT_FOUND");
      assert.equal("record" in attempt, false, "no record leaked in the error response");

      const snapshotForOther = await readHealthSnapshot(client, owner.householdId, otherUserId);
      assert.deepEqual(snapshotForOther.healthAppointments, []);
    });
  },
);

dbTest(
  "the conflict-diagnosis query for medication.update/measurement.update carries the same scope " +
    "as the write (parity with appointment.update)",
  async () => {
    await withRollback(async (client) => {
      const owner = await createHouseholdAndUser(client, "owner");
      const otherUserId = await addHouseholdMember(client, owner.householdId, "other");

      const medicationId = randomUUID();
      await applyHealthMutation(
        client,
        { householdId: owner.householdId, userId: owner.userId },
        {
          idempotencyKey: randomUUID(),
          op: "medication.create",
          payload: dbMedicationPayload({ id: medicationId, visibility: "private" }),
        },
      );
      const medicationAttempt = await applyHealthMutation(
        client,
        { householdId: owner.householdId, userId: otherUserId },
        {
          idempotencyKey: randomUUID(),
          op: "medication.update",
          payload: { id: medicationId, changes: { active: false } },
          baseVersion: 1,
        },
      );
      assert.equal(medicationAttempt.status, "error");
      assert.equal(medicationAttempt.code, "NOT_FOUND");
      assert.equal("record" in medicationAttempt, false);

      const measurementId = randomUUID();
      await applyHealthMutation(
        client,
        { householdId: owner.householdId, userId: owner.userId },
        {
          idempotencyKey: randomUUID(),
          op: "measurement.create",
          payload: dbMeasurementPayload({ id: measurementId, visibility: "private" }),
        },
      );
      const measurementAttempt = await applyHealthMutation(
        client,
        { householdId: owner.householdId, userId: otherUserId },
        {
          idempotencyKey: randomUUID(),
          op: "measurement.update",
          payload: { id: measurementId, changes: { value: "999/999" } },
          baseVersion: 1,
        },
      );
      assert.equal(measurementAttempt.status, "error");
      assert.equal(measurementAttempt.code, "NOT_FOUND");
      assert.equal("record" in measurementAttempt, false);
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
        op: "appointment.create",
        payload: dbAppointmentPayload(),
      };
      const first = await applyHealthMutation(client, ctx, mutation);
      const second = await applyHealthMutation(client, ctx, mutation);
      assert.equal(first.status, "applied");
      assert.deepEqual(second, JSON.parse(JSON.stringify(first)));
      const count = await client.query(
        "SELECT count(*)::int AS count FROM health_appointments WHERE household_id = $1",
        [householdId],
      );
      assert.equal(count.rows[0].count, 1);
    });
  },
);

dbTest(
  "retrying medication.update{changes:{lastTakenOn}} with the same idempotency key does NOT " +
    "re-apply the toggle: version increments exactly once and the stored result is returned verbatim",
  async () => {
    // This is the scenario the plan calls out explicitly: lastTakenOn is a REAL toggle computed
    // by the client (current === date ? null : date), not an idempotent "set". If a network retry
    // ever caused the server to run the update op a second time, and the *client* naively resent
    // the same toggled value, that alone wouldn't flip it back (the value is the same both times)
    // -- but idempotency is still the guarantee that a retry can NEVER be executed twice, which
    // matters the moment the op is anything other than a no-op SET (e.g. if the DB layer changes
    // later). Assert the contract directly: same key -> same stored result -> exactly one version
    // bump, exactly one row.
    await withRollback(async (client) => {
      const { householdId, userId } = await createHouseholdAndUser(client, "owner");
      const ctx = { householdId, userId };
      const medicationId = randomUUID();
      await applyHealthMutation(client, ctx, {
        idempotencyKey: randomUUID(),
        op: "medication.create",
        payload: dbMedicationPayload({ id: medicationId, lastTakenOn: null }),
      });

      const toggleMutation = {
        idempotencyKey: randomUUID(),
        op: "medication.update",
        payload: { id: medicationId, changes: { lastTakenOn: "2026-07-18" } },
        baseVersion: 1,
      };
      const first = await applyHealthMutation(client, ctx, toggleMutation);
      assert.equal(first.status, "applied");
      assert.equal(first.record.lastTakenOn, "2026-07-18");
      assert.equal(first.record.version, 2);

      const retry = await applyHealthMutation(client, ctx, toggleMutation);
      assert.deepEqual(retry, JSON.parse(JSON.stringify(first)));

      const row = await client.query(
        "SELECT version, last_taken_on::text AS last_taken_on FROM medications WHERE id = $1",
        [medicationId],
      );
      assert.equal(row.rows[0].version, 2, "version must have incremented exactly once");
      assert.equal(row.rows[0].last_taken_on, "2026-07-18");
    });
  },
);

dbTest(
  "resetHealthForUser (Settings 'Wyczyść dane aplikacji') deletes shared records and the caller's " +
    "own private records across all three tables, but never another member's private records",
  async () => {
    await withRollback(async (client) => {
      const owner = await createHouseholdAndUser(client, "owner");
      const otherUserId = await addHouseholdMember(client, owner.householdId, "other");
      const ctxOwner = { householdId: owner.householdId, userId: owner.userId };
      const ctxOther = { householdId: owner.householdId, userId: otherUserId };

      await applyHealthMutation(client, ctxOwner, {
        idempotencyKey: randomUUID(),
        op: "appointment.create",
        payload: dbAppointmentPayload({ title: "Wspólna", visibility: "household" }),
      });
      await applyHealthMutation(client, ctxOwner, {
        idempotencyKey: randomUUID(),
        op: "appointment.create",
        payload: dbAppointmentPayload({ title: "Prywatna właściciela", visibility: "private" }),
      });
      await applyHealthMutation(client, ctxOwner, {
        idempotencyKey: randomUUID(),
        op: "medication.create",
        payload: dbMedicationPayload({ name: "Prywatny lek właściciela", visibility: "private" }),
      });
      await applyHealthMutation(client, ctxOwner, {
        idempotencyKey: randomUUID(),
        op: "measurement.create",
        payload: dbMeasurementPayload({ visibility: "private" }),
      });

      await applyHealthMutation(client, ctxOther, {
        idempotencyKey: randomUUID(),
        op: "appointment.create",
        payload: dbAppointmentPayload({ title: "Prywatna innego", visibility: "private" }),
      });
      await applyHealthMutation(client, ctxOther, {
        idempotencyKey: randomUUID(),
        op: "medication.create",
        payload: dbMedicationPayload({ name: "Prywatny lek innego", visibility: "private" }),
      });
      await applyHealthMutation(client, ctxOther, {
        idempotencyKey: randomUUID(),
        op: "measurement.create",
        payload: dbMeasurementPayload({ visibility: "private" }),
      });

      await resetHealthForUser(client, owner.householdId, owner.userId);

      const snapshotForOwner = await readHealthSnapshot(client, owner.householdId, owner.userId);
      assert.deepEqual(snapshotForOwner.healthAppointments, []);
      assert.deepEqual(snapshotForOwner.medications, []);
      assert.deepEqual(snapshotForOwner.healthMeasurements, []);

      const snapshotForOther = await readHealthSnapshot(client, owner.householdId, otherUserId);
      assert.deepEqual(
        snapshotForOther.healthAppointments.map((appointment) => appointment.title),
        ["Prywatna innego"],
        "the other member's private appointment must survive the owner's reset",
      );
      assert.deepEqual(
        snapshotForOther.medications.map((medication) => medication.name),
        ["Prywatny lek innego"],
        "the other member's private medication must survive the owner's reset",
      );
      assert.equal(
        snapshotForOther.healthMeasurements.length,
        1,
        "the other member's private measurement must survive the owner's reset",
      );
    });
  },
);

dbTest(
  "visibility is editable in *.update for all three entities (regression coverage: Finance-era " +
    "bug where *.update silently dropped visibility changes)",
  async () => {
    await withRollback(async (client) => {
      const { householdId, userId } = await createHouseholdAndUser(client, "owner");
      const ctx = { householdId, userId };

      const appointmentId = randomUUID();
      await applyHealthMutation(client, ctx, {
        idempotencyKey: randomUUID(),
        op: "appointment.create",
        payload: dbAppointmentPayload({ id: appointmentId, visibility: "household" }),
      });
      const appointmentUpdate = await applyHealthMutation(client, ctx, {
        idempotencyKey: randomUUID(),
        op: "appointment.update",
        payload: { id: appointmentId, changes: { visibility: "private" } },
        baseVersion: 1,
      });
      assert.equal(appointmentUpdate.status, "applied");
      assert.equal(appointmentUpdate.record.visibility, "private");

      const medicationId = randomUUID();
      await applyHealthMutation(client, ctx, {
        idempotencyKey: randomUUID(),
        op: "medication.create",
        payload: dbMedicationPayload({ id: medicationId, visibility: "household" }),
      });
      const medicationUpdate = await applyHealthMutation(client, ctx, {
        idempotencyKey: randomUUID(),
        op: "medication.update",
        payload: { id: medicationId, changes: { visibility: "private" } },
        baseVersion: 1,
      });
      assert.equal(medicationUpdate.status, "applied");
      assert.equal(medicationUpdate.record.visibility, "private");

      const measurementId = randomUUID();
      await applyHealthMutation(client, ctx, {
        idempotencyKey: randomUUID(),
        op: "measurement.create",
        payload: dbMeasurementPayload({ id: measurementId, visibility: "household" }),
      });
      const measurementUpdate = await applyHealthMutation(client, ctx, {
        idempotencyKey: randomUUID(),
        op: "measurement.update",
        payload: { id: measurementId, changes: { visibility: "private" } },
        baseVersion: 1,
      });
      assert.equal(measurementUpdate.status, "applied");
      assert.equal(measurementUpdate.record.visibility, "private");
    });
  },
);

dbTest(
  "deletion is idempotent across all three entities: a second delete of an already-deleted record " +
    "is 'applied', not an error",
  async () => {
    await withRollback(async (client) => {
      const { householdId, userId } = await createHouseholdAndUser(client, "owner");
      const ctx = { householdId, userId };

      const appointmentId = randomUUID();
      await applyHealthMutation(client, ctx, {
        idempotencyKey: randomUUID(),
        op: "appointment.create",
        payload: dbAppointmentPayload({ id: appointmentId }),
      });
      const firstDelete = await applyHealthMutation(client, ctx, {
        idempotencyKey: randomUUID(),
        op: "appointment.delete",
        payload: { id: appointmentId },
      });
      assert.equal(firstDelete.status, "applied");
      const secondDelete = await applyHealthMutation(client, ctx, {
        idempotencyKey: randomUUID(),
        op: "appointment.delete",
        payload: { id: appointmentId },
      });
      assert.equal(secondDelete.status, "applied");
      assert.equal(secondDelete.record, null);

      const medicationId = randomUUID();
      await applyHealthMutation(client, ctx, {
        idempotencyKey: randomUUID(),
        op: "medication.create",
        payload: dbMedicationPayload({ id: medicationId }),
      });
      await applyHealthMutation(client, ctx, {
        idempotencyKey: randomUUID(),
        op: "medication.delete",
        payload: { id: medicationId },
      });
      const secondMedicationDelete = await applyHealthMutation(client, ctx, {
        idempotencyKey: randomUUID(),
        op: "medication.delete",
        payload: { id: medicationId },
      });
      assert.equal(secondMedicationDelete.status, "applied");

      const measurementId = randomUUID();
      await applyHealthMutation(client, ctx, {
        idempotencyKey: randomUUID(),
        op: "measurement.create",
        payload: dbMeasurementPayload({ id: measurementId }),
      });
      await applyHealthMutation(client, ctx, {
        idempotencyKey: randomUUID(),
        op: "measurement.delete",
        payload: { id: measurementId },
      });
      const secondMeasurementDelete = await applyHealthMutation(client, ctx, {
        idempotencyKey: randomUUID(),
        op: "measurement.delete",
        payload: { id: measurementId },
      });
      assert.equal(secondMeasurementDelete.status, "applied");

      // Deleting an id that never existed at all is likewise 'applied', not an error.
      const neverExisted = await applyHealthMutation(client, ctx, {
        idempotencyKey: randomUUID(),
        op: "appointment.delete",
        payload: { id: randomUUID() },
      });
      assert.equal(neverExisted.status, "applied");
      assert.equal(neverExisted.record, null);
    });
  },
);
