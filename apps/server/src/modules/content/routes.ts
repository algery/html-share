import type { FastifyInstance } from "fastify";

import type { AuthSessionService, PasswordAccessService, ProjectReader } from "@html-share/core";
import type { ObjectStore } from "@html-share/storage";

import { authorizeContent } from "./authorize-content.js";
import { sendContentNotFound } from "./error-pages.js";
import { applyDemoResponsePolicy, matchesEtag } from "./response-policy.js";
import type { WindowRateLimiter } from "../../plugins/rate-limit.js";

export interface ContentRouteOptions {
  appAuthUrl: string;
  contentRateLimiter?: WindowRateLimiter;
  demoAuthUrl: string;
  demoHost: string;
  demoWebUrl: string;
  projects?: ProjectReader;
  passwordAccess?: PasswordAccessService;
  rateLimits?: { ipPerMinute: number; sessionPerMinute: number };
  sessions: AuthSessionService;
  storage?: ObjectStore;
}

export function registerContentRoutes(app: FastifyInstance, options: ContentRouteOptions) {
  app.route({
    method: ["GET", "HEAD"],
    url: "/*",
    handler: async (request, reply) => {
      if (request.hostname !== options.demoHost) return sendContentNotFound(reply);
      let authorized;
      try {
        authorized = await authorizeContent(request, reply, options);
      } catch {
        request.log.warn({ trace_id: request.traceId }, "content authorization unavailable");
        return reply
          .header("cache-control", "no-store")
          .code(503)
          .send({ error: "content_authorization_unavailable" });
      }
      if (authorized === null) return reply;
      const { file, principal } = authorized;
      const userLimit = options.contentRateLimiter?.consume(
        `content-principal:${principal}`,
        options.rateLimits?.sessionPerMinute ?? 600,
      );
      const ipLimit = options.contentRateLimiter?.consume(
        `content-ip:${request.ip}`,
        options.rateLimits?.ipPerMinute ?? 1200,
      );
      const limit = userLimit?.allowed === false ? userLimit : ipLimit;
      if (limit?.allowed === false) {
        return reply
          .header("retry-after", String(limit.retryAfterSeconds))
          .code(429)
          .send({ error: "content_rate_limited" });
      }

      if (options.storage === undefined) return sendContentNotFound(reply);

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
