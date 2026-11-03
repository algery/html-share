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

describe("homepage management API", () => {
  const apps: FastifyInstance[] = [];
  afterEach(async () => {
    await Promise.all(apps.splice(0).map((app) => app.close()));
  });
  function setup() {
    const setOwnedHomepage = vi.fn().mockResolvedValue("updated");
    const reader: ProjectManagementReader = {
      setOwnedHomepage,
      findOwnedActiveProject: vi.fn().mockResolvedValue(null),
      listOwnedActiveProjects: vi.fn().mockResolvedValue({
        projects: [
          {
            accessMode: "password",
            createdAt: new Date(),
            updatedAt: new Date(),
            displayName: "Demo",
            fileCount: 2,
            projectKey: "abc12",
            totalSize: 12,
            htmlPaths: ["index.html", "目录/首页 #.html"],
            homepagePath: "目录/首页 #.html",
          },
        ],
        quota: { projectCount: 1, storageBytes: 12 },
      }),
    };
    const app = createApp(reader);
    apps.push(app);
    return { app, setOwnedHomepage };
  }
  async function authenticate(app: FastifyInstance) {
    const cookie = await createAppSession(app);
    const csrf = await app.inject({
      method: "GET",
      url: "/api/csrf",
      headers: { cookie, host: "app.localhost" },
    });
    return {
      cookie,
      host: "app.localhost",
      origin: "http://app.localhost:3000",
      "x-html-share-csrf": csrf.json().csrfToken as string,
    };
  }
  it("returns exact encoded homepage metadata without disclosing the file set or passwords", async () => {
    const { app } = setup();
    const headers = await authenticate(app);
    const response = await app.inject({ method: "GET", url: "/api/projects", headers });
    expect(response.statusCode).toBe(200);
    expect(response.headers["cache-control"]).toBe("private, no-store");
    expect(response.json().projects[0].homepage).toMatchObject({
      source: "manual",
      path: "目录/首页 #.html",
      url: "http://demo.localhost:3001/abc12/%E7%9B%AE%E5%BD%95/%E9%A6%96%E9%A1%B5%20%23.html",
    });
    for (const key of ["htmlPaths", "files", "accessPassword", "passwordHash"])
      expect(response.json().projects[0]).not.toHaveProperty(key);
  });
  it.each(["index.html", null])("saves or clears a current homepage: %s", async (relativePath) => {
    const { app, setOwnedHomepage } = setup();
    const headers = await authenticate(app);
    const response = await app.inject({
      method: "PUT",
      url: "/api/projects/abc12/homepage",
      headers,
      payload: { relativePath },
    });
    expect(response.statusCode).toBe(200);
    expect(setOwnedHomepage).toHaveBeenCalledWith({
      ownerUserId: "user-1",
      projectKey: "abc12",
      relativePath,
    });
  });
  it.each(["not_found", "invalid_file", "throw"])("handles repository %s", async (result) => {
    const { app, setOwnedHomepage } = setup();
    const headers = await authenticate(app);
    if (result === "throw") setOwnedHomepage.mockRejectedValue(new Error("database unavailable"));
    else setOwnedHomepage.mockResolvedValue(result);
    const response = await app.inject({
      method: "PUT",
      url: "/api/projects/abc12/homepage",
      headers,
      payload: { relativePath: "index.html" },
    });
    expect(response.statusCode).toBe(
      result === "not_found" ? 404 : result === "invalid_file" ? 409 : 503,
    );
  });
  it("rejects unauthenticated, wrong host/origin and missing CSRF writes before accessing storage", async () => {
    const { app, setOwnedHomepage } = setup();
    const headers = await authenticate(app);
    for (const [override, code] of [
      [{ cookie: "" }, 401],
      [{ host: "demo.localhost" }, 404],
      [{ origin: "https://evil.test" }, 403],
      [{ "x-html-share-csrf": "" }, 403],
    ] as const) {
      const response = await app.inject({
        method: "PUT",
        url: "/api/projects/abc12/homepage",
        headers: { ...headers, ...override },
        payload: { relativePath: "index.html" },
      });
      expect(response.statusCode).toBe(code);
    }
    expect(setOwnedHomepage).not.toHaveBeenCalled();
  });
  it.each([
    {},
    { relativePath: 12 },
    { relativePath: "app.js" },
    { relativePath: "x".repeat(1025) + ".html" },
  ])("validates malformed input %j", async (payload) => {
    const { app, setOwnedHomepage } = setup();
    const headers = await authenticate(app);
    const response = await app.inject({
      method: "PUT",
      url: "/api/projects/abc12/homepage",
      headers,
      payload,
    });
    expect(response.statusCode).toBe(400);
    expect(setOwnedHomepage).not.toHaveBeenCalled();
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
