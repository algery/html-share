import type { FastifyReply, FastifyRequest } from "fastify";

import type { SessionAudience } from "@html-share/core";

const SESSION_DURATION_SECONDS = 8 * 60 * 60;

export function sessionCookieName(audience: SessionAudience) {
  return audience === "app" ? "html_share_app_session" : "html_share_demo_session";
}

export function readSessionCookie(request: FastifyRequest, audience: SessionAudience) {
  return request.cookies[sessionCookieName(audience)];
}

export function setSessionCookie(
  reply: FastifyReply,
  input: { audience: SessionAudience; token: string },
) {
  reply.setCookie(sessionCookieName(input.audience), input.token, {
    httpOnly: true,
    maxAge: SESSION_DURATION_SECONDS,
    path: "/",
    sameSite: "lax",
    secure: true,
  });
}

export function clearSessionCookie(reply: FastifyReply, audience: SessionAudience) {
  reply.clearCookie(sessionCookieName(audience), {
    httpOnly: true,
    path: "/",
    sameSite: "lax",
    secure: true,
  });
}
