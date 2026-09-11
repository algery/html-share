import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import {
  ProjectDeletionError,
  type AuthSessionService,
  type ProjectDeletionService,
} from "@html-share/core";

import { readSessionCookie } from "../auth/cookies.js";
import { isTrustedWriteRequest } from "../projects/write-request.js";
import type { DeletionRateLimiter } from "../projects/delete-rate-limit.js";

export interface AdminRouteOptions {
  appHost: string;
  appWebUrl: string;
  deletion?: ProjectDeletionService;
  limiter: DeletionRateLimiter;
  sessions: AuthSessionService;
}

export function registerAdminRoutes(app: FastifyInstance, options: AdminRouteOptions) {
  app.get("/api/admin/projects/:projectKey", async (request, reply) => {
    const session = await requireAppSession(request, reply, options);
    if (session === null) return;
    if (options.deletion === undefined) return reply.code(503).send({ error: "admin_unavailable" });
    if (!options.deletion.isAdministrator(session.user))
      return reply.code(403).send({ error: "admin_forbidden" });
    const limit = options.limiter.consume({ key: `admin-query:${session.user.id}`, maximum: 30 });
    if (!limit.allowed) {
      await options.deletion.recordAdministratorRateLimit({
        actor: session.user,
        requestIp: request.ip,
        traceId: request.traceId,
      });
      return reply
        .header("retry-after", limit.retryAfterSeconds)
        .code(429)
        .send({ error: "admin_query_rate_limited" });
    }
    const projectKey = readProjectKey(request);
    if (projectKey === undefined) return reply.code(404).send({ error: "not_found" });
    try {
      const project = await options.deletion.findProjectAsAdministrator({
        actor: session.user,
        projectKey,
      });
      return project === null ? reply.code(404).send({ error: "not_found" }) : { project };
    } catch (error) {
      return respondToAdminError(error, reply);
    }
  });

  app.post("/api/admin/projects/:projectKey/delete", async (request, reply) => {
    const session = await requireAppSession(request, reply, options);
    if (session === null) return;
    if (!isTrustedWriteRequest(request, reply, options)) return;
    if (options.deletion === undefined) return reply.code(503).send({ error: "admin_unavailable" });
    if (!options.deletion.isAdministrator(session.user))
      return reply.code(403).send({ error: "admin_forbidden" });
    const limit = options.limiter.consume({ key: `admin-delete:${session.user.id}`, maximum: 5 });
    if (!limit.allowed) {
      await options.deletion.recordAdministratorRateLimit({
        actor: session.user,
        requestIp: request.ip,
        traceId: request.traceId,
      });
      return reply
        .header("retry-after", limit.retryAfterSeconds)
        .code(429)
        .send({ error: "admin_delete_rate_limited" });
    }
    const projectKey = readProjectKey(request);
    const reason = readString(request.body, "reason");
    if (projectKey === undefined || reason === undefined)
      return reply.code(400).send({ error: "invalid_request" });
    try {
      const result = await options.deletion.deleteProjectAsAdministrator({
        actor: session.user,
        projectKey,
        reason,
        requestIp: request.ip,
        traceId: request.traceId,
      });
      return result === "not_found"
        ? reply.code(404).send({ error: "not_found" })
        : { status: result };
    } catch (error) {
      return respondToAdminError(error, reply);
    }
  });
}

async function requireAppSession(
  request: FastifyRequest,
  reply: FastifyReply,
  options: Pick<AdminRouteOptions, "appHost" | "sessions">,
) {
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
  return session;
}

function respondToAdminError(error: unknown, reply: FastifyReply) {
  if (error instanceof ProjectDeletionError) {
    return reply
      .code(error.code === "ADMIN_FORBIDDEN" ? 403 : 400)
      .send({ error: error.code.toLowerCase() });
  }
  throw error;
}

function readProjectKey(request: FastifyRequest) {
  const value = (request.params as Record<string, unknown>)["projectKey"];
  return typeof value === "string" && /^[a-z0-9]{5}$/.test(value) ? value : undefined;
}

function readString(body: unknown, key: string) {
  if (typeof body !== "object" || body === null) return undefined;
  const value = (body as Record<string, unknown>)[key];
  return typeof value === "string" ? value : undefined;
}
