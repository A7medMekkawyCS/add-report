const crypto = require("crypto");

function getEncryptionKey() {
  const raw = process.env.CREDENTIALS_ENCRYPTION_KEY;
  if (!raw || !String(raw).trim()) {
    throw new Error("CREDENTIALS_ENCRYPTION_KEY is required");
  }
  const value = String(raw).trim();
  if (/^[0-9a-fA-F]{64}$/.test(value)) {
    return Buffer.from(value, "hex");
  }
  const fromBase64 = Buffer.from(value, "base64");
  if (fromBase64.length === 32) return fromBase64;
  return crypto.createHash("sha256").update(value).digest();
}

function encryptSecret(value) {
  if (value == null || String(value) === "") {
    throw new Error("Cannot encrypt an empty secret");
  }
  const key = getEncryptionKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([cipher.update(String(value), "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString("hex")}:${tag.toString("hex")}:${encrypted.toString("hex")}`;
}

function decryptSecret(payload) {
  if (!payload || typeof payload !== "string") {
    throw new Error("Cannot decrypt an empty secret");
  }
  const [ivHex, tagHex, dataHex] = payload.split(":");
  if (!ivHex || !tagHex || !dataHex) {
    throw new Error("Invalid encrypted secret format");
  }
  const key = getEncryptionKey();
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(ivHex, "hex"));
  decipher.setAuthTag(Buffer.from(tagHex, "hex"));
  const decrypted = Buffer.concat([
    decipher.update(Buffer.from(dataHex, "hex")),
    decipher.final(),
  ]);
  return decrypted.toString("utf8");
}

module.exports = {
  encryptSecret,
  decryptSecret,
};
