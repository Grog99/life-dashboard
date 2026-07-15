function memberError(statusCode, message, code) {
  const error = new Error(message);
  error.statusCode = statusCode;
  error.code = code;
  return error;
}

/**
 * Pure validation for removing a household member. Throws an httpError-shaped
 * Error (statusCode + code) for every disallowed case; returns nothing when the
 * removal is allowed to proceed. Contains no I/O so it can be unit tested
 * without a database or Fastify instance.
 */
export function assertRemovableMember({ targetUserId, targetRole, sessionUserId }) {
  if (targetUserId === sessionUserId) {
    throw memberError(400, "Nie możesz usunąć samego siebie z gospodarstwa", "CANNOT_REMOVE_SELF");
  }
  if (targetRole == null) {
    throw memberError(404, "Ten użytkownik nie należy do gospodarstwa", "MEMBER_NOT_FOUND");
  }
  if (targetRole === "owner") {
    throw memberError(403, "Nie można usunąć właściciela gospodarstwa", "CANNOT_REMOVE_OWNER");
  }
}
