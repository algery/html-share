import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import {
  PasswordManagementError,
  type AuthSessionService,
  type PasswordManagementAction,
  type PasswordManagementService,
} from "@html-share/core";

import { readSessionCookie } from "../auth/cookies.js";
import type { DeletionRateLimiter } from "./delete-rate-limit.js";
import { isTrustedWriteRequest } from "./write-request.js";

interface PasswordAccessRouteOptions {
  appHost: string;
  appWebUrl: string;
  limiter: DeletionRateLimiter;
  passwordManagement?: PasswordManagementService;
  sessions: AuthSessionService;
}

export function registerProjectPasswordAccessRoute(
  app: FastifyInstance,
  options: PasswordAccessRouteOptions,
) {
  app.post("/api/projects/:projectKey/password-access", async (request, reply) => {
    const session = await requireAppSession(request, reply, options);
    if (session === null) return;
    if (!isTrustedWriteRequest(request, reply, options)) return;
    const limit = options.limiter.consume({
      key: `password-management:${session.user.id}`,
      maximum: 10,
    });
    if (!limit.allowed) {
      return reply
        .header("retry-after", limit.retryAfterSeconds)
        .code(429)
        .send({ error: "password_management_rate_limited" });
    }
    if (options.passwordManagement === undefined) {
      return reply.code(503).send({ error: "password_management_unavailable" });
    }
    const projectKey = readProjectKey(request);
    const action = readAction(request.body);
    if (projectKey === null) return reply.code(404).send({ error: "not_found" });
    if (action === null) return reply.code(400).send({ error: "password_action_invalid" });

    try {
      const result = await options.passwordManagement.changeOwnedProjectAccess({
        action,
        ownerUserId: session.user.id,
        projectKey,
        requestIp: request.ip,
        traceId: request.id,
      });
      if (result.outcome === "not_found") return reply.code(404).send({ error: "not_found" });
      if (result.outcome === "conflict") {
        return reply.code(409).send({ error: "password_access_conflict" });
      }
      if (result.outcome === "upload_conflict") {
        return reply.code(409).send({ error: "project_upload_conflict" });
      }
      if ("access" in result) return { status: "updated", ...result.access };
      return reply.code(409).send({ error: "password_access_conflict" });
    } catch (error) {
      if (error instanceof PasswordManagementError && error.code === "INVALID_ACTION") {
        return reply.code(400).send({ error: "password_action_invalid" });
      }
      request.log.error(
        {
          code:
            error instanceof PasswordManagementError ? error.code : "PASSWORD_MANAGEMENT_FAILED",
          projectKey,
        },
        "password management failed",
      );
      return reply.code(503).send({ error: "password_management_unavailable" });
    }
  });
}

async function requireAppSession(
  request: FastifyRequest,
  reply: FastifyReply,
  options: Pick<PasswordAccessRouteOptions, "appHost" | "sessions">,
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

function readAction(body: unknown): PasswordManagementAction | null {
  if (typeof body !== "object" || body === null) return null;
  const action = (body as Record<string, unknown>)["action"];
  return action === "enable" || action === "regenerate" || action === "disable" ? action : null;
}

function readProjectKey(request: FastifyRequest) {
  const value = (request.params as Record<string, unknown>)["projectKey"];
  return typeof value === "string" && /^[a-z0-9]{5}$/.test(value) ? value : null;
}
