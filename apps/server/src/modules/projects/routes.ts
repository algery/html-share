import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import {
  MAX_DEMOS_PER_USER,
  MAX_STORAGE_BYTES_PER_USER,
  type AuthSessionService,
  type ProjectManagementReader,
} from "@html-share/core";

import { readSessionCookie } from "../auth/cookies.js";

export interface ProjectRouteOptions {
  appHost: string;
  demoWebUrl: string;
  projects?: ProjectManagementReader;
  sessions: AuthSessionService;
}

export function registerProjectRoutes(app: FastifyInstance, options: ProjectRouteOptions) {
  app.get("/api/projects", async (request, reply) => {
    const session = await requireAppSession(request, reply, options);
    if (session === null) return;
    if (options.projects === undefined) {
      return reply.code(503).send({ error: "project_list_unavailable" });
    }

    const result = await options.projects.listOwnedActiveProjects({ ownerUserId: session.user.id });
    return {
      projects: result.projects.map((project) => ({
        createdAt: project.createdAt.toISOString(),
        displayName: project.displayName,
        fileCount: project.fileCount,
        projectId: project.projectKey,
        projectPrefix: new URL(`/${project.projectKey}/`, options.demoWebUrl).toString(),
        totalSize: project.totalSize,
        updatedAt: project.updatedAt.toISOString(),
      })),
      quota: {
        projectCount: result.quota.projectCount,
        projectLimit: MAX_DEMOS_PER_USER,
        storageBytes: result.quota.storageBytes,
        storageLimitBytes: MAX_STORAGE_BYTES_PER_USER,
      },
    };
  });
}

async function requireAppSession(
  request: FastifyRequest,
  reply: FastifyReply,
  options: Pick<ProjectRouteOptions, "appHost" | "sessions">,
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
