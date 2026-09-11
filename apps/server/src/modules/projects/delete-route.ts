import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import type { AuthSessionService, ProjectDeletionService } from "@html-share/core";

import { readSessionCookie } from "../auth/cookies.js";
import { isTrustedWriteRequest } from "./write-request.js";
import type { DeletionRateLimiter } from "./delete-rate-limit.js";

export interface ProjectDeleteRouteOptions {
  appHost: string;
  appWebUrl: string;
  deletion?: ProjectDeletionService;
  limiter: DeletionRateLimiter;
  sessions: AuthSessionService;
}

export function registerProjectDeleteRoute(
  app: FastifyInstance,
  options: ProjectDeleteRouteOptions,
) {
  app.post("/api/projects/:projectKey/delete", async (request, reply) => {
    const session = await requireAppSession(request, reply, options);
    if (session === null) return;
    if (!isTrustedWriteRequest(request, reply, options)) return;
    const limit = options.limiter.consume({ key: `owner:${session.user.id}`, maximum: 10 });
    if (!limit.allowed)
      return reply
        .header("retry-after", limit.retryAfterSeconds)
        .code(429)
        .send({ error: "delete_rate_limited" });
    if (options.deletion === undefined)
      return reply.code(503).send({ error: "project_delete_unavailable" });
    const projectKey = readPathParameter(request, "projectKey");
    if (projectKey === undefined) return reply.code(404).send({ error: "not_found" });
    const confirmation = readString(request.body, "confirmation");
    if (confirmation !== projectKey)
      return reply.code(400).send({ error: "delete_confirmation_invalid" });
    const result = await options.deletion.deleteOwnedProject({
      projectKey,
      userId: session.user.id,
    });
    if (result === "forbidden") return reply.code(403).send({ error: "project_forbidden" });
    if (result === "not_found") return reply.code(404).send({ error: "not_found" });
    return { status: result };
  });
}

async function requireAppSession(
  request: FastifyRequest,
  reply: FastifyReply,
  options: Pick<ProjectDeleteRouteOptions, "appHost" | "sessions">,
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

function readPathParameter(request: FastifyRequest, key: string) {
  const value = (request.params as Record<string, unknown>)[key];
  return typeof value === "string" && /^[a-z0-9]{5}$/.test(value) ? value : undefined;
}

function readString(body: unknown, key: string) {
  if (typeof body !== "object" || body === null) return undefined;
  const value = (body as Record<string, unknown>)[key];
  return typeof value === "string" ? value : undefined;
}
