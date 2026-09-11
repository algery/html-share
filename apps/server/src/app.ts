import { registerInAppAuthCors, registerManagementApiCors } from "./app-cors.js";
import { registerPasswordAccess } from "./app-password-access.js";
import cookie from "@fastify/cookie";
import Fastify, { LogController, type FastifyInstance } from "fastify";

import type {
  AuthSessionService,
  McpTokenService,
  ProjectDeletionService,
  ProjectManagementReader,
  PasswordManagementService,
  ProjectReader,
  PasswordAccessService,
  UploadService,
} from "@html-share/core";
import type { DingTalkAuthorizationClient } from "@html-share/dingtalk";
import type { ObjectStore } from "@html-share/storage";

import { registerAuthRoutes } from "./modules/auth/routes.js";
import { registerAdminRoutes } from "./modules/admin/routes.js";
import { sendContentNotFound } from "./modules/content/error-pages.js";
import { registerContentRoutes } from "./modules/content/routes.js";
import { registerMcpRoutes } from "./modules/mcp/routes.js";
import { registerProjectRoutes } from "./modules/projects/routes.js";
import { registerProjectDeleteRoute } from "./modules/projects/delete-route.js";
import { registerProjectPasswordAccessRoute } from "./modules/projects/password-access-route.js";
import { createDeletionRateLimiter } from "./modules/projects/delete-rate-limit.js";
import { registerServerSecurity } from "./plugins/security.js";
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
  projectDeletion?: ProjectDeletionService;
  passwordAccess?: PasswordAccessService;
  passwordManagement?: PasswordManagementService;
  passwordStateSecret?: string;
  passwordRateLimits?: {
    ipPerMinute: number;
    ipProjectPerMinute: number;
    projectPerMinute: number;
  };
  dingtalk: DingTalkAuthorizationClient;
  logger?: boolean;
  mcpTokens: McpTokenService;
  projectManagement?: ProjectManagementReader;
  projects?: ProjectReader;
  rateLimits?: {
    authPerMinute: number;
    contentIpPerMinute: number;
    contentSessionPerMinute: number;
    mcpPerMinute: number;
    mcpUploadCompletePerMinute: number;
    mcpUploadPreparePerMinute: number;
  };
  storage?: ObjectStore;
  trustProxy?: boolean | string | string[];
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
    bodyLimit: 1_048_576,
    logController: new LogController({ disableRequestLogging: true }),
    logger: options.logger ?? true,
    trustProxy: options.trustProxy ?? false,
  });
  const deletionRateLimiter = createDeletionRateLimiter();
  const security = registerServerSecurity(app, {
    appHost: options.appHost,
    ...(options.rateLimits === undefined
      ? {}
      : { authRateLimitPerMinute: options.rateLimits.authPerMinute }),
    demoHost: options.demoHost,
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
  app.get("/health/metrics", (request, reply) => {
    if (request.hostname !== options.appHost) return reply.code(404).send({ error: "not_found" });
    return { metrics: security.telemetry.snapshot() };
  });
  app.addHook("onSend", async (request, reply, payload) => {
    const pathname = new URL(request.url, "http://management.local").pathname;
    if (
      request.hostname === options.appHost &&
      (pathname === "/auth/current" || pathname.startsWith("/api/"))
    )
      if (reply.getHeader("cache-control") === undefined) reply.header("cache-control", "no-store");
    return payload;
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
    ...(options.passwordAccess === undefined ? {} : { passwordAccess: options.passwordAccess }),
    ...(options.passwordStateSecret === undefined
      ? {}
      : { passwordStateSecret: options.passwordStateSecret }),
  });
  registerPasswordAccess(app, options);
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
    ...(options.passwordManagement === undefined
      ? {}
      : { passwordManagement: options.passwordManagement }),
    sessions: options.authSessions,
  });
  registerProjectDeleteRoute(app, {
    appHost: options.appHost,
    appWebUrl: options.appWebUrl,
    ...(options.projectDeletion === undefined ? {} : { deletion: options.projectDeletion }),
    limiter: deletionRateLimiter,
    sessions: options.authSessions,
  });
  registerProjectPasswordAccessRoute(app, {
    appHost: options.appHost,
    appWebUrl: options.appWebUrl,
    limiter: deletionRateLimiter,
    ...(options.passwordManagement === undefined
      ? {}
      : { passwordManagement: options.passwordManagement }),
    sessions: options.authSessions,
  });
  registerAdminRoutes(app, {
    appHost: options.appHost,
    appWebUrl: options.appWebUrl,
    ...(options.projectDeletion === undefined ? {} : { deletion: options.projectDeletion }),
    limiter: deletionRateLimiter,
    sessions: options.authSessions,
  });
  registerSkillRoutes(app, {
    appHost: options.appHost,
    appWebUrl: options.appWebUrl,
    sessions: options.authSessions,
  });
  registerMcpRoutes(app, {
    demoWebUrl: options.demoWebUrl,
    appHost: options.appHost,
    ...(options.rateLimits === undefined
      ? {}
      : {
          rateLimits: {
            mcpPerMinute: options.rateLimits.mcpPerMinute,
            uploadCompletePerMinute: options.rateLimits.mcpUploadCompletePerMinute,
            uploadPreparePerMinute: options.rateLimits.mcpUploadPreparePerMinute,
          },
        }),
    tokenService: options.mcpTokens,
    ...(options.storage === undefined ? {} : { storage: options.storage }),
    ...(options.uploads === undefined ? {} : { uploads: options.uploads }),
  });
  registerContentRoutes(app, {
    appAuthUrl: options.appAuthUrl,
    contentRateLimiter: security.contentLimiter,
    demoAuthUrl: options.demoAuthUrl,
    ...(options.passwordAccess === undefined ? {} : { passwordAccess: options.passwordAccess }),
    demoHost: options.demoHost,
    demoWebUrl: options.demoWebUrl,
    ...(options.rateLimits === undefined
      ? {}
      : {
          rateLimits: {
            ipPerMinute: options.rateLimits.contentIpPerMinute,
            sessionPerMinute: options.rateLimits.contentSessionPerMinute,
          },
        }),
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
