import { afterEach, describe, expect, it, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";

import { registerServerReadiness } from "./app-readiness.js";

const apps: FastifyInstance[] = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

function fixture(readiness?: () => Promise<void>) {
  const app = Fastify({ logger: false });
  apps.push(app);
  registerServerReadiness(app, {
    appHost: "app.localhost",
    demoHost: "demo.localhost",
    ...(readiness ? { readiness } : {}),
  });
  app.get("/health/live", () => ({ status: "ok" }));
  const write = vi.fn(() => ({ status: "written" }));
  app.post("/business", write);
  return { app, write };
}

describe("server runtime readiness", () => {
  it("reports SQL/schema outage as 503 while live remains healthy and blocks business writes", async () => {
    const readiness = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
    const { app, write } = fixture(readiness);
    expect(
      (await app.inject({ url: "/health/ready", headers: { host: "app.localhost" } })).statusCode,
    ).toBe(200);
    readiness.mockRejectedValue(new Error("postgresql://user:secret@host/db identity-private"));
    const ready = await app.inject({ url: "/health/ready", headers: { host: "app.localhost" } });
    expect(ready.statusCode).toBe(503);
    expect(ready.json()).toEqual({ service: "server", status: "not_ready" });
    expect((await app.inject({ url: "/health/live" })).statusCode).toBe(200);
    expect((await app.inject({ method: "POST", url: "/business" })).statusCode).toBe(503);
    expect(write).not.toHaveBeenCalled();
    readiness.mockResolvedValue(undefined);
    expect((await app.inject({ method: "POST", url: "/business" })).statusCode).toBe(200);
    expect(write).toHaveBeenCalledOnce();
  });

  it("does not expose the management readiness endpoint on Demo or unknown hosts", async () => {
    const readiness = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
    const { app } = fixture(readiness);
    for (const host of ["demo.localhost", "unknown.localhost"]) {
      expect((await app.inject({ url: "/health/ready", headers: { host } })).statusCode).toBe(404);
    }
    expect(readiness).not.toHaveBeenCalled();
  });

  it("keeps in-memory fixtures compatible while unconfigured readiness fails closed", async () => {
    const { app } = fixture();
    expect((await app.inject({ method: "POST", url: "/business" })).statusCode).toBe(200);
    expect(
      (await app.inject({ url: "/health/ready", headers: { host: "app.localhost" } })).statusCode,
    ).toBe(503);
  });
});
