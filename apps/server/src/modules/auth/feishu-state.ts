import { fastifyCookie } from "@fastify/cookie";
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import type { FastifyReply, FastifyRequest } from "fastify";
import type { SessionAudience } from "@html-share/core";

const TTL_SECONDS = 600;

function cookieName(state: string, secure: boolean) {
  return `${secure ? "__Host-" : ""}html_share_feishu_${createHash("sha256").update(state).digest("hex").slice(0, 24)}`;
}

function cookieOptions(secure: boolean) {
  return { path: "/", httpOnly: true, secure, sameSite: "lax" as const };
}

function signature(body: string, secret: string) {
  return createHmac("sha256", secret).update(`feishu-browser:v1:${body}`).digest("base64url");
}

export function setFeishuState(
  reply: FastifyReply,
  input: {
    state: string;
    audience: SessionAudience;
    codeVerifier: string;
    secret: string;
    secure: boolean;
  },
) {
  const body = Buffer.from(
    JSON.stringify({
      state: input.state,
      audience: input.audience,
      codeVerifier: input.codeVerifier,
      expiresAt: Date.now() + TTL_SECONDS * 1000,
    }),
  ).toString("base64url");
  reply.setCookie(
    cookieName(input.state, input.secure),
    `${body}.${signature(body, input.secret)}`,
    {
      ...cookieOptions(input.secure),
      maxAge: TTL_SECONDS,
    },
  );
}

export function expiredFeishuStateCookie(state: string, secure: boolean) {
  return fastifyCookie.serialize(cookieName(state, secure), "", {
    ...cookieOptions(secure),
    expires: new Date(0),
    maxAge: 0,
  });
}

export function clearFeishuState(reply: FastifyReply, state: string, secure: boolean) {
  reply.clearCookie(cookieName(state, secure), cookieOptions(secure));
}

export function readFeishuState(
  request: FastifyRequest,
  input: {
    state: string;
    audience: SessionAudience;
    secret: string;
    secure: boolean;
  },
): { codeVerifier: string } | null {
  if (!/^[A-Za-z0-9_-]{43}$/.test(input.state)) return null;
  const stored = request.cookies[cookieName(input.state, input.secure)];
  if (stored === undefined || stored.length > 1024) return null;
  const [body, received, extra] = stored.split(".");
  if (!body || !received || extra !== undefined) return null;
  const expected = Buffer.from(signature(body, input.secret));
  const actual = Buffer.from(received);
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return null;
  try {
    const value: unknown = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
    if (typeof value !== "object" || value === null) return null;
    const data = value as Record<string, unknown>;
    if (
      data["state"] !== input.state ||
      data["audience"] !== input.audience ||
      typeof data["expiresAt"] !== "number" ||
      data["expiresAt"] <= Date.now() ||
      typeof data["codeVerifier"] !== "string" ||
      !/^[A-Za-z0-9_-]{43}$/.test(data["codeVerifier"])
    )
      return null;
    return { codeVerifier: data["codeVerifier"] };
  } catch {
    return null;
  }
}
