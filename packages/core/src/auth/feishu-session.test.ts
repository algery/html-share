import { describe, expect, it, vi } from "vitest";
import { InMemoryAuthRepository } from "./in-memory-auth-repository.js";
import { createAuthSessionService } from "./session-service.js";

const now = new Date("2026-11-14T00:00:00Z");
const feishu = {
  feishuAppId: "app",
  feishuTenantKey: "tenant",
  feishuOpenId: "open",
  displayName: "成员",
};
const ding = { dingtalkUserId: "ding", displayName: "成员" };
const scope = { tenantAppKeyRef: "organization", now };

describe("Feishu identity and one-use authorization", () => {
  it("links both first-login orders and retains existing identity when contacts change", async () => {
    for (const first of ["feishu", "dingtalk"]) {
      const repository = new InMemoryAuthRepository();
      const a =
        first === "feishu"
          ? await repository.upsertFeishuUser({ ...scope, ...feishu, phone: "13800138000" })
          : await repository.upsertUser({ ...scope, ...ding, phone: "13800138000" });
      const b =
        first === "feishu"
          ? await repository.upsertUser({ ...scope, ...ding, phone: "+86 13800138000" })
          : await repository.upsertFeishuUser({ ...scope, ...feishu, phone: "+86 13800138000" });
      expect(a).toEqual(b);
      const other = await repository.upsertUser({
        ...scope,
        ...ding,
        dingtalkUserId: "other",
        email: "other@example.com",
      });
      expect(
        await repository.upsertFeishuUser({ ...scope, ...feishu, email: "other@example.com" }),
      ).toEqual(a);
      expect(other).not.toEqual(a);
    }
  });
  it("rejects split matches and same-provider occupancy without moving assets", async () => {
    const repository = new InMemoryAuthRepository();
    await repository.upsertUser({ ...scope, ...ding, phone: "13800138000" });
    await repository.upsertUser({
      ...scope,
      ...ding,
      dingtalkUserId: "other",
      email: "other@example.com",
    });
    await expect(
      repository.upsertFeishuUser({
        ...scope,
        ...feishu,
        phone: "13800138000",
        email: "other@example.com",
      }),
    ).rejects.toMatchObject({ code: "ACCOUNT_LINK_CONFLICT" });
    await expect(
      repository.upsertUser({ ...scope, ...ding, dingtalkUserId: "new", phone: "13800138000" }),
    ).rejects.toMatchObject({ code: "ACCOUNT_LINK_CONFLICT" });
  });
  it("clears omitted snapshots, ignores stale contacts and isolates organizations", async () => {
    for (const variant of ["omitted", "stale", "tenant"]) {
      const repository = new InMemoryAuthRepository();
      const a = await repository.upsertUser({ ...scope, ...ding, phone: "13800138000" });
      if (variant === "omitted") await repository.upsertUser({ ...scope, ...ding });
      const b = await repository.upsertFeishuUser({
        ...scope,
        ...feishu,
        phone: "13800138000",
        ...(variant === "stale" ? { now: new Date(now.getTime() + 31 * 86400000) } : {}),
        ...(variant === "tenant" ? { tenantAppKeyRef: "other" } : {}),
      });
      expect(b).not.toEqual(a);
    }
  });
  it("consumes state and validates audience/provider before invoking the resolver", async () => {
    const service = createAuthSessionService({
      repository: new InMemoryAuthRepository(),
      tenantAppKeyRef: scope.tenantAppKeyRef,
      stateSecret: "secret",
      now: () => now,
    });
    const resolver = vi.fn(async () => feishu);
    const dingState = await service.beginAuthorization({ audience: "app", returnPath: "/" });
    await expect(
      service.finishFeishuAuthorization({
        audience: "app",
        state: dingState.state,
        resolveIdentity: resolver,
      }),
    ).rejects.toMatchObject({ code: "AUTH_STATE_INVALID" });
    const mismatch = await service.beginFeishuAuthorization({ audience: "app", returnPath: "/" });
    await expect(
      service.finishFeishuAuthorization({
        audience: "demo",
        state: mismatch.state,
        resolveIdentity: resolver,
      }),
    ).rejects.toMatchObject({ code: "AUTH_STATE_INVALID" });
    await expect(
      service.finishFeishuAuthorization({
        audience: "app",
        state: mismatch.state,
        resolveIdentity: resolver,
      }),
    ).rejects.toMatchObject({ code: "AUTH_STATE_INVALID" });
    expect(resolver).not.toHaveBeenCalled();
    const valid = await service.beginFeishuAuthorization({
      audience: "demo",
      returnPath: "/demo/index.html",
    });
    const results = await Promise.allSettled(
      [1, 2].map(() =>
        service.finishFeishuAuthorization({
          audience: "demo",
          state: valid.state,
          resolveIdentity: resolver,
        }),
      ),
    );
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(resolver).toHaveBeenCalledTimes(1);
    const result = results.find((result) => result.status === "fulfilled");
    if (result?.status !== "fulfilled") throw new Error("expected successful authorization");
    expect(result.value.expiresAt.getTime() - now.getTime()).toBe(8 * 60 * 60 * 1000);
    expect(
      (await service.getSession({ audience: "demo", token: result.value.token }))?.user
        .dingtalkUserId,
    ).toBeNull();
  });
  it("rejects expired Feishu states and cannot consume them through DingTalk", async () => {
    let current = now;
    const service = createAuthSessionService({
      repository: new InMemoryAuthRepository(),
      tenantAppKeyRef: "org",
      stateSecret: "secret",
      now: () => current,
    });
    const resolver = vi.fn(async () => feishu);
    const valid = await service.beginFeishuAuthorization({ audience: "app", returnPath: "/" });
    await expect(
      service.finishAuthorization({ audience: "app", state: valid.state, identity: ding }),
    ).rejects.toMatchObject({ code: "AUTH_STATE_INVALID" });
    await expect(
      service.finishFeishuAuthorization({
        audience: "app",
        state: valid.state,
        resolveIdentity: resolver,
      }),
    ).resolves.toMatchObject({ audience: "app" });
    const expired = await service.beginFeishuAuthorization({ audience: "app", returnPath: "/" });
    current = new Date(now.getTime() + 10 * 60 * 1000);
    await expect(
      service.finishFeishuAuthorization({
        audience: "app",
        state: expired.state,
        resolveIdentity: resolver,
      }),
    ).rejects.toMatchObject({ code: "AUTH_STATE_INVALID" });
    expect(resolver).toHaveBeenCalledTimes(1);
  });

  it("keeps failed exchange states consumed and never creates a session", async () => {
    const repository = new InMemoryAuthRepository();
    const create = vi.spyOn(repository, "createAccessSession");
    const service = createAuthSessionService({
      repository,
      tenantAppKeyRef: "org",
      stateSecret: "secret",
    });
    const authorization = await service.beginFeishuAuthorization({
      audience: "app",
      returnPath: "/",
    });
    const resolveIdentity = vi.fn(async () => {
      throw new Error("upstream unavailable");
    });
    await expect(
      service.finishFeishuAuthorization({
        audience: "app",
        state: authorization.state,
        resolveIdentity,
      }),
    ).rejects.toThrow("upstream unavailable");
    await expect(
      service.finishFeishuAuthorization({
        audience: "app",
        state: authorization.state,
        resolveIdentity,
      }),
    ).rejects.toMatchObject({ code: "AUTH_STATE_INVALID" });
    expect(resolveIdentity).toHaveBeenCalledTimes(1);
    expect(create).not.toHaveBeenCalled();
  });
});
