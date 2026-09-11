import Fastify from "fastify";
import { afterEach, describe, expect, it } from "vitest";

import { readServerEnv } from "@html-share/config";

import { createWindowRateLimiter } from "./rate-limit.js";
import { registerServerSecurity } from "./security.js";

const applications: ReturnType<typeof Fastify>[] = [];

describe("server security plugin", () => {
  afterEach(async () => {
    await Promise.all(applications.splice(0).map((app) => app.close()));
  });

  it("sets a generated trace id and browser security headers", async () => {
    const app = createApp();
    const response = await app.inject({
      method: "GET",
      url: "/ok",
      headers: { host: "app.localhost" },
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers["x-trace-id"]).toMatch(/^[0-9a-f-]{36}$/);
    expect(response.headers["cross-origin-opener-policy"]).toBe("same-origin");
    expect(response.headers["x-frame-options"]).toBe("DENY");
  });

  it("rejects untrusted Host values before routing", async () => {
    const app = createApp();
    const response = await app.inject({
      method: "GET",
      url: "/ok",
      headers: { host: "attacker.test" },
    });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({ service: "server", status: "not-found" });
  });

  it("accepts an IPv6 loopback Host normalized by server configuration", async () => {
    const environment = readServerEnv({
      APP_AUTH_URL: "http://[::1]:3001",
      APP_HOST: "::1",
      APP_WEB_URL: "http://[::1]:3000",
      AUTH_STATE_SECRET: "test-state-signing-secret-with-enough-length",
      DATABASE_URL: "postgresql://app:password@localhost:5432/app",
      DEMO_AUTH_URL: "http://demo.localhost:3001",
      DEMO_HOST: "demo.localhost",
      DEMO_WEB_URL: "http://demo.localhost:3001",
      MCP_TOKEN_HASH_SECRET: "test-mcp-token-hash-secret-with-enough-length",
      OBJECT_STORAGE_ACCESS_KEY_ID: "minio",
      OBJECT_STORAGE_ACCESS_KEY_SECRET: "minio-secret",
      OBJECT_STORAGE_BUCKET: "html-share",
      OBJECT_STORAGE_ENDPOINT: "http://localhost:9000",
      OBJECT_STORAGE_PROVIDER: "minio",
      OBJECT_STORAGE_REGION: "local",
      PASSWORD_MANAGEMENT_ENCRYPTION_KEY: "AgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgI=",
      PASSWORD_RESULT_ENCRYPTION_KEY: "AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE=",
      SERVER_HOST: "::1",
      SERVER_PORT: "3001",
    });
    expect(environment.APP_HOST).toBe("[::1]");
    const app = createApp({ appHost: environment.APP_HOST });
    const response = await app.inject({
      method: "GET",
      url: "/ok",
      headers: { host: "[::1]:3001" },
    });

    expect(response.statusCode).toBe(200);
  });

  it("limits login attempts per IP", async () => {
    const app = createApp();
    for (let index = 0; index < 30; index += 1) {
      expect(
        (
          await app.inject({
            method: "GET",
            url: "/auth/login",
            headers: { host: "app.localhost" },
          })
        ).statusCode,
      ).toBe(200);
    }
    const limited = await app.inject({
      method: "GET",
      url: "/auth/login",
      headers: { host: "app.localhost" },
    });
    expect(limited.statusCode).toBe(429);
    expect(limited.headers["retry-after"]).toBe("60");
  });

  it.each(["/auth/session-handoff/start", "/auth/session-handoff/complete"])(
    "limits %s before its handler runs",
    async (url) => {
      let calls = 0;
      const app = createApp({
        authRateLimitPerMinute: 1,
        onSessionHandoff: () => {
          calls += 1;
        },
      });
      expect(
        (await app.inject({ method: "GET", url, headers: { host: "app.localhost" } })).statusCode,
      ).toBe(200);
      const limited = await app.inject({
        method: "GET",
        url,
        headers: { host: "app.localhost" },
      });
      expect(limited.statusCode).toBe(429);
      expect(calls).toBe(1);
    },
  );

  it("uses a fixed one-minute window and reports retry seconds", () => {
    let now = new Date("2026-09-03T00:00:00.000Z");
    const limiter = createWindowRateLimiter({ now: () => now });
    expect(limiter.consume("ip:1", 1).allowed).toBe(true);
    expect(limiter.consume("ip:1", 1)).toEqual({ allowed: false, retryAfterSeconds: 60 });
    now = new Date(now.getTime() + 60_000);
    expect(limiter.consume("ip:1", 1).allowed).toBe(true);
  });

  it("uses the gateway's forwarded client IP only when proxy trust is enabled", async () => {
    const app = createApp({ trustProxy: true });
    const response = await app.inject({
      method: "GET",
      url: "/ip",
      headers: { host: "app.localhost", "x-forwarded-for": "203.0.113.42" },
    });

    expect(response.json()).toEqual({ ip: "203.0.113.42" });
  });

  it("does not trust a forwarded client IP from an unlisted source address", async () => {
    const app = createApp({ trustProxy: "172.30.0.2" });
    const response = await app.inject({
      method: "GET",
      url: "/ip",
      headers: { host: "app.localhost", "x-forwarded-for": "203.0.113.42" },
    });

    expect(response.json()).toEqual({ ip: "127.0.0.1" });
  });

  it("trusts forwarded HTTPS from the 1Panel gateway and dedicated application subnet", async () => {
    const app = createApp({ trustProxy: "127.0.0.1,172.18.0.1,172.31.240.0/24" });
    for (const remoteAddress of ["172.18.0.1", "172.31.240.254"]) {
      const response = await app.inject({
        method: "GET",
        url: "/request-metadata",
        remoteAddress,
        headers: {
          host: "demo.localhost",
          "x-forwarded-for": "203.0.113.42",
          "x-forwarded-proto": "https",
        },
      });

      expect(response.json()).toEqual({ ip: "203.0.113.42", protocol: "https" });
    }
  });
});

function createApp(options?: {
  appHost?: string;
  authRateLimitPerMinute?: number;
  demoHost?: string;
  onSessionHandoff?: () => void;
  trustProxy?: boolean | string;
}) {
  const app = Fastify({ logger: false, trustProxy: options?.trustProxy ?? false });
  applications.push(app);
  registerServerSecurity(app, {
    appHost: options?.appHost ?? "app.localhost",
    ...(options?.authRateLimitPerMinute === undefined
      ? {}
      : { authRateLimitPerMinute: options.authRateLimitPerMinute }),
    demoHost: options?.demoHost ?? "demo.localhost",
  });
  app.get("/ip", (request) => ({ ip: request.ip }));
  app.get("/request-metadata", (request) => ({ ip: request.ip, protocol: request.protocol }));
  app.get("/ok", () => ({ status: "ok" }));
  app.get("/auth/login", () => ({ status: "login" }));
  app.get("/auth/session-handoff/start", () => {
    options?.onSessionHandoff?.();
    return { status: "handoff" };
  });
  app.get("/auth/session-handoff/complete", () => {
    options?.onSessionHandoff?.();
    return { status: "handoff" };
  });
  return app;
}
