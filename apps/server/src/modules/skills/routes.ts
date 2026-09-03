import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import type { AuthSessionService } from "@html-share/core";

import { readSessionCookie } from "../auth/cookies.js";

const SKILL_ARCHIVES = {
  "claude-code": "claude-code-html-share.zip",
  codex: "codex-html-share.zip",
} as const;

export interface SkillRouteOptions {
  appHost: string;
  appWebUrl: string;
  sessions: AuthSessionService;
}

export function registerSkillRoutes(app: FastifyInstance, options: SkillRouteOptions) {
  app.get("/api/skills/:host", async (request, reply) => {
    const session = await requireAppSession(request, reply, options);
    if (session === null) return;
    const host = readHost(request);
    if (host === undefined) return reply.code(404).send({ error: "skill_not_found" });

    reply.header("cache-control", "private, max-age=300");
    return reply.redirect(new URL(`/skills/${SKILL_ARCHIVES[host]}`, options.appWebUrl).toString());
  });
}

async function requireAppSession(
  request: FastifyRequest,
  reply: FastifyReply,
  options: Pick<SkillRouteOptions, "appHost" | "sessions">,
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

function readHost(request: FastifyRequest): keyof typeof SKILL_ARCHIVES | undefined {
  const value = (request.params as Record<string, unknown>)["host"];
  return typeof value === "string" && value in SKILL_ARCHIVES
    ? (value as keyof typeof SKILL_ARCHIVES)
    : undefined;
}
