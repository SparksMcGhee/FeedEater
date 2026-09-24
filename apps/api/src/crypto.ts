import crypto from "node:crypto";

function getKeyBytes(): Buffer {
  const raw = process.env.FEED_SETTINGS_KEY;
  if (!raw) throw new Error("Missing required env var: FEED_SETTINGS_KEY");

  const key = Buffer.from(raw, "base64");
  if (key.length !== 32) {
    throw new Error("FEED_SETTINGS_KEY must be 32 bytes (base64-encoded)");
  }
  return key;
}

export function encryptSecret(plaintext: string): string {
  const key = getKeyBytes();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);

  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();

  // v1:<base64(iv|tag|ciphertext)>
  return `v1:${Buffer.concat([iv, tag, ciphertext]).toString("base64")}`;
}

export function decryptSecret(encoded: string): string {
  if (!encoded.startsWith("v1:")) throw new Error("Unsupported secret encoding");
  const key = getKeyBytes();

  const raw = Buffer.from(encoded.slice(3), "base64");
  const iv = raw.subarray(0, 12);
  const tag = raw.subarray(12, 28);
  const ciphertext = raw.subarray(28);

  const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);

  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
}
