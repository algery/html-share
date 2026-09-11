import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";

import {
  createAuthSessionService,
  createMcpTokenService,
  InMemoryAuthRepository,
  InMemoryMcpTokenRepository,
} from "@html-share/core";
import { createSimulatorDingTalkClient } from "@html-share/dingtalk";

import { buildServerApp } from "./app.js";

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
    const sessionCookie = await createAppSession(app);
    const csrf = await app.inject({
      method: "GET",
      url: "/api/csrf",
      headers: { cookie: sessionCookie, host: "app.localhost" },
    });
    const { csrfToken } = csrf.json<{ csrfToken: string }>();

    const unauthorized = await app.inject({
      method: "GET",
      url: "/api/tokens",
      headers: { host: "app.localhost" },
    });
    const rejectedOrigin = await app.inject({
      method: "POST",
      url: "/api/tokens",
      headers: { cookie: sessionCookie, host: "app.localhost", origin: "https://attacker.test" },
      payload: { name: "Codex" },
    });
    const created = await app.inject({
      method: "POST",
      url: "/api/tokens",
      headers: {
        cookie: sessionCookie,
        host: "app.localhost",
        origin: "http://app.localhost:3000",
        "x-html-share-csrf": csrfToken,
      },
      payload: { name: "Codex laptop" },
    });
    const createdBody = created.json<{ token: { id: string }; value: string }>();
    const listed = await app.inject({
      method: "GET",
      url: "/api/tokens",
      headers: {
        cookie: sessionCookie,
        host: "app.localhost",
        origin: "http://app.localhost:3000",
        "x-html-share-csrf": csrfToken,
      },
    });
    const revoked = await app.inject({
      method: "POST",
      url: `/api/tokens/${createdBody.token.id}/revoke`,
      headers: {
        cookie: sessionCookie,
        host: "app.localhost",
        origin: "http://app.localhost:3000",
        "x-html-share-csrf": csrfToken,
      },
    });

    expect(unauthorized.statusCode).toBe(401);
    expect(csrf.statusCode).toBe(200);
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
          headers: { cookie: sessionCookie, host: "app.localhost" },
        })
      ).json(),
    ).toMatchObject({ tokens: [{ status: "revoked" }] });
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

  it("returns 401 for an expired Token", async () => {
    let currentTime = new Date("2026-09-02T00:00:00.000Z");
    const tokens = createMcpTokenService({
      hashSecret: HASH_SECRET,
      now: () => currentTime,
      repository: new InMemoryMcpTokenRepository(),
    });
    const { app } = buildTestApp({ tokenService: tokens });
    applications.push(app);
    const created = await tokens.createToken({ name: "Expired", user: USER });
    currentTime = new Date(currentTime.getTime() + 30 * 24 * 60 * 60 * 1000);

    const expired = await app.inject({
      method: "POST",
      url: "/mcp",
      headers: { authorization: `Bearer ${created.token}`, host: "app.localhost" },
    });

    expect(expired.statusCode).toBe(401);
  });

  it("connects Codex and Claude Code compatible clients over Streamable HTTP", async () => {
    const { app, tokens } = buildTestApp({ appHost: "127.0.0.1" });
    applications.push(app);
    const created = await tokens.createToken({ name: "Integration", user: USER });
    const address = await app.listen({ host: "127.0.0.1", port: 0 });
    const endpoint = new URL("/mcp", address);

    const codexResult = await checkConnection(endpoint, created.token, "codex");
    const claudeResult = await checkConnection(endpoint, created.token, "claude-code");

    expect(codexResult).toContain("Simulator Member");
    expect(claudeResult).toContain("Simulator Member");
    expect((await tokens.listTokens({ userId: USER.id }))[0]?.lastUsedAt).not.toBeNull();
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

async function createAppSession(app: FastifyInstance) {
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
  const header = completed.headers["set-cookie"];
  const cookie = Array.isArray(header) ? header[0] : header;
  if (typeof cookie !== "string") throw new Error("session cookie missing");
  return cookie.split(";")[0] ?? "";
}

async function checkConnection(endpoint: URL, token: string, clientName: string) {
  const client = new Client({ name: clientName, version: "1.0.0" });
  const transport = new StreamableHTTPClientTransport(endpoint, {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
  });
  await client.connect(transport);
  const result = await client.callTool({ arguments: {}, name: "check_connection" });
  await client.close();
  return JSON.stringify(result);
}

function readLocation(response: { headers: Record<string, unknown> }) {
  const location = response.headers["location"];
  if (typeof location !== "string") throw new Error("location header missing");
  return location;
}
