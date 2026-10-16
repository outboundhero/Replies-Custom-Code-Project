/**
 * Product costing keys are kept encrypted in the database (AES-256-GCM). The key is derived from
 * COSTING_SECRET, else the app's JWT_SECRET, so no new setting is needed. Keys never go back to
 * the browser — only their last four characters.
 */
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "crypto";

function key(): Buffer {
  const base = process.env.COSTING_SECRET || process.env.JWT_SECRET;
  if (!base) throw new Error("Neither COSTING_SECRET nor JWT_SECRET is set — can't store product keys safely.");
  return createHash("sha256").update(`costing-key:${base}`).digest();
}

export function sealKey(plain: string): string {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", key(), iv);
  const enc = Buffer.concat([c.update(plain, "utf8"), c.final()]);
  return `v1:${iv.toString("base64")}:${c.getAuthTag().toString("base64")}:${enc.toString("base64")}`;
}

export function openKey(sealed: string): string {
  const [v, iv, tag, data] = sealed.split(":");
  if (v !== "v1" || !iv || !tag || !data) throw new Error("This product's key can't be read — enter it again.");
  const d = createDecipheriv("aes-256-gcm", key(), Buffer.from(iv, "base64"));
  d.setAuthTag(Buffer.from(tag, "base64"));
  return Buffer.concat([d.update(Buffer.from(data, "base64")), d.final()]).toString("utf8");
}

export const keyHint = (plain: string) => (plain.length > 8 ? `••••${plain.slice(-4)}` : "••••");
