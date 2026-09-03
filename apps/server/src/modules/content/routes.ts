import type { FastifyInstance } from "fastify";

import type { AuthSessionService, ProjectReader } from "@html-share/core";
import type { ObjectStore } from "@html-share/storage";

import { readSessionCookie } from "../auth/cookies.js";
import { sendContentNotFound } from "./error-pages.js";
import { resolveDemoContentPath } from "./path-resolver.js";
import { applyDemoResponsePolicy, matchesEtag } from "./response-policy.js";

export interface ContentRouteOptions {
  demoHost: string;
  projects?: ProjectReader;
  sessions: AuthSessionService;
  storage?: ObjectStore;
}

export function registerContentRoutes(app: FastifyInstance, options: ContentRouteOptions) {
  app.route({
    method: ["GET", "HEAD"],
    url: "/*",
    handler: async (request, reply) => {
      if (request.hostname !== options.demoHost) return sendContentNotFound(reply);
      const session = await options.sessions.getSession({
        audience: "demo",
        token: readSessionCookie(request, "demo"),
      });
      if (session === null) {
        return reply.redirect(
          `/auth/content-login?return_path=${encodeURIComponent(request.raw.url ?? "/")}`,
        );
      }

      const path = resolveDemoContentPath(request.raw.url ?? request.url);
      if (path === null || options.projects === undefined || options.storage === undefined) {
        return sendContentNotFound(reply);
      }
      const file = await options.projects.findCurrentFile({
        ...path,
        tenantId: session.tenantId,
      });
      if (file === null) return sendContentNotFound(reply);

      let object;
      try {
        object = await options.storage.headObject(file.storageKey);
      } catch {
        return sendContentNotFound(reply);
      }
      if (object === null || object.size !== file.size) return sendContentNotFound(reply);

      if (matchesEtag(request.headers["if-none-match"], file.contentHash)) {
        applyDemoResponsePolicy(reply, file);
        return reply.code(304).send();
      }
      if (request.method === "HEAD") {
        applyDemoResponsePolicy(reply, file);
        return reply.code(200).send();
      }
      try {
        const body = await options.storage.getObject(file.storageKey);
        applyDemoResponsePolicy(reply, file);
        return reply.code(200).send(body);
      } catch {
        return sendContentNotFound(reply);
      }
    },
  });
}
