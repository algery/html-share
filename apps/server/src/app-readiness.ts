import type { FastifyInstance } from "fastify";

/** Runtime SQL readiness is injectable so in-memory application fixtures stay isolated. */
export function registerServerReadiness(
  app: FastifyInstance,
  options: { appHost: string; demoHost: string; readiness?: () => Promise<void> },
): void {
  app.get("/health/ready", async (request, reply) => {
    if (request.hostname !== options.appHost) return reply.code(404).send({ error: "not_found" });
    try {
      if (!options.readiness) throw new Error("Readiness is not configured");
      await options.readiness();
      return { service: "server", status: "ok" };
    } catch {
      return reply.code(503).send({ service: "server", status: "not_ready" });
    }
  });
  app.addHook("onRequest", async (request, reply) => {
    if (!options.readiness || new URL(request.url, "http://local").pathname.startsWith("/health/"))
      return;
    try {
      await options.readiness();
    } catch {
      return reply.code(503).send({ error: "service_unavailable" });
    }
  });
}
