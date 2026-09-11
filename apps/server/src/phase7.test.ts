import { afterEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";

import {
  createAuthSessionService,
  createMcpTokenService,
  InMemoryAuthRepository,
  InMemoryMcpTokenRepository,
  type ProjectManagementReader,
} from "@html-share/core";
import { createSimulatorDingTalkClient } from "@html-share/dingtalk";

import { buildServerApp } from "./app.js";

describe("Phase 7 management APIs", () => {
  const applications: FastifyInstance[] = [];

  afterEach(async () => {
    await Promise.all(applications.splice(0).map((app) => app.close()));
  });

  it("returns only the current owner's active projects and matching quota", async () => {
    const projects: ProjectManagementReader = {
      findOwnedActiveProject: vi.fn().mockResolvedValue(null),
      listOwnedActiveProjects: vi.fn().mockResolvedValue({
        projects: [
          {
            createdAt: new Date("2026-09-02T00:00:00.000Z"),
            displayName: "Latest Demo",
            fileCount: 2,
            projectKey: "newer",
            totalSize: 128,
            updatedAt: new Date("2026-09-03T00:00:00.000Z"),
          },
        ],
        quota: { projectCount: 1, storageBytes: 128 },
      }),
    };
    const app = createApp(projects);
    applications.push(app);
    const cookie = await createAppSession(app);

    const response = await app.inject({
      method: "GET",
      url: "/api/projects",
      headers: {
        cookie,
        host: "app.localhost",
        origin: "http://app.localhost:3000",
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      projects: [
        {
          displayName: "Latest Demo",
          projectId: "newer",
          projectPrefix: "http://demo.localhost:3001/newer/",
        },
      ],
      quota: {
        projectCount: 1,
        projectLimit: 100,
        storageBytes: 128,
        storageLimitBytes: 2 * 1024 * 1024 * 1024,
      },
    });
    expect(projects.listOwnedActiveProjects).toHaveBeenCalledWith({ ownerUserId: "user-1" });
  });

  it("enforces the app session, trusted origin, and app host for management APIs", async () => {
    const app = createApp();
    applications.push(app);
    const cookie = await createAppSession(app);

    const [unauthenticated, wrongOrigin, wrongHost] = await Promise.all([
      app.inject({ method: "GET", url: "/api/projects", headers: { host: "app.localhost" } }),
      app.inject({
        method: "GET",
        url: "/api/projects",
        headers: { cookie, host: "app.localhost", origin: "https://attacker.test" },
      }),
      app.inject({
        method: "GET",
        url: "/api/projects",
        headers: { cookie, host: "demo.localhost" },
      }),
    ]);

    expect(unauthenticated.statusCode).toBe(401);
    expect(wrongOrigin.statusCode).toBe(403);
    expect(wrongHost.statusCode).toBe(404);
  });

  it("reports a retryable error when the project query dependency is unavailable", async () => {
    const app = createApp();
    applications.push(app);
    const cookie = await createAppSession(app);

    const response = await app.inject({
      method: "GET",
      url: "/api/projects",
      headers: { cookie, host: "app.localhost" },
    });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({ error: "project_list_unavailable" });
  });

  it("redirects an authenticated user to the packaged host-specific Skill ZIP", async () => {
    const app = createApp();
    applications.push(app);
    const cookie = await createAppSession(app);

    const [codex, claude, unknown, unauthenticated, wrongHost] = await Promise.all([
      app.inject({
        method: "GET",
        url: "/api/skills/codex",
        headers: { cookie, host: "app.localhost" },
      }),
      app.inject({
        method: "GET",
        url: "/api/skills/claude-code",
        headers: { cookie, host: "app.localhost" },
      }),
      app.inject({
        method: "GET",
        url: "/api/skills/unknown",
        headers: { cookie, host: "app.localhost" },
      }),
      app.inject({ method: "GET", url: "/api/skills/codex", headers: { host: "app.localhost" } }),
      app.inject({
        method: "GET",
        url: "/api/skills/codex",
        headers: { cookie, host: "demo.localhost" },
      }),
    ]);

    expect(codex.statusCode).toBe(302);
    expect(codex.headers.location).toBe("http://app.localhost:3000/skills/codex-html-share.zip");
    expect(codex.headers["cache-control"]).toBe("private, max-age=300");
    expect(claude.headers.location).toBe(
      "http://app.localhost:3000/skills/claude-code-html-share.zip",
    );
    expect(unknown.statusCode).toBe(404);
    expect(unauthenticated.statusCode).toBe(401);
    expect(wrongHost.statusCode).toBe(404);
  });
});

function createApp(projectManagement?: ProjectManagementReader) {
  return buildServerApp({
    appAuthUrl: "http://app.localhost:3001",
    appHost: "app.localhost",
    appWebUrl: "http://app.localhost:3000",
    authSessions: createAuthSessionService({
      repository: new InMemoryAuthRepository(),
      stateSecret: "phase-seven-state-signing-secret-with-enough-length",
      tenantAppKeyRef: "test-dingtalk-app",
    }),
    demoAuthUrl: "http://demo.localhost:3001",
    demoHost: "demo.localhost",
    demoWebUrl: "http://demo.localhost:3001",
    dingtalk: createSimulatorDingTalkClient(),
    logger: false,
    mcpTokens: createMcpTokenService({
      hashSecret: "phase-seven-mcp-token-hash-secret-with-enough-length",
      repository: new InMemoryMcpTokenRepository(),
    }),
    ...(projectManagement === undefined ? {} : { projectManagement }),
  });
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

function readLocation(response: { headers: Record<string, unknown> }) {
  const location = response.headers["location"];
  if (typeof location !== "string") throw new Error("location header missing");
  return location;
}
