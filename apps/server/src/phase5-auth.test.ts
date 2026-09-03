import { Readable } from "node:stream";

import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";

import {
  createAuthSessionService,
  createMcpTokenService,
  InMemoryAuthRepository,
  InMemoryMcpTokenRepository,
  type ProjectReader,
} from "@html-share/core";
import { createSimulatorDingTalkClient } from "@html-share/dingtalk";
import type { ObjectStore } from "@html-share/storage";

import { buildServerApp } from "./app.js";

const HTML = "<!doctype html><title>Phase 5</title><h1>authorized</h1>";
const FILE = {
  contentHash: "a".repeat(64),
  relativePath: "a.html",
  size: Buffer.byteLength(HTML),
  storageKey: "projects/abc12/revisions/1/a.html",
};

describe("Phase 5 Demo content authorization", () => {
  const applications: FastifyInstance[] = [];

  afterEach(async () => {
    await Promise.all(applications.splice(0).map((app) => app.close()));
  });

  it("redirects unauthenticated reads before looking up or streaming content", async () => {
    const { app, reads } = createApp();
    applications.push(app);
    const response = await app.inject({
      method: "GET",
      url: "/abc12/a.html?preview=1",
      headers: { host: "demo.localhost" },
    });

    expect(response.statusCode).toBe(302);
    expect(response.headers.location).toBe(
      "/auth/content-login?return_path=%2Fabc12%2Fa.html%3Fpreview%3D1",
    );
    expect(response.body).toBe("");
    expect(reads()).toBe(0);
  });

  it("uses the native DingTalk bridge form and restores the exact signed path", async () => {
    const { app } = createApp();
    applications.push(app);
    const login = await app.inject({
      method: "GET",
      url: "/auth/content-login?return_path=%2Fabc12%2Fa.html%3Fpreview%3D1",
      headers: { host: "demo.localhost" },
    });

    expect(login.statusCode).toBe(200);
    expect(login.headers["content-type"]).toBe("text/html; charset=utf-8");
    expect(login.headers["cache-control"]).toBe("no-store");
    expect(login.body).toContain("window.dd");
    expect(login.body).toContain("requestAuthCode");
    expect(login.body).toContain('"clientId":"demo-client-id"');
    expect(login.body).toContain('"corpId":"demo-corp-id"');
    expect(login.body).toContain("/auth/internal/complete");
    expect(login.body).toContain("form.submit()");
    expect(login.body).not.toContain('redirect:"manual"');

    const completed = await app.inject({
      method: "POST",
      url: "/auth/internal/complete",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        host: "demo.localhost",
        origin: "http://demo.localhost:3001",
      },
      payload: new URLSearchParams({
        code: "simulator-member",
        state: readState(login.body),
      }).toString(),
    });

    expect(completed.statusCode).toBe(302);
    expect(completed.headers.location).toBe("http://demo.localhost:3001/abc12/a.html?preview=1");
    expect(readCookie(completed)).toContain("demo_session=");
  });

  it("renders internal and external organization denials as non-cacheable content errors", async () => {
    const { app } = createApp();
    applications.push(app);
    const internalLogin = await app.inject({
      method: "GET",
      url: "/auth/content-login?return_path=%2Fabc12%2Fa.html",
      headers: { host: "demo.localhost" },
    });
    const internalDenied = await app.inject({
      method: "POST",
      url: "/auth/internal/complete",
      headers: { "content-type": "application/x-www-form-urlencoded", host: "demo.localhost" },
      payload: new URLSearchParams({
        code: "simulator-denied",
        state: readState(internalLogin.body),
      }).toString(),
    });
    const externalLogin = await app.inject({
      method: "GET",
      url: "/auth/login?return_path=/abc12/a.html",
      headers: { host: "demo.localhost" },
    });
    const callback = new URL(String(externalLogin.headers.location));
    callback.searchParams.set("code", "simulator-denied");
    const externalDenied = await app.inject({
      method: "GET",
      url: `${callback.pathname}${callback.search}`,
      headers: { host: "demo.localhost" },
    });

    for (const denied of [internalDenied, externalDenied]) {
      expect(denied.statusCode).toBe(403);
      expect(denied.headers["cache-control"]).toBe("no-store");
      expect(denied.headers["content-type"]).toBe("text/html; charset=utf-8");
      expect(denied.body).toContain("你不属于可访问组织");
      expect(denied.body).toContain("诊断编号：ORGANIZATION_ACCESS_DENIED");
      expect(denied.headers["set-cookie"]).toBeUndefined();
    }
  });
});

function createApp() {
  let reads = 0;
  const projects: ProjectReader = {
    async findCurrentFile({ projectKey, relativePath, tenantId }) {
      return projectKey === "abc12" && relativePath === "a.html" && tenantId === "test-dingtalk-app"
        ? FILE
        : null;
    },
  };
  const storage: ObjectStore = {
    async createPresignedZipUpload() {
      throw new Error("not used");
    },
    async deleteObjects() {
      return undefined;
    },
    async ensurePrivateBucket() {
      return undefined;
    },
    async getObject() {
      reads += 1;
      return Readable.from([HTML]);
    },
    async headObject() {
      return { size: FILE.size };
    },
    async putObject() {
      return undefined;
    },
  };
  return {
    app: buildServerApp({
      appAuthUrl: "http://app.localhost:3001",
      appHost: "app.localhost",
      appWebUrl: "http://app.localhost:3000",
      authSessions: createAuthSessionService({
        repository: new InMemoryAuthRepository(),
        stateSecret: "phase-five-auth-state-signing-secret-with-enough-length",
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
        hashSecret: "phase-five-auth-mcp-token-hash-secret-with-enough-length",
        repository: new InMemoryMcpTokenRepository(),
      }),
      projects,
      storage,
    }),
    reads: () => reads,
  };
}

function readCookie(response: { headers: Record<string, unknown> }) {
  const header = response.headers["set-cookie"];
  const value = Array.isArray(header) ? header[0] : header;
  if (typeof value !== "string") throw new Error("session cookie missing");
  return value.split(";", 1)[0] ?? "";
}

function readState(page: string) {
  const state = page.match(/"state":"([A-Za-z0-9_-]+)"/)?.[1];
  if (state === undefined) throw new Error("authorization state missing from content login page");
  return state;
}
