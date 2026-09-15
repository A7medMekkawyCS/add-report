const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

process.env.CREDENTIALS_ENCRYPTION_KEY =
  process.env.CREDENTIALS_ENCRYPTION_KEY ||
  "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

const { encryptSecret, decryptSecret } = require("../src/crypto/secrets");

describe("encryptSecret / decryptSecret", () => {
  it("round-trips a password", () => {
    const encrypted = encryptSecret("super-secret-password");
    assert.notEqual(encrypted, "super-secret-password");
    assert.equal(decryptSecret(encrypted), "super-secret-password");
  });

  it("produces different ciphertext for the same value", () => {
    const a = encryptSecret("same-password");
    const b = encryptSecret("same-password");
    assert.notEqual(a, b);
    assert.equal(decryptSecret(a), decryptSecret(b));
  });

  it("does not store the plain password in the ciphertext", () => {
    const encrypted = encryptSecret("visible-password");
    assert.equal(encrypted.includes("visible-password"), false);
  });
});
