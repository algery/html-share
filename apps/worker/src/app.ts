import Fastify, { LogController, type FastifyInstance } from "fastify";

import { createTelemetry, type Telemetry } from "@html-share/observability";
import type { ObjectStoreActivity } from "@html-share/storage";

export interface WorkerAppOptions {
  cleanupMetrics?: () => Promise<{ pending: number; retrying: number; running: number }>;
  logger?: boolean;
  readiness?: () => Promise<void>;
  objectStorageMetrics?: () => ObjectStoreActivity;
  telemetry?: Telemetry;
}

const LIVE_RESPONSE = {
  service: "worker",
  status: "ok",
} as const;

export function buildWorkerApp(options: WorkerAppOptions = {}): FastifyInstance {
  const telemetry = options.telemetry ?? createTelemetry();
  const app = Fastify({
    logController: new LogController({ disableRequestLogging: true }),
    logger: options.logger ?? true,
  });

  app.get("/health/live", () => LIVE_RESPONSE);
  app.get("/health/ready", async (_request, reply) => {
    try {
      if (!options.readiness) throw new Error("Readiness is not configured");
      await options.readiness();
      return LIVE_RESPONSE;
    } catch {
      return reply.code(503).send({ service: "worker", status: "not_ready" });
    }
  });
  app.get("/health/metrics", async (_request, reply) => {
    if (options.cleanupMetrics === undefined)
      return reply.code(503).send({ error: "metrics_unavailable" });
    return {
      cleanup: await options.cleanupMetrics(),
      metrics: telemetry.snapshot(),
      objectStorage: options.objectStorageMetrics?.() ?? {
        bodyBytesRead: 0,
        getObjectCalls: 0,
      },
    };
  });

  return app;
}
