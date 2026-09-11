import { afterEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";

import {
  createAuthSessionService,
  createMcpTokenService,
  InMemoryAuthRepository,
  InMemoryMcpTokenRepository,
  type PasswordManagementService,
  type ProjectManagementReader,
} from "@html-share/core";
import { createSimulatorDingTalkClient } from "@html-share/dingtalk";

import { buildServerApp } from "./app.js";
import { createAppSession } from "./phase5-session.test-helper.js";

describe("owned project password management API", () => {
  const apps: FastifyInstance[] = [];
  afterEach(async () => Promise.all(apps.splice(0).map((app) => app.close())));

  function createApp(
    passwordManagement?: PasswordManagementService,
    projectManagement?: ProjectManagementReader,
  ) {
    const app = buildServerApp({
      appAuthUrl: "http://app.localhost:3001",
      appHost: "app.localhost",
      appWebUrl: "http://app.localhost:3000",
      authSessions: createAuthSessionService({
        repository: new InMemoryAuthRepository(),
        stateSecret: "password-management-test-state-secret-long-enough",
        tenantAppKeyRef: "test-app",
      }),
      demoAuthUrl: "http://demo.localhost:3001",
      demoHost: "demo.localhost",
      demoWebUrl: "http://demo.localhost:3001",
      dingtalk: createSimulatorDingTalkClient(),
      logger: false,
      mcpTokens: createMcpTokenService({
        hashSecret: "password-management-test-token-secret-long-enough",
        repository: new InMemoryMcpTokenRepository(),
      }),
      ...(passwordManagement === undefined ? {} : { passwordManagement }),
      ...(projectManagement === undefined ? {} : { projectManagement }),
    });
    apps.push(app);
    return app;
  }

  async function authenticated(app: FastifyInstance) {
    const cookie = await createAppSession(app);
    const csrf = await app.inject({
      headers: { cookie, host: "app.localhost" },
      method: "GET",
      url: "/api/csrf",
    });
    return { cookie, csrfToken: csrf.json().csrfToken as string };
  }

  it("validates the owner write boundary and returns a generated password", async () => {
    const changeOwnedProjectAccess = vi.fn().mockResolvedValue({
      access: {
        accessMode: "password",
        accessPassword: "Abcd2345",
        passwordStatus: "available",
      },
      outcome: "updated",
    });
    const app = createApp({
      changeOwnedProjectAccess,
      readOwnedProjectAccess: vi.fn(),
    });
    const auth = await authenticated(app);
    const response = await app.inject({
      body: { action: "enable" },
      headers: {
        cookie: auth.cookie,
        host: "app.localhost",
        origin: "http://app.localhost:3000",
        "x-html-share-csrf": auth.csrfToken,
      },
      method: "POST",
      url: "/api/projects/abc12/password-access",
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      accessMode: "password",
      accessPassword: "Abcd2345",
      passwordStatus: "available",
      status: "updated",
    });
    expect(changeOwnedProjectAccess).toHaveBeenCalledWith({
      action: "enable",
      ownerUserId: "user-1",
      projectKey: "abc12",
      requestIp: "127.0.0.1",
      traceId: expect.any(String),
    });
  });

  it("returns the current password only from owner detail while list exposes only mode", async () => {
    const passwordManagement: PasswordManagementService = {
      changeOwnedProjectAccess: vi.fn(),
      readOwnedProjectAccess: vi.fn().mockResolvedValue({
        accessMode: "password",
        accessPassword: "Abcd2345",
        passwordStatus: "available",
      }),
    };
    const summary = {
      accessMode: "password" as const,
      createdAt: new Date("2026-09-10T00:00:00Z"),
      displayName: "Protected",
      fileCount: 1,
      projectKey: "abc12",
      totalSize: 4,
      updatedAt: new Date("2026-09-10T00:00:00Z"),
    };
    const projectManagement: ProjectManagementReader = {
      findOwnedActiveProject: vi.fn().mockResolvedValue({
        ...summary,
        files: [{ relativePath: "index.html", size: 4 }],
      }),
      listOwnedActiveProjects: vi.fn().mockResolvedValue({
        projects: [summary],
        quota: { projectCount: 1, storageBytes: 4 },
      }),
    };
    const app = createApp(passwordManagement, projectManagement);
    const auth = await authenticated(app);
    const detail = await app.inject({
      headers: { cookie: auth.cookie, host: "app.localhost" },
      method: "GET",
      url: "/api/projects/abc12",
    });
    expect(detail.statusCode).toBe(200);
    expect(detail.json().project).toMatchObject({
      accessMode: "password",
      accessPassword: "Abcd2345",
      passwordStatus: "available",
    });
    const list = await app.inject({
      headers: { cookie: auth.cookie, host: "app.localhost" },
      method: "GET",
      url: "/api/projects",
    });
    expect(list.statusCode).toBe(200);
    expect(list.json().projects).toEqual([
      expect.objectContaining({ accessMode: "password", projectId: "abc12" }),
    ]);
    expect(list.body).not.toContain("Abcd2345");
    expect(list.body).not.toContain("accessPassword");
  });

  it("returns a controlled error when the stored password cannot be decrypted", async () => {
    const projectManagement: ProjectManagementReader = {
      findOwnedActiveProject: vi.fn().mockResolvedValue({
        accessMode: "password",
        createdAt: new Date("2026-09-10T00:00:00Z"),
        displayName: "Protected",
        fileCount: 1,
        files: [{ relativePath: "index.html", size: 4 }],
        projectKey: "abc12",
        totalSize: 4,
        updatedAt: new Date("2026-09-10T00:00:00Z"),
      }),
      listOwnedActiveProjects: vi.fn(),
    };
    const app = createApp(
      {
        changeOwnedProjectAccess: vi.fn(),
        readOwnedProjectAccess: vi.fn().mockRejectedValue(new Error("ciphertext rejected")),
      },
      projectManagement,
    );
    const auth = await authenticated(app);
    const detail = await app.inject({
      headers: { cookie: auth.cookie, host: "app.localhost" },
      method: "GET",
      url: "/api/projects/abc12",
    });
    expect(detail.statusCode).toBe(503);
    expect(detail.json()).toEqual({ error: "password_management_unavailable" });
    expect(detail.body).not.toContain("ciphertext rejected");
  });

  it("rejects unauthenticated, cross-origin, invalid CSRF and invalid actions", async () => {
    const changeOwnedProjectAccess = vi.fn();
    const app = createApp({ changeOwnedProjectAccess, readOwnedProjectAccess: vi.fn() });
    const auth = await authenticated(app);
    const base = {
      body: { action: "disable" },
      method: "POST" as const,
      url: "/api/projects/abc12/password-access",
    };
    expect((await app.inject({ ...base, headers: { host: "app.localhost" } })).statusCode).toBe(
      401,
    );
    expect(
      (
        await app.inject({
          ...base,
          headers: { cookie: auth.cookie, host: "app.localhost", origin: "https://evil.test" },
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await app.inject({
          ...base,
          headers: {
            cookie: auth.cookie,
            host: "app.localhost",
            origin: "http://app.localhost:3000",
            "x-html-share-csrf": "invalid",
          },
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await app.inject({
          ...base,
          body: { action: "read" },
          headers: {
            cookie: auth.cookie,
            host: "app.localhost",
            origin: "http://app.localhost:3000",
            "x-html-share-csrf": auth.csrfToken,
          },
        })
      ).statusCode,
    ).toBe(400);
    expect(changeOwnedProjectAccess).not.toHaveBeenCalled();
  });

  it.each([
    ["not_found", 404, "not_found"],
    ["conflict", 409, "password_access_conflict"],
    ["upload_conflict", 409, "project_upload_conflict"],
  ] as const)("maps %s without returning password material", async (outcome, status, error) => {
    const app = createApp({
      changeOwnedProjectAccess: vi.fn().mockResolvedValue({ outcome }),
      readOwnedProjectAccess: vi.fn(),
    });
    const auth = await authenticated(app);
    const response = await app.inject({
      body: { action: "regenerate" },
      headers: {
        cookie: auth.cookie,
        host: "app.localhost",
        origin: "http://app.localhost:3000",
        "x-html-share-csrf": auth.csrfToken,
      },
      method: "POST",
      url: "/api/projects/abc12/password-access",
    });
    expect(response.statusCode).toBe(status);
    expect(response.json()).toEqual({ error });
  });
});
