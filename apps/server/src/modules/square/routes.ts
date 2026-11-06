import type { FastifyInstance } from "fastify";
import type { SquareService } from "@html-share/core";
import { readSessionCookie } from "../auth/cookies.js";
import { isTrustedWriteRequest } from "../projects/write-request.js";
import { createWindowRateLimiter } from "../../plugins/rate-limit.js";
import {
  requireSquareSession,
  sendSquareError,
  validProjectKey,
  type SquareRequestOptions,
} from "./request.js";

export function registerSquareRoutes(
  app: FastifyInstance,
  options: SquareRequestOptions & { square?: SquareService },
) {
  const limiter = createWindowRateLimiter();
  app.get<{ Params: { projectId: string } }>(
    "/api/projects/:projectId/square",
    async (request, reply) => {
      const session = await requireSquareSession(request, reply, options, limiter);
      if (!session || !validProjectKey(request.params.projectId, reply)) return;
      try {
        if (!options.square) throw new Error("unavailable");
        const settings = await options.square.getSettings({
          tenantId: session.tenantId,
          ownerUserId: session.user.id,
          projectKey: request.params.projectId,
        });
        return {
          settings,
          csrfToken: options.sessions.createCsrfToken({
            audience: "app",
            token: readSessionCookie(request, "app"),
          }),
        };
      } catch (error) {
        return sendSquareError(error, reply, request.traceId);
      }
    },
  );
  app.put<{ Params: { projectId: string } }>(
    "/api/projects/:projectId/square",
    async (request, reply) => {
      const session = await requireSquareSession(request, reply, options, limiter, "write");
      if (!session || !validProjectKey(request.params.projectId, reply)) return;
      if (!isTrustedWriteRequest(request, reply, options)) return;
      try {
        if (!options.square) throw new Error("unavailable");
        const settings = await options.square.saveSettings({
          tenantId: session.tenantId,
          ownerUserId: session.user.id,
          projectKey: request.params.projectId,
          change: request.body,
          requestIp: request.ip,
          traceId: request.traceId,
        });
        return {
          settings,
          csrfToken: options.sessions.createCsrfToken({
            audience: "app",
            token: readSessionCookie(request, "app"),
          }),
        };
      } catch (error) {
        return sendSquareError(error, reply, request.traceId);
      }
    },
  );
  app.get<{ Querystring: { q?: string; page?: string; pageSize?: string } }>(
    "/api/square/projects",
    async (request, reply) => {
      const session = await requireSquareSession(request, reply, options, limiter);
      if (!session) return;
      try {
        if (!options.square) throw new Error("unavailable");
        return await options.square.listProjects({
          tenantId: session.tenantId,
          userId: session.user.id,
          ...(session.user.dingtalkUnionId ? { unionId: session.user.dingtalkUnionId } : {}),
          ...(request.query.q === undefined ? {} : { q: request.query.q }),
          ...(request.query.page === undefined ? {} : { page: Number(request.query.page) }),
          ...(request.query.pageSize === undefined
            ? {}
            : { pageSize: Number(request.query.pageSize) }),
        });
      } catch (error) {
        return sendSquareError(error, reply, request.traceId);
      }
    },
  );
  app.get<{ Params: { projectId: string } }>(
    "/api/square/projects/:projectId",
    async (request, reply) => {
      const session = await requireSquareSession(request, reply, options, limiter);
      if (!session || !validProjectKey(request.params.projectId, reply)) return;
      try {
        if (!options.square) throw new Error("unavailable");
        return await options.square.getProject({
          tenantId: session.tenantId,
          userId: session.user.id,
          projectKey: request.params.projectId,
          ...(session.user.dingtalkUnionId ? { unionId: session.user.dingtalkUnionId } : {}),
        });
      } catch (error) {
        return sendSquareError(error, reply, request.traceId);
      }
    },
  );
}
