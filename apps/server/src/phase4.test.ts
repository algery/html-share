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
import { Phase4FakeStorage } from "./phase4-storage.test-helper.js";
import {
  coverArgs,
  digestForWire,
  filesFor,
  manifestFile,
  prepareArgs,
  responseJson,
} from "./phase4-manifest.test-helper.js";

const HASH_SECRET = "phase-four-mcp-token-hash-secret-with-enough-length";
const USER = { dingtalkUserId: "publisher", displayName: "Publisher", id: "publisher-1" };

describe("Phase 4 MCP upload tools", () => {
  const applications: FastifyInstance[] = [];

  afterEach(async () => Promise.all(applications.splice(0).map((app) => app.close())));

  it("returns exact five-minute per-file PUT contracts and reuses an idempotent task", async () => {
    const { client, storage } = await testClient(applications);
    const args = prepareArgs();
    const first = responseJson(
      await client.callTool({ arguments: args, name: "prepare_demo_upload" }),
    );
    const second = responseJson(
      await client.callTool({ arguments: args, name: "prepare_demo_upload" }),
    );

    expect(first).toMatchObject({
      idempotent: false,
      project_id: expect.stringMatching(/^[a-z0-9]{5}$/),
      status: "prepared",
      uploads: [
        {
          relative_path: "index.html",
          upload_headers: {
            "content-length": "4",
            "content-md5": filesFor("demo")[0]?.content_md5,
            "content-type": "text/html; charset=utf-8",
          },
          upload_url: expect.stringContaining("/revisions/1/index.html"),
        },
      ],
    });
    expect(storage.signed[0]?.expiresInSeconds).toBeGreaterThanOrEqual(299);
    expect(storage.signed[0]?.expiresInSeconds).toBeLessThanOrEqual(300);
    expect(second).toMatchObject({ idempotent: true, upload_id: first["upload_id"] });
    expect(JSON.stringify(first)).not.toContain("<html");
    await client.close();
  });

  it("signs one optional JPEG per prepared upload and only reissues the same declaration", async () => {
    const { client, storage } = await testClient(applications);
    const prepared = responseJson(
      await client.callTool({ arguments: prepareArgs(), name: "prepare_demo_upload" }),
    );
    expect(prepared["cover_homepage"]).toBe("index.html");
    const args = coverArgs(prepared["upload_id"]);
    const call = (arguments_: Record<string, unknown>) =>
      client.callTool({ arguments: arguments_, name: "prepare_demo_cover" });

    const cover = responseJson(await call(args));
    expect(cover).toEqual({
      upload_headers: {
        "content-length": "10",
        "content-md5": args.content_md5,
        "content-type": "image/jpeg",
      },
      upload_url: expect.stringContaining(`/${prepared["upload_id"]}.jpg`),
    });
    expect(responseJson(await call(args))).toEqual(cover);
    expect((await call({ ...args, size: 11 })).isError).toBe(true);
    expect((await call({ ...args, homepage_path: "other.html" })).isError).toBe(true);
    expect((await call({ ...args, size: 1024 * 1024 + 1 })).isError).toBe(true);
    await client.callTool({
      arguments: { upload_id: args.upload_id },
      name: "complete_demo_upload",
    });
    expect((await call(args)).isError).toBe(true);
    expect(storage.signed).toHaveLength(3);
    expect(storage.signed[1]?.expiresInSeconds).toBeLessThanOrEqual(300);
    await client.close();
  });

  it("explicitly rejects the retired ZIP protocol with upgrade guidance", async () => {
    const { client } = await testClient(applications);
    const response = await client.callTool({
      arguments: {
        action: "create",
        archive_size: 12,
        client_request_id: "d290f1ee-6c54-4b01-90e6-d701748f0851",
        display_name: "Old client",
        file_count: 1,
        manifest_digest: "a".repeat(64),
        target_html: "index.html",
        total_size: 12,
      },
      name: "prepare_demo_upload",
    });
    expect(response.isError).toBe(true);
    expect(responseJson(response)).toMatchObject({ error: "upload_protocol_unsupported" });
    expect(JSON.stringify(responseJson(response))).toContain("升级");
    await client.close();
  });

  it("returns one exact signed contract for every one of 500 accepted files", async () => {
    const { client, storage } = await testClient(applications);
    const files = Array.from({ length: 500 }, (_, index) =>
      manifestFile(index === 0 ? "index.html" : `assets/${index}.txt`, "x"),
    );
    const result = responseJson(
      await client.callTool({
        arguments: prepareArgs({ files, manifest_digest: digestForWire(files) }),
        name: "prepare_demo_upload",
      }),
    );
    expect(result["uploads"]).toHaveLength(500);
    expect(storage.signed).toHaveLength(500);
    expect(storage.signed.every((input) => input.expiresInSeconds === 300)).toBe(true);
    await client.close();
  });

  it("does not allow a different token owner to overwrite a project", async () => {
    const repository = new InMemoryUploadRepository();
    const tokens = tokenService();
    const app = createApp(tokens, repository);
    applications.push(app);
    const ownerToken = await tokens.createToken({ name: "owner", user: USER });
    const otherToken = await tokens.createToken({
      name: "other",
      user: { dingtalkUserId: "other", displayName: "Other", id: "other-1" },
    });
    const address = await app.listen({ host: "127.0.0.1", port: 0 });
    const owner = await connect(address, ownerToken.token);
    const created = responseJson(
      await owner.callTool({ arguments: prepareArgs(), name: "prepare_demo_upload" }),
    );
    const other = await connect(address, otherToken.token);
    const response = await other.callTool({
      arguments: prepareArgs({
        action: "replace",
        client_request_id: "7d00d00e-aae9-4fac-9489-49061158fa7d",
        project_id: created["project_id"],
      }),
      name: "prepare_demo_upload",
    });
    expect(response.isError).toBe(true);
    expect(responseJson(response)).toMatchObject({ error: "project_forbidden" });
    const otherCover = await other.callTool({
      arguments: coverArgs(created["upload_id"]),
      name: "prepare_demo_cover",
    });
    expect(otherCover.isError).toBe(true);
    expect(responseJson(otherCover)).toMatchObject({ error: "upload_not_found" });
    await owner.close();
    await other.close();
  });

  it("does not reissue URLs after a task is processing or completed", async () => {
    const processing = await testClient(applications);
    const args = prepareArgs();
    const prepared = responseJson(
      await processing.client.callTool({ arguments: args, name: "prepare_demo_upload" }),
    );
    await processing.client.callTool({
      arguments: { upload_id: prepared["upload_id"] },
      name: "complete_demo_upload",
    });
    const retried = responseJson(
      await processing.client.callTool({ arguments: args, name: "prepare_demo_upload" }),
    );
    expect(retried).toMatchObject({ idempotent: true, status: "processing" });
    expect(retried).not.toHaveProperty("uploads");
    await processing.client.close();

    const completed = await testClient(applications, completedUploads);
    const result = responseJson(
      await completed.client.callTool({ arguments: args, name: "prepare_demo_upload" }),
    );
    expect(result).toMatchObject({ idempotent: true, status: "completed" });
    expect(result).not.toHaveProperty("uploads");
    await completed.client.close();
  });
});

async function testClient(applications: FastifyInstance[], uploads?: UploadService) {
  const tokens = tokenService();
  const storage = new Phase4FakeStorage();
  const app = createApp(tokens, new InMemoryUploadRepository(), uploads, storage);
  applications.push(app);
  const created = await tokens.createToken({ name: "publisher", user: USER });
  const address = await app.listen({ host: "127.0.0.1", port: 0 });
  return { client: await connect(address, created.token), storage };
}

function createApp(
  tokens: ReturnType<typeof createMcpTokenService>,
  repository = new InMemoryUploadRepository(),
  uploads: UploadService = createUploadService({ repository }),
  storage: ObjectStore = new Phase4FakeStorage(),
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
    storage,
    uploads,
  });
}

const completedUploads: UploadService = {
  async prepareCover() {
    throw new Error("not used");
  },
  async complete() {
    throw new Error("not used");
  },
  async status() {
    throw new Error("not used");
  },
  async prepare() {
    return {
      expiresAt: new Date("2026-09-02T00:05:00.000Z"),
      files: [],
      idempotent: true,
      projectId: "abc12",
      revisionNumber: 1,
      status: "completed",
      uploadId: "cc843430-74d7-4f4b-949f-a37a1c20c95a",
    };
  },
};

function tokenService() {
  return createMcpTokenService({
    hashSecret: HASH_SECRET,
    repository: new InMemoryMcpTokenRepository(),
  });
}

async function connect(address: string, token: string) {
  const client = new Client({ name: "phase4-test", version: "1.0.0" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL("/mcp", address), {
      requestInit: { headers: { Authorization: `Bearer ${token}` } },
    }),
  );
  return client;
}
