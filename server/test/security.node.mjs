import assert from "node:assert/strict";
import test from "node:test";
import {
  decryptSecret,
  encryptSecret,
  hashPassword,
  safeSameOriginPath,
  timingSafeString,
  verifyPassword,
} from "../src/security.mjs";

test("password hashing verifies only the original password", async () => {
  const encoded = await hashPassword("bardzo-dlugie-haslo");
  assert.equal(await verifyPassword("bardzo-dlugie-haslo", encoded), true);
  assert.equal(await verifyPassword("inne-bardzo-dlugie-haslo", encoded), false);
});

test("token comparison and AES-GCM secret storage work", () => {
  process.env.TOKEN_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString("base64");
  assert.equal(timingSafeString("sekret", "sekret"), true);
  assert.equal(timingSafeString("sekret", "inny"), false);
  const encrypted = encryptSecret("refresh-token");
  assert.notEqual(encrypted, "refresh-token");
  assert.equal(decryptSecret(encrypted), "refresh-token");
});

test("OAuth return path cannot escape the application origin", () => {
  const origin = "https://puls.example.com";
  assert.equal(
    safeSameOriginPath("/settings?google=1#calendar", origin),
    "/settings?google=1#calendar",
  );
  assert.equal(safeSameOriginPath("https://attacker.example/", origin), "/");
  assert.equal(safeSameOriginPath("//attacker.example/", origin), "/");
  assert.equal(safeSameOriginPath("/\\attacker.example/", origin), "/");
});

test("verifying against a dummy hash costs the same as a real one (timing-attack fix)", async () => {
  const realHash = await hashPassword("prawdziwe-haslo-uzytkownika");
  const dummyHash = await hashPassword("puls-timing-safety-placeholder");
  assert.notEqual(realHash, dummyHash);

  const time = async (encoded) => {
    const start = process.hrtime.bigint();
    await verifyPassword("probowane-haslo-atakujacego", encoded);
    return Number(process.hrtime.bigint() - start);
  };

  const withRealHash = await time(realHash);
  const withDummyHash = await time(dummyHash);
  const slower = Math.max(withRealHash, withDummyHash);
  const faster = Math.min(withRealHash, withDummyHash);
  assert.ok(
    slower / faster < 5,
    "verifyPassword must do equivalent-cost work for both a real and a dummy hash",
  );
});
