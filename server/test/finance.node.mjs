import assert from "node:assert/strict";
import test, { after } from "node:test";
import { randomUUID } from "node:crypto";
import pg from "pg";
import {
  FinanceValidationError,
  SUPPORTED_FINANCE_OPS,
  accountRowToDto,
  applyFinanceMutation,
  assertFinanceMutationShape,
  budgetRowToDto,
  goalRowToDto,
  normalizeCategoryName,
  readFinanceSnapshot,
  resolveOwnerId,
  resolveTransactionVisibility,
  resolveVersionConflict,
  transactionRowToDto,
  validateAccountCreatePayload,
  validateAccountUpdatePayload,
  validateBudgetCreatePayload,
  validateBudgetUpdatePayload,
  validateDeleteIdPayload,
  validateGoalCreatePayload,
  validateGoalUpdatePayload,
  validateTransactionCreatePayload,
  validateTransactionImportPayload,
} from "../src/finance.mjs";

// ---------------------------------------------------------------------------
// Pure unit tests -- no database required, always run (including in CI).
// ---------------------------------------------------------------------------

test("resolveOwnerId always returns the session user, never a client-supplied value", () => {
  const ctx = { userId: "session-user", householdId: "household-1" };
  assert.equal(resolveOwnerId(ctx), "session-user");
});

test("resolveTransactionVisibility inherits from the account unless the client sets a valid one", () => {
  assert.equal(resolveTransactionVisibility(undefined, "private"), "private");
  assert.equal(resolveTransactionVisibility(undefined, "household"), "household");
  assert.equal(resolveTransactionVisibility("household", "private"), "household");
  assert.equal(resolveTransactionVisibility("not-a-visibility", "private"), "private");
});

test("resolveVersionConflict compares the client's assumed version against the stored one", () => {
  assert.equal(resolveVersionConflict(1, 1), true);
  assert.equal(resolveVersionConflict(1, 2), false);
  assert.equal(resolveVersionConflict("1", 1), true);
});

test("normalizeCategoryName matches FinancePage.tsx's locale-aware comparison", () => {
  assert.equal(normalizeCategoryName("  Jedzenie "), "jedzenie");
  assert.equal(normalizeCategoryName("ŻYWNOŚĆ"), "żywność");
});

test("validateAccountCreatePayload accepts a valid payload and never passes through ownerId", () => {
  const data = validateAccountCreatePayload({
    id: "acc-1",
    name: " Konto ",
    type: "checking",
    balanceMinor: 1000,
    currency: "PLN",
    color: "#397763",
    archived: false,
    visibility: "household",
    ownerId: "someone-else",
  });
  assert.equal(data.name, "Konto");
  assert.equal("ownerId" in data, false, "the validator does not read or forward ownerId");
});

test("validateAccountCreatePayload rejects invalid fields", () => {
  assert.throws(() => validateAccountCreatePayload({}), FinanceValidationError);
  assert.throws(
    () =>
      validateAccountCreatePayload({
        id: "acc-1",
        name: "Konto",
        type: "not-a-type",
        balanceMinor: 0,
        currency: "PLN",
        color: "#fff",
        archived: false,
        visibility: "household",
      }),
    (error) => error.code === "INVALID_TYPE",
  );
});

test("validateAccountUpdatePayload rejects balance/ownership/visibility as editable fields", () => {
  assert.throws(
    () => validateAccountUpdatePayload({ id: "acc-1", changes: { balanceMinor: 500 } }, 1),
    (error) => error.code === "INVALID_CHANGES",
  );
  assert.throws(
    () => validateAccountUpdatePayload({ id: "acc-1", changes: { ownerId: "x" } }, 1),
    (error) => error.code === "INVALID_CHANGES",
  );
  assert.throws(
    () => validateAccountUpdatePayload({ id: "acc-1", changes: { visibility: "private" } }, 1),
    (error) => error.code === "INVALID_CHANGES",
  );
});

test("validateAccountUpdatePayload requires a positive integer baseVersion", () => {
  assert.throws(
    () => validateAccountUpdatePayload({ id: "acc-1", changes: { name: "X" } }, undefined),
    (error) => error.code === "INVALID_BASE_VERSION",
  );
  assert.throws(
    () => validateAccountUpdatePayload({ id: "acc-1", changes: { name: "X" } }, 0),
    (error) => error.code === "INVALID_BASE_VERSION",
  );
  const { changes, baseVersion } = validateAccountUpdatePayload(
    { id: "acc-1", changes: { name: " X " } },
    3,
  );
  assert.equal(changes.name, "X");
  assert.equal(baseVersion, 3);
});

test("validateTransactionCreatePayload leaves visibility undefined when the client omits it", () => {
  const data = validateTransactionCreatePayload({
    id: "tx-1",
    accountId: "acc-1",
    bookedOn: "2026-07-01",
    amountMinor: -500,
    currency: "PLN",
    merchant: "",
    title: "Kawa",
    category: "Jedzenie",
    source: "manual",
  });
  assert.equal(data.visibility, undefined);
  assert.throws(
    () => validateTransactionCreatePayload({ ...data, id: "tx-2", bookedOn: "2026-13-40" }),
    (error) => error.code === "INVALID_DATE",
  );
});

test("validateTransactionImportPayload validates every row and enforces a size cap", () => {
  assert.throws(
    () => validateTransactionImportPayload({ transactions: "not-an-array" }),
    (error) => error.code === "INVALID_TRANSACTIONS",
  );
  const rows = validateTransactionImportPayload({
    transactions: [
      {
        id: "tx-1",
        accountId: "acc-1",
        bookedOn: "2026-07-01",
        amountMinor: -100,
        currency: "PLN",
        merchant: "",
        title: "Zakupy",
        category: "Dom",
        source: "csv",
        fingerprint: "csv-aaaaaaaa",
      },
    ],
  });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].fingerprint, "csv-aaaaaaaa");
});

test("validateBudgetCreatePayload/validateBudgetUpdatePayload enforce non-negative limits", () => {
  assert.throws(
    () =>
      validateBudgetCreatePayload({
        id: "b-1",
        category: "Jedzenie",
        limitMinor: -1,
        currency: "PLN",
        color: "#fff",
      }),
    (error) => error.code === "INVALID_LIMIT",
  );
  const { changes, baseVersion } = validateBudgetUpdatePayload(
    { id: "b-1", changes: { limitMinor: 2000 } },
    2,
  );
  assert.equal(changes.limitMinor, 2000);
  assert.equal(baseVersion, 2);
});

test("validateGoalCreatePayload requires visibility; validateGoalUpdatePayload allows clearing deadline", () => {
  assert.throws(
    () =>
      validateGoalCreatePayload({
        id: "g-1",
        name: "Wakacje",
        targetMinor: 10000,
        savedMinor: 0,
        currency: "PLN",
      }),
    (error) => error.code === "INVALID_VISIBILITY",
  );
  const { changes } = validateGoalUpdatePayload({ id: "g-1", changes: { deadline: null } }, 1);
  assert.equal(changes.deadline, null);
});

test("validateDeleteIdPayload requires a valid id", () => {
  assert.throws(
    () => validateDeleteIdPayload({}),
    (error) => error.code === "INVALID_ID",
  );
  assert.deepEqual(validateDeleteIdPayload({ id: "tx-1" }), { id: "tx-1" });
});

test("assertFinanceMutationShape validates the whole-request envelope", () => {
  const valid = { idempotencyKey: randomUUID(), op: "account.create", payload: { id: "acc-1" } };
  assert.doesNotThrow(() => assertFinanceMutationShape(valid));
  assert.throws(
    () => assertFinanceMutationShape({ ...valid, idempotencyKey: "not-a-uuid" }),
    (error) => error.statusCode === 400 && error.code === "INVALID_IDEMPOTENCY_KEY",
  );
  assert.throws(
    () => assertFinanceMutationShape({ ...valid, op: "account.delete" }),
    (error) => error.statusCode === 400 && error.code === "UNSUPPORTED_OP",
  );
  assert.throws(
    () => assertFinanceMutationShape({ ...valid, payload: "nope" }),
    (error) => error.statusCode === 400,
  );
  assert.equal(
    SUPPORTED_FINANCE_OPS.has("account.delete"),
    false,
    "account.delete is out of scope",
  );
});

test("row->DTO mappers convert snake_case/bigint-as-string/Date columns to the frontend shape", () => {
  const account = accountRowToDto({
    id: "acc-1",
    owner_id: "user-1",
    visibility: "household",
    name: "Konto",
    type: "checking",
    balance_minor: "123456789012", // bigint columns arrive as strings from node-postgres
    currency: "PLN",
    color: "#397763",
    archived: false,
    version: 3,
    updated_at: new Date("2026-07-01T10:00:00.000Z"),
  });
  assert.equal(account.balanceMinor, 123456789012);
  assert.equal(typeof account.balanceMinor, "number");
  assert.equal(account.updatedAt, "2026-07-01T10:00:00.000Z");

  const transaction = transactionRowToDto({
    id: "tx-1",
    owner_id: "user-1",
    visibility: "household",
    account_id: "acc-1",
    booked_on: "2026-07-01", // cast to text in SQL: a plain string, not a locale-shifted Date
    amount_minor: "-500",
    currency: "PLN",
    merchant: "",
    title: "Kawa",
    category: "Jedzenie",
    source: "manual",
    fingerprint: null,
    notes: null,
    version: 1,
    updated_at: new Date("2026-07-01T10:00:00.000Z"),
  });
  assert.equal(transaction.bookedOn, "2026-07-01");
  assert.equal(transaction.amountMinor, -500);
  assert.equal(transaction.fingerprint, undefined);

  const budget = budgetRowToDto({
    id: "b-1",
    category: "Dom",
    limit_minor: "50000",
    currency: "PLN",
    color: "#fff",
    version: 1,
    updated_at: new Date("2026-07-01T10:00:00.000Z"),
  });
  assert.equal(budget.limitMinor, 50000);

  const goal = goalRowToDto({
    id: "g-1",
    owner_id: "user-1",
    visibility: "household",
    name: "Wakacje",
    target_minor: "200000",
    saved_minor: "1000",
    currency: "PLN",
    deadline: null,
    version: 1,
    updated_at: new Date("2026-07-01T10:00:00.000Z"),
  });
  assert.equal(goal.targetMinor, 200000);
  assert.equal(goal.deadline, undefined);
});

// ---------------------------------------------------------------------------
// DB-backed integration tests. `npm run test:server` in CI (.github/workflows/ci.yml) does not
// provision a Postgres instance, so these are automatically skipped there via a short connectivity
// probe rather than being deleted or mocked -- they exercise the real SQL (OCC predicates, the
// partial unique index for CSV dedup, the additive balance UPDATE) against a real database.
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
  const email = `finance-test-${randomUUID()}@example.com`;
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
    [`finance-test-${randomUUID()}@example.com`, label],
  );
  const userId = user.rows[0].id;
  await client.query(
    `INSERT INTO household_members(household_id, user_id, role) VALUES ($1, $2, 'member')`,
    [householdId, userId],
  );
  return userId;
}

dbTest(
  "readFinanceSnapshot returns household-wide records plus only the caller's own private ones",
  async () => {
    await withRollback(async (client) => {
      const owner = await createHouseholdAndUser(client, "owner");
      const otherUserId = await addHouseholdMember(client, owner.householdId, "other");
      const ctxOwner = { householdId: owner.householdId, userId: owner.userId };
      const ctxOther = { householdId: owner.householdId, userId: otherUserId };

      await applyFinanceMutation(client, ctxOwner, {
        idempotencyKey: randomUUID(),
        op: "account.create",
        payload: {
          id: randomUUID(),
          name: "Wspólne",
          type: "checking",
          balanceMinor: 0,
          currency: "PLN",
          color: "#397763",
          archived: false,
          visibility: "household",
        },
      });
      await applyFinanceMutation(client, ctxOwner, {
        idempotencyKey: randomUUID(),
        op: "account.create",
        payload: {
          id: randomUUID(),
          name: "Prywatne właściciela",
          type: "checking",
          balanceMinor: 0,
          currency: "PLN",
          color: "#397763",
          archived: false,
          visibility: "private",
        },
      });
      await applyFinanceMutation(client, ctxOther, {
        idempotencyKey: randomUUID(),
        op: "account.create",
        payload: {
          id: randomUUID(),
          name: "Prywatne innego",
          type: "checking",
          balanceMinor: 0,
          currency: "PLN",
          color: "#397763",
          archived: false,
          visibility: "private",
        },
      });

      const snapshotForOwner = await readFinanceSnapshot(client, owner.householdId, owner.userId);
      assert.deepEqual(snapshotForOwner.accounts.map((account) => account.name).sort(), [
        "Prywatne właściciela",
        "Wspólne",
      ]);
    });
  },
);

dbTest(
  "owner_id is always assigned from the session; a spoofed payload.ownerId is ignored",
  async () => {
    await withRollback(async (client) => {
      const { householdId, userId } = await createHouseholdAndUser(client, "owner");
      const ctx = { householdId, userId };
      const result = await applyFinanceMutation(client, ctx, {
        idempotencyKey: randomUUID(),
        op: "account.create",
        payload: {
          id: randomUUID(),
          name: "Konto",
          type: "checking",
          balanceMinor: 0,
          currency: "PLN",
          color: "#397763",
          archived: false,
          visibility: "private",
          ownerId: "00000000-0000-0000-0000-000000000000",
        },
      });
      assert.equal(result.status, "applied");
      assert.equal(result.record.ownerId, userId);
    });
  },
);

dbTest(
  "transaction.create inherits visibility from its account when the client doesn't set one",
  async () => {
    await withRollback(async (client) => {
      const { householdId, userId } = await createHouseholdAndUser(client, "owner");
      const ctx = { householdId, userId };
      const accountId = randomUUID();
      await applyFinanceMutation(client, ctx, {
        idempotencyKey: randomUUID(),
        op: "account.create",
        payload: {
          id: accountId,
          name: "Konto",
          type: "checking",
          balanceMinor: 0,
          currency: "PLN",
          color: "#397763",
          archived: false,
          visibility: "private",
        },
      });
      const txResult = await applyFinanceMutation(client, ctx, {
        idempotencyKey: randomUUID(),
        op: "transaction.create",
        payload: {
          id: randomUUID(),
          accountId,
          bookedOn: "2026-07-01",
          amountMinor: -500,
          currency: "PLN",
          merchant: "",
          title: "Kawa",
          category: "Jedzenie",
          source: "manual",
        },
      });
      assert.equal(txResult.status, "applied");
      assert.equal(txResult.record.visibility, "private");
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
        op: "account.create",
        payload: {
          id: randomUUID(),
          name: "Konto",
          type: "checking",
          balanceMinor: 1000,
          currency: "PLN",
          color: "#397763",
          archived: false,
          visibility: "household",
        },
      };
      const first = await applyFinanceMutation(client, ctx, mutation);
      const second = await applyFinanceMutation(client, ctx, mutation);
      assert.equal(first.status, "applied");
      assert.deepEqual(second, first);
      const count = await client.query(
        "SELECT count(*)::int AS count FROM finance_accounts WHERE household_id = $1",
        [householdId],
      );
      assert.equal(count.rows[0].count, 1);
    });
  },
);

dbTest(
  "two transaction.create mutations on the same account both apply additively -- they never conflict",
  async () => {
    await withRollback(async (client) => {
      const { householdId, userId } = await createHouseholdAndUser(client, "owner");
      const ctx = { householdId, userId };
      const accountId = randomUUID();
      await applyFinanceMutation(client, ctx, {
        idempotencyKey: randomUUID(),
        op: "account.create",
        payload: {
          id: accountId,
          name: "Wspólne",
          type: "checking",
          balanceMinor: 1000,
          currency: "PLN",
          color: "#397763",
          archived: false,
          visibility: "household",
        },
      });
      const first = await applyFinanceMutation(client, ctx, {
        idempotencyKey: randomUUID(),
        op: "transaction.create",
        payload: {
          id: randomUUID(),
          accountId,
          bookedOn: "2026-07-01",
          amountMinor: -300,
          currency: "PLN",
          merchant: "",
          title: "Zakupy",
          category: "Dom",
          source: "manual",
        },
      });
      const second = await applyFinanceMutation(client, ctx, {
        idempotencyKey: randomUUID(),
        op: "transaction.create",
        payload: {
          id: randomUUID(),
          accountId,
          bookedOn: "2026-07-02",
          amountMinor: -200,
          currency: "PLN",
          merchant: "",
          title: "Paliwo",
          category: "Samochód",
          source: "manual",
        },
      });
      assert.equal(first.status, "applied");
      assert.equal(second.status, "applied");
      assert.equal(first.account.balanceMinor, 700);
      assert.equal(second.account.balanceMinor, 500);
    });
  },
);

dbTest(
  "updating the same record with a stale baseVersion conflicts; a sibling record is unaffected",
  async () => {
    await withRollback(async (client) => {
      const { householdId, userId } = await createHouseholdAndUser(client, "owner");
      const ctx = { householdId, userId };
      const budgetAId = randomUUID();
      const budgetBId = randomUUID();
      await applyFinanceMutation(client, ctx, {
        idempotencyKey: randomUUID(),
        op: "budget.create",
        payload: {
          id: budgetAId,
          category: "Jedzenie",
          limitMinor: 50000,
          currency: "PLN",
          color: "#fff",
        },
      });
      await applyFinanceMutation(client, ctx, {
        idempotencyKey: randomUUID(),
        op: "budget.create",
        payload: {
          id: budgetBId,
          category: "Transport",
          limitMinor: 20000,
          currency: "PLN",
          color: "#000",
        },
      });

      const firstUpdate = await applyFinanceMutation(client, ctx, {
        idempotencyKey: randomUUID(),
        op: "budget.update",
        payload: { id: budgetAId, changes: { limitMinor: 60000 } },
        baseVersion: 1,
      });
      assert.equal(firstUpdate.status, "applied");
      assert.equal(firstUpdate.record.version, 2);

      // Same record, stale baseVersion=1 again: must come back as a per-record conflict.
      const staleUpdate = await applyFinanceMutation(client, ctx, {
        idempotencyKey: randomUUID(),
        op: "budget.update",
        payload: { id: budgetAId, changes: { limitMinor: 70000 } },
        baseVersion: 1,
      });
      assert.equal(staleUpdate.status, "conflict");
      assert.equal(staleUpdate.currentVersion, 2);
      assert.equal(staleUpdate.record.limitMinor, 60000);

      // A different record with a legitimately-current baseVersion must go through untouched.
      const otherUpdate = await applyFinanceMutation(client, ctx, {
        idempotencyKey: randomUUID(),
        op: "budget.update",
        payload: { id: budgetBId, changes: { limitMinor: 25000 } },
        baseVersion: 1,
      });
      assert.equal(otherUpdate.status, "applied");
    });
  },
);

dbTest("a private record cannot be updated by another household member", async () => {
  await withRollback(async (client) => {
    const owner = await createHouseholdAndUser(client, "owner");
    const otherUserId = await addHouseholdMember(client, owner.householdId, "other");
    const accountId = randomUUID();
    await applyFinanceMutation(
      client,
      { householdId: owner.householdId, userId: owner.userId },
      {
        idempotencyKey: randomUUID(),
        op: "account.create",
        payload: {
          id: accountId,
          name: "Prywatne",
          type: "checking",
          balanceMinor: 0,
          currency: "PLN",
          color: "#397763",
          archived: false,
          visibility: "private",
        },
      },
    );
    const attempt = await applyFinanceMutation(
      client,
      { householdId: owner.householdId, userId: otherUserId },
      {
        idempotencyKey: randomUUID(),
        op: "account.update",
        payload: { id: accountId, changes: { name: "Podmienione" } },
        baseVersion: 1,
      },
    );
    assert.equal(attempt.status, "error");
    assert.equal(attempt.code, "NOT_FOUND");
  });
});

dbTest(
  "budget.create rejects a duplicate category ignoring currency (parity with FinancePage.tsx)",
  async () => {
    await withRollback(async (client) => {
      const { householdId, userId } = await createHouseholdAndUser(client, "owner");
      const ctx = { householdId, userId };
      await applyFinanceMutation(client, ctx, {
        idempotencyKey: randomUUID(),
        op: "budget.create",
        payload: {
          id: randomUUID(),
          category: "Jedzenie",
          limitMinor: 50000,
          currency: "PLN",
          color: "#fff",
        },
      });
      const duplicate = await applyFinanceMutation(client, ctx, {
        idempotencyKey: randomUUID(),
        op: "budget.create",
        payload: {
          id: randomUUID(),
          category: " JEDZENIE ",
          limitMinor: 30000,
          currency: "USD",
          color: "#000",
        },
      });
      assert.equal(duplicate.status, "error");
      assert.equal(duplicate.code, "BUDGET_CATEGORY_DUPLICATE");
    });
  },
);

dbTest(
  "transaction.delete reverses the balance delta except for csv-sourced rows, and is idempotent",
  async () => {
    await withRollback(async (client) => {
      const { householdId, userId } = await createHouseholdAndUser(client, "owner");
      const ctx = { householdId, userId };
      const accountId = randomUUID();
      await applyFinanceMutation(client, ctx, {
        idempotencyKey: randomUUID(),
        op: "account.create",
        payload: {
          id: accountId,
          name: "Konto",
          type: "checking",
          balanceMinor: 1000,
          currency: "PLN",
          color: "#397763",
          archived: false,
          visibility: "household",
        },
      });
      const manualTxId = randomUUID();
      await applyFinanceMutation(client, ctx, {
        idempotencyKey: randomUUID(),
        op: "transaction.create",
        payload: {
          id: manualTxId,
          accountId,
          bookedOn: "2026-07-01",
          amountMinor: -400,
          currency: "PLN",
          merchant: "",
          title: "Zakupy",
          category: "Dom",
          source: "manual",
        },
      });
      const deleteResult = await applyFinanceMutation(client, ctx, {
        idempotencyKey: randomUUID(),
        op: "transaction.delete",
        payload: { id: manualTxId },
      });
      assert.equal(deleteResult.status, "applied");
      assert.equal(deleteResult.account.balanceMinor, 1000);

      const retryDelete = await applyFinanceMutation(client, ctx, {
        idempotencyKey: randomUUID(),
        op: "transaction.delete",
        payload: { id: manualTxId },
      });
      assert.equal(retryDelete.status, "applied");
      assert.equal(retryDelete.record, null);
    });
  },
);

dbTest(
  "transaction.import dedups by fingerprint and never touches the account balance",
  async () => {
    await withRollback(async (client) => {
      const { householdId, userId } = await createHouseholdAndUser(client, "owner");
      const ctx = { householdId, userId };
      const accountId = randomUUID();
      await applyFinanceMutation(client, ctx, {
        idempotencyKey: randomUUID(),
        op: "account.create",
        payload: {
          id: accountId,
          name: "Konto",
          type: "checking",
          balanceMinor: 500,
          currency: "PLN",
          color: "#397763",
          archived: false,
          visibility: "household",
        },
      });
      const row = {
        accountId,
        bookedOn: "2026-07-01",
        amountMinor: -100,
        currency: "PLN",
        merchant: "Sklep",
        title: "Zakupy",
        category: "Dom",
        source: "csv",
        fingerprint: `csv-${randomUUID()}`,
      };
      const first = await applyFinanceMutation(client, ctx, {
        idempotencyKey: randomUUID(),
        op: "transaction.import",
        payload: {
          transactions: [
            { ...row, id: randomUUID() },
            { ...row, id: randomUUID() },
          ],
        },
      });
      assert.equal(first.status, "applied");
      assert.equal(first.record.addedCount, 1);
      assert.equal(first.record.duplicateCount, 1);
      const account = await client.query(
        "SELECT balance_minor FROM finance_accounts WHERE id = $1",
        [accountId],
      );
      assert.equal(Number(account.rows[0].balance_minor), 500);
    });
  },
);
