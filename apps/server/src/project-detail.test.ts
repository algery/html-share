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
import { createAppSession } from "./phase5-session.test-helper.js";

const detail = {
  accessMode: "organization" as const,
  createdAt: new Date("2026-09-07T00:00:00Z"),
  updatedAt: new Date("2026-09-07T00:00:00Z"),
  displayName: "Demo",
  projectKey: "abc12",
  fileCount: 2,
  totalSize: 15,
  files: [
    { relativePath: "assets/a.js", size: 12 },
    { relativePath: "中文目录/页面 #?%&.html", size: 3 },
  ],
};

describe("owned project detail API", () => {
  const apps: FastifyInstance[] = [];
  afterEach(async () => {
    await Promise.all(apps.splice(0).map((app) => app.close()));
  });

  function createApp(projectManagement?: ProjectManagementReader) {
    const app = buildServerApp({
      appHost: "app.localhost",
      appAuthUrl: "http://app.localhost:3001",
      appWebUrl: "http://app.localhost:3000",
      demoHost: "demo.localhost",
      demoAuthUrl: "http://demo.localhost:3001",
      demoWebUrl: "http://demo.localhost:3001",
      authSessions: createAuthSessionService({
        repository: new InMemoryAuthRepository(),
        stateSecret: "project-detail-test-state-secret-long-enough",
        tenantAppKeyRef: "test-app",
      }),
      dingtalk: createSimulatorDingTalkClient(),
      mcpTokens: createMcpTokenService({
        hashSecret: "project-detail-test-token-secret-long-enough",
        repository: new InMemoryMcpTokenRepository(),
      }),
      logger: false,
      ...(projectManagement === undefined ? {} : { projectManagement }),
    });
    apps.push(app);
    return app;
  }

  it("returns safe metadata and encoded stable file URLs, then reads the replacement collection", async () => {
    const findOwnedActiveProject = vi.fn().mockResolvedValue(detail);
    const app = createApp({ listOwnedActiveProjects: vi.fn(), findOwnedActiveProject });
    const cookie = await createAppSession(app);
    const input = {
      method: "GET" as const,
      url: "/api/projects/abc12",
      headers: { cookie, host: "app.localhost" },
    };
    const response = await app.inject(input);
    expect(response.statusCode).toBe(200);
    expect(response.headers["cache-control"]).toBe("private, no-store");
    expect(findOwnedActiveProject).toHaveBeenCalledWith({
      ownerUserId: "user-1",
      projectKey: "abc12",
    });
    expect(response.json()).toEqual({
      csrfToken: expect.any(String),
      project: {
        accessMode: "organization",
        passwordStatus: "disabled",
        createdAt: detail.createdAt.toISOString(),
        updatedAt: detail.updatedAt.toISOString(),
        displayName: "Demo",
        fileCount: 2,
        homepage: {
          configuredPath: null,
          path: "中文目录/页面 #?%&.html",
          source: "automatic",
          url: "http://demo.localhost:3001/abc12/%E4%B8%AD%E6%96%87%E7%9B%AE%E5%BD%95/%E9%A1%B5%E9%9D%A2%20%23%3F%25%26.html",
        },
        projectId: "abc12",
        totalSize: 15,
      },
      files: [
        {
          relativePath: "assets/a.js",
          size: 12,
          url: "http://demo.localhost:3001/abc12/assets/a.js",
        },
        {
          relativePath: "中文目录/页面 #?%&.html",
          size: 3,
          url: "http://demo.localhost:3001/abc12/%E4%B8%AD%E6%96%87%E7%9B%AE%E5%BD%95/%E9%A1%B5%E9%9D%A2%20%23%3F%25%26.html",
        },
      ],
    });
    findOwnedActiveProject.mockResolvedValue({
      ...detail,
      fileCount: 1,
      files: [{ relativePath: "new.html", size: 15 }],
    });
    expect((await app.inject(input)).json().files).toEqual([
      { relativePath: "new.html", size: 15, url: "http://demo.localhost:3001/abc12/new.html" },
    ]);
  });

  it("rejects missing sessions, untrusted origins, and the content host before reading files", async () => {
    const findOwnedActiveProject = vi.fn();
    const app = createApp({ listOwnedActiveProjects: vi.fn(), findOwnedActiveProject });
    const cookie = await createAppSession(app);
    for (const [headers, status] of [
      [{ host: "app.localhost" }, 401],
      [{ host: "app.localhost", cookie, origin: "https://attacker.test" }, 403],
      [{ host: "demo.localhost", cookie }, 404],
    ] as const) {
      expect(
        (await app.inject({ method: "GET", url: "/api/projects/abc12", headers })).statusCode,
      ).toBe(status);
    }
    expect(findOwnedActiveProject).not.toHaveBeenCalled();
  });

  it("hides inaccessible projects, rejects invalid identifiers, and permits an empty collection", async () => {
    const findOwnedActiveProject = vi.fn().mockResolvedValue(null);
    const app = createApp({ listOwnedActiveProjects: vi.fn(), findOwnedActiveProject });
    const cookie = await createAppSession(app);
    for (const key of ["other", "gone1", "pend1", "none1", "invalid-id"]) {
      const response = await app.inject({
        method: "GET",
        url: `/api/projects/${key}`,
        headers: { host: "app.localhost", cookie },
      });
      expect(response.statusCode).toBe(404);
      expect(response.json()).toEqual({ error: "not_found" });
    }
    expect(findOwnedActiveProject).toHaveBeenCalledTimes(4);
    findOwnedActiveProject.mockResolvedValue({ ...detail, fileCount: 0, files: [], totalSize: 0 });
    expect(
      (
        await app.inject({
          method: "GET",
          url: "/api/projects/abc12",
          headers: { host: "app.localhost", cookie },
        })
      ).json().files,
    ).toEqual([]);
  });

  it("returns retryable errors for unavailable or failing metadata queries", async () => {
    for (const failing of [false, true]) {
      const app = createApp(
        failing
          ? {
              listOwnedActiveProjects: vi.fn(),
              findOwnedActiveProject: vi.fn().mockRejectedValue(new Error("database offline")),
            }
          : undefined,
      );
      const cookie = await createAppSession(app);
      const response = await app.inject({
        method: "GET",
        url: "/api/projects/abc12",
        headers: { cookie, host: "app.localhost" },
      });
      expect(response.statusCode).toBe(503);
      expect(response.body).not.toContain("database offline");
    }
  });
});
