import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { ConfigurationError } from "./config.js";

export interface EncryptedValue {
  ciphertext: string;
  iv: string;
  authTag: string;
}

function encryptionKey(keyHex: string): Buffer {
  if (!/^[a-fA-F0-9]{64}$/.test(keyHex)) {
    throw new ConfigurationError("TOKEN_ENCRYPTION_KEY must contain exactly 64 hexadecimal characters (32 bytes).");
  }
  return Buffer.from(keyHex, "hex");
}

export function encryptValue(value: string, keyHex: string): EncryptedValue {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", encryptionKey(keyHex), iv);
  const ciphertext = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  return {
    ciphertext: ciphertext.toString("base64"),
    iv: iv.toString("base64"),
    authTag: cipher.getAuthTag().toString("base64")
  };
}

export function decryptValue(value: EncryptedValue, keyHex: string): string {
  try {
    const decipher = createDecipheriv("aes-256-gcm", encryptionKey(keyHex), Buffer.from(value.iv, "base64"));
    decipher.setAuthTag(Buffer.from(value.authTag, "base64"));
    return Buffer.concat([
      decipher.update(Buffer.from(value.ciphertext, "base64")),
      decipher.final()
    ]).toString("utf8");
  } catch {
    throw new ConfigurationError("Could not decrypt the stored Strava tokens. Check that TOKEN_ENCRYPTION_KEY is unchanged.");
  }
}
