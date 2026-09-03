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

describe("server in-app authorization CORS", () => {
  let app: FastifyInstance;

  beforeEach(() => {
    app = buildServerApp({
      appAuthUrl: "http://app.localhost:3001",
      appHost: "app.localhost",
      appWebUrl: "http://app.localhost:3000",
      authSessions: createAuthSessionService({
        repository: new InMemoryAuthRepository(),
        stateSecret: "cors-state-signing-secret-with-enough-length",
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
        hashSecret: "cors-mcp-token-hash-secret-with-enough-length",
        repository: new InMemoryMcpTokenRepository(),
      }),
    });
  });

  afterEach(async () => {
    await app.close();
  });

  it("allows credentialed management authorization only from the configured management origin", async () => {
    const preflight = await app.inject({
      method: "OPTIONS",
      url: "/auth/internal/start",
      headers: { host: "app.localhost", origin: "http://app.localhost:3000" },
    });
    const rejected = await app.inject({
      method: "POST",
      url: "/auth/internal/start",
      headers: { host: "app.localhost", origin: "https://attacker.test" },
      payload: { returnPath: "/" },
    });

    expect(preflight.statusCode).toBe(204);
    expect(preflight.headers["access-control-allow-origin"]).toBe("http://app.localhost:3000");
    expect(preflight.headers["access-control-allow-credentials"]).toBe("true");
    expect(rejected.statusCode).toBe(403);
    expect(rejected.body).toBe('{"error":"origin_not_allowed"}');
  });

  it("allows Demo's own in-app authorization origin and rejects it at the management host", async () => {
    const demoPreflight = await app.inject({
      method: "OPTIONS",
      url: "/auth/internal/complete",
      headers: { host: "demo.localhost", origin: "http://demo.localhost:3001" },
    });
    const appRejected = await app.inject({
      method: "POST",
      url: "/auth/internal/start",
      headers: { host: "app.localhost", origin: "http://demo.localhost:3001" },
      payload: { returnPath: "/" },
    });

    expect(demoPreflight.statusCode).toBe(204);
    expect(demoPreflight.headers["access-control-allow-origin"]).toBe("http://demo.localhost:3001");
    expect(appRejected.statusCode).toBe(403);
  });
});
