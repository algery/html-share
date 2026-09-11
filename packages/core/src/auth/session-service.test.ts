import { describe, expect, it } from "vitest";

import { InMemoryAuthRepository } from "./in-memory-auth-repository.js";
import { AuthenticationError, createAuthSessionService } from "./session-service.js";

describe("auth session service", () => {
  it("creates isolated eight-hour sessions and consumes state once", async () => {
    let now = new Date("2026-09-02T00:00:00.000Z");
    const service = createAuthSessionService({
      now: () => now,
      repository: new InMemoryAuthRepository(),
      stateSecret: "test-state-signing-secret-with-enough-length",
      tenantAppKeyRef: "test-app",
    });
    const started = await service.beginAuthorization({
      audience: "demo",
      returnPath: "/3h32g/a.html",
    });
    const completed = await service.finishAuthorization({
      audience: "demo",
      identity: { dingtalkUserId: "user-1", displayName: "成员" },
      state: started.state,
    });

    expect(completed.returnPath).toBe("/3h32g/a.html");
    expect(completed.expiresAt.toISOString()).toBe("2026-09-02T08:00:00.000Z");
    expect(await service.getSession({ audience: "demo", token: completed.token })).not.toBeNull();
    expect(await service.getSession({ audience: "app", token: completed.token })).toBeNull();
    await expect(
      service.finishAuthorization({
        audience: "demo",
        identity: { dingtalkUserId: "user-1", displayName: "成员" },
        state: started.state,
      }),
    ).rejects.toMatchObject({ code: "AUTH_STATE_INVALID" });

    now = new Date("2026-09-02T08:00:00.000Z");
    expect(await service.getSession({ audience: "demo", token: completed.token })).toBeNull();
  });

  it("rejects external paths and cross-audience authorization before issuing a session", async () => {
    const service = createAuthSessionService({
      repository: new InMemoryAuthRepository(),
      stateSecret: "test-state-signing-secret-with-enough-length",
      tenantAppKeyRef: "test-app",
    });

    await expect(
      service.beginAuthorization({ audience: "demo", returnPath: "https://attacker.test" }),
    ).rejects.toBeInstanceOf(AuthenticationError);

    const started = await service.beginAuthorization({
      audience: "demo",
      returnPath: "/safe.html",
    });
    await expect(
      service.finishAuthorization({
        audience: "app",
        identity: { dingtalkUserId: "user-1", displayName: "成员" },
        state: started.state,
      }),
    ).rejects.toMatchObject({ code: "AUTH_STATE_INVALID" });
  });

  it("rejects tampered and expired authorization state without issuing a session", async () => {
    let now = new Date("2026-09-02T00:00:00.000Z");
    const service = createAuthSessionService({
      now: () => now,
      repository: new InMemoryAuthRepository(),
      stateSecret: "test-state-signing-secret-with-enough-length",
      tenantAppKeyRef: "test-app",
    });
    const started = await service.beginAuthorization({ audience: "app", returnPath: "/login" });
    const replacement = started.state[0] === "A" ? "B" : "A";
    const tamperedState = `${replacement}${started.state.slice(1)}`;

    await expect(
      service.finishAuthorization({
        audience: "app",
        identity: { dingtalkUserId: "user-1", displayName: "成员" },
        state: tamperedState,
      }),
    ).rejects.toMatchObject({ code: "AUTH_STATE_INVALID" });

    now = new Date("2026-09-02T00:11:00.000Z");
    await expect(
      service.finishAuthorization({
        audience: "app",
        identity: { dingtalkUserId: "user-1", displayName: "成员" },
        state: started.state,
      }),
    ).rejects.toMatchObject({ code: "AUTH_STATE_INVALID" });
  });

  it("hands an authenticated app session to the demo audience once without exposing identity", async () => {
    const service = createAuthSessionService({
      repository: new InMemoryAuthRepository(),
      stateSecret: "test-state-signing-secret-with-enough-length",
      tenantAppKeyRef: "test-app",
    });
    const sourceState = await service.beginAuthorization({ audience: "app", returnPath: "/demos" });
    const source = await service.finishAuthorization({
      audience: "app",
      identity: { dingtalkUserId: "sensitive-user-id", displayName: "测试成员" },
      state: sourceState.state,
    });

    const handoff = await service.beginSessionHandoff({
      returnPath: "/3h32g/嵌套%20页面.html?preview=1",
      sourceAudience: "app",
      sourceToken: source.token,
      targetAudience: "demo",
    });

    expect(handoff).not.toBeNull();
    expect(handoff?.ticket).not.toContain("sensitive-user-id");
    expect(handoff?.ticket).not.toContain("测试成员");
    expect(handoff?.ticket).not.toContain(source.token);
    const completed = await service.finishSessionHandoff({
      targetAudience: "demo",
      ticket: handoff?.ticket ?? "",
    });
    expect(completed.returnPath).toBe("/3h32g/嵌套%20页面.html?preview=1");
    expect(await service.getSession({ audience: "demo", token: completed.token })).toMatchObject({
      tenantId: "test-app",
      user: { dingtalkUserId: "sensitive-user-id" },
    });
    expect(await service.getSession({ audience: "app", token: completed.token })).toBeNull();
    await expect(
      service.finishSessionHandoff({
        targetAudience: "demo",
        ticket: handoff?.ticket ?? "",
      }),
    ).rejects.toMatchObject({ code: "SESSION_HANDOFF_INVALID" });
  });

  it("does not create a handoff for a missing source session and rejects unsafe paths", async () => {
    const service = createAuthSessionService({
      repository: new InMemoryAuthRepository(),
      stateSecret: "test-state-signing-secret-with-enough-length",
      tenantAppKeyRef: "test-app",
    });

    expect(
      await service.beginSessionHandoff({
        returnPath: "/safe.html",
        sourceAudience: "app",
        sourceToken: undefined,
        targetAudience: "demo",
      }),
    ).toBeNull();
    await expect(
      service.beginSessionHandoff({
        returnPath: "https://attacker.test",
        sourceAudience: "app",
        sourceToken: "missing",
        targetAudience: "demo",
      }),
    ).rejects.toMatchObject({ code: "RETURN_PATH_INVALID" });
  });

  it("rejects tampered, expired, and cross-audience handoff tickets", async () => {
    let now = new Date("2026-09-11T00:00:00.000Z");
    const service = createAuthSessionService({
      now: () => now,
      repository: new InMemoryAuthRepository(),
      stateSecret: "test-state-signing-secret-with-enough-length",
      tenantAppKeyRef: "test-app",
    });
    const sourceState = await service.beginAuthorization({ audience: "app", returnPath: "/demos" });
    const source = await service.finishAuthorization({
      audience: "app",
      identity: { dingtalkUserId: "user-1", displayName: "成员" },
      state: sourceState.state,
    });
    const first = await service.beginSessionHandoff({
      returnPath: "/safe.html",
      sourceAudience: "app",
      sourceToken: source.token,
      targetAudience: "demo",
    });
    const ticket = first?.ticket ?? "";
    const parts = ticket.split(".");
    const ciphertext = parts[2] ?? "";
    const replacement = ciphertext[0] === "A" ? "B" : "A";
    parts[2] = `${replacement}${ciphertext.slice(1)}`;
    await expect(
      service.finishSessionHandoff({
        targetAudience: "demo",
        ticket: parts.join("."),
      }),
    ).rejects.toMatchObject({ code: "SESSION_HANDOFF_INVALID" });
    await expect(
      service.finishSessionHandoff({ targetAudience: "app", ticket }),
    ).rejects.toMatchObject({ code: "SESSION_HANDOFF_INVALID" });

    const expiring = await service.beginSessionHandoff({
      returnPath: "/expired.html",
      sourceAudience: "app",
      sourceToken: source.token,
      targetAudience: "demo",
    });
    now = new Date("2026-09-11T00:01:00.000Z");
    await expect(
      service.finishSessionHandoff({
        targetAudience: "demo",
        ticket: expiring?.ticket ?? "",
      }),
    ).rejects.toMatchObject({ code: "SESSION_HANDOFF_INVALID" });
  });
});
