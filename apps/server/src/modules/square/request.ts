import type { FastifyReply, FastifyRequest } from "fastify";
import { SquareError, type AuthSessionService } from "@html-share/core";
import { readSessionCookie } from "../auth/cookies.js";
import type { WindowRateLimiter } from "../../plugins/rate-limit.js";

export interface SquareRequestOptions {
  appHost: string;
  appWebUrl: string;
  sessions: AuthSessionService;
}

export async function requireSquareSession(
  request: FastifyRequest,
  reply: FastifyReply,
  options: SquareRequestOptions,
  limiter: WindowRateLimiter,
  action: "read" | "write" | "directory" | "cover" = "read",
) {
  reply.header("cache-control", "private, no-store");
  if (request.hostname !== options.appHost) {
    reply.code(404).send({ error: "not_found" });
    return null;
  }
  const session = await options.sessions.getSession({
    audience: "app",
    token: readSessionCookie(request, "app"),
  });
  if (session === null) {
    reply.code(401).send({ error: "authentication_required" });
    return null;
  }
  const limit = limiter.consume(
    JSON.stringify([session.tenantId, session.user.id, action]),
    action === "write" ? 10 : action === "directory" ? 60 : action === "cover" ? 300 : 120,
  );
  if (!limit.allowed) {
    reply
      .header("retry-after", String(limit.retryAfterSeconds))
      .code(429)
      .send({ error: "rate_limited", message: "请求较频繁，请稍后重试。" });
    return null;
  }
  return session;
}

export function sendSquareError(error: unknown, reply: FastifyReply, traceId: string) {
  if (error instanceof SquareError) {
    return reply
      .code(error.statusCode)
      .send({ error: error.code, message: error.message, traceId });
  }
  return reply.code(503).send({
    error: "square_unavailable",
    message: "项目广场暂时不可用，请稍后重试。",
    traceId,
  });
}

export function validProjectKey(projectId: string, reply: FastifyReply) {
  if (/^[a-z0-9]{5}$/.test(projectId)) return true;
  reply.code(404).send({ error: "not_found" });
  return false;
}
