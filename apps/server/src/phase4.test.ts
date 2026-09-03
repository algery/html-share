import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";

import {
  createAuthSessionService,
  createMcpTokenService,
  createUploadService,
  InMemoryAuthRepository,
  InMemoryMcpTokenRepository,
  InMemoryUploadRepository,
} from "@html-share/core";
import type { UploadService } from "@html-share/core";
import { createSimulatorDingTalkClient } from "@html-share/dingtalk";
import type { ObjectStore } from "@html-share/storage";

import { buildServerApp } from "./app.js";

const HASH_SECRET = "phase-four-mcp-token-hash-secret-with-enough-length";
const USER = {
  dingtalkUserId: "publisher",
  displayName: "Publisher",
  id: "publisher-1",
};

describe("Phase 4 MCP upload tools", () => {
  const applications: FastifyInstance[] = [];

  afterEach(async () => {
    await Promise.all(applications.splice(0).map((app) => app.close()));
  });

  it("returns a direct ZIP upload URL and idempotently reuses the upload task", async () => {
    const tokens = createMcpTokenService({
      hashSecret: HASH_SECRET,
      repository: new InMemoryMcpTokenRepository(),
    });
    const app = createApp(tokens);
    applications.push(app);
    const created = await tokens.createToken({ name: "publisher", user: USER });
    const address = await app.listen({ host: "127.0.0.1", port: 0 });
    const client = await connect(address, created.token);
    const args = {
      action: "create",
      archive_size: 12,
      client_request_id: "d290f1ee-6c54-4b01-90e6-d701748f0851",
      display_name: "Demo",
      file_count: 1,
      manifest_digest: "a".repeat(64),
      target_html: "index.html",
      total_size: 12,
    };
    const first = await client.callTool({ arguments: args, name: "prepare_demo_upload" });
    const second = await client.callTool({ arguments: args, name: "prepare_demo_upload" });
    const firstResult = responseJson(first);
    const secondResult = responseJson(second);

    expect(firstResult).toMatchObject({
      idempotent: false,
      project_id: expect.stringMatching(/^[a-z0-9]{5}$/),
      upload_headers: { "content-length": "12", "content-type": "application/zip" },
      upload_url: expect.stringContaining("temporary/uploads/"),
    });
    expect(secondResult).toMatchObject({ idempotent: true, upload_id: firstResult["upload_id"] });
    expect(JSON.stringify(first)).not.toContain("<html");
    await client.close();
  });

  it("does not allow a different token owner to overwrite a project", async () => {
    const repository = new InMemoryUploadRepository();
    const tokens = createMcpTokenService({
      hashSecret: HASH_SECRET,
      repository: new InMemoryMcpTokenRepository(),
    });
    const app = createApp(tokens, repository);
    applications.push(app);
    const ownerToken = await tokens.createToken({ name: "owner", user: USER });
    const otherToken = await tokens.createToken({
      name: "other",
      user: {
        dingtalkUserId: "other",
        displayName: "Other",
        id: "other-1",
      },
    });
    const address = await app.listen({ host: "127.0.0.1", port: 0 });
    const owner = await connect(address, ownerToken.token);
    const created = responseJson(
      await owner.callTool({
        arguments: {
          action: "create",
          archive_size: 1,
          client_request_id: "01d14e3f-3cad-49f6-95ea-bae0305b9a89",
          display_name: "Demo",
          file_count: 1,
          manifest_digest: "b".repeat(64),
          target_html: "index.html",
          total_size: 1,
        },
        name: "prepare_demo_upload",
      }),
    );
    const other = await connect(address, otherToken.token);
    const response = await other.callTool({
      arguments: {
        action: "replace",
        archive_size: 1,
        client_request_id: "7d00d00e-aae9-4fac-9489-49061158fa7d",
        display_name: "Changed",
        file_count: 1,
        manifest_digest: "c".repeat(64),
        project_id: created["project_id"],
        target_html: "index.html",
        total_size: 1,
      },
      name: "prepare_demo_upload",
    });
    expect(response.isError).toBe(true);
    expect(responseJson(response)).toMatchObject({ error: "project_forbidden" });
    await owner.close();
    await other.close();
  });

  it("does not issue a new PUT address for an already completed idempotent request", async () => {
    const tokens = createMcpTokenService({
      hashSecret: HASH_SECRET,
      repository: new InMemoryMcpTokenRepository(),
    });
    const app = createApp(tokens, new InMemoryUploadRepository(), completedUploads);
    applications.push(app);
    const created = await tokens.createToken({ name: "publisher", user: USER });
    const address = await app.listen({ host: "127.0.0.1", port: 0 });
    const client = await connect(address, created.token);

    const result = responseJson(
      await client.callTool({
        arguments: {
          action: "create",
          archive_size: 1,
          client_request_id: "4b836981-c347-4d3c-98ec-f742f920347f",
          display_name: "Demo",
          file_count: 1,
          manifest_digest: "a".repeat(64),
          target_html: "index.html",
          total_size: 1,
        },
        name: "prepare_demo_upload",
      }),
    );

    expect(result).toMatchObject({ idempotent: true, status: "completed" });
    expect(result).not.toHaveProperty("upload_url");
    expect(result).not.toHaveProperty("upload_headers");
    await client.close();
  });

  it("does not reissue a PUT address after a task enters processing", async () => {
    const tokens = createMcpTokenService({
      hashSecret: HASH_SECRET,
      repository: new InMemoryMcpTokenRepository(),
    });
    const app = createApp(tokens);
    applications.push(app);
    const created = await tokens.createToken({ name: "publisher", user: USER });
    const address = await app.listen({ host: "127.0.0.1", port: 0 });
    const client = await connect(address, created.token);
    const args = {
      action: "create",
      archive_size: 1,
      client_request_id: "dba7aa3f-c1dc-42d6-a902-1f9be1d14411",
      display_name: "Demo",
      file_count: 1,
      manifest_digest: "a".repeat(64),
      target_html: "index.html",
      total_size: 1,
    };
    const prepared = responseJson(
      await client.callTool({ arguments: args, name: "prepare_demo_upload" }),
    );
    await client.callTool({
      arguments: { upload_id: prepared["upload_id"] },
      name: "complete_demo_upload",
    });
    const retried = responseJson(
      await client.callTool({ arguments: args, name: "prepare_demo_upload" }),
    );

    expect(retried).toMatchObject({ idempotent: true, status: "processing" });
    expect(retried).not.toHaveProperty("upload_url");
    expect(retried).not.toHaveProperty("upload_headers");
    await client.close();
  });

  it("reports the upload status only to the task owner", async () => {
    const tokens = createMcpTokenService({
      hashSecret: HASH_SECRET,
      repository: new InMemoryMcpTokenRepository(),
    });
    const app = createApp(tokens);
    applications.push(app);
    const created = await tokens.createToken({ name: "publisher", user: USER });
    const address = await app.listen({ host: "127.0.0.1", port: 0 });
    const client = await connect(address, created.token);
    const prepared = responseJson(
      await client.callTool({
        arguments: {
          action: "create",
          archive_size: 1,
          client_request_id: "1e84bf87-3b23-45fe-b598-7ed8b0b630f2",
          display_name: "Demo",
          file_count: 1,
          manifest_digest: "d".repeat(64),
          target_html: "index.html",
          total_size: 1,
        },
        name: "prepare_demo_upload",
      }),
    );
    const status = responseJson(
      await client.callTool({
        arguments: { upload_id: prepared["upload_id"] },
        name: "get_demo_upload_status",
      }),
    );
    expect(status).toMatchObject({ project_id: prepared["project_id"], status: "prepared" });
    await client.close();
  });
});

function createApp(
  tokens: ReturnType<typeof createMcpTokenService>,
  repository = new InMemoryUploadRepository(),
  uploads: UploadService = createUploadService({ repository }),
) {
  return buildServerApp({
    appAuthUrl: "http://127.0.0.1:3001",
    appHost: "127.0.0.1",
    appWebUrl: "http://app.localhost:3000",
    authSessions: createAuthSessionService({
      repository: new InMemoryAuthRepository(),
      stateSecret: "phase-four-state-signing-secret-with-enough-length",
      tenantAppKeyRef: "test-dingtalk-app",
    }),
    demoAuthUrl: "http://demo.localhost:3001",
    demoHost: "demo.localhost",
    demoWebUrl: "http://demo.localhost:3001",
    dingtalk: createSimulatorDingTalkClient(),
    logger: false,
    mcpTokens: tokens,
    storage: fakeStorage,
    uploads,
  });
}

const completedUploads: UploadService = {
  async complete() {
    throw new Error("not used");
  },
  async status() {
    throw new Error("not used");
  },
  async prepare() {
    return {
      archiveSize: 1,
      expiresAt: new Date("2026-09-02T00:05:00.000Z"),
      idempotent: true,
      projectId: "abc12",
      status: "completed",
      temporaryObjectKey: "temporary/uploads/already-complete.zip",
      uploadId: "cc843430-74d7-4f4b-949f-a37a1c20c95a",
    };
  },
};

async function connect(address: string, token: string) {
  const client = new Client({ name: "phase4-test", version: "1.0.0" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL("/mcp", address), {
      requestInit: { headers: { Authorization: `Bearer ${token}` } },
    }),
  );
  return client;
}

function responseJson(response: { content: { type: string; text?: string }[] }) {
  const text = response.content.find((item) => item.type === "text")?.text;
  if (text === undefined) throw new Error("missing MCP text result");
  return JSON.parse(text) as Record<string, string | boolean | Record<string, string>>;
}

const fakeStorage: ObjectStore = {
  async createPresignedZipUpload(input) {
    return {
      headers: {
        "content-length": String(input.contentLength),
        "content-type": "application/zip",
      },
      url: `https://storage.test/${input.key}`,
    };
  },
  async deleteObjects() {
    return undefined;
  },
  async ensurePrivateBucket() {
    return undefined;
  },
  async getObject() {
    throw new Error("not used in MCP tests");
  },
  async headObject() {
    return null;
  },
  async putObject() {
    return undefined;
  },
};
