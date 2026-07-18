import assert from "node:assert/strict";
import test from "node:test";
import {
  mergeWorkspaceData,
  splitWorkspaceData,
  workspaceDocumentIsValid,
} from "../src/workspace.mjs";

test("private life preferences and advanced hideAmounts are stored per user", () => {
  // Subscriptions (and every other former META_COLLECTIONS entry: car, pets, health) now live in
  // their own normalized SQL tables (server/src/subscriptions.mjs et al.) and are never part of
  // the workspace JSONB document anymore, so the private/shared split for a META_COLLECTIONS-style
  // advanced record is no longer exercised through this document -- see the META_COLLECTIONS
  // comment at the top of server/src/workspace.mjs. This test now covers only what still flows
  // through splitWorkspaceData: private life fields (scratchpad, preferences) and the advanced
  // hideAmounts flag.
  const source = {
    schemaVersion: 2,
    life: {
      tasks: [],
      scratchpad: "sekret",
      preferences: { theme: "dark", notificationsEnabled: true },
    },
    advanced: {
      hideAmounts: true,
      householdMembers: [{ id: "demo" }],
    },
  };

  const { sharedData, privateData } = splitWorkspaceData(source, "user-1");
  assert.equal(sharedData.life.scratchpad, undefined);
  assert.equal(privateData.life.scratchpad, "sekret");
  assert.equal(privateData.life.preferences.notificationsEnabled, undefined);
  assert.equal(privateData.advanced.hideAmounts, true);
  assert.equal(sharedData.advanced.hideAmounts, undefined);
});

// The two tests that used to live here ("private life records are split per user while legacy
// records stay shared" / "merge combines shared and private life collections and enforces ownerId
// from session") exercised LIFE_COLLECTIONS splitting/merging for tasks/events/reminders/notes/
// habits. Life was the last module carrying entries in LIFE_COLLECTIONS -- it is now `[]`
// (server/migrations/013_life_normalized.sql, docs/plans/zadania-kalendarz-notatki-nawyki-sql.md)
// and splitWorkspaceData/mergeWorkspaceData no longer split or merge those fields at all (any
// `life.tasks`/etc a legacy client still sends passes straight from shared input to shared output,
// unfiltered -- there is no longer a per-user notion for it in this document). Same precedent as
// the subscriptions-specific assertions dropped from "private life preferences and advanced
// hideAmounts are stored per user" above when subscriptions left META_COLLECTIONS.
test("workspace document no longer splits or merges life collections (moved to /api/v1/life)", () => {
  const source = {
    schemaVersion: 2,
    life: {
      tasks: [
        { id: "private-task", ownerId: "me", visibility: "private", title: "Sekret" },
        { id: "shared-task", ownerId: "me", visibility: "household", title: "Zakupy" },
      ],
    },
    advanced: {},
  };
  const { sharedData, privateData } = splitWorkspaceData(source, "user-1");
  assert.deepEqual(
    sharedData.life.tasks.map((item) => item.id),
    ["private-task", "shared-task"],
    "unfiltered pass-through -- splitWorkspaceData no longer knows about task visibility",
  );
  assert.equal(privateData.life.tasks, undefined);

  const merged = mergeWorkspaceData(
    { life: { tasks: [{ id: "shared-task", visibility: "household" }] } },
    { life: { tasks: [{ id: "private-task", visibility: "private" }] } },
    { userId: "user-2", userName: "Ola", householdName: "Dom", members: [] },
  );
  assert.deepEqual(
    merged.life.tasks.map((item) => item.id),
    ["shared-task"],
    "mergeWorkspaceData only carries the shared side through -- private input is ignored",
  );
});

test("merge exposes only the current user's private state and real members", () => {
  const merged = mergeWorkspaceData(
    {
      advanced: { subscriptions: [{ id: "shared", visibility: "household" }] },
      life: { tasks: [] },
    },
    {
      advanced: {
        subscriptions: [{ id: "mine", ownerId: "wrong", visibility: "private" }],
        hideAmounts: true,
      },
      life: { intention: "spokojnie", preferences: { name: "" } },
    },
    {
      userId: "user-2",
      userName: "Ola",
      householdName: "Dom",
      members: [{ id: "user-2", name: "Ola", email: "o@example.com", role: "owner" }],
    },
  );
  assert.deepEqual(
    merged.advanced.subscriptions.map((item) => item.id),
    ["shared", "mine"],
  );
  assert.equal(merged.advanced.subscriptions[1].ownerId, "user-2");
  assert.equal(merged.advanced.householdMembers[0].name, "Ola");
  assert.equal(merged.life.preferences.name, "Ola");
  assert.equal(merged.life.intention, "spokojnie");
});

test("an empty server workspace stays empty for first-run migration", () => {
  const merged = mergeWorkspaceData({}, undefined, {
    userId: "user-1",
    userName: "Ola",
    householdName: "Dom",
    members: [],
  });
  assert.deepEqual(merged, {});
});

test("server rejects malformed workspace documents", () => {
  assert.equal(workspaceDocumentIsValid({}), false);
  assert.equal(
    workspaceDocumentIsValid({ schemaVersion: 2, life: { tasks: [] }, advanced: {} }),
    false,
  );
  const collections = [
    "subscriptions",
    "vehicles",
    "carExpenses",
    "vehicleDeadlines",
    "healthAppointments",
    "medications",
    "healthMeasurements",
    "householdMembers",
    "pets",
    "petExpenses",
    "petVisits",
  ];
  assert.equal(
    workspaceDocumentIsValid({
      schemaVersion: 2,
      life: { tasks: [], events: [], reminders: [], notes: [], habits: [], preferences: {} },
      advanced: {
        ...Object.fromEntries(collections.map((key) => [key, []])),
        householdName: "Dom",
      },
    }),
    true,
  );
});
