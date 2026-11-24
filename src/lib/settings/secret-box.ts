import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "node:crypto";
import { getSettingsSecretConfig } from "@/lib/config";

/*
 * Secrets of the settings in the database (tokens, passwords, API keys) are
 * sealed with AES-256-GCM. The key is derived from BETTER_AUTH_SECRET with
 * HKDF, so no new variable is needed; a new BETTER_AUTH_SECRET means
 * entering these secrets again. Each sealed value is bound to its setting and
 * field, so it cannot be moved to another one. Format:
 * `v1:<base64url of IV (12 bytes), tag (16 bytes), ciphertext>`.
 */

const VERSION = "v1";
const IV_BYTES = 12;
const TAG_BYTES = 16;

/** A secret as the database keeps it: sealed, and the hint the page shows. */
export interface SealedSecret {
  sealed: string;
  hint: string;
}

export class SecretError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SecretError";
  }
}

/** The key that seals the settings' secrets, derived from BETTER_AUTH_SECRET. */
export function deriveSettingsKey(secret: string): Buffer {
  return Buffer.from(hkdfSync("sha256", secret, "meldgrove-library", "settings secrets v1", 32));
}

/** This process's key, or null when it has no BETTER_AUTH_SECRET (the worker with a Compose file up to 0.3.2). */
export function getSettingsKey(): Buffer | null {
  const secret = getSettingsSecretConfig().BETTER_AUTH_SECRET;
  return secret ? deriveSettingsKey(secret) : null;
}

export function sealSecret(key: Buffer, context: string, value: string): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from(context, "utf8"));
  const ciphertext = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  return `${VERSION}:${Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString("base64url")}`;
}

/** Opens a sealed value. Throws SecretError when the key or the context does not match. */
export function openSecret(key: Buffer, context: string, sealed: string): string {
  const [version, data] = sealed.split(":");
  if (version !== VERSION || !data) throw new SecretError("The saved secret has an unknown format.");
  const bytes = Buffer.from(data, "base64url");
  if (bytes.length < IV_BYTES + TAG_BYTES) throw new SecretError("The saved secret is damaged.");
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, bytes.subarray(0, IV_BYTES));
    decipher.setAAD(Buffer.from(context, "utf8"));
    decipher.setAuthTag(bytes.subarray(IV_BYTES, IV_BYTES + TAG_BYTES));
    return Buffer.concat([decipher.update(bytes.subarray(IV_BYTES + TAG_BYTES)), decipher.final()]).toString("utf8");
  } catch {
    throw new SecretError("The saved secret cannot be read: BETTER_AUTH_SECRET has changed since it was saved.");
  }
}

/** "…a1b2": the last four characters of a long secret; nothing of a short one. */
export function lastCharactersHint(value: string): string {
  return value.length >= 16 ? `…${value.slice(-4)}` : "…";
}

/** A URL with its password hidden: "smtps://library:****@mail.example.org:465". */
export function urlHint(value: string): string {
  try {
    const url = new URL(value);
    if (url.password) url.password = "****";
    return url.toString().replace(/\/$/, "");
  } catch {
    return "…";
  }
}
