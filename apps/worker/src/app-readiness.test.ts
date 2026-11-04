import { expect, it, vi } from "vitest";

import { buildWorkerApp } from "./app.js";

it("tracks SQL readiness failures/recovery without exposing details or changing liveness", async () => {
  const readiness = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
  const app = buildWorkerApp({ logger: false, readiness });
  try {
    expect((await app.inject({ url: "/health/ready" })).statusCode).toBe(200);
    readiness.mockRejectedValue(new Error("mysql://private:secret@host/db private-instance"));
    const failed = await app.inject({ url: "/health/ready" });
    expect(failed.statusCode).toBe(503);
    expect(failed.json()).toEqual({ service: "worker", status: "not_ready" });
    expect((await app.inject({ url: "/health/live" })).statusCode).toBe(200);
    readiness.mockResolvedValue(undefined);
    expect((await app.inject({ url: "/health/ready" })).statusCode).toBe(200);
  } finally {
    await app.close();
  }
});

it("fails closed if the worker readiness callback is absent", async () => {
  const app = buildWorkerApp({ logger: false });
  try {
    expect((await app.inject({ url: "/health/ready" })).statusCode).toBe(503);
  } finally {
    await app.close();
  }
});
