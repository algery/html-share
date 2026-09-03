import { describe, expect, it } from "vitest";

import {
  createMcpRateLimiter,
  createUploadToolRateLimiter,
  hasTokenQueryParameter,
} from "./auth.js";

const TOKEN = {
  createdAt: new Date("2026-09-02T00:00:00.000Z"),
  expiresAt: new Date("2026-10-02T00:00:00.000Z"),
  id: "token-1",
  lastUsedAt: null,
  name: "Test token",
  revokedAt: null,
  status: "active" as const,
  tokenSuffix: "suffix",
  user: { dingtalkUserId: "ding-user-1", displayName: "Tester", id: "user-1" },
};

describe("MCP authentication helpers", () => {
  it("rejects bearer credentials in URL query parameters", () => {
    expect(hasTokenQueryParameter("/mcp?token=value")).toBe(true);
    expect(hasTokenQueryParameter("/mcp?access_token=value")).toBe(true);
    expect(hasTokenQueryParameter("/mcp?request_id=value")).toBe(false);
  });

  it("enforces each token, user and IP key at 60 calls per minute", () => {
    let current = new Date("2026-09-02T00:00:00.000Z");
    const limiter = createMcpRateLimiter({ now: () => current });
    for (let index = 0; index < 60; index += 1) {
      expect(limiter.consume({ ip: "127.0.0.1", token: TOKEN }).allowed).toBe(true);
    }
    expect(limiter.consume({ ip: "127.0.0.1", token: TOKEN })).toEqual({
      allowed: false,
      retryAfterSeconds: 60,
    });

    current = new Date(current.getTime() + 60 * 1000);
    expect(limiter.consume({ ip: "127.0.0.1", token: TOKEN }).allowed).toBe(true);
  });

  it("limits prepare by user and complete by upload task", () => {
    const limiter = createUploadToolRateLimiter();
    for (let index = 0; index < 10; index += 1) {
      expect(limiter.consumePrepare("user-1").allowed).toBe(true);
      expect(limiter.consumeComplete("upload-1").allowed).toBe(true);
    }
    expect(limiter.consumePrepare("user-1").allowed).toBe(false);
    expect(limiter.consumeComplete("upload-1").allowed).toBe(false);
    expect(limiter.consumePrepare("user-2").allowed).toBe(true);
    expect(limiter.consumeComplete("upload-2").allowed).toBe(true);
  });
});
