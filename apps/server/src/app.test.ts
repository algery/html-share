import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";

import {
  createAuthSessionService,
  createMcpTokenService,
  InMemoryAuthRepository,
  InMemoryMcpTokenRepository,
} from "@html-share/core";
import { createSimulatorDingTalkClient } from "@html-share/dingtalk";

import { buildServerApp } from "./app.js";

describe("server application", () => {
  let app: FastifyInstance;

  beforeEach(() => {
    app = buildServerApp({
      appAuthUrl: "http://app.localhost:3001",
      appHost: "app.localhost",
      appWebUrl: "http://app.localhost:3000",
      authSessions: createAuthSessionService({
        repository: new InMemoryAuthRepository(),
        stateSecret: "test-state-signing-secret-with-enough-length",
        tenantAppKeyRef: "test-dingtalk-app",
      }),
      demoAuthUrl: "http://demo.localhost:3001",
      demoHost: "demo.localhost",
      demoInAppClientId: "demo-client-id",
      demoInAppCorpId: "demo-corp-id",
      demoWebUrl: "http://demo.localhost:3001",
      dingtalk: createSimulatorDingTalkClient(),
      logger: false,
      mcpTokens: createMcpTokenService({
        hashSecret: "test-mcp-token-hash-secret-with-enough-length",
        repository: new InMemoryMcpTokenRepository(),
      }),
    });
  });

  afterEach(async () => {
    await app.close();
  });

  it("serves the live health check independently of Host", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/health/live",
      headers: { host: "unknown.localhost" },
    });

    expect(response.statusCode).toBe(200);
    expect(response.body).toBe('{"service":"server","status":"ok"}');
  });

  it("routes the configured app Host to the app gateway", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/",
      headers: { host: "app.localhost:3100" },
    });

    expect(response.statusCode).toBe(200);
    expect(response.body).toBe(
      '{"service":"server","phase":1,"gateway":"app","status":"gateway-ready"}',
    );
  });

  it("routes the configured demo Host to the demo gateway", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/",
      headers: { host: "demo.localhost:3100" },
    });

    expect(response.statusCode).toBe(404);
    expect(response.headers["x-robots-tag"]).toBe("noindex");
  });

  it("rejects every unconfigured Host", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/",
      headers: { host: "app.localhost.attacker.test" },
    });

    expect(response.statusCode).toBe(404);
    expect(response.body).toBe('{"service":"server","status":"not-found"}');
  });

  it("completes external app authorization with a Host-only secure cookie", async () => {
    const login = await app.inject({
      method: "GET",
      url: "/auth/login?return_path=/login",
      headers: { host: "app.localhost" },
    });
    const callback = new URL(readLocation(login));
    const completed = await app.inject({
      method: "GET",
      url: `${callback.pathname}${callback.search}`,
      headers: { host: "app.localhost" },
    });
    const cookie = readCookie(completed);
    const current = await app.inject({
      method: "GET",
      url: "/auth/current",
      headers: { cookie, host: "app.localhost" },
    });

    expect(login.statusCode).toBe(302);
    expect(completed.statusCode).toBe(302);
    expect(readLocation(completed)).toBe("http://app.localhost:3000/login");
    expect(completed.headers["set-cookie"]).toContain("HttpOnly");
    expect(completed.headers["set-cookie"]).toContain("Secure");
    expect(completed.headers["set-cookie"]).toContain("SameSite=Lax");
    expect(completed.headers["set-cookie"]).not.toContain("Domain=");
    expect(current.statusCode).toBe(200);
    expect(current.json()).toMatchObject({ user: { dingtalkUserId: "simulator-user-001" } });
  });

  it("isolates demo sessions and returns the exact signed path after internal authorization", async () => {
    const start = await app.inject({
      method: "POST",
      url: "/auth/internal/start",
      headers: { host: "demo.localhost" },
      payload: { returnPath: "/3h32g/a.html" },
    });
    const { state } = start.json<{ state: string }>();
    const completed = await app.inject({
      method: "POST",
      url: "/auth/internal/complete",
      headers: { host: "demo.localhost" },
      payload: { code: "simulator-member", state },
    });
    const cookie = readCookie(completed);
    const content = await app.inject({
      method: "GET",
      url: "/auth/content",
      headers: { cookie, host: "demo.localhost" },
    });
    const appCurrent = await app.inject({
      method: "GET",
      url: "/auth/current",
      headers: { cookie, host: "app.localhost" },
    });

    expect(start.statusCode).toBe(200);
    expect(completed.statusCode).toBe(302);
    expect(readLocation(completed)).toBe("http://demo.localhost:3001/3h32g/a.html");
    expect(content.statusCode).toBe(200);
    expect(appCurrent.statusCode).toBe(401);
  });

  it("returns an external-browser Demo authorization to its exact original path", async () => {
    const login = await app.inject({
      method: "GET",
      url: "/auth/login?return_path=/3h32g/a.html",
      headers: { host: "demo.localhost" },
    });
    const callback = new URL(readLocation(login));
    const completed = await app.inject({
      method: "GET",
      url: `${callback.pathname}${callback.search}`,
      headers: { host: "demo.localhost" },
    });
    const cookie = readCookie(completed);
    const content = await app.inject({
      method: "GET",
      url: "/auth/content",
      headers: { cookie, host: "demo.localhost" },
    });

    expect(completed.statusCode).toBe(302);
    expect(readLocation(completed)).toBe("http://demo.localhost:3001/3h32g/a.html");
    expect(content.statusCode).toBe(200);
  });

  it("rejects open redirects, replay, cross-audience callbacks, and denied identities", async () => {
    const unsafePath = await app.inject({
      method: "GET",
      url: "/auth/login?return_path=https://attacker.test",
      headers: { host: "demo.localhost" },
    });
    const start = await app.inject({
      method: "POST",
      url: "/auth/internal/start",
      headers: { host: "demo.localhost" },
      payload: { returnPath: "/3h32g/a.html" },
    });
    const { state } = start.json<{ state: string }>();
    const wrongHost = await app.inject({
      method: "GET",
      url: `/auth/callback?code=simulator-external-member&state=${encodeURIComponent(state)}`,
      headers: { host: "app.localhost" },
    });
    const replay = await app.inject({
      method: "POST",
      url: "/auth/internal/complete",
      headers: { host: "demo.localhost" },
      payload: { code: "simulator-member", state },
    });
    const deniedLogin = await app.inject({
      method: "GET",
      url: "/auth/login",
      headers: { host: "app.localhost" },
    });
    const deniedCallback = new URL(readLocation(deniedLogin));
    deniedCallback.searchParams.set("code", "simulator-denied");
    const denied = await app.inject({
      method: "GET",
      url: `${deniedCallback.pathname}${deniedCallback.search}`,
      headers: { host: "app.localhost" },
    });

    expect(unsafePath.statusCode).toBe(400);
    expect(wrongHost.statusCode).toBe(400);
    expect(wrongHost.headers["set-cookie"]).toBeUndefined();
    expect(replay.statusCode).toBe(400);
    expect(denied.statusCode).toBe(403);
    expect(denied.body).toBe('{"error":"organization_access_denied"}');
    expect(denied.body).not.toContain("simulator-denied");
    expect(denied.headers["set-cookie"]).toBeUndefined();
  });

  it("revokes the current audience session on logout", async () => {
    const login = await app.inject({
      method: "GET",
      url: "/auth/login",
      headers: { host: "app.localhost" },
    });
    const callback = new URL(readLocation(login));
    const completed = await app.inject({
      method: "GET",
      url: `${callback.pathname}${callback.search}`,
      headers: { host: "app.localhost" },
    });
    const cookie = readCookie(completed);
    const logout = await app.inject({
      method: "POST",
      url: "/auth/logout",
      headers: { cookie, host: "app.localhost" },
    });
    const current = await app.inject({
      method: "GET",
      url: "/auth/current",
      headers: { cookie, host: "app.localhost" },
    });

    expect(logout.statusCode).toBe(204);
    expect(logout.headers["set-cookie"]).toContain("Max-Age=0");
    expect(current.statusCode).toBe(401);
  });
});

function readLocation(response: { headers: Record<string, unknown> }) {
  const location = response.headers["location"];
  if (typeof location !== "string") throw new Error("location header missing");
  return location;
}

function readCookie(response: { headers: Record<string, unknown> }) {
  const header = response.headers["set-cookie"];
  const value = Array.isArray(header) ? header[0] : header;
  if (typeof value !== "string") throw new Error("set-cookie header missing");
  const [cookie] = value.split(";");
  if (cookie === undefined) throw new Error("cookie missing");
  return cookie;
}
