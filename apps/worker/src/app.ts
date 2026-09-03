import Fastify, { LogController, type FastifyInstance } from "fastify";

export interface WorkerAppOptions {
  logger?: boolean;
}

const LIVE_RESPONSE = {
  service: "worker",
  status: "ok",
} as const;

export function buildWorkerApp(options: WorkerAppOptions = {}): FastifyInstance {
  const app = Fastify({
    logController: new LogController({ disableRequestLogging: true }),
    logger: options.logger ?? true,
  });

  app.get("/health/live", () => LIVE_RESPONSE);

  return app;
}
