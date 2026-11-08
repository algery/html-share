import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";

import {
  createAuthSessionService,
  createMcpTokenService,
  InMemoryAuthRepository,
  InMemoryMcpTokenRepository,
} from "@html-share/core";
import { createSimulatorDingTalkClient } from "@html-share/dingtalk";

import { buildServerApp } from "./app.js";
import { checkConnection, getTokenWriteHeaders } from "../tests/phase3-helpers.js";

const HASH_SECRET = "test-mcp-token-hash-secret-with-enough-length";
const USER = {
  dingtalkUserId: "simulator-user-001",
  displayName: "Simulator Member",
  id: "user-1",
};

describe("Phase 3 Token and MCP endpoints", () => {
  const applications: FastifyInstance[] = [];

  afterEach(async () => {
    await Promise.all(applications.splice(0).map((app) => app.close()));
  });

  it("creates a Token once, hides it on refresh, and revokes it for its owner", async () => {
    const { app } = buildTestApp();
    applications.push(app);
    const headers = await getTokenWriteHeaders(app);

    const unauthorized = await app.inject({
      method: "GET",
      url: "/api/tokens",
      headers: { host: "app.localhost" },
    });
    const rejectedOrigin = await app.inject({
      method: "POST",
      url: "/api/tokens",
      headers: { ...headers, origin: "https://attacker.test" },
      payload: { name: "Codex" },
    });
    const created = await app.inject({
      method: "POST",
      url: "/api/tokens",
      headers,
      payload: { name: "Codex laptop" },
    });
    const createdBody = created.json<{
      token: { id: string; createdAt: string; expiresAt: string };
      value: string;
    }>();
    expect(Date.parse(createdBody.token.expiresAt) - Date.parse(createdBody.token.createdAt)).toBe(
      30 * 86_400_000,
    );
    const listed = await app.inject({
      method: "GET",
      url: "/api/tokens",
      headers,
    });
    const revoked = await app.inject({
      method: "POST",
      url: `/api/tokens/${createdBody.token.id}/revoke`,
      headers,
    });

    expect(unauthorized.statusCode).toBe(401);
    expect(rejectedOrigin.statusCode).toBe(403);
    expect(created.statusCode).toBe(201);
    expect(created.headers["cache-control"]).toBe("no-store");
    expect(createdBody.value).toMatch(/^hsp_[A-Za-z0-9_-]{43}$/);
    expect(listed.statusCode).toBe(200);
    expect(listed.body).not.toContain(createdBody.value);
    expect(listed.json()).toMatchObject({
      tokens: [{ status: "active", tokenSuffix: createdBody.value.slice(-6) }],
    });
    expect(revoked.statusCode).toBe(204);
    expect(
      (
        await app.inject({
          method: "GET",
          url: "/api/tokens",
          headers,
        })
      ).json(),
    ).toMatchObject({ tokens: [{ status: "revoked" }] });
  });

  it("accepts finite and permanent validity and rejects unsupported values on creation", async () => {
    const { app } = buildTestApp();
    applications.push(app);
    const headers = await getTokenWriteHeaders(app);

    const issue = (expiresInDays: unknown) =>
      app.inject({
        method: "POST",
        url: "/api/tokens",
        headers,
        payload: { name: "Validity test", expiresInDays },
      });

    for (const expiresInDays of [1, 7, 15, 30, "never"] as const) {
      const response = await issue(expiresInDays);
      expect(response.statusCode).toBe(201);
      const { token } = response.json<{ token: { createdAt: string; expiresAt: string | null } }>();
      expect(token.expiresAt).toBe(
        expiresInDays === "never"
          ? null
          : new Date(Date.parse(token.createdAt) + expiresInDays * 86_400_000).toISOString(),
      );
    }

    for (const expiresInDays of [0, 14, "30", "", null]) {
      const response = await issue(expiresInDays);
      expect(response.statusCode).toBe(400);
      expect(response.json()).toEqual({ error: "invalid_token_validity" });
    }
    const listed = await app.inject({ method: "GET", url: "/api/tokens", headers });
    expect(listed.json().tokens).toHaveLength(5);
  });

  it("rejects missing and query-string credentials and blocks the demo Host", async () => {
    const { app } = buildTestApp();
    applications.push(app);

    const missing = await app.inject({
      method: "POST",
      url: "/mcp",
      headers: { host: "app.localhost" },
    });
    const query = await app.inject({
      method: "POST",
      url: "/mcp?token=not-accepted",
      headers: { authorization: "Bearer invalid", host: "app.localhost" },
    });
    const demo = await app.inject({
      method: "POST",
      url: "/mcp",
      headers: { authorization: "Bearer invalid", host: "demo.localhost" },
    });

    expect(missing.statusCode).toBe(401);
    expect(missing.headers["www-authenticate"]).toContain("Bearer");
    expect(query.statusCode).toBe(401);
    expect(demo.statusCode).toBe(404);
  });

  it.each([1, 7, 15, 30])("returns 401 at the %d-day deadline", async (expiresInDays) => {
    let currentTime = new Date("2026-09-02T00:00:00.000Z");
    const tokens = createMcpTokenService({
      hashSecret: HASH_SECRET,
      now: () => currentTime,
      repository: new InMemoryMcpTokenRepository(),
    });
    const { app } = buildTestApp({ tokenService: tokens });
    applications.push(app);
    const created = await tokens.createToken({ name: "Expired", user: USER, expiresInDays });
    const deadline = currentTime.getTime() + expiresInDays * 86_400_000;
    const connect = () =>
      app.inject({
        method: "POST",
        url: "/mcp",
        headers: {
          accept: "application/json, text/event-stream",
          authorization: `Bearer ${created.token}`,
          host: "app.localhost",
        },
        payload: {
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name: "check_connection", arguments: {} },
        },
      });
    currentTime = new Date(deadline - 1);
    const active = await connect();
    expect(active.statusCode).toBe(200);
    expect(active.body).toContain(USER.displayName);
    currentTime = new Date(deadline);
    expect((await connect()).statusCode).toBe(401);
  });

  it("connects Codex and Claude Code compatible clients over Streamable HTTP", async () => {
    const { app, tokens } = buildTestApp({ appHost: "127.0.0.1" });
    applications.push(app);
    const created = await tokens.createToken({ name: "Integration", user: USER });
    const permanent = await tokens.createToken({
      name: "Permanent",
      user: USER,
      expiresInDays: "never",
    });
    const address = await app.listen({ host: "127.0.0.1", port: 0 });
    const endpoint = new URL("/mcp", address);

    const codexResult = await checkConnection(endpoint, created.token, "codex");
    const claudeResult = await checkConnection(endpoint, created.token, "claude-code");

    expect(codexResult.structuredContent).toEqual({
      expiresAt: created.summary.expiresAt?.toISOString(),
      user: USER.displayName,
    });
    const permanentResult = await checkConnection(endpoint, permanent.token, "codex");
    expect(claudeResult.structuredContent).toEqual(codexResult.structuredContent);
    expect(permanentResult.structuredContent).toEqual({
      expiresAt: null,
      user: USER.displayName,
      validity: "永久有效",
    });
    expect(
      (await tokens.listTokens({ userId: USER.id })).every((token) => token.lastUsedAt !== null),
    ).toBe(true);
  });

  it("accepts the 2025-era Streamable HTTP initialize request", async () => {
    const { app, tokens } = buildTestApp();
    applications.push(app);
    const created = await tokens.createToken({ name: "Legacy client", user: USER });

    const response = await app.inject({
      method: "POST",
      url: "/mcp",
      headers: {
        accept: "application/json, text/event-stream",
        authorization: `Bearer ${created.token}`,
        "content-type": "application/json",
        host: "app.localhost",
        "mcp-protocol-version": "2025-11-25",
      },
      payload: {
        id: 1,
        jsonrpc: "2.0",
        method: "initialize",
        params: {
          capabilities: {},
          clientInfo: { name: "legacy-client", version: "1.0.0" },
          protocolVersion: "2025-11-25",
        },
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      id: 1,
      jsonrpc: "2.0",
      result: { protocolVersion: "2025-11-25" },
    });
  });
});

function buildTestApp(options?: {
  appHost?: string;
  tokenService?: ReturnType<typeof createMcpTokenService>;
}) {
  const appHost = options?.appHost ?? "app.localhost";
  const tokens =
    options?.tokenService ??
    createMcpTokenService({
      hashSecret: HASH_SECRET,
      repository: new InMemoryMcpTokenRepository(),
    });
  const app = buildServerApp({
    appAuthUrl: `http://${appHost}:3001`,
    appHost,
    appWebUrl: "http://app.localhost:3000",
    authSessions: createAuthSessionService({
      repository: new InMemoryAuthRepository(),
      stateSecret: "test-state-signing-secret-with-enough-length",
      tenantAppKeyRef: "test-dingtalk-app",
    }),
    demoAuthUrl: "http://demo.localhost:3001",
    demoHost: "demo.localhost",
    demoWebUrl: "http://demo.localhost:3001",
    dingtalk: createSimulatorDingTalkClient(),
    logger: false,
    mcpTokens: tokens,
  });
  return { app, tokens };
}
