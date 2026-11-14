import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import type { SessionAudience } from "./contracts.js";
const HANDOFF_AAD = Buffer.from("html-share:session-handoff:v1", "utf8");

interface SessionHandoffPayload {
  expiresAt: number;
  sourceAudience: SessionAudience;
  state: string;
  targetAudience: SessionAudience;
  userId: string;
  version: 1;
}

export function encryptHandoffTicket(payload: SessionHandoffPayload, key: Buffer) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv, { authTagLength: 16 });
  cipher.setAAD(HANDOFF_AAD);
  const ciphertext = Buffer.concat([
    cipher.update(JSON.stringify(payload), "utf8"),
    cipher.final(),
  ]);
  return [
    "v1",
    iv.toString("base64url"),
    ciphertext.toString("base64url"),
    cipher.getAuthTag().toString("base64url"),
  ].join(".");
}

export function decryptHandoffTicket(ticket: string, key: Buffer): SessionHandoffPayload | null {
  const parts = ticket.split(".");
  if (parts.length !== 4 || parts[0] !== "v1") return null;
  try {
    const iv = Buffer.from(parts[1] ?? "", "base64url");
    const ciphertext = Buffer.from(parts[2] ?? "", "base64url");
    const tag = Buffer.from(parts[3] ?? "", "base64url");
    if (iv.length !== 12 || ciphertext.length === 0 || tag.length !== 16) return null;
    const decipher = createDecipheriv("aes-256-gcm", key, iv, { authTagLength: 16 });
    decipher.setAAD(HANDOFF_AAD);
    decipher.setAuthTag(tag);
    const parsed: unknown = JSON.parse(
      Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8"),
    );
    return isSessionHandoffPayload(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function isSessionHandoffPayload(value: unknown): value is SessionHandoffPayload {
  if (typeof value !== "object" || value === null) return false;
  const payload = value as Record<string, unknown>;
  return (
    payload["version"] === 1 &&
    Number.isSafeInteger(payload["expiresAt"]) &&
    isAudience(payload["sourceAudience"]) &&
    isAudience(payload["targetAudience"]) &&
    typeof payload["state"] === "string" &&
    payload["state"].length > 0 &&
    payload["state"].length <= 128 &&
    typeof payload["userId"] === "string" &&
    payload["userId"].length > 0 &&
    payload["userId"].length <= 256
  );
}

function isAudience(value: unknown): value is SessionAudience {
  return value === "app" || value === "demo";
}
