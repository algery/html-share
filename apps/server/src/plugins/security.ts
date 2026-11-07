import type { FastifyInstance, FastifyReply } from "fastify";

import {
  createTelemetry,
  createTraceId,
  redactLogValue,
  type Telemetry,
} from "@html-share/observability";

import { createWindowRateLimiter, type WindowRateLimiter } from "./rate-limit.js";

declare module "fastify" {
  interface FastifyRequest {
    traceId: string;
    requestStartedAt: number;
  }
}

export interface SecurityOptions {
  appHost: string;
  authRateLimitPerMinute?: number;
  demoHost: string;
  telemetry?: Telemetry;
}

export interface SecurityServices {
  authLimiter: WindowRateLimiter;
  contentLimiter: WindowRateLimiter;
  telemetry: Telemetry;
}

/** Installs host, request-size, trace and browser security defaults. */
export function registerServerSecurity(
  app: FastifyInstance,
  options: SecurityOptions,
): SecurityServices {
  const authLimiter = createWindowRateLimiter();
  const contentLimiter = createWindowRateLimiter();
  const telemetry = options.telemetry ?? createTelemetry();
  const authMaximum = options.authRateLimitPerMinute ?? 30;

  app.decorateRequest("requestStartedAt", 0);
  app.decorateRequest("traceId", "");
  app.addHook("onRequest", async (request, reply) => {
    request.requestStartedAt = performance.now();
    request.traceId = createTraceId(readHeader(request.headers["x-trace-id"]));
    reply.header("x-trace-id", request.traceId);
    applySecurityHeaders(reply);

    if (
      request.url !== "/health/live" &&
      request.hostname !== options.appHost &&
      request.hostname !== options.demoHost
    ) {
      return reply.code(404).send({ service: "server", status: "not-found" });
    }
    if (isLoginAttempt(request.url)) {
      const limit = authLimiter.consume(`auth-ip:${request.ip}`, authMaximum);
      if (!limit.allowed) {
        telemetry.record({ failed: true, name: "auth_rate_limited" });
        return reply
          .header("retry-after", String(limit.retryAfterSeconds))
          .code(429)
          .send({ error: "auth_rate_limited" });
      }
    }
  });
  app.addHook("onResponse", async (request, reply) => {
    const action = requestAction(request.url);
    const milliseconds = Math.max(0, performance.now() - request.requestStartedAt);
    telemetry.record({
      failed: reply.statusCode >= 400,
      milliseconds,
      name: `operation.${action}.status.${reply.statusCode}`,
    });
    app.log.info(
      redactLogValue({
        action,
        duration_ms: Math.round(milliseconds),
        http_status: reply.statusCode,
        trace_id: request.traceId,
      }) as object,
      "request completed",
    );
  });
  app.addHook("onError", async (request, _reply, error) => {
    const action = requestAction(request.url);
    const code = errorCode(error);
    telemetry.record({ failed: true, name: `operation.${action}.failure.${code}` });
    app.log.warn(
      redactLogValue({ action, failure_type: code, trace_id: request.traceId }) as object,
      "request failed",
    );
  });

  return { authLimiter, contentLimiter, telemetry };
}

function applySecurityHeaders(reply: FastifyReply) {
  reply
    .header("cross-origin-opener-policy", "same-origin")
    .header("permissions-policy", "camera=(), geolocation=(), microphone=()")
    .header("referrer-policy", "no-referrer")
    .header("x-content-type-options", "nosniff")
    .header("x-frame-options", "DENY");
}

function isLoginAttempt(url: string) {
  const pathname = url.split("?", 1)[0];
  return (
    pathname === "/auth/login" ||
    pathname === "/auth/content-login" ||
    pathname === "/auth/callback" ||
    pathname === "/auth/session-handoff/start" ||
    pathname === "/auth/session-handoff/complete"
  );
}

function readHeader(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] : value;
}

function requestAction(url: string) {
  const pathname = url.split("?", 1)[0] ?? "/";
  if (pathname.startsWith("/auth/")) return "authorization";
  if (pathname === "/mcp") return "mcp";
  if (pathname.startsWith("/api/square/")) return "project_square";
  if (pathname.startsWith("/api/directory/")) return "organization_directory";
  if (/^\/api\/projects\/[^/]+\/square$/.test(pathname)) return "square_settings";
  if (pathname.startsWith("/api/projects")) return "project_management";
  if (pathname.startsWith("/api/tokens")) return "token_management";
  if (pathname.startsWith("/api/admin/")) return "admin_deletion";
  if (pathname.startsWith("/health/")) return "health";
  return "content_read";
}

function errorCode(error: unknown) {
  if (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof error.code === "string" &&
    /^[A-Z0-9_:-]{1,120}$/.test(error.code)
  ) {
    return error.code;
  }
  return "INTERNAL";
}
