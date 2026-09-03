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
});
