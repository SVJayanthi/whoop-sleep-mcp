// AES-256-GCM for WHOOP tokens at rest. Key comes from TOKEN_ENCRYPTION_KEY
// (64-char hex, or any other secret which is SHA-256'd into 32 bytes).
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

export function deriveKey(secret) {
  if (secret == null || String(secret).length < 16) {
    throw new Error("TOKEN_ENCRYPTION_KEY must be at least 16 characters (use `openssl rand -hex 32`).");
  }
  const s = String(secret);
  if (/^[0-9a-fA-F]{64}$/.test(s)) return Buffer.from(s, "hex");
  return createHash("sha256").update(s, "utf8").digest();
}

export function sha256(text) {
  return createHash("sha256").update(String(text), "utf8").digest("hex");
}

// blob = version (1) || iv (12) || tag (16) || ciphertext, base64.
// `aad` (e.g. WHOOP user id) is bound into the tag so a blob cannot be moved to another user.
export function encryptJson(key, obj, aad) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from(String(aad), "utf8"));
  const pt = Buffer.from(JSON.stringify(obj), "utf8");
  const ct = Buffer.concat([cipher.update(pt), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([Buffer.from([1]), iv, tag, ct]).toString("base64");
}

export function decryptJson(key, blob, aad) {
  const buf = Buffer.from(String(blob), "base64");
  if (buf.length < 29 || buf[0] !== 1) throw new Error("invalid encrypted blob");
  const iv = buf.subarray(1, 13);
  const tag = buf.subarray(13, 29);
  const ct = buf.subarray(29);
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAAD(Buffer.from(String(aad), "utf8"));
  decipher.setAuthTag(tag);
  const pt = Buffer.concat([decipher.update(ct), decipher.final()]);
  return JSON.parse(pt.toString("utf8"));
}
