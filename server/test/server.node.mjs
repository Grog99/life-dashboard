import assert from "node:assert/strict";
import test from "node:test";
import { assertRemovableMember } from "../src/householdMembers.mjs";

test("removing yourself is rejected regardless of role", () => {
  assert.throws(
    () =>
      assertRemovableMember({
        targetUserId: "user-1",
        targetRole: "member",
        sessionUserId: "user-1",
      }),
    (error) => error.statusCode === 400 && error.code === "CANNOT_REMOVE_SELF",
  );
});

test("removing a non-member is rejected", () => {
  assert.throws(
    () =>
      assertRemovableMember({ targetUserId: "user-2", targetRole: null, sessionUserId: "user-1" }),
    (error) => error.statusCode === 404 && error.code === "MEMBER_NOT_FOUND",
  );
});

test("removing the owner is rejected", () => {
  assert.throws(
    () =>
      assertRemovableMember({
        targetUserId: "user-2",
        targetRole: "owner",
        sessionUserId: "user-1",
      }),
    (error) => error.statusCode === 403 && error.code === "CANNOT_REMOVE_OWNER",
  );
});

test("removing a member or admin who is not the caller is allowed", () => {
  assert.doesNotThrow(() =>
    assertRemovableMember({
      targetUserId: "user-2",
      targetRole: "member",
      sessionUserId: "user-1",
    }),
  );
  assert.doesNotThrow(() =>
    assertRemovableMember({ targetUserId: "user-3", targetRole: "admin", sessionUserId: "user-1" }),
  );
});
