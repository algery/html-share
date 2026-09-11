import type { FastifyReply, FastifyRequest } from "fastify";
import type { AuthSessionService } from "@html-share/core";

import { readSessionCookie } from "../auth/cookies.js";

export function isTrustedWriteRequest(
  request: FastifyRequest,
  reply: FastifyReply,
  input: { appWebUrl: string; sessions: AuthSessionService },
) {
  if (request.headers.origin !== input.appWebUrl) {
    reply.code(403).send({ error: "origin_not_allowed" });
    return false;
  }
  const header = request.headers["x-html-share-csrf"];
  const token = Array.isArray(header) ? header[0] : header;
  if (
    typeof token !== "string" ||
    !input.sessions.validateCsrfToken({
      audience: "app",
      csrfToken: token,
      token: readSessionCookie(request, "app"),
    })
  ) {
    reply.code(403).send({ error: "csrf_invalid" });
    return false;
  }
  return true;
}
