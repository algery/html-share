import type { FastifyInstance } from "fastify";
import { readSessionCookie } from "../auth/cookies.js";
import { isTrustedWriteRequest } from "./write-request.js";
import type { ProjectRouteOptions } from "./routes.js";

export function registerHomepageRoute(app: FastifyInstance, options: ProjectRouteOptions) {
  app.put<{ Params: { projectId: string }; Body: { relativePath?: unknown } }>(
    "/api/projects/:projectId/homepage",
    async (request, reply) => {
      if (request.hostname !== options.appHost) return reply.code(404).send({ error: "not_found" });
      const session = await options.sessions.getSession({
        audience: "app",
        token: readSessionCookie(request, "app"),
      });
      if (session === null) return reply.code(401).send({ error: "authentication_required" });
      if (!isTrustedWriteRequest(request, reply, options)) return;
      reply.header("Cache-Control", "private, no-store");
      if (!/^[a-z0-9]{5}$/.test(request.params.projectId))
        return reply.code(404).send({ error: "not_found" });
      const path = request.body?.relativePath;
      if (
        path !== null &&
        (typeof path !== "string" || path.length > 1024 || !/\.html?$/i.test(path))
      ) {
        return reply.code(400).send({ error: "invalid_homepage" });
      }
      if (!options.projects?.setOwnedHomepage)
        return reply.code(503).send({ error: "homepage_unavailable" });
      try {
        const result = await options.projects.setOwnedHomepage({
          ownerUserId: session.user.id,
          projectKey: request.params.projectId,
          relativePath: path,
        });
        if (result === "not_found") return reply.code(404).send({ error: "not_found" });
        if (result === "invalid_file")
          return reply.code(409).send({ error: "homepage_file_changed" });
        return { status: "updated" };
      } catch {
        return reply.code(503).send({ error: "homepage_unavailable" });
      }
    },
  );
}
