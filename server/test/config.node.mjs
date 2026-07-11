import assert from "node:assert/strict";
import test from "node:test";
import { validateConfiguration } from "../src/config.mjs";

const validBase = {
  appOrigin: "https://puls.example.com",
  production: true,
  sessionDays: 30,
  maxWorkspaceBytes: 5_000_000,
  bootstrapToken: "a".repeat(32),
  tokenEncryptionKey: Buffer.alloc(32, 7).toString("base64"),
  googleClientId: "",
  googleClientSecret: "",
  googleRedirectUri: "",
};

test("optional Google Calendar can be completely disabled", () => {
  assert.doesNotThrow(() => validateConfiguration(validBase));
  assert.doesNotThrow(() => validateConfiguration({
    ...validBase,
    googleRedirectUri: "https://puls.example.com/api/v1/integrations/google/callback",
  }));
});

test("partial Google credentials are rejected", () => {
  assert.throws(
    () => validateConfiguration({ ...validBase, googleClientId: "client" }),
    /configuration is incomplete/,
  );
  assert.throws(
    () => validateConfiguration({ ...validBase, googleClientId: "client", googleClientSecret: "secret" }),
    /configuration is incomplete/,
  );
});

test("BOOTSTRAP_TOKEN minimum length is enforced even outside production", () => {
  assert.throws(
    () => validateConfiguration({ ...validBase, production: false, bootstrapToken: "too-short" }),
    /BOOTSTRAP_TOKEN must contain at least 24 characters/,
  );
  assert.doesNotThrow(() => validateConfiguration({ ...validBase, production: false, bootstrapToken: "a".repeat(24) }));
});

test("Google redirect must use the public application origin", () => {
  assert.doesNotThrow(() => validateConfiguration({
    ...validBase,
    googleClientId: "client",
    googleClientSecret: "secret",
    googleRedirectUri: "https://puls.example.com/api/v1/integrations/google/callback",
  }));
  assert.throws(
    () => validateConfiguration({
      ...validBase,
      googleClientId: "client",
      googleClientSecret: "secret",
      googleRedirectUri: "https://attacker.example/api/v1/integrations/google/callback",
    }),
    /must use APP_ORIGIN/,
  );
});
