import { createHmac, timingSafeEqual } from "node:crypto";

import { readReturnPath } from "../auth/return-state.js";
import { resolveDemoContentPath } from "./path-resolver.js";

const DOMAIN = "html-share:password-return:v1\0";
const STATE_TTL = 10 * 60_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const BROWSER_TOKEN = /^[A-Za-z0-9_-]{43}$/;

export interface PasswordReturnState {
  projectId: string;
  returnPath: string;
  expiresAt: number;
}

export function readPasswordReturnPath(value: unknown): string | null {
  const path = readReturnPath(value);
  return path !== null &&
    path.length <= 4096 &&
    ![...path].some(
      (character) => character <= "\u001f" || character === "\u007f" || character === "#",
    ) &&
    resolveDemoContentPath(path) !== null
    ? path
    : null;
}

export function isPasswordBrowserToken(value: unknown): value is string {
  return (
    typeof value === "string" &&
    BROWSER_TOKEN.test(value) &&
    Buffer.from(value, "base64url").toString("base64url") === value
  );
}

export function createPasswordState(input: {
  secret: string;
  browserToken: string;
  projectId: string;
  returnPath: string;
  now?: Date;
}): string {
  if (
    !UUID.test(input.projectId) ||
    !isPasswordBrowserToken(input.browserToken) ||
    readPasswordReturnPath(input.returnPath) === null ||
    input.secret.length < 32
  )
    throw new Error("Invalid password return state input");
  const payload = Buffer.from(
    JSON.stringify({
      projectId: input.projectId,
      returnPath: input.returnPath,
      expiresAt: (input.now ?? new Date()).getTime() + STATE_TTL,
    }),
  ).toString("base64url");
  return `${payload}.${signature(input.secret, input.browserToken, payload).toString("base64url")}`;
}

export function readPasswordState(input: {
  secret: string;
  browserToken: string | undefined;
  state: unknown;
  now?: Date;
}): PasswordReturnState | null {
  if (
    !isPasswordBrowserToken(input.browserToken) ||
    input.secret.length < 32 ||
    typeof input.state !== "string" ||
    input.state.length > 8192
  )
    return null;
  const parts = input.state.split(".");
  const [payload, mac] = parts;
  if (
    parts.length !== 2 ||
    !payload ||
    !mac ||
    !/^[A-Za-z0-9_-]+$/.test(payload) ||
    !/^[A-Za-z0-9_-]{43}$/.test(mac)
  )
    return null;
  const decodedMac = Buffer.from(mac, "base64url");
  if (
    decodedMac.length !== 32 ||
    decodedMac.toString("base64url") !== mac ||
    !timingSafeEqual(decodedMac, signature(input.secret, input.browserToken, payload))
  )
    return null;
  try {
    const bytes = Buffer.from(payload, "base64url");
    if (bytes.toString("base64url") !== payload) return null;
    const value: unknown = JSON.parse(bytes.toString("utf8"));
    if (typeof value !== "object" || value === null) return null;
    const fields = value as Record<string, unknown>;
    const currentTime = (input.now ?? new Date()).getTime();
    if (
      typeof fields["projectId"] !== "string" ||
      !UUID.test(fields["projectId"]) ||
      typeof fields["returnPath"] !== "string" ||
      readPasswordReturnPath(fields["returnPath"]) === null ||
      typeof fields["expiresAt"] !== "number" ||
      !Number.isSafeInteger(fields["expiresAt"]) ||
      fields["expiresAt"] <= currentTime ||
      fields["expiresAt"] > currentTime + STATE_TTL
    )
      return null;
    return {
      projectId: fields["projectId"],
      returnPath: fields["returnPath"],
      expiresAt: fields["expiresAt"],
    };
  } catch {
    return null;
  }
}

function signature(secret: string, browserToken: string, payload: string) {
  return createHmac("sha256", secret)
    .update(DOMAIN)
    .update(browserToken)
    .update("\0")
    .update(payload)
    .digest();
}
