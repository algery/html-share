import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";

import { createTelemetry } from "@html-share/observability";

import { buildWorkerApp } from "./app.js";

describe("worker application", () => {
  let app: FastifyInstance;

  beforeEach(() => {
    app = buildWorkerApp({ logger: false });
  });

  afterEach(async () => {
    await app.close();
  });

  it("serves the live health check", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/health/live",
    });

    expect(response.statusCode).toBe(200);
    expect(response.body).toBe('{"service":"worker","status":"ok"}');
  });

  it("exposes worker operation metrics with cleanup backlog counts", async () => {
    const telemetry = createTelemetry();
    telemetry.record({ failed: true, milliseconds: 15, name: "worker.cleanup.status.retry" });
    await app.close();
    app = buildWorkerApp({
      cleanupMetrics: async () => ({ pending: 2, retrying: 1, running: 0 }),
      logger: false,
      telemetry,
    });

    const response = await app.inject({ method: "GET", url: "/health/metrics" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      cleanup: { pending: 2, retrying: 1, running: 0 },
      metrics: {
        "worker.cleanup.status.retry": {
          count: 1,
          failures: 1,
          maxMilliseconds: 15,
          totalMilliseconds: 15,
        },
      },
      objectStorage: { bodyBytesRead: 0, getObjectCalls: 0 },
    });
  });
});
