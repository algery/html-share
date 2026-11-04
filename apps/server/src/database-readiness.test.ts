import { expect, it, vi } from "vitest";

import {
  createAuthSessionService,
  createMcpTokenService,
  InMemoryAuthRepository,
  InMemoryMcpTokenRepository,
} from "@html-share/core";
import { createSimulatorDingTalkClient } from "@html-share/dingtalk";

import { buildServerApp } from "./app.js";

it("wires runtime database readiness into the real server before authorization writes", async () => {
  const readiness = vi.fn<() => Promise<void>>().mockRejectedValue(new Error("database private"));
  const repository = new InMemoryAuthRepository();
  const dingtalk = createSimulatorDingTalkClient();
  const write = vi.spyOn(repository, "createAuthState");
  const app = buildServerApp({
    appAuthUrl: "http://app.localhost:3001",
    appHost: "app.localhost",
    appWebUrl: "http://app.localhost:3000",
    authSessions: createAuthSessionService({
      repository,
      stateSecret: "test-state-signing-secret-with-enough-length",
      tenantAppKeyRef: "test-dingtalk-app",
    }),
    demoAuthUrl: "http://demo.localhost:3001",
    demoHost: "demo.localhost",
    demoWebUrl: "http://demo.localhost:3001",
    dingtalk,
    logger: false,
    readiness,
    mcpTokens: createMcpTokenService({
      hashSecret: "test-mcp-token-hash-secret-with-enough-length",
      repository: new InMemoryMcpTokenRepository(),
    }),
  });
  try {
    const headers = { host: "app.localhost" };
    const blocked = await app.inject({ url: "/auth/login", headers });
    expect(blocked.statusCode).toBe(503);
    expect(blocked.json()).toEqual({ error: "service_unavailable" });
    expect(write).not.toHaveBeenCalled();
    expect((await app.inject({ url: "/health/ready", headers })).statusCode).toBe(503);
    expect((await app.inject({ url: "/health/live", headers })).statusCode).toBe(200);
    readiness.mockResolvedValue(undefined);
    expect((await app.inject({ url: "/auth/login", headers })).statusCode).toBe(302);
    expect(write).toHaveBeenCalledOnce();
  } finally {
    await app.close();
  }
});
