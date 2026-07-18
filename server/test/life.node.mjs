import assert from "node:assert/strict";
import test, { after } from "node:test";
import { randomUUID } from "node:crypto";
import pg from "pg";
import {
  LifeValidationError,
  SUPPORTED_LIFE_OPS,
  applyLifeMutation,
  assertLifeMutationShape,
  eventRowToDto,
  habitRowToDto,
  isSeriesIndex,
  noteRowToDto,
  readLifeSnapshot,
  reminderRowToDto,
  resetLifeForUser,
  resolveOwnerId,
  resolveVersionConflict,
  taskRowToDto,
  validateCompletedDates,
  validateDeleteIdPayload,
  validateEventCreatePayload,
  validateEventUpdatePayload,
  validateHabitCreatePayload,
  validateHabitUpdatePayload,
  validateNoteCreatePayload,
  validateNoteUpdatePayload,
  validateRecurrence,
  validateReminderCreatePayload,
  validateReminderUpdatePayload,
  validateTaskCreatePayload,
  validateTaskUpdatePayload,
} from "../src/life.mjs";

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

test("isSeriesIndex accepts non-negative integers only", () => {
  assert.equal(isSeriesIndex(0), true);
  assert.equal(isSeriesIndex(5), true);
  assert.equal(isSeriesIndex(-1), false);
  assert.equal(isSeriesIndex(1.5), false);
  assert.equal(isSeriesIndex("1"), false);
  assert.equal(isSeriesIndex(undefined), false);
});

// `isParsableTimestamp` itself is not exported (same as health.mjs's private helper) -- it's
// exercised indirectly through every validator field that uses it: `task.completedAt`,
// `event.externalUpdatedAt`, `reminder.notifiedAt` (see their dedicated tests below). This test
// pins down that indirect contract in one place: free-form Date.parse-able strings pass, garbage/
// empty/non-string/oversize values are rejected, consistently across all three fields.
test(
  "isParsableTimestamp (exercised via task.completedAt/event.externalUpdatedAt/reminder.notifiedAt) " +
    "accepts free-form Date.parse-able strings and rejects garbage/empty/oversize/non-string values",
  () => {
    const acceptedTimestamps = ["2026-07-18T07:30", "2026-07-18", "July 18, 2026"];
    for (const value of acceptedTimestamps) {
      assert.doesNotThrow(() => validateTaskCreatePayload(taskPayload({ completedAt: value })));
      assert.doesNotThrow(() =>
        validateEventCreatePayload(eventPayload({ externalUpdatedAt: value })),
      );
      assert.doesNotThrow(() =>
        validateReminderCreatePayload(reminderPayload({ notifiedAt: value })),
      );
    }

    const rejectedTimestamps = ["not-a-timestamp", "", "x".repeat(201)];
    for (const value of rejectedTimestamps) {
      assert.throws(
        () => validateTaskCreatePayload(taskPayload({ completedAt: value })),
        (error) => error.code === "INVALID_COMPLETED_AT",
      );
      assert.throws(
        () => validateEventCreatePayload(eventPayload({ externalUpdatedAt: value })),
        (error) => error.code === "INVALID_EXTERNAL_UPDATED_AT",
      );
      assert.throws(
        () => validateReminderCreatePayload(reminderPayload({ notifiedAt: value })),
        (error) => error.code === "INVALID_NOTIFIED_AT",
      );
    }

    assert.throws(
      () => validateTaskCreatePayload(taskPayload({ completedAt: 123 })),
      (error) => error.code === "INVALID_COMPLETED_AT",
      "non-string",
    );
  },
);

test("validateCompletedDates requires an array of iso-dates, capped at MAX_COMPLETED_DATES", () => {
  assert.equal(validateCompletedDates([]), true);
  assert.equal(validateCompletedDates(["2026-07-18", "2026-07-19"]), true);
  assert.equal(validateCompletedDates(["not-a-date"]), false);
  assert.equal(validateCompletedDates("2026-07-18"), false);
  assert.equal(validateCompletedDates(null), false);
  assert.equal(
    validateCompletedDates(Array.from({ length: 5001 }, () => "2026-07-18")),
    false,
    "over the 5000-entry cap",
  );
});

function recurrencePayload(overrides = {}) {
  return {
    freq: "weekly",
    interval: 1,
    weekdays: [1, 3, 5],
    count: 10,
    anchorDate: "2026-07-18",
    anchorTime: "09:00",
    ...overrides,
  };
}

test("validateRecurrence accepts a well-shaped recurrence and normalizes to an allow-listed object", () => {
  const result = validateRecurrence(recurrencePayload());
  assert.deepEqual(result, {
    freq: "weekly",
    interval: 1,
    weekdays: [1, 3, 5],
    count: 10,
    anchorDate: "2026-07-18",
    anchorTime: "09:00",
  });
});

test("validateRecurrence drops unknown keys (allow-list, not passthrough)", () => {
  const result = validateRecurrence(recurrencePayload({ evil: "payload" }));
  assert.equal("evil" in result, false);
});

test("validateRecurrence accepts the minimal shape (freq/interval/anchorDate only)", () => {
  const result = validateRecurrence({ freq: "daily", interval: 2, anchorDate: "2026-07-18" });
  assert.deepEqual(result, { freq: "daily", interval: 2, anchorDate: "2026-07-18" });
});

test("validateRecurrence rejects invalid freq/interval/weekdays/count/anchorDate/anchorTime", () => {
  assert.throws(
    () => validateRecurrence(recurrencePayload({ freq: "yearly" })),
    (error) => error.code === "INVALID_RECURRENCE",
  );
  assert.throws(
    () => validateRecurrence(recurrencePayload({ interval: 0 })),
    (error) => error.code === "INVALID_RECURRENCE",
  );
  assert.throws(
    () => validateRecurrence(recurrencePayload({ interval: 1.5 })),
    (error) => error.code === "INVALID_RECURRENCE",
  );
  assert.throws(
    () => validateRecurrence(recurrencePayload({ weekdays: [] })),
    (error) => error.code === "INVALID_RECURRENCE",
    "empty weekdays array",
  );
  assert.throws(
    () => validateRecurrence(recurrencePayload({ weekdays: [0] })),
    (error) => error.code === "INVALID_RECURRENCE",
    "weekday out of 1-7 range",
  );
  assert.throws(
    () => validateRecurrence(recurrencePayload({ weekdays: [8] })),
    (error) => error.code === "INVALID_RECURRENCE",
  );
  assert.throws(
    () => validateRecurrence(recurrencePayload({ count: 0 })),
    (error) => error.code === "INVALID_RECURRENCE",
  );
  assert.throws(
    () => validateRecurrence(recurrencePayload({ anchorDate: "not-a-date" })),
    (error) => error.code === "INVALID_RECURRENCE",
  );
  assert.throws(
    () => validateRecurrence(recurrencePayload({ anchorTime: "9am" })),
    (error) => error.code === "INVALID_RECURRENCE",
  );
  assert.throws(
    () => validateRecurrence(null),
    (error) => error.code === "INVALID_RECURRENCE",
  );
  assert.throws(
    () => validateRecurrence("nope"),
    (error) => error.code === "INVALID_RECURRENCE",
  );
});

function taskPayload(overrides = {}) {
  return {
    id: "task-1",
    title: "Zrobić zakupy",
    status: "todo",
    priority: "medium",
    category: "dom",
    isFocus: false,
    energy: "medium",
    visibility: "household",
    ...overrides,
  };
}

test("validateTaskCreatePayload accepts a well-shaped payload and never reads/forwards ownerId", () => {
  const data = validateTaskCreatePayload(taskPayload({ ownerId: "someone-else" }));
  assert.equal(data.title, "Zrobić zakupy");
  assert.equal(data.visibility, "household");
  assert.equal("ownerId" in data, false, "the validator does not read or forward ownerId");
});

test("validateTaskCreatePayload rejects invalid fields", () => {
  assert.throws(() => validateTaskCreatePayload({}), LifeValidationError);
  assert.throws(
    () => validateTaskCreatePayload(taskPayload({ title: "" })),
    (error) => error.code === "INVALID_TITLE",
  );
  assert.throws(
    () => validateTaskCreatePayload(taskPayload({ status: "in-progress" })),
    (error) => error.code === "INVALID_STATUS",
  );
  assert.throws(
    () => validateTaskCreatePayload(taskPayload({ priority: "urgent" })),
    (error) => error.code === "INVALID_PRIORITY",
  );
  assert.throws(
    () => validateTaskCreatePayload(taskPayload({ date: "not-a-date" })),
    (error) => error.code === "INVALID_DATE",
  );
  assert.throws(
    () => validateTaskCreatePayload(taskPayload({ time: "9am" })),
    (error) => error.code === "INVALID_TIME",
  );
  assert.throws(
    () => validateTaskCreatePayload(taskPayload({ estimatedMinutes: -5 })),
    (error) => error.code === "INVALID_ESTIMATED_MINUTES",
  );
  assert.throws(
    () => validateTaskCreatePayload(taskPayload({ category: "" })),
    (error) => error.code === "INVALID_CATEGORY",
  );
  assert.throws(
    () => validateTaskCreatePayload(taskPayload({ isFocus: "yes" })),
    (error) => error.code === "INVALID_IS_FOCUS",
  );
  assert.throws(
    () => validateTaskCreatePayload(taskPayload({ energy: "extreme" })),
    (error) => error.code === "INVALID_ENERGY",
  );
  assert.throws(
    () => validateTaskCreatePayload(taskPayload({ completedAt: "not-a-timestamp" })),
    (error) => error.code === "INVALID_COMPLETED_AT",
  );
  assert.throws(
    () => validateTaskCreatePayload(taskPayload({ visibility: "public" })),
    (error) => error.code === "INVALID_VISIBILITY",
  );
});

test("validateTaskCreatePayload's series fields must appear ALL TOGETHER or NOT AT ALL", () => {
  // None -- a plain one-off task -- is fine.
  const oneOff = validateTaskCreatePayload(taskPayload());
  assert.equal(oneOff.seriesId, null);
  assert.equal(oneOff.seriesIndex, null);
  assert.equal(oneOff.recurrence, null);

  // All three -- a series occurrence -- is fine.
  const occurrence = validateTaskCreatePayload(
    taskPayload({
      seriesId: "series-1",
      seriesIndex: 0,
      recurrence: recurrencePayload(),
    }),
  );
  assert.equal(occurrence.seriesId, "series-1");
  assert.equal(occurrence.seriesIndex, 0);
  assert.deepEqual(occurrence.recurrence.freq, "weekly");

  // Partial combos are all rejected.
  assert.throws(
    () => validateTaskCreatePayload(taskPayload({ seriesId: "series-1" })),
    (error) => error.code === "INVALID_SERIES_FIELDS",
    "seriesId alone",
  );
  assert.throws(
    () => validateTaskCreatePayload(taskPayload({ seriesIndex: 0 })),
    (error) => error.code === "INVALID_SERIES_FIELDS",
    "seriesIndex alone",
  );
  assert.throws(
    () => validateTaskCreatePayload(taskPayload({ recurrence: recurrencePayload() })),
    (error) => error.code === "INVALID_SERIES_FIELDS",
    "recurrence alone",
  );
  assert.throws(
    () => validateTaskCreatePayload(taskPayload({ seriesId: "series-1", seriesIndex: 0 })),
    (error) => error.code === "INVALID_SERIES_FIELDS",
    "seriesId + seriesIndex, missing recurrence",
  );
  assert.throws(
    () =>
      validateTaskCreatePayload(
        taskPayload({ seriesId: "series-1", recurrence: recurrencePayload() }),
      ),
    (error) => error.code === "INVALID_SERIES_FIELDS",
    "seriesId + recurrence, missing seriesIndex",
  );
});

test(
  "validateTaskUpdatePayload only allows TASK_UPDATE_KEYS, including visibility, and does NOT " +
    "enforce the series all-or-nothing group check (independently editable on update)",
  () => {
    assert.throws(
      () => validateTaskUpdatePayload({ id: "task-1", changes: { ownerId: "other" } }, 1),
      (error) => error.code === "INVALID_CHANGES",
    );
    const { changes, baseVersion } = validateTaskUpdatePayload(
      { id: "task-1", changes: { title: " Nowy tytuł ", visibility: "private" } },
      2,
    );
    assert.equal(changes.title, "Nowy tytuł");
    assert.equal(changes.visibility, "private");
    assert.equal(baseVersion, 2);

    // updateSeries may rewrite recurrence alone, without seriesId/seriesIndex present.
    const recurrenceOnly = validateTaskUpdatePayload(
      { id: "task-1", changes: { recurrence: recurrencePayload({ interval: 2 }) } },
      3,
    );
    assert.equal(recurrenceOnly.changes.recurrence.interval, 2);

    // Clearing recurrence to null (detaching an occurrence from its series) is allowed alone too.
    const clearRecurrence = validateTaskUpdatePayload(
      { id: "task-1", changes: { seriesId: null, seriesIndex: null, recurrence: null } },
      4,
    );
    assert.equal(clearRecurrence.changes.seriesId, null);
    assert.equal(clearRecurrence.changes.recurrence, null);
  },
);

test("validateTaskUpdatePayload requires a positive integer baseVersion", () => {
  assert.throws(
    () => validateTaskUpdatePayload({ id: "task-1", changes: { title: "X" } }, undefined),
    (error) => error.code === "INVALID_BASE_VERSION",
  );
  assert.throws(
    () => validateTaskUpdatePayload({ id: "task-1", changes: { title: "X" } }, 0),
    (error) => error.code === "INVALID_BASE_VERSION",
  );
});

test("validateDeleteIdPayload requires a valid id", () => {
  assert.throws(
    () => validateDeleteIdPayload({}),
    (error) => error.code === "INVALID_ID",
  );
  assert.deepEqual(validateDeleteIdPayload({ id: "task-1" }), { id: "task-1" });
});

function eventPayload(overrides = {}) {
  return {
    id: "event-1",
    title: "Stand-up",
    date: "2026-07-20",
    startTime: "09:00",
    endTime: "09:30",
    kind: "meeting",
    visibility: "household",
    ...overrides,
  };
}

test("validateEventCreatePayload accepts a well-shaped payload and never reads/forwards ownerId", () => {
  const data = validateEventCreatePayload(eventPayload({ ownerId: "someone-else" }));
  assert.equal(data.title, "Stand-up");
  assert.equal("ownerId" in data, false);
});

test("validateEventCreatePayload rejects invalid fields", () => {
  assert.throws(() => validateEventCreatePayload({}), LifeValidationError);
  assert.throws(
    () => validateEventCreatePayload(eventPayload({ date: "not-a-date" })),
    (error) => error.code === "INVALID_DATE",
  );
  assert.throws(
    () => validateEventCreatePayload(eventPayload({ startTime: "9am" })),
    (error) => error.code === "INVALID_START_TIME",
  );
  assert.throws(
    () => validateEventCreatePayload(eventPayload({ endTime: "9am" })),
    (error) => error.code === "INVALID_END_TIME",
  );
  assert.throws(
    () => validateEventCreatePayload(eventPayload({ kind: "party" })),
    (error) => error.code === "INVALID_KIND",
  );
  assert.throws(
    () => validateEventCreatePayload(eventPayload({ source: "outlook" })),
    (error) => error.code === "INVALID_SOURCE",
  );
  assert.throws(
    () => validateEventCreatePayload(eventPayload({ externalUpdatedAt: "not-a-timestamp" })),
    (error) => error.code === "INVALID_EXTERNAL_UPDATED_AT",
  );
  assert.throws(
    () => validateEventCreatePayload(eventPayload({ visibility: "public" })),
    (error) => error.code === "INVALID_VISIBILITY",
  );
});

test(
  "validateEventCreatePayload's series fields must appear ALL TOGETHER or NOT AT ALL (same group " +
    "check as tasks)",
  () => {
    const oneOff = validateEventCreatePayload(eventPayload());
    assert.equal(oneOff.seriesId, null);

    const occurrence = validateEventCreatePayload(
      eventPayload({ seriesId: "series-1", seriesIndex: 2, recurrence: recurrencePayload() }),
    );
    assert.equal(occurrence.seriesIndex, 2);

    assert.throws(
      () => validateEventCreatePayload(eventPayload({ seriesIndex: 0 })),
      (error) => error.code === "INVALID_SERIES_FIELDS",
    );
  },
);

test("validateEventUpdatePayload only allows EVENT_UPDATE_KEYS, including visibility", () => {
  assert.throws(
    () => validateEventUpdatePayload({ id: "event-1", changes: { ownerId: "other" } }, 1),
    (error) => error.code === "INVALID_CHANGES",
  );
  const { changes } = validateEventUpdatePayload(
    { id: "event-1", changes: { location: null, visibility: "private" } },
    1,
  );
  assert.equal(changes.location, null);
  assert.equal(changes.visibility, "private");
});

function reminderPayload(overrides = {}) {
  return {
    id: "reminder-1",
    title: "Zadzwonić do lekarza",
    date: "2026-07-20",
    time: "10:00",
    visibility: "household",
    ...overrides,
  };
}

test(
  "validateReminderCreatePayload accepts a well-shaped payload, defaults done=false/notifiedAt=null, " +
    "and never reads/forwards ownerId",
  () => {
    const data = validateReminderCreatePayload(reminderPayload({ ownerId: "someone-else" }));
    assert.equal(data.done, false);
    assert.equal(data.notifiedAt, null);
    assert.equal("ownerId" in data, false);
  },
);

test("validateReminderCreatePayload rejects invalid fields", () => {
  assert.throws(() => validateReminderCreatePayload({}), LifeValidationError);
  assert.throws(
    () => validateReminderCreatePayload(reminderPayload({ date: "not-a-date" })),
    (error) => error.code === "INVALID_DATE",
  );
  assert.throws(
    () => validateReminderCreatePayload(reminderPayload({ time: "10am" })),
    (error) => error.code === "INVALID_TIME",
  );
  assert.throws(
    () => validateReminderCreatePayload(reminderPayload({ done: "yes" })),
    (error) => error.code === "INVALID_DONE",
  );
  assert.throws(
    () => validateReminderCreatePayload(reminderPayload({ notifiedAt: "not-a-timestamp" })),
    (error) => error.code === "INVALID_NOTIFIED_AT",
  );
});

test(
  "validateReminderUpdatePayload only allows REMINDER_UPDATE_KEYS, including visibility and " +
    "notifiedAt (snoozeReminder/markReminderNotified's exact shapes)",
  () => {
    assert.throws(
      () => validateReminderUpdatePayload({ id: "reminder-1", changes: { ownerId: "other" } }, 1),
      (error) => error.code === "INVALID_CHANGES",
    );

    // snoozeReminder: reschedule + clear notifiedAt.
    const snoozed = validateReminderUpdatePayload(
      { id: "reminder-1", changes: { date: "2026-07-21", time: "11:00", notifiedAt: null } },
      1,
    );
    assert.deepEqual(snoozed.changes, {
      date: "2026-07-21",
      time: "11:00",
      notifiedAt: null,
    });

    // markReminderNotified: set notifiedAt.
    const notified = validateReminderUpdatePayload(
      { id: "reminder-1", changes: { notifiedAt: "2026-07-20T10:00:00.000Z" } },
      2,
    );
    assert.equal(notified.changes.notifiedAt, "2026-07-20T10:00:00.000Z");

    const visibilityChange = validateReminderUpdatePayload(
      { id: "reminder-1", changes: { visibility: "private" } },
      3,
    );
    assert.equal(visibilityChange.changes.visibility, "private");
  },
);

function notePayload(overrides = {}) {
  return {
    id: "note-1",
    title: "Pomysł",
    content: "Kupić kwiaty",
    color: "mint",
    pinned: false,
    visibility: "household",
    ...overrides,
  };
}

test("validateNoteCreatePayload accepts an empty content string (no .min(1)) and never reads/forwards ownerId", () => {
  const data = validateNoteCreatePayload(notePayload({ content: "", ownerId: "someone-else" }));
  assert.equal(data.content, "");
  assert.equal("ownerId" in data, false);
});

test("validateNoteCreatePayload rejects invalid fields", () => {
  assert.throws(() => validateNoteCreatePayload({}), LifeValidationError);
  assert.throws(
    () => validateNoteCreatePayload(notePayload({ title: "" })),
    (error) => error.code === "INVALID_TITLE",
  );
  assert.throws(
    () => validateNoteCreatePayload(notePayload({ content: "x".repeat(100_001) })),
    (error) => error.code === "INVALID_CONTENT",
  );
  assert.throws(
    () => validateNoteCreatePayload(notePayload({ color: "red" })),
    (error) => error.code === "INVALID_COLOR",
  );
  assert.throws(
    () => validateNoteCreatePayload(notePayload({ pinned: "yes" })),
    (error) => error.code === "INVALID_PINNED",
  );
});

test("validateNoteUpdatePayload only allows NOTE_UPDATE_KEYS, including visibility", () => {
  assert.throws(
    () => validateNoteUpdatePayload({ id: "note-1", changes: { ownerId: "other" } }, 1),
    (error) => error.code === "INVALID_CHANGES",
  );
  const { changes } = validateNoteUpdatePayload(
    { id: "note-1", changes: { pinned: true, visibility: "private" } },
    1,
  );
  assert.equal(changes.pinned, true);
  assert.equal(changes.visibility, "private");
});

function habitPayload(overrides = {}) {
  return {
    id: "habit-1",
    name: "Pić wodę",
    icon: "water",
    targetLabel: "8 szklanek dziennie",
    visibility: "household",
    ...overrides,
  };
}

test(
  "validateHabitCreatePayload accepts a well-shaped payload, defaults completedDates=[], and " +
    "never reads/forwards ownerId",
  () => {
    const data = validateHabitCreatePayload(habitPayload({ ownerId: "someone-else" }));
    assert.deepEqual(data.completedDates, []);
    assert.equal("ownerId" in data, false);
  },
);

test("validateHabitCreatePayload rejects invalid fields", () => {
  assert.throws(() => validateHabitCreatePayload({}), LifeValidationError);
  assert.throws(
    () => validateHabitCreatePayload(habitPayload({ icon: "run" })),
    (error) => error.code === "INVALID_ICON",
  );
  assert.throws(
    () => validateHabitCreatePayload(habitPayload({ targetLabel: "" })),
    (error) => error.code === "INVALID_TARGET_LABEL",
  );
  assert.throws(
    () => validateHabitCreatePayload(habitPayload({ completedDates: ["not-a-date"] })),
    (error) => error.code === "INVALID_COMPLETED_DATES",
  );
});

test(
  "validateHabitUpdatePayload's completedDates is an ABSOLUTE SET (the whole recomputed array), " +
    "not a per-date flip -- the validator just persists whatever array it's given",
  () => {
    assert.throws(
      () => validateHabitUpdatePayload({ id: "habit-1", changes: { ownerId: "other" } }, 1),
      (error) => error.code === "INVALID_CHANGES",
    );
    const { changes } = validateHabitUpdatePayload(
      { id: "habit-1", changes: { completedDates: ["2026-07-18", "2026-07-19"] } },
      1,
    );
    assert.deepEqual(changes.completedDates, ["2026-07-18", "2026-07-19"]);

    // toggleHabit removing a date sends the array WITHOUT it -- still just a plain SET from this
    // validator's point of view.
    const shrunk = validateHabitUpdatePayload(
      { id: "habit-1", changes: { completedDates: ["2026-07-18"] } },
      2,
    );
    assert.deepEqual(shrunk.changes.completedDates, ["2026-07-18"]);

    assert.throws(
      () => validateHabitUpdatePayload({ id: "habit-1", changes: { completedDates: ["bad"] } }, 1),
      (error) => error.code === "INVALID_COMPLETED_DATES",
    );
  },
);

test("assertLifeMutationShape validates the whole-request envelope", () => {
  const valid = {
    idempotencyKey: randomUUID(),
    op: "task.create",
    payload: { id: "task-1" },
  };
  assert.doesNotThrow(() => assertLifeMutationShape(valid));
  assert.throws(
    () => assertLifeMutationShape({ ...valid, idempotencyKey: "not-a-uuid" }),
    (error) => error.statusCode === 400 && error.code === "INVALID_IDEMPOTENCY_KEY",
  );
  assert.throws(
    () => assertLifeMutationShape({ ...valid, op: "task.archive" }),
    (error) => error.statusCode === 400 && error.code === "UNSUPPORTED_OP",
  );
  assert.throws(
    () => assertLifeMutationShape({ ...valid, payload: "nope" }),
    (error) => error.statusCode === 400,
  );
  assert.throws(
    () => assertLifeMutationShape({ ...valid, baseVersion: "1" }),
    (error) => error.statusCode === 400,
  );
  for (const collection of ["task", "event", "reminder", "note", "habit"]) {
    assert.equal(SUPPORTED_LIFE_OPS.has(`${collection}.create`), true);
    assert.equal(SUPPORTED_LIFE_OPS.has(`${collection}.update`), true);
    assert.equal(SUPPORTED_LIFE_OPS.has(`${collection}.delete`), true);
  }
});

test("row->DTO mappers convert snake_case/Date/jsonb columns to the frontend shape", () => {
  const task = taskRowToDto({
    id: "task-1",
    owner_id: "user-1",
    visibility: "household",
    title: "Zrobić zakupy",
    description: null,
    status: "todo",
    priority: "medium",
    date: "2026-07-20",
    time: null,
    estimated_minutes: null,
    category: "dom",
    is_focus: false,
    energy: "medium",
    completed_at: null,
    series_id: null,
    series_index: null,
    recurrence: null,
    version: 1,
    created_at: new Date("2026-07-01T10:00:00.000Z"),
    updated_at: new Date("2026-07-01T10:00:00.000Z"),
  });
  assert.equal(task.date, "2026-07-20");
  assert.equal(task.description, undefined);
  assert.equal(task.seriesId, undefined);
  assert.equal(task.updatedAt, "2026-07-01T10:00:00.000Z");

  const event = eventRowToDto({
    id: "event-1",
    owner_id: "user-1",
    visibility: "household",
    title: "Stand-up",
    date: "2026-07-20",
    start_time: "09:00",
    end_time: "09:30",
    kind: "meeting",
    location: null,
    notes: null,
    source: null,
    external_id: null,
    external_updated_at: null,
    series_id: "series-1",
    series_index: 2,
    recurrence: { freq: "daily", interval: 1, anchorDate: "2026-07-01" },
    version: 3,
    updated_at: new Date("2026-07-01T10:00:00.000Z"),
  });
  assert.equal(event.seriesId, "series-1");
  assert.equal(event.seriesIndex, 2);
  assert.deepEqual(event.recurrence, { freq: "daily", interval: 1, anchorDate: "2026-07-01" });

  const reminder = reminderRowToDto({
    id: "reminder-1",
    owner_id: "user-1",
    visibility: "household",
    title: "Zadzwonić",
    date: "2026-07-20",
    time: "10:00",
    done: false,
    notified_at: null,
    version: 1,
    updated_at: new Date("2026-07-01T10:00:00.000Z"),
  });
  assert.equal(reminder.notifiedAt, undefined);

  const note = noteRowToDto({
    id: "note-1",
    owner_id: "user-1",
    visibility: "household",
    title: "Pomysł",
    content: "",
    color: "mint",
    pinned: false,
    version: 1,
    created_at: new Date("2026-07-01T10:00:00.000Z"),
    updated_at: new Date("2026-07-01T10:00:00.000Z"),
  });
  assert.equal(note.content, "");

  const habit = habitRowToDto({
    id: "habit-1",
    owner_id: "user-1",
    visibility: "household",
    name: "Pić wodę",
    icon: "water",
    target_label: "8 szklanek",
    completed_dates: ["2026-07-18"],
    version: 1,
    updated_at: new Date("2026-07-01T10:00:00.000Z"),
  });
  assert.deepEqual(habit.completedDates, ["2026-07-18"]);

  // Defensive: a NULL completed_dates column (shouldn't happen -- NOT NULL DEFAULT '[]' -- but the
  // mapper guards against it anyway) still maps to an empty array, not undefined/null.
  const habitNullDates = habitRowToDto({
    id: "habit-2",
    owner_id: "user-1",
    visibility: "household",
    name: "Czytać",
    icon: "read",
    target_label: "20 stron",
    completed_dates: null,
    version: 1,
    updated_at: new Date("2026-07-01T10:00:00.000Z"),
  });
  assert.deepEqual(habitNullDates.completedDates, []);
});

// ---------------------------------------------------------------------------
// DB-backed integration tests. `npm run test:server` in CI (.github/workflows/ci.yml) does not
// provision a Postgres instance, so these are automatically skipped there via a short connectivity
// probe rather than being deleted or mocked -- they exercise the real SQL (OCC predicates, the
// visibility scoping on conflict lookups, idempotency claims, ID_TAKEN collisions) against a real
// database.
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
  const email = `life-test-${randomUUID()}@example.com`;
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
    [`life-test-${randomUUID()}@example.com`, label],
  );
  const userId = user.rows[0].id;
  await client.query(
    `INSERT INTO household_members(household_id, user_id, role) VALUES ($1, $2, 'member')`,
    [householdId, userId],
  );
  return userId;
}

function dbTaskPayload(overrides = {}) {
  return {
    id: randomUUID(),
    title: "Zrobić zakupy",
    status: "todo",
    priority: "medium",
    category: "dom",
    isFocus: false,
    energy: "medium",
    visibility: "household",
    ...overrides,
  };
}

function dbEventPayload(overrides = {}) {
  return {
    id: randomUUID(),
    title: "Stand-up",
    date: "2026-07-20",
    startTime: "09:00",
    endTime: "09:30",
    kind: "meeting",
    visibility: "household",
    ...overrides,
  };
}

function dbReminderPayload(overrides = {}) {
  return {
    id: randomUUID(),
    title: "Zadzwonić do lekarza",
    date: "2026-07-20",
    time: "10:00",
    visibility: "household",
    ...overrides,
  };
}

function dbNotePayload(overrides = {}) {
  return {
    id: randomUUID(),
    title: "Pomysł",
    content: "Kupić kwiaty",
    color: "mint",
    pinned: false,
    visibility: "household",
    ...overrides,
  };
}

function dbHabitPayload(overrides = {}) {
  return {
    id: randomUUID(),
    name: "Pić wodę",
    icon: "water",
    targetLabel: "8 szklanek dziennie",
    visibility: "household",
    ...overrides,
  };
}

dbTest(
  "*.create derives owner_id from the session for all five collections, ignoring any ownerId in " +
    "the payload",
  async () => {
    await withRollback(async (client) => {
      const owner = await createHouseholdAndUser(client, "owner");
      const impersonated = await addHouseholdMember(client, owner.householdId, "other");
      const ctx = { householdId: owner.householdId, userId: owner.userId };

      const task = await applyLifeMutation(client, ctx, {
        idempotencyKey: randomUUID(),
        op: "task.create",
        payload: dbTaskPayload({ ownerId: impersonated }),
      });
      assert.equal(task.record.ownerId, owner.userId);

      const event = await applyLifeMutation(client, ctx, {
        idempotencyKey: randomUUID(),
        op: "event.create",
        payload: dbEventPayload({ ownerId: impersonated }),
      });
      assert.equal(event.record.ownerId, owner.userId);

      const reminder = await applyLifeMutation(client, ctx, {
        idempotencyKey: randomUUID(),
        op: "reminder.create",
        payload: dbReminderPayload({ ownerId: impersonated }),
      });
      assert.equal(reminder.record.ownerId, owner.userId);

      const note = await applyLifeMutation(client, ctx, {
        idempotencyKey: randomUUID(),
        op: "note.create",
        payload: dbNotePayload({ ownerId: impersonated }),
      });
      assert.equal(note.record.ownerId, owner.userId);

      const habit = await applyLifeMutation(client, ctx, {
        idempotencyKey: randomUUID(),
        op: "habit.create",
        payload: dbHabitPayload({ ownerId: impersonated }),
      });
      assert.equal(habit.record.ownerId, owner.userId);
      for (const record of [task, event, reminder, note, habit]) {
        assert.notEqual(record.record.ownerId, impersonated);
      }
    });
  },
);

dbTest(
  "visibility comes from the payload on create and is NOT silently defaulted -- payload visibility " +
    "is honored, and it is editable on update (parity with Finance-era regression)",
  async () => {
    await withRollback(async (client) => {
      const { householdId, userId } = await createHouseholdAndUser(client, "owner");
      const ctx = { householdId, userId };

      const taskId = randomUUID();
      await applyLifeMutation(client, ctx, {
        idempotencyKey: randomUUID(),
        op: "task.create",
        payload: dbTaskPayload({ id: taskId, visibility: "household" }),
      });
      const taskUpdate = await applyLifeMutation(client, ctx, {
        idempotencyKey: randomUUID(),
        op: "task.update",
        payload: { id: taskId, changes: { visibility: "private" } },
        baseVersion: 1,
      });
      assert.equal(taskUpdate.status, "applied");
      assert.equal(taskUpdate.record.visibility, "private");
    });
  },
);

dbTest(
  "stale baseVersion on *.update returns conflict + currentVersion for exactly the affected record; " +
    "concurrent edits to two different records both apply",
  async () => {
    await withRollback(async (client) => {
      const { householdId, userId } = await createHouseholdAndUser(client, "owner");
      const ctx = { householdId, userId };

      const taskAId = randomUUID();
      const taskBId = randomUUID();
      await applyLifeMutation(client, ctx, {
        idempotencyKey: randomUUID(),
        op: "task.create",
        payload: dbTaskPayload({ id: taskAId, title: "Zadanie A" }),
      });
      await applyLifeMutation(client, ctx, {
        idempotencyKey: randomUUID(),
        op: "task.create",
        payload: dbTaskPayload({ id: taskBId, title: "Zadanie B" }),
      });

      // Bump A's version once so a client holding version 1 is now stale.
      await applyLifeMutation(client, ctx, {
        idempotencyKey: randomUUID(),
        op: "task.update",
        payload: { id: taskAId, changes: { title: "Zadanie A (v2)" } },
        baseVersion: 1,
      });

      const staleAttempt = await applyLifeMutation(client, ctx, {
        idempotencyKey: randomUUID(),
        op: "task.update",
        payload: { id: taskAId, changes: { title: "Zadanie A (konflikt)" } },
        baseVersion: 1,
      });
      assert.equal(staleAttempt.status, "conflict");
      assert.equal(staleAttempt.currentVersion, 2);
      assert.equal(staleAttempt.record.title, "Zadanie A (v2)");

      // B, untouched by A's conflict, still applies cleanly at its own (still-current) version.
      const concurrentB = await applyLifeMutation(client, ctx, {
        idempotencyKey: randomUUID(),
        op: "task.update",
        payload: { id: taskBId, changes: { title: "Zadanie B (v2)" } },
        baseVersion: 1,
      });
      assert.equal(concurrentB.status, "applied");
      assert.equal(concurrentB.record.title, "Zadanie B (v2)");
    });
  },
);

dbTest(
  "the conflict-diagnosis query for *.update carries the same visibility scope as the write, so a " +
    "private record's existence/content is never leaked to another household member",
  async () => {
    await withRollback(async (client) => {
      const owner = await createHouseholdAndUser(client, "owner");
      const otherUserId = await addHouseholdMember(client, owner.householdId, "other");
      const taskId = randomUUID();
      await applyLifeMutation(
        client,
        { householdId: owner.householdId, userId: owner.userId },
        {
          idempotencyKey: randomUUID(),
          op: "task.create",
          payload: dbTaskPayload({ id: taskId, visibility: "private" }),
        },
      );
      const attempt = await applyLifeMutation(
        client,
        { householdId: owner.householdId, userId: otherUserId },
        {
          idempotencyKey: randomUUID(),
          op: "task.update",
          payload: { id: taskId, changes: { title: "Podmienione" } },
          baseVersion: 1,
        },
      );
      assert.equal(attempt.status, "error");
      assert.equal(attempt.code, "NOT_FOUND");
      assert.equal("record" in attempt, false, "no record leaked in the error response");

      const snapshotForOther = await readLifeSnapshot(client, owner.householdId, otherUserId);
      assert.deepEqual(snapshotForOther.tasks, []);
    });
  },
);

dbTest(
  "retrying a mutation with the same idempotency key returns the stored result verbatim, not a new " +
    "row/duplicate",
  async () => {
    await withRollback(async (client) => {
      const { householdId, userId } = await createHouseholdAndUser(client, "owner");
      const ctx = { householdId, userId };
      const mutation = {
        idempotencyKey: randomUUID(),
        op: "task.create",
        payload: dbTaskPayload(),
      };
      const first = await applyLifeMutation(client, ctx, mutation);
      const second = await applyLifeMutation(client, ctx, mutation);
      assert.equal(first.status, "applied");
      assert.deepEqual(second, JSON.parse(JSON.stringify(first)));
      const count = await client.query(
        "SELECT count(*)::int AS count FROM tasks WHERE household_id = $1",
        [householdId],
      );
      assert.equal(count.rows[0].count, 1);
    });
  },
);

dbTest(
  "retrying habit.update{changes:{completedDates}} (the absolute-set toggle) with the same " +
    "idempotency key does not double-apply: version increments exactly once",
  async () => {
    await withRollback(async (client) => {
      const { householdId, userId } = await createHouseholdAndUser(client, "owner");
      const ctx = { householdId, userId };
      const habitId = randomUUID();
      await applyLifeMutation(client, ctx, {
        idempotencyKey: randomUUID(),
        op: "habit.create",
        payload: dbHabitPayload({ id: habitId, completedDates: [] }),
      });

      const toggleMutation = {
        idempotencyKey: randomUUID(),
        op: "habit.update",
        payload: { id: habitId, changes: { completedDates: ["2026-07-18"] } },
        baseVersion: 1,
      };
      const first = await applyLifeMutation(client, ctx, toggleMutation);
      assert.equal(first.status, "applied");
      assert.deepEqual(first.record.completedDates, ["2026-07-18"]);
      assert.equal(first.record.version, 2);

      const retry = await applyLifeMutation(client, ctx, toggleMutation);
      assert.deepEqual(retry, JSON.parse(JSON.stringify(first)));

      const row = await client.query("SELECT version FROM habits WHERE id = $1", [habitId]);
      assert.equal(row.rows[0].version, 2, "version must have incremented exactly once");
    });
  },
);

dbTest(
  "a *.create whose deterministic id (seriesId#seriesIndex) collides with an existing row returns " +
    "conflict/ID_TAKEN with the existing record and currentVersion -- the series-materialization " +
    "collision case, not a real error",
  async () => {
    await withRollback(async (client) => {
      const { householdId, userId } = await createHouseholdAndUser(client, "owner");
      const ctx = { householdId, userId };
      const occurrenceId = "series-1#0";

      const first = await applyLifeMutation(client, ctx, {
        idempotencyKey: randomUUID(),
        op: "task.create",
        payload: dbTaskPayload({
          id: occurrenceId,
          title: "Poniedziałkowy przegląd",
          seriesId: "series-1",
          seriesIndex: 0,
          recurrence: recurrencePayload(),
        }),
      });
      assert.equal(first.status, "applied");

      // A second device materializing the SAME logical occurrence computes the same id and
      // attempts to create it again (perhaps with slightly different local field values --
      // the point is the id collision, not the payload equality).
      const second = await applyLifeMutation(client, ctx, {
        idempotencyKey: randomUUID(),
        op: "task.create",
        payload: dbTaskPayload({
          id: occurrenceId,
          title: "Poniedziałkowy przegląd (inne urządzenie)",
          seriesId: "series-1",
          seriesIndex: 0,
          recurrence: recurrencePayload(),
        }),
      });
      assert.equal(second.status, "conflict");
      assert.equal(second.code, "ID_TAKEN");
      assert.equal(second.currentVersion, 1);
      assert.equal(second.record.id, occurrenceId);
      assert.equal(
        second.record.title,
        "Poniedziałkowy przegląd",
        "ID_TAKEN returns the EXISTING (server) record, not the caller's attempted payload",
      );

      const rows = await client.query("SELECT count(*)::int AS count FROM tasks WHERE id = $1", [
        occurrenceId,
      ]);
      assert.equal(rows.rows[0].count, 1, "the collision must not create a duplicate row");
    });
  },
);

dbTest(
  "ID_TAKEN also applies to event.create occurrences (the other recurring collection), and never " +
    "leaks another user's private occurrence as ID_TAKEN across a visibility boundary",
  async () => {
    await withRollback(async (client) => {
      const owner = await createHouseholdAndUser(client, "owner");
      const otherUserId = await addHouseholdMember(client, owner.householdId, "other");
      const occurrenceId = "series-evt#0";

      await applyLifeMutation(
        client,
        { householdId: owner.householdId, userId: owner.userId },
        {
          idempotencyKey: randomUUID(),
          op: "event.create",
          payload: dbEventPayload({
            id: occurrenceId,
            visibility: "private",
            seriesId: "series-evt",
            seriesIndex: 0,
            recurrence: recurrencePayload(),
          }),
        },
      );

      // Another household member's device, unaware of the owner's PRIVATE occurrence, tries to
      // materialize what it thinks is a fresh id. The unique-constraint violation still fires at
      // the DB level (id is a global PK, not scoped by visibility), but the conflict-diagnosis
      // query IS scoped -- since the existing row is private to the owner, it is invisible to
      // `otherUserId`, so this resolves to a plain `status:"error"`/`code:"ID_TAKEN"` (the id is
      // still reported as taken -- that much can't be hidden without breaking the invariant that
      // ids are globally unique -- but the *record itself* must never be exposed).
      const attempt = await applyLifeMutation(
        client,
        { householdId: owner.householdId, userId: otherUserId },
        {
          idempotencyKey: randomUUID(),
          op: "event.create",
          payload: dbEventPayload({
            id: occurrenceId,
            visibility: "household",
            seriesId: "series-evt",
            seriesIndex: 0,
            recurrence: recurrencePayload(),
          }),
        },
      );
      assert.equal(attempt.status, "error");
      assert.equal(attempt.code, "ID_TAKEN");
      assert.equal("record" in attempt, false, "no record leaked in the error response");

      // Meanwhile the OWNER's own retry of the exact same materialization on a second device
      // *does* see the row (same owner, private is visible to its own owner) -- a genuine
      // conflict, record included, exactly like the task.create case above.
      const ownerRetry = await applyLifeMutation(
        client,
        { householdId: owner.householdId, userId: owner.userId },
        {
          idempotencyKey: randomUUID(),
          op: "event.create",
          payload: dbEventPayload({
            id: occurrenceId,
            visibility: "private",
            seriesId: "series-evt",
            seriesIndex: 0,
            recurrence: recurrencePayload(),
          }),
        },
      );
      assert.equal(ownerRetry.status, "conflict");
      assert.equal(ownerRetry.code, "ID_TAKEN");
      assert.equal(ownerRetry.record.id, occurrenceId);
    });
  },
);

dbTest(
  "resetLifeForUser (Settings 'Wyczyść dane aplikacji') deletes shared + the caller's own private " +
    "records across all five tables, but never another member's private records",
  async () => {
    await withRollback(async (client) => {
      const owner = await createHouseholdAndUser(client, "owner");
      const otherUserId = await addHouseholdMember(client, owner.householdId, "other");
      const ctxOwner = { householdId: owner.householdId, userId: owner.userId };
      const ctxOther = { householdId: owner.householdId, userId: otherUserId };

      await applyLifeMutation(client, ctxOwner, {
        idempotencyKey: randomUUID(),
        op: "task.create",
        payload: dbTaskPayload({ title: "Wspólne zadanie", visibility: "household" }),
      });
      await applyLifeMutation(client, ctxOwner, {
        idempotencyKey: randomUUID(),
        op: "task.create",
        payload: dbTaskPayload({ title: "Prywatne zadanie właściciela", visibility: "private" }),
      });
      await applyLifeMutation(client, ctxOwner, {
        idempotencyKey: randomUUID(),
        op: "event.create",
        payload: dbEventPayload({ visibility: "private" }),
      });
      await applyLifeMutation(client, ctxOwner, {
        idempotencyKey: randomUUID(),
        op: "reminder.create",
        payload: dbReminderPayload({ visibility: "private" }),
      });
      await applyLifeMutation(client, ctxOwner, {
        idempotencyKey: randomUUID(),
        op: "note.create",
        payload: dbNotePayload({ title: "Prywatna notatka właściciela", visibility: "private" }),
      });
      await applyLifeMutation(client, ctxOwner, {
        idempotencyKey: randomUUID(),
        op: "habit.create",
        payload: dbHabitPayload({ name: "Prywatny nawyk właściciela", visibility: "private" }),
      });

      await applyLifeMutation(client, ctxOther, {
        idempotencyKey: randomUUID(),
        op: "task.create",
        payload: dbTaskPayload({ title: "Prywatne zadanie innego", visibility: "private" }),
      });
      await applyLifeMutation(client, ctxOther, {
        idempotencyKey: randomUUID(),
        op: "note.create",
        payload: dbNotePayload({ title: "Prywatna notatka innego", visibility: "private" }),
      });
      await applyLifeMutation(client, ctxOther, {
        idempotencyKey: randomUUID(),
        op: "habit.create",
        payload: dbHabitPayload({ name: "Prywatny nawyk innego", visibility: "private" }),
      });

      await resetLifeForUser(client, owner.householdId, owner.userId);

      const snapshotForOwner = await readLifeSnapshot(client, owner.householdId, owner.userId);
      assert.deepEqual(snapshotForOwner.tasks, []);
      assert.deepEqual(snapshotForOwner.events, []);
      assert.deepEqual(snapshotForOwner.reminders, []);
      assert.deepEqual(snapshotForOwner.notes, []);
      assert.deepEqual(snapshotForOwner.habits, []);

      const snapshotForOther = await readLifeSnapshot(client, owner.householdId, otherUserId);
      assert.deepEqual(
        snapshotForOther.tasks.map((task) => task.title),
        ["Prywatne zadanie innego"],
        "the other member's private task must survive the owner's reset",
      );
      assert.deepEqual(
        snapshotForOther.notes.map((note) => note.title),
        ["Prywatna notatka innego"],
        "the other member's private note must survive the owner's reset",
      );
      assert.deepEqual(
        snapshotForOther.habits.map((habit) => habit.name),
        ["Prywatny nawyk innego"],
        "the other member's private habit must survive the owner's reset",
      );
    });
  },
);

dbTest(
  "deletion is idempotent across all five entities: a second delete of an already-deleted record is " +
    "'applied', not an error",
  async () => {
    await withRollback(async (client) => {
      const { householdId, userId } = await createHouseholdAndUser(client, "owner");
      const ctx = { householdId, userId };

      const cases = [
        { op: "task.create", deleteOp: "task.delete", payload: dbTaskPayload() },
        { op: "event.create", deleteOp: "event.delete", payload: dbEventPayload() },
        { op: "reminder.create", deleteOp: "reminder.delete", payload: dbReminderPayload() },
        { op: "note.create", deleteOp: "note.delete", payload: dbNotePayload() },
        { op: "habit.create", deleteOp: "habit.delete", payload: dbHabitPayload() },
      ];

      for (const { op, deleteOp, payload } of cases) {
        await applyLifeMutation(client, ctx, {
          idempotencyKey: randomUUID(),
          op,
          payload,
        });
        const firstDelete = await applyLifeMutation(client, ctx, {
          idempotencyKey: randomUUID(),
          op: deleteOp,
          payload: { id: payload.id },
        });
        assert.equal(firstDelete.status, "applied");
        const secondDelete = await applyLifeMutation(client, ctx, {
          idempotencyKey: randomUUID(),
          op: deleteOp,
          payload: { id: payload.id },
        });
        assert.equal(secondDelete.status, "applied", `${deleteOp} second delete`);
        assert.equal(secondDelete.record, null);
      }

      // Deleting an id that never existed at all is likewise 'applied', not an error.
      const neverExisted = await applyLifeMutation(client, ctx, {
        idempotencyKey: randomUUID(),
        op: "task.delete",
        payload: { id: randomUUID() },
      });
      assert.equal(neverExisted.status, "applied");
      assert.equal(neverExisted.record, null);
    });
  },
);
