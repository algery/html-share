import { describe, expect, it } from "vitest";

import { InMemoryMcpTokenRepository } from "./in-memory-token-repository.js";
import { createMcpTokenService, McpTokenError } from "./token-service.js";

const USER = {
  dingtalkUserId: "ding-user-1",
  displayName: "Token Tester",
  id: "user-1",
};
const HASH_SECRET = "test-mcp-token-hash-secret-with-enough-length";

describe("MCP token service", () => {
  it("returns a random token only once and stores only its safe summary", async () => {
    const service = createMcpTokenService({
      hashSecret: HASH_SECRET,
      now: () => new Date("2026-09-02T00:00:00.000Z"),
      repository: new InMemoryMcpTokenRepository(),
    });

    const created = await service.createToken({ name: " Codex laptop ", user: USER });
    const listed = await service.listTokens({ userId: USER.id });

    expect(created.token).toMatch(/^hsp_[A-Za-z0-9_-]{43}$/);
    expect(created.summary).toMatchObject({
      name: "Codex laptop",
      status: "active",
      tokenSuffix: created.token.slice(-6),
    });
    expect(created.summary.expiresAt?.getTime()).toBe(
      created.summary.createdAt.getTime() + 30 * 24 * 60 * 60 * 1000,
    );
    expect(JSON.stringify(listed)).not.toContain(created.token);
    expect(listed).toEqual([created.summary]);
  });

  it("uses a keyed HMAC digest rather than accepting a Token under another secret", async () => {
    const repository = new InMemoryMcpTokenRepository();
    const firstService = createMcpTokenService({ hashSecret: HASH_SECRET, repository });
    const secondService = createMcpTokenService({
      hashSecret: "another-mcp-token-hash-secret-with-enough-length",
      repository,
    });
    const created = await firstService.createToken({ name: "HMAC test", user: USER });

    expect(await firstService.authenticate({ token: created.token })).not.toBeNull();
    expect(await secondService.authenticate({ token: created.token })).toBeNull();
  });

  it("authenticates only active, non-expired tokens and records successful use", async () => {
    let currentTime = new Date("2026-09-02T00:00:00.000Z");
    const service = createMcpTokenService({
      hashSecret: HASH_SECRET,
      now: () => currentTime,
      repository: new InMemoryMcpTokenRepository(),
    });
    const created = await service.createToken({ name: "Claude Code", user: USER });

    const authenticated = await service.authenticate({ token: created.token });
    expect(authenticated?.user).toEqual(USER);
    await service.recordTokenUse({ tokenId: created.summary.id });
    const listed = await service.listTokens({ userId: USER.id });
    expect(listed[0]?.lastUsedAt).toEqual(currentTime);

    expect(await service.revokeToken({ tokenId: created.summary.id, userId: USER.id })).toBe(true);
    expect(await service.authenticate({ token: created.token })).toBeNull();

    const next = await service.createToken({ name: "Expiry", user: USER });
    currentTime = new Date(currentTime.getTime() + 30 * 24 * 60 * 60 * 1000);
    expect(await service.authenticate({ token: next.token })).toBeNull();
    expect(await service.authenticate({ token: "not-a-token" })).toBeNull();
  });

  it("keeps token ownership isolated and validates names", async () => {
    const service = createMcpTokenService({
      hashSecret: HASH_SECRET,
      repository: new InMemoryMcpTokenRepository(),
    });
    const created = await service.createToken({ name: "Personal", user: USER });

    expect(await service.revokeToken({ tokenId: created.summary.id, userId: "another-user" })).toBe(
      false,
    );
    await expect(service.createToken({ name: " ", user: USER })).rejects.toEqual(
      new McpTokenError("TOKEN_NAME_INVALID"),
    );
    await expect(service.createToken({ name: "x".repeat(41), user: USER })).rejects.toEqual(
      new McpTokenError("TOKEN_NAME_INVALID"),
    );
  });
});
