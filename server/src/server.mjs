import Fastify from "fastify";
import cookie from "@fastify/cookie";
import fastifyStatic from "@fastify/static";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { pool, query, transaction } from "./db.mjs";
import { validateConfiguration } from "./config.mjs";
import { mergeWorkspaceData, splitWorkspaceData, workspaceDocumentIsValid } from "./workspace.mjs";
import { assertRemovableMember } from "./householdMembers.mjs";
import {
  applyFinanceMutation,
  assertFinanceMutationShape,
  MAX_FINANCE_MUTATIONS_BYTES,
  MAX_FINANCE_MUTATIONS_PER_BATCH,
  readFinanceSnapshot,
  resetFinanceForUser,
} from "./finance.mjs";
import {
  applyTripMutation,
  assertTripMutationShape,
  MAX_TRIP_MUTATIONS_BYTES,
  MAX_TRIP_MUTATIONS_PER_BATCH,
  readTripsSnapshot,
  resetTripsForHousehold,
} from "./trips.mjs";
import {
  applyMealMutation,
  assertMealMutationShape,
  MAX_MEAL_MUTATIONS_BYTES,
  MAX_MEAL_MUTATIONS_PER_BATCH,
  readMealsSnapshot,
  resetMealsForHousehold,
} from "./meals.mjs";
import {
  decryptSecret,
  encryptSecret,
  hashPassword,
  hashToken,
  isEmail,
  normalizeEmail,
  randomToken,
  safeSameOriginPath,
  timingSafeString,
  verifyPassword,
} from "./security.mjs";

const appOrigin = (process.env.APP_ORIGIN ?? "http://localhost:8080").replace(/\/$/, "");
const production = process.env.NODE_ENV === "production";
const secureCookie = process.env.COOKIE_SECURE ? process.env.COOKIE_SECURE === "true" : production;
const cookieName = secureCookie ? "__Host-puls_session" : "puls_session";
const sessionDays = Number(process.env.SESSION_DAYS ?? 30);
const maxWorkspaceBytes = Number(process.env.MAX_WORKSPACE_BYTES ?? 5_000_000);
const loginAttempts = new Map();
const loginAttemptsByAccount = new Map();
let activePasswordOperations = 0;
const DUMMY_PASSWORD_HASH = await hashPassword("puls-timing-safety-placeholder");

validateConfiguration({
  appOrigin,
  production,
  sessionDays,
  maxWorkspaceBytes,
  bootstrapToken: process.env.BOOTSTRAP_TOKEN,
  tokenEncryptionKey: process.env.TOKEN_ENCRYPTION_KEY,
  googleClientId: process.env.GOOGLE_CLIENT_ID,
  googleClientSecret: process.env.GOOGLE_CLIENT_SECRET,
  googleRedirectUri: process.env.GOOGLE_REDIRECT_URI,
});

const app = Fastify({
  logger: {
    level: process.env.LOG_LEVEL ?? "info",
    redact: [
      "req.headers.cookie",
      "req.headers.authorization",
      "body.password",
      "body.bootstrapToken",
      "body.inviteToken",
    ],
  },
  trustProxy: process.env.TRUST_PROXY === "1" ? 1 : false,
  bodyLimit: maxWorkspaceBytes + 100_000,
});

await app.register(cookie);

function httpError(statusCode, message, code = "REQUEST_ERROR") {
  const error = new Error(message);
  error.statusCode = statusCode;
  error.code = code;
  return error;
}

app.setErrorHandler((error, request, reply) => {
  const uniqueViolation = error.code === "23505";
  const statusCode = uniqueViolation
    ? 409
    : error.statusCode && error.statusCode < 600
      ? error.statusCode
      : 500;
  if (statusCode >= 500) request.log.error(error);
  reply.status(statusCode).send({
    error: uniqueViolation
      ? "Taki rekord już istnieje"
      : statusCode >= 500
        ? "Wewnętrzny błąd serwera"
        : error.message,
    code: uniqueViolation ? "CONFLICT" : (error.code ?? "INTERNAL_ERROR"),
  });
});

app.addHook("onRequest", async (request) => {
  if (["POST", "PUT", "PATCH", "DELETE"].includes(request.method)) {
    const origin = request.headers.origin;
    if (origin && origin.replace(/\/$/, "") !== appOrigin) {
      throw httpError(403, "Nieprawidłowe źródło żądania", "ORIGIN_MISMATCH");
    }
    if (
      !origin &&
      request.headers["sec-fetch-site"] &&
      request.headers["sec-fetch-site"] !== "same-origin"
    ) {
      throw httpError(403, "Żądanie spoza aplikacji zostało odrzucone", "ORIGIN_REQUIRED");
    }
  }
});

app.addHook("onSend", async (_request, reply, payload) => {
  reply.header("X-Content-Type-Options", "nosniff");
  reply.header("X-Frame-Options", "DENY");
  reply.header("Referrer-Policy", "strict-origin-when-cross-origin");
  reply.header("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  reply.header(
    "Content-Security-Policy",
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; font-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'; form-action 'self'",
  );
  if (production && secureCookie) {
    reply.header("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
  }
  return payload;
});

async function getSession(request) {
  const token = request.cookies[cookieName];
  if (!token) return null;
  const result = await query(
    `SELECT s.id AS session_id, s.user_id, s.household_id, s.expires_at, s.last_seen_at,
            u.email, u.display_name, u.locale, u.timezone,
            hm.role, h.name AS household_name, h.currency AS household_currency
       FROM sessions s
       JOIN users u ON u.id = s.user_id AND u.disabled_at IS NULL
  LEFT JOIN households h ON h.id = s.household_id
  LEFT JOIN household_members hm ON hm.household_id = s.household_id AND hm.user_id = s.user_id
      WHERE s.token_hash = $1 AND s.expires_at > now()`,
    [hashToken(token)],
  );
  if (!result.rowCount) return null;
  const session = result.rows[0];
  if (Date.now() - new Date(session.last_seen_at ?? 0).getTime() > 15 * 60_000) {
    void query("UPDATE sessions SET last_seen_at = now() WHERE id = $1", [
      session.session_id,
    ]).catch((error) => request.log.warn({ error }, "Could not refresh session activity"));
  }
  return session;
}

async function requireSession(request) {
  const session = await getSession(request);
  if (!session) throw httpError(401, "Zaloguj się ponownie", "UNAUTHENTICATED");
  return session;
}

async function requireHousehold(request, roles = ["owner", "admin", "member"]) {
  const session = await requireSession(request);
  if (!session.household_id || !roles.includes(session.role)) {
    throw httpError(403, "Brak dostępu do gospodarstwa domowego", "FORBIDDEN");
  }
  return session;
}

function setSessionCookie(reply, token) {
  reply.setCookie(cookieName, token, {
    path: "/",
    httpOnly: true,
    secure: secureCookie,
    sameSite: "lax",
    maxAge: sessionDays * 24 * 60 * 60,
  });
}

async function createSession(client, request, reply, userId, householdId) {
  const token = randomToken();
  await client.query(
    `INSERT INTO sessions(token_hash, user_id, household_id, user_agent, ip_address, expires_at)
     VALUES ($1, $2, $3, $4, $5, now() + ($6 || ' days')::interval)`,
    [
      hashToken(token),
      userId,
      householdId,
      String(request.headers["user-agent"] ?? "").slice(0, 500),
      request.ip,
      String(sessionDays),
    ],
  );
  setSessionCookie(reply, token);
}

function checkRateLimit(map, key, limit) {
  const now = Date.now();
  const current = map.get(key);
  if (!current || current.resetAt < now) {
    if (map.size >= 5_000) {
      for (const [existingKey, entry] of map) if (entry.resetAt < now) map.delete(existingKey);
      if (map.size >= 5_000 && !map.has(key)) {
        throw httpError(
          429,
          "Serwer otrzymał zbyt wiele prób logowania. Spróbuj ponownie później",
          "RATE_LIMITED",
        );
      }
    }
    map.set(key, { count: 1, resetAt: now + 15 * 60_000 });
    return;
  }
  current.count += 1;
  if (current.count > limit)
    throw httpError(429, "Zbyt wiele prób. Spróbuj ponownie później", "RATE_LIMITED");
}

function assertLoginRate(request, email) {
  checkRateLimit(loginAttempts, request.ip, 12);
  if (email) checkRateLimit(loginAttemptsByAccount, email, 12);
}

function publicUser(row) {
  return {
    id: row.user_id,
    email: row.email,
    name: row.display_name,
    locale: row.locale,
    timezone: row.timezone,
  };
}

async function validatedPasswordHash(password) {
  if (typeof password !== "string" || password.length < 8 || password.length > 256) {
    throw httpError(400, "Hasło musi mieć od 8 do 256 znaków", "PASSWORD_POLICY");
  }
  return passwordOperation(() => hashPassword(password));
}

async function passwordOperation(operation) {
  if (activePasswordOperations >= 4) {
    throw httpError(429, "Serwer weryfikuje już kilka logowań. Spróbuj za chwilę", "AUTH_BUSY");
  }
  activePasswordOperations += 1;
  try {
    return await operation();
  } finally {
    activePasswordOperations -= 1;
  }
}

async function audit(client, session, action, entityType, entityId, metadata = {}) {
  await client.query(
    `INSERT INTO audit_events(household_id, actor_id, action, entity_type, entity_id, metadata)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [
      session?.household_id ?? null,
      session?.user_id ?? null,
      action,
      entityType,
      entityId,
      metadata,
    ],
  );
}

app.get("/health/live", async () => ({ status: "ok" }));
app.get("/health/ready", async () => {
  await query("SELECT 1");
  return { status: "ready" };
});

app.get("/api/v1/auth/bootstrap-status", async () => {
  const result = await query("SELECT EXISTS(SELECT 1 FROM users) AS configured");
  return { configured: result.rows[0].configured };
});

app.post("/api/v1/auth/bootstrap", async (request, reply) => {
  assertLoginRate(request);
  const body = request.body ?? {};
  const configuredToken = process.env.BOOTSTRAP_TOKEN;
  if (
    !configuredToken ||
    !body.bootstrapToken ||
    !timingSafeString(body.bootstrapToken, configuredToken)
  ) {
    throw httpError(403, "Nieprawidłowy token startowy", "INVALID_BOOTSTRAP_TOKEN");
  }
  const email = normalizeEmail(body.email);
  const name = String(body.name ?? "").trim();
  const householdName = String(body.householdName ?? "Nasz dom").trim();
  if (!isEmail(email) || name.length < 2 || householdName.length < 2) {
    throw httpError(400, "Uzupełnij prawidłowe dane", "INVALID_INPUT");
  }
  const passwordHash = await validatedPasswordHash(body.password);
  return transaction(async (client) => {
    await client.query("SELECT pg_advisory_xact_lock(hashtext('puls-bootstrap'))");
    const configured = await client.query("SELECT EXISTS(SELECT 1 FROM users) AS configured");
    if (configured.rows[0].configured)
      throw httpError(409, "Puls został już skonfigurowany", "ALREADY_BOOTSTRAPPED");
    const user = await client.query(
      "INSERT INTO users(email, display_name, password_hash) VALUES ($1, $2, $3) RETURNING id",
      [email, name, passwordHash],
    );
    const household = await client.query(
      "INSERT INTO households(name, created_by) VALUES ($1, $2) RETURNING id",
      [householdName, user.rows[0].id],
    );
    await client.query(
      "INSERT INTO household_members(household_id, user_id, role) VALUES ($1, $2, 'owner')",
      [household.rows[0].id, user.rows[0].id],
    );
    await client.query("INSERT INTO workspace_states(household_id) VALUES ($1)", [
      household.rows[0].id,
    ]);
    await createSession(client, request, reply, user.rows[0].id, household.rows[0].id);
    await audit(
      client,
      { user_id: user.rows[0].id, household_id: household.rows[0].id },
      "bootstrap",
      "household",
      household.rows[0].id,
    );
    reply.status(201);
    return { ok: true };
  });
});

app.post("/api/v1/auth/login", async (request, reply) => {
  const body = request.body ?? {};
  const email = normalizeEmail(body.email);
  assertLoginRate(request, email);
  const result = await query(
    `SELECT u.id, u.password_hash,
            (SELECT hm.household_id FROM household_members hm WHERE hm.user_id = u.id ORDER BY hm.joined_at LIMIT 1) AS household_id
       FROM users u WHERE u.email = $1 AND u.disabled_at IS NULL`,
    [email],
  );
  const valid = await passwordOperation(() =>
    verifyPassword(
      String(body.password ?? ""),
      result.rowCount ? result.rows[0].password_hash : DUMMY_PASSWORD_HASH,
    ),
  );
  if (!result.rowCount || !valid)
    throw httpError(401, "Nieprawidłowy e-mail lub hasło", "INVALID_CREDENTIALS");
  loginAttempts.delete(request.ip);
  loginAttemptsByAccount.delete(email);
  await transaction(async (client) => {
    await createSession(client, request, reply, result.rows[0].id, result.rows[0].household_id);
    await audit(
      client,
      { user_id: result.rows[0].id, household_id: result.rows[0].household_id },
      "login",
      "session",
      null,
    );
  });
  return { ok: true };
});

app.post("/api/v1/auth/register", async (request, reply) => {
  const body = request.body ?? {};
  const email = normalizeEmail(body.email);
  assertLoginRate(request, email);
  const inviteHash = hashToken(String(body.inviteToken ?? ""));
  const name = String(body.name ?? "").trim();
  if (!isEmail(email) || name.length < 2)
    throw httpError(400, "Uzupełnij prawidłowe dane", "INVALID_INPUT");
  const invitePreview = await query(
    `SELECT invited_email FROM household_invitations
      WHERE token_hash = $1 AND accepted_at IS NULL AND expires_at > now()`,
    [inviteHash],
  );
  if (!invitePreview.rowCount)
    throw httpError(400, "Zaproszenie wygasło lub jest nieprawidłowe", "INVALID_INVITE");
  if (
    invitePreview.rows[0].invited_email &&
    normalizeEmail(invitePreview.rows[0].invited_email) !== email
  ) {
    throw httpError(403, "Zaproszenie jest przypisane do innego adresu", "INVITE_EMAIL_MISMATCH");
  }
  const passwordHash = await validatedPasswordHash(body.password);
  await transaction(async (client) => {
    const inviteResult = await client.query(
      `SELECT * FROM household_invitations
        WHERE token_hash = $1 AND accepted_at IS NULL AND expires_at > now()
        FOR UPDATE`,
      [inviteHash],
    );
    if (!inviteResult.rowCount)
      throw httpError(400, "Zaproszenie wygasło lub jest nieprawidłowe", "INVALID_INVITE");
    const invite = inviteResult.rows[0];
    if (invite.invited_email && normalizeEmail(invite.invited_email) !== email) {
      throw httpError(403, "Zaproszenie jest przypisane do innego adresu", "INVITE_EMAIL_MISMATCH");
    }
    const user = await client.query(
      "INSERT INTO users(email, display_name, password_hash) VALUES ($1, $2, $3) RETURNING id",
      [email, name, passwordHash],
    );
    await client.query(
      "INSERT INTO household_members(household_id, user_id, role) VALUES ($1, $2, $3)",
      [invite.household_id, user.rows[0].id, invite.role],
    );
    await client.query(
      "UPDATE household_invitations SET accepted_by = $1, accepted_at = now() WHERE id = $2",
      [user.rows[0].id, invite.id],
    );
    await createSession(client, request, reply, user.rows[0].id, invite.household_id);
    await audit(
      client,
      { user_id: user.rows[0].id, household_id: invite.household_id },
      "invite.accept",
      "invitation",
      invite.id,
    );
  });
  loginAttempts.delete(request.ip);
  loginAttemptsByAccount.delete(email);
  reply.status(201);
  return { ok: true };
});

app.post("/api/v1/auth/logout", async (request, reply) => {
  const token = request.cookies[cookieName];
  if (token) await query("DELETE FROM sessions WHERE token_hash = $1", [hashToken(token)]);
  reply.clearCookie(cookieName, { path: "/", secure: secureCookie, sameSite: "lax" });
  return { ok: true };
});

app.get("/api/v1/auth/me", async (request) => {
  const session = await requireSession(request);
  const households = await query(
    `SELECT h.id, h.name, h.currency, h.timezone, hm.role
       FROM household_members hm JOIN households h ON h.id = hm.household_id
      WHERE hm.user_id = $1 ORDER BY hm.joined_at`,
    [session.user_id],
  );
  return {
    user: publicUser(session),
    activeHouseholdId: session.household_id,
    households: households.rows,
  };
});

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function assertUuidParam(value) {
  if (typeof value !== "string" || !uuidPattern.test(value)) {
    throw httpError(400, "Nieprawidłowy identyfikator", "INVALID_ID");
  }
}

app.post("/api/v1/households/:id/select", async (request) => {
  const session = await requireSession(request);
  assertUuidParam(request.params.id);
  const membership = await query(
    "SELECT 1 FROM household_members WHERE household_id = $1 AND user_id = $2",
    [request.params.id, session.user_id],
  );
  if (!membership.rowCount) throw httpError(403, "Brak dostępu", "FORBIDDEN");
  await query("UPDATE sessions SET household_id = $1 WHERE id = $2", [
    request.params.id,
    session.session_id,
  ]);
  return { ok: true };
});

app.post("/api/v1/households/invitations/accept", async (request) => {
  const session = await requireSession(request);
  const inviteHash = hashToken(String(request.body?.inviteToken ?? ""));
  const householdId = await transaction(async (client) => {
    const result = await client.query(
      `SELECT * FROM household_invitations
        WHERE token_hash = $1 AND expires_at > now()
          AND (accepted_at IS NULL OR accepted_by = $2)
        FOR UPDATE`,
      [inviteHash, session.user_id],
    );
    if (!result.rowCount)
      throw httpError(400, "Zaproszenie wygasło lub jest nieprawidłowe", "INVALID_INVITE");
    const invite = result.rows[0];
    if (
      invite.invited_email &&
      normalizeEmail(invite.invited_email) !== normalizeEmail(session.email)
    ) {
      throw httpError(403, "Zaproszenie jest przypisane do innego adresu", "INVITE_EMAIL_MISMATCH");
    }
    await client.query(
      `INSERT INTO household_members(household_id, user_id, role) VALUES ($1, $2, $3)
       ON CONFLICT (household_id, user_id) DO NOTHING`,
      [invite.household_id, session.user_id, invite.role],
    );
    await client.query(
      "UPDATE household_invitations SET accepted_by = $1, accepted_at = now() WHERE id = $2",
      [session.user_id, invite.id],
    );
    await client.query("UPDATE sessions SET household_id = $1 WHERE id = $2", [
      invite.household_id,
      session.session_id,
    ]);
    await audit(
      client,
      { ...session, household_id: invite.household_id },
      "invite.accept",
      "invitation",
      invite.id,
    );
    return invite.household_id;
  });
  return { ok: true, householdId };
});

app.get("/api/v1/households/current/members", async (request) => {
  const session = await requireHousehold(request);
  const members = await query(
    `SELECT u.id, u.email, u.display_name AS name, hm.role, hm.joined_at
       FROM household_members hm JOIN users u ON u.id = hm.user_id
      WHERE hm.household_id = $1 ORDER BY hm.joined_at`,
    [session.household_id],
  );
  return { members: members.rows };
});

app.post("/api/v1/households/current/invitations", async (request) => {
  const session = await requireHousehold(request, ["owner"]);
  const body = request.body ?? {};
  const role = body.role === "admin" ? "admin" : "member";
  const email = body.email ? normalizeEmail(body.email) : null;
  if (email && !isEmail(email)) throw httpError(400, "Nieprawidłowy adres e-mail", "INVALID_INPUT");
  const token = randomToken();
  const result = await query(
    `INSERT INTO household_invitations(household_id, token_hash, invited_email, role, created_by, expires_at)
     VALUES ($1, $2, $3, $4, $5, now() + interval '7 days') RETURNING id, expires_at`,
    [session.household_id, hashToken(token), email, role, session.user_id],
  );
  await audit(pool, session, "invite.create", "invitation", result.rows[0].id, {
    role,
    hasEmail: Boolean(email),
  });
  return {
    token,
    inviteUrl: `${appOrigin}/?invite=${encodeURIComponent(token)}`,
    expiresAt: result.rows[0].expires_at,
  };
});

app.delete("/api/v1/households/current/members/:userId", async (request) => {
  const session = await requireHousehold(request, ["owner"]);
  const targetUserId = request.params.userId;
  assertUuidParam(targetUserId);
  await transaction(async (client) => {
    const target = await client.query(
      "SELECT role FROM household_members WHERE household_id = $1 AND user_id = $2 FOR UPDATE",
      [session.household_id, targetUserId],
    );
    const targetRole = target.rows[0]?.role ?? null;
    assertRemovableMember({ targetUserId, targetRole, sessionUserId: session.user_id });
    await client.query("DELETE FROM household_members WHERE household_id = $1 AND user_id = $2", [
      session.household_id,
      targetUserId,
    ]);
    await client.query(
      "DELETE FROM user_workspace_states WHERE household_id = $1 AND user_id = $2",
      [session.household_id, targetUserId],
    );
    await audit(client, session, "member.remove", "user", targetUserId, {
      role: targetRole,
      householdId: session.household_id,
    });
  });
  return { ok: true };
});

app.get("/api/v1/workspace", async (request) => {
  const session = await requireHousehold(request);
  const [sharedResult, privateResult, membersResult] = await Promise.all([
    query("SELECT revision, data, updated_at FROM workspace_states WHERE household_id = $1", [
      session.household_id,
    ]),
    query("SELECT data FROM user_workspace_states WHERE household_id = $1 AND user_id = $2", [
      session.household_id,
      session.user_id,
    ]),
    query(
      `SELECT u.id, u.email, u.display_name AS name, hm.role
         FROM household_members hm JOIN users u ON u.id = hm.user_id
        WHERE hm.household_id = $1 ORDER BY hm.joined_at`,
      [session.household_id],
    ),
  ]);
  const shared = sharedResult.rows[0] ?? { revision: 0, data: {}, updated_at: null };
  return {
    revision: Number(shared.revision),
    data: mergeWorkspaceData(shared.data, privateResult.rows[0]?.data, {
      userId: session.user_id,
      userName: session.display_name,
      householdName: session.household_name,
      members: membersResult.rows,
    }),
    updated_at: shared.updated_at,
  };
});

app.put("/api/v1/workspace", async (request, reply) => {
  const session = await requireHousehold(request);
  const body = request.body ?? {};
  const expectedRevision = Number(body.revision);
  if (
    !Number.isSafeInteger(expectedRevision) ||
    !body.data ||
    typeof body.data !== "object" ||
    Array.isArray(body.data)
  ) {
    throw httpError(400, "Nieprawidłowy dokument danych", "INVALID_WORKSPACE");
  }
  if (!workspaceDocumentIsValid(body.data)) {
    throw httpError(400, "Dokument nie spełnia schematu Puls 2.0", "INVALID_WORKSPACE_SCHEMA");
  }
  const serialized = JSON.stringify(body.data);
  if (Buffer.byteLength(serialized, "utf8") > maxWorkspaceBytes) {
    throw httpError(413, "Dane przekraczają dozwolony rozmiar", "WORKSPACE_TOO_LARGE");
  }
  const { sharedData, privateData } = splitWorkspaceData(body.data, session.user_id);
  const result = await transaction(async (client) => {
    const updated = await client.query(
      `UPDATE workspace_states
          SET data = $1::jsonb, revision = revision + 1, updated_by = $2, updated_at = now()
        WHERE household_id = $3 AND revision = $4
        RETURNING revision, updated_at`,
      [JSON.stringify(sharedData), session.user_id, session.household_id, expectedRevision],
    );
    if (!updated.rowCount) return null;
    await client.query(
      `INSERT INTO user_workspace_states(household_id, user_id, data, updated_at)
       VALUES ($1, $2, $3::jsonb, now())
       ON CONFLICT (household_id, user_id)
       DO UPDATE SET data = EXCLUDED.data, updated_at = now()`,
      [session.household_id, session.user_id, JSON.stringify(privateData)],
    );
    return updated.rows[0];
  });
  if (!result) {
    const current = await query("SELECT revision FROM workspace_states WHERE household_id = $1", [
      session.household_id,
    ]);
    reply.status(409);
    return {
      error: "Dane zostały zmienione na innym urządzeniu",
      code: "REVISION_CONFLICT",
      revision: current.rows[0]?.revision ?? 0,
    };
  }
  return result;
});

// Finance module: normalized tables, not part of the workspace JSONB document (see
// docs/plans/model-synchronizacji-danych.md and server/src/finance.mjs). GET returns a snapshot,
// mutations go through a single idempotent batch endpoint mapping 1:1 onto the client's offline queue.
app.get("/api/v1/finance", async (request) => {
  const session = await requireHousehold(request);
  const snapshot = await readFinanceSnapshot(pool, session.household_id, session.user_id);
  return { ...snapshot, serverAt: new Date().toISOString() };
});

app.post("/api/v1/finance/mutations", async (request) => {
  const session = await requireHousehold(request);
  const body = request.body ?? {};
  if (!Array.isArray(body.mutations)) {
    throw httpError(400, "Nieprawidłowe żądanie mutacji finansowych", "INVALID_FINANCE_MUTATIONS");
  }
  if (body.mutations.length > MAX_FINANCE_MUTATIONS_PER_BATCH) {
    throw httpError(413, "Zbyt wiele mutacji w jednym żądaniu", "FINANCE_MUTATIONS_TOO_LARGE");
  }
  const serializedSize = Buffer.byteLength(JSON.stringify(body.mutations), "utf8");
  if (serializedSize > MAX_FINANCE_MUTATIONS_BYTES) {
    throw httpError(
      413,
      "Dane mutacji przekraczają dozwolony rozmiar",
      "FINANCE_MUTATIONS_TOO_LARGE",
    );
  }
  // Validate the whole batch's shape up front (before any DB work) so one malformed entry can't
  // partially poison sibling mutations' bookkeeping -- see finance.mjs's assertFinanceMutationShape.
  for (const mutation of body.mutations) assertFinanceMutationShape(mutation);
  const results = [];
  for (const mutation of body.mutations) {
    const ctx = { householdId: session.household_id, userId: session.user_id };
    // Sequential by design: mutations must apply in the client's offline-queue order (e.g.
    // transaction.create after the account.create it depends on).
    const result = await transaction((client) => applyFinanceMutation(client, ctx, mutation));
    results.push(result);
  }
  return { results, serverAt: new Date().toISOString() };
});

// Wspiera "Wyczyść dane aplikacji" (SettingsPage.tsx danger zone): finance nie jest już częścią
// dokumentu JSONB, więc nie ma go czym nadpisać zwykłym PUT /api/v1/workspace -- ten endpoint
// odtwarza dokładnie ten sam zakres usuwania (wspólne rekordy + WYŁĄCZNIE prywatne rekordy
// wywołującego, nigdy prywatne rekordy innych domowników).
app.post("/api/v1/finance/reset", async (request) => {
  const session = await requireHousehold(request);
  await transaction((client) => resetFinanceForUser(client, session.household_id, session.user_id));
  return { serverAt: new Date().toISOString() };
});

// Trips module (Podróże): normalized tables, not part of the workspace JSONB document (see
// docs/plans/podroze-trips.md and server/src/trips.mjs). GET returns a snapshot, mutations go through
// a single idempotent batch endpoint mapping 1:1 onto the client's offline queue. Unlike Finance, trips
// have no private records at all -- the snapshot and every mutation scope exclusively by household_id.
app.get("/api/v1/trips", async (request) => {
  const session = await requireHousehold(request);
  const snapshot = await readTripsSnapshot(pool, session.household_id);
  return { ...snapshot, serverAt: new Date().toISOString() };
});

app.post("/api/v1/trips/mutations", async (request) => {
  const session = await requireHousehold(request);
  const body = request.body ?? {};
  if (!Array.isArray(body.mutations)) {
    throw httpError(400, "Nieprawidłowe żądanie mutacji podróży", "INVALID_TRIP_MUTATIONS");
  }
  if (body.mutations.length > MAX_TRIP_MUTATIONS_PER_BATCH) {
    throw httpError(413, "Zbyt wiele mutacji w jednym żądaniu", "TRIP_MUTATIONS_TOO_LARGE");
  }
  const serializedSize = Buffer.byteLength(JSON.stringify(body.mutations), "utf8");
  if (serializedSize > MAX_TRIP_MUTATIONS_BYTES) {
    throw httpError(413, "Dane mutacji przekraczają dozwolony rozmiar", "TRIP_MUTATIONS_TOO_LARGE");
  }
  // Validate the whole batch's shape up front (before any DB work) so one malformed entry can't
  // partially poison sibling mutations' bookkeeping -- see trips.mjs's assertTripMutationShape.
  for (const mutation of body.mutations) assertTripMutationShape(mutation);
  const results = [];
  for (const mutation of body.mutations) {
    const ctx = { householdId: session.household_id, userId: session.user_id };
    // Sequential by design: mutations must apply in the client's offline-queue order (e.g.
    // itinerary.create after the trip.create it depends on).
    const result = await transaction((client) => applyTripMutation(client, ctx, mutation));
    results.push(result);
  }
  return { results, serverAt: new Date().toISOString() };
});

// Wspiera "Wyczyść dane aplikacji" (SettingsPage.tsx danger zone): trips nie są już częścią dokumentu
// JSONB, więc nie ma ich czym nadpisać zwykłym PUT /api/v1/workspace. Prostsze niż Finance's reset --
// trips nie mają rekordów prywatnych, więc czyścimy całe gospodarstwo bezwarunkowo.
app.post("/api/v1/trips/reset", async (request) => {
  const session = await requireHousehold(request);
  await transaction((client) => resetTripsForHousehold(client, session.household_id));
  return { serverAt: new Date().toISOString() };
});

// Meals module (Posiłki): normalized tables, not part of the workspace JSONB document (see
// docs/plans/lista-zakupow-meals.md and server/src/meals.mjs). GET returns a snapshot, mutations
// go through a single idempotent batch endpoint mapping 1:1 onto the client's offline queue. Like
// Trips, meals have no private records at all -- the snapshot and every mutation scope exclusively
// by household_id.
app.get("/api/v1/meals", async (request) => {
  const session = await requireHousehold(request);
  const snapshot = await readMealsSnapshot(pool, session.household_id);
  return { ...snapshot, serverAt: new Date().toISOString() };
});

app.post("/api/v1/meals/mutations", async (request) => {
  const session = await requireHousehold(request);
  const body = request.body ?? {};
  if (!Array.isArray(body.mutations)) {
    throw httpError(400, "Nieprawidłowe żądanie mutacji posiłków", "INVALID_MEAL_MUTATIONS");
  }
  if (body.mutations.length > MAX_MEAL_MUTATIONS_PER_BATCH) {
    throw httpError(413, "Zbyt wiele mutacji w jednym żądaniu", "MEAL_MUTATIONS_TOO_LARGE");
  }
  const serializedSize = Buffer.byteLength(JSON.stringify(body.mutations), "utf8");
  if (serializedSize > MAX_MEAL_MUTATIONS_BYTES) {
    throw httpError(413, "Dane mutacji przekraczają dozwolony rozmiar", "MEAL_MUTATIONS_TOO_LARGE");
  }
  // Validate the whole batch's shape up front (before any DB work) so one malformed entry can't
  // partially poison sibling mutations' bookkeeping -- see meals.mjs's assertMealMutationShape.
  for (const mutation of body.mutations) assertMealMutationShape(mutation);
  const results = [];
  for (const mutation of body.mutations) {
    const ctx = { householdId: session.household_id, userId: session.user_id };
    // Sequential by design: mutations must apply in the client's offline-queue order (e.g.
    // meal.create/shopping.create after the recipe.create it depends on).
    const result = await transaction((client) => applyMealMutation(client, ctx, mutation));
    results.push(result);
  }
  return { results, serverAt: new Date().toISOString() };
});

// Wspiera "Wyczyść dane aplikacji" (SettingsPage.tsx danger zone): meals nie są już częścią
// dokumentu JSONB, więc nie ma ich czym nadpisać zwykłym PUT /api/v1/workspace. Meals nie mają
// rekordów prywatnych, więc czyścimy całe gospodarstwo bezwarunkowo.
app.post("/api/v1/meals/reset", async (request) => {
  const session = await requireHousehold(request);
  await transaction((client) => resetMealsForHousehold(client, session.household_id));
  return { serverAt: new Date().toISOString() };
});

app.post("/api/v1/migration/local-v1/preview", async (request) => {
  await requireHousehold(request);
  const source = request.body?.data ?? {};
  const keys = ["tasks", "events", "reminders", "notes", "habits"];
  const counts = Object.fromEntries(
    keys.map((key) => [key, Array.isArray(source[key]) ? source[key].length : 0]),
  );
  return { valid: Object.values(counts).some((count) => count > 0), counts };
});

app.get("/api/v1/push/public-key", async (request) => {
  await requireSession(request);
  return { publicKey: process.env.VAPID_PUBLIC_KEY ?? null };
});

const ALLOWED_PUSH_ENDPOINT_HOSTS = [
  "fcm.googleapis.com",
  "updates.push.services.mozilla.com",
  "push.apple.com",
  "notify.windows.com",
];

function isAllowedPushEndpointHost(hostname) {
  if (typeof hostname !== "string") return false;
  return ALLOWED_PUSH_ENDPOINT_HOSTS.some(
    (allowed) => hostname === allowed || hostname.endsWith(`.${allowed}`),
  );
}

app.post("/api/v1/push/subscriptions", async (request) => {
  const session = await requireSession(request);
  const subscription = request.body ?? {};
  let pushEndpoint;
  try {
    pushEndpoint = new URL(subscription.endpoint);
  } catch {
    pushEndpoint = null;
  }
  if (
    typeof subscription.endpoint !== "string" ||
    subscription.endpoint.length > 4_096 ||
    pushEndpoint?.protocol !== "https:" ||
    !isAllowedPushEndpointHost(pushEndpoint?.hostname) ||
    typeof subscription.keys?.p256dh !== "string" ||
    subscription.keys.p256dh.length < 16 ||
    subscription.keys.p256dh.length > 512 ||
    !/^[A-Za-z0-9_-]+$/.test(subscription.keys.p256dh) ||
    typeof subscription.keys?.auth !== "string" ||
    subscription.keys.auth.length < 8 ||
    subscription.keys.auth.length > 256 ||
    !/^[A-Za-z0-9_-]+$/.test(subscription.keys.auth)
  ) {
    throw httpError(400, "Nieprawidłowa subskrypcja push", "INVALID_PUSH_SUBSCRIPTION");
  }
  await query(
    `INSERT INTO push_subscriptions(user_id, endpoint, p256dh, auth_secret, user_agent)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (endpoint) DO UPDATE SET user_id = EXCLUDED.user_id, p256dh = EXCLUDED.p256dh, auth_secret = EXCLUDED.auth_secret, user_agent = EXCLUDED.user_agent`,
    [
      session.user_id,
      subscription.endpoint,
      subscription.keys.p256dh,
      subscription.keys.auth,
      String(request.headers["user-agent"] ?? "").slice(0, 500),
    ],
  );
  return { ok: true };
});

app.delete("/api/v1/push/subscriptions", async (request) => {
  const session = await requireSession(request);
  const endpoint = String(request.body?.endpoint ?? "");
  await query("DELETE FROM push_subscriptions WHERE user_id = $1 AND endpoint = $2", [
    session.user_id,
    endpoint,
  ]);
  return { ok: true };
});

function googleConfigured() {
  return Boolean(
    process.env.GOOGLE_CLIENT_ID &&
    process.env.GOOGLE_CLIENT_SECRET &&
    process.env.GOOGLE_REDIRECT_URI &&
    process.env.TOKEN_ENCRYPTION_KEY,
  );
}

app.get("/api/v1/integrations/google/status", async (request) => {
  const session = await requireSession(request);
  const connection = await query(
    "SELECT google_email, connected_at FROM google_connections WHERE user_id = $1",
    [session.user_id],
  );
  return {
    configured: googleConfigured(),
    connected: Boolean(connection.rowCount),
    connection: connection.rows[0] ?? null,
  };
});

app.post("/api/v1/integrations/google/start", async (request) => {
  const session = await requireSession(request);
  if (!googleConfigured())
    throw httpError(503, "Integracja Google nie jest skonfigurowana", "GOOGLE_NOT_CONFIGURED");
  const state = randomToken();
  const returnPath = safeSameOriginPath(request.body?.returnPath, appOrigin);
  await query(
    "INSERT INTO oauth_states(state_hash, user_id, return_path, expires_at) VALUES ($1, $2, $3, now() + interval '10 minutes')",
    [hashToken(state), session.user_id, returnPath],
  );
  const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  url.searchParams.set("client_id", process.env.GOOGLE_CLIENT_ID);
  url.searchParams.set("redirect_uri", process.env.GOOGLE_REDIRECT_URI);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("access_type", "offline");
  url.searchParams.set("prompt", "consent");
  url.searchParams.set("include_granted_scopes", "true");
  url.searchParams.set("scope", "openid email https://www.googleapis.com/auth/calendar.readonly");
  url.searchParams.set("state", state);
  return { url: url.toString() };
});

app.get("/api/v1/integrations/google/callback", async (request, reply) => {
  if (!googleConfigured())
    throw httpError(503, "Integracja Google nie jest skonfigurowana", "GOOGLE_NOT_CONFIGURED");
  const stateHash = hashToken(String(request.query.state ?? ""));
  const stateResult = await query(
    "DELETE FROM oauth_states WHERE state_hash = $1 AND expires_at > now() RETURNING user_id, return_path",
    [stateHash],
  );
  if (!stateResult.rowCount || !request.query.code)
    throw httpError(400, "Sesja OAuth wygasła", "INVALID_OAUTH_STATE");
  const tokenResponse = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code: String(request.query.code),
      client_id: process.env.GOOGLE_CLIENT_ID,
      client_secret: process.env.GOOGLE_CLIENT_SECRET,
      redirect_uri: process.env.GOOGLE_REDIRECT_URI,
      grant_type: "authorization_code",
    }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!tokenResponse.ok) throw httpError(502, "Google odrzucił połączenie", "GOOGLE_TOKEN_ERROR");
  const tokens = await tokenResponse.json();
  const profileResponse = await fetch("https://www.googleapis.com/oauth2/v2/userinfo", {
    headers: { authorization: `Bearer ${tokens.access_token}` },
    signal: AbortSignal.timeout(10_000),
  });
  const profile = profileResponse.ok ? await profileResponse.json() : {};
  await query(
    `INSERT INTO google_connections(user_id, access_token_encrypted, refresh_token_encrypted, token_expires_at, scopes, google_email)
     VALUES ($1, $2, $3, now() + ($4 || ' seconds')::interval, $5, $6)
     ON CONFLICT (user_id) DO UPDATE SET
       access_token_encrypted = EXCLUDED.access_token_encrypted,
       refresh_token_encrypted = COALESCE(EXCLUDED.refresh_token_encrypted, google_connections.refresh_token_encrypted),
       token_expires_at = EXCLUDED.token_expires_at,
       scopes = EXCLUDED.scopes,
       google_email = EXCLUDED.google_email,
       updated_at = now()`,
    [
      stateResult.rows[0].user_id,
      encryptSecret(tokens.access_token),
      tokens.refresh_token ? encryptSecret(tokens.refresh_token) : null,
      String(tokens.expires_in ?? 3600),
      String(tokens.scope ?? "")
        .split(" ")
        .filter(Boolean),
      profile.email ?? null,
    ],
  );
  const returnUrl = new URL(stateResult.rows[0].return_path, appOrigin);
  returnUrl.searchParams.set("google", "connected");
  reply.redirect(returnUrl.toString());
});

app.delete("/api/v1/integrations/google", async (request) => {
  const session = await requireSession(request);
  const connection = await query(
    "SELECT access_token_encrypted, refresh_token_encrypted FROM google_connections WHERE user_id = $1",
    [session.user_id],
  );
  if (connection.rowCount) {
    const encrypted =
      connection.rows[0].refresh_token_encrypted ?? connection.rows[0].access_token_encrypted;
    if (encrypted) {
      try {
        await fetch("https://oauth2.googleapis.com/revoke", {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({ token: decryptSecret(encrypted) }),
          signal: AbortSignal.timeout(10_000),
        });
      } catch (error) {
        request.log.warn({ error }, "Google token revocation failed");
      }
    }
  }
  await query("DELETE FROM google_connections WHERE user_id = $1", [session.user_id]);
  return { ok: true };
});

app.post("/api/v1/integrations/google/sync", async (request) => {
  const session = await requireSession(request);
  const connectionResult = await query("SELECT * FROM google_connections WHERE user_id = $1", [
    session.user_id,
  ]);
  if (!connectionResult.rowCount)
    throw httpError(409, "Najpierw połącz Google Calendar", "GOOGLE_NOT_CONNECTED");
  const accessToken = await freshGoogleAccessToken(connectionResult.rows[0]);
  const from = request.body?.from ?? new Date().toISOString();
  const until = request.body?.until ?? new Date(Date.now() + 90 * 24 * 60 * 60_000).toISOString();
  const fromTime = Date.parse(from);
  const untilTime = Date.parse(until);
  if (
    !Number.isFinite(fromTime) ||
    !Number.isFinite(untilTime) ||
    untilTime <= fromTime ||
    untilTime - fromTime > 366 * 24 * 60 * 60_000
  ) {
    throw httpError(400, "Nieprawidłowy zakres synchronizacji kalendarza", "INVALID_SYNC_RANGE");
  }
  const items = [];
  let pageToken;
  for (let page = 0; page < 10; page += 1) {
    const url = new URL("https://www.googleapis.com/calendar/v3/calendars/primary/events");
    url.searchParams.set("singleEvents", "true");
    url.searchParams.set("orderBy", "startTime");
    url.searchParams.set("showDeleted", "true");
    url.searchParams.set("timeMin", from);
    url.searchParams.set("timeMax", until);
    url.searchParams.set("maxResults", "500");
    if (pageToken) url.searchParams.set("pageToken", pageToken);
    const response = await fetch(url, {
      headers: { authorization: `Bearer ${accessToken}` },
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) throw httpError(502, "Nie udało się pobrać kalendarza", "GOOGLE_SYNC_ERROR");
    const payload = await response.json();
    items.push(...(payload.items ?? []));
    pageToken = payload.nextPageToken;
    if (!pageToken) break;
  }
  return {
    events: items.map((event) => ({
      externalId: event.id,
      title: event.summary ?? "Bez tytułu",
      start: event.start?.dateTime ?? event.start?.date,
      end: event.end?.dateTime ?? event.end?.date,
      location: event.location,
      htmlLink: event.htmlLink,
      status: event.status,
      updatedAt: event.updated,
      source: "google",
    })),
  };
});

async function freshGoogleAccessToken(connection) {
  if (
    connection.access_token_encrypted &&
    new Date(connection.token_expires_at).getTime() > Date.now() + 60_000
  ) {
    return decryptSecret(connection.access_token_encrypted);
  }
  if (!connection.refresh_token_encrypted)
    throw httpError(401, "Połącz ponownie Google Calendar", "GOOGLE_RECONNECT_REQUIRED");
  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      refresh_token: decryptSecret(connection.refresh_token_encrypted),
      client_id: process.env.GOOGLE_CLIENT_ID,
      client_secret: process.env.GOOGLE_CLIENT_SECRET,
      grant_type: "refresh_token",
    }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok)
    throw httpError(401, "Połącz ponownie Google Calendar", "GOOGLE_RECONNECT_REQUIRED");
  const tokens = await response.json();
  await query(
    "UPDATE google_connections SET access_token_encrypted = $1, token_expires_at = now() + ($2 || ' seconds')::interval, updated_at = now() WHERE user_id = $3",
    [encryptSecret(tokens.access_token), String(tokens.expires_in ?? 3600), connection.user_id],
  );
  return tokens.access_token;
}

const currentFile = fileURLToPath(import.meta.url);
const staticRoot = path.resolve(
  process.env.STATIC_DIR ?? path.join(path.dirname(currentFile), "..", "..", "dist"),
);
if (existsSync(staticRoot)) {
  await app.register(fastifyStatic, { root: staticRoot, prefix: "/" });
  app.setNotFoundHandler((request, reply) => {
    if (request.url.startsWith("/api/") || request.url.startsWith("/health/")) {
      return reply.status(404).send({ error: "Nie znaleziono", code: "NOT_FOUND" });
    }
    return reply.sendFile("index.html");
  });
}

const port = Number(process.env.PORT ?? 8080);
const host = process.env.HOST ?? "0.0.0.0";

let shuttingDown = false;
const shutdown = async (signal) => {
  if (shuttingDown) return;
  shuttingDown = true;
  app.log.info({ signal }, "Shutting down");
  await app.close();
  await pool.end();
  process.exit(0);
};
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));

await app.listen({ port, host });
