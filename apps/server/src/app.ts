import cookie from "@fastify/cookie";
import Fastify, { LogController, type FastifyInstance } from "fastify";

import type {
  AuthSessionService,
  McpTokenService,
  ProjectManagementReader,
  ProjectReader,
  UploadService,
} from "@html-share/core";
import type { DingTalkAuthorizationClient } from "@html-share/dingtalk";
import type { ObjectStore } from "@html-share/storage";

import { registerAuthRoutes } from "./modules/auth/routes.js";
import { sendContentNotFound } from "./modules/content/error-pages.js";
import { registerContentRoutes } from "./modules/content/routes.js";
import { registerMcpRoutes } from "./modules/mcp/routes.js";
import { registerProjectRoutes } from "./modules/projects/routes.js";
import { registerSkillRoutes } from "./modules/skills/routes.js";
import { registerTokenRoutes } from "./modules/tokens/routes.js";

export interface ServerAppOptions {
  appAuthUrl: string;
  appHost: string;
  appWebUrl: string;
  authSessions: AuthSessionService;
  demoAuthUrl: string;
  demoHost: string;
  demoInAppClientId?: string;
  demoInAppCorpId?: string;
  demoWebUrl: string;
  dingtalk: DingTalkAuthorizationClient;
  logger?: boolean;
  mcpTokens: McpTokenService;
  projectManagement?: ProjectManagementReader;
  projects?: ProjectReader;
  storage?: ObjectStore;
  uploads?: UploadService;
}

const LIVE_RESPONSE = {
  service: "server",
  status: "ok",
} as const;

const UNKNOWN_HOST_RESPONSE = {
  service: "server",
  status: "not-found",
} as const;

export function buildServerApp(options: ServerAppOptions): FastifyInstance {
  const app = Fastify({
    logController: new LogController({ disableRequestLogging: true }),
    logger: options.logger ?? true,
  });

  app.addContentTypeParser(
    "application/x-www-form-urlencoded",
    { parseAs: "string" },
    (_request, body, done) => {
      const values: Record<string, string> = {};
      const encodedBody = typeof body === "string" ? body : body.toString("utf8");
      for (const [name, value] of new URLSearchParams(encodedBody)) {
        if (values[name] === undefined) values[name] = value;
      }
      done(null, values);
    },
  );
  app.register(cookie);
  registerInAppAuthCors(app, options);
  registerManagementApiCors(app, options.appWebUrl);

  app.get("/health/live", (request, reply) => {
    if (request.hostname === options.demoHost) return sendContentNotFound(reply);
    return LIVE_RESPONSE;
  });

  registerAuthRoutes(app, {
    appAuthUrl: options.appAuthUrl,
    appHost: options.appHost,
    appWebUrl: options.appWebUrl,
    demoAuthUrl: options.demoAuthUrl,
    demoHost: options.demoHost,
    ...(options.demoInAppClientId === undefined
      ? {}
      : { demoInAppClientId: options.demoInAppClientId }),
    ...(options.demoInAppCorpId === undefined ? {} : { demoInAppCorpId: options.demoInAppCorpId }),
    demoWebUrl: options.demoWebUrl,
    dingtalk: options.dingtalk,
    sessions: options.authSessions,
  });
  registerTokenRoutes(app, {
    appHost: options.appHost,
    appWebUrl: options.appWebUrl,
    sessions: options.authSessions,
    tokens: options.mcpTokens,
  });
  registerProjectRoutes(app, {
    appHost: options.appHost,
    demoWebUrl: options.demoWebUrl,
    ...(options.projectManagement === undefined ? {} : { projects: options.projectManagement }),
    sessions: options.authSessions,
  });
  registerSkillRoutes(app, {
    appHost: options.appHost,
    appWebUrl: options.appWebUrl,
    sessions: options.authSessions,
  });
  registerMcpRoutes(app, {
    appHost: options.appHost,
    tokenService: options.mcpTokens,
    ...(options.storage === undefined ? {} : { storage: options.storage }),
    ...(options.uploads === undefined ? {} : { uploads: options.uploads }),
  });
  registerContentRoutes(app, {
    demoHost: options.demoHost,
    ...(options.projects === undefined ? {} : { projects: options.projects }),
    sessions: options.authSessions,
    ...(options.storage === undefined ? {} : { storage: options.storage }),
  });

  app.get("/", (request, reply) => {
    const host = request.hostname;

    if (host === options.appHost) {
      return {
        service: "server",
        phase: 1,
        gateway: "app",
        status: "gateway-ready",
      } as const;
    }

    if (host === options.demoHost) return sendContentNotFound(reply);

    return reply.code(404).send(UNKNOWN_HOST_RESPONSE);
  });

  return app;
}

function registerInAppAuthCors(app: FastifyInstance, options: ServerAppOptions) {
  app.addHook("onRequest", async (request, reply) => {
    if (!request.url.startsWith("/auth/internal/")) return;

    const allowedOrigin =
      request.hostname === options.appHost
        ? options.appWebUrl
        : request.hostname === options.demoHost
          ? options.demoWebUrl
          : undefined;
    const origin = request.headers.origin;
    if (allowedOrigin === undefined || (origin !== undefined && origin !== allowedOrigin)) {
      return reply.code(403).send({ error: "origin_not_allowed" });
    }
    if (origin === allowedOrigin) {
      reply
        .header("access-control-allow-credentials", "true")
        .header("access-control-allow-headers", "content-type")
        .header("access-control-allow-methods", "POST, OPTIONS")
        .header("access-control-allow-origin", allowedOrigin)
        .header("vary", "Origin");
    }
    if (request.method === "OPTIONS") {
      return reply.code(204).send();
    }
  });
}

function registerManagementApiCors(app: FastifyInstance, appWebUrl: string) {
  app.addHook("onRequest", async (request, reply) => {
    if (
      !request.url.startsWith("/api/tokens") &&
      !request.url.startsWith("/api/projects") &&
      !request.url.startsWith("/api/skills/")
    )
      return;

    const origin = request.headers.origin;
    if (origin !== undefined && origin !== appWebUrl) {
      return reply.code(403).send({ error: "origin_not_allowed" });
    }
    if (origin === appWebUrl) {
      reply
        .header("access-control-allow-credentials", "true")
        .header("access-control-allow-headers", "content-type")
        .header("access-control-allow-methods", "GET, POST, OPTIONS")
        .header("access-control-allow-origin", appWebUrl)
        .header("vary", "Origin");
    }
    if (request.method === "OPTIONS") {
      return reply.code(204).send();
    }
  });
}
