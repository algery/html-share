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
import { createAppSession, createDemoSession } from "./phase5-session.test-helper.js";

const HTML = "<!doctype html><title>Phase 5</title><h1>authorized</h1>";
const HASH = "a".repeat(64);
const FILE = {
  contentHash: HASH,
  relativePath: "a.html",
  size: Buffer.byteLength(HTML),
  storageKey: "projects/abc12/revisions/1/a.html",
};

describe("Phase 5 Demo content gateway", () => {
  const applications: FastifyInstance[] = [];

  afterEach(async () => {
    await Promise.all(applications.splice(0).map((app) => app.close()));
  });

  it("returns original bytes, trusted headers, and matching GET/HEAD metadata", async () => {
    const { app } = createApp();
    applications.push(app);
    const cookie = await createDemoSession(app);

    const get = await app.inject({
      method: "GET",
      url: "/abc12/a.html",
      headers: { cookie, host: "demo.localhost" },
    });
    const head = await app.inject({
      method: "HEAD",
      url: "/abc12/a.html",
      headers: { cookie, host: "demo.localhost" },
    });

    expect(get.statusCode).toBe(200);
    expect(get.body).toBe(HTML);
    expect(get.headers["content-type"]).toBe("text/html; charset=utf-8");
    expect(get.headers["content-length"]).toBe(String(Buffer.byteLength(HTML)));
    expect(get.headers.etag).toBe(`"${HASH}"`);
    expect(get.headers["x-content-type-options"]).toBe("nosniff");
    expect(get.headers["x-robots-tag"]).toBe("noindex");
    expect(get.headers["referrer-policy"]).toBe("no-referrer");
    expect(head.statusCode).toBe(200);
    expect(head.body).toBe("");
    expect(head.headers["content-type"]).toBe(get.headers["content-type"]);
    expect(head.headers["content-length"]).toBe(get.headers["content-length"]);
    expect(head.headers.etag).toBe(get.headers.etag);
  });

  it("honors ETag validation without opening the private object", async () => {
    const { app, reads } = createApp();
    applications.push(app);
    const cookie = await createDemoSession(app);

    const response = await app.inject({
      method: "GET",
      url: "/abc12/a.html",
      headers: { cookie, host: "demo.localhost", "if-none-match": `"${HASH}"` },
    });

    expect(response.statusCode).toBe(304);
    expect(response.body).toBe("");
    expect(response.headers.etag).toBe(`"${HASH}"`);
    expect(reads()).toBe(0);
  });

  it("limits authenticated content reads before opening private objects", async () => {
    const { app, reads } = createApp({ contentSessionLimit: 1 });
    applications.push(app);
    const cookie = await createDemoSession(app);

    const first = await app.inject({
      method: "GET",
      url: "/abc12/a.html",
      headers: { cookie, host: "demo.localhost" },
    });
    const limited = await app.inject({
      method: "GET",
      url: "/abc12/a.html",
      headers: { cookie, host: "demo.localhost" },
    });

    expect(first.statusCode).toBe(200);
    expect(limited.statusCode).toBe(429);
    expect(limited.headers["retry-after"]).toBe("60");
    expect(reads()).toBe(1);
  });

  it("does not leak a known file ETag when its private object is unavailable", async () => {
    const { app } = createApp({ objectExists: false });
    applications.push(app);
    const cookie = await createDemoSession(app);

    const response = await app.inject({
      method: "GET",
      url: "/abc12/a.html",
      headers: { cookie, host: "demo.localhost" },
    });

    expect(response.statusCode).toBe(404);
    expect(response.headers.etag).toBeUndefined();
    expect(response.headers["content-length"]).toBe(String(Buffer.byteLength(response.body)));
  });

  it("uses one indistinguishable 404 for unavailable content and path attacks", async () => {
    const { app } = createApp();
    applications.push(app);
    const cookie = await createDemoSession(app);
    const urls = [
      "/",
      "/abc12",
      "/abc12/",
      "/abc12/missing.html",
      "/abc12/%2e%2e/a.html",
      "/abc12/%252e%252e/a.html",
      "/abc12/%00a.html",
      "/abc12%5c/a.html",
      "/ABC12/a.html",
    ];
    const responses = await Promise.all(
      urls.map((url) =>
        app.inject({ method: "GET", url, headers: { cookie, host: "demo.localhost" } }),
      ),
    );

    for (const response of responses) {
      expect(response.statusCode).toBe(404);
      expect(response.body).toBe(responses[0]?.body);
      expect(response.headers["x-robots-tag"]).toBe("noindex");
    }
  });

  it("does not accept app sessions and keeps management APIs off the Demo host", async () => {
    const { app } = createApp();
    applications.push(app);
    const appCookie = await createAppSession(app);

    const content = await app.inject({
      method: "GET",
      url: "/abc12/a.html",
      headers: { cookie: appCookie, host: "demo.localhost" },
    });
    const tokens = await app.inject({
      method: "GET",
      url: "/api/tokens",
      headers: { cookie: appCookie, host: "demo.localhost" },
    });
    const mcp = await app.inject({
      method: "POST",
      url: "/mcp",
      headers: { host: "demo.localhost" },
    });
    const mcpGet = await app.inject({
      method: "GET",
      url: "/mcp",
      headers: { host: "demo.localhost" },
    });
    const mcpDelete = await app.inject({
      method: "DELETE",
      url: "/mcp",
      headers: { host: "demo.localhost" },
    });
    const health = await app.inject({
      method: "GET",
      url: "/health/live",
      headers: { host: "demo.localhost" },
    });

    expect(content.statusCode).toBe(302);
    expect(content.body).toBe("");
    expect(tokens.statusCode).toBe(404);
    expect(mcp.statusCode).toBe(404);
    expect(mcpGet.statusCode).toBe(404);
    expect(mcpDelete.statusCode).toBe(404);
    expect(health.statusCode).toBe(404);
  });
});

function createApp(options?: { contentSessionLimit?: number; objectExists?: boolean }) {
  let reads = 0;
  const projects: ProjectReader = {
    async findCurrentFile({ projectKey, relativePath, tenantId }) {
      return projectKey === "abc12" && relativePath === "a.html" && tenantId === "test-dingtalk-app"
        ? FILE
        : null;
    },
  };
  const storage: ObjectStore = {
    async createPresignedUpload() {
      throw new Error("not used");
    },
    async deleteObjects() {
      return undefined;
    },
    async ensurePrivateBucket() {
      return undefined;
    },
    async getObject(key) {
      expect(key).toBe(FILE.storageKey);
      reads += 1;
      return Readable.from([HTML]);
    },
    async headObject() {
      return options?.objectExists === false
        ? null
        : {
            contentMd5: "AAAAAAAAAAAAAAAAAAAAAA==",
            contentType: "text/html; charset=utf-8",
            size: FILE.size,
          };
    },
    async listObjects() {
      return { keys: [] };
    },
  };
  return {
    app: buildServerApp({
      appAuthUrl: "http://app.localhost:3001",
      appHost: "app.localhost",
      appWebUrl: "http://app.localhost:3000",
      authSessions: createAuthSessionService({
        repository: new InMemoryAuthRepository(),
        stateSecret: "phase-five-state-signing-secret-with-enough-length",
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
        hashSecret: "phase-five-mcp-token-hash-secret-with-enough-length",
        repository: new InMemoryMcpTokenRepository(),
      }),
      ...(options?.contentSessionLimit === undefined
        ? {}
        : {
            rateLimits: {
              authPerMinute: 30,
              contentIpPerMinute: 1200,
              contentSessionPerMinute: options.contentSessionLimit,
              mcpPerMinute: 60,
              mcpUploadCompletePerMinute: 10,
              mcpUploadPreparePerMinute: 10,
            },
          }),
      projects,
      storage,
    }),
    reads: () => reads,
  };
}
