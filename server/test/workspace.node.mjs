import assert from "node:assert/strict";
import test from "node:test";
import { mergeWorkspaceData, splitWorkspaceData, workspaceDocumentIsValid } from "../src/workspace.mjs";

test("private advanced records and their children are stored per user", () => {
  const source = {
    schemaVersion: 2,
    life: { tasks: [], scratchpad: "sekret", preferences: { theme: "dark", notificationsEnabled: true } },
    advanced: {
      financeAccounts: [
        { id: "private-account", ownerId: "me", visibility: "private" },
        { id: "shared-account", ownerId: "me", visibility: "household" },
      ],
      financeTransactions: [
        { id: "private-tx", accountId: "private-account", ownerId: "me", visibility: "household" },
        { id: "shared-tx", accountId: "shared-account", ownerId: "me", visibility: "household" },
      ],
      hideAmounts: true,
      householdMembers: [{ id: "demo" }],
    },
  };

  const { sharedData, privateData } = splitWorkspaceData(source, "user-1");
  assert.deepEqual(sharedData.advanced.financeAccounts.map((item) => item.id), ["shared-account"]);
  assert.deepEqual(privateData.advanced.financeAccounts.map((item) => item.id), ["private-account"]);
  assert.deepEqual(privateData.advanced.financeTransactions.map((item) => item.id), ["private-tx"]);
  assert.equal(privateData.advanced.financeAccounts[0].ownerId, "user-1");
  assert.equal(sharedData.life.scratchpad, undefined);
  assert.equal(privateData.life.scratchpad, "sekret");
  assert.equal(privateData.life.preferences.notificationsEnabled, undefined);
});

test("private life records are split per user while legacy records stay shared", () => {
  const source = {
    schemaVersion: 2,
    life: {
      tasks: [
        { id: "private-task", ownerId: "me", visibility: "private", title: "Sekret" },
        { id: "shared-task", ownerId: "me", visibility: "household", title: "Zakupy" },
        { id: "legacy-task", title: "Stare zadanie" },
      ],
      events: [],
      reminders: [
        { id: "private-reminder", ownerId: "me", visibility: "private" },
      ],
      notes: [],
      habits: [],
    },
    advanced: {},
  };

  const { sharedData, privateData } = splitWorkspaceData(source, "user-1");
  assert.deepEqual(sharedData.life.tasks.map((item) => item.id), ["shared-task", "legacy-task"]);
  assert.deepEqual(privateData.life.tasks.map((item) => item.id), ["private-task"]);
  assert.equal(privateData.life.tasks[0].ownerId, "user-1");
  assert.equal(sharedData.life.tasks[1].ownerId, undefined, "legacy record without ownerId is left untouched, not attributed to anyone");
  assert.deepEqual(privateData.life.reminders.map((item) => item.id), ["private-reminder"]);
  assert.deepEqual(sharedData.life.reminders, []);
});

test("merge combines shared and private life collections and enforces ownerId from session", () => {
  const merged = mergeWorkspaceData(
    {
      life: {
        tasks: [
          { id: "shared-task", visibility: "household", title: "Zakupy" },
          { id: "legacy-task", title: "Stare zadanie" },
        ],
      },
    },
    {
      life: {
        tasks: [
          { id: "private-task", ownerId: "someone-else", visibility: "private", title: "Sekret" },
        ],
      },
    },
    { userId: "user-2", userName: "Ola", householdName: "Dom", members: [] },
  );
  assert.deepEqual(merged.life.tasks.map((item) => item.id), ["shared-task", "legacy-task", "private-task"]);
  const privateTask = merged.life.tasks.find((item) => item.id === "private-task");
  assert.equal(privateTask.ownerId, "user-2", "server must assign ownerId from session, never trust the client value");
  const legacyTask = merged.life.tasks.find((item) => item.id === "legacy-task");
  assert.equal(legacyTask.ownerId, undefined, "legacy shared record is not retroactively attributed to anyone");
});

test("merge exposes only the current user's private state and real members", () => {
  const merged = mergeWorkspaceData(
    { advanced: { subscriptions: [{ id: "shared", visibility: "household" }] }, life: { tasks: [] } },
    { advanced: { subscriptions: [{ id: "mine", ownerId: "wrong", visibility: "private" }], hideAmounts: true }, life: { intention: "spokojnie", preferences: { name: "" } } },
    { userId: "user-2", userName: "Ola", householdName: "Dom", members: [{ id: "user-2", name: "Ola", email: "o@example.com", role: "owner" }] },
  );
  assert.deepEqual(merged.advanced.subscriptions.map((item) => item.id), ["shared", "mine"]);
  assert.equal(merged.advanced.subscriptions[1].ownerId, "user-2");
  assert.equal(merged.advanced.householdMembers[0].name, "Ola");
  assert.equal(merged.life.preferences.name, "Ola");
  assert.equal(merged.life.intention, "spokojnie");
});

test("an empty server workspace stays empty for first-run migration", () => {
  const merged = mergeWorkspaceData({}, undefined, {
    userId: "user-1", userName: "Ola", householdName: "Dom", members: [],
  });
  assert.deepEqual(merged, {});
});

test("server rejects malformed workspace documents", () => {
  assert.equal(workspaceDocumentIsValid({}), false);
  assert.equal(workspaceDocumentIsValid({ schemaVersion: 2, life: { tasks: [] }, advanced: {} }), false);
  const collections = [
    "financeAccounts", "financeTransactions", "financeBudgets", "savingsGoals", "trips", "tripItinerary",
    "tripBookings", "packingItems", "subscriptions", "recipes", "mealSlots", "shoppingItems", "vehicles",
    "carExpenses", "vehicleDeadlines", "healthAppointments", "medications", "healthMeasurements", "householdMembers",
    "pets", "petExpenses", "petVisits",
  ];
  assert.equal(workspaceDocumentIsValid({
    schemaVersion: 2,
    life: { tasks: [], events: [], reminders: [], notes: [], habits: [], preferences: {} },
    advanced: { ...Object.fromEntries(collections.map((key) => [key, []])), householdName: "Dom" },
  }), true);
});
