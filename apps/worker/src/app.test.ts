import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";

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
});
