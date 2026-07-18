import assert from "node:assert/strict";
import test, { after } from "node:test";
import { randomUUID } from "node:crypto";
import pg from "pg";
import {
  SubscriptionValidationError,
  SUPPORTED_SUBSCRIPTION_OPS,
  applySubscriptionMutation,
  assertSubscriptionMutationShape,
  readSubscriptionsSnapshot,
  resetSubscriptionsForUser,
  resolveOwnerId,
  resolveVersionConflict,
  subscriptionRowToDto,
  validateDeleteIdPayload,
  validateSubscriptionCreatePayload,
  validateSubscriptionUpdatePayload,
} from "../src/subscriptions.mjs";

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

function subscriptionPayload(overrides = {}) {
  return {
    id: "sub-1",
    name: "Netflix",
    category: "Rozrywka",
    amountMinor: 4390,
    currency: "PLN",
    cycle: "monthly",
    nextPayment: "2026-08-01",
    payer: "Karta",
    status: "active",
    reminderDays: 3,
    color: "#397763",
    cancelUrl: "https://netflix.com/cancel",
    visibility: "household",
    ...overrides,
  };
}

test("validateSubscriptionCreatePayload accepts a well-shaped payload and never reads/forwards ownerId", () => {
  const data = validateSubscriptionCreatePayload(subscriptionPayload({ ownerId: "someone-else" }));
  assert.equal(data.name, "Netflix");
  assert.equal(data.visibility, "household");
  assert.equal(data.cancelUrl, "https://netflix.com/cancel");
  assert.equal("ownerId" in data, false, "the validator does not read or forward ownerId");
});

test("validateSubscriptionCreatePayload trims name/category and normalizes an absent/blank cancelUrl to null", () => {
  const data = validateSubscriptionCreatePayload(
    subscriptionPayload({ name: "  Spotify  ", category: " Muzyka ", cancelUrl: undefined }),
  );
  assert.equal(data.name, "Spotify");
  assert.equal(data.category, "Muzyka");
  assert.equal(data.cancelUrl, null);
});

test("validateSubscriptionCreatePayload rejects an invalid id/name/category", () => {
  assert.throws(() => validateSubscriptionCreatePayload({}), SubscriptionValidationError);
  assert.throws(
    () => validateSubscriptionCreatePayload(subscriptionPayload({ id: "" })),
    (error) => error.code === "INVALID_ID",
  );
  assert.throws(
    () => validateSubscriptionCreatePayload(subscriptionPayload({ name: "" })),
    (error) => error.code === "INVALID_NAME",
  );
  assert.throws(
    () => validateSubscriptionCreatePayload(subscriptionPayload({ category: "" })),
    (error) => error.code === "INVALID_CATEGORY",
  );
});

test("validateSubscriptionCreatePayload rejects an invalid amountMinor (isSafeMoney/nonnegative)", () => {
  const invalidAmount = (error) => error.code === "INVALID_AMOUNT";
  assert.throws(
    () => validateSubscriptionCreatePayload(subscriptionPayload({ amountMinor: -1 })),
    invalidAmount,
    "negative",
  );
  assert.throws(
    () => validateSubscriptionCreatePayload(subscriptionPayload({ amountMinor: 1.5 })),
    invalidAmount,
    "non-integer",
  );
  assert.throws(
    () => validateSubscriptionCreatePayload(subscriptionPayload({ amountMinor: "4390" })),
    invalidAmount,
    "non-number",
  );
  assert.throws(
    () =>
      validateSubscriptionCreatePayload(
        subscriptionPayload({ amountMinor: Number.MAX_SAFE_INTEGER + 1 }),
      ),
    invalidAmount,
    "unsafe integer",
  );
  assert.doesNotThrow(() =>
    validateSubscriptionCreatePayload(subscriptionPayload({ amountMinor: 0 })),
  );
});

test("validateSubscriptionCreatePayload's currency validator (CURRENCIES.has) accepts exactly PLN/EUR/USD/GBP", () => {
  const invalidCurrency = (error) => error.code === "INVALID_CURRENCY";
  for (const currency of ["PLN", "EUR", "USD", "GBP"]) {
    assert.doesNotThrow(() => validateSubscriptionCreatePayload(subscriptionPayload({ currency })));
  }
  assert.throws(
    () => validateSubscriptionCreatePayload(subscriptionPayload({ currency: "CHF" })),
    invalidCurrency,
  );
  assert.throws(
    () => validateSubscriptionCreatePayload(subscriptionPayload({ currency: "pln" })),
    invalidCurrency,
    "case-sensitive",
  );
});

test("validateSubscriptionCreatePayload's cycle validator (CYCLES.has) accepts exactly monthly/quarterly/yearly", () => {
  const invalidCycle = (error) => error.code === "INVALID_CYCLE";
  for (const cycle of ["monthly", "quarterly", "yearly"]) {
    assert.doesNotThrow(() => validateSubscriptionCreatePayload(subscriptionPayload({ cycle })));
  }
  assert.throws(
    () => validateSubscriptionCreatePayload(subscriptionPayload({ cycle: "weekly" })),
    invalidCycle,
  );
});

test("validateSubscriptionCreatePayload's status validator (STATUSES.has) accepts exactly active/trial/paused/cancelled", () => {
  const invalidStatus = (error) => error.code === "INVALID_STATUS";
  for (const status of ["active", "trial", "paused", "cancelled"]) {
    assert.doesNotThrow(() => validateSubscriptionCreatePayload(subscriptionPayload({ status })));
  }
  assert.throws(
    () => validateSubscriptionCreatePayload(subscriptionPayload({ status: "expired" })),
    invalidStatus,
  );
});

test("validateSubscriptionCreatePayload rejects an invalid nextPayment (isIsoDate)", () => {
  assert.throws(
    () => validateSubscriptionCreatePayload(subscriptionPayload({ nextPayment: "not-a-date" })),
    (error) => error.code === "INVALID_NEXT_PAYMENT",
  );
  assert.throws(
    () => validateSubscriptionCreatePayload(subscriptionPayload({ nextPayment: "2026-02-30" })),
    (error) => error.code === "INVALID_NEXT_PAYMENT",
    "calendar-invalid date (Feb 30) must be rejected, not silently rolled over",
  );
});

test("validateSubscriptionCreatePayload's reminderDays validator (isReminderDays) accepts 0-365 integers only", () => {
  const invalidReminderDays = (error) => error.code === "INVALID_REMINDER_DAYS";
  assert.doesNotThrow(() =>
    validateSubscriptionCreatePayload(subscriptionPayload({ reminderDays: 0 })),
  );
  assert.doesNotThrow(() =>
    validateSubscriptionCreatePayload(subscriptionPayload({ reminderDays: 365 })),
  );
  assert.throws(
    () => validateSubscriptionCreatePayload(subscriptionPayload({ reminderDays: -1 })),
    invalidReminderDays,
    "negative",
  );
  assert.throws(
    () => validateSubscriptionCreatePayload(subscriptionPayload({ reminderDays: 366 })),
    invalidReminderDays,
    "over the cap",
  );
  assert.throws(
    () => validateSubscriptionCreatePayload(subscriptionPayload({ reminderDays: 1.5 })),
    invalidReminderDays,
    "non-integer",
  );
  assert.throws(
    () => validateSubscriptionCreatePayload(subscriptionPayload({ reminderDays: "3" })),
    invalidReminderDays,
    "non-number",
  );
});

test("validateSubscriptionCreatePayload's cancelUrl validator (isCancelUrl) requires an http(s) URL when present, but is optional", () => {
  const invalidCancelUrl = (error) => error.code === "INVALID_CANCEL_URL";
  assert.doesNotThrow(() =>
    validateSubscriptionCreatePayload(subscriptionPayload({ cancelUrl: undefined })),
  );
  assert.doesNotThrow(() =>
    validateSubscriptionCreatePayload(subscriptionPayload({ cancelUrl: null })),
  );
  assert.doesNotThrow(() =>
    validateSubscriptionCreatePayload(
      subscriptionPayload({ cancelUrl: "http://example.com/cancel" }),
    ),
  );
  assert.throws(
    () =>
      validateSubscriptionCreatePayload(subscriptionPayload({ cancelUrl: "javascript:alert(1)" })),
    invalidCancelUrl,
    "non-http(s) protocol must be rejected",
  );
  assert.throws(
    () => validateSubscriptionCreatePayload(subscriptionPayload({ cancelUrl: "not a url" })),
    invalidCancelUrl,
    "unparsable string",
  );
  assert.throws(
    () =>
      validateSubscriptionCreatePayload(
        subscriptionPayload({ cancelUrl: "https://" + "x".repeat(2000) }),
      ),
    invalidCancelUrl,
    "over the 2000-char cap",
  );
});

test("validateSubscriptionCreatePayload requires a valid visibility (household/private only)", () => {
  assert.throws(
    () => validateSubscriptionCreatePayload(subscriptionPayload({ visibility: "public" })),
    (error) => error.code === "INVALID_VISIBILITY",
  );
  assert.throws(
    () => validateSubscriptionCreatePayload(subscriptionPayload({ visibility: undefined })),
    (error) => error.code === "INVALID_VISIBILITY",
  );
});

test("validateSubscriptionUpdatePayload only allows SUBSCRIPTION_UPDATE_KEYS, including visibility", () => {
  assert.throws(
    () => validateSubscriptionUpdatePayload({ id: "sub-1", changes: { ownerId: "other" } }, 1),
    (error) => error.code === "INVALID_CHANGES",
  );
  // `visibility` IS editable -- explicit regression coverage for the Finance-era bug where
  // `*.update` silently dropped visibility changes (docs/plans/subskrypcje-sql.md "Ryzyka").
  const { changes, baseVersion } = validateSubscriptionUpdatePayload(
    { id: "sub-1", changes: { name: " Nowa nazwa ", visibility: "private" } },
    2,
  );
  assert.equal(changes.name, "Nowa nazwa");
  assert.equal(changes.visibility, "private");
  assert.equal(baseVersion, 2);
});

test("validateSubscriptionUpdatePayload requires a positive integer baseVersion (baseVersion is REQUIRED for updates, unlike delete)", () => {
  assert.throws(
    () => validateSubscriptionUpdatePayload({ id: "sub-1", changes: { name: "X" } }, undefined),
    (error) => error.code === "INVALID_BASE_VERSION",
  );
  assert.throws(
    () => validateSubscriptionUpdatePayload({ id: "sub-1", changes: { name: "X" } }, 0),
    (error) => error.code === "INVALID_BASE_VERSION",
  );
  assert.throws(
    () => validateSubscriptionUpdatePayload({ id: "sub-1", changes: { name: "X" } }, 1.5),
    (error) => error.code === "INVALID_BASE_VERSION",
  );
});

test("validateSubscriptionUpdatePayload re-validates every changed field with the same rules as create", () => {
  assert.throws(
    () => validateSubscriptionUpdatePayload({ id: "sub-1", changes: { currency: "CHF" } }, 1),
    (error) => error.code === "INVALID_CURRENCY",
  );
  assert.throws(
    () => validateSubscriptionUpdatePayload({ id: "sub-1", changes: { cycle: "weekly" } }, 1),
    (error) => error.code === "INVALID_CYCLE",
  );
  assert.throws(
    () => validateSubscriptionUpdatePayload({ id: "sub-1", changes: { status: "expired" } }, 1),
    (error) => error.code === "INVALID_STATUS",
  );
  assert.throws(
    () => validateSubscriptionUpdatePayload({ id: "sub-1", changes: { reminderDays: 400 } }, 1),
    (error) => error.code === "INVALID_REMINDER_DAYS",
  );
  assert.throws(
    () => validateSubscriptionUpdatePayload({ id: "sub-1", changes: { amountMinor: -5 } }, 1),
    (error) => error.code === "INVALID_AMOUNT",
  );
});

test("validateSubscriptionUpdatePayload treats cancelUrl with the hasOwnProperty nullable-clears-column pattern (parity with species/notes in pets.mjs/health.mjs)", () => {
  // Explicit null clears the column.
  const cleared = validateSubscriptionUpdatePayload(
    { id: "sub-1", changes: { cancelUrl: null } },
    1,
  );
  assert.equal(cleared.changes.cancelUrl, null);

  // A valid URL sets it.
  const set = validateSubscriptionUpdatePayload(
    { id: "sub-1", changes: { cancelUrl: "https://example.com/cancel" } },
    1,
  );
  assert.equal(set.changes.cancelUrl, "https://example.com/cancel");

  // Omitted entirely -- not part of `changes` at all (distinct from explicit null); the SQL layer
  // relies on this via the `hasCancelUrl` CASE WHEN.
  const omitted = validateSubscriptionUpdatePayload({ id: "sub-1", changes: { name: "X" } }, 1);
  assert.equal("cancelUrl" in omitted.changes, false);

  assert.throws(
    () =>
      validateSubscriptionUpdatePayload({ id: "sub-1", changes: { cancelUrl: "not-a-url" } }, 1),
    (error) => error.code === "INVALID_CANCEL_URL",
  );
});

test("validateSubscriptionUpdatePayload's exact shapes for renew/togglePause (SubscriptionsPage.tsx): absolute updateSubscription calls, not dedicated toggles", () => {
  // renew(): advances nextPayment and (if the subscription was cancelled) reactivates it -- both
  // computed absolutely on the client, sent as a plain `subscription.update`.
  const renewed = validateSubscriptionUpdatePayload(
    { id: "sub-1", changes: { nextPayment: "2026-09-01", status: "active" } },
    4,
  );
  assert.deepEqual(renewed.changes, { nextPayment: "2026-09-01", status: "active" });

  // togglePause(): flips active <-> paused, computed absolutely on the client.
  const paused = validateSubscriptionUpdatePayload(
    { id: "sub-1", changes: { status: "paused" } },
    5,
  );
  assert.deepEqual(paused.changes, { status: "paused" });
});

test("validateDeleteIdPayload requires a valid id", () => {
  assert.throws(
    () => validateDeleteIdPayload({}),
    (error) => error.code === "INVALID_ID",
  );
  assert.deepEqual(validateDeleteIdPayload({ id: "sub-1" }), { id: "sub-1" });
});

test("assertSubscriptionMutationShape validates the whole-request envelope", () => {
  const valid = {
    idempotencyKey: randomUUID(),
    op: "subscription.create",
    payload: { id: "sub-1" },
  };
  assert.doesNotThrow(() => assertSubscriptionMutationShape(valid));
  assert.throws(
    () => assertSubscriptionMutationShape({ ...valid, idempotencyKey: "not-a-uuid" }),
    (error) => error.statusCode === 400 && error.code === "INVALID_IDEMPOTENCY_KEY",
  );
  assert.throws(
    () => assertSubscriptionMutationShape({ ...valid, op: "subscription.renew" }),
    (error) => error.statusCode === 400 && error.code === "UNSUPPORTED_OP",
  );
  assert.throws(
    () => assertSubscriptionMutationShape({ ...valid, payload: "nope" }),
    (error) => error.statusCode === 400,
  );
  assert.throws(
    () => assertSubscriptionMutationShape({ ...valid, baseVersion: "1" }),
    (error) => error.statusCode === 400,
  );
  assert.equal(
    SUPPORTED_SUBSCRIPTION_OPS.has("subscription.renew"),
    false,
    "renew/togglePause are plain subscription.update calls with client-computed absolute values, not dedicated ops",
  );
  assert.equal(SUPPORTED_SUBSCRIPTION_OPS.has("subscription.togglePause"), false);
  assert.deepEqual([...SUPPORTED_SUBSCRIPTION_OPS].sort(), [
    "subscription.create",
    "subscription.delete",
    "subscription.update",
  ]);
});

test("subscriptionRowToDto converts snake_case/bigint-as-string/Date columns to the frontend shape", () => {
  const dto = subscriptionRowToDto({
    id: "sub-1",
    owner_id: "user-1",
    visibility: "household",
    name: "Netflix",
    category: "Rozrywka",
    amount_minor: "4390",
    currency: "PLN",
    cycle: "monthly",
    next_payment: "2026-08-01",
    payer: "Karta",
    status: "active",
    reminder_days: 3,
    color: "#397763",
    cancel_url: null,
    version: 1,
    updated_at: new Date("2026-07-01T10:00:00.000Z"),
  });
  assert.equal(dto.amountMinor, 4390);
  assert.equal(typeof dto.amountMinor, "number");
  assert.equal(dto.nextPayment, "2026-08-01");
  assert.equal(dto.cancelUrl, undefined, "null cancel_url is surfaced as undefined, not null");
  assert.equal(dto.updatedAt, "2026-07-01T10:00:00.000Z");
  assert.equal(dto.ownerId, "user-1");

  const withCancelUrl = subscriptionRowToDto({
    id: "sub-2",
    owner_id: "user-1",
    visibility: "private",
    name: "Spotify",
    category: "Muzyka",
    amount_minor: "1990",
    currency: "PLN",
    cycle: "monthly",
    next_payment: "2026-08-05",
    payer: "",
    status: "trial",
    reminder_days: 0,
    color: "#1db954",
    cancel_url: "https://spotify.com/cancel",
    version: 3,
    updated_at: new Date("2026-07-02T10:00:00.000Z"),
  });
  assert.equal(withCancelUrl.cancelUrl, "https://spotify.com/cancel");
  assert.equal(withCancelUrl.visibility, "private");
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
  const email = `subscriptions-test-${randomUUID()}@example.com`;
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
    [`subscriptions-test-${randomUUID()}@example.com`, label],
  );
  const userId = user.rows[0].id;
  await client.query(
    `INSERT INTO household_members(household_id, user_id, role) VALUES ($1, $2, 'member')`,
    [householdId, userId],
  );
  return userId;
}

function dbSubscriptionPayload(overrides = {}) {
  return {
    id: randomUUID(),
    name: "Netflix",
    category: "Rozrywka",
    amountMinor: 4390,
    currency: "PLN",
    cycle: "monthly",
    nextPayment: "2026-08-01",
    payer: "Karta",
    status: "active",
    reminderDays: 3,
    color: "#397763",
    visibility: "household",
    ...overrides,
  };
}

dbTest(
  "subscription.create derives owner_id from the session, ignoring any ownerId in the payload",
  async () => {
    await withRollback(async (client) => {
      const owner = await createHouseholdAndUser(client, "owner");
      const impersonated = await addHouseholdMember(client, owner.householdId, "other");
      const ctx = { householdId: owner.householdId, userId: owner.userId };
      const result = await applySubscriptionMutation(client, ctx, {
        idempotencyKey: randomUUID(),
        op: "subscription.create",
        payload: dbSubscriptionPayload({ ownerId: impersonated }),
      });
      assert.equal(result.status, "applied");
      assert.equal(result.record.ownerId, owner.userId);
      assert.notEqual(result.record.ownerId, impersonated);
    });
  },
);

dbTest(
  "the conflict-diagnosis query for subscription.update carries the same visibility scope as the " +
    "write, so a private record's existence/content is never leaked to another household member",
  async () => {
    await withRollback(async (client) => {
      const owner = await createHouseholdAndUser(client, "owner");
      const otherUserId = await addHouseholdMember(client, owner.householdId, "other");
      const subscriptionId = randomUUID();
      await applySubscriptionMutation(
        client,
        { householdId: owner.householdId, userId: owner.userId },
        {
          idempotencyKey: randomUUID(),
          op: "subscription.create",
          payload: dbSubscriptionPayload({ id: subscriptionId, visibility: "private" }),
        },
      );
      // Another household member attempting to update the owner's private subscription must get a
      // plain NOT_FOUND -- not a conflict that would leak the private record's current
      // version/content.
      const attempt = await applySubscriptionMutation(
        client,
        { householdId: owner.householdId, userId: otherUserId },
        {
          idempotencyKey: randomUUID(),
          op: "subscription.update",
          payload: { id: subscriptionId, changes: { name: "Podmienione" } },
          baseVersion: 1,
        },
      );
      assert.equal(attempt.status, "error");
      assert.equal(attempt.code, "NOT_FOUND");
      assert.equal("record" in attempt, false, "no record leaked in the error response");

      const snapshotForOther = await readSubscriptionsSnapshot(
        client,
        owner.householdId,
        otherUserId,
      );
      assert.deepEqual(snapshotForOther.subscriptions, []);
    });
  },
);

dbTest(
  "the conflict-diagnosis query for subscription.delete carries the same visibility scope as the " +
    "write (delete is idempotent, but a private record's existence must not leak through a conflict either)",
  async () => {
    await withRollback(async (client) => {
      const owner = await createHouseholdAndUser(client, "owner");
      const otherUserId = await addHouseholdMember(client, owner.householdId, "other");
      const subscriptionId = randomUUID();
      await applySubscriptionMutation(
        client,
        { householdId: owner.householdId, userId: owner.userId },
        {
          idempotencyKey: randomUUID(),
          op: "subscription.create",
          payload: dbSubscriptionPayload({ id: subscriptionId, visibility: "private" }),
        },
      );
      const attempt = await applySubscriptionMutation(
        client,
        { householdId: owner.householdId, userId: otherUserId },
        {
          idempotencyKey: randomUUID(),
          op: "subscription.delete",
          payload: { id: subscriptionId },
          baseVersion: 1,
        },
      );
      // The row still exists (belongs to someone else, outside this caller's scope), so this is
      // "applied" (not found within scope, same as a genuinely absent id) -- it must NOT report a
      // conflict carrying the private record.
      assert.equal(attempt.status, "applied");
      assert.equal(attempt.record, null);

      const snapshotForOwner = await readSubscriptionsSnapshot(
        client,
        owner.householdId,
        owner.userId,
      );
      assert.equal(
        snapshotForOwner.subscriptions.length,
        1,
        "the owner's private subscription must survive another member's delete attempt",
      );
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
        op: "subscription.create",
        payload: dbSubscriptionPayload(),
      };
      const first = await applySubscriptionMutation(client, ctx, mutation);
      const second = await applySubscriptionMutation(client, ctx, mutation);
      assert.equal(first.status, "applied");
      assert.deepEqual(second, JSON.parse(JSON.stringify(first)));
      const count = await client.query(
        "SELECT count(*)::int AS count FROM subscriptions WHERE household_id = $1",
        [householdId],
      );
      assert.equal(count.rows[0].count, 1);
    });
  },
);

dbTest(
  "retrying subscription.update{changes:{status}} (togglePause's exact shape) with the same " +
    "idempotency key does NOT re-apply the update: version increments exactly once",
  async () => {
    await withRollback(async (client) => {
      const { householdId, userId } = await createHouseholdAndUser(client, "owner");
      const ctx = { householdId, userId };
      const subscriptionId = randomUUID();
      await applySubscriptionMutation(client, ctx, {
        idempotencyKey: randomUUID(),
        op: "subscription.create",
        payload: dbSubscriptionPayload({ id: subscriptionId, status: "active" }),
      });

      const pauseMutation = {
        idempotencyKey: randomUUID(),
        op: "subscription.update",
        payload: { id: subscriptionId, changes: { status: "paused" } },
        baseVersion: 1,
      };
      const first = await applySubscriptionMutation(client, ctx, pauseMutation);
      assert.equal(first.status, "applied");
      assert.equal(first.record.status, "paused");
      assert.equal(first.record.version, 2);

      const retry = await applySubscriptionMutation(client, ctx, pauseMutation);
      assert.deepEqual(retry, JSON.parse(JSON.stringify(first)));

      const row = await client.query("SELECT version, status FROM subscriptions WHERE id = $1", [
        subscriptionId,
      ]);
      assert.equal(row.rows[0].version, 2, "version must have incremented exactly once");
      assert.equal(row.rows[0].status, "paused");
    });
  },
);

dbTest(
  "resetSubscriptionsForUser (Settings 'Wyczyść dane aplikacji') deletes shared records and the " +
    "caller's own private records, but never another member's private records",
  async () => {
    await withRollback(async (client) => {
      const owner = await createHouseholdAndUser(client, "owner");
      const otherUserId = await addHouseholdMember(client, owner.householdId, "other");
      const ctxOwner = { householdId: owner.householdId, userId: owner.userId };
      const ctxOther = { householdId: owner.householdId, userId: otherUserId };

      await applySubscriptionMutation(client, ctxOwner, {
        idempotencyKey: randomUUID(),
        op: "subscription.create",
        payload: dbSubscriptionPayload({ name: "Wspólna", visibility: "household" }),
      });
      await applySubscriptionMutation(client, ctxOwner, {
        idempotencyKey: randomUUID(),
        op: "subscription.create",
        payload: dbSubscriptionPayload({ name: "Prywatna właściciela", visibility: "private" }),
      });
      await applySubscriptionMutation(client, ctxOther, {
        idempotencyKey: randomUUID(),
        op: "subscription.create",
        payload: dbSubscriptionPayload({ name: "Prywatna innego", visibility: "private" }),
      });

      await resetSubscriptionsForUser(client, owner.householdId, owner.userId);

      const snapshotForOwner = await readSubscriptionsSnapshot(
        client,
        owner.householdId,
        owner.userId,
      );
      assert.deepEqual(snapshotForOwner.subscriptions, []);

      const snapshotForOther = await readSubscriptionsSnapshot(
        client,
        owner.householdId,
        otherUserId,
      );
      assert.deepEqual(
        snapshotForOther.subscriptions.map((subscription) => subscription.name),
        ["Prywatna innego"],
        "the other member's private subscription must survive the owner's reset",
      );
    });
  },
);

dbTest(
  "visibility is editable via subscription.update (regression coverage: Finance-era bug where " +
    "*.update silently dropped visibility changes)",
  async () => {
    await withRollback(async (client) => {
      const { householdId, userId } = await createHouseholdAndUser(client, "owner");
      const ctx = { householdId, userId };
      const subscriptionId = randomUUID();
      await applySubscriptionMutation(client, ctx, {
        idempotencyKey: randomUUID(),
        op: "subscription.create",
        payload: dbSubscriptionPayload({ id: subscriptionId, visibility: "household" }),
      });
      const update = await applySubscriptionMutation(client, ctx, {
        idempotencyKey: randomUUID(),
        op: "subscription.update",
        payload: { id: subscriptionId, changes: { visibility: "private" } },
        baseVersion: 1,
      });
      assert.equal(update.status, "applied");
      assert.equal(update.record.visibility, "private");
    });
  },
);

dbTest(
  "a concurrent update against a stale baseVersion reports a per-record conflict with the fresh " +
    "record and currentVersion, without touching unrelated records in the same batch",
  async () => {
    await withRollback(async (client) => {
      const { householdId, userId } = await createHouseholdAndUser(client, "owner");
      const ctx = { householdId, userId };
      const subscriptionId = randomUUID();
      await applySubscriptionMutation(client, ctx, {
        idempotencyKey: randomUUID(),
        op: "subscription.create",
        payload: dbSubscriptionPayload({ id: subscriptionId }),
      });
      // "device A" applies an update, bumping the version to 2.
      await applySubscriptionMutation(client, ctx, {
        idempotencyKey: randomUUID(),
        op: "subscription.update",
        payload: { id: subscriptionId, changes: { payer: "Konto wspólne" } },
        baseVersion: 1,
      });
      // "device B" still thinks the version is 1.
      const conflict = await applySubscriptionMutation(client, ctx, {
        idempotencyKey: randomUUID(),
        op: "subscription.update",
        payload: { id: subscriptionId, changes: { name: "Podmienione" } },
        baseVersion: 1,
      });
      assert.equal(conflict.status, "conflict");
      assert.equal(conflict.currentVersion, 2);
      assert.equal(conflict.record.payer, "Konto wspólne");
      assert.equal(conflict.record.name, "Netflix", "the stale write must not have applied");
    });
  },
);

dbTest(
  "deletion is idempotent: a second delete of an already-deleted (or never-existing) record is " +
    "'applied', not an error",
  async () => {
    await withRollback(async (client) => {
      const { householdId, userId } = await createHouseholdAndUser(client, "owner");
      const ctx = { householdId, userId };
      const subscriptionId = randomUUID();
      await applySubscriptionMutation(client, ctx, {
        idempotencyKey: randomUUID(),
        op: "subscription.create",
        payload: dbSubscriptionPayload({ id: subscriptionId }),
      });
      const firstDelete = await applySubscriptionMutation(client, ctx, {
        idempotencyKey: randomUUID(),
        op: "subscription.delete",
        payload: { id: subscriptionId },
      });
      assert.equal(firstDelete.status, "applied");
      const secondDelete = await applySubscriptionMutation(client, ctx, {
        idempotencyKey: randomUUID(),
        op: "subscription.delete",
        payload: { id: subscriptionId },
      });
      assert.equal(secondDelete.status, "applied");
      assert.equal(secondDelete.record, null);

      const neverExisted = await applySubscriptionMutation(client, ctx, {
        idempotencyKey: randomUUID(),
        op: "subscription.delete",
        payload: { id: randomUUID() },
      });
      assert.equal(neverExisted.status, "applied");
      assert.equal(neverExisted.record, null);
    });
  },
);

dbTest(
  "readSubscriptionsSnapshot returns household-wide records plus the caller's own private records, " +
    "sorted by next_payment, but never another member's private records",
  async () => {
    await withRollback(async (client) => {
      const owner = await createHouseholdAndUser(client, "owner");
      const otherUserId = await addHouseholdMember(client, owner.householdId, "other");
      const ctxOwner = { householdId: owner.householdId, userId: owner.userId };
      const ctxOther = { householdId: owner.householdId, userId: otherUserId };

      await applySubscriptionMutation(client, ctxOwner, {
        idempotencyKey: randomUUID(),
        op: "subscription.create",
        payload: dbSubscriptionPayload({
          name: "Spotify",
          nextPayment: "2026-08-10",
          visibility: "household",
        }),
      });
      await applySubscriptionMutation(client, ctxOwner, {
        idempotencyKey: randomUUID(),
        op: "subscription.create",
        payload: dbSubscriptionPayload({
          name: "Netflix (prywatny)",
          nextPayment: "2026-08-01",
          visibility: "private",
        }),
      });
      await applySubscriptionMutation(client, ctxOther, {
        idempotencyKey: randomUUID(),
        op: "subscription.create",
        payload: dbSubscriptionPayload({
          name: "Prywatna innego",
          nextPayment: "2026-08-05",
          visibility: "private",
        }),
      });

      const snapshotForOwner = await readSubscriptionsSnapshot(
        client,
        owner.householdId,
        owner.userId,
      );
      assert.deepEqual(
        snapshotForOwner.subscriptions.map((subscription) => subscription.name),
        ["Netflix (prywatny)", "Spotify"],
        "sorted by next_payment ascending; the other member's private record is excluded",
      );
    });
  },
);
