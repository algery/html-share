import { randomUUID } from "node:crypto";
import { expect, it } from "vitest";

import { databaseContract } from "./database-contract-fixture.mjs";

databaseContract("identity, single-use state and token authorization", (current) => {
  it("serializes concurrent identity upserts and consumes a state exactly once", async () => {
    const f = current();
    const input = {
      tenantAppKeyRef: f.tenant.dingtalkAppKeyRef,
      dingtalkUserId: randomUUID(),
      displayName: "并发身份😀",
      now: new Date("2026-11-04T08:00:00.123Z"),
    };
    const identities = await Promise.all([
      f.repositories.auth.upsertUser(input),
      f.second.auth.upsertUser(input),
    ]);
    expect(identities[0]).toEqual(identities[1]);
    expect(await f.db.user.count({ where: { dingtalkUserId: input.dingtalkUserId } })).toBe(1);
    const stateDigest = randomUUID();
    f.stateDigests.push(stateDigest);
    await f.repositories.auth.createAuthState({
      stateDigest,
      audience: "demo",
      returnPath: "/中文/😀/A.html",
      expiresAt: new Date(input.now.getTime() + 1),
    });
    const results = await Promise.all([
      f.repositories.auth.consumeAuthState({ stateDigest, now: input.now }),
      f.second.auth.consumeAuthState({ stateDigest, now: input.now }),
    ]);
    expect(results.filter(Boolean)).toEqual([{ audience: "demo", returnPath: "/中文/😀/A.html" }]);
    const expired = randomUUID();
    f.stateDigests.push(expired);
    await f.repositories.auth.createAuthState({
      stateDigest: expired,
      audience: "app",
      returnPath: "/",
      expiresAt: input.now,
    });
    expect(
      await f.repositories.auth.consumeAuthState({ stateDigest: expired, now: input.now }),
    ).toBeNull();
  });

  it("enforces audience, exact UTC expiry, revocation and disabled identity on sessions", async () => {
    const f = current();
    const tokenDigest = randomUUID();
    const expiresAt = new Date("2030-01-01T00:00:00.123Z");
    const input = { tokenDigest, audience: "app", now: new Date(expiresAt.getTime() - 1) };
    await f.repositories.auth.createAccessSession({
      userId: f.owner.id,
      tokenDigest,
      audience: "app",
      expiresAt,
    });
    expect(await f.repositories.auth.findAccessSession(input)).toMatchObject({
      audience: "app",
      expiresAt,
      tenantId: f.tenant.id,
      user: { id: f.owner.id },
    });
    expect(await f.repositories.auth.findAccessSession({ ...input, audience: "demo" })).toBeNull();
    expect(await f.repositories.auth.findAccessSession({ ...input, now: expiresAt })).toBeNull();
    await f.db.user.update({ where: { id: f.owner.id }, data: { status: "DISABLED" } });
    expect(await f.repositories.auth.findAccessSession(input)).toBeNull();
    await f.db.user.update({ where: { id: f.owner.id }, data: { status: "ACTIVE" } });
    await f.db.tenant.update({ where: { id: f.tenant.id }, data: { status: "DISABLED" } });
    expect(await f.repositories.auth.findAccessSession(input)).toBeNull();
    await f.db.tenant.update({ where: { id: f.tenant.id }, data: { status: "ACTIVE" } });
    await f.repositories.auth.revokeAccessSession(input);
    expect(await f.repositories.auth.findAccessSession(input)).toBeNull();
  });

  it("preserves token NULL fields and fences revoke/use by the owner and active status", async () => {
    const f = current();
    const tokenDigest = randomUUID();
    const expiresAt = new Date(f.now.getTime() + 60_000);
    const token = await f.repositories.mcpTokens.createToken({
      user: f.owner,
      name: "契约 Token😀",
      tokenDigest,
      tokenSuffix: "abcd",
      createdAt: f.now,
      expiresAt,
    });
    expect(token).toMatchObject({ status: "active", revokedAt: null, lastUsedAt: null });
    expect(await f.repositories.mcpTokens.listTokens({ userId: f.owner.id })).toEqual([token]);
    expect(
      await f.repositories.mcpTokens.findActiveToken({ tokenDigest, now: f.now }),
    ).toMatchObject({
      user: { id: f.owner.id },
    });
    expect(
      await f.repositories.mcpTokens.findActiveToken({ tokenDigest, now: expiresAt }),
    ).toBeNull();
    expect(
      await f.repositories.mcpTokens.revokeToken({
        tokenId: token.id,
        userId: randomUUID(),
        revokedAt: f.now,
      }),
    ).toBe(false);
    await f.repositories.mcpTokens.recordTokenUse({ tokenId: token.id, usedAt: f.now });
    expect(
      (await f.repositories.mcpTokens.listTokens({ userId: f.owner.id }))[0].lastUsedAt,
    ).toEqual(f.now);
    expect(
      await f.repositories.mcpTokens.revokeToken({
        tokenId: token.id,
        userId: f.owner.id,
        revokedAt: f.now,
      }),
    ).toBe(true);
    expect(
      await f.repositories.mcpTokens.revokeToken({
        tokenId: token.id,
        userId: f.owner.id,
        revokedAt: f.now,
      }),
    ).toBe(false);
    expect(await f.repositories.mcpTokens.findActiveToken({ tokenDigest, now: f.now })).toBeNull();
    await f.repositories.mcpTokens.recordTokenUse({ tokenId: token.id, usedAt: expiresAt });
    expect(
      (await f.repositories.mcpTokens.listTokens({ userId: f.owner.id }))[0].lastUsedAt,
    ).toEqual(f.now);
  });

  it("authenticates a permanent Token after 30 days only while owner and tenant are active", async () => {
    const f = current();
    const tokenDigest = randomUUID();
    const token = await f.repositories.mcpTokens.createToken({
      user: f.owner,
      name: "永久有效",
      tokenDigest,
      tokenSuffix: "abcd",
      createdAt: f.now,
      expiresAt: null,
    });
    expect(token.expiresAt).toBeNull();
    expect(await f.repositories.mcpTokens.listTokens({ userId: f.owner.id })).toEqual([token]);
    const input = { tokenDigest, now: new Date(f.now.getTime() + 31 * 86_400_000) };
    expect(await f.repositories.mcpTokens.findActiveToken(input)).toMatchObject({
      id: token.id,
      expiresAt: null,
    });
    await f.db.user.update({ where: { id: f.owner.id }, data: { status: "DISABLED" } });
    expect(await f.repositories.mcpTokens.findActiveToken(input)).toBeNull();
    await f.db.user.update({ where: { id: f.owner.id }, data: { status: "ACTIVE" } });
    await f.db.tenant.update({ where: { id: f.tenant.id }, data: { status: "DISABLED" } });
    expect(await f.repositories.mcpTokens.findActiveToken(input)).toBeNull();
    await f.db.tenant.update({ where: { id: f.tenant.id }, data: { status: "ACTIVE" } });
    expect(
      await f.repositories.mcpTokens.revokeToken({
        tokenId: token.id,
        userId: f.owner.id,
        revokedAt: input.now,
      }),
    ).toBe(true);
    expect(await f.repositories.mcpTokens.findActiveToken(input)).toBeNull();
  });
});
