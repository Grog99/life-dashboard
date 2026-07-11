export function validateConfiguration({
  appOrigin,
  production,
  sessionDays,
  maxWorkspaceBytes,
  bootstrapToken,
  tokenEncryptionKey,
  googleClientId,
  googleClientSecret,
  googleRedirectUri,
}) {
  let origin;
  try {
    origin = new URL(appOrigin);
  } catch {
    throw new Error("APP_ORIGIN must be an absolute URL");
  }

  if (origin.origin !== appOrigin) throw new Error("APP_ORIGIN must not contain a path, query, or fragment");
  if (production && origin.protocol !== "https:") throw new Error("APP_ORIGIN must use HTTPS in production");
  if (!Number.isFinite(sessionDays) || sessionDays < 1 || sessionDays > 365) {
    throw new Error("SESSION_DAYS must be between 1 and 365");
  }
  if (!Number.isFinite(maxWorkspaceBytes) || maxWorkspaceBytes < 100_000 || maxWorkspaceBytes > 50_000_000) {
    throw new Error("MAX_WORKSPACE_BYTES is outside the safe range");
  }
  if (String(bootstrapToken ?? "").length < 24) {
    throw new Error("BOOTSTRAP_TOKEN must contain at least 24 characters");
  }
  if (tokenEncryptionKey && Buffer.from(tokenEncryptionKey, "base64").length !== 32) {
    throw new Error("TOKEN_ENCRYPTION_KEY must be 32 bytes encoded as base64");
  }

  const hasGoogleId = Boolean(googleClientId);
  const hasGoogleSecret = Boolean(googleClientSecret);
  if (hasGoogleId || hasGoogleSecret) {
    if (!hasGoogleId || !hasGoogleSecret || !googleRedirectUri) {
      throw new Error("Google OAuth configuration is incomplete");
    }
    let redirect;
    try {
      redirect = new URL(googleRedirectUri);
    } catch {
      throw new Error("GOOGLE_REDIRECT_URI must be an absolute URL");
    }
    if (redirect.origin !== origin.origin) throw new Error("GOOGLE_REDIRECT_URI must use APP_ORIGIN");
  }
}
