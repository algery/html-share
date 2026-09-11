import type { FastifyReply, FastifyRequest } from "fastify";

import type { SessionAudience } from "@html-share/core";

const SESSION_DURATION_SECONDS = 8 * 60 * 60;
const SESSION_HANDOFF_CHECK_DURATION_SECONDS = 60;
const SESSION_HANDOFF_CHECK_COOKIE = "html_share_demo_session_handoff_checked";

export function sessionCookieName(audience: SessionAudience) {
  return audience === "app" ? "html_share_app_session" : "html_share_demo_session";
}

export function readSessionCookie(request: FastifyRequest, audience: SessionAudience) {
  return request.cookies[sessionCookieName(audience)];
}

export function setSessionCookie(
  reply: FastifyReply,
  input: { audience: SessionAudience; secure: boolean; token: string },
) {
  reply.setCookie(sessionCookieName(input.audience), input.token, {
    httpOnly: true,
    maxAge: SESSION_DURATION_SECONDS,
    path: "/",
    sameSite: "lax",
    secure: input.secure,
  });
}

export function clearSessionCookie(
  reply: FastifyReply,
  audience: SessionAudience,
  secure: boolean,
) {
  reply.clearCookie(sessionCookieName(audience), {
    httpOnly: true,
    path: "/",
    sameSite: "lax",
    secure,
  });
}

export function usesSecureSessionCookie(authUrl: string) {
  const url = new URL(authUrl);
  if (url.protocol === "https:") return true;
  if (url.protocol === "http:" && isLocalDevelopmentHost(url.hostname)) return false;
  throw new Error("Session cookies require HTTPS unless the auth URL uses localhost or loopback");
}

export function setSessionHandoffCheckedCookie(reply: FastifyReply, secure: boolean) {
  reply.setCookie(SESSION_HANDOFF_CHECK_COOKIE, "1", {
    httpOnly: true,
    maxAge: SESSION_HANDOFF_CHECK_DURATION_SECONDS,
    path: "/",
    sameSite: "lax",
    secure,
  });
}

export function consumeSessionHandoffCheckedCookie(
  request: FastifyRequest,
  reply: FastifyReply,
  secure: boolean,
) {
  if (request.cookies[SESSION_HANDOFF_CHECK_COOKIE] !== "1") return false;
  reply.clearCookie(SESSION_HANDOFF_CHECK_COOKIE, {
    httpOnly: true,
    path: "/",
    sameSite: "lax",
    secure,
  });
  return true;
}

function isLocalDevelopmentHost(hostname: string) {
  return (
    hostname === "localhost" ||
    hostname.endsWith(".localhost") ||
    isIpv4Loopback(hostname) ||
    hostname === "[::1]"
  );
}

function isIpv4Loopback(hostname: string) {
  const octets = hostname.split(".");
  return (
    octets.length === 4 &&
    octets.every((octet) => /^\d{1,3}$/.test(octet) && Number(octet) <= 255) &&
    Number(octets[0]) === 127
  );
}
