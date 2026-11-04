import type { FastifyInstance } from "fastify";
import type { ServerAppOptions } from "./app.js";

export function registerInAppAuthCors(app: FastifyInstance, options: ServerAppOptions) {
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
        .header("access-control-expose-headers", "x-trace-id")
        .header("vary", "Origin");
    }
    if (request.method === "OPTIONS") {
      return reply.code(204).send();
    }
  });
}

export function registerManagementApiCors(app: FastifyInstance, appWebUrl: string) {
  app.addHook("onRequest", async (request, reply) => {
    const requestPath = new URL(request.url, "http://management.local").pathname;
    if (
      !request.url.startsWith("/api/tokens") &&
      !request.url.startsWith("/api/projects") &&
      !request.url.startsWith("/api/csrf") &&
      !request.url.startsWith("/api/admin/") &&
      !request.url.startsWith("/api/skills/") &&
      requestPath !== "/auth/current" &&
      requestPath !== "/auth/logout"
    )
      return;

    const origin = request.headers.origin;
    if (origin !== undefined && origin !== appWebUrl) {
      return reply.code(403).send({ error: "origin_not_allowed" });
    }
    if (origin === appWebUrl) {
      reply
        .header("access-control-allow-credentials", "true")
        .header("access-control-allow-headers", "content-type, x-html-share-csrf, x-trace-id")
        .header("access-control-allow-methods", "GET, POST, PUT, OPTIONS")
        .header("access-control-allow-origin", appWebUrl)
        .header("vary", "Origin");
    }
    if (request.method === "OPTIONS") {
      return reply.code(204).send();
    }
  });
}
