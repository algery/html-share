import { createHmac, randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";

import {
  createPasswordState,
  readPasswordReturnPath,
  readPasswordState,
} from "./password-state.js";
import { createPasswordRateLimiter } from "./password-rate-limit.js";

const secret = "password-return-state-test-secret-32-characters";
const browserToken = randomBytes(32).toString("base64url");
const now = new Date("2026-09-09T10:00:00Z");
const projectId = "11111111-1111-4111-8111-111111111111";
const returnPath = "/abc12/目录/a%20b%25.html?preview=1&name=%E4%B8%AD";

describe("browser-bound password return state", () => {
  const state = createPasswordState({ secret, browserToken, projectId, returnPath, now });
  const read = (overrides: Partial<Parameters<typeof readPasswordState>[0]> = {}) =>
    readPasswordState({ secret, browserToken, state, now, ...overrides });

  it("preserves the exact nested path and query, with no password or cookie in the state", () => {
    expect(read()).toEqual({ projectId, returnPath, expiresAt: now.getTime() + 600_000 });
    expect(state).not.toContain(browserToken);
    expect(Buffer.from(state.split(".")[0] ?? "", "base64url").toString()).not.toContain(
      "password",
    );
    expect(read()).toEqual(read()); // Failed password attempts may reuse the state.
  });

  it("rejects tampering, cross-browser use, secret mismatch, expiry and malformed signatures", () => {
    for (const overrides of [
      { browserToken: undefined },
      { browserToken: randomBytes(32).toString("base64url") },
      { state: `${state.slice(0, -3)}AAA` },
      { state: `${state}.extra` },
      { state: `${state.split(".")[0]}.a` },
      { state: "a".repeat(8193) },
      { secret: `${secret}-another` },
      { now: new Date(now.getTime() + 600_000) },
      { now: new Date(now.getTime() - 1) },
      { state: { password: "never stringify" } },
    ])
      expect(read(overrides)).toBeNull();
  });

  it("domain separates the MAC from other uses of AUTH_STATE_SECRET", () => {
    const payload = state.split(".")[0] ?? "";
    const otherMac = createHmac("sha256", secret).update(payload).digest("base64url");
    expect(read({ state: `${payload}.${otherMac}` })).toBeNull();
  });

  it("rejects external, traversal, fragment and control paths while supporting encoded filenames", () => {
    for (const path of [
      "//evil.test/abc12/a",
      "https://evil.test/a",
      "/abc12/%2e%2e/a",
      "/abc12/a%2fb",
      "/abc12/a#fragment",
      "/abc12/a\n",
      "/auth/password",
      "/abc12/",
      "/abc12/a%255cb",
    ])
      expect(readPasswordReturnPath(path)).toBeNull();
    expect(readPasswordReturnPath("/abc12/目录/a b.html?x=1")).toBe("/abc12/目录/a b.html?x=1");
  });
});

describe("bounded password limiter", () => {
  it("fails closed at capacity, preserves active budgets, and frees expired keys", () => {
    let current = now;
    const limiter = createPasswordRateLimiter({ now: () => current, maxKeys: 2 });
    expect(limiter.consume("a", 1).allowed).toBe(true);
    expect(limiter.consume("b", 1).allowed).toBe(true);
    expect(limiter.consume("c", 1)).toEqual({ allowed: false, retryAfterSeconds: 60 });
    expect(limiter.consume("a", 1).allowed).toBe(false);
    current = new Date(now.getTime() + 60_000);
    expect(limiter.consume("c", 1).allowed).toBe(true);
    expect(limiter.consume("a", 1).allowed).toBe(true);
  });
});
