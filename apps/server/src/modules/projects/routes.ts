import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import {
  MAX_DEMOS_PER_USER,
  MAX_STORAGE_BYTES_PER_USER,
  type AuthSessionService,
  type ProjectManagementReader,
  type PasswordManagementService,
  type ManagedProjectAccess,
} from "@html-share/core";

import { readSessionCookie } from "../auth/cookies.js";

export interface ProjectRouteOptions {
  appHost: string;
  demoWebUrl: string;
  projects?: ProjectManagementReader;
  passwordManagement?: PasswordManagementService;
  sessions: AuthSessionService;
}

export function registerProjectRoutes(app: FastifyInstance, options: ProjectRouteOptions) {
  app.get<{ Params: { projectId: string } }>("/api/projects/:projectId", async (request, reply) => {
    const session = await requireAppSession(request, reply, options);
    if (session === null) return;
    reply.header("Cache-Control", "private, no-store");
    if (!/^[a-z0-9]{5}$/.test(request.params.projectId)) {
      return reply.code(404).send({ error: "not_found" });
    }
    if (options.projects === undefined) {
      return reply.code(503).send({ error: "project_detail_unavailable" });
    }
    let project;
    try {
      project = await options.projects.findOwnedActiveProject({
        ownerUserId: session.user.id,
        projectKey: request.params.projectId,
      });
    } catch {
      return reply.code(503).send({ error: "project_detail_unavailable" });
    }
    if (project === null) return reply.code(404).send({ error: "not_found" });
    let access: ManagedProjectAccess = {
      accessMode: project.accessMode,
      passwordStatus: project.accessMode === "password" ? "unavailable" : "disabled",
    };
    if (options.passwordManagement !== undefined) {
      try {
        const managedAccess = await options.passwordManagement.readOwnedProjectAccess({
          ownerUserId: session.user.id,
          projectKey: project.projectKey,
        });
        if (managedAccess === null) return reply.code(404).send({ error: "not_found" });
        access = managedAccess;
      } catch {
        return reply.code(503).send({ error: "password_management_unavailable" });
      }
    }
    return {
      csrfToken: options.sessions.createCsrfToken({
        audience: "app",
        token: readSessionCookie(request, "app"),
      }),
      project: {
        ...access,
        createdAt: project.createdAt.toISOString(),
        displayName: project.displayName,
        fileCount: project.fileCount,
        projectId: project.projectKey,
        totalSize: project.totalSize,
        updatedAt: project.updatedAt.toISOString(),
      },
      files: project.files.map((file) => ({
        relativePath: file.relativePath,
        size: file.size,
        url: new URL(
          `/${project.projectKey}/${file.relativePath.split("/").map(encodeURIComponent).join("/")}`,
          options.demoWebUrl,
        ).toString(),
      })),
    };
  });

  app.get("/api/csrf", async (request, reply) => {
    const session = await requireAppSession(request, reply, options);
    if (session === null) return;
    return {
      csrfToken: options.sessions.createCsrfToken({
        audience: "app",
        token: readSessionCookie(request, "app"),
      }),
    };
  });

  app.get("/api/projects", async (request, reply) => {
    const session = await requireAppSession(request, reply, options);
    if (session === null) return;
    if (options.projects === undefined) {
      return reply.code(503).send({ error: "project_list_unavailable" });
    }

    const result = await options.projects.listOwnedActiveProjects({ ownerUserId: session.user.id });
    return {
      csrfToken: options.sessions.createCsrfToken({
        audience: "app",
        token: readSessionCookie(request, "app"),
      }),
      projects: result.projects.map((project) => ({
        accessMode: project.accessMode,
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
