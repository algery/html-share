import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";

import {
  createMcpTokenService,
  createProjectDeletionService,
  InMemoryMcpTokenRepository,
  type AuthSessionService,
  type ProjectDeletionRepository,
} from "@html-share/core";
import { createSimulatorDingTalkClient } from "@html-share/dingtalk";

import { buildServerApp } from "./app.js";

describe("Phase 8 deletion APIs", () => {
  const applications: FastifyInstance[] = [];

  afterEach(async () => {
    await Promise.all(applications.splice(0).map((app) => app.close()));
  });

  it("requires trusted origin and CSRF confirmation before an owner can delete", async () => {
    const repository = new FakeDeletionRepository();
    const app = createApp(repository);
    applications.push(app);

    const [missingCsrf, wrongOrigin, deleted, repeated] = await Promise.all([
      requestDelete(app, {}),
      requestDelete(app, { origin: "https://attacker.test", "x-html-share-csrf": "csrf-test" }),
      requestDelete(app, {
        cookie: "html_share_csrf=csrf-test",
        origin: "http://app.localhost:3000",
        "x-html-share-csrf": "csrf-test",
      }),
      requestDelete(app, {
        cookie: "html_share_csrf=csrf-test",
        origin: "http://app.localhost:3000",
        "x-html-share-csrf": "csrf-test",
      }),
    ]);

    expect(missingCsrf.statusCode).toBe(403);
    expect(wrongOrigin.statusCode).toBe(403);
    expect(deleted.json()).toEqual({ status: "deleted" });
    expect(repeated.json()).toEqual({ status: "already_deleted" });
    expect(repository.ownerRequests).toBe(2);
  });

  it("keeps owner authorization failures private and enforces the ten-per-minute deletion limit", async () => {
    const repository = new FakeDeletionRepository();
    repository.ownerOutcome = "forbidden";
    const app = createApp(repository);
    applications.push(app);
    const headers = {
      cookie: "html_share_csrf=csrf-test",
      origin: "http://app.localhost:3000",
      "x-html-share-csrf": "csrf-test",
    };

    await expect(requestDelete(app, headers)).resolves.toMatchObject({ statusCode: 403 });
    repository.ownerOutcome = "already_deleted";
    for (let index = 0; index < 9; index += 1) await requestDelete(app, headers);
    const limited = await requestDelete(app, headers);
    expect(limited.statusCode).toBe(429);
    expect(limited.headers["retry-after"]).toBeDefined();
  });

  it("allows configured administrators to inspect exact metadata and delete with an audited reason", async () => {
    const repository = new FakeDeletionRepository();
    const app = createApp(repository, "simulator-user-001");
    applications.push(app);
    const headers = {
      cookie: "html_share_csrf=csrf-test",
      host: "app.localhost",
      origin: "http://app.localhost:3000",
      "x-html-share-csrf": "csrf-test",
      "x-trace-id": "trace-phase8",
    };

    const lookedUp = await app.inject({ method: "GET", url: "/api/admin/projects/abc12", headers });
    const deleted = await app.inject({
      method: "POST",
      url: "/api/admin/projects/abc12/delete",
      headers,
      payload: { reason: "误传包含客户信息，已完成合规复核。" },
    });

    expect(lookedUp.statusCode).toBe(200);
    expect(lookedUp.json()).toMatchObject({ project: { projectKey: "abc12" } });
    expect(deleted.json()).toEqual({ status: "deleted" });
    expect(repository.adminInput).toMatchObject({
      reason: "误传包含客户信息，已完成合规复核。",
      traceId: "trace-phase8",
    });
  });

  it("audits configured administrator delete-rate-limit events", async () => {
    const repository = new FakeDeletionRepository();
    const app = createApp(repository, "simulator-user-001");
    applications.push(app);
    const headers = {
      cookie: "html_share_csrf=csrf-test",
      host: "app.localhost",
      origin: "http://app.localhost:3000",
      "x-html-share-csrf": "csrf-test",
      "x-trace-id": "trace-rate-limit",
    };

    for (let index = 0; index < 5; index += 1) {
      await app.inject({
        method: "POST",
        url: "/api/admin/projects/abc12/delete",
        headers,
        payload: { reason: "管理员限流审计测试原因。" },
      });
    }
    const limited = await app.inject({
      method: "POST",
      url: "/api/admin/projects/abc12/delete",
      headers,
      payload: { reason: "管理员限流审计测试原因。" },
    });

    expect(limited.statusCode).toBe(429);
    expect(repository.rateLimitInputs).toEqual([
      expect.objectContaining({ requestIp: "127.0.0.1", traceId: "trace-rate-limit" }),
    ]);
  });

  it("returns 403 without project metadata to ordinary members", async () => {
    const app = createApp(new FakeDeletionRepository(), "different-administrator");
    applications.push(app);

    const response = await app.inject({
      method: "GET",
      url: "/api/admin/projects/abc12",
      headers: { host: "app.localhost" },
    });

    expect(response.statusCode).toBe(403);
    expect(response.body).not.toContain("Owner");
  });
});

function createApp(repository: FakeDeletionRepository, administrator = "") {
  const deletion = createProjectDeletionService({
    administratorDingTalkUserIds: administrator.length === 0 ? [] : [administrator],
    repository,
  });
  return buildServerApp({
    appAuthUrl: "http://app.localhost:3001",
    appHost: "app.localhost",
    appWebUrl: "http://app.localhost:3000",
    authSessions: fakeSessions(),
    demoAuthUrl: "http://demo.localhost:3001",
    demoHost: "demo.localhost",
    demoWebUrl: "http://demo.localhost:3001",
    dingtalk: createSimulatorDingTalkClient(),
    logger: false,
    mcpTokens: createMcpTokenService({
      hashSecret: "phase-eight-mcp-token-hash-secret-with-enough-length",
      repository: new InMemoryMcpTokenRepository(),
    }),
    projectDeletion: deletion,
  });
}

function fakeSessions() {
  return {
    createCsrfToken() {
      return "csrf-test";
    },
    async getSession() {
      return {
        audience: "app" as const,
        expiresAt: new Date("2026-09-04T00:00:00.000Z"),
        id: "session-1",
        tenantId: "tenant-1",
        user: { dingtalkUserId: "simulator-user-001", displayName: "Member", id: "user-1" },
      };
    },
    validateCsrfToken(input: { csrfToken: string | undefined }) {
      return input.csrfToken === "csrf-test";
    },
  } as unknown as AuthSessionService;
}

function requestDelete(app: FastifyInstance, headers: Record<string, string>) {
  return app.inject({
    method: "POST",
    url: "/api/projects/abc12/delete",
    headers: { host: "app.localhost", ...headers },
    payload: { confirmation: "abc12" },
  });
}

class FakeDeletionRepository implements ProjectDeletionRepository {
  adminInput: Parameters<ProjectDeletionRepository["deleteAsAdministrator"]>[0] | undefined;
  ownerOutcome: "already_deleted" | "deleted" | "forbidden" | "not_found" = "deleted";
  ownerRequests = 0;
  rateLimitInputs: Parameters<ProjectDeletionRepository["recordAdministratorRateLimit"]>[0][] = [];

  async deleteAsAdministrator(
    input: Parameters<ProjectDeletionRepository["deleteAsAdministrator"]>[0],
  ) {
    this.adminInput = input;
    return "deleted" as const;
  }

  async deleteAsOwner() {
    this.ownerRequests += 1;
    if (this.ownerRequests > 1 && this.ownerOutcome === "deleted")
      return "already_deleted" as const;
    return this.ownerOutcome;
  }

  async findForAdministrator() {
    return {
      createdAt: new Date("2026-09-01T00:00:00.000Z"),
      displayName: "Demo",
      ownerDisplayName: "Owner",
      ownerUserId: "owner-1",
      projectKey: "abc12",
      status: "active" as const,
      totalSize: 12,
      updatedAt: new Date("2026-09-03T00:00:00.000Z"),
    };
  }

  async recordAdministratorRateLimit(
    input: Parameters<ProjectDeletionRepository["recordAdministratorRateLimit"]>[0],
  ) {
    this.rateLimitInputs.push(input);
  }
}
