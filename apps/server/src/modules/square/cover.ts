import type { SquareService } from "@html-share/core";
import type { ObjectStore } from "@html-share/storage";
import type { FastifyInstance } from "fastify";

import type { WindowRateLimiter } from "../../plugins/rate-limit.js";
import {
  requireSquareSession,
  sendSquareError,
  validProjectKey,
  type SquareRequestOptions,
} from "./request.js";

export function registerSquareCoverRoute(
  app: FastifyInstance,
  options: SquareRequestOptions & { square?: SquareService; storage?: ObjectStore },
  limiter: WindowRateLimiter,
) {
  app.get<{ Params: { projectId: string; targetHash: string } }>(
    "/api/square/projects/:projectId/cover/:targetHash",
    async (request, reply) => {
      const session = await requireSquareSession(request, reply, options, limiter, "cover");
      if (!session || !validProjectKey(request.params.projectId, reply)) return;
      if (!/^[a-f0-9]{64}$/.test(request.params.targetHash))
        return reply.code(404).send({ error: "not_found" });
      try {
        if (!options.square || !options.storage) throw new Error("unavailable");
        const key = await options.square.getCover({
          tenantId: session.tenantId,
          userId: session.user.id,
          ...(session.user.dingtalkUnionId ? { unionId: session.user.dingtalkUnionId } : {}),
          projectKey: request.params.projectId,
          targetHash: request.params.targetHash,
        });
        const body = await options.storage.getObject(key);
        return reply.type("image/jpeg").header("x-content-type-options", "nosniff").send(body);
      } catch (error) {
        return sendSquareError(error, reply, request.traceId);
      }
    },
  );
}
